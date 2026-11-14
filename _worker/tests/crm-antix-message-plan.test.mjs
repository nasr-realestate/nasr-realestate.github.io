import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { previewAntixMessagePlan as plan } from '../crm-antix-message-plan.js';

const h = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const message = (key = 'stable_key_01') => ({ key_kind: 'wa_key_id', source_key: key,
  sent_at: '2026-11-10T12:00:00.000Z', sender_role: 'customer', body_text: 'رسالة اصطناعية' });
const input = (messages = [message()]) => ({ conversation_uid: 'wa:synthetic', selected_phone: '+201111111111',
  window_end: '2026-11-14T12:00:00.000Z', messages });
const snapshot = () => ({ conversations: [{ id: 'c1', conversation_uid: 'wa:synthetic', contact_id: 'p1', source_ref: 'antix_metadata_v1' }],
  phones: [{ phone_key: '201111111111', contact_id: 'p1' }], contacts: [{ id: 'p1', name: 'عميل اصطناعي' }], messages: [] });
const exclusions = ['اسم مستبعد'];
const existing = m => ({ conversation_id: 'c1', message_uid: h(['antix-message-key-v1', 'wa:synthetic', m.source_key]),
  content_sha256: h([m.sent_at, m.sender_role, m.body_text]) });

test('preview returns only counts; repeated stable key survives a moving window', async () => {
  const m = message(), db = snapshot();
  assert.deepEqual(await plan(input(), db, exclusions), { candidates: 1, unchanged: 0, held: 0 });
  db.messages.push(existing(m));
  const shifted = { ...input(), window_end: '2026-11-15T12:00:00.000Z' };
  const result = await plan(shifted, db, exclusions);
  assert.deepEqual(result, { candidates: 0, unchanged: 1, held: 0 });
  assert.doesNotMatch(JSON.stringify(result), /اصطناعية|201111111111|stable_key/);
});

test('same body with different source keys stays distinct; edited content is held', async () => {
  const a = message('one'), b = message('two'), db = snapshot();
  db.messages.push(existing(a));
  assert.deepEqual(await plan(input([{ ...a, body_text: 'تعديل اصطناعي' }, b]), db, exclusions),
    { candidates: 1, unchanged: 0, held: 1 });
});

test('missing source keys, duplicate keys and out-of-window messages fail closed', async () => {
  const db = snapshot();
  await assert.rejects(plan(input([{ ...message(), key_kind: 'row_id' }]), db, exclusions), /invalid-message/);
  await assert.rejects(plan(input([message(), message()]), db, exclusions), /invalid-message/);
  await assert.rejects(plan(input([{ ...message(), sent_at: '2026-10-29T12:00:00.000Z' }]), db, exclusions), /outside-window/);
  await assert.rejects(plan(input([{ ...message(), sent_at: '2026-11-15T12:00:00.000Z' }]), db, exclusions), /outside-window/);
});

test('phone owner, conversation, exclusions and prior message snapshots must agree', async () => {
  for (const mutate of [
    x => x.phones.push({ ...x.phones[0] }),
    x => { x.conversations[0].contact_id = 'different'; },
    x => { x.conversations[0].source_ref = 'other'; },
    x => { x.contacts[0].name = '🌀 محظور'; },
    x => { x.messages.push({ ...existing(message()), conversation_id: 'wrong' }); },
  ]) {
    const db = snapshot(); mutate(db);
    await assert.rejects(plan(input(), db, exclusions));
  }
  await assert.rejects(plan(input(), snapshot(), []), /invalid-plan/);
});
