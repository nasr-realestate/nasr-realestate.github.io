// Live Post-Deploy HTTP + Desktop & Mobile Browser Verification for nasr-crm-api-test.
// Outputs strictly non-PII aggregate JSON metrics. Never logs customer names, phones, or chat bodies.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = String(process.env.CRM_TEST_BASE_URL || '').trim().replace(/\/+$/, '');
const codeFile = String(process.env.CRM_LIVE_ACCESS_CODE_FILE || '').trim();
const ciTicketNonces = String(process.env.CRM_CI_TICKET_NONCES || process.env.CRM_CI_TICKET_NONCE || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!baseUrl.startsWith('https://')) {
  throw new Error('CRM_TEST_BASE_URL must be an https:// origin');
}
if (!codeFile && ciTicketNonces.length < 3) {
  throw new Error('Either CRM_LIVE_ACCESS_CODE_FILE or 3 CRM_CI_TICKET_NONCES are required');
}

let activeStep = 'init';

function extractCookiePair(setCookieHeader) {
  const firstPart = String(setCookieHeader || '').split(';')[0]?.trim() || '';
  assert.ok(firstPart.includes('='), 'missing-set-cookie');
  return firstPart;
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
  activeStep = 'check9-unauth-http';
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
    assert.equal(res.status, 401, `unauth-${p}-${res.status}`);
  }
  const wrongLogin = await apiCall('/api/auth/login', {
    method: 'POST',
    body: { access_code: 'wrong-invalid-access-code-check-0000' },
  });
  assert.equal(wrongLogin.status, 401, 'wrong-code-not-401');
}

async function authenticateHttpSession() {
  activeStep = 'check1-http-login';
  if (codeFile) {
    const code = (await readFile(codeFile, 'utf8')).trim();
    const res = await apiCall('/api/auth/login', {
      method: 'POST',
      body: { access_code: code },
    });
    assert.equal(res.status, 200, `code-login-${res.status}`);
    return {
      mode: 'access_code_login',
      accessCode: code,
      cookiePair: extractCookiePair(res.headers.get('set-cookie')),
      csrf: String(res.data.csrf_token || ''),
    };
  }
  const res = await apiCall('/api/auth/ci-ticket', {
    method: 'POST',
    body: { ticket_nonce: ciTicketNonces[0] },
  });
  assert.equal(res.status, 200, `ci-ticket-http-${res.status}`);
  return {
    mode: 'ci_ticket_preserving_owner_secret',
    accessCode: '',
    cookiePair: extractCookiePair(res.headers.get('set-cookie')),
    csrf: String(res.data.csrf_token || ''),
  };
}

function isNotTestRow(label) {
  return !String(label || '').startsWith('TEST ONLY');
}

