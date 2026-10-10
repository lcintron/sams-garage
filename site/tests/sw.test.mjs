// Runs site/sw.js in a VM with an in-memory Cache Storage and a scripted fetch, and checks install, activate and
// each fetch strategy of PLAN.md §6 (shell cache-first in production / network-first on localhost; meta.json
// network-first; catalog/search-index/agencies stale-while-revalidate; records and sqlite cache-first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js'), 'utf8');

/** In-memory CacheStorage good enough for sw.js. */
function makeCaches(base) {
  const stores = new Map();
  const keyOf = (req, ignoreSearch) => {
    const u = new URL(typeof req === 'string' ? req : req.url, base);
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  class Cache {
    constructor() { this.map = new Map(); }
    async match(req, opts = {}) {
      if (opts.ignoreSearch) {
        const want = keyOf(req, true);
        for (const [k, v] of this.map) if (keyOf(k, true) === want) return v.clone();
        return undefined;
      }
      return this.map.get(keyOf(req))?.clone();
    }
    async put(req, res) { this.map.set(keyOf(req), res.clone()); }
    async addAll(reqs) { for (const r of reqs) { const res = await globalFetch(r); if (!res.ok) throw new TypeError('addAll failed ' + r.url); await this.put(r, res); } }
    async keys() { return [...this.map.keys()].map(u => new Request(u)); }
    async delete(req) { return this.map.delete(keyOf(req)); }
  }
  let globalFetch;
  return {
    stores,
    bindFetch(f) { globalFetch = f; },
    async open(name) { if (!stores.has(name)) stores.set(name, new Cache()); return stores.get(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req, opts = {}) {
      const names = opts.cacheName ? [opts.cacheName] : [...stores.keys()];
      for (const n of names) { const hit = await stores.get(n)?.match(req, opts); if (hit) return hit; }
      return undefined;
    }
  };
}

/**
 * Load sw.js for a given origin/scope. `net(url, req)` returns a Response or throws (offline).
 */
function loadSW({ origin = 'https://user.github.io', scope = '/sams-garage/', net }) {
  const listeners = {};
  const calls = { fetch: [], skipWaiting: 0, claim: 0 };
  const base = origin + scope;
  // like a browser, relative URLs resolve against the worker's location
  class SWRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, base).href : input, init); }
  }
  const caches = makeCaches(base);
  const fetchFn = async req => {
    const r = typeof req === 'string' ? new SWRequest(req) : req;
    calls.fetch.push({ url: r.url, cache: r.cache });
    return net(r.url, r);
  };
  caches.bindFetch(fetchFn);
  const self = {
    location: new URL(origin + scope + 'sw.js'),
    registration: { scope: origin + scope },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { calls.skipWaiting++; },
    clients: { claim: async () => { calls.claim++; } }
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchFn, Request: SWRequest, Response, URL, Promise, console, setTimeout });
  vm.runInContext(SRC, ctx);

  async function lifecycle(type) {
    const waits = [];
    listeners[type]({ waitUntil: p => waits.push(p) });
    await Promise.all(waits);
  }
  /** Dispatch a fetch; returns { handled, response, background } */
  async function dispatch(url, init = {}) {
    const { mode, ...rest } = init;
    const request = new Request(new URL(url, origin + scope).href, rest);
    if (mode) Object.defineProperty(request, 'mode', { value: mode }); // "navigate" cannot be constructed in Node
    let responded = null;
    const waits = [];
    listeners.fetch({ request, respondWith: p => { responded = p; }, waitUntil: p => waits.push(p) });
    const response = responded ? await responded : null;
    await Promise.all(waits);
    await new Promise(r => setTimeout(r, 5)); // let background cache puts settle
    return { handled: !!responded, response };
  }
  return { lifecycle, dispatch, caches, calls, SHELL: vm.runInContext('SHELL', ctx), VERSION: vm.runInContext('VERSION', ctx) };
}

const ok = (body, type = 'application/json') => {
  const r = new Response(body, { status: 200, headers: { 'content-type': type } });
  Object.defineProperty(r, 'type', { value: 'basic' }); // same-origin responses are "basic" in browsers
  return r;
};
const notFound = () => { const r = new Response('Not found', { status: 404 }); Object.defineProperty(r, 'type', { value: 'basic' }); return r; };
const offline = () => { throw new TypeError('Failed to fetch'); };

test('install precaches the whole shell with cache: reload and skips waiting', async () => {
  const sw = loadSW({ net: url => ok('file ' + url, 'text/plain') });
  await sw.lifecycle('install');
  const shell = sw.caches.stores.get(sw.VERSION + '-shell');
  assert.equal(shell.map.size, sw.SHELL.length);
  assert.ok(sw.calls.fetch.every(f => f.cache === 'reload'));
  assert.equal(sw.calls.skipWaiting, 1);
});

test('activate deletes old shell caches, keeps the data cache, claims clients', async () => {
  const sw = loadSW({ net: () => ok('x') });
  await sw.caches.open('sg-0.0.1-shell');
  await sw.caches.open('sg-data');
  await sw.caches.open(sw.VERSION + '-shell');
  await sw.lifecycle('activate');
  assert.deepEqual((await sw.caches.keys()).sort(), [sw.VERSION + '-shell', 'sg-data'].sort());
  assert.equal(sw.calls.claim, 1);
});

