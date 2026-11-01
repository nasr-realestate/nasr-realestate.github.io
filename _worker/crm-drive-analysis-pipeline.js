// Phase 4 tooling module — turns downloaded Google Drive CRM source files into a
// privacy-minimal analysis payload for `crm_drive_file_registry` + the Phase 4
// analysis tables (migration 0008).
//
// CONTRACT (CRM_DATA_GOVERNANCE.md §2.2, §3, §4.1, §4.2, §5.4):
//  * Content digests come from actual bytes only; Drive metadata is never used as a
//    content hash.
//  * Identity leaves this module only as a SHA-256 digest (phone/name) or a counter.
//    No cleartext name, phone number or message body is ever emitted.
//  * A phone number found inside message text is emitted with
//    `attributed:false` and is never bound to the conversation owner.
//  * Similar names are never merged; duplicate verdicts require digests.
//  * A ZIP outer-digest difference alone never proves an inner-content difference.

import crypto from 'node:crypto';

import {
  DEFAULT_ZIP_LIMITS,
  ZipSafetyError,
  assessArchiveSafety,
  extractAllowedRecords,
  sha256Hex,
} from './crm-safe-archive.js';
import {
  classifyTranscriptOwnership,
  classifyVcardCard,
  decodeMaybeText,
  hashIdentifier,
  nameHash,
  driveRefHash,
  normalizeIdentifyingText,
  parseEgyptianPhone,
  parseVcfCards,
  parseWhatsAppTranscript,
} from './crm-wa-vcard-analysis.js';

export const PHASE4_RULE_VERSION = 'p4a-v1';
export const PHASE4_ENVELOPE_PREFIX = 'p4ana_v1';
export const PHASE4_IDENTITY_HASH_PEPPER = 'crm-p4-v1';
// A real Drive folder id is never committed (CRM_DATA_GOVERNANCE §2.2, §4.4): it is a
// run-time input, and the payload carries only its one-way hash so CI can prove which
// folder a payload belongs to without publishing the id.
const REGISTRY_FOLDER = process.env.CRM_DRIVE_FOLDER_ID ?? '';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const EMPTY_ZIP_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];

function isZipBytes(buf) {
  return (
    (buf[0] === ZIP_SIGNATURE[0] && buf[1] === ZIP_SIGNATURE[1] && buf[2] === ZIP_SIGNATURE[2] && buf[3] === ZIP_SIGNATURE[3]) ||
    (buf[0] === EMPTY_ZIP_SIGNATURE[0] && buf[1] === EMPTY_ZIP_SIGNATURE[1])
  );
}

function looksLikeVcf(buf, text) {
  return /BEGIN:VCARD/i.test(text.slice(0, 4096)) || /BEGIN:VCARD/i.test(text.slice(-4096));
}

function omitKeys(source, keys) {
  const rest = { ...source };
  for (const key of keys) {
    delete rest[key];
  }
  return rest;
}

function receiptRef(digest) {
  return `p4a:sha256:${digest.slice(0, 32)}`;
}

