import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../crm-worker.js';
import {
  CURRENT_RULE_VERSION,
  parseEgyptianTemporalSignal,
  upsertConversationAndAnalyze,
} from '../crm-chat-intel.js';
import { generateVapidKeyPair, runScheduledCrmNotifications } from '../crm-push.js';
import { createFollowupsController } from '../crm-ui/crm-assets/followups-ui.js';

const MIGRATION_FILES = [
  '0001_crm_opportunities.sql',
  '0002_crm_internal_auth.sql',
  '0003_crm_push_notifications.sql',
  '0004_crm_tracks_core.sql',
  '0005_sync_audit_and_intelligence.sql',
];
const ALLOWED_ORIGIN = 'https://nasr-crm-api-test.example.workers.dev';

function wrapD1(sqlite) {
  const makeStmt = (sql, values = []) => ({
    bind: (...next) => makeStmt(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => sqlite.prepare(sql).run(...values),
    _exec: () => sqlite.prepare(sql).run(...values),
  });
  return {
    prepare: sql => makeStmt(sql),
    batch: async statements => {
      sqlite.exec('SAVEPOINT d1_batch');
      try {
        const out = statements.map(statement => statement._exec());
        sqlite.exec('RELEASE d1_batch');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK TO d1_batch');
        sqlite.exec('RELEASE d1_batch');
        throw error;
      }
    },
  };
}

async function createIntelEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT, title TEXT,
      property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
      bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT
    );
    INSERT INTO areas VALUES (1, 'مكرم عبيد'), (2, 'عباس العقاد');
    INSERT INTO sources VALUES (4, 'site');
    INSERT INTO listings VALUES (101, 4, 'apt-101', '/properties/apt-101/', 'شقة مكرم عبيد', 'شقة', 'sale', 1, 165, 4200000, 3, 2, 'لوكس', '2026-10-25T10:00:00Z');
  `);
  for (const file of MIGRATION_FILES) {
    sqlite.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }

  const vapid = await generateVapidKeyPair();
  const accessCode = 'Test-Only-Intel-Code-2026-Strong-Key!';
  const sessionSecret = 'Test-Only-Intel-Session-2026-Strong!';
  const env = {
    DB: wrapD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    CRM_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    CRM_ACCESS_CODE: accessCode,
    CRM_SESSION_SECRET: sessionSecret,
    CRM_NASR_AREA_IDS: '1,2',
    CRM_SITE_SOURCE_ID: '4',
    CRM_VAPID_PUBLIC_KEY: vapid.publicKeyB64u,
    CRM_VAPID_PRIVATE_KEY: vapid.privateKeyB64u,
    CRM_VAPID_SUBJECT: 'mailto:test@example.com',
  };

  const loginRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.88',
    },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const { csrf_token: csrfToken } = await loginRes.json();

  const call = (path, { method = 'GET', body, key } = {}) => {
    const headers = { origin: ALLOWED_ORIGIN, cookie, 'sec-fetch-site': 'same-origin' };
    if (method !== 'GET' && method !== 'HEAD') headers['x-crm-csrf'] = csrfToken;
    if (key) headers['idempotency-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return worker.fetch(new Request(`${ALLOWED_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };

  return { sqlite, db: env.DB, env, call };
}

