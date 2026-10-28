// Private CRM Web Push & Scheduled Alert Engine (RFC 8291 aes128gcm + RFC 8292 VAPID ES256)
// Zero third-party services, zero PII in push payloads, backed by nasr-crm-test-db.

const ACTIVE_OPP_SQL = "'active','visit_scheduled','viewing_done','offer','negotiating','near_close'";
const VAPID_MAX_AGE_SECONDS = 12 * 3600;
const PUSH_TTL_SECONDS = 43_200; // 12 hours
const DEFAULT_VAPID_SUBJECT = 'mailto:samsar.talabak@mailo.com';
const ALLOWED_ENDPOINT_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const PHONE_DIGIT_RUN_RE = /(?:\+|00)\d{7,15}|\b01[0125]\d{8}\b|[0-9٠-٩]{7,}/g;
const INTENT_AR = { buy: 'طلب شراء', rent: 'طلب إيجار', sell: 'عرض بيع', lease: 'عرض تأجير', other: 'فرصة عقارية' };

const encoder = new TextEncoder();

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
    return null;
  }
}

function utf8ToB64u(text) {
  return toBase64Url(encoder.encode(String(text)));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function sanitizePushText(value, maxLen = 140) {
  const cleaned = String(value || '')
    .replaceAll(PHONE_DIGIT_RUN_RE, '[رقم محفوظ]')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
}

export async function generateVapidKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKeyB64u: toBase64Url(pubRaw),
    privateKeyB64u: privJwk.d,
  };
}

export async function importVapidConfig(env) {
  const pubB64u = String(env?.CRM_VAPID_PUBLIC_KEY || '').trim();
  const privB64u = String(env?.CRM_VAPID_PRIVATE_KEY || '').trim();
  if (!pubB64u || !privB64u) return null;
  const pub = fromBase64Url(pubB64u);
  const priv = fromBase64Url(privB64u);
  if (!pub || pub.byteLength !== 65 || pub[0] !== 4 || !priv || priv.byteLength !== 32) return null;
  try {
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(pub.slice(1, 33)),
      y: toBase64Url(pub.slice(33, 65)),
      d: toBase64Url(priv),
      alg: 'ES256',
      ext: true,
    };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const subject = String(env?.CRM_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT).trim();
    return { key, publicKeyB64u: pubB64u, subject };
  } catch {
    return null;
  }
}

function isAllowedPushHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || !ALLOWED_ENDPOINT_HOST_RE.test(host)) return false;
  return !/\.(local|internal|home|lan|corp)$/.test(host);
}

export function validatePushSubscription(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_subscription' };
  const endpoint = String(raw.endpoint || '').trim();
  if (endpoint.length < 20 || endpoint.length > 2048) return { ok: false, error: 'invalid_endpoint' };
  let parsedUrl;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    return { ok: false, error: 'invalid_endpoint' };
  }
  if (parsedUrl.protocol !== 'https:' || !isAllowedPushHost(parsedUrl.hostname)) {
    return { ok: false, error: 'invalid_endpoint' };
  }
  const p256dh = String(raw.keys?.p256dh || '').trim();
  const auth = String(raw.keys?.auth || '').trim();
  const pubBytes = fromBase64Url(p256dh);
  const authBytes = fromBase64Url(auth);
  if (!pubBytes || pubBytes.byteLength !== 65 || pubBytes[0] !== 4) return { ok: false, error: 'invalid_keys' };
  if (!authBytes || authBytes.byteLength < 16 || authBytes.byteLength > 64) return { ok: false, error: 'invalid_keys' };
  return { ok: true, endpoint, p256dh, auth };
}

async function hkdfSha256(ikmBytes, saltBytes, infoBytes, byteLength) {
  const key = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: infoBytes },
    key,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

