// Valuation Worker (v6.2, contract d1-price-snapshots-v2) end to end over a mock D1.
// يغطي: العقد v2، الوسيط + P25–P75 + Min/Max، الثقة، الإيجار، fallback المدينة ككل (E-2)، كل رموز الفشل مع
// available_areas (E-3)، القراءة المضيّقة من D1 وشبكات أمانها (E-4)، الحد الفعلي للحجم (E-5)، والقراءة فقط.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import worker from "../valuation-worker.js";
import { ID, snap, defaultRows, makeDb, brokenDb, valuationPost, chunkedJsonBody } from "./_fixtures.mjs";

const SIX = { area: "المنطقة السادسة", areaType: "sale", propertyType: "شقة", size: 180 };
const withDb = opts => ({ DB: makeDb(opts) });
const workerSource = fs.readFileSync(new URL("../valuation-worker.js", import.meta.url), "utf8");

test("GET /areas reports v6.2 / d1-price-snapshots-v2 and lists areas as objects, whole city first", async () => {
  const response = await worker.fetch(new Request("https://worker.test/areas"), withDb());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.version, "v6.2");
  assert.equal(body.api_contract, "d1-price-snapshots-v2");
  assert.equal(body.source_table, "price_snapshots");
  assert.equal(body.data_source, "price_snapshots");
  assert.equal(body.areas, 31);
  assert.equal(body.available_areas.length, 31);
  assert.deepEqual(Object.keys(body.available_areas[0]).sort(), ["id", "name", "name_ar", "name_en", "scope"]);
  assert.equal(body.available_areas[0].id, 1);
  assert.equal(body.available_areas[0].name, "مدينة نصر (ككل)");
  assert.ok(body.available_areas.some(a => a.name === "المنطقة الأولى"));
  assert.ok(body.available_areas.some(a => a.name === "الحي الأول"));
  assert.equal(body.valuation_method.central_indicator, "median_price_m2");
  assert.equal(body.valuation_method.core_range, "p25_price_m2_to_p75_price_m2");
  assert.equal(body.valuation_method.observed_bounds, "min_price_m2_to_max_price_m2");
});

test("the four priority areas return median × size, the P25–P75 range, Min/Max bounds and the Worker's confidence (cases 1–4)", async () => {
  const cases = [
    ["المنطقة السادسة", 9360000, 8280000, 10440000, 46000, 58000, 38000, 70000, "high", 41],
    ["المنطقة الثامنة", 8460000, 7560000, 9360000, 42000, 52000, 35000, 61000, "high", 33],
    ["المنطقة التاسعة", 8190000, 7200000, 9000000, 40000, 50000, 33000, 60000, "medium", 12],
    ["الحي العاشر", 7740000, 6840000, 8640000, 38000, 48000, 30000, 56000, "low", 8],
  ];
  for (const [area, estimate, low, high, p25, p75, min, max, confidence, samples] of cases) {
    const r = await valuationPost(worker, { ...SIX, area }, withDb());
    assert.equal(r.status, 200, area);
    assert.equal(r.body.api_contract, "d1-price-snapshots-v2");
    assert.equal(r.body.source_table, "price_snapshots");
    assert.equal(r.body.price_basis, "median_price_m2");
    assert.equal(r.body.area_found, area);
    assert.equal(r.body.fallback_used, false, `${area} must use its own snapshot`);
    assert.equal(r.body.estimate, estimate, area);
    assert.deepEqual(r.body.range, { low, high }, area);
    assert.deepEqual(r.body.price_per_m2_range, { low: p25, high: p75 }, area);
    assert.deepEqual(r.body.market_bounds, { min_price_per_m2: min, max_price_per_m2: max, min_value: min * 180, max_value: max * 180 }, area);
    assert.equal(r.body.confidence, confidence, area);
    assert.equal(r.body.sample_count, samples, area);
    assert.equal(r.body.period, "2026-09");
  }
});

test("confidence comes from the sample count: ≥30 high, 10–29 medium, <10 low", async () => {
  for (const [n, expected] of [[30, "high"], [29, "medium"], [10, "medium"], [9, "low"], [1, "low"]]) {
    const rows = [snap(ID.zone6, { median: 52000, p25: 46000, p75: 58000, n })];
    const r = await valuationPost(worker, SIX, withDb({ rows }));
    assert.equal(r.status, 200);
    assert.equal(r.body.confidence, expected, `n=${n}`);
    assert.equal(r.body.sample_count, n);
  }
});

