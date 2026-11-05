#!/usr/bin/env node
/**
 * A5 L2 — result evidence ledger (the ONLY accepted proof of ownership for synthetic rows).
 *
 * THREAT MODEL (established in the design review, do not "simplify" away):
 *   - The CRM API is reachable by ANY authenticated CRM session. `review_note`, `source_ref`,
 *     `actor`/`reviewer`, `conversation_uid` and `idempotency-key` are ALL client-controlled
 *     (`crm-worker.js:1133-1135, 1344-1345, 2445-2448, 969-971`). A normal CRM user can therefore
 *     forge the whole L1 tuple (tag + derived key + FK chain) through plain HTTP.
 *   - `run_tag` and the artifact digest are public (public repo, GITHUB_RUN_ID in URLs/artifact
 *     names). L0 (pre-write intent) is NOT a secret and is NOT used here as an ownership proof.
 *   => Ownership is proven ONLY by a published, hash-chained, run-identified L2 event whose
 *      `row_hash` includes Worker-generated IDs that no API caller can choose.
 *
 * WHAT THIS MODULE DOES
 *   begin      — read-only baseline snapshot + empty pending journal, BEFORE any write.
 *   record     — append one pending event per successfully created row (incremental, fsync'd).
 *   finalize   — resolve pending events with a read-only SELECT; unrecorded rows stop finalization.
 *   preflight  — load prior ledgers, verify chain/identity, re-read every row in the A5 synthetic
 *                scope, verify row_hash / observed_id / parent links; ANY unproven row => STOP.
 *
 * INVARIANTS
 *   - No DELETE / UPDATE / INSERT / REPLACE / PRAGMA ever leaves this module. Only SELECT.
 *   - No COUNT(*) and no display names (`TEST ONLY`) are used for classification or identity.
 *   - No L0/L1 acceptance path: `no-ledger(hard-cancel)` is deliberately NOT implemented.
 *   - Any unproven row is classified `unknown`, never deleted, never reclassified by guessing.
 *   - Only `nasr-crm-test-db` is queried (assertTestOnlyConfig), never nasr-market-db / backup.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { d1Query, assertTestOnlyConfig } from './a5-live-support.mjs';
import { verifyOutboxSync } from './l2-verify-outbox.mjs';

/* ─────────────────────────────── documented LEGACY namespace ───────────────────────────────
 * An absent ledger does NOT mean "no rows". Before L2 existed the A5 verifiers wrote rows under
 * a DIFFERENT, documented namespace: `TEST ONLY A5 ci-*` contact names (CRM_A5_RUN_TAG),
 * the fixed synthetic phones, `ci-e2e-ticket:%` / `post-deploy-synth-*` receipts, and
 * `post_deploy_e2e_synthetic` conversations. Those runs can never produce an L2 artifact.
 *
 * These broad indicators are only STOP-ONLY suspects, not proof of synthetic ownership.
 * They may match real customer data. SQL NULL must never suppress a suspect. No row is
 * modified, and historical markers cannot justify creating new ownership evidence.
 * ─────────────────────────────────────────────────────────────────────────────────────── */
const LEGACY_CONTACT_IDS = `SELECT id FROM crm_contacts
  WHERE name LIKE 'TEST ONLY%'`;
const LEGACY_CONVERSATION_IDS = `SELECT id FROM crm_conversations
  WHERE (source_ref = 'post_deploy_e2e_synthetic' OR chat_title LIKE 'TEST ONLY%')
`;

export const LEGACY_PROBES = Object.freeze([
  { table: 'crm_contacts', label: 'legacy-contact-name',
    where: `name LIKE 'TEST ONLY%'` },
  { table: 'crm_contact_phones', label: 'legacy-known-synthetic-phone',
    where: `phone_key IN ('201000000011','201000000012','201099990077')` },
  { table: 'crm_idempotency_receipts', label: 'legacy-ci-ticket',
    where: `submission_key LIKE 'ci-e2e-ticket:%' OR submission_key LIKE 'post-deploy-synth-%'` },
  { table: 'crm_conversations', label: 'legacy-conversation',
    where: `(source_ref = 'post_deploy_e2e_synthetic' OR chat_title LIKE 'TEST ONLY%')
` },
  { table: 'crm_opportunities', label: 'legacy-opportunity',
    where: `contact_id IN (${LEGACY_CONTACT_IDS}) OR notes LIKE 'TEST ONLY%'` },
  { table: 'crm_customer_requests', label: 'legacy-request',
    where: `contact_id IN (${LEGACY_CONTACT_IDS})` },
  { table: 'crm_request_status_history', label: 'legacy-request-history',
    where: `request_id IN (SELECT id FROM crm_customer_requests WHERE contact_id IN (${LEGACY_CONTACT_IDS}))
  OR actor LIKE 'TEST ONLY A5 %'` },
  { table: 'crm_interactions', label: 'legacy-interaction',
    where: `contact_id IN (${LEGACY_CONTACT_IDS}) OR summary LIKE 'TEST ONLY A5 %'
  OR created_by LIKE 'TEST ONLY A5 %'` },
  { table: 'crm_followups', label: 'legacy-followup',
    where: `contact_id IN (${LEGACY_CONTACT_IDS}) OR created_by LIKE 'TEST ONLY A5 %'` },
  { table: 'crm_operational_audit_log', label: 'legacy-operational-audit',
    where: `actor LIKE 'TEST ONLY A5 %' OR contact_id IN (${LEGACY_CONTACT_IDS})` },
  { table: 'crm_contact_audit_log', label: 'legacy-contact-audit',
    where: `contact_id IN (${LEGACY_CONTACT_IDS}) OR actor LIKE 'TEST ONLY A5 %'` },
  { table: 'crm_conversation_messages', label: 'legacy-message',
    where: `conversation_id IN (${LEGACY_CONVERSATION_IDS})` },
  { table: 'crm_conversation_insights', label: 'legacy-insight',
    where: `conversation_id IN (${LEGACY_CONVERSATION_IDS})` },
  { table: 'crm_drive_file_review_decision', label: 'legacy-review-decision',
    where: `reviewer LIKE 'TEST ONLY A5 %'` },
  { table: 'crm_drive_file_review_case', label: 'legacy-review-case',
    where: `opened_by LIKE 'TEST ONLY A5 %'` },
]);

