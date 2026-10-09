// تكامل بيانات السوق: الـWorker (D1) هو المصدر الوحيد للأرقام — الصفحة والوكيل بيعرضوها وبينقلوها بس.
//
// خريطة الاختبارات الخمسة القديمة → الجديدة (الملف القديم كان بيستورد _worker/market-data.js الميّت واتشال):
//   #1 «D1 keeps المنطقة الأولى separate from الحي الأول and resolves explicit area aliases»        → M1
//   #2 «D1 valuation uses avg/median and real min/max; no apartment substitution…»                 → M2  (الوسيط بس، من غير fallback للمتوسط)
//   #3 «valuation Worker serves D1 areas on /areas and D1 estimates on /api»                        → M3  (عقد v2 + MARKET_UNAVAILABLE 503)
//   #4 «agent valuation CTA is separate from buyer/owner qualification and preserves seller context» → M4  (الوكيل ما بيقتبسش أسعار؛ الزر 💎 في خطوة الهدية بس)
//   #5 «current listings remain sourced from ai-feed when the D1 snapshot is missing»                → M5  (الوحدات المشابهة من ai-feed في الصفحة، مفيش رقم بديل)
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import valuationWorker from "../valuation-worker.js";
import { ID, makeDb, snap, valuationPost } from "./_fixtures.mjs";
import {
  ADDRESS, agentPost, driveOwnerToGift, gemini, geminiText, installFetchMock, qualifiedOwnerState, resetGemini, restoreFetch,
} from "./_agent-harness.mjs";
import { createPageContext, textOf } from "./_dom-page.mjs";

const FEED = {
  properties: [{
    id: "feed-unit-1", title: "شقة معروضة في الحي الأول", zone: "الحي الأول", transaction: "sale", propertyType: "apartment",
    areaNumeric: 175, priceNumeric: 6200000, url: "https://nasr-realestate.github.io/properties/feed-unit-1.html",
  }],
};
before(() => installFetchMock({ feed: FEED }));
after(() => restoreFetch());

// لقطات مخترعة للاختبار فقط (مش بيانات D1 الحقيقية)
const rows = () => [
  snap(ID.zone1, { median: 50000, p25: 45000, p75: 55000, min: 40000, max: 65000, n: 12 }),
  snap(ID.makram, { median: 42000, p25: 40000, p75: 45000, min: 38000, max: 47000, n: 7 }),
  snap(ID.zone1, { tx: "rent", cond: "furnished", median: 1200, p25: 1000, p75: 1500, min: 900, max: 1800, n: 8 }),
  snap(ID.hayy1, { tx: "rent", cond: null, median: 900, p25: 800, p75: 1100, min: 700, max: 1300, n: 5 }),
];
const post = (body, r = rows()) => valuationPost(valuationWorker, body, { DB: makeDb({ rows: r }) });
const REQ = { area: "المنطقة الأولى", areaType: "sale", propertyType: "شقة", size: 100 };

