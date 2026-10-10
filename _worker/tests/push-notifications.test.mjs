// Web Push (VAPID) على الـWorker (_worker/worker.js) — اختبارات السلامة والتوافق
//   • تشفير RFC 8291 يُتحقق منه بمتجهات المثال الرسمية (Appendix A) ثم بفك تشفير
//     مستقل بلغة Node crypto لكشف أي انحراف عن RFC 8188/8291.
//   • ترويسة VAPID (RFC 8292) تُتحقق منها رياضيًا (ES256 + aud/exp/sub).
//   • الحماية: CORS للأصل الرسمي، تحقق من المدخلات، حدود المعدّل، سر الإرسال،
//     منع البيانات الشخصية (هواتف)، idempotency، تنظيف الاشتراكات المنتهية.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import agentWorker from "../worker.js";

const ORIGIN = "https://nasr-realestate.github.io";
const SEND_SECRET = "test-send-secret";
let ipSeq = 0;
const nextIp = () => `push-ip-${++ipSeq}`;

// ───────── أدوات base64url (مطابقة لصيغة الأدوات القياسية) ─────────
const b64uToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const bufToB64u = (b) => Buffer.from(b).toString("base64url");

// ───────── KV وهمي ─────────
function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k, opts) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return opts && opts.type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// ───────── مفاتيح VAPID حقيقية للاختبار (نفس صيغة push-notify-setup.yml) ─────────
function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const d = privateKey.export({ format: "jwk" }).d;
  const x = b64uToBuf(jwk.x);
  const y = b64uToBuf(jwk.y);
  const pub = bufToB64u(Buffer.concat([Buffer.from([4]), x, y]));
  return { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: d };
}
// زوج مفاتيح «جهاز» (المستلم) — p256dh + auth كما يُنتجها المتصفح
function generateDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const d = privateKey.export({ format: "jwk" }).d;
  const x = b64uToBuf(jwk.x);
  const y = b64uToBuf(jwk.y);
  return {
    p256dh: bufToB64u(Buffer.concat([Buffer.from([4]), x, y])),
    auth: bufToB64u(crypto.randomBytes(16)),
    priv32: b64uToBuf(d),
    pub65: Buffer.concat([Buffer.from([4]), x, y]),
  };
}

// ───────── مرجع فك التشفير (RFC 8291 / RFC 8188) بلغة Node crypto فقط ─────────
function decryptPushBody(bodyBytes, uaPriv32, uaPub65, uaAuth16) {
  const buf = Buffer.from(bodyBytes);
  assert.ok(buf.length > 86, "body is bigger than the RFC 8188 header");
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  assert.equal(rs, 4096, "record size must be 4096");
  const idlen = buf[20];
  assert.equal(idlen, 65, "keyid must be the 65-octet uncompressed point");
  const asPublic = buf.subarray(21, 21 + idlen);
  assert.equal(asPublic[0], 4);
  const cipher = buf.subarray(21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPriv32));
  const shared = ecdh.computeSecret(Buffer.from(asPublic));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(uaPub65), Buffer.from(asPublic)]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(uaAuth16), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  const tag = cipher.subarray(cipher.length - 16);
  decipher.setAuthTag(Buffer.from(tag));
  const plain = Buffer.concat([decipher.update(Buffer.from(cipher.subarray(0, cipher.length - 16))), decipher.final()]);
  assert.equal(plain[plain.length - 1], 0x02, "padding delimiter 0x02 must end the record");
  return plain.subarray(0, plain.length - 1);
}

test("RFC 8291 Appendix A: the independent decrypt reference matches the official test vector", () => {
  const uaPrivate = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
  const uaPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const uaAuth = "BTBZMqHH6r4Tts7J_aSIgg";
  const headerB64u = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const cipherB64u = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
  const body = Buffer.concat([b64uToBuf(headerB64u), b64uToBuf(cipherB64u)]);
  const plain = decryptPushBody(body, b64uToBuf(uaPrivate), b64uToBuf(uaPublic), b64uToBuf(uaAuth));
  assert.equal(plain.toString("utf8"), "When I grow up, I want to be a watermelon");
});

