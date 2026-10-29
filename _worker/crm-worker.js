// Private CRM API & UI Worker. Uses self-contained Worker authentication
// (salted PBKDF2-SHA256 secret verification, D1-backed hashed sessions,
// __Host- HttpOnly/Secure/SameSite=Strict cookies, strict Origin + CSRF checks,
// and D1 brute-force rate limiting) with zero dependency on Cloudflare Zero Trust.

import {
  generateVapidKeyPair,
  getPushStatusResponse,
  runScheduledCrmNotifications,
  sendTestPushAlert,
  subscribePushDevice,
  unsubscribePushDevice,
} from './crm-push.js';

export { generateVapidKeyPair };

export const ALLOWED_TRACKS = ['sale_apt', 'furnished_apt', 'new_rent_apt', 'admin_hq', 'transient'];
const TRACK_LABELS_AR = {
  sale_apt: '🟢 شقق للبيع',
  furnished_apt: '🔴 شقق مفروشة',
  new_rent_apt: '🔵 شقق إيجار جديد',
  admin_hq: '🟡 مقرات ومكاتب إدارية',
  transient: '✈️ طيارة (عميل عابر)',
};

function inferStructuralTrack(propertyType = '', intent = '', notes = '') {
  const hay = `${propertyType || ''} ${notes || ''}`;
  if (/مقر|إداري|اداري|مكتب|محل|تجاري|عيادة|عياده|مخزن|مول/.test(hay)) return 'admin_hq';
  if (/مفروش/.test(hay)) return 'furnished_apt';
  if (intent === 'rent' || intent === 'lease') return 'new_rent_apt';
  return 'sale_apt';
}

export function inferOpportunityTrack(body) {
  if (ALLOWED_TRACKS.includes(body?.track)) return body.track;
  return inferStructuralTrack(body?.property_type, body?.intent, body?.notes);
}

const ACTIVE = "'active','visit_scheduled','viewing_done','offer','negotiating','near_close'";
const SESSION_COOKIE = '__Host-crm_session';
const DEFAULT_SESSION_TTL_SECONDS = 28_800; // 8 hours
const MIN_SESSION_TTL_SECONDS = 300; // 5 minutes
const MAX_SESSION_TTL_SECONDS = 43_200; // 12 hours
const MAX_IDLE_SECONDS = 7_200; // 2 hours
const DEFAULT_PBKDF2_ITERATIONS = 25_000;
const MIN_PBKDF2_ITERATIONS = 10_000;
const MAX_PBKDF2_ITERATIONS = 100_000;
const MIN_ACCESS_CODE_LENGTH = 24;
const MIN_SESSION_SECRET_LENGTH = 32;
const AUTH_WINDOW_SECONDS = 900; // 15 minutes
const MAX_IP_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 20;
const UI_ASSET_PATHS = new Set([
  '/',
  '/crm.html',
  '/crm-client.js',
  '/crm-manifest.webmanifest',
  '/crm-sw.js',
  '/crm-assets/app.css',
  '/crm-assets/app.js',
  '/crm-assets/whatsapp-templates.js',
  '/crm-assets/icon-192.png',
  '/crm-assets/icon-512.png',
  '/crm-assets/icon-maskable-512.png',
]);
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    ...headers,
  },
});

function allowedOrigin(env) {
  try {
    const value = String(env.CRM_ALLOWED_ORIGIN || '').trim();
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value) return '';
    return value;
  } catch {
    // Malformed CRM_ALLOWED_ORIGIN must fail closed rather than throw.
    return '';
  }
}

function siteScope(env) {
  const sourceRaw = String(env.CRM_SITE_SOURCE_ID || '');
  const areaRaw = String(env.CRM_NASR_AREA_IDS || '');
  if (!/^[1-9]\d{0,8}$/.test(sourceRaw) || !/^[1-9]\d{0,8}(?:,[1-9]\d{0,8})*$/.test(areaRaw)) {
    return null;
  }
  const ids = areaRaw.split(',');
  if (ids.length > 100 || new Set(ids).size !== ids.length) return null;
  return { sourceId: Number(sourceRaw), areaSql: ids.join(',') };
}

function cors(origin, env) {
  const allowed = allowedOrigin(env);
  if (!origin || origin !== allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,idempotency-key,x-crm-csrf',
    'vary': 'Origin',
  };
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCodePoint(bytes[i]);
  }
  let encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  while (encoded.endsWith('=')) encoded = encoded.slice(0, -1);
  return encoded;
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, ch => ch.codePointAt(0));
  } catch {
    // Reject malformed base64url inputs safely.
    return null;
  }
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.byteLength === 0 || a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return new Uint8Array(digest);
}

async function sha256Hex(text) {
  return toHex(await sha256Bytes(text));
}

async function hmacBytes(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

async function hmacHex(secret, message) {
  return toHex(await hmacBytes(secret, message));
}

async function pbkdf2Sha256(secretText, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(secretText), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function createAccessCodeVerifier(accessCode, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const normalized = typeof accessCode === 'string' ? accessCode.trim() : '';
  if (normalized.length < MIN_ACCESS_CODE_LENGTH || normalized.length > 256 || /\s/.test(normalized)) {
    throw new Error('weak_or_invalid_access_code');
  }
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error('invalid_pbkdf2_iterations');
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2Sha256(normalized, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

function parseVerifier(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parts = text.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || !/^\d{5,6}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    return null;
  }
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  if (!salt || salt.byteLength < 16 || salt.byteLength > 64 || !expected || expected.byteLength !== 32) {
    return null;
  }
  return { iterations, salt, expected };
}

function parseSessionTtl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SESSION_TTL_SECONDS;
  const text = String(raw).trim();
  if (!/^\d{3,5}$/.test(text)) return null;
  const ttl = Number(text);
  if (ttl < MIN_SESSION_TTL_SECONDS || ttl > MAX_SESSION_TTL_SECONDS) return null;
  return ttl;
}

function authConfig(env) {
  const origin = allowedOrigin(env);
  const scope = siteScope(env);
  const sessionSecret = typeof env.CRM_SESSION_SECRET === 'string' ? env.CRM_SESSION_SECRET.trim() : '';
  const ttlSeconds = parseSessionTtl(env.CRM_SESSION_TTL_SECONDS);
  if (!env.DB || !origin || !scope || !ttlSeconds) return null;
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH || sessionSecret.length > 512) return null;

  const verifier = parseVerifier(env.CRM_ACCESS_CODE_VERIFIER);
  const directCode = typeof env.CRM_ACCESS_CODE === 'string' ? env.CRM_ACCESS_CODE.trim() : '';
  const hasValidDirectCode = directCode.length >= MIN_ACCESS_CODE_LENGTH && directCode.length <= 256 && !/\s/.test(directCode);
  if (!verifier && !hasValidDirectCode) return null;

  return {
    origin,
    scope,
    sessionSecret,
    ttlSeconds,
    idleSeconds: Math.min(ttlSeconds, MAX_IDLE_SECONDS),
    verifier: hasValidDirectCode ? null : verifier,
    directCode: hasValidDirectCode ? directCode : '',
  };
}

let cachedDirectVerifier = { fingerprint: '', salt: null, expected: null };

async function verifySubmittedAccessCode(submitted, config) {
  const candidate = typeof submitted === 'string' ? submitted.trim() : '';
  if (!candidate || candidate.length > 256) return false;
  if (config.verifier) {
    const derived = await pbkdf2Sha256(candidate, config.verifier.salt, config.verifier.iterations);
    return timingSafeEqualBytes(derived, config.verifier.expected);
  }
  const fp = await sha256Hex(`${config.sessionSecret}:${config.directCode}`);
  if (cachedDirectVerifier.fingerprint !== fp) {
    const salt = (await hmacBytes(config.sessionSecret, 'crm-access-code-salt-v1')).slice(0, 16);
    const expected = await pbkdf2Sha256(config.directCode, salt, DEFAULT_PBKDF2_ITERATIONS);
    cachedDirectVerifier = { fingerprint: fp, salt, expected };
  }
  const candidateDerived = await pbkdf2Sha256(candidate, cachedDirectVerifier.salt, DEFAULT_PBKDF2_ITERATIONS);
  return timingSafeEqualBytes(candidateDerived, cachedDirectVerifier.expected);
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

function readSessionCookie(request) {
  const header = request.headers.get('cookie') || '';
  if (!header || header.length > 4096) return null;
  const matches = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === SESSION_COOKIE) matches.push(value);
  }
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(matches[0])) return null;
  return matches[0];
}

async function deriveCsrfToken(sessionSecret, sessionId, sessionToken) {
  return toBase64Url(await hmacBytes(sessionSecret, `csrf-v1:${sessionId}:${sessionToken}`));
}

function isStateChanging(method) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function verifyRequestOrigin(request, config) {
  const origin = request.headers.get('origin') || '';
  const secFetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return { ok: false, status: 403, code: 'cross_site_forbidden' };
  }
  if (isStateChanging(request.method)) {
    if (!origin || origin !== config.origin) {
      return { ok: false, status: 403, code: 'origin_not_allowed' };
    }
    return { ok: true };
  }
  if (origin && origin !== config.origin) {
    return { ok: false, status: 403, code: 'origin_not_allowed' };
  }
  return { ok: true };
}

