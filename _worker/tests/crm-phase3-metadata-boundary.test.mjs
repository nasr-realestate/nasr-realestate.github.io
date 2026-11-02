// Phase 3 boundary — the rule the registry CI gate enforces, proven against the real service and the real
// schema, in memory, with synthetic ids only (no network, no Drive, no wrangler, no `nasr-crm-test-db`).
//
// Why this file exists: `crm-phase3-registry.yml` used to assert `SUM(content_sha256 IS NOT NULL) = 0`. That
// literal became false the moment Phase 4 started recording content, and a gate that fires on a legal state
// is a gate people delete. This suite is the replacement made testable: the rule lives in
// `scripts/crm/verify-phase3-metadata-boundary.mjs`, is exercised here against the migrations CI actually
// applies, and is run by CI itself (`selftest`) before it touches a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENTED_RECEIPT_RE, LEDGER_PROBE_SQL, evaluatePhase3Boundary, registryProvenanceSql, selftest,
} from '../../scripts/crm/verify-phase3-metadata-boundary.mjs';
import {
  T0, T1, buildRegistry, newRegistryFile, oneOf, sha,
} from './_registry-fixture.mjs';
import {
  recordContentHash, recordInspectionSuccess, recordVersion, syncDriveFolderMetadataInventory, upsertDriveFileMetadata,
} from '../crm-drive-file-registry.js';

const snap = (sqlite, { withLedger = false } = {}) =>
  sqlite.prepare(registryProvenanceSql({ withLedger })).all();

test('the gate holds its own 20 cases, and every refusal names exactly one reason', () => {
  const checks = selftest();
  assert.equal(checks.length, 20, 'the gate grew or shrank — CI prints this count, keep it deliberate');
  for (const [ok, name, note] of checks.filter(c => !c[0])) {
    assert.fail(`${name} — ${note}`);
  }
});

test('the gate speaks the real schema: both projections run against the applied migrations', async () => {
  const { sqlite, db } = buildRegistry();
  await newRegistryFile(db, 'SCHEMA');
  const bare = snap(sqlite, { withLedger: false });
  const withL = snap(sqlite, { withLedger: true });
  assert.equal(bare.length, 1);
  assert.equal(withL.length, 1);
  for (const col of ['drive_file_id', 'digest', 'status', 'receipt', 'processed_at', 'extracted', 'drive_ref']) {
    assert.ok(col in bare[0], `the projection dropped ${col}`);
  }
  assert.equal(bare[0].head_seq, null, 'without the ledger there is no head to project');
  assert.equal(withL[0].head_seq, 0, 'with the ledger, a file with no versions has head 0 — and the gate reads that');
  assert.equal(oneOf(sqlite, LEDGER_PROBE_SQL).n, 1, 'the ledger probe must find the table on this schema');
});

test('a real metadata pass neither writes, erases nor moves a fingerprint', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'KEPT');
  const before = snap(sqlite);

  // the inventory pass: one file whose Drive metadata changed, one file never seen before
  const res = await syncDriveFolderMetadataInventory(db, {
    driveParentId: 'SYNTH-FOLDER',
    scanTimestamp: T1,
    items: [
      { drive_file_id: 'SYNTH-KEPT', file_name: 'kept-renamed.zip', mime_type: 'application/zip',
        file_size: 4096, created_time: T0, modified_time: T1 },
      { drive_file_id: 'SYNTH-NEW', file_name: 'new.zip', mime_type: 'application/zip',
        file_size: 512, created_time: T0, modified_time: T1 },
    ],
  });
  assert.deepEqual({ ins: res.inserted, upd: res.updated, fail: res.failed }, { ins: 1, upd: 1, fail: 0 });
  const after = snap(sqlite);
  assert.equal(after.length, 2, 'the inventory did register the new file');
  assert.equal(
    oneOf(sqlite, "SELECT file_size AS s FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-KEPT'").s,
    4096, 'metadata really moved — otherwise this test proves nothing');
  const gate = evaluatePhase3Boundary({ before, after });
  assert.equal(gate.ok, true, gate.problems.join(' | '));
  assert.equal(gate.summary.fingerprinted, 0);
});

