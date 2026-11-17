// Tests: مولّد صفوف price_snapshots من عروض الموقع
//
// الحاجة (2026-11-17/18): price_snapshots = 39 صفًا، آخر observed_at 2026-10-01،
// صفر صف في 30 يومًا، 15 منطقة من 31 عندها سعر، ولا مسار كتابة في المستودع.
// والموقع ينشر 105 عرضًا صالحًا داخل المدينة.
//
// أخطر ما تمنعه هذه الاختبارات: تلوّث التجميع بوحدات خارج مدينة نصر.
// العطل المقيس: loadProperties() يُرجع scope: null للجميع، فالاعتماد عليه
// كان سيُدخل 12 وحدة (مصر الجديدة، التجمع، الرحاب، مدينتي، هليوبوليس، شيراتون).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCandidates, percentile, confidenceFor, resolveAreaId, normalize,
  inAreaMap, toSql, KNOWN_AREAS, MIN_SAMPLES, MIN_AREA_M2, SOURCE_ID,
} from '../crm/price-snapshot-candidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TODAY = '2026-11-18';
const FACETS = path.join(ROOT, '_data', 'listing_facets.json');

const prop = (o) => ({
  slug: 'x', transaction: 'sale', propertyType: 'apartment', zone: 'المنطقة السادسة',
  priceNumeric: 3_000_000, areaNumeric: 150, furnished: null, scope: null, ...o,
});

const three = [
  prop({ slug: 'a', priceNumeric: 3_000_000 }),
  prop({ slug: 'b', priceNumeric: 3_300_000 }),
  prop({ slug: 'c', priceNumeric: 3_600_000 }),
];

test('النطاق: الوحدات خارج مدينة نصر تُستبعد حتى لو كان scope فارغًا', () => {
  const inArea = inAreaMap(FACETS);
  // معرّفات حقيقية من listing_facets: in_area === false
  for (const slug of ['masr-al-gdida-150m-classic', 'new-polis-130m', 'rehab-villa-model-h-gate9']) {
    assert.equal(inArea(slug), false, `${slug}: لم تُعتبر خارج المدينة`);
  }

  const props = [
    prop({ slug: 'new-polis-130m', zone: 'المنطقة السادسة', priceNumeric: 9_000_000, areaNumeric: 200 }),
    prop({ slug: 'inside', zone: 'المنطقة السادسة' }),
  ];
  const { report } = buildCandidates(props, { today: TODAY, inArea });
  assert.equal(report.skipped.outOfScope, 1);
  assert.deepEqual(report.skipped.outOfScopeSlugs, ['new-polis-130m']);
});

test('النطاق: كل وحدة خارج المدينة في المستودع الفعلي تُستبعد (12)', () => {
  const facets = JSON.parse(fs.readFileSync(FACETS, 'utf8')).listings;
  const outside = Object.entries(facets).filter(([, v]) => v.in_area === false).map(([k]) => k);
  assert.equal(outside.length, 12, 'عدد الوحدات خارج المدينة تغيّر — راجع listing_facets');
  const inArea = inAreaMap(FACETS);
  for (const slug of outside) assert.equal(inArea(slug), false, `${slug}: سُمح بها`);
});

test('لا رقم مُختلق: بلا سعر أو بلا مساحة أو مساحة خطأ ⇒ يُستبعد', () => {
  const { rows, report } = buildCandidates([
    prop({ slug: 'no-price', priceNumeric: 0 }),
    prop({ slug: 'no-area', areaNumeric: 0 }),
    prop({ slug: 'bad-area', areaNumeric: MIN_AREA_M2 - 1 }),
  ], { today: TODAY });
  assert.equal(rows.length, 0);
  assert.equal(report.skipped.noPrice, 1);
  assert.deepEqual(report.skipped.noArea, ['no-area']);
  assert.deepEqual(report.skipped.badArea, ['bad-area']);
});

test(`أقل من ${MIN_SAMPLES} عينات لا يُكتب صفًا — يُسجَّل في التقرير`, () => {
  const two = [prop({ slug: 'a', priceNumeric: 3_000_000 }), prop({ slug: 'b', priceNumeric: 3_300_000 })];
  const { rows, report } = buildCandidates(two, { today: TODAY });
  assert.equal(rows.length, 0, 'كُتب صف من عينتين');
  assert.equal(report.groups_insufficient, 1);
  assert.equal(report.insufficient[0].samples, 2);

  const okRes = buildCandidates(three, { today: TODAY });
  assert.equal(okRes.rows.length, 1, 'ثلاث عينات يجب أن تُكتب');
});

test('الحساب صحيح: median و p25/p75 و min/max و avg من سعر المتر', () => {
  // 150م²: 3.0م ⇒ 20000/م² · 3.75م ⇒ 25000 · 4.5م ⇒ 30000
  const props = [
    prop({ slug: 'a', priceNumeric: 3_000_000, areaNumeric: 150 }),
    prop({ slug: 'b', priceNumeric: 3_750_000, areaNumeric: 150 }),
    prop({ slug: 'c', priceNumeric: 4_500_000, areaNumeric: 150 }),
  ];
  const { rows } = buildCandidates(props, { today: TODAY });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.median_price_m2, 25000);
  assert.equal(r.min_price_m2, 20000);
  assert.equal(r.max_price_m2, 30000);
  assert.equal(r.p25_price_m2, 22500);
  assert.equal(r.p75_price_m2, 27500);
  assert.equal(r.avg_price_m2, 25000);
  assert.equal(r.sample_count, 3);
  assert.equal(r.confidence, 'low');
});

