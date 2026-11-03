/**
 * A5 (ب/ج/d) — الطلبات والتفاعلات والمتابعات، عبر المسار الفعلي: worker.fetch → بوابة الجلسة → الخدمة →
 * SQLite يحمل نفس DDL المطبَّق على قاعدة الاختبار (0012/0013). لا بيانات عملاء حقيقية: كل شيء صناعي.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import worker from '../crm-worker.js';
import { buildRegistry, oneOf, T0 } from './_registry-fixture.mjs';
import {
  createCustomerRequestPayload, deriveRequestDedupeKey, setCustomerRequestStatusPayload,
} from '../crm-customer-requests.js';
import { createFollowupPayload, recordInteractionPayload } from '../crm-interactions.js';

const ORIGIN = 'https://nasr-crm-api-test.example.workers.dev';

async function buildA5Env({ withAuth = true } = {}) {
  const { sqlite, db } = buildRegistry({ ledger: true });
  sqlite.exec(`INSERT OR IGNORE INTO sources (id, name) VALUES (1, 'synthetic');
    INSERT OR IGNORE INTO areas (id, name_ar) VALUES (1, 'الأندلس'), (2, 'مكرم عبيد');
    INSERT INTO listings (id, source_id, external_id, url, title, property_type, transaction_type,
      area_id, area_m2, price, bedrooms, bathrooms, finishing, observed_at)
      VALUES (900001, NULL, 'synth-nasr-a', '/properties/synth-a/', 'شقة صناعية أ', 'apartment', 'sale', NULL, 140, 3600000, 3, 2, 'نصف تشطيب', '2026-11-01 09:00:00'),
             (900002, NULL, 'synth-nasr-b', '/properties/synth-b/', 'شقة صناعية ب', 'apartment', 'rent',  NULL, 110, 18000, 2, 1, 'تشطيب كامل', '2026-11-01 09:00:00');`);
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
  let cookie = '';
  let csrf = '';
  if (withAuth) {
    const login = await worker.fetch(new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ access_code: accessCode }),
    }), env);
    assert.equal(login.status, 200, 'the synthetic login must succeed for the harness to work');
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    csrf = (await login.json()).csrf_token;
  }
  async function call(path, { method = 'GET', body, key, useAuth = true, sendCsrf = true, origin = ORIGIN } = {}) {
    const headers = { origin };
    if (useAuth && cookie) headers.cookie = cookie;
    if (sendCsrf && method !== 'GET' && method !== 'HEAD' && csrf) headers['x-crm-csrf'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  }
  return { sqlite, db, env, call };
}

/** One synthetic customer with two numbers, created through the real endpoints. */
async function makeContact(call, tag, phone, secondPhone) {
  const created = await call('/api/contacts', {
    method: 'POST', key: `a5-contact-${tag}`,
    body: { name: `عميل صناعي ${tag}`, phones: [{ phone, is_primary: true }] },
  });
  assert.ok(created.body?.contact_id, `contact create failed: ${JSON.stringify(created.body)}`);
  const contactId = created.body.contact_id;
  if (secondPhone) {
    const added = await call(`/api/contacts/${contactId}/phones`, { method: 'POST', body: { phone: secondPhone, label: 'ثانٍ' } });
    assert.ok(added.status < 400, `attaching a second number failed: ${added.status} ${JSON.stringify(added.body)}`);
  }
  return contactId;
}

const REQUEST_BODY = { kind: 'buy', property_type: 'apartment', area: 'الأندلس', rooms: 3, budget_min: 3000000, budget_max: 4000000, source: 'whatsapp' };