/** Read-only enumeration of the documented legacy synthetic namespace. STOP-ONLY evidence. */
export function enumerateLegacySuspects(query) {
  const out = [];
  for (const probe of LEGACY_PROBES) {
    let rows;
    try { rows = query(`SELECT * FROM ${probe.table} WHERE ${probe.where}`); }
    catch { throw new Error(`a5-l2-legacy-probe-unreadable:${probe.label}`); }
    if (!Array.isArray(rows)) throw new Error(`a5-l2-legacy-probe-unreadable:${probe.label}`);
    const spec = TABLE_SPECS[probe.table];
    if (!spec) throw new Error(`a5-l2-legacy-probe-unmapped-table:${probe.table}`);
    for (const row of rows) {
      out.push({ table: probe.table, label: probe.label, spec, row,
        a5_key: String(row[spec.uniqueKey] ?? ''), a5_id: String(row[spec.idColumn] ?? '') });
    }
  }
  return out;
}

export const L2_SCHEMA = 'a5-l2-v1';
export const BASELINE_SCHEMA = 'a5-l2-baseline-v1';
export const TAG_PREFIX = 'A5-RUN:';
export const RUN_TAG_RE = /^a5-\d+-\d+-[0-9a-f]{8}$/;
export const LEDGER_ARTIFACT_NAME = 'a5-l2-ledger';

/* ─────────────────────────────── identity & derived keys ─────────────────────────────── */

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Stable serialization: object keys sorted, so the digest does not depend on insertion order. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function a5RunIdentity(env = process.env) {
  const rawRunId = String(env.GITHUB_RUN_ID || '').trim();
  const rawAttempt = String(env.GITHUB_RUN_ATTEMPT || '').trim();
  // Offline/local harnesses have no GitHub run context: use a stable numeric sentinel so the
  // resulting tag still satisfies RUN_TAG_RE, while CI always uses the real run id + attempt.
  const run_id = /^\d+$/.test(rawRunId) ? rawRunId : '0';
  const run_attempt = /^\d+$/.test(rawAttempt) ? rawAttempt : '1';
  const nonce = String(env.A5_L2_NONCE || '').trim() || randomBytes(4).toString('hex');
  if (!/^[0-9a-f]{8}$/.test(nonce)) throw new Error('a5-l2-invalid-run-identity');
  const run_tag = `a5-${run_id}-${run_attempt}-${nonce}`;
  if (run_tag.length > 64) throw new Error('a5-l2-run-tag-too-long');
  return { run_id, run_attempt, run_tag };
}

/** 11 digits in an unassigned E.164 prefix. The caller MUST send `+<phone>` to the Worker. */
export function derivedPhone(run_tag, role) {
  const h = sha256Hex(`${run_tag}|${role}`);
  const d = BigInt(`0x${h.slice(0, 16)}`) % 100000000n;
  return `999${String(d).padStart(8, '0')}`;
}
export const apiPhone = (run_tag, role) => `+${derivedPhone(run_tag, role)}`;
export const tagOf = run_tag => `${TAG_PREFIX}${run_tag}`;
export const submissionKey = (run_tag, suffix) => `${run_tag}:${suffix}`;
export const conversationUid = run_tag => `a5:${run_tag}:conv`;
export const driveSeedTag = run_tag => `A5-${sha256Hex(`seed|${run_tag}`).slice(0, 16)}`;

/* ─────────────────────────────── table coverage ─────────────────────────────── */

const CONTACT_SCOPE = `contact_id IN (SELECT contact_id FROM crm_contact_phones WHERE phone_key LIKE '999%')
  OR contact_id IN (SELECT id FROM crm_contacts WHERE review_note LIKE 'A5-RUN:%')`;
const CONTACT_IDS = `SELECT id FROM crm_contacts WHERE review_note LIKE 'A5-RUN:%'
  OR id IN (SELECT contact_id FROM crm_contact_phones WHERE phone_key LIKE '999%')`;
const SYNTH_CASES = `SELECT case_ref FROM crm_drive_file_review_case WHERE drive_ref IN
  (SELECT drive_ref FROM crm_drive_file_registry WHERE drive_file_id LIKE 'SYNTHLIVE-%')`;
const SYNTH_CONVERSATIONS = `SELECT id FROM crm_conversations WHERE source_ref LIKE 'A5-RUN:%'
  OR conversation_uid LIKE 'a5:%'`;

/**
 * Every table an A5 run may write, with:
 *   uniqueKey    — the schema's UNIQUE/PK key recorded in the ledger (`المفتاح الفريد`).
 *   lookup       — column used to resolve a pending event with a read-only SELECT.
 *   hashColumns  — the columns (and ONLY those) that enter row_hash. These are IMMUTABLE identity
 *                  columns (PK/unique keys, FK parents, content digests, creation timestamps).
 *                  Mutable state (`status`, `match_status`, `expires_at`, `head_version_seq`,
 *                  `review_status`, …) is deliberately EXCLUDED: run B legitimately changes state,
 *                  and hashing it would produce a false `unknown` stop. Ownership is proven by
 *                  the Worker-generated ID + unique key + parent link + this identity digest.
 *   parent       — direct, independently verifiable FK link; child rows are NEVER proven by
 *                  `contact`/`phone` proof alone.
 *   scope        — read-only enumeration predicate for the A5 synthetic namespace.
 */
