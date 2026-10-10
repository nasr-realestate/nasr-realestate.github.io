// Web Push — واجهة العميل (assets/js/push-notifications.js) تحت node:vm
//   • يتحقّق من العقد الفعلي مع الـWorker: POST /push/subscribe → { ok: true, id: <16 hex> }
//     (نفس العقد المُختبَر في push-notifications.test.mjs — لا حقول مُخترَعة هنا).
//   • السيناريوهات: اشتراك حقيقي + معرّف محفوظ · اشتراك بلا معرّف · معرّف قديم بلا اشتراك ·
//     فشل الطلب · رد ناجح بلا معرّف صالح · نجاح/فشل النسخ · منع الطلبات المكررة · منع النجاح الزائف.
//   • لا شبكة حقيقية ولا إشعارات: fetch مراقَب، والحافظة وexecCommand قابلان للتحكم.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const SRC = new URL("../../assets/js/push-notifications.js", import.meta.url);
const scriptSrc = fs.readFileSync(SRC, "utf8");
const API_BASE = "https://royal-snow-ea32.footcai-555.workers.dev";
const SUB_ID_KEY = "nasrPushSubId";
const VALID_ID = "0123456789abcdef";
const MSG_ID_FETCH_FAILED = "تعذر جلب المعرّف — تحقق من الاتصال";
const MSG_COPY_OK = "تم النسخ ✓";
const MSG_COPY_FAILED = "تعذر النسخ — يمكنك تحديد المعرّف بالأعلى ونسخه يدويًا.";
const MSG_SAVE_FAILED = "تم التفعيل في المتصفح، لكن تعذّر حفظ الاشتراك على الخادم — اضغط «فعّل التنبيهات» مرة أخرى.";
const SUBSCRIBED_TEXT = "أنت مشترك ✓";