test("M1 [was #1]: المنطقة الأولى stays separate from الحي الأول; the page resolves aliases, the Worker accepts official names only", async () => {
  const get = await valuationWorker.fetch(new Request("https://worker.test/areas"), { DB: makeDb() });
  const names = (await get.json()).available_areas.map(a => a.name);
  assert.equal(names[0], "مدينة نصر (ككل)");
  assert.ok(names.includes("المنطقة الأولى") && names.includes("الحي الأول"));
  assert.notEqual(names.indexOf("المنطقة الأولى"), names.indexOf("الحي الأول"));

  const page = createPageContext();
  page.run(`AREAS = ${JSON.stringify(names)}`);
  const find = text => page.run(`findAvailableArea(${JSON.stringify(text)})`);
  assert.equal(find("المنطقة الأولى"), "المنطقة الأولى");
  assert.equal(find("المنطقة الاولي"), "المنطقة الأولى");
  assert.equal(find("الحي الاول"), "الحي الأول");
  assert.notEqual(find("المنطقة الأولى"), find("الحي الأول"));
  assert.equal(find("مكرم عبيد"), "ممر مكرم عبيد");
  assert.equal(find("عباس العقاد"), "ممر عباس العقاد");
  assert.equal(find("حي السفارات"), "الحي الدبلوماسي");
  assert.equal(page.run(`findAreaMention(${JSON.stringify(ADDRESS)})`), "المنطقة السادسة");

  // الـWorker بيطابق الاسم الرسمي (بتطبيع الهمزات/الياء) ومبيخمّنش: اسم الشهرة مرفوض ومعاه القائمة
  const first = await post(REQ);
  const hayy = await post({ ...REQ, area: "الحي الأول" }, [snap(ID.hayy1, { median: 38000, p25: 34000, p75: 42000, n: 9 })]);
  assert.equal(first.body.area_found, "المنطقة الأولى");
  assert.equal(first.body.area_id, ID.zone1);
  assert.equal(hayy.body.area_found, "الحي الأول");
  assert.equal(hayy.body.area_id, ID.hayy1);
  assert.equal((await post({ ...REQ, area: "المنطقة الاولي" })).body.area_found, "المنطقة الأولى");
  assert.equal((await post({ ...REQ, area: "ممر مكرم عبيد" })).body.area_found, "ممر مكرم عبيد");
  const alias = await post({ ...REQ, area: "مكرم عبيد" });
  assert.equal(alias.status, 400);
  assert.equal(alias.body.code, "AREA_NOT_FOUND");
  assert.ok(alias.body.available_areas.some(a => a.name === "ممر مكرم عبيد"), "the error carries the list so the client can recover");
  assert.equal("estimate" in alias.body, false);
  for (const type of ["شقة", "شقه", "apartment", "Apartment"]) assert.equal((await post({ ...REQ, propertyType: type })).body.property_type, "apartment", type);
});

test("M2 [was #2]: the median is the only central value (no average fallback), min/max are real bounds, nothing is substituted", async () => {
  const ok = await post(REQ);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.price_basis, "median_price_m2");
  assert.equal(ok.body.estimate, 5000000);
  assert.equal(ok.body.price_per_meter, 50000);
  assert.deepEqual(ok.body.range, { low: 4500000, high: 5500000 });
  assert.deepEqual(ok.body.price_per_m2_range, { low: 45000, high: 55000 });
  assert.deepEqual(ok.body.market_bounds, { min_price_per_m2: 40000, max_price_per_m2: 65000, min_value: 4000000, max_value: 6500000 });
  assert.equal(ok.body.sample_count, 12);
  assert.equal(ok.body.fallback_used, false);
  assert.equal((await post({ ...REQ, size: 150 })).body.estimate, 7500000, "the total is exactly median × size");

  const makram = await post({ ...REQ, area: "ممر مكرم عبيد" });
  assert.equal(makram.body.area_found, "ممر مكرم عبيد");
  assert.equal(makram.body.price_basis, "median_price_m2");
  assert.equal(makram.body.estimate, 4200000);

  // مفيش fallback للمتوسط ولا مدى مخترع: لقطة من غير وسيط أو من غير P25/P75 = مفيش تقييم
  const avgOnly = await post(REQ, [snap(ID.zone1, { median: null, min: 45000, max: 55000, n: 12, extra: { avg_price_m2: 50000 } })]);
  assert.equal(avgOnly.status, 503);
  assert.equal(avgOnly.body.code, "MARKET_UNAVAILABLE");
  assert.equal("estimate" in avgOnly.body, false);
  const noQuartiles = await post(REQ, [snap(ID.zone1, { median: 50000, min: 45000, max: 55000, n: 12 })]);
  assert.equal(noQuartiles.status, 503);
  assert.equal("estimate" in noQuartiles.body, false);

  // مفيش استبدال لنوع العقار: فيلا/محل مفيش لهم لقطة (لا في المنطقة ولا في المدينة) = 503 مش سعر شقة
  for (const propertyType of ["فيلا", "محل تجاري"]) {
    const none = await post({ ...REQ, propertyType });
    assert.equal(none.status, 503, propertyType);
    assert.equal("estimate" in none.body, false, propertyType);
  }
  // مفيش استبدال لحالة الإيجار: مفروش بس موجود ⇒ «غير مفروش» مرفوض، و«مفروش» أو غير المحدد بيرجعوا لقطة المفروش باسمها
  const rent = { ...REQ, areaType: "rent" };
  assert.equal((await post({ ...rent, rentCondition: "unfurnished" })).status, 503);
  const furnished = await post({ ...rent, rentCondition: "furnished" });
  assert.equal(furnished.status, 200);
  assert.equal(furnished.body.rent_condition, "furnished");
  assert.equal(furnished.body.estimate, 120000);
  const unspecified = await post({ ...rent, rentCondition: "unknown" });
  assert.equal(unspecified.body.rent_condition, "furnished", "what was used is reported, never hidden");
  assert.equal(unspecified.body.requested_rent_condition, null);
  const allConditions = await post({ ...rent, area: "الحي الأول" });
  assert.equal(allConditions.status, 200);
  assert.equal(allConditions.body.rent_condition, "all");
});

