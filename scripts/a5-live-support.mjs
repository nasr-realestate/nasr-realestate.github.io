#!/usr/bin/env node
/**
 * A5 live-verification support (test database ONLY). Two modes, both silent on stdout so the
 * verifier's single-line JSON summary stays parseable:
 *
 *   ensure-review-case  — exact-key pre-check + ONE run-scoped synthetic file/version/case on the
 *                         test DB so A5-L8/L9 can record a `noted` decision. Every successful row
 *                         is appended to the A5 L2 pending journal for later hash-chain proof.
 *   expire-session      — the CRM_A5_EXPIRE_CMD hook. Expires ONLY the session this run created.
 *
 * WHY csrf_hash AND NOT token_hash: the Worker stores
 *     csrf_hash = sha256Hex(csrf_token)                 (no secret involved)
 *     token_hash = hmacSha256(CRM_SESSION_SECRET, 'session:' + cookie)
 * CRM_SESSION_SECRET is a Cloudflare Worker Secret that CI must never read, generate or print. The
 * verifier therefore writes the csrf_token it received to `${CRM_A5_STATE_FILE}.csrf`, and this hook
 * derives the same sha256 handle. That is a secret-free, run-local handle on exactly one row.
 *
 * SAFETY BARRIERS (any failure => non-zero exit, no mutation attempted):
 *   - hard-coded test DB UUID is used in EVERY D1 URL; no env-supplied DB id, no prod id.
 *   - wrangler config must name the test Worker/test DB and must not contain the prod DB id or name.
 *   - expire-session refuses unless EXACTLY ONE live crm_sessions row matches the handle;
 *     zero means the handle is wrong, more than one would mean touching someone else's session.
 *   - the guarded UPDATE re-checks that count inside the same statement and touches that row only.
 *   - no DELETE, no backup/stage DB, no secret create/update/rotate, no production Worker deploy.
 *   - nothing is ever written to stdout (only stderr diagnostics), and no secret/token is printed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const TEST_DB_UUID = '65bfcb14-4b48-423b-916f-00eefdb9ae1e';
export const TEST_DB_NAME = 'nasr-crm-test-db';
export const PROD_DB_UUID = 'ace5c9a2-c6b1-47b3-adf1-77e84ac50abf';
export const PROD_DB_NAME = 'nasr-market-db';
export const WORKER_NAME = 'nasr-crm-api-test';
export const WRANGLER_CFG = '_worker/wrangler.crm.toml';
export const CF_API = 'https://api.cloudflare.com/client/v4';
export const SEED_TAG = 'CI-A5-LIVE-SEED';

const log = (message) => process.stderr.write(`a5-live-support: ${message}\n`);
const fail = (code) => { log(`STOP ${code}`); process.exit(1); };

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function countLiveSessionSql(hash) {
  return `SELECT COUNT(*) AS n FROM crm_sessions WHERE csrf_hash = '${hash}' AND revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER);`;
}

export function expireSessionSql(hash) {
  // The inner count is the second, in-database barrier: even a race cannot widen this to two rows.
  return `UPDATE crm_sessions SET expires_at = CAST(strftime('%s','now') - 60 AS INTEGER) WHERE csrf_hash = '${hash}' AND revoked_at IS NULL AND (SELECT COUNT(*) FROM crm_sessions WHERE csrf_hash = '${hash}' AND revoked_at IS NULL) = 1;`;
}

export function countOpenReviewCasesSql() {
  return "SELECT COUNT(*) AS n FROM crm_drive_file_review_case WHERE status <> 'closed_no_action';";
}

/**
 * Run-scoped, synthetic-only seed. No customer data, no real Drive file, one version, one open case.
 *
 * A5 L2: keys are derived from `run_tag` (not from a constant), so two consecutive runs NEVER
 * contend for the same case_ref. Plain INSERT is used on purpose: `INSERT OR IGNORE` silently
 * reused a previous run's row and hid a UNIQUE conflict, which broke isolation. The dead
 * `UPDATE head_version_seq` is gone (trigger 0010 already maintains the head).
 *
 * `seedTag` defaults to the legacy constant ONLY so existing offline contract tests can call the
 * function with no arguments; the workflow always passes a run-scoped tag.
 */
