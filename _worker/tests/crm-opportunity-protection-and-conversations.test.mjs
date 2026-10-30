import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../crm-worker.js';
import { runSourceSyncBundle } from '../crm-sync-and-match.js';

const MIGRATION_FILES = [
  '0001_crm_opportunities.sql',
  '0002_crm_internal_auth.sql',
  '0003_crm_push_notifications.sql',
  '0004_crm_tracks_core.sql',
  '0005_sync_audit_and_intelligence.sql',
  '0006_decouple_opportunities_and_contact_levels.sql',
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

function snapshotCounts(sqlite) {
  return {
    contacts: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt),
    phones: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contact_phones').get().cnt),
    opportunities: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_opportunities').get().cnt),
    activities: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_activities').get().cnt),
    opportunity_properties: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_opportunity_properties').get().cnt),
    conversations: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversations').get().cnt),
    messages: Number(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversation_messages').get().cnt),
    unmatched_review: Number(
      sqlite.prepare("SELECT COUNT(*) AS cnt FROM crm_conversations WHERE match_status = 'unmatched_review'").get().cnt,
    ),
  };
}

async function createDecoupledTestEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY,
      source_id INTEGER,
      external_id TEXT,
      url TEXT,
      title TEXT,
      property_type TEXT,
      transaction_type TEXT,
      area_id INTEGER,
      area_m2 REAL,
      price REAL,
      bedrooms INTEGER,
      bathrooms INTEGER,
      finishing TEXT,
      observed_at TEXT
    );
    INSERT INTO sources(id, name) VALUES (1, 'aqarmap');
    INSERT INTO areas(id, name_ar) VALUES (1, 'مكرم عبيد'), (2, 'عباس العقاد');
    INSERT INTO listings(id, source_id, external_id, url, title, property_type, transaction_type, area_id, area_m2, price, bedrooms, bathrooms, finishing, observed_at)
      VALUES (201, 1, 'unit-nasr-201', '/properties/unit-nasr-201/', 'شقة اختبار مكرم عبيد 180م', 'apartment', 'sale', 1, 180, 5200000, 3, 2, 'سوبر لوكس', '2026-10-28T10:00:00Z');
  `);

  // Run 0006 inside an explicit active transaction just like Cloudflare D1 remote migrations!
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    if (file.startsWith('0006_')) {
      sqlite.exec('BEGIN TRANSACTION');
      sqlite.exec(sql);
      sqlite.exec('COMMIT');
    } else {
      sqlite.exec(sql);
    }
  }
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), [], 'Zero FK violations after 0006');

  const accessCode = crypto.randomBytes(24).toString('base64url');
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  const env = {
    DB: wrapD1(sqlite),
    ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
    CRM_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    CRM_ACCESS_CODE: accessCode,
    CRM_SESSION_SECRET: sessionSecret,
    CRM_SITE_SOURCE_ID: '1',
    CRM_NASR_AREA_IDS: '1,2',
  };

  const loginRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN,
      'cf-connecting-ip': '203.0.113.77',
    },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const { csrf_token: csrfToken } = await loginRes.json();

  async function call(path, { method = 'GET', body, key } = {}) {
    const headers = { cookie, origin: ALLOWED_ORIGIN };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['x-crm-csrf'] = csrfToken;
      if (body !== undefined) headers['content-type'] = 'application/json';
    }
    if (key) headers['idempotency-key'] = key;
    return worker.fetch(new Request(`${ALLOWED_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }

  return { sqlite, db: env.DB, env, call };
}

