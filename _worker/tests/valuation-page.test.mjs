// tools/valuation.html — the page's inline script under node:vm, talking to the REAL valuation Worker (mock D1).
// الأرقام كلها بتيجي من الـWorker؛ الصفحة بتعرضها وبتنقلها بس (ومفيش حساب تقييم في الـHTML).
import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import valuationWorker from "../valuation-worker.js";
import { AREA_NAMES, makeDb, valuationPost } from "./_fixtures.mjs";
import { createPageContext, inlineScript, textOf, valuationHtml, waitFor } from "./_dom-page.mjs";

const WORKER_ORIGIN = "https://noisy-bush-fd84.footcai-555.workers.dev/";
const WHOLE = "مدينة نصر (ككل)";
const SIX = { area: "المنطقة السادسة", areaType: "sale", propertyType: "شقة", size: 180 };

// fetch للصفحة: طلبات الـWorker بتروح لـvaluation-worker.js الحقيقي، والباقي ملفات ثابتة
function routedFetch({ env = { DB: makeDb() }, feed = { properties: [] }, calls = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", body: init.body });
    if (u.startsWith(WORKER_ORIGIN)) {
      return valuationWorker.fetch(new Request(u, { method: init.method || "GET", headers: init.headers, body: init.body }), env);
    }
    if (u.includes("ai-feed.json")) return new Response(JSON.stringify(feed), { status: 200 });
    if (u.includes("market-data.json")) return new Response(JSON.stringify({ areas: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}
const BASE_FIELDS = { area: "المنطقة السادسة", areaType: "sale", propertyType: "شقة", size: "180", finishing: "سوبر لوكس", floor: "ثالث", age: "medium", furnished: "unknown", askingPrice: "" };
async function runValuationWith(page, fields = {}) {
  for (const [id, value] of Object.entries({ ...BASE_FIELDS, ...fields })) page.el(id).value = value;
  await page.run("runValuation()");
}
async function pageWithAreas(opts = {}) {
  const calls = opts.calls || [];
  const page = createPageContext({ fetchImpl: routedFetch({ ...opts, calls }) });
  assert.equal(await page.run("loadAreas()"), true);
  return { page, calls };
}
const workerResult = async (body, env = { DB: makeDb() }) => (await valuationPost(valuationWorker, body, env)).body;

// ═══════════ الاختبارات الستة الأصلية (محفوظة) ═══════════

test("page rejects valuation payloads that do not explicitly identify the D1 contract", () => {
  const { context } = createPageContext();
  assert.equal(vm.runInContext("isD1ValuationResponse({estimate: 7000000, data_source: 'local'})", context), false);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v1', source_table: 'price_snapshots', price_basis: 'avg_price_m2', price_per_meter: 42000})", context), true);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v1', source_table: 'price_snapshots', price_basis: 'local', price_per_meter: 42000})", context), false);
  // عقد v2 (الـWorker v6.2) مقبول بنفس الشروط، وأي عقد تاني مرفوض
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v2', source_table: 'price_snapshots', price_basis: 'median_price_m2', price_per_meter: 52000})", context), true);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v3', source_table: 'price_snapshots', price_basis: 'median_price_m2', price_per_meter: 52000})", context), false);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v2', source_table: 'other', price_basis: 'median_price_m2', price_per_meter: 52000})", context), false);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v2', source_table: 'price_snapshots', price_basis: 'median_price_m2', price_per_meter: 0})", context), false);
});

test("page resolves live D1 area names without conflating المنطقة الأولى and الحي الأول", () => {
  const { context } = createPageContext();
  vm.runInContext("AREAS = ['المنطقة الأولى','الحي الأول','الحي الدبلوماسي','ممر مكرم عبيد','ممر عباس العقاد','رابعة العدوية']", context);
  assert.equal(vm.runInContext("findAvailableArea('المنطقة الاولي')", context), "المنطقة الأولى");
  assert.equal(vm.runInContext("findAvailableArea('الحي الاول')", context), "الحي الأول");
  assert.notEqual(
    vm.runInContext("findAvailableArea('المنطقة الأولى')", context),
    vm.runInContext("findAvailableArea('الحي الأول')", context),
  );
  assert.equal(vm.runInContext("findAvailableArea('حي السفارات')", context), "الحي الدبلوماسي");
  assert.equal(vm.runInContext("findAvailableArea('مكرم عبيد')", context), "ممر مكرم عبيد");
  assert.equal(vm.runInContext("findAreaMention('ممر عباس العقاد 180 متر')", context), "ممر عباس العقاد");
  assert.equal(vm.runInContext("findAreaMention('رابعة العدوية')", context), "رابعة العدوية");
  assert.equal(vm.runInContext("feedPropertyMatchesArea({zone:'مدينة نصر - شارع مكرم عبيد'}, 'ممر مكرم عبيد')", context), true);
  assert.equal(vm.runInContext("feedPropertyMatchesArea({zone:'الحي الأول'}, 'المنطقة الأولى')", context), false);
});

