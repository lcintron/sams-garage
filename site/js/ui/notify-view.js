/*
 * Notifications view (#/notify): the daily report's channels, triggers and time, a preview, the background status
 * (what runs where) and the export for GitHub Actions. Loaded on demand by app.js. Settings are saved as they change
 * (a short debounce, flushed when the page is hidden); each save reloads the stored settings and re-applies this
 * view's changes, so a change made elsewhere (the desktop tray's Pause) is never overwritten with a stale value. A
 * channel's fields are saved with its form. Secrets are shown only in their own fields (password inputs). In a browser,
 * Teams and WhatsApp Cloud API channels keep no secret: those are typed in the export form and used only there.
 */
import { h, fmtDate } from './dom.js';
import * as page from '../notify/page.js';

const N = globalThis.SgNotify;
const KINDS = [
  { type: 'slack', label: 'Slack' },
  { type: 'discord', label: 'Discord' },
  { type: 'teams', label: 'Microsoft Teams' },
  { type: 'whatsapp', provider: 'callmebot', label: 'WhatsApp (CallMeBot)' },
  { type: 'whatsapp', provider: 'cloud', label: 'WhatsApp (Cloud API)' }
];
const README = 'https://github.com/lcintron/sams-garage#notifications';
const LABELS = {
  url: 'Webhook URL', phone: 'Your WhatsApp number, with country code', apikey: 'CallMeBot API key',
  phoneNumberId: 'Phone number ID', accessToken: 'Access token', to: 'Send to (number with country code)',
  template: 'Approved template name (its body has one {{1}} variable)', language: 'Template language code'
};
const PLACEHOLDERS = {
  slack: { url: 'https://hooks.slack.com/services/…' }, discord: { url: 'https://discord.com/api/webhooks/…' },
  teams: { url: 'https://….logic.azure.com/workflows/…' },
  'whatsapp:callmebot': { phone: '+15551234567', apikey: '123456' },
  'whatsapp:cloud': { phoneNumberId: '1234567890', accessToken: 'EAAG…', to: '+15551234567', template: 'sg_daily_report', language: 'en_US' }
};
const HELP = {
  slack: ['In Slack, create an app at ', ['api.slack.com/apps', 'https://api.slack.com/apps'], ', turn on Incoming Webhooks, choose "Add New Webhook to Workspace", pick a channel and copy the URL.'],
  discord: ['In Discord, open the channel settings → Integrations → Webhooks → New Webhook, then "Copy Webhook URL".'],
  teams: ['In Teams, open the channel\'s ⋯ menu → Workflows → "Post to a channel when a webhook request is received", finish the steps and copy the URL. Office 365 connector URLs no longer work. Teams can only be sent from the desktop app or GitHub Actions.'],
  'whatsapp:callmebot': ['Free, for your own number. Follow the steps on ', ['CallMeBot', 'https://www.callmebot.com/blog/free-api-whatsapp-messages/'], ' (you message their bot once and get an API key), then enter your number and the key.'],
  'whatsapp:cloud': ['Meta\'s WhatsApp Cloud API: a WhatsApp Business app, its phone number ID, an access token, and an approved message template whose body has exactly one variable, {{1}}. Desktop app or GitHub Actions only.']
};

let ui = null; // {view, o, settings, state, lastReport, encryption, editing, draft, preview, status, exportSecrets}

const kindOf = c => N.kindOf(c);
const unsupportedHere = c => !page.isDesktop() && N.browserMode(c) === 'unsupported';
const validate = c => N.validateChannel(c, page.secretsKept(c) ? undefined : { secrets: false });
const sharedOriginHere = () => !page.isDesktop() && N.sharedOrigin(location.hostname);
const when = iso => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? '' : new Date(t).toLocaleString(); };
const helpNodes = parts => parts.map(p => (Array.isArray(p) ? h('a', { href: p[1], target: '_blank', rel: 'noopener noreferrer', text: p[0] }) : p));

/**
 * @param {HTMLElement} view
 * @param {{catalog, descriptions, profiles, watchCount, reportLast: boolean, toast: Function}} o
 */
