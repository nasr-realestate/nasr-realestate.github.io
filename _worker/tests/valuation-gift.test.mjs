// هدية التقييم 💎 من أول خطوة لحد رسالة الواتساب — الـWorkers الاتنين حقيقيين (D1 وهمي) وصفحتي agent.html و tools/valuation.html
// بيشتغلوا بنفس الـscripts بتاعتهم تحت node:vm:
//   Worker الوكيل → زر 💎 (agent.html) → صفحة التقييم → Worker التقييم → رابط الرجوع → agent.html → Worker الوكيل
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import agentWorker from "../worker.js";
import valuationWorker from "../valuation-worker.js";
import { makeDb } from "./_fixtures.mjs";
import {
  ADDRESS, GPS, ORIGIN, agentPost, driveOwnerToGift, finishOwnerFlow, gemini, installFetchMock, nextIp, resetGemini, restoreFetch,
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
  assert.match(backAgain.json.response, /في أي تفاصيل مهمة تانية/);
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

// ───────── الرحلة كاملة ─────────

test("end to end: Worker → 💎 button → valuation page → valuation Worker → back link → agent → announcement → WhatsApp lead", async () => {
  // ١) الوكيل بيوصّل المالك لخطوة الهدية (ومعاه دبوس الخريطة)
  const gift = await driveOwnerToGift({ withGps: true });
  const cta = gift.json.valuationCta;

  // ٢) agent.html بيستقبل نفس الرد (من غير ما نألّف ردود): بيرسم الزر ويحفظ الجلسة من غير الـGPS
  const agentBefore = bootAgent({ runTimers: true, fetchImpl: async () => new Response(JSON.stringify(gift.json), { status: 200 }) });
  await send(agentBefore, "لا");
  const button = agentBefore.chatArea.querySelector(".valuation-link");
  assert.ok(button, "the 💎 button is on screen");
  assert.equal(button.href, agentBefore.run(`buildValuationHref(${JSON.stringify(cta)})`));
  button.dispatch("click");
  const savedSession = agentBefore.sessionStorage.getItem("simsar_return_session");
  assert.ok(savedSession, "the chat is saved so the user can come back to it");
  for (const secret of [GPS.address, "30.06263", "31.32195"]) {
    assert.equal(savedSession.includes(secret), false, `${secret} is never stored`);
    assert.equal(agentBefore.sessionStorage.getItem("simsar_wa_v92").includes(secret), false);
  }

  // ٣) صفحة التقييم: بتفتح من الزر، بتعرف المنطقة من العنوان المكتوب، وبتنادي Worker التقييم الحقيقي مرة واحدة
  const posts = [];
  const valuationEnv = { DB: makeDb() };
  const valuationPage = createPageContext({
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (init.method === "POST") posts.push(JSON.parse(init.body));
      if (u.startsWith("https://noisy-bush-fd84.footcai-555.workers.dev/")) {
        return valuationWorker.fetch(new Request(u, { method: init.method || "GET", headers: init.headers, body: init.body }), valuationEnv);
      }
      return new Response(JSON.stringify({ properties: [] }), { status: 200 });
    },
  });
  valuationPage.window.location.search = new URL(button.href, BASE).search;
  await valuationPage.boot();
  await waitFor(() => valuationPage.el("result").classList.contains("show"), { label: "valuation result" });
  assert.equal(valuationPage.el("area").value, "المنطقة السادسة", "the district is read out of the typed address");
  assert.equal(valuationPage.el("size").value, "180");
  assert.equal(valuationPage.el("propertyType").value, "شقة");
  assert.equal(valuationPage.el("floor").value, "ثالث");
  assert.equal(valuationPage.el("askingPrice").value, "9,500,000");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { area: "المنطقة السادسة", areaType: "sale", propertyType: "شقة", size: 180, finishing: "سوبر لوكس", floor: "ثالث", age: "medium" });
  assert.equal(valuationPage.el("estimate").textContent, "9,360,000");
  assert.equal(valuationPage.el("fallbackNotice").classList.contains("show"), false);
  const backHref = valuationPage.el("backToAgentBtn").href;
  assert.equal(valuationPage.el("backToAgentBtn").style.display, "flex");

  // ٤) رجوع للوكيل: البانر بنفس أرقام الـWorker، والمحادثة متكمّلة من نفس الخطوة
  const calls = [];
  const agentAfter = bootAgent({
    runTimers: true,
    search: new URL(backHref, BASE).search,
    session: { simsar_return_session: savedSession },
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return agentWorker.fetch(new Request("https://agent.test/", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": nextIp() }, body: init.body,
      }), { GEMINI_API_KEY: "test-key" });
    },
  });
  const banner = agentAfter.messages().at(-1).innerHTML;
  assert.match(banner, /<strong>9,360,000 ج\.م<\/strong>/);
  assert.match(banner, /📍 المنطقة السادسة • 180 م²/);
  assert.match(banner, /📊 النطاق \(P25–P75\): 46,000 – 58,000 ج\.م\/م²/);
  assert.match(banner, /📏 سعر المتر \(الوسيط\): 52,000/);
  assert.match(banner, /🎯 الثقة: عالية \(41 عينة\)/);
  assert.equal(agentAfter.run("state.formState.stepIndex"), gift.json.formState.stepIndex);

  // ٥) أول رسالة بعد الرجوع: الـWorker بيعلن التقييم مرة واحدة وبعدين بيكمّل بالسؤال التالي
  resetGemini();
  await send(agentAfter, SKIP);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].valuationResult.estimate, 9360000);
  const announcement = lastBotText(agentAfter);
  assert.match(announcement, /تمام، شفت نتيجة التقييم 👌/);
  assert.match(announcement, /💰 السعر التقديري: 9,360,000 ج\.م/);
  assert.match(announcement, /📊 النطاق الأساسي: 8,280,000 – 10,440,000 ج\.م/);
  assert.match(announcement, /🟢 عينة قوية — مؤشر موثوق نسبيًا/);
  assert.match(announcement, /اسم حضرتك إيه؟/);
  assert.equal(agentAfter.chatArea.querySelectorAll(".valuation-link").length, 0, "the button is gone once the step is done");
  assert.equal(agentAfter.sessionStorage.getItem("simsar_return_session"), null);

  // ٦) باقي التسجيل: الاسم والرقم والصور — واللي يتبعت لطارق فيه القسم الموسوم بنفس الأرقام
  await send(agentAfter, "أحمد");
  await send(agentAfter, "01512345678");
  assert.equal(calls.at(-1).valuationResult, null, "the valuation is not re-sent after the first message");
  await send(agentAfter, "⏭ تخطي (بدون صور)");
  const wa = agentAfter.run("state.waMessage");
  assert.match(wa, SECTION);
  assert.match(wa, /💰 السعر التقديري: 9,360,000 ج\.م/);
  assert.match(wa, /📏 سعر المتر: 52,000 ج\.م/);
  assert.match(wa, /📊 نطاق المتر \(P25–P75\): 46,000 – 58,000 ج\.م/);
  assert.match(wa, /🧪 العينات: 41/);
  assert.match(wa, /9,500,000/, "the owner's own asking price stays in the property details");
  for (const secret of ["30.06263", "31.32195", "Ibrahim Nawara"]) assert.equal(wa.includes(secret), false, "no GPS text in the lead");
  assert.equal(gemini.length, 0, "the model is never involved in showing the valuation");
  assert.ok(agentAfter.run("state.whatsappUrl").startsWith("https://wa.me/"));
});

