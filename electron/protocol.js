/* SAM's Garage desktop app - the app:// scheme (main process).
 *
 * The page is served from app://sg/ rather than file://: it uses ES modules and fetch(), which a file:// page
 * cannot. Everything under app://sg/ is a file of the packaged site/ folder, except app://sg/data/*, which is the
 * live site's data when it can be reached (so the desktop app shows today's topics, like the web app) and a copy
 * otherwise:
 *   1. <live>/data/<path>?<query>, within a few seconds; a good answer is also kept in <userData>/data-cache/
 *   2. else the copy kept from the last good answer
 *   3. else the snapshot bundled with the app (site/data/, built when the installer was made)
 * An answer is good only when it looks like what was asked for (JSON that parses, a SQLite file, never an HTML
 * page such as a captive portal's or an error page), so nothing else is ever kept or served as data. The live data
 * is used only while its format (meta.json "format") is one this app reads; when the site has moved on to a newer
 * format, an older install keeps using its copies, and the page, which still gets the live meta.json, asks for an
 * update.
 *
 * No Electron imports here: main.js passes net.fetch in, and the tests run this module in plain Node. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEME = 'app';
const HOST = 'sg';
const ORIGIN = `${SCHEME}://${HOST}`;
const APP_PAGE = `${ORIGIN}/index.html`;
// The site data format this app reads: scraper/build.py SITE_FORMAT, site/js/data.js DATA_FORMAT (tested to match).
const DATA_FORMAT = 1;
const FORMAT_TTL_MS = 10 * 60000;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.sqlite': 'application/vnd.sqlite3'
};
const typeOf = file => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** The file under root that a URL path (still %-encoded) names, or null when it would leave root. */
function resolveInside(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + path.posix.sep + rel.replace(/^[/\\]+/, ''));
  return file.startsWith(base + path.sep) ? file : null;
}

/** Whether a body is plausibly the data file it claims to be (contentType: the live answer's, if any). */
function looksValid(file, buf, contentType = '') {
  if (/text\/html/i.test(contentType)) return false;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try { JSON.parse(buf.toString('utf8')); return true; } catch (e) { return false; }
  }
  if (ext === '.sqlite') return buf.length >= 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC);
  return buf.length > 0;
}

/** The format a meta.json body declares: true when this app reads it (a missing format is format 1). */
function formatSupported(meta) {
  const f = meta && meta.format;
  return f == null || (Number.isInteger(f) && f <= DATA_FORMAT);
}

const headersFor = (file, extra = {}) => ({ 'Content-Type': typeOf(file), 'Cache-Control': 'no-cache', ...extra });
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const bufferResponse = (buf, headers, head = false) =>
  new Response(head ? null : buf, { status: 200, headers: { ...headers, 'Content-Length': String(buf.length) } });

async function readFile(file) {
  try { return (await fs.promises.stat(file)).isFile() ? await fs.promises.readFile(file) : null; } catch (e) { return null; }
}

/** Write via a temporary file and a rename, so a reader never sees half a file. */
async function writeAtomic(file, buf) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, file); } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
}

/** Remove the temporary files a crash may have left in the cache folder. */
async function removeStaleTmp(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  await Promise.all(entries.map(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return removeStaleTmp(p);
    return e.name.endsWith('.tmp') ? fs.promises.rm(p, { force: true }).catch(() => {}) : null;
  }));
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(new Error(`timed out after ${ms} ms`)); }, ms); })
  ]).finally(() => clearTimeout(timer));
}

/**
 * The app:// handler.
 * @param {{ siteDir: string, cacheDir: string, liveBase: string, fetch: Function, timeoutMs?: number,
 *           bodyTimeoutMs?: number, userAgent?: string, onData?: (rel: string, source: string, detail?: string) => void,
 *           onNote?: (rel: string, note: string) => void }} o
 *   fetch reaches the live site (main.js passes net.fetch). onData reports where each data file came from
 *   (live, cache, bundled or missing); onNote reports anything else worth a log line (a cache write that failed).
 * @returns {(request: Request) => Promise<Response>}
 */