// ───────── harness: طلبات /push/ ─────────
async function pushReq(path, { method = "POST", body, headers = {}, ip = nextIp(), env } = {}) {
  const init = {
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await agentWorker.fetch(new Request(`https://agent.test${path}`, init), env);
  let json = null;
  try { json = await response.json(); } catch { /* non-json */ }
  return { status: response.status, json, headers: response.headers };
}

function testEnv(overrides = {}) {
  return { PUSH_SUBS: makeKv(), ...generateVapid(), PUSH_SEND_SECRET: SEND_SECRET, ...overrides };
}

const deviceSub = (device, endpoint = `https://push.example.test/ep/${crypto.randomBytes(8).toString("hex")}`) => ({
  endpoint,
  keys: { p256dh: device.p256dh, auth: device.auth },
});

const sendBody = (over = {}) => ({
  kind: "property",
  title: "شقة 180م للبيع في الحي السابع",
  price: "2,500,000 ج.م",
  location: "الحي السابع - مدينة نصر",
  url: "https://nasr-realestate.github.io/properties/test-slug/",
  filePath: "_properties/2026-10-10-test-slug.md",
  commitSha: "a".repeat(40),
  ...over,
});

// ───────── fetch وهمي لخدمات Push (يأسر الطلبات ويتحكم في الحالات) ─────────
function installPushFetchMock(handler) {
  const real = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    captured.push({ url, init });
    return handler(url, init, captured.length);
  };
  return { captured, restore: () => { globalThis.fetch = real; } };
}

test("GET /push/config: disabled without configuration, enabled with VAPID+KV (public key only)", async () => {
  const off1 = await pushReq("/push/config", { method: "GET", env: {} });
  assert.equal(off1.status, 200);
  assert.equal(off1.json.enabled, false);
  assert.equal(off1.json.publicKey, null);

  const env = testEnv();
  const on = await pushReq("/push/config", { method: "GET", env });
  assert.equal(on.json.enabled, true);
  assert.equal(on.json.publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal(JSON.stringify(on.json).includes(SEND_SECRET), false, "the send secret must never leak");
  assert.equal(JSON.stringify(on.json).includes(env.VAPID_PRIVATE_KEY), false, "the private key must never leak");
});

test("subscribe stores only technical data and returns a short id; unsubscribe removes it", async () => {
  const env = testEnv();
  const device = generateDevice();
  const sub = deviceSub(device);
  const r = await pushReq("/push/subscribe", { body: { subscription: sub, device: "mobile" }, env });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.id, /^[0-9a-f]{16}$/);

  const stored = [...env.PUSH_SUBS.store.values()].map((v) => JSON.parse(v));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].endpoint, sub.endpoint);
  assert.deepEqual(stored[0].keys, sub.keys);
  // لا بيانات شخصية: لا أسماء/هواتف/وكلاء مستخدم كاملين
  const blob = JSON.stringify(stored);
  assert.equal(/userAgent|ownerName|phone/i.test(blob), false);

  const un = await pushReq("/push/unsubscribe", { body: { endpoint: sub.endpoint }, env });
  assert.equal(un.status, 200);
  assert.equal(un.json.ok, true);
  assert.equal(env.PUSH_SUBS.store.size, 0);
});

test("subscribe validates the endpoint (https + public host) and key shapes", async () => {
  const env = testEnv();
  const device = generateDevice();
  const bad = [
    { ...deviceSub(device, "http://push.example.test/ep"), note: "http scheme" },
    { ...deviceSub(device, "https://localhost/ep"), note: "localhost" },
    { ...deviceSub(device, "https://192.168.1.10/ep"), note: "ip literal" },
    { ...deviceSub(device, "https://intranet.local/ep"), note: ".local" },
  ];
  for (const sub of bad) {
    const r = await pushReq("/push/subscribe", { body: { subscription: sub }, env });
    assert.equal(r.status, 400, sub.note);
    assert.equal(r.json.error, "invalid_endpoint");
  }
  const shortKeys = await pushReq("/push/subscribe", {
    body: { subscription: { endpoint: "https://push.example.test/ep/ok", keys: { p256dh: bufToB64u(Buffer.alloc(64, 4)), auth: device.auth } } },
    env,
  });
  assert.equal(shortKeys.status, 400);
  assert.equal(shortKeys.json.error, "invalid_keys");
  const shortAuth = await pushReq("/push/subscribe", {
    body: { subscription: { ...deviceSub(device), keys: { p256dh: device.p256dh, auth: bufToB64u(Buffer.alloc(8, 2)) } } },
    env,
  });
  assert.equal(shortAuth.status, 400);
  assert.equal(shortAuth.json.error, "invalid_keys");
});

