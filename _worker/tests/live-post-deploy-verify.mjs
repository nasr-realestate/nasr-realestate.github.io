// Live Post-Deploy HTTP + Desktop & Mobile Browser Verification for nasr-crm-api-test.
// Outputs strictly non-PII aggregate JSON metrics. Never logs customer names, phones, or chat bodies.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { a5RunIdentity, apiPhone, appendPendingEvent, derivedPhone, submissionKey, tagOf, conversationUid } from '../../scripts/a5-l2.mjs';

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
  // The Worker returns 403 for two very different reasons (unknown ticket vs expired ticket) and
  // 400 for a malformed nonce. Carrying the error code turns "403" into a diagnosis.
  assert.equal(res.status, 200, `ci-ticket-http-${res.status}-${String(res.data?.error || 'no-error-code')}`);
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
  // Counts are EVIDENCE, not thresholds (2026-11-06). They used to be asserted against one frozen
  // snapshot (66 / 60 / 64 / 83 / 19 / 76 / 2984), which made the whole gate impossible on a freshly
  // provisioned database and stale after every import. What the gate must prove is that the deployed
  // Worker answers correctly and that its summaries agree with its own lists — so the numbers are
  // recorded, and the relationships between them are asserted.
  const openAlertsBefore = Number(dash.data?.counts?.smart_alerts_open ?? 0);
  const dashUnmatched = Number(dash.data?.counts?.unmatched_review_chats ?? 0);
  const dashContactless = Number(dash.data?.counts?.contactless_opportunities ?? 0);
  assert.ok(openAlertsBefore >= 0 && dashUnmatched >= 0 && dashContactless >= 0, 'dash-counts-negative');

  const contactsRes = await apiCall('/api/contacts', { cookie: auth.cookiePair });
  assert.equal(contactsRes.status, 200, 'contacts-status');
  const contacts = (contactsRes.data.contacts || []).filter(c => isNotTestRow(c.name));
  const totalPhones = contacts.reduce((s, c) => s + Number(c.phone_count || 0), 0);
  assert.ok(contacts.every(c => String(c.id || '').length > 0), 'contacts-missing-id');

  const oppsRes = await apiCall('/api/opportunities', { cookie: auth.cookiePair });
  assert.equal(oppsRes.status, 200, 'opps-status');
  const opps = (oppsRes.data.opportunities || []).filter(o => isNotTestRow(o.notes));
  assert.ok(opps.every(o => String(o.id || '').length > 0), 'opps-missing-id');

  activeStep = 'check6-19-independent-opps';
  const contactlessOpps = opps.filter(o => !o.contact_id);
  // The dashboard must count exactly what the list returns — that is the real invariant, and it
  // catches a broken summary query at any data volume, including zero.
  assert.equal(contactlessOpps.length, dashContactless, 'dash-vs-list-contactless');

  let verifiedActivities = 0;
  for (const co of contactlessOpps) {
    const det = await apiCall(`/api/opportunities/${co.id}`, { cookie: auth.cookiePair });
    assert.equal(det.status, 200, `opp-det-${det.status}`);
    assert.equal(det.data?.opportunity?.id, co.id, 'opp-id-mismatch');
    assert.ok(String(det.data?.opportunity?.contact_name || det.data?.opportunity?.lead_label || '').length > 0, 'opp-label-empty');
    const acts = Array.isArray(det.data?.activities) ? det.data.activities : [];
    verifiedActivities += acts.length;
  }
  // Each contactless opportunity was opened and returned its own id; the activity total is recorded.

  return {
    contacts: contacts.length,
    phones: totalPhones,
    opportunities: opps.length,
    independent_opportunities: contactlessOpps.length,
    independent_activities: verifiedActivities,
    open_alerts: openAlertsBefore,
    dash_unmatched: dashUnmatched,
    dash_contactless: dashContactless,
  };
}

function assertNoDuplicateQueueAlerts(fuData) {
  const uniqueAlertsById = new Map();
  for (const qName of ['waiting_reply', 'stalled_intervention', 'new_chat_alerts', 'today', 'overdue', 'upcoming']) {
    const qAlerts = (fuData[qName] || []).filter(a => a.item_kind === 'smart_alert');
    const qIds = qAlerts.map(a => a.alert_id || a.id).filter(Boolean);
    assert.equal(qIds.length, new Set(qIds).size, `dup-in-${qName}`);
    for (const a of qAlerts) uniqueAlertsById.set(a.alert_id || a.id, a);
  }
  // No floor: the number is recorded, and the duplicate checks below carry the actual meaning.
  const dedupTuples = [...uniqueAlertsById.values()]
    .filter(a => a.conversation_id)
    .map(a => `${a.conversation_id}|${a.message_id || ''}|${a.alert_type}`);
  assert.equal(dedupTuples.length, new Set(dedupTuples).size, 'dup-alert-tuples');
  return uniqueAlertsById.size;
}

