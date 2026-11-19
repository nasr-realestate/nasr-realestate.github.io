#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/crm/price-snapshot-candidates.mjs
 *  مولّد صفوف price_snapshots من عروض الموقع المنشورة
 * ───────────────────────────────────────────────────────────────
 *  السبب (مقيس من القاعدة الحقيقية، run 44197828562):
 *    price_snapshots = 39 صفًا · آخر observed_at = 2026-10-01 ·
 *    صفر صف في آخر 30 يومًا · 15 منطقة من 31 عندها سعر ·
 *    ولا مسار كتابة واحد في هذا المستودع.
 *    والموقع ينشر 105 عرضًا صالحًا داخل مدينة نصر — ثلاثة أضعاف الجدول.
 *
 *  هذا الملف يُنتج الصفوف فقط. **لا يكتب على أي قاعدة.**
 *  المخرَج: JSON للمراجعة + ملف .sql فيه INSERT فقط.
 *
 *  ⚠️ الفخ الذي أوقع الفريق قبلًا: loadProperties() يُرجع scope = null
 *     لكل عرض. الاعتماد عليه أَدخل 12 وحدة خارج مدينة نصر (مصر الجديدة،
 *     التجمع، الرحاب، مدينتي، هليوبوليس، شيراتون) في التجميع — أي أن
 *     «سعر مدينة نصر» كان سيُحسب من أسيوط. النطاق هنا يأتي حصرًا من
 *     _data/listing_facets.json → listings[slug].in_area.
 *
 *  ⚠️ قاعدة لا أرقام مُختلقة: الحقل الغائب null لا صفرًا،
 *     ولا وسيط من أقل من 3 عينات (MIN_SAMPLES).
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** أقل عدد عينات يُسمح منه بحساب وسيط — نفس إعلان محرّك التقييم. */
export const MIN_SAMPLES = 3;
/** أقل مساحة وحدة معقولة — أقل منها خطأ إدخال لا مساحة (نفس قاعدة الواجهة). */
export const MIN_AREA_M2 = 15;
/** مصدر الأسعار: «سمسار طلبك» كما يعلن محرّك التقييم. */
export const SOURCE_ID = 9;

/**
 * المناطق الـ31 كما يعلنها محرّك التقييم الحقيقي (v6.2، available_areas).
 * المعرّفات مُقيسة من الـworker لا مُختلقة — أي صف بمعرّف غير موجود هنا
 * سيُرفض من القاعدة (FOREIGN KEY area_id → areas.id).
 */
export const KNOWN_AREAS = [
  [1, 'مدينة نصر (ككل)', 'مدينة نصر'],
  [2, 'الحي الأول'], [3, 'الحي الثاني'], [4, 'الحي الثالث'], [5, 'الحي الرابع'],
  [6, 'الحي الخامس'], [7, 'الحي السادس'], [8, 'الحي السابع'], [9, 'الحي الثامن'],
  [10, 'الحي التاسع'], [11, 'الحي العاشر'], [12, 'الحي الحادي عشر'], [13, 'الحي الثاني عشر'],
  [14, 'الحي الدبلوماسي'], [15, 'الواحة'], [16, 'زهراء مدينة نصر'],
  [17, 'المنطقة الأولى'], [18, 'المنطقة الثانية'], [19, 'المنطقة الثالثة'], [20, 'المنطقة الرابعة'],
  [21, 'المنطقة الخامسة'], [22, 'المنطقة السادسة'], [23, 'المنطقة السابعة'], [24, 'المنطقة الثامنة'],
  [25, 'المنطقة التاسعة'], [26, 'المنطقة العاشرة'], [27, 'المنطقة الحادية عشرة'], [28, 'المنطقة الثانية عشرة'],
  [29, 'ممر مكرم عبيد'], [30, 'ممر عباس العقاد'], [31, 'رابعة العدوية'],
].map(([id, name_ar, alias]) => ({ id, name_ar, alias }));

/**
 * بدائل كتابة يقبلها المنطق — لا تُنشئ مناطق جديدة، بل تُقرب النص إلى
 * اسم معلن. مفتاح البحث مُطبَّع بـnormalize()، والقيمة هي name_ar الرسمي.
 */