export async function showNotifyView(view, o) {
  const first = !ui || ui.view !== view;
  ui = { ...(first ? {} : ui), view, o };
  if (!first && ui.settings) {
    // back on the view: the run state and the last report may have changed meanwhile (a background report); the
    // settings too, unless a channel form is open
    try {
      const r = await page.load();
      Object.assign(ui, { state: r.state, lastReport: r.lastReport, encryption: r.encryption }, ui.editing ? {} : { settings: r.settings });
    } catch { /* keep what is shown */ }
  } else {
    view.replaceChildren(h('div', { class: 'notify' }, h('p', { class: 'dim', text: 'Loading notification settings…' })));
    try {
      Object.assign(ui, await page.load(), { editing: null, draft: null, preview: undefined });
    } catch (e) {
      view.replaceChildren(h('div', { class: 'notify' },
        h('p', { class: 'notice', text: 'Notification settings cannot be stored in this browser (' + e.message + '). Private windows often block it.' })));
      ui.settings = null;
      return;
    }
  }
  render();
  page.status().then(s => { ui.status = s; renderStatus(); }).catch(() => {});
  if (o.reportLast) setTimeout(() => ui.view.querySelector('#nfLast')?.scrollIntoView({ block: 'start' }), 0);
}

// ---------- saving ----------

let saveTimer = null;
let pending = []; // this view's changes since the last save, as functions of the settings
let saving = Promise.resolve();
const replay = (fns, s) => fns.reduce((acc, fn) => N.normalizeSettings(fn(structuredClone(acc))), s);

function change(patch) {
  const fn = typeof patch === 'function' ? patch : s => ({ ...s, ...patch });
  pending.push(fn);
  ui.settings = replay([fn], ui.settings);
  ui.preview = undefined;
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { flushSave(); }, 400);
}

/** Save now: reload what is stored, re-apply this view's pending changes, store the result. */
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!pending.length) return saving;
  const fns = pending;
  pending = [];
  saving = saving.then(async () => {
    try {
      const saved = await page.save(replay(fns, (await page.load()).settings));
      if (ui) {
        ui.settings = replay(pending, saved); // edits made meanwhile stay on top
        ui.o.toast('Notification settings saved', { id: 'nfsave', timeout: 1500 });
      }
    } catch (e) {
      if (ui) ui.o.toast('Could not save: ' + e.message, { id: 'nfsave' });
    }
    page.status().then(st => { if (ui) { ui.status = st; renderStatus(); } }).catch(() => {});
  });
  return saving;
}

// a page that is hidden or closed saves what is pending at once
addEventListener('pagehide', () => { flushSave(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
// the desktop app's tray changed the settings: show them (this view's pending edits are re-applied on top)
page.onSettingsChanged(async () => {
  if (!ui || !ui.settings || ui.editing) return;
  try {
    const r = await page.load();
    ui.settings = replay(pending, r.settings);
    ui.state = r.state;
    render();
  } catch { /* keep what is shown */ }
});
const trig = patch => change(s => ({ ...s, triggers: { ...s.triggers, ...patch } }));
const bg = patch => change(s => ({ ...s, background: { ...s.background, ...patch } }));

async function refreshState() {
  const r = await page.load();
  ui.state = r.state;
  ui.lastReport = r.lastReport;
  render();
}

// ---------- render ----------

/** Only the status panel: a full render would rebuild a form the person is typing in. */
function renderStatus() {
  const old = ui && ui.settings && ui.view.querySelector('#nfWhere');
  if (old) old.replaceWith(backgroundSection(ui.settings));
}

function render() {
  if (!ui || !ui.settings) return;
  const s = ui.settings;
  const focusId = document.activeElement && ui.view.contains(document.activeElement) ? document.activeElement.id : null;
  ui.view.replaceChildren(h('div', { class: 'notify' }, // the title is in the view's header (index.html)
    h('p', null, 'One report a day, and only when there is something to report: new topics that match your keywords, ',
      'changes to matching topics, and any change to the topics you starred. It goes to Slack, Discord, Microsoft Teams or WhatsApp. ',
      h('a', { href: README, target: '_blank', rel: 'noopener noreferrer', text: 'Setup guide' }), '.'),
    lastReportSection(),
    scheduleSection(s),
    triggersSection(s),
    channelsSection(s),
    previewSection(),
    backgroundSection(s),
    exportSection()));
  if (focusId) document.getElementById(focusId)?.focus();
}

function lastReportSection() {
  const r = ui.lastReport;
  if (!r || !r.digest) return ui.o.reportLast ? h('section', { class: 'nf-sec', id: 'nfLast' }, h('h2', { text: 'Last report' }), h('p', { class: 'dim', text: 'No report has been sent from this device yet.' })) : null;
  return h('section', { class: 'nf-sec', id: 'nfLast' },
    h('details', { open: ui.o.reportLast || null },
      h('summary', null, h('h2', { class: 'inline', text: 'Last report' }), ' ', h('span', { class: 'dim small', text: 'sent ' + when(r.at) })),
      digestView(r.digest)));
}

function scheduleSection(s) {
  const st = ui.state || {};
  const time = h('input', { type: 'time', id: 'nfTime', value: s.time, required: true });
  time.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(time.value)) change({ time: time.value }); });
  return h('section', { class: 'nf-sec' },
    h('h2', { text: 'Daily report' }),
    h('div', { class: 'row' },
      toggle('nfEnabled', s.enabled, 'Send a daily report', v => change({ enabled: v })),
      h('label', { class: 'nf-time', for: 'nfTime' }, 'at or after ', time),
      h('button', { class: 'btn small', type: 'button', text: "Send today's report now", disabled: !s.channels.some(c => c.enabled) || null, onclick: sendNow })),
    h('p', { class: 'small dim' }, st.lastSent && st.lastSent.at ? `Last report sent ${when(st.lastSent.at)}. ` : 'No report sent from this device yet. ',
      'A day that was missed (device off) is caught up at the next check; each report covers everything since the one before.'));
}

