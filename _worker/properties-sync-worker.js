// ═══════════════════════════════════════════════════════════════════════════
// سمسار طلبك — Properties Sync Worker
// GitHub `_properties/*.md`  →  Cloudflare D1 (`nasr-market-db`)
//
// Service: nasr-properties-sync
// Source : source_id = 9  (سمسار طلبك)  |  https://nasr-realestate.github.io
//
// المبادئ (لا تتغير):
//   1) GitHub هو مصدر المحتوى المنشور، وD1 يحتفظ بنسخة منظمة منه.
//   2) الكتابة على سجلات source_id = 9 فقط. لا نلمس أي مصدر آخر.
//   3) لا DELETE إطلاقًا. ملف اختفى من GitHub ⇒ يُسجَّل «missing_from_github» فقط.
//   4) لا كتابة في price_snapshots ولا إعادة حساب تقييم ولا تغيير منطق التقييم.
//   5) idempotent: تشغيل Cron عدة مرات لا ينتج أي duplicate.
//   6) ملف غير صالح ⇒ لا يُكتب record ناقص، ويُسجَّل باسم الملف والسبب.
//   7) لا اختراع قيم: الحقول تُشتق من الـfront matter فقط. المنطقة تُطابَق من جدول
//      areas الحقيقي، ولو مفيش match واضح ⇒ area_id فاضل (لا fallback عشوائي لمدينة نصر).
//   8) الـschema الحقيقي يُقرأ وقت التشغيل (PRAGMA) قبل أي SQL كتابة. لو الأعمدة
//      المطلوبة غير موجودة ⇒ نتوقف بلا أي كتابة (schema_mismatch).
//
// نقاط الوصول:
//   GET  /            → حالة الخدمة + آخر تشغيل
//   GET  /health      → نفس الشيء (alias)
//   GET  /schema      → الـschema الفعلي كما قرأه الـWorker + خريطة الأعمدة (قراءة فقط)
//   GET  /sync?...    → تشغيل يدوي للتشخيص (dry run افتراضيًا: ?dryRun=1)
//   POST /sync        → التشغيل الفعلي (يتطلب SYNC_TOKEN إن كان مضبوطًا)
//
// Cron Trigger: [triggers] crons = ["17 * * * *"]  (كل ساعة)
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_VERSION = "v1.0.0";
const SERVICE_NAME = "nasr-properties-sync";

const SOURCE_ID = 9;
const SOURCE_NAME = "سمسار طلبك";
const SOURCE_BASE_URL = "https://nasr-realestate.github.io";

const GITHUB = {
  owner: "nasr-realestate",
  repo: "nasr-realestate.github.io",
  branch: "master",
  dir: "_properties",
};

// جدول الحالة: إضافة فقط (additive) — يقفل إعادة قراءة الملفات اللي مفيش عليها تغيير.
const STATE_TABLE = "properties_sync_state";

const DEFAULT_FETCH_BUDGET = 40;   // حد الملفات المقروءة في التشغيل الواحد (subrequest budget)

// قيم قابلة للتجاوز من إعدادات الـWorker (بدون تغيير كود) — مع تنقية صارمة للأسماء
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function envIdent(value, fallback) {
  return typeof value === "string" && IDENT_RE.test(value) ? value : fallback;
}
function envBranch(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9._\/-]+$/.test(value) ? value : fallback;
}
const DEFAULT_MIN_INTERVAL_S = 60; // أقل فاصل بين تشغيلين يدويين متتاليين
const RUN_MARKER = "__run__";      // صف علامة في جدول الحالة يسجّل وقت آخر تشغيل
const INVALID_MARK = "__invalid__:"; // بادئة صفوف الملفات غير الصالحة في جدول الحالة
const OOS_MARK = "__oos__:";         // بادئة صفوف الملفات خارج نطاق مدينة نصر