async function verifySession(request, env, config) {
  const sessionToken = readSessionCookie(request);
  if (!sessionToken) return { ok: false, status: 401, code: 'authentication_required', hadCookie: false };
  const tokenHash = await hmacHex(config.sessionSecret, `session:${sessionToken}`);
  const row = await env.DB.prepare(
    'SELECT id, csrf_hash, created_at, expires_at, last_seen_at, revoked_at FROM crm_sessions WHERE token_hash = ? LIMIT 1',
  ).bind(tokenHash).first();
  const now = Math.floor(Date.now() / 1000);
  const validSessionRow = Boolean(row)
    && row.revoked_at === null
    && Number.isInteger(row.expires_at)
    && Number.isInteger(row.last_seen_at)
    && row.expires_at > now
    && (now - row.last_seen_at) <= config.idleSeconds;
  if (!validSessionRow) {
    return { ok: false, status: 401, code: 'authentication_required', hadCookie: true };
  }
  if (isStateChanging(request.method)) {
    const csrfHeader = (request.headers.get('x-crm-csrf') || '').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(csrfHeader)) {
      return { ok: false, status: 403, code: 'csrf_invalid', hadCookie: false };
    }
    const providedHash = await sha256Bytes(csrfHeader);
    const expectedHash = fromHex(row.csrf_hash);
    if (!expectedHash || !timingSafeEqualBytes(providedHash, expectedHash)) {
      return { ok: false, status: 403, code: 'csrf_invalid', hadCookie: false };
    }
  }
  if (now - row.last_seen_at >= 60) {
    await env.DB.prepare('UPDATE crm_sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { ok: true, sessionId: row.id, sessionToken, expiresAt: row.expires_at };
}

async function clientIpBucket(request, sessionSecret) {
  const rawIp = (request.headers.get('cf-connecting-ip') || 'unknown').trim().slice(0, 128);
  const digest = await hmacHex(sessionSecret, `login-ip:${rawIp}`);
  return `ip:${digest.slice(0, 48)}`;
}

async function checkRateLimitBucket(db, bucketKey, now) {
  const row = await db.prepare(
    'SELECT failures, window_started_at, blocked_until FROM crm_auth_attempts WHERE bucket_key = ? LIMIT 1',
  ).bind(bucketKey).first();
  if (!row) return 0;
  if (row.blocked_until > now) return row.blocked_until - now;
  return 0;
}

async function recordFailedAttempt(db, bucketKey, maxFailures, now) {
  const row = await db.prepare(
    'SELECT failures, window_started_at FROM crm_auth_attempts WHERE bucket_key = ? LIMIT 1',
  ).bind(bucketKey).first();
  const expiredWindow = !row || (now - row.window_started_at) >= AUTH_WINDOW_SECONDS;
  const failures = expiredWindow ? 1 : row.failures + 1;
  const windowStartedAt = expiredWindow ? now : row.window_started_at;
  const blockedUntil = failures >= maxFailures ? now + AUTH_WINDOW_SECONDS : 0;
  await db.prepare(
    `INSERT INTO crm_auth_attempts(bucket_key, failures, window_started_at, blocked_until)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       failures = excluded.failures,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until`,
  ).bind(bucketKey, failures, windowStartedAt, blockedUntil).run();
}

async function handleLogin(request, env, config) {
  const body = await readJson(request, 2048);
  const rawCode = typeof body.access_code === 'string' ? body.access_code.trim() : '';
  if (!rawCode || rawCode.length > 256) {
    return json({ error: 'access_code_required' }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const ipBucket = await clientIpBucket(request, config.sessionSecret);
  const ipRetry = await checkRateLimitBucket(env.DB, ipBucket, now);
  const globalRetry = await checkRateLimitBucket(env.DB, 'global', now);
  const retryAfter = Math.max(ipRetry, globalRetry);
  if (retryAfter > 0) {
    return json({ error: 'too_many_attempts' }, 429, { 'retry-after': String(retryAfter) });
  }

  const valid = await verifySubmittedAccessCode(rawCode, config);
  if (!valid) {
    await recordFailedAttempt(env.DB, ipBucket, MAX_IP_FAILURES, now);
    await recordFailedAttempt(env.DB, 'global', MAX_GLOBAL_FAILURES, now);
    return json({ error: 'invalid_credentials' }, 401);
  }

  const sessionId = id();
  const sessionToken = randomToken(32);
  const tokenHash = await hmacHex(config.sessionSecret, `session:${sessionToken}`);
  const csrfToken = await deriveCsrfToken(config.sessionSecret, sessionId, sessionToken);
  const csrfHash = await sha256Hex(csrfToken);
  const expiresAt = now + config.ttlSeconds;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM crm_auth_attempts WHERE bucket_key = ? OR (blocked_until < ? AND window_started_at < ?)').bind(
      ipBucket,
      now,
      now - AUTH_WINDOW_SECONDS,
    ),
    env.DB.prepare('DELETE FROM crm_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').bind(now),
    env.DB.prepare(
      'INSERT INTO crm_sessions(id, token_hash, csrf_hash, created_at, expires_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).bind(sessionId, tokenHash, csrfHash, now, expiresAt, now),
  ]);

  return json(
    {
      ok: true,
      authenticated: true,
      csrf_token: csrfToken,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    },
    200,
    { 'set-cookie': sessionCookieHeader(sessionToken, config.ttlSeconds) },
  );
}

async function handleSessionStatus(request, env, config) {
  const session = await verifySession(request, env, config);
  if (!session.ok) {
    const extra = session.hadCookie ? { 'set-cookie': clearSessionCookieHeader() } : {};
    return json({ authenticated: false, error: session.code }, session.status, extra);
  }
  const csrfToken = await deriveCsrfToken(config.sessionSecret, session.sessionId, session.sessionToken);
  return json({
    authenticated: true,
    csrf_token: csrfToken,
    expires_at: new Date(session.expiresAt * 1000).toISOString(),
  });
}

async function handleLogout(request, env, config) {
  const session = await verifySession(request, env, config);
  if (!session.ok) {
    const extra = session.hadCookie ? { 'set-cookie': clearSessionCookieHeader() } : {};
    return json({ error: session.code }, session.status, extra);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE crm_sessions SET revoked_at = ? WHERE id = ?').bind(now, session.sessionId).run();
  return json({ ok: true, authenticated: false }, 200, { 'set-cookie': clearSessionCookieHeader() });
}

function digits(value) {
  return String(value || '')
    .replace(/[\u0660-\u0669]/g, d => String(d.codePointAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, d => String(d.codePointAt(0) - 0x06f0));
}

export function normalizePhone(raw) {
  const value = digits(raw).trim();
  const international = /^\s*\+/.test(value) || value.startsWith('00');
  let number = value.replace(/\D/g, '');
  if (number.startsWith('00')) number = number.slice(2);
  if (/^01[0125]\d{8}$/.test(number)) number = `20${number.slice(1)}`;
  else if (/^1[0125]\d{8}$/.test(number) && !international) number = `20${number}`;
  else if (/^0201[0125]\d{8}$/.test(number)) number = number.slice(1);
  else if (/^0[2-9]\d{7,9}$/.test(number)) number = `20${number.slice(1)}`;
  if (number.length < 8 || number.length > 15 || !/^\d+$/.test(number)) return null;
  if (number.startsWith('20') && !/^20(?:1[0125]\d{8}|[2-9]\d{7,9})$/.test(number)) return null;
  if (!number.startsWith('20') && !international) return null;
  return number;
}

function boundedText(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeName(value) {
  return boundedText(value, 100).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('ar');
}

async function readJson(request, max = 10_000) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > max) throw new Error('body_too_large');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new SyntaxError('json_content_type_required');
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > max) throw new Error('body_too_large');
  const value = JSON.parse(decoder.decode(raw));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
  return value;
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, value: null };
  if (typeof value === 'string' && !value.trim()) return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e15) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

function safeSitePath(value) {
  const raw = boundedText(value, 500);
  return /^\/(?!\/)[A-Za-z0-9_./?=#%&+-]*$/.test(raw) ? raw : '';
}

function id() {
  return crypto.randomUUID();
}

function sqlError(error) {
  const msg = String(error?.message || '');
  if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(msg)) {
    return json({ error: 'duplicate_phone_review' }, 409);
  }
  if (/CHECK constraint failed/.test(msg)) return json({ error: 'validation_failed' }, 400);
  if (/FOREIGN KEY constraint failed/.test(msg)) return json({ error: 'linked_record_not_found' }, 400);
  return json({ error: 'database_error' }, 500);
}

function buildTrackCountsMap(rows = []) {
  const map = {};
  for (const code of ALLOWED_TRACKS) {
    map[code] = { total: 0, supply: 0, demand: 0 };
  }
  for (const row of rows) {
    if (map[row.track]) {
      map[row.track] = {
        total: Number(row.total || 0),
        supply: Number(row.supply_count || 0),
        demand: Number(row.demand_count || 0),
      };
    }
  }
  return map;
}