test("size limits: 20 and 100000 are accepted; 19, 100001 and junk are INVALID_AREA_SIZE; Arabic digits and units are understood", async () => {
  for (const size of [20, 100000, "١٨٠", "180 م²", "180"]) {
    const r = await valuationPost(worker, { ...SIX, size }, withDb());
    assert.equal(r.status, 200, `size ${JSON.stringify(size)}`);
  }
  assert.equal((await valuationPost(worker, { ...SIX, size: "١٨٠" }, withDb())).body.estimate, 9360000);
  for (const size of [19, 0, -5, 100001, "", "abc", null, undefined]) {
    const r = await valuationPost(worker, { ...SIX, size }, withDb());
    assert.equal(r.status, 400, `size ${JSON.stringify(size)}`);
    assert.equal(r.body.code, "INVALID_AREA_SIZE");
  }
});

test("rent: furnished and unfurnished read their own snapshot — «غير مفروش» is never read as «مفروش»", async () => {
  const rent = { area: "المنطقة السادسة", areaType: "rent", propertyType: "شقة", size: 120 };
  const furnished = await valuationPost(worker, { ...rent, rentCondition: "furnished" }, withDb());
  assert.equal(furnished.status, 200);
  assert.equal(furnished.body.estimate, 62400);
  assert.equal(furnished.body.rent_condition, "furnished");
  for (const value of ["unfurnished", "غير مفروش", "فاضي (قانون جديد)", false]) {
    const r = await valuationPost(worker, { ...rent, rentCondition: value }, withDb());
    assert.equal(r.status, 200, String(value));
    assert.equal(r.body.estimate, 31200, `${value} must pick the unfurnished snapshot`);
    assert.equal(r.body.rent_condition, "unfurnished");
  }
  const viaBoolean = await valuationPost(worker, { ...rent, furnished: true }, withDb());
  assert.equal(viaBoolean.body.estimate, 62400);
});

test("rentCondition null / '' / 'unknown' / 'غير محدد' / missing is accepted silently (E-1); sale ignores it; a real junk value is INVALID_RENT_CONDITION", async () => {
  const rent = { area: "المنطقة السادسة", areaType: "rent", propertyType: "شقة", size: 120 };
  for (const rentCondition of [null, "", "unknown", "غير محدد", "UNKNOWN", undefined]) {
    const r = await valuationPost(worker, { ...rent, rentCondition }, withDb());
    assert.equal(r.status, 200, `rentCondition ${JSON.stringify(rentCondition)}`);
    assert.equal(r.body.requested_rent_condition, null);
  }
  const sale = await valuationPost(worker, { ...SIX, rentCondition: "unknown" }, withDb());
  assert.equal(sale.status, 200);
  assert.equal(sale.body.estimate, 9360000);
  const saleJunk = await valuationPost(worker, { ...SIX, rentCondition: "xyz" }, withDb());
  assert.equal(saleJunk.status, 200, "rentCondition is irrelevant for sale");
  const junk = await valuationPost(worker, { ...rent, rentCondition: "xyz" }, withDb());
  assert.equal(junk.status, 400);
  assert.equal(junk.body.code, "INVALID_RENT_CONDITION");
});

test("whole-city fallback (E-2): a sub-area without a snapshot gets the real city snapshot, clearly flagged", async () => {
  const shop = await valuationPost(worker, { ...SIX, propertyType: "محل تجاري", size: 80 }, withDb());
  assert.equal(shop.status, 200);
  assert.equal(shop.body.fallback_used, true);
  assert.equal(shop.body.area_found, "مدينة نصر");
  assert.equal(shop.body.requested_area, "المنطقة السادسة");
  assert.equal(shop.body.fallback_reason, "no_snapshot_for_area");
  assert.equal(shop.body.estimate, 7200000);

  const invalid = await valuationPost(worker, SIX, withDb({
    rows: [snap(ID.zone6, { median: 52000, p25: 0, p75: 0 }), snap(ID.city, { median: 44000, p25: 39000, p75: 50000, n: 220 })],
  }));
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.fallback_used, true);
  assert.equal(invalid.body.fallback_reason, "invalid_snapshot_for_area");
  assert.equal(invalid.body.estimate, 44000 * 180);

  const rentFallback = await valuationPost(worker, { area: "المنطقة الثامنة", areaType: "rent", propertyType: "شقة", size: 120 }, withDb());
  assert.equal(rentFallback.status, 200);
  assert.equal(rentFallback.body.fallback_used, true);
  assert.equal(rentFallback.body.estimate, 310 * 120, "the whole-city 'all conditions' rent snapshot");

  for (const area of ["مدينة نصر (ككل)", "مدينة نصر"]) {
    const city = await valuationPost(worker, { ...SIX, area }, withDb());
    assert.equal(city.status, 200, area);
    assert.equal(city.body.fallback_used, false);
    assert.equal(city.body.estimate, 44000 * 180);
  }
});

