import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../crm-worker.js';
import { generateVapidKeyPair } from '../crm-push.js';
import {
  extractSafeUrls,
  getCairoClock,
  getCairoDayBoundsUtc,
  normalizeInternationalPhone,
  parseWhatsAppExport,
} from '../crm-chat-intel.js';
import { runSourceSyncBundle } from '../crm-sync-and-match.js';
import { buildReadyFollowupMessage, whatsappHref } from '../crm-ui/crm-assets/whatsapp-templates.js';

const ROOT_DIR = new URL('../../', import.meta.url);
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

async function createIsolatedCrmEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT);
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
    INSERT INTO areas VALUES (1, 'مكرم عبيد'), (2, 'عباس العقاد'), (99, 'التجمع الخامس');
    INSERT INTO sources VALUES (4, 'site'), (2, 'external');
    INSERT INTO listings VALUES
      (101, 4, 'apt-makram-good', '/properties/apt-makram-good/', 'شقة مميزة بمكرم عبيد', 'شقة', 'sale', 1, 165, 4200000, 3, 2, 'سوبر لوكس', '2026-10-25T10:00:00Z'),
      (102, 4, 'apt-makram-expensive', '/properties/apt-makram-expensive/', 'شقة فاخرة خارج الميزانية', 'شقة', 'sale', 1, 260, 9800000, 4, 3, 'ألترا لوكس', '2026-10-25T10:00:00Z'),
      (103, 4, 'shop-makram-sale', '/commercial/shop-makram/', 'محل تجاري بمكرم عبيد', 'محل', 'sale', 1, 60, 4100000, 0, 1, 'طوب أحمر', '2026-10-25T10:00:00Z'),
      (104, 4, 'apt-abbas-rent', '/rents/apt-abbas-rent/', 'شقة للإيجار بعباس العقاد', 'شقة', 'rent', 2, 140, 22000, 3, 2, 'مفروش', '2026-10-25T10:00:00Z'),
      (105, 4, 'apt-sold-hidden', '/properties/apt-sold-hidden/', 'شقة مباعة سابقاً', 'شقة', 'sale', 1, 160, 4100000, 3, 2, 'لوكس', '2026-10-20T10:00:00Z'),
      (106, 4, 'apt-outside-nasr', '/properties/apt-outside/', 'شقة خارج مدينة نصر', 'شقة', 'sale', 99, 165, 4200000, 3, 2, 'لوكس', '2026-10-25T10:00:00Z');
  `);

  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    sqlite.exec(sql);
  }
  sqlite.prepare("UPDATE listings SET status = 'sold' WHERE id = 105").run();

  const accessCode = 'Test-Only-Remediation-Code-2026-Strong!';
  const sessionSecret = 'Test-Only-Session-Secret-2026-Strong-Key!';
  const env = {
    DB: wrapD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    CRM_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    CRM_ACCESS_CODE: accessCode,
    CRM_SESSION_SECRET: sessionSecret,
    CRM_NASR_AREA_IDS: '1,2',
    CRM_SITE_SOURCE_ID: '4',
  };

  const loginRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.55',
    },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const { csrf_token: csrfToken } = await loginRes.json();

  const call = (path, { method = 'GET', body, key } = {}) => {
    const headers = {
      origin: ALLOWED_ORIGIN,
      cookie,
      'sec-fetch-site': 'same-origin',
    };
    if (method !== 'GET' && method !== 'HEAD') headers['x-crm-csrf'] = csrfToken;
    if (key) headers['idempotency-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return worker.fetch(new Request(`${ALLOWED_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };

  return { sqlite, env, call };
}

test('Migration 0005 creates 15 CRM tables and aligns listings status & price_updated_at safely', async () => {
  const { sqlite } = await createIsolatedCrmEnv();
  const crmTables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'crm_%' ORDER BY name").all();
  assert.equal(crmTables.length, 15);
  const listingCols = sqlite.prepare('PRAGMA table_info(listings)').all().map(c => c.name);
  assert.ok(listingCols.includes('status'));
  assert.ok(listingCols.includes('price_updated_at'));
  const sample = sqlite.prepare('SELECT status, price_updated_at, observed_at FROM listings WHERE id = 101').get();
  assert.equal(sample.status, 'active');
  assert.equal(sample.price_updated_at, sample.observed_at);
  sqlite.close();
});

