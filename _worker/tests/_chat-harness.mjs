// Harness for black-box tests of the Gemini-first chat route (POST /chat) — helper module, not a test file.
//
// • fetch وهمي: ai-feed.json بقائمة اختبار اصطناعية، وGemini بمُجيب مبرمج لكل طلب (JSON / خطأ HTTP / مهلة).
//   أي طلب خارجي تاني (ImgBB، GitHub، واتساب…) بيرمي استثناء ويتسجّل — الاختبارات بتتأكد إنه ما حصلش.
// • Conversation بيحاكي المتصفح: بيحتفظ بالحالة المنظمة + آخر الرسائل في الذاكرة ويبعتهم مع كل رسالة.
// • كل البيانات اصطناعية (test-*) — مفيش بيانات عملاء ولا عقارات حقيقية.
import agentWorker from "../worker.js";

export const ORIGIN = "https://nasr-realestate.github.io";
export const FEED_DATE = "2026-10-26T12:00:00.000Z";

const P = (slug, o) => ({
  id: slug, slug, url: `https://nasr-realestate.github.io/properties/${slug}/`, title: o.title,
  transaction: o.tx, propertyType: o.type ?? "apartment", location: o.location, zone: o.zone ?? "",
  price: `${o.price.toLocaleString("en-US")} ج.م`, priceNumeric: o.price,
  area: o.area ? `${o.area} متر مربع` : "", areaNumeric: o.area ?? 0, roomsNumeric: o.rooms ?? 3, bathsNumeric: o.baths ?? 2,
  furnished: o.furnished ?? "", image: `https://nasr-realestate.github.io/assets/img/properties/${slug}.webp`,
  date: o.date ?? "2026-10-01T00:00:00.000Z", availability_status: "needs_confirmation", last_confirmed_at: null,
  ...(o.extra || {}),
});
export const FEED = {
  generated_at: FEED_DATE, last_updated: "2026-10-26", total_count: 12,
  properties: [
    P("test-sale-180-makram", { title: "شقة اختبار 180م للبيع — مكرم عبيد", tx: "sale", location: "شارع مكرم عبيد - مدينة نصر", zone: "مكرم عبيد", price: 6500000, area: 180, date: "2026-10-20T00:00:00.000Z" }),
    P("test-sale-175-abbas", { title: "شقة اختبار 175م للبيع — عباس العقاد", tx: "sale", location: "عباس العقاد - مدينة نصر", zone: "عباس العقاد", price: 5800000, area: 175, date: "2026-10-18T00:00:00.000Z" }),
    P("test-sale-185-zone7", { title: "شقة اختبار 185م للبيع — المنطقة السابعة", tx: "sale", location: "المنطقة السابعة - مدينة نصر", zone: "المنطقة السابعة", price: 6900000, area: 185, date: "2026-10-10T00:00:00.000Z" }),
    P("test-sale-160-zone7", { title: "شقة اختبار 160م للبيع — المنطقة السابعة", tx: "sale", location: "المنطقة السابعة - مدينة نصر", zone: "المنطقة السابعة", price: 7200000, area: 160, date: "2026-10-05T00:00:00.000Z" }),
    P("test-sale-200-zone7", { title: "شقة اختبار 200م للبيع — المنطقة السابعة", tx: "sale", location: "المنطقة السابعة - مدينة نصر", zone: "المنطقة السابعة", price: 9000000, area: 200, rooms: 4, date: "2026-09-25T00:00:00.000Z" }),
    P("test-sale-120-hayy10", { title: "شقة اختبار 120م للبيع — الحي العاشر", tx: "sale", location: "الحي العاشر - مدينة نصر", zone: "الحي العاشر", price: 3500000, area: 120, rooms: 2 }),
    P("test-sale-190-hayy10", { title: "شقة اختبار 190م للبيع — الحي العاشر", tx: "sale", location: "الحي العاشر - مدينة نصر", zone: "الحي العاشر", price: 5500000, area: 190, rooms: 3 }),
    P("test-rent-160-tayaran", { title: "شقة اختبار 160م للإيجار — شارع الطيران", tx: "rent", location: "شارع الطيران - مدينة نصر", zone: "شارع الطيران", price: 18000, area: 160, furnished: "unfurnished" }),
    P("test-rent-170-abbas", { title: "شقة اختبار 170م للإيجار — عباس العقاد", tx: "rent", location: "عباس العقاد - مدينة نصر", zone: "عباس العقاد", price: 25000, area: 170, furnished: "furnished" }),
    P("test-rent-140-hayy7", { title: "شقة اختبار 140م للإيجار — الحي السابع", tx: "rent", location: "الحي السابع - مدينة نصر", zone: "الحي السابع", price: 15000, area: 140, rooms: 2 }),
    P("test-shop-rent-60", { title: "محل اختبار 60م للإيجار — عباس العقاد", tx: "rent", type: "shop", location: "عباس العقاد - مدينة نصر", zone: "عباس العقاد", price: 12000, area: 60, rooms: 0 }),
    P("test-archive-rehab", { title: "شقة أرشيف اختبار للبيع — الرحاب", tx: "sale", location: "الرحاب", zone: "الرحاب", price: 6000000, area: 180, extra: { in_nasr_city: false, scope: "archive" } }),
  ],
};

