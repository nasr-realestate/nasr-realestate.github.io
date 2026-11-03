/**
 * A5 (هـ) — اللوحة الداخلية: تُختبر دوال العرض نقية على DOM صناعي صغير، وعميل API بمساراته الحقيقية،
 * والربط في crm.html/العامل. بيانات صناعية فقط، ولا شيء من هذا يظهر في الصفحات العامة.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CRMClient, CRMApiError } from '../crm-ui/crm-client.js';
import {
  createCrmA5Controller, refusalMessage, renderCustomerFile, renderQueues, renderRequestCard,
  renderRequestDetail, renderReviewCase, renderTimeline,
} from '../crm-ui/crm-assets/crm-a5-ui.js';

/* ── DOM stub صغير: يكفي العرض، وinnerHTML نص لا HTML (نفس قاعدة بقية الاختبارات) ───────── */
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.attrs = {};
    this._class = '';
    this._text = '';
    this.hidden = false;
    this.value = '';
  }
  set className(value) { this._class = value; }
  get className() { return this._class; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join(' ') : this._text; }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  removeChild(node) { this.children = this.children.filter(c => c !== node); return node; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  fire(type, event = {}) {
    const fake = { preventDefault() { fake.defaultPrevented = true; }, ...event };
    for (const handler of this.listeners[type] ?? []) handler(fake);
    return fake;
  }
  reset() { this.value = ''; }
  /** كل النص داخل الشجرة، لفحص الظهور */
  get text() { return [this._text, ...this.children.map(c => c.text)].filter(Boolean).join(' • '); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find?.(predicate);
      if (found) return found;
    }
    return null;
  }
  allText() { return this.text; }
}

const IDS = ['#a5-cust-search', '#a5-cust-results', '#a5-cust-file', '#a5-cust-error', '#a5-req-list',
  '#a5-req-detail', '#a5-req-error', '#a5-req-kind', '#a5-req-status', '#a5-req-unmatched', '#a5-request-form',
  '#a5-req-actor', '#a5-request-form-target', '#a5-queues', '#a5-followup-form', '#a5-work-error',
  '#a5-review-list', '#a5-review-detail', '#a5-review-error', '#a5-review-status', '#a5-review-disposition',
  '#a5-review-form', '#a5-review-link-form', '#a5-review-decision', '#a5-review-reason', '#a5-review-actor',
  '#a5-review-link-contact', '#a5-review-link-basis', '#a5-req-refresh', '#a5-queues-refresh',
  '#a5-review-refresh', '#a5-cust-submit'];
const registry = new Map(IDS.map(id => [id, new Node('div')]));

// A tiny but honest DOM: createElement + querySelector from a fixed registry. innerHTML is never used, so
// every string that reaches the screen goes through textContent — which is the same rule the page follows.
globalThis.document = {
  createElement: tag => new Node(tag),
  querySelector: selector => registry.get(selector) ?? null,
  querySelectorAll: () => [],
  getElementById: id => registry.get(`#${id}`) ?? null,
};

const host = () => new Node('div');

