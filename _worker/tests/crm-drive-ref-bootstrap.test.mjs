// The bootstrap gap, closed and then proven closed — in memory, on synthetic rows, against the real drafts.
//
// Draft 0010 §5 backfills one version row per registry row that has BOTH a fingerprint and an anchor. Rows
// registered before the promotion have the fingerprint (Phase 4 recorded it) and no anchor (`drive_ref` is
// created by §1 of the same migration), so §5 passes over them: `head_version_seq` stays 0,
// `crm_drive_version_invariant_violations` counts them as `status_without_version`, and 0011 refuses to open a
// review case for them. `scripts/crm/seed-drive-file-refs.mjs` lays the anchor down; §5 re-run then finishes
// the job. This file is that sequence, executed — plus the parts that must stay true while doing it: the
// anchor is the repo key, the backfilled version carries a bootstrap claim and never a verified one, and no
// column except `drive_ref` moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DRAFT_0010, DRAFT_0011, T0, T1, buildRegistry, newRegistryFile, oneOf, sha,
} from './_registry-fixture.mjs';
import { deriveDriveRef, recordContentHash, recordInspectionSuccess } from '../crm-drive-file-registry.js';
import { assertSeedIsOneColumn, buildSeedPlan, driveRefFor, renderSeedSql, summarizeSeed }
  from '../../scripts/crm/seed-drive-file-refs.mjs';

const migrationText = readFileSync(DRAFT_0010, 'utf8');
const section5 = (() => {
  const start = migrationText.indexOf('-- 5) backfill');
  const end = migrationText.indexOf('-- 6) read-only surfaces', start);
  assert.ok(start > 0 && end > start, 'the bootstrap section must stay addressable — the test slices it by its headings');
  return migrationText.slice(start, end);
})();

// a pre-promotion database: registered by the metadata walk, fingerprinted and processed by Phase 4
async function legacyRow(db, sqlite, tag, bytes) {
  await newRegistryFile(db, tag);
  const digest = sha(bytes);
  await recordContentHash(db, {
    driveFileId: `SYNTH-${tag}`, contentSha256: digest, innerSha256: null, sizeBytes: bytes.length, now: T1,
  });
  await recordInspectionSuccess(db, {
    driveFileId: `SYNTH-${tag}`, processedAt: T1, extractedRecordsCount: 2,
    receiptRef: `p4a:sha256:${digest.slice(0, 32)}`,
  });
  return digest;
}

const exportRows = sqlite => sqlite
  .prepare('SELECT drive_file_id, drive_ref, content_sha256, processing_status FROM crm_drive_file_registry')
  .all();

test('the gap is real: a pre-0010 row with a fingerprint is left unreviewable by §5 alone', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  const digest = await legacyRow(db, sqlite, 'LEGACY', 'legacy bytes');

  // the anchor cannot be laid down first: the column does not exist yet — that is why the seed is step 3
  const cols = sqlite.prepare('PRAGMA table_info(crm_drive_file_registry)').all().map(c => c.name);
  assert.ok(!cols.includes('drive_ref'), 'if this starts passing, the promotion ordering note is obsolete');

  sqlite.exec(migrationText);                     // promote: §1 adds the column, §5 backfills what it can see
  assert.equal(oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 0,
    '§5 is blind to an un-anchored row — measured, not assumed');
  const inv = oneOf(sqlite, 'SELECT status_without_version AS n FROM crm_drive_version_invariant_violations');
  assert.equal(inv.n, 1, `the invariant view must report exactly the stuck row (got ${inv.n})`);
  assert.equal(oneOf(sqlite, "SELECT content_sha256 AS c FROM crm_drive_file_registry").c, digest);
});

