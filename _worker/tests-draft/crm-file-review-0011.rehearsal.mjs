// Local rehearsal for DRAFT migration 0011 — review cases for Drive files with no contact attached.
//
// IN-MEMORY ONLY: no wrangler config, no network, no Drive read, and no contact is created, linked or
// merged anywhere in this file. It exists to prove, before anyone approves 0011, that the DDL refuses
// what the design forbids — including the thing that matters most here: a link that nobody authorised.
//
//   node _worker/tests-draft/crm-file-review-0011.rehearsal.mjs
//
// Required proofs, numbered as in the task:
//   T4  a review case exists for a file with no contact at all
//   T5  no link to a contact can appear automatically, by guess, or by name
//   T6b review records cannot be lost, and a review cannot be closed against superseded bytes
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { driveRefHash } from '../../_worker/crm-wa-vcard-analysis.js';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = path.join(workerDir, 'migrations');
const draft = n => [path.join(MIG_DIR, n), path.join(workerDir, 'migrations-draft', n)].find(p => existsSync(p));
const D10 = draft('0010_crm_drive_file_versions.sql');
const D11 = draft('0011_crm_drive_file_intake_review.sql');
if (!D10 || !D11) throw new Error('0010 and 0011 must both be present (migrations or migrations-draft)');

const sha = t => createHash('sha256').update(t).digest('hex');
const MTIM = '2026-11-02T09:00:00.000Z';
const T0 = '2026-11-02T13:00:00Z';
const LATER = '2026-11-02T14:00:00Z';
const int = v => BigInt(Math.trunc(v));            // node:sqlite binds JS numbers as REAL; the CHECKs want integer

// ---------------------------------------------------------------- database
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
  catch { /* same policy as the 0009 rehearsal: skip what needs tables this file does not model */ }
}
  // A promoted migration arrives with the directory walk above, so "apply the draft file too" became
  // "apply it twice": `duplicate column name: drive_ref`, which is what this rehearsal died on the moment
  // 0010 moved from migrations-draft/ into migrations/. Read from wherever the file lives, apply it once.
  // Same rule _registry-fixture.mjs follows, for the same reason.
if (!applied.includes('0010')) db.exec(readFileSync(D10, 'utf8'));
db.exec(readFileSync(D11, 'utf8'));

// ---------------------------------------------------------------- assertions
const results = [];
const pass = label => results.push({ ok: true, label });
const fail = (label, detail) => results.push({ ok: false, label, detail });
function expectFail(label, fn, fragment) {
  try { fn(); fail(label, 'the write SUCCEEDED — barrier missing'); }
  catch (e) {
    const msg = String((e && e.message) || e);
    const held = fragment instanceof RegExp ? fragment.test(msg) : msg.includes(fragment);
    if (!held) fail(label, `refused for the wrong reason: ${msg.slice(0, 150)}`);
    else pass(`${label} [${fragment}]`);
  }
}
function expectOk(label, fn) {
  try { fn(); pass(`${label} [allowed]`); }
  catch (e) { fail(label, `expected success: ${String((e && e.message) || e).slice(0, 150)}`); }
}
const one = sql => db.prepare(sql).get();

