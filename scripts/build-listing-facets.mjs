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
import { renderListingFacets } from './lib/listing-facets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '_data', 'listing_facets.json');

const fresh = renderListingFacets(ROOT);
if (process.argv.includes('--check')) {
  const committed = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (committed !== fresh) {
    console.error('❌ _data/listing_facets.json قديم — نفّذ: node scripts/build-listing-facets.mjs');
    process.exit(1);
  }
  console.log('✅ _data/listing_facets.json مطابق للمصدر');
} else {
  fs.writeFileSync(TARGET, fresh, 'utf8');
  const data = JSON.parse(fresh);
  console.log(`[listing-facets] ${data.totals.all} عقار · داخل مدينة نصر ${data.totals.in_area} · خارج النطاق ${data.totals.out_of_area}`);
  for (const [key, s] of Object.entries(data.segments)) {
    console.log(`  ${key}: ${s.count}${s.indexable ? '' : ' (أقل من حد الفهرسة)'}`);
  }
}
