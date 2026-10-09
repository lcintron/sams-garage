/*
 * Filter panel: status, keyword profiles, closing window, opens-after date, agency (+ sub-agency), program, phase,
 * "new since last visit" and saved searches. Re-rendered from state on every change; focus is restored by a
 * data-fkey on each control so keyboard users keep their place.
 */
import { h } from './dom.js';
import { STATUSES, STATUS_LABELS, PROGRAMS, PHASES, CLOSING_WITHIN } from '../filters.js';

/**
 * @param {HTMLElement} body  #filtersBody
 * @param {{ onChange:(patch)=>void, onManageProfiles:()=>void, onSaveSearch:(name)=>void, onDeleteSearch:(name)=>void,
 *           searchHref:(query)=>string }} handlers
 */
export function createFiltersPanel(body, handlers) {
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

  function chip(fkey, label, pressed, n, onclick, title) {
    return h('button', {
      class: 'chip' + (n === 0 && !pressed ? ' zero' : ''), type: 'button', 'aria-pressed': pressed ? 'true' : 'false',
      dataset: { fkey }, onclick, title
    }, label, n != null ? h('span', { class: 'n', text: String(n) }) : null);
  }

  function section(title, ...content) {
    return h('section', { class: 'fsec' }, h('h3', null, title), ...content);
  }

  /**
   * @param {object} s filter state
   * @param {object} c facet counts (search.facetCounts)
   * @param {{ agencies: Map, profiles: [], saved: [], hasLastVisit: boolean, allAgencies: string[], subsByAgency: Map }} ctx
   */
  function render(s, c, ctx) {
    const focusKey = document.activeElement?.closest?.('#filtersBody [data-fkey]')?.dataset.fkey;
    const scroll = body.scrollTop;

    const status = section('Status', h('div', { class: 'chips' },
      STATUSES.map(st => chip('status-' + st, STATUS_LABELS[st], s.status.includes(st), c.status[st] || 0,
        () => handlers.onChange({ status: toggle(s.status, st) })))));
    if (!s.status.length) status.appendChild(h('p', { class: 'small dim', text: 'No status selected: showing all.' }));

    const profiles = h('section', { class: 'fsec' },
      h('h3', null, h('span', { class: 'grow', text: 'Keyword profiles' }),
        h('button', { class: 'btn small ghost', type: 'button', dataset: { fkey: 'profiles-manage' }, onclick: handlers.onManageProfiles, text: 'Manage…' })),
      h('div', { class: 'chips' }, ctx.profiles.map(p => chip('profile-' + p.id, '#' + p.name, s.profile.includes(p.id), c.profile[p.id] || 0,
        () => handlers.onChange({ profile: toggle(s.profile, p.id) }), `${p.name}: ${p.terms.join(', ')}`))));

    const closing = section('Closing within', h('div', { class: 'seg', role: 'group', 'aria-label': 'Closing within' },
      [null, ...CLOSING_WITHIN].map(d => h('button', {
        type: 'button', 'aria-pressed': s.closing === d ? 'true' : 'false', dataset: { fkey: 'closing-' + d },
        onclick: () => handlers.onChange({ closing: d })
      }, d ? d + ' d' : 'Any'))));

    const opensInput = h('input', { type: 'date', id: 'opensAfter', value: s.opens || '', dataset: { fkey: 'opens' }, 'aria-label': 'Opens on or after' });
    opensInput.addEventListener('change', () => handlers.onChange({ opens: opensInput.value || '' }));
    const opens = section('Opens on or after', h('div', { class: 'row' }, opensInput,
      s.opens && h('button', { class: 'btn small ghost', type: 'button', dataset: { fkey: 'opens-clear' }, onclick: () => handlers.onChange({ opens: '' }), text: 'Clear' })));

    // agencies: every agency present in the data, selected ones first is not needed — keep a stable alphabetical order
    const agencyRows = ctx.allAgencies.map(code => {
      const info = ctx.agencies.get(code);
      const n = c.agency[code] || 0;
      const checked = s.agency.includes(code);
      const row = h('label', { class: 'check' + (n === 0 && !checked ? ' zero' : ''), title: info ? info.name : code },
        h('input', { type: 'checkbox', checked, dataset: { fkey: 'agency-' + code }, onchange: () => {
          const agency = toggle(s.agency, code);
          // dropping an agency drops its sub-agency selections
          const subs = ctx.subsByAgency.get(code) || new Set();
          handlers.onChange({ agency, sub: checked ? s.sub.filter(x => !subs.has(x)) : s.sub });
        } }),
        h('span', { class: 'lbl' }, h('span', { class: 'code', text: code }), info && info.name !== code ? h('span', { class: 'dim', text: ' ' + info.name }) : null),
        h('span', { class: 'n', text: String(n) }));
      const subs = [...(ctx.subsByAgency.get(code) || [])].sort();
      if (!checked || !subs.length) return row;
      return [row, h('div', { class: 'subchecks checks', role: 'group', 'aria-label': code + ' sub-agencies' }, subs.map(sub => {
        const sn = c.sub[sub] || 0;
        const sChecked = s.sub.includes(sub);
        const name = info?.subs?.get(sub);
        return h('label', { class: 'check' + (sn === 0 && !sChecked ? ' zero' : '') },
          h('input', { type: 'checkbox', checked: sChecked, dataset: { fkey: 'sub-' + sub }, onchange: () => handlers.onChange({ sub: toggle(s.sub, sub) }) }),
          h('span', { class: 'lbl' }, sub, name && name !== sub ? h('span', { class: 'dim', text: ' ' + name }) : null),
          h('span', { class: 'n', text: String(sn) }));
      }))];
    });
    const agency = section('Agency', h('div', { class: 'checks', role: 'group', 'aria-label': 'Agency' }, agencyRows));

    const program = section('Program', h('div', { class: 'chips' },
      PROGRAMS.map(p => chip('program-' + p, p, s.program.includes(p), c.program[p] || 0, () => handlers.onChange({ program: toggle(s.program, p) })))));
    const phase = section('Phase', h('div', { class: 'chips' },
      PHASES.map(p => chip('phase-' + p, p === 'DP2' ? 'Direct to II' : 'Phase ' + p, s.phase.includes(p), c.phase[p] || 0,
        () => handlers.onChange({ phase: toggle(s.phase, p) }), p === 'DP2' ? 'Direct to Phase II' : null))));

    const fresh = section('Since your last visit', ctx.hasLastVisit
      ? h('div', { class: 'chips' }, chip('new', 'New only', s.newOnly, c.new, () => handlers.onChange({ newOnly: !s.newOnly })))
      : h('p', { class: 'small dim', text: 'New topics will be flagged from your next visit on.' }));

    // saved searches
    const nameInput = h('input', { type: 'text', placeholder: 'Name this search', maxlength: '60', dataset: { fkey: 'save-name' }, 'aria-label': 'Saved search name' });
    const save = () => { const n = nameInput.value.trim(); if (n) handlers.onSaveSearch(n); };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    const saved = section('Saved searches',
      h('div', { class: 'row save-row' }, nameInput, h('button', { class: 'btn small', type: 'button', dataset: { fkey: 'save-btn' }, onclick: save, text: 'Save' })),
      ctx.saved.length ? h('ul', { class: 'saved-list' }, ctx.saved.map(x => h('li', null,
        h('a', { href: handlers.searchHref(x.query), title: x.query || '(default view)', text: x.name }),
        h('button', { class: 'icon-btn mini', type: 'button', title: 'Delete saved search', 'aria-label': 'Delete saved search ' + x.name,
          dataset: { fkey: 'del-' + x.name }, onclick: () => handlers.onDeleteSearch(x.name), text: '×' })))) : null);

    body.replaceChildren(status, profiles, closing, opens, agency, program, phase, fresh, saved);
    body.scrollTop = scroll;
    if (focusKey) body.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`)?.focus();
  }

  return { render };
}
