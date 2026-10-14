// The notifications engine (site/js/notify/core.js): term matching, the digest, each platform's formatter and
// request, and the scheduling rules (isDue, retry once, never twice a day, catch-up), including across DST changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../js/notify/core.js';
import { PUBLIC_URL, topicLink } from '../js/config.js';
import { DATA_FORMAT } from '../js/data.js';
import { rec } from './helpers.mjs';

const N = globalThis.SgNotify;
const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://sg.example/app/';
const ctx = { publicUrl: BASE };

const ev = (at, id, event, from = null, to = null, fields) => ({ at, id, event, from, to, ...(fields ? { fields } : {}) });
const settings = over => ({ enabled: true, triggers: { keywords: ['#UAS'], profiles: [], ...over } });

// ---------------------------------------------------------------------------------------------------------------------
// shared constants
// ---------------------------------------------------------------------------------------------------------------------

test('PUBLIC_URL, topicLink and DATA_FORMAT match the page modules', () => {
  assert.equal(N.PUBLIC_URL, PUBLIC_URL, 'scripts/site-url.sh rewrites both');
  assert.equal(N.DATA_FORMAT, DATA_FORMAT);
  for (const id of ['dsip:A26B-T014', 'grants:a b/c', 'sbirgov:13020']) assert.equal(N.topicLink(BASE, id), topicLink(BASE, id));
});

