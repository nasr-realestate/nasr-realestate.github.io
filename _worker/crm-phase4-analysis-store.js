// Phase 4 tooling module — turns the offline analysis payload into idempotent SQL for
// the Phase 4 analysis tables (migration 0008) and classifies Drive items against the
// current CRM *without* importing or linking anything.
//
// BARRIERS (CRM_DATA_GOVERNANCE.md §2.2, §3, §4.1, §4.2, §5.4 + migration 0008 header):
//  * Only the eight `crm_*` tables created by migration 0008 are written. Operational
//    CRM tables are read-only inputs to the matcher; no statement here touches them.
//  * Identity is exchanged as SHA-256 digests. Cleartext names, phone numbers and
//    message bodies are rejected by `assertPiiFreePayload` before anything is built.
//  * A number found inside message text can never yield `exact_match`; it yields
//    `third_party_review` at most, with `attributed = 0`.
//  * `auto_link` is always 0 and the table CHECK refuses any other value.
//  * Similar names are never merged: name equality alone is reported as
//    `name_only_match`, and an ambiguous name as `conflict`.

import crypto from 'node:crypto';

import { canonicalPhoneKey, driveRefHash, hashIdentifier, normalizeIdentifyingText } from './crm-wa-vcard-analysis.js';

export const PHASE4_ANALYSIS_TABLES = Object.freeze([
  'crm_drive_analysis_run',
  'crm_drive_file_analysis',
  'crm_drive_archive_entry',
  'crm_wa_conversation',
  'crm_vcard_record',
  'crm_drive_identity_signal',
  'crm_drive_duplicate_finding',
  'crm_drive_match_candidate',
]);

export const OPERATIONAL_CRM_TABLES = Object.freeze([
  'crm_contacts',
  'crm_contact_phones',
  'crm_opportunities',
  'crm_activities',
  'crm_conversations',
  'crm_conversation_messages',
  'crm_smart_alerts',
  'crm_contact_audit_log',
]);

const HEX64 = /^[0-9a-f]{64}$/;
export const TRUSTED_PHONE_PROVENANCE = new Set(['vcard_tel', 'sender_label']);
// Egyptian subscriber shapes: built from parts so the alternation stays reviewable.
const PHONE_SHAPE_RE = new RegExp(
  ['(?:\\+|00)?20?', '\\s?0?1[0125679]', '[\\s().-]?\\d{3}', '[\\s().-]?\\d{4}'].join(''),
);
const FREE_TEXT_KEY = /(^|_)(error_?message|note|label|text|reason|title|display_name|name)($|_)/i;
const OPAQUE_ID_KEY = /(^|_)(drive_?file_?id|sha256|digest|hash|run_?key|receipt_?ref|encoding|version)$/i;
const PII_VALUE_KEY_NAMES = [
  'raw_?text', 'chat_?body', 'body_?text', 'message_?text',
  'full_?name', 'customer_?name', 'contact_?name', 'display_?name', 'name_?value',
  'phone', 'phone_?key', 'phone_?value', 'tel_?value', 'tel',
  'email', 'email_?value', 'address', 'token', 'secret', 'password',
  'vcard', 'vcard_?text',
];
const PII_VALUE_KEY = new RegExp(`(^|_)(?:${PII_VALUE_KEY_NAMES.join('|')})(_|$)`, 'i');
// Counters, flags, digests, sizes and timestamps describe *shape*, never carry a value.
const SAFE_SUFFIXES = [
  '_count', '_length', '_present', '_hash', '_digest', '_sha256', '_bytes', '_shape',
  '_kind', '_category', '_categories', '_basis', '_confidence', '_verified', '_code',
  '_version', '_encoding', '_ratio', '_share', '_total', '_size', '_id', '_key', '_at',
  '_ref', '_status',
];
const SAFE_SUFFIX = new RegExp(`(${SAFE_SUFFIXES.join('|')})$`, 'i');

