// Tests: طبقة الاكتشاف الآلي — فهرس المطابقة الخفيف
//
// القياس الذي أوجد هذه الاختبارات (2026-11-17):
//   api/properties.json = 240,098 B · ai-feed.json = 230,640 B
//   shortlist.json      =  34,711 B  ← 7× أصغر، وصفر وصف
//
// الفكرة: وكيل يجيب عن «شقة في المنطقة السادسة تحت ٦ مليون» لا يحتاج
// الكتالوج كله. هذه الاختبارات تمنع أن يعود الفهرس ثقيلًا، أو أن يتسرّب
// إليه عقار خارج مدينة نصر، أو أن يُخترع رقم مكان رقم غائب.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderShortlist } from '../lib/ai-docs.mjs';
import { loadProperties } from '../lib/properties.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const properties = loadProperties(path.join(ROOT, '_properties'));

/** نفس ختم النطاق الذي يطبّقه build-ai-artifacts قبل بناء الفهرس. */
function stamped() {
  const flags = JSON.parse(fs.readFileSync(path.join(ROOT, '_data', 'listing_facets.json'), 'utf8')).listings;
  return properties.map((p) => {
    const l = flags[p.slug];
    const archive = !!(l && l.in_area === false);
    return { ...p, in_nasr_city: archive ? false : p.in_nasr_city, scope: archive ? 'archive' : 'city' };
  });
}

const built = () => renderShortlist(stamped(), { stamp: '2026-11-17T00:00:00.000Z' });

test('الفهرس لا يُدرج أي وحدة خارج مدينة نصر', () => {
  const flags = JSON.parse(fs.readFileSync(path.join(ROOT, '_data', 'listing_facets.json'), 'utf8')).listings;
  const list = built();
  const leaked = list.properties.filter((p) => flags[p.id] && flags[p.id].in_area === false);
  assert.deepEqual(leaked.map((p) => p.id), [], 'وحدة خارج النطاق تسرّبت إلى فهرس الترشيح');
  assert.equal(list.total_count + list.withheld_out_of_scope, properties.length);
});

test('الحقل الغائب يُحذف ولا يُكتب صفرًا', () => {
  const list = built();
  for (const row of list.properties) {
    for (const key of ['p', 'a', 'r', 'b']) {
      if (key in row) assert.ok(Number(row[key]) > 0, `صف ${row.id}: ${key}=${row[key]} — الصفر يعني «لا سعر» وهو تضليل`);
    }
  }
  // هناك وحدات فعلية بلا سعر معلن — يجب أن تظهر بلا الحقل p لا بصفر.
  const noPrice = list.properties.filter((r) => !('p' in r));
  assert.ok(noPrice.length > 0, 'لا توجد أي وحدة بلا سعر — الاختبار فقد حالته');
  assert.equal(noPrice.filter((r) => r.p === 0).length, 0);
});

test('كل صف يحمل رابطًا مطلقًا قابلًا للاستشهاد', () => {
  for (const row of built().properties) {
    assert.match(row.u, /^https:\/\/nasr-realestate\.github\.io\/properties\/[^/]+\/$/, `رابط غير مطلق: ${row.u}`);
  }
});

test('مساحة أقل من 15م² تُسقط من الفهرس بدل نشر خطأ إدخال', () => {
  const list = renderShortlist(
    [{ slug: 'bad-area', url: 'https://x/p/bad-area/', transaction: 'sale', propertyType: 'apartment', areaNumeric: 4, priceNumeric: 1, scope: 'city' }],
    { stamp: '2026-11-17T00:00:00.000Z' },
  );
  assert.equal('a' in list.properties[0], false);
});

test('المفروش وحده يحمل f=1، وغير المفروش لا يحمله', () => {
  const rows = built().properties;
  const furnished = rows.filter((r) => r.f === 1);
  assert.ok(furnished.length > 0, 'لا توجد وحدات مفروشة في الفهرس — الاختبار فقد حالته');
  for (const row of furnished) {
    const src = properties.find((p) => p.slug === row.id);
    assert.equal(src.furnished, 'furnished', `${row.id}: f=1 لوحدة غير مفروشة`);
  }
});

test('الفهرس أخف من ثلث الكتالوج الكامل — وإلا فقد سبب وجوده', () => {
  // حدود صريحة: الكتالوج الكامل ~240KB لـ116 وحدة. صف الفهرس ~330 بايت.
  const list = built();
  const bytes = Buffer.byteLength(JSON.stringify(list));
  const perUnit = bytes / Math.max(list.properties.length, 1);
  assert.ok(perUnit < 500, `الصف الواحد ${Math.round(perUnit)} بايت — الفهرس توقف عن كونه خفيفًا`);
  assert.ok(!JSON.stringify(list).includes('description'), 'وصف نصي تسرّب إلى فهرس الترشيح');
});

test('الترتيب من الأحدث — الطلب في مدينة نصر يُحسم بالجديد أولًا', () => {
  const dates = built().properties.map((r) => r.d ?? '').filter(Boolean);
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(dates, sorted);
});

test('الفهرس مُعلن في robots.txt و llms.txt و ai-feed endpoints', () => {
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  assert.match(robots, /^Allow: \/shortlist\.json$/m, 'shortlist.json غير مسموح في robots.txt');
  // قاعدة Allow يجب أن تسبق أي Disallow (زواحف first-match).
  assert.ok(robots.indexOf('Allow: /shortlist.json') < robots.indexOf('Disallow: /_site/'), 'Allow بعد Disallow — زاحف first-match سيحجبه');

  const llms = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
  assert.match(llms, /shortlist\.json/);

  const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-ai-artifacts.mjs'), 'utf8');
  assert.match(builder, /shortlist: `\$\{SITE\}\/shortlist\.json`/);
});
