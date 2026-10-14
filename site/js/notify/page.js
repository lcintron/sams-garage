/*
 * The page's side of the notifications: where the settings live and who sends.
 *   - Web: settings, run state and the last report in IndexedDB (js/notify/idb.js), where the service worker reads
 *     them too; the page mirrors the watchlist and the user's profiles there. Reports go out from the service worker
 *     (Periodic Background Sync) and from the page itself on load and when it becomes visible (js/notify/runner.js;
 *     a lock in IndexedDB keeps the two from sending twice).
 *   - Desktop app: everything goes through the preload bridge (window.sgDesktop.notify); the main process stores the
 *     settings (secrets encrypted) and sends on its own schedule (electron/notify.js). No service worker there.
 * Secrets stay on this device: they are never put in the app's URLs or logged.
 */
import './core.js';
import './idb.js';
import './runner.js';
import * as store from '../store.js';

const N = globalThis.SgNotify;
const kv = globalThis.SgIdb;
const R = globalThis.SgNotifyRunner;
const DESKTOP = globalThis.sgDesktop && globalThis.sgDesktop.notify ? globalThis.sgDesktop : null;
export const TAG = 'sg-daily-report';
const PERIODIC_MS = 12 * 3600 * 1000;
const PREVIEW_DAYS = 7;

export const isDesktop = () => !!DESKTOP;
const appBase = () => new URL('./', location.href.split('#')[0]).href;
const swRegistration = async () => {
  if (DESKTOP || !('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.getRegistration(); } catch { return null; }
};

/** {settings, state, lastReport, encryption?} */
export async function load() {
  if (DESKTOP) {
    const r = await DESKTOP.notify.getSettings();
    return { settings: N.normalizeSettings(r && r.settings), state: N.cloneState(r && r.state), lastReport: (r && r.state && r.state.lastReport) || null, encryption: r ? r.encryption : null };
  }
  const [settings, state, lastReport] = await Promise.all([kv.get(R.KEYS.settings), kv.get(R.KEYS.state), kv.get(R.KEYS.lastReport)]);
  return { settings: N.normalizeSettings(settings), state: N.cloneState(state), lastReport: lastReport || null };
}

/** Store the settings (normalized) and bring the background schedule in line with them. */
export async function save(settings) {
  const s = N.normalizeSettings(settings);
  if (DESKTOP) await DESKTOP.notify.saveSettings(s);
  else await kv.set(R.KEYS.settings, s);
  syncPeriodic(s).catch(() => {});
  return s;
}

/** Copy the watchlist and the user's profiles to where the background sender reads them. */
export function mirror() {
  const watch = [...store.watchlist()].sort();
  const profiles = store.userProfiles();
  if (DESKTOP) {
    DESKTOP.setWatchlist && DESKTOP.setWatchlist(watch);
    DESKTOP.setProfiles && DESKTOP.setProfiles(profiles);
    return Promise.resolve();
  }
  return Promise.all([kv.set(R.KEYS.watchlist, watch), kv.set(R.KEYS.profiles, profiles)]).catch(() => {});
}

/** Keep the copies current: call once at start. */
export function startMirroring() {
  mirror();
  let t = null;
  store.onChange(key => {
    if (key !== 'watchlist' && key !== 'profiles') return;
    clearTimeout(t);
    t = setTimeout(mirror, 50);
  });
}

/** The page's own way to show the report notification (permission granted), or undefined. */
function pageNotifier() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return undefined;
  return async (title, options) => {
    const reg = await swRegistration();
    if (reg && reg.showNotification) return reg.showNotification(title, options);
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); location.hash = '#/notify?report=last'; n.close(); };
    return null;
  };
}

const env = mode => ({ kv, base: appBase(), owner: 'page', mode, fetch: (u, i) => fetch(u, i), notify: pageNotifier() });

let lastCheck = 0;
/** The page's due check (web only; at most every 5 minutes): on load and when the app becomes visible. */
export async function check({ force = false } = {}) {
  if (DESKTOP || !globalThis.indexedDB) return null;
  if (!force && Date.now() - lastCheck < 5 * 60000) return null;
  lastCheck = Date.now();
  try { return await R.run(env('scheduled')); } catch (e) { console.warn('[sg] notification check failed', e); return null; }
}

/** "Send today's report now": channels not yet sent today, whatever the time. */
export async function sendNow() {
  if (DESKTOP) return DESKTOP.notify.sendNow();
  return R.run(env('now'));
}

/** "Send test": the sample report to one channel (not saved, no state change). */
export async function sendTest(channel) {
  if (DESKTOP) return DESKTOP.notify.sendTest(channel);
  return R.sendTest({ kv, base: appBase(), fetch: (u, i) => fetch(u, i) }, channel);
}

/**
 * The report the current settings would give for the last 7 days, from the catalog the app has loaded
 * (descriptions: Map id -> text from the search index, when loaded). null when there is nothing to report.
 */
export async function preview(settings, { catalog, descriptions }) {
  const res = await fetch('data/changes.json');
  if (!res.ok) throw new Error('data/changes.json: HTTP ' + res.status);
  const changes = await res.json();
  const records = descriptions ? catalog.map(r => (descriptions.has(r.id) ? { ...r, description: descriptions.get(r.id) } : r)) : catalog;
  return N.buildDigest({
    records, events: changes.events || [], since: Date.now() - PREVIEW_DAYS * 86400000, until: null, settings,
    watchlist: [...store.watchlist()], profiles: N.allProfiles(store.userProfiles())
  });
}

/** What runs where, for the status panel. */
export async function status() {
  if (DESKTOP) {
    const s = await DESKTOP.notify.status().catch(() => null);
    return { runtime: 'desktop', desktop: s };
  }
  const out = { runtime: 'browser', notifications: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission, periodicSync: 'unsupported', registered: false, worker: false };
  const reg = await swRegistration();
  out.worker = !!(reg && reg.active);
  if (reg && 'periodicSync' in reg) {
    try {
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      out.periodicSync = perm.state; // granted | denied | prompt
    } catch { out.periodicSync = 'unknown'; }
    try { out.registered = (await reg.periodicSync.getTags()).includes(TAG); } catch { /* ignore */ }
  }
  return out;
}

/** Register (or drop) the Periodic Background Sync that wakes the service worker about twice a day. */
export async function syncPeriodic(settings) {
  const reg = await swRegistration();
  if (!reg || !('periodicSync' in reg)) return false;
  const want = settings.enabled && settings.background.browser && settings.channels.some(c => c.enabled && N.browserMode(c) !== 'unsupported');
  try {
    if (want) await reg.periodicSync.register(TAG, { minInterval: PERIODIC_MS });
    else await reg.periodicSync.unregister(TAG);
    return want;
  } catch { return false; } // no permission (not installed, or not engaged enough yet)
}

export async function requestNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** The JSON for the SG_NOTIFY_CONFIG repository secret: settings, watchlist and custom profiles, secrets included. */
export async function exportConfig() {
  const { settings } = await load();
  return JSON.stringify({ version: 1, settings, watchlist: [...store.watchlist()].sort(), profiles: store.userProfiles() });
}

/** The desktop app asks the page to open a view (a click on the report notification). */
export function onDesktopNavigate(fn) {
  if (DESKTOP && DESKTOP.onNavigate) DESKTOP.onNavigate(fn);
}