export async function encryptWebPushPayload(payloadText, uaPublicB64u, uaAuthB64u) {
  const uaPublic = fromBase64Url(uaPublicB64u);
  const uaAuth = fromBase64Url(uaAuthB64u);
  if (!uaPublic || uaPublic.byteLength !== 65 || uaPublic[0] !== 4 || !uaAuth || uaAuth.byteLength < 16) {
    throw new Error('invalid_push_keys');
  }
  const uaPubKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, ephemeral.privateKey, 256),
  );

  const infoPrefix = encoder.encode('WebPush: info\u0000');
  const keyInfo = new Uint8Array(infoPrefix.byteLength + uaPublic.byteLength + asPublic.byteLength);
  keyInfo.set(infoPrefix, 0);
  keyInfo.set(uaPublic, infoPrefix.byteLength);
  keyInfo.set(asPublic, infoPrefix.byteLength + uaPublic.byteLength);

  const ikm = await hkdfSha256(shared, uaAuth, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfSha256(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdfSha256(ikm, salt, encoder.encode('Content-Encoding: nonce\u0000'), 12);

  const plain = encoder.encode(String(payloadText));
  const record = new Uint8Array(plain.byteLength + 1);
  record.set(plain, 0);
  record[plain.byteLength] = 0x02;

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, record));

  const header = new Uint8Array(86);
  header.set(salt, 0);
  header.set([0x00, 0x00, 0x10, 0x00], 16);
  header[20] = 0x41;
  header.set(asPublic, 21);

  const body = new Uint8Array(header.byteLength + cipher.byteLength);
  body.set(header, 0);
  body.set(cipher, header.byteLength);
  return { body, saltB64u: toBase64Url(salt), asPublicB64u: toBase64Url(asPublic) };
}

async function buildVapidHeaders(vapid, endpointUrl) {
  const aud = new URL(endpointUrl).origin;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = utf8ToB64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = utf8ToB64u(JSON.stringify({ aud, exp: nowSec + VAPID_MAX_AGE_SECONDS, sub: vapid.subject }));
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, encoder.encode(signingInput)),
  );
  const jwt = `${signingInput}.${toBase64Url(sig)}`;
  return {
    Authorization: `vapid t=${jwt}, k=${vapid.publicKeyB64u}`,
    'Crypto-Key': `p256ecdsa=${vapid.publicKeyB64u}`,
  };
}

async function deliverSinglePush(subRow, payloadObj, vapid, fetchImpl) {
  const encrypted = await encryptWebPushPayload(JSON.stringify(payloadObj), subRow.p256dh, subRow.auth);
  const vapidHdr = await buildVapidHeaders(vapid, subRow.endpoint);
  const headers = {
    TTL: String(PUSH_TTL_SECONDS),
    Urgency: 'high',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Encryption: `salt=${encrypted.saltB64u}`,
    Authorization: vapidHdr.Authorization,
    'Crypto-Key': `dh=${encrypted.asPublicB64u}; ${vapidHdr['Crypto-Key']}`,
  };
  try {
    const res = await fetchImpl(subRow.endpoint, { method: 'POST', headers, body: encrypted.body });
    const status = res?.status || 0;
    if (status === 200 || status === 201) return { ok: true, gone: false };
    if (status === 404 || status === 410) return { ok: false, gone: true };
    return { ok: false, gone: false };
  } catch {
    return { ok: false, gone: false };
  }
}

async function broadcastToSubscriptions(db, subscriptions, payloadObj, vapid, fetchImpl) {
  let delivered = 0;
  let removed = 0;
  for (const sub of subscriptions) {
    const res = await deliverSinglePush(sub, payloadObj, vapid, fetchImpl);
    if (res.ok) {
      delivered += 1;
    } else if (res.gone) {
      await db.prepare('DELETE FROM crm_push_subscriptions WHERE id=?').bind(sub.id).run();
      removed += 1;
    }
  }
  return { delivered, removed, total: subscriptions.length };
}

