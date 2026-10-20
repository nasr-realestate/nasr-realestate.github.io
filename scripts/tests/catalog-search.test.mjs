// Tests: نواة البحث العربي (assets/js/catalog-search-core.js) + المعرض المرقّم — 2026-10-20
//
// node --test scripts/tests/catalog-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildListingFacets, catalogPageStubs } from '../lib/listing-facets.mjs';
import { parseFrontMatter } from '../lib/front-matter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// النواة سكربت متصفح عادي (بلا import/export) — نشغّلها في سياق معزول كما يشغّلها المتصفح.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(read('assets/js/catalog-search-core.js'), ctx);
const S = ctx.NasrSearch;
const plain = (x) => JSON.parse(JSON.stringify(x));

// نفس بيانات assets/data/catalog.json لكن مبنية من المصدر مباشرة (بلا Jekyll).
const facets = buildListingFacets(ROOT);
const front = {};
for (const f of fs.readdirSync(path.join(ROOT, '_properties')).filter((x) => x.endsWith('.md'))) {
  const { data } = parseFrontMatter(read(`_properties/${f}`));
  front[String(data.slug || f.replace(/\.md$/, '')).trim()] = data;
}
const ITEMS = facets.catalog.order.map((slug, o) => {
  const f = facets.listings[slug];
  const d = front[slug];
  return S.prepare({ u: `/properties/${slug}/`, t: d.title, l: d.location || 'مدينة نصر', p: d.price, d: f.deal, y: f.type,
    pn: f.price, an: f.area, rn: f.rooms, bn: f.baths, o, i: f.card_image, f: null });
});
const run = (q, ui = {}, sort) => S.search(ITEMS, S.combine(S.parseQuery(q), ui), sort);

test('التطبيع: همزات، ى/ي، ة/ه، تشكيل، تطويل، أرقام عربية وفواصل', () => {
  assert.equal(S.normalize('شَقَّة'), 'شقه');
  assert.equal(S.normalize('أإآٱ'), 'اااا');
  assert.equal(S.normalize('مصطفى'), S.normalize('مصطفي'));
  assert.equal(S.normalize('مـــدينة'), 'مدينه');
  assert.equal(S.normalize('٣ غرف'), '3 غرف');
  assert.equal(S.normalize('۴'), '4');
  assert.equal(S.normalize('٥٬٠٠٠٬٠٠٠'), '5000000');
  assert.equal(S.normalize('5,000,000'), '5000000');
  assert.equal(S.normalize('3,5 مليون'), '3.5 مليون');
  assert.equal(S.normalize('٣٫٥'), '3.5');
  assert.equal(S.normalize('150م²'), '150م2');
});

test('parseAmount: صيغ السعر الشائعة', () => {
  assert.equal(S.parseAmount('5 مليون'), 5000000);
  assert.equal(S.parseAmount('٥ مليون'), 5000000);
  assert.equal(S.parseAmount('2.5 مليون'), 2500000);
  assert.equal(S.parseAmount('مليون ونص'), 1500000);
  assert.equal(S.parseAmount('2 مليون ونص'), 2500000);
  assert.equal(S.parseAmount('20 ألف'), 20000);
  assert.equal(S.parseAmount('5,000,000'), 5000000);
  assert.equal(S.parseAmount('15000 جنيه'), 15000);
  assert.equal(S.parseAmount(''), null);
  assert.equal(S.parseAmount('كلام'), null);
});

test('parseQuery: الاستعلامات الطبيعية المطلوبة', () => {
  let p = S.parseQuery('شقه للبيع');
  assert.equal(p.deal, 'sale'); assert.deepEqual(plain(p.types), ['apartment']); assert.deepEqual(plain(p.text), []);
  p = S.parseQuery('3 غرف');
  assert.deepEqual(plain(p.rooms), { min: 3, max: 3 });
  p = S.parseQuery('شقة 150 متر');
  assert.equal(p.area.approx, 150); assert.ok(p.area.min < 150 && p.area.max > 150);
  p = S.parseQuery('أقل من 5 مليون');
  assert.deepEqual(plain(p.price), { min: null, max: 5000000 });
  p = S.parseQuery('من 2 الى 3 مليون');
  assert.deepEqual(plain(p.price), { min: 2000000, max: 3000000 });
  p = S.parseQuery('إيجار تحت 20 ألف');
  assert.equal(p.deal, 'rent'); assert.deepEqual(plain(p.price), { min: null, max: 20000 });
  p = S.parseQuery('اكبر من 150م');
  assert.deepEqual(plain(p.area), { min: 150, max: null });
  p = S.parseQuery('غرفتين');
  assert.deepEqual(plain(p.rooms), { min: 2, max: 2 });
  p = S.parseQuery('3 غرف او اكثر 2 حمام');
  assert.deepEqual(plain(p.rooms), { min: 3, max: null }); assert.deepEqual(plain(p.baths), { min: 2 });
});

