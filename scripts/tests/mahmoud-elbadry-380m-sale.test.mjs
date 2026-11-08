// Tests: شقة 380م مستويين للبيع بشارع محمود البدري — المنطقة الثامنة (2026-11-08)
//
// يتحقق من التزام العرض بمعايير العروض القياسية في المستودع:
//   • البنية المعيارية الكاملة (.main-stats-card · .detail-section · .technical-specs · .features-columns · .final-payment-alert)
//   • خلو المتن من الفئات غير المعرّفة (specs-grid · highlight-box · features-section · location-info)
//   • سلامة عناصر Flex داخل .spec-item و .features-list li لمنع التمدد الأفقي وإزاحة زر الوكيل
//   • جودة وأبعاد الصور المشتقة (840×1400 · 800×1333 · 800×600 · 1200×630)
//   • ظهور بطاقة الوكيل وزر الوكيل العائم دون تصادم مع زر واتساب العائم
//   • سلامة طبقة الذكاء الاصطناعي، المزامنة مع D1، بوابة الصوت، وعدم اختلاق أي بيانات أو PII.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontMatter } from '../lib/front-matter.mjs';
import { normalizeProperty } from '../lib/properties.mjs';
import { __test as syncWorker } from '../../_worker/properties-sync-worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'apartment-sale-mahmoud-elbadry-8th-district-380m';
const FILE = '_properties/2026-11-08-apartment-sale-mahmoud-elbadry-8th-district-380m.md';
const IMAGE_BASE = 'mahmoud-elbadry-8th-district-380m';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('ملف العقار يلتزم ببيانات الـfront matter المعيارية دون اختلاق أرقام غرف أو حمامات', () => {
  const raw = read(FILE);
  const { data } = parseFrontMatter(raw);

  assert.equal(data.layout, 'property_page');
  assert.equal(data.id, IMAGE_BASE);
  assert.equal(data.slug, SLUG);
  assert.equal(data.category, 'apartments');
  assert.equal(data.priceNumeric, 13000000);
  assert.equal(data.areaNumeric, 380);
  assert.equal(data.roomsNumeric, undefined, 'لا يُخترع عدد غرف غير مذكور');
  assert.equal(data.bathsNumeric, undefined, 'لا يُخترع عدد حمامات غير مذكور');
  assert.ok(String(data.rooms || '').trim().length > 0, 'حقل الغرف النصي حاضر في الشريط العلوي');
  assert.ok(String(data.bathrooms || '').trim().length > 0, 'حقل الحمامات النصي حاضر في الشريط العلوي');
  assert.equal(data.status, 'available');
  assert.equal(data.description, data.meta_description);
  assert.doesNotMatch(String(data.title), /\|/);
  assert.doesNotMatch(String(data.title), /سمسار طلبك/);

  const norm = normalizeProperty(data, SLUG);
  assert.equal(norm.roomsNumeric, null, 'التطبيع لا يستنتج رقم غرف زائفًا من النص');
  assert.equal(norm.bathsNumeric, null, 'التطبيع لا يستنتج رقم حمامات زائفًا من النص');
  assert.equal(norm.priceNumeric, 13000000);
  assert.equal(norm.areaNumeric, 380);
  assert.equal(norm.zone, 'المنطقة الثامنة');
});

