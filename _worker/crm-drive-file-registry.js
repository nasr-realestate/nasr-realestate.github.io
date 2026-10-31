// Central Google Drive File Registry Service Layer (Phase 3 — nasr-crm-test-db only).
// Pure Web-standard ES module (zero Node-only dependencies) compatible with both
// Cloudflare Workers D1 (env.DB) and node:sqlite D1 adapters in automated tests.
// Enforces idempotent metadata tracking, strict state machines, SHA-256 content
// deduplication without deletion, mandatory processing/review proofs, and zero PII in errors/logs.

export const REGISTRY_TABLE = 'crm_drive_file_registry';

export const ALLOWED_PROCESSING_STATUSES = Object.freeze([
  'discovered',
  'metadata_scanned',
  'downloaded',
  'hashed',
  'processed',
  'duplicate',
  'failed',
  'ignored',
]);

export const ALLOWED_REVIEW_STATUSES = Object.freeze([
  'not_required',
  'pending',
  'approved',
  'rejected',
  'needs_manual_review',
]);

export const ALLOWED_CONTENT_TYPES = Object.freeze([
  'VCF',
  'ZIP',
  'TXT',
  'SPREADSHEET',
  'DOCUMENT',
  'MEDIA',
  'OTHER',
  'UNKNOWN',
]);

export const PROCESSING_STATUS_TRANSITIONS = Object.freeze({
  discovered: Object.freeze(['discovered', 'metadata_scanned', 'failed', 'ignored']),
  metadata_scanned: Object.freeze(['metadata_scanned', 'downloaded', 'hashed', 'failed', 'ignored']),
  downloaded: Object.freeze(['downloaded', 'hashed', 'failed', 'ignored']),
  hashed: Object.freeze(['hashed', 'processed', 'duplicate', 'failed', 'ignored']),
  processed: Object.freeze(['processed', 'metadata_scanned', 'downloaded', 'hashed', 'failed']),
  duplicate: Object.freeze(['duplicate', 'metadata_scanned', 'hashed', 'failed', 'ignored']),
  failed: Object.freeze(['failed', 'discovered', 'metadata_scanned', 'downloaded', 'hashed', 'ignored']),
  ignored: Object.freeze(['ignored', 'metadata_scanned']),
});

export const REVIEW_STATUS_TRANSITIONS = Object.freeze({
  not_required: Object.freeze(['not_required', 'pending', 'needs_manual_review', 'approved', 'rejected']),
  pending: Object.freeze(['pending', 'needs_manual_review', 'approved', 'rejected', 'not_required']),
  needs_manual_review: Object.freeze(['needs_manual_review', 'pending', 'approved', 'rejected']),
  approved: Object.freeze(['approved', 'pending', 'needs_manual_review', 'rejected']),
  rejected: Object.freeze(['rejected', 'pending', 'needs_manual_review', 'approved']),
});

const NON_HUMAN_REVIEWERS = new Set([
  'auto',
  'system',
  'agent',
  'ai',
  'bot',
  'worker',
  'cron',
  'anonymous',
  'unknown',
  'none',
]);

const FORBIDDEN_METADATA_KEYS = new Set([
  'name',
  'customer_name',
  'client_name',
  'full_name',
  'lead_label',
  'chat_title',
  'peer_sender_name',
  'sender_name',
  'sender_label',
  'phone',
  'phones',
  'phone_key',
  'phone_number',
  'mobile',
  'tel',
  'raw_input',
  'raw_text',
  'body_text',
  'message',
  'messages',
  'chat_body',
  'excerpt',
  'vcard',
  'vcards',
  'contacts',
  'email',
  'address',
  'token',
  'access_token',
  'refresh_token',
  'access_code',
  'crm_access_code',
  'secret',
  'password',
  'authorization',
  'cookie',
  'drive_checksum_as_content',
]);

const HEX_64_RE = /^[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{2,80}$/;
const RECEIPT_REF_RE = /^[A-Za-z0-9_.:/-]{3,160}$/;

export class DriveRegistryError extends Error {
  constructor(code, technicalMessage) {
    const safeCode = ERROR_CODE_RE.test(String(code || '')) ? String(code) : 'REGISTRY_ERROR';
    const safeMsg = sanitizeTechnicalErrorMessage(technicalMessage || safeCode);
    super(`${safeCode}: ${safeMsg}`);
    this.name = 'DriveRegistryError';
    this.code = safeCode;
    this.technicalMessage = safeMsg;
  }
}

function nowIso(overrideIso) {
  if (typeof overrideIso === 'string' && overrideIso.trim().length > 0) {
    return overrideIso.trim();
  }
  return new Date().toISOString();
}

function generateRegistryId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDigitChar(ch) {
  return ch >= '0' && ch <= '9';
}

function isPhoneSeparator(ch) {
  return ch === ' ' || ch === '-' || ch === '(' || ch === ')' || ch === '.' || ch === '+';
}

// Linear-time O(n) phone-like digit sequence scrubber (zero backtracking regex).
export function scrubPhoneLikeSequences(input) {
  const str = String(input ?? '');
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (isDigitChar(str[i]) || (str[i] === '+' && i + 1 < str.length && isDigitChar(str[i + 1]))) {
      let j = i;
      let digits = 0;
      while (j < str.length && (isDigitChar(str[j]) || isPhoneSeparator(str[j]))) {
        if (isDigitChar(str[j])) digits += 1;
        j += 1;
      }
      if (digits >= 6) {
        out += '[redacted-num]';
        i = j;
        continue;
      }
    }
    out += str[i];
    i += 1;
  }
  return out;
}

