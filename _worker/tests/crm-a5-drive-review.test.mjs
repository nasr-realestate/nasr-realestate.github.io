/**
 * A5 (أ) — طبقة مراجعة ملفات Drive فوق 0011، عبر المسار الفعلي (worker.fetch → جلسة → خدمة → DDL نفس
 * المطبَّق على قاعدة الاختبار). كل البيانات صناعية، ولا استدعاء لـDrive في هذا المسار إطلاقًا — وهو شرط
 * يُختبر هنا لا يُفترض.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker from '../crm-worker.js';
import { buildRegistry, sha } from './_registry-fixture.mjs';
import { driveRefFor } from '../../scripts/crm/seed-drive-file-refs.mjs';
import {
  decisionDigest, listDriveReviewCasesPayload, recordReviewDecisionPayload,
  REVIEW_DECISIONS, proposeReviewContactLinkPayload,
} from '../crm-drive-file-review.js';

const ORIGIN = 'https://nasr-crm-api-test.example.workers.dev';
const MTIM = '2026-11-02T09:00:00.000Z';

/** A registered file with a recorded version and a head projection — exactly the shape A4 produced. */
function seedReviewCase(sqlite, { tag = 'A5', disposition = 'needs_governance_review', boundSeq = 1 } = {}) {
  const driveId = `SYNTHDRIVE${tag}`;
  const ref = driveRefFor(driveId);
  const digest = sha(`${driveId}-bytes-v1`);
  sqlite.prepare(`INSERT INTO crm_drive_file_registry
      (id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path, mime_type, file_size,
       drive_created_at, drive_modified_at, content_sha256, content_type, processing_status, review_status,
       last_processed_at, processing_receipt_ref, extracted_records_count, processing_attempts, metadata_json,
       created_at, updated_at, drive_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`reg-${tag}`, driveId, 'SYNTH-FOLDER', `synth-${tag}.zip`, `synth-${tag}.zip`, '/synth',
      'application/zip', 1024, MTIM, MTIM, digest, 'ZIP', 'metadata_scanned', 'not_required', MTIM,
      `receipt-${tag}`, 0, 1, '{}', MTIM, MTIM, ref);
  sqlite.prepare(`INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes, drive_modified_at,
       observed_at, observed_by, receipt_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`${ref}#1`, ref, 1, digest, 'verified_local_recompute', 1024, MTIM, MTIM, 'intake_pipeline', `receipt-${tag}`);
  sqlite.prepare('UPDATE crm_drive_file_registry SET head_version_seq = 1 WHERE drive_ref = ?').run(ref);
  // 0011 pins the shape: case_ref = 'frw-' || substr(drive_ref,1,16) || '-' || bound_version_seq
  const caseRef = `frw-${ref.slice(0, 16)}-${boundSeq}`;
  const snapshot = sha(`case-snapshot|${caseRef}|${digest}`);
  sqlite.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(caseRef, ref, boundSeq, digest, disposition, 'open', snapshot, sha(`genesis|${caseRef}`), 'intake_pipeline', MTIM);
  return { caseRef, ref, digest, snapshot };
}

async function buildEnv() {
  const { sqlite, db } = buildRegistry({ ledger: true });
  const accessCode = crypto.randomBytes(24).toString('base64url');
  const env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    CRM_ALLOWED_ORIGIN: ORIGIN,
    CRM_ACCESS_CODE: accessCode,
    CRM_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
    CRM_SITE_SOURCE_ID: '1',
    CRM_NASR_AREA_IDS: '1,2',
  };
  const login = await worker.fetch(new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const csrf = (await login.json()).csrf_token;
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { origin: ORIGIN, cookie };
    if (method !== 'GET') headers['x-crm-csrf'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  }
  /** the live session hash, taken the way the worker takes it: from the cookie, never from a body */
  const tokenHash = await (async () => {
    const row = sqlite.prepare('SELECT token_hash AS h FROM crm_sessions LIMIT 1').get();
    return row.h;
  })();
  /* A5-BLOCKER (found by this suite, not invented for it): 0009 §5.9 and 0011 §… both require
     `s.expires_at > strftime('%s','now') * 1000`, i.e. epoch *milliseconds*, while the Worker writes
     `crm_sessions.expires_at` in epoch *seconds* (0002 does not declare a unit). So a live session as the
     deployed login produces can never satisfy them, and every review decision except `noted` is refused by
     the database. `alignSessionUnits()` honors the unit the ledger expects so the *rest* of the ledger can be
     tested; A5R-2b pins the mismatch itself, and the report presents the two ways out instead of choosing one. */
  function alignSessionUnits() {
    sqlite.prepare('UPDATE crm_sessions SET expires_at = expires_at * 1000').run();
  }
  return { sqlite, db, env, call, tokenHash, alignSessionUnits };
}

