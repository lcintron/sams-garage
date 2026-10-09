/*
 * Stats bar (result count, sort, export, active filter chips) and the data-freshness pill in the header.
 */
import { h, ago, fmtDate } from './dom.js';
import { SORTS, STATUS_LABELS, defaultState } from '../filters.js';
import { metaUpdated } from '../data.js';

/** Fill the sort <select> once. */
export function initSort(select, onChange) {
  select.replaceChildren(...Object.entries(SORTS).map(([k, v]) => h('option', { value: k, text: v })));
  select.addEventListener('change', () => onChange(select.value));
}

/** Update the live result count ("54 of 68 topics"). */
export function renderCount(el, shown, total, mode) {
  const noun = mode === 'watch' ? 'watched' : 'topics';
  el.textContent = shown === total ? `${shown.toLocaleString()} ${noun}` : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`;
}

/**
 * Active filter chips; each removes its filter. A "Clear all" chip resets to defaults (keeping sort).
 * @param {(patch)=>void} onChange
 */
export function renderActiveChips(el, s, profilesById, onChange) {
  const d = defaultState();
  const chips = [];
  const add = (label, patch, title) => chips.push(h('button', { class: 'chip', type: 'button', title: title || 'Remove filter: ' + label, onclick: () => onChange(patch) }, label));
  if (s.q) add(`“${s.q}”`, { q: '' }, 'Clear search text');
  const sameStatus = s.status.length === d.status.length && s.status.every(x => d.status.includes(x));
  if (!sameStatus) {
    if (s.status.length) for (const st of s.status) add(STATUS_LABELS[st] || st, { status: s.status.filter(x => x !== st) });
    else add('Any status', { status: d.status }, 'Back to Open + Pre-release');
  }
  for (const p of s.profile) add('#' + (profilesById.get(p)?.name || p), { profile: s.profile.filter(x => x !== p) });
  for (const a of s.agency) add(a, { agency: s.agency.filter(x => x !== a) });
  for (const a of s.sub) add(a, { sub: s.sub.filter(x => x !== a) });
  for (const p of s.program) add(p, { program: s.program.filter(x => x !== p) });
  for (const p of s.phase) add(p === 'DP2' ? 'Direct to II' : 'Phase ' + p, { phase: s.phase.filter(x => x !== p) });
  if (s.closing) add(`Closes ≤ ${s.closing} d`, { closing: null });
  if (s.opens) add(`Opens ≥ ${fmtDate(s.opens)}`, { opens: '' });
  if (s.newOnly) add('New only', { newOnly: false });
  if (chips.length > 1) chips.push(h('button', { class: 'chip clear-all', type: 'button', onclick: () => onChange({ ...d, sort: s.sort }), text: 'Clear all' }));
  el.replaceChildren(...chips);
  return chips.length;
}

/** Header pill: "Updated 3h ago"; warns when a source failed or data is older than 2 days; marks dev fixtures. */
export function renderFreshness(el, meta, offline) {
  const txt = el.querySelector('.txt');
  el.classList.remove('ok', 'warn', 'stale', 'fixture');
  if (!meta) {
    txt.textContent = offline ? 'Offline' : 'No data';
    el.classList.add('stale');
    el.title = 'Data could not be loaded';
    return;
  }
  const t = metaUpdated(meta);
  const failed = Object.entries(meta.sources || {}).filter(([, v]) => v && v.ok === false).map(([k]) => k);
  const old = t && Date.now() - t > 2 * 86400000;
  txt.textContent = (meta.fixture ? 'DEV FIXTURE · ' : '') + 'Updated ' + ago(t) + (offline ? ' · offline' : '');
  el.classList.add(meta.fixture ? 'fixture' : old ? 'stale' : failed.length ? 'warn' : 'ok');
  el.title = [
    t ? 'Data refreshed ' + new Date(t).toLocaleString() : 'Refresh time unknown',
    failed.length ? 'Last run failed for: ' + failed.join(', ') : 'All sources OK on the last run',
    meta.fixture ? 'This is a development fixture, not real data' : null
  ].filter(Boolean).join('\n');
}
