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

// Every place the version is shown must be updated: a target whose pattern no longer matches stops the release
// before anything is written or committed, with --dry too.
test('release.js: a version target without its version string is fatal, and nothing is committed', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-release-'));
  try {
    for (const d of ['scripts', 'site/js', 'scraper']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const f of ['release.js', 'semver.js']) fs.copyFileSync(path.join(here, '..', '..', 'scripts', f), path.join(dir, 'scripts', f));
    const files = {
      'package.json': JSON.stringify({ name: 't', version: '1.0.0' }, null, 2) + '\n',
      'site/js/app.js': "const APP_VERSION = '1.0.0'; // app version\n",
      'site/sw.js': "const CACHE = 'sg-shell'; // the VERSION line is gone\n",
      'scraper/__init__.py': '__version__ = "1.0.0"\n'
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: first');
    for (const extra of [['--dry'], ['--no-push']]) {
      const run = spawnSync(process.execPath, ['scripts/release.js', 'minor', ...extra], { cwd: dir, encoding: 'utf8' });
      assert.notEqual(run.status, 0, extra.join(' '));
      assert.match(run.stderr, /No version string to update in: site\/sw\.js/);
    }
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1', 'nothing committed');
    assert.equal(git('tag', '-l').stdout.trim(), '', 'nothing tagged');
    assert.equal(git('status', '--porcelain').stdout, '', 'nothing written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// scripts/release.js runs git without a shell and accepts only v<semver> tags: a crafted tag name that is a valid
// git ref (such as one holding "$(...)") must never run as a command.
test('release.js: a crafted tag name is refused and never executed', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-release-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['release.js', 'semver.js']) fs.copyFileSync(path.join(here, '..', '..', 'scripts', f), path.join(dir, 'scripts', f));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }, null, 2) + '\n');
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat: first');
    const evil = 'v1.0.0$(touch${IFS}PWNED)';
    assert.equal(git('tag', evil).status, 0, 'git accepts the crafted tag name');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'feat: second');
    const run = spawnSync(process.execPath, ['scripts/release.js', 'auto', '--dry'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'the release refuses a tag that is not v<semver>');
    assert.match(run.stderr, /not a release tag/);
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false, 'the tag name was never run by a shell');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
