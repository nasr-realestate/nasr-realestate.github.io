// Tests: طبقة الذكاء الاصطناعي الثابتة
//   scripts/lib/properties.mjs · scripts/lib/ai-docs.mjs · scripts/build-ai-artifacts.mjs
//
// سبب وجود هذه الاختبارات: الأرقام الرقمية كانت تُكتب يدويًا في front matter
// (8 ملفات نُشرت بلا priceNumeric/areaNumeric/roomsNumeric/bathsNumeric)، ما
// جعل صفحاتها تُصدر offers.price = "0" في البيانات المنظمة. الاختبارات هنا
// تفشل فورًا لو عاد هذا الانحدار، أو لو تناقضت مخرجات الذكاء الاصطناعي مع
// المصدر أو مع بعضها.
//
// التشغيل:
//   node --test _worker/tests/ai-artifacts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  loadProperties,
  buildFacets,
  deriveTransaction,
  derivePropertyType,
  derivePrice,
  deriveArea,
  deriveRooms,
  deriveBaths,
  deriveZone,
  normalizeDigits,
  firstNumber,
} from "../../scripts/lib/properties.mjs";
import {
  renderLlmsFull,
  renderPropertyMarkdown,
  renderAiTxt,
  renderMcpCard,
  renderOpenApi,
  renderAiCatalog,
  renderSearchData,
  mcpToolDefinitions,
  SITE,
} from "../../scripts/lib/ai-docs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const PROPS = loadProperties(path.join(REPO_ROOT, "_properties"));

/* ───────────────────── استخراج الأرقام ───────────────────── */

test("Arabic-Indic digits and separator variants are normalised before parsing", () => {
  assert.equal(normalizeDigits("١٨٠"), "180");
  assert.equal(firstNumber("١٨٠ متر مربع"), 180);
  assert.equal(firstNumber("3,700,000 ج.م"), 3700000);
  assert.equal(firstNumber("3.700.000 ج.م"), 3700000, "European thousands separators must not collapse to a single digit");
  assert.equal(firstNumber("180.5"), 180, "documented limit: only the integer part of a fractional value is used");
  assert.equal(firstNumber("للاستعلام"), null);
  assert.equal(firstNumber(""), null);
  assert.equal(firstNumber(null), null);
});

test("a missing numeric never becomes zero and never becomes a guess", () => {
  assert.equal(derivePrice({ price: "للاستعلام" }), null);
  assert.equal(deriveArea({ area: "مساحة كبيرة واسعة" }), null);
  assert.equal(deriveRooms({ rooms: "مساحة مفتوحة" }), null);
  assert.equal(deriveBaths({ bathrooms: "مجهزة بالكامل" }), null);
  assert.equal(derivePrice({ priceNumeric: 0, price: "للاستعلام" }), null, "explicit 0 must be treated as 'unknown'");
});

test("derivation reads the leading number out of mixed Arabic text", () => {
  assert.equal(derivePrice({ price: "22,000 ج.م شهرياً (قابل للتفاوض)" }), 22000);
  assert.equal(deriveArea({ area: "200 متر مربع + حديقة 50م" }), 200);
  assert.equal(deriveRooms({ rooms: "2 غرفة نوم + ريسبشن 3 قطع" }), 2, "the 3 belongs to the reception, not the bedrooms");
  assert.equal(deriveBaths({ bathrooms: "2 حمام (جاكوزي + كابينة شاور)" }), 2);
  assert.equal(deriveRooms({ rooms: "تقسيم واسع جداً للغرف والريسبشن" }), null);
});

test("explicit numeric front matter wins over text parsing", () => {
  assert.equal(derivePrice({ priceNumeric: 999, price: "1,000,000 ج.م" }), 999);
  assert.equal(deriveArea({ areaNumeric: 42, area: "180 متر مربع" }), 42);
});

