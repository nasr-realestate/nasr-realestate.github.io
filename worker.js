/* eslint-disable */
// @ts-nocheck
/**
 * Worker: Semsar Talabak - Tarek Tantawy
 * V24 - الإصدار الاحترافي النهائي
 * ============================================================
 * الجديد في V24:
 * - Lifecycle كامل: active → completed → archived
 * - رد مناسب بعد إكمال الفورم (3 خيارات)
 * - شاشة رجوع محسّنة
 * - Logging كامل
 * - State Machine واضح
 */

const ALAA_PHONE = "+201022171667";
const OFFICE_ADDRESS = "16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر";
const OFFICE_MAP_URL = "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7";
const OFFICE_HOURS = "من 12 الضهر لحد 9 بالليل، ما عدا الجمعة";
const AI_FEED_URL = "https://nasr-realestate.github.io/ai-feed.json";
const CACHE_TTL_MS = 5 * 60 * 1000;
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// =====================================================================
// 🎯 الأزرار الأساسية
// =====================================================================
const BTN_BUY = "🔍 أشتري";
const BTN_TENANT = "🏠 أستأجر";
const BTN_SELL = "💰 أبيع";
const BTN_LANDLORD = "🔑 أأجر";

const MAIN_MENU_BUTTONS = [BTN_BUY, BTN_TENANT, BTN_SELL, BTN_LANDLORD];

const BTN_SKIP = "تخطي السؤال ⏭";
const BTN_SEND = "ابعت البيانات دلوقتي ✅";
const BTN_CANCEL = "إلغاء التسجيل ✕";
const BTN_BACK = "⬅️ رجوع";
const BTN_CANCEL_BACK = "إلغاء الرجوع";
const BTN_ANY_AREA = "أي منطقة في مدينة نصر";

// 🆕 أزرار ما بعد الإكمال
const BTN_SEND_WA = "✅ ابعت على واتساب";
const BTN_EDIT = "⬅️ عدّل حاجة";
const BTN_NEW_REQUEST = "🆕 طلب جديد";
const POST_COMPLETE_BUTTONS = [BTN_SEND_WA, BTN_EDIT, BTN_NEW_REQUEST];

const MIN_SCORE_THRESHOLD = 25;
const REQUIRED_IDS = ["propertyType", "location", "price", "ownerPhone"];

// =====================================================================
// 🚫 المناطق
// =====================================================================
const OUT_OF_COVERAGE_PATTERN = /فيصل|الهرم|أكتوبر|اكتوبر|المعادي|الشيخ زايد|الشروق|بدر|حدائق الأهرام|شبرا|المهندسين|الزمالك|العاصمة|التجمع|مصر الجديدة|مدينتي|الرحاب|6 أكتوبر|المقطم|حلوان|طرة|السيدة زينب|وسط البلد|شبرا الخيمة|المرج|عين شمس|المطرية|الزيتون|حلمية الزيتون|حدائق القبة|الوايلي|العباسية|غمرة|التحرير|جاردن سيتي|المنيل|الروضة|القلعة|مدينة السلام|النهضة|الأميرية|الشرابية|روض الفرج|بولاق|الظاهر|الجمالية|الدرب الأحمر|الخليفة|مصر القديمة|الفسطاط|الرمل|الأزاريطة|محرم بك|سموحة|سيدي جابر|العجمي|المنتزه|البيطاش|الهانوفيل/i;

const NASR_CITY_PATTERN = /مدينة نصر|مدينه نصر|نصر|الحي|المنطقة|مكرم عبيد|عباس العقاد|حسن المأمون|مصطفى النحاس|المقريفي|النزهة|الطيران|السفارات|حديقة الطفل|الرقابة الإدارية|الأهلي|الاستاد|الجامعة|شينزو آبي|سونستا|طيبة|الحياة|صن رايز|لا فيدا|جاردينيا|الواحة|truegate|true gate/i;

// =====================================================================
// 🗺️ معالم مدينة نصر
// =====================================================================
const KNOWN_LANDMARKS = [
  "المنطقة السادسة", "المنطقة السابعة", "المنطقة الثامنة", "المنطقة التاسعة",
  "المنطقة العاشرة", "المنطقة الحادية عشر", "الحي الأول", "الحي الثاني",
  "الحي السابع", "الحي العاشر", "مكرم عبيد", "عباس العقاد", "حسن المأمون",
  "مصطفى النحاس", "المقريفي", "النزهة", "الطيران", "السفارات", "حديقة الطفل",
  "الرقابة الإدارية", "الأهلي", "الاستاد", "الجامعة"
];

// =====================================================================
// 🔒 Rate Limiting
// =====================================================================
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

// =====================================================================
// 🧠 النوايا
// =====================================================================
const INTENTS = {
  SELL_OWN: "sell_own",
  RENT_OWN: "rent_own",
  BUY: "buy",
  RENT: "rent",
  INFO: "info",
  STUDENT_HOUSING: "student",
  OTHER: "other"
};

// =====================================================================
// 🎯 Lifecycle — حالات الفورم
// =====================================================================
const LIFECYCLE = {
  ACTIVE: "active",         // الفورم شغال
  COMPLETED: "completed",   // خلص الفورم
  CANCELLED: "cancelled",   // العميل ألغى
  ARCHIVED: "archived"      // بعد ما اتبعت على واتساب أو العميل بدأ جديد
};

// =====================================================================
// 🏠 خطوات فورم المالك — بيع
// =====================================================================
const SALE_STEPS = [
  { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: ["شقة", "مكتب إداري", "محل تجاري"] },
  { id: "location", q: "العقار فين في مدينة نصر؟ (الشارع - المنطقة)", type: "text" },
  { id: "area", q: "المساحة كام متر؟", type: "text" },
  { id: "price", q: "طالب فيه كام؟", type: "text" },
  { id: "rooms", q: "عدد الغرف؟", type: "buttons", options: ["2", "3", "4", "5+"] },
  { id: "baths", q: "عدد الحمامات؟", type: "buttons", options: ["1", "2", "3+"] },
  { id: "floor", q: "الدور؟", type: "buttons", options: ["أرضي", "أول", "ثاني", "متكرر", "أخير"] },
  { id: "finishing", q: "حالة التشطيب؟", type: "buttons", options: ["سوبر لوكس", "نصف تشطيب", "تحتاج تجديد", "طوب أحمر"] },
  { id: "ownerName", q: "اسمك الثلاثي؟", type: "text" },
  { id: "ownerPhone", q: "رقم الواتساب؟", type: "text", validate: /^01[0-9]{9}$/, err: "الرقم مش صح (11 رقم يبدأ بـ01)" },
  { id: "notes", q: "تفاصيل إضافية؟ (تخطي لو مفيش)", type: "text" }
];

// =====================================================================
// 🏠 خطوات فورم المالك — إيجار
// =====================================================================
const RENT_OWN_STEPS = [
  { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: ["شقة", "مكتب إداري", "محل تجاري"] },
  { id: "location", q: "العقار فين في مدينة نصر؟ (الشارع - المنطقة)", type: "text" },
  { id: "area", q: "المساحة كام متر؟", type: "text" },
  { id: "furnished", q: "الإيجار مفروش ولا فاضي (قانون جديد)؟", type: "buttons", options: ["مفروش", "فاضي (قانون جديد)"] },
  { id: "rentPeriods", q: "المدة المتاحة للإيجار؟", type: "buttons", options: ["أسبوعي", "شهري", "سنوي"], condition: (d) => d.furnished === "مفروش" },
  { id: "priceWeekly", q: "سعر الإيجار الأسبوعي كام؟", type: "text", condition: (d) => d.furnished === "مفروش" && (d.rentPeriods === "أسبوعي" || d.rentPeriods === "شهري" || d.rentPeriods === "سنوي") },
  { id: "priceMonthly", q: "سعر الإيجار الشهري كام؟", type: "text", condition: (d) => d.furnished === "مفروش" && (d.rentPeriods === "شهري" || d.rentPeriods === "سنوي") },
  { id: "priceYearly", q: "سعر الإيجار السنوي كام؟", type: "text", condition: (d) => d.furnished === "مفروش" && d.rentPeriods === "سنوي" },
  { id: "furnitureQuality", q: "جودة الأثاث؟", type: "buttons", options: ["سوبر لوكس", "كويسة", "متوسطة"], condition: (d) => d.furnished === "مفروش" },
  { id: "duration", q: "مدة العقد المطلوبة؟", type: "buttons", options: ["سنة", "سنتين", "3 سنين", "4 سنين", "5 سنين"], condition: (d) => d.furnished === "فاضي (قانون جديد)" },
  { id: "price", q: "الإيجار الشهري كام؟", type: "text", condition: (d) => d.furnished === "فاضي (قانون جديد)" },
  { id: "rooms", q: "عدد الغرف؟", type: "buttons", options: ["2", "3", "4", "5+"] },
  { id: "baths", q: "عدد الحمامات؟", type: "buttons", options: ["1", "2", "3+"] },
  { id: "floor", q: "الدور؟", type: "buttons", options: ["أرضي", "أول", "ثاني", "متكرر", "أخير"] },
  { id: "finishing", q: "حالة التشطيب؟", type: "buttons", options: ["سوبر لوكس", "نصف تشطيب", "تحتاج تجديد"] },
  { id: "ownerName", q: "اسمك الثلاثي؟", type: "text" },
  { id: "ownerPhone", q: "رقم الواتساب؟", type: "text", validate: /^01[0-9]{9}$/, err: "الرقم مش صح (11 رقم يبدأ بـ01)" },
  { id: "notes", q: "تفاصيل إضافية؟ (تخطي لو مفيش)", type: "text" }
];

