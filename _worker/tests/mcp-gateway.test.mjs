// Tests: _worker/mcp-worker.js — خادم MCP وواجهة القراءة الآلية
//
// كل الاختبارات تعمل **بدون شبكة**: `fetch` موك بالكامل، والتغذية مبنية من
// الملفات الحقيقية في _properties (عبر scripts/lib/properties.mjs) حتى
// تُختبر الأداة على بيانات فعلية لا على بيانات مُفبركة.
//
// التشغيل:
//   node --test _worker/tests/mcp-gateway.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { __test, RELEASE, callTool, filterProperties, buildStats, compactProperty, handleRpc } from "../mcp-worker.js";
import { loadProperties } from "../../scripts/lib/properties.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
   HERMETIC_NETWORK — الشبكة مقطوعة في هذا الملف بالكامل
   ───────────────────────────────────────────────────────────────────────────
   ⚠️ عطل حقيقي وقع في CI (2026-10-16): اختباران كانا يعتمدان على أن الطلب
   الحقيقي إلى https://nasr-realestate.github.io/ai-feed.json **يفشل**:
      • «health reports degraded + 503» — يفترض فشل التغذية فيُتوقّع 503.
      • «a failing upstream feed produces a clear error» — يفترض نفس الفشل.
   وقد نجحا محليًا فقط لأن بيئة التطوير تحجب هذه النطاقات أصلًا، بينما في
   GitHub Actions الشبكة تعمل: التغذية الحيّة تُقرأ بنجاح ⇒ 200 و isError=false
   ⇒ إخفاق البناء. الاختبار الذي يعتمد على حالة الشبكة ليس اختبارًا.

   الحل: نستبدل globalThis.fetch بدالة تفشل دائمًا **قبل** أي اختبار، وتسجّل
   كل محاولة. أي طلب حقيقي يصبح مستحيلًا، وأي اختبار يحتاج تغذية يحقنها
   صراحةً (cache أو fetchImpl) — فلا يعتمد شيء على الشبكة أو على كونها محجوبة.
   ═══════════════════════════════════════════════════════════════════════════ */
const REAL_FETCH = globalThis.fetch;
const NETWORK_ATTEMPTS = [];
const OFFLINE_FETCH = async (url) => {
  NETWORK_ATTEMPTS.push(String(url));
  throw new Error(`NETWORK_DISABLED_IN_TESTS: ${url}`);
};

before(() => { globalThis.fetch = OFFLINE_FETCH; });
after(() => { globalThis.fetch = REAL_FETCH; });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** تغذية حقيقية مبنية من _properties — بلا شبكة */
const REAL_PROPERTIES = loadProperties(path.join(REPO_ROOT, "_properties"));
const FEED = {
  schema_version: "3.0",
  brand: "سمسار طلبك",
  generated_at: "2026-10-16T00:00:00.000Z",
  total_count: REAL_PROPERTIES.length,
  properties: REAL_PROPERTIES,
};

function mockFetch({ feed = FEED, llms = "# catalog\n", failFeed = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("ai-feed.json")) {
      if (failFeed) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(feed), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("llms-full.txt")) {
      return new Response(llms, { status: 200, headers: { "content-type": "text/markdown" } });
    }
    return new Response("{}", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

/** يضبط الكاش المسبق حتى لا تُستدعى الشبكة إطلاقًا */
function prime(feed = FEED) {
  __test.setCache(feed);
}

function post(body, { fetchImpl, init = {} } = {}) {
  return worker.fetch(
    new Request("https://nasr-ai-gateway.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
    {},
    {},
  ).then(async (res) => ({ status: res.status, headers: res.headers, json: res.status === 202 ? null : await res.json() }));
}

test("RELEASE is declared and the worker exposes exactly one fetch handler", () => {
  assert.equal(typeof RELEASE, "string");
  assert.ok(RELEASE.startsWith("v"));
  assert.equal(typeof worker.fetch, "function");
});

/* ────────────────────────── CORS ────────────────────────── */

test("every response carries permissive CORS so any agent runtime can call it", async () => {
  const pre = await worker.fetch(new Request("https://nasr-ai-gateway.example/mcp", { method: "OPTIONS" }), {}, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
  assert.match(pre.headers.get("access-control-allow-headers"), /Mcp-Session-Id/);

  prime();
  const card = await worker.fetch(new Request("https://nasr-ai-gateway.example/"), {}, {});
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("access-control-allow-origin"), "*");
  const body = await card.json();
  assert.equal(body.read_only, true);
  assert.equal(body.requires_secrets, false, "the gateway must never need a secret to run");
});

/* ─────────────────── MCP handshake ─────────────────── */

test("initialize negotiates a supported protocol version and declares tool/resource/prompt capabilities", async () => {
  const supported = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } } });
  assert.equal(supported.status, 200);
  assert.equal(supported.json.result.protocolVersion, "2025-06-18");
  assert.equal(supported.json.result.serverInfo.name, "semsar-talabk");
  assert.ok(supported.json.result.capabilities.tools);
  assert.ok(supported.json.result.capabilities.resources);
  assert.ok(supported.json.result.capabilities.prompts);
  assert.match(supported.json.result.instructions, /سمسار طلبك/);
  assert.match(supported.json.result.instructions, /أسعار طلب/, "the broker's price policy must travel with the handshake");

  // إصدار غير معروف → نُعلن إصدارنا الرسمي بدل الرفض
  const unknown = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(unknown.json.result.protocolVersion, "2025-06-18");

  // إصدار أقدم مدعوم → نحترمه
  const legacy = await post({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(legacy.json.result.protocolVersion, "2024-11-05");
});

test("notifications (no id) are acknowledged with 202 and an empty body", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(res.json, null);
});

