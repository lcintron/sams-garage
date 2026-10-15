/*
 * Settings view (#/settings): the device's settings in one place. Appearance (the theme), installing the app, the
 * notifications (a link, with a one-line status when their code is already loaded), the keyboard shortcuts, and
 * data and storage (freshness, versions, the SQL console and database download, clearing local data). Loaded on
 * demand by app.js; the theme buttons are handled there (any [data-theme-pick] button), like the side panel's.
 */
import { h, ago } from './dom.js';
import { metaUpdated, metaVersion } from '../data.js';

const RELEASES = 'https://github.com/lcintron/sams-garage/releases/latest';

/**
 * @param {HTMLElement} view  #settingsBody
 * @param {{ meta, offline: boolean, appVersion: string, catalogCount: number, theme: 'light'|'dark'|'system',
 *           install: 'desktop'|'installed'|'available'|'unavailable', onInstall: () => void,
 *           notify: Promise<string|null>|null, sqliteUrl: string, onClearLocal: () => void }} o
 */
export function renderSettings(view, o) {
  const m = o.meta;
  const t = metaUpdated(m);
  const sec = (id, title, ...content) => h('section', { class: 'set-sec', 'aria-labelledby': id }, h('h2', { id, text: title }), ...content);

  const theme = h('div', { class: 'seg theme-seg', role: 'group', 'aria-label': 'Theme' },
    [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([v, l]) =>
      h('button', { type: 'button', dataset: { themePick: v }, 'aria-pressed': o.theme === v ? 'true' : 'false', text: l })));

  const install = {
    desktop: [h('p', { text: "You are using the desktop app. It updates its data on its own and works offline." })],
    installed: [h('p', { text: 'Installed: SAM\'s Garage is running as an app. The last data you loaded works offline.' })],
    available: [h('p', { text: 'Install SAM\'s Garage to open it like an app, from its own window; the last data you loaded works offline.' }),
      h('button', { class: 'btn small primary', type: 'button', text: 'Install the app', onclick: o.onInstall })],
    unavailable: [h('p', null, 'Your browser has not offered to install it here. Look for "Install app" or "Add to Home Screen" in the browser\'s menu.')]
  }[o.install] || [];
  if (o.install !== 'desktop') {
    install.push(h('p', { class: 'small dim' }, 'Desktop apps for Windows, macOS and Linux are on the ',
      h('a', { href: RELEASES, target: '_blank', rel: 'noopener noreferrer', text: 'releases page' }), '.'));
  }

  const notifyStatus = h('span', { class: 'dim' });
  if (o.notify) o.notify.then(s => { if (s) notifyStatus.textContent = ' · ' + s; }).catch(() => {});

  const keys = [
    [['/'], 'Search'],
    [['↑', '↓'], 'Move through the results'],
    [['Enter'], 'Open the topic'],
    [['Esc'], 'Close the topic, the menu or a view: back to Opportunities'],
    [['Ctrl', 'Enter'], 'Run the query in the SQL console']
  ];

  view.replaceChildren(h('div', { class: 'about settings' },
    sec('setAppearance', 'Appearance',
      h('div', { class: 'row' }, h('span', { text: 'Theme' }), theme),
      h('p', { class: 'small dim', text: 'System follows your device\'s light or dark setting.' })),

    sec('setInstall', 'Install the app', ...install),

    sec('setNotify', 'Notifications',
      h('p', null, h('a', { href: '#/notify', text: 'Daily report' }), notifyStatus),
      h('p', { class: 'small dim', text: 'One report a day to Slack, Discord, Microsoft Teams or WhatsApp, about new topics that match your keywords and changes to the ones you starred.' })),

    sec('setKeys', 'Keyboard shortcuts',
      h('dl', { class: 'keys' }, keys.map(([k, what]) => [
        h('dt', null, k.flatMap((x, i) => [i ? (k[0] === 'Ctrl' ? '+' : ' ') : null, h('kbd', { text: x })])),
        h('dd', { text: what })]))),

    sec('setData', 'Data and storage',
      h('p', null, t ? `Data refreshed ${new Date(t).toLocaleString()} (${ago(t)})` : 'Refresh time unknown',
        o.offline ? ' · offline' : '', ` · ${(m?.counts?.total ?? o.catalogCount).toLocaleString()} records. `,
        h('a', { href: '#/about', text: 'Sources' }), '.'),
      h('p', { class: 'small dim', text: `Data version ${metaVersion(m) || 'unknown'} · app ${o.appVersion}` }),
      h('p', null, 'Query everything in the ', h('a', { href: '#/sql', text: 'SQL console' }), ', or ',
        h('a', { href: o.sqliteUrl, download: 'solicitations.sqlite', text: 'download the database (.sqlite)' }), '.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small danger', type: 'button', text: 'Clear local data', onclick: o.onClearLocal })),
      h('p', { class: 'small dim', text: 'Clears the watchlist, saved searches, keyword profiles, preferences and notification settings (with their webhooks and keys). They are stored only on this device.' }))));
}
