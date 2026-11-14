import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildAntixWriteGuards } from '../crm-antix-write-guards.js';

const excluded = ['مثال مستبعد'];
const makeItem = (uid, phone, title = 'اسم اصطناعي جديد') => ({ conversation_uid: `wa:${uid}`,
  selected_phone: `+${phone}`, title, message_count: 1, first_message_at: null,
  last_message_at: null, raw_sha256: 'a'.repeat(64) });
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE crm_contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE crm_contact_phones(contact_id TEXT,phone_key TEXT); CREATE TABLE crm_conversations(conversation_uid TEXT); CREATE TABLE synthetic_writes(id TEXT)');
  const db = { prepare(sql) { return { bind(...args) { return { execute: () => sqlite.prepare(sql).all(...args) }; } }; } };
  return { sqlite, db, snapshot: () => ({ contacts: sqlite.prepare('SELECT id,name FROM crm_contacts').all(),
    phones: sqlite.prepare('SELECT contact_id,phone_key FROM crm_contact_phones').all(),
    conversations: sqlite.prepare('SELECT conversation_uid FROM crm_conversations').all() }) };
}

test('accepts unchanged missing and verified existing owners, without writing anything', () => {
  const f = fixture();
  try {
    f.sqlite.exec("INSERT INTO crm_contacts VALUES ('a','مالك اصطناعي'); INSERT INTO crm_contact_phones VALUES ('a','201111111111')");
    const items = [makeItem('owned', '201111111111'), makeItem('new', '201022222222')];
    const guards = buildAntixWriteGuards(f.db, items, f.snapshot(), excluded);
    for (const g of guards) assert.equal(g.execute()[0].guard, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM synthetic_writes').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('owner or name changes, new conversation and changed name collision abort', () => {
  for (const change of [
    "UPDATE crm_contacts SET name='آخر' WHERE id='a'",
    "UPDATE crm_contact_phones SET contact_id='b' WHERE phone_key='201111111111'",
    "INSERT INTO crm_conversations VALUES('wa:owned')",
    "INSERT INTO crm_contacts VALUES('c',char(8207)||'اسم اصطناعي جديد')",
  ]) {
    const f = fixture();
    try {
      f.sqlite.exec("INSERT INTO crm_contacts VALUES ('a','مالك اصطناعي'),('b','مالك آخر'); INSERT INTO crm_contact_phones VALUES ('a','201111111111')");
      const guards = buildAntixWriteGuards(f.db, [makeItem('owned', '201111111111'), makeItem('new', '201022222222')], f.snapshot(), excluded);
      f.sqlite.exec(change);
      f.sqlite.exec('BEGIN');
      try {
        guards[0].execute();
        f.sqlite.exec("INSERT INTO synthetic_writes VALUES('must roll back')");
        guards[1].execute();
        assert.fail('guard should have aborted');
      } catch (e) {
        f.sqlite.exec('ROLLBACK');
        assert.match(e.message, /integer overflow/);
      }
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM synthetic_writes').get().n, 0);
    } finally { f.sqlite.close(); }
  }
});

test('new owner appearing after preview aborts instead of linking it', () => {
  const f = fixture();
  try {
    const guard = buildAntixWriteGuards(f.db, [makeItem('new', '201111111111')], f.snapshot(), excluded)[0];
    f.sqlite.exec("INSERT INTO crm_contacts VALUES('a','اسم آخر'); INSERT INTO crm_contact_phones VALUES('a','201111111111')");
    assert.throws(() => guard.execute(), /integer overflow/);
  } finally { f.sqlite.close(); }
});

test('refuses held contact-only items and oversized batches before any SQL execution', () => {
  const f = fixture();
  try {
    f.sqlite.exec("INSERT INTO crm_contacts VALUES('a','🟢 جهة اصطناعية'); INSERT INTO crm_contact_phones VALUES('a','201111111111')");
    const held = { ...makeItem('held', '201111111111', '🟢 جهة اصطناعية'), message_count: 0,
      raw_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
    assert.throws(() => buildAntixWriteGuards(f.db, [held], f.snapshot(), excluded), /held-item/);
    assert.throws(() => buildAntixWriteGuards(f.db, Array(6).fill(held), f.snapshot(), excluded), /invalid-guard-batch/);
  } finally { f.sqlite.close(); }
});
