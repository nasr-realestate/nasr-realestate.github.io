// Live Post-Deploy HTTP + Desktop & Mobile Browser Verification for nasr-crm-api-test.
// Outputs strictly non-PII aggregate JSON metrics. Never logs customer names, phones, or chat bodies.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = String(process.env.CRM_TEST_BASE_URL || '').trim().replace(/\/+$/, '');
const codeFile = String(process.env.CRM_LIVE_ACCESS_CODE_FILE || '').trim();
const ciTicketNonce = String(process.env.CRM_CI_TICKET_NONCE || '').trim();

if (!baseUrl.startsWith('https://')) {
  throw new Error('CRM_TEST_BASE_URL must be an https:// origin');
}
if (!codeFile && !ciTicketNonce) {
  throw new Error('Either CRM_LIVE_ACCESS_CODE_FILE or CRM_CI_TICKET_NONCE is required');
}

function extractSessionCookie(setCookieHeader) {
  const raw = String(setCookieHeader || '');
  const firstPart = raw.split(';')[0]?.trim() || '';
  assert.ok(firstPart.includes('='), 'Missing session cookie in Set-Cookie header');
  const eqIdx = firstPart.indexOf('=');
  return {
    rawPair: firstPart,
    name: firstPart.slice(0, eqIdx),
    value: firstPart.slice(eqIdx + 1),
  };
}

function buildRequestHeaders({ cookie = '', csrf = '', key = '', hasBody = false } = {}) {
  const headers = { origin: baseUrl };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-crm-csrf'] = csrf;
  if (key) headers['idempotency-key'] = key;
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

async function apiCall(path, { method = 'GET', cookie = '', csrf = '', key = '', body } = {}) {
  const hasBody = body !== undefined;
  const headers = buildRequestHeaders({ cookie, csrf, key, hasBody });
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data };
}

async function verifyUnauthenticatedLockdown() {
  const protectedPaths = [
    '/api/dashboard',
    '/api/contacts',
    '/api/opportunities',
    '/api/conversations',
    '/api/followups',
    '/api/push/config',
  ];
  for (const p of protectedPaths) {
    const res = await apiCall(p);
    assert.equal(res.status, 401, `Expected 401 before login on ${p}, got ${res.status}`);
  }
  const wrongLogin = await apiCall('/api/auth/login', {
    method: 'POST',
    body: { access_code: 'wrong-invalid-access-code-check-0000' },
  });
  assert.equal(wrongLogin.status, 401, 'Invalid access code must return 401');
}

async function authenticateLiveSession() {
  if (codeFile) {
    const code = (await readFile(codeFile, 'utf8')).trim();
    const res = await apiCall('/api/auth/login', {
      method: 'POST',
      body: { access_code: code },
    });
    assert.equal(res.status, 200, `Login with access code failed: ${res.status}`);
    const parsedCookie = extractSessionCookie(res.headers.get('set-cookie'));
    return {
      mode: 'access_code_login',
      cookiePair: parsedCookie.rawPair,
      cookieName: parsedCookie.name,
      cookieValue: parsedCookie.value,
      csrf: String(res.data.csrf_token || ''),
    };
  }
  const res = await apiCall('/api/auth/ci-ticket', {
    method: 'POST',
    body: { ticket_nonce: ciTicketNonce },
  });
  assert.equal(res.status, 200, `CI ticket login failed: ${res.status}`);
  const parsedCookie = extractSessionCookie(res.headers.get('set-cookie'));
  return {
    mode: 'ci_ticket_preserving_owner_secret',
    cookiePair: parsedCookie.rawPair,
    cookieName: parsedCookie.name,
    cookieValue: parsedCookie.value,
    csrf: String(res.data.csrf_token || ''),
  };
}

function isNotTestRow(label) {
  return !String(label || '').startsWith('TEST ONLY');
}

