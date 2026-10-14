/*
 * SAM's Garage — boot, routing and glue.
 *
 * Routes (hash): #/ list · #/s/<id> detail · #/watch watchlist · #/sql SQL console · #/notify notifications · #/about
 * Filters live in the hash query (#/?q=uas&agency=DOD) so every view is shareable (filters.js).
 *
 * Start-up order, so first paint never waits on anything heavy:
 *   1. catalog.json (stale-while-revalidate in the SW) -> render the list
 *   2. meta.json (network-first) in parallel -> freshness pill; refetch data if data_version changed
 *   3. when idle: search-index.json + MiniSearch -> full-text search and description-aware profile scores
 *   4. sql.js + solicitations.sqlite only when #/sql is opened
 */
import * as store from './store.js';
import { parseQuery, toQuery, splitHash, buildHash, defaultState, isFiltered } from './filters.js';
import { allProfiles } from './profiles.js';
import {
  buildIndex, textSearch, fallbackSearch, runPipeline, facetCounts, computeProfileScores, todayISO
} from './search.js';
import * as data from './data.js';
import { toCSV, toJSON, download, exportName } from './export.js';
import { $, h, encodeId } from './ui/dom.js';
import { publicBase, topicLink } from './config.js';
import { aliasMap, resolveId, migrateWatchlist } from './ids.js';
import { toast } from './ui/toast.js';
import { createList } from './ui/list.js';
import { renderDetail, renderMissing } from './ui/detail.js';
import { createFiltersPanel } from './ui/filters-panel.js';
import { initSort, renderCount, renderActiveChips, renderFreshness } from './ui/stats.js';
import { openProfilesDialog } from './ui/profiles-dialog.js';
import * as notify from './notify/page.js';

const APP_VERSION = '0.3.0'; // app version; bump via scripts/release.js
const DESKTOP = window.sgDesktop || null; // the Electron app's bridge (electron/preload.js)
const WIDE = window.matchMedia('(min-width: 1280px)');   // filters as a column (else a drawer)
const SPLIT = window.matchMedia('(min-width: 1024px)');  // list and detail side by side (else detail full-screen)

const app = {
  catalog: [],
  byId: new Map(),
  aliasOf: new Map(),         // old id (an alt_id) -> the record's id now (js/ids.js)
  meta: null,
  version: '',
  agencies: data.agencyInfo(null),
  index: null,
  indexState: 'idle',        // idle | loading | ready | failed
  descriptions: null,        // Map id -> description text (from the search-index docs)
  state: defaultState(),
  route: { name: 'list', id: null },
  listMode: 'all',           // 'all' | 'watch' — which list sits beside a detail
  lastVisit: store.lastVisit(), // baseline for "new" this session; updated in storage only when the app is hidden
  profiles: allProfiles(store.userProfiles()),
  profilesById: new Map(),
  profileScores: new Map(),
  results: [],
  loaded: false,
  rendered: false,
  offline: !navigator.onLine,
  metaReady: null,
  lastMetaCheck: 0
};

// ---------- elements ----------
const el = {
  main: $('#main'), q: $('#q'), list: $('#list'), detail: $('#detail'), count: $('#resultCount'), chips: $('#activeChips'),
  sort: $('#sortSel'), filtersBody: $('#filtersBody'), filtersBtn: $('#filtersBtn'), filtersBadge: $('#filtersBadge'),
  freshness: $('#freshness'), sqlView: $('#sqlView'), aboutView: $('#aboutView'), notifyView: $('#notifyView'), listTitle: $('#listTitle'),
  indexState: $('#indexState'), watchBadge: $('#watchBadge'), scrim: $('#scrim'), themeBtn: $('#themeBtn'),
  installBtn: $('#installBtn'), exportBtn: $('#exportBtn'), exportMenu: $('#exportMenu')
};
const detailEmptyTemplate = el.detail.firstElementChild.cloneNode(true);

