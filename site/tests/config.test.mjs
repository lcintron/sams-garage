// Shareable links: the page's own address on the web, the public site from the desktop app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_URL, publicBase, topicLink } from '../js/config.js';

test('topicLink builds #/s/<id> links', () => {
  assert.equal(topicLink('https://x.test/app/', 'dsip:A26B-T014'), 'https://x.test/app/#/s/dsip:A26B-T014');
  assert.equal(topicLink('https://x.test/', 'grants:a b/c'), 'https://x.test/#/s/grants:a%20b%2Fc');
});

test('publicBase: the web page itself, else the public site', () => {
  assert.equal(publicBase({ protocol: 'https:', href: 'https://sg.example/?q=1#/s/x' }), 'https://sg.example/?q=1');
  assert.equal(publicBase({ protocol: 'http:', href: 'http://localhost:8091/#/' }), 'http://localhost:8091/');
  assert.equal(publicBase({ protocol: 'app:', href: 'app://sg/index.html#/s/x' }), PUBLIC_URL);
  assert.equal(publicBase(undefined), PUBLIC_URL);
  assert.match(PUBLIC_URL, /^https:\/\/.+\/$/);
});

test("index.html's link previews point at PUBLIC_URL", () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  const urls = [...html.matchAll(/<meta (?:property|name)="(?:og:url|og:image|twitter:image)" content="([^"]+)"/g)].map(m => m[1]);
  assert.equal(urls.length, 3);
  for (const u of urls) assert.ok(u.startsWith(PUBLIC_URL), u);
});