test('core.js is a classic script: no import or export statements', async () => {
  const src = (await import('node:fs')).readFileSync(path.join(here, '..', 'js', 'notify', 'core.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
});

// ---------------------------------------------------------------------------------------------------------------------
// term matching
// ---------------------------------------------------------------------------------------------------------------------

test('terms: whole words and phrases, case-insensitive, hyphen ≈ space, leading # stripped', () => {
  const t = N.normalizeText('Counter-UAS drone detection for small UAVs; persuasive audiology.');
  assert.deepEqual(N.findTerms(t, ['#UAS', 'counter uas', '#Counter-UAS', 'drone detection', 'uav', 'uavs']), ['#UAS', 'counter uas', '#Counter-UAS', 'drone detection', 'uavs']);
  assert.deepEqual(N.findTerms(N.normalizeText('A persuasive essay'), ['uas', '#uas']), [], 'no "uas" inside "persuasive"');
  assert.deepEqual(N.findTerms(N.normalizeText('audiology'), ['audio']), []);
  assert.deepEqual(N.findTerms(N.normalizeText('c-uas'), ['c uas', 'C-UAS']), ['c uas', 'C-UAS']);
  assert.deepEqual(N.findTerms(t, ['#', '', '   ', null]), [], 'empty terms never match');
  assert.deepEqual(N.findTerms(N.normalizeText('a (b) c.d'), ['(b)', 'c.d']), ['(b)', 'c.d'], 'regex characters are literal');
  assert.equal(N.cleanTerm('  ##Counter-UAS '), 'counter-uas');
  assert.deepEqual(N.parseTerms('#Lidar, point cloud\nLIDAR;; '), ['lidar', 'point cloud']);
});

test('recordText covers title, summary, description, keywords, technology areas and numbers', () => {
  const t = N.recordText(rec({ title: 'T', summary: 'S', description: 'D', keywords: ['kw one'], technology_areas: ['Area'], topic_number: 'A26-1' }));
  for (const w of ['t', 's', 'd', 'kw one', 'area', 'a26 1']) assert.ok(t.includes(' ' + w + ' '), w);
  assert.ok(N.recordText(rec({ title: 'X' }), 'from index').includes('from index'));
});

// ---------------------------------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------------------------------

const RECORDS = [
  rec({ id: 'dsip:A1', title: 'Small UAS swarms', status: 'open', close_date: '2026-11-01', alt_ids: ['sbirgov:old1'] }),
  rec({ id: 'dsip:A2', title: 'Acoustic arrays', status: 'pre_release', close_date: '2026-10-20', keywords: ['uas'] }),
  rec({ id: 'grants:3', title: 'Battery recycling', status: 'open', close_date: '2026-12-01' }),
  rec({ id: 'nsf:4', title: 'Drone delivery', status: 'open', close_date: null, summary: 'drones' })
];

test('digest: null when nothing matches or nothing happened', () => {
  assert.equal(N.buildDigest({ records: RECORDS, events: [], settings: settings() }), null);
  assert.equal(N.buildDigest({ records: RECORDS, events: [ev('2026-10-09T06:00:00Z', 'grants:3', 'new', null, 'open')], settings: settings() }), null);
  assert.equal(N.buildDigest({ records: RECORDS, events: [ev('2026-10-09T06:00:00Z', 'dsip:A1', 'new', null, 'open')], settings: settings({ keywords: [] }) }), null, 'no terms: no matches');
});

test('digest: sections, priority starred > new > updated, one appearance per topic, alias resolution', () => {
  const events = [
    ev('2026-10-09T06:00:00Z', 'dsip:A1', 'new', null, 'open'),
    ev('2026-10-09T06:00:00Z', 'dsip:A2', 'updated', 'h1', 'h2', ['description']),
    ev('2026-10-10T06:00:00Z', 'dsip:A2', 'status', 'pre_release', 'open'),
    ev('2026-10-10T06:00:00Z', 'sbirgov:old1', 'updated', 'x', 'y', ['keywords']), // A1 under its old id
    ev('2026-10-10T06:00:00Z', 'grants:3', 'missing', 'open', null),
    ev('2026-10-10T06:00:00Z', 'nobody:9', 'new', null, 'open')
  ];
  const d = N.buildDigest({ records: RECORDS, events, settings: settings(), watchlist: ['grants:3', 'sbirgov:old1'] });
  assert.deepEqual(d.sections.map(s => s.kind), ['starred', 'updated']);
  assert.deepEqual(d.sections[1].items.map(i => i.id), ['dsip:A2'], 'A2 matches by its keywords');
  const starred = d.sections[0].items;
  assert.deepEqual(starred.map(i => i.id), ['dsip:A1', 'grants:3'], 'the old id in the watchlist and the event resolves to A1');
  assert.equal(starred[0].event, 'updated');
  assert.deepEqual(starred[0].fields, ['keywords']);
  assert.deepEqual(starred[0].matched, ['#UAS']);
  assert.equal(starred[1].event, 'missing');
  assert.equal(starred[1].from, 'open');

  const d2 = N.buildDigest({ records: RECORDS, events, settings: settings() });
  assert.deepEqual(d2.sections.map(s => [s.kind, s.items.map(i => i.id)]), [['new', ['dsip:A1']], ['updated', ['dsip:A2']]]);
  const upd = d2.sections[1].items[0];
  assert.deepEqual([upd.event, upd.from, upd.to, upd.fields], ['status', 'pre_release', 'open', ['description']]);
  assert.deepEqual(d2.counts, { starred: 0, new: 1, updated: 1, total: 2 });
});

test('digest: each trigger can be switched off', () => {
  const events = [ev('2026-10-09T06:00:00Z', 'dsip:A1', 'new', null, 'open'), ev('2026-10-09T06:00:00Z', 'dsip:A2', 'status', 'pre_release', 'open'),
    ev('2026-10-09T06:00:00Z', 'grants:3', 'status', 'open', 'closed')];
  const kinds = s => (N.buildDigest({ records: RECORDS, events, settings: s, watchlist: ['grants:3'] }) || { sections: [] }).sections.map(x => x.kind);
  assert.deepEqual(kinds(settings()), ['starred', 'new', 'updated']);
  assert.deepEqual(kinds(settings({ starred: false })), ['new', 'updated']);
  assert.deepEqual(kinds(settings({ newMatches: false })), ['starred', 'updated']);
  assert.deepEqual(kinds(settings({ updatedMatches: false })), ['starred', 'new']);
  assert.deepEqual(kinds(settings({ starred: false, newMatches: false, updatedMatches: false })), []);
});

test('digest: the window is since < at <= until', () => {
  const events = [ev('2026-10-08T06:00:00Z', 'dsip:A1', 'new', null, 'open'), ev('2026-10-09T06:00:00Z', 'dsip:A2', 'status', 'pre_release', 'open'),
    ev('2026-10-10T06:00:00Z', 'nsf:4', 'new', null, 'open')];
  const ids = (since, until) => N.buildDigest({ records: RECORDS, events, since, until, settings: settings({ profiles: ['uas'] }) }).sections.flatMap(s => s.items.map(i => i.id));
  assert.deepEqual(ids('2026-10-08T06:00:00Z', '2026-10-09T06:00:00Z'), ['dsip:A2']);
  assert.deepEqual(ids(null, '2026-10-08T06:00:00Z'), ['dsip:A1']);
  assert.deepEqual(ids('2026-10-09T06:00:00Z', null), ['nsf:4'], 'profiles add their terms (drone, drones)');
});

test('digest: at most 15 items per section, sorted by close date, with the rest counted', () => {
  const records = Array.from({ length: 40 }, (_, i) => rec({ id: 'r:' + i, title: 'UAS ' + i, close_date: `2026-11-${String(30 - (i % 30)).padStart(2, '0')}` }));
  const events = records.map(r => ev('2026-10-09T06:00:00Z', r.id, 'new', null, 'open'));
  const d = N.buildDigest({ records, events, settings: settings() });
  const s = d.sections[0];
  assert.equal(s.total, 40);
  assert.equal(s.items.length, 15);
  assert.equal(s.more, 25);
  const dates = s.items.map(i => i.close_date);
  assert.deepEqual(dates, [...dates].sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------------------------------------------------

function bigDigest(n = 15, title = i => `UAS topic <${i}> & "friends" *bold* [x](y) @everyone ` + 'long words '.repeat(30)) {
  const records = Array.from({ length: 60 }, (_, i) => rec({ id: 'r:' + i, title: title(i), agency: 'DOD', sub_agency: 'ARMY', topic_number: 'T-' + i,
    close_date: '2026-11-01' }));
  const events = records.flatMap((r, i) => i < 20 ? [ev('2026-10-09T06:00:00Z', r.id, 'status', 'pre_release', 'open')]
    : i < 40 ? [ev('2026-10-09T06:00:00Z', r.id, 'new', null, 'open')] : [ev('2026-10-09T06:00:00Z', r.id, 'updated', 'a', 'b', ['description', 'close_date'])]);
  return N.buildDigest({ records, events, settings: settings(), watchlist: records.slice(0, 20).map(r => r.id), until: '2026-10-09T06:00:00Z' });
}

test('summary: counts and the first titles, short', () => {
  const d = bigDigest();
  const s = N.format.summary(d);
  assert.match(s, /^20 starred updates, 20 new matches, 20 updated matches: /);
  assert.ok(s.length <= 240);
  assert.equal(N.format.summary(null), '');
});

test('slack: mrkdwn escaped, at most 50 blocks, 3000 characters per section, link at the end', () => {
  const p = N.format.slack(bigDigest(), ctx);
  assert.ok(p.blocks.length <= 50);
  for (const b of p.blocks) {
    if (b.text) assert.ok(b.text.text.length <= 3000, b.text.text.length);
    for (const e of b.elements || []) assert.ok(e.text.length <= 3000);
  }
  const all = JSON.stringify(p.blocks);
  assert.ok(all.includes('UAS topic &lt;0&gt; &amp; '), 'escaped');
  assert.ok(!/<0>/.test(all));
  assert.ok(all.includes(`<${BASE}#/s/r:0|`), 'topic links');
  assert.ok(all.includes('and 5 more'), '20 - 15');
  assert.match(p.text, /SAM's Garage: 20 starred updates/);
  assert.ok(p.text.endsWith(BASE));
  const last = p.blocks[p.blocks.length - 1];
  assert.ok(last.elements[0].text.includes(`<${BASE}|Open SAM's Garage>`));
  // a report that needs more than 50 blocks is cut with a note
  const huge = { ...bigDigest(), sections: Array.from({ length: 30 }, () => bigDigest().sections[0]) };
  const ph = N.format.slack(huge, ctx);
  assert.equal(ph.blocks.length, 50);
  assert.ok(JSON.stringify(ph.blocks).includes('longer than Slack shows'));
});

test('discord: at most 10 embeds, 4096 per description, 6000 in all, mentions off, avatar and link', () => {
  const p = N.format.discord(bigDigest(), ctx);
  assert.equal(p.username, "SAM's Garage");
  assert.equal(p.avatar_url, BASE + 'icons/icon-192.png');
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  assert.ok(p.embeds.length >= 3 && p.embeds.length <= 10);
  let total = 0;
  for (const e of p.embeds) {
    assert.ok(e.description.length <= 4096);
    assert.ok(!e.title || e.title.length <= 256);
    total += (e.title || '').length + e.description.length + (e.footer ? e.footer.text.length : 0);
  }
  assert.ok(total <= 6000, 'total ' + total);
  const all = p.embeds.map(e => e.description).join('\n');
  assert.ok(all.includes('\\<0\\> & "friends" \\*bold\\* \\[x\\]\\(y\\) @​everyone'), 'markdown escaped, mentions defused');
  assert.match(all, /…and \d+ more in \[SAM's Garage\]\(https:\/\/sg\.example\/app\/#\/watch\)/);
  assert.deepEqual(p.embeds.filter(e => e.title).map(e => e.title), ['Starred updates (20)', 'New matches (20)', 'Updated matches (20)']);
  assert.ok(p.embeds[p.embeds.length - 1].footer.text.startsWith("SAM's Garage"));
  assert.ok(p.content.length <= 2000);
  // a short report keeps every item
  const small = N.format.discord(N.sampleDigest('2026-10-09T06:00:00Z'), ctx);
  assert.equal(small.embeds.length, 2);
  assert.ok(!small.embeds.some(e => /more in/.test(e.description)));
});

test('teams: an Adaptive Card 1.4 message with links and an open-app action', () => {
  const p = N.format.teams(bigDigest(), ctx);
  assert.equal(p.type, 'message');
  const a = p.attachments[0];
  assert.equal(a.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(a.content.type, 'AdaptiveCard');
  assert.equal(a.content.version, '1.4');
  assert.equal(a.content.actions[0].url, BASE);
  const texts = a.content.body.map(b => b.text);
  assert.ok(texts.some(t => t.startsWith('[UAS topic <0> & "friends" bold (x)(y) @everyone') && t.includes(`](${BASE}#/s/r:0)`)), 'brackets in titles cannot break the link');
  assert.ok(texts.includes('Starred updates (20)'));
  assert.ok(JSON.stringify(p).length < 28000, 'under the Teams message size limit');
});

test('whatsapp (CallMeBot): plain text, at most 1500 characters, ends with the app link', () => {
  const t = N.format.whatsapp(bigDigest(), ctx);
  assert.ok(t.length <= 1500, t.length);
  assert.ok(t.endsWith(`Open SAM's Garage: ${BASE}`));
  assert.match(t, /^\*SAM's Garage: 20 starred updates/);
  assert.match(t, /…and \d+ more/);
  const s = N.format.whatsapp(N.sampleDigest(), ctx);
  assert.ok(s.includes(BASE) && s.length < 800);
});

test('whatsapp (Cloud API): one line, at most 1000 characters, ends with the link', () => {
  const t = N.format.whatsappTemplate(bigDigest(), ctx);
  assert.ok(t.length <= 1000, t.length);
  assert.doesNotMatch(t, /[\n\t]| {4}/, 'template parameters allow no new lines, tabs or 4 spaces');
  assert.ok(t.endsWith('More: ' + BASE));
  assert.match(t, /^20 starred updates, 20 new matches, 20 updated matches\./);
});

// ---------------------------------------------------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------------------------------------------------

const CH = {
  slack: { id: 's', type: 'slack', name: 'Team', url: 'https://hooks.slack.com/services/T0/B0/secret1' },
  discord: { id: 'd', type: 'discord', url: 'https://discord.com/api/webhooks/1/secret2' },
  teams: { id: 't', type: 'teams', url: 'https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=secret3' },
  callmebot: { id: 'w', type: 'whatsapp', provider: 'callmebot', phone: '+1 555 123 4567', apikey: '987654' },
  cloud: { id: 'c', type: 'whatsapp', provider: 'cloud', phoneNumberId: '1234567890', accessToken: 'EAAG' + 'x'.repeat(40), to: '+15551234567', template: 'sg_daily', language: 'en_US' }
};

test('buildRequest: Slack is a form POST (payload=<json>) a browser can send without CORS', () => {
  const d = N.sampleDigest('2026-10-09T06:00:00Z');
  const r = N.buildRequest(CH.slack, d, ctx);
  assert.equal(r.url, CH.slack.url);
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.browserMode, 'no-cors');
  assert.ok(r.body.startsWith('payload='));
  assert.deepEqual(JSON.parse(decodeURIComponent(r.body.slice(8))), N.format.slack(d, ctx));
});

test('buildRequest: Discord JSON (cors), Teams JSON (unsupported in a browser)', () => {
  const d = N.sampleDigest();
  const r = N.buildRequest(CH.discord, d, ctx);
  assert.deepEqual([r.url, r.method, r.headers['Content-Type'], r.browserMode], [CH.discord.url, 'POST', 'application/json', 'cors']);
  assert.deepEqual(JSON.parse(r.body), N.format.discord(d, ctx));
  const t = N.buildRequest(CH.teams, d, ctx);
  assert.deepEqual([t.url, t.method, t.browserMode], [CH.teams.url, 'POST', 'unsupported']);
  assert.equal(JSON.parse(t.body).attachments[0].content.version, '1.4');
});

test('buildRequest: CallMeBot GET with phone, text and apikey; base overridable', () => {
  const d = N.sampleDigest();
  const r = N.buildRequest(CH.callmebot, d, ctx);
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, 'https://api.callmebot.com/whatsapp.php');
  assert.equal(u.searchParams.get('phone'), '+15551234567');
  assert.equal(u.searchParams.get('apikey'), '987654');
  assert.equal(u.searchParams.get('text'), N.format.whatsapp(d, ctx));
  assert.deepEqual([r.method, r.body, r.browserMode], ['GET', null, 'no-cors']);
  assert.ok(N.buildRequest(CH.callmebot, d, { callmebotUrl: 'http://127.0.0.1:9/cmb' }).url.startsWith('http://127.0.0.1:9/cmb?phone='));
});

test('buildRequest: WhatsApp Cloud API template message with one body parameter', () => {
  const d = N.sampleDigest();
  const r = N.buildRequest(CH.cloud, d, ctx);
  assert.equal(r.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(r.headers.Authorization, 'Bearer ' + CH.cloud.accessToken);
  assert.equal(r.browserMode, 'unsupported');
  const b = JSON.parse(r.body);
  assert.deepEqual([b.messaging_product, b.to, b.type, b.template.name, b.template.language.code], ['whatsapp', '15551234567', 'template', 'sg_daily', 'en_US']);
  assert.equal(b.template.components.length, 1);
  assert.deepEqual(b.template.components[0].parameters, [{ type: 'text', text: N.format.whatsappTemplate(d, ctx) }]);
  assert.equal(N.buildRequest(CH.cloud, d, { graphBase: 'http://127.0.0.1:9/graph' }).url, 'http://127.0.0.1:9/graph/1234567890/messages');
});

test('interpretResponse: 2xx is sent; errors and CallMeBot error pages are not; opaque is assumed sent', () => {
  assert.equal(N.interpretResponse(CH.discord, { status: 204 }).ok, true);
  assert.equal(N.interpretResponse(CH.teams, { status: 202 }).ok, true);
  assert.match(N.interpretResponse(CH.slack, { status: 403, body: 'invalid_token' }).error, /HTTP 403: invalid_token/);
  assert.equal(N.interpretResponse(CH.callmebot, { status: 200, body: '<p>Message queued. You will receive it in a few seconds.</p>' }).ok, true);
  assert.equal(N.interpretResponse(CH.callmebot, { status: 200, body: '<b>APIKey is invalid.</b>' }).ok, false);
  assert.equal(N.interpretResponse(CH.slack, { opaque: true }).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// settings, validation, secrets
// ---------------------------------------------------------------------------------------------------------------------

test('normalizeSettings: the one shape, defaults for anything malformed', () => {
  const d = N.normalizeSettings(null);
  assert.deepEqual(d, N.defaultSettings());
  assert.equal(d.enabled, false, 'opt-in');
  const s = N.normalizeSettings({ enabled: true, time: '25:00', channels: [{ type: 'slack', url: ' https://hooks.slack.com/x ', extra: 1 }, { type: 'fax' }, { id: 'a', type: 'discord' }, { id: 'a', type: 'discord' }],
    triggers: { keywords: ['#UAS', 'uas', ' Counter UAS ', '#counter-uas', '', 5], profiles: ['uas', 'BAD ID'], starred: false } });
  assert.equal(s.time, '08:00');
  assert.deepEqual(s.channels.map(c => [c.id, c.type, c.name]), [['c0', 'slack', 'Slack'], ['a', 'discord', 'Discord'], ['a-3', 'discord', 'Discord']]);
  assert.equal(s.channels[0].url, 'https://hooks.slack.com/x');
  assert.ok(!('extra' in s.channels[0]));
  assert.deepEqual(s.triggers.keywords, ['#UAS', 'Counter UAS', '5'], 'deduplicated by matching form');
  assert.deepEqual(s.triggers.profiles, ['uas']);
  assert.equal(s.triggers.starred, false);
  assert.equal(s.triggers.newMatches, true);
});

test('validateChannel: https webhooks, retired O365 connectors refused, WhatsApp fields checked', () => {
  for (const c of Object.values(CH)) assert.ok(N.validateChannel(c).ok, JSON.stringify(N.validateChannel(c)));
  assert.equal(N.validateChannel({ type: 'slack', url: 'http://hooks.slack.com/x' }).ok, false);
  assert.equal(N.validateChannel({ type: 'slack', url: 'http://127.0.0.1:8080/hook' }).ok, true, 'local testing');
  assert.equal(N.validateChannel({ type: 'slack', url: 'nope' }).ok, false);
  assert.ok(N.validateChannel({ type: 'slack', url: 'https://example.com/x' }).warnings.length);
  assert.equal(N.validateChannel({ type: 'teams', url: 'https://contoso.webhook.office.com/webhookb2/x' }).ok, false);
  assert.equal(N.validateChannel({ ...CH.callmebot, phone: 'abc' }).ok, false);
  assert.deepEqual(N.validateChannel({ ...CH.cloud, template: 'Bad Name', language: 'english' }).errors.map(e => e.field), ['template', 'language']);
});

test('secrets: every secret value is found and redacted from requests', () => {
  const s = { channels: Object.values(CH) };
  const secrets = N.secretValues(s);
  for (const v of [CH.slack.url, CH.discord.url, CH.teams.url, '987654', CH.cloud.accessToken, '1234567890', '+15551234567']) assert.ok(secrets.includes(v), v);
  const d = N.sampleDigest();
  for (const c of Object.values(CH)) {
    const r = N.redactRequest(N.buildRequest(c, d, ctx), s);
    const text = JSON.stringify(r);
    for (const v of secrets) assert.ok(!text.includes(v), `${c.type}: ${v}`);
  }
  assert.equal(N.redactRequest(N.buildRequest(CH.cloud, d, ctx), CH.cloud).headers.Authorization, '[redacted]');
});

// ---------------------------------------------------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------------------------------------------------

const at = (date, hm, tz = 0) => Date.parse(`${date}T${hm}:00Z`) - tz * 60000; // a local wall time in a fixed offset
const opt = { time: '08:00', tzOffset: -240 };

test('localDate and prevDate are calendar arithmetic', () => {
  assert.equal(N.localDate(at('2026-10-09', '23:30', -240), -240), '2026-10-09');
  assert.equal(N.localDate(at('2026-10-09', '23:30', -240), 0), '2026-10-10');
  assert.equal(N.prevDate('2026-03-01'), '2026-02-28');
  assert.equal(N.prevDate('2026-01-01'), '2025-12-31');
});

test('isDue: before/after the time, already sent today, catch-up after missed days', () => {
  assert.equal(N.isDue(at('2026-10-09', '07:59', -240), opt, '2026-10-08'), false, 'before the time, sent yesterday');
  assert.equal(N.isDue(at('2026-10-09', '08:00', -240), opt, '2026-10-08'), true, 'at the time');
  assert.equal(N.isDue(at('2026-10-09', '21:00', -240), opt, '2026-10-09'), false, 'sent today');
  assert.equal(N.isDue(at('2026-10-09', '06:00', -240), opt, '2026-10-06'), true, 'missed days: caught up at the next check');
  assert.equal(N.isDue(at('2026-10-09', '06:00', -240), opt, null), true, 'never sent');
  // a channel state: yesterday's slot was checked (nothing new): wait for today's time
  assert.equal(N.isDue(at('2026-10-09', '06:00', -240), opt, { date: '2026-10-05', slot: '2026-10-08' }), false);
  // today's slot checked without sending: keep watching today (new data may still come)
  assert.equal(N.isDue(at('2026-10-09', '09:00', -240), opt, { date: '2026-10-05', slot: '2026-10-09' }), true);
});

test('isDue across DST changes (America/New_York, local time zone of the process)', () => {
  const script = `
    await import(${JSON.stringify(new URL('../js/notify/core.js', import.meta.url).href)});
    const N = globalThis.SgNotify, o = { time: '08:00' };
    const out = {
      tz: new Date('2026-07-01T12:00:00Z').getTimezoneOffset(),
      // spring forward: 2026-03-08 02:00 EST -> 03:00 EDT. 07:59 EDT = 11:59Z, 08:00 EDT = 12:00Z
      springBefore: N.isDue(Date.parse('2026-03-08T11:59:00Z'), o, '2026-03-07'),
      springAt: N.isDue(Date.parse('2026-03-08T12:00:00Z'), o, '2026-03-07'),
      springDate: N.localDate(Date.parse('2026-03-08T05:30:00Z')), // 00:30 EST
      // fall back: 2026-11-01 02:00 EDT -> 01:00 EST. 08:00 EST = 13:00Z
      fallBefore: N.isDue(Date.parse('2026-11-01T12:59:00Z'), o, '2026-10-31'),
      fallAt: N.isDue(Date.parse('2026-11-01T13:00:00Z'), o, '2026-10-31'),
      fallDate: N.localDate(Date.parse('2026-11-01T05:30:00Z')),
      sentToday: N.isDue(Date.parse('2026-11-01T23:00:00Z'), o, '2026-11-01')
    };
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.tz, 240, 'the child runs in New York time');
  assert.deepEqual(o, { tz: 240, springBefore: false, springAt: true, springDate: '2026-03-08', fallBefore: false, fallAt: true, fallDate: '2026-11-01', sentToday: false });
});

// ---------------------------------------------------------------------------------------------------------------------
// runDue: the shared run loop
// ---------------------------------------------------------------------------------------------------------------------

function harness({ fail = () => false, meta = { last_run: '2026-10-09T06:15:00Z' } } = {}) {
  const sent = [];
  const h = {
    sent, meta, loads: 0,
    settings: { enabled: true, time: '08:00', triggers: { keywords: ['uas'] }, channels: [CH.discord, CH.slack, CH.teams] },
    events: [ev('2026-10-09T06:15:00Z', 'dsip:A1', 'new', null, 'open')],
    run: (state, now, extra = {}) => N.runDue({
      settings: h.settings, state, now, tzOffset: -240, ctx, runtime: 'desktop',
      loadMeta: async () => h.meta,
      loadData: async () => { h.loads++; return { records: RECORDS, events: h.events }; },
      send: async (req, ch) => { sent.push(ch.id); return fail(ch) ? { ok: false, error: 'HTTP 500' } : { ok: true, status: 204 }; },
      ...extra
    })
  };
  return h;
}

test('runDue: sends every due channel once, never twice on one date', async () => {
  const h = harness();
  const r1 = await h.run({}, at('2026-10-09', '08:05', -240));
  assert.equal(r1.reason, 'sent');
  assert.deepEqual(h.sent.sort(), ['d', 's', 't']);
  assert.equal(r1.state.channels.d.date, '2026-10-09');
  assert.equal(r1.state.channels.d.through, '2026-10-09T06:15:00Z');
  assert.equal(r1.state.lastSent.date, '2026-10-09');
  assert.equal(r1.state.lastReport.digest.counts.new, 1);
  h.meta = { last_run: '2026-10-09T18:00:00Z' };
  h.events.push(ev('2026-10-09T18:00:00Z', 'nsf:4', 'new', null, 'open'));
  h.settings.triggers.profiles = ['uas'];
  const r2 = await h.run(r1.state, at('2026-10-09', '21:00', -240));
  assert.equal(r2.reason, 'not-due');
  assert.equal(h.sent.length, 3, 'nothing more today');
  const r3 = await h.run(r2.state, at('2026-10-10', '08:00', -240));
  assert.equal(r3.sent, 3);
  assert.deepEqual(r3.digest.sections[0].items.map(i => i.id), ['nsf:4'], "the next day's report covers what came since the last one");
});

test('runDue: the browser only sends what a browser can (Teams is left to the desktop app or Actions)', async () => {
  const h = harness();
  await h.run({}, at('2026-10-09', '08:05', -240), { runtime: 'browser' });
  assert.deepEqual(h.sent.sort(), ['d', 's']);
});

test('runDue: a failed channel is retried once at the next check that day, then waits for tomorrow', async () => {
  let failing = true;
  const h = harness({ fail: ch => ch.id === 'd' && failing });
  const r1 = await h.run({}, at('2026-10-09', '08:00', -240));
  assert.deepEqual([r1.sent, r1.failed], [2, 1]);
  assert.equal(r1.state.channels.d.tries, 1);
  assert.equal(r1.state.channels.d.through, '2026-10-08T06:15:00Z', 'the window does not move on a failure (a first report keeps its start)');
  const r2 = await h.run(r1.state, at('2026-10-09', '08:15', -240));
  assert.deepEqual(h.sent.slice(3), ['d'], 'only the failed channel, once');
  assert.equal(r2.state.channels.d.tries, 2);
  const r3 = await h.run(r2.state, at('2026-10-09', '08:30', -240));
  assert.equal(r3.reason, 'not-due');
  assert.equal(h.sent.length, 4);
  failing = false;
  const r4 = await h.run(r3.state, at('2026-10-10', '08:00', -240));
  assert.deepEqual(r4.results.find(x => x.id === 'd').status, 'sent');
  assert.equal(r4.state.channels.d.tries, 0);
});

test('runDue: nothing new keeps watching today without loading the data; an empty report sends nothing', async () => {
  const h = harness();
  const r1 = await h.run({ channels: { d: { through: '2026-10-09T06:15:00Z' }, s: { through: '2026-10-09T06:15:00Z' }, t: { through: '2026-10-09T06:15:00Z' } } }, at('2026-10-09', '08:00', -240));
  assert.equal(r1.reason, 'no-new-data');
  assert.equal(h.loads, 0, 'only meta.json was read');
  assert.equal(r1.state.channels.d.slot, '2026-10-09');
  h.meta = { last_run: '2026-10-09T13:00:00Z' };
  h.events = [ev('2026-10-09T13:00:00Z', 'grants:3', 'new', null, 'open')]; // matches nothing
  const r2 = await h.run(r1.state, at('2026-10-09', '09:15', -240));
  assert.equal(r2.reason, 'empty');
  assert.equal(h.sent.length, 0);
  assert.equal(r2.state.channels.d.through, '2026-10-09T13:00:00Z', 'the window moves on');
  assert.equal(r2.state.channels.d.date, undefined, 'not counted as a report');
});

test('runDue: paused, no channels, Send now, and the device notification', async () => {
  const h = harness();
  h.settings.enabled = false;
  assert.equal((await h.run({}, at('2026-10-09', '09:00', -240))).reason, 'paused');
  const now = await h.run({}, at('2026-10-09', '05:00', -240), { mode: 'now' });
  assert.equal(now.sent, 3, 'Send now ignores the time and the pause');
  assert.equal((await h.run(now.state, at('2026-10-09', '05:01', -240), { mode: 'now' })).reason, 'not-due', '...but not twice a day');
  h.settings = { enabled: true, channels: [], triggers: { keywords: ['uas'] } };
  assert.equal((await h.run({}, at('2026-10-09', '09:00', -240))).reason, 'no-channels');
  const shown = [];
  const r = await h.run({}, at('2026-10-09', '09:00', -240), { local: async d => { shown.push(N.format.summary(d)); return { ok: true }; } });
  assert.equal(r.sent, 1);
  assert.match(shown[0], /^1 new match: Small UAS swarms/);
  assert.equal(r.state.channels.__local.date, '2026-10-09');
  h.settings.background = { osNotification: false };
  assert.equal((await h.run({}, at('2026-10-09', '09:00', -240), { local: async () => ({ ok: true }) })).reason, 'no-channels');
});

test('runDue: the state is stored after each channel, so a run cut short never resends', async () => {
  const h = harness();
  const stored = [];
  let hang;
  const cut = h.run({}, at('2026-10-09', '08:05', -240), {
    persist: st => { stored.push(structuredClone(st)); },
    send: async (req, ch) => { h.sent.push(ch.id); if (ch.id === 's') return new Promise(r => { hang = r; }); return { ok: true, status: 204 }; } // the process dies here
  });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(h.sent, ['d', 's']);
  const saved = stored[stored.length - 1];
  assert.equal(saved.channels.d.date, '2026-10-09', 'channel 1 was stored as sent before channel 2 started');
  assert.equal(saved.lastSent.date, '2026-10-09');
  const again = await h.run(saved, at('2026-10-09', '08:20', -240));
  assert.deepEqual(h.sent.slice(2).sort(), ['s', 't'], 'the re-run sends the rest, not channel 1 again');
  assert.equal(again.sent, 2);
  hang({ ok: true });
  await cut;
});

test('runDue: beforeSend runs before every send; false stops the run', async () => {
  const h = harness();
  let calls = 0;
  const r = await h.run({}, at('2026-10-09', '08:05', -240), { beforeSend: async () => ++calls < 2 });
  assert.equal(calls, 2);
  assert.equal(h.sent.length, 1, 'only the send before the lock was lost');
  assert.equal(r.reason, 'locked');
  assert.equal(r.results.find(x => x.status === 'skipped').error, 'the lock was lost');
});

test('runDue: errors that quote a secret are redacted before they are stored or returned', async () => {
  const h = harness({ fail: () => false });
  const r = await h.run({}, at('2026-10-09', '08:05', -240), {
    send: async (req, ch) => (ch.id === 'd' ? { ok: false, error: 'POST ' + req.url + ' failed' } : (() => { throw new Error('connect ' + CH.slack.url); })())
  });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(CH.discord.url) && !text.includes(CH.slack.url) && !text.includes('secret'), text);
  assert.equal(r.state.channels.d.error, 'POST [redacted] failed');
  assert.equal(r.state.channels.s.error, 'connect [redacted]');
});

test('runDue: a data error changes nothing, so the next check tries again', async () => {
  const h = harness();
  const r = await h.run({}, at('2026-10-09', '08:00', -240), { loadMeta: async () => { throw new Error('offline'); } });
  assert.equal(r.reason, 'data-error');
  assert.deepEqual(r.state.channels, {});
  assert.equal(h.sent.length, 0);
});

test('scripts/site-url.sh points the report links at the deployed address too', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) return t.skip('no bash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-url-'));
  for (const f of ['index.html', 'js/config.js', 'js/notify/core.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(here, '..', f), path.join(dir, f));
  }
  const r = spawnSync('bash', [path.join(here, '..', '..', 'scripts', 'site-url.sh'), dir, 'https://sg.example.org/'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const core = fs.readFileSync(path.join(dir, 'js/notify/core.js'), 'utf8');
  assert.match(core, /const PUBLIC_URL = 'https:\/\/sg\.example\.org\/';/);
  assert.ok(!core.includes(PUBLIC_URL));
});