function triggersSection(s) {
  const t = s.triggers;
  const input = h('input', { type: 'text', id: 'nfKeyword', placeholder: 'Add a keyword, phrase or #tag', maxlength: '60', autocomplete: 'off',
    value: ui.keywordDraft || '', oninput: e => { ui.keywordDraft = e.target.value; } });
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    ui.keywordDraft = '';
    trig({ keywords: [...t.keywords, ...v.split(',').map(x => x.trim()).filter(Boolean)] });
    setTimeout(() => document.getElementById('nfKeyword')?.focus(), 0);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const profiles = ui.o.profiles || [];
  return h('section', { class: 'nf-sec' },
    h('h2', { text: 'What to report' }),
    h('div', { class: 'nf-checks' },
      toggle('nfNew', t.newMatches, 'New topics that match', v => trig({ newMatches: v })),
      toggle('nfUpd', t.updatedMatches, 'Changes to topics that match (status, dates, description)', v => trig({ updatedMatches: v })),
      toggle('nfStar', t.starred, `Any change to a starred topic, whatever the keywords (${ui.o.watchCount} starred)`, v => trig({ starred: v }))),
    h('h3', { text: 'Keywords and hashtags' }),
    h('p', { class: 'small dim', text: 'Whole words or phrases, any case; "-" and " " are the same and a leading # is ignored, so #Counter-UAS matches "counter UAS".' }),
    h('div', { class: 'chips nf-chips', 'aria-label': 'Keywords' },
      t.keywords.map(k => h('button', { class: 'chip nf-chip', type: 'button', title: 'Remove ' + k, 'aria-label': 'Remove keyword ' + k, text: k,
        onclick: () => trig({ keywords: t.keywords.filter(x => x !== k) }) })),
      t.keywords.length ? null : h('span', { class: 'dim small', text: 'No keywords yet.' })),
    h('div', { class: 'row nf-add' }, input, h('button', { class: 'btn small', type: 'button', text: 'Add', onclick: add })),
    h('h3', { text: 'Keyword profiles' }),
    h('div', { class: 'checks nf-profiles' }, profiles.map(p => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: t.profiles.includes(p.id), onchange: e => trig({ profiles: e.target.checked ? [...t.profiles, p.id] : t.profiles.filter(x => x !== p.id) }) }),
      h('span', { class: 'lbl' }, h('span', { class: 'code', text: '#' + p.name }), ' ', h('span', { class: 'dim small', text: (p.preset ? 'preset · ' : 'yours · ') + p.terms.slice(0, 6).join(', ') + (p.terms.length > 6 ? '…' : '') }))))),
    h('p', { class: 'small dim', text: 'Add your own profiles under Filters → Keyword profiles → Manage.' }),
    !t.keywords.length && !t.profiles.length ? h('p', { class: 'small warn-text', text: 'With no keywords or profiles, only starred topics are reported.' }) : null);
}