function json(value) {
  return JSON.stringify(value ?? (Array.isArray(value) ? [] : {}));
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function upsert(table, uniqueCols, cols, conflictExtra = '') {
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter(c => !uniqueCols.includes(c) && c !== 'created_at' && c !== 'drive_file_id')
    .map(c => `${c} = excluded.${c}`);
  if (table === 'crm_drive_file_analysis') {
    updates.push('updated_at = excluded.analyzed_at');
  }
  return (
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${[...uniqueCols, ...conflictExtra.split('|')].filter(Boolean).join(', ')}) ` +
    `DO UPDATE SET ${updates.join(', ')}${updates.length ? ' ' : ''}WHERE 1=1`
  );
}

function stmt(sql, params) {
  return { sql, params: params.map(v => (v === undefined ? null : v)) };
}

function buildRefIndex(registryRows) {
  const byRef = new Map();
  for (const row of registryRows) {
    const ref = driveRefHash(row.drive_file_id);
    if (byRef.has(ref)) {
      throw new Error(`REF_AMBIGUOUS:${ref.slice(0, 12)}`);
    }
    byRef.set(ref, row);
  }
  return byRef;
}

function resolveOneRef(ref, byRef, unresolved) {
  const row = byRef.get(ref);
  if (!row) {
    unresolved.push(ref.slice(0, 12));
    return null;
  }
  return row;
}

function resolveRefEntry(v, byRef, unresolved, out) {
  const row = resolveOneRef(v, byRef, unresolved);
  if (!row) return;
  out.drive_file_id = row.drive_file_id;
  if (row.file_name !== undefined) out.file_name = row.file_name;
}

function resolveRefsInNode(node, byRef, unresolved) {
  if (Array.isArray(node)) return node.map(item => resolveRefsInNode(item, byRef, unresolved));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'ref' && typeof v === 'string') {
      resolveRefEntry(v, byRef, unresolved, out);
      continue;
    }
    if (k === 'refs' && Array.isArray(v)) {
      const ids = v.map(ref => resolveOneRef(ref, byRef, unresolved)?.drive_file_id).filter(Boolean);
      out.drive_file_ids = ids.sort();
      continue;
    }
    out[k] = resolveRefsInNode(v, byRef, unresolved);
  }
  return out;
}

/**
 * Turns a committable (ref-keyed) payload back into a working payload by resolving each
 * one-way `ref` against the registry rows read from D1. Fails closed: an unknown or
 * ambiguous ref aborts the run rather than guessing a row.
 */
export function resolvePayloadRefs({ payload, registryRows = [] }) {
  const byRef = buildRefIndex(registryRows);
  const unresolved = [];
  const resolved = resolveRefsInNode(payload, byRef, unresolved);
  if (unresolved.length > 0) {
    throw new Error(`REF_UNRESOLVED:${[...new Set(unresolved)].slice(0, 5).join(',')}`);
  }
  return resolved;
}

const ROW_REF_KEYS = ['registryUpdates', 'fileAnalysis', 'conversations', 'vcards', 'fileIdentities'];

/**
 * Registry-first partition. Analysis may legitimately cover a Drive file that is not yet
 * registered (a file added after the last inventory); its rows must never be applied, and
 * silently guessing an id is forbidden. Rows whose refs resolve are kept; the rest are
 * deferred and counted, so CI can assert the exact number of deferred files.
 */
export function partitionPayloadByRegistry({ payload, registryRows = [] }) {
  const known = new Set(registryRows.map(row => driveRefHash(row.drive_file_id)));
  const allResolve = refs => (refs ?? []).every(ref => known.has(ref));
  const dropped = new Set();
  const kept = { ...payload };
  for (const key of ROW_REF_KEYS) {
    const rows = Array.isArray(payload[key]) ? payload[key] : [];
    kept[key] = rows.filter(row => {
      if (row.ref && !known.has(row.ref)) {
        dropped.add(row.ref);
        return false;
      }
      return true;
    });
  }
  kept.duplicateFindings = (payload.duplicateFindings ?? []).filter(f => allResolve(f.refs));
  kept.identities = (payload.identities ?? [])
    .map(row => ({ ...row, refs: (row.refs ?? []).filter(ref => known.has(ref)) }))
    .filter(row => row.refs.length > 0);
  kept.files_expected = kept.fileAnalysis.length;
  return {
    payload: kept,
    deferredRefs: [...dropped].sort(),
  };
}

/**
 * A key that names an identity *and* holds a value-shaped payload is an offender.
 * Counters, flags and digests are not: `email_count: 3` describes shape, while
 * `email: 'x@y'` or a 9+ digit run under a phone-ish key is a value.
 */
function looksLikePiiValue(key, value) {
  if (SAFE_SUFFIX.test(key) || !PII_VALUE_KEY.test(key)) {
    return false;
  }
  if (typeof value === 'number') {
    return String(Math.trunc(value)).replace(/-/g, '').length >= 9;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 && !HEX64.test(value);
  }
  return false;
}

function longDigitRun(value) {
  const digits = value.replace(/\D/g, '');
  return /\d{9,}/.test(digits) ? digits.slice(0, 4) + '…' : null;
}

function scanStringValue(value, key, path, offenders) {
  if (HEX64.test(value) || OPAQUE_ID_KEY.test(key)) {
    return true;
  }
  if (PHONE_SHAPE_RE.test(value)) {
    offenders.push(`${path}.${key}:digit_shape`);
    return true;
  }
  if (FREE_TEXT_KEY.test(key) && longDigitRun(value)) {
    offenders.push(`${path}.${key}:digit_run`);
    return true;
  }
  return false;
}

/**
 * Fails loudly if a payload carries anything that looks like cleartext PII. Structural
 * digests are allowed (64-hex), everything else must be a counter, a flag or a code.
 */
export function assertPiiFreePayload(payload) {
  const offenders = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.slice(0, 4000).forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (looksLikePiiValue(key, value)) {
        offenders.push(`${path}.${key}`);
      }
      if (typeof value === 'string') {
        if (scanStringValue(value, key, path, offenders)) continue;
        if (/_json$/.test(key)) parseEmbeddedJson(value, `${path}.${key}`, walk, offenders);
      } else {
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(payload, '$');
  if (offenders.length > 0) {
    throw new Error(`PII_SHAPE_DETECTED:${offenders.slice(0, 5).join(',')}`);
  }
  return { ok: true, checked: true };
}

function parseEmbeddedJson(text, path, walk, offenders) {
  let nested;
  try {
    nested = JSON.parse(text);
  } catch {
    return; // opaque string: the shape rules above already covered it
  }
  if (nested && typeof nested === 'object') {
    walk(nested, `${path}#`);
  }
}