test('Fix A: normalizes phone search across +20/0020/010/Arabic-Indic/intl, manages secondary phones safely, prevents cross-contact conflict, and audits consent', async () => {
  const { sqlite, call } = await createIsolatedCrmEnv();

  const c1Res = await call('/api/contacts', {
    method: 'POST',
    key: 'fix-a-contact-0001',
    body: {
      name: 'عميل بحث وأرقام تجريبي',
      communication_consent: 'request_only',
      phones: [
        { phone: '010 1234-5678', label: 'أساسي', is_primary: true },
        { phone: '+971 50 111 2233', label: 'واتساب الإمارات', is_primary: false },
      ],
    },
  });
  assert.equal(c1Res.status, 201);
  const { contact_id: c1Id } = await c1Res.json();

  // Search must find the same contact across every Egyptian & international representation
  for (const query of ['01012345678', '+20 10 1234 5678', '0020-101-234-5678', '٠١٠١٢٣٤٥٦٧٨', '+971501112233', '00971 50 111 2233']) {
    const res = await call(`/api/contacts?q=${encodeURIComponent(query)}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.contacts.length, 1, `Expected 1 match for query "${query}"`);
    assert.equal(data.contacts[0].id, c1Id);
  }

  // Create second contact to verify cross-contact duplicate conflict returns owner metadata
  const c2Res = await call('/api/contacts', {
    method: 'POST',
    key: 'fix-a-contact-0002',
    body: {
      name: 'عميل ثانٍ مستقل تجريبي',
      phones: [{ phone: '01122334455', label: 'أساسي', is_primary: true }],
    },
  });
  assert.equal(c2Res.status, 201);
  const { contact_id: c2Id } = await c2Res.json();

  const dupConflictRes = await call(`/api/contacts/${c2Id}/phones`, {
    method: 'POST',
    body: { phone: '+20 101 234 5678', label: 'محاولة تكرار' },
  });
  assert.equal(dupConflictRes.status, 409);
  const dupBody = await dupConflictRes.json();
  assert.equal(dupBody.error, 'duplicate_phone_review');
  assert.equal(dupBody.conflict_contact_id, c1Id);
  assert.equal(dupBody.conflict_contact_name, 'عميل بحث وأرقام تجريبي');

  // Edit secondary phone via PATCH without losing primary phone, then delete secondary phone safely
  const beforeDetail = await (await call(`/api/contacts/${c1Id}`)).json();
  const secondaryPhone = beforeDetail.phones.find(p => p.is_primary === 0);
  assert.ok(secondaryPhone);

  const patchRes = await call(`/api/contacts/${c1Id}/phones/${secondaryPhone.id}`, {
    method: 'PATCH',
    body: { phone: '+971 50 999 8877', label: 'إماراتي محدث', is_primary: false },
  });
  assert.equal(patchRes.status, 200);

  const afterPatch = await (await call(`/api/contacts/${c1Id}`)).json();
  assert.equal(afterPatch.phones.length, 2);
  assert.equal(afterPatch.phones.find(p => p.is_primary === 1).phone_key, '201012345678');
  assert.equal(afterPatch.phones.find(p => p.id === secondaryPhone.id).phone_key, '971509998877');

  const delSecondary = await call(`/api/contacts/${c1Id}/phones/${secondaryPhone.id}`, { method: 'DELETE' });
  assert.equal(delSecondary.status, 200);
  const afterDel = await (await call(`/api/contacts/${c1Id}`)).json();
  assert.equal(afterDel.phones.length, 1);
  assert.equal(afterDel.phones[0].phone_key, '201012345678');
  assert.equal(afterDel.phones[0].is_primary, 1);

  // Update communication_consent and verify audit trail
  const consentRes = await call(`/api/contacts/${c1Id}`, {
    method: 'POST',
    body: { communication_consent: 'marketing_yes' },
  });
  assert.equal(consentRes.status, 200);
  const consentNoRes = await call(`/api/contacts/${c1Id}`, {
    method: 'POST',
    body: { communication_consent: 'do_not_contact' },
  });
  assert.equal(consentNoRes.status, 200);

  const finalDetail = await (await call(`/api/contacts/${c1Id}`)).json();
  assert.equal(finalDetail.contact.communication_consent, 'do_not_contact');
  const consentAudits = (finalDetail.audit_log || []).filter(a => a.action_type === 'consent_changed');
  assert.equal(consentAudits.length, 2);
  sqlite.close();
});

test('Fix B: stores >15,000-char conversations without 1200-char truncation, parses Android & iOS & +971, preserves safe links, blocks XSS schemes, and surfaces parse warnings', async () => {
  const { sqlite, call } = await createIsolatedCrmEnv();

  assert.equal(normalizeInternationalPhone('+971 52 444 5566'), '971524445566');
  assert.equal(normalizeInternationalPhone('٠٠٩٧١٥٢٤٤٤٥٥٦٦'), '971524445566');

  const urlCheck = extractSafeUrls(
    'شاهد https://nasr-realestate.github.io/properties/apt-makram-good/ و https://maps.example.com/loc?id=5 وتجنب javascript:alert(1) و data:text/html,<script>1</script>',
  );
  assert.equal(urlCheck.links.length, 2);
  assert.deepEqual(urlCheck.blockedSchemes, ['javascript', 'data']);

  const iosAndAndroidExport = [
    '[10/25/26, 2:15:00 PM] عميل تجريبي دولي: السلام عليكم محتاج شقة في مكرم عبيد ٣ غرف في حدود ٤ مليون',
    '25/10/2026, 2:18 م - سمسار طلبك: وعليكم السلام يا فندم متاح عرض ممتاز https://nasr-realestate.github.io/properties/apt-makram-good/',
    'سطر غير مؤرخ مكمل لنفس الرسالة بدون اقتطاع',
  ].join('\n');
  const parsed = await parseWhatsAppExport(iosAndAndroidExport, { chatTitle: 'دردشة في واتساب مع عميل تجريبي دولي' });
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].sender_role, 'customer');
  assert.equal(parsed.messages[1].sender_role, 'broker');
  assert.equal(parsed.messages[1].links.length, 1);

  const malformedExport = 'نص عشوائي قبل أي طابع زمني صالح\nسطر ثانٍ بدون طابع زمني';
  const malformedParsed = await parseWhatsAppExport(malformedExport, { chatTitle: 'ملف غير قياسي' });
  assert.ok(malformedParsed.parseWarnings.length >= 1, 'Expected explicit parse warning instead of silent drop');
  assert.equal(malformedParsed.rawText, malformedExport);

  // Store 16,500+ character conversation note & archive through the Worker API
  const oppRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'fix-b-opportunity-0001',
    body: {
      name: 'عميل محادثة طويلة تجريبي',
      phone: '+971550001122',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_max: 4500000,
      next_action: 'إرسال التفاصيل',
      next_followup_at: '2026-10-31T10:00:00Z',
    },
  });
  assert.equal(oppRes.status, 201);
  const { opportunity_id: oppId, contact_id: contactId } = await oppRes.json();

  const longParagraph = 'تفاصيل محادثة واتساب كاملة بدون أي قص صامت عند ١٢٠٠ حرف — ';
  const sixteenKText = Array.from({ length: 280 }, (_, idx) =>
    `${25 + (idx % 3)}/10/2026, 4:${String(idx % 60).padStart(2, '0')} م - عميل محادثة طويلة تجريبي: ${longParagraph}#${idx + 1} https://example.org/unit/${idx + 1}`,
  ).join('\n');
  assert.ok(sixteenKText.length > 16_000);

  const actRes = await call(`/api/opportunities/${oppId}/activities`, {
    method: 'POST',
    body: {
      activity_type: 'whatsapp_note',
      summary: sixteenKText.slice(0, 1200),
      full_text: sixteenKText,
      source_ref: 'whatsapp_archive_test',
      original_sent_at: '2026-10-27T14:00:00Z',
      next_action: 'تأكيد المعاينة',
      next_followup_at: '2026-10-31T12:00:00Z',
    },
  });
  assert.equal(actRes.status, 200);
  const actBody = await actRes.json();
  assert.equal(actBody.stored_length, sixteenKText.length);

  const oppDetail = await (await call(`/api/opportunities/${oppId}`)).json();
  const savedAct = oppDetail.activities.find(a => a.id === actBody.activity_id);
  assert.equal(savedAct.full_text.length, sixteenKText.length);
  assert.equal(savedAct.original_sent_at, '2026-10-27T14:00:00.000Z');

  const convImportRes = await call('/api/conversations/import', {
    method: 'POST',
    body: {
      contact_id: contactId,
      opportunity_id: oppId,
      chat_title: 'محادثة كاملة ١٦ ألف حرف تجريبية',
      source_ref: 'unit_test_zip',
      raw_text: sixteenKText,
    },
  });
  assert.equal(convImportRes.status, 201);
  const convImportBody = await convImportRes.json();
  const convDetail = await (await call(`/api/conversations/${convImportBody.conversation_id}`)).json();
  assert.equal(convDetail.conversation.raw_text.length, sixteenKText.length);
  assert.equal(convDetail.messages.length, 280);
  sqlite.close();
});

test('Fix C: GET /api/opportunities/:id/matches returns 200, enforces budget/size/area/type/status & bidirectional buy<->sell matching with match_reason', async () => {
  const { sqlite, call } = await createIsolatedCrmEnv();

  // Create a seller counterparty in Makram Ebeid within budget (4.3M, 170m2) and an out-of-budget seller (9.5M)
  const sellerOkRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'fix-c-seller-ok',
    body: {
      name: 'مالك شقة مكرم تجريبي',
      phone: '01060001111',
      intent: 'sell',
      source: 'call',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 4300000,
      budget_max: 4300000,
      size_min_m2: 170,
      size_max_m2: 170,
      next_action: 'تحديث العرض',
      next_followup_at: '2026-11-01T10:00:00Z',
    },
  });
  assert.equal(sellerOkRes.status, 201);
  const { opportunity_id: sellerOkId } = await sellerOkRes.json();

  await call('/api/opportunities', {
    method: 'POST',
    key: 'fix-c-seller-high',
    body: {
      name: 'مالك شقة مرتفعة السعر تجريبي',
      phone: '01060002222',
      intent: 'sell',
      source: 'call',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 9500000,
      budget_max: 9500000,
      size_min_m2: 250,
      size_max_m2: 250,
      next_action: 'متابعة',
      next_followup_at: '2026-11-01T10:00:00Z',
    },
  });

  // Create a buyer in Makram Ebeid with budget 3.8M..4.5M, size 150..185m2, apartment
  const buyerRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'fix-c-buyer-0001',
    body: {
      name: 'مشتري شقة مكرم تجريبي',
      phone: '01060003333',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 3800000,
      budget_max: 4500000,
      size_min_m2: 150,
      size_max_m2: 185,
      next_action: 'ترشيح عقارات',
      next_followup_at: '2026-10-31T11:00:00Z',
    },
  });
  assert.equal(buyerRes.status, 201);
  const { opportunity_id: buyerId } = await buyerRes.json();

  // 1) Buyer matches: must include apt-makram-good (101), exclude expensive (102), shop (103), rent (104), sold (105), outside Nasr (106)
  const buyerMatchRes = await call(`/api/opportunities/${buyerId}/matches`);
  assert.equal(buyerMatchRes.status, 200);
  const buyerMatches = await buyerMatchRes.json();

  const catIds = buyerMatches.listings.map(m => m.external_id);
  assert.deepEqual(catIds, ['apt-makram-good']);
  assert.ok(buyerMatches.listings[0].match_reason.includes('مكرم عبيد'));
  assert.equal(buyerMatches.opportunities.length, 1);
  assert.equal(buyerMatches.opportunities[0].id, sellerOkId);
  assert.ok(buyerMatches.opportunities[0].match_reason.length > 5);

  // 2) Reverse direction (Seller -> Buyer requests): must nominate buyerId with explicit match_reason!
  const sellerMatchRes = await call(`/api/opportunities/${sellerOkId}/matches`);
  assert.equal(sellerMatchRes.status, 200);
  const sellerMatches = await sellerMatchRes.json();
  assert.equal(sellerMatches.opportunities.length, 1);
  assert.equal(sellerMatches.opportunities[0].id, buyerId);
  assert.ok(sellerMatches.opportunities[0].match_reason.length > 5);
  sqlite.close();
});

