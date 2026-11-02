// Local regression tests for the version-ledger service layer (`recordVersion` and its write order) and
// for the barriers draft migration 0010/0011 must keep while the service writes through them.
//
// IN-MEMORY ONLY: no wrangler config is read, no network is touched, no Google Drive call is made, and
// `nasr-crm-test-db`, `nasr-market-db` and the reference backup are never referenced. Every file in the
// fixtures is synthetic (`SYNTH-*` ids, fabricated bytes); the "corrupt"/"wrong" digests are deliberate
// bad input for the validation tests. `npm test` picks this file up with the rest of `_worker/tests`.
//
//   node --test _worker/tests/crm-drive-file-versions.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRegistry } from './_registry-fixture.mjs';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = path.join(workerDir, 'migrations');
const DRAFT_DIR = path.join(workerDir, 'migrations-draft');
const draft = name => {
  const applied = path.join(MIG_DIR, name);
  return existsSync(applied) ? applied : path.join(DRAFT_DIR, name);
};
const DRAFT_0010 = draft('0010_crm_drive_file_versions.sql');
const DRAFT_0011 = draft('0011_crm_drive_file_intake_review.sql');

const {
  DriveRegistryError,
  deriveDriveRef,
  hasVersionLedger,
  insertNewDriveFileStrict,
  listVersions,
  recordContentHash,
  recordInspectionSuccess,
  recordVersion,
  transitionProcessingStatus,
  verifyVersionBinding,
} = await import('../crm-drive-file-registry.js');
const { driveRefHash } = await import('../crm-wa-vcard-analysis.js');

const sha = text => createHash('sha256').update(text).digest('hex');
const T0 = '2026-11-02T09:00:00.000Z';
const T1 = '2026-11-02T12:00:00.000Z';
const T2 = '2026-11-02T15:00:00.000Z';