/**
 * Builds the CRM side of the matching problem from read-only queries. Only digests are
 * kept in the returned maps, so the caller can drop the rows immediately.
 */
export function buildCrmMatchIndex({ contacts = [], phones = [] } = {}) {
  const phoneToContacts = new Map();
  const primaryPhoneHashes = new Set();
  const nameToContacts = new Map();
  for (const phone of phones) {
    const key = canonicalPhoneKey(phone.phone_key ?? phone.phoneKey ?? '');
    if (key === null) continue;
    const digest = hashIdentifier('phone_e164', key);
    const set = phoneToContacts.get(digest) ?? new Set();
    set.add(String(phone.contact_id));
    phoneToContacts.set(digest, set);
    if (Number(phone.is_primary) === 1) primaryPhoneHashes.add(digest);
  }
  for (const contact of contacts) {
    const normalized = normalizeIdentifyingText(contact.name ?? '');
    if (normalized.length === 0) continue;
    const digest = hashIdentifier('person_name', normalized);
    const set = nameToContacts.get(digest) ?? new Set();
    set.add(String(contact.id));
    nameToContacts.set(digest, set);
  }
  return { phoneToContacts, primaryPhoneHashes, nameToContacts, phoneRowCount: phones.length, contactCount: contacts.length };
}

function signalsForFile(payload, driveFileId) {
  const merged = new Map();
  for (const signal of payload.fileIdentities ?? []) {
    if (signal.drive_file_id !== driveFileId) continue;
    const key = `${signal.kind}|${signal.digest}`;
    const current = merged.get(key) ?? { kind: signal.kind, digest: signal.digest, provenances: [], attributed: false };
    current.provenances.push(signal.provenance);
    // Attribution needs one trustworthy occurrence, not only trustworthy occurrences:
    // a vCard TEL is direct evidence about this item's contact even when the same
    // number also appears in message text. `provenances` keeps both visible to review.
    if (signal.attributed === true && TRUSTED_PHONE_PROVENANCE.has(signal.provenance)) {
      current.attributed = true;
    }
    merged.set(key, current);
  }
  return [...merged.values()];
}

/**
 * Deterministic, hash-only classification of one Drive file against the CRM.
 *
 * Precedence: attributed phone → primary vs secondary → conflict; a phone that only
 * appears in message text is third-party by construction; name equality alone is
 * `name_only_match`; nothing matched is `unmatched` (or `temporary_review` when the
 * item carries the airplane marker) and stays exactly that way.
 */
function pushRow(ctx, row) {
  const dedupe = `${row.match_class}|${row.signal_digest ?? ''}|${row.crm_contact_id ?? ''}`;
  if (ctx.seen.has(dedupe)) return;
  ctx.seen.add(dedupe);
  ctx.rows.push({ drive_file_id: ctx.driveFileId, ...row });
}