test('المنطقة تُطابق بالمعرّف المعلن ولا تُخترع', () => {
  assert.deepEqual(resolveAreaId('المنطقة السادسة'), { id: 22, name_ar: 'المنطقة السادسة' });
  assert.deepEqual(resolveAreaId('مكرم عبيد'), { id: 29, name_ar: 'ممر مكرم عبيد' });
  assert.deepEqual(resolveAreaId('الحي السابع'), { id: 8, name_ar: 'الحي السابع' });
  assert.equal(resolveAreaId('مصر الجديدة'), null, 'منطقة خارج القائمة يجب أن تُرجع null');
  assert.equal(resolveAreaId(''), null);

  const { report } = buildCandidates([prop({ zone: 'مصر الجديدة' })], { today: TODAY });
  assert.equal(report.skipped.unmatchedArea['مصر الجديدة'], 1);
});

test('التطبيع العربي لا يُنشئ مناطق: «الحى» و«الحي» نفس المنطقة', () => {
  assert.equal(normalize('الحى السابع'), normalize('الحي السابع'));
  assert.equal(resolveAreaId('الحى السابع').id, resolveAreaId('الحي السابع').id);
});

test('معرّفات المناطق فريدة وتطابق ما أعلنه محرّك التقييم (31)', () => {
  assert.equal(KNOWN_AREAS.length, 31);
  assert.equal(new Set(KNOWN_AREAS.map((a) => a.id)).size, 31);
  assert.equal(new Set(KNOWN_AREAS.map((a) => a.name_ar)).size, 31);
  // المعرّفات متصلة 1..31 كما في available_areas
  assert.deepEqual(KNOWN_AREAS.map((a) => a.id), Array.from({ length: 31 }, (_, i) => i + 1));
});

test('idempotent: نفس المدخلات ⇒ نفس المخرجات بالحرف', () => {
  const one = buildCandidates(three, { today: TODAY });
  const two = buildCandidates(three, { today: TODAY });
  assert.deepEqual(one.rows, two.rows);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});

test('--today إلزامي: لا تاريخ من ساعة الجهاز', () => {
  assert.throws(() => buildCandidates([], {}), /today/);
  assert.throws(() => buildCandidates([], { today: '18/11/2026' }), /today/);
  assert.throws(() => buildCandidates([], { today: '2026-11' }), /today/);
});

test('SQL: INSERT فقط، ولا يحمل أي كلمة كتابة أخرى', () => {
  const { rows } = buildCandidates(three, { today: TODAY });
  const sql = toSql(rows);
  assert.match(sql, /^-- INSERT فقط/m);
  assert.equal((sql.match(/INSERT INTO/g) || []).length, rows.length);

  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const forbidden of ['UPDATE ', 'DELETE ', 'DROP ', 'ALTER ']) {
    assert.ok(!statements.includes(forbidden), `SQL يحمل ${forbidden}`);
  }
  // حقن: اسم جدول غير صالح يُرفض
  assert.throws(() => toSql(rows, 'x; DROP TABLE y'), /غير صالح/);
});

test('SQL: علامة اقتباس في النص تُهرَّب ولا تكسر الجملة', () => {
  const { rows } = buildCandidates(three, { today: TODAY });
  // condition_type عمود حقيقي في price_snapshots — نستخدمه للتحقق من التهريب
  const withQuote = [{ ...rows[0], condition_type: "حالة 'خاصة'" }];
  assert.match(toSql(withQuote), /'حالة ''خاصة'''/);
});

test('الفترة والتاريخ من --today لا من بيانات العرض', () => {
  const props = three.map((p) => ({ ...p, date: '2025-01-01' }));
  const { rows } = buildCandidates(props, { today: TODAY });
  assert.equal(rows[0].period, '2026-11');
  assert.equal(rows[0].observed_at, TODAY);
});

test('مصدر الأسعار: source_id=9 ولا ندّعي تحققًا لم يحدث', () => {
  const { rows } = buildCandidates(three, { today: TODAY });
  assert.equal(rows[0].source_id, SOURCE_ID);
  assert.equal(rows[0].price_verified, 0, 'الأسعار أسعار طلب لا صفقات مُتحقَّقة');
});

test('percentile: سلوك الحدود', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
});

test('confidence يطابق إعلان محرّك التقييم', () => {
  assert.equal(confidenceFor(2), 'low');
  assert.equal(confidenceFor(9), 'low');
  assert.equal(confidenceFor(10), 'medium');
  assert.equal(confidenceFor(29), 'medium');
  assert.equal(confidenceFor(30), 'high');
});

test('التشغيل الحقيقي على عروض المستودع: كل صف بمعرّف منطقة معلن', () => {
  const facets = JSON.parse(fs.readFileSync(FACETS, 'utf8')).listings;
  const inArea = inAreaMap(FACETS);
  const props = Object.entries(facets).map(([slug, v]) => ({
    slug, transaction: v.deal, propertyType: v.type, zone: v.zone ?? v.area_name ?? '',
    priceNumeric: v.price, areaNumeric: v.area, furnished: v.furnished, scope: null,
  }));
  const { rows } = buildCandidates(props, { today: TODAY, inArea });
  const ids = new Set(KNOWN_AREAS.map((a) => a.id));
  for (const r of rows) {
    assert.ok(ids.has(r.area_id), `${r.area_name}: معرّف ${r.area_id} غير معلن`);
    assert.ok(r.sample_count >= MIN_SAMPLES);
  }
});
