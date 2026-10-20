/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/lib/listing-facets.mjs — بيانات الواجهة المشتقة لكل عقار (2026-10-20)
 * ───────────────────────────────────────────────────────────────
 *  لماذا؟ كانت الواجهة (الرئيسية، المعرض، العقارات المشابهة) تصنّف العقار
 *  داخل Liquid بقواعد نصية مختلفة في كل صفحة (`title contains "إيجار"` هنا،
 *  و`price contains "شهرياً"` هناك)، ولا تعرف شيئًا عن نطاق مدينة نصر —
 *  فظهرت 12 وحدة في مصر الجديدة والتجمع والرحاب على صفحات «عقارات مدينة نصر».
 *
 *  هذا الملف يجمع مصدرين موجودين ومُختبرين أصلًا، ولا يخترع قواعد جديدة:
 *    • التصنيف (بيع/إيجار، النوع، الأرقام): scripts/lib/properties.mjs
 *      — نفس منطق ai-feed.json و/api.
 *    • النطاق الجغرافي: detectOutOfScope() من Worker المزامنة إلى D1
 *      — نفس السياسة التي تمنع كتابة أي وحدة خارج النطاق في D1، ونفس قائمة
 *        OUT_OF_SCOPE_IDS المعتمدة في deploy-properties-sync.yml.
 *  ويضيف عضوية صفحات الهبوط من _data/landing_segments.json.
 *
 *  المخرج حتمي (بلا طوابع زمنية) حتى يُقارن في CI بالنسخة المحفوظة.
 * ═══════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter } from './front-matter.mjs';
import { normalizeProperty } from './properties.mjs';
import { __test as syncWorker } from '../../_worker/properties-sync-worker.js';

const { detectOutOfScope, normalizeArabic, containsToken } = syncWorker;

/** نص النطاق — نفس الحقول التي يفحصها Worker المزامنة (buildRecord). */
export function scopeText(data, file) {
  return [data.location, data.title, data.description, data.meta_description, file]
    .filter(Boolean)
    .join(' ');
}

/**
 * مطابقة عبارة كاملة على نص الموقع بعد التطبيع العربي — بنفس containsToken
 * الذي يستعمله Worker المزامنة، فتُطابق «لمصطفى النحاس» و«ومصطفى النحاس»
 * ولا تُطابق «مصر للطيران» عند البحث عن «شارع الطيران».
 */
export function locationMatches(location, phrases = []) {
  const hay = ` ${normalizeArabic(location)} `;
  return phrases.some((p) => {
    const needle = normalizeArabic(p);
    return Boolean(needle) && containsToken(hay, needle);
  });
}

export function segmentMembers(listing, location, segments) {
  const out = [];
  if (!listing.in_area) return out; // صفحات الهبوط لمدينة نصر فقط
  for (const seg of segments) {
    if (seg.deal && seg.deal !== listing.deal) continue;
    if (Array.isArray(seg.types) && !seg.types.includes(listing.type)) continue;
    if (Array.isArray(seg.match) && !locationMatches(location, seg.match)) continue;
    out.push(seg.key);
  }
  return out;
}

const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
/**
 * المساحة: أقل من 15م² ليست مساحة وحدة بل خطأ إدخال (مثال حقيقي: area: «4 غرف + 4
 * ريسبشن» → areaNumeric: 4). لا نصحّحها بتخمين؛ نُسقطها من الفلاتر والترتيب فقط.
 */
const plausibleArea = (n) => (positive(n) !== null && n >= 15 ? n : null);

function range(values) {
  const v = values.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? { min: v[0], max: v[v.length - 1] } : null;
}

/**
 * @param {string} root جذر المستودع
 * @returns {{min_listings_for_index:number, totals:object, segments:object, listings:object}}
 */