function canonicalRecordSetDigest(digests) {
  const sorted = [...new Set(digests.filter(Boolean))].sort();
  if (sorted.length === 0) {
    return null;
  }
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function identityFromLabel(label) {
  const asPhone = parseEgyptianPhone(label);
  return {
    looks_like_phone: asPhone.ok,
    phone_hash: asPhone.ok ? asPhone.phoneHash : null,
    name_hash: nameHash(label),
    label_length: String(label ?? '').trim().length,
  };
}

/** Parses one WhatsApp TXT export into PII-free statistics. */
function analyzeConversationRecord({ entryBytes, entrySha, archiveLabel, entryName }) {
  const decoded = decodeMaybeText(entryBytes);
  const parsed = parseWhatsAppTranscript(decoded.text);
  const ownership = classifyTranscriptOwnership(parsed, archiveLabel ?? entryName ?? '');
  const identity = parsed.identity ?? {};
  const phoneHashes = [];
  for (const item of identity.sender_phone_hashes ?? []) {
    phoneHashes.push({ phone_hash: item.phone_hash, provenance: 'sender_label', attributed: true });
  }
  for (const hash of identity.sender_name_hashes ?? []) {
    phoneHashes.push({ name_hash: hash, provenance: 'sender_label_name', attributed: false });
  }
  for (const hash of identity.body_phone_candidate_hashes ?? []) {
    phoneHashes.push({ phone_hash: hash, provenance: 'body_text_candidate', attributed: false });
  }
  const archiveIdentity = identityFromLabel(archiveLabel);
  if (archiveIdentity.name_hash) {
    phoneHashes.push({ name_hash: archiveIdentity.name_hash, provenance: 'archive_label_name', attributed: false });
  }
  const stats = parsed.stats ?? {};
  return {
    record_kind: 'wa_conversation',
    entry_name_sha256: entryName ? hashIdentifier('entry_name', entryName) : null,
    entry_sha256: entrySha ?? null,
    record_sha256: parsed.fingerprint.full_sha256,
    normalized_sha256: parsed.fingerprint.normalized_sha256,
    set_sha256: parsed.fingerprint.set_sha256,
    prefix20_sha256: parsed.fingerprint.prefix20_sha256,
    suffix20_sha256: parsed.fingerprint.suffix20_sha256,
    message_count: stats.messages_total ?? 0,
    body_bytes: entryBytes.length,
    first_iso_date: parsed.first_iso_date,
    last_iso_date: parsed.last_iso_date,
    text_encoding: decoded.encoding,
    encoding_warnings: decoded.warnings,
    transcript_format: parsed.format,
    unique_sender_labels: stats.unique_sender_labels ?? 0,
    sender_label_phone_count: stats.sender_labels_matching_phone_shape ?? 0,
    dominant_sender_share: identity.dominant_sender_share ?? 0,
    deleted_message_count: stats.deleted_messages ?? 0,
    unsupported_message_count: stats.unsupported_messages ?? 0,
    phone_only_body_message_count: stats.body_is_phone_only_messages ?? 0,
    media_message_count: stats.media_messages ?? 0,
    text_only_message_count: stats.text_only_messages ?? 0,
    system_line_count: stats.system_lines ?? 0,
    body_char_count: stats.total_body_chars ?? 0,
    unparsed_line_count: stats.unparsed_lines ?? 0,
    continuation_line_count: stats.continuation_lines ?? 0,
    ambiguous_date_line_count: stats.ambiguous_date_lines ?? 0,
    body_phone_candidate_count: (identity.body_phone_candidate_hashes ?? []).length,
    temporary_mark: ownership.temporary,
    status_colors: ownership.status_colors,
    owner_identifiable: ownership.owner_identifiable,
    identity_basis: ownership.identity_basis ?? 'none',
    identity_confidence: ownership.identity_confidence ?? 'none',
    ownership_reasons: ownership.reasons,
    identity_signals: phoneHashes,
    _hashes: parsed.fingerprint.hashes ?? [],
  };
}

function analyzeVcfRecord({ entryBytes, entryName }) {
  const decoded = decodeMaybeText(entryBytes);
  const { cards, orphanIssues } = parseVcfCards(decoded.text);
  const identitySignals = [];
  const classificationTally = {};
  const noteTally = {};
  const records = [];
  for (const card of cards) {
    const { classification, reasons, informational_notes: notes } = classifyVcardCard(card);
    classificationTally[classification] = (classificationTally[classification] ?? 0) + 1;
    for (const note of notes ?? []) {
      noteTally[note] = (noteTally[note] ?? 0) + 1;
    }
    for (const hash of card.phone_hashes ?? []) {
      identitySignals.push({ phone_hash: hash, provenance: 'vcard_tel', attributed: true });
    }
    if (card.fn_hash) {
      identitySignals.push({ name_hash: card.fn_hash, provenance: 'vcard_fn', attributed: false });
    }
    records.push({
      entry_name_sha256: entryName ? hashIdentifier('entry_name', entryName) : null,
      card_index: card.index,
      record_sha256: canonicalRecordSetDigest([
        ...(card.phone_hashes ?? []),
        card.fn_hash ?? null,
        String(card.vcf_version ?? ''),
      ]),
      classification,
      classification_reasons: reasons,
      informational_notes: [],
      display_name_present: card.fn_present,
      display_name_length: card.fn_length,
      name_hash: card.fn_hash,
      phone_hash_count: (card.phone_hashes ?? []).length,
      tel_property_count: card.tel_count,
      unparsable_tel_count: (card.tel_count ?? 0) - (card.normalized_tel_count ?? 0),
      normalized_phone_count: card.normalized_tel_count,
      email_count: card.email_count,
      organization_present: card.org_present,
      note_present: card.note_present,
      has_structured_name_field: card.n_present,
      label_categories: card.labels ?? [],
      type_categories: card.tel_types ?? [],
      temporary_mark: card.temporary_mark,
      status_colors: card.status_colors ?? [],
      binary_payload_bytes: card.binary_payload_bytes,
      vcf_version: card.vcf_version,
      structure_issues: card.structure_issues,
    });
  }
  return {
    record_kind: 'vcard_set',
    entry_name_sha256: entryName ? hashIdentifier('entry_name', entryName) : null,
    record_count: cards.length,
    record_sha256: canonicalRecordSetDigest(records.map(r => r.record_sha256)),
    text_encoding: decoded.encoding,
    encoding_warnings: decoded.warnings,
    orphan_issues: orphanIssues,
    classification_tally: classificationTally,
    informational_note_tally: noteTally,
    identity_signals: identitySignals,
    records,
  };
}

function newAnalysisResult({ driveFileId, fileName, mimeType, driveMeta, contentSha256 }, buf, lim) {
  return {
    drive_file_id: driveFileId,
    file_name: fileName,
    mime_type: mimeType,
    content_sha256: contentSha256,
    size_bytes: buf.length,
    drive_size_bytes: Number.isFinite(driveMeta?.size) ? driveMeta.size : null,
    drive_modified_at: driveMeta?.modified_time ?? null,
    download_verified: Number.isFinite(driveMeta?.size) ? driveMeta.size === buf.length : null,
    analysis_version: PHASE4_RULE_VERSION,
    safety: {
      limits: {
        maxEntries: lim.maxEntries,
        maxEntryUncompressedBytes: lim.maxEntryUncompressedBytes,
        maxTotalUncompressedBytes: lim.maxTotalUncompressedBytes,
        maxCompressionRatio: lim.maxCompressionRatio,
        maxPathDepth: lim.maxPathDepth,
        maxElapsedMs: lim.maxElapsedMs,
      },
    },
    records: { conversations: [], vcards: [] },
    zip_entries: [],
    extracted_records_count: 0,
    inner_content_sha256: null,
    processing_status: 'processed',
    error_code: null,
    error_message: null,
  };
}

function applyVcfStream(result, buf) {
    result.content_type = 'VCF';
    const vcf = analyzeVcfRecord({ entryBytes: buf, entryName: 'root.vcf' });
    result.records.vcards.push(vcf);
    result.inner_content_sha256 = vcf.record_sha256;
    result.extracted_records_count = vcf.record_count;
    result.text_encoding = vcf.text_encoding;
    result.encoding_warnings = vcf.encoding_warnings;
    result.identity_signals = vcf.identity_signals;
    result.classification_tally = vcf.classification_tally;
    if (vcf.record_count === 0) {
      result.processing_status = 'failed';
      result.error_code = 'NO_VCARD_BLOCKS';
      result.error_message = 'no BEGIN:VCARD block found in payload';
    }
    result.safety = { ...result.safety, archive_issues: [], entry_count: 1, kind: 'single_vcf' };
}

function analyzeZipStream(result, buf, mimeType, lim) {
  result.content_type = 'ZIP';
  if (mimeType === 'text/x-vcard') {
    result.safety.archive_issues.push('mime_container_mismatch');
  }
  let archive;
  try {
    archive = extractAllowedRecords(buf, { limits: lim });
  } catch (err) {
    result.processing_status = 'failed';
    result.error_code = err instanceof ZipSafetyError
      ? `ZIP_${String(err.code).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
      : 'ZIP_READ_FAILED';
    result.error_message = err instanceof ZipSafetyError
      ? `archive unreadable (${err.code})`
      : 'archive unreadable';
    return result;
  }
  const safety = assessArchiveSafety(archive, lim);
  result.safety = {
    ...safety,
    limits: result.safety.limits,
    kind: 'zip_container',
    inflated_bytes: archive.inflatedBytes,
    archive_issues: archive.archiveIssues,
    entry_shapes: archive.entries.map(entry => ({
      name_sha256: entry.nameSha256,
      extension: entry.extension,
      method: entry.method,
      compressed_bytes: entry.compressedSize,
      uncompressed_bytes: entry.uncompressedSize,
      issues: entry.issues,
    })),
  };
  result.zip_entries = archive.entries.map(entry => ({
    entry_name_sha256: entry.nameSha256,
    entry_extension: entry.extension || null,
    entry_method: entry.method,
    compressed_bytes: entry.compressedSize,
    uncompressed_bytes: entry.uncompressedSize,
    accepted: (archive.accepted ?? []).some(a => a.index === entry.index),
    rejected_reasons: (archive.rejected ?? []).find(r => r.index === entry.index)?.reasons ?? [],
    skipped_reasons: (archive.skipped ?? []).filter(s => s.index === entry.index).map(s => s.reason),
    issue_codes: entry.issues,
  }));

  collectArchiveRecords(archive, result);
  const innerDigests = [
    ...result.records.conversations.map(c => c.record_sha256),
    ...result.records.vcards.map(v => v.record_sha256),
  ];
  result.inner_content_sha256 = canonicalRecordSetDigest(innerDigests);
  result.extracted_records_count =
    result.records.conversations.length + result.records.vcards.reduce((n, v) => n + v.record_count, 0);
  result.identity_signals = [
    ...result.records.conversations.flatMap(c => c.identity_signals),
    ...result.records.vcards.flatMap(v => v.identity_signals),
  ];
  const encodings = new Set([
    ...result.records.conversations.map(c => c.text_encoding),
    ...result.records.vcards.map(v => v.text_encoding),
  ]);
  result.text_encoding = [...encodings].join('+') || null;
  result.encoding_warnings = [
    ...new Set([...result.records.conversations, ...result.records.vcards].flatMap(r => r.encoding_warnings ?? [])),
  ];
  if (result.records.conversations.length === 0 && result.records.vcards.length === 0) {
    result.processing_status = 'failed';
    result.error_code = result.safety.has_encrypted_entries
      ? 'ZIP_ENCRYPTED_OR_BLOCKED'
      : 'NO_TXT_OR_VCF_RECORDS_IN_ARCHIVE';
    result.error_message = 'archive holds no TXT/VCF record that may be parsed';
  }
  flagNestedArchives(archive, result);
  return result;
}

function collectArchiveRecords(archive, result) {
  const archiveLabel = result.file_name;
  for (const accepted of archive.accepted) {
    if (accepted.extension === '.txt') {
      result.records.conversations.push(
        analyzeConversationRecord({
          entryBytes: accepted.bytes,
          entrySha: accepted.sha256,
          archiveLabel,
          entryName: accepted.name,
          entrySha: accepted.sha256,
        }),
      );
    } else if (accepted.extension === '.vcf') {
      result.records.vcards.push(
        analyzeVcfRecord({ entryBytes: accepted.bytes, entryName: accepted.name }),
      );
    }
  }
}

function flagNestedArchives(archive, result) {
  for (const accepted of archive.accepted) {
    if (accepted.startsWithZipSignature) {
      result.safety.archive_issues.push('embedded_archive_signature_in_text');
      result.safety.has_nested_archives = true;
    }
  }
}

export function analyzeDriveFile({ driveFileId, fileName, mimeType, driveMeta, bytes, limits = {} }) {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  const contentSha256 = sha256Hex(buf);
  const result = newAnalysisResult({ driveFileId, fileName, mimeType, driveMeta, contentSha256 }, buf, lim);

  if (buf.length === 0) {
    result.processing_status = 'failed';
    result.error_code = 'EMPTY_DOWNLOAD_PAYLOAD';
    result.error_message = 'downloaded payload has zero bytes';
    return result;
  }
  if (result.drive_size_bytes !== null && !result.download_verified) {
    result.size_mismatch = true;
    result.safety.archive_issues = ['drive_size_mismatch'];
  }

  const asText = decodeMaybeText(buf);
  const containerIsZip = isZipBytes(buf);
  // Container magic wins over both the Drive mime type and content sniffing: a STORED
  // archive can legitimately contain the literal text "BEGIN:VCARD".
  if (!containerIsZip && (mimeType === 'text/x-vcard' || looksLikeVcf(buf, asText.text))) {
    applyVcfStream(result, buf);
    return result;
  }

  if (!isZipBytes(buf)) {
    result.content_type = 'OTHER';
    result.processing_status = 'failed';
    result.error_code = 'UNRECOGNISED_CONTAINER_FORMAT';
    result.error_message = 'payload is neither a ZIP container nor a vCard stream';
    return result;
  }

  return analyzeZipStream(result, buf, mimeType, lim);
}

/**
 * Committable form of an analysis payload: every Drive id becomes a one-way `ref`
 * digest, `drive_file_ids` arrays become `refs`, and any file-name field is dropped.
 * Applied structurally so no field can be forgotten.
 */
export const PSEUDONYM_DROP_KEYS = new Set(['drive_name', 'file_name', 'placeholder_name', 'archive_label']);

export function pseudonymizePayload(node) {
  if (Array.isArray(node)) {
    return node.map(item => pseudonymizePayload(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (PSEUDONYM_DROP_KEYS.has(k)) continue;
    if (k === 'drive_file_id' && typeof v === 'string') {
      out.ref = driveRefHash(v);
      continue;
    }
    if (k === 'drive_file_ids' && Array.isArray(v)) {
      out.refs = v.map(id => driveRefHash(id)).sort();
      continue;
    }
    out[k] = pseudonymizePayload(v);
  }
  return out;
}

/**
 * Full overlap of a shorter transcript inside a longer one means the longer file is a
 * re-export, not a duplicate conversation; anything short of sustained overlap is only
 * shared wording, which is explicitly not a duplication finding.
 */
function overlapEvidence(isOverlap, overlap, largerSize, smallerSize) {
  if (!isOverlap) return 'phrase_similarity_only';
  if (overlap === 1 && largerSize > smallerSize) return 'superset_reexport';
  return 'conversation_overlap_candidate';
}

/** Compares every pair of analysed conversations/record sets and returns dedup evidence. */
function collectComparableItems(results) {
  const items = [];
  for (const res of results) {
    for (const conv of res.records.conversations) {
      items.push({ drive_file_id: res.drive_file_id, kind: 'conversation', conv });
    }
    for (const vcf of res.records.vcards) {
      items.push({ drive_file_id: res.drive_file_id, kind: 'vcf_set', digest: vcf.record_sha256 });
    }
  }
  return items;
}

/**
 * Digests shared by many *unrelated* conversations are boilerplate (greetings, "ok",
 * price back-and-forth). Counting them as overlap would invent duplication findings, so
 * they are suppressed before any pair is compared.
 */
function frequentPhraseDigests(items, options) {
  const threshold = options.commonPhraseFileThreshold ?? Math.max(5, Math.ceil(items.length * 0.05));
  const phraseFrequency = new Map();
  for (const item of items) {
    if (item.kind !== 'conversation') continue;
    for (const hash of new Set(item.conv._hashes ?? [])) {
      phraseFrequency.set(hash, (phraseFrequency.get(hash) ?? 0) + 1);
    }
  }
  const commonPhrases = new Set(
    [...phraseFrequency.entries()].filter(([, count]) => count >= threshold).map(([hash]) => hash),
  );
  return { commonPhrases, commonThreshold: threshold };
}

function outerByteFindings(results) {
  const outerByContent = new Map();
  for (const res of results) {
    const list = outerByContent.get(res.content_sha256) ?? [];
    list.push(res.drive_file_id);
    outerByContent.set(res.content_sha256, list);
  }
  const findings = [];
  for (const [digest, ids] of outerByContent) {
    if (ids.length > 1) {
      findings.push({
        level: 'outer_bytes',
        digest,
        drive_file_ids: ids.sort(),
        evidence: 'content_sha256_equal',
        action: 'keep_independent_rows',
      });
    }
  }
  return findings;
}

function pairIds(a, b) {
  return [a.drive_file_id, b.drive_file_id].sort();
}

function compareVcfPair(a, b, findings) {
  if (a.digest && a.digest === b.digest) {
    findings.push({
      level: 'inner_records',
      kind: 'vcf_set',
      digest: a.digest,
      drive_file_ids: pairIds(a, b),
      evidence: 'canonical_record_set_digest_equal',
      action: 'keep_independent_rows',
    });
  }
}

function compareConversationPair(a, b, findings, stripCommon) {
  const fa = a.conv;
  const fb = b.conv;
  if (fa.record_sha256 && fb.record_sha256 && fa.record_sha256 !== fb.record_sha256
    && fa.normalized_sha256 === fb.normalized_sha256) {
    findings.push({
      level: 'inner_records_partial',
      kind: 'conversation',
      drive_file_ids: pairIds(a, b),
      evidence: 'same_text_different_formatting',
      overlap_ratio: 1,
      shared_message_count: fa.message_count,
      action: 'needs_human_review',
    });
    return;
  }
  if (fa.record_sha256 && fa.record_sha256 === fb.record_sha256) {
    if ((fa.message_count ?? 0) === 0 && (fb.message_count ?? 0) === 0) {
      findings.push({
        level: 'inner_records_partial',
        kind: 'conversation',
        drive_file_ids: pairIds(a, b),
        evidence: 'both_transcripts_empty',
        overlap_ratio: 0,
        shared_message_count: 0,
        action: 'no_conclusion_empty_transcripts',
      });
      return;
    }
    findings.push({
      level: 'inner_records',
      kind: 'conversation',
      digest: fa.record_sha256,
      drive_file_ids: pairIds(a, b),
      evidence: 'ordered_transcript_digest_equal',
      overlap_ratio: 1,
      action: 'keep_independent_rows',
    });
    return;
  }
  const setA = stripCommon(fa._hashes ?? []);
  const setB = stripCommon(fb._hashes ?? []);
  if (setA.size === 0 || setB.size === 0) return;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let shared = 0;
  for (const hash of smaller) {
    if (larger.has(hash)) shared += 1;
  }
  if (shared === 0) return;
  const overlap = shared / smaller.size;
  // A shared handful of short replies is text similarity, not a duplicated
  // conversation; only sustained overlap is reported as an overlap candidate.
  const isOverlap = shared >= 8 && overlap >= 0.5;
  findings.push({
    level: 'inner_records_partial',
    kind: 'conversation',
    drive_file_ids: pairIds(a, b),
    evidence: overlapEvidence(isOverlap, overlap, larger.size, smaller.size),
    overlap_ratio: Number(overlap.toFixed(4)),
    shared_message_count: shared,
    action: isOverlap ? 'needs_human_review' : 'no_action_text_similarity_only',
  });
}

export function detectRecordDuplicates(results, options = {}) {
  const items = collectComparableItems(results);
  const findings = outerByteFindings(results);
  const { commonPhrases, commonThreshold } = frequentPhraseDigests(items, options);
  const stripCommon = list => new Set((list ?? []).filter(hash => !commonPhrases.has(hash)));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.kind !== b.kind) continue;
      if (a.kind === 'vcf_set') {
        compareVcfPair(a, b, findings);
        continue;
      }
      compareConversationPair(a, b, findings, stripCommon);
    }
  }
  return {
    findings,
    stats: {
      common_phrase_digests: commonPhrases.size,
      common_phrase_threshold_files: commonThreshold,
      compared_records: items.length,
    },
  };
}

/** Aggregated, PII-free numbers for the report and CI job summaries. */
export function buildAggregateSummary(results, findings) {
  const tally = newAggregateTally(results.length);
  const convDigests = new Set();
  for (const res of results) {
    tallyFileResult(tally, res, convDigests);
  }
  tally.unique_conversation_digests = convDigests.size;
  tallyFindings(tally, findings);
  return tally;
}

function newAggregateTally(filesTotal) {
  const names = [
    'files_processed', 'files_failed', 'zip_files', 'vcf_files', 'other_files', 'conversations',
    'messages', 'common_phrase_threshold_files', 'unique_conversation_digests', 'vcard_records',
    'vcard_complete', 'vcard_incomplete', 'vcard_needs_review', 'vcard_temporary',
    'temporary_marked_conversations', 'conversations_without_identifiable_owner',
    'body_phone_candidate_total', 'deleted_message_total', 'media_message_total',
    'encoding_non_utf8_files', 'duplicate_outer_groups', 'duplicate_inner_groups',
    'partial_overlap_pairs', 'superset_pairs', 'phrase_similarity_pairs',
    'same_formatting_difference_pairs', 'unsupported_message_total',
    'phone_only_body_message_total', 'conversations_label_name_only',
    'conversations_with_body_candidates', 'conversations_temporary',
    'archive_rejected_entries', 'archive_skipped_entries', 'unsafe_archive_flags',
  ];
  const tally = { files_total: filesTotal };
  for (const name of names) tally[name] = 0;
  return tally;
}

/** One file's contribution to the corpus tally: file shape first, then every record. */
function tallyFileResult(tally, res, convDigests) {
  const safety = res.safety ?? {};
  if (res.processing_status === 'processed') tally.files_processed += 1;
  else tally.files_failed += 1;
  if (res.content_type === 'ZIP') tally.zip_files += 1;
  else if (res.content_type === 'VCF') tally.vcf_files += 1;
  else tally.other_files += 1;
  tally.archive_rejected_entries += safety.rejected_entries ?? 0;
  tally.archive_skipped_entries += safety.skipped_entries ?? 0;
  if ((safety.issue_codes ?? []).length > 0) tally.unsafe_archive_flags += 1;
  if ((res.encoding_warnings ?? []).length > 0) tally.encoding_non_utf8_files += 1;
  for (const conv of res.records.conversations) tallyConversation(tally, conv, convDigests);
  for (const vcf of res.records.vcards) tallyVcfSet(tally, vcf);
}

function tallyConversation(tally, conv, convDigests) {
  tally.conversations += 1;
  tally.messages += conv.message_count ?? 0;
  if (conv.record_sha256) convDigests.add(conv.record_sha256);
  if (conv.temporary_mark) {
    tally.temporary_marked_conversations += 1;
    tally.conversations_temporary += 1;
  }
  if (!conv.owner_identifiable) tally.conversations_without_identifiable_owner += 1;
  tally.body_phone_candidate_total += conv.body_phone_candidate_count ?? 0;
  tally.unsupported_message_total += conv.unsupported_message_count ?? 0;
  tally.phone_only_body_message_total += conv.phone_only_body_message_count ?? 0;
  if ((conv.identity_basis ?? 'none') === 'label_name_only') tally.conversations_label_name_only += 1;
  if ((conv.body_phone_candidate_count ?? 0) > 0) tally.conversations_with_body_candidates += 1;
  tally.deleted_message_total += conv.deleted_message_count ?? 0;
  tally.media_message_total += conv.media_message_count ?? 0;
}

function tallyVcfSet(tally, vcf) {
  const t = vcf.classification_tally ?? {};
  tally.vcard_records += vcf.record_count ?? 0;
  tally.vcard_complete += t.complete_card ?? 0;
  tally.vcard_incomplete += t.incomplete_card ?? 0;
  tally.vcard_needs_review += (t.needs_human_review ?? 0);
  tally.vcard_temporary += (t.temporary_review ?? 0);
}

/** Duplicate evidence is counted by level first, then by the specific evidence kind. */
function tallyFindings(tally, findings) {
  for (const f of findings) {
    if (f.level === 'outer_bytes') {
      tally.duplicate_outer_groups += 1;
      continue;
    }
    if (f.level === 'inner_records') {
      tally.duplicate_inner_groups += 1;
      continue;
    }
    if (f.evidence === 'superset_reexport') tally.superset_pairs += 1;
    else if (f.evidence === 'conversation_overlap_candidate') tally.partial_overlap_pairs += 1;
    else if (f.evidence === 'same_text_different_formatting') tally.same_formatting_difference_pairs += 1;
    else tally.phrase_similarity_pairs += 1;
  }
}

/**
 * Builds the payload CI applies to D1: registry transitions, analysis rows and hashed
 * identity signals only — never cleartext PII.
 *
 * `pseudonymize:true` is the mode used for anything that will be committed: every row is
 * keyed by `ref` (a one-way digest of the Drive id) and no file name is included. CI
 * resolves `ref` back to the registry row inside the runner, so the repository and the job
 * logs never see an id, a name, a phone number or a transcript.
 */
function buildRegistryUpdateRow(res, key, findings) {
  return {

    ...key(res.drive_file_id),
    expected_size: res.drive_size_bytes,
    expected_modified_at: res.drive_modified_at,
    content_sha256: res.content_sha256,
    inner_content_sha256: res.inner_content_sha256,
    processing_status: res.processing_status,
    extracted_records_count: res.extracted_records_count,
    error_code: res.error_code,
    error_message: res.error_message,
    receipt_ref: receiptRef(res.content_sha256),
    metadata: {
      analysis_version: PHASE4_RULE_VERSION,
      content_type_observed: res.content_type ?? null,
      size_verified: res.download_verified,
      encoding: res.text_encoding ?? null,
      encoding_warning_count: (res.encoding_warnings ?? []).length,
      zip_entry_count: res.safety?.entry_count ?? null,
      archive_issue_codes: (res.safety?.archive_issues ?? []).slice(0, 12),
      rejected_entry_count: res.safety?.rejected_entries ?? 0,
      skipped_entry_count: res.safety?.skipped_entries ?? 0,
      traversal_risk: Boolean(res.safety?.has_traversal_risk),
      symlink_risk: Boolean(res.safety?.has_symlink_risk),
      encrypted_entries: Boolean(res.safety?.has_encrypted_entries),
      executable_entries: Boolean(res.safety?.has_executable_entries),
      nested_archive_entries: Boolean(res.safety?.has_nested_archives),
      conversation_count: res.records.conversations.length,
      vcard_set_count: res.records.vcards.length,
      duplicate_group_count: findings.filter(f => f.drive_file_ids?.includes(res.drive_file_id)).length,
    },
  
  };
}

function buildFileAnalysisRow(res) {
  return {

    drive_file_id: res.drive_file_id,
    content_kind: res.content_type ?? 'UNKNOWN',
    analysis_status: res.processing_status === 'processed' ? 'completed' : 'failed',
    size_bytes: res.size_bytes,
    drive_size_bytes: res.drive_size_bytes,
    size_verified: res.download_verified === false ? 'mismatch' : 'match',
    archive_entry_count: res.safety?.entry_count ?? 0,
    archive_text_records: res.records.conversations.length + res.records.vcards.length,
    archive_rejected_entries: res.safety?.rejected_entries ?? 0,
    archive_skipped_entries: res.safety?.skipped_entries ?? 0,
    safety_flags_json: JSON.stringify({
      issues: (res.safety?.issue_codes ?? []).slice(0, 20),
      traversal: Boolean(res.safety?.has_traversal_risk),
      symlink: Boolean(res.safety?.has_symlink_risk),
      encrypted: Boolean(res.safety?.has_encrypted_entries),
      executable: Boolean(res.safety?.has_executable_entries),
      nested: Boolean(res.safety?.has_nested_archives),
      budget_entry: Boolean(res.safety?.exceeds_entry_budget),
      budget_size: Boolean(res.safety?.exceeds_size_budget),
      suspicious_ratio_entries: res.safety?.suspicious_ratio_entries ?? 0,
      unsafe_name_entries: res.safety?.unsafe_name_entries ?? 0,
    }),
    extracted_records_count: res.extracted_records_count,
    inner_content_sha256: res.inner_content_sha256,
    message_count_total: res.records.conversations.reduce((n, c) => n + (c.message_count ?? 0), 0),
    temporary_mark_count: res.records.conversations.filter(c => c.temporary_mark).length,
    text_encoding: res.text_encoding ?? null,
    error_code: res.error_code,
    error_message: res.error_message,
    elapsed_ms: null,
  
  };
}

/**
 * One row per (file, kind, digest, provenance) plus the corpus-wide index of which files
 * carry which identity digest. `source_count` is what makes a repeated *label* visible
 * without turning it into an identity: a name present in dozens of files is a broker or a
 * marketplace tag, not a person.
 */
function buildIdentityIndex(results) {
  const identityIndex = new Map();
  const fileIdentities = [];
  const perFileSeen = new Set();
  for (const res of results) {
    for (const signal of res.identity_signals ?? []) {
      const digest = signal.phone_hash ?? signal.name_hash;
      if (!digest) continue;
      const kind = signal.phone_hash ? 'phone' : 'name';
      const attributed = signal.attributed !== false;
      const dedupeKey = `${res.drive_file_id}|${kind}|${digest}|${signal.provenance}`;
      if (!perFileSeen.has(dedupeKey)) {
        perFileSeen.add(dedupeKey);
        fileIdentities.push({ drive_file_id: res.drive_file_id, kind, digest, provenance: signal.provenance, attributed });
      }
      indexIdentitySource(identityIndex, res.drive_file_id, signal, attributed);
    }
  }
  return { fileIdentities, identities: summariseIdentityIndex(identityIndex) };
}

function indexIdentitySource(index, driveFileId, signal, attributed) {
  const key = signal.phone_hash ? `p:${signal.phone_hash}` : `n:${signal.name_hash}`;
  if (key.endsWith('null')) return;
  const list = index.get(key) ?? [];
  list.push({ drive_file_id: driveFileId, provenance: signal.provenance, attributed });
  index.set(key, list);
}

function summariseIdentityIndex(index) {
  return [...index.entries()].map(([key, sources]) => ({
    kind: key.startsWith('p:') ? 'phone' : 'name',
    digest: key.slice(2),
    source_count: new Set(sources.map(s => s.drive_file_id)).size,
    provenances: [...new Set(sources.map(s => s.provenance))].sort(),
    attributed_by_source: sources.some(s => s.attributed),
    drive_file_ids: [...new Set(sources.map(s => s.drive_file_id))].sort(),
  }));
}

export function buildPhase4Payload({ driveParentId = REGISTRY_FOLDER, results, findings, summary, scanTimestamp, files, pseudonymize = false }) {
  const ts = scanTimestamp ?? new Date().toISOString();
  const key = id => (pseudonymize ? { ref: driveRefHash(id) } : { drive_file_id: id });
  const registryUpdates = results.map(res => buildRegistryUpdateRow(res, key, findings));

  const fileAnalysis = results.map(res => buildFileAnalysisRow(res));

  const zipEntries = [];
  const conversations = [];
  const vcards = [];
  for (const res of results) {
    for (const entry of res.zip_entries ?? []) {
      zipEntries.push({ drive_file_id: res.drive_file_id, ...entry });
    }
    for (const conv of res.records.conversations) {
      // `_hashes`/`identity_signals` stay on the analysis result for record pairing; the
      // payload carries them once, through `fileIdentities`, never twice.
      conversations.push({
        drive_file_id: res.drive_file_id,
        ...omitKeys(conv, ['_hashes', 'identity_signals']),
      });
    }
    for (const vcf of res.records.vcards) {
      for (const card of vcf.records) {
        vcards.push({
          drive_file_id: res.drive_file_id,
          entry_name_sha256: vcf.entry_name_sha256,
          vcf_set_sha256: vcf.record_sha256,
          encoding: vcf.text_encoding,
          ...card,
        });
      }
    }
  }
  const { fileIdentities, identities } = buildIdentityIndex(results);
  const payload = {
    schema: PHASE4_ENVELOPE_PREFIX,
    rule_version: PHASE4_RULE_VERSION,
    drive_parent_ref: driveParentId.length > 0 ? driveRefHash(driveParentId) : null,
    scanTimestamp: ts,
    files_expected: Array.isArray(files) ? files.length : results.length,
    registryUpdates,
    fileAnalysis,
    zipEntries,
    conversations,
    vcards,
    identities,
    fileIdentities,
    duplicateFindings: findings,
    aggregate: summary,
  };
  // Content digest only: the wall clock must not change the identity of a payload, so a
  // re-run over unchanged inputs proves idempotence instead of producing a new hash.
  payload.payload_fingerprint = crypto
    .createHash('sha256')
    .update(stableStringify(payload, ['payload_fingerprint', 'scanTimestamp']))
    .digest('hex');
  return payload;
}

function stableStringify(value, omit = []) {
  const seen = new Set(omit);
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node).sort()) {
        if (seen.has(key)) continue;
        out[key] = walk(node[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export { driveRefHash, stableStringify };

export function normalizeNameForComparison(value) {
  return normalizeIdentifyingText(value);
}

export { REGISTRY_FOLDER };