test('activate moves the SBIR Portal data cache into sg-data, keeping newer entries, then deletes it', async () => {
  const sw = loadSW({ net: () => ok('x') });
  const base = 'https://user.github.io/sams-garage/'; // this worker's scope (loadSW's default)
  const old = 'https://user.github.io/sbir/';           // where SBIR Portal lived
  const legacy = await sw.caches.open('sbir-data');
  await legacy.put(new Request(old + 'data/catalog.json'), ok('["old catalog"]'));
  await legacy.put(new Request(old + 'data/agencies.json'), ok('["old agencies"]'));
  await legacy.put(new Request(old + 'data/records/dsip__A1.json?v=7'), ok('{"id":"dsip:A1"}'));
  await legacy.put(new Request(old + 'data/solicitations.sqlite?v=7'), ok('SQLite format 3', 'application/vnd.sqlite3'));
  await legacy.put(new Request(old + 'index.html'), ok('<html>', 'text/html'));
  const current = await sw.caches.open('sg-data');
  await current.put(new Request(base + 'data/catalog.json'), ok('["new catalog"]'));
  await sw.lifecycle('activate');
  assert.ok(!(await sw.caches.keys()).includes('sbir-data'), 'legacy cache deleted');
  const data = sw.caches.stores.get('sg-data');
  assert.equal(await (await data.match(base + 'data/catalog.json')).text(), '["new catalog"]', 'an existing entry wins');
  assert.equal(await (await data.match(base + 'data/agencies.json')).text(), '["old agencies"]', 'moved onto this scope');
  assert.equal(await (await data.match(base + 'data/records/dsip__A1.json?v=7')).text(), '{"id":"dsip:A1"}', 'query kept');
  assert.equal(await (await data.match(base + 'data/solicitations.sqlite?v=7')).text(), 'SQLite format 3');
  const keys = (await data.keys()).map(r => r.url);
  assert.ok(keys.every(u => u.startsWith(base + 'data/')), keys.join(' '));
  assert.equal(keys.length, 4, 'nothing outside data/ was copied');
});

test('production: shell comes from the cache without touching the network, also offline', async () => {
  let online = true;
  const sw = loadSW({ net: url => (online ? ok('net ' + url, 'text/html') : offline()) });
  await sw.lifecycle('install');
  online = false;
  const n = sw.calls.fetch.length;
  const r = await sw.dispatch('./index.html');
  assert.equal(r.handled, true);
  assert.match(await r.response.text(), /net .*index\.html/);
  const nav = await sw.dispatch('./?utm=x', { mode: 'navigate' });
  assert.equal(nav.response.status, 200, 'navigation with a query is served from the cached ./');
  assert.equal(sw.calls.fetch.length, n, 'no network requests');
});

test('localhost: shell is network-first with the cache as offline fallback', async () => {
  let online = true;
  let version = 1;
  const sw = loadSW({ origin: 'http://localhost:8091', scope: '/', net: () => (online ? ok('v' + version, 'text/css') : offline()) });
  await sw.lifecycle('install');
  version = 2;
  assert.equal(await (await sw.dispatch('./css/app.css')).response.text(), 'v2', 'fresh from the network');
  online = false;
  assert.equal(await (await sw.dispatch('./css/app.css')).response.text(), 'v2', 'cached copy when offline');
});

test('meta.json is network-first, cached copy offline', async () => {
  let online = true, n = 0;
  const sw = loadSW({ net: () => (online ? ok(JSON.stringify({ data_version: 'v' + ++n })) : offline()) });
  assert.equal((await (await sw.dispatch('data/meta.json')).response.json()).data_version, 'v1');
  assert.equal((await (await sw.dispatch('data/meta.json')).response.json()).data_version, 'v2');
  online = false;
  assert.equal((await (await sw.dispatch('data/meta.json')).response.json()).data_version, 'v2');
});

test('catalog is stale-while-revalidate; cache: no-store forces the network', async () => {
  let n = 0;
  const sw = loadSW({ net: () => ok(JSON.stringify([{ id: 'v' + ++n }])) });
  assert.equal((await (await sw.dispatch('data/catalog.json')).response.json())[0].id, 'v1', 'first: network');
  assert.equal((await (await sw.dispatch('data/catalog.json')).response.json())[0].id, 'v1', 'second: cached (stale) copy...');
  assert.equal(n, 2, '...while the network refreshed it in the background');
  assert.equal((await (await sw.dispatch('data/catalog.json')).response.json())[0].id, 'v2', 'third: the refreshed copy');
  assert.equal((await (await sw.dispatch('data/catalog.json', { cache: 'no-store' })).response.json())[0].id, 'v4', 'no-store: network now');
});

test('records and sqlite are cache-first, keyed by ?v=, and a 404 is never cached', async () => {
  let n = 0, missing = true;
  const sw = loadSW({ net: url => (/sqlite/.test(url) && missing ? notFound() : ok(JSON.stringify({ n: ++n }))) });
  const a = await (await sw.dispatch('data/records/dsip__A1.json?v=1')).response.json();
  const b = await (await sw.dispatch('data/records/dsip__A1.json?v=1')).response.json();
  assert.deepEqual(a, b, 'second read from the cache');
  const c = await (await sw.dispatch('data/records/dsip__A1.json?v=2')).response.json();
  assert.notDeepEqual(c, a, 'new data version is a cache miss');
  assert.equal((await sw.dispatch('data/solicitations.sqlite?v=1')).response.status, 404);
  missing = false;
  assert.equal((await sw.dispatch('data/solicitations.sqlite?v=1')).response.status, 200, '404 was not cached');
});

test('cross-origin and non-GET requests are left to the browser', async () => {
  const sw = loadSW({ net: () => ok('x') });
  assert.equal((await sw.dispatch('https://www.sbir.gov/topics')).handled, false);
  assert.equal((await sw.dispatch('data/meta.json', { method: 'POST', body: '{}' })).handled, false);
});
