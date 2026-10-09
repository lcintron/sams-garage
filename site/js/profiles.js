/*
 * Keyword profiles: named lists of terms that flag and rank topics of interest.
 *
 * The three presets and the scoring are ported from the retired analyze_sbir_hashtags.py (HASHTAG_TERMS,
 * GENERIC_CONTEXT_TERMS, rank_topics):
 *   score = 2 × (number of a profile's terms found) + the profile's bonus (Counter-UAS 6, UAS 3, Acoustic 3)
 *         + min(number of generic context terms found, 3)   — context only counts when some profile matched.
 * One difference: terms match as whole words/phrases (case-insensitive, "-" and " " interchangeable) instead of raw
 * substrings, so "uas" no longer matches "persuasive" and "audio" no longer matches "audiology".
 *
 * Pure: no DOM, no storage. User profiles are persisted by store.js and passed in.
 */

export const PRESET_PROFILES = Object.freeze([
  {
    id: 'uas', name: 'UAS', bonus: 3, preset: true,
    terms: ['uas', 'uav', 'unmanned aerial', 'uncrewed aerial', 'drone', 'drones', 'aerial system', 'autonomous air']
  },
  {
    id: 'cuas', name: 'Counter-UAS', bonus: 6, preset: true,
    terms: ['c-uas', 'cuas', 'counter-uas', 'counter uas', 'counter-unmanned', 'counter unmanned', 'counter-drone',
      'counter drone', 'drone detection', 'detect drones']
  },
  {
    id: 'acoustic', name: 'Acoustic', bonus: 3, preset: true,
    terms: ['acoustic', 'acoustics', 'audio', 'sound', 'sounds', 'sonar', 'microphone', 'passive sensing']
  }
]);

export const GENERIC_CONTEXT_TERMS = Object.freeze(['aircraft', 'sensor', 'sensors', 'tracking', 'detection', 'surveillance']);
export const MAX_CONTEXT_POINTS = 3;
export const POINTS_PER_TERM = 2;

/** Lowercase and fold hyphens/underscores/whitespace runs to single spaces, so "Counter-UAS" ≈ "counter uas". */
export function normalizeText(s) {
  return ' ' + String(s || '').toLowerCase().replace(/[‐-―−]/g, '-').replace(/[-_\s]+/g, ' ').trim() + ' ';
}

const termCache = new Map();
/** A regex that finds a term as a whole word or phrase inside normalizeText() output. */
function termRegex(term) {
  let re = termCache.get(term);
  if (!re) {
    const t = normalizeText(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp('(?<![a-z0-9])' + t + '(?![a-z0-9])');
    termCache.set(term, re);
  }
  return re;
}

/** Terms from `terms` that occur in the (already normalized) text. */
export function findTerms(normText, terms) {
  return terms.filter(t => t && termRegex(t).test(normText));
}

/**
 * The searchable text of a record for profile matching: title, summary, description, keywords, technology areas,
 * agency, topic and solicitation numbers (the analyzer's topic_text plus keywords and technology areas). `description` may come from the search-index docs
 * when the catalog record has none.
 */
export function recordText(rec, description) {
  const join = v => (Array.isArray(v) ? v.join(' ') : v || '');
  return normalizeText([rec.title, rec.agency, rec.sub_agency, rec.topic_number, rec.solicitation_number, rec.summary,
    description ?? rec.description, join(rec.keywords), join(rec.technology_areas)].filter(Boolean).join(' \n '));
}

/**
 * Score one record against a set of profiles.
 * @param {string} normText output of recordText()
 * @param {Array<{id,name,terms,bonus}>} profiles
 * @returns {null | {score:number, matched: Object<string,string[]>, context: string[]}} null when no profile matched
 */
export function scoreText(normText, profiles) {
  const matched = {};
  let score = 0;
  for (const p of profiles) {
    const found = findTerms(normText, p.terms || []);
    if (found.length) {
      matched[p.id] = found;
      score += found.length * POINTS_PER_TERM + (Number(p.bonus) || 0);
    }
  }
  if (!Object.keys(matched).length) return null;
  const context = findTerms(normText, GENERIC_CONTEXT_TERMS);
  score += Math.min(context.length, MAX_CONTEXT_POINTS);
  return { score, matched, context };
}

/**
 * The score of a match restricted to some profiles (the ones the user turned on): their term points and bonuses,
 * plus the context points if any of them matched. 0 when none of them matched.
 * @param {{matched:Object<string,string[]>, context:string[]}} match from scoreText()
 * @param {string[]} ids active profile ids
 * @param {Map<string,{bonus:number}>} profilesById
 */
export function scoreFor(match, ids, profilesById) {
  if (!match) return 0;
  let score = 0, any = false;
  for (const id of ids) {
    const terms = match.matched[id];
    if (!terms) continue;
    any = true;
    score += terms.length * POINTS_PER_TERM + (Number(profilesById.get(id)?.bonus) || 0);
  }
  return any ? score + Math.min(match.context.length, MAX_CONTEXT_POINTS) : 0;
}

/** Convenience: score a record object directly. */
export function scoreRecord(rec, profiles, description) {
  return scoreText(recordText(rec, description), profiles);
}

/** Rank records like analyze_sbir_hashtags.rank_topics: score desc, then agency, then topic number. */
export function rankRecords(records, profiles, descriptions = new Map()) {
  const out = [];
  for (const rec of records) {
    const m = scoreRecord(rec, profiles, descriptions.get(rec.id));
    if (m) out.push({ rec, ...m });
  }
  return out.sort((a, b) => b.score - a.score || cmp(a.rec.agency, b.rec.agency) || cmp(a.rec.topic_number, b.rec.topic_number));
}
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));

/** Parse a user's free-form term list (commas or new lines) into clean, deduplicated, lowercase terms. */
export function parseTerms(text) {
  const seen = new Set();
  for (const t of String(text || '').split(/[,\n;]+/)) {
    const v = t.trim().toLowerCase().replace(/^#/, '');
    if (v) seen.add(v);
  }
  return [...seen];
}

/** A stable, URL-safe id for a user profile name ("My Sensors!" -> "u-my-sensors"). */
export function profileId(name, taken = []) {
  const base = 'u-' + (String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile');
  let id = base, n = 2;
  while (taken.includes(id) || PRESET_PROFILES.some(p => p.id === id)) id = `${base}-${n++}`;
  return id;
}

/** Validate/normalize a user profile; returns null if unusable. */
export function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim().slice(0, 40);
  const terms = Array.isArray(p.terms) ? parseTerms(p.terms.join(',')) : parseTerms(p.terms);
  if (!name || !terms.length || !/^u-[a-z0-9-]+$/.test(p.id || '')) return null;
  const bonus = Math.max(0, Math.min(10, parseInt(p.bonus, 10) || 0));
  return { id: p.id, name, terms: terms.slice(0, 100), bonus, preset: false };
}

/** Presets followed by the user's valid profiles. */
export function allProfiles(userProfiles = []) {
  return [...PRESET_PROFILES, ...userProfiles.map(normalizeProfile).filter(Boolean)];
}
