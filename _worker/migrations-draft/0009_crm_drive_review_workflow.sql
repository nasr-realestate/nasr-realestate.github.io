-- 0009_crm_drive_review_workflow.sql — DRAFT FOR REVIEW. NOT APPLIED ANYWHERE.
-- Phase 4 (human review preparation) — private review workflow over the Phase 4 analysis tables.
--
-- STATUS: staged OUTSIDE `_worker/migrations/` on purpose. Every CRM workflow runs
--         `wrangler d1 migrations apply`, which applies the WHOLE directory, so a file placed in
--         `_worker/migrations/` would be applied to `nasr-crm-test-db` by the next run of
--         crm-phase4-analysis.yml, crm-phase3-registry.yml, crm-cloudflare-test-d1.yml or
--         crm-cloudflare-test-deploy.yml. It moves into `_worker/migrations/` only after explicit
--         approval, and that same commit must raise the `migs = 8` guard in
--         .github/workflows/crm-phase4-analysis.yml:660 to 9 (see the security design, §7).
--
-- BARRIERS ENCODED HERE (they are not conventions, they are refusals):
--   * No personal data: no column can hold a contact name, a phone number, a transcript line or a
--     real Drive id. Original card bytes live in ONE opaque base64 ciphertext column.
--   * Append-only ledger: UPDATE/DELETE on crm_drive_review_event and crm_drive_review_chain_anchor
--     are refused by BEFORE-triggers. A correction is a NEW event carrying supersedes_id.
--   * Approval never links anything: link_applied / merge_authorized / contact_write_count are
--     CHECK-locked to 0, and no event_type can express a link, a merge or an import.
--   * Approval never rests on a name: a BEFORE-INSERT trigger refuses `approve` unless the case's
--     basis is a phone-backed identifier, and refuses it at all for multi-file person cases.
--   * Chain verifiable in pure SQL: per-run prev/hash linkage + per-case density + an immutable
--     anchor mirror, so edits, deletions, reordering and ledger wipes are detected even if these
--     triggers were dropped by a privileged raw write.
--   * FK direction: only crm_drive_review_case references crm_drive_analysis_run. The ledger has no
--     FK at all, so no cascade can ever erase a recorded human decision.

-- ---------------------------------------------------------------------------
-- 1) case index — rebuilt from the Phase 4 tables; digests and labels only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_review_case (
  case_ref      TEXT    NOT NULL PRIMARY KEY
                CHECK (case_ref GLOB 'p4r-[0-9][0-9][0-9]' OR case_ref GLOB 'p4c-[0-9][0-9]'),
  case_kind     TEXT    NOT NULL
                CHECK (case_kind IN ('file_to_contact','contact_fanout')),
  run_key       TEXT    NOT NULL
                REFERENCES crm_drive_analysis_run(run_key) ON DELETE CASCADE,
  -- provenance handles (masked / truncated), never a raw Drive id
  drive_file_id TEXT    CHECK (drive_file_id IS NULL
                               OR (length(drive_file_id) BETWEEN 8 AND 64
                                   AND drive_file_id NOT GLOB '*[^0-9a-f]*')),
  source_content_kind TEXT CHECK (source_content_kind IS NULL
                               OR source_content_kind IN ('ZIP','VCF','TXT')),
  card_index    INTEGER CHECK (card_index IS NULL OR (card_index >= 0 AND card_index <= 100000)),
  files_count   INTEGER CHECK (files_count IS NULL OR (files_count >= 1 AND files_count <= 1000)),
  -- classification carried over for display; never derived from a name
  match_class   TEXT    NOT NULL
                CHECK (match_class IN ('exact_match','probable_match','name_only_match','conflict',
                                       'third_party_review','temporary_review','unmatched')),
  evidence_type TEXT    NOT NULL CHECK (length(trim(evidence_type)) BETWEEN 3 AND 200
                                        AND length(evidence_type) = length(trim(evidence_type))),
  confidence    TEXT    NOT NULL CHECK (confidence IN ('none','low','medium','high')),
  signal_kind   TEXT    CHECK (signal_kind IS NULL OR signal_kind IN ('phone','name','none')),
  signal_digest TEXT    CHECK (signal_digest IS NULL
                               OR (length(signal_digest) = 64 AND signal_digest NOT GLOB '*[^0-9a-f]*')),
  crm_contact_id TEXT   CHECK (crm_contact_id IS NULL
                               OR (length(crm_contact_id) BETWEEN 8 AND 64
                                   AND crm_contact_id NOT GLOB '*[^0-9a-zA-Z_-]*')),
  -- basis is the ONLY thing an approval may ever rest on. `name_digest` and `body_text` exist here
  -- so a reviewer can SEE that a basis is weak, never so that they can approve on it.
  basis         TEXT    NOT NULL
                CHECK (basis IN ('vcard_tel','sender_label_phone','transcript_overlap','name_digest','body_text')),
  approve_allowed INTEGER NOT NULL DEFAULT 0 CHECK (approve_allowed IN (0,1)),
  -- what the reviewer was shown (redacted snapshot), bound into every decision and into the seal
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                                            AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  seal_state    TEXT    NOT NULL DEFAULT 'pending'
                CHECK (seal_state IN ('pending','sealed','expired','revoked','unavailable')),
  built_at      TEXT    NOT NULL CHECK (length(built_at) BETWEEN 10 AND 32 AND datetime(built_at) IS NOT NULL),
  -- (hard) approval is impossible unless the basis is phone-backed AND this is a single file case:
  -- a multi-file person case must be investigated, never approved.
  CHECK (approve_allowed = 0
         OR (basis IN ('vcard_tel','sender_label_phone') AND case_kind = 'file_to_contact')),
  -- kind shape: a file case names its file and its contact; a person case names no file and spans
  -- at least two files, and is always surfaced as a conflict.
  CHECK ((case_kind = 'file_to_contact' AND drive_file_id IS NOT NULL AND crm_contact_id IS NOT NULL)
         OR (case_kind = 'contact_fanout' AND drive_file_id IS NULL AND crm_contact_id IS NOT NULL
             AND files_count >= 2 AND match_class = 'conflict')),
  UNIQUE (run_key, case_ref)
);
CREATE INDEX IF NOT EXISTS idx_crm_review_case_run ON crm_drive_review_case(run_key, case_kind, case_ref);
CREATE INDEX IF NOT EXISTS idx_crm_review_case_file ON crm_drive_review_case(drive_file_id, case_ref);
CREATE INDEX IF NOT EXISTS idx_crm_review_case_contact ON crm_drive_review_case(crm_contact_id, case_ref);

