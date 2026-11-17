// Tests: تطابق market-data.json مع قائمة مناطق الـworker
//
// الحالة المقيسة (2026-11-17): الملف المنشور كان 20 منطقة، والـworker الحقيقي
// (noisy-bush-fd84 v6.2) يعرف 31. أداة التقييم تعرض المناطق من هذا الملف
// والـworker يقيس عليها — فأي منطقة في الـworker وليست في الملف لا تظهر
// للمستخدم أبدًا، وأي منطقة في الملف وليست في الـworker تُنتج unknown_area.
//
// الملف يحتوي MORE than names (فيه أسعار). لكن المتصفح يقرأ 4 حقول فقط:
// name · level_ar · landmarks · main_streets (tools/valuation.html:833).
// هذه الاختبارات تثبّت أن الإضافة لا تُخترع لها أسعار، وأن التوحيد لا يُفقد وصفًا.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaAliasKey, reconcile, normalizeWorkerAreas, ALIASES } from '../sync-market-areas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKET = path.join(ROOT, 'assets', 'data', 'market-data.json');
const read = () => JSON.parse(fs.readFileSync(MARKET, 'utf8'));

/** قائمة الـworker v6.2 كما جُلبت فعليًا في 2026-11-17 (لقطة ثابتة للاختبار). */
const WORKER_SNAPSHOT = [
  [1, 'مدينة نصر (ككل)', 'city'], [2, 'الحي الأول', 'district'], [3, 'الحي الثاني', 'district'],
  [4, 'الحي الثالث', 'district'], [5, 'الحي الرابع', 'district'], [6, 'الحي الخامس', 'district'],
  [7, 'الحي السادس', 'district'], [8, 'الحي السابع', 'district'], [9, 'الحي الثامن', 'district'],
  [10, 'الحي التاسع', 'district'], [11, 'الحي العاشر', 'district'], [12, 'الحي الحادي عشر', 'district'],
  [13, 'الحي الثاني عشر', 'district'], [14, 'الحي الدبلوماسي', 'district'], [15, 'الواحة', 'district'],
  [16, 'زهراء مدينة نصر', 'district'], [17, 'المنطقة الأولى', 'zone'], [18, 'المنطقة الثانية', 'zone'],
  [19, 'المنطقة الثالثة', 'zone'], [20, 'المنطقة الرابعة', 'zone'], [21, 'المنطقة الخامسة', 'zone'],
  [22, 'المنطقة السادسة', 'zone'], [23, 'المنطقة السابعة', 'zone'], [24, 'المنطقة الثامنة', 'zone'],
  [25, 'المنطقة التاسعة', 'zone'], [26, 'المنطقة العاشرة', 'zone'], [27, 'المنطقة الحادية عشرة', 'zone'],
  [28, 'المنطقة الثانية عشرة', 'zone'], [29, 'ممر مكرم عبيد', 'corridor'], [30, 'ممر عباس العقاد', 'corridor'],
  [31, 'رابعة العدوية', 'market_area'],
].map(([id, name, scope]) => ({ id, name, scope }));

test('كل منطقة في قائمة الـworker مغطاة في الملف', () => {
  const keys = new Set(read().areas.map((a) => areaAliasKey(a.name)));
  const missing = WORKER_SNAPSHOT.filter((w) => !keys.has(areaAliasKey(w.name))).map((w) => w.name);
  assert.deepEqual(missing, [], `مناطق في الـworker ولا تظهر في أداة التقييم: ${missing.join(' · ')}`);
});

test('لا منطقة في الملف تحمل معرّف worker خاطئًا', () => {
  const byKey = new Map(WORKER_SNAPSHOT.map((w) => [areaAliasKey(w.name), w]));
  for (const area of read().areas) {
    if (area.in_worker === false) continue;
    const hit = byKey.get(areaAliasKey(area.name));
    assert.ok(hit, `${area.name}: in_worker=true لكنها ليست في قائمة الـworker`);
    assert.equal(area.worker_id, hit.id, `${area.name}: worker_id=${area.worker_id} والصحيح ${hit.id}`);
    assert.equal(area.worker_scope, hit.scope, `${area.name}: worker_scope خاطئ`);
  }
});

