// Regression tests for `can_admins_bypass=unknown`.
//
// Root cause: jq's `//` replaces BOTH null and false, so
//   `.can_admins_bypass // "unknown"` => "unknown"  when the API correctly returns false.
// The fix parses the documented boolean strictly and gates on `jq -e '.can_admins_bypass == false'`.
//
// These tests execute the ACTUAL `run:` script of each audit job against a stubbed `curl`,
// with no network, no GitHub token, no Cloudflare token and no database of any kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');
const readWf = (name) => fs.readFileSync(path.join(WF, name), 'utf8');
const wf = (name) => yaml.load(readWf(name));
const auditScript = (name, job) => wf(name).jobs[job].steps.find((s) => s.id === 'audit').run;
// Comments quote the old buggy expression on purpose; static guards must inspect executable lines only.
const codeOnly = (s) => s.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

const MIG = 'crm-test-migrations.yml';
const DEPLOY = 'crm-cloudflare-test-deploy.yml';

const goodEnvironment = (bypass) => ({
  id: 26230330392,
  name: 'crm-test-deploy',
  can_admins_bypass: bypass,
  protection_rules: [
    { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'nasr-realestate' } }] },
    { type: 'wait_timer', wait_timer: 10 },
  ],
  deployment_branch_policy: null,
});

/** Run a real audit step offline; return exit code, outputs and captured streams. */
function runAudit(workflowFile, job, body, httpCode = '200') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-bypass-audit-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'),
      '#!/bin/sh\ncat "$A5_STUB_BODY"\nprintf \'\\n%s\' "$(cat "$A5_STUB_CODE")"\n',
      { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'body'), typeof body === 'string' ? body : JSON.stringify(body));
    fs.writeFileSync(path.join(dir, 'code'), httpCode);
    const script = path.join(dir, 'audit.sh');
    fs.writeFileSync(script, auditScript(workflowFile, job));
    const output = path.join(dir, 'github_output');
    fs.writeFileSync(output, '');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'stub-token',
      API: 'https://api.github.com',
      REPO: 'nasr-realestate/nasr-realestate.github.io',
      GITHUB_OUTPUT: output,
      A5_STUB_BODY: path.join(dir, 'body'),
      A5_STUB_CODE: path.join(dir, 'code'),
      ATTEST: '', REVIEWERS: '', TIMER: '',
    };
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('bash', [script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      code = error.status;
      stdout = String(error.stdout || '');
      stderr = String(error.stderr || '');
    }
    const outputs = fs.readFileSync(output, 'utf8');
    const get = (k) => (outputs.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
    return { code, stdout, stderr, outputs, protection: get('protection'), detail: get('detail') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('1) the jq `//`-on-boolean bug is gone from BOTH audits, and the strict boolean gate is present', () => {
  for (const f of [MIG, DEPLOY]) {
    const code = codeOnly(readWf(f));
    assert.ok(!/\.can_admins_bypass\s*\/\/\s*"unknown"/.test(code),
      `${f}: jq // turns a real false into "unknown"`);
    assert.match(code, /if \(\.can_admins_bypass \| type\) == "boolean"/, `${f}: type-based diagnostic`);
    assert.match(code, /jq -e '\.can_admins_bypass == false'/, `${f}: strict boolean gate`);
    const audit = codeOnly(auditScript(f, f === MIG ? 'protection-audit' : 'env-protection-audit'));
    assert.ok(!/\|\|\s*true/.test(audit), `${f}: barrier failure must not be swallowed`);
  }
});

test('2) migrations audit uses the documented endpoint/permission, pins the API version, and still hard-stops', () => {
  const s = readWf(MIG);
  assert.match(s, /\/environments\/crm-test-deploy/, 'documented Get-an-environment endpoint');
  assert.match(s, /X-GitHub-Api-Version: 2022-11-28/, 'pinned, documented response schema');
  const auditJob = wf(MIG).jobs['protection-audit'];
  assert.equal(auditJob.permissions.actions, 'read', 'Actions (read) is the documented requirement');
  assert.match(s, /if \[ "\$code" != '200' \]/, 'non-200 is a stop, not an attestation');
  assert.match(s, /protection=unreadable/);
  assert.match(s, /protection=weak/);
  assert.ok(!/::warning::/.test(s), 'no warning downgrade anywhere in this workflow');
  const code = codeOnly(s);
  assert.ok(!/protection=attested|ATTEST:|environment_protection_attested/.test(code),
    'no attestation fallback / no typed claim can clear the gate');
  // The apply job remains unreachable unless the audit measured protection.
  assert.match(s, /needs\.protection-audit\.outputs\.protection == 'verified'/);
  const auditStep = auditScript(MIG, 'protection-audit');
  assert.ok(!/d1 migrations apply|wrangler|INSERT|UPDATE|DELETE/.test(auditStep),
    'the audit job itself touches no database');
});

test('3) REAL API shape with can_admins_bypass:false now verifies (previously reported "unknown")', () => {
  const r = runAudit(MIG, 'protection-audit', goodEnvironment(false));
  assert.equal(r.code, 0, `expected success, stderr=${r.stderr}, stdout=${r.stdout}`);
  assert.equal(r.protection, 'verified');
  assert.match(r.detail, /can_admins_bypass=false/, 'must report the measured boolean, not "unknown"');
  assert.ok(!/unknown/.test(r.detail));
  assert.match(r.stdout, /measured: .*can_admins_bypass=false/);
});

test('4) true / null / missing / string / wrong shape are ALL hard stops — never assumed false', () => {
  const cases = [
    ['true (admins really can bypass)', goodEnvironment(true)],
    ['null', goodEnvironment(null)],
    ['string "false"', goodEnvironment('false')],
    ['missing field', (() => { const o = goodEnvironment(false); delete o.can_admins_bypass; return o; })()],
    ['wrong shape: no protection_rules', { name: 'crm-test-deploy', can_admins_bypass: false }],
    ['wrong shape: JSON array', '[]'],
  ];
  for (const [label, body] of cases) {
    const r = runAudit(MIG, 'protection-audit', body);
    assert.notEqual(r.code, 0, `${label}: must stop`);
    assert.ok(['weak', 'unreadable'].includes(r.protection), `${label}: protection=${r.protection}`);
    assert.notEqual(r.protection, 'verified', `${label}: must not clear the gate`);
    assert.ok(!/can_admins_bypass=false/.test(r.detail || ''), `${label}: must not claim false`);
  }
});

test('5) non-200 is reject-if-unreadable; no attestation fallback, no write job reached', () => {
  const r = runAudit(MIG, 'protection-audit', { message: 'Not Found' }, '404');
  assert.notEqual(r.code, 0);
  assert.equal(r.protection, 'unreadable');
  assert.match(r.detail, /http-404/);
  const r403 = runAudit(MIG, 'protection-audit', { message: 'Forbidden' }, '403');
  assert.notEqual(r403.code, 0);
  assert.equal(r403.protection, 'unreadable');
});

test('6) deploy workflow: real false verifies, true and unreadable stop (no silent "unknown" pass)', () => {
  const ok = runAudit(DEPLOY, 'env-protection-audit', goodEnvironment(false));
  assert.equal(ok.code, 0, `expected success, stderr=${ok.stderr}, stdout=${ok.stdout}`);
  assert.equal(ok.protection, 'verified');
  assert.match(ok.detail, /can_admins_bypass=false/);
  for (const body of [goodEnvironment(true), goodEnvironment(null)]) {
    const r = runAudit(DEPLOY, 'env-protection-audit', body);
    assert.notEqual(r.code, 0);
    assert.equal(r.protection, 'weak');
  }
});
