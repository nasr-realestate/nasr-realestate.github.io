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
    out_of_area_slugs: Object.keys(listings).filter((s) => !listings[s].in_area).sort(),
    segments: segmentStats,
    listings,
  };
}

export function renderListingFacets(root) {
  return `${JSON.stringify(buildListingFacets(root), null, 2)}\n`;
}