export const TABLE_SPECS = {
  crm_contacts: {
    idColumn: 'id', uniqueKey: 'id', lookup: 'id',
    hashColumns: ['id'],
    parent: null,
    scope: `review_note LIKE 'A5-RUN:%' OR id IN (SELECT contact_id FROM crm_contact_phones WHERE phone_key LIKE '999%')`,
  },
  crm_contact_phones: {
    idColumn: 'id', uniqueKey: 'phone_key', lookup: 'phone_key',
    hashColumns: ['id', 'contact_id', 'phone_key'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: `phone_key LIKE '999%' OR ${CONTACT_SCOPE}`,
  },
  crm_idempotency_receipts: {
    idColumn: 'submission_key', uniqueKey: 'submission_key', lookup: 'submission_key',
    hashColumns: ['submission_key', 'resource_type', 'resource_id'],
    parent: { table: 'crm_contacts', column: 'resource_id' },
    scope: `submission_key LIKE 'a5-%' OR resource_id IN (${CONTACT_IDS})`,
  },
  crm_opportunities: {
    idColumn: 'id', uniqueKey: 'id', lookup: 'id',
    hashColumns: ['id', 'contact_id', 'created_at'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: `contact_id IN (${CONTACT_IDS}) OR notes LIKE 'TEST ONLY%'`,
  },
  crm_customer_requests: {
    idColumn: 'id', uniqueKey: 'dedupe_key', lookup: 'id',
    hashColumns: ['id', 'contact_id', 'dedupe_key', 'kind', 'property_type', 'source', 'created_at'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: CONTACT_SCOPE,
  },
  crm_request_status_history: {
    idColumn: 'seq', uniqueKey: 'seq', lookup: 'seq',
    hashColumns: ['seq', 'request_id', 'from_status', 'to_status', 'actor', 'changed_at'],
    parent: { table: 'crm_customer_requests', column: 'request_id' },
    scope: `request_id IN (SELECT id FROM crm_customer_requests WHERE ${CONTACT_SCOPE})`,
  },
  crm_interactions: {
    idColumn: 'id', uniqueKey: 'dedupe_key', lookup: 'id',
    hashColumns: ['id', 'contact_id', 'request_id', 'dedupe_key', 'kind', 'created_by', 'occurred_at'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: CONTACT_SCOPE,
  },
  crm_followups: {
    idColumn: 'id', uniqueKey: 'dedupe_key', lookup: 'id',
    hashColumns: ['id', 'contact_id', 'request_id', 'dedupe_key', 'created_by'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: CONTACT_SCOPE,
  },
  crm_operational_audit_log: {
    idColumn: 'seq', uniqueKey: 'seq', lookup: 'seq',
    hashColumns: ['seq', 'entity', 'entity_id', 'contact_id', 'action', 'actor', 'detail_sha256', 'occurred_at'],
    parent: null,
    scope: `actor LIKE 'A5-RUN:%' OR contact_id IN (${CONTACT_IDS})`,
  },
  crm_contact_audit_log: {
    idColumn: 'id', uniqueKey: 'id', lookup: 'id',
    hashColumns: ['id', 'contact_id', 'action_type', 'field_name', 'source_ref', 'actor', 'created_at'],
    parent: { table: 'crm_contacts', column: 'contact_id' },
    scope: `contact_id IN (${CONTACT_IDS}) OR source_ref LIKE 'A5-RUN:%'`,
  },
  crm_conversations: {
    idColumn: 'id', uniqueKey: 'conversation_uid', lookup: 'conversation_uid',
    hashColumns: ['id', 'conversation_uid', 'source_type', 'source_ref', 'raw_sha256'],
    parent: null,
    scope: `source_ref LIKE 'A5-RUN:%' OR conversation_uid LIKE 'a5:%' OR contact_id IN (${CONTACT_IDS})`,
  },
  crm_conversation_messages: {
    idColumn: 'id', uniqueKey: 'message_uid', lookup: 'message_uid',
    hashColumns: ['id', 'conversation_id', 'message_uid', 'seq_no', 'sender_role', 'sent_at'],
    parent: { table: 'crm_conversations', column: 'conversation_id' },
    scope: `conversation_id IN (${SYNTH_CONVERSATIONS})`,
  },
  crm_conversation_insights: {
    idColumn: 'id', uniqueKey: 'conversation_id', lookup: 'conversation_id',
    hashColumns: ['id', 'conversation_id'],
    parent: { table: 'crm_conversations', column: 'conversation_id' },
    scope: `conversation_id IN (${SYNTH_CONVERSATIONS})`,
  },
  crm_sessions: {
    idColumn: 'id', uniqueKey: 'token_hash', lookup: 'csrf_hash',
    hashColumns: ['id', 'token_hash', 'created_at'],
    parent: null,
    scope: `token_hash IN (SELECT session_hash FROM crm_drive_file_review_decision WHERE reviewer LIKE 'A5-RUN:%')`,
  },
  crm_drive_file_registry: {
    idColumn: 'id', uniqueKey: 'drive_ref', lookup: 'drive_ref',
    hashColumns: ['id', 'drive_file_id', 'drive_ref', 'content_sha256', 'created_at'],
    parent: null,
    scope: `drive_file_id LIKE 'SYNTHLIVE-%' OR review_notes LIKE 'A5-RUN:%' OR processing_receipt_ref LIKE 'A5-RUN:%'`,
  },
  crm_drive_file_version: {
    idColumn: 'version_ref', uniqueKey: 'version_ref', lookup: 'version_ref',
    hashColumns: ['version_ref', 'drive_ref', 'version_seq', 'content_sha256', 'evidence_class', 'size_bytes', 'observed_by', 'receipt_ref', 'observed_at'],
    parent: null,
    scope: `receipt_ref LIKE 'A5-RUN:%' OR drive_ref IN (SELECT drive_ref FROM crm_drive_file_registry WHERE drive_file_id LIKE 'SYNTHLIVE-%')`,
  },
  crm_drive_file_review_case: {
    idColumn: 'case_ref', uniqueKey: 'case_ref', lookup: 'case_ref',
    hashColumns: ['case_ref', 'drive_ref', 'bound_version_seq', 'bound_content_sha256', 'case_snapshot_sha256', 'genesis_sha256', 'opened_by', 'opened_at'],
    parent: null,
    scope: `drive_ref IN (SELECT drive_ref FROM crm_drive_file_registry WHERE drive_file_id LIKE 'SYNTHLIVE-%')`,
  },
  crm_drive_file_review_decision: {
    idColumn: 'id', uniqueKey: 'decision_sha256', lookup: 'decision_sha256',
    hashColumns: ['id', 'case_ref', 'decision_seq', 'decision', 'reviewer', 'reason_sha256', 'case_snapshot_sha256', 'session_hash', 'occurred_at', 'prev_decision_sha256', 'decision_sha256'],
    parent: { table: 'crm_drive_file_review_case', column: 'case_ref' },
    scope: `case_ref IN (${SYNTH_CASES}) OR reviewer LIKE 'A5-RUN:%'`,
  },
  crm_drive_file_review_anchor: {
    idColumn: 'seq', uniqueKey: 'seq', lookup: 'seq',
    hashColumns: ['seq', 'case_ref', 'decision_seq', 'anchor_source', 'anchored_at'],
    parent: null, // 0011 declares NO FK on case_ref; the link is case_ref ∈ proven case keys
    scope: `case_ref IN (${SYNTH_CASES})`,
  },
};

/* ─────────────────────────────── read-only query layer ─────────────────────────────── */

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|TRIGGER)\b/i;

/** Hard barrier: nothing but a single SELECT may ever be issued through the L2 query layer. */
export function assertReadOnlySql(sql) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(text) || text.includes(';') || FORBIDDEN_SQL.test(text)) {
    throw new Error(`a5-l2-non-readonly-sql:${String(sql).slice(0, 80)}`);
  }
  return text;
}

export function readonlyQuery(sql, env = process.env) {
  assertTestOnlyConfig(env);
  assertReadOnlySql(sql);
  const out = d1Query(sql, env);
  if (!Array.isArray(out)) throw new Error('a5-l2-query-shape');
  return out;
}

const selectColumns = spec => [...new Set([
  spec.idColumn, spec.uniqueKey, spec.lookup,
  ...spec.hashColumns,
  ...(spec.parent ? [spec.parent.column] : []),
])].join(',');

export function rowFor(table, key, query, lookupColumn) {
  const spec = TABLE_SPECS[table];
  if (!spec) throw new Error(`a5-l2-unknown-table:${table}`);
  const column = String(lookupColumn || spec.lookup);
  if (!/^[a-z_]+$/i.test(column)) throw new Error('a5-l2-bad-lookup-column');
  const sql = `SELECT ${selectColumns(spec)} FROM ${table} WHERE ${column} = ? LIMIT 2`
    .replace(/\?/, `'${String(key).replace(/'/g, "''")}'`);
  const rows = query(sql);
  if (rows.length !== 1) throw new Error(`a5-l2-row-not-unique:${table}:${rows.length}`);
  return rows[0];
}

/** Enumerate the A5 synthetic namespace, one read-only SELECT per table. No COUNT, no names. */
export function enumerateRows(query) {
  const out = [];
  for (const [table, spec] of Object.entries(TABLE_SPECS)) {
    const sql = `SELECT ${selectColumns(spec)} FROM ${table} WHERE ${spec.scope}`;
    for (const row of query(sql)) {
      out.push({ table, spec, row, a5_key: String(row[spec.uniqueKey] ?? ''), a5_id: String(row[spec.idColumn] ?? '') });
    }
  }
  return out;
}

/* ─────────────────────────────── ledger core ─────────────────────────────── */

/** Column values are stored as SHA-256 digests, never as raw text: no PII in Git or CI reports. */
export function rowColumnsSha256(spec, row) {
  const out = {};
  for (const col of spec.hashColumns) {
    if (!(col in row)) throw new Error(`a5-l2-missing-hash-column:${col}`);
    out[col] = row[col] === null || row[col] === undefined ? null : sha256Hex(row[col]);
  }
  return out;
}

export const rowHash = (spec, row) => sha256Hex(canonical(rowColumnsSha256(spec, row)));

export function createLedger(identity, baseline) {
  return {
    schema: L2_SCHEMA,
    run_id: identity.run_id,
    run_attempt: identity.run_attempt,
    run_tag: identity.run_tag,
    conclusion: 'running',
    stopped_at: '',
    baseline,
    events: [],
  };
}

const genesisHash = run_tag => sha256Hex(`a5-l2-genesis|${run_tag}`);

export function appendEvent(ledger, partial) {
  const spec = TABLE_SPECS[partial.table];
  if (!spec) throw new Error(`a5-l2-unknown-table:${partial.table}`);
  const prev = ledger.events.length ? ledger.events[ledger.events.length - 1].event_sha256 : genesisHash(ledger.run_tag);
  const event = {
    seq: ledger.events.length + 1,
    table: partial.table,
    unique_key: partial.unique_key,
    observed_id: String(partial.observed_id),
    id_source: partial.id_source,
    row_columns_sha256: partial.row_columns_sha256,
    row_hash: partial.row_hash,
    parent: partial.parent || null,
    step: partial.step || '',
    run_id: ledger.run_id,
    run_attempt: ledger.run_attempt,
    run_tag: ledger.run_tag,
    prev_event_sha256: prev,
  };
  event.event_sha256 = sha256Hex(canonical(event));
  ledger.events.push(event);
  return event;
}

export function ledgerDigest(ledger) {
  const { ledger_sha256, ...rest } = ledger;
  return sha256Hex(canonical(rest));
}

export function finalizeLedger(ledger, conclusion, stopped_at = '') {
  // `running` is a CHECKPOINT: the events in it are already resolved (row_hash included), so a
  // hard-cancelled run still leaves real proof for the steps it completed. It is not a fallback
  // for a row with NO event — that remains `unknown` and stops the next run.
  if (!['running', 'success', 'failure', 'cancelled'].includes(conclusion)) throw new Error('a5-l2-bad-conclusion');
  ledger.conclusion = conclusion;
  ledger.stopped_at = String(stopped_at || '');
  ledger.ledger_sha256 = ledgerDigest(ledger);
  return ledger;
}

/** Verify chain continuity, per-event hash, run identity and the enclosing digest. */
export function verifyLedgerIntegrity(ledger) {
  if (ledger?.schema !== L2_SCHEMA) return 'schema';
  if (!RUN_TAG_RE.test(String(ledger.run_tag))) return 'run-tag-shape';
  const expected = `a5-${ledger.run_id}-${ledger.run_attempt}-`;
  if (!String(ledger.run_tag).startsWith(expected)) return 'run-identity-mismatch';
  if (!['running', 'success', 'failure', 'cancelled'].includes(ledger.conclusion)) return 'conclusion';
  if (ledgerDigest(ledger) !== ledger.ledger_sha256) return 'ledger-digest';
  let prev = genesisHash(ledger.run_tag);
  for (let i = 0; i < (ledger.events || []).length; i += 1) {
    const e = ledger.events[i];
    const { event_sha256, ...rest } = e;
    if (e.seq !== i + 1 || sha256Hex(canonical(rest)) !== event_sha256) return `event-hash:${i + 1}`;
    if (e.prev_event_sha256 !== prev) return `chain:${i + 1}`;
    if (e.run_tag !== ledger.run_tag || e.run_id !== ledger.run_id || e.run_attempt !== ledger.run_attempt) return `event-identity:${i + 1}`;
    prev = event_sha256;
  }
  return 'ok';
}

/* ─────────────────────────────── pending journal (incremental) ─────────────────────────────── */

/**
 * Append one event per successfully created row. fsync after each append so a crash after step N
 * still leaves N durable pending events. A missing A5_L2_PENDING is a no-op (local contract tests).
 */
export function appendPendingEvent(path, event) {
  if (!path) return false;
  const spec = TABLE_SPECS[event.table];
  if (!spec) throw new Error(`a5-l2-unknown-table:${event.table}`);
  if (!event.lookup_value) throw new Error('a5-l2-pending-missing-lookup-value');
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({
      table: event.table,
      lookup_column: event.lookup_column || spec.lookup,
      lookup_value: String(event.lookup_value),
      observed_id: event.observed_id ? String(event.observed_id) : '',
      id_source: event.id_source || 'http-response',
      step: event.step || '',
      run_id: event.run_id || '',
      run_attempt: event.run_attempt || '',
      run_tag: event.run_tag || '',
      parent: event.parent || null,
    })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return true;
}

export function readPendingEvents(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw new Error('a5-l2-pending-corrupt'); }
  });
}