async function verifyLiveCoreRecords(auth) {
  const dash = await apiCall('/api/dashboard', { cookie: auth.cookiePair });
  assert.equal(dash.status, 200);
  const openAlertsBefore = Number(dash.data?.counts?.open_smart_alerts ?? 0);
  assert.ok(openAlertsBefore >= 66, `Expected >=66 open alerts, got ${openAlertsBefore}`);

  const contactsRes = await apiCall('/api/contacts', { cookie: auth.cookiePair });
  assert.equal(contactsRes.status, 200);
  const contacts = (contactsRes.data.contacts || []).filter(c => isNotTestRow(c.name));
  const totalPhones = contacts.reduce((s, c) => s + Number(c.phone_count || 0), 0);
  assert.equal(contacts.length, 60, `Expected 60 contacts, got ${contacts.length}`);
  assert.equal(totalPhones, 64, `Expected 64 phones, got ${totalPhones}`);

  const oppsRes = await apiCall('/api/opportunities', { cookie: auth.cookiePair });
  assert.equal(oppsRes.status, 200);
  const opps = (oppsRes.data.opportunities || []).filter(o => isNotTestRow(o.notes));
  assert.equal(opps.length, 83, `Expected 83 opportunities, got ${opps.length}`);

  const contactlessOpps = opps.filter(o => !o.contact_id);
  assert.equal(contactlessOpps.length, 19, `Expected 19 independent contactless opportunities, got ${contactlessOpps.length}`);

  let verifiedActivities = 0;
  for (const co of contactlessOpps) {
    const det = await apiCall(`/api/opportunities/${co.id}`, { cookie: auth.cookiePair });
    assert.equal(det.status, 200, `Failed reading opportunity ${co.id}`);
    assert.equal(det.data?.opportunity?.id, co.id);
    const acts = Array.isArray(det.data?.activities) ? det.data.activities : [];
    assert.ok(acts.length >= 1, `Missing activities on ${co.id}`);
    verifiedActivities += acts.length;
  }

  return {
    contacts: contacts.length,
    phones: totalPhones,
    opportunities: opps.length,
    independent_opportunities: contactlessOpps.length,
    independent_activities: verifiedActivities,
    open_alerts: openAlertsBefore,
  };
}

async function verifyLiveConversationsAndAlerts(auth) {
  const convsRes = await apiCall('/api/conversations', { cookie: auth.cookiePair });
  assert.equal(convsRes.status, 200);
  const convs = (convsRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  const totalMsgs = convs.reduce((s, c) => s + Number(c.message_count || 0), 0);
  assert.equal(convs.length, 76, `Expected 76 conversations, got ${convs.length}`);
  assert.equal(totalMsgs, 2984, `Expected 2984 messages, got ${totalMsgs}`);

  const unmRes = await apiCall('/api/conversations?match_status=unmatched_review', { cookie: auth.cookiePair });
  assert.equal(unmRes.status, 200);
  const unm = (unmRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  assert.equal(unm.length, 21, `Expected 21 unmatched_review conversations, got ${unm.length}`);
  assert.equal(unm.every(c => c.contact_id === null), true, 'Unmatched review conversations must have contact_id = null');

  const fuRes = await apiCall('/api/followups', { cookie: auth.cookiePair });
  assert.equal(fuRes.status, 200);
  const fuUnmatched = (fuRes.data.unmatched_review || []).filter(c => isNotTestRow(c.chat_title));
  assert.equal(fuUnmatched.length, 21);

  const alertIds = [
    ...(fuRes.data.waiting_reply || []).map(a => a.id),
    ...(fuRes.data.stalled_intervention || []).filter(a => !String(a.id || '').startsWith('stalled-opp:')).map(a => a.id),
    ...(fuRes.data.new_chat_alerts || []).map(a => a.id),
  ].filter(Boolean);
  assert.equal(alertIds.length, new Set(alertIds).size, 'Duplicate smart alert IDs detected in followups queues');

  const searchRes = await apiCall('/api/conversations?match_status=unmatched_review&q=%D8%AF%D8%B1%D8%AF%D8%B4%D8%A9', {
    cookie: auth.cookiePair,
  });
  assert.equal(searchRes.status, 200);
  assert.ok((searchRes.data.conversations || []).length >= 1, 'Search in unmatched_review returned 0 results');

  return {
    conversations: convs.length,
    messages: totalMsgs,
    unmatched_review: unm.length,
  };
}

async function verifySyntheticManualLink(auth) {
  const imp = await apiCall('/api/conversations/import', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    body: {
      chat_title: 'TEST ONLY — محادثة فحص ما بعد النشر',
      source_ref: 'post_deploy_e2e_synthetic',
      raw_text: '30/10/2026, 2:00 م - عميل فحص: تجربة ربط يدوي آمن بعد النشر',
    },
  });
  assert.ok(imp.status === 200 || imp.status === 201, `Synthetic conv import failed: ${imp.status}`);
  const convId = String(imp.data.conversation_id || '');
  assert.ok(convId.length >= 8);
  assert.equal(imp.data.match_status, 'unmatched_review');

  const cRes = await apiCall('/api/contacts', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    key: `post-deploy-synth-${crypto.randomUUID()}`,
    body: {
      name: 'TEST ONLY — عميل فحص الربط',
      phones: [{ phone: '01099990077', label: 'فحص', is_primary: true }],
    },
  });
  assert.equal(cRes.status, 201, `Synthetic contact create failed: ${cRes.status}`);
  const contactId = String(cRes.data.contact_id || '');
  assert.ok(contactId.length >= 8);

  const linkRes = await apiCall(`/api/conversations/${convId}/link-contact`, {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    body: { contact_id: contactId },
  });
  assert.equal(linkRes.status, 200, `Manual conversation link failed: ${linkRes.status}`);
  assert.equal(linkRes.data.match_status, 'resolved_manual');
  assert.equal(linkRes.data.contact_id, contactId);

  return { synthetic_conversation_id: convId, synthetic_contact_id: contactId };
}