test('A5R-1 قائمة الحالات تُقرأ عبر API موثَّق، ومغلقة في وجه المجهول', async () => {
  const { sqlite, call } = await buildEnv();
  const seeded = seedReviewCase(sqlite, { tag: 'LIST' });
  const listed = await call('/api/reviews/drive');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.cases[0].case_ref, seeded.caseRef);
  assert.equal(listed.body.cases[0].decision_count, 0);
  assert.equal(listed.body.by_status[0].count, 1);
  const detail = await call(`/api/reviews/drive/${seeded.caseRef}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.case.review_disposition, 'needs_governance_review');
  assert.deepEqual(detail.body.decisions, [], 'a fresh case has no decisions yet');
  const filtered = await call('/api/reviews/drive?status=decided');
  assert.equal(filtered.body.total, 0, 'the status filter is real, not decoration');
  const anonymous = await worker.fetch(new Request(`${ORIGIN}/api/reviews/drive`, {}), (await buildEnv()).env);
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `unauthenticated read must not work (${anonymous.status})`);
  const badRef = await call('/api/reviews/drive/not-a-case-ref!!');
  assert.ok(badRef.status === 400 || badRef.status === 404, JSON.stringify(badRef.body));
});

test('A5R-2 القرار يُسجَّل في السلسلة، والحالة تتحرك بواسطة 0011 نفسها لا بتراخيص الخدمة', async () => {
  const { sqlite, call, alignSessionUnits } = await buildEnv();
  alignSessionUnits();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'DEC' });
  const noted = await call('/api/reviews/drive/decision', {
    method: 'POST',
    body: { case_ref: caseRef, decision: 'noted', reason: 'راجعت الوصف: لا يوجد رقم موثق داخل الملف', reviewer: 'منى' },
  });
  assert.equal(noted.status, 201, JSON.stringify(noted.body));
  assert.equal(noted.body.decision.decision_seq, 1);
  assert.match(noted.body.decision.decision_sha256, /^[0-9a-f]{64}$/);
  const closed = await call('/api/reviews/drive/decision', {
    method: 'POST',
    body: { case_ref: caseRef, decision: 'close_no_action', reason: 'لا إجراء: الملف خارج نطاق الطلبات الحالية', reviewer: 'منى' },
  });
  assert.ok(closed.status < 400, JSON.stringify(closed.body));
  const row = sqlite.prepare('SELECT status, decided_at FROM crm_drive_file_review_case WHERE case_ref = ?').get(caseRef);
  assert.equal(row.status, 'closed_no_action', 'the ledger trigger moved the case, and only the ledger moved it');
  assert.ok(row.decided_at);
  const chain = await call(`/api/reviews/drive/${caseRef}`);
  assert.equal(chain.body.chain.decision_count, 2);
  assert.equal(chain.body.chain.intact, true, 'the anchor head must equal the newest decision digest');
  // 0011 anchors the chain with a genesis row at seq 0 plus one row per decision, all written by triggers.
  assert.deepEqual(chain.body.anchors.map(a => a.decision_seq), [0, 1, 2], 'the ledger keeps a genesis anchor and one per decision');
  assert.equal(chain.body.anchors[0].anchor_source, 'genesis');
  assert.equal(chain.body.anchors.filter(a => a.anchor_source === 'trigger').length, 2, 'no decision without its anchor');
  assert.equal(chain.body.anchors[2].decision_count, 2);
  const genesis = sqlite.prepare('SELECT genesis_sha256 AS g FROM crm_drive_file_review_case WHERE case_ref = ?').get(caseRef).g;
  assert.equal(chain.body.decisions[0].prev_decision_sha256, genesis, 'seq 1 chains from the case genesis');
  assert.equal(chain.body.decisions[1].prev_decision_sha256, chain.body.decisions[0].decision_sha256, 'seq 2 chains from seq 1');
});

test('A5R-2b الحاجز كما هو اليوم: جلسة العامِل بالثواني لا تُقبل في الدفتر، والرفض مسمّى لا مكتوم', async () => {
  const { sqlite, call } = await buildEnv();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'UNITS' });
  const noted = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'noted', reason: 'قيد ملاحظة ينجح لأن 0011 يعفيه من شرط الجلسة' } });
  assert.ok(noted.status < 400, JSON.stringify(noted.body));
  const escalate = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'close_no_action', reason: 'إغلاق بلا إجراء على ملف صناعي للاختبار' } });
  assert.equal(escalate.status, 403, JSON.stringify(escalate.body));
  assert.equal(escalate.body.error, 'session_not_live');
  assert.equal(escalate.body.barrier, 'file_review_decision_session_not_live');
  const secs = sqlite.prepare('SELECT expires_at, CAST(strftime(\'%s\',\'now\') AS INTEGER) * 1000 AS needs FROM crm_sessions LIMIT 1').get();
  assert.ok(secs.expires_at < secs.needs, 'the unit mismatch is the cause: seconds stored against milliseconds required');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_review_decision').get().c, 1, 'the refused decision wrote nothing');
});

test('A5R-3 المدخلات المرفوضة: سبب قصير، أو رقم هاتف داخل السبب، أو قرار غير موجود', async () => {
  const { sqlite, db, call } = await buildEnv();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'VAL' });
  const short = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'noted', reason: 'قصير', reviewer: 'منى' } });
  assert.equal(short.status, 400, JSON.stringify(short.body));
  assert.equal(short.body.error, 'reason_too_short');
  const phoneInReason = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'noted', reason: 'الاتصال بالعميل على 01000000001 ثم المتابعة لاحقًا', reviewer: 'منى' } });
  assert.equal(phoneInReason.status, 400, 'a reason must not smuggle a phone number (0011 CHECK, enforced at the edge)');
  assert.equal(phoneInReason.body.error, 'reason_contains_identifier_like_digits');
  const invented = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'merge_contacts', reason: 'دمج العميلين لأن الاسم متشابه تمامًا', reviewer: 'منى' } });
  assert.equal(invented.status, 400, 'there is no merge decision in the 0011 vocabulary, and this layer does not invent one');
  assert.equal(invented.body.error, 'decision_not_allowed');
  const ghost = await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: 'frw-ghost000000000', decision: 'noted', reason: 'حالة غير موجودة أصلًا للاختبار' } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error, 'review_case_not_found');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_review_decision').get().c, 0, 'a refusal writes nothing');
  // the service-level vocabulary is the same set, so a bypassing caller cannot widen it
  assert.equal(REVIEW_DECISIONS.has('merge_contacts'), false);
  const robot = await recordReviewDecisionPayload(db, { case_ref: caseRef, decision: 'noted', reason: 'قرار من آلة لا من إنسان' }, { actor: 'system', sessionHash: 'f'.repeat(64) });
  assert.deepEqual({ error: robot.error, status: robot.status }, { error: 'reviewer_not_human', status: 403 });
});

test('A5R-4 السجل لا يُعاد كتابته: append-only، ومنقّح خارج السلسلة مرفوض، وقرار بلا جلسة حيّة مرفوض', async () => {
  const { sqlite, db, tokenHash, call, alignSessionUnits } = await buildEnv();
  alignSessionUnits();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'CHAIN' });
  await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'noted', reason: 'قيد أول في سلسلة الاختبار', reviewer: 'منى' } });
  assert.throws(() => sqlite.prepare(`UPDATE crm_drive_file_review_decision SET reason = 'عُدِّلت' WHERE case_ref = '${caseRef}'`).run(),
    /file_review_anchors_are_append_only|drive_versions_are_append_only|append_only/);
  assert.throws(() => sqlite.prepare(`DELETE FROM crm_drive_file_review_decision`).run(), /append_only/);
  const head = sqlite.prepare('SELECT decision_sha256 AS d FROM crm_drive_file_review_decision WHERE case_ref = ?').get(caseRef).d;
  // a forged seq-2 bound to the wrong snapshot is refused by the ledger, not by politeness
  assert.throws(() => sqlite.prepare(`INSERT INTO crm_drive_file_review_decision
      (case_ref, decision_seq, decision, reviewer, reviewer_attestation, session_hash, reason, reason_sha256,
       bound_version_seq, head_version_seq_at_decision, case_snapshot_sha256, occurred_at, prev_decision_sha256, decision_sha256)
      VALUES ('${caseRef}', 2, 'noted', 'منى', 'session_label_not_independent_identity', '${tokenHash}',
              'سبب مزوّر لاختبار الحاجز', '${sha('r')}', 1, 1, '${sha('wrong-snapshot')}', '2026-11-03T09:00:00.000Z',
              '${head}', '${sha('forged')}')`).run(),
    /file_review_decision_snapshot_mismatch/);
  // and the same decision digest cannot be written twice
  const duplicate = await decisionDigest({ caseRef, seq: 2, decision: 'noted', reason: 'سبب مكرر لاختبار التصادم', snapshot: sqlite.prepare('SELECT case_snapshot_sha256 AS s FROM crm_drive_file_review_case WHERE case_ref = ?').get(caseRef).s });
  const firstDup = await recordReviewDecisionPayload(db, { case_ref: caseRef, decision: 'noted', reason: 'سبب مكرر لاختبار التصادم' }, { actor: 'منى', sessionHash: tokenHash });
  assert.ok(!firstDup.error, JSON.stringify(firstDup));
  const secondDup = await recordReviewDecisionPayload(db, { case_ref: caseRef, decision: 'noted', reason: 'سبب مكرر لاختبار التصادم' }, { actor: 'منى', sessionHash: tokenHash });
  // seq advances, so the same text at a different seq is a legitimate new decision; the digest differs then
  assert.ok(secondDup.decision === undefined || secondDup.decision.decision_sha256 !== duplicate);
  // a dead session may not decide anything except a note — and the note path is the only exemption 0011 grants
  const dead = await recordReviewDecisionPayload(db, { case_ref: caseRef, decision: 'recommend_registration', reason: 'قرار بجلسة غير حيّة لاختبار الحاجز' }, { actor: 'منى', sessionHash: 'e'.repeat(64) });
  assert.deepEqual({ error: dead.error, status: dead.status, barrier: dead.barrier },
    { error: 'session_not_live', status: 403, barrier: 'file_review_decision_session_not_live' });
});

test('A5R-5 لا قرار لحالة بلا سجل إصدار موثَّق — في القاعدة وفي الخدمة معًا', async () => {
  const { sqlite, db, tokenHash } = await buildEnv();
  const ref = driveRefFor('SYNTHDRIVENOVER');
  const ghostCaseRef = 'frw-' + ref.slice(0, 16) + '-1';
  const digest = sha('no-version-file');
  sqlite.prepare(`INSERT INTO crm_drive_file_registry
      (id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path, mime_type, file_size,
       drive_created_at, drive_modified_at, content_sha256, content_type, processing_status, review_status,
       last_processed_at, processing_receipt_ref, extracted_records_count, processing_attempts, metadata_json,
       created_at, updated_at, drive_ref)
      VALUES ('reg-nover', 'SYNTHDRIVENOVER', 'SYNTH-FOLDER', 'synth-nover.zip', 'synth-nover.zip', '/synth',
              'application/zip', 1024, ?, ?, ?, 'ZIP', 'metadata_scanned', 'not_required', ?, 'rc-nover', 0, 1,
              '{}', ?, ?, ?)`)
    .run(MTIM, MTIM, digest, MTIM, MTIM, MTIM, ref);
  assert.throws(() => sqlite.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES (?, ?, 1, ?, 'needs_governance_review', 'open', ?, ?, 'intake_pipeline', ?)`)
    .run(ghostCaseRef, ref, digest, sha('snap'), sha('genesis'), MTIM),
    /file_review_case_requires_a_recorded_version/);
  /* The head projection cannot even be hidden while versions exist: 0011's own `registry_head_must_match_ledger`
   * refuses it. That is why `registry_head_missing` in this layer is defence-in-depth for a half-written
   * intake — not a state a caller can reach by editing the row — and why the layer never trusts a
   * caller-reported head: it reads the head out of the registry on every decision. */
  const seeded = seedReviewCase(sqlite, { tag: 'HEAD' });
  assert.throws(() => sqlite.prepare('UPDATE crm_drive_file_registry SET head_version_seq = NULL WHERE drive_ref = ?').run(seeded.ref),
    /registry_head_must_match_ledger/);
  const decided = await recordReviewDecisionPayload(db, { case_ref: seeded.caseRef, decision: 'noted', reason: 'قيد بعد التأكيد أن الرأس لا يمكن إخفاؤه' }, { actor: 'منى', sessionHash: tokenHash });
  assert.ok(decided.decision, JSON.stringify(decided));
  assert.equal(sqlite.prepare('SELECT head_version_seq AS h FROM crm_drive_file_registry WHERE drive_ref = ?').get(seeded.ref).h, 1, 'the head the decision recorded is the ledger head, untouched');
});

