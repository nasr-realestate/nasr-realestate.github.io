// Rehearsal harness for the DRAFT migration 0009 (human review workflow).
//
// IN-MEMORY ONLY: it opens no wrangler config, makes no network call, and touches neither
// `nasr-crm-test-db`, nor `nasr-market-db`, nor the reference backup, nor Drive. Its only purpose is
// to prove — before anybody approves applying 0009 — that the DDL itself enforces the agreed limits.
//
//   node _worker/tests-draft/crm-review-sql-0009.abuse.mjs
//
// Exit 0 = every barrier held and every tampering attempt was detected.
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = path.join(workerDir, 'migrations');
const DRAFT = path.join(workerDir, 'migrations-draft', '0009_crm_drive_review_workflow.sql');
const sha = text => createHash('sha256').update(text).digest('hex');
const b64u = buf => Buffer.from(buf).toString('base64url');
const sql0009 = readFileSync(DRAFT, 'utf8');

// ---------------------------------------------------------------- build the isolated database
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');          // D1 enforces FKs; mirror that here
// The site base tables that migrations 0004..0006 expect (same minimal shape the repo's own
// isolated-schema tests use).
db.exec(`
  CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
  CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE listings (
    id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT, title TEXT,
    property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
    bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL);
`);
const applied = [];
const skipped = [];
for (const file of readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
  try {
    db.exec(readFileSync(path.join(MIG_DIR, file), 'utf8'));
    applied.push(file.slice(0, 4));
  } catch {
    skipped.push(file.slice(0, 4));
  }
}
if (!applied.includes('0008')) throw new Error('0008 must apply for this rehearsal to be meaningful');
const hasOps = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='crm_contacts'`).get().c === 1;
db.exec(sql0009);
const mode = hasOps ? 'migrations' : 'partial';

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
    if (!held) fail(label, `refused for the wrong reason: ${msg.slice(0, 140)}`);
    else pass(`${label} [${fragment || 'refused'}]`);
  }
}
function expectOk(label, fn) {
  try {
    fn();
    pass(`${label} [allowed]`);
  } catch (error) {
    fail(label, `expected success: ${String((error && error.message) || error).slice(0, 140)}`);
  }
}
// A test whose PASS condition is "damage is DETECTED": fn() returns truthy when detected.
function expectDetected(label, fn) {
  try {
    if (fn()) pass(`${label} [detected]`);
    else fail(label, 'tampering went undetected');
  } catch (error) {
    const msg = String((error && error.message) || error);
    if (msg.includes('append_only') || msg.includes('chain_head_required')) {
      pass(`${label} [refused before it could happen: ${msg.split(':')[0]}]`);
    } else fail(label, `harness error: ${msg.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- seed: run + 3 representative cases
const RUN = 'p4-rehearsal-run';
const GENESIS = sha(`p4rev_genesis|${RUN}`);
const now = '2026-11-01T12:00:00.000Z';
const contactA = sha('contact-a').slice(0, 32);
const contactB = sha('contact-b').slice(0, 32);
const fileA = sha('file-f1e4b581');
const fileB = sha('file-8c52ae5c');

db.prepare(`INSERT INTO crm_drive_analysis_run
    (run_key, payload_fingerprint, analysis_version, drive_parent_id, files_expected, files_analyzed,
     files_processed, files_failed, conversations_total, messages_total, vcard_records_total,
     duplicate_findings, match_candidates, import_performed)
    VALUES (?,?,?,?,100,100,100,0,90,2984,81,4,191,0)`)
  .run(RUN, sha('rehearsal-fingerprint'), 'p4a-v1-rehearsal', sha('rehearsal-parent').slice(0, 32));

function addCase(ref, kind, x) {
  const snapshot = sha(JSON.stringify([ref, kind, x.basis, x.match_class, x.evidence]));
  db.prepare(`INSERT INTO crm_drive_review_case
      (case_ref, case_kind, run_key, drive_file_id, source_content_kind, card_index, files_count,
       match_class, evidence_type, confidence, signal_kind, signal_digest, crm_contact_id,
       basis, approve_allowed, case_snapshot_sha256, built_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, kind, RUN, x.drive_file_id || null, x.source_content_kind || null, x.card_index ?? null,
      x.files_count ?? null, x.match_class, x.evidence, x.confidence, x.signal_kind || null,
      x.signal_digest || null, x.crm_contact_id, x.basis, x.approve_allowed, snapshot, now);
  return snapshot;
}
const snapA = addCase('p4r-001', 'file_to_contact', {
  drive_file_id: fileA, source_content_kind: 'VCF', card_index: 0, match_class: 'exact_match',
  evidence: 'vcard_tel_digest_equal_primary', confidence: 'high', signal_kind: 'phone',
  signal_digest: sha('phone-1'), crm_contact_id: contactA, basis: 'vcard_tel', approve_allowed: 1,
});
const snapName = addCase('p4r-002', 'file_to_contact', {
  drive_file_id: fileB, source_content_kind: 'ZIP', card_index: 1, match_class: 'probable_match',
  evidence: 'transcript_overlap_with_matched_file', confidence: 'low', signal_kind: 'name',
  signal_digest: sha('name-2'), crm_contact_id: contactB, basis: 'name_digest', approve_allowed: 0,
});
addCase('p4c-01', 'contact_fanout', {
  match_class: 'conflict', evidence: 'same_contact_id_from_two_files', confidence: 'none',
  signal_kind: 'none', files_count: 2, crm_contact_id: contactA, basis: 'name_digest', approve_allowed: 0,
});
db.prepare('INSERT INTO crm_drive_review_chain_head (run_key, head_sha256, event_count, updated_at) VALUES (?,?,0,?)')
  .run(RUN, GENESIS, now);
db.prepare(`INSERT INTO crm_drive_review_chain_anchor
    (run_key, event_seq, head_sha256, event_count, anchor_source, anchored_at) VALUES (?,?,?,0,'genesis',?)`)
  .run(RUN, 0, GENESIS, now);

// ---------------------------------------------------------------- the contract the API will implement
const headRow = () => db.prepare('SELECT head_sha256, event_count FROM crm_drive_review_chain_head WHERE run_key = ?').get(RUN);
const caseRow = ref => db.prepare('SELECT case_snapshot_sha256 AS snap, basis FROM crm_drive_review_case WHERE case_ref = ?').get(ref) || {};
const caseSeq = ref => (db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_event WHERE case_ref = ?').get(ref).c) + 1;

let clock = Date.parse('2026-11-01T12:00:00.000Z');
function nextAt() {
  clock = clock + 1000;
  return new Date(clock).toISOString();
}
function insertEvent(o) {
  const h = headRow();
  const c = caseRow(o.caseRef);
  const row = {
    run_key: o.run_key || RUN,
    event_seq: o.event_seq ?? (h.event_count + 1),
    case_seq: o.case_seq ?? caseSeq(o.caseRef),
    case_ref: o.caseRef,
    event_type: o.type,
    decision_state: o.state ?? null,
    reviewer: o.reviewer ?? 'nasr.owner',
    reviewer_attestation: o.attestation ?? 'session_label_not_independent_identity',
    session_hash: o.sessionHash ?? LIVE_TOKEN,
    reason: o.reason,
    reason_sha256: sha(String(o.reason ?? '')),
    reveal_purpose: o.purpose ?? null,
    reveal_outcome: o.outcome ?? null,
    seal_ciphertext_sha256: o.sealSha ?? null,
    basis_at_event: o.basis ?? c.basis,
    case_snapshot_sha256: o.snap ?? c.snap,
    link_applied: 0, merge_authorized: 0, contact_write_count: 0,
    supersedes_id: o.supersedesId ?? null,
    occurred_at: o.at ?? nextAt(),
    prev_event_sha256: o.prev ?? h.head_sha256,
  };
  row.event_sha256 = sha(JSON.stringify(row));
  const extra = o.raw || {};
  db.prepare(`INSERT INTO crm_drive_review_event
      (run_key, event_seq, case_seq, case_ref, event_type, decision_state, reviewer, reviewer_attestation,
       session_hash, reason, reason_sha256, reveal_purpose, reveal_outcome, seal_ciphertext_sha256,
       basis_at_event, case_snapshot_sha256, link_applied, merge_authorized, contact_write_count,
       supersedes_id, occurred_at, prev_event_sha256, event_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.run_key, row.event_seq, row.case_seq, row.case_ref, row.event_type, row.decision_state,
      row.reviewer, row.reviewer_attestation, row.session_hash, row.reason, row.reason_sha256,
      row.reveal_purpose, row.reveal_outcome, row.seal_ciphertext_sha256, row.basis_at_event,
      row.case_snapshot_sha256, extra.link_applied ?? 0, extra.merge_authorized ?? 0,
      extra.contact_write_count ?? 0, row.supersedes_id, row.occurred_at, row.prev_event_sha256,
      row.event_sha256);
  return row;
}


function insertEventWith(o) {
  return insertEvent(o);
}

// ---------------------------------------------------------------- 5b) the seal envelope (option A)
const SEAL_SECRET = randomBytes(32);            // stands in for the Worker secret CRM_REVIEW_SEAL_KEY
const KEY_VERSION = 1;
const deriveKey = (caseRef, snap) => Buffer.from(hkdfSync('sha256', SEAL_SECRET,
  Buffer.from(`${RUN}|${caseRef}`, 'utf8'), Buffer.from(`p4rev_seal_v1|${snap}`, 'utf8'), 32));
const aadFor = (caseRef, snap) => Buffer.from(`p4rev_v1|${caseRef}|${snap}|${RUN}|v${KEY_VERSION}`, 'utf8');
const cardPlaintext = JSON.stringify({
  vcard: { fn: 'اسم تجريبي', tel: '+20 100 000 0000', note: 'بطاقة اختبار فقط' },
  source: { file_ref: fileA.slice(0, 8), kind: 'VCF', card_index: 0, content_sha256: fileA },
});
function sealCard(caseRef, plaintext = cardPlaintext) {
  const snap = caseRow(caseRef).snap;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', deriveKey(caseRef, snap), iv);
  c.setAAD(aadFor(caseRef, snap));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const row = { caseRef, iv: b64u(iv), tag: b64u(c.getAuthTag()), ct: b64u(ct),
    ctSha: sha(ct), pSha: sha(plaintext), len: Buffer.byteLength(plaintext) };
  db.prepare(`INSERT INTO crm_drive_review_seal
      (case_ref, run_key, envelope_version, algo, kdf, aad_mode, key_version, iv_b64u, tag_b64u,
       ciphertext_b64u, ciphertext_sha256, plaintext_sha256, plaintext_len, retention_days, sealed_by,
       created_at, expires_at)
      VALUES (?,?,'p4rev_v1','AES-256-GCM','HKDF-SHA256','case_bound_v1',?,?,?,?,?,?,?,90,?,?,?)`)
    .run(row.caseRef, RUN, KEY_VERSION, row.iv, row.tag, row.ct, row.ctSha, row.pSha, row.len,
      'analysis_pipeline', now, new Date(Date.parse(now) + 90 * 86400_000).toISOString());
  return row;
}
function unseal(row, atCaseRef = row.caseRef) {
  const snap = caseRow(atCaseRef).snap;
  const d = createDecipheriv('aes-256-gcm', deriveKey(atCaseRef, snap), Buffer.from(row.iv, 'base64url'));
  d.setAAD(aadFor(atCaseRef, snap));
  d.setAuthTag(Buffer.from(row.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(row.ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- 0) live sessions and a sealed card first
// The ledger refuses any event whose CRM session is not live right now, so the rehearsal must sign
// in the same way the Worker does: session_hash == crm_sessions.token_hash (sha256 hex, never the
// token itself).
const LIVE_TOKEN = sha('session-live');
const EXPIRED_TOKEN = sha('session-expired');
const REVOKED_TOKEN = sha('session-revoked');
const msNow = Date.now();          // session liveness is checked against wall-clock now()
// node:sqlite binds JS numbers as REAL; the session columns CHECK for typeof = 'integer'
const int = v => (v === null || v === undefined ? null : BigInt(Math.trunc(v)));
function openSession(tokenHash, ageSeconds, ttlSeconds, revokedAfter) {
  const created = Date.now() - ageSeconds * 1000;
  db.prepare(`INSERT INTO crm_sessions(id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
      VALUES (?,?,?,?,?,?,?)`)
    .run(`sess-${tokenHash.slice(0, 8)}`, tokenHash, sha('csrf'), int(created),
      int(created + ttlSeconds * 1000), int(created),
      revokedAfter === null ? null : int(created + revokedAfter * 1000));
}
// a live session, an expired one, a revoked one, and a second live one for binding tests
openSession(LIVE_TOKEN, 60, 3600, null);
openSession(EXPIRED_TOKEN, 7200, 3600, null);
openSession(REVOKED_TOKEN, 60, 3600, 1);
const sealed = sealCard('p4r-001');
if (sha(unseal(sealed)) !== sealed.pSha || unseal(sealed) !== cardPlaintext) throw new Error('seal setup broken');
if (db.prepare('SELECT seal_state FROM crm_drive_review_case WHERE case_ref = ?').get('p4r-001').seal_state !== 'sealed') {
  throw new Error('case did not become sealed');
}
const storedCipher = db.prepare('SELECT ciphertext_b64u AS c FROM crm_drive_review_seal WHERE case_ref = ?').get('p4r-001').c;
if (/0100|\u0627\u0633\u0645|example/.test(storedCipher)) throw new Error('plaintext visible in the stored column');
pass('a sealed case stores only opaque ciphertext, and round-trips [ok]');
// two more cases so the reveal/approve binding can be probed on its own ground
const snapB = addCase('p4r-003', 'file_to_contact', {
  drive_file_id: fileB, source_content_kind: 'VCF', card_index: 2, match_class: 'exact_match',
  evidence: 'vcard_tel_digest_equal_primary', confidence: 'high', signal_kind: 'phone',
  signal_digest: sha('phone-3'), crm_contact_id: contactB, basis: 'vcard_tel', approve_allowed: 1,
});
const snapC = addCase('p4r-004', 'file_to_contact', {
  drive_file_id: fileB, source_content_kind: 'VCF', card_index: 3, match_class: 'exact_match',
  evidence: 'vcard_tel_digest_equal_primary', confidence: 'high', signal_kind: 'phone',
  signal_digest: sha('phone-4'), crm_contact_id: contactB, basis: 'vcard_tel', approve_allowed: 1,
});
const sealNameOnly = sealCard('p4r-002', JSON.stringify({ vcard: { fn: 'اسم تجريبي' }, source: { card_index: 0 } }));
const sealB = sealCard('p4r-003');
const sealC = sealCard('p4r-004');

const last = caseRef => db.prepare(`SELECT * FROM crm_drive_review_event WHERE case_ref = ? ORDER BY event_seq DESC LIMIT 1`).get(caseRef);

// ---------------------------------------------------------------- 1) honest path: reveal, decide, correct
expectOk('granted reveal of the sealed card', () => insertEvent({
  caseRef: 'p4r-001', type: 'reveal', purpose: 'identity_check', outcome: 'granted', sealSha: sealed.ctSha,
  reason: 'the reviewer opened the sealed vCard to compare the telephone before deciding',
}));
expectOk('approve a phone-backed case', () => insertEvent({
  caseRef: 'p4r-001', type: 'approve', state: 'approved',
  reason: 'vCard telephone equals the stored CRM row; identity checked by the reviewer',
}));
if (last('p4r-001')?.event_type !== 'approve') throw new Error('approve is not the current state');
if (db.prepare(`SELECT current_decision FROM crm_review_case_state WHERE case_ref = 'p4r-001'`).get().current_decision !== 'approve') {
  throw new Error('view disagrees with the ledger');
}
expectOk('log a note', () => insertEvent({
  caseRef: 'p4r-001', type: 'note',
  reason: 'the card also carries a landline, recorded as detail only',
}));
expectOk('defer a name-only case', () => insertEvent({
  caseRef: 'p4r-002', type: 'defer', state: 'deferred',
  reason: 'no phone-backed identifier yet, so identity stays unconfirmed',
}));
expectOk('flag the multi-file person case as a conflict', () => insertEvent({
  caseRef: 'p4c-01', type: 'conflict_investigation', state: 'conflict',
  reason: 'two source files point at one CRM row: duplication question, not linking',
}));
const firstDeferId = db.prepare(`SELECT id FROM crm_drive_review_event
   WHERE case_ref = 'p4r-002' AND event_type = 'defer'`).get().id;
expectOk('correct a decision with a NEW event (never an edit)', () => insertEvent({
  caseRef: 'p4r-002', type: 'exclude', state: 'excluded', supersedesId: firstDeferId,
  reason: 'reviewer found this card belongs to a broker, not to the customer record',
}));
const st = db.prepare(`SELECT current_decision, decided_at FROM crm_review_case_state
   WHERE case_ref = 'p4r-002'`).get();
if (st && st.current_decision === 'exclude') pass('derived state = newest decision (exclude) [ok]');
else fail('derived state', `got ${JSON.stringify(st)}`);
const liveCounts = () => ({
  events: db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_event').get().c,
  head: headRow().event_count,
  anchors: db.prepare(`SELECT COUNT(*) AS c FROM crm_drive_review_chain_anchor WHERE anchor_source = 'trigger'`).get().c,
});
let lc = liveCounts();
if (lc.events === lc.head && lc.head === lc.anchors) pass(`chain/head/anchor agree (${lc.events}) [ok]`);
else fail('chain agreement', JSON.stringify(lc));


// ---------------------------------------------------------------- 3b) reveal->approve binding and liveness
const LIVE_TOKEN2 = sha('session-live-2');
openSession(LIVE_TOKEN2, 60, 3600, null);
const approveReason = 'the vCard telephone was read and matched the stored CRM row';
expectFail('approve with no reveal ever granted', () => insertEvent({
  caseRef: 'p4r-003', type: 'approve', state: 'approved', reason: approveReason,
}), 'review_approve_requires_fresh_reveal');
expectOk('a granted reveal for that case and session', () => insertEvent({
  caseRef: 'p4r-003', type: 'reveal', purpose: 'identity_check', outcome: 'granted', sealSha: sealB.ctSha,
  reason: 'the reviewer opened the sealed card to confirm the telephone before any decision',
}));
expectFail('approve reusing another reviewer reveal', () => insertEvent({
  caseRef: 'p4r-003', type: 'approve', state: 'approved', reviewer: 'other.reviewer', reason: approveReason,
}), 'review_approve_requires_fresh_reveal');
expectFail('approve reusing another session reveal', () => insertEvent({
  caseRef: 'p4r-003', type: 'approve', state: 'approved', sessionHash: LIVE_TOKEN2, reason: approveReason,
}), 'review_approve_requires_fresh_reveal');
expectFail('approve after the seal was rotated', () => {
  db.prepare('UPDATE crm_drive_review_seal SET revoked_at = ? WHERE case_ref = ?').run(now, 'p4r-003');
  db.prepare('DELETE FROM crm_drive_review_seal WHERE case_ref = ?').run('p4r-003');
  sealCard('p4r-003', JSON.stringify({ vcard: { fn: 'اسم آخر' }, source: { card_index: 2 } }));
  insertEvent({ caseRef: 'p4r-003', type: 'approve', state: 'approved', reason: approveReason });
}, 'review_approve_requires_fresh_reveal');
const sealB2 = db.prepare('SELECT ciphertext_sha256 AS c FROM crm_drive_review_seal WHERE case_ref = ?').get('p4r-003');
expectOk('the new reveal is refused because its blob was already opened? no: reveal the rotated seal', () => insertEvent({
  caseRef: 'p4r-003', type: 'reveal', purpose: 'identity_check', outcome: 'granted', sealSha: sealB2.c,
  reason: 'the reviewer opened the re-sealed card, whose blob differs from the one first recorded',
}));
expectOk('approve by the same reviewer and session, right after a matching reveal', () => insertEvent({
  caseRef: 'p4r-003', type: 'approve', state: 'approved', reason: approveReason,
}));
expectFail('approve on a reveal older than 24 hours', () => {
  insertEvent({ caseRef: 'p4r-004', type: 'reveal', purpose: 'identity_check', outcome: 'granted',
    sealSha: sealC.ctSha, reason: 'a reveal granted now, to be reused long after the window closes' });
  insertEvent({ caseRef: 'p4r-004', type: 'approve', state: 'approved',
    at: new Date(clock + 25 * 3600_000).toISOString(), reason: approveReason });
}, 'review_approve_requires_fresh_reveal');
expectFail('a granted reveal must pin the ciphertext it opened', () => insertEvent({
  caseRef: 'p4r-001', type: 'reveal', purpose: 'identity_check', outcome: 'granted',
  reason: 'reveal granted but the blob identity was left out of the record',
}), 'CHECK constraint failed');
expectFail('a decision on an expired session is refused', () => insertEvent({
  caseRef: 'p4r-001', type: 'exclude', state: 'excluded', sessionHash: EXPIRED_TOKEN,
  reason: 'the session lapsed between opening the panel and clicking exclude',
}), 'review_event_session_not_live');
expectFail('a decision on a revoked session is refused', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', sessionHash: REVOKED_TOKEN,
  reason: 'the reviewer logged out on another device and the session was revoked',
}), 'review_event_session_not_live');
expectFail('a reveal on a revoked session is refused', () => insertEvent({
  caseRef: 'p4r-001', type: 'reveal', purpose: 'duplicate_check', outcome: 'granted',
  sealSha: sealed.ctSha, sessionHash: REVOKED_TOKEN,
  reason: 'opening a sealed card after the session was revoked',
}), 'review_event_session_not_live');
expectFail('a seal may not promise more than 90 days of retention', () => db.prepare(`INSERT INTO crm_drive_review_seal
    (case_ref, run_key, envelope_version, algo, kdf, aad_mode, key_version, iv_b64u, tag_b64u,
     ciphertext_b64u, ciphertext_sha256, plaintext_sha256, plaintext_len, retention_days, sealed_by,
     created_at, expires_at)
    VALUES ('p4c-01',?,'p4rev_v1','AES-256-GCM','HKDF-SHA256','case_bound_v1',1,?,?,?, ?,?,120,180,?,?,?)`)
  .run(RUN, b64u(randomBytes(12)), b64u(randomBytes(16)), b64u(randomBytes(200)), sha('cX'), sha('pX'),
    'analysis_pipeline', now, new Date(msNow + 180 * 86400_000).toISOString()), 'CHECK constraint failed');
expectFail('a seal may not be shorter than a day of availability', () => db.prepare(`INSERT INTO crm_drive_review_seal
    (case_ref, run_key, envelope_version, algo, kdf, aad_mode, key_version, iv_b64u, tag_b64u,
     ciphertext_b64u, ciphertext_sha256, plaintext_sha256, plaintext_len, retention_days, sealed_by,
     created_at, expires_at)
    VALUES ('p4c-01',?,'p4rev_v1','AES-256-GCM','HKDF-SHA256','case_bound_v1',1,?,?,?, ?,?,120,0,?,?,?)`)
  .run(RUN, b64u(randomBytes(12)), b64u(randomBytes(16)), b64u(randomBytes(200)), sha('cY'), sha('pY'),
    'analysis_pipeline', now, now), 'CHECK constraint failed');
expectFail('a live seal cannot be destroyed before its expiry', () => db.prepare(
  'DELETE FROM crm_drive_review_seal WHERE case_ref = ?').run('p4r-004'), 'review_seal_delete_before_expiry');
expectOk('a revoked seal may be swept away', () => {
  db.prepare('UPDATE crm_drive_review_seal SET revoked_at = ? WHERE case_ref = ?').run(now, 'p4r-004');
  db.prepare('DELETE FROM crm_drive_review_seal WHERE case_ref = ?').run('p4r-004');
});
if (db.prepare("SELECT availability FROM crm_review_seal_availability WHERE case_ref = 'p4c-01'").get().availability !== 'missing') {
  fail('availability view', 'p4c-01 should report a missing seal');
} else pass('crm_review_seal_availability answers without touching content [ok]');
const ciCols = db.prepare('PRAGMA table_info(crm_review_ci_summary)').all().map(c => c.name);
const forbidden = ciCols.filter(c => /^(reviewer|decided_by|signal_digest|drive_file_id|session_hash|reason|crm_contact_id|case_ref)$/.test(c));
if (forbidden.length) fail('crm_review_ci_summary hygiene', `forbidden columns: ${forbidden.join(',')}`);
else pass(`crm_review_ci_summary exposes only counts and chain hashes (${ciCols.length} cols) [ok]`);
const summary = db.prepare('SELECT cases, approved, reveals FROM crm_review_ci_summary').get();
if (summary.cases === db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_case').get().c && summary.approved >= 2) {
  pass(`ci summary agrees with the ledger (cases=${summary.cases}, approved=${summary.approved}) [ok]`);
} else fail('ci summary counts', JSON.stringify(summary));

// ---------------------------------------------------------------- 2) the ledger is not erasable
function barrierFragmentFor(sql) {
  if (/crm_drive_review_chain_anchor/.test(sql)) return 'review_anchors_are_append_only';
  if (/crm_drive_review_chain_head/.test(sql)) return 'review_chain_head_required';
  return 'review_events_are_append_only';
}

const someId = db.prepare('SELECT MIN(id) AS id FROM crm_drive_review_event').get().id;
for (const [label, sql, params] of [
  ['rewrite a reason', 'UPDATE crm_drive_review_event SET reason = ? WHERE id = ?', ['the reviewer never wrote this', someId]],
  ['swap the decision owner', 'UPDATE crm_drive_review_event SET reviewer = ? WHERE id = ?', ['someone.else', someId]],
  ['back-date the timestamp', 'UPDATE crm_drive_review_event SET occurred_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', someId]],
  ['forge the reason digest', 'UPDATE crm_drive_review_event SET reason_sha256 = ? WHERE id = ?', [sha('x'), someId]],
  ['flip the state label', 'UPDATE crm_drive_review_event SET decision_state = ? WHERE id = ?', ['approved', someId]],
  ['erase one event', 'DELETE FROM crm_drive_review_event WHERE id = ?', [someId]],
  ['erase the whole ledger', 'DELETE FROM crm_drive_review_event', []],
  ['rewrite a checkpoint', 'UPDATE crm_drive_review_chain_anchor SET head_sha256 = ? WHERE seq = 1', [sha('forged')]],
  ['delete checkpoints', 'DELETE FROM crm_drive_review_chain_anchor WHERE event_seq > 0', []],
  ['delete the chain head', 'DELETE FROM crm_drive_review_chain_head WHERE run_key = ?', [RUN]],
]) {
  expectFail(label, () => db.prepare(sql).run(...params), barrierFragmentFor(sql));
}

// ---------------------------------------------------------------- 3) forged or detached events
expectFail('event for a case that does not exist', () => insertEvent({
  caseRef: 'p4r-999', type: 'note', snap: sha('invented'), basis: 'vcard_tel',
  reason: 'a decision recorded against an invented case reference',
}), 'review_event_case_not_found');
expectFail('decision bound to another snapshot', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', reason: 'approval quoting data that was never shown', snap: sha('other'),
}), 'review_event_snapshot_mismatch');
expectFail('decision claiming a stronger basis than the case has', () => insertEvent({
  caseRef: 'p4r-002', type: 'note', reason: 'relabelling a name-only case as phone-backed at write time',
  basis: 'vcard_tel',
}), 'review_event_snapshot_mismatch');
expectFail('approve on a name-only basis', () => insertEvent({
  caseRef: 'p4r-002', type: 'approve', state: 'approved', reason: 'the names look identical, so approve this card',
}), /review_approve_requires_(phone_backed_basis|fresh_reveal)/);
expectFail('approve a multi-file person case', () => insertEvent({
  caseRef: 'p4c-01', type: 'approve', state: 'approved', reason: 'treat the two files as one approved identity now',
}), 'review_approve_requires_fresh_reveal');
// A fan-out case has no seal to open, so the reveal barrier fires first; that is the intended
// ordering — an approval is unreachable for that shape even before the basis rule is consulted.
for (const col of ['link_applied', 'merge_authorized', 'contact_write_count']) {
  expectFail(`${col} = 1 can never be recorded`, () => insertEvent({
    caseRef: 'p4r-001', type: 'note', reason: 'an event trying to assert a side effect on the CRM',
    raw: { [col]: 1 },
  }), 'CHECK constraint failed');
}
expectFail('back-date below the last event', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', at: '2019-01-01T00:00:00.000Z', reason: 'inserting into the past of the ledger',
}), 'review_event_chain_sequence_broken');
expectFail('skip a slot in the global chain', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', event_seq: headRow().event_count + 5,
  reason: 'leaving a hole so a real event can be dropped later',
}), 'review_event_chain_sequence_broken');
expectFail('stale prev hash (fork the chain)', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', prev: sha('genesis-again'),
  reason: 'rewinding history to a previous checkpoint',
}), 'review_event_chain_sequence_broken');
expectFail('future case_seq (reorder within a case)', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', case_seq: 77, reason: 'slipping a note between two recorded decisions',
}), 'review_event_case_seq_broken');
expectFail('supersedes an event of another case', () => insertEvent({
  caseRef: 'p4c-01', type: 'note', supersedesId: someId, reason: 'cross-case rewrite of a foreign decision',
}), 'review_supersedes_target_invalid');
expectFail('duplicate genesis anchor (second ledger for a run)', () => db.prepare(`INSERT INTO crm_drive_review_chain_anchor
    (run_key, event_seq, head_sha256, event_count, anchor_source, anchored_at) VALUES (?,?,?,0,'genesis',?)`)
  .run(RUN, 0, GENESIS, now), 'UNIQUE constraint failed');

