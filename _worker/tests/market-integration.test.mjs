import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import agentWorker from "../worker.js";
import valuationWorker from "../valuation-worker.js";
import {
  calculateMarketTotals,
  findAreaName,
  getMarketSnapshot,
  listMarketAreas,
  normalizePropertyType,
} from "../market-data.js";

const areas = [
  { id: 1, name_ar: "المنطقة الأولى" },
  { id: 2, name_ar: "الحي الأول" },
  { id: 3, name_ar: "ممر مكرم عبيد" },
  { id: 4, name_ar: "ممر عباس العقاد" },
  { id: 5, name_ar: "رابعة العدوية" },
  { id: 6, name_ar: "الحي الدبلوماسي" },
];

const snapshots = [
  {
    id: 1, area_name_ar: "المنطقة الأولى", property_type: "شقة", transaction_type: "بيع",
    rent_condition: null, avg_price_m2: 50000, median_price_m2: null,
    min_price_m2: 45000, max_price_m2: 55000, sample_count: 12,
    period: "2026-Q3", data_source: "D1 fixture",
  },
  {
    id: 2, area_name_ar: "ممر مكرم عبيد", property_type: "شقة", transaction_type: "بيع",
    rent_condition: null, avg_price_m2: null, median_price_m2: 42000,
    min_price_m2: 40000, max_price_m2: 45000, sample_count: 7,
    period: "2026-Q3", data_source: "D1 fixture",
  },
  {
    id: 3, area_name_ar: "المنطقة الأولى", property_type: "شقة", transaction_type: "إيجار",
    rent_condition: "مفروش", avg_price_m2: 1200, median_price_m2: null,
    min_price_m2: 1000, max_price_m2: 1500, sample_count: 8,
    period: "2026-Q3", data_source: "D1 fixture",
  },
  {
    id: 4, area_name_ar: "الحي الدبلوماسي", property_type: "شقة", transaction_type: "إيجار",
    rent_condition: null, avg_price_m2: 900, median_price_m2: null,
    min_price_m2: 800, max_price_m2: 1100, sample_count: 5,
    period: "2026-Q3", data_source: "D1 fixture",
  },
];

const snapshotColumns = [
  "id", "area_name_ar", "property_type", "transaction_type", "rent_condition",
  "avg_price_m2", "median_price_m2", "min_price_m2", "max_price_m2",
  "sample_count", "period", "data_source",
];
const areaColumns = ["id", "name_ar"];

