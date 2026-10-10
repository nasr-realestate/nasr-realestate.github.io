// ============================================================
// سمسار طلبك — Cloudflare Worker v9.2-FINAL
// طارق طنطاوي | مدينة نصر | 2014–2026
// Google Local Guide Level 7 | 16.3M+ Views
// ------------------------------------------------------------
// v9.2-FINAL — فوق v9.0-INTELLIGENCE (الحفاظ الكامل على السلوك):
//  • فهم المصرية الطبيعية: "أعرف سعرها" / "بتاعتي" / "مش مفروشة"
//  • دور المالك (SELLER/LANDLORD) يُكتشَف من "عندي/بتاعتي/ملكي"
//  • VALUATION يبدأ owner_sale/owner_rent مباشرة (بدل ما يسأل شراء/إيجار)
//  • حماية من ادعاء وجود مشتري (anti-hallucination)
//  • تطبيق التصحيحات داخل الـflow (استبدال القيم القديمة)
//  • استقبال النص الحر في notes بدل رفضه
//  • كل السلوك القديم (buyer/tenant/owner/valuation/image/WA) محفوظ
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
const FORM_VERSION       = "v92";
const RATE_WINDOW_MS     = 30 * 1000;
const RATE_MAX           = 15;
const MAX_VISIBLE_LM     = 8;
const VALUATION_MAX_AGE  = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_FEED   = 6000;
const FETCH_TIMEOUT_GEMINI = 8000;
const FETCH_TIMEOUT_IMGBB  = 15000;
const MAX_MSG_LEN          = 1000;
const MAX_HISTORY          = 20;
const MAX_CHAT_BODY_BYTES    = 256 * 1024;
const MAX_UPLOAD_BODY_BYTES  = 12 * 1024 * 1024;
const MAX_IMG_BYTES          = 6 * 1024 * 1024;
const UPLOAD_RATE_WINDOW     = 60 * 1000;
const UPLOAD_RATE_MAX        = 4;
const UPLOAD_HOURLY_WINDOW   = 60 * 60 * 1000;
const UPLOAD_HOURLY_MAX      = 20;
const RATE_MAP_MAX_KEYS    = 5000;
const CACHE_MAX_KEYS       = 500;
const DEFAULT_ALLOWED_ORIGINS = ["https://nasr-realestate.github.io"];

const TAREK_PERSONA = `أنت طارق طنطاوي، وكيل عقاري في مدينة نصر.
خبرتك 15 سنة، عمرك 48 سنة، وGoogle Local Guide Level 7.
بتتكلم مصري طبيعي، دافي ومختصر؛ مش رسمي، مش مبتذل، ومش بوت.
فكّر قبل الرد: استخدم المعلومات اللي قالها العميل فقط، واسأل سؤالًا واحدًا في كل رسالة.
متطلبش رقم موبايل أو أي بيانات شخصية قبل ما يبقى الطلب واضح: العملية، نوع العقار، المنطقة، والمساحة.
أي سعر أو ميعاد مبدئي ويتأكد مع طارق.`;

const MOOD_GUIDE = `صنّف النية الأول: عقارات، تحية أو سؤال شخصي، أو خارج الموضوع.
لو خارج العقارات: جملة واحدة لطيفة من غير أي أسئلة تأهيلية.
لو تحية: تحية قصيرة، عرّف نفسك في سطر، واسأل عن العملية فقط.
اقرا مزاج العميل: المستعجل اختصر، المتردد طمّنه، والمستثمر ادّيه أرقامًا مبدئية فقط.
لو العميل قال غالي، اسأل عن توقعه من غير دفاع. لو قال مش متأكد، ساعده يحدد من غير ضغط.`;

const IDENTITY_RESPONSE = `أنا وكيل ذكي بيشتغل لصالح طارق طنطاوي — سمسار مدينة نصر، خبرة 15 سنة، وGoogle Local Guide Level 7. بسجّل طلبك وبوصّله لطارق.
تحب تشتري ولا تأجر ولا تبيع؟`;
const GREETING_RESPONSE = `أهلاً بيك، أنا وكيل طارق طنطاوي الذكي — سمسار مدينة نصر.
تشتري ولا تأجر ولا تبيع؟`;
const OFF_TOPIC_RESPONSE = `أنا وكيل طارق، متخصص في عقارات مدينة نصر 🏠 ومش بساعد في ده، لكن معاك في أي طلب شراء أو إيجار أو بيع.`;
const PRICE_OBJECTION_RESPONSE = `فاهمك، السعر بيفرق حسب المنطقة والحالة. إيه السعر اللي في دماغك؟`;
const HESITATION_RESPONSE = `ولا يهمك، ناخدها واحدة واحدة ومن غير ضغط. نبدأ بشراء ولا إيجار؟`;
const OUT_OF_SCOPE_RESPONSE = `التخصص الحالي لطارق الوكيل هو مدينة نصر بس، ومش بعرض عقارات خارجها.`;

const GOOGLE_PROFILE = {
  url: "https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7",
  level: 7, badge: "Google Local Guide Level 7",
  points: 7741, maxPoints: 15000, photosCount: 468,
  totalViews: 16273294, formattedViews: "16.3 مليون",
  reviewsCount: 195, ratingsCount: 39,
  description: "Real Estate Agent in Nasr City",
  office: "مدينة نصر — القاهرة",
};

const BTN = {
  BUY:"🔍 أشتري", TENANT:"🏠 أستأجر", SELL:"💰 أبيع", LANDLORD:"🔑 أأجر",
  SKIP:"تخطي السؤال ⏭", SEND:"ابعت البيانات دلوقتي ✅", CANCEL:"إلغاء التسجيل ✕",
  BACK:"⬅️ رجوع", CANCEL_BACK:"إلغاء الرجوع", ANY_AREA:"أي منطقة في مدينة نصر",
  MORE:"➕ المزيد", FIRST_LIST:"⬅️ القائمة الأولى",
  ATTACH_IMG:"📷 أرفق صور", SKIP_IMG:"⏭ تخطي (بدون صور)",
  ADD_IMG:"📷 إضافة صور", DEL_IMG:"🗑️ احذف الكل", IMG_DONE:"✅ تمام، كمّل",
  SEND_WA:"✅ ابعت على واتساب", PREVIEW:"📄 معاينة الرسالة", EDIT:"⬅️ عدّل حاجة",
  NEW_REQ:"🆕 طلب جديد", BOOK_VIEW:"📅 احجز معاينة", BACK_LIST:"🔙 رجوع للعقارات",
  OTHER_PROP:"🔄 مواصفات تانية", ACCEPT:"✅ تمام، ده اللي عايزه",
  CUSTOM_SPEC:"📲 ابعت طلبي بالمواصفات دي لطارق", VALUATION:"💎 قيّم عقارك",
};
const ROUTE_BTNS      = [BTN.BUY, BTN.TENANT, BTN.SELL, BTN.LANDLORD];
const POST_COMPLETE   = [BTN.SEND_WA, BTN.PREVIEW, BTN.EDIT, BTN.NEW_REQ];
const POST_PREVIEW    = [BTN.SEND_WA, BTN.EDIT, BTN.NEW_REQ];
const POST_SELECTED   = [BTN.BOOK_VIEW, BTN.SEND_WA, BTN.PREVIEW, BTN.BACK_LIST, BTN.NEW_REQ];
const POST_VIEWING    = [BTN.SEND_WA, BTN.BACK_LIST, BTN.NEW_REQ];

const PT_MAP = {
  "شقة":"apartment","فيلا":"villa","دوبلكس":"duplex","روف":"roof",
  "محل تجاري":"shop","مكتب إداري":"office","مخزن":"storage",
};

const SUBTYPE_OPTIONS = {
  "شقة":["أرضي","أول","ثاني","ثالث","رابع","خامس","سادس","سابع","ثامن","تاسع","عاشر","أخير","بدروم"],
  "فيلا":["فيلا مستقلة","تاون هاوس","توين هاوس","أرضي مع حديقة","أرضي + أول (دوبلكس)"],
  "دوبلكس":["أرضي + أول بحديقة","دوبلكس علوي","بنتهاوس دوبلكس"],
  "روف":["روف مبني بتراس","بنتهاوس","مساحة مفتوحة","روف في عمارة"],
  "محل تجاري":["أرضي تجاري","ناصية","واجهة على شارع رئيسي","داخل مول","ميزانين"],
  "مكتب إداري":["مبنى إداري مرخص","دور إداري مستقل","داخل مول","أرضي إداري"],
  "مخزن":["بدروم","أرضي","مستقل / جمالون","داخل مبنى"],
};
function getSubtypeOptions(pt){ return SUBTYPE_OPTIONS[pt] || SUBTYPE_OPTIONS["شقة"]; }

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

function toEnNum(s){ return String(s||"").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))); }
function parseNum(v){ if(typeof v==="number")return v; if(!v)return 0; const c=toEnNum(String(v)).replace(/,/g,"").replace(/[^\d.]/g,""); const n=parseFloat(c); return isNaN(n)?0:n; }
function fmtNum(v){ if(!v&&v!==0)return "0"; const n=parseNum(v); return toEnNum(n<100000?String(n):n.toLocaleString("en-US")); }
function hasVal(v){ return v!==undefined&&v!==null&&String(v).trim()!==""&&String(v).trim()!=="—"; }
function fmtVal(v){ return hasVal(v)?toEnNum(String(v).trim()):"—"; }