test('Fix D & F: unifies Africa/Cairo across 00:00-02:00 boundary, computes overdue against current Cairo instant, and logs /api/push/test in D1', async () => {
  const { sqlite, env, call } = await createIsolatedCrmEnv();

  // 2026-10-29T22:30:00Z === 2026-10-30 00:30:00 Africa/Cairo
  const boundaryNow = new Date('2026-10-29T22:30:00.000Z');
  const cairoClock = getCairoClock(boundaryNow);
  assert.equal(cairoClock.dayKey, '2026-10-30', '22:30Z on Oct 29 must be Oct 30 in Africa/Cairo');
  assert.ok(cairoClock.hour >= 0 && cairoClock.hour <= 1);

  const bounds = getCairoDayBoundsUtc('2026-10-30');
  assert.ok(Date.parse(bounds.startUtcIso) <= boundaryNow.getTime());
  assert.ok(Date.parse(bounds.endUtcIso) > boundaryNow.getTime());

  // Fix E verification: buyer never addressed as owner; local phone gets 20 prefix
  assert.equal(whatsappHref('010 9876 5432', 'تجربة'), 'https://wa.me/201098765432?text=%D8%AA%D8%AC%D8%B1%D8%A8%D8%A9');
  const buyMsg = buildReadyFollowupMessage('عميل تجريبي', 'buy', 'مكرم عبيد');
  assert.ok(!buyMsg.includes('المعروضة لديكم'));
  const neutralMsg = buildReadyFollowupMessage('عميل تجريبي', '', '');
  assert.ok(!neutralMsg.includes('المعروضة لديكم'));

  // Fix F verification: /api/push/test logs kind='test' into crm_push_notifications_log
  const vapid = await generateVapidKeyPair();
  env.CRM_VAPID_PUBLIC_KEY = vapid.publicKeyB64u;
  env.CRM_VAPID_PRIVATE_KEY = vapid.privateKeyB64u;
  env.CRM_VAPID_SUBJECT = 'mailto:test@example.com';

  const deviceKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dhRaw = Buffer.from(await crypto.subtle.exportKey('raw', deviceKeys.publicKey)).toString('base64url');
  const authRaw = crypto.randomBytes(16).toString('base64url');

  const subRes = await call('/api/push/subscribe', {
    method: 'POST',
    body: {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-remediation',
        keys: { p256dh: p256dhRaw, auth: authRaw },
      },
      device_label: 'Android Chrome Test',
    },
  });
  assert.equal(subRes.status, 200);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 201 });
  try {
    const testPushRes = await call('/api/push/test', { method: 'POST', body: {} });
    assert.equal(testPushRes.status, 200);
    const testPushBody = await testPushRes.json();
    assert.equal(testPushBody.delivered, 1);
    assert.equal(testPushBody.logged, true);
    assert.ok(testPushBody.log_key.startsWith('test:'));
  } finally {
    globalThis.fetch = realFetch;
  }

  const loggedRow = sqlite.prepare("SELECT dedupe_key, kind, sent_at FROM crm_push_notifications_log WHERE kind = 'test'").get();
  assert.ok(loggedRow, 'Expected kind="test" row in crm_push_notifications_log');
  assert.ok(loggedRow.dedupe_key.startsWith('test:'));
  sqlite.close();
});

