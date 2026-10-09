import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape, toCSV, toJSON, primaryLink, exportName, CSV_COLUMNS } from '../js/export.js';
import { rec } from './helpers.mjs';

test('csvEscape: plain values pass through', () => {
  assert.equal(csvEscape('abc'), 'abc');
  assert.equal(csvEscape(42), '42');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(['a', 'b']), 'a; b');
});

test('csvEscape: commas, quotes, newlines and edge spaces are quoted', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('cr\r\nlf'), '"cr\r\nlf"');
  assert.equal(csvEscape(' padded '), '" padded "');
});

test('csvEscape: formula injection is neutralised, negative numbers are not', () => {
  assert.equal(csvEscape('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvEscape('+1+1'), "'+1+1");
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEscape('-cmd'), "'-cmd");
  assert.equal(csvEscape('-12.5'), '-12.5');
});

test('toCSV: BOM, header, CRLF rows, one row per record', () => {
  const r = rec({ id: 'sbirgov:1', title: 'Drones, "swarms"\nand more', phases: ['I', 'II'], keywords: ['uas', 'c-uas'],
    links: { official: 'https://example.gov/sol?a=1,2' } });
  const csv = toCSV([r, rec({ id: 'sbirgov:2' })]);
  assert.ok(csv.startsWith('﻿id,title,status,'));
  assert.ok(csv.endsWith('\r\n'));
  const body = csv.slice(1);
  assert.ok(body.includes('"Drones, ""swarms""\nand more"'));
  assert.ok(body.includes('I; II'));
  assert.ok(body.includes('"https://example.gov/sol?a=1,2"'));
  // header + 2 records; the embedded \n is inside quotes, so split on CRLF only
  assert.equal(body.trimEnd().split('\r\n').length, 3);
  assert.equal(body.split('\r\n')[0].split(',').length, CSV_COLUMNS.length);
});

test('toJSON and helpers', () => {
  const r = rec({ id: 'a' });
  assert.deepEqual(JSON.parse(toJSON([r])), [r]);
  assert.equal(primaryLink(rec({ source: 'dod_dsip', links: { dod_dsip: 'https://d', official: null } })), 'https://d');
  assert.equal(primaryLink(rec({ links: {} })), '');
  assert.equal(exportName('csv', '2026-10-09'), 'sbir-topics-2026-10-09.csv');
});
