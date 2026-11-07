import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_WINDOW_DAYS, requestState, requestAction, isReadyToGraduate,
} from '../crm/request-window.mjs';

const ASKED = '2026-11-01T09:00:00Z';
const day = (n) => new Date(Date.parse(ASKED) + n * 86_400_000).toISOString();

test('RW-1 the window is seven days, by his own rule', () => {
  assert.equal(REQUEST_WINDOW_DAYS, 7);
});

test('RW-2 the request stays alive, then narrows, then dies', () => {
  assert.equal(requestState({ askedAt: ASKED, now: day(0) }).state, 'fresh');
  assert.equal(requestState({ askedAt: ASKED, now: day(3) }).state, 'fresh');
  assert.equal(requestState({ askedAt: ASKED, now: day(3) }).daysLeft, 4);
  assert.equal(requestState({ askedAt: ASKED, now: day(6) }).state, 'closing');
  assert.equal(requestState({ askedAt: ASKED, now: day(6) }).daysLeft, 1);
  assert.equal(requestState({ askedAt: ASKED, now: day(7) }).state, 'expired');
  assert.equal(requestState({ askedAt: ASKED, now: day(60) }).state, 'expired');
});

test('RW-3 an offer inside the window graduates him; one after it does not', () => {
  const inside = requestState({ askedAt: ASKED, servedAt: day(5), now: day(6) });
  assert.equal(inside.state, 'met');
  const late = requestState({ askedAt: ASKED, servedAt: day(30), now: day(31) });
  assert.equal(late.state, 'expired', 'a pitch two months later is not a service');
});

test('RW-4 the action changes with the state: a live request is a pitch, a dead one a question', () => {
  assert.match(requestAction({ state: 'fresh' }), /اعرض/);
  assert.match(requestAction({ state: 'closing' }), /آخر فرصة/);
  assert.match(requestAction({ state: 'expired' }), /هل ما زلت تبحث/);
  assert.doesNotMatch(requestAction({ state: 'expired' }), /اعرض عليه الآن/);
});

test('RW-5 graduation needs a number and something actually exchanged', () => {
  assert.equal(isReadyToGraduate({ hasNumber: false, servedInWindow: true, repliedAfterOffer: true }), false);
  assert.equal(isReadyToGraduate({ hasNumber: true, servedInWindow: true, repliedAfterOffer: false }), false);
  assert.equal(isReadyToGraduate({ hasNumber: true, servedInWindow: true, repliedAfterOffer: true }), true);
  assert.equal(isReadyToGraduate({ hasNumber: true, servedInWindow: false, requests: 2 }), true);
  assert.equal(isReadyToGraduate({ hasNumber: true, servedInWindow: false, requests: 1 }), false);
});

test('RW-6 a broken date is never guessed', () => {
  const s = requestState({ askedAt: 'not-a-date', now: day(1) });
  assert.equal(s.state, 'unknown');
  assert.match(requestAction(s), /تحقّق/);
});