/* ─────────────────────────────── finalize / verification ─────────────────────────────── */

/**
 * Build the parent link for a row. The parent MUST already have its OWN L2 event: a child row is
 * never proven by a contact/phone proof alone. Both the parent's unique key and its PK are tried.
 */
function resolveParent(spec, row, eventByKey) {
  if (!spec.parent) return null;
  const parentSpec = TABLE_SPECS[spec.parent.table];
  if (!parentSpec) throw new Error('a5-l2-unknown-parent-table');
  const parentId = String(row[spec.parent.column] ?? '');
  if (!parentId) return null; // nullable FK (e.g. conversation.contact_id before linking)
  const parentEvent = eventByKey.get(`${spec.parent.table}|${parentId}`)
    || eventByKey.get(`${spec.parent.table}|observed:${parentId}`);
  if (!parentEvent) throw new Error(`a5-l2-unresolvable-parent:${spec.parent.table}:${parentId}`);
  return { table: spec.parent.table, key: parentEvent.unique_key, observed_id: parentEvent.observed_id };
}

/** Resolve a pending event to a real DB row, using ONLY a read-only keyed SELECT. */
function resolveEvent(ledger, pending, query, eventByKey) {
  const spec = TABLE_SPECS[pending.table];
  const row = rowFor(pending.table, pending.lookup_value, query, pending.lookup_column);
  const observed = String(row[spec.idColumn] ?? '');
  if (pending.observed_id && pending.observed_id !== observed) {
    throw new Error(`a5-l2-observed-id-mismatch:${pending.table}`);
  }
  // The pending hint declares WHICH column is the FK; the VALUE is read back from the DB, and the
  // parent identity is taken from the parent's L2 event — never from a client-supplied guess.
  const parent = pending.parent?.column ? resolveParent(spec, row, eventByKey) : null;
  return appendEvent(ledger, {
    table: pending.table,
    unique_key: String(row[spec.uniqueKey] ?? ''),
    observed_id: observed,
    id_source: pending.id_source,
    row_columns_sha256: rowColumnsSha256(spec, row),
    row_hash: rowHash(spec, row),
    parent,
    step: pending.step,
  });
}

