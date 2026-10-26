// هدية التقييم 💎 — الـWorkers الاتنين حقيقيين (D1 وهمي) وصفحتي agent.html و tools/valuation.html
// بيشتغلوا بنفس الـscripts بتاعتهم تحت node:vm:
//   • خطوة الهدية في المسار القديم POST / (formState) — باقي في الـWorker للتوافق.
//   • الرحلة الكاملة للصفحة الجديدة: /chat (Gemini وهمي) → زر 💎 → صفحة التقييم → Worker التقييم → رابط الرجوع → /chat
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import agentWorker from "../worker.js";
import valuationWorker from "../valuation-worker.js";
import { makeDb } from "./_fixtures.mjs";
import {
  ADDRESS, GPS, ORIGIN, agentPost, driveOwnerToGift, finishOwnerFlow, gemini, installFetchMock, nextIp, resetGemini, restoreFetch, setGeminiReply,
} from "./_agent-harness.mjs";
import { bootAgent } from "./_dom-agent.mjs";
import { createPageContext, waitFor } from "./_dom-page.mjs";

before(() => installFetchMock());
after(() => restoreFetch());

const BASE = "https://nasr-realestate.github.io";
const SKIP = "تخطي السؤال ⏭";
const GIFT_OPTIONS = [SKIP, "⬅️ رجوع", "إلغاء التسجيل ✕"];
const SECTION = /💎 \*التقييم السوقي \(استرشادي\):\*/;
const send = async (a, text) => { a.el("msgInput").value = text; await a.run("sendMsg()"); };
const lastBotText = a => a.run("state.history.filter(m => m.role === 'assistant').at(-1).message");

// ───────── خطوة الهدية في الـWorker ─────────

test("the gift step comes after the basic data and before the personal data, for owners only, and carries the seller's context", async () => {
  const sale = await driveOwnerToGift();
  assert.match(sale.json.response, /💎 \*هدية مننا:\*/);
  assert.match(sale.json.response, /\(10\/13\)$/, "10th of 13: after the 9 data questions, before name and phone");
  assert.deepEqual(sale.json.options, GIFT_OPTIONS);
  assert.equal(sale.json.valuationCta.intent, "seller");
  assert.equal(sale.json.valuationCta.area, "المنطقة السادسة", "the CTA carries the canonical district, never the street address");
  assert.equal(sale.json.valuationCta.size, 180);
  assert.equal(sale.json.valuationCta.areaType, "sale");
  assert.equal(sale.json.valuationCta.rentCondition, null);
  assert.equal(sale.json.readyToSend, false);
  assert.equal(sale.json.whatsappUrl, undefined, "nothing is sent to Tarek at the gift step");

  const rentFurnished = await driveOwnerToGift({ rent: true, furnished: true });
  assert.equal(rentFurnished.json.valuationCta.areaType, "rent");
  assert.equal(rentFurnished.json.valuationCta.rentCondition, "furnished");
  assert.equal(rentFurnished.json.valuationCta.price, 9000);
  const rentEmpty = await driveOwnerToGift({ rent: true, furnished: false });
  assert.equal(rentEmpty.json.valuationCta.rentCondition, "unfurnished");

  // المشتري/المستأجر مفيش عندهم هدية ولا زر في أي خطوة
  let r = await agentPost({ message: "🔍 أشتري", formState: {}, history: [] });
  for (let i = 0; i < 12 && !r.json.done; i += 1) {
    assert.equal(r.json.valuationCta, undefined, `buyer step ${i}`);
    assert.doesNotMatch(r.json.response, /هدية مننا/);
    const q = r.json.response;
    const choice = (r.json.options || []).find(o => !/رجوع|تخطي|ابعت|إلغاء|طلب جد/.test(o));
    const message = /ميزانيتك/.test(q) ? "5000000" : /اسم/.test(q) ? "محمد" : /موبايل|رقم/.test(q) ? "01012345678" : choice || "المنطقة السادسة";
    r = await agentPost({ message, formState: r.json.formState, history: [] });
  }
  assert.equal(r.json.done, true);
});

