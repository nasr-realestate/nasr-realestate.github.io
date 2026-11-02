// Local rehearsal for DRAFT migration 0010 — per-version content tracking for the Drive registry.
//
// IN-MEMORY ONLY: it opens no wrangler config, makes no network call, reads no Drive file, and touches
// neither `nasr-crm-test-db`, nor `nasr-market-db`, nor the reference backup. Its only purpose is to
// prove — before anyone approves applying 0010 — that the DDL itself refuses what the design forbids.
//
//   node _worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs
//
// Exit 0 = every barrier held, every required detection fired, and the reporting views were shown to be
// capable of seeing a violation at all (they are replayed against a trigger-less copy).
//
// Required proofs, numbered as in the task:
//   T1  a content change is detected while size and modifiedTime stay identical
//   T2  a new version is recorded and the previous version survives
//   T3  a wrong or missing fingerprint is refused
//   T6a no operation can lose version history
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the same ref function the registry, the snapshot tool and the discovery plan use — so the rehearsal
// cannot pass against a private reimplementation of the key
import { driveRefHash } from '../../_worker/crm-wa-vcard-analysis.js';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = path.join(workerDir, 'migrations');
const DRAFT_CANDIDATES = [
  path.join(MIG_DIR, '0010_crm_drive_file_versions.sql'),
  path.join(workerDir, 'migrations-draft', '0010_crm_drive_file_versions.sql'),
];
const DRAFT = DRAFT_CANDIDATES.find(p => existsSync(p));
if (!DRAFT) throw new Error('0010 not found in _worker/migrations or _worker/migrations-draft');
const DRAFT_SQL = readFileSync(DRAFT, 'utf8');