export function buildListingFacets(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, '_data', 'landing_segments.json'), 'utf8'));
  const segments = config.segments || [];
  const minIndex = Number(config.min_listings_for_index) || 6;
  const perPage = Number(config.catalog_per_page) || 24;
  const dir = path.join(root, '_properties');
  const imgDir = path.join(root, 'assets', 'img', 'properties');

  const listings = {};
  const locations = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const { data } = parseFrontMatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    const norm = normalizeProperty(data, file.replace(/\.md$/, ''));
    const reasons = detectOutOfScope(scopeText(data, file));
    const imageFile = norm.imageFile;
    const original = imageFile && fs.existsSync(path.join(imgDir, imageFile));
    const card = imageFile && fs.existsSync(path.join(imgDir, 'cards', imageFile));
    const listing = {
      id: norm.id,
      in_area: reasons.length === 0,
      out_of_area_reasons: reasons,
      deal: norm.transaction,
      type: norm.propertyType,
      furnished: norm.furnished,
      price: positive(norm.priceNumeric),
      area: plausibleArea(norm.areaNumeric),
      rooms: positive(norm.roomsNumeric),
      baths: positive(norm.bathsNumeric),
      // مصدر صورة البطاقة: النسخة 4:3 إن وُجدت، وإلا الأصل (لا 404 ثم onerror)،
      // وإلا null (عنصر نائب بلا صورة وهمية).
      date: String(data.date || '').slice(0, 10),
      card_image: card ? `/assets/img/properties/cards/${imageFile}` : original ? `/assets/img/properties/${imageFile}` : null,
      image: original ? `/assets/img/properties/${imageFile}` : null,
      segments: [],
    };
    listing.segments = segmentMembers(listing, data.location || '', segments);
    if (listings[norm.slug]) throw new Error(`slug مكرر في _properties: ${norm.slug}`);
    listings[norm.slug] = listing;
    locations[norm.slug] = data.location || '';
  }

  const all = Object.values(listings);
  const inArea = all.filter((l) => l.in_area);
  const segmentStats = {};
  for (const seg of segments) {
    const rows = inArea.filter((l) => l.segments.includes(seg.key));
    const count = (fn) => rows.filter(fn).length;
    segmentStats[seg.key] = {
      count: rows.length,
      indexable: rows.length >= minIndex,
      sale: count((l) => l.deal === 'sale'),
      rent: count((l) => l.deal === 'rent'),
      by_type: Object.fromEntries(
        [...new Set(rows.map((l) => l.type))].sort().map((t) => [t, count((l) => l.type === t)]),
      ),
      sale_price: range(rows.filter((l) => l.deal === 'sale').map((l) => l.price)),
      rent_price: range(rows.filter((l) => l.deal === 'rent').map((l) => l.price)),
      area: range(rows.map((l) => l.area)),
    };
  }

  // ترتيب المعرض الثابت (الأحدث ثم slug) — نفس الترتيب في كل صفحات الترقيم وفي البحث.
  const catalogOrder = Object.keys(listings)
    .filter((slug) => listings[slug].in_area)
    .sort((a, b) => (listings[b].date > listings[a].date ? 1 : listings[b].date < listings[a].date ? -1 : a < b ? -1 : 1));

  // «عقارات مشابهة» حتمية (كانت `sample: 3` عشوائية في كل بناء، تشمل وحدات خارج
  // مدينة نصر، وبصور أصلية ثقيلة بلا أبعاد). المعيار: نفس المعاملة إلزامي، ثم نفس
  // النوع، ثم نفس المنطقة (صفحة هبوط مشتركة)، ثم أقرب سعر، ثم ترتيب المعرض.
  const orderIndex = new Map(catalogOrder.map((slug, i) => [slug, i]));
  const areaKeys = new Set(segments.filter((s) => Array.isArray(s.match)).map((s) => s.key));
  for (const [slug, l] of Object.entries(listings)) {
    const myAreas = l.segments.filter((k) => areaKeys.has(k));
    const myArea = myAreas.length ? myAreas : segmentMembers({ ...l, in_area: true }, locations[slug], segments).filter((k) => areaKeys.has(k));
    const priceGap = (o) => (l.price && o.price ? Math.abs(Math.log(o.price / l.price)) : Infinity);
    l.related = catalogOrder
      .filter((s) => s !== slug && listings[s].deal === l.deal)
      .map((s) => ({ s, o: listings[s] }))
      .sort((a, b) => (
        (Number(b.o.type === l.type) - Number(a.o.type === l.type)) ||
        (Number(b.o.segments.some((k) => myArea.includes(k))) - Number(a.o.segments.some((k) => myArea.includes(k)))) ||
        (priceGap(a.o) - priceGap(b.o)) ||
        (orderIndex.get(a.s) - orderIndex.get(b.s))
      ))
      .slice(0, 3)
      .map((x) => x.s);
  }

  return {
    _comment: 'مولّد آليًا — لا تعدّله يدويًا. node scripts/build-listing-facets.mjs',
    min_listings_for_index: minIndex,
    totals: {
      all: all.length,
      in_area: inArea.length,
      out_of_area: all.length - inArea.length,
      in_area_sale: inArea.filter((l) => l.deal === 'sale').length,
      in_area_rent: inArea.filter((l) => l.deal === 'rent').length,
    },
    catalog: {
      per_page: perPage,
      total_pages: Math.max(1, Math.ceil(catalogOrder.length / perPage)),
      order: catalogOrder,
    },
    out_of_area_slugs: Object.keys(listings).filter((s) => !listings[s].in_area).sort(),
    segments: segmentStats,
    listings,
  };
}

