// One synthetic envelope, driven end-to-end through the sealed Phase 3 path — in memory, no network, no
// database server. This suite exists because of a gap that green CI could not close: `crm-phase3-registry.yml`
// runs its `sync_sealed` mode only when `_worker/ingest-queue/drive-registry-sealed.txt` holds a queued
// envelope, and that file has read `IDLE` since the queue was drained. So the production composition —
// queue line → ECDH open → payload-shape assertion → the real `syncDriveFolderMetadataInventory` → the real
// boundary gate — had never been executed as one piece anywhere. Here it is, on `SYNTH-*` ids, invented sizes
// and digests computed from the string "synthetic …", with no reference to `nasr-crm-test-db-v2` or `nasr-market-db`.
//
// "Pass" in this file is not "the sync ran". It is two things: an envelope either opens and applies or is
// refused before a single statement is issued; and the gate evaluates what the sync actually did, so a
// fingerprint with no provenance fails the run instead of being counted as clean. The last test rehearses the
// post-0010 database, which is what the migration plan's steps 7 and 9 will assert against the real D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPayloadShape, deriveKeyPair, describePayload, openEnvelope, readQueueLine, sealEnvelope, selftest,
} from '../../scripts/crm/drive-registry-envelope.mjs';
import {
  DOCUMENTED_RECEIPT_RE, evaluatePhase3Boundary, registryProvenanceSql,
} from '../../scripts/crm/verify-phase3-metadata-boundary.mjs';
import {
  T0, T1, buildRegistry, newRegistryFile, oneOf, sha,
} from './_registry-fixture.mjs';
import {
  deriveDriveRef, hasVersionLedger, recordVersion, syncDriveFolderMetadataInventory,
} from '../crm-drive-file-registry.js';

const SECRET = 'synthetic-test-secret-0123456789';
const OTHER_SECRET = 'another-synthetic-secret-9876543210';
const PARENT = 'SYNTH-PARENT-FOLDER-ID';
const ID_A = 'SYNTHENVELOPEAAAAAAAAAAAAAAAA01';
const ID_B = 'SYNTHENVELOPEAAAAAAAAAAAAAAAA02';
const ID_C = 'SYNTHENVELOPEAAAAAAAAAAAAAAAA03';
const SCAN_AT = '2026-11-03T09:00:00.000Z';
const BOOTSTRAP_RECEIPT = 'phase2-0010-bootstrap';

const snap = (sqlite, { withLedger = false } = {}) =>
  sqlite.prepare(registryProvenanceSql({ withLedger })).all();
// The columns that exist on every database. `drive_ref` and the head projection are added *by* draft 0010,
// so naming them in a ledger:false test is the same mistake the first version of the CI gate made.
const registryRow = (sqlite, id) =>
  sqlite.prepare(`SELECT drive_file_id, file_name, file_size, content_sha256, processing_status,
    processing_receipt_ref, last_seen_at, drive_modified_at FROM crm_drive_file_registry WHERE drive_file_id = ?`).get(id);
const ledgerRow = (sqlite, id) =>
  sqlite.prepare(`SELECT drive_ref, head_version_seq, versions_observed, head_evidence_class
    FROM crm_drive_file_registry WHERE drive_file_id = ?`).get(id);

const inventory = items => ({ driveParentId: PARENT, scanTimestamp: SCAN_AT, items });

function queueFor(payload, { secret = SECRET, comment = 'synthetic rehearsal queue' } = {}) {
  const { pubSpkiB64u } = deriveKeyPair(secret);
  return `# ${comment}\n${sealEnvelope(payload, pubSpkiB64u)}\n`;
}

/**
 * The `sync_sealed` branch of the workflow, with wrangler and the database it points at taken out: same queue
 * parsing, same key derivation, same shape assertion, same service call, same gate. If the workflow grows a
 * step, this helper is where a divergence would show up as a wrong expectation here.
 */