function channelsSection(s) {
  const st = (ui.state && ui.state.channels) || {};
  const adding = typeof ui.editing === 'string' && ui.editing.startsWith('new:');
  return h('section', { class: 'nf-sec' },
    h('h2', { text: 'Channels' }),
    s.channels.length ? null : h('p', { class: 'dim', text: 'No channels yet. Add one below.' }),
    h('div', { class: 'nf-chans' }, s.channels.map(c => (ui.editing === c.id ? channelForm(ui.draft) : channelCard(c, st[c.id] || {})))),
    adding ? channelForm(ui.draft) : null,
    h('div', { class: 'row nf-addchan' }, h('span', { class: 'small dim', text: 'Add:' }),
      KINDS.map(k => h('button', { class: 'btn small', type: 'button', text: '+ ' + k.label, onclick: () => {
        const n = s.channels.length + 1;
        ui.editing = 'new:' + k.type;
        ui.draft = N.normalizeChannel({ id: 'c' + Date.now().toString(36), type: k.type, provider: k.provider, name: k.label + (n > 1 ? ' ' + n : '') });
        render();
        setTimeout(() => ui.view.querySelector('.nf-form input')?.focus(), 0);
      } }))));
}

function channelCard(c, cs) {
  const v = validate(c);
  const statusText = cs.error && cs.failDate ? `Failed ${cs.failDate}: ${cs.error}` : cs.at ? `Last report ${when(cs.at)}${cs.opaque ? ' (sent; a browser cannot read the answer)' : ''}` : 'No report sent yet.';
  return h('div', { class: 'nf-chan' + (c.enabled ? '' : ' off') },
    h('div', { class: 'row' },
      h('label', { class: 'check nf-on', title: c.enabled ? 'Enabled' : 'Disabled' },
        h('input', { type: 'checkbox', checked: c.enabled, 'aria-label': 'Enable ' + c.name, onchange: e => change(st => ({ ...st, channels: st.channels.map(x => (x.id === c.id ? { ...x, enabled: e.target.checked } : x)) })) })),
      h('span', { class: 'nf-name', text: c.name }),
      h('span', { class: 'tag', text: N.kindLabel(c) }),
      unsupportedHere(c) ? h('span', { class: 'tag nf-only', text: 'Desktop app or GitHub Actions only' }) : null,
      v.ok ? null : h('span', { class: 'tag nf-bad', text: 'Incomplete' }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', type: 'button', text: 'Send test', disabled: !v.ok || unsupportedHere(c) || null, onclick: e => sendTest(c, e.target) }),
      h('button', { class: 'btn small ghost', type: 'button', text: 'Edit', onclick: () => { ui.editing = c.id; ui.draft = { ...c }; render(); } }),
      h('button', { class: 'btn small ghost danger', type: 'button', text: 'Remove', onclick: () => {
        if (confirm(`Remove the channel "${c.name}"? Its settings, webhook and key are deleted from this device.`)) change(st => ({ ...st, channels: st.channels.filter(x => x.id !== c.id) }));
      } })),
    h('p', { class: 'small ' + (cs.error && cs.failDate ? 'warn-text' : 'dim'), text: statusText }));
}

function channelForm(c) {
  const kind = kindOf(c);
  const isNew = ui.editing.startsWith('new:');
  const err = h('div', { class: 'small nf-errors', role: 'alert' });
  const inputs = {};
  const kept = page.secretsKept(c);
  const fields = [{ key: 'name' }, ...N.fieldsOf(c).filter(f => kept || !f.secret)];
  // c is ui.draft: typed text survives a re-render
  const rows = fields.map(f => secretInput('nf-f-' + f.key, f, kind, c[f.key] || '', v => { c[f.key] = v; }, inputs));
  const submit = e => {
    e.preventDefault();
    const next = { ...c };
    for (const [k, input] of Object.entries(inputs)) next[k] = input.value.trim();
    const v = validate(next);
    if (!v.ok) {
      err.replaceChildren(...v.errors.map(x => h('p', { text: (LABELS[x.field] || x.field) + ': ' + x.message })));
      inputs[v.errors[0].field]?.focus();
      return;
    }
    const n = N.normalizeChannel(next);
    ui.editing = null;
    ui.draft = null;
    change(st => ({ ...st, channels: isNew ? [...st.channels, n] : st.channels.map(x => (x.id === n.id ? { ...n, enabled: x.enabled } : x)) }));
    if (v.warnings.length) ui.o.toast(v.warnings[0], { timeout: 6000 });
  };
  return h('form', { class: 'nf-chan nf-form', onsubmit: submit },
    h('div', { class: 'row' }, h('strong', { text: (isNew ? 'New ' : 'Edit ') + N.kindLabel(c) + ' channel' }),
      unsupportedHere(c) ? h('span', { class: 'tag nf-only', text: 'Desktop app or GitHub Actions only' }) : null),
    h('p', { class: 'small dim' }, helpNodes(HELP[kind] || [])),
    rows, err,
    kept ? null : h('p', { class: 'small notice nf-warn nf-nokeep' }, 'This browser cannot send to ' + N.kindLabel(c) + ', so it does not keep its ',
      kind === 'teams' ? 'webhook URL: you enter it' : 'access token and numbers: you enter them', ' under "Export for GitHub Actions", for the export only. To send from this computer, use the desktop app.'),
    kept && sharedOriginHere() ? h('p', { class: 'small notice nf-warn nf-origin' }, h('strong', { text: 'Shared address: ' }),
      'other sites under ' + location.hostname + ' can read what this site keeps in the browser. For webhooks and keys, prefer the desktop app or GitHub Actions, or wait for the app\'s own domain.') : null,
    h('p', { class: 'small dim', text: page.isDesktop() ? 'Stored on this computer, encrypted with the system keychain when one is available.' : kept ? 'Stored only in this browser. Anyone with this webhook or key can post to the channel: keep it private.' : 'Only the name and the fields that are not secret are stored in this browser.' }),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'submit', text: isNew ? 'Add channel' : 'Save channel' }),
      h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => { ui.editing = null; ui.draft = null; render(); } })));
}

