import {
  calculateMarketTotals,
  findAreaMention,
  getMarketSnapshot,
  listMarketAreas,
  normalizeArabic as normalizeMarketText,
  normalizePropertyType as normalizeMarketPropertyType,
  normalizeRentCondition,
  normalizeTransaction as normalizeMarketTransaction,
} from "./market-data.js";

// ============================================================
// سمسار طلبك — Cloudflare Worker v8.5-MAPS + D1 MARKET
// طارق طنطاوي | مدينة نصر | 2014–2026
// Google Local Guide Level 7 | 16.3M+ Views
// Gemini للردود الحوارية + D1 حتمي لأسئلة السوق + رسالة مؤهلة كاملة
// ------------------------------------------------------------
// تحسينات v8.4 (بدون كسر أي وظيفة أو أي حقل في الـ JSON):
//  • أمان: CORS مقيّد بنطاقات الموقع، مفتاح Gemini في Header مش في الـ URL،
//    حماية /upload-images (rate limit + تحقق من الصور + حجم أقصى)،
//    تنظيف مدخلات المستخدم قبل ما تروح للـ AI (منع Prompt Injection)،
//    وإخفاء بيانات العميل الشخصية عن الـ AI.
//  • أداء: timeouts على كل fetch خارجي، رفع الصور بالتوازي،
//    Levenshtein بذاكرة O(n) بدل O(n·m)، كاش للتطبيع العربي،
//    وتحميل المناطق (landmarks) عند الحاجة فقط.
//  • تنظيم: استخراج الدوال المتكررة، ثوابت بدل النصوص السحرية،
//    معالجة أخطاء موحّدة مع لوجات قابلة للتتبّع.
// ============================================================

// ═══ CONSTANTS ═══
const ALAA_PHONE         = "+201022171667";
const TAREK_PHONE        = "201147758857";
const OFFICE_ADDRESS     = "16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر";
const OFFICE_MAP_URL     = "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7";
const OFFICE_HOURS       = "من 12 الضهر لحد 9 بالليل، ما عدا الجمعة";
const AI_FEED_URL        = "https://nasr-realestate.github.io/ai-feed.json";
const GEMINI_MODEL       = "gemini-3.5-flash-lite";
const GEMINI_BASE        = "https://generativelanguage.googleapis.com/v1beta/models";
const CACHE_TTL_MS       = 5 * 60 * 1000;
const LANDMARKS_TTL_MS   = 60 * 60 * 1000;
const GEMINI_CACHE_TTL   = 30 * 60 * 1000;
const MAX_IMAGES         = 5;
const MIN_SCORE          = 25;
const FORM_VERSION       = "v83";
const RATE_WINDOW_MS     = 30 * 1000;
const RATE_MAX           = 15;
const MAX_VISIBLE_LM     = 8;

// ═══ حدود الأمان والأداء (جديد في v8.4) ═══
// مهلات زمنية: الـ Worker عنده حد أقصى للـ CPU/الاستجابة، فلازم نقطع أي طلب خارجي بطيء
const FETCH_TIMEOUT_FEED   = 6000;   // مهلة تحميل ai-feed.json
const FETCH_TIMEOUT_GEMINI = 8000;   // مهلة استدعاء Gemini
const FETCH_TIMEOUT_IMGBB  = 15000;  // مهلة رفع الصورة الواحدة
// حدود الرسائل والصور — تمنع إغراق الـ Worker بحمولات ضخمة
const MAX_MSG_LEN          = 1000;   // أقصى طول لرسالة المستخدم
const MAX_HISTORY          = 20;     // أقصى عدد رسائل من السجل نعتمد عليها
const MAX_BODY_BYTES       = 12 * 1024 * 1024; // أقصى حجم للـ request body (الصور base64)
const MAX_IMG_BYTES        = 6 * 1024 * 1024;  // أقصى حجم للصورة الواحدة بعد فك base64
const UPLOAD_RATE_WINDOW   = 60 * 1000; // نافذة حد رفع الصور
const UPLOAD_RATE_MAX      = 6;         // أقصى عدد عمليات رفع في الدقيقة لكل IP
const RATE_MAP_MAX_KEYS    = 5000;      // سقف حجم خرائط الـ rate limit (منع تضخم الذاكرة)
const CACHE_MAX_KEYS       = 500;       // سقف حجم الكاشات الداخلية

// النطاقات المسموح لها باستدعاء الـ Worker — بديل آمن لـ "*"
// ملاحظة: أضف أي دومين جديد هنا (أو عبر متغير البيئة ALLOWED_ORIGINS مفصولاً بفواصل)
const DEFAULT_ALLOWED_ORIGINS = [
  "https://nasr-realestate.github.io",
];

const TAREK_PERSONA = `أنت وكيل سمسار طلبك المؤتمت، ولست طارقًا شخصيًا.
رتّب الطلب مبدئيًا، ولا تدّعِ أنك إنسان أو أن طارق يرد الآن.
بتكتب من موبايلك في الشارع أو المكتب.`;

const MOOD_GUIDE = `عامية مصرية محترمة، مختصر وواضح، بلا مبالغة.
عند سؤال الهوية أو طلب إنسان: اعترف بالأتمتة وقدّم رابط طارق.
اقرا مزاج العميل: مستعجل → اختصر. بيهزر → خفة دم. قلقان → طمّنه.`;

const IDENTITY_RESPONSE = `أنا وكيل ذكي مؤتمت، مش طارق شخصيًا.
مهمتي أرتّب طلبك مبدئيًا، والقرار النهائي دايمًا معاه.
لو محتاج تكلم طارق مباشرة:

📲 [https://wa.me/201147758857](https://wa.me/201147758857)

عايز نكمل طلبك؟`;

// ═══ GOOGLE AUTHORITY ═══
const GOOGLE_PROFILE = {
  url: "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7",
  level: 7,
  badge: "Google Local Guide Level 7",
  points: 7741,
  maxPoints: 15000,
  photosCount: 468,
  totalViews: 16273294,
  formattedViews: "16.3 مليون",
  reviewsCount: 195,
  ratingsCount: 39,
  description: "Real Estate Agent in Nasr City",
  office: "مدينة نصر — القاهرة",
};

// ═══ BUTTONS ═══
const BTN = {
  BUY:         "🔍 أشتري",
  TENANT:      "🏠 أستأجر",
  SELL:        "💰 أبيع",
  LANDLORD:    "🔑 أأجر",
  SKIP:        "تخطي السؤال ⏭",
  SEND:        "ابعت البيانات دلوقتي ✅",
  CANCEL:      "إلغاء التسجيل ✕",
  BACK:        "⬅️ رجوع",
  CANCEL_BACK: "إلغاء الرجوع",
  ANY_AREA:    "أي منطقة في مدينة نصر",
  MORE:        "➕ المزيد",
  FIRST_LIST:  "⬅️ القائمة الأولى",
  ATTACH_IMG:  "📷 أرفق صور",
  SKIP_IMG:    "⏭ تخطي (بدون صور)",
  ADD_IMG:     "📷 إضافة صور",
  DEL_IMG:     "🗑️ احذف الكل",
  IMG_DONE:    "✅ تمام، كمّل",
  SEND_WA:     "✅ ابعت على واتساب",
  PREVIEW:     "📄 معاينة الرسالة",
  EDIT:        "⬅️ عدّل حاجة",
  NEW_REQ:     "🆕 طلب جديد",
  BOOK_VIEW:   "📅 احجز معاينة",
  BACK_LIST:   "🔙 رجوع للعقارات",
  OTHER_PROP:  "🔄 مواصفات تانية",
  ACCEPT:      "✅ تمام، ده اللي عايزه",
  CUSTOM_SPEC: "📲 ابعت طلبي بالمواصفات دي لطارق",
};

const ROUTE_BTNS      = [BTN.BUY, BTN.TENANT, BTN.SELL, BTN.LANDLORD];
const POST_COMPLETE   = [BTN.SEND_WA, BTN.PREVIEW, BTN.EDIT, BTN.NEW_REQ];
const POST_PREVIEW    = [BTN.SEND_WA, BTN.EDIT, BTN.NEW_REQ];
const POST_SELECTED   = [BTN.BOOK_VIEW, BTN.SEND_WA, BTN.PREVIEW, BTN.BACK_LIST, BTN.NEW_REQ];
const POST_VIEWING    = [BTN.SEND_WA, BTN.BACK_LIST, BTN.NEW_REQ];

// ═══ PROPERTY TYPES MAP ═══
const PT_MAP = {
  "شقة":        "apartment",
  "فيلا":       "villa",
  "دوبلكس":     "duplex",
  "روف":        "roof",
  "محل تجاري":  "shop",
  "مكتب إداري": "office",
  "مخزن":       "storage",
};

// ═══ SUBTYPE OPTIONS ═══
const SUBTYPE_OPTIONS = {
  "شقة":        ["أرضي","أول","ثاني","ثالث","رابع","خامس","سادس","سابع","ثامن","تاسع","عاشر","أخير","بدروم"],
  "فيلا":       ["فيلا مستقلة","تاون هاوس","توين هاوس","أرضي مع حديقة","أرضي + أول (دوبلكس)"],
  "دوبلكس":     ["أرضي + أول بحديقة","دوبلكس علوي","بنتهاوس دوبلكس"],
  "روف":        ["روف مبني بتراس","بنتهاوس","مساحة مفتوحة","روف في عمارة"],
  "محل تجاري":  ["أرضي تجاري","ناصية","واجهة على شارع رئيسي","داخل مول","ميزانين"],
  "مكتب إداري": ["مبنى إداري مرخص","دور إداري مستقل","داخل مول","أرضي إداري"],
  "مخزن":       ["بدروم","أرضي","مستقل / جمالون","داخل مبنى"],
};

function getSubtypeOptions(pt) {
  return SUBTYPE_OPTIONS[pt] || SUBTYPE_OPTIONS["شقة"];
}

// ═══ MASTER LANDMARKS ═══
const MASTER_LANDMARKS = [
  "عباس العقاد","مكرم عبيد","مصطفى النحاس","شارع الطيران",
  "حسن المأمون","حسنين هيكل","يوسف عباس","أحمد فؤاد نسيم",
  "عبد الحميد بدوي","الطوخي","شارع النصر","رابعة العدوية",
  "شينزو آبي","الحي السابع","الحي الثامن","الحي العاشر",
  "المنطقة الأولى","المنطقة السادسة","المنطقة السابعة",
  "المنطقة التاسعة","المنطقة العاشرة","المربع الذهبي",
  "المربع الفندقي","زهراء مدينة نصر","الوفاء والأمل",
  "الواحة","حي السفارات","أرض الجولف","شيراتون",
  "النزهة","أحمد فخري","عبد الله العربي","معز الدولة",
  "المقريفي","حلمي حسن علي","إبراهيم نواره",
  "التعاونيات","سراج مول"
];

// ═══ HELPERS ═══
const isResidential = pt => ["شقة","فيلا","دوبلكس","روف"].includes(pt);
const isCommercial  = pt => ["محل تجاري","مكتب إداري","مخزن"].includes(pt);
const isShop        = pt => pt === "محل تجاري" || pt === "محل";
const isOffice      = pt => pt === "مكتب إداري" || pt === "مكتب";
const isWarehouse   = pt => pt === "مخزن";
const isVilla       = pt => pt === "فيلا";
const isDuplex      = pt => pt === "دوبلكس";

function toEnNum(s) {
  return String(s||"").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

function parseNum(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const c = toEnNum(String(v)).replace(/,/g,"").replace(/[^\d.]/g,"");
  const n = parseFloat(c);
  return isNaN(n) ? 0 : n;
}

function fmtNum(v) {
  if (!v && v !== 0) return "0";
  const n = parseNum(v);
  return toEnNum(n < 100000 ? String(n) : n.toLocaleString("en-US"));
}

function hasVal(v) {
  return v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "—";
}

function fmtVal(v) { return hasVal(v) ? toEnNum(String(v).trim()) : "—"; }

// تطبيع النص العربي — بيتنادى آلاف المرات في المطابقة، فبنكاش النتيجة
// الكاش محدود الحجم عشان ميكبرش مع الوقت في نفس الـ isolate
const _normCache = new Map();
function normAr(s) {
  const raw = String(s||"");
  if (raw.length <= 64) {
    const hit = _normCache.get(raw);
    if (hit !== undefined) return hit;
  }
  const out = raw
    .replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[أإآٱ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي")
    .replace(/[ًٌٍَُِّْـ]/g,"").replace(/[^\w\u0600-\u06FF]/g,"")
    .toLowerCase().trim();
  if (raw.length <= 64) {
    if (_normCache.size >= CACHE_MAX_KEYS) _normCache.clear();
    _normCache.set(raw, out);
  }
  return out;
}

function normalizePropType(pt) {
  if (!pt) return "";
  const s = normAr(String(pt));
  if (s.includes("شقق") || s.includes("شقه") || s.includes("شقة") || s.includes("apartment") || s.includes("flat")) return "شقة";
  if (s.includes("دوبلكس") || s.includes("duplex")) return "دوبلكس";
  if (s.includes("فيلا") || s.includes("فيلات") || s.includes("villa") || s.includes("townhouse") || s.includes("twinhouse")) return "فيلا";
  if (s.includes("روف") || s.includes("سطح") || s.includes("roof") || s.includes("penthouse")) return "روف";
  if (s.includes("محل") || s.includes("تجاري") || s.includes("shop") || s.includes("store") || s.includes("retail")) return "محل تجاري";
  if (s.includes("مكتب") || s.includes("اداري") || s.includes("إداري") || s.includes("office") || s.includes("admin")) return "مكتب إداري";
  if (s.includes("مخزن") || s.includes("مستودع") || s.includes("storage") || s.includes("warehouse")) return "مخزن";
  return s;
}

function isBtn(msg, label) {
  const a = String(msg||"").trim(), b = String(label||"").trim();
  if (!a||!b) return false;
  return a === b || normAr(a) === normAr(b);
}

function matchOpt(input, options) {
  if (!options?.length) return null;
  const n = normAr(input);
  if (!n||n.length<1) return null;
  for (const o of options) if (normAr(o)===n) return o;
  if (n.length<2) return null;
  const sorted = [...options].sort((a,b)=>normAr(b).length-normAr(a).length);
  for (const o of sorted) {
    const on = normAr(o);
    if (on?.length>=2 && (on.includes(n)||n.includes(on))) return o;
  }
  return null;
}

function normPhone(s) {
  let d = toEnNum(String(s||"")).replace(/\D/g,"");
  if (d.startsWith("2001")) d = d.slice(2);
  else if (d.startsWith("20")&&d.length>=12) d = "0"+d.slice(2);
  if (d.startsWith("1")&&d.length===10) d = "0"+d;
  return d;
}

function extractPrice(text) {
  const c = toEnNum(String(text||""));
  const m  = c.match(/(\d+\.?\d*)\s*(مليون|مليون جنيه)/);
  if (m) return parseFloat(m[1])*1000000;
  const k  = c.match(/(\d+\.?\d*)\s*(الف|ألف|k)(?!\w)/i);
  if (k) return parseFloat(k[1])*1000;
  const d  = c.match(/(\d{4,})/);
  if (d && parseFloat(d[1])>=10000) return parseFloat(d[1]);
  return null;
}

function isOwnerSaleIntent(message) {
  const text = normalizeMarketText(message);
  return /(?:عايز|عاوز|حابب|ارغب|اريد|ناوي|نفسي|بفكر|محتاج|ابغى).{0,40}(?:ابيع|بيع|اعرض|تبيع)/.test(text)
    || /عندي.{0,80}(?:شقه|عقار|فيلا|دوبلكس|محل|مكتب|روف).{0,70}(?:عايز|عاوز|حابب|ارغب|ناوي|ابيع|بيع)/.test(text)
    || /(?:ابيع|بيع).{0,30}(?:شقتي|عقاري|عقار|فيلا|دوبلكس|محلي|مكتبي|روفي)/.test(text);
}

function isMarketQuestion(message) {
  const text = normalizeMarketText(message);
  return /سعر\s*المتر|المتر\s*(?:بكام|كام|سعره)|سعر\s*السوق|متوسط\s*(?:السعر|الاسعار)|قيمه\s*(?:عقاري|الشقه|شقتي)|(?:شقتي|عقاري(?:\s*بتاعي)?|الشقه(?:\s*بتاعتي)?).{0,30}(?:تسوي|تساوي|قيمه|كام)|(?:تسوي|تساوي)\s*كام|هل\s*السعر\s*(?:مناسب|عادل)|السعر\s*(?:مناسب|عادل)|التقييم\s*كام|قبل\s*البيع/.test(text);
}

function isValuationIntent(message) {
  const text = normalizeMarketText(message);
  return isMarketQuestion(message)
    || /(?:قيم|تقييم|تسوي|تساوي|قيمه).{0,30}(?:شقتي|عقاري|الشقه|عقار)|(?:شقتي|الشقه|عقاري).{0,30}(?:ابيع|بيع|تسوي|تساوي)/.test(text);
}

function isListingSearchIntent(message) {
  const text = normalizeMarketText(message);
  return /معروض|المعروض|متاح|متوفر|بدور|ادور|ابحث|اشوف|اعرضلي|وريني|عندكم\s*(?:شقق|عقارات|وحدات)|عايز\s+(?:اشتري|شقه|عقار|فيلا|دوبلكس|محل|مكتب)/.test(text);
}

function extractPropertySize(message) {
  const text = toEnNum(String(message || "")).replace(/٬/g, ",");
  const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:متر(?:\s*مربع)?|م\s*(?:²|2)|sqm)/i);
  if (!match) return 0;
  const size = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(size) && size >= 20 && size <= 100000 ? size : 0;
}