test('Mandatory Case 1: opportunity linked to a conversation without a phone number operates independently without fake contacts', async () => {
  const { sqlite, call } = await createDecoupledTestEnv();
  const before = snapshotCounts(sqlite);
  assert.equal(before.contacts, 0);
  assert.equal(before.opportunities, 0);
  assert.equal(before.conversations, 0);

  const convImport = await (await call('/api/conversations/import', {
    method: 'POST',
    body: {
      chat_title: '🟢 مشتري تجريبي بدون رقم @buyer_demo_01',
      raw_text: [
        '29/10/2026, 4:10 م - مشتري تجريبي: السلام عليكم أبحث عن شقة تمليك 180م في مكرم عبيد في حدود 5.2 مليون',
        '29/10/2026, 4:15 م - سمسار طلبك: أهلاً بحضرتك متاح خيار ممتاز في مكرم عبيد',
      ].join('\n'),
    },
  })).json();
  assert.equal(convImport.match_status, 'unmatched_review');
  assert.equal(convImport.contact_id, null);

  const oppCreateRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'case1-contactless-opp-0001',
    body: {
      conversation_id: convImport.conversation_id,
      lead_label: '🟢 مشتري تجريبي بدون رقم — مكرم عبيد',
      track: 'sale_apt',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 4800000,
      budget_max: 5500000,
      size_min_m2: 170,
      size_max_m2: 195,
      next_action: 'إرسال تفاصيل الشقة عبر المحادثة',
      next_followup_at: '2026-10-30T10:00:00Z',
    },
  });
  assert.equal(oppCreateRes.status, 201);
  const created = await oppCreateRes.json();
  assert.equal(created.contact_id, null, 'Must NOT create a fake contact');
  assert.equal(created.conversation_id, convImport.conversation_id);

  // Full workflow operability: list, detail, dashboard, followups, matches, activity log, spec update
  const listJson = await (await call('/api/opportunities?q=مشتري تجريبي')).json();
  assert.equal(listJson.opportunities.length, 1);
  assert.equal(listJson.opportunities[0].contact_completeness, 'unlinked_opportunity');

  const detailJson = await (await call(`/api/opportunities/${created.opportunity_id}`)).json();
  assert.equal(detailJson.opportunity.contact_id, null);
  assert.equal(detailJson.opportunity.conversation_id, convImport.conversation_id);
  assert.equal(detailJson.phones.length, 0);
  assert.equal(detailJson.conversations.length, 1);

  const matchJson = await (await call(`/api/opportunities/${created.opportunity_id}/matches`)).json();
  assert.ok(matchJson.listings.some(l => l.external_id === 'unit-nasr-201'), 'Matches site listings even without contact_id');

  const dashJson = await (await call('/api/dashboard?day=2026-10-30')).json();
  assert.equal(dashJson.counts.active, 1);
  assert.equal(dashJson.counts.due_today, 1);
  assert.equal(dashJson.counts.contactless_opportunities, 1);

  const actRes = await call(`/api/opportunities/${created.opportunity_id}/activities`, {
    method: 'POST',
    key: 'case1-contactless-activity-01',
    body: {
      activity_type: 'whatsapp_note',
      summary: 'تم إرسال العرض عبر المحادثة وبانتظار الرقم للتنسيق',
      next_action: 'انتظار رد العميل بالرقم',
      next_followup_at: '2026-10-31T14:00:00Z',
    },
  });
  assert.equal(actRes.status, 200);

  const after = snapshotCounts(sqlite);
  assert.equal(after.contacts, 0, 'Zero fake contacts created');
  assert.equal(after.phones, 0, 'Zero fake phones invented');
  assert.equal(after.opportunities, 1);
  assert.equal(after.conversations, 1);
  assert.equal(after.messages, 2);
  sqlite.close();
});