test('متن العرض يستخدم القالب المعياري الموحّد ويمنع أسباب التمدد الأفقي يمينًا ويسارًا', () => {
  const raw = read(FILE);
  const body = raw.slice(raw.indexOf('\n---', 4) + 4);

  // الفئات القياسية المعرّفة في assets/css/style.css
  for (const cls of [
    'property-detail-wrapper',
    'property-main-hero',
    'main-stats-card',
    'stat-box',
    'detail-section',
    'detail-title',
    'detail-text',
    'technical-specs',
    'spec-item',
    'features-columns',
    'features-list',
    'final-payment-alert',
  ]) {
    assert.match(body, new RegExp(`class="[^"]*\\b${cls}\\b`), `الفئة المعيارية مفقودة: ${cls}`);
  }

  // الفئات الدخيلة غير المعرّفة في style.css محظورة
  for (const forbidden of ['specs-grid', 'highlight-box', 'features-section', 'location-info']) {
    assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`), `فئة غير معرّفة في الأنماط: ${forbidden}`);
  }

  // كل .spec-item يحتوي عنصرين مباشرين فقط: <span>...</span> ثم <strong>...</strong>
  const specItems = [...body.matchAll(/<div class="spec-item">([\s\S]*?)<\/div>/g)];
  assert.equal(specItems.length, 8);
  for (const [, inner] of specItems) {
    assert.match(inner.trim(), /^<span><i class="fas [^"]+ gold-text"><\/i> [^<]+<\/span>\s*<strong>[^<]+<\/strong>$/);
  }

  // كل عنصر <li> في .features-list يغلّف النص في <span> واحدة بجانب الأيقونة لمنع انقسام Flex الأفقي
  const listItems = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)];
  assert.equal(listItems.length, 6);
  for (const [, inner] of listItems) {
    assert.match(inner.trim(), /^<i class="fas fa-check-circle gold-text"><\/i>\s*<span>[^<]+<\/span>$/);
  }
});

function readImageInfo(rel) {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), `ملف الصورة مفقود: ${rel}`);
  const buf = fs.readFileSync(full);
  if (rel.endsWith('.webp')) {
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, bytes: buf.length };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, bytes: buf.length };
    }
    if (chunk === 'VP8X') {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), bytes: buf.length };
    }
  }
  if (rel.endsWith('.jpg')) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), bytes: buf.length };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error(`تعذر قراءة أبعاد الصورة: ${rel}`);
}

test('الصورة الرئيسية والنسخ المشتقة محسّنة بالأبعاد المعيارية الصحيحة (بلا توليد اصطناعي)', () => {
  const identify = readImageInfo;

  const main = identify(`assets/img/properties/${IMAGE_BASE}.webp`);
  assert.deepEqual({ w: main.w, h: main.h }, { w: 840, h: 1400 });
  assert.ok(main.bytes > 15_000 && main.bytes <= 120_000, `حجم الصورة الرئيسية غير متوقع: ${main.bytes}`);

  const wide = identify(`assets/img/properties/${IMAGE_BASE}-800w.webp`);
  assert.deepEqual({ w: wide.w, h: wide.h }, { w: 800, h: 1333 });

  const card = identify(`assets/img/properties/cards/${IMAGE_BASE}.webp`);
  assert.deepEqual({ w: card.w, h: card.h }, { w: 800, h: 600 });
  assert.ok(card.bytes <= 60 * 1024 && card.bytes <= main.bytes * 0.9, 'نسخة البطاقة ضمن سقف الأداء');

  const og = identify(`assets/img/properties/og/${IMAGE_BASE}.jpg`);
  assert.deepEqual({ w: og.w, h: og.h }, { w: 1200, h: 630 });
  assert.ok(og.bytes <= 80 * 1024, 'نسخة المشاركة الاجتماعية ضمن سقف 80KB');

  const dims = read('_data/image_dims.yml');
  assert.match(dims, /"mahmoud-elbadry-8th-district-380m":\s*\{w:\s*840,\s*h:\s*1400\}/);
});

test('الوكيل ظاهر بلا تصادم بصري: زر الوكيل العائم وبطاقة الوكيل وقاعدة فصل زر واتساب', () => {
  const defaultLayout = read('_layouts/default.html');
  const propLayout = read('_layouts/property_page.html');
  const routeCss = read('assets/css/route-property.min.css');

  assert.match(defaultLayout, /class="agent-float-btn"/);
  assert.match(propLayout, /class="pp-agent-card"/);
  assert.match(routeCss, /overflow-x:clip/);
  assert.match(routeCss, /body\.layout-property_page \.pp-floating-wa[^{]*\{bottom:104px\}/);
});

test('المزامنة مع D1 وطبقة الذكاء الاصطناعي وخلو الملف من أي بيانات شخصية', () => {
  const raw = read(FILE);
  assert.doesNotMatch(raw, /01[0125]\d{8}/, 'لا أرقام هواتف للعميل أو المالك');

  const feed = JSON.parse(read('ai-feed.json'));
  const item = feed.properties.find((p) => p.slug === SLUG);
  assert.ok(item, 'العقار مدرج في ai-feed.json');
  assert.equal(item.scope, 'city');
  assert.equal(item.zone, 'المنطقة الثامنة');
  assert.equal(item.priceNumeric, 13000000);
  assert.equal(item.areaNumeric, 380);
  assert.equal(item.roomsNumeric, null);
  assert.equal(item.bathsNumeric, null);

  const facets = JSON.parse(read('_data/listing_facets.json'));
  assert.equal(facets.listings[SLUG]?.in_area, true);

  const { data } = parseFrontMatter(raw);
  const built = syncWorker.buildRecord(
    data,
    '2026-11-08-apartment-sale-mahmoud-elbadry-8th-district-380m.md',
    [
      { id: 1, name: 'مدينة نصر', names: ['مدينة نصر'] },
      { id: 8, name: 'المنطقة الثامنة', names: ['المنطقة الثامنة'] },
    ],
  );
  assert.equal(built.outOfScope, false);
  assert.deepEqual(built.problems, []);
  assert.equal(built.record.externalId, IMAGE_BASE);
  assert.equal(built.record.areaId, 8);
  assert.equal(built.record.transactionType, 'sale');
  assert.equal(built.record.propertyType, 'apartment');
  assert.equal(built.record.price, 13_000_000);
  assert.equal(built.record.areaM2, 380);
  assert.equal(built.record.rooms, null);
  assert.equal(built.record.bathrooms, null);
});