export const ZONE_ALIASES = {
  'الحى الاول': 'الحي الأول', 'الحي 1': 'الحي الأول',
  'الحى الثانى': 'الحي الثاني', 'الحي 2': 'الحي الثاني',
  'الحى الثالث': 'الحي الثالث', 'الحي 3': 'الحي الثالث',
  'الحى الرابع': 'الحي الرابع', 'الحي 4': 'الحي الرابع',
  'الحى الخامس': 'الحي الخامس', 'الحي 5': 'الحي الخامس',
  'الحى السادس': 'الحي السادس', 'الحي 6': 'الحي السادس',
  'الحى السابع': 'الحي السابع', 'الحي 7': 'الحي السابع',
  'الحى الثامن': 'الحي الثامن', 'الحي 8': 'الحي الثامن',
  'الحى التاسع': 'الحي التاسع', 'الحي 9': 'الحي التاسع',
  'الحى العاشر': 'الحي العاشر', 'الحي 10': 'الحي العاشر',
  'مكرم عبيد': 'ممر مكرم عبيد', 'عباس العقاد': 'ممر عباس العقاد',
  'عباس الاكاد': 'ممر عباس العقاد', 'رابعه العدويه': 'رابعة العدوية',
  'زهراء مدينه نصر': 'زهراء مدينة نصر', 'الزهراء': 'زهراء مدينة نصر',
};