function identityFreeRow(matchClass, evidence, confidence) {
  return {
    match_class: matchClass,
    signal_kind: null,
    signal_digest: null,
    crm_contact_id: null,
    crm_entity: null,
    evidence,
    confidence,
    auto_link: 0,
  };
}

function sortedContacts(index, digest) {
  return [...(index.phoneToContacts.get(digest) ?? [])].sort();
}

function fileCarriesTemporaryMark(file, conversations) {
  if ((file?.temporary_mark_count ?? 0) > 0) return true;
  return conversations.some(c => c.temporary_mark === true || c.temporary_mark === 1);
}

function pushPhoneConflictRows(ctx, signal, contacts) {
  for (const contactId of contacts) {
    pushRow(ctx, {
      match_class: 'conflict',
      signal_kind: 'phone',
      signal_digest: signal.digest,
      crm_contact_id: contactId,
      crm_entity: 'contact',
      evidence: 'phone_digest_shared_by_multiple_contacts',
      confidence: 'high',
      auto_link: 0,
    });
  }
}

function pushAttributedPhoneRows(ctx, signals) {
  const { index } = ctx;
  let matchedContact = null;
  let verdictReached = false;
  for (const signal of signals) {
    const contacts = sortedContacts(index, signal.digest);
    if (contacts.length > 1) {
      verdictReached = true;
      pushPhoneConflictRows(ctx, signal, contacts);
      continue;
    }
    if (contacts.length === 1) {
      matchedContact = contacts[0];
      verdictReached = true;
      const primary = index.primaryPhoneHashes.has(signal.digest);
      pushRow(ctx, {
        match_class: primary ? 'exact_match' : 'probable_match',
        signal_kind: 'phone',
        signal_digest: signal.digest,
        crm_contact_id: contacts[0],
        crm_entity: 'contact',
        evidence: primary
          ? 'trusted_phone_digest_equal_primary'
          : 'trusted_phone_digest_equal_non_primary',
        confidence: primary ? 'high' : 'medium',
        auto_link: 0,
      });
    }
  }
  return { matchedContact, verdictReached };
}

/** A number seen only inside message text is never attributed to the file's owner. */
function pushTextPhoneRows(ctx, signals) {
  for (const signal of signals) {
    const contacts = sortedContacts(ctx.index, signal.digest);
    if (contacts.length === 0) {
      pushRow(ctx, {
        ...identityFreeRow('third_party_review', 'number_found_in_message_text_no_crm_row', 'none'),
        signal_kind: 'phone',
        signal_digest: signal.digest,
      });
      continue;
    }
    for (const contactId of contacts) {
      pushRow(ctx, {
        match_class: 'third_party_review',
        signal_kind: 'phone',
        signal_digest: signal.digest,
        crm_contact_id: contactId,
        crm_entity: 'contact',
        evidence: 'number_found_in_message_text_never_attributed',
        confidence: 'low',
        auto_link: 0,
      });
    }
  }
}

function pushNameRows(ctx, names) {
  let nameHit = false;
  for (const signal of names) {
    const contacts = [...(ctx.index.nameToContacts.get(signal.digest) ?? [])].sort();
    if (contacts.length === 1) {
      nameHit = true;
      pushRow(ctx, {
        match_class: 'name_only_match',
        signal_kind: 'name',
        signal_digest: signal.digest,
        crm_contact_id: contacts[0],
        crm_entity: 'contact',
        evidence: 'normalized_name_digest_equal_no_trusted_phone',
        confidence: 'low',
        auto_link: 0,
      });
    } else if (contacts.length > 1) {
      nameHit = true;
      for (const contactId of contacts) {
        pushRow(ctx, {
          match_class: 'conflict',
          signal_kind: 'name',
          signal_digest: signal.digest,
          crm_contact_id: contactId,
          crm_entity: 'contact',
          evidence: 'name_digest_ambiguous_multiple_contacts',
          confidence: 'low',
          auto_link: 0,
        });
      }
    }
  }
  return nameHit;
}

function pushFallbackRow(ctx, { groupPartners, temporary }) {
  // A transcript that overlaps a file which *did* match is still not a match: it is
  // reported as probable and left for a human, never linked automatically.
  const partnerMatched = (groupPartners ?? []).map(p => p.matched_contact_id).find(Boolean);
  if (partnerMatched) {
    pushRow(ctx, {
      ...identityFreeRow('probable_match', 'transcript_overlap_with_matched_file', 'low'),
      crm_contact_id: partnerMatched,
      crm_entity: 'contact',
    });
  } else if (temporary) {
    pushRow(ctx, identityFreeRow('temporary_review', 'airplane_marker_no_durable_identity', 'none'));
  } else {
    pushRow(ctx, identityFreeRow('unmatched', 'no_trusted_identifier_in_file', 'none'));
  }
}

