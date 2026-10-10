/*
 * Loading the generated site data (PLAN.md §5). No DOM access; uses fetch and, for cleanup, the Cache API.
 *
 * Caching is the service worker's job (sw.js): meta.json network-first; catalog/search-index/agencies
 * stale-while-revalidate; records and the sqlite file cache-first. Records and the sqlite file are requested with
 * "?v=<data_version>" so a new data version is a cache miss, and purgeStaleData() removes older versions.
 */

export const DATA_CACHE = 'sg-data'; // must match sw.js
const BASE = 'data/';

export class DataError extends Error {
  constructor(message, status) { super(message); this.name = 'DataError'; this.status = status; }
}

async function getJSON(path, init) {
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch (err) {
    throw new DataError(`Could not reach ${path} (offline?)`, 0);
  }
  if (!res.ok) throw new DataError(`${path}: HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new DataError(`${path} is not valid JSON`, res.status);
  }
}

/** File name for a record: ":" -> "__" (PLAN.md §5). */
export function idSafe(id) { return String(id).replace(/:/g, '__'); }

/** Meta: always try the network first (the SW falls back to its cached copy). */
export function loadMeta() { return getJSON('meta.json', { cache: 'no-cache' }); }

/** Catalog, index docs, agencies. `fresh` bypasses the SW's stale copy (used after a data_version change). */
export function loadCatalog(fresh = false) { return getJSON('catalog.json', fresh ? { cache: 'no-store' } : undefined); }
export function loadSearchDocs(fresh = false) { return getJSON('search-index.json', fresh ? { cache: 'no-store' } : undefined); }
export function loadAgencies(fresh = false) { return getJSON('agencies.json', fresh ? { cache: 'no-store' } : undefined).catch(() => null); }

const recordCache = new Map();
/** Full record (with description). Memoized per data version. */
export function loadRecord(id, version) {
  const key = version + '|' + id;
  if (!recordCache.has(key)) {
    const p = getJSON(`records/${encodeURIComponent(idSafe(id))}.json${version ? '?v=' + encodeURIComponent(version) : ''}`);
    p.catch(() => recordCache.delete(key));
    recordCache.set(key, p);
  }
  return recordCache.get(key);
}

/** URL of the SQLite database for the given data version. */
export function sqliteURL(version) { return BASE + 'solicitations.sqlite' + (version ? '?v=' + encodeURIComponent(version) : ''); }

/** Remove cached records/sqlite of other data versions. Best effort. */
export async function purgeStaleData(version) {
  if (!globalThis.caches || !version) return;
  try {
    const cache = await caches.open(DATA_CACHE);
    const keys = await cache.keys();
    await Promise.all(keys.filter(req => {
      const u = new URL(req.url);
      return /\/data\/(records\/|solicitations\.sqlite)/.test(u.pathname) && u.searchParams.get('v') !== version;
    }).map(req => cache.delete(req)));
  } catch { /* ignore */ }
}

/** Version string from meta, tolerant of naming. */
export function metaVersion(meta) {
  return meta ? String(meta.data_version ?? meta.version ?? meta.built_at ?? meta.last_run ?? '') : '';
}
/** Time the data was last refreshed (ms) from meta, tolerant of naming. */
export function metaUpdated(meta) {
  const v = meta && (meta.last_run || meta.built_at || meta.build_time || meta.generated_at);
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Agency display info: merge agencies.json (array, {agencies:[...]}, or {CODE:{...}}) with built-in names.
 * Returns Map code -> { name, subs: Map code -> name }.
 */
export const AGENCY_NAMES = {
  DOD: 'Defense', HHS: 'Health & Human Services', NSF: 'National Science Foundation', DOE: 'Energy', NASA: 'NASA',
  USDA: 'Agriculture', DHS: 'Homeland Security', DOT: 'Transportation', EPA: 'Environmental Protection', ED: 'Education',
  DOC: 'Commerce', OTHER: 'Other'
};
export function agencyInfo(agenciesJson) {
  const out = new Map();
  for (const [code, name] of Object.entries(AGENCY_NAMES)) out.set(code, { name, subs: new Map() });
  let list = [];
  if (Array.isArray(agenciesJson)) list = agenciesJson;
  else if (agenciesJson && Array.isArray(agenciesJson.agencies)) list = agenciesJson.agencies;
  else if (agenciesJson && typeof agenciesJson === 'object') list = Object.entries(agenciesJson).map(([code, v]) => ({ code, ...(v || {}) }));
  for (const a of list) {
    if (!a || !a.code) continue;
    const entry = out.get(a.code) || { name: a.code, subs: new Map() };
    if (a.name && !AGENCY_NAMES[a.code]) entry.name = a.name;
    const subs = Array.isArray(a.sub_agencies) ? a.sub_agencies
      : a.sub_agencies && typeof a.sub_agencies === 'object' ? Object.entries(a.sub_agencies).map(([code, v]) => ({ code, ...(typeof v === 'object' ? v : {}) }))
      : [];
    for (const s of subs) if (s && s.code) entry.subs.set(s.code, s.name || s.code);
    out.set(a.code, entry);
  }
  return out;
}
