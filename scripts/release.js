#!/usr/bin/env node
/* SAM's Garage release helper (no dependencies).
 *
 *   node scripts/release.js [auto|major|minor|patch|prerelease] [--pre=Beta] [--dry] [--no-push] [--ci] [--show]
 *
 * - Picks the semantic-version bump from the conventional commits since the last tag when "auto" (default):
 *     a "BREAKING CHANGE:" footer / "type!:" -> major,  feat: -> minor,  fix: / perf: / revert: -> patch,
 *     only chore/docs/ci/style/refactor/test/build/data commits -> no release (exit 0, released=false)
 *   (the rules and the version arithmetic are in scripts/semver.js)
 * - --ci: non-interactive mode for GitHub Actions: first brings the branch up to date with the remote (the daily
 *   data commits land on main too), and writes released/tag/version to $GITHUB_OUTPUT
 * - Writes the new version everywhere it is shown: package.json, site/js/app.js (APP_VERSION, shown in About,
 *   Settings and the side panel), site/sw.js (the cache name) and scraper/__init__.py (the data bot's User-Agent);
 *   the README shows the latest release with a badge
 * - Commits "chore(release): vX.Y.Z", tags vX.Y.Z and pushes both at once (git push --atomic: the branch and the
 *   tag land together or not at all). If the branch moved meanwhile, --ci rebases once and retries; otherwise it
 *   stops and says to re-run. The GitHub "Release" workflow, which runs this script when started by hand, then
 *   builds the Windows, macOS and Linux installers, publishes the GitHub Release and deploys GitHub Pages from that
 *   tag (with today's data).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const semver = require('./semver');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = n => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
const bumpArg = args.find(a => !a.startsWith('--')) || 'auto';

// git runs with an argument list, never through a shell: tag and branch names can't inject commands
const git = (argv, quiet) => execFileSync('git', argv, { cwd: root, stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'] }).toString().trim();
// a release tag: v + semantic version (the only kind this script reads or writes)
const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);

function output(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${v}\n`).join(''));
}

if (flag('show')) { console.log(JSON.parse(read('package.json')).version); process.exit(0); }

const branchName = () => { const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], true); return b === 'HEAD' ? 'main' : b; };
const branch = branchName();
// CI: release what is on the remote branch now (a data refresh may have landed since the run started)
if (flag('ci') && !flag('no-push')) git(['pull', '--rebase', '--quiet', 'origin', branch]);

const current = JSON.parse(read('package.json')).version;

function lastTag() {
  let tag;
  try { tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], true); } catch (e) { return null; }
  if (!TAG_RE.test(tag)) { console.error('The nearest v* tag is not a release tag (v<major>.<minor>.<patch>): ' + JSON.stringify(tag)); process.exit(1); }
  return tag;
}

function autoBump() {
  const tag = lastTag();
  return semver.bumpFor(git(['log', tag ? `${tag}..HEAD` : 'HEAD', '--format=%s%n%b'], true));
}

const auto = bumpArg === 'auto' ? autoBump() : null;
if (bumpArg === 'auto' && !auto) {
  console.log(`No release needed: no feat/fix/perf commits since ${lastTag() || 'the first commit'}.`);
  output({ released: 'false', tag: '', version: current });
  process.exit(0);
}
const kind = bumpArg === 'auto' ? auto : bumpArg;
if (!['major', 'minor', 'patch', 'prerelease'].includes(kind)) { console.error('Unknown bump: ' + kind); process.exit(1); }
const pre = opt('pre');
if (pre && !semver.validPre(pre)) { console.error('Invalid pre-release label: ' + pre); process.exit(1); }
const next = semver.format(semver.bump(semver.parse(current), kind, pre));
const tag = 'v' + next;
// the tag must be a valid git ref before anything is written or committed
try { if (!TAG_RE.test(tag)) throw new Error(); git(['check-ref-format', `refs/tags/${tag}`], true); } catch (e) { console.error('Not a valid tag name: ' + tag); process.exit(1); }

console.log(`${current} -> ${next}  (${bumpArg === 'auto' ? 'auto: ' : ''}${kind})`);

if (!flag('dry')) {
  if (git(['status', '--porcelain'], true)) { console.error('Working tree is not clean. Commit or stash first.'); process.exit(1); }
  try { git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], true); console.error('Tag already exists: ' + tag); process.exit(1); } catch (e) { /* ok */ }
}

// ---- rewrite every place the version is shown ----
const edits = [
  ['package.json', s => semver.withVersion(s, next)],
  ['site/js/app.js', s => s.replace(/const APP_VERSION = '[^']*';[^\n]*/, `const APP_VERSION = '${next}'; // app version; bump via scripts/release.js`)],
  ['site/sw.js', s => s.replace(/const VERSION = '[^']*';[^\n]*/, `const VERSION = 'sg-${next}'; // app version; bump via scripts/release.js`)],
  ['scraper/__init__.py', s => s.replace(/__version__ = "[^"]*"/, `__version__ = "${next}"`)]
];
// Every target must change; a pattern that no longer matches is fatal (also in --dry, so CI catches it) and is
// reported before anything is written or committed.
const rewritten = edits.map(([file, fn]) => { const before = read(file); return [file, before, fn(before)]; });
const stale = rewritten.filter(([, before, after]) => before === after).map(([file]) => file);
if (stale.length) {
  console.error('No version string to update in: ' + stale.join(', ') + '. Fix the pattern in scripts/release.js (nothing was written).');
  output({ released: 'false', tag: '', version: '' });
  process.exit(1);
}
for (const [file, , after] of rewritten) { console.log('  updated ' + file); if (!flag('dry')) write(file, after); }

if (flag('dry')) { console.log('Dry run: nothing written, committed or tagged.'); output({ released: 'false', tag, version: next }); process.exit(0); }

git(['add', '--', ...edits.map(([f]) => f)]);
git(['commit', '-q', '-m', `chore(release): ${tag}`]);
const tagIt = () => git(['tag', '-f', '-a', tag, '-m', `SAM's Garage ${tag}`], true);
tagIt();
console.log('Committed and tagged ' + tag);

if (flag('no-push')) { console.log('Not pushed (--no-push).'); output({ released: 'true', tag, version: next }); process.exit(0); }
const push = () => git(['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]);
try {
  push();
} catch (e) {
  let pushed = false;
  if (flag('ci')) {
    // The branch moved while this ran (most likely the daily data commit): replay the release commit on top of
    // it, move the tag there, and try once more.
    try { git(['pull', '--rebase', '--quiet', 'origin', branch]); tagIt(); push(); pushed = true; } catch (e2) { /* reported below */ }
  }
  if (!pushed) {
    console.error(`Push failed: ${branch} moved on the remote during the release (or the push was refused). Nothing was pushed: re-run the release.`);
    output({ released: 'false', tag: '', version: '' }); // the workflow summary then points at this step's log
    process.exit(1);
  }
}
console.log(`Pushed ${branch} and ${tag}.` + (flag('ci') ? '' : ' The Release workflow builds the installers and deploys the site.'));
output({ released: 'true', tag, version: next });
