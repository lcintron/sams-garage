// The release rules (scripts/semver.js): the bump the conventional commits call for, and the version arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parse, format, bumpFor, bump, validPre, withVersion } = require('../../scripts/semver.js');
const next = (v, kind, pre) => format(bump(parse(v), kind, pre));

test('bumpFor: breaking changes -> major', () => {
  assert.equal(bumpFor('feat: x\nsome body\n\nBREAKING CHANGE: the v1 format is gone'), 'major');
  assert.equal(bumpFor('fix: y\n\nBREAKING-CHANGE: z'), 'major');
  assert.equal(bumpFor('feat(api)!: drop v1'), 'major');
  assert.equal(bumpFor('refactor!: rename'), 'major');
});

test('bumpFor: the words inside a sentence are not a breaking change', () => {
  assert.equal(bumpFor('ci: release tooling\n\nThe rule (a BREAKING CHANGE: footer or type!) picks major.'), null);
  assert.equal(bumpFor('feat: x\n\nThis mentions BREAKING CHANGE in passing.'), 'minor');
});

test('bumpFor: feat -> minor, fix/perf/revert -> patch', () => {
  assert.equal(bumpFor('feat: x'), 'minor');
  assert.equal(bumpFor('feat(desktop): x\nfix: y'), 'minor');
  for (const s of ['fix: y', 'fix(scraper): y', 'perf: z', 'revert: w']) assert.equal(bumpFor('docs: a\n' + s), 'patch', s);
});

test('bumpFor: nothing user-facing -> no release', () => {
  assert.equal(bumpFor(''), null);
  assert.equal(bumpFor('chore: a\ndocs: b\nci: c\nchore(release): v0.2.0\ndata: refresh 2026-10-09 (352 open, 4 new)\nbuild: d\ntest: e\nstyle: f\nrefactor: g'), null);
  assert.equal(bumpFor('  feat: indented is not a subject'), null);
});

test('bump: normal and pre-release sequences', () => {
  assert.equal(next('0.1.0', 'minor'), '0.2.0');
  assert.equal(next('0.2.3', 'patch'), '0.2.4');
  assert.equal(next('0.2.3', 'major'), '1.0.0');
  assert.equal(next('0.2.0', 'prerelease'), '0.2.1-Beta.0');
  assert.equal(next('0.2.1-Beta.0', 'prerelease'), '0.2.1-Beta.1');
  assert.equal(next('0.2.0', 'prerelease', 'rc'), '0.2.1-rc.0');
  assert.equal(next('0.2.1-Beta.1', 'patch'), '0.2.1', 'leaving a pre-release of the same level keeps the number');
  assert.equal(next('0.2.1-Beta.1', 'minor'), '0.3.0', 'leaving it with minor skips a number, as in GenGIS');
  assert.equal(next('0.2.0', 'minor', 'Beta'), '0.3.0-Beta');
  assert.throws(() => parse('1.2'), /Not a semantic version/);
});

test('validPre', () => {
  for (const ok of ['Beta', 'rc.1', 'alpha-2.x']) assert.ok(validPre(ok), ok);
  for (const bad of ['', '.x', 'x.', 'a..b', 'rc.01', 'a b', 'a/b']) assert.ok(!validPre(bad), bad);
});

test('withVersion keeps package.json as it is formatted', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const version = JSON.parse(text).version;
  assert.equal(withVersion(text, version), text, 'package.json is kept in the form release.js writes');
  const out = withVersion(text, '9.9.9');
  assert.equal(JSON.parse(out).version, '9.9.9');
  assert.ok(out.endsWith('}\n') && out.includes('\n  "name": "sams-garage",\n'));
});