/**
 * Finalize: explicit pending events first (incremental evidence), then derived events for FK
 * side-effect rows discovered by read-back. Nothing is written to the DB by this function.
 */
export function buildLedger({ identity, baseline, pending, query, priorLedgers = [],
  conclusion = 'success', stopped_at = '' }) {
  const ledger = createLedger(identity, baseline);
  const eventByKey = new Map();
  const index = event => {
    eventByKey.set(`${event.table}|${event.unique_key}`, event);
    eventByKey.set(`${event.table}|observed:${event.observed_id}`, event);
  };
  // Rows already proven by a previous run keep THEIR OWN run identity. This run must not
  // re-attest them: the previous ledger is the proof, and preflight re-verifies its row_hash.
  const alreadyProven = new Set();
  if (priorLedgers.length) {
    const priorCheck = classifyRows({ query, ledgers: priorLedgers.map(p => ({ error: 'ok', ledger: p.ledger || p })), currentRunTag: identity.run_tag });
    // A current run may already have created new rows. Verify the exact prior claims below,
    // but do not use priorCheck.ok (which also rejects those newly created rows).
    const badPrior = priorCheck.verdicts.find(v => v.verdict.startsWith('unknown') &&
      priorLedgers.some(p => (p.ledger || p).events.some(e => e.table === v.table && e.unique_key === v.a5_key)));
    if (badPrior || priorCheck.reason.startsWith('l2-row-vanished')) throw new Error('a5-l2-untrusted-prior-row');
  }
  for (const prior of priorLedgers) {
    if (verifyLedgerIntegrity(prior.ledger || prior) !== 'ok') throw new Error('a5-l2-untrusted-prior-ledger');
    const l = prior.ledger || prior;
    for (const e of l.events) {
      if (!(l.baseline?.ids?.[e.table] || []).includes(e.unique_key)
          && e.id_source !== 'read-back' && e.step !== 'derived-read-back') {
        alreadyProven.add(`${e.table}|${e.unique_key}`);
      }
    }
  }
  const baselineKeys = new Set();
  for (const [table, keys] of Object.entries(baseline?.ids || {})) {
    for (const key of keys) baselineKeys.add(`${table}|${key}`);
  }
  for (const p of pending) {
    const spec = TABLE_SPECS[p.table];
    const row = rowFor(p.table, p.lookup_value, query, p.lookup_column);
    const key = String(row[spec.uniqueKey] ?? '');
    if (baselineKeys.has(`${p.table}|${key}`) || alreadyProven.has(`${p.table}|${key}`)) {
      throw new Error(`a5-l2-unproven-preexisting-row:${p.table}`);
    }
    index(resolveEvent(ledger, p, query, eventByKey));
  }
  for (const entry of enumerateRows(query)) {
    if (eventByKey.has(`${entry.table}|${entry.a5_key}`) || alreadyProven.has(`${entry.table}|${entry.a5_key}`)) continue;
    throw new Error(`a5-l2-${baselineKeys.has(`${entry.table}|${entry.a5_key}`) ? 'unproven-preexisting-row' : 'unproven-row'}:${entry.table}`);
  }
  // Publishing ANY ledger while a legacy row is unproven would implicitly declare the namespace
  // clean. Refuse (fail-closed). The CLI then publishes `failure-evidence` instead: a genuine,
  // hash-chained ledger with ZERO ownership claims — so the run is not a "completed run with no
  // evidence", while nothing is retroactively proven or laundered.
  for (const s of enumerateLegacySuspects(query)) {
    if (!eventByKey.has(`${s.table}|${s.a5_key}`) && !eventByKey.has(`${s.table}|observed:${s.a5_id}`) && !alreadyProven.has(`${s.table}|${s.a5_key}`)) {
      throw new Error(`a5-l2-unproven-legacy-row:${s.table}:${s.label}`);
    }
  }
  return finalizeLedger(ledger, conclusion, stopped_at);
}