const sha = t => createHash('sha256').update(t).digest('hex');
const SIZE = 1024;
const MTIM = '2026-11-02T09:00:00.000Z';
const LATER = '2026-11-02T12:00:00.000Z';
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- isolated database
function build({ applyDraft = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT,
      title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
      bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL);
  `);
  const applied = [];
  for (const file of readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(path.join(MIG_DIR, file), 'utf8')); applied.push(file.slice(0, 4)); }
    catch { /* migrations that need tables this rehearsal does not model are skipped, as in 0009's */ }
  }
  if (!applied.includes('0007')) throw new Error('0007 (the registry) must apply for this to mean anything');
  if (applyDraft) db.exec(DRAFT_SQL);
  return { db, applied };
}
const { db, applied } = build();

// ---------------------------------------------------------------- assertions
const results = [];
const pass = label => results.push({ ok: true, label });
const fail = (label, detail) => results.push({ ok: false, label, detail });
function expectFail(label, fn, fragment) {
  try {
    fn();
    fail(label, 'the write SUCCEEDED — barrier missing');
  } catch (error) {
    const msg = String((error && error.message) || error);
    const held = fragment instanceof RegExp ? fragment.test(msg) : (!fragment || msg.includes(fragment));
    if (!held) fail(label, `refused for the wrong reason: ${msg.slice(0, 150)}`);
    else pass(`${label} [${typeof fragment === 'string' ? fragment : 'refused'}]`);
  }
}
function expectOk(label, fn) {
  try { fn(); pass(`${label} [allowed]`); }
  catch (error) { fail(label, `expected success: ${String((error && error.message) || error).slice(0, 150)}`); }
}
const one = sql => db.prepare(sql).get();
const rows = (ref) => db.prepare('SELECT version_seq, content_sha256, evidence_class FROM crm_drive_file_version WHERE drive_ref = ? ORDER BY version_seq').all(ref);

// ---------------------------------------------------------------- fixtures
// The order is the design: a file row is created at a metadata status, the content state is APPENDED
// to the version ledger, and only then may the file row advance. (This is precisely the change T2 asks
// of _worker/crm-drive-file-registry.js, whose recordContentHash currently does it in one UPDATE.)
let counter = 0;
function newFile({ size = SIZE, mtime = MTIM, digest, label, status = 'metadata_scanned' } = {}) {
  const driveId = `FIXTURE${String(++counter).padStart(4, '0')}`;
  const ref = driveRefHash(driveId);
  const content = digest === undefined ? sha(`${driveId}-content-v1`) : digest;
  db.prepare(`INSERT INTO crm_drive_file_registry
      (id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path, mime_type,
       file_size, drive_created_at, drive_modified_at, content_sha256, content_type, processing_status,
       review_status, last_processed_at, processing_receipt_ref, extracted_records_count,
       processing_attempts, metadata_json, created_at, updated_at, drive_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`reg-${counter}`, driveId, 'FOLDER', label ?? `fixture-${counter}.zip`, `fixture-${counter}.zip`,
      '/rehearsal', 'application/zip', size, mtime, mtime, content, 'ZIP', status, 'not_required',
      mtime, `receipt-${counter}`, 0, 1, '{}', mtime, mtime, ref);
  return { driveId, ref, content, size, mtime };
}
function advanceStatus(ref, to) {
  db.prepare(`UPDATE crm_drive_file_registry SET processing_status = ?, updated_at = ?
               WHERE drive_ref = ?`).run(to, now(), ref);
}
function addVersion({ ref, seq, digest, size = SIZE, mtime = MTIM, observedAt = LATER,
                     evidence = 'verified_local_recompute', receipt = 'receipt-rehearsal',
                     repeatOf = null, revision = null, md5 = null }) {
  db.prepare(`INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes,
       drive_modified_at, observed_at, observed_by, receipt_ref, repeat_of_version_ref,
       drive_revision, drive_md5)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`${ref}#${seq}`, ref, seq, digest, evidence, size, mtime, observedAt,
      evidence === 'bootstrap_backfill' ? 'registry_bootstrap' : 'intake_pipeline', receipt,
      repeatOf, revision, md5);
}
function projectHead({ ref, seq, digest }) {
  db.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ?, updated_at = ?
               WHERE drive_ref = ? AND head_version_seq = ?`).run(digest, now(), ref, seq);
}
const fileA = newFile();
addVersion({ ref: fileA.ref, seq: 1, digest: fileA.content });
advanceStatus(fileA.ref, 'hashed');

// ---------------------------------------------------------------- T2: history is kept
expectOk('T2 head projection after one version', () => {
  const r = one(`SELECT head_version_seq AS h, versions_observed AS n, head_evidence_class AS e,
                        content_sha256 AS c FROM crm_drive_file_registry WHERE drive_ref = '${fileA.ref}'`);
  if (r.h !== 1 || r.n !== 1) throw new Error(`head=${r.h} count=${r.n}`);
  if (r.e !== 'verified_local_recompute') throw new Error('evidence class not projected');
  if (r.c !== fileA.content) throw new Error('projection changed the digest');
});
const v2Digest = sha(`${fileA.driveId}-content-v2`);
expectFail('T2 a second version must APPEND, never replace (seq 1 again)',
  () => addVersion({ ref: fileA.ref, seq: 1, digest: v2Digest }), 'drive_version_seq_not_next');
expectFail('T2 a version may not skip numbers',
  () => addVersion({ ref: fileA.ref, seq: 9, digest: v2Digest }), 'drive_version_seq_not_next');
expectOk('T2 v2 appended as seq 2', () => addVersion({ ref: fileA.ref, seq: 2, digest: v2Digest }));
expectOk('T2 both versions survive with their own digests', () => {
  const all = rows(fileA.ref);
  if (all.length !== 2) throw new Error(`expected 2 version rows, got ${all.length}`);
  if (all[0].content_sha256 !== fileA.content) throw new Error('v1 digest was replaced');
  if (all[1].content_sha256 !== v2Digest) throw new Error('v2 digest not recorded');
});
expectOk('T2 the file row may now be projected onto v2', () => projectHead({ ref: fileA.ref, seq: 2, digest: v2Digest }));
expectOk('T2 v1 is still readable after the projection', () => {
  if (rows(fileA.ref)[0].content_sha256 !== fileA.content) throw new Error('history lost');
});

// ---------------------------------------------------------------- T1: same size + same mtime, new bytes
const fileB = newFile();
addVersion({ ref: fileB.ref, seq: 1, digest: fileB.content });
advanceStatus(fileB.ref, 'hashed');
// bytes change; Drive reports the same size and the same modifiedTime (a same-length in-place edit)
const swapped = sha(`${fileB.driveId}-rewritten-but-same-length`);
if (Buffer.from(swapped, 'hex').length === 0) throw new Error('fixture broken');
expectOk('T1 the swap is recorded as a new version (same size, same mtime)',
  () => addVersion({ ref: fileB.ref, seq: 2, digest: swapped, size: fileB.size, mtime: fileB.mtime }));
expectOk('T1 the ledger reports it as a change the metadata could not see', () => {
  const s = one(`SELECT projection_state AS p, metadata_agreement AS m, metadata_is_silent AS q,
                        head_size_bytes AS hs, registry_size_bytes AS rs, head_modified_at AS hm,
                        registry_modified_at AS rm
                   FROM crm_drive_version_state WHERE drive_ref = '${fileB.ref}'`);
  if (s.p !== 'registry_fingerprint_not_head') throw new Error(`projection_state=${s.p}`);
  if (s.m !== 'changed_under_identical_metadata') throw new Error(`metadata_agreement=${s.m}`);
  if (s.hs !== s.rs || s.hm !== s.rm) throw new Error('the fixture is not actually metadata-identical');
});
expectFail('T1 the registry may not be advanced onto a digest that is not the head',
  () => db.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = ? WHERE drive_ref = ?`)
    .run(sha('a-claim-with-no-version-row'), fileB.ref),
  'registry_fingerprint_must_match_recorded_head_version');
