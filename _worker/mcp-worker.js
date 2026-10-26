/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MCP Gateway — سمسار طلبك
 *  _worker/mcp-worker.js  ·  Cloudflare Worker  ·  nasr-ai-gateway
 * ───────────────────────────────────────────────────────────────────────────
 *  غرض هذا العامل: أن يصبح الموقع **قابلًا للاستدعاء** (callable) من أي
 *  نموذج أو وكيل يدعم Model Context Protocol، لا مجرد صفحة تُزحف.
 *
 *  ما يقدّمه:
 *    POST /mcp          خادم MCP على Streamable HTTP (JSON-RPC 2.0)
 *                       initialize · tools/list · tools/call · ping
 *                       resources/list · resources/read
 *                       prompts/list · prompts/get
 *                       notifications/* → 202 بلا جسم
 *    GET  /mcp          → 405 (العامل لا يفتح بث SSE — مسموح في المواصفة)
 *    GET  /             بطاقة الخدمة + قائمة الأدوات
 *    GET  /health       فحص صحة + عمر البيانات
 *    GET  /api/properties        كل الوحدات (مع فلاتر عبر query params)
 *    GET  /api/properties/:slug  وحدة واحدة
 *    GET  /api/stats             ملخص السوق
 *    GET  /api/zones             المناطق وعدد الوحدات
 *    OPTIONS *          CORS preflight
 *
 *  مبادئ التصميم (متوافقة مع قواعد بقية العوامل في هذا المستودع):
 *    • ملف واحد مستقل تمامًا — لا imports ولا وحدات مشتركة.
 *    • **للقراءة فقط**: لا كتابة في D1، ولا كتابة على أي مصدر.
 *    • **بلا أسرار**: لا يحتاج GEMINI_API_KEY ولا أي توكن. يقرأ ملفًا عامًا
 *      (`ai-feed.json`) من GitHub Pages، ويخزّنه على حافة Cloudflare 300 ثانية.
 *    • **لا يخترع أرقامًا**: إن غاب حقل رقمي يُعاد null صراحةً، ولا يُحسب بديل.
 *    • **لا يلمس العوامل الأخرى**: هذا العامل منفصل عن وكيل المحادثة
 *      (`royal-snow-ea32`) وعن عامل التقييم (`noisy-bush-fd84`) وعن المزامنة.
 *
 *  النشر: wrangler.mcp.toml — أو .github/workflows/deploy-mcp-gateway.yml
 * ═══════════════════════════════════════════════════════════════════════════
 */

"use strict";

export const RELEASE = "v1.0.1";
export const SCHEMA_VERSION = "3.0";

const SITE = "https://nasr-realestate.github.io";
const FEED_URL = `${SITE}/ai-feed.json`;
const LLMS_FULL_URL = `${SITE}/llms-full.txt`;

/** إصدار بروتوكول MCP الذي يعلنه هذا الخادم */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_NAME = "semsar-talabk";
const SERVER_TITLE = "سمسار طلبك — بوابة عقارات مدينة نصر";
const SERVER_VERSION = "1.0.2";

const CACHE_TTL_S = 300;          // كاش حافة على القراءة من GitHub Pages
const MEM_TTL_MS = 60 * 1000;     // كاش في الذاكرة داخل نفس الـisolate
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 50;

/** بيانات ثابتة موثّقة — مطابقة لـ _config.yml و llms.txt */
const CONTACT = {
  broker: "طارق طنطاوي",
  brand: "سمسار طلبك",
  brand_en: "Semsar Talabk",
  since: 2014,
  whatsapp: "+201147758857",
  whatsapp_url: "https://wa.me/201147758857",
  phone: "01147758857",
  email: "samsar.talabak@mailo.com",
  address: "16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر - القاهرة - 11371 - مصر",
  hours: "السبت – الخميس 12:00 – 21:00 · الجمعة إجازة",
  maps_url: "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7",
  rating: { value: 4.7, reviewCount: 102, source: "Google Maps — صفحة النشاط" },
  website: SITE,
};

/* ═════════ مقارنات وتحليل مسارات (بلا تعبيرات نمطية متغيّرة التراجع) ═════════ */

/**
 * مقارنة نصية بترتيب كود UTF-16 — نفس سلوك sort الافتراطي،
 * لكن بمقارن صريح كما تطلب SonarCloud (S2871) — بلا تغيير ترتيب المخرجات.
 */
function byCodeUnit(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** يزيل الشرطات الختامية من مسار — بحلقة بسيطة بدل `/\/+$/`. */
function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/** معرّف الوحدة من رابط أو ملف: يحذف الاستعلام والشرطات والامتداد. */
function tidyUnitId(raw) {
  let id = String(raw).split("?")[0];
  id = stripTrailingSlashes(id).split("/").pop() ?? "";
  for (const ext of [".json", ".md"]) {
    if (id.endsWith(ext)) return id.slice(0, -ext.length);
  }
  return id;
}

/* ═══════════════════════════ أدوات نصية ═══════════════════════════ */

/** تطبيع عربي للمقارنة: تشكيل، همزات، تاء مربوطة، ألف مقصورة */
export function normAr(s) {
  return String(s ?? "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    // أرقام عربية/فارسية ← غربية — بدونها «٣ غرف» لا يرى «3 غرف» أبدًا (عطل Manus 2026-10-21)
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) <= 0x0669 ? d.charCodeAt(0) - 0x0660 : d.charCodeAt(0) - 0x06F0))
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function clampLimit(v, fallback = 10) {
  const n = toNum(v);
  if (n === null || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_RESULTS);
}

/* ═══════════════════════ قراءة التغذية + الكاش ═══════════════════════ */