async function verifyLiveCoreRecords(auth) {
  activeStep = 'check2-contacts-opps';
  const dash = await apiCall('/api/dashboard', { cookie: auth.cookiePair });
  assert.equal(dash.status, 200, 'dash-status');
  const openAlertsBefore = Number(dash.data?.counts?.open_smart_alerts ?? 0);
  assert.ok(openAlertsBefore >= 66, `alerts-lt-66-${openAlertsBefore}`);

  const contactsRes = await apiCall('/api/contacts', { cookie: auth.cookiePair });
  assert.equal(contactsRes.status, 200, 'contacts-status');
  const contacts = (contactsRes.data.contacts || []).filter(c => isNotTestRow(c.name));
  const totalPhones = contacts.reduce((s, c) => s + Number(c.phone_count || 0), 0);
  assert.equal(contacts.length, 60, `contacts-cnt-${contacts.length}`);
  assert.equal(totalPhones, 64, `phones-cnt-${totalPhones}`);

  const oppsRes = await apiCall('/api/opportunities', { cookie: auth.cookiePair });
  assert.equal(oppsRes.status, 200, 'opps-status');
  const opps = (oppsRes.data.opportunities || []).filter(o => isNotTestRow(o.notes));
  assert.equal(opps.length, 83, `opps-cnt-${opps.length}`);

  activeStep = 'check6-19-independent-opps';
  const contactlessOpps = opps.filter(o => !o.contact_id);
  assert.equal(contactlessOpps.length, 19, `contactless-cnt-${contactlessOpps.length}`);

  let verifiedActivities = 0;
  for (const co of contactlessOpps) {
    const det = await apiCall(`/api/opportunities/${co.id}`, { cookie: auth.cookiePair });
    assert.equal(det.status, 200, `opp-det-${det.status}`);
    assert.equal(det.data?.opportunity?.id, co.id, 'opp-id-mismatch');
    assert.ok(String(det.data?.opportunity?.contact_name || det.data?.opportunity?.lead_label || '').length > 0, 'opp-label-empty');
    const acts = Array.isArray(det.data?.activities) ? det.data.activities : [];
    verifiedActivities += acts.length;
  }
  assert.ok(verifiedActivities >= 22, `contactless-acts-${verifiedActivities}`);

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
  activeStep = 'check3-convs-msgs';
  const convsRes = await apiCall('/api/conversations', { cookie: auth.cookiePair });
  assert.equal(convsRes.status, 200, 'convs-status');
  const convs = (convsRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  const totalMsgs = convs.reduce((s, c) => s + Number(c.message_count || 0), 0);
  assert.equal(convs.length, 76, `convs-cnt-${convs.length}`);
  assert.equal(totalMsgs, 2984, `msgs-cnt-${totalMsgs}`);

  activeStep = 'check4-unmatched-21';
  const unmRes = await apiCall('/api/conversations?match_status=unmatched_review', { cookie: auth.cookiePair });
  assert.equal(unmRes.status, 200, 'unm-status');
  const unm = (unmRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  assert.equal(unm.length, 21, `unm-cnt-${unm.length}`);
  assert.equal(unm.every(c => c.contact_id === null), true, 'unm-contact-not-null');

  activeStep = 'check5-alerts-dedup';
  const fuRes = await apiCall('/api/followups', { cookie: auth.cookiePair });
  assert.equal(fuRes.status, 200, 'fu-status');
  const fuUnmatched = (fuRes.data.unmatched_review || []).filter(c => isNotTestRow(c.chat_title));
  assert.equal(fuUnmatched.length, 21, `fu-unm-cnt-${fuUnmatched.length}`);

  const alertIds = [
    ...(fuRes.data.waiting_reply || []).map(a => a.alert_id || a.id),
    ...(fuRes.data.stalled_intervention || []).filter(a => a.item_kind === 'smart_alert').map(a => a.alert_id || a.id),
    ...(fuRes.data.new_chat_alerts || []).map(a => a.alert_id || a.id),
  ].filter(Boolean);
  assert.equal(alertIds.length, new Set(alertIds).size, 'dup-alert-ids');

  activeStep = 'check7a-conv-search';
  const searchRes = await apiCall('/api/conversations?match_status=unmatched_review&q=%D8%AF%D8%B1%D8%AF%D8%B4%D8%A9', {
    cookie: auth.cookiePair,
  });
  assert.equal(searchRes.status, 200, 'search-status');
  assert.ok((searchRes.data.conversations || []).length >= 1, 'search-empty');

  return {
    conversations: convs.length,
    messages: totalMsgs,
    unmatched_review: unm.length,
  };
}

async function verifySyntheticManualLink(auth) {
  activeStep = 'check7b-manual-link';
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
  assert.ok(imp.status === 200 || imp.status === 201, `synth-imp-${imp.status}`);
  const convId = String(imp.data.conversation_id || '');
  assert.ok(convId.length >= 8, 'synth-conv-id');
  assert.equal(imp.data.match_status, 'unmatched_review', 'synth-imp-match');

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
  assert.equal(cRes.status, 201, `synth-contact-${cRes.status}`);
  const contactId = String(cRes.data.contact_id || '');
  assert.ok(contactId.length >= 8, 'synth-contact-id');

  const linkRes = await apiCall(`/api/conversations/${convId}/link-contact`, {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    body: { contact_id: contactId },
  });
  assert.equal(linkRes.status, 200, `synth-link-${linkRes.status}`);
  assert.equal(linkRes.data.ok, true, 'synth-link-ok');
  assert.equal(linkRes.data.contact_id, contactId, 'synth-link-cid');

  const verifyConv = await apiCall(`/api/conversations/${convId}`, { cookie: auth.cookiePair });
  assert.equal(verifyConv.status, 200, `synth-det-${verifyConv.status}`);
  assert.equal(verifyConv.data?.conversation?.match_status, 'resolved_manual', 'synth-det-status');
  assert.equal(verifyConv.data?.conversation?.contact_id, contactId, 'synth-det-cid');

  await apiCall('/api/auth/logout', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
  });

  return { synthetic_conversation_id: convId, synthetic_contact_id: contactId };
}

async function loginPageSession(page, auth, ticketNonce) {
  if (auth.accessCode) {
    await page.locator('#access-code-input').fill(auth.accessCode);
    await page.locator('#login-submit').click();
  } else {
    const status = await page.evaluate(async nonce => {
      const r = await fetch('/api/auth/ci-ticket', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket_nonce: nonce }),
      });
      return r.status;
    }, ticketNonce);
    assert.equal(status, 200, `browser-ci-ticket-${status}`);
    await page.reload({ waitUntil: 'networkidle' });
  }
  await page.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });
  await page.locator('#crm-workspace').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await page.locator('#login-panel').isHidden(), true, 'login-panel-still-visible');
}