function scrubTokensAndVcards(text) {
  const words = String(text ?? '').split(/\s+/);
  const cleaned = [];
  for (const rawWord of words) {
    if (!rawWord) continue;
    const upper = rawWord.toUpperCase();
    if (
      upper.startsWith('BEGIN:VCARD') ||
      upper.startsWith('END:VCARD') ||
      upper.startsWith('FN:') ||
      upper.startsWith('TEL:') ||
      upper.startsWith('TEL;') ||
      upper.startsWith('N:') ||
      upper.startsWith('EMAIL:')
    ) {
      cleaned.push('[redacted-vcard]');
      continue;
    }
    if (rawWord.includes('@') && rawWord.includes('.')) {
      cleaned.push('[redacted-email]');
      continue;
    }
    if (
      upper.startsWith('HTTP://') ||
      upper.startsWith('HTTPS://') ||
      upper.startsWith('BEARER') ||
      rawWord.startsWith('ya29.') ||
      rawWord.startsWith('ghp_') ||
      rawWord.startsWith('enc_v1.') ||
      upper.includes('ACCESS_CODE') ||
      upper.includes('SECRET') ||
      upper.includes('TOKEN=')
    ) {
      cleaned.push('[redacted-CredentialOrUrl]');
      continue;
    }
    cleaned.push(rawWord);
  }
  return cleaned.join(' ');
}

function stripQuotedLiterals(input) {
  let out = '';
  let quoteChar = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (!quoteChar && (ch === '"' || ch === "'" || ch === '«' || ch === '`')) {
      quoteChar = ch === '«' ? '»' : ch;
      out += '[redacted-literal]';
      continue;
    }
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = '';
      continue;
    }
    out += ch;
  }
  return out;
}

function replaceNonAsciiSpans(input) {
  let out = '';
  let inNonAscii = false;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      if (!inNonAscii) {
        out += ' [redacted] ';
        inNonAscii = true;
      }
    } else {
      inNonAscii = false;
      out += input[i];
    }
  }
  return out;
}

export function sanitizeTechnicalErrorMessage(rawMessage, maxLength = 280) {
  if (rawMessage === null || rawMessage === undefined) return '';
  let s = String(rawMessage);
  s = stripQuotedLiterals(s);
  s = replaceNonAsciiSpans(s);
  s = scrubTokensAndVcards(s);
  s = scrubPhoneLikeSequences(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return 'technical_failure_redacted';
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

export function sanitizeHumanReviewNote(rawNote, maxLength = 450) {
  const s0 = String(rawNote ?? '').trim();
  if (!s0) return '';
  let s = scrubTokensAndVcards(s0);
  s = scrubPhoneLikeSequences(s);
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

function sanitizeMetadataString(value) {
  const scrubbed = scrubPhoneLikeSequences(scrubTokensAndVcards(value));
  if (scrubbed !== value) {
    throw new DriveRegistryError('FORBIDDEN_PII_IN_METADATA', 'Metadata string contains personal or credential pattern');
  }
  if (value.length > 500) {
    throw new DriveRegistryError('METADATA_VALUE_TOO_LONG', 'Metadata string exceeds maximum length');
  }
  return value;
}

function sanitizeMetadataObject(obj, depth) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const normKey = String(k).trim().toLowerCase();
    if (!normKey || FORBIDDEN_METADATA_KEYS.has(normKey)) {
      throw new DriveRegistryError('FORBIDDEN_PII_IN_METADATA', 'Metadata contains forbidden personal or secret key');
    }
    if (v !== undefined) {
      out[k] = validateAndSanitizeMetadataValue(v, depth + 1);
    }
  }
  return out;
}

function validateAndSanitizeMetadataValue(value, depth = 0) {
  if (depth > 4) {
    throw new DriveRegistryError('METADATA_DEPTH_EXCEEDED', 'Metadata nesting exceeds maximum depth');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DriveRegistryError('INVALID_METADATA_NUMBER', 'Metadata number must be finite');
    }
    return value;
  }
  if (typeof value === 'string') return sanitizeMetadataString(value);
  if (Array.isArray(value)) {
    if (value.length > 50) {
      throw new DriveRegistryError('METADATA_ARRAY_TOO_LARGE', 'Metadata array exceeds maximum size');
    }
    return value.map(item => validateAndSanitizeMetadataValue(item, depth + 1));
  }
  if (typeof value === 'object') return sanitizeMetadataObject(value, depth);
  throw new DriveRegistryError('INVALID_METADATA_TYPE', 'Unsupported metadata field type');
}