// ---------------------------------------------------------------- fixtures
let counter = 0;
function registerFile() {
  const driveId = `FIXTURE${String(++counter).padStart(4, '0')}`;
  const ref = driveRefHash(driveId);
  const digest = sha(`${driveId}-bytes-v1`);
  db.prepare(`INSERT INTO crm_drive_file_registry
      (id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path, mime_type,
       file_size, drive_created_at, drive_modified_at, content_sha256, content_type, processing_status,
       review_status, last_processed_at, processing_receipt_ref, extracted_records_count,
       processing_attempts, metadata_json, created_at, updated_at, drive_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`reg-${counter}`, driveId, 'FOLDER', `fixture-${counter}.zip`, `fixture-${counter}.zip`, '/x',
      'application/zip', 1024, MTIM, MTIM, digest, 'ZIP', 'metadata_scanned', 'not_required', MTIM,
      `receipt-${counter}`, 0, 1, '{}', MTIM, MTIM, ref);
  db.prepare(`INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes,
       drive_modified_at, observed_at, observed_by, receipt_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`${ref}#1`, ref, 1, digest, 'verified_local_recompute', 1024, MTIM, T0, 'intake_pipeline',
      'receipt-rehearsal');
  db.prepare(`UPDATE crm_drive_file_registry SET processing_status = 'hashed' WHERE drive_ref = ?`).run(ref);
  return { driveId, ref, digest };
}
function openCase(file, { disposition = 'register_new_file', seq = 1 } = {}) {
  const caseRef = `frw-${file.ref.slice(0, 16)}-${seq}`;
  const snapshot = sha(`case-snapshot|${caseRef}|${file.digest}`);
  db.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(caseRef, file.ref, seq, file.digest, disposition, 'open', snapshot,
      sha(`genesis|${caseRef}`), 'intake_pipeline', T0);
  return { caseRef, snapshot };
}
const LIVE = sha('session-live');
const EXPIRED = sha('session-expired');
const REVOKED = sha('session-revoked');
function openSession(tokenHash, ageSeconds, ttlSeconds, revokedAfter) {
  const created = Date.now() - ageSeconds * 1000;
  db.prepare(`INSERT INTO crm_sessions(id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
      VALUES (?,?,?,?,?,?,?)`)
    .run(`s-${tokenHash.slice(0, 8)}`, tokenHash, sha('csrf'), int(created),
      int(created + ttlSeconds * 1000), int(created),
      revokedAfter === null ? null : int(created + revokedAfter * 1000));
}
openSession(LIVE, 60, 3600, null);
openSession(EXPIRED, 7200, 3600, null);
openSession(REVOKED, 60, 3600, 1);

function decide(c, decision, { seq, reason = 'rehearsal reason for this decision', reviewer = 'reviewer-one',
                              session = LIVE, at = LATER, head = 1, snapshot } = {}) {
  const snap = snapshot ?? c.snapshot;
  const prev = seq === 1
    ? db.prepare('SELECT genesis_sha256 AS g FROM crm_drive_file_review_case WHERE case_ref = ?').get(c.caseRef).g
    : (db.prepare(`SELECT decision_sha256 AS d FROM crm_drive_file_review_decision
                    WHERE case_ref = ? AND decision_seq = ?`).get(c.caseRef, seq - 1) || {}).d
      ?? sha('no-such-predecessor');
  const digest = sha(`frw_decision|${c.caseRef}|${seq}|${decision}|${reason}|${snap}`);
  db.prepare(`INSERT INTO crm_drive_file_review_decision
      (case_ref, decision_seq, decision, reviewer, reviewer_attestation, session_hash, reason,
       reason_sha256, bound_version_seq, head_version_seq_at_decision, case_snapshot_sha256,
       occurred_at, prev_decision_sha256, decision_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.caseRef, seq, decision, reviewer, 'session_label_not_independent_identity', session, reason,
      sha(reason), 1, head, snap, at, prev, digest);
  return digest;
}

// ---------------------------------------------------------------- T4: a case for a file, no contact anywhere
const f1 = registerFile();
let c1;
expectOk('T4 a case opens for a file with crm_contact_id absent', () => {
  c1 = openCase(f1);
  const r = one(`SELECT crm_contact_id AS k, link_state AS ls, status AS st FROM crm_drive_file_review_case WHERE case_ref = ?`);
  const row = db.prepare('SELECT crm_contact_id AS k, link_state AS ls, status AS st FROM crm_drive_file_review_case WHERE case_ref = ?').get(c1.caseRef);
  if (row.k !== null) throw new Error('a contact appeared by itself');
  if (row.ls !== 'none' || row.st !== 'open') throw new Error(`ls=${row.ls} st=${row.st}`);
});
expectOk('T4 and no analysis run, no seal and no ciphertext were needed', () => {
  const n = one(`SELECT COUNT(*) AS c FROM crm_drive_review_case`).c;
  if (n !== 0) throw new Error('the contact-matching workflow was dragged in');
  const s = one(`SELECT COUNT(*) AS c FROM crm_drive_review_seal`).c;
  if (s !== 0) throw new Error('a seal was created for a file review');
});
expectOk('T4 the genesis anchor is part of the chain from the first decision', () => {
  decide(c1, 'noted', { seq: 1 });
  decide(c1, 'schedule_rehash', { seq: 2 });
  const i = db.prepare('SELECT * FROM crm_drive_file_review_chain_integrity WHERE case_ref = ?').get(c1.caseRef);
  if (i.decisions !== 2 || i.broken_links !== 0 || i.seq_gaps !== 0 || i.anchor_mismatches !== 0) {
    throw new Error(`decisions=${i.decisions} broken=${i.broken_links} gaps=${i.seq_gaps} anchors=${i.anchor_mismatches}`);
  }
  if (i.anchors !== 2) throw new Error(`trigger anchors=${i.anchors}`);
});
expectOk('T4 a healthy ledger reads healthy, and CI sees only counts', () => {
  const s = db.prepare('SELECT * FROM crm_drive_file_review_ci_summary').all();
  if (!s.length) throw new Error('summary empty');
  const bad = s.filter(r => r.broken_links !== 0 || r.seq_gaps !== 0 || r.anchor_mismatches !== 0
    || r.links_proposed !== 0 || r.stale_cases !== 0);
  if (bad.length) throw new Error(JSON.stringify(bad));
  const cols = Object.keys(s[0]);
  for (const forbidden of ['reviewer', 'reason', 'crm_contact_id', 'session_hash']) {
    if (cols.includes(forbidden)) throw new Error(`ci_summary exposes ${forbidden}`);
  }
});
expectFail('T4 a case cannot be opened against bytes nobody recorded',
  () => db.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES (?,?,7,?, 'verify_content_digest','open',?,?, 'intake_pipeline',?)`)
    .run('frw-deadbeefdeadbe-1', f1.ref, f1.digest, sha('x'), sha('g'), LATER),
  'file_review_case_requires_a_recorded_version');
