// Card/detail wording for open and close dates (js/ui/dom.js has no DOM access at import time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateLabel, isEstimated } from '../js/ui/dom.js';
import { rec } from './helpers.mjs';

test('open/closed records keep the usual wording', () => {
  assert.equal(dateLabel(rec({ status: 'open' }), 'close', 3).cls, 'soon');
  assert.match(dateLabel(rec({ status: 'open' }), 'close', 3).text, /^Closes .* · in 3 days$/);
  assert.equal(dateLabel(rec({ status: 'open' }), 'close', 30).cls, '');
  const closed = dateLabel(rec({ status: 'closed', close_date: '2026-09-01' }), 'close', -38);
  assert.equal(closed.cls, 'past');
  assert.match(closed.text, /^Closed /);
  assert.equal(dateLabel(rec({ close_date: null }), 'close', null), null);
});

test('forecasted / pre-release dates are estimates; a passed one is not "Closed"', () => {
  const stale = rec({ status: 'forecasted', close_date: '2025-11-20' });
  assert.equal(isEstimated(stale), true);
  const l = dateLabel(stale, 'close', -323);
  assert.equal(l.cls, 'est-passed');
  assert.match(l.text, /^Est\. close .*2025 \(date passed\)$/);
  assert.doesNotMatch(l.text, /Closed/);
  const soon = dateLabel(rec({ status: 'pre_release' }), 'close', 2);
  assert.equal(soon.cls, '', 'no red treatment for an estimate');
  assert.match(soon.text, /^Est\. close .* · in 2 days$/);
  assert.match(dateLabel(rec({ status: 'pre_release', open_date: '2026-10-01' }), 'open', -8).text, /^Est\. open .*\(date passed\)$/);
  assert.equal(isEstimated(rec({ status: 'open' })), false);
});
