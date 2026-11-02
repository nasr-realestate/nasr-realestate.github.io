// Phase 4 tooling module — safe ZIP reading for Google Drive WhatsApp exports.
//
// HARD BOUNDARIES:
//  * Never touches the filesystem: the caller hands in bytes and receives parsed
//    entries in memory. There is no extraction path to write to, so Zip Slip /
//    path traversal cannot become a disk write by construction.
//  * Never executes, imports, or evaluates extracted content.
//  * Never imported by `_worker/crm-worker.js`; it is not part of any public
//    endpoint. Used only by offline analysis tooling and CI test jobs.
//  * No dependency outside `node:zlib` / `node:crypto`.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const S_IFDIR = 0x4000;
const S_IXANY = 0o111;

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryUncompressedBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathDepth: 8,
  maxNameBytes: 220,
  maxElapsedMs: 20000,
  allowedTextExtensions: Object.freeze(['.txt', '.vcf']),
});

/** Extensions that must never be inflated or executed, only reported. */
const NESTED_ARCHIVE_EXT = new Set([
  '.zip', '.jar', '.war', '.ear', '.apk', '.aab', '.7z', '.rar', '.gz', '.bz2',
  '.xz', '.zst', '.tgz', '.tbz2', '.cab', '.iso', '.img', '.dmg',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.bat', '.cmd', '.ps1', '.sh',
  '.apk', '.swf', '.js', '.jse', '.vbs', '.vbe', '.wsf', '.scr', '.pif',
]);

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp', '.tiff', '.svg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.aac', '.mp3', '.ogg',
  '.opus', '.wav', '.amr', '.m4a', '.pdf', '.docx', '.xlsx', '.pptx',
]);

export class ZipSafetyError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.name = 'ZipSafetyError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readU16(buf, off) {
  return buf.length < off + 2 ? null : buf.readUInt16LE(off);
}