// ───────── fetch وهمي ─────────
export const calls = { gemini: [], feed: 0, unexpected: [] };
let responder = null;
let realFetch = null;
// رد Gemini ناجح بـJSON منظم (نفس شكل generateContent)
export function geminiOk(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
export const geminiStatus = status => new Response(JSON.stringify({ error: { code: status } }), { status, headers: { "Content-Type": "application/json" } });
export function abortError() { const e = new Error("The operation was aborted"); e.name = "AbortError"; return e; }
export function reply(text, patch = {}, extra = {}) { return { intent: "unclear", needs_clarification: false, patch, reply: text, ...extra }; }

export function installChatMock({ feed = FEED, feedStatus = 200 } = {}) {
  realFetch = globalThis.fetch;
  responder = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("ai-feed.json")) {
      calls.feed += 1;
      return new Response(JSON.stringify(feed), { status: feedStatus, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(init.body);
      const call = { url, model: url.split("/models/")[1]?.split(":")[0], headers: init.headers, system: body?.system_instruction?.parts?.[0]?.text || "", contents: body?.contents || [], generationConfig: body?.generationConfig || {}, raw: init.body };
      calls.gemini.push(call);
      // زي fetch الحقيقي: لو الطلب اتلغى (مهلة/طلب احتياطي سبق) الوعد بيترفض بـAbortError فورًا
      const pending = Promise.resolve(responder ? responder(call, calls.gemini.length) : reply("تمام."));
      let r;
      if (init.signal) {
        if (init.signal.aborted) throw abortError();
        r = await Promise.race([pending, new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(abortError()), { once: true }))]);
      } else r = await pending;
      if (r instanceof Error) throw r;
      if (r instanceof Response) return r;
      return geminiOk(r);
    }
    calls.unexpected.push(url);
    throw new Error(`Unexpected external fetch in test: ${url}`);
  };
}
export function onGemini(fn) { responder = fn; }
export function restoreChatMock() { if (realFetch) globalThis.fetch = realFetch; realFetch = null; responder = null; }
export function resetCalls() { calls.gemini.length = 0; calls.feed = 0; calls.unexpected.length = 0; }

// env فيه مصائد: أي لمس لـD1 أو KV أو ImgBB يتسجّل (المحادثة ممنوع تلمسهم)
export function trappedEnv(over = {}) {
  const touched = [];
  const trap = name => new Proxy({}, { get(_t, prop) { touched.push(`${name}.${String(prop)}`); throw new Error(`${name} must not be used by /chat`); } });
  const env = { ...TEST_ENV, DB: trap("DB"), PUSH_SUBS: trap("PUSH_SUBS"), ...over };
  Object.defineProperty(env, "IMGBB_API_KEY", { get() { touched.push("IMGBB_API_KEY"); return "imgbb-test"; }, enumerable: true });
  return { env, touched };
}

// بيئة الاختبار: من غير مهلة الإعادة الحقيقية (700ms) عشان السويت تفضل سريعة — الإعادة نفسها متختبرة
export const TEST_ENV = Object.freeze({ GEMINI_API_KEY: "test-key", CHAT_RETRY_BACKOFF_MS: "0" });
let seq = 0;
export const nextIp = () => `chat-ip-${++seq}`;
export async function chatRequest(body, { env, ip, headers = {}, method = "POST", raw } = {}) {
  const init = { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip ?? nextIp(), ...headers } };
  if (method !== "GET" && method !== "OPTIONS") init.body = raw ?? JSON.stringify(body);
  const res = await agentWorker.fetch(new Request("https://agent.test/chat", init), env ?? TEST_ENV);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, json };
}

// محادثة كاملة زي المتصفح: الحالة + آخر الرسائل في الذاكرة، والموافقة مع كل طلب
export class Conversation {
  constructor({ env, state = null, history = [] } = {}) {
    this.env = env ?? TEST_ENV;
    this.state = state;
    this.history = history;
    this.turns = [];
  }
  async say(message, geminiResponse, extraBody = {}) {
    if (geminiResponse !== undefined) onGemini(typeof geminiResponse === "function" ? geminiResponse : () => geminiResponse);
    const before = calls.gemini.length;
    const res = await chatRequest({ consent: "gemini-v1", message, state: this.state, history: this.history.slice(-10), ...extraBody }, { env: this.env });
    const turn = { message, status: res.status, json: res.json, gemini: calls.gemini.slice(before) };
    this.turns.push(turn);
    if (res.status === 200 && res.json?.ok) {
      this.state = res.json.state;
      this.history.push({ role: "user", text: message }, { role: "assistant", text: res.json.reply });
    }
    return turn;
  }
}
