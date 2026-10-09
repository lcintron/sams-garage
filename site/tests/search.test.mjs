import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from '../vendor/minisearch/minisearch.js';
import {
  buildIndex, textSearch, fallbackSearch, runPipeline, facetCounts, computeProfileScores, sortResults, effectiveSort,
  parseDate, daysUntil, isNew, todayISO
} from '../js/search.js';
import { defaultState } from '../js/filters.js';
import { PRESET_PROFILES } from '../js/profiles.js';
import { CATALOG, TODAY } from './helpers.mjs';

const ctx = (over = {}) => ({ today: TODAY, textScores: null, profileScores: new Map(), lastVisit: null, ...over });
const ids = results => results.map(r => r.rec.id);
const run = (patch, c) => runPipeline(CATALOG, { ...defaultState(), ...patch }, ctx(c));

const DOCS = CATALOG.map(r => ({
  id: r.id, title: r.title, summary: r.summary, keywords: r.keywords.join(' '), technology_areas: r.technology_areas.join(' '), topic_number: r.topic_number || '',
  solicitation_number: '', agency: r.agency, sub_agency: r.sub_agency || '',
  description: r.id === 'sbirgov:4' ? 'Lithium-ion battery recycling and hydrometallurgy.' : ''
}));

test('dates: ISO dates and timestamps both parse', () => {
  assert.equal(parseDate('2026-10-09'), Date.UTC(2026, 9, 9));
  assert.equal(parseDate('2026-10-09T06:15:00Z'), Date.UTC(2026, 9, 9, 6, 15));
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('garbage'), null);
  assert.equal(daysUntil('2026-10-12', TODAY), 3);
  assert.equal(daysUntil('2026-10-12T23:00:00Z', TODAY), 3);
  assert.equal(daysUntil('2026-10-01', TODAY), -8);
  assert.equal(daysUntil(null, TODAY), null);
  assert.equal(todayISO(new Date(2026, 0, 5)), '2026-01-05');
});

test('default view: open + pre-release, sorted by close date', () => {
  assert.deepEqual(ids(run({})), ['dsip:A1', 'sbirgov:4', 'dsip:D7', 'dsip:N2', 'grants:6']);
});

test('status filter; empty status means any', () => {
  assert.deepEqual(ids(run({ status: ['closed'] })), ['sbirgov:5']);
  assert.deepEqual(ids(run({ status: ['forecasted'] })), ['grants:3']);
  assert.equal(run({ status: [] }).length, CATALOG.length);
});

test('agency and sub-agency filters', () => {
  assert.deepEqual(ids(run({ agency: ['HHS'], status: [] })), ['grants:3']);
  assert.deepEqual(ids(run({ agency: ['DOD'], sub: ['USAF'] })), ['dsip:D7']);
  assert.deepEqual(ids(run({ agency: ['DOD', 'NSF'] })).sort(), ['dsip:A1', 'dsip:D7', 'dsip:N2', 'grants:6'].sort());
});

test('program filter: SBIR/STTR satisfies both', () => {
  assert.deepEqual(ids(run({ program: ['STTR'] })).sort(), ['dsip:A1', 'grants:6']);
  assert.ok(ids(run({ program: ['SBIR'] })).includes('grants:6'));
  assert.ok(!ids(run({ program: ['SBIR'] })).includes('dsip:A1'));
});

test('phase filter', () => {
  assert.deepEqual(ids(run({ phase: ['DP2'] })), ['dsip:D7']);
  assert.deepEqual(ids(run({ phase: ['II'], status: [] })).sort(), ['dsip:N2', 'grants:3']);
});

test('closing within N days excludes past and undated', () => {
  assert.deepEqual(ids(run({ closing: 7 })), ['dsip:A1']);
  assert.deepEqual(ids(run({ closing: 30 })), ['dsip:A1', 'sbirgov:4', 'dsip:D7']);
  assert.ok(!ids(run({ closing: 60, status: [] })).includes('sbirgov:5'));
});

test('opens on or after', () => {
  assert.deepEqual(ids(run({ opens: '2026-10-15', status: [] })).sort(), ['dsip:N2', 'grants:3']);
});

test('new since last visit (dates and timestamps)', () => {
  const lastVisit = Date.UTC(2026, 9, 1, 12); // Oct 1 12:00Z: N2 first_seen "2026-10-01" (midnight) is NOT new
  const res = run({ newOnly: true }, { lastVisit });
  assert.deepEqual(ids(res).sort(), ['dsip:A1', 'grants:6']);
  assert.ok(res.every(r => r.isNew));
  assert.equal(run({ newOnly: true }).length, 0, 'no last visit: nothing is new');
  assert.equal(isNew(CATALOG[0], null), false);
});

