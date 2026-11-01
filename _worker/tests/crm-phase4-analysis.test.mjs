// Phase 4 (analysis / extraction / matching without import) — synthetic unit tests.
// Everything below runs against an in-memory SQLite DB built from the CRM migrations and
// uses only synthetic fixture data. No real Drive content, name, phone number or
// transcript ever appears in this file (CRM_DATA_GOVERNANCE.md §2.2, §3, §5.4).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_ZIP_LIMITS,
  ZipSafetyError,
  assessArchiveSafety,
  crc32,
  extractAllowedRecords,
  inspectEntryName,
  readZipCentralDirectory,
} from '../crm-safe-archive.js';
import {
  buildConversationFingerprint,
  classifyIdentityBasis,
  classifyTranscriptOwnership,
  classifyVcardCard,
  compareConversationFingerprints,
  decodeMaybeText,
  detectMarkers,
  findPhoneCandidatesInText,
  nameHash,
  normalizeIdentifyingText,
  parsePhoneAnyScope,
  parseTimestamp,
  parseVcfCards,
  parseWhatsAppTranscript,
  phoneHash,
  canonicalPhoneKey,
} from '../crm-wa-vcard-analysis.js';
import {
  analyzeDriveFile,
  buildAggregateSummary,
  buildPhase4Payload,
  detectRecordDuplicates,
  driveRefHash,
  pseudonymizePayload,
} from '../crm-drive-analysis-pipeline.js';
import {
  OPERATIONAL_CRM_TABLES,
  PHASE4_ANALYSIS_TABLES,
  assertPiiFreePayload,
  buildCrmMatchIndex,
  buildOperationalCountQueries,
  resolvePayloadRefs,
  buildPhase4Statements,
  classifyFileMatches,
  partitionPayloadByRegistry,
} from '../crm-phase4-analysis-store.js';
import {
  recordContentHash,
  recordInspectionFailure,
  recordInspectionSuccess,
  registerDiscoveredDriveFile,
} from '../crm-drive-file-registry.js';

const ALL_CRM_MIGRATIONS = [
  '0001_crm_opportunities.sql',
  '0002_crm_internal_auth.sql',
  '0003_crm_push_notifications.sql',
  '0004_crm_tracks_core.sql',
  '0005_sync_audit_and_intelligence.sql',
  '0006_decouple_opportunities_and_contact_levels.sql',
  '0007_crm_drive_file_registry.sql',
  '0008_crm_phase4_analysis.sql',
];

function wrapD1(sqlite) {
  const makeStmt = (sql, values = []) => ({
    bind: (...next) => makeStmt(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => sqlite.prepare(sql).run(...values),
    _exec: () => sqlite.prepare(sql).run(...values),
  });
  return {
    prepare: sql => makeStmt(sql),
    batch: async statements => {
      sqlite.exec('SAVEPOINT p4_batch');
      try {
        const out = statements.map(s => s._exec());
        sqlite.exec('RELEASE p4_batch');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK TO p4_batch');
        sqlite.exec('RELEASE p4_batch');
        throw err;
      }
    },
  };
}

async function createIsolatedDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT, title TEXT,
      property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
      bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT
    );
  `);
  for (const mig of ALL_CRM_MIGRATIONS) {
    const sql = await readFile(new URL(`../migrations/${mig}`, import.meta.url), 'utf8');
    sqlite.exec('BEGIN TRANSACTION');
    sqlite.exec(sql);
    sqlite.exec('COMMIT');
  }
  return { sqlite, db: wrapD1(sqlite) };
}

/* ── synthetic ZIP writer (STORED + DEFLATE, tamperable) ───────────────────── */

function localHeader({ name, data, method, crc, compressedSize, uncompressedSize, flags = 0 }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(flags, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0x5555, 12);
  head.writeUInt32LE(crc >>> 0, 14);
  head.writeUInt32LE(compressedSize >>> 0, 18);
  head.writeUInt32LE(uncompressedSize >>> 0, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, data]);
}

function centralRecord({ name, data, method, crc, flags = 0, extraMode, localOffset, compressedSize, uncompressedSize }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(0x031e, 4); // made by: unix | zip 3.0
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(flags, 8);
  head.writeUInt16LE(method, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(0x5555, 14);
  head.writeUInt32LE(crc >>> 0, 16);
  head.writeUInt32LE((compressedSize ?? data.length) >>> 0, 20);
  head.writeUInt32LE((uncompressedSize ?? data.length) >>> 0, 24);
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  head.writeUInt32LE(((extraMode ?? 0o100644) << 16) >>> 0, 38);
  head.writeUInt32LE(localOffset >>> 0, 42);
  return Buffer.concat([head, nameBuf]);
}

/**
 * Builds a minimal but spec-valid ZIP from `{ name, text?, data?, mode?, method? }`
 * entries. `data`/`mode` make it possible to plant symlink, executable, nested-archive
 * and lying-size entries without shipping any real archive.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    let raw = entry.data ?? Buffer.from(entry.text ?? '', 'utf8');
    let payload = raw;
    if (method === 8) payload = deflateRawSync(raw, { level: 9 });
    const record = {
      name: entry.name,
      method,
      crc: entry.crc ?? crc32(raw),
      data: payload,
      flags: entry.flags ?? 0,
      extraMode: entry.mode,
      localOffset: offset,
      compressedSize: entry.compressedSize ?? payload.length,
      uncompressedSize: entry.uncompressedSize ?? raw.length,
    };
    const local = localHeader({
      name: record.name,
      data: record.data,
      method,
      crc: record.crc,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      flags: record.flags,
    });
    locals.push(local);
    centrals.push(centralRecord(record));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const SYNTH_TS = '2026-11-01T00:00:00Z';

function synthTranscript(messages, { sender = 'عميل تجريبي', date = '05/06/2026' } = {}) {
  return messages
    .map((body, i) => `${date}، ${String(10 + (i % 8))}:${String(10 + i).padStart(2, '0')} م - ${sender}: ${body}`)
    .join('\n');
}

function synthVcf(cards) {
  return cards.map(card => [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${card.name ?? ''}`,
    `N:${card.name ?? ''};;;;`,
    ...(card.phones ?? []).map(p => `TEL;type=CELL;waid=201012345678:${p}`),
    ...(card.photo ? [`PHOTO;BASE64:${Buffer.from(card.photo).toString('base64')}`] : []),
    'END:VCARD',
  ].join('\r\n')).join('\r\n') + '\r\n';
}