function previewSection() {
  const d = ui.preview;
  return h('section', { class: 'nf-sec' },
    h('h2', { text: 'Preview' }),
    h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', id: 'nfPreview', text: 'Preview report (last 7 days)', onclick: preview }),
      h('span', { class: 'small dim', text: 'With the settings above, as if the last report had been a week ago.' })),
    d === undefined ? null : d === null ? h('p', { class: 'dim', text: 'Nothing to report for the last 7 days with these settings.' }) : h('div', null,
      digestView(d),
      h('details', { class: 'nf-payloads' }, h('summary', { text: 'What each platform receives' }),
        payload('Slack (text)', d, x => N.format.slack(x, ctx()).blocks.map(b => b.text ? b.text.text : b.elements ? b.elements.map(e => e.text).join(' ') : '—').join('\n\n')),
        payload('Discord (JSON)', d, x => JSON.stringify(N.format.discord(x, ctx()), null, 2)),
        payload('Microsoft Teams (Adaptive Card)', d, x => JSON.stringify(N.format.teams(x, ctx()), null, 2)),
        payload('WhatsApp (CallMeBot text)', d, x => N.format.whatsapp(x, ctx())),
        payload('WhatsApp (Cloud API template parameter)', d, x => N.format.whatsappTemplate(x, ctx())))));
}
const ctx = () => ({ publicUrl: N.PUBLIC_URL });
const payload = (title, d, fn) => h('div', null, h('h3', { text: title }), h('pre', { class: 'nf-pre', text: fn(d) }));

function digestView(d) {
  return h('div', { class: 'nf-report' },
    h('p', { class: 'nf-headline', text: N.format.headline(d) + (d.until ? ' · changes through ' + fmtDate(d.until.slice(0, 10)) : '') }),
    d.partial ? h('p', { class: 'small warn-text', text: N.PARTIAL_NOTE }) : null,
    d.sections.map(sec => h('div', { class: 'nf-rsec' },
      h('h3', { text: `${sec.title} (${sec.total})` }),
      h('ul', null, sec.items.map(it => h('li', null,
        h('a', { href: '#/s/' + encodeURIComponent(it.id).replace(/%3A/gi, ':'), text: it.title }),
        h('div', { class: 'small dim', text: N.format.detail(it) })))),
      sec.more ? h('p', { class: 'small dim', text: `…and ${sec.more} more` }) : null)));
}