test('Mandatory Case 2: conversation without a contact (contact_id = NULL) preserves full messages, stays unmatched_review, and is searchable & readable', async () => {
  const { sqlite, call } = await createDecoupledTestEnv();
  const before = snapshotCounts(sqlite);
  assert.equal(before.conversations, 0);
  assert.equal(before.contacts, 0);

  const rawChat = [
    '28/10/2026, 1:05 م - @nasr_seeker_test: مساء الخير عايز شقة إيجار جديد في عباس العقاد، للتواصل مع الحارس 01099887766',
    '28/10/2026, 1:12 م - سمسار طلبك: أهلاً بحضرتك متاح شقة 160م أول سكن',
    '28/10/2026, 1:15 م - @nasr_seeker_test: ممتاز ابعتلي التفاصيل من فضلك',
  ].join('\n');

  const imp = await (await call('/api/conversations/import', {
    method: 'POST',
    body: {
      chat_title: '🔵 دردشة مع @nasr_seeker_test عباس العقاد',
      source_ref: 'synthetic_zip_test.zip',
      raw_text: rawChat,
    },
  })).json();
  assert.equal(imp.match_status, 'unmatched_review');
  assert.equal(imp.contact_id, null);

  // Searchable in unmatched_review tab by @username and by message content
  const searchByHandle = await (await call('/api/conversations?match_status=unmatched_review&q=nasr_seeker_test')).json();
  assert.equal(searchByHandle.conversations.length, 1);
  assert.equal(searchByHandle.conversations[0].id, imp.conversation_id);

  const searchByBody = await (await call('/api/conversations?match_status=unmatched_review&q=أول سكن')).json();
  assert.equal(searchByBody.conversations.length, 1);

  // Readable in full with exact message count and raw_text preserved
  const detail = await (await call(`/api/conversations/${imp.conversation_id}`)).json();
  assert.equal(detail.conversation.contact_id, null);
  assert.equal(detail.conversation.match_status, 'unmatched_review');
  assert.equal(detail.conversation.raw_text, rawChat);
  assert.equal(detail.messages.length, 3);

  const after = snapshotCounts(sqlite);
  assert.equal(after.contacts, 0, 'Must NOT auto-create contact from @username, chat title, or body phone');
  assert.equal(after.phones, 0, 'Must NOT auto-attribute phone numbers mentioned inside chat body');
  assert.equal(after.conversations, 1);
  assert.equal(after.unmatched_review, 1);
  assert.equal(after.messages, 3);
  sqlite.close();
});

test('Mandatory Case 3: contact without an opportunity supports explicit 3-tier classification (complete vs incomplete needs-review)', async () => {
  const { sqlite, call } = await createDecoupledTestEnv();
  const before = snapshotCounts(sqlite);
  assert.equal(before.contacts, 0);
  assert.equal(before.opportunities, 0);

  // Tier 1: Complete contact (name + verified phone) without any opportunity
  const compRes = await call('/api/contacts', {
    method: 'POST',
    key: 'case3-complete-contact-01',
    body: { name: 'عميل مكتمل بلا فرصة تجريبي', phones: [{ phone: '01012340001', label: 'أساسي', is_primary: true }] },
  });
  assert.equal(compRes.status, 201);
  const compBody = await compRes.json();
  assert.equal(compBody.completeness_status, 'complete');
  assert.equal(compBody.needs_review, false);

  // Tier 2: Incomplete contact (name/chat handle without phone) without any opportunity -> flagged for review
  const incRes = await call('/api/contacts', {
    method: 'POST',
    key: 'case3-incomplete-contact-01',
    body: { name: 'عميل معرف محادثة غير مكتمل تجريبي', phones: [] },
  });
  assert.equal(incRes.status, 201);
  const incBody = await incRes.json();
  assert.equal(incBody.completeness_status, 'incomplete');
  assert.equal(incBody.needs_review, true);

  const onlyComplete = await (await call('/api/contacts?completeness=complete')).json();
  assert.equal(onlyComplete.contacts.length, 1);
  assert.equal(onlyComplete.contacts[0].id, compBody.contact_id);
  assert.equal(onlyComplete.contacts[0].opportunity_count, 0);

  const onlyIncomplete = await (await call('/api/contacts?completeness=incomplete')).json();
  assert.equal(onlyIncomplete.contacts.length, 1);
  assert.equal(onlyIncomplete.contacts[0].id, incBody.contact_id);
  assert.equal(onlyIncomplete.contacts[0].needs_review, true);

  const after = snapshotCounts(sqlite);
  assert.equal(after.contacts, 2);
  assert.equal(after.phones, 1);
  assert.equal(after.opportunities, 0);
  sqlite.close();
});

