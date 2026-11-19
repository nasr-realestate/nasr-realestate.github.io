/* صفحة «شقق بالفيديو» — مولَّدة من بيانات المنشور، لا مكتوبة يدويًا.
 *
 * العيب الأصلي (2026-11-18): البطاقات كانت مكتوبتين يدويًا وفيهما
 *   «المقاس: 480×854 (9:16) · 12 إطار/ث»
 *   «الحجم: 615 ك.ب · المدة: 24.5 ثانية»
 * أرقام هندسية للفيديو لا تفيد المشتري، وقد تُقرأ كعيب في الجودة. والمفيد —
 * الغرف والحمامات والدور والتشطيب — كان غائبًا. وكانت صفحتان فقط من ثماني
 * وحدات لها فيديو، فلا يعرف الزائر أن الباقي موجود.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGE = read('video-preview.html');

test('لا أرقام هندسية للفيديو على صفحة يقرأها مشترٍ', () => {
  // الحجم والمدة وإطار/ث ورقم إصدار الترميز: كلها بلا فائدة للمشتري.
  assert.doesNotMatch(PAGE, /إطار\/ث/, '«12 إطار/ث» رقم تقني لا يخدم الزائر');
  assert.doesNotMatch(PAGE, /\d+(\.\d+)?\s*ك\.ب/, 'الحجم بالكيلوبايت لا يعني المشتري');
  assert.doesNotMatch(PAGE, /480×854/, 'أبعاد الملف تقنية لا شرائية');
  assert.doesNotMatch(PAGE, /المدة:/, '«المدة:» سطر تقني');
});

test('كل بطاقة تعرض ما يسأل عنه المشتري فعلًا', () => {
  const cards = PAGE.split('<div class="vp-card">').slice(1);
  assert.equal(cards.length, 8, `عدد البطاقات ${cards.length} لا 8`);

  for (const card of cards) {
    const title = (card.match(/<h2>([^<]+)<\/h2>/) || [])[1] || '?';
    assert.match(card, /class="vp-meta">[^<]*ج\.م/, `${title}: بلا سعر`);
    assert.match(card, /<video[^>]*preload="none"/, `${title}: preload=none مطلوب`);
    assert.match(card, /poster="/, `${title}: بلا صورة مصغّرة`);
    // ثلاث مواصفات على الأقل: الغرف/الحمامات/الدور/التشطيب
    const facts = (card.match(/<li/g) || []).length;
    assert.ok(facts >= 3, `${title}: مواصفات قليلة (${facts})`);
    assert.match(
      card,
      /href="\{\{ '\/properties\/[a-z0-9-]+\/' \| relative_url \}\}"/,
      `${title}: بلا رابط لصفحة العرض`,
    );
  }
});

test('كل وحدة لها فيديو مبني تظهر — لا صفحتان من ثماني وحدات', () => {
  const videos = fs
    .readdirSync(path.join(ROOT, 'assets/video/preview'))
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => f.replace('.mp4', ''));
  assert.equal(videos.length, 8, 'عدد الفيديوهات المبنيّة تغيّر');
  for (const slug of videos) {
    assert.ok(
      PAGE.includes(`/assets/video/preview/${slug}.mp4`),
      `الوحدة ${slug} لها فيديو ولا تظهر في الصفحة`,
    );
  }
});

test('تسمية المواصفة لا تكذب: النص يجب أن يطابق عنوانه', async () => {
  const props = JSON.parse(read('api/properties.json'));
  const byslug = new Map(props.properties.map((p) => [p.slug, p]));
  // وحدة 380م تحمل في baths نص «تشطيب فندقي فاخر» — لو عُرض كـ«الحمامات:»
  // لكان كلامًا غير صحيح على صفحة منشورة. المولّد يتخطّى التسمية.
  const badry = byslug.get('apartment-sale-mahmoud-elbadry-8th-district-380m');
  assert.ok(badry, 'وحدة الاختبار مفقودة');
  assert.doesNotMatch(badry.baths || '', /حمام/, 'تغيّرت البيانات — حدّث الاختبار');
  assert.doesNotMatch(
    PAGE,
    /<span>الحمامات<\/span> <b>تشطيب/,
    'تسمية كاذبة: تشطيب معروض كحمامات',
  );
});

test('الصفحة مطابقة لمولّدها — لا تعديل يدوي يفلت', () => {
  const out = execFileSync(process.execPath, ['scripts/build-video-preview.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /مطابقة/);
});

test('بصمة كاش على كل رابط فيديو', () => {
  const srcs = [...PAGE.matchAll(/\/assets\/video\/preview\/[a-z0-9-]+\.mp4\?v=([a-f0-9]{8})/g)];
  assert.equal(srcs.length, 8, `روابط ببصمة: ${srcs.length} لا 8`);
});