expectOk('T1 once v2 is head, the projection is legal', () => projectHead({ ref: fileB.ref, seq: 2, digest: swapped }));
expectOk('T1 and the state reads aligned again', () => {
  const s = one(`SELECT projection_state AS p FROM crm_drive_version_state WHERE drive_ref = '${fileB.ref}'`);
  if (s.p !== 'aligned') throw new Error(`projection_state=${s.p}`);
});

// ---------------------------------------------------------------- metadata alone concludes nothing
const fileC = newFile({ status: 'metadata_scanned', digest: null });
expectOk('T1 a metadata-only file has no version row and is queued for bytes', () => {
  const n = one(`SELECT COUNT(*) AS c FROM crm_drive_file_version WHERE drive_ref = '${fileC.ref}'`).c;
  if (n !== 0) throw new Error('a metadata-only walk created a version row');
  const q = one(`SELECT reason AS r FROM crm_drive_rehash_queue WHERE drive_ref = '${fileC.ref}'`);
  if (!q || q.r !== 'no_version_row') throw new Error(`rehash_queue=${q && q.r}`);
});
expectFail('T1 metadata equality cannot mark the file downloaded/hashed/processed',
  () => db.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'processed'
                     WHERE drive_ref = '${fileC.ref}'`).run(),
  'status_requires_a_recorded_version');
expectFail('T1 not even via the download step',
  () => db.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'downloaded'
                     WHERE drive_ref = '${fileC.ref}'`).run(),
  'status_requires_a_recorded_version');
expectFail('T1 a version row cannot be created for a file with no recorded digest',
  () => addVersion({ ref: fileC.ref, seq: 1, digest: sha('claim') }), 'drive_version_ref_not_registered');