/**
 * Hard gate: NO ledger (checkpoint or final) may be published unless THIS run's read-only
 * ownership preflight cleared. Without this, an `if: always()` finalize after a failed preflight
 * could launder `unknown` rows into `previous-a5-proven` for the next run.
 */
export function preflightCleared(dir, runTag) {
  const file = join(dir, 'preflight.json');
  if (!existsSync(file)) return 'a5-l2-preflight-missing';
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return 'a5-l2-preflight-unparsable'; }
  if (parsed.ok !== true) return `a5-l2-preflight-not-cleared:${String(parsed.reason || '').slice(0, 60)}`;
  if (parsed.run_tag !== runTag) return 'a5-l2-preflight-run-tag-mismatch';
  return 'ok';
}

export function loadLedgers(dir, currentRunTag = '') {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'baseline.json' && n !== 'identity.json').sort()) {
    let ledger;
    try { ledger = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
    catch { out.push({ name, error: 'unparsable', ledger: null }); continue; }
    const check = verifyLedgerIntegrity(ledger);
    if (check !== 'ok') { out.push({ name, error: check, ledger }); continue; }
    if (ledger.run_tag === currentRunTag) { out.push({ name, error: 'current-run-ledger', ledger }); continue; }
    out.push({ name, error: 'ok', ledger });
  }
  return out;
}

/**
 * Preflight for run B. Returns { ok, reason, verdicts }.
 * L0 and L1 are NEVER consulted: a matching tag or a derived key proves nothing here.
 */
