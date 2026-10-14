// Runs site/sw.js in a VM with an in-memory Cache Storage and a scripted fetch, and checks install, activate and
// each fetch strategy of PLAN.md §6 (shell cache-first in production / network-first on localhost; meta.json
// network-first; catalog/search-index/agencies stale-while-revalidate; records and sqlite cache-first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');

/**
 * A small IndexedDB: one object store, values structured-cloned, and transactions run one after another like the
 * real thing (that is what makes js/notify/idb.js's lock a lock).
 */
function fakeIndexedDB() {
  const data = new Map();
  let last = Promise.resolve();
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  function transaction() {
    const t = {}, queue = [];
    let release;
    const finished = new Promise(r => { release = r; });
    const prev = last;
    last = finished;
    const op = fn => { const req = {}; queue.push([fn, req]); return req; };
    const step = async () => {
      while (queue.length) {
        const [fn, req] = queue.shift();
        await null;
        req.result = fn();
        if (req.onsuccess) req.onsuccess();
      }
      await null;
      if (queue.length) return step();
      if (t.oncomplete) t.oncomplete();
      release();
    };
    t.objectStore = () => ({ get: k => op(() => clone(data.get(k))), put: (v, k) => op(() => { data.set(k, clone(v)); }), delete: k => op(() => { data.delete(k); }) });
    t.abort = () => {};
    prev.then(step);
    return t;
  }
  return {
    data,
    open() {
      const req = {};
      Promise.resolve().then(() => {
        req.result = { objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction, close() {} };
        req.onsuccess();
      });
      return req;
    }
  };
}

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
function loadSW({ origin = 'https://user.github.io', scope = '/sams-garage/', net, idb = fakeIndexedDB(), permission = 'default', windows = [] }) {
  const listeners = {};
  const calls = { fetch: [], skipWaiting: 0, claim: 0, notifications: [], opened: [] };
  const base = origin + scope;
  // like a browser, relative URLs resolve against the worker's location
  class SWRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, base).href : input, init); }
  }
  const caches = makeCaches(base);
  const fetchFn = async (req, init) => {
    const r = typeof req === 'string' ? new SWRequest(req, init) : req;
    calls.fetch.push({ url: r.url, cache: r.cache, method: r.method });
    return net(r.url, r);
  };
  caches.bindFetch(fetchFn);
  const self = {
    location: new URL(origin + scope + 'sw.js'),
    registration: { scope: origin + scope, showNotification: async (title, options) => { calls.notifications.push({ title, options }); } },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { calls.skipWaiting++; },
    clients: {
      claim: async () => { calls.claim++; },
      matchAll: async () => windows,
      openWindow: async url => { calls.opened.push(url); }
    }
  };
  const ctx = vm.createContext({
    self, caches, fetch: fetchFn, Request: SWRequest, Response, URL, URLSearchParams, Promise, console, setTimeout, clearTimeout,
    AbortController, structuredClone, crypto: globalThis.crypto, indexedDB: idb, Notification: { permission }
  });
  // importScripts as in a classic worker: the scripts run in the worker's global scope
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx, { filename: f }); };
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
  /** Dispatch an event of another type (periodicsync, notificationclick) and wait for its waitUntil. */
  async function fire(type, props) {
    const waits = [];
    listeners[type]({ ...props, waitUntil: p => waits.push(p) });
    return Promise.all(waits);
  }
  return { lifecycle, dispatch, fire, caches, calls, ctx, idb, SHELL: vm.runInContext('SHELL', ctx), VERSION: vm.runInContext('VERSION', ctx) };
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

// ---------------------------------------------------------------------------------------------------------------------
// daily notification report
// ---------------------------------------------------------------------------------------------------------------------

const LIVE = 'https://user.github.io/sams-garage/';
const RUN = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const CATALOG = [
  { id: 'dsip:A1', title: 'Small UAS swarms', agency: 'DOD', sub_agency: 'ARMY', status: 'open', close_date: '2026-11-01', alt_ids: [] },
  { id: 'grants:2', title: 'Battery recycling', agency: 'DOE', status: 'open', close_date: '2026-12-01', alt_ids: ['sbirgov:2'] }
];
const CHANGES = { last_run: RUN, since: null, events: [
  { at: RUN, id: 'dsip:A1', event: 'new', from: null, to: 'open' },
  { at: RUN, id: 'sbirgov:2', event: 'status', from: 'pre_release', to: 'open' }
] };
const DISCORD = 'https://discord.com/api/webhooks/1/abc';
const TEAMS = 'https://prod-1.westus.logic.azure.com/workflows/x';

