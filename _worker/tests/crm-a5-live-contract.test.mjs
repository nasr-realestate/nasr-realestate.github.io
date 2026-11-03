/**
 * A5 — عقد الفحوص الحيّة: يثبت أن `_worker/tests/live-a5-verify.mjs` يقيس شيئًا فعلًا.
 *
 * التشغيل هنا حقيقي بقدر ما تسمح به البيئة: خادم HTTP على loopback يُوَجَّه إلى `worker.fetch` نفسه
 * (نفس العامل المنشور، لا نسخة مختصرة منه)، وقاعدة SQLite تحمل كل `_worker/migrations/*.sql` — أي أن
 * حواجز 0011/0009/0012/0013/0014 سارية على المسار، والعميل المستخدم هو `CRMClient` نفسه الذي يستخدمه
 * المتصفح (لا fetch مكتوب لليد). الفارغ مرفوض: كل فحص يفشل إن لم يَرَ أرقامًا محددة.
 *
 * الاختباران 2 و3 هما ضمانة عدم العبث: نفس الفحوص على سلسلة بلا 0014 يجب أن تسقط، وعلى بنية بلا A5
 * يجب أن تُسمّي العلة («غير منشور») بدل أن ترمي خطأ غامضًا.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import worker from '../crm-worker.js';
import { buildRegistry, sha } from './_registry-fixture.mjs';
import { driveRefFor } from '../../scripts/crm/seed-drive-file-refs.mjs';
import { createTransport, runA5LiveChecks } from './live-a5-verify.mjs';

const MTIM = '2026-11-02T09:00:00.000Z';
// العامل يفشل مغلقًا إن لم يكن CRM_ALLOWED_ORIGIN نطاقًا على https؛ النقل المحلي يذهب إلى loopback
// ويرسل هذا النطاق في ترويسة Origin — نفس المطابقة التي تجري على النسخة المنشورة، بلا تخفيف للحاجز.
const TEST_ORIGIN = 'https://crm-a5-live.invalid';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'live-a5-verify.mjs');

/** نفس البنية التي ينتجها A4: ملف مسجَّل، إصدار موثَّق، إسناد رأس، وحالة مراجعة مفتوحة. */
function seedReviewCase(sqlite, tag) {
  const driveId = `SYNTHLIVE${tag}`;
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
  const caseRef = `frw-${ref.slice(0, 16)}-1`;
  sqlite.prepare(`INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(caseRef, ref, 1, digest, 'needs_governance_review', 'open', sha(`case-snapshot|${caseRef}|${digest}`),
      sha(`genesis|${caseRef}`), 'intake_pipeline', MTIM);
  return caseRef;
}

function seedBase(sqlite) {
  sqlite.exec(`INSERT OR IGNORE INTO sources (id, name) VALUES (1, 'synthetic');
    INSERT OR IGNORE INTO areas (id, name_ar) VALUES (1, 'الأندلس'), (2, 'مكرم عبيد');
    INSERT INTO listings (id, source_id, external_id, url, title, property_type, transaction_type,
      area_id, area_m2, price, bedrooms, bathrooms, finishing, observed_at)
      VALUES (900001, NULL, 'synth-live-a', '/properties/synth-a/', 'شقة صناعية أ', 'apartment', 'sale',
              NULL, 140, 3600000, 3, 2, 'نصف تشطيب', '2026-11-01 09:00:00');`);
}

/** Worker الفعلي خلف HTTP: لا تحويلات ولا اختصارات — فقط جسر ثنائي الاتجاه. */
async function serve(env) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.set(req.rawHeaders[i], req.rawHeaders[i + 1]);
    headers.set('cf-connecting-ip', '203.0.113.9');
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    // العنوان بمضيف المنفذ الحقيقي: العامل يقرأ النطاق من الطلب، فيجب أن يمرّ فحص Origin كما في الإنتاج.
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers, body,
    });
    let response;
    try {
      response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler_failed' }));
      return;
    }
    const out = {};
    for (const [key, value] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie' || lower === 'content-length' || lower === 'transfer-encoding') continue;
      out[key] = value;
    }
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise(resolve => server.close(resolve)) };
}

async function buildLiveHarness({ withReviewCase = true, apply0014 = true } = {}) {
  const { sqlite, db } = buildRegistry({ ledger: true });
  seedBase(sqlite);
  const caseRef = withReviewCase ? seedReviewCase(sqlite, 'LIVE') : '';
  const accessCode = crypto.randomBytes(24).toString('base64url');
  const env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    CRM_ALLOWED_ORIGIN: TEST_ORIGIN,
    CRM_ACCESS_CODE: accessCode,
    CRM_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
    CRM_SITE_SOURCE_ID: '1',
    CRM_NASR_AREA_IDS: '1,2',
  };
  const started = await serve(env);
  if (!apply0014) {
    // أرجع الحارسَين إلى ما كانا عليه قبل 0014 (مللي ثانية) — لنفس الغرض الذي من أجله كُتب 0014.
    sqlite.exec(`DROP TRIGGER IF EXISTS trg_file_review_decision_session_live;
      CREATE TRIGGER trg_file_review_decision_session_live
        BEFORE INSERT ON crm_drive_file_review_decision
        WHEN NEW.decision <> 'noted'
             AND NOT EXISTS (SELECT 1 FROM crm_sessions s
                              WHERE s.token_hash = NEW.session_hash
                                AND s.revoked_at IS NULL
                                AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
      BEGIN
        SELECT RAISE(ABORT, 'file_review_decision_session_not_live');
      END;`);
  }
  const expire = () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare('UPDATE crm_sessions SET created_at = ?, expires_at = ?').run(now - 7200, now - 60);
  };
  return { sqlite, started, accessCode, caseRef, expire,
    run: options => runA5LiveChecks(createTransport({ baseUrl: started.baseUrl, origin: TEST_ORIGIN }), { accessCode, ...options }) };
}

const ids = summary => summary.checks.map(c => `${c.id}:${c.status}`).join(' ');

test('LIVE-1 فحوص A5 الحيّة تمرّ عبر HTTP على العامل الحقيقي بنفس DDL قاعدة الاختبار', async () => {
  const harness = await buildLiveHarness();
  try {
    const summary = await harness.run({ writeDecision: 'state-changing', expireHook: harness.expire });
    assert.equal(summary.ok, true, `checks failed: ${JSON.stringify(summary.checks.filter(c => c.status === 'fail'))}`);
    assert.equal(summary.checks.length, 10, `expected 10 checks, got: ${ids(summary)}`);
    assert.equal(summary.checks.every(c => c.status === 'pass'), true, ids(summary));
    const evidence = Object.fromEntries(summary.checks.map(c => [c.id, c.evidence]));
    assert.match(evidence['A5-L8'], /close_no_action_seq=1/, 'the state-changing decision must land as seq 1');
    assert.match(evidence['A5-L9'], /expired=(401|403)/, 'a dead session must be refused — by the worker gate or the ledger guard');
    assert.match(evidence['A5-L4'], /found_by_both=yes/, 'phone search must find the customer by either number');
    // الحالة تحركت بقاعدة 0011 نفسها، والدفتر Append-only لم يُكتب فيه إلا القرار المسموح
    assert.equal(harness.sqlite.prepare('SELECT status AS s FROM crm_drive_file_review_case WHERE case_ref = ?')
      .get(harness.caseRef).s, 'closed_no_action');
    assert.equal(harness.sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_review_decision').get().c, 1);
    assert.equal(harness.sqlite.prepare('SELECT COUNT(*) AS c FROM crm_contacts WHERE name NOT LIKE ?').get('TEST ONLY%').c, 0,
      'every synthetic row stays inside the TEST ONLY prefix');
  } finally { await harness.started.close(); }
});

test('LIVE-2 الفحوص نفسها تسقط على سلسلة بلا 0014 — إذًا هي تقيس الإصلاح ولا تُجمَّل', async () => {
  const harness = await buildLiveHarness({ apply0014: false });
  try {
    const summary = await harness.run({ writeDecision: 'state-changing' });
    assert.equal(summary.ok, false, 'without 0014 a live session is refused — the check must notice');
    const failing = summary.checks.find(c => c.status === 'fail');
    assert.equal(failing.id, 'A5-L8', ids(summary));
    assert.match(failing.evidence, /decision-not-recorded:403:session_not_live/, failing.evidence);
  } finally { await harness.started.close(); }
});

test('LIVE-3 وضع القراءة فقط لا يترك أثرًا في دفتر المراجعة، ويميّز البنية التي لا تعرف A5', async () => {
  const harness = await buildLiveHarness();
  try {
    const summary = await harness.run({});
    assert.equal(summary.ok, true, `read-only mode must still pass: ${JSON.stringify(summary.checks.filter(c => c.status === 'fail'))}`);
    assert.ok(summary.notes.some(n => n.startsWith('review-write=not-attempted')), JSON.stringify(summary));
    assert.equal(harness.sqlite.prepare('SELECT COUNT(*) AS c FROM crm_drive_file_review_decision').get().c, 0,
      'the default mode must not append anything to the review ledger');
  } finally { await harness.started.close(); }

  // بنية قديمة لا تعرف A5: تشغّل خادمًا يردّ 404 على مسارات A5 وحدها.
  const stale = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise(resolve => stale.listen(0, '127.0.0.1', resolve));
  try {
    const summary = await runA5LiveChecks(createTransport({ baseUrl: `http://127.0.0.1:${stale.address().port}`, origin: TEST_ORIGIN }),
      { accessCode: 'unused-because-build-check-fails-first' });
    assert.equal(summary.ok, false);
    assert.equal(summary.build, 'a5-not-in-deployed-build');
    assert.equal(summary.checks.length, 1, 'the run must stop at the build check, not report ten failures');
  } finally { await new Promise(resolve => stale.close(resolve)); }
});