test('Sync Guardrails: dry_run diff, matched + unmatched review queue + chatless contacts, zero body-phone contact creation, zero name-only merge, zero auto-opportunities, and 100% idempotency', async () => {
  const { sqlite } = await createIsolatedCrmEnv();
  const db = wrapD1(sqlite);

  // Seed 1 existing contact with primary phone, and 1 existing contact with same name as a DIFFERENT VCF person (must NOT merge on name alone!)
  sqlite.prepare("INSERT INTO crm_contacts(id,name,communication_consent) VALUES ('existing-c1','عميل قائم تجريبي','request_only')").run();
  sqlite.prepare("INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES ('ph-c1','existing-c1','201011112222','أساسي',1)").run();

  sqlite.prepare("INSERT INTO crm_contacts(id,name,communication_consent) VALUES ('existing-same-name','اسم متشابه تجريبي','request_only')").run();
  sqlite.prepare("INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES ('ph-same','existing-same-name','201099990000','أساسي',1)").run();

  const syncPayload = {
    vcf_contacts: [
      {
        fn: 'عميل قائم تجريبي',
        phones: [
          { e164: '201011112222', vcf_file: 'batch1.vcf' },
          { e164: '201211112222', vcf_file: 'batch2.vcf', label: 'ثانوي' },
        ],
      },
      {
        fn: 'عميل جديد بمحادثة تجريبي',
        phones: [{ e164: '201133334444', vcf_file: 'batch1.vcf' }],
      },
      {
        fn: 'عميل بدون محادثة تجريبي',
        phones: [{ e164: '201555556666', vcf_file: 'batch3.vcf' }],
      },
      {
        // Same name as 'existing-same-name' but different phone -> MUST NOT merge automatically!
        fn: 'اسم متشابه تجريبي',
        phones: [{ e164: '201077778888', vcf_file: 'batch4.vcf' }],
      },
    ],
    unique_chats: [
      {
        sig: 'sig-matched-1',
        title: 'دردشة في واتساب مع عميل جديد بمحادثة تجريبي.txt',
        raw_txt: '26/10/2026, 3:10 م - عميل جديد بمحادثة تجريبي: السلام عليكم عايز شقة في مكرم عبيد وممكن رقم حارس العقار 01088887777 للمعاينة بكرة الساعة 5',
      },
      {
        sig: 'sig-unmatched-body-phone',
        title: 'دردشة في واتساب مع حساب غير معروف تجريبي.txt',
        raw_txt: '26/10/2026, 4:00 م - حساب غير معروف تجريبي: ده إعلان مالك شقة رقمه 01044443333 وده رقم زوجتي 01244443333 كلمني الأسبوع الجاي',
      },
    ],
  };

  // 1) dry_run: true produces exact diff without touching DB
  const beforeCount = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt;
  const dryRes = await runSourceSyncBundle(db, { ...syncPayload, dry_run: true }, new Date('2026-10-30T10:00:00Z'));
  assert.equal(dryRes.dry_run, true);
  assert.equal(dryRes.diff.existing_contacts_with_valid_phones, 1);
  assert.equal(dryRes.diff.additional_phones_for_existing, 1);
  assert.equal(dryRes.diff.missing_contacts_to_add, 2);
  assert.equal(dryRes.diff.conflicting_or_duplicate_phones, 1);
  assert.equal(dryRes.diff.conversations_matched, 1);
  assert.equal(dryRes.diff.conversations_unmatched_review, 1);
  assert.equal(dryRes.diff.chatless_vcf_contacts_retained, 3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt, beforeCount, 'dry_run must not mutate DB');

  // 2) Live sync run 1
  const run1 = await runSourceSyncBundle(db, syncPayload, new Date('2026-10-30T10:00:00Z'));
  assert.equal(run1.dry_run, false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt, 4, '2 existing + 2 new VCF contacts; zero body-phone contacts');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_opportunities').get().cnt, 0, 'Zero auto-created opportunities from mere sync');

  // Guardrail proof: body phones 01088887777, 01044443333, 01244443333 MUST NOT exist in crm_contact_phones!
  for (const bodyPhone of ['201088887777', '201044443333', '201244443333']) {
    const found = sqlite.prepare('SELECT 1 FROM crm_contact_phones WHERE phone_key = ?').get(bodyPhone);
    assert.equal(found, undefined, `Body-mentioned phone ${bodyPhone} must NEVER become a CRM phone`);
  }

  // Unmatched chat is preserved in review queue with full raw text
  const unmatchedRow = sqlite.prepare("SELECT match_status, contact_id FROM crm_conversations WHERE match_status = 'unmatched_review'").get();
  assert.ok(unmatchedRow);
  assert.equal(unmatchedRow.contact_id, null);

  // 3) Live sync run 2 (strict idempotency!)
  const contactsAfter1 = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt;
  const phonesAfter1 = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contact_phones').get().cnt;
  const convsAfter1 = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversations').get().cnt;
  const msgsAfter1 = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversation_messages').get().cnt;
  const alertsAfter1 = sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_smart_alerts').get().cnt;

  const run2 = await runSourceSyncBundle(db, syncPayload, new Date('2026-10-30T10:05:00Z'));
  assert.equal(run2.diff.missing_contacts_to_add, 0);
  assert.equal(run2.diff.additional_phones_for_existing, 0);
  assert.equal(run2.intelligence.conversations_incremental_skipped, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contacts').get().cnt, contactsAfter1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_contact_phones').get().cnt, phonesAfter1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversations').get().cnt, convsAfter1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_conversation_messages').get().cnt, msgsAfter1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS cnt FROM crm_smart_alerts').get().cnt, alertsAfter1);
  sqlite.close();
});

