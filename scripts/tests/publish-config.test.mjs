// Tests: إعدادات النشر في _config.yml — حراسة «المضائد الصامتة» في Jekyll
//
// سبب وجود الاختبار: النشر الفعلي على GitHub Pages يجري ببناء Jekyll على الفرع،
// وفيه أربع طرق تُفسد طبقة الذكاء **بلا أي رسالة خطأ**:
//   1) ملف `.md` يبدأ بـ`---` ⇒ يُعالَج «صفحةً» ويُحذف وصفه الميكانيكي.
//   2) مسار يبدأ بنقطة (`.well-known/`) ⇒ يُهمَل إلا إذا صُرّح به في `include`.
//   3) مفتاح `keep_files` ناقص ⇒ إعادة بناء في نفس مجلد الوجهة تمحو المخرجات المولَّدة.
//   4) الإضافة الافتراضية `jekyll-optional-front-matter` (وهي في DEFAULT_PLUGINS
//      في github/pages-gem v231، أي مفعّلة بلا أن نطلبها) تحوّل كل ملف Markdown بلا
//      front matter إلى «صفحة» ذات رابط pretty ⇒ تُنشر api/properties/*.md مرتين:
//      نسخة حرفية صحيحة **و102 صفحة HTML مكرّرة** على /api/properties/<slug>/index.html
//      تدخل sitemap.xml وتتقدّم على واجهة JSON/Markdown. هذا ما كشفته بوابة
//      _diag/check-ai-layer-published.mjs في CI (102 ملفًا زائدًا في _site)،
//      والدرس أن الفحص كان محقًّا وأن الإصلاح في الإعداد لا في الفحص.
// ولا تُستعمل `require_front_matter` لإسكات الرابعة، لأنها تُفعّل معها
// `remove_originals` فتُحذف النسخ الأصلية من _site بدل نشرها حرفيًا.
//
// التشغيل:
//   node --test scripts/tests/publish-config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONFIG = fs.readFileSync(path.join(REPO_ROOT, "_config.yml"), "utf8");

/**
 * أسطر كتلة مفتاح على المستوى الأعلى من YAML (تعليقاتها وأسطرها الفارغة مسقَطة).
 * قارئ مبسّط مقصود: بلا أي حزمة، لأن النشر نفسه لا يعتمد على npm.
 * @param {string} key
 * @returns {string[] | null} أسطر الكتلة أو null إذا كان المفتاح غائبًا
 */
function blockLines(key) {
  const lines = CONFIG.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^([A-Za-z_][\w-]*):[ \t]*(#.*)?$/.exec(line);
    return match !== null && match[1] === key;
  });
  if (start === -1) return null;
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break; // مفتاح جديد على المستوى الأعلى
    collected.push(line.trim());
  }
  return collected;
}

/** عناصر قائمة YAML (`- x`) تحت مفتاح، بلا علامات التنصيص. */
function listEntries(key) {
  return (blockLines(key) ?? [])
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim().replace(/^['"]|['"]$/g, ""));
}

/** ملفات مسار معيّن داخل المستودع، منسوبة إلى جذر المستودع. */
function walk(relativeDir) {
  const absolute = path.join(REPO_ROOT, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  for (const name of fs.readdirSync(absolute).sort()) {
    const relative = path.join(relativeDir, name);
    if (fs.statSync(path.join(REPO_ROOT, relative)).isDirectory()) out.push(...walk(relative));
    else out.push(relative);
  }
  return out;
}

test("الإضافة الافتراضية jekyll-optional-front-matter مطفأة صراحةً", () => {
  const block = blockLines("optional_front_matter");
  assert.notEqual(block, null, "مفتاح optional_front_matter غائب عن _config.yml");
  assert.match(block.join("\n"), /^enabled:\s*false$/m, "يجب أن يكون enabled: false وإلا تحوّلت ملفات api/**/*.md إلى صفحات HTML");
  assert.doesNotMatch(block.join("\n"), /remove_originals:\s*true/, "remove_originals: true يحذف النسخ الأصلية من _site");
});

test("require_front_matter غير مستعمل (فهو يحذف النسخ الأصلية)", () => {
  const keys = CONFIG.split(/\r?\n/).map((line) => line.trim());
  assert.ok(!keys.some((line) => line.startsWith("require_front_matter:")));
});

test("include يصرّح بـ .well-known (Jekyll يتجاهل ما يبدأ بنقطة)", () => {
  assert.ok(listEntries("include").includes(".well-known"), "بدون include: .well-known تختفي بطاقة الوكلاء وai.txt");
});

test("keep_files يحمي المخرجات المولَّدة من إعادة البناء في نفس المجلد", () => {
  const kept = listEntries("keep_files");
  for (const entry of ["api", ".well-known", "llms-full.txt", "search-data.json", "ai-feed.json"]) {
    assert.ok(kept.includes(entry), `keep_files ينقصه ${entry}`);
  }
});

test("exclude لا يستبعد أي ملف من طبقة الذكاء", () => {
  const excluded = listEntries("exclude");
  for (const entry of ["api", ".well-known", "llms-full.txt", "llms.txt", "ai.txt", "mcp.json", "search-data.json"]) {
    assert.ok(!excluded.includes(entry), `${entry} مستبعد في _config.yml ⇒ لن يُنشر إطلاقًا`);
  }
});

test("ملفات وصف الوحدات المُلزَمة تبدأ بالتعليق الميكانيكي لا بـfront matter", () => {
  const docs = walk(path.join("api", "properties")).filter((file) => file.endsWith(".md"));
  assert.ok(docs.length > 0, "لا ملفات وصف في api/properties");
  for (const file of docs) {
    const head = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").slice(0, 32);
    assert.ok(!head.startsWith("---"), `${file}: يبدأ بـfront matter ⇒ سيتحول صفحة HTML`);
    assert.ok(head.startsWith("<!-- ai-property "), `${file}: تعليق الوصف الميكانيكي مفقود`);
  }
});
