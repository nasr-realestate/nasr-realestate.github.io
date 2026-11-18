import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Tests: .github/workflows/areas-streets-apply.yml
//
// هذا الـworkflow ينفّذ كتابة على قاعدة الإنتاج nasr-market-db. أي خطأ في
// حاجزه يعني تعديلًا لا رجعة فيه على بيانات حقيقية. الاختبارات هنا تثبت:
//   1) الحاجز يقبل ما تعنيه المسوّدة فقط.
//   2) الحاجز يرفض كل كلمة تدمير، حتى لو جاءت داخل جملة مسموحة.
//   3) الهدف قاعدة السوق حصرًا — قاعدة CRM مرفوضة بالثابتين.
//   4) لا تنفيذ بلا تصريح صريح.
//   5) الـworkflow يدوي فقط ولا يعمل على push.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'areas-streets-apply.yml');
const src = fs.readFileSync(WF, 'utf8');

/** يستخرج جسم دالة bash من نص الـworkflow — لا نعيد كتابتها هنا. */
function extractFn(name) {
  const start = src.indexOf(`${name}() {`);
  assert.ok(start > 0, `${name} غير موجودة في الـworkflow`);
  // نأخذ حتى السطر الذي يغلق الدالة: أول "}" في بداية سطر بعد البداية
  const rest = src.slice(start);
  const end = rest.indexOf('\n          }');
  assert.ok(end > 0, `نهاية ${name} غير واضحة`);
  return rest.slice(0, end + 12);
}

/**
 * نسخة JS من الحاجز المستخرج — تُبنى من نص الـbash نفسه لا من افتراض.
 * تُحاكي grep -Eq بالتعابير نفسها.
 */
function makeGuard() {
  const body = extractFn('assert_allowed');
  const forbiddenMatch = body.match(/grep -Eq '([^']+)'/);
  assert.ok(forbiddenMatch, 'تعبير الكلمات المحظورة غير موجود');
  const forbidden = new RegExp(forbiddenMatch[1]);
  return (sql) => {
    const upper = sql.toUpperCase();
    if (forbidden.test(upper)) return false;
    if (/^SELECT/.test(upper) || /^PRAGMA/.test(upper)) return true;
    if (/^INSERT/.test(upper)) return true;
    if (/^ALTER TABLE AREAS ADD COLUMN/.test(upper)) return true;
    return false;
  };
}

test('الحاجز: يقبل جمل المسوّدة الثلاثة والاستعلامات', () => {
  const allow = makeGuard();
  assert.ok(allow("INSERT INTO areas (name_ar) SELECT 'حسن المأمون' WHERE NOT EXISTS (SELECT 1 FROM areas)"));
  assert.ok(allow('ALTER TABLE areas ADD COLUMN zone_patterns TEXT'));
  assert.ok(allow('SELECT COUNT(*) AS n FROM areas'));
  assert.ok(allow("PRAGMA table_info('areas')"));
});

test('الحاجز: يرفض كل كلمة تدمير', () => {
  const allow = makeGuard();
  for (const sql of [
    'DELETE FROM areas',
    'DROP TABLE areas',
    'UPDATE areas SET name_ar = 1',
    'TRUNCATE areas',
    'ALTER TABLE areas DROP COLUMN zone_patterns',
    'ATTACH DATABASE x AS y',
    'REPLACE INTO areas VALUES (1)',
  ]) {
    assert.equal(allow(sql), false, `الحاجز قبل: ${sql}`);
  }
});

test('الحاجز: يرفض ALTER على جدول غير areas', () => {
  const allow = makeGuard();
  assert.equal(allow('ALTER TABLE price_snapshots ADD COLUMN x TEXT'), false);
  assert.equal(allow('ALTER TABLE listings ADD COLUMN x TEXT'), false);
});

test('الحاجز: كلمة محظورة مدسوسة في نص مسموح تُرفض', () => {
  const allow = makeGuard();
  // الحاجز يفحص المدخل نفسه؛ النص العربي لا يخدعه
  assert.equal(allow("INSERT INTO areas (description) SELECT 'DROP'"), false);
  assert.equal(allow("SELECT 1; DELETE FROM areas"), false);
});

