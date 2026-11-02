-- 0011_crm_drive_file_intake_review.sql — DRAFT FOR REVIEW. NOT APPLIED ANYWHERE.
-- Phase 2 / T2 blocker 2: a review case for a Drive file that is not linked to any contact.
--
-- STATUS: staged in `_worker/migrations-draft/` like 0010. Promotion requires explicit approval, and
--         the same commit must raise the migration counter in .github/workflows/crm-phase4-analysis.yml.
--
-- THE DEFECT THIS FIXES (measured, not assumed):
-- `crm_drive_review_case` (0009) cannot hold "a file that needs a decision". Its kind-shape CHECK reads
--   CHECK ((case_kind = 'file_to_contact' AND drive_file_id IS NOT NULL AND crm_contact_id IS NOT NULL)
--          OR (case_kind = 'contact_fanout' AND drive_file_id IS NULL AND crm_contact_id IS NOT NULL
--              AND files_count >= 2 AND match_class = 'conflict'))
-- so BOTH kinds require a contact, `case_kind` accepts only those two values, and `run_key` is
-- NOT NULL REFERENCES crm_drive_analysis_run(run_key) — an unregistered file has no analysis run either.
-- Consequence, found in T1: the plan's `register_new -> 0009 review batch` is unrepresentable, so a new
-- file has nowhere to record "a human looked at this and decided to read the bytes".
--
-- WHY A SIBLING TABLE INSTEAD OF RELAXING 0009 (deliberate, and measured before deciding):
-- Relaxing a CHECK means rebuilding the table (SQLite cannot alter a CHECK). A probe on this repo's
-- engine (node:sqlite, SQLite 3.51.3) showed `ALTER TABLE ... RENAME TO` rewrites the bodies of
-- dependent VIEWS to the temporary name: after the rename, `crm_review_case_state`,
-- `crm_review_seal_availability` and `crm_review_ci_summary` followed `..._old` and broke on the DROP.
-- A correct rebuild must therefore drop and recreate 4 views and 19 triggers and carry `sqlite_sequence`
-- forward by hand — on the object set whose whole value is that it cannot be edited, applied by a tool
-- that runs a migration statement-by-statement with no wrapping transaction. The live database holds
-- 0 rows in every 0009 object (measured by the promotion rehearsal, see
-- CRM_PHASE4_REVIEW_TEST_REPORT.md), so a rebuild would buy nothing
-- today and risk the strongest barriers in the project. This file therefore ADDS objects and modifies
-- none: isolation of file review from contact work becomes structural rather than a convention.
--
-- BARRIERS ENCODED HERE:
--   * contact linkage is OPTIONAL and never automatic: `crm_contact_id` may only exist together with a
--     phone-backed or explicitly pinned basis, a named human, a timestamp and an evidence digest — one
--     CHECK, so a half-filled link is not expressible — and the `link_basis` vocabulary contains no
--     name-based option at all ('name_digest', 'similarity', 'guess' do not exist here).
--   * file review may only PROPOSE a link. `approved_by_contact_review` additionally requires an
--     escalation case in 0009 that itself carries an approve decision, so this workflow can never be the
--     thing that authorises touching a contact record.
--   * a case is bound to a version (bound_version_seq + bound_content_sha256) and cannot be decided once
--     the file's head has moved (trg_file_review_case_stale_on_close): a review of bytes that no longer
--     exist cannot be recorded as a review of the file.
--   * the ledger is append-only, dense per case, chained to a genesis digest stored on the case row (as
--     in 0009: genesis is part of the chain, so a healthy ledger reads broken_links = 0 instead of
--     permanently red — a gate that is red on a good database is a gate that gets switched off), mirrored
--     per decision into an immutable anchor table, and any state-changing decision requires a session
--     that is live in crm_sessions at that moment.
--   * the case row is a PROJECTION of the ledger, like 0010's fingerprint columns: link evidence cannot
--     be erased in place, and dropping a link is only possible by recording an unlink decision.
--   * no personal data: no name, phone, path or transcript column exists. A file is named by drive_ref
--     (a one-way hash); a proposed contact is an opaque handle.
--   * HONEST LIMIT: D1 has no SHA-256 in SQL, so genesis/decision digests are supplied by the writer.
--     Density, anchors and the projection guards make deletion, reordering, re-dating and re-binding
--     detectable or impossible; recomputation of `decision_sha256` from the canonical pre-image is the
--     read-only CI job's job (the pattern already exists: scripts/crm/verify-review-event-chain.mjs),
--     and is listed as a required companion, not as something this file provides.
--
-- EFFECT ON EXISTING DATA: none. Three new tables, three new views, no ALTER, no UPDATE, no DROP, no
-- backfill: existing files simply have zero intake cases until a human or the intake pipeline opens one.