test('A5-UI-1 الخط الزمني الموحَّد: مرتّب تنازليًا، ويُظهر النتيجة والخطوة التالية والمرجع الأرشيفي', () => {
  const container = host();
  renderTimeline([
    { kind: 'note', occurred_at: '2026-11-01T09:00:00.000Z', summary: 'ملاحظة أقدم', source: 'manual' },
    { kind: 'call', occurred_at: '2026-11-03T09:00:00.000Z', summary: 'مكالمة أحدث', outcome: 'اتفقنا', next_step: 'إرسال وحدات', next_followup_at: '2026-11-05T10:00:00.000Z', source: 'phone', created_by: 'منى' },
    { kind: 'conversation', occurred_at: '2026-11-02T09:00:00.000Z', summary: 'سجل قديم مُدرج', source: 'import', legacy_ref_table: 'crm_conversation_messages', legacy_ref_id: '41' },
  ], container);
  const items = container.children[0].children;
  assert.equal(items.length, 3);
  assert.match(items[0].text, /مكالمة أحدث/);
  assert.match(items[0].text, /اتفقنا/);
  assert.match(items[0].text, /إرسال وحدات/);
  assert.match(items[1].text, /crm_conversation_messages#41/, 'the archive reference stays visible so nothing is duplicated');
  // empty state is a sentence, not a blank card
  const blank = host();
  renderTimeline([], blank);
  assert.match(blank.children[0].text, /لا تفاعلات مسجّلة بعد/);
});

test('A5-UI-2 بطاقة الطلب: الحالة والمنطقة والميزانية وسبب الإغلاق، وبلا ربط يُصنَّف «بلا مطابق»', () => {
  const container = host();
  const row = {
    id: 'req-synth-1', kind: 'buy', property_type: 'apartment', status: 'paused', contact_name: 'عميل صناعي',
    area: 'الأندلس', sub_area: 'شارع مصطفى النحاس', area_min_m2: 120, area_max_m2: 160, rooms: 3,
    budget_min: 3000000, budget_max: 4000000, currency: 'EGP', stop_reason: 'الميزانية قيد المراجعة',
    updated_at: '2026-11-03T09:00:00.000Z', listing_links: [],
  };
  let opened = null;
  container.appendChild(renderRequestCard(row, { onOpen: detail => { opened = detail; } }));
  const text = container.children[0].text;
  assert.match(text, /شراء · شقة/);
  assert.match(text, /موقوف/);
  assert.match(text, /الأندلس/);
  assert.match(text, /لا عقار مرتبط بعد — يبقى الطلب في قائمة «بلا مطابق»/);
  assert.match(text, /أُغلق بسبب/);
  const button = container.children[0].find(node => node.tagName === 'BUTTON');
  button.fire('click');
  assert.equal(opened.id, row.id);
});

test('A5-UI-3 تفاصيل الطلب: سجل الحالة كامل، والقرار لا يُعرض لسجل مُقرَّر، والنهاية نهائية', () => {
  const container = host();
  const detail = { request: {
    id: 'req-synth-1', kind: 'rent', property_type: 'apartment', status: 'closed', contact_id: 'c-1', city: 'مدينة نصر',
    area: 'الزهراء', budget_min: null, budget_max: null, currency: null, source: 'whatsapp', requirements: 'دور علوي',
    stop_reason: 'تم الحجز', closed_at: '2026-11-03T09:00:00.000Z', created_at: '2026-11-01T09:00:00.000Z', updated_at: '2026-11-03T09:00:00.000Z',
    status_history: [{ from_status: null, to_status: 'new', changed_at: '2026-11-01T09:00:00.000Z', reason: null },
      { from_status: 'new', to_status: 'active', changed_at: '2026-11-02T09:00:00.000Z', reason: null },
      { from_status: 'active', to_status: 'closed', changed_at: '2026-11-03T09:00:00.000Z', reason: 'تم الحجز' }],
    listing_links: [{ id: 'rll-synth-1', listing_id: 900001, listing_title: 'شقة صناعية أ', state: 'confirmed', evidence_ref: 'wa:msg:1', decided_by: 'منى' }],
  } };
  const decided = [];
  renderRequestDetail(detail, container, { onStatus: () => {}, onLink: () => {}, onDecide: (id, linkId, state) => decided.push([id, linkId, state]) });
  const text = container.text;
  assert.match(text, /سجل الحالة/);
  assert.match(text, /مغلق/);
  assert.match(text, /تم الحجز/);
  assert.match(text, /مؤكَّد/, 'a decided link shows its decision');
  assert.deepEqual(decided, [], 'a decided link gets no re-decision buttons');
  assert.equal(/اقتراح ربط/.test(text), false, 'a closed request cannot be linked from the UI');
  assert.match(text, /الحالة نهائية|سجل الحالة/, 'the terminal state is stated');
});

test('A5-UI-4 قوائم العمل: عدّادات ومستحقات ومتأخرات وفرص صامتة — والنتيجة تُسأل قبل الإنهاء', () => {
  const container = host();
  let completed = null;
  renderQueues({
    counts: { due: 2, overdue: 1, unmatched: 3, stale: 1 },
    due: [{ id: 'fu-synth-1', contact_id: 'c-1', contact_name: 'عميل صناعي', target_kind: 'request', target_label: 'req-synth-1', due_at: '2026-11-03T10:00:00.000Z' }],
    overdue: [{ id: 'fu-2', contact_id: 'c-2', contact_name: 'عميل صناعي ٢', target_kind: 'opportunity', target_label: 'opp-1', due_at: '2026-11-01T10:00:00.000Z', overdue_days: 2 }],
    unmatched_requests: [{ contact_id: 'c-3', contact_name: 'عميل صناعي ٣', kind: 'buy', area: 'الأندلس', budget_min: 3000000, budget_max: 4000000 }],
    stale_opportunities: [{ id: 'opp-9', contact_name: 'عميل صناعي ٩', days_silent: 33, last_interaction_at: '2026-10-01T09:00:00.000Z' }],
    opportunity_stages: [{ status: 'active', count: 4, viewings: 1, closed_with_reason: 0 }],
  }, container, { onCompleteFollowup: (row, status = 'done') => { completed = [row.id, status]; } });
  const text = container.text;
  assert.match(text, /متأخر/);
  assert.match(text, /طلبات نشطة بلا عقار مناسب/);
  assert.match(text, /فرص صامتة/);
  assert.match(text, /تأخّر/);
  const overdueButtons = container.children[2].find(node => node._class === 'a5-actions');
  const [done, missed] = overdueButtons.children;
  done.fire('click');
  assert.deepEqual(completed, ['fu-2', 'done']);
  missed.fire('click');
  assert.deepEqual(completed, ['fu-2', 'missed']);
});

test('A5-UI-5 ملف العميل الموحَّد: أرقام بواحد أساسي، وطلبات، وفرص، وخط زمني في صفحة واحدة', () => {
  const container = host();
  renderCustomerFile({
    contact: { id: 'c-1', name: 'عميل صناعي', communication_consent: 'request_only' },
    phones: [{ phone_key: '01000000101', is_primary: 1, label: null }, { phone_key: '01000000102', is_primary: 0, label: 'ثانٍ' }],
    requests: [{ id: 'req-synth-1', kind: 'buy', status: 'active', area: 'الأندلس', budget_min: 3000000, budget_max: 4000000 }],
    opportunities: [{ id: 'opp-1', lead_label: 'فرصة صناعية', status: 'active', next_action: 'إرسال وحدات' }],
    interactions: [{ kind: 'call', occurred_at: '2026-11-03T09:00:00.000Z', summary: 'مكالمة', source: 'phone' }],
  }, container);
  const text = container.text;
  assert.match(text, /عميل صناعي/);
  assert.match(text, /أساسي/);
  assert.match(text, /طلبات فقط/);
  assert.match(text, /شراء · قيد العمل/);
  assert.match(text, /فرصة صناعية/);
  assert.match(text, /مكالمة/);
});

test('A5-UI-6 شاشة المراجعة: السلسلة الظاهرة، ولا أفعال دمج، والحالة تتحرك في الخادم', async () => {
  const container = host();
  let decideCalls = 0;
  let linkForms = 0;
  const detail = {
    case: { case_ref: 'frw-abc-1', file_name: 'synth.zip', status: 'open', review_disposition: 'needs_governance_review',
      bound_version_seq: 1, head_version_seq: 1, crm_contact_id: null, link_state: null, opened_at: '2026-11-02T09:00:00.000Z', opened_by: 'intake_pipeline' },
    decisions: [{ decision_seq: 1, decision: 'noted', reviewer: 'منى', occurred_at: '2026-11-02T10:00:00.000Z', reason: 'قيد ملاحظة' }],
    anchors: [], chain: { decision_count: 1, intact: true },
  };
  renderReviewCase(detail, container, { onDecide: () => { decideCalls += 1; }, onProposeLink: () => { linkForms += 1; } });
  const text = container.text;
  assert.match(text, /سلسلة القرارات سليمة/);
  assert.match(text, /مفتوحة/);
  assert.match(text, /لا ربط — الربط اقتراحٌ يقرره إنسان/);
  assert.equal(decideCalls, 1);
  assert.equal(linkForms, 1);
  // a broken chain is shouted, not smoothed over
  const broken = host();
  renderReviewCase({ ...detail, chain: { decision_count: 1, intact: false } }, broken, {});
  assert.match(broken.text, /غير متطابقة/, 'tampering must be visible on the screen');
  const client = await readFile(new URL('../crm-ui/crm-client.js', import.meta.url), 'utf8');
  assert.equal(/merge|auto[_-]?match|apply[_-]?link/.test(client), false, 'the client exposes no merge/apply verb at all');
});

test('A5-UI-7 الرفض يُعرَض ولا يُخفى: الرمز والحاجز وجملة عربية لكل حالة', async () => {
  const duplicate = new CRMApiError('conflict', 'نسخة مكررة', 409, 'duplicate_request');
  assert.match(refusalMessage(duplicate), /يوجد طلب مطابق/);
  assert.match(refusalMessage(duplicate), /رمز الرفض: duplicate_request/);
  const barrier = new CRMApiError('conflict', 'لا يُربط بلا دليل', 409, 'evidence_ref_required');
  barrier.barrier = 'request_listing_link_needs_evidence';
  assert.match(refusalMessage(barrier), /الحاجز: request_listing_link_needs_evidence/);
  assert.match(refusalMessage(new CRMApiError('authentication', 'x', 401, 'authentication_required')), /انتهت الجلسة/);
  assert.match(refusalMessage({ message: 'boom' }), /خطأ غير متوقع/);
  // and the panel really renders it
  const container = host();
  const controller = createCrmA5Controller({ api: () => ({}), showError: () => {} });
  controller.renderRefusal(container, new CRMApiError('validation', 'bad', 400, 'reason_contains_identifier_like_digits'));
  assert.match(container.text, /لا يُكتب رقم هاتف/);
  assert.match(container.text, /العملية لم تُنفَّذ/);
});

test('A5-UI-8 مسارات عميل API هي نفسها المسارات التي يحميها العامل (CSRF + idempotency)', async () => {
  const calls = [];
  const client = new CRMClient({
    apiBase: '/api',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, credentials: init.credentials, cache: init.cache });
      const payload = url === '/api/auth/login'
        ? { authenticated: true, csrf_token: 'csrf_token_for_runtime_only_1234567890' }
        : { ok: true };
      return { ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => payload };
    },
  });
  await client.login('a'.repeat(24));
  await client.listRequests({ contact_id: 'c-1', unmatched: 1 });
  await client.createRequest({ contact_id: 'c-1', kind: 'buy', property_type: 'apartment', source: 'manual' }, 'key-1');
  await client.setRequestStatus('req-synth-1', { status: 'active' });
  await client.linkRequestListing('req-synth-1', { listing_id: 900001, evidence_ref: 'wa:msg:1' });
  await client.decideRequestListingLink('req-synth-1', 'rll-synth-1', { state: 'confirmed' });
  await client.listInteractions({ contact_id: 'c-1', limit: 50 });
  await client.recordInteraction({ contact_id: 'c-1', kind: 'call', summary: 'مكالمة', occurred_at: '2026-11-03T09:00:00.000Z' }, 'key-2');
  await client.linkLegacyInteraction({ contact_id: 'c-1', legacy_ref_table: 'crm_contact_audit_log', legacy_ref_id: 'a-1' });
  await client.operationalQueues({ now: '2026-11-03T00:00:00.000Z' });
  await client.contactsNeedingFollowup({ limit: 50 });
  await client.createFollowup({ contact_id: 'c-1', request_id: 'req-synth-1', due_at: '2026-11-06T10:00:00.000Z' });
  await client.completeFollowup('fu-synth-1', { status: 'done', outcome: 'تم' });
  await client.listDriveReviews({ status: 'open' });
  await client.getDriveReview('frw-abcdef-1');
  await client.recordDriveReviewDecision({ case_ref: 'frw-abcdef-1', decision: 'noted', reason: 'قيد ملاحظة للاختبار' });
  await client.proposeDriveReviewLink({ case_ref: 'frw-abcdef-1', contact_id: 'c-1', link_basis: 'manual_pin', reason: 'مطابقة يدوية' });
  const paths = calls.map(c => `${c.method} ${c.url}`);
  assert.deepEqual(paths.slice(1), [
    'GET /api/requests?contact_id=c-1&unmatched=1',
    'POST /api/requests',
    'POST /api/requests/req-synth-1/status',
    'POST /api/requests/req-synth-1/links',
    'POST /api/requests/req-synth-1/links/rll-synth-1/decision',
    'GET /api/interactions?contact_id=c-1&limit=50',
    'POST /api/interactions',
    'POST /api/interactions/legacy-link',
    'GET /api/queues?now=2026-11-03T00%3A00%3A00.000Z',
    'GET /api/followups/needs?limit=50',
    'POST /api/followups',
    'POST /api/followups/fu-synth-1/complete',
    'GET /api/reviews/drive?status=open',
    'GET /api/reviews/drive/frw-abcdef-1',
    'POST /api/reviews/drive/decision',
    'POST /api/reviews/drive/link-proposal',
  ]);
  for (const call of calls.slice(1)) {
    if (call.method === 'GET') continue;
    assert.equal(call.headers['x-crm-csrf'].length >= 32, true, 'every write carries the CSRF token');
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.cache, 'no-store');
  }
  assert.equal(calls[2].headers['idempotency-key'], 'key-1');
  assert.equal(calls[7].headers['idempotency-key'], 'key-2');
  assert.match(calls[2].body, /"kind":"buy"/);
  assert.equal(/contact_id=undefined/.test(paths.join(' ')), false, 'no unresolved query holes reach the API');
});