// ───────── DOM مصغّر (بلا jsdom) يدعم المحدّدات البسيطة المستخدمة في السكربت ─────────
function matchesSimple(el, sel) {
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let m;
  let any = false;
  while ((m = re.exec(String(sel)))) {
    any = true;
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    if (m[2] && !el._classes.has(m[2])) return false;
    if (m[3]) {
      if (el.getAttribute(m[3]) === null) return false;
      if (m[4] !== undefined && el.getAttribute(m[3]) !== m[4]) return false;
    }
  }
  return any;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this._classes = new Set();
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.logs = [];
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) { (this.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...ev })); }
  appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
  querySelectorAll(sel) {
    const groups = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (groups.some((g) => matchesSimple(c, g))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  select() { this.logs.push("select"); }
  setSelectionRange(a, b) { this.logs.push(`range:${a}-${b}`); }
}

function makeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// ───────── صفحة /notifications.html كما هي في المستودع (نفس البنية والمحدّدات) ─────────
function buildCard() {
  const card = new El("section");
  card.className = "push-card";
  card.setAttribute("data-push-panel", "");
  card.setAttribute("data-push-state", "loading");
  const status = new El("p");
  status.className = "push-status-text";
  const actions = new El("div");
  actions.className = "push-actions";
  const enable = new El("button"); enable.setAttribute("data-push-enable", "");
  const disable = new El("button"); disable.setAttribute("data-push-disable", "");
  const copy = new El("button"); copy.setAttribute("data-push-copy-id", ""); copy.textContent = "نسخ معرّف الاشتراك";
  actions.children = [enable, disable, copy];
  [enable, disable, copy].forEach((b) => { b.parent = actions; });
  const hint = new El("p");
  hint.className = "push-hint";
  const subId = new El("span");
  subId.className = "push-sub-id";
  subId.textContent = "—";
  hint.children = [subId]; subId.parent = hint;
  card.children = [status, actions, hint];
  card.children.forEach((c) => { c.parent = card; });
  return { card, status, enable, disable, copy, subId };
}

// اشتراك متصفح وهمي (endpoint + keys) — لا يُطبع ولا يُرسل لأي شبكة حقيقية
function makeSubscription(endpoint = "https://push.example.test/ep/abc") {
  const keys = { p256dh: "BP256dhTestKey", auth: "authSecretTest" };
  const sub = { endpoint, keys, toJSON: () => ({ endpoint, keys }), unsubscribed: false };
  sub.unsubscribe = async () => { sub.unsubscribed = true; return true; };
  return sub;
}

// ───────── تشغيل السكربت الحقيقي في سياق معزول ─────────
function bootPage(opts = {}) {
  const {
    subscription = makeSubscription(),
    newSubscription,           // ما يعيده pushManager.subscribe() عند التفعيل (افتراضيًا نفس الحالي)
    storage = {},
    permission = "default",
    config = { ok: true, enabled: true, publicKey: "BFakeVapidPublicKey" },
    subscribeReply,            // دالة/قيمة لرد /push/subscribe
    clipboard = null,          // { writeText } أو null (بلا clipboard API)
    execCommand = null,        // نتيجة document.execCommand('copy') أو null (غير مدعوم)
    readyState = "complete",
  } = opts;

  const dom = buildCard();
  const body = new El("body");
  body.appendChild(dom.card);
  const calls = [];
  const timers = [];
  const logged = [];

  const fetchImpl = async (input, init) => {
    const url = String(input);
    const bodyText = init && init.body ? String(init.body) : "";
    calls.push({ url, init, body: bodyText });
    const path = url.replace(API_BASE, "");
    if (path === "/push/config") return { json: async () => config };
    if (path === "/push/subscribe") {
      const reply = typeof subscribeReply === "function" ? subscribeReply(bodyText, calls.length) : subscribeReply;
      if (reply instanceof Error) throw reply;
      return { json: async () => reply };
    }
    if (path === "/push/unsubscribe") return { json: async () => ({ ok: true }) };
    throw new Error(`unexpected fetch: ${path}`);
  };

  const reg = {
    scope: "https://nasr-realestate.github.io/",
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => (newSubscription === undefined ? (subscription || makeSubscription()) : newSubscription),
    },
  };
  const navigator = {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    platform: "X11",
    maxTouchPoints: 0,
    onLine: true,
    serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
  };
  if (clipboard) navigator.clipboard = clipboard;

  const Notification = {
    permission,
    requestPermission: async () => permission,
  };
  const doc = {
    readyState,
    body,
    documentElement: new El("html"),
    createElement: (tag) => new El(tag),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    addEventListener() {},
    execCommand: execCommand === null ? undefined : () => execCommand,
  };
  const win = {
    document: doc,
    navigator,
    Notification,
    PushManager: function PushManager() {},
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
  };
  const localStorage = makeStorage(storage);

  const ctx = vm.createContext({
    window: win, document: doc, navigator, Notification, localStorage,
    fetch: fetchImpl, atob, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}, console: { log: (...a) => logged.push(a.join(" ")), warn: (...a) => logged.push(a.join(" ")), error: (...a) => logged.push(a.join(" ")) },
    URL, URLSearchParams, Promise,
  });
  vm.runInContext(scriptSrc, ctx, { filename: "assets/js/push-notifications.js" });

  return {
    ...dom, body, localStorage, calls, timers, logged, win, ctx,
    api: win.NasrPush,
    notice: () => dom.card.querySelector(".push-notice"),
    noticeText: () => (dom.card.querySelector(".push-notice") || {}).textContent || "",
    statusText: () => dom.status.textContent,
    idText: () => dom.subId.textContent,
    stored: () => localStorage.getItem(SUB_ID_KEY),
    subscribeCalls: () => calls.filter((c) => c.url.endsWith("/push/subscribe")),
    tick: () => new Promise((r) => setImmediate(r)),
  };
}

// ── 1) اشتراك حقيقي + معرّف محفوظ → عرض فوري بلا أي طلب شبكة ─────────────────────────
test("client: a real subscription plus a stored id shows the id with no network request", async () => {
  const p = bootPage({ storage: { [SUB_ID_KEY]: VALID_ID }, subscribeReply: { ok: true, id: VALID_ID } });
  await p.tick();
  assert.equal(p.api.getState(), "subscribed");
  assert.equal(p.idText(), VALID_ID, "the stored id is displayed");
  assert.match(p.statusText(), new RegExp(SUBSCRIBED_TEXT));
  assert.equal(p.calls.length, 0, "no /push/config and no /push/subscribe on load");
  // تحديثات متكررة لا تُنشئ طلبات
  await p.api.refresh(); await p.api.refresh();
  assert.equal(p.calls.length, 0);
});