test("skipping, going back and typing: the gift never traps the owner or loses progress", async () => {
  const gift = await driveOwnerToGift();
  const stepIndex = gift.json.formState.stepIndex;

  const skipped = await agentPost({ message: SKIP, formState: gift.json.formState, history: [] });
  assert.match(skipped.json.response, /^اسم حضرتك إيه؟/);
  assert.equal(skipped.json.valuationCta, undefined, "the button goes away with the step");
  assert.equal(skipped.json.formState.data.valuation, undefined);

  const back = await agentPost({ message: "⬅️ رجوع", formState: skipped.json.formState, history: [] });
  assert.equal(back.json.formState.stepIndex, stepIndex, "back from the name step returns to the gift");
  assert.ok(back.json.valuationCta, "…with its button");

  const backAgain = await agentPost({ message: "⬅️ رجوع", formState: gift.json.formState, history: [] });
  assert.match(backAgain.json.response, /في تفصيلة مهمة عن العقار|سنة البناء التقريبية/);
  assert.equal(backAgain.json.valuationCta, undefined);

  // أي كلام عادي على خطوة الهدية = كمّل (مفيش حاجة بتتعلّق)
  for (const text of ["لا", "كمّل", "تمام"]) {
    const next = await agentPost({ message: text, formState: gift.json.formState, history: [] });
    assert.match(next.json.response, /^اسم حضرتك إيه؟/, text);
    assert.equal(next.json.formState.stepIndex, stepIndex + 1);
  }

  // طلب التقييم صراحةً على خطوة الهدية = نفس الهدية بزرها (مش «ابدأ تسجيل» ومش قايمة الأزرار الرئيسية)
  resetGemini();
  const asked = await agentPost({ message: "عايز اشوف التقييم", formState: gift.json.formState, history: [] });
  assert.equal(asked.json.formState.stepIndex, stepIndex);
  assert.deepEqual(asked.json.valuationCta, gift.json.valuationCta, "the button survives");
  assert.deepEqual(asked.json.options, GIFT_OPTIONS);
  assert.match(asked.json.response, /💎 \*هدية مننا:\*/);
  assert.doesNotMatch(asked.json.response, /ابدأ بـ/);
  assert.equal(gemini.length, 0);
});

test("once a valuation is stored, asking again re-announces it from the stored numbers — no Gemini and no recalculation", async () => {
  const gift = await driveOwnerToGift();
  const valuation = { estimate: 9360000, confidence: "high", samples: 41, perMeter: 52000, p25: 46000, p75: 58000, priceBasis: "median_price_m2", area: "المنطقة السادسة", size: 180, areaType: "sale" };
  const back = await agentPost({ message: SKIP, formState: gift.json.formState, history: [], valuationResult: valuation });
  assert.match(back.json.response, /تمام، شفت نتيجة التقييم 👌/);
  assert.match(back.json.response, /اسم حضرتك إيه؟/);
  resetGemini();
  const again = await agentPost({ message: "ممكن أشوف التقييم", formState: back.json.formState, history: [] });
  assert.match(again.json.response, /💰 السعر التقديري: 9,360,000 ج\.م/);
  assert.equal(gemini.length, 0);
  assert.equal(again.json.formState.stepIndex, back.json.formState.stepIndex, "the flow is where it was");
  assert.equal(again.json.formState.data.valuation.estimate, 9360000);
  // من غير تقييم محفوظ وفي خطوة تانية (مش الهدية): الرد الجاهز القديم زي ما هو (مفيش تغيير في السلوك العام)
  const midFlow = await agentPost({ message: "عايز اشوف التقييم", formState: (await agentPost({ message: "💰 أبيع", formState: {}, history: [] })).json.formState, history: [] });
  assert.match(midFlow.json.response, /التقييم متاح وأنت في مسار تسجيل عقار/);
});

test("skipping the gift leaves the lead exactly as before: no 💎 section, no Gemini call", async () => {
  const gift = await driveOwnerToGift({ withGps: false });
  const skipped = await agentPost({ message: SKIP, formState: gift.json.formState, history: [] });
  resetGemini();
  const done = await finishOwnerFlow(skipped.json.formState);
  assert.equal(done.json.done, true);
  assert.equal(done.json.readyToSend, true);
  assert.doesNotMatch(done.json.waMessage, SECTION);
  assert.equal(gemini.length, 0);
  assert.match(done.json.waMessage, /9,500,000/);
});