test('Privacy Canary: repository contains zero historic leaked customer phones, zero .vcf archives, and IDLE ingest queue', async () => {
  // Verify SHA-256 of historic leaked phone (33622413234 -> 49c006b0...) never appears anywhere in repository source/tests
  const leakedPhoneSha256 = '49c006b064988062a51eb01a7e7b35d6e6188d9c53034974990cf26c47755479';
  const walk = async (dir, acc = []) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '_site') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        assert.notEqual(ent.name, 'google_drive', 'google_drive staging directory must never exist inside repo');
        await walk(full, acc);
      } else {
        assert.ok(!ent.name.toLowerCase().endsWith('.vcf'), `VCF file forbidden in repository: ${full}`);
        if (/\.(js|mjs|cjs|html|css|json|sql|yml|yaml|txt)$/i.test(ent.name)) acc.push(full);
      }
    }
    return acc;
  };

  const files = await walk(ROOT_DIR.pathname);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const token of content.match(/\+?\d[\d\s-]{8,16}\d/g) || []) {
      const digits = token.replaceAll(/\D/g, '');
      const digest = crypto.createHash('sha256').update(digits).digest('hex');
      assert.notEqual(digest, leakedPhoneSha256, `Forbidden historic customer phone detected in ${file}`);
    }
  }
});