function bytesSize(res) {
  return Number.isFinite(res?.size_bytes) ? res.size_bytes : 1;
}

function synthPayload(overrides = {}) {
  return {
    schema: 'p4ana_v1',
    rule_version: 'p4a-v1',
    driveParentId: 'synth_folder',
    scanTimestamp: SYNTH_TS,
    files_expected: 1,
    payload_fingerprint: 'f'.repeat(64),
    fileAnalysis: [{
      drive_file_id: 'synth_file_1',
      content_kind: 'ZIP',
      analysis_status: 'completed',
      size_bytes: 4096,
      drive_size_bytes: 4096,
      size_verified: 'match',
      archive_entry_count: 1,
      archive_text_records: 1,
      archive_rejected_entries: 0,
      archive_skipped_entries: 0,
      safety_flags_json: '{}',
      extracted_records_count: 1,
      message_count_total: 3,
      temporary_mark_count: 0,
      error_code: null,
      error_message: null,
    }],
    zipEntries: [],
    conversations: [{
      drive_file_id: 'synth_file_1',
      record_sha256: 'a'.repeat(64),
      message_count: 3,
      temporary_mark: false,
      identity_basis: 'label_name_only',
      identity_confidence: 'low',
    }],
    vcards: [],
    identities: [],
    fileIdentities: [],
    duplicateFindings: [],
    aggregate: { files_total: 1, files_processed: 1, files_failed: 0 },
    ...overrides,
  };
}

test('1. حظر Zip Slip والمسارات المطلقة والروابط الرمزية والأرشيفات المتداخلة والملفات التنفيذية', () => {
  const evil = buildZip([
    { name: 'chat.txt', text: synthTranscript(['مرحبا']) },
    { name: '../escape.txt', text: 'x' },
    { name: '/etc/passwd', text: 'x' },
    { name: '..\\win\\escape.txt', text: 'x' },
    { name: 'a/b/c/d/e/f/g/h/deep.txt', text: 'x' },
    { name: 'link.vcf', mode: 0o120777, text: 'x' },
    { name: 'run.exe', text: 'x' },
    { name: 'inner.zip', data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]) },
    { name: 'photo.jpg', text: 'not-really' },
    { name: '\u0000nul.txt', text: 'x' },
  ]);
  const archive = extractAllowedRecords(evil);
  assert.equal(archive.accepted.length, 1, 'only the safe chat.txt may be inflated');
  assert.equal(archive.accepted[0].name, 'chat.txt');
  const reasons = archive.rejected.flatMap(r => r.reasons);
  assert.ok(reasons.includes('name_dotdot_segment'), 'relative traversal blocked');
  assert.ok(reasons.includes('name_absolute_path'), 'absolute path blocked');
  assert.ok(reasons.includes('name_backslash_separator'), 'backslash separator blocked');
  assert.ok(reasons.includes('name_nul_byte'), 'NUL byte blocked');
  assert.ok(reasons.includes('path_depth_exceeded'), 'path depth capped');
  assert.ok(reasons.includes('symlink_entry'), 'symlink blocked');
  assert.ok(reasons.includes('nested_archive_or_binary_not_expected'), 'exe + nested zip blocked');
  assert.ok(archive.skipped.some(s => s.reason === 'media_attachment_not_parsed'), 'media is reported, never parsed');
  const safety = assessArchiveSafety(archive, DEFAULT_ZIP_LIMITS);
  assert.equal(safety.has_traversal_risk, true);
  assert.equal(safety.has_symlink_risk, true);
  assert.equal(safety.has_executable_entries, true);
  assert.equal(safety.has_nested_archives, true);
  assert.ok(archive.accepted.every(a => a.bytes.includes('مرحبا')), 'nothing blocked was inflated');
  assert.deepEqual(inspectEntryName('photos/../../x.txt').filter(i => i === 'dotdot_segment'), ['dotdot_segment']);
});

test('2. قنبلة ZIP: حد الحجم الكلي ونسبة الانضغاط وعدد المدخلات تُوقف التفكيك', () => {
  const payload = 'ا'.repeat(12 * 1024 * 1024);
  const bomb = buildZip([
    { name: 'huge.txt', text: payload, method: 8 },
    { name: 'huge2.txt', text: payload, method: 8 },
    { name: 'huge3.txt', text: payload, method: 8 },
  ]);
  assert.ok(bomb.length < 4 * 1024 * 1024, 'fixture stays small while declaring gigabytes');
  const tight = extractAllowedRecords(bomb, {
    limits: { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 8 * 1024 * 1024, maxEntryUncompressedBytes: 4 * 1024 * 1024 },
  });
  assert.equal(tight.accepted.length, 0, 'every oversized entry is refused before inflation completes');
  assert.ok(tight.archiveIssues.length > 0, 'archive-level budget breach is recorded');
  const ratio = buildZip([
    { name: 'ratio.txt', text: 'A'.repeat(2 * 1024 * 1024), method: 8, uncompressedSize: 2 * 1024 * 1024 },
  ]);
  const ratioCheck = readZipCentralDirectory(ratio, { ...DEFAULT_ZIP_LIMITS, maxCompressionRatio: 1, maxEntryUncompressedBytes: 16 * 1024 * 1024 });
  assert.ok(ratioCheck.entries[0].issues.includes('compression_ratio_suspicious'), 'absurd ratio flagged');
  const tooMany = buildZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, text: `content ${i}` })));
  assert.throws(
    () => extractAllowedRecords(tooMany, { limits: { ...DEFAULT_ZIP_LIMITS, maxEntries: 4 } }),
    err => err instanceof ZipSafetyError && err.code === 'too_many_entries',
    'entry count capped',
  );
});