// ---------------------------------------------------------------- the D1-shaped adapter over node:sqlite
function wrapD1(sqlite, { failOnBatchStep = null } = {}) {
  const makeStmt = (sql, values = []) => ({
    bind: (...next) => makeStmt(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => sqlite.prepare(sql).run(...values),
    _exec: () => sqlite.prepare(sql).run(...values),
    _sql: sql,
  });
  return {
    prepare: sql => makeStmt(sql),
    batch: async statements => {
      sqlite.exec('SAVEPOINT d1_batch');
      try {
        for (let i = 0; i < statements.length; i += 1) {
          if (failOnBatchStep === i) throw new Error('simulated crash after the first statement');
          statements[i]._exec();
        }
        sqlite.exec('RELEASE d1_batch');
      } catch (err) {
        sqlite.exec('ROLLBACK TO d1_batch');
        sqlite.exec('RELEASE d1_batch');
        throw err;
      }
    },
  };
}

// One fixture, in one place. This suite used to keep its own copy of "apply the chain, then the drafts",
// and when 0010 was promoted out of `migrations-draft/` the copy began applying it twice — `duplicate
// column name: drive_ref`, 13 failures that looked like a broken migration and were a stale test harness.
// `buildRegistry` knows that a promoted migration is already in the chain and that `ledger: false` must
// exclude it, so the pre-0010 and post-0010 states stay two different databases either way.
function build({ ledger = true, intake = false, failOnBatchStep = null } = {}) {
  return buildRegistry({ ledger, intake, failOnBatchStep });
}


// one synthetic file, registered the way the intake path registers it
async function newFile(db, tag, { size = 1024, modifiedAt = T0 } = {}) {
  const row = await insertNewDriveFileStrict(db, {
    drive_file_id: `SYNTH-${tag}`,
    file_name: `${tag}.zip`,
    mime_type: 'application/zip',
    file_size: size,
    drive_created_at: '2026-10-01T09:00:00.000Z',
    drive_modified_at: modifiedAt,
    last_seen_at: modifiedAt,
  });
  assert.ok(row, 'the synthetic file must be registered');
  return row;
}

const rows = (sqlite, sql) => sqlite.prepare(sql).all();
const one = (sqlite, sql) => sqlite.prepare(sql).get();

// ---------------------------------------------------------------- 1) the key must be the repo's own key
test('deriveDriveRef is the repo ref scheme, not a private reimplementation', async () => {
  const { db } = build();
  for (const id of ['0800b5e0abc', 'SYNTH-1', 'AbC_-.x9', 'ملف-عميل.zip', 'a'.repeat(180)]) {
    assert.equal(await deriveDriveRef(id), driveRefHash(id), `ref for ${id.slice(0, 8)} must match`);
    assert.match(await deriveDriveRef(id), /^[0-9a-f]{64}$/);
  }
  assert.equal(await hasVersionLedger(db), true);
  const { db: bare } = build({ ledger: false });
  assert.equal(await hasVersionLedger(bare), false, 'the probe reads the catalogue, it does not assume');
});

test('recordVersion refuses rather than writing into a ledger that is not there', async () => {
  const { sqlite, db } = build({ ledger: false });
  const entry = await newFile(db, 'NOLEDGER');
  await assert.rejects(
    () => recordVersion(db, { driveFileId: 'SYNTH-NOLEDGER', contentSha256: sha('x'), sizeBytes: 10, observedAt: T0 }),
    /VERSION_LEDGER_UNAVAILABLE/,
  );
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_registry').n, 1);
  assert.equal(entry.content_sha256, null, 'and the refusal changed nothing');
});

// ---------------------------------------------------------------- 2) the new file, the first version
test('a new file gets exactly one version row, and the fingerprint becomes a projection of it', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'FRESH');
  const digest = sha('the-first-version');
  const out = await recordVersion(db, {
    driveFileId: 'SYNTH-FRESH',
    contentSha256: digest,
    sizeBytes: 1024,
    evidenceClass: 'declared_by_writer',
    observedBy: 'intake_pipeline',
    observedAt: T0,
    driveModifiedAt: T0,
    receiptRef: 'p2v:fresh',
  });
  assert.equal(out.status, 'recorded');
  assert.equal(out.version_seq, 1);
  assert.equal(out.projection, 'aligned');
  assert.equal(out.version_ref, `${out.drive_ref}#1`, 'version_ref is derived, never supplied');
  const ledger = rows(sqlite, 'SELECT * FROM crm_drive_file_version ORDER BY version_seq');
  assert.equal(ledger.length, 1);
  assert.deepEqual(
    { rev: ledger[0].drive_revision, md5: ledger[0].drive_md5 },
    { rev: null, md5: null },
    'revision and md5 stay absent until something observes them — the service must not guess',
  );
  const file = one(sqlite, `SELECT content_sha256 AS s, head_version_seq AS h, versions_observed AS v,
      head_evidence_class AS e, drive_ref AS r FROM crm_drive_file_registry`);
  assert.equal(file.s, digest);
  assert.equal(file.h, 1);
  assert.equal(file.v, 1);
  assert.equal(file.e, 'declared_by_writer');
  assert.equal(file.r, out.drive_ref);
  assert.deepEqual(await verifyVersionBinding(db, 'SYNTH-FRESH'), {
    aligned: true, drive_ref: out.drive_ref, head_version_seq: 1, content_sha256: digest,
    head_evidence_class: 'declared_by_writer', ledger_rows: 1, versions_observed: 1,
  });
});

// ---------------------------------------------------------------- 3) unchanged content, retry safety
test('re-observing the same fingerprint creates no version, moves no counter, and says so', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'SAME');
  const digest = sha('unchanged-bytes');
  const first = await recordVersion(db, { driveFileId: 'SYNTH-SAME', contentSha256: digest, sizeBytes: 1024, observedAt: T0 });
  const again = await recordVersion(db, { driveFileId: 'SYNTH-SAME', contentSha256: digest, sizeBytes: 1024, observedAt: T1 });
  assert.equal(first.status, 'recorded');
  assert.equal(again.status, 'unchanged');
  assert.equal(again.version_seq, 1, 'an unchanged file keeps its head');
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1);
  assert.equal(one(sqlite, 'SELECT versions_observed AS v FROM crm_drive_file_registry').v, 1);
  // eleven retries of the same request: the answer is stable and the ledger does not grow
  for (let i = 0; i < 11; i += 1) {
    const retry = await recordVersion(db, { driveFileId: 'SYNTH-SAME', contentSha256: digest, sizeBytes: 1024, observedAt: T2 });
    assert.equal(retry.status, 'unchanged');
  }
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1);
});

