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
//   GET  /verify?...  → تقرير تحقق قراءة فقط (counts/duplicates/integrity) على D1 الحقيقي
//   GET  /sync?...    → تشغيل يدوي للتشخيص (dry run افتراضيًا: ?dryRun=1)
//   POST /sync        → التشغيل الفعلي (يتطلب SYNC_TOKEN إن كان مضبوطًا)
//
// Cron Trigger: [triggers] crons = ["17 * * * *"]  (كل ساعة)
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_VERSION = "v1.1.0";
// نسخة قواعد المعالجة فقط. تتغير عند تغيير parsing/scope فقط، لا عند تغيير
// طريقة الجلب — حتى لا يُعاد معالجة 103 ملفات بلا داعٍ بعد نشر نقل البيانات.
const LOGIC_VERSION = "v1.0.4";
// آخر مراجعة: 2026-10-14 — لم يتغيّر أي سلوك. يُنشر من .github/workflows/deploy-properties-sync.yml
// (نشر + تحقق حقيقي على D1) عند أي تغيير في هذا الملف أو في اختباراته أو في wrangler.sync.toml.
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
// GitHub — قائمة الملفات من ai-feed.json المنشور (طلب واحد)
// ───────────────────────────────────────────────────────────────────────────
// لماذا؟ Tree API كان يعطي قائمة الملفات في طلب واحد، لكنه يعتمد على حد
// 60 طلبًا/ساعة للزوار المجهولين، وأي فشل فيه يوقف المزامنة كلها. الـfeed
// المنشور هو مصدر الحقيقة نفسه الذي يقرأه الوكيل وخادم MCP، ويحمل لكل وحدة
// `source_path` (يضيفه قالب Jekyll/المولّد) و`source_sha256` عند توفره.
//
// لا نستخدم أي API غير موثّق: feed أولًا. وإذا غاب source_path (نسخة قديمة
// من الـfeed) وكان GITHUB_TOKEN متاحًا نستخدم Contents API الموثّق كاحتياط
// واحد فقط. بلا توكن ⇒ خطأ واضح في /verify بدل تخمين أسماء ملفات.
const FEED_FALLBACK_DELAYS = [500, 1000, 2000, 4000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { headers = {}, log = null, label = "fetch", attempts = 4 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res = null;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      lastError = new Error(`${label}_network:${String(err.message || err).slice(0, 160)}`);
    }
    if (res) {
      if (log) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        if (remaining !== null) log.rate_limit_remaining = Number(remaining);
        if (reset !== null) log.rate_limit_reset = new Date(Number(reset) * 1000).toISOString();
        log.last_http_status = res.status;
      }
      if (res.ok) return res;
      const status = res.status;
      lastError = new Error(`${label}_failed:${status}`);
      // 404/422 أخطاء دائمة: لا فائدة من إعادة المحاولة
      if (status === 404 || status === 422) break;
      let delay = FEED_FALLBACK_DELAYS[Math.min(attempt - 1, FEED_FALLBACK_DELAYS.length - 1)];
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(parsed) && parsed > 0) delay = Math.min(parsed, 8000);
      } else if ((status === 403 || status === 429) && log && log.rate_limit_remaining === 0 && log.rate_limit_reset) {
        const wait = Date.parse(log.rate_limit_reset) - Date.now() + 1000;
        if (Number.isFinite(wait) && wait > 0) delay = Math.min(wait, 8000);
      }
      if (log) log.retries = (log.retries || 0) + 1;
      if (attempt < attempts) await sleep(Math.min(delay, 8000));
    } else if (attempt < attempts) {
      await sleep(FEED_FALLBACK_DELAYS[Math.min(attempt - 1, FEED_FALLBACK_DELAYS.length - 1)]);
    }
  }
  throw lastError || new Error(`${label}_failed`);
}