export async function getPushStatusResponse(env, jsonHelper) {
  const vapid = await importVapidConfig(env);
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM crm_push_subscriptions').first();
  return jsonHelper({
    enabled: Boolean(vapid),
    public_key: vapid ? vapid.publicKeyB64u : null,
    subscriptions_count: Number(row?.count || 0),
  });
}

export async function subscribePushDevice(request, env, { readJson, boundedText, jsonHelper }) {
  const vapid = await importVapidConfig(env);
  if (!vapid) return jsonHelper({ error: 'push_not_configured' }, 503);
  const body = await readJson(request);
  const parsed = validatePushSubscription(body.subscription);
  if (!parsed.ok) return jsonHelper({ error: parsed.error }, 400);

  const endpointHash = await sha256Hex(parsed.endpoint);
  const subId = endpointHash.slice(0, 16);
  const label = boundedText(body.device_label || 'جهاز المالك', 80);
  const morningDigest = body.morning_digest === false ? 0 : 1;

  await env.DB.prepare(
    `INSERT INTO crm_push_subscriptions(id,endpoint_hash,endpoint,p256dh,auth,device_label,morning_digest)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(endpoint_hash) DO UPDATE SET
       endpoint=excluded.endpoint,
       p256dh=excluded.p256dh,
       auth=excluded.auth,
       device_label=excluded.device_label,
       morning_digest=excluded.morning_digest,
       updated_at=CURRENT_TIMESTAMP`,
  ).bind(subId, endpointHash, parsed.endpoint, parsed.p256dh, parsed.auth, label, morningDigest).run();

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM crm_push_subscriptions').first();
  return jsonHelper({
    ok: true,
    subscription_id: subId,
    morning_digest: Boolean(morningDigest),
    subscriptions_count: Number(countRow?.count || 0),
  });
}

export async function unsubscribePushDevice(request, env, { readJson, jsonHelper }) {
  const body = await readJson(request);
  const endpoint = String(body.endpoint || '').trim();
  if (!endpoint || endpoint.length > 2048) return jsonHelper({ error: 'invalid_endpoint' }, 400);
  const endpointHash = await sha256Hex(endpoint);
  const res = await env.DB.prepare('DELETE FROM crm_push_subscriptions WHERE endpoint_hash=?').bind(endpointHash).run();
  return jsonHelper({ ok: true, removed: Number(res?.meta?.changes ?? res?.changes ?? 0) });
}

export async function sendTestPushAlert(request, env, { readJson, jsonHelper, fetchImpl = fetch }) {
  const vapid = await importVapidConfig(env);
  if (!vapid) return jsonHelper({ error: 'push_not_configured' }, 503);
  const body = await readJson(request);
  const endpoint = String(body.endpoint || '').trim();

  let subsResult;
  if (endpoint) {
    const endpointHash = await sha256Hex(endpoint);
    subsResult = await env.DB.prepare('SELECT id,endpoint,p256dh,auth FROM crm_push_subscriptions WHERE endpoint_hash=?')
      .bind(endpointHash).all();
  } else {
    subsResult = await env.DB.prepare('SELECT id,endpoint,p256dh,auth FROM crm_push_subscriptions LIMIT 20').all();
  }
  const subscriptions = subsResult?.results || [];
  if (subscriptions.length === 0) return jsonHelper({ error: 'no_active_subscription' }, 404);

  const payload = {
    title: '🔔 إشعارات CRM سمسار طلبك مفعّلة',
    body: 'وصلك هذا الإشعار التجريبي بنجاح — ستصلك تنبيهات المتابعات والمعاينات تلقائيًا.',
    tag: 'crm-test-alert',
    url: '/',
  };
  const stats = await broadcastToSubscriptions(env.DB, subscriptions, payload, vapid, fetchImpl);
  if (stats.delivered === 0) return jsonHelper({ error: 'push_delivery_failed', ...stats }, 502);
  return jsonHelper({ ok: true, ...stats });
}

