/**
 * A5 L2 — FINAL LIMITED FIX for PR #138: safe separation of PRE-L2 runs from L2-ELIGIBLE runs,
 * plus the documented legacy synthetic namespace. EXACTLY SEVEN new offline tests.
 *
 *   F1  a pre-L2 run with NO artifact is ineligible => NO deadlock, and NO run is skipped by
 *       date/count (exhaustive pagination, no `created` filter).
 *   F2  an L2-eligible run with a missing/unreadable ledger STILL stops; age / conclusion /
 *       display name / count never downgrade eligibility; contradictory evidence stops too.
 *   F3  an unproven LEGACY synthetic row (`TEST ONLY A5 ci-*`, known synthetic phones,
 *       `ci-e2e-ticket:%`, post-deploy synthetic conversations) => `unknown` + STOP, while real
 *       customer rows are NOT classified as synthetic; a zero-claim failure ledger cannot launder it.
 *   F4  a successful run A gives EVERY row its own independent evidence (row_hash, observed_id,
 *       parent, run identity, hash chain).
 *   F5  a PARTIAL failure of A publishes the evidence of the rows it DID create, and B can verify them.
 *   F6  B re-reads the rows and verifies row_hash, parent relations and A's run identity.
 *   F7  A and B never interfere, and absence of evidence is NEVER treated as success.
 *
 * Offline only: real 14-migration SQLite fixture, NO Cloudflare call, NO network, NO DB deletion,
 * NO Worker code, NO migration, NO workflow dispatch, NO production/backup database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRegistry } from '../../_worker/tests/_registry-fixture.mjs';
import {
  BASELINE_SCHEMA, L2_SCHEMA, a5RunIdentity, assertKeysFree, assertReadOnlySql,
  baselineFrom, buildLedger, classifyRows, createLedger, derivedPhone, enumerateLegacySuspects,
  enumerateRows, finalizeLedger, ledgerDigest, loadLedgers, preflightCleared, sha256Hex,
  submissionKey, tagOf, verifyLedgerIntegrity, appendEvent, canonical,
} from '../a5-l2.mjs';
import {
  A5_WRITE_STEP, L2_MECHANISM_MARKERS, L2_PREFLIGHT_STEP,
  classifyEligibility, collectPriorLedgers, fetchAllRuns, mechanismInWorkflow,
} from '../a5-l2-prior-runs.mjs';

const ID_A = a5RunIdentity({ GITHUB_RUN_ID: '700', GITHUB_RUN_ATTEMPT: '1', A5_L2_NONCE: 'cccccccc' });
const ID_B = a5RunIdentity({ GITHUB_RUN_ID: '701', GITHUB_RUN_ATTEMPT: '1', A5_L2_NONCE: 'dddddddd' });
const ID_C = a5RunIdentity({ GITHUB_RUN_ID: '702', GITHUB_RUN_ATTEMPT: '1', A5_L2_NONCE: 'eeeeeeee' });
const NOW = '2026-11-04T12:00:00Z';

/** The exact workflow text for a run that COULD publish an L2 ledger. */
const L2_WORKFLOW = [
  'name: CRM isolated Worker deploy and live auth E2E',
  ...L2_MECHANISM_MARKERS.map(m => `# ${m}`),
  `- name: ${L2_PREFLIGHT_STEP}`,
  `- name: ${A5_WRITE_STEP}`,
].join('\n');
/** A pre-L2 workflow version: it can write synthetic rows but has NO L2 mechanism at all. */
const PRE_L2_WORKFLOW = [
  'name: CRM isolated Worker deploy and live auth E2E',
  `- name: ${A5_WRITE_STEP}`,
  "run: node _worker/tests/live-a5-verify.mjs # no a5-l2 module in this version",
].join('\n');

const writeSteps = [{ name: A5_WRITE_STEP, conclusion: 'success' }];
const l2Steps = [{ name: L2_PREFLIGHT_STEP, conclusion: 'success' }, ...writeSteps];

