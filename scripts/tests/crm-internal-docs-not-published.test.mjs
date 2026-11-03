// Tests: وثائق CRM الداخلية لا تُنشر على Pages — وتبقى محفوظة في Git
//
// سبب وجود الاختبار (قيس، لا استنتاج): ملفات الجذر بلا front matter لا تولّد «صفحة» عند
// Jekyll لأن `optional_front_matter` معطّل هنا، لكنها تظل **ملفات ساكنة تُنسخ حرفيًا** إلى
// `_site`. النتيجة المقاسة في 2026-11-03: `https://nasr-realestate.github.io/CRM_PHASE4_REVIEW_SECURITY.md`
// كان يرجع 200 بكامل نصّه — أي أن تقارير المراجعة الأمنية وخطط الترحيل ودليل التشغيل كانت
// عامة. لا بيانات عملاء فيها، لكنها تصف الحواجز وأسماء قواعد الاختبار ومسارات CI وأرقامه، وهو
// ما لا يُراد نشره. الاستبعاد هو الإصلاح؛ والحراسة هنا حتى لا يُضاف `CRM_*.md` جديد عند الجذر
// وينسى صاحبه الاستبعاد، وحتى لا «يُحلّ» الأمر بحذف الوثائق نفسها.
//
// التشغيل:
//   node --test scripts/tests/crm-internal-docs-not-published.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONFIG = fs.readFileSync(path.join(REPO_ROOT, "_config.yml"), "utf8");

/** قائمة الإدخالات تحت مفتاح أعلى المستوى في _config.yml (قارئ مبسّط بلا حزم، كما في publish-config). */
function listEntries(key) {
  const lines = CONFIG.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^${key}:[ \\t]*(#.*)?$`).test(line));
  assert.ok(start >= 0, `${key} مفقود من _config.yml`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:/.test(line)) break;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) out.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

/** ملفات CRM الجذرية: ما يبدأ بـ`CRM_` وينتهي بـ`.md` في جذر المستودع فقط. */
function rootCrmDocs() {
  return fs.readdirSync(REPO_ROOT)
    .filter(name => /^CRM_.*\.md$/.test(name) && fs.statSync(path.join(REPO_ROOT, name)).isFile())
    .sort();
}

test("كل وثيقة CRM داخلية في الجذر مستبعدة من بناء Pages", () => {
  const docs = rootCrmDocs();
  assert.ok(docs.length >= 14, `متوقع 14 وثيقة على الأقل، والعدد ${docs.length} — القائمة اختزلت؟`);
  const excluded = listEntries("exclude");
  for (const doc of docs) {
    assert.ok(excluded.includes(doc), `${doc} ليست في exclude ⇒ Jekyll سينسخها حرفيًا إلى _site`);
  }
});

test("وثائق الحوكمة والإحالة تبقى مستبعدة (pin ضد النسيان)", () => {
  const excluded = listEntries("exclude");
  for (const doc of ["AGENTS.md", "README.md", "CRM_DATA_GOVERNANCE.md"]) {
    assert.ok(excluded.includes(doc), `${doc} لم تعد مستبعدة`);
  }
});

test("الاستبعاد لا يترك رابطًا معطوبًا: لا إحالة عامة إلى وثائق CRM في الطبقة المنشورة", () => {
  const publishedSources = ["_includes", "_layouts", "api"].map(dir => path.join(REPO_ROOT, dir));
  const stray = [];
  for (const dir of publishedSources) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!/\.(html|md|txt|json|js|yml)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("CRM_PHASE") || text.includes("CRM_A5_GO_LIVE")) {
          stray.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  for (const file of ["llms.txt", "ai.txt", "mcp.json", "llms-full.txt"]) {
    const full = path.join(REPO_ROOT, file);
    if (fs.existsSync(full) && /CRM_(PHASE|A5)/.test(fs.readFileSync(full, "utf8"))) stray.push(file);
  }
  assert.deepEqual(stray, [], `إحالات إلى وثائق مستبعدة ستصبح 404: ${stray.join(", ")}`);
});

test("الإصلاح استبعادٌ لا حذف: الوثائق ماثلة في المستودع وبلا front matter", () => {
  const docs = rootCrmDocs();
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(REPO_ROOT, doc), "utf8");
    assert.ok(!text.startsWith("---"), `${doc} يبدأ بـfront matter فيتحوّل إلى «صفحة» بدل ملف ساكن`);
    assert.ok(text.length > 400, `${doc} قصيرة بدرجة تجعلها غير مفيدة كأرشيف`);
  }
});