async function dashboard(db, url) {
  const now = new Date();
  const day = url.searchParams.get('day') || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'invalid_day' }, 400);
  const start = `${day}T00:00:00.000Z`;
  const end = `${day}T23:59:59.999Z`;
  const current = now.toISOString();
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM crm_opportunities WHERE status IN (${ACTIVE}) AND track != 'transient'`).first();
  const trackRows = await db.prepare(`SELECT track, COUNT(*) AS total,
      SUM(CASE WHEN intent IN ('sell','lease') THEN 1 ELSE 0 END) AS supply_count,
      SUM(CASE WHEN intent IN ('buy','rent') THEN 1 ELSE 0 END) AS demand_count
    FROM crm_opportunities GROUP BY track`).all();
  const today = await db.prepare(`SELECT o.id,o.track,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.area_label,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at BETWEEN ? AND ? ORDER BY o.next_followup_at`).bind(start, end).all();
  const overdue = await db.prepare(`SELECT o.id,o.track,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.area_label,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at < ? ORDER BY o.next_followup_at LIMIT 200`).bind(start).all();
  const noAction = await db.prepare(`SELECT o.id,o.track,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.no_followup_reason,o.updated_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at IS NULL AND COALESCE(o.no_followup_reason,'')='' ORDER BY o.updated_at LIMIT 200`).all();
  const stale = await db.prepare(`SELECT o.id,o.track,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.updated_at,
    (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id) AS last_activity
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND COALESCE((SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id),o.updated_at) < ?
    ORDER BY COALESCE(last_activity,o.updated_at) LIMIT 200`).bind(new Date(Date.now() - 7 * 86400000).toISOString()).all();
  const visits = await db.prepare(`SELECT p.id,p.viewing_at,p.viewing_result,o.id AS opportunity_id,o.track,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,l.title,l.url
    FROM crm_opportunity_properties p JOIN crm_opportunities o ON o.id=p.opportunity_id
    JOIN crm_contacts c ON c.id=o.contact_id JOIN listings l ON l.id=p.listing_id
    WHERE p.presentation_status='viewing_scheduled' AND p.viewing_at BETWEEN ? AND ? ORDER BY p.viewing_at`).bind(start, end).all();
  const outcomes = await db.prepare(`SELECT status, COUNT(*) AS count FROM crm_opportunities WHERE status IN ('won','lost','paused','unqualified') GROUP BY status`).all();
  return json({
    day,
    generated_at: current,
    counts: {
      active: active?.count || 0,
      due_today: today.results.length,
      overdue: overdue.results.length,
      missing_next_step: noAction.results.length,
    },
    tracks: buildTrackCountsMap(trackRows.results),
    due_today: today.results,
    overdue: overdue.results,
    missing_next_step: noAction.results,
    stale_7_days: stale.results,
    scheduled_visits: visits.results,
    outcomes: outcomes.results,
  });
}

function appendOpportunityTrackFilter(track, where, params) {
  if (track === 'live') {
    where.push("o.track != 'transient'");
  } else if (ALLOWED_TRACKS.includes(track)) {
    where.push('o.track=?');
    params.push(track);
  }
}

function appendOpportunityRoleFilter(role, where) {
  if (role === 'supply') where.push("o.intent IN ('sell','lease')");
  else if (role === 'demand') where.push("o.intent IN ('buy','rent')");
}

async function listOpportunities(db, url) {
  const status = url.searchParams.get('status') || '';
  const track = url.searchParams.get('track') || '';
  const role = url.searchParams.get('role') || '';
  const q = boundedText(url.searchParams.get('q'), 80);
  const params = [];
  const where = [];
  if (status) {
    where.push('o.status=?');
    params.push(status);
  }
  appendOpportunityTrackFilter(track, where, params);
  appendOpportunityRoleFilter(role, where);
  if (q) {
    const pat = `%${q}%`;
    where.push('(c.name LIKE ? OR EXISTS (SELECT 1 FROM crm_contact_phones p WHERE p.contact_id=c.id AND p.phone_key LIKE ?) OR o.area_label LIKE ? OR o.property_type LIKE ? OR o.notes LIKE ?)');
    params.push(pat, pat, pat, pat, pat);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT o.*,c.name AS contact_name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id ${whereSql} ORDER BY CASE WHEN o.track='transient' THEN 1 ELSE 0 END, CASE WHEN o.next_followup_at IS NULL THEN 1 ELSE 0 END, o.next_followup_at DESC, o.updated_at DESC LIMIT 300`;
  const rows = await db.prepare(sql).bind(...params).all();
  return json({ opportunities: rows.results });
}

async function listListings(db, url, scope) {
  const q = boundedText(url.searchParams.get('q'), 80);
  const pattern = q ? `%${q}%` : '';
  const rows = await db.prepare(`SELECT l.id,l.external_id,l.url,l.title,l.property_type,l.transaction_type,l.area_id,a.name_ar AS area_name,l.area_m2,l.price,l.bedrooms,l.bathrooms,l.finishing
    FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.source_id=? AND l.area_id IN (${scope.areaSql}) AND (?='' OR l.title LIKE ? OR l.external_id LIKE ? OR a.name_ar LIKE ?)
    ORDER BY l.observed_at DESC LIMIT 200`).bind(scope.sourceId, q, pattern, pattern, pattern).all();
  return json({ listings: rows.results });
}

async function getOpportunity(db, opportunityId) {
  const opportunity = await db.prepare(`SELECT o.*,c.name AS contact_name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id WHERE o.id=?`).bind(opportunityId).first();
  if (!opportunity) return json({ error: 'opportunity_not_found' }, 404);
  const [activities, properties, phones, siblings] = await Promise.all([
    db.prepare('SELECT * FROM crm_activities WHERE opportunity_id=? ORDER BY created_at DESC LIMIT 100').bind(opportunityId).all(),
    db.prepare(`SELECT p.*,l.external_id,l.url,l.title,l.area_m2,l.price,l.area_id,a.name_ar AS area_name FROM crm_opportunity_properties p
      JOIN listings l ON l.id=p.listing_id JOIN areas a ON a.id=l.area_id WHERE p.opportunity_id=? ORDER BY p.created_at DESC`).bind(opportunityId).all(),
    db.prepare('SELECT id,phone_key,label,is_primary,created_at FROM crm_contact_phones WHERE contact_id=? ORDER BY is_primary DESC,created_at').bind(opportunity.contact_id).all(),
    db.prepare('SELECT id,track,intent,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type FROM crm_opportunities WHERE contact_id=? ORDER BY updated_at DESC LIMIT 20').bind(opportunity.contact_id).all(),
  ]);
  return json({
    opportunity,
    activities: activities.results,
    properties: properties.results,
    phones: phones.results,
    sibling_opportunities: siblings.results,
  });
}

function activityTypeForPresentation(presentation) {
  if (presentation === 'viewing_scheduled' || presentation === 'viewed') return 'visit';
  if (presentation === 'presented' || presentation === 'offer_made') return 'offer';
  return 'objection';
}

async function linkProperty(request, env, opportunityId, scope) {
  const body = await readJson(request);
  const externalId = boundedText(body.external_id, 160);
  const allowedPresentations = ['presented', 'viewing_scheduled', 'viewed', 'offer_made', 'negotiating', 'rejected', 'selected'];
  const presentation = allowedPresentations.includes(body.presentation_status) ? body.presentation_status : 'presented';
  const viewingAt = body.viewing_at ? isoDate(body.viewing_at) : null;
  const price = optionalNumber(body.presented_price);
  const allowedObjections = ['price', 'location', 'size', 'financing', 'timing', 'no_response', 'other'];
  const objection = allowedObjections.includes(body.objection_reason) ? body.objection_reason : null;
  if (!externalId || (body.viewing_at && !viewingAt) || !price.ok) return json({ error: 'invalid_property_link' }, 400);
  const opportunity = await env.DB.prepare('SELECT id FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!opportunity) return json({ error: 'opportunity_not_found' }, 404);
  const listing = await env.DB.prepare(`SELECT l.id FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.source_id=? AND l.external_id=? AND l.area_id IN (${scope.areaSql}) LIMIT 1`).bind(scope.sourceId, externalId).first();
  if (!listing) return json({ error: 'nasr_city_listing_not_found' }, 404);
  const linkId = id();
  const actType = activityTypeForPresentation(presentation);
  const summary = boundedText(body.activity_summary, 1200) || `تحديث عقار معروض: ${externalId}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id,presentation_status,presented_price,viewing_at,viewing_result,objection_reason,notes)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(linkId, opportunityId, listing.id, presentation, price.value, viewingAt, boundedText(body.viewing_result, 400), objection, boundedText(body.notes, 700)),
      env.DB.prepare(`INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id(), opportunityId, actType, summary, boundedText(body.viewing_result, 200), null, null),
    ]);
    return json({ ok: true, listing_id: listing.id, external_id: externalId });
  } catch (error) {
    return sqlError(error);
  }
}

function validIdempotency(request) {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9._:-]{12,128}$/.test(key) ? key : null;
}

async function receipt(db, key) {
  return db.prepare('SELECT resource_type,resource_id FROM crm_idempotency_receipts WHERE submission_key=?').bind(key).first();
}

async function findPhone(db, phone) {
  return db.prepare(`SELECT p.id AS phone_id,p.contact_id,p.phone_key,c.name,c.communication_consent
    FROM crm_contact_phones p JOIN crm_contacts c ON c.id=p.contact_id WHERE p.phone_key=?`).bind(phone).first();
}

function duplicatePhone() {
  return json({ error: 'duplicate_phone_review', review_required: true }, 409);
}

