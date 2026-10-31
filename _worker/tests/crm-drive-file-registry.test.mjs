import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DriveRegistryError,
  compareZipRecordsWithoutInnerInspection,
  detectAndRegisterDuplicate,
  getRegistryEntryByDriveFileId,
  insertNewDriveFileStrict,
  listFilesNeedingProcessing,
  listFilesPendingHumanReview,
  recordContentHash,
  recordHumanReviewDecision,
  recordInspectionFailure,
  recordInspectionSuccess,
  registerDiscoveredDriveFile,
  syncDriveFolderMetadataInventory,
  touchFileLastSeen,
  transitionProcessingStatus,
  upsertDriveFileMetadata,
} from '../crm-drive-file-registry.js';

const ALL_CRM_MIGRATIONS = [
  '0001_crm_opportunities.sql',
  '0002_crm_internal_auth.sql',
  '0003_crm_push_notifications.sql',
  '0004_crm_tracks_core.sql',
  '0005_sync_audit_and_intelligence.sql',
  '0006_decouple_opportunities_and_contact_levels.sql',
  '0007_crm_drive_file_registry.sql',
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
      sqlite.exec('SAVEPOINT d1_batch');
      try {
        const out = statements.map(s => s._exec());
        sqlite.exec('RELEASE d1_batch');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK TO d1_batch');
        sqlite.exec('RELEASE d1_batch');
        throw err;
      }
    },
  };
}

async function createIsolatedRegistryDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY,
      source_id INTEGER,
      external_id TEXT,
      url TEXT,
      title TEXT,
      property_type TEXT,
      transaction_type TEXT,
      area_id INTEGER,
      area_m2 REAL,
      price REAL,
      bedrooms INTEGER,
      bathrooms INTEGER,
      finishing TEXT,
      observed_at TEXT
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

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('1. إضافة ملف جديد بنجاح (VCF وZIP بدون امتداد وحالة discovered) دون اعتبار Metadata بصمة محتوى', async () => {
  const { db } = await createIsolatedRegistryDb();

  const discovered = await registerDiscoveredDriveFile(db, {
    drive_file_id: 'synth_drv_0001',
    drive_parent_id: 'synth_folder_root',
    file_name: 'synthetic_batch_01.vcf',
    mime_type: 'text/x-vcard',
    last_seen_at: '2026-11-01T00:10:00Z',
  });
  assert.equal(discovered.action, 'inserted');
  assert.equal(discovered.entry.processing_status, 'discovered');
  assert.equal(discovered.entry.review_status, 'not_required');
  assert.equal(discovered.entry.content_type, 'VCF');
  assert.equal(discovered.entry.content_sha256, null);
  assert.equal(discovered.entry.original_file_name, 'synthetic_batch_01.vcf');

  const extensionlessZip = await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_drv_0002',
    drive_parent_id: 'synth_folder_root',
    file_name: 'synthetic_whatsapp_archive_without_ext',
    mime_type: 'application/zip',
    file_size: 2048,
    drive_created_at: '2026-10-30T08:00:00Z',
    drive_modified_at: '2026-10-30T09:15:00Z',
    last_seen_at: '2026-11-01T00:11:00Z',
  });
  assert.equal(extensionlessZip.action, 'inserted');
  assert.equal(extensionlessZip.entry.processing_status, 'metadata_scanned');
  assert.equal(extensionlessZip.entry.content_type, 'ZIP');
  assert.equal(extensionlessZip.entry.file_size, 2048);
  assert.equal(extensionlessZip.entry.content_sha256, null);

  await assert.rejects(
    () => upsertDriveFileMetadata(db, {
      drive_file_id: 'synth_drv_0003',
      file_name: 'should_reject_meta_hash.vcf',
      mime_type: 'text/x-vcard',
      drive_modified_at: '2026-10-30T09:15:00Z',
      content_sha256: sha256Hex('metadata-is-not-content'),
    }),
    err => err instanceof DriveRegistryError && err.code === 'METADATA_CANNOT_SET_CONTENT_HASH',
  );
});