// ───────── الرحلة كاملة (2026-10-27: الصفحة بقت Gemini أولًا عبر POST /chat) ─────────
// خطوة الهدية فوق بتختبر المسار القديم POST / (باقي في الـWorker للتوافق). الرحلة دي بتختبر الصفحة الجديدة:
//   agent.html ⇄ Worker الحقيقي (/chat، Gemini وهمي) → زر 💎 → صفحة التقييم → Worker التقييم → رابط الرجوع → agent.html → /chat
const CONSENT = { simsar_gemini_consent_v1: "gemini-v1" };
const chatEnv = { GEMINI_API_KEY: "test-key" };
const geminiJson = (reply, patch = {}) => setGeminiReply(JSON.stringify({ intent: "offer_sell", needs_clarification: false, patch, reply }));
function chatFetch(calls) {
  return async (url, init) => {
    assert.equal(String(url), "https://royal-snow-ea32.footcai-555.workers.dev/chat", "the page talks to /chat only");
    calls.push(JSON.parse(init.body));
    return agentWorker.fetch(new Request("https://agent.test/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": nextIp() }, body: init.body,
    }), chatEnv);
  };
}
function valuationPageFor(href, posts) {
  const page = createPageContext({
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (init.method === "POST") posts.push(JSON.parse(init.body));
      if (u.startsWith("https://noisy-bush-fd84.footcai-555.workers.dev/")) {
        return valuationWorker.fetch(new Request(u, { method: init.method || "GET", headers: init.headers, body: init.body }), { DB: makeDb() });
      }
      return new Response(JSON.stringify({ properties: [] }), { status: 200 });
    },
  });
  page.window.location.search = new URL(href, BASE).search;
  return page;
}

test("end to end: /chat → 💎 button → valuation page → valuation Worker → back link → agent → the next Gemini turn carries the numbers once", async () => {
  // ١) المالك بيكتب بحرية؛ الـWorker الحقيقي بيبني الحالة، وزر 💎 بيظهر لما التفاصيل الأساسية تكتمل
  const calls = [];
  const agentBefore = bootAgent({ runTimers: true, local: CONSENT, fetchImpl: chatFetch(calls) });
  geminiJson("تمام، شقة 180 متر في المنطقة السادسة وطالب فيها 9.5 مليون. فيها كام أوضة؟",
    { role: "owner", operation: "sell", property_type: "apartment", location: "المنطقة السادسة", area_value: 180, price_value: 9500000, floor: "الدور التالت" });
  await send(agentBefore, "عندي شقة للبيع في المنطقة السادسة مساحتها 180 متر في الدور التالت وطالب 9.5 مليون");
  assert.equal(calls.length, 1);
  assert.equal(agentBefore.run("state.chat.price.value"), 9500000);
  const button = agentBefore.el("valuationSlot").querySelector(".valuation-link");
  assert.ok(button, "the 💎 button is on screen");
  assert.deepEqual(Object.fromEntries(new URL(button.href, BASE).searchParams), {
    from: "agent", journey: "seller", area: "6th-district", size: "180", type: "apartment", deal: "sale", floor: "3", price: "9500000",
  });
  assert.ok(agentBefore.el("waWrapper").classList.contains("show"), "an explicit WhatsApp action is offered");
  assert.match(decodeURIComponent(agentBefore.el("waBtn").href), /عندي عقار: بيع · شقة · المنطقة السادسة · مطلوب 9\.5 مليون · 180م/);
  button.dispatch("click");
  const savedSession = agentBefore.sessionStorage.getItem("simsar_return_session");
  assert.ok(savedSession, "the structured summary is kept for the round trip");
  assert.doesNotMatch(savedSession, /عندي شقة للبيع|فيها كام أوضة/, "no chat text is stored");

  // ٢) صفحة التقييم: بتفتح من الزر، وبتنادي Worker التقييم الحقيقي مرة واحدة
  const posts = [];
  const valuationPage = valuationPageFor(button.href, posts);
  await valuationPage.boot();
  await waitFor(() => valuationPage.el("result").classList.contains("show"), { label: "valuation result" });
  assert.equal(valuationPage.el("area").value, "المنطقة السادسة");
  assert.equal(valuationPage.el("size").value, "180");
  assert.equal(valuationPage.el("propertyType").value, "شقة");
  assert.equal(valuationPage.el("floor").value, "ثالث");
  assert.equal(valuationPage.el("askingPrice").value, "9,500,000");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { area: "المنطقة السادسة", areaType: "sale", propertyType: "شقة", size: 180, finishing: "سوبر لوكس", floor: "ثالث", age: "medium" });
  assert.equal(valuationPage.el("estimate").textContent, "9,360,000");
  const backHref = valuationPage.el("backToAgentBtn").href;

  // ٣) رجوع: البانر بأرقام الـWorker، والملخص المنظم راجع (من غير نص المحادثة)
  const agentAfter = bootAgent({ runTimers: true, local: CONSENT, search: new URL(backHref, BASE).search, session: { simsar_return_session: savedSession }, fetchImpl: chatFetch(calls) });
  const banner = agentAfter.messages().at(-1).innerHTML;
  assert.match(banner, /<strong>9,360,000 ج\.م<\/strong>/);
  assert.match(banner, /📍 المنطقة السادسة • 180 م²/);
  assert.match(banner, /📊 النطاق \(P25–P75\): 46,000 – 58,000 ج\.م\/م²/);
  assert.match(banner, /📏 سعر المتر \(الوسيط\): 52,000/);
  assert.match(banner, /🎯 الثقة: عالية \(41 عينة\)/);
  assert.equal(agentAfter.run("state.chat.role"), "owner");
  assert.equal(agentAfter.sessionStorage.getItem("simsar_return_session"), null, "the round-trip context is consumed");

  // ٤) أول رسالة بعد الرجوع: التقييم بيتبعت مرة واحدة كأرقام، وGemini بيشوفه، والرد بيعدّي فحص الأرقام
  resetGemini();
  geminiJson("المؤشر الاسترشادي 9.36 مليون، وسعرك المطلوب 9.5 مليون قريب منه. تحب نكمل بعدد الأوض؟");
  await send(agentAfter, "تمام، إيه رأيك في السعر؟");
  assert.equal(calls.at(-1).valuation.estimate, 9360000);
  assert.match(gemini.at(-1).system, /"estimate":9360000/);
  assert.ok(agentAfter.messages().some(m => m._classes.has("msg-ai") && /9\.36 مليون/.test(m.innerHTML)));
  await send(agentAfter, "3 غرف");
  assert.equal(calls.at(-1).valuation, undefined, "the valuation is not re-sent after the first message");
  assert.equal(gemini.length, 2, "one Gemini call per message");
});