test("legacy market JSON contributes area descriptions only, never price fields", async () => {
  const { context } = createPageContext();
  context.fetch = async () => new Response(JSON.stringify({ areas: [{
    name: "المنطقة الأولى", level_ar: "راقٍ", landmarks: ["جنينة مول"], main_streets: ["عباس العقاد"],
    sale: { apartment: { avg: 999999999 } }, data_source: "legacy price",
  }] }), { status: 200 });
  assert.equal(await vm.runInContext("loadAreaMetadata()", context), true);
  const metadata = vm.runInContext("AREA_METADATA[0]", context);
  assert.equal(metadata.name, "المنطقة الأولى");
  assert.deepEqual(Array.from(metadata.landmarks), ["جنينة مول"]);
  assert.equal("sale" in metadata, false);
  assert.equal("confidence" in metadata, false);
  assert.equal("data_source" in metadata, false);
});

test("agent query params prefill the canonical D1 area and seller context", () => {
  const { context, getElementById, window } = createPageContext();
  vm.runInContext("AREAS = ['المنطقة الأولى','الحي الأول','ممر مكرم عبيد']", context);
  window.location.search = "?from=agent&journey=seller&area=%D9%85%D9%83%D8%B1%D9%85+%D8%B9%D8%A8%D9%8A%D8%AF&size=180&type=sale&propertyType=%D8%B4%D9%82%D8%A9";
  assert.equal(vm.runInContext("prefillFromUrl()", context), true);
  assert.equal(getElementById("area").value, "ممر مكرم عبيد");
  assert.equal(getElementById("size").value, "180");
  assert.equal(getElementById("propertyType").value, "شقة");
  assert.equal(getElementById("areaType").value, "sale");
});

test("incomplete chat context is prefilled but never auto-estimated with apartment/sale defaults", () => {
  const { context, getElementById, window } = createPageContext();
  vm.runInContext("AREAS = ['المنطقة الأولى']", context);
  window.location.search = "?from=agent&area=%D8%A7%D9%84%D9%85%D9%86%D8%B7%D9%82%D8%A9+%D8%A7%D9%84%D8%A3%D9%88%D9%84%D9%89&size=180";
  assert.equal(vm.runInContext("prefillFromUrl()", context), false);
  assert.equal(getElementById("area").value, "المنطقة الأولى");
  assert.equal(getElementById("size").value, "180");
});

