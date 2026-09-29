import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const html = fs.readFileSync(new URL("../../tools/valuation.html", import.meta.url), "utf8");
const inlineScript = html.split("<script>")[1]?.split("</script>")[0];
assert.ok(inlineScript, "valuation page must contain its inline script");

function createPageContext() {
  const elements = new Map();
  const optionsById = {
    propertyType: ["شقة", "دوبلكس", "فيلا", "روف", "محل تجاري", "مكتب إداري", "مخزن"],
    finishing: ["سوبر لوكس", "ألترا سوبر لوكس", "نصف تشطيب", "طوب أحمر"],
    floor: ["أرضي", "أول", "ثاني", "ثالث", "رابع", "خامس+"],
    age: ["new", "medium", "old"],
    furnished: ["unknown", "unfurnished", "furnished"],
  };
  const makeElement = id => ({
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    style: {},
    options: (optionsById[id] || []).map(value => ({ value })),
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    querySelectorAll() { return []; },
    querySelector() { return { innerHTML: "", textContent: "" }; },
    setAttribute() {},
    scrollIntoView() {},
    appendChild() {},
    replaceChildren() {},
    addEventListener() {},
  });
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const window = {
    location: {
      origin: "https://nasr-realestate.github.io",
      href: "https://nasr-realestate.github.io/tools/valuation.html",
      search: "",
    },
    history: { replaceState() {} },
    scrollTo() {},
    prompt() {},
    open() {},
  };
  const document = {
    getElementById,
    createElement: tag => makeElement(tag),
    addEventListener() {},
    querySelectorAll() { return []; },
    body: { appendChild() {} },
  };
  const context = vm.createContext({
    document, window, location: window.location,
    URL, URLSearchParams, console,
    navigator: {},
    fetch: async () => new Response(JSON.stringify({ properties: [] }), { status: 200 }),
    setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(inlineScript, context);
  return { context, elements, getElementById, window };
}

test("page rejects valuation payloads that do not explicitly identify the D1 contract", () => {
  const { context } = createPageContext();
  assert.equal(vm.runInContext("isD1ValuationResponse({estimate: 7000000, data_source: 'local'})", context), false);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v1', source_table: 'price_snapshots', price_basis: 'avg_price_m2', price_per_meter: 42000})", context), true);
  assert.equal(vm.runInContext("isD1ValuationResponse({api_contract: 'd1-price-snapshots-v1', source_table: 'price_snapshots', price_basis: 'local', price_per_meter: 42000})", context), false);
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
  // الصياغة الحالية في buildReport هي "🔗 الرابط: <url>" (بدل عبارة «رابط إعادة فتح الأداة»
  // القديمة)، فبنتحقق من الصياغة الحالية ومن وجود الرابط فعليًا ومن بارامتراته الأساسية.
  // ده أقوى من الادعاء القديم: عبارة وصفية من غير رابط كانت هتنجح قبل كده.
  const report = getElementById("whatsappMessage").textContent;
  assert.match(report, /🔗 الرابط: https:\/\/nasr-realestate\.github\.io\/tools\/valuation\.html\S*/);
  const reportUrl = new URL(report.match(/https:\/\/\S+/)[0]);
  assert.equal(reportUrl.pathname, "/tools/valuation.html");
  // المنطقة الأولى → 1st-district، ومش 1st-neighborhood (اللي هو الحي الأول)
  assert.equal(reportUrl.searchParams.get("area"), "1st-district");
  assert.equal(reportUrl.searchParams.get("size"), "180");
  assert.equal(reportUrl.searchParams.get("type"), "sale");
  assert.equal(reportUrl.searchParams.get("pt"), "apartment");
  assert.doesNotMatch(report, /عايز نكمل مع بعض/);
  assert.doesNotMatch(inlineScript, /function\s+localEstimate\s*\(/);
  assert.doesNotMatch(inlineScript, /function\s+loadMarket\s*\(/);
});