let memCache = { at: 0, data: null };

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** يقرأ ai-feed.json (مع كاش الحافة ثم كاش الذاكرة). لا يرمي — يُعيد null. */
export async function loadFeed(fetchImpl = fetch) {
  const now = Date.now();
  if (memCache.data && now - memCache.at < MEM_TTL_MS) return memCache.data;
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true },
    }, FETCH_TIMEOUT_MS, fetchImpl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.properties)) {
      throw new Error("shape");
    }
    memCache = { at: now, data };
    return data;
  } catch (err) {
    if (memCache.data) return memCache.data; // تراجع للنسخة القديمة بدل الفشل
    console.warn("[mcp] feed unavailable:", err && err.message);
    return null;
  }
}

/* ═══════════════════════════ الفلترة ═══════════════════════════ */

/** مرادفات الأنواع — عربي وإنجليزي، للتطبيع قبل المطابقة */
const TYPE_ALIASES = {
  apartment: ["apartment", "flat", "شقه", "شقة", "سكني"],
  villa: ["villa", "townhouse", "twinhouse", "duplex", "فيلا", "دوبلكس", "تاون"],
  shop: ["shop", "store", "retail", "محل", "تجاري", "معرض", "صيدليه", "صيدلية", "showroom", "شوروم"],
  office: ["office", "admin", "administrative", "مكتب", "اداري", "مقر"],
  warehouse: ["warehouse", "storage", "مخزن", "مخازن", "مستودع"],
  clinic: ["clinic", "عياده", "عيادة"],
};

/** التسمية العربية المفردة لكل نوع — تُستخدم في المطابقة النصية الاحتياطية */
const TYPE_AR = {
  apartment: "شقه",
  villa: "فيلا",
  shop: "محل",
  office: "مكتب",
  warehouse: "مخزن",
  clinic: "عياده",
};

/**
 * يُرجع المفتاح القانوني للنوع (apartment|villa|shop|office|warehouse|clinic).
 * "commercial" هنا = محل، لأن هذا هو الاستخدام الفعلي في بيانات الموقع.
 * يُرجع null لو المدخل غير معروف — وحينها تُستخدم المطابقة الحرفية فقط.
 */
export function canonicalType(value) {
  const want = normAr(value);
  if (!want) return null;
  for (const [key, aliases] of Object.entries(TYPE_ALIASES)) {
    if (key === want || aliases.some((a) => normAr(a) === want)) return key;
  }
  for (const [key, aliases] of Object.entries(TYPE_ALIASES)) {
    if (want.includes(key) || aliases.some((a) => want.includes(normAr(a)))) return key;
  }
  return null;
}

/** كلمات عاطلة في الاستعلامات العربية الحرة — تُحذف من بقية النص النصي */
const QUERY_FILLERS = ["في", "علي", "من", "عن", "قرب", "قريب", "حول", "حوالي", "جانب", "بجانب", "داخل", "لدي", "بدي", "اريد", "عايز", "ممكن", "لو", "سمحت", "وحدة", "عقار"];

/** مرادفات المعاملة — كلمة واحدة تكفي */
const TRANSACTION_ALIASES = [
  { value: "sale", words: ["للبيع", "بيع", "شراء", "تمليك"] },
  { value: "rent", words: ["للايجار", "لايجار", "ايجار", "تاجير", "تأجير", "شهري"] },
];

/**
 * يقرأ الاستعلام العربي الحر ويفرز منه فلاتر مهيكلة صادقة + بقية نصية،
 * بدل إلصاق النص كاملًا كسلسلة واحدة (وهو ما كان يُعيد 0 دائمًا).
 *  - «٣ غرف» / «3 غرف نوم»      → min_rooms
 *  - «للبيع» / «إيجار»          → transaction
 *  - «شقة / محل / مكتب / فيلا»   → property_type (عبر canonicalType نفسه)
 *  - «حتى ٣٠ ألف» / «أقل من 5 مليون» / «بحد أقصى …» → max_price
 * ما لا يُفهم يبقى نصًا وتُطابَق كلماته على العنوان/الموقع/الوصف داخل
 * filterProperties (كلمة بكلمة، بأي ترتيب). لا يُشتق سعر من لا شيء ولا
 * تُخترع معلومة لم يردها النص.
 */
export function parseFreeQuery(raw) {
  const src = normAr(raw);
  const out = { filters: {}, text: "" };
  if (!src) return out;

  let text = ` ${src} `;

  const roomMatch = text.match(/(\d+)\s*غرف(ه|ة)?(\s*نوم)?/u);
  if (roomMatch) {
    out.filters.min_rooms = Number(roomMatch[1]);
    text = text.replace(roomMatch[0], " ");
  }

  // السقف السعري: صيغة سقف صريحة فقط («حتى ٣٠ ألف») — لا يصبح «٣٠» داهية
  // في النص سعرًا من تلقائه (قد تكون تاريخًا أو مساحة — لا نخمن على العميل).
  const priceMatch = text.match(/(?:حتي|حتى|اقل\s*من|بحد\s*اقصي|سقف)\s*(\d[\d.,]*)\s*(مليون|ملايين|الف|ألف|k|m)?/u);
  if (priceMatch) {
    const n = toNum(String(priceMatch[1]));
    if (n !== null) {
      const mult = /مليون|ملايين|m/u.test(priceMatch[2] ?? "") ? 1_000_000 : /الف|ألف|k/u.test(priceMatch[2] ?? "") ? 1_000 : 1;
      if (n * mult >= 1000) out.filters.max_price = Math.round(n * mult);
    }
    text = text.replace(priceMatch[0], " ");
  }

  // المعاملة — أول كلمة تكسب
  for (const { value, words } of TRANSACTION_ALIASES) {
    const hit = words.find((w) => text.includes(` ${normAr(w)} `));
    if (hit) {
      out.filters.transaction = value;
      text = text.replace(` ${normAr(hit)} `, " ");
      break;
    }
  }

  // النوع — عبر نفس جدول المرادفات المستخدم في الفلتر المهيكل
  const tokens = text.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const type = canonicalType(t);
    if (type) { out.filters.property_type = type; text = text.replace(` ${t} `, " "); break; }
  }

  // البقية: تُنظّف من الحروف العاطلة وتُركب كنص نهائي
  const remain = text.split(/\s+/).filter((t) => t && !QUERY_FILLERS.includes(t));
  out.text = remain.join(" ").trim();
  return out;
}