const list = createList(el.list, {
  hrefFor: id => buildHash('/s/' + encodeId(id), app.state),
  onStar: id => toggleWatch(id),
  onOpen: id => { location.hash = buildHash('/s/' + encodeId(id), app.state); }
});

const panel = createFiltersPanel(el.filtersBody, {
  onChange: patch => setState(patch),
  onManageProfiles: () => openProfilesDialog(store.userProfiles(), saveUserProfiles),
  onSaveSearch: name => {
    store.saveSearch(name, toQuery(app.state));
    toast(`Saved search “${name}”`);
    refresh({ keepScroll: true });
  },
  onDeleteSearch: name => { store.deleteSearch(name); refresh({ keepScroll: true }); },
  searchHref: query => '#/' + (query ? '?' + query : '')
});

// ---------- state & URL ----------

/** Apply a filter patch, write it to the URL (replaceState: filter tweaks do not flood history), re-render. */
function setState(patch, { keepScroll = false } = {}) {
  app.state = parseQuery(toQuery({ ...app.state, ...patch })); // normalize through the URL format
  const path = app.route.name === 'detail' ? '/s/' + encodeId(app.route.id) : app.listMode === 'watch' ? '/watch' : '/';
  const hash = buildHash(path, app.state);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  if (el.q.value.trim() !== app.state.q) el.q.value = app.state.q;
  refresh({ keepScroll });
}

function backHref() { return buildHash(app.listMode === 'watch' ? '/watch' : '/', app.state); }

// ---------- compute + render ----------

function recomputeProfileScores() {
  app.profilesById = new Map(app.profiles.map(p => [p.id, p]));
  app.profileScores = computeProfileScores(app.catalog, app.profiles, app.descriptions);
}

function ctx() {
  const q = app.state.q;
  return {
    today: todayISO(),
    textScores: q ? (app.index ? textSearch(app.index, q) : fallbackSearch(app.catalog, q)) : null,
    profileScores: app.profileScores,
    profilesById: app.profilesById,
    lastVisit: app.lastVisit
  };
}

/** Recompute results and re-render list, counts, chips and the filter panel. */
function refresh({ keepScroll = false } = {}) {
  if (!app.loaded) return;
  app.rendered = true;
  const c = ctx();
  const watch = store.watchlist();
  let total;
  if (app.listMode === 'watch') {
    const recs = app.catalog.filter(r => watch.has(r.id));
    app.results = runPipeline(recs, { ...defaultState(), status: [], sort: app.state.sort }, { ...c, textScores: null });
    total = recs.length;
  } else {
    app.results = runPipeline(app.catalog, app.state, c);
    total = app.catalog.length;
  }

  el.sort.value = app.state.sort;
  renderCount(el.count, app.results.length, total, app.listMode);
  const nChips = app.listMode === 'watch' ? (el.chips.replaceChildren(), 0) : renderActiveChips(el.chips, app.state, app.profilesById, p => setState(p));
  el.filtersBadge.textContent = String(nChips);
  el.filtersBadge.classList.toggle('hidden', !nChips || app.listMode === 'watch');
  el.listTitle.textContent = app.listMode === 'watch' ? 'Watchlist' : 'Opportunities';
  if (app.route.name === 'list') setListTitle();
  el.main.classList.toggle('mode-watch', app.listMode === 'watch');
  el.filtersBtn.disabled = app.listMode === 'watch';
  updateWatchBadge(watch);

  list.render(app.results, {
    selectedId: app.route.name === 'detail' ? app.route.id : null,
    watch,
    profilesById: app.profilesById,
    activeProfiles: app.state.profile,
    keepScroll,
    empty: emptyState()
  });

  if (app.listMode !== 'watch') {
    const counts = facetCounts(app.catalog, app.state, c);
    const subsByAgency = new Map();
    for (const r of app.catalog) if (r.sub_agency) (subsByAgency.get(r.agency) || subsByAgency.set(r.agency, new Set()).get(r.agency)).add(r.sub_agency);
    panel.render(app.state, counts, {
      agencies: app.agencies,
      profiles: app.profiles,
      saved: store.savedSearches(),
      hasLastVisit: !!app.lastVisit,
      allAgencies: [...new Set([...app.catalog.map(r => r.agency).filter(Boolean), ...app.state.agency])].sort(),
      subsByAgency
    });
  }
}

