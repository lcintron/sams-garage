/* SAM's Garage - semantic versions and the conventional-commit bump rules (no dependencies), used by
 * scripts/release.js and tested in site/tests/release.test.mjs. */

/** "1.2.3" or "1.2.3-Beta.1" -> { major, minor, patch, pre }. */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error('Not a semantic version: ' + v);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function format(v) { return `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`; }

/**
 * The bump the commits call for (subjects and bodies, one per line, as `git log --format=%s%n%b` prints them):
 *   a "BREAKING CHANGE:" (or "BREAKING-CHANGE:") footer line, or "type!:" / "type(scope)!:" -> 'major'
 *   feat: -> 'minor';  fix: / perf: / revert: -> 'patch'
 *   anything else (chore, docs, ci, style, refactor, test, build, data, chore(release)) -> null: nothing to release
 * The words "BREAKING CHANGE" inside a sentence do not count.
 */
function bumpFor(log) {
  if (!String(log || '').trim()) return null;
  if (/^BREAKING[ -]CHANGE:|^[a-z]+(\([^)]*\))?!:/m.test(log)) return 'major';
  if (/^feat(\([^)]*\))?:/m.test(log)) return 'minor';
  if (/^(fix|perf|revert)(\([^)]*\))?:/m.test(log)) return 'patch';
  return null;
}

/** The next version: kind is major | minor | patch | prerelease; pre is an optional pre-release label. */
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
  // So leaving one with minor or major skips a number (0.2.1-Beta.0 + minor -> 0.3.0), as in GenGIS.
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

/** Valid semver pre-release label: dot-separated groups of letters, digits and dashes, no leading zeros. */
function validPre(pre) {
  return /^[0-9A-Za-z][0-9A-Za-z-]*(\.[0-9A-Za-z][0-9A-Za-z-]*)*$/.test(pre) && !/(^|\.)0\d+(\.|$)/.test(pre);
}

/** package.json text with a new version (2-space JSON and a trailing newline, as the file is kept). */
function withVersion(packageJson, version) {
  const pkg = JSON.parse(packageJson);
  pkg.version = version;
  return JSON.stringify(pkg, null, 2) + '\n';
}

module.exports = { parse, format, bumpFor, bump, validPre, withVersion };