test('Mandatory Case 4: restoring opportunities by original ID preserves track/status/notes/activities/properties without duplication', async () => {
  const { sqlite, db, call } = await createDecoupledTestEnv();
  const before = snapshotCounts(sqlite);
  assert.equal(before.opportunities, 0);

  const restoreBundle = {
    conversations: [
      {
        title: 'دردشة واتساب مع 🟢 عميل مستعاد تجريبي 1',
        source_ref: 'synthetic_restore_1.zip',
        raw_txt: '25/10/2026, 2:00 م - عميل مستعاد 1: مطلوب شقة 180م في مكرم عبيد',
      },
      {
        title: 'دردشة واتساب مع 🟡 شركة مقر إداري مستعاد 2',
        source_ref: 'synthetic_restore_2.zip',
        raw_txt: '26/10/2026, 3:00 م - شركة مستعاد 2: نبحث عن مقر إداري 220م بعباس العقاد',
      },
    ],
    restore_opportunities: [
      {
        id: 'orig-opp-backup-uuid-0001',
        lead_label: '🟢 عميل مستعاد تجريبي 1',
        track: 'sale_apt',
        intent: 'buy',
        source: 'whatsapp',
        status: 'negotiating',
        area_label: 'مكرم عبيد',
        property_type: 'شقة',
        budget_min: 5000000,
        budget_max: 5500000,
        notes: 'ملاحظات أصلية محفوظة من النسخة الاحتياطية',
        next_action: 'متابعة التفاوض على السعر',
        next_followup_at: '2026-10-31T12:00:00Z',
        activities: [
          {
            id: 'orig-act-backup-0001',
            activity_type: 'whatsapp_note',
            summary: 'سجل نشاط أصلي مستعاد بالكامل',
            created_at: '2026-10-25T14:05:00Z',
          },
        ],
        opportunity_properties: [
          {
            id: 'orig-prop-backup-0001',
            listing_id: 201,
            presentation_status: 'selected',
            notes: 'عقار مرتبط أصلي',
            created_at: '2026-10-25T14:10:00Z',
          },
        ],
      },
      {
        id: 'orig-opp-backup-uuid-0002',
        lead_label: '🟡 شركة مقر إداري مستعاد 2',
        track: 'admin_hq',
        intent: 'rent',
        source: 'whatsapp',
        status: 'active',
        area_label: 'عباس العقاد',
        property_type: 'مقر إداري',
        notes: 'طلب مقر شركة',
        next_action: 'إرسال بدائل إدارية',
        next_followup_at: '2026-11-01T11:00:00Z',
        activities: [
          {
            id: 'orig-act-backup-0002',
            activity_type: 'note',
            summary: 'توثيق أولي للطلب الإداري',
            created_at: '2026-10-26T15:00:00Z',
          },
        ],
        opportunity_properties: [],
      },
    ],
  };

  // Run 1: Restores both opportunities with original IDs, zero fake contacts, linked to conversations
  const run1 = await runSourceSyncBundle(db, restoreBundle, { now: new Date('2026-10-30T12:00:00Z') });
  assert.equal(run1.ok, true);
  assert.equal(run1.restoration_manifest.opportunities_requested, 2);
  assert.equal(run1.restoration_manifest.opportunities_restored, 2);
  assert.equal(run1.restoration_manifest.opportunities_already_present, 0);
  assert.equal(run1.restoration_manifest.opportunities_linked_to_conversation, 2);
  assert.equal(run1.restoration_manifest.opportunities_contactless_independent, 2);
  assert.equal(run1.restoration_manifest.unrestored_records.length, 0);

  const mid = snapshotCounts(sqlite);
  assert.equal(mid.contacts, 0, 'Zero fake contacts created during opportunity restoration');
  assert.equal(mid.phones, 0, 'Zero fake phones invented');
  assert.equal(mid.opportunities, 2);
  assert.equal(mid.activities, 2);
  assert.equal(mid.opportunity_properties, 1);

  const restoredDetail = await (await call('/api/opportunities/orig-opp-backup-uuid-0001')).json();
  assert.equal(restoredDetail.opportunity.id, 'orig-opp-backup-uuid-0001');
  assert.equal(restoredDetail.opportunity.track, 'sale_apt');
  assert.equal(restoredDetail.opportunity.status, 'negotiating');
  assert.equal(restoredDetail.opportunity.notes, 'ملاحظات أصلية محفوظة من النسخة الاحتياطية');
  assert.equal(restoredDetail.activities.length, 1);
  assert.equal(restoredDetail.properties.length, 1);
  assert.equal(restoredDetail.conversations.length, 1);

  // Run 2: Re-running exact same restore bundle creates ZERO duplicates!
  const run2 = await runSourceSyncBundle(db, restoreBundle, { now: new Date('2026-10-30T12:05:00Z') });
  assert.equal(run2.ok, true);
  assert.equal(run2.restoration_manifest.opportunities_restored, 0);
  assert.equal(run2.restoration_manifest.opportunities_already_present, 2);
  assert.equal(run2.restoration_manifest.opportunity_activities_restored, 0);
  assert.equal(run2.restoration_manifest.opportunity_properties_restored, 0);

  const after = snapshotCounts(sqlite);
  assert.deepEqual(after, mid, 'Before vs After Run 2 counts must be 100% identical (zero duplication)');
  sqlite.close();
});

