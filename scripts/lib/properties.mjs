/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/lib/properties.mjs
 *  نموذج بيانات موحّد للعقارات — مصدر واحد للحقيقة
 * ───────────────────────────────────────────────────────────────
 *  السبب: كانت الحقول الرقمية (priceNumeric/areaNumeric/roomsNumeric/
 *  bathsNumeric) مكتوبة يدويًا داخل front matter في 102 ملف. Νέα ملفات
 *  تُضاف من غير الأرقام → صفحة العقار تصدر Offer.price = "0" وبدون
 *  floorSize/numberOfRooms. هذا الملف يستنتج الأرقام من النصوص العربية
 *  بنفس منطق قالب ai-feed.json، ويستخدم كمرجع واحد لكل مخرجات الذكاء
 *  الاصطناعي (ai-feed.json · llms-full.txt · /api/**).
 *
 *  ⚠️ قاعدة صارمة: لا نختلق أرقامًا. لو النص لا يحتوي رقمًا واضحًا،
 *     القيمة ترجع null وليس 0. الفراغ أصدق من الرقم الخطأ.
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontMatter } from './front-matter.mjs';

/** أرقام عربية-هندية شائعة الاستخدام في النصوص العربية */
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export function normalizeDigits(input) {
  return String(input ?? '').replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

/** إزالة التشكيل والحروف الممدودة لتوحيد المطابقة النصية */
export function stripTashkeel(input) {
  return normalizeDigits(input)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/\u0622|\u0623|\u0625/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647');
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** وحدات مكتوبة بالحروف — تُستخدم فقط لو الرقم مكتوب حروفًا (نادر) */
const NUMERIC_WORDS = {
  'واحد': 1, 'اثنين': 2, 'اتنين': 2, 'ثلاثة': 3, 'تلاتة': 3, 'أربعة': 4, 'اربعة': 4,
  'خمسة': 5, 'ستة': 6, 'سبعة': 7, 'ثمانية': 8, 'تمانية': 8, 'تسعة': 9, 'عشرة': 10,
};

/**
 * أول عدد صحيح داخل نص (يدعم الفواصل والمسافات).
 * "3,700,000 ج.م" → 3700000 · "180 متر مربع" → 180 · "لا يوجد" → null
 */
export function firstNumber(input) {
  const s = normalizeDigits(input).replace(/[\u066B\u066C]/g, ',');

  // ⚠️ «3.700.000» — النقطة كفاصل آلاف أوروبي.
  // لولا هذه الحالة لكنا أعدنا 3 بدل 3,700,000 (خطأ بمعامل مليون).
  // الشرط صارم: 1–3 أرقام ثم مجموعة أو أكثر من «.٣ أرقام» — أي نمط آخر
  // (مثل «12.5» الكسرية) لا يدخل هنا، فتبقى القاعدة «الجزء الصحيح فقط».
  const grouped = s.match(/^\s*(\d{1,3}(?:\.\d{3})+)/);
  if (grouped) {
    const n = Number(grouped[1].replace(/\./g, ''));
    if (Number.isFinite(n)) return n;
  }

  const m = s.match(/\d[\d,\s\u00A0\u202F]*/);
  if (m) {
    const digits = m[0].replace(/[^\d]/g, '');
    if (digits) {
      const n = Number(digits);
      if (Number.isFinite(n)) return n;
    }
  }
  const plain = stripTashkeel(input);
  for (const [word, value] of Object.entries(NUMERIC_WORDS)) {
    if (plain.includes(word)) return value;
  }
  return null;
}

/** عدد محدود بعدد معيّن من الكلمات المفتاحية — مثل «3 غرف» أو «2 حمام» */
export function numberOf(input, keywords, { max = 20 } = {}) {
  const s = normalizeDigits(input);
  for (const kw of keywords) {
    const re = new RegExp(`(\\d[\\d,]*)\\s*${kw}`, 'u');
    const m = s.match(re);
    if (m) {
      const n = Number(m[1].replace(/[^\d]/g, ''));
      if (Number.isFinite(n) && n > 0 && n <= max) return n;
    }
  }
  return null;
}

/** استخراج رقم السعر */
export function derivePrice(d) {
  if (d.priceNumeric !== undefined && d.priceNumeric !== null && Number(d.priceNumeric) > 0) {
    return Number(d.priceNumeric);
  }
  return firstNumber(d.price);
}

/** استخراج رقم المساحة */
export function deriveArea(d) {
  if (d.areaNumeric !== undefined && d.areaNumeric !== null && Number(d.areaNumeric) > 0) {
    return Number(d.areaNumeric);
  }
  return firstNumber(d.area);
}

/** استخراج عدد الغرف — «غرف» أولًا ثم «أوض» ثم رقم البداية */
export function deriveRooms(d) {
  if (d.roomsNumeric !== undefined && d.roomsNumeric !== null && Number(d.roomsNumeric) > 0) {
    return Number(d.roomsNumeric);
  }
  const byKeyword = numberOf(d.rooms, ['غرف(?:ة)?', 'اوض(?:ة|ه)?', 'أوض(?:ة|ه)?'], { max: 15 });
  if (byKeyword !== null) return byKeyword;
  const s = normalizeDigits(d.rooms);
  if (/^\s*\d/.test(s)) {
    const n = firstNumber(s);
    if (n !== null && n > 0 && n <= 15) return n;
  }
  return null;
}

/** استخراج عدد الحمامات */
export function deriveBaths(d) {
  const direct = d.bathsNumeric ?? d.bathroomsNumeric;
  if (direct !== undefined && direct !== null && Number(direct) > 0) return Number(direct);
  const src = d.bathrooms ?? d.baths;
  const byKeyword = numberOf(src, ['حمام(?:ات)?'], { max: 10 });
  if (byKeyword !== null) return byKeyword;
  const s = normalizeDigits(src);
  if (/^\s*\d/.test(s)) {
    const n = firstNumber(s);
    if (n !== null && n > 0 && n <= 10) return n;
  }
  return null;
}

/**
 * هل العقار للإيجار؟
 * ⚠️ منطق دقيق (2026-10-16): كان «شهري» في العنوان يُصنّف عقارات البيع
 *    كإيجار — مثل «محل 212م — عائد شهري 160 ألف» و«شقة 130م (بعائد شهري)»
 *    وهما عرضان للبيع بعائد إيجاري. التصنيف يعتمد الآن على **السعر**
 *    (الذي يحمل كلمة «شهرياً») أو على **العنوان** بعلامة إيجار صريحة،
 *    لا على أي ذكر عابر لكلمة «شهري».
 */
export function deriveTransaction(d, title = '') {
  const category = stripTashkeel(d.category ?? '');
  if (/rent/i.test(category)) return 'rent';

  const priceNorm = stripTashkeel(d.price ?? '');
  const titleNorm = stripTashkeel(`${title} ${d.title ?? ''}`);

  // «شهرياً» / «/ شهر» / «كل شهر» في خانة السعر = إيجار شهري
  if (/شهريا|شهر\b|شهرى|كل شهر|\/\s*شهر/.test(priceNorm)) return 'rent';

  // علامة إيجار صريحة في العنوان
  if (/لل[ا]?يجار|للايجار|للإيجار|للايجار/.test(titleNorm)) return 'rent';

  // «إيجار» في السعر، إلا لو كان خيارًا ثانويًا («أو إيجار …»)
  if (/ايجار/.test(priceNorm) && !/(او|أو)\s*ايجار/.test(priceNorm)) return 'rent';

  return 'sale';
}

/**
 * نوع العقار الموحّد: apartment | villa | shop | office | warehouse | clinic
 *
 * ⚠️ قاعدة «الكلمة الأولى في العنوان تفوز».
 * السبب: عناوين هذا الموقع تُكتب «النوع الرئيسي / نوع ثانوي - الموقع»،
 * فمثلًا «مكتب إداري / مخزن 73م للإيجار» وحدة إدارية يجوز استخدامها كمخزن.
 * الفحص بقائمة أولويات ثابتة كان يقرأها «مخزن» فتُختفي من فلتر المكاتب،
 * بينما قراءة العنوان بالترتيب تُعطي «مكتب إداري» — وهو ما يقرأه الإنسان.
 */
export function derivePropertyType(d, title = '') {
  const hay = stripTashkeel(`${d.title ?? ''} ${title}`);
  const category = stripTashkeel(d.category ?? '').toLowerCase();

  const PATTERNS = [
    ['warehouse', /warehouse|مخزن|مخازن|مستودع/],
    ['shop', /shop|commercial|محل|تجار|معرض|صيدلي|showroom|شوروم/],
    ['clinic', /clinic|عياده/],
    // ⚠️ «مقر» مستثناة عن قصد: «مقر تجاري» في عناوين هذا الموقع تعني وحدة
    // تجارية (محل/معرض)، لا مكتبًا. إدخالها هنا كان يحوّل محلات إلى مكاتب.
    ['office', /office|admin|ادار|مكتب/],
    ['villa', /villa|فيلا|دوبلكس|duplex|تاون/],
    ['apartment', /apartment|شقه|روف|roof|بنتهاوس|penthouse|flat/],
  ];

  // 1) العنوان: أول كلمة نوع تظهر تفوز
  let best = null;
  for (const [type, re] of PATTERNS) {
    const m = hay.match(re);
    if (!m) continue;
    if (best === null || m.index < best.index) best = { type, index: m.index };
  }
  if (best) return best.type;

  // 2) الفئة: بالمثل، أول وصف يظهر
  let catBest = null;
  const CATEGORY_HINTS = [
    ['warehouse', /warehouse|مخزن/],
    ['shop', /shop|commercial|محل|تجار/],
    ['office', /office|admin|ادار|مكتب/],
    ['villa', /villa|فيلا/],
    ['apartment', /apartment|rent|شقه/],
  ];
  for (const [type, re] of CATEGORY_HINTS) {
    const m = category.match(re);
    if (!m) continue;
    if (catBest === null || m.index < catBest.index) catBest = { type, index: m.index };
  }
  return catBest ? catBest.type : 'apartment';
}

/** هل العقار مفروش؟ */
export function deriveFurnished(d, title = '') {
  const haystack = stripTashkeel(`${d.title ?? ''} ${title} ${d.description ?? ''}`);
  if (/غير مفروش|مش مفروش|فاضيه|فاضية|خاليه من العفش/.test(haystack)) return 'unfurnished';
  if (d.furnished === true) return 'furnished';
  if (d.furnished === false) return 'unfurnished';
  if (/مفروش|furnished|فندق/.test(haystack)) return 'furnished';
  return null;
}

/**
 * المناطق المعروفة — مرتّبة بالأولوية: الأحياء/المناطق أولًا (أوسع نطاقًا)،
 * ثم الشوارع والميادين الشهيرة، ثم المدن والكمبوندات.
 * القيمة المعروضة تبقى بالعربية الصحيحة، والمطابقة تتم على نص مُوحّد.
 */
export const KNOWN_ZONES = [
  // الأحياء والمناطق (مدينة نصر)
  'المنطقة الأولى', 'المنطقة الثانية', 'المنطقة الثالثة', 'المنطقة الرابعة', 'المنطقة الخامسة',
  'المنطقة السادسة', 'المنطقة السابعة', 'المنطقة الثامنة', 'المنطقة التاسعة', 'المنطقة العاشرة',
  'المنطقة الحادية عشرة',
  'الحي الأول', 'الحي الثاني', 'الحي الثالث', 'الحي الرابع', 'الحي الخامس', 'الحي السادس',
  'الحي السابع', 'الحي الثامن', 'الحي التاسع', 'الحي العاشر', 'الحي الحادي عشر',
  'الحي السفارات', 'الحي الدبلوماسي', 'الحي الأول (الأندلس)', 'حي الواحة',
  // شوارع وميادين مدينة نصر
  'عباس العقاد', 'مكرم عبيد', 'مصطفى النحاس', 'شارع الطيران', 'حسن المأمون', 'حسنين هيكل',
  'المربع الفندقي', 'الميرغني', 'النزهة', 'الزهور', 'المحكمة', 'السلام',
  'زهراء مدينة نصر', 'الوفاء والأمل', 'إسكان الشباب', 'المدينة الجامعية',
  'رابعة العدوية', 'الوحدة الوطنية', 'عمارات العبور', 'شينزو آبي', 'طريق الأوتوستراد',
  // مناطق خارج نطاق مدينة نصر
  'التجمع الخامس', 'التجمع الأول', 'الرحاب', 'مدينتي', 'مصر الجديدة', 'هليوبوليس',
  'شيراتون', 'كمبوند دجلة لاند مارك', 'الواحة', 'بنفسج',
];

/** مقارنة نصية بترتيب كود UTF-16 — نفس سلوك Array.prototype.sort الافتراضي بلاه، ولكن بمقارن صريح (SonarCloud S2871). */
function byCodeUnit(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const ZONE_INDEX = KNOWN_ZONES
  .map((name) => ({ name, norm: stripTashkeel(name).replace(/\s+/g, ' ') }))
  .sort((a, b) => b.norm.length - a.norm.length);

/** محرف مسافة (\s في النمط الأصلي) — بلا تعبير نمطي */
const SPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
/** محارف الفصل الأخرى من صنف `[^\s\-–—,(]` */
const ZONE_DELIMITERS = new Set(['-', '–', '—', ',', '(']);

const isSpace = (ch) => SPACE_CHARS.has(ch);
const isZoneDelimiter = (ch) => ch === undefined || isSpace(ch) || ZONE_DELIMITERS.has(ch);

/**
 * «المنطقة/الحي» + أول كلمة أو كلمتين كما كُتبتا في النص، أو null.
 *
 * مكتوبة يدويًا بلا تعبير نمطي متغيّر التراجع (SonarCloud S5852 — تنديد
 * بأداء فوق خطي): تمسح النص من اليسار، وتشترط مسافة بعد الكلمة، وتتوقف
 * عند أول محرف فاصل — نفس دلالات النمط السابق حرفيًا (بما فيها أن أول
 * ظهور في النص هو الفائز، وأن «الحيوية» لا تُعتبر بداية جديدة لأن الحرف بعدها
 * ليس مسافة).
 */
function firstDistrictPhrase(raw) {
  for (let at = 0; at < raw.length; at += 1) {
    for (const head of ['المنطقة', 'الحي']) {
      if (!raw.startsWith(head, at)) continue;
      let i = at + head.length;
      if (!isSpace(raw[i])) continue;
      while (isSpace(raw[i])) i += 1;

      const words = [];
      while (words.length < 2) {
        const start = i;
        while (!isZoneDelimiter(raw[i])) i += 1;
        if (i === start) break;
        words.push(raw.slice(start, i));
        if (!isSpace(raw[i])) break;
        while (isSpace(raw[i])) i += 1;
      }
      if (words.length) return `${head} ${words.join(' ')}`;
    }
  }
  return null;
}

export function deriveZone(location = '') {
  const raw = text(location).trim();
  if (!raw) return null;
  const norm = stripTashkeel(raw).replace(/\s+/g, ' ');

  // 1) اسم منطقة/حي معروف داخل النص (الأطول أولًا لتفادي المطابقات الجزئية)
  for (const z of ZONE_INDEX) {
    if (norm.includes(z.norm)) return z.name;
  }

  // 2) نمط «المنطقة/الحي + الاسم» — نُعيد النص الأصلي كما هو مكتوب
  const district = firstDistrictPhrase(raw);
  if (district) return district;

  // 3) أول مقطع من العنوان (قبل الفاصل) كمنطقة احتياطية
  const head = raw.split(/[-–—,(/]/)[0].trim();
  return head ? head.slice(0, 48) : null;
}

/** تنقية الوصف إلى نص واحد نظيف */
export function cleanDescription(d, fallback = '') {
  // meta_description هو الحقل الذي يحرره المالك للوصف التسويقي القصير؛
  // نستخدمه احتياطيًا لو غاب description (jekyll-seo-tag يقرأ description فقط،
  // لذلك تُضاف نسخة description في الـfront matter للصفحات التسويقية).
  const raw = text(d.description || d.meta_description || fallback);
  return raw.replace(/\s+/g, ' ').trim();
}

function isoDate(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

/**
 * يحوّل ملف front matter إلى كائن عقار موحّد.
 * @param {object} data front matter
 * @param {string} slug اسم الملف بدون .md
 * @param {{siteUrl?:string, baseurl?:string}} opts
 */
export function normalizeProperty(data, slug, opts = {}) {
  const siteUrl = (opts.siteUrl ?? 'https://nasr-realestate.github.io').replace(/\/$/, '');
  const baseurl = opts.baseurl ?? '';
  const frontSlug = text(data.slug).trim() || slug;
  const url = `${siteUrl}${baseurl}/properties/${frontSlug}/`;
  const title = text(data.title).trim();
  const imageFile = text(data.image_file).trim();

  const priceNumeric = derivePrice(data);
  const areaNumeric = deriveArea(data);
  const roomsNumeric = deriveRooms(data);
  const bathsNumeric = deriveBaths(data);
  const transaction = deriveTransaction(data, title);
  const propertyType = derivePropertyType(data, title);

  return {
    id: text(data.id).trim() || frontSlug,
    slug: frontSlug,
    title,
    metaTitle: text(data.meta_title).trim() || title,
    url,
    path: `/properties/${frontSlug}/`,
    transaction,
    propertyType,
    category: text(data.category).trim() || 'apartments',
    location: text(data.location).trim(),
    zone: deriveZone(data.location),
    price: text(data.price).trim(),
    priceNumeric,
    priceIsMonthly: transaction === 'rent',
    currency: 'EGP',
    area: text(data.area).trim(),
    areaNumeric,
    rooms: text(data.rooms).trim(),
    roomsNumeric,
    baths: text(data.bathrooms ?? data.baths).trim(),
    bathsNumeric,
    floor: text(data.floor).trim(),
    finish: text(data.finish).trim(),
    furnished: deriveFurnished(data, title),
    description: cleanDescription(data, title),
    image: imageFile && (!opts.imgDir || fs.existsSync(path.join(opts.imgDir, imageFile)))
      ? `${siteUrl}${baseurl}/assets/img/properties/${imageFile}`
      : null,
    imageFile: imageFile || null,
    audioFile: text(data.audio_file).trim() || null,
    status: text(data.status).trim() || 'available',
    // availability_confirmed_at is optional and must be set from a documented owner confirmation.
    // The publication date is never treated as a verification date.
    last_confirmed_at: isoDate(data.availability_confirmed_at)?.slice(0, 10) ?? null,
    availability_status: isoDate(data.availability_confirmed_at) ? 'confirmed_on_date' : 'needs_confirmation',
    date: isoDate(data.date),
    datePosted: isoDate(data.date)?.slice(0, 10) ?? null,
    // حقول مشتقة مكتوبة صراحةً حتى يعرفها أي مستهلك
    _derived: {
      priceFromText: priceNumeric !== null && !(Number(data.priceNumeric) > 0),
      areaFromText: areaNumeric !== null && !(Number(data.areaNumeric) > 0),
      roomsFromText: roomsNumeric !== null && !(Number(data.roomsNumeric) > 0),
      bathsFromText: bathsNumeric !== null && !(Number(data.bathsNumeric ?? data.bathroomsNumeric) > 0),
    },
  };
}

/** sortKeys: ترتيب ثابت للحقول → diffs نظيفة في git */
export function stableStringify(value, indent = 2) {
  return JSON.stringify(value, null, indent);
}

export function loadProperties(dir = '_properties', opts = {}) {
  if (!fs.existsSync(dir)) return [];
  const defaultImgDir = path.join(path.dirname(path.resolve(dir)), 'assets', 'img', 'properties');
  const resolvedOpts = opts.imgDir !== undefined
    ? opts
    : { ...opts, imgDir: fs.existsSync(defaultImgDir) ? defaultImgDir : null };
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = parseFrontMatter(raw);
    const slug = file.replace(/\.md$/, '');
    // بيانات المصدر: تُمكّن مزامنة D1 من قراءة قائمة الملفات من ai-feed.json
    // في طلب واحد بدل GitHub Tree API (الذي يسقط عند حد المعدل).
    out.push({
      ...normalizeProperty(parsed.data, slug, resolvedOpts),
      // مسار نسبي من جذر المستودع (قابل للقراءة من الـWorker) مهما كان cwd.
      source_path: path.relative(process.cwd(), path.join(dir, file)).split(path.sep).join('/'),
      source_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    });
  }
  out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.slug.localeCompare(b.slug));
  return out;
}

/** إحصاءات السوق المجمّعة — تُستخدم في llms-full.txt و/api/index.json */
export function buildFacets(properties) {
  const count = (keyFn) => {
    const map = new Map();
    for (const p of properties) {
      const k = keyFn(p);
      if (!k) continue;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
  };

  const priceStats = (list) => {
    const nums = list.map((p) => p.priceNumeric).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!nums.length) return null;
    const median = nums.length % 2
      ? nums[(nums.length - 1) / 2]
      : Math.round((nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2);
    return { min: nums[0], max: nums[nums.length - 1], median, count: nums.length };
  };

  const byTypePrice = {};
  for (const type of [...new Set(properties.map((p) => p.propertyType))].sort(byCodeUnit)) {
    const rows = properties.filter((p) => p.propertyType === type);
    byTypePrice[type] = {
      count: rows.length,
      sale: priceStats(rows.filter((p) => p.transaction === 'sale')),
      rent: priceStats(rows.filter((p) => p.transaction === 'rent')),
    };
  }

  return {
    total: properties.length,
    by_transaction: count((p) => p.transaction),
    by_property_type: count((p) => p.propertyType),
    by_zone: count((p) => p.zone),
    by_finish: count((p) => p.finish),
    by_furnished: count((p) => p.furnished),
    price_by_type: byTypePrice,
    overall_sale_price: priceStats(properties.filter((p) => p.transaction === 'sale')),
    overall_rent_price: priceStats(properties.filter((p) => p.transaction === 'rent')),
  };
}