// ── 2) اشتراك حقيقي بلا معرّف محفوظ → طلب واحد، حفظ، عرض، ومنع التكرار ───────────────
test("client: a real subscription without a stored id registers once, saves and displays the id", async () => {
  const p = bootPage({ subscribeReply: { ok: true, id: VALID_ID } });
  await p.tick();
  const subs = p.subscribeCalls();
  assert.equal(subs.length, 1, "exactly one /push/subscribe request");
  const sent = JSON.parse(subs[0].body);
  assert.equal(sent.subscription.endpoint, "https://push.example.test/ep/abc");
  assert.ok(sent.subscription.keys.p256dh && sent.subscription.keys.auth);
  assert.equal(sent.device, "desktop");
  assert.equal(p.stored(), VALID_ID, "the id is persisted under nasrPushSubId");
  assert.equal(p.idText(), VALID_ID);
  assert.equal(p.api.getState(), "subscribed");
  assert.equal(p.noticeText(), "", "no error notice on success");
  // refresh() متكررة لا تُعيد التسجيل
  await p.api.refresh();
  await p.api.refresh();
  await p.api.refresh();
  assert.equal(p.subscribeCalls().length, 1, "refresh() must not re-register");
});

// ── 3) لا اشتراك + معرّف قديم → لا حالة اشتراك ولا معرّف، والمفتاح يُمسح ───────────────
test("client: no real subscription with a stale stored id is not shown as subscribed and clears the key", async () => {
  const p = bootPage({
    subscription: null,
    storage: { [SUB_ID_KEY]: VALID_ID },
    config: { ok: true, enabled: true, publicKey: "BFakeVapidPublicKey" },
  });
  await p.tick();
  assert.equal(p.api.getState(), "ready", "state comes from the browser, not from localStorage");
  assert.equal(p.idText(), "—", "the stale id is not displayed");
  assert.equal(p.stored(), null, "the stale key is removed");
  assert.equal(p.statusText().includes(SUBSCRIBED_TEXT), false, "never claims a subscription that does not exist");
  assert.equal(p.subscribeCalls().length, 0);
  assert.equal(p.calls.length, 1, "only /push/config was requested");
  assert.equal(p.disable.disabled, true, "the unsubscribe button stays disabled");
});

// ── 3ب) اشتراك منتهٍ مع إذن مرفوض → الحالة الصحيحة ────────────────────────────────────
test("client: an expired subscription with denied permission shows the denied state, not subscribed", async () => {
  const p = bootPage({ subscription: null, permission: "denied", storage: { [SUB_ID_KEY]: VALID_ID } });
  await p.tick();
  assert.equal(p.api.getState(), "denied");
  assert.equal(p.idText(), "—");
  assert.equal(p.stored(), null);
});

// ── 4) فشل /push/subscribe → رسالة واضحة، بلا معرّف محفوظ، وبلا نجاح زائف ──────────────
test("client: a failed /push/subscribe shows a clear message and stores nothing", async () => {
  for (const reply of [{ ok: false, error: "rate_limited" }, new Error("network down")]) {
    const p = bootPage({ subscribeReply: reply });
    await p.tick();
    assert.equal(p.idText(), "—");
    assert.equal(p.stored(), null, "nothing is persisted after a failure");
    assert.equal(p.noticeText(), MSG_ID_FETCH_FAILED, "a visible, understandable error");
    assert.equal(p.api.getState(), "ready", "a browser subscription the server never confirmed is not shown as subscribed");
    assert.equal(p.statusText().includes(SUBSCRIBED_TEXT), false, "no fake subscription message");
    assert.equal(p.enable.disabled, false, "the user can retry");
    // refresh() متكررة تعرض الخطأ بلا طلبات جديدة
    await p.api.refresh();
    await p.api.refresh();
    assert.equal(p.subscribeCalls().length, 1, "the failed lookup is not retried automatically");
    assert.equal(p.noticeText(), MSG_ID_FETCH_FAILED);
  }
});

// ── 5) رد ناجح بلا معرّف صالح → لا حفظ ولا عرض ولا نجاح ───────────────────────────────
test("client: a successful response without a valid id is rejected (no save, no display)", async () => {
  for (const reply of [{ ok: true }, { ok: true, id: "" }, { ok: true, id: "NOT-A-VALID-ID" }, { ok: true, id: "0123456789abcdef0" }, {}]) {
    const p = bootPage({ subscribeReply: reply });
    await p.tick();
    assert.equal(p.stored(), null, `nothing stored for ${JSON.stringify(reply)}`);
    assert.equal(p.idText(), "—");
    assert.equal(p.noticeText(), MSG_ID_FETCH_FAILED);
  }
});