// =====================================================================
// 🛒 خطوات المشتري
// =====================================================================
function getBuyerSteps(transaction) {
  if (transaction === "sale") {
    return [
      { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: ["شقة", "مكتب إداري", "محل تجاري", "فيلا"] },
      { id: "landmark", q: "المنطقة في مدينة نصر؟", type: "dynamic_buttons", dynamicSource: "landmarks" },
      { id: "budget", q: "الميزانية كام؟", type: "text" },
      { id: "rooms", q: "عدد الغرف؟", type: "buttons", options: ["2", "3", "4", "5+"] },
      { id: "urgency", q: "هتشتري امتى؟", type: "buttons", options: ["بأسرع وقت", "خلال شهر", "خلال 3 شهور", "بستكشف"] },
      { id: "phone", q: "رقمك كام؟ (11 رقم يبدأ بـ01)", type: "text", validate: /^01[0-9]{9}$/, err: "الرقم مش صح" }
    ];
  }

  return [
    { id: "propertyType", q: "نوع العقار؟", type: "buttons", options: ["شقة", "مكتب إداري", "محل تجاري"] },
    { id: "landmark", q: "المنطقة في مدينة نصر؟", type: "dynamic_buttons", dynamicSource: "landmarks" },
    { id: "furnished", q: "الإيجار مفروش ولا فاضي (قانون جديد)؟", type: "buttons", options: ["مفروش", "فاضي (قانون جديد)"] },
    { id: "rentPeriods", q: "المدة المفضلة؟", type: "buttons", options: ["أسبوعي", "شهري", "سنوي"], condition: (d) => d.furnished === "مفروش" },
    { id: "duration", q: "مدة العقد المفضلة؟", type: "buttons", options: ["سنة", "سنتين", "3 سنين", "4 سنين", "5 سنين"], condition: (d) => d.furnished === "فاضي (قانون جديد)" },
    { id: "budget", q: "الميزانية الشهرية كام؟", type: "text" },
    { id: "rooms", q: "عدد الغرف؟", type: "buttons", options: ["2", "3", "4", "5+"] },
    { id: "urgency", q: "هتسكن امتى؟", type: "buttons", options: ["بأسرع وقت", "خلال شهر", "خلال 3 شهور", "بستكشف"] },
    { id: "phone", q: "رقمك كام؟ (11 رقم يبدأ بـ01)", type: "text", validate: /^01[0-9]{9}$/, err: "الرقم مش صح" }
  ];
}

// =====================================================================
// 🏷️ أسماء الحقول
// =====================================================================
function getFieldLabel(stepId) {
  const labels = {
    propertyType: "نوع العقار", location: "الموقع", landmark: "المنطقة",
    area: "المساحة", price: "السعر", priceWeekly: "الإيجار الأسبوعي",
    priceMonthly: "الإيجار الشهري", priceYearly: "الإيجار السنوي",
    budget: "الميزانية", rooms: "عدد الغرف", baths: "الحمامات",
    floor: "الدور", finishing: "التشطيب", furnished: "نوع الإيجار",
    furnitureQuality: "جودة الأثاث", duration: "مدة العقد",
    rentPeriods: "المدة", urgency: "الموعد",
    ownerName: "الاسم", ownerPhone: "الرقم", phone: "الرقم", notes: "ملاحظات"
  };
  return labels[stepId] || stepId;
}

// =====================================================================
// 🚫 Canned Rules
// =====================================================================
const INTERRUPT_RULES = [
  { test: /عمول|السعي|سعيكم|نسبتكم|بتاخد(?:وا|و)?\s*كام|هتاخد كام|مصاريف|سمسرة|سمسره/i, answer: "العمولة معلنة ومتفق عليها بعد المعاينة والتقييم. مفيش حاجة مخبية." },
  { test: /^اسمك ايه|^اسمك إيه|حضرتك اسمك|^انت مين|^أنت مين|مين حضرتك/i, answer: "أنا طارق طنطاوي، سمسار مدينة نصر من 2014." },
  { test: /مستعجلين|بتضغطوا|هتبيعوني بسرعة/i, answer: "مش مستعجلين على حساب حقك. بنختار المشتري الجد بس." },
  { test: /بتشتغلوا ازاي|طريقة العمل|بتاخدوا العقار إزاي/i, answer: "معاينة، تقييم، تصوير، تسويق، وبعدين بوصلك العميل الجاد." },
  { test: /عنوانكم|فين مكانكم|نيجي إزاي|فين المكتب/i, answer: `${OFFICE_ADDRESS}\n${OFFICE_MAP_URL}\n${OFFICE_HOURS}` },
  { test: /طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i, answer: `سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}` },
  { test: /ضمان|تأمينكم|هتنصب|بتاخدوا مقدم/i, answer: "شغلنا بالعقد الواضح. مفيش فلوس بتتحرك قبل الاتفاق." }
];

