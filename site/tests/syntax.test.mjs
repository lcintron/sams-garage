// Every script parses: the site's modules (an import that fails to parse only breaks the route that loads it,
// e.g. the About view), the shared notification scripts, the service worker, the desktop app and the scripts
// (release, notifications).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const jsIn = (dir, deep) => (deep ? walk(path.join(root, dir)) : fs.readdirSync(path.join(root, dir)).map(f => path.join(root, dir, f)))
  .filter(f => /\.m?js$/.test(f));

const files = [...jsIn('site/js', true), path.join(root, 'site', 'sw.js'), ...jsIn('electron', false), ...jsIn('scripts', false)];

test('the file list covers the app', () => {
  for (const f of ['site/js/app.js', 'site/js/nav.js', 'site/js/ui/about.js', 'site/js/ui/settings.js', 'site/js/ui/notify-view.js', 'site/js/notify/core.js', 'site/js/notify/idb.js',
    'site/js/notify/runner.js', 'site/js/notify/page.js', 'site/sw.js', 'electron/main.js', 'electron/notify.js', 'electron/notify-store.js',
    'electron/notify-scheduler.js', 'electron/notify-core.js', 'scripts/release.js', 'scripts/notify.mjs']) {
    assert.ok(files.includes(path.join(root, f)), f);
  }
});

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  test(`node --check ${rel}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel} does not parse:\n${r.stderr}`);
  });
}