async function runSealedSync({ sqlite, db, queueText, secret = SECRET, ledger = false }) {
  const line = readQueueLine(queueText);
  if (!line) return { status: 'idle' };
  const payload = assertPayloadShape(openEnvelope(line, deriveKeyPair(secret).privKey));
  const before = snap(sqlite, { withLedger: ledger });
  const sync = await syncDriveFolderMetadataInventory(db, payload);
  const after = snap(sqlite, { withLedger: ledger });
  const verdict = evaluatePhase3Boundary({ before, after, withLedger: ledger });
  return { status: 'applied', sync, verdict, before, after, summary: describePayload(payload) };
}

test('the envelope codec holds its 13 barriers, so everything below rests on a checked primitive', () => {
  const checks = selftest();
  assert.equal(checks.length, 13, 'the codec grew or shrank — the sync path inherits every one of these rules');
  for (const [ok, name, note] of checks.filter(c => !c[0])) assert.fail(`${name} — ${note}`);
});

test('one synthetic envelope opens, applies, and the gate passes on a database with no ledger', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'EXISTING-A', { size: 1024, parentId: PARENT });
  assert.equal(registryRow(sqlite, `SYNTH-EXISTING-A`).drive_file_id, 'SYNTH-EXISTING-A');

  const payload = inventory([
    // (1) already registered and the folder moved on: size and modified time are the only things it may say
    { drive_file_id: `SYNTH-EXISTING-A`, file_name: 'a.zip', mime_type: 'application/zip', file_size: 2048,
      created_time: T0, modified_time: T1, metadata: { name_verified: false } },
    // (2) new in the folder — the one thing metadata is allowed to create
    { drive_file_id: ID_B, file_name: 'b.vcf', mime_type: 'text/vcard', file_size: 514,
      created_time: T1, modified_time: T1 },
    // (3) unreachable: recorded as a problem, never as a fabricated file
    { drive_file_id: ID_C, unreachable: true, error_code: 'DRIVE_METADATA_UNREACHABLE',
      error_message: 'metadata call returned 404' },
  ]);
  const run = await runSealedSync({ sqlite, db, queueText: queueFor(payload) });

  assert.equal(run.status, 'applied', 'a queued envelope must be applied, not reported as idle');
  assert.equal(run.verdict.ok, true, `the gate refused a legal metadata pass: ${run.verdict.problems.join('; ')}`);
  assert.equal(run.sync.inserted, 1, 'the file that is new to the folder is the only row it may create');
  assert.equal(run.sync.updated, 1, 'the known file is refreshed, never re-created');
  assert.equal(run.sync.failed, 1, 'an unreachable id has to be recorded, not dropped');
  assert.equal(run.sync.byContentType.ZIP, 1);
  assert.equal(run.sync.byContentType.VCF, 1);
  // +2, not +1: the unreachable id becomes a row too (`recordInspectionFailure` registers the problem), but
  // it is counted under `failed`, never as an insert — a file that could not be read is not a file that arrived.
  assert.equal(run.after.length, run.before.length + 2, 'one new file and one recorded problem, and nothing else');
  assert.equal(run.verdict.summary.fingerprinted, 0,
    'no row may end a metadata pass holding a fingerprint the pass cannot trace');

  const a = registryRow(sqlite, 'SYNTH-EXISTING-A');
  assert.equal(a.file_size, 2048, 'refreshing metadata is the whole point of the pass');
  assert.equal(a.drive_modified_at, T1);
  assert.equal(a.content_sha256, null, '§5.4.2: size and modifiedTime are not a content fingerprint');
  assert.equal(a.processing_receipt_ref, null, 'a metadata pass leaves no receipt, because it earned none');
  assert.notEqual(a.processing_status, 'hashed', 'metadata may not advance a row into a content state');
  assert.equal(registryRow(sqlite, ID_C).processing_status, 'failed', 'the unreachable id is a row with a status');

  // Applied means consumed: the queue goes back to IDLE, and an idle queue is an idle run — not a green one.
  assert.equal(readQueueLine(queueFor(payload).split('\n')[0] + '\nIDLE\n'), null,
    'a drained queue must read as nothing pending');
  assert.deepEqual(await runSealedSync({ sqlite, db, queueText: '# note\nIDLE\n' }), { status: 'idle' });
});