// ---------------------------------------------------------------- 4) a content change, and A->B->A
test('changed bytes at an identical size and an identical modifiedTime are still a new version', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'SWAP');
  const a = sha('content-A');
  const b = sha('content-B');
  await recordVersion(db, { driveFileId: 'SYNTH-SWAP', contentSha256: a, sizeBytes: 1024, driveModifiedAt: T0, observedAt: T0 });
  const out = await recordVersion(db, { driveFileId: 'SYNTH-SWAP', contentSha256: b, sizeBytes: 1024, driveModifiedAt: T0, observedAt: T1 });
  assert.equal(out.status, 'recorded');
  assert.equal(out.version_seq, 2);
  const history = rows(sqlite, 'SELECT version_seq AS s, content_sha256 AS d FROM crm_drive_file_version ORDER BY version_seq');
  assert.deepEqual(history.map(h => h.d), [a, b], 'the previous fingerprint must still be on the record');
  assert.equal(one(sqlite, 'SELECT head_version_seq AS h FROM crm_drive_file_registry').h, 2);
});

test('A -> B -> A keeps three rows, marks the return, and never resurrects or overwrites', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'ABA');
  const a = sha('content-A'), b = sha('content-B');
  const ref = await deriveDriveRef('SYNTH-ABA');
  await recordVersion(db, { driveFileId: 'SYNTH-ABA', contentSha256: a, sizeBytes: 10, observedAt: T0 });
  await recordVersion(db, { driveFileId: 'SYNTH-ABA', contentSha256: b, sizeBytes: 11, observedAt: T1 });
  const back = await recordVersion(db, { driveFileId: 'SYNTH-ABA', contentSha256: a, sizeBytes: 10, observedAt: T2 });
  assert.equal(back.status, 'recorded');
  assert.equal(back.version_seq, 3);
  assert.equal(back.repeat_of_version_ref, `${ref}#1`, 'a repeat must point at the earliest row carrying the digest');
  const all = rows(sqlite, 'SELECT version_seq AS s, content_sha256 AS d, repeat_of_version_ref AS r FROM crm_drive_file_version ORDER BY version_seq');
  assert.deepEqual(all.map(x => x.d), [a, b, a]);
  assert.deepEqual(all.map(x => x.r), [null, null, `${ref}#1`]);
  assert.equal(one(sqlite, 'SELECT COUNT(DISTINCT content_sha256) AS n FROM crm_drive_file_version').n, 2);
  assert.equal(one(sqlite, 'SELECT versions_observed AS v FROM crm_drive_file_registry').v, 3);
});

// ---------------------------------------------------------------- 5) the fingerprint is verified first
test('a digest that the handed-over bytes do not carry is refused before anything is written', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'BYTES');
  const bytes = new TextEncoder().encode('the real content');
  const honest = await sha256Of(bytes);
  await assert.rejects(
    () => recordVersion(db, {
      driveFileId: 'SYNTH-BYTES', contentSha256: sha('a different content'), sourceBytes: bytes, sizeBytes: 16, observedAt: T0,
    }),
    /DIGEST_MISMATCH/,
  );
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 0);
  assert.equal(one(sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, null);
  const ok = await recordVersion(db, {
    driveFileId: 'SYNTH-BYTES', contentSha256: honest, sourceBytes: bytes, sizeBytes: 16, observedAt: T0,
    receiptRef: 'recompute:run-1',
  });
  assert.equal(ok.evidence_class, 'verified_local_recompute', 'bytes in hand is what makes it a measurement');
});