async function listContacts(db, url) {
  const q = boundedText(url.searchParams.get('q'), 80);
  const track = url.searchParams.get('track') || '';
  const hasTrack = ALLOWED_TRACKS.includes(track);
  const pattern = `%${q}%`;
  const rows = await db.prepare(`SELECT c.id,c.name,c.communication_consent,c.created_at,c.updated_at,
      GROUP_CONCAT(p.phone_key, ',') AS phone_numbers,
      MAX(CASE WHEN p.is_primary=1 THEN p.phone_key ELSE NULL END) AS primary_phone,
      (SELECT COUNT(*) FROM crm_opportunities o WHERE o.contact_id=c.id) AS opportunity_count,
      (SELECT GROUP_CONCAT(DISTINCT o.track) FROM crm_opportunities o WHERE o.contact_id=c.id) AS tracks
    FROM crm_contacts c LEFT JOIN crm_contact_phones p ON p.contact_id=c.id
    WHERE (?='' OR c.name LIKE ? OR EXISTS (SELECT 1 FROM crm_contact_phones q WHERE q.contact_id=c.id AND q.phone_key LIKE ?))
      AND (?='' OR EXISTS (SELECT 1 FROM crm_opportunities ox WHERE ox.contact_id=c.id AND ox.track=?))
    GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 200`).bind(q, pattern, pattern, hasTrack ? track : '', hasTrack ? track : '').all();
  return json({ contacts: rows.results });
}

async function getContact(db, contactId) {
  const contact = await db.prepare('SELECT * FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!contact) return json({ error: 'contact_not_found' }, 404);
  const [phones, opportunities] = await Promise.all([
    db.prepare('SELECT id,phone_key,label,is_primary,created_at FROM crm_contact_phones WHERE contact_id=? ORDER BY is_primary DESC,created_at').bind(contactId).all(),
    db.prepare('SELECT id,track,intent,source,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,created_at,updated_at FROM crm_opportunities WHERE contact_id=? ORDER BY updated_at DESC LIMIT 100').bind(contactId).all(),
  ]);
  return json({ contact, phones: phones.results, opportunities: opportunities.results });
}

function parseSinglePhoneItem(item, seen) {
  if (!item || typeof item !== 'object' || typeof item.phone !== 'string') return null;
  if (item.is_primary !== undefined && typeof item.is_primary !== 'boolean') return null;
  const phone = normalizePhone(item.phone);
  if (!phone || seen.has(phone)) return null;
  seen.add(phone);
  return { phone, label: boundedText(item.label, 40), is_primary: item.is_primary === true };
}

function extractPhoneInputList(body) {
  if (body.phones !== undefined && !Array.isArray(body.phones)) return null;
  if (Array.isArray(body.phones)) return body.phones;
  if (body.phone) return [{ phone: body.phone, label: body.phone_label, is_primary: true }];
  return [];
}

function contactPhones(body) {
  const input = extractPhoneInputList(body);
  if (!input || input.length > 8) return null;
  const result = [];
  const seen = new Set();
  for (const item of input) {
    const parsed = parseSinglePhoneItem(item, seen);
    if (!parsed) return null;
    result.push(parsed);
  }
  if (result.filter(item => item.is_primary).length > 1) return null;
  if (result.length && !result.some(item => item.is_primary)) result[0].is_primary = true;
  return result;
}

function parseContactBody(body) {
  const name = boundedText(body.name, 100);
  const phones = contactPhones(body);
  const allowedConsent = ['request_only', 'marketing_yes', 'do_not_contact'];
  const consent = allowedConsent.includes(body.communication_consent) ? body.communication_consent : 'request_only';
  const consentAt = body.consent_captured_at ? isoDate(body.consent_captured_at) : null;
  if (!phones || (!name && !phones.length)) return null;
  if ((body.consent_captured_at && !consentAt) || (consent === 'marketing_yes' && !consentAt)) return null;
  return { name, phones, consent, consentAt };
}

function namesCompatible(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  return !left || !right || left === right;
}

async function findContactDuplicate(db, name, phones) {
  const matches = [];
  for (const item of phones) {
    const found = await findPhone(db, item.phone);
    if (found) matches.push(found);
  }
  if (!matches.length) return null;
  const sameSingle = phones.length === 1 && matches.length === 1 && namesCompatible(matches[0].name, name);
  if (sameSingle) return json({ contact_id: matches[0].contact_id, duplicate_contact: true });
  return duplicatePhone();
}

async function saveContact(db, key, contact) {
  const contactId = id();
  const statements = [
    db.prepare('INSERT INTO crm_contacts(id,name,communication_consent,consent_captured_at) VALUES(?,?,?,?)')
      .bind(contactId, contact.name, contact.consent, contact.consentAt),
  ];
  for (const item of contact.phones) {
    statements.push(
      db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
        .bind(id(), contactId, item.phone, item.label, item.is_primary ? 1 : 0),
    );
  }
  statements.push(
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(key, 'contact', contactId),
  );
  try {
    await db.batch(statements);
    return json({ contact_id: contactId, phone_count: contact.phones.length, duplicate_contact: false }, 201);
  } catch (error) {
    const message = String(error?.message || '');
    if (/UNIQUE constraint failed: crm_idempotency_receipts\.submission_key/.test(message)) {
      const replay = await receipt(db, key);
      if (replay?.resource_type === 'contact') return json({ contact_id: replay.resource_id, duplicate_submission: true });
      if (replay) return json({ error: 'idempotency_key_reused' }, 409);
    }
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(message)) return duplicatePhone();
    return sqlError(error);
  }
}

async function createContact(request, env) {
  const body = await readJson(request);
  const key = validIdempotency(request);
  if (!key) return json({ error: 'idempotency_key_required' }, 400);
  const contact = parseContactBody(body);
  if (!contact) return json({ error: 'invalid_contact' }, 400);
  const replay = await receipt(env.DB, key);
  if (replay) {
    if (replay.resource_type === 'contact') return json({ contact_id: replay.resource_id, duplicate_submission: true });
    return json({ error: 'idempotency_key_reused' }, 409);
  }
  const duplicate = await findContactDuplicate(env.DB, contact.name, contact.phones);
  if (duplicate) return duplicate;
  return saveContact(env.DB, key, contact);
}

async function addContactPhone(request, env, contactId) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: 'invalid_phone' }, 400);
  const contact = await env.DB.prepare('SELECT id FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!contact) return json({ error: 'contact_not_found' }, 404);
  const found = await findPhone(env.DB, phone);
  if (found) {
    if (found.contact_id === contactId) return json({ ok: true, duplicate: true, phone_id: found.phone_id });
    return duplicatePhone();
  }
  const existingPrimary = await env.DB.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(contactId).first();
  const primary = body.is_primary === true || !existingPrimary;
  const statements = [];
  if (primary) statements.push(env.DB.prepare('UPDATE crm_contact_phones SET is_primary=0 WHERE contact_id=?').bind(contactId));
  statements.push(
    env.DB.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
      .bind(id(), contactId, phone, boundedText(body.label, 40), primary ? 1 : 0),
  );
  try {
    await env.DB.batch(statements);
    await env.DB.prepare('UPDATE crm_contacts SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(contactId).run();
    return json({ ok: true, duplicate: false });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) {
      return duplicatePhone();
    }
    return sqlError(error);
  }
}

async function resolveContactPhoneUpdate(db, contactId, body) {
  if (!body.phone) return { statements: [], duplicate: false };
  const phone = normalizePhone(body.phone);
  if (!phone) return { error: json({ error: 'invalid_phone' }, 400) };
  const found = await findPhone(db, phone);
  if (found && found.contact_id !== contactId) return { error: duplicatePhone() };
  if (found) return { statements: [], duplicate: true };
  const existingPrimary = await db.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(contactId).first();
  const primary = body.is_primary === true || !existingPrimary;
  const statements = [];
  if (primary) statements.push(db.prepare('UPDATE crm_contact_phones SET is_primary=0 WHERE contact_id=?').bind(contactId));
  statements.push(
    db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
      .bind(id(), contactId, phone, boundedText(body.label, 40), primary ? 1 : 0),
  );
  return { statements, duplicate: false };
}

async function updateContact(request, env, contactId) {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT id,name FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!existing) return json({ error: 'contact_not_found' }, 404);
  const newName = body.name === undefined ? null : boundedText(body.name, 100);
  if (newName === '' && !body.phone) return json({ error: 'invalid_contact' }, 400);
  if (newName === null && !body.phone) return json({ error: 'invalid_contact' }, 400);
  const phoneUpdate = await resolveContactPhoneUpdate(env.DB, contactId, body);
  if (phoneUpdate.error) return phoneUpdate.error;
  const statements = [...phoneUpdate.statements];
  const targetName = newName !== null && newName !== '' ? newName : existing.name;
  statements.push(
    env.DB.prepare('UPDATE crm_contacts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(targetName, contactId),
  );
  try {
    await env.DB.batch(statements);
    return json({ ok: true, contact_id: contactId, duplicate_phone: phoneUpdate.duplicate });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) {
      return duplicatePhone();
    }
    return sqlError(error);
  }
}

const SEALED_ENVELOPE_RE = /^enc_v1\.([A-Za-z0-9_-]{64,1200})\.([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{24,520000})$/;

export async function generateIngestKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('spki', pair.publicKey),
  ]);
  return {
    privateKeyPkcs8B64u: toBase64Url(new Uint8Array(pkcs8)),
    publicKeySpkiB64u: toBase64Url(new Uint8Array(spki)),
  };
}

export async function sealIngestPayload(payload, publicKeySpkiB64u) {
  const spkiBytes = fromBase64Url(publicKeySpkiB64u);
  if (!spkiBytes) throw new Error('invalid_ingest_public_key');
  const rsaPub = await crypto.subtle.importKey(
    'spki',
    spkiBytes,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawAes = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaPub, rawAes));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext));
  return `enc_v1.${toBase64Url(wrapped)}.${toBase64Url(iv)}.${toBase64Url(cipher)}`;
}

