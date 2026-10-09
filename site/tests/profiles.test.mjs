import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_PROFILES, scoreRecord, scoreFor, scoreText, recordText, rankRecords, parseTerms, profileId, normalizeProfile, allProfiles, normalizeText
} from '../js/profiles.js';
import { rec } from './helpers.mjs';

const byId = id => PRESET_PROFILES.find(p => p.id === id);

test('presets are the analyzer hashtags', () => {
  assert.deepEqual(PRESET_PROFILES.map(p => p.name), ['UAS', 'Counter-UAS', 'Acoustic']);
  assert.deepEqual(PRESET_PROFILES.map(p => p.bonus), [3, 6, 3]);
  assert.ok(byId('cuas').terms.includes('counter-drone'));
  assert.ok(byId('acoustic').terms.includes('passive sensing'));
});

test('scoring: 2 per term + profile bonus + context capped at 3', () => {
  // As in the analyzer, every listed variant that is found counts: "c-uas", "counter-uas" and "counter uas" all match
  // "Counter-UAS" once dashes are folded, plus "drone detection".
  const r = rec({ title: 'Counter-UAS drone detection', summary: 'sensor tracking detection surveillance aircraft' });
  const m = scoreRecord(r, [byId('cuas')]);
  assert.deepEqual([...m.matched.cuas].sort(), ['counter uas', 'counter-uas', 'drone detection'].sort());
  assert.equal(m.score, 3 * 2 + 6 + 3);
  assert.equal(m.context.length > 3, true);
});

test('several profiles add up', () => {
  const m = scoreRecord(rec({ title: 'Acoustic detection of drones' }), PRESET_PROFILES);
  // uas: drones (2+3) · acoustic: acoustic (2+3) · context: detection (1)
  assert.deepEqual(Object.keys(m.matched).sort(), ['acoustic', 'uas']);
  assert.equal(m.score, 5 + 5 + 1);
});

test('scoreFor counts only the chosen profiles', () => {
  const byIdMap = new Map(PRESET_PROFILES.map(p => [p.id, p]));
  const m = scoreRecord(rec({ title: 'Acoustic detection of drones' }), PRESET_PROFILES);
  assert.equal(scoreFor(m, ['acoustic'], byIdMap), 2 + 3 + 1);
  assert.equal(scoreFor(m, ['acoustic', 'uas'], byIdMap), m.score);
  assert.equal(scoreFor(m, ['cuas'], byIdMap), 0);
  assert.equal(scoreFor(null, ['uas'], byIdMap), 0);
});

test('no match returns null and context alone never scores', () => {
  assert.equal(scoreRecord(rec({ title: 'Sensor tracking surveillance' }), PRESET_PROFILES), null);
});

test('whole-word matching avoids substring false positives', () => {
  assert.equal(scoreRecord(rec({ title: 'Persuasive audiology resounding' }), PRESET_PROFILES), null);
  assert.ok(scoreRecord(rec({ title: 'Small UAS swarms' }), [byId('uas')]));
  assert.ok(scoreRecord(rec({ title: 'Drones over water' }), [byId('uas')]).matched.uas.includes('drones'));
});

test('description from the search index is used when the catalog has none', () => {
  const r = rec({ title: 'Generic sensing' });
  assert.equal(scoreRecord(r, [byId('acoustic')]), null);
  assert.ok(scoreRecord(r, [byId('acoustic')], 'A microphone array for sonar.'));
});

test('technology areas count as text', () => {
  const r = rec({ title: 'X', technology_areas: ['Acoustics', 'Sensors'] });
  assert.deepEqual(scoreRecord(r, [byId('acoustic')]).matched.acoustic, ['acoustics']);
});

test('keywords count as text', () => {
  const t = recordText(rec({ title: 'X', keywords: ['counter-uas'] }));
  assert.ok(scoreText(t, [byId('cuas')]));
});

test('rankRecords orders by score then agency then topic', () => {
  const a = rec({ id: 'a', agency: 'HHS', topic_number: 'B', title: 'acoustic' });
  const b = rec({ id: 'b', agency: 'DOD', topic_number: 'Z', title: 'acoustic' });
  const c = rec({ id: 'c', agency: 'DOD', topic_number: 'A', title: 'acoustic sonar microphone' });
  assert.deepEqual(rankRecords([a, b, c], PRESET_PROFILES).map(x => x.rec.id), ['c', 'b', 'a']);
});

test('user profiles: parse, id, normalize', () => {
  assert.deepEqual(parseTerms('#Lidar, point cloud\nLIDAR;; '), ['lidar', 'point cloud']);
  assert.equal(profileId('My Sensors!'), 'u-my-sensors');
  assert.equal(profileId('My Sensors!', ['u-my-sensors']), 'u-my-sensors-2');
  assert.equal(normalizeProfile({ id: 'bad id', name: 'x', terms: ['a'] }), null);
  assert.equal(normalizeProfile({ id: 'u-x', name: '', terms: ['a'] }), null);
  assert.deepEqual(normalizeProfile({ id: 'u-x', name: ' Lidar ', terms: 'lidar, LIDAR', bonus: 99 }),
    { id: 'u-x', name: 'Lidar', terms: ['lidar'], bonus: 10, preset: false });
  const all = allProfiles([{ id: 'u-x', name: 'Lidar', terms: ['lidar'] }, { junk: true }]);
  assert.equal(all.length, 4);
  assert.ok(scoreRecord(rec({ title: 'LiDAR mapping' }), all).matched['u-x']);
});

test('normalizeText folds dashes and spacing', () => {
  assert.equal(normalizeText('Counter–UAS\n  drones'), ' counter uas drones ');
});
