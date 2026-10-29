import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker, {
  createAccessCodeVerifier,
  generateIngestKeyPair,
  generateVapidKeyPair,
  sealIngestPayload,
} from '../crm-worker.js';
import { runScheduledCrmNotifications } from '../crm-push.js';

const migration0001 = await readFile(new URL('../migrations/0001_crm_opportunities.sql', import.meta.url), 'utf8');
const migration0002 = await readFile(new URL('../migrations/0002_crm_internal_auth.sql', import.meta.url), 'utf8');
const migration0003 = await readFile(new URL('../migrations/0003_crm_push_notifications.sql', import.meta.url), 'utf8');
const migration0004 = await readFile(new URL('../migrations/0004_crm_tracks_core.sql', import.meta.url), 'utf8');
const ALLOWED_ORIGIN = 'https://nasr-crm-api-test.footcai-555.workers.dev';

function randomToken(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(raw).toString('base64url');
}

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

function mockAssets() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/crm.html') {
        return new Response('<!doctype html><html lang="ar"><title>CRM</title></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (pathname === '/crm-client.js' || pathname === '/crm-assets/app.js' || pathname === '/crm-sw.js') {
        return new Response('export default true;', {
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        });
      }
      if (pathname === '/crm-manifest.webmanifest') {
        return new Response('{"name":"CRM"}', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      if (pathname.endsWith('.png')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      if (pathname === '/crm-assets/app.css') {
        return new Response('body{margin:0}', {
          status: 200,
          headers: { 'content-type': 'text/css; charset=utf-8' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}

async function createEnv({ useVerifier = true, extraEnv = {} } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT, title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL, bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT);
    INSERT INTO sources(id,name) VALUES (1,'aqarmap'),(9009,'crm-synthetic-test');
    INSERT INTO areas(id,name_ar) VALUES (1,'الحي العاشر'),(99,'القاهرة الجديدة'),(90001,'مدينة نصر اختبار');
    INSERT INTO listings(id,source_id,external_id,url,title,property_type,transaction_type,area_id,area_m2,price,bedrooms,bathrooms,finishing,observed_at)
      VALUES (10,1,'nasr-1','https://example.test/1','شقة مدينة نصر','apartment','sale',1,140,3500000,3,2,'تشطيب كامل','2026-10-27T10:00:00Z'),
             (11,1,'outside-1','https://example.test/2','شقة خارج النطاق','apartment','sale',99,140,3500000,3,2,'تشطيب كامل','2026-10-27T10:00:00Z'),
             (12,9009,'synthetic-nasr-1','https://example.test/synthetic-1','شقة اختبار معزولة','apartment','sale',90001,155,4100000,3,2,'سوبر لوكس','2026-10-28T09:00:00Z');`);
  sqlite.exec(migration0001);
  sqlite.exec(migration0002);
  sqlite.exec(migration0003);
  sqlite.exec(migration0004);

  const accessCode = randomToken(24);
  const sessionSecret = randomToken(32);
  const baseEnv = {
    DB: wrapD1(sqlite),
    ASSETS: mockAssets(),
    CRM_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    CRM_SITE_SOURCE_ID: '1',
    CRM_NASR_AREA_IDS: '1',
    CRM_SESSION_SECRET: sessionSecret,
  };
  if (useVerifier) {
    baseEnv.CRM_ACCESS_CODE_VERIFIER = await createAccessCodeVerifier(accessCode);
  } else {
    baseEnv.CRM_ACCESS_CODE = accessCode;
  }
  return { sqlite, accessCode, env: { ...baseEnv, ...extraEnv } };
}

function extractCookiePair(setCookieHeader) {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  return setCookieHeader.split(';')[0];
}

async function loginSession(env, accessCode, clientIp = '198.51.100.10') {
  const res = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': clientIp,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /^__Host-crm_session=[A-Za-z0-9_-]{32,128};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=28800/);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.match(body.csrf_token, /^[A-Za-z0-9_-]{32,128}$/);
  return {
    cookie: extractCookiePair(setCookie),
    rawToken: extractCookiePair(setCookie).slice('__Host-crm_session='.length),
    csrfToken: body.csrf_token,
  };
}

function makeAuthedApiCall(env, session) {
  return async (path, { method = 'GET', body, key, csrf = session.csrfToken, origin = ALLOWED_ORIGIN } = {}) => {
    const headers = { cookie: session.cookie };
    if (origin) headers.origin = origin;
    headers['sec-fetch-site'] = 'same-origin';
    if (method !== 'GET' && method !== 'HEAD') {
      if (csrf !== null) headers['x-crm-csrf'] = csrf;
    }
    if (key) headers['idempotency-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return worker.fetch(new Request(`${ALLOWED_ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };
}

test('fails closed with 503 auth_not_configured when internal auth secrets are missing or weak', async () => {
  const { sqlite, env } = await createEnv();
  const missingAll = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/dashboard`), { DB: env.DB });
  assert.equal(missingAll.status, 503);
  assert.deepEqual(await missingAll.json(), { error: 'auth_not_configured' });

  const weakSession = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/dashboard`), {
    ...env,
    CRM_SESSION_SECRET: 'too-short',
  });
  assert.equal(weakSession.status, 503);

  const weakAccessCode = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/dashboard`), {
    DB: env.DB,
    CRM_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    CRM_SESSION_SECRET: env.CRM_SESSION_SECRET,
    CRM_ACCESS_CODE: 'short-code',
  });
  assert.equal(weakAccessCode.status, 503);
  sqlite.close();
});

test('serves static login shell without exposing data and blocks every unauthenticated API route', async () => {
  const { sqlite, env } = await createEnv();

  const rootRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/`, {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  }), env);
  assert.equal(rootRes.status, 200);
  assert.equal(rootRes.headers.get('cache-control'), 'private, no-store');
  assert.equal(rootRes.headers.get('x-frame-options'), 'DENY');
  assert.match(rootRes.headers.get('content-security-policy') || '', /default-src 'self'/);

  const crossSiteApiGet = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/contacts`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  }), env);
  assert.equal(crossSiteApiGet.status, 403);

  const unauthRoutes = [
    ['GET', '/api/auth/session'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/contacts'],
    ['POST', '/api/contacts'],
    ['GET', '/api/contacts/contact_12345678'],
    ['POST', '/api/contacts/contact_12345678/phones'],
    ['GET', '/api/opportunities'],
    ['POST', '/api/opportunities'],
    ['GET', '/api/opportunities/opportunity_1234'],
    ['POST', '/api/opportunities/opportunity_1234/activities'],
    ['GET', '/api/listings'],
    ['POST', '/api/opportunities/opportunity_1234/properties'],
    ['POST', '/api/auth/logout'],
    ['GET', '/nonexistent-private-path'],
  ];

  for (const [method, path] of unauthRoutes) {
    const headers = method === 'POST' ? { origin: ALLOWED_ORIGIN, 'sec-fetch-site': 'same-origin' } : {};
    const res = await worker.fetch(new Request(`${ALLOWED_ORIGIN}${path}`, { method, headers }), env);
    assert.equal(res.status, 401, `Expected 401 for unauthenticated ${method} ${path}`);
  }
  sqlite.close();
});

test('enforces Origin, Sec-Fetch-Site, CORS allowlist, CSRF header, rate limiting, hashed D1 session storage, and logout revocation', async () => {
  const { sqlite, accessCode, env } = await createEnv();

  const badCors = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/contacts`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
  }), env);
  assert.equal(badCors.status, 403);
  assert.equal(badCors.headers.get('access-control-allow-origin'), null);

  const goodCors = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/contacts`, {
    method: 'OPTIONS',
    headers: { origin: ALLOWED_ORIGIN },
  }), env);
  assert.equal(goodCors.status, 204);
  assert.equal(goodCors.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(goodCors.headers.get('access-control-allow-credentials'), 'true');

  const wrongOriginLogin = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(wrongOriginLogin.status, 403);
  assert.deepEqual(await wrongOriginLogin.json(), { error: 'origin_not_allowed' });

  const crossSiteFetch = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { origin: ALLOWED_ORIGIN, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(crossSiteFetch.status, 403);
  assert.deepEqual(await crossSiteFetch.json(), { error: 'cross_site_forbidden' });

  for (let i = 0; i < 5; i += 1) {
    const wrong = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: {
        origin: ALLOWED_ORIGIN,
        'cf-connecting-ip': '203.0.113.77',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_code: 'wrong-code-attempt-' + i }),
    }), env);
    assert.equal(wrong.status, 401);
  }
  const locked = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'cf-connecting-ip': '203.0.113.77',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_code: accessCode }),
  }), env);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);

  const session = await loginSession(env, accessCode, '198.51.100.25');
  const storedSession = sqlite.prepare('SELECT token_hash, csrf_hash, revoked_at FROM crm_sessions LIMIT 1').get();
  assert.equal(storedSession.token_hash.length, 64);
  assert.equal(storedSession.csrf_hash.length, 64);
  assert.notEqual(storedSession.token_hash, session.rawToken);
  assert.notEqual(storedSession.csrf_hash, session.csrfToken);
  assert.equal(storedSession.revoked_at, null);

  const api = makeAuthedApiCall(env, session);

  const missingCsrf = await api('/api/contacts', {
    method: 'POST',
    key: 'no-csrf-contact-1',
    csrf: null,
    body: { name: 'بدون CSRF', phones: [{ phone: '01012345678', is_primary: true }] },
  });
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), { error: 'csrf_invalid' });

  const wrongCsrf = await api('/api/contacts', {
    method: 'POST',
    key: 'bad-csrf-contact-1',
    csrf: randomToken(32),
    body: { name: 'CSRF خاطئ', phones: [{ phone: '01012345678', is_primary: true }] },
  });
  assert.equal(wrongCsrf.status, 403);

  const sessionCheck = await api('/api/auth/session');
  assert.equal(sessionCheck.status, 200);
  const refreshed = await sessionCheck.json();
  assert.equal(refreshed.authenticated, true);
  assert.equal(refreshed.csrf_token, session.csrfToken);

  const logoutRes = await api('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(logoutRes.status, 200);
  assert.match(logoutRes.headers.get('set-cookie') || '', /Max-Age=0/);

  const replayAfterLogout = await api('/api/contacts');
  assert.equal(replayAfterLogout.status, 401);
  assert.match(replayAfterLogout.headers.get('set-cookie') || '', /Max-Age=0/);
  sqlite.close();
});

test('supports direct CRM_ACCESS_CODE secret mode and rejects idle-expired sessions', async () => {
  const { sqlite, accessCode, env } = await createEnv({ useVerifier: false });
  const session = await loginSession(env, accessCode);
  const api = makeAuthedApiCall(env, session);

  assert.equal((await api('/api/dashboard?day=2026-10-28')).status, 200);

  sqlite.prepare('UPDATE crm_sessions SET last_seen_at=?').run(1000);
  const staleRes = await api('/api/dashboard?day=2026-10-28');
  assert.equal(staleRes.status, 401);
  assert.deepEqual(await staleRes.json(), { error: 'authentication_required' });
  sqlite.close();
});

test('creates opportunities, enforces idempotency and duplicate review, logs follow-ups, and scopes property links to Nasr City', async () => {
  const { sqlite, accessCode, env } = await createEnv();
  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  const key = 'submission-key-0001';
  const payload = {
    name: 'أحمد حسن',
    phone: '01012345678',
    intent: 'buy',
    source: 'call',
    area_label: 'الحي العاشر',
    budget_min: 3000000,
    budget_max: 4000000,
    next_action: 'إرسال ٣ شقق مناسبة',
    next_followup_at: '2026-10-28T10:00:00Z',
    notes: 'عميل جاد يفضل الاستلام الفوري',
  };
  const created = await call('/api/opportunities', { method: 'POST', key, body: payload });
  assert.equal(created.status, 201);
  const { opportunity_id: oppId } = await created.json();
  const replayed = await call('/api/opportunities', { method: 'POST', key, body: payload });
  assert.equal(replayed.status, 200);
  assert.equal((await replayed.json()).opportunity_id, oppId);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM crm_opportunities').get().n, 1);

  const conflict = await call('/api/opportunities', {
    method: 'POST',
    key: 'submission-key-0002',
    body: { ...payload, name: 'عميل مختلف بنفس الرقم' },
  });
  assert.equal(conflict.status, 409);

  const missingAction = await call('/api/opportunities', {
    method: 'POST',
    key: 'submission-key-0003',
    body: { name: 'سارة', phone: '01099887766', intent: 'rent', source: 'website' },
  });
  assert.equal(missingAction.status, 400);

  const badLink = await call(`/api/opportunities/${oppId}/properties`, {
    method: 'POST',
    body: { external_id: 'outside-1' },
  });
  assert.equal(badLink.status, 404);
  const okLink = await call(`/api/opportunities/${oppId}/properties`, {
    method: 'POST',
    body: { external_id: 'nasr-1', presentation_status: 'viewing_scheduled', viewing_at: '2026-10-28T15:00:00Z' },
  });
  assert.equal(okLink.status, 200);

  const act = await call(`/api/opportunities/${oppId}/activities`, {
    method: 'POST',
    body: { activity_type: 'status_change', status: 'lost', loss_reason: 'price', summary: 'الميزانية أقل من المطلوب' },
  });
  assert.equal(act.status, 200);

  const dash = await (await call('/api/dashboard?day=2026-10-28')).json();
  assert.equal(dash.scheduled_visits.length, 1);
  assert.equal(dash.outcomes.find(row => row.status === 'lost').count, 1);
  sqlite.close();
});

test('supports isolated synthetic listing scope via CRM_SITE_SOURCE_ID and CRM_NASR_AREA_IDS', async () => {
  const { sqlite, accessCode, env } = await createEnv({
    extraEnv: { CRM_SITE_SOURCE_ID: '9009', CRM_NASR_AREA_IDS: '90001' },
  });
  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  const listingsRes = await call('/api/listings');
  assert.equal(listingsRes.status, 200);
  const { listings } = await listingsRes.json();
  assert.equal(listings.length, 1);
  assert.equal(listings[0].external_id, 'synthetic-nasr-1');
  sqlite.close();
});

test('supports standalone customers with multiple phones, marketing consent gate, and multiple opportunities', async () => {
  const { sqlite, accessCode, env } = await createEnv();
  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  const unconfirmedConsent = await call('/api/contacts', {
    method: 'POST',
    key: 'contact-consent-missing',
    body: { name: 'ندى محمود', phones: [{ phone: '01022334455', is_primary: true }], communication_consent: 'marketing_yes' },
  });
  assert.equal(unconfirmedConsent.status, 400);

  const contactRes = await call('/api/contacts', {
    method: 'POST',
    key: 'contact-key-0001',
    body: {
      name: 'ندى محمود',
      phones: [
        { phone: '01022334455', label: 'شخصي', is_primary: true },
        { phone: '01155667788', label: 'عمل', is_primary: false },
      ],
    },
  });
  assert.equal(contactRes.status, 201);
  const { contact_id: contactId } = await contactRes.json();

  const addedPhone = await call(`/api/contacts/${contactId}/phones`, {
    method: 'POST',
    body: { phone: '01233445566', label: 'منزل' },
  });
  assert.equal(addedPhone.status, 200);

  const oppA = await call('/api/opportunities', {
    method: 'POST',
    key: 'contact-opp-0001',
    body: { contact_id: contactId, intent: 'buy', source: 'call', next_action: 'إرسال خيارات شراء', next_followup_at: '2026-10-29T10:00:00Z' },
  });
  const oppB = await call('/api/opportunities', {
    method: 'POST',
    key: 'contact-opp-0002',
    body: { contact_id: contactId, intent: 'rent', source: 'website', next_action: 'إرسال خيارات إيجار', next_followup_at: '2026-10-30T10:00:00Z' },
  });
  assert.equal(oppA.status, 201);
  assert.equal(oppB.status, 201);

  const detail = await (await call(`/api/contacts/${contactId}`)).json();
  assert.equal(detail.contact.communication_consent, 'request_only');
  assert.equal(detail.phones.length, 3);
  assert.equal(detail.opportunities.length, 2);

  const search = await (await call('/api/contacts?q=01155667788')).json();
  assert.equal(search.contacts.length, 1);
  assert.equal(search.contacts[0].id, contactId);
  sqlite.close();
});

test('updates placeholder owner contact atomically and enforces sealed-box encrypted ingest with anti-replay ticket', async () => {
  const keyPair = await generateIngestKeyPair();
  const { sqlite, accessCode, env } = await createEnv({
    extraEnv: { CRM_INGEST_PRIVATE_KEY: keyPair.privateKeyPkcs8B64u },
  });
  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  // 1. Create a phone-less apartment owner placeholder and complete name + phone via POST /api/contacts/:id
  const placeholderRes = await call('/api/contacts', {
    method: 'POST',
    key: 'placeholder-owner-0001',
    body: { name: 'مالك — شقة مدينة نصر (بانتظار الرقم)', phones: [] },
  });
  assert.equal(placeholderRes.status, 201);
  const { contact_id: placeholderId } = await placeholderRes.json();

  const updated = await call(`/api/contacts/${placeholderId}`, {
    method: 'POST',
    body: { name: 'مالك تجريبي محدث', phone: '01099887766', label: 'أساسي', is_primary: true },
  });
  assert.equal(updated.status, 200);
  const updatedDetail = await (await call(`/api/contacts/${placeholderId}`)).json();
  assert.equal(updatedDetail.contact.name, 'مالك تجريبي محدث');
  assert.equal(updatedDetail.phones.length, 1);
  assert.equal(updatedDetail.phones[0].phone_key, '201099887766');

  // 2. Sealed-box encrypted ingest wipes prior customers when requested, supports extra_phones + contact_only, and blocks replay
  const sealedEnvelope = await sealIngestPayload({
    wipe_existing_customers: true,
    entries: [
      {
        submission_key: 'sealed-owner-test-0001',
        name: 'عميل مشفر تجريبي',
        phone: '+33 6 22413234',
        phone_label: 'واتساب دولي',
        extra_phones: [{ phone: '01299001122', label: 'موبايل مصري' }],
        intent: 'sell',
        source: 'whatsapp',
        source_url: '/properties/test-unit/',
        status: 'active',
        area_label: 'مدينة نصر',
        property_type: 'شقة',
        budget_min: 3500000,
        budget_max: 3500000,
        size_min_m2: 140,
        size_max_m2: 140,
        external_id: 'nasr-1',
        no_followup_reason: 'معروض بالموقع',
        notes: 'بيانات مشفرة للاختبار المعزول فقط',
      },
      {
        submission_key: 'sealed-contact-only-test-0002',
        entry_type: 'contact_only',
        name: 'عميل خارج النطاق تجريبي',
        phone: '01099002233',
        phone_label: 'هاتف',
      },
    ],
  }, keyPair.publicKeySpkiB64u);

  const unticketed = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/ingest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed_payload: sealedEnvelope }),
  }), env);
  assert.equal(unticketed.status, 403);

  const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealedEnvelope));
  const ticketHash = Buffer.from(digestBuf).toString('hex');
  sqlite.prepare("INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,'opportunity','authorized_pending')")
    .run(`sealed-ticket:${ticketHash}`);

  const accepted = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/ingest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed_payload: sealedEnvelope }),
  }), env);
  assert.equal(accepted.status, 200);
  const acceptedJson = await accepted.json();
  assert.equal(acceptedJson.wiped_existing, true);
  assert.equal(acceptedJson.processed, 2);
  assert.equal(acceptedJson.created_contacts, 2);
  assert.equal(acceptedJson.created_opportunities, 1);
  assert.equal(acceptedJson.linked_properties, 1);

  const replay = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/ingest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed_payload: sealedEnvelope }),
  }), env);
  assert.equal(replay.status, 403);

  const allContacts = await (await call('/api/contacts')).json();
  assert.equal(allContacts.contacts.length, 2, 'Old placeholder customer wiped; only new batch exists');
  const opps = await (await call('/api/opportunities?status=active')).json();
  const sealedOpp = opps.opportunities.find(o => o.contact_name === 'عميل مشفر تجريبي');
  assert.ok(sealedOpp, 'Expected decrypted opportunity in D1');
  assert.equal(sealedOpp.phone_key, '33622413234');
  const sealedContactDetail = await (await call(`/api/contacts/${sealedOpp.contact_id}`)).json();
  assert.equal(sealedContactDetail.phones.length, 2);

  sqlite.close();
});

function createPushTestDevice() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const d = privateKey.export({ format: 'jwk' }).d;
  const pub65 = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const authBuf = nodeCrypto.randomBytes(16);
  return {
    p256dh: pub65.toString('base64url'),
    auth: authBuf.toString('base64url'),
    priv32: Buffer.from(d, 'base64url'),
    pub65,
    authBuf,
  };
}

function decryptRfc8291PushBody(bodyBytes, device) {
  const buf = Buffer.from(bodyBytes);
  const salt = buf.subarray(0, 16);
  assert.equal(buf.readUInt32BE(16), 4096);
  assert.equal(buf[20], 65);
  const asPublic = buf.subarray(21, 86);
  const cipher = buf.subarray(86);

  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(device.priv32);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.pub65, asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, device.authBuf, keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 0x02);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

test('delivers encrypted Web Push notifications, runs scheduled due/digest alerts without PII, deduplicates, and prunes 410 subscriptions', async () => {
  const vapid = await generateVapidKeyPair();
  const { sqlite, accessCode, env } = await createEnv({
    extraEnv: {
      CRM_VAPID_PUBLIC_KEY: vapid.publicKeyB64u,
      CRM_VAPID_PRIVATE_KEY: vapid.privateKeyB64u,
    },
  });

  // Service worker + WebAPK manifest/icon headers and unauthenticated push API 401
  const swAssetRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/crm-sw.js`), env);
  assert.equal(swAssetRes.status, 200);
  assert.equal(swAssetRes.headers.get('service-worker-allowed'), '/');
  assert.match(swAssetRes.headers.get('content-type') || '', /application\/javascript/);

  const mfRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/crm-manifest.webmanifest`), env);
  assert.equal(mfRes.status, 200);
  assert.equal(mfRes.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  assert.equal(mfRes.headers.get('cache-control'), 'public, max-age=3600');

  const iconRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/crm-assets/icon-maskable-512.png`), env);
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers.get('content-type'), 'image/png');
  assert.equal(iconRes.headers.get('cache-control'), 'public, max-age=3600');

  const unauthPushRes = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/push/config`), env);
  assert.equal(unauthPushRes.status, 401);

  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  const cfgRes = await call('/api/push/config');
  assert.equal(cfgRes.status, 200);
  const cfgJson = await cfgRes.json();
  assert.equal(cfgJson.enabled, true);
  assert.equal(cfgJson.public_key, vapid.publicKeyB64u);

  const deviceActive = createPushTestDevice();
  const deviceStale = createPushTestDevice();
  const activeEndpoint = 'https://push.apple.example/v1/sub-active-owner';
  const staleEndpoint = 'https://fcm.googleapis.example/v1/sub-stale-410';

  // Reject insecure http:// or localhost SSRF endpoints
  const badSub = await call('/api/push/subscribe', {
    method: 'POST',
    body: { subscription: { endpoint: 'http://localhost/push', keys: { p256dh: deviceActive.p256dh, auth: deviceActive.auth } } },
  });
  assert.equal(badSub.status, 400);

  const subRes1 = await call('/api/push/subscribe', {
    method: 'POST',
    body: {
      subscription: { endpoint: activeEndpoint, keys: { p256dh: deviceActive.p256dh, auth: deviceActive.auth } },
      device_label: 'iPhone PWA',
      morning_digest: true,
    },
  });
  assert.equal(subRes1.status, 200);

  const subRes2 = await call('/api/push/subscribe', {
    method: 'POST',
    body: {
      subscription: { endpoint: staleEndpoint, keys: { p256dh: deviceStale.p256dh, auth: deviceStale.auth } },
      device_label: 'Old Android',
      morning_digest: true,
    },
  });
  assert.equal(subRes2.status, 200);

  // Create an active opportunity with a due follow-up AND a phone number inside next_action to prove zero-PII scrubbing
  const oppRes = await call('/api/opportunities', {
    method: 'POST',
    key: 'push-due-opp-1',
    body: {
      name: 'مالك سري للاختبار',
      phone: '01088776655',
      intent: 'sell',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      next_action: 'اتصال بالمالك على 01088776655 لتأكيد الموعد',
      next_followup_at: '2026-10-29T07:30:00Z',
      notes: 'ملاحظات داخلية سرية',
    },
  });
  assert.equal(oppRes.status, 201);

  const capturedDeliveries = [];
  const mockPushFetch = async (url, init) => {
    if (String(url) === staleEndpoint) return new Response('Gone', { status: 410 });
    capturedDeliveries.push({ url: String(url), headers: init.headers, body: init.body });
    return new Response('', { status: 201 });
  };

  // Run scheduled alerts at 09:45 Africa/Cairo (07:45 UTC on 2026-10-29 -> triggers both due alert + morning digest, and prunes stale 410!)
  const cronStats1 = await runScheduledCrmNotifications(env, {
    now: new Date('2026-10-29T07:45:00Z'),
    fetchImpl: mockPushFetch,
  });
  assert.equal(cronStats1.followup_alerts, 1);
  assert.equal(cronStats1.morning_digest, 1);
  assert.equal(capturedDeliveries.length, 2);

  // Verify stale 410 subscription was automatically pruned from D1
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM crm_push_subscriptions').get().n, 1);

  // Decrypt the actual RFC 8291 ciphertext and verify zero PII leaked (neither owner name nor phone number!)
  const decryptedMessages = capturedDeliveries.map(d => decryptRfc8291PushBody(d.body, deviceActive));
  const dueMsg = decryptedMessages.find(m => m.tag.startsWith('crm-due-'));
  const digestMsg = decryptedMessages.find(m => m.tag.startsWith('crm-digest-'));
  assert.ok(dueMsg, 'Expected decrypted due follow-up push alert');
  assert.ok(digestMsg, 'Expected decrypted morning digest push alert');
  assert.equal(dueMsg.body.includes('01088776655'), false, 'Phone number must be scrubbed from push payload');
  assert.equal(dueMsg.body.includes('مالك سري'), false, 'Customer name must never appear in push payload');
  assert.match(dueMsg.body, /مكرم عبيد/);
  assert.match(digestMsg.body, /1 متابعة مستحقة/);

  // Re-running scheduled job 15 minutes later must NOT duplicate already-sent notifications
  const cronStats2 = await runScheduledCrmNotifications(env, {
    now: new Date('2026-10-29T08:00:00Z'),
    fetchImpl: mockPushFetch,
  });
  assert.equal(cronStats2.followup_alerts, 0);
  assert.equal(cronStats2.morning_digest, 0);
  assert.equal(capturedDeliveries.length, 2);

  // Unsubscribe cleanly
  const unsubRes = await call('/api/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: activeEndpoint },
  });
  assert.equal(unsubRes.status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM crm_push_subscriptions').get().n, 0);

  sqlite.close();
});

test('5-track operational core separates live color tracks from transient archive, supports 1-tap switching, smart matching, and multi-unit contact_key dedup', async () => {
  const keyPair = await generateIngestKeyPair();
  const { sqlite, accessCode, env } = await createEnv({
    extraEnv: { CRM_INGEST_PRIVATE_KEY: keyPair.privateKeyPkcs8B64u },
  });
  const session = await loginSession(env, accessCode);
  const call = makeAuthedApiCall(env, session);

  // 1) Create a 🟢 sale owner, a 🟢 sale buyer, a ✈️ transient apartment seeker, and a ✈️ transient commercial seeker
  const saleOwner = await (await call('/api/opportunities', {
    method: 'POST',
    key: 'track-sale-owner-1',
    body: {
      track: 'sale_apt',
      name: 'مالك شقة مكرم تجريبي',
      phone: '01011223344',
      intent: 'sell',
      source: 'whatsapp',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 5500000,
      budget_max: 5500000,
      size_min_m2: 185,
      size_max_m2: 185,
      next_action: 'تأكيد مفتاح المعاينة',
      next_followup_at: '2026-10-29T12:00:00Z',
    },
  })).json();
  assert.ok(saleOwner.opportunity_id);

  const saleBuyer = await (await call('/api/opportunities', {
    method: 'POST',
    key: 'track-sale-buyer-1',
    body: {
      track: 'sale_apt',
      name: 'مشتري شقة جاد تجريبي',
      phone: '01122334455',
      intent: 'buy',
      source: 'call',
      area_label: 'مكرم عبيد',
      property_type: 'شقة',
      budget_min: 5000000,
      budget_max: 6000000,
      no_followup_reason: 'بانتظار ترشيح مناسب',
    },
  })).json();
  assert.ok(saleBuyer.opportunity_id);

  // Transient ✈️ lead needs NO follow-up date and defaults cleanly to paused
  const transientApt = await (await call('/api/opportunities', {
    method: 'POST',
    key: 'track-transient-apt-1',
    body: {
      track: 'transient',
      name: 'عميل طيارة شقة تجريبي',
      intent: 'buy',
      source: 'whatsapp',
      area_label: 'عباس العقاد',
      property_type: 'شقة',
      notes: 'سأل مرة ومضى لحال سبيله',
    },
  })).json();
  assert.ok(transientApt.opportunity_id);

  const transientShop = await (await call('/api/opportunities', {
    method: 'POST',
    key: 'track-transient-shop-1',
    body: {
      track: 'transient',
      name: 'عميل طيارة محل تجاري تجريبي',
      intent: 'rent',
      source: 'whatsapp',
      area_label: 'مدينة نصر',
      property_type: 'محل تجاري',
      notes: 'كان يبحث عن محل مخبوزات',
    },
  })).json();
  assert.ok(transientShop.opportunity_id);

  // 2) Verify dashboard counts exclude ✈️ transient from active/due queues while reporting per-track supply/demand
  const dash = await (await call('/api/dashboard?day=2026-10-29')).json();
  assert.equal(dash.counts.active, 2, 'Only live non-transient opportunities count as active');
  assert.equal(dash.counts.due_today, 1);
  assert.equal(dash.tracks.sale_apt.total, 2);
  assert.equal(dash.tracks.sale_apt.supply, 1);
  assert.equal(dash.tracks.sale_apt.demand, 1);
  assert.equal(dash.tracks.transient.total, 2);

  // 3) Verify ?track=live, ?track=transient, and ?role=supply|demand filters
  const liveList = await (await call('/api/opportunities?track=live')).json();
  assert.equal(liveList.opportunities.length, 2);
  const supplyList = await (await call('/api/opportunities?track=sale_apt&role=supply')).json();
  assert.equal(supplyList.opportunities.length, 1);
  assert.equal(supplyList.opportunities[0].id, saleOwner.opportunity_id);

  // 4) Verify smart cross-matching for 🟢 sale owner includes 🟢 active buyer + ✈️ apartment seeker, NOT ✈️ shop seeker
  const matchRes = await (await call(`/api/opportunities/${saleOwner.opportunity_id}/matches`)).json();
  assert.equal(matchRes.target_track, 'sale_apt');
  const matchedIds = matchRes.opportunities.map(o => o.id);
  assert.equal(matchedIds.includes(saleBuyer.opportunity_id), true);
  assert.equal(matchedIds.includes(transientApt.opportunity_id), true);
  assert.equal(matchedIds.includes(transientShop.opportunity_id), false);

  // 5) Verify 1-tap track switch: moving 🟢 owner -> ✈️ transient pauses it and clears due follow-up; moving to 🔴 furnished reactivates it
  const toPlane = await (await call(`/api/opportunities/${saleOwner.opportunity_id}/track`, {
    method: 'POST',
    body: { track: 'transient' },
  })).json();
  assert.equal(toPlane.track, 'transient');
  assert.equal(toPlane.status, 'paused');

  const dashAfterPlane = await (await call('/api/dashboard?day=2026-10-29')).json();
  assert.equal(dashAfterPlane.counts.due_today, 0, 'Moving to transient immediately clears daily follow-up clutter');

  const toFurnished = await (await call(`/api/opportunities/${saleOwner.opportunity_id}/track`, {
    method: 'POST',
    body: { track: 'furnished_apt' },
  })).json();
  assert.equal(toFurnished.track, 'furnished_apt');
  assert.equal(toFurnished.status, 'active');

  // 6) Verify sealed ingest contact_key deduplicates multi-unit contacts even without phone numbers
  const multiEnvelope = await sealIngestPayload({
    wipe_existing_customers: true,
    entries: [
      {
        submission_key: 'sealed-multi-no-phone-01',
        contact_key: 'owner-multi-nophone-01',
        track: 'new_rent_apt',
        name: 'مالكة وحدتين بدون رقم تجريبي',
        intent: 'lease',
        source: 'whatsapp',
        area_label: 'مكرم عبيد',
        property_type: 'شقة إيجار جديد',
        budget_min: 20000,
        budget_max: 20000,
        no_followup_reason: 'مسجل بالأرشيف الحي',
      },
      {
        submission_key: 'sealed-multi-no-phone-02',
        contact_key: 'owner-multi-nophone-01',
        track: 'furnished_apt',
        name: 'مالكة وحدتين بدون رقم تجريبي',
        intent: 'lease',
        source: 'whatsapp',
        area_label: 'الحديقة الدولية',
        property_type: 'شقة مفروشة',
        budget_min: 27000,
        budget_max: 27000,
        no_followup_reason: 'مسجل بالأرشيف الحي',
      },
    ],
  }, keyPair.publicKeySpkiB64u);
  const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(multiEnvelope));
  const ticketHash = Buffer.from(digestBuf).toString('hex');
  sqlite.prepare("INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,'opportunity','authorized_pending')")
    .run(`sealed-ticket:${ticketHash}`);
  const ingestRes = await (await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/ingest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed_payload: multiEnvelope }),
  }), env)).json();
  assert.equal(ingestRes.created_contacts, 1, 'Multi-unit phone-less owner must create 1 contact, zero duplicates');
  assert.equal(ingestRes.created_opportunities, 2);

  const contactsAfter = await (await call('/api/contacts')).json();
  assert.equal(contactsAfter.contacts.length, 1);
  assert.equal(contactsAfter.contacts[0].opportunity_count, 2);

  sqlite.close();
});