test('2. منع إدخال drive_file_id مكرر على مستوى الخدمة وقيد UNIQUE في قاعدة البيانات', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  await insertNewDriveFileStrict(db, {
    drive_file_id: 'synth_unique_01',
    drive_parent_id: 'synth_folder_root',
    file_name: 'first_name.vcf',
    mime_type: 'text/x-vcard',
    file_size: 512,
    drive_modified_at: '2026-10-30T10:00:00Z',
  });

  await assert.rejects(
    () => insertNewDriveFileStrict(db, {
      drive_file_id: 'synth_unique_01',
      drive_parent_id: 'synth_folder_root',
      file_name: 'second_name.vcf',
      mime_type: 'text/x-vcard',
      file_size: 999,
      drive_modified_at: '2026-10-31T10:00:00Z',
    }),
    err => err instanceof DriveRegistryError && err.code === 'DUPLICATE_DRIVE_FILE_ID',
  );

  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO crm_drive_file_registry (
        id, drive_file_id, file_name, original_file_name, mime_type, drive_modified_at, processing_status
      ) VALUES ('id-dup-raw', 'synth_unique_01', 'raw.vcf', 'raw.vcf', 'text/x-vcard', '2026-10-31T10:00:00Z', 'metadata_scanned')
    `).run();
  }, /UNIQUE/i);

  const count = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_drive_file_registry').get().cnt;
  assert.equal(Number(count), 1);
});

test('3. تحديث Metadata للملف وتحديث last_seen_at دون فقدان بيانات المعالجة والمراجعة السابقة', async () => {
  const { db } = await createIsolatedRegistryDb();
  const hash1 = sha256Hex('canonical-vcf-bytes-v1');

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_hist_01',
    drive_parent_id: 'synth_folder_root',
    file_name: 'initial_contacts.vcf',
    mime_type: 'text/x-vcard',
    file_size: 1200,
    drive_created_at: '2026-10-20T08:00:00Z',
    drive_modified_at: '2026-10-25T10:00:00Z',
    last_seen_at: '2026-10-31T20:00:00Z',
    metadata: { batch_tag: 'initial_scan' },
  });

  await recordContentHash(db, {
    driveFileId: 'synth_hist_01',
    contentSha256: hash1,
    hashedAt: '2026-10-31T20:05:00Z',
  });

  await recordInspectionSuccess(db, {
    driveFileId: 'synth_hist_01',
    processedAt: '2026-10-31T20:10:00Z',
    receiptRef: 'run:phase4-synth-001',
    extractedRecordsCount: 12,
    metadataPatch: { parser_version: 'v1' },
  });

  await recordHumanReviewDecision(db, {
    driveFileId: 'synth_hist_01',
    reviewStatus: 'pending',
    updatedAt: '2026-10-31T20:12:00Z',
  });

  await recordHumanReviewDecision(db, {
    driveFileId: 'synth_hist_01',
    reviewStatus: 'approved',
    reviewer: 'owner_supervisor',
    reviewedAt: '2026-10-31T20:15:00Z',
    reviewNotes: 'Approved synthetic test record',
  });

  const touched = await touchFileLastSeen(db, {
    driveFileId: 'synth_hist_01',
    seenAt: '2026-11-01T00:30:00Z',
  });
  assert.equal(touched.last_seen_at, '2026-11-01T00:30:00Z');
  assert.equal(touched.processing_status, 'processed');

  // Now update metadata (renamed file + newer modifiedTime in Drive):
  const metaUpdated = await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_hist_01',
    drive_parent_id: 'synth_folder_root',
    file_name: 'VCF__2026-11-01__contacts__renamed__v2.vcf',
    mime_type: 'text/x-vcard',
    file_size: 1450,
    drive_modified_at: '2026-11-01T01:00:00Z',
    last_seen_at: '2026-11-01T01:05:00Z',
    metadata: { rescan_pass: 2 },
  });

  assert.equal(metaUpdated.action, 'updated');
  assert.equal(metaUpdated.modifiedSinceProcessed, true);
  const row = metaUpdated.entry;
  assert.equal(row.file_name, 'VCF__2026-11-01__contacts__renamed__v2.vcf');
  assert.equal(row.original_file_name, 'initial_contacts.vcf');
  assert.equal(row.file_size, 1450);
  assert.equal(row.last_processed_at, '2026-10-31T20:10:00Z');
  assert.equal(row.drive_modified_at_processed, '2026-10-25T10:00:00Z');
  assert.equal(row.processing_receipt_ref, 'run:phase4-synth-001');
  assert.equal(row.extracted_records_count, 12);
  assert.equal(row.processing_attempts, 1);
  assert.equal(row.content_sha256, hash1);
  assert.equal(row.review_status, 'approved');
  assert.equal(row.reviewed_by, 'owner_supervisor');
  assert.deepEqual(JSON.parse(row.metadata_json), {
    batch_tag: 'initial_scan',
    parser_version: 'v1',
    rescan_pass: 2,
  });

  // Because drive_modified_at changed after drive_modified_at_processed, work queue surfaces it:
  const queue = await listFilesNeedingProcessing(db, { driveParentId: 'synth_folder_root' });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].drive_file_id, 'synth_hist_01');
});

test('4. اكتشاف تطابق SHA-256 بين ملفين مختلفي الاسم والمعرّف وعدم الاعتماد على الحجم وحده', async () => {
  const { db } = await createIsolatedRegistryDb();
  const sharedHash = sha256Hex('identical-binary-payload-across-two-drive-files');

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_orig_A',
    drive_parent_id: 'synth_folder_root',
    file_name: 'export_original_october.vcf',
    mime_type: 'text/x-vcard',
    file_size: 4096,
    drive_created_at: '2026-10-15T10:00:00Z',
    drive_modified_at: '2026-10-15T10:00:00Z',
  });
  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_copy_B',
    drive_parent_id: 'synth_folder_root',
    file_name: 'copy_with_completely_different_name.vcf',
    mime_type: 'text/x-vcard',
    file_size: 4800, // Even if reported size differed or matched, SHA-256 governs
    drive_created_at: '2026-10-29T18:30:00Z',
    drive_modified_at: '2026-10-29T18:30:00Z',
  });

  // Before hashing, file_size alone MUST NOT mark either file as duplicate:
  const preHashCheck = await detectAndRegisterDuplicate(db, { driveFileId: 'synth_copy_B' });
  assert.equal(preHashCheck.isDuplicate, false);
  assert.equal(preHashCheck.reason, 'content_sha256_not_computed');

  await recordContentHash(db, { driveFileId: 'synth_orig_A', contentSha256: sharedHash });
  await recordContentHash(db, { driveFileId: 'synth_copy_B', contentSha256: sharedHash });

  const canonRes = await detectAndRegisterDuplicate(db, { driveFileId: 'synth_orig_A' });
  assert.equal(canonRes.isDuplicate, false);
  assert.equal(canonRes.canonicalDriveFileId, 'synth_orig_A');

  const dupRes = await detectAndRegisterDuplicate(db, {
    driveFileId: 'synth_copy_B',
    detectedAt: '2026-11-01T01:20:00Z',
  });
  assert.equal(dupRes.isDuplicate, true);
  assert.equal(dupRes.canonicalDriveFileId, 'synth_orig_A');
  assert.equal(dupRes.reason, 'confirmed_exact_content_sha256');
});

test('5. تسجيل علاقة duplicate دون حذف أي سجل ومنع حذف الملف المرجعي عبر ON DELETE RESTRICT', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();
  const sharedHash = sha256Hex('duplicate-lineage-preservation-payload');

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_canon_01',
    drive_parent_id: 'synth_folder_root',
    file_name: 'canonical_contacts.vcf',
    mime_type: 'text/x-vcard',
    file_size: 2048,
    drive_created_at: '2026-10-10T10:00:00Z',
    drive_modified_at: '2026-10-10T10:00:00Z',
  });
  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_dup_02',
    drive_parent_id: 'synth_folder_root',
    file_name: 'duplicate_contacts_copy.vcf',
    mime_type: 'text/x-vcard',
    file_size: 2048,
    drive_created_at: '2026-10-20T10:00:00Z',
    drive_modified_at: '2026-10-20T10:00:00Z',
  });

  await recordContentHash(db, { driveFileId: 'synth_canon_01', contentSha256: sharedHash });
  await recordContentHash(db, { driveFileId: 'synth_dup_02', contentSha256: sharedHash });

  const dupRes = await detectAndRegisterDuplicate(db, { driveFileId: 'synth_dup_02' });
  assert.equal(dupRes.isDuplicate, true);
  assert.equal(dupRes.entry.processing_status, 'duplicate');
  assert.equal(dupRes.entry.duplicate_of_file_id, 'synth_canon_01');

  const canonEntry = await getRegistryEntryByDriveFileId(db, 'synth_canon_01');
  assert.equal(canonEntry.processing_status, 'hashed');
  assert.equal(canonEntry.duplicate_of_file_id, null);

  // Both rows remain intact; deleting canonical row is blocked by ON DELETE RESTRICT:
  const totalRows = Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_drive_file_registry').get().cnt);
  assert.equal(totalRows, 2);
  assert.throws(() => {
    sqlite.prepare("DELETE FROM crm_drive_file_registry WHERE drive_file_id = 'synth_canon_01'").run();
  }, /FOREIGN KEY/i);
});

test('6. عدم اعتبار ZIP مختلف البصمة الخارجية مكررًا داخليًا أو مختلفًا قطعيًا دون فحص محتواه الداخلي', async () => {
  const { db } = await createIsolatedRegistryDb();

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_zip_1',
    drive_parent_id: 'synth_folder_root',
    file_name: 'chat_export_morning',
    mime_type: 'application/zip',
    file_size: 1389,
    drive_modified_at: '2026-10-30T09:00:00Z',
  });
  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_zip_2',
    drive_parent_id: 'synth_folder_root',
    file_name: 'chat_export_evening',
    mime_type: 'application/zip',
    file_size: 1389,
    drive_modified_at: '2026-10-30T21:00:00Z',
  });

  await recordContentHash(db, {
    driveFileId: 'synth_zip_1',
    contentSha256: sha256Hex('zip-container-header-timestamp-1'),
  });
  await recordContentHash(db, {
    driveFileId: 'synth_zip_2',
    contentSha256: sha256Hex('zip-container-header-timestamp-2'),
  });

  const d1 = await detectAndRegisterDuplicate(db, { driveFileId: 'synth_zip_1' });
  const d2 = await detectAndRegisterDuplicate(db, { driveFileId: 'synth_zip_2' });
  assert.equal(d1.isDuplicate, false);
  assert.equal(d2.isDuplicate, false);
  assert.equal(d2.reason, 'unique_outer_sha256_zip_inner_deferred');

  const cmp = compareZipRecordsWithoutInnerInspection(d1.entry, d2.entry);
  assert.equal(cmp.outerIdentical, false);
  assert.equal(cmp.confirmedDuplicate, false);
  assert.equal(cmp.innerComparison, 'indeterminate_until_inner_inspection');
});

test('7. رفض الحالات غير المسموح بها والانتقالات غير القانونية على مستوى الخدمة وSQL CHECK', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  await registerDiscoveredDriveFile(db, {
    drive_file_id: 'synth_state_01',
    drive_parent_id: 'synth_folder_root',
    file_name: 'state_machine_check.vcf',
    mime_type: 'text/x-vcard',
  });

  await assert.rejects(
    () => transitionProcessingStatus(db, { driveFileId: 'synth_state_01', toStatus: 'not_a_valid_status' }),
    err => err instanceof DriveRegistryError && err.code === 'INVALID_PROCESSING_STATUS',
  );

  // Illegal jump from 'discovered' directly to 'downloaded' or 'hashed':
  await assert.rejects(
    () => transitionProcessingStatus(db, { driveFileId: 'synth_state_01', toStatus: 'downloaded' }),
    err => err instanceof DriveRegistryError && err.code === 'ILLEGAL_PROCESSING_TRANSITION',
  );

  await assert.rejects(
    () => recordHumanReviewDecision(db, { driveFileId: 'synth_state_01', reviewStatus: 'invalid_review_state' }),
    err => err instanceof DriveRegistryError && err.code === 'INVALID_REVIEW_STATUS',
  );

  // Direct SQL invalid enum values rejected by SQLite CHECK:
  assert.throws(() => {
    sqlite.prepare("UPDATE crm_drive_file_registry SET processing_status = 'bogus' WHERE drive_file_id = 'synth_state_01'").run();
  }, /CHECK/i);
  assert.throws(() => {
    sqlite.prepare("UPDATE crm_drive_file_registry SET review_status = 'bogus' WHERE drive_file_id = 'synth_state_01'").run();
  }, /CHECK/i);
  assert.throws(() => {
    sqlite.prepare("UPDATE crm_drive_file_registry SET content_sha256 = 'not-64-hex' WHERE drive_file_id = 'synth_state_01'").run();
  }, /CHECK/i);
});

test('8. عدم قبول تحويل ملف إلى processed دون دليل فعلي على نجاح المعالجة', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_proc_guard',
    drive_parent_id: 'synth_folder_root',
    file_name: 'guard_processed.vcf',
    mime_type: 'text/x-vcard',
    file_size: 900,
    drive_modified_at: '2026-10-30T12:00:00Z',
  });

  // 1) Missing content_sha256:
  await assert.rejects(
    () => recordInspectionSuccess(db, {
      driveFileId: 'synth_proc_guard',
      processedAt: '2026-11-01T01:00:00Z',
      receiptRef: 'run:valid-receipt-01',
      extractedRecordsCount: 3,
    }),
    err => err instanceof DriveRegistryError && err.code === 'MISSING_PROCESSING_EVIDENCE',
  );

  await recordContentHash(db, {
    driveFileId: 'synth_proc_guard',
    contentSha256: sha256Hex('verified-content-for-proc-guard'),
  });

  // 2) Missing receiptRef:
  await assert.rejects(
    () => recordInspectionSuccess(db, {
      driveFileId: 'synth_proc_guard',
      processedAt: '2026-11-01T01:00:00Z',
      receiptRef: '',
      extractedRecordsCount: 3,
    }),
    err => err instanceof DriveRegistryError && err.code === 'MISSING_PROCESSING_EVIDENCE',
  );

  // 3) Missing extractedRecordsCount:
  await assert.rejects(
    () => recordInspectionSuccess(db, {
      driveFileId: 'synth_proc_guard',
      processedAt: '2026-11-01T01:00:00Z',
      receiptRef: 'run:valid-receipt-01',
    }),
    err => err instanceof DriveRegistryError && err.code === 'MISSING_PROCESSING_EVIDENCE',
  );

  // 4) Direct SQL bypass attempt without receipt / last_processed_at / attempts rejected by DB CHECK:
  assert.throws(() => {
    sqlite.prepare("UPDATE crm_drive_file_registry SET processing_status = 'processed' WHERE drive_file_id = 'synth_proc_guard'").run();
  }, /CHECK/i);

  // 5) Succeeds ONLY when complete evidence is provided:
  const ok = await recordInspectionSuccess(db, {
    driveFileId: 'synth_proc_guard',
    processedAt: '2026-11-01T01:05:00Z',
    receiptRef: 'run:valid-receipt-01',
    extractedRecordsCount: 3,
  });
  assert.equal(ok.processing_status, 'processed');
  assert.equal(ok.processing_attempts, 1);
});

test('9. عدم قبول تحويل ملف إلى approved دون تسجيل مراجعة بشرية فعلية واستخراج قائمة المراجعة', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_rev_guard',
    drive_parent_id: 'synth_folder_root',
    file_name: 'guard_review.zip',
    mime_type: 'application/zip',
    file_size: 1600,
    drive_modified_at: '2026-10-30T15:00:00Z',
  });

  await recordHumanReviewDecision(db, {
    driveFileId: 'synth_rev_guard',
    reviewStatus: 'needs_manual_review',
    reviewNotes: 'Ambiguous archive header requires owner inspection',
  });

  const pendingList = await listFilesPendingHumanReview(db, { driveParentId: 'synth_folder_root' });
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].drive_file_id, 'synth_rev_guard');

  // Automated/non-human reviewers or missing notes/timestamps MUST fail:
  for (const badReviewer of ['', 'system', 'auto', 'agent', 'ai', 'worker', 'cron']) {
    await assert.rejects(
      () => recordHumanReviewDecision(db, {
        driveFileId: 'synth_rev_guard',
        reviewStatus: 'approved',
        reviewer: badReviewer,
        reviewedAt: '2026-11-01T01:10:00Z',
        reviewNotes: 'Attempted automated approval',
      }),
      err => err instanceof DriveRegistryError && err.code === 'HUMAN_REVIEW_REQUIRED',
    );
  }

  await assert.rejects(
    () => recordHumanReviewDecision(db, {
      driveFileId: 'synth_rev_guard',
      reviewStatus: 'approved',
      reviewer: 'owner_manual',
      reviewedAt: '2026-11-01T01:10:00Z',
      reviewNotes: '   ',
    }),
    err => err instanceof DriveRegistryError && err.code === 'HUMAN_REVIEW_REQUIRED',
  );

  // Direct SQL bypass without human reviewer or with 'system' rejected by DB CHECK:
  assert.throws(() => {
    sqlite.prepare("UPDATE crm_drive_file_registry SET review_status = 'approved' WHERE drive_file_id = 'synth_rev_guard'").run();
  }, /CHECK/i);
  assert.throws(() => {
    sqlite.prepare(`
      UPDATE crm_drive_file_registry
      SET review_status = 'approved', reviewed_by = 'system', reviewed_at = '2026-11-01T01:10:00Z', review_notes = 'auto'
      WHERE drive_file_id = 'synth_rev_guard'
    `).run();
  }, /CHECK/i);

  const approved = await recordHumanReviewDecision(db, {
    driveFileId: 'synth_rev_guard',
    reviewStatus: 'approved',
    reviewer: 'owner_manual',
    reviewedAt: '2026-11-01T01:12:00Z',
    reviewNotes: 'Reviewed manually by project owner',
  });
  assert.equal(approved.review_status, 'approved');
  assert.equal(approved.reviewed_by, 'owner_manual');

  const pendingAfter = await listFilesPendingHumanReview(db, { driveParentId: 'synth_folder_root' });
  assert.equal(pendingAfter.length, 0);
});

test('10. سلامة المفاتيح الأجنبية والقيود والفهارس على كامل مخطط الهجرات 0001..0007', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  const integrity = sqlite.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);

  const indexes = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'crm_drive_file_registry' AND sql IS NOT NULL
    ORDER BY name ASC
  `).all().map(r => r.name);

  assert.deepEqual(indexes, [
    'idx_crm_drive_registry_content_sha256',
    'idx_crm_drive_registry_duplicate_of',
    'idx_crm_drive_registry_inner_sha256',
    'idx_crm_drive_registry_parent_seen',
    'idx_crm_drive_registry_proc_status',
    'idx_crm_drive_registry_review_status',
  ]);

  await upsertDriveFileMetadata(db, {
    drive_file_id: 'synth_fk_self',
    drive_parent_id: 'synth_folder_root',
    file_name: 'self_ref_test.vcf',
    mime_type: 'text/x-vcard',
    file_size: 400,
    drive_modified_at: '2026-10-30T10:00:00Z',
  });
  await recordContentHash(db, {
    driveFileId: 'synth_fk_self',
    contentSha256: sha256Hex('self-ref-test'),
  });

  // Self-reference blocked by CHECK:
  assert.throws(() => {
    sqlite.prepare(`
      UPDATE crm_drive_file_registry
      SET processing_status = 'duplicate', duplicate_of_file_id = 'synth_fk_self'
      WHERE drive_file_id = 'synth_fk_self'
    `).run();
  }, /CHECK/i);

  // Non-existent duplicate_of_file_id blocked by FOREIGN KEY:
  assert.throws(() => {
    sqlite.prepare(`
      UPDATE crm_drive_file_registry
      SET processing_status = 'duplicate', duplicate_of_file_id = 'non_existent_drive_id'
      WHERE drive_file_id = 'synth_fk_self'
    `).run();
  }, /FOREIGN KEY/i);

  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('11. إعادة تنفيذ العملية نفسها (Idempotency) دون تكرار السجلات أو تضخيم العدادات', async () => {
  const { sqlite, db } = await createIsolatedRegistryDb();

  const items = Array.from({ length: 12 }, (_, idx) => ({
    id: `synth_idem_${String(idx + 1).padStart(2, '0')}`,
    name: idx < 3 ? `synth_contacts_${idx + 1}.vcf` : `synth_whatsapp_chat_${idx + 1}`,
    mimeType: idx < 3 ? 'text/x-vcard' : 'application/zip',
    size: 700 + idx * 55,
    createdTime: '2026-10-29T10:00:00Z',
    modifiedTime: '2026-10-30T14:00:00Z',
    ownedByMe: true,
    shared: false,
  }));

  const pass1 = await syncDriveFolderMetadataInventory(db, {
    driveParentId: 'synth_folder_99',
    items,
    scanTimestamp: '2026-11-01T01:00:00Z',
  });
  assert.equal(pass1.inserted, 12);
  assert.equal(pass1.updated, 0);
  assert.deepEqual(pass1.byContentType, { VCF: 3, ZIP: 9, OTHER: 0 });

  const pass2 = await syncDriveFolderMetadataInventory(db, {
    driveParentId: 'synth_folder_99',
    items,
    scanTimestamp: '2026-11-01T01:15:00Z',
  });
  assert.equal(pass2.inserted, 0);
  assert.equal(pass2.updated, 12);

  const pass3 = await syncDriveFolderMetadataInventory(db, {
    driveParentId: 'synth_folder_99',
    items,
    scanTimestamp: '2026-11-01T01:30:00Z',
  });
  assert.equal(pass3.inserted, 0);
  assert.equal(pass3.updated, 12);

  const count = Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_drive_file_registry').get().cnt);
  assert.equal(count, 12);

  // Replay recordInspectionSuccess with identical receiptRef does not inflate processing_attempts:
  await recordContentHash(db, {
    driveFileId: 'synth_idem_01',
    contentSha256: sha256Hex('idem-file-01'),
  });
  await recordInspectionSuccess(db, {
    driveFileId: 'synth_idem_01',
    processedAt: '2026-11-01T02:00:00Z',
    receiptRef: 'run:idem-receipt-1',
    extractedRecordsCount: 5,
  });
  const replay = await recordInspectionSuccess(db, {
    driveFileId: 'synth_idem_01',
    processedAt: '2026-11-01T02:05:00Z',
    receiptRef: 'run:idem-receipt-1',
    extractedRecordsCount: 5,
  });
  assert.equal(replay.processing_attempts, 1);
});