async function verifyAnonBrowser(browser, pageErrors) {
  const anonCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-EG' });
  const anonPage = await anonCtx.newPage();
  anonPage.on('pageerror', err => pageErrors.push(`anon:${String(err?.message || err).slice(0, 50)}`));
  const nav = await anonPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  assert.equal(nav.status(), 200);
  await anonPage.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
  await anonPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await anonPage.locator('#crm-workspace').isHidden(), true);
  assert.equal((await anonPage.locator('#contact-results').textContent() || '').trim(), '');
  await anonCtx.close();
}

async function verifyDesktopBrowser(browser, auth, host, pageErrors) {
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-EG' });
  await deskCtx.addCookies([{
    name: auth.cookieName,
    value: auth.cookieValue,
    domain: host,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  }]);
  const deskPage = await deskCtx.newPage();
  deskPage.on('pageerror', err => pageErrors.push(`desk:${String(err?.message || err).slice(0, 50)}`));
  await deskPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await deskPage.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
  await deskPage.locator('#crm-workspace').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await deskPage.locator('#login-panel').isHidden(), true);

  await deskPage.locator('.tab[data-panel="followups-panel"]').click();
  await deskPage.locator('#followups-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await deskPage.locator('[data-followup-queue="unmatched_review"]').click();
  await deskPage.locator('#followups-list .followup-alert-card').first().waitFor({ state: 'visible', timeout: 15_000 });
  const deskUnmatchedCards = await deskPage.locator('#followups-list .followup-alert-card').count();
  assert.ok(deskUnmatchedCards >= 21, `Expected >=21 unmatched cards in desktop UI, got ${deskUnmatchedCards}`);
  await deskPage.locator('#followups-list .followup-alert-card button').first().click();
  await deskPage.locator('#conversation-viewer .chat-bubble').first().waitFor({ state: 'visible', timeout: 15_000 });
  await deskCtx.close();
}

async function verifyMobileBrowser(browser, auth, host, pageErrors) {
  const mobCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ar-EG',
  });
  await mobCtx.addCookies([{
    name: auth.cookieName,
    value: auth.cookieValue,
    domain: host,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  }]);
  const mobPage = await mobCtx.newPage();
  mobPage.on('pageerror', err => pageErrors.push(`mob:${String(err?.message || err).slice(0, 50)}`));
  const cdp = await mobCtx.newCDPSession(mobPage);
  await mobPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await mobPage.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
  await mobPage.locator('#crm-workspace').waitFor({ state: 'visible', timeout: 15_000 });

  const swReady = await mobPage.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg?.active && reg.scope.endsWith('/'));
  });
  assert.equal(swReady, true, 'Service Worker must be active on mobile');
  const mf = await cdp.send('Page.getAppManifest');
  assert.deepEqual(mf.errors || [], []);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(inst.installabilityErrors || [], []);

  await mobPage.locator('.tab[data-panel="contacts-panel"]').click();
  await mobPage.locator('#contacts-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await mobPage.locator('#contact-results .record').first().waitFor({ state: 'visible', timeout: 15_000 });
  await mobPage.locator('#contact-results .record').first().click();
  await mobPage.locator('#record-sheet').waitFor({ state: 'visible', timeout: 10_000 });
  await mobPage.locator('#record-sheet-close').click();

  await mobPage.locator('#logout-button').click();
  await mobPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await mobPage.locator('#crm-workspace').isHidden(), true);
  await mobCtx.close();
}

async function verifyDesktopAndMobileBrowsers(auth) {
  const host = new URL(baseUrl).hostname;
  const pageErrors = [];
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyAnonBrowser(browser, pageErrors);
    await verifyDesktopBrowser(browser, auth, host, pageErrors);
    await verifyMobileBrowser(browser, auth, host, pageErrors);
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], `Browser console/page errors: ${pageErrors.join(';')}`);
  return { desktop_ui: 'verified', mobile_ui: 'verified', unauth_ui_locked: 'verified' };
}

async function main() {
  await verifyUnauthenticatedLockdown();
  const auth = await authenticateLiveSession();
  const coreMetrics = await verifyLiveCoreRecords(auth);
  const convMetrics = await verifyLiveConversationsAndAlerts(auth);
  const synth = await verifySyntheticManualLink(auth);
  const ui = await verifyDesktopAndMobileBrowsers(auth);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    auth_mode: auth.mode,
    metrics: { ...coreMetrics, ...convMetrics },
    synthetic_ids: synth,
    ui,
  })}\n`);
}

await main();
