/* SAM's Garage service worker: offline app shell + cached data (PLAN.md §6), and the browser's daily notification
 * report (PLAN.md "Notifications"). A classic worker on purpose: module service workers would break Firefox's offline
 * support, so the shared notification code is written as classic scripts and loaded with importScripts. */
importScripts('js/notify/core.js', 'js/notify/idb.js', 'js/notify/runner.js');
const VERSION = 'sg-0.4.1'; // app version; bump via scripts/release.js
const SHELL_CACHE = VERSION + '-shell';
const DATA_CACHE = 'sg-data'; // not versioned: the last data survives app updates (js/data.js purges old versions)
// Data caches of earlier names, moved into DATA_CACHE on activate (SBIR Portal was the app's name before).
const LEGACY_DATA_CACHES = ['sbir-data'];

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/config.js', './js/ids.js', './js/data.js', './js/search.js', './js/filters.js', './js/nav.js', './js/profiles.js', './js/store.js', './js/sql.js', './js/export.js',
  './js/ui/dom.js', './js/ui/toast.js', './js/ui/list.js', './js/ui/detail.js', './js/ui/filters-panel.js', './js/ui/stats.js',
  './js/ui/profiles-dialog.js', './js/ui/sql-console.js', './js/ui/about.js', './js/ui/settings.js', './js/ui/notify-view.js',
  './js/notify/core.js', './js/notify/idb.js', './js/notify/runner.js', './js/notify/page.js',
  './vendor/minisearch/minisearch.js',
  './vendor/sqljs/sql-wasm.js', './vendor/sqljs/sql-wasm.wasm',
  './icons/icon.svg', './icons/favicon.ico', './icons/favicon-32.png', './icons/apple-touch-icon.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-192-maskable.png', './icons/icon-512-maskable.png'
];

// On a development host the shell comes from the network first so edits show up at once (GenGIS pattern).
// Anywhere else the installed version's files come from its cache and a new release replaces them as a set.
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);

self.addEventListener('install', e => {
  // 'reload' bypasses the HTTP cache: a new version must not be built from files cached for the old one
  e.waitUntil(caches.open(SHELL_CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

/**
 * Copy every data entry of a legacy data cache into DATA_CACHE (entries already there win), so offline data
 * survives the rename too. The old app may have lived under another path, so each entry is filed under this
 * worker's scope: everything from "data/" on (query included) is kept, e.g. /sbir/data/catalog.json ->
 * <scope>data/catalog.json; entries outside a data/ folder are dropped. Returns the legacy caches that could not
 * be copied: they are kept for the next activation.
 */
async function adoptLegacyData(keys) {
  const keep = new Set();
  for (const name of LEGACY_DATA_CACHES.filter(n => keys.includes(n))) {
    try {
      const from = await caches.open(name);
      const to = await caches.open(DATA_CACHE);
      for (const req of await from.keys()) {
        const old = new URL(req.url);
        const at = old.pathname.indexOf('/data/');
        if (at < 0) continue;
        const url = new URL(old.pathname.slice(at + 1) + old.search, self.registration.scope).href;
        if (await to.match(url)) continue;
        const res = await from.match(req);
        if (res) await to.put(url, res);
      }
    } catch {
      keep.add(name);
    }
  }
  return keep;
}

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(async keys => {
      const keep = await adoptLegacyData(keys);
      await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE && !keep.has(k)).map(k => caches.delete(k)));
    })
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Store a good response in a cache (in the background). */
function put(cacheName, req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(cacheName).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

/** Network first, cached copy when offline. */
async function networkFirst(req, cacheName) {
  try {
    return put(cacheName, req, await fetch(req));
  } catch (err) {
    const hit = await caches.match(req, { cacheName });
    if (hit) return hit;
    throw err;
  }
}

/** Cached copy at once, refreshed in the background; network when nothing is cached. */
async function staleWhileRevalidate(e, req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => put(cacheName, req, res));
  if (hit) {
    e.waitUntil(net.catch(() => {}));
    return hit;
  }
  return net;
}

/** Cached copy if there is one, else the network (and cache it). */
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  return put(cacheName, req, await fetch(req));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nothing cross-origin is cached

  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;

  if (rel.startsWith('data/')) {
    if (rel === 'data/meta.json') {
      e.respondWith(networkFirst(req, DATA_CACHE));
    } else if (/^data\/(catalog|search-index|agencies|changes)\.json$/.test(rel)) {
      // The app asks with cache: 'no-store' after a data_version change: then it must get the network copy.
      e.respondWith(req.cache === 'no-store' || req.cache === 'reload' ? networkFirst(req, DATA_CACHE) : staleWhileRevalidate(e, req, DATA_CACHE));
    } else if (rel.startsWith('data/records/') || rel === 'data/solicitations.sqlite') {
      e.respondWith(cacheFirst(req, DATA_CACHE));
    }
    return; // anything else under data/: straight to the network
  }

  // App shell
  if (DEV) {
    e.respondWith(networkFirst(req, SHELL_CACHE)
      .catch(() => req.mode === 'navigate' ? caches.match('./index.html').then(r => r || Response.error()) : Response.error()));
  } else {
    // A page address may carry a query (?utm=…) that is not part of the cached entry.
    e.respondWith(caches.open(SHELL_CACHE)
      .then(c => c.match(req, { ignoreSearch: req.mode === 'navigate' }))
      .then(hit => hit || networkFirst(req, SHELL_CACHE).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
  }
});

// ---------- daily notification report (best effort: only while the browser runs) ----------
// Periodic Background Sync (installed Chromium apps, with permission) wakes the worker about twice a day; the page
// runs the same check on load and when it becomes visible. js/notify/runner.js does the work; a lock in IndexedDB
// keeps the page and the worker from sending the same report twice.
const REPORT_TAG = 'sg-daily-report';
// This worker's name for the shared lock: unique per worker instance (each page tab has its own too).
const LOCK_OWNER = 'sw:' + (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function backgroundReport(mode) {
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  return SgNotifyRunner.run({
    kv: SgIdb, base: self.registration.scope, owner: LOCK_OWNER, mode,
    fetch: (url, init) => fetch(url, init),
    notify: granted ? (title, options) => self.registration.showNotification(title, options) : undefined
  }).catch(err => { console.warn('[sg] notification report failed', err); return { reason: 'error', error: String(err) }; });
}

self.addEventListener('periodicsync', e => {
  if (e.tag === REPORT_TAG) e.waitUntil(backgroundReport('scheduled'));
});

// A click on the report notification opens the app (or focuses it) at the last report.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const fallback = new URL('./#/notify?report=last', self.registration.scope).href;
  const want = e.notification.data && typeof e.notification.data.url === 'string' ? e.notification.data.url : fallback;
  const url = new URL(want, self.registration.scope).origin === self.location.origin ? want : fallback;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    const scope = self.registration.scope;
    const win = list.find(c => c.url.startsWith(scope));
    if (win) {
      await win.focus();
      if (win.navigate) { try { await win.navigate(url); return; } catch (err) { /* not controlled: tell the page */ } }
      win.postMessage({ type: 'OPEN', url });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  }));
});