// ── نطاق مدينة نصر (R2): مؤشرات صريحة على موقع خارج النطاق ──────────────────
// المطابقة على كلمات كاملة بعد التطبيع العربي (فلا يتحول «بدريسنج» إلى «بدر»،
// ولا «مباني التسعينات» إلى «التسعين»). لا تخمين: المؤشر لازم يكون مذكورًا نصًا.
const OUT_OF_SCOPE_MARKERS = [
  "مصر الجديدة",
  "هليوبوليس",
  "التجمع الخامس",
  "التجمع الأول",
  "التجمع الثاني",
  "التجمع الثالث",
  "القاهرة الجديدة",
  "الرحاب",
  "مدينتي",
  "مستقبل سيتي",
  "وادي دجلة",
  "مدينة السلام",
  "مدينة العبور",
  "الشروق",
  "الشيخ زايد",
  "اكتوبر",
  "المعادي",
  "المقطم",
  "حلوان",
  "الزمالك",
  "المهندسين",
  "الدقي",
  "وسط البلد",
  "شارع التسعين",
  "التسعين الجنوبي",
  "التسعين الشمالي",
  "الشويفات",
  "نيوبوليس",
  "مدينة بدر",
];
// مؤشرات مشروطة: تُحتسب فقط لو النص ما ذكرش «مدينة نصر» صريحًا
// (لأن شارع النزهة الرئيسي ومساكن شيراتون لهما عناوين داخل مدينة نصر فعليًا).
const CONDITIONAL_OUT_OF_SCOPE_MARKERS = ["شيراتون", "مساكن شيراتون"];
const IN_SCOPE_MARKER = "مدينة نصر";

const WORKER_UA = `nasr-properties-sync/${WORKER_VERSION}`;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://nasr-realestate.github.io",
];

// ── خريطة الأعمدة: كل حقل منطقي → أسماء أعمدة محتملة (أول اسم موجود في D1 يفوز) ──
// ملاحظة: دي مرشحات للقراءة وقت التشغيل، مش افتراضات. الـschema الفعلي هو الحكم.
const COLUMN_MAP = {
  externalId: ["external_id", "externalId", "ref_id", "reference", "external_ref", "listing_ref", "source_listing_id", "source_ref"],
  sourceId: ["source_id", "sourceId"],
  sourceUrl: ["source_url", "url", "listing_url", "link"],
  title: ["title", "title_ar"],
  description: ["description", "description_ar", "details"],
  transactionType: ["transaction_type", "transactionType", "deal_type", "purpose", "transaction", "listing_type", "offer_type"],
  propertyType: ["property_type", "propertyType"],
  price: ["price", "price_egp", "asking_price", "price_total", "price_amount"],
  pricePeriod: ["price_period", "rent_period"],
  currency: ["currency"],
  areaM2: ["area_m2", "areaM2", "area_sqm", "size_m2", "space_m2", "area"],
  areaId: ["area_id", "areaId", "areaID"],
  rooms: ["rooms", "bedrooms"],
  bathrooms: ["bathrooms", "baths"],
  floor: ["floor"],
  finish: ["finish", "finishing"],
  status: ["status", "listing_status", "availability"],
  category: ["category_raw", "source_category"],
  street: ["street", "address", "location"],
  imageUrl: ["image_url", "photo_url", "main_image", "image"],
  publishedAt: ["published_at", "listing_date", "date"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon"],
  createdAt: ["created_at"],
  updatedAt: ["updated_at", "last_updated", "modified_at"],
  contentHash: ["content_hash", "raw_hash", "source_hash", "checksum"],
};

const REQUIRED_FIELDS = ["externalId", "transactionType", "propertyType", "price", "areaM2"];

// أعمدة سجل التشغيل في ingestion_runs (مرشحات كذلك)
const RUN_COLUMN_MAP = {
  sourceId: ["source_id", "sourceId"],
  runType: ["run_type", "type", "kind", "job"],
  status: ["status", "listing_status", "availability"],
  startedAt: ["started_at", "start_time", "created_at"],
  finishedAt: ["finished_at", "end_time", "ended_at", "completed_at"],
  filesTotal: ["files_total", "total_files", "items_total", "records_total"],
  inserted: ["records_inserted", "inserted", "new_records", "inserted_count"],
  updated: ["records_updated", "updated", "updated_count"],
  unchanged: ["records_unchanged", "unchanged", "skipped", "skipped_count"],
  invalid: ["records_invalid", "invalid", "invalid_count", "failed"],
  errorsCount: ["errors_count", "error_count", "errors"],
  details: ["details", "error_details", "notes", "message", "summary"],
};

// ───────────────────────────────────────────────────────────────────────────
// أدوات عامة
// ───────────────────────────────────────────────────────────────────────────
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

function corsHeaders(request) {
  const origin = request?.headers?.get("origin") || "";
  const allowed = DEFAULT_ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ALLOWED_ORIGINS[0];
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "origin",
  };
}

