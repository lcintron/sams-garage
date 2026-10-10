// The desktop app's app:// handler (electron/protocol.js), run in plain Node with a scripted fetch: files come from
// site/ with the right types and never from outside it, and data/ is live first, then the kept copy, then the
// bundled snapshot, with nothing that does not look like the file asked for ever kept or served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DATA_FORMAT as PAGE_FORMAT } from '../js/data.js';

const require = createRequire(import.meta.url);
const { createHandler, resolveInside, typeOf, looksValid, APP_PAGE, DATA_FORMAT } = require('../../electron/protocol.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84)]);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-desktop-'));
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(site, 'data', 'records'), { recursive: true });
  fs.mkdirSync(path.join(site, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(site, 'vendor', 'x.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(site, 'data', 'catalog.json'), '["bundled"]');
  fs.writeFileSync(path.join(site, 'data', 'meta.json'), '{"format":1,"v":"bundled"}');
  fs.writeFileSync(path.join(site, 'data', 'solicitations.sqlite'), SQLITE);
  fs.writeFileSync(path.join(site, 'data', 'records', 'a__1.json'), '{"id":"a:1"}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  return { dir, site, cache: path.join(dir, 'cache') };
}

/** A live site: routes maps a data path ("catalog.json") to a Response factory; meta.json defaults to format 1. */
function site(routes = {}) {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push(url);
    const rel = url.replace(/^https:\/\/live\.test\/data\//, '').split('?')[0];
    const make = routes[rel] || (rel === 'meta.json' ? () => new Response('{"format":1,"v":"live"}') : null);
    if (!make) return new Response('missing', { status: 404 });
    return make(url, init);
  };
  return { fetch, asked };
}

const handler = (f, fetch, extra = {}) => createHandler({ siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/', fetch, ...extra });
const get = (handle, url, method = 'GET') => handle(new Request(url, { method }));
const wait = () => new Promise(r => setTimeout(r, 50)); // the kept copy is written in the background

test('the desktop app reads the data format the site builds', () => {
  assert.equal(DATA_FORMAT, PAGE_FORMAT);
  const build = fs.readFileSync(path.join(here, '..', '..', 'scraper', 'build.py'), 'utf8');
  assert.equal(Number(/^SITE_FORMAT = (\d+)/m.exec(build)[1]), DATA_FORMAT);
});

test('serves the site with the right content types', async () => {
  const f = fixture();
  const handle = handler(f, () => Promise.reject(new Error('offline')));
  const page = await get(handle, APP_PAGE);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal((await get(handle, 'app://sg/')).status, 200);
  assert.equal((await get(handle, 'app://sg/vendor/x.wasm')).headers.get('content-type'), 'application/wasm');
  assert.equal(typeOf('data/solicitations.sqlite'), 'application/vnd.sqlite3');
  assert.equal((await get(handle, 'app://sg/missing.js')).status, 404);
  assert.equal((await get(handle, 'app://other/index.html')).status, 404);
});

test('never serves a file outside site/', async () => {
  const f = fixture();
  const handle = handler(f, () => Promise.reject(new Error('offline')));
  for (const u of ['app://sg/..%2fsecret.txt', 'app://sg/%2e%2e/secret.txt', 'app://sg/..%5csecret.txt', 'app://sg/data/..%2f..%2fsecret.txt', 'app://sg/%00']) {
    assert.equal((await get(handle, u)).status, 404, u);
  }
  assert.equal(resolveInside(f.site, '/../secret.txt'), null);
  assert.equal(resolveInside(f.site, '/%E0%A4%A'), null, 'bad escape');
  assert.equal(resolveInside(f.site, '/index.html'), path.join(f.site, 'index.html'));
});

test('data: live first (query kept), and the answer is kept for later', async () => {
  const f = fixture();
  const live = site({ 'catalog.json': () => new Response('["live"]', { headers: { 'content-type': 'application/json' } }) });
  const handle = createHandler({ siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/sams-garage/', fetch: (u, i) => live.fetch(u.replace('/sams-garage', ''), i) });
  const res = await get(handle, 'app://sg/data/catalog.json?v=7');
  assert.equal(await res.text(), '["live"]');
  assert.equal(res.headers.get('x-sg-source'), 'live');
  assert.ok(live.asked.includes('https://live.test/data/catalog.json?v=7'), live.asked.join(' '));
  await wait();
  assert.equal(fs.readFileSync(path.join(f.cache, 'catalog.json'), 'utf8'), '["live"]');
});

test('data: offline -> the kept copy, else the bundled snapshot; a live error is not kept', async () => {
  const f = fixture();
  let res = await get(handler(f, async () => { throw new TypeError('net::ERR_INTERNET_DISCONNECTED'); }), 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["bundled"]');
  assert.equal(res.headers.get('x-sg-source'), 'bundled');
  await get(handler(f, site({ 'catalog.json': () => new Response('["live"]') }).fetch), 'app://sg/data/catalog.json');
  await wait();
  const broken = handler(f, site({ 'catalog.json': () => new Response('oops', { status: 500 }), 'records/a__1.json': () => new Response('x', { status: 503 }) }).fetch);
  res = await get(broken, 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["live"]');
  assert.equal(res.headers.get('x-sg-source'), 'cache');
  assert.equal((await get(broken, 'app://sg/data/records/a__1.json?v=3')).headers.get('x-sg-source'), 'bundled');
  assert.equal((await get(broken, 'app://sg/data/records/none.json')).status, 404);
});

test('data: an HTML page or a wrong body from the live site is never kept or served', async () => {
  const f = fixture();
  const portal = () => new Response('<html>Sign in to the Wi-Fi</html>', { headers: { 'content-type': 'text/html' } });
  const handle = handler(f, site({
    'catalog.json': portal,
    'search-index.json': () => new Response('{"not json'),
    'solicitations.sqlite': () => new Response('<html>nope</html>', { headers: { 'content-type': 'application/octet-stream' } })
  }).fetch);
  for (const [rel, body] of [['catalog.json', '["bundled"]'], ['solicitations.sqlite', null]]) {
    const res = await get(handle, 'app://sg/data/' + rel);
    assert.equal(res.headers.get('x-sg-source'), 'bundled', rel);
    if (body) assert.equal(await res.text(), body);
  }
  assert.equal((await get(handle, 'app://sg/data/search-index.json')).status, 404, 'no copy at all');
  await wait();
  assert.ok(!fs.existsSync(path.join(f.cache, 'catalog.json')), 'nothing kept');
  assert.ok(!fs.existsSync(path.join(f.cache, 'solicitations.sqlite')), 'nothing kept');
  assert.ok(looksValid('x.sqlite', SQLITE) && !looksValid('x.json', Buffer.from('[1]'), 'text/html; charset=utf-8'));
});

test('data: a large JSON body is parsed in full, so a truncated one is not kept', async () => {
  const f = fixture();
  const big = '[' + '"0123456789abcdef",'.repeat(1_000_000); // about 19 MiB, starts like JSON, never closes
  const handle = handler(f, site({ 'search-index.json': () => new Response(big), 'catalog.json': () => new Response(big + '"end"]') }).fetch);
  assert.equal((await get(handle, 'app://sg/data/search-index.json')).status, 404, 'no copy to fall back to');
  const ok = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(ok.headers.get('x-sg-source'), 'live', 'a complete large body is fine');
  await wait();
  assert.ok(!fs.existsSync(path.join(f.cache, 'search-index.json')), 'the truncated body is not kept');
  assert.ok(fs.existsSync(path.join(f.cache, 'catalog.json')));
});

test('data: a poisoned kept copy is skipped and removed', async () => {
  const f = fixture();
  fs.mkdirSync(f.cache, { recursive: true });
  fs.writeFileSync(path.join(f.cache, 'catalog.json'), '<html>captive portal</html>');
  fs.writeFileSync(path.join(f.cache, 'solicitations.sqlite'), 'not sqlite');
  const handle = handler(f, async () => { throw new Error('offline'); });
  assert.equal(await (await get(handle, 'app://sg/data/catalog.json')).text(), '["bundled"]');
  assert.equal((await get(handle, 'app://sg/data/solicitations.sqlite')).headers.get('x-sg-source'), 'bundled');
  assert.ok(!fs.existsSync(path.join(f.cache, 'catalog.json')) && !fs.existsSync(path.join(f.cache, 'solicitations.sqlite')));
});

test('data: live data in a newer format is not used; the page still gets the live meta.json', async () => {
  const f = fixture();
  const live = site({ 'meta.json': () => new Response(`{"format":${DATA_FORMAT + 1}}`), 'catalog.json': () => new Response('{"records":[]}') });
  const handle = handler(f, live.fetch);
  const meta = await get(handle, 'app://sg/data/meta.json');
  assert.equal(JSON.parse(await meta.text()).format, DATA_FORMAT + 1);
  const cat = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(await cat.text(), '["bundled"]');
  assert.ok(!live.asked.some(u => u.includes('catalog.json')), 'the catalog is not even fetched');
  await wait();
  assert.ok(!fs.existsSync(path.join(f.cache, 'meta.json')), 'the newer meta.json is not kept');
});

test('data: a live request that hangs gives up after the timeout', async () => {
  const f = fixture();
  let aborted = false;
  const handle = handler(f, (url, init) => new Promise(() => init.signal.addEventListener('abort', () => { aborted = true; })), { timeoutMs: 60 });
  const t0 = Date.now();
  const res = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["bundled"]');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(aborted, 'the request is aborted');
});

test('HEAD: headers only, no live request and no cache write', async () => {
  const f = fixture();
  const live = site({ 'catalog.json': () => new Response('["live"]') });
  const handle = handler(f, live.fetch);
  const res = await get(handle, 'app://sg/data/catalog.json', 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String('["bundled"]'.length));
  assert.equal(await res.text(), '');
  assert.deepEqual(live.asked, []);
  await wait();
  assert.ok(!fs.existsSync(path.join(f.cache, 'catalog.json')));
});

test('a non-ok live answer has its body cancelled', async () => {
  const f = fixture();
  let cancelled = false;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  const handle = handler(f, site({ 'catalog.json': () => new Response(body, { status: 502 }) }).fetch);
  await get(handle, 'app://sg/data/catalog.json');
  assert.ok(cancelled);
});

test('concurrent requests for one file leave one valid kept copy and no temporary files', async () => {
  const f = fixture();
  let n = 0;
  const handle = handler(f, site({ 'catalog.json': async () => { const i = n++; await new Promise(r => setTimeout(r, i % 3)); return new Response(JSON.stringify([`live-${i}`, 'x'.repeat(5000)])); } }).fetch);
  const all = await Promise.all(Array.from({ length: 20 }, () => get(handle, 'app://sg/data/catalog.json').then(r => r.text())));
  assert.ok(all.every(t => JSON.parse(t)[0].startsWith('live-')));
  await new Promise(r => setTimeout(r, 200));
  const kept = JSON.parse(fs.readFileSync(path.join(f.cache, 'catalog.json'), 'utf8'));
  assert.match(kept[0], /^live-\d+$/);
  assert.deepEqual(fs.readdirSync(f.cache).filter(x => x.endsWith('.tmp')), []);
});

test('stale temporary files in the cache are removed at start', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.cache, 'records'), { recursive: true });
  fs.writeFileSync(path.join(f.cache, 'catalog.json.123.abcd.tmp'), 'half');
  fs.writeFileSync(path.join(f.cache, 'records', 'a__1.json.9.ff.tmp'), 'half');
  const handle = handler(f, async () => { throw new Error('offline'); });
  await get(handle, 'app://sg/data/catalog.json');
  assert.ok(!fs.existsSync(path.join(f.cache, 'catalog.json.123.abcd.tmp')));
  assert.ok(!fs.existsSync(path.join(f.cache, 'records', 'a__1.json.9.ff.tmp')));
});
