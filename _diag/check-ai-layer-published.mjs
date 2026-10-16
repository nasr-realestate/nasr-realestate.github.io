// بوابة «طبقة الذكاء تُنشر كما هي» — تُشغَّل بعد `bundle exec jekyll build`
// في مسار التحقق قبل الدمج، على نفس بناء Jekyll الذي ينشر الموقع فعلًا.
//
// تعالج ثلاثة أخطاء صامتة لا يكشفها أي فحص آخر:
//   1) Jekyll يعدّ أي ملف `.md` يبدأ بـ`---` «صفحة» فيحذف وصفه الميكانيكي
//      ويحوّل نصه إلى HTML ⇒ تتغيّر صيغة الخدمة بلا أي رسالة خطأ.
//   2) `.well-known/` يُهمَل صامتًا لأن Jekyll يتجاهل ما يبدأ بنقطة إلا إذا
//      صُرّح به في `include` (وهو ما فعلناه في _config.yml).
//   3) ملفات طبقة الذكاء قد لا تكون منسوخة أصلًا إلى _site.
//
// التشغيل: node _diag/check-ai-layer-published.mjs [_site]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SITE_DIR = process.argv[2] ?? '_site';
const ROOT = '.';
/** ملفات تُنشر مفردة ويجب أن تكون مطابقة للأصل بايتًا ببايت. */
const VERBATIM_FILES = ['llms-full.txt', 'ai.txt', 'mcp.json', 'search-data.json'];
/** مجلدات تُنشر كاملة ويجب أن تكون مطابقة للأصل ملفًا بملف. */
const VERBATIM_TREES = ['api', '.well-known'];

/** كل الملفات تحت مسار، كنسبٍ من ذلك المسار. */
function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

// ─── 1) نسخ حرفي: لا تحويل، ولا حذف، ولا إضافة ────────────────────────────
let files = 0;
for (const file of VERBATIM_FILES) {
  const source = path.join(ROOT, file);
  const published = path.join(SITE_DIR, file);
  assert.ok(fs.existsSync(source), `${file}: غير موجود في المستودع`);
  assert.ok(fs.existsSync(published), `${file}: لم يُنشر إلى ${SITE_DIR} — تحقّق من exclude/keep_files في _config.yml`);
  assert.equal(
    fs.readFileSync(published, 'utf8'),
    fs.readFileSync(source, 'utf8'),
    `${file}: المحتوى المنشور لا يطابق الأصل`,
  );
  files += 1;
}

for (const tree of VERBATIM_TREES) {
  const sourceFiles = walk(path.join(ROOT, tree));
  const publishedFiles = walk(path.join(SITE_DIR, tree));
  assert.ok(sourceFiles.length > 0, `${tree}: لا ملفات في المستودع`);
  assert.deepEqual(
    publishedFiles,
    sourceFiles,
    `${tree}: قائمة الملفات المنشورة تختلف عن الأصل (Jekyll يتجاهل ما يبدأ بنقطة إلا بـinclude، ويحوّل .md ذا front matter إلى صفحة)`,
  );
  for (const file of sourceFiles) {
    assert.equal(
      fs.readFileSync(path.join(SITE_DIR, tree, file), 'utf8'),
      fs.readFileSync(path.join(ROOT, tree, file), 'utf8'),
      `${tree}/${file}: نُشر محوَّلًا لا حرفيًا`,
    );
  }
  files += sourceFiles.length;
  console.log(`${tree}: ${sourceFiles.length} ملفًا منشورًا حرفيًا`);
}

// ─── 2) الوصف الميكانيكي يبقى مقروءًا بعد النشر ───────────────────────────
const properties = walk(path.join(ROOT, 'api', 'properties')).filter((f) => f.endsWith('.md'));
assert.ok(properties.length >= 100, `عدد صفحات الوحدات غير متوقع: ${properties.length}`);
for (const file of properties) {
  const md = fs.readFileSync(path.join(SITE_DIR, 'api', 'properties', file), 'utf8');
  assert.ok(md.startsWith('<!-- ai-property '), `${file}: تعليق الوصف مفقود — Jekyll عالج الملف كصفحة؟`);
  assert.ok(!md.startsWith('---'), `${file}: الملف المنشور يبدأ بـfront matter`);
  const json = md.slice(md.indexOf('<!-- ai-property ') + 17, md.indexOf(' -->'));
  let meta;
  try {
    meta = JSON.parse(json);
  } catch (error) {
    assert.fail(`${file}: تعليق الوصف ليس JSON صالحًا — ${error.message}`);
  }
  assert.equal(meta.slug, file.replace(/\.md$/, ''), `${file}: المعرّف داخل الوصف لا يطابق اسم الملف`);
  assert.ok(meta.title && meta.transaction && meta.propertyType, `${file}: حقول أساسية ناقصة`);
}
console.log(`api/properties: ${properties.length} صفحة Markdown منشورة بوصفها الميكانيكي سليمًا`);

// ─── 3) التغذية التي يقرأها الوكلاء: قالب Liquid منشور وصالح ──────────────
const feedPath = path.join(SITE_DIR, 'ai-feed.json');
assert.ok(fs.existsSync(feedPath), 'ai-feed.json: لم يُنشر — الوكلاء والنموذج لن يجدوا كتالوج الوحدات');
const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
const sourceCount = fs.readdirSync(path.join(ROOT, '_properties')).filter((f) => f.endsWith('.md')).length;
assert.equal(feed.properties?.length, sourceCount, 'ai-feed.json: عدد الوحدات المنشورة لا يطابق _properties');
assert.equal(feed.total_count, sourceCount, 'ai-feed.json: total_count لا يطابق _properties');
for (const p of feed.properties.slice(0, 5)) {
  assert.ok(p.slug && p.url && p.title, 'ai-feed.json: وحدة بلا معرّف/رابط/عنوان');
}
console.log(`ai-feed.json: ${feed.properties.length} وحدة · schema_version ${feed.schema_version}`);

// ─── 4) بقية ملفات الاكتشاف ──────────────────────────────────────────────
for (const file of ['llms.txt', 'robots.txt', 'sitemap.xml']) {
  assert.ok(fs.existsSync(path.join(SITE_DIR, file)), `${file}: غير منشور`);
}
console.log(`\n✅ طبقة الذكاء منشورة: ${files + properties.length + 1} ملفًا تحقّقت حرفيًا.`);