async function unsealIngestPayload(envelope, privateKeyPkcs8B64u) {
  const match = typeof envelope === 'string' ? SEALED_ENVELOPE_RE.exec(envelope.trim()) : null;
  const pkcs8Bytes = fromBase64Url(String(privateKeyPkcs8B64u || '').trim());
  if (!match || !pkcs8Bytes) return null;
  const wrapped = fromBase64Url(match[1]);
  const iv = fromBase64Url(match[2]);
  const cipher = fromBase64Url(match[3]);
  if (!wrapped || !iv || iv.byteLength !== 12 || !cipher) return null;
  try {
    const rsaPriv = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8Bytes,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    );
    const rawAes = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsaPriv, wrapped);
    const aesKey = await crypto.subtle.importKey('raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
    const parsed = JSON.parse(decoder.decode(plainBytes));
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return {
      entries: parsed.entries,
      wipeExistingCustomers: parsed.wipe_existing_customers === true,
    };
  } catch {
    return null;
  }
}

async function wipeExistingCustomerData(db) {
  await db.batch([
    db.prepare('DELETE FROM crm_opportunity_properties'),
    db.prepare('DELETE FROM crm_activities'),
    db.prepare('DELETE FROM crm_opportunities'),
    db.prepare('DELETE FROM crm_contact_phones'),
    db.prepare("DELETE FROM crm_idempotency_receipts WHERE submission_key != 'system:ingest-public-key-v1' AND submission_key NOT LIKE 'sealed-ticket:%'"),
    db.prepare('DELETE FROM crm_contacts'),
  ]);
}

async function appendExtraPhonesStatements(db, statements, contactId, extraPhones, primaryPhone) {
  if (!Array.isArray(extraPhones)) return;
  const seen = new Set(primaryPhone ? [primaryPhone] : []);
  for (const item of extraPhones.slice(0, 6)) {
    const extraKey = normalizePhone(item?.phone);
    if (!extraKey || seen.has(extraKey)) continue;
    seen.add(extraKey);
    if (await findPhone(db, extraKey)) continue;
    statements.push(
      db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,0)')
        .bind(id(), contactId, extraKey, boundedText(item?.label, 40) || 'إضافي'),
    );
  }
}

async function insertSealedContactOnlyEntry(db, entry, subKey, phone) {
  const name = boundedText(entry.name, 100);
  if (!name && !phone) return null;
  const existingPhone = phone ? await findPhone(db, phone) : null;
  if (existingPhone) return { createdContact: 0, updatedContact: 0, createdOpportunity: 0, linkedProperty: 0 };
  const contactId = id();
  const statements = [
    db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').bind(contactId, name),
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(subKey, 'contact', contactId),
  ];
  if (phone) {
    statements.push(
      db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,1)')
        .bind(id(), contactId, phone, boundedText(entry.phone_label, 40) || 'واتساب'),
    );
  }
  await appendExtraPhonesStatements(db, statements, contactId, entry.extra_phones, phone);
  await db.batch(statements);
  return { createdContact: 1, updatedContact: 0, createdOpportunity: 0, linkedProperty: 0 };
}

async function findPlaceholderBySourceUrl(db, sourceUrl) {
  if (!sourceUrl) return null;
  return db.prepare(`SELECT o.id AS opportunity_id, o.notes, c.id AS contact_id, c.name
    FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id
    WHERE o.source_url = ? AND NOT EXISTS (SELECT 1 FROM crm_contact_phones p WHERE p.contact_id = c.id)
    ORDER BY o.created_at DESC LIMIT 1`).bind(sourceUrl).first();
}