function readU32(buf, off) {
  return buf.length < off + 4 ? null : buf.readUInt32LE(off);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (readU32(buf, i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

function decodeEntryName(rawBytes, flags) {
  if (flags & FLAG_UTF8_NAME) {
    return { name: new TextDecoder('utf-8').decode(rawBytes), utf8: true };
  }
  try {
    return { name: new TextDecoder('utf-8', { fatal: true }).decode(rawBytes), utf8: true };
  } catch {
    // Legacy DOS archives use CP437; callers must not trust this rendering.
    return { name: new TextDecoder('windows-1252').decode(rawBytes), utf8: false };
  }
}

function extensionOf(name) {
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function pathDepth(name) {
  return name.split('/').filter(seg => seg.length > 0).length;
}

/**
 * Validates one central-directory entry name against traversal and shape rules.
 * Returns an array of machine-readable issue codes (empty when safe).
 */
export function inspectEntryName(name) {
  const issues = [];
  if (name.length === 0) {
    issues.push('empty_entry_name');
    return issues;
  }
  if (name.includes('\\')) {
    issues.push('backslash_separator');
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    issues.push('absolute_path');
  }
  const segments = name.split('/');
  if (segments.some(seg => seg === '..')) {
    issues.push('dotdot_segment');
  }
  if (segments.some(seg => seg.includes('\0'))) {
    issues.push('nul_byte');
  }
  if (name.startsWith('~/') || name.startsWith('~\\')) {
    issues.push('home_relative_path');
  }
  return issues;
}

/**
 * Reads the central directory and returns entries plus a structural report.
 * Throws only for unreadable archives; unsafe-but-readable entries are
 * reported so the caller can decide to keep them as evidence.
 */
export function readZipCentralDirectory(buf, limits = {}) {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf)) {
    throw new ZipSafetyError('invalid_buffer', 'expected a Buffer of archive bytes');
  }
  if (buf.length > lim.maxArchiveBytes) {
    throw new ZipSafetyError('archive_too_large', `archive exceeds ${lim.maxArchiveBytes} bytes`);
  }
  const issues = [];
  const eocdAt = findEocd(buf);
  if (eocdAt < 0) {
    throw new ZipSafetyError('missing_end_of_central_directory', 'no EOCD signature; not a readable ZIP');
  }
  const diskNo = readU16(buf, eocdAt + 4);
  const cdDisk = readU16(buf, eocdAt + 6);
  const entryCount16 = readU16(buf, eocdAt + 10);
  let cdSize = readU32(buf, eocdAt + 12);
  let cdOffset = readU32(buf, eocdAt + 16);
  let entryCount = entryCount16;

  if (entryCount16 === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const zip64 = readZip64CentralDirectory(buf, eocdAt, issues);
    if (zip64) {
      entryCount = zip64.entryCount;
      cdSize = zip64.cdSize;
      cdOffset = zip64.cdOffset;
    }
  }
  checkCentralDirectoryShape({ buf, lim, issues, diskNo, cdDisk, entryCount, cdOffset, cdSize });

  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (readU32(buf, at) !== CENTRAL_SIG) {
      issues.push('central_directory_out_of_sync');
      break;
    }
    const versionMadeBy = readU16(buf, at + 4) ?? 0;
    const flags = readU16(buf, at + 8) ?? 0;
    const method = readU16(buf, at + 10) ?? 0;
    const crc = readU32(buf, at + 16) ?? 0;
    const compSize = readU32(buf, at + 20) ?? 0;
    const uncompSize = readU32(buf, at + 24) ?? 0;
    const nameLen = readU16(buf, at + 28) ?? 0;
    const extraLen = readU16(buf, at + 30) ?? 0;
    const commentLen = readU16(buf, at + 32) ?? 0;
    const extAttrs = readU32(buf, at + 38) ?? 0;
    const localOffset = readU32(buf, at + 42) ?? 0;
    const nameStart = at + 46;
    if (nameStart + nameLen + extraLen + commentLen > buf.length) {
      issues.push('truncated_central_entry');
      break;
    }
    const rawName = buf.subarray(nameStart, nameStart + nameLen);
    const { name, utf8 } = decodeEntryName(rawName, flags);
    const unixMode = (versionMadeBy >>> 8) === 3 ? (extAttrs >>> 16) & 0xffff : 0;
    const extraStart = nameStart + nameLen;
    const entry = {
      index: i,
      name,
      nameSha256: sha256Hex(rawName),
      nameUtf8: utf8,
      nameBytes: rawName.length,
      extension: extensionOf(name),
      depth: pathDepth(name),
      flags,
      method,
      crc32: crc,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      externalAttributes: extAttrs,
      unixMode,
      localHeaderOffset: localOffset,
      extraFieldsBytes: extraLen,
      commentBytes: commentLen,
      isDirectory: name.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR,
      isSymlink: (unixMode & S_IFMT) === S_IFLNK,
      isExecutable: (unixMode & S_IXANY) !== 0,
      isEncrypted: (flags & FLAG_ENCRYPTED) !== 0,
      nameIssues: inspectEntryName(name),
      issues: [],
    };
    assessEntryPolicy(entry, lim, versionMadeBy);
    entries.push(entry);
    at = extraStart + extraLen + commentLen;
  }

  const totalUncompressed = entries.reduce((sum, e) => sum + (e.uncompressedSize || 0), 0);
  if (totalUncompressed > lim.maxTotalUncompressedBytes) {
    issues.push('uncompressed_total_exceeds_limit');
  }
  return { entries, issues, entryCount, totalUncompressedBytes: totalUncompressed, cdOffset, cdSize };
}

/** The ZIP64 end-of-central-directory record, when the 32-bit fields are saturated. */
function readZip64CentralDirectory(buf, eocdAt, issues) {
  const locator = eocdAt - 20;
  if (locator < 0 || readU32(buf, locator) !== EOCD64_LOCATOR_SIG) {
    issues.push('zip64_markers_unresolved');
    return null;
  }
  const eocd64 = Number(readU32(buf, locator + 8)) + Number(readU32(buf, locator + 4) * 0x100000000);
  if (readU32(buf, eocd64) !== EOCD64_SIG) {
    issues.push('zip64_locator_without_zip64_eocd');
    return null;
  }
  return {
    entryCount: Number(readU32(buf, eocd64 + 32)),
    cdSize: Number(readU32(buf, eocd64 + 40)),
    cdOffset: Number(readU32(buf, eocd64 + 48)),
  };
}

/** Structural sanity of the central directory: any of these means "do not trust the list". */
function checkCentralDirectoryShape({ buf, lim, issues, diskNo, cdDisk, entryCount, cdOffset, cdSize }) {
  if (diskNo !== cdDisk) {
    issues.push('multi_disk_archive');
  }
  if (entryCount > lim.maxEntries) {
    issues.push('too_many_entries');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipSafetyError('truncated_central_directory', 'central directory extends past end of file');
  }
}



const ENTRY_ISSUE_RULES_BEFORE_METHOD = [
  ['entry_name_too_long', (entry, lim) => entry.nameBytes > lim.maxNameBytes],
  ['path_depth_exceeded', (entry, lim) => entry.depth > lim.maxPathDepth],
  ['non_utf8_entry_name', entry => !entry.nameUtf8],
  ['encrypted_entry', entry => entry.isEncrypted],
  ['symlink_entry', entry => entry.isSymlink],
  ['directory_entry', entry => entry.isDirectory],
  ['executable_mode', entry => entry.isExecutable],
];

const ENTRY_ISSUE_RULES_AFTER_METHOD = [
  ['entry_uncompressed_too_large', (entry, lim) => entry.uncompressedSize > lim.maxEntryUncompressedBytes],
  ['compression_ratio_suspicious', (entry, lim) => looksLikeZipBomb(entry, lim)],
  ['nested_archive_or_binary_not_expected', entry => NESTED_ARCHIVE_EXT.has(entry.extension)],
];

/** Deflate ratios far beyond text norms are the classic decompression-bomb signature. */
function looksLikeZipBomb(entry, lim) {
  if (entry.uncompressedSize <= 1024 || entry.compressedSize <= 0) return false;
  return entry.uncompressedSize / entry.compressedSize > lim.maxCompressionRatio;
}

function collectIssueCodes(entry, lim, rules) {
  const out = [];
  for (const [code, test] of rules) {
    if (test(entry, lim)) out.push(code);
  }
  return out;
}

/**
 * Flags every entry, including the ones that will be skipped: a symlink or an encrypted
 * member is recorded as evidence even when it is never inflated. Order is stable so the
 * same archive always yields the same digest.
 */
const BLOCKED_ENTRY_REASONS = [
  code => code.startsWith('name_'),
  code => code === 'symlink_entry',
  code => code === 'encrypted_entry',
  code => code === 'executable_mode',
  code => code === 'nested_archive_or_binary_not_expected',
  code => code.startsWith('unsupported_method_'),
  code => code === 'entry_uncompressed_too_large',
  code => code === 'compression_ratio_suspicious',
  code => code === 'path_depth_exceeded',
];

/** Codes that mean "this member is never inflated", in stable entry order. */
function blockedReasonsFor(entry) {
  const out = [];
  for (const code of entry.issues) {
    if (BLOCKED_ENTRY_REASONS.some(test => test(code))) out.push(code);
  }
  return out;
}

/** Inflate then verify: a CRC mismatch is a corrupt member, never a partial result. */
function inflateAndVerify(buf, entry, lim) {
  let data;
  try {
    data = inflateEntry(buf, entry, lim);
  } catch (err) {
    return { ok: false, reason: err instanceof ZipSafetyError ? err.code : 'inflate_failed' };
  }
  if (crc32(data) !== entry.crc32) {
    return { ok: false, reason: 'crc32_mismatch' };
  }
  return { ok: true, data };
}

function skipEntry(skipped, entry) {
  skipped.push({
    index: entry.index,
    nameSha256: entry.nameSha256,
    extension: entry.extension,
    reason: MEDIA_EXT.has(entry.extension) ? 'media_attachment_not_parsed' : 'entry_kind_not_allowed',
    bytes: entry.uncompressedSize,
  });
}

/** Accepted payloads are recorded with their own digest; nothing is written to disk. */
function acceptRecord(accepted, entry, data) {
  accepted.push({
    index: entry.index,
    name: entry.name,
    nameSha256: entry.nameSha256,
    extension: entry.extension,
    bytes: data,
    sha256: sha256Hex(data),
    sizeBytes: data.length,
    startsWithZipSignature: startsWithZipPayload(data),
  });
}

function startsWithZipPayload(data) {
  return data.length > 3 && data[0] === 0x50 && data[1] === 0x4b;
}

function rejectEntry(rejected, entry, reasons) {
  rejected.push({ index: entry.index, nameSha256: entry.nameSha256, extension: entry.extension, reasons });
}

function clockOf(options) {
  return typeof options.now === 'function' ? options.now() : Date.now();
}

function assessEntryPolicy(entry, lim, versionMadeBy) {
  const creator = versionMadeBy >>> 8;
  const issues = [];
  if (creator !== 0 && creator !== 3 && creator !== 20) {
    issues.push(`creator_os_${creator}`);
  }
  issues.push(...collectIssueCodes(entry, lim, ENTRY_ISSUE_RULES_BEFORE_METHOD));
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    issues.push(`unsupported_method_${entry.method}`);
  }
  issues.push(...collectIssueCodes(entry, lim, ENTRY_ISSUE_RULES_AFTER_METHOD));
  for (const issue of entry.nameIssues) {
    issues.push(`name_${issue}`);
  }
  entry.issues = issues;
}