// ---------------------------------------------------------------- 4) no side effects, no automation, bounded reason
for (const bad of ['merge_contacts', 'link_conversation', 'import_customer', 'delete_contact', 'set_owner']) {
  expectFail(`event_type "${bad}" does not exist`, () => insertEvent({
    caseRef: 'p4r-001', type: bad, reason: 'smuggling an operational side effect through the ledger',
  }), 'CHECK constraint failed');
}
for (const bot of ['auto', 'system', 'pipeline', 'operator', 'worker', 'cron', 'a', '  ']) {
  expectFail(`reviewer "${bot.trim() || '(blank)'}" is not a human label`, () => insertEvent({
    caseRef: 'p4r-001', type: 'note', reviewer: bot, reason: 'automation signing a human decision for it',
  }), 'CHECK constraint failed');
}
for (const short of ['', 'too short', 'ok']) {
  expectFail(`reason "${short}" is not accountable`, () => insertEvent({
    caseRef: 'p4r-001', type: 'note', reason: short,
  }), 'CHECK constraint failed');
}
expectFail('reason holding a phone number is refused', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', reason: 'call him on 01012345678 before deciding anything here',
}), 'CHECK constraint failed');
expectFail('reason holding pasted transcript lines is refused', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', reason: 'line one\nline two of transcript content pasted in',
}), 'CHECK constraint failed');
expectFail('attestation overstates the guarantee', () => insertEvent({
  caseRef: 'p4r-001', type: 'note', attestation: 'kyc_verified_identity',
  reason: 'a note claiming an identity proof the schema never provides',
}), 'CHECK constraint failed');
expectFail('reveal without a purpose', () => insertEvent({
  caseRef: 'p4r-001', type: 'reveal', reason: 'the reviewer opened the sealed card once, purpose unstated',
}), 'CHECK constraint failed');
expectFail('reveal with an unknown purpose', () => insertEvent({
  caseRef: 'p4r-001', type: 'reveal', purpose: 'curiosity', outcome: 'granted',
  reason: 'the reviewer opened the sealed card without a stated need',
}), 'CHECK constraint failed');
expectFail('a decision faking a reveal record', () => insertEvent({
  caseRef: 'p4r-001', type: 'exclude', state: 'excluded', purpose: 'identity_check', outcome: 'granted',
  reason: 'a decision event that also pretends to be a reveal for bookkeeping reasons',
}), 'CHECK constraint failed');