expectFail('T4 the case handle is derived, not invented', () => {
  const fx = registerFile();          // a file whose v1 exists, so only the handle rule can refuse it
  db.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES ('frw-cafe0000cafe0000-1',?,1,?,'register_new_file','open',?,?,'intake_pipeline',?)`)
    .run(fx.ref, fx.digest, sha('y'), sha('gen'), LATER);
}, 'CHECK constraint failed');
expectFail('T4 two cases for the same file version are refused',
  () => openCase(f1), 'UNIQUE constraint failed');

// ---------------------------------------------------------------- T5: no link nobody authorised
expectFail('T5 a contact handle cannot simply be written onto a case',
  () => db.prepare('UPDATE crm_drive_file_review_case SET crm_contact_id = ? WHERE case_ref = ?')
    .run('contact-handle-1', c1.caseRef),
  'file_review_link_requires_explicit_human_basis');
expectFail('T5 a link cannot be created together with the case (no decision, no reviewer)',
  () => {
    const f = registerFile();
    const ref = `frw-${f.ref.slice(0, 16)}-1`;
    db.prepare(`INSERT INTO crm_drive_file_review_case
        (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
         crm_contact_id, link_state, link_basis, link_confirmed_by, link_confirmed_at,
         link_evidence_sha256, case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
        VALUES (?,?,1,?,'register_new_file','open',?,'proposed','vcard_tel','reviewer-one',?,?,?,?,'intake_pipeline',?)`)
      .run(ref, f.ref, f.digest, 'contact-handle-2', sha('evidence'), LATER, sha('snap'), sha('gen'), LATER);
  },
  'file_review_link_requires_a_recorded_decision');
expectFail('T5 a proposal with a human but no recorded decision is refused',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'contact-handle-5',
        link_state = 'proposed', link_basis = 'vcard_tel', link_confirmed_by = 'reviewer-one',
        link_confirmed_at = ?, link_evidence_sha256 = ? WHERE case_ref = ?`)
    .run(LATER, sha('e'), c1.caseRef),
  'file_review_link_requires_explicit_human_basis');
expectOk('T5 the only legal route: a recorded decision, then a named human, then the pointer', () => {
  decide(c1, 'link_proposed', { seq: 3 });
  db.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'contact-handle-6',
        link_state = 'proposed', link_basis = 'vcard_tel', link_confirmed_by = 'reviewer-one',
        link_confirmed_at = ?, link_evidence_sha256 = ? WHERE case_ref = ?`)
    .run(LATER, sha('tel-backing-evidence'), c1.caseRef);
  const row = db.prepare('SELECT link_state AS ls, crm_contact_id AS k FROM crm_drive_file_review_case WHERE case_ref = ?').get(c1.caseRef);
  if (row.ls !== 'proposed' || row.k !== 'contact-handle-6') throw new Error('proposal not recorded');
});
expectFail('T5 no name-based basis exists in the vocabulary at all',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'contact-handle-3',
        link_state = 'proposed', link_basis = 'name_digest', link_confirmed_by = 'reviewer-one',
        link_confirmed_at = ?, link_evidence_sha256 = ? WHERE case_ref = ?`)
    .run(LATER, sha('e'), c1.caseRef),
  'CHECK constraint failed');
expectFail('T5 nor does "similarity", "matcher" or "auto"',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'c', link_state = 'proposed',
        link_basis = 'similarity', link_confirmed_by = 'matcher', link_confirmed_at = ?,
        link_evidence_sha256 = ? WHERE case_ref = ?`).run(LATER, sha('e'), c1.caseRef),
  'CHECK constraint failed');
expectFail('T5 a machine label cannot confirm a link',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'contact-handle-4',
        link_state = 'proposed', link_basis = 'vcard_tel', link_confirmed_by = 'pipeline',
        link_confirmed_at = ?, link_evidence_sha256 = ? WHERE case_ref = ?`)
    .run(LATER, sha('e'), c1.caseRef),
  'CHECK constraint failed');