test('A5-1 العميل والأرقام: رقمان لعميل واحد، ورقم أساسي واحد مُكرَه في القاعدة', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '01', '01000000011', '01000000012');
  const phones = sqlite.prepare('SELECT phone_key, is_primary FROM crm_contact_phones WHERE contact_id = ? ORDER BY phone_key').all(contactId);
  assert.equal(phones.length, 2, 'the second number must be attached to the same customer');
  assert.equal(phones.filter(p => p.is_primary === 1).length, 1, 'exactly one primary number');
  const second = sqlite.prepare('SELECT id FROM crm_contact_phones WHERE contact_id = ? AND is_primary = 0').get(contactId);
  const promoted = await call(`/api/contacts/${contactId}/phones/${second.id}`, { method: 'PATCH', body: { is_primary: true } });
  assert.ok(promoted.status < 400, `promotion should be accepted, got ${promoted.status} ${JSON.stringify(promoted.body)}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM crm_contact_phones WHERE contact_id = ? AND is_primary = 1').get(contactId).c, 1);
  // the DB itself refuses two primaries, independently of the API
  assert.throws(() => sqlite.prepare(`UPDATE crm_contact_phones SET is_primary = 1 WHERE contact_id = '${contactId}'`).run(),
    /UNIQUE constraint failed: crm_contact_phones.contact_id/);
  // and a number cannot be shared with a second customer
  const other = await call('/api/contacts', { method: 'POST', key: 'a5-contact-owner-2', body: { name: 'عميل صناعي آخر', phones: [{ phone: '01000000011' }] } });
  assert.equal(other.status, 409, 'a phone owned by another customer must be a conflict, not a merge');
  assert.equal(other.body?.error, 'duplicate_phone_review');
  assert.equal(other.body?.review_required, true, 'the conflict is surfaced for a human, never merged silently');
});

test('A5-2 الطلبات: طلب شراء وطلب إيجار مستقلان لنفس العميل، بلا تكرار وبلا خلط بالعقار المعروض', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '02', '10100000011');
  const buy = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } });
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  assert.equal(buy.body.request.status, 'new');
  assert.equal(buy.body.request.city, 'مدينة نصر', 'the served city is fixed by the layer, not typed by the caller');
  assert.equal(buy.body.request.contact_id, contactId, 'the request belongs to the customer it names');
  const rent = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, kind: 'rent', budget_min: 12000, budget_max: 18000, actor: 'منى' } });
  assert.equal(rent.status, 201);
  assert.notEqual(rent.body.request.id, buy.body.request.id);
  const listed = await call(`/api/requests?contact_id=${contactId}`);
  assert.equal(listed.body.total, 2, 'a customer may hold more than one request');
  const again = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } });
  assert.equal(again.status, 409, 're-sending the same intent is a replay, not a second request');
  assert.equal(again.body.error, 'duplicate_request');
  assert.equal(again.body.existing_request_id, buy.body.request.id);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM crm_customer_requests').get().c, 2);

  const bad = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, budget_min: 5000000, budget_max: 1000000, actor: 'منى' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_range');
  const ghost = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: 'does-not-exist-1', actor: 'منى' } });
  assert.equal(ghost.status, 404, 'a request cannot be created for a customer that does not exist');
  assert.throws(() => sqlite.prepare(`INSERT INTO crm_customer_requests (id, contact_id, kind, property_type, city, status, source, dedupe_key, created_at, updated_at)
      VALUES ('req-outside-2', '${contactId}', 'buy', 'apartment', 'المعادي', 'new', 'phone', '${'a'.repeat(64)}', '2026-11-03T09:00:00.000Z', '2026-11-03T09:00:00.000Z')`).run(),
    /CHECK constraint failed: city/);
  // the key is derived, so an identical intent from another customer is a different request
  const other = await makeContact(call, '03', '10100000012');
  assert.notEqual(await deriveRequestDedupeKey({ contactId, kind: 'buy', propertyType: 'apartment', area: 'الأندلس', subArea: null, budgetMin: 3000000, budgetMax: 4000000, createdAt: T0 }),
    await deriveRequestDedupeKey({ contactId: other, kind: 'buy', propertyType: 'apartment', area: 'الأندلس', subArea: null, budgetMin: 3000000, budgetMax: 4000000, createdAt: T0 }));
});

test('A5-3 حالات الطلب: الانتقالات مشروعة، والإيقاف والإغلاق بسبب، والسجل append-only', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '04', '10100000021');
  const created = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'حسام' } });
  const id = created.body.request.id;
  const jump = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'closed', reason: 'اشترى من الخارج' }, actor: 'حسام' });
  assert.equal(jump.status, 409, 'new → closed is not a legal move');
  assert.equal(jump.body.error, 'illegal_status_transition');
  const pausedNoReason = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'paused' } });
  assert.equal(pausedNoReason.status, 400, 'pausing without a reason is refused (the CHECK in 0012 too)');
  assert.ok(pausedNoReason.body.error.startsWith('reason'));
  const active = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'active' } });
  assert.ok(active.status < 400, JSON.stringify(active.body));
  const paused = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'paused', reason: 'الميزانية قيد المراجعة' } });
  assert.ok(paused.status < 400);
  assert.equal(paused.body.request.stop_reason, 'الميزانية قيد المراجعة');
  const closed = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'closed', reason: 'تم الحجز' } });
  assert.ok(closed.status < 400);
  assert.ok(closed.body.request.closed_at, 'closing stamps closed_at');
  const history = sqlite.prepare('SELECT from_status, to_status FROM crm_request_status_history WHERE request_id = ? ORDER BY seq').all(id).map(r => `${r.from_status ?? '∅'}→${r.to_status}`);
  assert.deepEqual(history, ['∅→new', 'new→active', 'active→paused', 'paused→closed']);
  const after = await call(`/api/requests/${id}/status`, { method: 'POST', body: { status: 'active' } });
  assert.equal(after.status, 409, 'a closed request is not resurrected');
  assert.equal(after.body.error, 'illegal_status_transition');
  assert.equal(sqlite.prepare('SELECT status FROM crm_customer_requests WHERE id = ?').get(id).status, 'closed', 'the refusal left the request closed');
  assert.throws(() => sqlite.prepare(`UPDATE crm_request_status_history SET to_status = 'won' WHERE request_id = '${id}'`).run(),
    /request_history_is_append_only/);
  // a rewrite of the owning customer is refused by 0012; the timestamp is far in the future so that the
  // identity guard, and not trg_crm_request_timestamp_forward, is the barrier that answers.
  assert.throws(() => sqlite.prepare(`UPDATE crm_customer_requests SET contact_id = 'other-contact-1', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = '${id}'`).run(),
    /customer_request_identity_is_immutable/);
});

test('A5-4 الربط بعقار معروض: دليل إلزامي، والتأكيد قرار إنسان مسمّى، والطلب لا يُعاد تفسيره', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '05', '10100000031');
  const request = (await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } })).body.request;
  const noEvidence = await call(`/api/requests/${request.id}/links`, { method: 'POST', body: { listing_id: 900001 } });
  assert.equal(noEvidence.status, 400, 'a link without an evidence reference is the speculative match this project refuses');
  assert.equal(noEvidence.body.error, 'evidence_ref_required');
  const ghostListing = await call(`/api/requests/${request.id}/links`, { method: 'POST', body: { listing_id: 999999, evidence_ref: 'wa:msg:700001' } });
  assert.equal(ghostListing.status, 404);
  const linked = await call(`/api/requests/${request.id}/links`, { method: 'POST', body: { listing_id: 900001, evidence_ref: 'wa:msg:700001' } });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.link.state, 'proposed');
  const twice = await call(`/api/requests/${request.id}/links`, { method: 'POST', body: { listing_id: 900001, evidence_ref: 'wa:msg:700001' } });
  assert.equal(twice.status, 409);
  const confirmed = await call(`/api/requests/${request.id}/links/${linked.body.link.id}/decision`, { method: 'POST', body: { state: 'confirmed' } });
  assert.ok(confirmed.status < 400, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.link.decided_by.length > 0, true);
  const reDecided = await call(`/api/requests/${request.id}/links/${linked.body.link.id}/decision`, { method: 'POST', body: { state: 'rejected' } });
  assert.equal(reDecided.status, 409, 'a decided link is not silently re-decided');
  const detail = await call(`/api/requests/${request.id}`);
  assert.equal(detail.body.request.listing_links[0].listing_title, 'شقة صناعية أ');
  assert.equal(detail.body.request.listing_links[0].state, 'confirmed');
  // a robot name is refused by the same vocabulary 0011 uses
  const asRobot = await call(`/api/requests/${request.id}/links`, { method: 'POST', body: { listing_id: 900002, evidence_ref: 'wa:msg:700002', actor: 'matcher' } });
  assert.equal(asRobot.status, 403, 'proposed_by must be a person: the matcher is not');
  // and the DB holds the line on its own
  const linkId = sqlite.prepare('SELECT id FROM crm_request_listing_link WHERE request_id = ? AND listing_id = 900001').get(request.id).id;
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM crm_request_listing_link WHERE id = ?').get(linkId).c, 1);
  assert.throws(() => sqlite.prepare(`UPDATE crm_request_listing_link SET evidence_ref = 'rewritten' WHERE id = '${linkId}'`).run(),
    /request_listing_link_evidence_is_immutable/);
});

test('A5-5 التفاعلات: سجل موحَّد append-only، وإعادة الإرسال لا تُضاعف، والربط بالقديم مرجعي لا نسخة', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '06', '10100000041');
  const request = (await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } })).body.request;
  const call1 = await call('/api/interactions', { method: 'POST', body: { contact_id: contactId, request_id: request.id, kind: 'call', occurred_at: '2026-11-03T10:00:00.000Z', summary: 'مكالمة أولى لتحديد الميزانية', outcome: 'الميزانية مؤكدة', next_step: 'إرسال ثلاث وحدات', next_followup_at: '2026-11-05T10:00:00.000Z', source: 'phone', actor: 'منى' } });
  assert.equal(call1.status, 201, JSON.stringify(call1.body));
  assert.equal(call1.body.interaction.contact_id, contactId);
  const replay = await call('/api/interactions', { method: 'POST', body: { contact_id: contactId, request_id: request.id, kind: 'call', occurred_at: '2026-11-03T10:00:00.000Z', summary: 'مكالمة أولى لتحديد الميزانية', source: 'phone', actor: 'منى' } });
  assert.equal(replay.status, 409, 'the same event twice is a replay');
  assert.equal(replay.body.error, 'duplicate_interaction');
  assert.equal(replay.body.existing_interaction_id, call1.body.interaction.id);
  const badTarget = await call('/api/interactions', { method: 'POST', body: { contact_id: contactId, request_id: 'req-not-there-1', kind: 'note', summary: 'x', actor: 'منى' } });
  assert.equal(badTarget.status, 404);
  const timeline = await call(`/api/interactions?contact_id=${contactId}`);
  assert.equal(timeline.body.count, 1);
  // the old history is linked, not copied: one reference per source row, idempotently
  sqlite.prepare(`INSERT INTO crm_contact_audit_log (id, contact_id, action_type, field_name, new_value, source_ref, actor, created_at)
      VALUES ('aud-synth-1', '${contactId}', 'name_updated', 'name', 'عميل صناعي 06', 'seed', 'منى', '2026-11-02T09:00:00.000Z')`).run();
  const auditId = 'aud-synth-1';
  const linked = await call('/api/interactions/legacy-link', { method: 'POST', body: { contact_id: contactId, legacy_ref_table: 'crm_contact_audit_log', legacy_ref_id: auditId, summary: 'سجل سابق مُدرج في الخط الزمني', occurred_at: '2026-11-02T09:00:00.000Z', actor: 'منى' } });
  assert.ok(linked.status < 400, JSON.stringify(linked.body));
  assert.equal(linked.body.interaction.source, 'import', 'a legacy link is an import, and 0013 demands that');
  const relink = await call('/api/interactions/legacy-link', { method: 'POST', body: { contact_id: contactId, legacy_ref_table: 'crm_contact_audit_log', legacy_ref_id: auditId, actor: 'منى' } });
  assert.equal(relink.body.error, 'already_linked', 're-importing the same source row does not double the timeline');
  assert.equal(relink.status, 200);
  const original = sqlite.prepare('SELECT new_value, created_at FROM crm_contact_audit_log WHERE id = ?').get(auditId);
  assert.deepEqual(Object.values(original), ['عميل صناعي 06', '2026-11-02T09:00:00.000Z'], 'the old row is untouched — a reference, not a rewrite');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_interactions`).get().c, 2);
  assert.throws(() => sqlite.prepare(`UPDATE crm_interactions SET summary = 'مُعدَّلة' WHERE id = '${call1.body.interaction.id}'`).run(), /interactions_are_append_only/);
  assert.throws(() => sqlite.prepare(`DELETE FROM crm_interactions`).run(), /interactions_are_append_only/);
});

