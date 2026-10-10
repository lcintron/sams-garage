/*
 * Record ids that changed. A record keeps its id once published (scraper/merge.py), but ids it absorbed through
 * dedupe (alt_ids) may still be in old links and watchlists, as may ids from before that rule. They resolve to the
 * record that holds them now. Pure functions, no DOM.
 */

/** Map alt id -> canonical id for every alt_id in the catalog that is not itself a record's id. */
export function aliasMap(catalog) {
  const ids = new Set(catalog.map(r => r.id));
  const out = new Map();
  for (const r of catalog) for (const alt of r.alt_ids || []) if (!ids.has(alt) && !out.has(alt)) out.set(alt, r.id);
  return out;
}

/** The id of the record an id names now: itself, the record that absorbed it, or null when unknown. */
export function resolveId(id, byId, aliasOf) {
  if (byId.has(id)) return id;
  return aliasOf.get(id) ?? null;
}

/**
 * Watchlist ids with aliases replaced by their records' ids (sorted, deduped). Unknown ids are kept: the topic
 * may come back, or the catalog may be partial. Returns { ids, changed }.
 */
export function migrateWatchlist(ids, byId, aliasOf) {
  const out = new Set();
  let changed = false;
  for (const id of ids) {
    const now = byId.has(id) ? id : aliasOf.get(id) ?? id;
    if (now !== id) changed = true;
    out.add(now);
  }
  const list = [...out].sort();
  return { ids: list, changed: changed || list.length !== [...ids].length };
}