function setListTitle() {
  document.title = (app.listMode === 'watch' ? 'Watchlist' : app.state.q ? `“${app.state.q}”` : 'Open topics') + " · SAM's Garage";
}

function emptyState() {
  if (app.listMode === 'watch') {
    return h('div', { class: 'empty' }, h('p', { text: 'No starred topics yet.' }),
      h('p', { class: 'small', text: 'Use the ☆ on any topic to keep it here.' }), h('a', { class: 'btn small', href: '#/', text: 'Browse topics' }));
  }
  return h('div', { class: 'empty' }, h('p', { text: 'No topics match these filters.' }),
    isFiltered(app.state) ? h('button', { class: 'btn small', type: 'button', text: 'Clear all filters', onclick: () => setState({ ...defaultState(), sort: app.state.sort }) }) : null);
}

function updateWatchBadge(watch = store.watchlist()) {
  // only count watched ids that exist in the catalog
  const n = app.loaded ? app.catalog.reduce((k, r) => k + (watch.has(r.id) ? 1 : 0), 0) : watch.size;
  el.watchBadge.textContent = String(n);
  el.watchBadge.classList.toggle('hidden', !n);
}

function toggleWatch(id) {
  const on = store.toggleWatch(id);
  toast(on ? 'Added to watchlist' : 'Removed from watchlist', { id: 'watch', timeout: 1800 });
  if (app.listMode === 'watch') refresh({ keepScroll: true });
  else updateWatchBadge();
  return on;
}

// ---------- routing ----------

/**
 * A topic route whose id another record has absorbed (an old link, or the catalog was refreshed while the topic
 * was open): point it at that record and put its id in the address, keeping the filters.
 */
function followAlias(route = app.route) {
  if (route.name !== 'detail' || !app.loaded) return;
  const now = resolveId(route.id, app.byId, app.aliasOf);
  if (now && now !== route.id) {
    route.id = now;
    history.replaceState(null, '', buildHash('/s/' + encodeId(now), app.state));
  }
}

function parseRoute(path) {
  if (path === '/' || path === '') return { name: 'list', id: null, mode: 'all' };
  if (path === '/watch') return { name: 'list', id: null, mode: 'watch' };
  if (path === '/sql') return { name: 'sql' };
  if (path === '/about') return { name: 'about' };
  if (path === '/notify') return { name: 'notify' };
  const m = path.match(/^\/s\/(.+)$/);
  if (m) { try { return { name: 'detail', id: decodeURIComponent(m[1]) }; } catch { return { name: 'detail', id: m[1] }; } }
  return null;
}

