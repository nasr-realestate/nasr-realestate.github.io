import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ddl = readFileSync(new URL('../../_worker/migrations-proposed/0016_crm_provenance_ledger.sql', import.meta.url), 'utf8');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  return db;
}

function insert(db, runId = 'run-1') {
  db.prepare(`INSERT INTO crm_provenance_ledger
    (run_id, table_name, row_id, drive_file_id, drive_file_hash, content_hash, event_seq, prev_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, 'crm_conversations', 'row-1', 'file-1', 'file-hash', 'content-hash', 1, 'previous', 'entry');
}

test('provenance ledger DDL applies to in-memory SQLite', () => {
  const db = fixture();
  try {
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crm_provenance_ledger'").get().name, 'crm_provenance_ledger');
  } finally { db.close(); }
});

test('provenance ledger rejects UPDATE', () => {
  const db = fixture();
  try {
    insert(db);
    assert.throws(() => db.prepare("UPDATE crm_provenance_ledger SET run_id = 'other'").run(), /provenance-immutable/);
  } finally { db.close(); }
});

test('provenance ledger rejects duplicate table and row across runs', () => {
  const db = fixture();
  try {
    insert(db);
    assert.throws(() => insert(db, 'run-2'), /UNIQUE constraint failed: crm_provenance_ledger.table_name, crm_provenance_ledger.row_id/);
  } finally { db.close(); }
});