test('Mandatory Case 5: importing and re-importing 21 unlinked conversations creates zero duplicates and preserves exact message totals', async () => {
  const { sqlite, db, call } = await createDecoupledTestEnv();
  const before = snapshotCounts(sqlite);
  assert.equal(before.conversations, 0);
  assert.equal(before.messages, 0);

  const synthetic21 = Array.from({ length: 21 }, (_, idx) => {
    const n = idx + 1;
    const prefix = idx < 19 ? '🟢' : '✈️';
    const msgCount = (idx % 4) + 2; // deterministic message counts summing to 74 messages
    const lines = Array.from({ length: msgCount }, (__, mIdx) => (
      `28/10/2026, 10:${String(10 + mIdx).padStart(2, '0')} ص - طرف تجريبي ${n}: رسالة رقم ${mIdx + 1} في المحادثة التجريبية ${n}`
    ));
    return {
      title: `دردشة واتساب مع ${prefix} محادثة غير مربوطة تجريبية رقم ${n}`,
      source_ref: `synthetic_unmatched_${String(n).padStart(2, '0')}.zip`,
      raw_txt: lines.join('\n'),
      expected_msgs: msgCount,
    };
  });
  const expectedTotalMessages = synthetic21.reduce((acc, c) => acc + c.expected_msgs, 0);

  // Run 1: Import all 21 conversations
  const run1 = await runSourceSyncBundle(db, { conversations: synthetic21 }, { now: new Date('2026-10-30T12:00:00Z') });
  assert.equal(run1.ok, true);
  assert.equal(run1.diff.conversations_unmatched_review, 21);
  assert.equal(run1.intelligence.conversations_created, 21);
  assert.equal(run1.intelligence.messages_stored, expectedTotalMessages);

  const afterRun1 = snapshotCounts(sqlite);
  assert.equal(afterRun1.contacts, 0, 'Zero auto-created contacts');
  assert.equal(afterRun1.conversations, 21);
  assert.equal(afterRun1.unmatched_review, 21);
  assert.equal(afterRun1.messages, expectedTotalMessages);

  // Verify unmatched_review API returns all 21 and supports search
  const unmatchedRes = await (await call('/api/conversations?match_status=unmatched_review')).json();
  assert.equal(unmatchedRes.conversations.length, 21);
  const searched = await (await call('/api/conversations?match_status=unmatched_review&q=المحادثة التجريبية 17')).json();
  assert.equal(searched.conversations.length, 1);

  // Run 2: Re-import exact same 21 conversations -> zero duplicates!
  const run2 = await runSourceSyncBundle(db, { conversations: synthetic21 }, { now: new Date('2026-10-30T12:10:00Z') });
  assert.equal(run2.ok, true);
  assert.equal(run2.intelligence.conversations_created, 0);
  assert.equal(run2.intelligence.conversations_incremental_skipped, 21);

  const afterRun2 = snapshotCounts(sqlite);
  assert.deepEqual(afterRun2, afterRun1, 'Re-importing all 21 conversations produces zero duplicate conversations or messages');
  sqlite.close();
});