test("no data → an error and no number: the type is never substituted and the city is never invented", async () => {
  const villa = await valuationPost(worker, { ...SIX, propertyType: "فيلا" }, withDb());
  assert.equal(villa.status, 503);
  assert.equal(villa.body.code, "MARKET_UNAVAILABLE");
  assert.equal("estimate" in villa.body, false, "no apartment numbers for a villa");
  const warehouse = await valuationPost(worker, { ...SIX, propertyType: "مخزن", size: 200 }, withDb());
  assert.equal(warehouse.status, 503);
  assert.equal(warehouse.body.code, "MARKET_UNAVAILABLE");
  assert.equal(warehouse.body.error, "لا توجد لقطة سوقية صالحة مطابقة للطلب حاليًا.");
  const noCity = await valuationPost(worker, SIX, withDb({ rows: [snap(ID.zone8, { median: 47000, p25: 42000, p75: 52000 })] }));
  assert.equal(noCity.status, 503, "neither the area nor the whole city has data");
  assert.equal("estimate" in noCity.body, false);
  const dbDown = await valuationPost(worker, SIX, { DB: brokenDb });
  assert.equal(dbDown.status, 503);
  assert.equal(dbDown.body.code, "MARKET_UNAVAILABLE");
  assert.equal("estimate" in dbDown.body, false);
});

test("E-3: every failure carries code + error + available_areas", async () => {
  const cases = [
    ["AREA_REQUIRED", 400, { ...SIX, area: "" }],
    ["TRANSACTION_REQUIRED", 400, { area: SIX.area, propertyType: SIX.propertyType, size: 180 }],
    ["PROPERTY_TYPE_REQUIRED", 400, { area: SIX.area, areaType: "sale", size: 180 }],
    ["UNSUPPORTED_PROPERTY_TYPE", 422, { ...SIX, propertyType: "قصر" }],
    ["INVALID_AREA_SIZE", 400, { ...SIX, size: 0 }],
    ["INVALID_AREA_SIZE", 400, { ...SIX, size: "" }],
    ["INVALID_RENT_CONDITION", 400, { ...SIX, areaType: "rent", rentCondition: "xyz" }],
    ["AREA_NOT_FOUND", 400, { ...SIX, area: "منطقة وهمية" }],
    ["AREA_NOT_FOUND", 400, { ...SIX, area: "مكرم عبيد" }],
    ["MARKET_UNAVAILABLE", 503, { ...SIX, propertyType: "مخزن" }],
  ];
  for (const [code, status, body] of cases) {
    const r = await valuationPost(worker, body, withDb());
    assert.equal(r.status, status, code);
    assert.equal(r.body.code, code);
    assert.equal(typeof r.body.error, "string");
    assert.ok(r.body.error.length > 0);
    assert.ok(Array.isArray(r.body.available_areas), `${code} must list available_areas`);
    assert.equal(r.body.available_areas.length, 31, code);
    assert.equal("estimate" in r.body, false, `${code} must not carry a number`);
  }
  // D1 نفسه واقع + خطأ تحقق: الرد سليم و available_areas فاضية بدل ما يتكسر
  const down = await valuationPost(worker, { ...SIX, size: 0 }, { DB: brokenDb });
  assert.equal(down.status, 400);
  assert.equal(down.body.code, "INVALID_AREA_SIZE");
  assert.deepEqual(down.body.available_areas, []);
});

test("E-4: only the requested area and the whole city are read from D1 (one narrowed query), same answer as a full read", async () => {
  const db = makeDb();
  const r = await valuationPost(worker, SIX, { DB: db });
  assert.equal(r.status, 200);
  const snapshotStatements = db.log.filter(l => /price_snapshots/.test(l.sql));
  assert.equal(snapshotStatements.length, 1, "the request and its fallback share one read");
  assert.match(snapshotStatements[0].sql, /WHERE area_id IN \(\?,\?\) LIMIT \?/);
  assert.deepEqual(snapshotStatements[0].binds, [22, 1, 1000]);
  assert.equal(db.log.filter(l => /areas/.test(l.sql)).length, 1);

  const cityDb = makeDb();
  await valuationPost(worker, { ...SIX, area: "مدينة نصر (ككل)" }, { DB: cityDb });
  assert.deepEqual(cityDb.log.find(l => /price_snapshots/.test(l.sql)).binds, [1, 1000]);

  const full = await valuationPost(worker, SIX, withDb({ failWhere: true }));
  assert.deepEqual(full.body.range, r.body.range);
  assert.equal(full.body.estimate, r.body.estimate);
});