function githubHeaders(env) {
  const headers = { "user-agent": WORKER_UA, "accept": "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/** قائمة الملفات من feed المنشور — طلب واحد. */
async function githubFeed(env, log) {
  const branch = envBranch(env.GITHUB_BRANCH, GITHUB.branch);
  const base = String(env.SYNC_FEED_URL || `${SOURCE_BASE_URL}/ai-feed.json`);
  const url = `${base}${base.includes("?") ? "&" : "?"}sync_ts=${Date.now()}`;
  const res = await fetchWithRetry(url, {
    headers: { "user-agent": WORKER_UA, accept: "application/json", "cache-control": "no-cache" },
    log, label: "github_feed", attempts: 4,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("github_feed_invalid_json"); }
  const properties = Array.isArray(data.properties) ? data.properties : [];
  if (!properties.length) throw new Error("github_feed_empty");
  if (log) {
    log.feed_url = base;
    log.feed_generated_at = data.generated_at || null;
    log.feed_total = Number(data.total_count) || properties.length;
    log.branch = branch;
  }
  const prefix = `${GITHUB.dir}/`;
  const files = properties.map((p) => {
    const sourcePath = String(p.source_path || "").trim();
    if (!sourcePath.startsWith(prefix) || !sourcePath.endsWith(".md")) {
      throw new Error(`feed_missing_source_path:${String(p.slug || p.id || "unknown").slice(0, 80)}`);
    }
    return {
      path: sourcePath,
      file: sourcePath.slice(prefix.length),
      sha: String(p.source_sha256 || "").trim(),
      size: null,
    };
  });
  // نفس المسار مرتين = feed غير متسق؛ نرفض بدل كتابة صفوف مكررة.
  const paths = new Set();
  for (const f of files) {
    if (paths.has(f.path)) throw new Error(`feed_duplicate_source_path:${f.path}`);
    paths.add(f.path);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** احتياط موثّق (Contents API) — فقط عند غياب source_path ومع وجود GITHUB_TOKEN. */
async function githubContents(env, log) {
  const branch = envBranch(env.GITHUB_BRANCH, GITHUB.branch);
  const url = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${GITHUB.dir}?ref=${encodeURIComponent(branch)}`;
  const res = await fetchWithRetry(url, { headers: githubHeaders(env), log, label: "github_contents", attempts: 3 });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("github_contents_unexpected_shape");
  if (log) log.fallback_source = "contents-api";
  return data
    .filter((e) => e && e.type === "file" && typeof e.name === "string" && e.name.endsWith(".md"))
    .map((e) => ({ path: `${GITHUB.dir}/${e.name}`, file: e.name, sha: String(e.sha || ""), size: e.size ?? null }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function githubFileList(env, log) {
  try {
    return await githubFeed(env, log);
  } catch (err) {
    const message = String(err.message || err);
    // feed قديم بلا source_path: احتياط واحد فقط إن وُجد توكن (API موثّق، لا Tree).
    if (message.startsWith("feed_missing_source_path") && env.GITHUB_TOKEN) {
      log.feed_error = message;
      return await githubContents(env, log);
    }
    log.feed_error = message.slice(0, 200);
    throw err;
  }
}

async function githubRaw(env, path, log) {
  const branch = envBranch(env.GITHUB_BRANCH, GITHUB.branch);
  const url = `https://raw.githubusercontent.com/${GITHUB.owner}/${GITHUB.repo}/${branch}/${path}`;
  const res = await fetchWithRetry(url, {
    headers: { "user-agent": WORKER_UA }, log, label: `github_raw:${path}`, attempts: 3,
  });
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

  return { record, problems, outOfScope: false, outOfScopeReasons: [], transactionEvidence };
}

// أسماء بديلة آمنة: مشتقة من اسم المنطقة نفسه فقط (بدون أي تخمين)
// «ممر مكرم عبيد» ⇒ «مكرم عبيد» حتى تُطابق الصياغات الشائعة «شارع مكرم عبيد».
function areaAliases(area) {
  const out = new Set();
  for (const raw of area.names || []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    out.add(name);
    const stripped = name.replace(/^ممر\s+/, "").trim();
    if (stripped && stripped !== name) out.add(stripped);
  }
  return [...out];
}

function isCityArea(area) {
  if (area && area.scope) return String(area.scope).toLowerCase() === "city";
  const name = normalizeArabic(area && area.name);
  return name === normalizeArabic(IN_SCOPE_MARKER) || name.startsWith(`${normalizeArabic(IN_SCOPE_MARKER)} `);
}

// R3: قاعدة «الأخص يفوز» — أي منطقة فرعية واضحة تتغلب على عقدة المدينة.
// وفي داخل كل مجموعة (فرعية / مدينة) الأطول يفوز، والمطابقة على كلمات كاملة.
function matchArea(text, areaIndex) {
  if (!text || !areaIndex.length) return null;
  const hay = ` ${normalizeArabic(text)} `;
  const subAreas = areaIndex.filter((a) => !isCityArea(a));
  const cityAreas = areaIndex.filter((a) => isCityArea(a));
  return bestAreaMatch(hay, subAreas) || bestAreaMatch(hay, cityAreas);
}

function bestAreaMatch(hay, areas) {
  let best = null;
  for (const area of areas) {
    for (const name of areaAliases(area)) {
      const needle = normalizeArabic(name);
      if (!needle || needle.length < 4) continue;
      if (containsToken(hay, needle)) {
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
    const scopeCol = cols.has("scope") ? "scope" : null;
    const select = ["id", ...nameCols, ...(scopeCol ? [scopeCol] : [])];
    const { results } = await db.prepare(`SELECT ${select.join(", ")} FROM areas`).all();
    return (results || []).map((r) => ({
      id: r.id,
      name: r[nameCols[0]],
      names: nameCols.map((c) => r[c]).filter(Boolean),
      scope: scopeCol ? r[scopeCol] : null,
    }));
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Upsert (source_id = 9 فقط)
// ───────────────────────────────────────────────────────────────────────────
function pickRowValues(record, mapping, existingRow, clearUnmatchedArea = true) {
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
  // R1: ملف داخل النطاق بلا مطابقة منطقة واضحة ⇒ area_id يجب أن يكون NULL،
  // حتى لو كان في D1 صف قديم بقيمة افتراضية (مدينة نصر) من استيراد سابق — بدون أي تخمين.
  else if (existingRow && clearUnmatchedArea && mapping.areaId && existingRow[mapping.areaId] !== null && existingRow[mapping.areaId] !== undefined) {
    values[mapping.areaId] = null;
  }
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
    if (value === null) {
      // تصفير قصدًا (مثل area_id عند غياب مطابقة) — ليس "لا تغيير"
      if (current === null || current === undefined) continue;
      return false;
    }
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

async function upsertListing(db, listingsTable, mapping, record, existingRow, contentHash, clearUnmatchedArea = true) {
  const values = pickRowValues(record, mapping, existingRow, clearUnmatchedArea);
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
  const cleared = mapping.areaId && values[mapping.areaId] === null && existingRow[mapping.areaId] != null
    ? existingRow[mapping.areaId]
    : null;
  return { action: "updated", changes: res?.meta?.changes ?? null, values, area_cleared: cleared !== null, area_cleared_from: cleared };
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
      out_of_scope: summary.db.out_of_scope,
      out_of_scope_files: summary.out_of_scope_files.slice(0, 25),
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
  const clearUnmatchedArea = String(env.SYNC_CLEAR_UNMATCHED_AREA ?? "1") !== "0";
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
    worker_version: WORKER_VERSION,
    logic_reprocess: false,
    github: {
      source: "ai-feed.json",
      files_total: 0, fetched: 0, skipped_unchanged: 0,
      missing_from_github: 0, budget_skipped: 0, budget_exhausted: false,
      complete: true, truncated: false,
      feed_url: null, feed_generated_at: null, feed_total: null,
      retries: 0, last_http_status: null, rate_limit_remaining: null,
      rate_limit_reset: null, feed_error: null,
    },
    db: {
      inserted: 0, updated: 0, unchanged: 0, unchanged_invalid: 0, unchanged_out_of_scope: 0, area_cleared: 0,
      invalid: 0, out_of_scope: 0, duplicates: 0, write_failures: 0, writes_blocked: false,
    },
    area_cleared: [],
    invalid_files: [],
    out_of_scope_files: [],
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

    // 4) قائمة ملفات GitHub من feed المنشور (طلب واحد) — لا Tree API
    const files = await githubFileList(env, summary.github);
    summary.github.files_total = files.length;
    summary.github.truncated = false;
    // ترتيب الأولويات: الملفات غير المعالجة/الأقدم في جدول الحالة أولًا، حتى
    // يكمل التشغيل الجزئي (budget) من حيث توقف بدل أن يعيد قراءة نفس الملفات.
    files.sort((a, b) => {
      const ta = (state.get(a.path) || {}).last_synced_at || "";
      const tb = (state.get(b.path) || {}).last_synced_at || "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    const seenIds = new Set();      // external_ids اللي اتعالجت في التشغيل ده
    const excludedIds = new Set();  // external_ids الملفات خارج النطاق (R2) — مش «مختفية»
    const stateWrites = [];
    let fetchCount = 0;

    for (const f of files) {
      const priorByPath = state.get(f.path) || null;
      const priorId = priorByPath && priorByPath.external_id ? String(priorByPath.external_id) : null;

      // المسار السريع: نفس الـblob SHA والسطر موجود في D1 (أو الملف معروف كمستبعد بنفس المحتوى)
      // ⇒ لا قراءة ولا كتابة
      const priorInvalid = Boolean(priorId && priorId.startsWith(INVALID_MARK));
      const priorOutOfScope = Boolean(priorId && priorId.startsWith(OOS_MARK));
      // كل صف حالة يحمل نسخة منطق الـWorker اللي عالجته؛ الملف اللي اتعالج بنسخة أقدم
      // يُعاد معالجته مرة واحدة (فتُطبَّق القواعد الجديدة على الصفوف القديمة)، والتشغيل
      // الجزئي يكمّل من حيث انتهى لأن الصفوف المُعاد معالجتها بقت بالنسخة الحالية.
      const priorLogic = priorByPath && priorByPath.content_hash
        ? String(priorByPath.content_hash).split(":")[0]
        : null;
      const sameLogic = priorLogic === LOGIC_VERSION;
      if (priorByPath && !sameLogic) summary.logic_reprocess = true;
      if (sameLogic && priorByPath && f.sha && priorByPath.blob_sha === f.sha && ((priorId && existing.has(priorId)) || priorInvalid || priorOutOfScope)) {
        summary.github.skipped_unchanged++;
        if (priorInvalid) summary.db.unchanged_invalid++;
        else if (priorOutOfScope) summary.db.unchanged_out_of_scope++;
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
      const raw = await githubRaw(env, f.path, summary.github);
      summary.github.fetched++;
      const contentHash = await sha256Hex(raw);

      const fm = parseFrontMatter(raw);
      if (!fm) {
        summary.invalid_files.push({ file: f.path, reason: "no_front_matter" });
        summary.db.invalid++;
        if (stateEnabled) stateWrites.push([f.path, INVALID_MARK + f.path, f.sha, `${LOGIC_VERSION}:${contentHash}`]);
        continue;
      }

      const built = buildRecord(fm, f.file, areaIndex);
      const record = built.record;

      // R1 + R2: خارج نطاق مدينة نصر ⇒ لا INSERT ولا UPDATE إطلاقًا
      if (built.outOfScope) {
        summary.out_of_scope_files.push({ file: f.path, reasons: built.outOfScopeReasons });
        summary.db.out_of_scope++;
        excludedIds.add(record.externalId);
        if (stateEnabled) stateWrites.push([f.path, OOS_MARK + f.path, f.sha, `${LOGIC_VERSION}:${contentHash}`]);
        continue;
      }

      if (built.problems.length) {
        summary.invalid_files.push({ file: f.path, reason: built.problems.join(",") });
        summary.db.invalid++;
        if (stateEnabled) stateWrites.push([f.path, INVALID_MARK + f.path, f.sha, `${LOGIC_VERSION}:${contentHash}`]);
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
        if (stateEnabled) stateWrites.push([f.path, record.externalId, f.sha, `${LOGIC_VERSION}:${contentHash}`]);
        continue;
      }

      let result = null;
      try {
        result = await upsertListing(db, listingsTable, schema.mapping, record, existingRow, contentHash, clearUnmatchedArea);
        if (result.area_cleared) {
          summary.db.area_cleared = (summary.db.area_cleared || 0) + 1;
          summary.area_cleared.push({ file: f.path, was: result.area_cleared_from });
        }
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

      if (stateEnabled) stateWrites.push([f.path, record.externalId, f.sha, `${LOGIC_VERSION}:${contentHash}`]);
    }

    // 5) ملفات موجودة في D1 ومختفية من GitHub ⇒ تُسجَّل فقط، بدون أي حذف.
    //    لو التشغيل ده ما استوعبش كل الملفات (budget) النتيجة تبقى «غير معروفة» بدل تقرير خاطئ.
    if (summary.github.budget_exhausted) {
      summary.github.missing_from_github = null;
    } else {
      for (const key of existing.keys()) {
        if (key && !seenIds.has(key) && !excludedIds.has(key)) summary.github.missing_from_github++;
      }
    }

    // 6) كتابة جدول الحالة (batch) — دايمًا مع صف علامة وقت آخر تشغيل
    if (stateEnabled && !dryRun) {
      stateWrites.push([RUN_MARKER, RUN_MARKER, null, LOGIC_VERSION]);
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
    worker_version: WORKER_VERSION,
    logic_reprocess: false,
    version: WORKER_VERSION,
    source: { id: SOURCE_ID, name: SOURCE_NAME, base_url: SOURCE_BASE_URL },
    github: {
      owner: GITHUB.owner, repo: GITHUB.repo, dir: GITHUB.dir,
      branch: envBranch(env.GITHUB_BRANCH, GITHUB.branch),
      file_list: "ai-feed.json (single request)",
      feed_url: String(env.SYNC_FEED_URL || `${SOURCE_BASE_URL}/ai-feed.json`),
      fallback: "contents-api (only with GITHUB_TOKEN and a feed without source_path)",
    },
    scheduler: "Cloudflare Cron",
    cron: "17 * * * *",
    cache_policy: { clear_unmatched_area: true },
    endpoints: {
      info: "GET /",
      schema: "GET /schema",
      verify: "GET /verify?in_scope=&out_of_scope=&invalid=&null_area=&rows= (read-only D1 report)",
      manual: "POST /sync (or GET /sync?dryRun=1)",
    },
    read_only_sources: ["price_snapshots", "areas", "other source rows"],
    write_scope: { table: "listings", filter: "source_id = 9", deletes: false },
    scope_policy: {
      in_scope: "مدينة نصر فقط",
      out_of_scope_action: "لا INSERT ولا UPDATE — يُسجَّل في out_of_scope_files",
      area_rule: "المنطقة الفرعية تتغلب على عقدة المدينة (الأخص يفوز)، ولا area_id عند غياب مطابقة واضحة",
    },
    write_ready: writeAccess,
    schema,
    last_run: last,
  };
}

// تصدير دوال نقية للاختبار فقط — Cloudflare يستخدم default handler فقط.
// ───────────────────────────────────────────────────────────────────────────
// تقرير تحقّق قراءة فقط (GET/POST /verify) — بدون أي كتابة إطلاقًا
// يستخدمه الـCI لتنفيذ checklist التسليم على D1 الحقيقي من خلال نفس الـbinding،
// فمش محتاج صلاحية D1 على الـAPI token.
// ───────────────────────────────────────────────────────────────────────────
const VERIFY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function parseIdList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(",")) {
    const id = part.trim();
    if (!VERIFY_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

async function scalar(db, sql, binds = []) {
  try {
    const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
    const { results } = await stmt.all();
    const row = (results || [])[0] || {};
    const value = Object.values(row)[0];
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return value;
    const n = Number(value);
    return Number.isFinite(n) && String(value).trim() !== "" ? n : value;
  } catch (err) {
    return { error: String(err.message || err).slice(0, 160) };
  }
}

async function manyRows(db, sql, binds = []) {
  try {
    const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
    const { results } = await stmt.all();
    return results || [];
  } catch (err) {
    return { error: String(err.message || err).slice(0, 160) };
  }
}

// صحة التشغيل كما يراها /verify: هل آخر خطأ أحدث من آخر نجاح؟
// لا كتابة هنا إطلاقًا — الخطأ «يُمسَح» منطقيًا بمجرد تسجيل تشغيل ناجح أحدث.
async function runHealth(db, runMap) {
  const empty = { available: false, active: false, last_success: null, last_error: null };
  if (!runMap || !runMap.status) return empty;
  const rows = await manyRows(
    db,
    `SELECT rowid AS __rowid, * FROM ingestion_runs WHERE source_id = ? ORDER BY rowid DESC LIMIT 25`,
    [SOURCE_ID]
  );
  if (!Array.isArray(rows)) return { ...empty, error: rows.error };
  const shape = (r) => ({
    rowid: r.__rowid,
    status: runMap.status ? r[runMap.status] ?? null : null,
    started_at: runMap.startedAt ? r[runMap.startedAt] ?? null : null,
    finished_at: runMap.finishedAt ? r[runMap.finishedAt] ?? null : null,
    errors_count: runMap.errorsCount ? r[runMap.errorsCount] ?? null : null,
    details: runMap.details ? String(r[runMap.details] ?? "").slice(0, 1200) : null,
  });
  const statusOf = (r) => String(r[runMap.status] ?? "");
  const success = rows.find((r) => statusOf(r) === "success");
  const failure = rows.find((r) => statusOf(r) === "error" || statusOf(r) === "partial_success");
  const active = Boolean(failure && (!success || Number(failure.__rowid) > Number(success.__rowid)));
  return {
    available: true,
    active,
    last_success: success ? shape(success) : null,
    last_error: failure ? shape(failure) : null,
    note: active
      ? "آخر تشغيل فاشل أو جزئي أحدث من آخر نجاح — بيانات D1 قد تكون قديمة. رسالة الخطأ في last_error.details."
      : "لا خطأ نشط: لا يوجد خطأ أحدث من آخر تشغيل ناجح.",
  };
}

async function verificationReport(env, { outOfScopeIds = [], invalidIds = [], nullAreaIds = [], inScopeIds = [], rowLists = [] } = {}) {
  const db = env.DB;
  const listingsTable = envIdent(env.LISTINGS_TABLE, "listings");
  const schema = await readSchemaReport(db, env);
  const map = schema.mapping || {};
  const sourceCol = map.sourceId;
  const externalCol = map.externalId;
  const areaCol = map.areaId;

  const inList = async (ids, extra = "") => {
    if (!externalCol || !sourceCol || !ids.length) return { checked: ids.length, present: 0 };
    const ph = ids.map(() => "?").join(",");
    const n = await scalar(
      db,
      `SELECT COUNT(*) AS n FROM ${listingsTable} WHERE ${sourceCol} = ? AND ${externalCol} IN (${ph})${extra}`,
      [SOURCE_ID, ...ids]
    );
    return { checked: ids.length, present: n };
  };

  const counts = {
    listings_total: await scalar(db, `SELECT COUNT(*) AS n FROM ${listingsTable}`),
    source9_total: sourceCol ? await scalar(db, `SELECT COUNT(*) AS n FROM ${listingsTable} WHERE ${sourceCol} = ?`, [SOURCE_ID]) : null,
    source9_null_area: sourceCol && areaCol
      ? await scalar(db, `SELECT COUNT(*) AS n FROM ${listingsTable} WHERE ${sourceCol} = ? AND ${areaCol} IS NULL`, [SOURCE_ID])
      : null,
    areas_total: await scalar(db, "SELECT COUNT(*) AS n FROM areas"),
    price_snapshots_total: await scalar(db, "SELECT COUNT(*) AS n FROM price_snapshots"),
  };

  const dupRows = externalCol && sourceCol
    ? await manyRows(
        db,
        `SELECT ${externalCol} AS external_id, COUNT(*) AS n FROM ${listingsTable} WHERE ${sourceCol} = ? GROUP BY ${externalCol} HAVING COUNT(*) > 1 LIMIT 20`,
        [SOURCE_ID]
      )
    : [];

  const stateTable = envIdent(env.STATE_TABLE, STATE_TABLE);
  const stateRows = await manyRows(db, `SELECT external_id, file_path FROM ${stateTable} WHERE ${sourceCol ? "source_id" : "source_id"} = ?`, [SOURCE_ID]);
  const stateList = Array.isArray(stateRows) ? stateRows : [];
  const stateInfo = {
    rows: stateList.length,
    files_tracked: stateList.filter((r) => r.external_id !== RUN_MARKER).length,
    in_scope: stateList.filter((r) => !String(r.external_id || "").startsWith(INVALID_MARK) && !String(r.external_id || "").startsWith(OOS_MARK) && r.external_id !== RUN_MARKER).length,
    invalid: stateList.filter((r) => String(r.external_id || "").startsWith(INVALID_MARK)).length,
    out_of_scope: stateList.filter((r) => String(r.external_id || "").startsWith(OOS_MARK)).length,
    invalid_files: stateList.filter((r) => String(r.external_id || "").startsWith(INVALID_MARK)).map((r) => r.file_path).sort(),
    out_of_scope_files: stateList.filter((r) => String(r.external_id || "").startsWith(OOS_MARK)).map((r) => r.file_path).sort(),
  };

  const fkRows = await manyRows(db, "PRAGMA foreign_key_check");
  const integrity = await scalar(db, "PRAGMA integrity_check");
  // quick_check أقل تقييدًا من D1؛ لو مسموح فهو بديل مفيد (integrity_check ممنوع في D1)
  const quick = await scalar(db, "PRAGMA quick_check");

  // صفوف كاملة لمجموعات محددة صراحةً (تُستخدم لإثبات أن الـWorker لم يلمس صفوفًا خارج نطاقه)
  const listingsColumns = (schema.tables && schema.tables.listings) || [];
  const pickup = ["id", map.sourceId, map.externalId, map.title, map.transactionType, map.propertyType, map.price, map.areaM2, map.areaId].filter(Boolean);
  const selectCols = [];
  for (const c of pickup) if (listingsColumns.includes(c) && !selectCols.includes(c)) selectCols.push(c);
  const rowsFor = async (ids, key) => {
    if (!rowLists.includes(key) || !externalCol || !sourceCol || !ids.length || !selectCols.length) return null;
    const ph = ids.map(() => "?").join(",");
    return manyRows(
      db,
      `SELECT ${selectCols.join(", ")} FROM ${listingsTable} WHERE ${sourceCol} = ? AND ${externalCol} IN (${ph}) ORDER BY ${externalCol}`,
      [SOURCE_ID, ...ids]
    );
  };

  let lastRunInfo = null;
  try {
    const runCols = await tableInfo(db, "ingestion_runs");
    if (runCols) {
      const runMap = buildMapping(runCols, RUN_COLUMN_MAP);
      const row = await lastRun(db, runMap);
      if (row) {
        const notes = row[runMap.details] ?? row.notes ?? null;
        lastRunInfo = {
          started_at: runMap.startedAt ? row[runMap.startedAt] : null,
          status: runMap.status ? row[runMap.status] : null,
          notes: typeof notes === "string" ? notes.slice(0, 2000) : null,
        };
      }
    }
  } catch {
    lastRunInfo = null;
  }

  return {
    service: SERVICE_NAME,
    version: WORKER_VERSION,
    source_id: SOURCE_ID,
    source_name: SOURCE_NAME,
    checked_at: new Date().toISOString(),
    last_run: lastRunInfo,
    run_health: await runHealth(db, schema.run_mapping),
    read_only: true,
    listings_table: listingsTable,
    mapping: { sourceId: sourceCol, externalId: externalCol, areaId: areaCol },
    counts,
    duplicates: {
      count: Array.isArray(dupRows) ? dupRows.length : null,
      sample: dupRows,
    },
    lists: {
      in_scope: await inList(inScopeIds),
      out_of_scope: await inList(outOfScopeIds),
      invalid: await inList(invalidIds),
      null_area: await inList(nullAreaIds, areaCol ? ` AND ${areaCol} IS NULL` : ""),
      null_area_checked: Boolean(areaCol),
    },
    state: stateInfo,
    preexisting_rows: {
      out_of_scope: await rowsFor(outOfScopeIds, "out_of_scope"),
      invalid: await rowsFor(invalidIds, "invalid"),
    },
    integrity: {
      foreign_key_check: Array.isArray(fkRows) ? fkRows.length : fkRows,
      integrity_check: integrity,
      quick_check: quick,
    },
  };
}

export const __test = {
  parseFrontMatter,
  buildRecord,
  matchArea,
  detectOutOfScope,
  containsToken,
  areaAliases,
  isCityArea,
  OUT_OF_SCOPE_MARKERS,
  CONDITIONAL_OUT_OF_SCOPE_MARKERS,
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

      // تقرير تحقق قراءة فقط — يُنفَّذ على D1 الحقيقي بدون أي كتابة (بديل مستقل عن صلاحية D1 API)
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/verify") {
        if (!authorized) return json({ error: "unauthorized" }, 401, cors);
        if (!env.DB) return json({ error: "missing_DB_binding" }, 500, cors);
        return json(
          await verificationReport(env, {
            outOfScopeIds: parseIdList(url.searchParams.get("out_of_scope")),
            invalidIds: parseIdList(url.searchParams.get("invalid")),
            nullAreaIds: parseIdList(url.searchParams.get("null_area")),
            inScopeIds: parseIdList(url.searchParams.get("in_scope")),
            rowLists: (url.searchParams.get("rows") || "").split(",").map((x) => x.trim()).filter((x) => x === "out_of_scope" || x === "invalid"),
          }),
          200,
          cors
        );
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

      return json({ error: "not_found", endpoints: ["GET /", "GET /schema", "GET /verify", "POST /sync"] }, 404, cors);
    } catch (err) {
      return json({ error: "internal_error", message: String(err.message || err).slice(0, 300) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, { trigger: "cron", dryRun: false }));
  },
};