async function verifyDesktopBrowser(browser, auth, pageErrors) {
  activeStep = 'check8a-desktop-ui';
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-EG' });
  const deskPage = await deskCtx.newPage();
  deskPage.on('pageerror', err => pageErrors.push(`desk:${String(err?.message || err).slice(0, 40)}`));
  const nav = await deskPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  assert.equal(nav.status(), 200, 'desk-nav-status');
  await deskPage.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });

  // Check 9 in real browser: zero private data visible before login
  await deskPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await deskPage.locator('#crm-workspace').isHidden(), true, 'anon-workspace-visible');
  assert.equal((await deskPage.locator('#contact-results').textContent() || '').trim(), '', 'anon-contacts-nonempty');

  await loginPageSession(deskPage, auth, ciTicketNonces[1]);

  await deskPage.locator('.tab[data-panel="followups-panel"]').click();
  await deskPage.locator('#followups-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await deskPage.locator('[data-followup-queue="unmatched_review"]').click();
  await deskPage.locator('#followups-list .followup-alert-card').first().waitFor({ state: 'visible', timeout: 15_000 });
  const deskUnmatchedCards = await deskPage.locator('#followups-list .followup-alert-card').count();
  assert.ok(deskUnmatchedCards >= 21, `desk-unm-cards-${deskUnmatchedCards}`);
  await deskPage.locator('#followups-list .followup-alert-card button').first().click();
  await deskPage.locator('#conversation-viewer .chat-bubble').first().waitFor({ state: 'visible', timeout: 15_000 });
  await deskPage.locator('#logout-button').click();
  await deskPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 15_000 });
  await deskCtx.close();
}

async function verifyMobileBrowser(browser, auth, pageErrors) {
  activeStep = 'check8b-mobile-ui';
  const mobCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ar-EG',
  });
  const mobPage = await mobCtx.newPage();
  mobPage.on('pageerror', err => pageErrors.push(`mob:${String(err?.message || err).slice(0, 40)}`));
  const cdp = await mobCtx.newCDPSession(mobPage);
  await mobPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await mobPage.locator('html[data-crm-ready="true"]').waitFor({ state: 'attached', timeout: 15_000 });

  await loginPageSession(mobPage, auth, ciTicketNonces[2]);

  const swReady = await mobPage.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg?.active && reg.scope.endsWith('/'));
  });
  assert.equal(swReady, true, 'mob-sw-inactive');
  const mf = await cdp.send('Page.getAppManifest');
  assert.deepEqual(mf.errors || [], [], 'mob-manifest-err');
  const inst = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(inst.installabilityErrors || [], [], 'mob-install-err');

  await mobPage.locator('.tab[data-panel="contacts-panel"]').click();
  await mobPage.locator('#contacts-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await mobPage.locator('#contact-results .record').first().waitFor({ state: 'visible', timeout: 15_000 });
  await mobPage.locator('#contact-results .record').first().click();
  await mobPage.locator('#record-sheet').waitFor({ state: 'visible', timeout: 10_000 });
  await mobPage.locator('#record-sheet-close').click();

  await mobPage.locator('#logout-button').click();
  await mobPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await mobPage.locator('#crm-workspace').isHidden(), true, 'mob-postlogout-visible');
  await mobCtx.close();
}

async function verifyDesktopAndMobileBrowsers(auth) {
  const pageErrors = [];
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyDesktopBrowser(browser, auth, pageErrors);
    await verifyMobileBrowser(browser, auth, pageErrors);
  } finally {
    await browser.close();
  }
  assert.deepEqual(pageErrors, [], `page-errors-${pageErrors.length}`);
  return { desktop_ui: 'verified', mobile_ui: 'verified', unauth_ui_locked: 'verified' };
}

try {
  await verifyUnauthenticatedLockdown();
  const auth = await authenticateHttpSession();
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
} catch (err) {
  const shortMsg = String(err?.message || err || 'unknown')
    .split('\n')[0]
    .replaceAll(/[^A-Za-z0-9_:-]/g, '-')
    .slice(0, 36);
  process.stderr.write(`STEP=${activeStep}:${shortMsg}\n`);
  process.exit(1);
}