test('re-running the same inventory is idempotent and never invents a fingerprint', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'EXISTING-A', { size: 1024, parentId: PARENT });
  const payload = inventory([
    { drive_file_id: 'SYNTH-EXISTING-A', file_name: 'a.zip', mime_type: 'application/zip', file_size: 1024,
      created_time: T0, modified_time: T0 },
  ]);

  const first = await runSealedSync({ sqlite, db, queueText: queueFor(payload) });
  const second = await runSealedSync({ sqlite, db, queueText: queueFor(payload) });
  assert.equal(first.verdict.ok, true);
  assert.equal(second.verdict.ok, true, `a repeat scan must not look like a violation: ${second.verdict.problems.join('; ')}`);
  assert.equal(second.after.length, first.after.length, 'the same listing twice must not duplicate rows');
  assert.equal(second.sync.inserted, 0, 'the row exists already; there is nothing to insert');
  assert.equal(second.sync.updated, 1, 'last_seen_at is what a repeat scan is allowed to move');
  assert.equal(second.verdict.summary.fingerprinted, 0);
  assert.deepEqual([...new Set(second.after.map(r => r.digest8))], [null],
    'every row still has exactly one digest: none');
});

test('a metadata envelope cannot move a fingerprint a content phase already recorded', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'HASHED-A', { size: 1024, parentId: PARENT });
  const measured = sha('synthetic file a');
  const id = 'SYNTH-HASHED-A';
  sqlite.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ?, processing_status = 'hashed',
    processing_receipt_ref = ?, drive_modified_at = ? WHERE drive_file_id = ?`)
    .run(measured, BOOTSTRAP_RECEIPT, T0, id);
  const before = snap(sqlite)[0];
  assert.match(before.receipt, DOCUMENTED_RECEIPT_RE, 'the baseline digest is documented, so the run is fair');

  // The envelope a careless operator would send: same id, renamed, resized, older timestamps.
  const run = await runSealedSync({
    sqlite, db,
    queueText: queueFor(inventory([
      { drive_file_id: id, file_name: 'renamed-and-shrunk.zip', mime_type: 'application/zip', file_size: 1,
        created_time: T0, modified_time: T0, metadata: { name_verified: false } },
    ])),
  });

  assert.equal(run.verdict.ok, true, `a legal metadata refresh must not trip the gate: ${run.verdict.problems.join('; ')}`);
  const after = registryRow(sqlite, id);
  assert.equal(after.content_sha256, measured, '§5.4.3: a re-scan refreshes metadata and preserves the recorded digest');
  assert.equal(after.processing_status, 'hashed', 'metadata does not demote or promote a content state');
  assert.equal(after.processing_receipt_ref, BOOTSTRAP_RECEIPT, 'the receipt that documents the digest survives the pass');
  assert.equal(after.file_size, 1, 'the size is the folder truth and is allowed to move');
  assert.equal(after.file_name, 'renamed-and-shrunk.zip', 'a name correction is metadata, not evidence');
  assert.ok(after.last_seen_at > T0, 'the pass has to leave a trace of itself');
});

test('content facts are refused on the way in, and the service would drop them anyway', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  const id = await newRegistryFile(db, 'EXISTING-A', { size: 1024, parentId: PARENT }).then(r => r.drive_file_id);
  const rowsBefore = oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_registry').n;

  const smuggled = {
    drive_file_id: id, file_name: 'a.zip', mime_type: 'application/zip', file_size: 1024,
    created_time: T0, modified_time: T1, content_sha256: sha('hand made'), inner_content_sha256: sha('inner'),
    processing_status: 'processed', processing_receipt_ref: 'p4a:sha256:' + 'f'.repeat(32),
    extracted_records_count: 7, review_status: 'approved',
  };
  const { pubSpkiB64u } = deriveKeyPair(SECRET);
  assert.throws(() => sealEnvelope(inventory([smuggled]), pubSpkiB64u), /content-phase field/,
    'the sealing tool must refuse to encrypt a payload that mixes phases, not wrap it and hope the DB says no');

  // Second line of defence: hand the service the same object directly (bypassing every reviewed tool).
  const verdictBefore = evaluatePhase3Boundary({ before: snap(sqlite), after: snap(sqlite), withLedger: false });
  assert.equal(verdictBefore.ok, true, 'the baseline is clean, so anything the next line changes is attributable');
  const sync = await syncDriveFolderMetadataInventory(db, inventory([smuggled]));
  assert.equal(sync.updated, 1, 'the row was refreshed — that is all the service was willing to do');
  assert.equal(sync.inserted, 0);
  const after = registryRow(sqlite, id);
  assert.equal(after.content_sha256, null, 'a metadata call may not plant a fingerprint, sealed or not');
  assert.equal(after.processing_status, 'metadata_scanned', 'nor may it write a terminal status');
  assert.equal(after.processing_receipt_ref, null, 'nor a receipt that claims a measurement happened');
  assert.equal(oneOf(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_registry').n, rowsBefore);
  assert.equal(evaluatePhase3Boundary({ before: snap(sqlite), after: snap(sqlite), withLedger: false }).ok, true);
});

test('a tampered envelope, or one sealed for someone else, is refused and changes no byte', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  const id = (await newRegistryFile(db, 'EXISTING-A', { size: 1024, parentId: PARENT })).drive_file_id;
  const payload = inventory([
    { drive_file_id: id, file_name: 'a.zip', mime_type: 'application/zip', file_size: 2048,
      created_time: T0, modified_time: T1 },
  ]);
  const untouched = () => registryRow(sqlite, id);
  const snapshotBefore = JSON.stringify(snap(sqlite));

  const [comment, envelope] = queueFor(payload).split('\n');
  const parts = envelope.split('.');
  const raw = Buffer.from(parts[3], 'base64url');
  raw[0] ^= 0x01;
  parts[3] = Buffer.from(raw).toString('base64url');
  await assert.rejects(() => runSealedSync({ sqlite, db, queueText: `${comment}\n${parts.join('.')}\n` }),
    undefined, 'GCM has to reject a single flipped byte, not truncate and continue');
  assert.equal(JSON.stringify(snap(sqlite)), snapshotBefore, 'a refused envelope must be a no-op, not a partial write');
  assert.equal(untouched().file_size, 1024, 'the size the refused envelope carried was not written');

  await assert.rejects(() => runSealedSync({
    sqlite, db, queueText: queueFor(payload, { secret: OTHER_SECRET }), secret: SECRET,
  }), undefined, 'an envelope addressed to another recipient is not ours to open');
  assert.equal(untouched().file_size, 1024);
  assert.equal(JSON.stringify(snap(sqlite)), snapshotBefore);
});

test('the gate, not the sync result, is what fails a run when a digest has no provenance', async () => {
  const { sqlite, db } = buildRegistry({ ledger: false });
  await newRegistryFile(db, 'EXISTING-A', { size: 1024, parentId: PARENT });
  const id = 'SYNTH-EXISTING-A';
  // Someone wrote a fingerprint and a terminal status by hand — the failure mode the old count-based check
  // could never describe, because "not zero" was the whole of its vocabulary.
  sqlite.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ?, processing_status = 'hashed',
    processing_receipt_ref = 'manual' WHERE drive_file_id = ?`).run(sha('hand written'), id);

  const run = await runSealedSync({
    sqlite, db,
    queueText: queueFor(inventory([
      { drive_file_id: id, file_name: 'a.zip', mime_type: 'application/zip', file_size: 1024,
        created_time: T0, modified_time: T1 },
    ])),
  });

  assert.equal(run.sync.updated, 1, 'the metadata pass itself succeeded, which is exactly why it is not the verdict');
  assert.equal(run.verdict.ok, false, 'a fingerprint with no admissible receipt must fail the run');
  assert.ok(run.verdict.problems.some(p => /undocumented|receipt|provenance/i.test(p)),
    `the refusal has to name provenance, got: ${run.verdict.problems.join(' | ')}`);
  assert.ok(!JSON.stringify(run.verdict.problems).includes(id),
    'the message identifies the row by position and digest prefix, never by its Drive id');
});

