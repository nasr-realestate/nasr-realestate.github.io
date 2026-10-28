// Private CRM API & UI Worker. Uses self-contained Worker authentication
// (salted PBKDF2-SHA256 secret verification, D1-backed hashed sessions,
// __Host- HttpOnly/Secure/SameSite=Strict cookies, strict Origin + CSRF checks,
// and D1 brute-force rate limiting) with zero dependency on Cloudflare Zero Trust.

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
const UI_ASSET_PATHS = new Set(['/', '/crm.html', '/crm-client.js', '/crm-assets/app.css', '/crm-assets/app.js']);
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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

async function dashboard(db, url) {
  const now = new Date();
  const day = url.searchParams.get('day') || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'invalid_day' }, 400);
  const start = `${day}T00:00:00.000Z`;
  const end = `${day}T23:59:59.999Z`;
  const current = now.toISOString();
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM crm_opportunities WHERE status IN (${ACTIVE})`).first();
  const today = await db.prepare(`SELECT o.id,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at BETWEEN ? AND ? ORDER BY o.next_followup_at`).bind(start, end).all();
  const overdue = await db.prepare(`SELECT o.id,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at < ? ORDER BY o.next_followup_at LIMIT 200`).bind(start).all();
  const noAction = await db.prepare(`SELECT o.id,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.no_followup_reason,o.updated_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at IS NULL AND COALESCE(o.no_followup_reason,'')='' ORDER BY o.updated_at LIMIT 200`).all();
  const stale = await db.prepare(`SELECT o.id,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,o.intent,o.status,o.updated_at,
    (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id) AS last_activity
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND COALESCE((SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id),o.updated_at) < ?
    ORDER BY COALESCE(last_activity,o.updated_at) LIMIT 200`).bind(new Date(Date.now() - 7 * 86400000).toISOString()).all();
  const visits = await db.prepare(`SELECT p.id,p.viewing_at,p.viewing_result,o.id AS opportunity_id,c.name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,l.title,l.url
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
    due_today: today.results,
    overdue: overdue.results,
    missing_next_step: noAction.results,
    stale_7_days: stale.results,
    scheduled_visits: visits.results,
    outcomes: outcomes.results,
  });
}

