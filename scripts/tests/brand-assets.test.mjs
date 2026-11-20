/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/tests/brand-assets.test.mjs — حارس هوية العلامة
 * ───────────────────────────────────────────────────────────────────
 *  لماذا (2026-11-20): جرد 565 ملف صورة كشف أربعة عيوب في مجلد الهوية
 *  لم يكن أي اختبار يحرسها:
 *
 *    1. `icon-maskable-512.png` هامشه 10.9% فقط. مواصفة Google تطلب أن
 *       يقع المحتوى داخل 80% المركزية (هامش ≥20%) وإلا يُقتطع الشعار على
 *       أيقونات أندرويد الدائرية والمربعة. صار 20.02%.
 *    2. `favicon.ico` كان 16/32/48 فقط — لا 96 التي يطلبها بعض متصفحات
 *       أندرويد ومايكروسوفت. صار 16/24/32/48/64/96.
 *    3. `theme_color` و`background_color` كانا `#0a3d2e` (أخضر زيتي) بينما
 *       خلفية الشعار `#080808` — فيظهر إطار مختلف اللون حول الأيقونة عند
 *       تثبيت التطبيق. صارا مطابقين للشعار.
 *    4. `favicon.svg` كان يستخدم `#000000` و`#43C641` بينما الشعار
 *       `#080808` و`#41C641` — انحراف لوني غير مقصود.
 *
 *  الاختبار يعمل بلا حزم خارجية (fs فقط) ولا يحتاج ImageMagick.
 * ═══════════════════════════════════════════════════════════════════
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const abs = (rel) => path.join(ROOT, rel);

/** أبعاد ICO تُقرأ من رأس الملف: 6 بايت رأس ثم 16 بايت لكل صورة. */
function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    // 0 يعني 256
    sizes.push(buf[off] === 0 ? 256 : buf[off]);
  }
  return sizes;
}

test('maskable icon: الرسم داخل المنطقة الآمنة (لا يُقتطع على أندرويد)', () => {
  // نقرأ الأبعاد من PNG IHDR ولا نحتاج مكوّنًا خارجيًا.
  const buf = fs.readFileSync(abs('assets/img/icon-maskable-512.png'));
  assert.equal(buf.readUInt32BE(16), 512, 'يجب أن يكون 512×512');
  assert.equal(buf.readUInt32BE(20), 512, 'يجب أن يكون 512×512');

  // الهامش مقيس في _data/brand_assets.json (يُحدّثه scripts/images/measure-brand-assets.mjs)
  const m = JSON.parse(read('_data/brand_assets.json'));
  const margin = m.maskable.marginPercent;
  assert.ok(
    margin >= 20,
    `هامش maskable = ${margin}% والمواصفة تطلب 20% على الأقل — الشعار سيُقتطع على أندرويد`,
  );
});

test('favicon.ico يحمل 16 و32 و48 و96 بكسل', () => {
  const sizes = icoSizes(fs.readFileSync(abs('favicon.ico')));
  for (const need of [16, 32, 48, 96]) {
    assert.ok(sizes.includes(need), `favicon.ico لا يحمل ${need}×${need} (الموجود: ${sizes.join(', ')})`);
  }
});

test('theme_color و background_color يطابقان خلفية الشعار', () => {
  const m = JSON.parse(read('manifest.json'));
  const brand = JSON.parse(read('_data/brand_assets.json'));
  assert.equal(m.theme_color.toUpperCase(), brand.colors.black.toUpperCase(),
    'theme_color لا يطابق أسود الشعار — شريط الحالة سيبدو مختلفًا عن الأيقونة');
  assert.equal(m.background_color.toUpperCase(), brand.colors.black.toUpperCase(),
    'background_color لا يطابق أسود الشعار — يظهر إطار غريب عند فتح التطبيق');
});

test('favicon.svg يستخدم ألوان الشعار لا ألوانًا منحرفة', () => {
  const svg = read('favicon.svg');
  const brand = JSON.parse(read('_data/brand_assets.json'));
  assert.ok(
    !svg.includes('#000000'),
    'favicon.svg يستخدم #000000 بينما خلفية الشعار #080808 — انحراف لوني',
  );
  assert.ok(
    !svg.toLowerCase().includes('#43c641'),
    'favicon.svg يستخدم #43C641 بينما أخضر الشعار #41C641',
  );
  for (const hex of [brand.colors.black, brand.colors.green]) {
    assert.ok(svg.includes(hex), `favicon.svg لا يحمل اللون ${hex}`);
  }
});

test('كل ملفات الهوية المعلنة موجودة على القرص', () => {
  const brand = JSON.parse(read('_data/brand_assets.json'));
  for (const rel of brand.requiredFiles) {
    assert.ok(fs.existsSync(abs(rel)), `ملف الهوية مفقود: ${rel}`);
  }
});

test('بديل WebP أصغر من PNG لكل أيقونة — وإلا لا فائدة منه', () => {
  const m = JSON.parse(read('_data/brand_assets.json'));
  for (const pair of m.webpPairs) {
    if (!fs.existsSync(abs(pair.webp))) continue;
    const png = fs.statSync(abs(pair.png)).size;
    const webp = fs.statSync(abs(pair.webp)).size;
    assert.ok(webp < png, `${pair.webp} ليس أصغر من ${pair.png} (${webp} ≥ ${png})`);
  }
});
