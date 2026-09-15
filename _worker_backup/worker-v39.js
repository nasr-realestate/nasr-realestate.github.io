/* eslint-disable */
// @ts-nocheck
/**
 * Worker: Semsar Talabak - Tarek Tantawy
 * V39 FINAL — النسخة الاحترافية النهائية للنشر
 * ============================================================
 * آخر تحديثات:
 *   • إصلاح detectIntentRegex (RENT_OWN بيمسك "شقة للإيجار")
 *   • إصلاح isLikelyQuestion (Gemini يرد جوه الفورم)
 *   • تمرير history في tryHandleInterrupt (السياق محفوظ)
 *   • مسارات منطقية لكل نوع عقار
 *   • أرقام لاتينية في كل الرسائل
 *   • مسار رفع الصور كامل
 * ============================================================
 */

const ALAA_PHONE = "+201022171667";
const OFFICE_ADDRESS = "16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر";
const OFFICE_MAP_URL = "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7";
const OFFICE_HOURS = "من 12 الضهر لحد 9 بالليل، ما عدا الجمعة";
const AI_FEED_URL = "https://nasr-realestate.github.io/ai-feed.json";
const AREAS_URL = "https://nasr-realestate.github.io/nasr-city.json";
const CACHE_TTL_MS = 5 * 60 * 1000;
const AREAS_CACHE_TTL_MS = 60 * 60 * 1000;
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const BTN_BUY = "🔍 أشتري";
const BTN_TENANT = "🏠 أستأجر";
const BTN_SELL = "💰 أبيع";
const BTN_LANDLORD = "🔑 أأجر";

const BTN_SKIP = "تخطي السؤال ⏭";
const BTN_SEND = "ابعت البيانات دلوقتي ✅";
const BTN_CANCEL = "إلغاء التسجيل ✕";
const BTN_BACK = "⬅️ رجوع";
const BTN_CANCEL_BACK = "إلغاء الرجوع";
const BTN_ANY_AREA = "أي منطقة في مدينة نصر";

const BTN_ATTACH_IMAGES = "📷 أرفق صور";
const BTN_SKIP_IMAGES = "⏭ تخطي (بدون صور)";
const BTN_ADD_IMAGES = "📷 إضافة صور";
const BTN_DELETE_IMAGES = "🗑️ احذف الكل";
const BTN_IMAGES_DONE = "✅ تمام، كمّل";

const BTN_SEND_WA = "✅ ابعت على واتساب";
const BTN_EDIT = "⬅️ عدّل حاجة";
const BTN_NEW_REQUEST = "🆕 طلب جديد";
const POST_COMPLETE_BUTTONS = [BTN_SEND_WA, BTN_EDIT, BTN_NEW_REQUEST];

const MIN_SCORE_THRESHOLD = 25;
const REQUIRED_IDS = ["propertyType", "location", "price", "ownerPhone"];
const MAX_IMAGES_PER_PROPERTY = 5;

const OUT_OF_COVERAGE_PATTERN = /فيصل|الهرم|أكتوبر|اكتوبر|المعادي|الشيخ زايد|الشروق|بدر|حدائق الأهرام|شبرا|المهندسين|الزمالك|العاصمة|التجمع|مصر الجديدة|مدينتي|الرحاب|6 أكتوبر|المقطم|حلوان|طرة|السيدة زينب|وسط البلد|شبرا الخيمة|المرج|عين شمس|المطرية|الزيتون|حلمية الزيتون|حدائق القبة|الوايلي|العباسية|غمرة|التحرير|جاردن سيتي|المنيل|الروضة|القلعة|مدينة السلام|النهضة|الأميرية|الشرابية|روض الفرج|بولاق|الظاهر|الجمالية|الدرب الأحمر|الخليفة|مصر القديمة|الفسطاط|الرمل|الأزاريطة|محرم بك|سموحة|سيدي جابر|العجمي|المنتزه|البيطاش|الهانوفيل/i;

const NASR_CITY_PATTERN = /مدينة نصر|مدينه نصر|نصر|الحي|المنطقة|مكرم عبيد|عباس العقاد|حسن المأمون|مصطفى النحاس|المقريفي|النزهة|الطيران|السفارات|حديقة الطفل|الرقابة الإدارية|الأهلي|الاستاد|الجامعة|شينزو آبي|سونستا|طيبة|الحياة|صن رايز|لا فيدا|جاردينيا|الواحة|truegate|true gate/i;

const KNOWN_LANDMARKS = [
  "المنطقة السادسة", "المنطقة السابعة", "المنطقة الثامنة", "المنطقة التاسعة",
  "المنطقة العاشرة", "المنطقة الحادية عشر", "الحي الأول", "الحي الثاني",
  "الحي السابع", "الحي العاشر", "مكرم عبيد", "عباس العقاد", "حسن المأمون",
  "مصطفى النحاس", "المقريفي", "النزهة", "الطيران", "السفارات", "حديقة الطفل",
  "الرقابة الإدارية", "الأهلي", "الاستاد", "الجامعة"
];

// ═════════════════════════════════════════════════════════
// 🔒 Rate Limiting
// ═════════════════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 30 * 1000;
const RATE_MAX_MSGS = 15;

function isRateLimited(ip) {
  const now = Date.now();
  const arr = rateLimitMap.get(ip) || [];
  const fresh = arr.filter(t => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX_MSGS) return true;
  fresh.push(now);
  rateLimitMap.set(ip, fresh);
  return false;
}

// ═════════════════════════════════════════════════════════
// 🧠 Intents & Lifecycle
// ═════════════════════════════════════════════════════════
const INTENTS = {
  SELL_OWN: "sell_own",
  RENT_OWN: "rent_own",
  BUY: "buy",
  RENT: "rent",
  INFO: "info",
  STUDENT_HOUSING: "student",
  OTHER: "other"
};

const LIFECYCLE = {
  ACTIVE: "active",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  ARCHIVED: "archived"
};

// ═════════════════════════════════════════════════════════
// 🏠 Property Type Helpers
// ═════════════════════════════════════════════════════════
function isResidentialType(pt) {
  return pt === "شقة" || pt === "فيلا";
}
function isCommercialType(pt) {
  return pt === "محل تجاري" || pt === "مكتب إداري" || pt === "مخزن";
}
function isShop(pt) { return pt === "محل تجاري"; }
function isOffice(pt) { return pt === "مكتب إداري"; }
function isWarehouse(pt) { return pt === "مخزن"; }

// ═════════════════════════════════════════════════════════
// 🔢 V39 FINAL: تحويل الأرقام العربية للاتينية
// ═════════════════════════════════════════════════════════
function toEnglishDigits(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "0";
  const n = parseNumeric(value);
  if (!n) return "0";
  return toEnglishDigits(n.toLocaleString("en-US"));
}

function formatValue(value) {
  if (!hasValue(value)) return "—";
  return toEnglishDigits(String(value).trim());
}

// ═════════════════════════════════════════════════════════
// 🏠 Steps — SALE (المالك)
// ═════════════════════════════════════════════════════════
const PROPERTY_TYPE_OPTIONS = ["شقة", "مكتب إداري", "محل تجاري", "مخزن"];

const SALE_STEPS = [
  { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: PROPERTY_TYPE_OPTIONS },
  { id: "location", q: (d) => `ال${d.propertyType || "عقار"} فين في مدينة نصر؟ (الشارع - المنطقة)`, type: "text" },
  { id: "area", q: "المساحة كام متر؟", type: "text" },

  // محل تجاري
  { id: "businessType", q: "المحل نشاطه الحالي إيه؟", type: "text",
    condition: (d) => isShop(d.propertyType) },
  { id: "previousActivity", q: "قبله كان نشاط إيه؟ (اكتب اسم النشاط)", type: "text",
    condition: (d) => isShop(d.propertyType) },
  { id: "frontage", q: "الواجهة على إيه؟", type: "buttons",
    options: ["شارع رئيسي", "شارع جانبي", "داخل مول", "متفرع"],
    condition: (d) => isShop(d.propertyType) },

  // مكتب إداري
  { id: "businessType", q: "نشاط المكتب إيه؟", type: "text",
    condition: (d) => isOffice(d.propertyType) },
  { id: "officesCount", q: "كام مكتب في المكان؟", type: "buttons",
    options: ["1", "2", "3", "4", "5+"],
    condition: (d) => isOffice(d.propertyType) },
  { id: "floor", q: "المكتب في الدور الكام؟", type: "buttons",
    options: ["أرضي", "أول", "ثاني", "ثالث", "رابع", "خامس+"],
    condition: (d) => isOffice(d.propertyType) },

  // مخزن
  { id: "storageType", q: "نوع التخزين إيه؟", type: "buttons",
    options: ["أغذية", "ملابس", "إلكترونيات", "مستلزمات طبية", "عام"],
    condition: (d) => isWarehouse(d.propertyType) },

  // شقة/فيلا
  { id: "rooms", q: "عدد الغرف؟", type: "buttons",
    options: ["2", "3", "4", "5+"],
    condition: (d) => isResidentialType(d.propertyType) },
  { id: "baths", q: "عدد الحمامات؟", type: "buttons",
    options: ["1", "2", "3+"],
    condition: (d) => isResidentialType(d.propertyType) },
  { id: "floor", q: "الدور؟", type: "buttons",
    options: ["أرضي", "أول", "ثاني", "متكرر", "أخير", "بدروم"],
    condition: (d) => isResidentialType(d.propertyType) },

  { id: "price", q: "طالب فيه كام؟", type: "text" },

  { id: "finishing", q: "حالة التشطيب؟", type: "buttons",
    options: ["سوبر لوكس", "نصف تشطيب", "تحتاج تجديد", "طوب أحمر"],
    condition: (d) => !isWarehouse(d.propertyType) },

  { id: "ownerName", q: "اسمك الثلاثي؟", type: "text" },
  { id: "ownerPhone", q: "رقم الواتساب؟ (11 رقم يبدأ بـ01)", type: "text",
    validate: /^01[0-9]{9}$/, err: "الرقم مش صح (11 رقم يبدأ بـ01)" },

  { id: "images", q: "📷 صور العقار (اختياري بس بتفرق كتير مع المشترين)", type: "images_step" },

  { id: "notes", q: "تفاصيل إضافية؟ (تخطي لو مفيش)", type: "text" }
];

