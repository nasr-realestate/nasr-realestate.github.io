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

  // external_id: id ثم slug ثم اسم الملف — كلها معرّفات موجودة فعلًا في الملف
  const externalId = String(fm.id || fm.slug || file.replace(/\.md$/, "")).trim();
  if (!externalId) problems.push("missing_external_id");

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

  const slug = String(fm.slug || fm.id || "").trim();
  const imageFile = String(fm.image_file || "").trim();

  const record = {
    externalId,
    transactionType,
    transactionEvidence,
    propertyType,
    price: price > 0 ? Math.round(price) : null,
    pricePeriod: transactionType === "rent" ? "monthly" : null,
    currency: "EGP",
    areaM2: areaM2 > 0 ? areaM2 : null,
    areaId: areaMatch ? areaMatch.id : null,
    areaMatchName: areaMatch ? areaMatch.name : null,
    title: fm.title ? String(fm.title).trim() : null,
    description: fm.description ? String(fm.description).trim() : null,
    rooms: toNumber(fm.roomsNumeric) ?? null,
    bathrooms: toNumber(fm.bathsNumeric) ?? null,
    floor: fm.floor ? String(fm.floor).trim() : null,
    finish: fm.finish ? String(fm.finish).trim() : null,
    status: fm.status ? String(fm.status).trim() : null,
    category: fm.category ? String(fm.category).trim() : null,
    street: fm.location ? String(fm.location).trim() : null,
    imageUrl: imageFile ? `${SOURCE_BASE_URL}/assets/img/properties/${imageFile}` : null,
    sourceUrl: slug ? `${SOURCE_BASE_URL}/properties/${slug}/` : SOURCE_BASE_URL,
    publishedAt: fm.date ? String(fm.date).trim() : null,
    latitude,
    longitude,
  };

  return { record, problems, transactionEvidence };
}

function matchArea(text, areaIndex) {
  if (!text || !areaIndex.length) return null;
  const hay = ` ${normalizeArabic(text)} `;
  let best = null;
  for (const area of areaIndex) {
    for (const name of area.names) {
      const needle = normalizeArabic(name);
      if (!needle || needle.length < 4) continue;
      if (hay.includes(` ${needle} `) || hay.includes(needle)) {
        if (!best || needle.length > best.length) best = { id: area.id, name: area.name, length: needle.length };
      }
    }
  }
  return best;
}