function getCairoClock(nowDate) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(nowDate);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const hour = Number(map.hour === '24' ? 0 : map.hour);
  const minute = Number(map.minute);
  return {
    dayKey: `${map.year}-${map.month}-${map.day}`,
    minutesOfDay: hour * 60 + minute,
  };
}

function buildDueFollowupPayload(opp) {
  const intent = INTENT_AR[opp.intent] || 'فرصة عقارية';
  const prop = sanitizePushText(opp.property_type || 'وحدة', 36);
  const area = sanitizePushText(opp.area_label || 'مدينة نصر', 48);
  const action = sanitizePushText(opp.next_action || 'متابعة مجدولة', 70);
  return {
    title: '⏰ موعد متابعة مستحق — مدينة نصر',
    body: `${intent} · ${prop} (${area}) — الإجراء: ${action}`,
    tag: `crm-due-${opp.id.slice(0, 20)}`,
    url: '/',
  };
}

async function dispatchDueFollowupAlerts(db, subscriptions, vapid, nowIso, fetchImpl) {
  const dueRows = await db.prepare(
    `SELECT o.id, o.intent, o.property_type, o.area_label, o.next_action, o.next_followup_at
     FROM crm_opportunities o
     WHERE o.status IN (${ACTIVE_OPP_SQL})
       AND o.next_followup_at IS NOT NULL
       AND datetime(o.next_followup_at) <= datetime(?, '+5 minutes')
       AND NOT EXISTS (
         SELECT 1 FROM crm_push_notifications_log l
         WHERE l.dedupe_key = ('due:' || o.id || ':' || o.next_followup_at)
       )
     ORDER BY o.next_followup_at ASC
     LIMIT 10`,
  ).bind(nowIso).all();

  let sent = 0;
  for (const opp of dueRows?.results || []) {
    const dedupeKey = `due:${opp.id}:${opp.next_followup_at}`;
    const stats = await broadcastToSubscriptions(db, subscriptions, buildDueFollowupPayload(opp), vapid, fetchImpl);
    if (stats.delivered > 0) {
      await db.prepare("INSERT OR IGNORE INTO crm_push_notifications_log(dedupe_key,kind) VALUES(?,'followup_due')")
        .bind(dedupeKey).run();
      sent += 1;
    }
  }
  return sent;
}

async function dispatchUpcomingViewingAlerts(db, subscriptions, vapid, nowIso, fetchImpl) {
  const viewingRows = await db.prepare(
    `SELECT p.id, p.viewing_at, l.title
     FROM crm_opportunity_properties p
     JOIN listings l ON l.id = p.listing_id
     WHERE p.presentation_status = 'viewing_scheduled'
       AND p.viewing_at IS NOT NULL
       AND datetime(p.viewing_at) <= datetime(?, '+30 minutes')
       AND datetime(p.viewing_at) >= datetime(?, '-2 hours')
       AND NOT EXISTS (
         SELECT 1 FROM crm_push_notifications_log log
         WHERE log.dedupe_key = ('viewing:' || p.id || ':' || p.viewing_at)
       )
     LIMIT 10`,
  ).bind(nowIso, nowIso).all();

  let sent = 0;
  for (const row of viewingRows?.results || []) {
    const dedupeKey = `viewing:${row.id}:${row.viewing_at}`;
    const unitTitle = sanitizePushText(row.title || 'وحدة بمدينة نصر', 90);
    const payload = {
      title: '🏠 تذكير بمعاينة عقار قريبة',
      body: `معاينة مجدولة قريبًا: ${unitTitle} — افتح الـCRM للتفاصيل.`,
      tag: `crm-view-${row.id.slice(0, 20)}`,
      url: '/',
    };
    const stats = await broadcastToSubscriptions(db, subscriptions, payload, vapid, fetchImpl);
    if (stats.delivered > 0) {
      await db.prepare("INSERT OR IGNORE INTO crm_push_notifications_log(dedupe_key,kind) VALUES(?,'viewing_due')")
        .bind(dedupeKey).run();
      sent += 1;
    }
  }
  return sent;
}

