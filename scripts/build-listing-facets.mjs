#!/usr/bin/env node
/**
 * يكتب _data/listing_facets.json (بيانات الواجهة المشتقة لكل عقار) — 2026-10-20.
 *
 *   node scripts/build-listing-facets.mjs          # يكتب الملف
 *   node scripts/build-listing-facets.mjs --check  # يفشل لو المحفوظ لا يطابق المصدر
 *
 * يجب تشغيله بعد إضافة/تعديل أي ملف في _properties أو صورته أو
 * _data/landing_segments.json — والاختبار scripts/tests/listing-facets.test.mjs
 * يُسقط CI لو نُسي (نفس نمط check-ai-artifacts-in-sync).
 * بلا أي حزمة خارجية: آمن داخل مسار النشر.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderListingFacets, catalogPageStubs, landingPageStubs } from './lib/listing-facets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '_data', 'listing_facets.json');

const fresh = renderListingFacets(ROOT);
const segments = JSON.parse(fs.readFileSync(path.join(ROOT, '_data', 'landing_segments.json'), 'utf8')).segments;
const stubs = new Map([...catalogPageStubs(JSON.parse(fresh)), ...landingPageStubs(JSON.parse(fresh), segments)]);
const PAGE_DIR = path.join(ROOT, 'properties', 'page');
const listHtml = (dir, rel) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => `${rel}/${f}`) : []);
const existingStubs = [...listHtml(PAGE_DIR, 'properties/page'), ...listHtml(path.join(ROOT, 'properties'), 'properties')];

if (process.argv.includes('--check')) {
  const committed = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  const staleStubs = existingStubs.filter((p) => !stubs.has(p));
  const badStubs = [...stubs].filter(([p, c]) => !fs.existsSync(path.join(ROOT, p)) || fs.readFileSync(path.join(ROOT, p), 'utf8') !== c);
  if (committed !== fresh || staleStubs.length || badStubs.length) {
    console.error('❌ _data/listing_facets.json أو صفحات الترقيم/الهبوط قديمة — نفّذ: node scripts/build-listing-facets.mjs');
    process.exit(1);
  }
  console.log('✅ _data/listing_facets.json وصفحات الترقيم مطابقة للمصدر');
} else {
  fs.writeFileSync(TARGET, fresh, 'utf8');
  fs.mkdirSync(PAGE_DIR, { recursive: true });
  for (const p of existingStubs) if (!stubs.has(p)) fs.unlinkSync(path.join(ROOT, p));
  for (const [p, c] of stubs) fs.writeFileSync(path.join(ROOT, p), c, 'utf8');
  const data = JSON.parse(fresh);
  console.log(`[listing-facets] صفحات المعرض: ${data.catalog.total_pages} · ${data.totals.all} عقار · داخل مدينة نصر ${data.totals.in_area} · خارج النطاق ${data.totals.out_of_area}`);
  for (const [key, s] of Object.entries(data.segments)) {
    console.log(`  ${key}: ${s.count}${s.indexable ? '' : ' (أقل من حد الفهرسة)'}`);
  }
}