// ═════════════════════════════════════════════════════════
// 🏠 Steps — RENT OWN (المالك المؤجر)
// ═════════════════════════════════════════════════════════
const RENT_OWN_STEPS = [
  { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: PROPERTY_TYPE_OPTIONS },
  { id: "location", q: (d) => `ال${d.propertyType || "عقار"} فين في مدينة نصر؟ (الشارع - المنطقة)`, type: "text" },
  { id: "area", q: "المساحة كام متر؟", type: "text" },

  { id: "businessType", q: "المحل نشاطه الحالي إيه؟", type: "text",
    condition: (d) => isShop(d.propertyType) },
  { id: "previousActivity", q: "قبله كان نشاط إيه؟", type: "text",
    condition: (d) => isShop(d.propertyType) },
  { id: "frontage", q: "الواجهة على إيه؟", type: "buttons",
    options: ["شارع رئيسي", "شارع جانبي", "داخل مول", "متفرع"],
    condition: (d) => isShop(d.propertyType) },

  { id: "businessType", q: "نشاط المكتب إيه؟", type: "text",
    condition: (d) => isOffice(d.propertyType) },
  { id: "officesCount", q: "كام مكتب في المكان؟", type: "buttons",
    options: ["1", "2", "3", "4", "5+"],
    condition: (d) => isOffice(d.propertyType) },
  { id: "floor", q: "المكتب في الدور الكام؟", type: "buttons",
    options: ["أرضي", "أول", "ثاني", "ثالث", "رابع", "خامس+"],
    condition: (d) => isOffice(d.propertyType) },

  { id: "storageType", q: "نوع التخزين إيه؟", type: "buttons",
    options: ["أغذية", "ملابس", "إلكترونيات", "مستلزمات طبية", "عام"],
    condition: (d) => isWarehouse(d.propertyType) },

  { id: "furnished", q: "الإيجار مفروش ولا فاضي (قانون جديد)؟", type: "buttons",
    options: ["مفروش", "فاضي (قانون جديد)"],
    condition: (d) => isResidentialType(d.propertyType) },

  { id: "rentPeriods", q: "المدة المتاحة للإيجار؟", type: "buttons",
    options: ["أسبوعي", "شهري", "سنوي"],
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" },
  { id: "priceWeekly", q: "سعر الإيجار الأسبوعي كام؟", type: "text",
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" && d.rentPeriods === "أسبوعي" },
  { id: "priceMonthly", q: "سعر الإيجار الشهري كام؟", type: "text",
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" && (d.rentPeriods === "شهري" || d.rentPeriods === "سنوي") },
  { id: "priceYearly", q: "سعر الإيجار السنوي كام؟", type: "text",
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" && d.rentPeriods === "سنوي" },
  { id: "furnitureQuality", q: "جودة الأثاث؟", type: "buttons",
    options: ["سوبر لوكس", "كويسة", "متوسطة"],
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" },

  { id: "duration", q: "مدة العقد المطلوبة؟", type: "buttons",
    options: ["سنة", "سنتين", "3 سنين", "4 سنين", "5 سنين"],
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "فاضي (قانون جديد)" },
  { id: "price", q: "الإيجار الشهري كام؟", type: "text",
    condition: (d) => isResidentialType(d.propertyType) && d.furnished === "فاضي (قانون جديد)" },

  { id: "price", q: "الإيجار الشهري كام؟", type: "text",
    condition: (d) => isCommercialType(d.propertyType) },

  { id: "rooms", q: "عدد الغرف؟", type: "buttons",
    options: ["2", "3", "4", "5+"],
    condition: (d) => isResidentialType(d.propertyType) },
  { id: "baths", q: "عدد الحمامات؟", type: "buttons",
    options: ["1", "2", "3+"],
    condition: (d) => isResidentialType(d.propertyType) },
  { id: "floor", q: "الدور؟", type: "buttons",
    options: ["أرضي", "أول", "ثاني", "متكرر", "أخير", "بدروم"],
    condition: (d) => isResidentialType(d.propertyType) },

  { id: "finishing", q: "حالة التشطيب؟", type: "buttons",
    options: ["سوبر لوكس", "نصف تشطيب", "تحتاج تجديد"],
    condition: (d) => !isWarehouse(d.propertyType) },

  { id: "ownerName", q: "اسمك الثلاثي؟", type: "text" },
  { id: "ownerPhone", q: "رقم الواتساب؟ (11 رقم يبدأ بـ01)", type: "text",
    validate: /^01[0-9]{9}$/, err: "الرقم مش صح (11 رقم يبدأ بـ01)" },

  { id: "images", q: "📷 صور العقار (اختياري بس بتفرق كتير مع المستأجرين)", type: "images_step" },

  { id: "notes", q: "تفاصيل إضافية؟ (تخطي لو مفيش)", type: "text" }
];

// ═════════════════════════════════════════════════════════
// 🏠 Steps — BUYER / TENANT
// ═════════════════════════════════════════════════════════
function getBuyerSteps(transaction) {
  const isSale = transaction === "sale";
  const typeOptions = isSale
    ? ["شقة", "مكتب إداري", "محل تجاري", "مخزن", "فيلا"]
    : ["شقة", "مكتب إداري", "محل تجاري", "مخزن"];

  const steps = [
    { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: typeOptions },
    { id: "landmark", q: "المنطقة في مدينة نصر؟", type: "dynamic_buttons", dynamicSource: "landmarks" }
  ];

  if (!isSale) {
    steps.push(
      { id: "furnished", q: "الإيجار مفروش ولا فاضي (قانون جديد)؟", type: "buttons",
        options: ["مفروش", "فاضي (قانون جديد)"],
        condition: (d) => isResidentialType(d.propertyType) },
      { id: "rentPeriods", q: "المدة المفضلة؟", type: "buttons",
        options: ["أسبوعي", "شهري", "سنوي"],
        condition: (d) => isResidentialType(d.propertyType) && d.furnished === "مفروش" },
      { id: "duration", q: "مدة العقد المفضلة؟", type: "buttons",
        options: ["سنة", "سنتين", "3 سنين", "4 سنين", "5 سنين"],
        condition: (d) => isResidentialType(d.propertyType) && d.furnished === "فاضي (قانون جديد)" }
    );
  }

  steps.push(
    { id: "businessActivity", q: "هتفتح نشاط إيه؟", type: "text",
      condition: (d) => isShop(d.propertyType) },
    { id: "frontagePref", q: "الواجهة المفضلة؟", type: "buttons",
      options: ["شارع رئيسي", "شارع جانبي", "داخل مول", "مش فارقة"],
      condition: (d) => isShop(d.propertyType) }
  );

  steps.push(
    { id: "businessType", q: "نشاط المكتب إيه؟", type: "text",
      condition: (d) => isOffice(d.propertyType) },
    { id: "officesCount", q: "محتاج كام مكتب؟", type: "buttons",
      options: ["1", "2", "3", "4", "5+"],
      condition: (d) => isOffice(d.propertyType) }
  );

  steps.push(
    { id: "storageType", q: "نوع التخزين إيه؟", type: "buttons",
      options: ["أغذية", "ملابس", "إلكترونيات", "مستلزمات طبية", "عام"],
      condition: (d) => isWarehouse(d.propertyType) }
  );

  steps.push(
    { id: "budget", q: (d) => {
        if (isCommercialType(d.propertyType)) {
          return isSale ? "الميزانية كام؟" : "الإيجار الشهري في حدود كام؟";
        }
        return isSale ? "الميزانية كام؟" : "الميزانية الشهرية كام؟";
      }, type: "text" }
  );

  steps.push(
    { id: "rooms", q: "عدد الغرف؟", type: "buttons",
      options: ["2", "3", "4", "5+"],
      condition: (d) => isResidentialType(d.propertyType) }
  );

  steps.push(
    { id: "urgency", q: (d) => {
        if (isShop(d.propertyType)) return isSale ? "هتشتري المحل امتى؟" : "هتفتح المحل امتى؟";
        if (isOffice(d.propertyType)) return isSale ? "هتشتري المكتب امتى؟" : "هتبدأ الشغل في المكتب امتى؟";
        if (isWarehouse(d.propertyType)) return isSale ? "هتشتري المخزن امتى؟" : "هتبدأ تستخدم المخزن امتى؟";
        return isSale ? "هتشتري امتى؟" : "هتسكن امتى؟";
      },
      type: "buttons",
      options: ["بأسرع وقت", "خلال شهر", "خلال 3 شهور", "بستكشف"] }
  );

  steps.push(
    { id: "phone", q: "رقمك كام؟ (11 رقم يبدأ بـ01)", type: "text",
      validate: /^01[0-9]{9}$/, err: "الرقم مش صح" }
  );

  return steps;
}

// ═════════════════════════════════════════════════════════
// 🏷️ Field Labels
// ═════════════════════════════════════════════════════════
function getFieldLabel(stepId) {
  const labels = {
    propertyType: "نوع العقار", location: "الموقع", landmark: "المنطقة",
    area: "المساحة", price: "السعر",
    priceWeekly: "الإيجار الأسبوعي", priceMonthly: "الإيجار الشهري",
    priceYearly: "الإيجار السنوي",
    budget: "الميزانية", rooms: "عدد الغرف", baths: "الحمامات",
    floor: "الدور", finishing: "التشطيب", furnished: "نوع الإيجار",
    furnitureQuality: "جودة الأثاث", duration: "مدة العقد",
    rentPeriods: "المدة", urgency: "الموعد",
    ownerName: "الاسم", ownerPhone: "الرقم", phone: "الرقم",
    notes: "ملاحظات",
    businessType: "النشاط", frontage: "الواجهة",
    businessActivity: "النشاط المطلوب", frontagePref: "الواجهة المفضلة",
    previousActivity: "النشاط السابق",
    officesCount: "عدد المكاتب", storageType: "نوع التخزين",
    images: "الصور"
  };
  return labels[stepId] || stepId;
}

function resolveQuestion(step, data) {
  return typeof step.q === "function" ? step.q(data) : step.q;
}

// ═════════════════════════════════════════════════════════
// 🏢 Office Query
// ═════════════════════════════════════════════════════════
function isOfficeQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const t = raw
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "").replace(/[؟?.,!]/g, "")
    .replace(/\s+/g, " ").toLowerCase().trim();

  const patterns = [
    /^هو مكتبكم فين$/, /^هو المكتب فين$/, /^مكتبكم فين$/, /^المكتب فين$/,
    /^فين المكتب$/, /^فين مكتبكم$/, /^عنوان المكتب ايه$/, /^عنوانكم ايه$/,
    /^عنوانكم فين$/, /^العنوان ايه$/, /^العنوان فين$/, /^نيجي ازاي$/,
    /^ازاي اجي المكتب$/, /^عنوانك ايه$/, /^عنوانك فين$/
  ];
  return patterns.some(p => p.test(t));
}

function buildOfficeMessage() {
  return `📌 عنوان المكتب: ${OFFICE_ADDRESS}\n\n` +
         `🗺️ اللوكيشن على الخريطة: ${OFFICE_MAP_URL}\n\n` +
         `⏰ المواعيد: ${OFFICE_HOURS}\n\n` +
         `📝 ملحوظة: إحنا أغلب الوقت في الشارع معاينات. ` +
         `فالأفضل تكلمنا الأول على الواتساب قبل ما تجي المكتب.`;
}

// ═════════════════════════════════════════════════════════
// 🗺️ Areas
// ═════════════════════════════════════════════════════════
let areasCache = { data: null, timestamp: 0 };

async function fetchAreasData() {
  const now = Date.now();
  if (areasCache.data && now - areasCache.timestamp < AREAS_CACHE_TTL_MS) return areasCache.data;
  try {
    const res = await fetch(AREAS_URL, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new Error("Areas fetch failed");
    const data = await res.json();
    areasCache = { data, timestamp: now };
    return data;
  } catch (e) {
    return areasCache.data || { areas: [], city_avg: {} };
  }
}

function findArea(areasData, query) {
  if (!areasData || !areasData.areas || !query) return null;
  const q = normalizeAr(query);
  if (!q) return null;

  for (const a of areasData.areas) {
    if (normalizeAr(a.name) === q) return a;
  }
  for (const a of areasData.areas) {
    const an = normalizeAr(a.name);
    if (an.includes(q) || q.includes(an)) return a;
  }
  for (const a of areasData.areas) {
    for (const s of (a.main_streets || [])) {
      const sn = normalizeAr(s);
      if (sn.includes(q) || q.includes(sn)) return a;
    }
  }
  return null;
}

function isPriceQuery(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /سعر\s*المتر|المتر\s*بكام|بكام\s*المتر|متر\s*بكام|كيلو\s*المتر|المتر\s*بيعمل|بيعمل\s*كام|المتر\s*كام/i.test(t);
}

async function buildPriceResponse(userMessage) {
  const areasData = await fetchAreasData();
  const foundArea = findArea(areasData, userMessage);

  if (foundArea) {
    const sale = foundArea.sale?.apartment_per_meter_avg;
    const rentU = foundArea.rent?.unfurnished_per_meter_avg;
    const rentF = foundArea.rent?.furnished_per_meter_avg;

    const lines = [`📊 أسعار المتر في ${foundArea.name}:`];
    if (sale) lines.push(`💰 بيع (شقق): ${formatNumber(sale)} ج.م/م²`);
    if (rentU) lines.push(`🏠 إيجار فاضي: ${formatNumber(rentU)} ج.م/م²/شهر`);
    if (rentF) lines.push(`🛋️ إيجار مفروش: ${formatNumber(rentF)} ج.م/م²/شهر`);
    lines.push(`\n📝 الأسعار تقديرية من السوق.`);
    return lines.join("\n");
  }

  const avg = areasData.city_avg || {};
  const lines = [`📊 متوسط أسعار المتر في مدينة نصر:`];
  if (avg.sale_apartment_per_meter) lines.push(`💰 بيع (شقق): ${formatNumber(avg.sale_apartment_per_meter)} ج.م/م²`);
  if (avg.rent_unfurnished_per_meter) lines.push(`🏠 إيجار فاضي: ${formatNumber(avg.rent_unfurnished_per_meter)} ج.م/م²/شهر`);
  if (avg.rent_furnished_per_meter) lines.push(`🛋️ إيجار مفروش: ${formatNumber(avg.rent_furnished_per_meter)} ج.م/م²/شهر`);
  lines.push(`\nقولّي المنطقة عشان أديك سعرها بالظبط.`);
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════
// 💬 Canned Rules
// ═════════════════════════════════════════════════════════
const INTERRUPT_RULES = [
  { test: /عمول|السعي|سعيكم|نسبتكم|بتاخد(?:وا|و)?\s*كام|هتاخد كام|مصاريف|سمسرة|سمسره/i,
    answer: "العمولة 2.5% من قيمة البيع، بتتحدد بعد المعاينة والتقييم. مفيش حاجة مخبية." },
  { test: /^اسمك ايه|^اسمك إيه|حضرتك اسمك|^انت مين|^أنت مين|مين حضرتك/i,
    answer: "أنا طارق طنطاوي، سمسار مدينة نصر من 2014." },
  { test: /مستعجلين|بتضغطوا|هتبيعوني بسرعة/i,
    answer: "مش مستعجلين على حساب حقك. بنختار المشتري الجد بس." },
  { test: /بتشتغلوا ازاي|طريقة العمل|بتاخدوا العقار إزاي/i,
    answer: "معاينة، تقييم، تصوير، تسويق، وبعدين بوصلك العميل الجاد." },
  { test: /طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i,
    answer: `سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}` },
  { test: /ضمان|تأمينكم|هتنصب|بتاخدوا مقدم/i,
    answer: "شغلنا بالعقد الواضح. مفيش فلوس بتتحرك قبل الاتفاق." }
];

// ═════════════════════════════════════════════════════════
// 🛠️ Helpers
// ═════════════════════════════════════════════════════════
function logEvent(type, data) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${type}]`, JSON.stringify(data));
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...getCorsHeaders(), "Content-Type": "application/json" }
  });
}

async function uploadToImgBB(env, base64Images) {
  const apiKey = env && env.IMGBB_API_KEY;
  if (!apiKey) return { ok: false, error: "ImgBB API key not configured" };
  if (!Array.isArray(base64Images) || base64Images.length === 0) return { ok: false, error: "No images provided" };
  if (base64Images.length > MAX_IMAGES_PER_PROPERTY) return { ok: false, error: `Maximum ${MAX_IMAGES_PER_PROPERTY} images allowed` };

  const urls = [];
  const errors = [];
  for (const img of base64Images) {
    if (typeof img !== "string" || !img.trim()) continue;
    try {
      const form = new FormData();
      form.append("key", apiKey);
      form.append("image", img.trim());
      const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
      if (!res.ok) { errors.push(`HTTP ${res.status}`); continue; }
      const data = await res.json();
      const url = data?.data?.url;
      if (url) urls.push(url);
      else errors.push(data?.error?.message || "no url");
    } catch (e) { errors.push(e.message); }
  }
  console.log("[V39] uploadToImgBB:", urls.length, "of", base64Images.length);
  if (urls.length === 0) return { ok: false, error: errors[0] || "Failed to upload" };
  return { ok: true, urls };
}

function getSteps(type) {
  if (type === "sale") return SALE_STEPS;
  if (type === "rent") return RENT_OWN_STEPS;
  return SALE_STEPS;
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "—";
}

function nextStepIndex(steps, data, fromIndex) {
  for (let i = fromIndex; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (hasValue(data[step.id])) continue;
    return i;
  }
  return -1;
}

function countRemainingSteps(steps, data, fromIndex) {
  let count = 0;
  for (let i = fromIndex; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (hasValue(data[step.id])) continue;
    count++;
  }
  return count;
}

function countTotalSteps(steps, data) {
  let count = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    count++;
  }
  return count;
}

function buildProgress(steps, data, currentIdx) {
  const total = countTotalSteps(steps, data);
  const remaining = countRemainingSteps(steps, data, currentIdx);
  const current = Math.max(1, total - remaining + 1);
  const percent = total ? Math.round(((current - 1) / total) * 100) : 0;
  return { current, total, remaining, percent };
}

function decorateWithProgress(question, progress, showCount = true) {
  if (!showCount || !progress || progress.remaining <= 1) return question;
  return `${question}\n\n(${progress.current}/${progress.total})`;
}

function normalizeAr(s) {
  return String(s || "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "").replace(/[^\w\u0600-\u06FF+]/g, "")
    .toLowerCase().trim();
}

function isBtn(msg, label) {
  const a = String(msg || "").trim();
  const b = String(label || "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizeAr(a) === normalizeAr(b);
}

function matchOption(input, options) {
  if (!options || !options.length) return null;
  const n = normalizeAr(input);
  if (!n || n.length < 1) return null;
  for (const o of options) if (normalizeAr(o) === n) return o;
  if (n.length < 2) return null;
  for (const o of options) {
    const on = normalizeAr(o);
    if (on && on.length >= 2 && (on.includes(n) || n.includes(on))) return o;
  }
  return null;
}

function normalizePhone(s) {
  let d = String(s || "")
    .replace(/[٠-٩]/g, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)))
    .replace(/\D/g, "");
  if (d.startsWith("2001")) d = d.slice(2);
  else if (d.startsWith("20") && d.length >= 12) d = "0" + d.slice(2);
  if (d.startsWith("1") && d.length === 10) d = "0" + d;
  return d;
}

// ═════════════════════════════════════════════════════════
// ❓ isLikelyQuestion — V39 FINAL
// ═════════════════════════════════════════════════════════
function isLikelyQuestion(text, currentOptions) {
  const t = String(text || "").trim();
  if (!t) return false;

  // لو الرسالة تطابق خيار من الأزرار → مش سؤال
  if (currentOptions && currentOptions.length && matchOption(t, currentOptions)) return false;

  // علامة استفهام
  if (/[؟?]/.test(t)) return true;

  // كلمات استفهام صريحة
  if (/(هل|امتى|إمتى|بكام|كام|ليه|إزاي|ازاي|فين|مين|يعني ايه|ايه ده|ايه هو|هو ايه|ينفع|ممكن|اقدر|أقدر|تقدر|لو سمحت|من فضلك|ايه رايكم|ايه الفرق)/i.test(t)) return true;

  // كلمات تعليق قوية
  if (/(معلش|بصراحة|الحقيقة|سؤال|استفسار|مش فاهم|مش واضح)/i.test(t)) return true;

  return false;
}

// ═════════════════════════════════════════════════════════
// 🎯 Buttons — is*
// ═════════════════════════════════════════════════════════
function isSkip(msg) {
  if (isBtn(msg, BTN_SKIP) || isBtn(msg, "تخطي السؤال") || isBtn(msg, "تخطي")) return true;
  return /^(تخطي|تخطي السؤال|سكيب|skip|بعدين|مش دلوقتي|مش متأكد|مفيش)$/i.test(String(msg).trim());
}

function isCancel(msg) {
  if (isBtn(msg, BTN_CANCEL) || isBtn(msg, "إلغاء التسجيل")) return true;
  return /^(إلغاء التسجيل|الغاء التسجيل|إلغاء|الغاء|وقف التسجيل|cancel)$/i.test(String(msg).trim());
}

function isSendNow(msg) {
  if (isBtn(msg, BTN_SEND) || isBtn(msg, "ابعت البيانات دلوقتي")) return true;
  return /ابعت البيانات|ابعت اللي عندك|ابعت دلوقتي|خلاص ابعت|send now/i.test(String(msg).trim());
}

function isBack(msg) {
  return isBtn(msg, BTN_BACK) || /^(رجوع|⬅️ رجوع|back)$/i.test(String(msg).trim());
}

function isCancelBack(msg) {
  return isBtn(msg, BTN_CANCEL_BACK) || /^(إلغاء الرجوع|الغاء الرجوع)$/i.test(String(msg).trim());
}

function isAnyArea(msg) {
  return isBtn(msg, BTN_ANY_AREA) || /أي منطقة|اي منطقة|كل المناطق|مدينة نصر كلها/i.test(String(msg).trim());
}

function isAttachImagesBtn(msg) {
  const t = String(msg || "").trim();
  if (isBtn(t, BTN_ATTACH_IMAGES)) return true;
  return /^(📷\s*)?(أرفق|ارفق)\s*صور$/i.test(t);
}

function isSkipImagesBtn(msg) {
  const t = String(msg || "").trim();
  if (isBtn(t, BTN_SKIP_IMAGES)) return true;
  return /تخطي\s*\(?بدون\s*صور\)?/i.test(t);
}

function isAddImagesBtn(msg) {
  const t = String(msg || "").trim();
  if (isBtn(t, BTN_ADD_IMAGES)) return true;
  return /^(📷\s*)?(إضافة|اضافة)\s*صور$/i.test(t);
}

function isDeleteImagesBtn(msg) {
  const t = String(msg || "").trim();
  if (isBtn(t, BTN_DELETE_IMAGES)) return true;
  return /احذف\s*الكل|امسح\s*الكل|حذف\s*الكل/i.test(t);
}

function isImagesDoneBtn(msg) {
  const t = String(msg || "").trim();
  if (!t) return false;
  if (isBtn(t, BTN_IMAGES_DONE)) return true;
  if (/تمام[\s،,]*كم+ل/i.test(t)) return true;
  if (/^✅\s*تمام/i.test(t)) return true;
  if (/^تمام/i.test(t) && /كم+ل/i.test(t)) return true;
  return false;
}

function isSendWaBtn(msg) {
  return isBtn(msg, BTN_SEND_WA) || /^(ابعت على واتساب|ابعت واتساب|واتساب)$/i.test(String(msg).trim());
}

function isEditBtn(msg) {
  return isBtn(msg, BTN_EDIT) || /^(عدّل حاجة|عدل حاجة|عدل|تعديل)$/i.test(String(msg).trim());
}

function isNewRequestBtn(msg) {
  return isBtn(msg, BTN_NEW_REQUEST) || /^(طلب جديد|جديد|ابدا من جديد|محادثة جديدة)$/i.test(String(msg).trim());
}

function isBuyBtn(msg) {
  return isBtn(msg, BTN_BUY) || /^(عايز أشتري|عايز اشتري|أشتري|اشتري)$/i.test(String(msg).trim());
}

function isTenantBtn(msg) {
  return isBtn(msg, BTN_TENANT) || /^(عايز أستأجر|عايز استاجر|أستأجر|استأجر|مستأجر)$/i.test(String(msg).trim());
}

function isSellBtn(msg) {
  return isBtn(msg, BTN_SELL) || /^(عايز أبيع|عايز ابيع|أبيع|ابيع)$/i.test(String(msg).trim());
}

function isLandlordBtn(msg) {
  return isBtn(msg, BTN_LANDLORD) || /^(عايز أأجر|عايز اجر|أأجر|ااجر|أؤجر|عايز أؤجر)$/i.test(String(msg).trim());
}

function isOutOfCoverage(text) {
  return OUT_OF_COVERAGE_PATTERN.test(String(text || "").trim());
}

function isInNasrCity(text) {
  return NASR_CITY_PATTERN.test(String(text || "").trim());
}

function canEarlySend(data) {
  return hasValue(data.propertyType) && hasValue(data.location) && hasValue(data.price);
}

function withControls(stepOptions, data, showBack = true) {
  const opts = Array.isArray(stepOptions) ? [...stepOptions] : [];
  if (showBack) opts.push(BTN_BACK);
  opts.push(BTN_SKIP);
  if (canEarlySend(data)) opts.push(BTN_SEND);
  opts.push(BTN_CANCEL);
  return opts;
}

function matchInterrupt(message) {
  const t = String(message || "").trim();
  for (const rule of INTERRUPT_RULES) {
    if (rule.test.test(t)) return rule.answer;
  }
  return null;
}

// ═════════════════════════════════════════════════════════
// 🎯 tryHandleInterrupt — V39 FINAL (مع history)
// ═════════════════════════════════════════════════════════
async function tryHandleInterrupt(msg, env, currentOptions, formState, currentStep, history) {
  const trimmed = String(msg || "").trim();
  if (!trimmed) return null;
  if (isSkip(trimmed) || isCancel(trimmed) || isSendNow(trimmed) ||
      isBack(trimmed) || isCancelBack(trimmed)) return null;
  if (isImagesDoneBtn(trimmed) || isAttachImagesBtn(trimmed) ||
      isSkipImagesBtn(trimmed) || isAddImagesBtn(trimmed) ||
      isDeleteImagesBtn(trimmed)) return null;
  if (currentOptions && currentOptions.length && matchOption(trimmed, currentOptions)) return null;
  if (!isLikelyQuestion(trimmed, currentOptions)) return null;

  const canned = matchInterrupt(trimmed);
  if (canned) return { answer: canned, source: "canned" };

  const contextual = await askGeminiContextual(env, {
    userMessage: trimmed,
    formState,
    currentStep,
    history
  });
  if (contextual) return { answer: contextual, source: "contextual" };

  return { answer: "معلش، ممكن نكمّل البيانات الأول؟", source: "fallback" };
}

// ═════════════════════════════════════════════════════════
// 💰 extractFullPrice
// ═════════════════════════════════════════════════════════
function extractFullPrice(text) {
  const cleaned = String(text || "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const million = cleaned.match(/(\d+\.?\d*)\s*(مليون|مليون جنيه)/);
  if (million) return parseFloat(million[1]) * 1000000;
  const thousand = cleaned.match(/(\d+\.?\d*)\s*(الف|ألف|k)/i);
  if (thousand) return parseFloat(thousand[1]) * 1000;
  const direct = cleaned.match(/(\d{4,})/);
  if (direct && parseFloat(direct[1]) >= 10000) return parseFloat(direct[1]);
  return null;
}

function parseNumeric(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const cleaned = String(value)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/,/g, "").replace(/[^\d.]/g, "")
    .replace(/\.{2,}/g, ".").replace(/\.$/, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ═════════════════════════════════════════════════════════
// 📷 buildImagesSection
// ═════════════════════════════════════════════════════════
function buildImagesSection(imageUrls, type = "owner", imagesSkipped = false) {
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    const lines = [];
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`📷 *صور العقار (${imageUrls.length} ${imageUrls.length === 1 ? "صورة" : "صور"})*`);
    imageUrls.forEach((url, i) => {
      const num = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][i] || `${i + 1}.`;
      lines.push(`${num} [اضغط لمعاينة الصورة](${url})`);
    });
    return lines.join("\n");
  }

  if (type === "owner") {
    const lines = [];
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    if (imagesSkipped) lines.push(`📷 *الصور:* ⏭ تم التخطي (بدون صور)`);
    else lines.push(`📷 *الصور:* ⚠️ لم يتم إرفاق صور`);
    lines.push(`   (يُرجى إرسالها لاحقًا على الواتساب)`);
    return lines.join("\n");
  }
  return "";
}

// ═════════════════════════════════════════════════════════
// 💬 buildOwnerWaMessage
// ═════════════════════════════════════════════════════════
function buildOwnerWaMessage(type, data, imageUrls) {
  const typeLabel = type === "sale" ? "بيع" : "إيجار";
  const propertyLabel = data.propertyType || "عقار";

  const lines = [
    `السلام عليكم أ. طارق،`,
    ``,
    `أنا ${data.ownerName || "—"}، صاحب ${propertyLabel} في مدينة نصر.`,
    `عميل جدّي عايز أعرض ${propertyLabel === "شقة" ? "شقتي" : `${propertyLabel}ي`} لل${typeLabel}، وعندي ثقة في خبرتك.`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `📋 *تفاصيل العقار*`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏷️ نوع العقار: ${propertyLabel}`,
    `📍 الموقع: ${data.location || "—"}`
  ];

  if (hasValue(data.area)) lines.push(`📐 المساحة: ${formatValue(data.area)} م²`);

  if (isShop(data.propertyType)) {
    if (hasValue(data.businessType)) lines.push(`💼 النشاط الحالي: ${data.businessType}`);
    if (hasValue(data.previousActivity)) lines.push(`📋 النشاط السابق: ${data.previousActivity}`);
    if (hasValue(data.frontage)) lines.push(`🚪 الواجهة: ${data.frontage}`);
  }
  if (isOffice(data.propertyType)) {
    if (hasValue(data.businessType)) lines.push(`💼 نشاط المكتب: ${data.businessType}`);
    if (hasValue(data.officesCount)) lines.push(`🚪 عدد المكاتب: ${formatValue(data.officesCount)}`);
  }
  if (isWarehouse(data.propertyType)) {
    if (hasValue(data.storageType)) lines.push(`📦 نوع التخزين: ${data.storageType}`);
  }

  if (type === "rent" && hasValue(data.furnished)) {
    lines.push(`🛋️ نوع الإيجار: ${data.furnished}`);
    if (data.furnished === "مفروش") {
      if (hasValue(data.rentPeriods)) lines.push(`📅 المدة: ${data.rentPeriods}`);
      if (hasValue(data.priceWeekly)) lines.push(`💰 الإيجار الأسبوعي: ${formatNumber(data.priceWeekly)} ج.م`);
      if (hasValue(data.priceMonthly)) lines.push(`💰 الإيجار الشهري: ${formatNumber(data.priceMonthly)} ج.م`);
      if (hasValue(data.priceYearly)) lines.push(`💰 الإيجار السنوي: ${formatNumber(data.priceYearly)} ج.م`);
      if (hasValue(data.furnitureQuality)) lines.push(`✨ جودة الأثاث: ${data.furnitureQuality}`);
    } else {
      if (hasValue(data.duration)) lines.push(`📅 مدة العقد: ${data.duration}`);
      if (hasValue(data.price)) lines.push(`💰 الإيجار الشهري: ${formatNumber(data.price)} ج.م`);
    }
  } else if (type === "sale" && hasValue(data.price)) {
    lines.push(`💰 السعر المطلوب: ${formatNumber(data.price)} ج.م`);
  } else if (type === "rent" && hasValue(data.price)) {
    lines.push(`💰 الإيجار الشهري: ${formatNumber(data.price)} ج.م`);
  }

  if (isResidentialType(data.propertyType)) {
    if (hasValue(data.rooms)) lines.push(`🛏️ عدد الغرف: ${formatValue(data.rooms)}`);
    if (hasValue(data.baths)) lines.push(`🛁 عدد الحمامات: ${formatValue(data.baths)}`);
  }

  if (hasValue(data.floor)) lines.push(`🏢 الدور: ${data.floor}`);
  if (hasValue(data.finishing)) lines.push(`✨ التشطيب: ${data.finishing}`);
  if (hasValue(data.notes) && data.notes !== "لا") lines.push(`📝 ملاحظات: ${data.notes}`);

  const imagesSection = buildImagesSection(imageUrls, "owner", !!data.imagesSkipped);
  if (imagesSection) { lines.push(""); lines.push(imagesSection); }

  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📱 *بيانات التواصل*`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`👤 الاسم: ${data.ownerName || "—"}`);
  lines.push(`📞 الجوال: ${formatValue(data.ownerPhone)}`);
  lines.push("");
  lines.push(`في انتظار توجيهاتك.`);
  lines.push(`شكرًا جزيلًا.`);
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════
// 💬 buildTenantWaMessage
// ═════════════════════════════════════════════════════════
function buildTenantWaMessage(data, imageUrls) {
  const propertyLabel = data.propertyType || "عقار";

  const lines = [
    `السلام عليكم أ. طارق،`,
    ``,
    `أنا عميل من موقع "سمسار طلبك".`,
    `ببحث عن ${propertyLabel} للإيجار في مدينة نصر.`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `📋 *تفاصيل الطلب*`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏷️ نوع العقار: ${propertyLabel}`
  ];

  if (data.landmark && data.landmark !== "__ANY__") lines.push(`📍 المنطقة: ${data.landmark}`);
  else lines.push(`📍 المنطقة: أي منطقة في مدينة نصر`);

  if (isShop(data.propertyType)) {
    if (hasValue(data.businessActivity)) lines.push(`💼 النشاط: ${data.businessActivity}`);
    if (hasValue(data.frontagePref)) lines.push(`🚪 الواجهة: ${data.frontagePref}`);
  }
  if (isOffice(data.propertyType)) {
    if (hasValue(data.businessType)) lines.push(`💼 النشاط: ${data.businessType}`);
    if (hasValue(data.officesCount)) lines.push(`🚪 عدد المكاتب: ${formatValue(data.officesCount)}`);
  }
  if (isWarehouse(data.propertyType)) {
    if (hasValue(data.storageType)) lines.push(`📦 نوع التخزين: ${data.storageType}`);
  }

  if (hasValue(data.furnished)) lines.push(`🛋️ نوع الإيجار: ${data.furnished}`);
  if (data.furnished === "مفروش" && hasValue(data.rentPeriods)) lines.push(`📅 المدة: ${data.rentPeriods}`);
  if (data.furnished === "فاضي (قانون جديد)" && hasValue(data.duration)) lines.push(`📅 مدة العقد: ${data.duration}`);
  if (hasValue(data.budget)) lines.push(`💰 الميزانية: ${formatNumber(data.budget)} ج.م`);
  if (isResidentialType(data.propertyType) && hasValue(data.rooms)) lines.push(`🛏️ عدد الغرف: ${formatValue(data.rooms)}`);
  if (hasValue(data.urgency)) lines.push(`⏰ الموعد: ${data.urgency}`);

  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    lines.push("");
    const sec = buildImagesSection(imageUrls, "buyer");
    if (sec) lines.push(sec);
  }

  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📱 *بيانات التواصل*`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📞 الجوال: ${formatValue(data.phone)}`);
  lines.push("");
  lines.push(`في انتظار توجيهاتك.`);
  lines.push(`شكرًا جزيلًا.`);
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════
// 💬 buildBuyerWaMessage
// ═════════════════════════════════════════════════════════
function buildBuyerWaMessage(data, imageUrls) {
  const propertyLabel = data.propertyType || "عقار";

  const lines = [
    `السلام عليكم أ. طارق،`,
    ``,
    `أنا عميل من موقع "سمسار طلبك".`,
    `ببحث عن ${propertyLabel} للشراء في مدينة نصر.`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `📋 *تفاصيل الطلب*`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏷️ نوع العقار: ${propertyLabel}`
  ];

  if (data.landmark && data.landmark !== "__ANY__") lines.push(`📍 المنطقة: ${data.landmark}`);
  else lines.push(`📍 المنطقة: أي منطقة في مدينة نصر`);

  if (isShop(data.propertyType)) {
    if (hasValue(data.businessActivity)) lines.push(`💼 النشاط: ${data.businessActivity}`);
    if (hasValue(data.frontagePref)) lines.push(`🚪 الواجهة: ${data.frontagePref}`);
  }
  if (isOffice(data.propertyType)) {
    if (hasValue(data.businessType)) lines.push(`💼 النشاط: ${data.businessType}`);
    if (hasValue(data.officesCount)) lines.push(`🚪 عدد المكاتب: ${formatValue(data.officesCount)}`);
  }
  if (isWarehouse(data.propertyType)) {
    if (hasValue(data.storageType)) lines.push(`📦 نوع التخزين: ${data.storageType}`);
  }

  if (hasValue(data.budget)) lines.push(`💰 الميزانية: ${formatNumber(data.budget)} ج.م`);
  if (isResidentialType(data.propertyType) && hasValue(data.rooms)) lines.push(`🛏️ عدد الغرف: ${formatValue(data.rooms)}`);
  if (hasValue(data.urgency)) lines.push(`⏰ الموعد: ${data.urgency}`);

  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    lines.push("");
    const sec = buildImagesSection(imageUrls, "buyer");
    if (sec) lines.push(sec);
  }

  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📱 *بيانات التواصل*`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📞 الجوال: ${formatValue(data.phone)}`);
  lines.push("");
  lines.push(`في انتظار توجيهاتك.`);
  lines.push(`شكرًا جزيلًا.`);
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════
// 📋 buildReviewScreen
// ═════════════════════════════════════════════════════════
function buildReviewScreen(steps, data) {
  const lines = ["اختار السؤال اللي عايز تعدّله:"];
  const buttons = [];
  let counter = 1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (!hasValue(data[step.id])) continue;
    if (step.id === "images") continue;
    let value = data[step.id];
    if (step.id === "landmark" && value === "__ANY__") value = "أي منطقة";
    if (step.id === "notes" && value === "لا") value = "(مفيش)";
    value = toEnglishDigits(String(value));
    lines.push(`${counter}. ${getFieldLabel(step.id)}: ${value}`);
    buttons.push(`${counter}`);
    counter++;
  }
  buttons.push(BTN_CANCEL_BACK);
  return { response: lines.join("\n"), buttons };
}

// ═════════════════════════════════════════════════════════
// 🎯 askStep
// ═════════════════════════════════════════════════════════
function askStep(steps, idx, formState, prefix) {
  const step = steps[idx];
  const progress = buildProgress(steps, formState.data, idx);
  const qText = resolveQuestion(step, formState.data);
  const question = decorateWithProgress(qText, progress, true);
  const response = prefix ? `${prefix}\n\n${question}` : question;
  const showBack = formState.stepIndex > 0;
  const nextState = {
    ...formState,
    stepIndex: idx,
    awaitingQuestion: false,
    flowType: formState.flowType || "owner"
  };

  let options;
  if (step.type === "images_step") {
    const imageUrls = formState.imageUrls || [];
    if (imageUrls.length > 0) {
      options = [BTN_IMAGES_DONE, BTN_ADD_IMAGES, BTN_DELETE_IMAGES];
    } else {
      options = [BTN_ATTACH_IMAGES, BTN_SKIP_IMAGES];
    }
    if (showBack) options.push(BTN_BACK);
    options.push(BTN_CANCEL);
  } else {
    options = withControls(step.type === "buttons" ? step.options : [], formState.data, showBack);
  }

  return {
    response,
    formState: nextState,
    options,
    done: false, readyToSend: false,
    progress,
    waMessage: buildOwnerWaMessage(formState.type, formState.data, formState.imageUrls || []),
    imageUrls: formState.imageUrls || []
  };
}

// ═════════════════════════════════════════════════════════
// ✅ completeOwnerForm
// ═════════════════════════════════════════════════════════
function completeOwnerForm(formState, data) {
  const steps = getSteps(formState.type);
  const imageUrls = formState.imageUrls || [];
  const waMessage = buildOwnerWaMessage(formState.type, data, imageUrls);
  const total = countTotalSteps(steps, data);
  const finalState = {
    ...formState, stepIndex: -1, data,
    lifecycle: LIFECYCLE.COMPLETED,
    flowType: formState.type === "sale" ? "owner_completed_sale" : "owner_completed_rent",
    awaitingQuestion: false,
    imageUrls
  };

  const hasImgs = imageUrls.length > 0;
  const imagesNote = hasImgs
    ? `استلمت ${imageUrls.length} صورة ✅`
    : (data.imagesSkipped ? `ملاحظة: تم تخطي الصور` : `ملاحظة: لسه ما اترفعتش صور — تقدر تبعتها على الواتساب بعد كده`);

  return {
    response: `تمام يا فندم، سجّلت العقار كامل ✅\n\n${imagesNote}\n\n` +
              `طارق هيتواصل معاك على الواتساب خلال ساعات إن شاء الله.\n` +
              `دوس على "ابعت على واتساب" تحت عشان يوصلك التفاصيل كاملة.`,
    formState: finalState,
    options: POST_COMPLETE_BUTTONS,
    done: true, readyToSend: true,
    canShareWhatsapp: true,
    progress: { current: total, total, remaining: 0, percent: 100 },
    leadData: { type: formState.type === "sale" ? "بيع عقار (مالك)" : "إيجار عقار (مالك)", ...data },
    waMessage,
    imageUrls
  };
}

function cancelForm(formState) {
  return {
    response: `تمام يا فندم، ألغينا الطلب. لو حبيت تبدأ من جديد في أي وقت، أنا معاك.`,
    formState: {
      active: false, lifecycle: LIFECYCLE.CANCELLED,
      type: formState.type, stepIndex: -1,
      data: formState.data || {}, awaitingQuestion: false, flowType: null,
      imageUrls: formState.imageUrls || []
    },
    options: null,
    done: false, readyToSend: false, cancelled: true,
    canShareWhatsapp: false,
    progress: null, waMessage: null,
    leadData: { type: "إلغاء تسجيل عقار" },
    imageUrls: formState.imageUrls || []
  };
}

function findMissingRequired(steps, data) {
  for (const id of REQUIRED_IDS) {
    if (!hasValue(data[id])) {
      const idx = steps.findIndex((s) => s.id === id);
      if (idx >= 0) return idx;
    }
  }
  return -1;
}

function tryCompleteOwner(formState, data) {
  const steps = getSteps(formState.type);
  const missingIdx = findMissingRequired(steps, data);
  if (missingIdx !== -1) {
    const miss = steps[missingIdx];
    const missQ = resolveQuestion(miss, data);
    return askStep(steps, missingIdx, { ...formState, data, lifecycle: LIFECYCLE.ACTIVE }, `محتاج ${missQ.replace("؟", "")} بس.`);
  }
  if (!hasValue(data.notes)) data.notes = "لا";
  return completeOwnerForm(formState, data);
}

// ═════════════════════════════════════════════════════════
// 🧠 askGeminiContextual
// ═════════════════════════════════════════════════════════
async function askGeminiContextual(env, ctx) {
  const apiKey = env && env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const { userMessage, formState, currentStep, history } = ctx || {};
  if (!userMessage) return null;

  let contextBlock = "";
  if (formState) {
    const flowType = formState.flowType || "unknown";
    const data = formState.data || {};
    const filledFields = Object.entries(data)
      .filter(([_, v]) => hasValue(v))
      .map(([k, v]) => `  • ${getFieldLabel(k)}: ${v}`)
      .join("\n");

    let typeLabel = "غير محدد";
    if (formState.type === "sale") typeLabel = "بيع";
    else if (formState.type === "rent") typeLabel = "إيجار";

    let flowLabel = "غير معروف";
    if (flowType === "owner") flowLabel = `فورم مالك (${typeLabel})`;
    else if (flowType === "buyer") flowLabel = `فورم مشتري/مستأجر (${typeLabel})`;
    else if (flowType.includes("review")) flowLabel = "شاشة مراجعة";
    else if (flowType.includes("completed")) flowLabel = "شاشة ما بعد الإرسال";
    else if (flowType === "buyer_select") flowLabel = "اختيار عقار";
    else if (flowType === "buyer_no_results") flowLabel = "شاشة لا نتائج";
    else if (flowType === "buyer_phone_only") flowLabel = "إدخال رقم فقط";

    contextBlock = `
📋 السياق الحالي:
- العميل داخل: ${flowLabel}
- نوع المعاملة: ${typeLabel}
${currentStep ? `- السؤال الحالي المعلّق: "${resolveQuestion(currentStep, data)}"` : ""}
${filledFields ? `- البيانات المُجمَّعة:\n${filledFields}` : "- لم يجمع بيانات بعد"}
`.trim();
  }

  const historyText = Array.isArray(history) && history.length > 0
    ? history.slice(-15).map(h => `${h.role === "user" ? "العميل" : "طارق"}: ${h.message || h.text || ""}`).join("\n")
    : "(أول رسالة)";

  const systemPrompt = `أنت "طارق طنطاوي"، خبير عقارات في مدينة نصر من 2014.
شخصيتك: مصري أصيل، محترم، واثق في نفسه، مباشر، بتحب العميل وبتحل مشاكله.
العميل ده بيتعامل معاك بثقة كبيرة — عنده عقار بالملايين أو بيدور على سكن العمر.
لازم تتعامل معاه كخبير حقيقي، مش روبوت دردشة.

[قواعد الرد — مهمة جدًا]:
1. رسالة العميل هي الأولوية القصوى — اقرأها كويس وافهم قصدها قبل الرد.
2. رد على سؤال العميل في 2-4 أسطر بالكتير، بالعامية المصرية الأصيلة.
3. لو العميل داخل فورم، بعد ما ترد على سؤاله، ذكّره بلطف بالسؤال الحالي المعلّق.
4. ممنوع تسأل سؤال جديد من عندك (غير السؤال المعلّق).
5. ممنوع تخرج عن سياق العقارات أو مدينة نصر.
6. ممنوع كلمات: "يا هلا" / "منور" / "يا باشا" / "لقطة" / "يا غالي" / "تمام التمام".
7. لو السؤال مش واضح، قول: "معلش مش فاهم قصدك، ممكن توضح؟"
8. متكتبش أي حاجة عن إنك AI أو مساعد ذكي.
9. لو سأل عن العمولة: "2.5% من قيمة البيع، بتتحدد بعد المعاينة والتقييم. مفيش حاجة مخبية."
10. لو سأل عن العنوان: ارد بالعنوان + اللوكيشن + المواعيد + الأفضل يواتساب قبل ما ييجي.

[سياق المحادثة الكامل]:
${historyText}

${contextBlock}

أعد JSON فقط بالشكل: {"answer":"..."}`;

  try {
    const payload = {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        maxOutputTokens: 260,
        temperature: 0.35,
        responseMimeType: "application/json"
      }
    };

    const r = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) return null;
    const j = await r.json();
    const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      return parsed?.answer?.trim() || null;
    } catch (_) { return raw; }
  } catch (e) { return null; }
}

async function askGeminiBrief(env, question) {
  const apiKey = env && env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const payload = {
      contents: [{ role: "user", parts: [{ text: question }] }],
      systemInstruction: {
        parts: [{
          text: `أنت طارق طنطاوي، سمسار عقارات في مدينة نصر من 2014.
[قواعد]: عامية مصرية أصيلة، سطر أو سطرين بالكتير، مباشر ومفيد، ممنوع "يا هلا"/"منور"/"يا باشا"/"لقطة"/"يا غالي"، ممنوع تسأل سؤال جديد.
أعد JSON فقط بالشكل {"answer":"..."}`
        }]
      },
      generationConfig: { maxOutputTokens: 120, temperature: 0.2, responseMimeType: "application/json" }
    };
    const r = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!raw) return null;
    try { return JSON.parse(raw)?.answer?.trim() || null; } catch (_) { return raw; }
  } catch (e) { return null; }
}

// ═════════════════════════════════════════════════════════
// 📝 fillOwnerStep
// ═════════════════════════════════════════════════════════
function fillOwnerStep(step, msg, data) {
  if (!step) return { ok: false, reason: "no-step" };
  const trimmed = String(msg || "").trim();

  if (step.id === "ownerPhone") {
    const ph = normalizePhone(trimmed);
    if (/^01[0-9]{9}$/.test(ph)) { data.ownerPhone = ph; return { ok: true }; }
    return { ok: false, reason: step.err };
  }

  if (step.id === "ownerName") {
    if (isLikelyQuestion(trimmed) || /عمول|مستعجل/.test(trimmed)) return { ok: false, reason: "question" };
    const ph = normalizePhone(trimmed);
    if (/^01[0-9]{9}$/.test(ph)) { data.ownerPhone = ph; return { ok: true, jumped: true }; }
    if (trimmed.length < 2) return { ok: false, reason: "اكتب اسمك الثلاثي." };
    data.ownerName = trimmed;
    return { ok: true };
  }

  if (step.id === "location") {
    if (isOutOfCoverage(trimmed)) return { ok: false, reason: "out_of_coverage" };
    if (!isInNasrCity(trimmed) && trimmed.length < 5) {
      return { ok: false, reason: "اكتب العنوان بالتفصيل (الشارع والمنطقة)." };
    }
    data.location = trimmed;
    return { ok: true };
  }

  if (step.id === "price" || step.id === "priceWeekly" || step.id === "priceMonthly" || step.id === "priceYearly") {
    const extracted = extractFullPrice(trimmed);
    const num = parseNumeric(trimmed);
    if (!extracted && num < 100) return { ok: false, reason: "اكتب السعر رقم." };
    data[step.id] = String(extracted || num);
    return { ok: true };
  }

  if (step.id === "area") {
    const n = parseNumeric(trimmed);
    if (!n) return { ok: false, reason: "اكتب المساحة بالمتر." };
    data.area = String(n);
    return { ok: true };
  }

  if (step.type === "buttons") {
    const matched = matchOption(trimmed, step.options);
    if (matched) { data[step.id] = matched; return { ok: true }; }

    if (step.id === "rooms" || step.id === "officesCount") {
      const n = parseNumeric(trimmed);
      if (n >= 5) { data[step.id] = "5+"; return { ok: true }; }
      if (n >= 1 && n <= 4) { data[step.id] = String(n); return { ok: true }; }
    }
    if (step.id === "baths") {
      const n = parseNumeric(trimmed);
      if (n >= 3) { data.baths = "3+"; return { ok: true }; }
      if (n >= 1 && n <= 2) { data.baths = String(n); return { ok: true }; }
    }
    return { ok: false, reason: "اختار من الأزرار." };
  }

  if (step.validate && !step.validate.test(trimmed)) return { ok: false, reason: step.err };
  if (step.id === "notes") { data.notes = trimmed || "لا"; return { ok: true }; }
  if (trimmed.length < 2) return { ok: false, reason: "الإجابة قصيرة." };
  data[step.id] = trimmed;
  return { ok: true };
}

// ═════════════════════════════════════════════════════════
// 🔍 extractOwnerFields + extractBuyerFields
// ═════════════════════════════════════════════════════════
function extractOwnerFields(message) {
  const d = {};
  const t = String(message || "");
  const tNorm = t.replace(/[أإآ]/g, "ا");

  if (/محل|تجارى|تجاري|معرض/.test(tNorm)) d.propertyType = "محل تجاري";
  else if (/مكتب|اداري|إداري/.test(tNorm)) d.propertyType = "مكتب إداري";
  else if (/مخزن|مستودع/.test(tNorm)) d.propertyType = "مخزن";
  else if (/شقه|شقة|استوديو/.test(tNorm)) d.propertyType = "شقة";
  else if (/فيلا|فيللا/.test(tNorm)) d.propertyType = "فيلا";

  const area = tNorm.match(/(\d{2,4})\s*(متر|م²|م2)/);
  if (area) d.area = String(parseNumeric(area[1]));

  const priceVal = extractFullPrice(t);
  if (priceVal) d.price = String(priceVal);

  const phoneRaw = t.replace(/[٠-٩]/g, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
  const phone = normalizePhone(phoneRaw.match(/01[0-9]{9}/)?.[0] || "");
  if (/^01[0-9]{9}$/.test(phone)) d.ownerPhone = phone;

  const roomsMatch = tNorm.match(/(\d+)\s*(غرف|غرفة|اوض|أوض)/);
  if (roomsMatch) d.rooms = String(parseNumeric(roomsMatch[1]));

  const bathsMatch = tNorm.match(/(\d+)\s*(حمام|حمامات)/);
  if (bathsMatch) d.baths = String(parseNumeric(bathsMatch[1]));

  if (/ارضي|أرضي/.test(tNorm)) d.floor = "أرضي";
  else if (/بدروم/.test(tNorm)) d.floor = "بدروم";
  else if (/اخير|أخير/.test(tNorm)) d.floor = "أخير";
  else if (/متكرر/.test(tNorm)) d.floor = "متكرر";

  return d;
}

function extractBuyerFields(message) {
  const d = {};
  const t = String(message || "");
  const tNorm = t.replace(/[أإآ]/g, "ا");

  if (/محل|تجارى|تجاري|معرض/.test(tNorm)) d.propertyType = "محل تجاري";
  else if (/مكتب|اداري|إداري/.test(tNorm)) d.propertyType = "مكتب إداري";
  else if (/مخزن|مستودع/.test(tNorm)) d.propertyType = "مخزن";
  else if (/شقه|شقة|استوديو/.test(tNorm)) d.propertyType = "شقة";
  else if (/فيلا|فيللا/.test(tNorm)) d.propertyType = "فيلا";

  for (const lm of KNOWN_LANDMARKS) {
    if (t.includes(lm)) { d.landmark = lm; break; }
  }

  const priceVal = extractFullPrice(t);
  if (priceVal) d.budget = String(priceVal);

  const roomsMatch = tNorm.match(/(\d+)\s*(غرف|غرفة|اوض|أوض)/);
  if (roomsMatch) d.rooms = String(parseNumeric(roomsMatch[1]));

  if (/مفروش/.test(tNorm)) d.furnished = "مفروش";
  else if (/فاضي|قانون جديد/.test(tNorm)) d.furnished = "فاضي (قانون جديد)";

  const phoneRaw = t.replace(/[٠-٩]/g, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
  const phone = normalizePhone(phoneRaw.match(/01[0-9]{9}/)?.[0] || "");
  if (/^01[0-9]{9}$/.test(phone)) d.phone = phone;

  const activityMatch = tNorm.match(/نشاط(?:ي|ه|ها)?\s+(.+?)(?:\s|$|،)/);
  if (activityMatch && activityMatch[1].length >= 2) d.businessActivity = activityMatch[1].trim();

  return d;
}

function mergeExtracted(data, extracted) {
  const next = { ...data };
  for (const [k, v] of Object.entries(extracted || {})) {
    if (!hasValue(next[k]) && hasValue(v)) next[k] = v;
  }
  return next;
}

// ═════════════════════════════════════════════════════════
// 🚀 startOwnerForm
// ═════════════════════════════════════════════════════════
function startOwnerForm(type, initialData) {
  const steps = getSteps(type);
  const data = initialData && typeof initialData === "object" ? { ...initialData } : {};
  const idx = nextStepIndex(steps, data, 0);

  const formState = {
    active: true, lifecycle: LIFECYCLE.ACTIVE, type,
    stepIndex: idx, data, awaitingQuestion: false, flowType: "owner",
    imageUrls: []
  };

  const prefix = (idx > 0 && Object.keys(data).length > 0)
    ? `تمام، سجّلت اللي قلته ✅\nنكمّل باقي البيانات بس:`
    : null;

  return askStep(steps, idx, formState, prefix);
}

// ═════════════════════════════════════════════════════════
// 🎯 processOwnerFlow — V39 FINAL
// ═════════════════════════════════════════════════════════
async function processOwnerFlow(formState, userMessage, env, history) {
  const steps = getSteps(formState.type);
  let data = { ...formState.data };
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  if (formState.stepIndex === -1) {
    const idx = nextStepIndex(steps, data, 0);
    return askStep(steps, idx, { ...formState, stepIndex: idx, data, imageUrls });
  }

  if (isCancel(msg)) return cancelForm(formState);
  if (isSendNow(msg)) return tryCompleteOwner({ ...formState, data, imageUrls }, data);

  if (isBack(msg)) {
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, flowType: "owner_review",
        stepIndex: formState.stepIndex, returnStepIndex: formState.stepIndex,
        reviewButtons: review.buttons, data, imageUrls
      },
      options: review.buttons,
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls
    };
  }

  const currentStep = steps[formState.stepIndex] || steps[nextStepIndex(steps, data, 0)];
  const currentOptions = currentStep && currentStep.type === "buttons" ? currentStep.options : [];

  if (currentStep && currentStep.type === "images_step") {
    return await processOwnerImagesStep(formState, msg, env, currentStep, history);
  }

  // ✅ الأول: جرّب الإجابة على السؤال الحالي
  let answerFilled = false;
  if (!isSkip(msg)) {
    const extracted = extractOwnerFields(msg);
    const merged = mergeExtracted(data, extracted);

    if (hasValue(merged[currentStep.id])) {
      answerFilled = true;
      Object.assign(data, merged);
    } else {
      const testFill = fillOwnerStep(currentStep, msg, { ...merged });
      if (testFill.ok) {
        Object.assign(data, merged);
        answerFilled = true;
      }
    }
  }

  // ✅ لو الإجابة نجحت → روح للخطوة اللي بعدها
  if (answerFilled) {
    const nextIdxAuto = nextStepIndex(steps, data, 0);
    if (nextIdxAuto === -1 && !formState.isReviewing) {
      return tryCompleteOwner({ ...formState, data, imageUrls }, data);
    }
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return tryCompleteOwner({ ...formState, data, imageUrls }, data);
    return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  // ✅ لو الإجابة فشلت → شوف لو سؤال
  if (!isSkip(msg)) {
    const interruptResult = await tryHandleInterrupt(msg, env, currentOptions, formState, currentStep, history);
    if (interruptResult) {
      return askStep(steps, formState.stepIndex, { ...formState, data, imageUrls }, interruptResult.answer);
    }
  }

  if (isSkip(msg)) {
    if (currentStep && currentStep.id === "notes") data.notes = "لا";
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return tryCompleteOwner({ ...formState, data, imageUrls }, data);
    return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  const extracted = extractOwnerFields(msg);
  const merged = mergeExtracted(data, extracted);

  if (!hasValue(merged[currentStep.id])) {
    const filled = fillOwnerStep(currentStep, msg, merged);

    if (filled.reason === "out_of_coverage") {
      return {
        response: `معلش يا فندم، شغلنا في مدينة نصر بس.`,
        formState: {
          active: false, lifecycle: LIFECYCLE.CANCELLED, type: formState.type,
          stepIndex: -1, data: {}, awaitingQuestion: false, flowType: null,
          imageUrls
        },
        options: null,
        done: false, readyToSend: false, cancelled: true,
        canShareWhatsapp: false,
        progress: null, waMessage: null,
        leadData: { type: "خارج النطاق (مالك)" },
        imageUrls
      };
    }

    if (!filled.ok) {
      if (filled.reason === "question") {
        const canned = matchInterrupt(msg);
        let answer = canned;
        if (!answer) {
          answer = await askGeminiContextual(env, {
            userMessage: msg,
            formState: { ...formState, data: merged },
            currentStep,
            history
          });
          if (!answer) answer = "معلش، نكمّل البيانات الأول؟";
        }
        return askStep(steps, formState.stepIndex, { ...formState, data: merged, imageUrls }, answer);
      }
      const progress = buildProgress(steps, merged, formState.stepIndex);
      const showBack = formState.stepIndex > 0;
      return {
        response: `${filled.reason}\n\n${decorateWithProgress(resolveQuestion(currentStep, merged), progress, true)}`,
        formState: { ...formState, data: merged, awaitingQuestion: false, imageUrls },
        options: withControls(currentStep.type === "buttons" ? currentStep.options : [], merged, showBack),
        done: false, readyToSend: false, progress,
        canShareWhatsapp: true,
        waMessage: buildOwnerWaMessage(formState.type, merged, imageUrls),
        imageUrls
      };
    }
  }

  const nextIdxAuto = nextStepIndex(steps, merged, 0);
  if (nextIdxAuto === -1 && !formState.isReviewing) {
    return tryCompleteOwner({ ...formState, data: merged, imageUrls }, merged);
  }

  if (formState.isReviewing && formState.returnStepIndex !== undefined) {
    const returnIdx = formState.returnStepIndex;
    if (returnIdx === formState.stepIndex) {
      const nextIdx = nextStepIndex(steps, merged, formState.stepIndex + 1);
      if (nextIdx === -1) return tryCompleteOwner({ ...formState, data: merged, imageUrls }, merged);
      return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data: merged, isReviewing: false, returnStepIndex: undefined, imageUrls });
    }
    return askStep(steps, returnIdx, { ...formState, stepIndex: returnIdx, data: merged, isReviewing: false, returnStepIndex: undefined, imageUrls }, "تمام، عدّلناه. نكمّل.");
  }

  const nextIdx = nextStepIndex(steps, merged, formState.stepIndex + 1);
  if (nextIdx === -1) return tryCompleteOwner({ ...formState, data: merged, imageUrls }, merged);
  return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data: merged, imageUrls });
}

// ═════════════════════════════════════════════════════════
// 🆕 processOwnerImagesStep
// ═════════════════════════════════════════════════════════
async function processOwnerImagesStep(formState, msg, env, currentStep, history) {
  const steps = getSteps(formState.type);
  const data = { ...formState.data };
  const imageUrls = formState.imageUrls || [];

  console.log("[V39] processOwnerImagesStep: msg =", msg, "imageUrls =", imageUrls.length);

  if (!isAttachImagesBtn(msg) && !isSkipImagesBtn(msg) && !isAddImagesBtn(msg) &&
      !isDeleteImagesBtn(msg) && !isImagesDoneBtn(msg)) {
    const interruptResult = await tryHandleInterrupt(msg, env,
      [BTN_ATTACH_IMAGES, BTN_SKIP_IMAGES, BTN_BACK, BTN_CANCEL],
      formState, currentStep, history);
    if (interruptResult) {
      return askStep(steps, formState.stepIndex, { ...formState, data, imageUrls }, interruptResult.answer);
    }
  }

  if (isSkipImagesBtn(msg)) {
    data.imagesSkipped = true;
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return tryCompleteOwner({ ...formState, data, imageUrls }, data);
    return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  if (isAttachImagesBtn(msg) || isAddImagesBtn(msg)) {
    return {
      response: `تمام يا فندم 👌\n` +
                `دوس على زر 📷 اللي جنب شريط الكتابة واختار الصور (لحد ${MAX_IMAGES_PER_PROPERTY} صور).\n\n` +
                `بعد ما تخلص رفع، اضغط "✅ تمام، كمّل".`,
      formState: { ...formState, stepIndex: formState.stepIndex, data, imageUrls },
      options: imageUrls.length > 0
        ? [BTN_IMAGES_DONE, BTN_ADD_IMAGES, BTN_DELETE_IMAGES, BTN_BACK, BTN_CANCEL]
        : [BTN_IMAGES_DONE, BTN_BACK, BTN_CANCEL],
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls,
      imageStepAction: "open_picker"
    };
  }

  if (isDeleteImagesBtn(msg)) {
    return {
      response: `تمام، مسحنا كل الصور. تحب ترفع صور تانية ولا نكمّل بدون صور؟`,
      formState: { ...formState, stepIndex: formState.stepIndex, data, imageUrls: [] },
      options: [BTN_ATTACH_IMAGES, BTN_SKIP_IMAGES, BTN_BACK, BTN_CANCEL],
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls: []
    };
  }

  if (isImagesDoneBtn(msg)) {
    if (imageUrls.length === 0) data.imagesSkipped = true;
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return tryCompleteOwner({ ...formState, data, imageUrls }, data);
    return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  return askStep(steps, formState.stepIndex, { ...formState, data, imageUrls },
    `اختار من الأزرار: 📷 أرفق صور، أو ⏭ تخطي.`);
}

// ═════════════════════════════════════════════════════════
// 🎯 processPostComplete
// ═════════════════════════════════════════════════════════
async function processPostComplete(formState, userMessage, env, history) {
  const msg = String(userMessage || "").trim();
  const data = formState.data || {};
  const imageUrls = formState.imageUrls || [];

  if (!isSendWaBtn(msg) && !isEditBtn(msg) && !isNewRequestBtn(msg)) {
    const interruptResult = await tryHandleInterrupt(msg, env, POST_COMPLETE_BUTTONS, formState, null, history);
    if (interruptResult) {
      return {
        response: `${interruptResult.answer}\n\nاختار:`,
        formState, options: POST_COMPLETE_BUTTONS,
        done: true, readyToSend: true, canShareWhatsapp: true,
        leadData: formState.leadData || null,
        waMessage: formState.waMessage || null,
        imageUrls
      };
    }
  }

  if (isSendWaBtn(msg)) {
    const finalWa = formState.waMessage ||
      (formState.type === "sale" || formState.type === "rent"
        ? buildOwnerWaMessage(formState.type, data, imageUrls)
        : buildBuyerWaMessage(data, imageUrls));

    return {
      response: `تمام يا فندم، دوس على البانر الأخضر تحت 👇\nهيفتحلك واتساب برسالة كاملة.`,
      formState: { ...formState, lifecycle: LIFECYCLE.ARCHIVED, flowType: null, imageUrls },
      options: null,
      done: true, readyToSend: true, canShareWhatsapp: true,
      leadData: formState.leadData || null,
      waMessage: finalWa,
      imageUrls
    };
  }

  if (isEditBtn(msg)) {
    const steps = formState.type === "sale"
      ? SALE_STEPS
      : (formState.type === "rent" ? RENT_OWN_STEPS : getBuyerSteps(formState.type));
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE,
        flowType: (formState.type === "sale" || formState.type === "rent") ? "owner_review" : "buyer_review",
        stepIndex: -1, returnStepIndex: 0,
        reviewButtons: review.buttons, data, imageUrls
      },
      options: review.buttons,
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls
    };
  }

  if (isNewRequestBtn(msg)) {
    return {
      response: "تمام، اختار نوع الطلب الجديد:",
      formState: {
        active: false, lifecycle: LIFECYCLE.ARCHIVED,
        stepIndex: -1, data: {}, awaitingQuestion: false, flowType: null,
        imageUrls: []
      },
      options: null,
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls: []
    };
  }

  return {
    response: `تمام يا فندم، البيانات محفوظة ✅\nاختار:`,
    formState: formState,
    options: POST_COMPLETE_BUTTONS,
    done: true, readyToSend: true, canShareWhatsapp: true,
    leadData: formState.leadData || null,
    waMessage: formState.waMessage || null,
    imageUrls
  };
}

// ═════════════════════════════════════════════════════════
// 📋 processReviewScreen
// ═════════════════════════════════════════════════════════
async function processReviewScreen(formState, userMessage, env, history) {
  const steps = formState.flowType === "owner_review"
    ? getSteps(formState.type)
    : getBuyerSteps(formState.type);
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  if (isCancelBack(msg)) {
    const returnIdx = formState.returnStepIndex ?? 0;
    if (formState.flowType === "owner_review") {
      return askStep(steps, returnIdx, { ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "owner", stepIndex: returnIdx, data, imageUrls }, "تمام، كمّلنا.");
    }
    return await askBuyerStep(steps, returnIdx, { ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "buyer", stepIndex: returnIdx, data, imageUrls }, "تمام، كمّلنا.");
  }

  const interruptResult = await tryHandleInterrupt(msg, env, formState.reviewButtons || [], formState, null, history);
  if (interruptResult) {
    return {
      response: `${interruptResult.answer}\n\n${(buildReviewScreen(steps, data)).response}`,
      formState, options: formState.reviewButtons || [BTN_CANCEL_BACK],
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls
    };
  }

  const normalized = msg.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const numMatch = normalized.match(/\d+/);
  const choice = numMatch ? parseInt(numMatch[0], 10) : NaN;

  if (isNaN(choice)) {
    return {
      response: "اختار رقم من القايمة أو دوس [إلغاء الرجوع]:",
      formState, options: formState.reviewButtons || [BTN_CANCEL_BACK],
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls
    };
  }

  const answeredSteps = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (!hasValue(data[step.id])) continue;
    if (step.id === "images") continue;
    answeredSteps.push({ step, index: i });
  }

  if (choice < 1 || choice > answeredSteps.length) {
    return {
      response: `اختار رقم من 1 لـ ${answeredSteps.length}:`,
      formState, options: formState.reviewButtons || [BTN_CANCEL_BACK],
      done: false, readyToSend: false,
      canShareWhatsapp: true,
      imageUrls
    };
  }

  const target = answeredSteps[choice - 1];
  const newData = { ...data };
  delete newData[target.step.id];

  const returnIdx = formState.returnStepIndex ?? formState.stepIndex ?? 0;

  const newState = {
    ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE,
    flowType: formState.flowType === "owner_review" ? "owner" : "buyer",
    stepIndex: target.index, data: newData,
    returnStepIndex: returnIdx, isReviewing: true,
    imageUrls
  };

  if (formState.flowType === "owner_review") {
    return askStep(steps, target.index, newState, `تمام، عدّل ${getFieldLabel(target.step.id)}:`);
  }
  return await askBuyerStep(steps, target.index, newState, `تمام، عدّل ${getFieldLabel(target.step.id)}:`);
}

// ═════════════════════════════════════════════════════════
// 🎯 askBuyerStep
// ═════════════════════════════════════════════════════════
async function askBuyerStep(steps, idx, formState, prefix) {
  const step = steps[idx];
  const progress = buildProgress(steps, formState.data, idx);
  const qText = resolveQuestion(step, formState.data);
  const question = decorateWithProgress(qText, progress, true);
  const response = prefix ? `${prefix}\n\n${question}` : question;

  let options = [];
  if (step.type === "buttons") options = step.options || [];
  else if (step.type === "dynamic_buttons" && step.dynamicSource === "landmarks") {
    const feed = await fetchPropertyFeed();
    options = getLandmarkButtons(feed.properties || []);
  }

  if (formState.stepIndex > 0) options = [...options, BTN_BACK];

  return {
    response,
    formState: { ...formState, stepIndex: idx, awaitingQuestion: false },
    options, done: false, readyToSend: false, progress,
    canShareWhatsapp: false,
    buyerData: { ...formState.data },
    imageUrls: formState.imageUrls || []
  };
}

// ═════════════════════════════════════════════════════════
// 🚀 startBuyerFlow
// ═════════════════════════════════════════════════════════
function startBuyerFlow(transaction, initialData) {
  const steps = getBuyerSteps(transaction);
  const data = initialData && typeof initialData === "object" ? { ...initialData } : {};
  const idx = nextStepIndex(steps, data, 0);

  const formState = {
    active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "buyer", type: transaction,
    stepIndex: idx, data, awaitingQuestion: false,
    imageUrls: []
  };

  const prefix = (idx > 0 && Object.keys(data).length > 0)
    ? `تمام، سجّلت اللي قلته ✅\nنكمّل باقي البيانات بس:`
    : null;

  return askBuyerStep(steps, idx, formState, prefix);
}

// ═════════════════════════════════════════════════════════
// 🎯 processBuyerFlow — V39 FINAL
// ═════════════════════════════════════════════════════════
async function processBuyerFlow(formState, userMessage, env, history) {
  const steps = getBuyerSteps(formState.type);
  let data = { ...formState.data };
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  if (isCancel(msg)) {
    return {
      response: `تمام يا فندم، ألغينا الطلب.`,
      formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null, imageUrls },
      options: null,
      done: true, cancelled: true, readyToSend: false,
      canShareWhatsapp: false,
      buyerData: null, progress: null,
      imageUrls
    };
  }

  if (isBack(msg)) {
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, flowType: "buyer_review",
        stepIndex: formState.stepIndex, returnStepIndex: formState.stepIndex,
        reviewButtons: review.buttons, data, imageUrls
      },
      options: review.buttons,
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const currentStep = steps[formState.stepIndex];
  if (!currentStep) {
    return { response: "حصل خطأ، نبدأ من الأول؟", formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, imageUrls }, options: null, done: false, readyToSend: false, canShareWhatsapp: false, imageUrls };
  }

  // ✅ الأول: جرّب الإجابة على السؤال الحالي
  let answerFilled = false;
  if (!isSkip(msg)) {
    const extracted = extractBuyerFields(msg);
    const merged = mergeExtracted(data, extracted);

    if (hasValue(merged[currentStep.id])) {
      answerFilled = true;
      Object.assign(data, merged);
    }
  }

  // ✅ لو الإجابة نجحت → روح للخطوة اللي بعدها
  if (answerFilled) {
    const nextIdxAuto = nextStepIndex(steps, data, 0);
    if (nextIdxAuto === -1 && !formState.isReviewing) {
      return await completeBuyerFlow({ ...formState, imageUrls }, data);
    }
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return await completeBuyerFlow({ ...formState, imageUrls }, data);
    return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  // ✅ لو الإجابة فشلت → شوف لو سؤال
  if (!isSkip(msg)) {
    const currentOptions = currentStep.type === "buttons" ? (currentStep.options || []) : [];
    const interruptResult = await tryHandleInterrupt(msg, env, currentOptions, formState, currentStep, history);
    if (interruptResult) {
      return await askBuyerStep(steps, formState.stepIndex, { ...formState, data, imageUrls }, interruptResult.answer);
    }
  }

  if (isSkip(msg)) {
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return await completeBuyerFlow({ ...formState, imageUrls }, data);
    return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
  }

  const extracted = extractBuyerFields(msg);
  const mergedFromMsg = mergeExtracted(data, extracted);
  Object.keys(mergedFromMsg).forEach(k => {
    if (!hasValue(data[k]) && hasValue(mergedFromMsg[k])) {
      data[k] = mergedFromMsg[k];
    }
  });

  let filled = { ok: false };
  const trimmed = msg;

  if (hasValue(data[currentStep.id])) {
    filled = { ok: true };
  } else if (currentStep.id === "phone") {
    const ph = normalizePhone(trimmed);
    if (/^01[0-9]{9}$/.test(ph)) { data.phone = ph; filled = { ok: true }; }
    else filled = { ok: false, reason: currentStep.err };
  } else if (currentStep.id === "budget") {
    const price = extractFullPrice(trimmed);
    const num = parseNumeric(trimmed);
    if (!price && num < 1000) filled = { ok: false, reason: "اكتب الميزانية رقم." };
    else { data.budget = String(price || num); filled = { ok: true }; }
  } else if (currentStep.id === "landmark") {
    if (isOutOfCoverage(trimmed)) {
      return {
        response: `معلش يا فندم، شغلنا في مدينة نصر بس.`,
        formState: { active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null, type: formState.type, stepIndex: -1, data: {}, awaitingQuestion: false, imageUrls },
        options: null,
        done: false, readyToSend: false, cancelled: true,
        canShareWhatsapp: false,
        buyerData: null, progress: null,
        leadData: { type: "خارج النطاق (مشتري/مستأجر)" },
        imageUrls
      };
    }
    if (isAnyArea(trimmed)) { data.landmark = "__ANY__"; filled = { ok: true }; }
    else {
      const t = String(trimmed).trim();
      if (t.length >= 2 && t.length <= 60) { data.landmark = t; filled = { ok: true }; }
      else filled = { ok: false, reason: "اختار المنطقة من الأزرار." };
    }
  } else if (currentStep.type === "buttons" || currentStep.type === "dynamic_buttons") {
    let opts = currentStep.options || [];
    if (currentStep.type === "dynamic_buttons") {
      const feed = await fetchPropertyFeed();
      opts = getLandmarkButtons(feed.properties || []);
    }
    const matched = matchOption(trimmed, opts);
    if (matched) {
      if (currentStep.id === "landmark" && matched === BTN_ANY_AREA) data.landmark = "__ANY__";
      else data[currentStep.id] = matched;
      filled = { ok: true };
    } else if (currentStep.id === "rooms") {
      const n = parseNumeric(trimmed);
      if (n >= 5) { data.rooms = "5+"; filled = { ok: true }; }
      else if (n >= 2 && n <= 4) { data.rooms = String(n); filled = { ok: true }; }
      else filled = { ok: false, reason: "اختار من الأزرار." };
    } else filled = { ok: false, reason: "اختار من الأزرار." };
  } else {
    data[currentStep.id] = trimmed;
    filled = { ok: true };
  }

  if (!filled.ok) {
    const progress = buildProgress(steps, data, formState.stepIndex);
    let opts = currentStep.type === "buttons" ? currentStep.options : [];
    if (currentStep.type === "dynamic_buttons") {
      const feed = await fetchPropertyFeed();
      opts = getLandmarkButtons(feed.properties || []);
    }
    if (formState.stepIndex > 0) opts = [...opts, BTN_BACK];
    return {
      response: `${filled.reason}\n\n${decorateWithProgress(resolveQuestion(currentStep, data), progress, true)}`,
      formState: { ...formState, data, imageUrls }, options: opts,
      done: false, readyToSend: false, progress, buyerData: data,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const nextIdxAuto = nextStepIndex(steps, data, 0);
  if (nextIdxAuto === -1 && !formState.isReviewing) {
    return await completeBuyerFlow({ ...formState, imageUrls }, data);
  }

  if (formState.isReviewing && formState.returnStepIndex !== undefined) {
    const returnIdx = formState.returnStepIndex;
    if (returnIdx === formState.stepIndex) {
      const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
      if (nextIdx === -1) return await completeBuyerFlow({ ...formState, imageUrls }, data);
      return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, isReviewing: false, returnStepIndex: undefined, imageUrls });
    }
    return await askBuyerStep(steps, returnIdx, { ...formState, stepIndex: returnIdx, data, isReviewing: false, returnStepIndex: undefined, imageUrls }, "تمام، عدّلناه. نكمّل.");
  }

  const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
  if (nextIdx === -1) return await completeBuyerFlow({ ...formState, imageUrls }, data);
  return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, imageUrls });
}

// ═════════════════════════════════════════════════════════
// ✅ completeBuyerFlow
// ═════════════════════════════════════════════════════════
async function completeBuyerFlow(formState, data) {
  const transaction = formState.type;
  const imageUrls = formState.imageUrls || [];
  const feed = await fetchPropertyFeed();
  const allProperties = feed.properties || [];

  const criteria = {
    transaction,
    landmark: data.landmark && data.landmark !== "__ANY__" ? data.landmark : null,
    propertyType: data.propertyType === "شقة" ? "apartment" :
                  data.propertyType === "مكتب إداري" ? "office" :
                  data.propertyType === "محل تجاري" ? "shop" :
                  data.propertyType === "مخزن" ? "storage" : "villa",
    budget: parseNumeric(data.budget),
    rooms: parseNumeric(data.rooms),
    furnished: data.furnished === "مفروش" ? true : (data.furnished === "فاضي (قانون جديد)" ? false : null)
  };

  const filtered = filterProperties(allProperties, criteria);
  const ranked = rankedProperties(filtered, criteria);
  const topMatches = ranked.filter(x => x.score >= MIN_SCORE_THRESHOLD).slice(0, 5).map(x => x.property);

  const areaLabel = !data.landmark || data.landmark === "__ANY__" ? "مدينة نصر" : data.landmark;
  const isRent = transaction === "rent";
  const actionWord = isRent ? "إيجار" : "بيع";

  if (topMatches.length === 0) {
    const waMsg = isRent ? buildTenantWaMessage(data, imageUrls) : buildBuyerWaMessage(data, imageUrls);
    return {
      response: `مفيش ${data.propertyType} ${actionWord} في ${areaLabel} بالميزانية اللي حددتها حالياً.\n\n` +
                `بس أقدر أسجّل طلبك كامل وأبعته لطارق يدورلك عند الزملاء.\nتحب أسجّل الطلب؟`,
      formState: { ...formState, active: true, flowType: "buyer_no_results", stepIndex: -1, data, imageUrls },
      options: ["✅ أيوه سجّل طلبي", "❌ لا شكراً"],
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      buyerData: data, waMessage: waMsg,
      leadData: { type: isRent ? "إيجار (بدون نتائج)" : "شراء (بدون نتائج)", ...data, score: 5, source: "buyer-no-results" },
      imageUrls
    };
  }

  const lines = [`دي أنسب ${topMatches.length} حاجة لطلبك يا فندم:`];
  topMatches.forEach((p, i) => {
    lines.push(`\n*${i + 1}. ${p.title}*`);
    const parts = [];
    const tx = p.transaction === "rent" ? "إيجار" : "بيع";
    const type = p.propertyType === "apartment" ? "شقة" :
                 p.propertyType === "office" ? "مكتب" :
                 p.propertyType === "shop" ? "محل" :
                 p.propertyType === "storage" ? "مخزن" : "فيلا";
    parts.push(`${type} ${tx}`);
    if (p.location) parts.push(p.location);
    const priceNum = parseNumeric(p.priceNumeric || p.price);
    if (priceNum > 0) parts.push(`${formatNumber(priceNum)} ج.م`);
    if (p.area && !isNaN(parseFloat(p.area))) parts.push(`${formatValue(p.area)} م²`);
    const roomsNum = parseNumeric(p.rooms);
    if (roomsNum >= 1 && roomsNum <= 10) parts.push(`${roomsNum} غرف`);
    lines.push(parts.join(" • "));
    lines.push(`🔗 ${p.url}`);
  });

  lines.push(`\nاختار الرقم أو دوس [⬅️ رجوع] لتعديل طلبك:`);

  const propertyButtons = topMatches.map((_, i) => String(i + 1));
  propertyButtons.push(BTN_BACK);

  return {
    response: lines.join("\n"),
    formState: { ...formState, active: true, flowType: "buyer_select", stepIndex: -1, data, suggestedProperties: topMatches, imageUrls },
    options: propertyButtons,
    done: false, readyToSend: false,
    canShareWhatsapp: false,
    buyerData: data, suggestedProperties: topMatches,
    waMessage: isRent ? buildTenantWaMessage(data, imageUrls) : buildBuyerWaMessage(data, imageUrls),
    leadData: {
      type: transaction === "sale" ? "شراء (نتائج متاحة)" : "إيجار (نتائج متاحة)",
      ...data, score: 5, source: "buyer-flow",
      matchedProperties: topMatches.length
    },
    imageUrls
  };
}

// ═════════════════════════════════════════════════════════
// 🎯 processBuyerSelect
// ═════════════════════════════════════════════════════════
async function processBuyerSelect(formState, userMessage, env, history) {
  const props = formState.suggestedProperties || [];
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  if (isCancel(msg)) {
    return {
      response: `تمام يا فندم، ألغينا.`,
      formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null, imageUrls },
      options: null,
      done: true, cancelled: true, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  if (isBack(msg)) {
    const steps = getBuyerSteps(formState.type);
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: { ...formState, active: true, flowType: "buyer_review", stepIndex: -1, returnStepIndex: 0, reviewButtons: review.buttons, data, imageUrls },
      options: review.buttons,
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const selectButtons = [...props.map((_, i) => String(i + 1)), BTN_BACK];
  const interruptResult = await tryHandleInterrupt(msg, env, selectButtons, formState, null, history);
  if (interruptResult) {
    return {
      response: `${interruptResult.answer}\n\nاختار الرقم أو ارجع لتعديل طلبك:`,
      formState: { ...formState, active: true, flowType: "buyer_select", imageUrls },
      options: selectButtons,
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const normalizedMsg = msg.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const numMatch = normalizedMsg.match(/\d+/);
  const choice = numMatch ? parseInt(numMatch[0], 10) : NaN;

  if (!isNaN(choice) && choice >= 1 && choice <= props.length) {
    const sel = props[choice - 1];
    const selPrice = formatNumber(sel.priceNumeric || sel.price);

    let waMsg = `السلام عليكم أ. طارق،\n\n` +
                `أنا عميل من موقع "سمسار طلبك".\n` +
                `مهتم بالعقار ده اللي شفته على الموقع.\n\n` +
                `━━━━━━━━━━━━━━━━━━\n🏠 *تفاصيل العقار*\n━━━━━━━━━━━━━━━━━━\n` +
                `📌 ${sel.title}\n📍 ${sel.location}\n💰 ${selPrice} ج.م\n🔗 ${sel.url}\n`;

    if (imageUrls.length > 0) {
      waMsg += `\n━━━━━━━━━━━━━━━━━━\n📷 *صور مرفقة*\n━━━━━━━━━━━━━━━━━━\n`;
      imageUrls.forEach((u, i) => {
        const num = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][i] || `${i + 1}.`;
        waMsg += `${num} [اضغط لمعاينة الصورة](${u})\n`;
      });
    }

    waMsg += `\n━━━━━━━━━━━━━━━━━━\n📱 *بيانات التواصل*\n━━━━━━━━━━━━━━━━━━\n📞 الجوال: ${formatValue(data.phone)}\n\nفي انتظار توجيهاتك.\nشكرًا جزيلًا.`;

    return {
      response: `تمام يا فندم، اخترت:\n\n*${sel.title}*\n📍 ${sel.location}\n💰 ${selPrice} ج.م\n\n` +
                `طارق هيتواصل معاك على ${formatValue(data.phone)} خلال ساعات إن شاء الله.\n` +
                `دوس على "ابعت على واتساب" تحت عشان يوصلك التفاصيل كاملة.`,
      formState: {
        ...formState, active: true, lifecycle: LIFECYCLE.COMPLETED, flowType: "buyer_completed",
        selectedProperty: sel,
        data: { ...data, selectedProperty: sel.title, selectedUrl: sel.url },
        imageUrls
      },
      options: POST_COMPLETE_BUTTONS,
      done: true, readyToSend: true, canShareWhatsapp: true,
      waMessage: waMsg,
      imageUrls,
      leadData: {
        type: formState.type === "sale" ? "شراء (اختار عقار)" : "إيجار (اختار عقار)",
        ...data, selectedProperty: sel.title, selectedUrl: sel.url, score: 5, source: "buyer-select"
      }
    };
  }

  return {
    response: `اختار رقم من 1 لـ ${props.length} أو دوس [⬅️ رجوع]:`,
    formState: { ...formState, active: true, flowType: "buyer_select", imageUrls },
    options: selectButtons,
    done: false, readyToSend: false,
    canShareWhatsapp: false,
    imageUrls
  };
}

// ═════════════════════════════════════════════════════════
// 🎯 processBuyerNoResults
// ═════════════════════════════════════════════════════════
async function processBuyerNoResults(formState, userMessage, env, history) {
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  if (isCancel(msg) || /إلغاء|الغاء|cancel|لا شكرا|❌/.test(msg)) {
    return {
      response: "تمام يا فندم، لو حبيت تبدأ من جديد قولّي.",
      formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null, imageUrls },
      options: null,
      done: true, cancelled: true, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const yesNoButtons = ["✅ أيوه سجّل طلبي", "❌ لا شكراً"];

  if (/أيوه|سجل|✅|تمام سجل|عايز أسجل/i.test(msg)) {
    if (!hasValue(data.phone)) {
      return {
        response: `تمام يا فندم، هسجل طلبك.\nاكتب رقمك (11 رقم يبدأ بـ01):`,
        formState: { ...formState, active: true, flowType: "buyer_phone_only", stepIndex: -1, data, imageUrls },
        options: null, done: false, readyToSend: false,
        canShareWhatsapp: false,
        imageUrls
      };
    }

    const waMsg = formState.type === "rent" ? buildTenantWaMessage(data, imageUrls) : buildBuyerWaMessage(data, imageUrls);
    return {
      response: `تمام يا فندم، سجّلت طلبك ✅\n\n` +
                `طارق هيدورلك عند الزملاء، وهيتواصل معاك على ${formatValue(data.phone)}.\n\n` +
                `دوس على "ابعت على واتساب" تحت عشان يوصل طلبك كامل.`,
      formState: { ...formState, active: true, lifecycle: LIFECYCLE.COMPLETED, flowType: "buyer_completed", data, imageUrls },
      options: POST_COMPLETE_BUTTONS,
      done: true, readyToSend: true, canShareWhatsapp: true,
      waMessage: waMsg,
      imageUrls,
      leadData: { type: formState.type === "sale" ? "شراء (طلب معلق)" : "إيجار (طلب معلق)", ...data, score: 5, source: "buyer-pending-request" }
    };
  }

  const interruptResult = await tryHandleInterrupt(msg, env, yesNoButtons, formState, null, history);
  if (interruptResult) {
    return {
      response: `${interruptResult.answer}\n\nعايز أسجّل طلبك؟`,
      formState: { ...formState, active: true, flowType: "buyer_no_results", imageUrls },
      options: yesNoButtons,
      done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  return {
    response: `عايز أسجّل طلبك؟`,
    formState: { ...formState, active: true, flowType: "buyer_no_results", imageUrls },
    options: yesNoButtons,
    done: false, readyToSend: false,
    canShareWhatsapp: false,
    imageUrls
  };
}

// ═════════════════════════════════════════════════════════
// 🎯 processBuyerPhoneOnly
// ═════════════════════════════════════════════════════════
async function processBuyerPhoneOnly(formState, userMessage, env, history) {
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();
  const imageUrls = formState.imageUrls || [];

  const interruptResult = await tryHandleInterrupt(msg, env, [], formState, null, history);
  if (interruptResult) {
    return {
      response: `${interruptResult.answer}\n\nاكتب رقمك (11 رقم يبدأ بـ01):`,
      formState: { ...formState, active: true, flowType: "buyer_phone_only", imageUrls },
      options: null, done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const ph = normalizePhone(msg);

  if (!/^01[0-9]{9}$/.test(ph)) {
    return {
      response: `الرقم مش صح. اكتبه تاني (11 رقم يبدأ بـ01):`,
      formState: { ...formState, active: true, flowType: "buyer_phone_only", imageUrls },
      options: null, done: false, readyToSend: false,
      canShareWhatsapp: false,
      imageUrls
    };
  }

  const newData = { ...data, phone: ph };
  const waMsg = formState.type === "rent" ? buildTenantWaMessage(newData, imageUrls) : buildBuyerWaMessage(newData, imageUrls);

  return {
    response: `تمام يا فندم، سجّلت طلبك ✅\n\nطارق هيتواصل معاك على ${formatValue(ph)}.\n\n` +
              `دوس على "ابعت على واتساب" تحت عشان يوصل طلبك كامل.`,
    formState: { ...formState, active: true, lifecycle: LIFECYCLE.COMPLETED, flowType: "buyer_completed", data: newData, imageUrls },
    options: POST_COMPLETE_BUTTONS,
    done: true, readyToSend: true, canShareWhatsapp: true,
    waMessage: waMsg,
    imageUrls,
    leadData: { type: formState.type === "sale" ? "شراء (طلب معلق)" : "إيجار (طلب معلق)", ...newData, score: 5, source: "buyer-pending-request" }
  };
}

// ═════════════════════════════════════════════════════════
// 📡 Property Feed
// ═════════════════════════════════════════════════════════
let feedCache = { data: null, timestamp: 0 };

async function fetchPropertyFeed() {
  const now = Date.now();
  if (feedCache.data && now - feedCache.timestamp < CACHE_TTL_MS) return feedCache.data;
  try {
    const res = await fetch(AI_FEED_URL, { cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error("Feed fetch failed");
    const data = await res.json();
    feedCache = { data, timestamp: now };
    return data;
  } catch (e) {
    return feedCache.data || { properties: [] };
  }
}

function filterProperties(properties, criteria) {
  return properties.filter(p => {
    const txn = (p.transaction || "sale").toLowerCase();
    if (criteria.transaction && txn !== criteria.transaction) return false;

    const pPrice = parseNumeric(p.priceNumeric || p.price);
    if (pPrice <= 0) return false;

    const loc = (p.location || "").toLowerCase();
    if (!/مدينة نصر|نصر/.test(loc)) return false;

    if (criteria.landmark && !loc.includes(criteria.landmark.toLowerCase())) return false;

    if (criteria.propertyType) {
      const type = (p.propertyType || "apartment").toLowerCase();
      if (type !== criteria.propertyType && !type.includes(criteria.propertyType)) return false;
    }

    if (criteria.furnished !== null && criteria.furnished !== undefined) {
      if (Boolean(p.furnished) !== criteria.furnished) return false;
    }

    if (criteria.budget) {
      const tolerance = criteria.transaction === "rent" ? 0.4 : 0.25;
      if (pPrice < criteria.budget * (1 - tolerance) || pPrice > criteria.budget * (1 + tolerance)) return false;
    }

    if (criteria.rooms) {
      const pRooms = parseNumeric(p.rooms);
      if (pRooms > 0 && Math.abs(pRooms - criteria.rooms) > 1) return false;
    }

    return true;
  });
}

function scoreProperty(property, criteria) {
  let score = 0;
  const pPrice = parseNumeric(property.priceNumeric || property.price);
  if (criteria.budget && pPrice > 0) {
    const diff = Math.abs(pPrice - criteria.budget) / criteria.budget;
    score += (1 - diff) * 40;
  } else if (pPrice > 0) score += 15;
  if (criteria.landmark) {
    const loc = (property.location || "").toLowerCase();
    if (loc.includes(criteria.landmark.toLowerCase())) score += 30;
  } else score += 10;
  if (criteria.propertyType && property.propertyType === criteria.propertyType) score += 20;
  if (criteria.rooms) {
    const pRooms = parseNumeric(property.rooms);
    if (pRooms > 0 && pRooms === criteria.rooms) score += 10;
    else if (pRooms > 0 && Math.abs(pRooms - criteria.rooms) === 1) score += 5;
  }
  return score;
}

function rankedProperties(properties, criteria) {
  return properties
    .map(p => ({ property: p, score: scoreProperty(p, criteria) }))
    .sort((a, b) => b.score - a.score);
}

function extractLandmarkFromLocation(location) {
  if (!location) return null;
  const loc = String(location);
  for (const lm of KNOWN_LANDMARKS) if (loc.includes(lm)) return lm;
  const parts = loc.split(/[-–—،,]/).map(p => p.trim()).filter(Boolean);
  const filtered = parts.filter(p => !/مدينة نصر/.test(p) && p.length > 2);
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    if (last.length <= 40) return last;
  }
  return "مدينة نصر";
}

function getLandmarkButtons(properties) {
  if (!properties || !properties.length) return [BTN_ANY_AREA];
  const landmarksSet = new Set();
  const nasrProperties = properties.filter(p =>
    (p.location || "").includes("مدينة نصر") || (p.location || "").includes("نصر")
  );
  for (const p of nasrProperties) {
    const lm = extractLandmarkFromLocation(p.location);
    if (lm && lm !== "مدينة نصر" && lm.length <= 40) landmarksSet.add(lm);
  }
  let landmarks = Array.from(landmarksSet);
  if (landmarks.length === 0) landmarks = KNOWN_LANDMARKS.slice(0, 8);
  landmarks = landmarks.slice(0, 10);
  landmarks.push(BTN_ANY_AREA);
  return landmarks;
}

// ═════════════════════════════════════════════════════════
// 🎯 detectIntentRegex — V39 FINAL (موسّعة)
// ═════════════════════════════════════════════════════════
function detectIntentRegex(text) {
  const t = String(text || "").trim();
  const tNorm = t.replace(/[أإآ]/g, "ا");

  // ═══ RENT_OWN — مؤجر / صاحب العقار ═══
  if (/عايز\s*(ااجر|أاجر|اجر|اؤجر|أؤجر|أأجر)|عندي\s*(شقة|شقه|عقار|محل|مكتب|مخزن|فيلا).*(للايجار|للإيجار|ااجر|اجر|اؤجر|أأجر)|شقة\s*(للايجار|للإيجار)|عقار\s*(للايجار|للإيجار)|للتاجير|للتأجير|مؤجر|صاحب\s*(شقة|شقه|عقار|محل|مكتب)|مالك\s*(شقة|شقه|عقار|محل|مكتب)|عندي\s*(شقة|عقار)\s*فاضية|ااجر\s*شقتي|أاجر\s*شقتي/i.test(t)) return INTENTS.RENT_OWN;

  // ═══ RENT — مستأجر ═══
  if (/عايز\s*(استاجر|أستاجر|أستأجر|استأجر)|بدور\s*على\s*(ايجار|إيجار)|محتاج\s*(ايجار|إيجار)|مستاجر|مستأجر|عايز\s*(اسكن|أسكن)\s*(ايجار|إيجار)|دور\s*على\s*(ايجار|إيجار)|عايز\s*(شقة|شقه|محل|مكتب)\s*(للايجار|للإيجار)/i.test(t)) return INTENTS.RENT;

  // ═══ SELL_OWN — بيع ═══
  if (/عايز\s*(ابيع|أبيع|بيع)|عندي\s*(شقة|شقه|عقار|محل|مكتب|مخزن|فيلا).*(للبيع|ابيع|أبيع)|شقة\s*(للبيع)|عقار\s*(للبيع)|اسعر\s*شقتي|اسعر\s*عقاري/i.test(t)) return INTENTS.SELL_OWN;

  // ═══ BUY — شراء ═══
  if (/عايز\s*(اشتري|أشتري|شراء)|بدور\s*على\s*(شقة|شقه|عقار|محل|مكتب|فيلا)\s*(للشراء|للتمليك)|محتاج\s*(شقة|شقه|عقار)\s*(للشراء|للتمليك)|ناوي\s*(اشتري|أشتري)|عايز\s*(استثمر|اسكن|أسكن|استقر)|محتاج\s*سكن|للعرايس|للجواز|عايز\s*افتح\s*محل|هشتري|بشتري/i.test(t)) return INTENTS.BUY;

  // ═══ BUTTONS المباشرة ═══
  if (/^(عايز أشتري|عايز اشتري|أشتري|اشتري)$/i.test(tNorm)) return INTENTS.BUY;
  if (/^(عايز أستأجر|عايز استاجر|أستأجر|استأجر|مستأجر)$/i.test(tNorm)) return INTENTS.RENT;
  if (/^(عايز أبيع|عايز ابيع|أبيع|ابيع)$/i.test(tNorm)) return INTENTS.SELL_OWN;
  if (/^(عايز أأجر|عايز اجر|أأجر|ااجر|أؤجر|عايز أؤجر)$/i.test(tNorm)) return INTENTS.RENT_OWN;

  // ═══ INFO / STUDENT ═══
  if (/فين|أين|عنوان|مكان|مواعيد|امتى|بتفتحوا|الموقع/i.test(t)) return INTENTS.INFO;
  if (/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(t)) return INTENTS.STUDENT_HOUSING;

  return INTENTS.OTHER;
}

// ═════════════════════════════════════════════════════════
// 🚀 Main Export
// ═════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    // /upload-images endpoint
    if (new URL(request.url).pathname === "/upload-images" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const images = body.images || [];
        const result = await uploadToImgBB(env, images);
        if (!result.ok) {
          logEvent("IMAGE_UPLOAD", { ok: false, error: result.error, count: images.length });
          return jsonResponse({ error: result.error || "Upload failed" }, 400);
        }
        logEvent("IMAGE_UPLOAD", { ok: true, count: result.urls.length });
        return jsonResponse({ urls: result.urls });
      } catch (err) {
        logEvent("IMAGE_UPLOAD", { ok: false, error: err.message });
        return jsonResponse({ error: "Upload failed" }, 500);
      }
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: getCorsHeaders() });
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(clientIP)) {
      return jsonResponse({
        response: "استنى شوية يا فندم، بتبعت رسايل كتير.",
        options: null, qualificationScore: 0,
        canShareWhatsapp: false, readyToSend: false
      }, 429);
    }

    try {
      const body = await request.json().catch(() => ({}));
      const userMessage = (body.message || body.text || "").trim();
      const rawHistory = body.messages || body.history || [];
      let incomingFormState = body.formState || null;
      const apiKey = env.GEMINI_API_KEY;
      const incomingImageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];

      if (incomingImageUrls.length > 0) {
        if (incomingFormState) {
          incomingFormState.imageUrls = [
            ...(incomingFormState.imageUrls || []),
            ...incomingImageUrls
          ].slice(0, MAX_IMAGES_PER_PROPERTY);
        } else {
          incomingFormState = { imageUrls: incomingImageUrls.slice(0, MAX_IMAGES_PER_PROPERTY), active: false };
        }
      }

      const fullHistory = Array.isArray(rawHistory) ? rawHistory : [];

      logEvent("REQUEST", {
        ip: clientIP,
        message: userMessage.slice(0, 100),
        hasForm: !!incomingFormState,
        lifecycle: incomingFormState?.lifecycle,
        flowType: incomingFormState?.flowType,
        images: incomingImageUrls.length,
        historyLen: fullHistory.length
      });

      if (!apiKey) return jsonResponse({ response: "حصل خطأ مؤقت. حاول تاني.", options: null }, 500);

      if (body.source === "form-complete" && body.data) {
        const formType = body.type === "sale" ? "sale" : "rent";
        return jsonResponse({
          response: "تم استلام بياناتك ✅", reply: "تم استلام بياناتك ✅",
          qualificationScore: 5, canShareWhatsapp: true, readyToSend: true,
          progress: { current: 100, total: 100, remaining: 0, percent: 100 },
          leadData: { type: formType === "sale" ? "بيع عقار" : "إيجار عقار", source: "form", ...body.data },
          waMessage: buildOwnerWaMessage(formType, body.data, incomingImageUrls),
          imageUrls: incomingImageUrls,
          conversationClosed: true
        });
      }

      if (incomingFormState && incomingFormState.lifecycle === LIFECYCLE.COMPLETED) {
        const result = await processPostComplete(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 5,
          canShareWhatsapp: result.canShareWhatsapp !== undefined ? result.canShareWhatsapp : true,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || incomingFormState.imageUrls || []
        });
      }

      // القوائم
      if (!incomingFormState || !incomingFormState.active) {
        if (isBuyBtn(userMessage)) {
          const result = await startBuyerFlow("sale");
          return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 2, canShareWhatsapp: false, readyToSend: false, progress: result.progress, leadData: { type: "شراء (جاري)" }, imageUrls: [] });
        }
        if (isTenantBtn(userMessage)) {
          const result = await startBuyerFlow("rent");
          return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 2, canShareWhatsapp: false, readyToSend: false, progress: result.progress, leadData: { type: "إيجار (جاري)" }, imageUrls: [] });
        }
        if (isSellBtn(userMessage)) {
          const result = startOwnerForm("sale");
          return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 4, canShareWhatsapp: true, readyToSend: false, progress: result.progress, waMessage: null, imageUrls: [], leadData: { type: "بيع (مالك)" } });
        }
        if (isLandlordBtn(userMessage)) {
          const result = startOwnerForm("rent");
          return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 4, canShareWhatsapp: true, readyToSend: false, progress: result.progress, waMessage: null, imageUrls: [], leadData: { type: "إيجار (مالك)" } });
        }
      }

      // owner
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "owner") {
        const result = await processOwnerFlow(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.cancelled ? 1 : (result.done ? 5 : 3),
          canShareWhatsapp: result.cancelled ? false : true,
          readyToSend: result.readyToSend || false,
          progress: result.progress || null,
          leadData: result.leadData || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || incomingFormState.imageUrls || [],
          imageStepAction: result.imageStepAction || null
        });
      }

      // owner_review
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "owner_review") {
        const result = await processReviewScreen(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 3, canShareWhatsapp: true, readyToSend: false,
          progress: result.progress || null, leadData: null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || incomingFormState.imageUrls || []
        });
      }

      // buyer
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer") {
        const result = await processBuyerFlow(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.cancelled ? 1 : (result.done ? 5 : 3),
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: result.progress || null,
          leadData: result.leadData || null,
          buyerData: result.buyerData || null,
          suggestedProperties: result.suggestedProperties || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || incomingFormState.imageUrls || []
        });
      }

      // buyer_review
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_review") {
        const result = await processReviewScreen(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 3, canShareWhatsapp: false, readyToSend: false,
          progress: result.progress || null, leadData: null, waMessage: null,
          imageUrls: result.imageUrls || incomingFormState.imageUrls || []
        });
      }

      // buyer_select
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_select") {
        const result = await processBuyerSelect(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.done ? 5 : 4,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || []
        });
      }

      // buyer_no_results
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_no_results") {
        const result = await processBuyerNoResults(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.done ? 5 : 4,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || []
        });
      }

      // buyer_phone_only
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_phone_only") {
        const result = await processBuyerPhoneOnly(incomingFormState, userMessage, env, fullHistory);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 5,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null,
          waMessage: result.waMessage || null,
          imageUrls: result.imageUrls || []
        });
      }

      // أسعار المتر
      if (isPriceQuery(userMessage)) {
        logEvent("PRICE_QUERY", { message: userMessage });
        return jsonResponse({
          response: await buildPriceResponse(userMessage),
          options: null,
          qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "استعلام أسعار" }
        });
      }

      // عنوان المكتب
      if (isOfficeQuery(userMessage)) {
        logEvent("OFFICE_QUERY", { message: userMessage });
        return jsonResponse({
          response: buildOfficeMessage(),
          options: null,
          qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "استعلام عنوان" }
        });
      }

      // خارج النطاق
      if (isOutOfCoverage(userMessage) && !isInNasrCity(userMessage)) {
        return jsonResponse({
          response: `معلش يا فندم، شغلنا في مدينة نصر بس.`,
          options: null,
          qualificationScore: 0, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "خارج النطاق" }
        });
      }

      // تحليل النية
      const analysis = await this.analyzeIntent(userMessage, fullHistory, apiKey, incomingFormState);

      const extractedBuyer = extractBuyerFields(userMessage);
      const extractedOwner = extractOwnerFields(userMessage);

      if (analysis.intent === INTENTS.SELL_OWN) {
        const result = startOwnerForm("sale", extractedOwner);
        return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 4, canShareWhatsapp: true, readyToSend: false, progress: result.progress, waMessage: null, imageUrls: [], leadData: { type: "بيع (مالك)" } });
      }
      if (analysis.intent === INTENTS.RENT_OWN) {
        const result = startOwnerForm("rent", extractedOwner);
        return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 4, canShareWhatsapp: true, readyToSend: false, progress: result.progress, waMessage: null, imageUrls: [], leadData: { type: "إيجار (مالك)" } });
      }
      if (analysis.intent === INTENTS.BUY) {
        const result = await startBuyerFlow("sale", extractedBuyer);
        return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 2, canShareWhatsapp: false, readyToSend: false, progress: result.progress, leadData: { type: "شراء (جاري)" }, imageUrls: [] });
      }
      if (analysis.intent === INTENTS.RENT) {
        const result = await startBuyerFlow("rent", extractedBuyer);
        return jsonResponse({ response: result.response, reply: result.response, options: result.options, formState: result.formState, qualificationScore: 2, canShareWhatsapp: false, readyToSend: false, progress: result.progress, leadData: { type: "إيجار (جاري)" }, imageUrls: [] });
      }

      if (analysis.intent === INTENTS.STUDENT_HOUSING) {
        return jsonResponse({ response: `سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`, options: null, qualificationScore: 1, canShareWhatsapp: false, readyToSend: false, leadData: { type: "سكن طلاب" } });
      }

      if (/سيارة|عربية|موبايل|أجهزة|ساعة/i.test(userMessage)) {
        return jsonResponse({ response: `بنشتغل في العقارات بس يا فندم.`, options: null, qualificationScore: 0, canShareWhatsapp: false, readyToSend: false, leadData: { type: "غير عقاري" } });
      }

      const metaAnswer = matchInterrupt(userMessage);
      if (metaAnswer) {
        return jsonResponse({ response: metaAnswer, options: null, qualificationScore: 1, canShareWhatsapp: false, readyToSend: false, leadData: { type: "سؤال عام" } });
      }

      if (analysis.answer && String(analysis.answer).trim()) {
        return jsonResponse({ response: String(analysis.answer).trim(), options: null, qualificationScore: 1, canShareWhatsapp: false, readyToSend: false, leadData: { type: "سؤال عام (Gemini)" } });
      }

      if (userMessage.length > 0) {
        const contextualReply = await askGeminiContextual(env, {
          userMessage,
          formState: incomingFormState,
          currentStep: null,
          history: fullHistory
        });
        if (contextualReply) {
          return jsonResponse({ response: contextualReply, options: null, qualificationScore: 1, canShareWhatsapp: false, readyToSend: false, leadData: { type: "سؤال عام (contextual)" } });
        }
        const briefReply = await askGeminiBrief(env, userMessage);
        if (briefReply) {
          return jsonResponse({ response: briefReply, options: null, qualificationScore: 1, canShareWhatsapp: false, readyToSend: false, leadData: { type: "سؤال عام (brief)" } });
        }
      }

      return jsonResponse({
        response: "معاك طارق طنطاوي. اختار طلبك من الأزرار أو اكتبلي محتاج إيه في مدينة نصر.",
        options: null,
        qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
        leadData: { type: "استفسار مبدئي" }
      });

    } catch (err) {
      logEvent("ERROR", { message: err.message, stack: err.stack });
      return jsonResponse({ response: "حصلت مشكلة مؤقتة، جرّب تاني.", options: null }, 500);
    }
  },

  async analyzeIntent(userMessage, history, apiKey, formState) {
    let intent = detectIntentRegex(userMessage);

    if (intent === INTENTS.OTHER) {
      const recentText = (history || [])
        .filter(h => h.role === "user" || h.type === "user")
        .slice(-5)
        .map(h => h.message || h.text || "")
        .join(" ");
      if (recentText) intent = detectIntentRegex(recentText);
    }

    if (intent !== INTENTS.OTHER) return { intent, confidence: 0.9, answer: null };

    const areasData = await fetchAreasData();
    const areasList = (areasData.areas || []).map(a => a.name).join(" / ");
    const cityAvg = areasData.city_avg || {};

    const historyText = (history || []).slice(-10)
      .map(h => `${h.role === "user" ? "العميل" : "طارق"}: ${h.message || h.text || ""}`)
      .join("\n");

    let formContext = "";
    if (formState && formState.active) {
      const flowType = formState.flowType || "unknown";
      const data = formState.data || {};
      const filled = Object.entries(data)
        .filter(([_, v]) => hasValue(v))
        .map(([k, v]) => `${getFieldLabel(k)}: ${v}`)
        .join(" | ");
      formContext = `\n📋 العميل حالياً داخل: ${flowType}${filled ? `\nالبيانات: ${filled}` : ""}`;
    }

    const prompt = `المحادثة:\n${historyText || "(أول رسالة)"}\nالرسالة الجديدة: "${userMessage}"\n${formContext}

🗺️ مناطق مدينة نصر: ${areasList || "(غير محدد)"}
📊 متوسط الأسعار:
- بيع شقق: ${cityAvg.sale_apartment_per_meter || "غير محدد"} ج.م/م²
- إيجار فاضي: ${cityAvg.rent_unfurnished_per_meter || "غير محدد"} ج.م/م²/شهر

حدد نية العميل: SELL_OWN, RENT_OWN, BUY, RENT, INFO, STUDENT_HOUSING, OTHER`;

    try {
      const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: {
            parts: [{
              text: `أنت محلل نوايا لطارق طنطاوي.
رجّع JSON فقط: {"intent":"...","answer":"..."}

- "intent": واحدة من SELL_OWN, RENT_OWN, BUY, RENT, INFO, STUDENT_HOUSING, OTHER.
  * SELL_OWN = صاحب عقار عايز يبيع (بيع/ابيع/اسوق شقتي)
  * RENT_OWN = صاحب عقار عايز يأجر (ااجر/اؤجر/عندي شقة للإيجار)
  * BUY = عايز يشتري (اشتري/شراء/هشتري)
  * RENT = عايز يستأجر (استأجر/مستأجر/عايز أسكن إيجار)
- "answer": لو "intent" = OTHER بس، رد قصير بالعامية المصرية. غير كده خليها "".

⚠️ "شقة للإيجار" من صاحبها = RENT_OWN. "عايز شقة للإيجار" = RENT.`
            }]
          },
          generationConfig: { temperature: 0.15, maxOutputTokens: 200, responseMimeType: "application/json" }
        })
      });
      if (!res.ok) return { intent: INTENTS.OTHER, confidence: 0, answer: null };
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { intent: INTENTS.OTHER, confidence: 0, answer: null };
      const parsed = JSON.parse(jsonMatch[0]);
      const validIntents = [INTENTS.SELL_OWN, INTENTS.RENT_OWN, INTENTS.BUY, INTENTS.RENT, INTENTS.INFO, INTENTS.STUDENT_HOUSING, INTENTS.OTHER];
      const finalIntent = validIntents.includes(parsed.intent) ? parsed.intent : INTENTS.OTHER;
      return { intent: finalIntent, confidence: 0.9, answer: parsed.answer || null };
    } catch (e) {
      return { intent: INTENTS.OTHER, confidence: 0, answer: null };
    }
  }
};
