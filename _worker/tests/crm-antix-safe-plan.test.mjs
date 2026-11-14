import test from 'node:test';
import assert from 'node:assert/strict';
import { planAntixBatch } from '../crm-antix-safe-plan.js';

const hash = 'a'.repeat(64);
const item = (uid, phone, title = 'عميل اصطناعي') => ({ conversation_uid: `wa:${uid}`, selected_phone: `+${phone}`,
  title, message_count: 1, first_message_at: '2025-11-13T02:13:00.000Z',
  last_message_at: '2025-11-13T02:15:00.000Z', raw_sha256: hash });
const contact = (uid, phone) => ({ ...item(uid, phone, '🟢 عميل اصطناعي'), message_count: 0,
  first_message_at: null, last_message_at: null,
  raw_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
const excluded = ['مثال مستبعد'];

test('holds contact-only existing owners without changing or linking them, plans other candidates separately', () => {
  const snapshot = { contacts: [{ id: 'one', name: '🟢 عميل اصطناعي' }, { id: 'two', name: 'عميل اصطناعي آخر' }],
    phones: [{ contact_id: 'one', phone_key: '201111111111' }, { contact_id: 'two', phone_key: '201022222222' }], conversations: [] };
  const held = contact('held', '201111111111');
  const matched = item('matched', '201022222222');
  const missing = item('missing', '201222222222', 'اسم اصطناعي جديد');
  const before = JSON.stringify({ snapshot, held, matched, missing });
  const plan = planAntixBatch([held, matched, missing], snapshot, excluded);
  assert.deepEqual(plan.held, [held]);
  assert.deepEqual(plan.eligible, [matched, missing]);
  assert.equal(JSON.stringify({ snapshot, held, matched, missing }), before);
});

test('holds protected owners, multiple owners, existing UID and name collision', () => {
  const snapshot = { contacts: [{ id: 'a', name: '🌀 مستبعد' }, { id: 'b', name: '🟢 اصطناعي' },
    { id: 'c', name: 'شخص اصطناعي آخر' }], phones: [
    { contact_id: 'a', phone_key: '201111111111' },
    { contact_id: 'b', phone_key: '201222222222' },
    { contact_id: 'c', phone_key: '201222222222' },
  ], conversations: [{ conversation_uid: 'wa:prior', contact_id: 'b' }] };
  const rows = [item('protected', '201111111111'), item('multiple', '201222222222'),
    item('prior', '201033333333'), item('name', '201055555555', '🟢 اصطناعي')];
  assert.deepEqual(planAntixBatch(rows, snapshot, excluded), { eligible: [], held: rows });
});

test('rejects incomplete snapshots, exclusions, duplicates and invalid data before planning', () => {
  const snapshot = { contacts: [], phones: [], conversations: [] };
  const row = item('one', '201111111111');
  assert.throws(() => planAntixBatch([row], { ...snapshot, phones: null }, excluded), /unverified-snapshot/);
  assert.throws(() => planAntixBatch([row], { ...snapshot, phones: [{ phone_key: '201111111111', contact_id: 'missing' }] }, excluded), /unverified-snapshot/);
  assert.throws(() => planAntixBatch([row], snapshot, []), /private-exclusions-required/);
  assert.throws(() => planAntixBatch([row, row], snapshot, excluded), /invalid/);
  assert.throws(() => planAntixBatch([{ ...row, title: '🌀 اصطناعي' }], snapshot, excluded), /invalid/);
});