export function renderListingFacets(root) {
  return `${JSON.stringify(buildListingFacets(root), null, 2)}\n`;
}

/**
 * صفحات الترقيم الثابتة /properties/page/N/ (N ≥ 2). Jekyll على GitHub Pages لا
 * يرقّم المجموعات (jekyll-paginate للتدوينات فقط ولا إضافات مخصصة)، فنولّد
 * ملفات قصيرة يعرض كل منها شريحة من catalog.order عبر _includes/catalog-body.html.
 * @returns {Map<string,string>} مسار نسبي ← محتوى
 */
export function catalogPageStubs(facets) {
  const out = new Map();
  const total = facets.catalog.total_pages;
  for (let n = 2; n <= total; n += 1) {
    out.set(`properties/page/${n}.html`, [
      '---',
      '# مولّد آليًا — node scripts/build-listing-facets.mjs (لا تعدّله يدويًا)',
      'layout: default',
      'body_class: page-properties',
      `title: "معرض عقارات مدينة نصر — صفحة ${n} من ${total}"`,
      `description: "صفحة ${n} من ${total} في معرض سمسار طلبك: شقق ومحلات ومكاتب للبيع والإيجار داخل مدينة نصر، بالسعر والمساحة والموقع لكل عرض."`,
      `permalink: /properties/page/${n}/`,
      'image: "/assets/img/social-properties.png"',
      'hide_navbar: true',
      `catalog_page: ${n}`,
      '---',
      '{% include schema-catalog.html %}',
      '{% include catalog-body.html %}',
      '',
    ].join('\n'));
  }
  return out;
}

const arNum = (n) => Number(n).toLocaleString('en-US');
function fmtEGP(v) {
  if (v >= 1e6) return `${(Math.round(v / 1e4) / 100).toString()} مليون`;
  if (v >= 1e3) return `${arNum(Math.round(v / 1e3))} ألف`;
  return arNum(v);
}
const offersAr = (n) => (n === 1 ? 'عرض واحد' : n === 2 ? 'عرضان' : n <= 10 ? `${n} عروض` : `${n} عرضًا`);

/** وصف ميتا من الأرقام الفعلية فقط (لا صياغة تسويقية بلا مصدر). */
export function landingDescription(seg, st) {
  const place = seg.kind === 'area' ? `${seg.short}، مدينة نصر` : 'مدينة نصر';
  const parts = [`${offersAr(st.count)} ${seg.kind === 'area' ? 'في' : 'من'} ${seg.kind === 'area' ? place : seg.short + ' في ' + place}`];
  if (st.sale && st.rent) parts[0] += ` (${st.sale} للبيع و${st.rent} للإيجار)`;
  const bits = [];
  if (st.sale_price) bits.push(st.sale_price.min === st.sale_price.max ? `البيع ${fmtEGP(st.sale_price.min)} ج.م` : `البيع من ${fmtEGP(st.sale_price.min)} إلى ${fmtEGP(st.sale_price.max)} ج.م`);
  if (st.rent_price) bits.push(st.rent_price.min === st.rent_price.max ? `الإيجار ${fmtEGP(st.rent_price.min)} ج.م شهريًا` : `الإيجار من ${fmtEGP(st.rent_price.min)} إلى ${fmtEGP(st.rent_price.max)} ج.م شهريًا`);
  if (st.area) bits.push(st.area.min === st.area.max ? `مساحة ${st.area.min} م²` : `مساحات من ${st.area.min} إلى ${st.area.max} م²`);
  return `${parts[0]}. ${bits.join('، ')}. الأسعار كما أعلنها الملاك — تواصل مع طارق طنطاوي.`;
}

