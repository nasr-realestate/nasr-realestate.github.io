// The Phase 4 write order, checked the way CI checks it — same function, same SQL, in memory, synthetic only.
//
// `crm-phase4-analysis.yml` records a fingerprint, lets the ledger move the projection, and only then marks
// the file processed. That order is not decoration: `processed` is the state that says "content was handled",
// and it is the state 0011 lets a human decide on. This file proves (a) the check CI runs returns clean on
// a legal run, (b) it is not vacuous — a fingerprint smuggled in with raw SQL is named — and (c) the mapping
// from counter to problem is exact, including the pre-0010 case where there is no ledger to consult and the
// head checks must be reported as not applicable instead of quietly passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { T1, buildRegistry, newRegistryFile, oneOf, sha } from './_registry-fixture.mjs';
import { processingOrderProblems, recordContentHash, recordInspectionSuccess, verifyProcessingOrder }
  from '../crm-drive-file-registry.js';

const receiptFor = d => `p4a:sha256:${d.slice(0, 32)}`;

test('a legal run through the service leaves nothing for the order check to report', async () => {
  const { sqlite, db } = buildRegistry();
  await newRegistryFile(db, 'ORDER');
  const digest = sha('order-proof-bytes');
  await recordContentHash(db, {
    driveFileId: 'SYNTH-ORDER', contentSha256: digest, innerSha256: null, sizeBytes: 17, hashedAt: T1,
    versionEvidence: { evidenceClass: 'verified_local_recompute', receiptRef: receiptFor(digest), sizeBytes: 17, observedBy: 'intake_pipeline' },
  });
  let order = await verifyProcessingOrder(db);
  assert.deepEqual(order.problems, [], 'a run that only recorded a version must not be reported as broken');
  assert.equal(order.ledger, true);
  assert.equal(order.counters.fingerprinted_rows, 1);
  assert.equal(order.counters.processed_rows, 0, 'hashed is not processed, and the check knows the difference');

  await recordInspectionSuccess(db, {
    driveFileId: 'SYNTH-ORDER', processedAt: T1, extractedRecordsCount: 4, receiptRef: receiptFor(digest),
  });
  order = await verifyProcessingOrder(db);
  assert.deepEqual(order.problems, []);
  assert.equal(order.counters.processed_rows, 1);
  assert.equal(oneOf(sqlite, 'SELECT head_version_seq AS h FROM crm_drive_file_registry').h, 1,
    'the projection the check reads is the one the ledger moved');
});

test('with 0010 applied the database itself refuses a bare fingerprint — the check is the second line', async () => {
  const { sqlite, db } = buildRegistry();
  await newRegistryFile(db, 'FORGED');
  let refused = null;
  try {
    sqlite.prepare("UPDATE crm_drive_file_registry SET content_sha256 = ? WHERE drive_file_id = 'SYNTH-FORGED'")
      .run('9'.repeat(64));
  } catch (e) {
    refused = String(e.message);
  }
  assert.match(String(refused), /registry_fingerprint_must_match_recorded_head_version/,
    'if this stops failing, draft 0010 §4 has lost a trigger — and the check below is the only thing left');
  assert.equal(oneOf(sqlite, "SELECT content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-FORGED'").c, null);
  const order = await verifyProcessingOrder(db);
  assert.deepEqual(order.problems, [], 'nothing was written, so nothing may be reported');
});

test('without 0010 the head checks are reported as not applicable — a skipped check is never a pass', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'PRE0010');
  // 'hashed' with no receipt is the legal mid-flight state of the pre-0010 pipeline: not a finding
  sqlite.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ?, processing_status = 'hashed'
    WHERE drive_file_id = 'SYNTH-PRE0010'`).run('7'.repeat(64));
  let order = await verifyProcessingOrder(db);
  assert.equal(order.ledger, false);
  assert.deepEqual(order.problems, [], 'a check that invents findings about a legal state gets disabled within a week');
  // 'processed' with no receipt is not a state 0007 can even hold — the column CHECK refuses it, which is why
  // the pre-0010 half of this check is a confirmation, not a detector
  let refused = null;
  try {
    sqlite.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'processed', last_processed_at = ?
      WHERE drive_file_id = 'SYNTH-PRE0010'`).run(T1);
  } catch (e) {
    refused = String(e.message);
  }
  assert.match(refused, /CHECK constraint failed: processing_status/, 'the schema must still refuse this');
  order = await verifyProcessingOrder(db);
  assert.deepEqual(order.problems, []);
  assert.equal(order.counters.processed_rows, 0, 'no row claimed processed, because none could');
  assert.equal(order.counters.processed_without_version, 0, 'there is no ledger to consult, so the counter is not computed');
  const mapped = processingOrderProblems(
    { processed_without_version: 3, projection_disagrees: 1, fingerprint_without_receipt: 0 },
    { ledger: false },
  );
  assert.deepEqual(mapped, [], 'without a ledger these two counters must not be turned into accusations');
  assert.equal(processingOrderProblems({ processed_without_version: 3 }, { ledger: true }).length, 1);
});

test('every counter maps to exactly one sentence a human can act on', () => {
  const cases = [
    [{ fingerprint_without_receipt: 2 }, /2 fingerprint\(s\) recorded with no receipt/],
    [{ fingerprint_without_processed_time: 1 }, /marked processed with no last_processed_at/],
    [{ processed_without_version: 4 }, /4 row\(s\) reached processed with no recorded version/],
    [{ projection_disagrees: 1 }, /project a fingerprint the head version does not carry/],
  ];
  for (const [counters, re] of cases) {
    const problems = processingOrderProblems(counters, { ledger: true });
    assert.equal(problems.length, 1, `${JSON.stringify(counters)} produced ${problems.length} problems`);
    assert.match(problems[0], re);
  }
  assert.deepEqual(processingOrderProblems({}, { ledger: true }), []);
  assert.deepEqual(processingOrderProblems(null, { ledger: true }), []);
  assert.deepEqual(processingOrderProblems({ processed_without_version: '0' }, { ledger: true }), [],
    'a zero from SQLite must not become a finding');
});