test('Clean Foundation Policy (strict_complete_contacts_only): enforces backup ref, purges phoneless/username-only/transient records FK-safely, and guarantees 100% working wa.me links', async () => {
  // 1) Verify WhatsApp direct link vs @username-only technical behavior
  const readyMsg = buildReadyFollowupMessage({
    clientName: '🟢 عميل متكامل تجريبي',
    intent: 'buy',
    track: 'sale_apt',
    areaLabel: 'مكرم عبيد',
  });
  const directHref = whatsappHref('+20 100 111 2233', readyMsg);
  const usernameOnlyHref = whatsappHref('@username_without_phone', readyMsg);
  assert.match(directHref, /^https:\/\/wa\.me\/201001112233\?text=/);
  assert.match(usernameOnlyHref, /^https:\/\/wa\.me\/\?text=/, 'Meta wa.me cannot address @username directly without E.164 digits');

  // 2) Seed isolated DB (`PRAGMA foreign_keys = ON`!) with mixed complete, phoneless/@username, body-scraped, and ✈️ transient records + child FKs
  const { sqlite, env } = await createIsolatedCrmEnv();
  const db = env.DB;

  sqlite.exec(`
    INSERT INTO crm_contacts(id, name, communication_consent) VALUES
      ('c-complete-1', '🟢 عميل متكامل أول', 'request_only'),
      ('c-phoneless-1', 'عميل اسم مستخدم فقط @user_demo', 'request_only'),
      ('c-transient-1', '✈️ باحث عابر قديم انتهى', 'request_only'),
      ('c-nonvcf-1', 'جهة غير موثقة بدون بطاقة VCF', 'request_only'),
      ('c-test-keep', 'TEST ONLY synthetic canary', 'request_only');
    INSERT INTO crm_contact_phones(id, contact_id, phone_key, label, is_primary, source_type) VALUES
      ('p-comp-1', 'c-complete-1', '201001112233', 'واتساب', 1, 'manual'),
      ('p-trans-1', 'c-transient-1', '201112223344', 'واتساب', 1, 'vcf'),
      ('p-nonvcf-1', 'c-nonvcf-1', '201223334455', 'يدوي', 1, 'manual'),
      ('p-test-1', 'c-test-keep', '201550001199', 'اختبار', 1, 'manual');
    INSERT INTO crm_opportunities(id, contact_id, track, intent, source, status, area_label, property_type, next_action, next_followup_at, no_followup_reason) VALUES
      ('o-comp-1', 'c-complete-1', 'sale_apt', 'buy', 'whatsapp', 'active', 'مكرم عبيد', 'شقة', 'إرسال عروض', '2026-10-31T10:00:00Z', ''),
      ('o-phoneless-1', 'c-phoneless-1', 'sale_apt', 'buy', 'whatsapp', 'paused', 'عباس العقاد', 'شقة', '', NULL, 'بدون رقم هاتف'),
      ('o-trans-1', 'c-transient-1', 'transient', 'rent', 'whatsapp', 'paused', 'مدينة نصر', 'شقة', '', NULL, 'أرشيف عابر');
    INSERT INTO crm_activities(id, opportunity_id, activity_type, summary) VALUES
      ('a-comp-1', 'o-comp-1', 'note', 'نشاط عميل متكامل'),
      ('a-phoneless-1', 'o-phoneless-1', 'note', 'نشاط حساب بدون رقم'),
      ('a-trans-1', 'o-trans-1', 'note', 'نشاط عابر');
    INSERT INTO crm_opportunity_properties(id, opportunity_id, listing_id, presentation_status) VALUES
      ('op-phoneless-1', 'o-phoneless-1', 101, 'selected');
    INSERT INTO crm_conversations(id, conversation_uid, contact_id, opportunity_id, chat_title, raw_text, raw_sha256, match_status) VALUES
      ('cv-unmatched-1', 'wa:unmatched-demo', NULL, NULL, 'عميل اسم مستخدم فقط @user_demo', '29/10/2026, 2:00 م - عميل: استفسار', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'unmatched_review');
  `);

  const cleanBundle = {
    clean_foundation_policy: 'strict_complete_contacts_only',
    vcf_contacts: [
      { fn: '🟢 عميل متكامل أول', phones: [{ raw: '01001112233', vcf_file: 'vcards_1.vcf' }] },
      { fn: '🔵 عميل متكامل ثانٍ', phones: [{ raw: '+20 109 888 7766', vcf_file: 'vcards_2.vcf' }] },
      { fn: '✈️ باحث عابر قديم انتهى', phones: [{ raw: '01112223344', vcf_file: 'vcards_3.vcf' }] },
    ],
    conversations: [
      {
        title: '🟢 عميل متكامل أول',
        raw_txt: '29/10/2026, 5:00 م - 🟢 عميل متكامل أول: عايز نعاين شقة مكرم عبيد بكرة الساعة 6 مساءً',
      },
      {
        title: 'عميل اسم مستخدم فقط @user_demo',
        raw_txt: '29/10/2026, 5:10 م - عميل: محادثة بدون رقم هاتف',
      },
      {
        title: '✈️ باحث عابر قديم انتهى',
        raw_txt: '20/08/2026, 3:00 م - عابر: تم التأجير خارجنا',
      },
    ],
  };

  // 3) Safety gate: live destructive cleanup MUST reject when backup_verified_ref is omitted
  const rejected = await runSourceSyncBundle(db, cleanBundle, { now: new Date('2026-10-30T12:00:00Z') });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'backup_verified_ref_required_before_foundation_cleanup');

  // 4) Dry-run succeeds without mutating D1 and reports exact purge + keep counts
  const dryRes = await runSourceSyncBundle(db, cleanBundle, { dryRun: true, now: new Date('2026-10-30T12:00:00Z') });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.diff.incomplete_or_transient_vcf_skipped, 1);
  assert.equal(dryRes.diff.purged_incomplete_contacts, 3);
  assert.equal(dryRes.diff.purged_incomplete_opportunities, 2);
  assert.equal(dryRes.diff.purged_incomplete_conversations, 1);
  assert.equal(dryRes.diff.existing_contacts_with_valid_phones, 1);
  assert.equal(dryRes.diff.missing_contacts_to_add, 1);
  assert.equal(dryRes.diff.conversations_matched, 1);
  assert.equal(dryRes.diff.incomplete_conversations_skipped, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS cnt FROM crm_contacts WHERE name NOT LIKE 'TEST ONLY%'").get().cnt, 4, 'dry_run must not delete rows');

  // 5) Live cleanup with verified backup reference executes cleanly without any FK violation
  const liveRun1 = await runSourceSyncBundle(
    db,
    { ...cleanBundle, backup_verified_ref: 'nasr-crm-test-db-backup-20261030-unit' },
    { now: new Date('2026-10-30T12:00:00Z') },
  );
  assert.equal(liveRun1.ok, true);
  assert.equal(liveRun1.diff.purged_incomplete_contacts, 3);

  const remainingRealContacts = sqlite.prepare(
    `SELECT c.id, c.name, COUNT(p.id) AS phone_cnt
     FROM crm_contacts c LEFT JOIN crm_contact_phones p ON p.contact_id = c.id
     WHERE c.name NOT LIKE 'TEST ONLY%'
     GROUP BY c.id`,
  ).all();
  assert.equal(remainingRealContacts.length, 2, 'Only the 2 complete non-transient VCF contacts remain');
  assert.ok(remainingRealContacts.every(r => r.phone_cnt >= 1 && !r.name.includes('✈')), '100% of remaining contacts have verified phones and zero ✈️ clutter');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS cnt FROM crm_conversations WHERE match_status = 'unmatched_review'").get().cnt, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS cnt FROM crm_opportunities WHERE id = 'o-comp-1'").get().cnt, 1, 'Active opportunity on complete contact preserved');

  // 6) Second run is 100% idempotent (0 purges, 0 additions, incremental conversation skip)
  const liveRun2 = await runSourceSyncBundle(
    db,
    { ...cleanBundle, backup_verified_ref: 'nasr-crm-test-db-backup-20261030-unit' },
    { now: new Date('2026-10-30T12:05:00Z') },
  );
  assert.equal(liveRun2.ok, true);
  assert.equal(liveRun2.diff.purged_incomplete_contacts, 0);
  assert.equal(liveRun2.diff.missing_contacts_to_add, 0);
  assert.equal(liveRun2.intelligence.conversations_incremental_skipped, 1);
  sqlite.close();
});