-- ---------------------------------------------------------------------------
-- 1) the case index for file-level triage — a contact is optional, never required, never invented
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_file_review_case (
  case_ref      TEXT    NOT NULL PRIMARY KEY,
  -- derived, not invented: the case is exactly (this file, this version). Truncated ref keeps it
  -- printable in CI logs while UNIQUE(drive_ref, bound_version_seq) carries the real key.
  drive_ref     TEXT    NOT NULL CHECK (length(drive_ref) = 64 AND drive_ref NOT GLOB '*[^0-9a-f]*'),
  bound_version_seq INTEGER NOT NULL CHECK (typeof(bound_version_seq) = 'integer'
                                             AND bound_version_seq >= 1),
  bound_content_sha256 TEXT NOT NULL CHECK (length(bound_content_sha256) = 64
                                             AND bound_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- what the file needs. No import, link, merge or identity verb exists in this vocabulary.
  review_disposition TEXT NOT NULL CHECK (review_disposition IN
      ('register_new_file', 'verify_content_digest', 'rehash_after_revision_change',
       'duplicate_suspect', 'metadata_only_no_conclusion', 'out_of_scope_folder',
       'needs_governance_review')),
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'awaiting_content', 'decided', 'escalated',
                                  'closed_no_action')),
  -- an optional, human-asserted pointer. Never populated by a matcher: see the CHECK and the triggers.
  crm_contact_id TEXT   CHECK (crm_contact_id IS NULL
                               OR (length(crm_contact_id) BETWEEN 8 AND 64
                                   AND crm_contact_id NOT GLOB '*[^0-9a-zA-Z_-]*')),
  link_state    TEXT    NOT NULL DEFAULT 'none'
                CHECK (link_state IN ('none', 'proposed', 'approved_by_contact_review')),
  link_basis    TEXT    CHECK (link_basis IS NULL
                               OR link_basis IN ('vcard_tel', 'sender_label_phone', 'manual_pin')),
  link_confirmed_by TEXT CHECK (link_confirmed_by IS NULL
                                OR (length(trim(link_confirmed_by)) BETWEEN 3 AND 120
                                    AND length(link_confirmed_by) = length(trim(link_confirmed_by))
                                    AND lower(link_confirmed_by) NOT IN
                                        ('auto','system','agent','ai','bot','worker','cron','pipeline',
                                         'matcher','algorithm','unknown','none','na','-'))),
  link_confirmed_at TEXT CHECK (link_confirmed_at IS NULL
                                OR (length(link_confirmed_at) BETWEEN 10 AND 32
                                    AND datetime(link_confirmed_at) IS NOT NULL)),
  link_evidence_sha256 TEXT CHECK (link_evidence_sha256 IS NULL
                                   OR (length(link_evidence_sha256) = 64
                                       AND link_evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  -- the ONLY route by which file review can end up next to a contact decision is hand-off, and hand-off
  -- is reviewed by 0009's barriers, not here.
  escalated_case_ref TEXT REFERENCES crm_drive_review_case(case_ref) ON DELETE RESTRICT,
  -- what the reviewer was shown, bound into every decision so a stale review cannot be closed as current
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                                            AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the chain's first link, supplied by the writer and mirrored into the anchor ledger at creation
  genesis_sha256 TEXT    NOT NULL CHECK (length(genesis_sha256) = 64
                                         AND genesis_sha256 NOT GLOB '*[^0-9a-f]*'),
  opened_by     TEXT    NOT NULL CHECK (opened_by IN
                    ('intake_pipeline', 'reconciliation', 'manual_review', 'registry_bootstrap')),
  opened_at     TEXT    NOT NULL CHECK (length(opened_at) BETWEEN 10 AND 32
                                        AND datetime(opened_at) IS NOT NULL),
  decided_at    TEXT    CHECK (decided_at IS NULL OR (length(decided_at) BETWEEN 10 AND 32
                                                      AND datetime(decided_at) IS NOT NULL)),
  -- three nails, as in 0009: this table structurally cannot record an operational write
  import_implied      INTEGER NOT NULL DEFAULT 0 CHECK (import_implied = 0),
  merge_authorized    INTEGER NOT NULL DEFAULT 0 CHECK (merge_authorized = 0),
  contact_write_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_write_count = 0),
  CHECK (case_ref = 'frw-' || substr(drive_ref, 1, 16) || '-' || bound_version_seq),
  -- the shape rule: a link without a basis, a human, a time and pinned evidence does not exist
  CHECK (
    (link_state = 'none' AND crm_contact_id IS NULL AND link_basis IS NULL
     AND link_confirmed_by IS NULL AND link_confirmed_at IS NULL AND link_evidence_sha256 IS NULL)
    OR
    (link_state IN ('proposed', 'approved_by_contact_review') AND crm_contact_id IS NOT NULL
     AND link_basis IS NOT NULL AND link_confirmed_by IS NOT NULL
     AND link_confirmed_at IS NOT NULL AND link_evidence_sha256 IS NOT NULL)
  ),
  CHECK (escalated_case_ref IS NULL OR status = 'escalated'),
  UNIQUE (drive_ref, bound_version_seq)
);
CREATE INDEX IF NOT EXISTS idx_crm_file_review_case_status
  ON crm_drive_file_review_case(status, link_state, case_ref);
