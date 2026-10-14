// The desktop app's notification modules, run in plain Node: the settings file (secrets encrypted with an injected
// cipher, as main.js does with safeStorage) and the scheduler (due logic, retry once, never twice a day per channel,
// the data format gate, Send test and the dry run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore } = require('../../electron/notify-core.js');
const { createStore } = require('../../electron/notify-store.js');
const { createScheduler } = require('../../electron/notify-scheduler.js');
const N = loadCore();

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-notify-')), 'notify.json');
/** A reversible stand-in for safeStorage (base64 of the reversed text, tagged). */
const cipher = (available = true) => ({
  available: () => available,
  encrypt: s => Buffer.from('enc:' + [...s].reverse().join('')).toString('base64'),
  decrypt: b => { const t = Buffer.from(b, 'base64').toString(); if (!t.startsWith('enc:')) throw new Error('bad'); return [...t.slice(4)].reverse().join(''); }
});

const DISCORD = 'https://discord.com/api/webhooks/1/secret-token';
const SLACK = 'https://hooks.slack.com/services/T/B/secret-slack';
const CMB = { id: 'w', type: 'whatsapp', provider: 'callmebot', name: 'Phone', phone: '+15551234567', apikey: '987654' };

test('the loader runs core.js in this process (whatever site/package.json says)', () => {
  const saved = globalThis.SgNotify;
  delete globalThis.SgNotify;
  try {
    const M = loadCore();
    assert.equal(typeof M.buildDigest, 'function');
    assert.equal(globalThis.SgNotify, M);
  } finally { globalThis.SgNotify = saved; }
});

test('store: secrets are encrypted on disk and come back in clear (round trip)', () => {
  const file = tmp();
  const s1 = createStore({ file, N, cipher: cipher() });
  s1.saveSettings({ enabled: true, channels: [{ id: 'd', type: 'discord', url: DISCORD }, CMB], triggers: { keywords: ['uas'] } });
  const disk = fs.readFileSync(file, 'utf8');
  for (const secret of [DISCORD, '987654', '+15551234567']) assert.ok(!disk.includes(secret), 'not on disk: ' + secret);
  const doc = JSON.parse(disk);
  assert.equal(doc.plaintextSecrets, false);
  assert.ok(doc.settings.channels[0].url.$enc);
  assert.equal(doc.settings.channels[1].name, 'Phone', 'non-secret fields stay readable');
  const s2 = createStore({ file, N, cipher: cipher() });
  assert.equal(s2.getSettings().channels[0].url, DISCORD);
  assert.equal(s2.getSettings().channels[1].apikey, '987654');
  assert.equal(s2.encryption(), true);
  assert.equal(s2.secretsLost(), false);
});

test('store: without a keychain secrets are stored as they are, flagged; undecryptable ones read as empty', () => {
  const file = tmp();
  const plain = createStore({ file, N, cipher: cipher(false) });
  plain.saveSettings({ channels: [{ id: 'd', type: 'discord', url: DISCORD }] });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.plaintextSecrets, true);
  assert.equal(doc.settings.channels[0].url, DISCORD);
  assert.equal(plain.encryption(), false);
  // encrypted with one keychain, read with another
  createStore({ file, N, cipher: cipher() }).saveSettings({ channels: [{ id: 'd', type: 'discord', url: DISCORD }] });
  const notes = [];
  const other = createStore({ file, N, cipher: { ...cipher(), decrypt: () => { throw new Error('wrong key'); } }, onNote: m => notes.push(m) });
  assert.equal(other.getSettings().channels[0].url, '');
  assert.equal(other.secretsLost(), true);
  assert.equal(notes.length, 1);
});

test('store: a secret that fails to decrypt once is kept and comes back when the keychain answers', () => {
  const file = tmp();
  createStore({ file, N, cipher: cipher() }).saveSettings({ enabled: true, channels: [{ id: 'd', type: 'discord', url: DISCORD }, CMB] });
  let fail = true;
  const flaky = { ...cipher(), decrypt: b => { if (fail) throw new Error('keychain locked'); return cipher().decrypt(b); } };
  const s1 = createStore({ file, N, cipher: flaky });
  assert.equal(s1.getSettings().channels[0].url, '');
  assert.equal(s1.secretsLost(), true);
  // the app keeps working meanwhile: run state, watchlist and even a settings save leave the blob alone
  s1.setState({ channels: { d: { date: '2026-10-09' } } });
  s1.setWatchlist(['x']);
  s1.saveSettings({ ...s1.getSettings(), time: '09:30' });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(disk.settings.channels[0].url.$enc, 'the encrypted blob is still on disk');
  assert.equal(disk.settings.time, '09:30');
  fail = false;
  const s2 = createStore({ file, N, cipher: flaky });
  assert.equal(s2.getSettings().channels[0].url, DISCORD, 'the secret survived');
  assert.equal(s2.getSettings().channels[1].apikey, '987654');
  assert.equal(s2.secretsLost(), false);
});