export function sanitizeRegistryMetadataJson(metaInput, existingJson = '{}') {
  let base = {};
  if (typeof existingJson === 'string' && existingJson.trim()) {
    try {
      const parsed = JSON.parse(existingJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch {
      base = {};
    }
  }
  if (metaInput === undefined || metaInput === null) {
    const serializedBase = JSON.stringify(base);
    return serializedBase.length <= 8192 ? serializedBase : '{}';
  }
  const patchObj = typeof metaInput === 'string' ? JSON.parse(metaInput) : metaInput;
  if (!patchObj || typeof patchObj !== 'object' || Array.isArray(patchObj)) {
    throw new DriveRegistryError('INVALID_METADATA_OBJECT', 'Metadata must be a JSON object');
  }
  const cleanPatch = validateAndSanitizeMetadataValue(patchObj, 0);
  const merged = { ...base, ...cleanPatch };
  const serialized = JSON.stringify(merged);
  if (serialized.length > 8192) {
    throw new DriveRegistryError('METADATA_JSON_TOO_LARGE', 'Serialized metadata_json exceeds 8192 characters');
  }
  return serialized;
}

export function classifyDriveContentType(mimeType = '', fileName = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  const name = String(fileName || '').trim().toLowerCase();
  if (mime === 'text/x-vcard' || mime === 'text/vcard' || name.endsWith('.vcf')) {
    return 'VCF';
  }
  if (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'multipart/x-zip' ||
    name.endsWith('.zip')
  ) {
    return 'ZIP';
  }
  if (mime === 'text/plain' || name.endsWith('.txt')) {
    return 'TXT';
  }
  if (
    mime.includes('spreadsheet') ||
    mime === 'text/csv' ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.csv')
  ) {
    return 'SPREADSHEET';
  }
  if (
    mime.includes('document') ||
    mime === 'application/pdf' ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  ) {
    return 'DOCUMENT';
  }
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) {
    return 'MEDIA';
  }
  if (!mime && !name) {
    return 'UNKNOWN';
  }
  return 'OTHER';
}

export function validateSha256Hex(hashValue, fieldLabel = 'content_sha256') {
  if (hashValue === null || hashValue === undefined || hashValue === '') return null;
  const normalized = String(hashValue).trim().toLowerCase();
  if (!HEX_64_RE.test(normalized)) {
    throw new DriveRegistryError('INVALID_SHA256_DIGEST', `Invalid 64-hex digest for ${fieldLabel}`);
  }
  return normalized;
}

function validateDriveFileId(driveFileId) {
  const id = String(driveFileId ?? '').trim();
  if (!id || id.length > 200 || /\s/.test(id)) {
    throw new DriveRegistryError('INVALID_DRIVE_FILE_ID', 'drive_file_id must be a non-empty identifier without whitespace');
  }
  return id;
}

function validateNonEmptyString(val, code, desc) {
  const trimmed = String(val ?? '').trim();
  if (!trimmed) {
    throw new DriveRegistryError(code, desc);
  }
  return trimmed;
}

function normalizeFileSize(fileSize) {
  if (fileSize === null || fileSize === undefined || fileSize === '') return null;
  const num = typeof fileSize === 'number' ? fileSize : Number(String(fileSize).trim());
  if (!Number.isInteger(num) || num < 0) {
    throw new DriveRegistryError('INVALID_FILE_SIZE', 'file_size must be a non-negative integer or null');
  }
  return num;
}

export function assertProcessingTransitionAllowed(fromStatus, toStatus) {
  if (!ALLOWED_PROCESSING_STATUSES.includes(toStatus)) {
    throw new DriveRegistryError('INVALID_PROCESSING_STATUS', 'Target processing_status is not in allowed set');
  }
  const allowedNext = PROCESSING_STATUS_TRANSITIONS[fromStatus];
  if (!allowedNext || !allowedNext.includes(toStatus)) {
    throw new DriveRegistryError(
      'ILLEGAL_PROCESSING_TRANSITION',
      `Transition from ${fromStatus} to ${toStatus} is not permitted`,
    );
  }
}

export function assertReviewTransitionAllowed(fromStatus, toStatus) {
  if (!ALLOWED_REVIEW_STATUSES.includes(toStatus)) {
    throw new DriveRegistryError('INVALID_REVIEW_STATUS', 'Target review_status is not in allowed set');
  }
  const allowedNext = REVIEW_STATUS_TRANSITIONS[fromStatus];
  if (!allowedNext || !allowedNext.includes(toStatus)) {
    throw new DriveRegistryError(
      'ILLEGAL_REVIEW_TRANSITION',
      `Review transition from ${fromStatus} to ${toStatus} is not permitted`,
    );
  }
}

export async function getRegistryEntryByDriveFileId(db, driveFileId) {
  const cleanId = validateDriveFileId(driveFileId);
  return db
    .prepare(`SELECT * FROM ${REGISTRY_TABLE} WHERE drive_file_id = ? LIMIT 1`)
    .bind(cleanId)
    .first();
}

// Strict insert that rejects duplicate drive_file_id (proving UNIQUE enforcement).
export async function insertNewDriveFileStrict(db, input) {
  const driveFileId = validateDriveFileId(input?.drive_file_id ?? input?.driveFileId);
  const fileName = validateNonEmptyString(input?.file_name ?? input?.fileName, 'MISSING_FILE_NAME', 'file_name is required');
  const mimeType = validateNonEmptyString(input?.mime_type ?? input?.mimeType ?? 'application/octet-stream', 'MISSING_MIME_TYPE', 'mime_type is required');
  const parentId = String(input?.drive_parent_id ?? input?.driveParentId ?? '').trim();
  const drivePath = String(input?.drive_path ?? input?.drivePath ?? '/').trim() || '/';
  const fileSize = normalizeFileSize(input?.file_size ?? input?.fileSize);
  const driveCreatedAt = input?.drive_created_at ?? input?.driveCreatedAt ?? null;
  const driveModifiedAt = input?.drive_modified_at ?? input?.driveModifiedAt ?? null;
  const seenAt = nowIso(input?.last_seen_at ?? input?.lastSeenAt);
  const contentType = input?.content_type && ALLOWED_CONTENT_TYPES.includes(input.content_type)
    ? input.content_type
    : classifyDriveContentType(mimeType, fileName);
  const initialStatus = driveModifiedAt ? 'metadata_scanned' : 'discovered';
  if (input?.processing_status && input.processing_status !== initialStatus) {
    if (!['discovered', 'metadata_scanned', 'ignored'].includes(input.processing_status)) {
      throw new DriveRegistryError(
        'ILLEGAL_INITIAL_STATUS',
        'New Drive file registration cannot start in hashed, processed, or duplicate state',
      );
    }
  }
  const procStatus = input?.processing_status ?? initialStatus;
  if (procStatus === 'metadata_scanned' && !driveModifiedAt) {
    throw new DriveRegistryError('MISSING_DRIVE_MODIFIED_AT', 'metadata_scanned requires drive_modified_at');
  }
  const metadataJson = sanitizeRegistryMetadataJson(input?.metadata, '{}');
  const rowId = input?.id ? validateNonEmptyString(input.id, 'INVALID_ID', 'id must be non-empty') : generateRegistryId();

  try {
    await db.prepare(`
      INSERT INTO ${REGISTRY_TABLE} (
        id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path,
        mime_type, file_size, drive_created_at, drive_modified_at, content_type,
        processing_status, review_status, last_seen_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_required', ?, ?, ?, ?)
    `).bind(
      rowId,
      driveFileId,
      parentId,
      fileName,
      fileName,
      drivePath,
      mimeType,
      fileSize,
      driveCreatedAt ? String(driveCreatedAt).trim() : null,
      driveModifiedAt ? String(driveModifiedAt).trim() : null,
      contentType,
      procStatus,
      seenAt,
      metadataJson,
      seenAt,
      seenAt,
    ).run();
  } catch (err) {
    const raw = String(err?.message || '');
    if (raw.includes('UNIQUE') || raw.includes('constraint')) {
      throw new DriveRegistryError('DUPLICATE_DRIVE_FILE_ID', 'drive_file_id already exists or violated constraint');
    }
    throw new DriveRegistryError('DB_INSERT_FAILED', 'Database rejected new Drive file registration');
  }

  return getRegistryEntryByDriveFileId(db, driveFileId);
}

// Idempotent registration / metadata update: preserves processing history, original_file_name,
// content_sha256, processing_attempts, and human review fields across repeated executions.
export async function upsertDriveFileMetadata(db, input) {
  if (input?.content_sha256 !== undefined || input?.contentSha256 !== undefined) {
    throw new DriveRegistryError(
      'METADATA_CANNOT_SET_CONTENT_HASH',
      'Metadata scan must not set content_sha256; compute hash from actual file bytes via recordContentHash',
    );
  }
  const driveFileId = validateDriveFileId(input?.drive_file_id ?? input?.driveFileId);
  const existing = await getRegistryEntryByDriveFileId(db, driveFileId);
  if (!existing) {
    const created = await insertNewDriveFileStrict(db, input);
    return { action: 'inserted', entry: created, modifiedSinceProcessed: false };
  }

  const fileName = validateNonEmptyString(
    input?.file_name ?? input?.fileName ?? existing.file_name,
    'MISSING_FILE_NAME',
    'file_name is required',
  );
  const mimeType = validateNonEmptyString(
    input?.mime_type ?? input?.mimeType ?? existing.mime_type,
    'MISSING_MIME_TYPE',
    'mime_type is required',
  );
  const parentId = input?.drive_parent_id !== undefined || input?.driveParentId !== undefined
    ? String(input?.drive_parent_id ?? input?.driveParentId ?? '').trim()
    : existing.drive_parent_id;
  const drivePath = input?.drive_path !== undefined || input?.drivePath !== undefined
    ? (String(input?.drive_path ?? input?.drivePath ?? '/').trim() || '/')
    : existing.drive_path;
  const fileSize = input?.file_size !== undefined || input?.fileSize !== undefined
    ? normalizeFileSize(input?.file_size ?? input?.fileSize)
    : existing.file_size;
  const driveCreatedAt = (input?.drive_created_at ?? input?.driveCreatedAt)
    ? String(input?.drive_created_at ?? input?.driveCreatedAt).trim()
    : existing.drive_created_at;
  const driveModifiedAt = (input?.drive_modified_at ?? input?.driveModifiedAt)
    ? String(input?.drive_modified_at ?? input?.driveModifiedAt).trim()
    : existing.drive_modified_at;
  const seenAt = nowIso(input?.last_seen_at ?? input?.lastSeenAt);
  const contentType = classifyDriveContentType(mimeType, fileName);
  const mergedMeta = sanitizeRegistryMetadataJson(input?.metadata, existing.metadata_json);

  // Determine next processing_status without losing prior processing history:
  const promoteToScanned = Boolean(driveModifiedAt) && (
    existing.processing_status === 'discovered' ||
    (existing.processing_status === 'failed' && input?.recoverFromMetadataFailure === true)
  );
  const nextStatus = promoteToScanned ? 'metadata_scanned' : existing.processing_status;

  const clearError = nextStatus !== 'failed' && existing.processing_status === 'failed';
  const modifiedSinceProcessed = Boolean(
    existing.drive_modified_at_processed &&
    driveModifiedAt &&
    driveModifiedAt !== existing.drive_modified_at_processed,
  );

  const clearFlag = clearError ? 1 : 0;

  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET drive_parent_id = ?,
        file_name = ?,
        drive_path = ?,
        mime_type = ?,
        file_size = ?,
        drive_created_at = ?,
        drive_modified_at = ?,
        content_type = ?,
        processing_status = ?,
        error_code = CASE WHEN ? = 1 THEN NULL ELSE error_code END,
        error_message = CASE WHEN ? = 1 THEN NULL ELSE error_message END,
        last_seen_at = ?,
        metadata_json = ?,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(
    parentId,
    fileName,
    drivePath,
    mimeType,
    fileSize,
    driveCreatedAt,
    driveModifiedAt,
    contentType,
    nextStatus,
    clearFlag,
    clearFlag,
    seenAt,
    mergedMeta,
    seenAt,
    driveFileId,
  ).run();

  const updated = await getRegistryEntryByDriveFileId(db, driveFileId);
  return { action: 'updated', entry: updated, modifiedSinceProcessed };
}

export async function registerDiscoveredDriveFile(db, input) {
  return upsertDriveFileMetadata(db, input);
}

export async function touchFileLastSeen(db, { driveFileId, seenAt } = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!existing) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'Cannot update last_seen_at for unregistered drive_file_id');
  }
  const ts = nowIso(seenAt);
  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET last_seen_at = ?, updated_at = ?
    WHERE drive_file_id = ?
  `).bind(ts, ts, cleanId).run();
  return getRegistryEntryByDriveFileId(db, cleanId);
}

export async function recordContentHash(db, {
  driveFileId,
  contentSha256,
  innerContentSha256 = null,
  hashedAt,
} = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  const outerHash = validateSha256Hex(contentSha256, 'content_sha256');
  if (!outerHash) {
    throw new DriveRegistryError('MISSING_CONTENT_SHA256', 'content_sha256 is required when recording content hash');
  }
  const innerHash = validateSha256Hex(innerContentSha256, 'inner_content_sha256');
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!existing) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'drive_file_id must be registered before recording hash');
  }
  if (!existing.drive_modified_at) {
    throw new DriveRegistryError('MISSING_DRIVE_MODIFIED_AT', 'Metadata must be scanned before recording content hash');
  }

  const ts = nowIso(hashedAt);
  const unchangedProcessed = existing.processing_status === 'processed' && existing.content_sha256 === outerHash;
  const unchangedDuplicate = existing.processing_status === 'duplicate' && existing.content_sha256 === outerHash;
  let nextStatus = 'hashed';
  if (unchangedProcessed) {
    nextStatus = 'processed';
  } else if (unchangedDuplicate) {
    nextStatus = 'duplicate';
  } else {
    assertProcessingTransitionAllowed(existing.processing_status, 'hashed');
  }

  const resetDuplicateLink = nextStatus === 'hashed' ? 1 : 0;

  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET content_sha256 = ?,
        inner_content_sha256 = COALESCE(?, inner_content_sha256),
        processing_status = ?,
        duplicate_of_file_id = CASE WHEN ? = 1 THEN NULL ELSE duplicate_of_file_id END,
        error_code = NULL,
        error_message = NULL,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(outerHash, innerHash, nextStatus, resetDuplicateLink, ts, cleanId).run();

  return getRegistryEntryByDriveFileId(db, cleanId);
}

// Detects confirmed byte-level content duplicates via content_sha256 without deleting any record.
// Never uses file_size or file_name alone, and never treats ZIP files with different outer
// content_sha256 as inner-identical or inner-distinct when inner_content_sha256 is uninspected.
export async function detectAndRegisterDuplicate(db, { driveFileId, detectedAt } = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  const target = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!target) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'Target drive_file_id not found in registry');
  }
  if (!target.content_sha256) {
    return {
      isDuplicate: false,
      canonicalDriveFileId: null,
      reason: 'content_sha256_not_computed',
      entry: target,
    };
  }

  const matchesRes = await db.prepare(`
    SELECT * FROM ${REGISTRY_TABLE}
    WHERE content_sha256 = ?
    ORDER BY
      CASE WHEN processing_status = 'processed' THEN 0 ELSE 1 END ASC,
      COALESCE(drive_created_at, created_at) ASC,
      created_at ASC,
      id ASC
  `).bind(target.content_sha256).all();

  const matches = matchesRes?.results || [];
  const canonical = matches.find(row => row.drive_file_id !== cleanId && row.duplicate_of_file_id !== cleanId);
  if (!canonical) {
    return {
      isDuplicate: false,
      canonicalDriveFileId: null,
      reason: target.content_type === 'ZIP' && !target.inner_content_sha256
        ? 'unique_outer_sha256_zip_inner_deferred'
        : 'unique_content_sha256',
      entry: target,
    };
  }

  // If target itself is already processed or is earlier than all non-processed peers, keep canonical deterministic:
  const firstOverall = matches[0];
  if (firstOverall && firstOverall.drive_file_id === cleanId) {
    return {
      isDuplicate: false,
      canonicalDriveFileId: cleanId,
      reason: 'target_is_canonical_source',
      entry: target,
    };
  }

  const canonicalId = firstOverall.duplicate_of_file_id || firstOverall.drive_file_id;
  if (canonicalId === cleanId) {
    return {
      isDuplicate: false,
      canonicalDriveFileId: cleanId,
      reason: 'target_is_canonical_source',
      entry: target,
    };
  }

  if (target.processing_status === 'duplicate' && target.duplicate_of_file_id === canonicalId) {
    return {
      isDuplicate: true,
      canonicalDriveFileId: canonicalId,
      reason: 'already_registered_duplicate',
      entry: target,
    };
  }

  assertProcessingTransitionAllowed(target.processing_status, 'duplicate');
  const ts = nowIso(detectedAt);
  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET processing_status = 'duplicate',
        duplicate_of_file_id = ?,
        error_code = NULL,
        error_message = NULL,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(canonicalId, ts, cleanId).run();

  const updated = await getRegistryEntryByDriveFileId(db, cleanId);
  return {
    isDuplicate: true,
    canonicalDriveFileId: canonicalId,
    reason: 'confirmed_exact_content_sha256',
    entry: updated,
  };
}

export function compareZipRecordsWithoutInnerInspection(fileA, fileB) {
  if (!fileA || !fileB) {
    throw new DriveRegistryError('MISSING_COMPARISON_TARGET', 'Both registry entries are required');
  }
  if (fileA.content_sha256 && fileB.content_sha256 && fileA.content_sha256 === fileB.content_sha256) {
    return {
      outerIdentical: true,
      confirmedDuplicate: true,
      innerComparison: 'identical_by_outer_bytes',
    };
  }
  if (fileA.content_type === 'ZIP' || fileB.content_type === 'ZIP') {
    return {
      outerIdentical: false,
      confirmedDuplicate: false,
      innerComparison: 'indeterminate_until_inner_inspection',
    };
  }
  return {
    outerIdentical: false,
    confirmedDuplicate: false,
    innerComparison: 'not_applicable',
  };
}

// Marks a file as 'processed' ONLY when verifiable processing success evidence is supplied.
export async function recordInspectionSuccess(db, {
  driveFileId,
  processedAt,
  receiptRef,
  extractedRecordsCount,
  metadataPatch,
} = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!existing) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'drive_file_id must exist before recording success');
  }
  if (!existing.content_sha256 || !HEX_64_RE.test(existing.content_sha256)) {
    throw new DriveRegistryError(
      'MISSING_PROCESSING_EVIDENCE',
      'Cannot mark file processed without verified 64-hex content_sha256',
    );
  }
  const cleanReceipt = String(receiptRef ?? '').trim();
  if (!RECEIPT_REF_RE.test(cleanReceipt)) {
    throw new DriveRegistryError(
      'MISSING_PROCESSING_EVIDENCE',
      'Cannot mark file processed without valid ASCII processing_receipt_ref',
    );
  }
  if (!Number.isInteger(extractedRecordsCount) || extractedRecordsCount < 0) {
    throw new DriveRegistryError(
      'MISSING_PROCESSING_EVIDENCE',
      'Cannot mark file processed without non-negative integer extractedRecordsCount',
    );
  }
  const cleanProcessedAt = validateNonEmptyString(
    processedAt,
    'MISSING_PROCESSING_EVIDENCE',
    'processedAt timestamp is required as processing evidence',
  );

  // Idempotent replay with identical receipt & unmodified Drive timestamp:
  if (
    existing.processing_status === 'processed' &&
    existing.processing_receipt_ref === cleanReceipt &&
    existing.drive_modified_at_processed === existing.drive_modified_at
  ) {
    return existing;
  }

  assertProcessingTransitionAllowed(existing.processing_status, 'processed');
  const mergedMeta = sanitizeRegistryMetadataJson(metadataPatch, existing.metadata_json);

  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET processing_status = 'processed',
        last_processed_at = ?,
        drive_modified_at_processed = drive_modified_at,
        processing_attempts = processing_attempts + 1,
        processing_receipt_ref = ?,
        extracted_records_count = ?,
        duplicate_of_file_id = NULL,
        error_code = NULL,
        error_message = NULL,
        metadata_json = ?,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(cleanProcessedAt, cleanReceipt, extractedRecordsCount, mergedMeta, cleanProcessedAt, cleanId).run();

  return getRegistryEntryByDriveFileId(db, cleanId);
}

// Records a metadata or processing failure with strict PII scrubbing and without inventing missing metadata.
export async function recordInspectionFailure(db, {
  driveFileId,
  driveParentId = '',
  placeholderName = '[unreadable_drive_item]',
  mimeType = 'application/octet-stream',
  errorCode,
  errorMessage,
  failedAt,
  needsManualReview = false,
} = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  const cleanCode = String(errorCode ?? '').trim();
  if (!ERROR_CODE_RE.test(cleanCode)) {
    throw new DriveRegistryError('INVALID_ERROR_CODE', 'error_code must be 2..80 ASCII code characters');
  }
  const safeErrorMsg = sanitizeTechnicalErrorMessage(errorMessage || cleanCode);
  const ts = nowIso(failedAt);
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);

  if (!existing) {
    const safePlaceholder = sanitizeTechnicalErrorMessage(placeholderName, 80) || '[unreadable_drive_item]';
    const rowId = generateRegistryId();
    const reviewStatus = needsManualReview ? 'needs_manual_review' : 'not_required';
    await db.prepare(`
      INSERT INTO ${REGISTRY_TABLE} (
        id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path,
        mime_type, file_size, drive_created_at, drive_modified_at, content_type,
        processing_status, review_status, last_seen_at, processing_attempts,
        error_code, error_message, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '/', ?, NULL, NULL, NULL, 'UNKNOWN', 'failed', ?, ?, 1, ?, ?, '{}', ?, ?)
    `).bind(
      rowId,
      cleanId,
      String(driveParentId || '').trim(),
      safePlaceholder,
      safePlaceholder,
      String(mimeType || 'application/octet-stream').trim(),
      reviewStatus,
      ts,
      cleanCode,
      safeErrorMsg,
      ts,
      ts,
    ).run();
    return getRegistryEntryByDriveFileId(db, cleanId);
  }

  assertProcessingTransitionAllowed(existing.processing_status, 'failed');
  const nextReview = needsManualReview && existing.review_status === 'not_required'
    ? 'needs_manual_review'
    : existing.review_status;

  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET processing_status = 'failed',
        review_status = ?,
        processing_attempts = processing_attempts + 1,
        error_code = ?,
        error_message = ?,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(nextReview, cleanCode, safeErrorMsg, ts, cleanId).run();

  return getRegistryEntryByDriveFileId(db, cleanId);
}

export async function transitionProcessingStatus(db, {
  driveFileId,
  toStatus,
  updatedAt,
} = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  if (!ALLOWED_PROCESSING_STATUSES.includes(toStatus)) {
    throw new DriveRegistryError('INVALID_PROCESSING_STATUS', 'Unsupported processing_status value');
  }
  if (toStatus === 'processed') {
    throw new DriveRegistryError(
      'MISSING_PROCESSING_EVIDENCE',
      'Use recordInspectionSuccess with verified evidence to transition to processed',
    );
  }
  if (toStatus === 'duplicate') {
    throw new DriveRegistryError(
      'MISSING_DUPLICATE_PROOF',
      'Use detectAndRegisterDuplicate with verified content_sha256 to transition to duplicate',
    );
  }
  if (toStatus === 'failed') {
    throw new DriveRegistryError(
      'MISSING_ERROR_CODE',
      'Use recordInspectionFailure with an explicit error_code to transition to failed',
    );
  }
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!existing) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'drive_file_id not found in registry');
  }
  assertProcessingTransitionAllowed(existing.processing_status, toStatus);
  if (toStatus === 'hashed' && !existing.content_sha256) {
    throw new DriveRegistryError('MISSING_CONTENT_SHA256', 'Cannot transition to hashed without content_sha256');
  }
  const ts = nowIso(updatedAt);
  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET processing_status = ?,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(toStatus, ts, cleanId).run();
  return getRegistryEntryByDriveFileId(db, cleanId);
}

// Records human review queue state or actual human approval/rejection decision.
export async function recordHumanReviewDecision(db, {
  driveFileId,
  reviewStatus,
  reviewer,
  reviewedAt,
  reviewNotes,
  updatedAt,
} = {}) {
  const cleanId = validateDriveFileId(driveFileId);
  if (!ALLOWED_REVIEW_STATUSES.includes(reviewStatus)) {
    throw new DriveRegistryError('INVALID_REVIEW_STATUS', 'Unsupported review_status value');
  }
  const existing = await getRegistryEntryByDriveFileId(db, cleanId);
  if (!existing) {
    throw new DriveRegistryError('DRIVE_FILE_NOT_FOUND', 'drive_file_id not found in registry');
  }
  assertReviewTransitionAllowed(existing.review_status, reviewStatus);

  if (reviewStatus === 'approved' || reviewStatus === 'rejected') {
    const cleanReviewer = String(reviewer ?? '').trim();
    if (cleanReviewer.length < 3 || NON_HUMAN_REVIEWERS.has(cleanReviewer.toLowerCase())) {
      throw new DriveRegistryError(
        'HUMAN_REVIEW_REQUIRED',
        'Transition to approved or rejected requires an explicit human reviewer identity',
      );
    }
    const cleanReviewedAt = String(reviewedAt ?? '').trim();
    if (!cleanReviewedAt) {
      throw new DriveRegistryError(
        'HUMAN_REVIEW_REQUIRED',
        'Transition to approved or rejected requires reviewedAt timestamp',
      );
    }
    const cleanNotes = sanitizeHumanReviewNote(reviewNotes);
    if (!cleanNotes) {
      throw new DriveRegistryError(
        'HUMAN_REVIEW_REQUIRED',
        'Transition to approved or rejected requires non-empty reviewNotes',
      );
    }
    const safeReviewer = sanitizeTechnicalErrorMessage(cleanReviewer, 120);
    if (safeReviewer.length < 3 || NON_HUMAN_REVIEWERS.has(safeReviewer.toLowerCase())) {
      throw new DriveRegistryError(
        'HUMAN_REVIEW_REQUIRED',
        'Human reviewer identifier must be a non-PII ASCII handle of at least 3 chars',
      );
    }
    const ts = nowIso(updatedAt ?? cleanReviewedAt);
    await db.prepare(`
      UPDATE ${REGISTRY_TABLE}
      SET review_status = ?,
          reviewed_by = ?,
          reviewed_at = ?,
          review_notes = ?,
          updated_at = ?
      WHERE drive_file_id = ?
    `).bind(reviewStatus, safeReviewer, cleanReviewedAt, cleanNotes, ts, cleanId).run();
    return getRegistryEntryByDriveFileId(db, cleanId);
  }

  const ts = nowIso(updatedAt);
  const optionalNote = reviewNotes !== undefined ? sanitizeHumanReviewNote(reviewNotes) : existing.review_notes;
  await db.prepare(`
    UPDATE ${REGISTRY_TABLE}
    SET review_status = ?,
        review_notes = ?,
        updated_at = ?
    WHERE drive_file_id = ?
  `).bind(reviewStatus, optionalNote, ts, cleanId).run();
  return getRegistryEntryByDriveFileId(db, cleanId);
}

// Extracts new, unhashed/unprocessed, failed, or Drive-modified files needing processing.
export async function listFilesNeedingProcessing(db, {
  driveParentId = null,
  limit = 200,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (driveParentId) {
    const res = await db.prepare(`
      SELECT * FROM ${REGISTRY_TABLE}
      WHERE drive_parent_id = ?
        AND review_status != 'rejected'
        AND (
          processing_status IN ('discovered', 'metadata_scanned', 'downloaded', 'hashed', 'failed')
          OR (
            processing_status = 'processed'
            AND drive_modified_at IS NOT NULL
            AND (drive_modified_at_processed IS NULL OR drive_modified_at != drive_modified_at_processed)
          )
        )
      ORDER BY COALESCE(drive_modified_at, created_at) ASC, id ASC
      LIMIT ?
    `).bind(String(driveParentId).trim(), safeLimit).all();
    return res?.results || [];
  }

  const res = await db.prepare(`
    SELECT * FROM ${REGISTRY_TABLE}
    WHERE review_status != 'rejected'
      AND (
        processing_status IN ('discovered', 'metadata_scanned', 'downloaded', 'hashed', 'failed')
        OR (
          processing_status = 'processed'
          AND drive_modified_at IS NOT NULL
          AND (drive_modified_at_processed IS NULL OR drive_modified_at != drive_modified_at_processed)
        )
      )
    ORDER BY COALESCE(drive_modified_at, created_at) ASC, id ASC
    LIMIT ?
  `).bind(safeLimit).all();
  return res?.results || [];
}

// Extracts files awaiting human review ('pending' or 'needs_manual_review').
export async function listFilesPendingHumanReview(db, {
  driveParentId = null,
  limit = 200,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (driveParentId) {
    const res = await db.prepare(`
      SELECT * FROM ${REGISTRY_TABLE}
      WHERE drive_parent_id = ?
        AND review_status IN ('pending', 'needs_manual_review')
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `).bind(String(driveParentId).trim(), safeLimit).all();
    return res?.results || [];
  }

  const res = await db.prepare(`
    SELECT * FROM ${REGISTRY_TABLE}
    WHERE review_status IN ('pending', 'needs_manual_review')
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `).bind(safeLimit).all();
  return res?.results || [];
}

// Executes a metadata-only Drive folder inventory pass (never downloads content or sets content_sha256).
export async function syncDriveFolderMetadataInventory(db, {
  driveParentId,
  items,
  scanTimestamp,
} = {}) {
  const parentId = validateNonEmptyString(
    driveParentId,
    'MISSING_PARENT_FOLDER_ID',
    'driveParentId is required for folder metadata inventory',
  );
  if (!Array.isArray(items)) {
    throw new DriveRegistryError('INVALID_INVENTORY_ITEMS', 'items must be an array');
  }
  const ts = nowIso(scanTimestamp);
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let vcfCount = 0;
  let zipCount = 0;
  let otherCount = 0;

  for (const item of items) {
    if (item?.unreachable === true) {
      await recordInspectionFailure(db, {
        driveFileId: item.drive_file_id ?? item.id,
        driveParentId: parentId,
        errorCode: item.error_code || 'DRIVE_METADATA_UNREACHABLE',
        errorMessage: item.error_message || 'Drive metadata could not be retrieved via OAuth',
        failedAt: ts,
        needsManualReview: true,
      });
      failed += 1;
      continue;
    }

    const res = await upsertDriveFileMetadata(db, {
      drive_file_id: item.drive_file_id ?? item.id,
      drive_parent_id: item.drive_parent_id ?? parentId,
      file_name: item.file_name ?? item.name,
      drive_path: item.drive_path ?? '/',
      mime_type: item.mime_type ?? item.mimeType,
      file_size: item.file_size ?? item.size,
      drive_created_at: item.drive_created_at ?? item.created_time ?? item.createdTime ?? null,
      drive_modified_at: item.drive_modified_at ?? item.modified_time ?? item.modifiedTime ?? null,
      last_seen_at: ts,
      metadata: {
        inventory_source: 'google_drive_oauth_metadata_v1',
        owned_by_me: Boolean(item.owned_by_me ?? item.ownedByMe ?? true),
        shared: Boolean(item.shared ?? false),
      },
    });
    if (res.action === 'inserted') inserted += 1;
    else updated += 1;

    if (res.entry.content_type === 'VCF') vcfCount += 1;
    else if (res.entry.content_type === 'ZIP') zipCount += 1;
    else otherCount += 1;
  }

  return {
    scannedTotal: items.length,
    inserted,
    updated,
    failed,
    byContentType: {
      VCF: vcfCount,
      ZIP: zipCount,
      OTHER: otherCount,
    },
    scanTimestamp: ts,
  };
}