test('3. ملف تالف أو غير مكتمل: فشل موثوق برمز خطأ ولا صفوف تحليل', async () => {
  const good = buildZip([{ name: 'chat.txt', text: synthTranscript(['رسالة أولى']) }]);
  const cases = [
    ['truncated', good.subarray(0, Math.floor(good.length / 2))],
    ['empty', Buffer.alloc(0)],
    ['garbage', Buffer.from('هذا ليس أرشيفاً على الإطلاق')],
    ['bad_crc', buildZip([{ name: 'chat.txt', text: synthTranscript(['رسالة أولى']), crc: 1234 }])],
  ];
  const { db, sqlite } = await createIsolatedDb();
  for (const [label, bytes] of cases) {
    await registerDiscoveredDriveFile(db, {
      drive_file_id: `drv_${label}`,
      drive_parent_id: 'synth_folder',
      file_name: `synth_${label}`,
      mime_type: 'application/zip',
      file_size: bytes.length,
      drive_modified_at: SYNTH_TS,
      last_seen_at: SYNTH_TS,
    });
    const res = analyzeDriveFile({
      driveFileId: `drv_${label}`,
      fileName: `synth_${label}`,
      mimeType: 'application/zip',
      driveMeta: { size: bytes.length, modified_time: SYNTH_TS },
      bytes,
    });
    assert.equal(res.processing_status, 'failed', `${label}: must not silently succeed`);
    assert.ok(/^[A-Z0-9_]+$/.test(res.error_code), `${label}: machine error code present (${res.error_code})`);
    assert.equal(res.records.conversations.length, 0, `${label}: no records fabricated`);
    assert.equal(res.inner_content_sha256, null, `${label}: no inner digest invented`);
    assert.ok(!String(res.error_message).includes('synth_'), 'error message carries no file name');
    const failed = await recordInspectionFailure(db, {
      driveFileId: `drv_${label}`,
      errorCode: res.error_code,
      errorMessage: res.error_message,
      failedAt: SYNTH_TS,
    });
    assert.equal(failed.processing_status, 'failed');
  }
  const rows = sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_archive_entry').get().c;
  assert.equal(rows, 0, 'a failed file contributes no archive inventory rows');
});

test('4. التطابق على مستوى الملف الخارجي يختلف عن التطابق داخل المحادثة: لا يُحذف أي ملف', async () => {
  const inner = synthTranscript(['عرض سعر', 'المعاينة الأحد', 'تم الحجز']);
  const a = analyzeDriveFile({
    driveFileId: 'drv_dup_a',
    fileName: 'دردشة تجريبي أ',
    mimeType: 'application/zip',
    driveMeta: { size: 1, modified_time: SYNTH_TS },
    bytes: buildZip([{ name: 'chat.txt', text: inner }]),
  });
  const b = analyzeDriveFile({
    driveFileId: 'drv_dup_b',
    fileName: 'دردشة تجريبي ب',
    mimeType: 'application/zip',
    driveMeta: { size: 1, modified_time: SYNTH_TS },
    bytes: buildZip([{ name: '_chat.txt', text: inner, method: 8 }]),
  });
  const c = analyzeDriveFile({
    driveFileId: 'drv_dup_c',
    fileName: 'دردشة تجريبي ج',
    mimeType: 'application/zip',
    driveMeta: { size: 1, modified_time: SYNTH_TS },
    bytes: buildZip([{ name: 'chat.txt', text: inner }]),
  });
  assert.notEqual(a.content_sha256, b.content_sha256, 'outer bytes differ (name/method differ) although content is identical');
  assert.equal(a.content_sha256, c.content_sha256, 'byte-identical files share the outer digest');
  assert.equal(a.records.conversations[0].record_sha256, b.records.conversations[0].record_sha256, 'inner transcript digest equal');
  const dup = detectRecordDuplicates([a, b, c]);
  const innerDupes = dup.findings.filter(f => f.level === 'inner_records' && f.kind === 'conversation');
  const outerDupes = dup.findings.filter(f => f.level === 'outer_bytes');
  assert.equal(outerDupes.length, 1, 'exactly one outer byte-duplicate group (a,c)');
  assert.equal(innerDupes.length, 3, 'all three pairs are inner duplicates (a-b, a-c, b-c)');
  assert.equal(new Set(innerDupes.flatMap(f => f.drive_file_ids)).size, 3);
  const summary = buildAggregateSummary([a, b, c], dup.findings);
  assert.equal(summary.duplicate_outer_groups, 1);
  assert.equal(summary.duplicate_inner_groups, 3);
  // Registry consequence: duplicates are recorded, never deleted, and lineage is not
  // asserted for an inner-only duplicate.
  const { db } = await createIsolatedDb();
  for (const res of [a, b]) {
    await registerDiscoveredDriveFile(db, {
      drive_file_id: res.drive_file_id,
      drive_parent_id: 'synth_folder',
      file_name: res.file_name,
      mime_type: 'application/zip',
      file_size: bytesSize(res),
      drive_modified_at: SYNTH_TS,
      last_seen_at: SYNTH_TS,
    });
    const hashed = await recordContentHash(db, {
      driveFileId: res.drive_file_id,
      contentSha256: res.content_sha256,
      innerContentSha256: res.inner_content_sha256,
      hashedAt: SYNTH_TS,
    });
    assert.equal(hashed.processing_status, 'hashed');
    assert.equal(hashed.inner_content_sha256, res.inner_content_sha256);
  }
});

test('5. تكرار جزئي للمحادثة: استنتاج «تراكب» وليس «نسخة طبق الأصل»', () => {
  const shared = ['سعر الوحدة كام', 'المساحة ١٤٠', 'الدور الرابع', 'التشطيب سوبر ديلوكس', 'المقدم ٢٠٪', 'الاستلام ٢٠٢٨', 'فيه تقسيط؟'];
  const parsedShort = parseWhatsAppTranscript(synthTranscript(shared));
  const parsedLong = parseWhatsAppTranscript(synthTranscript([...shared, 'حجزنا معاينة', 'تمت المعاينة', 'ارسل الايميل', 'سجلت البيانات', 'بانتظار الموافقة', 'وافقت الإدارة', 'تم التوقيع']));
  const cmp = compareConversationFingerprints(parsedShort.fingerprint, parsedLong.fingerprint);
  assert.equal(cmp.comparable, true);
  assert.equal(cmp.identical, false, 'a superset is never reported as identical');
  assert.ok(cmp.shared_message_count >= 5, 'shared content is quantified');
  assert.equal(cmp.overlap_ratio, 1, 'the shorter transcript is fully contained');
  assert.ok(cmp.only_in_first_count === 0 && cmp.only_in_second_count >= 6);
  assert.ok(['contained_within', 'heavy_overlap'].includes(cmp.verdict), `verdict=${cmp.verdict}`);
  const unrelated = parseWhatsAppTranscript(synthTranscript(['رسالة مختلفة تمامًا', 'موضوع آخر', 'لا توجد رسالة مشتركة']));
  const cmp2 = compareConversationFingerprints(parsedShort.fingerprint, unrelated.fingerprint);
  assert.equal(cmp2.shared_message_count, 0);
  assert.equal(cmp2.verdict, 'different');
});

