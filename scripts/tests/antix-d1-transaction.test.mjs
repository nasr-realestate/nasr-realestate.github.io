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
