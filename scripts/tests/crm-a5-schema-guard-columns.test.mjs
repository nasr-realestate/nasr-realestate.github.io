// Regression tests for `a5-schema-guard-failed:missing=column:crm_drive_file_review_decision.seq,
// column:crm_drive_file_review_decision.created_at`.
//
// Root cause: the deploy workflow's read-only schema guard expected `seq` / `created_at`, but the
// authoritative migration `_worker/migrations/0011_crm_drive_file_intake_review.sql:141` defines
// `decision_seq` (:144) and `occurred_at` (:170). `seq` is the PK of a DIFFERENT table,
// `crm_drive_file_review_anchor` (0011:189). 0014 only recreates two triggers; it changes no column.
// Application code (`_worker/crm-drive-file-review.js:133,200,215,233`) uses the real names.
//
// Fix: one line — `.github/workflows/crm-cloudflare-test-deploy.yml:505`. These tests prove the guard
// checks the correct names AND rejects the incorrect ones, by parsing the real `run:` block and by
// executing it offline against a SQLite schema rebuilt from the approved migrations. Entirely offline:
// no network, no GitHub API, no Cloudflare API, no secret values, and no real DB is touched — the only
// SQLite files are throwaway in-memory / os.tmpdir() fixtures, removed in a finally block.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'crm-cloudflare-test-deploy.yml');
const MIG_DIR = path.join(ROOT, '_worker', 'migrations');
const TABLE = 'crm_drive_file_review_decision';

const readWf = () => fs.readFileSync(WF, 'utf8');
const loadWf = () => yaml.load(readWf());
const guardScript = () => loadWf().jobs['deploy-and-verify'].steps.find((s) => s.id === 'schema').run;