export function classifyRows({ query, ledgers, currentRunTag }) {
  // Artifacts, baselines and read-back are not ownership proof. Read the outbox before
  // classifying rows, and fail closed if it is unavailable or its result has an invalid shape.
  let outbox = [];
  let outboxReadable = false;
  try {
    outbox = query('SELECT run_id,table_name,row_id,result,event_seq,entry_hash FROM l2_outbox');
    outboxReadable = Array.isArray(outbox) && outbox.every(e => e && typeof e.run_id === 'string' &&
      typeof e.table_name === 'string' && typeof e.row_id === 'string' && typeof e.result === 'string');
  } catch { /* no live access, missing schema, or unreadable outbox is never clean */ }
  const loaded = ledgers.filter(x => x.error === 'ok');
  const bad = ledgers.find(x => x.error !== 'ok');
  if (bad) return { ok: false, reason: `untrusted-result-ledger:${bad.error}`,
    verdicts: [], legacy_suspects: 0 };

  const eventByKey = new Map();
  for (const { ledger } of loaded) {
    for (const e of ledger.events) {
      // Old read-back and baseline claims were not contemporaneous ownership evidence.
      const preexisting = (ledger.baseline?.ids?.[e.table] || []).includes(e.unique_key);
      if (!preexisting && e.id_source !== 'read-back' && e.step !== 'derived-read-back') {
        eventByKey.set(`${e.table}|${e.unique_key}`, e);
      }
    }
  }

  const verificationByRun = new Map();
  // LIMITATION: This verifier proves row↔outbox binding and chain integrity.
  // It does NOT prove temporal contemporaneity. A future migration must add
  // created_at NOT NULL and an INSERT-time trigger to close this gap before A5.
  const outboxVerdict = (entry, ev) => {
    if (!outboxReadable) return 'unknown:outbox-verification-failed';
    const matches = outbox.filter(x => x.table_name === entry.table && x.row_id === entry.a5_id &&
      x.run_id === ev.run_tag && x.result === 'proven');
    if (!matches.length) return 'unknown:outbox-evidence-required';
    if (matches.length !== 1) return 'unknown:outbox-verification-failed';
    if (!verificationByRun.has(ev.run_tag)) {
      // The L2 query adapter accepts SQL only; escape literal parameters and preserve the
      // existing read-only boundary. Identifiers come from the verifier's table allowlist.
      const boundQuery = (sql, params) => {
        let i = 0;
        const bound = sql.replace(/\?/g, () => {
          if (i >= params.length) throw new Error('a5-l2-outbox-parameter-count');
          return `'${String(params[i++]).replace(/'/g, "''")}'`;
        });
        if (i !== params.length) throw new Error('a5-l2-outbox-parameter-count');
        assertReadOnlySql(bound);
        return query(bound);
      };
      verificationByRun.set(ev.run_tag, verifyOutboxSync({ query: boundQuery, runId: ev.run_tag }));
    }
    const checked = verificationByRun.get(ev.run_tag);
    if (!checked.ok || !checked.proven.some(x => x.table === entry.table && x.row_id === entry.a5_id &&
        x.run_id === ev.run_tag && x.event_seq === matches[0].event_seq && x.entry_hash === matches[0].entry_hash)) {
      return 'unknown:outbox-verification-failed';
    }
    return 'previous-a5-proven';
  };

  const rows = enumerateRows(query);
  const verdicts = [];
  for (const entry of rows) {
    const { table, spec, row, a5_key, a5_id } = entry;
    const ev = eventByKey.get(`${table}|${a5_key}`);
    let verdict;
    if (!ev) {
      verdict = outboxReadable ? 'unknown:outbox-evidence-required' : 'unknown';
    } else if (ev.run_tag === currentRunTag) {
      verdict = 'current-run';
    } else {
      const freshHash = rowHash(spec, row);
      const freshCols = canonical(rowColumnsSha256(spec, row));
      let reason = '';
      if (ev.observed_id !== a5_id) reason = 'observed-id-mismatch';
      else if (ev.row_hash !== freshHash) reason = 'row-hash-mismatch';
      else if (canonical(ev.row_columns_sha256) !== freshCols) reason = 'row-columns-mismatch';
      else if (ev.parent) {
        const parentEv = eventByKey.get(`${ev.parent.table}|${ev.parent.key}`);
        const parentColumn = spec.parent?.column;
        if (!parentEv) reason = 'parent-event-missing';
        else if (!parentColumn || String(row[parentColumn] ?? '') !== ev.parent.observed_id) reason = 'parent-link-mismatch';
      }
      verdict = reason ? `unknown:${reason}` : outboxVerdict(entry, ev);
    }
    verdicts.push({ table, a5_key, a5_id, verdict });
  }

  // LEGACY namespace: an ineligible (pre-L2) run's rows are inspected here row-by-row. These rows
  // were NEVER in a baseline and can NEVER receive retroactive evidence, so a missing L2 event is
  // `unknown` => STOP. `baseline-origin` is deliberately NOT an option for a legacy suspect:
  // absence of a ledger artifact is not proof that no row was written.
  const legacySuspects = enumerateLegacySuspects(query);
  let legacyStop = '';
  for (const s of legacySuspects) {
    const ev = eventByKey.get(`${s.table}|${s.a5_key}`);
    let verdict;
    if (!ev) {
      verdict = outboxReadable ? 'unknown:outbox-evidence-required' : 'unknown:legacy-unproven';
    } else if (ev.run_tag === currentRunTag) {
      verdict = 'current-run';
    } else {
      const freshHash = rowHash(s.spec, s.row);
      const freshCols = canonical(rowColumnsSha256(s.spec, s.row));
      let reason = '';
      if (ev.observed_id !== s.a5_id) reason = 'observed-id-mismatch';
      else if (ev.row_hash !== freshHash) reason = 'row-hash-mismatch';
      else if (canonical(ev.row_columns_sha256) !== freshCols) reason = 'row-columns-mismatch';
      else if (ev.parent) {
        const parentEv = eventByKey.get(`${ev.parent.table}|${ev.parent.key}`);
        const parentColumn = s.spec.parent?.column;
        if (!parentEv) reason = 'parent-event-missing';
        else if (!parentColumn || String(s.row[parentColumn] ?? '') !== ev.parent.observed_id) reason = 'parent-link-mismatch';
      }
      verdict = reason ? `unknown:legacy-${reason}` : outboxVerdict(s, ev);
    }
    verdicts.push({ table: s.table, a5_key: s.a5_key, a5_id: s.a5_id, verdict });
    if ((verdict.startsWith('unknown') || verdict === 'current-run') && !legacyStop) {
      legacyStop = `unknown-ownership:${s.table}:${verdict}:${s.label}`;
    }
  }

  // EVERY published event (success, partial failure, checkpoint or cancellation) must still
  // describe a row that exists. A vanished row is a deletion we never perform and must stop B.
  for (const { ledger } of loaded) {
    for (const e of ledger.events) {
      if (!rows.some(r => r.table === e.table && r.a5_key === e.unique_key)) {
        return { ok: false, reason: `l2-row-vanished:${e.table}`, verdicts,
          legacy_suspects: legacySuspects.length };
      }
    }
  }

  if (legacyStop) {
    return { ok: false, reason: legacyStop, verdicts, legacy_suspects: legacySuspects.length };
  }
  const unknowns = verdicts.filter(v => v.verdict.startsWith('unknown') || v.verdict === 'current-run');
  if (unknowns.length) {
    return { ok: false, reason: `unknown-ownership:${unknowns[0].table}:${unknowns[0].verdict}`,
      verdicts, legacy_suspects: legacySuspects.length };
  }
  if (!outboxReadable) return { ok: false, reason: 'outbox-verification-failed:unreadable', verdicts, legacy_suspects: legacySuspects.length };
  return { ok: true, reason: 'clean', verdicts, legacy_suspects: legacySuspects.length };
}