export function classifyFileMatches({ payload, driveFileId, index, groupPartners = [] }) {
  const file = (payload.fileAnalysis ?? []).find(f => f.drive_file_id === driveFileId);
  const conversations = (payload.conversations ?? []).filter(c => c.drive_file_id === driveFileId);
  const ctx = {
    index,
    driveFileId,
    rows: [],
    seen: new Set(),
    temporary: fileCarriesTemporaryMark(file, conversations),
  };
  if ((file?.analysis_status ?? 'completed') === 'failed') {
    pushRow(ctx, {
      ...identityFreeRow('unmatched', `analysis_failed:${clip(file.error_code ?? 'unknown', 60)}`, 'none'),
    });
    return ctx.rows;
  }
  const signals = signalsForFile(payload, driveFileId);
  const attributed = signals.filter(s => s.kind === 'phone' && s.attributed);
  const textPhones = signals.filter(s => s.kind === 'phone' && !s.attributed);
  const verdict = pushAttributedPhoneRows(ctx, attributed);
  pushTextPhoneRows(ctx, textPhones);
  if (!verdict.verdictReached) {
    const nameHit = pushNameRows(ctx, signals.filter(s => s.kind === 'name'));
    if (!nameHit) pushFallbackRow(ctx, { groupPartners, temporary: ctx.temporary });
  }
  if (ctx.temporary && !ctx.rows.some(r => r.match_class === 'temporary_review')) {
    pushRow(ctx, {
      ...identityFreeRow(
        'temporary_review',
        'airplane_marker_present_regardless_of_other_signals',
        'none',
      ),
      crm_contact_id: verdict.matchedContact,
      crm_entity: verdict.matchedContact ? 'contact' : null,
    });
  }
  return ctx.rows;
}

function findingDigest(finding) {
  return crypto
    .createHash('sha256')
    .update([finding.level, finding.kind, finding.evidence, finding.digest ?? '', ...(finding.drive_file_ids ?? []).slice().sort()].join('|'))
    .digest('hex');
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function bool01(value) {
  return value === true || value === 1 ? 1 : 0;
}

function hex64(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return HEX64.test(text) ? text : null;
}

function listJson(value, max = 4096) {
  const text = json(Array.isArray(value) ? value : []);
  return text.length > max ? clip(text, max) : text;
}

function flagList(values, max) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return clip(values.join(','), max);
}

function shaForFile(payload, driveFileId) {
  const row = (payload.registryUpdates ?? []).find(r => r.drive_file_id === driveFileId);
  return hex64(row?.content_sha256);
}

function runRowParams(payload, aggregate, runKey, analyzedAt, counts) {
  // An analysis run must be attributable to the folder it was read from. The committed
  // payload only carries `drive_parent_ref`, so the caller (CI) injects the id it read back
  // from the registry; silently writing an empty parent would break that audit trail.
  const driveParentId = payload.driveParentId || payload.drive_parent_ref;
  if (!driveParentId) {
    throw new Error('ANALYSIS_RUN_PARENT_REQUIRED: payload has no drive_parent_ref and no injected driveParentId');
  }
  return [
    runKey,
    payload.payload_fingerprint,
    payload.rule_version,
    driveParentId,
    num(payload.files_expected ?? aggregate.files_total),
    num(aggregate.files_total),
    num(aggregate.files_processed),
    num(aggregate.files_failed),
    num(aggregate.conversations),
    num(aggregate.messages),
    num(aggregate.vcard_records),
    num(counts.duplicateFindings),
    num(counts.matchCandidates),
    0,
    num(counts.recordsWritten),
    json(aggregate),
    analyzedAt,
    analyzedAt,
  ];
}

const RUN_UPSERT_SQL = `INSERT INTO crm_drive_analysis_run (
       run_key, payload_fingerprint, analysis_version, drive_parent_id, files_expected,
       files_analyzed, files_processed, files_failed, conversations_total, messages_total,
       vcard_records_total, duplicate_findings, match_candidates, import_performed,
       records_written, aggregate_json, started_at, completed_at
     ) VALUES (${new Array(18).fill('?').join(', ')})
     ON CONFLICT(run_key) DO UPDATE SET
       files_analyzed = excluded.files_analyzed,
       files_processed = excluded.files_processed,
       files_failed = excluded.files_failed,
       conversations_total = excluded.conversations_total,
       messages_total = excluded.messages_total,
       vcard_records_total = excluded.vcard_records_total,
       duplicate_findings = excluded.duplicate_findings,
       match_candidates = excluded.match_candidates,
       records_written = excluded.records_written,
       aggregate_json = excluded.aggregate_json,
       completed_at = excluded.completed_at`;

