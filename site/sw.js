/* SAM's Garage service worker: offline app shell + cached data (PLAN.md §6). */
const VERSION = 'sg-0.2.0'; // app version; bump via scripts/release.js
const SHELL_CACHE = VERSION + '-shell';
const DATA_CACHE = 'sg-data'; // not versioned: the last data survives app updates (js/data.js purges old versions)
// Data caches of earlier names, moved into DATA_CACHE on activate (SBIR Portal was the app's name before).
const LEGACY_DATA_CACHES = ['sbir-data'];

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/config.js', './js/ids.js', './js/data.js', './js/search.js', './js/filters.js', './js/profiles.js', './js/store.js', './js/sql.js', './js/export.js',
  './js/ui/dom.js', './js/ui/toast.js', './js/ui/list.js', './js/ui/detail.js', './js/ui/filters-panel.js', './js/ui/stats.js',
  './js/ui/profiles-dialog.js', './js/ui/sql-console.js', './js/ui/about.js',
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
    } else if (/^data\/(catalog|search-index|agencies)\.json$/.test(rel)) {
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