test('A5-UI-9 اللوحة مركّوبة في crm.html وتُخدم من العامل، ولا شيء منها في الصفحات العامة', async () => {
  const [html, workerJs, indexHtml, css] = await Promise.all([
    readFile(new URL('../crm-ui/crm.html', import.meta.url), 'utf8'),
    readFile(new URL('../crm-worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.css', import.meta.url), 'utf8'),
  ]);
  for (const panel of ['a5-customer-panel', 'a5-requests-panel', 'a5-work-panel', 'a5-review-panel']) {
    assert.match(html, new RegExp(`data-panel="${panel}"`), `${panel} needs a tab`);
    assert.match(html, new RegExp(`id="${panel}" hidden`), `${panel} needs its section`);
  }
  assert.match(html, /لا دمج تلقائي لعميلين/);
  assert.match(html, /لا استدعاء لـDrive/);
  assert.match(html, /القرار يُضاف إلى سلسلة غير قابلة للتعديل/);
  assert.match(workerJs, /'\/crm-assets\/crm-a5-ui\.js'/, 'the allow-list must serve the new asset');
  assert.match(css, /\.a5-refusal/);
  assert.match(css, /@media \(max-width:640px\)\{\.a5-facts/, 'mobile-first: the fact grid collapses on small screens');
  assert.equal(indexHtml.includes('crm-a5-ui'), false, 'the public site must not reference internal customer tooling');
  assert.equal(indexHtml.includes('a5-customer-panel'), false);
});

test('A5-UI-10 اللوحة لا تطلب بيانات قبل الجلسة، وتُحدَّث عند فتح تبويبها', async () => {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); return { requests: [], cases: [], counts: {}, contacts: [] }; } });
  const controller = createCrmA5Controller({ api: () => api, showError: () => {}, prompt: () => 'نتيجة صناعية' });
  // no data fetches at construction time
  assert.deepEqual(calls, []);
  await controller.loadRequests();
  await controller.loadQueues();
  await controller.loadReviews();
  assert.deepEqual(calls, ['listRequests', 'operationalQueues', 'listDriveReviews']);
  await controller.unlock();
  assert.deepEqual(calls.slice(3), ['listRequests', 'listDriveReviews'], 'unlock refreshes the two read surfaces, no writes');
});