function inflateEntry(buf, entry, lim) {
  const local = entry.localHeaderOffset;
  if (readU32(buf, local) !== LOCAL_SIG) {
    throw new ZipSafetyError('local_header_signature_mismatch', `entry ${entry.index}`);
  }
  const localNameLen = readU16(buf, local + 26) ?? 0;
  const localExtraLen = readU16(buf, local + 28) ?? 0;
  const dataStart = local + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ZipSafetyError('truncated_entry_data', `entry ${entry.index}`);
  }
  const raw = buf.subarray(dataStart, dataEnd);
  if (entry.method === METHOD_STORE) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new ZipSafetyError('stored_size_mismatch', `entry ${entry.index}`);
    }
    return raw;
  }
  try {
    // maxOutputLength makes decompression-bomb protection atomic: it aborts
    // before the inflated bytes can grow past the configured ceiling.
    return zlib.inflateRawSync(raw, { maxOutputLength: lim.maxEntryUncompressedBytes + 1 });
  } catch (err) {
    if (err && /maxOutputLength|buffersize|zlib/i.test(String(err.message || ''))) {
      throw new ZipSafetyError('inflate_limit_or_corruption', `entry ${entry.index}: ${err.name}`);
    }
    throw new ZipSafetyError('inflate_failed', `entry ${entry.index}`);
  }
}