/** Parse the REAL columnChecks literal out of the workflow's `run:` block (no eval). */
function columnChecks() {
  const script = guardScript();
  const match = script.match(/const columnChecks = (\[[\s\S]*?\]);/);
  assert.ok(match, 'the deploy schema guard must still declare columnChecks');
  // The literal uses single quotes and contains no apostrophes, so this is a safe, total conversion.
  const parsed = JSON.parse(match[1].replace(/'/g, '"'));
  assert.ok(Array.isArray(parsed) && parsed.length === 9, 'exactly nine column-check rows');
  return parsed;
}

/** The full expected array: the decision row is the only one that changed. */
const EXPECTED = [
  ['crm_customer_requests', ['id', 'contact_id', 'dedupe_key', 'status', 'created_at', 'updated_at']],
  ['crm_request_status_history', ['request_id', 'from_status', 'to_status', 'actor', 'changed_at']],
  ['crm_request_listing_link', ['request_id', 'listing_id', 'evidence_ref', 'state', 'decided_by']],
  ['crm_operational_audit_log', ['entity', 'entity_id', 'contact_id', 'action', 'actor']],
  ['crm_interactions', ['id', 'contact_id', 'kind', 'summary', 'dedupe_key', 'created_at']],
  ['crm_followups', ['id', 'contact_id', 'request_id', 'opportunity_id', 'due_at', 'status', 'dedupe_key']],
  [TABLE, ['case_ref', 'decision_seq', 'decision', 'reviewer', 'occurred_at']],
  ['crm_sessions', ['id', 'token_hash', 'csrf_hash', 'created_at', 'expires_at', 'revoked_at']],
  ['crm_idempotency_receipts', ['submission_key', 'resource_type', 'resource_id', 'received_at']],
];
const OLD_BUGGY_ROW = [TABLE, ['case_ref', 'seq', 'decision', 'reviewer', 'created_at']];

/** The same loop the guard runs at :509-512, over an in-memory SQLite database. */
function runColumnLoop(db, checks) {
  const absent = [];
  for (const [table, cols] of checks) {
    const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}');`).all();
    const present = new Set(rows.map((r) => String(r.name)));
    for (const c of cols) if (!present.has(c)) absent.push(`column:${table}.${c}`);
  }
  return absent;
}

/** Apply every approved migration in order. `listings` is a pre-existing site table, not a migration. */
function authoritativeSchema(db) {
  db.exec(`CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT,
    title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 INTEGER, price INTEGER,
    bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT);`);
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return files;
}

/** Run the REAL guard `run:` block offline; `curl` is replaced by a SQLite-backed stub. */
function runGuard(wrongDecisionColumns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-schema-guard-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const stub = path.join(dir, 'curl-stub.mjs');
    fs.writeFileSync(stub, `
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
const i = args.indexOf('--data');
if (i < 0) { process.stderr.write('stub curl: missing --data\\n'); process.exit(2); }
const { sql } = JSON.parse(args[i + 1]);
const db = new DatabaseSync(process.env.A5_STUB_DB);
let rows = db.prepare(sql).all();
if (process.env.A5_STUB_WRONG_DECISION === '1' &&
    /pragma_table_info\\('crm_drive_file_review_decision'\\)/.test(sql)) {
  rows = rows.map(r => ({ name: String(r.name)
    .replace('decision_seq', 'seq').replace('occurred_at', 'created_at') }));
}
process.stdout.write(JSON.stringify({ result: [{ results: rows, success: true }] }));
`);
    // `curl` receives the exact argv from the guard's execFileSync call.
    fs.writeFileSync(path.join(bin, 'curl'),
      '#!/bin/sh\nexec node --no-warnings "$A5_STUB_JS" "$@"\n', { mode: 0o755 });

    const dbPath = path.join(dir, 'stub.sqlite');
    const db = new DatabaseSync(dbPath);
    const files = authoritativeSchema(db);
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
    const insert = db.prepare('INSERT INTO d1_migrations (id, name) VALUES (?, ?);');
    files.forEach((name, idx) => insert.run(idx + 1, name));
    db.close();

    const script = path.join(dir, 'guard.sh');
    fs.writeFileSync(script, guardScript());
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      API: 'https://api.cloudflare.com/client/v4',
      CLOUDFLARE_ACCOUNT_ID: 'stub-account',
      TEST_DB_UUID: '65bfcb14-4b48-423b-916f-00eefdb9ae1e',
      PROD_DB_UUID: 'ace5c9a2-c6b1-47b3-adf1-77e84ac50abf',
      CLOUDFLARE_API_TOKEN: 'stub-token',
      MIGRATIONS_DIR: MIG_DIR,
      GITHUB_OUTPUT: path.join(dir, 'github_output'),
      A5_STUB_JS: stub,
      A5_STUB_DB: dbPath,
      A5_STUB_WRONG_DECISION: wrongDecisionColumns ? '1' : '0',
    };
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('bash', [script], {
        cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      });
    } catch (error) {
      code = error.status;
      stdout = String(error.stdout || '');
      stderr = String(error.stderr || '');
    }
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('1) deploy guard expects decision_seq / occurred_at — never seq / created_at — for the decision table', () => {
  const checks = columnChecks();
  const rows = checks.filter(([t]) => t === TABLE);
  assert.equal(rows.length, 1, 'the decision table is checked exactly once');
  assert.deepEqual(rows[0], [TABLE, ['case_ref', 'decision_seq', 'decision', 'reviewer', 'occurred_at']]);
  assert.ok(!rows[0][1].includes('seq'), '`seq` belongs to crm_drive_file_review_anchor (0011:189)');
  assert.ok(!rows[0][1].includes('created_at'), 'the decision timestamp is occurred_at (0011:170)');
  assert.match(readWf(), /\['crm_drive_file_review_decision', \['case_ref','decision_seq','decision','reviewer','occurred_at'\]\]/);
});