// =====================================================================
// 📊 Logging
// =====================================================================
function logEvent(type, data) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${type}]`, JSON.stringify(data));
}

// =====================================================================
// 🛠️ أدوات
// =====================================================================
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

function isLikelyQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/[؟?]/.test(t)) return true;
  if (/عمول|السعي|نسبتكم|بتاخدوا|هتاخد كام|اسمك ايه|حضرتك اسمك|مستعجلين|بتشتغلوا ازاي|مين حضرتك/i.test(t)) return true;
  if (/^(و)?(ايه|إيه|كام|مين|ازاي|إزاي|ليه|فين|هل|امتى|بكام)\b/.test(t) && t.length < 50) return true;
  return false;
}

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

// 🆕 أزرار ما بعد الإكمال
function isSendWaBtn(msg) {
  return isBtn(msg, BTN_SEND_WA) || /^(ابعت على واتساب|ابعت واتساب|واتساب)$/i.test(String(msg).trim());
}

function isEditBtn(msg) {
  return isBtn(msg, BTN_EDIT) || /^(عدّل حاجة|عدل حاجة|عدل|تعديل)$/i.test(String(msg).trim());
}

function isNewRequestBtn(msg) {
  return isBtn(msg, BTN_NEW_REQUEST) || /^(طلب جديد|جديد|ابدا من جديد|محادثة جديدة)$/i.test(String(msg).trim());
}

// الأزرار الرئيسية
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

// التحقق من النطاق
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

// =====================================================================
// 💰 استخراج السعر
// =====================================================================
function extractFullPrice(text) {
  const cleaned = String(text || "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const million = cleaned.match(/(\d+\.?\d*)\s*(مليون|مليون جنيه)/);
  if (million) return parseFloat(million[1]) * 1000000;
  const thousand = cleaned.match(/(\d+\.?\d*)\s*(الف|ألف|k)\b/i);
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

// =====================================================================
// 📨 رسائل الواتساب
// =====================================================================
function buildOwnerWaMessage(type, data) {
  const typeLabel = type === "sale" ? "بيع" : "إيجار";
  const lines = [
    `السلام عليكم أ. طارق،`,
    `أنا المالك: ${data.ownerName || ""}`,
    `عايز أعرض عقاري:`,
    `─────────────────`,
    `🏷️ المعاملة: ${typeLabel}`
  ];
  if (data.propertyType && data.propertyType !== "شقة") lines.push(`🏠 النوع: ${data.propertyType}`);
  lines.push(`📍 الموقع: ${data.location || ""}`);
  if (hasValue(data.area)) lines.push(`📐 المساحة: ${data.area} م²`);

  if (type === "rent" && data.furnished) {
    lines.push(`🛋️ نوع الإيجار: ${data.furnished}`);
    if (data.furnished === "مفروش") {
      if (hasValue(data.priceWeekly)) lines.push(`📅 الإيجار الأسبوعي: ${data.priceWeekly} ج.م`);
      if (hasValue(data.priceMonthly)) lines.push(`📅 الإيجار الشهري: ${data.priceMonthly} ج.م`);
      if (hasValue(data.priceYearly)) lines.push(`📅 الإيجار السنوي: ${data.priceYearly} ج.م`);
      if (hasValue(data.furnitureQuality)) lines.push(`✨ جودة الأثاث: ${data.furnitureQuality}`);
    } else {
      if (hasValue(data.duration)) lines.push(`📅 مدة العقد: ${data.duration}`);
      if (hasValue(data.price)) lines.push(`💰 الإيجار الشهري: ${data.price} ج.م`);
    }
  } else {
    lines.push(`💰 ${type === "sale" ? "السعر" : "الإيجار"}: ${data.price || ""} ج.م`);
  }

  if (hasValue(data.rooms)) lines.push(`🛏️ الغرف: ${data.rooms}`);
  if (hasValue(data.baths)) lines.push(`🛁 الحمامات: ${data.baths}`);
  if (hasValue(data.floor)) lines.push(`🏢 الدور: ${data.floor}`);
  if (hasValue(data.finishing)) lines.push(`✨ التشطيب: ${data.finishing}`);
  if (hasValue(data.notes) && data.notes !== "لا") lines.push(`📝 ملاحظات: ${data.notes}`);
  lines.push(`─────────────────`);
  lines.push(`📱 رقم التواصل: ${data.ownerPhone || ""}`);
  return lines.join("\n");
}

function buildTenantWaMessage(data) {
  const lines = [
    `السلام عليكم أ. طارق،`,
    `أنا بيدور على إيجار في مدينة نصر ومش لاقي حاجة مناسبة عندكم.`,
    `ياريت تدورلي عند زملائك في نفس المنطقة 🙏`,
    `─────────────────`,
    `🏷️ نوع العقار: ${data.propertyType || "—"}`
  ];
  if (data.furnished) lines.push(`🛋️ نوع الإيجار: ${data.furnished}`);
  if (data.furnished === "مفروش" && data.rentPeriods) lines.push(`📅 المدة: ${data.rentPeriods}`);
  if (data.furnished === "فاضي (قانون جديد)" && data.duration) lines.push(`📅 مدة العقد: ${data.duration}`);
  if (data.landmark && data.landmark !== "__ANY__") lines.push(`📍 المنطقة: ${data.landmark}`);
  else lines.push(`📍 المنطقة: أي منطقة في مدينة نصر`);
  if (hasValue(data.budget)) lines.push(`💰 الميزانية: ${Number(data.budget).toLocaleString("ar-EG")} ج.م`);
  if (hasValue(data.rooms)) lines.push(`🛏️ الغرف: ${data.rooms}`);
  if (hasValue(data.urgency)) lines.push(`⏰ الموعد: ${data.urgency}`);
  lines.push(`─────────────────`);
  lines.push(`📱 رقمي: ${data.phone || ""}`);
  return lines.join("\n");
}

function buildBuyerWaMessage(data) {
  const lines = [
    `السلام عليكم أ. طارق،`,
    `أنا بيدور على شراء في مدينة نصر ومش لاقي حاجة مناسبة عندكم.`,
    `ياريت تدورلي عند زملائك في نفس المنطقة 🙏`,
    `─────────────────`,
    `🏷️ نوع العقار: ${data.propertyType || "—"}`
  ];
  if (data.landmark && data.landmark !== "__ANY__") lines.push(`📍 المنطقة: ${data.landmark}`);
  else lines.push(`📍 المنطقة: أي منطقة في مدينة نصر`);
  if (hasValue(data.budget)) lines.push(`💰 الميزانية: ${Number(data.budget).toLocaleString("ar-EG")} ج.م`);
  if (hasValue(data.rooms)) lines.push(`🛏️ الغرف: ${data.rooms}`);
  if (hasValue(data.urgency)) lines.push(`⏰ الموعد: ${data.urgency}`);
  lines.push(`─────────────────`);
  lines.push(`📱 رقمي: ${data.phone || ""}`);
  return lines.join("\n");
}

// =====================================================================
// 🏷️ شاشة الرجوع
// =====================================================================
function buildReviewScreen(steps, data) {
  const lines = ["اختار السؤال اللي عايز تعدّله:"];
  const buttons = [];
  let counter = 1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (!hasValue(data[step.id])) continue;
    let value = data[step.id];
    if (step.id === "landmark" && value === "__ANY__") value = "أي منطقة";
    if (step.id === "notes" && value === "لا") value = "(مفيش)";
    lines.push(`${counter}. ${getFieldLabel(step.id)}: ${value}`);
    buttons.push(`${counter}`);
    counter++;
  }

  buttons.push(BTN_CANCEL_BACK);
  return { response: lines.join("\n"), buttons };
}

// =====================================================================
// 🛒 إدارة فورم المالك
// =====================================================================
function askStep(steps, idx, formState, prefix) {
  const step = steps[idx];
  const progress = buildProgress(steps, formState.data, idx);
  const question = decorateWithProgress(step.q, progress, true);
  const response = prefix ? `${prefix}\n\n${question}` : question;
  const showBack = formState.stepIndex > 0;
  return {
    response,
    formState: { ...formState, stepIndex: idx, awaitingQuestion: false, flowType: formState.flowType || "owner" },
    options: withControls(step.type === "buttons" ? step.options : [], formState.data, showBack),
    done: false, readyToSend: false,
    progress,
    waMessage: buildOwnerWaMessage(formState.type, formState.data)
  };
}

// 🆕 إكمال فورم المالك
function completeOwnerForm(formState, data) {
  const steps = getSteps(formState.type);
  const waMessage = buildOwnerWaMessage(formState.type, data);
  const total = countTotalSteps(steps, data);

  return {
    response: `تمام، البيانات جاهزة ✅`,
    formState: {
      ...formState,
      stepIndex: -1,
      data,
      lifecycle: LIFECYCLE.COMPLETED,
      flowType: formState.type === "sale" ? "owner_completed_sale" : "owner_completed_rent",
      awaitingQuestion: false
    },
    options: POST_COMPLETE_BUTTONS,
    done: true,
    readyToSend: true,
    progress: { current: total, total, remaining: 0, percent: 100 },
    leadData: { type: formState.type === "sale" ? "بيع عقار (مالك)" : "إيجار عقار (مالك)", ...data },
    waMessage
  };
}

function cancelForm(formState) {
  return {
    response: "تم الإلغاء. لو حبيت تبدأ من جديد، قولّي.",
    formState: {
      active: false,
      lifecycle: LIFECYCLE.CANCELLED,
      type: formState.type,
      stepIndex: -1,
      data: formState.data || {},
      awaitingQuestion: false,
      flowType: null
    },
    options: MAIN_MENU_BUTTONS,
    done: false, readyToSend: false, cancelled: true,
    progress: null, waMessage: null,
    leadData: { type: "إلغاء تسجيل عقار" }
  };
}

function tryCompleteOwner(formState, data) {
  const steps = getSteps(formState.type);
  const missingIdx = findMissingRequired(steps, data);
  if (missingIdx !== -1) {
    const miss = steps[missingIdx];
    return askStep(steps, missingIdx, { ...formState, data, lifecycle: LIFECYCLE.ACTIVE }, `محتاج ${miss.q.replace("؟", "")} بس.`);
  }
  if (!hasValue(data.notes)) data.notes = "لا";
  return completeOwnerForm(formState, data);
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

// =====================================================================
// 🤖 Gemini Brief
// =====================================================================
async function askGeminiBrief(env, question) {
  const apiKey = env && env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const payload = {
      contents: [{ role: "user", parts: [{ text: question }] }],
      systemInstruction: {
        parts: [{
          text: `أنت طارق طنطاوي، سمسار عقارات في مدينة نصر من 2014.

