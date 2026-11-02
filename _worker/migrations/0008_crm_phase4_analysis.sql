-- Additive CRM migration 0008 (isolated nasr-crm-test-db only) — Phase 4 analysis.
-- Stores the *results* of offline analysis of Google Drive CRM source files: integrity
-- digests, ZIP entry inventory, WhatsApp conversation statistics, vCard classifications,
-- hashed identity signals, non-destructive duplicate findings and CRM match candidates.
--
-- HARD BARRIERS encoded below (CRM_DATA_GOVERNANCE.md §2.2, §3, §4.1, §4.2, §5.4):
--  * No column may hold a name, phone number, address or message body. Identity is
--    stored only as a 64-hex SHA-256 digest, a length, or a count.
--  * `attributed = 1` is only reachable for numbers that come from a vCard TEL or a
--    sender label; numbers scraped out of message text are stored with attributed = 0
--    and can never produce an exact match (enforced by the classifier, and by the
--    CHECK below that ties `exact_match` to an attributed signal).
--  * `auto_link` is constrained to 0: the database itself refuses any statement that
--    would mark a match candidate as automatically linkable. Linking/merging requires
--    a human decision in a later phase.
--  * Nothing here writes to operational CRM tables (crm_contacts, crm_contact_phones,
--    crm_opportunities, crm_conversations, crm_conversation_messages, ...).
--  * Never apply to nasr-market-db. Never apply to production.

