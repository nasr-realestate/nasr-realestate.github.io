// Tests: نطاق مدينة نصر في الواجهة والبيانات المنظمة — 2026-10-20
//
// السياسة: الموقع وD1 يخدمان مدينة نصر فقط. الوحدات القديمة خارجها تبقى
// متاحة بالرابط المباشر لكن noindex وخارج sitemap وخارج كل القوائم.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListingFacets } from '../lib/listing-facets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const facets = buildListingFacets(ROOT);

/** يحذف تعليقات HTML وLiquid — التوثيق الداخلي مسموح أن يذكر الأخطاء القديمة. */
const visible = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '');

const OTHER_AREAS = /القاهرة الجديدة|مصر الجديدة|التجمع|الرحاب|هليوبوليس|New Cairo|Heliopolis/;

// ملفات الواجهة العامة التي تُعرض لكل زائر أو تُقرأ كبيانات منظمة للموقع كله.
const SITE_WIDE = [
  '_config.yml', 'metadata.json', 'index.html', 'properties.html', '404.html', 'luxury-gallery.html',
  '_layouts/default.html', '_layouts/property_page.html', '_layouts/request_page.html',
  '_includes/schema-global.html', '_includes/schema-property.html', '_includes/floating-menu.html',
];

test('لا ادعاء بتغطية مناطق خارج مدينة نصر في القوالب العامة', () => {
  for (const f of SITE_WIDE) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const m = visible(read(f)).match(OTHER_AREAS);
    assert.equal(m, null, `${f}: «${m && m[0]}»`);
  }
});

test('لا aggregateRating/Review ذاتي في البيانات المنظمة', () => {
  for (const f of SITE_WIDE) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const src = visible(read(f));
    assert.doesNotMatch(src, /"aggregateRating"|"@type"\s*:\s*"(Review|AggregateRating)"/, f);
  }
});

test('وحدات خارج النطاق مستبعدة من sitemap عبر defaults في _config.yml — نفس القائمة بالضبط', () => {
  const cfg = read('_config.yml');
  const listed = [...cfg.matchAll(/path:\s*"_properties\/([^"]+)"\s*\n\s*values:\s*\n\s*sitemap:\s*false/g)]
    .map((m) => m[1]).sort();
  const dir = path.join(ROOT, '_properties');
  const oosFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).filter((f) => {
    const slug = (read(`_properties/${f}`).match(/^slug:\s*"?([^"\n]+)"?/m) || [])[1]?.trim() || f.replace(/\.md$/, '');
    return facets.listings[slug] && !facets.listings[slug].in_area;
  }).sort();
  assert.equal(oosFiles.length, facets.totals.out_of_area);
  assert.deepEqual(listed, oosFiles);
});

test('default.html: robots يحترم page.robots ويجعل الوحدات خارج النطاق noindex', () => {
  const src = read('_layouts/default.html');
  assert.match(src, /assign _robots = page\.robots/);
  assert.match(src, /_facet\.in_area == false/);
  assert.match(src, /"noindex, follow"/);
  assert.doesNotMatch(src, /<meta name="robots" content="index, follow[^"{]*">/, 'وسم robots ثابت');
  assert.match(read('404.html'), /^robots:\s*"noindex, follow"/m);
});

test('روابط معرض النخبة اليدوية تشير لوحدات داخل مدينة نصر فقط', () => {
  const urls = [...read('luxury-gallery.html').matchAll(/url:\s*"\/properties\/([^/"]+)\/"/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const slug of urls) {
    assert.ok(facets.listings[slug], `رابط مكسور: ${slug}`);
    assert.equal(facets.listings[slug].in_area, true, `خارج النطاق: ${slug}`);
  }
});

// ═══ اختبار رجوع من التدقيق العملي (2026-10-25): تعارض وصف MCP والنطاق ═══
test('وثائق MCP لا تعِد بمناطق خارج مدينة نصر، ووصف البحث مطابق للنطاق المعلن', () => {
  for (const f of ['mcp.json', '.well-known/mcp.json', '.well-known/mcp/server-card.json']) {
    const card = JSON.parse(read(f));
    const search = (card.tools || []).find((t) => t.name === 'search_properties');
    assert.ok(search, `${f}: أداة البحث موجودة`);
    assert.doesNotMatch(search.description, OTHER_AREAS, `${f}: وصف أداة البحث`);
    assert.match(search.description, /مدينة نصر فقط/);
    assert.doesNotMatch(JSON.stringify(card.description || ''), /والقاهرة الجديدة/, `${f}: وصف الخادم`);
  }
});

test('كل وحدة في API تحمل scope صريحًا: city للترشيح وarchive للأرشفة فقط', () => {
  const api = JSON.parse(read('api/properties.json'));
  const archive = facets.out_of_area_slugs || [];
  assert.ok(archive.length > 0, 'توجد وحدات أرشيفية خارج النطاق (وإلا فالاختبار بلا معنى)');
  for (const p of api.properties) {
    assert.ok(p.scope === 'city' || p.scope === 'archive', `${p.slug}: ${p.scope}`);
    assert.equal(p.scope === 'archive', archive.includes(p.slug), p.slug);
    if (p.scope === 'archive') assert.equal(p.in_nasr_city, false, p.slug);
  }
  const feed = JSON.parse(read('ai-feed.json'));
  for (const p of feed.properties) assert.ok(p.scope === 'city' || p.scope === 'archive', p.slug);
});
