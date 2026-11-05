#!/usr/bin/env node
// تنظيف الصفوف الصناعية القديمة من قاعدة الاختبار — بـ**نفس** تعريفات بوابة A5 L2.
//
// المشكلة المقيسة (2026-11-05): التشغيل 42107203775 توقف عند بوابة L2 بـ:
//   unknown-ownership:crm_contacts:unknown:legacy-unproven  · rows=35 · legacy_suspects=35
// والكود يقول صراحةً في a5-l2.mjs أن الصفوف القديمة **لا يمكن إثباتها أبدًا**
// (ليست في TABLE_SPECS، فـ buildLedger لا يستطيع التصديق عليها). أي أن تلك القاعدة
// لن تُشغّل A5 أبدًا ما دامت هذه الصفوف فيها.
//
// وهذا السكربت هو طريق الخروج الوحيد غير المدمِّر للمخطط: يحذف **بالضبط** الصفوف التي
// تسمّيها البوابة، مستوردًا `LEGACY_PROBES` من `a5-l2.mjs` نفسِه — لا نسخة ثانية من الشروط،
// فلا يمكن أن يتباعد ما نحذفه عمّا تفحصه البوابة.
//
// الضوابط:
//   * الافتراضي **عدّ فقط** (dry-run). لا حذف بلا `--apply` **و** `CRM_CLEANUP_APPLY=1`.
//   * الهدف قاعدة الاختبار وحدها: `assertTestOnlyConfig()` من a5-live-support (يرفض الإنتاج).
//   * سقف أمان: أكثر من 500 صف ⇒ رفض كامل، لأن هذا لم يعد "نطاقًا صناعيًا معروفًا".
//   * عدّ قبل، حذف بترتيب معاكس (الأبناء قبل الآباء) لاحترام المفاتيح الأجنبية، عدّ بعد.
//   * الحذف بـ WHERE شرط كل probe — لا `DELETE FROM table` عارية، ولا DDL إطلاقًا.
//   * السجل: السكربت يطبع ملخّصًا واحدًا (عدد قبل/محذوف/بعد لكل جدول) وهذا هو سجل العملية؛
//     لا نكتب صفًا في crm_operational_audit_log لأن قيود CHECK فيه صارمة، وإدراج خاطئ
//     بعد الحذف يُفشل التشغيل في أسوأ لحظة. الملخّص المطبوع + artefact الجلسة كافيان.
import {
  LEGACY_PROBES,
} from '../a5-l2.mjs';
import {
  TEST_DB_UUID,
  TEST_DB_NAME,
  PROD_DB_UUID,
  PROD_DB_NAME,
  assertTestOnlyConfig,
} from '../a5-live-support.mjs';

const API = process.env.CRM_A5_CF_API || 'https://api.cloudflare.com/client/v4';
const APPLY_ENV = 'CRM_CLEANUP_APPLY';
const APPLY_VALUE = '1';
const MAX_ROWS_SAFETY = 500;

const apply = process.argv.slice(2).includes('--apply');
const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const log = (message) => process.stderr.write(`legacy-cleanup: ${message}\n`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}

async function cfGet(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) {
    throw new Error(`cf-get:http=${response.status}`);
  }
  return body;
}

async function accountId() {
  const body = await cfGet('/accounts?per_page=100');
  const accounts = Array.isArray(body.result) ? body.result : [];
  if (accounts.length !== 1) throw new Error(`accounts-count:${accounts.length}`);
  return accounts[0].id;
}

async function query(account, sql) {
  const response = await fetch(`${API}/accounts/${account}/d1/database/${TEST_DB_UUID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) {
    const message = String(body?.errors?.[0]?.message ?? `http-${response.status}`).slice(0, 120);
    throw new Error(`d1:${message}`);
  }
  return body.result?.[0] ?? {};
}

async function countWhere(account, probe) {
  const result = await query(account, `SELECT COUNT(*) AS n FROM ${probe.table} WHERE ${probe.where}`);
  const value = Number(result?.results?.[0]?.n);
  if (!Number.isFinite(value)) throw new Error(`count-shape:${probe.table}`);
  return value;
}

async function main() {
  // Guards first: nothing below runs if the target is not the test database.
  assertTestOnlyConfig();
  if (TEST_DB_UUID === PROD_DB_UUID || TEST_DB_NAME === PROD_DB_NAME) {
    throw new Error('target-is-production');
  }
  if (apply && process.env[APPLY_ENV] !== APPLY_VALUE) {
    throw new Error(`apply-flag-missing:${APPLY_ENV}=${APPLY_VALUE}`);
  }

  const account = await accountId();

  const before = [];
  let beforeTotal = 0;
  for (const probe of LEGACY_PROBES) {
    const rows = await countWhere(account, probe);
    before.push({ table: probe.table, label: probe.label, rows });
    beforeTotal += rows;
  }

  if (beforeTotal > MAX_ROWS_SAFETY) {
    throw new Error(`refused:${beforeTotal}-rows-exceeds-safety-${MAX_ROWS_SAFETY}`);
  }

  if (!apply) {
    emit({ mode: 'dry-run', target: TEST_DB_NAME, before_total: beforeTotal, tables: before });
    log(`dry-run: ${beforeTotal} row(s) in scope on ${TEST_DB_NAME}; nothing deleted`);
    return 0;
  }

  // Children before parents: LEGACY_PROBES is ordered parent → child, so delete in reverse.
  const deleted = [];
  for (const probe of [...LEGACY_PROBES].reverse()) {
    const result = await query(account, `DELETE FROM ${probe.table} WHERE ${probe.where}`);
    const changes = Number(result?.meta?.changes ?? 0);
    if (!Number.isFinite(changes)) throw new Error(`delete-meta-missing:${probe.table}`);
    deleted.push({ table: probe.table, deleted: changes });
  }

  const after = [];
  let afterTotal = 0;
  for (const probe of LEGACY_PROBES) {
    const rows = await countWhere(account, probe);
    after.push({ table: probe.table, rows });
    afterTotal += rows;
  }

  const deletedTotal = deleted.reduce((sum, item) => sum + item.deleted, 0);
  emit({
    mode: 'apply',
    target: TEST_DB_NAME,
    before_total: beforeTotal,
    deleted_total: deletedTotal,
    after_total: afterTotal,
    deleted,
    after,
  });
  log(`apply: before=${beforeTotal} deleted=${deletedTotal} after=${afterTotal}`);
  return afterTotal === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    log(`STOP ${String(error?.message || error).slice(0, 160)}`);
    process.exitCode = 1;
  });