test('6. ترميز العربية: تطابق الأرقام الهندية والتشكيل وعلامات الاتجاه وحالات الألف والياء', () => {
  const variants = [
    'أحمد محمد علي',
    'أحمدُ محمدُ عليُ',
    'احمد محمد على',
    '‎أحمد محمد علي‏',
    '  أحمد   محمد  علي ',
  ];
  const normalized = variants.map(v => normalizeIdentifyingText(v));
  assert.equal(new Set(normalized).size, 1, `diacritics/alif/ya/ta-marbuta/bidi/space folded: ${normalized.join('|')}`);
  assert.equal(new Set(variants.map(v => nameHash(v))).size, 1);
  assert.notEqual(nameHash('أحمد محمد علي'), nameHash('أحمد محمد عليان'), 'a different person is never collapsed');
  const digits = '٠١٢٣٤٥٦٧٨٩';
  assert.equal(normalizeIdentifyingText(digits), '0123456789');
  const cp1256 = Buffer.from([0xc7, 0xe3, 0xed, 0xe1]); // «عجم» in windows-1256-ish bytes, not valid UTF-8
  const decoded = decodeMaybeText(cp1256);
  assert.ok(decoded.encoding !== 'utf-8', `non-UTF8 bytes are reported as ${decoded.encoding}, not silently mangled`);
  assert.ok(decoded.warnings.length >= 0);
  const bom = decodeMaybeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BEGIN:VCARD', 'utf8')]));
  assert.equal(bom.text.startsWith('BEGIN:VCARD'), true, 'BOM stripped');
  const utf16 = decodeMaybeText(Buffer.concat([Buffer.alloc(8), Buffer.from('BEGIN:VCARD', 'utf16le'), Buffer.alloc(8)]));
  assert.equal(utf16.encoding, 'utf-16le', 'UTF-16LE without BOM detected from the NUL pattern');
  assert.ok(utf16.text.includes('BEGIN:VCARD'));
});

test('7. أرقام الهاتف المصرية: صيغ متعددة ببصمة واحدة، والصيغ غير الصالحة مرفوضة', () => {
  const forms = [
    '+201012345678',
    '01012345678',
    '0020 10 1234 5678',
    '+20 (10) 1234-5678',
    '٠١٠١٢٣٤٥٦٧٨',
    'tel:+201012345678',
    '201012345678',
    '+20 10 1234 5678 تحويله 12',
  ];
  const hashes = forms.map(f => phoneHash(f));
  assert.equal(new Set(hashes).size, 1, 'all written forms collapse to one canonical digest');
  assert.equal(canonicalPhoneKey('01012345678'), '201012345678');
  for (const bad of ['', '010123', '+2010123456789012345', 'not a phone', '+20 2 1234 5678 cell']) {
    const parsed = parsePhoneAnyScope(bad);
    assert.ok(!parsed.ok || parsed.scope !== 'egypt_mobile', `never presented as an Egyptian mobile: ${bad}`);
  }
  assert.equal(phoneHash('010123'), null, 'too-short number yields no digest');
  const inText = findPhoneCandidatesInText('رقمني 01012345678 أو ‎+20 10 1234 5678 ونفس الرقم ٠١٠١٢٣٤٥٦٧٨', 10);
  assert.equal(inText.length, 1, 'repeated number in one body is counted once');
  assert.equal(inText[0].e164, '+201012345678');
});

test('8. تحليل نص المحادثة: الطابع الزمني، الأسطر المتابعة، وحذف الوسائط بدون تضخيم العدد', () => {
  const text = [
    '05/06/2026، ١٠:٢٢ ص - عميل تجريبي: هل توجد وحدة بحرية؟',
    '05/06/2026، ١٠:٢٣ ص - عميل تجريبي: <تم استبعاد الوسائط>',
    '05/06/2026، ١٠:٢٤ ص - سمسار: التواصل عبر 01012345678',
    '05/06/2026، ١٠:٢٥ ص - عميل تجريبي: تم حذف هذه الرسالة',
    '05/06/2026، ١٠:٢٦ ص - عميل تجريبي: سطر أول',
    'سطر ثانٍ من نفس الرسالة',
    '05/06/2026، ١٠:٢٧ م - : الرسائل مشفرة من طرف إلى طرف',
  ].join('\n');
  const parsed = parseWhatsAppTranscript(text);
  assert.equal(parsed.format, 'dash_android');
  assert.equal(parsed.stats.messages_total, 5, 'the encryption notice is a system line, not a message');
  assert.equal(parsed.stats.raw_message_blocks, 6);
  assert.equal(parsed.stats.system_lines, 1);
  assert.equal(parsed.stats.continuation_lines, 1);
  assert.equal(parsed.stats.unparsed_lines, 0);
  assert.equal(parsed.stats.unsupported_messages, 1, 'omitted-media placeholder counted as media/unsupported');
  assert.equal(parsed.stats.deleted_messages, 1);
  assert.equal(parsed.stats.ambiguous_date_lines, 5, 'dd<=12 and mm<=12 is flagged, not silently resolved');
  assert.equal(parsed.first_iso_date, '2026-06-05');
  assert.equal(parseTimestamp('5/6/2026', '10:22 م').iso, '2026-06-05', 'day-first dates and PM hour');
  assert.equal(parseTimestamp('2026/06/05', '10:22').iso, '2026-06-05');
  assert.equal(parseTimestamp('31/12/2026', null).ambiguous, false, 'an unambiguous day needs no caveat');
  assert.equal(parsed.identity.body_phone_candidate_hashes.length, 1, 'number found in text is a candidate only');
  const basis = classifyIdentityBasis(parsed);
  assert.equal(basis.basis, 'body_candidate_only', 'never upgraded to a phone identity');
  assert.equal(basis.confidence, 'low');
  const air = classifyTranscriptOwnership(parsed, '✈ دردشة مؤقتة 🔴');
  assert.equal(air.temporary, true);
  assert.deepEqual(air.status_colors, ['red']);
  assert.ok(air.reasons.includes('airplane_temporary_mark'));
  assert.deepEqual(detectMarkers('عادي 🟢').status_colors, ['green']);
  assert.equal(detectMarkers('عادي').temporary, false);
});

