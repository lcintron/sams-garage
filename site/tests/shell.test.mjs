// Static checks on the PWA shell: every precached file exists, every module the app imports is precached, the
// manifest's icons exist, and the store works without localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../js/store.js';
import { agencyInfo, idSafe, metaVersion, metaUpdated, formatSupported, shouldUseData, DATA_FORMAT } from '../js/data.js';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(site, f), 'utf8');

function shellList() {
  const src = read('sw.js');
  const m = src.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(m, 'SHELL array found');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test('every precached shell file exists', () => {
  for (const u of shellList()) {
    if (u === './') continue;
    assert.ok(fs.existsSync(path.join(site, u)), `missing ${u}`);
  }
});

test('every js module and vendor file is precached', () => {
  const shell = new Set(shellList().map(u => u.replace(/^\.\//, '')));
  const walk = dir => fs.readdirSync(path.join(site, dir), { withFileTypes: true })
    .flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name).replace(/\\/g, '/')]));
  for (const f of [...walk('js'), ...walk('vendor')].filter(f => /\.(js|wasm)$/.test(f))) {
    assert.ok(shell.has(f), `not precached: ${f}`);
  }
});

test('sw.js has a VERSION and the data cache name matches data.js', () => {
  const src = read('sw.js');
  assert.match(src, /const VERSION = '[^']+'/);
  assert.match(src, /const DATA_CACHE = 'sg-data'/);
  assert.match(read('js/data.js'), /DATA_CACHE = 'sg-data'/);
});

test('manifest icons exist and include maskable ones', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(site, i.src)), i.src);
  assert.ok(m.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.ok(m.icons.some(i => i.purpose === 'any' && i.sizes === '192x192'));
});

test('index.html references existing files', () => {
  const html = read('index.html');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    assert.ok(fs.existsSync(path.join(site, ref)), `index.html -> ${ref}`);
  }
});

test('store falls back to memory and round-trips', () => {
  const mem = new Map();
  store.useStorage({ getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) });
  assert.equal(store.isWatched('a'), false);
  assert.equal(store.toggleWatch('a'), true);
  assert.equal(store.isWatched('a'), true);
  assert.equal(store.toggleWatch('a'), false);
  store.saveSearch('UAS', 'profile=uas');
  store.saveSearch('UAS', 'profile=uas,cuas');
  assert.deepEqual(store.savedSearches(), [{ name: 'UAS', query: 'profile=uas,cuas' }]);
  store.markVisit(123);
  assert.equal(store.lastVisit(), 123);
  mem.set('sg.watchlist', '{not json');
  assert.equal(store.watchlist().size, 0, 'corrupt value -> fallback');
  store.useStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} });
  assert.equal(store.set('x', 1), false);
  assert.equal(store.get('x', 'fb'), 'fb');
  store.useStorage(null);
});

test('store moves SBIR Portal keys (sbir.*) to sg.* once, never overwriting', () => {
  const mem = new Map([['sbir.watchlist', '["dsip:A1"]'], ['sbir.prefs', '{"theme":"light"}'], ['sg.prefs', '{"theme":"dark"}'], ['other', 'x']]);
  const s = {
    get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
    getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k)
  };
  store.useStorage(s);
  assert.deepEqual([...store.watchlist()], ['dsip:A1']);
  assert.equal(store.prefs().theme, 'dark', 'an existing sg.* value wins');
  assert.deepEqual([...mem.keys()].sort(), ['other', 'sg.prefs', 'sg.watchlist']);
  store.useStorage(s); // a second run changes nothing
  assert.deepEqual([...mem.keys()].sort(), ['other', 'sg.prefs', 'sg.watchlist']);
  store.useStorage(null);
});

test('shouldUseData: only data in a format the app reads', () => {
  assert.equal(shouldUseData({ format: 1 }, 1), true);
  assert.equal(shouldUseData({ format: 1 }, 2), true, 'older data is fine');
  assert.equal(shouldUseData({ format: 2 }, 1), false);
  assert.equal(shouldUseData({}, 1), true, 'no format: the first one');
  assert.equal(shouldUseData(null, 1), true, 'meta not loaded (offline, slow): go ahead');
  assert.equal(shouldUseData(undefined, 1), true);
  assert.equal(shouldUseData({ format: '2' }, 1), false);
  assert.equal(shouldUseData({ format: 1.5 }, 1), false);
  assert.equal(shouldUseData({ format: DATA_FORMAT }), true);
});

test('data helpers', () => {
  assert.equal(idSafe('dsip:ARM26BX06-NV012'), 'dsip__ARM26BX06-NV012');
  assert.equal(metaVersion({ data_version: 'abc' }), 'abc');
  assert.ok(formatSupported({ format: DATA_FORMAT }) && formatSupported({}) && formatSupported(null));
  assert.ok(!formatSupported({ format: DATA_FORMAT + 1 }) && !formatSupported({ format: '1' }));
  assert.equal(metaUpdated({ last_run: '2026-10-09T06:15:00Z' }), Date.UTC(2026, 9, 9, 6, 15));
  const a1 = agencyInfo([{ code: 'HHS', name: 'x', sub_agencies: [{ code: 'NIH', name: 'National Institutes of Health' }] }]);
  assert.equal(a1.get('HHS').subs.get('NIH'), 'National Institutes of Health');
  const a2 = agencyInfo({ agencies: [{ code: 'ZZZ', name: 'Zed' }] });
  assert.equal(a2.get('ZZZ').name, 'Zed');
  const a3 = agencyInfo({ DOD: { name: 'Defense', sub_agencies: { ARMY: { name: 'Army' } } } });
  assert.equal(a3.get('DOD').subs.get('ARMY'), 'Army');
});