// ---------------------------------------------------------------- 5) case/seal shape
expectFail('case advertising approve_allowed on a name basis', () => addCase('p4r-003', 'file_to_contact', {
  drive_file_id: fileA, match_class: 'name_only_match', evidence: 'name_digest_equal_primary_name',
  confidence: 'low', signal_kind: 'name', signal_digest: sha('n'), crm_contact_id: contactA,
  basis: 'name_digest', approve_allowed: 1,
}), 'CHECK constraint failed');
expectFail('person case with a single file', () => addCase('p4c-09', 'contact_fanout', {
  match_class: 'conflict', evidence: 'same_contact_id_from_two_files', confidence: 'none',
  signal_kind: 'none', files_count: 1, crm_contact_id: contactA, basis: 'name_digest', approve_allowed: 0,
}), 'CHECK constraint failed');
expectFail('unstable case reference', () => addCase('p4r-7', 'file_to_contact', {
  drive_file_id: fileA, match_class: 'exact_match', evidence: 'vcard_tel_digest_equal_primary',
  confidence: 'high', crm_contact_id: contactA, basis: 'vcard_tel', approve_allowed: 1,
}), 'CHECK constraint failed');
expectFail('file case without its file', () => addCase('p4r-004', 'file_to_contact', {
  match_class: 'exact_match', evidence: 'vcard_tel_digest_equal_primary', confidence: 'high',
  crm_contact_id: contactA, basis: 'vcard_tel', approve_allowed: 1,
}), 'CHECK constraint failed');
const sealCols = db.prepare('PRAGMA table_info(crm_drive_review_seal)').all().map(c => c.name);
if (sealCols.some(c => /(^|_)(name|phone|tel|body|transcript|conversation|contact_id|customer)(_|$)/i.test(c))) {
  fail('seal separation', `column may hold personal data: ${sealCols.join(',')}`);
} else pass(`seal table has no personal-data column (${sealCols.length} cols, ciphertext only) [ok]`);
for (const tbl of ['crm_drive_review_case', 'crm_drive_review_event']) {
  const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
  if (cols.some(c => /(^|_)(name|phone|tel|body|transcript|text|customer|opportunity)(_|$)/i.test(c))) {
    fail(`${tbl} separation`, `column may hold personal data: ${cols.join(',')}`);
  } else pass(`${tbl} carries no personal-data column (${cols.length} cols) [ok]`);
}