CREATE INDEX IF NOT EXISTS idx_crm_file_review_case_ref
  ON crm_drive_file_review_case(drive_ref, bound_version_seq DESC);
CREATE INDEX IF NOT EXISTS idx_crm_file_review_case_contact
  ON crm_drive_file_review_case(crm_contact_id, case_ref) WHERE crm_contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) the decision ledger — append-only, dense, chained
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_drive_file_review_decision (
  id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  case_ref      TEXT    NOT NULL REFERENCES crm_drive_file_review_case(case_ref) ON DELETE RESTRICT,
  decision_seq  INTEGER NOT NULL CHECK (typeof(decision_seq) = 'integer' AND decision_seq >= 1),
  -- decisions a file reviewer can actually make. There is no 'approve_link', no 'import', no 'merge'.
  decision      TEXT    NOT NULL CHECK (decision IN
                    ('noted', 'request_content_read', 'schedule_rehash', 'link_proposed',
                     'unlink_recorded', 'escalate_to_contact_review', 'close_no_action',
                     'recommend_registration', 'reject_duplicate_claim', 'supersede')),
  reviewer      TEXT    NOT NULL CHECK (length(trim(reviewer)) BETWEEN 3 AND 120
                                        AND length(reviewer) = length(trim(reviewer))
                                        AND lower(reviewer) NOT IN
                                            ('auto','system','bot','worker','cron','pipeline','operator',
                                             'matcher','algorithm','unknown','none','na','-')),
  reviewer_attestation TEXT NOT NULL
                CHECK (reviewer_attestation = 'session_label_not_independent_identity'),
  session_hash  TEXT    NOT NULL CHECK (length(session_hash) = 64
                                        AND session_hash NOT GLOB '*[^0-9a-f]*'),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) BETWEEN 12 AND 1000
                                        AND length(reason) = length(trim(reason))
                                        AND reason NOT GLOB '*[' || char(9) || char(10) || char(13) || ']*'
                                        AND reason NOT GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'),
  reason_sha256 TEXT    NOT NULL CHECK (length(reason_sha256) = 64
                                        AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the version the decision was made about, and the head at that moment: staleness is auditable
  bound_version_seq INTEGER NOT NULL CHECK (bound_version_seq >= 1),
  head_version_seq_at_decision INTEGER NOT NULL CHECK (head_version_seq_at_decision >= 0),
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                                            AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  occurred_at   TEXT    NOT NULL CHECK (length(occurred_at) BETWEEN 10 AND 32
                                        AND datetime(occurred_at) IS NOT NULL),
  prev_decision_sha256 TEXT NOT NULL CHECK (length(prev_decision_sha256) = 64
                                            AND prev_decision_sha256 NOT GLOB '*[^0-9a-f]*'),
  decision_sha256 TEXT   NOT NULL UNIQUE CHECK (length(decision_sha256) = 64
                                                AND decision_sha256 NOT GLOB '*[^0-9a-f]*'),
  supersedes_id INTEGER  CHECK (supersedes_id IS NULL
                                OR (typeof(supersedes_id) = 'integer' AND supersedes_id >= 1)),
  link_applied INTEGER NOT NULL DEFAULT 0 CHECK (link_applied = 0),
  merge_authorized INTEGER NOT NULL DEFAULT 0 CHECK (merge_authorized = 0),
  contact_write_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_write_count = 0),
  UNIQUE (case_ref, decision_seq)
);
CREATE INDEX IF NOT EXISTS idx_crm_file_review_decision_case
  ON crm_drive_file_review_decision(case_ref, decision_seq);