test('A5-6 المتابعات: مرتبطة بعميل وطلب/فرصة، لها موعد ونتيجة، والمتأخر يظهر — ولا متابعة وهمية', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '07', '10100000051');
  const request = (await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } })).body.request;
  const floating = await call('/api/followups', { method: 'POST', body: { contact_id: contactId, due_at: '2026-11-06T10:00:00.000Z', actor: 'منى' } });
  assert.equal(floating.status, 400, 'a reminder with no request and no opportunity is refused');
  assert.equal(floating.body.error, 'followup_needs_request_or_opportunity');
  const scheduled = await call('/api/followups', { method: 'POST', body: { contact_id: contactId, request_id: request.id, due_at: '2026-11-06T10:00:00.000Z', actor: 'منى' } });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const duplicate = await call('/api/followups', { method: 'POST', body: { contact_id: contactId, request_id: request.id, due_at: '2026-11-07T10:00:00.000Z', actor: 'منى' } });
  assert.equal(duplicate.status, 409, 'one open follow-up per target');
  assert.equal(duplicate.body.existing_followup_id, scheduled.body.followup.id);
  const queues = await call('/api/queues?now=2026-11-05T00:00:00.000Z');
  assert.equal(queues.status, 200);
  assert.equal(queues.body.counts.due, 1, 'due, not overdue, before the deadline');
  assert.equal(queues.body.overdue.length, 0);
  const late = await call('/api/queues?now=2026-11-08T00:00:00.000Z');
  assert.equal(late.body.overdue.length, 1, 'the same follow-up shows as overdue later');
  assert.equal(late.body.overdue[0].contact_id, contactId);
  const completeNoOutcome = await call(`/api/followups/${scheduled.body.followup.id}/complete`, { method: 'POST', body: {} });
  assert.equal(completeNoOutcome.status, 400, 'done without an outcome is refused');
  const done = await call(`/api/followups/${scheduled.body.followup.id}/complete`, { method: 'POST', body: { status: 'done', outcome: 'اتفقنا على معاينة السبت' } });
  assert.ok(done.status < 400, JSON.stringify(done.body));
  assert.equal(done.body.timeline_row_recorded, true, '0013 writes the timeline row as part of completion');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_interactions WHERE kind = 'followup' AND outcome IS NOT NULL`).get().c, 1);
  assert.equal((await call('/api/queues?now=2026-11-08T00:00:00.000Z')).body.overdue.length, 0, 'a finished follow-up leaves the queue');
  const reopen = await call(`/api/followups/${scheduled.body.followup.id}/complete`, { method: 'POST', body: { status: 'pending' } });
  assert.equal(reopen.status, 409, 'a finalized follow-up is not reopened');
  const cancelledNoReason = await call('/api/followups', { method: 'POST', body: { contact_id: contactId, opportunity_id: null, request_id: request.id, due_at: '2026-11-09T10:00:00.000Z', actor: 'منى' } });
  assert.ok(cancelledNoReason.status < 400 || cancelledNoReason.status === 409);
  const missed = await call(`/api/followups/${cancelledNoReason.body.followup?.id}/complete`, { method: 'POST', body: { status: 'missed', outcome: 'لم يرد بعد ثلاث محاولات' } });
  assert.ok(missed.status < 400, JSON.stringify(missed.body));
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_followups WHERE status = 'pending'`).get().c, 0, 'nothing lingers as a phantom obligation');
});