async function verifyLiveConversationsAndAlerts(auth, { unmatched: dashUnmatched }) {
  activeStep = 'check3-convs-msgs';
  const convsRes = await apiCall('/api/conversations', { cookie: auth.cookiePair });
  assert.equal(convsRes.status, 200, 'convs-status');
  const convs = (convsRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  const totalMsgs = convs.reduce((s, c) => s + Number(c.message_count || 0), 0);
  assert.ok(convs.every(c => String(c.chat_uid || c.id || '').length > 0), 'convs-missing-id');

  activeStep = 'check4-unmatched-21';
  const unmRes = await apiCall('/api/conversations?match_status=unmatched_review', { cookie: auth.cookiePair });
  assert.equal(unmRes.status, 200, 'unm-status');
  const unm = (unmRes.data.conversations || []).filter(c => isNotTestRow(c.chat_title));
  // The list is the source of truth; the dashboard must agree with it.
  assert.equal(unm.length, dashUnmatched, 'dash-vs-list-unmatched');
  assert.equal(unm.every(c => c.contact_id === null), true, 'unm-contact-not-null');

  activeStep = 'check5-alerts-dedup';
  const fuRes = await apiCall('/api/followups', { cookie: auth.cookiePair });
  assert.equal(fuRes.status, 200, 'fu-status');
  const fuUnmatched = (fuRes.data.unmatched_review || []).filter(c => isNotTestRow(c.chat_title));
  // Two different endpoints, same question: they must not disagree.
  assert.equal(fuUnmatched.length, unm.length, `fu-vs-list-unmatched-${fuUnmatched.length}`);
  assertNoDuplicateQueueAlerts(fuRes.data);

  activeStep = 'check7a-conv-search';
  const searchRes = await apiCall('/api/conversations?match_status=unmatched_review&q=%D8%AF%D8%B1%D8%AF%D8%B4%D8%A9', {
    cookie: auth.cookiePair,
  });
  assert.equal(searchRes.status, 200, 'search-status');
  let searchState = 'verified';
  if (unm.length > 0) {
    assert.ok((searchRes.data.conversations || []).length >= 1, 'search-empty');
  } else {
    // Nothing unmatched exists, so a query over unmatched rows can only return nothing. Reporting
    // "not applicable" is honest; asserting a hit would fail every clean database forever.
    searchState = 'skipped-no-unmatched-rows';
  }

  return {
    conversations: convs.length,
    messages: totalMsgs,
    unmatched_review: unm.length,
    conversation_search: searchState,
  };
}

async function verifySyntheticManualLink(auth) {
  activeStep = 'check7b-manual-link';
  // A5 L2: every key in this step is derived from this run's tag. No constant phone, no random
  // display-name-only identity, no reuse of a previous run's conversation_uid or receipt key.
  // The strict 201 assertion below is UNCHANGED — a duplicate/200 must still fail the run.
  const identity = a5RunIdentity(process.env);
  const runTag = identity.run_tag;
  const tag = tagOf(runTag);
  const uid = conversationUid(runTag);
  const synthPhone = apiPhone(runTag, 'live10-manual-link');
  const synthKey = submissionKey(runTag, 'live10-contact');
  const l2Pending = String(process.env.A5_L2_PENDING || '').trim();
  const l2 = (event) => appendPendingEvent(l2Pending, { ...event, run_id: identity.run_id,
    run_attempt: identity.run_attempt, run_tag: runTag });

  const imp = await apiCall('/api/conversations/import', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    body: {
      chat_title: 'TEST ONLY — محادثة فحص ما بعد النشر',
      conversation_uid: uid,
      source_ref: tag,
      raw_text: '30/10/2026, 2:00 م - عميل فحص: تجربة ربط يدوي آمن بعد النشر',
    },
  });
  assert.ok(imp.status === 200 || imp.status === 201, `synth-imp-${imp.status}`);
  const convId = String(imp.data.conversation_id || '');
  assert.ok(convId.length >= 8, 'synth-conv-id');
  assert.equal(imp.data.match_status, 'unmatched_review', 'synth-imp-match');
  l2({ table: 'crm_conversations', lookup_value: uid, observed_id: convId,
    id_source: 'http-response', step: 'check7b-manual-link' });

  const cRes = await apiCall('/api/contacts', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
    key: synthKey,
    body: {
      name: 'TEST ONLY — عميل فحص الربط',
      review_note: tag,
      phones: [{ phone: synthPhone, label: 'فحص', is_primary: true }],
    },
  });
  assert.equal(cRes.status, 201, `synth-contact-${cRes.status}`);
  const contactId = String(cRes.data.contact_id || '');
  assert.ok(contactId.length >= 8, 'synth-contact-id');
  l2({ table: 'crm_contacts', lookup_value: contactId, observed_id: contactId,
    id_source: 'http-201-body', step: 'check7b-manual-link' });
  l2({ table: 'crm_contact_phones', lookup_value: derivedPhone(runTag, 'live10-manual-link'),
    id_source: 'http-201-body+exact-key', parent: { table: 'crm_contacts', column: 'contact_id' },
    step: 'check7b-manual-link' });
  l2({ table: 'crm_idempotency_receipts', lookup_value: synthKey,
    id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'resource_id' },
    step: 'check7b-manual-link' });

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
  const finalMatchStatus = String(verifyConv.data?.conversation?.match_status || '');
  assert.ok(finalMatchStatus === 'matched' || finalMatchStatus === 'resolved_manual', `synth-det-status-${finalMatchStatus}`);
  assert.equal(verifyConv.data?.conversation?.match_method, 'manual_review_link', 'synth-det-method');
  assert.equal(verifyConv.data?.conversation?.contact_id, contactId, 'synth-det-cid');

  await apiCall('/api/auth/logout', {
    method: 'POST',
    cookie: auth.cookiePair,
    csrf: auth.csrf,
  });

  // A5 L2: publish the resolved ledger for this step before the run moves on. Failure here fails
  // the whole verification — no silent best-effort evidence path.
  const checkpointCmd = String(process.env.A5_L2_CHECKPOINT_CMD || '').trim();
  if (checkpointCmd) execFileSync('/bin/sh', ['-c', checkpointCmd], { stdio: 'inherit', env: process.env });

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
  await deskPage.locator('#followups-metrics .metric').first().waitFor({ state: 'visible', timeout: 15_000 });
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
  const convMetrics = await verifyLiveConversationsAndAlerts(auth, { unmatched: coreMetrics.dash_unmatched });
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
