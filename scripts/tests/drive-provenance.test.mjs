import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { outboxCanonical, OUTBOX_ZERO } from '../../_worker/l2-outbox.js';
import { recordDriveProvenance } from '../../_worker/drive-provenance.js';

const migration = readFileSync(new URL('../../_worker/migrations/0005_sync_audit_and_intelligence.sql', import.meta.url), 'utf8');
const provenanceDdl = readFileSync(new URL('../../_worker/migrations-proposed/0016_crm_provenance_ledger.sql', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(outboxCanonical(value)).digest('hex');

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE crm_contacts(id TEXT PRIMARY KEY); CREATE TABLE crm_opportunities(id TEXT PRIMARY KEY);');
  for (const table of ['crm_conversations', 'crm_conversation_messages']) {
    const ddl = migration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    assert.ok(ddl, `missing DDL for ${table}`);
    sqlite.exec(ddl[0]);
  }
  sqlite.exec(provenanceDdl);
  sqlite.exec("INSERT INTO crm_contacts(id) VALUES ('contact-1'), ('contact-2');");
  sqlite.prepare(`INSERT INTO crm_conversations(id, conversation_uid, contact_id, chat_title, raw_text, raw_sha256)
    VALUES (?, ?, ?, ?, ?, ?)`).run('conv-1', 'uid-conv', 'contact-1', 'synthetic', 'synthetic', 'hash');
  sqlite.prepare(`INSERT INTO crm_conversation_messages(id, conversation_id, message_uid, seq_no, sender_role, body_text)
    VALUES (?, ?, ?, ?, ?, ?)`).run('msg-1', 'conv-1', 'uid-msg', 1, 'unknown', 'synthetic');
  const db = { prepare: sql => ({ bind: (...values) => ({ first: async () => sqlite.prepare(sql).get(...values) ?? null }) }) };
  const args = { runId: 'run-1', fileId: 'file-1', fileHash: 'file-hash', conversations: [], messages: [] };
  return { sqlite, db, args };
}

test('existing row yields an entry with a correct canonical event hash', async () => {
  const { sqlite, db, args } = fixture();
  try {
    const [entry] = await recordDriveProvenance(db, { ...args, conversations: ['uid-conv'] });
    const { entry_hash, ...event } = entry;
    assert.equal(entry_hash, hash(event));
    assert.equal(entry.row_id, 'conv-1');
    assert.equal(entry.content_hash, hash({ id: 'conv-1', contact_id: 'contact-1' }));
    assert.equal(entry.prev_hash, OUTBOX_ZERO);
    assert.equal(entry.event_seq, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM crm_provenance_ledger').get().n, 0);
  } finally { sqlite.close(); }
});

test('missing conversation is rejected', async () => {
  const { sqlite, db, args } = fixture();
  try {
    await assert.rejects(recordDriveProvenance(db, { ...args, conversations: ['missing'] }), /provenance-row-missing:crm_conversations:missing/);
  } finally { sqlite.close(); }
});

test('missing message is rejected', async () => {
  const { sqlite, db, args } = fixture();
  try {
    await assert.rejects(recordDriveProvenance(db, { ...args, messages: ['missing'] }), /provenance-row-missing:crm_conversation_messages:missing/);
  } finally { sqlite.close(); }
});

test('successive events form a hash chain', async () => {
  const { sqlite, db, args } = fixture();
  try {
    const [first, second] = await recordDriveProvenance(db, { ...args, conversations: ['uid-conv'], messages: ['uid-msg'] });
    assert.equal(second.event_seq, first.event_seq + 1);
    assert.equal(second.prev_hash, first.entry_hash);
    assert.equal(second.content_hash, hash({ id: 'msg-1', conversation_id: 'conv-1' }));
    const { entry_hash, ...event } = second;
    assert.equal(entry_hash, hash(event));
  } finally { sqlite.close(); }
});

test('content hash reflects the actual contact foreign key', async () => {
  const { sqlite, db, args } = fixture();
  try {
    const options = { ...args, conversations: ['uid-conv'] };
    const [before] = await recordDriveProvenance(db, options);
    sqlite.prepare('UPDATE crm_conversations SET contact_id = ? WHERE id = ?').run('contact-2', 'conv-1');
    const [after] = await recordDriveProvenance(db, options);
    assert.notEqual(after.content_hash, before.content_hash);
    assert.equal(after.content_hash, hash({ id: 'conv-1', contact_id: 'contact-2' }));
  } finally { sqlite.close(); }
});