test('المناطق المضافة بلا أسعار مُختلقة — البند الغائب يبقى null', () => {
  const added = read().areas.filter((a) => a.notes && a.notes.includes('أُضيفت من قائمة الـworker'));
  assert.ok(added.length > 0, 'لا توجد مناطق مضافة — الاختبار فقد حالته');
  for (const a of added) {
    assert.equal(a.sale.apartment, null, `${a.name}: سعر مُختلق`);
    assert.equal(a.verified, false, `${a.name}: وُسمت موثقة بلا تحقق`);
    assert.deepEqual(a.landmarks, [], `${a.name}: معالم مُختلقة`);
    assert.deepEqual(a.main_streets, [], `${a.name}: شوارع مُختلقة`);
    assert.match(a.data_source, /names only, no prices/);
  }
});

test('إعادة التشغيل idempotent — لا تكرار ولا تغيير عند نفس المدخل', () => {
  const current = read();
  const once = reconcile(current, WORKER_SNAPSHOT, '2026-11-17T21:45:00.000Z').market;
  const twice = reconcile(once, WORKER_SNAPSHOT, '2026-11-17T21:45:00.000Z').market;
  assert.deepEqual(twice.areas.map((a) => a.name), once.areas.map((a) => a.name), 'التشغيل الثاني أضاف مناطق');
  assert.equal(new Set(twice.areas.map((a) => areaAliasKey(a.name))).size, twice.areas.length, 'اسم مكرر بعد التطبيع');
});

test('التوحيد الإملائي يحفظ الوصف الحقيقي ولا يفقده', () => {
  const areas = read().areas;
  const sixth = areas.find((a) => a.name === 'المنطقة السادسة');
  assert.ok(sixth.landmarks.length > 0, 'وصف المنطقة السادسة فُقد');
  // «حي السفارات» كان له وصف — يجب أن يكون انتقل إلى «الحي الدبلوماسي»
  const dip = areas.find((a) => a.name === 'الحي الدبلوماسي');
  assert.ok(dip, 'الحي الدبلوماسي غير موجود بعد التوحيد');
  assert.ok(dip.in_worker !== false);
});

test('منطقة في الملف وليست في الـworker تُعلَّم ولا تُحذف', () => {
  const odd = read().areas.filter((a) => a.in_worker === false);
  assert.ok(odd.length > 0, 'الاختبار فقد حالته — لا منطقة خارج القائمة');
  for (const a of odd) assert.ok(a.name, 'منطقة بلا اسم');
  const keys = odd.map((a) => a.name);
  assert.ok(keys.includes('الوفاء والأمل'), 'الوفاء والأمل حُذفت من الملف');
});

test('الفهارس محسوبة لا مكتوبة يدويًا', () => {
  const m = read();
  const inWorker = m.areas.filter((a) => a.in_worker !== false).length;
  assert.equal(m.coverage.total_areas, m.areas.length);
  assert.equal(m.coverage.areas_in_worker, inWorker);
  assert.equal(m.coverage.areas_not_in_worker, m.areas.length - inWorker);
  assert.equal(m.coverage.areas_without_prices, m.areas.filter((a) => !a.sale || !a.sale.apartment).length);
  // التوثيق لا يرتفع بعدد المناطق: الإضافة ليست تحققًا
  assert.equal(m.coverage.verified_areas, m.areas.filter((a) => a.verified === true).length);
});

test('الـworker الحقيقي لم يعد يستخدم مصدرًا تقديريًا', () => {
  const src = read().data_sources || [];
  assert.ok(!src.some((s) => /Gemini/i.test(s)), 'مصدر تقديري ما زال معلنًا كمصدر بيانات');
});

test('normalizeWorkerAreas يرفض الحمولات غير الصالحة', () => {
  assert.throws(() => normalizeWorkerAreas({}), /available_areas/);
  assert.equal(normalizeWorkerAreas({ available_areas: [{ id: 1, name_ar: 'س', scope: 'zone' }] }).length, 1);
  assert.equal(normalizeWorkerAreas([{ id: 1, name: 'س', scope: 'zone' }]).length, 1);
});

test('البدائل كلها تشير إلى أسماء موجودة في قائمة الـworker', () => {
  const names = new Set(WORKER_SNAPSHOT.map((w) => areaAliasKey(w.name)));
  for (const [from, to] of Object.entries(ALIASES)) {
    if (to === null) continue;
    assert.ok(names.has(areaAliasKey(to)), `البديل «${from}» يشير إلى «${to}» غير موجود في الـworker`);
  }
});