async function upgradePlaceholderEntry(db, placeholder, entry, subKey, phone) {
  const nextName = boundedText(entry.name, 100) || placeholder.name;
  const nextNotes = boundedText(entry.notes, 1200) || placeholder.notes || '';
  const nextTrack = inferOpportunityTrack(entry);
  const statements = [
    db.prepare('UPDATE crm_contacts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(nextName, placeholder.contact_id),
    db.prepare('UPDATE crm_opportunities SET track=?,notes=?,source=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(nextTrack, nextNotes, ['call', 'missed_call', 'referral', 'website', 'whatsapp', 'other'].includes(entry.source) ? entry.source : 'whatsapp', placeholder.opportunity_id),
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(subKey, 'opportunity', placeholder.opportunity_id),
  ];
  if (phone) {
    statements.push(
      db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,1)')
        .bind(id(), placeholder.contact_id, phone, boundedText(entry.phone_label, 40) || 'واتساب'),
    );
  }
  await db.batch(statements);
  return { createdContact: 0, updatedContact: 1, createdOpportunity: 0, linkedProperty: 0 };
}

async function resolveSealedContactGroup(db, entry, phone) {
  if (phone) {
    const existingPhone = await findPhone(db, phone);
    if (existingPhone) return { contactId: existingPhone.contact_id, isNew: false, groupReceiptKey: '' };
  }
  const rawKey = boundedText(entry.contact_key, 80);
  const groupReceiptKey = /^[A-Za-z0-9._:-]{6,80}$/.test(rawKey) ? `cgroup:${rawKey}` : '';
  if (groupReceiptKey) {
    const existingGroup = await receipt(db, groupReceiptKey);
    if (existingGroup?.resource_id) {
      return { contactId: existingGroup.resource_id, isNew: false, groupReceiptKey: '' };
    }
  }
  return { contactId: id(), isNew: true, groupReceiptKey };
}

async function insertSealedOpportunityEntry(db, scope, entry, subKey, phone) {
  const parsed = parseOpportunityInput({ ...entry, phone: undefined });
  if (parsed.error) return null;
  const { contactId, isNew, groupReceiptKey } = await resolveSealedContactGroup(db, entry, phone);
  const oppId = id();
  const statements = [];
  if (isNew) {
    statements.push(db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').bind(contactId, boundedText(entry.name, 100)));
    if (groupReceiptKey) {
      statements.push(
        db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
          .bind(groupReceiptKey, 'contact', contactId),
      );
    }
    if (phone) {
      statements.push(
        db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,1)')
          .bind(id(), contactId, phone, boundedText(entry.phone_label, 40) || 'واتساب'),
      );
    }
    await appendExtraPhonesStatements(db, statements, contactId, entry.extra_phones, phone);
  }
  const sourceUrl = safeSitePath(entry.source_url);
  statements.push(
    db.prepare(`INSERT INTO crm_opportunities(id,contact_id,track,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(oppId, contactId, parsed.track, parsed.intent, parsed.source, sourceUrl, parsed.status, boundedText(entry.area_label, 100), parsed.budgetMin.value, parsed.budgetMax.value, parsed.sizeMin.value, parsed.sizeMax.value, boundedText(entry.property_type, 80), boundedText(entry.notes, 1200), parsed.nextAction, parsed.nextAt, parsed.reason),
    db.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id(), oppId, initialActivityType(parsed.source), boundedText(entry.activity_summary || entry.notes, 1200) || 'تسجيل مشفر آمن', '', parsed.nextAction, parsed.nextAt),
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(subKey, 'opportunity', oppId),
  );
  let linkedProperty = 0;
  const extId = boundedText(entry.external_id, 160);
  if (extId && scope) {
    const listing = await db.prepare(`SELECT id FROM listings WHERE source_id=? AND external_id=? AND area_id IN (${scope.areaSql}) LIMIT 1`).bind(scope.sourceId, extId).first();
    if (listing) {
      statements.push(
        db.prepare('INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id,presentation_status,presented_price,notes) VALUES(?,?,?,?,?,?)')
          .bind(id(), oppId, listing.id, 'selected', parsed.budgetMax.value ?? parsed.budgetMin.value, boundedText(entry.property_notes, 700)),
      );
      linkedProperty = 1;
    }
  }
  await db.batch(statements);
  return { createdContact: isNew ? 1 : 0, updatedContact: 0, createdOpportunity: 1, linkedProperty };
}

async function findContactForPhoneBackfill(db, entry) {
  const rawKey = boundedText(entry.contact_key, 80);
  if (/^[A-Za-z0-9._:-]{6,80}$/.test(rawKey)) {
    const grp = await receipt(db, `cgroup:${rawKey}`);
    if (grp?.resource_id) {
      const row = await db.prepare('SELECT id FROM crm_contacts WHERE id=? LIMIT 1').bind(grp.resource_id).first();
      if (row?.id) return row.id;
    }
  }
  const rawCandidates = [entry.name, ...(Array.isArray(entry.match_names) ? entry.match_names.slice(0, 6) : [])];
  for (const cand of rawCandidates) {
    const clean = boundedText(cand, 100);
    if (!clean) continue;
    const exact = await db.prepare(
      `SELECT c.id FROM crm_contacts c WHERE c.name = ?
       ORDER BY EXISTS(SELECT 1 FROM crm_contact_phones p WHERE p.contact_id = c.id) ASC, c.created_at DESC LIMIT 1`,
    ).bind(clean).first();
    if (exact?.id) return exact.id;
    if (clean.length >= 10) {
      const noteHit = await db.prepare(
        `SELECT c.id FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id
         WHERE INSTR(o.notes, ?) > 0 AND NOT EXISTS(SELECT 1 FROM crm_contact_phones p WHERE p.contact_id = c.id)
         ORDER BY o.created_at DESC LIMIT 1`,
      ).bind(clean.slice(0, 70)).first();
      if (noteHit?.id) return noteHit.id;
    }
  }
  return null;
}

async function applySealedPhoneBackfillEntry(db, entry, subKey, phone) {
  if (!phone) return null;
  const existingPhone = await findPhone(db, phone);
  if (existingPhone) {
    const statements = [
      db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
        .bind(subKey, 'contact', existingPhone.contact_id),
    ];
    await appendExtraPhonesStatements(db, statements, existingPhone.contact_id, entry.extra_phones, phone);
    const addedExtras = statements.length > 1;
    await db.batch(statements);
    return { createdContact: 0, updatedContact: addedExtras ? 1 : 0, createdOpportunity: 0, linkedProperty: 0 };
  }
  const targetContactId = await findContactForPhoneBackfill(db, entry);
  if (!targetContactId) return null;
  const existingPrimary = await db.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(targetContactId).first();
  const primaryFlag = existingPrimary ? 0 : 1;
  const statements = [
    db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
      .bind(id(), targetContactId, phone, boundedText(entry.phone_label, 40) || 'واتساب', primaryFlag),
    db.prepare('UPDATE crm_contacts SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(targetContactId),
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(subKey, 'contact', targetContactId),
  ];
  await appendExtraPhonesStatements(db, statements, targetContactId, entry.extra_phones, phone);
  await db.batch(statements);
  return { createdContact: 0, updatedContact: 1, createdOpportunity: 0, linkedProperty: 0 };
}

async function applySingleIngestEntry(db, scope, entry) {
  if (!entry || typeof entry !== 'object') return { skipped: 1 };
  const subKey = boundedText(entry.submission_key, 120);
  if (!/^[A-Za-z0-9._:-]{12,120}$/.test(subKey)) return { skipped: 1 };
  if (await receipt(db, subKey)) return { skipped: 1 };
  const phone = entry.phone ? normalizePhone(entry.phone) : null;
  if (entry.phone && !phone) return { skipped: 1 };
  if (entry.entry_type === 'phone_backfill') {
    const synced = await applySealedPhoneBackfillEntry(db, entry, subKey, phone);
    return synced ? { skipped: 0, ...synced } : { skipped: 1 };
  }
  if (entry.entry_type === 'contact_only') {
    const contactOnly = await insertSealedContactOnlyEntry(db, entry, subKey, phone);
    return contactOnly ? { skipped: 0, ...contactOnly } : { skipped: 1 };
  }
  const sourceUrl = safeSitePath(entry.source_url);
  const placeholder = sourceUrl ? await findPlaceholderBySourceUrl(db, sourceUrl) : null;
  if (placeholder && (!phone || !(await findPhone(db, phone)))) {
    const res = await upgradePlaceholderEntry(db, placeholder, entry, subKey, phone);
    return { skipped: 0, ...res };
  }
  const inserted = await insertSealedOpportunityEntry(db, scope, entry, subKey, phone);
  if (!inserted) return { skipped: 1 };
  return { skipped: 0, ...inserted };
}

async function handleSealedIngest(request, env, config) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const privKey = typeof env.CRM_INGEST_PRIVATE_KEY === 'string' ? env.CRM_INGEST_PRIVATE_KEY.trim() : '';
  if (!privKey) return json({ error: 'ingest_not_configured' }, 503);
  const body = await readJson(request, 560_000);
  const envelope = typeof body.sealed_payload === 'string' ? body.sealed_payload.trim() : '';
  if (!SEALED_ENVELOPE_RE.test(envelope)) return json({ error: 'invalid_sealed_envelope' }, 400);

  const ticketKey = `sealed-ticket:${await sha256Hex(envelope)}`;
  const ticket = await env.DB.prepare('SELECT resource_id FROM crm_idempotency_receipts WHERE submission_key=?').bind(ticketKey).first();
  if (!ticket || ticket.resource_id !== 'authorized_pending') {
    return json({ error: 'unauthorized_sealed_ingest' }, 403);
  }

  const unsealed = await unsealIngestPayload(envelope, privKey);
  if (!unsealed || unsealed.entries.length === 0 || unsealed.entries.length > 250) {
    return json({ error: 'invalid_sealed_payload' }, 400);
  }

  await env.DB.prepare("UPDATE crm_idempotency_receipts SET resource_id='consumed' WHERE submission_key=? AND resource_id='authorized_pending'")
    .bind(ticketKey)
    .run();

  if (unsealed.wipeExistingCustomers) {
    await wipeExistingCustomerData(env.DB);
  }

  const totals = {
    wiped_existing: unsealed.wipeExistingCustomers,
    processed: 0,
    created_contacts: 0,
    updated_contacts: 0,
    created_opportunities: 0,
    linked_properties: 0,
    skipped: 0,
  };
  for (const entry of unsealed.entries) {
    const res = await applySingleIngestEntry(env.DB, config.scope, entry);
    if (res.skipped) {
      totals.skipped += 1;
    } else {
      totals.processed += 1;
      totals.created_contacts += res.createdContact;
      totals.updated_contacts += res.updatedContact;
      totals.created_opportunities += res.createdOpportunity;
      totals.linked_properties += res.linkedProperty;
    }
  }
  return json({ ok: true, ...totals });
}

const ALLOWED_STATUSES = ['active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close', 'won', 'lost', 'paused', 'unqualified'];
const ACTIVE_STATUS_SET = new Set(['active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close']);
const ALLOWED_LOSS_REASONS = ['price', 'location', 'size', 'financing', 'timing', 'no_response', 'competition', 'unsuitable', 'other'];

function orderedRangeValid(minResult, maxResult) {
  if (!minResult.ok || !maxResult.ok) return false;
  if (minResult.value === null || maxResult.value === null) return true;
  return minResult.value <= maxResult.value;
}

function hasValidFollowupRule(status, nextAction, nextAt, reason) {
  if (!ACTIVE_STATUS_SET.has(status)) return true;
  if (nextAction && nextAt) return true;
  return Boolean(reason);
}

function resolveInputStatusAndReason(body, track) {
  const hasExplicitStatus = ALLOWED_STATUSES.includes(body.status);
  const defaultStatus = track === 'transient' ? 'paused' : 'active';
  const status = hasExplicitStatus ? body.status : defaultStatus;
  const rawReason = boundedText(body.no_followup_reason, 240) || null;
  if (rawReason) return { status, reason: rawReason };
  if (track === 'transient') return { status, reason: 'عميل عابر (طيارة ✈️) — محفوظ بالأرشيف للرجوع عند الحاجة' };
  return { status, reason: null };
}

function parseOpportunityInput(body) {
  if (body.track !== undefined && body.track !== '' && !ALLOWED_TRACKS.includes(body.track)) {
    return { error: json({ error: 'invalid_track' }, 400) };
  }
  const track = inferOpportunityTrack(body);
  const phone = body.phone ? normalizePhone(body.phone) : null;
  const intent = ['buy', 'rent', 'sell', 'lease', 'other'].includes(body.intent) ? body.intent : null;
  const source = ['call', 'missed_call', 'referral', 'website', 'whatsapp', 'other'].includes(body.source) ? body.source : null;
  const { status, reason } = resolveInputStatusAndReason(body, track);
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const budgetMin = optionalNumber(body.budget_min);
  const budgetMax = optionalNumber(body.budget_max);
  const sizeMin = optionalNumber(body.size_min_m2);
  const sizeMax = optionalNumber(body.size_max_m2);

  const basicValid = (!body.phone || Boolean(phone))
    && Boolean(intent)
    && Boolean(source)
    && (!body.next_followup_at || Boolean(nextAt))
    && orderedRangeValid(budgetMin, budgetMax)
    && orderedRangeValid(sizeMin, sizeMax);
  if (!basicValid) {
    return { error: json({ error: 'invalid_contact_or_opportunity' }, 400) };
  }
  if (!hasValidFollowupRule(status, nextAction, nextAt, reason)) {
    return { error: json({ error: 'next_action_required' }, 400) };
  }
  if (status === 'lost' && !ALLOWED_LOSS_REASONS.includes(body.loss_reason)) {
    return { error: json({ error: 'loss_reason_required' }, 400) };
  }
  return { track, phone, intent, source, status, nextAction, nextAt, reason, budgetMin, budgetMax, sizeMin, sizeMax };
}

function initialActivityType(source) {
  if (source === 'call') return 'call';
  if (source === 'missed_call') return 'missed_call';
  if (source === 'whatsapp') return 'whatsapp_note';
  return 'note';
}

async function resolveOpportunityContact(db, requestedId, phone, name) {
  const existing = requestedId ? await db.prepare('SELECT id,name FROM crm_contacts WHERE id=?').bind(requestedId).first() : null;
  if (requestedId && !existing) return { error: json({ error: 'contact_not_found' }, 404) };
  if (!requestedId && !phone && !normalizeName(name)) return { error: json({ error: 'contact_or_phone_required' }, 400) };
  const byPhone = phone ? await findPhone(db, phone) : null;
  if (byPhone && existing && byPhone.contact_id !== existing.id) return { error: duplicatePhone() };
  const contact = existing || (byPhone ? { id: byPhone.contact_id, name: byPhone.name } : null);
  if (!namesCompatible(contact?.name || '', name)) return { error: duplicatePhone() };
  return { contact, phoneExists: Boolean(byPhone) };
}

async function handleOpportunityBatchError(db, error, key, phone, name) {
  const message = String(error?.message || '');
  if (/UNIQUE constraint failed: crm_idempotency_receipts\.submission_key/.test(message)) {
    const replay = await receipt(db, key);
    if (replay?.resource_type === 'opportunity') return json({ contact_id: null, opportunity_id: replay.resource_id, duplicate_submission: true });
    return json({ error: 'idempotency_key_reused' }, 409);
  }
  if (phone && /UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(message)) {
    const winner = await findPhone(db, phone);
    if (winner && namesCompatible(winner.name, name)) return json({ error: 'retry_with_resolved_contact', review_required: true }, 409);
    return duplicatePhone();
  }
  return sqlError(error);
}

async function buildContactSetupStatements(db, contact, contactId, name, phone, phoneExists) {
  const statements = [];
  if (!contact) {
    statements.push(db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').bind(contactId, name));
  } else if (!normalizeName(contact.name || '') && normalizeName(name)) {
    statements.push(db.prepare('UPDATE crm_contacts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name, contactId));
  }
  if (phone && !phoneExists) {
    const hasPrimary = await db.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(contactId).first();
    statements.push(db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,is_primary) VALUES(?,?,?,?)').bind(id(), contactId, phone, hasPrimary ? 0 : 1));
  }
  return statements;
}

async function createOpportunity(request, env) {
  const body = await readJson(request);
  const parsed = parseOpportunityInput(body);
  if (parsed.error) return parsed.error;
  const key = validIdempotency(request);
  if (!key) return json({ error: 'idempotency_key_required' }, 400);
  const prior = await receipt(env.DB, key);
  if (prior) {
    if (prior.resource_type === 'opportunity') return json({ contact_id: null, opportunity_id: prior.resource_id, duplicate_submission: true });
    return json({ error: 'idempotency_key_reused' }, 409);
  }

  const name = boundedText(body.name, 100);
  const requestedId = boundedText(body.contact_id, 80);
  const resolved = await resolveOpportunityContact(env.DB, requestedId, parsed.phone, name);
  if (resolved.error) return resolved.error;

  const contactId = resolved.contact?.id || id();
  const opportunityId = id();
  const statements = await buildContactSetupStatements(env.DB, resolved.contact, contactId, name, parsed.phone, resolved.phoneExists);
  const closedAt = parsed.status === 'won' || parsed.status === 'lost' ? new Date().toISOString() : null;
  statements.push(
    env.DB.prepare(`INSERT INTO crm_opportunities(id,contact_id,track,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,closed_at,loss_reason,loss_notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(opportunityId, contactId, parsed.track, parsed.intent, parsed.source, safeSitePath(body.source_url), parsed.status, boundedText(body.area_label, 100), parsed.budgetMin.value, parsed.budgetMax.value, parsed.sizeMin.value, parsed.sizeMax.value, boundedText(body.property_type, 80), boundedText(body.notes, 1200), parsed.nextAction, parsed.nextAt, parsed.reason, closedAt, body.loss_reason || null, boundedText(body.loss_notes, 500)),
  );
  statements.push(env.DB.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)').bind(key, 'opportunity', opportunityId));
  statements.push(
    env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id(), opportunityId, initialActivityType(parsed.source), boundedText(body.notes, 1200) || 'تسجيل فرصة جديدة', '', parsed.nextAction, parsed.nextAt),
  );

  try {
    await env.DB.batch(statements);
    return json({ contact_id: contactId, opportunity_id: opportunityId, duplicate_submission: false }, 201);
  } catch (error) {
    return handleOpportunityBatchError(env.DB, error, key, parsed.phone, name);
  }
}

function resolveLossReason(nextStatus, requestedReason, current) {
  if (nextStatus !== 'lost') return null;
  if (ALLOWED_LOSS_REASONS.includes(requestedReason)) return requestedReason;
  if (current.status === 'lost') return current.loss_reason;
  return null;
}

function resolveClosedAt(nextStatus, current) {
  if (nextStatus !== 'won' && nextStatus !== 'lost') return null;
  if (current.status === nextStatus && current.closed_at) return current.closed_at;
  return new Date().toISOString();
}

function resolveTrackTransition(current, targetTrack) {
  if (targetTrack === 'transient') {
    return {
      status: ACTIVE_STATUS_SET.has(current.status) ? 'paused' : current.status,
      nextAction: null,
      nextAt: null,
      reason: 'نُقل إلى أرشيف الطيارة ✈️ (عميل عابر خارج المتابعة اليومية)',
    };
  }
  const status = current.status === 'paused' ? 'active' : current.status;
  const needsFallbackReason = ACTIVE_STATUS_SET.has(status) && (!current.next_action || !current.next_followup_at);
  return {
    status,
    nextAction: current.next_action || null,
    nextAt: current.next_followup_at || null,
    reason: needsFallbackReason ? (current.no_followup_reason || 'نشط بالمسار — بانتظار جدولة المتابعة') : (current.no_followup_reason || null),
  };
}

function parseOpportunityPatch(body, current) {
  const allowedIntents = ['buy', 'rent', 'sell', 'lease', 'other'];
  const intent = body.intent === undefined ? current.intent : body.intent;
  if (!allowedIntents.includes(intent)) return { error: json({ error: 'invalid_contact_or_opportunity' }, 400) };
  const budgetMin = body.budget_min === undefined ? { ok: true, value: current.budget_min } : optionalNumber(body.budget_min);
  const budgetMax = body.budget_max === undefined ? { ok: true, value: current.budget_max } : optionalNumber(body.budget_max);
  const sizeMin = body.size_min_m2 === undefined ? { ok: true, value: current.size_min_m2 } : optionalNumber(body.size_min_m2);
  const sizeMax = body.size_max_m2 === undefined ? { ok: true, value: current.size_max_m2 } : optionalNumber(body.size_max_m2);
  if (!orderedRangeValid(budgetMin, budgetMax) || !orderedRangeValid(sizeMin, sizeMax)) {
    return { error: json({ error: 'invalid_contact_or_opportunity' }, 400) };
  }
  const areaLabel = body.area_label === undefined ? current.area_label : boundedText(body.area_label, 100);
  const propertyType = body.property_type === undefined ? current.property_type : boundedText(body.property_type, 80);
  const notes = body.notes === undefined ? current.notes : boundedText(body.notes, 1200);
  return { intent, areaLabel, propertyType, notes, budgetMin: budgetMin.value, budgetMax: budgetMax.value, sizeMin: sizeMin.value, sizeMax: sizeMax.value };
}

async function updateOpportunity(request, env, opportunityId) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  const patch = parseOpportunityPatch(body, current);
  if (patch.error) return patch.error;
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE crm_opportunities SET intent=?,area_label=?,property_type=?,budget_min=?,budget_max=?,size_min_m2=?,size_max_m2=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(patch.intent, patch.areaLabel, patch.propertyType, patch.budgetMin, patch.budgetMax, patch.sizeMin, patch.sizeMax, patch.notes, opportunityId),
      env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id(), opportunityId, 'note', 'تحديث مواصفات أو ملاحظات الفرصة', '', current.next_action, current.next_followup_at),
    ]);
    return json({ ok: true, opportunity_id: opportunityId });
  } catch (error) {
    return sqlError(error);
  }
}

