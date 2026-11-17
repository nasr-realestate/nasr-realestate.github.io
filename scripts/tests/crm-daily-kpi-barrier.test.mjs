// Tests: حاجز القراءة فقط في `crm-daily-kpi.yml`
//
// الخطأ المقيس (2026-11-17، التشغيل 44132622848): كان الحاجز يطابق كلمات الكتابة
// كـ**سلاسل فرعية**، فرفض كل استعلام سليم على العمود `created_at` لأنها تحتوي
// `CREATE`. الحاجز الذي يرفض القراءة التي وُجد ليسمح بها عطل لا حاجز.
//
// هذا الملف يستخرج `assert_read_only()` من الـworkflow نفسه ويشغّلها فعليًا في
// bash، فإن رجع أحدهم إلى المطابقة بالسلسلة الفرعية يسقط الاختبار.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'crm-daily-kpi.yml');

/** يستخرج نص `assert_read_only()` كما هو مكتوب في الـworkflow. */
function barrierSource() {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const start = yml.indexOf('assert_read_only() {');
  assert.ok(start > -1, 'assert_read_only غير موجود في الـworkflow');
  const end = yml.indexOf('\n          }', start);
  assert.ok(end > start, 'نهاية assert_read_only غير واضحة');
  return yml
    .slice(start, end + '\n          }'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

/** يشغّل الحاجز في bash ويُعيد كود الخروج. */
function runBarrier(sql) {
  const script = `${barrierSource()}\nassert_read_only ${JSON.stringify(sql)}`;
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test('الحاجز يسمح باستعلام سليم على عمود يحتوي «CREATE»', () => {
  for (const sql of [
    'SELECT COUNT(*) AS n FROM crm_contacts',
    "SELECT COUNT(*) AS n FROM crm_contacts WHERE datetime(created_at) > datetime('2026-11-17 00:00:00')",
    "SELECT COUNT(*) AS won FROM crm_opportunities WHERE status='won'",
    'SELECT COUNT(*) AS n FROM crm_interactions WHERE next_followup_at IS NOT NULL',
  ]) {
    const { code, out } = runBarrier(sql);
    assert.equal(code, 0, `رُفض استعلام سليم: ${sql}\n${out}`);
  }
});

test('الحاجز يرفض كل كلمة كتابة ككلمة كاملة', () => {
  for (const sql of [
    'DELETE FROM crm_contacts',
    'UPDATE crm_contacts SET name = 1',
    'INSERT INTO crm_contacts VALUES (1)',
    'DROP TABLE crm_contacts',
    'PRAGMA table_info(crm_contacts)',
    'CREATE TABLE t (a)',
    'ATTACH DATABASE x AS y',
    'VACUUM',
  ]) {
    const { code } = runBarrier(sql);
    assert.notEqual(code, 0, `سُمح بكتابة: ${sql}`);
  }
});

test('الحاجز يرفض أي جملة متسلسلة بفاصلة منقوطة', () => {
  const { code } = runBarrier('SELECT 1; DROP TABLE x');
  assert.notEqual(code, 0);
});

test('الحاجز يرفض ما لا يبدأ بـSELECT', () => {
  const { code } = runBarrier('EXPLAIN SELECT 1');
  assert.notEqual(code, 0);
});

test('قاعدة الإنتاج ثابت رفض وحيد لا هدف، والإعداد مربوط بقاعدة الاختبار', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /760079c6-85f9-4a30-aa19-9a66f95d421a/, 'قاعدة الاختبار يجب أن تكون مذكورة صراحةً');

  const prodId = 'ace5c9a2-c6b1-47b3-adf1-77e84ac50abf';
  const occurrences = yml.split(prodId).length - 1;
  assert.equal(occurrences, 1, 'معرّف الإنتاج يجب أن يظهر كثابت رفض وحيد فقط');

  const cfg = readFileSync(path.join(ROOT, '_worker', 'wrangler.crm.toml'), 'utf8');
  assert.ok(!cfg.includes(prodId), 'الإعداد مربوط بقاعدة إنتاج');
  assert.ok(cfg.includes('760079c6-85f9-4a30-aa19-9a66f95d421a'), 'الإعداد ليس مربوطًا بقاعدة الاختبار');
});