expectFail('plaintext bigger than the 4 KB cap cannot be sealed', () => db.prepare(
  'UPDATE crm_drive_review_seal SET plaintext_len = 4097 WHERE case_ref = ?').run('p4r-001'),
  'CHECK constraint failed');
expectFail('a second seal for the same case is impossible', () => sealCard('p4r-001'), 'UNIQUE constraint failed');
expectFail('wrong key version cannot decrypt', () => {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', randomBytes(32),
    Buffer.from(`${RUN}|p4r-001`, 'utf8'), Buffer.from(`p4rev_seal_v1|${snapA}`, 'utf8'), 32)),
  Buffer.from(sealed.iv, 'base64url'));
  d.setAAD(aadFor('p4r-001', snapA));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64url')), d.final()]);
}, 'enticate');
expectDetected('blob moved to another case cannot be decrypted', () => {
  db.exec('DROP TRIGGER IF EXISTS trg_review_seal_case_exists');
  db.prepare('UPDATE OR IGNORE crm_drive_review_seal SET case_ref = ?').run('p4r-002');
  const moved = db.prepare('SELECT * FROM crm_drive_review_seal').get();
  let decrypted = null;
  try { decrypted = unseal({ iv: b64u(Buffer.from(moved.iv_b64u, 'base64url')), tag: moved.tag_b64u, ct: moved.ciphertext_b64u }, 'p4r-002'); }
  catch { return true; }                                     // auth failure = binding held
  return decrypted !== cardPlaintext;                          // or wrong plaintext = detected
});
db.exec(sql0009);