test('A5-7 قوائم العمل: طلبات بلا عقار مؤكَّد، وفرص صامتة، ومراحل بإغلاق مبيَّن السبب', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '08', '10100000061');
  const request = (await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'منى' } })).body.request;
  const unmatched = await call('/api/requests?unmatched=1');
  assert.equal(unmatched.body.total, 1);
  assert.equal(unmatched.body.requests[0].id, request.id);
  const inserted = sqlite.prepare(`INSERT INTO crm_opportunities (id, contact_id, lead_label, city, area_label, intent, source, status, track, property_type, notes, next_action, next_followup_at, created_at, updated_at)
      VALUES ('opp-synth-1', '${contactId}', 'فرصة صناعية', 'مدينة نصر', 'الأندلس', 'buy', 'whatsapp', 'active', 'sale_apt', 'apartment', 'وصف صناعي', 'إرسال وحدات بديلة', '2026-11-04T10:00:00.000Z', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z')`).run();
  assert.equal(inserted.changes, 1);
  const queues = await call('/api/queues?now=2026-11-03T00:00:00.000Z');
  assert.equal(queues.body.stale_opportunities.length, 1, 'a month-old opportunity with no interaction is stale');
  assert.ok(queues.body.stale_opportunities[0].days_silent >= 30);
  assert.equal(queues.body.opportunity_stages[0].status, 'active');
  await call(`/api/interactions`, { method: 'POST', body: { contact_id: contactId, opportunity_id: 'opp-synth-1', kind: 'viewing', occurred_at: '2026-11-02T09:00:00.000Z', summary: 'معاينة صناعية', source: 'manual', actor: 'منى' } });
  const afterVisit = await call('/api/queues?now=2026-11-03T00:00:00.000Z');
  assert.equal(afterVisit.body.stale_opportunities.length, 0, 'a recorded interaction stops the silence clock');
  assert.equal(afterVisit.body.opportunity_stages[0].viewings, 1, 'the stage view counts viewings from the unified log');
  const needs = await call('/api/followups/needs?now=2026-11-03T00:00:00.000Z');
  assert.equal(needs.body.count, 0, 'no follow-up is invented for a customer that has none');
});