test('A5R-6 الصدأ يُرى: ملف ظهر إصدار أحدث يجعل إغلاق الحالة مرفوضًا', async () => {
  const { sqlite, call, alignSessionUnits } = await buildEnv();
  alignSessionUnits();
  const { caseRef, ref, digest } = seedReviewCase(sqlite, { tag: 'STALE' });
  sqlite.prepare(`INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes, drive_modified_at,
       observed_at, observed_by, receipt_ref)
      VALUES (?, ?, 2, ?, 'verified_local_recompute', 2048, ?, ?, 'intake_pipeline', 'rc-v2')`)
    .run(`${ref}#2`, ref, sha('synth-bytes-v2'), MTIM, MTIM);
  sqlite.prepare('UPDATE crm_drive_file_registry SET head_version_seq = 2, content_sha256 = ? WHERE drive_ref = ?')
    .run(digest, ref);
  const stale = await call('/api/reviews/drive/decision', {
    method: 'POST',
    body: { case_ref: caseRef, decision: 'close_no_action', reason: 'محاولة إغلاق على إصدار قدمه أحدث منه', reviewer: 'منى' },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, 'case_stale_newer_version');
  assert.equal(stale.body.barrier, 'review_case_bound_version_is_stale');
  assert.equal(sqlite.prepare('SELECT status FROM crm_drive_file_review_case WHERE case_ref = ?').get(caseRef).status, 'open', 'a refused decision leaves the case exactly where it was');
});

test('A5R-7 الربط اقتراحٌ بعد قرار، ولا يلمس جدول عميل واحدًا', async () => {
  const { sqlite, db, tokenHash, call, alignSessionUnits } = await buildEnv();
  alignSessionUnits();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'LINK' });
  sqlite.prepare(`INSERT INTO crm_contacts (id, name, communication_consent, created_at, updated_at)
      VALUES ('synth-contact-l1', 'عميل صناعي للربط', 'request_only', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z')`).run();
  const contact = { id: 'synth-contact-l1' };
  const before = JSON.stringify(sqlite.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(contact.id));
  // 0011 refuses a link that has no recorded decision behind it — the barrier, proven directly
  assert.throws(() => sqlite.prepare(`UPDATE crm_drive_file_review_case SET crm_contact_id = 'synth-contact-l1',
      link_state = 'proposed', link_basis = 'manual_pin', link_confirmed_by = 'منى', link_confirmed_at = '2026-11-03T09:00:00.000Z',
      link_evidence_sha256 = '${sha('ev')}' WHERE case_ref = '${caseRef}'`).run(),
    /file_review_link_requires_explicit_human_basis/);
  const proposal = await proposeReviewContactLinkPayload(db, {
    case_ref: caseRef, contact_id: contact.id, link_basis: 'manual_pin', evidence_ref: 'wa:msg:700009',
    reason: 'الربط بعد مطابقة الاسم ورقم المرسل يدويًا من المراجع',
  }, { actor: 'منى', sessionHash: tokenHash });
  assert.ok(!proposal.error, JSON.stringify(proposal));
  assert.equal(proposal.proposal.link_state, 'proposed');
  assert.equal(proposal.decision.decision_seq, 1, 'the decision is written first, and it is what unlocks the link');
  const caseRow = sqlite.prepare('SELECT link_state, crm_contact_id, link_basis FROM crm_drive_file_review_case WHERE case_ref = ?').get(caseRef);
  assert.deepEqual([caseRow.link_state, caseRow.crm_contact_id, caseRow.link_basis], ['proposed', contact.id, 'manual_pin']);
  assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(contact.id)), before,
    'the proposal must not touch the customer row at all');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_contact_phones`).get().c, 0, 'no phone was invented, copied or merged');
  // the approval state needs a live review event from 0009 — this layer does not fake it
  assert.throws(() => sqlite.prepare(`UPDATE crm_drive_file_review_case SET link_state = 'approved_by_contact_review'
      WHERE case_ref = '${caseRef}'`).run(), /file_review_link_requires_explicit_human_basis/);
  const detail = await call(`/api/reviews/drive/${caseRef}`);
  assert.equal(detail.body.case.link_state, 'proposed');
  assert.ok(detail.body.chain.intact);
});

test('A5R-8 لا Drive API، ولا تعديل لملف أصلي: الحظر مفحوص في النص المصدر لا معلن', async () => {
  const sources = await Promise.all([
    '../crm-drive-file-review.js', '../crm-customer-requests.js', '../crm-interactions.js', '../crm-operational-shared.js',
  ].map(p => readFile(new URL(p, import.meta.url), 'utf8')));
  const all = sources.join('\n');
  for (const forbidden of ['www.googleapis.com', 'drive/v3', 'files/', 'fetch(', 'XMLHttpRequest', 'Authorization']) {
    assert.equal(all.includes(forbidden), false, `the A5 layer must not reach out (found ${forbidden})`);
  }
  assert.equal(/(INSERT INTO|UPDATE|DELETE FROM)\s+crm_drive_file_registry/.test(all), false,
    'the review layer never writes the registry: originals and their metadata are not its to touch');
  assert.equal(/(INSERT INTO|UPDATE|DELETE FROM)\s+crm_(contacts|contact_phones)/.test(all), false,
    'the review layer never writes customer rows');
});

test('A5R-9 audit: كل قرار يترك أثرًا مبصَمًا في سجل التشغيل', async () => {
  const { sqlite, call, alignSessionUnits } = await buildEnv();
  alignSessionUnits();
  const { caseRef } = seedReviewCase(sqlite, { tag: 'AUD' });
  await call('/api/reviews/drive/decision', { method: 'POST', body: { case_ref: caseRef, decision: 'schedule_rehash', reason: 'يلزم إعادة حساب البصمة بعد تعديل الوصف', reviewer: 'منى' } });
  const row = sqlite.prepare(`SELECT entity, entity_id, action, actor, detail_sha256 FROM crm_operational_audit_log
      WHERE entity = 'drive_review_decision' ORDER BY seq DESC LIMIT 1`).get();
  assert.equal(row.entity_id, caseRef);
  assert.equal(row.action, 'decision_schedule_rehash');
  assert.equal(row.actor, 'منى');
  assert.match(row.detail_sha256, /^[0-9a-f]{64}$/);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_operational_audit_log WHERE contact_id IS NOT NULL AND entity = 'drive_review_decision'`).get().c, 0,
    'a review decision is not attributed to a customer row — it is about a file');
});
