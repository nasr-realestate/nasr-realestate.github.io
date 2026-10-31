-- Additive CRM migration 0007 (isolated nasr-crm-test-db only):
-- Central Google Drive file tracking & deduplication registry (crm_drive_file_registry).
-- Stores technical Drive metadata, verified byte-level SHA-256 digests, processing and
-- human-review state machines, non-destructive duplicate lineage, and non-PII receipts.
-- Never stores chat bodies, extracted contacts, or phone numbers; never apply to nasr-market-db.

CREATE TABLE IF NOT EXISTS crm_drive_file_registry (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  drive_file_id TEXT NOT NULL UNIQUE CHECK (length(trim(drive_file_id)) > 0),
  drive_parent_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  original_file_name TEXT NOT NULL CHECK (length(trim(original_file_name)) > 0),
  drive_path TEXT NOT NULL DEFAULT '/' CHECK (length(trim(drive_path)) > 0),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
  file_size INTEGER CHECK (file_size IS NULL OR (typeof(file_size) = 'integer' AND file_size >= 0)),
  drive_created_at TEXT CHECK (drive_created_at IS NULL OR length(trim(drive_created_at)) > 0),
  drive_modified_at TEXT CHECK (drive_modified_at IS NULL OR length(trim(drive_modified_at)) > 0),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  inner_content_sha256 TEXT CHECK (
    inner_content_sha256 IS NULL OR (length(inner_content_sha256) = 64 AND inner_content_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  content_type TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
    content_type IN ('VCF', 'ZIP', 'TXT', 'SPREADSHEET', 'DOCUMENT', 'MEDIA', 'OTHER', 'UNKNOWN')
  ),
  processing_status TEXT NOT NULL DEFAULT 'discovered' CHECK (
    processing_status IN (
      'discovered',
      'metadata_scanned',
      'downloaded',
      'hashed',
      'processed',
      'duplicate',
      'failed',
      'ignored'
    )
  ),
  review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
    review_status IN (
      'not_required',
      'pending',
      'approved',
      'rejected',
      'needs_manual_review'
    )
  ),
  last_processed_at TEXT CHECK (last_processed_at IS NULL OR length(trim(last_processed_at)) > 0),
  drive_modified_at_processed TEXT CHECK (
    drive_modified_at_processed IS NULL OR length(trim(drive_modified_at_processed)) > 0
  ),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (length(trim(last_seen_at)) > 0),
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(processing_attempts) = 'integer' AND processing_attempts >= 0
  ),
  processing_receipt_ref TEXT CHECK (
    processing_receipt_ref IS NULL OR (
      length(trim(processing_receipt_ref)) BETWEEN 3 AND 160
      AND processing_receipt_ref NOT GLOB '*[^A-Za-z0-9_.:/-]*'
    )
  ),
  extracted_records_count INTEGER CHECK (
    extracted_records_count IS NULL OR (typeof(extracted_records_count) = 'integer' AND extracted_records_count >= 0)
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(trim(error_code)) BETWEEN 2 AND 80
      AND error_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    )
  ),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
  duplicate_of_file_id TEXT REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE RESTRICT,
  reviewed_by TEXT CHECK (reviewed_by IS NULL OR length(trim(reviewed_by)) BETWEEN 3 AND 120),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR length(trim(reviewed_at)) > 0),
  review_notes TEXT NOT NULL DEFAULT '' CHECK (length(review_notes) <= 500),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (length(metadata_json) BETWEEN 2 AND 8192),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (length(trim(updated_at)) > 0),

  -- Metadata completeness required once beyond 'discovered' / 'failed' / 'ignored'
  CHECK (
    processing_status NOT IN ('metadata_scanned', 'downloaded', 'hashed', 'processed', 'duplicate')
    OR (drive_modified_at IS NOT NULL AND length(trim(drive_modified_at)) > 0)
  ),

  -- 'hashed' requires an actual 64-hex content_sha256
  CHECK (processing_status != 'hashed' OR content_sha256 IS NOT NULL),

  -- Cannot transition to 'processed' without verifiable processing success evidence
  CHECK (
    processing_status != 'processed' OR (
      content_sha256 IS NOT NULL
      AND last_processed_at IS NOT NULL
      AND processing_receipt_ref IS NOT NULL
      AND extracted_records_count IS NOT NULL AND extracted_records_count >= 0
      AND processing_attempts >= 1
      AND duplicate_of_file_id IS NULL
      AND error_code IS NULL
      AND error_message IS NULL
    )
  ),

  -- Duplicate lineage cannot self-reference and requires verified content_sha256
  CHECK (duplicate_of_file_id IS NULL OR duplicate_of_file_id != drive_file_id),
  CHECK (duplicate_of_file_id IS NULL OR content_sha256 IS NOT NULL),
  CHECK (
    processing_status != 'duplicate' OR (
      duplicate_of_file_id IS NOT NULL
      AND content_sha256 IS NOT NULL
    )
  ),

  -- 'failed' requires an explicit machine error_code
  CHECK (processing_status != 'failed' OR error_code IS NOT NULL),

  -- Cannot transition to 'approved' or 'rejected' without actual human review provenance
  CHECK (
    review_status NOT IN ('approved', 'rejected') OR (
      reviewed_by IS NOT NULL
      AND lower(trim(reviewed_by)) NOT IN (
        'auto', 'system', 'agent', 'ai', 'bot', 'worker', 'cron', 'anonymous', 'unknown', 'none'
      )
      AND reviewed_at IS NOT NULL
      AND length(trim(review_notes)) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_parent_seen
  ON crm_drive_file_registry(drive_parent_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_proc_status
  ON crm_drive_file_registry(processing_status, drive_modified_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_review_status
  ON crm_drive_file_registry(review_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_content_sha256
  ON crm_drive_file_registry(content_sha256) WHERE content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_inner_sha256
  ON crm_drive_file_registry(inner_content_sha256) WHERE inner_content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_duplicate_of
  ON crm_drive_file_registry(duplicate_of_file_id) WHERE duplicate_of_file_id IS NOT NULL;
