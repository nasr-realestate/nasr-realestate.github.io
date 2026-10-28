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

  // 2. Unauthenticated rejection across all CRM routes
  currentStep = '2-unauth-routes';
  const unauthContactsRes = await waitForStatus('/api/contacts', 401, 25_000);
  assert.equal((await unauthContactsRes.json()).error, 'authentication_required');
  for (const path of ['/api/auth/session', '/api/dashboard', '/api/opportunities', '/api/listings']) {
    const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 401, `unauth-${path}-${res.status}`);
  }
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
  summary.unauth_rejected = 401;

  // 3. All UI assets served with 200 + private no-store + strict CSP and hidden workspace
  currentStep = '3-ui-bundle';
  const uiRes = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(uiRes.status, 200, `ui-status-${uiRes.status}`);
  assert.match(uiRes.headers.get('cache-control') || '', /no-store/i);
  assert.equal((uiRes.headers.get('x-frame-options') || '').toUpperCase(), 'DENY');
  assert.match(uiRes.headers.get('content-security-policy') || '', /default-src 'self'/);
  const uiHtml = await uiRes.text();
  assert.match(uiHtml, /id="login-panel"/);
  assert.match(uiHtml, /id="crm-workspace"\s+hidden/);
  for (const assetPath of ['/crm-assets/app.css', '/crm-assets/app.js', '/crm-client.js']) {
    const assetRes = await fetch(`${baseUrl}${assetPath}`, { redirect: 'manual' });
    assert.equal(assetRes.status, 200, `asset-${assetPath}-${assetRes.status}`);
    assert.match(assetRes.headers.get('cache-control') || '', /no-store/i);
  }
  summary.ui_bundle = 200;

  // 4. CORS preflight, Origin, and Sec-Fetch-Site protection
  currentStep = '4-cors-origin-guards';
  const badCors = await fetch(`${baseUrl}/api/contacts`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
    redirect: 'manual',
  });
  assert.equal(badCors.status, 403);
  const okCors = await fetch(`${baseUrl}/api/contacts`, {
    method: 'OPTIONS',
    headers: { origin: baseUrl },
    redirect: 'manual',
  });
  assert.equal(okCors.status, 204);

  const badOriginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ access_code: 'ignored-wrong-origin-code-value' }),
    redirect: 'manual',
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal((await badOriginRes.json()).error, 'origin_not_allowed');

  const crossSiteRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: JSON.stringify({ access_code: 'ignored-cross-site-value' }),
    redirect: 'manual',
  });
  assert.equal(crossSiteRes.status, 403);
  summary.origin_and_cors = 403;

  // 5. Wrong access code rejected with 401
  currentStep = '5-wrong-code';
  const wrongCodeRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ access_code: 'invalid-synthetic-passcode-00000000' }),
    redirect: 'manual',
  });
  assert.equal(wrongCodeRes.status, 401);
  assert.equal((await wrongCodeRes.json()).error, 'invalid_credentials');
  summary.wrong_code_login = 401;

  // 6. Valid login + session status verification (browser reload check)
  currentStep = '6-valid-login';
  let loginRes = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
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

  const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(sessionRes.status, 200);
  const sessionBody = await sessionRes.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.csrf_token, csrfToken);
  summary.valid_login_and_session = 200;

  // 7. Authenticated POST without X-CRM-CSRF rejected with 403
  currentStep = '7-missing-csrf';
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
  assert.equal(noCsrfRes.status, 403);
  assert.equal((await noCsrfRes.json()).error, 'csrf_invalid');
  summary.missing_csrf_post = 403;

  // 8. Save synthetic customer + add secondary phone + retrieve customer
  currentStep = '8-customer-crud';
  const createRes = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'idempotency-key': `live-e2e-contact-${crypto.randomUUID()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'TEST ONLY — عميل اختبار حي معزول',
      phones: [{ phone: '01099990001', label: 'أساسي', is_primary: true }],
      communication_consent: 'request_only',
    }),
    redirect: 'manual',
  });
  assert.equal(createRes.status, 201, `create-status-${createRes.status}`);
  const created = await createRes.json();
  assert.match(created.contact_id, /^[A-Za-z0-9_-]{8,80}$/);

  const addPhoneRes = await fetch(`${baseUrl}/api/contacts/${encodeURIComponent(created.contact_id)}/phones`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ phone: '01199990002', label: 'عمل', is_primary: false }),
    redirect: 'manual',
  });
  assert.equal(addPhoneRes.status, 200);

  const detailRes = await fetch(`${baseUrl}/api/contacts/${encodeURIComponent(created.contact_id)}`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.contact.id, created.contact_id);
  assert.equal(detail.phones.length, 2);
  summary.customer_crud = 200;

  // 9. Create synthetic opportunity + link Nasr City listing + log follow-up + verify dashboard
  currentStep = '9-opportunity-lifecycle';
  const oppRes = await fetch(`${baseUrl}/api/opportunities`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'idempotency-key': `live-e2e-opp-${crypto.randomUUID()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contact_id: created.contact_id,
      intent: 'buy',
      source: 'call',
      status: 'active',
      area_label: 'الحي العاشر',
      property_type: 'شقة',
      budget_min: 3000000,
      budget_max: 4500000,
      next_action: 'إرسال خيارات مدينة نصر',
      next_followup_at: '2026-10-28T16:00:00Z',
      notes: 'TEST ONLY — فرصة اختبار معزولة',
    }),
    redirect: 'manual',
  });
  assert.equal(oppRes.status, 201, `opp-status-${oppRes.status}`);
  const { opportunity_id: oppId } = await oppRes.json();

  const outOfScopeLink = await fetch(`${baseUrl}/api/opportunities/${encodeURIComponent(oppId)}/properties`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ external_id: 'crm-test-only-outside' }),
    redirect: 'manual',
  });
  assert.equal(outOfScopeLink.status, 404);

  const inScopeLink = await fetch(`${baseUrl}/api/opportunities/${encodeURIComponent(oppId)}/properties`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ external_id: 'crm-test-only-inside', presentation_status: 'presented' }),
    redirect: 'manual',
  });
  assert.equal(inScopeLink.status, 200);

  const activityRes = await fetch(`${baseUrl}/api/opportunities/${encodeURIComponent(oppId)}/activities`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'x-crm-csrf': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      activity_type: 'call',
      summary: 'TEST ONLY — متابعة اختبار',
      next_action: 'تأكيد موعد المعاينة',
      next_followup_at: '2026-10-29T12:00:00Z',
    }),
    redirect: 'manual',
  });
  assert.equal(activityRes.status, 200);

  const oppDetailRes = await fetch(`${baseUrl}/api/opportunities/${encodeURIComponent(oppId)}`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(oppDetailRes.status, 200);
  const oppDetail = await oppDetailRes.json();
  assert.equal(oppDetail.properties.length, 1);
  assert.ok(oppDetail.activities.length >= 2);

  const dashRes = await fetch(`${baseUrl}/api/dashboard?day=2026-10-29`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(dashRes.status, 200);
  assert.ok((await dashRes.json()).counts.active >= 1);
  summary.opportunity_and_dashboard = 200;

  // 10. Logout revokes session in D1 and clears cookie
  currentStep = '10-logout';
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
  assert.equal(logoutRes.status, 200);
  assert.match(logoutRes.headers.get('set-cookie') || '', /max-age=0/i);
  summary.logout = 200;

  // 11. Replaying the revoked session cookie after logout is rejected with 401
  currentStep = '11-post-logout-replay';
  const postLogoutGet = await fetch(`${baseUrl}/api/contacts/${encodeURIComponent(created.contact_id)}`, {
    headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  assert.equal(postLogoutGet.status, 401);
  summary.post_logout_replay_rejected = 401;

  process.stdout.write(`${JSON.stringify({ ok: true, contact_id: created.contact_id, opportunity_id: oppId, summary })}\n`);
} catch (error) {
  const safeReason = String(error?.message || 'assertion').replace(/[^A-Za-z0-9_:-]/g, '-').slice(0, 60);
  process.stdout.write(`${JSON.stringify({ ok: false, failed_step: currentStep, reason: safeReason })}\n`);
  process.exit(1);
}