function makeDb(rows = snapshots) {
  return {
    prepare(sql) {
      return {
        async all() {
          if (sql.startsWith("PRAGMA table_info")) {
            const columns = sql.includes("'price_snapshots'") ? snapshotColumns : areaColumns;
            return { results: columns.map(name => ({ name })) };
          }
          if (sql.includes('"price_snapshots"')) return { results: rows };
          if (sql.includes('"areas"')) return { results: areas };
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}

const feed = {
  properties: [
    {
      id: "feed-unit-1",
      title: "شقة معروضة في الحي الأول",
      zone: "الحي الأول",
      transaction: "sale",
      propertyType: "apartment",
      areaNumeric: 175,
      priceNumeric: 6200000,
      url: "https://nasr-realestate.github.io/properties/feed-unit-1.html",
    },
  ],
};
const previousFetch = globalThis.fetch;
let geminiCallCount = 0;

before(() => {
  globalThis.fetch = async input => {
    if (String(input).includes("ai-feed.json")) {
      return new Response(JSON.stringify(feed), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    geminiCallCount += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "-" }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = previousFetch;
});

test("D1 keeps المنطقة الأولى separate from الحي الأول and resolves explicit area aliases", async () => {
  const names = await listMarketAreas(makeDb());
  assert.deepEqual(names, areas.map(area => area.name_ar));
  assert.equal(findAreaName(names, "المنطقة الأولى"), "المنطقة الأولى");
  assert.equal(findAreaName(names, "الحي الأول"), "الحي الأول");
  assert.equal(findAreaName(names, "مكرم عبيد"), "ممر مكرم عبيد");
  assert.equal(findAreaName(names, "حي السفارات"), "الحي الدبلوماسي");
  assert.notEqual(findAreaName(names, "المنطقة الأولى"), findAreaName(names, "الحي الأول"));
  assert.equal(normalizePropertyType("شقتي"), "apartment");
});

test("D1 valuation uses avg/median and real min/max; no apartment substitution for unsupported types", async () => {
  const db = makeDb();
  const first = await getMarketSnapshot(db, { area: "المنطقة الأولى", propertyType: "شقة", areaType: "sale" });
  assert.equal(first.ok, true);
  assert.equal(first.price_basis, "avg_price_m2");
  assert.deepEqual(calculateMarketTotals(first, 100), {
    estimate: 5000000,
    range: { low: 4500000, high: 5500000 },
    price_per_meter: 50000,
    price_per_m2_range: { low: 45000, high: 55000 },
  });

  const makram = await getMarketSnapshot(db, { area: "مكرم عبيد", propertyType: "شقة", areaType: "sale" });
  assert.equal(makram.ok, true);
  assert.equal(makram.area_found, "ممر مكرم عبيد");
  assert.equal(makram.price_basis, "median_price_m2");

  const villa = await getMarketSnapshot(db, { area: "المنطقة الأولى", propertyType: "فيلا", areaType: "sale" });
  assert.equal(villa.ok, false);
  assert.equal(villa.reason, "insufficient_data");
  const noSaleSnapshot = await getMarketSnapshot(db, { area: "الحي الأول", propertyType: "شقة", areaType: "sale" });
  assert.equal(noSaleSnapshot.ok, false);
  assert.equal(noSaleSnapshot.reason, "insufficient_data");
  const wrongRentCondition = await getMarketSnapshot(db, {
    area: "المنطقة الأولى", propertyType: "شقة", areaType: "rent", rentCondition: "unfurnished",
  });
  assert.equal(wrongRentCondition.ok, false);
  assert.equal(wrongRentCondition.reason, "insufficient_data");
  const unspecifiedRent = await getMarketSnapshot(db, {
    area: "الحي الدبلوماسي", propertyType: "شقة", areaType: "rent", rentCondition: "unknown",
  });
  assert.equal(unspecifiedRent.ok, true);
  assert.equal(unspecifiedRent.rent_condition, "unknown");
});

test("valuation Worker serves D1 areas on /areas and D1 estimates on /api", async () => {
  const db = makeDb();
  const get = await valuationWorker.fetch(new Request("https://worker.test/areas"), { DB: db });
  const getBody = await get.json();
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(getBody.available_areas));
  assert.equal(getBody.api_contract, "d1-price-snapshots-v1");
  assert.equal(getBody.data_source, "price_snapshots");
  assert.equal("database" in getBody, false);

  const post = await valuationWorker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://nasr-realestate.github.io" },
    body: JSON.stringify({ area: "المنطقة الأولى", areaType: "sale", propertyType: "شقة", size: 100 }),
  }), { DB: db });
  const body = await post.json();
  assert.equal(post.status, 200);
  assert.equal(body.api_contract, "d1-price-snapshots-v1");
  assert.equal(body.source_table, "price_snapshots");
  assert.equal(body.estimate, 5000000);
  assert.equal(body.sample_count, 12);
  assert.equal(body.confidence, "high");
  assert.equal(body.period, "2026-Q3");
  assert.equal(body.price_per_m2_range.low, 45000);

  const unsupported = await valuationWorker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ area: "المنطقة الأولى", areaType: "sale", propertyType: "فيلا", size: 100 }),
  }), { DB: db });
  assert.equal(unsupported.status, 422);
  const noSnapshotBody = await unsupported.json();
  assert.equal(noSnapshotBody.code, "INSUFFICIENT_MARKET_DATA");
  assert.equal("estimate" in noSnapshotBody, false);

  const unknownType = await valuationWorker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ area: "المنطقة الأولى", areaType: "sale", propertyType: "قصر", size: 100 }),
  }), { DB: db });
  assert.equal(unknownType.status, 422);
  assert.equal((await unknownType.json()).code, "UNSUPPORTED_PROPERTY_TYPE");

  const missingPropertyType = await valuationWorker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ area: "المنطقة الأولى", areaType: "sale", size: 100 }),
  }), { DB: db });
  assert.equal(missingPropertyType.status, 400);
  assert.equal((await missingPropertyType.json()).code, "PROPERTY_TYPE_REQUIRED");

  const missingTransaction = await valuationWorker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ area: "المنطقة الأولى", propertyType: "شقة", size: 100 }),
  }), { DB: db });
  assert.equal(missingTransaction.status, 400);
  assert.equal((await missingTransaction.json()).code, "TRANSACTION_REQUIRED");
});