test("end to end (rent): a furnished-rent owner gets the furnished snapshot, labelled as rent per month", async () => {
  const calls = [];
  const agentBefore = bootAgent({ runTimers: true, local: CONSENT, fetchImpl: chatFetch(calls) });
  setGeminiReply(JSON.stringify({ intent: "offer_lease", needs_clarification: false, reply: "تمام، شقة مفروشة 180 متر للإيجار بـ 9000 في الشهر. فيها كام أوضة؟",
    patch: { role: "owner", operation: "lease", property_type: "apartment", location: "المنطقة السادسة", area_value: 180, price_value: 9000, furnished: "furnished", floor: "الدور التالت" } }));
  await send(agentBefore, "عندي شقة مفروشة للإيجار في المنطقة السادسة 180 متر في الدور التالت وطالب 9000 جنيه في الشهر");
  const button = agentBefore.el("valuationSlot").querySelector(".valuation-link");
  assert.deepEqual(Object.fromEntries(new URL(button.href, BASE).searchParams), {
    from: "agent", journey: "seller", area: "6th-district", size: "180", type: "apartment", deal: "rent", furnished: "yes", floor: "3", price: "9000",
  });
  button.dispatch("click");
  const saved = agentBefore.sessionStorage.getItem("simsar_return_session");
  const posts = [];
  const page = valuationPageFor(button.href, posts);
  await page.boot();
  await waitFor(() => page.el("result").classList.contains("show"), { label: "rent result" });
  assert.equal(posts[0].areaType, "rent");
  assert.equal(posts[0].rentCondition, "furnished");
  assert.equal(page.el("estimate").textContent, "93,600", "520 × 180 from the furnished snapshot");
  const link = new URL(page.el("backToAgentBtn").href, BASE);
  assert.equal(link.searchParams.get("areaType"), "rent");

  const agentAfter = bootAgent({ runTimers: true, local: CONSENT, search: link.search, session: { simsar_return_session: saved }, fetchImpl: chatFetch(calls) });
  assert.match(agentAfter.messages().at(-1).innerHTML, /<strong>93,600 ج\.م \/ شهريًا<\/strong>/);
  setGeminiReply(JSON.stringify({ intent: "offer_lease", needs_clarification: false, reply: "المؤشر الاسترشادي للإيجار 93,600 شهريًا حسب أداة الموقع." }));
  await send(agentAfter, "طب والإيجار؟");
  assert.equal(calls.at(-1).valuation.areaType, "rent");
  assert.match(gemini.at(-1).system, /"deal":"rent"/);
});