test('malformed, claimed, or lazy fingerprints are refused with a code, not a stack trace', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'BAD');
  const base = { driveFileId: 'SYNTH-BAD', sizeBytes: 10, observedAt: T0 };
  const refused = [
    ['a digest that is not hex at all', { ...base, contentSha256: 'zzzz' }, /INVALID_SHA256_DIGEST/],
    ['a 63-character digest', { ...base, contentSha256: 'a'.repeat(63) }, /INVALID_SHA256_DIGEST/],
    ['no digest at all', { ...base, contentSha256: null }, /MISSING_CONTENT_SHA256/],
    ['the empty-input digest filed against a 10-byte file', { ...base, contentSha256: sha('') }, /DIGEST_OF_EMPTY_INPUT/],
    ['no size, so nothing was observed', { ...base, contentSha256: sha('x'), sizeBytes: null }, /INVALID_FILE_SIZE/],
    ['an evidence class that does not exist', { ...base, contentSha256: sha('x'), evidenceClass: 'guessed' }, /INVALID_EVIDENCE_CLASS/],
    ['an observer outside the four recording paths', { ...base, contentSha256: sha('x'), observedBy: 'cron' }, /INVALID_OBSERVER/],
    ['a revision that is not digits', { ...base, contentSha256: sha('x'), driveRevision: 'r-7' }, /INVALID_DRIVE_REVISION/],
    ['an md5 of the wrong length', { ...base, contentSha256: sha('x'), driveMd5: 'ab' }, /INVALID_DRIVE_MD5/],
    ['a receipt ref with a space in it', { ...base, contentSha256: sha('x'), receiptRef: 'no good' }, /INVALID_RECEIPT_REF/],
    ['a timestamp that is not a timestamp', { ...base, contentSha256: sha('x'), observedAt: 'yesterday' }, /INVALID_OBSERVED_AT/],
    ['a measurement claim with neither bytes nor a receipt', { ...base, contentSha256: sha('x'),
      evidenceClass: 'verified_local_recompute' }, /MISSING_RECOMPUTE_BYTES/],
    ['a measurement claim with a malformed receipt and no bytes', { ...base, contentSha256: sha('x'),
      evidenceClass: 'verified_local_recompute', receiptRef: 'not: a receipt' }, /MISSING_RECOMPUTE_BYTES/],
    ['a measurement with bytes but no receipt to check', { ...base, contentSha256: sha('x'),
      sourceBytes: new TextEncoder().encode('x'), sizeBytes: 1 }, /MISSING_RECOMPUTE_RECEIPT/],
  ];
  for (const [label, input, code] of refused) {
    const err = await recordVersion(db, input).then(() => null, e => e);
    assert.ok(err instanceof DriveRegistryError, `${label} must be refused`);
    assert.match(`${err.code}: ${err.technicalMessage}`, code, label);
  }
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 0, 'none of that wrote a version');
  assert.equal(one(sqlite, 'SELECT drive_ref AS r FROM crm_drive_file_registry').r, null,
    'not even the handle was provisioned for a rejected write');
});

// ---------------------------------------------------------------- 6) partial failure, DB failure
test('a crash between the version row and the projection leaves neither — then a retry converges', async () => {
  const crashed = build({ failOnBatchStep: 1 });
  await newFile(crashed.db, 'CRASH');
  const digest = sha('crash-content');
  await assert.rejects(
    () => recordVersion(crashed.db, { driveFileId: 'SYNTH-CRASH', contentSha256: digest, sizeBytes: 10, observedAt: T0 }),
    /simulated crash/,
  );
  assert.equal(one(crashed.sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 0, 'the version row rolled back');
  assert.equal(one(crashed.sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, null, 'so nothing dangles');

  // the retry runs against the same file, with the crash removed: it must land once and only once
  const sqlite = crashed.sqlite;
  const db = wrapD1(sqlite);
  const out = await recordVersion(db, { driveFileId: 'SYNTH-CRASH', contentSha256: digest, sizeBytes: 10, observedAt: T0 });
  assert.equal(out.status, 'recorded');
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1);
  assert.equal(one(sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, digest);
  const again = await recordVersion(db, { driveFileId: 'SYNTH-CRASH', contentSha256: digest, sizeBytes: 10, observedAt: T1 });
  assert.equal(again.status, 'unchanged');
});

test('a database that fails mid-write reports failure, and no success is claimed', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'DBDOWN');
  const broken = {
    prepare: sql => ({
      bind: (...v) => ({
        first: () => db.prepare(sql).bind(...v).first(),
        all: () => db.prepare(sql).bind(...v).all(),
        run: () => { throw new Error('D1 unavailable'); },
      }),
    }),
    batch: statements => db.batch(statements),
  };
  await assert.rejects(
    () => recordVersion(broken, { driveFileId: 'SYNTH-DBDOWN', contentSha256: sha('x'), sizeBytes: 10, observedAt: T0 }),
    /D1 unavailable/,
  );
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 0);
  await assert.rejects(
    () => recordVersion({ prepare: () => { throw new Error('D1 unavailable'); } }, {
      driveFileId: 'SYNTH-DBDOWN', contentSha256: sha('x'), sizeBytes: 10, observedAt: T0,
    }),
    /VERSION_LEDGER_UNAVAILABLE/,
    'a database that cannot even answer the probe is treated as no ledger, not as an empty one',
  );
});

