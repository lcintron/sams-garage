// The desktop app's app:// handler (electron/protocol.js), run in plain Node with a scripted fetch: files come from
// site/ with the right types and never from outside it, and data/ is live first, then the kept copy, then the
// bundled snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler, resolveInside, typeOf, APP_PAGE } = require('../../electron/protocol.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-desktop-'));
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(site, 'data', 'records'), { recursive: true });
  fs.mkdirSync(path.join(site, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(site, 'vendor', 'x.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(site, 'data', 'catalog.json'), '["bundled"]');
  fs.writeFileSync(path.join(site, 'data', 'records', 'a__1.json'), '{"id":"a:1"}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  return { dir, site, cache: path.join(dir, 'cache') };
}

const get = (handle, url) => handle(new Request(url));
const wait = () => new Promise(r => setTimeout(r, 50)); // the kept copy is written in the background

test('serves the site with the right content types', async () => {
  const f = fixture();
  const handle = createHandler({ siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/', fetch: () => Promise.reject(new Error('offline')) });
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
  const handle = createHandler({ siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/', fetch: () => Promise.reject(new Error('offline')) });
  for (const u of ['app://sg/..%2fsecret.txt', 'app://sg/%2e%2e/secret.txt', 'app://sg/..%5csecret.txt', 'app://sg/data/..%2f..%2fsecret.txt', 'app://sg/%00']) {
    assert.equal((await get(handle, u)).status, 404, u);
  }
  assert.equal(resolveInside(f.site, '/../secret.txt'), null);
  assert.equal(resolveInside(f.site, '/%E0%A4%A'), null, 'bad escape');
  assert.equal(resolveInside(f.site, '/index.html'), path.join(f.site, 'index.html'));
});

test('data: live first (query kept), and the answer is kept for later', async () => {
  const f = fixture();
  const asked = [];
  const handle = createHandler({
    siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/sams-garage/',
    fetch: async url => { asked.push(url); return new Response('["live"]', { status: 200 }); }
  });
  const res = await get(handle, 'app://sg/data/catalog.json?v=7');
  assert.equal(await res.text(), '["live"]');
  assert.equal(res.headers.get('x-sg-source'), 'live');
  assert.deepEqual(asked, ['https://live.test/sams-garage/data/catalog.json?v=7']);
  await wait();
  assert.equal(fs.readFileSync(path.join(f.cache, 'catalog.json'), 'utf8'), '["live"]');
});

test('data: offline -> the kept copy, else the bundled snapshot; a live error is not kept', async () => {
  const f = fixture();
  let mode = 'live';
  const handle = createHandler({
    siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/',
    fetch: async () => {
      if (mode === 'offline') throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
      if (mode === '500') return new Response('oops', { status: 500 });
      return new Response('["live"]', { status: 200 });
    }
  });
  mode = 'offline';
  let res = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["bundled"]');
  assert.equal(res.headers.get('x-sg-source'), 'bundled');
  mode = 'live';
  await get(handle, 'app://sg/data/catalog.json');
  await wait();
  mode = '500';
  res = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["live"]');
  assert.equal(res.headers.get('x-sg-source'), 'cache');
  assert.equal((await get(handle, 'app://sg/data/records/a__1.json?v=3')).headers.get('x-sg-source'), 'bundled');
  assert.equal((await get(handle, 'app://sg/data/records/none.json')).status, 404);
});

test('data: a live request that hangs gives up after the timeout', async () => {
  const f = fixture();
  let aborted = false;
  const handle = createHandler({
    siteDir: f.site, cacheDir: f.cache, liveBase: 'https://live.test/', timeoutMs: 60,
    fetch: (url, init) => new Promise(() => init.signal.addEventListener('abort', () => { aborted = true; }))
  });
  const t0 = Date.now();
  const res = await get(handle, 'app://sg/data/catalog.json');
  assert.equal(await res.text(), '["bundled"]');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(aborted, 'the request is aborted');
});
