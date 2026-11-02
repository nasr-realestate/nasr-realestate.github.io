-- 0010_crm_drive_file_versions.sql — DRAFT FOR REVIEW. NOT APPLIED ANYWHERE.
-- Phase 2 / T2 blocker 1: per-version content tracking for crm_drive_file_registry.
--
-- STATUS: staged in `_worker/migrations-draft/` on purpose, exactly like 0009 was. Every CRM workflow
--         runs `wrangler d1 migrations apply` on the WHOLE `_worker/migrations/` directory, so a file
--         placed there would be applied to `nasr-crm-test-db` by the next run of
--         crm-phase4-analysis.yml, crm-phase3-registry.yml, crm-cloudflare-test-d1.yml or
--         crm-cloudflare-test-deploy.yml. Promotion requires explicit approval, and that same commit
--         must raise the migration counter in .github/workflows/crm-phase4-analysis.yml.
--
-- THE DEFECT THIS FIXES (measured, not assumed):
--   `crm_drive_file_registry` (0007) holds ONE fingerprint per file: content_sha256 /
--   inner_content_sha256 are plain columns on the file row. _worker/crm-drive-file-registry.js:683
--   (`recordContentHash`) writes them with `SET content_sha256 = ?`. So a second observation of the
--   same file does not record a new version — it OVERWRITES the previous fingerprint, and the earlier
--   content state ceases to exist. Nothing in the schema can answer "what was this file before?".
--   There is also no revision column at all (no drive revision id, no md5), while the folder contains
--   files at Drive revisions 2..6 (T1 listing, 2026-11-02): a content swap that keeps size and
--   modifiedTime is invisible to every reconciliation performed so far.
--
-- BARRIERS ENCODED HERE (refusals, not conventions):
--   * content_sha256 / inner_content_sha256 on the FILE row become projections: an UPDATE may only set
--     them to the digest of the version row currently marked HEAD, and may never set them back to NULL
--     (trg_registry_fingerprint_is_a_projection, trg_registry_fingerprint_irreversible). A fingerprint
--     can therefore only be replaced by APPENDING a version, never in place.
--   * version rows are append-only and dense: seq must equal max+1 per file, no UPDATE, no DELETE, and
--     observed_at may not run backwards (like 0009's per-case density rule, which is what makes a
--     deleted row impossible to hide).
--   * a version row REQUIRES a real digest (NOT NULL, 64-hex) and a registry row that already carries
--     drive_ref. Consequence, and this is the point: a metadata-only walk (size + modifiedTime, bytes
--     untouched) cannot create a version row, cannot advance processing_status past
--     'metadata_scanned' (0007 already requires content_sha256 for 'hashed'/'processed'), and so can
--     never conclude that two files are equal or that a file is unchanged. Same size + same
--     modifiedTime is not evidence, structurally.
--   * a repeated digest for the same file must be marked as a repeat of a specific earlier version, so
--     an A->B->A cycle is visible instead of being silently deduplicated or overwritten.
--   * a duplicate claim must PIN (ref, version_seq) of the row it duplicates, and that pinned version
--     must actually share the digest — a lineage that later drifts is reported by a view instead of
--     quietly becoming wrong. (0007's duplicate_of_file_id alone could not express this: the canonical
--     row's fingerprint is mutable, so the claim re-points at whatever it now says.)
--   * no personal data: this migration adds no name/path/message column. The join handle is
--     drive_ref = sha256("crm-p4-v1\ndrive_ref\n<id>"), a one-way handle, already the repo convention.
--     A BEFORE-INSERT trigger refuses a version row whose drive_ref does not exist in the registry, so
--     history cannot be manufactured for an arbitrary hash.
--   * HONEST LIMIT, same class as 0009's: D1 has no SHA-256 in SQL, so the digests here are supplied by
--     the writer. This migration makes an UNVERIFIED digest impossible to *confuse* with a verified one
--     (evidence_class is mandatory and every view reports it), and it makes the registry's projection
--     auditable, but detection of a forged/legacy digest is the job of a read-only recomputation pass
--     (the same shape as scripts/crm/verify-review-event-chain.mjs), not of a CHECK.
--
-- EFFECT ON EXISTING DATA (nasr-crm-test-db, measured 2026-11-02 via crm-drive-registry-snapshot):
--   99 rows, all processing_status='processed', all with a 64-hex content_sha256. This migration
--   ADDS columns with defaults and ADDS tables; it rewrites no row and drops nothing. Backfill is a
--   separate, idempotent statement (§5) that creates exactly one bootstrap version per registered file,
--   labelled evidence_class='bootstrap_backfill' — a claim that a digest was recorded, never a proof
--   that today's bytes still match. drive_ref cannot be computed in SQL, so §5 is a no-op until the
--   writer fills registry.drive_ref; the migration therefore does not depend on a hash function it
--   cannot have, and applying it is inert with respect to content claims.

-- ---------------------------------------------------------------------------
-- 1) the file row gains a stable, non-personal handle and a head pointer
-- ---------------------------------------------------------------------------
-- SQLite forbids ADD COLUMN with a REFERENCES clause, so integrity for these columns lives in the
-- triggers below rather than in an inline FK (same reason 0007's duplicate_of_file_id is the only FK).
ALTER TABLE crm_drive_file_registry ADD COLUMN drive_ref TEXT
  CHECK (drive_ref IS NULL OR (length(drive_ref) = 64 AND drive_ref NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE crm_drive_file_registry ADD COLUMN head_version_seq INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(head_version_seq) = 'integer' AND head_version_seq >= 0);
ALTER TABLE crm_drive_file_registry ADD COLUMN versions_observed INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(versions_observed) = 'integer' AND versions_observed >= 0);
-- Drive's own revision id (a numeric string) and its md5: secondary signals, never sufficient alone,
-- but the only cheap way to notice a swap that keeps size and modifiedTime.
ALTER TABLE crm_drive_file_registry ADD COLUMN drive_revision TEXT
  CHECK (drive_revision IS NULL OR (length(drive_revision) BETWEEN 1 AND 32
                                    AND drive_revision NOT GLOB '*[^0-9]*'));
ALTER TABLE crm_drive_file_registry ADD COLUMN drive_md5 TEXT
  CHECK (drive_md5 IS NULL OR (length(drive_md5) = 32 AND drive_md5 NOT GLOB '*[^0-9a-f]*'));
-- how much trust the head fingerprint deserves; NULL means "no version row recorded yet"
ALTER TABLE crm_drive_file_registry ADD COLUMN head_evidence_class TEXT
  CHECK (head_evidence_class IS NULL OR head_evidence_class IN
         ('verified_local_recompute', 'declared_by_writer', 'bootstrap_backfill'));
-- a duplicate claim must pin the exact version it was decided against
ALTER TABLE crm_drive_file_registry ADD COLUMN duplicate_of_drive_ref TEXT
  CHECK (duplicate_of_drive_ref IS NULL OR (length(duplicate_of_drive_ref) = 64
                                            AND duplicate_of_drive_ref NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE crm_drive_file_registry ADD COLUMN duplicate_of_version_seq INTEGER
  CHECK (duplicate_of_version_seq IS NULL OR (typeof(duplicate_of_version_seq) = 'integer'
                                              AND duplicate_of_version_seq >= 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_drive_registry_ref
  ON crm_drive_file_registry(drive_ref) WHERE drive_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_drive_registry_revision
  ON crm_drive_file_registry(drive_revision) WHERE drive_revision IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) one immutable row per observed content state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_file_version (
  version_ref   TEXT    NOT NULL PRIMARY KEY,
  drive_ref     TEXT    NOT NULL CHECK (length(drive_ref) = 64 AND drive_ref NOT GLOB '*[^0-9a-f]*'),
  version_seq   INTEGER NOT NULL CHECK (typeof(version_seq) = 'integer' AND version_seq >= 1),
  content_sha256 TEXT   NOT NULL CHECK (length(content_sha256) = 64
                                         AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  inner_content_sha256 TEXT CHECK (inner_content_sha256 IS NULL
                                    OR (length(inner_content_sha256) = 64
                                        AND inner_content_sha256 NOT GLOB '*[^0-9a-f]*')),
  size_bytes    INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes >= 0
                                        AND size_bytes <= 5000000000),
  -- where the digest came from. This column is the answer to "is this a measurement or a claim?".
  evidence_class TEXT    NOT NULL CHECK (evidence_class IN
                    ('verified_local_recompute', 'declared_by_writer', 'bootstrap_backfill')),
  drive_revision TEXT    CHECK (drive_revision IS NULL OR (length(drive_revision) BETWEEN 1 AND 32
                                                           AND drive_revision NOT GLOB '*[^0-9]*')),
  drive_md5     TEXT    CHECK (drive_md5 IS NULL OR (length(drive_md5) = 32
                                                      AND drive_md5 NOT GLOB '*[^0-9a-f]*')),
  drive_modified_at TEXT CHECK (drive_modified_at IS NULL
                                OR (length(drive_modified_at) BETWEEN 10 AND 32
                                    AND datetime(drive_modified_at) IS NOT NULL)),
  observed_at   TEXT    NOT NULL CHECK (length(observed_at) BETWEEN 10 AND 32
                                        AND datetime(observed_at) IS NOT NULL),
  observed_by   TEXT    NOT NULL CHECK (observed_by IN
                    ('intake_pipeline', 'reconciliation', 'registry_bootstrap', 'manual_refresh')),
  receipt_ref   TEXT    CHECK (receipt_ref IS NULL OR (length(trim(receipt_ref)) BETWEEN 3 AND 160
                                                        AND receipt_ref NOT GLOB '*[^A-Za-z0-9_.:/-]*')),
  repeat_of_version_ref TEXT,
  -- version_ref is DERIVED, not supplied: a writer cannot smuggle a row that no join can find.
  CHECK (version_ref = drive_ref || '#' || version_seq),
  -- SQLite rule found the hard way here: a TABLE-level CHECK may only reference columns declared to
  -- its left, so both rules below sit after the whole column list. (A column-level CHECK may refer to
  -- any column; a table-level one may not — the compiler refuses the file otherwise.)
  -- a digest of the empty input with a claimed non-zero size is a lazy or hostile writer, not a fact
  CHECK (size_bytes = 0 OR content_sha256 <>
         'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
  -- only a recompute over bytes the writer actually fetched may skip a receipt; it must not.
  CHECK (evidence_class <> 'verified_local_recompute' OR receipt_ref IS NOT NULL),
  -- A->B->A must say so: the first earlier row with the same digest is the only legal target
  CHECK (repeat_of_version_ref IS NULL
         OR (repeat_of_version_ref <> version_ref
             AND substr(repeat_of_version_ref, 1, 64) = drive_ref)),
  UNIQUE (drive_ref, version_seq)
);
CREATE INDEX IF NOT EXISTS idx_crm_drive_version_ref_seq
  ON crm_drive_file_version(drive_ref, version_seq DESC);
CREATE INDEX IF NOT EXISTS idx_crm_drive_version_digest
  ON crm_drive_file_version(content_sha256);
CREATE INDEX IF NOT EXISTS idx_crm_drive_version_inner_digest
  ON crm_drive_file_version(inner_content_sha256) WHERE inner_content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_drive_version_observed
  ON crm_drive_file_version(observed_at, drive_ref);

-- ---------------------------------------------------------------------------
-- 3) the version ledger is append-only, dense and never retro-dated
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_drive_version_no_update
  BEFORE UPDATE ON crm_drive_file_version
BEGIN
  SELECT RAISE(ABORT, 'drive_versions_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_drive_version_no_delete
  BEFORE DELETE ON crm_drive_file_version
BEGIN
  SELECT RAISE(ABORT, 'drive_versions_are_append_only');
END;

-- (3.1) only the next seq may be appended: no gap, no rewrite, no "replace version 1 with my digest".
--       This is the barrier that makes requirement "never overwrite an earlier fingerprint" a fact of
--       the database rather than a convention of the writer.
CREATE TRIGGER IF NOT EXISTS trg_drive_version_seq_dense
  BEFORE INSERT ON crm_drive_file_version
  WHEN NEW.version_seq <> (SELECT COALESCE(MAX(v.version_seq), 0) + 1
                             FROM crm_drive_file_version v WHERE v.drive_ref = NEW.drive_ref)
BEGIN
  SELECT RAISE(ABORT, 'drive_version_seq_not_next');
END;

-- (3.2) a version row may only be written about a file the registry already knows by ref, so history
--       cannot be manufactured for an arbitrary digest, and refs stay joinable in one direction.
--
--       Measured, not reasoned, while wiring the service layer: this barrier must NOT also require
--       r.content_sha256 IS NOT NULL. §4 already refuses writing a fingerprint that is not a recorded
--       head version, so demanding a fingerprint before the FIRST version row exists deadlocks the real
--       intake path (metadata_scanned → hashed): with a NULL digest on the file row the version insert is
--       refused here and the digest update is refused there, and no writer could ever record a file's
--       first version — only a destructive INSERT OR REPLACE of the whole file row would slip past, which
--       is not a path to design around. Being registered by ref is the rule; the legality of the digest is
--       §4's job, and §4 cannot be evaded by reordering writes: after this insert the ledger holds the
--       digest, the head projection moves to it, and the file row's fingerprint must still match or be set
--       to exactly that value.
CREATE TRIGGER IF NOT EXISTS trg_drive_version_ref_registered
  BEFORE INSERT ON crm_drive_file_version
  WHEN NOT EXISTS (SELECT 1 FROM crm_drive_file_registry r WHERE r.drive_ref = NEW.drive_ref)
BEGIN
  SELECT RAISE(ABORT, 'drive_version_ref_not_registered');
END;

-- (3.3) time may not run backwards inside one file's history
CREATE TRIGGER IF NOT EXISTS trg_drive_version_time_forward
  BEFORE INSERT ON crm_drive_file_version
  WHEN (SELECT MAX(datetime(v.observed_at)) FROM crm_drive_file_version v
         WHERE v.drive_ref = NEW.drive_ref AND v.version_seq = NEW.version_seq - 1)
         > datetime(NEW.observed_at)
BEGIN
  SELECT RAISE(ABORT, 'drive_version_time_moved_backwards');
END;

-- (3.4) re-observing a digest this file already had must be marked, and must point at the earliest row
--       carrying it. An unmarked repeat is refused: that is the shape of a confused or lazy writer.
CREATE TRIGGER IF NOT EXISTS trg_drive_version_repeat_marked
  BEFORE INSERT ON crm_drive_file_version
  WHEN EXISTS (SELECT 1 FROM crm_drive_file_version p
                 WHERE p.drive_ref = NEW.drive_ref AND p.content_sha256 = NEW.content_sha256
                   AND p.version_seq < NEW.version_seq)
       AND (NEW.repeat_of_version_ref IS NULL
            OR NEW.repeat_of_version_ref <> (
                 SELECT q.version_ref FROM crm_drive_file_version q
                  WHERE q.drive_ref = NEW.drive_ref AND q.content_sha256 = NEW.content_sha256
                  ORDER BY q.version_seq ASC LIMIT 1))
BEGIN
  SELECT RAISE(ABORT, 'drive_version_repeat_must_be_marked');
END;

-- (3.5) a repeat must not be claimed for a digest that was never seen before
CREATE TRIGGER IF NOT EXISTS trg_drive_version_repeat_real
  BEFORE INSERT ON crm_drive_file_version
  WHEN NEW.repeat_of_version_ref IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM crm_drive_file_version p
                        WHERE p.version_ref = NEW.repeat_of_version_ref
                          AND p.content_sha256 = NEW.content_sha256)
BEGIN
  SELECT RAISE(ABORT, 'drive_version_repeat_target_invalid');
END;

-- (3.6) the file row's head pointer is a projection of the ledger, maintained by the ledger
CREATE TRIGGER IF NOT EXISTS trg_drive_version_after_insert
  AFTER INSERT ON crm_drive_file_version
BEGIN
  UPDATE crm_drive_file_registry
     SET drive_ref           = NEW.drive_ref,
         head_version_seq    = NEW.version_seq,
         versions_observed   = (SELECT COUNT(*) FROM crm_drive_file_version v
                                 WHERE v.drive_ref = NEW.drive_ref),
         head_evidence_class = NEW.evidence_class,
         drive_revision      = NEW.drive_revision,
         drive_md5           = NEW.drive_md5,
         updated_at          = NEW.observed_at
   WHERE drive_ref = NEW.drive_ref;
END;

-- ---------------------------------------------------------------------------
-- 4) the file row's fingerprints stop being mutable facts
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_registry_fingerprint_is_a_projection
  BEFORE UPDATE OF content_sha256 ON crm_drive_file_registry
  WHEN NEW.content_sha256 IS NOT OLD.content_sha256
       AND (NEW.drive_ref IS NULL
            OR NOT EXISTS (SELECT 1 FROM crm_drive_file_version v
                            WHERE v.drive_ref = NEW.drive_ref
                              AND v.version_seq = NEW.head_version_seq
                              AND v.content_sha256 = NEW.content_sha256))
BEGIN
  SELECT RAISE(ABORT, 'registry_fingerprint_must_match_recorded_head_version');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_fingerprint_irreversible
  BEFORE UPDATE OF content_sha256 ON crm_drive_file_registry
  WHEN OLD.content_sha256 IS NOT NULL AND NEW.content_sha256 IS NULL
BEGIN
  SELECT RAISE(ABORT, 'registry_fingerprint_cannot_be_erased');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_inner_fingerprint_is_a_projection
  BEFORE UPDATE OF inner_content_sha256 ON crm_drive_file_registry
  WHEN NEW.inner_content_sha256 IS NOT OLD.inner_content_sha256
       AND NEW.inner_content_sha256 IS NOT NULL
       AND (NEW.drive_ref IS NULL
            OR NOT EXISTS (SELECT 1 FROM crm_drive_file_version v
                            WHERE v.drive_ref = NEW.drive_ref
                              AND v.version_seq = NEW.head_version_seq
                              AND (v.inner_content_sha256 IS NEW.inner_content_sha256
                                   OR (v.inner_content_sha256 IS NULL
                                       AND NEW.inner_content_sha256 = v.content_sha256))))
BEGIN
  SELECT RAISE(ABORT, 'registry_inner_fingerprint_must_match_recorded_head_version');
END;

-- (4.0) head_version_seq / versions_observed are ledger projections: no writer may set them to anything
--       other than what the version rows say, so a head cannot be pointed at a convenient version.
CREATE TRIGGER IF NOT EXISTS trg_registry_head_starts_empty
  BEFORE INSERT ON crm_drive_file_registry
  WHEN COALESCE(NEW.head_version_seq, 0) <> 0 OR COALESCE(NEW.versions_observed, 0) <> 0
       OR NEW.head_evidence_class IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'registry_head_is_maintained_by_the_ledger');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_head_matches_ledger
  BEFORE UPDATE OF head_version_seq, versions_observed, head_evidence_class ON crm_drive_file_registry
  WHEN NEW.head_version_seq IS NOT (SELECT COALESCE(MAX(v.version_seq), 0)
                                      FROM crm_drive_file_version v WHERE v.drive_ref = NEW.drive_ref)
       OR NEW.versions_observed IS NOT (SELECT COUNT(*) FROM crm_drive_file_version v
                                         WHERE v.drive_ref = NEW.drive_ref)
       OR NEW.head_evidence_class IS NOT (SELECT v.evidence_class FROM crm_drive_file_version v
                                          WHERE v.drive_ref = NEW.drive_ref
                                            AND v.version_seq = NEW.head_version_seq)
BEGIN
  SELECT RAISE(ABORT, 'registry_head_must_match_ledger');
END;

-- (4.0b) the file row may not be deleted out from under its history, and its handle is write-once:
--        a re-pointed ref would silently move a whole version ledger onto another file.
CREATE TRIGGER IF NOT EXISTS trg_registry_row_has_history
  BEFORE DELETE ON crm_drive_file_registry
  WHEN EXISTS (SELECT 1 FROM crm_drive_file_version v WHERE v.drive_ref = OLD.drive_ref)
       OR EXISTS (SELECT 1 FROM crm_drive_file_registry c
                   WHERE c.duplicate_of_drive_ref = OLD.drive_ref)
BEGIN
  SELECT RAISE(ABORT, 'registry_row_anchors_versions_or_lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_ref_is_write_once
  BEFORE UPDATE OF drive_ref ON crm_drive_file_registry
  WHEN OLD.drive_ref IS NOT NULL AND NEW.drive_ref IS NOT OLD.drive_ref
BEGIN
  SELECT RAISE(ABORT, 'registry_drive_ref_is_write_once');
END;

-- (4.1) 'duplicate' must pin a version, and the pinned version must really share the digest. 0007's
--       own CHECK already demands duplicate_of_file_id + content_sha256; this adds the version pin, so
--       a claim survives the canonical row moving on to new bytes.
CREATE TRIGGER IF NOT EXISTS trg_registry_duplicate_pin_insert
  BEFORE INSERT ON crm_drive_file_registry
  WHEN NEW.processing_status = 'duplicate'
       AND (NEW.duplicate_of_drive_ref IS NULL OR NEW.duplicate_of_version_seq IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'duplicate_claim_must_pin_a_version');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_duplicate_pin_update
  BEFORE UPDATE OF processing_status, duplicate_of_drive_ref, duplicate_of_version_seq
    ON crm_drive_file_registry
  WHEN NEW.processing_status = 'duplicate'
       AND (NEW.duplicate_of_drive_ref IS NULL OR NEW.duplicate_of_version_seq IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'duplicate_claim_must_pin_a_version');
END;

CREATE TRIGGER IF NOT EXISTS trg_registry_duplicate_pin_self
  BEFORE UPDATE OF processing_status, duplicate_of_drive_ref, duplicate_of_version_seq
    ON crm_drive_file_registry
  WHEN NEW.processing_status = 'duplicate'
       AND NEW.duplicate_of_drive_ref IS NOT NULL
       AND NEW.duplicate_of_drive_ref = NEW.drive_ref
BEGIN
  SELECT RAISE(ABORT, 'duplicate_claim_must_pin_another_files_version');
END;

-- (4.2) metadata-only walks may not pretend otherwise: 'downloaded'/'hashed'/'processed' require a
--       version row, which by construction requires bytes. 0007 already refuses 'hashed'/'processed'
--       without a digest; this closes the 'downloaded' loophole (a claim of bytes without a record).
CREATE TRIGGER IF NOT EXISTS trg_registry_status_needs_version
  BEFORE UPDATE OF processing_status ON crm_drive_file_registry
  WHEN NEW.processing_status IN ('downloaded', 'hashed', 'processed', 'duplicate')
       AND COALESCE(NEW.head_version_seq, 0) < 1
BEGIN
  SELECT RAISE(ABORT, 'status_requires_a_recorded_version');
END;

-- the same rule on the way IN: a file may not arrive already claiming a content state. This is not
-- pedantry — the version ledger cannot exist before the file row (its density trigger reads the
-- registry), so an INSERT-only path was a way to park a file at 'processed' forever with zero evidence.
CREATE TRIGGER IF NOT EXISTS trg_registry_status_needs_version_insert
  BEFORE INSERT ON crm_drive_file_registry
  WHEN NEW.processing_status IN ('downloaded', 'hashed', 'processed', 'duplicate')
       AND COALESCE(NEW.head_version_seq, 0) < 1
BEGIN
  SELECT RAISE(ABORT, 'status_requires_a_recorded_version');
END;

-- ---------------------------------------------------------------------------
-- 5) backfill — one bootstrap version per already-registered file (idempotent)
-- ---------------------------------------------------------------------------
-- Run AFTER the writer has filled crm_drive_file_registry.drive_ref (SQL has no SHA-256). Until then
-- this selects zero rows and is a no-op, which is the safe direction for a mistake. Re-running is
-- harmless: the NOT EXISTS guard makes it idempotent, and the density trigger makes a second attempt
-- impossible to fake as a "new version".
INSERT INTO crm_drive_file_version
    (version_ref, drive_ref, version_seq, content_sha256, inner_content_sha256, evidence_class,
     size_bytes, drive_revision, drive_md5, drive_modified_at, observed_at, observed_by, receipt_ref)
SELECT r.drive_ref || '#1', r.drive_ref, 1, r.content_sha256, r.inner_content_sha256,
       'bootstrap_backfill', COALESCE(r.file_size, 0), NULL, NULL, r.drive_modified_at,
       COALESCE(r.last_seen_at, r.created_at), 'registry_bootstrap',
       'phase2-0010-bootstrap'
  FROM crm_drive_file_registry r
 WHERE r.drive_ref IS NOT NULL AND r.content_sha256 IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM crm_drive_file_version v WHERE v.drive_ref = r.drive_ref);

-- ---------------------------------------------------------------------------
-- 6) read-only surfaces — what CI may print, and what a human must see before deciding
-- ---------------------------------------------------------------------------
-- the whole point in one row per file: does the metadata still agree, and was the agreement ever
-- worth anything? 'changed_under_identical_metadata' is the failure mode this migration exists to see.
CREATE VIEW IF NOT EXISTS crm_drive_version_state AS
SELECT r.drive_ref AS drive_ref,
       r.file_size AS registry_size_bytes,
       r.drive_modified_at AS registry_modified_at,
       r.content_sha256 AS registry_sha256,
       r.versions_observed AS versions_observed,
       r.head_version_seq AS head_version_seq,
       v.content_sha256 AS head_sha256,
       v.size_bytes AS head_size_bytes,
       v.drive_modified_at AS head_modified_at,
       v.evidence_class AS head_evidence_class,
       v.observed_at AS head_observed_at,
       CASE WHEN r.drive_ref IS NULL THEN 'ref_not_backfilled'
            WHEN r.versions_observed = 0 THEN 'no_version_rows'
            WHEN r.head_version_seq <> v.version_seq THEN 'head_pointer_stale'
            WHEN r.content_sha256 IS NOT v.content_sha256 THEN 'registry_fingerprint_not_head'
            ELSE 'aligned' END AS projection_state,
       CASE WHEN v.version_ref IS NULL THEN 'unknown'
            WHEN r.file_size IS v.size_bytes AND r.drive_modified_at IS v.drive_modified_at
                 AND r.content_sha256 IS NOT v.content_sha256 THEN 'changed_under_identical_metadata'
            WHEN r.file_size IS v.size_bytes AND r.drive_modified_at IS v.drive_modified_at
                 AND r.content_sha256 IS v.content_sha256 THEN 'metadata_and_digest_agree'
            ELSE 'metadata_differs' END AS metadata_agreement,
       CASE WHEN v.version_ref IS NOT NULL
            AND v.size_bytes = r.file_size AND v.drive_modified_at = r.drive_modified_at
            THEN 0 ELSE 1 END AS metadata_is_silent
  FROM crm_drive_file_registry r
  LEFT JOIN crm_drive_file_version v
    ON v.drive_ref = r.drive_ref AND v.version_seq = r.head_version_seq;