async function onHashChange() {
  const { path, query } = splitHash(location.hash);
  const route = parseRoute(path);
  if (!route) { history.replaceState(null, '', '#/' + (query ? '?' + query : '')); return onHashChange(); }

  const prevRoute = app.route;
  const prevMode = app.listMode;
  const stateChanged = toQuery(parseQuery(query)) !== toQuery(app.state);
  if (stateChanged) app.state = parseQuery(query);
  if (route.mode) app.listMode = route.mode;
  followAlias(route); // an old id in a link or bookmark: that record, under its id now
  app.route = route;
  if (el.q.value.trim() !== app.state.q && document.activeElement !== el.q) el.q.value = app.state.q;

  // view switching
  const view = route.name === 'sql' || route.name === 'about' || route.name === 'notify' ? route.name : 'list';
  el.main.dataset.view = view;
  el.sqlView.classList.toggle('hidden', view !== 'sql');
  el.aboutView.classList.toggle('hidden', view !== 'about');
  el.notifyView.classList.toggle('hidden', view !== 'notify');
  el.main.dataset.detail = route.name === 'detail' ? 'open' : 'closed';
  for (const [a, on] of [['#navWatch', route.mode === 'watch' || (route.name === 'detail' && app.listMode === 'watch')], ['#navSql', view === 'sql'], ['#navNotify', view === 'notify'], ['#navAbout', view === 'about']]) {
    const link = $(a);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  closeDrawer();

  if (view === 'sql') {
    document.title = "SQL console · SAM's Garage";
    await app.metaReady;
    const { showSqlConsole } = await import('./ui/sql-console.js');
    showSqlConsole(el.sqlView, { url: data.sqliteURL(app.version), version: app.version || 'none' });
    return;
  }
  if (view === 'about') {
    document.title = "About · SAM's Garage";
    renderAboutView();
    return;
  }
  if (view === 'notify') {
    document.title = "Notifications · SAM's Garage";
    renderNotifyView(new URLSearchParams(query).get('report') === 'last');
    return;
  }

  // list (+ detail)
  const listChanged = !app.rendered || stateChanged || prevMode !== app.listMode || ['sql', 'about', 'notify'].includes(prevRoute.name);
  if (listChanged) refresh();
  if (route.name === 'detail') {
    list.select(route.id);
    showDetail(route.id, prevRoute);
  } else {
    setListTitle();
    list.select(null);
    el.detail.replaceChildren(detailEmptyTemplate.cloneNode(true));
    // coming back from a detail: return focus to its card
    if (prevRoute.name === 'detail' && !SPLIT.matches) list.focusCard(prevRoute.id);
  }
}

let detailToken = 0;
async function showDetail(id, prevRoute) {
  const token = ++detailToken;
  if (!app.loaded) { el.detail.replaceChildren(h('div', { class: 'd-wrap' }, h('div', { class: 'loading-line' }), h('div', { class: 'loading-line' }))); return; }
  const rec = app.byId.get(id);
  if (!rec) { renderMissing(el.detail, id, backHref()); document.title = "Not found · SAM's Garage"; el.detail.querySelector('h2')?.focus(); return; }
  document.title = (rec.topic_number ? rec.topic_number + ' · ' : '') + (rec.title || id) + " · SAM's Garage";
  const result = app.results.find(r => r.rec.id === id);
  const opts = full => ({
    full,
    watched: store.isWatched(id),
    today: todayISO(),
    isNew: result ? result.isNew : false,
    profile: app.profileScores.get(id) || null,
    profilesById: app.profilesById,
    backHref: backHref(),
    onStar: () => {
      const on = toggleWatch(id);
      const star = el.list.querySelector(`.card[data-id="${CSS.escape(id)}"] .star`);
      if (star) star.setAttribute('aria-pressed', on ? 'true' : 'false');
      return on;
    },
    onCopyLink: () => copyText(topicLink(publicBase(), id), 'Link copied'), // the desktop app links to the public site
    onExport: r => download(`${data.idSafe(r.id)}.json`, toJSON(r), 'application/json')
  });
  const sameRecord = prevRoute && prevRoute.name === 'detail' && prevRoute.id === id;
  const { title } = renderDetail(el.detail, rec, opts(null));
  el.detail.scrollTop = 0;
  if (!sameRecord) title.focus({ preventScroll: true });
  await app.metaReady;
  let full;
  try { full = await data.loadRecord(id, app.version); } catch (err) { full = err; }
  if (token !== detailToken) return; // another detail was opened meanwhile
  const hadFocus = el.detail.contains(document.activeElement) && document.activeElement.id === 'detailTitle';
  const scroll = el.detail.scrollTop;
  const r2 = renderDetail(el.detail, rec, opts(full));
  el.detail.scrollTop = scroll;
  if (hadFocus) r2.title.focus({ preventScroll: true });
}

function renderAboutView() {
  import('./ui/about.js').then(({ renderAbout }) => renderAbout(el.aboutView, {
    meta: app.meta,
    appVersion: APP_VERSION,
    theme: store.prefs().theme || 'system',
    catalogCount: app.catalog.length,
    onTheme: t => setTheme(t === 'system' ? null : t),
    onClearLocal: () => {
      if (!confirm('Clear your watchlist, saved searches, keyword profiles and preferences on this device?')) return;
      for (const k of ['watchlist', 'searches', 'profiles', 'prefs', 'lastVisit']) store.remove(k);
      location.reload();
    }
  }));
}

function renderNotifyView(reportLast) {
  import('./ui/notify-view.js').then(({ showNotifyView }) => showNotifyView(el.notifyView, {
    catalog: app.catalog,
    descriptions: app.descriptions,
    profiles: app.profiles,
    watchCount: app.loaded ? app.catalog.reduce((k, r) => k + (store.isWatched(r.id) ? 1 : 0), 0) : store.watchlist().size,
    reportLast,
    toast
  })).catch(err => {
    el.notifyView.replaceChildren(h('div', { class: 'about' }, h('p', { text: 'The notifications view could not load: ' + err.message })));
  });
}

// ---------- data loading ----------

function setCatalog(catalog) {
  app.catalog = Array.isArray(catalog) ? catalog.filter(r => r && r.id) : [];
  app.byId = new Map(app.catalog.map(r => [r.id, r]));
  app.aliasOf = aliasMap(app.catalog);
  // starred topics saved under an id another record has since absorbed follow that record
  const watch = migrateWatchlist(store.watchlist(), app.byId, app.aliasOf);
  if (watch.changed) store.setWatchlist(watch.ids);
  recomputeProfileScores();
  app.loaded = true;
}

async function loadAll() {
  let resolveMeta;
  app.metaReady = new Promise(r => { resolveMeta = r; });
  // All three start at once, but nothing from the catalog or agencies is used before meta.json has settled (the
  // loading skeleton stays meanwhile), so an installed app never renders data newer than it reads. loadMeta gives
  // up on a stalled network after a few seconds and then uses the copy of meta.json in the data cache; with
  // neither (a first visit while offline, when the catalog cannot load either) the app goes ahead ungated.
  const metaP = data.loadMeta().then(m => { app.meta = m; app.version = data.metaVersion(m); return m; }).catch(() => null).finally(() => resolveMeta());
  const catalogP = data.loadCatalog();
  catalogP.catch(() => {}); // handled below
  const agenciesP = data.loadAgencies();
  // The desktop app is exempt (and does not wait): electron/protocol.js only serves it data in a format it reads.
  const early = DESKTOP ? null : await metaP;
  if (!DESKTOP && !data.shouldUseData(early)) {
    await onHashChange();
    showNewerDataNotice();
    renderFreshness(el.freshness, early, app.offline);
    app.lastMetaCheck = Date.now();
    return;
  }

  try {
    setCatalog(await catalogP);
  } catch (err) {
    app.loaded = false;
    const notBuilt = err.status === 404;
    el.count.textContent = notBuilt ? 'No data' : 'Could not load data';
    el.list.replaceChildren(h('div', { class: 'empty' },
      h('p', { text: notBuilt ? 'The data has not been built yet.' : 'The data could not be loaded.' }),
      h('p', { class: 'small' }, notBuilt
        ? ['Run ', h('code', { text: 'python -m scraper build --out site/data' }), ' and reload.']
        : (app.offline ? 'You are offline and no copy is cached yet.' : err.message)),
      h('button', { class: 'btn small', type: 'button', text: 'Retry', onclick: () => location.reload() })));
    metaP.then(m => renderFreshness(el.freshness, m, app.offline));
    return;
  }
  app.agencies = data.agencyInfo(await agenciesP);
  await onHashChange();
  scheduleIndex();

  const meta = await metaP;
  renderFreshness(el.freshness, meta, app.offline);
  app.lastMetaCheck = Date.now();
  if (meta) await checkVersion(meta);
  notify.check(); // the daily report, when it is due and this browser sends it (the desktop app sends on its own)
}

/** The published data is newer than this version reads: no list, a notice and a way to update. */
function showNewerDataNotice() {
  el.count.textContent = 'Update needed';
  el.indexState.textContent = '';
  el.list.replaceChildren(h('div', { class: 'empty' },
    h('p', { text: "A newer version of SAM's Garage is needed for the latest data." }),
    h('button', { class: 'btn small primary', type: 'button', text: 'Reload', onclick: updateAndReload })));
}

/** Fetch the new version of the app (its service worker), let it take over, then reload. */
async function updateAndReload() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update();
      const next = reg.installing || reg.waiting;
      if (next) {
        await new Promise(resolve => {
          const t = setTimeout(resolve, 8000);
          const check = () => { if (next.state === 'activated' || next.state === 'redundant') { clearTimeout(t); resolve(); } };
          next.addEventListener('statechange', check);
          if (next.state === 'installed') next.postMessage({ type: 'SKIP_WAITING' });
          check();
        });
      }
    }
  } catch { /* offline or no worker: a plain reload */ }
  location.reload();
}

