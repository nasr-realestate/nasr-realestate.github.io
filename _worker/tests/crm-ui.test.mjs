import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CRMApiError, CRMClient } from '../crm-ui/crm-client.js';
import {
  buildReadyFollowupMessage,
  buildWhatsappTemplates,
  extractClientSalutation,
  prettyPhoneFormat,
  whatsappHref,
} from '../crm-ui/crm-assets/whatsapp-templates.js';

function jsonResponse(payload, status = 200, extra = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: Boolean(extra.redirected),
    headers: new Headers({ 'content-type': extra.contentType || 'application/json; charset=utf-8' }),
    json: async () => payload,
  };
}

test('CRMClient manages internal auth login, session, CSRF token header, and logout without browser storage', async () => {
  const calls = [];
  const client = new CRMClient({
    apiBase: '/api/',
    fetchImpl: async function browserWebIdlFetch(url, init) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      calls.push({ url, init });
      if (url === '/api/auth/login') {
        return jsonResponse({ authenticated: true, csrf_token: 'csrf_token_for_runtime_only_1234567890' });
      }
      if (url === '/api/contacts' && init.method === 'POST') {
        return jsonResponse({ contact_id: 'contact_12345678', duplicate_contact: false }, 201);
      }
      if (url === '/api/auth/logout') {
        return jsonResponse({ ok: true, authenticated: false });
      }
      return jsonResponse({ contacts: [{ id: 'contact_12345678', name: 'ندى محمود' }] });
    },
  });

  assert.equal(client.hasCsrfToken(), false);
  const runtimeCode = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
  const loginRes = await client.login(runtimeCode);
  assert.equal(loginRes.authenticated, true);
  assert.equal(client.hasCsrfToken(), true);
  assert.equal(calls[0].url, '/api/auth/login');
  assert.equal(calls[0].init.headers['x-crm-csrf'], undefined);

  await client.searchContacts('ندى');
  assert.equal(calls[1].url, '/api/contacts?q=%D9%86%D8%AF%D9%89');
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.equal(calls[1].init.cache, 'no-store');
  assert.equal(calls[1].init.headers['x-crm-csrf'], undefined);

  await client.createContact({ name: 'ندى محمود', phones: [{ phone: '01022334455', is_primary: true }] }, 'idempotency-key-1234');
  assert.equal(calls[2].init.headers['idempotency-key'], 'idempotency-key-1234');
  assert.equal(calls[2].init.headers['x-crm-csrf'], 'csrf_token_for_runtime_only_1234567890');

  await client.logout();
  assert.equal(calls[3].url, '/api/auth/logout');
  assert.equal(calls[3].init.headers['x-crm-csrf'], 'csrf_token_for_runtime_only_1234567890');
  assert.equal(client.hasCsrfToken(), false);
});

test('CRMClient clears CSRF token on 401 and classifies auth, rate-limit, offline, conflict, and 503 states safely', async () => {
  await assert.rejects(
    async () => new CRMClient({ apiBase: 'https://evil.example/api', fetchImpl: async () => jsonResponse({}) }),
    error => error instanceof CRMApiError && error.kind === 'configuration',
  );

  const redirectClient = new CRMClient({
    fetchImpl: async () => jsonResponse({}, 200, { redirected: true, contentType: 'text/html' }),
  });
  await assert.rejects(() => redirectClient.getDashboard(), { kind: 'authentication' });

  let statusToReturn = 200;
  const expiringClient = new CRMClient({
    fetchImpl: async url => {
      if (url === '/api/auth/session') return jsonResponse({ authenticated: true, csrf_token: 'csrf_active_token_1234567890123456' });
      return jsonResponse({ error: 'invalid_session' }, statusToReturn);
    },
  });
  await expiringClient.getSession();
  assert.equal(expiringClient.hasCsrfToken(), true);
  statusToReturn = 401;
  await assert.rejects(() => expiringClient.getDashboard(), { kind: 'authentication', status: 401 });
  assert.equal(expiringClient.hasCsrfToken(), false);

  for (const [status, code, kind] of [
    [401, 'invalid_credentials', 'authentication'],
    [403, 'invalid_csrf', 'authentication'],
    [409, 'duplicate_phone_review', 'conflict'],
    [429, 'too_many_attempts', 'rate_limit'],
    [503, 'auth_not_configured', 'configuration'],
    [500, 'request_failed', 'server'],
  ]) {
    const client = new CRMClient({ fetchImpl: async () => jsonResponse({ error: code }, status) });
    await assert.rejects(() => client.getDashboard(), { kind, status });
  }

  const offlineClient = new CRMClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => offlineClient.getDashboard(), { kind: 'offline' });
});

