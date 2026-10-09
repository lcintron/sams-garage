/*
 * "Manage keyword profiles" dialog. Presets (UAS, Counter-UAS, Acoustic) are read-only but can be duplicated;
 * user profiles can be added, edited and deleted. Saving goes through onSave(list) (store.js persists it).
 */
import { h } from './dom.js';
import { PRESET_PROFILES, parseTerms, profileId, normalizeProfile } from '../profiles.js';

let dlg = null;

/**
 * @param {Array} userProfiles current user profiles
 * @param {(list:Array)=>void} onSave
 */
export function openProfilesDialog(userProfiles, onSave) {
  let list = userProfiles.map(normalizeProfile).filter(Boolean);
  let editing = null; // { id|null, name, terms, bonus, from }

  if (!dlg) {
    dlg = h('dialog', { id: 'profilesDlg', 'aria-labelledby': 'profilesDlgTitle' });
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // click on backdrop
  }

  function persist(next) {
    list = next;
    onSave(list);
    render();
  }

  function form() {
    const name = h('input', { type: 'text', value: editing.name, maxlength: '40', required: true, id: 'pfName' });
    const terms = h('textarea', { id: 'pfTerms', spellcheck: 'false' }, editing.terms.join(', '));
    const bonus = h('input', { type: 'number', min: '0', max: '10', step: '1', value: String(editing.bonus ?? 3), id: 'pfBonus' });
    const err = h('p', { class: 'small', style: 'color:var(--danger)', role: 'alert' });
    const submit = e => {
      e.preventDefault();
      const t = parseTerms(terms.value);
      if (!name.value.trim()) { err.textContent = 'Give the profile a name.'; name.focus(); return; }
      if (!t.length) { err.textContent = 'Add at least one term.'; terms.focus(); return; }
      const id = editing.id || profileId(name.value, list.map(p => p.id));
      const p = normalizeProfile({ id, name: name.value, terms: t, bonus: bonus.value });
      const next = editing.id ? list.map(x => (x.id === id ? p : x)) : [...list, p];
      editing = null;
      persist(next);
    };
    return h('form', { class: 'prof-item prof-form', onsubmit: submit },
      h('label', { for: 'pfName' }, 'Name', name),
      h('label', { for: 'pfTerms' }, 'Terms (comma or one per line; whole words/phrases, case-insensitive)', terms),
      h('label', { for: 'pfBonus' }, 'Bonus points when any term matches (0–10)', bonus),
      err,
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', type: 'submit', text: editing.id ? 'Save profile' : 'Add profile' }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => { editing = null; render(); } })));
  }

  function item(p) {
    return h('div', { class: 'prof-item' },
      h('div', { class: 'row' },
        h('span', { class: 'name', text: '#' + p.name }),
        p.preset ? h('span', { class: 'tag', text: 'preset · bonus ' + p.bonus }) : h('span', { class: 'tag', text: 'yours · bonus ' + p.bonus }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Duplicate', onclick: () => {
          editing = { id: null, name: p.name + ' (copy)', terms: [...p.terms], bonus: p.bonus };
          render();
        } }),
        !p.preset && h('button', { class: 'btn small ghost', type: 'button', text: 'Edit', onclick: () => { editing = { ...p }; render(); } }),
        !p.preset && h('button', { class: 'btn small ghost danger', type: 'button', text: 'Delete', onclick: () => {
          if (confirm(`Delete the profile "${p.name}"?`)) persist(list.filter(x => x.id !== p.id));
        } })),
      h('div', { class: 'terms', text: p.terms.join(', ') }));
  }

  function render() {
    const body = h('div', { class: 'dlg-body' },
      h('p', { class: 'small dim' }, 'A topic matches a profile when any of its terms appears in the title, summary, description or keywords. ',
        'Score = 2 per matched term + the profile bonus + up to 3 for context terms (sensor, tracking, detection…).'),
      editing && !editing.id ? form() : h('p', null, h('button', { class: 'btn small primary', type: 'button', text: '+ New profile', onclick: () => {
        editing = { id: null, name: '', terms: [], bonus: 3 };
        render();
      } })),
      PRESET_PROFILES.map(item),
      list.map(p => (editing && editing.id === p.id ? form() : item(p))));
    dlg.replaceChildren(
      h('div', { class: 'dlg-head' }, h('h2', { id: 'profilesDlgTitle', text: 'Keyword profiles' }),
        h('button', { class: 'icon-btn mini', type: 'button', 'aria-label': 'Close', title: 'Close', text: '×', onclick: () => dlg.close() })),
      body);
    dlg.querySelector('form input, form textarea')?.focus();
  }

  render();
  if (!dlg.open) dlg.showModal();
}
