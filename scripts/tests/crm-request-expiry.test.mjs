import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateRequest, withWindows } from '../../_worker/crm-request-expiry.js';
import { requestState } from '../crm/request-window.mjs';

const NOW = '2026-11-07T09:00:00Z';
const req = (created, status = 'active', id = 'req-1') => ({ id, status, created_at: created, contact_name: 'عميل' });

test('EXP-1 a request is decorated with its window, and the row itself is untouched', () => {
  const row = req('2026-11-04T09:00:00Z');
  const out = decorateRequest(row, NOW);
  assert.equal(out.id, 'req-1');
  assert.equal(out.window.state, 'fresh');
  assert.equal(out.window.window_days, 7);
  assert.equal(out.window.days_left, requestState({ askedAt: row.created_at, now: NOW }).daysLeft);
  assert.equal(row.window, undefined, 'no mutation of the stored row');
});

test('EXP-2 the last two days are the last chance, and day seven closes it', () => {
  assert.equal(decorateRequest(req('2026-11-01T09:00:00Z'), NOW).window.state, 'closing');
  assert.equal(decorateRequest(req('2026-10-31T09:00:00Z'), NOW).window.state, 'expired');
  assert.match(decorateRequest(req('2026-10-31T09:00:00Z'), NOW).window.action, /هل ما زلت تبحث/);
});

test('EXP-3 a closed file has no clock to run', () => {
  for (const status of ['closed', 'cancelled']) {
    const out = decorateRequest(req('2026-01-01T00:00:00Z', status), NOW);
    assert.equal(out.window.state, 'settled');
    assert.equal(out.window.days_left, null);
  }
});

test('EXP-4 decorating a list keeps order, length and every other field', () => {
  const payload = { requests: [req('2026-11-06T09:00:00Z', 'active', 'a'), req('2026-10-01T09:00:00Z', 'active', 'b')], count: 2, total: 9 };
  const out = withWindows(payload, NOW);
  assert.deepEqual(out.requests.map((r) => r.id), ['a', 'b']);
  assert.equal(out.count, 2);
  assert.equal(out.total, 9);
  assert.equal(out.requests[0].window.state, 'fresh');
  assert.equal(out.requests[1].window.state, 'expired');
});

test('EXP-5 a payload without requests is returned as-is', () => {
  assert.deepEqual(withWindows({ error: 'x' }, NOW), { error: 'x' });
  assert.equal(withWindows(null, NOW), null);
});