async function switchOpportunityTrack(request, env, opportunityId) {
  const body = await readJson(request);
  const targetTrack = body.track;
  if (!ALLOWED_TRACKS.includes(targetTrack)) return json({ error: 'invalid_track' }, 400);
  const current = await env.DB.prepare('SELECT id,track,status,next_action,next_followup_at,no_followup_reason FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  const transition = resolveTrackTransition(current, targetTrack);
  const label = TRACK_LABELS_AR[targetTrack] || targetTrack;
  const summary = `تغيير المسار اللوني إلى ${label}`;
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE crm_opportunities SET track=?,status=?,next_action=?,next_followup_at=?,no_followup_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(targetTrack, transition.status, transition.nextAction, transition.nextAt, transition.reason, opportunityId),
      env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id(), opportunityId, 'status_change', summary, '', transition.nextAction, transition.nextAt),
    ]);
    return json({ ok: true, opportunity_id: opportunityId, track: targetTrack, status: transition.status });
  } catch (error) {
    return sqlError(error);
  }
}

async function queryCatalogMatches(db, scope, opp, targetTrack) {
  if (!scope || (opp.intent !== 'buy' && opp.intent !== 'rent')) return [];
  const txType = opp.intent === 'buy' ? 'sale' : 'rent';
  const rows = await db.prepare(`SELECT id,external_id,title,url,price,area_m2,bedrooms,bathrooms
    FROM listings
    WHERE source_id=? AND area_id IN (${scope.areaSql}) AND status='active' AND transaction_type=?
    ORDER BY price_updated_at DESC, id DESC LIMIT 40`).bind(scope.sourceId, txType).all();
  const filtered = rows.results.filter(item => {
    const inferred = inferStructuralTrack(item.title, opp.intent, '');
    return inferred === targetTrack || (targetTrack === 'sale_apt' && inferred !== 'admin_hq');
  });
  return filtered.slice(0, 5);
}