test('profile filter uses profile scores (any selected profile)', () => {
  const profileScores = computeProfileScores(CATALOG, PRESET_PROFILES, new Map());
  const c = { profileScores, profilesById: new Map(PRESET_PROFILES.map(p => [p.id, p])) };
  assert.deepEqual(ids(run({ profile: ['cuas'] }, c)), ['dsip:A1']);
  assert.deepEqual(ids(run({ profile: ['acoustic'], status: [] }, c)).sort(), ['dsip:A1', 'dsip:N2', 'grants:3']);
  // UAS matches A1 ("UAS") and the closed drone topic
  assert.deepEqual(ids(run({ profile: ['uas'], status: [] }, c)).sort(), ['dsip:A1', 'sbirgov:5']);
  // with a profile active, auto sort is relevance: highest score first
  const res = run({ profile: ['acoustic', 'cuas'], status: [] }, c);
  assert.equal(res[0].rec.id, 'dsip:A1');
  assert.ok(res[0].score >= res[1].score);
  // A1: acoustic ("acoustic") 2+3, cuas ("counter-uas" and "counter uas", as the analyzer counted variants) 4+6, context ("detection") 1
  assert.equal(res[0].profileScore, 16);
});

test('full-text search with MiniSearch: prefix, fuzzy, boosts, description', () => {
  const index = buildIndex(MiniSearch, DOCS);
  const hit = q => [...textSearch(index, q).keys()];
  assert.equal(hit('acous')[0], 'dsip:A1', 'prefix');
  assert.ok(hit('sonr').includes('dsip:N2'), 'fuzzy');
  assert.ok(hit('A26B-T014').includes('dsip:A1'), 'topic number');
  assert.ok(hit('hydrometallurgy').includes('sbirgov:4'), 'description field');
  assert.equal(textSearch(index, '   '), null);
  // AND across words, falls back to OR when AND finds nothing
  assert.deepEqual(hit('passive sonar'), ['dsip:N2']);
  assert.ok(hit('sonar zzzzqqq').includes('dsip:N2'));
  const res = run({ q: 'passive' }, { textScores: textSearch(index, 'passive') });
  assert.deepEqual(ids(res).sort(), ['dsip:A1', 'dsip:N2']);
  assert.equal(effectiveSort({ ...defaultState(), q: 'x' }), 'relevance');
});

test('technology areas are indexed, matched before the index is ready, and optional', () => {
  const index = buildIndex(MiniSearch, DOCS);
  assert.deepEqual([...textSearch(index, 'hypersonics').keys()], ['dsip:D7']);
  assert.deepEqual([...fallbackSearch(CATALOG, 'hypersonics').keys()], ['dsip:D7']);
  // documents from builds without the field still index
  const old = buildIndex(MiniSearch, [{ id: 'o', title: 'legacy doc', keywords: 'x' }]);
  assert.deepEqual([...textSearch(old, 'legacy').keys()], ['o']);
});

test('keywords given as arrays are indexed too', () => {
  const index = buildIndex(MiniSearch, [{ id: 'k', title: 't', keywords: ['hypersonics', 'ramjet'] }, { id: 'k', title: 'dup' }]);
  assert.deepEqual([...textSearch(index, 'ramjet').keys()], ['k']);
});

test('fallback search before the index is ready', () => {
  const m = fallbackSearch(CATALOG, 'passive ARRAY');
  assert.deepEqual([...m.keys()], ['dsip:N2']);
  assert.equal(fallbackSearch(CATALOG, ''), null);
});

test('sorting', () => {
  const all = { status: [] };
  assert.equal(run({ ...all, sort: 'title' })[0].rec.title, 'Battery recycling for rail');
  assert.equal(run({ ...all, sort: 'added' })[0].rec.id, 'dsip:A1');
  assert.equal(run({ ...all, sort: 'changed' })[0].rec.id, 'dsip:D7');
  const close = ids(run({ ...all, sort: 'close' }));
  assert.equal(close[0], 'sbirgov:5');
  assert.equal(close.at(-1), 'grants:6', 'records without a close date sort last');
  assert.equal(effectiveSort(defaultState()), 'close');
  assert.equal(sortResults([], 'nope').length, 0);
});

test('results carry days-until-close', () => {
  const a1 = run({}).find(r => r.rec.id === 'dsip:A1');
  assert.equal(a1.days, 3);
});

test('facet counts ignore their own facet', () => {
  const s = { ...defaultState(), agency: ['HHS'] };
  const c = facetCounts(CATALOG, s, ctx());
  // agency counts are computed without the agency filter (open + pre-release only)
  assert.deepEqual(c.agency, { DOD: 3, DOT: 1, NSF: 1 });
  // status counts are computed with agency=HHS but without the status filter
  assert.deepEqual(c.status, { forecasted: 1 });
  assert.equal(facetCounts(CATALOG, defaultState(), ctx()).program.STTR, 2);
});