test('LIVE-4 وضع سطر الأوامر يُخرِج JSONآلًا قابلًا للقراءة ويخرج 0 عند النجاح', async () => {
  const harness = await buildLiveHarness();
  try {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, CRM_TEST_BASE_URL: harness.started.baseUrl, CRM_A5_ORIGIN: TEST_ORIGIN,
        CRM_A5_ACCESS_CODE: harness.accessCode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    const parsed = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(code, 0, `cli exit ${code}: ${stdout}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.counts.fail, 0);
    assert.ok(parsed.counts.pass >= 8, `expected at least 8 passing checks, got ${parsed.counts.pass}`);
    assert.ok(Array.isArray(parsed.created.interaction_ids) && parsed.created.interaction_ids.length >= 1,
      'the summary must name what it created so cleanup can find it');
  } finally { await harness.started.close(); }
});

// ما تستخدمه الـ workflow فعلًا: تذكرة CI لمرة واحدة بدل رمز الوصول (قد يبقى الرمز في لوحة Cloudflare
// وحده بلا نسخة في GitHub). الفحص يقود نفس العميل، فيثبّت أن مسار التذكرة يعطي جلسة وCSRF صالحين
// لـ A5 كلها — وأن ملف حالة الجلسة (0600) يُكتب كما يتوقعه منشّر الإنهاء في CI.
test('LIVE-5 دخول تذكرة CI يمرّر كل فحوص A5 ويكتب ملف الحالة بصلاحية 0600', async () => {
  const harness = await buildLiveHarness();
  const stateFile = path.join(os.tmpdir(), `a5-live5-${crypto.randomBytes(4).toString('hex')}.token`);
  try {
    const nonce = crypto.randomBytes(36).toString('base64url');
    const key = `ci-e2e-ticket:${crypto.createHash('sha256').update(nonce).digest('hex')}`;
    harness.sqlite.prepare(`INSERT INTO crm_idempotency_receipts (submission_key, resource_type, resource_id, received_at)
      VALUES (?, 'contact', 'authorized_pending', ?)`)
      .run(key, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const summary = await harness.run({ accessTicket: nonce, accessCode: '', stateFile });
    assert.equal(summary.ok, true, JSON.stringify(summary.checks.filter(c => c.status === 'fail')));
    const evidence = Object.fromEntries(summary.checks.map(c => [c.id, c.evidence]));
    assert.match(evidence['A5-L2'], /mode=ci_ticket.*state=written/, evidence['A5-L2']);
    assert.equal(harness.sqlite.prepare('SELECT resource_id AS r FROM crm_idempotency_receipts WHERE submission_key = ?')
      .get(key).r, 'consumed', 'a CI ticket must be single-use');
    const token = readFileSync(stateFile, 'utf8').trim();
    assert.ok(token.length >= 32, 'the session token must be written for the expiry hook');
    assert.equal(readFileSync(stateFile, 'utf8').includes('csrf'), false, 'only the token belongs in that file');
    assert.equal((statSync(stateFile).mode & 0o777).toString(8), '600');
    // الجلسة التي صُنعت بالتذكرة تعمل كأي جلسة رمز وصول: قراءة موثّقة ثم خروج ثم رفض
    assert.match(evidence['A5-L9'], /live=ok/, evidence['A5-L9']);
  } finally {
    await harness.started.close();
    try { unlinkSync(stateFile); } catch { /* لا شيء */ }
  }
});