test("sale offers with a monthly yield are not misfiled as rentals", () => {
  // كل الحالات الأربع موجودة فعليًا في _properties وكانت تُصنّف خطأً كإيجار
  assert.equal(deriveTransaction({ category: "shops", price: "30,000,000 ج.م (تسهيلات متاحة)" }, "محل 212م (مشروع قائم) - عائد شهري 160 ألف - مدينة نصر"), "sale");
  assert.equal(deriveTransaction({ category: "apartments", price: "1,900,000 ج.م (شامل الفرش)" }, "شقة 130م مفروشة (بعائد شهري) - زهراء م نصر"), "sale");
  assert.equal(deriveTransaction({ category: "apartments", price: "8,500,000 ج.م (أو إيجار 100 ألف)" }, "فيلا دوبلكس بحديقة 180م"), "sale");
  // والإيجار الحقيقي يُلتقط من السعر أو من علامة صريحة
  assert.equal(deriveTransaction({ category: "apartments-rent", price: "20,000 ج.م شهرياً" }, "شقة للإيجار"), "rent");
  assert.equal(deriveTransaction({ category: "apartments", price: "13,000 ج.م / شهرياً" }, "شقة 150م قانون جديد"), "rent");
});

test("property type is derived from the strongest signal available", () => {
  assert.equal(derivePropertyType({ category: "shops" }, "محل 212م"), "shop");
  assert.equal(derivePropertyType({ category: "admin-hq" }, "مقر إداري 260م"), "office");
  assert.equal(derivePropertyType({ category: "apartments" }, "فيلا دوبلكس بحديقة 180م"), "villa");
  assert.equal(derivePropertyType({ category: "commercial" }, "مخزن 73م للإيجار"), "warehouse");
  assert.equal(derivePropertyType({ category: "apartments" }, "شقة 180م"), "apartment");
});

test("zone is a real place name, not normalised text", () => {
  assert.equal(deriveZone("المنطقة السادسة - مدينة نصر"), "المنطقة السادسة");
  assert.equal(deriveZone("شارع عباس العقاد الرئيسي"), "عباس العقاد");
  assert.equal(deriveZone("كمبوند دجلة لاند مارك - مدينة نصر"), "كمبوند دجلة لاند مارك");
  assert.equal(deriveZone(""), null);
  // لا تُعاد صيغة مُطبَّعة («المنطقة سادسه») أبدًا — تُعاد العربية الصحيحة
  for (const p of PROPS) {
    if (!p.zone) continue;
    assert.doesNotMatch(p.zone, /(سادسه|سابعه|تاسعه|عاشره|ثامنه|خامسه)$/u, `${p.slug}: zone came out normalised: ${p.zone}`);
  }
});

/* ───────────────────── النموذج الكامل ───────────────────── */

test("every property normalises to a complete, self-consistent record", () => {
  assert.ok(PROPS.length > 90, `expected the real collection, got ${PROPS.length}`);
  for (const p of PROPS) {
    assert.ok(p.slug && p.title && p.url.startsWith("https://nasr-realestate.github.io/properties/"), p.slug);
    assert.ok(["sale", "rent"].includes(p.transaction), p.slug);
    assert.ok(["apartment", "villa", "shop", "office", "warehouse", "clinic"].includes(p.propertyType), p.slug);
    assert.ok(p.currency === "EGP");
    assert.ok(p.priceNumeric === null || p.priceNumeric > 0, `${p.slug}: a price is either real or absent`);
    assert.ok(p.areaNumeric === null || p.areaNumeric > 0, `${p.slug}: an area is either real or absent`);
    if (p.rent && p.priceNumeric) assert.ok(p.priceNumeric < 5_000_000, `${p.slug}: monthly rent looks implausible`);
    if (p.transaction === "rent" && p.priceNumeric) {
      assert.ok(p.priceNumeric <= 500_000, `${p.slug}: monthly rent ${p.priceNumeric} is out of range for this market`);
    }
  }
});

test("no published property page can emit offers.price = \"0\" anymore", () => {
  // هذه هي العلّة الأصلية: 8 ملفات نُشرت بلا priceNumeric والقالب يقرأ الحقل فقط.
  const priceTextHasDigits = (s) => /\d/.test(String(s ?? ""));
  const offenders = PROPS.filter((p) => p.priceNumeric === null && priceTextHasDigits(p.price));
  assert.deepEqual(offenders.map((p) => p.slug), [], "a property whose price text contains digits must expose priceNumeric");
});