function propertyTypeLabel(type) {
  return ({
    apartment: "شقة", duplex: "دوبلكس", villa: "فيلا", roof: "روف",
    shop: "محل تجاري", office: "مكتب إداري", warehouse: "مخزن",
  })[type] || "";
}

function rentConditionFromText(message) {
  const text = normalizeMarketText(message);
  if (/غير\s*مفروش|فاضي|بدون\s*فرش|قانون\s*جديد/.test(text)) return "unfurnished";
  if (/مفروش|مفروشه/.test(text)) return "furnished";
  return "unknown";
}

function valuationCta(intent, context = {}) {
  const type = context.propertyType ? normalizeMarketPropertyType(context.propertyType) : null;
  const transaction = normalizeMarketTransaction(context.areaType || context.transaction);
  const size = parseNum(context.size ?? context.area);
  return {
    intent: intent === "seller" ? "seller" : "valuation",
    area: String(context.areaName || context.marketArea || "").trim().slice(0, 80) || null,
    size: size >= 20 && size <= 100000 ? size : null,
    propertyType: type ? propertyTypeLabel(type) || null : null,
    areaType: transaction || null,
    rentCondition: context.rentCondition || null,
  };
}

async function marketContextForMessage(env, message, formState = {}) {
  const data = formState?.data || {};
  let areaNames = [];
  try { areaNames = await listMarketAreas(env?.DB); } catch {}

  const areaFromMessage = findAreaMention(message, areaNames);
  const areaFromState = findAreaMention(
    [data.marketArea, data.landmark, data.location].filter(Boolean).join(" "),
    areaNames
  );
  const area = areaFromMessage || areaFromState;
  const propertyType = normalizeMarketPropertyType(message)
    || normalizeMarketPropertyType(data.propertyType)
    || null;
  const transaction = normalizeMarketTransaction(message)
    || normalizeMarketTransaction(formState?.type)
    || "sale"; // sale is the display default; rent snapshots are queried only when rent is stated
  const rentCondition = transaction === "rent"
    ? rentConditionFromText(message) || normalizeRentCondition(data.furnished) || "unknown"
    : null;
  const size = extractPropertySize(message) || parseNum(data.area);

  if (!area) {
    return { area: null, areaNames, propertyType, transaction, rentCondition, size, snapshot: { ok: false, reason: "area_required" } };
  }
  if (!propertyType || !transaction) {
    return {
      area, areaNames, propertyType, transaction, rentCondition, size,
      snapshot: { ok: false, reason: "market_context_required" },
    };
  }

  const snapshot = await getMarketSnapshot(env?.DB, {
    area,
    areaType: transaction,
    propertyType,
    rentCondition,
  });
  return { area, areaNames, propertyType, transaction, rentCondition, size, snapshot };
}

function formatMarketQuote(snapshot, size = 0) {
  const totals = size >= 20 ? calculateMarketTotals(snapshot, size) : null;
  const typeLabel = propertyTypeLabel(snapshot.property_type) || "العقار";
  const operationLabel = snapshot.transaction === "rent" ? "للإيجار" : "للبيع";
  const conditionLabel = snapshot.rent_condition === "furnished" ? "مفروش"
    : snapshot.rent_condition === "unfurnished" ? "غير مفروش" : "حالة الفرش غير محددة";
  const confidenceLabel = snapshot.confidence === "high" ? "عالية"
    : snapshot.confidence === "medium" ? "متوسطة"
      : snapshot.confidence === "low" ? "منخفضة" : "غير محددة";

  const lines = [
    `📊 مؤشر السوق المتاح: ${typeLabel} ${operationLabel}${snapshot.transaction === "rent" ? ` (${conditionLabel})` : ""}`,
    `📍 المنطقة: ${snapshot.area_found}`,
    `📏 سعر المتر في بيانات D1: ${fmtNum(snapshot.price_per_meter)} ج.م/م²${snapshot.transaction === "rent" ? " شهريًا" : ""}`,
  ];
  const hasMeterRange = Number.isFinite(snapshot.min_price_m2) && Number.isFinite(snapshot.max_price_m2)
    && snapshot.min_price_m2 > 0 && snapshot.max_price_m2 >= snapshot.min_price_m2;
  lines.push(hasMeterRange
    ? `↕️ نطاق سعر المتر المسجل: ${fmtNum(snapshot.min_price_m2)}–${fmtNum(snapshot.max_price_m2)} ج.م/م²${snapshot.transaction === "rent" ? " شهريًا" : ""}`
    : "↕️ نطاق سعر المتر غير متاح في السجل");
  if (totals) {
    const timeUnit = snapshot.transaction === "rent" ? " / شهريًا" : "";
    const rangeText = totals.range.low !== null && totals.range.high !== null
      ? ` (النطاق المسجل: ${fmtNum(totals.range.low)}–${fmtNum(totals.range.high)} ج.م${timeUnit})`
      : " (نطاق السعر غير متاح في السجل)";
    lines.push(`📐 لمساحة ${fmtNum(size)} م²: مؤشر حسابي ${fmtNum(totals.estimate)} ج.م${timeUnit}${rangeText}`);
  }
  if (snapshot.sample_count !== null && snapshot.sample_count !== undefined) lines.push(`🔎 عدد العينات: ${fmtNum(snapshot.sample_count)}`);
  else lines.push("🔎 عدد العينات: غير متاح في السجل");
  if (snapshot.period) lines.push(`🗓️ الفترة: ${snapshot.period}`);
  else if (snapshot.updated_at) lines.push(`🗓️ آخر تحديث مسجل: ${snapshot.updated_at}`);
  else lines.push("🗓️ الفترة: غير محددة في السجل");
  const priceBasis = snapshot.price_basis === "median_price_m2" ? "الوسيط المسجل (median_price_m2)" : "المتوسط المسجل (avg_price_m2)";
  lines.push(`📚 أساس سعر المتر: ${priceBasis}`);
  lines.push(`🎯 الثقة: ${confidenceLabel}`, `المصدر: ${snapshot.data_source || "price_snapshots"}`);
  lines.push("تنبيه: هذا مؤشر من بيانات أسعار الطلب المتاحة، وليس سعر إتمام بيع أو إيجار مؤكدًا.");
  return lines.join("\n");
}

function marketQuestionReply(context) {
  const result = context.snapshot;
  if (result.ok) return formatMarketQuote(result, context.size);
  if (result.reason === "area_required") {
    return "أقدر أراجع مؤشر السوق من البيانات المتاحة، بس محتاج أعرف المنطقة بالاسم أولًا. لو بتسأل عن قيمة عقارك، ابعت المنطقة والمساحة، أو استخدم زر التقييم.";
  }
  if (result.reason === "market_context_required") {
    const missing = [];
    if (!context.propertyType) missing.push("نوع العقار");
    if (!context.transaction) missing.push("العملية (بيع أم إيجار)");
    return `عشان ما أستخدمش بيانات غير مطابقة، حدّد ${missing.join(" و")} في ${context.area}؛ بعدها أراجع الـD1 من غير تخمين.`;
  }
  if (result.reason === "unsupported_type") {
    return "بيانات السوق المتاحة لا تغطي هذا النوع أو العملية حاليًا؛ مش هستخدم متوسط نوع عقار تاني كبديل. أقدر أساعدك بتقييم يدوي من خلال الأداة عند توفر بيانات مناسبة.";
  }
  if (result.reason === "market_unavailable") {
    return "بيانات السوق مش متاحة مؤقتًا، ومش هخمن رقم. تقدر تكمل المحادثة أو تجرّب أداة التقييم بعد شوية.";
  }
  return "لا توجد بيانات سوقية كافية لهذا النوع والمنطقة في السجل الحالي، لذلك مش هخمن سعرًا.";
}

function listingMatchesArea(property, areaName) {
  if (!areaName) return true;
  const location = [property?.zone, property?.location].filter(Boolean).join(" ");
  return Boolean(findAreaMention(location, [areaName]));
}

function currentListingMatches(property, context) {
  const tx = normalizeMarketTransaction(property?.transaction || property?.category || property?.title);
  if (tx !== context.transaction) return false;
  const propertyType = normalizeMarketPropertyType(`${property?.propertyType || property?.type || property?.category || ""} ${property?.title || ""}`);
  if (propertyType !== context.propertyType) return false;
  return listingMatchesArea(property, context.area);
}

async function findCurrentListings(context) {
  try {
    const feed = await fetchFeed();
    return (feed.properties || [])
      .filter(property => currentListingMatches(property, context))
      .map(property => ({
        property,
        size: parseNum(property.areaNumeric || property.area),
      }))
      .sort((left, right) => {
        const leftDistance = left.size ? Math.abs(left.size - context.size) : Number.MAX_SAFE_INTEGER;
        const rightDistance = right.size ? Math.abs(right.size - context.size) : Number.MAX_SAFE_INTEGER;
        return leftDistance - rightDistance;
      })
      .slice(0, 3)
      .map(item => item.property);
  } catch {
    return null;
  }
}

function formatCurrentListings(properties) {
  if (properties === null) return "\n\n🏠 تعذر تحميل قائمة العقارات المنشورة الآن؛ بيانات السوق أعلاه مستقلة عن ذلك.";
  if (!properties.length) return "\n\n🏠 لا توجد عقارات منشورة مطابقة في المصدر الحالي لهذه المنطقة والنوع.";
  const lines = ["", "🏠 عقارات منشورة من المصدر الحالي:"];
  for (const property of properties) {
    const price = parseNum(property.priceNumeric || property.price);
    lines.push(`• ${property.title || "عقار معروض"}`);
    if (property.zone || property.location) lines.push(`  📍 ${property.zone || property.location}`);
    if (price > 0) lines.push(`  💰 السعر المعروض: ${fmtNum(price)} ج.م`);
    if (property.url) lines.push(`  🔗 ${property.url}`);
  }
  return lines.join("\n");
}

async function answerMarketQuestion(env, message, formState = {}) {
  const context = await marketContextForMessage(env, message, formState);
  let response = marketQuestionReply(context);
  if (isListingSearchIntent(message)) {
    const listings = await findCurrentListings(context);
    response += formatCurrentListings(listings);
  }
  const sellerContext = isOwnerSaleIntent(message)
    || (formState?.active && String(formState?.flowType || "").startsWith("owner") && normalizeMarketTransaction(formState.type) === "sale");
  const cta = isValuationIntent(message)
    ? valuationCta(sellerContext ? "seller" : "valuation", {
      areaName: context.area,
      size: context.size,
      propertyType: propertyTypeLabel(context.propertyType),
      areaType: context.transaction,
      rentCondition: context.rentCondition,
    })
    : null;
  return { response, valuationCta: cta, marketContext: context };
}

async function controlsForExistingFlow(formState) {
  const flowType = String(formState?.flowType || "");
  if (!formState?.active || !flowType || flowType === "route_selection") return { options: ROUTE_BTNS };

  if (flowType === "owner") {
    const steps = getOwnerSteps(formState.type);
    const step = steps[formState.stepIndex];
    const lms = await fetchLandmarks({ transaction: formState.type });
    const prompt = askOwnerStep(steps, formState.stepIndex, formState, null, lms);
    return { options: prompt.options, ui: prompt.ui, uiRequired: prompt.uiRequired };
  }
  if (flowType === "buyer" || flowType === "tenant") {
    const steps = getBuyerSteps(formState.type);
    const lms = await fetchLandmarks({ transaction: formState.type, propertyType: formState.data?.propertyType });
    const prompt = askBuyerStep(steps, formState.stepIndex, formState, null, lms);
    return { options: prompt.options, ui: prompt.ui, uiRequired: prompt.uiRequired };
  }
  if (flowType === "buyer_select") {
    return { options: [...(formState.suggestedProperties || []).map((_, index) => String(index + 1)), BTN.CUSTOM_SPEC, BTN.BACK] };
  }
  if (flowType === "buyer_selected_property") return { options: POST_SELECTED };
  if (flowType.startsWith("owner_completed") || flowType === "buyer_completed") return { options: POST_COMPLETE };
  return { options: ROUTE_BTNS };
}

// ═══ GOOGLE AUTHORITY BUILDERS ═══
function buildGoogleAuthorityMsg() {
  return `🏆 *طارق طنطاوي* — ${GOOGLE_PROFILE.badge}

📊 *الأرقام الرسمية على Google Maps:*
• 👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة
• 📸 ${GOOGLE_PROFILE.photosCount} صورة
• ⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة + ${GOOGLE_PROFILE.ratingsCount} تقييم
• 🎯 ${GOOGLE_PROFILE.points.toLocaleString("en-US")} / ${GOOGLE_PROFILE.maxPoints.toLocaleString("en-US")} نقطة

📍 ${GOOGLE_PROFILE.description}
🗺️ شوف بروفايلي: ${GOOGLE_PROFILE.url}`;
}

function buildGoogleAuthorityShort() {
  return `🏆 ${GOOGLE_PROFILE.badge}
👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps
⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة
🗺️ ${GOOGLE_PROFILE.url}`;
}

function buildTrustBar() {
  return `━━━━━━━━━━━━━━━━━━━
🏆 Google Local Guide Level 7
⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة | 👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة
━━━━━━━━━━━━━━━━━━━`;
}

// ═══ REQUEST LABEL ═══
function getRequestLabel(type, propertyType, furnished, isOwner = false) {
  const isRent = type === "rent" || type === "owner_rent" || type === "tenant" || type === "buyer_rent";
  const pt = propertyType || "عقار";
  
  let emoji = "📋";
  if (isRent && pt === "شقة" && furnished === "مفروش") emoji = "🛏️";
  else if (isRent && pt === "شقة" && (furnished === "فاضي (قانون جديد)" || furnished === "فاضي")) emoji = "🏚️";
  else {
    const emojiMap = {
      "شقة": "🏠", "فيلا": "🏡", "دوبلكس": "🏡", "روف": "🌅",
      "محل تجاري": "🏪", "مكتب إداري": "🏢", "مخزن": "🏭"
    };
    emoji = emojiMap[pt] || (isRent ? "🔑" : "🏠");
  }

  const action = isOwner ? (isRent ? "تأجير" : "بيع") : (isRent ? "إيجار" : "شراء");
  const prefix = isOwner ? "عرض" : "طلب";

  if (isRent && (pt === "شقة" || pt === "فيلا" || pt === "دوبلكس" || pt === "روف")) {
    if (furnished === "مفروش") return `${emoji} ${prefix} ${action} ${pt} مفروش`;
    if (furnished === "فاضي (قانون جديد)" || furnished === "فاضي") return `${emoji} ${prefix} ${action} ${pt} فاضي (قانون جديد)`;
  }

  return `${emoji} ${prefix} ${action} ${pt}`;
}