test('Mandatory Case 6: linking an unlinked conversation to a contact after adding a verified phone upgrades both conversation and opportunity', async () => {
  const { sqlite, call } = await createDecoupledTestEnv();

  // 1) Create an incomplete contact (without phone) + an unlinked conversation + a contactless opportunity
  const incContact = await (await call('/api/contacts', {
    method: 'POST',
    key: 'case6-inc-contact-01',
    body: { name: 'عميل قيد التوثيق تجريبي', phones: [] },
  })).json();

  const conv = await (await call('/api/conversations/import', {
    method: 'POST',
    body: {
      chat_title: '🟢 عميل قيد التوثيق تجريبي',
      raw_text: '29/10/2026, 6:00 م - عميل قيد التوثيق: عايز أحدد معاينة شقة مكرم عبيد غدًا',
    },
  })).json();

  const opp = await (await call('/api/opportunities', {
    method: 'POST',
    key: 'case6-contactless-opp-01',
    body: {
      conversation_id: conv.conversation_id,
      lead_label: '🟢 عميل قيد التوثيق تجريبي',
      track: 'sale_apt',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      next_action: 'تأكيد الهاتف والمعاينة',
      next_followup_at: '2026-10-31T10:00:00Z',
    },
  })).json();

  const before = snapshotCounts(sqlite);
  assert.equal(before.contacts, 1);
  assert.equal(before.phones, 0);
  assert.equal(before.unmatched_review, 1);

  // 2) Attempting to resolve unmatched_review onto a phoneless contact BEFORE verified phone is rejected
  const prematureLink = await call(`/api/conversations/${conv.conversation_id}/link-contact`, {
    method: 'POST',
    body: { contact_id: incContact.contact_id },
  });
  assert.equal(prematureLink.status, 400);
  const prematureJson = await prematureLink.json();
  assert.equal(prematureJson.error, 'verified_phone_required_before_linking');

  // 3) Add verified phone to the contact -> becomes complete -> link conversation succeeds and upgrades opportunity!
  const addPhRes = await call(`/api/contacts/${incContact.contact_id}/phones`, {
    method: 'POST',
    body: { phone: '01066778899', label: 'واتساب موثق', is_primary: true },
  });
  assert.equal(addPhRes.status, 200);

  const linkRes = await call(`/api/conversations/${conv.conversation_id}/link-contact`, {
    method: 'POST',
    body: { contact_id: incContact.contact_id },
  });
  assert.equal(linkRes.status, 200);
  const linkJson = await linkRes.json();
  assert.equal(linkJson.contact_id, incContact.contact_id);
  assert.equal(linkJson.opportunity_id, opp.opportunity_id);

  const after = snapshotCounts(sqlite);
  assert.equal(after.contacts, 1);
  assert.equal(after.phones, 1);
  assert.equal(after.opportunities, 1);
  assert.equal(after.conversations, 1);
  assert.equal(after.unmatched_review, 0, 'Conversation graduated out of unmatched_review into resolved_manual');

  const oppDetail = await (await call(`/api/opportunities/${opp.opportunity_id}`)).json();
  assert.equal(oppDetail.opportunity.contact_id, incContact.contact_id, 'Attached opportunity upgraded to verified contact');
  assert.equal(oppDetail.opportunity.contact_completeness, 'complete');
  sqlite.close();
});