function backgroundSection(s) {
  const st = ui.status;
  const rows = [];
  if (page.isDesktop()) {
    const d = st && st.desktop;
    rows.push(['This desktop app', d ? [
      d.paused ? 'Paused. ' : s.enabled ? 'Checks every 15 minutes and when the computer wakes, while the app runs (also from the tray when its window is closed). ' : 'Off: switch on "Send a daily report". ',
      d.lastCheck ? `Last check ${when(d.lastCheck)}. ` : '',
      d.encryption === false ? h('strong', { class: 'warn-text', text: 'No system keychain: webhooks and keys are stored unencrypted on this computer. ' }) : 'Webhooks and keys are encrypted with the system keychain. ',
      d.openAtLogin ? 'Starts at login. ' : 'Use the tray menu to start it at login.'
    ] : 'Status unavailable.']);
  } else {
    const ps = st ? st.periodicSync : 'unknown';
    const psText = !st ? 'Checking…' : ps === 'unsupported' ? 'This browser has no Periodic Background Sync (Chromium browsers have it for installed apps).'
      : ps === 'granted' ? (st.registered ? 'Periodic Background Sync is on: the browser wakes the app about twice a day while it runs.' : 'Periodic Background Sync is allowed and turns on with a browser-capable channel.')
      : 'Periodic Background Sync is not allowed: install the app (Install in the header) and use it for a while.';
    rows.push(['This browser', [
      'Checks when you open the app and when it comes back to the foreground. ', psText, ' A browser never runs when it is fully closed. ',
      h('div', { class: 'row' },
        toggle('nfBrowser', s.background.browser, 'Send from this browser', v => bg({ browser: v })),
        st && st.notifications === 'default' ? h('button', { class: 'btn small', type: 'button', text: 'Allow notifications on this device', onclick: async () => { await page.requestNotifications(); ui.status = await page.status(); renderStatus(); } })
          : h('span', { class: 'small dim', text: st ? (st.notifications === 'granted' ? 'Device notifications allowed.' : st.notifications === 'denied' ? 'Device notifications blocked in the browser settings.' : '') : '' }))
    ]]);
  }
  rows.push(['Device notification', [toggle('nfOs', s.background.osNotification, 'Also show the report as a notification on this device', v => bg({ osNotification: v }))]]);
  rows.push(['GitHub Actions', ['Runs after each daily data refresh, with every device off. Export the settings to the repository secret below. ',
    'Pick one place for each channel: a channel set up both here and in GitHub Actions gets two reports.']]);
  return h('section', { class: 'nf-sec', id: 'nfWhere' }, h('h2', { text: 'Where it runs' }),
    h('dl', { class: 'nf-where' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)])));
}

function exportSection() {
  // the secrets this runtime does not keep (a browser's Teams and Cloud API channels) are typed here, for this export
  const need = ui.settings.channels.filter(c => c.enabled && !page.secretsKept(c));
  const typed = ui.exportSecrets || (ui.exportSecrets = {});
  const inputs = {};
  const rows = need.map(c => h('fieldset', { class: 'nf-chan nf-form' }, h('legend', { text: c.name + ' (' + N.kindLabel(c) + ')' }),
    N.fieldsOf(c).filter(f => f.secret).map(f => secretInput('nf-x-' + c.id + '-' + f.key, f, N.kindOf(c), (typed[c.id] || {})[f.key] || '',
      v => { (typed[c.id] = typed[c.id] || {})[f.key] = v; }, inputs, c.id))));
  return h('section', { class: 'nf-sec', id: 'nfExport' },
    h('h2', { text: 'Export for GitHub Actions' }),
    h('p', null, 'Copies your settings, watchlist and custom profiles as JSON for the repository secret ', h('code', { text: 'SG_NOTIFY_CONFIG' }),
      ' (Settings → Secrets and variables → Actions → New repository secret). The daily workflow then sends the report after each data refresh.'),
    h('p', { class: 'notice nf-warn' }, h('strong', { text: 'It contains your secrets: ' }),
      'webhook URLs, API keys and tokens. Paste it only into the repository secret, never into an issue, a commit or a chat. Export again after you change the settings or the watchlist.'),
    need.length ? h('p', { class: 'small dim', text: 'These channels keep no secret in this browser: enter them for this export. They are not saved.' }) : null,
    rows,
    h('div', { class: 'small nf-errors', id: 'nfExportErr', role: 'alert' }),
    h('button', { class: 'btn small', type: 'button', text: 'Copy settings for GitHub Actions', onclick: exportConfig }));
}