export function seedReviewCaseStatements(seedTag = SEED_TAG) {
  const driveId = `SYNTHLIVE${seedTag}`;
  const ref = sha256Hex(driveId);
  const digest = sha256Hex(`${driveId}-bytes-v1`);
  const caseRef = `frw-${ref.slice(0, 16)}-1`;
  const mtim = new Date().toISOString();
  const q = (s) => s.replace(/'/g, "''");
  return [
    `INSERT INTO crm_drive_file_registry
      (id, drive_file_id, drive_parent_id, file_name, original_file_name, drive_path, mime_type, file_size,
       drive_created_at, drive_modified_at, content_sha256, content_type, processing_status, review_status,
       last_processed_at, processing_receipt_ref, extracted_records_count, processing_attempts, metadata_json,
       created_at, updated_at, drive_ref)
      VALUES ('reg-${q(seedTag)}','${q(driveId)}','SYNTH-FOLDER','synth-${q(seedTag)}.zip','synth-${q(seedTag)}.zip','/synth',
       'application/zip',1024,'${mtim}','${mtim}','${digest}','ZIP','metadata_scanned','not_required','${mtim}',
       'receipt-${q(seedTag)}',0,1,'{}','${mtim}','${mtim}','${ref}');`,
    `INSERT INTO crm_drive_file_version
      (version_ref, drive_ref, version_seq, content_sha256, evidence_class, size_bytes, drive_modified_at,
       observed_at, observed_by, receipt_ref)
      VALUES ('${ref}#1','${ref}',1,'${digest}','verified_local_recompute',1024,'${mtim}','${mtim}',
       'intake_pipeline','receipt-${q(seedTag)}');`,
    `INSERT INTO crm_drive_file_review_case
      (case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition, status,
       case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
      VALUES ('${caseRef}','${ref}',1,'${digest}','needs_governance_review','open',
       '${sha256Hex(`case-snapshot|${caseRef}|${digest}`)}','${sha256Hex(`genesis|${caseRef}`)}',
       'intake_pipeline','${mtim}');`,
  ];
}

/** Exact-key, read-only pre-check for THIS run's seed. Never a namespace-wide "empty" assertion. */
export function seedExistsSql(seedTag) {
  return `SELECT drive_ref FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTHLIVE${String(seedTag).replace(/'/g, "''")}' LIMIT 2`;
}

export function seedTagFor(runTag) {
  return `A5-${sha256Hex(`seed|${runTag}`).slice(0, 16)}`;
}

function parseD1Response(out) {
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('d1-response-not-json'); }
  const rows = parsed?.result?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error('d1-response-shape');
  return rows;
}

