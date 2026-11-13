import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { validateAntixMetadata, writeAntixMetadataPrototype } from '../crm-antix-metadata-write.js';

const item = (uid, phone) => ({ conversation_uid: uid, selected_phone: phone, title: '🟢 اصطناعي',
  message_count: 2, first_message_at: '2025-11-13T02:13:00.000Z',
  last_message_at: '2025-11-13T02:15:00.000Z', raw_sha256: 'a'.repeat(64) });

async function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec('CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, area_id INTEGER, transaction_type TEXT, price REAL, observed_at TEXT)');
  for (const file of ['0001_crm_opportunities.sql', '0002_crm_internal_auth.sql', '0003_crm_push_notifications.sql',
    '0004_crm_tracks_core.sql', '0005_sync_audit_and_intelligence.sql']) {
    sqlite.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const db = {
    prepare(sql) { return { bind(...args) { return { run: () => sqlite.prepare(sql).run(...args) }; } }; },
    async batch(statements) {
      sqlite.exec('SAVEPOINT testbatch');
      try { const rows = statements.map(s => s.run()); sqlite.exec('RELEASE testbatch'); return rows; }
      catch (e) { sqlite.exec('ROLLBACK TO testbatch'); sqlite.exec('RELEASE testbatch'); throw e; }
    },
  };
  return { db, sqlite };
}

test('isolated metadata prototype stores no text, requires an existing exact phone and never adopts by name', async () => {
  const { db, sqlite } = await setup();
  sqlite.exec("INSERT INTO crm_contacts(id,name) VALUES('a','🟢 اصطناعي'),('b','🌀 مستبعد')");
  sqlite.exec("INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES('p','a','201111111111'),('q','b','201222222222')");
  const rows = [item('wa:one', '+201111111111'), item('wa:two', '+201033333333'), item('wa:three', '+201222222222')];
  assert.deepEqual(await writeAntixMetadataPrototype(db, rows), { attempted: 3, inserted: 1, not_inserted: 2 });
  const stored = sqlite.prepare('SELECT contact_id,raw_text,message_count,match_method FROM crm_conversations').get();
  assert.deepEqual({ ...stored }, { contact_id: 'a', raw_text: '', message_count: 2, match_method: 'exact_phone' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM crm_conversation_messages').get().n, 0);
  assert.deepEqual(await writeAntixMetadataPrototype(db, rows), { attempted: 3, inserted: 0, not_inserted: 3 });
  sqlite.close();
});

test('rejects body text, duplicates and malformed inputs before any database access', async () => {
  const base = item('wa:one', '+201111111111');
  const db = { prepare() { throw new Error('unexpected write'); } };
  for (const batch of [[{ ...base, raw_txt: 'private text' }], [base, base], [{ ...base, raw_sha256: 'bad' }],
    [{ ...base, title: '🌀 مستبعد' }], [{ ...base, selected_phone: '+201333333333' }]]) {
    assert.throws(() => validateAntixMetadata(batch));
    await assert.rejects(writeAntixMetadataPrototype(db, batch), /invalid/);
  }
});

test('new phone creates customer, provenance and metadata atomically without assigning by name', async () => {
  const { db, sqlite } = await setup();
  try {
    sqlite.exec("INSERT INTO crm_contacts(id,name) VALUES('existing','🟢 اصطناعي')");
    const conflict = item('wa:conflict', '+201111111111');
    const unique = { ...item('wa:new', '+201222222222'), title: '🟡 آخر تجريبي' };
    assert.deepEqual(await writeAntixMetadataPrototype(db, [conflict, unique], { createMissing: true }),
      { attempted: 2, inserted: 1, not_inserted: 1, created_contacts: 1 });
    const row = sqlite.prepare(`SELECT c.name,c.communication_consent,p.phone_key,cv.raw_text,cv.match_method
      FROM crm_conversations cv JOIN crm_contacts c ON c.id=cv.contact_id
      JOIN crm_contact_phones p ON p.contact_id=c.id WHERE cv.conversation_uid='wa:new'`).get();
    assert.deepEqual({ ...row }, { name: '🟡 آخر تجريبي', communication_consent: 'request_only',
      phone_key: '201222222222', raw_text: '', match_method: 'exact_phone' });
    assert.equal(sqlite.prepare("SELECT count(*) n FROM crm_contact_audit_log WHERE field_name='contact_created'").get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_conversation_messages').get().n, 0);
    assert.deepEqual(await writeAntixMetadataPrototype(db, [conflict, unique], { createMissing: true }),
      { attempted: 2, inserted: 0, not_inserted: 2, created_contacts: 0 });
  } finally { sqlite.close(); }
});

test('existing conversation UID prevents creation of orphan contacts for another phone', async () => {
  const { db, sqlite } = await setup();
  try {
    sqlite.exec("INSERT INTO crm_contacts(id,name) VALUES('original','اسم آخر')");
    sqlite.exec("INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES('phone','original','201111111111')");
    const old = { ...item('wa:existing', '+201111111111'), title: 'اسم آخر' };
    await writeAntixMetadataPrototype(db, [old]);
    const collision = { ...item('wa:existing', '+201222222222'), title: 'اسم جديد' };
    assert.deepEqual(await writeAntixMetadataPrototype(db, [collision], { createMissing: true }),
      { attempted: 1, inserted: 0, not_inserted: 1, created_contacts: 0 });
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contacts').get().n, 1);
    assert.equal(sqlite.prepare("SELECT contact_id FROM crm_conversations WHERE conversation_uid='wa:existing'").get().contact_id, 'original');
  } finally { sqlite.close(); }
});

test('any insert failure rolls back all contacts, phones, audit and conversations in the batch', async () => {
  const { db, sqlite } = await setup();
  try {
    sqlite.exec("CREATE TRIGGER synthetic_block BEFORE INSERT ON crm_conversations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(writeAntixMetadataPrototype(db, [item('wa:one', '+201111111111')], { createMissing: true }));
    for (const table of ['crm_contacts', 'crm_contact_phones', 'crm_contact_audit_log', 'crm_conversations']) {
      assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    }
  } finally { sqlite.close(); }
});

test('hidden bidi controls cannot bypass excluded marker check', () => {
  const hidden = { ...item('wa:one', '+201111111111'), title: '\u200f🌀 مستبعد' };
  assert.throws(() => validateAntixMetadata([hidden]));
});

test('stores a long synthetic customer name without truncation and still enforces limits', async () => {
  const { db, sqlite } = await setup();
  try {
    const title = ('🟢 ' + 'اسم طويل '.repeat(45)).trim();
    const record = { ...item('wa:long-name', '+201111111111'), title };
    assert.deepEqual(await writeAntixMetadataPrototype(db, [record], { createMissing: true }),
      { attempted: 1, inserted: 1, not_inserted: 0, created_contacts: 1 });
    assert.equal(sqlite.prepare('SELECT name FROM crm_contacts').get().name, title);
    assert.equal(sqlite.prepare('SELECT chat_title FROM crm_conversations').get().chat_title, title);
    assert.throws(() => validateAntixMetadata([{ ...record, title: 'س'.repeat(4097) }]));
    assert.throws(() => validateAntixMetadata([{ ...record, title: title + ' 🌀' }]));
  } finally { sqlite.close(); }
});
