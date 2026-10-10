/* SAM's Garage desktop app - the app:// scheme (main process).
 *
 * The page is served from app://sg/ rather than file://: it uses ES modules and fetch(), which a file:// page
 * cannot. Everything under app://sg/ is a file of the packaged site/ folder, except app://sg/data/*, which is the
 * live site's data when it can be reached (so the desktop app shows today's topics, like the web app) and a copy
 * otherwise:
 *   1. <live>/data/<path>?<query>, within a few seconds; a good answer is also kept in <userData>/data-cache/
 *   2. else the copy kept from the last good answer
 *   3. else the snapshot bundled with the app (site/data/, built when the installer was made)
 *
 * No Electron imports here: main.js passes net.fetch in, and the tests run this module in plain Node. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEME = 'app';
const HOST = 'sg';
const ORIGIN = `${SCHEME}://${HOST}`;
const APP_PAGE = `${ORIGIN}/index.html`;

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

const headersFor = (file, extra = {}) => ({ 'Content-Type': typeOf(file), 'Cache-Control': 'no-cache', ...extra });
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function readFile(file) {
  try { return (await fs.promises.stat(file)).isFile() ? await fs.promises.readFile(file) : null; } catch (e) { return null; }
}

const bufferResponse = (buf, headers) => new Response(buf, { status: 200, headers: { ...headers, 'Content-Length': String(buf.length) } });

/** Write via a temporary file and a rename, so a reader never sees half a file. */
async function writeAtomic(file, buf) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, file); } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
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
 *           bodyTimeoutMs?: number, userAgent?: string, onData?: (rel: string, source: string, detail?: string) => void }} o
 *   fetch reaches the live site (main.js passes net.fetch); onData reports where each data file came from.
 * @returns {(request: Request) => Promise<Response>}
 */
function createHandler(o) {
  const { siteDir, cacheDir, liveBase, fetch, timeoutMs = 8000, bodyTimeoutMs = 60000, userAgent, onData = () => {} } = o;
  const dataDir = path.join(siteDir, 'data');

  async function live(rawRel, search) {
    const ctl = new AbortController();
    const headers = userAgent ? { 'User-Agent': userAgent } : {};
    const res = await withTimeout(fetch(liveBase + 'data/' + rawRel + search, { signal: ctl.signal, headers, cache: 'no-store' }), timeoutMs, () => ctl.abort());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await withTimeout(res.arrayBuffer(), bodyTimeoutMs, () => ctl.abort()));
  }

  async function data(rawRel, search) {
    const cached = resolveInside(cacheDir, rawRel);
    const bundled = resolveInside(dataDir, rawRel);
    if (!cached || !bundled) return notFound();
    let why = '';
    let buf = null;
    try { buf = await live(rawRel, search); } catch (e) { why = e.message; }
    if (buf) {
      onData(rawRel, 'live');
      writeAtomic(cached, buf).catch(e => onData(rawRel, 'cache-write-failed', e.message)); // for when the site is out of reach
      return bufferResponse(buf, headersFor(cached, { 'X-Sg-Source': 'live' }));
    }
    for (const [file, source] of [[cached, 'cache'], [bundled, 'bundled']]) {
      const copy = await readFile(file);
      if (copy) { onData(rawRel, source, why); return bufferResponse(copy, headersFor(file, { 'X-Sg-Source': source })); }
    }
    onData(rawRel, 'missing', why);
    return notFound();
  }

  return async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch (e) { return notFound(); }
    if (url.protocol !== SCHEME + ':' || url.host !== HOST) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p.startsWith('/data/')) return data(p.slice('/data/'.length), url.search);
    const file = resolveInside(siteDir, p);
    const buf = file && await readFile(file);
    return buf ? bufferResponse(buf, headersFor(file)) : notFound();
  };
}

module.exports = { SCHEME, HOST, ORIGIN, APP_PAGE, TYPES, typeOf, resolveInside, createHandler };