test("M3 [was #3]: the valuation Worker serves D1 areas on /areas and D1 estimates on /api (contract v2)", async () => {
  const env = { DB: makeDb({ rows: rows() }) };
  const get = await valuationWorker.fetch(new Request("https://worker.test/areas"), env);
  const getBody = await get.json();
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(getBody.available_areas));
  assert.equal(getBody.api_contract, "d1-price-snapshots-v2");
  assert.equal(getBody.data_source, "price_snapshots");
  assert.equal(getBody.version, "v6.2");
  assert.equal("database" in getBody, false);

  const { status, body } = await valuationPost(valuationWorker, REQ, env);
  assert.equal(status, 200);
  assert.equal(body.api_contract, "d1-price-snapshots-v2");
  assert.equal(body.source_table, "price_snapshots");
  assert.equal(body.estimate, 5000000);
  assert.equal(body.sample_count, 12);
  assert.equal(body.confidence, "medium");
  assert.equal(body.period, "2026-09");
  assert.equal(body.price_per_m2_range.low, 45000);

  const noSnapshot = await valuationPost(valuationWorker, { ...REQ, propertyType: "فيلا" }, env);
  assert.equal(noSnapshot.status, 503);
  assert.equal(noSnapshot.body.code, "MARKET_UNAVAILABLE");
  assert.equal("estimate" in noSnapshot.body, false);
  assert.ok(noSnapshot.body.available_areas.length > 0);

  const unknownType = await valuationPost(valuationWorker, { ...REQ, propertyType: "قصر" }, env);
  assert.equal(unknownType.status, 422);
  assert.equal(unknownType.body.code, "UNSUPPORTED_PROPERTY_TYPE");
  const { propertyType: _omitType, ...noType } = REQ;
  const missingType = await valuationPost(valuationWorker, noType, env);
  assert.equal(missingType.status, 400);
  assert.equal(missingType.body.code, "PROPERTY_TYPE_REQUIRED");
  const { areaType: _omitTx, ...noTx } = REQ;
  const missingTransaction = await valuationPost(valuationWorker, noTx, env);
  assert.equal(missingTransaction.status, 400);
  assert.equal(missingTransaction.body.code, "TRANSACTION_REQUIRED");
});

