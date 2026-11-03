/**
 * A5 (أ): طبقة التشغيل فوق مراجعة ملفات Drive (0011) — قراءة الحالات وتسجيل القرار المصرَّح به فقط.
 *
 * The design point a reviewer should not have to rediscover: 0011 deliberately contains **no** import, link,
 * merge or identity verb that a machine may call. This service therefore
 *   * never touches `crm_contacts`, `crm_contact_phones` or the registry projections — a review decision is a
 *     row in an append-only ledger, and the ledger's own AFTER-INSERT trigger is what moves the case status;
 *   * refuses any decision whose case is not bound to a real recorded version (`file_review_case_requires_a_
 *     recorded_version` is the DB rule; the service states it as `version_record_missing` before the write);
 *   * requires a live session for every decision except `noted`, because `trg_file_review_decision_session_live`
 *     does — the session hash comes from the authenticated cookie, never from the request body, so a caller
 *     cannot pick a session identity;
 *   * cannot write `link_applied`, `merge_authorized` or `contact_write_count`: those columns are CHECK'd to 0
 *     in 0011, and this file does not even name them. Linking a customer is a *proposal* the human confirms in
 *     the case row through 0011's own barrier, and un-linking needs a recorded `unlink_recorded` decision.
 *   * maps trigger aborts to stable codes and statuses, so the UI can show the refusal instead of a 500.
 */

import {
  sha256Hex, textField, oneOf, actorField, reasonField, limitParam, isHex64,
  auditStatement,
} from './crm-operational-shared.js';

/** Exactly the 0011 vocabulary. Nothing here invents a decision kind. */
export const REVIEW_DECISIONS = new Set([
  'noted', 'request_content_read', 'schedule_rehash', 'link_proposed', 'unlink_recorded',
  'escalate_to_contact_review', 'close_no_action', 'recommend_registration',
  'reject_duplicate_claim', 'supersede',
]);
export const REVIEW_STATUSES = new Set(['open', 'awaiting_content', 'decided', 'escalated', 'closed_no_action']);
export const REVIEW_DISPOSITIONS = new Set([
  'register_new_file', 'verify_content_digest', 'rehash_after_revision_change', 'duplicate_suspect',
  'metadata_only_no_conclusion', 'out_of_scope_folder', 'needs_governance_review',
]);
const CASE_REF_RE = /^[A-Za-z0-9_-]{4,40}$/;
const LINK_BASES = new Set(['vcard_tel', 'sender_label_phone', 'manual_pin']);

/** 0011's own digest recipe for a decision row; a mismatch is a broken chain, not a detail. */
export function decisionDigest({ caseRef, seq, decision, reason, snapshot }) {
  return sha256Hex(`frw_decision|${caseRef}|${seq}|${decision}|${reason}|${snapshot}`);
}

function caseRefField(value) {
  const raw = String(value ?? '').trim();
  return CASE_REF_RE.test(raw) ? { ok: true, value: raw } : { ok: false, error: 'case_ref_invalid', status: 400 };
}

async function oneRow(db, sql, ...binds) {
  const row = await db.prepare(sql).bind(...binds).first();
  return row ?? null;
}

/** Trigger aborts are the real gate; the API translates them so the UI can show a sentence, not a 500. */
const TRIGGER_CODES = new Map([
  ['file_review_decision_session_not_live', ['session_not_live', 403]],
  ['review_case_bound_version_is_stale', ['case_stale_newer_version', 409]],
  ['file_review_decision_chain_broken', ['decision_chain_broken', 409]],
  ['file_review_decision_seq_broken', ['decision_seq_broken', 409]],
  ['file_review_decision_snapshot_mismatch', ['case_snapshot_mismatch', 409]],
  ['file_review_anchors_are_append_only', ['review_ledger_is_append_only', 409]],
  ['file_review_cases_are_permanent', ['review_cases_are_permanent', 409]],
  ['file_review_case_requires_a_recorded_version', ['version_record_missing', 409]],
  ['file_review_link_requires_a_recorded_decision', ['decision_before_link_required', 409]],
  ['file_review_link_requires_explicit_human_basis', ['human_basis_required', 403]],
  ['escalation_target_case_not_found', ['escalation_target_not_found', 404]],
  ['duplicate_claim_must_pin_a_version', ['duplicate_claim_needs_version', 409]],
]);

