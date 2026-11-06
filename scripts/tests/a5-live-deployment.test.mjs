// Seven targeted tests for the A5 live-deployment channel:
//   * the separate, protected, dispatch-only migrations workflow;
//   * the deploy workflow's read-only-only role and its new 10th-check path;
//   * the secret-free, single-row expiry hook (unit + stubbed end-to-end).
// Entirely offline: no network, no GitHub API, no Cloudflare API, no secret values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');
const read = (name) => fs.readFileSync(path.join(WF, name), 'utf8');
const migrations = () => read('crm-test-migrations.yml');
const deploy = () => read('crm-cloudflare-test-deploy.yml');
const support = () => fs.readFileSync(path.join(ROOT, 'scripts', 'a5-live-support.mjs'), 'utf8');
const verifier = () => fs.readFileSync(path.join(ROOT, '_worker', 'tests', 'live-a5-verify.mjs'), 'utf8');
const loadYaml = (name) => yaml.load(read(name));
// js-yaml v4 keeps `on` a string (YAML 1.2), older/1.1 schemas expose it as the boolean key "true".
const triggers = (doc) => doc.on ?? doc.true ?? {};

const TEST_DB_UUID = '760079c6-85f9-4a30-aa19-9a66f95d421a';
const PROD_DB_UUID = 'ace5c9a2-c6b1-47b3-adf1-77e84ac50abf';

test('1) migrations workflow: dispatch-only, exact typed gate, master ref, protected environment', () => {
  const doc = loadYaml('crm-test-migrations.yml');
  assert.ok(doc && doc.jobs, 'workflow must parse as YAML with jobs');
  const on = triggers(doc);
  assert.ok(on.workflow_dispatch, 'workflow_dispatch only');
  assert.equal(on.push, undefined, 'no push trigger');
  assert.equal(on.pull_request, undefined, 'no pull_request trigger');
  assert.match(on.workflow_dispatch.inputs.authorize_migrations.description, /APPLY-PENDING-TEST-DB-MIGRATIONS/);
  const s = migrations();
  assert.match(s, /environment:\s*crm-test-deploy/, 'apply job must sit behind the protected environment');
  assert.match(s, /github\.ref == 'refs\/heads\/master'/, 'master ref guard in the job if');
  assert.match(s, /needs\.protection-audit\.outputs\.protection == 'verified'/, 'measured protection gate');
  assert.match(s, /Approval gate/, 'a legible approval gate step');
  assert.equal(doc.jobs['apply-migrations'].needs, 'protection-audit');
});

test('2) migrations workflow: hard-coded test DB only; no DB create/import/delete, no Worker deploy, one write', () => {
  const s = migrations();
  assert.match(s, /TEST_DB_UUID:\s*760079c6-85f9-4a30-aa19-9a66f95d421a/);
  assert.match(s, /TEST_DB_NAME:\s*nasr-crm-test-db/);
  // The production identifiers may appear ONLY for read-only measurement, never as a write target.
  assert.ok(!/d1 (execute|migrations apply)[^\n]*\$PROD_DB_UUID/.test(s), 'never apply to prod by id');
  assert.ok(!/d1 create|d1 delete|d1 import/i.test(s), 'no DB create/import/delete');
  assert.ok(!/wrangler@4 deploy|wrangler deploy/.test(s), 'this workflow never deploys a Worker');
  assert.equal((s.match(/npx --yes wrangler@4 d1 migrations apply/g) || []).length, 1,
    'exactly one migrations-apply command');
  assert.ok(!/INSERT INTO|UPDATE crm_|DELETE FROM/.test(s), 'no hand-written DML against any DB');
  assert.match(s, /market-db-invariance-ok/, 'production invariance is verified read-only');
});