test("unknown methods and malformed payloads return JSON-RPC errors, never a 500", async () => {
  const unknown = await post({ jsonrpc: "2.0", id: 9, method: "does/not/exist" });
  assert.equal(unknown.json.error.code, -32601);

  const bad = await worker.fetch(new Request("https://nasr-ai-gateway.example/mcp", { method: "POST", body: "{not json" }), {}, {});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);

  const notObject = await post({ jsonrpc: "2.0", id: 10 });
  assert.equal(notObject.json.error.code, -32600);
});

test("GET /mcp answers 405 with Allow: POST — the server is stateless, not SSE", async () => {
  const res = await worker.fetch(new Request("https://nasr-ai-gateway.example/mcp"), {}, {});
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow"), /POST/);
  const body = await res.json();
  assert.match(body.detail, /stateless/);
});

/* ─────────────────── tools ─────────────────── */

test("tools/list exposes the five documented tools with strict input schemas", async () => {
  const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const names = res.json.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["search_properties", "get_property", "market_summary", "list_zones", "get_contact"]);
  for (const tool of res.json.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown arguments`);
    assert.ok(tool.description.length > 30, `${tool.name} needs a description a model can act on`);
  }
  const search = res.json.result.tools.find((t) => t.name === "search_properties");
  assert.equal(search.inputSchema.properties.limit.maximum, 50, "limit must be capped so one call can never flood a context window");
});

test("search_properties filters on real data and returns a compact, citable list", async () => {
  prime();
  const out = await callTool("search_properties", { transaction: "rent", property_type: "shop", limit: 5 });
  const sc = out.structuredContent;
  assert.ok(sc.total_count === FEED.total_count);
  assert.ok(sc.properties.length > 0 && sc.properties.length <= 5);
  for (const p of sc.properties) {
    assert.equal(p.transaction, "rent");
    assert.equal(p.propertyType, "shop");
    assert.ok(p.url.startsWith("https://nasr-realestate.github.io/properties/"));
    assert.ok(p.priceNumeric > 0);
    assert.match(p.price_note, /قابل للتفاوض/);
  }
  assert.match(out.content[0].text, /أسعار طلب قابلة للتفاوض/);
  assert.match(out.content[0].text, /سمسار طلبك/);
  // الترتيب: الأحدث أولًا
  const dates = sc.properties.map((p) => p.datePosted);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("search_properties never invents a price for a unit that has none", async () => {
  const feed = {
    ...FEED,
    properties: [
      { slug: "no-price", title: "وحدة بلا سعر معلن", url: "https://nasr-realestate.github.io/properties/no-price/", transaction: "sale", propertyType: "apartment", price: "للاستعلام", priceNumeric: null, areaNumeric: 120, date: "2026-01-01" },
    ],
  };
  prime(feed);
  const out = await callTool("search_properties", {});
  assert.equal(out.structuredContent.properties[0].priceNumeric, null);
  assert.match(out.content[0].text, /للاستعلام/);
  assert.doesNotMatch(out.content[0].text, /0 ج\.م/);
});

test("search_properties caps results and tells the model how to see more", async () => {
  prime();
  const out = await callTool("search_properties", { limit: 1000 });
  assert.ok(out.structuredContent.returned <= 50);
  if (out.structuredContent.matched_count > out.structuredContent.returned) {
    assert.match(out.content[0].text, /زد قيمة limit/);
  }
});

test("an empty match set is reported as empty — never padded with a near miss", async () => {
  prime();
  const out = await callTool("search_properties", { zone: "منطقة-لا-توجد-إطلاقا", min_price: 900000000 });
  assert.equal(out.structuredContent.returned, 0);
  assert.equal(out.structuredContent.properties.length, 0);
  assert.match(out.content[0].text, /لا توجد وحدة/);
});

test("get_property resolves by slug, by full URL and by file name; misses are explicit", async () => {
  prime();
  const sample = FEED.properties[0];

  for (const id of [sample.slug, sample.url, `${sample.url.replace(/\/$/, "")}`, `${sample.slug}.json`]) {
    const out = await callTool("get_property", { id });
    assert.ok(!out.isError, `should resolve: ${id}`);
    assert.equal(out.structuredContent.slug, sample.slug);
  }

  const miss = await callTool("get_property", { id: "definitely-not-a-real-unit" });
  assert.equal(miss.isError, true);
  assert.equal(miss.structuredContent.error, "NOT_FOUND");
  assert.ok(miss.structuredContent.suggestion.length > 0);

  const blank = await callTool("get_property", { id: "" });
  assert.equal(blank.isError, true);
});

test("market_summary is derived from real asking prices and states the method", async () => {
  prime();
  const out = await callTool("market_summary", { property_type: "apartment", transaction: "sale" });
  const stats = out.structuredContent;
  assert.ok(stats.total > 0);
  const sale = stats.price_by_type.apartment.sale;
  assert.ok(sale.min <= sale.median && sale.median <= sale.max);
  assert.ok(sale.count > 0);
  assert.match(stats.method, /أسعار طلب/);
  assert.match(out.content[0].text, /الوسيط/);

  const scoped = await callTool("market_summary", { transaction: "rent", property_type: "villa" });
  assert.ok(scoped.structuredContent.total >= 0);
});

test("list_zones and get_contact return sourced facts only", async () => {
  prime();
  const zones = await callTool("list_zones", {});
  assert.ok(zones.structuredContent.total_zones > 5);
  const total = Object.values(zones.structuredContent.zones).reduce((a, b) => a + b, 0);
  assert.ok(total > 0 && total <= FEED.total_count);

  const contact = await callTool("get_contact", {});
  assert.equal(contact.structuredContent.whatsapp, "+201147758857");
  assert.equal(contact.structuredContent.brand, "سمسار طلبك");
  assert.equal(contact.structuredContent.rating.source, "Google Maps — صفحة النشاط");
  assert.match(out(zones), /وحدة/);
});

function out(result) {
  return result.content.map((c) => c.text).join("\n");
}

test("unknown tool names fail loudly with the list of valid tools", async () => {
  prime();
  const res = await post({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  assert.equal(res.status, 200, "protocol errors ride inside a 200 body for tools/call");
  assert.equal(res.json.result.isError, true);
  assert.equal(res.json.result.structuredContent.error, "UNKNOWN_TOOL");
  assert.ok(res.json.result.structuredContent.available.includes("search_properties"));

  const noName = await post({ jsonrpc: "2.0", id: 12, method: "tools/call", params: {} });
  assert.equal(noName.json.error.code, -32602);
});

test("a failing upstream feed produces a clear error instead of an empty-but-happy answer", async () => {
  // الشبكة مقطوعة في هذا الملف (انظر HERMETIC_NETWORK)، فالتغذية تفشل حتمًا.
  __test.resetCache();
  const res = await post({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "search_properties", arguments: {} } }, { });
  assert.equal(res.json.result.isError, true);
  assert.equal(res.json.result.structuredContent.error, "FEED_UNAVAILABLE");
  assert.match(res.json.result.content[0].text, /غير متاحة/);

  // ومع وجود نسخة قديمة في الذاكرة، نخدم النسخة القديمة بدل الفشل
  prime();
  const stale = await callTool("search_properties", {}, { fetchImpl: mockFetch({ failFeed: true }) });
  assert.ok(!stale.isError);
  assert.ok(stale.structuredContent.returned > 0);
});

/* ─────────────────── resources & prompts ─────────────────── */

test("resources/list + resources/read stream the same source of truth", async () => {
  prime();
  const list = await post({ jsonrpc: "2.0", id: 20, method: "resources/list" });
  const uris = list.json.result.resources.map((r) => r.uri);
  assert.deepEqual(uris, ["semsar://catalog", "semsar://llms-full", "semsar://contact", "semsar://stats"]);

  const catalog = await post({ jsonrpc: "2.0", id: 21, method: "resources/read", params: { uri: "semsar://catalog" } });
  const parsed = JSON.parse(catalog.json.result.contents[0].text);
  assert.equal(parsed.total_count, FEED.total_count);
  assert.equal(parsed.properties.length, FEED.total_count);
  assert.equal(catalog.json.result.contents[0].mimeType, "application/json");

  // مسار llms-full يحاول الشبكة ثم يسقط إلى الكتالوج المحلي — وهو السلوك
  // الصحيح تمامًا في بيئة بلا شبكة، ولذلك نتحقق من المحتوى لا من المصدر.
  const llms = await post({ jsonrpc: "2.0", id: 22, method: "resources/read", params: { uri: "semsar://llms-full" } }, {});
  assert.equal(llms.json.result.contents[0].uri, "semsar://llms-full");
  assert.equal(llms.json.result.contents[0].mimeType, "text/markdown");
  assert.match(llms.json.result.contents[0].text, /كتالوج سمسار طلبك|سمسار طلبك/);

  // والحقن الصريح يعمل أيضًا: تغذية llms-full عبر fetchImpl بلا شبكة
  const injected = await callTool("list_zones", {}, { fetchImpl: mockFetch({ llms: "# نسخة محقونة\n" }) });
  assert.ok(injected.structuredContent.total_zones > 0);
  const viaInjection = await post({ jsonrpc: "2.0", id: 25, method: "resources/read", params: { uri: "semsar://llms-full" } });
  assert.equal(viaInjection.json.result.contents[0].uri, "semsar://llms-full");

  const missing = await post({ jsonrpc: "2.0", id: 23, method: "resources/read", params: { uri: "semsar://nope" } });
  assert.equal(missing.json.error.code, -32002);

  const noUri = await post({ jsonrpc: "2.0", id: 24, method: "resources/read", params: {} });
  assert.equal(noUri.json.error.code, -32602);
});

test("prompts/get builds an anti-fabrication instruction set", async () => {
  const res = await post({ jsonrpc: "2.0", id: 30, method: "prompts/get", params: { name: "recommend_units", arguments: { need: "شقة 3 غرف للإيجار", budget: "30000" } } });
  const text = res.json.result.messages[0].content.text;
  assert.match(text, /شقة 3 غرف للإيجار/);
  assert.match(text, /30000/);
  assert.match(text, /بدل اختراع وحدة/);
  assert.match(text, /أسعار طلب/);

  const unknown = await post({ jsonrpc: "2.0", id: 31, method: "prompts/get", params: { name: "nope" } });
  assert.equal(unknown.json.error.code, -32602);
});

/* ─────────────────── REST surface ─────────────────── */

test("REST endpoints mirror the MCP surface and clamp the limit", async () => {
  prime();
  const list = await worker.fetch(new Request("https://nasr-ai-gateway.example/api/properties?transaction=sale&limit=3"), {}, {});
  const body = await list.json();
  assert.equal(body.returned, 3);
  assert.equal(body.matched_count, body.properties.length + (body.matched_count - 3));
  assert.ok(body.properties.every((p) => p.transaction === "sale"));
  assert.match(body.citation, /سمسار طلبك/);

  const one = await worker.fetch(new Request(`https://nasr-ai-gateway.example/api/properties/${FEED.properties[0].slug}`), {}, {});
  assert.equal(one.status, 200);
  assert.equal((await one.json()).slug, FEED.properties[0].slug);

  const missing = await worker.fetch(new Request("https://nasr-ai-gateway.example/api/properties/nope-nope"), {}, {});
  assert.equal(missing.status, 404);

  const stats = await worker.fetch(new Request("https://nasr-ai-gateway.example/api/stats"), {}, {});
  assert.equal((await stats.json()).total, FEED.total_count);

  const zones = await worker.fetch(new Request("https://nasr-ai-gateway.example/api/zones"), {}, {});
  const z = await zones.json();
  assert.equal(z.total_properties, FEED.total_count);

  const unknown = await worker.fetch(new Request("https://nasr-ai-gateway.example/whatever"), {}, {});
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).hint, /\/mcp/);
});