test('seed the anchor, re-run §5, and the row becomes reviewable with a bootstrap claim only', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  const digest = await legacyRow(db, sqlite, 'LEGACY', 'legacy bytes');
  await legacyRow(db, sqlite, 'SECOND', 'other bytes');
  sqlite.exec(migrationText);
  sqlite.exec(readFileSync(DRAFT_0011, 'utf8'));

  // 0011 refuses a review case while the file has no recorded version — the practical consequence of the gap
  const caseTable = 'crm_drive_file_review_case';
  assert.equal(oneOf(sqlite, `SELECT COUNT(*) AS n FROM ${caseTable}`).n, 0);

  const plan = buildSeedPlan(exportRows(sqlite));
  const seed = summarizeSeed(plan);
  assert.deepEqual(
    { anchored: seed.anchored, conflicts: seed.conflicts, refused: seed.refused },
    { anchored: 2, conflicts: 0, refused: 0 },
    'both legacy rows are exactly the stuck set',
  );
  const sqlText = renderSeedSql(plan);
  assertSeedIsOneColumn(sqlText);
  for (const line of sqlText.split('\n').filter(l => l.startsWith('UPDATE '))) sqlite.exec(line);

  sqlite.exec(section5);                          // the migration's own backfill, re-run over anchored rows

  for (const tag of ['LEGACY', 'SECOND']) {
    const v = oneOf(sqlite, `SELECT v.version_seq AS seq, v.content_sha256 AS digest, v.evidence_class AS e,
         v.size_bytes AS size, v.receipt_ref AS receipt, v.observed_by AS obs
      FROM crm_drive_file_version v JOIN crm_drive_file_registry r ON r.drive_ref = v.drive_ref
      WHERE r.drive_file_id = 'SYNTH-${tag}'`);
    assert.ok(v, `SYNTH-${tag} must now have a version row`);
    assert.equal(v.seq, 1, 'a bootstrap version is seq 1 — the first the ledger knows about');
    assert.equal(v.e, 'bootstrap_backfill', 'the claim must say where it came from');
    assert.equal(v.obs, 'registry_bootstrap', 'the observer is the migration, not somebody who verified bytes');
    assert.ok(v.receipt === null || !/verified/i.test(String(v.receipt)));
    // and the migration's own queue still lists it as unproven work — closure must not read as re-verification
    const q = oneOf(sqlite, `SELECT reason AS r FROM crm_drive_rehash_queue q
      JOIN crm_drive_file_registry reg ON reg.drive_ref = q.drive_ref
      WHERE reg.drive_file_id = 'SYNTH-${tag}'`);
    assert.equal(q.r, 'bootstrap_claim_only', `${tag} left the rehash queue as if it had been re-measured`);
  }
  assert.equal(oneOf(sqlite, "SELECT COUNT(*) AS n FROM crm_drive_file_version WHERE evidence_class = 'verified_local_recompute'").n, 0,
    'nothing backfilled here may carry a re-verification claim');
  assert.equal(oneOf(sqlite, "SELECT COUNT(*) AS n FROM crm_drive_file_registry WHERE head_evidence_class = 'verified_local_recompute'").n, 0);
  assert.equal(oneOf(sqlite, 'SELECT status_without_version AS n FROM crm_drive_version_invariant_violations').n, 0,
    'no row left unreviewable — the point of the whole exercise');

  // every fingerprint still belongs to its file, unchanged, and the projection equals it
  const reg = sqlite.prepare('SELECT drive_file_id AS id, content_sha256 AS d, drive_ref AS ref, head_version_seq AS h FROM crm_drive_file_registry ORDER BY id').all();
  assert.equal(reg.length, 2);
  for (const r of reg) {
    assert.equal(r.ref, driveRefFor(r.id), 'the seeded anchor is the repo key');
    assert.equal(r.ref, await deriveDriveRef(r.id), '…and the key the service itself would have written');
    assert.equal(r.h, 1);
    assert.equal(oneOf(sqlite, `SELECT content_sha256 AS d FROM crm_drive_file_version WHERE drive_ref = '${r.ref}'`).d, r.d,
      'the head version carries exactly the fingerprint the registry projected');
  }
  // the review path opens for a file that was previously sealed shut — the same insert that was refused a
  // moment ago now lands, because a recorded version exists for it
  const ref = reg[0].ref;
  const head = oneOf(sqlite, `SELECT head_version_seq AS h, content_sha256 AS c FROM crm_drive_file_registry
    WHERE drive_ref = '${ref}'`);
  const snapshot = sha('case-snapshot'), genesis = sha('case-genesis');
  assert.equal(head.h, 1, 'the backfilled version is the head the case must bind to');
  // case_ref is derived by a CHECK, so it is computed here the way the schema computes it
  sqlite.prepare(`INSERT INTO ${caseTable} (case_ref, drive_ref, bound_version_seq, bound_content_sha256,
      review_disposition, status, case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`frw-${ref.slice(0, 16)}-${head.h}`, ref, head.h, head.c,
      'verify_content_digest', 'open', snapshot, genesis, 'intake_pipeline', T1);
  assert.equal(oneOf(sqlite, `SELECT COUNT(*) AS n FROM ${caseTable}`).n, 1,
    'a review case can be opened against the backfilled version — the closure is functional, not cosmetic');
});

test('the seed is idempotent and touches exactly one column', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await legacyRow(db, sqlite, 'LEGACY', 'legacy bytes');
  sqlite.exec(migrationText);
  const fingerprintOf = () => sqlite.prepare(
    'SELECT drive_file_id, content_sha256, processing_status, processing_receipt_ref, extracted_records_count,'
    + ' file_size, file_name, updated_at FROM crm_drive_file_registry ORDER BY drive_file_id',
  ).all().map(r => JSON.stringify(r)).join('\n');
  const before = fingerprintOf();

  const first = renderSeedSql(buildSeedPlan(exportRows(sqlite)));
  assertSeedIsOneColumn(first);
  for (const line of first.split('\n').filter(l => l.startsWith('UPDATE '))) sqlite.exec(line);
  const afterFirst = fingerprintOf();
  assert.equal(afterFirst, before, 'anchoring moved nothing but drive_ref — a status or a fingerprint would show up here');

  const second = buildSeedPlan(exportRows(sqlite));
  assert.equal(summarizeSeed(second).anchored, 0, 'a re-run must plan no writes');
  assert.equal(summarizeSeed(second).already_anchored, 1);
  sqlite.exec(section5);
  assert.equal(oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1, '§5 again adds nothing');
  sqlite.exec(section5);
  assert.equal(oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1, '…a third time either');
});

test('a row anchored to something else is a conflict, and the seed refuses to smooth it over', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await legacyRow(db, sqlite, 'TAMPERED', 'bytes');
  sqlite.exec(migrationText);
  // simulate a row whose handle points at a different Drive object (a copy moved folders, a bad manual fix)
  sqlite.prepare("UPDATE crm_drive_file_registry SET drive_ref = ? WHERE drive_file_id = 'SYNTH-TAMPERED'")
    .run('e'.repeat(64));
  const plan = buildSeedPlan(exportRows(sqlite));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.seeded.length, 0, 'the answer is a human decision, not a silent overwrite');
  assert.equal(summarizeSeed(plan).refused, 0, 'a conflict is its own category, not a malformed row');
  // What §5 then does with a hand-set handle is the honest limit of this design, and this assertion pins it:
  // D1 has no SHA-256, so the migration cannot check that an anchor was *derived* from the id — only that it
  // is well-formed and exists. That is exactly why the seed never overwrites one, and why a conflict has to be
  // resolved by a person before §5 is re-run rather than smoothed over by a tool.
  sqlite.exec(section5);
  assert.equal(oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1);
  assert.equal(oneOf(sqlite, "SELECT COUNT(*) AS n FROM crm_drive_rehash_queue WHERE reason = 'bootstrap_claim_only'").n, 1,
    'the row is recorded, and still reported as an unproven claim — nothing about the conflict was laundered');
  assert.equal(oneOf(sqlite, 'SELECT status_without_version AS n FROM crm_drive_version_invariant_violations').n, 0);
});

test('the migration and the tool agree on the claim vocabulary, and neither invents one', () => {
  assert.match(migrationText, /'bootstrap_backfill', COALESCE\(r\.file_size, 0\)/,
    '§5 must label backfilled versions as what they are');
  const sec5 = section5;
  for (const forbidden of ['verified_local_recompute', 'declared_by_writer']) {
    assert.ok(!sec5.includes(forbidden),
      `the bootstrap section must not reach for “${forbidden}” — it did not measure anything`);
  }
  const toolText = readFileSync(new URL('../../scripts/crm/seed-drive-file-refs.mjs', import.meta.url), 'utf8');
  assert.ok(!toolText.includes('SET processing_status') && !toolText.includes('SET content_sha256'),
    'the seeding tool must have no vocabulary beyond the anchor');
});
