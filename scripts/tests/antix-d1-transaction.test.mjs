import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { buildAntixWriteGuards } from '../../_worker/crm-antix-write-guards.js';

test('local D1 batch rolls back synthetic writes when the owner changes', async () => {
  // No network access, persistent database, real client data, or remote D1 binding.
  const mf = new Miniflare({ cf: false, modules: true, compatibilityDate: '2025-01-01',
    script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of ['CREATE TABLE crm_contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL)',
      'CREATE TABLE crm_contact_phones(contact_id TEXT,phone_key TEXT)',
      'CREATE TABLE crm_conversations(conversation_uid TEXT)', 'CREATE TABLE synthetic_writes(id TEXT)']) {
      await db.prepare(sql).run();
    }
    const item = { conversation_uid: 'wa:synthetic', selected_phone: '+201111111111',
      title: 'عميل اصطناعي', message_count: 1, first_message_at: null,
      last_message_at: null, raw_sha256: 'a'.repeat(64) };
    const guard = buildAntixWriteGuards(db, [item], { contacts: [], phones: [], conversations: [] }, ['مثال مستبعد'])[0];
    const result = await db.batch([guard]);
    assert.equal(result[0].results[0].guard, 1);
    await db.prepare("INSERT INTO crm_contacts VALUES('a','عميل اصطناعي آخر')").run();
    await db.prepare("INSERT INTO crm_contact_phones VALUES('a','201111111111')").run();
    await assert.rejects(db.batch([db.prepare("INSERT INTO synthetic_writes VALUES('must roll back')"), guard]));
    assert.equal((await db.prepare('SELECT count(*) n FROM synthetic_writes').first()).n, 0);
  } finally {
    await mf.dispose();
  }
});

test('local D1 guarded metadata batch aborts partial inserts on an intra-batch collision', async () => {
  const { writeGuardedAntixPrototype } = await import('../../_worker/crm-antix-guarded-write-prototype.js');
  const mf = new Miniflare({ cf: false, modules: true, compatibilityDate: '2025-01-01',
    script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const statements = [
      'CREATE TABLE crm_contacts(id TEXT PRIMARY KEY,name TEXT,communication_consent TEXT,created_at TEXT,updated_at TEXT)',
      'CREATE TABLE crm_contact_phones(id TEXT PRIMARY KEY,contact_id TEXT,phone_key TEXT UNIQUE,label TEXT,is_primary INTEGER,raw_input TEXT,source_type TEXT,source_ref TEXT,verified_at TEXT)',
      'CREATE TABLE crm_contact_audit_log(id TEXT PRIMARY KEY,contact_id TEXT,action_type TEXT,field_name TEXT,old_value TEXT,new_value TEXT,source_ref TEXT,actor TEXT,created_at TEXT)',
      'CREATE TABLE crm_conversations(id TEXT PRIMARY KEY,conversation_uid TEXT UNIQUE,contact_id TEXT,source_type TEXT,source_ref TEXT,chat_title TEXT,peer_sender_name TEXT,match_status TEXT,match_method TEXT,review_reason TEXT,raw_text TEXT,raw_sha256 TEXT,message_count INTEGER,first_message_at TEXT,last_message_at TEXT,parse_warnings_json TEXT,created_at TEXT,updated_at TEXT)',
    ];
    for (const sql of statements) await db.prepare(sql).run();
    const item = (uid, phone) => ({ conversation_uid: uid, selected_phone: phone, title: '🟢 اسم اصطناعي',
      message_count: 1, first_message_at: null, last_message_at: null, raw_sha256: 'a'.repeat(64) });
    const items = [item('wa:first', '+201111111111'), item('wa:second', '+201022222222')];
    const snapshot = { contacts: [], phones: [], conversations: [] };
    await assert.rejects(writeGuardedAntixPrototype(db, items, snapshot, { excludedNames: ['مثال مستبعد'] }));
    for (const table of ['crm_contacts', 'crm_contact_phones', 'crm_contact_audit_log', 'crm_conversations']) {
      assert.equal((await db.prepare(`SELECT count(*) n FROM ${table}`).first()).n, 0);
    }
    const result = await writeGuardedAntixPrototype(db, [items[0]], snapshot, { excludedNames: ['مثال مستبعد'] });
    assert.deepEqual(result, { attempted: 1, inserted: 1, not_inserted: 0, created_contacts: 1 });
  } finally { await mf.dispose(); }
});