// ═══ LANDMARK MATCHING ═══
// مسافة ليفنشتاين — نفس النتيجة بالظبط، بس بصفّين بدل مصفوفة كاملة
// الذاكرة بقت O(n) بدل O(n×m): فرق كبير لما نقارن النص بكل المناطق
function levenshtein(a, b) {
  if (!a || !b) return Math.max(a?.length || 0, b?.length || 0);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Uint16Array(n + 1);
  let cur  = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a[i-1];
    for (let j = 1; j <= n; j++) {
      cur[j] = ca === b[j-1] ? prev[j-1] : 1 + Math.min(prev[j], cur[j-1], prev[j-1]);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function similarity(a, b) {
  const na = normAr(a), nb = normAr(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - (dist / maxLen) : 0;
}

function matchLandmark(text, pool) {
  const t = normAr(text);
  if (!t || t.length < 2) return null;
  for (const lm of pool) if (normAr(lm) === t) return lm;
  const sorted = [...pool].sort((a,b) => normAr(b).length - normAr(a).length);
  for (const lm of sorted) {
    const n = normAr(lm);
    if (n?.length >= 3 && t.includes(n)) return lm;
  }
  let best = null, bestScore = 0;
  for (const lm of pool) {
    const score = similarity(text, lm);
    if (score > bestScore && score >= 0.75) { bestScore = score; best = lm; }
  }
  if (best) return best;
  for (const lm of sorted) {
    const n = normAr(lm);
    if (n?.length >= 4 && n.includes(t) && t.length >= 3) return lm;
  }
  return null;
}

// ═══ GEOGRAPHY ═══
const OUT_OF_COVERAGE = ["التجمع","القاهرة الجديدة","الشروق","مدينتي","الرحاب","مصر الجديدة","هليوبوليس","المعادي","حلوان","المقطم","الهرم","فيصل","أكتوبر","الشيخ زايد","العاصمة الإدارية"];
const NASR_TERMS = ["مدينة نصر","مدينه نصر","عباس العقاد","مكرم عبيد","مصطفى النحاس","الطيران","حسن المأمون","حسنين هيكل","يوسف عباس","الحي السادس","الحي السابع","الحي الثامن","الحي العاشر","المنطقة السادسة","المنطقة السابعة","المنطقة الثامنة","المنطقة التاسعة","المنطقة العاشرة","زهراء مدينة نصر","الوفاء والأمل","الواحة","عزبة الهجانة"];
const isNasr = text => NASR_TERMS.some(x=>normAr(text).includes(normAr(x)));
const isOutOfArea = text => { if (isNasr(text)) return false; return OUT_OF_COVERAGE.some(x=>normAr(text).includes(normAr(x))); };

// ═══ CANNED ANSWERS ═══
const INTERRUPTS = [
  { re: /عمول|السعي|نسبتكم|هتاخد كام|مصاريف|سمسرة/i, ans: "العمولة 2.5% من قيمة البيع — بتتحدد بعد المعاينة والتقييم." },
  { re: /^اسمك ايه|حضرتك اسمك|^انت مين|مين حضرتك/i, ans: IDENTITY_RESPONSE },
  { re: /بتشتغلوا ازاي|طريقة العمل/i, ans: "معاينة، تقييم، تصوير، تسويق — وبعدين أوصلك العميل الجاد." },
  { re: /ضمان|هتنصب|بتاخدوا مقدم/i, ans: "شغلنا بالعقد الواضح. مفيش فلوس بتتحرك قبل الاتفاق." },
  { re: /المواعيد|بتفتحوا امتى|بتقفلوا امتى|ساعات العمل/i, ans: `مواعيد العمل: ${OFFICE_HOURS}` },
  { re: /بتشتغلوا في التجمع|القاهرة الجديدة|مدينتي|الرحاب/i, ans: "إحنا بنشتغل في مدينة نصر بس يا فندم." },
  { re: /في رسوم|بتاخدوا فلوس/i, ans: "مفيش رسوم مبدئية. العمولة بس بعد إتمام البيع/الإيجار." },
];

const GOOGLE_AUTHORITY_INTERRUPTS = [
  // ملاحظة: أسئلة الهوية ("مين انت"/"انت مين"/"مين حضرتك") بتتحسم بـ IDENTITY_RESPONSE
  // قبل المقارنة دي (توحيد الهوية) — هنا بس أسئلة الثقة والمصداقية.
  { re: /ضمان|مصداقية|بتعرف تشتغل|ليه اثق|معرفتك|خبرتك/i, ans: () => buildGoogleAuthorityShort() },
  { re: /جوجل ماب|google maps|الخرايط|الخريطة|تقييمات|رأى الناس/i, ans: () => buildGoogleAuthorityMsg() },
  { re: /كام تقييم|كام مراجعة|كام صورة|كام مشاهدة/i, ans: () => buildGoogleAuthorityMsg() },
];

// ═══ كشف أسئلة الهوية وطلب الإنسان (P0.1) ═══
// رد حتمي: أي سؤال عن ماهوية المتحدث أو طلب تكلم مع إنسان حقيقي
// لازم يترد عليه بـ IDENTITY_RESPONSE من غير ما نستدعي Gemini خالص —
// عشان الوكيل مايقدرش ينفي بشريته ولا ينتحل شخصية طارق في أي لحظة.
const IDENTITY_Q_PATTERNS = [
  // بوت / روبوت / ذكاء اصطناعي / GPT
  /بوت|روبوت|شات\s*جي\s*بي\s*تي|جي\s*بي\s*تي|chat\s*gpt|\bgpt\b|openai|\b(bot|robot)\b|artificial|ذكاء\s*اصطناعي|a\.?i\.?\b/i,
  // ادعاء/سؤال إن المتحدث إنسان مقابل الآلة
  /انسان|إنسان|بني\s*آدم|بني\s*ادم|شخص\s*حقيقي|حد\s*حقيقي|شخص\s*بشري|حد\s*بشري|رد\s*بشري|human|real\s*person|are\s*you\s*(real|human)|not\s*a\s*(bot|machine)/i,
  // هوية المتحدث: مين انت / اسمك ايه / انت طارق؟
  /مين\s*انت|انت\s*مين|حضرتك\s*مين|مين\s*حضرتك|انت\s*طارق|حضرتك\s*طارق|معاك\s*طارق|ده\s*طارق|اسمك\s*(ايه|إيه)|who\s*are\s*you|are\s*you\s*tarek/i,
  // طلب تكلم مع إنسان حقيقي / طارق مباشرة
  /(عايز|محتاج|ممكن|ابغى|احب|ياريت)\s*(اتكلم|اكلم|كلموني|كلملي|كلم|مكالمة|اتصل|يتصل|قابل|اشوف)\s*(مع\s*)?(حد|شخص|واحد|موظف|مدير|مسؤول|طارق|الاستاذ\s*طارق|مين)/i,
  /(حد|شخص|موظف|مدير|مسؤول|طارق)\s*(يتواصل|يتكلم|يتصل|يكلمني|يجيلي|يجي)\s*(معايا|معي|ليا|اياي)?/i,
  /(كلمني|كلموني|كلملي|وصلني|وصلوني|ابعتلي|اعرضني|عرضني)\s*((على|[لب])\s*)?(حد|شخص|موظف|مدير|مسؤول|طارق)/i,
  /(فين|وين)\s*طارق|طارق\s*(فين|وين|موجود|بيرد|على\s*الخط|متاح)/i,
  /(اللي\s*)?(بيرد|بترد|بيكتب|بتكتب|على\s*الخط)\s*(ده|دي)?\s*مين|مين\s*(اللي\s*)?(بيرد|بترد|بيكتب|بتكتب|على\s*الخط)/i,
  /مين\s*صاحب|صاحب\s*(الموقع|الصفحة|الحساب|الشركة|المكتب)/i,
  /(talk|speak|call|chat)\s*(to|with)\s*(a\s*)?(human|person|real\s*person|someone\s*real|tarek|manager)/i,
];
// صيغ مسحوبة من المسافات — بتتحط على النص بعد normAr عشان نمسك "انت مين" حتى لو كتبها العميل متداخلة
const IDENTITY_NORM_SUBSTR = [
  "مينانت","انتمين","حضرتكمين","مينحضرتك","انتطارق","حضرتكتارق","معاكطارق","دهطارق",
  "اسمكايها","اسمكايه","حدحقيقي","شخصحقيقي","عايزحد","ممكنحد","اتكلمحد","كلموني","مينالليبرد",
  "الليبيرد","الليبترد","الليبيكتب","مينصاحب",
];

function isIdentityQ(msg) {
  const t = String(msg||"").trim();
  if (!t) return false;
  if (IDENTITY_Q_PATTERNS.some(re => re.test(t))) return true;
  const n = normAr(t);
  return IDENTITY_NORM_SUBSTR.some(s => n.includes(s));
}

function matchInterrupt(msg) {
  for (const r of GOOGLE_AUTHORITY_INTERRUPTS) {
    if (r.re.test(String(msg||""))) return typeof r.ans === "function" ? r.ans() : r.ans;
  }
  for (const r of INTERRUPTS) if (r.re.test(String(msg||""))) return r.ans;
  return null;
}

function isOfficeQ(text) {
  const t = normAr(text);
  return ["هو مكتبكم فين","هو المكتب فين","مكتبكم فين","المكتب فين","فين المكتب","فين مكتبكم","عنوان المكتب ايه","عنوانكم ايه","عنوانكم فين","العنوان ايه","العنوان فين","عنوانك ايه"].some(p => normAr(p)===t);
}

// ملاحظة حالة المكتب دلوقتي — بتتحط قبل رسالة العنوان
// الفايدة: العميل اللي بيسأل 11 بالليل يعرف إن المكتب قافل من غير ما يروح
function officeStatusNote(now = cairoNow()) {
  const { hour, isFriday } = now;
  if (isFriday) return "النهاردة الجمعة والمكتب إجازة.";
  if (hour >= 21 || hour < 12) return "المكتب قافل دلوقتي، بيفتح 12 الضهر.";
  return "";
}

const officeMsg = () => {
  const note = officeStatusNote();
  return `${note ? note + "\n\n" : ""}📌 عنوان المكتب: ${OFFICE_ADDRESS}\n\n🗺️ اللوكيشن: ${OFFICE_MAP_URL}\n\n⏰ المواعيد: ${OFFICE_HOURS}\n\n📝 الأفضل تكلمنا على الواتساب قبل ما تجي.`;
};

// ═══ BUTTON MATCHERS ═══
const isSkip       = m => isBtn(m,BTN.SKIP)||/^(تخطي|skip|بعدين|مش دلوقتي|مفيش)$/i.test(String(m).trim());
const isCancel     = m => isBtn(m,BTN.CANCEL)||/^(إلغاء|الغاء|cancel)$/i.test(String(m).trim());
const isSendNow    = m => isBtn(m,BTN.SEND);
const isBack       = m => isBtn(m,BTN.BACK);
const isBackFirst  = m => isBtn(m,BTN.FIRST_LIST);
const isMore       = m => isBtn(m,BTN.MORE)||/المزيد|more|\+/.test(String(m||""));
const isAnyArea    = m => isBtn(m,BTN.ANY_AREA)||/أي منطقة|اى منطقه|كل مدينة نصر/i.test(String(m||""));
const isAttachImg  = m => isBtn(m,BTN.ATTACH_IMG)||isBtn(m,BTN.ADD_IMG);
const isDelImg     = m => isBtn(m,BTN.DEL_IMG);
const isImgDone    = m => isBtn(m,BTN.IMG_DONE);
const isSkipImg    = m => isBtn(m,BTN.SKIP_IMG);
const isSendWA     = m => isBtn(m,BTN.SEND_WA);
const isPreview    = m => isBtn(m,BTN.PREVIEW);
const isEdit       = m => isBtn(m,BTN.EDIT);
const isNewReq     = m => isBtn(m,BTN.NEW_REQ);
const isBookView   = m => isBtn(m,BTN.BOOK_VIEW);
const isBackList   = m => isBtn(m,BTN.BACK_LIST);
const isOtherProp  = m => isBtn(m,BTN.OTHER_PROP);
const isBuy        = m => isBtn(m,BTN.BUY);
const isTenant     = m => isBtn(m,BTN.TENANT);
const isSell       = m => isBtn(m,BTN.SELL);
const isLandlord   = m => isBtn(m,BTN.LANDLORD);
const isCustomSpec = m => isBtn(m,BTN.CUSTOM_SPEC)||/مش عاجبني|ولا واحد|مفيش حاجة مناسبة|ابعت طلبي/i.test(String(m||""));
const isAccept     = m => isBtn(m,BTN.ACCEPT);

// ═══ CACHE ═══
let feedCache = { at:0, data:null };
const lmCache = new Map();
const geminiCache = new Map();

// إضافة لأي Map مع سقف للحجم — يمنع تسريب الذاكرة داخل الـ isolate الطويل العمر
function cacheSet(map, key, value) {
  if (map.size >= CACHE_MAX_KEYS) {
    // امسح أقدم مفتاح (Map بتحافظ على ترتيب الإدخال)
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// fetch بمهلة زمنية — أي طلب خارجي بطيء بيتقطع بدل ما يعلّق الـ Worker
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// تحميل ملف العقارات مع كاش + مهلة + تحقق من الشكل
// ملاحظة: بنرجّع آخر نسخة ناجحة (stale) لو التحميل فشل، عشان الشات ميقفش
async function fetchFeed() {
  const now = Date.now();
  if (feedCache.data && (now-feedCache.at)<CACHE_TTL_MS) return feedCache.data;
  try {
    const r = await fetchWithTimeout(AI_FEED_URL, { headers:{"Accept":"application/json"} }, FETCH_TIMEOUT_FEED);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    // تحقق دفاعي: لو الملف اتغيّر شكله، منكسرش الفلترة
    const safe = (d && typeof d === "object") ? d : { properties: [] };
    if (!Array.isArray(safe.properties)) safe.properties = [];
    feedCache = { at:now, data:safe };
    return safe;
  } catch (err) {
    if (feedCache.data) {
      console.warn("[feed] fallback to stale cache:", err?.message);
      return feedCache.data; // نسخة قديمة أحسن من انهيار الطلب
    }
    throw err;
  }
}

async function fetchLandmarks(filters) {
  const now = Date.now();
  const key = filters ? JSON.stringify(filters) : "__all__";
  const cached = lmCache.get(key);
  if (cached && (now-cached.at)<LANDMARKS_TTL_MS) return cached.data;
  try {
    const feed = await fetchFeed();
    let props = feed.properties || [];
    if (filters) {
      props = props.filter(p => {
        if (!p) return false;
        if (filters.transaction && p.transaction!==filters.transaction) return false;
        if (filters.propertyType && normalizePropType(p.propertyType)!==normalizePropType(filters.propertyType)) return false;
        return true;
      });
    }
    const set = new Set();
    for (const p of props) {
      const txt = String(p.zone||p.location||"");
      for (const lm of MASTER_LANDMARKS) if (txt.includes(lm)) set.add(lm);
    }
    if (set.size < 3) {
      for (const p of props) {
        const loc = String(p.location||"");
        const part = loc.split(/[-،,(]/)[0].trim();
        if (part?.length>=3 && part.length<=30 && !MASTER_LANDMARKS.some(l=>part.includes(l)||l.includes(part))) {
          set.add(part);
        }
      }
    }
    const lms = [...set].sort((a,b)=>a.localeCompare(b,"ar"));
    cacheSet(lmCache, key, { at:now, data:lms });
    return lms;
  } catch (err) {
    // فشل تحميل المناطق مش سبب لكسر المحادثة — بنرجع قائمة فاضية والواجهة بتستخدم MASTER_LANDMARKS
    console.warn("[landmarks] fallback:", err?.message);
    cacheSet(lmCache, key, { at:now, data:[] });
    return [];
  }
}

// ═══ STEP DEFINITIONS ═══
function getOwnerSteps(type) {
  const isSale = type==="sale";
  return [
    { id:"propertyType", type:"buttons", q:"العقار شقة ولا فيلا ولا دوبلكس ولا محل ولا مكتب ولا مخزن ولا روف؟", opts:["شقة","فيلا","دوبلكس","محل تجاري","مكتب إداري","مخزن","روف"] },
    { id:"location", type:"text", q:"العقار فين بالضبط؟ اكتب الشارع والمنطقة.", err:"اكتب العنوان بالتفصيل." },
    { id:"area", type:"number", q:"المساحة كام متر؟", err:"اكتب المساحة بالمتر." },
    { id:"price", type:"number", q: isSale?"السعر المطلوب كام؟":"الإيجار الشهري كام؟", err:"اكتب السعر رقم." },
    { id:"rooms", type:"buttons", q:"عدد الغرف كام؟", opts:["1","2","3","4","5+"], when: d=>isResidential(d.propertyType) && !isVilla(d.propertyType) },
    { id:"baths", type:"buttons", q:"عدد الحمامات كام؟", opts:["1","2","3+"], when: d=>isResidential(d.propertyType) },
    { id:"floor", type:"buttons", q:"الدور الكام؟", opts:SUBTYPE_OPTIONS["شقة"], when: d=>d.propertyType==="شقة" },
    { id:"villaType", type:"buttons", q:"نوع الفيلا إيه؟", opts:SUBTYPE_OPTIONS["فيلا"], when: d=>isVilla(d.propertyType) },
    { id:"duplexType", type:"buttons", q:"نوع الدوبلكس إيه؟", opts:SUBTYPE_OPTIONS["دوبلكس"], when: d=>isDuplex(d.propertyType) },
    { id:"roofType", type:"buttons", q:"طبيعة الروف إيه؟", opts:SUBTYPE_OPTIONS["روف"], when: d=>d.propertyType==="روف" },
    { id:"shopType", type:"buttons", q:"موقع المحل إيه؟", opts:SUBTYPE_OPTIONS["محل تجاري"], when: d=>isShop(d.propertyType) },
    { id:"officeType", type:"buttons", q:"تصنيف المكتب إيه؟", opts:SUBTYPE_OPTIONS["مكتب إداري"], when: d=>isOffice(d.propertyType) },
    { id:"storageType", type:"buttons", q:"موقع وطبيعة المخزن إيه؟", opts:SUBTYPE_OPTIONS["مخزن"], when: d=>isWarehouse(d.propertyType) },
    { id:"finishing", type:"buttons", q:"التشطيب إيه؟", opts:["ألترا سوبر لوكس","سوبر لوكس","نصف تشطيب","طوب أحمر"], when: d=>isResidential(d.propertyType) },
    { id:"furnished", type:"buttons", q:"الإيجار مفروش ولا فاضي (قانون جديد)؟", opts:["مفروش","فاضي (قانون جديد)"], when: d=>!isSale&&isResidential(d.propertyType) },
    { id:"duration", type:"text", q:"مدة العقد المطلوبة كام؟", when: d=>!isSale&&d.furnished==="فاضي (قانون جديد)" },
    { id:"rentPeriods", type:"buttons", q:"المدة المطلوبة إيه؟", opts:["أسبوعي","شهري","سنوي"], when: d=>!isSale&&d.furnished==="مفروش" },
    { id:"priceWeekly", type:"number", q:"الإيجار الأسبوعي كام؟", when: d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="أسبوعي" },
    { id:"priceMonthly", type:"number", q:"الإيجار الشهري كام؟", when: d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="شهري" },
    { id:"priceYearly", type:"number", q:"الإيجار السنوي كام؟", when: d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="سنوي" },
    { id:"furnitureQuality", type:"buttons", q:"مستوى الأثاث إيه؟", opts:["فاخر","جيد جداً","جيد","اقتصادي"], when: d=>!isSale&&d.furnished==="مفروش" },
    { id:"businessType", type:"text", q:"النشاط الحالي إيه؟", when: d=>isShop(d.propertyType)||isOffice(d.propertyType) },
    { id:"frontage", type:"buttons", q:"المحل على ناصية ولا واجهة واحدة؟", opts:["ناصية","واجهة واحدة"], when: d=>isShop(d.propertyType) },
    { id:"officesCount", type:"buttons", q:"عدد المكاتب كام؟", opts:["1","2","3","4","5+"], when: d=>isOffice(d.propertyType) },
    { id:"warehouseType", type:"text", q:"المخزن مناسب لتخزين إيه؟", when: d=>isWarehouse(d.propertyType) },
    { id:"notes", type:"text", q:"في أي تفاصيل مهمة تانية؟ ولو مفيش اكتب لا." },
    { id:"ownerName", type:"text", q:"اسم حضرتك إيه؟" },
    { id:"ownerPhone", type:"phone", q:"رقم الموبايل اللي طارق يتواصل عليه؟", err:"اكتب رقم موبايل مصري 11 رقم يبدأ بـ01." },
    { id:"images", type:"images_step", q:`لو عندك صور، تقدر ترفقها دلوقتي (لحد ${MAX_IMAGES}).` },
  ];
}

function getBuyerSteps(type) {
  const isSale = type==="sale";
  return [
    { id:"propertyType", type:"buttons", q:"عايز شقة ولا فيلا ولا دوبلكس ولا محل ولا مكتب ولا مخزن ولا روف؟", opts:["شقة","فيلا","دوبلكس","محل تجاري","مكتب إداري","مخزن","روف"] },
    { id:"landmark", type:"dynamic_buttons", q:"عايز العقار في أنهي منطقة؟" },
    { id:"budget", type:"number", q: isSale?"ميزانيتك لحد كام؟":"ميزانيتك الشهرية لحد كام؟" },
    { id:"villaType", type:"buttons", q:"بتفضل نوع الفيلا إيه؟", opts:SUBTYPE_OPTIONS["فيلا"], when: d=>isVilla(d.propertyType) },
    { id:"duplexType", type:"buttons", q:"بتفضل نوع الدوبلكس إيه؟", opts:SUBTYPE_OPTIONS["دوبلكس"], when: d=>isDuplex(d.propertyType) },
    { id:"shopType", type:"buttons", q:"بتفضل موقع المحل إيه؟", opts:SUBTYPE_OPTIONS["محل تجاري"], when: d=>isShop(d.propertyType) },
    { id:"officeType", type:"buttons", q:"بتفضل نوع المكتب إيه؟", opts:SUBTYPE_OPTIONS["مكتب إداري"], when: d=>isOffice(d.propertyType) },
    { id:"storageType", type:"buttons", q:"بتفضل المخزن يكون إيه؟", opts:SUBTYPE_OPTIONS["مخزن"], when: d=>isWarehouse(d.propertyType) },
    { id:"rooms", type:"buttons", q:"محتاج كام غرفة؟", opts:["1","2","3","4","5+"], when:d=>isResidential(d.propertyType) && !isVilla(d.propertyType) },
    { id:"baths", type:"buttons", q:"محتاج كام حمام؟", opts:["1","2","3+"], when:d=>isResidential(d.propertyType) },
    { id:"furnished", type:"buttons", q:"عايزه مفروش ولا فاضي؟", opts:["مفروش","فاضي (قانون جديد)"], when:d=>!isSale&&isResidential(d.propertyType) },
    { id:"businessActivity", type:"text", q:"النشاط التجاري/الإداري إيه؟", when:d=>isCommercial(d.propertyType) },
    { id:"buyerName", type:"text", q:"اسم حضرتك إيه عشان طارق يعرف يكلم مين؟", err:"اكتب اسم حضرتك." },
    { id:"buyerPhone", type:"phone", q:"رقم الموبايل اللي طارق يتواصل عليه؟", err:"اكتب رقم موبايل مصري 11 رقم يبدأ بـ01." },
  ];
}

function getSteps(type, flowType) {
  if (!flowType) return getOwnerSteps(type);
  if (["buyer","tenant","buyer_","buyer_completed"].some(x=>flowType===x||flowType.startsWith("buyer_"))) return getBuyerSteps(type);
  return getOwnerSteps(type);
}

// ═══ STEP ENGINE ═══
const REQUIRED_OWNER = ["propertyType","location","price","ownerPhone"];

function stepKey(step) { return step?._key||step?.id||""; }
function isApplicable(step, data) { if (!step) return false; if (typeof step.when !== "function") return true; try { return !!step.when(data||{}); } catch { return false; } }
function isFilled(data, step) { if (!step) return false; const k = stepKey(step); return !!(data?._filled?.[k]) || hasVal(data?.[k]); }
function markFilled(data, step) { if (!data._filled) data._filled = {}; const k = stepKey(step); if (k) data._filled[k] = true; }

function hydrateData(data, steps) {
  const d = data||{};
  if (!d._filled) d._filled = {};
  for (const s of steps||[]) if (isApplicable(s,d) && hasVal(d[stepKey(s)])) d._filled[stepKey(s)] = true;
  return d;
}

function nextStep(steps, data, from=0) {
  const d = hydrateData(data, steps);
  for (let i=Math.max(0,from);i<steps.length;i++) {
    const s = steps[i];
    if (isApplicable(s,d) && !isFilled(d,s)) return i;
  }
  return -1;
}

function countSteps(steps, data) { return (steps||[]).filter(s=>isApplicable(s,data)).length; }

function buildProgress(steps, data, idx) {
  const total = countSteps(steps, data);
  const before = (steps||[]).slice(0,idx).filter(s=>isApplicable(s,data)&&isFilled(data,s)).length;
  const current = Math.min(total, before+1);
  const remaining = Math.max(0, total-before-1);
  const pct = total ? Math.round((before/total)*100) : 0;
  return { current, total, remaining, pct };
}

function withCtrl(opts, data, showBack=true) {
  const o = [...(opts||[])];
  if (showBack) o.push(BTN.BACK);
  o.push(BTN.SKIP);
  if (hasVal(data?.propertyType) && hasVal(data?.location) && hasVal(data?.price)) o.push(BTN.SEND);
  o.push(BTN.CANCEL);
  o.push(BTN.NEW_REQ);
  return [...new Set(o)];
}

// ═══ SCORING ENGINE ═══
function scoreProperty(p, criteria) {
  let score = 30;
  const targetType = normalizePropType(criteria.propertyType);
  const pType = normalizePropType(p.propertyType || p.type || p.category);

  if (targetType) {
    if (targetType === "دوبلكس") {
      if (pType !== "دوبلكس" && pType !== "فيلا") return -999;
      score += 25;
    } else if (targetType === "فيلا") {
      if (pType !== "فيلا" && pType !== "دوبلكس") return -999;
      score += 25;
    } else {
      if (pType !== targetType) return -999;
      score += 30;
    }
  }

  if (criteria.transaction) {
    const pTx = (p.transaction === "rent" || normAr(p.transaction).includes("ايجار")) ? "rent" : "sale";
    if (pTx === criteria.transaction) score += 20;
    else return -999;
  }

  if (criteria.landmark) {
    const txt = String(p.zone||p.location||"");
    const txtNorm = normAr(txt);
    const lmNorm = normAr(criteria.landmark);
    if (txtNorm.includes(lmNorm)) score += 20;
    else if (lmNorm.includes(txtNorm)) score += 10;
    else { const sim = similarity(txt, criteria.landmark); if (sim >= 0.6) score += 5; }
  }

  const budget = parseNum(criteria.budget);
  if (budget > 0) {
    const price = parseNum(p.priceNumeric||p.price);
    if (price > 0) {
      const ratio = price / budget;
      if (ratio <= 0.95) score += 25;
      else if (ratio <= 1.0) score += 20;
      else if (ratio <= 1.1) score += 10;
      else if (ratio <= 1.2) score += 0;
      else if (ratio <= 1.3) score -= 10;
      else score -= 30;
    }
  }

  const rooms = parseNum(criteria.rooms);
  if (rooms > 0) {
    const r = parseNum(p.roomsNumeric||p.rooms);
    if (r === rooms) score += 15;
    else if (r === rooms+1 || r === rooms-1) score += 5;
    else if (r > rooms) score += 3;
    else if (r < rooms) score -= 10;
  }

  const baths = parseNum(criteria.baths);
  if (baths > 0) {
    const b = parseNum(p.bathsNumeric||p.baths);
    if (b === baths) score += 8;
    else if (b > baths) score += 3;
    else if (b < baths) score -= 5;
  }

  if (criteria.furnished) {
    const pf = p.furnished===true?"مفروش":p.furnished===false?"فاضي (قانون جديد)":String(p.furnished||"");
    if (pf && pf === criteria.furnished) score += 10;
    else if (pf && pf !== criteria.furnished) score -= 20;
  }

  return score;
}

function filterAndRank(properties, criteria) {
  if (!Array.isArray(properties)) return [];
  const targetType = normalizePropType(criteria.propertyType);
  const targetTx = criteria.transaction;
  return properties
    .filter(p => {
      if (!p) return false;
      if (targetTx) {
        const pTx = (p.transaction === "rent" || normAr(p.transaction).includes("ايجار")) ? "rent" : "sale";
        if (pTx !== targetTx) return false;
      }
      if (targetType) {
        const pType = normalizePropType(p.propertyType || p.type || p.category);
        if (targetType === "دوبلكس") { if (pType !== "دوبلكس" && pType !== "فيلا") return false; }
        else if (targetType === "فيلا") { if (pType !== "فيلا" && pType !== "دوبلكس") return false; }
        else { if (pType !== targetType) return false; }
      }
      return true;
    })
    .map(p => ({ p, score: scoreProperty(p, criteria) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a,b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.p);
}

// ═══ WA MESSAGE BUILDER ═══
// ═══ GPS (من منتقي الخريطة في agent.html) ═══
// بيتقبل من الواجهة كـ body.gps = { lat, lng, address } — بدون أي تخزين دائم (بيعيش جوه formState بس)
function sanitizeGps(g) {
  if (!g || typeof g !== "object") return null;
  const lat = Number(g.lat), lng = Number(g.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const address = String(g.address||"").replace(/[\u0000-\u001F\u007F<>]/g," ").replace(/\s+/g," ").trim().slice(0,200);
  return { lat: Math.round(lat*1e5)/1e5, lng: Math.round(lng*1e5)/1e5, address };
}
function gpsLines(data) {
  const g = sanitizeGps(data?.gps);
  if (!g) return [];
  const out = [];
  if (g.address && g.address !== String(data.location||"").trim() && g.address !== String(data.landmark||"").trim())
    out.push(`│ 🗺️ العنوان (خريطة): ${g.address}`);
  out.push(`│ 📌 الإحداثيات: ${g.lat}, ${g.lng}`);
  out.push(`│ 🔗 https://maps.google.com/?q=${g.lat},${g.lng}`);
  return out;
}

function buildWAMsg(ctx, data, imgUrls=[]) {
  const isOwner = ctx==="owner_sale"||ctx==="owner_rent";
  const isSale  = ctx==="owner_sale"||ctx==="buyer";
  const isRent  = ctx==="owner_rent"||ctx==="tenant";
  const pt      = data.propertyType||"عقار";

  const requestLabel = getRequestLabel(isRent ? "rent" : "sale", pt, data.furnished, isOwner);

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `*${requestLabel}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `السلام عليكم أ. طارق،`,
    `أنا عميل من موقع "سمسار طلبك".`,
    ``,
    `📋 *المواصفات المطلوبة:*`,
    `┌───────────────────`,
    `│ 🏷️ النوع: ${pt}`
  ];

  if (isOwner) {
    if (hasVal(data.location))  lines.push(`│ 📍 الموقع: ${data.location}`);
    lines.push(...gpsLines(data));
    if (hasVal(data.area))      lines.push(`│ 📐 المساحة: ${fmtVal(data.area)} م²`);

    if (isShop(pt)) {
      if (hasVal(data.shopType))     lines.push(`│ 🏪 الموقع: ${data.shopType}`);
      if (hasVal(data.businessType)) lines.push(`│ 💼 النشاط: ${data.businessType}`);
      if (hasVal(data.frontage))     lines.push(`│ 🚪 الواجهة: ${data.frontage}`);
    }
    if (isOffice(pt)) {
      if (hasVal(data.officeType))   lines.push(`│ 🏢 النوع: ${data.officeType}`);
      if (hasVal(data.businessType)) lines.push(`│ 💼 النشاط: ${data.businessType}`);
      if (hasVal(data.officesCount)) lines.push(`│ 🚪 عدد المكاتب: ${fmtVal(data.officesCount)}`);
    }
    if (isWarehouse(pt)) {
      if (hasVal(data.storageType))   lines.push(`│ 🏭 الموقع: ${data.storageType}`);
      if (hasVal(data.warehouseType)) lines.push(`│ 📦 التخزين: ${data.warehouseType}`);
    }
    if (isVilla(pt) && hasVal(data.villaType)) lines.push(`│ 🏡 النوع: ${data.villaType}`);
    if (isDuplex(pt) && hasVal(data.duplexType)) lines.push(`│ 🏡 نوع الدوبلكس: ${data.duplexType}`);
    if (pt === "روف" && hasVal(data.roofType)) lines.push(`│ 🌅 طبيعة الروف: ${data.roofType}`);

    if (isRent && data.furnished==="مفروش") {
      lines.push(`│ 🛋️ نوع الإيجار: مفروش`);
      if (hasVal(data.rentPeriods))      lines.push(`│ 📅 المدة: ${data.rentPeriods}`);
      if (hasVal(data.furnitureQuality)) lines.push(`│ 🪑 الأثاث: ${data.furnitureQuality}`);
      if (hasVal(data.priceWeekly))      lines.push(`│ 💰 الإيجار الأسبوعي: ${fmtNum(data.priceWeekly)} ج.م`);
      if (hasVal(data.priceMonthly))     lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.priceMonthly)} ج.م`);
      if (hasVal(data.priceYearly))      lines.push(`│ 💰 الإيجار السنوي: ${fmtNum(data.priceYearly)} ج.م`);
      if (!hasVal(data.priceWeekly)&&!hasVal(data.priceMonthly)&&!hasVal(data.priceYearly)&&hasVal(data.price))
        lines.push(`│ 💰 السعر: ${fmtNum(data.price)} ج.م`);
    } else if (isRent && data.furnished==="فاضي (قانون جديد)") {
      lines.push(`│ 🛋️ نوع الإيجار: فاضي (قانون جديد)`);
      if (hasVal(data.duration)) lines.push(`│ 📅 مدة العقد: ${data.duration}`);
      if (hasVal(data.price))    lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.price)} ج.م`);
    } else if (isRent && hasVal(data.price)) {
      lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.price)} ج.م`);
    } else if (isSale && hasVal(data.price)) {
      lines.push(`│ 💰 السعر المطلوب: ${fmtNum(data.price)} ج.م`);
    }

    if (isResidential(pt) && !isVilla(pt)) {
      if (hasVal(data.rooms))     lines.push(`│ 🛏️ الغرف: ${fmtVal(data.rooms)}`);
      if (hasVal(data.baths))     lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    }
    if (isVilla(pt) && hasVal(data.baths)) lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    if (hasVal(data.floor))      lines.push(`│ 🏢 الدور: ${data.floor}`);
    if (hasVal(data.finishing))  lines.push(`│ ✨ التشطيب: ${data.finishing}`);
    if (hasVal(data.notes) && data.notes!=="لا") lines.push(`│ 📝 ملاحظات: ${data.notes}`);
  } else {
    const landmark = data.landmark && data.landmark!=="__ANY__" ? data.landmark : "أي منطقة في مدينة نصر";
    lines.push(`│ 📍 المنطقة: ${landmark}`);
    lines.push(...gpsLines(data));
    const bgt = hasVal(data.budget) ? data.budget : data.price;
    if (hasVal(bgt)) lines.push(`│ 💰 الميزانية: ${fmtNum(bgt)} ج.م`);
    if (isVilla(pt) && hasVal(data.villaType)) lines.push(`│ 🏡 نوع الفيلا: ${data.villaType}`);
    if (isDuplex(pt) && hasVal(data.duplexType)) lines.push(`│ 🏡 نوع الدوبلكس: ${data.duplexType}`);
    if (isShop(pt) && hasVal(data.shopType)) lines.push(`│ 🏪 موقع المحل: ${data.shopType}`);
    if (isOffice(pt) && hasVal(data.officeType)) lines.push(`│ 🏢 نوع المكتب: ${data.officeType}`);
    if (isWarehouse(pt) && hasVal(data.storageType)) lines.push(`│ 🏭 طبيعة المخزن: ${data.storageType}`);
    if (isCommercial(pt) && hasVal(data.businessActivity)) lines.push(`│ 💼 النشاط: ${data.businessActivity}`);
    if (isResidential(pt) && !isVilla(pt) && hasVal(data.rooms)) lines.push(`│ 🛏️ الغرف: ${fmtVal(data.rooms)}`);
    if (isResidential(pt) && hasVal(data.baths)) lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    if (hasVal(data.furnished)) lines.push(`│ 🛋️ حالة الفرش: ${data.furnished}`);
  }
  lines.push(`└───────────────────`);

  if (!isOwner && hasVal(data.selectedProperty)) {
    lines.push("", `🎯 *العقار المختار للمعاينة:*`, `┌───────────────────`);
    lines.push(`│ 📌 ${data.selectedProperty}`);
    if (hasVal(data.selectedLocation))  lines.push(`│ 📍 ${data.selectedLocation}`);
    if (hasVal(data.selectedPrice) && data.selectedPrice!=="0") lines.push(`│ 💰 ${data.selectedPrice} ج.م`);
    if (hasVal(data.selectedArea))      lines.push(`│ 📐 ${data.selectedArea}`);
    if (hasVal(data.selectedRooms))     lines.push(`│ 🛏️ ${data.selectedRooms} غرف`);
    if (hasVal(data.selectedBaths))     lines.push(`│ 🛁 ${data.selectedBaths} حمام`);
    if (hasVal(data.selectedFloor))     lines.push(`│ 🏢 ${data.selectedFloor}`);
    if (hasVal(data.selectedFinishing)) lines.push(`│ ✨ ${data.selectedFinishing}`);
    if (hasVal(data.selectedImage))     lines.push(`│ 📷 ${data.selectedImage}`);
    if (hasVal(data.selectedUrl))       lines.push(`│ 🔗 ${data.selectedUrl}`);
    lines.push(`└───────────────────`);
    lines.push(``, `📩 *عميل مهتم* — جاهز للتواصل`);
  }

  // بيانات العميل
  const hasAnyContact = hasVal(data.ownerName) || hasVal(data.ownerPhone) || hasVal(data.buyerName) || hasVal(data.buyerPhone) || hasVal(data.phone);
  if (hasAnyContact) {
    lines.push("", `👤 *بيانات العميل:*`);
    if (hasVal(data.ownerName))  lines.push(`• الاسم: ${data.ownerName}`);
    if (hasVal(data.ownerPhone)) lines.push(`• الرقم: ${data.ownerPhone}`);
    if (hasVal(data.buyerName))  lines.push(`• الاسم: ${data.buyerName}`);
    if (hasVal(data.buyerPhone)) lines.push(`• الرقم: ${data.buyerPhone}`);
    if (hasVal(data.phone))      lines.push(`• الرقم: ${data.phone}`);
  }

  if (imgUrls?.length) {
    lines.push("", `📷 *الصور المرفقة:* ${imgUrls.length} صورة`);
    imgUrls.forEach((u,i) => lines.push(`${i+1}. ${u}`));
  }

  // التذييل الموحّد — بطاقة طارق أولًا، وتحتها سطر التوقيع كسطر فرعي
  // ملحوظة: التوقيع اندمج جوه نفس الصندوق بدل ما يكون صندوق منفصل،
  // وبقى بخط مائل (_نص_ في واتساب) عشان يبان ثانوي مش عنوان رئيسي.
  lines.push("", `━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏆 *طارق طنطاوي* — ${GOOGLE_PROFILE.badge}`);
  lines.push(`📸 ${GOOGLE_PROFILE.photosCount} صورة | ⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة`);
  lines.push(`👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps`);
  lines.push(`🗺️ ${GOOGLE_PROFILE.url}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`_🤖 تم الإرسال من الوكيل الذكي_`);

  return lines.join("\n");
}

const waURL = (phone, msg) => `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;

// ═══ FORM STATE ═══
const LC = { ACTIVE:"active", DONE:"completed", CANCELLED:"cancelled" };

function sanitizeState(fs) {
  if (!fs?.active) return fs;
  if (fs._version && fs._version!==FORM_VERSION) return { active:false, lifecycle:LC.CANCELLED, type:null, stepIndex:-1, data:{}, awaitingQ:false, flowType:null, imageUrls:[], _version:FORM_VERSION };
  if (fs._savedAt && (Date.now()-fs._savedAt) > 86400000) return { active:false, lifecycle:LC.CANCELLED, type:null, stepIndex:-1, data:{}, awaitingQ:false, flowType:null, imageUrls:[] };
  try {
    const steps = getSteps(fs.type, fs.flowType);
    if (steps.length) {
      if (typeof fs.stepIndex!=="number"||fs.stepIndex<-1||fs.stepIndex>=steps.length) fs.stepIndex=0;
      if (fs.data) fs.data = hydrateData(fs.data, steps);
    }
  } catch {}
  return fs;
}

// ═══ GEMINI CALLS ═══

// تنظيف نص المستخدم قبل ما يتحط جوه الـ system prompt
// بيمنع Prompt Injection (محاولة العميل يغيّر تعليمات البوت) وبيحد الطول
function sanitizeForPrompt(s, max = 300) {
  return String(s || "")
    .replace(/[`\u0000-\u001F\u007F]/g, " ")   // شيل الأحرف التحكمية والباك-تيك
    .replace(/\b(ignore|disregard|system\s*prompt|forget)\b/gi, "") // عبارات التلاعب الشائعة
    .replace(/تجاهل\s+(كل\s+)?(التعليمات|اللي\s+فات)/g, "")
    // إخفاء أرقام الموبايل قبل إرسال النص لطرف تالت — العميل ساعات بيكتب رقمه في الرسالة نفسها
    .replace(/(?:\+?2)?0?1[0-2]\d{8}/g, "[رقم]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// نسخة مختصرة وآمنة من بيانات الفورم للـ AI
// مهم: بنشيل الاسم والتليفون — مفيش داعي نبعت بيانات العميل الشخصية لطرف تالت
const PII_KEYS = new Set(["ownerName","ownerPhone","buyerName","buyerPhone","phone","_filled"]);
function safeDataForPrompt(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (PII_KEYS.has(k)) continue;
    if (k.startsWith("_") || k.startsWith("selected")) continue;
    if (!hasVal(v)) continue;
    out[k] = typeof v === "string" ? v.slice(0, 60) : v;
  }
  return JSON.stringify(out).slice(0, 500);
}

async function callGemini(env, sys, msgs, maxTok=150, temp=0.6) {
  if (!env?.GEMINI_API_KEY) return null;
  try {
    // المفتاح في Header مش في الـ query string — الـ URLs بتتسجّل في اللوجات والـ proxies
    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;
    const body = { system_instruction: { parts:[{text:sys}] }, contents: msgs, generationConfig: { temperature:temp, maxOutputTokens:maxTok } };
    const r = await fetchWithTimeout(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body:JSON.stringify(body)
    }, FETCH_TIMEOUT_GEMINI);
    if (!r.ok) {
      // منسجّلش نص الرد كامل عشان ميحتويش على بيانات حساسة
      console.warn("[gemini] non-ok status:", r.status);
      return null;
    }
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    return t ? String(t).trim() : null;
  } catch (err) {
    console.warn("[gemini] failed:", err?.name === "AbortError" ? "timeout" : err?.message);
    return null;
  }
}

// ═══ الإحساس بالوقت (v8.6) ═══
// طارق بيرد من موبايله، فلازم يبان إنه عارف الساعة كام واليوم إيه.
// بنحسب توقيت القاهرة مباشرة عشان الـ Worker بيشتغل على UTC.
function cairoNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", hour: "numeric", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || "";
  // Intl بيرجّع 24 بدل 0 بعد منتصف الليل في بعض البيئات
  const hour = Number(get("hour")) % 24;
  const wd = get("weekday");
  return { hour, isFriday: wd === "Fri" };
}

// وصف الوقت بكلام بشري — بيتحط في الـ prompt عشان النموذج يتصرف على أساسه
// ملاحظة: ده سياق للـ AI بس، مش نص بيتعرض للعميل، عشان ميبقاش جملة محفوظة
function timeContext(now = cairoNow()) {
  const { hour, isFriday } = now;
  const bits = [];
  if (isFriday) bits.push("النهاردة الجمعة والمكتب إجازة");
  if (hour >= 22 || hour < 5) bits.push("الوقت دلوقتي متأخر بالليل");
  else if (hour >= 21) bits.push("الوقت بعد التسعة بالليل والمكتب قفل");
  else if (hour < 9) bits.push("الوقت بدري الصبح والمكتب لسه مافتحش");
  else if (hour < 12) bits.push("المكتب بيفتح 12 الضهر، لسه مافتحش");
  if (!bits.length) return "";
  return `الوقت دلوقتي: ${bits.join("، ")}.
اذكر ده بشكل عابر وطبيعي لو كان له لازمة (زي إنك هترد متأخر أو المعاينة تتأجل)، من غير ما تعتذر كتير ومن غير ما تكرره في كل رد.`;
}

// ملاحظة: TAREK_PERSONA و MOOD_GUIDE و IDENTITY_RESPONSE معرّفين فوق بعد CONSTANTS —
// الوكيل مؤتمت ومش طارق شخصيًا (توحيد الهوية + إفصاح صادق).

async function geminiFirstMsg(env, userMsg, history) {
  const sys = `${TAREK_PERSONA}

الموقف: حد لسه داخل على الشات دلوقتي وكتبلك حاجة.
انت عايز تعرف هو عايز يشتري ولا يأجر ولا عنده عقار عايز يبيعه أو يأجره.
تحت الشات في أزرار جاهزة، وجّهه ليها بكلامك من غير ما تسرد الاختيارات كأنها قايمة.

${MOOD_GUIDE}
${timeContext()}

رد بسطر أو اتنين بالكتير. متسألش عن تفاصيل العقار دلوقتي ومتتكلمش في أسعار.`;
  // 0.85 بدل 0.6 — أول انطباع محتاج تنوّع، الحرارة الواطية بتنتج نفس الجملة كل مرة
  return callGemini(env, sys, [{role:"user",parts:[{text:sanitizeForPrompt(userMsg)}]}], 150, 0.85);
}

async function geminiComment(env, userMsg, nextQ, fsData) {
  const safeMsg = sanitizeForPrompt(userMsg);

  // مفتاح الكاش لازم يشمل السؤال المطروح كمان، مش نص العميل بس
  // قبل كده: العميل يكتب "3" للغرف و"3" للحمامات فياخد نفس التعليق حرفيًا
  // وكمان كل العملاء اللي بيكتبوا نفس الكلمة كانوا بياخدوا نفس الجملة لمدة نص ساعة
  const qKey = normAr(String(nextQ||"")).slice(0,40);
  const cacheKey = `c:${qKey}:${normAr(userMsg).slice(0,60)}`;
  const cached = geminiCache.get(cacheKey);
  // بنخزّن عدة صيغ للموقف الواحد وبنختار واحدة عشوائية — يمنع تكرار نفس الجملة
  if (cached && (Date.now()-cached.at) < GEMINI_CACHE_TTL && cached.variants?.length) {
    return cached.variants[Math.floor(Math.random()*cached.variants.length)];
  }

  const sys = `${TAREK_PERSONA}

الموقف: العميل لسه جاوبك على سؤال، وانت هتسأله السؤال اللي بعده على طول.
عايز منك رد فعل قصير جدا على إجابته — زي ما بتعمل في الواتساب بالظبط.

${MOOD_GUIDE}
${timeContext()}

مهم جدا: مش كل إجابة محتاجة رد.
لو إجابته عادية خالص (رقم، اختيار من زرار، كلمة واحدة) — مترّدش خالص واكتب: -
الرد الفاضي ده طبيعي، البني آدم مش بيعلّق على كل كلمة.
علّق بس لما يكون في حاجة فعلا تستاهل: حاجة مميزة، أو حاجة محتاجة طمأنة، أو مزاج واضح في كلامه.

لو هتعلّق: كلمتين أو تلاتة بالكتير. متعيدش السؤال اللي جاي. متفتحش موضوع جديد.
نوّع في كلامك، متقولش نفس الكلمة كل مرة.

إجابة العميل: "${safeMsg}"
السؤال اللي جاي: "${sanitizeForPrompt(nextQ, 200)}"
اللي عارفه عنه: ${safeDataForPrompt(fsData)}`;

  // 0.95 بدل 0.7 — دي أكتر دالة محتاجة عشوائية عشان متكررش نفس التعليق
  const reply = await callGemini(env, sys, [{role:"user",parts:[{text:safeMsg}]}], 60, 0.95);

  // النموذج بيرجع "-" لما يقرر إن الإجابة متستاهلش تعليق
  const cleaned = String(reply||"").trim();
  if (!cleaned || cleaned === "-" || /^[-–—.]+$/.test(cleaned)) return null;

  // خزّن الصيغة الجديدة مع الصيغ السابقة لنفس الموقف (بحد أقصى 4)
  const variants = cached?.variants ? [...new Set([...cached.variants, cleaned])].slice(-4) : [cleaned];
  cacheSet(geminiCache, cacheKey, { variants, at: cached?.at || Date.now() });
  return cleaned;
}

async function geminiContextual(env, userMsg, formState, currentStep, history) {
  const q = currentStep ? (typeof currentStep.q==="function"?currentStep.q(formState?.data):currentStep.q) : "";
  const convHistory = (Array.isArray(history)?history:[]).slice(-8)
    .filter(m=>m?.message?.trim())
    .map(m=>({ role:m.role==="assistant"?"model":"user", parts:[{text:sanitizeForPrompt(m.message, 500)}] }));
  if (convHistory[convHistory.length-1]?.role==="user") convHistory.pop();
  convHistory.push({ role:"user", parts:[{text:sanitizeForPrompt(userMsg)}] });

  const sys = `${TAREK_PERSONA}

الموقف: انت كنت سألته سؤال، وهو بدل ما يجاوب سألك انت سؤال تاني.
جاوب على سؤاله بسرعة وبعدين رجّعه للسؤال بتاعك.

${MOOD_GUIDE}
${timeContext()}

السؤال اللي انت مستنيه منه: "${sanitizeForPrompt(q, 200)}"
اللي عارفه عنه: ${safeDataForPrompt(formState?.data)}

جاوب سؤاله في سطر واحد بس، وبعدين اسأله سؤالك تاني.
السؤال ترجّعه بمعناه وبكلامك انت، مش نسخ لصق حرفي.
لو سأل في حاجة بعيدة عن العقارات، رجّعه للموضوع من غير ما تحسسه إنك بتتجاهله.`;
  // 0.75 بدل 0.5 — كانت أقل حرارة وهي أكتر دالة بترد على أسئلة حقيقية
  return callGemini(env, sys, convHistory, 150, 0.75);
}

// ═══ Gemini لتعليق الردود الحوارية المؤهلة (تُستثنى أسعار D1 الحتمية) ═══
// بيحدد هل الإجابة دي تستاهل تعليق أصلًا قبل ما نستدعي الـ AI
// البني آدم مش بيعلّق على كل كلمة — التعليق على كل رد هو أوضح علامة إنه بوت
function deservesComment(userMsg) {
  const t = String(userMsg||"").trim();
  if (!t) return false;
  // ضغطة زرار أو رقم مجرد — مفيش داعي لتعليق
  if (/^\d+$/.test(toEnNum(t))) return false;
  if (t.length <= 3) return false;
  // مؤشرات إن العميل كاتب حاجة فيها مزاج أو تفصيل يستاهل رد فعل
  const hasMood = /[!؟?]{1,}|هه|😀|😂|🙏|😊|حلو|تمام\s*\?|مستعجل|بسرعة|دلوقتي|مش فاهم|غالي|كتير|معقول/.test(t);
  const isLong  = t.split(/\s+/).length >= 4;
  return hasMood || isLong;
}

async function enhanceResponse(env, result, userMsg, formState, currentStep, history) {
  if (!formState?.active || result.done || result.readyToSend) return result;
  // فلتر قبلي: بيوفر استدعاءات Gemini وبيخلي الإيقاع طبيعي
  if (!deservesComment(userMsg)) return result;
  const comment = await geminiComment(env, userMsg, result.response, formState?.data);
  if (comment) return { ...result, response:`${comment}\n\n${result.response}` };
  return result;
}

// ═══ FLOW: ASK STEP ═══
function askOwnerStep(steps, idx, fs, extra, lms) {
  const data = hydrateData(fs.data||{}, steps);
  if (idx<0||idx>=steps.length) return completeOwner({...fs,data}, data);
  const step = steps[idx];
  if (!isApplicable(step,data)) {
    const ni = nextStep(steps, data, idx+1);
    if (ni===-1) return completeOwner({...fs,data},data);
    return askOwnerStep(steps, ni, {...fs,data}, null, lms);
  }
  if (step.type==="images_step") return askImgStep(steps, idx, {...fs,data});

  const progress = buildProgress(steps,data,idx);
  let q = typeof step.q==="function"?step.q(data):step.q;
  if (progress.remaining>1) q += `\n\n(${progress.current}/${progress.total})`;

  let opts;
  if (step.type==="buttons") opts = withCtrl(step.opts, data);
  else opts = withCtrl([], data);

  // خطوة الموقع → الواجهة بتفتح منتقي الخريطة (إجباري في البيع، اختياري في الإيجار)
  const ui = step.id==="location" ? { ui:"map_picker", uiRequired: fs.type==="sale" } : {};

  return {
    response: extra ? `${extra}\n\n${q}` : q,
    formState: {...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[], ...ui
  };
}

function askBuyerStep(steps, idx, fs, extra, lms) {
  const data = hydrateData(fs.data||{}, steps);
  if (idx<0||idx>=steps.length) return completeBuyer({...fs,data},data);
  const step = steps[idx];
  if (!isApplicable(step,data)) {
    const ni = nextStep(steps,data,idx+1);
    if (ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,data},null,lms);
  }

  const progress = buildProgress(steps,data,idx);
  let q = typeof step.q==="function"?step.q(data):step.q;
  if (progress.remaining>1) q += `\n\n(${progress.current}/${progress.total})`;

  let opts;
  if (step.type==="buttons") opts = withCtrl(step.opts, data, idx>0);
  else if (step.type==="dynamic_buttons" && step.id==="landmark") {
    const pool = lms?.length ? lms : MASTER_LANDMARKS;
    if (pool.length>MAX_VISIBLE_LM) {
      const visible = pool.slice(0,MAX_VISIBLE_LM);
      opts = withCtrl([...visible, `${BTN.MORE} (${pool.length-MAX_VISIBLE_LM})`, BTN.ANY_AREA], data, idx>0);
    } else {
      opts = withCtrl([...pool, BTN.ANY_AREA], data, idx>0);
    }
  } else opts = withCtrl([], data, idx>0);

  // خطوة المنطقة عند المشتري/المستأجر → منتقي الخريطة اختياري
  const ui = step.id==="landmark" ? { ui:"map_picker", uiRequired:false } : {};

  return {
    response: extra ? `${extra}\n\n${q}` : q,
    formState: {...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[], ...ui
  };
}

function askImgStep(steps, idx, fs) {
  const imageUrls = fs.imageUrls||[];
  const opts = imageUrls.length>0
    ? [BTN.IMG_DONE, BTN.ADD_IMG, BTN.DEL_IMG, BTN.BACK, BTN.CANCEL]
    : [BTN.ATTACH_IMG, BTN.SKIP_IMG, BTN.BACK, BTN.CANCEL];
  return {
    response: `لو عندك صور للعقار، تقدر ترفقها دلوقتي (لحد ${MAX_IMAGES} صور).`,
    formState: {...fs, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:true,
    imageUrls
  };
}

// ═══ COMPLETE OWNER ═══
function completeOwnerCheck(fs, data) {
  const steps = getOwnerSteps(fs.type);
  const missing = REQUIRED_OWNER.filter(id=>{
    const s = steps.find(x=>x.id===id);
    return s && isApplicable(s,data) && !isFilled(data,s);
  });
  if (missing.length) {
    const idx = steps.findIndex(s=>s.id===missing[0]);
    if (idx>=0) return askOwnerStep(steps, idx, fs, null, null);
  }
  return completeOwner(fs, data);
}

function completeOwner(fs, data) {
  const steps = getOwnerSteps(fs.type);
  const imgs = fs.imageUrls||[];
  const ctx = fs.type==="sale"?"owner_sale":"owner_rent";
  const waMsg = buildWAMsg(ctx, data, imgs);
  const total = countSteps(steps, data);
  const hasImgs = imgs.length>0;
  const imgNote = hasImgs ? `استلمت ${imgs.length} صورة ✅` : (data.imagesSkipped ? "تم تخطي الصور" : "مفيش صور");

  return {
    response: `تمام يا فندم، سجّلت العقار كامل ✅\n\n${imgNote}\n\nقبل ما نبعت لطارق، عايز تراجع الرسالة؟`,
    formState: {...fs, stepIndex:-1, data, lifecycle:LC.DONE,
      flowType: fs.type==="sale"?"owner_completed_sale":"owner_completed_rent",
      awaitingQ:false, imageUrls:imgs},
    options: POST_COMPLETE, done:true, readyToSend:true, canShareWhatsapp:true,
    progress: {current:total,total,remaining:0,pct:100},
    leadData: { type:getRequestLabel(ctx, data.propertyType, data.furnished, true), ...data },
    waMessage: waMsg, imageUrls:imgs, whatsappUrl: waURL(TAREK_PHONE, waMsg)
  };
}

// ═══ COMPLETE BUYER ═══
async function completeBuyer(fs, data) {
  const imgs = fs.imageUrls||[];
  let allProps = [];
  try { const feed = await fetchFeed(); allProps = feed.properties||[]; } catch {}

  const criteria = {
    transaction: fs.type,
    landmark: data.landmark && data.landmark!=="__ANY__" ? data.landmark : null,
    propertyType: data.propertyType || null,
    budget: parseNum(data.budget),
    rooms: parseNum(data.rooms),
    baths: parseNum(data.baths),
    furnished: data.furnished||null,
  };

  const matches = filterAndRank(allProps, criteria);
  const isRent = fs.type==="rent";
  const requestLabel = getRequestLabel(fs.type, data.propertyType, data.furnished);
  const waMsg = buildWAMsg(isRent?"tenant":"buyer", data, imgs);

  if (!matches.length) {
    return {
      response: `حالياً مفيش ${data.propertyType||"عقار"} معروض بنفس الميزانية في المنطقة دي على السيستم.\n\nبس ولا تشيل هم! أنا جهّزت كامل مواصفاتك لطارق طنطاوي عشان يدوّرلك في المعروض الخاص ويتواصل معاك أول ما ينزل طلبك مباشرة 🌟.\n\nابعت الرسالة لطارق دلوقتي على واتساب:`,
      formState: {...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
      options: POST_COMPLETE,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
      leadData: { type: requestLabel, ...data, matchedProperties: 0 },
      imageUrls:imgs
    };
  }

  const lines = [`دي أنسب ${matches.length} عقارات مطابقة لطلبك بالضبط:`];
  matches.forEach((p,i)=>{
    const pt = p.propertyType==="apartment"?"شقة":p.propertyType==="office"?"مكتب":
               p.propertyType==="shop"?"محل":p.propertyType==="storage"?"مخزن":
               p.propertyType==="roof"?"روف":"فيلا";
    const tx = p.transaction==="rent"?"إيجار":"بيع";
    const priceN = parseNum(p.priceNumeric||p.price);

    lines.push("",`*${i+1}. ${p.title||"عقار"}*`,
      [pt,tx,p.location,priceN>0?`${fmtNum(priceN)} ج.م`:""].filter(Boolean).join(" • "));

    if (priceN>0) lines.push(`💰 السعر: ${fmtNum(priceN)} ج.م`);
    if (p.area)   lines.push(`📐 المساحة: ${fmtVal(p.area)} متر مربع`);
    const rN = parseNum(p.roomsNumeric||p.rooms);
    if (rN>0) lines.push(`🛏️ الغرف: ${rN}`);
    const bN = parseNum(p.bathsNumeric||p.baths);
    if (bN>0) lines.push(`🛁 الحمامات: ${bN}`);
    if (p.floor) lines.push(`🏢 الدور: ${p.floor}`);
    const fin = p.finishing||p.finish;
    if (fin) lines.push(`✨ التشطيب: ${fin}`);
    if (p.image) lines.push(`📷 صورة العقار: ${p.image}`);
    if (p.url)   lines.push(`🔗 التفاصيل: ${p.url}`);
  });
  lines.push("","اختار رقم العقار للمعاينة، أو لو مش مناسبين ابعت مواصفاتك لطارق:");

  const selectOpts = [...matches.map((_,i)=>String(i+1)), BTN.CUSTOM_SPEC, BTN.BACK];

  return {
    response: lines.join("\n"),
    formState: {...fs, active:true, flowType:"buyer_select", stepIndex:-1, data, suggestedProperties:matches, imageUrls:imgs, waMessage:waMsg},
    options: selectOpts,
    done:false, readyToSend:false, canShareWhatsapp:false,
    waMessage: waMsg,
    leadData: { type: requestLabel, ...data, matchedProperties:matches.length },
    imageUrls:imgs
  };
}

// ═══ PROCESS FLOWS ═══
async function processOwner(fs, msg, env, history, lms) {
  const steps = getOwnerSteps(fs.type);
  const step = steps[fs.stepIndex];
  if (!step) return completeOwnerCheck(fs, fs.data||{});

  if (isNewReq(msg)) return newRequest();
  if (isBack(msg)) {
    const bs = goBack(fs);
    return askOwnerStep(getOwnerSteps(bs.type), bs.stepIndex, bs, "تمام، رجعنا خطوة.", lms);
  }
  if (isCancel(msg)) return cancelFlow(fs);
  if (isSendNow(msg)) return completeOwnerCheck(fs, fs.data||{});

  const data = {...(fs.data||{})};

  if (isSkip(msg)) {
    data[step.id] = "—"; markFilled(data,step);
    const ni = nextStep(steps, data, fs.stepIndex+1);
    if (ni===-1) return completeOwnerCheck({...fs,data},data);
    return askOwnerStep(steps, ni, {...fs,stepIndex:ni,data}, null, lms);
  }

  if (step.type==="images_step") return processImgStep(fs, msg, env, step, lms);

  if (step.type==="buttons") {
    const m = matchOpt(msg, step.opts);
    if (m) {
      data[step.id]=m; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if (ni===-1) return completeOwnerCheck({...fs,data},data);
      return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
    return askOwnerStep(steps,fs.stepIndex,fs,"معلش، اختار من الأزرار اللي تحت.",lms);
  }

  const txt = String(msg||"").trim();
  if (step.type==="number") {
    const n=parseNum(txt);
    if (!n||n<=0) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
    data[step.id]=n;
  } else if (step.type==="phone") {
    const ph=normPhone(txt);
    if (!/^01[0-9]{9}$/.test(ph)) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم موبايل 11 رقم يبدأ بـ01.",lms);
    data[step.id]=ph;
  } else {
    if (!txt) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب إجابة.",lms);
    data[step.id]=txt;
    if (step.id === "location") {
      try {
        const area = findAreaMention(txt, await listMarketAreas(env?.DB));
        if (area) data.marketArea = area;
      } catch {}
    }
  }
  markFilled(data,step);
  const ni = nextStep(steps,data,fs.stepIndex+1);
  if (ni===-1) return completeOwnerCheck({...fs,data},data);
  return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
}

async function processBuyer(fs, msg, env, history, lms) {
  const steps = getBuyerSteps(fs.type);
  const step = steps[fs.stepIndex];
  if (!step) return completeBuyer(fs, fs.data||{});

  if (isNewReq(msg)) return newRequest();
  if (isBack(msg)) {
    const bs = goBack(fs);
    return askBuyerStep(getBuyerSteps(bs.type), bs.stepIndex, bs, "تمام، رجعنا خطوة.", lms);
  }
  if (isCancel(msg)) return cancelFlow(fs);

  const data = {...(fs.data||{})};

  if (step.type==="dynamic_buttons" && step.id==="landmark") {
    if (isMore(msg)) {
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const rest = pool.slice(MAX_VISIBLE_LM);
      if (!rest.length) return askBuyerStep(steps,fs.stepIndex,fs,"مفيش مناطق تانية.",lms);
      return {
        response:`دي باقي المناطق (${rest.length}):`,
        formState:{...fs,data,awaitingQ:true},
        options:[...rest,BTN.FIRST_LIST,BTN.ANY_AREA,BTN.BACK,BTN.NEW_REQ],
        done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:fs.imageUrls||[]
      };
    }
    if (isBackFirst(msg)) {
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const visible = pool.slice(0,MAX_VISIBLE_LM);
      return {
        response:"تمام، دي المناطق الأكثر شيوعاً:",
        formState:{...fs,data,awaitingQ:true},
        options:withCtrl([...visible,`${BTN.MORE} (${pool.length-MAX_VISIBLE_LM})`,BTN.ANY_AREA],data,fs.stepIndex>0),
        done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:fs.imageUrls||[]
      };
    }
    if (isAnyArea(msg)) data.landmark="__ANY__";
    else {
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const lm = matchLandmark(msg, pool) || msg.trim();
      data.landmark = lm;
    }
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }

  const extracted = extractBuyerFields(msg);
  for (const [k,v] of Object.entries(extracted)) {
    if (hasVal(v) && !hasVal(data[k])) { data[k]=v; if (!data._filled) data._filled={}; data._filled[k]=true; }
  }

  if (hasVal(data[step.id])) {
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }

  if (step.type==="buttons") {
    const m = matchOpt(msg, step.opts);
    if (m) {
      data[step.id]=m; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if (ni===-1) return completeBuyer({...fs,data},data);
      return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
  }

  const txt = String(msg||"").trim();
  if (step.type==="number") {
    const n=parseNum(txt);
    if (n>0) {
      data[step.id]=n; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if (ni===-1) return completeBuyer({...fs,data},data);
      return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
  } else if (step.type==="phone") {
    const ph=normPhone(txt);
    if (!/^01[0-9]{9}$/.test(ph)) return askBuyerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم موبايل 11 رقم يبدأ بـ01.",lms);
    data[step.id]=ph; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  } else if (txt) {
    data[step.id]=txt; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }

  return askBuyerStep(steps,fs.stepIndex,fs,"معلش، ممكن توضح تاني؟",lms);
}

function extractBuyerFields(msg) {
  const t = String(msg||"").trim();
  const out = {};
  if (/دوبلكس/i.test(t)) out.propertyType="دوبلكس";
  else if (/شقة|شقه/.test(t)) out.propertyType="شقة";
  else if (/فيلا/.test(t)) out.propertyType="فيلا";
  else if (/روف/.test(t)) out.propertyType="روف";
  else if (/محل/.test(t)) out.propertyType="محل تجاري";
  else if (/مكتب/.test(t)) out.propertyType="مكتب إداري";
  else if (/مخزن/.test(t)) out.propertyType="مخزن";
  const lm = matchLandmark(t, MASTER_LANDMARKS);
  if (lm) out.landmark=lm;
  const budget = extractPrice(t);
  if (budget>0) out.budget=budget;
  const rm = t.match(/(\d+)\s*(غرف|غرفة|أوض|اوض)/);
  if (rm) out.rooms=rm[1];
  const bm = t.match(/(\d+)\s*(حمام|حمامات)/);
  if (bm) out.baths=bm[1];
  const phoneMatch = t.match(/01[0-9]{9}/);
  if (phoneMatch) out.buyerPhone = phoneMatch[0];
  if (/مفروش/.test(t)) out.furnished="مفروش";
  else if (/فاضي|قانون جديد/.test(t)) out.furnished="فاضي (قانون جديد)";
  return out;
}

async function processImgStep(fs, msg, env, step, lms) {
  const steps = getOwnerSteps(fs.type);
  const data = {...(fs.data||{})};
  const imgs = fs.imageUrls||[];

  if (isSkipImg(msg)) {
    data.imagesSkipped=true; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeOwnerCheck({...fs,data,imageUrls:imgs},data);
    return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data,imageUrls:imgs},null,lms);
  }
  if (isAttachImg(msg)) {
    return {
      response:`تمام 👌\nدوس على 📷 جنب شريط الكتابة واختار الصور.\n\nبعد ما تخلص، اضغط "✅ تمام، كمّل".`,
      formState:{...fs,data,imageUrls:imgs},
      options:imgs.length?[BTN.IMG_DONE,BTN.ADD_IMG,BTN.DEL_IMG,BTN.BACK,BTN.CANCEL]:[BTN.IMG_DONE,BTN.BACK,BTN.CANCEL],
      done:false,readyToSend:false,canShareWhatsapp:true,imageUrls:imgs,imageStepAction:"open_picker"
    };
  }
  if (isDelImg(msg)) {
    return {
      response:"تمام، مسحنا كل الصور.",
      formState:{...fs,data,imageUrls:[]},
      options:[BTN.ATTACH_IMG,BTN.SKIP_IMG,BTN.BACK,BTN.CANCEL],
      done:false,readyToSend:false,canShareWhatsapp:true,imageUrls:[]
    };
  }
  if (isImgDone(msg)) {
    if (!imgs.length) data.imagesSkipped=true;
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if (ni===-1) return completeOwnerCheck({...fs,data,imageUrls:imgs},data);
    return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data,imageUrls:imgs},null,lms);
  }
  return askOwnerStep(steps,fs.stepIndex,{...fs,data,imageUrls:imgs},"اختار من الأزرار تحت.",lms);
}

// ═══ ✅ processBuyerSelect — لا تعليق ═══
async function processBuyerSelect(fs, msg, env) {
  const props = fs.suggestedProperties||[];
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const isRent = fs.type==="rent";
  const waMsg = fs.waMessage || buildWAMsg(isRent?"tenant":"buyer", data, imgs);
  const requestLabel = getRequestLabel(fs.type, data.propertyType, data.furnished);

  if (isNewReq(msg)) return newRequest();

  if (isCustomSpec(msg)) {
    return {
      response: `تمام يا فندم 🌟\nجهّزتلك رسالتك المؤهلة بكل تفاصيل طلبك لطارق طنطاوي.\n\nتقدر تبعتها على واتساب دلوقتي:`,
      formState: {...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
      options: POST_COMPLETE,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
      imageUrls: imgs,
      leadData: { type: requestLabel, ...data }
    };
  }

  if (isBack(msg)) {
    const bs = goBack(fs);
    const backSteps = getBuyerSteps(bs.type);
    return askBuyerStep(backSteps, bs.stepIndex, bs, "تمام، رجعنا خطوة.", null);
  }

  const nm = toEnNum(String(msg||"")).match(/\d+/);
  const choice = nm ? parseInt(nm[0],10) : NaN;

  if (!isNaN(choice) && choice>=1 && choice<=props.length) {
    const sel = props[choice-1];
    const selPrice = fmtNum(sel.priceNumeric||sel.price);
    const selData = { ...data,
      selectedProperty:sel.title, selectedUrl:sel.url, selectedLocation:sel.location,
      selectedPrice:selPrice, selectedArea:sel.area?`${fmtVal(sel.area)} متر مربع`:null,
      selectedRooms:parseNum(sel.roomsNumeric||sel.rooms)>0?String(parseNum(sel.roomsNumeric||sel.rooms)):null,
      selectedBaths:parseNum(sel.bathsNumeric||sel.baths)>0?String(parseNum(sel.bathsNumeric||sel.baths)):null,
      selectedFloor:sel.floor||null, selectedFinishing:sel.finishing||sel.finish||null,
      selectedImage:sel.image||null
    };
    const propWaMsg = buildWAMsg(isRent?"tenant":"buyer", selData, imgs);
    const lines = [`تمام يا فندم 👌 اخترت:`,``,`🎯 *${sel.title}*`,`📍 ${sel.location}`];
    if (selPrice&&selPrice!=="0") lines.push(`💰 ${selPrice} ج.م`);
    if (sel.area) lines.push(`📐 المساحة: ${fmtVal(sel.area)} متر مربع`);
    const rN=parseNum(sel.roomsNumeric||sel.rooms);
    if (rN>0) lines.push(`🛏️ الغرف: ${rN}`);
    const bN=parseNum(sel.bathsNumeric||sel.baths);
    if (bN>0) lines.push(`🛁 الحمامات: ${bN}`);
    if (sel.floor) lines.push(`🏢 الدور: ${sel.floor}`);
    const fin=sel.finishing||sel.finish;
    if (fin) lines.push(`✨ التشطيب: ${fin}`);
    if (sel.image) lines.push(`📷 صورة العقار: ${sel.image}`);
    if (sel.url)   lines.push(`🔗 التفاصيل: ${sel.url}`);
    lines.push(``,`تحب نحدد ميعاد معاينة ونتواصل مع أ. طارق؟`);

    return {
      response: lines.join("\n"),
      formState: {...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_selected_property", selectedProperty:sel, data:selData, imageUrls:imgs, waMessage:propWaMsg},
      options: POST_SELECTED,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: propWaMsg,
      whatsappUrl: waURL(TAREK_PHONE, propWaMsg),
      imageUrls: imgs,
      leadData: {type:requestLabel,...selData}
    };
  }

  // ✅ Fallback — أي رد غير مفهوم → رسالة مؤهلة (منع التعليق)
  return {
    response: `تمام، جهّزتلك رسالتك المؤهلة بالمواصفات اللي طلبتها لطارق طنطاوي 🌟.\n\nتقدر تبعتها دلوقتي على واتساب:`,
    formState: {...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
    options: POST_COMPLETE,
    done:true, readyToSend:true, canShareWhatsapp:true,
    waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
    imageUrls: imgs
  };
}

// ═══ processBuyerSelectedProp ═══
async function processBuyerSelectedProp(fs, msg, env) {
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const ctx = fs.type==="rent"?"tenant":"buyer";
  const waMsg = fs.waMessage || buildWAMsg(ctx,data,imgs);

  if (isNewReq(msg)) return newRequest();

  if (isBookView(msg)||isSendWA(msg)||isAccept(msg)) {
    return {
      response: `تمام يا فندم! اضغط على الزر ده عشان تفتح واتساب وتبعت الرسالة لطارق مباشرة 👇`,
      formState: {...fs, waMessage:waMsg},
      options: POST_VIEWING, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  
  if (isPreview(msg)) {
    return {
      response: `دي الرسالة المؤهلة اللي هتتبعت لطارق على واتساب:\n\n${waMsg}`,
      formState: {...fs, waMessage:waMsg},
      options: POST_SELECTED, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  
  if (isBackList(msg)||isBack(msg)) {
    const props = fs.suggestedProperties||[];
    if (!props.length) return completeBuyer(fs,data);
    const selectOpts = [...props.map((_,i)=>String(i+1)), BTN.CUSTOM_SPEC, BTN.BACK];
    return {
      response: `تمام، دي قائمة العقارات المقترحة تاني. اختار رقم العقار أو اضغط لإرسال طلبك الخاص:`,
      formState: {...fs, active:true, flowType:"buyer_select", selectedProperty:null, imageUrls:imgs},
      options: selectOpts,
      done:false, readyToSend:false, canShareWhatsapp:false, imageUrls:imgs
    };
  }

  return {
    response: `جاهزين لإرسال طلب المعاينة لطارق طنطاوي على واتساب:`,
    formState: fs,
    options: POST_SELECTED,
    done:true, readyToSend:true, canShareWhatsapp:true,
    waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
  };
}

// ═══ processPostComplete ═══
async function processPostComplete(fs, msg, env) {
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const ownerFlow = String(fs.flowType||"").startsWith("owner");
  const ctx = ownerFlow?(fs.type==="sale"?"owner_sale":"owner_rent"):(fs.type==="sale"?"buyer":"tenant");
  const waMsg = fs.waMessage || buildWAMsg(ctx,data,imgs);

  if (isSendWA(msg)) {
    return {
      response: "تمام يا فندم! اضغط على الزر تحت لفتح المحادثة على واتساب فوراً 👇",
      formState: {...fs, waMessage:waMsg},
      options: POST_COMPLETE, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  
  if (isPreview(msg)) {
    return {
      response: `دي الرسالة المؤهلة اللي هتتبعت لطارق:\n\n${waMsg}`,
      formState: {...fs, waMessage:waMsg},
      options: POST_PREVIEW, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  
  if (isEdit(msg)) {
    const editFs = {...fs, active:true, lifecycle:LC.ACTIVE, stepIndex:0,
      flowType:ownerFlow?"owner":(fs.type==="sale"?"buyer":"tenant"), awaitingQ:true, data:{}, waMessage:null};
    if (ownerFlow) return askOwnerStep(getOwnerSteps(fs.type),0,editFs,null,null);
    return askBuyerStep(getBuyerSteps(fs.type),0,editFs,null,null);
  }
  
  if (isNewReq(msg)) return newRequest();

  return {
    response: "اضغط على الزر تحت عشان تبعت رسالتك المؤهلة لطارق على واتساب مباشرة:",
    formState: fs,
    options: POST_COMPLETE,
    done:true, readyToSend:true, canShareWhatsapp:true,
    waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
  };
}

// ═══ GO BACK ═══
function goBack(fs) {
  const steps = getSteps(fs.type, fs.flowType);
  const data = {...(fs.data||{})};
  if (!data._filled) data._filled={};
  else data._filled={...data._filled};

  let idx = fs.stepIndex;
  if (idx<0||idx>=steps.length) {
    const filled = steps.map((s,i)=>({s,i})).filter(({s})=>isFilled(data,s)).map(({i})=>i);
    idx = filled.length ? Math.max(...filled)+1 : 0;
  }

  let prev = idx-1;
  while (prev>=0 && steps[prev]?.id==="images") prev--;
  if (prev<0) return {...fs,active:true,lifecycle:LC.ACTIVE,stepIndex:0,data,awaitingQ:true, waMessage:null};

  const prevStep = steps[prev];
  const k = stepKey(prevStep);
  delete data[k]; delete data._filled[k];
  return {...fs,active:true,lifecycle:LC.ACTIVE,stepIndex:prev,data,awaitingQ:true, waMessage:null};
}

// ═══ CANCEL ═══
function cancelFlow(fs) {
  return {
    response:"تمام يا فندم، ألغينا الطلب. تقدر تبدأ من جديد في أي وقت:",
    formState:{active:false,lifecycle:LC.CANCELLED,type:fs.type,stepIndex:-1, data:{},awaitingQ:false,flowType:null,imageUrls:[]},
    options:ROUTE_BTNS, done:true,cancelled:true,readyToSend:false,canShareWhatsapp:false,imageUrls:[]
  };
}

// ═══ NEW REQUEST ═══
function newRequest() {
  return {
    response: `${buildTrustBar()}

معاك سمسار طلبك 🏆
بتدور على إيه، شراء ولا إيجار؟`,
    formState:{active:true,lifecycle:LC.ACTIVE,type:null,stepIndex:-1,data:{}, awaitingQ:false,flowType:"route_selection",imageUrls:[]},
    options:ROUTE_BTNS, done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:[]
  };
}

async function startOwnerFlow(type, message, env, history, lms) {
  const steps = getOwnerSteps(type);
  const data = { _filled: {} };
  const parsedType = normalizeMarketPropertyType(message);
  const parsedSize = extractPropertySize(message);
  let marketContext = null;

  if (type === "sale" && isOwnerSaleIntent(message)) {
    marketContext = await marketContextForMessage(env, message, { type, data });
  }

  // Keep the existing owner qualification form unchanged; seller details travel only in the separate CTA.
  const formState = {
    active: true,
    lifecycle: LC.ACTIVE,
    type,
    stepIndex: 0,
    data,
    awaitingQ: true,
    flowType: "owner",
    imageUrls: [],
  };
  const firstStep = nextStep(steps, data, 0);
  let result = askOwnerStep(steps, firstStep < 0 ? 0 : firstStep, formState, null, lms);

  if (isMarketQuestion(message) && marketContext?.area && parsedType && parsedSize) {
    if (marketContext.snapshot?.ok) {
      result.response = `${formatMarketQuote(marketContext.snapshot, parsedSize)}\n\n${result.response}`;
    } else if (marketContext.snapshot?.reason === "insufficient_data" || marketContext.snapshot?.reason === "unsupported_type") {
      result.response = `مافيش بيانات D1 كافية لنوع العقار والمنطقة دي، فمش هخمن سعرًا.\n\n${result.response}`;
    }
  }

  result.valuationCta = valuationCta(type === "sale" ? "seller" : "valuation", {
    areaName: marketContext?.area,
    size: parsedSize,
    propertyType: propertyTypeLabel(parsedType),
    areaType: type,
  });
  // Keep market/seller replies deterministic; Gemini must not attach an unverified price to them.
  if (isMarketQuestion(message) || isOwnerSaleIntent(message)) return result;
  return enhanceResponse(env, result, message, result.formState, steps[firstStep] || steps[0], history);
}

// ═══ ROUTE DETECTION ═══
function detectRoute(msg) {
  const raw = String(msg||"").trim();
  const n = normalizeMarketText(raw);
  if (/ااجر|اؤجر|أأجر|أاجر|مؤجر|عندي.*للإيجار/i.test(raw)) return "owner_rent";
  if (n.includes("استاجر") || n.includes("مستاجر") || /بدور.{0,30}(?:ايجار|للايجار)/.test(n)) return "buyer_rent";
  if (isOwnerSaleIntent(raw)) return "owner_sale";
  if (n.includes("اشتري") || n.includes("شراء") || n.includes("تمليك")
      || (/(?:شقه|عقار|فيلا|دوبلكس|محل|مكتب)/.test(n) && /للبيع|للتملك/.test(n) && !n.includes("شقتي"))) return "buyer_sale";
  if (n.includes("ايجار") || n.includes("اجار")) return "buyer_rent";
  if (n.includes("بيع")) return "owner_sale";
  return null;
}

// ═══ UPLOAD IMGBB ═══

// تحقق من إن المدخل فعلاً صورة base64 وحجمها معقول
// من غير ده الـ endpoint مفتوح لأي حد يرفع أي داتا على حساب مفتاحنا
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function validateImagePayload(raw) {
  if (typeof raw !== "string") return null;
  // اقبل شكل data URL كمان واستخرج منه الجزء المشفّر
  let b64 = raw.trim();
  const dataUrl = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (dataUrl) b64 = dataUrl[2];
  b64 = b64.replace(/\s/g, "");
  if (!b64 || b64.length < 64) return null;
  if (!B64_RE.test(b64)) return null;
  // الحجم التقريبي بعد فك التشفير = 3/4 طول النص
  const approxBytes = Math.floor(b64.length * 3 / 4);
  if (approxBytes > MAX_IMG_BYTES) return null;
  return b64;
}

async function uploadImgBB(env, images) {
  const key = env?.IMGBB_API_KEY;
  if (!key) { console.warn("[imgbb] missing key"); return {ok:false,error:"Upload unavailable"}; }
  if (!Array.isArray(images) || !images.length) return {ok:false,error:"No images"};
  if (images.length>MAX_IMAGES) return {ok:false,error:`Max ${MAX_IMAGES}`};

  // تحقق من كل صورة قبل أي طلب خارجي
  const valid = images.map(validateImagePayload).filter(Boolean);
  if (!valid.length) return {ok:false,error:"Invalid image data"};

  // رفع بالتوازي بدل التسلسل — 5 صور بقت في زمن صورة واحدة تقريباً
  const results = await Promise.allSettled(valid.map(async (b64) => {
    const f = new FormData();
    f.append("key", key);
    f.append("image", b64);
    const r = await fetchWithTimeout("https://api.imgbb.com/1/upload", {method:"POST", body:f}, FETCH_TIMEOUT_IMGBB);
    if (!r.ok) throw new Error(`imgbb HTTP ${r.status}`);
    const d = await r.json();
    const u = d?.data?.url;
    if (typeof u !== "string" || !/^https:\/\//.test(u)) throw new Error("bad url");
    return u;
  }));

  const urls = [];
  for (const res of results) {
    if (res.status === "fulfilled") urls.push(res.value);
    else console.warn("[imgbb] one upload failed:", res.reason?.message);
  }
  return urls.length?{ok:true,urls}:{ok:false,error:"Upload failed"};
}

// ═══ RATE LIMITER ═══
// خريطتين منفصلتين: الشات له حد، ورفع الصور له حد أقل (لأنه أغلى بكتير)
const rateMap = new Map();
const uploadRateMap = new Map();

// تنظيف دوري للمفاتيح القديمة — من غيره الخريطة بتفضل تكبر طول عمر الـ isolate
function pruneRateMap(map, windowMs) {
  if (map.size < RATE_MAP_MAX_KEYS) return;
  const now = Date.now();
  for (const [k, arr] of map) {
    const fresh = arr.filter(t => now - t < windowMs);
    if (fresh.length) map.set(k, fresh); else map.delete(k);
  }
  // لو لسه كبيرة بعد التنظيف، امسحها بالكامل (حماية قصوى)
  if (map.size >= RATE_MAP_MAX_KEYS) map.clear();
}

function hitLimit(map, key, windowMs, max) {
  pruneRateMap(map, windowMs);
  const now = Date.now();
  const arr = (map.get(key)||[]).filter(t=>now-t<windowMs);
  if (arr.length>=max) return true;
  arr.push(now); map.set(key,arr);
  return false;
}

function rateLimited(ip)       { return hitLimit(rateMap, ip, RATE_WINDOW_MS, RATE_MAX); }
function uploadRateLimited(ip) { return hitLimit(uploadRateMap, ip, UPLOAD_RATE_WINDOW, UPLOAD_RATE_MAX); }

// ═══ RESPONSE HELPERS ═══
// CORS مقيّد: بنرجّع الـ Origin بس لو موجود في القائمة البيضاء
// (قبل كده كان "*" — أي موقع كان يقدر يستهلك الـ Worker ومفاتيحه)
function allowedOrigins(env) {
  const extra = String(env?.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const list = allowedOrigins(env);
  const ok = origin && list.includes(origin);
  return {
    // لو الـ Origin مش مسموح بنرجّع الدومين الأساسي فالمتصفح هيرفض الرد
    "Access-Control-Allow-Origin": ok ? origin : DEFAULT_ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    // هيدرز أمان إضافية
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

// ═══ تأخير الكتابة (v8.6) ═══
// طارق بيكتب من موبايله، فالرد الفوري بيفضح إنه آلة.
// بنحسب المدة هنا وبنبعتها للواجهة في حقل typingDelay، والواجهة هي اللي تستنى —
// عشان منستهلكش وقت تنفيذ الـ Worker (ده بيتحاسب عليه في فاتورة Cloudflare).
const TYPING_MIN_MS = 400;
const TYPING_MAX_MS = 900;
function typingDelayFor(text) {
  const len = String(text||"").length;
  if (!len) return 0;
  // خريطة خطية: رد قصير (~40 حرف) ≈ الحد الأدنى، رد طويل (~400 حرف) ≈ الحد الأقصى
  const span = TYPING_MAX_MS - TYPING_MIN_MS;
  const ratio = Math.min(1, Math.max(0, (len - 40) / 360));
  const base = TYPING_MIN_MS + Math.round(span * ratio);
  // ±12% عشوائية عشان المدة متبقاش منتظمة بشكل ملحوظ
  const jitter = Math.round(base * (Math.random() * 0.24 - 0.12));
  return Math.max(TYPING_MIN_MS, Math.min(TYPING_MAX_MS, base + jitter));
}

// بيضيف حقل typingDelay لأي رد فيه نص للعميل
// الحقل اختياري تمامًا: أي نسخة قديمة من الواجهة هتتجاهله ببساطة
function withTypingDelay(obj) {
  if (obj && typeof obj === "object" && typeof obj.response === "string" && obj.response) {
    return { ...obj, typingDelay: typingDelayFor(obj.response) };
  }
  return obj;
}

// ختم نسخة النموذج على أي formState راجع للواجهة.
// السبب: الواجهة كانت بتبعت _version قديم، والسيرفر كان بيرجّع الحالة
// من غير _version خالص، فالجلسة كانت بتتلغي عشوائيًا في نص المسار.
// دلوقتي كل رد بيحمل النسخة الصح، فالواجهة تفضل متزامنة تلقائيًا.
function stampVersion(obj) {
  if (obj && typeof obj === "object" && obj.formState && typeof obj.formState === "object") {
    return { ...obj, formState: { ...obj.formState, _version: FORM_VERSION } };
  }
  return obj;
}

const jsonResWith = (cors, obj, s=200) =>
  new Response(JSON.stringify(obj), {status:s, headers:{...cors, "Content-Type":"application/json; charset=utf-8"}});

// ══════════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // الـ CORS بقى متوقّف على الـ Origin، فبنحسبه مرة واحدة لكل طلب
    const cors = corsHeaders(request, env);
    // كل الردود بتعدي من هنا، فبنضيف typingDelay في مكان واحد بدل 20 موضع
    const jsonRes = (obj, s=200) => jsonResWith(cors, stampVersion(withTypingDelay(obj)), s);
    // معرّف قصير للطلب عشان نقدر نربط اللوجات ببعض وقت التشخيص
    const reqId = Math.random().toString(36).slice(2, 10);
    const ip = request.headers.get("CF-Connecting-IP")||"unknown";

    // preflight الأول — لازم يرد قبل أي فحص تاني
    if (request.method==="OPTIONS") return new Response(null,{status:204,headers:cors});

    // رفض أي حمولة أكبر من الحد قبل ما نقراها أصلاً
    const declaredLen = Number(request.headers.get("Content-Length")||0);
    if (declaredLen > MAX_BODY_BYTES) return jsonRes({error:"Payload too large"},413);

    // ── مسار رفع الصور ──
    if (url.pathname==="/upload-images" && request.method==="POST") {
      // حد أقل للرفع: العملية دي بتستهلك مفتاح ImgBB وبتكلف وقت
      if (uploadRateLimited(ip)) return jsonRes({error:"Too many uploads, slow down"},429);
      try {
        const body = await request.json().catch(()=>null);
        if (!body || typeof body !== "object") return jsonRes({error:"Invalid JSON"},400);
        const r = await uploadImgBB(env, body.images||[]);
        if (!r.ok) return jsonRes({error:r.error},400);
        return jsonRes({urls:r.urls});
      } catch (err) {
        console.error(`[${reqId}][upload] ${err?.message}`);
        return jsonRes({error:"Upload failed"},500);
      }
    }

    if (request.method!=="POST") return jsonRes({error:"Method not allowed"},405);

    if (rateLimited(ip)) return jsonRes({response:"استنى شوية، بتبعت رسايل كتير.",options:ROUTE_BTNS},429);

    try {
      const body = await request.json().catch(()=>null);
      if (!body || typeof body !== "object") return jsonRes({response:"طلب غير صالح.",options:ROUTE_BTNS},400);

      // قصّ رسالة المستخدم — يمنع استهلاك توكنز/CPU برسالة ضخمة
      const userMsg = String(body.message||"").trim().slice(0, MAX_MSG_LEN);
      let fs = sanitizeState(body.formState && typeof body.formState === "object" ? body.formState : {});
      // السجل بيتفلتر ويتقص: بنقبل بس العناصر اللي شكلها صح
      const history = (Array.isArray(body.history)?body.history:[])
        .filter(m => m && typeof m === "object" && typeof m.message === "string")
        .slice(-MAX_HISTORY);
      // روابط الصور لازم تكون https فعلاً — منع حقن روابط خبيثة في رسالة الواتساب
      const incomingImgs = (Array.isArray(body.imageUrls)?body.imageUrls:[])
        .filter(u => typeof u === "string" && /^https:\/\/[^\s<>"']+$/.test(u))
        .slice(0, MAX_IMAGES);

      if (incomingImgs.length && fs?.active) {
        fs.imageUrls = [...(fs.imageUrls||[]),...incomingImgs].slice(0,MAX_IMAGES);
      }

      // GPS من منتقي الخريطة — بيتربط بالطلب الحالي فقط (ذاكرة الجلسة، بدون تخزين)
      const incomingGps = sanitizeGps(body.gps);
      if (incomingGps && fs?.active) {
        fs.data = { ...(fs.data||{}), gps: incomingGps };
      }

      // ── رد حتمي على أسئلة الهوية أو طلب إنسان (P0.1) ──
      // بيتحسم من غير Gemini وقبل أي مسار تاني — عشان الوكيل يعترف بالأتمتة
      // ويقدّم رابط طارق بدل ما ينتحل شخصيته أو ينفي بشريته. الحالة بتفضل زي ما هي عشان يكمل طلبه.
      if (isIdentityQ(userMsg)) {
        return jsonRes({
          response: IDENTITY_RESPONSE,
          formState: fs,
          options: ROUTE_BTNS,
          done: false, readyToSend: false, canShareWhatsapp: false,
          imageUrls: fs.imageUrls || [],
        });
      }

      const flowType = fs.flowType||"";
      const hasFlow = fs.active===true && flowType!=="";

      // Market questions are answered from D1 before Gemini so no model can invent prices.
      // Returning the unchanged formState preserves an in-progress qualified chat flow.
      if (userMsg && isMarketQuestion(userMsg) && !isOwnerSaleIntent(userMsg)) {
        const marketReply = await answerMarketQuestion(env, userMsg, fs);
        const controls = await controlsForExistingFlow(fs);
        const response = {
          response: marketReply.response,
          formState: fs,
          imageUrls: fs.imageUrls || [],
          ...controls,
        };
        if (marketReply.valuationCta) response.valuationCta = marketReply.valuationCta;
        return jsonRes(response);
      }

      if (!env?.GEMINI_API_KEY) {
        console.error(`[${reqId}] GEMINI_API_KEY missing`);
        return jsonRes({response:"حصل خطأ مؤقت.",options:ROUTE_BTNS},500);
      }

      if (!hasFlow || flowType==="route_selection") {

        if (isBuy(userMsg)) {
          const lms = await fetchLandmarks({transaction:"sale"});
          const steps = getBuyerSteps("sale");
          const newFs = {active:true,lifecycle:LC.ACTIVE,type:"sale",stepIndex:0,data:{},awaitingQ:true,flowType:"buyer",imageUrls:[]};
          const r = askBuyerStep(steps,0,newFs,null,lms);
          return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
        }
        if (isTenant(userMsg)) {
          const lms = await fetchLandmarks({transaction:"rent"});
          const steps = getBuyerSteps("rent");
          const newFs = {active:true,lifecycle:LC.ACTIVE,type:"rent",stepIndex:0,data:{},awaitingQ:true,flowType:"tenant",imageUrls:[]};
          const r = askBuyerStep(steps,0,newFs,null,lms);
          return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
        }
        if (isSell(userMsg)) {
          const lms = await fetchLandmarks({transaction:"sale"});
          return jsonRes(await startOwnerFlow("sale", userMsg, env, history, lms));
        }
        if (isLandlord(userMsg)) {
          const lms = await fetchLandmarks({transaction:"rent"});
          return jsonRes(await startOwnerFlow("rent", userMsg, env, history, lms));
        }

        if (!userMsg) return jsonRes(newRequest());

        const route = detectRoute(userMsg);
        if (route) {
          const isBuyer = route.startsWith("buyer");
          const type = route.endsWith("rent")?"rent":"sale";
          const lms = await fetchLandmarks({transaction:type});
          if (isBuyer) {
            const steps = getBuyerSteps(type);
            const newFs = {active:true,lifecycle:LC.ACTIVE,type,stepIndex:0,data:{},awaitingQ:true,flowType:type==="sale"?"buyer":"tenant",imageUrls:[]};
            const r = askBuyerStep(steps,0,newFs,null,lms);
            return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
          } else {
            return jsonRes(await startOwnerFlow(type, userMsg, env, history, lms));
          }
        }

        if (isOfficeQ(userMsg)) return jsonRes({response:officeMsg(),options:ROUTE_BTNS,formState:fs});
        if (/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(userMsg)) return jsonRes({response:`سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`,options:ROUTE_BTNS,formState:fs});
        const canned = matchInterrupt(userMsg);
        if (canned) return jsonRes({response:canned,options:ROUTE_BTNS,formState:fs});
        if (isOutOfArea(userMsg)&&!isNasr(userMsg)) return jsonRes({response:"إحنا بنشتغل في مدينة نصر بس يا فندم.",options:ROUTE_BTNS,formState:fs});
        if (/سيارة|عربية|موبايل|أجهزة|ساعة/i.test(userMsg)) return jsonRes({response:"بنشتغل في العقارات بس يا فندم.",options:ROUTE_BTNS,formState:fs});

        const reply = await geminiFirstMsg(env, userMsg, history);
        if (reply) return jsonRes({response:reply,options:ROUTE_BTNS,formState:fs});
        return jsonRes(newRequest());
      }

      if (isOfficeQ(userMsg)) return jsonRes({response:officeMsg(),options:ROUTE_BTNS,formState:fs});
      if (/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(userMsg)) return jsonRes({response:`سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`,options:ROUTE_BTNS,formState:fs});
      const cannedMid = matchInterrupt(userMsg);
      if (cannedMid) return jsonRes({response:cannedMid,options:ROUTE_BTNS,formState:fs});

      if (flowType==="owner") {
        const lms = await fetchLandmarks({transaction:fs.type});
        const step = getOwnerSteps(fs.type)[fs.stepIndex];
        // إجابة يدوية على خطوة الموقع (بدون gps في نفس الطلب) → أي إحداثيات قديمة بتتشال (لا pin كاذب)
        if (step?.id==="location" && !incomingGps && fs.data?.gps) { fs.data = {...fs.data}; delete fs.data.gps; }
        const r = await processOwner(fs,userMsg,env,history,lms);
        const enhanced = await enhanceResponse(env,r,userMsg,fs,step,history);
        if (!r.done && !r.readyToSend) {
          const ownerData = r.formState?.data || fs.data || {};
          let marketArea = ownerData.marketArea || null;
          if (!marketArea && ownerData.location) {
            try { marketArea = findAreaMention(ownerData.location, await listMarketAreas(env?.DB)); } catch {}
          }
          enhanced.valuationCta = valuationCta(fs.type === "sale" ? "seller" : "valuation", {
            areaName: marketArea,
            size: ownerData.area,
            propertyType: ownerData.propertyType,
            areaType: fs.type,
          });
        }
        return jsonRes(enhanced);
      }

      if (flowType==="buyer"||flowType==="tenant") {
        const lms = await fetchLandmarks({transaction:fs.type,propertyType:fs.data?.propertyType});
        const step = getBuyerSteps(fs.type)[fs.stepIndex];
        if (step?.id==="landmark" && !incomingGps && fs.data?.gps) { fs.data = {...fs.data}; delete fs.data.gps; }
        const r = await processBuyer(fs,userMsg,env,history,lms);
        return jsonRes(await enhanceResponse(env,r,userMsg,fs,step,history));
      }

      if (flowType==="buyer_select") return jsonRes(await processBuyerSelect(fs,userMsg,env));
      if (flowType==="buyer_selected_property") return jsonRes(await processBuyerSelectedProp(fs,userMsg,env));
      if (flowType.startsWith("owner_completed")||flowType==="buyer_completed") return jsonRes(await processPostComplete(fs,userMsg,env));

      const step = getSteps(fs.type,flowType)[fs.stepIndex];
      if (step) {
        const reply = await geminiContextual(env,userMsg,fs,step,history);
        if (reply) return jsonRes({response:reply,formState:fs,options:ROUTE_BTNS});
      }

      return jsonRes({response:"أهلاً بيك. اختار طلبك:",options:ROUTE_BTNS,formState:fs});

    } catch(err) {
      // لوج فيه معرّف الطلب للتشخيص — من غير ما نسرّب التفاصيل للعميل
      console.error(`[${reqId}][ERROR]`, err?.message, err?.stack);
      return jsonRes({response:"حصلت مشكلة مؤقتة، جرّب تاني.",options:ROUTE_BTNS},500);
    }
  }
};
// ═══════════════════════════════════════════════════
// نهاية الملف — سمسار طلبك v8.5-MAPS + D1 MARKET (منتقي الخريطة: ui:"map_picker" + gps في رسالة الواتساب)
// ✅ Gemini للردود الحوارية + أسعار D1 حتمية + رسالة مؤهلة كاملة
// ═══════════════════════════════════════════════════