async function loadAreaIndex(db) {
  try {
    const info = await tableInfo(db, "areas");
    if (!info) return [];
    const cols = new Set(info.map((c) => String(c.name).toLowerCase()));
    const idCol = cols.has("id") ? "id" : null;
    if (!idCol) return [];
    const nameCols = ["name", "name_ar", "name_en"].filter((c) => cols.has(c));
    if (!nameCols.length) return [];
    const { results } = await db.prepare(`SELECT id, ${nameCols.join(", ")} FROM areas`).all();
    return (results || []).map((r) => ({
      id: r.id,
      name: r[nameCols[0]],
      names: nameCols.map((c) => r[c]).filter(Boolean),
    }));
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Upsert (source_id = 9 فقط)
// ───────────────────────────────────────────────────────────────────────────
function pickRowValues(record, mapping, existingRow) {
  const values = {};
  const set = (field, value) => {
    const col = mapping[field];
    if (col && value !== undefined && value !== null && value !== "") values[col] = value;
  };
  set("externalId", record.externalId);
  set("sourceId", SOURCE_ID);
  set("sourceUrl", record.sourceUrl);
  set("title", record.title);
  set("description", record.description);
  set("transactionType", record.transactionType);
  set("propertyType", record.propertyType);
  set("price", record.price);
  if (record.pricePeriod) set("pricePeriod", record.pricePeriod);
  set("currency", record.currency);
  set("areaM2", record.areaM2);
  if (record.areaId !== null) set("areaId", record.areaId);
  set("rooms", record.rooms);
  set("bathrooms", record.bathrooms);
  set("floor", record.floor);
  set("finish", record.finish);
  set("status", record.status);
  set("category", record.category);
  set("street", record.street);
  set("imageUrl", record.imageUrl);
  set("publishedAt", record.publishedAt);
  set("latitude", record.latitude);
  set("longitude", record.longitude);

  // created_at: لا يُكتب عند التحديث (يبقى كما هو)
  if (!existingRow) set("createdAt", nowIso());
  set("updatedAt", nowIso());
  return values;
}

// هل القيم المستهدفة مطابقة للموجود فعلًا؟ (لو نعم ⇒ لا write)
function isSameAsExisting(values, existingRow, mapping) {
  if (!existingRow) return false;
  for (const [col, value] of Object.entries(values)) {
    if (col === mapping.updatedAt) continue; // updated_at يتغير مع أي write حقيقي
    const current = existingRow[col];
    if (current === null || current === undefined) {
      if (String(value) !== "") return false;
      continue;
    }
    if (typeof value === "number") {
      if (Number(current) !== value) return false;
    } else if (String(current) !== String(value)) {
      return false;
    }
  }
  return true;
}

async function upsertListing(db, listingsTable, mapping, record, existingRow, contentHash) {
  const values = pickRowValues(record, mapping, existingRow);
  if (mapping.contentHash) values[mapping.contentHash] = contentHash;
  const base = isSameAsExisting(values, existingRow, mapping);

  if (!existingRow) {
    const cols = Object.keys(values);
    const sql = `INSERT INTO ${listingsTable} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const res = await db
      .prepare(sql)
      .bind(...cols.map((c) => values[c]))
      .run();
    return { action: "inserted", changes: res?.meta?.changes ?? null, values };
  }

  if (base) return { action: "unchanged", changes: 0, values };

  const cols = Object.keys(values);
  const sql = `UPDATE ${listingsTable} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
  const res = await db
    .prepare(sql)
    .bind(...cols.map((c) => values[c]), existingRow.id)
    .run();
  return { action: "updated", changes: res?.meta?.changes ?? null, values };
}

// ───────────────────────────────────────────────────────────────────────────
// ingestion_runs (لو الجدول موجود ومصمم للعمليات دي)
// ───────────────────────────────────────────────────────────────────────────
async function writeRunLog(db, runMap, summary) {
  if (!runMap || !runMap.startedAt) return false;
  const values = {};
  const set = (field, value) => {
    const col = runMap[field];
    if (col && value !== undefined && value !== null) values[col] = value;
  };
  set("sourceId", SOURCE_ID);
  set("runType", summary.trigger === "cron" ? "properties_sync_cron" : "properties_sync_manual");
  set("status", summary.status);
  set("startedAt", summary.startedAt);
  set("finishedAt", summary.finishedAt);
  set("filesTotal", summary.github.files_total);
  set("inserted", summary.db.inserted);
  set("updated", summary.db.updated);
  set("unchanged", summary.db.unchanged);
  set("invalid", summary.db.invalid);
  set("errorsCount", summary.errors.length);
  if (runMap.details) {
    values[runMap.details] = JSON.stringify({
      version: WORKER_VERSION,
      trigger: summary.trigger,
      dry_run: summary.dry_run,
      fetched: summary.github.fetched,
      missing: summary.github.missing_from_github,
      duplicates: summary.db.duplicates,
      invalid_files: summary.invalid_files.slice(0, 25),
      errors: summary.errors.slice(0, 10),
      area_unmatched: summary.area_unmatched.slice(0, 25),
      duration_ms: summary.duration_ms,
    }).slice(0, 4000);
  }
  const cols = Object.keys(values);
  if (!cols.length) return false;
  try {
    await db
      .prepare(`INSERT INTO ingestion_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => values[c]))
      .run();
    return true;
  } catch {
    return false;
  }
}

async function lastRun(db, runMap) {
  try {
    const sql = `SELECT * FROM ingestion_runs WHERE source_id = ? ORDER BY rowid DESC LIMIT 1`;
    return await db.prepare(sql).bind(SOURCE_ID).first();
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// التشغيل الأساسي
// ───────────────────────────────────────────────────────────────────────────
async function runSync(env, opts = {}) {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const dryRun = Boolean(opts.dryRun);
  const trigger = opts.trigger || "manual";
  const budget = Number(env.SYNC_FETCH_BUDGET) > 0 ? Number(env.SYNC_FETCH_BUDGET) : DEFAULT_FETCH_BUDGET;
  const db = env.DB;

  const summary = {
    service: SERVICE_NAME,
    version: WORKER_VERSION,
    trigger,
    dry_run: dryRun,
    source_id: SOURCE_ID,
    source_name: SOURCE_NAME,
    started_at: startedAt,
    finished_at: null,
    duration_ms: 0,
    status: "running",
    github: {
      files_total: 0, fetched: 0, skipped_unchanged: 0,
      missing_from_github: 0, budget_skipped: 0, budget_exhausted: false,
      complete: true, truncated: false,
    },
    db: { inserted: 0, updated: 0, unchanged: 0, unchanged_invalid: 0, invalid: 0, duplicates: 0, write_failures: 0, writes_blocked: false },
    invalid_files: [],
    duplicate_files: [],
    area_unmatched: [],
    errors: [],
    schema: null,
  };

  if (!db) {
    summary.status = "error";
    summary.errors.push("missing_DB_binding");
    summary.finished_at = nowIso();
    summary.duration_ms = Date.now() - startedMs;
    return summary;
  }

  try {
    // 1) قراءة الـschema الفعلي قبل أي SQL كتابة
    const schema = await readSchemaReport(db, env);
    const listingsTable = schema.listings_table;
    const stateTable = schema.state_table;
    summary.schema = {
      listings_columns: schema.tables.listings,
      mapping: schema.mapping,
      missing_required: schema.missing_required,
      ingestion_runs_columns: schema.tables.ingestion_runs,
      state_table: schema.tables[STATE_TABLE],
    };

    if (!schema.tables.listings) {
      summary.status = "schema_mismatch";
      summary.errors.push(`listings_table_not_found:${listingsTable}`);
      summary.db.writes_blocked = true;
      return finalize(summary, startedMs);
    }
    if (schema.missing_required.length) {
      summary.status = "schema_mismatch";
      summary.errors.push(`missing_required_columns:${schema.missing_required.join(",")}`);
      summary.db.writes_blocked = true;
      return finalize(summary, startedMs);
    }
    if (!schema.mapping.sourceId) {
      // بدون source_id لا يمكن عزل المصادر ⇒ نرفض الكتابة (حماية للمصادر الأخرى)
      summary.status = "schema_mismatch";
      summary.errors.push("source_id_column_not_found");
      summary.db.writes_blocked = true;
      return finalize(summary, startedMs);
    }

    // 2) جدول الحالة (إضافة فقط) — لو ممنوع نكمل بوضع degraded آمن
    let state = new Map();
    let stateEnabled = true;
    if (String(env.SYNC_ALLOW_DDL ?? "1") !== "0") {
      try {
        await ensureStateTable(db, stateTable);
      } catch (err) {
        stateEnabled = false;
        summary.errors.push(`state_table_create_failed:${String(err.message).slice(0, 120)}`);
      }
    } else {
      stateEnabled = false;
    }
    if (stateEnabled) state = await loadState(db, stateTable);

    // 3) المناطق الحقيقية + السجلات الحالية للمصدر 9 فقط
    const areaIndex = await loadAreaIndex(db);
    const externalIdCol = schema.mapping.externalId;
    const { results: existingRows } = await db
      .prepare(`SELECT * FROM ${listingsTable} WHERE ${schema.mapping.sourceId} = ?`)
      .bind(SOURCE_ID)
      .all();
    const existing = new Map();
    const preexistingDuplicates = [];
    for (const row of existingRows || []) {
      const key = String(row[externalIdCol] ?? "");
      if (!key) continue;
      if (existing.has(key)) preexistingDuplicates.push(key); // تكرار موجود قبل المزامنة — يُبلَّغ عنه ولا يُلمس
      else existing.set(key, row);
    }
    summary.db.preexisting_duplicate_ids = preexistingDuplicates.length;
    if (preexistingDuplicates.length) summary.db.preexisting_duplicate_sample = preexistingDuplicates.slice(0, 5);

    // 3b) حماية من الطرق المتكرر على التشغيل اليدوي (cron مستثنى)
    const minIntervalS = Number(env.SYNC_MIN_INTERVAL_S) >= 0 ? Number(env.SYNC_MIN_INTERVAL_S) : DEFAULT_MIN_INTERVAL_S;
    if (trigger === "manual" && minIntervalS > 0) {
      const lastMarker = state.get(RUN_MARKER);
      const lastMs = lastMarker ? Date.parse(String(lastMarker.last_synced_at)) : NaN;
      const sinceMs = Date.now() - lastMs;
      if (Number.isFinite(lastMs) && sinceMs < minIntervalS * 1000) {
        summary.status = "throttled";
        summary.errors.push(`manual_run_throttled:retry_after_s=${Math.ceil((minIntervalS * 1000 - sinceMs) / 1000)}`);
        return finalize(summary, startedMs);
      }
    }

    // 4) قائمة ملفات GitHub
    const files = await githubTree(env, summary.github);
    summary.github.files_total = files.length;
    summary.github.truncated = Boolean(summary.github.githubTruncated);

    const seenIds = new Set();      // external_ids اللي اتعالجت في التشغيل ده
    const stateWrites = [];
    let fetchCount = 0;

    for (const f of files) {
      const priorByPath = state.get(f.path) || null;
      const priorId = priorByPath && priorByPath.external_id ? String(priorByPath.external_id) : null;

      // المسار السريع: نفس الـblob SHA والسطر موجود في D1 (أو الملف معروف كغير صالح بنفس المحتوى)
      // ⇒ لا قراءة ولا كتابة
      const priorInvalid = Boolean(priorId && priorId.startsWith(INVALID_MARK));
      if (priorByPath && priorByPath.blob_sha === f.sha && ((priorId && existing.has(priorId)) || priorInvalid)) {
        summary.github.skipped_unchanged++;
        if (priorInvalid) summary.db.unchanged_invalid++;
        else { summary.db.unchanged++; seenIds.add(priorId); }
        continue;
      }

      if (fetchCount >= budget) {
        // تشغيل جزئي مقصود: باقي الملفات في التشغيل الجاي (جدول الحالة = المؤشر)
        summary.github.budget_skipped++;
        summary.github.budget_exhausted = true;
        summary.github.complete = false;
        continue;
      }
      fetchCount++;
      const raw = await githubRaw(env, f.path);
      summary.github.fetched++;
      const contentHash = await sha256Hex(raw);

      const fm = parseFrontMatter(raw);
      if (!fm) {
        summary.invalid_files.push({ file: f.path, reason: "no_front_matter" });
        summary.db.invalid++;
        if (stateEnabled) stateWrites.push([f.path, INVALID_MARK + f.path, f.sha, contentHash]);
        continue;
      }

      const built = buildRecord(fm, f.file, areaIndex);
      const record = built.record;

      if (built.problems.length) {
        summary.invalid_files.push({ file: f.path, reason: built.problems.join(",") });
        summary.db.invalid++;
        if (stateEnabled) stateWrites.push([f.path, INVALID_MARK + f.path, f.sha, contentHash]);
        continue;
      }

      if (seenIds.has(record.externalId)) {
        summary.duplicate_files.push({ file: f.path, external_id: record.externalId });
        summary.db.duplicates++;
        continue;
      }
      seenIds.add(record.externalId);

      if (!record.areaId && record.street) {
        summary.area_unmatched.push({ file: f.path, location: record.street });
      }

      const existingRow = existing.get(record.externalId) || null;

      if (dryRun) {
        summary.db[existingRow ? "updated" : "inserted"]++;
        if (stateEnabled) stateWrites.push([f.path, record.externalId, f.sha, contentHash]);
        continue;
      }

      let result = null;
      try {
        result = await upsertListing(db, listingsTable, schema.mapping, record, existingRow, contentHash);
      } catch (err) {
        // فشل سطر واحد (مثلاً NOT NULL في عمود خارج الخريطة) لا يوقف بقية الملفات،
        // ولا تُكتب حالة الملف ⇒ يعاد المحاولة في التشغيل التالي بعد إصلاح السبب.
        summary.errors.push(`write_failed:${f.path}:${String(err.message || err).slice(0, 160)}`);
        summary.db.write_failures = (summary.db.write_failures || 0) + 1;
        continue;
      }
      if (result.action === "inserted") summary.db.inserted++;
      else if (result.action === "updated") summary.db.updated++;
      else summary.db.unchanged++;

      if (stateEnabled) stateWrites.push([f.path, record.externalId, f.sha, contentHash]);
    }

    // 5) ملفات موجودة في D1 ومختفية من GitHub ⇒ تُسجَّل فقط، بدون أي حذف.
    //    لو التشغيل ده ما استوعبش كل الملفات (budget) النتيجة تبقى «غير معروفة» بدل تقرير خاطئ.
    if (summary.github.budget_exhausted) {
      summary.github.missing_from_github = null;
    } else {
      for (const key of existing.keys()) {
        if (key && !seenIds.has(key)) summary.github.missing_from_github++;
      }
    }

    // 6) كتابة جدول الحالة (batch) — دايمًا مع صف علامة وقت آخر تشغيل
    if (stateEnabled && !dryRun) {
      stateWrites.push([RUN_MARKER, RUN_MARKER, null, null]);
      const stmts = stateWrites.map(([path, externalId, sha, hash]) =>
        db
          .prepare(
            `INSERT INTO ${stateTable} (source_id, external_id, file_path, blob_sha, content_hash, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, external_id) DO UPDATE SET
               file_path = excluded.file_path, blob_sha = excluded.blob_sha,
               content_hash = excluded.content_hash, last_synced_at = excluded.last_synced_at`
          )
          .bind(SOURCE_ID, externalId || `__file__:${path}`, path, sha, hash, nowIso())
      );
      try {
        // D1 batch على دفعات (حدود D1) — بدون أي تأثير على السلوك
        for (let i = 0; i < stmts.length; i += 40) {
          await db.batch(stmts.slice(i, i + 40));
        }
      } catch (err) {
        summary.errors.push(`state_write_failed:${String(err.message).slice(0, 120)}`);
      }
    }

    summary.status = summary.errors.length ? "partial_success" : "success";
  } catch (err) {
    summary.status = "error";
    summary.errors.push(`${String(err.message || err).slice(0, 300)}`);
  }

  const finalSummary = finalize(summary, startedMs);

  // سجل التشغيل (best-effort، لا يكسر التشغيل لو الجدول مختلف)
  try {
    const runInfo = await tableInfo(env.DB, "ingestion_runs");
    if (runInfo) {
      const runMap = buildMapping(runInfo, RUN_COLUMN_MAP);
      finalSummary.logged_to_ingestion_runs = await writeRunLog(env.DB, runMap, finalSummary);
    }
  } catch {
    finalSummary.logged_to_ingestion_runs = false;
  }

  return finalSummary;
}

function finalize(summary, startedMs) {
  summary.finished_at = nowIso();
  summary.duration_ms = Date.now() - startedMs;
  // إزالة الحقول المؤقتة
  delete summary.github.githubTruncated;
  return summary;
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────
async function serviceInfo(env, request) {
  let schema = null;
  let last = null;
  let writeAccess = false;
  try {
    if (env.DB) {
      const full = await readSchemaReport(env.DB, env);
      schema = {
        listings_columns: full.tables.listings,
        missing_required: full.missing_required,
        state_table_exists: full.tables[STATE_TABLE],
        ingestion_runs_columns: full.tables.ingestion_runs,
      };
      writeAccess = Boolean(full.tables.listings) && full.missing_required.length === 0 && Boolean(full.mapping?.sourceId);
      const runInfo = await tableInfo(env.DB, "ingestion_runs");
      if (runInfo) last = await lastRun(env.DB, buildMapping(runInfo, RUN_COLUMN_MAP));
    }
  } catch (err) {
    schema = { error: String(err.message || err).slice(0, 200) };
  }
  return {
    service: SERVICE_NAME,
    status: "running",
    version: WORKER_VERSION,
    source: { id: SOURCE_ID, name: SOURCE_NAME, base_url: SOURCE_BASE_URL },
    github: {
      owner: GITHUB.owner, repo: GITHUB.repo, dir: GITHUB.dir,
      branch: envBranch(env.GITHUB_BRANCH, GITHUB.branch),
    },
    scheduler: "Cloudflare Cron",
    cron: "17 * * * *",
    endpoints: { info: "GET /", schema: "GET /schema", manual: "POST /sync (or GET /sync?dryRun=1)" },
    read_only_sources: ["price_snapshots", "areas", "other source rows"],
    write_scope: { table: "listings", filter: "source_id = 9", deletes: false },
    write_ready: writeAccess,
    schema,
    last_run: last,
  };
}

// تصدير دوال نقية للاختبار فقط — Cloudflare يستخدم default handler فقط.
export const __test = {
  parseFrontMatter,
  buildRecord,
  matchArea,
  normalizeArabic,
  toNumber,
  propertyTypeFromCategory,
  buildMapping,
  isSameAsExisting,
  runSync,
  COLUMN_MAP,
  REQUIRED_FIELDS,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // حماية التشغيل اليدوي: لو SYNC_TOKEN مضبوط، فهو مطلوب
    const authorized = (() => {
      if (!env.SYNC_TOKEN) return true;
      const header = request.headers.get("authorization") || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") || "";
      return token === env.SYNC_TOKEN;
    })();

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json(await serviceInfo(env, request), 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/schema") {
        if (!env.DB) return json({ error: "missing_DB_binding" }, 500, cors);
        return json(await readSchemaReport(env.DB, env), 200, cors);
      }

      if (url.pathname === "/sync") {
        if (!authorized) return json({ error: "unauthorized" }, 401, cors);
        const dryRun = request.method === "GET"
          ? url.searchParams.get("dryRun") !== "0"
          : url.searchParams.get("dryRun") === "1";
        const result = await runSync(env, { trigger: "manual", dryRun });
        const status = result.status === "schema_mismatch" ? 409
          : result.status === "throttled" ? 429
          : 200;
        return json(result, status, cors);
      }

      return json({ error: "not_found", endpoints: ["GET /", "GET /schema", "POST /sync"] }, 404, cors);
    } catch (err) {
      return json({ error: "internal_error", message: String(err.message || err).slice(0, 300) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, { trigger: "cron", dryRun: false }));
  },
};