/**
 * يخدم أدوات الترشيح (search/market/list_zones) من قائمة الوحدات داخل النطاق فقط;
 * لا يطبّق على get_property حتى يبقى الرابط المباشر شغالًا لمن معه (startup، noindex — لا إبعاد).
 */
export function scopeList(list) {
  return (Array.isArray(list) ? list : []).filter(IN_SCOPE);
}

/**
 * يدمج استعلامًا حرًا مع الفلاتر الصريحة: الصريح الذي وصل في حقول الأداة يكسب،
 * والمفكك من النص يسد الفراغ فقط. والنص الباقي من التفكيك يصبح query الفعلي.
 */
export function mergeQuery(args = {}) {
  const explicit = { ...args };
  const raw = typeof explicit.query === "string" ? explicit.query : "";
  if (!raw.trim()) { delete explicit.limit; return explicit; }
  const parsed = parseFreeQuery(raw);
  const merged = { ...parsed.filters };
  for (const [k, v] of Object.entries(explicit)) {
    if (k === "query") continue;
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
  }
  if (parsed.text) merged.query = parsed.text;
  return merged;
}
/**
 * يطبّق الفلاتر على قائمة الوحدات.
 * كل فلتر لا يطابق شيئًا يُقلّص النتيجة — لا يوجد أي «تسامح» صامت،
 * لأن التقريب في العقارات = معلومة خاطئة.
 */
/** النطاق المُعلن للوسيط: مدينة نصر فقط (نفس سياسة موقع الواجهة وD1 في listing_facets).
 *  التغذية تستضيف ملفات خارج النطاق توثيقيًا (روابط مباشرة/noindex)، لكنها لا
 *  تدخل أبعاض البحث ولا ملخص السوق ولا قائمة المناطق — حتى لا يوصي مساعد
 *  بوحدة خارج حقول الخدمة المعلنة (تحقيق Manus 2026-10-21: mcp.json كانت تقول
 *  «مدينة نصر والقاهرة الجديدة» بينما نطاق الواجهة مدينة نصر).
 *  in_nasr_city === false ← الموجب الوحيد للاستبعاد؛ غياب الحقل = داخل النطاق. */
export const IN_SCOPE = (p) => p.in_nasr_city !== false;

export function filterProperties(list, f = {}) {
  let out = Array.isArray(list) ? list.slice() : [];
  out = out.filter(IN_SCOPE);

  if (f.transaction) {
    const want = normAr(f.transaction);
    out = out.filter((p) => normAr(p.transaction).includes(want));
  }
  if (f.property_type) {
    const canonical = canonicalType(f.property_type);
    const want = normAr(f.property_type);
    out = out.filter((p) => {
      // الحقل المهيكل أولًا — وهو الأدق. المطابقة النصية للملخّص
      // كانت تسرّب نتائج خاطئة (وحدة `warehouse` بعنوان تجاري تطابق `shop`).
      const pt = String(p.propertyType ?? "").trim().toLowerCase();
      if (pt) return canonical ? pt === canonical : pt === want;
      const hay = normAr(`${p.title} ${p.category}`);
      return canonical ? hay.includes(TYPE_AR[canonical]) : hay.includes(want);
    });
  }
  if (f.zone) {
    const want = normAr(f.zone);
    out = out.filter((p) => normAr(`${p.zone} ${p.location}`).includes(want));
  }
  if (f.query) {
    const want = normAr(f.query);
    // كل مفردة من الاستعلام يجب أن تُرى (بأي ترتيب) — وليس العبارة كلها كتلة واحدة،
    // لأن «شقه للبيع ٣ غرف» ليست سلسلة فرعية في أي عنوان (عطل Manus: كانت يُعاد 0).
    const terms = want ? want.split(/\s+/).filter(Boolean) : [];
    if (terms.length) {
      out = out.filter((p) => {
        const hay = normAr(`${p.title} ${p.description} ${p.location} ${p.zone} ${p.finish} ${p.propertyType}`);
        return terms.every((t) => hay.includes(t));
      });
    }
  }
  const min = toNum(f.min_price);
  const max = toNum(f.max_price);
  if (min !== null) out = out.filter((p) => toNum(p.priceNumeric) !== null && toNum(p.priceNumeric) >= min);
  if (max !== null) out = out.filter((p) => toNum(p.priceNumeric) !== null && toNum(p.priceNumeric) <= max);

  const aMin = toNum(f.min_area);
  const aMax = toNum(f.max_area);
  if (aMin !== null) out = out.filter((p) => toNum(p.areaNumeric) !== null && toNum(p.areaNumeric) >= aMin);
  if (aMax !== null) out = out.filter((p) => toNum(p.areaNumeric) !== null && toNum(p.areaNumeric) <= aMax);

  const rooms = toNum(f.min_rooms);
  if (rooms !== null) out = out.filter((p) => toNum(p.roomsNumeric) !== null && toNum(p.roomsNumeric) >= rooms);

  if (f.furnished === true || f.furnished === "true") {
    out = out.filter((p) => normAr(p.furnished).includes("مفروش") && !normAr(p.furnished).includes("غير"));
  }
  return out;
}

