// Tests: بيانات الواجهة المشتقة (_data/listing_facets.json) ونطاق مدينة نصر — 2026-10-20
//
// node --test scripts/tests/listing-facets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListingFacets, renderListingFacets, locationMatches } from '../lib/listing-facets.mjs';
import { parseFrontMatter } from '../lib/front-matter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const facets = buildListingFacets(ROOT);
const segmentsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, '_data/landing_segments.json'), 'utf8'));

function propertyFiles() {
  return fs.readdirSync(path.join(ROOT, '_properties')).filter((f) => f.endsWith('.md')).map((file) => {
    const { data } = parseFrontMatter(fs.readFileSync(path.join(ROOT, '_properties', file), 'utf8'));
    return { file, data, slug: String(data.slug || '').trim() || file.replace(/\.md$/, '') };
  });
}

test('_data/listing_facets.json المحفوظ مطابق للمصدر (شغّل build-listing-facets بعد أي تعديل)', () => {
  const committed = fs.readFileSync(path.join(ROOT, '_data/listing_facets.json'), 'utf8');
  assert.equal(committed, renderListingFacets(ROOT),
    'الملف قديم — نفّذ: node scripts/build-listing-facets.mjs');
});

test('كل عقار له سجل واحد، والإجماليات متسقة', () => {
  const files = propertyFiles();
  assert.equal(Object.keys(facets.listings).length, files.length);
  for (const { slug } of files) assert.ok(facets.listings[slug], `سجل مفقود: ${slug}`);
  assert.equal(facets.totals.in_area + facets.totals.out_of_area, files.length);
});

test('خارج النطاق = نفس قائمة OUT_OF_SCOPE_IDS المعتمدة لمزامنة D1 (سياسة واحدة)', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-properties-sync.yml'), 'utf8');
  const listed = wf.match(/OUT_OF_SCOPE_IDS:\s*"([^"]*)"/)[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  const ours = Object.values(facets.listings).filter((l) => !l.in_area).map((l) => l.id).sort();
  assert.deepEqual(ours, listed);
});

test('مطابقة العبارات: حروف الجر الملتصقة نعم، والكلمات المشابهة لا', () => {
  assert.equal(locationMatches('شارع حلمي - موازي لمصطفى النحاس', ['مصطفى النحاس']), true);
  assert.equal(locationMatches('الرابط بين حسن المأمون ومصطفي النحاس', ['مصطفى النحاس']), true);
  assert.equal(locationMatches('خلف مصر للطيران - قرب جامع بلال', ['شارع الطيران', 'الطيران الرئيسي', 'من الطيران']), false);
  assert.equal(locationMatches('شارع خضر التوني - متفرع من الطيران', ['من الطيران']), true);
});

test('صفحات الهبوط لا تضم إلا عقارات داخل مدينة نصر ومطابقة فعلًا للنوع/المعاملة/المنطقة', () => {
  const byKey = Object.fromEntries(segmentsConfig.segments.map((s) => [s.key, s]));
  const locations = Object.fromEntries(propertyFiles().map(({ slug, data }) => [slug, data.location || '']));
  for (const [slug, l] of Object.entries(facets.listings)) {
    if (!l.in_area) assert.deepEqual(l.segments, [], `${slug}: خارج النطاق ولا يجوز أن يدخل صفحة هبوط`);
    for (const key of l.segments) {
      const seg = byKey[key];
      if (seg.deal) assert.equal(l.deal, seg.deal, `${slug} في ${key}`);
      if (seg.types) assert.ok(seg.types.includes(l.type), `${slug} (${l.type}) في ${key}`);
      if (seg.match) assert.ok(locationMatches(locations[slug], seg.match), `${slug} في ${key}`);
    }
  }
  for (const seg of segmentsConfig.segments) {
    const stats = facets.segments[seg.key];
    const members = Object.values(facets.listings).filter((l) => l.segments.includes(seg.key)).length;
    assert.equal(stats.count, members, seg.key);
    assert.equal(stats.indexable, members >= facets.min_listings_for_index, seg.key);
  }
});

test('الأرقام: لا قيمة صفرية أو مساحة غير معقولة تدخل الفلاتر', () => {
  for (const [slug, l] of Object.entries(facets.listings)) {
    for (const k of ['price', 'area', 'rooms', 'baths']) {
      assert.ok(l[k] === null || (typeof l[k] === 'number' && l[k] > 0), `${slug}.${k}=${l[k]}`);
    }
    assert.ok(l.area === null || l.area >= 15, `${slug}: مساحة ${l.area}`);
    assert.ok(['sale', 'rent'].includes(l.deal), slug);
  }
});

test('صورة البطاقة: موجودة على القرص دائمًا (لا 404 ثم onerror)', () => {
  for (const [slug, l] of Object.entries(facets.listings)) {
    if (l.card_image === null) continue;
    assert.ok(fs.existsSync(path.join(ROOT, l.card_image)), `${slug}: ${l.card_image}`);
  }
});