// ---------------------------------------------------------------- 7) two writers at once
test('two writers on one file: the loser adopts the winner row, and never leaves a gap or a duplicate', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'RACE');
  const ref = await deriveDriveRef('SYNTH-RACE');
  const mine = sha('my content');
  const theirs = sha('their content');
  const third = sha('third content');

  // (a) a competitor appends the very same digest while my batch is being built, so my insert loses the
  //     race on sequence number. The right answer is not "two rows": it is their row, plus the projection
  //     my write would have made.
  const racing = wrapD1(sqlite, {});
  const originalBatch = racing.batch;
  let rivalDone = false;
  racing.batch = async statements => {
    if (!rivalDone) {
      rivalDone = true;
      sqlite.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
        evidence_class, size_bytes, observed_at, observed_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(`${ref}#1`, ref, 1, mine, 'declared_by_writer', 10, T0, 'reconciliation');
    }
    return originalBatch(statements);
  };
  const out = await recordVersion(racing, { driveFileId: 'SYNTH-RACE', contentSha256: mine, sizeBytes: 10, observedAt: T0 });
  assert.equal(out.status, 'already_recorded');
  assert.equal(out.version_seq, 1);
  assert.equal(out.projection, 'aligned');
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1, 'one row, not two');
  assert.equal(one(sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, mine,
    'and the file row was brought up to the head the winner wrote');
  assert.deepEqual(await verifyVersionBinding(db, 'SYNTH-RACE'), {
    aligned: true, drive_ref: ref, head_version_seq: 1, content_sha256: mine,
    head_evidence_class: 'declared_by_writer', ledger_rows: 1, versions_observed: 1,
  });

  // (b) a competitor appends *different* bytes in the same window: my row must land on top of theirs,
  //     densely, so both writers' history survives and no sequence number is reused.
  const racing2 = wrapD1(sqlite, {});
  const original2 = racing2.batch;
  let rival2 = false;
  racing2.batch = async statements => {
    if (!rival2) {
      rival2 = true;
      sqlite.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
        evidence_class, size_bytes, observed_at, observed_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(`${ref}#2`, ref, 2, theirs, 'declared_by_writer', 10, T1, 'reconciliation');
    }
    return original2(statements);
  };
  const second = await recordVersion(racing2, { driveFileId: 'SYNTH-RACE', contentSha256: third, sizeBytes: 12, observedAt: T2 });
  assert.equal(second.status, 'recorded');
  assert.equal(second.version_seq, 3);
  const seqs = rows(sqlite, 'SELECT version_seq AS s FROM crm_drive_file_version ORDER BY version_seq').map(r => r.s);
  assert.deepEqual(seqs, [1, 2, 3], 'dense: no gap, no duplicate slot, no lost write');
  assert.deepEqual(
    rows(sqlite, 'SELECT content_sha256 AS d FROM crm_drive_file_version ORDER BY version_seq').map(r => r.d),
    [mine, theirs, third],
  );
});

// ---------------------------------------------------------------- 8) the `processed` gate
test('processed is unreachable while the file row has no head version to point at', async () => {
  const { sqlite, db } = build();
  const digest = sha('gate-content');
  // a row that arrived with a fingerprint and no ledger behind it — the shape of a mirrored or promoted
  // row before 0010's bootstrap runs. It is a legal row; it is not a legal basis for "processed".
  sqlite.prepare(`INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name,
      mime_type, content_type, processing_status, content_sha256, file_size, drive_created_at,
      drive_modified_at, last_seen_at, created_at, updated_at)
    VALUES ('gate1','SYNTH-GATE','g.zip','g.zip','application/zip','ZIP','metadata_scanned',?,10,?,?,?,?,?)`)
    .run(digest, T0, T0, T0, T0, T0);
  await assert.rejects(
    () => recordInspectionSuccess(db, {
      driveFileId: 'SYNTH-GATE', processedAt: T1, receiptRef: 'p2v:gate', extractedRecordsCount: 1,
    }),
    /VERSION_BINDING_MISSING/,
    'a fingerprint with no recorded version is not evidence of processing',
  );
  assert.equal(one(sqlite, 'SELECT processing_status AS s FROM crm_drive_file_registry').s, 'metadata_scanned');
  assert.throws(() => sqlite.prepare("UPDATE crm_drive_file_registry SET processing_status = 'hashed' WHERE id = 'gate1'").run(),
    /status_requires_a_recorded_version/, 'and the schema refuses the same step from the other side');
  assert.throws(() => sqlite.prepare('UPDATE crm_drive_file_registry SET content_sha256 = ? WHERE id = ?')
    .run(sha('rewritten'), 'gate1'), /registry_fingerprint_must_match_recorded_head_version/,
    'nor can that orphan fingerprint be re-pointed at a version nobody recorded');

  // the service path: the legacy entry point now goes through the ledger, and that is what opens the gate
  const hashed = await recordContentHash(db, { driveFileId: 'SYNTH-GATE', contentSha256: digest, hashedAt: T0 });
  assert.equal(hashed.processing_status, 'hashed');
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1,
    'the orphan fingerprint became version 1 — no second row was created for a digest that was already there');
  const done = await recordInspectionSuccess(db, {
    driveFileId: 'SYNTH-GATE', processedAt: T1, receiptRef: 'p2v:gate', extractedRecordsCount: 1,
  });
  assert.equal(done.processing_status, 'processed');
  assert.equal(one(sqlite, 'SELECT head_version_seq AS h FROM crm_drive_file_registry').h, 1);
  assert.equal(one(sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, digest,
    'the digest itself was never rewritten — the version row is what made it a fact');
});