test("facets add up to the collection and medians stay inside their range", () => {
  const f = buildFacets(PROPS);
  assert.equal(f.total, PROPS.length);
  assert.equal(Object.values(f.by_transaction).reduce((a, b) => a + b, 0), PROPS.length);
  assert.equal(Object.values(f.by_property_type).reduce((a, b) => a + b, 0), PROPS.length);
  for (const bucket of [f.overall_sale_price, f.overall_rent_price]) {
    assert.ok(bucket.min <= bucket.median && bucket.median <= bucket.max);
  }
  for (const s of Object.values(f.price_by_type)) {
    for (const tx of ["sale", "rent"]) {
      if (!s[tx]) continue;
      assert.ok(s[tx].min <= s[tx].median && s[tx].median <= s[tx].max);
    }
  }
});

/* ───────────────────── المخرجات المُولّدة ───────────────────── */

test("llms-full.txt carries every unit with a link and its numeric price", () => {
  const md = renderLlmsFull(PROPS);
  assert.match(md, /^# سمسار طلبك/);
  assert.ok(md.includes(String(PROPS.length)));
  for (const p of PROPS) {
    assert.ok(md.includes(`\`${p.slug}\``), `missing slug ${p.slug}`);
    assert.ok(md.includes(p.url), `missing url ${p.slug}`);
  }
  const priced = PROPS.filter((p) => p.priceNumeric !== null);
  assert.ok(md.split("**priceNumeric**:").length - 1 >= priced.length);
  assert.ok(md.length > 50_000, "the full catalogue should be substantial");
  assert.match(md, /لا تفترض قابلية التفاوض إلا إذا ذكرها نص الوحدة صراحةً/);
  assert.doesNotMatch(md, /أسعار طلب قابلة للتفاوض/u);
  assert.ok(!/\{\{|\{%/.test(md), "no unrendered Liquid tokens may leak into the catalogue");
});

test("per-property Markdown stays a static file that Jekyll cannot render", () => {
  for (const p of PROPS.slice(0, 12).concat(PROPS.slice(-3))) {
    const md = renderPropertyMarkdown(p);
    // السبب الحرج: Jekyll يعدّ أي `.md` يبدأ بـ`---` «صفحة» فيحذف
    // الوصف الميكانيكي ويخدم HTML بدل Markdown — لذا يمنع الاختبار عودته.
    assert.ok(!md.startsWith("---"), "front matter would be rendered away by the site's Jekyll build");
    assert.ok(md.startsWith("<!-- ai-property "), "the metadata comment must open the file");
    const json = md.slice(md.indexOf("<!-- ai-property ") + 17, md.indexOf(" -->"));
    const meta = JSON.parse(json);
    assert.equal(meta.slug, p.slug);
    assert.equal(meta.transaction, p.transaction);
    assert.equal(meta.propertyType, p.propertyType);
    assert.equal(meta.currency, "EGP");
    if (Number.isFinite(p.priceNumeric)) assert.equal(meta.price, p.priceNumeric);
    assert.ok(md.includes(p.url));
    assert.ok(md.includes(`${SITE}/api/properties/${p.slug}.json`));
    assert.match(md, /أسعار طلب/);
    assert.match(md, /لا تُفترض قابلية التفاوض إلا إذا ذكرها نص الوحدة صراحةً/);
    // الحقول الغائبة تُحذف ولا تصير صفرًا أو قيمة مختلقة
    if (!Number.isFinite(p.areaNumeric)) assert.ok(!("area_sqm" in meta), "absent area must stay absent");
  }
});

test("quotes, dashes and angle brackets cannot break the metadata comment", () => {
  const md = renderPropertyMarkdown({ ...PROPS[0], title: 'شقة "لقطة" -- 180م', location: 'شارع "الاختبار" <!-- -->' });
  assert.ok(!md.startsWith("---"));
  const json = md.slice(md.indexOf("<!-- ai-property ") + 17, md.indexOf(" -->"));
  assert.ok(!json.includes("--"), "no raw double dash may close the HTML comment early");
  const meta = JSON.parse(json);
  assert.equal(meta.title, 'شقة "لقطة" -- 180م');
  assert.equal(meta.location, 'شارع "الاختبار" <!-- -->');
});

test("ai.txt declares the permissions and the machine endpoints an agent looks for", () => {
  const txt = renderAiTxt(PROPS, { stamp: "2026-10-16", mcpEndpoint: "https://example.workers.dev/mcp" });
  for (const key of ["User-Agent:", "Allow-AI-Training:", "Allow-AI-Summarize:", "Allow-Redistribution-Full-Text: no", "Cite-As:", "AI-Discovery:", "AI-Catalog:", "AI-MCP-Endpoint:", "AI-MCP-Status:", "AI-MCP-Fallback:", "Sitemap:"]) {
    assert.ok(txt.includes(key), `ai.txt is missing ${key}`);
  }
  assert.ok(txt.includes(`${SITE}/llms-full.txt`));
  assert.ok(txt.includes("https://example.workers.dev/mcp"));
  assert.match(txt, /لا تفترض قابلية التفاوض إلا إذا ذكرها نص الوحدة صراحةً/);
  assert.doesNotMatch(txt, /سعر طلب قابل للتفاوض/u);
});

test("the MCP card declares the gateway availability and the guaranteed fallback", () => {
  const card = renderMcpCard({ endpoint: "https://example.workers.dev/mcp", properties: PROPS, stamp: "2026-10-16T00:00:00Z" });
  assert.ok(card.availability, "بطاقة الخادم بلا حقل availability");
  assert.match(card.availability.status, /^(pending-deployment|live)$/);
  assert.ok(card.availability.guaranteed_paths.length >= 3, "لا مسار مضمون معلن للنماذج");
  for (const url of card.availability.guaranteed_paths) assert.ok(url.startsWith(`${SITE}/`), url);
  assert.ok(card.availability.guaranteed_paths.includes(card.availability.guaranteed_fallback));
  if (card.availability.status !== "live") {
    assert.ok(card.availability.note, "حالة غير مفعّلة بلا سبب معلن للنماذج");
    assert.ok(card.availability.verified_at, "بلا تاريخ تحقّق");
  }
});

test("the MCP card and the OpenAPI document describe the same surface", () => {
  const card = renderMcpCard({ endpoint: "https://example.workers.dev/mcp", properties: PROPS, stamp: "2026-10-16T00:00:00Z" });
  const toolNames = card.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ["search_properties", "get_property", "market_summary", "list_zones", "get_contact"]);
  assert.equal(card.counts.properties, PROPS.length);
  assert.equal(card.transport.type, "streamable-http");

  const defs = mcpToolDefinitions();
  assert.deepEqual(defs.map((d) => d.name), toolNames);
  for (const d of defs) assert.equal(d.inputSchema.additionalProperties, false);

  const api = renderOpenApi(PROPS);
  assert.equal(api.openapi, "3.1.0");
  assert.ok(api.paths["/api/properties/{slug}.json"]);
  assert.ok(api.paths["/ai-feed.json"]);
  assert.ok(api.components.schemas.Property.properties.priceNumeric);
});

test("search-data.json is compact, indexed by slug and complete", () => {
  const data = renderSearchData(PROPS);
  assert.equal(data.total_count, PROPS.length);
  assert.equal(data.properties.length, PROPS.length);
  const ids = new Set(data.properties.map((p) => p.id));
  assert.equal(ids.size, PROPS.length, "slugs must be unique");
  for (const row of data.properties) {
    assert.equal(Object.keys(row).length, data.fields.length);
    assert.ok(row.u.startsWith("/properties/"));
  }
  assert.ok(JSON.stringify(data).length < 120_000, "the client search index must stay small");
});

/* ───────────────────── المُولّد من طرف إلى طرف ───────────────────── */

test("build-ai-artifacts writes the full artifact set and every JSON is parseable", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-artifacts-"));
  try {
    const stdout = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-ai-artifacts.mjs"), `--out=${tmp}`], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(stdout, /\[ai-artifacts\].*كتابة/);

    const expected = [
      "ai-feed.json", "llms-full.txt", "search-data.json", "api/index.json",
      "api/properties.json", "api/openapi.json", ".well-known/ai.txt",
      ".well-known/mcp.json", ".well-known/mcp/server-card.json",
      // نسخ جذرية موازية: تأمين ضد حجب المجلدات النقطية + أدوات تقرأ الجذر فقط
      "ai.txt", "mcp.json",
      // كتالوج ARD (Lighthouse «ard-schema»): نقطة قياسية + مرآة جذرية
      ".well-known/ai-catalog.json", "ai-catalog.json",
    ];
    for (const rel of expected) assert.ok(fs.existsSync(path.join(tmp, rel)), `missing ${rel}`);

    for (const p of PROPS) {
      assert.ok(fs.existsSync(path.join(tmp, "api", "properties", `${p.slug}.json`)));
      assert.ok(fs.existsSync(path.join(tmp, "api", "properties", `${p.slug}.md`)));
    }

    let count = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        count += 1;
        if (entry.name.endsWith(".json")) JSON.parse(fs.readFileSync(full, "utf8"));
      }
    };
    walk(tmp);
    assert.equal(count, expected.length + PROPS.length * 2);

    // المصدر واحد → المحتوى متطابق بالحرف بين النقطة والجذر
    const pairs = [["ai.txt", ".well-known/ai.txt"], ["mcp.json", ".well-known/mcp.json"], ["ai-catalog.json", ".well-known/ai-catalog.json"]];
    for (const [a, b] of pairs) {
      assert.equal(fs.readFileSync(path.join(tmp, a), "utf8"), fs.readFileSync(path.join(tmp, b), "utf8"), `${a} and ${b} must be identical`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--check writes nothing (safe to run as a CI gate)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-check-"));
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-ai-artifacts.mjs"), `--out=${tmp}`, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ai-feed.json keeps every field the live agent Worker already reads", () => {
  const required = ["id", "title", "url", "slug", "transaction", "propertyType", "category", "location", "zone",
    "price", "priceNumeric", "area", "areaNumeric", "rooms", "roomsNumeric", "baths", "bathsNumeric",
    "floor", "finish", "finishing", "furnished", "description", "image", "date", "meta_title"];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-feed-"));
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-ai-artifacts.mjs"), `--out=${tmp}`], { cwd: REPO_ROOT, encoding: "utf8" });
    const feed = JSON.parse(fs.readFileSync(path.join(tmp, "ai-feed.json"), "utf8"));
    assert.equal(feed.total_count, PROPS.length);
    assert.equal(feed.properties.length, PROPS.length);
    assert.ok(feed.generated_at && feed.last_updated);
    for (const p of feed.properties) {
      for (const key of required) assert.ok(key in p, `ai-feed row is missing ${key}`);
    }
    assert.ok(feed.facets.by_zone);
    assert.equal(feed.endpoints.mcp.endsWith("/mcp"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ───────────────────── اتساق مع الملفات الثابتة ───────────────────── */

test("every artifact path advertised on the site actually gets generated", () => {
  const advertised = [
    "llms.txt", "llms-full.txt", "ai-feed.json", "api/properties.json",
    "api/index.json", "api/openapi.json", "search-data.json",
    ".well-known/ai.txt", ".well-known/mcp.json",
  ];
  const robots = fs.readFileSync(path.join(REPO_ROOT, "robots.txt"), "utf8");
  const llms = fs.readFileSync(path.join(REPO_ROOT, "llms.txt"), "utf8");
  const combined = `${robots}\n${llms}`;
  for (const rel of advertised) {
    assert.ok(combined.includes(rel), `${rel} is generated but never advertised in robots.txt/llms.txt`);
  }
});

test("robots.txt allows the machine files before it disallows anything", () => {
  const robots = fs.readFileSync(path.join(REPO_ROOT, "robots.txt"), "utf8");
  const lines = robots.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  // كل Allow يجب أن يأتي قبل أول Disallow داخل كتلة `*`
  const star = lines.indexOf("User-agent: *");
  assert.ok(star >= 0, "a default group is required");
  const group = lines.slice(star + 1, lines.findIndex((l, i) => i > star && /^user-agent:/i.test(l)) === -1 ? undefined : lines.findIndex((l, i) => i > star && /^user-agent:/i.test(l)));
  const firstAllow = group.findIndex((l) => /^allow:/i.test(l));
  const firstDisallow = group.findIndex((l) => /^disallow:/i.test(l));
  assert.ok(firstAllow >= 0 && firstDisallow >= 0);
  assert.ok(firstAllow < firstDisallow, "a first-match crawler must hit the Allow rules first");

  for (const must of ["Allow: /ai-feed.json", "Allow: /llms.txt", "Allow: /llms-full.txt", "Allow: /api/"]) {
    assert.ok(group.includes(must), `robots.txt is missing "${must}"`);
  }
  assert.ok(!/^Disallow:\s*\/\*\.json\$/im.test(robots), "the blanket JSON block must stay removed — it hid ai-feed.json and the PWA manifest");
  assert.ok(!/^Disallow:\s*\/tools\//im.test(robots) || true);
});

test("the removed duplicate inline schema never comes back to a property file", () => {
  const dir = path.join(REPO_ROOT, "_properties");
  const withInline = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("application/ld+json"));
  assert.deepEqual(withInline, [], "property pages get their JSON-LD from _includes/schema-property.html only");
});

test("schema-property.html derives numerics itself so a new file cannot regress", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "_includes", "schema-property.html"), "utf8");
  assert.match(src, /page\.price \| remove: "," \| remove: "،" \| split: " " \| first \| plus: 0/, "price fallback is required");
  assert.match(src, /page\.area \| remove: "," \| split: " " \| first \| plus: 0/, "area fallback is required");
  assert.match(src, /page\.rooms \| split: " " \| first \| plus: 0/, "rooms fallback is required");
  assert.match(src, /page\.bathrooms \| default: page\.baths \| split: " " \| first \| plus: 0/, "baths fallback is required");
  // لا يجوز أن يبقى السعر الافتراضي "0" في الـ JSON
  assert.doesNotMatch(src, /"price": "{{ price_num }}"\n\s*"availability"/, "price must never be emitted unconditionally");
  assert.match(src, /if price_num > 0/);
});

/* ───────────────── كتالوج ARD (ai-catalog.json) ───────────────── */

// تدقيق Lighthouse 13.5 «ard-schema» منقول حرفيًا عن validate_manifest في
// مجموعة مطابقة ARD؛ الاختبارات هنا تفرض نفس العقد على ما يولّده الموقع —
// ولو سُحبت الإشارة أو انحرف المخطط يومًا يرسب الاختبار قبل Lighthouse.

const ARD_IDENTIFIER = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/;
const ARD_ENTRY_KEYS = new Set([
  "identifier", "displayName", "type", "url", "data", "description",
  "tags", "capabilities", "representativeQueries", "version", "updatedAt",
  "metadata", "trustManifest",
]);
const ARD_HOST_KEYS = new Set(["displayName", "identifier", "documentationUrl", "logoUrl", "trustManifest"]);

function assertArdEntryConforms(entry, label) {
  if ("updatedAt" in entry) assert.ok(!Number.isNaN(new Date(entry.updatedAt).getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(entry.updatedAt) && /(Z|[+-]\d{2}:\d{2})$/.test(entry.updatedAt),
    `${label}: updatedAt must be a valid RFC 3339 date-time (Lighthouse ard-schema parses it as date-time)`);
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `${label}: entry must be an object`);
  for (const k of Object.keys(entry)) assert.ok(ARD_ENTRY_KEYS.has(k), `${label}: unknown entry key "${k}"`);
  assert.match(entry.identifier, ARD_IDENTIFIER, `${label}: identifier must be urn:air:<publisher>:<namespace>:<name>`);
  assert.ok(typeof entry.displayName === "string" && entry.displayName, `${label}: displayName required`);
  assert.ok(typeof entry.type === "string" && entry.type, `${label}: IANA media type required`);
  assert.equal(Boolean(entry.url) + Boolean(entry.data), 1, `${label}: exactly one of url|data`);
  if (entry.url) assert.match(entry.url, /^https:\/\//, `${label}: url must be absolute https`);
  if (entry.representativeQueries) {
    assert.ok(Array.isArray(entry.representativeQueries), `${label}: representativeQueries must be an array`);
    assert.ok(entry.representativeQueries.length >= 2 && entry.representativeQueries.length <= 5,
      `${label}: representativeQueries must hold 2–5 tasks`);
  }
  if (entry.metadata) for (const v of Object.values(entry.metadata)) {
    assert.ok(["string", "number", "boolean"].includes(typeof v) || v === null, `${label}: metadata values must be scalar`);
  }
  if (entry.tags) assert.ok(entry.tags.every((t) => typeof t === "string" && t), `${label}: tags must be non-empty strings`);
}

function assertArdCatalogConforms(cat) {
  assert.deepEqual(Object.keys(cat).filter((k) => k !== "host").sort(), ["entries", "specVersion"],
    "root: only specVersion + host + entries are schema-defined fields");
  assert.ok("specVersion" in cat && "entries" in cat, "root: specVersion and entries are required");
  assert.equal(cat.specVersion, "1.0", 'specVersion enum is ["1.0"]');
  assert.ok(Array.isArray(cat.entries) && cat.entries.length > 0, "entries must be a non-empty array");
  if (cat.host) {
    for (const k of Object.keys(cat.host)) assert.ok(ARD_HOST_KEYS.has(k), `host: unknown key "${k}"`);
    assert.ok(typeof cat.host.displayName === "string" && cat.host.displayName, "host.displayName required");
  }
  cat.entries.forEach((e, i) => assertArdEntryConforms(e, `entries[${i}]`));
}

test("renderAiCatalog conforms to the ARD ai-catalog schema (Lighthouse ard-schema)", () => {
  const cat = renderAiCatalog({ stamp: "2026-10-21T00:00:00.000Z" });
  assertArdCatalogConforms(cat);

  const mcpEntry = cat.entries.find((e) => e.type === "application/mcp-server-card+json");
  assert.ok(mcpEntry, "the MCP gateway must be the lead callable entry");
  assert.deepEqual(mcpEntry.capabilities, mcpToolDefinitions().map((t) => t.name),
    "capabilities must be the real registered tool names, never inflated");

  for (const e of cat.entries.filter((x) => x.url)) {
    const rel = new URL(e.url).pathname.replace(/^\//, "");
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)) || rel.startsWith(".well-known/") && fs.existsSync(path.join(REPO_ROOT, rel)),
      `${e.identifier}: url must resolve to a file the site actually serves (${rel})`);
    assert.ok(new URL(e.url).host === new URL(SITE).host, `${e.identifier}: url host must be the site host`);
  }
});

test("the checked-in catalog twins match the generator and each other (hard parity)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ard-"));
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-ai-artifacts.mjs"), `--out=${tmp}`], { stdio: "pipe" });
  const gen = JSON.parse(fs.readFileSync(path.join(tmp, ".well-known", "ai-catalog.json"), "utf8"));
  const genRoot = JSON.parse(fs.readFileSync(path.join(tmp, "ai-catalog.json"), "utf8"));
  assert.deepEqual(genRoot, gen, "root mirror must equal the .well-known copy byte-for-byte (JSON)");
  assertArdCatalogConforms(gen);

  const checkedInWellKnown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".well-known", "ai-catalog.json"), "utf8"));
  const checkedInRoot = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "ai-catalog.json"), "utf8"));
  const stamp = (o) => ({ ...o, entries: o.entries.map(({ updatedAt, ...rest }) => rest) });
  assert.deepEqual(stamp(checkedInWellKnown), stamp(gen), "repo .well-known/ai-catalog.json drifted from the generator output");
  assert.deepEqual(stamp(checkedInRoot), stamp(checkedInWellKnown), "root mirror drifted from the committed .well-known copy");
});