[قواعد صارمة]:
1. اتكلم بالعامية المصرية الأصيلة
2. جاوب في سطر أو سطرين بالكتير
3. كون مباشر ومفيد
4. ممنوع تقول: "يا هلا"، "منور"، "يا باشا"، "لقطة"، "يا غالي"
5. ممنوع تسأل سؤال جديد
6. أعد JSON فقط بالشكل {"answer":"..."}`
        }]
      },
      generationConfig: { maxOutputTokens: 120, temperature: 0.1, responseMimeType: "application/json" }
    };
    const r = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!raw) return null;
    try { return JSON.parse(raw)?.answer?.trim() || null; } catch (_) { return raw; }
  } catch (e) {
    return null;
  }
}

// =====================================================================
// 🎯 تعبئة خطوات المالك
// =====================================================================
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
    if (step.id === "rooms") {
      const n = parseNumeric(trimmed);
      if (n >= 5) { data.rooms = "5+"; return { ok: true }; }
      if (n >= 2 && n <= 4) { data.rooms = String(n); return { ok: true }; }
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

function extractOwnerFields(message) {
  const d = {};
  const t = String(message || "");
  const tNorm = t.replace(/[أإآ]/g, "ا");
  if (/محل|تجارى|تجاري|معرض/.test(tNorm)) d.propertyType = "محل تجاري";
  else if (/مكتب|اداري|إداري/.test(tNorm)) d.propertyType = "مكتب إداري";
  else if (/شقه|شقة|استوديو/.test(tNorm)) d.propertyType = "شقة";
  const area = tNorm.match(/(\d{2,4})\s*(متر|م²|م2)/);
  if (area) d.area = area[1];
  const priceVal = extractFullPrice(t);
  if (priceVal) d.price = String(priceVal);
  const phoneRaw = t.replace(/[٠-٩]/g, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
  const phone = normalizePhone(phoneRaw.match(/01[0-9]{9}/)?.[0] || "");
  if (/^01[0-9]{9}$/.test(phone)) d.ownerPhone = phone;
  return d;
}

function mergeExtracted(data, extracted) {
  const next = { ...data };
  for (const [k, v] of Object.entries(extracted || {})) {
    if (!hasValue(next[k]) && hasValue(v)) next[k] = v;
  }
  return next;
}

function startOwnerForm(type) {
  const steps = getSteps(type);
  const data = {};
  const idx = nextStepIndex(steps, data, 0);
  const formState = {
    active: true,
    lifecycle: LIFECYCLE.ACTIVE,
    type,
    stepIndex: idx,
    data,
    awaitingQuestion: false,
    flowType: "owner"
  };
  return askStep(steps, idx, formState, null);
}

// =====================================================================
// 🔄 معالجة فورم المالك
// =====================================================================
async function processOwnerFlow(formState, userMessage, env) {
  const steps = getSteps(formState.type);
  const data = { ...formState.data };
  const msg = String(userMessage || "").trim();

  if (formState.stepIndex === -1) {
    const idx = nextStepIndex(steps, data, 0);
    return askStep(steps, idx, { ...formState, stepIndex: idx, data });
  }

  if (isCancel(msg)) return cancelForm(formState);
  if (isSendNow(msg)) return tryCompleteOwner(formState, data);

  if (isBack(msg)) {
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, flowType: "owner_review",
        stepIndex: formState.stepIndex, returnStepIndex: formState.stepIndex,
        reviewButtons: review.buttons, data
      },
      options: review.buttons,
      done: false, readyToSend: false
    };
  }

  const currentStep = steps[formState.stepIndex] || steps[nextStepIndex(steps, data, 0)];
  const matchesOption = currentStep && currentStep.type === "buttons" && matchOption(msg, currentStep.options);

  if (!isSkip(msg) && !matchesOption && (formState.awaitingQuestion || isLikelyQuestion(msg))) {
    const canned = matchInterrupt(msg);
    let answer = canned;
    if (!answer) {
      answer = await askGeminiBrief(env, msg);
      if (!answer) answer = "معلش، ممكن نكمّل البيانات الأول؟";
    }
    return askStep(steps, formState.stepIndex, { ...formState, data }, answer);
  }

  if (isSkip(msg)) {
    if (currentStep && currentStep.id === "notes") data.notes = "لا";
    const nextIdx = nextStepIndex(steps, data, formState.stepIndex + 1);
    if (nextIdx === -1) return tryCompleteOwner(formState, data);
    return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data });
  }

  const extracted = extractOwnerFields(msg);
  const merged = mergeExtracted(data, extracted);

  if (!hasValue(merged[currentStep.id])) {
    const filled = fillOwnerStep(currentStep, msg, merged);

    if (filled.reason === "out_of_coverage") {
      return {
        response: `معلش يا فندم، شغلنا في مدينة نصر بس. لو عندك عقار في مدينة نصر، أنا تحت أمرك.`,
        formState: {
          active: false,
          lifecycle: LIFECYCLE.CANCELLED,
          type: formState.type,
          stepIndex: -1,
          data: {},
          awaitingQuestion: false,
          flowType: null
        },
        options: MAIN_MENU_BUTTONS,
        done: false, readyToSend: false, cancelled: true,
        progress: null, waMessage: null,
        leadData: { type: "خارج النطاق (مالك)" }
      };
    }

    if (!filled.ok) {
      if (filled.reason === "question") {
        const canned = matchInterrupt(msg);
        let answer = canned;
        if (!answer) {
          answer = await askGeminiBrief(env, msg);
          if (!answer) answer = "معلش، نكمّل البيانات الأول؟";
        }
        return askStep(steps, formState.stepIndex, { ...formState, data: merged }, answer);
      }
      const progress = buildProgress(steps, merged, formState.stepIndex);
      const showBack = formState.stepIndex > 0;
      return {
        response: `${filled.reason}\n\n${decorateWithProgress(currentStep.q, progress, true)}`,
        formState: { ...formState, data: merged, awaitingQuestion: false },
        options: withControls(currentStep.type === "buttons" ? currentStep.options : [], merged, showBack),
        done: false, readyToSend: false, progress,
        waMessage: buildOwnerWaMessage(formState.type, merged)
      };
    }
  }

  if (formState.isReviewing && formState.returnStepIndex !== undefined) {
    const returnIdx = formState.returnStepIndex;
    if (returnIdx === formState.stepIndex) {
      const nextIdx = nextStepIndex(steps, merged, formState.stepIndex + 1);
      if (nextIdx === -1) return tryCompleteOwner(formState, merged);
      return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data: merged, isReviewing: false, returnStepIndex: undefined });
    }
    return askStep(steps, returnIdx, { ...formState, stepIndex: returnIdx, data: merged, isReviewing: false, returnStepIndex: undefined }, "تمام، عدّلناه. نكمّل.");
  }

  const nextIdx = nextStepIndex(steps, merged, 0);
  if (nextIdx === -1) return tryCompleteOwner(formState, merged);
  return askStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data: merged });
}

// =====================================================================
// 🎯 معالجة ما بعد الإكمال
// =====================================================================
function processPostComplete(formState, userMessage) {
  const msg = String(userMessage || "").trim();
  const data = formState.data || {};

  // ✅ ابعت على واتساب
  if (isSendWaBtn(msg)) {
    return {
      response: `تمام، دوس على البانر الأخضر تحت 👇`,
      formState: { ...formState, lifecycle: LIFECYCLE.ARCHIVED, flowType: null },
      options: null,
      done: true, readyToSend: true, canShareWhatsapp: true,
      leadData: formState.leadData || null,
      waMessage: formState.waMessage || null
    };
  }

  // ⬅️ عدّل حاجة
  if (isEditBtn(msg)) {
    const steps = formState.type === "sale" ? SALE_STEPS : (formState.type === "rent" ? RENT_OWN_STEPS : getBuyerSteps(formState.type));
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE,
        flowType: formState.type === "sale" || formState.type === "rent" ? "owner_review" : "buyer_review",
        stepIndex: -1, returnStepIndex: 0,
        reviewButtons: review.buttons, data
      },
      options: review.buttons,
      done: false, readyToSend: false
    };
  }

  // 🆕 طلب جديد
  if (isNewRequestBtn(msg)) {
    return {
      response: "تمام، اختار نوع الطلب الجديد:",
      formState: {
        active: false,
        lifecycle: LIFECYCLE.ARCHIVED,
        stepIndex: -1,
        data: {},
        awaitingQuestion: false,
        flowType: null
      },
      options: MAIN_MENU_BUTTONS,
      done: false, readyToSend: false
    };
  }

  // أي رسالة تانية
  return {
    response: `تمام، البيانات محفوظة ✅\nاختار:`,
    formState: formState,
    options: POST_COMPLETE_BUTTONS,
    done: true, readyToSend: true,
    leadData: formState.leadData || null,
    waMessage: formState.waMessage || null
  };
}

// =====================================================================
// 🎯 شاشة الرجوع
// =====================================================================
async function processReviewScreen(formState, userMessage, env) {
  const steps = formState.flowType === "owner_review"
    ? getSteps(formState.type)
    : getBuyerSteps(formState.type);
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();

  if (isCancelBack(msg)) {
    const returnIdx = formState.returnStepIndex ?? 0;
    if (formState.flowType === "owner_review") {
      return askStep(steps, returnIdx, { ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "owner", stepIndex: returnIdx, data }, "تمام، كمّلنا.");
    }
    return await askBuyerStep(steps, returnIdx, { ...formState, active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "buyer", stepIndex: returnIdx, data }, "تمام، كمّلنا.");
  }

  const normalized = msg.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const numMatch = normalized.match(/\d+/);
  const choice = numMatch ? parseInt(numMatch[0], 10) : NaN;

  if (isNaN(choice)) {
    return {
      response: "اختار رقم من القايمة أو دوس [إلغاء الرجوع]:",
      formState, options: formState.reviewButtons || [BTN_CANCEL_BACK],
      done: false, readyToSend: false
    };
  }

  const answeredSteps = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.condition && !step.condition(data)) continue;
    if (!hasValue(data[step.id])) continue;
    answeredSteps.push({ step, index: i });
  }

  if (choice < 1 || choice > answeredSteps.length) {
    return {
      response: `اختار رقم من 1 لـ ${answeredSteps.length}:`,
      formState, options: formState.reviewButtons || [BTN_CANCEL_BACK],
      done: false, readyToSend: false
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
    returnStepIndex: returnIdx, isReviewing: true
  };

  if (formState.flowType === "owner_review") {
    return askStep(steps, target.index, newState, `تمام، عدّل ${getFieldLabel(target.step.id)}:`);
  }
  return await askBuyerStep(steps, target.index, newState, `تمام، عدّل ${getFieldLabel(target.step.id)}:`);
}

// =====================================================================
// 🛒 مسار المشتري
// =====================================================================
async function askBuyerStep(steps, idx, formState, prefix) {
  const step = steps[idx];
  const progress = buildProgress(steps, formState.data, idx);
  const question = decorateWithProgress(step.q, progress, true);
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
    buyerData: { ...formState.data }
  };
}

function startBuyerFlow(transaction) {
  const steps = getBuyerSteps(transaction);
  const data = {};
  const idx = 0;
  const formState = {
    active: true, lifecycle: LIFECYCLE.ACTIVE, flowType: "buyer", type: transaction,
    stepIndex: idx, data, awaitingQuestion: false
  };
  return askBuyerStep(steps, idx, formState, null);
}

async function processBuyerFlow(formState, userMessage, env) {
  const steps = getBuyerSteps(formState.type);
  const data = { ...formState.data };
  const msg = String(userMessage || "").trim();

  if (isCancel(msg)) {
    return {
      response: "تم الإلغاء.",
      formState: {
        ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null
      },
      options: MAIN_MENU_BUTTONS,
      done: true, cancelled: true, readyToSend: false,
      buyerData: null, progress: null
    };
  }

  if (isBack(msg)) {
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: {
        ...formState, active: true, flowType: "buyer_review",
        stepIndex: formState.stepIndex, returnStepIndex: formState.stepIndex,
        reviewButtons: review.buttons, data
      },
      options: review.buttons,
      done: false, readyToSend: false
    };
  }

  const currentStep = steps[formState.stepIndex];
  if (!currentStep) {
    return { response: "حصل خطأ، نبدأ من الأول؟", formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED }, options: MAIN_MENU_BUTTONS, done: false, readyToSend: false };
  }

  if (isLikelyQuestion(msg) && currentStep.type !== "buttons" && currentStep.type !== "dynamic_buttons") {
    const canned = matchInterrupt(msg);
    let answer = canned;
    if (!answer) {
      answer = await askGeminiBrief(env, msg);
      if (!answer) answer = "معلش، نكمّل؟";
    }
    return await askBuyerStep(steps, formState.stepIndex, { ...formState, data }, answer);
  }

  if (isSkip(msg)) {
    const nextIdx = formState.stepIndex + 1;
    if (nextIdx >= steps.length) return await completeBuyerFlow(formState, data);
    return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data });
  }

  let filled = { ok: false };
  const trimmed = msg;

  if (currentStep.id === "phone") {
    const ph = normalizePhone(trimmed);
    if (/^01[0-9]{9}$/.test(ph)) { data.phone = ph; filled = { ok: true }; }
    else filled = { ok: false, reason: currentStep.err };
  } else if (currentStep.id === "budget") {
    const price = extractFullPrice(trimmed);
    const num = parseNumeric(trimmed);
    if (!price && num < 1000) filled = { ok: false, reason: "اكتب الميزانية رقم." };
    else { data.budget = price || num; filled = { ok: true }; }
  } else if (currentStep.id === "landmark") {
    if (isOutOfCoverage(trimmed)) {
      return {
        response: `معلش يا فندم، شغلنا في مدينة نصر بس.`,
        formState: { active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null, type: formState.type, stepIndex: -1, data: {}, awaitingQuestion: false },
        options: MAIN_MENU_BUTTONS,
        done: false, readyToSend: false, cancelled: true,
        buyerData: null, progress: null,
        leadData: { type: "خارج النطاق (مشتري/مستأجر)" }
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
      response: `${filled.reason}\n\n${decorateWithProgress(currentStep.q, progress, true)}`,
      formState: { ...formState, data }, options: opts,
      done: false, readyToSend: false, progress, buyerData: data
    };
  }

  if (formState.isReviewing && formState.returnStepIndex !== undefined) {
    const returnIdx = formState.returnStepIndex;
    if (returnIdx === formState.stepIndex) {
      const nextIdx = formState.stepIndex + 1;
      if (nextIdx >= steps.length) return await completeBuyerFlow(formState, data);
      return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data, isReviewing: false, returnStepIndex: undefined });
    }
    return await askBuyerStep(steps, returnIdx, { ...formState, stepIndex: returnIdx, data, isReviewing: false, returnStepIndex: undefined }, "تمام، عدّلناه. نكمّل.");
  }

  const nextIdx = formState.stepIndex + 1;
  if (nextIdx >= steps.length) return await completeBuyerFlow(formState, data);
  return await askBuyerStep(steps, nextIdx, { ...formState, stepIndex: nextIdx, data });
}

// =====================================================================
// ✅ عرض العقارات
// =====================================================================
async function completeBuyerFlow(formState, data) {
  const transaction = formState.type;
  const feed = await fetchPropertyFeed();
  const allProperties = feed.properties || [];

  const criteria = {
    transaction,
    landmark: data.landmark && data.landmark !== "__ANY__" ? data.landmark : null,
    propertyType: data.propertyType === "شقة" ? "apartment" :
                  data.propertyType === "مكتب إداري" ? "office" :
                  data.propertyType === "محل تجاري" ? "shop" : "villa",
    budget: data.budget,
    rooms: parseNumeric(data.rooms),
    furnished: data.furnished === "مفروش" ? true : (data.furnished === "فاضي (قانون جديد)" ? false : null)
  };

  const filtered = filterProperties(allProperties, criteria);
  const ranked = rankedProperties(filtered, criteria);
  const topMatches = ranked.filter(x => x.score >= MIN_SCORE_THRESHOLD).slice(0, 5).map(x => x.property);

  const areaLabel = !data.landmark || data.landmark === "__ANY__" ? "مدينة نصر" : data.landmark;

  if (topMatches.length === 0) {
    const isRent = transaction === "rent";
    const waMsg = isRent ? buildTenantWaMessage(data) : buildBuyerWaMessage(data);

    return {
      response: `مفيش ${data.propertyType} ${isRent ? "إيجار" : "بيع"} في ${areaLabel} بميزانية ${Number(data.budget).toLocaleString("ar-EG")} ج.م حالياً.\n\nبس أقدر أسجّل طلبك كامل وأبعته لطارق يدورلك عند الزملاء والمكاتب المعتمدة.`,
      formState: { ...formState, active: true, flowType: "buyer_no_results", stepIndex: -1, data },
      options: ["✅ أيوه سجّل طلبي", "❌ لا شكراً"],
      done: false, readyToSend: false,
      buyerData: data, waMessage: waMsg,
      leadData: { type: isRent ? "إيجار (بدون نتائج)" : "شراء (بدون نتائج)", ...data, score: 5, source: "buyer-no-results" }
    };
  }

  const lines = [`دي أنسب ${topMatches.length} حاجة لطلبك:`];
  topMatches.forEach((p, i) => {
    lines.push(`\n*${i + 1}. ${p.title}*`);
    const parts = [];
    const tx = p.transaction === "rent" ? "إيجار" : "بيع";
    const type = p.propertyType === "apartment" ? "شقة" : p.propertyType === "office" ? "مكتب" : p.propertyType === "shop" ? "محل" : "فيلا";
    parts.push(`${type} ${tx}`);
    if (p.location) parts.push(p.location);
    const priceNum = parseNumeric(p.priceNumeric || p.price);
    if (priceNum > 0) parts.push(`${priceNum.toLocaleString("ar-EG")} ج.م`);
    if (p.area && !isNaN(parseFloat(p.area))) parts.push(`${p.area} م²`);
    const roomsNum = parseNumeric(p.rooms);
    if (roomsNum >= 1 && roomsNum <= 10) parts.push(`${roomsNum} غرف`);
    lines.push(parts.join(" • "));
    lines.push(`🔗 ${p.url}`);
  });

  lines.push(`\nاختار الرقم أو ارجع لتعديل طلبك:`);

  const propertyButtons = topMatches.map((_, i) => String(i + 1));
  propertyButtons.push(BTN_BACK);

  return {
    response: lines.join("\n"),
    formState: {
      ...formState, active: true, flowType: "buyer_select",
      stepIndex: -1, data, suggestedProperties: topMatches
    },
    options: propertyButtons,
    done: false, readyToSend: false,
    buyerData: data, suggestedProperties: topMatches,
    waMessage: transaction === "rent" ? buildTenantWaMessage(data) : buildBuyerWaMessage(data),
    leadData: {
      type: transaction === "sale" ? "شراء (نتائج متاحة)" : "إيجار (نتائج متاحة)",
      ...data, score: 5, source: "buyer-flow",
      matchedProperties: topMatches.length
    }
  };
}

// =====================================================================
// 🎯 اختيار العقار
// =====================================================================
async function processBuyerSelect(formState, userMessage, env) {
  const props = formState.suggestedProperties || [];
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();

  if (isCancel(msg)) {
    return {
      response: "تم الإلغاء.",
      formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null },
      options: MAIN_MENU_BUTTONS,
      done: true, cancelled: true, readyToSend: false
    };
  }

  if (isBack(msg)) {
    const steps = getBuyerSteps(formState.type);
    const review = buildReviewScreen(steps, data);
    return {
      response: review.response,
      formState: { ...formState, active: true, flowType: "buyer_review", stepIndex: -1, returnStepIndex: 0, reviewButtons: review.buttons, data },
      options: review.buttons,
      done: false, readyToSend: false
    };
  }

  const normalizedMsg = msg.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const numMatch = normalizedMsg.match(/\d+/);
  const choice = numMatch ? parseInt(numMatch[0], 10) : NaN;

  if (!isNaN(choice) && choice >= 1 && choice <= props.length) {
    const sel = props[choice - 1];
    const selPrice = Number(sel.priceNumeric || sel.price).toLocaleString("ar-EG");
    return {
      response: `تمام، اخترت:\n\n*${sel.title}*\n📍 ${sel.location}\n💰 ${selPrice} ج.م\n\nهبعتلك تفاصيل المعاينة على ${data.phone}.`,
      formState: {
        ...formState,
        active: true,
        lifecycle: LIFECYCLE.COMPLETED,
        flowType: "buyer_completed",
        selectedProperty: sel,
        data: { ...data, selectedProperty: sel.title, selectedUrl: sel.url }
      },
      options: POST_COMPLETE_BUTTONS,
      done: true, readyToSend: true, canShareWhatsapp: true,
      waMessage: `أستاذ طارق، أنا مهتم بالعقار ده:\n\n${sel.title}\n${sel.url}\n\n📍 ${sel.location}\n💰 ${selPrice} ج.م\n\nرقمي: ${data.phone}`,
      leadData: {
        type: formState.type === "sale" ? "شراء (اختار عقار)" : "إيجار (اختار عقار)",
        ...data, selectedProperty: sel.title, selectedUrl: sel.url, score: 5, source: "buyer-select"
      }
    };
  }

  return {
    response: `اختار رقم من 1 لـ ${props.length} أو دوس [⬅️ رجوع]:`,
    formState: { ...formState, active: true, flowType: "buyer_select" },
    options: [...props.map((_, i) => String(i + 1)), BTN_BACK],
    done: false, readyToSend: false
  };
}

// =====================================================================
// 🎯 الطلبات المعلقة
// =====================================================================
async function processBuyerNoResults(formState, userMessage, env) {
  const data = formState.data || {};
  const msg = String(userMessage || "").trim();

  if (isCancel(msg) || /إلغاء|الغاء|cancel|لا شكرا|❌/.test(msg)) {
    return {
      response: "تمام، لو حبيت تبدأ من جديد قولّي.",
      formState: { ...formState, active: false, lifecycle: LIFECYCLE.CANCELLED, flowType: null },
      options: MAIN_MENU_BUTTONS,
      done: true, cancelled: true, readyToSend: false
    };
  }

  if (/أيوه|سجل|✅|تمام سجل|عايز أسجل/i.test(msg)) {
    if (!hasValue(data.phone)) {
      return {
        response: `تمام، هسجل طلبك. اكتب رقمك (11 رقم يبدأ بـ01):`,
        formState: { ...formState, active: true, flowType: "buyer_phone_only", stepIndex: -1, data },
        options: null, done: false, readyToSend: false
      };
    }

    const waMsg = formState.type === "rent" ? buildTenantWaMessage(data) : buildBuyerWaMessage(data);
    return {
      response: `تمام، سجلت طلبك ✅\nهبعت طلبك لطارق يدورلك عند الزملاء والمكاتب المعتمدة.`,
      formState: {
        ...formState,
        active: true,
        lifecycle: LIFECYCLE.COMPLETED,
        flowType: "buyer_completed",
        data
      },
      options: POST_COMPLETE_BUTTONS,
      done: true, readyToSend: true, canShareWhatsapp: true,
      waMessage: waMsg,
      leadData: { type: formState.type === "sale" ? "شراء (طلب معلق)" : "إيجار (طلب معلق)", ...data, score: 5, source: "buyer-pending-request" }
    };
  }

  return {
    response: `عايز أسجّل طلبك؟`,
    formState: { ...formState, active: true, flowType: "buyer_no_results" },
    options: ["✅ أيوه سجّل طلبي", "❌ لا شكراً"],
    done: false, readyToSend: false
  };
}

async function processBuyerPhoneOnly(formState, userMessage, env) {
  const data = formState.data || {};
  const ph = normalizePhone(userMessage);

  if (!/^01[0-9]{9}$/.test(ph)) {
    return {
      response: `الرقم مش صح. اكتبه تاني (11 رقم يبدأ بـ01):`,
      formState: { ...formState, active: true, flowType: "buyer_phone_only" },
      options: null, done: false, readyToSend: false
    };
  }

  const newData = { ...data, phone: ph };
  const waMsg = formState.type === "rent" ? buildTenantWaMessage(newData) : buildBuyerWaMessage(newData);

  return {
    response: `تمام، سجلت طلبك ✅`,
    formState: {
      ...formState,
      active: true,
      lifecycle: LIFECYCLE.COMPLETED,
      flowType: "buyer_completed",
      data: newData
    },
    options: POST_COMPLETE_BUTTONS,
    done: true, readyToSend: true, canShareWhatsapp: true,
    waMessage: waMsg,
    leadData: { type: formState.type === "sale" ? "شراء (طلب معلق)" : "إيجار (طلب معلق)", ...newData, score: 5, source: "buyer-pending-request" }
  };
}

// =====================================================================
// 🏠 جلب العقارات
// =====================================================================
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

// =====================================================================
// 🔍 فلترة
// =====================================================================
function filterProperties(properties, criteria) {
  return properties.filter(p => {
    const txn = (p.transaction || "sale").toLowerCase();
    if (criteria.transaction && txn !== criteria.transaction) return false;

    const pPrice = parseNumeric(p.priceNumeric || p.price);
    if (pPrice <= 0) return false;

    const loc = (p.location || "").toLowerCase();
    if (!/مدينة نصر|نصر/.test(loc)) return false;

    if (criteria.landmark) {
      if (!loc.includes(criteria.landmark.toLowerCase())) return false;
    }

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
  } else if (pPrice > 0) {
    score += 15;
  }

  if (criteria.landmark) {
    const loc = (property.location || "").toLowerCase();
    if (loc.includes(criteria.landmark.toLowerCase())) score += 30;
  } else {
    score += 10;
  }

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

// =====================================================================
// 🗺️ استخراج المعالم
// =====================================================================
function extractLandmarkFromLocation(location) {
  if (!location) return null;
  const loc = String(location);
  for (const lm of KNOWN_LANDMARKS) {
    if (loc.includes(lm)) return lm;
  }
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

// =====================================================================
// 🧠 كشف النية
// =====================================================================
function detectIntentRegex(text) {
  const t = String(text || "").trim();
  const tNorm = t.replace(/[أإآ]/g, "ا");

  if (/^(عايز أشتري|عايز اشتري|أشتري|اشتري|ناوي أشتري|ناوي اشتري)$/i.test(tNorm)) return INTENTS.BUY;
  if (/^(عايز أستأجر|عايز استاجر|أستأجر|استأجر|مستأجر|عايز أستاجر)$/i.test(tNorm)) return INTENTS.RENT;
  if (/^(عايز أبيع|عايز ابيع|أبيع|ابيع|ناوي أبيع)$/i.test(tNorm)) return INTENTS.SELL_OWN;
  if (/^(عايز أأجر|عايز اجر|أأجر|ااجر|أؤجر|عايز أؤجر|مؤجر)$/i.test(tNorm)) return INTENTS.RENT_OWN;

  if (/^(شراء|تمليك|بشتري|هشتري|سكن|سكني|استثمار|للسكن|للاستثمار)$/i.test(tNorm)) return INTENTS.BUY;
  if (/^(ايجار|إيجار|للايجار|للإيجار|أجر|اجر|استئجار|مفروش|مستأجر)$/i.test(tNorm)) return INTENTS.RENT;
  if (/^(بيع|للبيع|ابيع|أبيع)$/i.test(tNorm)) return INTENTS.SELL_OWN;
  if (/^(تأجير|للتأجير|تاجير|ااجر|أأجر|أؤجر)$/i.test(tNorm)) return INTENTS.RENT_OWN;
  if (/^(شقة|شقه|عقار|محل|مكتب|فيلا|استوديو)$/i.test(tNorm)) return INTENTS.BUY;

  if (/أبيع|ابيع|عايز أبيع|للبيع|أعرض عقار|أعرض شقة|تسوقلي|أسعر شقتي|أسعر عقاري|عايز أسلّك|بيع شقة|بيع عقار/i.test(t)) return INTENTS.SELL_OWN;
  if (/أأجر|اجر|أجّر|عايز أأجر|عايز أجر|عندي.*للإيجار|للايجار.*عندي|للتأجير|أؤجر|عايز أؤجر/i.test(t)) return INTENTS.RENT_OWN;
  if (/أشتري|اشتري|شراء|تمليك|عايز شقة|محتاج شقة|بدور على شقة|دور على شقة|عايز عقار|محتاج عقار|عايز أستثمر|عايز أستقر|عايز أسكن|محتاج سكن|للعرايس|للجواز|عايز أفتح محل|عايز مكتب|محتاج مكتب|ناوي أشتري|بشتري|هشتري/i.test(t)) return INTENTS.BUY;
  if (/إيجار|ايجار|إيجار شهري|مفروش|مفروشة|دور على إيجار|محتاج إيجار|عايز إيجار|أستأجر|مستأجر|عايز أسكن إيجار|قانون جديد/i.test(t)) return INTENTS.RENT;

  if (/فين|أين|عنوان|مكان|مواعيد|امتى|بتفتحوا|الموقع/i.test(t)) return INTENTS.INFO;
  if (/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(t)) return INTENTS.STUDENT_HOUSING;

  return INTENTS.OTHER;
}

// =====================================================================
// 🎯 المعالج الرئيسي
// =====================================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: getCorsHeaders() });
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(clientIP)) {
      return jsonResponse({ response: "استنى شوية، بتبعت رسايل كتير.", options: MAIN_MENU_BUTTONS, qualificationScore: 0, canShareWhatsapp: false, readyToSend: false }, 429);
    }

    try {
      const body = await request.json().catch(() => ({}));
      const userMessage = (body.message || body.text || "").trim();
      const rawHistory = body.messages || body.history || [];
      const incomingFormState = body.formState || null;
      const apiKey = env.GEMINI_API_KEY;

      logEvent("REQUEST", { ip: clientIP, message: userMessage.slice(0, 100), hasForm: !!incomingFormState, lifecycle: incomingFormState?.lifecycle });

      if (!apiKey) return jsonResponse({ response: "حصل خطأ مؤقت. حاول تاني.", options: MAIN_MENU_BUTTONS }, 500);

      // A. فورم مكتمل خارجي
      if (body.source === "form-complete" && body.data) {
        const formType = body.type === "sale" ? "sale" : "rent";
        return jsonResponse({
          response: "تم استلام بياناتك ✅", reply: "تم استلام بياناتك ✅",
          qualificationScore: 5, canShareWhatsapp: true, readyToSend: true,
          progress: { current: 100, total: 100, remaining: 0, percent: 100 },
          leadData: { type: formType === "sale" ? "بيع عقار" : "إيجار عقار", source: "form", ...body.data },
          waMessage: buildOwnerWaMessage(formType, body.data),
          conversationClosed: true
        });
      }

      // 🆕 B. معالجة حالات ما بعد الإكمال (قبل أي شيء)
      if (incomingFormState && incomingFormState.lifecycle === LIFECYCLE.COMPLETED) {
        logEvent("POST_COMPLETE", { flowType: incomingFormState.flowType });
        const result = processPostComplete(incomingFormState, userMessage);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 5,
          canShareWhatsapp: result.canShareWhatsapp || true,
          readyToSend: result.readyToSend || false,
          progress: null,
          leadData: result.leadData || null,
          waMessage: result.waMessage || null
        });
      }

      // C. الأزرار الأربعة الأساسية
      if (!incomingFormState || !incomingFormState.active) {
        if (isBuyBtn(userMessage)) {
          logEvent("START_BUYER_SALE", {});
          const result = await startBuyerFlow("sale");
          return jsonResponse({
            response: result.response, reply: result.response,
            options: result.options, formState: result.formState,
            qualificationScore: 2, canShareWhatsapp: false, readyToSend: false,
            progress: result.progress,
            leadData: { type: "شراء (جاري)" }
          });
        }
        if (isTenantBtn(userMessage)) {
          logEvent("START_BUYER_RENT", {});
          const result = await startBuyerFlow("rent");
          return jsonResponse({
            response: result.response, reply: result.response,
            options: result.options, formState: result.formState,
            qualificationScore: 2, canShareWhatsapp: false, readyToSend: false,
            progress: result.progress,
            leadData: { type: "إيجار (جاري)" }
          });
        }
        if (isSellBtn(userMessage)) {
          logEvent("START_OWNER_SALE", {});
          const result = startOwnerForm("sale");
          return jsonResponse({
            response: result.response, reply: result.response,
            options: result.options, formState: result.formState,
            qualificationScore: 4, canShareWhatsapp: true, readyToSend: false,
            progress: result.progress, waMessage: null,
            leadData: { type: "بيع (مالك)" }
          });
        }
        if (isLandlordBtn(userMessage)) {
          logEvent("START_OWNER_RENT", {});
          const result = startOwnerForm("rent");
          return jsonResponse({
            response: result.response, reply: result.response,
            options: result.options, formState: result.formState,
            qualificationScore: 4, canShareWhatsapp: true, readyToSend: false,
            progress: result.progress, waMessage: null,
            leadData: { type: "إيجار (مالك)" }
          });
        }
      }

      // D. فورم المالك
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "owner") {
        const result = await processOwnerFlow(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.cancelled ? 1 : (result.done ? 5 : 3),
          canShareWhatsapp: result.cancelled ? false : true,
          readyToSend: result.readyToSend || false,
          progress: result.progress || null,
          leadData: result.leadData || null,
          waMessage: result.waMessage || null
        });
      }

      // D2. شاشة رجوع المالك
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "owner_review") {
        const result = await processReviewScreen(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 3, canShareWhatsapp: true, readyToSend: false,
          progress: result.progress || null, leadData: null, waMessage: result.waMessage || null
        });
      }

      // E. فورم المشتري
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer") {
        const result = await processBuyerFlow(incomingFormState, userMessage, env);
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
          waMessage: result.waMessage || null
        });
      }

      // E2. شاشة رجوع المشتري
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_review") {
        const result = await processReviewScreen(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 3, canShareWhatsapp: false, readyToSend: false,
          progress: result.progress || null, leadData: null, waMessage: null
        });
      }

      // E3. اختيار عقار
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_select") {
        const result = await processBuyerSelect(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.done ? 5 : 4,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null, waMessage: result.waMessage || null
        });
      }

      // E4. مفيش نتائج
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_no_results") {
        const result = await processBuyerNoResults(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: result.done ? 5 : 4,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null, waMessage: result.waMessage || null
        });
      }

      // E5. رقم فقط
      if (incomingFormState && incomingFormState.active && incomingFormState.flowType === "buyer_phone_only") {
        const result = await processBuyerPhoneOnly(incomingFormState, userMessage, env);
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 5,
          canShareWhatsapp: result.canShareWhatsapp || false,
          readyToSend: result.readyToSend || false,
          progress: null, leadData: result.leadData || null, waMessage: result.waMessage || null
        });
      }

      // F. التحقق من النطاق
      if (isOutOfCoverage(userMessage) && !isInNasrCity(userMessage)) {
        logEvent("OUT_OF_COVERAGE", { message: userMessage });
        return jsonResponse({
          response: `معلش يا فندم، شغلنا في مدينة نصر بس. لو بتدور في مدينة نصر، أنا تحت أمرك.`,
          options: MAIN_MENU_BUTTONS,
          qualificationScore: 0, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "خارج النطاق" }
        });
      }

      // G. كشف النية
      const analysis = await this.analyzeIntent(userMessage, rawHistory, apiKey);

      if (analysis.intent === INTENTS.SELL_OWN) {
        const result = startOwnerForm("sale");
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 4, canShareWhatsapp: true, readyToSend: false,
          progress: result.progress, waMessage: null,
          leadData: { type: "بيع (مالك)" }
        });
      }
      if (analysis.intent === INTENTS.RENT_OWN) {
        const result = startOwnerForm("rent");
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 4, canShareWhatsapp: true, readyToSend: false,
          progress: result.progress, waMessage: null,
          leadData: { type: "إيجار (مالك)" }
        });
      }
      if (analysis.intent === INTENTS.BUY) {
        const result = await startBuyerFlow("sale");
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 2, canShareWhatsapp: false, readyToSend: false,
          progress: result.progress,
          leadData: { type: "شراء (جاري)" }
        });
      }
      if (analysis.intent === INTENTS.RENT) {
        const result = await startBuyerFlow("rent");
        return jsonResponse({
          response: result.response, reply: result.response,
          options: result.options, formState: result.formState,
          qualificationScore: 2, canShareWhatsapp: false, readyToSend: false,
          progress: result.progress,
          leadData: { type: "إيجار (جاري)" }
        });
      }

      // H. معلومات / طلاب
      if (analysis.intent === INTENTS.INFO) {
        return jsonResponse({
          response: `${OFFICE_ADDRESS}\n${OFFICE_MAP_URL}\n${OFFICE_HOURS}`,
          options: MAIN_MENU_BUTTONS,
          qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "معلومات" }
        });
      }
      if (analysis.intent === INTENTS.STUDENT_HOUSING) {
        return jsonResponse({
          response: `سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`,
          options: MAIN_MENU_BUTTONS,
          qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "سكن طلاب" }
        });
      }

      // I. غير عقاري
      if (/سيارة|عربية|موبايل|أجهزة|ساعة/i.test(userMessage)) {
        return jsonResponse({
          response: `بنشتغل في العقارات بس.`,
          options: MAIN_MENU_BUTTONS,
          qualificationScore: 0, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "غير عقاري" }
        });
      }

      // J. سؤال جانبي
      const metaAnswer = matchInterrupt(userMessage);
      if (metaAnswer) {
        return jsonResponse({
          response: metaAnswer,
          options: MAIN_MENU_BUTTONS,
          qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
          leadData: { type: "سؤال عام" }
        });
      }

      // K. Gemini
      // أي رسالة عامة لم تدخل مساراً أو قاعدة ثابتة تصل إلى Gemini.
      // الترحيب الأول لا يمر من هنا؛ صفحة agent.html ترسله محلياً بدون Gemini.
      if (userMessage.length > 0) {
        const geminiReply = await askGeminiBrief(env, userMessage);
        if (geminiReply) {
          return jsonResponse({
            response: geminiReply,
            options: MAIN_MENU_BUTTONS,
            qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
            leadData: { type: "سؤال عام (Gemini)" }
          });
        }
      }

      // L. رد افتراضي
      return jsonResponse({
        response: "معاك طارق طنطاوي. اختار طلبك من الأزرار أو اكتبلي محتاج إيه في مدينة نصر.",
        options: MAIN_MENU_BUTTONS,
        qualificationScore: 1, canShareWhatsapp: false, readyToSend: false,
        leadData: { type: "استفسار مبدئي" }
      });

    } catch (err) {
      logEvent("ERROR", { message: err.message, stack: err.stack });
      return jsonResponse({ response: "حصلت مشكلة مؤقتة، جرّب تاني.", options: MAIN_MENU_BUTTONS }, 500);
    }
  },

  async analyzeIntent(userMessage, history, apiKey) {
    let intent = detectIntentRegex(userMessage);

    if (intent === INTENTS.OTHER) {
      const recentText = (history || [])
        .filter(h => h.role === "user" || h.type === "user")
        .slice(-5)
        .map(h => h.message || h.text || "")
        .join(" ");
      if (recentText) intent = detectIntentRegex(recentText);
    }

    if (intent !== INTENTS.OTHER) return { intent, confidence: 0.9 };

    const historyText = (history || []).slice(-6)
      .map(h => `${h.role === "user" ? "العميل" : "أنا"}: ${h.message || h.text || ""}`)
      .join("\n");

    const prompt = `المحادثة:\n${historyText || "(أول رسالة)"}\nالرسالة الجديدة: "${userMessage}"\n\nحدد نية العميل: SELL_OWN, RENT_OWN, BUY, RENT, INFO, STUDENT_HOUSING, OTHER`;

    try {
      const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: `أنت محلل نوايا. رد بـ JSON بس: {"intent":"BUY","confidence":0.9}` }] },
          generationConfig: { temperature: 0.1, maxOutputTokens: 50, responseMimeType: "application/json" }
        })
      });
      if (!res.ok) return { intent: INTENTS.OTHER, confidence: 0 };
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { intent: INTENTS.OTHER, confidence: 0 };
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return { intent: INTENTS.OTHER, confidence: 0 };
    }
  }
};