CREATE INDEX IF NOT EXISTS idx_crm_file_review_decision_reviewer
  ON crm_drive_file_review_decision(reviewer, occurred_at);

CREATE TABLE IF NOT EXISTS crm_drive_file_review_anchor (
  seq           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  case_ref      TEXT    NOT NULL CHECK (length(case_ref) BETWEEN 4 AND 40),
  decision_seq  INTEGER NOT NULL CHECK (decision_seq >= 0),
  head_sha256   TEXT    NOT NULL CHECK (length(head_sha256) = 64
                                        AND head_sha256 NOT GLOB '*[^0-9a-f]*'),
  decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
  anchor_source TEXT    NOT NULL CHECK (anchor_source IN ('genesis', 'trigger', 'ci_external')),
  anchored_at   TEXT    NOT NULL CHECK (length(anchored_at) BETWEEN 10 AND 32
                                        AND datetime(anchored_at) IS NOT NULL),
  UNIQUE (case_ref, decision_seq, anchor_source)
);

-- ---------------------------------------------------------------------------
-- 3) triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_no_update
  BEFORE UPDATE ON crm_drive_file_review_decision
BEGIN
  SELECT RAISE(ABORT, 'file_review_decisions_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_no_delete
  BEFORE DELETE ON crm_drive_file_review_decision
BEGIN
  SELECT RAISE(ABORT, 'file_review_decisions_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_review_anchor_no_update
  BEFORE UPDATE ON crm_drive_file_review_anchor
BEGIN
  SELECT RAISE(ABORT, 'file_review_anchors_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_review_anchor_no_delete
  BEFORE DELETE ON crm_drive_file_review_anchor
BEGIN
  SELECT RAISE(ABORT, 'file_review_anchors_are_append_only');
END;

-- (3.1) the ledger cannot be opened on a file/version the version ledger does not carry, so a case can
--       never be written against an invented digest, and 'no bytes seen yet' stays distinguishable.
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_version_exists
  BEFORE INSERT ON crm_drive_file_review_case
  WHEN NOT EXISTS (SELECT 1 FROM crm_drive_file_version v
                    WHERE v.drive_ref = NEW.drive_ref
                      AND v.version_seq = NEW.bound_version_seq
                      AND v.content_sha256 = NEW.bound_content_sha256)
BEGIN
  SELECT RAISE(ABORT, 'file_review_case_requires_a_recorded_version');
END;

-- (3.1b) a case is born unlinked. Without this, the link barrier below could be bypassed by creating
--        the row already linked, which is exactly how an "automatic" link would arrive in practice.
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_no_insert_link
  BEFORE INSERT ON crm_drive_file_review_case
  WHEN NEW.crm_contact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'file_review_link_requires_a_recorded_decision');
END;

-- (3.2) a case needs a genesis anchor; the chain is closed from the first decision onward
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_after_insert
  AFTER INSERT ON crm_drive_file_review_case
BEGIN
  INSERT INTO crm_drive_file_review_anchor
      (case_ref, decision_seq, head_sha256, decision_count, anchor_source, anchored_at)
  VALUES (NEW.case_ref, 0, NEW.genesis_sha256, 0, 'genesis', NEW.opened_at);
END;

-- (3.3) a case cannot be deleted while decisions exist (RESTRICT covers that), and cannot be deleted at
--       all once it has been touched by a reviewer
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_no_delete
  BEFORE DELETE ON crm_drive_file_review_case
BEGIN
  SELECT RAISE(ABORT, 'file_review_cases_are_permanent');
END;

-- (3.4) per-case density: a deleted or reordered decision breaks it, with no hashing involved
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_seq_dense
  BEFORE INSERT ON crm_drive_file_review_decision
  WHEN NEW.decision_seq <> (SELECT COUNT(*) + 1 FROM crm_drive_file_review_decision d
                             WHERE d.case_ref = NEW.case_ref)
BEGIN
  SELECT RAISE(ABORT, 'file_review_decision_seq_broken');
END;

-- (3.5) chain continuity, genesis included: seq 1 links to the case's genesis, later rows to their
--       predecessor, and time may not run backwards
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_chain
  BEFORE INSERT ON crm_drive_file_review_decision
  WHEN NEW.prev_decision_sha256 <> (
         SELECT CASE WHEN NEW.decision_seq = 1 THEN c.genesis_sha256
                     ELSE p.decision_sha256 END
           FROM crm_drive_file_review_case c
           LEFT JOIN crm_drive_file_review_decision p
                  ON p.case_ref = NEW.case_ref
                 AND p.decision_seq = NEW.decision_seq - 1
          WHERE c.case_ref = NEW.case_ref)
       OR datetime(NEW.occurred_at) < (SELECT MAX(datetime(d.occurred_at))
                                        FROM crm_drive_file_review_decision d
                                       WHERE d.case_ref = NEW.case_ref)
BEGIN
  SELECT RAISE(ABORT, 'file_review_decision_chain_broken');
END;

-- (3.6) the decision must be about the snapshot the reviewer holds, and about a version that existed
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_snapshot_binding
  BEFORE INSERT ON crm_drive_file_review_decision
  WHEN (SELECT c.case_snapshot_sha256 FROM crm_drive_file_review_case c
         WHERE c.case_ref = NEW.case_ref) IS NOT NEW.case_snapshot_sha256
       OR NEW.bound_version_seq <> (SELECT c.bound_version_seq FROM crm_drive_file_review_case c
                                     WHERE c.case_ref = NEW.case_ref)
BEGIN
  SELECT RAISE(ABORT, 'file_review_decision_snapshot_mismatch');
END;

-- (3.7) a state-changing decision requires a session that is live right now (0009's rule, same shape)
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_session_live
  BEFORE INSERT ON crm_drive_file_review_decision
  WHEN NEW.decision <> 'noted'
       AND NOT EXISTS (SELECT 1 FROM crm_sessions s
                        WHERE s.token_hash = NEW.session_hash
                          AND s.revoked_at IS NULL
                          AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
BEGIN
  SELECT RAISE(ABORT, 'file_review_decision_session_not_live');
END;

-- (3.8) every accepted decision mirrors into the immutable anchor ledger
CREATE TRIGGER IF NOT EXISTS trg_file_review_decision_after_insert
  AFTER INSERT ON crm_drive_file_review_decision
BEGIN
  INSERT INTO crm_drive_file_review_anchor
      (case_ref, decision_seq, head_sha256, decision_count, anchor_source, anchored_at)
  VALUES (NEW.case_ref, NEW.decision_seq, NEW.decision_sha256, NEW.decision_seq, 'trigger',
          NEW.occurred_at);
  UPDATE crm_drive_file_review_case
     SET status = CASE NEW.decision
                    WHEN 'close_no_action' THEN 'closed_no_action'
                    WHEN 'request_content_read' THEN 'awaiting_content'
                    WHEN 'escalate_to_contact_review' THEN 'escalated'
                    WHEN 'unlink_recorded' THEN 'open'
                    ELSE status END,
         decided_at = CASE WHEN NEW.decision IN ('close_no_action','recommend_registration',
                                                 'reject_duplicate_claim')
                           THEN NEW.occurred_at ELSE decided_at END,
         -- dropping a link returns the row to the none-shape the table CHECK demands; the retained
         -- evidence is the append-only decision itself, which is why the ledger is the record.
         link_state = CASE WHEN NEW.decision = 'unlink_recorded' THEN 'none' ELSE link_state END,
         crm_contact_id = CASE WHEN NEW.decision = 'unlink_recorded' THEN NULL ELSE crm_contact_id END,
         link_basis = CASE WHEN NEW.decision = 'unlink_recorded' THEN NULL ELSE link_basis END,
         link_confirmed_by = CASE WHEN NEW.decision = 'unlink_recorded' THEN NULL
                                  ELSE link_confirmed_by END,
         link_confirmed_at = CASE WHEN NEW.decision = 'unlink_recorded' THEN NULL
                                  ELSE link_confirmed_at END,
         link_evidence_sha256 = CASE WHEN NEW.decision = 'unlink_recorded' THEN NULL
                                     ELSE link_evidence_sha256 END
   WHERE case_ref = NEW.case_ref
     AND NEW.decision IN ('close_no_action','request_content_read','escalate_to_contact_review',
                          'unlink_recorded');
END;

-- (3.9) THE LINK BARRIER. A link may only be created or widened by a named human on a phone-backed or
--       manually pinned basis; it may never be dropped except by an unlink decision; and its evidence
--       columns may never be erased in place.
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_link_barrier
  BEFORE UPDATE OF crm_contact_id, link_state, link_basis, link_confirmed_by, link_confirmed_at,
                   link_evidence_sha256 ON crm_drive_file_review_case
  WHEN (NEW.crm_contact_id IS NOT OLD.crm_contact_id
        OR NEW.link_state IS NOT OLD.link_state
        OR NEW.link_basis IS NOT OLD.link_basis
        OR NEW.link_confirmed_by IS NOT OLD.link_confirmed_by
        OR NEW.link_evidence_sha256 IS NOT OLD.link_evidence_sha256)
       AND NOT (
              -- undoing a link is only possible behind a recorded unlink decision (which is how the
              -- ledger's own projection update reaches 'none', and no other caller can)
              (NEW.link_state = 'none' AND NEW.crm_contact_id IS NULL
               AND (SELECT COUNT(*) FROM crm_drive_file_review_decision d
                     WHERE d.case_ref = NEW.case_ref AND d.decision = 'unlink_recorded') >= 1)
              OR
              -- proposing a link: must already be escalated-and-approved when the state says so
              (NEW.link_state = 'proposed'
               AND NEW.crm_contact_id IS NOT NULL AND NEW.link_basis IS NOT NULL
               AND NEW.link_confirmed_by IS NOT NULL AND NEW.link_confirmed_at IS NOT NULL
               AND NEW.link_evidence_sha256 IS NOT NULL
               AND (SELECT COUNT(*) FROM crm_drive_file_review_decision d
                     WHERE d.case_ref = NEW.case_ref AND d.decision = 'link_proposed') >= 1)
              OR
              (NEW.link_state = 'approved_by_contact_review'
               AND NEW.crm_contact_id IS NOT NULL AND NEW.link_basis IS NOT NULL
               AND NEW.link_confirmed_by IS NOT NULL AND NEW.link_confirmed_at IS NOT NULL
               AND NEW.link_evidence_sha256 IS NOT NULL
               AND NEW.escalated_case_ref IS NOT NULL
               AND EXISTS (SELECT 1 FROM crm_drive_review_event e
                            WHERE e.case_ref = NEW.escalated_case_ref AND e.event_type = 'approve'))
            )
BEGIN
  SELECT RAISE(ABORT, 'file_review_link_requires_explicit_human_basis');
END;

-- (3.10) escalation is a hand-off to a real case, never to a name
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_escalation_target
  BEFORE UPDATE OF escalated_case_ref, status ON crm_drive_file_review_case
  WHEN NEW.escalated_case_ref IS NOT OLD.escalated_case_ref
       AND NEW.escalated_case_ref IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM crm_drive_review_case c
                        WHERE c.case_ref = NEW.escalated_case_ref)
BEGIN
  SELECT RAISE(ABORT, 'escalation_target_case_not_found');
END;

-- (3.11) staleness: a case cannot be decided once the file's head version moved past what was reviewed
CREATE TRIGGER IF NOT EXISTS trg_file_review_case_stale_on_close
  BEFORE UPDATE OF status ON crm_drive_file_review_case
  WHEN NEW.status IN ('decided', 'closed_no_action')
       AND (SELECT r.head_version_seq FROM crm_drive_file_registry r
             WHERE r.drive_ref = NEW.drive_ref) IS NOT NEW.bound_version_seq
BEGIN
  SELECT RAISE(ABORT, 'review_case_bound_version_is_stale');
END;

-- ---------------------------------------------------------------------------
-- 4) views — state, tamper evidence, and the isolation proof CI can read
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS crm_drive_file_review_state AS
SELECT c.case_ref AS case_ref,
       c.drive_ref AS drive_ref,
       c.bound_version_seq AS bound_version_seq,
       c.review_disposition AS review_disposition,
       c.status AS status,
       c.link_state AS link_state,
       c.crm_contact_id IS NOT NULL AS has_contact_handle,
       c.escalated_case_ref AS escalated_case_ref,
       COALESCE(dd.decisions, 0) AS decisions,
       ld.decision AS last_decision,
       ld.occurred_at AS last_decided_at,
       ld.reviewer AS last_reviewer,
       r.head_version_seq AS current_head_seq,
       CASE WHEN r.drive_ref IS NULL THEN 'file_not_registered'
            WHEN r.head_version_seq > c.bound_version_seq THEN 'stale_newer_version_exists'
            WHEN r.head_version_seq = c.bound_version_seq THEN 'current'
            ELSE 'head_behind_case' END AS freshness
  FROM crm_drive_file_review_case c
  LEFT JOIN crm_drive_file_registry r ON r.drive_ref = c.drive_ref
  LEFT JOIN (
    SELECT case_ref AS case_ref, COUNT(*) AS decisions, MAX(decision_seq) AS last_seq
      FROM crm_drive_file_review_decision
     GROUP BY case_ref
  ) dd ON dd.case_ref = c.case_ref
  LEFT JOIN crm_drive_file_review_decision ld
    ON ld.case_ref = c.case_ref AND ld.decision_seq = dd.last_seq;

CREATE VIEW IF NOT EXISTS crm_drive_file_review_chain_integrity AS
SELECT e.case_ref AS case_ref,
       COUNT(*) AS decisions,
       MIN(e.decision_seq) AS first_seq,
       MAX(e.decision_seq) AS last_seq,
       MAX(e.decision_seq) - MIN(e.decision_seq) + 1 - COUNT(*) AS seq_gaps,
       SUM(CASE WHEN e.prev_decision_sha256 IS NOT COALESCE(p.decision_sha256, g.head_sha256)
                THEN 1 ELSE 0 END) AS broken_links,
       SUM(CASE WHEN a.head_sha256 IS NULL OR a.head_sha256 <> e.decision_sha256
                THEN 1 ELSE 0 END) AS anchor_mismatches,
       (SELECT COUNT(*) FROM crm_drive_file_review_anchor x
         WHERE x.case_ref = e.case_ref AND x.anchor_source = 'trigger') AS anchors
  FROM crm_drive_file_review_decision e
  LEFT JOIN crm_drive_file_review_decision p
         ON p.case_ref = e.case_ref AND p.decision_seq = e.decision_seq - 1
  LEFT JOIN crm_drive_file_review_anchor g
         ON g.case_ref = e.case_ref AND g.decision_seq = 0 AND g.anchor_source = 'genesis'
  LEFT JOIN crm_drive_file_review_anchor a
         ON a.case_ref = e.case_ref AND a.decision_seq = e.decision_seq
 GROUP BY e.case_ref;

-- the only shape CI may print: counts and digests, never a reviewer label or a contact handle
CREATE VIEW IF NOT EXISTS crm_drive_file_review_ci_summary AS
SELECT c.review_disposition AS review_disposition,
       COUNT(*) AS cases,
       SUM(CASE WHEN COALESCE(i.decisions, 0) = 0 THEN 1 ELSE 0 END) AS untouched,
       SUM(CASE WHEN c.link_state = 'proposed' THEN 1 ELSE 0 END) AS links_proposed,
       SUM(CASE WHEN c.link_state = 'approved_by_contact_review' THEN 1 ELSE 0 END) AS links_approved,
       SUM(CASE WHEN s.freshness = 'stale_newer_version_exists' THEN 1 ELSE 0 END) AS stale_cases,
       SUM(CASE WHEN c.status IN ('decided','closed_no_action') THEN 1 ELSE 0 END) AS decided,
       COALESCE(MAX(i.decisions), 0) AS max_decisions,
       COALESCE(SUM(i.broken_links), 0) AS broken_links,
       COALESCE(SUM(i.seq_gaps), 0) AS seq_gaps,
       COALESCE(SUM(i.anchor_mismatches), 0) AS anchor_mismatches
  FROM crm_drive_file_review_case c
  LEFT JOIN crm_drive_file_review_state s ON s.case_ref = c.case_ref
  LEFT JOIN crm_drive_file_review_chain_integrity i ON i.case_ref = c.case_ref
 GROUP BY c.review_disposition;

-- isolation, in SQL: file review must own no path to contact tables or to operational columns.
-- Anything non-zero here is a design breach, not a cosmetic issue.
CREATE VIEW IF NOT EXISTS crm_drive_file_review_isolation AS
SELECT (SELECT COUNT(*) FROM sqlite_master m
         WHERE m.name IN ('crm_drive_file_review_case','crm_drive_file_review_decision',
                          'crm_drive_file_review_anchor')
           AND (m.sql LIKE '%crm_contacts%' OR m.sql LIKE '%crm_conversations%'
                OR m.sql LIKE '%crm_opportunities%' OR m.sql LIKE '%lead_phones%'
                OR m.sql LIKE '%file_name%' OR m.sql LIKE '%original_file_name%'
                OR m.sql LIKE '%drive_path%' OR m.sql LIKE '%error_message%')) AS forbidden_refs,
       (SELECT COUNT(*) FROM crm_drive_file_review_case
         WHERE import_implied <> 0 OR merge_authorized <> 0 OR contact_write_count <> 0) AS nails_loose,
       (SELECT COUNT(*) FROM crm_drive_file_review_case
         WHERE crm_contact_id IS NOT NULL AND link_state = 'none') AS unexplained_links;