/** تطبيع نص عربي للمقارنة: تشكيل، أ/إ→ا، ى→ي، ة→ه، مسافات. */
export function normalize(input) {
  return String(input ?? '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\s+/g, ' ')
    .trim();
}

const AREA_LOOKUP = new Map();
for (const a of KNOWN_AREAS) {
  AREA_LOOKUP.set(normalize(a.name_ar), a);
  if (a.alias) AREA_LOOKUP.set(normalize(a.alias), a);
}
for (const [from, to] of Object.entries(ZONE_ALIASES)) {
  const target = KNOWN_AREAS.find((a) => a.name_ar === to);
  if (target) AREA_LOOKUP.set(normalize(from), target);
}

/**
 * خريطة مناطق قابلة للاستبدال. الافتراضي هو الـ31 المُعلنة في محرّك التقييم.
 * بعد إضافة شوارع إلى جدول areas تُمرَّر الخريطة الحقيقية من القاعدة عبر
 * `--areas-json`، لأن المعرّفات تمنحها AUTOINCREMENT ولا يجوز اختراعها.
 */
let areaLookup = AREA_LOOKUP;
let areaPatterns = [];

/** يستبدل خريطة المناطق بخريطة مقروءة من القاعدة. الاختبارات تستخدمه أيضًا. */
export function useAreas(areas) {
  const lookup = new Map();
  for (const a of areas) {
    if (!a || a.id === undefined || a.id === null) continue;
    const entry = { id: Number(a.id), name_ar: a.name_ar || a.name };
    if (!entry.name_ar) continue;
    lookup.set(normalize(entry.name_ar), entry);
    if (a.alias) lookup.set(normalize(a.alias), entry);
  }
  // البدائل المُعلنة في الكود تبقى فعّالة: الخريطة القادمة من القاعدة تحمل
  // الأسماء الرسمية فقط، وبدون هذا السطر تختفي «مكرم عبيد» ⇒ «ممر مكرم عبيد»
  // وتسقط عروضها من التجميع (عيب مقيس: فقدنا صفَّين عند أول اختبار).
  for (const [alias, canonical] of Object.entries(ZONE_ALIASES)) {
    const target = areas.find((a) => a && (a.name_ar || a.name) === canonical);
    if (target && target.id !== undefined && target.id !== null) {
      lookup.set(normalize(alias), { id: Number(target.id), name_ar: target.name_ar || target.name });
    }
  }
  areaLookup = lookup;
  // أنماط المطابقة: صفوف فيها zone_patterns تُطابق بالاحتواء لا بالتساوي.
  areaPatterns = areas
    .filter((a) => a && a.zone_patterns && a.id !== undefined && a.id !== null)
    .map((a) => ({
      id: Number(a.id),
      name_ar: a.name_ar || a.name,
      patterns: String(a.zone_patterns).split('|').map(normalize).filter(Boolean),
    }));
}

/**
 * يحوّل نص منطقة من عرض إلى {id, name_ar} معلن، أو null.
 * لا يختلق معرّفًا: «مصر الجديدة» تُرجع null لا منطقة قريبة.
 * الترتيب: مطابقة تامة بالاسم ⇒ مطابقة بنمط مُعلن في القاعدة.
 */
export function resolveAreaId(zone) {
  const exact = areaLookup.get(normalize(zone));
  if (exact) return { id: exact.id, name_ar: exact.name_ar };

  const key = normalize(zone);
  if (!key) return null;
  for (const p of areaPatterns) {
    if (p.patterns.some((pat) => key.includes(pat))) {
      return { id: p.id, name_ar: p.name_ar };
    }
  }
  return null;
}

/**
 * يقرأ _data/listing_facets.json ويُعيد دالة (slug) => in_area.
 * هذه هي بوابة النطاق الصحيحة — لا p.scope ولا in_nasr_city.
 */
export function inAreaMap(facetsPath = path.join(ROOT, '_data', 'listing_facets.json')) {
  const raw = JSON.parse(fs.readFileSync(facetsPath, 'utf8'));
  const listings = raw.listings ?? {};
  // غياب العلم = داخل المدينة (الافتراضي في المولّد)، لكن false صريح يُستبعد.
  return (slug) => listings[slug]?.in_area !== false;
}

/** وسيط/مئين بطريقة الاستيفاء الخطي. [] ⇒ null (لا صفر مخترع). */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** تقريب لخانتين — يمنع فروقًا وهمية بين تشغيلين. */
export function round2(n) {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}

/** نفس عتبات محرّك التقييم المعلنة في api_contract. */
export function confidenceFor(n) {
  if (n >= 30) return 'high';
  if (n >= 10) return 'medium';
  return 'low';
}

/** نوع الحالة (مفروش/غير مفروش) إن وُجد — جزء من مفتاح التجميع. */
function conditionOf(p) {
  const f = p.furnished;
  if (f === null || f === undefined || f === '') return null;
  if (f === true || f === 'true' || f === 'furnished' || f === 'مفروش') return 'furnished';
  if (f === false || f === 'false' || f === 'unfurnished' || f === 'غير مفروش') return 'unfurnished';
  return null;
}

/**
 * سبب الاستبعاد، أو null إذا كان العرض صالحًا للتجميع.
 * دالة منفصلة لتبقى الحلقة الرئيسية بسيطة وقابلة للقراءة.
 */
function skipReason(p, isInArea) {
  if (p.scope === 'archive' || p.in_nasr_city === false || !isInArea(p.slug)) return 'outOfScope';
  if (!p.propertyType || !p.transaction) return 'badRow';
  const price = Number(p.priceNumeric);
  const area = Number(p.areaNumeric);
  if (!Number.isFinite(price) || price <= 0) return 'noPrice';
  if (!Number.isFinite(area) || area <= 0) return 'noArea';
  if (area < MIN_AREA_M2) return 'badArea';
  return null;
}

function recordSkip(skipped, reason, p) {
  if (reason === 'noPrice') { skipped.noPrice++; return; }
  if (reason === 'badArea') { skipped.badArea.push(p.slug); return; }
  if (reason === 'noArea') { skipped.noArea.push(p.slug); return; }
  if (reason === 'badRow') { skipped.badRow.push(p.slug); return; }
  skipped.outOfScope++;
  skipped.outOfScopeSlugs.push(p.slug);
}

/** يجمّع سعر المتر لكل (منطقة × نوع × غرض × حالة). */
function collectGroups(properties, isInArea) {
  const grouped = new Map();
  const skipped = {
    noPrice: 0, noArea: [], badArea: [], badRow: [],
    unmatchedArea: {}, outOfScope: 0, outOfScopeSlugs: [],
  };
  const used = new Set();

  for (const p of properties) {
    const reason = skipReason(p, isInArea);
    if (reason) { recordSkip(skipped, reason, p); continue; }

    const hit = resolveAreaId(p.zone);
    if (!hit) {
      const k = p.zone || '(بلا منطقة)';
      skipped.unmatchedArea[k] = (skipped.unmatchedArea[k] || 0) + 1;
      continue;
    }

    const condition = conditionOf(p);
    const key = [hit.id, p.propertyType, p.transaction, condition ?? '-'].join('|');
    if (!grouped.has(key)) {
      grouped.set(key, {
        area_id: hit.id,
        area_name: hit.name_ar,
        property_type: p.propertyType,
        transaction_type: p.transaction,
        condition_type: condition,
        perM2: [],
      });
    }
    grouped.get(key).perM2.push(Number(p.priceNumeric) / Number(p.areaNumeric));
    used.add(p.slug);
  }
  return { grouped, skipped, used };
}

function summarizeGroup(g, samples) {
  return {
    area_id: g.area_id,
    area_name: g.area_name,
    property_type: g.property_type,
    transaction_type: g.transaction_type,
    condition_type: g.condition_type,
    samples,
  };
}

function rowFromGroup(g, sorted, today) {
  return {
    ...summarizeGroup(g, sorted.length),
    median_price_m2: round2(percentile(sorted, 0.5)),
    p25_price_m2: round2(percentile(sorted, 0.25)),
    p75_price_m2: round2(percentile(sorted, 0.75)),
    min_price_m2: round2(sorted[0]),
    max_price_m2: round2(sorted[sorted.length - 1]),
    avg_price_m2: round2(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    sample_count: sorted.length,
    confidence: confidenceFor(sorted.length),
    period: today.slice(0, 7),
    observed_at: today,
    source_id: SOURCE_ID,
    source_verified: 1,
    // الأسعار أسعار طلب لا صفقات مُتحقَّقة — يبقى العلم 0 حتى تُتحقق.
    price_verified: 0,
  };
}

/**
 * يبني الصفوف المرشحة. دالة نقية: نفس المدخلات ⇒ نفس المخرجات.
 * @param {Array} properties عروض بحقول: slug, transaction, propertyType, zone,
 *   priceNumeric, areaNumeric, furnished
 * @param {{today:string, inArea?:(slug:string)=>boolean}} opts
 */
export function buildCandidates(properties, { today, inArea } = {}) {
  const isInArea = typeof inArea === 'function' ? inArea : () => true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))) {
    throw new Error('مطلوب --today بصيغة YYYY-MM-DD (لا يُشتق من ساعة الجهاز)');
  }

  const { grouped, skipped, used } = collectGroups(properties, isInArea);

  const rows = [];
  const insufficient = [];
  for (const g of grouped.values()) {
    const sorted = [...g.perM2].sort((a, b) => a - b);
    if (sorted.length < MIN_SAMPLES) {
      insufficient.push(summarizeGroup(g, sorted.length));
      continue;
    }
    rows.push(rowFromGroup(g, sorted, today));
  }
  rows.sort((a, b) => (
    a.area_id - b.area_id
    || a.property_type.localeCompare(b.property_type)
    || a.transaction_type.localeCompare(b.transaction_type)
  ));

  return {
    today,
    rows,
    report: {
      listings_total: properties.length,
      listings_used: used.size,
      groups_total: grouped.size,
      groups_written: rows.length,
      groups_insufficient: insufficient.length,
      insufficient,
      skipped,
      min_samples: MIN_SAMPLES,
    },
  };
}