function createHandler(o) {
  const { siteDir, cacheDir, liveBase, fetch, timeoutMs = 8000, bodyTimeoutMs = 60000, userAgent, onData = () => {}, onNote = () => {} } = o;
  const dataDir = path.join(siteDir, 'data');
  const ready = removeStaleTmp(cacheDir);

  /** The live file, checked; throws when it cannot be had or does not look right. */
  async function live(rawRel, search, file) {
    const ctl = new AbortController();
    const headers = userAgent ? { 'User-Agent': userAgent } : {};
    const res = await withTimeout(fetch(liveBase + 'data/' + rawRel + search, { signal: ctl.signal, headers, cache: 'no-store' }), timeoutMs, () => ctl.abort());
    if (!res.ok) {
      try { await res.body?.cancel(); } catch (e) { /* already gone */ }
      throw new Error('HTTP ' + res.status);
    }
    const buf = Buffer.from(await withTimeout(res.arrayBuffer(), bodyTimeoutMs, () => ctl.abort()));
    if (!looksValid(file, buf, res.headers.get('content-type') || '')) throw new Error('not a valid ' + path.extname(file) + ' file');
    return buf;
  }

  // Whether the live data can be used, from the live meta.json: 'ok', 'newer' (a format this app does not read)
  // or 'unreachable'. Remembered for a while (an unreachable site for half a minute), so the data files of one
  // page load wait for one check at most.
  let format = null, formatUntil = 0;
  function liveFormat() {
    if (format && Date.now() < formatUntil) return format;
    formatUntil = Infinity; // until it settles
    format = live('meta.json', '', 'meta.json')
      .then(buf => (formatSupported(JSON.parse(buf.toString('utf8'))) ? 'ok' : 'newer'))
      .catch(() => 'unreachable');
    format.then(v => { formatUntil = Date.now() + (v === 'unreachable' ? 30000 : FORMAT_TTL_MS); });
    return format;
  }

  async function kept(file, source, rel, why, head) {
    const buf = await readFile(file);
    if (!buf) return null;
    if (!looksValid(file, buf)) { // a damaged or poisoned copy: never again
      if (source === 'cache') await fs.promises.rm(file, { force: true }).catch(() => {});
      onNote(rel, `${source} copy is not a valid file${source === 'cache' ? '; removed' : ''}`);
      return null;
    }
    onData(rel, source, why);
    return bufferResponse(buf, headersFor(file, { 'X-Sg-Source': source }), head);
  }

  async function data(rawRel, search, head) {
    const cached = resolveInside(cacheDir, rawRel);
    const bundled = resolveInside(dataDir, rawRel);
    if (!cached || !bundled) return notFound();
    await ready;
    let why = '';
    if (!head) { // HEAD: headers of the copy at hand, no live request and no cache write
      const isMeta = rawRel === 'meta.json';
      const f = isMeta ? 'ok' : await liveFormat();
      if (f === 'newer') why = 'the live data is in a newer format than this app reads';
      else if (f === 'unreachable') why = 'the live site cannot be reached';
      else {
        let buf = null;
        try { buf = await live(rawRel, search, cached); } catch (e) { why = e.message; }
        if (buf && isMeta && !formatSupported(JSON.parse(buf.toString('utf8')))) {
          // the page sees the newer format and asks for an update; the copies stay as they are
          onData(rawRel, 'live', 'newer format, not kept');
          return bufferResponse(buf, headersFor(cached, { 'X-Sg-Source': 'live' }));
        }
        if (buf) {
          onData(rawRel, 'live');
          writeAtomic(cached, buf).catch(e => onNote(rawRel, 'cache write failed: ' + e.message)); // for when the site is out of reach
          return bufferResponse(buf, headersFor(cached, { 'X-Sg-Source': 'live' }));
        }
      }
    }
    for (const [file, source] of [[cached, 'cache'], [bundled, 'bundled']]) {
      const res = await kept(file, source, rawRel, why, head);
      if (res) return res;
    }
    onData(rawRel, 'missing', why);
    return notFound();
  }

  return async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch (e) { return notFound(); }
    if (url.protocol !== SCHEME + ':' || url.host !== HOST) return notFound();
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) return new Response('Method not allowed', { status: 405 });
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p.startsWith('/data/')) return data(p.slice('/data/'.length), url.search, head);
    const file = resolveInside(siteDir, p);
    const buf = file && await readFile(file);
    return buf ? bufferResponse(buf, headersFor(file), head) : notFound();
  };
}

module.exports = { SCHEME, HOST, ORIGIN, APP_PAGE, DATA_FORMAT, TYPES, typeOf, resolveInside, looksValid, formatSupported, createHandler };