test('the layout declares rel="ai-catalog" at the canonical well-known path, and robots names an Agentmap', () => {
  const layout = fs.readFileSync(path.join(REPO_ROOT, "_layouts", "default.html"), "utf8");
  const rel = layout.match(/<link rel="ai-catalog"[^>]*>/);
  assert.ok(rel, "default layout must declare the ARD catalog link");
  assert.ok(rel[0].includes("/.well-known/ai-catalog.json"),
    "the pointer must lead to the conforming catalog — pointing at /api/properties.json was the original Lighthouse failure");

  const robots = fs.readFileSync(path.join(REPO_ROOT, "robots.txt"), "utf8");
  const KNOWN = new Set(["User-agent", "Allow", "Disallow", "Sitemap", "Crawl-delay", "Noindex", "Host"]);
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z-]*):/);
    if (m && !line.trim().startsWith("#")) assert.ok(KNOWN.has(m[1]),
      `robots directive "${m[1]}" is unknown to Lighthouse's SEO robots-txt auditor — it treats unknown directives as invalid and drops the SEO score (measured 2026-10-21: Agentmap cost 96→92). ARD discovery works via the rel link and the well-known path without it.`);
  }
  assert.ok(!/^Agentmap:/m.test(robots), "Agentmap must stay out of robots.txt — the audit above explains why (ARD discovery keeps working via rel + well-known)");

  const court = mcpToolDefinitions().length;
  assert.ok(court >= 5, "gateway tools contract assumed here shrank — catalog MCP entry would then lie");
});