test('private CRM UI keeps workspace hidden until login, removes Cloudflare Access requirement, and avoids public site, storage, contact import, and unsafe DOM APIs', async () => {
  const [html, appJs, followupsUiJs, waTemplatesJs, clientJs, crmSwJs, crmManifestRaw, css, indexHtml, swJs, workerJs] = await Promise.all([
    readFile(new URL('../crm-ui/crm.html', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/followups-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/whatsapp-templates.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-manifest.webmanifest', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-worker.js', import.meta.url), 'utf8'),
  ]);
  const uiBundle = `${html}\n${appJs}\n${followupsUiJs}\n${waTemplatesJs}\n${clientJs}\n${crmSwJs}\n${css}`;
  const manifest = JSON.parse(crmManifestRaw);

  assert.equal(manifest.id, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.dir, 'rtl');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.equal(manifest.icons.some(icon => icon.purpose === 'any' && icon.sizes === '192x192'), true);
  assert.equal(manifest.icons.some(icon => icon.purpose === 'any' && icon.sizes === '512x512'), true);
  assert.equal(manifest.icons.some(icon => icon.purpose === 'maskable' && icon.sizes === '512x512'), true);
  assert.equal(manifest.icons.some(icon => String(icon.purpose).includes(' ')), false, 'Do not combine any maskable');
  assert.match(html, /rel="manifest"\s+href="\/crm-manifest\.webmanifest"/);
  assert.match(html, /id="push-card"/);
  assert.match(html, /id="pwa-install-btn"/);
  assert.match(html, /id="track-hub-grid"/);
  assert.match(html, /id="record-sheet"\s+hidden/);
  assert.match(html, /id="record-sheet-close"/);
  assert.match(html, /data-quick-track="transient"/);
  assert.match(appJs, /void ensureCrmServiceWorker\(\)/);
  assert.match(appJs, /buildQuickActionPad\s*\(/);
  assert.match(appJs, /tel:\+/);
  assert.match(clientJs, /subscribePush\s*\(/);
  assert.match(clientJs, /switchOpportunityTrack\s*\(/);
  assert.match(clientJs, /updateOpportunity\s*\(/);
  assert.match(clientJs, /getOpportunityMatches\s*\(/);
  assert.match(crmSwJs, /addEventListener\('fetch'/);
  assert.match(crmSwJs, /showNotification\s*\(/);

  assert.match(html, /lang="ar"\s+dir="rtl"/);
  assert.match(html, /name="robots"\s+content="noindex,nofollow,noarchive,nosnippet"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /id="login-panel"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="access-code-input"[^>]*type="password"/);
  assert.match(html, /id="logout-button"[^>]*hidden/);
  assert.match(html, /id="crm-workspace"\s+hidden/);
  assert.match(html, /id="quick-entry-panel"\s+hidden/);
  assert.match(html, /id="quick-entry-form"/);
  assert.match(clientJs, /updateContact\s*\(/);
  assert.match(html, /لا تُقرأ جهات اتصال الهاتف ولا تُنقل البيانات المحلية تلقائيًا/);
  assert.match(appJs, /textContent/);
  assert.doesNotMatch(uiBundle, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(uiBundle, /localStorage|sessionStorage|indexedDB|caches\.open/);
  assert.doesNotMatch(uiBundle, /navigator\.contacts|ContactsManager|\.vcf|vcard|FileReader/i);
  assert.match(uiBundle, /https:\/\/wa\.me\//);
  assert.match(workerJs, /\/crm-assets\/whatsapp-templates\.js/);
  assert.doesNotMatch(uiBundle, /cloudflareaccess|cf-access-jwt-assertion|Zero\s*Trust/i);
  assert.doesNotMatch(workerJs, /cloudflareaccess|cf-access-jwt-assertion|ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAIL/);
  assert.doesNotMatch(indexHtml, /crm\.html|crm-assets|crm-client\.js/);
  assert.doesNotMatch(swJs, /crm\.html|crm-assets|crm-client\.js/);
});

test('WhatsApp link builder and professional message templates format salutations, E.164 phones, and role-aware pre-filled links cleanly', () => {
  assert.equal(prettyPhoneFormat('201022334455'), '+20 1022334455');
  assert.equal(prettyPhoneFormat('01022334455'), '+20 1022334455');
  assert.equal(prettyPhoneFormat('971501234567'), '+971 501234567');
  assert.equal(prettyPhoneFormat('33600009999'), '+33 600009999');

  assert.equal(extractClientSalutation('🟢 سلمى تجريبي عندها شقه في الحي السابع 2.5 مليون'), 'أ/ سلمى تجريبي');
  assert.equal(extractClientSalutation('🟢اللواء سامح انا مالك شقه للبيع بمدينه نصر'), 'سيادة اللواء سامح');
  assert.equal(extractClientSalutation('🟠د مروان تجريبي مقر اداري ارضي كابول 55000'), 'د. مروان تجريبي');
  assert.equal(extractClientSalutation('✈️ مطلوب ايجار محل محل 60 متر'), 'يا فندم');
  assert.equal(extractClientSalutation('✈️ نعم كان بيدور على محل للايجار'), 'يا فندم');

  const ownerTpls = buildWhatsappTemplates({
    name: '🟢 ريم تجريبي بيع شقة ١٨٠ السنهورى',
    track: 'sale_apt',
    intent: 'sell',
    areaLabel: 'عبد الرازق السنهوري',
    propertyType: 'شقة',
    sizeMax: 180,
    siteUrl: 'https://nasr-realestate.github.io/properties/test-sale/',
  });
  assert.equal(ownerTpls.length, 4);
  assert.match(ownerTpls[0].text, /السلام عليكم أ\/ ريم تجريبي، معك طارق طنطاوي — سمسار طلبك/);
  assert.match(ownerTpls[0].text, /شقة \(180 م²\) في عبد الرازق السنهوري/);
  assert.doesNotMatch(ownerTpls[0].text, /بيع شقة ١٨٠ السنهورى/);
  assert.match(ownerTpls[3].text, /https:\/\/nasr-realestate\.github\.io\/properties\/test-sale\//);

  const buyerTpls = buildWhatsappTemplates({
    name: '✈️ سارة تجريبي تبحث عن شقه 4مليون',
    track: 'transient',
    intent: 'buy',
    areaLabel: 'مدينة نصر',
    propertyType: 'شقة تمليك',
  });
  assert.equal(buyerTpls.length, 4);
  assert.match(buyerTpls[0].text, /السلام عليكم أ\/ سارة تجريبي، معك طارق طنطاوي — سمسار طلبك/);
  assert.match(buyerTpls[0].text, /بخصوص طلب حضرتك/);
  assert.match(buyerTpls[0].text, /للشراء والتمليك/);
  assert.doesNotMatch(buyerTpls[0].text, /وحدتكم|هل ما زالت متاحة للبيع/);

  const tenantTpls = buildWhatsappTemplates({
    name: 'أستاذ كريم تجريبي',
    track: 'new_rent_apt',
    intent: 'rent',
    areaLabel: 'مكرم عبيد',
    propertyType: 'شقة',
  });
  assert.match(tenantTpls[0].text, /للإيجار/);
  assert.doesNotMatch(tenantTpls[0].text, /للبيع|وحدتكم/);

  // Unknown/empty intent must NEVER address a contact as a property owner
  const unknownRoleTpls = buildWhatsappTemplates({
    name: 'أستاذ ماجد تجريبي',
    intent: '',
    areaLabel: 'مدينة نصر',
  });
  assert.equal(unknownRoleTpls.length, 3);
  assert.doesNotMatch(unknownRoleTpls[0].text, /وحدتكم|هل ما زالت متاحة للبيع/);

  // Local Egyptian and Arabic-Indic numbers must normalize to international 20... before wa.me
  const hrefLocal = whatsappHref('01022334455', buyerTpls[0].text);
  assert.match(hrefLocal, /^https:\/\/wa\.me\/201022334455\?text=/);
  const hrefArabicDigits = whatsappHref('٠١٠٢٢٣٣٤٤٥٥', 'مرحبا');
  assert.match(hrefArabicDigits, /^https:\/\/wa\.me\/201022334455\?text=/);

  const hrefWithPhone = whatsappHref('201022334455', buyerTpls[0].text);
  assert.match(hrefWithPhone, /^https:\/\/wa\.me\/201022334455\?text=/);
  assert.equal(decodeURIComponent(hrefWithPhone.split('?text=')[1]), buyerTpls[0].text);

  const hrefIntl = whatsappHref('971501234567', ownerTpls[0].text);
  assert.match(hrefIntl, /^https:\/\/wa\.me\/971501234567\?text=/);

  const hrefPhoneless = whatsappHref('', buildReadyFollowupMessage('🟢 نور تجريبي شقه خلف التوحيد د5', 'sell', 'مصطفى النحاس'));
  assert.match(hrefPhoneless, /^https:\/\/wa\.me\/\?text=/);
});
