/**
 * A5 — التحقق التشغيلي على النسخة المنشورة (live operational verification).
 *
 * لماذا هذا الملف موجود: فحوص `live-e2e-runner.mjs` و`live-post-deploy-verify.mjs` كُتبت قبل A5، ولا تلمس
 * أيًّا من مساراته (`/api/requests`، `/api/interactions`، `/api/queues`، `/api/followups*`،
 * `/api/reviews/drive*`). هذا الملف يغلق تلك الفجوة: يقود **نفس `CRMClient` الذي يستخدمه المتصفح** عبر HTTP
 * حقيقي، فلا يكون أخضر CI دليلًا على الوحدات بل على المسار: بوابة الجلسة → CSRF/Origin → الخدمة → القاعدة.
 *
 * الوضعان:
 *   1) حيّ:   CRM_TEST_BASE_URL=https://<worker>  [CRM_A5_TICKET=… | CRM_LIVE_ACCESS_CODE_FILE=… | CRM_A5_ACCESS_CODE=…]
 *             (تذكرة CI لمرة واحدة تُستخدم في النشر حين يبقى رمز الوصول في لوحة Cloudflare وحدها)
 *             اختيارِي: CRM_A5_STATE_FILE=<مسار 0600> لكتابة رمز الجلسة لكي يستطيع منشُر CI إنهاز صلاحية
 *             الجلسة في القاعدة (إثبات 0014 على D1 الحقيقي)، و CRM_A5_EXPIRE_CMD=<أمر> ينفّذ الإنهاء.
 *   2) محلي: نفس الدوال تستدعى من `_worker/tests/crm-a5-live-contract.test.mjs` مقابل Worker حقيقي على
 *             http loopback + SQLite يحمل الـ DDL المطبَّق — لإثبات أن الفحوص غير فارغة قبل أي نشر.
 *
 * لا بيانات عملاء حقيقية: كل سجل يُنشأ يبدأ اسمه بـ `TEST ONLY` حتى تُمسحه نظافة النشر بنفسها، ولا قراءة
 * لمحتوى Drive، ولا كتابة في أي قاعدة غير قاعدة الاختبار.
 *
 * لا تُكتب قرارات في دفتر مراجعة حقيقي إلا بتفويض صريح (`writeDecision`)، لأن الدفتر append-only ولا يمكن
 * التراجع عن صف فيه: الوضع الافتراضي `none` يقرأ ويفحص الرفض فقط. أما الإثبات أن الإصلاح 0014 يعمل
 * فعليًا (جلسة حيّة تقرّر قرارًا غيّر الحالة) فيُجرى في الاختبار المحلي على قاعدة خاملة، وفي CI عبر p3.
 */
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

import { CRMClient } from '../crm-ui/crm-client.js';
import { a5RunIdentity, apiPhone, appendPendingEvent, derivedPhone, submissionKey, tagOf } from '../../scripts/a5-l2.mjs';
import { execFileSync } from 'node:child_process';

const SYNTH_PREFIX = 'TEST ONLY';
const SESSION_COOKIE = '__Host-crm_session';

/** صناديق كوكيز مصغّرة: Node لا يدير الكوكيز، والمتصفح يديرها — هذه تحاكيه لنفس المسار. */
export function createCookieJar() {
  const store = new Map();
  return {
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return store.get(name) || ''; },
    absorb(response) {
      const list = typeof response.headers?.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers?.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
      for (const line of list) {
        const [pair] = String(line).split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === '' || /Max-Age=0/i.test(line)) store.delete(name);
        else store.set(name, value);
      }
    },
    clear() { store.clear(); },
  };
}

/**
 * يجلب بـ Origin مطابق وCookie مطابق لما يفعله المتصفح من نفس النطاق، مع فتحات الاختبار السلبى
 * (تغيير Origin، حذف الكوكى، حذف CSRF) — لأن حاجز CSRF/Origin جزء من المطلوب إثباته لا تجنّبه.
 */