-- everything still unproven: the queue T2 must actually work through, ordered by exposure
CREATE VIEW IF NOT EXISTS crm_drive_rehash_queue AS
SELECT r.drive_ref AS drive_ref,
       r.processing_status AS processing_status,
       COALESCE(r.versions_observed, 0) AS versions_observed,
       COALESCE(v.evidence_class, 'none') AS head_evidence_class,
       CASE WHEN COALESCE(r.versions_observed, 0) = 0 THEN 'no_version_row'
            WHEN v.evidence_class = 'bootstrap_backfill' THEN 'bootstrap_claim_only'
            WHEN v.evidence_class = 'declared_by_writer' THEN 'writer_claim_only'
            ELSE 'verified' END AS reason
  FROM crm_drive_file_registry r
  LEFT JOIN crm_drive_file_version v
    ON v.drive_ref = r.drive_ref AND v.version_seq = r.head_version_seq
 WHERE COALESCE(r.versions_observed, 0) = 0 OR v.evidence_class <> 'verified_local_recompute';

-- who said what about digests, in aggregate — the trust ledger of this table
CREATE VIEW IF NOT EXISTS crm_drive_version_provenance AS
SELECT evidence_class AS evidence_class,
       observed_by AS observed_by,
       COUNT(*) AS version_rows,
       COUNT(DISTINCT drive_ref) AS files,
       SUM(CASE WHEN inner_content_sha256 IS NULL THEN 1 ELSE 0 END) AS without_inner_digest,
       SUM(CASE WHEN drive_md5 IS NULL THEN 1 ELSE 0 END) AS without_md5,
       SUM(CASE WHEN drive_revision IS NULL THEN 1 ELSE 0 END) AS without_revision,
       MIN(observed_at) AS first_observed_at,
       MAX(observed_at) AS last_observed_at
  FROM crm_drive_file_version
 GROUP BY evidence_class, observed_by;