// ── 6) النسخ: نجاح عبر clipboard API ─────────────────────────────────────────────────
test("client: copy succeeds through the clipboard API and only then reports success", async () => {
  const written = [];
  const p = bootPage({
    storage: { [SUB_ID_KEY]: VALID_ID },
    clipboard: { writeText: async (t) => { written.push(t); } },
  });
  await p.tick();
  const out = await p.api.copyId();
  await p.tick();
  assert.deepEqual(written, [VALID_ID], "the id itself was copied");
  assert.equal(out.copied, true);
  assert.equal(p.copy.textContent, MSG_COPY_OK, "«تم النسخ ✓» appears only after a real copy");
  assert.equal(p.noticeText(), MSG_COPY_OK);
  assert.equal(p.calls.length, 0, "a known id is copied with no network request");
  assert.equal(p.copy.disabled, false, "the button is usable again");
});

// ── 6ب) النسخ: بديل execCommand عندما ترفض الحافظة ───────────────────────────────────
test("client: copy falls back to a temporary textarea + execCommand when the clipboard API fails", async () => {
  const p = bootPage({
    storage: { [SUB_ID_KEY]: VALID_ID },
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: true,
  });
  await p.tick();
  const out = await p.api.copyId();
  assert.equal(out.copied, true);
  assert.equal(p.copy.textContent, MSG_COPY_OK);
  const ta = p.body.children.find((c) => c.tagName === "TEXTAREA");
  assert.equal(ta, undefined, "the temporary textarea is removed after copying");
});

// ── 6ج) النسخ: فشل الحافظة والبديل → رسالة فشل واضحة وبلا نجاح زائف ──────────────────
test("client: copy failure is reported to the user and never faked", async () => {
  const p = bootPage({
    storage: { [SUB_ID_KEY]: VALID_ID },
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: false,
  });
  await p.tick();
  const out = await p.api.copyId();
  assert.equal(out.copied, false);
  assert.equal(p.copy.textContent.includes(MSG_COPY_OK), false, "no fake success on the button");
  assert.equal(p.noticeText(), MSG_COPY_FAILED, "a visible failure with the manual-copy hint");
  assert.equal(p.idText(), VALID_ID, "the id stays selectable for a manual copy");
  assert.equal(p.copy.disabled, false);
});

// ── 6د) بلا clipboard API إطلاقًا وبلا execCommand → فشل مُعلن ────────────────────────
test("client: without any clipboard support the button reports failure instead of staying silent", async () => {
  const p = bootPage({ storage: { [SUB_ID_KEY]: VALID_ID } });
  await p.tick();
  const out = await p.api.copyId();
  assert.equal(out.copied, false);
  assert.equal(p.noticeText(), MSG_COPY_FAILED);
  assert.equal(p.copy.textContent.includes(MSG_COPY_OK), false);
});

// ── 6هـ) معرّف غير معروف + لا اشتراك → رسالة واضحة وبلا طلب ──────────────────────────
test("client: copying with no subscription says so instead of failing silently", async () => {
  const p = bootPage({ subscription: null });
  await p.tick();
  const out = await p.api.copyId();
  assert.equal(out.copied, false);
  assert.equal(out.reason, "no_subscription");
  assert.match(p.noticeText(), /لا يوجد اشتراك فعّال/);
  assert.equal(p.subscribeCalls().length, 0);
});

// ── 7) منع الطلبات المكررة: نقرات متزامنة على زر النسخ ────────────────────────────────
test("client: repeated copy clicks share one in-flight registration request", async () => {
  const p = bootPage({
    // المحاولة التلقائية عند التحميل تفشل → لا معرّف محفوظ، فالنقر يحتاج جلبًا واحدًا
    subscribeReply: (_body, n) => (n === 1 ? { ok: false, error: "rate_limited" } : { ok: true, id: VALID_ID }),
    clipboard: { writeText: async () => {} },
  });
  await p.tick();
  assert.equal(p.subscribeCalls().length, 1, "the load-time attempt happened once");
  assert.equal(p.stored(), null);
  p.copy.dispatch("click");
  p.copy.dispatch("click");
  p.copy.dispatch("click");
  const pending = [p.api.copyId(), p.api.copyId(), p.api.copyId()];
  const results = await Promise.all(pending);
  await p.tick();
  assert.equal(p.subscribeCalls().length, 2, "the concurrent clicks/calls collapse into a single new request");
  assert.deepEqual(results.map((r) => r.copied), [true, true, true]);
  assert.equal(p.copy.textContent, MSG_COPY_OK);
  assert.equal(p.stored(), VALID_ID);
  assert.equal(p.copy.disabled, false, "the button is re-enabled after the operation");
});