test('9. بطاقات vCard: كاملة/ناقصة/مؤقتة ✈/رقم أجنبي — والصورة تُحوَّل إلى طول فقط', () => {
  const vcf = synthVcf([
    { name: 'عميل كامل', phones: ['+201012345678'] },
    { name: 'عميل بلا رقم', phones: [] },
    { name: '✈ مؤقت', phones: ['+201199999999'] },
    { name: 'عميل أجنبي', phones: ['+218911234567'] },
    { name: '', phones: ['+201255555555'] },
    { name: 'عميل بصورة', phones: ['+201012345678'], photo: 'x'.repeat(4096) },
  ]);
  const { cards, orphanIssues } = parseVcfCards(vcf);
  assert.equal(cards.length, 6);
  assert.deepEqual(orphanIssues, []);
  const verdicts = cards.map(card => ({ card, ...classifyVcardCard(card) }));
  assert.equal(verdicts[0].classification, 'complete_card');
  assert.equal(verdicts[1].classification, 'incomplete_card', 'no normalizable phone → incomplete, not dropped');
  assert.equal(verdicts[2].classification, 'temporary_review', 'airplane marker forces review');
  assert.ok(verdicts[2].reasons.includes('airplane_temporary_mark'));
  assert.equal(verdicts[3].classification, 'needs_human_review', 'foreign number is out of scope, never guessed');
  assert.ok(verdicts[3].reasons.includes('non_egyptian_number_in_scope'));
  assert.equal(verdicts[4].classification, 'incomplete_card', 'phone without a display name is incomplete');
  assert.ok(verdicts[4].reasons.includes('no_display_name'));
  assert.ok(verdicts[5].card.binary_payload_bytes >= 4096, 'photo reduced to an encoded byte count');
  assert.equal(verdicts[5].card.properties === undefined, true, 'parsed property list is not retained');
  assert.ok(!JSON.stringify(cards).includes('xxxxxxxx'), 'no binary payload material is retained');
  assert.equal(new Set(cards.map(c => c.fn_hash).filter(Boolean)).size, 5, 'distinct names stay distinct');
  // Truncated stream must be visible as a structural problem.
  const broken = parseVcfCards(`${vcf}\r\nBEGIN:VCARD\r\nFN:بطاقة بلا نهاية\r\n`);
  const brokenCard = broken.cards[broken.cards.length - 1];
  assert.ok(brokenCard.structure_issues.includes('unterminated_card'));
  assert.equal(classifyVcardCard(brokenCard).classification, 'needs_human_review');
  // Duplicate detection by digest, never by name similarity.
  const twin = parseVcfCards(synthVcf([{ name: 'عميل كامل', phones: ['01012345678'] }]));
  assert.equal(cards[0].phone_hashes[0], twin.cards[0].phone_hashes[0], 'same number in another spelling is the same identity');
  assert.equal(cards[0].fn_hash, twin.cards[0].fn_hash);
});

test('10. عدم دمج الأسماء المتشابهة وعدم نسب رقم من النص إلى صاحب المحادثة', () => {
  const index = buildCrmMatchIndex({
    contacts: [
      { id: 'c1', name: 'أحمد محمد علي' },
      { id: 'c2', name: 'أحمد محمد عليان' },
      { id: 'c3', name: 'عميل مشترك' },
      { id: 'c4', name: 'عميل مشترك' },
    ],
    phones: [
      { contact_id: 'c1', phone_key: '201011111111', is_primary: 1 },
      { contact_id: 'c2', phone_key: '201022222222', is_primary: 1 },
      { contact_id: 'c3', phone_key: '201033333333', is_primary: 1 },
      { contact_id: 'c4', phone_key: '201033333333', is_primary: 0 },
    ],
  });
  const exact = classifyFileMatches({
    payload: synthPayload({
      fileIdentities: [{ drive_file_id: 'synth_file_1', kind: 'phone', digest: phoneHash('01011111111'), provenance: 'vcard_tel', attributed: true }],
    }),
    driveFileId: 'synth_file_1',
    index,
  });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].match_class, 'exact_match');
  assert.equal(exact[0].crm_contact_id, 'c1');
  assert.equal(exact[0].auto_link, 0);

  const ambiguousPhone = classifyFileMatches({
    payload: synthPayload({
      fileIdentities: [{ drive_file_id: 'synth_file_1', kind: 'phone', digest: phoneHash('01033333333'), provenance: 'vcard_tel', attributed: true }],
    }),
    driveFileId: 'synth_file_1',
    index,
  });
  assert.deepEqual(ambiguousPhone.map(r => r.match_class).sort(), ['conflict', 'conflict'], 'one number on two contacts is a conflict');
  assert.deepEqual([...new Set(ambiguousPhone.map(r => r.crm_contact_id))].sort(), ['c3', 'c4'], 'both contacts kept, none merged');

  const nameOnly = classifyFileMatches({
    payload: synthPayload({
      fileIdentities: [{ drive_file_id: 'synth_file_1', kind: 'name', digest: nameHash('أحمد محمد عليان'), provenance: 'archive_label_name', attributed: false }],
    }),
    driveFileId: 'synth_file_1',
    index,
  });
  assert.equal(nameOnly.length, 1);
  assert.equal(nameOnly[0].match_class, 'name_only_match');
  assert.equal(nameOnly[0].crm_contact_id, 'c2', 'exact normalized-name equality only');
  assert.equal(nameOnly[0].confidence, 'low');

  const bodyNumber = classifyFileMatches({
    payload: synthPayload({
      fileIdentities: [{ drive_file_id: 'synth_file_1', kind: 'phone', digest: phoneHash('010111111111'), provenance: 'body_text_candidate', attributed: false }],
    }),
    driveFileId: 'synth_file_1',
    index,
  });
  assert.equal(bodyNumber[0].match_class, 'third_party_review', 'a number inside chat text never becomes an exact match');
  assert.ok(!bodyNumber.some(r => r.match_class === 'exact_match'));
  assert.ok(bodyNumber.every(r => r.crm_contact_id === 'c1' || r.crm_contact_id === null), 'flagged for review with the contact that owns the number noted');

  const nothing = classifyFileMatches({ payload: synthPayload(), driveFileId: 'synth_file_1', index });
  assert.equal(nothing[0].match_class, 'unmatched');
  assert.equal(nothing[0].crm_contact_id, null, 'unmatched keeps contact_id NULL');

  const tempFile = synthPayload({
    conversations: [{
      drive_file_id: 'synth_file_1',
      record_sha256: 'a'.repeat(64),
      message_count: 3,
      temporary_mark: true,
      identity_basis: 'label_name_only',
      identity_confidence: 'low',
    }],
  });
  const tempRows = classifyFileMatches({ payload: tempFile, driveFileId: 'synth_file_1', index });
  assert.ok(tempRows.some(r => r.match_class === 'temporary_review'), 'airplane-marked conversation goes to temporary review');
});

