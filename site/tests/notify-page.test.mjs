// js/notify/page.js in Node with a small in-memory IndexedDB: what the browser stores (no Teams or WhatsApp Cloud API
// secret ever), the export for GitHub Actions (secrets only in the export), "Clear local data", the Periodic
// Background Sync decision, and the github.io shared-origin hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// a minimal IndexedDB: one store, transactions one after another (enough for js/notify/idb.js)
function fakeIndexedDB() {
  const data = new Map();
  let last = Promise.resolve();
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  function transaction() {
    const t = {}, queue = [];
    let release;
    const finished = new Promise(r => { release = r; });
    const prev = last;
    last = finished;
    const op = fn => { const req = {}; queue.push([fn, req]); return req; };
    const step = async () => {
      while (queue.length) { const [fn, req] = queue.shift(); await null; req.result = fn(); if (req.onsuccess) req.onsuccess(); }
      await null;
      if (queue.length) return step();
      if (t.oncomplete) t.oncomplete();
      release();
    };
    t.objectStore = () => ({ get: k => op(() => clone(data.get(k))), put: (v, k) => op(() => { data.set(k, clone(v)); }), delete: k => op(() => { data.delete(k); }) });
    t.abort = () => {};
    prev.then(step);
    return t;
  }
  return { data, open() { const req = {}; Promise.resolve().then(() => { req.result = { objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction, close() {} }; req.onsuccess(); }); return req; } };
}

const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
const store = await import('../js/store.js');
const mem = new Map();
store.useStorage({ getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) });
const page = await import('../js/notify/page.js');
const N = globalThis.SgNotify;

const SLACK = 'https://hooks.slack.com/services/T/B/slack-secret';
const TEAMS = 'https://prod-1.westus.logic.azure.com/workflows/x?sig=teams-secret';
const TOKEN = 'EAAG' + 'q'.repeat(40);
const SETTINGS = {
  enabled: true, triggers: { keywords: ['uas'] },
  channels: [
    { id: 's', type: 'slack', name: 'Team', url: SLACK },
    { id: 't', type: 'teams', name: 'Bids', url: TEAMS },
    { id: 'c', type: 'whatsapp', provider: 'cloud', name: 'Biz', phoneNumberId: '99887766', accessToken: TOKEN, to: '+15550002222', template: 'sg_daily', language: 'en_US' }
  ]
};
const stored = () => JSON.stringify([...idb.data.entries()]);

test('the browser never stores Teams or WhatsApp Cloud API secrets; it keeps the others', async () => {
  const saved = await page.save(SETTINGS);
  assert.equal(saved.channels[0].url, SLACK);
  assert.equal(saved.channels[1].url, '');
  assert.equal(saved.channels[2].accessToken, '');
  assert.equal(saved.channels[2].template, 'sg_daily', 'fields that are not secret stay');
  const raw = stored();
  for (const secret of [TEAMS, TOKEN, '99887766', '+15550002222']) assert.ok(!raw.includes(secret), 'not in IndexedDB: ' + secret);
  assert.ok(raw.includes(SLACK));
  assert.equal(page.secretsKept(SETTINGS.channels[0]), true);
  assert.equal(page.secretsKept(SETTINGS.channels[1]), false);
  // settings stored before that rule are cleaned when read
  await globalThis.SgIdb.set('notify-settings', SETTINGS);
  const { settings } = await page.load();
  assert.equal(settings.channels[1].url, '');
  assert.ok(!stored().includes(TEAMS));
});

test('export for GitHub Actions: the typed secrets go into the export only, and missing ones are listed', async () => {
  store.setWatchlist(['dsip:A1']);
  store.setUserProfiles([{ id: 'u-lidar', name: 'Lidar', terms: ['lidar'] }]);
  await page.save(SETTINGS);
  const without = await page.exportConfig();
  assert.deepEqual(without.missing.map(m => [m.id, m.fields]), [['t', ['url']], ['c', ['phoneNumberId', 'accessToken', 'to']]]);
  const r = await page.exportConfig({ t: { url: TEAMS }, c: { phoneNumberId: '99887766', accessToken: TOKEN, to: '+15550002222' } });
  assert.deepEqual(r.missing, []);
  const doc = JSON.parse(r.text);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.settings.channels.map(c => c.url || c.accessToken), [SLACK, TEAMS, TOKEN]);
  assert.deepEqual(doc.watchlist, ['dsip:A1']);
  assert.deepEqual(doc.profiles.map(p => p.id), ['u-lidar']);
  for (const secret of [TEAMS, TOKEN]) assert.ok(!stored().includes(secret), 'still not stored: ' + secret);
});

test('Clear local data removes every notification key, the lock and the copies', async () => {
  await page.save(SETTINGS);
  await globalThis.SgIdb.set('notify-state', { channels: { s: { date: '2026-10-09' } } });
  await globalThis.SgIdb.set('notify-last-report', { at: 'x' });
  await globalThis.SgIdb.lock('notify', 'page:x', 60000);
  await page.mirror();
  assert.ok(idb.data.size >= 6);
  await page.reset();
  assert.deepEqual([...idb.data.keys()], []);
});

test('saving drops the run state of a removed channel', async () => {
  await page.save(SETTINGS);
  await globalThis.SgIdb.set('notify-state', { channels: { s: { date: '2026-10-09' }, gone: { date: '2026-10-08' }, __local: { date: '2026-10-09' } } });
  await page.save({ ...SETTINGS, channels: SETTINGS.channels.slice(0, 1) });
  assert.deepEqual(Object.keys((await globalThis.SgIdb.get('notify-state')).channels).sort(), ['__local', 's']);
});

test('Periodic Background Sync: registered only when on, sending from this browser, with a channel it can reach', async () => {
  const calls = [];
  const reg = { periodicSync: { register: async (tag, o) => calls.push(['register', tag, o.minInterval]), unregister: async tag => calls.push(['unregister', tag]) } };
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { getRegistration: async () => reg } }, configurable: true });
  try {
    const browserOnly = { ...SETTINGS, channels: SETTINGS.channels.slice(1) }; // Teams and Cloud only
    assert.equal(N.wantsPeriodicSync(SETTINGS), true);
    assert.equal(N.wantsPeriodicSync({ ...SETTINGS, enabled: false }), false);
    assert.equal(N.wantsPeriodicSync({ ...SETTINGS, background: { browser: false } }), false);
    assert.equal(N.wantsPeriodicSync(browserOnly), false, 'nothing a browser can send');
    assert.equal(N.wantsPeriodicSync({ ...SETTINGS, channels: [{ ...SETTINGS.channels[0], enabled: false }] }), false);
    assert.equal(await page.syncPeriodic(N.normalizeSettings(SETTINGS)), true);
    assert.equal(await page.syncPeriodic(N.normalizeSettings(browserOnly)), false);
    assert.deepEqual(calls, [['register', 'sg-daily-report', 12 * 3600 * 1000], ['unregister', 'sg-daily-report']]);
  } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real); else delete globalThis.navigator;
  }
});

test('the shared-origin hint is for github.io addresses only', () => {
  assert.equal(N.sharedOrigin('lcintron.github.io'), true);
  assert.equal(N.sharedOrigin('LCINTRON.GITHUB.IO'), true);
  assert.equal(N.sharedOrigin('sg.luiscintron.com'), false);
  assert.equal(N.sharedOrigin('localhost'), false);
  assert.equal(N.sharedOrigin('github.io.evil.example'), false);
});