// ---------------------------------------------------------------- T3: fingerprint hygiene
expectFail('T3 a missing digest is refused',
  () => db.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, evidence_class,
        size_bytes, observed_at, observed_by) VALUES ('x','${fileA.ref}',3,'declared_by_writer',1,?,'reconciliation')`)
    .run(now()), 'NOT NULL constraint failed');
expectFail('T3 a truncated digest is refused',
  () => addVersion({ ref: fileA.ref, seq: 3, digest: 'abc123' }), 'CHECK constraint failed');
expectFail('T3 a non-hex digest of the right length is refused',
  () => addVersion({ ref: fileA.ref, seq: 3, digest: 'z'.repeat(64) }), 'CHECK constraint failed');
expectFail('T3 the digest of an empty buffer cannot be filed against a non-empty file',
  () => addVersion({ ref: fileA.ref, seq: 3, digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }),
  'CHECK constraint failed');
expectFail('T3 a version_ref that does not match (ref,seq) is refused',
  () => db.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
        evidence_class, size_bytes, observed_at, observed_by)
        VALUES ('hidden-row',?,?,?,'declared_by_writer',1,?,'reconciliation')`)
    .run(fileA.ref, 3, sha('y'), now()), 'CHECK constraint failed');
expectFail('T3 a version for a ref nobody registered is refused',
  () => addVersion({ ref: sha('unregistered-ref'), seq: 1, digest: sha('z') }),
  'drive_version_ref_not_registered');
expectFail('T3 an already-recorded fingerprint cannot be erased from the file row',
  () => db.prepare(`UPDATE crm_drive_file_registry SET content_sha256 = NULL WHERE drive_ref = ?`)
    .run(fileA.ref),
  'registry_fingerprint_cannot_be_erased');
expectFail('T3 the head pointer cannot be pointed at a convenient version',
  () => db.prepare(`UPDATE crm_drive_file_registry SET head_version_seq = 1 WHERE drive_ref = ?`).run(fileA.ref),
  'registry_head_must_match_ledger');
expectFail('T3 a new file cannot arrive claiming versions it never had',
  () => db.prepare(`INSERT INTO crm_drive_file_registry
        (id, drive_file_id, file_name, original_file_name, mime_type, content_type, head_version_seq)
        VALUES ('x','y','f','f','text/plain','TXT',7)`).run(),
  'registry_head_is_maintained_by_the_ledger');
expectFail('T1 a fresh row cannot be inserted at a content status with no version ledger',
  () => db.prepare(`INSERT INTO crm_drive_file_registry
        (id, drive_file_id, file_name, original_file_name, mime_type, content_type,
         processing_status, review_status, content_sha256, file_size, drive_modified_at,
         last_processed_at, processing_receipt_ref, extracted_records_count, processing_attempts,
         drive_ref)
        VALUES ('y1','YY','f','f','application/zip','ZIP','processed','not_required',?,9,?,?,?,0,3,?)`)
    .run(sha('self-declared'), MTIM, MTIM, 'receipt-y', sha('y-ref')),
  'status_requires_a_recorded_version');
expectFail('T3 the ref handle is write-once',
  () => db.prepare(`UPDATE crm_drive_file_registry SET drive_ref = ? WHERE drive_ref = ?`)
    .run(sha('other-ref'), fileA.ref),
  'registry_drive_ref_is_write_once');

// ---------------------------------------------------------------- A->B->A is visible, not silent
expectOk('T3 a repeat of an older digest must be marked, and is then allowed', () => {
  const v3 = fileA.content; // back to the original bytes
  let unmarked = false;
  try { addVersion({ ref: fileA.ref, seq: 3, digest: v3 }); unmarked = true; } catch { /* expected */ }
  if (unmarked) throw new Error('an unmarked repeat was accepted');
  addVersion({ ref: fileA.ref, seq: 3, digest: v3, repeatOf: `${fileA.ref}#1` });
  const r = rows(fileA.ref);
  if (r.length !== 3) throw new Error(`expected 3 rows, got ${r.length}`);
});
expectFail('T3 a repeat may not point at a version that did not carry that digest',
  () => db.prepare(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
        evidence_class, size_bytes, observed_at, observed_by, repeat_of_version_ref)
        VALUES (?,?,4,?,'declared_by_writer',1,?,'reconciliation',?)`)
    .run(`${fileA.ref}#4`, fileA.ref, sha('brand-new-digest'), now(), `${fileA.ref}#2`),
  'drive_version_repeat_target_invalid');