// ── 8) لا نجاح زائفًا: اشتراك المتصفح نجح لكن حفظه لدى الخادم فشل ─────────────────────
test("client: enablePush does not claim a server-side subscription when saving fails", async () => {
  const p = bootPage({
    subscription: null,
    permission: "granted",
    subscribeReply: { ok: false, error: "rate_limited" },
  });
  await p.tick();
  const ok = await p.api.enable();
  await p.tick();
  assert.equal(ok, false);
  assert.equal(p.api.getState(), "ready", "not reported as subscribed");
  assert.equal(p.statusText().includes(SUBSCRIBED_TEXT), false, "no fake success message");
  assert.equal(p.noticeText(), MSG_SAVE_FAILED, "an understandable error telling the user to retry");
  assert.equal(p.stored(), null);
  assert.equal(p.idText(), "—");
  assert.equal(p.enable.disabled, false, "the user can retry");
});

// ── 8ب) enablePush ناجح: حفظ + عرض المعرّف بعد تأكيد الخادم ───────────────────────────
test("client: enablePush saves and displays the id only after the server confirms it", async () => {
  const p = bootPage({ subscription: null, permission: "granted", subscribeReply: { ok: true, id: VALID_ID } });
  await p.tick();
  const ok = await p.api.enable();
  await p.tick();
  assert.equal(ok, true);
  assert.equal(p.api.getState(), "subscribed");
  assert.equal(p.stored(), VALID_ID);
  assert.equal(p.idText(), VALID_ID);
  assert.equal(p.disable.disabled, false, "the unsubscribe button is enabled for subscribers");
  assert.equal(p.noticeText(), "");
});

// ── 8ج) enablePush: رد الخادم بلا معرّف صالح = لا حفظ ولا نجاح ────────────────────────
test("client: enablePush treats a server response without a valid id as a failure", async () => {
  const p = bootPage({ subscription: null, permission: "granted", subscribeReply: { ok: true } });
  await p.tick();
  const ok = await p.api.enable();
  assert.equal(ok, false);
  assert.equal(p.stored(), null);
  assert.equal(p.api.getState(), "ready");
  assert.equal(p.statusText().includes(SUBSCRIBED_TEXT), false);
});

// ── الخصوصية: لا تُطبع بيانات الاشتراك أو المفاتيح في السجلات ─────────────────────────
test("client: subscription endpoints and keys are never written to the console", async () => {
  const p = bootPage({ subscribeReply: { ok: false, error: "invalid_keys" } });
  await p.tick();
  await p.api.copyId().catch(() => {});
  await p.tick();
  const all = p.logged.join("\n");
  assert.equal(all.includes("push.example.test"), false, "no endpoint in the logs");
  assert.equal(all.includes("BP256dhTestKey"), false, "no p256dh key in the logs");
  assert.equal(all.includes("authSecretTest"), false, "no auth secret in the logs");
  assert.equal(p.noticeText().includes("push.example.test"), false, "no subscription data in user-facing errors");
});

// ── الإيقاف يمسح المعرّف حتى لا يُعرض معرّف قديم لاحقًا ───────────────────────────────
test("client: unsubscribing clears the stored id and the displayed value", async () => {
  const sub = makeSubscription();
  const p = bootPage({ subscription: sub, storage: { [SUB_ID_KEY]: VALID_ID } });
  await p.tick();
  assert.equal(p.idText(), VALID_ID);
  await p.api.disable();
  await p.tick();
  assert.equal(sub.unsubscribed, true, "the browser subscription was released");
  assert.equal(p.calls.some((c) => c.url.endsWith("/push/unsubscribe")), true, "the server was told to forget it");
  assert.equal(p.stored(), null);
  assert.equal(p.idText(), "—");
  assert.equal(p.api.getState(), "ready");
});