-- duplicate lineage, checked against the version it was pinned to — never against "whatever the row
-- says today". drift is a reportable fact, not a silent re-binding.
CREATE VIEW IF NOT EXISTS crm_drive_duplicate_lineage AS
SELECT r.drive_ref AS drive_ref,
       r.duplicate_of_drive_ref AS canonical_ref,
       r.duplicate_of_version_seq AS canonical_seq,
       r.content_sha256 AS claimed_sha256,
       p.content_sha256 AS pinned_sha256,
       (SELECT MAX(c.version_seq) FROM crm_drive_file_version c
         WHERE c.drive_ref = r.duplicate_of_drive_ref) AS canonical_head_seq,
       CASE WHEN r.duplicate_of_drive_ref IS NULL THEN 'not_a_duplicate'
            WHEN p.version_ref IS NULL THEN 'pinned_version_missing'
            WHEN p.content_sha256 IS NOT r.content_sha256 THEN 'drift_pinned_digest_differs'
            WHEN r.duplicate_of_version_seq <> (SELECT MAX(c.version_seq) FROM crm_drive_file_version c
                                                 WHERE c.drive_ref = r.duplicate_of_drive_ref)
                 THEN 'drift_canonical_moved_forward'
            ELSE 'verified' END AS lineage_state
  FROM crm_drive_file_registry r
  LEFT JOIN crm_drive_file_version p
    ON p.drive_ref = r.duplicate_of_drive_ref
   AND p.version_seq = r.duplicate_of_version_seq;