test('a head version that moved past the projected fingerprint blocks the state, and a retry converges', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'DRIFT');
  const digest = sha('drift-content');
  // the legacy entry point, now wired through the ledger: this call records version 1 and then hashes
  await recordContentHash(db, { driveFileId: 'SYNTH-DRIFT', contentSha256: digest, hashedAt: T0 });
  assert.equal(one(sqlite, 'SELECT processing_status AS s FROM crm_drive_file_registry').s, 'hashed');
  const ref = await deriveDriveRef('SYNTH-DRIFT');
  // a bare ledger write (a promotion script, a rival build) advances the head without the projection
  sqlite.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
    evidence_class, size_bytes, observed_at, observed_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(`${ref}#2`, ref, 2, sha('drift-new'), 'declared_by_writer', 11, T1, 'reconciliation');
  await assert.rejects(
    () => recordInspectionSuccess(db, {
      driveFileId: 'SYNTH-DRIFT', processedAt: T2, receiptRef: 'p2v:drift', extractedRecordsCount: 1,
    }),
    /VERSION_BINDING_MISMATCH/,
    'the projected fingerprint is no longer the head, so "processed" would be a lie',
  );
  const fixed = await recordVersion(db, {
    driveFileId: 'SYNTH-DRIFT', contentSha256: sha('drift-new'), sizeBytes: 11, observedAt: T2,
  });
  assert.equal(fixed.status, 'projection_repaired');
  assert.equal(one(sqlite, 'SELECT content_sha256 AS s FROM crm_drive_file_registry').s, sha('drift-new'));
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 2, 'no third row was invented');
  const done = await recordInspectionSuccess(db, {
    driveFileId: 'SYNTH-DRIFT', processedAt: T2, receiptRef: 'p2v:drift', extractedRecordsCount: 1,
  });
  assert.equal(done.processing_status, 'processed');
});

// ---------------------------------------------------------------- 9) history cannot be lost
test('five writes keep every version, and the ledger refuses having any of them edited or erased', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'KEEP');
  const ref = await deriveDriveRef('SYNTH-KEEP');
  const digests = [];
  for (let i = 0; i < 4; i += 1) {
    const d = sha(`content-${i}`);
    digests.push(d);
    const out = await recordVersion(db, { driveFileId: 'SYNTH-KEEP', contentSha256: d, sizeBytes: 100 + i, observedAt: `2026-11-0${2 + i}T09:00:00.000Z` });
    assert.equal(out.version_seq, i + 1);
  }
  const listed = await listVersions(db, 'SYNTH-KEEP');
  assert.deepEqual(listed.map(v => v.content_sha256), digests, 'listVersions must show all of them, oldest first');
  const refRow = listed[1];
  assert.throws(() => sqlite.prepare('UPDATE crm_drive_file_version SET content_sha256 = ? WHERE version_ref = ?')
    .run('e'.repeat(64), `${ref}#2`), /drive_versions_are_append_only/);
  assert.throws(() => sqlite.prepare('DELETE FROM crm_drive_file_version WHERE version_ref = ?').run(`${ref}#1`),
    /drive_versions_are_append_only/);
  assert.throws(() => sqlite.prepare('UPDATE crm_drive_file_registry SET head_version_seq = 1 WHERE drive_ref = ?').run(ref),
    /registry_head_must_match_ledger|registry_head_is_maintained_by_the_ledger/);
  assert.equal(refRow.size_bytes, 101, 'and the row that stayed is the row that was written');
});