expectFail('T5 a proposed link is not an approved one: escalation must be real and decided',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET link_state = 'approved_by_contact_review'
                      WHERE case_ref = ?`).run(c1.caseRef),
  'file_review_link_requires_explicit_human_basis');
expectFail('T5 the file workflow cannot record an import, a merge or a contact write',
  () => db.prepare(`UPDATE crm_drive_file_review_case SET import_implied = 1 WHERE case_ref = ?`).run(c1.caseRef),
  'CHECK constraint failed');
expectOk('T5 unlinking is possible but only through the ledger, and the record survives', () => {
  decide(c1, 'unlink_recorded', { seq: 4 });
  const row = db.prepare('SELECT link_state AS ls, crm_contact_id AS k, status AS st FROM crm_drive_file_review_case WHERE case_ref = ?').get(c1.caseRef);
  if (row.ls !== 'none' || row.k !== null) throw new Error(`ls=${row.ls}`);
  const n = db.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_review_decision WHERE case_ref = ?').get(c1.caseRef).c;
  if (n !== 4) throw new Error(`decisions=${n}, expected 4 (the history keeps both acts)`);
});

// ---------------------------------------------------------------- T6b: nothing may be lost or re-written
expectFail('T6b a decision cannot be edited',
  () => db.prepare('UPDATE crm_drive_file_review_decision SET decision = ? WHERE case_ref = ?')
    .run('close_no_action', c1.caseRef),
  'file_review_decisions_are_append_only');
expectFail('T6b a decision cannot be deleted',
  () => db.prepare('DELETE FROM crm_drive_file_review_decision WHERE case_ref = ?').run(c1.caseRef),
  'file_review_decisions_are_append_only');
expectFail('T6b the anchor mirror cannot be edited or wiped',
  () => db.exec('DELETE FROM crm_drive_file_review_anchor'),
  'file_review_anchors_are_append_only');
expectFail('T6b a case that a reviewer touched cannot be deleted',
  () => db.prepare('DELETE FROM crm_drive_file_review_case WHERE case_ref = ?').run(c1.caseRef),
  'file_review_cases_are_permanent');
expectFail('T6b decisions cannot skip a number',
  () => decide(c1, 'noted', { seq: 9 }),
  'file_review_decision_seq_broken');
expectFail('T6b a decision must link to the previous one',
  () => db.prepare(`INSERT INTO crm_drive_file_review_decision
      (case_ref, decision_seq, decision, reviewer, reviewer_attestation, session_hash, reason,
       reason_sha256, bound_version_seq, head_version_seq_at_decision, case_snapshot_sha256,
       occurred_at, prev_decision_sha256, decision_sha256)
      VALUES (?,5,'noted','reviewer-one','session_label_not_independent_identity',?,?,'ignored',?,?,?,?,'ignored','ignored')`)
    .run(c1.caseRef, LIVE, sha('r'), 1, 1, c1.snapshot, LATER),
  'file_review_decision_chain_broken');
expectFail('T6b a decision bound to a different snapshot is refused',
  () => decide(c1, 'noted', { seq: 5, snapshot: sha('a-different-snapshot-than-the-reviewer-saw') }),
  'file_review_decision_snapshot_mismatch');
expectFail('T6b a state-changing decision needs a session that is live right now',
  () => decide(c1, 'schedule_rehash', { seq: 5, session: REVOKED }),
  'file_review_decision_session_not_live');
expectFail('T6b an expired session is equally refused',
  () => decide(c1, 'schedule_rehash', { seq: 5, session: EXPIRED }),
  'file_review_decision_session_not_live');
expectOk('T6b a note may still be filed without a session, and nothing else changes', () => {
  decide(c1, 'noted', { seq: 5, session: sha('no-session-needed-for-a-note') });
  const st = db.prepare('SELECT status AS s FROM crm_drive_file_review_case WHERE case_ref = ?').get(c1.caseRef);
  if (st.s !== 'open') throw new Error(`status=${st.s}`);
});

// ---------------------------------------------------------------- staleness: reviews die with the bytes
expectOk('T6b the file moves to a new version while the case is open', () => {
  const newDigest = sha(`${f1.driveId}-bytes-v2`);
  db.prepare(`INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes,
       drive_modified_at, observed_at, observed_by, receipt_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`${f1.ref}#2`, f1.ref, 2, newDigest, 'verified_local_recompute', 1024, MTIM, LATER,
      'reconciliation', 'receipt-rehearsal');
  const s = db.prepare('SELECT freshness AS f, current_head_seq AS h FROM crm_drive_file_review_state WHERE case_ref = ?').get(c1.caseRef);
  if (s.f !== 'stale_newer_version_exists' || s.h !== 2) throw new Error(`freshness=${s.f} head=${s.h}`);
});
expectFail('T6b a stale case cannot be closed as if it were current',
  () => decide(c1, 'close_no_action', { seq: 6, head: 2 }),
  'review_case_bound_version_is_stale');