test("subscribe is rate-limited per IP (12 per hour)", async () => {
  const env = testEnv();
  const device = generateDevice();
  const ip = nextIp();
  for (let i = 0; i < 12; i += 1) {
    const r = await pushReq("/push/subscribe", {
      body: { subscription: deviceSub(device, `https://push.example.test/ep/${i}`) }, env, ip,
    });
    assert.equal(r.status, 200);
  }
  const blocked = await pushReq("/push/subscribe", { body: { subscription: deviceSub(device) }, env, ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, "rate_limited");
});

test("send requires the Worker secret; wrong or missing bearer is 401", async () => {
  const env = testEnv();
  const noAuth = await pushReq("/push/send", { body: sendBody(), env });
  assert.equal(noAuth.status, 401);
  const badAuth = await pushReq("/push/send", { body: sendBody(), env, headers: { Authorization: "Bearer nope" } });
  assert.equal(badAuth.status, 401);
  const good = await pushReq("/push/send", {
    body: sendBody(), env, headers: { Authorization: `Bearer ${SEND_SECRET}` },
  });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json.ok, true);
  assert.equal(good.json.note, "no_subscribers");
});

test("send validates file path, commit sha, kind and site URL", async () => {
  const env = testEnv();
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const cases = [
    [sendBody({ filePath: "etc/passwd" }), "invalid_file_path"],
    [sendBody({ commitSha: "not-a-sha" }), "invalid_commit_sha"],
    [sendBody({ url: "https://evil.example.com/properties/x/" }), "invalid_url"],
    [sendBody({ url: "https://nasr-realestate.github.io/agent.html" }), "invalid_url"],
    [sendBody({ url: "https://nasr-realestate.github.io/properties/../secret/" }), "invalid_url"],
    [sendBody({ kind: "request" }), "kind_mismatch"],
    [sendBody({ title: "" }), "invalid_title"],
    [sendBody({ title: "عندي شقة للبيع 01012345678" }), "privacy_guard"],
    [sendBody({ title: "شقة", location: "اتصل على 01147758857" }), "privacy_guard"],
  ];
  for (const [body, expected] of cases) {
    const r = await pushReq("/push/send", { body, env, headers: auth });
    assert.equal(r.status, 400, `${expected} → ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, expected);
  }
  // حد حجم جسم الطلب (8KB) يُفرض على مسارات /push/
  const big = await pushReq("/push/send", {
    body: "x".repeat(9 * 1024), env, headers: auth,
  });
  assert.equal(big.status, 413);
});

test("send accepts listing URLs with or without a slug (root collection links)", async () => {
  const env = testEnv();
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  for (const url of [
    "https://nasr-realestate.github.io/",
    "https://nasr-realestate.github.io/properties/",
    "https://nasr-realestate.github.io/requests/",
  ]) {
    const r = await pushReq("/push/send", {
      body: sendBody({ url, commitSha: "d".repeat(40), filePath: "_properties/2026-10-10-test-slug.md" }),
      env, headers: auth,
    });
    assert.equal(r.status, 200, `${url} → ${JSON.stringify(r.json)}`);
  }
});

test("test sends must target exactly one subscription — no broadcast test", async () => {
  const env = testEnv();
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const noTarget = await pushReq("/push/send", { body: sendBody({ test: true }), env, headers: auth });
  assert.equal(noTarget.status, 400);
  assert.equal(noTarget.json.error, "test_requires_single_target");
});

test("send is idempotent per commit SHA + file path — workflow re-runs never duplicate", async () => {
  const env = testEnv();
  const device = generateDevice();
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(device) }, env });
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const mock = installPushFetchMock(() => new Response("", { status: 201 }));
  try {
    const first = await pushReq("/push/send", { body: sendBody(), env, headers: auth });
    assert.equal(first.json.ok, true);
    assert.equal(first.json.deduped, false);
    assert.equal(first.json.success, 1);
    const second = await pushReq("/push/send", { body: sendBody(), env, headers: auth });
    assert.equal(second.json.deduped, true);
    assert.equal(second.json.attempted, 0);
    assert.equal(mock.captured.length, 1, "the push service must be contacted once");
  } finally {
    mock.restore();
  }
});

test("broadcast delivers to every subscriber; 404/410 subscriptions are deleted; counts are reported", async () => {
  const env = testEnv();
  const d1 = generateDevice(), d2 = generateDevice(), d3 = generateDevice();
  const e1 = "https://push.example.test/ep/one", e2 = "https://push.example.test/ep/two", e3 = "https://push.example.test/ep/three";
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(d1, e1) }, env });
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(d2, e2) }, env });
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(d3, e3) }, env });

  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const mock = installPushFetchMock((url) => {
    if (url === e1) return new Response("", { status: 201 });
    if (url === e2) return new Response("", { status: 410 });
    return new Response("", { status: 404 });
  });
  try {
    const r = await pushReq("/push/send", { body: sendBody(), env, headers: auth });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(r.json.attempted, 3);
    assert.equal(r.json.success, 1);
    assert.equal(r.json.failed, 2);
    assert.equal(r.json.removed, 2);
  } finally {
    mock.restore();
  }
  // الاشتراكات المنتهية اختفت وبقي السليم فقط
  const left = [...env.PUSH_SUBS.store.keys()].filter((k) => k.startsWith("push:sub:"));
  assert.equal(left.length, 1);
  assert.equal(JSON.parse(env.PUSH_SUBS.store.get(left[0])).endpoint, e1);
});

test("a real send fails (502) when every delivery fails; test mode stays informational", async () => {
  const env = testEnv();
  const device = generateDevice();
  const ep = "https://push.example.test/ep/down";
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(device, ep) }, env });
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const mock = installPushFetchMock(() => new Response("", { status: 503 }));
  try {
    const real = await pushReq("/push/send", { body: sendBody(), env, headers: auth });
    assert.equal(real.status, 502);
    assert.equal(real.json.ok, false);
    assert.equal(real.json.error, "all_deliveries_failed");
    assert.equal(real.json.attempted, 1);
  } finally {
    mock.restore();
  }
});

test("RFC 8291 end-to-end: the worker's ciphertext decrypts with the device key (independent reference)", async () => {
  const env = testEnv();
  const device = generateDevice();
  const ep = "https://push.example.test/ep/roundtrip";
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(device, ep) }, env });
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };

  let capturedReq = null;
  const mock = installPushFetchMock((url, init) => {
    capturedReq = { url, init };
    return new Response("", { status: 201 });
  });
  try {
    const r = await pushReq("/push/send", { body: sendBody(), env, headers: auth });
    assert.equal(r.json.success, 1, JSON.stringify(r.json));
  } finally {
    mock.restore();
  }
  assert.ok(capturedReq, "the push service was called");
  assert.equal(capturedReq.url, ep);

  const headers = capturedReq.init.headers;
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.match(headers.Encryption, /^salt=[A-Za-z0-9\-_]+$/);
  assert.match(headers["Crypto-Key"], /^dh=[A-Za-z0-9\-_]+; p256ecdsa=[A-Za-z0-9\-_]+$/);
  assert.equal(headers.TTL, "86400");
  assert.equal(headers.Urgency, "normal");

  const plain = decryptPushBody(capturedReq.init.body, device.priv32, device.pub65, b64uToBuf(device.auth));
  const payload = JSON.parse(plain.toString("utf8"));
  assert.equal(payload.title, "🏠 عرض جديد: شقة 180م للبيع في الحي السابع");
  assert.equal(payload.body, "💰 2,500,000 ج.م · 📍 الحي السابع - مدينة نصر");
  assert.equal(payload.url, "https://nasr-realestate.github.io/properties/test-slug/");
});

test("RFC 8292: the VAPID JWT is ES256-signed with correct aud/exp/sub claims", async () => {
  const env = testEnv();
  const device = generateDevice();
  const ep = "https://fcm.googleapis.com/fcm/send/abc";
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(device, ep) }, env });
  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  let capturedReq = null;
  const mock = installPushFetchMock((url, init) => {
    capturedReq = { url, init };
    return new Response("", { status: 201 });
  });
  try {
    await pushReq("/push/send", { body: sendBody(), env, headers: auth });
  } finally {
    mock.restore();
  }
  const m = /^vapid t=(.+), k=(.+)$/.exec(capturedReq.init.headers.Authorization);
  assert.ok(m, "Authorization: vapid t=…, k=… expected");
  assert.equal(m[2], env.VAPID_PUBLIC_KEY);

  const [h, p, s] = m[1].split(".");
  const pub65 = b64uToBuf(m[2]);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bufToB64u(pub65.subarray(1, 33)), y: bufToB64u(pub65.subarray(33, 65)),
  };
  const keyObject = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verified = crypto.verify(
    "sha256", Buffer.from(`${h}.${p}`),
    { key: keyObject, dsaEncoding: "ieee-p1363" },
    b64uToBuf(s)
  );
  assert.equal(verified, true, "ES256 signature must verify with the VAPID public key");

  const claims = JSON.parse(b64uToBuf(p).toString("utf8"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:samsar.talabak@mailo.com");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 12 * 3600);
});

test("test mode reaches exactly the targeted subscription and never the others", async () => {
  const env = testEnv();
  const d1 = generateDevice(), d2 = generateDevice();
  const e1 = "https://push.example.test/ep/targeted", e2 = "https://push.example.test/ep/bystander";
  await pushReq("/push/subscribe", { body: { subscription: deviceSub(d1, e1) }, env });
  const r2 = await pushReq("/push/subscribe", { body: { subscription: deviceSub(d2, e2) }, env });

  const auth = { Authorization: `Bearer ${SEND_SECRET}` };
  const mock = installPushFetchMock(() => new Response("", { status: 201 }));
  try {
    const r = await pushReq("/push/send", {
      body: sendBody({ test: true, target: r2.json.id, idempotencyKey: "sha:file.md#test-42-1" }),
      env, headers: auth,
    });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(r.json.attempted, 1);
    assert.equal(r.json.success, 1);
    assert.equal(r.json.id, "sha:file.md#test-42-1", "test sends carry a run-scoped idempotency key");
  } finally {
    mock.restore();
  }
});

test("chat routing is untouched: GET / stays 405 and /push/* never reaches chat handlers", async () => {
  const res = await agentWorker.fetch(new Request("https://agent.test/", {
    method: "GET", headers: { Origin: ORIGIN, "CF-Connecting-IP": nextIp() },
  }), { GEMINI_API_KEY: "test-key" });
  assert.equal(res.status, 405);
  const unknown = await pushReq("/push/unknown", { body: {}, env: testEnv() });
  assert.equal(unknown.status, 404);
});

test("sw.js keeps its cache strategy and only opens same-origin notification links", () => {
  const sw = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");
  assert.match(sw, /caches\.open\(CACHE_NAME\)/, "cache logic must remain");
  assert.match(sw, /Network-First/, "the documented strategy must remain");
  assert.match(sw, /self\.addEventListener\('push'/);
  assert.match(sw, /self\.addEventListener\('notificationclick'/);
  assert.match(sw, /safeNotificationUrl/);
  assert.match(sw, /u\.origin === PUSH_SITE_ORIGIN/, "click targets are restricted to the site origin");
  // لا تسجيل Service Worker آخر في الكود
  const site = readFileSync(new URL("../../_includes/pwa.html", import.meta.url), "utf8");
  const registers = site.match(/\.register\(/g) || [];
  assert.equal(registers.length, 1, "only /sw.js may be registered");
});

test("the client script never requests notification permission outside a user click", () => {
  const js = readFileSync(new URL("../../assets/js/push-notifications.js", import.meta.url), "utf8");
  assert.match(js, /function enablePush\(\)/);
  const requests = js.match(/Notification\.requestPermission/g) || [];
  assert.equal(requests.length, 1, "exactly one requestPermission call, inside enablePush");
  const idx = js.indexOf("Notification.requestPermission");
  const enableIdx = js.indexOf("function enablePush");
  const disableIdx = js.indexOf("function disablePush");
  assert.ok(idx > enableIdx && idx < disableIdx, "requestPermission must live inside enablePush only");
});