test('A5-8 الحماية: كل مسار جديد خلف الجلسة نفسها، و CSRF و Origin ساريان، ولا شيء عام', async () => {
  const { call } = await buildA5Env();
  const surfaces = [
    '/api/requests', '/api/queues', '/api/interactions?contact_id=anything-12', '/api/followups/needs', '/api/reviews/drive',
  ];
  for (const path of surfaces) {
    const anonymous = await call(path, { useAuth: false });
    assert.equal(anonymous.status, 401, `${path} must refuse an unauthenticated read`);
    assert.equal(anonymous.body.error, 'authentication_required');
    const wrongOrigin = await call(path, { origin: 'https://evil.example' });
    assert.equal(wrongOrigin.status, 403, `${path} must refuse a foreign origin`);
  }
  const noCsrf = await call('/api/requests', { method: 'POST', sendCsrf: false, body: { ...REQUEST_BODY, contact_id: 'anything-12' } });
  assert.equal(noCsrf.status, 403, 'a state-changing call without the CSRF token is refused before the service runs');
  assert.equal(noCsrf.body.error, 'csrf_invalid');
  const postSurfaces = ['/api/interactions', '/api/followups', '/api/reviews/drive/decision', '/api/interactions/legacy-link'];
  for (const path of postSurfaces) {
    const anonymous = await call(path, { method: 'POST', body: {}, useAuth: false });
    assert.equal(anonymous.status, 401, `${path} must refuse an unauthenticated write`);
  }
  const bodyTooLarge = await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, requirements: 'س'.repeat(400_000), contact_id: 'anything-12' } });
  assert.equal(bodyTooLarge.status, 413, 'request bodies are bounded');
  // the parameterised routes inherit the same gate — no path reaches a service without a session
  for (const [method, path] of [
    ['GET', '/api/requests/req-synth-1'],
    ['POST', '/api/requests/req-synth-1/status'],
    ['POST', '/api/requests/req-synth-1/links'],
    ['POST', '/api/requests/req-synth-1/links/rll-synth-1/decision'],
    ['POST', '/api/followups/fu-synth-1/complete'],
    ['GET', '/api/reviews/drive/frw-synthdrive000000-1'],
  ]) {
    const anonymous = await call(path, { method, ...(method === 'POST' ? { body: {} } : {}), useAuth: false });
    assert.equal(anonymous.status, 401, `${method} ${path} must refuse an unauthenticated caller`);
    const csrfless = await call(path, { method, ...(method === 'POST' ? { body: {} } : {}), sendCsrf: false });
    if (method === 'POST') {
      assert.equal(csrfless.status, 403, `${method} ${path} must demand the CSRF token`);
      assert.equal(csrfless.body.error, 'csrf_invalid');
    }
  }
});