test('the phase separation is enforced, not just observed: metadata cannot set a fingerprint', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'HASHED');
  await assert.rejects(
    () => upsertDriveFileMetadata(db, { drive_file_id: 'SYNTH-HASHED', file_name: 'h.zip',
      mime_type: 'application/zip', content_sha256: sha('x') }),
    /METADATA_CANNOT_SET_CONTENT_HASH/,
    'the intake path refuses the very thing the gate is watching for',
  );

  // the content path may, and the gate accepts it — with or without a ledger
  const digest = sha('kept-bytes');
  await recordContentHash(db, { driveFileId: 'SYNTH-HASHED', contentSha256: digest, innerSha256: null, sizeBytes: 7, now: T1 });
  const hashedOnly = evaluatePhase3Boundary({ before: [], after: snap(sqlite) });
  assert.equal(hashedOnly.ok, false, 'a bare hash with no receipt and no ledger is not documented provenance');
  assert.match(hashedOnly.problems.join(' '), /no measurement behind it/);

  await recordInspectionSuccess(db, {
    driveFileId: 'SYNTH-HASHED', processedAt: T1, extractedRecordsCount: 3,
    receiptRef: `p4a:sha256:${digest.slice(0, 32)}`,
  });
  const processed = snap(sqlite);
  assert.equal(evaluatePhase3Boundary({ before: processed, after: processed }).ok, true,
    'the state Phase 4 leaves behind passes the gate');
});

test('a fingerprint smuggled in by raw SQL is caught — the gate is not a formality', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'CLEAN');
  await newRegistryFile(db, 'FORGED');
  const before = snap(sqlite);
  // exactly what a future one-off script could do: write a digest with no measurement behind it.
  // 0007/0010 allow it at metadata_scanned (the row is not claiming content was handled), so only the
  // boundary check catches it — which is why the check exists.
  sqlite.prepare('UPDATE crm_drive_file_registry SET content_sha256 = ? WHERE drive_file_id = ?')
    .run('f'.repeat(64), 'SYNTH-FORGED');
  const verdict = evaluatePhase3Boundary({ before, after: snap(sqlite) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(' | '), /gained a fingerprint during a metadata pass/);
  assert.match(verdict.problems.join(' | '), /no measurement behind it/);
  for (const p of verdict.problems) {
    assert.ok(!p.includes('SYNTH-FORGED') && !p.includes('SYNTH-CLEAN'), `identifier leaked into: ${p}`);
  }
});

test('with the ledger live, a fingerprint the version table does not carry is refused — and seeding fixes it', async () => {
  const { sqlite, db } = buildRegistry();
  await newRegistryFile(db, 'DOCUMENTED');
  const digest = sha('documented-by-the-ledger');
  await recordVersion(db, {
    driveFileId: 'SYNTH-DOCUMENTED', contentSha256: digest, sizeBytes: 11, observedAt: T1,
    observer: 'test_suite', evidenceClass: 'verified_local_recompute',
    receiptRef: `p4a:sha256:${digest.slice(0, 32)}`,
  });
  const ok = snap(sqlite, { withLedger: true });
  assert.equal(evaluatePhase3Boundary({ before: ok, after: ok, withLedger: true }).ok, true);

  // now the same fact without a version behind it: a row whose digest predates the ledger (the bootstrap case)
  const orphan = sha('predates-the-ledger');
  sqlite.prepare(`INSERT INTO crm_drive_file_registry
      (drive_file_id, file_name, original_file_name, mime_type, content_type, file_size,
       drive_created_at, drive_modified_at, last_seen_at, processing_status, content_sha256)
     VALUES ('SYNTH-PREDATE', 'p.zip', 'p.zip', 'application/zip', 'ZIP', 9, ?, ?, ?, 'metadata_scanned', ?)`)
    .run(T0, T0, T0, orphan);
  const after = snap(sqlite, { withLedger: true });
  const verdict = evaluatePhase3Boundary({ before: ok, after, withLedger: true });
  assert.equal(verdict.ok, false, 'a fingerprint older than the ledger must not be read as reviewed');
  assert.match(verdict.problems.join(' | '), /the version ledger does not hold/);
});

test('the receipt pattern is the documented one, not a vibe', () => {
  for (const good of ['p4a:sha256:' + 'a'.repeat(32), 'phase2-0010-bootstrap']) {
    assert.match(good, DOCUMENTED_RECEIPT_RE);
  }
  for (const bad of ['', 'p4a:sha256:', 'p4a:sha256:xyz', `p4a:sha256:${'a'.repeat(31)}`, 'P4A:sha256:' + 'a'.repeat(32),
    'phase2-bootstrap', 'verified', 'p2v:whatever', 'manual note']) {
    assert.ok(!DOCUMENTED_RECEIPT_RE.test(bad), `${bad} must not count as provenance`);
  }
});