test('11. حواجز قاعدة البيانات: لا auto_link ولا نسبة رقم من نص، وأعمدة PII غير موجودة أصلًا', async () => {
  const { sqlite } = await createIsolatedDb();
  const columns = new Map();
  for (const table of PHASE4_ANALYSIS_TABLES) {
    const info = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    assert.ok(info.length > 0, `${table} exists`);
    columns.set(table, info.map(c => c.name));
  }
  const forbidden = /(^|_)(raw_?text|chat_?body|body_?text|full_?name|customer_?name|contact_?name|phone_?key|tel_value|vcard_?text|email|address|token|secret)(_|$)/i;
  const safeCounter = /(_count|_length|_present|_hash|_digest|_bytes|_json|_at|_id)$/;
  for (const [table, names] of columns) {
    const hits = names.filter(n => forbidden.test(n) && !safeCounter.test(n));
    assert.deepEqual(hits, [], `${table} declares no PII column (found ${hits.join(',')})`);
  }
  const ddl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='crm_drive_match_candidate'").get().sql;
  assert.ok(/auto_link\s+INTEGER NOT NULL DEFAULT 0 CHECK \(auto_link = 0\)/.test(ddl), 'auto_link pinned to 0 by the schema');
  const signalDdl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='crm_drive_identity_signal'").get().sql;
  assert.ok(/provenance != 'body_text_candidate' OR attributed = 0/.test(signalDdl), 'body-text numbers cannot be attributed');
  assert.ok(/match_class != 'exact_match'/.test(ddl), 'exact_match requires an attributable phone signal');
});

test('12. تنفيذ التحليل على قاعدة معزولة: صفوف قابلة للتكرار بدون مضاعفة النتائج', async () => {
  const { db, sqlite } = await createIsolatedDb();
  const bytes = buildZip([
    { name: 'chat.txt', text: synthTranscript(['هل تتوفر وحدة؟', 'نعم الدور الرابع', 'أرسل لي الرقم', 'رقمي 01012345678'], { sender: 'عميل تجريبي' }) },
    { name: 'card.vcf', text: synthVcf([{ name: 'عميل تجريبي', phones: ['+201012345678'] }]) },
  ]);
  for (const id of ['synth_file_1', 'synth_file_2']) {
    await registerDiscoveredDriveFile(db, {
      drive_file_id: id,
      drive_parent_id: 'synth_folder',
      file_name: `synth_${id}`,
      mime_type: 'application/zip',
      file_size: 512,
      drive_modified_at: SYNTH_TS,
      last_seen_at: SYNTH_TS,
    });
  }
  const res = analyzeDriveFile({
    driveFileId: 'synth_file_1',
    fileName: 'synth_file_1',
    mimeType: 'application/zip',
    driveMeta: { size: bytes.length, modified_time: SYNTH_TS },
    bytes,
  });
  assert.equal(res.processing_status, 'processed', 'pipeline speaks the registry vocabulary');
  assert.equal(res.records.conversations.length, 1);
  assert.equal(res.records.vcards.length, 1);
  assert.ok(res.inner_content_sha256, 'inner digest derived from parsed records');
  const dup = detectRecordDuplicates([res]);
  const payload = buildPhase4Payload({
    driveParentId: 'synth_folder',
    results: [res],
    findings: dup.findings,
    summary: buildAggregateSummary([res], dup.findings),
    scanTimestamp: SYNTH_TS,
    files: ['synth_file_1'],
  });
  assert.doesNotThrow(() => assertPiiFreePayload(payload), 'pipeline payload is PII-shaped-clean');
  const index = buildCrmMatchIndex({
    contacts: [{ id: 'c1', name: 'عميل تجريبي' }],
    phones: [{ contact_id: 'c1', phone_key: '201012345678', is_primary: 1 }],
  });
  const before = buildOperationalCountQueries().map(q => ({ table: q.table, c: sqlite.prepare(q.sql).get().c }));
  const run1 = buildPhase4Statements({ payload, index, runKey: 'run_synth_1', now: SYNTH_TS });
  for (const s of run1.statements) await db.prepare(s.sql).bind(...s.params).run();
  const countsAfter1 = PHASE4_ANALYSIS_TABLES.map(t => ({ t, c: sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c }));
  const run2 = buildPhase4Statements({ payload, index, runKey: 'run_synth_1', now: SYNTH_TS });
  for (const s of run2.statements) await db.prepare(s.sql).bind(...s.params).run();
  const countsAfter2 = PHASE4_ANALYSIS_TABLES.map(t => ({ t, c: sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c }));
  assert.deepEqual(countsAfter2, countsAfter1, 'a rerun of the same payload changes no row counts');
  assert.ok(countsAfter1.find(r => r.t === 'crm_drive_file_analysis').c >= 1);
  assert.ok(countsAfter1.find(r => r.t === 'crm_wa_conversation').c >= 1);
  assert.ok(countsAfter1.find(r => r.t === 'crm_vcard_record').c >= 1);
  assert.ok(countsAfter1.find(r => r.t === 'crm_drive_identity_signal').c >= 2, 'phone + name signals persisted');
  const matched = sqlite.prepare("SELECT match_class, crm_contact_id, confidence FROM crm_drive_match_candidate WHERE drive_file_id = 'synth_file_1'").all();
  assert.ok(matched.some(r => r.match_class === 'exact_match' && r.crm_contact_id === 'c1'), 'vCard TEL digest matched the primary CRM phone');
  const after = buildOperationalCountQueries().map(q => ({ table: q.table, c: sqlite.prepare(q.sql).get().c }));
  assert.deepEqual(after, before, 'operational CRM tables are byte-for-byte unchanged by Phase 4 writes');
  assert.throws(() => sqlite.prepare("UPDATE crm_drive_match_candidate SET auto_link = 1").run(), /CHECK constraint failed/, 'schema refuses any auto-linking');
  assert.throws(
    () => sqlite.prepare(`INSERT INTO crm_drive_identity_signal
      (drive_file_id, signal_kind, signal_digest, provenance, attributed, source_file_count, analyzed_at)
      VALUES ('synth_file_1','phone','${'a'.repeat(64)}','body_text_candidate',1,1,'${SYNTH_TS}')`).run(),
    /CHECK constraint failed/,
    'schema refuses attributing a number scraped from message text',
  );
  const row = sqlite.prepare("SELECT * FROM crm_drive_file_analysis WHERE drive_file_id='synth_file_1'").get();
  assert.equal(row.size_verified, 'match');
  assert.equal(row.analysis_status, 'completed');
  assert.ok(!JSON.stringify(row).includes('01012345678'), 'no cleartext number persisted anywhere');
  const hashed = await recordContentHash(db, {
    driveFileId: 'synth_file_1',
    contentSha256: res.content_sha256,
    innerContentSha256: res.inner_content_sha256,
    hashedAt: SYNTH_TS,
  });
  assert.equal(hashed.processing_status, 'hashed');
  const ok = await recordInspectionSuccess(db, {
    driveFileId: 'synth_file_1',
    processedAt: SYNTH_TS,
    receiptRef: `p4a:sha256:${res.content_sha256.slice(0, 32)}`,
    extractedRecordsCount: res.extracted_records_count,
    metadataPatch: { analysis_version: 'p4a-v1', content_type_observed: 'ZIP' },
  });
  assert.equal(ok.processing_status, 'processed');
  assert.equal(ok.extracted_records_count, res.extracted_records_count);
  const registryRow = sqlite.prepare("SELECT processing_status, content_sha256, inner_content_sha256, extracted_records_count, metadata_json FROM crm_drive_file_registry WHERE drive_file_id='synth_file_1'").get();
  assert.equal(registryRow.content_sha256, res.content_sha256);
  assert.ok(!JSON.stringify(registryRow).includes('01012345678'), 'registry metadata stays free of cleartext numbers');
});