-- the only two-level duplicate evidence this schema will ever offer a human: same OUTER digest, or
-- same INNER record-set digest with a different container. Provisional fingerprints are excluded by
-- absence: they cannot exist in crm_drive_file_version at all.
CREATE VIEW IF NOT EXISTS crm_drive_duplicate_evidence AS
SELECT 'outer' AS level, v.content_sha256 AS digest,
       COUNT(DISTINCT v.drive_ref) AS files,
       GROUP_CONCAT(DISTINCT substr(v.drive_ref, 1, 12)) AS refs_prefix
  FROM crm_drive_file_version v
  WHERE v.evidence_class = 'verified_local_recompute'
 GROUP BY v.content_sha256
HAVING COUNT(DISTINCT v.drive_ref) > 1
UNION ALL
SELECT 'inner' AS level, v.inner_content_sha256 AS digest,
       COUNT(DISTINCT v.drive_ref) AS files,
       GROUP_CONCAT(DISTINCT substr(v.drive_ref, 1, 12)) AS refs_prefix
  FROM crm_drive_file_version v
  WHERE v.evidence_class = 'verified_local_recompute' AND v.inner_content_sha256 IS NOT NULL
 GROUP BY v.inner_content_sha256
HAVING COUNT(DISTINCT v.drive_ref) > 1;

