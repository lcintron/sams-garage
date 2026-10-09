/*
 * Filter state <-> URL query string. Pure: no DOM, no globals, safe to import from node --test.
 *
 * The query lives inside the hash route so every view is shareable: "#/?q=uas&agency=DOD", "#/s/<id>?q=uas".
 * Only values that differ from the defaults are written, so the default view has a clean "#/".
 */

export const STATUSES = ['open', 'pre_release', 'forecasted', 'closed'];
export const STATUS_LABELS = { open: 'Open', pre_release: 'Pre-release', forecasted: 'Forecasted', closed: 'Closed', unknown: 'Unknown' };
export const PROGRAMS = ['SBIR', 'STTR'];
export const PHASES = ['I', 'II', 'DP2'];
export const CLOSING_WITHIN = [7, 14, 30, 60];
export const SORTS = {
  auto: 'Best match',          // relevance when there is a text query or profile, else close date
  close: 'Close date ↑',
  added: 'Recently added',
  changed: 'Recently changed',
  relevance: 'Relevance',
  title: 'Title A–Z'
};

/** A fresh default filter state. Status defaults to Open + Pre-release (PLAN.md §6). */
export function defaultState() {
  return {
    q: '',
    status: ['open', 'pre_release'],
    agency: [],
    sub: [],
    program: [],
    phase: [],
    closing: null,      // number of days, or null
    opens: '',          // YYYY-MM-DD "opens after", or ''
    profile: [],        // profile ids
    newOnly: false,
    sort: 'auto'
  };
}

// Status uses facet semantics: nothing selected means "any status". In the URL that is written as "status=any" so it
// can be told apart from the (absent) default.
const ANY = 'any';

const LIST_KEYS = ['status', 'agency', 'sub', 'program', 'phase', 'profile'];

const encList = arr => arr.map(v => encodeURIComponent(v)).join(',');
const decList = s => (s ? s.split(',').map(v => safeDecode(v)).filter(Boolean) : []);

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

const sameSet = (a, b) => a.length === b.length && a.every(v => b.includes(v));

/**
 * Parse a query string ("q=uas&status=open,closed", with or without a leading "?") into a full filter state.
 * Unknown keys and invalid values are ignored; anything missing takes its default.
 */
export function parseQuery(query) {
  const state = defaultState();
  const qs = String(query || '').replace(/^[?#]/, '');
  if (!qs) return state;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const raw = eq < 0 ? '' : part.slice(eq + 1);
    switch (key) {
      case 'q': state.q = safeDecode(raw); break;
      case 'status': state.status = raw === ANY ? [] : decList(raw).filter(s => STATUSES.includes(s)); break;
      case 'agency': case 'sub': state[key] = decList(raw).map(s => s.toUpperCase()); break;
      case 'program': state.program = decList(raw).map(s => s.toUpperCase()).filter(p => PROGRAMS.includes(p)); break;
      case 'phase': state.phase = decList(raw).map(s => s.toUpperCase()).filter(p => PHASES.includes(p)); break;
      case 'profile': state.profile = decList(raw); break;
      case 'closing': { const n = parseInt(raw, 10); state.closing = n > 0 && n <= 3650 ? n : null; break; }
      case 'opens': state.opens = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''; break;
      case 'new': state.newOnly = raw === '1' || raw === 'true'; break;
      case 'sort': state.sort = Object.hasOwn(SORTS, raw) ? raw : 'auto'; break;
      default: break;
    }
  }
  for (const k of LIST_KEYS) state[k] = [...new Set(state[k])];
  return state;
}

/** Serialize a filter state to a query string without the leading "?"; defaults are omitted. Stable key order. */
export function toQuery(state) {
  const d = defaultState();
  const s = { ...d, ...state };
  const out = [];
  if (s.q && s.q.trim()) out.push('q=' + encodeURIComponent(s.q.trim()));
  if (!sameSet(s.status, d.status)) out.push('status=' + (s.status.length ? encList(s.status) : ANY));
  for (const k of ['agency', 'sub', 'program', 'phase', 'profile']) if (s[k].length) out.push(k + '=' + encList(s[k]));
  if (s.closing) out.push('closing=' + s.closing);
  if (s.opens) out.push('opens=' + s.opens);
  if (s.newOnly) out.push('new=1');
  if (s.sort && s.sort !== 'auto') out.push('sort=' + s.sort);
  return out.join('&');
}

/** True when the state differs from the defaults in anything other than sort. */
export function isFiltered(state) {
  const { sort, ...rest } = parseQuery(toQuery(state));
  const { sort: _s, ...def } = defaultState();
  return JSON.stringify(rest) !== JSON.stringify(def);
}

/** Split a location hash ("#/s/abc?q=x") into { path: "/s/abc", query: "q=x" }. */
export function splitHash(hash) {
  const h = String(hash || '').replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  return { path: (i < 0 ? h : h.slice(0, i)) || '/', query: i < 0 ? '' : h.slice(i + 1) };
}

/** Build a hash from a route path and a filter state. */
export function buildHash(path, state) {
  const q = state ? toQuery(state) : '';
  return '#' + (path || '/') + (q ? '?' + q : '');
}