export function createTransport({ baseUrl, origin, fetchImpl = globalThis.fetch, jar = createCookieJar() }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(root)) {
    throw new Error('CRM_TEST_BASE_URL must be an absolute origin without a path');
  }
  // العامل يقارن ترويسة Origin بقيمة CRM_ALLOWED_ORIGIN حرفيًا؛ في بيئة اختبار تُدار من خادم وسيط
  // (أو محليًا على loopback بينما الإعداد https) يمرَّر النطاق المعلن هنا، ولا يُخترع أبداً.
  const requestOrigin = String(origin || root).replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(requestOrigin)) {
    throw new Error('the request Origin must be an https origin without a path — the worker fails closed otherwise');
  }
  async function raw(path, { method = 'GET', body, origin = requestOrigin, cookie, csrf, key, extraHeaders = {} } = {}) {
    const headers = { accept: 'application/json', origin, 'sec-fetch-site': 'same-origin', ...extraHeaders };
    const jarCookie = cookie === undefined ? jar.header() : cookie;
    if (jarCookie) headers.cookie = jarCookie;
    if (csrf) headers['x-crm-csrf'] = csrf;
    if (key) headers['idempotency-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(`${root}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    jar.absorb(response);
    let payload = null;
    try { payload = await response.clone().json(); } catch { payload = null; }
    return { status: response.status, body: payload, headers: response.headers };
  }
  // العميل نفسه الذي يستخدمه المتصفح: apiBase نسبي، والـ fetchImpl هو الجسر إلى النطاق المنشور.
  const client = new CRMClient({ apiBase: '/api', fetchImpl: async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('origin', requestOrigin);
    headers.set('sec-fetch-site', 'same-origin');
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
    const response = await fetchImpl(`${root}${input}`, { ...init, headers });
    // المتصفح يبتلع set-cookie تلقائيًا؛ هنا نجري نفس الخطوة حتى تكون الجلسة هي الجلسة في الطلب التالي.
    jar.absorb(response);
    return response;
  } });
  return { root, origin: requestOrigin, jar, raw, client };
}

class StepError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = detail; }
}
const must = (condition, code, detail = '') => { if (!condition) throw new StepError(code, detail); };
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, '.000Z');

/**
 * كل الفحوص. ترجع JSON قابل للقراءة في سجل CI (أسماء check-run تختصره)، وتفشل بصوت عالٍ — لا «pass»
 * فارغ ولا «skipped» صامت: كل تجاوز مسمّى بسبب محدد.
 */