// ---------------------------------------------------------------- 10) the legacy path, unchanged
test('recordContentHash still works exactly as before when 0010 is not applied', async () => {
  const { sqlite, db } = build({ ledger: false });
  await newFile(db, 'LEGACY');
  const digest = sha('legacy');
  const entry = await recordContentHash(db, { driveFileId: 'SYNTH-LEGACY', contentSha256: digest, hashedAt: T0 });
  assert.equal(entry.processing_status, 'hashed');
  assert.equal(entry.content_sha256, digest);
  assert.throws(() => sqlite.prepare('SELECT * FROM crm_drive_file_version').get(), /no such table/);
  // and on a ledger database it now goes through the version path instead of overwriting a fact
  const ledged = build();
  await newFile(ledged.db, 'MODERN');
  const modern = await recordContentHash(ledged.db, { driveFileId: 'SYNTH-MODERN', contentSha256: digest, hashedAt: T0 });
  assert.equal(modern.processing_status, 'hashed');
  assert.equal(rows(ledged.sqlite, 'SELECT * FROM crm_drive_file_version').length, 1);
  const again = await recordContentHash(ledged.db, { driveFileId: 'SYNTH-MODERN', contentSha256: sha('other'), hashedAt: T1 });
  assert.equal(again.processing_status, 'hashed');
  assert.equal(rows(ledged.sqlite, 'SELECT * FROM crm_drive_file_version').length, 2, 'the old digest is not replaced');
  assert.deepEqual(rows(ledged.sqlite, 'SELECT content_sha256 AS d FROM crm_drive_file_version ORDER BY version_seq').map(r => r.d),
    [digest, sha('other')]);
});

// ---------------------------------------------------------------- 11) 0011 can read what 0010 recorded
test('0011 opens a contact-less review case against a version this service recorded', async () => {
  const { sqlite, db } = build({ intake: true });
  await newFile(db, 'CASE');
  const out = await recordVersion(db, {
    driveFileId: 'SYNTH-CASE', contentSha256: sha('case-content'), sizeBytes: 10, observedAt: T0,
  });
  const caseRef = `frw-${out.drive_ref.slice(0, 16)}-1`;
  sqlite.prepare(`INSERT INTO crm_drive_file_review_case (case_ref, drive_ref, bound_version_seq,
      bound_content_sha256, review_disposition, case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
    VALUES (?, ?, 1, ?, 'verify_content_digest', ?, ?, 'intake_pipeline', ?)`)
    .run(caseRef, out.drive_ref, sha('case-content'), 'b'.repeat(64), 'a'.repeat(64), T1);
  const caseRow = { ...one(sqlite, 'SELECT crm_contact_id AS c, link_state AS l, status AS s FROM crm_drive_file_review_case') };
  assert.deepEqual(caseRow, { c: null, l: 'none', s: 'open' }, 'a case with no contact, and no invented link');
  assert.throws(() => sqlite.prepare(`INSERT INTO crm_drive_file_review_case (case_ref, drive_ref, bound_version_seq,
      bound_content_sha256, review_disposition, case_snapshot_sha256, genesis_sha256, opened_by, opened_at, crm_contact_id)
    VALUES ('frw-x-2', ?, 1, 'c', 'register_new_file', ?, ?, 'manual_review', ?, 'contact-12345678')`)
    .run(out.drive_ref, 'b'.repeat(64), 'a'.repeat(64), T1), /file_review_link_requires_a_recorded_decision/,
    'the same case born linked is still refused');
});