/** ترتيب: الأحدث نشرًا أولًا (والأحدث تاريخًا لا يضمن الترتيب في المصدر) */
export function sortByDateDesc(list) {
  return list.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

/** قاعدة تفاوض حذرة: لا تُذكر إلا إذا وردت صراحةً في نص السعر المعلن. */
function priceNegotiationNote(p) {
  const label = p.transaction === "rent" ? "سعر طلب شهري" : "سعر طلب";
  if (/قابل\s*للتفاوض/u.test(String(p.price ?? ""))) {
    return `${label} قابل للتفاوض وفق نص الإعلان، وليس سعر إتمام`;
  }
  return `${label} معلن، وليس سعر إتمام؛ لم يذكر الإعلان إن كان قابلًا للتفاوض`;
}

/** بطاقة مضغوطة موجّهة للنموذج — بلا حقول داخلية ولا ادّعاءات */
export function compactProperty(p) {
  const out = {
    id: p.id ?? p.slug ?? null,
    slug: p.slug ?? null,
    title: p.title ?? null,
    url: p.url ?? null,
    transaction: p.transaction ?? null,
    propertyType: p.propertyType ?? null,
    location: p.location ?? null,
    zone: p.zone ?? null,
    price: p.price ?? null,
    priceNumeric: toNum(p.priceNumeric),
    currency: "EGP",
    price_note: priceNegotiationNote(p),
    areaNumeric: toNum(p.areaNumeric),
    area: p.area ?? null,
    roomsNumeric: toNum(p.roomsNumeric),
    bathsNumeric: toNum(p.bathsNumeric),
    floor: p.floor ?? null,
    finish: p.finish ?? null,
    furnished: p.furnished ?? null,
    image: p.image ?? null,
    datePosted: p.date ? String(p.date).slice(0, 10) : null,
  };
  return out;
}

/** نص Markdown مختصر لنتيجة بحث — أسهل على النماذج من JSON خام */
export function resultsAsMarkdown(items, meta = {}) {
  if (!items.length) {
    return `${meta.total_before_filter === 0 ? "لا توجد بيانات متاحة حاليًا." : "لا توجد وحدة مطابقة لهذه المعايير."}\n` +
      (meta.hint ? `\n${meta.hint}\n` : "");
  }
  const lines = [];
  lines.push(`**${items.length} وحدة${meta.filtered ? " مطابقة" : ""}** (من إجمالي ${meta.total_count ?? items.length} وحدة معروضة)`);
  lines.push("");
  for (const [i, p] of items.entries()) {
    const numeric = toNum(p.priceNumeric);
    const price = numeric === null
      ? `السعر: ${p.price || "للاستعلام"}`
      : `السعر: ${numeric.toLocaleString("en-US")} ج.م${p.transaction === "rent" ? " شهريًا" : ""}`;
    const bits = [
      price,
      toNum(p.areaNumeric) !== null ? `${toNum(p.areaNumeric)} م²` : null,
      toNum(p.roomsNumeric) !== null ? `${toNum(p.roomsNumeric)} غرف` : null,
      toNum(p.bathsNumeric) !== null ? `${toNum(p.bathsNumeric)} حمام` : null,
      p.finish || null,
    ].filter(Boolean);
    lines.push(`${i + 1}. **[${p.title}](${p.url})**`);
    lines.push(`   - ${bits.join(" · ")}`);
    if (p.location) lines.push(`   - الموقع: ${p.location}`);
    lines.push(`   - المعرّف: \`${p.slug}\``);
  }
  lines.push("");
  if (meta.hint) lines.push(`ℹ️ ${meta.hint}`, "");
  lines.push("> الأسعار أسعار طلب وليست أسعار إتمام؛ لا تفترض قابلية التفاوض إلا إذا وردت صراحة في نص الإعلان. الاقتباس مع ذكر المصدر «سمسار طلبك» ورابط الوحدة.");
  return lines.join("\n");
}

/* ═══════════════════════════ أدوات MCP ═══════════════════════════ */

export const TOOLS = [
  {
    name: "search_properties",
    title: "البحث في العقارات",
    description:
      "ابحث في الوحدات المعروضة للبيع والإيجار داخل مدينة نصر فقط (نطاق الخدمة المعلن؛ الوحدات الأرشيفية خارج المدينة لا تُرشَّح ولا تُعاد هنا). يدعم الفلترة بنوع المعاملة (sale/rent)، نوع العقار (apartment/villa/shop/office/warehouse/clinic)، المنطقة أو الشارع، نطاق السعر، نطاق المساحة، أدنى عدد غرف، الفرش، وبحث نصي حر. يُعيد قائمة مضغوطة برابط كل وحدة وبطاقة قابلة للاقتباس.",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "string", enum: ["sale", "rent"], description: "بيع أو إيجار" },
        property_type: { type: "string", enum: ["apartment", "villa", "shop", "office", "warehouse", "clinic"], description: "نوع العقار" },
        zone: { type: "string", description: "المنطقة أو الشارع، مثل: المنطقة السادسة، عباس العقاد، مكرم عبيد" },
        min_price: { type: "number", description: "أقل سعر بالجنيه المصري (شهري لو إيجار)" },
        max_price: { type: "number", description: "أعلى سعر بالجنيه المصري" },
        min_area: { type: "number", description: "أقل مساحة بالمتر المربع" },
        max_area: { type: "number", description: "أعلى مساحة بالمتر المربع" },
        min_rooms: { type: "integer", description: "أدنى عدد غرف" },
        furnished: { type: "boolean", description: "true = المفروش فقط" },
        query: { type: "string", description: "بحث نصي حر في العنوان والوصف والموقع" },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 10, description: "أقصى عدد نتائج" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_property",
    title: "تفاصيل وحدة",
    description: "يُرجع كل بيانات وحدة واحدة بمعرّفها (slug) أو برابط صفحتها.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "معرّف الوحدة (slug) أو الرابط الكامل أو اسم الملف" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "market_summary",
    title: "ملخص السوق",
    description:
      "إحصاءات مجمّعة من الأسعار المعروضة فعليًا: العدد، الوسيط، الأقل والأعلى — لكل نوع عقار ومعاملة، مع توزيع المناطق. مشتقة من الأسعار المعروضة وليست تقييمًا عقاريًا معتمدًا.",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "string", enum: ["sale", "rent"] },
        property_type: { type: "string", enum: ["apartment", "villa", "shop", "office", "warehouse", "clinic"] },
        zone: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_zones",
    title: "المناطق المخدومة",
    description: "قائمة المناطق والشوارع المخدومة مع عدد الوحدات المنشورة في كل منطقة (النشر ليس تأكيدًا للتوافر).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_contact",
    title: "بيانات التواصل",
    description: "بيانات التواصل الرسمية مع الوسيط طارق طنطاوي: واتساب، هاتف، بريد، عنوان المكتب، المواعيد، وتقييم Google.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const PROMPTS = [
  {
    name: "recommend_units",
    title: "ترشيح وحدات لعميل",
    description: "يبني تعليمات جاهزة لنموذج كي يرشّح وحدات حقيقية من الموقع حسب احتياج العميل، بلا اختلاق أرقام.",
    arguments: [
      { name: "need", description: "احتياج العميل بالتفصيل (النوع، المنطقة، الميزانية)", required: true },
      { name: "budget", description: "الميزانية بالجنيه المصري", required: false },
    ],
  },
];

