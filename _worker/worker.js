// ============================================================
// سمسار طلبك — Cloudflare Worker v8.3-FINAL
// طارق طنطاوي | مدينة نصر | 2014–2026
// Google Local Guide Level 7 | 16.3M+ Views
// Gemini في كل محادثة + لا تعليق + رسالة مؤهلة كاملة
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

function normAr(s) {
  return String(s||"")
    .replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[أإآٱ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي")
    .replace(/[ًٌٍَُِّْـ]/g,"").replace(/[^\w\u0600-\u06FF]/g,"")
    .toLowerCase().trim();
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
function levenshtein(a, b) {
  if (!a || !b) return Math.max(a?.length || 0, b?.length || 0);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
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
  { re: /^اسمك ايه|حضرتك اسمك|^انت مين|مين حضرتك/i, ans: "أنا طارق طنطاوي، سمسار مدينة نصر من 2014." },
  { re: /بتشتغلوا ازاي|طريقة العمل/i, ans: "معاينة، تقييم، تصوير، تسويق — وبعدين أوصلك العميل الجاد." },
  { re: /ضمان|هتنصب|بتاخدوا مقدم/i, ans: "شغلنا بالعقد الواضح. مفيش فلوس بتتحرك قبل الاتفاق." },
  { re: /المواعيد|بتفتحوا امتى|بتقفلوا امتى|ساعات العمل/i, ans: `مواعيد العمل: ${OFFICE_HOURS}` },
  { re: /بتشتغلوا في التجمع|القاهرة الجديدة|مدينتي|الرحاب/i, ans: "إحنا بنشتغل في مدينة نصر بس يا فندم." },
  { re: /في رسوم|بتاخدوا فلوس/i, ans: "مفيش رسوم مبدئية. العمولة بس بعد إتمام البيع/الإيجار." },
];

const GOOGLE_AUTHORITY_INTERRUPTS = [
  { re: /ضمان|مصداقية|مين انت|بتعرف تشتغل|ليه اثق|معرفتك|خبرتك|مين حضرتك|انت مين/i, ans: () => buildGoogleAuthorityShort() },
  { re: /جوجل ماب|google maps|الخرايط|الخريطة|تقييمات|رأى الناس/i, ans: () => buildGoogleAuthorityMsg() },
  { re: /كام تقييم|كام مراجعة|كام صورة|كام مشاهدة/i, ans: () => buildGoogleAuthorityMsg() },
];

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

const officeMsg = () => `📌 عنوان المكتب: ${OFFICE_ADDRESS}\n\n🗺️ اللوكيشن: ${OFFICE_MAP_URL}\n\n⏰ المواعيد: ${OFFICE_HOURS}\n\n📝 الأفضل تكلمنا على الواتساب قبل ما تجي.`;

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

async function fetchFeed() {
  const now = Date.now();
  if (feedCache.data && (now-feedCache.at)<CACHE_TTL_MS) return feedCache.data;
  const r = await fetch(AI_FEED_URL, { headers:{"Accept":"application/json"} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  feedCache = { at:now, data:d };
  return d;
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
    lmCache.set(key, { at:now, data:lms });
    return lms;
  } catch {
    lmCache.set(key, { at:now, data:[] });
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
    lines.push(``, `📅 *طلب حجز معاينة ميدانية* — جاهز للتواصل`);
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

  lines.push("", `━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏆 *طارق طنطاوي* — ${GOOGLE_PROFILE.badge}`);
  lines.push(`📸 ${GOOGLE_PROFILE.photosCount} صورة | ⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة`);
  lines.push(`👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps`);
  lines.push(`🗺️ ${GOOGLE_PROFILE.url}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}

const waURL = (phone, msg) => `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;

// ═══ FORM STATE ═══
const LC = { ACTIVE:"active", DONE:"completed", CANCELLED:"cancelled" };

function sanitizeState(fs) {
  if (!fs?.active) return fs;
  if (fs._version && fs._version!==FORM_VERSION) return { active:false, lifecycle:LC.CANCELLED, type:null, stepIndex:-1, data:{}, awaitingQ:false, flowType:null, imageUrls:[] };
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
async function callGemini(env, sys, msgs, maxTok=150, temp=0.6) {
  if (!env?.GEMINI_API_KEY) return null;
  try {
    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    const body = { system_instruction: { parts:[{text:sys}] }, contents: msgs, generationConfig: { temperature:temp, maxOutputTokens:maxTok } };
    const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    if (!r.ok) return null;
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    return t ? String(t).trim() : null;
  } catch { return null; }
}

async function geminiFirstMsg(env, userMsg, history) {
  const sys = `أنت "طارق طنطاوي" — سمسار عقاري في مدينة نصر من 2014.
🏆 Google Local Guide Level 7 | ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps

دورك: العميل لسه بادئ — وجّهه للأزرار فقط في رد قصير (2-3 أسطر).
ممنوع: تسأل عن تفاصيل العقار / تتكلم عن أسعار أو مناطق.
اللغة: عامية مصرية. النبرة: ودود ومختصر واحترافي.
مهم: وجّه للأزرار دايماً — لا تسأل أسئلة تفصيلية.`;
  return callGemini(env, sys, [{role:"user",parts:[{text:userMsg}]}], 150, 0.6);
}

async function geminiComment(env, userMsg, nextQ, fsData) {
  const cacheKey = `c:${normAr(userMsg).slice(0,80)}`;
  const cached = geminiCache.get(cacheKey);
  if (cached && (Date.now()-cached.at) < GEMINI_CACHE_TTL) return cached.reply;

  const sys = `أنت "طارق طنطاوي" — سمسار مدينة نصر.
دورك: تعليق قصير (سطر واحد، 15 كلمة بحد أقصى) على إجابة العميل.
ممنوع: تكتب السؤال التالي / تفتح مواضيع جديدة.
لو الإجابة عادية: "تمام" أو "ماشي".
لو مميزة: علّق بإيجابية قصيرة.
السياق — إجابة العميل: "${userMsg}" | السؤال التالي: "${nextQ}" | البيانات: ${JSON.stringify(fsData||{})}
اللغة: عامية مصرية. ممنوع: "يا هلا" / "منور" / "يا باشا".`;

  const reply = await callGemini(env, sys, [{role:"user",parts:[{text:userMsg}]}], 60, 0.7);
  if (reply) geminiCache.set(cacheKey, { reply, at:Date.now() });
  return reply;
}

async function geminiContextual(env, userMsg, formState, currentStep, history) {
  const q = currentStep ? (typeof currentStep.q==="function"?currentStep.q(formState?.data):currentStep.q) : "";
  const convHistory = (Array.isArray(history)?history:[]).slice(-8)
    .filter(m=>m?.message?.trim())
    .map(m=>({ role:m.role==="assistant"?"model":"user", parts:[{text:String(m.message).slice(0,500)}] }));
  if (convHistory[convHistory.length-1]?.role==="user") convHistory.pop();
  convHistory.push({ role:"user", parts:[{text:userMsg}] });

  const sys = `أنت "طارق طنطاوي" — سمسار عقاري في مدينة نصر من 2014.
🏆 Google Local Guide Level 7 | ${GOOGLE_PROFILE.formattedViews} مشاهدة

دورك: رد على سؤال العميل في سطر واحد + أعِد السؤال المعلّق حرفياً.
السؤال المعلّق: "${q}"
البيانات: ${JSON.stringify(formState?.data||{})}
ممنوع: تسأل سؤال جديد / تتكلم خارج العقارات.
اللغة: عامية مصرية.`;
  return callGemini(env, sys, convHistory, 150, 0.5);
}

// ═══ ✅ Gemini في كل محادثة ═══
async function enhanceResponse(env, result, userMsg, formState, currentStep, history) {
  if (!formState?.active || result.done || result.readyToSend) return result;
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

  return {
    response: extra ? `${extra}\n\n${q}` : q,
    formState: {...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[]
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

  return {
    response: extra ? `${extra}\n\n${q}` : q,
    formState: {...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[]
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

معاك طارق طنطاوي 🏆
بتدور على إيه، شراء ولا إيجار؟`,
    formState:{active:true,lifecycle:LC.ACTIVE,type:null,stepIndex:-1,data:{}, awaitingQ:false,flowType:"route_selection",imageUrls:[]},
    options:ROUTE_BTNS, done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:[]
  };
}

// ═══ ROUTE DETECTION ═══
function detectRoute(msg) {
  const raw = String(msg||"").trim();
  const n = normAr(raw);
  if (/ااجر|اؤجر|أأجر|أاجر|مؤجر|عندي.*للإيجار/i.test(raw)) return "owner_rent";
  if (n.includes("استاجر")||n.includes("استأجر")||n.includes("مستاجر")) return "buyer_rent";
  if (/عايز ابيع|عايز أبيع|ابيع شقتي|أبيع شقتي/i.test(raw)) return "owner_sale";
  if (n.includes("اشتري")||n.includes("أشتري")||n.includes("شراء")||n.includes("تمليك")) return "buyer_sale";
  if (n.includes("ايجار")||n.includes("إيجار")) return "buyer_rent";
  if (n.includes("بيع")) return "owner_sale";
  return null;
}

// ═══ UPLOAD IMGBB ═══
async function uploadImgBB(env, images) {
  const key = env?.IMGBB_API_KEY;
  if (!key||!images?.length) return {ok:false,error:"No images or key"};
  if (images.length>MAX_IMAGES) return {ok:false,error:`Max ${MAX_IMAGES}`};
  const urls=[];
  for (const img of images) {
    if (!img?.trim()) continue;
    try {
      const f=new FormData(); f.append("key",key); f.append("image",img.trim());
      const r=await fetch("https://api.imgbb.com/1/upload",{method:"POST",body:f});
      if (!r.ok) continue;
      const d=await r.json();
      if (d?.data?.url) urls.push(d.data.url);
    } catch {}
  }
  return urls.length?{ok:true,urls}:{ok:false,error:"Upload failed"};
}

// ═══ RATE LIMITER ═══
const rateMap = new Map();
function rateLimited(ip) {
  const now=Date.now();
  const arr=(rateMap.get(ip)||[]).filter(t=>now-t<RATE_WINDOW_MS);
  if (arr.length>=RATE_MAX) return true;
  arr.push(now); rateMap.set(ip,arr);
  return false;
}

// ═══ RESPONSE HELPERS ═══
const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const jsonRes = (obj,s=200) => new Response(JSON.stringify(obj),{status:s,headers:{...CORS,"Content-Type":"application/json"}});

// ══════════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname==="/upload-images" && request.method==="POST") {
      try {
        const body = await request.json().catch(()=>({}));
        const r = await uploadImgBB(env, body.images||[]);
        if (!r.ok) return jsonRes({error:r.error},400);
        return jsonRes({urls:r.urls});
      } catch { return jsonRes({error:"Upload failed"},500); }
    }

    if (request.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
    if (request.method!=="POST") return jsonRes({error:"Method not allowed"},405);

    const ip = request.headers.get("CF-Connecting-IP")||"unknown";
    if (rateLimited(ip)) return jsonRes({response:"استنى شوية، بتبعت رسايل كتير.",options:ROUTE_BTNS},429);

    try {
      const body = await request.json().catch(()=>({}));
      const userMsg = String(body.message||"").trim();
      let fs = sanitizeState(body.formState||{});
      const history = Array.isArray(body.history)?body.history:[];
      const incomingImgs = Array.isArray(body.imageUrls)?body.imageUrls:[];

      if (incomingImgs.length && fs?.active) {
        fs.imageUrls = [...(fs.imageUrls||[]),...incomingImgs].slice(0,MAX_IMAGES);
      }

      if (!env?.GEMINI_API_KEY) return jsonRes({response:"حصل خطأ مؤقت.",options:ROUTE_BTNS},500);

      const flowType = fs.flowType||"";
      const hasFlow = fs.active===true && flowType!=="";

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
          const steps = getOwnerSteps("sale");
          const newFs = {active:true,lifecycle:LC.ACTIVE,type:"sale",stepIndex:0,data:{},awaitingQ:true,flowType:"owner",imageUrls:[]};
          const r = askOwnerStep(steps,0,newFs,null,lms);
          return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
        }
        if (isLandlord(userMsg)) {
          const lms = await fetchLandmarks({transaction:"rent"});
          const steps = getOwnerSteps("rent");
          const newFs = {active:true,lifecycle:LC.ACTIVE,type:"rent",stepIndex:0,data:{},awaitingQ:true,flowType:"owner",imageUrls:[]};
          const r = askOwnerStep(steps,0,newFs,null,lms);
          return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
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
            const steps = getOwnerSteps(type);
            const newFs = {active:true,lifecycle:LC.ACTIVE,type,stepIndex:0,data:{},awaitingQ:true,flowType:"owner",imageUrls:[]};
            const r = askOwnerStep(steps,0,newFs,null,lms);
            return jsonRes(await enhanceResponse(env,r,userMsg,r.formState,steps[0],history));
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
        const r = await processOwner(fs,userMsg,env,history,lms);
        return jsonRes(await enhanceResponse(env,r,userMsg,fs,step,history));
      }

      if (flowType==="buyer"||flowType==="tenant") {
        const lms = await fetchLandmarks({transaction:fs.type,propertyType:fs.data?.propertyType});
        const step = getBuyerSteps(fs.type)[fs.stepIndex];
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

      return jsonRes({response:"معاك طارق طنطاوي. اختار طلبك:",options:ROUTE_BTNS,formState:fs});

    } catch(err) {
      console.error("[ERROR]", err.message, err.stack);
      return jsonRes({response:"حصلت مشكلة مؤقتة، جرّب تاني.",options:ROUTE_BTNS},500);
    }
  }
};
// ═══════════════════════════════════════════════════
// نهاية الملف — سمسار طلبك v8.3-FINAL
// ✅ Gemini في كل محادثة + لا تعليق + رسالة مؤهلة كاملة
// ═══════════════════════════════════════════════════