test("M4 [was #4]: the agent never quotes a price and never starts a valuation by itself; the 💎 button belongs to the owner's gift step and keeps the seller's context", async () => {
  const quote = /سعر المتر في بيانات D1|بيانات D1|التقييم السوقي/;
  // v9.2: أسئلة السعر والتحية بتتجاب حتمًا (من غير Gemini) — مفيش اقتباس أسعار، ومفيش CTA ولا واتساب، والقوائم/الأسعار اللي في ai-feed مش بتظهر
  for (const message of ["سعر المتر في المنطقة الأولى كام؟", "شقتي في المنطقة الأولى ١٨٠ متر تسوى كام؟", "السلام عليكم"]) {
    resetGemini();
    const { json } = await agentPost({ message, formState: {}, history: [] });
    assert.equal(gemini.length, 0, `${message}: deterministic reply, the model is not called`);
    assert.doesNotMatch(json.response, quote);
    assert.doesNotMatch(JSON.stringify(json), /6,?200,?000/, "feed prices never reach the reply");
    assert.equal(json.valuationCta, undefined, "no seller CTA before the gift step");
    assert.equal(json.whatsappUrl, undefined);
    assert.ok(!json.readyToSend, "nothing is marked ready to send");
  }
  // نية البيع بتبدأ تسجيل المالك من الأول (بدون ما نفترض أي بيانات من النص الحر) ومن غير زر تقييم في الخطوات العادية
  for (const message of ["عايز أبيع شقتي في المنطقة الأولى ١٨٠ متر", "أريد بيع شقتي في المنطقة الأولى ١٨٠ متر", "عايز أبيع شقتي في المنطقة الأولى ١٨٠ متر، تسوى كام؟"]) {
    const { json } = await agentPost({ message, formState: {}, history: [] });
    assert.equal(json.formState.flowType, "owner", message);
    // v9.2 بيستخرج اللي اتقال في النص (نوع/مساحة) ويكمل الأسئلة: أي قيمة مستخرجة لازم تطابق النص، ومفيش سعر متخيّل
    assert.ok(json.formState.data.area === undefined || json.formState.data.area === 180, message);
    assert.ok(json.formState.data.propertyType === undefined || json.formState.data.propertyType === "شقة", message);
    assert.equal(json.formState.data.price, undefined, "no price is invented from free text");
    assert.equal(json.valuationCta, undefined, "no CTA before the gift step");
    assert.equal(json.done, false);
    assert.equal(json.readyToSend, false);
    assert.equal(json.whatsappUrl, undefined);
    assert.doesNotMatch(json.response, quote);
  }
  // سؤال السعر وسط التسجيل مبيرجعش الخطوة ومبيبعتش حاجة لطارق، لا للمالك ولا للمشتري.
  // (الحالة دي بيانات الأساسية فيها مكتملة، فالـflow بيكمل لخطوة الهدية زي ما كان قبل v9.2 — ومعاها الـCTA الطبيعي بتاعها)
  const owner = qualifiedOwnerState({ stepIndex: 2 });
  const ownerQ = (await agentPost({ message: "الشقة بتاعتي تسوى كام؟", formState: owner, history: [] })).json;
  assert.equal(ownerQ.formState.flowType, "owner");
  assert.ok(ownerQ.formState.stepIndex >= 2, "a price question never rewinds the flow");
  assert.doesNotMatch(ownerQ.response, quote);
  assert.equal(ownerQ.whatsappUrl, undefined);
  assert.ok(!ownerQ.readyToSend, "nothing is sent by a price question");
  const buyerQ = (await agentPost({ message: "سعر المتر في المنطقة الأولى كام؟", formState: { ...owner, flowType: "buyer" }, history: [] })).json;
  assert.equal(buyerQ.formState.flowType, "buyer");
  assert.ok(buyerQ.formState.stepIndex >= 2, "a price question never rewinds the flow");
  assert.doesNotMatch(buyerQ.response, quote);
  assert.ok(!buyerQ.readyToSend, "a price question never completes or sends the request");
  assert.equal(buyerQ.whatsappUrl, undefined);

  // خطوة الهدية: الزر مع سياق البائع كامل، وما فيش إرسال لطارق
  const sale = (await driveOwnerToGift()).json;
  assert.deepEqual(sale.valuationCta, {
    // الرابط بيحمل اسم المنطقة المعيّن فقط، مش العنوان الشارع (حماية الخصوصية)
    intent: "seller", area: "المنطقة السادسة", size: 180, propertyType: "شقة", areaType: "sale", rentCondition: null, price: 9500000, floor: "ثالث", finishing: "سوبر لوكس",
  });
  assert.deepEqual(sale.options, ["تخطي السؤال ⏭", "⬅️ رجوع", "إلغاء التسجيل ✕"]);
  assert.equal(sale.readyToSend, false);
  assert.equal(sale.whatsappUrl, undefined);
  const rent = (await driveOwnerToGift({ rent: true, furnished: true })).json;
  assert.equal(rent.valuationCta.areaType, "rent");
  assert.equal(rent.valuationCta.rentCondition, "furnished");
  assert.equal(rent.valuationCta.price, 9000);
  assert.equal((await driveOwnerToGift({ rent: true, furnished: false })).json.valuationCta.rentCondition, "unfurnished");
});