const TYPE_PLURAL = { apartment: 'شقق', villa: 'دوبلكس/فيلات', shop: 'محلات', office: 'مكاتب وإداري', clinic: 'عيادات', warehouse: 'مخازن' };
const fmtRange = (r, unit) => (r.min === r.max ? `${fmtEGP(r.min)} ${unit}` : `من ${fmtEGP(r.min)} إلى ${fmtEGP(r.max)} ${unit}`);

/** حقائق الصفحة — كلها محسوبة من العروض المنشورة الآن، لا شيء مكتوب يدويًا. */
export function landingFacts(st) {
  const facts = [['العروض المنشورة', st.sale && st.rent ? `${st.count} (${st.sale} للبيع، ${st.rent} للإيجار)` : String(st.count)]];
  if (st.sale_price) facts.push(['أسعار البيع المعلنة', fmtRange(st.sale_price, 'ج.م')]);
  if (st.rent_price) facts.push(['الإيجار الشهري المعلن', fmtRange(st.rent_price, 'ج.م')]);
  if (st.area) facts.push(['المساحات', st.area.min === st.area.max ? `${st.area.min} م²` : `من ${st.area.min} إلى ${st.area.max} م²`]);
  const types = Object.entries(st.by_type || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (types.length > 1) facts.push(['الأنواع', types.map(([t, n]) => `${TYPE_PLURAL[t] || t}: ${n}`).join(' · ')]);
  return facts;
}

export function landingIntro(seg) {
  if (seg.kind === 'area') {
    return `العروض المنشورة لدى سمسار طلبك التي يذكر عنوانها المعلن ${seg.match.join(' أو ')} داخل مدينة نصر، مرتبة من الأحدث، بالسعر والمساحة وعدد الغرف كما أعلنها المالك.`;
  }
  const what = seg.deal === 'sale' ? 'الشقق والدوبلكسات المعروضة للبيع' : seg.deal === 'rent' ? 'الشقق المعروضة للإيجار' : 'المحلات والمكاتب والمقرات الإدارية المعروضة للبيع والإيجار';
  return `كل ${what} داخل مدينة نصر لدى سمسار طلبك في صفحة واحدة، مرتبة من الأحدث، بالسعر والمساحة${seg.deal === 'rent' || seg.deal === 'sale' ? ' وعدد الغرف' : ''} كما أعلنها المالك.`;
}

export function landingTitle(seg) {
  return seg.title || (seg.kind === 'area' ? `${seg.name} للبيع والإيجار — مدينة نصر` : `${seg.name} — عروض بالسعر والمساحة`);
}

/**
 * صفحات الهبوط properties/<key>.html — تُولَّد من _data/landing_segments.json والأرقام الحالية.
 * أقل من min_listings_for_index ← noindex + خارج sitemap تلقائيًا (لا صفحات رقيقة مفهرسة).
 */
export function landingPageStubs(facets, segments) {
  const out = new Map();
  for (const seg of segments) {
    const st = facets.segments[seg.key];
    const q = (v) => JSON.stringify(v);
    const lines = [
      '---',
      '# مولّد آليًا — node scripts/build-listing-facets.mjs (لا تعدّله يدويًا؛ عدّل _data/landing_segments.json)',
      'layout: landing',
      'body_class: page-properties page-landing',
      `title: ${q(landingTitle(seg))}`,
      `description: ${q(landingDescription(seg, st))}`,
      `permalink: ${seg.path}`,
      'image: "/assets/img/social-properties.png"',
      'hide_navbar: true',
      `landing_key: ${seg.key}`,
      `landing_intro: ${q(landingIntro(seg))}`,
      'landing_facts:',
      ...landingFacts(st).map(([k, v]) => `  - { label: ${q(k)}, value: ${q(v)} }`),
    ];
    if (!st.indexable) lines.push('sitemap: false', 'robots: "noindex, follow"');
    lines.push('---', '');
    out.set(`properties/${seg.key}.html`, lines.join('\n'));
  }
  return out;
}