// ---------------------------------------------------------------- 7) tampering survives guard removal
expectDetected('edit a recorded decision after dropping the guard trigger', () => {
  db.exec('DROP TRIGGER IF EXISTS trg_review_event_no_update');
  db.prepare('UPDATE crm_drive_review_event SET reviewer = ? WHERE id = ?').run('intruder.label', someId);
  const i = db.prepare('SELECT * FROM crm_review_chain_integrity WHERE run_key = ?').get(RUN);
  return i.broken_links > 0 || i.anchor_mismatches > 0;
});
expectDetected('delete the newest event after dropping the guard trigger', () => {
  db.exec('DROP TRIGGER IF EXISTS trg_review_event_no_delete');
  db.prepare('DELETE FROM crm_drive_review_event WHERE id = (SELECT MAX(id) FROM crm_drive_review_event)').run();
  const c = liveCounts();
  return c.head !== c.events || c.anchors !== c.events;
});
expectDetected('reorder two events after dropping the guard trigger', () => {
  db.exec('DROP TRIGGER IF EXISTS trg_review_event_no_update');
  db.prepare('UPDATE crm_drive_review_event SET event_seq = 9001 WHERE event_seq = (SELECT MIN(event_seq) FROM crm_drive_review_event WHERE event_seq > 1)')
    .run();
  const dense = db.prepare(`SELECT COUNT(*) AS c, MIN(event_seq) AS lo, MAX(event_seq) AS hi
    FROM crm_drive_review_event WHERE run_key = ?`).get(RUN);
  const i = db.prepare('SELECT * FROM crm_review_chain_integrity WHERE run_key = ?').get(RUN);
  return dense.hi !== dense.c || i.broken_links > 0 || i.anchor_mismatches > 0;
});
expectDetected('wipe the whole ledger and restart it (head + anchors remember)', () => {
  const before = liveCounts();
  db.exec('DROP TABLE IF EXISTS crm_drive_review_event');
  db.exec(sql0009);
  const after = liveCounts();
  return after.events === 0 && (before.events > 0 && (after.head !== 0 || after.anchors !== 0));
});
const declaredTriggers = (sql0009.match(/CREATE TRIGGER IF NOT EXISTS (trg_review_[a-z_]+)/g) || [])
  .map(s => s.split(' ').pop());