/**
 * In-memory extraction of only the allowed record formats (TXT / VCF).
 * Returns accepted payloads, rejected entries with codes, and counters.
 * Nothing is written to disk and nothing is executed.
 */
export function extractAllowedRecords(buf, options = {}) {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...options.limits };
  const startedAt = clockOf(options);
  const allowed = new Set(lim.allowedTextExtensions);
  const report = readZipCentralDirectory(buf, lim);
  if (report.entryCount > lim.maxEntries) {
    // Refuse the whole container rather than partially inflating an anomalous archive.
    throw new ZipSafetyError('too_many_entries', `archive declares ${report.entryCount} entries above the ${lim.maxEntries} cap`);
  }
  const accepted = [];
  const rejected = [];
  const skipped = [];
  let inflatedBytes = 0;

  for (const entry of report.entries) {
    const elapsed = clockOf(options) - startedAt;
    if (elapsed > lim.maxElapsedMs) {
      report.issues.push('extraction_time_budget_exceeded');
      break;
    }
    if (entry.isDirectory) {
      skipped.push({ index: entry.index, reason: 'directory_entry' });
      continue;
    }
    const blocked = blockedReasonsFor(entry);
    if (blocked.length > 0) {
      rejected.push({ index: entry.index, nameSha256: entry.nameSha256, extension: entry.extension, reasons: blocked });
      continue;
    }
    if (!allowed.has(entry.extension)) {
      skipEntry(skipped, entry);
      continue;
    }
    const inflated = inflateAndVerify(buf, entry, lim);
    if (!inflated.ok) {
      rejectEntry(rejected, entry, [inflated.reason]);
      continue;
    }
    const data = inflated.data;
    inflatedBytes += data.length;
    if (inflatedBytes > lim.maxTotalUncompressedBytes) {
      report.issues.push('uncompressed_total_exceeds_limit');
      break;
    }
    acceptRecord(accepted, entry, data);
  }

  return {
    entries: report.entries,
    accepted,
    rejected,
    skipped,
    archiveIssues: report.issues,
    entryCount: report.entryCount,
    totalUncompressedBytes: report.totalUncompressedBytes,
    inflatedBytes,
    elapsedMs: clockOf(options) - startedAt,
  };
}

