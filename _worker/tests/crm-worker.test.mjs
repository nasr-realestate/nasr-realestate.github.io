import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker, { createAccessCodeVerifier, generateIngestKeyPair, sealIngestPayload } from '../crm-worker.js';

const migration0001 = await readFile(new URL('../migrations/0001_crm_opportunities.sql', import.meta.url), 'utf8');
const migration0002 = await readFile(new URL('../migrations/0002_crm_internal_auth.sql', import.meta.url), 'utf8');
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
      if (pathname === '/crm-client.js' || pathname === '/crm-assets/app.js') {
        return new Response('export default true;', {
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
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

  // 2. Sealed-box encrypted ingest rejects un-ticketed ciphertexts, accepts ticketed ciphertext once, and blocks replay
  const sealedEnvelope = await sealIngestPayload({
    entries: [
      {
        submission_key: 'sealed-owner-test-0001',
        name: 'عميل مشفر تجريبي',
        phone: '+20 15 50001122',
        phone_label: 'واتساب',
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
  assert.equal(acceptedJson.processed, 1);
  assert.equal(acceptedJson.created_contacts, 1);
  assert.equal(acceptedJson.created_opportunities, 1);
  assert.equal(acceptedJson.linked_properties, 1);

  const replay = await worker.fetch(new Request(`${ALLOWED_ORIGIN}/api/ingest/sealed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sealed_payload: sealedEnvelope }),
  }), env);
  assert.equal(replay.status, 403);

  const opps = await (await call('/api/opportunities?status=active')).json();
  const sealedOpp = opps.opportunities.find(o => o.contact_name === 'عميل مشفر تجريبي');
  assert.ok(sealedOpp, 'Expected decrypted opportunity in D1');
  assert.equal(sealedOpp.phone_key, '201550001122');

  sqlite.close();
});
