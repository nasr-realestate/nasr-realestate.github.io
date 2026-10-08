// Shared harness for black-box tests of the AGENT Worker (_worker/worker.js) — helper module, not a test file.
//
// الـWorker بيتجرّب من برّه عبر fetch handler الحقيقي (من غير أي export إضافي):
//  • fetch وهمي بيلتقط كل طلب رايح لـ Gemini (system prompt + contents) ويرد على ai-feed.json بقائمة اختبار.
//  • كل طلب بيبعت CF-Connecting-IP مختلف عشان حد المعدّل (15 / 30 ثانية) ما يتدخلش.
import agentWorker from "../worker.js";

export const ORIGIN = "https://nasr-realestate.github.io";
export const ADDRESS = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";
export const GPS = { lat: 30.06263, lng: 31.32195, address: "Ibrahim Nawara Street, Nasr City, Cairo, Egypt" };
// نصوص/أرقام ممنوع تظهر في أي طلب لـ Gemini (S-1)
export const SENSITIVE = ["30.06263", "31.32195", "Ibrahim Nawara", "إبراهيم نوارة", "صيدلية العزبي"];

export function goodValuation(over = {}) {
  return {
    estimate: 9360000, confidence: "high", samples: 41, perMeter: 52000, p25: 46000, p75: 58000,
    priceBasis: "median_price_m2", area: "المنطقة السادسة", size: 180, areaType: "sale",
    savedAt: Date.now(), ...over,
  };
}

// ───────── fetch وهمي ─────────
export const gemini = [];                 // كل عنصر: { system, contents, raw }
export const imgbb = [];                  // طلبات رفع الصور اللي وصلت لـ imgbb (الحقل image بس — مش الـkey)
let realFetch = null;
let currentReply = "-";                   // "-" = تعليق Gemini الاختياري ملغي فالرد الحتمي يفضل زي ما هو
export function setGeminiReply(text) { currentReply = text; }
export function installFetchMock({ feed = { properties: [] } } = {}) {
  realFetch = globalThis.fetch;
  currentReply = "-";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("ai-feed.json")) {
      return new Response(JSON.stringify(feed), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(init.body);
      gemini.push({ system: body?.system_instruction?.parts?.[0]?.text || "", contents: body?.contents || [], raw: init.body });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: currentReply }] } }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("api.imgbb.com")) {
      imgbb.push({ size: String(init.body?.get?.("image") || "").length });
      return new Response(JSON.stringify({ data: { url: `https://i.ibb.co/test/${imgbb.length}.png` } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected external fetch in test: ${url}`);
  };
}
export function restoreFetch() { if (realFetch) globalThis.fetch = realFetch; realFetch = null; }
export function resetGemini() { gemini.length = 0; imgbb.length = 0; }
export const geminiText = () => gemini.map(g => g.raw).join("\n");

// ───────── طلبات الـWorker ─────────
let seq = 0;
export const nextIp = () => `ip-${++seq}`;
export async function agentPost(body, { env, ip, headers = {} } = {}) {
  const response = await agentWorker.fetch(new Request("https://agent.test/", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip ?? nextIp(), ...headers },
    body: JSON.stringify(body),
  }), env ?? { GEMINI_API_KEY: "test-key" });
  return { status: response.status, json: await response.json() };
}
export function rawAgentRequest(path, init = {}, env) {
  return agentWorker.fetch(new Request(`https://agent.test${path}`, init), env ?? { GEMINI_API_KEY: "test-key" });
}

// ───────── حالة مالك مكتملة (مسار «ابعت البيانات دلوقتي ✅») — بتستخدم لاختبار valuationResult بسرعة ─────────
export function qualifiedOwnerState(over = {}) {
  return {
    active: true, lifecycle: "active", type: "sale", stepIndex: 0, flowType: "owner", awaitingQ: true, imageUrls: [], _version: "v92",
    data: {
      propertyType: "شقة", location: "المنطقة السادسة - شارع عباس العقاد", area: 180, price: 9500000, rooms: "3", baths: "2",
      floor: "ثالث", finishing: "سوبر لوكس", notes: "لا", ownerName: "أحمد محمد", ownerPhone: "01012345678",
    },
    ...over,
  };
}
export const SEND_NOW = "ابعت البيانات دلوقتي ✅";
export async function completeWithValuation(valuationResult, state = qualifiedOwnerState()) {
  return agentPost({ message: SEND_NOW, formState: structuredClone(state), history: [], valuationResult });
}

// ───────── مسار المالك الكامل لحد خطوة هدية التقييم ─────────
const ANSWERS = [
  [/العقار شقة ولا فيلا/, () => "شقة"],
  [/العقار فين بالضبط/, o => o.locationMessage],
  [/المساحة كام/, () => "180"],
  [/السعر المطلوب كام|الإيجار الشهري كام/, o => o.price],
  [/عدد الغرف/, () => "3"],
  [/عدد الحمامات/, () => "2"],
  [/الدور الكام/, () => "ثالث"],
  [/التشطيب/, () => "سوبر لوكس"],
  [/مفروش ولا فاضي/, o => (o.furnished ? "مفروش" : "فاضي (قانون جديد)")],
  [/مدة العقد/, () => "سنة"],
  [/المدة المطلوبة/, () => "شهري"],
  [/مستوى الأثاث/, () => "جيد"],
  [/تفاصيل مهمة/, () => "لا"],
];
export async function driveOwnerToGift({ rent = false, furnished = true, withGps = true, locationMessage = ADDRESS, post = agentPost } = {}) {
  const opts = { price: rent ? "9000" : "9500000", furnished, locationMessage };
  let r = await post({ message: rent ? "🔑 أأجر" : "💰 أبيع", formState: {}, history: [] });
  for (let i = 0; i < 30 && !r.json.valuationCta; i += 1) {
    const q = r.json.response || "";
    const hit = ANSWERS.find(([re]) => re.test(q));
    if (!hit) throw new Error(`driveOwnerToGift: no scripted answer for: ${q.slice(0, 80)}`);
    const message = hit[1](opts);
    const isLocation = /العقار فين بالضبط/.test(q);
    r = await post({ message, formState: r.json.formState, history: [], ...(isLocation && withGps ? { gps: GPS } : {}) });
  }
  if (!r.json.valuationCta) throw new Error("driveOwnerToGift: gift step never reached");
  return r;
}
// يكمل بعد الهدية: اسم → موبايل → تخطي الصور (بيرجع آخر رد = رد الإتمام)
export async function finishOwnerFlow(formState, { phone = "01512345678", post = agentPost } = {}) {
  let r = await post({ message: "أحمد", formState, history: [] });
  r = await post({ message: phone, formState: r.json.formState, history: [] });
  r = await post({ message: "⏭ تخطي (بدون صور)", formState: r.json.formState, history: [] });
  return r;
}
