// scripts/notify.mjs end to end: a local HTTP server stands in for Slack, Discord, Teams, CallMeBot and the Graph API.
// Checks the exact requests, that every secret is masked before anything is printed, the empty-config exit, and that
// only the events of this scrape run (at == meta.last_run) are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'notify.mjs');
const RUN = '2026-10-09T06:15:00Z';

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-notify-data-'));
  const recs = [
    { id: 'dsip:A1', title: 'Small UAS swarms', agency: 'DOD', sub_agency: 'ARMY', status: 'open', close_date: '2026-11-01', alt_ids: [], description: 'Counter drone work.' },
    { id: 'dsip:OLD', title: 'Old UAS topic', agency: 'DOD', status: 'open', close_date: '2026-11-02', alt_ids: [] },
    { id: 'grants:2', title: 'Battery recycling', agency: 'DOE', status: 'closed', close_date: '2026-10-01', alt_ids: ['sbirgov:2'] }
  ];
  const events = [
    { at: '2026-10-08T06:15:00Z', id: 'dsip:OLD', event: 'new', from: null, to: 'open' },   // the previous run: not reported
    { at: RUN, id: 'dsip:A1', event: 'new', from: null, to: 'open' },
    { at: RUN, id: 'sbirgov:2', event: 'status', from: 'open', to: 'closed' }
  ];
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ last_run: RUN }));
  fs.writeFileSync(path.join(dir, 'solicitations.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

/** The stand-in platforms: records every request; /discord-fail answers 500. */
async function platforms() {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      reqs.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/discord-fail')) { res.writeHead(500); res.end('nope'); return; }
      if (req.url.startsWith('/cmb')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Message queued.</p>'); return; }
      if (req.url.startsWith('/graph')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"messages":[{"id":"wamid.1"}]}'); return; }
      res.writeHead(req.url.startsWith('/teams') ? 202 : req.url.startsWith('/discord') ? 204 : 200);
      res.end(req.url.startsWith('/slack') ? 'ok' : '');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { reqs, base, close: () => new Promise(r => server.close(r)) };
}

function run(env, args = []) {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('notify.mjs: no config is a notice and exit 0; bad JSON is a warning and exit 0', async () => {
  const dir = dataDir();
  const empty = await run({ SG_NOTIFY_CONFIG: '' }, ['--data', dir]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /^::notice::SG_NOTIFY_CONFIG is not set/m);
  const bad = await run({ SG_NOTIFY_CONFIG: '{"settings": secret-oops' }, ['--data', dir]);
  assert.equal(bad.code, 0);
  assert.match(bad.stdout, /::warning::SG_NOTIFY_CONFIG is not valid JSON/);
  assert.ok(!bad.stdout.includes('secret-oops'), 'the content is never printed');
});

test('notify.mjs: sends this run\'s report to every platform with the exact requests, masking every secret', async () => {
  const p = await platforms();
  try {
    const dir = dataDir();
    const cfg = {
      settings: {
        enabled: true, time: '23:59', triggers: { keywords: ['#UAS'], profiles: [] },
        channels: [
          { id: 's', type: 'slack', name: 'Team', url: p.base + '/slack/T0/B0/slacksecret' },
          { id: 'd', type: 'discord', name: 'Ops', url: p.base + '/discord/1/discordsecret' },
          { id: 't', type: 'teams', name: 'Bids', url: p.base + '/teams/workflows/x?sig=teamssecret' },
          { id: 'w', type: 'whatsapp', provider: 'callmebot', name: 'Me', phone: '+15550001111', apikey: '424242' },
          { id: 'c', type: 'whatsapp', provider: 'cloud', name: 'Biz', phoneNumberId: '99887766', accessToken: 'EAAGtoken' + 'z'.repeat(30), to: '+15550002222', template: 'sg_daily', language: 'en_US' },
          { id: 'x', type: 'discord', name: 'Disabled', enabled: false, url: p.base + '/discord/never' }
        ]
      },
      watchlist: ['sbirgov:2'],
      profiles: []
    };
    const r = await run({
      SG_NOTIFY_CONFIG: JSON.stringify(cfg), SITE_URL: 'https://sg.example/',
      SG_NOTIFY_TEST_CALLMEBOT_URL: p.base + '/cmb', SG_NOTIFY_TEST_GRAPH_BASE: p.base + '/graph/', GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md')
    }, ['--data', dir]);
    assert.equal(r.code, 0, r.stderr);

    // masking: every secret is masked, before any other line
    const lines = r.stdout.trim().split('\n');
    const firstOther = lines.findIndex(l => !l.startsWith('::add-mask::'));
    const masked = lines.slice(0, firstOther).map(l => l.slice('::add-mask::'.length));
    const secrets = [cfg.settings.channels[0].url, cfg.settings.channels[1].url, cfg.settings.channels[2].url, '424242', '+15550001111', '99887766', cfg.settings.channels[4].accessToken, '+15550002222'];
    for (const s of secrets) assert.ok(masked.includes(s), 'masked: ' + s);
    for (const l of lines.slice(firstOther)) for (const s of secrets) assert.ok(!l.includes(s), `printed a secret: ${l}`);
    assert.match(r.stdout, /SAM's Garage: 1 starred update, 1 new match/);
    assert.match(r.stdout, /Done: 5 sent, 0 not sent/);
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /### Notifications[\s\S]*Slack "Team": sent/);

    const by = prefix => p.reqs.filter(q => q.url.startsWith(prefix));
    assert.equal(p.reqs.length, 5, 'one request per enabled channel');
    // Slack: form-encoded payload=<json>
    const [slack] = by('/slack/T0/B0/slacksecret');
    assert.equal(slack.method, 'POST');
    assert.equal(slack.headers['content-type'], 'application/x-www-form-urlencoded');
    const sp = JSON.parse(new URLSearchParams(slack.body).get('payload'));
    const stext = JSON.stringify(sp.blocks);
    assert.ok(stext.includes('<https://sg.example/#/s/grants:2|Battery recycling>'));
    assert.ok(stext.includes('Status: Open → Closed'));
    assert.ok(stext.includes('<https://sg.example/#/s/dsip:A1|Small UAS swarms>'));
    assert.ok(!stext.includes('Old UAS topic'), 'only the events of this run');
    // Discord: JSON with username, avatar and embeds
    const [discord] = by('/discord/1/discordsecret');
    assert.equal(discord.headers['content-type'], 'application/json');
    const dp = JSON.parse(discord.body);
    assert.equal(dp.avatar_url, 'https://sg.example/icons/icon-192.png');
    assert.deepEqual(dp.embeds.map(e => e.title), ['Starred updates (1)', 'New matches (1)']);
    // Teams: an Adaptive Card message
    const [teams] = by('/teams/workflows/x');
    assert.equal(teams.url, '/teams/workflows/x?sig=teamssecret');
    const tp = JSON.parse(teams.body);
    assert.equal(tp.attachments[0].content.version, '1.4');
    // CallMeBot: GET with phone, text and apikey
    const [cmb] = by('/cmb');
    assert.equal(cmb.method, 'GET');
    const q = new URL(cmb.url, p.base).searchParams;
    assert.deepEqual([q.get('phone'), q.get('apikey')], ['+15550001111', '424242']);
    assert.ok(q.get('text').endsWith("Open SAM's Garage: https://sg.example/"));
    // Graph API: the template with one body parameter, bearer token
    const [graph] = by('/graph/99887766/messages');
    assert.equal(graph.headers.authorization, 'Bearer ' + cfg.settings.channels[4].accessToken);
    const gp = JSON.parse(graph.body);
    assert.deepEqual([gp.type, gp.to, gp.template.name, gp.template.language.code], ['template', '15550002222', 'sg_daily', 'en_US']);
    assert.equal(gp.template.components[0].parameters.length, 1);
    assert.match(gp.template.components[0].parameters[0].text, /^1 starred update, 1 new match\. .*More: https:\/\/sg\.example\/$/);
  } finally { await p.close(); }
});

test('notify.mjs: a failing channel is a warning (secret-free), nothing to report is a notice, exit 0 either way', async () => {
  const p = await platforms();
  try {
    const dir = dataDir();
    const url = p.base + '/discord-fail/1/failsecret';
    const cfg = { settings: { enabled: true, triggers: { keywords: ['uas'] }, channels: [{ type: 'discord', name: 'Broken', url }] } };
    const r = await run({ SG_NOTIFY_CONFIG: JSON.stringify(cfg) }, ['--data', dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /::warning::Discord "Broken": not sent: HTTP 500: nope/);
    assert.ok(!r.stdout.split('\n').filter(l => !l.startsWith('::add-mask::')).some(l => l.includes('failsecret')));
    const none = await run({ SG_NOTIFY_CONFIG: JSON.stringify({ settings: { ...cfg.settings, triggers: { keywords: ['quantum'], starred: false } } }) }, ['--data', dir]);
    assert.equal(none.code, 0);
    assert.match(none.stdout, /::notice::Nothing to report for the run of 2026-10-09T06:15:00Z \(2 events, none matching\)/);
    const paused = await run({ SG_NOTIFY_CONFIG: JSON.stringify({ settings: { ...cfg.settings, enabled: false } }) }, ['--data', dir]);
    assert.match(paused.stdout, /::notice::Notifications are paused/);
    assert.equal(p.reqs.length, 1);
  } finally { await p.close(); }
});
