// Old ids (alt_ids) in links and watchlists resolve to the record that holds them now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasMap, resolveId, migrateWatchlist } from '../js/ids.js';
import { rec } from './helpers.mjs';

const catalog = [
  rec({ id: 'sbirgov:13020', alt_ids: ['dsip:DON27BZ01-NV003'] }),
  rec({ id: 'dsip:A1', alt_ids: ['sbirgov:9', 'dsip:B2'] }),
  rec({ id: 'dsip:B2' })
];
const byId = new Map(catalog.map(r => [r.id, r]));
const aliasOf = aliasMap(catalog);

test('aliasMap skips alt ids that are records of their own', () => {
  assert.deepEqual([...aliasOf].sort(), [['dsip:DON27BZ01-NV003', 'sbirgov:13020'], ['sbirgov:9', 'dsip:A1']]);
});

test('resolveId', () => {
  assert.equal(resolveId('dsip:A1', byId, aliasOf), 'dsip:A1');
  assert.equal(resolveId('dsip:DON27BZ01-NV003', byId, aliasOf), 'sbirgov:13020');
  assert.equal(resolveId('dsip:B2', byId, aliasOf), 'dsip:B2');
  assert.equal(resolveId('grants:nope', byId, aliasOf), null);
});

test('migrateWatchlist moves aliases to their records, keeps unknown ids, dedupes', () => {
  assert.deepEqual(migrateWatchlist(['dsip:DON27BZ01-NV003', 'sbirgov:13020', 'grants:gone'], byId, aliasOf),
    { ids: ['grants:gone', 'sbirgov:13020'], changed: true });
  assert.deepEqual(migrateWatchlist(['dsip:A1', 'grants:gone'], byId, aliasOf), { ids: ['dsip:A1', 'grants:gone'], changed: false });
});