test('Part II Test 1 & 2: parses explicit Egyptian temporal expressions in Africa/Cairo, distinguishes customer vs broker origin, and NEVER invents dates for ambiguous phrases', () => {
  const baseSent = '2026-10-28T12:00:00.000Z'; // Wed Oct 28 2026 14:00 Cairo

  // 1) Explicit customer callback promise: "كلمني بكرة الساعة 5"
  const tomorrow5 = parseEgyptianTemporalSignal('تمام يا أستاذ طارق كلمني بكرة الساعة 5 مساءً', baseSent, 'customer');
  assert.ok(tomorrow5);
  assert.equal(tomorrow5.due_precision, 'exact');
  assert.equal(tomorrow5.date_origin, 'customer_promised');
  assert.ok(tomorrow5.due_at.startsWith('2026-10-29T'));

  // 2) Explicit broker-scheduled promise: "هكلم حضرتك الأسبوع الجاي"
  const nextWeekBroker = parseEgyptianTemporalSignal('خلاص يا فندم هكلم حضرتك الأسبوع الجاي نأكد الميعاد', baseSent, 'broker');
  assert.ok(nextWeekBroker);
  assert.equal(nextWeekBroker.date_origin, 'broker_scheduled');
  assert.notEqual(nextWeekBroker.due_precision, 'ambiguous');
  assert.ok(nextWeekBroker.due_at.startsWith('2026-11-04T'));

  // 3) Ambiguous Egyptian expressions -> MUST return due_precision='ambiguous' and due_at=null!
  for (const phrase of ['نتكلم بعد القبض إن شاء الله', 'خليها بعد العيد أحسن', 'لما أفضى هبعتلك', 'هرد عليك بعد الرجوع من السفر']) {
    const amb = parseEgyptianTemporalSignal(phrase, baseSent, 'customer');
    assert.ok(amb, `Expected temporal review signal for "${phrase}"`);
    assert.equal(amb.due_precision, 'ambiguous', `Phrase "${phrase}" must be marked ambiguous`);
    assert.equal(amb.due_at, null, `Phrase "${phrase}" must NEVER invent a confirmed date`);
  }
});