test("health reports degraded + 503 when the feed cannot be read at all", async () => {
  // لا حقن هنا عن قصد: نريد اختبار السلوك الافتراضي (fetch العالمي) داخل
  // بيئة بلا شبكة إطلاقًا — وهو ما يمنع عودة الاعتماد على حالة الشبكة.
  __test.resetCache();
  const res = await worker.fetch(new Request("https://nasr-ai-gateway.example/health"), {}, {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.read_only, true);
  assert.equal(body.feed_url, "https://nasr-realestate.github.io/ai-feed.json");
});

/* ─────────────────── عزل المصدر (قواعد المستودع) ─────────────────── */

test("the gateway is read-only and self-contained: no writes, no secrets, no imports", () => {
  const code = fs.readFileSync(path.join(REPO_ROOT, "_worker", "mcp-worker.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import\s/m, "a self-contained worker imports nothing");
  assert.doesNotMatch(code, /\bDB\b\s*\.|\benv\.DB\b/, "no D1 binding access");
  assert.doesNotMatch(code, /GEMINI_API_KEY|IMGBB_API_KEY|VAPID|PUSH_SEND_SECRET/, "no secret is required");
  assert.doesNotMatch(code, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/, "never issues a write request upstream");
  assert.doesNotMatch(code, /\.prepare\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i, "no SQL write paths");
});

test("filter logic is deterministic and treats an absent numeric as non-matching", () => {
  const rows = [
    { slug: "a", title: "شقة", priceNumeric: 100, areaNumeric: 100, roomsNumeric: 2, transaction: "sale", propertyType: "apartment", furnished: "مفروش", zone: "المنطقة السادسة" },
    { slug: "b", title: "محل", priceNumeric: null, areaNumeric: 50, roomsNumeric: null, transaction: "rent", propertyType: "shop", furnished: "", zone: "عباس العقاد" },
  ];
  assert.equal(filterProperties(rows, { max_price: 500 }).length, 1, "a null price must not satisfy a price filter");
  assert.equal(filterProperties(rows, { min_price: 50 }).length, 1);
  assert.equal(filterProperties(rows, { min_rooms: 1 }).length, 1, "a null room count must not satisfy a room filter");
  assert.equal(filterProperties(rows, { furnished: true }).length, 1);
  assert.equal(filterProperties(rows, { zone: "العقاد" }).length, 1);
  assert.equal(filterProperties(rows, { property_type: "shop" }).length, 1);
  assert.equal(filterProperties(rows, { query: "محل" }).length, 1);
});

test("buildStats never divides by zero and omits empty buckets", () => {
  assert.deepEqual(buildStats([]).by_transaction, {});
  assert.equal(buildStats([]).total, 0);
  const s = buildStats([{ transaction: "sale", propertyType: "apartment", priceNumeric: 1000, zone: "x" }]);
  assert.equal(s.overall.sale.median, 1000);
  assert.equal(s.overall.rent, null);
});

test("the suite is hermetic: no test may reach the real network", () => {
  // لو نُفِّذ طلب حقيقي في أي اختبار أعلاه لظهر في NETWORK_ATTEMPTS، ولأن
  // الدالة ترمي دائمًا فلن تستطيع أي تغذية حيّة أن تُغيّر النتائج.
  assert.notEqual(globalThis.fetch, REAL_FETCH, "the offline stub must stay installed for the whole file");
  const hosts = new Set(NETWORK_ATTEMPTS.map((u) => new URL(u).host));
  for (const host of hosts) {
    assert.equal(host, "nasr-realestate.github.io", `unexpected outbound host in tests: ${host}`);
  }
  // هناك محاولات متوقّعة (اختبارات الفشل الصريح) — لكنها لم تنجح قط.
  assert.ok(NETWORK_ATTEMPTS.every((u) => u.startsWith("https://nasr-realestate.github.io/")));
});

test("compactProperty publishes a stable contract for downstream models", () => {
  const p = compactProperty(FEED.properties[0]);
  assert.deepEqual(Object.keys(p).sort(), [
    "area", "areaNumeric", "bathsNumeric", "currency", "datePosted", "finish", "floor",
    "furnished", "id", "image", "location", "price", "priceNumeric", "price_note",
    "propertyType", "roomsNumeric", "slug", "title", "transaction", "url", "zone",
  ]);
  assert.equal(p.currency, "EGP");
  assert.ok(!("_derived" in p), "internal derivation flags must never leak to a client");
});