// ---------------------------------------------------------------- T6a: history cannot be destroyed
expectFail('T6a a version row cannot be updated',
  () => db.prepare(`UPDATE crm_drive_file_version SET content_sha256 = ? WHERE drive_ref = ?`)
    .run(sha('rewrite-history'), fileA.ref), 'drive_versions_are_append_only');
expectFail('T6a a version row cannot be deleted',
  () => db.prepare(`DELETE FROM crm_drive_file_version WHERE drive_ref = ? AND version_seq = 1`).run(fileA.ref),
  'drive_versions_are_append_only');
expectFail('T6a the whole ledger cannot be wiped',
  () => db.exec('DELETE FROM crm_drive_file_version'), 'drive_versions_are_append_only');
expectFail('T6a a file row with history cannot be dropped',
  () => db.prepare(`DELETE FROM crm_drive_file_registry WHERE drive_ref = ?`).run(fileA.ref),
  'registry_row_anchors_versions_or_lineage');
expectOk('T6a and the counts are unchanged by every attempt', () => {
  const n = one(`SELECT COUNT(*) AS c FROM crm_drive_file_version`).c;
  if (n !== 5) throw new Error(`version rows = ${n}, expected 5 (A:3 + B:2)`);
  const v = one(`SELECT * FROM crm_drive_version_invariant_violations`);
  for (const k of ['counter_mismatches', 'dangling_heads', 'seq_gaps', 'status_without_version']) {
    if (v[k] !== 0) throw new Error(`${k}=${v[k]} on a healthy ledger`);
  }
});

// ---------------------------------------------------------------- duplicate lineage is pinned to a version
const fileD = newFile({ digest: fileA.content });   // same bytes as A's v1, different file
expectOk('T2 the duplicate evidence view finds two files sharing a verified outer digest', () => {
  // give D a verified version so it can appear at all
  addVersion({ ref: fileD.ref, seq: 1, digest: fileA.content });
  advanceStatus(fileD.ref, 'hashed');
  const hit = one(`SELECT files AS n FROM crm_drive_duplicate_evidence WHERE level = 'outer'
                     AND digest = '${fileA.content}'`);
  if (!hit || hit.n !== 2) throw new Error(`duplicate_evidence=${JSON.stringify(hit)}`);
});
expectFail('T2 a duplicate claim without a version pin is refused',
  () => db.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'duplicate',
                           duplicate_of_file_id = ? WHERE drive_ref = ?`).run(fileA.driveId, fileD.ref),
  'duplicate_claim_must_pin_a_version');
expectOk('T2 a pinned claim is accepted and stays true when the canonical row moves on', () => {
  db.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'duplicate',
                     duplicate_of_file_id = ?, duplicate_of_drive_ref = ?, duplicate_of_version_seq = 1
              WHERE drive_ref = ?`).run(fileA.driveId, fileA.ref, fileD.ref);
  const l = one(`SELECT lineage_state AS s FROM crm_drive_duplicate_lineage WHERE drive_ref = '${fileD.ref}'`);
  if (l.s !== 'drift_canonical_moved_forward') throw new Error(`lineage_state=${l.s}`);
});