const rebuilt = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_review%'").all().map(r => r.name);
const missing = declaredTriggers.filter(n => !rebuilt.includes(n));
if (!missing.length && rebuilt.length === declaredTriggers.length) {
  pass(`all ${declaredTriggers.length} guard triggers present after re-running 0009 [ok]`);
} else fail('trigger inventory', `expected ${declaredTriggers.length}, found ${rebuilt.length}; missing=${missing.join(',')}`);
const anchorHistory = db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_chain_anchor').get().c;
if (anchorHistory > 0) pass(`immutable anchor history survived every attempt (${anchorHistory} rows) [ok]`);
else fail('anchor history', 'anchors vanished — retention is not enforceable');

// ---------------------------------------------------------------- 8) PII shape of the migration text
const digits = (sql0009.match(/(?<![\w-])\d{10,}(?![\w-])/g) || []);
if (digits.length) fail('pii_scan', `long digit runs: ${digits.slice(0, 3).join(',')}`);
else pass('pii_scan: no 10+ digit runs (no phone numbers, no national ids) [ok]');
if (/[\u0600-\u06FF]/.test(sql0009)) fail('pii_scan', 'Arabic text present in the DDL (a name could hide there)');
else pass('pii_scan: no Arabic text anywhere in the migration [ok]');
const emails = sql0009.match(/[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,64}[.][A-Za-z]{2,8}/g) || [];
if (emails.length) fail('pii_scan', `e-mail addresses: ${emails.slice(0, 2).join(',')}`);
else pass('pii_scan: no e-mail addresses [ok]');
const longTokens = (sql0009.match(/\b[A-Za-z0-9_-]{29,}\b/g) || [])
  .filter(x => !/^(crm_|trg_|idx_|p4rev|review_|0009|vcard|unmatched|conflict_investigation|not_in|session_)/.test(x));
