// بوابة «طبقة الذكاء تُنشر كما هي» — تُشغَّل بعد `bundle exec jekyll build`
// في .github/workflows/verify-ai-layer.yml، على نفس بناء Jekyll الذي ينشر الموقع.
//
// تعالج ثلاثة أخطاء صامتة لا يكشفها أي فحص آخر:
//   1) Jekyll يعدّ أي ملف `.md` يبدأ بـ`---` «صفحة» فيحذف وصفه الميكانيكي
//      ويحوّل نصه إلى HTML ⇒ تتغيّر صيغة الخدمة بلا أي رسالة خطأ.
//   2) `.well-known/` يُهمَل صامتًا لأن Jekyll يتجاهل ما يبدأ بنقطة إلا إذا
//      صُرّح به في `include` (وهو ما فعلناه في _config.yml).
//   3) ملفات طبقة الذكاء قد لا تكون منسوخة أصلًا إلى _site.
//
// التشغيل: node _diag/check-ai-layer-published.mjs   (بعد bundle exec jekyll build)
//
// كل مشكلة تُطبع وتُصدر أيضًا كـ`::error::` لتظهر في توضيحات الفحص على GitHub
// حتى عندما يتعذّر قراءة سجل الخطوة.
import fs from 'node:fs';
import path from 'node:path';

const SITE_DIR = '_site';
/** ملفات تُنشر مفردة ويجب أن تكون مطابقة للأصل بايتًا ببايت. */
const VERBATIM_FILES = ['llms-full.txt', 'ai.txt', 'mcp.json', 'search-data.json'];
/** مجلدات تُنشر كاملة ويجب أن تكون مطابقة للأصل ملفًا بملف. */
const VERBATIM_TREES = ['api', '.well-known'];
const MAX_ANNOTATIONS = 12;

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

const sameBytes = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const sample = (list) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` … (+${list.length - 3})` : '');

const problems = [];
const note = (message) => problems.push(message);

// ─── 1) نسخ حرفي: لا تحويل، ولا حذف، ولا إضافة ────────────────────────────
let verified = 0;
for (const file of VERBATIM_FILES) {
  if (!fs.existsSync(file)) note(`${file}: غير موجود في المستودع`);
  else if (!fs.existsSync(path.join(SITE_DIR, file))) {
    note(`${file}: لم يُنشر إلى ${SITE_DIR} — تحقّق من exclude/keep_files في _config.yml`);
  } else if (!sameBytes(file, path.join(SITE_DIR, file))) {
    note(`${file}: المحتوى المنشور لا يطابق الأصل`);
  } else verified += 1;
}

for (const tree of VERBATIM_TREES) {
  const sourceFiles = walk(tree);
  if (!sourceFiles.length) {
    note(`${tree}: لا ملفات في المستودع`);
    continue;
  }
  const publishedFiles = walk(path.join(SITE_DIR, tree));
  const missing = sourceFiles.filter((f) => !publishedFiles.includes(f));
  const extra = publishedFiles.filter((f) => !sourceFiles.includes(f));
  const changed = sourceFiles
    .filter((f) => publishedFiles.includes(f))
    .filter((f) => !sameBytes(path.join(tree, f), path.join(SITE_DIR, tree, f)));
  if (missing.length) {
    note(`${tree}: ${missing.length} ملفًا غير منشور (${sample(missing)}) — Jekyll يتجاهل ما يبدأ بنقطة إلا بـinclude`);
  }
  if (extra.length) note(`${tree}: ${extra.length} ملفًا في _site ليس في المستودع (${sample(extra)})`);
  if (changed.length) note(`${tree}: ${changed.length} ملفًا نُشر محوَّلًا لا حرفيًا (${sample(changed)})`);
  verified += sourceFiles.length - missing.length - changed.length;
}