const _normCache = new Map();
function normAr(s){
  const raw = String(s||"");
  if (raw.length<=64){ const hit=_normCache.get(raw); if(hit!==undefined)return hit; }
  const out = raw
    .replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[أإآٱ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي")
    .replace(/[ًٌٍَُِّْـ]/g,"").replace(/[^\w\u0600-\u06FF]/g,"")
    .toLowerCase().trim();
  if (raw.length<=64){ if(_normCache.size>=CACHE_MAX_KEYS)_normCache.clear(); _normCache.set(raw,out); }
  return out;
}

// ═══ INTENT + FACT EXTRACTION ═══
const GREETING_RE = /^(?:السلام\s*عليكم(?:\s*ورحمة\s*الله)?|وعليكم\s*السلام|اهلا|أهلا|أهلاً|اهلاً|صباح\s*الخير|صباح\s*النور|مساء\s*الخير|مساء\s*النور|ازيك|إزيك|ازاى|إزاى|عامل\s*ايه|عامل\s*إيه|هاي|hello|hi|hey|سلام)[!؟?.,\s]*$/i;
const REAL_ESTATE_CORE_RE = /عقار|شقه?|فيلا|دوبلكس|روف|محل|مكتب|مخزن|سكن|تمليك|شراء|اشتري|أشتري|إيجار|ايجار|استأجر|استاجر|بيع|ابيع|أبيع|تأجير|أأجر|متر|مساحه|مساحة|ميزانيه|ميزانية|سعر/i;
const REAL_ESTATE_RE = new RegExp(`${REAL_ESTATE_CORE_RE.source}|مدينة\\s*نصر|مدينه\\s*نصر|الحي|المنطقه|المنطقة|عباس|مكرم|النحاس|الطيران`, "i");
const OFF_TOPIC_RE = /شاي|قهوة|قهوه|جو\s*(بكره|بكرة|النهارده|دلوقتي)|الطقس|الجو|سياسة|سياسه|رياضة|رياضه|كورة|كره|ماتش|برمجه|برمجة|كود|بايثون|جافاسكربت|javascript|python|فيلم|اغنيه|أغنية|موسيقى|مزيكا|وصفة|اكل|أكل|طبخ|سفر|كرة\s*قدم|سيارة|سيارات|عربية/i;
const PRICE_OBJECTION_RE = /غالي|غالى|غلاء|كتير|مرتفع|مش\s*مناسب|مش\s*قدرتي|فوق\s*ميزانيتي/i;
const HESITATION_RE = /مش\s*متأكد|مش\s*متاكده|مش\s*عارف|لسه\s*محتار|محتارة|محتار|متردد|مترددة/i;

function isGreeting(msg){
  const t=String(msg||"").trim();
  if(!t||t.length>80||REAL_ESTATE_CORE_RE.test(t))return false;
  return GREETING_RE.test(t)||/^(?:السلام|اهلا|أهلا|أهلاً|صباح|مساء|ازيك|إزيك|هاي|hello|hi|hey|سلام)(?:\s|$)/i.test(t)&&t.split(/\s+/).length<=6;
}
function isOffTopic(msg){
  const t=String(msg||"").trim();
  return !!t&&!REAL_ESTATE_CORE_RE.test(t)&&OFF_TOPIC_RE.test(t);
}

function extractRequestFacts(msg){
  const t=String(msg||"").trim();
  const facts={};
  if(/دوبلكس/i.test(t))facts.propertyType="دوبلكس";
  else if(/شقة|شقه|شقت/i.test(t))facts.propertyType="شقة";
  else if(/فيلا/i.test(t))facts.propertyType="فيلا";
  else if(/روف/i.test(t))facts.propertyType="روف";
  else if(/محل/i.test(t))facts.propertyType="محل تجاري";
  else if(/مكتب/i.test(t))facts.propertyType="مكتب إداري";
  else if(/مخزن/i.test(t))facts.propertyType="مخزن";

  const landmark = matchLandmark(t, MASTER_LANDMARKS);
  if(landmark) facts.landmark = landmark;

  const sizeMatch = toEnNum(t).match(/(?:مساح(?:ة|ه)\s*)?(\d{1,6})\s*(?:متر|م٢|m2|sqm|م(?=\s*(?:\d|²|٢|$)))/i);
  if(sizeMatch) facts.area = Number(sizeMatch[1]);

  const price = extractPrice(t);
  if(price>0) facts.budget = price;
  const rooms = toEnNum(t).match(/(\d+)\s*(?:غرف|غرفة|أوض|اوض)/i);
  if(rooms) facts.rooms = rooms[1];
  const baths = toEnNum(t).match(/(\d+)\s*(?:حمام|حمامات)/i);
  if(baths) facts.baths = baths[1];

  // ⭐ ترتيب مهم: فحص "مش مفروشة/فاضي" قبل "مفروش"
  if(/مش\s*مفروش|مش\s*مفروشة|فاضي|قانون\s*جديد|بدون\s*فرش/i.test(t)) facts.furnished="فاضي (قانون جديد)";
  else if(/مفروش/i.test(t)) facts.furnished="مفروش";

  facts.transaction = detectRoute(t);
  return facts;
}
function hasRequestFacts(facts){
  return !!(facts&&(facts.propertyType||facts.landmark||facts.area||facts.budget||facts.transaction));
}
function seedFlowData(facts, owner){
  const f=facts||{}; const data={};
  if(hasVal(f.propertyType))data.propertyType=f.propertyType;
  if(hasVal(f.area))data.area=f.area;
  if(hasVal(f.rooms))data.rooms=f.rooms;
  if(hasVal(f.baths))data.baths=f.baths;
  if(hasVal(f.furnished))data.furnished=f.furnished;
  if(owner){ if(hasVal(f.landmark))data.location=f.landmark; if(hasVal(f.budget))data.price=f.budget; }
  else { if(hasVal(f.landmark))data.landmark=f.landmark; if(hasVal(f.budget))data.budget=f.budget; }
  if(!data._filled)data._filled={};
  return data;
}
function factsSummary(facts){
  const f=facts||{}; const bits=[];
  if(f.propertyType)bits.push(f.propertyType);
  if(f.area)bits.push(`${fmtNum(f.area)}م`);
  if(f.landmark)bits.push(`في ${f.landmark}`);
  return bits.join(" ");
}
function buildRouteQuestion(facts){
  const s=factsSummary(facts);
  return s?`تمام، ${s}. للشراء ولا للإيجار؟`:"تمام، للشراء ولا للإيجار؟";
}

// ═══ VALUATION HELPERS ═══
function strictNum(v){
  if(typeof v==="number") return Number.isFinite(v)?v:null;
  if(typeof v==="string"){ const t=toEnNum(v); if(/^\d{1,15}(?:\.\d{1,6})?$/.test(t)) return Number(t); }
  return null;
}
function sanitizeValuation(v){
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const estimate = strictNum(v.estimate);
  if(estimate===null||estimate<=0||estimate>1e12)return null;
  const samples = strictNum(v.samples);
  const perMeter = strictNum(v.perMeter);
  const size = strictNum(v.size);
  const p25 = strictNum(v.p25);
  const p75 = strictNum(v.p75);
  const sizeOk = size!==null && size>=20 && size<=100000;
  const pmOk = perMeter!==null && perMeter>0 && perMeter<=1e9;
  if(pmOk && sizeOk && Math.abs(estimate - perMeter*size) > size*0.51+1) return null;
  const rangeOk = p25!==null && p75!==null && p25>0 && p75>=p25 && p75<=1e9;
  const oneOf = (x,list)=>(typeof x==="string"&&list.includes(x)?x:"");
  return {
    estimate: Math.round(estimate),
    confidence: oneOf(v.confidence, ["high","medium","low"]) || "unknown",
    samples: samples!==null && samples>=0 && samples<=1e6 ? Math.round(samples) : 0,
    perMeter: pmOk ? Math.round(perMeter) : 0,
    p25: rangeOk ? Math.round(p25) : 0,
    p75: rangeOk ? Math.round(p75) : 0,
    priceBasis: oneOf(v.priceBasis, ["median_price_m2","avg_price_m2"]),
    area: typeof v.area==="string" ? redactPII(v.area).replace(/[\u0000-\u001F\u007F<>]/g," ").replace(/\s+/g," ").trim().slice(0,80) : "",
    size: sizeOk ? size : 0,
    areaType: oneOf(v.areaType, ["rent","sale"]),
    savedAt: Date.now(),
  };
}
function buildValuationAnnouncement(v){
  if(!v||!v.estimate)return "";
  const fmtN = n => Number(n||0).toLocaleString("en-US");
  const confLabel = v.confidence==="high"?"عالية":v.confidence==="medium"?"متوسطة":v.confidence==="low"?"منخفضة":"غير محددة";
  const status = v.confidence==="high"?"🟢 عينة قوية — مؤشر موثوق نسبيًا"
               : v.confidence==="medium"?"🟡 عينة متوسطة — استرشادي"
               : v.confidence==="low"?"🔴 عينة محدودة — استرشادي فقط"
               : "⚪ الثقة غير محددة — مؤشر عام فقط";
  const isRent = v.areaType === "rent";
  const perMonth = isRent ? " / شهريًا" : "";
  const basisLabel = v.priceBasis==="median_price_m2"?" (الوسيط)":v.priceBasis==="avg_price_m2"?" (المتوسط)":"";
  const lines = [`تمام، شفت نتيجة التقييم 👌`,``,`💎 *تقييم عقارك ${isRent?"للإيجار":"للبيع"}:*`,`┌───────────────────`];
  if(v.area) lines.push(`│ 📍 المنطقة: ${v.area}${v.size>0?` • ${fmtN(v.size)} م²`:""}`);
  lines.push(`│ 💰 ${isRent?"الإيجار":"السعر"} التقديري: ${fmtN(v.estimate)} ج.م${perMonth}`);
  if(v.p25>0&&v.p75>0&&v.size>0) lines.push(`│ 📊 النطاق الأساسي: ${fmtN(Math.round(v.p25*v.size))} – ${fmtN(Math.round(v.p75*v.size))} ج.م${perMonth}`);
  if(v.perMeter>0) lines.push(`│ 📏 سعر المتر${basisLabel}: ${fmtN(v.perMeter)} ج.م/م²${perMonth}`);
  if(v.p25>0&&v.p75>0) lines.push(`│ ↕️ نطاق المتر (P25–P75): ${fmtN(v.p25)} – ${fmtN(v.p75)} ج.م/م²${perMonth}`);
  lines.push(`│ 🎯 الثقة: ${confLabel}${v.samples>0?` (${fmtN(v.samples)} عينة)`:""}`);
  lines.push(`│ ${status}`);
  lines.push(`└───────────────────`);
  lines.push(``,`ده مؤشر استرشادي من بيانات مدينة نصر، مش سعر إتمام مؤكد.`,``,`نكمّل التسجيل؟`);
  return lines.join("\n");
}

function normalizePropType(pt){
  if(!pt)return "";
  const s = normAr(String(pt));
  if(s.includes("شقق")||s.includes("شقه")||s.includes("شقة")||s.includes("apartment")||s.includes("flat"))return "شقة";
  if(s.includes("دوبلكس")||s.includes("duplex"))return "دوبلكس";
  if(s.includes("فيلا")||s.includes("فيلات")||s.includes("villa")||s.includes("townhouse")||s.includes("twinhouse"))return "فيلا";
  if(s.includes("روف")||s.includes("سطح")||s.includes("roof")||s.includes("penthouse"))return "روف";
  if(s.includes("محل")||s.includes("تجاري")||s.includes("shop")||s.includes("store")||s.includes("retail"))return "محل تجاري";
  if(s.includes("مكتب")||s.includes("اداري")||s.includes("إداري")||s.includes("office")||s.includes("admin"))return "مكتب إداري";
  if(s.includes("مخزن")||s.includes("مستودع")||s.includes("storage")||s.includes("warehouse"))return "مخزن";
  return s;
}
function isBtn(msg,label){ const a=String(msg||"").trim(),b=String(label||"").trim(); if(!a||!b)return false; return a===b||normAr(a)===normAr(b); }
function matchOpt(input, options){
  if(!options?.length)return null;
  const n=normAr(input); if(!n||n.length<1)return null;
  for(const o of options) if(normAr(o)===n) return o;
  if(n.length<2)return null;
  const sorted=[...options].sort((a,b)=>normAr(b).length-normAr(a).length);
  for(const o of sorted){ const on=normAr(o); if(on?.length>=2&&(on.includes(n)||n.includes(on))) return o; }
  return null;
}
function normPhone(s){
  let d = toEnNum(String(s||"")).replace(/\D/g,"");
  if(d.startsWith("2001")) d = d.slice(2);
  else if(d.startsWith("20")&&d.length>=12) d = "0"+d.slice(2);
  if(d.startsWith("1")&&d.length===10) d = "0"+d;
  return d;
}
function extractPrice(text){
  const c = stripThousands(toEnNum(String(text||"")));
  const m = c.match(/(\d+\.?\d*)\s*(مليون|مليون جنيه)/);
  if(m){
    const base = parseFloat(m[1])*1000000;
    const rest = c.slice(m.index + m[0].length);
    const add = rest.match(/^\s*و\s*(\d{1,3})(?!\d)/);
    return add ? base + parseFloat(add[1])*1000 : base;
  }
  const k = c.match(/(\d+\.?\d*)\s*(الف|ألف|k)(?!\w)/i);
  if(k) return parseFloat(k[1])*1000;
  const d = c.match(/(\d{4,})/);
  // رقم مجرد يقبل كسعر فقط لو مش شبيه بموبايل/رقم قومي وطوله منطقي للسعر (4..9)
  if(d && parseFloat(d[1])>=10000 && d[1].length<=9 && !isPhoneRun(d[1])) return parseFloat(d[1]);
  return null;
}
// ═══ تمييز أنواع الأرقام: هاتف / سعر / ميزانية / مساحة / غرف / حمامات / دور / سنة / غير ذلك ═══
const MONEY_STEP_IDS = new Set(["price","priceWeekly","priceMonthly","priceYearly","budget"]);
const NAME_STEP_IDS  = new Set(["ownerName","buyerName"]);
const NAME_ERR = "معلش، محتاج اسم حضرتك بس من غير أرقام أو عنوان.";
function stripThousands(c){ return String(c||"").replace(/(\d)[,\u066C](\d{3})(?!\d)/g,"$1$2").replace(/(\d)[,\u066C](\d{3})(?!\d)/g,"$1$2"); }
function digitTokens(t){
  const c = toEnNum(String(t||"")), out = []; const re = /\d+(?:[.,]\d+)?/g; let m;
  while((m = re.exec(c))) out.push({ raw:m[0], i:m.index, end:m.index+m[0].length });
  return out;
}
function isPhoneRun(run){ return /^01[0-9]{9}$/.test(run) || /^1[0125][0-9]{8}$/.test(run) || /^201[0125][0-9]{8}$/.test(run); }
function isPhoneLikeText(t){
  const c = toEnNum(String(t||"")).replace(/[\s\-()]/g,"");
  const runs = c.match(/\d{8,}/g) || [];
  return runs.some(isPhoneRun);
}
// أرقام مربوطة بوحدة (مساحة/غرف/حمامات/دور/سنة) مش مرشحة تكون سعر
const UNIT_AFTER_RE = /^\s*(?:متر|م(?![\u0600-\u06FF²2٢])|م٢|م²|m2|sqm|غرف|غرفة|أوض|اوض|غرفه|حمام|حمامات|سن[ةه]|سنين|دور|طابق|أدوار)/i;
function isUnitLabeled(c, tok){
  return UNIT_AFTER_RE.test(c.slice(tok.end, tok.end + 14));
}
// مرشحات السعر الصريحة: 5 مليون / 5م / مليونين / 5.5 مليون / 3 مليون و200 / 500 ألف
function moneyCandidates(text){
  const c = stripThousands(toEnNum(String(text||"")));
  const out = [];
  const re = /(?:(\d+(?:[.,]\d+)?)\s*)?(?:مليون|ملیون)(?!ين)|مليونين|ألفين|(\d+(?:[.,]\d+)?)\s*(?:ألف|الف|k)(?!\w)|(\d+(?:[.,]\d+)?)\s*م(?![\u0600-\u06FF²2٢])|(?:نص|نصف)\s*مليون|ربع\s*مليون/gi;
  let m;
  while((m = re.exec(c))){
    const num = v => parseFloat(String(v).replace(",", "."));
    const s = m[0];
    if(/^مليونين/.test(s)) { out.push({ value: 2000000, i:m.index, form:"million" }); continue; }
    if(/^ألفين/.test(s)) { out.push({ value: 2000, i:m.index, form:"thousand" }); continue; }
    if(/^(?:نص|نصف)/.test(s)) { out.push({ value: 500000, i:m.index, form:"million" }); continue; }
    if(/^ربع/.test(s)) { out.push({ value: 250000, i:m.index, form:"million" }); continue; }
    if(/مليون|ملیون/.test(s)) { out.push({ value: (m[1] ? num(m[1]) : 1) * 1000000, i:m.index, form:"million" }); continue; }
    if(m[2] !== undefined) { out.push({ value: num(m[2]) * 1000, i:m.index, form:"thousand" }); continue; }
    if(m[3] !== undefined) { out.push({ value: num(m[3]) * 1000000, i:m.index, form:"million" }); continue; }
  }
  // "3 مليون و200" = 3,200,000 (إضافة مشتركة، مش خيارين)
  const add = c.match(/(\d+(?:[.,]\d+)?)\s*(?:مليون|ملیون)\s*و\s*(\d{1,3})(?!\d)/);
  if(add){
    const base = parseFloat(add[1].replace(",", ".")) * 1000000 + parseFloat(add[2]) * 1000;
    const at = c.indexOf(add[0]);
    const spanEnd = at + add[0].length;
    const hit = out.find(o => o.i === at);
    if(hit) hit.value = base; else out.push({ value: base, i: at, form: "million" });
    for(let x = out.length - 1; x >= 0; x--) if(out[x].i > at && out[x].i < spanEnd) out.splice(x, 1);
  }
  return out;
}
function numberTokens(t){ return digitTokens(t); }
// هل الرسالة فيها خيارين/نطاق (رقمين بينهم "أو/إلى/لحد/حتى/-")؟
function isAmbiguousChoice(t){
  const c = stripThousands(toEnNum(String(t||"")));
  const toks = numberTokens(c);
  if(toks.length < 2) return false;
  for(let k = 0; k < toks.length - 1; k++){
    const between = c.slice(toks[k].end, toks[k+1].i).trim();
    if(!between) return true;                                   // رقمين متجاورين بدون سياق
    if(/(?:^|[\s(])(?:أو|او|إلى|الى|لحد|لحاية|حتى|~|–|—|-)(?:[\s(]|$)/.test(between)) return true;
    if(/(?:^|\s)لـ?$/.test(between)) return true;
    if(between.indexOf("و") !== -1){
      const left = c.slice(toks[k].i, toks[k+1].i);
      const smallAdd = /مليون|ملیون|ألف|الف/.test(left) && parseFloat(String(toks[k+1].raw).replace(",", ".")) < 1000;
      if(!smallAdd) return true;
    }
  }
  return false;
}
// قرار السعر في سياق خطوة: OK بقيمة واحدة / توضيح / رقم غير صالح
function parseMoneyAnswer(text){
  const c = stripThousands(toEnNum(String(text||"")));
  // ⭐ رقم الموبايل مش رقم منافس: بنشيله قبل فحص الالتباس
  const noPhone = c.replace(/(?:\+?20|0)?1[0125]\d{8}(?!\d)|(?:\d[\s-]?){9,}\d/g, " ");
  if(isAmbiguousChoice(noPhone)) return { ok:false, reason:"ambiguous" };
  const explicit = moneyCandidates(c);
  if(explicit.length > 1) return { ok:false, reason:"ambiguous" };
  if(explicit.length === 1){
    // ⭐ إضافة مكتوبة بالحروف ("مليونين وخمسين ألف") مش مفهومة بالكامل ⇒ توضيح بدل قراءة ناقصة
    if(/(?:مليون|ملیون|ألف|الف)(?:ين|ان)?\s*و\s*(?:نص|ربع|عشر|عشرين|تلاتين|ثلاثين|أربعين|اربعين|خمسين|ستين|سبعين|تمانين|ثمانين|تسعين|م[ئي]ة|مائة|م[ئي]تين|ألف|الف)/.test(noPhone)) return { ok:false, reason:"unclear" };
    return { ok:true, value: explicit[0].value };
  }
  if(isPhoneLikeText(c)) return { ok:false, reason:"phone" };
  const toks = numberTokens(c);
  const bare = toks.filter(tk => /^\d{4,9}$/.test(tk.raw) && parseFloat(tk.raw) >= 10000 && !isPhoneRun(tk.raw) && !isUnitLabeled(c, tk));
  if(bare.length === 0) return { ok:false, reason:"none" };
  if(bare.length > 1) return { ok:false, reason:"ambiguous" };
  return { ok:true, value: parseFloat(bare[0].raw) };
}
function plainMoneyValue(text, type){
  const rent = String(type||"") === "rent";
  const floor = rent ? 100 : 10000;
  const c = stripThousands(toEnNum(String(text||"")));
  const runs = c.match(/\d{1,9}/g) || [];
  if(runs.length !== 1) return null;
  const n = Number(runs[0]);
  if(!Number.isFinite(n) || n < floor || n > 1000000000) return null;
  return n;
}
function moneyClarifyQ(stepId, reason){
  const what = stepId === "budget" ? "الميزانية" : "السعر";
  if(reason === "phone") return `الرقم ده شكله رقم موبايل مش ${what === "الميزانية" ? "ميزانية" : "سعر"}. ${what} كام بالظبط؟ (مثال: 5 مليون)`;
  if(reason === "unclear") return `معلش، عايز المبلغ بالأرقام بالظبط عشان أنقله صح. ${what} كام؟ (مثال: 2,050,000)`;
  void what;
  return `معلش، فيه أكتر من رقم في الرسالة. ${what} كام بالظبط؟ اكتب رقم واحد (مثال: 5 مليون).`;
}
// هل الرسالة تصريح سعر واضح (يسمح بتصحيح السعر/الميزانية)؟ الرقم المجرد لا يكفي.
function isClearPriceStatement(msg, stepId){
  const c = stripThousands(toEnNum(String(msg||"")));
  if(isPhoneLikeText(c) && !/(?:مليون|ملیون|ألف|الف|جنيه)/.test(c)) return false;
  if(isAmbiguousChoice(c)) return false;
  const explicit = moneyCandidates(c);
  if(explicit.length === 1) return true;
  if(explicit.length > 1) return false;
  return MONEY_STEP_IDS.has(String(stepId||""));
}
// ═══ الاسم: فحص شكلي/دلالي — اسم محتمل بشري، مش رقم/سعر/عنوان/نص عشوائي ═══
const NAME_FILLER_RE = /^(?:لا|لأ|تمام|طيب|ماشي|ماشى|اوك|أوك|ok|حاضر|معلش|مش|عارف|فاهم|مشكله|مشكلة|خلاص|كده|شكرا|شكرًا|any|ايوة|أيوه|ايوه|اه|اها|اها|مفيش|لسه|كمان|برضه|برضو|ممكن|فين|ازاي|ايه|ايه|test|تجربه|تجربة|asdf|qwerty|unknown|null|none|xxx|zzz|ههه+|هههه+)$/;
function cleanPersonName(raw){
  let t = String(raw||"").trim().replace(/\s+/g," ");
  if(!t) return null;
  t = t.replace(/^[\s،,.:!?؟\-]+/,"").replace(/[\s،,.:!?؟\-]+$/,"");
  t = t.replace(/^(?:أ\.|ا\.|الأستاذ(?:ة)?|أستاذ(?:ة)?|استاذ(?:ة)?|م\.|د\.|مهندس(?:ة)?)\s+/,"");
  t = t.replace(/^(?:(?:لأ|لا|قصدي|اقصد|أقصد|بالعكس)[\s،,]+)+/,"");
  t = t.replace(/^(?:أنا\s+اسمي|انا\s+اسمي|اسمي|اسمى|أنا|انا)\s+/,"");
  t = t.replace(/[\s،,.:!?؟\-]+$/,"");
  if(!t || t.length > 40) return null;
  if(/[\d٠-٩۰-۹]/.test(t)) return null;                                  // أرقام: هاتف/سعر/سنة/مساحة ⇒ ليس اسمًا
  if(/(?:مليون|ملیون|ألف|الف|جنيه|ج\.م|دولار|متر|م2|م²|م٢|قرش)/.test(t)) return null;
  if(/(?:شارع|ش\.|منطقة|مدينة|ميدان|مربع|عمارة|برج|كمبوند|الحي|حي\b|عقار|شقة|شقه|فيلا|محل|مكتب|مخزن|روف|دور|الدور|مبنى|عايز|عاوز|محتاج|سعر|ميزانية)/.test(t)) return null;
  const words = t.split(" ").filter(Boolean);
  if(words.length < 1 || words.length > 4) return null;
  // ⭐ أسماء الشوارع بتتصادم مع أسماء أشخاص شائعة ("أحمد" = شارع أحمد فؤاد نسيم):
  //    الفحص ده للردود المتعددة الكلمات فقط، عشان ما نرفضش اسم حقيقي من كلمة واحدة
  if(words.length >= 2){ try { if(matchLandmark(t, MASTER_LANDMARKS)) return null; } catch {} }
  const okWord = w => /^[\u0600-\u06FF]{2,15}$/.test(w) || /^[A-Za-z][A-Za-z'’\-]{1,19}$/.test(w);
  if(!words.every(okWord)) return null;
  if(words.every(w => NAME_FILLER_RE.test(normAr(w)))) return null;       // "تمام تمام"/"مش عارف"
  return t;
}

// ═══ GOOGLE AUTHORITY ═══
function buildGoogleAuthorityMsg(){
  return `🏆 *طارق طنطاوي* — ${GOOGLE_PROFILE.badge}\n\n📊 *الأرقام الرسمية على Google Maps:*\n• 👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة\n• 📸 ${GOOGLE_PROFILE.photosCount} صورة\n• ⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة + ${GOOGLE_PROFILE.ratingsCount} تقييم\n• 🎯 ${GOOGLE_PROFILE.points.toLocaleString("en-US")} / ${GOOGLE_PROFILE.maxPoints.toLocaleString("en-US")} نقطة\n\n📍 ${GOOGLE_PROFILE.description}\n🗺️ شوف بروفايلي: ${GOOGLE_PROFILE.url}`;
}
function buildGoogleAuthorityShort(){
  return `🏆 ${GOOGLE_PROFILE.badge}\n👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps\n⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة\n🗺️ ${GOOGLE_PROFILE.url}`;
}
function buildTrustBar(){
  return `━━━━━━━━━━━━━━━━━━━\n🏆 Google Local Guide Level 7\n⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة | 👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة\n━━━━━━━━━━━━━━━━━━━`;
}

// ═══ REQUEST LABEL ═══
function getRequestLabel(type, propertyType, furnished, isOwner=false){
  const isRent = type==="rent"||type==="owner_rent"||type==="tenant"||type==="buyer_rent";
  const pt = propertyType||"عقار";
  let emoji = "📋";
  if(isRent&&pt==="شقة"&&furnished==="مفروش") emoji="🛏️";
  else if(isRent&&pt==="شقة"&&(furnished==="فاضي (قانون جديد)"||furnished==="فاضي")) emoji="🏚️";
  else {
    const emojiMap = {"شقة":"🏠","فيلا":"🏡","دوبلكس":"🏡","روف":"🌅","محل تجاري":"🏪","مكتب إداري":"🏢","مخزن":"🏭"};
    emoji = emojiMap[pt]||(isRent?"🔑":"🏠");
  }
  const action = isOwner ? (isRent?"تأجير":"بيع") : (isRent?"إيجار":"شراء");
  const prefix = isOwner ? "عرض" : "طلب";
  if(isRent&&(pt==="شقة"||pt==="فيلا"||pt==="دوبلكس"||pt==="روف")){
    if(furnished==="مفروش") return `${emoji} ${prefix} ${action} ${pt} مفروش`;
    if(furnished==="فاضي (قانون جديد)"||furnished==="فاضي") return `${emoji} ${prefix} ${action} ${pt} فاضي (قانون جديد)`;
  }
  return `${emoji} ${prefix} ${action} ${pt}`;
}

// ═══ LANDMARK MATCHING ═══
function levenshtein(a,b){
  if(!a||!b)return Math.max(a?.length||0,b?.length||0);
  if(a===b)return 0;
  const m=a.length,n=b.length;
  if(m===0)return n; if(n===0)return m;
  let prev=new Uint16Array(n+1); let cur=new Uint16Array(n+1);
  for(let j=0;j<=n;j++) prev[j]=j;
  for(let i=1;i<=m;i++){
    cur[0]=i; const ca=a[i-1];
    for(let j=1;j<=n;j++){ cur[j]=ca===b[j-1]?prev[j-1]:1+Math.min(prev[j],cur[j-1],prev[j-1]); }
    const t=prev; prev=cur; cur=t;
  }
  return prev[n];
}
function similarity(a,b){
  const na=normAr(a),nb=normAr(b);
  if(!na||!nb)return 0;
  if(na===nb)return 1;
  const dist=levenshtein(na,nb);
  const maxLen=Math.max(na.length,nb.length);
  return maxLen ? 1-(dist/maxLen) : 0;
}
function matchLandmark(text,pool){
  const t=normAr(text);
  if(!t||t.length<2)return null;
  for(const lm of pool) if(normAr(lm)===t) return lm;
  const sorted=[...pool].sort((a,b)=>normAr(b).length-normAr(a).length);
  for(const lm of sorted){ const n=normAr(lm); if(n?.length>=3&&t.includes(n)) return lm; }
  let best=null,bestScore=0;
  for(const lm of pool){ const score=similarity(text,lm); if(score>bestScore&&score>=0.75){bestScore=score;best=lm;} }
  if(best) return best;
  for(const lm of sorted){ const n=normAr(lm); if(n?.length>=4&&n.includes(t)&&t.length>=3) return lm; }
  return null;
}

// ═══ GEOGRAPHY ═══
const OUT_OF_COVERAGE = ["التجمع","القاهرة الجديدة","الشروق","مدينتي","الرحاب","مصر الجديدة","هليوبوليس","المعادي","حلوان","المقطم","الهرم","فيصل","أكتوبر","الشيخ زايد","العاصمة الإدارية"];
const NASR_TERMS = ["مدينة نصر","مدينه نصر","عباس العقاد","مكرم عبيد","مصطفى النحاس","الطيران","حسن المأمون","حسنين هيكل","يوسف عباس","الحي السادس","الحي السابع","الحي الثامن","الحي العاشر","المنطقة السادسة","المنطقة السابعة","المنطقة الثامنة","المنطقة التاسعة","المنطقة العاشرة","زهراء مدينة نصر","الوفاء والأمل","الواحة","عزبة الهجانة"];
const isNasr = text => NASR_TERMS.some(x=>normAr(text).includes(normAr(x)));
const isOutOfArea = text => { if(isNasr(text)) return false; return OUT_OF_COVERAGE.some(x=>normAr(text).includes(normAr(x))); };

// ═══ CANNED ANSWERS ═══
const INTERRUPTS = [
  { re:/عمول|السعي|نسبتكم|هتاخد كام|مصاريف|سمسرة/i, ans:"العمولة مبدئيًا بتتحدد بعد المعاينة والاتفاق، والتفاصيل تتأكد مع طارق." },
  { re:/^اسمك ايه|حضرتك اسمك|^انت مين|مين حضرتك/i, ans:IDENTITY_RESPONSE },
  { re:/بتشتغلوا ازاي|طريقة العمل/i, ans:"معاينة، تقييم، تصوير، تسويق — وبعدين أوصلك العميل الجاد." },
  { re:/ضمان|هتنصب|بتاخدوا مقدم/i, ans:"شغلنا بالعقد الواضح، وأي تفاصيل مالية مبدئية تتأكد مع طارق بعد الاتفاق." },
  { re:/المواعيد|بتفتحوا امتى|بتقفلوا امتى|ساعات العمل/i, ans:`مواعيد العمل: ${OFFICE_HOURS}` },
  { re:/بتشتغلوا في التجمع|القاهرة الجديدة|مدينتي|الرحاب/i, ans:OUT_OF_SCOPE_RESPONSE },
  { re:/في رسوم|بتاخدوا فلوس/i, ans:"مفيش رسوم مبدئية. العمولة بس بعد إتمام البيع/الإيجار." },
];
const GOOGLE_AUTHORITY_INTERRUPTS = [
  { re:/ضمان|مصداقية|بتعرف تشتغل|ليه اثق|معرفتك|خبرتك/i, ans:()=>buildGoogleAuthorityShort() },
  { re:/جوجل ماب|google maps|الخرايط|الخريطة|تقييمات|رأى الناس/i, ans:()=>buildGoogleAuthorityMsg() },
  { re:/كام تقييم|كام مراجعة|كام صورة|كام مشاهدة/i, ans:()=>buildGoogleAuthorityMsg() },
];
const IDENTITY_Q_PATTERNS = [
  /بوت|روبوت|شات\s*جي\s*بي\s*تي|جي\s*بي\s*تي|chat\s*gpt|\bgpt\b|openai|\b(bot|robot)\b|artificial|ذكاء\s*اصطناعي|a\.?i\.?\b/i,
  /انسان|إنسان|بني\s*آدم|بني\s*ادم|شخص\s*حقيقي|حد\s*حقيقي|شخص\s*بشري|حد\s*بشري|رد\s*بشري|human|real\s*person|are\s*you\s*(real|human)|not\s*a\s*(bot|machine)/i,
  /مين\s*انت|انت\s*مين|حضرتك\s*مين|مين\s*حضرتك|انت\s*طارق|حضرتك\s*طارق|معاك\s*طارق|ده\s*طارق|اسمك\s*(ايه|إيه)|who\s*are\s*you|are\s*you\s*tarek/i,
  /(عايز|محتاج|ممكن|ابغى|احب|ياريت)\s*(اتكلم|اكلم|كلموني|كلملي|كلم|مكالمة|اتصل|يتصل|قابل|اشوف)\s*(مع\s*)?(حد|شخص|واحد|موظف|مدير|مسؤول|طارق|الاستاذ\s*طارق|مين)/i,
  /(حد|شخص|موظف|مدير|مسؤول|طارق)\s*(يتواصل|يتكلم|يتصل|يكلمني|يجيلي|يجي)\s*(معايا|معي|ليا|اياي)?/i,
  /(كلمني|كلموني|كلملي|وصلني|وصلوني|ابعتلي|اعرضني|عرضني)\s*((على|[لب])\s*)?(حد|شخص|موظف|مدير|مسؤول|طارق)/i,
  /(فين|وين)\s*طارق|طارق\s*(فين|وين|موجود|بيرد|على\s*الخط|متاح)/i,
  /(اللي\s*)?(بيرد|بترد|بيكتب|بتكتب|على\s*الخط)\s*(ده|دي)?\s*مين|مين\s*(اللي\s*)?(بيرد|بترد|بيكتب|بتكتب|على\s*الخط)/i,
  /مين\s*صاحب|صاحب\s*(الموقع|الصفحة|الحساب|الشركة|المكتب)/i,
  /(talk|speak|call|chat)\s*(to|with)\s*(a\s*)?(human|person|real\s*person|someone\s*real|tarek|manager)/i,
];
const IDENTITY_NORM_SUBSTR = [
  "مينانت","انتمين","حضرتكمين","مينحضرتك","انتطارق","حضرتكتارق","معاكطارق","دهطارق",
  "اسمكايها","اسمكايه","حدحقيقي","شخصحقيقي","عايزحد","ممكنحد","اتكلمحد","كلموني","مينالليبرد",
  "الليبيرد","الليبترد","الليبيكتب","مينصاحب",
];
function isIdentityQ(msg){
  const t=String(msg||"").trim();
  if(!t)return false;
  if(IDENTITY_Q_PATTERNS.some(re=>re.test(t)))return true;
  const n=normAr(t);
  return IDENTITY_NORM_SUBSTR.some(s=>n.includes(s));
}
const VALUATION_REQUEST_RE = /(عايز|ممكن|محتاج|وريني|أشوف|اشوف|هات|فين|ايه|إيه)\s*(التقييم|تقييم|قيم عقاري|قيّم عقاري)/i;

function matchInterrupt(msg, fs){
  const text = String(msg||"");
  if(PRICE_OBJECTION_RE.test(text)) return PRICE_OBJECTION_RESPONSE;
  if(HESITATION_RE.test(text)) return HESITATION_RESPONSE;
  if(VALUATION_REQUEST_RE.test(String(msg||""))){
    if(fs?.data?.valuation) return buildValuationAnnouncement(fs.data.valuation);
    return "التقييم متاح وأنت في مسار تسجيل عقار. ابدأ بـ 💰 أبيع أو 🔑 أأجر وهتلاقي زر التقييم.";
  }
  for(const r of GOOGLE_AUTHORITY_INTERRUPTS){ if(r.re.test(String(msg||""))) return typeof r.ans==="function"?r.ans():r.ans; }
  for(const r of INTERRUPTS) if(r.re.test(String(msg||""))) return r.ans;
  return null;
}
function isOfficeQ(text){
  const t=normAr(text);
  return ["هو مكتبكم فين","هو المكتب فين","مكتبكم فين","المكتب فين","فين المكتب","فين مكتبكم","عنوان المكتب ايه","عنوانكم ايه","عنوانكم فين","العنوان ايه","العنوان فين","عنوانك ايه"].some(p=>normAr(p)===t);
}
function officeStatusNote(now=cairoNow()){
  const {hour,isFriday}=now;
  if(isFriday) return "النهاردة الجمعة والمكتب إجازة.";
  if(hour>=21||hour<12) return "المكتب قافل دلوقتي، بيفتح 12 الضهر.";
  return "";
}
const officeMsg = () => {
  const note = officeStatusNote();
  return `${note?note+"\n\n":""}📌 عنوان المكتب: ${OFFICE_ADDRESS}\n\n🗺️ اللوكيشن: ${OFFICE_MAP_URL}\n\n⏰ المواعيد: ${OFFICE_HOURS}\n\n📝 الأفضل تكلمنا على الواتساب قبل ما تجي.`;
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
const isValuation  = m => isBtn(m,BTN.VALUATION)||/قيّم عقارك|قيم عقارك|التقييم/i.test(String(m||""));

// ═══ CACHE ═══
let feedCache = { at:0, data:null };
const lmCache = new Map();
const geminiCache = new Map();
function cacheSet(map,key,value){
  if(map.size>=CACHE_MAX_KEYS){ const oldest=map.keys().next().value; if(oldest!==undefined)map.delete(oldest); }
  map.set(key,value);
}
async function fetchWithTimeout(url,opts={},timeoutMs=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(),timeoutMs);
  try { return await fetch(url,{...opts,signal:ctrl.signal}); }
  finally { clearTimeout(t); }
}
async function fetchFeed(){
  const now = Date.now();
  if(feedCache.data && (now-feedCache.at)<CACHE_TTL_MS) return feedCache.data;
  try {
    const r = await fetchWithTimeout(AI_FEED_URL,{headers:{"Accept":"application/json"}},FETCH_TIMEOUT_FEED);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const safe = (d&&typeof d==="object")?d:{properties:[]};
    if(!Array.isArray(safe.properties)) safe.properties=[];
    feedCache = { at:now, data:safe };
    return safe;
  } catch(err){
    if(feedCache.data){ console.warn("[feed] fallback to stale cache:",err?.message); return feedCache.data; }
    throw err;
  }
}
async function fetchLandmarks(filters){
  const now = Date.now();
  const key = filters ? JSON.stringify(filters) : "__all__";
  const cached = lmCache.get(key);
  if(cached && (now-cached.at)<LANDMARKS_TTL_MS) return cached.data;
  try {
    const feed = await fetchFeed();
    let props = feed.properties||[];
    if(filters){
      props = props.filter(p=>{
        if(!p)return false;
        if(filters.transaction&&p.transaction!==filters.transaction)return false;
        if(filters.propertyType&&normalizePropType(p.propertyType)!==normalizePropType(filters.propertyType))return false;
        return true;
      });
    }
    const set = new Set();
    for(const p of props){
      const txt = String(p.zone||p.location||"");
      for(const lm of MASTER_LANDMARKS) if(txt.includes(lm)) set.add(lm);
    }
    if(set.size<3){
      for(const p of props){
        const loc = String(p.location||"");
        const part = loc.split(/[-،,(]/)[0].trim();
        if(part?.length>=3 && part.length<=30 && !MASTER_LANDMARKS.some(l=>part.includes(l)||l.includes(part))) set.add(part);
      }
    }
    const lms = [...set].sort((a,b)=>a.localeCompare(b,"ar"));
    cacheSet(lmCache,key,{at:now,data:lms});
    return lms;
  } catch(err){
    console.warn("[landmarks] fallback:",err?.message);
    cacheSet(lmCache,key,{at:now,data:[]});
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// INTELLIGENCE CORE v9.2
// ═══════════════════════════════════════════════════════════

const AGENT_ROLE = Object.freeze({
  BUYER:"BUYER", TENANT:"TENANT", SELLER:"SELLER", LANDLORD:"LANDLORD", UNKNOWN:"UNKNOWN"
});
const AGENT_INTENT = Object.freeze({
  PROPERTY_SEARCH:"PROPERTY_SEARCH",
  PROPERTY_OFFER:"PROPERTY_OFFER",
  VALUATION:"VALUATION",
  PRICE_CHECK:"PRICE_CHECK",
  PROPERTY_DETAILS:"PROPERTY_DETAILS",
  GENERAL_REAL_ESTATE:"GENERAL_REAL_ESTATE",
  FOLLOW_UP:"FOLLOW_UP",
  OUT_OF_SCOPE:"OUT_OF_SCOPE",
  CLARIFICATION:"CLARIFICATION"
});
const DECISION = Object.freeze({
  ANSWER:"ANSWER", ASK:"ASK", SEARCH:"SEARCH", VALUATE:"VALUATE",
  REFUSE:"REFUSE", HANDOFF:"HANDOFF", CONTINUE_FLOW:"CONTINUE_FLOW"
});
const EV = Object.freeze({
  VERIFIED:"VERIFIED", INFERRED:"INFERRED", UNKNOWN:"UNKNOWN", HISTORICAL:"HISTORICAL",
  CUSTOMER:"CUSTOMER_PROVIDED", SYSTEM:"SYSTEM_PROVIDED", TOOL:"TOOL_RESULT"
});

function initAgentState(prev){
  const p = prev && typeof prev==="object" ? prev : {};
  return {
    role: p.role||null, intent: p.intent||null,
    transaction: p.transaction||null, propertyType: p.propertyType||null,
    location: p.location||null, budget: p.budget||null, price: p.price||null,
    area: p.area||null, rooms: p.rooms||null, baths: p.baths||null,
    furnished: p.furnished||null, purpose: p.purpose||null,
    evidence: p.evidence && typeof p.evidence==="object" ? p.evidence : {},
    corrections: Array.isArray(p.corrections) ? p.corrections.slice(-20) : [],
    unknown: Array.isArray(p.unknown) ? p.unknown : [],
    lastAction: p.lastAction||null,
  };
}
function setAgentField(as, key, value, evType){
  if(!as||!key) return as;
  const prev = as[key];
  if(prev!==undefined && prev!==null && prev!=="" && String(prev)!==String(value)){
    as.corrections = [...(as.corrections||[]), {key, from:prev, to:value, at:Date.now()}].slice(-20);
  }
  as[key] = value;
  as.evidence = as.evidence || {};
  as.evidence[key] = evType || EV.CUSTOMER;
  return as;
}
function syncAgentStateFromFlow(as, fs){
  if(!as||!fs) return as;
  const d = fs.data||{};
  if(fs.type==="sale") as.transaction = "SALE";
  else if(fs.type==="rent") as.transaction = "RENT";
  if(hasVal(d.propertyType) && !as.propertyType) setAgentField(as,"propertyType",d.propertyType,EV.CUSTOMER);
  if(hasVal(d.landmark) && !as.location) setAgentField(as,"location",d.landmark,EV.CUSTOMER);
  if(hasVal(d.location) && !as.location) setAgentField(as,"location",d.location,EV.CUSTOMER);
  // ⭐ خصوصية: عنوان الدبوس (reverse-geocode) مش بيدخل agentState أبدًا — الـstate بيرجع للمتصفح وبيتخزن في sessionStorage.
  //    بنسجّل بس إن الموقع معروف (علامة ثابتة) عشان قرار الأسئلة يفضل زي ما هو.
  if(hasVal(d.gps?.address) && !as.location) setAgentField(as,"location","موقع على الخريطة",EV.CUSTOMER);
  if(hasVal(d.budget) && as.budget===null) as.budget = parseNum(d.budget);
  if(hasVal(d.price) && as.price===null) as.price = parseNum(d.price);
  if(hasVal(d.area) && as.area===null) as.area = parseNum(d.area);
  if(hasVal(d.rooms) && as.rooms===null) as.rooms = parseNum(d.rooms);
  if(hasVal(d.baths) && as.baths===null) as.baths = parseNum(d.baths);
  if(hasVal(d.furnished) && !as.furnished) as.furnished = d.furnished;
  if(fs.flowType){
    if(fs.flowType==="buyer"||fs.flowType.startsWith("buyer_")){
      as.role = fs.type==="rent"?AGENT_ROLE.TENANT:AGENT_ROLE.BUYER;
    } else if(fs.flowType==="tenant"){
      as.role = AGENT_ROLE.TENANT;
    } else if(fs.flowType.startsWith("owner")){
      as.role = fs.type==="rent"?AGENT_ROLE.LANDLORD:AGENT_ROLE.SELLER;
    }
  }
  return as;
}

// ⭐ detectRoleFromText — موسّع ليشمل "بتاعتي/ملكي/بتاعنا"
function detectRoleFromText(t){
  const n = normAr(t);

  // مؤشرات الملكية: عندي X / بتاعتي / بتاعي / ملكي / بتاعتنا
  const hasOwnerHint = /عندي\s*(?:شقة|شقه|عقار|محل|فيلا|مكتب|مخزن|روف|أرض|ارض|دوبلكس)|بتاعتي|بتاعى|بتاعي|ملكي|ملكى|بتاعتنا|بتاعنا|الشقة\s*بتاعتي|العقار\s*بتاعي|المحل\s*بتاعي/i.test(t);
  if(hasOwnerHint){
    return /أأجر|ااجر|للإيجار|للايجار|أأجره|مؤجر|مؤجرة/i.test(t) ? AGENT_ROLE.LANDLORD : AGENT_ROLE.SELLER;
  }
  // بيع صريح
  if(/(?:حابب|عايز|ناوي|نفسي)\s*(?:أ|ا)?بيع|أبيع\s*(?:شقتي|عقاري)?/i.test(t)) return AGENT_ROLE.SELLER;
  // شراء
  if(/(?:عايز|محتاج|مطلوب|بدور|نفسي)\s*(?:أ|ا)?(?:شتري|شترى)/i.test(t)) return AGENT_ROLE.BUYER;
  // إيجار
  if(/(?:عايز|محتاج|مطلوب|بدور|نفسي)\s*(?:أ|ا)?(?:أجر|اجر|ستأجر|ستاجر)|سكن\s*عريس|سكن\s*طلاب|مقر\s*(?:لشركة|لشركه)/i.test(t)) return AGENT_ROLE.TENANT;
  return null;
}

// ⭐ detectIntentFromText — موسّع لاصطياد "أعرف سعرها" / "قيمتها كام"
function detectIntentFromText(t, as, facts){
  if(isOutOfArea(t)&&!isNasr(t)) return AGENT_INTENT.OUT_OF_SCOPE;

  // VALUATION — يشمل: أعرف سعرها، أعرف قيمتها، تسوى كام، بكام، قيّم، تقييم...
  if(/قيّم|قيم|تقييم|أقيّم|يسوى|تسوى|بتسوى|قيمة\s*عقاري|(?:أعرف|اعرف|تعرف|أشوف|اشوف|وريني|هات|قولي|قوللي)\s*(?:سعر|سعرها|سعره|أسعار|اسعار|قيمة|قيمتها|قيمته)|سعرها\s*(?:كام|ايه|إيه|قد\s*ايه)|كام\s*(?:تسوى|تسوي|بتسوى|بتسوي)|بكام\s*(?:تتاجر|تتباع|تتأجر|تتأجّر)/i.test(t)) return AGENT_INTENT.VALUATION;

  if(/كويسة|غالي|رخيص|مناسب|السعر\s*ده\s*(?:كام|كويس)|ده\s*سعر\s*كويس|السعر\s*مبالغ/i.test(t) && !PRICE_OBJECTION_RE.test(t)) return AGENT_INTENT.PRICE_CHECK;
  if(/تفاصيل|التفاصيل|مواصفات|عايز\s*أعرف\s*أكتر|كمان\s*معلومة/i.test(t) && (as?.propertyType||as?.location)) return AGENT_INTENT.PROPERTY_DETAILS;
  if(hasVal(as?.propertyType)||hasVal(as?.location)||hasVal(as?.budget)||hasVal(as?.area)) return AGENT_INTENT.FOLLOW_UP;

  if(facts?.transaction||facts?.propertyType||facts?.landmark||facts?.budget){
    if(as?.role===AGENT_ROLE.SELLER||as?.role===AGENT_ROLE.LANDLORD) return AGENT_INTENT.PROPERTY_OFFER;
    return AGENT_INTENT.PROPERTY_SEARCH;
  }
  return AGENT_INTENT.GENERAL_REAL_ESTATE;
}

// ⭐ understandMessage — يمرّر الدور المكتشف للـintent
function understandMessage(msg, as, fs, history){
  const t = String(msg||"").trim();
  const facts = extractRequestFacts(t);
  const detectedRole = detectRoleFromText(t);
  const role = detectedRole || as?.role || null;
  // نمرّر الدور المكتشف للـintent detection عشان يفرّق buyer/seller
  const effectiveAs = detectedRole ? {...as, role: detectedRole} : as;
  const intent = detectIntentFromText(t, effectiveAs, facts);
  return { role, intent, transaction: facts.transaction || as?.transaction || null, entities: facts, raw: t, confidence: 0.7 };
}

function selectBlockingQuestion(as, intent){
  if(intent===AGENT_INTENT.PROPERTY_SEARCH || (intent===AGENT_INTENT.FOLLOW_UP && (as?.role===AGENT_ROLE.BUYER||as?.role===AGENT_ROLE.TENANT))){
    if(!as?.transaction) return {field:"transaction", q:"للشراء ولا للإيجار؟"};
    if(!as?.propertyType) return {field:"propertyType", q:"عايز شقة ولا فيلا ولا محل ولا مكتب؟"};
    if(!as?.location) return {field:"location", q:"العقار في أنهي منطقة في مدينة نصر؟"};
    if(!as?.budget) return {field:"budget", q:"ميزانيتك لحد كام؟"};
    return null;
  }
  if(intent===AGENT_INTENT.PROPERTY_OFFER || (intent===AGENT_INTENT.FOLLOW_UP && (as?.role===AGENT_ROLE.SELLER||as?.role===AGENT_ROLE.LANDLORD))){
    if(!as?.propertyType) return {field:"propertyType", q:"العقار شقة ولا فيلا ولا محل ولا مكتب؟"};
    if(!as?.location) return {field:"location", q:"العقار فين بالضبط في مدينة نصر؟"};
    if(!as?.area) return {field:"area", q:"المساحة كام متر؟"};
    if(!as?.price) return {field:"price", q:"السعر المطلوب كام؟"};
    return null;
  }
  return null;
}

function decideNextAction(understanding, as, fs){
  const intent = understanding?.intent;
  if(intent===AGENT_INTENT.OUT_OF_SCOPE) return {action:DECISION.REFUSE, reason:"out_of_scope_location"};
  if(intent===AGENT_INTENT.VALUATION) return {action:DECISION.VALUATE, payload:{subIntent:"valuation"}};
  if(intent===AGENT_INTENT.PRICE_CHECK) return {action:DECISION.VALUATE, payload:{subIntent:"price_check"}};
  if(intent===AGENT_INTENT.PROPERTY_SEARCH||intent===AGENT_INTENT.PROPERTY_OFFER){
    const blocking = selectBlockingQuestion(as,intent);
    if(blocking) return {action:DECISION.ASK, payload:blocking};
    return {action:DECISION.SEARCH, payload:{as}};
  }
  if(intent===AGENT_INTENT.FOLLOW_UP) return {action:DECISION.CONTINUE_FLOW};
  return {action:DECISION.ANSWER};
}

function detectCorrection(as, newFacts){
  if(!as||!newFacts) return [];
  const corrections = [];
  const map = {landmark:"location", budget:"budget", area:"area", rooms:"rooms", baths:"baths", furnished:"furnished", propertyType:"propertyType"};
  for(const [k,v] of Object.entries(newFacts)){
    if(!hasVal(v)) continue;
    const key = map[k]||k;
    const prev = as[key];
    if(prev!==undefined && prev!==null && prev!=="" && String(prev)!==String(v)){
      corrections.push({field:key, from:prev, to:v});
    }
  }
  return corrections;
}

function currentStepIdOf(fs){
  try { return getSteps(fs?.type, fs?.flowType)[fs?.stepIndex]?.id || null; } catch { return null; }
}
function plausibleArea(n){ const v = Number(n); return Number.isFinite(v) && v >= 1 && v <= 100000; }
function applyUnderstandingToFlowData(fs, understanding){
  if(!fs||!understanding) return fs;
  const d = {...(fs.data||{})};
  const f = understanding.entities||{};
  const owner = String(fs.flowType||"").startsWith("owner");
  const stepId = currentStepIdOf(fs);
  const raw = understanding.raw || "";
  if(!d._filled) d._filled = {};
  if(!hasVal(d.propertyType) && hasVal(f.propertyType)) d.propertyType = f.propertyType;
  if(owner){
    if(!hasVal(d.location) && hasVal(f.landmark)) d.location = f.landmark;
    if(!hasVal(d.price) && hasVal(f.budget) && isClearPriceStatement(raw, stepId)) d.price = f.budget;
  } else {
    if(!hasVal(d.landmark) && hasVal(f.landmark)) d.landmark = f.landmark;
    if(!hasVal(d.budget) && hasVal(f.budget) && isClearPriceStatement(raw, stepId)) d.budget = f.budget;
  }
  if(!hasVal(d.area) && hasVal(f.area) && plausibleArea(f.area)) d.area = f.area;
  if(!hasVal(d.rooms) && hasVal(f.rooms)) d.rooms = f.rooms;
  if(!hasVal(d.baths) && hasVal(f.baths)) d.baths = f.baths;
  if(!hasVal(d.furnished) && hasVal(f.furnished)) d.furnished = f.furnished;
  return {...fs, data:d};
}

// ═══ END INTELLIGENCE CORE ═══

// ═══ STEP DEFINITIONS ═══
function getOwnerSteps(type){
  const isSale = type==="sale";
  return [
    { id:"propertyType", type:"buttons", q:"العقار شقة ولا فيلا ولا دوبلكس ولا محل ولا مكتب ولا مخزن ولا روف؟", opts:["شقة","فيلا","دوبلكس","محل تجاري","مكتب إداري","مخزن","روف"] },
    { id:"location", type:"text", q:"العقار فين بالضبط؟ اكتب الشارع والمنطقة.", err:"اكتب العنوان بالتفصيل." },
    { id:"area", type:"number", q:"المساحة كام متر؟", err:"اكتب المساحة بالمتر." },
    { id:"price", type:"number", q:isSale?"السعر المطلوب كام؟":"الإيجار الشهري كام؟", err:"اكتب السعر رقم." },
    { id:"rooms", type:"buttons", q:"عدد الغرف كام؟", opts:["1","2","3","4","5+"], when:d=>isResidential(d.propertyType)&&!isVilla(d.propertyType) },
    { id:"baths", type:"buttons", q:"عدد الحمامات كام؟", opts:["1","2","3+"], when:d=>isResidential(d.propertyType) },
    { id:"floor", type:"buttons", q:"الدور الكام؟", opts:SUBTYPE_OPTIONS["شقة"], when:d=>d.propertyType==="شقة" },
    { id:"villaType", type:"buttons", q:"نوع الفيلا إيه؟", opts:SUBTYPE_OPTIONS["فيلا"], when:d=>isVilla(d.propertyType) },
    { id:"duplexType", type:"buttons", q:"نوع الدوبلكس إيه؟", opts:SUBTYPE_OPTIONS["دوبلكس"], when:d=>isDuplex(d.propertyType) },
    { id:"roofType", type:"buttons", q:"طبيعة الروف إيه؟", opts:SUBTYPE_OPTIONS["روف"], when:d=>d.propertyType==="روف" },
    { id:"shopType", type:"buttons", q:"موقع المحل إيه؟", opts:SUBTYPE_OPTIONS["محل تجاري"], when:d=>isShop(d.propertyType) },
    { id:"officeType", type:"buttons", q:"تصنيف المكتب إيه؟", opts:SUBTYPE_OPTIONS["مكتب إداري"], when:d=>isOffice(d.propertyType) },
    { id:"storageType", type:"buttons", q:"موقع وطبيعة المخزن إيه؟", opts:SUBTYPE_OPTIONS["مخزن"], when:d=>isWarehouse(d.propertyType) },
    { id:"finishing", type:"buttons", q:"التشطيب إيه؟", opts:["ألترا سوبر لوكس","سوبر لوكس","نصف تشطيب","طوب أحمر"], when:d=>isResidential(d.propertyType) },
    { id:"furnished", type:"buttons", q:"الإيجار مفروش ولا فاضي (قانون جديد)؟", opts:["مفروش","فاضي (قانون جديد)"], when:d=>!isSale&&isResidential(d.propertyType) },
    { id:"duration", type:"text", q:"مدة العقد المطلوبة كام؟", when:d=>!isSale&&d.furnished==="فاضي (قانون جديد)" },
    { id:"rentPeriods", type:"buttons", q:"المدة المطلوبة إيه؟", opts:["أسبوعي","شهري","سنوي"], when:d=>!isSale&&d.furnished==="مفروش" },
    { id:"priceWeekly", type:"number", q:"الإيجار الأسبوعي كام؟", when:d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="أسبوعي" },
    { id:"priceMonthly", type:"number", q:"الإيجار الشهري كام؟", when:d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="شهري" },
    { id:"priceYearly", type:"number", q:"الإيجار السنوي كام؟", when:d=>!isSale&&d.furnished==="مفروش"&&d.rentPeriods==="سنوي" },
    { id:"furnitureQuality", type:"buttons", q:"مستوى الأثاث إيه؟", opts:["فاخر","جيد جداً","جيد","اقتصادي"], when:d=>!isSale&&d.furnished==="مفروش" },
    { id:"businessType", type:"text", q:"النشاط الحالي إيه؟", when:d=>isShop(d.propertyType)||isOffice(d.propertyType) },
    { id:"frontage", type:"buttons", q:"المحل على ناصية ولا واجهة واحدة؟", opts:["ناصية","واجهة واحدة"], when:d=>isShop(d.propertyType) },
    { id:"officesCount", type:"buttons", q:"عدد المكاتب كام؟", opts:["1","2","3","4","5+"], when:d=>isOffice(d.propertyType) },
    { id:"warehouseType", type:"text", q:"المخزن مناسب لتخزين إيه؟", when:d=>isWarehouse(d.propertyType) },
    { id:"notes", type:"text", q:"في أي تفاصيل مهمة تانية؟ ولو مفيش اكتب لا." },
    { id:"valuationGift", type:"gift",
      q:`تمام، خلصنا البيانات الأساسية 👌\n\n💎 *هدية مننا:* قبل ما نطلب رقمك، تقدر تقيّم عقارك من بيانات السوق الحقيقية في مدينة نصر، وتعرف قيمته الاسترشادية.\n\nالخدمة مجانية، وتقدر تخرج وترجع وقت ما تحب.`,
      when:d=>!d._valuationGiftShown },
    { id:"ownerName", type:"text", q:"اسم حضرتك إيه؟" },
    { id:"ownerPhone", type:"phone", q:"رقم الموبايل اللي طارق يتواصل عليه؟", err:"اكتب رقم موبايل مصري 11 رقم يبدأ بـ01." },
    { id:"images", type:"images_step", q:`لو عندك صور، تقدر ترفقها دلوقتي (لحد ${MAX_IMAGES}).` },
  ];
}
function getBuyerSteps(type){
  const isSale = type==="sale";
  return [
    { id:"propertyType", type:"buttons", q:"عايز شقة ولا فيلا ولا دوبلكس ولا محل ولا مكتب ولا مخزن ولا روف؟", opts:["شقة","فيلا","دوبلكس","محل تجاري","مكتب إداري","مخزن","روف"] },
    { id:"landmark", type:"dynamic_buttons", q:"عايز العقار في أنهي منطقة؟" },
    { id:"area", type:"number", q:"المساحة كام متر؟", opts:["80","100","120","150","180","200"], err:"اكتب المساحة بالمتر." },
    { id:"budget", type:"number", q:isSale?"ميزانيتك لحد كام؟":"ميزانيتك الشهرية لحد كام؟" },
    { id:"villaType", type:"buttons", q:"بتفضل نوع الفيلا إيه؟", opts:SUBTYPE_OPTIONS["فيلا"], when:d=>isVilla(d.propertyType) },
    { id:"duplexType", type:"buttons", q:"بتفضل نوع الدوبلكس إيه؟", opts:SUBTYPE_OPTIONS["دوبلكس"], when:d=>isDuplex(d.propertyType) },
    { id:"shopType", type:"buttons", q:"بتفضل موقع المحل إيه؟", opts:SUBTYPE_OPTIONS["محل تجاري"], when:d=>isShop(d.propertyType) },
    { id:"officeType", type:"buttons", q:"بتفضل نوع المكتب إيه؟", opts:SUBTYPE_OPTIONS["مكتب إداري"], when:d=>isOffice(d.propertyType) },
    { id:"storageType", type:"buttons", q:"بتفضل المخزن يكون إيه؟", opts:SUBTYPE_OPTIONS["مخزن"], when:d=>isWarehouse(d.propertyType) },
    { id:"rooms", type:"buttons", q:"محتاج كام غرفة؟", opts:["1","2","3","4","5+"], when:d=>isResidential(d.propertyType)&&!isVilla(d.propertyType) },
    { id:"baths", type:"buttons", q:"محتاج كام حمام؟", opts:["1","2","3+"], when:d=>isResidential(d.propertyType) },
    { id:"furnished", type:"buttons", q:"عايزه مفروش ولا فاضي؟", opts:["مفروش","فاضي (قانون جديد)"], when:d=>!isSale&&isResidential(d.propertyType) },
    { id:"businessActivity", type:"text", q:"النشاط التجاري/الإداري إيه؟", when:d=>isCommercial(d.propertyType) },
    { id:"buyerName", type:"text", q:"اسم حضرتك إيه عشان طارق يعرف يكلم مين؟", err:"اكتب اسم حضرتك." },
    { id:"buyerPhone", type:"phone", q:"رقم الموبايل اللي طارق يتواصل عليه؟", err:"اكتب رقم موبايل مصري 11 رقم يبدأ بـ01." },
  ];
}
function getSteps(type, flowType){
  if(!flowType) return getOwnerSteps(type);
  if(["buyer","tenant","buyer_","buyer_completed"].some(x=>flowType===x||flowType.startsWith("buyer_"))) return getBuyerSteps(type);
  return getOwnerSteps(type);
}

// ═══ STEP ENGINE ═══
const REQUIRED_OWNER = ["propertyType","location","area","price","ownerPhone"];
const REQUIRED_BUYER = ["propertyType","landmark","area","budget"];
const CORE_OWNER = new Set(["propertyType","location","area","price"]);
const CORE_BUYER = new Set(["propertyType","landmark","area","budget"]);
function missingCore(data, owner){
  return (owner?REQUIRED_OWNER:REQUIRED_BUYER).filter(id=>id!=="ownerPhone"&&!hasVal(data?.[id]));
}
function stepKey(step){ return step?._key||step?.id||""; }
function isApplicable(step, data){ if(!step)return false; if(typeof step.when!=="function")return true; try{ return !!step.when(data||{}); }catch{ return false; } }
function isFilled(data, step){ if(!step)return false; const k=stepKey(step); return !!(data?._filled?.[k])||hasVal(data?.[k]); }
function markFilled(data, step){ if(!data._filled)data._filled={}; const k=stepKey(step); if(k)data._filled[k]=true; }
function hydrateData(data, steps){
  const d = data||{};
  if(!d._filled) d._filled = {};
  for(const s of steps||[]) if(isApplicable(s,d)&&hasVal(d[stepKey(s)])) d._filled[stepKey(s)] = true;
  return d;
}
function nextStep(steps, data, from=0){
  const d = hydrateData(data, steps);
  for(let i=Math.max(0,from);i<steps.length;i++){
    const s = steps[i];
    if(isApplicable(s,d)&&!isFilled(d,s)) return i;
  }
  return -1;
}
function countSteps(steps, data){ return (steps||[]).filter(s=>isApplicable(s,data)).length; }
function buildProgress(steps, data, idx){
  const total = countSteps(steps, data);
  const before = (steps||[]).slice(0,idx).filter(s=>isApplicable(s,data)&&isFilled(data,s)).length;
  const current = Math.min(total, before+1);
  const remaining = Math.max(0, total-before-1);
  const pct = total ? Math.round((before/total)*100) : 0;
  return {current,total,remaining,pct};
}
function withCtrl(opts, data, showBack=true, allowSkip=true){
  const o = [...(opts||[])];
  if(showBack) o.push(BTN.BACK);
  if(allowSkip) o.push(BTN.SKIP);
  const areaKnown = hasVal(data?.location)||hasVal(data?.landmark);
  const sizeKnown = hasVal(data?.area);
  const moneyKnown = hasVal(data?.price)||hasVal(data?.budget)||hasVal(data?.priceMonthly)||hasVal(data?.priceYearly)||hasVal(data?.priceWeekly);
  if(hasVal(data?.propertyType)&&areaKnown&&sizeKnown&&moneyKnown) o.push(BTN.SEND);
  o.push(BTN.CANCEL);
  o.push(BTN.NEW_REQ);
  return [...new Set(o)];
}

// ═══ SCORING ═══
function scoreProperty(p, criteria){
  let score = 30;
  const targetType = normalizePropType(criteria.propertyType);
  const pType = normalizePropType(p.propertyType||p.type||p.category);
  if(targetType){
    if(targetType==="دوبلكس"){ if(pType!=="دوبلكس"&&pType!=="فيلا")return -999; score+=25; }
    else if(targetType==="فيلا"){ if(pType!=="فيلا"&&pType!=="دوبلكس")return -999; score+=25; }
    else { if(pType!==targetType)return -999; score+=30; }
  }
  if(criteria.transaction){
    const pTx = (p.transaction==="rent"||normAr(p.transaction).includes("ايجار"))?"rent":"sale";
    if(pTx===criteria.transaction) score+=20; else return -999;
  }
  if(criteria.landmark){
    const txt = String(p.zone||p.location||"");
    const txtNorm = normAr(txt); const lmNorm = normAr(criteria.landmark);
    if(txtNorm.includes(lmNorm)) score+=20;
    else if(lmNorm.includes(txtNorm)) score+=10;
    else { const sim = similarity(txt, criteria.landmark); if(sim>=0.6) score+=5; }
  }
  const budget = parseNum(criteria.budget);
  if(budget>0){
    const price = parseNum(p.priceNumeric||p.price);
    if(price>0){
      const ratio = price/budget;
      if(ratio<=0.95) score+=25;
      else if(ratio<=1.0) score+=20;
      else if(ratio<=1.1) score+=10;
      else if(ratio<=1.2) score+=0;
      else if(ratio<=1.3) score-=10;
      else score-=30;
    }
  }
  const rooms = parseNum(criteria.rooms);
  if(rooms>0){
    const r = parseNum(p.roomsNumeric||p.rooms);
    if(r===rooms) score+=15;
    else if(r===rooms+1||r===rooms-1) score+=5;
    else if(r>rooms) score+=3;
    else if(r<rooms) score-=10;
  }
  const baths = parseNum(criteria.baths);
  if(baths>0){
    const b = parseNum(p.bathsNumeric||p.baths);
    if(b===baths) score+=8;
    else if(b>baths) score+=3;
    else if(b<baths) score-=5;
  }
  if(criteria.furnished){
    const pf = p.furnished===true?"مفروش":p.furnished===false?"فاضي (قانون جديد)":String(p.furnished||"");
    if(pf&&pf===criteria.furnished) score+=10;
    else if(pf&&pf!==criteria.furnished) score-=20;
  }
  return score;
}
function filterAndRank(properties, criteria){
  if(!Array.isArray(properties)) return [];
  const targetType = normalizePropType(criteria.propertyType);
  const targetTx = criteria.transaction;
  return properties
    .filter(p=>{
      if(!p)return false;
      if(targetTx){
        const pTx = (p.transaction==="rent"||normAr(p.transaction).includes("ايجار"))?"rent":"sale";
        if(pTx!==targetTx)return false;
      }
      if(targetType){
        const pType = normalizePropType(p.propertyType||p.type||p.category);
        if(targetType==="دوبلكس"){ if(pType!=="دوبلكس"&&pType!=="فيلا")return false; }
        else if(targetType==="فيلا"){ if(pType!=="فيلا"&&pType!=="دوبلكس")return false; }
        else { if(pType!==targetType)return false; }
      }
      return true;
    })
    .map(p=>({p, score:scoreProperty(p,criteria)}))
    .filter(x=>x.score>=MIN_SCORE)
    .sort((a,b)=>b.score-a.score)
    .slice(0,5)
    .map(x=>x.p);
}

// ═══ GPS ═══
function sanitizeGps(g){
  if(!g||typeof g!=="object") return null;
  const lat = Number(g.lat), lng = Number(g.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)) return null;
  if(Math.abs(lat)>90||Math.abs(lng)>180) return null;
  const address = String(g.address||"").replace(/[\u0000-\u001F\u007F<>]/g," ").replace(/\s+/g," ").trim().slice(0,200);
  return { lat: Math.round(lat*1e5)/1e5, lng: Math.round(lng*1e5)/1e5, address };
}
function gpsLines(data){
  const g = sanitizeGps(data?.gps);
  if(!g) return [];
  const out = [];
  if(g.address && g.address!==String(data.location||"").trim() && g.address!==String(data.landmark||"").trim())
    out.push(`│ 🗺️ العنوان (خريطة): ${g.address}`);
  out.push(`│ 📍 الإحداثيات: ${g.lat}, ${g.lng}`);
  return out;
}

// ═══ WA MESSAGE BUILDER ═══
function buildWAMsg(ctx, data, imgUrls=[]){
  const isOwner = ctx==="owner_sale"||ctx==="owner_rent";
  const isSale = ctx==="owner_sale"||ctx==="buyer";
  const isRent = ctx==="owner_rent"||ctx==="tenant";
  const pt = data.propertyType||"عقار";
  const requestLabel = getRequestLabel(isRent?"rent":"sale", pt, data.furnished, isOwner);
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
  if(isOwner){
    if(hasVal(data.location)) lines.push(`│ 📍 الموقع: ${data.location}`);
    lines.push(...gpsLines(data));
    if(hasVal(data.area)) lines.push(`│ 📐 المساحة: ${fmtVal(data.area)} م²`);
    if(isShop(pt)){
      if(hasVal(data.shopType)) lines.push(`│ 🏪 الموقع: ${data.shopType}`);
      if(hasVal(data.businessType)) lines.push(`│ 💼 النشاط: ${data.businessType}`);
      if(hasVal(data.frontage)) lines.push(`│ 🚪 الواجهة: ${data.frontage}`);
    }
    if(isOffice(pt)){
      if(hasVal(data.officeType)) lines.push(`│ 🏢 النوع: ${data.officeType}`);
      if(hasVal(data.businessType)) lines.push(`│ 💼 النشاط: ${data.businessType}`);
      if(hasVal(data.officesCount)) lines.push(`│ 🚪 عدد المكاتب: ${fmtVal(data.officesCount)}`);
    }
    if(isWarehouse(pt)){
      if(hasVal(data.storageType)) lines.push(`│ 🏭 الموقع: ${data.storageType}`);
      if(hasVal(data.warehouseType)) lines.push(`│ 📦 التخزين: ${data.warehouseType}`);
    }
    if(isVilla(pt)&&hasVal(data.villaType)) lines.push(`│ 🏡 النوع: ${data.villaType}`);
    if(isDuplex(pt)&&hasVal(data.duplexType)) lines.push(`│ 🏡 نوع الدوبلكس: ${data.duplexType}`);
    if(pt==="روف"&&hasVal(data.roofType)) lines.push(`│ 🌅 طبيعة الروف: ${data.roofType}`);
    if(isRent&&data.furnished==="مفروش"){
      lines.push(`│ 🛋️ نوع الإيجار: مفروش`);
      if(hasVal(data.rentPeriods)) lines.push(`│ 📅 المدة: ${data.rentPeriods}`);
      if(hasVal(data.furnitureQuality)) lines.push(`│ 🪑 الأثاث: ${data.furnitureQuality}`);
      if(hasVal(data.priceWeekly)) lines.push(`│ 💰 الإيجار الأسبوعي: ${fmtNum(data.priceWeekly)} ج.م`);
      if(hasVal(data.priceMonthly)) lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.priceMonthly)} ج.م`);
      if(hasVal(data.priceYearly)) lines.push(`│ 💰 الإيجار السنوي: ${fmtNum(data.priceYearly)} ج.م`);
      if(!hasVal(data.priceWeekly)&&!hasVal(data.priceMonthly)&&!hasVal(data.priceYearly)&&hasVal(data.price))
        lines.push(`│ 💰 السعر: ${fmtNum(data.price)} ج.م`);
    } else if(isRent&&data.furnished==="فاضي (قانون جديد)"){
      lines.push(`│ 🛋️ نوع الإيجار: فاضي (قانون جديد)`);
      if(hasVal(data.duration)) lines.push(`│ 📅 مدة العقد: ${data.duration}`);
      if(hasVal(data.price)) lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.price)} ج.م`);
    } else if(isRent&&hasVal(data.price)){
      lines.push(`│ 💰 الإيجار الشهري: ${fmtNum(data.price)} ج.م`);
    } else if(isSale&&hasVal(data.price)){
      lines.push(`│ 💰 السعر المطلوب: ${fmtNum(data.price)} ج.م`);
    }
    if(isResidential(pt)&&!isVilla(pt)){
      if(hasVal(data.rooms)) lines.push(`│ 🛏️ الغرف: ${fmtVal(data.rooms)}`);
      if(hasVal(data.baths)) lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    }
    if(isVilla(pt)&&hasVal(data.baths)) lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    if(hasVal(data.floor)) lines.push(`│ 🏢 الدور: ${data.floor}`);
    if(hasVal(data.finishing)) lines.push(`│ ✨ التشطيب: ${data.finishing}`);
    if(hasVal(data.notes)&&data.notes!=="لا") lines.push(`│ 📝 ملاحظات: ${data.notes}`);
  } else {
    const landmark = data.landmark&&data.landmark!=="__ANY__"?data.landmark:"أي منطقة في مدينة نصر";
    lines.push(`│ 📍 المنطقة: ${landmark}`);
    lines.push(...gpsLines(data));
    const bgt = hasVal(data.budget)?data.budget:data.price;
    if(hasVal(bgt)) lines.push(`│ 💰 الميزانية: ${fmtNum(bgt)} ج.م`);
    if(isVilla(pt)&&hasVal(data.villaType)) lines.push(`│ 🏡 نوع الفيلا: ${data.villaType}`);
    if(isDuplex(pt)&&hasVal(data.duplexType)) lines.push(`│ 🏡 نوع الدوبلكس: ${data.duplexType}`);
    if(isShop(pt)&&hasVal(data.shopType)) lines.push(`│ 🏪 موقع المحل: ${data.shopType}`);
    if(isOffice(pt)&&hasVal(data.officeType)) lines.push(`│ 🏢 نوع المكتب: ${data.officeType}`);
    if(isWarehouse(pt)&&hasVal(data.storageType)) lines.push(`│ 🏭 طبيعة المخزن: ${data.storageType}`);
    if(isCommercial(pt)&&hasVal(data.businessActivity)) lines.push(`│ 💼 النشاط: ${data.businessActivity}`);
    if(isResidential(pt)&&!isVilla(pt)&&hasVal(data.rooms)) lines.push(`│ 🛏️ الغرف: ${fmtVal(data.rooms)}`);
    if(isResidential(pt)&&hasVal(data.baths)) lines.push(`│ 🛁 الحمامات: ${fmtVal(data.baths)}`);
    if(hasVal(data.furnished)) lines.push(`│ 🛋️ حالة الفرش: ${data.furnished}`);
    if(hasVal(data.notes)) lines.push(`│ 📝 ملاحظات: ${data.notes}`);
  }
  lines.push(`└───────────────────`);
  if(isOwner&&data.valuation&&data.valuation.estimate>0){
    const v = data.valuation;
    const fmtN = n => Number(n||0).toLocaleString("en-US");
    const confLabel = v.confidence==="high"?"عالية":v.confidence==="medium"?"متوسطة":v.confidence==="low"?"منخفضة":"غير محددة";
    lines.push("",`💎 *التقييم السوقي (استرشادي):*`,`┌───────────────────`);
    lines.push(`│ 💰 السعر التقديري: ${fmtN(v.estimate)} ج.م`);
    if(v.perMeter>0) lines.push(`│ 📏 سعر المتر: ${fmtN(v.perMeter)} ج.م`);
    if(v.p25>0&&v.p75>0) lines.push(`│ 📊 نطاق المتر (P25–P75): ${fmtN(v.p25)} – ${fmtN(v.p75)} ج.م`);
    if(v.confidence) lines.push(`│ 🎯 الثقة: ${confLabel}`);
    if(v.samples>0) lines.push(`│ 🧪 العينات: ${fmtN(v.samples)}`);
    if(v.area) lines.push(`│ 📍 منطقة التقييم: ${v.area}`);
    lines.push(`└───────────────────`);
  }
  if(!isOwner&&hasVal(data.selectedProperty)){
    lines.push("",`🎯 *العقار المختار للمعاينة:*`,`┌───────────────────`);
    lines.push(`│ 📌 ${data.selectedProperty}`);
    if(hasVal(data.selectedLocation)) lines.push(`│ 📍 ${data.selectedLocation}`);
    if(hasVal(data.selectedPrice)&&data.selectedPrice!=="0") lines.push(`│ 💰 ${data.selectedPrice} ج.م`);
    if(hasVal(data.selectedArea)) lines.push(`│ 📐 ${data.selectedArea}`);
    if(hasVal(data.selectedRooms)) lines.push(`│ 🛏️ ${data.selectedRooms} غرف`);
    if(hasVal(data.selectedBaths)) lines.push(`│ 🛁 ${data.selectedBaths} حمام`);
    if(hasVal(data.selectedFloor)) lines.push(`│ 🏢 ${data.selectedFloor}`);
    if(hasVal(data.selectedFinishing)) lines.push(`│ ✨ ${data.selectedFinishing}`);
    if(hasVal(data.selectedImage)) lines.push(`│ 📷 ${data.selectedImage}`);
    if(hasVal(data.selectedUrl)) lines.push(`│ 🔗 ${data.selectedUrl}`);
    lines.push(`└───────────────────`);
    lines.push(``,`📩 *عميل مهتم* — جاهز للتواصل`);
  }
  const hasAnyContact = hasVal(data.ownerName)||hasVal(data.ownerPhone)||hasVal(data.buyerName)||hasVal(data.buyerPhone)||hasVal(data.phone);
  if(hasAnyContact){
    lines.push("",`👤 *بيانات العميل:*`);
    if(hasVal(data.ownerName)) lines.push(`• الاسم: ${data.ownerName}`);
    if(hasVal(data.ownerPhone)) lines.push(`• الرقم: ${data.ownerPhone}`);
    if(hasVal(data.buyerName)) lines.push(`• الاسم: ${data.buyerName}`);
    if(hasVal(data.buyerPhone)) lines.push(`• الرقم: ${data.buyerPhone}`);
    if(hasVal(data.phone)) lines.push(`• الرقم: ${data.phone}`);
  }
  if(imgUrls?.length){
    lines.push("",`📷 *الصور المرفقة:* ${imgUrls.length} صورة`);
    imgUrls.forEach((u,i)=>lines.push(`${i+1}. ${u}`));
  }
  lines.push("",`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🏆 *طارق طنطاوي* — ${GOOGLE_PROFILE.badge}`);
  lines.push(`📸 ${GOOGLE_PROFILE.photosCount} صورة | ⭐ ${GOOGLE_PROFILE.reviewsCount} مراجعة`);
  lines.push(`👁️ ${GOOGLE_PROFILE.formattedViews} مشاهدة على Google Maps`);
  lines.push(`🗺️ ${GOOGLE_PROFILE.url}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`_تم تجهيز الطلب من موقع سمسار طلبك — طارق طنطاوي_`);
  return lines.join("\n");
}
const waURL = (phone,msg) => `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;

// ═══ FORM STATE ═══
const LC = { ACTIVE:"active", DONE:"completed", CANCELLED:"cancelled" };
function sanitizeState(fs){
  if(!fs?.active) return fs;
  if(fs._version&&fs._version!==FORM_VERSION) return {active:false,lifecycle:LC.CANCELLED,type:null,stepIndex:-1,data:{},awaitingQ:false,flowType:null,imageUrls:[],_version:FORM_VERSION};
  if(fs._savedAt&&(Date.now()-fs._savedAt)>86400000) return {active:false,lifecycle:LC.CANCELLED,type:null,stepIndex:-1,data:{},awaitingQ:false,flowType:null,imageUrls:[]};
  try {
    const steps = getSteps(fs.type,fs.flowType);
    if(steps.length){
      if(typeof fs.stepIndex!=="number"||fs.stepIndex<-1||fs.stepIndex>=steps.length) fs.stepIndex = 0;
      if(fs.data) fs.data = hydrateData(fs.data, steps);
    }
  } catch {}
  return fs;
}

// ═══ GEMINI ═══
function asciiDigits(s){
  return String(s??"").replace(/[٠-٩۰-۹]/g,d=>{ const c=d.charCodeAt(0); return String(c>=0x06F0?c-0x06F0:c-0x0660); });
}
const EG_MOBILE_RE = /(?<!\d)\(?(?:(?:\+|00)[\s.\-]{0,2})?(?:20\)?[\s.\-]{0,2})?(?:\(?0[\s.\-]{0,2})?1[0125]\)?(?:[\s.\-]{0,2}\d){8}(?!\d)/g;
const EG_NATIONAL_ID_RE = /(?<!\d)[23]\d{13}(?!\d)/g;
function redactPII(s){ return asciiDigits(s).replace(EG_NATIONAL_ID_RE,"[رقم]").replace(EG_MOBILE_RE,"[رقم]"); }
function sanitizeForPrompt(s, max=300){
  return redactPII(s)
    .replace(/[`\u0000-\u001F\u007F]/g," ")
    .replace(/\b(ignore|disregard|system\s*prompt|forget)\b/gi,"")
    .replace(/تجاهل\s+(كل\s+)?(التعليمات|اللي\s*فات)/g,"")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,max);
}
const PII_KEYS = new Set(["ownerName","ownerPhone","buyerName","buyerPhone","phone","_filled"]);
const LOCATION_KEYS = new Set(["gps","location","address","lat","lng","lon","latitude","longitude","coords","coordinates","mapUrl","mapsUrl","googleMapsUrl"]);
function safeDataForPrompt(data){
  const out = {};
  const rawCanon = (Array.isArray(data?._rawLocations) ? data._rawLocations : [])
    .map(x => addrCanon(String(x||"")).s).filter(x => x.length >= 6);
  for(const [k,v] of Object.entries(data||{})){
    if(PII_KEYS.has(k)||LOCATION_KEYS.has(k)) continue;
    if(k.startsWith("_")||k.startsWith("selected")) continue;
    if(k==="valuation"){
      if(v&&typeof v==="object"){ const {estimate,perMeter,p25,p75,confidence,samples,areaType}=v; out.valuation={estimate,perMeter,p25,p75,confidence,samples,areaType}; }
      continue;
    }
    if(!hasVal(v)) continue;
    // ⭐ F2: أي قيمة نصية (notes/landmark/أي حقل مستقبلي) تُنقّى قبل الـprompt،
    //    وأي قيمة هي جزء من عنوان خام كتبه العميل بنفسه تُستبدل بالكامل
    if(typeof v === "string"){
      const cv = addrCanon(v).s;
      out[k] = (cv.length>=3 && rawCanon.some(r => r.includes(cv))) ? "[عنوان]" : sanitizeForPrompt(scrubAddresses(v, data),60);
    } else out[k] = v;
  }
  return redactPII(JSON.stringify(out)).slice(0,500);
}
// العنوان الخام اللي العميل كتبه بنفسه — بيتحفظ قبل أي تطبيع لمنطقة عشان التنقية تلاقيه
function rememberRawLocation(data, raw){
  const t = String(raw||"").trim();
  if(t.length<6) return data;
  const list = Array.isArray(data?._rawLocations) ? data._rawLocations : [];
  if(list.includes(t)) return data;
  return { ...data, _rawLocations: [...list, t].slice(-5) };
}
// ═══ F3: تطبيع عربي خفيف (ه/ة · ي/ى · الهمزات · التشكيل · المسافات · الترقيم) — بلا false positives واسعة ═══
const AR_DIACRITIC = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;
const AR_CANON_MAP = { "ة":"ه", "ى":"ي", "أ":"ا", "إ":"ا", "آ":"ا", "ٱ":"ا", "ؤ":"و", "ئ":"ي" };
function addrCanon(text){
  const src = String(text||""); let s = ""; const map = [];
  for(let i=0;i<src.length;i++){
    const ch = src[i];
    if(AR_DIACRITIC.test(ch)) continue;
    s += (AR_CANON_MAP[ch] || ch); map.push(i);
  }
  return { s, map };
}
// مطابقة متحمّلة: كلمات العنوان بينها مسافات/ترقيم مرن (المقارنة على النص المُطبَّع)
function addrRegex(needle){
  const { s } = addrCanon(needle);
  const words = s.split(/[\s،,.!؟\-–—|]+/).filter(Boolean);
  if(words.join("").length < 6) return null;
  const body = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s،,.\\-–—]*");
  return new RegExp(body, "g");
}
// أنماط أرضية للعنوان داخل أي نص حر — لا تعتمد على خطوة العنوان ولا على أي قائمة
const ADDR_SPAN_RES = [
  /(?<![\u0600-\u06FF])(?:صيدلية|مسجد|مستشفى|مدرسه|مدرسة|مول|كافيه|مطعم|بنك|محطه|محطة|كوبري|كوبرى|برج|عمارة|كمبوند|كومباوند|فندق|سوبر\s*ماركت)(?:\s+[^\s،,.!؟|]+){1,2}/g,
  /(?<![\u0600-\u06FF])(?:بجوار|بجانب|جنب|أمام|امام|خلف|مقابل|ناصية)\s+(?:[^\s،,.!؟|]+\s+){0,2}[^\s،,.!؟|]+/g,
  /(?<![\u0600-\u06FF])(?:شارع|شوارع|ش\.)\s*(?:[^\s،,.!؟|]+\s+){0,3}[^\s،,.!؟|]+/g,
];
// كلمات تدل على أن العنوان انتهى وبدأ كلام/سؤال — تُقصّ من آخر المقطع فقط (ما تمنعش اكتشاف العنوان)
const AR_SPAN_STOP = new Set(["في","على","من","إلى","الى","عند","عندك","عندنا","قريب","قريبة","زي","نفس","بعد","قبل","كل","أي","اي","بتاع","بتاعة","وفيها","وفيه","وفي","وفى","والمساحة","والميزانية","والسعر","والمكان","وكمان","وكان","وكانت","وبعدين","ومش","ولسه","ولسا","وعايز","وعاوز","وعايزه","وعايزة","وعاوزة","وأريد","واريد","وأعرف","واعرف","عايز","عاوز","عايزه","عايزة","عاوزة","أريد","اريد","أعرف","اعرف","ممكن","تقولي","تقول","قولي","فين","إزاي","ازاي","كام","ليه","إيه","ايه","مش","بس","ده","دي","دا","دول","أنا","انا","هو","هي","احنا","إحنا","كمان","برضو","بردو","عشان","علشان","لو","أو","او","اللي","إللي","اللى","التي","الذي","امبارح","النهارده","النهاردة","بكره","بكرة"]);
function spanTailTrim(span){
  let v = String(span||"");
  for(;;){
    const m = v.match(/(\S+)\s*$/);          // آخر كلمة فعليّة (بتتخطّى المسافات في الآخر)
    if(!m) break;
    const key = m[1].replace(/[^\u0600-\u06FF0-9A-Za-z]/g,"");
    if(key && AR_SPAN_STOP.has(key)){ v = v.slice(0, m.index); continue; }
    break;
  }
  return v.replace(/\s+$/,"");
}
function maskAddressSpans(text){
  let t = String(text||"");
  for(const re of ADDR_SPAN_RES)
    t = t.replace(re, (sp) => {
      const v = spanTailTrim(sp);
      return (v.length>=6 ? "[عنوان]" : "") + sp.slice(v.length);
    });
  return t;
}
function addressSpans(text){
  const out = []; const t = String(text||"");
  for(const re of ADDR_SPAN_RES){
    re.lastIndex = 0; let m;
    while((m = re.exec(t))){ const v = spanTailTrim(m[0]); if(v.length>=6) out.push(v); if(m.index === re.lastIndex) re.lastIndex++; }
  }
  return [...new Set(out)];
}
function scrubAddresses(text,data){
  let t = String(text||"");
  const raw = Array.isArray(data?._rawLocations) ? data._rawLocations : [];
  const known = [...new Set([data?.location, data?.gps?.address, ...raw].map(x=>String(x||"").trim()).filter(x=>x.length>=6))].sort((a,b)=>b.length-a.length);
  for(const a of known){
    const re = addrRegex(a);
    if(!re) continue;
    const { s, map } = addrCanon(t);
    const parts = []; let last = 0, m;
    while((m = re.exec(s))){
      const st = map[m.index] ?? 0;
      const lastIdx = m.index + m[0].length - 1;
      const end = lastIdx < map.length ? map[lastIdx] + 1 : t.length;
      parts.push(t.slice(last, st), "[عنوان]"); last = end;
      if(m.index === re.lastIndex) re.lastIndex++;
    }
    if(parts.length){ parts.push(t.slice(last)); t = parts.join(""); }
  }
  return maskAddressSpans(t);
}
// ═══ F1 + الحاجز النهائي: لا يخرج أي payload فيه عنوان خام إلى Gemini ═══
function rememberAddressSpans(data, spans){
  if(!data || !Array.isArray(spans) || !spans.length) return;
  const list = Array.isArray(data._rawLocations) ? data._rawLocations : (data._rawLocations = []);
  for(const s of spans){ const v = String(s||"").trim(); if(v.length>=6 && !list.includes(v)) list.push(v); }
  if(list.length>5) list.splice(0, list.length-5);
}
// الحاجز بينقّي النصوص الديناميكية فقط (رسائل العميل + بيانات الحالة + أي نص متغيّر).
// القوالب الثابتة (الشخصية/المزاج) ما بتتغيّرش — ما ينفعش يبقى فيها عنوان أصلًا، وفحص المنع
// (payloadHasRawAddress) بيفحص الحمولة كلها بما فيها القوالب، فلو حصل حاجة غريبة الإرسال يتوقف.
const GUARD_TEMPLATES = [() => TAREK_PERSONA, () => MOOD_GUIDE];
// يقسّم النص لمقاطع {text, dynamic} — القالب الثابت يفضل كما هو وما بيتحسبش تسريب
function splitDynamic(text){
  const t = String(text||"");
  const spans = [];
  for(const get of GUARD_TEMPLATES){
    const c = get(); if(!c) continue;
    let i = 0;
    while((i = t.indexOf(c, i)) >= 0){ spans.push([i, i + c.length]); i += c.length; }
  }
  if(!spans.length) return [{ text: t, dynamic: true }];
  spans.sort((a,b)=>a[0]-b[0]);
  const out = []; let last = 0;
  for(const [a,b] of spans){
    if(a < last) continue;
    if(a > last) out.push({ text: t.slice(last, a), dynamic: true });
    out.push({ text: t.slice(a, b), dynamic: false });     // القالب الثابت
    last = b;
  }
  if(last < t.length) out.push({ text: t.slice(last), dynamic: true });
  return out;
}
function scrubDynamicText(text, data){
  return splitDynamic(text).map(p => p.dynamic ? scrubAddresses(p.text, data) : p.text).join("");
}
function guardGeminiPayload(body, data){
  const clean = JSON.parse(JSON.stringify(body));
  const fix = t => {
    if(typeof t !== "string") return t;
    const spans = addressSpans(t);
    if(spans.length) rememberAddressSpans(data, spans);   // يُسجَّل فورًا: أي نص عنواني يُلتقط بعد كده بالمطابقة المتحمّلة
    return scrubDynamicText(t, data);
  };
  if(clean?.system_instruction?.parts) for(const p of clean.system_instruction.parts) p.text = fix(p.text);
  for(const c of clean?.contents||[]) for(const p of c.parts||[]) p.text = fix(p.text);
  return clean;
}
// الفحص النهائي: أي عنوان خام كتبه العميل لسه موجود في الأجزاء الديناميكية من الحمولة؟ ⇒ امنع الإرسال
function payloadPartsText(body){
  const out = [];
  if(body?.system_instruction?.parts) for(const p of body.system_instruction.parts) out.push(String(p?.text ?? ""));
  for(const c of body?.contents||[]) for(const p of c.parts||[]) out.push(String(p?.text ?? ""));
  return out;
}
function payloadHasRawAddress(body, data){
  const raw = (Array.isArray(data?._rawLocations) ? data._rawLocations : [])
    .map(x => addrCanon(String(x||"").trim()).s).filter(x => x.length >= 6);
  if(!raw.length) return false;
  const dynamic = payloadPartsText(body).flatMap(t => splitDynamic(t).filter(p => p.dynamic).map(p => p.text)).map(addrCanon).join("\n");
  return raw.some(r => dynamic.includes(r));
}
async function callGemini(env, sys, msgs, maxTok=150, temp=0.6, data){
  if(!env?.GEMINI_API_KEY) return null;
  try {
    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;
    const body = { system_instruction:{parts:[{text:sys}]}, contents:msgs, generationConfig:{temperature:temp,maxOutputTokens:maxTok} };
    // ⭐ الحاجز النهائي قبل أي fetch لـGoogle: تنقية كل النصوص، ومنع الإرسال لو بقي عنوان خام معروف
    const guarded = guardGeminiPayload(body, data);
    if(payloadHasRawAddress(guarded, data)){ console.warn("[gemini] payload blocked: raw address"); return null; }
    const r = await fetchWithTimeout(url,{
      method:"POST",
      headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
      body:JSON.stringify(guarded)
    }, FETCH_TIMEOUT_GEMINI);
    if(!r.ok){ console.warn("[gemini] non-ok status:",r.status); return null; }
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    return t ? String(t).trim() : null;
  } catch(err){
    console.warn("[gemini] failed:",err?.name==="AbortError"?"timeout":err?.message);
    return null;
  }
}

// ═══ TIME ═══
function cairoNow(d = new Date()){
  const parts = new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Cairo",hour:"numeric",hour12:false,weekday:"short"}).formatToParts(d);
  const get = t => parts.find(p=>p.type===t)?.value||"";
  const hour = Number(get("hour"))%24;
  const wd = get("weekday");
  return {hour, isFriday: wd==="Fri"};
}
function timeContext(now = cairoNow()){
  const {hour,isFriday} = now;
  const bits = [];
  if(isFriday) bits.push("النهاردة الجمعة والمكتب إجازة");
  if(hour>=22||hour<5) bits.push("الوقت دلوقتي متأخر بالليل");
  else if(hour>=21) bits.push("الوقت بعد التسعة بالليل والمكتب قفل");
  else if(hour<9) bits.push("الوقت بدري الصبح والمكتب لسه مافتحش");
  else if(hour<12) bits.push("المكتب بيفتح 12 الضهر، لسه مافتحش");
  if(!bits.length) return "";
  return `الوقت دلوقتي: ${bits.join("، ")}.\nاذكر ده بشكل عابر وطبيعي لو كان له لازمة، من غير ما تعتذر كتير ومن غير ما تكرره في كل رد.`;
}
async function geminiFirstMsg(env, userMsg, history, data){
  const sys = `${TAREK_PERSONA}\n\nالموقف: حد لسه داخل على الشات دلوقتي وكتبلك حاجة.\nانت عايز تعرف هو عايز يشتري ولا يأجر ولا عنده عقار عايز يبيعه أو يأجره.\nتحت الشات في أزرار جاهزة، وجّهه ليها بكلامك من غير ما تسرد الاختيارات كأنها قايمة.\n\n${MOOD_GUIDE}\n${timeContext()}\n\nرد بسطر أو اتنين بالكتير. متسألش عن تفاصيل العقار دلوقتي ومتتكلمش في أسعار.`;
  return callGemini(env, sys, [{role:"user",parts:[{text:sanitizeForPrompt(scrubAddresses(userMsg, data))}]}], 150, 0.85, data);
}
async function geminiComment(env, userMsg, nextQ, fsData){
  const safeMsg = sanitizeForPrompt(scrubAddresses(userMsg, fsData));
  const qKey = normAr(String(nextQ||"")).slice(0,40);
  const cacheKey = `c:${qKey}:${normAr(userMsg).slice(0,60)}`;
  const cached = geminiCache.get(cacheKey);
  if(cached && (Date.now()-cached.at)<GEMINI_CACHE_TTL && cached.variants?.length){
    return cached.variants[Math.floor(Math.random()*cached.variants.length)];
  }
  const sys = `${TAREK_PERSONA}\n\nالموقف: العميل لسه جاوبك على سؤال، وانت هتسأله السؤال اللي بعده على طول.\nعايز منك رد فعل قصير جدا على إجابته.\n\n${MOOD_GUIDE}\n${timeContext()}\n\nمهم جدا: مش كل إجابة محتاجة رد.\nلو إجابته عادية خالص (رقم، اختيار من زرار، كلمة واحدة) — مترّدش خالص واكتب: -\nالرد الفاضي ده طبيعي.\nعلّق بس لما يكون في حاجة فعلا تستاهل.\nلو هتعلّق: كلمتين أو تلاتة بالكتير. متعيدش السؤال اللي جاي.\n\nإجابة العميل: "${safeMsg}"\nالسؤال اللي جاي: "${sanitizeForPrompt(nextQ,200)}"\nاللي عارفه عنه: ${safeDataForPrompt(fsData)}`;
  const reply = await callGemini(env, sys, [{role:"user",parts:[{text:safeMsg}]}], 60, 0.95, fsData);
  const cleaned = String(reply||"").trim();
  if(!cleaned||cleaned==="-"||/^[-–—.]+$/.test(cleaned)) return null;
  const variants = cached?.variants ? [...new Set([...cached.variants, cleaned])].slice(-4) : [cleaned];
  cacheSet(geminiCache, cacheKey, {variants, at:cached?.at||Date.now()});
  return cleaned;
}
async function geminiContextual(env, userMsg, formState, currentStep, history){
  const q = currentStep?(typeof currentStep.q==="function"?currentStep.q(formState?.data):currentStep.q):"";
  const convHistory = (Array.isArray(history)?history:[]).slice(-8)
    .filter(m=>m?.message?.trim())
    .map(m=>({role:m.role==="assistant"?"model":"user", parts:[{text:sanitizeForPrompt(scrubAddresses(m.message, formState?.data),500)}]}));
  if(convHistory[convHistory.length-1]?.role==="user") convHistory.pop();
  convHistory.push({role:"user",parts:[{text:sanitizeForPrompt(scrubAddresses(userMsg, formState?.data))}]});
  const sys = `${TAREK_PERSONA}\n\nالموقف: انت كنت سألته سؤال، وهو بدل ما يجاوب سألك انت سؤال تاني.\nجاوب على سؤاله بسرعة وبعدين رجّعه للسؤال بتاعك.\n\n${MOOD_GUIDE}\n${timeContext()}\n\nالسؤال اللي انت مستنيه منه: "${sanitizeForPrompt(q,200)}"\nاللي عارفه عنه: ${safeDataForPrompt(formState?.data)}\n\nجاوب سؤاله في سطر واحد بس، وبعدين اسأله سؤالك تاني.\nالسؤال ترجّعه بمعناه وبكلامك انت، مش نسخ لصق حرفي.`;
  return callGemini(env, sys, convHistory, 150, 0.75, formState?.data);
}
function deservesComment(userMsg){
  const t = String(userMsg||"").trim();
  if(!t) return false;
  if(/^\d+$/.test(toEnNum(t))) return false;
  if(t.length<=3) return false;
  const hasMood = /[!؟?]{1,}|هه|😀|😂|🙏|😊|حلو|تمام\s*\?|مستعجل|بسرعة|دلوقتي|مش فاهم|غالي|كتير|معقول/.test(t);
  const isLong = t.split(/\s+/).length>=4;
  return hasMood||isLong;
}
const ADDRESS_STEP_IDS = new Set(["location","landmark"]);
async function enhanceResponse(env, result, userMsg, formState, currentStep, history){
  const nextQuestion = result.response;
  if(formState?._justReturnedFromValuation && formState?.data?.valuation && !formState.data._valuationShown){
    const announcement = buildValuationAnnouncement(formState.data.valuation);
    if(announcement){
      result = {
        ...result,
        response: announcement + (result.response ? "\n\n"+result.response : ""),
        formState: {
          ...result.formState,
          data: {...result.formState.data, _valuationShown:true},
          _justReturnedFromValuation: false,
        }
      };
    }
  }
  if(!formState?.active||result.done||result.readyToSend) return result;
  if(ADDRESS_STEP_IDS.has(currentStep?.id)) return result;
  if(!deservesComment(userMsg)) return result;
  const comment = await geminiComment(env, userMsg, nextQuestion, formState?.data);
  if(comment) return {...result, response:`${comment}\n\n${result.response}`};
  return result;
}

// ═══ FLOW: ASK STEP ═══
function askOwnerStep(steps, idx, fs, extra, lms){
  const data = hydrateData(fs.data||{}, steps);
  if(idx<0||idx>=steps.length) return completeOwner({...fs,data}, data);
  const step = steps[idx];
  if((step.id==="ownerName"||step.id==="ownerPhone") && missingCore(data,true).length){
    const missing = missingCore(data,true)[0];
    const mi = steps.findIndex(s=>s.id===missing);
    if(mi>=0) return askOwnerStep(steps, mi, {...fs,data}, "خلينا نكمّل البيانات الأساسية الأول.", lms);
  }
  if(!isApplicable(step,data)){
    const ni = nextStep(steps,data,idx+1);
    if(ni===-1) return completeOwner({...fs,data},data);
    return askOwnerStep(steps,ni,{...fs,data},null,lms);
  }
  if(step.type==="images_step") return askImgStep(steps,idx,{...fs,data});
  const progress = buildProgress(steps,data,idx);
  let q = typeof step.q==="function"?step.q(data):step.q;
  if(progress.remaining>1) q += `\n\n(${progress.current}/${progress.total})`;
  let opts;
  const allowSkip = !CORE_OWNER.has(step.id);
  if(step.type==="buttons") opts = withCtrl(step.opts, data, true, allowSkip);
  else opts = withCtrl([], data, true, allowSkip);
  const ui = step.id==="location" ? { ui:"map_picker", uiRequired: fs.type==="sale" } : {};
  const result = {
    response: extra?`${extra}\n\n${q}`:q,
    formState:{...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[], ...ui
  };
  if(step.id==="valuationGift"){
    result.valuationCta = {
      intent:"seller",
      area: hasVal(data.location)?String(data.location).slice(0,80):"",
      size: hasVal(data.area)?parseNum(data.area):null,
      propertyType: hasVal(data.propertyType)?data.propertyType:"",
      areaType: fs.type==="rent"?"rent":"sale",
      rentCondition: data.furnished==="مفروش"?"furnished":data.furnished==="فاضي (قانون جديد)"?"unfurnished":null,
      price: hasVal(data.price)?parseNum(data.price):null,
      floor: hasVal(data.floor)?String(data.floor).slice(0,40):"",
      finishing: hasVal(data.finishing)?String(data.finishing).slice(0,40):"",
    };
    result.options = [BTN.SKIP, BTN.BACK, BTN.CANCEL];
  }
  return result;
}
function askBuyerStep(steps, idx, fs, extra, lms){
  const data = hydrateData(fs.data||{}, steps);
  if(idx<0||idx>=steps.length) return completeBuyer({...fs,data},data);
  const step = steps[idx];
  if((step.id==="buyerName"||step.id==="buyerPhone") && missingCore(data,false).length){
    const missing = missingCore(data,false)[0];
    const mi = steps.findIndex(s=>s.id===missing);
    if(mi>=0) return askBuyerStep(steps, mi, {...fs,data}, "خلينا نكمّل البيانات الأساسية الأول.", lms);
  }
  if(!isApplicable(step,data)){
    const ni = nextStep(steps,data,idx+1);
    if(ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,data},null,lms);
  }
  const progress = buildProgress(steps,data,idx);
  let q = typeof step.q==="function"?step.q(data):step.q;
  if(progress.remaining>1) q += `\n\n(${progress.current}/${progress.total})`;
  let opts;
  const allowSkip = !CORE_BUYER.has(step.id);
  if(step.type==="buttons") opts = withCtrl(step.opts, data, idx>0, allowSkip);
  else if(step.id==="area") opts = withCtrl(step.opts||["80","100","120","150","180","200"], data, idx>0, allowSkip);
  else if(step.type==="dynamic_buttons"&&step.id==="landmark"){
    const pool = lms?.length?lms:MASTER_LANDMARKS;
    if(pool.length>MAX_VISIBLE_LM){
      const visible = pool.slice(0,MAX_VISIBLE_LM);
      opts = withCtrl([...visible,`${BTN.MORE} (${pool.length-MAX_VISIBLE_LM})`,BTN.ANY_AREA], data, idx>0, allowSkip);
    } else {
      opts = withCtrl([...pool,BTN.ANY_AREA], data, idx>0, allowSkip);
    }
  } else opts = withCtrl([], data, idx>0, allowSkip);
  const ui = step.id==="landmark" ? { ui:"map_picker", uiRequired:false } : {};
  return {
    response: extra?`${extra}\n\n${q}`:q,
    formState:{...fs, data, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:false,
    progress, imageUrls:fs.imageUrls||[], ...ui
  };
}
function askImgStep(steps, idx, fs){
  const imageUrls = fs.imageUrls||[];
  const opts = imageUrls.length>0
    ? [BTN.IMG_DONE, BTN.ADD_IMG, BTN.DEL_IMG, BTN.BACK, BTN.CANCEL]
    : [BTN.ATTACH_IMG, BTN.SKIP_IMG, BTN.BACK, BTN.CANCEL];
  return {
    response: `لو عندك صور للعقار، تقدر ترفقها دلوقتي (لحد ${MAX_IMAGES} صور).`,
    formState:{...fs, stepIndex:idx, awaitingQ:true},
    options: opts, done:false, readyToSend:false, canShareWhatsapp:true,
    imageUrls
  };
}

// ═══ COMPLETE OWNER ═══
function completeOwnerCheck(fs, data){
  const steps = getOwnerSteps(fs.type);
  const missing = REQUIRED_OWNER.filter(id=>{
    const s = steps.find(x=>x.id===id);
    return s && isApplicable(s,data) && !isFilled(data,s);
  });
  if(missing.length){
    const idx = steps.findIndex(s=>s.id===missing[0]);
    if(idx>=0) return askOwnerStep(steps, idx, fs, null, null);
  }
  return completeOwner(fs, data);
}
function completeOwner(fs, data){
  const steps = getOwnerSteps(fs.type);
  const imgs = fs.imageUrls||[];
  const ctx = fs.type==="sale"?"owner_sale":"owner_rent";
  const waMsg = buildWAMsg(ctx, data, imgs);
  const total = countSteps(steps, data);
  const hasImgs = imgs.length>0;
  const imgNote = hasImgs ? `استلمت ${imgs.length} صورة ✅` : (data.imagesSkipped ? "تم تخطي الصور" : "مفيش صور");
  return {
    response: `تمام، سجّلت العقار كامل ✅\n\n${imgNote}\n\nقبل ما نبعت لطارق، عايز تراجع الرسالة؟`,
    formState:{...fs, stepIndex:-1, data, lifecycle:LC.DONE,
      flowType: fs.type==="sale"?"owner_completed_sale":"owner_completed_rent",
      awaitingQ:false, imageUrls:imgs},
    options: POST_COMPLETE, done:true, readyToSend:true, canShareWhatsapp:true,
    progress: {current:total,total,remaining:0,pct:100},
    leadData: { type:getRequestLabel(ctx, data.propertyType, data.furnished, true), ...data },
    waMessage: waMsg, imageUrls:imgs, whatsappUrl: waURL(TAREK_PHONE, waMsg)
  };
}

// ═══ COMPLETE BUYER ═══
async function completeBuyer(fs, data){
  const imgs = fs.imageUrls||[];
  let allProps = [];
  try { const feed = await fetchFeed(); allProps = feed.properties||[]; } catch {}
  const criteria = {
    transaction: fs.type,
    landmark: data.landmark&&data.landmark!=="__ANY__"?data.landmark:null,
    propertyType: data.propertyType||null,
    budget: parseNum(data.budget),
    rooms: parseNum(data.rooms),
    baths: parseNum(data.baths),
    furnished: data.furnished||null,
  };
  const matches = filterAndRank(allProps, criteria);
  const isRent = fs.type==="rent";
  const requestLabel = getRequestLabel(fs.type, data.propertyType, data.furnished);
  const waMsg = buildWAMsg(isRent?"tenant":"buyer", data, imgs);
  if(!matches.length){
    return {
      response: `حالياً مش لاقي ${data.propertyType||"عقار"} مناسب مبدئيًا بنفس الميزانية في المنطقة دي على السيستم.\n\nبس ولا تشيل هم! أنا جهّزت كامل مواصفاتك لطارق طنطاوي عشان يدوّرلك في المعروض الخاص ويتواصل معاك أول ما ينزل طلب مناسب 🌟.\n\nابعت الرسالة لطارق دلوقتي على واتساب:`,
      formState:{...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
      options: POST_COMPLETE,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
      leadData: { type: requestLabel, ...data, matchedProperties: 0 },
      imageUrls: imgs
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
      [pt,tx,p.location,priceN>0?`مبدئيًا ${fmtNum(priceN)} ج.م`:""].filter(Boolean).join(" • "));
    if(priceN>0) lines.push(`💰 السعر المبدئي: ${fmtNum(priceN)} ج.م`);
    if(p.area) lines.push(`📐 المساحة: ${fmtVal(p.area)} متر مربع`);
    const rN = parseNum(p.roomsNumeric||p.rooms);
    if(rN>0) lines.push(`🛏️ الغرف: ${rN}`);
    const bN = parseNum(p.bathsNumeric||p.baths);
    if(bN>0) lines.push(`🛁 الحمامات: ${bN}`);
    if(p.floor) lines.push(`🏢 الدور: ${p.floor}`);
    const fin = p.finishing||p.finish;
    if(fin) lines.push(`✨ التشطيب: ${fin}`);
    if(p.image) lines.push(`📷 صورة العقار: ${p.image}`);
    if(p.url) lines.push(`🔗 التفاصيل: ${p.url}`);
  });
  lines.push("","اختار رقم العقار للمعاينة، أو لو مش مناسبين ابعت مواصفاتك لطارق:");
  const selectOpts = [...matches.map((_,i)=>String(i+1)), BTN.CUSTOM_SPEC, BTN.BACK];
  return {
    response: lines.join("\n"),
    formState:{...fs, active:true, flowType:"buyer_select", stepIndex:-1, data, suggestedProperties:matches, imageUrls:imgs, waMessage:waMsg},
    options: selectOpts,
    done:false, readyToSend:false, canShareWhatsapp:false,
    waMessage: waMsg,
    leadData: { type: requestLabel, ...data, matchedProperties:matches.length },
    imageUrls: imgs
  };
}

// ═══ FLOW PROCESSORS ═══
async function processOwner(fs, msg, env, history, lms){
  const steps = getOwnerSteps(fs.type);
  const step = steps[fs.stepIndex];
  if(!step) return completeOwnerCheck(fs, fs.data||{});
  if(isNewReq(msg)) return newRequest();
  if(isBack(msg)){
    const bs = goBack(fs);
    return askOwnerStep(getOwnerSteps(bs.type), bs.stepIndex, bs, "تمام، رجعنا خطوة.", lms);
  }
  if(isCancel(msg)) return cancelFlow(fs);
  if(isSendNow(msg)) return completeOwnerCheck(fs, fs.data||{});
  let data = {...(fs.data||{})};
  if(ADDRESS_STEP_IDS.has(step.id)) data = rememberRawLocation(data, msg);
  if(isSkip(msg)){
    if(CORE_OWNER.has(step.id)) return askOwnerStep(steps, fs.stepIndex, fs, "دي معلومة أساسية عشان أرتبلك الطلب.", lms);
    data[step.id]="—"; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeOwnerCheck({...fs,data},data);
    return askOwnerStep(steps, ni, {...fs,stepIndex:ni,data}, null, lms);
  }
  if(step.type==="images_step") return processImgStep(fs, msg, env, step, lms);
  if(step.id==="valuationGift"){
    data._valuationGiftShown = true;
    data[step.id] = "—";
    markFilled(data, step);
    const ni = nextStep(steps, data, fs.stepIndex+1);
    if(ni===-1) return completeOwnerCheck({...fs, data}, data);
    return askOwnerStep(steps, ni, {...fs, stepIndex:ni, data}, null, lms);
  }
  const extracted = extractRequestFacts(msg);
  if(!hasVal(data.propertyType)&&hasVal(extracted.propertyType)) data.propertyType = extracted.propertyType;
  if(!hasVal(data.location)&&hasVal(extracted.landmark)) data.location = extracted.landmark;
  if(!hasVal(data.area)&&hasVal(extracted.area)) data.area = extracted.area;
  // ⭐ السعر من رسالة مجردة/ملتبسة لا يُعبّأ من الـfacts، ولو السؤال الحالي هو السعر فالـparser بتاعه هو المرجع
  if(!hasVal(data.price)&&hasVal(extracted.budget)&&!MONEY_STEP_IDS.has(step.id)&&isClearPriceStatement(msg, step.id)) data.price = extracted.budget;
  for(const key of ["rooms","baths","furnished"]){
    if(!hasVal(data[key])&&hasVal(extracted[key])) data[key] = extracted[key];
  }
  if(hasVal(data[step.id])){
    markFilled(data,step);
    const ni = nextStep(steps, data, fs.stepIndex+1);
    if(ni===-1) return completeOwnerCheck({...fs,data},data);
    return askOwnerStep(steps, ni, {...fs,stepIndex:ni,data}, null, lms);
  }
  if(step.type==="buttons"){
    const m = matchOpt(msg, step.opts);
    if(m){
      data[step.id]=m; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if(ni===-1) return completeOwnerCheck({...fs,data},data);
      return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
    return askOwnerStep(steps,fs.stepIndex,fs,"معلش، اختار من الأزرار اللي تحت.",lms);
  }
  const txt = String(msg||"").trim();
  if(NAME_STEP_IDS.has(step.id)){
    const nm = cleanPersonName(txt);
    if(!nm) return askOwnerStep(steps,fs.stepIndex,fs,NAME_ERR,lms);
    data[step.id]=nm;
  } else if(step.type==="number"){
    if(MONEY_STEP_IDS.has(step.id)){
      const money = parseMoneyAnswer(txt);
      if(money.reason && money.reason !== "none") return askOwnerStep(steps,fs.stepIndex,fs,moneyClarifyQ(step.id,money.reason),lms);
      const plain = money.ok ? null : plainMoneyValue(txt, fs.type);
      if(!money.ok && plain===null) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      data[step.id]= money.ok ? money.value : plain;
    } else {
      if(isPhoneLikeText(txt)) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      const n = parseNum(txt);
      if(!n||n<=0) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      if(step.id==="area"&&n>100000) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      data[step.id]=n;
    }
  } else if(step.type==="phone"){
    const ph = normPhone(txt);
    if(!/^01[0-9]{9}$/.test(ph)) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم موبايل 11 رقم يبدأ بـ01.",lms);
    data[step.id]=ph;
  } else {
    if(!txt) return askOwnerStep(steps,fs.stepIndex,fs,step.err||"اكتب إجابة.",lms);
    data[step.id]=txt;
  }
  markFilled(data,step);
  const ni = nextStep(steps,data,fs.stepIndex+1);
  if(ni===-1) return completeOwnerCheck({...fs,data},data);
  return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
}

async function processBuyer(fs, msg, env, history, lms){
  const steps = getBuyerSteps(fs.type);
  const step = steps[fs.stepIndex];
  if(!step) return completeBuyer(fs, fs.data||{});
  if(isNewReq(msg)) return newRequest();
  if(isBack(msg)){
    const bs = goBack(fs);
    return askBuyerStep(getBuyerSteps(bs.type), bs.stepIndex, bs, "تمام، رجعنا خطوة.", lms);
  }
  if(isCancel(msg)) return cancelFlow(fs);
  let data = {...(fs.data||{})};
  if(ADDRESS_STEP_IDS.has(step.id)) data = rememberRawLocation(data, msg);
  if(isSkip(msg)&&CORE_BUYER.has(step.id)){
    return askBuyerStep(steps, fs.stepIndex, fs, "دي معلومة أساسية عشان أرتبلك الطلب.", lms);
  }
  const extracted = extractBuyerFields(msg);
  for(const [k,v] of Object.entries(extracted)){
    if(!hasVal(v)||hasVal(data[k])) continue;
    // ⭐ الميزانية من رسالة مجردة/ملتبسة لا تُعبّأ من الـfacts، ولو السؤال الحالي هو الميزانية فالـparser بتاعه هو المرجع
    if(k==="budget" && (MONEY_STEP_IDS.has(step.id) || !isClearPriceStatement(msg, step.id))) continue;
    data[k]=v; if(!data._filled) data._filled={}; data._filled[k]=true;
  }
  if(step.type==="dynamic_buttons"&&step.id==="landmark"){
    if(isMore(msg)){
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const rest = pool.slice(MAX_VISIBLE_LM);
      if(!rest.length) return askBuyerStep(steps,fs.stepIndex,fs,"مفيش مناطق تانية.",lms);
      return {
        response:`دي باقي المناطق (${rest.length}):`,
        formState:{...fs,data,awaitingQ:true},
        options:[...rest,BTN.FIRST_LIST,BTN.ANY_AREA,BTN.BACK,BTN.NEW_REQ],
        done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:fs.imageUrls||[]
      };
    }
    if(isBackFirst(msg)){
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const visible = pool.slice(0,MAX_VISIBLE_LM);
      return {
        response:"تمام، دي المناطق الأكثر شيوعاً:",
        formState:{...fs,data,awaitingQ:true},
        options:withCtrl([...visible,`${BTN.MORE} (${pool.length-MAX_VISIBLE_LM})`,BTN.ANY_AREA],data,fs.stepIndex>0),
        done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:fs.imageUrls||[]
      };
    }
    if(isAnyArea(msg)) data.landmark="__ANY__";
    else {
      const pool = lms?.length?lms:MASTER_LANDMARKS;
      const lm = matchLandmark(msg, pool) || msg.trim();
      data.landmark = lm;
    }
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }
  if(hasVal(data[step.id])){
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }
  if(step.type==="buttons"){
    const m = matchOpt(msg, step.opts);
    if(m){
      data[step.id]=m; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if(ni===-1) return completeBuyer({...fs,data},data);
      return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
  }
  const txtN = String(msg||"").trim();
  if(NAME_STEP_IDS.has(step.id)){
    const nm = cleanPersonName(txtN);
    if(!nm) return askBuyerStep(steps,fs.stepIndex,fs,NAME_ERR,lms);
    data[step.id]=nm; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  }
  const txt = String(msg||"").trim();
  if(step.type==="number"){
    if(MONEY_STEP_IDS.has(step.id)){
      const money = parseMoneyAnswer(txt);
      if(money.reason && money.reason !== "none") return askBuyerStep(steps,fs.stepIndex,fs,moneyClarifyQ(step.id,money.reason),lms);
      const plain = money.ok ? null : plainMoneyValue(txt, fs.type);
      if(!money.ok && plain===null) return askBuyerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      data[step.id]= money.ok ? money.value : plain; markFilled(data,step);
      const niM = nextStep(steps,data,fs.stepIndex+1);
      if(niM===-1) return completeBuyer({...fs,data},data);
      return askBuyerStep(steps,niM,{...fs,stepIndex:niM,data},null,lms);
    }
    if(isPhoneLikeText(txt)) return askBuyerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
    const n = parseNum(txt);
    if(n>0){
      if(step.id==="area"&&n>100000) return askBuyerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم صحيح.",lms);
      data[step.id]=n; markFilled(data,step);
      const ni = nextStep(steps,data,fs.stepIndex+1);
      if(ni===-1) return completeBuyer({...fs,data},data);
      return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
    }
  } else if(step.type==="phone"){
    const ph = normPhone(txt);
    if(!/^01[0-9]{9}$/.test(ph)) return askBuyerStep(steps,fs.stepIndex,fs,step.err||"اكتب رقم موبايل 11 رقم يبدأ بـ01.",lms);
    data[step.id]=ph; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeBuyer({...fs,data},data);
    return askBuyerStep(steps,ni,{...fs,stepIndex:ni,data},null,lms);
  } else if(txt && txt.length >= 2){
    // ⭐ نص حر لم يُطابق step — نحفظه في notes بدل رفضه
    const existingNotes = data.notes ? String(data.notes) : "";
    const combined = existingNotes ? `${existingNotes} • ${txt}` : txt;
    data.notes = combined.slice(0, 200);
    if(!data._filled) data._filled={};
    data._filled.notes = true;
    const ni = nextStep(steps, data, fs.stepIndex + 1);
    if(ni === -1) return completeBuyer({ ...fs, data }, data);
    return askBuyerStep(steps, ni, { ...fs, stepIndex: ni, data }, null, lms);
  }
  return askBuyerStep(steps,fs.stepIndex,fs,"معلش، ممكن توضح تاني؟",lms);
}

function extractBuyerFields(msg){
  const t = String(msg||"").trim();
  const out = {};
  if(/دوبلكس/i.test(t)) out.propertyType="دوبلكس";
  else if(/شقة|شقه|شقت/.test(t)) out.propertyType="شقة";
  else if(/فيلا/.test(t)) out.propertyType="فيلا";
  else if(/روف/.test(t)) out.propertyType="روف";
  else if(/محل/.test(t)) out.propertyType="محل تجاري";
  else if(/مكتب/.test(t)) out.propertyType="مكتب إداري";
  else if(/مخزن/.test(t)) out.propertyType="مخزن";
  const lm = matchLandmark(t, MASTER_LANDMARKS);
  if(lm) out.landmark = lm;
  const budget = extractPrice(t);
  if(budget>0) out.budget = budget;
  const size = toEnNum(t).match(/(?:مساح(?:ة|ه)\s*)?(\d{1,6})\s*(?:متر|م٢|m2|sqm|م(?=\s*(?:\d|²|٢|$)))/i);
  if(size) out.area = Number(size[1]);
  const rm = t.match(/(\d+)\s*(غرف|غرفة|أوض|اوض)/);
  if(rm) out.rooms = rm[1];
  const bm = t.match(/(\d+)\s*(حمام|حمامات)/);
  if(bm) out.baths = bm[1];
  const phoneMatch = t.match(/01[0-9]{9}/);
  if(phoneMatch) out.buyerPhone = phoneMatch[0];
  // ⭐ ترتيب مهم: "مش مفروشة/فاضي" قبل "مفروش"
  if(/مش\s*مفروش|مش\s*مفروشة|فاضي|قانون جديد|بدون\s*فرش/.test(t)) out.furnished="فاضي (قانون جديد)";
  else if(/مفروش/.test(t)) out.furnished="مفروش";
  return out;
}

async function processImgStep(fs, msg, env, step, lms){
  const steps = getOwnerSteps(fs.type);
  const data = {...(fs.data||{})};
  const imgs = fs.imageUrls||[];
  if(isSkipImg(msg)){
    data.imagesSkipped = true; markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeOwnerCheck({...fs,data,imageUrls:imgs},data);
    return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data,imageUrls:imgs},null,lms);
  }
  if(isAttachImg(msg)){
    return {
      response:`تمام 👌\nدوس على 📷 جنب شريط الكتابة واختار الصور.\n\nبعد ما تخلص، اضغط "✅ تمام، كمّل".`,
      formState:{...fs,data,imageUrls:imgs},
      options:imgs.length?[BTN.IMG_DONE,BTN.ADD_IMG,BTN.DEL_IMG,BTN.BACK,BTN.CANCEL]:[BTN.IMG_DONE,BTN.BACK,BTN.CANCEL],
      done:false,readyToSend:false,canShareWhatsapp:true,imageUrls:imgs,imageStepAction:"open_picker"
    };
  }
  if(isDelImg(msg)){
    return {
      response:"تمام، مسحنا كل الصور.",
      formState:{...fs,data,imageUrls:[]},
      options:[BTN.ATTACH_IMG,BTN.SKIP_IMG,BTN.BACK,BTN.CANCEL],
      done:false,readyToSend:false,canShareWhatsapp:true,imageUrls:[]
    };
  }
  if(isImgDone(msg)){
    if(!imgs.length) data.imagesSkipped = true;
    markFilled(data,step);
    const ni = nextStep(steps,data,fs.stepIndex+1);
    if(ni===-1) return completeOwnerCheck({...fs,data,imageUrls:imgs},data);
    return askOwnerStep(steps,ni,{...fs,stepIndex:ni,data,imageUrls:imgs},null,lms);
  }
  return askOwnerStep(steps,fs.stepIndex,{...fs,data,imageUrls:imgs},"اختار من الأزرار تحت.",lms);
}

async function processBuyerSelect(fs, msg, env){
  const props = fs.suggestedProperties||[];
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const isRent = fs.type==="rent";
  const waMsg = fs.waMessage || buildWAMsg(isRent?"tenant":"buyer", data, imgs);
  const requestLabel = getRequestLabel(fs.type, data.propertyType, data.furnished);
  if(isNewReq(msg)) return newRequest();
  if(isCustomSpec(msg)){
    return {
      response: `تمام 🌟\nجهّزتلك رسالتك المؤهلة بكل تفاصيل طلبك لطارق طنطاوي.\n\nتقدر تبعتها على واتساب دلوقتي:`,
      formState:{...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
      options: POST_COMPLETE,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
      imageUrls: imgs,
      leadData: {type:requestLabel, ...data}
    };
  }
  if(isBack(msg)){
    const bs = goBack(fs);
    const backSteps = getBuyerSteps(bs.type);
    return askBuyerStep(backSteps, bs.stepIndex, bs, "تمام، رجعنا خطوة.", null);
  }
  const nm = toEnNum(String(msg||"")).match(/\d+/);
  const choice = nm ? parseInt(nm[0],10) : NaN;
  if(!isNaN(choice)&&choice>=1&&choice<=props.length){
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
    const lines = [`تمام 👌 اخترت:`,``,`🎯 *${sel.title}*`,`📍 ${sel.location}`];
    if(selPrice&&selPrice!=="0") lines.push(`💰 ${selPrice} ج.م`);
    if(sel.area) lines.push(`📐 المساحة: ${fmtVal(sel.area)} متر مربع`);
    const rN = parseNum(sel.roomsNumeric||sel.rooms);
    if(rN>0) lines.push(`🛏️ الغرف: ${rN}`);
    const bN = parseNum(sel.bathsNumeric||sel.baths);
    if(bN>0) lines.push(`🛁 الحمامات: ${bN}`);
    if(sel.floor) lines.push(`🏢 الدور: ${sel.floor}`);
    const fin = sel.finishing||sel.finish;
    if(fin) lines.push(`✨ التشطيب: ${fin}`);
    if(sel.image) lines.push(`📷 صورة العقار: ${sel.image}`);
    if(sel.url) lines.push(`🔗 التفاصيل: ${sel.url}`);
    lines.push(``,`تحب نحدد ميعاد معاينة ونتواصل مع أ. طارق؟`);
    return {
      response: lines.join("\n"),
      formState:{...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_selected_property", selectedProperty:sel, data:selData, imageUrls:imgs, waMessage:propWaMsg},
      options: POST_SELECTED,
      done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: propWaMsg,
      whatsappUrl: waURL(TAREK_PHONE, propWaMsg),
      imageUrls: imgs,
      leadData: {type:requestLabel,...selData}
    };
  }
  return {
    response: `تمام، جهّزتلك رسالتك المؤهلة بالمواصفات اللي طلبتها لطارق طنطاوي 🌟.\n\nتقدر تبعتها دلوقتي على واتساب:`,
    formState:{...fs, active:true, lifecycle:LC.DONE, flowType:"buyer_completed", stepIndex:-1, data, imageUrls:imgs, waMessage:waMsg},
    options: POST_COMPLETE,
    done:true, readyToSend:true, canShareWhatsapp:true,
    waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE, waMsg),
    imageUrls: imgs
  };
}

async function processBuyerSelectedProp(fs, msg, env){
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const ctx = fs.type==="rent"?"tenant":"buyer";
  const waMsg = fs.waMessage || buildWAMsg(ctx,data,imgs);
  if(isNewReq(msg)) return newRequest();
  if(isBookView(msg)||isSendWA(msg)||isAccept(msg)){
    return {
      response: `تمام! اضغط على الزر ده عشان تفتح واتساب وتبعت الرسالة لطارق مباشرة 👇`,
      formState:{...fs, waMessage:waMsg},
      options: POST_VIEWING, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  if(isPreview(msg)){
    return {
      response: `دي الرسالة المؤهلة اللي هتتبعت لطارق على واتساب:\n\n${waMsg}`,
      formState:{...fs, waMessage:waMsg},
      options: POST_SELECTED, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  if(isBackList(msg)||isBack(msg)){
    const props = fs.suggestedProperties||[];
    if(!props.length) return completeBuyer(fs,data);
    const selectOpts = [...props.map((_,i)=>String(i+1)), BTN.CUSTOM_SPEC, BTN.BACK];
    return {
      response: `تمام، دي قائمة العقارات المقترحة تاني. اختار رقم العقار أو اضغط لإرسال طلبك الخاص:`,
      formState:{...fs, active:true, flowType:"buyer_select", selectedProperty:null, imageUrls:imgs},
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

async function processPostComplete(fs, msg, env){
  const data = fs.data||{};
  const imgs = fs.imageUrls||[];
  const ownerFlow = String(fs.flowType||"").startsWith("owner");
  const ctx = ownerFlow?(fs.type==="sale"?"owner_sale":"owner_rent"):(fs.type==="sale"?"buyer":"tenant");
  const waMsg = fs.waMessage || buildWAMsg(ctx,data,imgs);
  if(isSendWA(msg)){
    return {
      response: "تمام! اضغط على الزر تحت لفتح المحادثة على واتساب دلوقتي 👇",
      formState:{...fs, waMessage:waMsg},
      options: POST_COMPLETE, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  if(isPreview(msg)){
    return {
      response: `دي الرسالة المؤهلة اللي هتتبعت لطارق:\n\n${waMsg}`,
      formState:{...fs, waMessage:waMsg},
      options: POST_PREVIEW, done:true, readyToSend:true, canShareWhatsapp:true,
      waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
    };
  }
  if(isEdit(msg)){
    const editFs = {...fs, active:true, lifecycle:LC.ACTIVE, stepIndex:0,
      flowType:ownerFlow?"owner":(fs.type==="sale"?"buyer":"tenant"), awaitingQ:true, data:{}, waMessage:null};
    if(ownerFlow) return askOwnerStep(getOwnerSteps(fs.type),0,editFs,null,null);
    return askBuyerStep(getBuyerSteps(fs.type),0,editFs,null,null);
  }
  if(isNewReq(msg)) return newRequest();
  return {
    response: "اضغط على الزر تحت عشان تبعت رسالتك المؤهلة لطارق على واتساب مباشرة:",
    formState: fs,
    options: POST_COMPLETE,
    done:true, readyToSend:true, canShareWhatsapp:true,
    waMessage: waMsg, whatsappUrl: waURL(TAREK_PHONE,waMsg), imageUrls:imgs
  };
}

function goBack(fs){
  const steps = getSteps(fs.type, fs.flowType);
  const data = {...(fs.data||{})};
  if(!data._filled) data._filled={};
  else data._filled={...data._filled};
  let idx = fs.stepIndex;
  if(idx<0||idx>=steps.length){
    const filled = steps.map((s,i)=>({s,i})).filter(({s})=>isFilled(data,s)).map(({i})=>i);
    idx = filled.length ? Math.max(...filled)+1 : 0;
  }
  let prev = idx-1;
  while(prev>=0 && steps[prev]?.id==="images") prev--;
  if(prev<0) return {...fs,active:true,lifecycle:LC.ACTIVE,stepIndex:0,data,awaitingQ:true, waMessage:null};
  const prevStep = steps[prev];
  const k = stepKey(prevStep);
  delete data[k]; delete data._filled[k];
  return {...fs,active:true,lifecycle:LC.ACTIVE,stepIndex:prev,data,awaitingQ:true, waMessage:null};
}

function cancelFlow(fs){
  return {
    response:"تمام، ألغينا الطلب. تقدر تبدأ من جديد وقت ما تحب:",
    formState:{active:false,lifecycle:LC.CANCELLED,type:fs.type,stepIndex:-1, data:{},awaitingQ:false,flowType:null,imageUrls:[]},
    options:ROUTE_BTNS, done:true,cancelled:true,readyToSend:false,canShareWhatsapp:false,imageUrls:[]
  };
}

function newRequest(){
  return {
    response: `أهلاً بيك، أنا وكيل طارق طنطاوي الذكي — سمسار مدينة نصر.
تشتري ولا تأجر ولا تبيع؟`,
    formState:{active:true,lifecycle:LC.ACTIVE,type:null,stepIndex:-1,data:{}, awaitingQ:false,flowType:"route_selection",imageUrls:[]},
    options:ROUTE_BTNS, done:false,readyToSend:false,canShareWhatsapp:false,imageUrls:[]
  };
}

function detectRoute(msg){
  const raw = String(msg||"").trim();
  const n = normAr(raw);
  if(/أأجر|ااجر|اؤجر|أاجر|مؤجر|مؤجرة|عندي.*(?:للإيجار|للايجار)|عايز.*(?:أأجر|ااجر)/i.test(raw)) return "owner_rent";
  if(n.includes("استاجر")||n.includes("مستاجر")||n.includes("للايجار")||n.includes("ايجار")) return "buyer_rent";
  if(/عايز\s*(?:ا|أ)بيع|ابيع\s*(?:شقتي|عقاري)?|أبيع\s*(?:شقتي|عقاري)?/i.test(raw)) return "owner_sale";
  if(n.includes("اشتري")||n.includes("شراء")||n.includes("للشراء")||n.includes("تمليك")) return "buyer_sale";
  if(n.includes("بيع")) return "owner_sale";
  return null;
}

// ═══ UPLOAD ═══
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function validateImagePayload(raw){
  if(typeof raw!=="string") return null;
  let b64 = raw.trim();
  const dataUrl = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if(dataUrl) b64 = dataUrl[2];
  b64 = b64.replace(/\s/g,"");
  if(!b64||b64.length<64) return null;
  if(!B64_RE.test(b64)) return null;
  const approxBytes = Math.floor(b64.length*3/4);
  if(approxBytes>MAX_IMG_BYTES) return null;
  return b64;
}
async function uploadImgBB(env, images){
  const key = env?.IMGBB_API_KEY;
  if(!key){ console.warn("[imgbb] missing key"); return {ok:false,error:"Upload unavailable"}; }
  if(!Array.isArray(images)||!images.length) return {ok:false,error:"No images"};
  if(images.length>MAX_IMAGES) return {ok:false,error:`Max ${MAX_IMAGES}`};
  const valid = images.map(validateImagePayload).filter(Boolean);
  if(!valid.length) return {ok:false,error:"Invalid image data"};
  const results = await Promise.allSettled(valid.map(async (b64) => {
    const f = new FormData();
    f.append("key", key);
    f.append("image", b64);
    const r = await fetchWithTimeout("https://api.imgbb.com/1/upload",{method:"POST",body:f},FETCH_TIMEOUT_IMGBB);
    if(!r.ok) throw new Error(`imgbb HTTP ${r.status}`);
    const d = await r.json();
    const u = d?.data?.url;
    if(typeof u!=="string"||!/^https:\/\//.test(u)) throw new Error("bad url");
    return u;
  }));
  const urls = [];
  for(const res of results){
    if(res.status==="fulfilled") urls.push(res.value);
    else console.warn("[imgbb] one upload failed:",res.reason?.message);
  }
  return urls.length?{ok:true,urls}:{ok:false,error:"Upload failed"};
}

// ═══ RATE LIMITER ═══
const rateMap = new Map();
const uploadRateMap = new Map();
const uploadHourlyMap = new Map();
function pruneRateMap(map, windowMs){
  if(map.size<RATE_MAP_MAX_KEYS) return;
  const now = Date.now();
  for(const [k,arr] of map){
    const fresh = arr.filter(t=>now-t<windowMs);
    if(fresh.length) map.set(k,fresh); else map.delete(k);
  }
  if(map.size>=RATE_MAP_MAX_KEYS) map.clear();
}
function hitLimit(map, key, windowMs, max){
  pruneRateMap(map, windowMs);
  const now = Date.now();
  const arr = (map.get(key)||[]).filter(t=>now-t<windowMs);
  if(arr.length>=max) return true;
  arr.push(now); map.set(key,arr);
  return false;
}
function rateLimited(ip){ return hitLimit(rateMap, ip, RATE_WINDOW_MS, RATE_MAX); }
function uploadRateLimited(ip){
  return hitLimit(uploadRateMap, ip, UPLOAD_RATE_WINDOW, UPLOAD_RATE_MAX) || hitLimit(uploadHourlyMap, ip, UPLOAD_HOURLY_WINDOW, UPLOAD_HOURLY_MAX);
}
async function readJsonBody(request, maxBytes){
  const declared = Number(request.headers.get("Content-Length"));
  if(Number.isFinite(declared)&&declared>maxBytes) return {tooLarge:true,json:null};
  if(!request.body) return {tooLarge:false,json:null};
  const reader = request.body.getReader(); const chunks=[]; let total=0;
  try { for(;;){ const {done,value}=await reader.read(); if(done)break; total+=value.byteLength; if(total>maxBytes){ await reader.cancel().catch(()=>{}); return {tooLarge:true,json:null}; } chunks.push(value); } }
  catch { return {tooLarge:false,json:null}; }
  const bytes = new Uint8Array(total); let off=0; for(const c of chunks){ bytes.set(c,off); off+=c.byteLength; }
  try { return {tooLarge:false,json:JSON.parse(new TextDecoder().decode(bytes))}; } catch { return {tooLarge:false,json:null}; }
}

// ═══ RESPONSE HELPERS ═══
function allowedOrigins(env){
  const extra = String(env?.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}
function corsHeaders(request, env){
  const origin = request?.headers?.get("Origin")||"";
  const list = allowedOrigins(env);
  const ok = origin && list.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : DEFAULT_ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}
const TYPING_MIN_MS = 400;
const TYPING_MAX_MS = 900;
function typingDelayFor(text){
  const len = String(text||"").length;
  if(!len) return 0;
  const span = TYPING_MAX_MS-TYPING_MIN_MS;
  const ratio = Math.min(1,Math.max(0,(len-40)/360));
  const base = TYPING_MIN_MS+Math.round(span*ratio);
  const jitter = Math.round(base*(Math.random()*0.24-0.12));
  return Math.max(TYPING_MIN_MS,Math.min(TYPING_MAX_MS,base+jitter));
}
function withTypingDelay(obj){
  if(obj&&typeof obj==="object"&&typeof obj.response==="string"&&obj.response) return {...obj, typingDelay:typingDelayFor(obj.response)};
  return obj;
}
function stampVersion(obj){
  if(obj&&typeof obj==="object"&&obj.formState&&typeof obj.formState==="object") return {...obj, formState:{...obj.formState, _version:FORM_VERSION}};
  return obj;
}
const jsonResWith = (cors, obj, s=200) =>
  new Response(JSON.stringify(obj), {status:s, headers:{...cors, "Content-Type":"application/json; charset=utf-8"}});

// ══════════════════════════════════════════════════════════════════════
// WEB PUSH (VAPID) — إشعارات العروض والطلبات الجديدة · 2026-10-10
// ──────────────────────────────────────────────────────────────────────
// المسارات (كلها تحت /push/ ولا تمس محادثة الوكيل إطلاقًا):
//   GET  /push/config      → المفتاح العام VAPID + حالة الجاهزية
//   POST /push/subscribe   → حفظ اشتراك Push في KV (CORS للأصل الرسمي فقط)
//   POST /push/unsubscribe → حذف الاشتراك
//   POST /push/send        → إرسال إشعار لمشتركين (يحميه سر Worker Secret)
//
// الأمان:
//  • لا تُخزَّن بيانات شخصية إطلاقًا: الـendpoint + مفتاحا التشفير + تاريخ فقط.
//  • الإرسال يرفض أي نص يشبه أرقام هواتف (حماية إضافية على مستوى الـWorker).
//  • الرابط المفتوح عند الضغط يُقيَّد بنطاق الموقع الرسمي داخل sw.js أيضًا.
//  • الحفاظ على idempotency عبر commit SHA + مسار الملف (مفتاح في KV).
//  • الاشتراكات المنتهية (404/410 من مزود Push) تُحذف تلقائيًا.
//
// ⚠️ المفاتيح والأسرار (VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY / PUSH_SEND_SECRET)
//    تُضبط كـ Worker Secrets ولا تُخزَّن في Git — راجع push-notify-setup.yml.
// ══════════════════════════════════════════════════════════════════════

const PUSH_SUB_PREFIX      = "push:sub:";
const PUSH_SENT_PREFIX     = "push:sent:";
const PUSH_SENT_TTL_S      = 30 * 24 * 3600;      // ذاكرة idempotency لمدة 30 يومًا
const VAPID_SUBJECT        = "mailto:samsar.talabak@mailo.com";
const SITE_ORIGIN          = "https://nasr-realestate.github.io";
const PUSH_MAX_BODY        = 8 * 1024;            // حد مستقل لمسارات /push/
const PUSH_SUB_RATE_WINDOW = 60 * 60 * 1000;
const PUSH_SUB_RATE_MAX    = 12;
const PUSH_SEND_RATE_WINDOW = 10 * 60 * 1000;
const PUSH_SEND_RATE_MAX    = 30;
const PUSH_TTL_SECONDS     = 86400;               // يوم واحد — عروض عقارية لا تستدعي إلحاحًا
const VAPID_MAX_AGE_S      = 12 * 3600;
const MAX_SUBS_PER_SEND    = 2000;                // سقف أمان ضد الضخامة
const MAX_TITLE_LEN        = 120;
const MAX_BODY_LEN         = 180;

// روابط الإشعارات: الموقع الرسمي فقط (نفس القيد في sw.js)
const PUSH_URL_RE = /^https:\/\/nasr-realestate\.github\.io\/(?:|(?:properties|requests)(?:\/[a-z0-9][a-z0-9-]{0,80})?\/)$/;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const FILE_PATH_RE = /^_(properties|requests)\/[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.md$/;

const pushSubRateMap  = new Map();
const pushSendRateMap = new Map();
function pushSubRateLimited(ip){ return hitLimit(pushSubRateMap, ip, PUSH_SUB_RATE_WINDOW, PUSH_SUB_RATE_MAX); }
function pushSendRateLimited(ip){ return hitLimit(pushSendRateMap, ip, PUSH_SEND_RATE_WINDOW, PUSH_SEND_RATE_MAX); }

// ─── ترميز base64url (بديل Buffer — متاح في Workers وNode معًا) ───
const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function bytesToB64u(bytes){
  let out = "";
  for(let i = 0; i < bytes.length; i += 3){
    const b0 = bytes[i], b1 = bytes[i+1], b2 = bytes[i+2];
    out += B64U_ALPHABET[b0 >> 2];
    out += B64U_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if(i + 1 < bytes.length) out += B64U_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if(i + 2 < bytes.length) out += B64U_ALPHABET[b2 & 63];
  }
  return out;
}
function b64uToBytes(str){
  const s = String(str || "").replace(/[^A-Za-z0-9\-_]/g, "");
  const out = [];
  let buf = 0, bits = 0;
  for(const ch of s){
    const v = B64U_ALPHABET.indexOf(ch);
    if(v < 0) return new Uint8Array(0);
    buf = (buf << 6) | v; bits += 6;
    if(bits >= 8){ bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
function b64uToAscii(str){ return String.fromCharCode(...b64uToBytes(str)); }
function utf8ToB64u(text){ return bytesToB64u(new TextEncoder().encode(String(text))); }
function asciiToB64u(str){ return bytesToB64u(Uint8Array.from(str, c => c.charCodeAt(0))); }

function timingSafeEqualStr(a, b){
  const sa = String(a || ""), sb = String(b || "");
  // مقارنة ثابتة الزمن على بايت خشن ثم مطابقة الطول
  let diff = sa.length ^ sb.length;
  const n = Math.max(sa.length, sb.length);
  for(let i = 0; i < n; i++) diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  return diff === 0;
}

// ─── حماية الخصوصية: أي نص يشبه رقم هاتف/بيانات شخصية يُرفض ───
const PHONE_LIKE_RE = /(?:\+|00)\d{7,15}|\b01[0125]\d{8}\b|[0-9٠-٩]{9,}/;
function looksLikePhone(text){ return PHONE_LIKE_RE.test(String(text || "")); }

function pushCors(request, env, methods){
  return { ...corsHeaders(request, env), "Access-Control-Allow-Methods": methods };
}

// ─── تحقق من اشتراك Push المُستلَم من المتصفح ───
const ALLOWED_ENDPOINT_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
function validateSubscription(raw){
  if(!raw || typeof raw !== "object") return { error: "invalid_subscription" };
  const endpoint = String(raw.endpoint || "");
  if(endpoint.length < 20 || endpoint.length > 2048) return { error: "invalid_endpoint" };
  let eu;
  try { eu = new URL(endpoint); } catch { return { error: "invalid_endpoint" }; }
  if(eu.protocol !== "https:") return { error: "invalid_endpoint" };
  const host = eu.hostname.toLowerCase();
  if(host === "localhost" || !ALLOWED_ENDPOINT_HOST_RE.test(host) ||
     /\.(local|internal|home|lan|corp)$/.test(host)){
    return { error: "invalid_endpoint" };
  }
  const keys = raw.keys;
  if(!keys || typeof keys !== "object") return { error: "invalid_keys" };
  const p256dh = String(keys.p256dh || "");
  const auth = String(keys.auth || "");
  const p256 = b64uToBytes(p256dh);
  const authB = b64uToBytes(auth);
  if(p256.length !== 65 || p256[0] !== 4) return { error: "invalid_keys" };
  if(authB.length < 16 || authB.length > 64) return { error: "invalid_keys" };
  return { ok: true, subscription: { endpoint, keys: { p256dh, auth } } };
}

// معرّف الاشتراك: بصمة SHA-256 للـendpoint (لا نُعيد الـendpoint نفسه أبدًا في الردود)
async function endpointHashHex(endpoint){
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(endpoint)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── RFC 8291: تشفير محتوى الإشعار (aes128gcm) عبر WebCrypto فقط ───
async function hkdfSha256(ikmBytes, saltBytes, infoBytes, length){
  const key = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes }, key, length * 8
  );
  return new Uint8Array(bits);
}
async function webPushEncrypt(payloadText, uaPublicB64u, uaAuthB64u){
  const uaPublic = b64uToBytes(uaPublicB64u);
  const uaAuth = b64uToBytes(uaAuthB64u);
  if(uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad_p256dh");
  if(uaAuth.length < 16) throw new Error("bad_auth");

  const uaPubKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPubKey }, eph.privateKey, 256));

  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const infoPrefix = new TextEncoder().encode("WebPush: info\u0000");
  const keyInfo = new Uint8Array(infoPrefix.length + uaPublic.length + asPublic.length);
  keyInfo.set(infoPrefix, 0);
  keyInfo.set(uaPublic, infoPrefix.length);
  keyInfo.set(asPublic, infoPrefix.length + uaPublic.length);

  const ikm = await hkdfSha256(ecdhSecret, uaAuth, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\u0000");
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\u0000");
  const cek = await hkdfSha256(ikm, salt, cekInfo, 16);
  const nonce = await hkdfSha256(ikm, salt, nonceInfo, 12);

  // سجل واحد: البيانات ثم محدد التجزئة 0x02 (RFC 8188 / RFC 8291 §4)
  const plain = new TextEncoder().encode(String(payloadText));
  const record = new Uint8Array(plain.length + 1);
  record.set(plain, 0);
  record[plain.length] = 0x02;

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, record));

  // ترويسة RFC 8188: salt(16) || rs=4096 (4 بايت BE) || idlen=0x41 || as_public(65)
  const header = new Uint8Array(86);
  header.set(salt, 0);
  header.set([0x00, 0x00, 0x10, 0x00], 16);
  header[20] = 0x41;
  header.set(asPublic, 21);

  const body = new Uint8Array(header.length + cipher.length);
  body.set(header, 0);
  body.set(cipher, header.length);
  return { body, saltB64u: bytesToB64u(salt), asPublicB64u: bytesToB64u(asPublic) };
}

// ─── RFC 8292: ترويسة VAPID (JWT ES256) ───
async function importVapidKeys(env){
  const privB64u = String(env.VAPID_PRIVATE_KEY || "");
  const pubB64u = String(env.VAPID_PUBLIC_KEY || "");
  if(!privB64u || !pubB64u) return null;
  try{
    const pub = b64uToBytes(pubB64u);
    const priv = b64uToBytes(privB64u);
    if(pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return null;
    const jwk = {
      kty: "EC", crv: "P-256",
      x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)),
      d: bytesToB64u(priv), alg: "ES256", ext: true,
    };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { key, publicKeyB64u: pubB64u };
  }catch{ return null; }
}
async function vapidHeaders(vapid, endpointUrl){
  const aud = new URL(endpointUrl).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = utf8ToB64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = utf8ToB64u(JSON.stringify({ aud, exp: now + VAPID_MAX_AGE_S, sub: VAPID_SUBJECT }));
  const signingInput = header + "." + payload;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, vapid.key,
    new TextEncoder().encode(signingInput)
  ));
  const jwt = signingInput + "." + bytesToB64u(sig);
  return {
    "Authorization": "vapid t=" + jwt + ", k=" + vapid.publicKeyB64u,
    "Crypto-Key": "p256ecdsa=" + vapid.publicKeyB64u,
  };
}

// ─── إرسال إشعار واحد إلى مزود Push؛ يعيد الحالة دون كشف بيانات ───
async function deliverPush(sub, payloadObj, vapid, fetchImpl = fetch){
  const encryption = await webPushEncrypt(JSON.stringify(payloadObj), sub.keys.p256dh, sub.keys.auth);
  const vapidHdr = await vapidHeaders(vapid, sub.endpoint);
  // Crypto-Key يجمع dh (RFC 8188 القديم) و p256ecdsa (VAPID) — دون إسقاط أحدهما
  const cryptoKey = "dh=" + encryption.asPublicB64u + "; " + (vapidHdr["Crypto-Key"] || "");
  const headers = {
    "TTL": String(PUSH_TTL_SECONDS),
    "Urgency": "normal",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Encryption": "salt=" + encryption.saltB64u,
    "Authorization": vapidHdr["Authorization"],
    "Crypto-Key": cryptoKey,
  };
  const res = await fetchImpl(sub.endpoint, { method: "POST", headers, body: encryption.body });
  const status = res?.status || 0;
  if(status === 201 || status === 200) return { ok: true, status };
  if(status === 404 || status === 410) return { ok: false, gone: true, status };
  return { ok: false, gone: false, status };
}

// ─── صياغة نص الإشعار من بيانات عامة فقط (بلا هواتف/أسماء/بيانات عملاء) ───
function buildNotification(input){
  const kind = input.kind === "request" ? "request" : "property";
  const rawTitle = String(input.title || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
  if(!rawTitle) return { error: "invalid_title" };
  const price = String(input.price || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const location = String(input.location || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const parts = [];
  if(price) parts.push("💰 " + price);
  if(location) parts.push("📍 " + location);
  const body = parts.join(" · ").slice(0, MAX_BODY_LEN) || "اضغط للتفاصيل";
  const title = (kind === "request" ? "🔔 طلب جديد: " : "🏠 عرض جديد: ") + rawTitle;
  if(looksLikePhone(title + " " + body)) return { error: "privacy_guard" };
  return {
    payload: {
      title: title.slice(0, MAX_TITLE_LEN + 24),
      body,
      url: String(input.url || ""),
      tag: "listing-" + String(input.filePath || "").replace(/[^a-z0-9]/gi, "-").slice(-40),
      kind,
    },
  };
}

function isConfigured(env){ return Boolean(env && env.PUSH_SUBS && env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY); }

// ─── المُعالج الرئيسي لمسارات /push/ ───
async function handlePush(request, env, url, ip){
  const path = url.pathname;
  const cors = pushCors(request, env, "GET,POST,OPTIONS");

  if(request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const respond = (obj, s = 200) => jsonResWith(cors, obj, s);

  // ── GET /push/config: المفتاح العام فقط (لا أسرار) ──
  if(path === "/push/config"){
    if(request.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);
    const publicKey = env.VAPID_PUBLIC_KEY && env.PUSH_SUBS ? String(env.VAPID_PUBLIC_KEY) : null;
    return respond({ ok: true, enabled: Boolean(publicKey), publicKey });
  }

  if(request.method !== "POST") return respond({ ok: false, error: "method_not_allowed" }, 405);
  if(!env.PUSH_SUBS) return respond({ ok: false, error: "push_not_configured" }, 503);
  const contentType = request.headers.get("Content-Type") || "";
  if(!/^application\/json\b/i.test(contentType)) return respond({ ok: false, error: "unsupported_content_type" }, 415);

  const { json: body, tooLarge } = await readJsonBody(request, PUSH_MAX_BODY);
  if(tooLarge) return respond({ ok: false, error: "payload_too_large" }, 413);
  if(!body || typeof body !== "object") return respond({ ok: false, error: "invalid_json" }, 400);

  // ── POST /push/subscribe ──
  if(path === "/push/subscribe"){
    if(pushSubRateLimited(ip)) return respond({ ok: false, error: "rate_limited" }, 429);
    const checked = validateSubscription(body.subscription);
    if(checked.error) return respond({ ok: false, error: checked.error }, 400);
    const device = ["mobile", "desktop", "tablet", "other"].includes(String(body.device || "")) ? String(body.device) : "other";
    const hash = await endpointHashHex(checked.subscription.endpoint);
    const nowIso = new Date().toISOString();
    const prev = await env.PUSH_SUBS.get(PUSH_SUB_PREFIX + hash, { type: "json" });
    await env.PUSH_SUBS.put(PUSH_SUB_PREFIX + hash, JSON.stringify({
      ...checked.subscription,
      device,
      createdAt: prev?.createdAt || nowIso,
      updatedAt: nowIso,
    }));
    return respond({ ok: true, id: hash.slice(0, 16) });
  }

  // ── POST /push/unsubscribe ──
  if(path === "/push/unsubscribe"){
    if(pushSubRateLimited(ip)) return respond({ ok: false, error: "rate_limited" }, 429);
    let hash = "";
    if(body.endpoint && typeof body.endpoint === "string") hash = await endpointHashHex(body.endpoint);
    else if(body.id && typeof body.id === "string" && /^[0-9a-f]{12,64}$/.test(body.id)) hash = body.id;
    else return respond({ ok: false, error: "invalid_request" }, 400);
    if(hash.length === 64){
      await env.PUSH_SUBS.delete(PUSH_SUB_PREFIX + hash);
    }else{
      // معرّف مختصر (16 حرفًا): ابحث بالبادئة ثم احذف المطابق
      const listed = await env.PUSH_SUBS.list({ prefix: PUSH_SUB_PREFIX });
      for(const key of (listed.keys || [])){
        if(key.name.slice(PUSH_SUB_PREFIX.length).startsWith(hash)) await env.PUSH_SUBS.delete(key.name);
      }
    }
    return respond({ ok: true });
  }

  // ── POST /push/send — مسار الإرسال من GitHub Actions (سر Worker Secret) ──
  if(path === "/push/send"){
    const auth = String(request.headers.get("Authorization") || "");
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const expected = String(env.PUSH_SEND_SECRET || "");
    if(!expected || !token || !timingSafeEqualStr(token, expected)){
      return respond({ ok: false, error: "unauthorized" }, 401);
    }
    if(pushSendRateLimited(ip)) return respond({ ok: false, error: "rate_limited" }, 429);

    const filePath = String(body.filePath || "");
    const commitSha = String(body.commitSha || "");
    const targetUrl = String(body.url || "");
    const isTest = body.test === true;
    const target = body.target == null ? "" : String(body.target);

    if(!FILE_PATH_RE.test(filePath)) return respond({ ok: false, error: "invalid_file_path" }, 400);
    if(!COMMIT_SHA_RE.test(commitSha)) return respond({ ok: false, error: "invalid_commit_sha" }, 400);
    if(!PUSH_URL_RE.test(targetUrl)) return respond({ ok: false, error: "invalid_url" }, 400);
    const kindFromPath = filePath.indexOf("_requests/") === 0 ? "request" : "property";
    const kind = String(body.kind || kindFromPath);
    if(kind !== kindFromPath) return respond({ ok: false, error: "kind_mismatch" }, 400);
    if(target && !/^[0-9a-f]{12,64}$/.test(target)) return respond({ ok: false, error: "invalid_target" }, 400);
    if(isTest && !target) return respond({ ok: false, error: "test_requires_single_target" }, 400);

    const built = buildNotification({ kind, title: body.title, price: body.price || body.budget, location: body.location, url: targetUrl, filePath });
    if(built.error) return respond({ ok: false, error: built.error }, 400);
    if(isTest) built.payload.title = "🧪 اختبار: " + built.payload.title;

    // idempotency: نفس commit SHA + المسار لا يُرسل مرتين (يحمي من إعادة التشغيل)
    const idemKey = String(body.idempotencyKey || (commitSha + ":" + filePath)).slice(0, 200);
    if(!/^[A-Za-z0-9:._#\/-]+$/.test(idemKey)) return respond({ ok: false, error: "invalid_idempotency_key" }, 400);
    const sentKey = PUSH_SENT_PREFIX + idemKey;
    const already = await env.PUSH_SUBS.get(sentKey);
    if(already) return respond({ ok: true, deduped: true, attempted: 0, success: 0, failed: 0, removed: 0, id: idemKey });

    // جمع المشتركين (أو واحد فقط عند التحديد)
    const subs = [];
    if(target && target.length === 64){
      const one = await env.PUSH_SUBS.get(PUSH_SUB_PREFIX + target, { type: "json" });
      if(one) subs.push({ key: PUSH_SUB_PREFIX + target, sub: one });
    }else{
      let cursor;
      do{
        const page = await env.PUSH_SUBS.list({ prefix: PUSH_SUB_PREFIX, cursor });
        for(const item of (page.keys || [])){
          const sub = await env.PUSH_SUBS.get(item.name, { type: "json" });
          if(sub && sub.endpoint && sub.keys) subs.push({ key: item.name, sub });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      }while(cursor && subs.length < MAX_SUBS_PER_SEND);
      if(target){
        const narrowed = subs.filter(s => s.key.slice(PUSH_SUB_PREFIX.length).startsWith(target));
        subs.length = 0; subs.push(...narrowed);
      }
    }

    if(!subs.length){
      await env.PUSH_SUBS.put(sentKey, JSON.stringify({ at: Date.now(), attempted: 0 }), { expirationTtl: PUSH_SENT_TTL_S });
      return respond({ ok: true, deduped: false, attempted: 0, success: 0, failed: 0, removed: 0, note: isTest ? "target_not_found" : "no_subscribers", id: idemKey });
    }

    const vapid = await importVapidKeys(env);
    if(!vapid) return respond({ ok: false, error: "vapid_not_configured" }, 503);

    let success = 0, failed = 0, removed = 0;
    for(const entry of subs){
      try{
        const result = await deliverPush(entry.sub, built.payload, vapid);
        if(result.ok){ success++; }
        else{
          failed++;
          if(result.gone){ await env.PUSH_SUBS.delete(entry.key); removed++; }
        }
      }catch{ failed++; }
    }

    const summary = { attempted: subs.length, success, failed, removed, id: idemKey };
    // ذاكرة idempotency — تُحفظ حتى لو فشل البعض، لأن إعادة التشغيل لن تُصلح مشتركًا ميتًا
    await env.PUSH_SUBS.put(sentKey, JSON.stringify({ at: Date.now(), ...summary }), { expirationTtl: PUSH_SENT_TTL_S });

    if(success === 0 && subs.length > 0 && !isTest){
      return respond({ ok: false, error: "all_deliveries_failed", ...summary }, 502);
    }
    return respond({ ok: true, deduped: false, ...summary });
  }

  return respond({ ok: false, error: "not_found" }, 404);
}

// ══════════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const jsonRes = (obj, s=200) => jsonResWith(cors, stampVersion(withTypingDelay(obj)), s);
    const reqId = Math.random().toString(36).slice(2,10);
    const ip = request.headers.get("CF-Connecting-IP")||"unknown";

    // ═══ Web Push — مسارات الإشعارات مستقلة تمامًا عن محادثة الوكيل ═══
    if(url.pathname.indexOf("/push/")===0) return handlePush(request, env, url, ip);

    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors});

    const isUpload = url.pathname === "/upload-images";
    const declaredLen = Number(request.headers.get("Content-Length")||0);
    if(declaredLen > (isUpload ? MAX_UPLOAD_BODY_BYTES : MAX_CHAT_BODY_BYTES)) return jsonRes({error:"Payload too large"},413);

    if(isUpload && request.method==="POST"){
      if(uploadRateLimited(ip)) return jsonRes({error:"Too many uploads, slow down"},429);
      if(!/^application\/json\b/i.test(request.headers.get("Content-Type")||"")) return jsonRes({error:"Unsupported content type"},415);
      try {
        const { json: body, tooLarge } = await readJsonBody(request, MAX_UPLOAD_BODY_BYTES);
        if(tooLarge) return jsonRes({error:"Payload too large"},413);
        if(!body||typeof body!=="object") return jsonRes({error:"Invalid JSON"},400);
        const r = await uploadImgBB(env, body.images||[]);
        if(!r.ok) return jsonRes({error:r.error},400);
        return jsonRes({urls:r.urls});
      } catch(err){
        console.error(`[${reqId}][upload] ${err?.message}`);
        return jsonRes({error:"Upload failed"},500);
      }
    }

    if(request.method!=="POST") return jsonRes({error:"Method not allowed"},405);
    if(rateLimited(ip)) return jsonRes({response:"استنى شوية، بتبعت رسايل كتير.",options:ROUTE_BTNS},429);

    try {
      const { json: body, tooLarge } = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
      if(tooLarge) return jsonRes({response:"الرسالة كبيرة أوي — قصّرها وجرّب تاني.",options:ROUTE_BTNS},413);
      if(!body||typeof body!=="object") return jsonRes({response:"طلب غير صالح.",options:ROUTE_BTNS},400);

      const userMsg = String(body.message||"").trim().slice(0, MAX_MSG_LEN);
      let fs = sanitizeState(body.formState && typeof body.formState==="object" ? body.formState : {});
      const history = (Array.isArray(body.history)?body.history:[])
        .filter(m=>m&&typeof m==="object"&&typeof m.message==="string")
        .slice(-MAX_HISTORY);
      const incomingImgs = (Array.isArray(body.imageUrls)?body.imageUrls:[])
        .filter(u=>typeof u==="string"&&/^https:\/\/[^\s<>"']+$/.test(u))
        .slice(0, MAX_IMAGES);

      if(incomingImgs.length && fs?.active){
        fs.imageUrls = [...(fs.imageUrls||[]),...incomingImgs].slice(0,MAX_IMAGES);
      }
      const incomingGps = sanitizeGps(body.gps);
      if(incomingGps && fs?.active){
        fs.data = { ...(fs.data||{}), gps: incomingGps };
      }
      const incomingValuation = sanitizeValuation(body.valuationResult);
      if(incomingValuation && fs?.active){
        fs.data = fs.data || {};
        fs.data.valuation = incomingValuation;
        fs.data._valuationShown = false;
        fs._justReturnedFromValuation = true;
      }

      // ═══ Intelligence Core: build/refresh agentState ═══
      fs.agentState = initAgentState(fs.agentState);
      syncAgentStateFromFlow(fs.agentState, fs);

      // Identity / Greeting / Off-topic
      if(isIdentityQ(userMsg)){
        return jsonRes({
          response: IDENTITY_RESPONSE,
          formState: fs,
          options: ROUTE_BTNS,
          done:false, readyToSend:false, canShareWhatsapp:false,
          imageUrls: fs.imageUrls||[],
        });
      }
      if(isGreeting(userMsg)){
        return jsonRes({
          response: GREETING_RESPONSE,
          formState: fs,
          options: ROUTE_BTNS,
          done:false, readyToSend:false, canShareWhatsapp:false,
          imageUrls: fs.imageUrls||[],
        });
      }
      if(isOffTopic(userMsg)){
        return jsonRes({ response: OFF_TOPIC_RESPONSE, formState: fs, options: [] });
      }
      if(PRICE_OBJECTION_RE.test(userMsg)) return jsonRes({ response: PRICE_OBJECTION_RESPONSE, options: ROUTE_BTNS, formState: fs });
      if(HESITATION_RE.test(userMsg)) return jsonRes({ response: HESITATION_RESPONSE, options: ROUTE_BTNS, formState: fs });

      const flowType = fs.flowType||"";
      const hasFlow = fs.active===true && flowType!=="";

      // ═══ Route selection ═══
      if(!hasFlow || flowType==="route_selection"){
        if(!userMsg) return jsonRes(newRequest());

        const currentFacts = extractRequestFacts(userMsg);
        const pendingFacts = fs?.data?.pendingFacts && typeof fs.data.pendingFacts==="object" ? fs.data.pendingFacts : {};
        const facts = { ...pendingFacts, ...currentFacts };

        // Understanding
        const understanding = understandMessage(userMsg, fs.agentState, fs, history);
        const decision = decideNextAction(understanding, fs.agentState, fs);
        fs.agentState.intent = understanding.intent;
        fs.agentState.role = understanding.role || fs.agentState.role;
        fs.agentState.lastAction = decision.action;

        // Correction detection
        const corrections = detectCorrection(fs.agentState, currentFacts);
        if(corrections.length) fs.agentState.corrections = [...(fs.agentState.corrections||[]), ...corrections].slice(-20);

        // ═══ beginFlow ═══
        const beginFlow = async (route, seedFacts) => {
          const isBuyer = route.startsWith("buyer");
          const type = route.endsWith("rent") ? "rent" : "sale";
          const owner = !isBuyer;
          const lms = await fetchLandmarks({ transaction: type });
          const steps = isBuyer ? getBuyerSteps(type) : getOwnerSteps(type);
          const safeFacts = {...(seedFacts||{})};
          // ⭐ رقم مجرد/ملتبس/هاتف في أول رسالة لا يُبذر كسعر
          if(!isClearPriceStatement(userMsg, null)) delete safeFacts.budget;
          const data = seedFlowData(safeFacts, owner);
          const newFs = {
            active: true, lifecycle: LC.ACTIVE, type, stepIndex: 0, data,
            awaitingQ: true, flowType: isBuyer ? (type === "sale" ? "buyer" : "tenant") : "owner",
            imageUrls: [],
            agentState: {
              ...fs.agentState,
              role: owner ? (type==="rent"?AGENT_ROLE.LANDLORD:AGENT_ROLE.SELLER) : (type==="rent"?AGENT_ROLE.TENANT:AGENT_ROLE.BUYER),
              transaction: type==="rent" ? "RENT" : "SALE",
              intent: owner ? AGENT_INTENT.PROPERTY_OFFER : AGENT_INTENT.PROPERTY_SEARCH,
            }
          };
          const idx = nextStep(steps, data, 0);
          const r = isBuyer
            ? askBuyerStep(steps, idx < 0 ? 0 : idx, newFs, null, lms)
            : askOwnerStep(steps, idx < 0 ? 0 : idx, newFs, null, lms);
          const activeStep = steps[idx < 0 ? 0 : idx];
          return jsonRes(await enhanceResponse(env, r, userMsg, r.formState, activeStep, history));
        };

        // ═══ REFUSE ═══
        if(decision.action === DECISION.REFUSE){
          return jsonRes({response: OUT_OF_SCOPE_RESPONSE, options: ROUTE_BTNS, formState: fs});
        }

        // ═══ VALUATE ═══
        if(decision.action === DECISION.VALUATE){
          const role = understanding.role;
          if(role === AGENT_ROLE.SELLER || role === AGENT_ROLE.LANDLORD){
            const isRent = role === AGENT_ROLE.LANDLORD || /ايجار|إيجار|أأجر|ااجر|للايجار/i.test(userMsg);
            return beginFlow(isRent ? "owner_rent" : "owner_sale", facts);
          }
          return jsonRes({
            response: "تمام، عايز تعرف قيمة عقارك؟ 💎\n\nاختار 💰 أبيع أو 🔑 أأجر وأنا هوصل معاك خطوة خطوة، وفي الآخر هتلاقي زر التقييم يفتحلك تقييم استرشادي من بيانات مدينة نصر.",
            formState: { ...fs, agentState: fs.agentState },
            options: [BTN.SELL, BTN.LANDLORD, BTN.NEW_REQ],
            done:false, readyToSend:false, canShareWhatsapp:false, imageUrls: [],
          });
        }

        // ⭐ SELLER/LANDLORD مع ذكر مشتري → لا ندّعي وجود مشتري
        if((understanding.role === AGENT_ROLE.SELLER || understanding.role === AGENT_ROLE.LANDLORD)
           && /مشتري|مشترين|مشترى|عميل|عملاء|مستأجر|مستأجرين|حد\s*جاهز/i.test(userMsg)){
          return jsonRes({
            response: "معندناش قايمة مشترين مفتوحة للاطلاع، بس سجّل عقارك وهنعرضه على العملاء الجاهزين في القاعدة بعد ما نتفق على التفاصيل.\n\n💰 أبيع ولا 🔑 أأجر؟",
            formState: { ...fs, agentState: fs.agentState },
            options: [BTN.SELL, BTN.LANDLORD, BTN.NEW_REQ],
            done:false, readyToSend:false, canShareWhatsapp:false, imageUrls:[]
          });
        }

        // ⭐ SELLER/LANDLORD مع ذكر عقار → owner flow مباشر
        if((understanding.role === AGENT_ROLE.SELLER || understanding.role === AGENT_ROLE.LANDLORD)
           && (hasRequestFacts(facts) || REAL_ESTATE_RE.test(userMsg))){
          const isRent = understanding.role === AGENT_ROLE.LANDLORD;
          return beginFlow(isRent ? "owner_rent" : "owner_sale", facts);
        }

        // ═══ Standard routes ═══
        if(isBuy(userMsg))      return beginFlow("buyer_sale", facts);
        if(isTenant(userMsg))   return beginFlow("buyer_rent", facts);
        if(isSell(userMsg))     return beginFlow("owner_sale", facts);
        if(isLandlord(userMsg)) return beginFlow("owner_rent", facts);

        const route = facts.transaction || detectRoute(userMsg);
        if(route) return beginFlow(route, facts);

        if(isOfficeQ(userMsg)) return jsonRes({response:officeMsg(),options:ROUTE_BTNS,formState:fs});
        if(/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(userMsg)) return jsonRes({response:`سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`,options:ROUTE_BTNS,formState:fs});
        const canned = matchInterrupt(userMsg, fs);
        if(canned) return jsonRes({response:canned,options:ROUTE_BTNS,formState:fs});
        if(isOutOfArea(userMsg)&&!isNasr(userMsg)) return jsonRes({response:OUT_OF_SCOPE_RESPONSE,options:ROUTE_BTNS,formState:fs});

        if(hasRequestFacts(facts) || REAL_ESTATE_RE.test(userMsg)){
          return jsonRes({
            response: buildRouteQuestion(facts),
            formState: {
              active: true, lifecycle: LC.ACTIVE, type: null, stepIndex: -1,
              data: { pendingFacts: facts }, awaitingQ: false, flowType: "route_selection", imageUrls: [],
              agentState: { ...fs.agentState, intent: understanding.intent },
            },
            options: ROUTE_BTNS, done:false, readyToSend:false, canShareWhatsapp:false,
          });
        }

        if(!env?.GEMINI_API_KEY) return jsonRes({response:"تمام، أساعدك في عقارات مدينة نصر. شراء ولا إيجار؟",options:ROUTE_BTNS,formState:fs});
        const reply = await geminiFirstMsg(env, userMsg, history, fs?.data);
        if(reply) return jsonRes({response:reply,options:ROUTE_BTNS,formState:fs});
        return jsonRes(newRequest());
      }

      // ═══ Intelligence: تحديث agentState + تطبيق التصحيحات داخل الـflow ═══
      {
        const understanding = understandMessage(userMsg, fs.agentState, fs, history);
        if(understanding.role && !fs.agentState.role) fs.agentState.role = understanding.role;
        if(understanding.intent && understanding.intent !== AGENT_INTENT.FOLLOW_UP) fs.agentState.intent = understanding.intent;
        else if(!fs.agentState.intent) fs.agentState.intent = AGENT_INTENT.FOLLOW_UP;

        // ⭐ تطبيق التصحيحات على بيانات الفورم — استبدال القيم القديمة
        const ownerFlow = String(flowType||"").startsWith("owner");
        const factKeyMap = {
          landmark: ownerFlow ? "location" : "landmark",
          budget: ownerFlow ? "price" : "budget",
          area: "area", rooms: "rooms", baths: "baths",
          furnished: "furnished", propertyType: "propertyType"
        };
        // سياق الخطوة الحالية: هو الحاكم في التفريق بين رقم مجرد وسعر
        let currentStepId = null;
        try { currentStepId = getSteps(fs.type, flowType)[fs.stepIndex]?.id || null; } catch {}
        const newFacts = understanding.entities || {};
        for(const [k,v] of Object.entries(newFacts)){
          if(!hasVal(v)) continue;
          const key = factKeyMap[k];
          if(!key) continue;
          // ⭐ رقم مجرد لا يصحّح السعر/الميزانية: لازم تصريح سعر واضح أو السؤال الحالي هو السعر/الميزانية
          if((key === "price" || key === "budget") && !isClearPriceStatement(userMsg, currentStepId)) continue;
          // ⭐ ومفيش مساحة غير معقولة تستبدل مساحة صحيحة
          if(key === "area" && !plausibleArea(v)) continue;
          const prev = fs.data?.[key];
          if(hasVal(prev) && String(prev) !== String(v)){
            if(ADDRESS_STEP_IDS.has(key)) fs.data = rememberRawLocation(fs.data, prev);
            fs.data = { ...fs.data, [key]: v };
            fs.agentState.corrections = [...(fs.agentState.corrections||[]), { field:key, from:prev, to:v, at:Date.now() }].slice(-20);
          }
        }

        fs = applyUnderstandingToFlowData(fs, understanding);
        syncAgentStateFromFlow(fs.agentState, fs);
      }

      if(isOfficeQ(userMsg)) return jsonRes({response:officeMsg(),options:ROUTE_BTNS,formState:fs});
      if(/طلاب|طلبة|مغتربين|مغتربات|سكن طلاب/i.test(userMsg)) return jsonRes({response:`سكن الطلاب مع الأستاذة آلاء: ${ALAA_PHONE}`,options:ROUTE_BTNS,formState:fs});
      if(flowType==="owner" && !fs.data?.valuation && VALUATION_REQUEST_RE.test(userMsg)){
        const ownerSteps = getOwnerSteps(fs.type);
        if(ownerSteps[fs.stepIndex]?.id==="valuationGift"){
          return jsonRes(askOwnerStep(ownerSteps, fs.stepIndex, fs, "أكيد 👌 اضغط زر 💎 قيّم عقارك تحت.", null));
        }
      }
      const cannedMid = matchInterrupt(userMsg, fs);
      if(cannedMid) return jsonRes({response:cannedMid,options:ROUTE_BTNS,formState:fs});

      if(flowType==="owner"){
        const lms = await fetchLandmarks({transaction:fs.type});
        const step = getOwnerSteps(fs.type)[fs.stepIndex];
        if(step?.id==="location" && !incomingGps && fs.data?.gps){ fs.data = {...fs.data}; delete fs.data.gps; }
        const r = await processOwner(fs,userMsg,env,history,lms);
        return jsonRes(await enhanceResponse(env,r,userMsg,fs,step,history));
      }
      if(flowType==="buyer"||flowType==="tenant"){
        const lms = await fetchLandmarks({transaction:fs.type,propertyType:fs.data?.propertyType});
        const step = getBuyerSteps(fs.type)[fs.stepIndex];
        if(step?.id==="landmark" && !incomingGps && fs.data?.gps){ fs.data = {...fs.data}; delete fs.data.gps; }
        const r = await processBuyer(fs,userMsg,env,history,lms);
        return jsonRes(await enhanceResponse(env,r,userMsg,fs,step,history));
      }
      if(flowType==="buyer_select") return jsonRes(await processBuyerSelect(fs,userMsg,env));
      if(flowType==="buyer_selected_property") return jsonRes(await processBuyerSelectedProp(fs,userMsg,env));
      if(flowType.startsWith("owner_completed")||flowType==="buyer_completed") return jsonRes(await processPostComplete(fs,userMsg,env));

      const step = getSteps(fs.type,flowType)[fs.stepIndex];
      if(step){
        const reply = await geminiContextual(env,userMsg,fs,step,history);
        if(reply) return jsonRes({response:reply,formState:fs,options:ROUTE_BTNS});
      }
      return jsonRes({response:"أهلاً بيك. اختار طلبك:",options:ROUTE_BTNS,formState:fs});
    } catch(err){
      console.error(`[${reqId}][ERROR]`, err?.message, err?.stack);
      return jsonRes({response:"حصلت مشكلة مؤقتة، جرّب تاني.",options:ROUTE_BTNS},500);
    }
  }
};
// ═══════════════════════════════════════════════════
// نهاية الملف — سمسار طلبك v9.2-FINAL
// ═══════════════════════════════════════════════════