test('Mandatory Case 7: archiving or deleting a contact NEVER deletes its linked opportunity or conversation', async () => {
  const { sqlite, call } = await createDecoupledTestEnv();

  // Create complete contact + linked opportunity + activity + linked conversation
  const oppRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'case7-decoupled-opp-01',
    body: {
      name: 'عميل اختبار فصل الحذف والأرشفة',
      phone: '01277889900',
      track: 'sale_apt',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      notes: 'فرصة حقيقية يجب ألا تُحذف أبداً عند حذف جهة الاتصال',
      next_action: 'متابعة العرض',
      next_followup_at: '2026-10-31T15:00:00Z',
    },
  });
  assert.equal(oppRes.status, 201);
  const { contact_id: contactId, opportunity_id: oppId } = await oppRes.json();

  const convRes = await (await call('/api/conversations/import', {
    method: 'POST',
    body: {
      contact_id: contactId,
      opportunity_id: oppId,
      chat_title: '🟢 عميل اختبار فصل الحذف والأرشفة',
      raw_text: [
        '29/10/2026, 7:00 م - عميل: مهتم بشقة مكرم عبيد ومحتاج معاينة يوم السبت',
        '29/10/2026, 7:05 م - سمسار طلبك: تمام يا فندم نرتب الموعد',
      ].join('\n'),
    },
  })).json();

  const before = snapshotCounts(sqlite);
  assert.equal(before.contacts, 1);
  assert.equal(before.phones, 1);
  assert.equal(before.opportunities, 1);
  assert.equal(before.activities, 1);
  assert.equal(before.conversations, 1);
  assert.equal(before.messages, 2);

  // Step A: Archive the contact -> hidden from default active contacts list, visible in ?completeness=archived, opp & conv 100% intact
  const archRes = await call(`/api/contacts/${contactId}/archive`, { method: 'POST', body: {} });
  assert.equal(archRes.status, 200);
  const archJson = await archRes.json();
  assert.equal(archJson.archived, true);
  assert.equal(archJson.opportunities_preserved, 1);
  assert.equal(archJson.conversations_preserved, 1);

  const activeContacts = await (await call('/api/contacts')).json();
  assert.equal(activeContacts.contacts.length, 0);
  const archivedContacts = await (await call('/api/contacts?completeness=archived')).json();
  assert.equal(archivedContacts.contacts.length, 1);
  assert.equal(archivedContacts.contacts[0].completeness_status, 'archived');

  // Step B: Delete the contact -> contact & phone removed, opportunity & conversation & messages 100% preserved and operable!
  const delRes = await call(`/api/contacts/${contactId}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const delJson = await delRes.json();
  assert.equal(delJson.ok, true);
  assert.equal(delJson.detached_opportunities, 1);
  assert.equal(delJson.detached_conversations, 1);

  const after = snapshotCounts(sqlite);
  assert.equal(after.contacts, 0, 'Contact row deleted');
  assert.equal(after.phones, 0, 'Contact phones deleted');
  assert.equal(after.opportunities, 1, 'Opportunity MUST NOT be deleted');
  assert.equal(after.activities, 1, 'Opportunity activities MUST NOT be deleted');
  assert.equal(after.conversations, 1, 'Conversation MUST NOT be deleted');
  assert.equal(after.messages, 2, 'Conversation messages MUST NOT be deleted');
  assert.equal(after.unmatched_review, 1, 'Detached conversation safely moved to unmatched_review');

  const survivingOpp = await (await call(`/api/opportunities/${oppId}`)).json();
  assert.equal(survivingOpp.opportunity.id, oppId);
  assert.equal(survivingOpp.opportunity.contact_id, null);
  assert.equal(survivingOpp.opportunity.contact_name, 'عميل اختبار فصل الحذف والأرشفة');
  assert.equal(survivingOpp.opportunity.notes, 'فرصة حقيقية يجب ألا تُحذف أبداً عند حذف جهة الاتصال');

  const survivingConv = await (await call(`/api/conversations/${convRes.conversation_id}`)).json();
  assert.equal(survivingConv.conversation.id, convRes.conversation_id);
  assert.equal(survivingConv.conversation.contact_id, null);
  assert.equal(survivingConv.conversation.match_status, 'unmatched_review');
  assert.equal(survivingConv.messages.length, 2);
  sqlite.close();
});
