/*
 * Search and filter pipeline. Pure: the MiniSearch class is passed in (the app loads it lazily), records are plain
 * catalog objects, and "today" is a parameter, so all of it runs under node --test.
 *
 *   results = runPipeline(catalog, filterState, ctx)  ->  [{ rec, score, textScore, profile, isNew, days }]
 */
import { recordText, scoreText, scoreFor } from './profiles.js';

/** MiniSearch configuration (PLAN.md §6): prefix + fuzzy 0.2, boosts title 3 / keywords 2 / topic_number 3. */
export const INDEX_FIELDS = ['title', 'summary', 'description', 'keywords', 'technology_areas', 'topic_number', 'solicitation_number', 'agency', 'sub_agency'];
export const SEARCH_OPTIONS = { prefix: true, fuzzy: 0.2, boost: { title: 3, keywords: 2, topic_number: 3 }, combineWith: 'AND' };

/**
 * Build a MiniSearch index from the compact docs in data/search-index.json
 * ([{id,title,summary,keywords,technology_areas,topic_number,solicitation_number,agency,sub_agency,description}]).
 * keywords and technology_areas are space-joined strings (arrays are accepted too); a missing field indexes as empty.
 */
export function buildIndex(MiniSearch, docs) {
  const index = new MiniSearch({
    fields: INDEX_FIELDS,
    storeFields: [],
    idField: 'id',
    // keywords/technology_areas may arrive as arrays or space-joined strings, or be absent
    extractField: (doc, field) => {
      const v = doc[field];
      return Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v);
    },
    searchOptions: SEARCH_OPTIONS
  });
  // Duplicate ids would throw inside MiniSearch; keep the first.
  const seen = new Set();
  index.addAll(docs.filter(d => d && d.id && !seen.has(d.id) && seen.add(d.id)));
  return index;
}

/**
 * Run a text query. Returns Map id -> score (higher is better), or null when the query is empty.
 * Falls back to OR when an AND query finds nothing, so a typo in one word does not empty the list.
 */
export function textSearch(index, q) {
  const query = String(q || '').trim();
  if (!query || !index) return null;
  let hits = index.search(query);
  if (!hits.length && /\s/.test(query)) hits = index.search(query, { combineWith: 'OR' });
  return new Map(hits.map(h => [h.id, h.score]));
}

/**
 * Text matching before the index is ready: every word must occur in title, topic/solicitation number, agency,
 * summary, keywords or technology areas. Returns Map id -> crude score.
 */
export function fallbackSearch(records, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const out = new Map();
  for (const r of records) {
    const title = (r.title || '').toLowerCase();
    const hay = [title, r.topic_number, r.solicitation_number, r.agency, r.sub_agency, r.summary,
      (r.keywords || []).join(' '), (r.technology_areas || []).join(' ')].join(' ').toLowerCase();
    if (words.every(w => hay.includes(w))) out.set(r.id, words.reduce((s, w) => s + (title.includes(w) ? 3 : 1), 0));
  }
  return out;
}

// ---------- dates ----------

const DAY = 86400000;

/** Parse "YYYY-MM-DD" or an ISO timestamp into epoch ms (UTC); null if missing/invalid. */
export function parseDate(s) {
  if (!s) return null;
  const str = String(s);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(str) ? Date.parse(str + 'T00:00:00Z') : Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

/** Today's local calendar date as "YYYY-MM-DD". */
export function todayISO(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from `today` (YYYY-MM-DD) to date `d` (YYYY-MM-DD or timestamp); negative if past; null if no date. */
export function daysUntil(d, today) {
  const a = parseDate(today), b = parseDate(String(d || '').slice(0, 10));
  return a == null || b == null ? null : Math.round((b - a) / DAY);
}

// ---------- filtering ----------

/** Does a record's program satisfy the selected programs? "SBIR/STTR" satisfies both. */
function programMatches(rec, programs) {
  if (!programs.length) return true;
  const p = String(rec.program || '').toUpperCase();
  return programs.some(x => p.split('/').includes(x));
}

/**
 * Filter predicate pieces. `skip` names one facet to ignore (used to compute facet counts "excluding self").
 * ctx: { today, textScores: Map|null, profileScores: Map id->match, profilesById: Map, lastVisit: ms|null }
 */
export function matches(rec, s, ctx, skip = '') {
  if (skip !== 'status' && s.status.length && !s.status.includes(rec.status || 'unknown')) return false;
  if (skip !== 'agency' && s.agency.length && !s.agency.includes(rec.agency)) return false;
  if (skip !== 'sub' && s.sub.length && !s.sub.includes(rec.sub_agency)) return false;
  if (skip !== 'program' && !programMatches(rec, s.program)) return false;
  if (skip !== 'phase' && s.phase.length && !(rec.phases || []).some(p => s.phase.includes(p))) return false;
  if (s.closing) {
    const d = daysUntil(rec.close_date, ctx.today);
    if (d == null || d < 0 || d > s.closing) return false;
  }
  if (s.opens) {
    if (!rec.open_date || rec.open_date < s.opens) return false;
  }
  if (skip !== 'new' && s.newOnly && !isNew(rec, ctx.lastVisit)) return false;
  if (ctx.textScores && !ctx.textScores.has(rec.id)) return false;
  if (skip !== 'profile' && s.profile.length) {
    const m = ctx.profileScores && ctx.profileScores.get(rec.id);
    if (!m || !s.profile.some(id => m.matched[id])) return false;
  }
  return true;
}

/** first_seen after the stored last-visit time (epoch ms). Without a last visit nothing is "new". */
export function isNew(rec, lastVisit) {
  if (!lastVisit) return false;
  const t = parseDate(rec.first_seen);
  return t != null && t > lastVisit;
}

/**
 * Profile scores for every record against the active profiles (or all profiles when none is active, so cards can
 * still show matched terms). descriptions: Map id -> description text (from the search-index docs) or undefined.
 * Returns Map id -> {score, matched, context}.
 */
export function computeProfileScores(records, profiles, descriptions) {
  const out = new Map();
  if (!profiles.length) return out;
  for (const r of records) {
    const m = scoreText(recordText(r, descriptions ? descriptions.get(r.id) : undefined), profiles);
    if (m) out.set(r.id, m);
  }
  return out;
}

// ---------- sorting ----------

const byStr = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
const nullsLast = (a, b, dir) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a - b) * dir);