function world() {
  const { sqlite } = buildRegistry({ ledger: true });
  const query = sql => { assertReadOnlySql(sql); return sqlite.prepare(sql).all(); };
  return { sqlite, query };
}

/** One realistic A5 synthetic group with Worker-generated IDs; `rows` selects a partial subset. */
function writeGroup(w, identity, suffix,
  rows = ['contact', 'phones', 'receipt', 'request', 'interaction', 'followup']) {
  const rt = identity.run_tag;
  const tag = tagOf(rt);
  const cid = randomUUID();
  const pA = derivedPhone(rt, `p-${suffix}-a`);
  const pB = derivedPhone(rt, `p-${suffix}-b`);
  const receipt = submissionKey(rt, `c-${suffix}`);
  const rid = randomUUID();
  const iid = randomUUID();
  const fid = randomUUID();
  const pending = [];
  if (rows.includes('contact')) {
    w.sqlite.prepare('INSERT INTO crm_contacts(id,name,communication_consent,review_note) VALUES(?,?,?,?)')
      .run(cid, `TEST ONLY A5 ${rt}-${suffix}`, 'request_only', tag);
    pending.push({ table: 'crm_contacts', lookup_value: cid, observed_id: cid,
      id_source: 'http-201-body', run_tag: rt, step: 'A5-L4' });
  }
  if (rows.includes('phones')) {
    for (const pk of [pA, pB]) {
      w.sqlite.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
        .run(randomUUID(), cid, pk, 'فحص', pk === pA ? 1 : 0);
      pending.push({ table: 'crm_contact_phones', lookup_value: pk,
        id_source: 'http-201-body+exact-key', parent: { table: 'crm_contacts', column: 'contact_id' },
        run_tag: rt, step: 'A5-L4' });
    }
  }
  if (rows.includes('receipt')) {
    w.sqlite.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
      .run(receipt, 'contact', cid);
    pending.push({ table: 'crm_idempotency_receipts', lookup_value: receipt,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'resource_id' },
      run_tag: rt, step: 'A5-L4' });
  }
  if (rows.includes('request')) {
    w.sqlite.prepare(`INSERT INTO crm_customer_requests
      (id,contact_id,kind,property_type,source,status,dedupe_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(rid, cid, 'buy', 'apartment', 'whatsapp', 'new',
        sha256Hex(submissionKey(rt, `r-${suffix}`)), NOW, NOW);
    pending.push({ table: 'crm_customer_requests', lookup_value: rid, observed_id: rid,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' },
      run_tag: rt, step: 'A5-L5' });
  }
  if (rows.includes('interaction')) {
    w.sqlite.prepare(`INSERT INTO crm_interactions
      (id,contact_id,request_id,kind,occurred_at,summary,source,created_by,dedupe_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(iid, cid, rid, 'call', NOW, 'TEST ONLY مكالمة صناعية',
        'phone', tag, sha256Hex(submissionKey(rt, `i-${suffix}`)), NOW);
    pending.push({ table: 'crm_interactions', lookup_value: iid, observed_id: iid,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' },
      run_tag: rt, step: 'A5-L6' });
  }
  if (rows.includes('followup')) {
    w.sqlite.prepare(`INSERT INTO crm_followups
      (id,contact_id,request_id,due_at,status,created_by,dedupe_key,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(fid, cid, rid, NOW, 'pending', tag,
        sha256Hex(submissionKey(rt, `f-${suffix}`)), NOW);
    pending.push({ table: 'crm_followups', lookup_value: fid, observed_id: fid,
      id_source: 'http-201-body', parent: { table: 'crm_contacts', column: 'contact_id' },
      run_tag: rt, step: 'A5-L6' });
  }
  return { cid, pA, pB, receipt, rid, iid, fid, pending };
}

const preflightFor = (w, ledgers, currentRunTag) =>
  classifyRows({ query: w.query, ledgers: ledgers.map(l => ({ error: 'ok', ledger: l })),
    currentRunTag });

const mkRunApi = (lengths, total, { failPage = 0 } = {}) => {
  const calls = [];
  const execGh = args => {
    calls.push(args);
    const flags = args.filter((_, i) => i > 0 && args[i - 1] === '-f');
    const page = Number((flags.find(f => String(f).startsWith('page=')) || 'page=1').slice(5));
    if (failPage === page) throw new Error('stub http 503');
    const n = lengths[page - 1] ?? 0;
    const start = lengths.slice(0, page - 1).reduce((a, b) => a + b, 0);
    return JSON.stringify({ total_count: total,
      workflow_runs: Array.from({ length: n }, (_, i) => ({
        id: 4_000_000_000 + start + i, head_sha: 'd'.repeat(40),
        conclusion: i % 2 ? 'failure' : 'cancelled',
        display_title: 'arbitrary display name, never evidence',
      })) });
  };
  return { execGh, calls };
};

/* ─────────────────────────────── F1 ─────────────────────────────── */

test('F1 pre-L2 run with NO artifact is ineligible (no deadlock); no date/count skipping', () => {
  assert.equal(mechanismInWorkflow(PRE_L2_WORKFLOW), 'absent');
  assert.equal(mechanismInWorkflow(L2_WORKFLOW), 'present');
  assert.equal(mechanismInWorkflow(L2_MECHANISM_MARKERS.slice(0, 3).join('\n')), 'ambiguous');

  const { execGh, calls } = mkRunApi([39], 39);
  const all = fetchAllRuns({ execGh, repo: 'o/r', now: new Date('2026-11-04T00:00:00Z') });
  assert.equal(all.runIds.length, 39, 'EVERY completed run is inspected');
  assert.equal(all.pagesFetched, 1);
  assert.equal(all.cutoffIsFilter, false);
  for (const args of calls) {
    assert.ok(!args.some(a => String(a).startsWith('created=')),
      'a time filter must never skip historical runs');
  }
  // An ancient, failed, arbitrarily-named pre-L2 run that DID write rows owes no impossible artifact.
  const ancient = { ...all.runs[0], id: '41118295521',
    conclusion: 'failure', displayTitle: 'anything at all' };
  const e = classifyEligibility({ runs: [ancient],
    readWorkflow: () => PRE_L2_WORKFLOW, readJobs: () => writeSteps });
  assert.equal(e.eligible.length, 0);
  assert.equal(e.ineligible.length, 1);
  assert.equal(e.ineligible[0].reason, 'pre-l2-workflow-version');
  assert.equal(e.ineligible[0].writeStepRan, true, 'it wrote rows; the artifact is not the proof');

  const dir = mkdtempSync(path.join(tmpdir(), 'a5-f1-'));
  try {
    let downloads = 0;
    const collected = collectPriorLedgers({
      runIds: e.eligible.map(r => r.id), priorDir: path.join(dir, 'p'),
      workDir: path.join(dir, 'w'), download: () => { downloads += 1; throw new Error('never'); },
    });
    assert.equal(collected.runs, 0);
    assert.equal(collected.ledgers, 0);
    assert.equal(downloads, 0, 'an ineligible run is never asked for a ledger');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────────── F2 ─────────────────────────────── */

test('F2 L2-eligible run with NO artifact STILL stops; old/failed/cancelled are never ignored', () => {
  const { execGh } = mkRunApi([100, 100, 17], 217);
  const all = fetchAllRuns({ execGh, repo: 'o/r' });
  assert.equal(all.runIds.length, 217, 'no count cap: all 217 runs are inspected');
  const e = classifyEligibility({ runs: all.runs,
    readWorkflow: () => L2_WORKFLOW, readJobs: () => l2Steps });
  assert.equal(e.eligible.length, 217);
  assert.equal(e.ineligible.length, 0);
  assert.ok(e.eligible.every(r => r.mechanism === 'present' && r.l2StepRan));
  assert.equal(e.workflowsRead, 1, 'workflow evidence cached by head_sha');

  const dir = mkdtempSync(path.join(tmpdir(), 'a5-f2-'));
  try {
    const priorDir = path.join(dir, 'p');
    const workDir = path.join(dir, 'w');
    // Every eligible run gets a readable ledger: none is skipped.
    const ok = collectPriorLedgers({ runIds: e.eligible.map(r => r.id), priorDir, workDir,
      download: (rid, dl) => writeFileSync(path.join(dl, `a5-l2-${rid}.json`),
        JSON.stringify({ schema: L2_SCHEMA, run_tag: `a5-${rid}-1-aaaaaaaa`, events: [] })) });
    assert.equal(ok.ledgers, 217);
    // One eligible run with a missing artifact = HARD STOP (even if cancelled/failed/ancient).
    assert.throws(() => collectPriorLedgers({ runIds: ['41118295521'],
      priorDir: path.join(dir, 'p2'), workDir: path.join(dir, 'w2'),
      download: () => { throw new Error('404'); } }),
      /a5-l2-ledger-artifact-unreadable:run=41118295521/);
    assert.throws(() => collectPriorLedgers({ runIds: ['41118295521'],
      priorDir: path.join(dir, 'p3'), workDir: path.join(dir, 'w3'), download: () => {} }),
      /a5-l2-ledger-artifact-missing:run=41118295521/);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const one = [{ id: '41852222160', headSha: 'e'.repeat(40), conclusion: 'cancelled',
    displayTitle: 'unrelated name' }];
  assert.throws(() => classifyEligibility({ runs: one,
    readWorkflow: () => { throw new Error('no commit'); }, readJobs: () => l2Steps }),
    /a5-l2-eligibility-workflow-unreadable:run=41852222160/);
  assert.throws(() => classifyEligibility({ runs: one,
    readWorkflow: () => L2_WORKFLOW, readJobs: () => { throw new Error('no jobs'); } }),
    /a5-l2-eligibility-jobs-unreadable:run=41852222160/);
  assert.throws(() => classifyEligibility({ runs: one,
    readWorkflow: () => L2_MECHANISM_MARKERS.slice(0, 3).join('\n'), readJobs: () => l2Steps }),
    /a5-l2-eligibility-workflow-ambiguous:run=41852222160/);
  assert.throws(() => classifyEligibility({ runs: one,
    readWorkflow: () => PRE_L2_WORKFLOW, readJobs: () => l2Steps }),
    /a5-l2-eligibility-mechanism-mismatch:run=41852222160/);
  assert.throws(() => classifyEligibility({ runs: one,
    readWorkflow: () => L2_WORKFLOW, readJobs: () => writeSteps }),
    /a5-l2-eligibility-writes-without-preflight:run=41852222160/);
  // A dispatch whose deploy job was skipped: mechanism in the file, but no L2 step ran, and no
  // write step ran either => ineligible, so it cannot create a new impossible-artifact deadlock.
  const skipped = classifyEligibility({ runs: one,
    readWorkflow: () => L2_WORKFLOW, readJobs: () => [] });
  assert.equal(skipped.eligible.length, 0);
  assert.equal(skipped.ineligible[0].reason, 'l2-preflight-step-not-reached');
});

/* ─────────────────────────────── F3 ─────────────────────────────── */

/** Insert the documented LEGACY namespace AND ordinary (real) customer rows. */
function legacyWorld() {
  const w = world();
  const legacy = w.sqlite;
  legacy.prepare('INSERT INTO crm_contacts(id,name,review_note) VALUES(?,?,?)')
    .run('legacy-c1', 'TEST ONLY A5 ci-41852222160', '');
  legacy.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
    .run('legacy-p1', 'legacy-c1', '201000000011', 'فحص', 1);
  legacy.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
    .run('ci-e2e-ticket:legacy1', 'contact', 'legacy-c1');
  legacy.prepare(`INSERT INTO crm_conversations
    (id,conversation_uid,chat_title,source_ref,raw_text,raw_sha256)
    VALUES(?,?,?,?,?,?)`)
    .run('legacy-conv1', 'legacy-uid-1', 'TEST ONLY محادثة قديمة',
      'post_deploy_e2e_synthetic', 'x', sha256Hex('x'));
  legacy.prepare(`INSERT INTO crm_customer_requests
    (id,contact_id,kind,property_type,source,status,dedupe_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('legacy-req1', 'legacy-c1', 'buy', 'apartment', 'whatsapp', 'new',
      sha256Hex('legacy-req'), NOW, NOW);
  legacy.prepare(`INSERT INTO crm_interactions
    (id,contact_id,kind,occurred_at,summary,source,created_by,dedupe_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('legacy-int1', 'legacy-c1', 'call', NOW, 'TEST ONLY A5 مكالمة صناعية',
      'phone', 'TEST ONLY A5 ci-1', sha256Hex('legacy-int'), NOW);
  // Ordinary customer rows: MUST NOT be classified as synthetic.
  legacy.prepare('INSERT INTO crm_contacts(id,name,review_note) VALUES(?,?,?)')
    .run('real-c1', 'عميل حقيقي', '');
  legacy.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary) VALUES(?,?,?,?,?)')
    .run('real-p1', 'real-c1', '201234567890', 'أساسي', 1);
  legacy.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
    .run('real-receipt-1', 'contact', 'real-c1');
  legacy.prepare(`INSERT INTO crm_conversations
    (id,conversation_uid,chat_title,source_ref,raw_text,raw_sha256)
    VALUES(?,?,?,?,?,?)`)
    .run('real-conv1', 'real-uid-1', 'محادثة حقيقية', 'whatsapp_export', 'y', sha256Hex('y'));
  return w;
}

test('F3 unproven legacy synthetic row => unknown + STOP; real rows untouched; no laundering', () => {
  const w = legacyWorld();
  // Without the fix these rows were INVISIBLE: the old scope only matched new L2 markers.
  // The receipts scope is widened ON PURPOSE (2026-11-06): a single-use ticket must be provable by
  // the run that minted it, otherwise every run leaves a row no future run can ever prove. The rest
  // of the legacy namespace stays probe-only — those rows can never receive evidence, so they must
  // keep stopping the run.
  assert.deepEqual(enumerateRows(w.query).map(r => `${r.table}|${r.a5_key}`),
    ['crm_idempotency_receipts|ci-e2e-ticket:legacy1'],
    'only the ticket receipt enters the provable scope; legacy contact rows stay probe-only');
  const suspects = enumerateLegacySuspects(w.query);
  assert.ok(suspects.length >= 6, `documented legacy rows must be inspected: ${suspects.length}`);
  const suspectKeys = new Set(suspects.map(s => `${s.table}|${s.a5_key}`));
  for (const needle of ['legacy-c1', '201000000011', 'ci-e2e-ticket:legacy1', 'legacy-uid-1']) {
    assert.ok([...suspectKeys].some(k => k.includes(needle)), `legacy marker not probed: ${needle}`);
  }
  // NO real customer row may be dragged into the synthetic namespace.
  for (const real of ['real-c1', '201234567890', 'real-receipt-1', 'real-uid-1']) {
    assert.ok(![...suspectKeys].some(k => k.includes(real)), `over-match on real data: ${real}`);
  }

  // Absence of a ledger artifact is NOT proof that no row was written.
  const none = classifyRows({ query: w.query, ledgers: [], currentRunTag: ID_B.run_tag });
  assert.equal(none.ok, false);
  assert.match(none.reason, /unknown-ownership:.*legacy-unproven/);
  assert.ok(none.legacy_suspects >= 6);
  assert.ok(none.verdicts.some(v => v.verdict === 'unknown:legacy-unproven'));

  // buildLedger must NOT be able to publish a ledger that implicitly declares this namespace clean.
  // Two refusals guard this, and either one is a legitimate STOP: a ticket receipt is now inside
  // the provable scope, so a pre-existing unproven one hits `unproven-preexisting-row` first; the
  // remaining legacy rows hit `unproven-legacy-row`. Publishing is refused in both cases.
  assert.throws(() => buildLedger({ identity: ID_B, baseline: baselineFrom(w.query),
    pending: [], query: w.query, conclusion: 'success' }),
  /a5-l2-unproven-(legacy|preexisting)-row/);

  // The deadlock fix publishes a genuine zero-claim failure ledger. It must NOT launder the rows.
  const failure = createLedger(ID_A, { schema: BASELINE_SCHEMA, ids: {},
    digest: sha256Hex(canonical({})) });
  failure.evidence_class = 'failure-no-ownership-claims';
  finalizeLedger(failure, 'failure', 'preflight-not-cleared');
  assert.equal(verifyLedgerIntegrity(failure), 'ok');
  assert.equal(failure.events.length, 0);
  assert.equal(Object.keys(failure.baseline.ids).length, 0);
  assert.equal(failure.conclusion, 'failure');
  const after = preflightFor(w, [failure], ID_B.run_tag);
  assert.equal(after.ok, false, 'a zero-claim ledger must not clear ownership');
  assert.match(after.reason, /legacy-unproven/);
  assert.ok(!after.verdicts.some(v => v.verdict === 'baseline-origin'),
    'no retroactive baseline/ownership proof for legacy rows');
});

/* ─────────────────────────────── F4 ─────────────────────────────── */

test('F4 success: EVERY new synthetic row gets its own independent, hash-chained evidence', () => {
  const w = world();
  const baseline = baselineFrom(w.query);
  assert.equal(assertKeysFree(w.query, ID_A.run_tag), true);
  const g = writeGroup(w, ID_A, 'a');
  const ledger = buildLedger({ identity: ID_A, baseline, pending: g.pending,
    query: w.query, conclusion: 'success' });
  assert.equal(verifyLedgerIntegrity(ledger), 'ok');
  assert.equal(ledger.conclusion, 'success');
  assert.ok(ledger.events.length >= g.pending.length);
  assert.equal(ledger.baseline.digest, baseline.digest);
  let prev = sha256Hex(`a5-l2-genesis|${ledger.run_tag}`);
  for (const [i, e] of ledger.events.entries()) {
    assert.equal(e.seq, i + 1);
    assert.equal(e.prev_event_sha256, prev, `chain break at event ${i + 1}`);
    assert.equal(e.run_id, ID_A.run_id);
    assert.equal(e.run_attempt, ID_A.run_attempt);
    assert.equal(e.run_tag, ID_A.run_tag);
    assert.match(e.row_hash, /^[0-9a-f]{64}$/, 'independent per-row row_hash');
    assert.ok(e.observed_id && e.observed_id.length > 0, 'Worker-generated observed_id');
    assert.ok(e.row_columns_sha256 && Object.keys(e.row_columns_sha256).length > 0);
    const { event_sha256, ...rest } = e;
    assert.equal(sha256Hex(canonical(rest)), event_sha256, 'per-event digest');
    prev = event_sha256;
  }
  // Parent links are independent events, never inferred from a parent's proof alone.
  const phone = ledger.events.find(e => e.table === 'crm_contact_phones');
  assert.ok(phone?.parent, 'child row has its own parent link');
  assert.equal(phone.parent.table, 'crm_contacts');
  assert.equal(ledger.ledger_sha256, ledgerDigest(ledger));
  assert.equal(preflightFor(w, [ledger], ID_B.run_tag).ok, true, 'B can verify every A row');
});

/* ─────────────────────────────── F5 ─────────────────────────────── */

test('F5 partial failure of A publishes evidence for the rows it DID create; B verifies them', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a', ['contact', 'phones', 'receipt']);
  const ledgerA = buildLedger({ identity: ID_A, baseline: baselineA, pending: g.pending,
    query: w.query, conclusion: 'failure', stopped_at: 'A5-L4:simulated-crash' });
  assert.equal(ledgerA.conclusion, 'failure', 'partial failure NEVER claims success');
  assert.match(ledgerA.stopped_at, /simulated-crash/);
  assert.equal(verifyLedgerIntegrity(ledgerA), 'ok');
  assert.ok(ledgerA.events.length >= 4, 'contact + 2 phones + receipt each own an event');
  for (const table of ['crm_contacts', 'crm_contact_phones', 'crm_idempotency_receipts']) {
    assert.ok(ledgerA.events.some(e => e.table === table), `missing evidence for ${table}`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'a5-f5-'));
  try {
    // The failure ledger is a REAL readable artifact for the next eligible run.
    writeFileSync(path.join(dir, `a5-l2-${ledgerA.run_tag}.json`), JSON.stringify(ledgerA));
    const loaded = loadLedgers(dir, ID_B.run_tag);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].error, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const pre = preflightFor(w, [ledgerA], ID_B.run_tag);
  assert.equal(pre.ok, true, pre.reason);
  assert.ok(pre.verdicts.filter(v => v.verdict === 'previous-a5-proven').length >= 4);
  // B proceeds with its own baseline and keeps A's rows intact (no delete, no re-attestation).
  const gB = writeGroup(w, ID_B, 'b', ['contact', 'phones']);
  const ledgerB = buildLedger({ identity: ID_B, baseline: baselineFrom(w.query),
    pending: gB.pending, query: w.query, priorLedgers: [ledgerA], conclusion: 'success' });
  assert.equal(verifyLedgerIntegrity(ledgerB), 'ok');
  assert.ok(ledgerB.events.every(e => e.run_tag === ID_B.run_tag));
  assert.ok(!ledgerB.events.some(e => e.unique_key === g.cid), 'A rows are not re-attested by B');
});

/* ─────────────────────────────── F6 ─────────────────────────────── */

test('F6 B re-reads rows and verifies row_hash, parent relations and A run identity', () => {
  const w = world();
  const g = writeGroup(w, ID_A, 'a');
  const ledgerA = buildLedger({ identity: ID_A, baseline: baselineFrom(w.query),
    pending: g.pending, query: w.query, conclusion: 'success' });
  assert.equal(preflightFor(w, [ledgerA], ID_B.run_tag).ok, true);

  // (1) B RE-READS the live row and recomputes row_hash. A ledger whose stored claim no longer
  // matches the live row is still structurally valid, but B must classify that row `unknown`.
  // (The live row is not mutated: 0012 makes request identity columns immutable by design.)
  const rebuild = (source, map) => {
    const out = createLedger(ID_A, source.baseline);
    for (const e of map(source.events)) {
      const { event_sha256, ...rest } = e;
      appendEvent(out, { ...rest, parent: rest.parent });
    }
    finalizeLedger(out, source.conclusion, source.stopped_at);
    return out;
  };
  const wrongClaim = rebuild(ledgerA, events => events.map((e, i) =>
    i === 0 ? { ...e, row_hash: '0'.repeat(64) } : e));
  assert.equal(verifyLedgerIntegrity(wrongClaim), 'ok');
  const tampered = preflightFor(w, [wrongClaim], ID_B.run_tag);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.verdicts.some(v => v.verdict === 'unknown:row-hash-mismatch'),
    'B recomputes row_hash from the live row instead of trusting the stored claim');

  // (2) Removing the parent's independent event breaks the child => unknown + STOP.
  const stripped = createLedger(ID_A, ledgerA.baseline);
  for (const e of ledgerA.events.filter(x => x.table !== 'crm_contacts')) {
    const { event_sha256, ...rest } = e;
    appendEvent(stripped, { ...rest, parent: rest.parent });
  }
  finalizeLedger(stripped, 'success');
  assert.equal(verifyLedgerIntegrity(stripped), 'ok');
  const noParent = preflightFor(w, [stripped], ID_B.run_tag);
  assert.equal(noParent.ok, false);
  assert.ok(noParent.verdicts.some(v => v.verdict === 'unknown:parent-event-missing'),
    'a child is never proven by a parent proof alone');

  // (3) Prior run identity is bound into the ledger and verified.
  assert.equal(verifyLedgerIntegrity({ ...ledgerA, run_id: '999' }), 'run-identity-mismatch');
  const digestBroken = { ...ledgerA, events: ledgerA.events.map((e, i) =>
    i === 0 ? { ...e, row_hash: '0'.repeat(64) } : e) };
  assert.notEqual(verifyLedgerIntegrity(digestBroken), 'ok');
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-f6-'));
  try {
    writeFileSync(path.join(dir, 'a5-l2-tampered.json'), JSON.stringify(digestBroken));
    assert.equal(loadLedgers(dir, ID_B.run_tag)[0].error, 'ledger-digest');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(preflightFor(w, [ledgerA], ID_B.run_tag).ok, true, 'A data stayed intact');
});

/* ─────────────────────────────── F7 ─────────────────────────────── */

test('F7 A and B do not interfere; absence of evidence is NEVER success', () => {
  const w = world();
  assert.notEqual(ID_A.run_tag, ID_B.run_tag);
  assert.notEqual(derivedPhone(ID_A.run_tag, 'contact-primary'),
    derivedPhone(ID_B.run_tag, 'contact-primary'));
  assert.notEqual(submissionKey(ID_A.run_tag, 'x'), submissionKey(ID_B.run_tag, 'x'));
  assert.equal(assertKeysFree(w.query, ID_A.run_tag), true);
  assert.equal(assertKeysFree(w.query, ID_B.run_tag), true);

  // A writes FIRST and gets its own ledger; B then writes into the SAME database.
  const gA = writeGroup(w, ID_A, 'a');
  const ledgerA = buildLedger({ identity: ID_A, baseline: baselineFrom(w.query),
    pending: gA.pending, query: w.query, conclusion: 'success' });
  assert.equal(preflightFor(w, [ledgerA], ID_B.run_tag).ok, true,
    'B verifies all A rows; A data stays intact');
  const gB = writeGroup(w, ID_B, 'b');
  assert.notEqual(gA.cid, gB.cid);

  // No artifact at all + rows present => unknown, never "clean".
  const absent = classifyRows({ query: w.query, ledgers: [], currentRunTag: ID_C.run_tag });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /unknown-ownership/);
  assert.ok(absent.verdicts.some(v => v.verdict === 'unknown'));
  // A's ledger alone cannot bless B's brand-new rows: absence of evidence is not success.
  const bOnly = preflightFor(w, [ledgerA], ID_C.run_tag);
  assert.equal(bOnly.ok, false);
  assert.ok(bOnly.verdicts.some(v => v.a5_id === gB.cid && v.verdict === 'unknown'));

  // Only an explicit, cleared, run-scoped preflight may let claim-making ledgers be published.
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-f7-'));
  try {
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'a5-l2-preflight-missing');
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: false,
      reason: 'unknown-ownership:crm_contacts:unknown', run_tag: ID_B.run_tag }));
    assert.match(preflightCleared(dir, ID_B.run_tag), /a5-l2-preflight-not-cleared/);
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: true,
      reason: 'clean', run_tag: ID_A.run_tag }));
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'a5-l2-preflight-run-tag-mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // B's ledger keeps A's run identity for A rows (no re-attestation), and a third run verifies both.
  const ledgerB = buildLedger({ identity: ID_B, baseline: baselineFrom(w.query),
    pending: gB.pending, query: w.query, priorLedgers: [ledgerA], conclusion: 'success' });
  assert.equal(verifyLedgerIntegrity(ledgerB), 'ok');
  assert.ok(ledgerB.events.every(e => e.run_tag === ID_B.run_tag));
  assert.ok(!ledgerB.events.some(e => e.unique_key === gA.cid), 'A rows are not re-attested by B');
  const both = preflightFor(w, [ledgerA, ledgerB], ID_C.run_tag);
  assert.equal(both.ok, true, both.reason);
  assert.ok(both.verdicts.filter(v => v.verdict === 'previous-a5-proven').length
    >= gA.pending.length + gB.pending.length, 'A and B never interfere');
});