test('store: writes merge into the file as it is now, and a changed file is read again', () => {
  const file = tmp();
  const a = createStore({ file, N, cipher: cipher() });
  const b = createStore({ file, N, cipher: cipher() });
  a.saveSettings({ enabled: true, channels: [{ id: 'd', type: 'discord', url: DISCORD }] });
  assert.equal(b.getSettings().enabled, true, 'b sees what a wrote');
  b.setState({ channels: { d: { date: '2026-10-09' } } });
  a.setWatchlist(['w1']); // a's copy of the state is older: it must not overwrite b's
  assert.equal(createStore({ file, N, cipher: cipher() }).getState().channels.d.date, '2026-10-09');
  assert.equal(a.getState().channels.d.date, '2026-10-09');
  assert.deepEqual(b.getWatchlist(), ['w1']);
  a.reset();
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(a.getSettings(), N.defaultSettings());
});

test('store: watchlist, profiles and run state persist; a damaged file falls back to defaults', () => {
  const file = tmp();
  const s = createStore({ file, N, cipher: cipher() });
  s.setWatchlist(['b', 'a', 'a', 5]);
  s.setProfiles([{ id: 'u-x', name: 'X', terms: ['lidar'] }, { junk: 1 }]);
  s.setState({ channels: { d: { date: '2026-10-09' } } });
  const again = createStore({ file, N, cipher: cipher() });
  assert.deepEqual(again.getWatchlist(), ['a', 'b']);
  assert.deepEqual(again.getProfiles().map(p => p.id), ['u-x']);
  assert.equal(again.getState().channels.d.date, '2026-10-09');
  fs.writeFileSync(file, '{oops');
  const notes = [];
  assert.deepEqual(createStore({ file, N, cipher: cipher(), onNote: m => notes.push(m) }).getSettings(), N.defaultSettings());
  assert.equal(notes.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------

const LIVE = 'https://live.test/sams-garage/';
const T = (d, hm) => Date.parse(`${d}T${hm}:00`); // local wall time of this process

function world({ format = 1, lastRun = '2026-10-09T06:15:00Z', failing = () => false } = {}) {
  const w = {
    sent: [], fetched: [], lastRun, format,
    events: [{ at: lastRun, id: 'dsip:A1', event: 'new', from: null, to: 'open' }],
    fetch: async (url, init = {}) => {
      w.fetched.push(url);
      if (url.startsWith(LIVE + 'data/')) {
        const rel = url.slice((LIVE + 'data/').length);
        const files = {
          'meta.json': { format: w.format, last_run: w.lastRun, data_version: 'v1' },
          'catalog.json': [{ id: 'dsip:A1', title: 'Small UAS swarms', agency: 'DOD', status: 'open', close_date: '2026-11-01' }],
          'changes.json': { last_run: w.lastRun, events: w.events },
          'search-index.json': [{ id: 'dsip:A1', description: 'drones' }]
        };
        return rel in files ? new Response(JSON.stringify(files[rel])) : new Response('nope', { status: 404 });
      }
      w.sent.push({ url, method: init.method, headers: init.headers, body: init.body });
      return failing(url) ? new Response('boom', { status: 500 }) : new Response(null, { status: 204 });
    }
  };
  return w;
}

function setup(w, { time = '08:00', now } = {}) {
  const store = createStore({ file: tmp(), N, cipher: cipher() });
  store.saveSettings({ enabled: true, time, triggers: { keywords: ['uas'] }, channels: [{ id: 'd', type: 'discord', url: DISCORD }, { id: 's', type: 'slack', url: SLACK }] });
  const clock = { t: now };
  const shown = [];
  const sched = createScheduler({ N, store, fetch: w.fetch, liveBase: LIVE, userAgent: 'SG-test', now: () => clock.t, notify: (title, body) => { shown.push({ title, body }); return true; } });
  return { store, sched, clock, shown };
}

test('scheduler: nothing before the time; at the time every channel once, plus the device notification', async () => {
  const w = world();
  const { sched, clock, store, shown } = setup(w, { now: T('2026-10-09', '07:30') });
  store.setState({ channels: { d: { date: '2026-10-08', slot: '2026-10-08' }, s: { date: '2026-10-08', slot: '2026-10-08' }, __local: { date: '2026-10-08', slot: '2026-10-08' } } });
  assert.equal((await sched.check()).reason, 'not-due');
  assert.equal(w.fetched.length, 0, 'not even meta.json');
  clock.t = T('2026-10-09', '08:00');
  const r = await sched.check();
  assert.equal(r.sent, 3);
  assert.deepEqual(w.sent.map(x => x.url).sort(), [DISCORD, SLACK].sort());
  assert.equal(w.sent.find(x => x.url === DISCORD).headers['User-Agent'], 'SG-test');
  assert.match(JSON.parse(w.sent.find(x => x.url === DISCORD).body).embeds[0].description, /Small UAS swarms/);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "SAM's Garage: 1 new match");
  assert.equal(store.getState().channels.d.date, '2026-10-09');
  // the rest of the day: no second report, even with new data
  w.lastRun = '2026-10-09T18:00:00Z';
  w.events.push({ at: w.lastRun, id: 'dsip:A1', event: 'status', from: 'open', to: 'closed' });
  clock.t = T('2026-10-09', '22:00');
  assert.equal((await sched.check()).reason, 'not-due');
  assert.equal(w.sent.length, 2);
});

test('scheduler: a failed channel is retried once at the next check that day, never twice', async () => {
  let down = true;
  const w = world({ failing: url => url === SLACK && down });
  const { sched, clock, store } = setup(w, { now: T('2026-10-09', '08:00') });
  await sched.check();
  assert.equal(store.getState().channels.s.tries, 1);
  clock.t = T('2026-10-09', '08:15');
  await sched.check();
  assert.equal(w.sent.filter(x => x.url === SLACK).length, 2, 'retried once');
  assert.equal(w.sent.filter(x => x.url === DISCORD).length, 1, 'the channel that worked is not sent again');
  clock.t = T('2026-10-09', '08:30');
  await sched.check();
  assert.equal(w.sent.filter(x => x.url === SLACK).length, 2, 'no third try today');
  down = false;
  clock.t = T('2026-10-10', '08:00');
  w.lastRun = '2026-10-10T06:15:00Z';
  await sched.check();
  const slack = w.sent.filter(x => x.url === SLACK);
  assert.equal(slack.length, 3);
  assert.match(decodeURIComponent(slack[2].body), /Small UAS swarms/, 'the next report still has what failed');
  assert.equal(store.getState().channels.s.error, null);
});

test('scheduler: catch-up after the computer was off, and checks never overlap', async () => {
  const w = world();
  const { sched, clock, store } = setup(w, { now: T('2026-10-12', '06:00') });
  store.setState({ channels: { d: { date: '2026-10-08', slot: '2026-10-08', through: '2026-10-08T06:15:00Z' } } });
  const [a, b] = await Promise.all([sched.check('resume'), sched.check('timer')]);
  assert.equal(a, b, 'one run');
  assert.equal(w.sent.filter(x => x.url === DISCORD).length, 1, 'the missed days are caught up before the time');
  clock.t = T('2026-10-12', '08:00');
  await sched.check();
  assert.equal(w.sent.filter(x => x.url === DISCORD).length, 1, 'but that was the report for today');
});

test('scheduler: live data in a newer format is not used; paused sends nothing', async () => {
  const w = world({ format: 2 });
  const { sched, store } = setup(w, { now: T('2026-10-09', '09:00') });
  const r = await sched.check();
  assert.equal(r.reason, 'data-error');
  assert.match(r.error, /newer format/);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.fetched, [LIVE + 'data/meta.json']);
  store.saveSettings({ ...store.getSettings(), enabled: false });
  w.format = 1;
  assert.equal((await sched.check()).reason, 'paused');
  assert.equal(sched.status().paused, true);
});

test('scheduler: Send test sends the sample to one channel and changes no state', async () => {
  const w = world();
  const { sched, store } = setup(w, { now: T('2026-10-09', '09:00') });
  const r = await sched.sendTest({ id: 'x', type: 'discord', url: DISCORD });
  assert.equal(r.ok, true);
  assert.match(JSON.parse(w.sent[0].body).content, /Test message/);
  assert.deepEqual(store.getState().channels, {});
  assert.equal((await sched.sendTest({ type: 'discord', url: 'nope' })).ok, false);
});

test('scheduler: errors never show a secret (state, status, log, Send test)', async () => {
  const w = world();
  const logs = [];
  const store = createStore({ file: tmp(), N, cipher: cipher() });
  store.saveSettings({ enabled: true, time: '08:00', triggers: { keywords: ['uas'] }, channels: [{ id: 'd', type: 'discord', url: DISCORD }] });
  const fetch = async (url, init) => { if (url === DISCORD) throw new Error('getaddrinfo failed for ' + DISCORD); return w.fetch(url, init); };
  const sched = createScheduler({ N, store, fetch, liveBase: LIVE, now: () => T('2026-10-09', '09:00'), log: m => logs.push(m) });
  await sched.check();
  const t = await sched.sendTest({ id: 'd', type: 'discord', url: DISCORD });
  const all = JSON.stringify([store.getState(), sched.status(), logs, t]);
  assert.ok(!all.includes('secret-token'), all);
  assert.match(store.getState().channels.d.error, /[redacted]/);
  assert.match(t.error, /[redacted]/);
});

test('scheduler: the dry run builds each channel report with secrets redacted and sends nothing', async () => {
  const w = world();
  const { sched, store } = setup(w, { now: T('2026-10-09', '09:00') });
  store.saveSettings({ ...store.getSettings(), channels: [...store.getSettings().channels, CMB] });
  const out = await sched.dryRun();
  assert.equal(w.sent.length, 0);
  assert.equal(out.channels.length, 3);
  assert.equal(out.channels[0].digest.counts.new, 1);
  const text = JSON.stringify(out);
  for (const secret of [DISCORD, SLACK, '987654', '15551234567', 'secret-token']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('[redacted]'));
  assert.deepEqual(store.getState().channels, {});
});