async function agentPost(message, formState = {}, db = makeDb()) {
  return agentWorker.fetch(new Request("https://agent.test/", {
    method: "POST",
    headers: {
      Origin: "https://nasr-realestate.github.io",
      "Content-Type": "application/json",
      "CF-Connecting-IP": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({ message, formState, history: [] }),
  }), { DB: db, GEMINI_API_KEY: "test-key" });
}

test("agent valuation CTA is separate from buyer/owner qualification and preserves seller context", async () => {
  const underspecified = await (await agentPost("سعر المتر في المنطقة الأولى كام؟")).json();
  assert.match(underspecified.response, /حدّد نوع العقار/);
  assert.equal(underspecified.valuationCta.propertyType, null);
  assert.equal(underspecified.valuationCta.areaType, "sale");
  assert.doesNotMatch(underspecified.response, /سعر المتر في بيانات D1/);
  assert.equal(geminiCallCount, 0);

  const valuation = await (await agentPost("شقتي في المنطقة الأولى ١٨٠ متر تسوى كام؟")).json();
  assert.match(valuation.response, /سعر المتر في بيانات D1/);
  assert.equal(valuation.valuationCta.intent, "valuation");
  assert.equal(valuation.valuationCta.area, "المنطقة الأولى");
  assert.equal(valuation.valuationCta.size, 180);
  assert.equal(valuation.readyToSend, undefined);
  assert.equal(valuation.whatsappUrl, undefined);

  const seller = await (await agentPost("عايز أبيع شقتي في المنطقة الأولى ١٨٠ متر")).json();
  assert.equal(seller.valuationCta.intent, "seller");
  assert.equal(seller.formState.flowType, "owner");
  assert.equal(seller.formState.stepIndex, 0);
  assert.equal(seller.formState.data.area, undefined);
  assert.equal(seller.formState.data.propertyType, undefined);
  assert.doesNotMatch(seller.response, /سعر المتر في بيانات D1/);
  assert.equal(seller.done, false);
  assert.equal(seller.readyToSend, false);
  assert.equal(seller.whatsappUrl, undefined);
  const explicitSeller = await (await agentPost("أريد بيع شقتي في المنطقة الأولى ١٨٠ متر")).json();
  assert.equal(explicitSeller.valuationCta.intent, "seller");
  assert.equal(explicitSeller.valuationCta.area, "المنطقة الأولى");
  assert.equal(explicitSeller.valuationCta.size, 180);
  assert.equal(explicitSeller.readyToSend, false);
  const sellerValuation = await (await agentPost("عايز أبيع شقتي في المنطقة الأولى ١٨٠ متر، تسوى كام؟")).json();
  assert.match(sellerValuation.response, /سعر المتر في بيانات D1/);
  assert.equal(sellerValuation.valuationCta.intent, "seller");
  assert.equal(sellerValuation.formState.data.area, undefined);
  assert.equal(sellerValuation.whatsappUrl, undefined);
  assert.equal(geminiCallCount, 0, "D1 quote path stays deterministic and does not ask Gemini for a price");

  const ownerState = {
    active: true, lifecycle: "active", type: "sale", stepIndex: 2,
    data: { propertyType: "شقة", area: 180, location: "المنطقة الأولى" },
    awaitingQ: true, flowType: "owner", imageUrls: [], _version: "v83",
  };
  const ownerQuestion = await (await agentPost("الشقة بتاعتي تسوى كام؟", ownerState)).json();
  assert.equal(ownerQuestion.formState.flowType, "owner");
  assert.equal(ownerQuestion.valuationCta.intent, "seller");
  assert.equal(ownerQuestion.valuationCta.size, 180);
  assert.equal(ownerQuestion.whatsappUrl, undefined);

  const buyerState = { ...ownerState, flowType: "buyer" };
  const buyerQuestion = await (await agentPost("سعر المتر في المنطقة الأولى كام؟", buyerState)).json();
  assert.equal(buyerQuestion.formState.flowType, "buyer");
  assert.equal(buyerQuestion.formState.stepIndex, 2);
  assert.equal(buyerQuestion.readyToSend, undefined);
  assert.equal(buyerQuestion.whatsappUrl, undefined);

  assert.equal(geminiCallCount, 0, "market interruptions do not call Gemini for prices");
  const greeting = await (await agentPost("السلام عليكم")).json();
  assert.equal(greeting.valuationCta, undefined);
  assert.equal(geminiCallCount, 1, "the ordinary agent greeting keeps its existing Gemini path");
});

test("current listings remain sourced from ai-feed when the D1 snapshot is missing", async () => {
  const noSaleSnapshotDb = makeDb(snapshots.filter(row => row.transaction_type !== "بيع"));
  const response = await (await agentPost("في شقة معروضة للبيع في الحي الأول وسعر السوق كام؟", {}, noSaleSnapshotDb)).json();
  assert.match(response.response, /لا توجد بيانات سوقية كافية/);
  assert.match(response.response, /عقارات منشورة من المصدر الحالي/);
  assert.match(response.response, /السعر المعروض: 6,200,000 ج\.م/);
  assert.equal(response.valuationCta.area, "الحي الأول");
  assert.equal(response.whatsappUrl, undefined);
});