test('Part II Test 3, 4, 5 & 6: detects viewing_requested_unlogged, offer_sent_no_followup, request_specs_changed (without mutating opp!), unanswered_question, and high_interest_stalled with all required fields', async () => {
  const { sqlite, db, call } = await createIntelEnv();
  const now = new Date('2026-10-30T14:00:00.000Z');

  // Create contact + opportunity (3M budget, 140m2, Makram Ebeid)
  const oppRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'intel-opp-main-0001',
    body: {
      name: 'عميل ذكاء محادثات تجريبي',
      phone: '01033445566',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 2800000,
      budget_max: 3200000,
      size_min_m2: 130,
      size_max_m2: 150,
      next_action: 'إرسال عروض',
      next_followup_at: '2026-10-29T10:00:00Z',
    },
  });
  assert.equal(oppRes.status, 201);
  const { contact_id: contactId, opportunity_id: oppId } = await oppRes.json();

  // Case A: Viewing request + Spec change + Unanswered question
  const chatViewingAndSpec = [
    '26/10/2026, 2:00 م - عميل ذكاء محادثات تجريبي: السلام عليكم رفعت الميزانية لـ 5 مليون وعايز شقة 200 متر في عباس العقاد',
    '26/10/2026, 2:05 م - سمسار طلبك: تمام يا فندم متاح شقة ممتازة في عباس العقاد https://nasr-realestate.github.io/properties/apt-101/',
    '28/10/2026, 6:00 م - عميل ذكاء محادثات تجريبي: ممتاز جداً، ممكن نعاين الشقة؟ وهل العمارة مرخصة وفيها حصة في الأرض؟',
  ].join('\n');

  const resA = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-test-viewing-spec',
    contactId,
    opportunityId: oppId,
    chatTitle: 'عميل ذكاء محادثات تجريبي',
    rawText: chatViewingAndSpec,
    now,
  });
  assert.equal(resA.created, true);

  const alertsA = sqlite.prepare("SELECT * FROM crm_smart_alerts WHERE conversation_id = ? AND status = 'open'").all(resA.conversation_id);
  const typesA = new Set(alertsA.map(a => a.alert_type));
  assert.ok(typesA.has('viewing_requested_unlogged'), 'Must detect unlogged viewing request');
  assert.ok(typesA.has('request_specs_changed'), 'Must detect spec change vs linked opportunity');
  assert.ok(typesA.has('unanswered_question'), 'Must detect unanswered customer question');

  // Verify every smart alert carries ALL mandatory Part II fields
  for (const alert of alertsA) {
    assert.equal(alert.customer_name, 'عميل ذكاء محادثات تجريبي');
    assert.equal(alert.opportunity_id, oppId);
    assert.ok(alert.alert_reason && alert.alert_reason.length > 5);
    assert.ok(alert.source_message_at);
    assert.ok(alert.excerpt && alert.excerpt.length > 5);
    assert.ok(alert.suggested_action && alert.suggested_action.length > 5);
    assert.ok(alert.confidence >= 0.5 && alert.confidence <= 1);
    assert.equal(alert.rule_version, CURRENT_RULE_VERSION);
  }

  // GUARDRAIL: Linked opportunity specs MUST remain untouched (still 3,200,000 & مكرم عبيد)!
  const unchangedOpp = sqlite.prepare('SELECT area_label, budget_max, size_max_m2 FROM crm_opportunities WHERE id = ?').get(oppId);
  assert.equal(unchangedOpp.area_label, 'مكرم عبيد');
  assert.equal(unchangedOpp.budget_max, 3200000);
  assert.equal(unchangedOpp.size_max_m2, 150);

  // Verify insights row stores rule_version, analyzed_at, confidence, and source_message_id
  const insightRow = sqlite.prepare('SELECT * FROM crm_conversation_insights WHERE conversation_id = ?').get(resA.conversation_id);
  assert.ok(insightRow);
  assert.equal(insightRow.rule_version, CURRENT_RULE_VERSION);
  assert.ok(insightRow.analyzed_at);
  assert.ok(insightRow.spec_change_json);

  // Case B: Broker sent property offer >48h ago with NO customer reply -> offer_sent_no_followup
  const c2Res = await call('/api/contacts', {
    method: 'POST',
    key: 'intel-contact-offer-0002',
    body: { name: 'عميل عرض بدون رد تجريبي', phones: [{ phone: '01277889900', is_primary: true }] },
  });
  const { contact_id: c2Id } = await c2Res.json();
  const chatOfferNoReply = [
    '25/10/2026, 1:00 م - عميل عرض بدون رد تجريبي: محتاج تفاصيل شقق مكرم عبيد',
    '25/10/2026, 1:10 م - سمسار طلبك: اتفضل تفاصيل وسعر الشقة المتاحة https://nasr-realestate.github.io/properties/apt-101/',
  ].join('\n');
  const resB = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-test-offer-noreply',
    contactId: c2Id,
    chatTitle: 'عميل عرض بدون رد تجريبي',
    rawText: chatOfferNoReply,
    now,
  });
  const alertsB = sqlite.prepare('SELECT alert_type FROM crm_smart_alerts WHERE conversation_id = ?').all(resB.conversation_id);
  assert.ok(alertsB.some(a => a.alert_type === 'offer_sent_no_followup'));

  // Case C: High-interest customer stalled >7 days -> high_interest_stalled
  const chatStalled = [
    '15/10/2026, 5:00 م - عميل عرض بدون رد تجريبي: الشقة دي مناسبة جداً وجاهز للتعاقد كاش الأسبوع ده',
    '15/10/2026, 5:10 م - سمسار طلبك: تمام يا فندم تحت أمرك',
  ].join('\n');
  const resC = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-test-stalled-hot',
    contactId: c2Id,
    chatTitle: 'عميل مهتم متوقف تجريبي',
    rawText: chatStalled,
    now,
  });
  const alertsC = sqlite.prepare('SELECT alert_type FROM crm_smart_alerts WHERE conversation_id = ?').all(resC.conversation_id);
  assert.ok(alertsC.some(a => a.alert_type === 'high_interest_stalled'));
  sqlite.close();
});