async function dispatchMorningDigestIfDue(db, subscriptions, vapid, nowDate, fetchImpl) {
  const digestSubs = subscriptions.filter(s => Number(s.morning_digest) === 1);
  if (digestSubs.length === 0) return 0;

  const { dayKey, minutesOfDay } = getCairoClock(nowDate);
  // Window: 09:30 (570m) through 11:59 (719m) Africa/Cairo local time (deduped once per day)
  if (minutesOfDay < 570 || minutesOfDay > 719) return 0;

  const dedupeKey = `digest:${dayKey}`;
  const already = await db.prepare('SELECT 1 AS hit FROM crm_push_notifications_log WHERE dedupe_key=?')
    .bind(dedupeKey).first();
  if (already) return 0;

  const counts = await db.prepare(
    `SELECT
      SUM(CASE WHEN status IN (${ACTIVE_OPP_SQL}) AND next_followup_at IS NOT NULL AND substr(next_followup_at,1,10) = ? THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN status IN (${ACTIVE_OPP_SQL}) AND next_followup_at IS NOT NULL AND substr(next_followup_at,1,10) < ? THEN 1 ELSE 0 END) AS overdue
     FROM crm_opportunities`,
  ).bind(dayKey, dayKey).first();

  const dueToday = Number(counts?.due_today || 0);
  const overdue = Number(counts?.overdue || 0);
  if (dueToday === 0 && overdue === 0) return 0;

  const payload = {
    title: '☀️ ملخص متابعات اليوم — سمسار طلبك',
    body: `لديك اليوم ${dueToday} متابعة مستحقة و${overdue} متابعة متأخرة في مدينة نصر.`,
    tag: `crm-digest-${dayKey}`,
    url: '/',
  };
  const stats = await broadcastToSubscriptions(db, digestSubs, payload, vapid, fetchImpl);
  if (stats.delivered > 0) {
    await db.prepare("INSERT OR IGNORE INTO crm_push_notifications_log(dedupe_key,kind) VALUES(?,'morning_digest')")
      .bind(dedupeKey).run();
    return 1;
  }
  return 0;
}

export async function runScheduledCrmNotifications(env, { now = new Date(), fetchImpl = fetch, forceCheck = false } = {}) {
  const vapid = await importVapidConfig(env);
  if (!vapid) return { ok: false, skipped: 'push_not_configured', followup_alerts: 0, viewing_alerts: 0, morning_digest: 0 };

  const subsRes = await env.DB.prepare(
    'SELECT id,endpoint,p256dh,auth,morning_digest FROM crm_push_subscriptions LIMIT 25',
  ).all();
  const subscriptions = subsRes?.results || [];
  if (subscriptions.length === 0) {
    return { ok: true, skipped: 'no_subscriptions', followup_alerts: 0, viewing_alerts: 0, morning_digest: 0 };
  }

  const nowIso = now.toISOString();
  const followupAlerts = await dispatchDueFollowupAlerts(env.DB, subscriptions, vapid, nowIso, fetchImpl);
  const viewingAlerts = await dispatchUpcomingViewingAlerts(env.DB, subscriptions, vapid, nowIso, fetchImpl);
  const morningDigest = forceCheck
    ? 0
    : await dispatchMorningDigestIfDue(env.DB, subscriptions, vapid, now, fetchImpl);

  await env.DB.prepare("DELETE FROM crm_push_notifications_log WHERE datetime(sent_at) < datetime(?, '-60 days')")
    .bind(nowIso).run();

  return {
    ok: true,
    followup_alerts: followupAlerts,
    viewing_alerts: viewingAlerts,
    morning_digest: morningDigest,
    subscriptions_checked: subscriptions.length,
  };
}