/** Newer data than this version of the app reads: keep what is shown and ask for an update. */
function newerFormat(meta) {
  if (data.formatSupported(meta)) return false;
  if (!app.loaded) return true; // nothing shown yet: the list already says so (showNewerDataNotice)
  toast('Update the app to load the newest data.', { id: 'format', timeout: 0 });
  return true;
}

/** Compare meta's data_version with the one the cached catalog belongs to; refetch and say so when it changed. */
async function checkVersion(meta) {
  if (newerFormat(meta)) return;
  const v = data.metaVersion(meta);
  const stored = store.dataVersion();
  if (!v) return;
  if (stored && stored !== v) {
    try {
      const [catalog, agencies] = await Promise.all([data.loadCatalog(true), data.loadAgencies(true)]);
      setCatalog(catalog);
      if (agencies) app.agencies = data.agencyInfo(agencies);
      app.index = null;
      app.descriptions = null;
      app.indexState = 'idle';
      scheduleIndex(true);
      followAlias();
      refresh({ keepScroll: true });
      if (app.route.name === 'detail') showDetail(app.route.id, app.route);
      toast('Data updated — ' + app.catalog.length.toLocaleString() + ' records', { id: 'data' });
    } catch {
      return; // keep showing what we have; try again next time
    }
  }
  store.setDataVersion(v);
  data.purgeStaleData(v);
}