test('post-0010 rehearsal: the schema refuses what the gate would otherwise have to notice', async () => {
  const { sqlite, db } = buildRegistry({ ledger: true });
  assert.equal(await hasVersionLedger(db), true, 'the probe answers for the database it is handed, never for the plan');
  const row = await newRegistryFile(db, 'LEDGER-A', { size: 1024, parentId: PARENT });
  const id = row.drive_file_id;
  const measured = sha('ledger era file');
  const attempts = `UPDATE crm_drive_file_registry SET content_sha256 = ?, processing_status = 'processed',
    last_processed_at = ?, extracted_records_count = 3, processing_attempts = 1, processing_receipt_ref = NULL
    WHERE drive_file_id = ?`;

  // (a) a terminal status with a fingerprint and no recorded version: impossible, not merely suspicious
  assert.throws(() => sqlite.prepare(attempts).run(measured, T1, id), /status_requires_a_recorded_version/,
    '0010 has to refuse the bypass at the schema, or the bootstrap era depends on everybody behaving');
  assert.equal(registryRow(sqlite, id).content_sha256, null, 'and the refused statement leaves nothing behind');

  // (b) the legal path — one version row, recorded before the status may exist
  const res = await recordVersion(db, {
    driveFileId: id, contentSha256: measured, evidenceClass: 'bootstrap_backfill', sizeBytes: 1024,
    observedBy: 'registry_bootstrap', receiptRef: BOOTSTRAP_RECEIPT, observedAt: T1,
  });
  assert.equal(res.status, 'recorded');
  assert.equal(res.version_seq, 1);
  const anchored = ledgerRow(sqlite, id);
  assert.equal(anchored.drive_ref, await deriveDriveRef(id), 'the one-column ref the bootstrap tool writes is the same ref the service derives');
  assert.equal(registryRow(sqlite, id).content_sha256, measured, 'the fingerprint reaches the row only through the version writer');
  assert.equal(anchored.head_version_seq, 1);
  assert.equal(anchored.versions_observed, 1);
  assert.equal(anchored.head_evidence_class, 'bootstrap_backfill',
    'a backfilled fingerprint is labelled as backfilled, never laundered into a measurement');
  assert.equal(oneOf(sqlite, `SELECT COUNT(*) AS n FROM crm_drive_version_invariant_violations
    WHERE status_without_version <> 0 OR counter_mismatches <> 0 OR seq_gaps <> 0 OR dangling_heads <> 0`).n, 0,
    'step 9 of the migration plan asserts exactly this view');

  // (c) now the status is allowed, because the version exists — and the gate agrees
  sqlite.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'processed', last_processed_at = ?,
    extracted_records_count = 3, processing_attempts = 1, processing_receipt_ref = ?
    WHERE drive_file_id = ?`).run(T1, BOOTSTRAP_RECEIPT, id);
  const afterLedger = snap(sqlite, { withLedger: true });
  const mine = afterLedger.find(r => r.drive_file_id === id);
  assert.equal(mine.head_digest, measured, 'the projection has to agree with the head version it points at');
  assert.equal(evaluatePhase3Boundary({ before: afterLedger, after: afterLedger, withLedger: true }).ok, true);

  // (d) a metadata envelope over that state refreshes metadata, keeps the fingerprint, and the gate holds
  const run = await runSealedSync({
    sqlite, db, ledger: true,
    queueText: queueFor(inventory([
      { drive_file_id: id, file_name: 'renamed-in-folder.zip', mime_type: 'application/zip', file_size: 4096,
        created_time: T0, modified_time: T1 },
    ])),
  });
  assert.equal(run.verdict.ok, true, `the post-migration gate must survive a normal scan: ${run.verdict.problems.join('; ')}`);
  assert.equal(registryRow(sqlite, id).content_sha256, measured);
  assert.equal(registryRow(sqlite, id).file_size, 4096);

  // (e) and a swap away from the head is refused rather than detected: the ledger is the point of 0010
  assert.throws(() => sqlite.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ? WHERE drive_file_id = ?`)
    .run(sha('a different synthetic file'), id), /registry_fingerprint_must_match_recorded_head_version/,
    'with 0010 a silent re-fingerprint is not a policy to check, it is a statement that does not run');
  assert.equal(oneOf(sqlite, `SELECT COUNT(*) AS n FROM crm_drive_file_version`).n, 1,
    'a refused write created no version either — the ledger stays append-only');
});