test('A5-9 سجل التدقيق: كل عملية تترك أثرًا، والأثر بصمة لا نصّ، ولا يُعاد كتابته', async () => {
  const { call, sqlite } = await buildA5Env();
  const contactId = await makeContact(call, '09', '10100000071');
  const request = (await call('/api/requests', { method: 'POST', body: { ...REQUEST_BODY, contact_id: contactId, actor: 'ريم' } })).body.request;
  await call(`/api/requests/${request.id}/status`, { method: 'POST', body: { status: 'active' } });
  const rows = sqlite.prepare('SELECT entity, action, actor, contact_id, detail_sha256 FROM crm_operational_audit_log ORDER BY seq').all();
  assert.deepEqual(rows.map(r => `${r.entity}:${r.action}`), ['customer_request:created', 'request_status:status_active']);
  assert.equal(rows[0].actor, 'ريم');
  for (const row of rows) {
    assert.match(String(row.detail_sha256), /^[0-9a-f]{64}$/, 'the audit trail stores a digest, never the payload');
  }
  assert.throws(() => sqlite.prepare(`UPDATE crm_operational_audit_log SET action = 'x' WHERE seq = 1`).run(), /operational_audit_is_append_only/);
  assert.throws(() => sqlite.prepare(`DELETE FROM crm_operational_audit_log`).run(), /operational_audit_is_append_only/);
  const phone = sqlite.prepare(`SELECT COUNT(*) AS c FROM crm_operational_audit_log WHERE detail_sha256 IS NULL`).get().c;
  assert.equal(phone, 0, 'an audit row without a digest would be unaccountable');
});

