import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSourceSyncBundle as runBundle } from '../crm-sync-and-match.js';
const runSourceSyncBundle = (db, bundle, opts = {}) => runBundle(db, bundle, { antixExcludedNames: ['مثال مستبعد'], ...opts });

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
  assert.deepEqual(counts, { exact_unique_phone: 1, phone_not_found: 1, phone_conflict: 1, conversation_conflict: 1, name_conflict: 0, invalid: 2 });
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

test('preview warns for name collisions and any existing UID without adopting by name', async () => {
  const { previewAntixPhoneMatches } = await import('../crm-antix-phone-preview.js');
  const chats = [
    { conversation_uid: 'wa:name', selected_phone: '+201111111111', title: 'اسم اصطناعي' },
    { conversation_uid: 'wa:existing', selected_phone: '+201022222222', title: 'اسم آخر' },
    { conversation_uid: 'wa:owned', selected_phone: '+201033333333', title: 'اسم ثالث' },
    { conversation_uid: 'wa:new', selected_phone: '+201044444444', title: 'اسم جديد' },
  ];
  const contacts = [{ id: 'c', name: 'اسم اصطناعي' }];
  const previous = [{ conversation_uid: 'wa:existing', contact_id: null },
    { conversation_uid: 'wa:owned', contact_id: 'o' }];
  const phones = [{ phone_key: '201033333333', contact_id: 'o' }];
  const counts = previewAntixPhoneMatches(chats, phones, previous, contacts);
  assert.deepEqual(counts, { exact_unique_phone: 0, phone_not_found: 1, phone_conflict: 0,
    conversation_conflict: 2, name_conflict: 1, invalid: 0 });
  assert.doesNotMatch(JSON.stringify(counts), /اسم اصطناعي|201111111111/);
});

test('dry-run passes existing contact names only to private conflict counting', async () => {
  const db = { prepare(sql) { return { bind() { return this; }, async all() {
    if (sql.includes('FROM crm_contacts') && !sql.includes('JOIN')) return { results: [{ id: 'contact', name: 'اسم اصطناعي' }] };
    return { results: [] };
  } }; } };
  const item = { conversation_uid: 'wa:synthetic-name', selected_phone: '+201111111111', title: 'اسم اصطناعي',
    message_count: 1, first_message_at: null, last_message_at: null, raw_sha256: 'a'.repeat(64) };
  const result = await runSourceSyncBundle(db, { dry_run: true, vcf_contacts: [], conversations: [item] });
  assert.equal(result.antix_phone_preview.name_conflict, 1);
  assert.equal(result.antix_phone_preview.phone_not_found, 0);
  assert.doesNotMatch(JSON.stringify(result), /اسم اصطناعي|201111111111/);
});

test('preview flags existing contact-only phones and excluded existing owners before writes', async () => {
  const { previewAntixPhoneMatches } = await import('../crm-antix-phone-preview.js');
  const items = [
    { conversation_uid: 'wa:contact', selected_phone: '+201111111111', title: '🟢 اصطناعي', message_count: 0 },
    { conversation_uid: 'wa:excluded', selected_phone: '+201022222222', title: 'اصطناعي آخر', message_count: 1 },
    { conversation_uid: 'wa:normal', selected_phone: '+201033333333', title: 'اصطناعي ثالث', message_count: 1 },
  ];
  const phones = [{ phone_key: '201111111111', contact_id: 'a' },
    { phone_key: '201022222222', contact_id: 'b' }, { phone_key: '201033333333', contact_id: 'c' }];
  const contacts = [{ id: 'a', name: '🟢 اصطناعي' }, { id: 'b', name: 'اسم 🌀 مستبعد' }, { id: 'c', name: 'اصطناعي ثالث' }];
  const counts = previewAntixPhoneMatches(items, phones, [], contacts);
  assert.equal(counts.phone_conflict, 2);
  assert.equal(counts.exact_unique_phone, 1);
  assert.doesNotMatch(JSON.stringify(counts), /201111111111|مستبعد/);
});

test('antiX preview and writes fail closed if private exclusions are not configured', async () => {
  const db = { prepare() { throw new Error('must not query'); } };
  const conversations = [{ selected_phone: '+201111111111' }];
  for (const antixExcludedNames of [undefined, null, [], ['  ']]) {
    assert.deepEqual(await runBundle(db, { dry_run: true, conversations }, { antixExcludedNames }),
      { ok: false, error: 'antix_private_exclusions_not_configured' });
  }
});

test('phone-conflict detail partitions counts without exposing customer data', async () => {
  const { previewAntixPhoneMatches } = await import('../crm-antix-phone-preview.js');
  const chats = [
    { conversation_uid: 'wa:one', selected_phone: '+201111111111', message_count: 0 },
    { conversation_uid: 'wa:two', selected_phone: '+201022222222', message_count: 1 },
    { conversation_uid: 'wa:three', selected_phone: '+201033333333', message_count: 1 },
    { conversation_uid: 'wa:four', selected_phone: '+201044444444', message_count: 0 },
  ];
  const phones = [{ phone_key: '201111111111', contact_id: 'a' },
    { phone_key: '201022222222', contact_id: 'b' },
    { phone_key: '201033333333', contact_id: 'c' }, { phone_key: '201033333333', contact_id: 'd' },
    { phone_key: '201044444444', contact_id: 'e' }];
  const contacts = [{ id: 'a', name: 'عميل اصطناعي' }, { id: 'b', name: '🌀 مستبعد' },
    { id: 'e', name: 'مثال مستبعد' }];
  const result = previewAntixPhoneMatches(chats, phones, [], contacts, ['مثال مستبعد'], true);
  assert.equal(result.phone_conflict, 4);
  assert.deepEqual(result.phone_conflict_detail, { multiple_owners: 1, protected_owner: 2, contact_only_existing_phone: 1 });
  assert.doesNotMatch(JSON.stringify(result), /201111111111|عميل اصطناعي|مثال مستبعد/);
});

test('preview fails closed when any database snapshot is missing or reports failure', async () => {
  const item = { conversation_uid: 'wa:synthetic', selected_phone: '+201111111111', title: 'اسم اصطناعي',
    message_count: 1, first_message_at: null, last_message_at: null, raw_sha256: 'a'.repeat(64) };
  for (const brokenIndex of [0, 1, 2]) {
    for (const broken of [undefined, {}, { success: false, results: [] }]) {
      let index = 0;
      const db = { prepare() { const current = index++; return { bind() { return this; },
        async all() { return current === brokenIndex ? broken : { success: true, results: [] }; } }; } };
      const result = await runSourceSyncBundle(db, { dry_run: true, conversations: [item], vcf_contacts: [] });
      assert.deepEqual(result, { ok: false, error: 'antix_preview_snapshot_unavailable' });
    }
  }
});

test('preview reports existing marked contact-only phone as a conflict without exposing values', async () => {
  const { previewAntixPhoneMatches } = await import('../crm-antix-phone-preview.js');
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const incoming = { conversation_uid: 'wa:contact', selected_phone: '+201111111111', title: '🔴 اسم اصطناعي جديد',
    message_count: 0, first_message_at: null, last_message_at: null, raw_sha256: emptyHash };
  const result = previewAntixPhoneMatches([incoming], [{ phone_key: '201111111111', contact_id: 'existing' }], [],
    [{ id: 'existing', name: 'اسم اصطناعي قديم' }], [], true);
  assert.equal(result.phone_conflict_detail.contact_only_existing_phone, 1);
  assert.equal(result.exact_unique_phone, 0);
  assert.doesNotMatch(JSON.stringify(result), /اصطناعي|201111111111/);
});