/** Build the full-text index after first paint, when the browser is idle. */
function scheduleIndex(fresh = false) {
  const run = async () => {
    if (app.indexState === 'loading' || app.indexState === 'ready') return;
    app.indexState = 'loading';
    el.indexState.textContent = 'indexing…';
    try {
      const [docs, mod] = await Promise.all([data.loadSearchDocs(fresh), import('../vendor/minisearch/minisearch.js')]);
      const t0 = performance.now();
      app.index = buildIndex(mod.default, Array.isArray(docs) ? docs : []);
      app.descriptions = new Map((docs || []).map(d => [d.id, d.description || '']));
      recomputeProfileScores();
      app.indexState = 'ready';
      el.indexState.textContent = '';
      console.debug(`[sg] indexed ${docs.length} docs in ${(performance.now() - t0).toFixed(0)} ms`);
      followAlias();
      if (app.state.q || app.state.profile.length || app.listMode === 'all') refresh({ keepScroll: true });
      if (app.route.name === 'detail') list.select(app.route.id);
    } catch (err) {
      app.indexState = 'failed';
      el.indexState.textContent = 'basic search';
      el.indexState.title = 'Full-text index unavailable: ' + err.message;
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 200);
}

/** When the app comes back after a while, check whether newer data was published. */
async function recheckMeta() {
  if (Date.now() - app.lastMetaCheck < 30 * 60000) return;
  app.lastMetaCheck = Date.now();
  try {
    const meta = await data.loadMeta();
    app.meta = meta;
    app.version = data.metaVersion(meta);
    renderFreshness(el.freshness, meta, app.offline);
    await checkVersion(meta);
  } catch { /* offline */ }
}

// ---------- profiles ----------

function saveUserProfiles(list) {
  store.setUserProfiles(list);
  app.profiles = allProfiles(list);
  recomputeProfileScores();
  const ids = new Set(app.profiles.map(p => p.id));
  if (app.state.profile.some(id => !ids.has(id))) setState({ profile: app.state.profile.filter(id => ids.has(id)) });
  else refresh({ keepScroll: true });
}

// ---------- header controls ----------

function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  store.setPref('theme', t || null);
  syncThemeUi();
}