-- one statement that fails closed if the ledger and the projections disagree; safe to run anywhere,
-- any time, and the pre-promotion check in the local rehearsal.
CREATE VIEW IF NOT EXISTS crm_drive_version_invariant_violations AS
SELECT (SELECT COUNT(*) FROM crm_drive_file_registry r
         WHERE r.drive_ref IS NOT NULL
           AND r.versions_observed <> (SELECT COUNT(*) FROM crm_drive_file_version v
                                        WHERE v.drive_ref = r.drive_ref)) AS counter_mismatches,
       (SELECT COUNT(*) FROM crm_drive_file_registry r
         WHERE r.head_version_seq > 0
           AND NOT EXISTS (SELECT 1 FROM crm_drive_file_version v
                            WHERE v.drive_ref = r.drive_ref AND v.version_seq = r.head_version_seq))
         AS dangling_heads,
       (SELECT COUNT(*) FROM crm_drive_file_version v
         WHERE v.version_seq > (SELECT MIN(w.version_seq) FROM crm_drive_file_version w
                                 WHERE w.drive_ref = v.drive_ref)
           AND NOT EXISTS (SELECT 1 FROM crm_drive_file_version u
                            WHERE u.drive_ref = v.drive_ref AND u.version_seq = v.version_seq - 1))
         AS seq_gaps,
       (SELECT COUNT(*) FROM crm_drive_file_registry r
         WHERE r.processing_status IN ('hashed', 'processed', 'duplicate')
           AND COALESCE(r.head_version_seq, 0) < 1) AS status_without_version;