/** A live site plus webhooks: records every webhook request; meta.json in `format`. */
function liveNet({ format = 1 } = {}) {
  const posts = [];
  const net = async (url, req) => {
    if (url === DISCORD || url === TEAMS) { posts.push({ url, method: req.method, body: await req.text() }); return new Response(null, { status: 204 }); }
    const rel = url.slice(LIVE.length);
    const files = { 'data/meta.json': { format, last_run: RUN }, 'data/catalog.json': CATALOG, 'data/changes.json': CHANGES, 'data/search-index.json': [{ id: 'dsip:A1', description: 'drones' }] };
    if (rel in files) return ok(JSON.stringify(files[rel]));
    return notFound();
  };
  return { net, posts };
}

async function seed(sw, over = {}) {
  const kv = sw.ctx.SgIdb;
  await kv.set('notify-settings', {
    enabled: true, time: '00:00', triggers: { keywords: ['uas'] },
    channels: [{ id: 'd1', type: 'discord', name: 'Ops', url: DISCORD }, { id: 't1', type: 'teams', url: TEAMS }], ...over
  });
  await kv.set('watchlist', ['sbirgov:2']);
  return kv;
}

test('notify: importScripts loads the shared engine, the IndexedDB wrapper and the runner', () => {
  const sw = loadSW({ net: () => ok('x') });
  for (const name of ['SgNotify', 'SgIdb', 'SgNotifyRunner']) assert.equal(typeof sw.ctx[name], 'object', name);
  for (const f of ['./js/notify/core.js', './js/notify/idb.js', './js/notify/runner.js']) assert.ok(sw.SHELL.includes(f), f);
});

test('notify: periodicsync sends the report to the channels a browser can reach, stores it, shows a notification', async () => {
  const live = liveNet();
  const sw = loadSW({ net: live.net, permission: 'granted' });
  const kv = await seed(sw);
  await sw.fire('periodicsync', { tag: 'sg-daily-report' });
  assert.equal(live.posts.length, 1, 'Discord only: Teams is desktop/Actions only');
  assert.equal(live.posts[0].url, DISCORD);
  const body = JSON.parse(live.posts[0].body);
  assert.equal(body.username, "SAM's Garage");
  const text = body.embeds.map(e => `${e.title} ${e.description}`).join('\n');
  assert.match(text, /Starred updates \(1\)/);
  assert.match(text, /Battery recycling/, 'the starred topic, found through its old id');
  assert.match(text, /New matches \(1\)[\s\S]*Small UAS swarms/);
  const state = await kv.get('notify-state');
  assert.equal(state.channels.d1.through, RUN);
  assert.equal(state.channels.t1, undefined, 'Teams untouched');
  assert.equal(state.channels.__local.date, state.lastSent.date);
  assert.equal((await kv.get('notify-last-report')).digest.counts.total, 2);
  assert.equal(sw.calls.notifications.length, 1);
  const n = sw.calls.notifications[0];
  assert.equal(n.title, "SAM's Garage: 1 starred update, 1 new match");
  assert.equal(n.options.tag, 'sg-daily-report');
  assert.equal(n.options.data.url, LIVE + '#/notify?report=last');
  // another wake-up the same day sends nothing
  await sw.fire('periodicsync', { tag: 'sg-daily-report' });
  assert.equal(live.posts.length, 1);
  assert.equal(sw.calls.notifications.length, 1);
});

test('notify: no notification without permission; other periodicsync tags and paused settings do nothing', async () => {
  const live = liveNet();
  const sw = loadSW({ net: live.net });
  await seed(sw, { enabled: false });
  await sw.fire('periodicsync', { tag: 'sg-daily-report' });
  assert.equal(live.posts.length, 0, 'paused');
  await seed(sw);
  await sw.fire('periodicsync', { tag: 'something-else' });
  assert.equal(live.posts.length, 0);
  await sw.fire('periodicsync', { tag: 'sg-daily-report' });
  assert.equal(live.posts.length, 1);
  assert.equal(sw.calls.notifications.length, 0, 'permission not granted');
});

test('notify: live data in a newer format is not used', async () => {
  const live = liveNet({ format: 2 });
  const sw = loadSW({ net: live.net, permission: 'granted' });
  const kv = await seed(sw);
  await sw.fire('periodicsync', { tag: 'sg-daily-report' });
  assert.equal(live.posts.length, 0);
  assert.equal(sw.calls.fetch.filter(f => f.url.endsWith('catalog.json')).length, 0);
  assert.deepEqual((await kv.get('notify-state')).channels, {});
});