test('12. عدم كشف بيانات العملاء أو الأسرار في رسائل الخطأ أو metadata_json أو Logs', async () => {
  const { db } = await createIsolatedRegistryDb();

  const capturedLogs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => capturedLogs.push(args.join(' '));
  console.warn = (...args) => capturedLogs.push(args.join(' '));
  console.error = (...args) => capturedLogs.push(args.join(' '));

  const CANARIES = [
    'طارق عبد الرحمن',
    'دردشة في واتساب مع طارق عبد الرحمن',
    '+20 100 987 6543',
    '201009876543',
    '01123456789',
    'مريم سامي',
    'tarek.canary@example.org',
    'ya29.a0AfH6SM_secret_canary_oauth',
    'super_secret_crm_code_canary',
    'Ahmed Canaryson',
  ];

  try {
    const failedEntry = await recordInspectionFailure(db, {
      driveFileId: 'synth_pii_guard_01',
      driveParentId: 'synth_folder_root',
      placeholderName: 'دردشة في واتساب مع طارق عبد الرحمن +20 100 987 6543',
      errorCode: 'PARSE_ARCHIVE_ERROR',
      errorMessage:
        'Failed parsing "Ahmed Canaryson" دردشة في واتساب مع طارق عبد الرحمن +20 100 987 6543 ' +
        '01123456789 FN:مريم سامي tarek.canary@example.org Bearer ya29.a0AfH6SM_secret_canary_oauth ' +
        'CRM_ACCESS_CODE=super_secret_crm_code_canary',
      failedAt: '2026-11-01T02:10:00Z',
      needsManualReview: true,
    });

    const storedRecordText = JSON.stringify(failedEntry);
    for (const canary of CANARIES) {
      assert.equal(
        storedRecordText.includes(canary),
        false,
        `Canary leaked into stored failure row: ${canary}`,
      );
    }

    // Forbidden PII keys or phone strings inside metadata_json must be rejected without echoing canary:
    for (const badMeta of [
      { customer_name: 'طارق عبد الرحمن' },
      { phone: '+20 100 987 6543' },
      { raw_text: 'دردشة في واتساب مع طارق عبد الرحمن' },
      { access_token: 'ya29.a0AfH6SM_secret_canary_oauth' },
      { safe_key_name: 'Call +20 100 987 6543 now' },
    ]) {
      await assert.rejects(
        () => upsertDriveFileMetadata(db, {
          drive_file_id: 'synth_pii_guard_02',
          file_name: 'synthetic_clean.vcf',
          mime_type: 'text/x-vcard',
          drive_modified_at: '2026-10-30T10:00:00Z',
          metadata: badMeta,
        }),
        err => {
          assert.ok(err instanceof DriveRegistryError);
          for (const canary of CANARIES) {
            assert.equal(err.message.includes(canary), false, `Canary leaked in Error.message: ${canary}`);
          }
          return true;
        },
      );
    }

    const row2 = await getRegistryEntryByDriveFileId(db, 'synth_pii_guard_02');
    assert.equal(row2, null);

    const allLogs = capturedLogs.join('\n');
    for (const canary of CANARIES) {
      assert.equal(allLogs.includes(canary), false, `Canary leaked into console logs: ${canary}`);
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
});