async function listOpportunities(db, url) {
  const status = url.searchParams.get('status') || '';
  const q = boundedText(url.searchParams.get('q'), 80);
  const params = [];
  const where = [];
  if (status) {
    where.push('o.status=?');
    params.push(status);
  }
  if (q) {
    where.push('(c.name LIKE ? OR EXISTS (SELECT 1 FROM crm_contact_phones p WHERE p.contact_id=c.id AND p.phone_key LIKE ?) OR o.notes LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT o.*,c.name AS contact_name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id ${whereSql} ORDER BY CASE WHEN o.next_followup_at IS NULL THEN 1 ELSE 0 END,o.next_followup_at DESC,o.updated_at DESC LIMIT 300`;
  const rows = await db.prepare(sql).bind(...params).all();
  return json({ opportunities: rows.results });
}

async function listListings(db, url, scope) {
  const q = boundedText(url.searchParams.get('q'), 80);
  const pattern = q ? `%${q}%` : '';
  const rows = await db.prepare(`SELECT l.id,l.external_id,l.url,l.title,l.property_type,l.transaction_type,l.area_id,a.name_ar AS area_name,l.area_m2,l.price,l.bedrooms,l.bathrooms,l.finishing
    FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.source_id=? AND l.area_id IN (${scope.areaSql}) AND (?='' OR l.title LIKE ? OR l.external_id LIKE ? OR a.name_ar LIKE ?)
    ORDER BY l.observed_at DESC LIMIT 100`).bind(scope.sourceId, q, pattern, pattern, pattern).all();
  return json({ listings: rows.results });
}

async function getOpportunity(db, opportunityId) {
  const opportunity = await db.prepare(`SELECT o.*,c.name AS contact_name,(SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id WHERE o.id=?`).bind(opportunityId).first();
  if (!opportunity) return json({ error: 'opportunity_not_found' }, 404);
  const [activities, properties] = await Promise.all([
    db.prepare('SELECT * FROM crm_activities WHERE opportunity_id=? ORDER BY created_at DESC LIMIT 100').bind(opportunityId).all(),
    db.prepare(`SELECT p.*,l.external_id,l.url,l.title,l.area_m2,l.price,l.area_id,a.name_ar AS area_name FROM crm_opportunity_properties p
      JOIN listings l ON l.id=p.listing_id JOIN areas a ON a.id=l.area_id WHERE p.opportunity_id=? ORDER BY p.created_at DESC`).bind(opportunityId).all(),
  ]);
  return json({ opportunity, activities: activities.results, properties: properties.results });
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
  const pattern = `%${q}%`;
  const rows = await db.prepare(`SELECT c.id,c.name,c.communication_consent,c.created_at,c.updated_at,
      GROUP_CONCAT(p.phone_key, ',') AS phone_numbers,
      MAX(CASE WHEN p.is_primary=1 THEN p.phone_key ELSE NULL END) AS primary_phone,
      (SELECT COUNT(*) FROM crm_opportunities o WHERE o.contact_id=c.id) AS opportunity_count
    FROM crm_contacts c LEFT JOIN crm_contact_phones p ON p.contact_id=c.id
    WHERE ?='' OR c.name LIKE ? OR EXISTS (SELECT 1 FROM crm_contact_phones q WHERE q.contact_id=c.id AND q.phone_key LIKE ?)
    GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 200`).bind(q, pattern, pattern).all();
  return json({ contacts: rows.results });
}

async function getContact(db, contactId) {
  const contact = await db.prepare('SELECT * FROM crm_contacts WHERE id=?').bind(contactId).first();
  if (!contact) return json({ error: 'contact_not_found' }, 404);
  const [phones, opportunities] = await Promise.all([
    db.prepare('SELECT id,phone_key,label,is_primary,created_at FROM crm_contact_phones WHERE contact_id=? ORDER BY is_primary DESC,created_at').bind(contactId).all(),
    db.prepare('SELECT id,intent,source,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,next_action,next_followup_at,no_followup_reason,created_at,updated_at FROM crm_opportunities WHERE contact_id=? ORDER BY updated_at DESC LIMIT 100').bind(contactId).all(),
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

function parseOpportunityInput(body) {
  const phone = body.phone ? normalizePhone(body.phone) : null;
  const intent = ['buy', 'rent', 'sell', 'lease', 'other'].includes(body.intent) ? body.intent : null;
  const source = ['call', 'missed_call', 'referral', 'website', 'whatsapp', 'other'].includes(body.source) ? body.source : null;
  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'active';
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason, 240) || null;
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
  return { phone, intent, source, status, nextAction, nextAt, reason, budgetMin, budgetMax, sizeMin, sizeMax };
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
  if (!requestedId && !phone) return { error: json({ error: 'contact_or_phone_required' }, 400) };
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
    env.DB.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,closed_at,loss_reason,loss_notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(opportunityId, contactId, parsed.intent, parsed.source, safeSitePath(body.source_url), parsed.status, boundedText(body.area_label, 100), parsed.budgetMin.value, parsed.budgetMax.value, parsed.sizeMin.value, parsed.sizeMax.value, boundedText(body.property_type, 80), boundedText(body.notes, 1200), parsed.nextAction, parsed.nextAt, parsed.reason, closedAt, body.loss_reason || null, boundedText(body.loss_notes, 500)),
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

async function addActivity(request, env, opportunityId) {
  const body = await readJson(request);
  const summary = boundedText(body.summary, 1200);
  const allowedTypes = ['call', 'missed_call', 'whatsapp_note', 'visit', 'offer', 'objection', 'note', 'status_change'];
  const activityType = allowedTypes.includes(body.activity_type) ? body.activity_type : null;
  const status = body.status;
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason, 240) || null;
  const current = await env.DB.prepare('SELECT id,status,closed_at,loss_reason,loss_notes FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  if (!summary || !activityType || (status && !ALLOWED_STATUSES.includes(status)) || (body.next_followup_at && !nextAt)) {
    return json({ error: 'invalid_activity' }, 400);
  }
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
      env.DB.prepare('UPDATE crm_opportunities SET status=?,next_action=?,next_followup_at=?,no_followup_reason=?,closed_at=?,loss_reason=?,loss_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(nextStatus, nextAction, nextAt, reason, closed, lossReason, lossNotes, opportunityId),
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

async function serveUiAsset(request, url, env) {
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !env.ASSETS) return null;
  if (!UI_ASSET_PATHS.has(url.pathname)) return null;
  const assetUrl = new URL(url.toString());
  if (assetUrl.pathname === '/') assetUrl.pathname = '/crm.html';
  const assetRequest = new Request(assetUrl.toString(), { method: request.method, headers: request.headers });
  const asset = await env.ASSETS.fetch(assetRequest);
  const assetHeaders = new Headers(asset.headers);
  assetHeaders.set('cache-control', 'private, no-store');
  assetHeaders.set('pragma', 'no-cache');
  assetHeaders.set('x-content-type-options', 'nosniff');
  assetHeaders.set('x-frame-options', 'DENY');
  assetHeaders.set('referrer-policy', 'same-origin');
  assetHeaders.set('content-security-policy', UI_CSP);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: assetHeaders });
}

const EXACT_GET_ROUTES = {
  '/api/contacts': (db, url) => listContacts(db, url),
  '/api/dashboard': (db, url) => dashboard(db, url),
  '/api/opportunities': (db, url) => listOpportunities(db, url),
  '/api/listings': (db, url, config) => listListings(db, url, config.scope),
};

const EXACT_POST_ROUTES = {
  '/api/contacts': (request, env) => createContact(request, env),
  '/api/opportunities': (request, env) => createOpportunity(request, env),
};

async function dispatchParameterizedApi(request, pathname, env, config) {
  const { method } = request;
  const phoneRoute = pathname.match(/^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})\/phones$/);
  if (method === 'POST' && phoneRoute) return addContactPhone(request, env, phoneRoute[1]);
  const contactDetail = pathname.match(/^\/api\/contacts\/([a-zA-Z0-9_-]{8,80})$/);
  if (method === 'GET' && contactDetail) return getContact(env.DB, contactDetail[1]);
  const detail = pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/);
  if (method === 'GET' && detail) return getOpportunity(env.DB, detail[1]);
  const activity = pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/activities$/);
  if (method === 'POST' && activity) return addActivity(request, env, activity[1]);
  const property = pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/properties$/);
  if (method === 'POST' && property) return linkProperty(request, env, property[1], config.scope);
  return json({ error: 'not_found' }, 404);
}

async function dispatchProtectedApi(request, url, env, config) {
  if (request.method === 'GET' && EXACT_GET_ROUTES[url.pathname]) {
    return EXACT_GET_ROUTES[url.pathname](env.DB, url, config);
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
};
