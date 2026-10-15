/*
 * About view (#/about), informational only: what the app is, its version, data freshness per source, counts, links
 * and the license. The device's settings (theme, clearing local data, shortcuts) are in Settings (ui/settings.js).
 */
import { h, ago } from './dom.js';
import { metaUpdated, metaVersion } from '../data.js';
import { STATUS_LABELS } from '../filters.js';

const SOURCE_NAMES = { sbir_gov: 'SBIR.gov topics', dod_dsip: 'DoD SBIR/STTR (DSIP)', grants_gov: 'Grants.gov' };

/**
 * @param {HTMLElement} view
 * @param {{ meta, appVersion: string, catalogCount: number }} o
 */
export function renderAbout(view, o) {
  const m = o.meta;
  const sources = Object.entries(m?.sources || {});
  const counts = m?.counts || {};
  const t = metaUpdated(m);

  view.replaceChildren(h('div', { class: 'about' },
    h('div', { class: 'about-app' },
      h('img', { src: 'icons/icon.svg', alt: '', width: '40', height: '40' }),
      h('div', null, h('h2', { text: "SAM's Garage" }), h('p', { class: 'dim', text: `Version ${o.appVersion}` }))),
    h('p', null, "SAM's Garage (Sg) puts every open and upcoming U.S. federal SBIR/STTR topic and solicitation in one searchable list: DoD, HHS/NIH, NSF, DOE, NASA, USDA, DHS, DOT, EPA, ED, DOC and more. ",
      'The data is scraped daily by a GitHub Action from SBIR.gov, the DoD SBIR/STTR portal (DSIP) and Grants.gov, stored in the git repository, and searched entirely in your browser. ',
      'Always confirm details in the official solicitation before you propose.'),
    m?.fixture ? h('div', { class: 'notice' }, h('h2', { text: 'Development fixture' }),
      h('p', { text: m.note || 'This data was generated for development and is not real.' })) : null,

    h('h2', { text: 'Data' }),
    h('p', null, t ? `Last refreshed ${new Date(t).toLocaleString()} (${ago(t)}). ` : 'Refresh time unknown. ',
      `${(counts.total ?? o.catalogCount).toLocaleString()} records`,
      counts.by_status ? ' — ' + Object.entries(counts.by_status).map(([k, v]) => `${v} ${STATUS_LABELS[k] || k}`).join(', ') : '', '.'),
    sources.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Source', 'Last run', 'Status', 'Fetched', 'Failed', 'Error'].map(x => h('th', { scope: 'col', text: x })))),
      h('tbody', null, sources.map(([k, v]) => h('tr', null,
        h('td', { text: SOURCE_NAMES[k] || k }),
        h('td', { text: v?.ran_at ? ago(Date.parse(v.ran_at)) : '—' }),
        h('td', { class: v?.ok ? 'ok' : 'bad', text: v?.ok ? 'OK' : 'Failed' }),
        h('td', { text: String(v?.fetched ?? '—') }),
        h('td', { text: String(v?.failed ?? '—') }),
        h('td', { class: 'dim', text: v?.error || '' })))))) : null,
    h('p', { class: 'small dim', text: `Data version ${metaVersion(m) || 'unknown'} · app ${o.appVersion}` }),

    h('h2', { text: 'Use it' }),
    h('ul', null,
      h('li', null, 'Every filter is part of the address, so a view can be bookmarked or shared.'),
      h('li', null, 'Star topics to keep them on your ', h('a', { href: '#/watch', text: 'watchlist' }), '. Topics first seen since your last visit are marked NEW.'),
      h('li', null, 'Keyword profiles (#UAS, #Counter-UAS, #Acoustic, or your own) flag and rank matching topics.'),
      h('li', null, 'The ', h('a', { href: '#/sql', text: 'SQL console' }), ' runs read-only queries over the whole database in your browser.'),
      h('li', null, 'Install it (the Install button, ', h('a', { href: '#/settings', text: 'Settings' }), ' or the browser menu) to use it like an app; the last data you loaded works offline. ',
        'Desktop apps for Windows, macOS and Linux are on the ', h('a', { href: 'https://github.com/lcintron/sams-garage/releases/latest', target: '_blank', rel: 'noopener noreferrer', text: 'releases page' }), '.'),
      h('li', null, 'Your watchlist, saved searches, profiles and settings stay on this device; the theme, keyboard shortcuts and clearing them are in ',
        h('a', { href: '#/settings', text: 'Settings' }), '.')),

    h('h2', { text: 'Open source' }),
    h('p', null, 'MIT licensed; source on ', h('a', { href: 'https://github.com/lcintron/sams-garage', target: '_blank', rel: 'noopener noreferrer', text: 'GitHub' }), '. Bundled: ', h('a', { href: 'vendor/minisearch/LICENSE.txt', text: 'MiniSearch' }), ' (MIT) and ',
      h('a', { href: 'vendor/sqljs/LICENSE', text: 'sql.js' }), ' (MIT). Not affiliated with the SBA or any agency.')));
}
