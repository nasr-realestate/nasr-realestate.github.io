import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CRMApiError, CRMClient } from '../crm-ui/crm-client.js';

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
    fetchImpl: async (url, init) => {
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
  const [html, appJs, clientJs, css, indexHtml, swJs, workerJs] = await Promise.all([
    readFile(new URL('../crm-ui/crm.html', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../crm-worker.js', import.meta.url), 'utf8'),
  ]);
  const uiBundle = `${html}\n${appJs}\n${clientJs}\n${css}`;

  assert.match(html, /lang="ar"\s+dir="rtl"/);
  assert.match(html, /name="robots"\s+content="noindex,nofollow,noarchive,nosnippet"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /id="login-panel"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="access-code-input"[^>]*type="password"/);
  assert.match(html, /id="logout-button"[^>]*hidden/);
  assert.match(html, /id="crm-workspace"\s+hidden/);
  assert.match(html, /لا تُقرأ جهات اتصال الهاتف ولا تُنقل البيانات المحلية تلقائيًا/);
  assert.match(appJs, /textContent/);
  assert.doesNotMatch(uiBundle, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(uiBundle, /localStorage|sessionStorage|indexedDB|caches\.open/);
  assert.doesNotMatch(uiBundle, /navigator\.contacts|ContactsManager|\.vcf|vcard|FileReader/i);
  assert.doesNotMatch(uiBundle, /wa\.me|api\.whatsapp\.com/);
  assert.doesNotMatch(uiBundle, /cloudflareaccess|cf-access-jwt-assertion|Zero\s*Trust/i);
  assert.doesNotMatch(workerJs, /cloudflareaccess|cf-access-jwt-assertion|ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAIL/);
  assert.doesNotMatch(indexHtml, /crm\.html|crm-assets|crm-client\.js/);
  assert.doesNotMatch(swJs, /crm\.html|crm-assets|crm-client\.js/);
});