/* ═══════════════════════════ إحصاءات ═══════════════════════════ */

function priceStats(items) {
  const nums = items.map((p) => toNum(p.priceNumeric)).filter((n) => n !== null && n > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const median = nums.length % 2 === 1
    ? nums[(nums.length - 1) / 2]
    : Math.round((nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2);
  return { count: nums.length, min: nums[0], median, max: nums[nums.length - 1] };
}

export function buildStats(list) {
  const by = (fn) => {
    const m = new Map();
    for (const p of list) {
      const k = fn(p);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
  };
  const types = [...new Set(list.map((p) => p.propertyType).filter(Boolean))].sort(byCodeUnit);
  const perType = {};
  for (const t of types) {
    const rows = list.filter((p) => p.propertyType === t);
    perType[t] = {
      count: rows.length,
      sale: priceStats(rows.filter((p) => p.transaction === "sale")),
      rent: priceStats(rows.filter((p) => p.transaction === "rent")),
    };
  }
  return {
    total: list.length,
    by_transaction: by((p) => p.transaction),
    by_property_type: by((p) => p.propertyType),
    by_zone: by((p) => p.zone),
    by_finish: by((p) => p.finish),
    price_by_type: perType,
    overall: {
      sale: priceStats(list.filter((p) => p.transaction === "sale")),
      rent: priceStats(list.filter((p) => p.transaction === "rent")),
    },
    method:
      "الوسيط (median) لأرقام priceNumeric المعروضة فعليًا. أسعار طلب وليست أسعار إتمام. الوحدات بلا سعر رقمي مستثناة من الإحصاء ولا يُقدَّر لها بديل.",
  };
}

/* ═══════════════════════════ تنفيذ الأدوات ═══════════════════════════ */

export async function callTool(name, args = {}, deps = {}) {
  const feed = deps.feed ?? (await loadFeed(deps.fetchImpl ?? fetch));
  const list = (feed && Array.isArray(feed.properties)) ? feed.properties : [];

  if (!list.length) {
    return {
      isError: true,
      structuredContent: { error: "FEED_UNAVAILABLE", message: "بيانات العقارات غير متاحة مؤقتًا — أعد المحاولة بعد قليل." },
      content: [{ type: "text", text: "⚠️ بيانات العقارات غير متاحة مؤقتًا (تعذّر قراءة ai-feed.json). أعد المحاولة بعد قليل، أو تواصل على واتساب +201147758857." }],
    };
  }

  switch (name) {
    case "search_properties": {
      const limit = clampLimit(args.limit, 10);
      const scope = scopeList(list);
      const argsMerged = mergeQuery(args);
      const filtered = filterProperties(scope ?? list, argsMerged);
      const items = sortByDateDesc(filtered).slice(0, limit).map(compactProperty);
      const usedFilter = Object.keys(args).some((k) => k !== "limit" && args[k] !== undefined && args[k] !== null && args[k] !== "");
      const text = resultsAsMarkdown(items, {
        total_count: list.length,
        total_before_filter: list.length,
        filtered: usedFilter,
        hint: filtered.length > items.length ? `يوجد ${filtered.length} نتيجة مطابقة — زد قيمة limit لعرض المزيد (بحد أقصى ${MAX_RESULTS}).` : undefined,
      });
      return {
        structuredContent: {
          total_count: scope.length,
          matched_count: filtered.length,
          returned: items.length,
          scope: "مدينة نصر",
          out_of_scope_units_withheld: list.length - scope.length,
          filters: argsMerged,
          properties: items,
          citation: "سمسار طلبك — طارق طنطاوي (مدينة نصر، القاهرة)",
        },
        content: [{ type: "text", text }],
      };
    }

    case "get_property": {
      const raw = String(args.id ?? "").trim();
      if (!raw) {
        return { isError: true, content: [{ type: "text", text: "❌ مطلوب معرّف الوحدة (id)." }] };
      }
      const slug = tidyUnitId(raw);
      const needle = normAr(slug);
      const hit = list.find((p) => normAr(p.slug) === needle)
        ?? list.find((p) => normAr(p.id) === needle)
        ?? list.find((p) => normAr(p.title) === needle)
        ?? list.find((p) => normAr(p.url).endsWith(needle + "/"));
      if (!hit) {
        return {
          isError: true,
          structuredContent: { error: "NOT_FOUND", id: raw, suggestion: `جرّب أداة search_properties، أو استعرض ${SITE}/api/properties.json` },
          content: [{ type: "text", text: `❌ لا توجد وحدة بالمعرّف \`${raw}\`. استخدم search_properties للبحث، أو راجع ${SITE}/llms-full.txt` }],
        };
      }
      const p = compactProperty(hit);
      const oosNote = IN_SCOPE(hit) ? null : `> ℹ️ هذه الوحدة في «${hit.zone || "منطقة خارج مدينة نصر"}» — خارج النطاق المُعلن في الموقع؛ تُعرض توثيقيًا لا ترشيحيًا، وأدوات البحث لا تقترحها.`;
      const details = [
        `# ${p.title}`,
        "",
        hit.description || "",
        "",
        `- **النوع**: ${p.propertyType} — ${p.transaction === "rent" ? "إيجار" : "بيع"}`,
        `- **السعر**: ${p.priceNumeric !== null ? `${p.priceNumeric.toLocaleString("en-US")} ج.م${p.transaction === "rent" ? " شهريًا" : ""}` : (p.price || "للاستعلام")}`,
        p.areaNumeric !== null ? `- **المساحة**: ${p.areaNumeric} م²` : null,
        p.roomsNumeric !== null ? `- **الغرف**: ${p.roomsNumeric}` : null,
        p.bathsNumeric !== null ? `- **الحمامات**: ${p.bathsNumeric}` : null,
        p.finish ? `- **التشطيب**: ${p.finish}` : null,
        p.floor ? `- **الدور**: ${p.floor}` : null,
        p.location ? `- **الموقع**: ${p.location}` : null,
        p.datePosted ? `- **تاريخ النشر**: ${p.datePosted}` : null,
        "",
        `- **الصفحة**: ${p.url}`,
        `- **JSON**: ${SITE}/api/properties/${p.slug}.json`,
        `- **Markdown**: ${SITE}/api/properties/${p.slug}.md`,
        `- **صورة**: ${p.image || "—"}`,
        "",
        `> ${p.price_note}. للتواصل: واتساب ${CONTACT.whatsapp} (${CONTACT.broker}).`,
      ].filter(Boolean).join("\n");
      if (oosNote) {
        p.in_scope = false;
        return { structuredContent: p, content: [{ type: "text", text: [oosNote, "", details].join("\n") }] };
      }
      return { structuredContent: p, content: [{ type: "text", text: details }] };
    }

    case "market_summary": {
      const scoped = filterProperties(scopeList(list), {
        transaction: args.transaction,
        property_type: args.property_type,
        zone: args.zone,
      });
      const stats = buildStats(scoped);
      const label = [args.property_type, args.transaction === "rent" ? "إيجار" : args.transaction === "sale" ? "بيع" : null, args.zone]
        .filter(Boolean).join(" · ") || "كل العقارات";
      const lines = [`## ملخص السوق — ${label}`, "", `- **عدد الوحدات**: ${stats.total}`];
      for (const [t, s] of Object.entries(stats.price_by_type)) {
        for (const tx of ["sale", "rent"]) {
          if (!s[tx]) continue;
          lines.push(`- **${t} / ${tx === "sale" ? "بيع" : "إيجار"}** (${s[tx].count}): الوسيط ${s[tx].median.toLocaleString("en-US")} · من ${s[tx].min.toLocaleString("en-US")} إلى ${s[tx].max.toLocaleString("en-US")} ج.م`);
        }
      }
      lines.push("", `> ${stats.method}`);
      return { structuredContent: stats, content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "list_zones": {
      const zones = buildStats(scopeList(list)).by_zone;
      const lines = ["## المناطق المخدومة", "", ...Object.entries(zones).map(([z, n]) => `- **${z}** — ${n} وحدة`)];
      return { structuredContent: { total_zones: Object.keys(zones).length, zones }, content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "get_contact": {
      const text = [
        `# ${CONTACT.brand} — ${CONTACT.broker}`,
        "",
        `- **واتساب**: ${CONTACT.whatsapp}`,
        `- **هاتف**: ${CONTACT.phone}`,
        `- **بريد**: ${CONTACT.email}`,
        `- **المكتب**: ${CONTACT.address}`,
        `- **المواعيد**: ${CONTACT.hours}`,
        `- **Google Maps**: ${CONTACT.maps_url}`,
        `- **التقييم**: ${CONTACT.rating.value}/5 من ${CONTACT.rating.reviewCount} مراجعة (${CONTACT.rating.source})`,
        "",
        "> ملاحظة: الوكيل الذكي على الموقع (agent.html) ليس طارق شخصيًا — هو أداة أولية لترتيب الطلبات.",
      ].join("\n");
      return { structuredContent: CONTACT, content: [{ type: "text", text }] };
    }

    default:
      return {
        isError: true,
        structuredContent: { error: "UNKNOWN_TOOL", name, available: TOOLS.map((t) => t.name) },
        content: [{ type: "text", text: `❌ أداة غير معروفة: ${name}` }],
      };
  }
}

/* ═══════════════════════════ بروتوكول MCP ═══════════════════════════ */

const RESOURCES = [
  { uri: "semsar://catalog", name: "كتالوج الوحدات (JSON)", description: "كل الوحدات المعروضة مع الحقول الرقمية والفهارس.", mimeType: "application/json" },
  { uri: "semsar://llms-full", name: "الكتالوج الكامل (Markdown)", description: "كل الوحدات في ملف Markdown واحد — مناسب للقراءة الكاملة.", mimeType: "text/markdown" },
  { uri: "semsar://contact", name: "بيانات التواصل", description: "بيانات الوسيط الرسمية ومواعيد العمل.", mimeType: "application/json" },
  { uri: "semsar://stats", name: "إحصاءات السوق", description: "ملخص الأسعار المعروضة لكل نوع ومعاملة.", mimeType: "application/json" },
];

async function readResource(uri, deps = {}) {
  const feed = deps.feed ?? (await loadFeed(deps.fetchImpl ?? fetch));
  const list = (feed && Array.isArray(feed.properties)) ? feed.properties : [];

  if (uri === "semsar://contact") {
    return { uri, mimeType: "application/json", text: JSON.stringify(CONTACT, null, 2) };
  }
  if (uri === "semsar://stats") {
    return { uri, mimeType: "application/json", text: JSON.stringify(buildStats(list), null, 2) };
  }
  if (uri === "semsar://catalog") {
    const payload = {
      schema_version: SCHEMA_VERSION,
      source: FEED_URL,
      total_count: list.length,
      generated_at: feed?.generated_at ?? null,
      properties: sortByDateDesc(list).map(compactProperty),
    };
    return { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) };
  }
  if (uri === "semsar://llms-full") {
    // نفس قابلية الحقن الموجودة في loadFeed — بدونها كان هذا المسار
    // يذهب إلى الشبكة الحقيقية داخل الاختبارات (انظر HERMETIC_NETWORK في
    // _worker/tests/mcp-gateway.test.mjs).
    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const res = await fetchWithTimeout(LLMS_FULL_URL, { headers: { Accept: "text/markdown" }, cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true } }, FETCH_TIMEOUT_MS, fetchImpl);
      if (res.ok) return { uri, mimeType: "text/markdown", text: await res.text() };
    } catch { /* نُكمل إلى البديل */ }
    const fallback = sortByDateDesc(list)
      .map((p) => `### ${p.title}\n- الرابط: ${p.url}\n- السعر: ${p.priceNumeric ?? p.price}\n- الموقع: ${p.location}\n`)
      .join("\n");
    return { uri, mimeType: "text/markdown", text: `# كتالوج سمسار طلبك\n\n${fallback}` };
  }
  return null;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/**
 * معالج رسالة JSON-RPC واحدة.
 * يُعاد `null` للرسائل التي لا تحتاج ردًّا (notifications).
 */
export async function handleRpc(msg, deps = {}) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  // كل الطلبات التي لا تحتاج ردًّا
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {},
        },
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
        instructions:
          "خادم قراءة فقط لموقع سمسار طلبك (وسيط عقاري في مدينة نصر، القاهرة، مصر). نطاق الترشيح مدينة نصر فقط؛ السجلات الأرشيفية خارجها روابط مباشرة لا تُرشَّح. " +
          "استخدم search_properties للبحث عن وحدات، وget_property لتفاصيل وحدة، وmarket_summary لإحصاءات الأسعار المعروضة، " +
          "وlist_zones للمناطق، وget_contact لبيانات الوسيط. " +
          "قواعد الإسناد: اذكر المصدر «سمسار طلبك» وأرفق رابط الوحدة، وبيّن أن الأسعار أسعار طلب وليست أسعار إتمام؛ لا تفترض قابلية التفاوض إلا إذا وردت صراحة في نص الإعلان، " +
          "ولا تُقدّر سعرًا لوحدة لا يحمل حقل priceNumeric قيمة.",
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params.name;
      if (!name) return rpcError(id, -32602, "Missing tool name");
      const out = await callTool(name, params.arguments ?? {}, deps);
      return rpcResult(id, {
        content: out.content,
        isError: Boolean(out.isError),
        ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}),
      });
    }

    case "resources/list":
      return rpcResult(id, { resources: RESOURCES });

    case "resources/read": {
      const uri = params.uri;
      if (!uri) return rpcError(id, -32602, "Missing resource uri");
      const found = await readResource(uri, deps);
      if (!found) return rpcError(id, -32002, `Resource not found: ${uri}`);
      return rpcResult(id, { contents: [found] });
    }

    case "resources/templates/list":
      return rpcResult(id, {
        resourceTemplates: [
          {
            uriTemplate: "semsar://property/{slug}",
            name: "وحدة واحدة",
            description: "بيانات وحدة بمعرّفها.",
            mimeType: "application/json",
          },
        ],
      });

    case "prompts/list":
      return rpcResult(id, { prompts: PROMPTS });

    case "prompts/get": {
      const name = params.name;
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${name}`);
      const need = String(params.arguments?.need ?? "").trim();
      const budget = String(params.arguments?.budget ?? "").trim();
      const text = [
        "أنت مساعد عقاري. لديك خادم MCP لموقع «سمسار طلبك» (مدينة نصر فقط؛ لا ترشح سجلات أرشيفية خارجها).",
        "",
        `احتياج العميل: ${need || "(غير محدد)"}`,
        budget ? `الميزانية: ${budget} ج.م` : null,
        "",
        "الخطوات:",
        "1. استدعِ search_properties بفلاتر مناسبة (transaction، property_type، zone، min_price/max_price، min_area، min_rooms).",
        "2. لو رجعت النتائج قليلة، وسّع الفلاتر تدريجيًا واذكر أنك وسّعتها.",
        "3. اعرض كل وحدة مرشّحة برابطها وسعرها الرقمي ومساحتها — ولا تُضف أي رقم غير موجود في النتيجة.",
        "4. لو لم توجد نتيجة مطابقة، قل ذلك صراحةً واقترح تعديل الفلاتر بدل اختراع وحدة.",
        "5. اختم ببيانات التواصل من get_contact (واتساب) واسأل العميل عن الوحدات التي يريد معاينتها.",
        "",
        "إلزامي: بيّن أن الأسعار أسعار طلب وليست أسعار إتمام، ولا تفترض قابلية التفاوض إلا إذا وردت صراحة في نص الإعلان؛ واذكر المصدر «سمسار طلبك» مع رابط كل وحدة.",
      ].filter((l) => l !== null).join("\n");
      return rpcResult(id, {
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      });
    }

    case "completion/complete":
      return rpcResult(id, { completion: { values: [], total: 0, hasMore: false } });

    case "logging/setLevel":
      return rpcResult(id, {});

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/* ═══════════════════════════ HTTP ═══════════════════════════ */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS_HEADERS, ...extra },
  });
}

function text(body, status = 200, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": type, ...CORS_HEADERS, ...extra } });
}

export function serviceCard() {
  return {
    service: SERVER_NAME,
    title: SERVER_TITLE,
    release: RELEASE,
    status: "running",
    description:
      "خادم MCP للقراءة فقط يعرض الوحدات المعروضة على موقع سمسار طلبك في مدينة نصر ويمكّن أي نموذج أو وكيل من البحث فيها واسترجاعها واقتباسها بالإسناد. السجلات خارج مدينة نصر أرشيفية ولا تُرشَّح.",
    protocol: { name: "model-context-protocol", version: MCP_PROTOCOL_VERSION, transport: "streamable-http", endpoint: "/mcp" },
    source_of_truth: FEED_URL,
    read_only: true,
    requires_secrets: false,
    website: SITE,
    endpoints: {
      mcp: "/mcp",
      health: "/health",
      properties: "/api/properties",
      property: "/api/properties/{slug}",
      stats: "/api/stats",
      zones: "/api/zones",
      card: `${SITE}/.well-known/mcp.json`,
    },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    resources: RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })),
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title })),
    citation_policy: "اذكر المصدر «سمسار طلبك» وأرفق رابط الوحدة. الأسعار أسعار طلب وليست أسعار إتمام؛ لا تفترض قابلية التفاوض إلا إذا وردت صراحة في نص الإعلان.",
    contact: { broker: CONTACT.broker, whatsapp: CONTACT.whatsapp, email: CONTACT.email },
  };
}

function queryToFilter(url) {
  const q = url.searchParams;
  const f = {};
  for (const key of ["transaction", "property_type", "zone", "query"]) {
    const v = q.get(key);
    if (v) f[key] = v;
  }
  for (const key of ["min_price", "max_price", "min_area", "max_area", "min_rooms", "limit"]) {
    const v = q.get(key);
    if (v !== null && v !== "") f[key] = Number(v);
  }
  const furnished = q.get("furnished");
  if (furnished === "true" || furnished === "1") f.furnished = true;
  return f;
}

/* ═══════════════════════════ المُوجِّه ═══════════════════════════ */

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const path = stripTrailingSlashes(url.pathname) || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── MCP ──────────────────────────────────────────────
    if (path === "/mcp") {
      if (method === "GET") {
        // لا بث SSE من هذا العامل — المواصفة تسمح بـ405 هنا.
        return json({ error: "Method Not Allowed", detail: "This MCP server is stateless and does not open SSE streams. Send JSON-RPC over POST.", protocol_version: MCP_PROTOCOL_VERSION }, 405, { Allow: "POST, OPTIONS" });
      }
      if (method !== "POST") {
        return json({ error: "Method Not Allowed" }, 405, { Allow: "POST, OPTIONS" });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(rpcError(null, -32700, "Parse error"), 400);
      }

      if (Array.isArray(payload)) {
        // JSON-RPC batch (بُترت في MCP 2025-06-18 لكن تُدعم للتوافق)
        const responses = [];
        for (const msg of payload) {
          const r = await handleRpc(msg, {});
          if (r) responses.push(r);
        }
        if (!responses.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
        return json(responses, 200, { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION });
      }

      const response = await handleRpc(payload, {});
      if (!response) {
        // إشعار (initialized / cancelled …) — 202 بلا جسم كما تقتضي المواصفة
        return new Response(null, { status: 202, headers: { ...CORS_HEADERS, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } });
      }
      return json(response, 200, { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION });
    }

    // ── بطاقة الخدمة والصحة ──────────────────────────────
    if (path === "/" || path === "/health") {
      const card = serviceCard();
      if (path === "/health") {
        const feed = await loadFeed();
        const list = feed?.properties ?? [];
        return json({
          status: list.length ? "ok" : "degraded",
          release: RELEASE,
          properties: list.length,
          feed_generated_at: feed?.generated_at ?? null,
          feed_url: FEED_URL,
          checked_at: new Date().toISOString(),
          read_only: true,
        }, list.length ? 200 : 503);
      }
      return json(card);
    }

    // ── REST مختصر ──────────────────────────────────────
    if (path === "/api/properties" && method === "GET") {
      const feed = await loadFeed();
      const list = feed?.properties ?? [];
      const f = queryToFilter(url);
      const limit = clampLimit(f.limit, list.length);
      delete f.limit;
      const filtered = filterProperties(list, f);
      const items = sortByDateDesc(filtered).slice(0, limit).map(compactProperty);
      return json({
        schema_version: SCHEMA_VERSION,
        generated_at: feed?.generated_at ?? null,
        source: FEED_URL,
        total_count: list.length,
        matched_count: filtered.length,
        returned: items.length,
        filters: f,
        citation: "سمسار طلبك — طارق طنطاوي (مدينة نصر، القاهرة)",
        properties: items,
      });
    }

    if (path.startsWith("/api/properties/") && method === "GET") {
      const slug = decodeURIComponent(path.slice("/api/properties/".length));
      const out = await callTool("get_property", { id: slug });
      if (out.isError && out.structuredContent?.error === "NOT_FOUND") {
        return json({ error: "NOT_FOUND", id: slug, catalog: `${SITE}/api/properties.json` }, 404);
      }
      if (out.isError) return json(out.structuredContent ?? { error: "UNAVAILABLE" }, 503);
      return json(out.structuredContent);
    }

    if (path === "/api/stats" && method === "GET") {
      const feed = await loadFeed();
      const list = feed?.properties ?? [];
      const f = queryToFilter(url);
      delete f.limit;
      return json(buildStats(filterProperties(list, f)));
    }

    if (path === "/api/zones" && method === "GET") {
      const feed = await loadFeed();
      const list = feed?.properties ?? [];
      const zones = buildStats(list).by_zone;
      return json({ total_zones: Object.keys(zones).length, total_properties: list.length, zones });
    }

    if (path === "/robots.txt") {
      return text("User-agent: *\nAllow: /\n", 200, "text/plain; charset=utf-8");
    }

    return json({
      error: "Not Found",
      service: SERVER_NAME,
      hint: `المسارات المتاحة: / · /health · /mcp (POST) · /api/properties · /api/properties/{slug} · /api/stats · /api/zones`,
      website: SITE,
    }, 404);
  },
};

/** واجهة اختبار — لا تُستخدم في التنفيذ */
export const __test = {
  buildStats,
  canonicalType,
  filterProperties,
  compactProperty,
  handleRpc,
  readResource,
  serviceCard,
  RESOURCES,
  TOOLS,
  PROMPTS,
  CONTACT,
  resetCache: () => { memCache = { at: 0, data: null }; },
  setCache: (data) => { memCache = { at: Date.now(), data }; },
  MCP_PROTOCOL_VERSION,
};
