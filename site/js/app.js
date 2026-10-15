/*
 * SAM's Garage — boot, routing and glue.
 *
 * Routes (hash): #/ list · #/s/<id> detail · #/watch watchlist · #/sql SQL console · #/notify notifications ·
 * #/settings · #/about (js/nav.js). Filters live in the hash query of the list routes (#/?q=uas&agency=DOD) so every
 * view is shareable (filters.js); the other views leave them as they were, and their "← Opportunities" goes back to them.
 *
 * The menu button opens the side panel: navigation, the filters (on the list of all topics) and a footer with the
 * theme, Settings and About. From 1280 px it is a docked column the button collapses; below, a modal drawer.
 *
 * Start-up order, so first paint never waits on anything heavy:
 *   1. catalog.json (stale-while-revalidate in the SW) -> render the list
 *   2. meta.json (network-first) in parallel -> freshness pill; refetch data if data_version changed
 *   3. when idle: search-index.json + MiniSearch -> full-text search and description-aware profile scores
 *   4. sql.js + solicitations.sqlite only when #/sql is opened
 *   5. after that: the notification code (js/notify/page.js) - the due check, mirroring the watchlist, the periodic sync
 */
import * as store from './store.js';
import { parseQuery, toQuery, splitHash, buildHash, defaultState, isFiltered } from './filters.js';
import {
  WIDE_MIN, parseRoute, viewOf, keepsState, activeNav, showsFilters, isSecondary, homeHref, watchHref, viewTitle, themeChoice
} from './nav.js';
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

const APP_VERSION = '0.3.0'; // app version; bump via scripts/release.js
// The notification code loads after the first paint (startNotifications), or at once when #/notify is opened first.
let notifyP = null;
const loadNotify = () => (notifyP = notifyP || import('./notify/page.js'));
const DESKTOP = window.sgDesktop || null; // the Electron app's bridge (electron/preload.js)
const WIDE = window.matchMedia(`(min-width: ${WIDE_MIN}px)`); // the side panel docked as a column (else a drawer)
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
  lastMetaCheck: 0,
  installPrompt: null        // the browser's install offer (beforeinstallprompt), while it stands
};

// ---------- elements ----------
const el = {
  main: $('#main'), q: $('#q'), list: $('#list'), detail: $('#detail'), count: $('#resultCount'), chips: $('#activeChips'),
  sort: $('#sortSel'), filters: $('#filters'), filtersBody: $('#filtersBody'), filtersCount: $('#filtersCount'),
  menuBtn: $('#menuBtn'), menuBadge: $('#menuBadge'), panel: $('#sidepanel'), panelScroll: $('#panelScroll'), showResults: $('#showResults'),
  freshness: $('#freshness'), listTitle: $('#listTitle'), indexState: $('#indexState'),
  watchBadge: $('#watchBadge'), watchCount: $('#navWatchCount'), scrim: $('#scrim'),
  installBtn: $('#installBtn'), exportBtn: $('#exportBtn'), exportMenu: $('#exportMenu'),
  // each view: its section (header + body) and the body its module renders into
  views: {
    sql: { section: $('#sqlView'), body: $('#sqlBody') },
    notify: { section: $('#notifyView'), body: $('#notifyBody') },
    settings: { section: $('#settingsView'), body: $('#settingsBody') },
    about: { section: $('#aboutView'), body: $('#aboutBody') }
  }
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
  // a search typed on another view (the search box is in the header) shows its results: the list, as a new page
  if (viewOf(app.route) !== 'list') { location.hash = homeHref(app.state); return; }
  const path = app.route.name === 'detail' ? '/s/' + encodeId(app.route.id) : app.listMode === 'watch' ? '/watch' : '/';
  const hash = buildHash(path, app.state);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  if (el.q.value.trim() !== app.state.q) el.q.value = app.state.q;
  syncNav();
  refresh({ keepScroll });
}

/** Where a detail's Back (and Esc) goes: the list it was opened from. */
function backHref() { return app.listMode === 'watch' ? watchHref(app.state) : homeHref(app.state); }

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

/** The watchlist's state: the search and the sort; every status, no filters. */
const watchState = () => ({ ...defaultState(), status: [], q: app.state.q, sort: app.state.sort });

