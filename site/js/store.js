/*
 * Persistent per-device state in localStorage: watchlist, saved searches, last visit, user profiles, preferences.
 * Every access is wrapped: storage may be missing or throw (private mode, blocked site data), and the app must keep
 * working with in-memory state. No DOM access; the backing storage can be swapped for tests with useStorage().
 */

const PREFIX = 'sbir.';
const memory = new Map();
const memoryStorage = {
  getItem: k => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: k => { memory.delete(k); }
};

let backend = null;
function storage() {
  if (backend) return backend;
  try {
    const ls = globalThis.localStorage;
    const probe = PREFIX + 'probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    backend = ls;
  } catch {
    backend = memoryStorage;
  }
  return backend;
}

/** Replace the backing storage (tests). Pass null to re-detect. */
export function useStorage(s) { backend = s; }

export function get(key, fallback = null) {
  try {
    const raw = storage().getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try { storage().setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
}

export function remove(key) {
  try { storage().removeItem(PREFIX + key); } catch { /* ignore */ }
}

// ---------- watchlist ----------
export function watchlist() { const w = get('watchlist', []); return new Set(Array.isArray(w) ? w : []); }
export function isWatched(id) { return watchlist().has(id); }
/** Toggle an id; returns the new watched state. */
export function toggleWatch(id) {
  const w = watchlist();
  const on = !w.has(id);
  if (on) w.add(id); else w.delete(id);
  set('watchlist', [...w].sort());
  return on;
}

// ---------- saved searches ----------
export function savedSearches() { const s = get('searches', []); return Array.isArray(s) ? s : []; }
export function saveSearch(name, query) {
  const list = savedSearches().filter(s => s.name !== name);
  list.push({ name: String(name).slice(0, 60), query: String(query || '') });
  set('searches', list);
  return list;
}
export function deleteSearch(name) {
  const list = savedSearches().filter(s => s.name !== name);
  set('searches', list);
  return list;
}

// ---------- last visit ----------
/** The last-visit time stored when the app was last hidden/closed (epoch ms) or null. */
export function lastVisit() { const v = get('lastVisit', null); return typeof v === 'number' ? v : null; }
export function markVisit(now = Date.now()) { set('lastVisit', now); }

// ---------- user profiles ----------
export function userProfiles() { const p = get('profiles', []); return Array.isArray(p) ? p : []; }
export function setUserProfiles(list) { set('profiles', list); }

// ---------- preferences ----------
export function prefs() { const p = get('prefs', {}); return p && typeof p === 'object' ? p : {}; }
export function setPref(key, value) { const p = prefs(); p[key] = value; set('prefs', p); }

// ---------- data version the cached catalog corresponds to ----------
export function dataVersion() { return get('dataVersion', null); }
export function setDataVersion(v) { set('dataVersion', v); }
