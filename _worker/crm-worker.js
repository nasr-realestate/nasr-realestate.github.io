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
import {
  buildPhoneSearchVariants,
  extractSafeLinks,
  getCairoClock,
  getCairoDayBoundsUtc,
  normalizeInternationalPhone,
  sanitizeExternalOrSiteUrl,
} from './crm-chat-intel.js';
import {
  buildFollowupWorkspaceData,
  computeOpportunityMatches,
  getConversationDetailData,
  importConversationPayload,
  linkConversationToContactPayload,
  listConversationsData,
  refreshTimeBasedSmartAlerts,
  resolveSmartAlertPayload,
  runSourceSyncBundle,
} from './crm-sync-and-match.js';

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
  '/crm-assets/followups-ui.js',
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
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

async function handleCiTicketLogin(request, env, config) {
  const body = await readJson(request, 2048);
  const nonce = typeof body.ticket_nonce === 'string' ? body.ticket_nonce.trim() : '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    return json({ error: 'invalid_ci_ticket' }, 400);
  }
  const ticketKey = `ci-e2e-ticket:${await sha256Hex(nonce)}`;
  const row = await env.DB.prepare(
    'SELECT resource_id, created_at FROM crm_idempotency_receipts WHERE submission_key = ? LIMIT 1',
  ).bind(ticketKey).first();
  if (!row || row.resource_id !== 'authorized_pending') {
    return json({ error: 'unauthorized_ci_ticket' }, 403);
  }
  const createdMs = Date.parse(String(row.created_at || '').includes('T') ? row.created_at : `${String(row.created_at).replace(' ', 'T')}Z`);
  if (!Number.isFinite(createdMs) || Math.abs(Date.now() - createdMs) > 90_000) {
    await env.DB.prepare("UPDATE crm_idempotency_receipts SET resource_id='expired' WHERE submission_key=?").bind(ticketKey).run();
    return json({ error: 'expired_ci_ticket' }, 403);
  }
  const consumeRes = await env.DB.prepare(
    "UPDATE crm_idempotency_receipts SET resource_id='consumed' WHERE submission_key=? AND resource_id='authorized_pending'",
  ).bind(ticketKey).run();
  if ((consumeRes?.meta?.changes ?? consumeRes?.changes ?? 1) === 0) {
    return json({ error: 'unauthorized_ci_ticket' }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(config.ttlSeconds, 900);
  const sessionId = id();
  const sessionToken = randomToken(32);
  const tokenHash = await hmacHex(config.sessionSecret, `session:${sessionToken}`);
  const csrfToken = await deriveCsrfToken(config.sessionSecret, sessionId, sessionToken);
  const csrfHash = await sha256Hex(csrfToken);
  const expiresAt = now + ttl;
  await env.DB.prepare(
    'INSERT INTO crm_sessions(id, token_hash, csrf_hash, created_at, expires_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)',
  ).bind(sessionId, tokenHash, csrfHash, now, expiresAt, now).run();

  return json(
    {
      ok: true,
      authenticated: true,
      session_id: sessionId,
      csrf_token: csrfToken,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    },
    200,
    { 'set-cookie': sessionCookieHeader(sessionToken, ttl) },
  );
}

export function normalizePhone(raw) {
  return normalizeInternationalPhone(raw);
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
  return sanitizeExternalOrSiteUrl(value);
}

async function hasTable(db, tableName) {
  const row = await db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1").bind(tableName).first();
  return Boolean(row?.ok);
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
  const nowParam = url.searchParams.get('now');
  const now = nowParam && isoDate(nowParam) ? new Date(isoDate(nowParam)) : new Date();
  const cairo = getCairoClock(now);
  const day = url.searchParams.get('day') || cairo.dayKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'invalid_day' }, 400);
  const bounds = getCairoDayBoundsUtc(day);
  if (!bounds) return json({ error: 'invalid_day' }, 400);
  const start = bounds.startUtcIso;
  const end = bounds.endUtcIso;
  const current = now.toISOString();

  let smartAlertsOpen = 0;
  let unmatchedChatsCount = 0;
  if (await hasTable(db, 'crm_smart_alerts')) {
    await refreshTimeBasedSmartAlerts(db, now);
    const [saRow, umRow] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS cnt FROM crm_smart_alerts WHERE status = 'open'").first(),
      db.prepare("SELECT COUNT(*) AS cnt FROM crm_conversations WHERE match_status = 'unmatched_review'").first(),
    ]);
    smartAlertsOpen = Number(saRow?.cnt || 0);
    unmatchedChatsCount = Number(umRow?.cnt || 0);
  }

  const s0006 = await inspectSchema0006(db);
  const nameSql = oppContactNameSql(s0006);
  const convJoin = oppConvJoinSql(s0006);
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM crm_opportunities WHERE status IN (${ACTIVE}) AND track != 'transient'`).first();
  const trackRows = await db.prepare(`SELECT track, COUNT(*) AS total,
      SUM(CASE WHEN intent IN ('sell','lease') THEN 1 ELSE 0 END) AS supply_count,
      SUM(CASE WHEN intent IN ('buy','rent') THEN 1 ELSE 0 END) AS demand_count
    FROM crm_opportunities GROUP BY track`).all();
  const today = await db.prepare(`SELECT o.id,o.track,o.contact_id,${nameSql} AS name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.area_label,o.next_action,o.next_followup_at
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at IS NOT NULL AND datetime(o.next_followup_at) >= datetime(?) AND datetime(o.next_followup_at) <= datetime(?) ORDER BY o.next_followup_at`).bind(start, end).all();
  const overdue = await db.prepare(`SELECT o.id,o.track,o.contact_id,${nameSql} AS name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.area_label,o.next_action,o.next_followup_at
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at IS NOT NULL AND datetime(o.next_followup_at) < datetime(?) ORDER BY o.next_followup_at LIMIT 200`).bind(current).all();
  const noAction = await db.prepare(`SELECT o.id,o.track,o.contact_id,${nameSql} AS name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.no_followup_reason,o.updated_at
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND o.next_followup_at IS NULL AND COALESCE(o.no_followup_reason,'')='' ORDER BY o.updated_at LIMIT 200`).all();
  const stale = await db.prepare(`SELECT o.id,o.track,o.contact_id,${nameSql} AS name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.updated_at,
    (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id) AS last_activity
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
    WHERE o.status IN (${ACTIVE}) AND o.track != 'transient' AND COALESCE((SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id),o.updated_at) < ?
    ORDER BY COALESCE(last_activity,o.updated_at) LIMIT 200`).bind(new Date(now.getTime() - 7 * 86400000).toISOString()).all();
  const visits = await db.prepare(`SELECT p.id,p.viewing_at,p.viewing_result,o.id AS opportunity_id,o.track,${nameSql} AS name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,l.title,l.url
    FROM crm_opportunity_properties p JOIN crm_opportunities o ON o.id=p.opportunity_id
    LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin} JOIN listings l ON l.id=p.listing_id
    WHERE p.presentation_status='viewing_scheduled' AND p.viewing_at IS NOT NULL AND datetime(p.viewing_at) >= datetime(?) AND datetime(p.viewing_at) <= datetime(?) ORDER BY p.viewing_at`).bind(start, end).all();
  const outcomes = await db.prepare(`SELECT status, COUNT(*) AS count FROM crm_opportunities WHERE status IN ('won','lost','paused','unqualified') GROUP BY status`).all();
  const contactlessRow = await db.prepare("SELECT COUNT(*) AS count FROM crm_opportunities WHERE contact_id IS NULL AND track != 'transient'").first();
  return json({
    day,
    timezone: 'Africa/Cairo',
    cairo_bounds_utc: bounds,
    generated_at: current,
    counts: {
      active: active?.count || 0,
      due_today: today.results.length,
      overdue: overdue.results.length,
      missing_next_step: noAction.results.length,
      smart_alerts_open: smartAlertsOpen,
      unmatched_review_chats: unmatchedChatsCount,
      contactless_opportunities: Number(contactlessRow?.count || 0),
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

async function inspectSchema0006(db) {
  const [oppInfo, contactInfo] = await Promise.all([
    db.prepare('PRAGMA table_info(crm_opportunities)').all(),
    db.prepare('PRAGMA table_info(crm_contacts)').all(),
  ]);
  const oppCols = new Set((oppInfo?.results || []).map(r => r.name));
  const contactCols = new Set((contactInfo?.results || []).map(r => r.name));
  return {
    hasLeadLabel: oppCols.has('lead_label'),
    hasConversationId: oppCols.has('conversation_id'),
    hasArchivedAt: contactCols.has('archived_at'),
    hasReviewNote: contactCols.has('review_note'),
  };
}

function computeContactCompletenessStatus(row) {
  if (row?.archived_at) return 'archived';
  const hasPhone = Boolean(row?.primary_phone || row?.phone_numbers || Number(row?.phone_count || 0) > 0);
  return hasPhone ? 'complete' : 'incomplete';
}

function oppContactNameSql(s0006) {
  if (s0006.hasLeadLabel && s0006.hasConversationId) {
    return "COALESCE(c.name, NULLIF(o.lead_label, ''), cv_link.chat_title, 'فرصة قيد استكمال جهة الاتصال')";
  }
  if (s0006.hasLeadLabel) {
    return "COALESCE(c.name, NULLIF(o.lead_label, ''), 'فرصة قيد استكمال جهة الاتصال')";
  }
  return "COALESCE(c.name, 'عميل')";
}

function oppConvJoinSql(s0006) {
  return s0006.hasConversationId ? 'LEFT JOIN crm_conversations cv_link ON cv_link.id=o.conversation_id' : '';
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

function buildPhoneSearchClause(q, tableAlias = 'p', contactCol = 'c.id') {
  const variants = buildPhoneSearchVariants(q);
  if (variants.length === 0) {
    return { sql: `EXISTS (SELECT 1 FROM crm_contact_phones ${tableAlias} WHERE ${tableAlias}.contact_id=${contactCol} AND ${tableAlias}.phone_key LIKE ?)`, params: [`%${q}%`] };
  }
  const sub = variants.map(() => `${tableAlias}.phone_key LIKE ?`).join(' OR ');
  return {
    sql: `EXISTS (SELECT 1 FROM crm_contact_phones ${tableAlias} WHERE ${tableAlias}.contact_id=${contactCol} AND (${sub}))`,
    params: variants.map(v => `%${v}%`),
  };
}

function appendOpportunitySearchClause(q, s0006, where, params) {
  if (!q) return;
  const pat = `%${q}%`;
  const phoneClause = buildPhoneSearchClause(q, 'p', 'c.id');
  const leadParts = [];
  const leadParams = [];
  if (s0006.hasLeadLabel) {
    leadParts.push('o.lead_label LIKE ?');
    leadParams.push(pat);
  }
  if (s0006.hasConversationId) {
    leadParts.push('cv_link.chat_title LIKE ?');
    leadParams.push(pat);
  }
  const extraSql = leadParts.length ? `${leadParts.join(' OR ')} OR ` : '';
  where.push(`(c.name LIKE ? OR ${extraSql}${phoneClause.sql} OR o.area_label LIKE ? OR o.property_type LIKE ? OR o.notes LIKE ?)`);
  params.push(pat, ...leadParams, ...phoneClause.params, pat, pat, pat);
}

async function listOpportunities(db, url) {
  const s0006 = await inspectSchema0006(db);
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
  appendOpportunitySearchClause(q, s0006, where, params);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const nameSql = oppContactNameSql(s0006);
  const convJoin = oppConvJoinSql(s0006);
  const sql = `SELECT o.*, ${nameSql} AS contact_name,
    (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
    ${whereSql}
    ORDER BY CASE WHEN o.track='transient' THEN 1 ELSE 0 END, CASE WHEN o.next_followup_at IS NULL THEN 1 ELSE 0 END, o.next_followup_at DESC, o.updated_at DESC LIMIT 300`;
  const rows = await db.prepare(sql).bind(...params).all();
  const opportunities = (rows.results || []).map(row => ({
    ...row,
    contact_completeness: row.contact_id ? (row.phone_key ? 'complete' : 'incomplete') : 'unlinked_opportunity',
  }));
  return json({ opportunities });
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

async function loadOpportunityConversationsAndAlerts(db, opportunityId, contactId, directConvId) {
  if (!(await hasTable(db, 'crm_conversations'))) {
    return { conversations: [], smartAlerts: [] };
  }
  const convSql = directConvId
    ? `SELECT id, chat_title, match_status, source_type, source_ref, length(raw_text) AS char_length, message_count, first_message_at, last_message_at, analyzed_at, analyzed_rule_version AS rule_version
       FROM crm_conversations
       WHERE opportunity_id=? OR id=? OR (? IS NOT NULL AND contact_id=?)
       ORDER BY last_message_at DESC LIMIT 20`
    : `SELECT id, chat_title, match_status, source_type, source_ref, length(raw_text) AS char_length, message_count, first_message_at, last_message_at, analyzed_at, analyzed_rule_version AS rule_version
       FROM crm_conversations
       WHERE opportunity_id=? OR (? IS NOT NULL AND contact_id=?)
       ORDER BY last_message_at DESC LIMIT 20`;
  const convParams = directConvId
    ? [opportunityId, directConvId, contactId || null, contactId || null]
    : [opportunityId, contactId || null, contactId || null];
  const [convRes, alertRes] = await Promise.all([
    db.prepare(convSql).bind(...convParams).all(),
    db.prepare("SELECT * FROM crm_smart_alerts WHERE opportunity_id=? OR (? IS NOT NULL AND contact_id=?) ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, created_at DESC LIMIT 30")
      .bind(opportunityId, contactId || null, contactId || null).all(),
  ]);
  return {
    conversations: convRes?.results || [],
    smartAlerts: alertRes?.results || [],
  };
}

async function getOpportunity(db, opportunityId) {
  const s0006 = await inspectSchema0006(db);
  const nameSql = oppContactNameSql(s0006);
  const convJoin = oppConvJoinSql(s0006);
  const opportunity = await db.prepare(
    `SELECT o.*, ${nameSql} AS contact_name,
      (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key
     FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id ${convJoin}
     WHERE o.id=?`,
  ).bind(opportunityId).first();
  if (!opportunity) return json({ error: 'opportunity_not_found' }, 404);
  const contactId = opportunity.contact_id || null;
  const [activities, properties, phones, siblings, chatBundle] = await Promise.all([
    db.prepare('SELECT * FROM crm_activities WHERE opportunity_id=? ORDER BY created_at DESC LIMIT 100').bind(opportunityId).all(),
    db.prepare(`SELECT p.*,l.external_id,l.url,l.title,l.area_m2,l.price,l.area_id,a.name_ar AS area_name FROM crm_opportunity_properties p
      JOIN listings l ON l.id=p.listing_id JOIN areas a ON a.id=l.area_id WHERE p.opportunity_id=? ORDER BY p.created_at DESC`).bind(opportunityId).all(),
    contactId
      ? db.prepare('SELECT * FROM crm_contact_phones WHERE contact_id=? ORDER BY is_primary DESC,created_at').bind(contactId).all()
      : Promise.resolve({ results: [] }),
    contactId
      ? db.prepare('SELECT id,track,intent,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type FROM crm_opportunities WHERE contact_id=? ORDER BY updated_at DESC LIMIT 20').bind(contactId).all()
      : Promise.resolve({ results: [] }),
    loadOpportunityConversationsAndAlerts(db, opportunityId, contactId, opportunity.conversation_id || null),
  ]);
  if (!opportunity.conversation_id && chatBundle.conversations.length > 0) {
    opportunity.conversation_id = chatBundle.conversations[0].id;
  }
  opportunity.contact_completeness = contactId ? (phones.results.length > 0 ? 'complete' : 'incomplete') : 'unlinked_opportunity';
  return json({
    opportunity,
    activities: activities.results,
    properties: properties.results,
    phones: phones.results,
    sibling_opportunities: siblings.results,
    conversations: chatBundle.conversations,
    smart_alerts: chatBundle.smartAlerts,
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

function duplicatePhone(conflict = null) {
  const payload = { error: 'duplicate_phone_review', review_required: true };
  if (conflict?.contact_id) {
    payload.conflict_contact_id = conflict.contact_id;
    payload.conflict_contact_name = conflict.name || '';
    payload.phone_key = conflict.phone_key || '';
  }
  return json(payload, 409);
}

function appendContactCompletenessFilter(completeness, s0006, where) {
  if (completeness === 'archived') {
    where.push(s0006.hasArchivedAt ? 'c.archived_at IS NOT NULL' : '1=0');
    return;
  }
  if (completeness !== 'all' && s0006.hasArchivedAt) {
    where.push('c.archived_at IS NULL');
  }
  if (completeness === 'complete') {
    where.push('EXISTS (SELECT 1 FROM crm_contact_phones cp WHERE cp.contact_id=c.id)');
  } else if (completeness === 'incomplete') {
    where.push('NOT EXISTS (SELECT 1 FROM crm_contact_phones cp WHERE cp.contact_id=c.id)');
  }
}

async function listContacts(db, url) {
  const s0006 = await inspectSchema0006(db);
  const q = boundedText(url.searchParams.get('q'), 80);
  const track = url.searchParams.get('track') || '';
  const completeness = (url.searchParams.get('completeness') || '').trim();
  const hasTrack = ALLOWED_TRACKS.includes(track);
  const where = ['1=1'];
  const params = [];
  appendContactCompletenessFilter(completeness, s0006, where);
  if (q) {
    const pattern = `%${q}%`;
    const phoneClause = buildPhoneSearchClause(q, 'q', 'c.id');
    where.push(`(c.name LIKE ? OR ${phoneClause.sql})`);
    params.push(pattern, ...phoneClause.params);
  }
  if (hasTrack) {
    where.push('EXISTS (SELECT 1 FROM crm_opportunities ox WHERE ox.contact_id=c.id AND ox.track=?)');
    params.push(track);
  }
  const hasConv = await hasTable(db, 'crm_conversations');
  const convSelect = hasConv
    ? ', (SELECT COUNT(*) FROM crm_conversations cv WHERE cv.contact_id=c.id) AS conversation_count, (SELECT COUNT(*) FROM crm_smart_alerts sa WHERE sa.contact_id=c.id AND sa.status=\'open\') AS open_alerts_count'
    : '';
  const extra0006Select = [
    s0006.hasArchivedAt ? 'c.archived_at' : 'NULL AS archived_at',
    s0006.hasReviewNote ? 'c.review_note' : 'NULL AS review_note',
  ].join(',');
  const rows = await db.prepare(`SELECT c.id,c.name,c.communication_consent,c.consent_captured_at,c.created_at,c.updated_at,
      ${extra0006Select},
      GROUP_CONCAT(p.phone_key, ',') AS phone_numbers,
      MAX(CASE WHEN p.is_primary=1 THEN p.phone_key ELSE NULL END) AS primary_phone,
      COUNT(p.id) AS phone_count,
      (SELECT COUNT(*) FROM crm_opportunities o WHERE o.contact_id=c.id) AS opportunity_count,
      (SELECT GROUP_CONCAT(DISTINCT o.track) FROM crm_opportunities o WHERE o.contact_id=c.id) AS tracks${convSelect}
    FROM crm_contacts c LEFT JOIN crm_contact_phones p ON p.contact_id=c.id
    WHERE ${where.join(' AND ')}
    GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 250`).bind(...params).all();
  const contacts = (rows.results || []).map(row => {
    const status = computeContactCompletenessStatus(row);
    return {
      ...row,
      completeness_status: status,
      needs_review: status === 'incomplete',
    };
  });
  return json({ contacts });
}

async function getContact(db, contactId) {
  const contact = await db.prepare('SELECT * FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!contact) return json({ error: 'contact_not_found' }, 404);
  const [phones, opportunities] = await Promise.all([
    db.prepare('SELECT * FROM crm_contact_phones WHERE contact_id=? ORDER BY is_primary DESC,created_at').bind(contactId).all(),
    db.prepare('SELECT id,track,intent,source,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,created_at,updated_at FROM crm_opportunities WHERE contact_id=? ORDER BY updated_at DESC LIMIT 100').bind(contactId).all(),
  ]);
  let conversations = [];
  let smartAlerts = [];
  let auditLog = [];
  if (await hasTable(db, 'crm_conversations')) {
    const [convRes, alertRes, auditRes] = await Promise.all([
      db.prepare('SELECT id, chat_title, match_status, source_type, source_ref, length(raw_text) AS char_length, message_count, first_message_at, last_message_at, analyzed_at, analyzed_rule_version AS rule_version FROM crm_conversations WHERE contact_id=? ORDER BY last_message_at DESC LIMIT 30').bind(contactId).all(),
      db.prepare('SELECT * FROM crm_smart_alerts WHERE contact_id=? ORDER BY CASE WHEN status=\'open\' THEN 0 ELSE 1 END, created_at DESC LIMIT 40').bind(contactId).all(),
      db.prepare('SELECT * FROM crm_contact_audit_log WHERE contact_id=? ORDER BY created_at DESC LIMIT 40').bind(contactId).all(),
    ]);
    conversations = convRes?.results || [];
    smartAlerts = alertRes?.results || [];
    auditLog = auditRes?.results || [];
  }
  const completenessStatus = computeContactCompletenessStatus({
    archived_at: contact.archived_at,
    phone_count: phones.results.length,
  });
  return json({
    contact: {
      ...contact,
      completeness_status: completenessStatus,
      needs_review: completenessStatus === 'incomplete',
    },
    phones: phones.results,
    opportunities: opportunities.results,
    conversations,
    smart_alerts: smartAlerts,
    audit_log: auditLog,
  });
}

function parseSinglePhoneItem(item, seen) {
  if (!item || typeof item !== 'object' || typeof item.phone !== 'string') return null;
  if (item.is_primary !== undefined && typeof item.is_primary !== 'boolean') return null;
  const phone = normalizePhone(item.phone);
  if (!phone || seen.has(phone)) return null;
  seen.add(phone);
  return { phone, raw: boundedText(item.phone, 50), label: boundedText(item.label, 40), is_primary: item.is_primary === true };
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
  const name = boundedText(body.name || body.chat_handle, 100);
  const phones = contactPhones(body);
  const allowedConsent = ['request_only', 'marketing_yes', 'do_not_contact'];
  const consent = allowedConsent.includes(body.communication_consent) ? body.communication_consent : 'request_only';
  const consentAt = body.consent_captured_at ? isoDate(body.consent_captured_at) : null;
  if (!phones || (!name && !phones.length)) return null;
  if ((body.consent_captured_at && !consentAt) || (consent === 'marketing_yes' && !consentAt)) return null;
  const reviewNote = phones.length === 0
    ? (boundedText(body.review_note, 240) || 'جهة اتصال غير مكتملة بدون رقم هاتف موثق — تحتاج مراجعة')
    : (boundedText(body.review_note, 240) || '');
  return { name, phones, consent, consentAt, reviewNote };
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
  return duplicatePhone(matches[0]);
}

async function pushAuditStmtIfSupported(db, stmts, { contactId, actionType, fieldName, oldVal = null, newVal = null, sourceRef = 'crm_ui' }) {
  if (!(await hasTable(db, 'crm_contact_audit_log'))) return;
  stmts.push(
    db.prepare(
      'INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor) VALUES(?,?,?,?,?,?,?,?)',
    ).bind(id(), contactId, actionType, fieldName, oldVal, newVal, sourceRef, 'operator'),
  );
}

async function saveContact(db, key, contact) {
  const contactId = id();
  const s0006 = await inspectSchema0006(db);
  const hasProv = await hasTable(db, 'crm_contact_audit_log');
  const statements = [
    s0006.hasReviewNote
      ? db.prepare('INSERT INTO crm_contacts(id,name,communication_consent,consent_captured_at,review_note) VALUES(?,?,?,?,?)')
          .bind(contactId, contact.name, contact.consent, contact.consentAt, contact.reviewNote)
      : db.prepare('INSERT INTO crm_contacts(id,name,communication_consent,consent_captured_at) VALUES(?,?,?,?)')
          .bind(contactId, contact.name, contact.consent, contact.consentAt),
  ];
  for (const item of contact.phones) {
    if (hasProv) {
      statements.push(
        db.prepare("INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type) VALUES(?,?,?,?,?,?,'manual')")
          .bind(id(), contactId, item.phone, item.label, item.is_primary ? 1 : 0, item.raw || item.phone),
      );
    } else {
      statements.push(
        db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
          .bind(id(), contactId, item.phone, item.label, item.is_primary ? 1 : 0),
      );
    }
  }
  statements.push(
    db.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .bind(key, 'contact', contactId),
  );
  const completenessStatus = contact.phones.length > 0 ? 'complete' : 'incomplete';
  try {
    await db.batch(statements);
    return json({
      contact_id: contactId,
      phone_count: contact.phones.length,
      completeness_status: completenessStatus,
      needs_review: completenessStatus === 'incomplete',
      duplicate_contact: false,
    }, 201);
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

async function archiveContact(request, env, contactId) {
  const s0006 = await inspectSchema0006(env.DB);
  if (!s0006.hasArchivedAt) return json({ error: 'migration_0006_required' }, 409);
  const body = await readJson(request).catch(() => ({}));
  const existing = await env.DB.prepare('SELECT id, name, archived_at FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!existing) return json({ error: 'contact_not_found' }, 404);
  const restore = body?.restore === true || body?.archived === false;
  const nextArchivedAt = restore ? null : new Date().toISOString();
  const [oppCnt, convCnt] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM crm_opportunities WHERE contact_id=?').bind(contactId).first(),
    (await hasTable(env.DB, 'crm_conversations'))
      ? env.DB.prepare('SELECT COUNT(*) AS cnt FROM crm_conversations WHERE contact_id=?').bind(contactId).first()
      : Promise.resolve({ cnt: 0 }),
  ]);
  const stmts = [
    env.DB.prepare('UPDATE crm_contacts SET archived_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(nextArchivedAt, contactId),
  ];
  await pushAuditStmtIfSupported(env.DB, stmts, {
    contactId,
    actionType: restore ? 'contact_unarchived' : 'contact_archived',
    fieldName: 'archived_at',
    oldVal: existing.archived_at || null,
    newVal: nextArchivedAt,
  });
  await env.DB.batch(stmts);
  return json({
    ok: true,
    contact_id: contactId,
    archived: !restore,
    archived_at: nextArchivedAt,
    completeness_status: restore ? 'incomplete_or_complete' : 'archived',
    opportunities_preserved: Number(oppCnt?.cnt || 0),
    conversations_preserved: Number(convCnt?.cnt || 0),
  });
}

async function deleteContactDetached(env, contactId) {
  const s0006 = await inspectSchema0006(env.DB);
  if (!s0006.hasLeadLabel) return json({ error: 'migration_0006_required' }, 409);
  const existing = await env.DB.prepare('SELECT id, name FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!existing) return json({ error: 'contact_not_found' }, 404);
  const hasConv = await hasTable(env.DB, 'crm_conversations');
  const [oppCnt, convCnt] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS cnt FROM crm_opportunities WHERE contact_id=?').bind(contactId).first(),
    hasConv
      ? env.DB.prepare('SELECT COUNT(*) AS cnt FROM crm_conversations WHERE contact_id=?').bind(contactId).first()
      : Promise.resolve({ cnt: 0 }),
  ]);
  const stmts = [
    env.DB.prepare(
      `UPDATE crm_opportunities
       SET lead_label = COALESCE(NULLIF(lead_label, ''), ?),
           contact_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ?`,
    ).bind(existing.name || '', contactId),
  ];
  if (hasConv) {
    stmts.push(
      env.DB.prepare(
        `UPDATE crm_conversations
         SET contact_id = NULL,
             match_status = CASE WHEN match_status IN ('matched', 'resolved_manual') THEN 'unmatched_review' ELSE match_status END,
             review_reason = CASE WHEN COALESCE(review_reason, '') = '' THEN 'تم حذف سجل جهة الاتصال مع الاحتفاظ بالمحادثة كاملة دون مسح' ELSE review_reason END,
             updated_at = CURRENT_TIMESTAMP
         WHERE contact_id = ?`,
      ).bind(contactId),
      env.DB.prepare('UPDATE crm_conversation_insights SET contact_id = NULL WHERE contact_id = ?').bind(contactId),
      env.DB.prepare('UPDATE crm_smart_alerts SET contact_id = NULL WHERE contact_id = ?').bind(contactId),
      env.DB.prepare('UPDATE crm_contact_audit_log SET contact_id = NULL WHERE contact_id = ?').bind(contactId),
    );
  }
  await pushAuditStmtIfSupported(env.DB, stmts, {
    contactId: null,
    actionType: 'contact_deleted_detached',
    fieldName: 'contact_id',
    oldVal: `${contactId}:${existing.name || ''}`,
    newVal: null,
  });
  stmts.push(
    env.DB.prepare('DELETE FROM crm_contact_phones WHERE contact_id = ?').bind(contactId),
    env.DB.prepare("DELETE FROM crm_idempotency_receipts WHERE resource_type = 'contact' AND resource_id = ?").bind(contactId),
    env.DB.prepare('DELETE FROM crm_contacts WHERE id = ?').bind(contactId),
  );
  await env.DB.batch(stmts);
  return json({
    ok: true,
    deleted_contact_id: contactId,
    detached_opportunities: Number(oppCnt?.cnt || 0),
    detached_conversations: Number(convCnt?.cnt || 0),
  });
}

async function addContactPhone(request, env, contactId) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: 'invalid_phone' }, 400);
  const contact = await env.DB.prepare('SELECT id FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!contact) return json({ error: 'contact_not_found' }, 404);
  const found = await findPhone(env.DB, phone);
  if (found) {
    if (found.contact_id === contactId) return json({ ok: true, duplicate: true, phone_id: found.phone_id, phone_key: phone });
    return duplicatePhone(found);
  }
  const existingPrimary = await env.DB.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(contactId).first();
  const primary = body.is_primary === true || !existingPrimary;
  const newPhoneId = id();
  const hasProv = await hasTable(env.DB, 'crm_contact_audit_log');
  const statements = [];
  if (primary) statements.push(env.DB.prepare('UPDATE crm_contact_phones SET is_primary=0 WHERE contact_id=?').bind(contactId));
  if (hasProv) {
    statements.push(
      env.DB.prepare("INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type,source_ref) VALUES(?,?,?,?,?,?,'manual',?)")
        .bind(newPhoneId, contactId, phone, boundedText(body.label, 40), primary ? 1 : 0, boundedText(body.phone, 50), boundedText(body.source_ref, 120) || 'crm_ui'),
    );
  } else {
    statements.push(
      env.DB.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
        .bind(newPhoneId, contactId, phone, boundedText(body.label, 40), primary ? 1 : 0),
    );
  }
  await pushAuditStmtIfSupported(env.DB, statements, {
    contactId,
    actionType: 'phone_added',
    fieldName: primary ? 'primary_phone' : 'secondary_phone',
    newVal: phone,
  });
  try {
    await env.DB.batch(statements);
    await env.DB.prepare('UPDATE crm_contacts SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(contactId).run();
    return json({ ok: true, duplicate: false, phone_id: newPhoneId, phone_key: phone, is_primary: primary });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) {
      return duplicatePhone();
    }
    return sqlError(error);
  }
}

async function updateContactPhone(request, env, contactId, phoneId) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM crm_contact_phones WHERE id=? AND contact_id=?').bind(phoneId, contactId).first();
  if (!current) return json({ error: 'phone_not_found' }, 404);

  const nextPhone = body.phone !== undefined ? normalizePhone(body.phone) : current.phone_key;
  if (!nextPhone) return json({ error: 'invalid_phone' }, 400);
  if (nextPhone !== current.phone_key) {
    const owner = await findPhone(env.DB, nextPhone);
    if (owner && owner.contact_id !== contactId) return duplicatePhone(owner);
    if (owner && owner.phone_id !== phoneId) return json({ error: 'duplicate_phone_same_contact', phone_id: owner.phone_id }, 409);
  }

  const nextLabel = body.label !== undefined ? boundedText(body.label, 40) : current.label;
  if (body.is_primary === false && Number(current.is_primary) === 1) {
    return json({ error: 'cannot_demote_primary_without_replacement' }, 400);
  }
  const makePrimary = body.is_primary === true && Number(current.is_primary) !== 1;

  const statements = [];
  if (makePrimary) {
    statements.push(env.DB.prepare('UPDATE crm_contact_phones SET is_primary=0 WHERE contact_id=?').bind(contactId));
  }
  statements.push(
    env.DB.prepare('UPDATE crm_contact_phones SET phone_key=?, label=?, is_primary=? WHERE id=? AND contact_id=?')
      .bind(nextPhone, nextLabel, makePrimary ? 1 : current.is_primary, phoneId, contactId),
    env.DB.prepare('UPDATE crm_contacts SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(contactId),
  );
  await pushAuditStmtIfSupported(env.DB, statements, {
    contactId,
    actionType: 'phone_updated',
    fieldName: makePrimary ? 'primary_phone' : 'phone',
    oldVal: `${current.phone_key}:${current.label || ''}`,
    newVal: `${nextPhone}:${nextLabel || ''}`,
  });

  try {
    await env.DB.batch(statements);
    return json({ ok: true, phone_id: phoneId, phone_key: nextPhone, label: nextLabel, is_primary: Boolean(makePrimary || current.is_primary) });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) return duplicatePhone();
    return sqlError(error);
  }
}

async function deleteContactPhone(request, env, contactId, phoneId) {
  const current = await env.DB.prepare('SELECT * FROM crm_contact_phones WHERE id=? AND contact_id=?').bind(phoneId, contactId).first();
  if (!current) return json({ error: 'phone_not_found' }, 404);

  const url = new URL(request.url);
  const promoteId = boundedText(url.searchParams.get('promote_phone_id'), 80);
  const statements = [];

  if (Number(current.is_primary) === 1) {
    if (!promoteId) {
      return json({ error: 'cannot_delete_primary_phone' }, 400);
    }
    const replacement = await env.DB.prepare('SELECT id FROM crm_contact_phones WHERE id=? AND contact_id=? AND id != ?')
      .bind(promoteId, contactId, phoneId).first();
    if (!replacement) return json({ error: 'replacement_primary_not_found' }, 400);
    statements.push(env.DB.prepare('UPDATE crm_contact_phones SET is_primary=1 WHERE id=? AND contact_id=?').bind(promoteId, contactId));
  }

  statements.push(
    env.DB.prepare('DELETE FROM crm_contact_phones WHERE id=? AND contact_id=?').bind(phoneId, contactId),
    env.DB.prepare('UPDATE crm_contacts SET updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(contactId),
  );
  await pushAuditStmtIfSupported(env.DB, statements, {
    contactId,
    actionType: 'phone_deleted',
    fieldName: Number(current.is_primary) === 1 ? 'primary_phone_replaced' : 'secondary_phone',
    oldVal: current.phone_key,
  });

  await env.DB.batch(statements);
  return json({ ok: true, deleted_phone_id: phoneId });
}

async function resolveContactPhoneUpdate(db, contactId, body) {
  if (!body.phone) return { statements: [], duplicate: false };
  const phone = normalizePhone(body.phone);
  if (!phone) return { error: json({ error: 'invalid_phone' }, 400) };
  const found = await findPhone(db, phone);
  if (found && found.contact_id !== contactId) return { error: duplicatePhone(found) };
  if (found) return { statements: [], duplicate: true };
  const existingPrimary = await db.prepare('SELECT id FROM crm_contact_phones WHERE contact_id=? AND is_primary=1').bind(contactId).first();
  const primary = body.is_primary === true || !existingPrimary;
  const statements = [];
  if (primary) statements.push(db.prepare('UPDATE crm_contact_phones SET is_primary=0 WHERE contact_id=?').bind(contactId));
  statements.push(
    db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
      .bind(id(), contactId, phone, boundedText(body.label, 40), primary ? 1 : 0),
  );
  await pushAuditStmtIfSupported(db, statements, {
    contactId,
    actionType: 'phone_added',
    fieldName: primary ? 'primary_phone' : 'secondary_phone',
    newVal: phone,
  });
  return { statements, duplicate: false };
}

function parseConsentPatch(body, existing) {
  const allowed = ['request_only', 'marketing_yes', 'do_not_contact'];
  if (body.communication_consent === undefined) {
    return { ok: true, consent: existing.communication_consent, consentAt: existing.consent_captured_at, changed: false };
  }
  if (!allowed.includes(body.communication_consent)) return { ok: false };
  const nextConsent = body.communication_consent;
  let nextAt = existing.consent_captured_at;
  if (body.consent_captured_at !== undefined) {
    nextAt = body.consent_captured_at ? isoDate(body.consent_captured_at) : null;
    if (body.consent_captured_at && !nextAt) return { ok: false };
  } else if (nextConsent === 'marketing_yes' && !nextAt) {
    nextAt = new Date().toISOString();
  }
  return {
    ok: true,
    consent: nextConsent,
    consentAt: nextAt,
    changed: nextConsent !== existing.communication_consent,
  };
}

async function updateContact(request, env, contactId) {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT id,name,communication_consent,consent_captured_at FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!existing) return json({ error: 'contact_not_found' }, 404);

  const newName = body.name === undefined ? null : boundedText(body.name, 100);
  const hasConsentField = body.communication_consent !== undefined;
  if (newName === '' && !body.phone && !hasConsentField) return json({ error: 'invalid_contact' }, 400);
  if (newName === null && !body.phone && !hasConsentField) return json({ error: 'invalid_contact' }, 400);

  const consentPatch = parseConsentPatch(body, existing);
  if (!consentPatch.ok) return json({ error: 'invalid_consent' }, 400);

  const phoneUpdate = await resolveContactPhoneUpdate(env.DB, contactId, body);
  if (phoneUpdate.error) return phoneUpdate.error;
  const statements = [...phoneUpdate.statements];
  const targetName = newName !== null && newName !== '' ? newName : existing.name;

  statements.push(
    env.DB.prepare('UPDATE crm_contacts SET name=?,communication_consent=?,consent_captured_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(targetName, consentPatch.consent, consentPatch.consentAt, contactId),
  );
  if (targetName !== existing.name) {
    await pushAuditStmtIfSupported(env.DB, statements, {
      contactId,
      actionType: 'name_updated',
      fieldName: 'name',
      oldVal: existing.name,
      newVal: targetName,
    });
  }
  if (consentPatch.changed) {
    await pushAuditStmtIfSupported(env.DB, statements, {
      contactId,
      actionType: 'consent_changed',
      fieldName: 'communication_consent',
      oldVal: existing.communication_consent,
      newVal: consentPatch.consent,
    });
  }
  try {
    await env.DB.batch(statements);
    return json({
      ok: true,
      contact_id: contactId,
      communication_consent: consentPatch.consent,
      consent_captured_at: consentPatch.consentAt,
      duplicate_phone: phoneUpdate.duplicate,
    });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) {
      return duplicatePhone();
    }
    return sqlError(error);
  }
}

const SEALED_ENVELOPE_RE = /^enc_v1\.([A-Za-z0-9_-]{64,1200})\.([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{24,12000000})$/;

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
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.wipe_existing_customers === true) {
      return { wipeForbidden: true };
    }
    if (parsed.sync_bundle && typeof parsed.sync_bundle === 'object') {
      return {
        syncBundle: parsed.sync_bundle,
        dryRun: parsed.dry_run === true,
      };
    }
    if (!Array.isArray(parsed.entries)) return null;
    return {
      entries: parsed.entries,
    };
  } catch {
    return null;
  }
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
  const body = await readJson(request, 12_000_000);
  const envelope = typeof body.sealed_payload === 'string' ? body.sealed_payload.trim() : '';
  if (!SEALED_ENVELOPE_RE.test(envelope)) return json({ error: 'invalid_sealed_envelope' }, 400);

  const ticketKey = `sealed-ticket:${await sha256Hex(envelope)}`;
  const ticket = await env.DB.prepare('SELECT resource_id FROM crm_idempotency_receipts WHERE submission_key=?').bind(ticketKey).first();
  if (!ticket || ticket.resource_id !== 'authorized_pending') {
    return json({ error: 'unauthorized_sealed_ingest' }, 403);
  }

  const unsealed = await unsealIngestPayload(envelope, privKey);
  if (!unsealed) {
    return json({ error: 'invalid_sealed_payload' }, 400);
  }
  if (unsealed.wipeForbidden) {
    return json({ error: 'wipe_existing_customers_forbidden' }, 400);
  }
  if (unsealed.syncBundle) {
    const cleanPol = String(unsealed.syncBundle?.clean_foundation_policy || '').trim();
    if (cleanPol === 'strict_complete_contacts_only' && !unsealed.dryRun && !String(unsealed.syncBundle?.backup_verified_ref || '').trim()) {
      return json({ ok: false, error: 'backup_verified_ref_required_before_foundation_cleanup' }, 400);
    }
    await env.DB.prepare("UPDATE crm_idempotency_receipts SET resource_id='consumed' WHERE submission_key=? AND resource_id='authorized_pending'")
      .bind(ticketKey)
      .run();
    const syncResult = await runSourceSyncBundle(env.DB, unsealed.syncBundle, { dryRun: unsealed.dryRun });
    return json(syncResult, syncResult?.ok === false ? 400 : 200);
  }
  if (!Array.isArray(unsealed.entries) || unsealed.entries.length === 0 || unsealed.entries.length > 250) {
    return json({ error: 'invalid_sealed_payload' }, 400);
  }

  await env.DB.prepare("UPDATE crm_idempotency_receipts SET resource_id='consumed' WHERE submission_key=? AND resource_id='authorized_pending'")
    .bind(ticketKey)
    .run();

  const totals = {
    wiped_existing: false,
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

async function resolveOpportunityConversationRef(db, requestedConvId) {
  if (!requestedConvId) return { conv: null };
  if (!(await hasTable(db, 'crm_conversations'))) return { error: json({ error: 'conversation_not_found' }, 404) };
  const conv = await db.prepare('SELECT id, contact_id, chat_title FROM crm_conversations WHERE id=?').bind(requestedConvId).first();
  if (!conv) return { error: json({ error: 'conversation_not_found' }, 404) };
  return { conv };
}

function buildOpportunityInsertStmt(db, s0006, {
  opportunityId,
  contactId,
  conversationId,
  leadLabel,
  parsed,
  body,
  closedAt,
}) {
  if (s0006.hasLeadLabel && s0006.hasConversationId) {
    return db.prepare(
      `INSERT INTO crm_opportunities(id,contact_id,conversation_id,lead_label,track,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,closed_at,loss_reason,loss_notes)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      opportunityId,
      contactId,
      conversationId,
      leadLabel,
      parsed.track,
      parsed.intent,
      parsed.source,
      safeSitePath(body.source_url),
      parsed.status,
      boundedText(body.area_label, 100),
      parsed.budgetMin.value,
      parsed.budgetMax.value,
      parsed.sizeMin.value,
      parsed.sizeMax.value,
      boundedText(body.property_type, 80),
      boundedText(body.notes, 1200),
      parsed.nextAction,
      parsed.nextAt,
      parsed.reason,
      closedAt,
      body.loss_reason || null,
      boundedText(body.loss_notes, 500),
    );
  }
  return db.prepare(
    `INSERT INTO crm_opportunities(id,contact_id,track,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,closed_at,loss_reason,loss_notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    opportunityId,
    contactId,
    parsed.track,
    parsed.intent,
    parsed.source,
    safeSitePath(body.source_url),
    parsed.status,
    boundedText(body.area_label, 100),
    parsed.budgetMin.value,
    parsed.budgetMax.value,
    parsed.sizeMin.value,
    parsed.sizeMax.value,
    boundedText(body.property_type, 80),
    boundedText(body.notes, 1200),
    parsed.nextAction,
    parsed.nextAt,
    parsed.reason,
    closedAt,
    body.loss_reason || null,
    boundedText(body.loss_notes, 500),
  );
}

async function prepareOpportunityContactOrContactless(db, s0006, body, parsed, convRow) {
  const rawLabel = boundedText(body.lead_label || body.name, 120);
  const name = boundedText(body.name || rawLabel || convRow?.chat_title, 100);
  const requestedId = boundedText(body.contact_id, 80);
  const hasExplicitContactName = Boolean(boundedText(body.name, 100));
  const useIndependentContactless = s0006.hasLeadLabel
    && !requestedId
    && !parsed.phone
    && (body.contactless === true || (!hasExplicitContactName && Boolean(body.lead_label || convRow)));

  if (useIndependentContactless) {
    const effectiveLabel = rawLabel || boundedText(convRow?.chat_title, 120);
    if (!normalizeName(effectiveLabel) && !convRow) {
      return { error: json({ error: 'contact_or_phone_required' }, 400) };
    }
    return { contactId: convRow?.contact_id || null, statements: [], name, rawLabel };
  }

  const resolved = await resolveOpportunityContact(db, requestedId, parsed.phone, name);
  if (resolved.error) return { error: resolved.error };
  const contactId = resolved.contact?.id || id();
  const statements = await buildContactSetupStatements(db, resolved.contact, contactId, name, parsed.phone, resolved.phoneExists);
  return { contactId, statements, name, rawLabel };
}

async function createOpportunity(request, env) {
  const body = await readJson(request);
  const parsed = parseOpportunityInput(body);
  if (parsed.error) return parsed.error;
  const key = validIdempotency(request);
  if (!key) return json({ error: 'idempotency_key_required' }, 400);
  const prior = await receipt(env.DB, key);
  if (prior) {
    return prior.resource_type === 'opportunity'
      ? json({ contact_id: null, opportunity_id: prior.resource_id, duplicate_submission: true })
      : json({ error: 'idempotency_key_reused' }, 409);
  }

  const s0006 = await inspectSchema0006(env.DB);
  const convLookup = await resolveOpportunityConversationRef(env.DB, boundedText(body.conversation_id, 80));
  if (convLookup.error) return convLookup.error;
  const convRow = convLookup.conv;

  const prep = await prepareOpportunityContactOrContactless(env.DB, s0006, body, parsed, convRow);
  if (prep.error) return prep.error;

  const opportunityId = id();
  const closedAt = parsed.status === 'won' || parsed.status === 'lost' ? new Date().toISOString() : null;
  const leadLabel = prep.rawLabel || boundedText(convRow?.chat_title, 120) || '';
  const statements = [...prep.statements, buildOpportunityInsertStmt(env.DB, s0006, {
    opportunityId,
    contactId: prep.contactId,
    conversationId: convRow?.id || null,
    leadLabel,
    parsed,
    body,
    closedAt,
  })];
  if (convRow?.id) {
    statements.push(
      env.DB.prepare('UPDATE crm_conversations SET opportunity_id=COALESCE(opportunity_id, ?), updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(opportunityId, convRow.id),
    );
  }
  statements.push(
    env.DB.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)').bind(key, 'opportunity', opportunityId),
    env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id(), opportunityId, initialActivityType(parsed.source), boundedText(body.notes, 1200) || 'تسجيل فرصة جديدة', '', parsed.nextAction, parsed.nextAt),
  );

  try {
    await env.DB.batch(statements);
    return json({
      contact_id: prep.contactId,
      conversation_id: convRow?.id || null,
      opportunity_id: opportunityId,
      duplicate_submission: false,
    }, 201);
  } catch (error) {
    return handleOpportunityBatchError(env.DB, error, key, parsed.phone, prep.name);
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

async function attachVerifiedContactForOpportunityUpdate(db, current, body, nextLeadLabel) {
  if (current.contact_id || !body.phone) {
    return { contactId: current.contact_id || null, statements: [] };
  }
  const phone = normalizePhone(body.phone);
  if (!phone) return { error: json({ error: 'invalid_phone' }, 400) };
  const found = await findPhone(db, phone);
  if (found) {
    const stmts = [];
    if (current.conversation_id) {
      stmts.push(
        db.prepare("UPDATE crm_conversations SET contact_id=?, match_status='resolved_manual', review_reason='', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(found.contact_id, current.conversation_id),
      );
    }
    return { contactId: found.contact_id, statements: stmts };
  }
  const newContactId = id();
  const cName = boundedText(body.name || nextLeadLabel || 'عميل موثق', 100);
  const hasProv = await hasTable(db, 'crm_contact_audit_log');
  const stmts = [
    db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').bind(newContactId, cName),
    hasProv
      ? db.prepare("INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type,source_ref) VALUES(?,?,?,?,1,?,'manual','opportunity_phone_attach')")
          .bind(id(), newContactId, phone, boundedText(body.label, 40) || 'أساسي', boundedText(body.phone, 50))
      : db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,1)')
          .bind(id(), newContactId, phone, boundedText(body.label, 40) || 'أساسي'),
  ];
  await pushAuditStmtIfSupported(db, stmts, {
    contactId: newContactId,
    actionType: 'contact_created',
    fieldName: 'primary_phone',
    newVal: phone,
    sourceRef: 'opportunity_phone_attach',
  });
  if (current.conversation_id) {
    stmts.push(
      db.prepare("UPDATE crm_conversations SET contact_id=?, match_status='resolved_manual', review_reason='', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(newContactId, current.conversation_id),
    );
  }
  return { contactId: newContactId, statements: stmts };
}

async function updateOpportunity(request, env, opportunityId) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  const patch = parseOpportunityPatch(body, current);
  if (patch.error) return patch.error;
  const s0006 = await inspectSchema0006(env.DB);
  const nextLeadLabel = body.lead_label === undefined
    ? (current.lead_label || '')
    : boundedText(body.lead_label, 120);
  const attachRes = await attachVerifiedContactForOpportunityUpdate(env.DB, current, body, nextLeadLabel);
  if (attachRes.error) return attachRes.error;

  const updateStmt = s0006.hasLeadLabel
    ? env.DB.prepare('UPDATE crm_opportunities SET contact_id=?,lead_label=?,intent=?,area_label=?,property_type=?,budget_min=?,budget_max=?,size_min_m2=?,size_max_m2=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(attachRes.contactId, nextLeadLabel, patch.intent, patch.areaLabel, patch.propertyType, patch.budgetMin, patch.budgetMax, patch.sizeMin, patch.sizeMax, patch.notes, opportunityId)
    : env.DB.prepare('UPDATE crm_opportunities SET intent=?,area_label=?,property_type=?,budget_min=?,budget_max=?,size_min_m2=?,size_max_m2=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(patch.intent, patch.areaLabel, patch.propertyType, patch.budgetMin, patch.budgetMax, patch.sizeMin, patch.sizeMax, patch.notes, opportunityId);

  try {
    await env.DB.batch([
      ...attachRes.statements,
      updateStmt,
      env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id(), opportunityId, 'note', 'تحديث مواصفات أو ملاحظات الفرصة', '', current.next_action, current.next_followup_at),
    ]);
    return json({ ok: true, opportunity_id: opportunityId, contact_id: attachRes.contactId });
  } catch (error) {
    if (/UNIQUE constraint failed: crm_contact_phones\.phone_key/.test(String(error?.message))) return duplicatePhone();
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

async function getOpportunityMatches(db, opportunityId, scope, url) {
  const allowNearBounds = url?.searchParams?.get('include_near') === '1';
  const result = await computeOpportunityMatches(db, opportunityId, scope, { allowNearBounds });
  if (!result) return json({ error: 'opportunity_not_found' }, 404);
  return json(result);
}

async function hasActivityFullTextCol(db) {
  const info = await db.prepare('PRAGMA table_info(crm_activities)').all();
  return (info?.results || []).some(r => r.name === 'full_text');
}

async function addActivity(request, env, opportunityId) {
  const body = await readJson(request, 300_000);
  const rawFullText = typeof body.full_text === 'string' && body.full_text.trim()
    ? body.full_text.trim().slice(0, 250_000)
    : (typeof body.summary === 'string' ? body.summary.trim().slice(0, 250_000) : '');
  const summary = rawFullText.slice(0, 1200);
  const allowedTypes = ['call', 'missed_call', 'whatsapp_note', 'visit', 'offer', 'objection', 'note', 'status_change'];
  const activityType = allowedTypes.includes(body.activity_type) ? body.activity_type : null;
  const status = body.status;
  const requestedTrack = body.track;
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason, 240) || null;
  const current = await env.DB.prepare('SELECT id,contact_id,track,status,closed_at,loss_reason,loss_notes FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
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

  const actId = id();
  const linksInfo = extractSafeLinks(rawFullText);
  const hasFullCol = await hasActivityFullTextCol(env.DB);
  const actInsertStmt = hasFullCol
    ? env.DB.prepare(
      'INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,full_text,source_ref,original_sent_at,external_links_json,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      actId,
      opportunityId,
      activityType,
      summary,
      rawFullText,
      boundedText(body.source_ref, 160) || 'crm_ui',
      body.original_sent_at ? isoDate(body.original_sent_at) : null,
      JSON.stringify(linksInfo.safe),
      boundedText(body.outcome, 200),
      nextAction,
      nextAt,
    )
    : env.DB.prepare('INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)')
      .bind(actId, opportunityId, activityType, summary, boundedText(body.outcome, 200), nextAction, nextAt);

  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE crm_opportunities SET track=?,status=?,next_action=?,next_followup_at=?,no_followup_reason=?,closed_at=?,loss_reason=?,loss_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(nextTrack, nextStatus, nextAction, nextAt, reason, closed, lossReason, lossNotes, opportunityId),
      actInsertStmt,
    ]);
    return json({
      ok: true,
      opportunity_id: opportunityId,
      activity_id: actId,
      stored_length: rawFullText.length,
      safe_links: linksInfo.safe,
      blocked_links: linksInfo.blocked,
    });
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

async function handleFollowupsGet(db, url) {
  const nowParam = url.searchParams.get('now');
  const now = nowParam && isoDate(nowParam) ? new Date(isoDate(nowParam)) : new Date();
  if (await hasTable(db, 'crm_smart_alerts')) {
    await refreshTimeBasedSmartAlerts(db, now);
    return json(await buildFollowupWorkspaceData(db, { now }));
  }
  return json({
    timezone: 'Africa/Cairo',
    cairo_day: getCairoClock(now).dayKey,
    generated_at: now.toISOString(),
    counts: { today: 0, overdue: 0, upcoming: 0, waiting_reply: 0, stalled_intervention: 0, new_chat_alerts: 0, unmatched_review_chats: 0 },
    today: [],
    overdue: [],
    upcoming: [],
    waiting_reply: [],
    stalled_intervention: [],
    new_chat_alerts: [],
  });
}

async function handleConversationImportPost(request, env) {
  const body = await readJson(request, 600_000);
  const res = await importConversationPayload(env.DB, body);
  if (res.error) return json({ error: res.error }, res.status || 400);
  return json(res, res.status || 201);
}

async function handleConversationLinkPost(request, env, conversationId) {
  const body = await readJson(request, 10_000);
  const res = await linkConversationToContactPayload(env.DB, conversationId, body);
  if (res.error) return json({ error: res.error }, res.status || 400);
  return json(res, 200);
}

async function handleResolveAlertPost(request, env, alertId) {
  const body = await readJson(request, 50_000);
  const res = await resolveSmartAlertPayload(env.DB, alertId, body);
  if (res.error) return json({ error: res.error }, res.status || 400);
  return json(res, 200);
}

const EXACT_GET_ROUTES = {
  '/api/contacts': (db, url) => listContacts(db, url),
  '/api/dashboard': (db, url) => dashboard(db, url),
  '/api/followups': (db, url) => handleFollowupsGet(db, url),
  '/api/conversations': async (db, url) => json(await listConversationsData(db, url)),
  '/api/opportunities': (db, url) => listOpportunities(db, url),
  '/api/listings': (db, url, config) => listListings(db, url, config.scope),
  '/api/push/config': (_db, _url, _config, env) => getPushStatusResponse(env, json),
};

const EXACT_POST_ROUTES = {
  '/api/contacts': (request, env) => createContact(request, env),
  '/api/opportunities': (request, env) => createOpportunity(request, env),
  '/api/conversations/import': (request, env) => handleConversationImportPost(request, env),
  '/api/push/subscribe': (request, env) => subscribePushDevice(request, env, { readJson, boundedText, jsonHelper: json }),
  '/api/push/unsubscribe': (request, env) => unsubscribePushDevice(request, env, { readJson, jsonHelper: json }),
  '/api/push/test': (request, env) => sendTestPushAlert(request, env, { readJson, jsonHelper: json }),
  '/api/push/check-now': async (_request, env) => json(await runScheduledCrmNotifications(env, { forceCheck: true })),
};

const PARAM_ROUTES = [
  { method: 'POST', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/archive$/, run: (req, env, m) => archiveContact(req, env, m[1]) },
  { method: 'POST', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/phones$/, run: (req, env, m) => addContactPhone(req, env, m[1]) },
  { method: 'PATCH', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/phones\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, m) => updateContactPhone(req, env, m[1], m[2]) },
  { method: 'DELETE', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/phones\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, m) => deleteContactPhone(req, env, m[1], m[2]) },
  { method: 'GET', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/, run: (_req, env, m) => getContact(env.DB, m[1]) },
  { method: 'POST', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, m) => updateContact(req, env, m[1]) },
  { method: 'DELETE', re: /^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/, run: (_req, env, m) => deleteContactDetached(env, m[1]) },
  { method: 'GET', re: /^\/api\/conversations\/([a-zA-Z0-9_-]{8,80})$/, run: async (_req, env, m) => {
    const data = await getConversationDetailData(env.DB, m[1]);
    return data ? json(data) : json({ error: 'conversation_not_found' }, 404);
  } },
  { method: 'POST', re: /^\/api\/conversations\/([a-zA-Z0-9_-]{8,80})\/link-contact$/, run: (req, env, m) => handleConversationLinkPost(req, env, m[1]) },
  { method: 'POST', re: /^\/api\/alerts\/([a-zA-Z0-9_-]{8,80})\/resolve$/, run: (req, env, m) => handleResolveAlertPost(req, env, m[1]) },
  { method: 'GET', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/, run: (_req, env, m) => getOpportunity(env.DB, m[1]) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/, run: (req, env, m) => updateOpportunity(req, env, m[1]) },
  { method: 'GET', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/matches$/, run: (req, env, m, cfg) => getOpportunityMatches(env.DB, m[1], cfg.scope, new URL(req.url)) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/track$/, run: (req, env, m) => switchOpportunityTrack(req, env, m[1]) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/activities$/, run: (req, env, m) => addActivity(req, env, m[1]) },
  { method: 'POST', re: /^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/properties$/, run: (req, env, m, cfg) => linkProperty(req, env, m[1], cfg.scope) },
];

async function dispatchParameterizedApi(request, pathname, env, config) {
  for (const route of PARAM_ROUTES) {
    if (request.method !== route.method) continue;
    const match = route.re.exec(pathname);
    if (match) return route.run(request, env, match, config);
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
  if (pathname === '/api/auth/ci-ticket' && request.method === 'POST') return handleCiTicketLogin(request, env, config);
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