async function getOpportunityMatches(db, opportunityId, scope) {
  const opp = await db.prepare('SELECT id,track,intent,property_type,area_label,budget_min,budget_max,size_min_m2,size_max_m2,notes FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!opp) return json({ error: 'opportunity_not_found' }, 404);
  const targetTrack = opp.track === 'transient'
    ? inferStructuralTrack(opp.property_type, opp.intent, opp.notes)
    : opp.track;
  const isSupply = opp.intent === 'sell' || opp.intent === 'lease';
  const oppositeSql = isSupply ? "'buy','rent'" : "'sell','lease'";
  const candidates = await db.prepare(`SELECT o.id,o.track,o.intent,o.status,o.area_label,o.budget_min,o.budget_max,o.size_min_m2,o.size_max_m2,o.property_type,o.notes,
      c.name AS contact_name,
      (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.id != ? AND o.intent IN (${oppositeSql}) AND (o.track = ? OR o.track = 'transient')
    ORDER BY CASE WHEN o.track='transient' THEN 1 ELSE 0 END, o.updated_at DESC LIMIT 20`).bind(opportunityId, targetTrack).all();
  const matchingOpportunities = candidates.results
    .filter(row => row.track === targetTrack || inferStructuralTrack(row.property_type, row.intent, row.notes) === targetTrack)
    .slice(0, 8);
  const matchingListings = await queryCatalogMatches(db, scope, opp, targetTrack);
  return json({
    target_track: targetTrack,
    opportunities: matchingOpportunities,
    listings: matchingListings,
  });
}

async function addActivity(request, env, opportunityId) {
  const body = await readJson(request);
  const summary = boundedText(body.summary, 1200);
  const allowedTypes = ['call', 'missed_call', 'whatsapp_note', 'visit', 'offer', 'objection', 'note', 'status_change'];
  const activityType = allowedTypes.includes(body.activity_type) ? body.activity_type : null;
  const status = body.status;
  const requestedTrack = body.track;
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason, 240) || null;
  const current = await env.DB.prepare('SELECT id,track,status,closed_at,loss_reason,loss_notes FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  if (!summary || !activityType || (status && !ALLOWED_STATUSES.includes(status)) || (requestedTrack && !ALLOWED_TRACKS.includes(requestedTrack)) || (body.next_followup_at && !nextAt)) {
    return json({ error: 'invalid_activity' }, 400);
  }
  const nextTrack = requestedTrack || current.track || 'sale_apt';
  const nextStatus = status || current.status;
  if (ACTIVE_STATUS_SET.has(nextStatus) && (!nextAction || !nextAt) && !reason) {
    return json({ error: 'next_action_required' }, 400);
  }
  const closed = resolveClosedAt(nextStatus, current);
  const lossReason = resolveLossReason(nextStatus, body.loss_reason, current);
  const lossNotes = nextStatus === 'lost' ? (boundedText(body.loss_notes, 500) || current.loss_notes || '') : '';
  if (nextStatus === 'lost' && !lossReason) return json({ error: 'loss_reason_required' }, 400);
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE crm_opportunities SET track=?,status=?,next_action=?,next_followup_at=?,no_followup_reason=?,closed_at=?,loss_reason=?,loss_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(nextTrack, nextStatus, nextAction, nextAt, reason, closed, lossReason, lossNotes, opportunityId),
      env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id(), opportunityId, activityType, summary, boundedText(body.outcome, 200), nextAction, nextAt),
    ]);
    return json({ ok: true, opportunity_id: opportunityId });
  } catch (error) {
    return sqlError(error);
  }
}

function attachHeaders(response, extraHeaders) {
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(extraHeaders)) merged.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function applyPwaAssetHeaders(pathname, assetHeaders) {
  const isPwaPublicMeta = pathname === '/crm-manifest.webmanifest' || pathname.endsWith('.png');
  if (pathname === '/crm-manifest.webmanifest') {
    assetHeaders.set('content-type', 'application/manifest+json; charset=utf-8');
  } else if (pathname.endsWith('.png')) {
    assetHeaders.set('content-type', 'image/png');
  } else if (pathname.endsWith('.js')) {
    assetHeaders.set('content-type', 'application/javascript; charset=utf-8');
  }
  if (isPwaPublicMeta) {
    assetHeaders.set('cache-control', 'public, max-age=3600');
    assetHeaders.delete('pragma');
  } else {
    assetHeaders.set('cache-control', 'private, no-store');
    assetHeaders.set('pragma', 'no-cache');
    assetHeaders.set('x-frame-options', 'DENY');
    assetHeaders.set('content-security-policy', UI_CSP);
  }
  if (pathname === '/crm-sw.js') assetHeaders.set('service-worker-allowed', '/');
}

async function serveUiAsset(request, url, env) {
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !env.ASSETS) return null;
  if (!UI_ASSET_PATHS.has(url.pathname)) return null;
  const assetUrl = new URL(url.toString());
  if (assetUrl.pathname === '/') assetUrl.pathname = '/crm.html';
  const assetRequest = new Request(assetUrl.toString(), { method: request.method, headers: request.headers });
  const asset = await env.ASSETS.fetch(assetRequest);
  const assetHeaders = new Headers(asset.headers);
  assetHeaders.set('x-content-type-options', 'nosniff');
  assetHeaders.set('referrer-policy', 'same-origin');
  applyPwaAssetHeaders(url.pathname, assetHeaders);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: assetHeaders });
}

const EXACT_GET_ROUTES = {
  '/api/contacts': (db, url) => listContacts(db, url),
  '/api/dashboard': (db, url) => dashboard(db, url),
  '/api/opportunities': (db, url) => listOpportunities(db, url),
  '/api/listings': (db, url, config) => listListings(db, url, config.scope),
  '/api/push/config': (_db, _url, _config, env) => getPushStatusResponse(env, json),
};

const EXACT_POST_ROUTES = {
  '/api/contacts': (request, env) => createContact(request, env),
  '/api/opportunities': (request, env) => createOpportunity(request, env),
  '/api/push/subscribe': (request, env) => subscribePushDevice(request, env, { readJson, boundedText, jsonHelper: json }),
  '/api/push/unsubscribe': (request, env) => unsubscribePushDevice(request, env, { readJson, jsonHelper: json }),
  '/api/push/test': (request, env) => sendTestPushAlert(request, env, { readJson, jsonHelper: json }),
  '/api/push/check-now': async (_request, env) => json(await runScheduledCrmNotifications(env, { forceCheck: true })),
};

const PARAM_ROUTES = [
  { method: 'POST', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/phones$/, run: (req, env, idVal) => addContactPhone(req, env, idVal) },
  { method: 'GET', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/, run: (_req, env, idVal) => getContact(env.DB, idVal) },
  { method: 'POST', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, idVal) => updateContact(req, env, idVal) },
  { method: 'GET', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/, run: (_req, env, idVal) => getOpportunity(env.DB, idVal) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, idVal) => updateOpportunity(req, env, idVal) },
  { method: 'GET', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/matches$/, run: (_req, env, idVal, cfg) => getOpportunityMatches(env.DB, idVal, cfg.scope) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/track$/, run: (req, env, idVal) => switchOpportunityTrack(req, env, idVal) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/activities$/, run: (req, env, idVal) => addActivity(req, env, idVal) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/properties$/, run: (req, env, idVal, cfg) => linkProperty(req, env, idVal, cfg.scope) },
];

async function dispatchParameterizedApi(request, pathname, env, config) {
  for (const route of PARAM_ROUTES) {
    if (request.method !== route.method) continue;
    const match = route.re.exec(pathname);
    if (match) return route.run(request, env, match[1], config);
  }
  return json({ error: 'not_found' }, 404);
}

async function dispatchProtectedApi(request, url, env, config) {
  if (request.method === 'GET' && EXACT_GET_ROUTES[url.pathname]) {
    return EXACT_GET_ROUTES[url.pathname](env.DB, url, config, env);
  }
  if (request.method === 'POST' && EXACT_POST_ROUTES[url.pathname]) {
    return EXACT_POST_ROUTES[url.pathname](request, env);
  }
  return dispatchParameterizedApi(request, url.pathname, env, config);
}

async function dispatchAuthRoute(request, pathname, env, config) {
  if (pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env, config);
  if (pathname === '/api/auth/session' && request.method === 'GET') return handleSessionStatus(request, env, config);
  if (pathname === '/api/auth/logout' && request.method === 'POST') return handleLogout(request, env, config);
  return null;
}

function errorResponse(error, corsHeaders) {
  if (error?.message === 'body_too_large') return json({ error: 'body_too_large' }, 413, corsHeaders);
  if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400, corsHeaders);
  return json({ error: 'request_failed' }, 500, corsHeaders);
}

async function handleConfiguredRequest(request, url, env, config, corsHeaders) {
  if (!url.pathname.startsWith('/api/')) {
    const uiAsset = await serveUiAsset(request, url, env);
    if (uiAsset) return attachHeaders(uiAsset, corsHeaders);
  }

  if (url.pathname === '/api/ingest/sealed') {
    return attachHeaders(await handleSealedIngest(request, env, config), corsHeaders);
  }

  const originCheck = verifyRequestOrigin(request, config);
  if (!originCheck.ok) return json({ error: originCheck.code }, originCheck.status, corsHeaders);

  const authResponse = await dispatchAuthRoute(request, url.pathname, env, config);
  if (authResponse) return attachHeaders(authResponse, corsHeaders);

  const auth = await verifySession(request, env, config);
  if (!auth.ok) {
    const extra = auth.hadCookie ? { ...corsHeaders, 'set-cookie': clearSessionCookieHeader() } : corsHeaders;
    return json({ error: auth.code }, auth.status, extra);
  }

  return attachHeaders(await dispatchProtectedApi(request, url, env, config), corsHeaders);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const corsHeaders = cors(origin, env);
    if (request.method === 'OPTIONS') {
      const status = origin && origin === allowedOrigin(env) ? 204 : 403;
      return new Response(null, { status, headers: corsHeaders });
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'nasr-crm-api' });
    }

    const config = authConfig(env);
    if (!config) return json({ error: 'auth_not_configured' }, 503, corsHeaders);

    try {
      return await handleConfiguredRequest(request, url, env, config, corsHeaders);
    } catch (error) {
      return errorResponse(error, corsHeaders);
    }
  },
  async scheduled(_controller, env, ctx) {
    const task = runScheduledCrmNotifications(env);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
      return undefined;
    }
    return task;
  },
};