test("M5 [was #5]: listing prices live in ai-feed and the page — a missing D1 snapshot never produces a substitute number", async () => {
  // الوكيل مبيقولش أسعار السوق ولا بيعرض أسعار من ai-feed حتى لو مفيش لقطة
  resetGemini();
  const { json } = await agentPost({ message: "في شقة معروضة للبيع في الحي الأول وسعر السوق كام؟", formState: {}, history: [] });
  assert.doesNotMatch(json.response, /لا توجد بيانات سوقية كافية|عقارات منشورة من المصدر الحالي|السعر المعروض|6,200,000/);
  assert.equal(json.whatsappUrl, undefined);
  assert.ok(!/6,?200,?000/.test(geminiText()));

  // الصفحة: مفيش لقطة ⇒ رسالة خطأ بالكود، ومفيش نتيجة ولا وحدات مشابهة ولا رقم بديل
  const routed = (db, feed) => async (url, init = {}) => {
    const u = String(url);
    if (u.includes("ai-feed.json")) return new Response(JSON.stringify(feed), { status: 200 });
    if (u.startsWith("https://noisy-bush-fd84.footcai-555.workers.dev/")) {
      return valuationWorker.fetch(new Request(u, { method: init.method || "GET", headers: init.headers, body: init.body }), { DB: db });
    }
    return new Response("{}", { status: 404 });
  };
  const noSnapshotPage = createPageContext({ fetchImpl: routed(makeDb({ rows: [] }), FEED) });
  await noSnapshotPage.run("loadAreas()");
  for (const [id, value] of Object.entries({ area: "الحي الأول", areaType: "sale", propertyType: "شقة", size: "175", finishing: "سوبر لوكس", floor: "ثالث", age: "medium", furnished: "unknown", askingPrice: "" })) noSnapshotPage.el(id).value = value;
  await noSnapshotPage.run("runValuation()");
  assert.match(noSnapshotPage.el("error-box").textContent, /\(رمز الخطأ: MARKET_UNAVAILABLE\)/);
  assert.equal(noSnapshotPage.el("result").classList.contains("show"), false);
  assert.equal(noSnapshotPage.run("lastResult"), null);
  assert.equal(noSnapshotPage.el("estimate").textContent, "");

  // ومع وجود لقطة: الوحدة المنشورة بتظهر بسعرها المعلن (مؤشر منفصل) من ai-feed بس
  const withSnapshot = createPageContext({ fetchImpl: routed(makeDb({ rows: [snap(ID.hayy1, { median: 38000, p25: 34000, p75: 42000, min: 30000, max: 48000, n: 9 })] }), FEED) });
  await withSnapshot.run("loadAreas()");
  await withSnapshot.run("loadSimilarProperties({ areaType: 'sale', size: 175 }, 'الحي الأول')");
  assert.equal(withSnapshot.el("similarGrid").children.length, 1);
  assert.match(textOf(withSnapshot.el("similarGrid").children[0]), /السعر المعلن: 6,200,000 ج\.م/);

  // الـWorker مبيقراش ai-feed ومبيعملش أي طلب خارجي — D1 بس
  const source = fs.readFileSync(new URL("../valuation-worker.js", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /ai-feed|market-data/);
  assert.doesNotMatch(code, /await\s+fetch\(|globalThis\.fetch|=\s*fetch\(|\.then\(/, "no outbound requests — D1 only");
});