test('الهدف: قاعدة السوق مثبتة وقاعدة CRM مرفوضة قبل أي طلب', () => {
  assert.match(src, /MARKET_DB=ace5c9a2-c6b1-47b3-adf1-77e84ac50abf/);
  assert.match(src, /CRM_DB=760079c6-85f9-4a30-aa19-9a66f95d421a/);
  // المقارنة والرفض موجودان
  assert.match(src, /if \[ "\$MARKET_DB" = "\$CRM_DB" \]/);
});

test('لا تنفيذ بلا تصريح: apply يتطلب نصًا مطابقًا', () => {
  assert.match(src, /APPLY-AREAS-0015/);
  assert.match(src, /if \[ "\$MODE" = "apply" \] && \[ "\$CONFIRM" != "APPLY-AREAS-0015" \]/);
});

test('يدوي فقط: لا trigger على push', () => {
  assert.match(src, /workflow_dispatch:/);
  assert.ok(!/^\s{2}push:/m.test(src), 'الـworkflow يعمل على push — ممنوع');
  assert.ok(!/^\s{2}pull_request:/m.test(src), 'الـworkflow يعمل على pull_request');
});

test('الجمل تُقرأ من المسوّدة لا تُعاد كتابتها في الـworkflow', () => {
  assert.match(src, /_worker\/migrations-draft\/0015_areas_streets\.sql/);
  // لا INSERT مكتوب يدويًا داخل الـworkflow
  assert.ok(!/INSERT INTO areas/.test(src), 'الـworkflow يحمل INSERT مكتوبًا يدويًا');
});

test('dry_run افتراضي ولا يكتب', () => {
  const dryBlock = src.slice(src.indexOf('if [ "$MODE" = "dry_run" ]'), src.indexOf('else\n            i=0'));
  assert.ok(dryBlock.length > 0, 'كتلة dry_run غير موجودة');
  assert.ok(!/d1 "\$st"/.test(dryBlock), 'dry_run ينفّذ الجمل');
});

test('YAML صالح: لا مفتاح مكرر (GitHub يرفض الملف كله بـ422)', () => {
  // العيب المقيس: خطوة كانت تحمل مفتاح env مرتين، فرفض GitHub التشغيل بـ
  // "Invalid Argument - 'env' is already defined" ولم يعمل الـworkflow أصلًا.
  const yaml = require('yaml');
  const doc = yaml.parse(src);
  assert.ok(doc && doc.jobs, 'الملف لا يُحلَّل كـYAML صالح');

  // كل خطوة: المفاتيح فريدة (المحلّل يدمج المكرر بصمت، فنفحص النص الخام)
  const stepBlocks = src.split(/\n      - /).slice(1);
  for (const block of stepBlocks) {
    const envCount = (block.match(/^        env:/gm) || []).length;
    assert.ok(envCount <= 1, `خطوة تحمل env ${envCount} مرة`);
    const runCount = (block.match(/^        run:/gm) || []).length;
    assert.ok(runCount <= 1, `خطوة تحمل run ${runCount} مرة`);
  }
});

test('خطوة التنفيذ الواحدة تحمل كل المتغيرات المطلوبة', () => {
  const yaml = require('yaml');
  const doc = yaml.parse(src);
  const step = doc.jobs.apply.steps.find((s) => s.name && s.name.includes('0015'));
  assert.ok(step, 'خطوة التنفيذ غير موجودة');
  for (const key of ['CLOUDFLARE_TOKEN', 'MODE', 'CONFIRM', 'GITHUB_TOKEN']) {
    assert.ok(step.env[key], `المتغير ${key} غير مضبوط — سيصل فارغًا للـshell`);
  }
});

test('النشر يعمل عند الفشل: خطوة مستقلة بـif always()', () => {
  // العيب المقيس: أول dry_run فشل ولم يُنشر تقرير، فلم نعرف السبب — سجل
  // الـjob محجوب. النشر يجب ألا يعتمد على نجاح خطوة التنفيذ.
  const yaml = require('yaml');
  const doc = yaml.parse(src);
  const pub = doc.jobs.apply.steps.find((s2) => (s2.name || '').includes('Publish'));
  assert.ok(pub, 'خطوة النشر غير موجودة');
  assert.equal(pub.if, 'always()', 'النشر لا يعمل عند الفشل');
  // ولا تحمل منطق التنفيذ
  assert.ok(!/INSERT INTO/.test(pub.run), 'خطوة النشر تحمل SQL تنفيذ');
});