test('2) the other eight columnChecks rows and every other guard check are unchanged; nothing is weakened', () => {
  assert.deepEqual(columnChecks(), EXPECTED, 'only the decision row may differ from the approved list');
  const s = guardScript();
  // Migration chain, object inventory, FK rules, column loop and the hard throw all survive.
  assert.match(s, /SELECT name FROM d1_migrations ORDER BY id ASC/);
  assert.match(s, /expected\.at\(-1\) !== '0014_fix_drive_review_session_expiry_units\.sql'/);
  assert.match(s, /SELECT type, name FROM sqlite_schema/);
  assert.match(s, /SELECT name, sql FROM sqlite_schema WHERE type='table'/);
  assert.match(s, /for \(const \[table, cols\] of columnChecks\)/);
  assert.match(s, /if \(absent\.length\) throw new Error\(`a5-schema-guard-failed:missing=\$\{absent\.join\(','\)\}`\)/);
  assert.match(s, /schema-guard-ok:migrations=/);
  assert.match(s, /schema-guard-wrong-test-db/);
  assert.match(s, /schema-guard-env-missing/);
  // Read-only and non-bypassable: no apply/DDL/DML, no swallowed failure, no skip.
  assert.ok(!/d1 migrations apply|INSERT INTO|UPDATE crm_|ALTER TABLE|DELETE FROM/.test(s));
  assert.ok(!/\|\|\s*true|continue;|exit 0\s*#|\.catch\s*\(/.test(s), 'a guard failure is never swallowed');
  assert.equal((s.match(/SELECT name FROM pragma_table_info/g) || []).length, 1,
    'still one column-check query executed for all nine tables');
});

test('3) the guard column loop passes on the authoritative schema rebuilt from all 14 approved migrations', () => {
  const db = new DatabaseSync(':memory:');
  const files = authoritativeSchema(db);
  assert.equal(files.length, 14, '0001..0014');
  assert.equal(files.at(-1), '0014_fix_drive_review_session_expiry_units.sql');
  const info = db.prepare(`SELECT name FROM pragma_table_info('${TABLE}');`).all().map((r) => String(r.name));
  assert.ok(info.includes('decision_seq') && info.includes('occurred_at'), 'real columns exist');
  assert.ok(!info.includes('seq') && !info.includes('created_at'), 'no seq/created_at on this table');
  assert.deepEqual(runColumnLoop(db, columnChecks()), [], 'the corrected guard finds nothing missing');
  db.close();
});

test('4) the guard rejects a decision table that exposes only the incorrect names seq / created_at', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ${TABLE} (case_ref TEXT, seq INTEGER, decision TEXT, reviewer TEXT, created_at TEXT);`);
  const decisionRow = columnChecks().find(([t]) => t === TABLE);
  assert.deepEqual(runColumnLoop(db, [decisionRow]), [
    `column:${TABLE}.decision_seq`,
    `column:${TABLE}.occurred_at`,
  ], 'the old/bogus column names are NOT accepted as a substitute');
  db.close();
});

test('5) reintroducing the old expectation reproduces the exact reported A5 failure (regression is caught)', () => {
  const db = new DatabaseSync(':memory:');
  authoritativeSchema(db);
  const buggy = columnChecks().map(([t, cols]) => [t, t === TABLE ? OLD_BUGGY_ROW[1] : cols]);
  const absent = runColumnLoop(db, buggy);
  assert.deepEqual(absent, [
    `column:${TABLE}.seq`,
    `column:${TABLE}.created_at`,
  ]);
  assert.equal(`a5-schema-guard-failed:missing=${absent.join(',')}`,
    'a5-schema-guard-failed:missing=column:crm_drive_file_review_decision.seq,' +
    'column:crm_drive_file_review_decision.created_at');
  db.close();
});

test('6) the REAL guard run: block succeeds offline against the rebuilt test schema', () => {
  const { code, stdout, stderr } = runGuard(false);
  assert.equal(code, 0, `guard must pass; stderr=${stderr.slice(-900)}`);
  assert.match(stdout, /schema-guard-ok:migrations=14;tables=16;views=8;triggers=12/);
  assert.ok(!/a5-schema-guard-failed/.test(stdout + stderr));
});

test('7) the REAL guard run: block fails when the decision columns are the incorrect names', () => {
  const { code, stdout, stderr } = runGuard(true);
  assert.notEqual(code, 0, 'a schema with seq/created_at must be rejected');
  const out = stdout + stderr;
  assert.match(out, /a5-schema-guard-failed:missing=column:crm_drive_file_review_decision\.decision_seq,column:crm_drive_file_review_decision\.occurred_at/);
  assert.ok(!/schema-guard-ok/.test(out), 'the guard must never report success on the wrong names');
});
