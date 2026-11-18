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
    // ?v=<بصمة> تكسر كاش المتصفح حين يُعاد بناء الفيديو — مقبولة ومطلوبة.
    assert.match(
      v,
      /^\/assets\/video\/preview\/[a-z0-9-]+\.mp4(\?v=[a-f0-9]{8})?$/,
      `مسار غير متوقع: ${v}`,
    );
    const filePath = '.' + v.split('?')[0];
    assert.ok(existsSync(filePath), `ملف الفيديو غير موجود: ${v}`);
  }
});

test('روابط الفيديو تحمل بصمة تكسر الكاش — وإلا ظل المالك يرى النسخة القديمة', () => {
  const html = read('luxury-gallery.html');
  const block = html.split('const properties = [')[1].split('        ];')[0];
  const vids = [...block.matchAll(/video:\s*"([^"]*)"/g)]
    .map((m) => m[1])
    .filter(Boolean);
  assert.equal(vids.length, 8);
  for (const v of vids) {
    assert.match(v, /\?v=[a-f0-9]{8}$/, `بلا بصمة كاش: ${v}`);
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

// ═══ 2026-11-18: «النصوص بحروف مبعثرة» — سبب قابل للقياس والفحص ═══
test('عناوين الرئيسية لا تستخدم الوزن 900: النقاط العربية تطفو فتبدو الحروف مفكّكة', () => {
  const css = read('assets/css/style.css');
  for (const sel of [
    'body.homepage .hp-cinematic-content h2',
    'body.homepage .hp-section-title',
    'body.homepage .hp-cinematic h2',
    'body.homepage .hp-final-cta h2',
  ]) {
    const i = css.indexOf(sel + ' {');
    assert.ok(i !== -1, `قاعدة مفقودة: ${sel}`);
    const block = css.slice(i, css.indexOf('}', i));
    assert.doesNotMatch(block, /font-weight:\s*900/, `${sel}: الوزن 900 يفكّك النص العربي`);
    assert.doesNotMatch(block, /letter-spacing:\s*-/, `${sel}: تباعد سالب يفكّك النص العربي`);
  }
});

test('صفحتا النخبة مفهرستان: index/follow وsitemap — لا تناقض', () => {
  for (const f of ['luxury-gallery.html', 'video-preview.html']) {
    const src = read(f);
    // الـfront matter فقط: التعليقات داخل الصفحة قد تذكر الاسم بلا أن تنفّذه
    const fm = src.split('---')[1] || '';
    assert.match(fm, /^sitemap:\s*true/m, `${f}: مستبعدة من الخريطة رغم طلب الترشيح`);
    assert.match(fm, /^robots:\s*"index, follow/m, `${f}: robots`);
    assert.doesNotMatch(fm, /noindex/, `${f}: noindex`);
  }
});

// ═══ 2026-11-18: «الحروف المبعثرة» — ثلاثة أسباب حقيقية، كلها مقيسة ═══
test('عناوين الرئيسية: لا تباعد سالب ولا قطع كلمات ولا عرض أضيق من الكلمة', () => {
  const css = read('assets/css/style.css');
  const rules = [];
  for (const m of css.matchAll(/(body\.homepage \.hp-hero-title[^{]*)\{([^}]*)\}/g)) {
    rules.push({ sel: m[1].trim(), body: m[2] });
  }
  assert.ok(rules.length >= 4, `قواعد العنوان قليلة: ${rules.length}`);

  for (const { sel, body } of rules) {
    // ١) التباعد السالب يدمج الحروف العربية فيبدو النص مشوّهًا
    assert.doesNotMatch(
      body, /letter-spacing:\s*-[\d.]/,
      `${sel}: تباعد سالب يكسر وصل الحروف العربية`,
    );
    // ٢) flex-wrap على العنوان نفسه يجعل كل كلمة عنصرًا يُقطع
    assert.doesNotMatch(
      body, /display:\s*flex[^;]*;[^}]*flex-wrap/,
      `${sel}: flex-wrap على العنوان يقطع الكلمة الواحدة`,
    );
    // ٣) max-width بوحدة em أصغر من الكلمة الأطول يُجبر القطع
    const mw = body.match(/max-width:\s*([\d.]+)em/);
    if (mw) {
      assert.ok(
        Number(mw[1]) >= 9,
        `${sel}: max-width:${mw[1]}em أضيق من الكلمة العربية الأطول`,
      );
    }
  }

  // ٤) على الجوال: المقاس لا يتجاوز ما يجعل الكلمة أوسع من الشاشة
  const mobile = css.match(/@media \(max-width: 480px\)[\s\S]{0,600}?hp-hero-title[^}]*font-size:\s*clamp\(([\d.]+)rem,\s*([\d.]+)vw/);
  assert.ok(mobile, 'قاعدة العنوان على الجوال 480px');
  const vw = Number(mobile[2]);
  assert.ok(vw <= 8.5, `الجوال: ${vw}vw = ${(vw * 3.6).toFixed(0)}px على 360px — تُقطع الكلمة`);
});

// ═══ 2026-11-18: نصوص شريحة المعرض على الهاتف ═══
// المالك شكا من تداخل الأزرار والعناوين على الجوال. القواعد صارت clamp()
// مقيّدة بـ body.page-luxury، والوصف لم يبقَ مخفيًا على الشاشات الضيقة.
test('نصوص شريحة المعرض متجاوبة: clamp + الوصف ظاهر + السعر معزول', () => {
  const css = read('assets/css/style.css');
  const block = css.slice(css.indexOf('body.page-luxury .prop-data {\n  direction: rtl;'));
  assert.ok(block.length > 500, 'كتلة prop-data المتجاوبة');

  // clamp على العنوان والوصف والسعر
  for (const [sel, re] of [
    ['h2', /body\.page-luxury \.prop-data h2 \{[^}]*font-size: clamp\(1\.25rem, 5vw, 2rem\)/],
    ['p', /body\.page-luxury \.prop-data p \{[^}]*font-size: clamp\(0\.9rem, 3\.6vw, 1\.1rem\)/],
    ['price', /body\.page-luxury \.prop-price \{[^}]*font-size: clamp\(1\.4rem, 6vw, 2\.2rem\)/],
  ]) {
    assert.match(block.replace(/\s+/g, ' '), re, `${sel}: مقاس متجاوب بـ clamp()`);
  }

  // السعر معزول اتجاهيًا: «13,000,000 ج.م» لا يتبدّد ترتيبه
  assert.match(block.replace(/\s+/g, ' '), /prop-price \{[^}]*unicode-bidi: isolate/);

  // ⚠️ كان الوصف display:none تحت 380px — معلومة بيع تُخفى
  const propsData = css.slice(css.lastIndexOf('body.page-luxury .prop-data p {'));
  assert.doesNotMatch(
    css.match(/@media \(max-width: 380px\) \{[\s\S]*?\}/)?.[0] || '',
    /prop-data p \{ display: none/,
    'الوصف ممنوع يُخفى على الهاتف',
  );
  assert.ok(propsData.length > 0);
});

test('صور المعرض وخلفيته بلا نص مدموج — لا حاجة لتعديل الفيديو', () => {
  // الخلفية والشرائح صور فوتوغرافية خام من العروض. النص كله HTML فوقها.
  const html = read('luxury-gallery.html');
  // النص يأتي من مصفوفة JS كنصوص HTML لا من صورة
  assert.match(html, /\$\{p\.title\}/, 'العنوان نص HTML');
  assert.match(html, /\$\{p\.price\}/, 'السعر نص HTML');
  assert.match(html, /\$\{p\.desc\}/, 'الوصف نص HTML');
  // ولا صورة تحمل نصًا: الشرائح كلها صور عقارات
  for (const m of html.matchAll(/img:\s*"([^"]+)"/g)) {
    assert.match(m[1], /\.(webp|jpe?g|png)$/i, `صورة غير متوقعة: ${m[1]}`);
    assert.ok(existsSync(path.join(ROOT, 'assets', 'img', 'properties', m[1])), `صورة مفقودة: ${m[1]}`);
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