function syncThemeUi() {
  const cur = effectiveTheme();
  const next = cur === 'dark' ? 'light' : 'dark';
  el.themeBtn.title = `Switch to ${next} theme`;
  el.themeBtn.setAttribute('aria-label', `Switch to ${next} theme`);
  $('meta[name="theme-color"]').setAttribute('content', cur === 'dark' ? '#0b1118' : '#ffffff');
  // Desktop app: the window buttons drawn over the top bar take the bar's colors.
  if (DESKTOP && DESKTOP.setTitleBarColors) {
    const css = getComputedStyle(document.documentElement);
    DESKTOP.setTitleBarColors({ color: css.getPropertyValue('--bg-2').trim(), symbolColor: css.getPropertyValue('--text').trim() });
  }
}

function openDrawer() {
  document.body.classList.add('filters-open');
  el.scrim.classList.remove('hidden');
  el.filtersBtn.setAttribute('aria-expanded', 'true');
  (el.filtersBody.querySelector('button, input') || $('#filtersClose')).focus();
}
function closeDrawer() {
  if (!document.body.classList.contains('filters-open')) return;
  document.body.classList.remove('filters-open');
  el.scrim.classList.add('hidden');
  el.filtersBtn.setAttribute('aria-expanded', 'false');
}
function toggleFilters() {
  if (WIDE.matches) {
    const collapsed = document.documentElement.classList.toggle('filters-collapsed');
    store.setPref('filtersCollapsed', collapsed);
    el.filtersBtn.setAttribute('aria-expanded', String(!collapsed));
  } else if (document.body.classList.contains('filters-open')) {
    closeDrawer();
    el.filtersBtn.focus();
  } else {
    openDrawer();
  }
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    toast(ok ? okMsg : 'Copy failed — use the address bar');
  }
}

function exportResults(kind) {
  const recs = app.results.map(r => r.rec);
  if (!recs.length) { toast('Nothing to export'); return; }
  const base = app.listMode === 'watch' ? 'sg-watchlist' : 'sg-topics';
  if (kind === 'csv') download(exportName('csv', todayISO(), base), toCSV(recs), 'text/csv;charset=utf-8');
  else download(exportName('json', todayISO(), base), toJSON(recs), 'application/json');
  toast(`Exported ${recs.length.toLocaleString()} ${recs.length === 1 ? 'topic' : 'topics'} as ${kind.toUpperCase()}`);
}

