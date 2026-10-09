import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, parseQuery, toQuery, splitHash, buildHash, isFiltered } from '../js/filters.js';

test('default state serializes to an empty query', () => {
  assert.equal(toQuery(defaultState()), '');
  assert.deepEqual(parseQuery(''), defaultState());
  assert.equal(isFiltered(defaultState()), false);
});

test('filters round-trip through the URL query', () => {
  const s = {
    ...defaultState(), q: 'counter uas & acoustic, "array" 100%', status: ['open', 'closed'], agency: ['DOD', 'HHS'], sub: ['ARMY'],
    program: ['STTR'], phase: ['I', 'DP2'], closing: 14, opens: '2026-10-15', profile: ['cuas', 'u-my-sensors'], newOnly: true, sort: 'added'
  };
  const q = toQuery(s);
  assert.deepEqual(parseQuery(q), s);
  assert.equal(toQuery(parseQuery(q)), q, 'query is stable');
  assert.equal(isFiltered(s), true);
});

test('every single filter round-trips on its own', () => {
  const patches = [{ q: 'uas' }, { status: ['closed'] }, { status: [] }, { agency: ['NSF'] }, { sub: ['NIH'] }, { program: ['SBIR'] },
    { phase: ['II'] }, { closing: 60 }, { opens: '2027-01-01' }, { profile: ['acoustic'] }, { newOnly: true }, { sort: 'title' }];
  for (const p of patches) {
    const s = { ...defaultState(), ...p };
    assert.deepEqual(parseQuery(toQuery(s)), s, JSON.stringify(p));
  }
});

test('empty status list is "any" and survives the round trip', () => {
  const s = { ...defaultState(), status: [] };
  assert.equal(toQuery(s), 'status=any');
  assert.deepEqual(parseQuery('status=any').status, []);
});

test('status order does not matter for the default', () => {
  assert.equal(toQuery({ ...defaultState(), status: ['pre_release', 'open'] }), '');
});

test('invalid values are ignored', () => {
  const s = parseQuery('?status=open,bogus&program=sbir,XYZ&phase=i,9&closing=-3&opens=tomorrow&sort=nope&zzz=1&new=0');
  assert.deepEqual(s.status, ['open']);
  assert.deepEqual(s.program, ['SBIR']);
  assert.deepEqual(s.phase, ['I']);
  assert.equal(s.closing, null);
  assert.equal(s.opens, '');
  assert.equal(s.sort, 'auto');
  assert.equal(s.newOnly, false);
});

test('malformed percent-encoding does not throw', () => {
  assert.equal(parseQuery('q=%E0%A4%A').q, '%E0%A4%A');
  assert.equal(parseQuery('q=a+b').q, 'a b');
});

test('duplicates are removed', () => {
  assert.deepEqual(parseQuery('agency=DOD,dod,HHS').agency, ['DOD', 'HHS']);
});

test('splitHash / buildHash', () => {
  assert.deepEqual(splitHash('#/s/dsip:A1?q=uas'), { path: '/s/dsip:A1', query: 'q=uas' });
  assert.deepEqual(splitHash(''), { path: '/', query: '' });
  assert.deepEqual(splitHash('#/?closing=7'), { path: '/', query: 'closing=7' });
  assert.equal(buildHash('/', { ...defaultState(), closing: 7 }), '#/?closing=7');
  assert.equal(buildHash('/watch', defaultState()), '#/watch');
});
