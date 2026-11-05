// Tests: سقف محكم لقواعد SonarJS الحاجزة (2026-11-05)
//
// المشكلة المقيسة: `npm run lint:sonar` (= `eslint .`) يفشل بـ412 خطأ في 44 ملفًا،
// ولا يشغّله أي سير عمل — أي أن طقم القواعد الذي وُضع ليُشبه بوابة SonarCloud
// صار **غير مربوط بأي حاجز**، وانحرف بلا أن يلاحظه أحد: القاعدة
// `sonarjs/super-linear-regex` (S5852 — تعبير نمطي متغيّر التراجع، تصنيف أمان)
// عادت 26 مرة بعد أن أُصلحت في 2026-10-16، بينما ظل تعليق `eslint.config.mjs`
// يعلن أنها صفر.
//
// لماذا «سقف» لا «صفر»؟ لأن تصفير 412 رائحة كود الآن يحتاج إعادة كتابة ملفات
// إنتاجية بلا مبرر وظيفي — بينما الخطر الحقيقي هو **الجديد** الذي يدخل. السقف
// يمنع الزيادة فورًا، ويُخفَّض رقمه فقط بعد إصلاح فعلي (لا بتعديله).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** الأرقام المقيسة في 2026-11-05 على master (لا تُرفع؛ تُخفَّض بعد إصلاح). */
const BUDGET = {
  'sonarjs/super-linear-regex': 26,
  'sonarjs/no-alphabetical-sort': 0,
  total: 412,
};

function eslintJson() {
  const bin = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  // eslint يخرج بـ1 عند وجود أخطاء، والـJSON يبقى على stdout — لذا spawnSync لا execFileSync.
  const res = spawnSync(process.execPath, [bin, '.', '-f', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(res.error, undefined, 'تعذّر تشغيل eslint (هل npm ci نُفّذ؟)');
  assert.ok(res.stdout && res.stdout.trim().startsWith('['), `مخرَج eslint غير متوقع:\n${(res.stderr || '').slice(0, 500)}`);
  return JSON.parse(res.stdout);
}

test('قواعد SonarJS الحاجزة لا تتجاوز سقفها، والإجمالي لا يزيد', () => {
  const results = eslintJson();
  const counts = {};
  let total = 0;
  for (const file of results) {
    for (const message of file.messages) {
      const rule = message.ruleId || '(fatal)';
      counts[rule] = (counts[rule] || 0) + 1;
      total += 1;
    }
  }

  for (const [rule, budget] of Object.entries(BUDGET)) {
    if (rule === 'total') continue;
    const actual = counts[rule] || 0;
    assert.ok(
      actual <= budget,
      `${rule}: ${actual} > السقف ${budget} — كود جديد خالف قاعدة حاجزة. أصلح الموضع، أو (إن كان الإصلاح مؤجلًا بقرار) ارفع السقف في نفس الـcommit مع تبرير مكتوب.`,
    );
  }
  assert.ok(
    Number.isInteger(BUDGET.total) && total <= BUDGET.total,
    `إجمالي أخطاء الطقم ${total} > السقف ${BUDGET.total} — لا تُضاف روائح جديدة بلا قرار.`,
  );
});

test('السقف ليس أعمى: القاعدتان معلنتان صراحةً في eslint.config.mjs', () => {
  const cfg = readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8');
  for (const rule of ['sonarjs/super-linear-regex', 'sonarjs/no-alphabetical-sort']) {
    assert.match(cfg, new RegExp(rule.replace('/', '\\/')), `${rule} غير معلنة صراحةً في التهيئة`);
  }
});
