import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WIDE_MIN, panelMode, parseRoute, viewOf, keepsState, activeNav, showsFilters, isSecondary, homeHref, watchHref,
  viewTitle, panelCollapsedPref, themeChoice
} from '../js/nav.js';
import { defaultState, parseQuery, splitHash } from '../js/filters.js';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(site, f), 'utf8');

test('panel mode: docked from 1280 px, an overlay drawer below', () => {
  assert.equal(WIDE_MIN, 1280);
  assert.equal(panelMode(1280), 'docked');
  assert.equal(panelMode(1920), 'docked');
  assert.equal(panelMode(1279), 'overlay');
  assert.equal(panelMode(1100), 'overlay');
  assert.equal(panelMode(375), 'overlay');
});

test('the CSS and app.js breakpoints match WIDE_MIN', () => {
  const css = read('css/app.css');
  assert.ok(css.includes(`@media (min-width: ${WIDE_MIN}px)`), 'docked rules');
  assert.ok(css.includes(`@media (max-width: ${WIDE_MIN - 1}px)`), 'drawer rules');
  assert.match(read('js/app.js'), /matchMedia\(`\(min-width: \$\{WIDE_MIN\}px\)`\)/);
});

test('routes', () => {
  assert.deepEqual(parseRoute('/'), { name: 'list', id: null, mode: 'all' });
  assert.deepEqual(parseRoute(''), { name: 'list', id: null, mode: 'all' });
  assert.deepEqual(parseRoute('/watch'), { name: 'list', id: null, mode: 'watch' });
  for (const v of ['sql', 'notify', 'settings', 'about']) assert.deepEqual(parseRoute('/' + v), { name: v });
  assert.deepEqual(parseRoute('/s/dsip:A1'), { name: 'detail', id: 'dsip:A1' });
  assert.deepEqual(parseRoute('/s/a%2Fb'), { name: 'detail', id: 'a/b' });
  assert.deepEqual(parseRoute('/s/%E0%A4%A'), { name: 'detail', id: '%E0%A4%A' }, 'a bad escape is kept as it is');
  for (const bad of ['/nope', '/SQL', '/sql/x', '/s/', '/constructor', '/toString', '/hasOwnProperty']) assert.equal(parseRoute(bad), null, bad);
});

test('the active panel item for each route', () => {
  const r = p => parseRoute(splitHash(p).path);
  assert.equal(activeNav(r('#/')), 'home');
  assert.equal(activeNav(r('#/?q=uas')), 'home');
  assert.equal(activeNav(r('#/s/dsip:A1'), 'all'), 'home');
  assert.equal(activeNav(r('#/s/dsip:A1'), 'watch'), 'watch', 'a topic opened from the watchlist');
  assert.equal(activeNav(r('#/watch')), 'watch');
  assert.equal(activeNav(r('#/watch'), 'all'), 'watch', 'the route says which list');
  assert.equal(activeNav(r('#/sql')), 'sql');
  assert.equal(activeNav(r('#/notify?report=last')), 'notify');
  assert.equal(activeNav(r('#/settings')), 'settings');
  assert.equal(activeNav(r('#/about')), 'about');
  assert.equal(activeNav(null), null);
});

