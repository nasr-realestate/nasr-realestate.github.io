import test from 'node:test';
import assert from 'node:assert/strict';
import { operationalQueuesPayload } from '../../_worker/crm-interactions.js';

/** A DB stub: every query resolves to the rows registered for its marker. */
function fakeDb({ requests = null, throwOnRequests = false } = {}) {
  return {
    prepare(sql) {
      const isRequests = /crm_customer_requests/.test(sql);
      return {
        bind: () => ({
          all: async () => {
            if (isRequests) {
              if (throwOnRequests) throw new Error('no such table: crm_customer_requests');
              return { results: requests ?? [] };
            }
            return { results: [] };
          },
          first: async () => null,
        }),
      };
    },
  };
}

const NOW = '2026-11-07T09:00:00Z';

test('Q-1 the seven-day clock rides on the queue without breaking it', async () => {
  const db = fakeDb({
    requests: [
      { id: 'r1', status: 'active', created_at: '2026-11-01T09:00:00Z', contact_name: 'أ' }, // closing
      { id: 'r2', status: 'new', created_at: '2026-11-06T09:00:00Z', contact_name: 'ب' },    // fresh
      { id: 'r3', status: 'active', created_at: '2026-10-01T09:00:00Z', contact_name: 'ج' }, // expired
    ],
  });
  const out = await operationalQueuesPayload(db, { now: NOW, limit: 10 });
  assert.equal(out.counts.expiring, 2, 'only closing and expired are worth a row');
  assert.deepEqual(out.expiring_requests.map((r) => r.id), ['r1', 'r3']);
  assert.equal(out.expiring_requests[0].window.state, 'closing');
  assert.equal(out.expiring_requests[1].window.state, 'expired');
  assert.match(out.expiring_requests[1].window.action, /هل ما زلت تبحث/);
});

test('Q-2 an environment without the requests table still serves the queue', async () => {
  const out = await operationalQueuesPayload(fakeDb({ throwOnRequests: true }), { now: NOW, limit: 5 });
  assert.deepEqual(out.expiring_requests, []);
  assert.equal(out.counts.expiring, 0);
  assert.equal(new Date(out.as_of).toISOString(), new Date(NOW).toISOString());
  assert.equal(out.timezone, 'Africa/Cairo');
});

test('Q-3 no open requests means an empty clock, not a missing key', async () => {
  const out = await operationalQueuesPayload(fakeDb({ requests: [] }), { now: NOW });
  assert.ok(Array.isArray(out.expiring_requests));
  assert.equal(out.expiring_requests.length, 0);
});