function nowIso() {
  return new Date().toISOString();
}

// تطبيع النص العربي للمقارنة (همزات/تاء مربوطة/تشكيل/مسافات)
function normalizeArabic(input) {
  return String(input || "")
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// أرقام: يدعم الأرقام العربية/الفارسية والفواصل
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[,\u066C\u060C\s]/g, "");
  const m = normalized.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// مطابقة كلمة كاملة مع مراعاة حروف الجر/العطف الملتصقة بالعربية:
// «الحي الثامن» تُطابق «بالحي الثامن» و«والحي الثامن»، و«مدينة نصر» تُطابق «بمدينة نصر».
// ومع ذلك «بدريسنج» لا تُطابق «بدر» و«مباني التسعينات» لا تُطابق «التسعين» (لأن المطابقة على كلمة كاملة).
const ATTACHED_PREFIX_LETTERS = ["ب", "و", "ل", "ف", "ك"];
function prefixVariants() {
  const prefixes = new Set([""]);
  for (const a of ATTACHED_PREFIX_LETTERS) {
    prefixes.add(a);
    for (const b of ATTACHED_PREFIX_LETTERS) prefixes.add(`${a}${b}`); // وب، وب، فل… مثل «وبالحي الثامن»
  }
  return [...prefixes];
}
const TOKEN_PREFIXES = prefixVariants();
function tokenForms(needle) {
  const variants = new Set([needle]);
  const bare = needle.replace(/^ال/, "");
  if (bare && bare !== needle) variants.add(bare);
  const forms = new Set();
  for (const v of variants) for (const p of TOKEN_PREFIXES) forms.add(`${p}${v}`);
  return [...forms];
}
function containsToken(hay, needle) {
  if (!needle) return false;
  for (const form of tokenForms(needle)) {
    if (hay.includes(` ${form} `)) return true;
  }
  return false;
}

// نطاق مدينة نصر: يرجّع قائمة المؤشرات الصريحة التي وُجدت فعلًا في نص الملف
function detectOutOfScope(text) {
  const hay = ` ${normalizeArabic(text)} `;
  const inScope = containsToken(hay, normalizeArabic(IN_SCOPE_MARKER));
  const hits = [];
  for (const marker of OUT_OF_SCOPE_MARKERS) {
    if (containsToken(hay, normalizeArabic(marker))) hits.push(marker);
  }
  if (!inScope) {
    for (const marker of CONDITIONAL_OUT_OF_SCOPE_MARKERS) {
      if (containsToken(hay, normalizeArabic(marker)) && !hits.includes(marker)) hits.push(marker);
    }
  }
  return hits;
}

// ───────────────────────────────────────────────────────────────────────────
// قراءة front matter (بنية `key: value` مسطّحة — نفس نمط _properties الحالي)
// ───────────────────────────────────────────────────────────────────────────
function parseFrontMatter(raw) {
  const text = String(raw || "");
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue; // سطر غير مفهوم داخل الـfront matter ⇒ يُتجاهل (لا نخمّن)
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "" || value === "~" || value === "null") continue;
    data[kv[1]] = value;
  }
  return data;
}

// ── تصنيف: نوع المعاملة ونوع العقار (إشارات صريحة فقط + افتراضي موثّق) ──
const RENT_SIGNAL = /(rent|إيجار|ايجار|للإيجار|للايجار|شهري|شهريا|شهرياً|monthly)/i;
const SALE_SIGNAL = /(sale|للبيع|تمليك|بيع نهائي)/i;

const PROPERTY_TYPE_BY_CATEGORY = {
  "apartments": "apartment",
  "apartments-rent": "apartment",
  "villas": "villa",
  "villa": "villa",
  "offices": "office",
  "office": "office",
  "shops": "shop",
  "shop": "shop",
  "commercial": "commercial",
  "admin-hq": "admin",
  "admin": "admin",
  "duplex": "duplex",
  "roof": "roof",
  "warehouse": "warehouse",
  "land": "land",
};