/** SQL بصلاحية INSERT فقط. لا يُنفَّذ هنا — يُكتب ملفًا للمراجعة قبل أي تنفيذ. */
export function toSql(rows, table = 'price_snapshots') {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('اسم جدول غير صالح');
  const cols = [
    'area_id', 'property_type', 'transaction_type', 'condition_type',
    'median_price_m2', 'p25_price_m2', 'p75_price_m2', 'min_price_m2',
    'max_price_m2', 'avg_price_m2', 'sample_count', 'confidence', 'period',
    'observed_at', 'source_id', 'source_verified', 'price_verified',
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const lines = ['-- INSERT فقط — لا UPDATE ولا DELETE. للمراجعة قبل أي تنفيذ.'];
  for (const r of rows) {
    lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => esc(r[c])).join(', ')});`);
  }
  return `${lines.join('\n')}\n`;
}

/* ─────────────────────────── CLI ─────────────────────────── */
const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const today = arg('today');
  if (!today) {
    console.error('✗ مطلوب --today YYYY-MM-DD (لا نشتق التاريخ من ساعة الجهاز — التقرير يجب أن يكون قابلًا لإعادة الإنتاج)');
    process.exit(2);
  }

  const areasJson = arg('areas-json');
  if (areasJson) {
    // الخريطة الحقيقية من القاعدة — المعرّفات تأتي منها لا من رمز مكتوب.
    const areaRows = JSON.parse(fs.readFileSync(path.resolve(areasJson), 'utf8'));
    const rowsArr = Array.isArray(areaRows) ? areaRows : (areaRows.areas ?? areaRows.result ?? []);
    useAreas(rowsArr);
    console.log(`  المناطق: ${rowsArr.length} من ${areasJson}`);
  }

  const { loadProperties } = await import('../lib/properties.mjs');
  const properties = loadProperties(path.join(ROOT, '_properties'));
  const inArea = inAreaMap();

  const candidates = buildCandidates(properties, { today, inArea });
  const r = candidates.report;

  console.log(`[price-snapshots] ${candidates.rows.length} صفًا من ${r.listings_used} عرضًا (من ${r.listings_total})`);
  console.log(`  تركيبات: ${r.groups_total} · تُكتب: ${r.groups_written} · أقل من ${r.min_samples} عينات: ${r.groups_insufficient}`);
  console.log(`  مستبعد: خارج المدينة ${r.skipped.outOfScope} · بلا سعر ${r.skipped.noPrice} · بلا مساحة ${r.skipped.noArea.length} · مساحة خطأ ${r.skipped.badArea.length} · منطقة غير مطابقة ${Object.keys(r.skipped.unmatchedArea).length}`);

  const jsonOut = arg('json-out');
  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');
    console.log(`  JSON: ${jsonOut}`);
  }

  const sqlOut = arg('sql-out');
  if (sqlOut) {
    fs.mkdirSync(path.dirname(path.resolve(sqlOut)), { recursive: true });
    fs.writeFileSync(path.resolve(sqlOut), toSql(candidates.rows), 'utf8');
    console.log(`  SQL: ${sqlOut} (${candidates.rows.length} INSERT — للمراجعة فقط)`);
  }

  if (!candidates.rows.length) process.exitCode = 1;
}