async function sha256Of(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

test('the ledger probe is re-asked while it says no, and cached once it says yes', async () => {
  const { sqlite, db } = build({ ledger: false });
  await newFile(db, 'FRESH');
  assert.equal(await hasVersionLedger(db), false, 'a database without 0010 has no ledger');
  // the migration lands underneath a long-lived connection — exactly what happens to a warm isolate
  // during a rollout, and the reason a negative answer must not be remembered
  sqlite.exec(readFileSync(DRAFT_0010, 'utf8'));
  assert.equal(await hasVersionLedger(db), true, 'a stale "no" must not outlive the migration');
  assert.equal(await hasVersionLedger(db), true, 'and the positive answer keeps working');
  const out = await recordVersion(db, { driveFileId: 'SYNTH-FRESH', contentSha256: sha('post-migration'),
    sizeBytes: 1024, observedAt: T0 });
  assert.equal(out.status, 'recorded', 'the first version after the rollout is written, not refused');
  assert.equal(await hasVersionLedger({ prepare() { throw new Error('binding is broken'); } }), false,
    'a database that cannot answer is reported as having no ledger, not as an empty one');
});

test('the walk the intake runner performs records a version before it claims processed', async () => {
  const { sqlite, db } = build();
  await newFile(db, 'INTAKE');
  const digest = sha('intake-bytes');
  // .github/workflows/crm-phase4-analysis.yml with 0010 applied: no intermediate `downloaded` state,
  // recordContentHash writes the ledger row, and the strong evidence class arrives as a receipt
  // because the runner is the one that hashed the bytes.
  const hashed = await recordContentHash(db, {
    driveFileId: 'SYNTH-INTAKE',
    contentSha256: digest,
    hashedAt: T0,
    versionEvidence: {
      evidenceClass: 'verified_local_recompute',
      receiptRef: 'p4:run/intake',
      sizeBytes: 1024,
      driveModifiedAt: T0,
      observedBy: 'intake_pipeline',
    },
  });
  assert.equal(hashed.processing_status, 'hashed');
  const v = one(sqlite, 'SELECT evidence_class AS e, receipt_ref AS r, size_bytes AS n FROM crm_drive_file_version');
  assert.equal(v.e, 'verified_local_recompute', 'a caller that measured is not recorded as guessing');
  assert.equal(v.r, 'p4:run/intake');
  assert.equal(v.n, 1024);
  const done = await recordInspectionSuccess(db, {
    driveFileId: 'SYNTH-INTAKE', processedAt: T1, receiptRef: 'p4:run/intake', extractedRecordsCount: 3,
  });
  assert.equal(done.processing_status, 'processed');
  assert.equal(one(sqlite, 'SELECT COUNT(*) AS n FROM crm_drive_file_version').n, 1, 'one version, from one run');

  // and the same runner without 0010 keeps the walk it has always done, `downloaded` step included
  const legacy = build({ ledger: false });
  await newFile(legacy.db, 'LEGACY');
  await transitionProcessingStatus(legacy.db, { driveFileId: 'SYNTH-LEGACY', toStatus: 'downloaded', updatedAt: T0 });
  const legacyHash = await recordContentHash(legacy.db, {
    driveFileId: 'SYNTH-LEGACY', contentSha256: digest, hashedAt: T1,
    versionEvidence: { evidenceClass: 'verified_local_recompute', receiptRef: 'p4:legacy' },
  });
  assert.equal(legacyHash.processing_status, 'hashed', 'the extra evidence is inert without a ledger');
  assert.equal(legacyHash.content_sha256, digest);
  assert.equal(legacy.sqlite.prepare('SELECT COUNT(*) AS n FROM crm_drive_file_registry').get().n, 1);
  assert.equal(legacy.sqlite.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
    WHERE name = 'crm_drive_file_version'`).get().n, 0, 'and no ledger was conjured into existence');
});

test('a strong evidence claim with neither bytes nor a receipt is still a refusal', async () => {
  const { db } = build();
  await newFile(db, 'BARE');
  await assert.rejects(
    () => recordVersion(db, {
      driveFileId: 'SYNTH-BARE', contentSha256: sha('bare-claim'), sizeBytes: 10,
      evidenceClass: 'verified_local_recompute', observedAt: T0,
    }),
    /MISSING_RECOMPUTE_BYTES/,
  );
  await assert.rejects(
    () => recordVersion(db, {
      driveFileId: 'SYNTH-BARE', contentSha256: sha('bare-claim'), sizeBytes: 10, observedAt: T0,
      evidenceClass: 'verified_local_recompute', receiptRef: 'receipt with a space',
    }),
    /MISSING_RECOMPUTE_BYTES/,
    'a malformed receipt does not qualify a claim either',
  );
});