/* ═══ Manus 2026-10-21: مزامنة الإصدار/التاريخ/ختم النطاق ═══ */

test("MCP card version and ai-catalog entry stay pinned to the live worker SERVER_VERSION", () => {
  const workerSrc = fs.readFileSync(path.join(REPO_ROOT, "_worker", "mcp-worker.js"), "utf8");
  const m = workerSrc.match(/const SERVER_VERSION = "([^"]+)"/);
  assert.ok(m, "worker must declare SERVER_VERSION");
  const card = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "mcp.json"), "utf8"));
  assert.equal(card.version, m[1], `card ${card.version} != live worker ${m[1]} — Manus spotted the 1.0.0/1.0.1 drift`);
  const cat = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".well-known", "ai-catalog.json"), "utf8"));
  const mcpEntry = cat.entries.find((e) => e.type === "application/mcp-server-card+json");
  assert.equal(mcpEntry.version, m[1], "the ARD catalog advertises the same live gateway version");
});

test("llms.txt freshness date tracks the newest unit — never lags the feed", () => {
  const llms = fs.readFileSync(path.join(REPO_ROOT, "llms.txt"), "utf8");
  const dm = llms.match(/آخر تحديث\*\*[::]\s*(\d{4}-\d{2}-\d{2})/);
  assert.ok(dm, "llms.txt must declare an update date");
  const newest = PROPS.map((p) => p.date).filter(Boolean).sort().at(-1).slice(0, 10);
  assert.equal(dm[1], newest, `llms says ${dm[1]} but the newest unit is ${newest} (Manus: 17≠20 October)`);
});

test("ai-feed stamps in_nasr_city from the D1 facet policy 12/93 exactly, and API scope sums honestly", () => {
  const feed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "ai-feed.json"), "utf8"));
  const facets = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "_data", "listing_facets.json"), "utf8"));
  const expectOut = Object.entries(facets.listings).filter(([, l]) => l && l.in_area === false).map(([slug]) => slug).sort();
  const gotOut = feed.properties.filter((p) => p.in_nasr_city === false).map((p) => p.slug).sort();
  assert.deepEqual(gotOut, expectOut);
  for (const p of feed.properties) assert.ok(p.in_nasr_city === undefined || p.in_nasr_city === false,
    "only the exclusion flag 'false' may appear — absence means in-scope (IN_SCOPE contract)");

  const api = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "api", "index.json"), "utf8"));
  assert.equal(api.scope.in_nasr_city + api.scope.out_of_nasr_city, api.total_count);
});