test('13. حِزم متعددة داخل ملف واحد: كل سجل يُنسب لمُدخله، والمُدخلات المرفوضة تُسجَّل ولا تُفسَّر', () => {
  const bytes = buildZip([
    { name: 'Chat1.txt', text: synthTranscript(['رسالة أولى']) },
    { name: 'Chat2.txt', text: synthTranscript(['رسالة ثانية'], { sender: 'عميل ثانٍ' }) },
    { name: 'contacts.vcf', text: synthVcf([{ name: 'عميل كامل', phones: ['+201012345678'] }]) },
    { name: '../../evil.txt', text: 'محتوى غير مسموح' },
  ]);
  const res = analyzeDriveFile({
    driveFileId: 'synth_multi',
    fileName: 'synth_multi',
    mimeType: 'application/zip',
    driveMeta: { size: bytes.length, modified_time: SYNTH_TS },
    bytes,
  });
  assert.equal(res.records.conversations.length, 2);
  assert.equal(res.records.vcards.length, 1);
  assert.equal(res.safety.rejected_entries, 1, 'the traversal entry is recorded as rejected');
  assert.equal(res.safety.entry_count, 4);
  assert.equal(res.extracted_records_count, 3, '1 vCard + 2 conversations');
  assert.ok(res.safety.entry_shapes.every(e => /^[0-9a-f]{64}$/.test(e.name_sha256)), 'entry names are only digests');
  assert.ok(!JSON.stringify(res.safety).includes('evil.txt'), 'rejected entry name never echoed in cleartext');
  assert.notEqual(res.records.conversations[0].record_sha256, res.records.conversations[1].record_sha256);
});

test('14. تشابه النصوص لا يُقرأ تكراراً: عبارة متكررة في محادثات كثيرة تُستبعد منقرانات التطابق', () => {
  const boiler = ['شكرا جزيلا', 'تمام', 'حاضر'];
  const results = Array.from({ length: 8 }, (_, i) => analyzeDriveFile({
    driveFileId: `drv_n${i}`,
    fileName: `chat_${i}`,
    mimeType: 'application/zip',
    driveMeta: { size: 10, modified_time: SYNTH_TS },
    bytes: buildZip([{ name: 'chat.txt', text: synthTranscript([...boiler, `موضوع مختلف ${i} أ`, `موضوع مختلف ${i} ب`, `موضوع مختلف ${i} ج`]) }]),
  }));
  const dup = detectRecordDuplicates(results);
  const summary = buildAggregateSummary(results, dup.findings);
  assert.equal(summary.duplicate_inner_groups, 0, 'sharing three boilerplate phrases is not duplication');
  assert.equal(dup.stats.common_phrase_digests, 3, 'the repeated phrases are recognised as common and excluded');
  assert.equal(summary.partial_overlap_pairs, 0);
  assert.ok(dup.findings.every(f => f.evidence !== 'ordered_transcript_digest_equal'));
});

test('15. حارس عدم تسريب PII في الحِزمة يرفض الحقول والأرقام صريحة', () => {
  assert.throws(
    () => assertPiiFreePayload({ conversations: [{ full_name: 'عميل' }] }),
    /PII_SHAPE_DETECTED/,
    'a name-shaped key is refused',
  );
  assert.throws(
    () => assertPiiFreePayload({ fileAnalysis: [{ error_message: 'تعذر تحليل 01012345678' }] }),
    /PII_SHAPE_DETECTED/,
    'a phone inside a free-text field is refused',
  );
  assert.throws(
    () => assertPiiFreePayload({ vcards: [{ raw_text: 'BEGIN:VCARD' }] }),
    /PII_SHAPE_DETECTED/,
    'raw vCard text is refused',
  );
  assert.doesNotThrow(() => assertPiiFreePayload(synthPayload()));
  const payload = synthPayload({ identities: [{ kind: 'phone', digest: phoneHash('01012345678'), source_count: 1, provenances: ['vcard_tel'], drive_file_ids: ['synth_file_1'] }] });
  assert.doesNotThrow(() => assertPiiFreePayload(payload), 'digests are the allowed form of identity');
});