test("end to end (rent): a furnished-rent owner gets the furnished snapshot, labelled as rent per month", async () => {
  const gift = await driveOwnerToGift({ rent: true, furnished: true, withGps: false, locationMessage: "المنطقة السادسة شارع عباس العقاد" });
  const agentBefore = bootAgent({ runTimers: true, fetchImpl: async () => new Response(JSON.stringify(gift.json), { status: 200 }) });
  await send(agentBefore, "لا");
  const button = agentBefore.chatArea.querySelector(".valuation-link");
  assert.deepEqual(Object.fromEntries(new URL(button.href, BASE).searchParams), {
    from: "agent", journey: "seller", area: "6th-district", size: "180", type: "apartment", deal: "rent", furnished: "yes", floor: "3", price: "9000",
  });
  const posts = [];
  const page = createPageContext({
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") posts.push(JSON.parse(init.body));
      if (String(url).startsWith("https://noisy-bush-fd84.footcai-555.workers.dev/")) {
        return valuationWorker.fetch(new Request(String(url), { method: init.method || "GET", headers: init.headers, body: init.body }), { DB: makeDb() });
      }
      return new Response(JSON.stringify({ properties: [] }), { status: 200 });
    },
  });
  page.window.location.search = new URL(button.href, BASE).search;
  await page.boot();
  await waitFor(() => page.el("result").classList.contains("show"), { label: "rent result" });
  assert.equal(posts[0].areaType, "rent");
  assert.equal(posts[0].rentCondition, "furnished");
  assert.equal(page.el("estimate").textContent, "93,600", "520 × 180 from the furnished snapshot");
  const link = new URL(page.el("backToAgentBtn").href, BASE);
  assert.equal(link.searchParams.get("areaType"), "rent");

  const agentAfter = bootAgent({
    runTimers: true,
    search: link.search,
    session: { simsar_return_session: (agentBefore.chatArea.querySelector(".valuation-link").dispatch("click"), agentBefore.sessionStorage.getItem("simsar_return_session")) },
    fetchImpl: async (url, init) => agentWorker.fetch(new Request("https://agent.test/", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": nextIp() }, body: init.body,
    }), { GEMINI_API_KEY: "test-key" }),
  });
  assert.match(agentAfter.messages().at(-1).innerHTML, /<strong>93,600 ج\.م \/ شهريًا<\/strong>/);
  await send(agentAfter, SKIP);
  const text = lastBotText(agentAfter);
  assert.match(text, /💎 \*تقييم عقارك للإيجار:\*/);
  assert.match(text, /💰 الإيجار التقديري: 93,600 ج\.م \/ شهريًا/);
});