function setupUi() {
  initSort(el.sort, v => setState({ sort: v }));
  syncThemeUi();
  el.filtersBtn.setAttribute('aria-expanded', String(WIDE.matches && !document.documentElement.classList.contains('filters-collapsed')));

  // search box: debounce typing; Enter applies at once and moves to the results
  let t = null;
  el.q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => setState({ q: el.q.value.trim() }), 140);
  });
  el.q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(t); setState({ q: el.q.value.trim() }); }
    if (e.key === 'ArrowDown') { e.preventDefault(); clearTimeout(t); setState({ q: el.q.value.trim() }); list.focusFirst(); }
    if (e.key === 'Escape' && el.q.value) { e.preventDefault(); e.stopPropagation(); el.q.value = ''; setState({ q: '' }); }
  });

  el.themeBtn.addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncThemeUi);
  el.filtersBtn.addEventListener('click', toggleFilters);
  $('#filtersClose').addEventListener('click', () => { if (WIDE.matches) toggleFilters(); else { closeDrawer(); el.filtersBtn.focus(); } });
  $('#filtersReset').addEventListener('click', () => setState({ ...defaultState(), sort: app.state.sort }));
  el.scrim.addEventListener('click', closeDrawer);
  WIDE.addEventListener('change', () => { closeDrawer(); el.filtersBtn.setAttribute('aria-expanded', String(WIDE.matches && !document.documentElement.classList.contains('filters-collapsed'))); });

  $('#skipLink').addEventListener('click', e => { e.preventDefault(); list.focusFirst(); });

  // export menu
  const closeMenu = () => { el.exportMenu.classList.add('hidden'); el.exportBtn.setAttribute('aria-expanded', 'false'); };
  el.exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = el.exportMenu.classList.toggle('hidden') === false;
    el.exportBtn.setAttribute('aria-expanded', String(open));
    if (open) el.exportMenu.querySelector('button').focus();
  });
  el.exportMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-export]');
    if (b) { closeMenu(); exportResults(b.dataset.export); }
  });
  el.exportMenu.addEventListener('keydown', e => {
    const items = [...el.exportMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); el.exportBtn.focus(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) closeMenu(); });

  // global keys
  document.addEventListener('keydown', e => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); el.q.focus(); el.q.select(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (document.querySelector('dialog[open]')) return; // the dialog closes itself
      if (document.body.classList.contains('filters-open')) { closeDrawer(); el.filtersBtn.focus(); return; }
      if (app.route.name === 'detail') {
        const id = app.route.id;
        location.hash = backHref();
        setTimeout(() => list.focusCard(id), 0);
      }
    }
  });

  // last visit: stored when the app is hidden or closed, never on load
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.markVisit();
    else { recheckMeta(); notify.check(); }
  });
  window.addEventListener('pagehide', () => store.markVisit());

  window.addEventListener('online', () => { app.offline = false; renderFreshness(el.freshness, app.meta, false); toast('Back online'); recheckMeta(); });
  window.addEventListener('offline', () => { app.offline = true; renderFreshness(el.freshness, app.meta, true); toast('Offline: showing the last data loaded'); });
  window.addEventListener('hashchange', () => { onHashChange(); });
}

// ---------- PWA ----------

function setupPwa() {
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    el.installBtn.classList.remove('hidden');
  });
  el.installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    el.installBtn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => { el.installBtn.classList.add('hidden'); toast('Installed'); });

  // The desktop app has no service worker: its files are on disk and it keeps the data fresh itself (electron/).
  if (DESKTOP || !('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller; // the first install also takes control: that is not an update
  sw.addEventListener('controllerchange', () => {
    if (!hadController) return;
    toast("A new version of SAM's Garage is ready.", { action: 'Reload', onAction: () => location.reload(), timeout: 0, id: 'update' });
  });
  sw.register('sw.js').then(reg => {
    // a worker waiting from an older tab: let it take over (it calls skipWaiting itself, this is belt and braces)
    if (reg.waiting && hadController) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // the daily report's Periodic Background Sync follows the saved settings
    notify.load().then(r => notify.syncPeriodic(r.settings)).catch(() => {});
  }).catch(err => console.warn('Service worker not registered', err));
  // a click on the report notification, when the open page is not controlled by the worker
  sw.addEventListener('message', e => {
    const d = e.data;
    if (d && d.type === 'OPEN' && typeof d.url === 'string' && new URL(d.url, location.href).origin === location.origin) location.href = d.url;
  });
}

// ---------- boot ----------

setupUi();
setupPwa();
notify.startMirroring(); // the watchlist and profiles, where the background report reads them
notify.onDesktopNavigate(hash => { if (/^#\/[a-z]/.test(hash)) location.hash = hash; });
el.q.value = parseQuery(splitHash(location.hash).query).q;
loadAll();