// ─── 2) الوصف الميكانيكي يبقى مقروءًا بعد النشر ───────────────────────────
const propertyDocs = walk(path.join('api', 'properties')).filter((f) => f.endsWith('.md'));
if (propertyDocs.length < 100) note(`عدد صفحات وحدات الـMarkdown غير متوقع: ${propertyDocs.length}`);
let metadataOk = 0;
for (const file of propertyDocs) {
  const published = path.join(SITE_DIR, 'api', 'properties', file);
  if (!fs.existsSync(published)) continue; // عُدّ أعلاه
  const md = fs.readFileSync(published, 'utf8');
  if (md.startsWith('---')) {
    note(`${file}: الملف المنشور يبدأ بـfront matter — Jekyll عالجه كصفحة`);
    continue;
  }
  if (!md.startsWith('<!-- ai-property ')) {
    note(`${file}: تعليق الوصف مفقود في الملف المنشور`);
    continue;
  }
  try {
    const meta = JSON.parse(md.slice(md.indexOf('<!-- ai-property ') + 17, md.indexOf(' -->')));
    if (meta.slug !== file.replace(/\.md$/, '')) note(`${file}: المعرّف داخل الوصف لا يطابق اسم الملف`);
    else if (!meta.title || !meta.transaction || !meta.propertyType) note(`${file}: حقول أساسية ناقصة`);
    else metadataOk += 1;
  } catch (error) {
    note(`${file}: تعليق الوصف ليس JSON صالحًا (${String(error.message).slice(0, 60)})`);
  }
}

// ─── 3) التغذية التي يقرأها الوكلاء: قالب Liquid منشور وصالح ──────────────
const feedPath = path.join(SITE_DIR, 'ai-feed.json');
const sourceCount = fs.readdirSync('_properties').filter((f) => f.endsWith('.md')).length;
let feedSummary = 'غير منشورة';
if (!fs.existsSync(feedPath)) {
  note('ai-feed.json: لم يُنشر — الوكلاء والنموذج لن يجدوا كتالوج الوحدات');
} else {
  try {
    const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
    if (feed.properties?.length !== sourceCount) {
      note(`ai-feed.json: عدد الوحدات المنشورة ${feed.properties?.length} لا يطابق _properties (${sourceCount})`);
    }
    if (feed.total_count !== sourceCount) {
      note(`ai-feed.json: total_count = ${feed.total_count} لا يطابق _properties (${sourceCount})`);
    }
    const broken = (feed.properties ?? []).filter((p) => !p.slug || !p.url || !p.title).length;
    if (broken) note(`ai-feed.json: ${broken} وحدة بلا معرّف/رابط/عنوان`);
    feedSummary = `${feed.properties?.length} وحدة · schema_version ${feed.schema_version}`;
  } catch (error) {
    note(`ai-feed.json: ليس JSON صالحًا — ${String(error.message).slice(0, 80)}`);
  }
}

// ─── 4) بقية ملفات الاكتشاف ──────────────────────────────────────────────
for (const file of ['llms.txt', 'robots.txt', 'sitemap.xml']) {
  if (!fs.existsSync(path.join(SITE_DIR, file))) note(`${file}: غير منشور`);
}

// ─── الحكم ────────────────────────────────────────────────────────────────
if (problems.length) {
  for (const problem of problems.slice(0, MAX_ANNOTATIONS)) {
    const escaped = problem.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=AI layer publication::${escaped}`);
  }
  if (problems.length > MAX_ANNOTATIONS) {
    console.log(`::error title=AI layer publication::+${problems.length - MAX_ANNOTATIONS} مشكلة أخرى (انظر السجل)`);
  }
  console.error(`\n❌ ${problems.length} مشكلة في نشر طبقة الذكاء:`);
  for (const problem of problems) console.error(`   • ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`✅ طبقة الذكاء منشورة حرفيًا: ${verified} ملفًا · ${metadataOk} صفحة Markdown بوصفها الميكانيكي · ${feedSummary}`);
}