CREATE TABLE IF NOT EXISTS crm_drive_analysis_run (
  run_key TEXT PRIMARY KEY CHECK (length(trim(run_key)) BETWEEN 3 AND 160),
  payload_fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  analysis_version TEXT NOT NULL CHECK (length(trim(analysis_version)) BETWEEN 2 AND 40),
  drive_parent_id TEXT NOT NULL CHECK (length(trim(drive_parent_id)) > 0),
  files_expected INTEGER NOT NULL CHECK (files_expected >= 0),
  files_analyzed INTEGER NOT NULL CHECK (files_analyzed >= 0),
  files_processed INTEGER NOT NULL CHECK (files_processed >= 0),
  files_failed INTEGER NOT NULL CHECK (files_failed >= 0),
  conversations_total INTEGER NOT NULL DEFAULT 0 CHECK (conversations_total >= 0),
  messages_total INTEGER NOT NULL DEFAULT 0 CHECK (messages_total >= 0),
  vcard_records_total INTEGER NOT NULL DEFAULT 0 CHECK (vcard_records_total >= 0),
  duplicate_findings INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_findings >= 0),
  match_candidates INTEGER NOT NULL DEFAULT 0 CHECK (match_candidates >= 0),
  import_performed INTEGER NOT NULL DEFAULT 0 CHECK (import_performed = 0),
  records_written INTEGER NOT NULL DEFAULT 0 CHECK (records_written >= 0),
  aggregate_json TEXT NOT NULL DEFAULT '{}' CHECK (length(aggregate_json) BETWEEN 2 AND 65536),
  started_at TEXT CHECK (started_at IS NULL OR length(trim(started_at)) > 0),
  completed_at TEXT CHECK (completed_at IS NULL OR length(trim(completed_at)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_drive_file_analysis (
  drive_file_id TEXT PRIMARY KEY CHECK (length(trim(drive_file_id)) > 0),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  inner_content_sha256 TEXT CHECK (
    inner_content_sha256 IS NULL OR (length(inner_content_sha256) = 64 AND inner_content_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  content_kind TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
    content_kind IN ('ZIP', 'VCF', 'TXT', 'OTHER', 'UNKNOWN')
  ),
  analysis_status TEXT NOT NULL CHECK (analysis_status IN ('completed', 'failed', 'skipped')),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR (typeof(size_bytes) = 'integer' AND size_bytes >= 0)),
  drive_size_bytes INTEGER CHECK (
    drive_size_bytes IS NULL OR (typeof(drive_size_bytes) = 'integer' AND drive_size_bytes >= 0)
  ),
  size_verified TEXT NOT NULL DEFAULT 'unknown' CHECK (size_verified IN ('match', 'mismatch', 'unknown')),
  archive_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (archive_entry_count >= 0),
  archive_text_records INTEGER NOT NULL DEFAULT 0 CHECK (archive_text_records >= 0),
  archive_rejected_entries INTEGER NOT NULL DEFAULT 0 CHECK (archive_rejected_entries >= 0),
  archive_skipped_entries INTEGER NOT NULL DEFAULT 0 CHECK (archive_skipped_entries >= 0),
  safety_flags_json TEXT NOT NULL DEFAULT '{}' CHECK (length(safety_flags_json) BETWEEN 2 AND 8192),
  extracted_records_count INTEGER NOT NULL DEFAULT 0 CHECK (extracted_records_count >= 0),
  message_count_total INTEGER NOT NULL DEFAULT 0 CHECK (message_count_total >= 0),
  temporary_mark_count INTEGER NOT NULL DEFAULT 0 CHECK (temporary_mark_count >= 0),
  text_encoding TEXT CHECK (text_encoding IS NULL OR length(text_encoding) BETWEEN 2 AND 60),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(trim(error_code)) BETWEEN 2 AND 80
      AND error_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    )
  ),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
  elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR (typeof(elapsed_ms) = 'integer' AND elapsed_ms >= 0)),
  analysis_version TEXT NOT NULL CHECK (length(trim(analysis_version)) BETWEEN 2 AND 40),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (analysis_status != 'failed' OR error_code IS NOT NULL),
  CHECK (analysis_status != 'completed' OR error_code IS NULL),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_file_analysis_status
  ON crm_drive_file_analysis(analysis_status, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_drive_file_analysis_inner_sha
  ON crm_drive_file_analysis(inner_content_sha256) WHERE inner_content_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_drive_archive_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL CHECK (length(trim(drive_file_id)) > 0),
  entry_name_sha256 TEXT NOT NULL CHECK (
    length(entry_name_sha256) = 64 AND entry_name_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  entry_extension TEXT CHECK (
    entry_extension IS NULL OR (length(entry_extension) BETWEEN 1 AND 12 AND entry_extension NOT GLOB '*[^.a-z0-9]*')
  ),
  entry_method TEXT CHECK (entry_method IS NULL OR length(entry_method) BETWEEN 2 AND 20),
  compressed_bytes INTEGER CHECK (compressed_bytes IS NULL OR (typeof(compressed_bytes) = 'integer' AND compressed_bytes >= 0)),
  uncompressed_bytes INTEGER CHECK (uncompressed_bytes IS NULL OR (typeof(uncompressed_bytes) = 'integer' AND uncompressed_bytes >= 0)),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  rejected_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (length(rejected_reasons_json) BETWEEN 2 AND 2048),
  skipped_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (length(skipped_reasons_json) BETWEEN 2 AND 2048),
  issue_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (length(issue_codes_json) BETWEEN 2 AND 2048),
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  UNIQUE (drive_file_id, entry_name_sha256, uncompressed_bytes),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_archive_entry_file
  ON crm_drive_archive_entry(drive_file_id, accepted);

-- One row per WhatsApp transcript found inside a Drive archive. Digests and counts
-- only: the transcript text itself is never stored anywhere.
CREATE TABLE IF NOT EXISTS crm_wa_conversation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL CHECK (length(trim(drive_file_id)) > 0),
  entry_name_sha256 TEXT CHECK (
    entry_name_sha256 IS NULL OR (length(entry_name_sha256) = 64 AND entry_name_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  entry_sha256 TEXT CHECK (
    entry_sha256 IS NULL OR (length(entry_sha256) = 64 AND entry_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  record_sha256 TEXT NOT NULL CHECK (
    length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  normalized_sha256 TEXT CHECK (
    normalized_sha256 IS NULL OR (length(normalized_sha256) = 64 AND normalized_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  set_sha256 TEXT CHECK (
    set_sha256 IS NULL OR (length(set_sha256) = 64 AND set_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  prefix20_sha256 TEXT,
  suffix20_sha256 TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  body_bytes INTEGER CHECK (body_bytes IS NULL OR (typeof(body_bytes) = 'integer' AND body_bytes >= 0)),
  body_char_count INTEGER NOT NULL DEFAULT 0 CHECK (body_char_count >= 0),
  first_iso_date TEXT CHECK (first_iso_date IS NULL OR length(first_iso_date) = 10),
  last_iso_date TEXT CHECK (last_iso_date IS NULL OR length(last_iso_date) = 10),
  transcript_format TEXT CHECK (transcript_format IS NULL OR length(transcript_format) BETWEEN 3 AND 40),
  text_encoding TEXT CHECK (text_encoding IS NULL OR length(text_encoding) BETWEEN 2 AND 60),
  unique_sender_labels INTEGER NOT NULL DEFAULT 0 CHECK (unique_sender_labels >= 0),
  sender_label_phone_count INTEGER NOT NULL DEFAULT 0 CHECK (sender_label_phone_count >= 0),
  dominant_sender_share REAL CHECK (
    dominant_sender_share IS NULL OR (dominant_sender_share >= 0 AND dominant_sender_share <= 1)
  ),
  deleted_message_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_message_count >= 0),
  media_message_count INTEGER NOT NULL DEFAULT 0 CHECK (media_message_count >= 0),
  unsupported_message_count INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_message_count >= 0),
  phone_only_body_message_count INTEGER NOT NULL DEFAULT 0 CHECK (phone_only_body_message_count >= 0),
  system_line_count INTEGER NOT NULL DEFAULT 0 CHECK (system_line_count >= 0),
  unparsed_line_count INTEGER NOT NULL DEFAULT 0 CHECK (unparsed_line_count >= 0),
  continuation_line_count INTEGER NOT NULL DEFAULT 0 CHECK (continuation_line_count >= 0),
  ambiguous_date_line_count INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_date_line_count >= 0),
  body_phone_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (body_phone_candidate_count >= 0),
  temporary_mark INTEGER NOT NULL DEFAULT 0 CHECK (temporary_mark IN (0, 1)),
  status_colors TEXT CHECK (status_colors IS NULL OR length(status_colors) <= 60),
  identity_basis TEXT NOT NULL DEFAULT 'none' CHECK (
    identity_basis IN ('none', 'label_name_only', 'body_candidate_only', 'label_phone', 'label_phone_and_name')
  ),
  identity_confidence TEXT NOT NULL DEFAULT 'none' CHECK (
    identity_confidence IN ('none', 'low', 'medium', 'high')
  ),
  ownership_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (length(ownership_reasons_json) BETWEEN 2 AND 4096),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  UNIQUE (drive_file_id, record_sha256),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_wa_conversation_record
  ON crm_wa_conversation(record_sha256);
CREATE INDEX IF NOT EXISTS idx_crm_wa_conversation_temp
  ON crm_wa_conversation(temporary_mark, message_count DESC);

CREATE TABLE IF NOT EXISTS crm_vcard_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL CHECK (length(trim(drive_file_id)) > 0),
  entry_name_sha256 TEXT CHECK (
    entry_name_sha256 IS NULL OR (length(entry_name_sha256) = 64 AND entry_name_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  vcf_set_sha256 TEXT CHECK (
    vcf_set_sha256 IS NULL OR (length(vcf_set_sha256) = 64 AND vcf_set_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  card_index INTEGER NOT NULL CHECK (card_index >= 0),
  record_sha256 TEXT CHECK (
    record_sha256 IS NULL OR (length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  classification TEXT NOT NULL CHECK (
    classification IN (
      'complete_card',
      'incomplete_card',
      'trusted_duplicate',
      'temporary_review',
      'third_party_review',
      'needs_human_review'
    )
  ),
  classification_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (length(classification_reasons_json) BETWEEN 2 AND 4096),
  informational_notes_json TEXT NOT NULL DEFAULT '[]' CHECK (length(informational_notes_json) BETWEEN 2 AND 4096),
  display_name_present INTEGER NOT NULL DEFAULT 0 CHECK (display_name_present IN (0, 1)),
  display_name_length INTEGER CHECK (display_name_length IS NULL OR (typeof(display_name_length) = 'integer' AND display_name_length >= 0)),
  name_hash TEXT CHECK (
    name_hash IS NULL OR (length(name_hash) = 64 AND name_hash NOT GLOB '*[^0-9a-f]*')
  ),
  phone_hash_count INTEGER NOT NULL DEFAULT 0 CHECK (phone_hash_count >= 0),
  tel_property_count INTEGER NOT NULL DEFAULT 0 CHECK (tel_property_count >= 0),
  unparsable_tel_count INTEGER NOT NULL DEFAULT 0 CHECK (unparsable_tel_count >= 0),
  normalized_phone_count INTEGER NOT NULL DEFAULT 0 CHECK (normalized_phone_count >= 0),
  international_phone_count INTEGER NOT NULL DEFAULT 0 CHECK (international_phone_count >= 0),
  email_count INTEGER NOT NULL DEFAULT 0 CHECK (email_count >= 0),
  organization_present INTEGER NOT NULL DEFAULT 0 CHECK (organization_present IN (0, 1)),
  note_present INTEGER NOT NULL DEFAULT 0 CHECK (note_present IN (0, 1)),
  has_structured_name_field INTEGER NOT NULL DEFAULT 0 CHECK (has_structured_name_field IN (0, 1)),
  phone_types_json TEXT NOT NULL DEFAULT '[]' CHECK (length(phone_types_json) BETWEEN 2 AND 1024),
  temporary_mark INTEGER NOT NULL DEFAULT 0 CHECK (temporary_mark IN (0, 1)),
  binary_payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (binary_payload_bytes >= 0),
  vcf_version TEXT CHECK (vcf_version IS NULL OR length(vcf_version) BETWEEN 1 AND 12),
  structure_issues_json TEXT NOT NULL DEFAULT '[]' CHECK (length(structure_issues_json) BETWEEN 2 AND 2048),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  UNIQUE (drive_file_id, entry_name_sha256, card_index),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_vcard_record_class
  ON crm_vcard_record(classification, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_vcard_record_name_hash
  ON crm_vcard_record(name_hash) WHERE name_hash IS NOT NULL;

-- Hashed identity signals. `provenance` records where the identifier came from and
-- `attributed` records whether it may be tied to the file's customer at all.
CREATE TABLE IF NOT EXISTS crm_drive_identity_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL CHECK (length(trim(drive_file_id)) > 0),
  signal_kind TEXT NOT NULL CHECK (signal_kind IN ('phone', 'name')),
  signal_digest TEXT NOT NULL CHECK (
    length(signal_digest) = 64 AND signal_digest NOT GLOB '*[^0-9a-f]*'
  ),
  provenance TEXT NOT NULL CHECK (
    provenance IN (
      'vcard_tel',
      'vcard_fn',
      'sender_label',
      'sender_label_name',
      'archive_label_name',
      'body_text_candidate'
    )
  ),
  attributed INTEGER NOT NULL DEFAULT 0 CHECK (attributed IN (0, 1)),
  source_file_count INTEGER NOT NULL DEFAULT 1 CHECK (source_file_count >= 1),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  -- A number lifted from message text is never an attributed identity.
  CHECK (provenance != 'body_text_candidate' OR attributed = 0),
  UNIQUE (drive_file_id, signal_kind, signal_digest, provenance),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_identity_digest
  ON crm_drive_identity_signal(signal_kind, signal_digest);

CREATE TABLE IF NOT EXISTS crm_drive_duplicate_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(finding_sha256) = 64 AND finding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  level TEXT NOT NULL CHECK (level IN ('outer_bytes', 'inner_records', 'inner_records_partial')),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('conversation', 'vcf_set', 'file')),
  evidence TEXT NOT NULL CHECK (length(trim(evidence)) BETWEEN 3 AND 60),
  digest TEXT CHECK (
    digest IS NULL OR (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')
  ),
  drive_file_ids_json TEXT NOT NULL CHECK (length(drive_file_ids_json) BETWEEN 2 AND 8192),
  overlap_ratio REAL CHECK (overlap_ratio IS NULL OR (overlap_ratio >= 0 AND overlap_ratio <= 1)),
  shared_message_count INTEGER CHECK (
    shared_message_count IS NULL OR (typeof(shared_message_count) = 'integer' AND shared_message_count >= 0)
  ),
  action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 3 AND 80),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_dup_finding_level
  ON crm_drive_duplicate_finding(level, evidence);

-- CRM match candidates. Reference-only: `crm_contact_id` is never copied back into
-- any operational table, and `auto_link` is pinned to 0 by the table itself.
CREATE TABLE IF NOT EXISTS crm_drive_match_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_file_id TEXT NOT NULL CHECK (length(trim(drive_file_id)) > 0),
  match_class TEXT NOT NULL CHECK (
    match_class IN (
      'exact_match',
      'probable_match',
      'name_only_match',
      'conflict',
      'unmatched',
      'third_party_review',
      'temporary_review'
    )
  ),
  signal_kind TEXT CHECK (signal_kind IS NULL OR signal_kind IN ('phone', 'name')),
  signal_digest TEXT CHECK (
    signal_digest IS NULL OR (length(signal_digest) = 64 AND signal_digest NOT GLOB '*[^0-9a-f]*')
  ),
  crm_contact_id TEXT CHECK (crm_contact_id IS NULL OR length(trim(crm_contact_id)) > 0),
  crm_entity TEXT CHECK (crm_entity IS NULL OR crm_entity IN ('contact')),
  evidence TEXT NOT NULL CHECK (length(trim(evidence)) BETWEEN 3 AND 200),
  confidence TEXT NOT NULL DEFAULT 'none' CHECK (confidence IN ('none', 'low', 'medium', 'high')),
  auto_link INTEGER NOT NULL DEFAULT 0 CHECK (auto_link = 0),
  run_key TEXT REFERENCES crm_drive_analysis_run(run_key) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL CHECK (length(trim(analyzed_at)) > 0),
  -- exact_match is only ever allowed for a phone digest that is legitimately
  -- attributable to the customer (vCard TEL or sender label), never for text bodies.
  CHECK (
    match_class != 'exact_match'
    OR (signal_kind = 'phone' AND crm_contact_id IS NOT NULL AND crm_entity = 'contact')
  ),
  UNIQUE (drive_file_id, match_class, signal_digest, crm_contact_id),
  FOREIGN KEY (drive_file_id) REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_match_candidate_class
  ON crm_drive_match_candidate(match_class, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_drive_match_candidate_contact
  ON crm_drive_match_candidate(crm_contact_id) WHERE crm_contact_id IS NOT NULL;