test('3) migrations workflow: reject-if-unreadable/weak protection, no attestation, secret NAMES only, barriers stop', () => {
  const s = migrations();
  assert.ok(!/environment_protection_attested|ATTEST:|protection=attested/i.test(s),
    'no attestation branch: unmeasurable protection is a STOP');
  assert.match(s, /if \[ "\$code" != '200' \]/);
  assert.match(s, /protection=unreadable/);
  assert.match(s, /wait_seconds/, 'minutes -> seconds normalisation (API reports minutes)');
  assert.match(s, /can_admins_bypass/);
  assert.match(s, /required reviewer|required_reviewers/);
  assert.ok(!/secret put|wrangler secret/.test(s), 'no secret write');
  assert.match(s, /Worker secret NAMES only|secret NAME/, 'secret-name-only inventory check');
  assert.match(s, /missing GitHub Secret ARENA_CLOUDFLARE_TOKEN/);
  assert.match(s, /::add-mask::/);
  assert.ok(!/printenv|set -x|jq \.|SELECT \*/.test(s), 'no bulk/secret logging');
  const barriers = s.match(/echo "::error::[^\n]*/g) || [];
  assert.ok(barriers.length >= 8, `expected several named barriers, got ${barriers.length}`);
  for (const line of barriers) {
    assert.ok(line.includes('::error::') && line.length > 25, `barrier must be legible: ${line}`);
  }
  assert.ok(!/exit 1[\s\S]{0,40}\|\| true/.test(s), 'a barrier failure is never swallowed');
});

test('4) deploy workflow keeps migrations OUT and its schema guard read-only', () => {
  const s = deploy();
  assert.ok(!/d1 migrations apply/.test(s), 'deploy never applies migrations (separate workflow owns that)');
  assert.match(s, /Migrations are NEVER applied by this workflow/);
  assert.match(s, /SELECT name FROM d1_migrations ORDER BY id ASC/, 'read-only migration guard');
  assert.match(s, /0014_fix_drive_review_session_expiry_units\.sql/, '0014 is expected');
  assert.match(s, /sqlite_schema/, 'read-only object inventory');
  const doc = loadYaml('crm-cloudflare-test-deploy.yml');
  assert.ok(doc.jobs['deploy-and-verify'].needs, 'deploy is gated by the environment audit');
  assert.equal(doc.jobs['deploy-and-verify'].environment, 'crm-test-deploy');
});

test('5) deploy workflow wires the 10th live check: expire hook + state sidecar + noted decision, JSON stays one line', () => {
  const s = deploy();
  assert.match(s, /CRM_A5_EXPIRE_CMD/, 'deploy must set the expire hook');
  assert.match(s, /a5-live-support\.mjs expire-session/, 'hook is the guarded support script');
  assert.match(s, /a5-live-support\.mjs ensure-review-case/, 'one open review case is guaranteed as a barrier');
  assert.match(s, /A5_WRITE_DECISION_INPUT:-none.*noted/s);
  assert.match(s, /CRM_A5_STATE_FILE="\$a5_state"/, 'state file still passed');
  assert.match(s, /1>&2/, "hook stdout must not corrupt the verifier's JSON line");
  assert.match(s, /rm -f "\$a5_state\.csrf"/, 'stale handle removed per run');
  const v = verifier();
  assert.match(v, /\$\{stateFile\}\.csrf/, 'verifier writes the csrf handle');
  assert.match(v, /writeFileSync\(csrfState, session\.csrf_token/, 'handle is the csrf token, not a secret');
  assert.match(v, /if \(expireHook && !failed\(\) && created\.review_case_ref\)/, 'A5-L10 stays conditional');
  const doc = loadYaml('crm-cloudflare-test-deploy.yml');
  assert.deepEqual(triggers(doc).workflow_dispatch.inputs.a5_write_decision.options, ['none', 'noted'],
    'state-changing stays off the dispatch form');
});

test('6) expiry hook: secret-free sha256 handle, single-row guard, test-DB-only, no destructive SQL', async () => {
  const m = await import('../a5-live-support.mjs');
  assert.equal(m.TEST_DB_UUID, TEST_DB_UUID);
  const token = 'Zm9v'.repeat(11); // 44 chars, base64url-shaped csrf token
  const expected = createHash('sha256').update(token, 'utf8').digest('hex');
  assert.equal(m.sha256Hex(token), expected, 'must equal the Worker sha256Hex(csrf_token)');
  const hash = m.sha256Hex(token);
  const countSql = m.countLiveSessionSql(hash);
  const updateSql = m.expireSessionSql(hash);
  assert.match(countSql, /FROM crm_sessions/);
  assert.match(countSql, /csrf_hash =/);
  assert.match(countSql, /revoked_at IS NULL/);
  assert.match(updateSql, /UPDATE crm_sessions SET expires_at/);
  assert.match(updateSql, /\(SELECT COUNT\(\*\) FROM crm_sessions[\s\S]*\) = 1/, 'in-DB single-row barrier');
  assert.match(updateSql, /strftime\('%s','now'\)/, '0014 epoch seconds');
  const src = support();
  assert.ok(!/process\.env\.CRM_SESSION_SECRET|env\.CRM_SESSION_SECRET|hmac\(/.test(src),
    'no CRM_SESSION_SECRET is read or derived');
  const sqlStatements = [...m.seedReviewCaseStatements(), updateSql, countSql];
  assert.ok(!sqlStatements.some((q) => /\bDELETE\b|\bDROP\b/i.test(q)), 'no destructive SQL is generated');
  assert.ok(src.includes(PROD_DB_UUID), 'prod UUID appears ONLY as an isolation guard constant');
  assert.match(src, /if \(live !== 1\) fail\(/, 'refuse 0 or >1 matching sessions');
  assert.match(src, /process\.stderr\.write/, 'diagnostics go to stderr only');
  assert.ok(!/console\.log/.test(src), 'nothing on stdout');
  const bad = path.join(ROOT, '.a5-bad-config.toml');
  fs.writeFileSync(bad, `name = "nasr-crm-api-test"\ndatabase_name = "nasr-crm-test-db"\ndatabase_id = "${PROD_DB_UUID}"\n`);
  try {
    assert.throws(() => m.assertTestOnlyConfig({ CRM_A5_WRANGLER_CFG: bad }));
  } finally {
    fs.rmSync(bad, { force: true });
  }
  assert.doesNotThrow(() => m.assertTestOnlyConfig({
    CRM_A5_WRANGLER_CFG: path.join(ROOT, '_worker', 'wrangler.crm.toml'),
  }));
});

test('7) expiry hook end-to-end with a stub D1 driver: refuses 0/2 matches, expires exactly 1', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.a5-stub-'));
  try {
    const state = path.join(dir, 'state');
    const stub = path.join(dir, 'stub.sh');
    fs.writeFileSync(stub, `#!/bin/sh
if printf '%s' "$A5_SQL" | grep -q '^UPDATE'; then
  printf '0' > "$A5_STUB_STATE"
  printf '%s' '{"result":[{"results":[]}]}'
else
  printf '{"result":[{"results":[{"n":%s}]}]}' "$(cat "$A5_STUB_STATE")"
fi
`);
    const tokenFile = path.join(dir, 'a5_state');
    fs.writeFileSync(`${tokenFile}.csrf`, 'QWxhZGRpbjpPcGVuU2VzYW1l'.repeat(2), { mode: 0o600 });
    const env = {
      ...process.env,
      CRM_A5_TEST_STUB: '1',
      CRM_A5_D1_QUERY_CMD: `sh "${stub}"`,
      CRM_A5_WRANGLER_CFG: path.join(ROOT, '_worker', 'wrangler.crm.toml'),
      CRM_A5_STATE_FILE: tokenFile,
      CLOUDFLARE_API_TOKEN: 'stub-token',
      CLOUDFLARE_ACCOUNT_ID: 'stub-account',
      A5_STUB_STATE: state,
    };
    const run = () => {
      try {
        const out = execFileSync('node', ['scripts/a5-live-support.mjs', 'expire-session'], {
          cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out };
      } catch (error) {
        return { code: error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
      }
    };

    for (const n of [0, 2]) {
      fs.writeFileSync(state, String(n));
      const r = run();
      assert.notEqual(r.code, 0, `must refuse when ${n} live sessions match`);
      assert.match(r.err, /expected-exactly-one-live-session/);
      assert.equal(fs.readFileSync(state, 'utf8'), String(n), 'no UPDATE was attempted on refusal');
    }
    fs.writeFileSync(state, '1');
    const ok = run();
    assert.equal(ok.code, 0, `expected success, got ${ok.err || ''}`);
    assert.equal(ok.out, '', 'success must print nothing to stdout (JSON summary stays one line)');
    assert.equal(fs.readFileSync(state, 'utf8'), '0', 'the single session was expired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