-- ---------------------------------------------------------------------------
-- 2) sealed original card — opaque ciphertext; the only place original bytes may live.
--    Deliberately NOT append-only: retention and revocation must stay enforceable, and no decision
--    depends on it (the ledger never stores revealed bytes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_review_seal (
  case_ref      TEXT    NOT NULL PRIMARY KEY
                REFERENCES crm_drive_review_case(case_ref) ON DELETE CASCADE,
  run_key       TEXT    NOT NULL,
  envelope_version TEXT NOT NULL CHECK (envelope_version = 'p4rev_v1'),
  algo          TEXT    NOT NULL CHECK (algo = 'AES-256-GCM'),
  kdf           TEXT    NOT NULL CHECK (kdf = 'HKDF-SHA256'),
  aad_mode      TEXT    NOT NULL CHECK (aad_mode = 'case_bound_v1'),
  key_version   INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 99),
  iv_b64u       TEXT    NOT NULL CHECK (length(iv_b64u) = 16 AND iv_b64u NOT GLOB '*[^A-Za-z0-9_-]*'),
  tag_b64u      TEXT    NOT NULL CHECK (length(tag_b64u) = 22 AND tag_b64u NOT GLOB '*[^A-Za-z0-9_-]*'),
  ciphertext_b64u TEXT  NOT NULL CHECK (length(ciphertext_b64u) BETWEEN 24 AND 8192
                                        AND ciphertext_b64u NOT GLOB '*[^A-Za-z0-9_-]*'),
  ciphertext_sha256 TEXT NOT NULL UNIQUE
                CHECK (length(ciphertext_sha256) = 64 AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- binds the ciphertext to the redacted snapshot offered to the reviewer without revealing it
  plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64
                                        AND plaintext_sha256 NOT GLOB '*[^0-9a-f]*'),
  plaintext_len INTEGER NOT NULL CHECK (plaintext_len BETWEEN 1 AND 4096),
  sealed_by     TEXT    NOT NULL CHECK (sealed_by IN ('analysis_pipeline','manual_refresh')),
  created_at    TEXT    NOT NULL CHECK (length(created_at) BETWEEN 10 AND 32
                                        AND datetime(created_at) IS NOT NULL),
  expires_at    TEXT    NOT NULL CHECK (length(expires_at) BETWEEN 10 AND 32
                                        AND datetime(expires_at) IS NOT NULL
                                        AND datetime(expires_at) > datetime(created_at)),
  revoked_at    TEXT    CHECK (revoked_at IS NULL
                               OR (length(revoked_at) BETWEEN 10 AND 32 AND datetime(revoked_at) IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_review_seal_expiry ON crm_drive_review_seal(expires_at, case_ref);

-- ---------------------------------------------------------------------------
-- 3) the ledger — who / when / why, append-only, hash-chained, self-verifiable in pure SQL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_review_event (
  id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  run_key       TEXT    NOT NULL CHECK (length(run_key) BETWEEN 8 AND 128),
  event_seq     INTEGER NOT NULL CHECK (event_seq >= 1),
  case_seq      INTEGER NOT NULL CHECK (case_seq >= 1),
  case_ref      TEXT    NOT NULL CHECK (case_ref GLOB 'p4r-[0-9][0-9][0-9]'
                                        OR case_ref GLOB 'p4c-[0-9][0-9]'),
  event_type    TEXT    NOT NULL CHECK (event_type IN ('approve','exclude','defer',
                                                        'conflict_investigation','reveal','note')),
  decision_state TEXT   CHECK (decision_state IN ('approved','excluded','deferred','conflict')),
  -- who: a mandatory human label, plus the honest attestation that the label alone is not
  -- independent identity proof (agreed for this phase).
  reviewer      TEXT    NOT NULL CHECK (length(trim(reviewer)) BETWEEN 3 AND 120
                                        AND length(reviewer) = length(trim(reviewer))
                                        AND lower(reviewer) NOT IN ('auto','system','bot','worker','cron',
                                                                    'pipeline','operator','unknown','none','na','-')),
  reviewer_attestation TEXT NOT NULL
                CHECK (reviewer_attestation = 'session_label_not_independent_identity'),
  session_hash  TEXT    NOT NULL CHECK (length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  -- why: bounded and sanitized. The 9-consecutive-digit rule keeps phone numbers and national ids
  -- out of it (10 classes is refused by D1 itself: "LIKE or GLOB pattern too complex"), while an ISO
  -- date in prose stays legal. Spaced-out digits are caught by the service layer before insert.
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) BETWEEN 12 AND 1000
                                        AND length(reason) = length(trim(reason))
                                        AND reason NOT GLOB '*[' || char(9) || char(10) || char(13) || ']*'
                                        AND reason NOT GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'),
  reason_sha256 TEXT    NOT NULL CHECK (length(reason_sha256) = 64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- reveal bookkeeping: purpose and outcome only, never the revealed bytes
  reveal_purpose TEXT   CHECK (reveal_purpose IN ('identity_check','duplicate_check','contact_clarify')),
  reveal_outcome TEXT   CHECK (reveal_outcome IN ('granted','denied','failed','expired')),
  seal_ciphertext_sha256 TEXT CHECK (seal_ciphertext_sha256 IS NULL
                               OR (length(seal_ciphertext_sha256) = 64
                                   AND seal_ciphertext_sha256 NOT GLOB '*[^0-9a-f]*')),
  basis_at_event TEXT   NOT NULL
                CHECK (basis_at_event IN ('vcard_tel','sender_label_phone','transcript_overlap',
                                           'name_digest','body_text')),
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                                             AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- three nails: a review event can never assert a link, a merge or an operational write
  link_applied        INTEGER NOT NULL DEFAULT 0 CHECK (link_applied = 0),
  merge_authorized    INTEGER NOT NULL DEFAULT 0 CHECK (merge_authorized = 0),
  contact_write_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_write_count = 0),
  supersedes_id INTEGER  CHECK (supersedes_id IS NULL
                                OR (typeof(supersedes_id) = 'integer' AND supersedes_id >= 1)),
  occurred_at   TEXT    NOT NULL CHECK (length(occurred_at) BETWEEN 10 AND 32
                                        AND datetime(occurred_at) IS NOT NULL),
  prev_event_sha256 TEXT NOT NULL CHECK (length(prev_event_sha256) = 64
                                         AND prev_event_sha256 NOT GLOB '*[^0-9a-f]*'),
  event_sha256  TEXT    NOT NULL UNIQUE CHECK (length(event_sha256) = 64
                                               AND event_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- a decision event carries exactly the state its type implies; reveals and notes carry none
  CHECK (
    (event_type = 'approve'                AND decision_state = 'approved')
    OR (event_type = 'exclude'             AND decision_state = 'excluded')
    OR (event_type = 'defer'               AND decision_state = 'deferred')
    OR (event_type = 'conflict_investigation' AND decision_state = 'conflict')
    OR (event_type IN ('reveal','note')    AND decision_state IS NULL)
  ),
  CHECK ((event_type = 'reveal') = (reveal_purpose IS NOT NULL AND reveal_outcome IS NOT NULL)),
  CHECK ((event_type <> 'reveal') = (reveal_purpose IS NULL AND reveal_outcome IS NULL
                                      AND seal_ciphertext_sha256 IS NULL)),
  UNIQUE (run_key, event_seq),
  UNIQUE (case_ref, case_seq)
);
CREATE INDEX IF NOT EXISTS idx_crm_review_event_run ON crm_drive_review_event(run_key, event_seq);
CREATE INDEX IF NOT EXISTS idx_crm_review_event_case ON crm_drive_review_event(case_ref, case_seq);
CREATE INDEX IF NOT EXISTS idx_crm_review_event_reviewer ON crm_drive_review_event(reviewer, occurred_at);

-- ---------------------------------------------------------------------------
-- 4) checkpoints — a mutable head (fast path) mirrored per event by an immutable anchor ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_review_chain_head (
  run_key     TEXT NOT NULL PRIMARY KEY REFERENCES crm_drive_analysis_run(run_key) ON DELETE CASCADE,
  head_sha256 TEXT NOT NULL CHECK (length(head_sha256) = 64 AND head_sha256 NOT GLOB '*[^0-9a-f]*'),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  updated_at  TEXT NOT NULL CHECK (length(updated_at) BETWEEN 10 AND 32 AND datetime(updated_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS crm_drive_review_chain_anchor (
  seq         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  run_key     TEXT    NOT NULL CHECK (length(run_key) BETWEEN 8 AND 128),
  event_seq   INTEGER NOT NULL CHECK (event_seq >= 0),
  head_sha256 TEXT    NOT NULL CHECK (length(head_sha256) = 64 AND head_sha256 NOT GLOB '*[^0-9a-f]*'),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  anchor_source TEXT  NOT NULL CHECK (anchor_source IN ('genesis','trigger','ci_external')),
  anchored_at TEXT    NOT NULL CHECK (length(anchored_at) BETWEEN 10 AND 32
                                      AND datetime(anchored_at) IS NOT NULL),
  UNIQUE (run_key, event_seq)
);

-- ---------------------------------------------------------------------------
-- 5) triggers — immutability, chain continuity, and the approval-basis barrier
-- ---------------------------------------------------------------------------
-- (5.1) the ledger cannot be edited or erased; the only correction is a new event with supersedes_id
CREATE TRIGGER IF NOT EXISTS trg_review_event_no_update
  BEFORE UPDATE ON crm_drive_review_event
BEGIN
  SELECT RAISE(ABORT, 'review_events_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_event_no_delete
  BEFORE DELETE ON crm_drive_review_event
BEGIN
  SELECT RAISE(ABORT, 'review_events_are_append_only');
END;

-- (5.2) the anchor mirror is equally immutable, and the head may never disappear
CREATE TRIGGER IF NOT EXISTS trg_review_anchor_no_update
  BEFORE UPDATE ON crm_drive_review_chain_anchor
BEGIN
  SELECT RAISE(ABORT, 'review_anchors_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_anchor_no_delete
  BEFORE DELETE ON crm_drive_review_chain_anchor
BEGIN
  SELECT RAISE(ABORT, 'review_anchors_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_head_no_delete
  BEFORE DELETE ON crm_drive_review_chain_head
BEGIN
  SELECT RAISE(ABORT, 'review_chain_head_required');
END;

-- (5.3) an event must belong to a real case of this run, and to the snapshot that was shown
CREATE TRIGGER IF NOT EXISTS trg_review_event_case_exists
  BEFORE INSERT ON crm_drive_review_event
  WHEN (SELECT COUNT(*) FROM crm_drive_review_case c
        WHERE c.case_ref = NEW.case_ref AND c.run_key = NEW.run_key) <> 1
BEGIN
  SELECT RAISE(ABORT, 'review_event_case_not_found');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_event_snapshot_binding
  BEFORE INSERT ON crm_drive_review_event
  WHEN (SELECT COUNT(*) FROM crm_drive_review_case c WHERE c.case_ref = NEW.case_ref) = 1
      AND ((SELECT c.case_snapshot_sha256 FROM crm_drive_review_case c
            WHERE c.case_ref = NEW.case_ref) IS NOT NEW.case_snapshot_sha256
        OR (SELECT c.basis FROM crm_drive_review_case c
            WHERE c.case_ref = NEW.case_ref) IS NOT NEW.basis_at_event)
BEGIN
  SELECT RAISE(ABORT, 'review_event_snapshot_mismatch');
END;

-- (5.4) global continuity: prev must equal the current head, seq must be head+1, and time must not
--         run backwards. Without a head row nothing can be appended, so history cannot be restarted.
CREATE TRIGGER IF NOT EXISTS trg_review_event_chain_sequence
  BEFORE INSERT ON crm_drive_review_event
  WHEN (SELECT COUNT(*) FROM crm_drive_review_chain_head h WHERE h.run_key = NEW.run_key) <> 1
      OR NEW.prev_event_sha256 <> (SELECT h.head_sha256 FROM crm_drive_review_chain_head h
                                   WHERE h.run_key = NEW.run_key)
      OR NEW.event_seq <> (SELECT h.event_count + 1 FROM crm_drive_review_chain_head h
                           WHERE h.run_key = NEW.run_key)
      OR datetime(NEW.occurred_at) < (SELECT MAX(datetime(e.occurred_at)) FROM crm_drive_review_event e
                                      WHERE e.run_key = NEW.run_key)
BEGIN
  SELECT RAISE(ABORT, 'review_event_chain_sequence_broken');
END;

-- (5.5) per-case continuity, verifiable WITHOUT any hashing: a deleted or reordered event breaks the
--         density of case_seq and is caught by the verification views below.
CREATE TRIGGER IF NOT EXISTS trg_review_event_case_sequence
  BEFORE INSERT ON crm_drive_review_event
  WHEN NEW.case_seq <> (SELECT COUNT(*) + 1 FROM crm_drive_review_event e
                        WHERE e.case_ref = NEW.case_ref)
BEGIN
  SELECT RAISE(ABORT, 'review_event_case_seq_broken');
END;

-- (5.6) THE APPROVAL BARRIER: name similarity is never a basis, and a person case is never approved
CREATE TRIGGER IF NOT EXISTS trg_review_event_approve_basis
  BEFORE INSERT ON crm_drive_review_event
  WHEN NEW.event_type = 'approve'
      AND (SELECT COUNT(*) FROM crm_drive_review_case c WHERE c.case_ref = NEW.case_ref) = 1
      AND ( (SELECT c.approve_allowed FROM crm_drive_review_case c
             WHERE c.case_ref = NEW.case_ref) IS NOT 1
         OR (SELECT c.basis FROM crm_drive_review_case c
             WHERE c.case_ref = NEW.case_ref) NOT IN ('vcard_tel','sender_label_phone') )
BEGIN
  SELECT RAISE(ABORT, 'review_approve_requires_phone_backed_basis');
END;

-- (5.7) a correction must point at a real event of the same case
CREATE TRIGGER IF NOT EXISTS trg_review_event_supersedes_target
  BEFORE INSERT ON crm_drive_review_event
  WHEN NEW.supersedes_id IS NOT NULL
      AND (SELECT COUNT(*) FROM crm_drive_review_event p
           WHERE p.id = NEW.supersedes_id AND p.case_ref = NEW.case_ref) <> 1
BEGIN
  SELECT RAISE(ABORT, 'review_supersedes_target_invalid');
END;

-- (5.8) every accepted event advances the head and mirrors it into the immutable anchor ledger
CREATE TRIGGER IF NOT EXISTS trg_review_event_after_insert
  AFTER INSERT ON crm_drive_review_event
BEGIN
  UPDATE crm_drive_review_chain_head
     SET head_sha256 = NEW.event_sha256,
         event_count = NEW.event_seq,
         updated_at = NEW.occurred_at
   WHERE run_key = NEW.run_key;
  INSERT INTO crm_drive_review_chain_anchor
      (run_key, event_seq, head_sha256, event_count, anchor_source, anchored_at)
  VALUES (NEW.run_key, NEW.event_seq, NEW.event_sha256, NEW.event_seq, 'trigger', NEW.occurred_at);
END;

-- (5.9) a seal needs its case; sealing is reflected on the case row for the UI
CREATE TRIGGER IF NOT EXISTS trg_review_seal_case_exists
  BEFORE INSERT ON crm_drive_review_seal
  WHEN (SELECT COUNT(*) FROM crm_drive_review_case c
        WHERE c.case_ref = NEW.case_ref) <> 1
BEGIN
  SELECT RAISE(ABORT, 'review_seal_case_not_found');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_seal_after_insert
  AFTER INSERT ON crm_drive_review_seal
BEGIN
  UPDATE crm_drive_review_case SET seal_state = 'sealed' WHERE case_ref = NEW.case_ref;
END;

CREATE TRIGGER IF NOT EXISTS trg_review_seal_after_delete
  AFTER DELETE ON crm_drive_review_seal
BEGIN
  UPDATE crm_drive_review_case SET seal_state = 'unavailable' WHERE case_ref = OLD.case_ref;
END;

-- ---------------------------------------------------------------------------
-- 6) verification views — pure SQL, usable from CI without recomputing any hash
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS crm_review_chain_integrity AS
SELECT e.run_key AS run_key,
       COUNT(*) AS events,
       MIN(e.event_seq) AS first_seq,
       MAX(e.event_seq) AS last_seq,
       SUM(CASE WHEN p.event_sha256 IS NULL OR e.prev_event_sha256 <> p.event_sha256
                THEN 1 ELSE 0 END) AS broken_links,
       SUM(CASE WHEN a.head_sha256 IS NULL OR a.head_sha256 <> e.event_sha256
                THEN 1 ELSE 0 END) AS anchor_mismatches,
       -- a rewound or deleted head, and a missing anchor row, both show up here without any hashing
       (SELECT h.event_count FROM crm_drive_review_chain_head h
         WHERE h.run_key = e.run_key) AS head_event_count,
       (SELECT COUNT(*) FROM crm_drive_review_chain_anchor a
         WHERE a.run_key = e.run_key AND a.anchor_source = 'trigger') AS anchors
  FROM crm_drive_review_event e
  LEFT JOIN crm_drive_review_event p
         ON p.run_key = e.run_key AND p.event_seq = e.event_seq - 1
  LEFT JOIN crm_drive_review_chain_anchor a
         ON a.run_key = e.run_key AND a.event_seq = e.event_seq
 GROUP BY e.run_key;

CREATE VIEW IF NOT EXISTS crm_review_case_state AS
SELECT c.run_key AS run_key,
       c.case_ref AS case_ref,
       c.case_kind AS case_kind,
       c.basis AS basis,
       c.approve_allowed AS approve_allowed,
       c.seal_state AS seal_state,
       s.current_decision AS current_decision,
       s.decided_at AS decided_at,
       s.decided_by AS decided_by,
       COALESCE(s.events, 0) AS events,
       COALESCE(s.reveals, 0) AS reveals,
       CASE WHEN s.case_ref IS NULL THEN 'open' ELSE 'touched' END AS touched
  FROM crm_drive_review_case c
  LEFT JOIN (
    SELECT e.run_key AS run_key, e.case_ref AS case_ref,
           COUNT(*) AS events,
           SUM(CASE WHEN e.event_type = 'reveal' THEN 1 ELSE 0 END) AS reveals,
           (SELECT d.event_type FROM crm_drive_review_event d
             WHERE d.run_key = e.run_key AND d.case_ref = e.case_ref AND d.decision_state IS NOT NULL
               AND d.event_seq = (SELECT MAX(f.event_seq) FROM crm_drive_review_event f
                                  WHERE f.run_key = e.run_key AND f.case_ref = e.case_ref
                                    AND f.decision_state IS NOT NULL)) AS current_decision,
           (SELECT d.occurred_at FROM crm_drive_review_event d
             WHERE d.run_key = e.run_key AND d.case_ref = e.case_ref AND d.decision_state IS NOT NULL
               AND d.event_seq = (SELECT MAX(f.event_seq) FROM crm_drive_review_event f
                                  WHERE f.run_key = e.run_key AND f.case_ref = e.case_ref
                                    AND f.decision_state IS NOT NULL)) AS decided_at,
           (SELECT d.reviewer FROM crm_drive_review_event d
             WHERE d.run_key = e.run_key AND d.case_ref = e.case_ref AND d.decision_state IS NOT NULL
               AND d.event_seq = (SELECT MAX(f.event_seq) FROM crm_drive_review_event f
                                  WHERE f.run_key = e.run_key AND f.case_ref = e.case_ref
                                    AND f.decision_state IS NOT NULL)) AS decided_by
      FROM crm_drive_review_event e
     GROUP BY e.run_key, e.case_ref
  ) s ON s.run_key = c.run_key AND s.case_ref = c.case_ref;