/** Per-key collision guard for the CURRENT run: full key only, never a namespace-wide empty check. */
export function assertKeysFree(query, runTag, roles = ['contact-primary', 'contact-secondary', 'negative']) {
  for (const role of roles) {
    const full = derivedPhone(runTag, role);
    const exact = query(`SELECT id FROM crm_contact_phones WHERE phone_key = '${full}' LIMIT 2`);
    const substring = query(`SELECT id FROM crm_contact_phones WHERE phone_key LIKE '%${full}%' LIMIT 2`);
    const receipt = query(`SELECT submission_key FROM crm_idempotency_receipts WHERE submission_key = '${submissionKey(runTag, role)}' LIMIT 2`);
    if (exact.length || substring.length || receipt.length) throw new Error(`synthetic-key-collision:${role}`);
  }
  return true;
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

export function baselineFrom(query) {
  const ids = {};
  for (const r of enumerateRows(query)) (ids[r.table] ||= []).push(r.a5_key);
  for (const k of Object.keys(ids)) ids[k].sort();
  return { schema: BASELINE_SCHEMA, ids, digest: sha256Hex(canonical(ids)) };
}

function cli() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = name => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = opt('dir') || process.env.A5_L2_DIR;
  if (!dir) throw new Error('a5-l2-dir-required');
  mkdirSync(dir, { recursive: true });
  const query = sql => readonlyQuery(sql, process.env);
  const identity = a5RunIdentity(process.env);

  if (cmd === 'begin') {
    const baseline = baselineFrom(query);
    writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify(baseline)}\n`);
    writeFileSync(join(dir, 'identity.json'), `${JSON.stringify(identity)}\n`);
    writeFileSync(join(dir, 'pending.jsonl'), '');
    process.stderr.write(`a5-l2: begin baseline_digest=${baseline.digest} run_tag=${identity.run_tag}\n`);
    return;
  }
  if (cmd === 'record') {
    const event = JSON.parse(process.env.A5_L2_EVENT || '{}');
    appendPendingEvent(join(dir, 'pending.jsonl'), event);
    return;
  }
  /**
   * `if: always()` publication for a run that could NOT clear preflight (or whose finalize threw).
   * It breaks the deadlock "completed run with no evidence" WITHOUT laundering anything:
   *   - zero events, empty baseline => ZERO ownership claims, nothing can become
   *     `baseline-origin` / `previous-a5-proven` for the next run;
   *   - a real, hash-chained, run-identified ledger with conclusion `failure` and an explicit
   *     stopped_at reason, so the next eligible run finds a readable artifact;
   *   - NO database query at all (no enumeration, no attestation), and NO success is claimed.
   * `preflightCleared()` is deliberately NOT consulted here: it is a gate for CLAIM-MAKING
   * ledgers only. Every row, including the legacy namespace, is still verified by `preflight`
   * on the next run, and any `unknown` still stops.
   */
  if (cmd === 'failure-evidence') {
    const baseline = { schema: BASELINE_SCHEMA, ids: {}, digest: sha256Hex(canonical({})) };
    const ledger = createLedger(identity, baseline);
    ledger.evidence_class = 'failure-no-ownership-claims';
    const reason = String(opt('reason') || process.env.A5_L2_FAILURE_REASON || 'preflight-not-cleared')
      .slice(0, 160);
    finalizeLedger(ledger, 'failure', reason);
    writeFileSync(join(dir, `a5-l2-${identity.run_tag}.json`), `${JSON.stringify(ledger)}\n`);
    process.stderr.write(`a5-l2: failure-evidence published (0 ownership claims) run_tag=${identity.run_tag} reason=${reason}\n`);
    return;
  }
  // A checkpoint publishes a REAL (already row_hash-resolved) ledger while the run is still going.
  // This is the incremental-publication requirement: a crash after step N leaves N proven rows,
  // and no `no-ledger(hard-cancel)` acceptance path is introduced.
  if (cmd === 'checkpoint' || cmd === 'finalize') {
    const cleared = preflightCleared(dir, identity.run_tag);
    if (cleared !== 'ok') throw new Error(cleared);
    const baseline = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8'));
    const pending = readPendingEvents(join(dir, 'pending.jsonl'));
    const prior = loadLedgers(opt('ledgers') || process.env.A5_L2_PRIOR_DIR || '', identity.run_tag)
      .filter(x => x.error === 'ok').map(x => x.ledger);
    const ledger = buildLedger({
      identity, baseline, pending, query, priorLedgers: prior,
      conclusion: cmd === 'checkpoint' ? 'running'
        : (opt('conclusion') || process.env.A5_L2_CONCLUSION || 'failure'),
      stopped_at: opt('stopped-at') || process.env.A5_L2_STOPPED_AT || '',
    });
    writeFileSync(join(dir, `a5-l2-${identity.run_tag}.json`), `${JSON.stringify(ledger)}\n`);
    process.stderr.write(`a5-l2: ${cmd} events=${ledger.events.length} conclusion=${ledger.conclusion} digest=${ledger.ledger_sha256}\n`);
    return;
  }
  if (cmd === 'preflight') {
    const ledgers = loadLedgers(opt('ledgers') || process.env.A5_L2_PRIOR_DIR || '', identity.run_tag);
    let keysFree = false;
    let keyError = '';
    try { keysFree = assertKeysFree(query, identity.run_tag); }
    catch (error) { keyError = String(error?.message || error); }
    const result = classifyRows({ query, ledgers, currentRunTag: identity.run_tag });
    const payload = { ok: result.ok && keysFree, reason: keyError || result.reason,
      run_tag: identity.run_tag, ledgers: ledgers.length, rows: result.verdicts.length,
      legacy_suspects: result.legacy_suspects, verdicts: result.verdicts };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    writeFileSync(join(dir, 'preflight.json'), `${JSON.stringify(payload)}\n`);
    if (!payload.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`a5-l2-unknown-command:${cmd}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { cli(); }
  catch (error) {
    process.stderr.write(`a5-l2: STOP ${String(error?.message || error).slice(0, 200)}\n`);
    process.exitCode = 1;
  }
}