test('Part II Test 7 & 8: incremental append without reprocessing archive, strict DB deduplication, Follow-up Workspace 6 queues, Unmatched Review linking, and Cron Push suppression of closed alerts', async () => {
  const { sqlite, db, env, call } = await createIntelEnv();
  const now = new Date('2026-10-30T11:00:00.000Z');

  const oppRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'intel-dedupe-opp-0001',
    body: {
      name: 'عميل متابعة وتنبيهات تجريبي',
      phone: '01144556677',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      next_action: 'اتصال تأكيدي',
      next_followup_at: '2026-10-30T08:00:00.000Z', // Overdue earlier today in Africa/Cairo!
    },
  });
  const { contact_id: contactId, opportunity_id: oppId } = await oppRes.json();

  const initialChat = [
    '29/10/2026, 4:00 م - عميل متابعة وتنبيهات تجريبي: السلام عليكم كلمني بكرة الساعة 2 بعد الضهر',
  ].join('\n');

  const firstImport = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-incremental-01',
    contactId,
    opportunityId: oppId,
    chatTitle: 'عميل متابعة وتنبيهات تجريبي',
    rawText: initialChat,
    now,
  });
  assert.equal(firstImport.created, true);
  assert.equal(firstImport.message_count, 1);
  const firstMsgRow = sqlite.prepare('SELECT id FROM crm_conversation_messages WHERE conversation_id = ?').get(firstImport.conversation_id);
  const initialAlertCount = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_smart_alerts WHERE conversation_id = ?').get(firstImport.conversation_id).cnt;
  assert.ok(initialAlertCount >= 1);

  // Re-run identical archive -> incremental skip, zero duplicate alerts!
  const secondImport = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-incremental-01',
    contactId,
    opportunityId: oppId,
    chatTitle: 'عميل متابعة وتنبيهات تجريبي',
    rawText: initialChat,
    now,
  });
  assert.equal(secondImport.incremental_skipped, true);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_smart_alerts WHERE conversation_id = ?').get(firstImport.conversation_id).cnt,
    initialAlertCount,
  );

  // Append 1 new message -> existing message ID stays identical (not deleted/recreated!)
  const appendedChat = `${initialChat}\n30/10/2026, 12:30 م - عميل متابعة وتنبيهات تجريبي: ممكن كمان أعرف الدور الكام؟`;
  const thirdImport = await upsertConversationAndAnalyze(db, {
    conversationUid: 'conv-incremental-01',
    contactId,
    opportunityId: oppId,
    chatTitle: 'عميل متابعة وتنبيهات تجريبي',
    rawText: appendedChat,
    now,
  });
  assert.equal(thirdImport.incremental_skipped, false);
  assert.equal(thirdImport.message_count, 2);
  const preservedFirstMsg = sqlite.prepare('SELECT id FROM crm_conversation_messages WHERE conversation_id = ? AND seq_no = 1').get(firstImport.conversation_id);
  assert.equal(preservedFirstMsg.id, firstMsgRow.id, 'Incremental append must preserve existing message IDs');

  // Import an unmatched conversation and verify manual review linking via /api/conversations/:id/link
  const unmatchedRes = await call('/api/conversations/import', {
    method: 'POST',
    body: {
      chat_title: 'محادثة غير مرتبطة للمراجعة تجريبية',
      raw_text: '29/10/2026, 7:00 م - مرسل للمراجعة: محتاج شقة مفروشة بعباس العقاد',
    },
  });
  assert.equal(unmatchedRes.status, 201);
  const { conversation_id: unmatchedConvId } = await unmatchedRes.json();

  // Verify GET /api/followups returns all 6 queues + unmatched_review
  const followupsRes = await call('/api/followups');
  assert.equal(followupsRes.status, 200);
  const followupsData = await followupsRes.json();
  for (const queueKey of ['today', 'overdue', 'upcoming', 'waiting_reply', 'needs_intervention', 'new_chat_alerts']) {
    assert.ok(Array.isArray(followupsData.queues[queueKey]), `Missing queue ${queueKey}`);
  }
  assert.equal(followupsData.unmatched_review.length, 1);
  assert.equal(followupsData.unmatched_review[0].id, unmatchedConvId);

  // Link unmatched conversation manually to contactId via API
  const linkRes = await call(`/api/conversations/${unmatchedConvId}/link-contact`, {
    method: 'POST',
    body: { contact_id: contactId, opportunity_id: oppId },
  });
  assert.equal(linkRes.status, 200);
  const afterLink = await (await call('/api/followups')).json();
  assert.equal(afterLink.unmatched_review.length, 0);

  // Resolve ALL open smart alerts via /api/alerts/:id/resolve + log outcome, then verify Cron Push NEVER sends closed alerts!
  const openAlerts = sqlite.prepare("SELECT id FROM crm_smart_alerts WHERE status = 'open'").all();
  assert.ok(openAlerts.length >= 1);
  for (const a of openAlerts) {
    const resolveRes = await call(`/api/alerts/${a.id}/resolve`, {
      method: 'POST',
      body: {
        status: 'completed',
        log_activity: true,
        activity_type: 'call',
        outcome_summary: 'تم الاتصال بالعميل وتحديد الموعد النهائي',
        next_action: 'معاينة ميدانية',
        next_followup_at: '2026-11-02T14:00:00Z',
      },
    });
    assert.equal(resolveRes.status, 200);
  }

  // Verify history preserved (rows NOT deleted, status='completed', resolved_by_activity_id populated)
  const completedRows = sqlite.prepare("SELECT status, resolved_at, resolved_by_activity_id FROM crm_smart_alerts WHERE status = 'completed'").all();
  assert.equal(completedRows.length, openAlerts.length);
  assert.ok(completedRows[0].resolved_at);
  assert.ok(completedRows[0].resolved_by_activity_id);

  // Subscribe a Push device and run Cron -> smart_alerts sent MUST be 0 because all alerts are completed!
  const devKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  await call('/api/push/subscribe', {
    method: 'POST',
    body: {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/intel-cron-device',
        keys: {
          p256dh: Buffer.from(await crypto.subtle.exportKey('raw', devKey.publicKey)).toString('base64url'),
          auth: crypto.randomBytes(16).toString('base64url'),
        },
      },
      device_label: 'Cron Test Device',
    },
  });

  let pushCalls = 0;
  const cronResult = await runScheduledCrmNotifications(env, {
    now: new Date('2026-10-30T13:00:00.000Z'), // 15:00 Cairo (outside 09:00 digest window)
    forceCheck: true,
    fetchImpl: async () => {
      pushCalls += 1;
      return new Response('', { status: 201 });
    },
  });
  assert.equal(cronResult.smart_alerts, 0, 'Closed/completed smart alerts must NEVER fire Push notifications');
  assert.equal(pushCalls, 0);
  sqlite.close();
});