test('16. حزام الأمان: لا استيراد ولا ربط تلقائي في أي جدول تشغيلي، والجداول الجديدة فقط هي القابلة للكتابة', async () => {
  const src = await readFile(new URL('../crm-phase4-analysis-store.js', import.meta.url), 'utf8');
  const touched = new Set((src.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+crm_[a-z_]+/g) ?? [])
    .map(fragment => fragment.split(/\s+/).pop()));
  for (const table of touched) {
    assert.ok(PHASE4_ANALYSIS_TABLES.includes(table), `store writes only Phase 4 tables (found ${table})`);
  }
  for (const table of OPERATIONAL_CRM_TABLES) {
    assert.ok(!touched.has(table), `operational table ${table} is never a write target`);
  }
  const { sqlite } = await createIsolatedDb();
  const rows = sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_analysis').get().c;
  assert.equal(rows, 0, 'a fresh isolated database starts with no Phase 4 analysis rows');
});

test('17. الحِزمة القابلة للت Commit: مراجع أحادية الاتجاه بدل المعرّفات والأسماء، وفكّها يفشل عند الشك', () => {
  const bytes = buildZip([{ name: 'chat.txt', text: synthTranscript(['رسالة واحدة'], { sender: 'عميل تجريبي' }) }]);
  const res = analyzeDriveFile({
    driveFileId: 'drvREALid0000000000000000000000abc',
    fileName: 'دردشة في واتساب مع عميل حقيقي جدا',
    mimeType: 'application/zip',
    driveMeta: { size: bytes.length, modified_time: SYNTH_TS },
    bytes,
  });
  const dup = detectRecordDuplicates([res]);
  const full = buildPhase4Payload({
    driveParentId: 'synth_folder',
    results: [res],
    findings: dup.findings,
    summary: buildAggregateSummary([res], dup.findings),
    scanTimestamp: SYNTH_TS,
    files: [res.drive_file_id],
  });
  const committable = pseudonymizePayload(full);
  const serialized = JSON.stringify(committable);
  assert.ok(!serialized.includes('drive_file_id'), 'no cleartext Drive id survives pseudonymization');
  assert.ok(!serialized.includes(res.drive_file_id), 'the real id itself is absent');
  assert.ok(!serialized.includes('عميل حقيقي'), 'no file name survives pseudonymization');
  assert.ok(/^[0-9a-f]{64}$/.test(committable.fileAnalysis[0].ref), 'rows are keyed by a 64-hex ref');
  assert.doesNotThrow(() => assertPiiFreePayload(committable), 'the committable payload passes the PII guard');
  assert.notEqual(driveRefHash(res.drive_file_id), res.drive_file_id, 'ref is one-way');
  assert.equal(driveRefHash(res.drive_file_id), committable.fileAnalysis[0].ref);

  const registryRows = [{ drive_file_id: res.drive_file_id, file_name: res.file_name }];
  const resolved = resolvePayloadRefs({ payload: committable, registryRows });
  assert.equal(resolved.fileAnalysis[0].drive_file_id, res.drive_file_id, 'ref resolves back inside the runner only');
  assert.equal(resolved.registryUpdates[0].file_name, res.file_name, 'the name is re-attached from D1, never from Git');

  assert.throws(
    () => resolvePayloadRefs({ payload: committable, registryRows: [] }),
    /REF_UNRESOLVED/,
    'an unresolvable ref aborts the run instead of guessing a row',
  );
  assert.throws(
    () => resolvePayloadRefs({ payload: committable, registryRows: [...registryRows, { drive_file_id: res.drive_file_id, file_name: 'x' }] }),
    /REF_AMBIGUOUS/,
    'a ref matching two rows aborts',
  );
});

test('18. ملف ظهر بعد آخر جرد: صفوفه تُؤجَّل ولا تُطبَّق، والعدد معلن لCI', () => {
  const bytes = buildZip([{ name: 'chat.txt', text: synthTranscript(['رسالة أولى'], { sender: 'طرف تجريبي' }) }]);
  const registered = analyzeDriveFile({
    driveFileId: 'drvRegistered00000000000000000000001',
    fileName: 'دردشة مسجلة',
    mimeType: 'application/zip',
    driveMeta: { size: bytes.length, modified_time: SYNTH_TS },
    bytes,
  });
  const latecomer = analyzeDriveFile({
    driveFileId: 'drvNotRegistered000000000000000000002',
    fileName: 'دردشة جديدة غير مسجلة',
    mimeType: 'text/x-vcard',
    driveMeta: { size: 1, modified_time: SYNTH_TS },
    bytes: Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n', 'utf8'),
  });
  const results = [registered, latecomer];
  const dup = detectRecordDuplicates(results);
  const payload = pseudonymizePayload(buildPhase4Payload({
    driveParentId: 'synth_folder',
    results,
    findings: dup.findings,
    summary: buildAggregateSummary(results, dup.findings),
    scanTimestamp: SYNTH_TS,
    files: results.map(r => r.drive_file_id),
  }));
  assert.equal(payload.fileAnalysis.length, 2, 'the committable payload covers both files');
  const registryRows = [{ drive_file_id: registered.drive_file_id, file_name: registered.file_name }];
  const partitioned = partitionPayloadByRegistry({ payload, registryRows });
  assert.deepEqual(partitioned.deferredRefs, [latecomer ? driveRefHash(latecomer.drive_file_id) : null].filter(Boolean));
  assert.equal(partitioned.payload.fileAnalysis.length, 1, 'only the registered file survives partitioning');
  assert.equal(partitioned.payload.files_expected, 1);
  assert.equal(partitioned.payload.registryUpdates.length, 1);
  assert.throws(() => resolvePayloadRefs({ payload, registryRows }), /REF_UNRESOLVED/, 'the raw resolver still fails closed on the late file');
  const resolved = resolvePayloadRefs({ payload: partitioned.payload, registryRows });
  assert.equal(resolved.fileAnalysis[0].drive_file_id, registered.drive_file_id);
  assert.equal(resolved.conversations.length, 1);
});
