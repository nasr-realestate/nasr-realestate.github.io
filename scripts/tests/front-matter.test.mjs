// Tests: scripts/lib/front-matter.mjs — قارئ front matter المستقل
//
// سبب وجود الاختبار: خطوة التوليد في .github/workflows/deploy.yml تعمل
// **بلا npm إطلاقًا** — ليس لأن القفل معدوم (2026-10-16: صار محفوظًا
// ليعمل `npm ci` في CI بتثبيت قابل للتكرار، ويُغلق تنبيه SonarCloud S6505)، بل لأن نشر
// الموقع يجب ألا يعتمد على تثبيت حزم. لذلك يقرأ المُولّد الـfront matter بنفسه،
// وهذا الاختبار هو شبكة الأمان: يقارن مخرجات القارئ المستقل بـ gray-matter
// (المكتبة المعيارية) على **كل ملفات المستودع الفعلية**، فلا يمر خطأ قراءة صامت إلى النشر.
//
// التشغيل:
//   node --test scripts/tests/front-matter.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontMatter } from "../lib/front-matter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** gray-matter اختيارية: لو غير مثبتة نُتخطّى التكافؤ ونكتفي باختبارات الوحدة */
let matter = null;
try {
  matter = (await import("gray-matter")).default;
} catch {
  matter = null;
}

const reset = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

function realFiles() {
  const out = [];
  for (const dir of ["_properties", "_requests"]) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (f.endsWith(".md")) out.push({ rel: `${dir}/${f}`, abs: path.join(abs, f) });
    }
  }
  return out;
}

/* ─────────────────────────── وحدة ─────────────────────────── */

test("delimiters, quotes, comments, blank lines and scalars are handled", () => {
  const doc = [
    "---",
    "title: \"شقة 180م للبيع\"",
    "slug: '10th-district-180m'",
    "",
    "# هذا تعليق يجب أن يُتجاهل",
    "price: \"3,700,000 ج.م\"",
    "priceNumeric: 3700000",
    "areaNumeric: 180.5",
    "locked: false",
    "open: true",
    "missing:",
    "nothing: null",
    "tags: [a, b, \"c d\"]",
    "---",
    "",
    "المحتوى هنا",
  ].join("\n");

  const { data, content, hasFrontMatter } = parseFrontMatter(doc);
  assert.equal(hasFrontMatter, true);
  assert.equal(data.title, "شقة 180م للبيع");
  assert.equal(data.slug, "10th-district-180m");
  assert.equal(data.price, "3,700,000 ج.م");
  assert.equal(data.priceNumeric, 3700000);
  assert.equal(data.areaNumeric, 180.5);
  assert.equal(data.locked, false);
  assert.equal(data.open, true);
  assert.equal(data.missing, null);
  assert.equal(data.nothing, null);
  assert.deepEqual(data.tags, ["a", "b", "c d"]);
  assert.equal(content.trim(), "المحتوى هنا");
  assert.ok(!("عنوان" in data));
});

test("a '#' inside quotes is not treated as a comment", () => {
  const { data } = parseFrontMatter('---\ntitle: "وحدة # 12 في المربع"\nprice: 5000000 # سعر كاش\n---\n');
  assert.equal(data.title, "وحدة # 12 في المربع");
  assert.equal(data.price, 5000000, "a real trailing comment is dropped, the value survives");
});

test("files without front matter pass through untouched", () => {
  const out = parseFrontMatter("# عنوان\n\nنص");
  assert.equal(out.hasFrontMatter, false);
  assert.deepEqual(out.data, {});
  assert.equal(out.content, "# عنوان\n\nنص");
  assert.equal(parseFrontMatter("").hasFrontMatter, false);
  assert.equal(parseFrontMatter(null).hasFrontMatter, false);
});

test("an unterminated block does not swallow the body as front matter", () => {
  const out = parseFrontMatter("---\ntitle: x\n\nنص عادي بدون إغلاق");
  assert.equal(out.hasFrontMatter, false);
});

test("a BOM at the start of the file is tolerated", () => {
  const { data, hasFrontMatter } = parseFrontMatter('\uFEFF---\ntitle: "مع BOM"\n---\n');
  assert.equal(hasFrontMatter, true);
  assert.equal(data.title, "مع BOM");
});

/* ─────────────────────────── تكافؤ ─────────────────────────── */

test("parity with gray-matter on every real file in the repository", { skip: matter ? false : "gray-matter not installed — run `npm install`" }, () => {
  const files = realFiles();
  assert.ok(files.length > 90, `expected the real collections, found ${files.length} files`);

  const mismatches = [];
  for (const { rel, abs } of files) {
    const raw = fs.readFileSync(abs, "utf8");
    const expected = matter(raw).data;
    const actual = parseFrontMatter(raw).data;
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (JSON.stringify(reset(expected[key])) !== JSON.stringify(reset(actual[key]))) {
        mismatches.push(`${rel} · ${key} · gray-matter=${JSON.stringify(reset(expected[key]))} · independent=${JSON.stringify(reset(actual[key]))}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], "the dependency-free reader must agree with gray-matter on real content");
});

test("the generator and its libraries import nothing from outside node: builtins", () => {
  // هذا هو الضمان الذي يجعل خطوة النشر بلا `npm install` آمنة.
  const roots = [
    "scripts/lib/front-matter.mjs",
    "scripts/lib/properties.mjs",
    "scripts/lib/ai-docs.mjs",
    "scripts/build-ai-artifacts.mjs",
    "_worker/mcp-worker.js",
  ];
  for (const rel of roots) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    for (const m of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
      const spec = m[1];
      assert.ok(
        spec.startsWith("node:") || spec.startsWith("."),
        `${rel} imports "${spec}" — the deploy path must stay dependency-free`,
      );
    }
  }
});

test("the deploy path never runs npm, and CI now installs reproducibly from a committed lockfile", () => {
  // 1) القفل محفوظ في Git: بدونه يفشل `npm ci` وبقي التثبيت غير محدود الإصدارات.
  const ignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.doesNotMatch(ignore, /^package-lock\.json$/m, "the lockfile must be tracked, not ignored");
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "package-lock.json")),
    "package-lock.json must exist so that npm ci can resolve locked versions",
  );

  // 2) خطوة نشر الموقع تبقى بلا npm تمامًا.
  const deploy = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "deploy.yml"), "utf8");
  // نستبعد أسطر التعليقات: الملف يشرح سبب تجنّب npm، والشرح نفسه يذكر الكلمة.
  const commands = deploy
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(commands, /npm (ci|install)/, "deploy.yml must never run npm");
  assert.doesNotMatch(commands, /cache:\s*["']?npm/, "the site deploy does not need npm caching");
  assert.match(commands, /scripts\/build-ai-artifacts\.mjs --out=_site/);

  // 3) مهام CI/الأدوات تستخدم `npm ci` (مقدّر بالقفل) لا `npm install`.
  const tests = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "tests.yml"), "utf8");
  const testCommands = tests
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.match(testCommands, /npm ci/, "CI must install from the committed lockfile");
  assert.doesNotMatch(testCommands, /npm install/, "unlocked installs are what SonarCloud S6505 flags");
});
