import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = String(process.env.CRM_TEST_BASE_URL || '').trim().replace(/\/+$/, '');
const codeFile = String(process.env.CRM_LIVE_ACCESS_CODE_FILE || '').trim();

if (!baseUrl.startsWith('https://')) {
  throw new Error('CRM_TEST_BASE_URL must be an https:// origin');
}
if (!codeFile) {
  throw new Error('CRM_LIVE_ACCESS_CODE_FILE is required');
}

const accessCode = (await readFile(codeFile, 'utf8')).trim();
assert.ok(accessCode.length >= 24, 'Access code must be at least 24 chars');

async function waitForStatus(path, expectedStatus, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    lastStatus = res.status;
    if (res.status === expectedStatus) return res;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`timeout-${expectedStatus}-got-${lastStatus}`);
}

const summary = {};
let currentStep = 'init';

try {
  // 1. Health endpoint
  currentStep = '1-health';
  const healthRes = await waitForStatus('/health', 200);
  const healthJson = await healthRes.json();
  assert.deepEqual(healthJson, { ok: true, service: 'nasr-crm-api' });
  summary.health = 200;

  // 2. Unauthenticated /api/contacts rejected with 401
  currentStep = '2-unauth-get-contacts';
  const unauthContactsRes = await waitForStatus('/api/contacts', 401, 25_000);
  const unauthContactsBody = await unauthContactsRes.json();
  assert.equal(unauthContactsBody.error, 'authentication_required');
  summary.unauth_get_contacts = 401;

  // 3. Unauthenticated dashboard & mutation routes rejected with 401
  currentStep = '3-unauth-dashboard-and-post';
  const unauthDashRes = await fetch(`${baseUrl}/api/dashboard`, { redirect: 'manual' });
  assert.equal(unauthDashRes.status, 401);
  summary.unauth_get_dashboard = 401;

  const unauthPostRes = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': `live-unauth-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ name: 'TEST ONLY unauth' }),
    redirect: 'manual',
  });
  assert.equal(unauthPostRes.status, 401);
  summary.unauth_post_contacts = 401;

  // 4. Static login shell served with 200 + private no-store + CSP and hidden workspace
  currentStep = '4-ui-shell';
  const uiRes = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(uiRes.status, 200, `ui-status-${uiRes.status}`);
  assert.match(uiRes.headers.get('cache-control') || '', /no-store/i);
  assert.equal((uiRes.headers.get('x-frame-options') || '').toUpperCase(), 'DENY');
  assert.match(uiRes.headers.get('content-security-policy') || '', /default-src 'self'/);
  const uiHtml = await uiRes.text();
  assert.match(uiHtml, /id="login-panel"/);
  assert.match(uiHtml, /id="crm-workspace"\s+hidden/);
  summary.ui_shell = 200;

  // 5. Disallowed Origin rejected with 403
  currentStep = '5-bad-origin';
  const badOriginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_code: 'ignored-wrong-origin-code-value' }),
    redirect: 'manual',
  });
  assert.equal(badOriginRes.status, 403, `bad-origin-status-${badOriginRes.status}`);
  assert.equal((await badOriginRes.json()).error, 'origin_not_allowed');
  summary.bad_origin_login = 403;

  // 6. Wrong access code rejected with 401
  currentStep = '6-wrong-code';
  const wrongCodeRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_code: 'invalid-synthetic-passcode-00000000' }),
    redirect: 'manual',
  });
  assert.equal(wrongCodeRes.status, 401, `wrong-code-status-${wrongCodeRes.status}`);
  assert.equal((await wrongCodeRes.json()).error, 'invalid_credentials');
  summary.wrong_code_login = 401;

  // 7. Valid login succeeds and sets __Host-crm_session with HttpOnly + Secure + SameSite=Strict
  currentStep = '7-valid-login';
  let loginRes = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_code: accessCode }),
      redirect: 'manual',
    });
    if (loginRes.status === 200) break;
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  assert.equal(loginRes.status, 200, `login-status-${loginRes.status}`);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /^__Host-crm_session=[A-Za-z0-9_-]{32,128};/);
  assert.match(setCookie, /httponly/i);
  assert.match(setCookie, /secure/i);
  assert.match(setCookie, /samesite=strict/i);
  assert.match(setCookie, /path=\//i);
  assert.match(setCookie, /max-age=28800/i);
  const cookieHeader = setCookie.split(';')[0];
  const loginBody = await loginRes.json();
  assert.equal(loginBody.authenticated, true);
  assert.match(loginBody.csrf_token, /^[A-Za-z0-9_-]{32,128}$/);
  const csrfToken = loginBody.csrf_token;
  summary.valid_login = 200;

  // 8. Authenticated POST without X-CRM-CSRF rejected with 403
  currentStep = '8-missing-csrf';
  const noCsrfRes = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': `live-nocsrf-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ name: 'TEST ONLY no csrf', phones: [{ phone: '01099990001', is_primary: true }] }),
    redirect: 'manual',
  });
  assert.equal(noCsrfRes.status, 403, `nocsrf-status-${noCsrfRes.status}`);
  assert.equal((await noCsrfRes.json()).error, 'csrf_invalid');
  summary.missing_csrf_post = 403;

  // 9. Save synthetic test customer (201)
  currentStep = '9-save-contact';
  const idempotencyKey = `live-e2e-${crypto.randomUUID()}`;
  const createRes = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'TEST ONLY — عميل اختبار حي معزول',
      phones: [{ phone: '01099990001', label: 'اختبار', is_primary: true }],
      communication_consent: 'request_only',
    }),
    redirect: 'manual',
  });
  assert.equal(createRes.status, 201, `create-status-${createRes.status}`);
  const created = await createRes.json();
  assert.match(created.contact_id, /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(created.phone_count, 1);
  summary.save_synthetic_contact = 201;

  // 10. Retrieve synthetic test customer by ID and search query + verify isolated Nasr City listing scope
  currentStep = '10-retrieve-contact-and-listings';
  const detailRes = await fetch(`${baseUrl}/api/contacts/${encodeURIComponent(created.contact_id)}`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(detailRes.status, 200, `detail-status-${detailRes.status}`);
  const detail = await detailRes.json();
  assert.equal(detail.contact.id, created.contact_id);
  assert.equal(detail.contact.name, 'TEST ONLY — عميل اختبار حي معزول');
  assert.equal(detail.phones.length, 1);
  assert.equal(detail.phones[0].phone_key, '201099990001');
  summary.get_synthetic_contact = 200;

  const searchRes = await fetch(`${baseUrl}/api/contacts?q=01099990001`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(searchRes.status, 200, `search-status-${searchRes.status}`);
  const searchBody = await searchRes.json();
  assert.ok(searchBody.contacts.some(item => item.id === created.contact_id));
  summary.search_synthetic_contact = 200;

  const listingsRes = await fetch(`${baseUrl}/api/listings`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(listingsRes.status, 200, `listings-status-${listingsRes.status}`);
  const listingsBody = await listingsRes.json();
  assert.equal(listingsBody.listings.length, 1);
  assert.equal(listingsBody.listings[0].external_id, 'crm-test-only-inside');
  summary.scoped_listings = 200;

  // 11. Logout revokes session in D1 and clears cookie
  currentStep = '11-logout';
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'content-type': 'application/json',
    },
    body: '{}',
    redirect: 'manual',
  });
  assert.equal(logoutRes.status, 200, `logout-status-${logoutRes.status}`);
  assert.match(logoutRes.headers.get('set-cookie') || '', /max-age=0/i);
  summary.logout = 200;

  // 12. Replaying the revoked session cookie after logout is rejected with 401
  currentStep = '12-post-logout-replay';
  const postLogoutGet = await fetch(`${baseUrl}/api/contacts/${encodeURIComponent(created.contact_id)}`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(postLogoutGet.status, 401, `post-logout-status-${postLogoutGet.status}`);
  summary.post_logout_replay_rejected = 401;

  process.stdout.write(`${JSON.stringify({ ok: true, contact_id: created.contact_id, summary })}\n`);
} catch (error) {
  const safeReason = String(error?.message || 'assertion').replace(/[^A-Za-z0-9_:-]/g, '-').slice(0, 60);
  process.stdout.write(`${JSON.stringify({ ok: false, failed_step: currentStep, reason: safeReason })}\n`);
  process.exit(1);
}