test("page displays missing D1 bounds as unavailable and reports D1-only source metadata", () => {
  const { context, getElementById } = createPageContext();
  const result = {
    estimate: 9000000,
    range: { low: null, high: null },
    price_per_meter: 50000,
    price_per_m2_range: { low: null, high: null },
    area_found: "المنطقة الأولى",
    confidence: "unknown",
    sample_count: null,
    period: null,
    data_source: "price_snapshots",
    price_basis: "avg_price_m2",
    disclaimer: "مؤشر أسعار طلب وليس سعر إتمام مؤكدًا.",
  };
  const inputs = {
    area: "المنطقة الأولى", areaType: "sale", propertyType: "شقة", size: 180,
    finishing: "سوبر لوكس", floor: "ثالث", age: "medium", rentCondition: null,
  };
  vm.runInContext(`lastResult = ${JSON.stringify(result)}; lastInputs = ${JSON.stringify(inputs)}; showResult(lastResult, lastInputs, 0);`, context);
  assert.equal(getElementById("range").textContent, "النطاق غير متاح في السجل");
  assert.equal(getElementById("marketRange").textContent, "نطاق سعر المتر غير مسجل");
  assert.equal(getElementById("sampleCount").textContent, "غير متاح");
  assert.equal(getElementById("confidence").textContent, "● غير محددة");
  assert.match(getElementById("srcNote").textContent, /price_snapshots/);
  // تقرير المشاركة لازم يحمل رابط إعادة فتح الأداة نفسه — مش مجرد عبارة وصفية.
  // الصياغة الحالية في buildReport هي "🔗 الرابط: <url>" (بدل عبارة «رابط إعادة فتح الأداة» القديمة)،
  // فبنتحقق من الصياغة الحالية ومن وجود الرابط فعليًا ومن بارامتراته الأساسية.
  const report = getElementById("whatsappMessage").textContent;
  assert.match(report, /🔗 الرابط: https:\/\/nasr-realestate\.github\.io\/tools\/valuation\.html\S*/);
  const reportUrl = new URL(report.match(/https:\/\/\S+/)[0]);
  assert.equal(reportUrl.pathname, "/tools/valuation.html");
  // المنطقة الأولى → 1st-district، ومش 1st-neighborhood (اللي هو الحي الأول)
  assert.equal(reportUrl.searchParams.get("area"), "1st-district");
  assert.equal(reportUrl.searchParams.get("size"), "180");
  // مفاتيح الرابط الحالية: type = نوع العقار (slug) و deal = بيع/إيجار (الرابط القديم كان type=sale&pt=apartment)
  assert.equal(reportUrl.searchParams.get("type"), "apartment");
  assert.equal(reportUrl.searchParams.get("deal"), "sale");
  assert.equal(reportUrl.searchParams.has("pt"), false);
  assert.doesNotMatch(report, /عايز نكمل مع بعض/);
  assert.doesNotMatch(inlineScript, /function\s+localEstimate\s*\(/);
  assert.doesNotMatch(inlineScript, /function\s+loadMarket\s*\(/);
});

// ═══════════ C-1 … C-8 و T2.1 ═══════════

test("C-1: the area list accepts name objects and plain strings; whole city first, then the four priority areas, parent scope never offered", async () => {
  const mixed = createPageContext({
    fetchImpl: async () => new Response(JSON.stringify({ available_areas: [
      WHOLE, "مدينة نصر", { name: "المنطقة الأولى" }, { name_ar: "الحي الأول" }, { area_name_ar: "الحي الثاني" }, {}, null, 7, "  المنطقة السادسة  ",
    ] }), { status: 200 }),
  });
  assert.equal(await mixed.run("loadAreas()"), true);
  assert.deepEqual(Array.from(mixed.run("AREAS")), [WHOLE, "مدينة نصر", "المنطقة الأولى", "الحي الأول", "الحي الثاني", "المنطقة السادسة"]);
  const offered = mixed.el("area").children.map(o => o.value);
  assert.deepEqual(offered, [WHOLE, "المنطقة السادسة", "المنطقة الأولى", "الحي الأول", "الحي الثاني"], "whole city, priority area, then the rest in Worker order");

  const { page } = await pageWithAreas();
  const options = page.el("area").children.map(o => o.value);
  assert.equal(options[0], WHOLE);
  assert.deepEqual(options.slice(1, 5), ["المنطقة السادسة", "المنطقة الثامنة", "المنطقة التاسعة", "الحي العاشر"]);
  assert.equal(options.length, 31, "whole city + 30 sub-areas");
  assert.equal(new Set(options).size, options.length, "no duplicates");
  assert.ok(!options.includes("مدينة نصر"), "the bare parent scope is never offered");
  assert.deepEqual([...options].sort(), [...AREA_NAMES.filter(n => n !== "مدينة نصر"), WHOLE].sort(), "every live area is offered exactly once");

  const empty = createPageContext({ fetchImpl: async () => new Response(JSON.stringify({ available_areas: [] }), { status: 200 }) });
  assert.equal(await empty.run("loadAreas()"), false);
  assert.match(empty.el("error-box").textContent, /تعذر تحميل قائمة المناطق/);
  const down = createPageContext({ fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.equal(await down.run("loadAreas()"), false);
  assert.equal(down.el("error-box").style.display, "block");
});

test("C-2: rentCondition is sent for rent only, and only with an explicit value", async () => {
  const sent = async fields => {
    const calls = [];
    const { page } = await pageWithAreas({ calls });
    await runValuationWith(page, fields);
    const post = calls.filter(c => c.method === "POST");
    assert.equal(post.length, 1);
    return JSON.parse(post[0].body);
  };
  assert.equal("rentCondition" in await sent({ areaType: "sale", furnished: "furnished" }), false, "sale never carries it");
  assert.equal("rentCondition" in await sent({ areaType: "rent", furnished: "unknown" }), false, "rent + unknown carries nothing");
  assert.equal((await sent({ areaType: "rent", furnished: "furnished" })).rentCondition, "furnished");
  assert.equal((await sent({ areaType: "rent", furnished: "unfurnished" })).rentCondition, "unfurnished");
  const payload = await sent({ size: "١٨٠", finishing: "نصف تشطيب" });
  assert.equal(payload.size, 180, "Arabic digits become a number");
  assert.equal(payload.area, "المنطقة السادسة", "only the official area name is sent");
  assert.deepEqual(Object.keys(payload).sort(), ["age", "area", "areaType", "finishing", "floor", "propertyType", "size"]);
});

test("C-3: every Worker error code has a clear Arabic message and shows its code; failures never render a result", async () => {
  const { page } = await pageWithAreas();
  const ctx = JSON.stringify({ area: "المنطقة السادسة", propertyType: "شقة", areaType: "sale" });
  const table = [
    ["AREA_REQUIRED", /اختر المنطقة/], ["TRANSACTION_REQUIRED", /نوع العملية/], ["PROPERTY_TYPE_REQUIRED", /نوع العقار/],
    ["UNSUPPORTED_PROPERTY_TYPE", /نوع العقار "شقة" غير مدعوم/], ["INVALID_AREA_SIZE", /بين 20 و100,000/], ["INVALID_RENT_CONDITION", /حالة التأثيث/],
    ["AREA_NOT_FOUND", /المنطقة "المنطقة السادسة" غير مسجلة/], ["MARKET_UNAVAILABLE", /لا توجد لقطة سوقية مطابقة لـ"المنطقة السادسة" \+ "شقة" \+ "بيع"/],
    ["INSUFFICIENT_MARKET_DATA", /لم يتم إنشاء تقييم بديل/], ["REQUEST_TOO_LARGE", /حجم الطلب/], ["INVALID_JSON", /تعذر إرسال الطلب/],
    ["INVALID_PAYLOAD", /تعذر إرسال الطلب/], ["METHOD_NOT_ALLOWED", /رفضت نوع الطلب/],
  ];
  for (const [code, pattern] of table) {
    const message = page.run(`workerFailureMessage({ code: '${code}' }, ${ctx})`);
    assert.match(message, pattern, code);
    assert.ok(message.endsWith(`(رمز الخطأ: ${code})`), `${code} must be shown under the message`);
  }
  assert.equal(page.run("workerErrorText('AREA_NOT_FOUND', { areaType: 'rent' }).includes('undefined')"), false);
  assert.match(page.run("workerFailureMessage({ code: 'SOMETHING_NEW', apiMessage: 'رسالة من الـWorker' }, {})"), /رسالة من الـWorker\n\(رمز الخطأ: SOMETHING_NEW\)/);
  assert.match(page.run("workerFailureMessage({ noResponse: true }, {})"), /تعذر الاتصال بخدمة التقييم/);
  assert.match(page.run("workerFailureMessage({ badResponse: true }, { httpStatus: 502 })"), /رد غير متوقع \(HTTP 502\)/);
  assert.match(page.run("workerFailureMessage(null, {})"), /تعذر الحصول على مؤشر/);

  const expectNoResult = (p, pattern) => {
    assert.match(p.el("error-box").textContent, pattern);
    assert.equal(p.el("error-box").style.display, "block");
    assert.equal(p.el("result").classList.contains("show"), false, "no result card");
    assert.equal(p.run("lastResult"), null, "no result stored");
    assert.equal(p.el("inputSection").style.display, "block", "the form is back so the user can fix the input");
  };
  // الـWorker الحقيقي: مفيش لقطة لفيلا في المنطقة السادسة ⇒ 503 MARKET_UNAVAILABLE (مفيش رقم بديل)
  await runValuationWith(page, { propertyType: "فيلا" });
  expectNoResult(page, /لا توجد لقطة سوقية مطابقة لـ"المنطقة السادسة" \+ "فيلا" \+ "بيع"[\s\S]*\(رمز الخطأ: MARKET_UNAVAILABLE\)/);
  // الـWorker واقف
  const offline = createPageContext({ fetchImpl: async u => { if (String(u).endsWith("/areas")) return routedFetch()(u); throw new TypeError("offline"); } });
  await offline.run("loadAreas()");
  await runValuationWith(offline);
  expectNoResult(offline, /تعذر الاتصال بخدمة التقييم/);
  // رد مش JSON
  const html502 = createPageContext({ fetchImpl: async (u, i) => (String(u).endsWith("/areas") ? routedFetch()(u, i) : new Response("<html>Bad Gateway</html>", { status: 502 })) });
  await html502.run("loadAreas()");
  await runValuationWith(html502);
  expectNoResult(html502, /رد غير متوقع \(HTTP 502\)/);
  // عقد غير مؤكد
  const wrongContract = createPageContext({ fetchImpl: async (u, i) => (String(u).endsWith("/areas") ? routedFetch()(u, i) : new Response(JSON.stringify({ estimate: 5000000, price_per_meter: 28000 }), { status: 200 })) });
  await wrongContract.run("loadAreas()");
  await runValuationWith(wrongContract);
  expectNoResult(wrongContract, /لا يؤكد استخدام price_snapshots/);
});

test("C-4: fallback_used is announced on the result card, in the report and in the agent link — and only then", async () => {
  const { page } = await pageWithAreas();
  await runValuationWith(page, { propertyType: "محل تجاري", size: "80" });
  assert.equal(page.el("result").classList.contains("show"), true, "the real Worker answered with the whole-city snapshot");
  assert.equal(page.el("fallbackNotice").classList.contains("show"), true);
  assert.match(page.el("fallbackNoticeText").textContent, /لا توجد لقطة سوقية مستقلة لـ«المنطقة السادسة»[\s\S]*بيانات «مدينة نصر»/);
  assert.equal(page.el("areaFound").textContent, "مدينة نصر — بديل عن «المنطقة السادسة»");
  assert.equal(page.el("fallbackNotice").getAttribute("aria-hidden"), "false");
  const report = page.el("whatsappMessage").textContent;
  assert.match(report, /⚠️ لا توجد لقطة مستقلة للمنطقة المختارة — المؤشر مبني على بيانات «مدينة نصر»/);
  assert.match(report, /📍 المنطقة: مدينة نصر — بديل عن «المنطقة السادسة»/);
  page.run("fromAgent = true; updateBackToAgentButton(lastResult, lastInputs)");
  const link = new URL(page.el("backToAgentBtn").href, "https://nasr-realestate.github.io");
  assert.equal(link.searchParams.get("area"), "مدينة نصر", "numbers from the city snapshot are attributed to the city, not to the selected area");

  const normal = await pageWithAreas();
  await runValuationWith(normal.page);
  assert.equal(normal.page.el("fallbackNotice").classList.contains("show"), false);
  assert.equal(normal.page.el("fallbackNotice").getAttribute("aria-hidden"), "true");
  assert.equal(normal.page.el("areaFound").textContent, "المنطقة السادسة");
  assert.doesNotMatch(normal.page.el("whatsappMessage").textContent, /بديل عن|لا توجد لقطة مستقلة/);
});

test("C-5: v2 shows P25–P75 as the main range with Min–Max sample bounds; v1 keeps Min–Max", async () => {
  const { page } = await pageWithAreas();
  await runValuationWith(page);
  assert.equal(page.el("estimate").textContent, "9,360,000");
  assert.equal(page.el("rangeLabel").textContent, "النطاق (P25 – P75)");
  assert.equal(page.el("range").textContent, "8,280,000 – 10,440,000");
  assert.equal(page.el("marketRangeLabel").textContent, "نطاق سعر المتر (P25 – P75)");
  assert.equal(page.el("marketRange").textContent, "46,000 – 58,000 ج.م/م²");
  assert.equal(page.el("marketBounds").textContent, "38,000 – 70,000 ج.م/م²");
  assert.equal(page.el("perMeterLabel").textContent, "سعر المتر (الوسيط)");
  assert.equal(page.el("perMeter").textContent, "52,000 /م²");
  assert.equal(page.el("confidence").textContent, "● عالية");
  assert.equal(page.el("sampleCount").textContent, "41");
  assert.equal(page.el("marketPeriod").textContent, "2026-09");
  assert.match(page.el("srcNote").textContent, /الأساس: الوسيط \(median_price_m2\)/);
  const report = page.el("whatsappMessage").textContent;
  for (const line of ["📊 النطاق الأساسي (P25–P75): 8,280,000 – 10,440,000 ج.م", "📏 سعر المتر (الوسيط): 52,000 ج.م/م²", "↕️ نطاق المتر (P25–P75): 46,000 – 58,000 ج.م/م²", "↔️ حدود العينة (Min–Max): 38,000 – 70,000 ج.م/م²", "🧪 العينات: 41", "🎯 الثقة: عالية"]) {
    assert.ok(report.includes(line), line);
  }
  // لا شيء بيتحسب في الصفحة: الأرقام المعروضة هي أرقام الـWorker حرفيًا
  const worker = await workerResult(SIX);
  assert.equal(page.el("estimate").textContent, worker.estimate.toLocaleString("en-US"));

  const v1 = createPageContext();
  const legacy = { api_contract: "d1-price-snapshots-v1", source_table: "price_snapshots", price_basis: "avg_price_m2", estimate: 5000000, price_per_meter: 50000, range: { low: 4500000, high: 5500000 }, price_per_m2_range: { low: 45000, high: 55000 }, confidence: "high", sample_count: 12, period: "2026-Q3" };
  v1.run(`lastResult = ${JSON.stringify(legacy)}; lastInputs = { area: 'المنطقة الأولى', areaType: 'sale', propertyType: 'شقة', size: 100 }; showResult(lastResult, lastInputs, 0);`);
  assert.equal(v1.el("rangeLabel").textContent, "النطاق (Min – Max)");
  assert.equal(v1.el("marketRangeLabel").textContent, "نطاق سعر المتر (Min – Max)");
  assert.equal(v1.el("perMeterLabel").textContent, "سعر المتر (المتوسط)");
  assert.equal(v1.el("marketBounds").textContent, "حدود العينة غير مسجلة");
  assert.match(v1.el("whatsappMessage").textContent, /📊 النطاق \(Min–Max\)/);
  assert.doesNotMatch(v1.el("whatsappMessage").textContent, /حدود العينة/);
});

test("C-6: the share link round-trips — known areas travel as slugs, unknown ones by name", async () => {
  const { page } = await pageWithAreas();
  const url = new URL(page.run("buildShareUrl({ area: 'المنطقة السادسة', size: 180, propertyType: 'شقة', areaType: 'rent', rentCondition: 'furnished', finishing: 'نصف تشطيب', floor: 'ثالث', age: 'new', asking: 62000 })"));
  assert.equal(url.pathname, "/tools/valuation.html");
  assert.deepEqual(Object.fromEntries(url.searchParams), { area: "6th-district", size: "180", type: "apartment", deal: "rent", furnished: "yes", finish: "semi-finished", floor: "3", age: "new", price: "62000" });
  page.window.location.search = url.search;
  assert.equal(page.run("prefillFromUrl()"), true);
  assert.deepEqual(
    ["area", "size", "areaType", "propertyType", "finishing", "floor", "age", "furnished", "askingPrice"].map(id => page.el(id).value),
    ["المنطقة السادسة", "180", "rent", "شقة", "نصف تشطيب", "ثالث", "new", "furnished", "62,000"],
  );

  // اسم منطقة جديد في الـWorker لسه ملوش slug في الصفحة: بيتمرر كما هو بدل ما الرابط يتكسر
  const future = "المنطقة الثالثة عشرة";
  page.run(`AREAS = [...AREAS, '${future}']`);
  const byName = new URL(page.run(`buildShareUrl({ area: '${future}', size: 150, propertyType: 'شقة', areaType: 'sale' })`));
  assert.equal(byName.searchParams.get("area"), future);
  page.window.location.search = byName.search;
  assert.equal(page.run("prefillFromUrl()"), true);
  assert.equal(page.el("area").value, future);

  // مفيش حاجة غير افتراضية في الرابط الافتراضي + مفيش rentCondition في البيع
  const plain = new URL(page.run("buildShareUrl({ area: 'المنطقة الثامنة', size: 100, propertyType: 'شقة', areaType: 'sale', rentCondition: 'furnished', finishing: 'سوبر لوكس', floor: 'أرضي', age: 'medium', asking: 0 })"));
  assert.deepEqual(Object.fromEntries(plain.searchParams), { area: "8th-district", size: "100", type: "apartment", deal: "sale" });
  assert.equal(page.run("buildShareUrl(null)"), "");
  // المشاركة بتنسخ الرابط (مفيش إرسال تلقائي)
  page.run("lastInputs = { area: 'المنطقة الثامنة', size: 100, propertyType: 'شقة', areaType: 'sale' }");
  await page.run("shareValuation()");
  assert.equal(page.clipboard.length, 1);
  assert.match(page.clipboard[0], /^https:\/\/nasr-realestate\.github\.io\/tools\/valuation\.html\?area=8th-district/);
});

test("C-7: the page forces the dark colour scheme for the page, fields and menus", () => {
  const style = valuationHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  assert.match(style, /:root\s*\{[^}]*color-scheme:\s*dark/);
  assert.match(style, /textarea,\s*input,\s*select\s*\{[^}]*color-scheme:\s*dark/);
  assert.match(style, /select option,\s*select optgroup\s*\{[^}]*background-color:\s*var\(--input\);[^}]*color:\s*#fff/);
  assert.doesNotMatch(style, /prefers-color-scheme:\s*light|color-scheme:\s*(light|only light)/);
});

test("C-8: the back-to-agent link carries the Worker's numbers (P25/P75 only for v2) and is hidden outside the agent journey", async () => {
  const { page } = await pageWithAreas();
  await runValuationWith(page);
  page.run("fromAgent = false; updateBackToAgentButton(lastResult, lastInputs)");
  assert.equal(page.el("backToAgentBtn").style.display, "none");
  page.run("fromAgent = true; updateBackToAgentButton(lastResult, lastInputs)");
  assert.equal(page.el("backToAgentBtn").style.display, "flex");
  const link = new URL(page.el("backToAgentBtn").href, "https://nasr-realestate.github.io");
  assert.equal(link.pathname, "/agent.html");
  assert.deepEqual(Object.fromEntries(link.searchParams), {
    return: "valuation", estimate: "9360000", confidence: "high", samples: "41", perMeter: "52000", p25: "46000", p75: "58000",
    basis: "median_price_m2", area: "المنطقة السادسة", size: "180", areaType: "sale",
  });
  const v1 = new URL(page.run(`fromAgent = true; updateBackToAgentButton({ api_contract: 'd1-price-snapshots-v1', source_table: 'price_snapshots', estimate: 5000000, price_per_meter: 50000, price_per_m2_range: { low: 45000, high: 55000 }, price_basis: 'avg_price_m2', confidence: 'high', sample_count: 12 }, { area: 'المنطقة الأولى', size: 100, areaType: 'sale' }); document.getElementById('backToAgentBtn').href`), "https://nasr-realestate.github.io");
  assert.equal(v1.searchParams.has("p25"), false, "v1's range is Min–Max, so it must not be passed as P25");
  assert.equal(v1.searchParams.has("p75"), false);
  assert.equal(v1.searchParams.get("basis"), "avg_price_m2");
});

test("T2.1: an area that can't be resolved from the link or chat produces a visible hint", async () => {
  const { page } = await pageWithAreas();
  const hint = /ما قدرناش نتعرّف على المنطقة من الرابط/;
  page.window.location.search = "?from=agent&area=" + encodeURIComponent("حي غير موجود في القايمة") + "&size=180&deal=sale&type=apartment";
  assert.equal(page.run("prefillFromUrl()"), false, "never auto-runs without a resolved area");
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0].textContent, hint);
  assert.equal(page.toasts[0].className, "toast");
  assert.equal(page.timers.at(-1).ms, 6000, "long enough to be read");

  const before = page.toasts.length;
  page.window.location.search = "?area=" + encodeURIComponent("المنطقة السادسة") + "&size=180&deal=sale&type=apartment";
  assert.equal(page.run("prefillFromUrl()"), true);
  page.window.location.search = "?size=180&deal=sale&type=apartment";
  page.run("prefillFromUrl()");
  assert.equal(page.toasts.length, before, "no hint for a resolved area or when no area was asked for");
  // العنوان الكامل (اللي بيبعته الوكيل) بيتفكّ لمنطقة رسمية بدل ما يظهر التنبيه
  page.window.location.search = "?area=" + encodeURIComponent("شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة") + "&size=180&deal=sale&type=apartment";
  assert.equal(page.run("prefillFromUrl()"), true);
  assert.equal(page.el("area").value, "المنطقة السادسة");
  assert.equal(page.toasts.length, before);
});

// ═══════════ حراسة الخصوصية والتصميم ═══════════

test("the page computes nothing: it displays Worker numbers and keeps only a minimal local trace", async () => {
  assert.doesNotMatch(inlineScript, /price_per_meter\s*\*|\*\s*(?:inputs|i|payload)\.size|median_price_m2\s*\*|\bp25\b\s*\*/, "no valuation arithmetic in the page");
  assert.doesNotMatch(inlineScript, /\b\d{5,}\b\s*(?:\*|\/)\s*(?:size|inputs)/, "no hard-coded prices");
  const { page } = await pageWithAreas();
  await runValuationWith(page, { askingPrice: "9,500,000" });
  const trace = JSON.parse(page.localStorage.getItem("simsar_valuation_last_v1"));
  assert.deepEqual(Object.keys(trace).sort(), ["area", "estimate", "savedAt", "size"], "no asking price, no phone, no free text in the trace");
  assert.equal(trace.estimate, 9360000);
  page.run("confirmClearTrace()");
  assert.equal(page.localStorage.getItem("simsar_valuation_last_v1"), null);
  assert.equal(page.el("verdictLabel").textContent, "🟡 قريب من مؤشر بيانات السوق");
});

test("nothing is sent to anyone automatically: the WhatsApp hand-off is an explicit click and opens with noopener", async () => {
  const { page } = await pageWithAreas();
  await runValuationWith(page);
  assert.equal(page.opened.length, 0, "no window.open after a valuation");
  page.run("sendToTarek()");
  assert.equal(page.opened.length, 1);
  const [url, target, features] = page.opened[0];
  assert.match(url, /^https:\/\/wa\.me\/201147758857\?text=/);
  assert.equal(target, "_blank");
  assert.equal(features, "noopener");
  assert.match(decodeURIComponent(url.split("text=")[1]), /السعر الاسترشادي: 9,360,000 ج\.م/);
});

test("similar listings come from ai-feed only (asking prices), independently of the Worker's numbers", async () => {
  const feed = { properties: [
    { id: "feed-unit-1", title: "شقة معروضة في الحي الأول", zone: "الحي الأول", transaction: "sale", propertyType: "apartment", areaNumeric: 175, priceNumeric: 6200000, url: "https://nasr-realestate.github.io/properties/feed-unit-1.html" },
    { id: "feed-unit-2", title: "شقة في المنطقة السادسة", zone: "المنطقة السادسة", transaction: "sale", areaNumeric: 170, price: "8,100,000 ج.م", url: "javascript:alert(1)" },
    { id: "feed-unit-3", title: "شقة إيجار في الحي الأول", zone: "الحي الأول", transaction: "rent", areaNumeric: 120, priceNumeric: 20000, url: "https://nasr-realestate.github.io/properties/feed-unit-3.html" },
  ] };
  const { page } = await pageWithAreas({ feed });
  await page.run("loadSimilarProperties({ areaType: 'sale', size: 180 }, 'الحي الأول')");
  const cards = page.el("similarGrid").children;
  assert.equal(cards.length, 1, "only the same area, same deal");
  assert.match(textOf(cards[0]), /السعر المعلن: 6,200,000 ج\.م/, "the listing's own asking price, labelled as such");
  assert.match(page.el("similarStatus").textContent, /الأقرب لمساحة 180 م² في الحي الأول/);
  await page.run("loadSimilarProperties({ areaType: 'sale', size: 180 }, 'المنطقة السادسة')");
  assert.equal(page.el("similarGrid").children.length, 0, "a card with an unsafe URL is dropped");
  assert.match(page.el("similarStatus").textContent, /لا توجد وحدات منشورة حاليًا في المنطقة نفسها/);
});

test("the agent journey auto-runs once the area list is loaded and the link is complete", async () => {
  const calls = [];
  const page = createPageContext({ fetchImpl: routedFetch({ calls }) });
  page.window.location.search = "?from=agent&journey=seller&area=6th-district&size=180&type=apartment&deal=sale&price=9500000&floor=3";
  await page.boot();
  await waitFor(() => page.el("result").classList.contains("show"), { label: "auto-run result" });
  assert.equal(page.el("agentJourneyBar").classList.contains("show"), true);
  assert.equal(page.el("estimate").textContent, "9,360,000");
  assert.equal(page.el("floor").value, "ثالث");
  assert.equal(page.el("askingPrice").value, "9,500,000");
  assert.equal(page.el("backToAgentBtn").style.display, "flex");
  assert.equal(calls.filter(c => c.method === "POST").length, 1, "exactly one valuation request");

  // رابط ناقص: بيتملي بس ومش بيشغّل تقييم لوحده
  const partial = createPageContext({ fetchImpl: routedFetch() });
  partial.window.location.search = "?from=agent&area=6th-district&size=180";
  await partial.boot();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(partial.el("result").classList.contains("show"), false);
  assert.equal(partial.el("area").value, "المنطقة السادسة");
});