/** Single-statement, single-target D1 query. Stub driver is honoured ONLY in local unit tests. */
export function d1Query(sql, env = process.env) {
  if (env.CRM_A5_TEST_STUB === '1' && env.CRM_A5_D1_QUERY_CMD) {
    const out = execFileSync('/bin/sh', ['-c', env.CRM_A5_D1_QUERY_CMD], {
      encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      env: { ...env, A5_SQL: sql },
    });
    return parseD1Response(out);
  }
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('cloudflare-env-missing');
  const payload = JSON.stringify({ sql });
  const out = execFileSync('curl', [
    '--silent', '--show-error', '--fail-with-body', '--connect-timeout', '10', '--max-time', '30',
    '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json',
    '--data', payload,
    `${env.CRM_A5_CF_API || CF_API}/accounts/${account}/d1/database/${TEST_DB_UUID}/query`,
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return parseD1Response(out);
}

/** Reject any configuration that could reach the production DB or a non-test Worker. */
export function assertTestOnlyConfig(env = process.env) {
  const cfg = env.CRM_A5_WRANGLER_CFG || WRANGLER_CFG;
  const text = readFileSync(cfg, 'utf8');
  if (!text.includes(`name = "${WORKER_NAME}"`)) throw new Error('config-not-test-worker');
  if (!text.includes(`database_name = "${TEST_DB_NAME}"`)) throw new Error('config-not-test-db-name');
  if (!text.includes(`database_id = "${TEST_DB_UUID}"`)) throw new Error('config-not-test-db-uuid');
  if (text.includes(PROD_DB_UUID) || text.includes(PROD_DB_NAME)) throw new Error('config-contains-prod-db');
  if (env.CRM_A5_TEST_DB && env.CRM_A5_TEST_DB !== TEST_DB_UUID) throw new Error('test-db-env-mismatch');
}

function countOf(rows) {
  const n = Number(rows?.[0]?.n);
  if (!Number.isFinite(n)) throw new Error('count-query-shape');
  return n;
}

function ensureReviewCase(env) {
  // A5 L2: every run owns its own case. Checking the exact run key (not "any open case") is what
  // stops run B from silently reusing run A's case and therefore reusing A's L1-looking evidence.
  const runTag = String(env.A5_L2_RUN_TAG || '').trim();
  if (!/^a5-\d+-\d+-[0-9a-f]{8}$/.test(runTag)) fail('run-tag-required-for-a5-l2-seed');
  const seedTag = seedTagFor(runTag);
  const existing = d1Query(seedExistsSql(seedTag), env);
  if (existing.length > 0) { log(`this run's synthetic case already exists (${existing.length}); no second seed`); return; }

  const statements = seedReviewCaseStatements(seedTag);
  for (const statement of statements) d1Query(statement, env);
  const after = d1Query(seedExistsSql(seedTag), env);
  if (after.length !== 1) fail('review-case-seed-did-not-create-exactly-one-case');

  // Incremental L2 evidence for the three rows this barrier actually wrote. These are D1-side
  // writes, so they cannot come from an HTTP response; finalize resolves them by exact key.
  const driveRef = sha256Hex(`SYNTHLIVE${seedTag}`);
  const pending = String(env.A5_L2_PENDING || '').trim();
  if (pending) {
    const events = [
      { table: 'crm_drive_file_registry', lookup_column: 'drive_ref', lookup_value: driveRef, id_source: 'd1-exact-key', step: 'ensure-review-case' },
      { table: 'crm_drive_file_version', lookup_column: 'version_ref', lookup_value: `${driveRef}#1`, id_source: 'd1-exact-key', step: 'ensure-review-case' },
      { table: 'crm_drive_file_review_case', lookup_column: 'case_ref', lookup_value: `frw-${driveRef.slice(0, 16)}-1`, id_source: 'd1-exact-key', step: 'ensure-review-case' },
    ];
    for (const event of events) {
      appendFileSync(pending, `${JSON.stringify({ ...event, run_tag: runTag,
        run_id: env.GITHUB_RUN_ID || '', run_attempt: env.GITHUB_RUN_ATTEMPT || '' })}\n`);
    }
  }
  log('one run-scoped synthetic open review case created on the test DB (L2 evidence recorded)');
}

function expireSession(env) {
  const stateFile = String(env.CRM_A5_STATE_FILE || '').trim();
  if (!stateFile) fail('no-state-file');
  let csrf;
  try { csrf = readFileSync(`${stateFile}.csrf`, 'utf8'); } catch { fail('no-csrf-state-file'); }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(csrf)) fail('csrf-state-shape');
  const hash = sha256Hex(csrf);
  const live = countOf(d1Query(countLiveSessionSql(hash), env));
  if (live !== 1) fail(`expected-exactly-one-live-session(got=${live})`);
  d1Query(expireSessionSql(hash), env);
  const stillLive = countOf(d1Query(countLiveSessionSql(hash), env));
  if (stillLive !== 0) fail(`session-still-live-after-update(${stillLive})`);
  // No stdout: the parent verifier writes exactly one JSON line there.
  log('synthetic session expired in crm_sessions (one row, 0014 units)');
}

function main() {
  const mode = process.argv[2];
  if (!['ensure-review-case', 'expire-session'].includes(mode)) fail('unknown-mode');
  try { assertTestOnlyConfig(); } catch (error) { fail(`config-guard:${error.message}`); }
  try {
    if (mode === 'ensure-review-case') ensureReviewCase(process.env);
    else expireSession(process.env);
  } catch (error) {
    fail(`d1:${String(error?.message || error).slice(0, 160)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