expectOk('T6b the review stays open, and a fresh case against v2 is allowed', () => {
  const c2 = openCase({ ref: f1.ref, digest: sha(`${f1.driveId}-bytes-v2`) }, { seq: 2, disposition: 'verify_content_digest' });
  if (!c2.caseRef.endsWith('-2')) throw new Error('case ref not version-bound');
});

// ---------------------------------------------------------------- isolation, with a positive control
expectOk('T5 file review owns no path to contact tables and no operational column', () => {
  const iso = one(`SELECT * FROM crm_drive_file_review_isolation`);
  if (iso.forbidden_refs !== 0) throw new Error(`forbidden_refs=${iso.forbidden_refs}`);
  if (iso.nails_loose !== 0 || iso.unexplained_links !== 0) throw new Error(JSON.stringify(iso));
});
{
  // a deliberately bad sibling: same names, forbidden references — the view must notice
  const bad = new DatabaseSync(':memory:');
  bad.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY); INSERT INTO crm_contacts VALUES ('n');");
  bad.exec(`CREATE TABLE crm_drive_file_review_case (case_ref TEXT PRIMARY KEY, contact_name TEXT
              REFERENCES crm_contacts(id), import_implied INTEGER DEFAULT 1, merge_authorized INTEGER DEFAULT 1,
              contact_write_count INTEGER DEFAULT 2, crm_contact_id TEXT, link_state TEXT);
            CREATE TABLE crm_drive_file_review_decision (case_ref TEXT);
            CREATE TABLE crm_drive_file_review_anchor (case_ref TEXT);`);
  bad.exec(readFileSync(D11, 'utf8').match(/CREATE VIEW IF NOT EXISTS crm_drive_file_review_isolation[\s\S]*?;/)[0]);
  bad.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, contact_name, import_implied, merge_authorized, contact_write_count, crm_contact_id,
       link_state) VALUES ('bad-1','n',1,2,3,'c','none')`).run();
  const iso = bad.prepare('SELECT * FROM crm_drive_file_review_isolation').get();
  if (iso.forbidden_refs < 1 || iso.nails_loose < 1) fail('positive control: the isolation view must see a bad design', JSON.stringify(iso));
  else pass(`positive control: isolation view does see a bad design (forbidden_refs=${iso.forbidden_refs} nails_loose=${iso.nails_loose})`);
  bad.close();
}
expectFail('T5 the operational nails are welded: even an INSERT cannot claim a write',
  () => {
    const f = registerFile();
    const ref = `frw-${f.ref.slice(0, 16)}-1`;
    db.prepare(`INSERT INTO crm_drive_file_review_case
        (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
         case_snapshot_sha256, genesis_sha256, opened_by, opened_at, contact_write_count)
        VALUES (?,?,1,?,'register_new_file','open',?,?,'intake_pipeline',?,1)`)
      .run(ref, f.ref, f.digest, sha('s'), sha('g'), T0);
  },
  'CHECK constraint failed');

// ---------------------------------------------------------------- 0009 is not weakened by any of this
expectFail('T4 the contact-matching workflow still demands a contact (0009 untouched)',
  () => db.prepare(`INSERT INTO crm_drive_review_case
      (case_ref, case_kind, run_key, crm_contact_id, match_class, evidence_type, confidence, basis,
       case_snapshot_sha256, built_at)
      VALUES ('p4r-001','file_to_contact','run-x',NULL,'unmatched','rehearsal','none','vcard_tel',?,'2026-11-02T09:00:00Z')`)
    .run(sha('snap')),
  'CHECK constraint failed');

// ---------------------------------------------------------------- nothing was imported
{
  const ops = {};
  for (const tbl of ['crm_contacts', 'crm_contact_phones', 'crm_opportunities', 'crm_conversations',
                     'crm_conversation_messages', 'crm_smart_alerts']) {
    const has = one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='${tbl}'`).c;
    if (has) ops[tbl] = one(`SELECT COUNT(*) AS n FROM ${tbl}`).n;
  }
  if (Object.keys(ops).some(k => ops[k] !== 0)) fail('no operational write', JSON.stringify(ops));
  else pass(`operational tables untouched by this rehearsal (${Object.keys(ops).length} tables)`);
}

// ---------------------------------------------------------------- summary
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}`);
const objs = db.prepare(`SELECT type, COUNT(*) AS c FROM sqlite_master
   WHERE name LIKE 'crm_drive_file_review%' OR name LIKE 'trg_file_review%'
   GROUP BY type ORDER BY type`).all();
console.log('\nobjects: ' + objs.map(o => `${o.type}=${o.c}`).join(' '));
console.log('migrations_applied=' + applied.join(',') +
  ` drafts=${D10.includes('migrations-draft') ? '0010,0011' : 'promoted'}`);
console.log(`FILE_REVIEW ${results.length - failed.length}/${results.length} checks held`);
if (failed.length) {
  console.log('BARRIERS_MISSING:');
  for (const f of failed) console.log(` - ${f.label} :: ${f.detail}`);
  process.exit(1);
}
console.log('ALL_BARRIERS_HELD');
db.close();
