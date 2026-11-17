// Tests: workflow جرد جدول الأسعار (price-snapshots-audit.yml)
//
// الحاجة التي أُنشئت لها (2026-11-17): محرّك التقييم يحسب من price_snapshots،
// ولا يوجد في المستودع أي مسار كتابة لهذا الجدول. قبل أي إصلاح لا بد من قياس:
// كام صف، آخر تحديث امتى، وكام منطقة عندها أرقام فعلية.
//
// هذا الملف يثبّت أمرين لا ثالث لهما:
//   ١) الـworkflow لا يستطيع الكتابة — الحاجز يرفض كل كلمة كتابة ككلمة كاملة.
//   ٢) الـworkflow لا يستهدف قاعدة العملاء.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'price-snapshots-audit.yml');
const yml = fs.readFileSync(WORKFLOW, 'utf8');

/** يستخرج assert_read_only كما هو مكتوب (نفس نمط crm-daily-kpi-barrier). */
function barrierSource() {
  const start = yml.indexOf('assert_read_only() {');
  assert.ok(start > -1, 'assert_read_only غير موجود');
  const end = yml.indexOf('\n          }', start);
  assert.ok(end > start);
  return yml
    .slice(start, end + '\n          }'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

function runBarrier(sql) {
  const script = `${barrierSource()}\nassert_read_only ${JSON.stringify(sql)}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' }).status;
}

test('الحاجز يسمح بالاستعلامات التي يستخدمها الجرد فعلًا', () => {
  for (const sql of [
    'SELECT COUNT(*) AS rows_total FROM price_snapshots',
    'SELECT COUNT(DISTINCT area_id) AS areas_with_prices FROM price_snapshots',
    'SELECT MIN(observed_at) AS oldest, MAX(observed_at) AS newest FROM price_snapshots',
    "SELECT substr(observed_at,1,7) AS month, COUNT(*) AS n FROM price_snapshots GROUP BY month ORDER BY month DESC LIMIT 12",
    "SELECT COUNT(*) AS n FROM price_snapshots WHERE observed_at >= date('now','-30 day')",
  ]) {
    assert.equal(runBarrier(sql), 0, `رُفض استعلام سليم: ${sql}`);
  }
});

test('الحاجز يرفض كل كلمة كتابة ككلمة كاملة', () => {
  for (const sql of [
    'DELETE FROM price_snapshots',
    'UPDATE price_snapshots SET price = 1',
    'INSERT INTO price_snapshots VALUES (1)',
    'DROP TABLE price_snapshots',
  ]) {
    assert.notEqual(runBarrier(sql), 0, `سُمح بكتابة: ${sql}`);
  }
});

test('الحاجز يرفض الجمل المتسلسلة', () => {
  assert.notEqual(runBarrier('SELECT 1; DROP TABLE price_snapshots'), 0);
});

test('الـworkflow لا يحمل أي أمر كتابة d1', () => {
  // أي `d1 execute` مع SQL غير SELECT، أو أي كلمة كتابة خارج نص الحاجز
  assert.doesNotMatch(yml, /wrangler@4 d1 (execute|export)/, 'الـworkflow يستخدم wrangler لقاعدة البيانات — ممنوع');
  // نلتقط نداءات الاستعلام الحقيقية فقط: `q "SELECT ..."` — لا توثيق الدالة
  // (`q() { # q "<SELECT>" "<label>" }`) الذي يظهر بنفس الشكل النصي.
  const sqlCalls = [...yml.matchAll(/^\s+q "(SELECT [^"]+)"/gm)].map((m) => m[1]);
  assert.ok(sqlCalls.length >= 5, `لم تُعثر على استعلامات الجرد (${sqlCalls.length})`);
  for (const sql of sqlCalls) {
    assert.match(sql, /^SELECT /, `استعلام ليس SELECT: ${sql}`);
  }
});

test('الهدف هو قاعدة العقارات، وقاعدة العملاء مرفوضة صراحةً', () => {
  assert.match(yml, /MARKET_DB=ace5c9a2-c6b1-47b3-adf1-77e84ac50abf/);
  assert.match(yml, /CRM_DB=760079c6-85f9-4a30-aa19-9a66f95d421a/);
  assert.match(yml, /if \[ "\$MARKET_DB" = "\$CRM_DB" \]/, 'حارس تطابق الثابتين مفقود');
});

test('يدوي فقط — لا push trigger', () => {
  assert.match(yml, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(yml, /^\s{2}push:/m, 'trigger تلقائي على push — ممنوع لملف يلمس قاعدة حقيقية');
});

test('لا يطبع حقولًا نصية حرة من الجدول', () => {
  // الجرد أعداد وتواريخ وتجميعات فقط؛ لا title ولا description ولا address.
  const sqlCalls = [...yml.matchAll(/^\s+q "(SELECT [^"]+)"/gm)].map((m) => m[1]).join(' ');
  for (const forbidden of ['title', 'description', 'address', 'raw_data']) {
    assert.ok(!sqlCalls.includes(forbidden), `استعلام الجرد يقرأ ${forbidden}`);
  }
});