test('parseQuery: ليس كل رقم فلترًا', () => {
  for (const q of ['عمارة 12', 'المنطقة 10', 'برج 7 مكرم عبيد', 'شقة 150']) {
    const p = S.parseQuery(q);
    assert.equal(p.price, null, q); assert.equal(p.area, null, q); assert.equal(p.rooms, null, q);
  }
  // «المنطقة 10» يُترجم إلى الترتيب المكتوب في العناوين
  assert.deepEqual(plain(S.parseQuery('المنطقة 10').text), ['المنطقه', 'العاشره']);
  // رقم كبير بلا وحدة = سعر واضح
  assert.equal(S.parseQuery('5000000').price.approx, 5000000);
});

test('parseQuery: كل ما فُهم يظهر في understood مع نصه الأصلي', () => {
  const p = S.parseQuery('شقه للبيع 3 غرف اقل من 5 مليون');
  assert.deepEqual(plain(p.understood.map((u) => u.kind)).sort(), ['deal', 'price', 'rooms', 'type']);
  for (const u of p.understood) assert.ok(S.normalize('شقه للبيع 3 غرف اقل من 5 مليون').includes(u.src), u.src);
});

test('البحث على البيانات الحقيقية: «شقه» = «شقة»، والهمزة والياء والأرقام', () => {
  const pairs = [['شقه للبيع', 'شقة للبيع'], ['شقة ٣ غرف', 'شقه 3 غرف'], ['إيجار', 'ايجار'],
    ['مصطفى النحاس', 'مصطفي النحاس'], ['عباس العقاد', 'عباس العقّاد'], ['أقل من ٥ مليون', 'اقل من 5 مليون']];
  for (const [a, b] of pairs) {
    const ra = run(a).map((x) => x.u), rb = run(b).map((x) => x.u);
    assert.ok(ra.length > 0, a);
    assert.deepEqual(ra, rb, `${a} ≠ ${b}`);
  }
});

test('النتائج تحترم كل قيد فعلًا', () => {
  for (const it of run('شقه للبيع')) { assert.equal(it.d, 'sale'); assert.equal(it.y, 'apartment'); }
  for (const it of run('3 غرف')) assert.equal(it.rn, 3);
  for (const it of run('اقل من 5 مليون')) { assert.ok(it.pn <= 5000000); assert.equal(it.d, 'sale', 'إيجار شهري لا يطابق سعر مليون'); }
  for (const it of run('ايجار تحت 20 الف')) { assert.equal(it.d, 'rent'); assert.ok(it.pn <= 20000); }
  for (const it of run('شقة 150 متر')) assert.ok(it.an >= 127 && it.an <= 173, String(it.an));
  for (const it of run('مكرم عبيد')) assert.ok(S.normalize(it.t + ' ' + it.l).includes('مكرم'));
  // «بعباس» = «عباس» (حرف جر ملتصق)
  assert.deepEqual(run('محل بعباس العقاد').map((x) => x.u), run('محل عباس العقاد').map((x) => x.u));
});

test('فلاتر الواجهة مع النص: AND، والتعارض يعطي صفرًا لا نتائج خاطئة', () => {
  const r = run('', { deal: 'sale', types: ['apartment'], price: { min: null, max: 5000000 }, rooms: { min: 3, max: null } });
  assert.ok(r.length > 0);
  for (const it of r) { assert.equal(it.d, 'sale'); assert.equal(it.y, 'apartment'); assert.ok(it.pn <= 5000000 && it.rn >= 3); }
  assert.equal(run('للبيع', { deal: 'rent' }).length, 0);
  assert.equal(run('', {}).length, ITEMS.length, 'بلا قيود = كل عقارات مدينة نصر');
});