if (longTokens.length) fail('pii_scan', `suspicious long tokens: ${longTokens.slice(0, 3).join(',')}`);
else pass('pii_scan: no Drive ids / file ids of real customers [ok]');

// ---------------------------------------------------------------- 9) idempotency + operational proof
const before = liveCounts();
const casesBefore = db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_case').get().c;
expectOk('re-running 0009 changes nothing', () => {
  db.exec(sql0009);
  const after = liveCounts();
  const casesAfter = db.prepare('SELECT COUNT(*) AS c FROM crm_drive_review_case').get().c;
  if (after.events !== before.events || after.head !== before.head || casesAfter !== casesBefore) {
    throw new Error(`state moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});
if (mode === 'migrations') {
  const ops = {};
  for (const tbl of ['crm_contacts', 'crm_contact_phones', 'crm_opportunities', 'crm_conversations',
    'crm_conversation_messages', 'crm_contact_audit_log', 'crm_drive_file_registry']) {
    ops[tbl] = db.prepare(`SELECT COUNT(*) AS c FROM ${tbl}`).get().c;
  }
  if (Object.values(ops).some(v => v !== 0)) fail('no operational write', JSON.stringify(ops));
  else pass(`operational tables still empty in this rehearsal (${Object.keys(ops).length} tables) [ok]`);
}
const files = existsSync(MIG_DIR) ? readdirSync(MIG_DIR).filter(f => f.startsWith('0009')) : [];
console.log(`draft_is_outside_migrations=${files.length === 0 ? 'yes' : 'NO'}`);
console.log(`migrations_applied=${applied.join(',')} skipped=${skipped.join(',') || 'none'}`);

const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}`);
const obj = db.prepare(`SELECT type, COUNT(*) AS c FROM sqlite_master
   WHERE name LIKE 'crm_drive_review%' OR name LIKE 'trg_review%' OR name LIKE 'crm_review%' OR name LIKE 'idx_crm_review%'
   GROUP BY type`).all();
const objSummary = obj.map(o => o.type + '=' + o.c).join(' ');
console.log('\nmode=' + mode + ' review_objects: ' + objSummary);
console.log(`ABUSE ${results.length - failed.length}/${results.length} checks held`);
if (failed.length) {
  console.log('BARRIERS_MISSING:');
  for (const f of failed) console.log(` - ${f.label} :: ${f.detail}`);
  process.exit(1);
}
console.log('ALL_BARRIERS_HELD');
db.close();
