#!/usr/bin/env node
/* SAM's Garage release helper (no dependencies).
 *
 *   node scripts/release.js [auto|major|minor|patch|prerelease] [--pre=Beta] [--dry] [--no-push] [--ci] [--show]
 *
 * - Picks the semantic-version bump from the conventional commits since the last tag when "auto" (default):
 *     "BREAKING CHANGE" / "type!:" -> major,  feat: -> minor,  fix: / perf: / revert: -> patch,
 *     only chore/docs/ci/style/refactor/test/build/data commits -> no release (exit 0, released=false)
 * - --ci: non-interactive mode for GitHub Actions; writes released/tag/version to $GITHUB_OUTPUT
 * - Writes the new version everywhere it is shown: package.json, site/js/app.js (APP_VERSION, shown in the About
 *   view), site/sw.js (the cache name) and scraper/__init__.py (the data bot's User-Agent); the README shows the
 *   latest release with a badge
 * - Commits "chore(release): vX.Y.Z", tags vX.Y.Z and pushes. The GitHub "Release" workflow, which runs this
 *   script when started by hand, then builds the Windows, macOS and Linux installers, publishes the GitHub
 *   Release and deploys GitHub Pages from that tag (with today's data).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = n => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
const bumpArg = args.find(a => !a.startsWith('--')) || 'auto';

const sh = (cmd, quiet) => execSync(cmd, { cwd: root, stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'] }).toString().trim();
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);

const pkg = JSON.parse(read('package.json'));
const current = pkg.version;

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error('Not a semantic version: ' + v);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}
function format(v) { return `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`; }

function lastTag() { try { return sh('git describe --tags --abbrev=0 --match "v*"', true); } catch (e) { return null; } }

function autoBump() {
  const tag = lastTag();
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = sh(`git log ${range} --format=%s%n%b`, true);
  if (!log.trim()) return null;
  if (/BREAKING CHANGE|^[a-z]+(\([^)]*\))?!:/m.test(log)) return 'major';
  if (/^feat(\([^)]*\))?:/m.test(log)) return 'minor';
  if (/^(fix|perf|revert)(\([^)]*\))?:/m.test(log)) return 'patch';
  return null; // nothing user-facing since the last release (the daily "data: refresh" commits included)
}

function output(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function bump(v, kind, pre) {
  const n = { ...v };
  if (kind === 'prerelease') {
    if (!n.pre) { n.patch++; n.pre = (pre || 'Beta') + '.0'; }
    else {
      const m = /^(.*?)(?:\.(\d+))?$/.exec(n.pre);
      n.pre = m[1] + '.' + ((m[2] == null ? 0 : +m[2]) + 1);
    }
    return n;
  }
  // Leaving a pre-release of the same level keeps the number (0.0.1-Beta -> 0.0.1); otherwise bump normally.
  if (n.pre && kind === 'patch') { n.pre = null; }
  else {
    n.pre = null;
    if (kind === 'major') { n.major++; n.minor = 0; n.patch = 0; }
    else if (kind === 'minor') { n.minor++; n.patch = 0; }
    else n.patch++;
  }
  if (pre) n.pre = pre;
  return n;
}

if (flag('show')) { console.log(current); process.exit(0); }

const auto = bumpArg === 'auto' ? autoBump() : null;
if (bumpArg === 'auto' && !auto) {
  console.log(`No release needed: no feat/fix/perf commits since ${lastTag() || 'the first commit'}.`);
  output({ released: 'false', tag: '', version: current });
  process.exit(0);
}
const kind = bumpArg === 'auto' ? auto : bumpArg;
if (!['major', 'minor', 'patch', 'prerelease'].includes(kind)) { console.error('Unknown bump: ' + kind); process.exit(1); }
const pre = opt('pre');
// semver pre-release form: dot-separated groups of letters, digits and dashes (no "..", no leading or trailing
// dot, no all-digit group with a leading zero such as "01")
if (pre && (!/^[0-9A-Za-z][0-9A-Za-z-]*(\.[0-9A-Za-z][0-9A-Za-z-]*)*$/.test(pre) || /(^|\.)0\d+(\.|$)/.test(pre))) { console.error('Invalid pre-release label: ' + pre); process.exit(1); }
const next = format(bump(parse(current), kind, pre));
const tag = 'v' + next;
// the tag must be a valid git ref before anything is written or committed
try { sh(`git check-ref-format refs/tags/${tag}`, true); } catch (e) { console.error('Not a valid tag name: ' + tag); process.exit(1); }

console.log(`${current} -> ${next}  (${bumpArg === 'auto' ? 'auto: ' : ''}${kind})`);

if (!flag('dry')) {
  if (sh('git status --porcelain', true)) { console.error('Working tree is not clean. Commit or stash first.'); process.exit(1); }
  try { sh(`git rev-parse -q --verify refs/tags/${tag}`, true); console.error('Tag already exists: ' + tag); process.exit(1); } catch (e) { /* ok */ }
}

// ---- rewrite every place the version is shown ----
const edits = [
  ['package.json', s => s.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`)],
  ['site/js/app.js', s => s.replace(/const APP_VERSION = '[^']*';[^\n]*/, `const APP_VERSION = '${next}'; // app version; bump via scripts/release.js`)],
  ['site/sw.js', s => s.replace(/const VERSION = '[^']*';[^\n]*/, `const VERSION = 'sg-${next}'; // app version; bump via scripts/release.js`)],
  ['scraper/__init__.py', s => s.replace(/__version__ = "[^"]*"/, `__version__ = "${next}"`)]
];
for (const [file, fn] of edits) {
  const before = read(file), after = fn(before);
  if (before === after) console.warn('  (no version string found in ' + file + ')');
  else { console.log('  updated ' + file); if (!flag('dry')) write(file, after); }
}

if (flag('dry')) { console.log('Dry run: nothing written, committed or tagged.'); output({ released: 'false', tag, version: next }); process.exit(0); }

sh('git add ' + edits.map(([f]) => f).join(' '));
sh(`git commit -q -m "chore(release): ${tag}"`);
sh(`git tag -a ${tag} -m "SAM's Garage ${tag}"`);
console.log('Committed and tagged ' + tag);
if (!flag('no-push')) {
  const branch = sh('git rev-parse --abbrev-ref HEAD', true);
  sh(`git push origin HEAD:${branch === 'HEAD' ? 'main' : branch}`);
  sh(`git push origin ${tag}`);
  console.log(`Pushed ${branch} and ${tag}.` + (flag('ci') ? '' : ' The Release workflow builds the installers and deploys the site.'));
} else console.log('Not pushed (--no-push).');
output({ released: 'true', tag, version: next });