/** Resolve "auto" to a concrete sort key. */
export function effectiveSort(state) {
  if (state.sort && state.sort !== 'auto') return state.sort;
  return state.q && state.q.trim() ? 'relevance' : state.profile.length ? 'relevance' : 'close';
}

export function sortResults(results, sortKey) {
  const closeCmp = (a, b) => nullsLast(parseDate(a.rec.close_date), parseDate(b.rec.close_date), 1) || byStr(a.rec.title, b.rec.title);
  const cmps = {
    close: closeCmp,
    added: (a, b) => nullsLast(parseDate(a.rec.first_seen), parseDate(b.rec.first_seen), -1) || closeCmp(a, b),
    changed: (a, b) => nullsLast(parseDate(a.rec.last_changed), parseDate(b.rec.last_changed), -1) || closeCmp(a, b),
    relevance: (a, b) => b.score - a.score || closeCmp(a, b),
    title: (a, b) => byStr(a.rec.title, b.rec.title) || byStr(a.rec.id, b.rec.id)
  };
  return results.sort(cmps[sortKey] || closeCmp);
}

// ---------- the pipeline ----------

/**
 * Filter + score + sort.
 * Relevance score = normalized text score (0..10) + profile score; with neither, 0.
 */
export function runPipeline(records, state, ctx) {
  const out = [];
  let maxText = 0;
  if (ctx.textScores) for (const v of ctx.textScores.values()) maxText = Math.max(maxText, v);
  for (const rec of records) {
    if (!matches(rec, state, ctx)) continue;
    const textScore = ctx.textScores ? (ctx.textScores.get(rec.id) || 0) : 0;
    const profile = ctx.profileScores ? ctx.profileScores.get(rec.id) || null : null;
    // only the profiles the user turned on count towards relevance (ctx.profilesById supplies their bonuses)
    const profileScore = profile && state.profile.length ? scoreFor(profile, state.profile, ctx.profilesById || new Map()) : 0;
    out.push({
      rec,
      textScore,
      profile,
      profileScore,
      score: (maxText ? (textScore / maxText) * 10 : 0) + profileScore,
      isNew: isNew(rec, ctx.lastVisit),
      days: daysUntil(rec.close_date, ctx.today)
    });
  }
  return sortResults(out, effectiveSort(state));
}

/**
 * Facet counts, each computed with every other filter applied but its own ignored, so a user sees how many results
 * selecting that value would give. Returns { status:{}, agency:{}, sub:{}, program:{}, phase:{}, profile:{}, new:n }.
 */
export function facetCounts(records, state, ctx) {
  const c = { status: {}, agency: {}, sub: {}, program: {}, phase: {}, profile: {}, new: 0 };
  const inc = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  for (const r of records) {
    if (matches(r, state, ctx, 'status')) inc(c.status, r.status || 'unknown');
    if (matches(r, state, ctx, 'agency')) inc(c.agency, r.agency);
    if (matches(r, state, ctx, 'sub')) inc(c.sub, r.sub_agency);
    if (matches(r, state, ctx, 'program')) for (const p of String(r.program || '').toUpperCase().split('/')) inc(c.program, p);
    if (matches(r, state, ctx, 'phase')) for (const p of r.phases || []) inc(c.phase, p);
    if (matches(r, state, ctx, 'profile')) {
      const m = ctx.profileScores && ctx.profileScores.get(r.id);
      if (m) for (const id of Object.keys(m.matched)) inc(c.profile, id);
    }
    if (matches(r, state, ctx, 'new') && isNew(r, ctx.lastVisit)) c.new++;
  }
  return c;
}