// ---------------------------------------------------------------- the views are not vacuous
{
  const noTriggers = DRAFT_SQL.replace(/^CREATE TRIGGER [\s\S]*?^END;\n/gm, '');
  if (/CREATE TRIGGER/.test(noTriggers)) throw new Error('could not strip triggers for the positive control');
  const { db: bare } = build({ applyDraft: false });
  bare.exec(noTriggers);
  // a writer that bypassed the triggers: stale head, missing rows, a gap, and a processed file with no
  // version — the exact states the views promise to report
  bare.exec(`UPDATE crm_drive_file_registry SET drive_ref = drive_ref, head_version_seq = 4,
             versions_observed = 7 WHERE 1 = 0;`);
  bare.prepare(`INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name,
        mime_type, content_type, processing_status, review_status, content_sha256, file_size,
        drive_modified_at, last_processed_at, processing_receipt_ref, extracted_records_count,
        processing_attempts, drive_ref, head_version_seq, versions_observed)
        VALUES ('b1','BB','f','f','application/zip','ZIP','processed','not_required',?,9,?,?,?,0,3,?,4,7)`)
    .run(sha('bare'), MTIM, MTIM, 'receipt-bare', sha('bare-ref'));
  const v = bare.prepare('SELECT * FROM crm_drive_version_invariant_violations').get();
  const seen = Object.entries(v).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  if (seen.length === 0) fail('positive control: the invariant view must see a broken ledger', 'reported nothing');
  else pass(`positive control: views do see a bypassed ledger (${seen.join(' ')})`);
  const stale = bare.prepare(`SELECT projection_state AS s, metadata_is_silent AS q
                                FROM crm_drive_version_state LIMIT 1`).get();
  if (stale.s === 'aligned') fail('positive control: version_state must not bless a bare ledger', 'aligned');
  else pass(`positive control: version_state flags it (${stale.s})`);
}

// ---------------------------------------------------------------- provenance stays honest
const fileE = newFile({ digest: sha('a-digest-nobody-recomputed') });
expectOk('T1 a declared digest is stored as a claim and stays labelled as one', () => {
  addVersion({ ref: fileE.ref, seq: 1, digest: fileE.content, evidence: 'declared_by_writer', receipt: null });
  // and only now may the file row advance (the refusal for doing it earlier is asserted above);
  // the point here is that advancing does not launder the claim into a measurement.
  advanceStatus(fileE.ref, 'hashed');
  const s = one(`SELECT head_evidence_class AS e, projection_state AS p FROM crm_drive_version_state
                  WHERE drive_ref = '${fileE.ref}'`);
  if (s.e !== 'declared_by_writer') throw new Error(`head_evidence_class=${s.e}`);
  const q = one(`SELECT reason AS r FROM crm_drive_rehash_queue WHERE drive_ref = '${fileE.ref}'`);
  if (!q || q.r !== 'writer_claim_only') throw new Error(`rehash_queue=${q && q.r}`);
});
expectFail('T1 a row may not call itself verified without the bytes it was computed from',
  () => addVersion({ ref: fileE.ref, seq: 2, digest: sha('whatever'), evidence: 'verified_local_recompute',
                     receipt: null }),
  'CHECK constraint failed');
expectOk('T1 and the ledger still holds both rows for that file', () => {
  const n = rows(fileE.ref).length;
  if (n !== 1) throw new Error(`rows=${n}`);
});

// ---------------------------------------------------------------- summary
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}`);
const objs = db.prepare(`SELECT type, COUNT(*) AS c FROM sqlite_master
   WHERE name LIKE 'crm_drive_file_version%' OR name LIKE 'crm_drive_version%'
      OR name LIKE 'crm_drive_duplicate%' OR name LIKE 'crm_drive_rehash%'
      OR name LIKE 'trg_drive_version%' OR name LIKE 'trg_registry_%' OR name LIKE 'idx_crm_drive_version%'
      OR name LIKE 'idx_crm_drive_registry%'
   GROUP BY type ORDER BY type`).all();
console.log('\nobjects: ' + objs.map(o => `${o.type}=${o.c}`).join(' '));
console.log('migrations_applied=' + applied.join(',') +
  ` draft=${DRAFT.includes('migrations-draft') ? 'draft' : 'promoted'}`);
console.log(`VERSIONS ${results.length - failed.length}/${results.length} checks held`);
if (failed.length) {
  console.log('BARRIERS_MISSING:');
  for (const f of failed) console.log(` - ${f.label} :: ${f.detail}`);
  process.exit(1);
}
console.log('ALL_BARRIERS_HELD');
db.close();