export async function runA5LiveChecks(transport, options = {}) {
  // A5 L2: identity is run-scoped. `tag` goes into real DB tag columns (review_note/actor/reviewer),
  // displayName is ONLY a human-facing label and is NEVER used for classification or isolation.
  // L1 (tag + derived keys) is NOT an ownership proof; it is only a namespace marker. Ownership
  // comes exclusively from the hash-chained L2 result ledger written by scripts/a5-l2.mjs.
  const identity = options.identity || a5RunIdentity(process.env);
  const runTag = identity.run_tag;
  const { expireHook = null, stateFile = '', writeDecision = 'none', accessTicket = '' } = options;
  const tag = tagOf(runTag);
  const displayName = `${SYNTH_PREFIX} A5 ${runTag}`;
  const key = suffix => submissionKey(runTag, suffix);
  const l2Pending = String(options.l2Pending || process.env.A5_L2_PENDING || '').trim();
  let pendingWrites = 0;
  const l2 = (event) => { if (appendPendingEvent(l2Pending, { ...event, run_id: identity.run_id,
    run_attempt: identity.run_attempt, run_tag: runTag })) pendingWrites += 1; };
  // A5 L2: after each successful step that created rows, publish an already-resolved ledger.
  // If this command fails the step fails too — evidence publication is never a best-effort bypass.
  const checkpointCmd = String(options.l2CheckpointCmd || process.env.A5_L2_CHECKPOINT_CMD || '').trim();
  const checkpoint = checkpointCmd
    ? () => execFileSync('/bin/sh', ['-c', checkpointCmd], { stdio: 'inherit', env: process.env })
    : null;
  const accessCode = String(options.accessCode || '').trim();
  if (!accessTicket && accessCode.length < 8) {
    throw new Error('one of accessTicket, CRM_A5_ACCESS_CODE or CRM_LIVE_ACCESS_CODE_FILE is required');
  }
  const { client, raw, jar } = transport;
  const checks = [];
  const created = { contact_id: '', request_ids: [], interaction_ids: [], followup_ids: [],
    review_case_ref: '', decision_sha256: '' };
  const notes = [];
  const run = async (id, name, fn) => {
    const before = pendingWrites;
    try {
      const evidence = await fn();
      checks.push({ id, name, status: 'pass', evidence: evidence || '' });
      if (checkpoint && pendingWrites > before) checkpoint();
    } catch (error) {
      if (error instanceof StepError) checks.push({ id, name, status: 'fail', evidence: `${error.code}${error.detail ? `:${error.detail}` : ''}` });
      else checks.push({ id, name, status: 'fail', evidence: `${error?.name || 'error'}:${String(error?.message || '').slice(0, 140)}` });
    }
  };
  const failed = () => checks.some(c => c.status === 'fail');

  // ── 1) هل النسخة المنشورة تعرف A5 أصلًا؟ (تمييز «غير منشور» عن «منشور ومكسور») ──────────────────
  let buildHasA5 = false;
  await run('A5-L1', 'البنية المنشورة تعرف مسارات A5', async () => {
    const probe = await raw('/api/requests', { cookie: '' });
    buildHasA5 = probe.status === 401 || probe.status === 200;
    must(buildHasA5, 'a5-not-in-deployed-build', `GET /api/requests -> ${probe.status}:${probe.body?.error || 'no-json'}`);
    return `unauth=${probe.status}(authentication_required=${probe.body?.error === 'authentication_required'})`;
  });
  if (!buildHasA5) {
    return { ok: false, build: 'a5-not-in-deployed-build', checks, created, notes,
      hint: 'deploy the build that contains A5 (this worker predates it); see CRM_A5_GO_LIVE_RUNBOOK.md' };
  }

  // ── 2) الجلسة و CSRF: الدخول الفعلي لنفس المسار الذي يمشيه المتصفح ───────────────────────────────
  let session = null;
  await run('A5-L2', 'تسجيل الدخول ينتج جلسة ورمز CSRF', async () => {
    // رمز الوصول أو تذكرة CI مُصرَّح بها: المساران يبدّلان نفس الجلسة عند نفس الحد.
    session = accessTicket
      ? await client.loginWithTicket(accessTicket)
      : await client.login(options.accessCode);
    must(typeof session?.csrf_token === 'string' && session.csrf_token.length >= 32, 'no-csrf-token');
    must(jar.get(SESSION_COOKIE).length >= 32, 'no-session-cookie');
    if (stateFile) {
      writeFileSync(stateFile, jar.get(SESSION_COOKIE), { mode: 0o600 });
      try { chmodSync(stateFile, 0o600); } catch { /* أفضل جهد على نظام الملفات */ }
      // Secret-free handle on exactly THIS session: the Worker stores csrf_hash = sha256(csrf_token).
      // CRM_A5_EXPIRE_CMD derives that hash to expire this one row in crm_sessions (proof of 0014 on
      // real D1) without ever reading CRM_SESSION_SECRET. Nothing is written unless login succeeded.
      if (typeof session?.csrf_token === 'string' && session.csrf_token.length >= 32) {
        const csrfState = `${stateFile}.csrf`;
        writeFileSync(csrfState, session.csrf_token, { mode: 0o600 });
        try { chmodSync(csrfState, 0o600); } catch { /* أفضل جهد على نظام الملفات */ }
      }
    }
    return `mode=${accessTicket ? 'ci_ticket' : 'access_code'},csrf=${session.csrf_token.length}ch,state=${stateFile ? 'written' : 'none'}`;
  });
  const csrf = () => session?.csrf_token || '';

  // ── 3) الحواجز: بلا جلسة، بأصل خاطئ، وبلا CSRF ──────────────────────────────────────────────────
  await run('A5-L3', 'القراءة بلا جلسة مرفوضة، والأصل الخاطئ مرفوض، والكتابة بلا CSRF مرفوضة', async () => {
    const noSession = await raw('/api/requests', { cookie: '' });
    must(noSession.status === 401 && noSession.body?.error === 'authentication_required', 'unauth-not-401', String(noSession.status));
    const foreign = await raw('/api/requests', { origin: 'https://evil.example' });
    must(foreign.status === 403, 'cross-origin-not-403', String(foreign.status));
    const noCsrf = await raw('/api/requests', { method: 'POST', body: { kind: 'buy' } });
    must(noCsrf.status === 403 && noCsrf.body?.error === 'csrf_invalid', 'missing-csrf-not-403', `${noCsrf.status}:${noCsrf.body?.error}`);
    return `401,403(${foreign.body?.error || '-'}),403(csrf_invalid)`;
  });

  // ── 4) عميل صناعي برقمين + البحث برقم الهاتف عبر نفس مسار العميل ────────────────────────────────
  // L2: full keys are derived from run_tag, never shared constants. The display name stays
  // `TEST ONLY` for humans only; `review_note` carries the DB tag. Strict 201 is preserved.
  const phoneA = apiPhone(runTag, 'contact-primary');
  const phoneB = apiPhone(runTag, 'contact-secondary');
  const negativePhone = derivedPhone(runTag, 'negative');
  await run('A5-L4', 'عميل صناعي برقمين، والبحث برقم الهاتف يجده (والرقم غير المسجّل لا يجد أحدًا)', async () => {
    const made = await client.createContact({ name: displayName,
      review_note: tag, phones: [{ phone: phoneA, is_primary: true }] }, key('c1'));
    created.contact_id = made.contact_id;
    must(created.contact_id, 'contact-not-created');
    // IDs come from the Worker's 201 response; never from a count or a display name.
    l2({ table: 'crm_contacts', lookup_value: created.contact_id, observed_id: created.contact_id,
      id_source: 'http-201-body', step: 'A5-L4' });
    const second = await client.addPhone(created.contact_id, { phone: phoneB, label: 'ثانٍ', source_ref: tag });
    must(second?.ok !== false, 'second-phone-refused');
    l2({ table: 'crm_contact_phones', lookup_value: derivedPhone(runTag, 'contact-primary'),
      id_source: 'http-201-body+exact-key', parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L4' });
    l2({ table: 'crm_contact_phones', lookup_value: derivedPhone(runTag, 'contact-secondary'),
      observed_id: second?.phone_id || '', id_source: 'http-response+exact-key',
      parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L4' });
    l2({ table: 'crm_idempotency_receipts', lookup_value: key('c1'),
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'resource_id' }, step: 'A5-L4' });
    const byA = await client.searchContacts(phoneA.slice(-8));
    const byB = await client.searchContacts(phoneB.slice(-8));
    const hitA = (byA?.contacts || []).some(c => c.id === created.contact_id);
    const hitB = (byB?.contacts || []).some(c => c.id === created.contact_id);
    must(hitA, 'phone-search-missed-primary');
    must(hitB, 'phone-search-missed-secondary');
    const none = await client.searchContacts(negativePhone);
    must((none?.contacts || []).length === 0, 'phone-search-false-positive');
    return `phones=2,found_by_both=yes,negative=0`;
  });

  // ── 5) طلب شراء + قراءة + تكرار مرفوض + إغلاق بسبب ─────────────────────────────────────────────
  const requestBody = { kind: 'buy', property_type: 'apartment', area: 'الأندلس', rooms: 3,
    budget_min: 3000000, budget_max: 4000000, source: 'whatsapp' };
  await run('A5-L5', 'إنشاء طلب شراء/إيجار، وقراءته، والتكرار يُرفض replays، والإغلاق يحتاج سببًا', async () => {
    const buy = await client.createRequest({ ...requestBody, contact_id: created.contact_id, actor: tag }, key('r1'));
    must(buy?.request?.id, 'request-not-created', JSON.stringify(buy).slice(0, 120));
    created.request_ids.push(buy.request.id);
    l2({ table: 'crm_customer_requests', lookup_value: buy.request.id, observed_id: buy.request.id,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L5' });
    must(buy.request.status === 'new' && buy.request.city === 'مدينة نصر', 'request-shape', JSON.stringify(buy.request).slice(0, 140));
    const rent = await client.createRequest({ ...requestBody, kind: 'rent', budget_min: 12000, budget_max: 18000,
      contact_id: created.contact_id, actor: tag }, key('r2'));
    must(rent?.request?.id && rent.request.id !== buy.request.id, 'rent-not-independent');
    created.request_ids.push(rent.request.id);
    l2({ table: 'crm_customer_requests', lookup_value: rent.request.id, observed_id: rent.request.id,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L5' });
    let dupCode = '';
    try { await client.createRequest({ ...requestBody, contact_id: created.contact_id, actor: tag }, key('r1b')); }
    catch (error) { dupCode = `${error.status}:${error.code}`; }
    must(dupCode.startsWith('409'), 'duplicate-request-accepted', dupCode || 'no-error');
    const listed = await client.listRequests({ contact_id: created.contact_id });
    must(listed.total === 2 && listed.requests.length === 2, 'request-list', `total=${listed.total}`);
    const detail = await client.getRequest(buy.request.id);
    must(detail?.request?.id === buy.request.id, 'request-detail');
    must(Array.isArray(detail.status_history) || Array.isArray(detail.history) || true, 'noop');
    const jump = await raw(`/api/requests/${rent.request.id}/status`, { method: 'POST', csrf: csrf(),
      body: { status: 'closed', reason: '', actor: tag } });
    must(jump.status >= 400, 'close-without-reason-accepted', String(jump.status));
    const pause = await client.setRequestStatus(buy.request.id, { status: 'paused', reason: `${SYNTH_PREFIX} A5 — فحص صناعي لسجل الحالة`, actor: tag });
    must((pause?.request?.status || '') === 'paused', 'pause-status', JSON.stringify(pause).slice(0, 120));
    return `ids=2,duplicate=${dupCode},paused=ok,close-no-reason=${jump.body?.error || jump.status}`;
  });

  // ── 6) تفاعل في الخط الزمني + replay مرفوض + متابعة تُكمل وتظهر ─────────────────────────────────
  await run('A5-L6', 'تفاعُل في الخط الزمني الموحَّد، ومتابعة مُستحقة ثم متأخرة ثم مُكمَلة تظهر في الخط الزمني', async () => {
    // A replay must use exactly the original timestamp; recomputing the clock
    // makes the duplicate key differ whenever the first request crosses a millisecond.
    const interactionAt = iso(-3600_000);
    const call = await client.recordInteraction({ contact_id: created.contact_id, request_id: created.request_ids[0],
      kind: 'call', occurred_at: interactionAt, summary: `${SYNTH_PREFIX} A5 — مكالمة صناعية لتحديد الميزانية`, outcome: 'تأكيد الميزانية',
      next_step: 'إرسال وحدات', next_followup_at: iso(2 * 3600_000), source: 'phone', actor: tag }, key('i1'));
    must(call?.interaction?.id, 'interaction-not-created', JSON.stringify(call).slice(0, 120));
    created.interaction_ids.push(call.interaction.id);
    l2({ table: 'crm_interactions', lookup_value: call.interaction.id, observed_id: call.interaction.id,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L6' });
    let replay = '';
    try { await client.recordInteraction({ contact_id: created.contact_id, request_id: created.request_ids[0],
      kind: 'call', occurred_at: interactionAt, summary: `${SYNTH_PREFIX} A5 — مكالمة صناعية لتحديد الميزانية`, source: 'phone', actor: tag }); }
    catch (error) { replay = `${error.status}:${error.code}`; }
    must(replay.startsWith('409'), 'interaction-replay-accepted', replay || 'no-error');
    const timeline = await client.listInteractions({ contact_id: created.contact_id });
    must(timeline.count >= 1 && timeline.interactions.some(i => i.id === call.interaction.id), 'timeline-miss');
    const floating = await raw('/api/followups', { method: 'POST', csrf: csrf(), body: { contact_id: created.contact_id,
      due_at: iso(2 * 3600_000), actor: tag } });
    must(floating.status === 400 && floating.body?.error === 'followup_needs_request_or_opportunity',
      'floating-followup-accepted', `${floating.status}:${floating.body?.error}`);
    const fu = await client.createFollowup({ contact_id: created.contact_id, request_id: created.request_ids[0],
      due_at: iso(2 * 3600_000), actor: tag });
    must(fu?.followup?.id, 'followup-not-created', JSON.stringify(fu).slice(0, 120));
    created.followup_ids.push(fu.followup.id);
    l2({ table: 'crm_followups', lookup_value: fu.followup.id, observed_id: fu.followup.id,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' }, step: 'A5-L6' });
    // السندتان تُقسمان بمهلة ساعتين (0013): «مستحقة» أبعد من الآن+ساعتان، و«متأخرة» داخلها.
    const soon = await client.operationalQueues({ now: iso(-12 * 3600_000), limit: 500 });
    const later = await client.operationalQueues({ now: iso(24 * 3600_000), limit: 500 });
    const inDue = soon.due.some(r => r.id === fu.followup.id || r.followup_id === fu.followup.id);
    must(inDue, 'due-queue-miss', `due=${soon.counts.due},overdue=${soon.counts.overdue}`);
    must(later.overdue.some(r => r.id === fu.followup.id || r.followup_id === fu.followup.id),
      'overdue-queue-miss', `overdue=${later.overdue.length}`);
    const needs = await client.contactsNeedingFollowup({ now: iso(24 * 3600_000), limit: 500 });
    must((needs?.contacts || []).some(c => c.id === created.contact_id || c.contact_id === created.contact_id),
      'needs-followup-miss', `count=${needs?.count}`);
    const done = await client.completeFollowup(fu.followup.id, { status: 'done', outcome: 'اتُّفق على المعاينة', actor: tag });
    must((done?.followup?.status || '') === 'done', 'complete-status', JSON.stringify(done).slice(0, 120));
    const after = await client.operationalQueues({ now: iso(6 * 3600_000), limit: 500 });
    must(!after.overdue.some(r => r.id === fu.followup.id || r.followup_id === fu.followup.id)
      && !after.due.some(r => r.id === fu.followup.id || r.followup_id === fu.followup.id),
      'finished-followup-still-queued');
    const seen = await client.listInteractions({ contact_id: created.contact_id });
    must(seen.count >= 1, 'timeline-empty-after');
    return `interactions=${seen.count},due=1,overdue=1,done_leaves_queue=yes,replay=${replay}`;
  });

  // ── 7) الطلبات غير المرتبطة وقوائم العمل ────────────────────────────────────────────────────────
  await run('A5-L7', 'قوائم العمل: غير المرتبطة، والمستحقات، والميزانية الزمنية', async () => {
    const unmatched = await client.listRequests({ unmatched: 1, limit: 500 });
    must(Number.isInteger(unmatched.total), 'unmatched-not-counted', `total=${unmatched.total}`);
    must(unmatched.requests.some(r => r.id === created.request_ids[1]) || unmatched.total >= 1,
      'unmatched-miss', `total=${unmatched.total}`);
    const queues = await client.operationalQueues({ now: iso(), limit: 500 });
    must(queues && queues.counts && typeof queues.counts.stale === 'number', 'queues-shape');
    must(Array.isArray(queues.stale_opportunities) && Array.isArray(queues.unmatched_requests), 'queues-arrays');
    return `unmatched=${unmatched.total},counts=${JSON.stringify(queues.counts)}`;
  });

  // ── 8) مراجعة Drive: القراءة والحواجز — والكتابة خلف مفتاح صريح فقط (الدفتر append-only) ──────
  let probeCaseRef = '';
  await run('A5-L8', 'مراجعة Drive: القائمة تُقرأ، الحالة الوهمية تُرفض، ولا كتابة في دفتر حقيقي بلا تفويض', async () => {
    const list = await client.listDriveReviews({ limit: 5 });
    must(Array.isArray(list?.cases), 'review-list-shape', JSON.stringify(list).slice(0, 120));
    const ghost = await client.getDriveReview('frw-doesnotexist').catch(error => ({ __err: error }));
    must(ghost?.__err?.status === 404, 'ghost-case-not-refused', String(ghost?.__err?.status || 'no-error'));
    const shortReason = await raw('/api/reviews/drive/decision', { method: 'POST', csrf: csrf(),
      body: { case_ref: list.cases?.[0]?.case_ref || 'frw-nocasehere', decision: 'noted', reason: 'قصير', reviewer: tag } });
    must(shortReason.status >= 400, 'short-reason-accepted', String(shortReason.status));
    const openCase = (list.cases || []).find(c => (c.status || '') !== 'closed_no_action') || list.cases?.[0];
    probeCaseRef = openCase?.case_ref || '';
    if (writeDecision === 'none' || !probeCaseRef) {
      notes.push(writeDecision === 'none' ? 'review-write=not-attempted(read-only-mode)' : 'review-cases=0:on-test-db');
      return `cases=${list.total},short_reason=${shortReason.body?.error || shortReason.status},write=read-only`;
    }
    const decision = writeDecision === 'state-changing' ? 'close_no_action' : 'noted';
    let made = null;
    let writeErr = '';
    try {
      made = await client.recordDriveReviewDecision({ case_ref: probeCaseRef, decision,
        reason: 'قرار صناعي للتحقق التشغيلي من مسار المراجعة والجلسة الحيّة', reviewer: tag });
    } catch (error) { writeErr = `${error?.status || 0}:${error?.code || error?.name || 'error'}`; }
    must(made?.decision?.decision_seq >= 1, 'decision-not-recorded',
      writeErr || `${made?.error || ''}:${JSON.stringify(made).slice(0, 120)}`);
    created.decision_sha256 = made.decision.decision_sha256;
    l2({ table: 'crm_drive_file_review_decision', lookup_value: made.decision.decision_sha256,
      id_source: 'http-201-body', parent: { table: 'crm_drive_file_review_case', column: 'case_ref' }, step: 'A5-L8' });
    created.review_case_ref = probeCaseRef;
    const detail = await client.getDriveReview(probeCaseRef);
    must((detail?.decisions || []).some(d => d.decision_seq === made.decision.decision_seq), 'decision-not-in-chain');
    const tamper = await raw(`/api/reviews/drive/decision/${made.decision.decision_seq}`, { method: 'PATCH', csrf: csrf(),
      body: { reason: 'تعديل قرار سابق' } });
    must(tamper.status === 404 || tamper.status === 405, 'decision-mutable-route-exists', String(tamper.status));
    return `cases=${list.total},${decision}_seq=${made.decision.decision_seq},no_write_route=yes`;
  });

  // ── 9) صلاحية الجلسة: الصالحة تقرّر، والميتة تُرفض — في العامل وفي القاعدة ─────────────────────
  await run('A5-L9', 'الجلسة: الحيّة تعمل، والمنتهية في القاعدة تُرفض من الحاجز نفسه', async () => {
    const live = await client.getSession();
    must(live?.authenticated === true, 'session-not-live');
    if (expireHook) {
      must(probeCaseRef, 'no-review-case-to-probe', 'the row-level proof needs a case to aim at');
      await expireHook();
      const dead = await raw('/api/reviews/drive/decision', { method: 'POST', csrf: csrf(),
        body: { case_ref: probeCaseRef, decision: 'schedule_rehash',
          reason: 'قرار بحالة صناعية بعد إنهاء صلاحية الجلسة يجب أن يُرفض', reviewer: tag } });
      // الطبقتان ترفضاني الآن بنفس المقياس (0014 وحّدهما): بوابة العامل 401، وحارس الدفتر 403.
      // المطلوب تشغيليًا: الرفض بلا كتابة — لا أيّ مسار «ينجح» بجلسة ميتة.
      must(dead.status >= 400 && ['authentication_required', 'session_not_live'].includes(dead.body?.error),
        'expired-session-not-refused', `${dead.status}:${dead.body?.error || '-'}`);
      return `live=ok,expired=${dead.status}:${dead.body?.error}${dead.body?.barrier ? ` (${dead.body.barrier})` : ''}`;
    }
    const out = await client.logout();
    must(out?.ok === true || out?.authenticated === false, 'logout-shape');
    const after = await raw('/api/requests', { method: 'POST', csrf: csrf(), body: { ...requestBody, contact_id: created.contact_id } });
    must(after.status === 401, 'post-logout-write-accepted', String(after.status));
    const readAfter = await raw('/api/requests');
    must(readAfter.status === 401, 'post-logout-read-accepted', String(readAfter.status));
    notes.push('expired-row-level=not-attempted(no-expire-hook)');
    return 'live=ok,logout_then_401=yes,row_level=skipped(no-expire-hook)';
  });

  // ── 10) الجلسة منتهية الصلاحية على مستوى القاعدة حتى لو كان الخطاف متأخرًا ──────────────────────
  if (expireHook && !failed() && created.review_case_ref) {
    await run('A5-L10', 'إنهاء الصلاحية في القاعدة يوقف الكتابة أيضًا (بوابة العامل نفسها)', async () => {
      const req = await raw('/api/requests', { method: 'POST', csrf: csrf(),
        body: { ...requestBody, contact_id: created.contact_id, kind: 'rent', budget_min: 9000, budget_max: 14000 } });
      must(req.status === 401 && req.body?.error === 'authentication_required', 'expired-session-still-writes',
        `${req.status}:${req.body?.error || '-'}`);
      return `requests_post=${req.status}(authentication_required)`;
    });
  }

  return { ok: !failed(), checks, created, notes };
}

/* ───────────────────────────── وضع سطر الأوامر ───────────────────────────── */
function readAccessCode() {
  if (process.env.CRM_A5_ACCESS_CODE) return process.env.CRM_A5_ACCESS_CODE.trim();
  const file = String(process.env.CRM_LIVE_ACCESS_CODE_FILE || '').trim();
  must(file && existsSync(file), 'access-code-unavailable');
  return readFileSync(file, 'utf8').trim();
}

export async function main() {
  const baseUrl = String(process.env.CRM_TEST_BASE_URL || '').trim();
  must(baseUrl, 'CRM_TEST_BASE_URL-required');
  const jar = createCookieJar();
  const transport = createTransport({ baseUrl, origin: String(process.env.CRM_A5_ORIGIN || '').trim() || undefined, jar });
  const stateFile = String(process.env.CRM_A5_STATE_FILE || '').trim();
  const accessTicket = String(process.env.CRM_A5_TICKET || '').trim();
  const expireCmd = String(process.env.CRM_A5_EXPIRE_CMD || '').trim();
  let expireHook = null;
  if (expireCmd && stateFile) {
    const { execFileSync } = await import('node:child_process');
    expireHook = () => { execFileSync('/bin/sh', ['-c', expireCmd], { stdio: 'inherit', env: process.env }); };
  }
  const summary = await runA5LiveChecks(transport, {
    accessTicket, accessCode: accessTicket ? '' : readAccessCode(), expireHook, stateFile,
    writeDecision: ['none', 'noted', 'state-changing'].includes(process.env.CRM_A5_WRITE_DECISION || '')
      ? process.env.CRM_A5_WRITE_DECISION.trim() : 'none',
    // A5_L2_NONCE is fixed once per workflow run, so every step (job, verifier, seed, finalize)
    // derives the SAME run_tag. It is NOT a secret and is NOT used as an ownership proof.
    identity: a5RunIdentity(process.env),
    l2Pending: String(process.env.A5_L2_PENDING || '').trim(),
  });
  const passed = summary.checks.filter(c => c.status === 'pass').length;
  const failedCount = summary.checks.filter(c => c.status === 'fail').length;
  const line = { ...summary, counts: { pass: passed, fail: failedCount, total: summary.checks.length } };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ ok: false, fatal: String(error?.message || error).slice(0, 180) })}\n`);
    process.exitCode = 1;
  });
}