test('A5-10 الحواجز تبقى حواجز: المولّد لا يخترع مفتاحًا، والخدمة لا تكتب في جداول العملاء', async () => {
  const { db, sqlite } = await buildA5Env();
  const keyOf = fields => deriveRequestDedupeKey({ contactId: 'c-1', kind: 'buy', propertyType: 'apartment', ...fields });
  const before = { key: await keyOf({}), same: await keyOf({ createdAt: T0 }) };
  assert.equal(before.key, before.same, 'the clock is not part of an intent, so a retry cannot mint a copy');
  assert.match(before.key, /^[0-9a-f]{64}$/, 'a key the UNIQUE index in 0012 can hold');
  assert.notEqual(before.key, await keyOf({ area: 'الزهراء' }), 'a different area is a different intent');
  assert.notEqual(before.key, await keyOf({ rooms: 3 }), 'rooms are part of the intent');
  assert.notEqual(await keyOf({ budgetMin: 1 }), await keyOf({ budgetMin: 2 }), 'a different budget is a different intent');
  // a machine actor is refused at the edge, exactly as the 0011 ledger refuses one
  const robot = await createCustomerRequestPayload(db, { contact_id: 'c-1', kind: 'buy', property_type: 'apartment', source: 'phone' }, { actor: 'auto' });
  assert.deepEqual({ error: robot.error, status: robot.status }, { error: 'actor_not_human', status: 403 });
  // an unknown customer is a refusal, never a silent insert (foreign keys are on in 0012)
  const ghost = await createCustomerRequestPayload(db, { contact_id: 'ghost-contact-1', kind: 'buy', property_type: 'apartment', source: 'phone' }, { actor: 'ريم' });
  assert.deepEqual({ error: ghost.error, status: ghost.status }, { error: 'contact_not_found', status: 404 });
  const botFollowup = await createFollowupPayload(db, { contact_id: 'synth-contact-x1', request_id: 'synth-req-y1', due_at: '2026-11-06T10:00:00.000Z' }, { actor: 'cron' });
  assert.equal(botFollowup.error, 'actor_not_human');
  sqlite.prepare(`INSERT INTO crm_contacts (id, name, communication_consent, created_at, updated_at)
      VALUES ('synth-contact-k1', 'عميل صناعي للمفردات', 'request_only', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z')`).run();
  const badContact = await recordInteractionPayload(db, { contact_id: 'synth-contact-x9', kind: 'note', summary: 'ملاحظة صناعية' }, { actor: 'ريم' });
  assert.deepEqual({ error: badContact.error, status: badContact.status }, { error: 'contact_not_found', status: 404 }, 'the customer is resolved before anything is written');
  const badKind = await recordInteractionPayload(db, { contact_id: 'synth-contact-k1', kind: 'guess', summary: 'ملاحظة صناعية' }, { actor: 'ريم' });
  assert.equal(badKind.error, 'kind_not_allowed', 'there is no invented interaction kind');
  // a value that slips past the validators is still refused by the database — as a named refusal, not a 500
  const smuggled = await recordInteractionPayload(db, { contact_id: 'synth-contact-k1', kind: 'note', summary: 'ملاحظة', source: 'telepathy' }, { actor: 'ريم' });
  assert.ok(smuggled.error, 'an unknown source must not be written');
  assert.ok([400, 409].includes(smuggled.status), JSON.stringify(smuggled));
  const noReason = await setCustomerRequestStatusPayload(db, 'req-12345678', { status: 'paused' }, { actor: 'ريم' });
  assert.ok(noReason.error === 'request_not_found' || String(noReason.error).startsWith('reason'), JSON.stringify(noReason));
});