function propertyTypeFromCategory(category) {
  const key = String(category || "").trim().toLowerCase();
  if (!key) return null;
  if (PROPERTY_TYPE_BY_CATEGORY[key]) return PROPERTY_TYPE_BY_CATEGORY[key];
  for (const [k, v] of Object.entries(PROPERTY_TYPE_BY_CATEGORY)) {
    if (key.includes(k)) return v;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// GitHub
// ───────────────────────────────────────────────────────────────────────────
async function githubTree(env, log) {
  const branch = envBranch(env.GITHUB_BRANCH, GITHUB.branch);
  const url = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/git/trees/${branch}?recursive=1`;
  const headers = { "user-agent": WORKER_UA, "accept": "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers["authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github_tree_failed:${res.status}:${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const prefix = `${GITHUB.dir}/`;
  const files = (data.tree || [])
    .filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.startsWith(prefix) && e.path.endsWith(".md"))
    .map((e) => ({ path: e.path, file: e.path.slice(prefix.length), sha: e.sha, size: e.size ?? null }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (log) log.githubTruncated = Boolean(data.truncated);
  return files;
}

async function githubRaw(env, path) {
  const branch = envBranch(env.GITHUB_BRANCH, GITHUB.branch);
  const url = `https://raw.githubusercontent.com/${GITHUB.owner}/${GITHUB.repo}/${branch}/${path}`;
  const res = await fetch(url, { headers: { "user-agent": WORKER_UA } });
  if (!res.ok) throw new Error(`github_raw_failed:${res.status}:${path}`);
  return await res.text();
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ───────────────────────────────────────────────────────────────────────────
// D1: قراءة الـschema + بناء خريطة الأعمدة الفعلية
// ───────────────────────────────────────────────────────────────────────────
async function tableInfo(db, table) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    return (results || []).map((r) => ({ name: r.name, type: r.type, notnull: r.notnull, pk: r.pk }));
  } catch {
    return null; // الجدول غير موجود
  }
}

async function tableExists(db, table) {
  try {
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .bind(table)
      .first();
    return Boolean(row && row.name);
  } catch {
    return false;
  }
}

function buildMapping(info, map) {
  const byLower = new Map((info || []).map((c) => [String(c.name).toLowerCase(), c.name]));
  const out = {};
  const used = new Map();
  for (const [field, candidates] of Object.entries(map)) {
    out[field] = null;
    for (const cand of candidates) {
      const actual = byLower.get(cand.toLowerCase());
      if (actual && !used.has(actual)) {
        out[field] = actual;
        used.set(actual, field);
        break;
      }
    }
  }
  return out;
}

async function readSchemaReport(db, env = {}) {
  const listingsTable = envIdent(env.LISTINGS_TABLE, "listings");
  const stateTable = envIdent(env.STATE_TABLE, STATE_TABLE);
  const [listings, ingestionRuns, sources, areas, stateExists] = await Promise.all([
    tableInfo(db, listingsTable),
    tableInfo(db, "ingestion_runs"),
    tableInfo(db, "sources"),
    tableInfo(db, "areas"),
    tableExists(db, stateTable),
  ]);
  const listingsMap = listings ? buildMapping(listings, COLUMN_MAP) : null;
  const runMap = ingestionRuns ? buildMapping(ingestionRuns, RUN_COLUMN_MAP) : null;
  return {
    tables: {
      listings: listings ? listings.map((c) => c.name) : null,
      ingestion_runs: ingestionRuns ? ingestionRuns.map((c) => c.name) : null,
      sources: sources ? sources.map((c) => c.name) : null,
      areas: areas ? areas.map((c) => c.name) : null,
      [stateTable]: stateExists,
    },
    listings_table: listingsTable,
    state_table: stateTable,
    mapping: listingsMap,
    run_mapping: runMap,
    missing_required: listingsMap
      ? REQUIRED_FIELDS.filter((f) => !listingsMap[f])
      : [...REQUIRED_FIELDS],
  };
}

// ── جدول الحالة (additive) ──
async function ensureStateTable(db, stateTable = STATE_TABLE) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${stateTable} (
         source_id INTEGER NOT NULL,
         external_id TEXT NOT NULL,
         file_path TEXT NOT NULL,
         blob_sha TEXT,
         content_hash TEXT,
         last_synced_at TEXT NOT NULL,
         PRIMARY KEY (source_id, external_id)
       )`
    )
    .run();
}

async function loadState(db, stateTable = STATE_TABLE) {
  // المفتاح = مسار الملف (هو اللي بنبحث بيه في كل تشغيل)
  const map = new Map();
  try {
    const { results } = await db
      .prepare(`SELECT external_id, file_path, blob_sha, content_hash FROM ${stateTable} WHERE source_id = ?`)
      .bind(SOURCE_ID)
      .all();
    for (const r of results || []) map.set(String(r.file_path), r);
  } catch {
    // الجدول لسه ما اتعملش ⇒ نغيّر المسار لإنشائه قبل أي كتابة
  }
  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// تحويل ملف GitHub → record منطقي (بدون أي اختراع قيم)
// ───────────────────────────────────────────────────────────────────────────
function buildRecord(fm, file, areaIndex) {
  const problems = [];
  const scopeText = [fm.location, fm.title, fm.description, fm.meta_description, file].filter(Boolean).join(" ");

  // external_id: id ثم slug ثم اسم الملف — كلها معرّفات موجودة فعلًا في الملف
  const externalId = String(fm.id || fm.slug || file.replace(/\.md$/, "")).trim();
  if (!externalId) problems.push("missing_external_id");

  // R1 + R2: حماية النطاق — أي مؤشر صريح على موقع خارج مدينة نصر ⇒ out_of_scope
  // (لا area_id من مناطق مدينة نصر ولا أي كتابة في listings)
  const outOfScopeReasons = detectOutOfScope(scopeText);
  if (outOfScopeReasons.length) {
    return {
      record: { externalId, outOfScope: true, outOfScopeReasons: outOfScopeReasons.slice() },
      problems: [],
      outOfScope: true,
      outOfScopeReasons,
      transactionEvidence: null,
    };
  }

  // نوع المعاملة: إشارة صريحة، وإلا الافتراضي «sale» مع توثيق ذلك
  const haystack = [fm.category, fm.slug, fm.title, fm.price, file].filter(Boolean).join(" ");
  const rentSignal = RENT_SIGNAL.test(haystack);
  const saleSignal = SALE_SIGNAL.test(haystack);
  let transactionType = null;
  let transactionEvidence = null;
  if (rentSignal) {
    transactionType = "rent";
    transactionEvidence = "explicit";
  } else if (saleSignal) {
    transactionType = "sale";
    transactionEvidence = "explicit";
  } else {
    transactionType = "sale";
    transactionEvidence = "default_sale_no_explicit_signal";
  }

  // نوع العقار من category (المصدر الوحيد المتاح)
  const propertyType = propertyTypeFromCategory(fm.category);
  if (!propertyType) problems.push("missing_property_type");

  // السعر: priceNumeric أولًا ثم استخراج رقم من نص price
  let price = toNumber(fm.priceNumeric);
  if (!(price > 0)) price = toNumber(fm.price);
  if (!(price > 0)) problems.push("missing_price");

  // المساحة: areaNumeric ثم استخراج رقم من نص area
  let areaM2 = toNumber(fm.areaNumeric);
  if (!(areaM2 > 0)) areaM2 = toNumber(fm.area);
  if (!(areaM2 > 0)) problems.push("missing_area_m2");

  // المنطقة: مطابقة أطول اسم منطقة معروف من جدول areas الحقيقي
  const locationText = [fm.location, fm.title, fm.description].filter(Boolean).join(" ");
  const areaMatch = matchArea(locationText, areaIndex);

  // إحداثيات: تُكتب فقط لو موجودة في الملف (مفيش أي تخمين)
  let latitude = toNumber(fm.latitude ?? fm.lat ?? null);
  let longitude = toNumber(fm.longitude ?? fm.lng ?? fm.lon ?? null);
  if ((latitude === null || longitude === null) && typeof fm.gps === "string") {
    const pair = fm.gps.split(/[,;\s]+/).map((v) => toNumber(v));
    if (pair.length >= 2 && pair[0] !== null && pair[1] !== null) { latitude = pair[0]; longitude = pair[1]; }
  }

  const slug = String(fm.slug || fm.id |