test("E-4 fail-safe: a SQL error on the narrowed read falls back to the previous full read", async () => {
  const db = makeDb({ failWhere: true });
  const r = await valuationPost(worker, SIX, { DB: db });
  assert.equal(r.status, 200);
  assert.equal(r.body.estimate, 9360000);
  const statements = db.log.map(l => (/WHERE/.test(l.sql) ? "narrowed" : /price_snapshots/.test(l.sql) ? "full" : "areas"));
  assert.deepEqual(statements, ["areas", "narrowed", "full"]);
});

test("E-4 fail-safe: 0 rows from the narrowed read (e.g. area_id stored as text) also falls back — no false MARKET_UNAVAILABLE", async () => {
  const db = makeDb({ emptyWhere: true });
  const r = await valuationPost(worker, SIX, { DB: db });
  assert.equal(r.status, 200);
  assert.equal(r.body.estimate, 9360000);
  assert.equal(db.log.filter(l => /price_snapshots/.test(l.sql)).length, 2, "narrowed + full");
  const textIds = defaultRows().map(row => ({ ...row, area_id: String(row.area_id) }));
  const viaText = await valuationPost(worker, SIX, withDb({ rows: textIds, emptyWhere: true }));
  assert.equal(viaText.status, 200, "text ids are still understood by the JS filter");
});

test("E-4 removes the silent 1000-row truncation: target rows beyond the first 1000 are still found", async () => {
  const filler = Array.from({ length: 1500 }, () => snap(5, { median: 30000, p25: 25000, p75: 35000 }));
  const rows = [...filler, ...defaultRows()];
  const narrowed = await valuationPost(worker, SIX, withDb({ rows }));
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.estimate, 9360000);
  // نفس الجدول بالقراءة القديمة (SELECT * LIMIT 1000) كان هيفوّت اللقطات دي → نحاكيها بإجبار الرجوع للقراءة الكاملة
  const old = await valuationPost(worker, SIX, withDb({ rows, failWhere: true }));
  assert.equal(old.status, 503, "documented latent risk of the old read — what E-4 avoids");
});

test("E-5: the body cap counts real bytes — chunked bodies and bad JSON are rejected cleanly", async () => {
  const chunked = await worker.fetch(new Request("https://worker.test/api", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: chunkedJsonBody(40 * 1024), duplex: "half",
  }), withDb());
  assert.equal(chunked.status, 413);
  assert.equal((await chunked.json()).code, "REQUEST_TOO_LARGE");

  const declared = await worker.fetch(new Request("https://worker.test/api", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "20000" }, body: "{}",
  }), withDb()).catch(() => null);
  if (declared) assert.ok([413, 400].includes(declared.status));

  const ok = await valuationPost(worker, SIX, withDb());
  assert.equal(ok.status, 200, "a normal request is untouched");

  const bad = await valuationPost(worker, "{not json", withDb());
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_JSON");
  for (const payload of ["[]", "null", "42", '"text"']) {
    const r = await valuationPost(worker, payload, withDb());
    assert.equal(r.status, 400, payload);
    assert.equal(r.body.code, "INVALID_PAYLOAD");
  }
});

test("protocol: OPTIONS answers CORS for the site origin, other methods get 405 METHOD_NOT_ALLOWED", async () => {
  const preflight = await worker.fetch(new Request("https://worker.test/api", { method: "OPTIONS", headers: { Origin: "https://nasr-realestate.github.io" } }), withDb());
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://nasr-realestate.github.io");
  const stranger = await worker.fetch(new Request("https://worker.test/api", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), withDb());
  assert.notEqual(stranger.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
  const put = await worker.fetch(new Request("https://worker.test/api", { method: "PUT", body: "{}" }), withDb());
  assert.equal(put.status, 405);
  assert.equal((await put.json()).code, "METHOD_NOT_ALLOWED");
});

test("D1 is read-only: every statement the Worker prepares is a SELECT", async () => {
  const dbs = [makeDb(), makeDb({ failWhere: true }), makeDb({ emptyWhere: true })];
  for (const db of dbs) {
    await valuationPost(worker, SIX, { DB: db });
    await valuationPost(worker, { ...SIX, area: "منطقة وهمية" }, { DB: db });
    await worker.fetch(new Request("https://worker.test/areas"), { DB: db });
    assert.ok(db.log.length > 0);
    assert.ok(db.log.every(l => /^\s*SELECT\b/i.test(l.sql)), db.log.map(l => l.sql).join(" | "));
  }
  const prepared = [...workerSource.matchAll(/\.prepare\(\s*`([^`]*)`/g)];
  assert.ok(prepared.length >= 2);
  assert.ok(prepared.every(m => /^\s*SELECT\b/i.test(m[1])), "no INSERT/UPDATE/DELETE/DDL anywhere in the Worker");
});