test('القيم المجهولة: لا تطابق فلترًا رقميًا وتُرتَّب في النهاية', () => {
  const withPrice = ITEMS.filter((x) => x.pn > 0).length;
  assert.equal(run('', { price: { min: 1, max: null } }).length, withPrice);
  const asc = run('', {}, 'price-asc');
  const firstNull = asc.findIndex((x) => !(x.pn > 0));
  if (firstNull !== -1) assert.ok(asc.slice(firstNull).every((x) => !(x.pn > 0)));
  for (let i = 1; i < (firstNull === -1 ? asc.length : firstNull); i += 1) assert.ok(asc[i - 1].pn <= asc[i].pn);
  // «الأحدث» = ترتيب المعرض الثابت في صفحات HTML
  assert.deepEqual(run('', {}, 'newest').map((x) => x.o), ITEMS.map((x) => x.o));
});

test('لا تسرّب خارج النطاق: بيانات البحث والمعرض لعقارات مدينة نصر فقط', () => {
  for (const slug of facets.catalog.order) assert.equal(facets.listings[slug].in_area, true, slug);
  assert.equal(facets.catalog.order.length, facets.totals.in_area);
  for (const q of ['مصر الجديده', 'التجمع', 'الرحاب', 'هليوبوليس']) assert.equal(run(q).length, 0, q);
  assert.match(read('assets/data/catalog.json'), /_facets\.catalog\.order/);
});

test('الترقيم: صفحات HTML ثابتة لكل الشرائح، وكل عقار في صفحة واحدة بالضبط', () => {
  const { per_page: per, total_pages: pages, order } = facets.catalog;
  assert.equal(pages, Math.ceil(order.length / per));
  const stubs = catalogPageStubs(facets);
  assert.equal(stubs.size, pages - 1);
  for (let n = 2; n <= pages; n += 1) {
    const file = `properties/page/${n}.html`;
    assert.equal(read(file), stubs.get(file), `${file} قديم — شغّل build-listing-facets`);
    assert.match(stubs.get(file), new RegExp(`permalink: /properties/page/${n}/`));
  }
  const extra = fs.readdirSync(path.join(ROOT, 'properties/page')).filter((f) => !stubs.has(`properties/page/${f}`));
  assert.deepEqual(extra, []);
  const body = read('_includes/catalog-body.html');
  assert.match(body, /for _slug in _facets\.catalog\.order limit: _per offset: _offset/);
  assert.match(body, /rel="prev"/); assert.match(body, /rel="next"/); assert.match(body, /aria-current="page"/);
  assert.doesNotMatch(body.replace(/{%-?\s*comment[\s\S]*?endcomment\s*-?%}/g, ''), /تحميل المزيد|load more/i);
  assert.match(read('properties.html'), /catalog_page: 1/);
});

test('بطاقة JS تطابق بطاقة Liquid (نفس الأصناف والحقول)', () => {
  const liquid = read('_includes/property-card.html');
  const js = read('assets/js/catalog.js');
  for (const cls of ['pl-card', 'pl-card-img-wrap', 'pl-card-img', 'pl-card-badge', 'pl-card-body', 'pl-card-title',
    'pl-card-specs', 'pl-card-location', 'pl-card-footer', 'pl-card-price', 'pl-card-arrow', 'img-ph']) {
    assert.ok(liquid.includes(cls), `Liquid: ${cls}`);
    assert.ok(js.includes(cls), `JS: ${cls}`);
  }
  for (const s of ['width="400" height="300"', 'loading="lazy"', 'م²', 'غرف', 'حمام', 'للإيجار', 'للبيع']) {
    assert.ok(liquid.includes(s) && js.includes(s), s);
  }
});

test('إمكانية الوصول في المعرض: تسميات، أزرار حالة، إعلان النتائج', () => {
  const body = read('_includes/catalog-body.html');
  for (const id of ['plSearch', 'plSort', 'plPmin', 'plPmax', 'plAmin', 'plAmax', 'plRooms']) {
    assert.match(body, new RegExp(`<label for="${id}"`), id);
  }
  assert.match(body, /role="search"/);
  assert.match(body, /id="plStatus" role="status" aria-live="polite"/);
  const chips = body.match(/class="pl-chip(?: active)?"[^>]*>/g) || [];
  assert.ok(chips.length >= 8);
  for (const c of chips) assert.match(c, /aria-pressed="(true|false)"/);
  assert.match(body, /type="submit"/, 'زر إرسال: Enter يعمل حتى مع عدة حقول');
});
