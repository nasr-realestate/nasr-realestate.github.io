import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, nextDate, bucketOf, buildDayList, daysBetween, TERMINAL,
} from '../crm/followup-dates.mjs';

const T = '2026-11-07';

test('DT-1 law one: every live state yields a date, terminal states yield none', () => {
  for (const state of Object.keys(STATES)) {
    const r = nextDate({ state, from: T, hasNewProperty: true });
    assert.ok(r.at, `${state} must schedule a date`);
    assert.ok(r.why, `${state} must carry a reason`);
  }
  for (const state of TERMINAL) {
    assert.equal(nextDate({ state, from: T }).at, null);
  }
});

test('DT-2 law two: no offer is invented when no matching property exists', () => {
  // A viewed client with nothing new to show does not get an "offer" message.
  const r = nextDate({ state: 'viewed', from: T, hasNewProperty: false });
  assert.equal(r.why, 'ask-still-looking');
  assert.equal(r.at, '2026-11-10');
  // Same client, and a matching flat was just re-priced: now the offer is real.
  const o = nextDate({ state: 'viewed', from: T, hasNewProperty: true });
  assert.equal(o.why, 'offer-match');
  assert.equal(o.at, '2026-11-09');
});

test('DT-3 an appointment falls due on its own day, not N days later', () => {
  const r = nextDate({ state: 'viewing-booked', from: '2026-11-12T14:30:00Z' });
  assert.equal(r.at, '2026-11-12');
  assert.equal(r.why, 'confirm-appointment');
});

test('DT-4 unanswered attempts go dormant instead of nagging forever', () => {
  const one = nextDate({ state: 'considering', from: T, attempts: 0 });
  const two = nextDate({ state: 'considering', from: T, attempts: 1 });
  assert.ok(daysBetween(T, two.at) > daysBetween(T, one.at), 'gaps must stretch');
  const gone = nextDate({ state: 'considering', from: T, attempts: 3 });
  assert.equal(gone.state, 'dormant');
  assert.equal(gone.at, null);
});

test('DT-5 buckets are exact on the day boundary', () => {
  assert.equal(bucketOf('2026-11-05', T), 'overdue');
  assert.equal(bucketOf(T, T), 'today');
  assert.equal(bucketOf('2026-11-08', T), 'upcoming');
  assert.equal(bucketOf(null, T), 'none');
  // A date with a time component on the same day is still "today".
  assert.equal(bucketOf('2026-11-07T23:59:00Z', T), 'today');
});

test('DT-6 the day list is capped, ranked, and says what it held back', () => {
  const clients = [
    { id: 'a', name: 'حازم', state: 'no-match', due_at: '2026-10-01', why: 'ask-still-looking' },
    { id: 'b', name: 'راندا', state: 'closing', due_at: '2026-11-07', why: 'move-paperwork' },
    { id: 'c', name: 'هشام', state: 'owner-listing', due_at: '2026-11-06', why: 'report-views' },
    { id: 'd', name: 'عزة', state: 'viewed', due_at: '2026-11-08', why: 'offer-match' },
  ];
  const day = buildDayList(clients, T);
  assert.deepEqual(day.items.map((i) => i.id), ['b', 'c', 'a'], 'paperwork first even when others are stale');
  assert.equal(day.counts.overdue, 2);
  assert.equal(day.counts.today, 1);

  const tight = buildDayList(clients, T, { cap: 2 });
  assert.equal(tight.items.length, 2);
  assert.equal(tight.held_back, 1, 'the broker must see that something was held back');
});

test('DT-7 a client with no reason is never put on the list', () => {
  const day = buildDayList([{ id: 'x', name: 'بلا سبب', state: 'dormant', due_at: T }], T);
  assert.equal(day.items.length, 0);
});

test('DT-8 unknown state and bad dates fail loudly', () => {
  assert.throws(() => nextDate({ state: 'wat', from: T }), /unknown-state/);
  assert.throws(() => bucketOf('not-a-date', T), /bad-date/);
});
