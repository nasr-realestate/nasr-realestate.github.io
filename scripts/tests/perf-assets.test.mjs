// Tests: أصول الأداء المولَّدة (2026-10-24)
//
// سبب وجود هذه الاختبارات: خفض وزن الصفحة على الجوال اعتمد على ثلاثة أشياء
// **مولَّدة ومُتتبَّعة في Git** — لو نسي أحد إعادة توليدها بعد تعديل المصدر،
// يعود الموقع إلى الحالة البطيئة بلا أي خطأ ظاهر:
//   1) assets/css/route-*.min.css  ← من scripts/build-css.mjs (style.css)
//   2) assets/css/fa-subset.css + assets/fonts/*.woff2 ← من scripts/fonts/subset-icons.py
//   3) assets/img/properties/{cards,-800w}/*.webp ← من scripts/images/build-image-variants.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CSS_DIR = path.join(ROOT, 'assets', 'css');
const IMG_DIR = path.join(ROOT, 'assets', 'img', 'properties');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const scopes = JSON.parse(read('_data/css_scopes.json'));
const facets = JSON.parse(read('_data/listing_facets.json'));

test('css: كل مسار في _data/css_scopes.json له ملف موجود وغير فارغ', () => {
  const files = new Set();
  for (const [route, list] of Object.entries(scopes)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${route}: بلا ملفات`);
    for (const file of list) {
      files.add(file);
      const full = path.join(CSS_DIR, file);
      assert.ok(fs.existsSync(full), `${route}: ملف مفقود ${file}`);
      const size = fs.statSync(full).size;
      assert.ok(size > 2000, `${route}: ${file} صغير بشكل غير متوقع (${size} بايت)`);
    }
  }
  assert.ok(files.size >= 10, `عدد ملفات المسارات غير متوقع: ${files.size}`);
});

test('css: ملفات المسارات مُشتقّة من style.css الحالي (لا نسخة قديمة)', () => {
  const source = read('assets/css/style.css');
  // كل محدِّد مُنطَّق بصفحة يجب أن يوجد في ملف المسار الذي يخدم تلك الصفحة
  const checks = [
    ['homepage', 'default-page|property_page', 'no-check'],
    ['homepage', 'homepage|default', 'hp-hero-layout'],
    ['layout-property_page', 'default-page|property_page', 'pp-gallery-main'],
    ['layout-request_page', 'default-page|request_page', 'rq-budget'],
    ['page-agent', 'page-agent|app', 'wa-dialog'],
    ['page-properties', 'page-properties|default', 'pl-toolbar'],
  ];
  for (const [scope, route, selector] of checks) {
    if (selector === 'no-check') continue;
    assert.ok(source.includes(selector), `style.css لم يعد يحتوي ${selector} — حدّث الاختبار`);
    const files = scopes[route];
    assert.ok(files, `المسار ${route} غير مسجّل`);
    const css = files.map((f) => read(`assets/css/${f}`)).join('\n');
    assert.ok(css.includes(selector), `${route} (${scope}): لا يحتوي ${selector}`);
  }
});

test('css: الصفحات لم تعد تُحمّل cdnjs (Font Awesome) كأصل خارجي', () => {
  const candidates = [
    '_layouts/default.html', '_layouts/app.html', 'agent.html',
    'luxury-gallery.html', 'tools/valuation.html', 'property-images.html',
  ];
  for (const file of candidates) {
    const src = fs.existsSync(path.join(ROOT, file)) ? read(file) : '';
    if (!src) continue;
    // يُسمح بذكره في تعليق توضيحي فقط
    const active = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('<!--') && !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(active, /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/, `${file}: ما زال يحمّل Font Awesome من cdnjs`);
  }
});

test('icons: fa-subset.css يغطي كل صنف fa-* مستخدم في الصفحات والقوالب', () => {
  const css = read('assets/css/fa-subset.css');
  const covered = new Set([...css.matchAll(/\.(fa-[a-z0-9-]+)::before/g)].map((m) => m[1]));
  const utilities = new Set([
    'fa-spin', 'fa-pulse', 'fa-fw', 'fa-border', 'fa-ul', 'fa-li', 'fa-stack',
    'fa-stack-1x', 'fa-stack-2x', 'fa-inverse', 'fa-rotate-90', 'fa-rotate-180',
    'fa-rotate-270', 'fa-flip-horizontal', 'fa-flip-vertical',
    // أصناف العائلات نفسها (ليست أيقونات): <i class="fab fa-whatsapp">
    'fa-brands', 'fa-solid', 'fa-regular',
  ]);
  const globs = ['*.html', '_layouts/*.html', '_includes/*.html', '_properties/*.md', '_requests/*.md', 'properties/*.html'];
  const used = new Set();
  for (const pattern of globs) {
    const dir = pattern.includes('/') ? path.join(ROOT, path.dirname(pattern)) : ROOT;
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.html') && !file.endsWith('.md')) continue;
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      // أسماء الملفات والمسارات (fa-subset.css، fa-solid-900.woff2) ليست أصنافًا
      const withoutAssets = src.replace(/[\w./-]*fa-[a-z0-9-]+\.(?:css|woff2|svg)/g, ' ');
      for (const match of withoutAssets.matchAll(/\bfa-[a-z0-9-]+\b/g)) {
        used.add(match[0]);
      }
    }
  }
  const missing = [...used].filter((c) => !covered.has(c) && !utilities.has(c));
  assert.deepEqual(missing, [],
    `أيقونات مستخدمة بلا قاعدة في fa-subset.css: ${missing.join(', ')}\n`
    + '   الحل: python3 scripts/fonts/subset-icons.py  (ثم أعد تشغيل الاختبارات)');
});

test('css: الملفات المولَّدة مطابقة للمصدر (build-css --check)', () => {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-css.mjs'), '--check'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    assert.fail(`ملفات الأنماط قديمة — نفّذ: node scripts/build-css.mjs\n${err.stdout || ''}${err.stderr || ''}`);
  }
});

test('images: كل بطاقة عقار تشير إلى ملف موجود (cards/ أو الأصل)', () => {
  const missing = [];
  for (const [slug, listing] of Object.entries(facets.listings)) {
    const card = listing.card_image;
    if (!card) continue;
    const full = path.join(ROOT, card.replace(/^\//, ''));
    if (!fs.existsSync(full)) missing.push(`${slug} → ${card}`);
  }
  assert.deepEqual(missing, [], `صور بطاقات مفقودة: ${missing.slice(0, 5).join(' · ')}`);
});

test('images: لكل صورة عقار نسخة 800px (LCP صفحة العقار)', () => {
  const images = new Set(
    Object.values(facets.listings)
      .map((l) => l.image)
      .filter(Boolean)
      .map((p) => path.basename(p)),
  );
  const missing = [];
  for (const name of images) {
    const variant = path.join(IMG_DIR, name.replace(/\.webp$/i, '-800w.webp'));
    if (!fs.existsSync(variant)) missing.push(name);
  }
  assert.deepEqual(missing.slice(0, 5), [],
    `صور بلا نسخة 800px (${missing.length}): ${missing.slice(0, 3).join(' · ')}\n`
    + '   الحل: node scripts/images/build-image-variants.mjs');
});

test('images: _data/image_dims.yml يغطي كل صور العقارات', () => {
  const dims = read('_data/image_dims.yml');
  const known = new Set([...dims.matchAll(/^"([^"]+)":/gm)].map((m) => m[1]));
  const missing = [];
  for (const listing of Object.values(facets.listings)) {
    if (!listing.image) continue;
    const key = path.basename(listing.image).replace(/\.webp$/i, '');
    if (!known.has(key)) missing.push(key);
  }
  assert.deepEqual(missing, [],
    `صور بلا أبعاد في image_dims.yml: ${missing.slice(0, 5).join(', ')}\n`
    + '   الحل: node scripts/images/build-image-variants.mjs');
});