/** Recompute results and re-render list, counts, chips and the filter panel. */
function refresh({ keepScroll = false } = {}) {
  if (!app.loaded) return;
  app.rendered = true;
  const c = ctx();
  const watch = store.watchlist();
  let total;
  if (app.listMode === 'watch') {
    // the starred topics, searched by the search box; the filters do not apply to them
    const recs = app.catalog.filter(r => watch.has(r.id));
    app.results = runPipeline(recs, watchState(), c);
    total = recs.length;
  } else {
    app.results = runPipeline(app.catalog, app.state, c);
    total = app.catalog.length;
  }

  el.sort.value = app.state.sort;
  renderCount(el.count, app.results.length, total, app.listMode);
  // on the watchlist, only the search has a chip
  const chipState = app.listMode === 'watch' ? { ...defaultState(), q: app.state.q, sort: app.state.sort } : app.state;
  const nChips = renderActiveChips(el.chips, chipState, app.profilesById, p => setState(p));
  showFilterCount(app.listMode === 'watch' ? 0 : nChips); // the filters are not used on the watchlist
  el.showResults.textContent = app.results.length === 1 ? 'Show 1 result' : `Show ${app.results.length.toLocaleString()} results`;
  el.listTitle.textContent = app.listMode === 'watch' ? 'Watchlist' : 'Opportunities';
  if (app.route.name === 'list') setListTitle();
  el.main.classList.toggle('mode-watch', app.listMode === 'watch');
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

/** The number of active filters: on the menu button (it opens them) and beside the Filters heading. */
function showFilterCount(n) {
  for (const b of [el.menuBadge, el.filtersCount]) {
    b.textContent = String(n);
    b.classList.toggle('hidden', !n);
  }
  el.filtersCount.title = n === 1 ? '1 active filter' : `${n} active filters`;
  el.menuBtn.setAttribute('aria-label', n ? `Menu (${n} active ${n === 1 ? 'filter' : 'filters'})` : 'Menu');
}

/**
 * The navigation in step with the route and the filters: the current panel item, the header star, the links that
 * keep the filters (home, the back links, the watchlist), and the filters section (only on the list of all topics).
 */
function syncNav() {
  const cur = activeNav(app.route, app.listMode);
  for (const a of document.querySelectorAll('#sidepanel [data-nav], #watchBtn')) {
    const on = (a.dataset.nav || 'watch') === cur;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const home = homeHref(app.state), watch = watchHref(app.state);
  for (const a of document.querySelectorAll('#navHome, .back-home')) a.setAttribute('href', home);
  for (const a of document.querySelectorAll('#navWatch, #watchBtn')) a.setAttribute('href', watch);
  el.filters.classList.toggle('hidden', !showsFilters(app.route, app.listMode));
}

function emptyState() {
  if (app.listMode === 'watch' && app.state.q && store.watchlist().size) {
    return h('div', { class: 'empty' }, h('p', { text: `No starred topics match “${app.state.q}”.` }),
      h('button', { class: 'btn small', type: 'button', text: 'Clear the search', onclick: () => setState({ q: '' }) }));
  }
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
  el.watchCount.textContent = n ? String(n) : '';
  el.watchCount.title = n === 1 ? '1 starred topic' : `${n} starred topics`;
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

const VIEW_FOCUS = new Set(['settings', 'about', 'notify']);

async function onHashChange() {
  const { path, query } = splitHash(location.hash);
  const route = parseRoute(path);
  if (!route) { history.replaceState(null, '', '#/' + (query ? '?' + query : '')); return onHashChange(); }

  const prevRoute = app.route;
  const prevMode = app.listMode;
  // the list routes carry the filters in their query; the other views keep them as they were (their back links use them)
  const stateChanged = keepsState(route) && toQuery(parseQuery(query)) !== toQuery(app.state);
  if (stateChanged) app.state = parseQuery(query);
  if (route.mode) app.listMode = route.mode;
  followAlias(route); // an old id in a link or bookmark: that record, under its id now
  app.route = route;
  if (el.q.value.trim() !== app.state.q && document.activeElement !== el.q) el.q.value = app.state.q;

  // view switching
  const view = viewOf(route);
  el.main.dataset.view = view;
  for (const [name, v] of Object.entries(el.views)) v.section.classList.toggle('hidden', name !== view);
  el.main.dataset.detail = route.name === 'detail' ? 'open' : 'closed';
  syncNav();
  // another page (Back, a link elsewhere): the drawer closes. A filter change or a saved search keeps it open.
  if (activeNav(prevRoute, prevMode) !== activeNav(route, app.listMode) || viewOf(prevRoute) !== view) closeDrawer();
  // entering a view: its title takes the focus (after closeDrawer, which would move it back to the menu button);
  // the SQL console focuses its query box itself
  if (view !== viewOf(prevRoute) && VIEW_FOCUS.has(view)) $('#' + view + 'Title').focus({ preventScroll: true });

  if (view !== 'list') {
    document.title = viewTitle(view);
    const body = el.views[view].body;
    if (view === 'sql') {
      await app.metaReady;
      const { showSqlConsole } = await import('./ui/sql-console.js');
      showSqlConsole(body, { url: data.sqliteURL(app.version), version: app.version || 'none' });
    } else if (view === 'about') renderAboutView();
    else if (view === 'settings') renderSettingsView();
    else if (view === 'notify') renderNotifyView(new URLSearchParams(query).get('report') === 'last');
    return;
  }

  // list (+ detail)
  const listChanged = !app.rendered || stateChanged || prevMode !== app.listMode || viewOf(prevRoute) !== 'list';
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
  import('./ui/about.js').then(({ renderAbout }) => renderAbout(el.views.about.body, {
    meta: app.meta,
    appVersion: APP_VERSION,
    catalogCount: app.catalog.length
  }));
}

/** Watchlist, saved searches, profiles, preferences and the notification settings (with the periodic sync) go. */
async function clearLocalData() {
  if (!confirm('Clear your watchlist, saved searches, keyword profiles, preferences and notification settings (channels, webhooks and keys) on this device?')) return;
  for (const k of ['watchlist', 'searches', 'profiles', 'prefs', 'lastVisit']) store.remove(k);
  try { await (await loadNotify()).reset(); } catch (err) { console.warn('[sg] notification settings not cleared', err); }
  location.reload();
}

/** How the app can be installed here: the desktop app, already installed, the browser offers it, or neither. */
function installState() {
  if (DESKTOP) return 'desktop';
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) return 'installed';
  return app.installPrompt ? 'available' : 'unavailable';
}

/**
 * One line about the notifications, when their code is already loaded (it loads after the first paint); null
 * otherwise: Settings never loads it just for this line.
 */
function notifySummary() {
  if (!notifyP) return null;
  return notifyP.then(n => n.load()).then(({ settings: s }) => {
    const n = s.channels.filter(c => c.enabled).length;
    if (!s.enabled) return 'Off';
    return n ? `On · ${n} ${n === 1 ? 'channel' : 'channels'}` : 'On, but no channel is set up yet';
  }).catch(() => null);
}

function renderSettingsView() {
  if (app.route.name !== 'settings') return;
  import('./ui/settings.js').then(({ renderSettings }) => renderSettings(el.views.settings.body, {
    meta: app.meta,
    offline: app.offline,
    appVersion: APP_VERSION,
    catalogCount: app.catalog.length,
    theme: themeChoice(store.prefs()),
    install: installState(),
    onInstall: promptInstall,
    notify: notifySummary(),
    sqliteUrl: data.sqliteURL(app.version),
    onClearLocal: clearLocalData
  })).catch(err => {
    el.views.settings.body.replaceChildren(h('div', { class: 'about' }, h('p', { text: 'Settings could not load: ' + err.message })));
  });
}

function renderNotifyView(reportLast) {
  import('./ui/notify-view.js').then(({ showNotifyView }) => showNotifyView(el.views.notify.body, {
    catalog: app.catalog,
    descriptions: app.descriptions,
    profiles: app.profiles,
    watchCount: app.loaded ? app.catalog.reduce((k, r) => k + (store.isWatched(r.id) ? 1 : 0), 0) : store.watchlist().size,
    reportLast,
    toast
  })).catch(err => {
    el.views.notify.body.replaceChildren(h('div', { class: 'about' }, h('p', { text: 'The notifications view could not load: ' + err.message })));
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
}

/**
 * After the first paint: the notification code. It mirrors the watchlist and profiles to where the background
 * report reads them, runs the due check (web; the desktop app sends on its own), keeps the Periodic Background Sync in
 * line with the settings, and opens a view the desktop app asks for (a click on the report notification).
 */
function startNotifications() {
  loadNotify().then(n => {
    n.startMirroring();
    n.onDesktopNavigate(hash => { if (/^#\/[a-z]/.test(hash)) location.hash = hash; });
    n.check();
    n.load().then(r => n.syncPeriodic(r.settings)).catch(() => {});
  }).catch(err => console.warn('[sg] notifications not loaded', err));
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

/** The theme picked here: 'light', 'dark' or 'system' (as applied to the page; saved in prefs.theme). */
const currentTheme = () => themeChoice({ theme: document.documentElement.dataset.theme });

function syncThemeUi() {
  const choice = currentTheme();
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-pressed', String(b.dataset.themePick === choice));
  $('meta[name="theme-color"]').setAttribute('content', effectiveTheme() === 'dark' ? '#0b1118' : '#ffffff');
  // Desktop app: the window buttons drawn over the top bar take the bar's colors.
  if (DESKTOP && DESKTOP.setTitleBarColors) {
    const css = getComputedStyle(document.documentElement);
    DESKTOP.setTitleBarColors({ color: css.getPropertyValue('--bg-2').trim(), symbolColor: css.getPropertyValue('--text').trim() });
  }
}

// ---------- side panel: a docked column (wide) or a modal drawer ----------

const panelOpen = () => document.body.classList.contains('panel-open');
const panelCollapsed = () => document.documentElement.classList.contains('panel-collapsed');
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(x => x.getClientRects().length);

/**
 * The panel's semantics for the width: a modal dialog (role, aria-modal, inert while closed) in the drawer, plain
 * landmarks when docked (inert only while collapsed); the menu button's aria-expanded either way.
 */
function syncPanelMode() {
  const overlay = !WIDE.matches;
  if (overlay) {
    el.panel.setAttribute('role', 'dialog');
    el.panel.setAttribute('aria-modal', 'true');
    el.panel.setAttribute('aria-labelledby', 'sidepanelTitle');
  } else {
    for (const a of ['role', 'aria-modal', 'aria-labelledby']) el.panel.removeAttribute(a);
  }
  el.panel.inert = overlay ? !panelOpen() : panelCollapsed();
  el.menuBtn.setAttribute('aria-expanded', String(overlay ? panelOpen() : !panelCollapsed()));
}

function openDrawer() {
  document.body.classList.add('panel-open');
  el.scrim.classList.remove('hidden');
  syncPanelMode();
  // focus into the drawer: the current page's item (where the user is), else the first one
  (el.panel.querySelector('.sp-item[aria-current="page"]') || focusables(el.panel)[0]).focus();
}

/** Close the drawer; focus goes back to the menu button unless restoreFocus is false (or it was elsewhere). */
function closeDrawer({ restoreFocus = true } = {}) {
  if (!panelOpen()) return;
  const hadFocus = el.panel.contains(document.activeElement) || document.activeElement === document.body;
  document.body.classList.remove('panel-open');
  el.scrim.classList.add('hidden');
  syncPanelMode();
  if (restoreFocus && hadFocus) el.menuBtn.focus();
}

function toggleMenu() {
  if (WIDE.matches) {
    const collapsed = document.documentElement.classList.toggle('panel-collapsed');
    store.setPref('panelCollapsed', collapsed);
    syncPanelMode();
  } else if (panelOpen()) {
    closeDrawer();
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
  syncPanelMode();
  $('#appVersion').textContent = ' · v' + APP_VERSION;

  // search box: debounce typing; Enter applies at once and moves to the results
  let t = null;
  el.q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => setState({ q: el.q.value.trim() }), 140);
  });
  el.q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(t); setState({ q: el.q.value.trim() }); }
    if (e.key === 'ArrowDown') { e.preventDefault(); clearTimeout(t); setState({ q: el.q.value.trim() }); list.focusFirst(); }
    if (e.key === 'Escape' && el.q.value) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(t);
      el.q.value = '';
      // on another view, clearing the box stays there (setState would open the list)
      if (viewOf(app.route) === 'list') setState({ q: '' });
      else { app.state = { ...app.state, q: '' }; syncNav(); }
    }
  });

  // theme: the segmented Light / Dark / System in the panel and in Settings
  document.addEventListener('click', e => {
    const b = e.target.closest?.('[data-theme-pick]');
    if (b) setTheme(b.dataset.themePick === 'system' ? null : b.dataset.themePick);
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncThemeUi);

  // side panel
  el.menuBtn.addEventListener('click', toggleMenu);
  $('#panelClose').addEventListener('click', () => closeDrawer());
  $('#filtersReset').addEventListener('click', () => setState({ ...defaultState(), sort: app.state.sort }));
  el.showResults.addEventListener('click', () => {
    closeDrawer({ restoreFocus: false });
    list.focusFirst();
    if (!el.list.contains(document.activeElement)) el.menuBtn.focus();
  });
  el.scrim.addEventListener('click', () => closeDrawer());
  // choosing a page in the drawer closes it (filters do not: filtering is iterative)
  el.panel.addEventListener('click', e => { if (e.target.closest('a[data-nav]') && !WIDE.matches) closeDrawer(); });
  // the drawer keeps the focus while it is open: Tab cycles inside it, and focus that lands outside comes back
  el.panel.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !panelOpen()) return;
    const items = focusables(el.panel);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !el.panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('focusin', e => {
    if (!panelOpen() || el.panel.contains(e.target) || e.target.closest?.('dialog, .toasts')) return;
    (focusables(el.panel)[0] || el.menuBtn).focus();
  });
  WIDE.addEventListener('change', () => {
    const inPanel = el.panel.contains(document.activeElement);
    closeDrawer({ restoreFocus: false });
    syncPanelMode();
    if (inPanel && el.panel.inert) el.menuBtn.focus(); // docked -> drawer: the panel is closed now
  });

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
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (panelOpen()) closeDrawer({ restoreFocus: false }); // the search box is behind the drawer
      el.q.focus();
      el.q.select();
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (document.querySelector('dialog[open]')) return; // the dialog closes itself
      if (panelOpen()) { closeDrawer(); return; }
      if (app.route.name === 'detail') {
        const id = app.route.id;
        location.hash = backHref();
        setTimeout(() => list.focusCard(id), 0);
      } else if (isSecondary(app.route) && !typing && !e.target.closest?.('[role="menu"], [role="dialog"]')) {
        // the watchlist and the other views: Esc goes home, filters as they were
        location.hash = homeHref(app.state);
      }
    }
  });

  // last visit: stored when the app is hidden or closed, never on load
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.markVisit();
    else { recheckMeta(); if (notifyP) notifyP.then(n => n.check()).catch(() => {}); }
  });
  window.addEventListener('pagehide', () => store.markVisit());

  window.addEventListener('online', () => { app.offline = false; renderFreshness(el.freshness, app.meta, false); toast('Back online'); recheckMeta(); });
  window.addEventListener('offline', () => { app.offline = true; renderFreshness(el.freshness, app.meta, true); toast('Offline: showing the last data loaded'); });
  window.addEventListener('hashchange', () => { onHashChange(); });
}

// ---------- PWA ----------

/** Show the browser's install prompt (the header's Install button, Settings). */
async function promptInstall() {
  const p = app.installPrompt;
  if (!p) return;
  p.prompt();
  await p.userChoice.catch(() => null);
  app.installPrompt = null;
  el.installBtn.classList.add('hidden');
  renderSettingsView();
}

function setupPwa() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    app.installPrompt = e;
    el.installBtn.classList.remove('hidden');
    renderSettingsView();
  });
  el.installBtn.addEventListener('click', promptInstall);
  window.addEventListener('appinstalled', () => { app.installPrompt = null; el.installBtn.classList.add('hidden'); toast('Installed'); renderSettingsView(); });

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
el.q.value = parseQuery(splitHash(location.hash).query).q;
loadAll().catch(() => {}).finally(startNotifications);
