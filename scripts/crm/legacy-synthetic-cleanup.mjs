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
  residueProbes,
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

// Optional second scope: the residue of ONE named failed run (2026-11-07). Run 42292458694 wrote
// its synthetic rows and then could not publish a ledger, so nothing can ever prove them and they
// are outside the legacy namespace. The scope is still IMPORTED (a5-l2.mjs owns the key
// conventions), still counted on both sides, still dry-run by default, and still capped.
// An exact run tag is required: no wildcards, no prefixes, no dates.
function scopedProbes() {
  const tag = String(process.env.CRM_CLEANUP_RUN_TAG || '').trim();
  if (!tag) return { probes: LEGACY_PROBES, scope: 'legacy' };
  const current = process.env.GITHUB_RUN_ID
    ? `a5-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
    : '';
  if (current && tag.startsWith(current)) {
    throw new Error('refused:residue-scope-targets-this-very-run');
  }
  return { probes: residueProbes(tag), scope: `residue:${tag}` };
}

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

const MAX_PASSES = 6;

async function countAll(account, probes) {
  const rows = [];
  let total = 0;
  for (const probe of probes) {
    const n = await countWhere(account, probe);
    rows.push({ table: probe.table, label: probe.label, rows: n });
    total += n;
  }
  return { rows, total };
}

// The delete order is NOT inferred from the list order. Live evidence, run 42222015132: the first
// statement died because `crm_drive_file_review_decision.case_ref` references
// `crm_drive_file_review_case(case_ref)` ON DELETE RESTRICT, while LEGACY_PROBES lists the decision
// BEFORE the case — so reversing the list deleted the parent first. Dependency is a fact of the
// schema, not of an array, so this stops guessing: it retries, and a row that cannot go yet is
// simply picked up by the next pass. It ends when a whole pass makes no progress.
async function deleteAll(account, probes) {
  let pending = [...probes].reverse().map((probe) => ({ probe, error: null }));
  const deleted = [];
  for (let pass = 1; pass <= MAX_PASSES && pending.length > 0; pass += 1) {
    const attempt = await deletePass(account, pending, pass, deleted);
    pending = attempt.blocked;
    if (!attempt.progressed) break;
  }
  return { deleted, pending };
}

async function deletePass(account, pending, pass, deleted) {
  const blocked = [];
  let progressed = false;
  for (const { probe } of pending) {
    try {
      const result = await query(account, `DELETE FROM ${probe.table} WHERE ${probe.where}`);
      const changes = Number(result?.meta?.changes ?? 0);
      if (!Number.isFinite(changes)) throw new Error('delete-meta-missing');
      deleted.push({ table: probe.table, deleted: changes, pass });
      progressed = true;
    } catch (error) {
      blocked.push({ probe, error: String(error?.message || error).slice(0, 120) });
    }
  }
  return { blocked, progressed };
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
  const { probes, scope } = scopedProbes();

  const before = await countAll(account, probes);
  const beforeTotal = before.total;

  if (beforeTotal > MAX_ROWS_SAFETY) {
    throw new Error(`refused:${beforeTotal}-rows-exceeds-safety-${MAX_ROWS_SAFETY}`);
  }

  if (!apply) {
    emit({ mode: 'dry-run', scope, target: TEST_DB_NAME, before_total: beforeTotal, tables: before.rows });
    log(`dry-run: ${beforeTotal} row(s) in scope on ${TEST_DB_NAME}; nothing deleted`);
    return 0;
  }

  const { deleted, pending } = await deleteAll(account, probes);

  const after = await countAll(account, probes);
  const afterTotal = after.total;

  const deletedTotal = deleted.reduce((sum, item) => sum + item.deleted, 0);
  const errors = pending.map(({ probe, error }) => ({ table: probe.table, error }));
  // Emitted even on failure: the workflow puts the first error into the check name, so the reason is
  // readable from the run list without downloading logs (which are not always reachable).
  emit({
    mode: 'apply',
    scope,
    target: TEST_DB_NAME,
    before_total: beforeTotal,
    deleted_total: deletedTotal,
    after_total: afterTotal,
    errors,
    deleted,
    after: after.rows,
  });
  log(`apply: before=${beforeTotal} deleted=${deletedTotal} after=${afterTotal} errors=${errors.length}`);
  return afterTotal === 0 && errors.length === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    log(`STOP ${String(error?.message || error).slice(0, 160)}`);
    process.exitCode = 1;
  });