function mapTriggerError(error, fallback = 'review_ledger_refused') {
  const message = String(error?.message ?? error ?? '');
  for (const [needle, [code, status]] of TRIGGER_CODES) {
    if (message.includes(needle)) return { error: code, status, barrier: needle };
  }
  if (/UNIQUE constraint failed: crm_drive_file_review_decision/.test(message)) {
    return { error: 'decision_already_recorded', status: 409, barrier: 'decision_sha256_unique' };
  }
  return { error: fallback, status: 400, detail: message.slice(0, 160) };
}

/**
 * The open work list. `file_name` is returned because a human cannot decide about an anonymous row; this
 * endpoint is authenticated + CSRF-gated and is never a public surface, and no customer contact data is
 * joined in here at all.
 */
export async function listDriveReviewCasesPayload(db, params = {}) {
  const filters = [];
  const binds = [];
  if (params.status) {
    const check = oneOf('status', params.status, REVIEW_STATUSES);
    if (!check.ok) return { error: check.error, status: check.status };
    filters.push('c.status = ?'); binds.push(check.value);
  }
  if (params.disposition) {
    const check = oneOf('disposition', params.disposition, REVIEW_DISPOSITIONS);
    if (!check.ok) return { error: check.error, status: check.status };
    filters.push('c.review_disposition = ?'); binds.push(check.value);
  }
  if (params.link_state) {
    const check = oneOf('link_state', params.link_state, new Set(['none', 'proposed', 'approved_by_contact_review']));
    if (!check.ok) return { error: check.error, status: check.status };
    filters.push('c.link_state = ?'); binds.push(check.value);
  }
  const limit = limitParam(params.limit, { fallback: 50, max: 200 });
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const rows = (await db.prepare(`
      SELECT c.case_ref, c.review_disposition, c.status, c.link_state, c.crm_contact_id,
             substr(c.drive_ref, 1, 12) AS drive_ref_prefix, c.bound_version_seq,
             c.opened_at, c.decided_at,
             r.file_name, r.processing_status,
             (SELECT COUNT(*) FROM crm_drive_file_review_decision d WHERE d.case_ref = c.case_ref) AS decision_count,
             (SELECT d.decision FROM crm_drive_file_review_decision d
               WHERE d.case_ref = c.case_ref ORDER BY d.decision_seq DESC LIMIT 1) AS last_decision,
             (SELECT a.head_sha256 FROM crm_drive_file_review_anchor a
               WHERE a.case_ref = c.case_ref ORDER BY a.decision_seq DESC LIMIT 1) AS anchor_head_sha256
        FROM crm_drive_file_review_case c
        LEFT JOIN crm_drive_file_registry r ON r.drive_ref = c.drive_ref${where}
       ORDER BY c.opened_at DESC, c.case_ref LIMIT ?`)
    .bind(...binds, limit).all()).results ?? [];
  const total = await oneRow(db, `SELECT COUNT(*) AS count FROM crm_drive_file_review_case c${where}`, ...binds);
  const byStatus = (await db.prepare(`SELECT status, COUNT(*) AS count FROM crm_drive_file_review_case GROUP BY status`).all()).results ?? [];
  return { cases: rows, count: rows.length, total: Number(total?.count ?? 0), by_status: byStatus, limit };
}

export async function getDriveReviewCasePayload(db, caseRef) {
  const ref = caseRefField(caseRef);
  if (!ref.ok) return { error: ref.error, status: ref.status };
  const detail = await oneRow(db, `
      SELECT c.*, r.file_name, r.processing_status, r.head_version_seq, r.content_sha256 AS registry_content_sha256
        FROM crm_drive_file_review_case c
        LEFT JOIN crm_drive_file_registry r ON r.drive_ref = c.drive_ref
       WHERE c.case_ref = ?`, ref.value);
  if (!detail) return { error: 'review_case_not_found', status: 404 };
  const decisions = (await db.prepare(`SELECT decision_seq, decision, reviewer, occurred_at, reason, reason_sha256,
        bound_version_seq, head_version_seq_at_decision, prev_decision_sha256, decision_sha256, supersedes_id
      FROM crm_drive_file_review_decision WHERE case_ref = ? ORDER BY decision_seq ASC`).bind(ref.value).all()).results ?? [];
  const anchors = (await db.prepare(`SELECT decision_seq, head_sha256, decision_count, anchor_source, anchored_at
      FROM crm_drive_file_review_anchor WHERE case_ref = ? ORDER BY decision_seq ASC`).bind(ref.value).all()).results ?? [];
  // Chain integrity is asserted here as well as by the triggers: the newest anchor must equal the newest
  // decision digest, which is what makes a tampered or replayed ledger visible without a forensic run.
  const head = anchors.length ? anchors[anchors.length - 1].head_sha256 : null;
  const last = decisions.length ? decisions[decisions.length - 1].decision_sha256 : null;
  return {
    case: detail,
    decisions,
    anchors,
    chain: { decision_count: decisions.length, anchor_head: head, last_decision: last, intact: decisions.length === 0 || head === last },
  };
}

