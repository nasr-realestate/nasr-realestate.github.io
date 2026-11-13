import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSourceSyncBundle } from '../crm-sync-and-match.js';

test('antiX phone evidence cannot be written or mixed with name-matching contacts', async () => {
  const db = { prepare() { throw new Error('guard must reject before database access'); } };
  const conversations = [{ title: 'اسم اصطناعي', selected_phone: '+201111111111', raw_txt: 'نص اصطناعي' }];
  for (const bundle of [
    { conversations },
    { conversations, dry_run: true, vcf_contacts: [{ fn: 'اسم اصطناعي' }] },
    { conversations, dry_run: true, restore_opportunities: [{}] },
  ]) {
    assert.deepEqual(await runSourceSyncBundle(db, bundle), { ok: false, error: 'antix_phone_verified_write_not_available' });
  }
});

test('phone preview uses exact unique numbers, never name or legacy title', async () => {
  const { previewAntixPhoneMatches } = await import('../crm-antix-phone-preview.js');
  const chats = [
    { conversation_uid: 'wa:1', selected_phone: '+201111111111', title: 'same name' },
    { conversation_uid: 'wa:2', selected_phone: '+201222222222', title: 'same name' },
    { conversation_uid: 'wa:3', selected_phone: '+201033333333' },
    { conversation_uid: 'wa:4', selected_phone: '+201544444444' },
    { conversation_uid: 'wa:5', selected_phone: '201111111111' },
    { conversation_uid: 'wa:1', selected_phone: '+201111111111' },
  ];
  const rows = [
    { phone_key: '201111111111', contact_id: 'A' },
    { phone_key: '201033333333', contact_id: 'B' },
    { phone_key: '201033333333', contact_id: 'C' },
    { phone_key: '201544444444', contact_id: 'D' },
  ];
  const counts = previewAntixPhoneMatches(chats, rows, [{ conversation_uid: 'wa:4', contact_id: 'E' }]);
  assert.deepEqual(counts, { exact_unique_phone: 1, phone_not_found: 1, phone_conflict: 1, conversation_conflict: 1, invalid: 2 });
});

test('preview does not write or return customer data', async () => {
  const queries = [];
  const db = { prepare(sql) {
    queries.push(sql);
    return { bind() { return this; }, async all() {
      if (sql.includes('FROM crm_contact_phones')) return { results: [{ phone_key: '201111111111', contact_id: 'id' }] };
      return { results: [] };
    } };
  } };
  const result = await runSourceSyncBundle(db, { dry_run: true, conversations: [
    { conversation_uid: 'wa:test', selected_phone: '+201111111111', title: 'اسم سري', message_count: 1, first_message_at: null, last_message_at: null, raw_sha256: 'a'.repeat(64) },
  ], vcf_contacts: [] });
  assert.equal(result.antix_phone_preview.exact_unique_phone, 1);
  assert.equal(queries.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /اسم سري|نص سري|201111111111/);
});


test('preview rejects raw transcript before querying the database', async () => {
  const db = { prepare() { throw new Error('unexpected database access'); } };
  const result = await runSourceSyncBundle(db, { dry_run: true, vcf_contacts: [], conversations: [{
    conversation_uid: 'wa:test', selected_phone: '+201111111111', title: 'اختبار', raw_txt: 'سري',
  }] });
  assert.deepEqual(result, { ok: false, error: 'antix_invalid_preview_batch' });
});

test('a caller-supplied backup reference cannot enable writes without both trusted gates', async () => {
  const db = { prepare() { throw new Error('must reject before database access'); } };
  const item = { conversation_uid: 'wa:synthetic', selected_phone: '+201111111111', title: 'اختبار',
    message_count: 1, first_message_at: null, last_message_at: null, raw_sha256: 'a'.repeat(64) };
  const bundle = { conversations: [item], antix_mode: 'metadata_only_v1', backup_verified_ref: 'fake-backup' };
  for (const opts of [{}, { allowAntixMetadataWrite: true }, { antixVerifiedBackupRef: 'fake-backup' },
    { allowAntixMetadataWrite: true, antixVerifiedBackupRef: 'different-backup' }]) {
    assert.deepEqual(await runSourceSyncBundle(db, bundle, opts), { ok: false, error: 'antix_phone_verified_write_not_available' });
  }
  const unsafe = { ...item, raw_txt: 'سري' };
  assert.deepEqual(await runSourceSyncBundle(db, { ...bundle, conversations: [unsafe] },
    { allowAntixMetadataWrite: true, antixVerifiedBackupRef: 'fake-backup' }), { ok: false, error: 'antix_invalid_preview_batch' });
});
