// Tests: نطاق مدينة نصر في الواجهة والبيانات المنظمة — 2026-10-20
//
// السياسة: الموقع وD1 يخدمان مدينة نصر فقط. الوحدات القديمة خارجها تبقى
// متاحة بالرابط المباشر لكن noindex وخارج sitemap وخارج كل القوائم.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListingFacets } from '../lib/listing-facets.mjs';
import { spawnSync } from 'node:child_process';

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

test('روابط معرض النخبة تشير لوحدات داخل مدينة نصر فقط', () => {
  const urls = [...read('luxury-gallery.html').matchAll(/url:\s*"\/properties\/([^/"]+)\/"/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const slug of urls) {
    assert.ok(facets.listings[slug], `رابط مكسور: ${slug}`);
    assert.equal(facets.listings[slug].in_area, true, `خارج النطاق: ${slug}`);
  }
});

// ═══ 2026-11-18: «المعرض السينمائي» صار مشتقًّا من البيانات لا مكتوبًا يدويًا ═══
test('معرض النخبة: شقق بيع داخل النطاق من 8 مليون فقط — ما يطابق وعد «أفخم الوحدات»', () => {
  const block = read('luxury-gallery.html')
    .split('const properties = [')[1]
    .split('        ];')[0];
  const urls = [...block.matchAll(/url:\s*"\/properties\/([^/"]+)\//g)].map((m) => m[1]);
  assert.ok(urls.length > 0, 'المعرض لا يمكن أن يكون فارغًا');
  for (const slug of urls) {
    const u = facets.listings[slug];
    assert.equal(u.deal, 'sale', `معرض الفخامة للبيع فقط: ${slug}`);
    assert.equal(u.type, 'apartment', `معرض الفخامة للشقق فقط: ${slug}`);
    assert.ok(
      u.price >= 8_000_000,
      `تحت حد الفخامة (8 مليون): ${slug} = ${u.price}`,
    );
  }
});

test('كل شريحة نخبة لها فيديو موجود فعليًا — لا مسار مكسور', () => {
  const html = read('luxury-gallery.html');
  const block = html.split('const properties = [')[1].split('        ];')[0];
  const vids = [...block.matchAll(/video:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(vids.length, 8, 'يجب أن تحمل كل شريحة مفتاح video');
  const withVideo = vids.filter(Boolean);
  assert.equal(withVideo.length, 8, `شرائح بلا فيديو: ${vids.length - withVideo.length}`);
  for (const v of withVideo) {
    assert.match(v, /^\/assets\/video\/preview\/[a-z0-9-]+\.mp4$/, `مسار غير متوقع: ${v}`);
    assert.ok(existsSync('.' + v), `ملف الفيديو غير موجود: ${v}`);
  }
});

test('فيديو المعرض لا يضيف وزنًا: preload=none وخلف زر ضغط', () => {
  const html = read('luxury-gallery.html');
  // المشغّل يُبنى عند الضغط فقط — لا <video src=...> في الـHTML الثابت
  assert.doesNotMatch(html, /<video[^>]*\ssrc=/i, 'فيديو مُضمَّن فورًا في الـHTML');
  assert.match(html, /preload="none"/, 'المشغّل يجب أن يكون preload=none');
  assert.match(html, /class="btn-video"/, 'زر تشغيل الفيديو');
  // ويوقف العرض التلقائي: مشهد سينمائي لا سباق شرائح
  assert.match(html, /function stopEngine\(\)/);
  // بعد الإغلاق يعود العرض التلقائي (وإلا تجمّد المعرض بعد أول فيديو)
  const closeFn = html.split('function closeVideo()')[1].split('function openVideo(')[0];
  assert.match(closeFn, /startEngine\(\)/, 'لا يُستأنف العرض بعد إغلاق الفيديو');
});

test('معرض النخبة مطابق لمولّده — لا تعديل يدوي يفلت', () => {
  // يُشغَّل المولّد بـ--check: يفشل لو حُرِّر الملف يدويًا أو تغيّر سعر/عرض.
  const r = spawnSync(process.execPath, [path.join('scripts', 'build-luxury-gallery.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `المعرض خارج التزامن مع المولّد:\n${r.stdout || ''}${r.stderr || ''}`);
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
