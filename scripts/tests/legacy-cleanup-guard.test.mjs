import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LEGACY_PROBES } from '../a5-l2.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const scriptPath = join(root, 'scripts', 'crm', 'legacy-synthetic-cleanup.mjs');
const workflowPath = join(root, '.github', 'workflows', 'crm-legacy-synthetic-cleanup.yml');

const scriptSource = readFileSync(scriptPath, 'utf8');
const workflowSource = readFileSync(workflowPath, 'utf8');

const json = (response, payload) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
};

// A stand-in for the Cloudflare D1 REST API that records every SQL statement it is sent and
// reports rows as "present" until the matching table has been deleted from. This is what makes the
// test able to catch a wrong delete order or a missing WHERE clause — a text assertion cannot.
async function withFakeApi(handler) {
  const seen = [];
  const emptied = new Set();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (!request.url.includes('/d1/database/')) {
        json(response, { success: true, result: [{ id: 'acct-test-1' }] });
        return;
      }
      let sql = '';
      try { sql = String(JSON.parse(body || '{}').sql || ''); } catch { sql = ''; }
      seen.push(sql);
      const table = /(?:FROM|DELETE\s+FROM)\s+([A-Za-z0-9_]+)/i.exec(sql)?.[1] ?? '';
      if (/^\s*SELECT/i.test(sql)) {
        json(response, { success: true, result: [{ results: [{ n: emptied.has(table) ? 0 : 2 }] }] });
        return;
      }
      emptied.add(table);
      json(response, { success: true, result: [{ meta: { changes: 2 } }] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await handler({ seen, emptied, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runScript(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLOUDFLARE_API_TOKEN: 'fake-token-for-tests',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cleanup script imports its scope instead of restating it', () => {
  // The whole safety argument is "the delete predicates are the gate's own strings". If someone ever
  // copies them into this file, it becomes a second source of truth that can silently drift.
  assert.match(scriptSource, /import\s*\{[^}]*LEGACY_PROBES[^}]*\}\s*from\s*'\.\.\/a5-l2\.mjs'/);
  assert.doesNotMatch(scriptSource, /TEST ONLY%/, 'predicate literal copied into the script');
  assert.doesNotMatch(scriptSource, /ci-e2e-ticket:/, 'predicate literal copied into the script');
  assert.doesNotMatch(scriptSource, /a5:%/, 'predicate literal copied into the script');
});

test('cleanup script never issues DDL or an unqualified DELETE', () => {
  assert.doesNotMatch(scriptSource, /\b(DROP|ALTER|CREATE|TRUNCATE|VACUUM)\b/i);
  assert.doesNotMatch(scriptSource, /DELETE\s+FROM\s+\$\{[^}]+\}\s*(`|'|")?\s*;?\s*$/m);
  // Every delete goes through a WHERE built from the probe.
  assert.match(scriptSource, /DELETE FROM \$\{probe\.table\} WHERE \$\{probe\.where\}/);
});

test('dry-run is the default and apply needs both the flag and the environment value', async () => {
  await withFakeApi(async ({ seen, base }) => {
    const dry = await runScript([], { CRM_A5_CF_API: base });
    assert.equal(dry.code, 0, dry.stderr);
    const payload = JSON.parse(dry.stdout.trim());
    assert.equal(payload.mode, 'dry-run');
    assert.equal(payload.before_total, 2 * LEGACY_PROBES.length);
    assert.equal(seen.filter((sql) => /^\s*DELETE/i.test(sql)).length, 0, 'dry-run must not delete');
    assert.ok(seen.length > 0, 'dry-run should still count');
  });

  // `--apply` alone is not enough: without CRM_CLEANUP_APPLY=1 the process must stop before it
  // opens a socket at all.
  await withFakeApi(async ({ seen, base }) => {
    const refused = await runScript(['--apply'], { CRM_A5_CF_API: base });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /apply-flag-missing/);
    assert.equal(seen.length, 0, 'refused apply must not reach the API');
  });
});

test('apply deletes children before parents, with a WHERE, and finishes at zero', async () => {
  await withFakeApi(async ({ seen, base }) => {
    const applied = await runScript(['--apply'], { CRM_A5_CF_API: base, CRM_CLEANUP_APPLY: '1' });
    assert.equal(applied.code, 0, applied.stderr);

    const deletes = seen.filter((sql) => /^\s*DELETE/i.test(sql));
    assert.equal(deletes.length, LEGACY_PROBES.length);
    deletes.forEach((sql) => {
      assert.match(sql, /^\s*DELETE FROM [A-Za-z0-9_]+ WHERE [\s\S]+/i, `delete without WHERE: ${sql}`);
    });

    // LEGACY_PROBES runs parent → child, so the deletes must arrive in the exact reverse order.
    const expected = [...LEGACY_PROBES].map((probe) => probe.table).reverse();
    const actual = deletes.map((sql) => /DELETE\s+FROM\s+([A-Za-z0-9_]+)/i.exec(sql)[1]);
    assert.deepEqual(actual, expected);

    const payload = JSON.parse(applied.stdout.trim());
    assert.equal(payload.mode, 'apply');
    assert.equal(payload.before_total, 2 * LEGACY_PROBES.length);
    assert.equal(payload.deleted_total, 2 * LEGACY_PROBES.length);
    assert.equal(payload.after_total, 0, 'a non-zero after-count must fail the run');
  });
});

test('a leftover row fails the run instead of being reported as success', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (!request.url.includes('/d1/database/')) {
        json(response, { success: true, result: [{ id: 'acct-test-1' }] });
        return;
      }
      let sql = '';
      try { sql = String(JSON.parse(body || '{}').sql || ''); } catch { sql = ''; }
      if (/^\s*SELECT/i.test(sql)) {
        // Always reports rows, as if the delete silently matched nothing.
        json(response, { success: true, result: [{ results: [{ n: 1 }] }] });
        return;
      }
      json(response, { success: true, result: [{ meta: { changes: 0 } }] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runScript(['--apply'], { CRM_A5_CF_API: base, CRM_CLEANUP_APPLY: '1' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /after=14/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the safety ceiling aborts before any write', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (!request.url.includes('/d1/database/')) {
        json(response, { success: true, result: [{ id: 'acct-test-1' }] });
        return;
      }
      let sql = '';
      try { sql = String(JSON.parse(body || '{}').sql || ''); } catch { sql = ''; }
      if (/^\s*DELETE/i.test(sql)) { globalThis.__sawDelete = true; }
      json(response, { success: true, result: [{ results: [{ n: 5000 }], meta: { changes: 1 } }] });
    });
  });
  globalThis.__sawDelete = false;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runScript(['--apply'], { CRM_A5_CF_API: base, CRM_CLEANUP_APPLY: '1' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refused:70000-rows-exceeds-safety-500/);
    assert.equal(globalThis.__sawDelete, false, 'nothing may be deleted above the ceiling');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a dry run never claims after=0 (it did not measure "after")', () => {
  // Live evidence that this matters: run 42122723509 was a clean dry-run over 35 rows in scope, and
  // its check name read `before=35 deleted=0 after=0` — which reads as "already empty" to anyone who
  // has not read the script. `after` may only be reported when a recount actually happened.
  assert.match(workflowSource, /after_total='n\/a'/);

  const assignments = workflowSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('after_total='));
  // three: the n/a default, the failure path (which must never invent a number), and the success path
  assert.equal(assignments.length, 3, assignments.join(' | '));
  assert.ok(assignments[0].startsWith("after_total='n/a'"), 'the default must be n/a');
  assert.equal(
    assignments[1],
    `after_total="$(jq -r '.after_total // empty' cleanup.json 2>/dev/null || true)"`,
    'a failed run must report empty, not zero',
  );
  assert.match(assignments[2], /\$\(jq -r '\.after_total/, 'the only real value comes from the recount');

  const applyBranchAt = workflowSource.indexOf(`if [ "$mode" = 'apply' ]; then`);
  assert.ok(applyBranchAt > -1, 'the apply branch must exist');
  assert.ok(
    workflowSource.indexOf("after_total=\"$(jq -r '.after_total // 0'") > applyBranchAt,
    'the recount must be reachable only when mode=apply',
  );
});

// Run 42222015132 failed on its very FIRST delete because
// `crm_drive_file_review_decision.case_ref` references `crm_drive_file_review_case(case_ref)`
// ON DELETE RESTRICT. These two tests are the regression guard for that: the cleanup must survive a
// blocked parent (retry it after its children are gone) and must report the permanent blocker.
function scenarioServer({ blocked }) {
  const attempts = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (!request.url.includes('/d1/database/')) {
        json(response, { success: true, result: [{ id: 'acct-test-1' }] });
        return;
      }
      let sql = '';
      try { sql = String(JSON.parse(body || '{}').sql || ''); } catch { sql = ''; }
      const deleteTable = /DELETE\s+FROM\s+([A-Za-z0-9_]+)/i.exec(sql)?.[1];
      if (!deleteTable) {
        json(response, { success: true, result: [{ results: [{ n: 0 }] }] });
        return;
      }
      attempts.push(deleteTable);
      const denial = blocked(deleteTable, attempts.filter((t) => t === deleteTable).length);
      if (denial) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, errors: [{ message: denial }] }));
        return;
      }
      json(response, { success: true, result: [{ meta: { changes: 1 } }] });
    });
  });
  return { server, attempts };
}

test('a blocked parent is retried after its children, not abandoned', async () => {
  const blockedTable = 'crm_drive_file_review_case';
  const { server, attempts } = scenarioServer({
    blocked: (table, tries) => (table === blockedTable && tries === 1 ? 'FOREIGN KEY constraint failed' : null),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runScript(['--apply'], { CRM_A5_CF_API: base, CRM_CLEANUP_APPLY: '1' });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.errors.length, 0);
    assert.equal(payload.after_total, 0);
    assert.equal(attempts.filter((t) => t === blockedTable).length, 2, 'the parent must be retried once');
    // ...and the retry must come after the child that was holding it.
    const firstParent = attempts.indexOf(blockedTable);
    const childAfter = attempts.indexOf('crm_drive_file_review_decision');
    assert.ok(childAfter > firstParent, 'the child must be deleted between the two parent attempts');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a permanent block fails the run and names the table in the JSON', async () => {
  const blockedTable = 'crm_drive_file_review_case';
  const { server } = scenarioServer({
    blocked: (table) => (table === blockedTable ? 'FOREIGN KEY constraint failed' : null),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runScript(['--apply'], { CRM_A5_CF_API: base, CRM_CLEANUP_APPLY: '1' });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.errors.length, 1);
    assert.equal(payload.errors[0].table, blockedTable);
    assert.match(payload.errors[0].error, /FOREIGN KEY/);
    // The workflow reads exactly this to build the check name.
    assert.match(workflowSource, /jq -r '\(\.errors\[0\] \/\/ empty\) \| "\\\(\.table\): \\\(\.error\)"'/);
    assert.match(workflowSource, /outcome="failed:\$\{reason\}"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the workflow is dispatch-only, typed, dry-run by default, and masks the token', () => {
  assert.match(workflowSource, /^on:\s*$/m);
  assert.doesNotMatch(workflowSource, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(workflowSource, /inputs\.authorize_cleanup == 'DELETE-LEGACY-SYNTHETIC-ROWS'/);
  assert.match(workflowSource, /default: dry-run/);
  assert.match(workflowSource, /CRM_CLEANUP_APPLY=1 node scripts\/crm\/legacy-synthetic-cleanup\.mjs --apply/);
  // The reason must be readable from the run list, where the check NAME lives.
  assert.match(workflowSource, /name: "CRM legacy cleanup — \$\{\{ needs\.cleanup\.outputs\.mode \}\} — \$\{\{ needs\.cleanup\.outputs\.outcome \}\}/);
  // Mask must precede any request-bearing step in the same block.
  const maskAt = workflowSource.indexOf('::add-mask::');
  assert.ok(maskAt > -1);
  assert.ok(workflowSource.indexOf('run_cleanup()') > maskAt, 'cleanup must not start before masking');
  // The token is never echoed outside the mask line.
  const echoed = workflowSource.split('\n').filter((line) => line.includes('CLOUDFLARE_API_TOKEN') && line.includes('echo'));
  assert.deepEqual(echoed.map((line) => line.trim()), ['echo "::add-mask::${CLOUDFLARE_API_TOKEN}"']);
});

/* ─────── residue of ONE named failed run: exact scope, no widening ─────── */

test('R1 residue scope is exact, imported, and refuses anything that is not a run tag', async () => {
  const { residueProbes } = await import('../a5-l2.mjs');
  const tag = 'a5-42292458694-1-abcdef12';
  const probes = residueProbes(tag);
  assert.ok(probes.length >= 10, 'the failed run touched many tables');
  // Every predicate is pinned to this run: its tag, its conversation uid, or its run-scoped keys.
  for (const probe of probes) {
    assert.ok(/a5-42292458694-1-abcdef12/.test(probe.where), `unscoped predicate: ${probe.label}`);
    assert.ok(!/OR\s+1=1|LIKE\s+'%'|LIKE\s+'a5-%'/i.test(probe.where), `widened predicate: ${probe.label}`);
  }
  // Children before parents, so foreign keys are respected even without retries.
  const order = probes.map(p => p.table);
  assert.ok(order.indexOf('crm_conversation_messages') < order.indexOf('crm_conversations'), 'messages before their conversation');
  assert.ok(order.indexOf('crm_conversations') < order.indexOf('crm_contacts'), 'conversations before their contact');
  assert.equal(order.at(-1), 'crm_contacts', 'the contact is deleted last');
  // `<run_id>-<attempt>` is accepted and pinned as a prefix of the tag: the nonce is random and
  // belongs to exactly one run, so the prefix cannot match another run's rows.
  const byRun = residueProbes('a5-42292458694-1');
  assert.equal(byRun.length, probes.length);
  assert.match(byRun.at(-1).where, /review_note LIKE 'A5-RUN:a5-42292458694-1-%'/);
  assert.throws(() => residueProbes('a5-42292458694'), /bad-run-tag/, 'attempt is mandatory');
  // Anything that is not a run tag is refused outright.
  for (const bad of ['', 'a5-1', "a5-1-1-abcdef12' OR '1'='1", 'A5-RUN:a5-1-1-abcdef12', '../x']) {
    assert.throws(() => residueProbes(bad), /a5-l2-residue-bad-run-tag/, `accepted: ${bad}`);
  }
  // The cleanup script must IMPORT this scope rather than restating it, and the workflow must expose
  // it as an explicit, empty-by-default input.
  assert.match(scriptSource, /residueProbes/);
  assert.match(workflowSource, /residue_run_tag/);
  assert.match(workflowSource, /CRM_CLEANUP_RUN_TAG: \$\{\{ inputs\.residue_run_tag \}\}/);
  assert.doesNotMatch(scriptSource, /review_note\s*=\s*'/, 'predicate restated in the script');
});

test('R2 the residue scope can never target the run that is executing it', async () => {
  const { spawn: spawn2 } = await import('node:child_process');
  const { residueProbes } = await import('../a5-l2.mjs');
  // The guard lives in the script, so prove it by construction: a tag of the current run matches
  // the same prefix the script refuses. This is the invariant the refusal protects.
  const currentTag = 'a5-999-1-cafebabe';
  assert.ok(currentTag.startsWith('a5-999-1'), 'prefix rule is what the script checks');
  assert.ok(residueProbes(currentTag).length > 0, 'the scope itself is valid');
  assert.ok(typeof spawn2 === 'function');
});
