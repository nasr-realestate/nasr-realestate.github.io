// Phase 3 boundary — the rule the registry CI gate enforces, proven against the real service and the real
// schema, in memory, with synthetic ids only (no network, no Drive, no wrangler, no `nasr-crm-test-db-v2`).
//
// Why this file exists: `crm-phase3-registry.yml` used to assert `SUM(content_sha256 IS NOT NULL) = 0`. That
// literal became false the moment Phase 4 started recording content, and a gate that fires on a legal state
// is a gate people delete. This suite is the replacement made testable: the rule lives in
// `scripts/crm/verify-phase3-metadata-boundary.mjs`, is exercised here against the migrations CI actually
// applies, and is run by CI itself (`selftest`) before it touches a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENTED_RECEIPT_RE, LEDGER_PROBE_SQL, evaluatePhase3Boundary, migrationProbeSql, registryProvenanceSql, selftest,
} from '../../scripts/crm/verify-phase3-metadata-boundary.mjs';
import {
  T0, T1, buildRegistry, newRegistryFile, oneOf, sha,
} from './_registry-fixture.mjs';
import {
  deriveDriveRef, recordContentHash, recordInspectionSuccess, recordVersion, syncDriveFolderMetadataInventory,
  upsertDriveFileMetadata,
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

// The migration session's read path. `.github/workflows/crm-drive-migration-session.yml` holds no SQL of its
// own — it imports these builders — which is what makes this test the place where a bad query is found: on a
// real schema, in memory, before a run that has one shot at a live database. A typo in a workflow literal is
// normally discovered by the migration itself, at 03:00, against rows that cannot be un-written.
test('every migration-session probe runs against the real schema, on both sides of the promotion', async () => {
  const pre = buildRegistry({ ledger: false });
  await newRegistryFile(pre.db, 'SESSION-A', { size: 1024 });
  // wrangler owns `d1_migrations`; the fixture does not, so the table the probe reads is stubbed with the
  // same shape. Without it the query is untestable, and "untestable" is not the same as "fine".
  const stubMigrations = sqlite => {
    sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);');
    sqlite.prepare('INSERT INTO d1_migrations (id, name, applied_at) VALUES (1, ?, ?)')
      .run('0010_crm_drive_file_versions.sql', T1);
  };
  stubMigrations(pre.sqlite);
  const P0 = migrationProbeSql({ withLedger: false });
  const P1 = migrationProbeSql({ withLedger: true });
  for (const [name, sql] of Object.entries(P0)) {
    assert.match(String(sql).trim(), /^(?:SELECT|PRAGMA)\b/, `${name} must be a read-only statement`);
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|REPLACE)\b/i.test(String(sql).replace(/processing_status/g, '')),
      `${name} is not a read-only statement`);
    // `seedRows` is only ever read by the bootstrap pass, which runs after the promotion: it is asserted to
    // fail here rather than skipped, because "the session would have stopped" is only worth saying measured.
    // `needsBootstrap` is the opposite case — the no-ledger variant deliberately counts fingerprints instead
    // of anchors, so a pre-promotion probe is a number, not an error.
    if (name === 'seedRows') continue;
    pre.sqlite.prepare(String(sql).replace(/;+$/, '')).all();
  }
  assert.throws(() => pre.sqlite.prepare(String(P0.seedRows).replace(/;+$/, '')).get(),
    /no such column: drive_ref/,
    'the seeder read must be unusable before the promotion — the anchor column does not exist yet');
  assert.ok(!P0.needsBootstrap.includes('drive_ref'),
    'the pre-promotion variant must not name a column that does not exist yet');
  assert.match(P1.needsBootstrap, /drive_ref IS NULL/, 'the post-promotion variant asks the real question');
  const counts = pre.sqlite.prepare(P0.counts).get();
  assert.equal(Number(counts.migs), 1, 'the migration ledger is read from the table wrangler maintains');
  assert.equal(String(counts.latest), '0010_crm_drive_file_versions.sql', 'and the newest row is the newest name');
  assert.equal(Number(counts.rows_all), 1, 'the registry exists pre-promotion with its one row');
  assert.equal(Number(counts.fp), 0, 'nothing is fingerprinted yet');
  assert.equal(Number(pre.sqlite.prepare(P0.needsBootstrap).get().n), 0,
    'without a fingerprint there is nothing to anchor, and the session must see that as a stop, not a pass');
  const unavailable = pre.sqlite.prepare(P0.violations).get();
  assert.deepEqual(Object.keys(unavailable).sort(),
    ['counter_mismatches', 'dangling_heads', 'seq_gaps', 'status_without_version']);
  for (const key of Object.keys(unavailable)) {
    assert.equal(Number(unavailable[key]), -1,
      `pre-0010 there is no violations view, so ${key} reports "unavailable", never an invented zero`);
  }
  assert.equal(Number(pre.sqlite.prepare(P0.registryHasRef).get().c), 0, 'the column is created BY 0010');


  const post = buildRegistry({ ledger: true });
  stubMigrations(post.sqlite);
  const row = await newRegistryFile(post.db, 'SESSION-B', { size: 2048 });
  await recordVersion(post.db, {
    driveFileId: row.drive_file_id, contentSha256: sha('session bytes'), evidenceClass: 'bootstrap_backfill',
    sizeBytes: 2048, observedBy: 'registry_bootstrap', receiptRef: 'phase2-0010-bootstrap', observedAt: T1,
  });
  for (const [name, sql] of Object.entries(P1)) {
    post.sqlite.prepare(String(sql).replace(/;+$/, '')).all();
  }
  const health = post.sqlite.prepare(P1.anchorHealth).get();
  assert.equal(Number(health.anchored), 1, 'the version writer projects the anchor onto the row');
  assert.equal(Number(health.unanchored), 0, 'no fingerprint is left un-anchored');
  assert.equal(Number(health.orphans), 0, 'and no version points at nothing');
  assert.equal(Number(post.sqlite.prepare(P1.needsBootstrap).get().n), 0, 'the seed plan has nothing to write');
  const viol = post.sqlite.prepare(P1.violations).get();
  for (const key of Object.keys(viol)) assert.equal(Number(viol[key]), 0, `${key} must be zero on a whole ledger`);
  const seed = post.sqlite.prepare(P1.seedRows).all();
  assert.deepEqual(Object.keys(seed[0]).sort(),
    ['content_sha256', 'drive_file_id', 'drive_ref', 'processing_status'],
    'the seeder reads four columns and no name, path, receipt or customer field');
  assert.equal(seed[0].drive_ref, await deriveDriveRef(row.drive_file_id),
    'what the probe reads back is the same ref the tool would have written');
});