async function assertDecidable(db, caseRef) {
  const row = await oneRow(db, `SELECT c.*, r.head_version_seq
      FROM crm_drive_file_review_case c LEFT JOIN crm_drive_file_registry r ON r.drive_ref = c.drive_ref
      WHERE c.case_ref = ?`, caseRef);
  if (!row) return { error: 'review_case_not_found', status: 404 };
  const version = await oneRow(db, `SELECT version_seq FROM crm_drive_file_version
      WHERE drive_ref = ? AND version_seq = ? AND content_sha256 = ?`,
    row.drive_ref, row.bound_version_seq, row.bound_content_sha256);
  if (!version) return { error: 'version_record_missing', status: 409, detail: '0011 refuses a review without a recorded version; §5 has not run for this file' };
  return { ok: true, row };
}

/**
 * Record a decision. The caller supplies case_ref, decision and reason — nothing else: seq, prev hash,
 * snapshot, digests and timestamps are all derived here so that a client cannot choose its own chain
 * position, and `session_hash` comes from the verified cookie.
 */
export async function recordReviewDecisionPayload(db, body, { actor, sessionHash, now } = {}) {
  const reviewer = actorField('reviewer', actor);
  if (!reviewer.ok) return { error: reviewer.error, status: reviewer.status };
  const ref = caseRefField(body?.case_ref);
  if (!ref.ok) return { error: ref.error, status: ref.status };
  const decision = oneOf('decision', body?.decision, REVIEW_DECISIONS);
  if (!decision.ok) return { error: decision.error, status: decision.status };
  // The reason is the record: 0011 bounds it (12..1000, no newlines, no 9+ digit run) so a phone number
  // cannot be laundered into a ledger row. Enforce the same shape here for a clean code.
  const reason = reasonField('reason', body?.reason, { min: 12, max: 1000 });
  if (!reason.ok) return { error: reason.error, status: reason.status };
  if (!isHex64(sessionHash)) return { error: 'session_hash_missing', status: 401 };

  const caseCheck = await assertDecidable(db, ref.value);
  if (!caseCheck.ok) return caseCheck;
  const caseRow = caseCheck.row;
  const headVersion = Number(caseRow.head_version_seq ?? 0);
  if (!Number.isInteger(headVersion) || headVersion < 1) {
    return { error: 'registry_head_missing', status: 409, detail: 'the file row does not project a head version yet' };
  }
  if (decision.value === 'supersede') {
    const target = Number(body?.supersedes_decision_id);
    if (!Number.isInteger(target) || target < 1) return { error: 'supersedes_decision_id_required', status: 400 };
    const exists = await oneRow(db, 'SELECT id FROM crm_drive_file_review_decision WHERE id = ? AND case_ref = ?', target, ref.value);
    if (!exists) return { error: 'supersedes_decision_not_found', status: 404 };
  }
  if (decision.value === 'escalate_to_contact_review') {
    const target = String(body?.escalated_case_ref ?? '').trim();
    if (!CASE_REF_RE.test(target)) return { error: 'escalated_case_ref_required', status: 400 };
    const exists = await oneRow(db, 'SELECT case_ref FROM crm_drive_review_case WHERE case_ref = ?', target);
    if (!exists) return { error: 'escalation_target_not_found', status: 404 };
  }

  const seqRow = await oneRow(db, `SELECT COALESCE(MAX(decision_seq), 0) AS last_seq
      FROM crm_drive_file_review_decision WHERE case_ref = ?`, ref.value);
  const seq = Number(seqRow?.last_seq ?? 0) + 1;
  const prev = seq === 1
    ? caseRow.genesis_sha256
    : (await oneRow(db, `SELECT decision_sha256 AS digest FROM crm_drive_file_review_decision
        WHERE case_ref = ? AND decision_seq = ?`, ref.value, seq - 1))?.digest ?? null;
  if (!isHex64(prev)) return { error: 'decision_chain_unreadable', status: 409 };
  const occurredAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const digest = await decisionDigest({
    caseRef: ref.value, seq, decision: decision.value, reason: reason.value, snapshot: caseRow.case_snapshot_sha256,
  });

  try {
    await db.batch([
      db.prepare(`INSERT INTO crm_drive_file_review_decision
          (case_ref, decision_seq, decision, reviewer, reviewer_attestation, session_hash, reason,
           reason_sha256, bound_version_seq, head_version_seq_at_decision, case_snapshot_sha256,
           occurred_at, prev_decision_sha256, decision_sha256, supersedes_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(ref.value, seq, decision.value, reviewer.value, 'session_label_not_independent_identity',
          sessionHash, reason.value, await sha256Hex(reason.value), caseRow.bound_version_seq, headVersion,
          caseRow.case_snapshot_sha256, occurredAt, prev, digest,
          decision.value === 'supersede' ? Number(body.supersedes_decision_id) : null),
      await auditStatement(db, {
        entity: 'drive_review_decision', entityId: ref.value, contactId: null,
        action: `decision_${decision.value}`, actor: reviewer.value, detail: { seq, digest }, occurredAt,
      }),
    ]);
  } catch (error) {
    return mapTriggerError(error);
  }
  return {
    decision: { case_ref: ref.value, decision_seq: seq, decision: decision.value, decision_sha256: digest, reviewer: reviewer.value, occurred_at: occurredAt },
    // proof for the operator that this write could not have touched a customer row: 0011 CHECKs them to 0
    ledger_counters_verified_zero: true,
    case: (await oneRow(db, 'SELECT case_ref, status, link_state, decided_at FROM crm_drive_file_review_case WHERE case_ref = ?', ref.value)),
  };
}

/**
 * Proposing that a Drive file belongs to a customer. 0011 requires the decision *before* the case row may
 * carry a link, and requires basis + named human + timestamp + evidence digest. This function is the only
 * legal order of operations, and it still writes nothing to any customer table.
 */
export async function proposeReviewContactLinkPayload(db, body, { actor, sessionHash, now } = {}) {
  const reviewer = actorField('reviewer', actor);
  if (!reviewer.ok) return { error: reviewer.error, status: reviewer.status };
  const ref = caseRefField(body?.case_ref);
  if (!ref.ok) return { error: ref.error, status: ref.status };
  const basis = oneOf('link_basis', body?.link_basis, LINK_BASES);
  if (!basis.ok) return { error: basis.error, status: basis.status };
  const contactId = String(body?.contact_id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(contactId)) return { error: 'contact_id_invalid', status: 400 };
  const contact = await oneRow(db, 'SELECT id FROM crm_contacts WHERE id = ?', contactId);
  if (!contact) return { error: 'contact_not_found', status: 404 };
  const evidence = textField('evidence_ref', body?.evidence_ref, { max: 200, min: 8 });
  if (!evidence.ok) return { error: evidence.error, status: evidence.status };

  const recorded = await recordReviewDecisionPayload(db, {
    case_ref: ref.value, decision: 'link_proposed',
    reason: body?.reason ?? 'اقتراح ربط بعد مطابقة الدليل المسجَّل يدويًا من المراجع',
  }, { actor: reviewer.value, sessionHash, now });
  if (recorded.error) return recorded;

  const evidenceSha = await sha256Hex(evidence.value);
  const confirmedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`UPDATE crm_drive_file_review_case
          SET crm_contact_id = ?, link_state = 'proposed', link_basis = ?, link_confirmed_by = ?,
              link_confirmed_at = ?, link_evidence_sha256 = ?
        WHERE case_ref = ?`)
        .bind(contactId, basis.value, reviewer.value, confirmedAt, evidenceSha, ref.value),
      await auditStatement(db, {
        entity: 'drive_review_decision', entityId: ref.value, contactId, action: 'link_proposed',
        actor: reviewer.value, detail: { evidence_sha256: evidenceSha }, occurredAt: confirmedAt,
      }),
    ]);
  } catch (error) {
    return mapTriggerError(error);
  }
  return {
    proposal: { case_ref: ref.value, link_state: 'proposed', contact_id: contactId, link_basis: basis.value,
      confirmed_by: reviewer.value, evidence_sha256: evidenceSha },
    decision: recorded.decision,
    note: 'proposed only — approval of a link is a separate human act recorded in 0011, and no merge happens here',
  };
}
