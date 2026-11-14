import test from 'node:test';
import assert from 'node:assert/strict';
import { issuePlanToken, verifyPlanToken } from '../crm-antix-plan-token.js';

const now = Date.parse('2026-11-14T20:00:00.000Z');
const opts = { now, scopeEnd: '2026-11-14T19:59:00.000Z', secret: 'synthetic-secret-only-0123456789abcdef',
  backupRef: 'verified-backup-synthetic', excludedNames: ['مثال مستبعد'] };
const msg = (uid, phone) => ({ conversation_uid: `wa:${uid}`, selected_phone: `+${phone}`, title: 'اسم اصطناعي',
  message_count: 1, first_message_at: '2026-11-12T08:00:00.000Z', last_message_at: '2026-11-12T08:00:00.000Z', raw_sha256: 'a'.repeat(64) });
const contact = { ...msg('held', '201111111111'), title: '🟢 اسم اصطناعي', message_count: 0,
  first_message_at: null, last_message_at: null,
  raw_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
const candidate = msg('candidate', '201022222222');
const snapshot = { contacts: [{ id: 'a', name: '🟢 اسم اصطناعي' }],
  phones: [{ phone_key: '201111111111', contact_id: 'a' }], conversations: [] };

test('token binds approved candidates while holding conflicts and reveals no identity', async () => {
  const issued = await issuePlanToken([contact, candidate], snapshot, opts);
  assert.equal(issued.candidates, 1);
  assert.equal(issued.held, 1);
  assert.doesNotMatch(JSON.stringify(issued), /اسم|201111111111|wa:candidate/);
  const result = await verifyPlanToken([contact, candidate], snapshot, issued.token, opts);
  assert.deepEqual(result, { candidates: [candidate], held: 1 });
});

test('token refuses changed source, candidates, exclusions, owner, reference or tampering', async () => {
  const issued = await issuePlanToken([contact, candidate], snapshot, opts);
  const cases = [
    [[contact, { ...candidate, title: 'تغيير اصطناعي' }], snapshot, issued.token, opts],
    [[contact, candidate], { ...snapshot, contacts: [], phones: [] }, issued.token, opts],
    [[contact, candidate], snapshot, issued.token, { ...opts, excludedNames: ['اسم مستبعد آخر'] }],
    [[contact, candidate], snapshot, issued.token, { ...opts, backupRef: 'another-backup' }],
    [[contact, candidate], snapshot, issued.token.slice(0, -1) + (issued.token.endsWith('0') ? '1' : '0'), opts],
  ];
  for (const args of cases) await assert.rejects(verifyPlanToken(...args));
});

test('token rejects stale scope, messages outside 15-day window, and invalid secret', async () => {
  await assert.rejects(issuePlanToken([candidate], snapshot, { ...opts, now: now + 61 * 60 * 1000 }), /stale-scope/);
  await assert.rejects(issuePlanToken([{ ...candidate, first_message_at: '2026-10-01T00:00:00.000Z' }], snapshot, opts), /outside-window/);
  await assert.rejects(issuePlanToken([candidate], snapshot, { ...opts, secret: 'short' }), /missing-plan-secret/);
  const issued = await issuePlanToken([candidate], snapshot, opts);
  await assert.rejects(verifyPlanToken([candidate], snapshot, issued.token, { ...opts, now: now + 2 * 60 * 60 * 1000 }));
});