test('notify: the shared lock keeps the page and the worker from sending twice', async () => {
  const live = liveNet();
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = async (url, req) => { if (url === DISCORD) await gate; return live.net(url, req); };
  const sw = loadSW({ net: slow, permission: 'granted' });
  const kv = await seed(sw);
  const worker = sw.fire('periodicsync', { tag: 'sg-daily-report' });
  await new Promise(r => setTimeout(r, 30)); // the worker holds the lock and waits on Discord
  const page = await sw.ctx.SgNotifyRunner.run({ kv, base: LIVE, owner: 'page', fetch: (u, i) => sw.ctx.fetch(u, i) });
  assert.equal(page.reason, 'locked');
  release();
  await worker;
  assert.equal(live.posts.length, 1);
  const again = await sw.ctx.SgNotifyRunner.run({ kv, base: LIVE, owner: 'page', fetch: (u, i) => sw.ctx.fetch(u, i) });
  assert.equal(again.reason, 'not-due', 'the lock was released and the report is done for today');
  assert.equal(live.posts.length, 1);
});

test('idb lock: free, expired or own leases can be taken; another live lease cannot', async () => {
  const sw = loadSW({ net: () => ok('x') });
  const kv = sw.ctx.SgIdb;
  assert.equal(kv.canLock(undefined, 'a', 10), true);
  assert.equal(kv.canLock({ owner: 'b', until: 20 }, 'a', 10), false);
  assert.equal(kv.canLock({ owner: 'b', until: 5 }, 'a', 10), true, 'expired');
  assert.equal(kv.canLock({ owner: 'a', until: 20 }, 'a', 10), true, 'own');
  const both = await Promise.all([kv.lock('x', 'page', 60000), kv.lock('x', 'sw', 60000)]);
  assert.deepEqual(both, [true, false], 'transactions run one after another');
  await kv.unlock('x', 'sw'); // not the owner: no effect
  assert.equal(await kv.lock('x', 'sw', 60000), false);
  await kv.unlock('x', 'page');
  assert.equal(await kv.lock('x', 'sw', 60000), true);
  assert.equal(await kv.update('n', v => (v || 0) + 1), 1);
  assert.equal(await kv.update('n', v => (v || 0) + 1), 2);
  await kv.del('n');
  assert.equal(await kv.get('n'), undefined);
});

test('notify: two page tabs never share the lock (owners are unique per context)', async () => {
  const live = liveNet();
  const sw = loadSW({ net: live.net });
  const kv = await seed(sw);
  assert.match(sw.ctx.LOCK_OWNER || vm.runInContext('LOCK_OWNER', sw.ctx), /^sw:[0-9a-f-]{8,}/);
  assert.equal(await kv.lock('notify', 'page:tab-a', 60000), true);
  assert.equal(await kv.lock('notify', 'page:tab-b', 60000), false, 'another tab is refused');
  const r = await sw.ctx.SgNotifyRunner.run({ kv, base: LIVE, owner: 'page:tab-b', fetch: (u, i) => sw.ctx.fetch(u, i) });
  assert.equal(r.reason, 'locked');
  assert.equal(live.posts.length, 0);
  await kv.unlock('notify', 'page:tab-b'); // not the holder: no effect
  assert.equal(await kv.lock('notify', 'page:tab-b', 60000), false);
  await kv.unlock('notify', 'page:tab-a');
  assert.equal(await kv.lock('notify', 'page:tab-b', 60000), true);
});

test('page.js gives each tab its own lock owner', () => {
  const src = fs.readFileSync(path.join(SITE, 'js', 'notify', 'page.js'), 'utf8');
  assert.match(src, /const OWNER = 'page:' +/);
  assert.match(src, /owner: OWNER/);
  assert.doesNotMatch(src, /owner: 'page'/);
});

test('notify: a click on the notification focuses the app at the last report, or opens it', async () => {
  const nav = [];
  const win = { url: LIVE + '#/', focus: async () => { nav.push('focus'); }, navigate: async url => { nav.push(url); } };
  const sw = loadSW({ net: () => ok('x'), windows: [win] });
  let closed = false;
  await sw.fire('notificationclick', { notification: { close: () => { closed = true; }, data: { url: LIVE + '#/notify?report=last' } } });
  assert.ok(closed);
  assert.deepEqual(nav, ['focus', LIVE + '#/notify?report=last']);
  const sw2 = loadSW({ net: () => ok('x') });
  await sw2.fire('notificationclick', { notification: { close() {}, data: { url: 'https://evil.example/' } } });
  assert.deepEqual(sw2.calls.opened, [LIVE + '#/notify?report=last'], 'only the app itself is ever opened');
});
