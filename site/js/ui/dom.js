/*
 * Tiny DOM helpers shared by the ui/* modules. Elements are built with h() and text is always set via textContent
 * (never innerHTML with data), so scraped strings cannot inject markup.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * h('a', { class: 'x', href: '#', onclick: fn, 'aria-label': 'y', dataset: { id: 1 } }, 'text', childNode, [more])
 * Falsy children are skipped; strings become text nodes. Boolean attributes: true sets "", false/null omits.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === '') continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Build inline SVG from a trusted, constant path string (icons only). */
export function svg(paths, size = 18, viewBox = '0 0 24 24') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths; // constant icon markup from this codebase, never data
  return s;
}

export const ICONS = {
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
};

/** "2026-10-15" -> "Oct 15, 2026" (UTC so dates never shift by a day). */
export function fmtDate(iso) {
  if (!iso) return '—';
  const s = String(iso);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Days -> "today", "tomorrow", "in 5 days", "3 days ago". */
export function relDays(d) {
  if (d == null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** Forecasted and pre-release dates are the agency's estimates (Grants.gov keeps stale forecasts with past dates). */
export const isEstimated = rec => rec.status === 'forecasted' || rec.status === 'pre_release';

/**
 * Wording for a record's open or close date on cards and in the detail.
 * @param {'open'|'close'} kind
 * @param {number|null} days whole days from today to that date (search.daysUntil)
 * @returns {null | { text: string, cls: ''|'soon'|'past'|'est-passed' }}
 *   Estimated (forecasted / pre-release): "Est. close Nov 20, 2025 (date passed)" in a dim style, never the red
 *   "Closed" treatment. Open / closed records keep "Closes … · in N days" (red under 7 days) and "Closed …".
 */
export function dateLabel(rec, kind, days) {
  const d = kind === 'close' ? rec.close_date : rec.open_date;
  if (!d) return null;
  const when = fmtDate(d);
  if (isEstimated(rec)) {
    const verb = kind === 'close' ? 'Est. close ' : 'Est. open ';
    if (days != null && days < 0) return { text: verb + when + ' (date passed)', cls: 'est-passed' };
    return { text: verb + when + (days != null ? ' · ' + relDays(days) : ''), cls: '' };
  }
  if (kind === 'open') return { text: 'Opens ' + when, cls: '' };
  if (days != null && days < 0) return { text: 'Closed ' + when, cls: 'past' };
  return { text: 'Closes ' + when + (days != null ? ' · ' + relDays(days) : ''), cls: days != null && days < 7 ? 'soon' : '' };
}

/** ms timestamp -> "3h ago" style. */
export function ago(ms, now = Date.now()) {
  if (!ms) return 'unknown';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr}h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

/** Hash-safe id: keep ":" readable, encode everything else that needs it. */
export const encodeId = id => encodeURIComponent(id).replace(/%3A/gi, ':');