/** One input for a channel field: secrets as password fields that browsers and password managers do not offer to save. */
function secretInput(id, f, kind, value, onInput, inputs, group) {
  const type = f.secret && (f.key === 'url' || f.key === 'apikey' || f.key === 'accessToken') ? 'password' : f.key === 'phone' || f.key === 'to' ? 'tel' : 'text';
  const input = h('input', { id, type, value, spellcheck: 'false', placeholder: f.key === 'name' ? '' : (PLACEHOLDERS[kind] || {})[f.key] || '',
    autocomplete: type === 'password' ? 'new-password' : 'off', 'data-lpignore': 'true', 'data-1p-ignore': 'true',
    oninput: e => onInput(e.target.value) });
  inputs[group ? group + ':' + f.key : f.key] = input;
  const show = type === 'password' ? h('button', { class: 'btn small ghost', type: 'button', text: 'Show', onclick: e => { input.type = input.type === 'password' ? 'text' : 'password'; e.target.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }) : null;
  return h('label', { for: id }, f.key === 'name' ? 'Name' : LABELS[f.key] || f.key, h('span', { class: 'row nf-field' }, input, show));
}

function toggle(id, on, label, onchange) {
  return h('label', { class: 'check nf-toggle', for: id }, h('input', { type: 'checkbox', id, checked: !!on, onchange: e => onchange(e.target.checked) }), h('span', { class: 'lbl', text: label }));
}

// ---------- actions ----------

async function sendTest(c, btn) {
  btn.disabled = true;
  try {
    const r = await page.sendTest(c);
    ui.o.toast(r && r.ok ? (r.opaque ? `Test sent to ${c.name} (a browser cannot read the answer: check the channel).` : `Test sent to ${c.name}.`) : `Test to ${c.name} failed: ${(r && r.error) || 'unknown error'}`, { timeout: 6000 });
  } catch (e) {
    ui.o.toast(`Test to ${c.name} failed: ${e.message}`, { timeout: 6000 });
  } finally { btn.disabled = false; }
}

async function sendNow() {
  try {
    await flushSave();
    const r = await page.sendNow();
    const msg = !r ? 'Nothing happened.' : r.sent ? `Report sent to ${r.sent} ${r.sent === 1 ? 'channel' : 'channels'}` + (r.failed ? `, ${r.failed} failed.` : '.')
      : r.failed ? 'The report could not be sent: ' + ((r.results || []).find(x => x.error) || {}).error
      : r.reason === 'not-due' ? "Today's report was already sent." : r.reason === 'no-new-data' || r.reason === 'empty' ? 'Nothing new to report.'
      : r.reason === 'no-channels' ? 'No channel this device can send to.' : r.reason === 'locked' ? 'A report is being sent right now.' : 'Not sent: ' + (r.error || r.reason);
    ui.o.toast(msg, { timeout: 6000 });
  } catch (e) { ui.o.toast('Could not send: ' + e.message, { timeout: 6000 }); }
  refreshState().catch(() => {});
}

async function preview() {
  try {
    ui.preview = await page.preview(ui.settings, { catalog: ui.o.catalog || [], descriptions: ui.o.descriptions });
  } catch (e) {
    ui.o.toast('Preview failed: ' + e.message);
    return;
  }
  render();
  document.getElementById('nfPreview')?.focus();
}

async function exportConfig() {
  await flushSave();
  const { text, missing } = await page.exportConfig(ui.exportSecrets || {});
  const errBox = document.getElementById('nfExportErr');
  if (missing.length) {
    errBox.replaceChildren(...missing.map(m => h('p', { text: m.name + ': fill in ' + m.fields.map(k => LABELS[k] || k).join(', ') + '.' })));
    return;
  }
  errBox.replaceChildren();
  ui.exportSecrets = {}; // typed for this export only
  try {
    await navigator.clipboard.writeText(text);
    ui.o.toast('Copied. Paste it into the SG_NOTIFY_CONFIG repository secret.', { timeout: 6000 });
  } catch {
    const ta = h('textarea', { class: 'nf-pre', readonly: true, rows: '6', 'aria-label': 'Settings for GitHub Actions' }, text);
    ui.view.querySelector('.nf-warn')?.after(ta);
    ta.select();
    ui.o.toast('Select the text and copy it (it contains secrets).', { timeout: 6000 });
  }
}