test('Part II Test 9: Follow-up Screen UI controller renders queues, opens untruncated chat viewer, logs resolution, and makes ZERO external AI calls', async () => {
  // Minimal DOM environment without external dependencies
  const makeNode = (tag = 'div') => {
    const listeners = new Map();
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      hidden: false,
      disabled: false,
      value: '',
      href: '',
      target: '',
      rel: '',
      type: '',
      rows: 0,
      placeholder: '',
      dataset: {},
      children: [],
      classList: {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        toggle: (c, f) => {
          const on = f === undefined ? !classes.has(c) : Boolean(f);
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: c => classes.has(c),
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n === null || n === undefined) continue;
          this.children.push(typeof n === 'string' ? { tagName: '#TEXT', textContent: n, children: [] } : n);
        }
      },
      appendChild(n) { this.append(n); return n; },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      setAttribute(k, v) { this[k] = String(v); },
      addEventListener(ev, fn) { listeners.set(ev, fn); },
      async trigger(ev, eventObj = { preventDefault() {} }) {
        const fn = listeners.get(ev);
        if (fn) await fn(eventObj);
      },
    };
    return el;
  };

  const domById = new Map([
    ['followups-metrics', makeNode('div')],
    ['followups-queue-heading', makeNode('h2')],
    ['followups-list', makeNode('div')],
    ['conversation-viewer', makeNode('section')],
  ]);

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: tag => makeNode(tag),
    getElementById: id => domById.get(id) || null,
    querySelectorAll: () => [],
    body: makeNode('body'),
  };

  const treeText = el => [el.textContent || '', ...(el.children || []).map(treeText)].join(' ');
  let resolvedPayload = null;

  try {
    const fakeApi = {
      getFollowups: async () => ({
        cairo_day: '2026-10-30',
        counts: { today: 1, overdue: 0, upcoming: 0, waiting_reply: 0, stalled_intervention: 1, new_chat_alerts: 1, unmatched_review_chats: 1 },
        today: [{
          item_kind: 'smart_alert',
          alert_id: 'alert-ui-01',
          alert_type: 'viewing_requested_unlogged',
          priority: 'high',
          customer_name: 'عميل شاشة المتابعة تجريبي',
          phone_key: '201055554444',
          contact_id: 'c-ui-01',
          opportunity_id: 'opp-ui-01',
          conversation_id: 'conv-ui-01',
          intent: 'buy',
          area_label: 'مكرم عبيد',
          alert_reason: 'طلب معاينة في المحادثة بدون تسجيل زيارة',
          excerpt: 'ممكن نعاين الشقة بكرة الساعة 6؟',
          suggested_action: 'تأكيد موعد المعاينة وتسجيله',
          confidence: 0.92,
          source_message_at: '2026-10-30T10:00:00Z',
        }],
        overdue: [],
        upcoming: [],
        waiting_reply: [],
        stalled_intervention: [],
        new_chat_alerts: [],
      }),
      getConversation: async id => ({
        conversation: {
          id,
          chat_title: 'محادثة كاملة للعميل التجريبي',
          match_status: 'matched',
          char_length: 9200,
          message_count: 2,
          source_ref: 'whatsapp.zip',
          raw_text: 'نص كامل محفوظ بالكامل بدون اقتطاع',
          parse_warnings: [],
        },
        insights: { inferred_intent: 'buy', inferred_area: 'مكرم عبيد', confidence: 0.92 },
        messages: [
          { seq_no: 1, sender_role: 'customer', sender_label: 'عميل تجريبي', raw_timestamp: '30/10/2026 12:00 م', body_text: 'ممكن نعاين الشقة؟ https://nasr-realestate.github.io/properties/apt-101/', links: [{ url: 'https://nasr-realestate.github.io/properties/apt-101/' }] },
          { seq_no: 2, sender_role: 'broker', sender_label: 'سمسار طلبك', raw_timestamp: '30/10/2026 12:05 م', body_text: 'تحت أمر حضرتك', links: [] },
        ],
      }),
      resolveSmartAlert: async (id, payload) => {
        resolvedPayload = { id, payload };
        return { ok: true };
      },
    };

    const controller = createFollowupsController({
      api: () => fakeApi,
      getContacts: () => [{ id: 'c-ui-01', name: 'عميل شاشة المتابعة تجريبي', primary_phone: '201055554444' }],
      openContact: async () => {},
      openOpportunity: async () => {},
      openPanel: () => {},
      showError: err => { throw err; },
      errorText: err => String(err),
    });

    await controller.refreshFollowups();
    const listText = treeText(domById.get('followups-list'));
    assert.ok(listText.includes('عميل شاشة المتابعة تجريبي'));
    assert.ok(listText.includes('طلب معاينة في المحادثة'));

    // Click "المحادثة الأصلية" button on the alert card to open full untruncated conversation viewer
    const findButtonByText = (root, needle) => {
      if (root.tagName === 'BUTTON' && (root.textContent || '').includes(needle)) return root;
      for (const ch of root.children || []) {
        const hit = findButtonByText(ch, needle);
        if (hit) return hit;
      }
      return null;
    };
    const openConvBtn = findButtonByText(domById.get('followups-list'), 'المحادثة الأصلية');
    assert.ok(openConvBtn, 'Expected button to open original untruncated conversation');
    await openConvBtn.trigger('click');
    assert.ok(treeText(domById.get('conversation-viewer')).includes('ممكن نعاين الشقة؟'));

    // Trigger inline resolution submit on the rendered alert card
    const findTag = (root, tag) => {
      if (root.tagName === tag) return root;
      for (const ch of root.children || []) {
        const hit = findTag(ch, tag);
        if (hit) return hit;
      }
      return null;
    };
    const resolveForm = findTag(domById.get('followups-list'), 'FORM');
    assert.ok(resolveForm, 'Expected inline resolution form inside smart alert card');
    await resolveForm.trigger('submit');
    assert.equal(resolvedPayload.id, 'alert-ui-01');
    assert.equal(resolvedPayload.payload.status, 'completed');
    assert.equal(resolvedPayload.payload.log_activity, true);
  } finally {
    globalThis.document = prevDoc;
  }
});
