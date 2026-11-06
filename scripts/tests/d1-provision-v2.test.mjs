// Tests: سير تجهيز قاعدة v2 (2026-11-06).
//
// لماذا هذا الملف: قاعدة الاختبار الحالية لا يمكن أن تمرّ بوابة L2 أبدًا — تحمل 17 صفًا في
// crm_drive_file_review_decision، والجدول append-only بـtrigger مقصود، والصفوف القديمة لا تُثبت
// رجعيًا (a5-l2.mjs). الطريق الوحيد الذي لا يُسقط حاجزًا هو قاعدة نظيفة. هذه الاختبارات تحرس
// خصائص ذلك السير: أنه لا يخلق ما هو موجود، ولا يكتب في القديم أو الإنتاج، ولا يحذف شيئًا،
// وأن كل كتابة تمرّ عبر قناة الهجرات المعتمدة لا عبر SQL مُلفّق.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, '.github', 'workflows', 'crm-d1-provision-v2.yml');
const src = readFileSync(FILE, 'utf8');
const doc = yaml.load(src);
const provision = doc.jobs.provision;

test('dispatch-only, typed string, and behind the same environment approval', () => {
  const triggers = doc.on ?? doc[true];
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch']);
  assert.match(src, /inputs\.authorize_provision == 'PROVISION-CRM-TEST-DB-V2'/);
  // The human gate must be the existing protected environment, not a fresh unprotected one.
  assert.equal(provision.environment, 'crm-test-deploy');
  assert.match(provision.if, /github\.repository == 'nasr-realestate\/nasr-realestate\.github\.io'/);
});

test('it never deletes, drops, or truncates anything', () => {
  // Assert on the executed script, not the prose above it: the header quotes the append-only trigger
  // on purpose, and a comment must never be mistaken for a statement.
  const script = provision.steps.filter((step) => step.run).map((step) => step.run).join('\n');
  assert.doesNotMatch(script, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(script, /\b(DROP|TRUNCATE|VACUUM)\b/i);
  assert.doesNotMatch(script, /d1\s+(database|d1)\s+delete/i);
});

test('creating is idempotent: an existing v2 is reused, never recreated', () => {
  assert.match(src, /select\(\.name==\$n\)/, 'must look the database up by name first');
  assert.match(src, /created='no-reused'/);
  // Create is only reachable in the else branch.
  const lookupAt = src.indexOf("select(.name==$n)");
  const createAt = src.indexOf('-X POST "$API/accounts/$account_id/d1/database"');
  assert.ok(lookupAt > -1 && createAt > lookupAt, 'lookup must precede create');
});

test('the new database can never be the old one or production', () => {
  assert.match(src, /if \[ "\$uuid" = "\$\{PROD_DB_UUID\}" \] \|\| \[ "\$uuid" = "\$\{OLD_DB_UUID\}" \]/);
  assert.match(src, /outcome='refused:target-is-not-new'/);
});

test('the migration config is derived from the pinned config, not retyped', () => {
  const s2 = src;
  assert.ok(
    s2.includes('s/^database_name = .*/database_name = \\"${NEW_DB_NAME}\\"/'),
    'the name line must be substituted, not retyped',
  );
  assert.match(src, /_worker\/wrangler\.crm\.toml > _worker\/wrangler\.v2\.toml/);
  // ...and applied through wrangler's own ledger, so d1_migrations stays truthful.
  assert.match(src, /d1 migrations apply "\$NEW_DB_NAME" --remote/);
});

test('the old database is read once, and only with SELECT', () => {
  // It appears as a declaration, in the refusal check, and in exactly one request URL.
  assert.equal(src.split('${OLD_DB_UUID}/query').length - 1, 1, 'exactly one request may target the old DB');
  const at = src.indexOf('${OLD_DB_UUID}/query');
  const around = src.slice(Math.max(0, at - 400), at + 200);
  assert.match(around, /pub_sql="SELECT /);
  assert.doesNotMatch(around, /INSERT|UPDATE|DELETE/i);
});

test('the seeded key value is masked, and inserted only into the new database', () => {
  assert.match(src, /echo "::add-mask::\$\{pub\}"/);
  const maskAt = src.indexOf('echo "::add-mask::${pub}"');
  const insertAt = src.indexOf('crm_idempotency_receipts(submission_key,resource_type,resource_id,received_at)');
  assert.ok(maskAt > -1 && insertAt > maskAt, 'the value must be masked before it is written');
  // The insert is executed against NEW_DB_NAME, never the old uuid.
  const insertCmd = src.slice(insertAt, insertAt + 600);
  assert.doesNotMatch(insertCmd, /OLD_DB_UUID/);
});

test('the check name carries the outcome and the uuid', () => {
  assert.match(src, /name: "D1 v2 — \$\{\{ needs\.provision\.outputs\.outcome \}\} — uuid=\$\{\{ needs\.provision\.outputs\.uuid \}\}/);
});

test('the platform base schema exists as one file and matches the proven bootstrap verbatim', () => {
  // The CRM migrations assume listings/areas/sources already exist. Run 42229265442 proved what
  // happens without them: 'no such table: listings: SQLITE_ERROR'. The proven bootstrap is the one
  // in crm-cloudflare-test-d1.yml; this file must stay identical to it, or the two will drift.
  const base = readFileSync(path.join(ROOT, '_worker', 'base', 'crm-test-platform-base.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const bootstrap = readFileSync(path.join(ROOT, '.github', 'workflows', 'crm-cloudflare-test-d1.yml'), 'utf8');
  const heredoc = bootstrap.slice(
    bootstrap.indexOf("BASE_SCHEMA=$(cat <<'SQL'"),
    bootstrap.indexOf("          SQL\n          )"),
  );
  const fromWorkflow = heredoc
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  assert.ok(fromWorkflow.length > 300, 'the bootstrap heredoc must be found');
  assert.equal(base, fromWorkflow, 'the shared base file drifted from the proven bootstrap');
});

test('the base schema is applied before the migrations, and never to an already-provisioned DB', () => {
  const script = provision.steps.filter((step) => step.run).map((step) => step.run).join('\n');
  const baseAt = script.indexOf('base/crm-test-platform-base.sql');
  // Match the real command, not the comment that quotes it.
  const migrateAt = script.indexOf('d1 migrations apply "$NEW_DB_NAME" --remote');
  assert.ok(baseAt > -1, 'the base schema must be applied at all');
  assert.ok(migrateAt > baseAt, 'the base schema must come first');
  // A reused database that already has the ledger must skip both, or CREATE TABLE aborts.
  assert.match(script, /name='d1_migrations'/);
  assert.match(script, /migrations='already-provisioned'/);
});

test('a failure reports the wrangler error line, not its log trailer', () => {
  const script = provision.steps.filter((step) => step.run).map((step) => step.run).join('\n');
  assert.match(script, /err_line\(\)/);
  assert.match(script, /grep -aiE '\(✘\\|\\\[ERROR\\\]\\|error:\)'/);
  assert.match(script, /outcome="base-schema-failed:\$\(err_line /);
  assert.match(script, /outcome="migrations-failed:\$\(err_line /);
  // The old, useless form must be gone.
  assert.doesNotMatch(script, /tail -n 2 \/tmp\/migrations\.log/);
});

test('it verifies the three numbers that make a database usable', () => {
  const script = provision.steps.filter((step) => step.run).map((step) => step.run).join('\n');
  assert.match(script, /key_rows/);
  assert.match(script, /migrations-verify:count=/);
  assert.match(script, /fixture-verify:synthetic_rows=/);
});