// Several child tables have a UNIQUE key that may contain NULLs (a digest or a contact id
// is legitimately absent for `unmatched` rows). SQLite treats NULLs as distinct there, so a
// re-run replaces its own output — scoped to its `run_key`, never to another run's rows —
// instead of racing the constraint and doubling rows. `crm_drive_file_analysis` (primary key
// drive_file_id) and `crm_drive_archive_entry` (fully non-NULL unique key) need no
// replacement pass, and the latter has no run_key column at all.
export const PHASE4_RUN_SCOPED_TABLES = [
  'crm_wa_conversation',
  'crm_vcard_record',
  'crm_drive_identity_signal',
  'crm_drive_duplicate_finding',
  'crm_drive_match_candidate',
];

function buildRunReplacementStatements(runKey) {
  return PHASE4_RUN_SCOPED_TABLES.map(table => stmt(`DELETE FROM ${table} WHERE run_key = ?`, [runKey]));
}

function fileAnalysisRow(payload, file, analyzedAt, runKey) {
  const cols = [
    'drive_file_id', 'content_sha256', 'inner_content_sha256', 'content_kind', 'analysis_status',
    'size_bytes', 'drive_size_bytes', 'size_verified', 'archive_entry_count', 'archive_text_records',
    'archive_rejected_entries', 'archive_skipped_entries', 'safety_flags_json', 'extracted_records_count',
    'message_count_total', 'temporary_mark_count', 'text_encoding', 'error_code', 'error_message',
    'elapsed_ms', 'analysis_version', 'run_key', 'analyzed_at', 'created_at', 'updated_at',
  ];
  const params = [
    file.drive_file_id,
    shaForFile(payload, file.drive_file_id),
    hex64(file.inner_content_sha256),
    file.content_kind ?? 'UNKNOWN',
    file.analysis_status ?? 'completed',
    num(file.size_bytes),
    num(file.drive_size_bytes),
    file.size_verified ?? 'unknown',
    num(file.archive_entry_count),
    num(file.archive_text_records),
    num(file.archive_rejected_entries),
    num(file.archive_skipped_entries),
    listJson(safeParse(file.safety_flags_json), 8192),
    num(file.extracted_records_count),
    num(file.message_count_total),
    num(file.temporary_mark_count),
    file.text_encoding ?? null,
    file.error_code ?? null,
    clip(file.error_message, 300) || null,
    file.elapsed_ms === null || file.elapsed_ms === undefined ? null : num(file.elapsed_ms),
    payload.rule_version,
    runKey,
    analyzedAt,
    analyzedAt,
    analyzedAt,
  ];
  return stmt(upsert('crm_drive_file_analysis', ['drive_file_id'], cols), params);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function archiveEntryRow(entry, analyzedAt) {
  const cols = [
    'drive_file_id', 'entry_name_sha256', 'entry_extension', 'entry_method', 'compressed_bytes',
    'uncompressed_bytes', 'accepted', 'rejected_reasons_json', 'skipped_reasons_json',
    'issue_codes_json', 'analyzed_at',
  ];
  const params = [
    entry.drive_file_id,
    hex64(entry.entry_name_sha256),
    clip(entry.entry_extension?.toLowerCase() ?? '', 12) || null,
    typeof entry.entry_method === 'number' ? `method_${entry.entry_method}` : entry.entry_method ?? null,
    num(entry.compressed_bytes),
    num(entry.uncompressed_bytes),
    bool01(entry.accepted),
    listJson(entry.rejected_reasons, 2048),
    listJson(entry.skipped_reasons, 2048),
    listJson(entry.issue_codes, 2048),
    analyzedAt,
  ];
  return stmt(
    upsert('crm_drive_archive_entry', ['drive_file_id', 'entry_name_sha256', 'uncompressed_bytes'], cols),
    params,
  );
}

function conversationRow(conv, analyzedAt, runKey) {
  const cols = [
    'drive_file_id', 'entry_name_sha256', 'entry_sha256', 'record_sha256', 'normalized_sha256',
    'set_sha256', 'prefix20_sha256', 'suffix20_sha256', 'message_count', 'body_bytes',
    'body_char_count', 'first_iso_date', 'last_iso_date', 'transcript_format', 'text_encoding',
    'unique_sender_labels', 'sender_label_phone_count', 'dominant_sender_share',
    'deleted_message_count', 'media_message_count', 'unsupported_message_count',
    'phone_only_body_message_count', 'system_line_count', 'unparsed_line_count',
    'continuation_line_count', 'ambiguous_date_line_count', 'body_phone_candidate_count',
    'temporary_mark', 'status_colors', 'identity_basis', 'identity_confidence',
    'ownership_reasons_json', 'run_key', 'analyzed_at',
  ];
  const params = [
    conv.drive_file_id,
    hex64(conv.entry_name_sha256),
    hex64(conv.entry_sha256),
    hex64(conv.record_sha256),
    hex64(conv.normalized_sha256),
    hex64(conv.set_sha256),
    hex64(conv.prefix20_sha256),
    hex64(conv.suffix20_sha256),
    num(conv.message_count),
    num(conv.body_bytes),
    num(conv.body_char_count),
    conv.first_iso_date ?? null,
    conv.last_iso_date ?? null,
    conv.transcript_format ?? null,
    conv.text_encoding ?? null,
    num(conv.unique_sender_labels),
    num(conv.sender_label_phone_count),
    conv.dominant_sender_share ?? null,
    num(conv.deleted_message_count),
    num(conv.media_message_count),
    num(conv.unsupported_message_count),
    num(conv.phone_only_body_message_count),
    num(conv.system_line_count),
    num(conv.unparsed_line_count),
    num(conv.continuation_line_count),
    num(conv.ambiguous_date_line_count),
    num(conv.body_phone_candidate_count),
    bool01(conv.temporary_mark),
    flagList(conv.status_colors, 60),
    conv.identity_basis ?? 'none',
    conv.identity_confidence ?? 'none',
    listJson(conv.ownership_reasons, 4096),
    runKey,
    analyzedAt,
  ];
  return stmt(upsert('crm_wa_conversation', ['drive_file_id', 'record_sha256'], cols), params);
}

function vcardRow(card, analyzedAt, runKey) {
  const cols = [
    'drive_file_id', 'entry_name_sha256', 'vcf_set_sha256', 'card_index', 'record_sha256',
    'classification', 'classification_reasons_json', 'informational_notes_json',
    'display_name_present', 'display_name_length', 'name_hash', 'phone_hash_count',
    'tel_property_count', 'unparsable_tel_count', 'normalized_phone_count',
    'international_phone_count', 'email_count', 'organization_present', 'note_present',
    'has_structured_name_field', 'phone_types_json', 'temporary_mark', 'binary_payload_bytes',
    'vcf_version', 'structure_issues_json', 'run_key', 'analyzed_at',
  ];
  const params = [
    card.drive_file_id,
    hex64(card.entry_name_sha256),
    hex64(card.vcf_set_sha256),
    num(card.card_index),
    hex64(card.record_sha256),
    card.classification ?? 'needs_human_review',
    listJson(card.classification_reasons, 4096),
    listJson(card.informational_notes, 4096),
    bool01(card.display_name_present),
    card.display_name_length === undefined ? null : num(card.display_name_length),
    hex64(card.name_hash),
    num(card.phone_hash_count),
    num(card.tel_property_count),
    num(card.unparsable_tel_count),
    num(card.normalized_phone_count),
    num(card.international_phone_count),
    num(card.email_count),
    bool01(card.organization_present),
    bool01(card.note_present),
    bool01(card.has_structured_name_field),
    listJson(card.type_categories ?? card.phone_types, 1024),
    bool01(card.temporary_mark),
    num(card.binary_payload_bytes),
    card.vcf_version ?? null,
    listJson(card.structure_issues, 2048),
    runKey,
    analyzedAt,
  ];
  return stmt(
    upsert('crm_vcard_record', ['drive_file_id', 'entry_name_sha256', 'card_index'], cols),
    params,
  );
}

function sourceCountForDigest(identities, digest) {
  const row = (identities ?? []).find(item => item.digest === digest);
  return row ? Math.max(1, num(row.source_count)) : 1;
}

function signalRow(signal, identities, analyzedAt, runKey) {
  const cols = [
    'drive_file_id', 'signal_kind', 'signal_digest', 'provenance', 'attributed',
    'source_file_count', 'run_key', 'analyzed_at',
  ];
  const params = [
    signal.drive_file_id,
    signal.kind,
    hex64(signal.digest),
    signal.provenance,
    bool01(signal.attributed),
    sourceCountForDigest(identities, signal.digest),
    runKey,
    analyzedAt,
  ];
  const unique = ['drive_file_id', 'signal_kind', 'signal_digest', 'provenance'];
  return stmt(upsert('crm_drive_identity_signal', unique, cols), params);
}

function duplicateRow(finding, analyzedAt, runKey) {
  const cols = [
    'finding_sha256', 'level', 'record_kind', 'evidence', 'digest', 'drive_file_ids_json',
    'overlap_ratio', 'shared_message_count', 'action', 'run_key', 'analyzed_at',
  ];
  const params = [
    findingDigest(finding),
    finding.level,
    finding.kind ?? 'file',
    clip(finding.evidence, 60),
    hex64(finding.digest),
    listJson(finding.drive_file_ids ?? [], 8192),
    finding.overlap_ratio ?? null,
    finding.shared_message_count === undefined ? null : num(finding.shared_message_count),
    clip(finding.action ?? 'needs_human_review', 80),
    runKey,
    analyzedAt,
  ];
  return stmt(upsert('crm_drive_duplicate_finding', ['finding_sha256'], cols), params);
}

function matchRow(row, analyzedAt, runKey) {
  const cols = [
    'drive_file_id', 'match_class', 'signal_kind', 'signal_digest', 'crm_contact_id',
    'crm_entity', 'evidence', 'confidence', 'auto_link', 'run_key', 'analyzed_at',
  ];
  const params = [
    row.drive_file_id,
    row.match_class,
    row.signal_kind ?? null,
    hex64(row.signal_digest),
    row.crm_contact_id ?? null,
    row.crm_entity ?? null,
    clip(row.evidence, 200),
    row.confidence ?? 'none',
    0,
    runKey,
    analyzedAt,
  ];
  const unique = ['drive_file_id', 'match_class', 'signal_digest', 'crm_contact_id'];
  return stmt(upsert('crm_drive_match_candidate', unique, cols), params);
}

/**
 * Full statement set for one analysis run. Ordered so that a single `db.batch()`
 * applies run → files → entries → records → signals → duplicates → matches.
 */
export function buildPhase4Statements({ payload, index, runKey, now, groupPartnersByFile = {} }) {
  const analyzedAt = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const aggregate = payload.aggregate ?? {};
  const fileRows = (payload.fileAnalysis ?? []).map(f => fileAnalysisRow(payload, f, analyzedAt, runKey));
  const entryRows = (payload.zipEntries ?? []).map(e => archiveEntryRow(e, analyzedAt));
  const convRows = (payload.conversations ?? []).map(c => conversationRow(c, analyzedAt, runKey));
  const cardRows = (payload.vcards ?? []).map(c => vcardRow(c, analyzedAt, runKey));
  const signalRows = (payload.fileIdentities ?? []).map(s => signalRow(s, payload.identities, analyzedAt, runKey));
  const dupRows = (payload.duplicateFindings ?? []).map(f => duplicateRow(f, analyzedAt, runKey));
  const matchRows = buildMatchRows(payload, index, analyzedAt, runKey, groupPartnersByFile);
  const counts = {
    duplicateFindings: dupRows.length,
    matchCandidates: matchRows.length,
    recordsWritten: convRows.length + cardRows.length,
  };
  const statements = [
    stmt(RUN_UPSERT_SQL, runRowParams(payload, aggregate, runKey, analyzedAt, counts)),
    ...buildRunReplacementStatements(runKey),
    ...fileRows,
    ...entryRows,
    ...convRows,
    ...cardRows,
    ...signalRows,
    ...dupRows,
    ...matchRows,
  ];
  return {
    statements,
    runKey,
    analyzedAt,
    counts: { ...counts, statements: statements.length, files: fileRows.length, entries: entryRows.length },
  };
}

function buildMatchRows(payload, index, analyzedAt, runKey, groupPartnersByFile) {
  const rows = [];
  for (const file of payload.fileAnalysis ?? []) {
    if (!file.drive_file_id) continue;
    const partners = groupPartnersByFile[file.drive_file_id] ?? [];
    const classified = classifyFileMatches({ payload, driveFileId: file.drive_file_id, index, groupPartners: partners });
    for (const row of classified) {
      rows.push(matchRow(row, analyzedAt, runKey));
    }
  }
  return rows;
}

/** Row-count snapshot used to prove that operational tables and registry rows are unchanged. */
export function buildOperationalCountQueries() {
  return OPERATIONAL_CRM_TABLES.map(table => ({
    table,
    sql: `SELECT COUNT(*) AS c FROM ${table}`,
  }));
}

export { upsert as _upsertTemplate };
