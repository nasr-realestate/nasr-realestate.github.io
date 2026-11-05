CREATE TABLE IF NOT EXISTS crm_provenance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('crm_conversations','crm_conversation_messages')),
  row_id TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  drive_file_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, table_name, row_id),
  UNIQUE (table_name, row_id)
);
CREATE INDEX IF NOT EXISTS idx_prov_run ON crm_provenance_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_prov_row ON crm_provenance_ledger(table_name, row_id);
CREATE TRIGGER IF NOT EXISTS prov_no_update
  BEFORE UPDATE ON crm_provenance_ledger
  BEGIN SELECT RAISE(ABORT, 'provenance-immutable'); END;
CREATE TRIGGER IF NOT EXISTS prov_no_delete
  BEFORE DELETE ON crm_provenance_ledger
  BEGIN SELECT RAISE(ABORT, 'provenance-immutable'); END;