/** Any of these three name shapes means the writer tried to escape the extraction root. */
const TRAVERSAL_ISSUES = ['name_dotdot_segment', 'name_absolute_path', 'name_backslash_separator'];

const SAFETY_FLAG_RULES = [
  ['symlink_entry', 'has_symlink_risk', 'symlink_entry'],
  ['encrypted_entry', 'has_encrypted_entries', 'encrypted_entry'],
  ['executable_mode', 'has_executable_entries', 'executable_entry'],
  ['nested_archive_or_binary_not_expected', 'has_nested_archives', 'nested_archive'],
];

/** Per-entry safety verdict: a flag on the archive plus a machine-readable code. */
function tallyEntrySafety(summary, codes, entry) {
  const issueSet = new Set(entry.issues || []);
  if (TRAVERSAL_ISSUES.some(issue => issueSet.has(issue))) {
    summary.has_traversal_risk = true;
    codes.add('zip_slip_attempt');
  }
  for (const [issue, flag, code] of SAFETY_FLAG_RULES) {
    if (issueSet.has(issue)) {
      summary[flag] = true;
      codes.add(code);
    }
  }
  if (issueSet.has('compression_ratio_suspicious')) {
    summary.suspicious_ratio_entries += 1;
  }
  if ([...issueSet].some(c => c.startsWith('name_'))) {
    summary.unsafe_name_entries += 1;
  }
  if (MEDIA_EXT.has(entry.extension)) {
    summary.media_only_entries += 1;
  }
}

/** Machine-readable safety verdict for a whole archive, independent of extraction. */
export function assessArchiveSafety(archive, limits = {}) {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const codes = new Set(archive.archiveIssues || []);
  const textEntries = archive.entries.filter(e => (e.extension === '.txt' || e.extension === '.vcf'));
  const summary = {
    structurally_readable: true,
    entry_count: archive.entries.length,
    text_record_entries: textEntries.length,
    rejected_entries: (archive.rejected || []).length,
    skipped_entries: (archive.skipped || []).length,
    has_traversal_risk: false,
    has_symlink_risk: false,
    has_encrypted_entries: false,
    has_executable_entries: false,
    has_nested_archives: false,
    exceeds_entry_budget: archive.entries.length > lim.maxEntries,
    exceeds_size_budget: (archive.totalUncompressedBytes || 0) > lim.maxTotalUncompressedBytes,
    suspicious_ratio_entries: 0,
    unsafe_name_entries: 0,
    media_only_entries: 0,
  };
  for (const entry of archive.entries) {
    tallyEntrySafety(summary, codes, entry);
  }
  for (const item of archive.accepted || []) {
    if (item.startsWithZipSignature) {
      codes.add('embedded_archive_signature_in_text');
    }
  }
  summary.issue_codes = [...codes].sort();
  summary.safe_for_in_memory_parsing =
    !summary.has_traversal_risk &&
    !summary.has_symlink_risk &&
    summary.unsafe_name_entries === 0 &&
    summary.exceeds_entry_budget === false &&
    summary.exceeds_size_budget === false;
  return summary;
}