test('every panel item in index.html is one activeNav names, and the home item keeps a Home icon', () => {
  const html = read('index.html');
  const items = [...html.matchAll(/data-nav="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(items)].sort(), ['about', 'home', 'notify', 'settings', 'sql', 'watch']);
  for (const v of ['sql', 'notify', 'settings', 'about']) {
    assert.ok(html.includes(`id="${v}View"`) && html.includes(`id="${v}Body"`), v + ' view and body');
  }
  assert.equal((html.match(/class="btn small ghost back-home"/g) || []).length, 5, 'a back link on the watchlist and on each view');
  assert.ok(!/brand-short/.test(html) && !/brand-short/.test(read('css/app.css')), 'no "Sg" next to the logo');
  assert.match(html, /id="menuBtn"[^>]*aria-controls="sidepanel"[^>]*aria-expanded/);
});

test('views, the filters section and Esc', () => {
  const list = parseRoute('/'), watch = parseRoute('/watch'), det = parseRoute('/s/x');
  assert.equal(viewOf(list), 'list');
  assert.equal(viewOf(det), 'list');
  assert.equal(viewOf(watch), 'list');
  assert.equal(viewOf(parseRoute('/settings')), 'settings');
  assert.equal(showsFilters(list), true);
  assert.equal(showsFilters(det, 'all'), true);
  assert.equal(showsFilters(det, 'watch'), false);
  assert.equal(showsFilters(watch), false);
  for (const v of ['sql', 'notify', 'settings', 'about']) {
    assert.equal(showsFilters(parseRoute('/' + v)), false, v);
    assert.equal(isSecondary(parseRoute('/' + v)), true, v);
    assert.equal(keepsState(parseRoute('/' + v)), false, v + ' leaves the filters as they were');
  }
  assert.equal(isSecondary(watch), true);
  assert.equal(isSecondary(list), false);
  assert.equal(isSecondary(det), false, 'a detail has its own Back');
  assert.equal(isSecondary(null), false);
  assert.ok(keepsState(list) && keepsState(watch) && keepsState(det));
});

test('back links keep the filter query', () => {
  const s = { ...defaultState(), q: 'counter uas', agency: ['DOD'], closing: 30, sort: 'close' };
  const h = homeHref(s);
  assert.ok(h.startsWith('#/?'));
  assert.deepEqual(parseQuery(splitHash(h).query), s);
  assert.equal(splitHash(h).path, '/');
  assert.equal(homeHref(defaultState()), '#/');
  assert.equal(watchHref(defaultState()), '#/watch');
  // the watchlist carries the whole state: its search and sort apply there, the filters are kept for the way back
  assert.deepEqual(parseQuery(splitHash(watchHref(s)).query), s);
  assert.equal(parseQuery(splitHash(watchHref(s)).query).q, 'counter uas');
  assert.equal(splitHash(watchHref(s)).path, '/watch');
});

test('the result count calls the watchlist\'s topics "starred"', async () => {
  const { renderCount } = await import('../js/ui/stats.js');
  const el = { textContent: '' };
  renderCount(el, 3, 7, 'watch');
  assert.equal(el.textContent, '3 of 7 starred');
  renderCount(el, 7, 7, 'watch');
  assert.equal(el.textContent, '7 starred');
  renderCount(el, 54, 68, 'all');
  assert.equal(el.textContent, '54 of 68 topics');
});

test('document titles', () => {
  assert.equal(viewTitle('settings'), "Settings · SAM's Garage");
  assert.equal(viewTitle('sql'), "SQL console · SAM's Garage");
  assert.equal(viewTitle('notify'), "Notifications · SAM's Garage");
  assert.equal(viewTitle('about'), "About · SAM's Garage");
});

test('the collapsed-panel preference reads its old name', () => {
  assert.equal(panelCollapsedPref({}), false);
  assert.equal(panelCollapsedPref(null), false);
  assert.equal(panelCollapsedPref({ filtersCollapsed: true }), true, 'the old preference');
  assert.equal(panelCollapsedPref({ filtersCollapsed: true, panelCollapsed: false }), false, 'the new one wins');
  assert.equal(panelCollapsedPref({ filtersCollapsed: false, panelCollapsed: true }), true);
  // index.html applies it before the first paint with the same rule
  assert.match(read('index.html'), /typeof p\.panelCollapsed === 'boolean' \? p\.panelCollapsed : p\.filtersCollapsed/);
});

test('theme choice', () => {
  assert.equal(themeChoice({ theme: 'light' }), 'light');
  assert.equal(themeChoice({ theme: 'dark' }), 'dark');
  assert.equal(themeChoice({ theme: null }), 'system');
  assert.equal(themeChoice({ theme: 'sepia' }), 'system');
  assert.equal(themeChoice({}), 'system');
  assert.equal(themeChoice(undefined), 'system');
});

test('APP_VERSION is defined once, in app.js, and the side panel shows it', () => {
  const app = read('js/app.js');
  assert.match(app, /const APP_VERSION = '\d+\.\d+\.\d+';/);
  assert.match(app, /'#appVersion'\)\.textContent = .*APP_VERSION/);
  assert.ok(!/v?\d+\.\d+\.\d+/.test(read('index.html').match(/id="appVersion"[^<]*</)[0]), 'not hard-coded in the page');
});
