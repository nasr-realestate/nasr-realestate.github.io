-- PROPOSED ONLY: deliberately outside the deployed migrations directory.
-- Applying this migration requires separate authorization and a complete writer integration.
CREATE TABLE l2_outbox (
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  table_name TEXT NOT NULL CHECK (length(table_name) BETWEEN 1 AND 80),
  row_id TEXT NOT NULL CHECK (length(row_id) BETWEEN 1 AND 256),
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64 AND row_hash NOT GLOB '*[^0-9a-f]*'),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64 AND prev_hash NOT GLOB '*[^0-9a-f]*'),
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64 AND entry_hash NOT GLOB '*[^0-9a-f]*'),
  result TEXT NOT NULL CHECK (result IN ('proven','unknown','failed')),
  PRIMARY KEY (run_id, event_seq),
  UNIQUE (run_id, table_name, row_id)
);
CREATE TRIGGER l2_outbox_sequence BEFORE INSERT ON l2_outbox BEGIN
  SELECT CASE WHEN NEW.event_seq != COALESCE((SELECT MAX(event_seq) + 1 FROM l2_outbox WHERE run_id=NEW.run_id),1)
    THEN RAISE(ABORT,'l2-outbox-sequence') END;
  SELECT CASE WHEN NEW.prev_hash != COALESCE((SELECT entry_hash FROM l2_outbox WHERE run_id=NEW.run_id ORDER BY event_seq DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000')
    THEN RAISE(ABORT,'l2-outbox-previous-hash') END;
END;
CREATE TRIGGER l2_outbox_no_update BEFORE UPDATE ON l2_outbox BEGIN SELECT RAISE(ABORT,'l2-outbox-append-only'); END;
CREATE TRIGGER l2_outbox_no_delete BEFORE DELETE ON l2_outbox BEGIN SELECT RAISE(ABORT,'l2-outbox-append-only'); END;
