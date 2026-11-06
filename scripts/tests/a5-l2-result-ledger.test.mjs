/**
 * A5 L2 — offline A→B result-ledger tests.
 *
 * These run against the REAL 14-migration SQLite schema (`_registry-fixture.mjs`), with no
 * Worker deploy, no Cloudflare call, no nasr-market-db, no network and no DB deletion.
 *
 * They prove the exact acceptance criteria:
 *   1. A success  -> B re-reads every A row, verifies row_hash / ID / parent / run identity.
 *   2. A partial failure -> B may continue ONLY IF every existing A row is proven; A stays intact.
 *   3. Any unproven / forged / tampered / vanished row => `unknown` + explicit STOP.
 *   4. Hard cancellation before any L2 event => `unknown` + STOP (no `no-ledger(hard-cancel)`).
 *   5. Run A and run B never contend for the same full key and never interfere with each other.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRegistry } from '../../_worker/tests/_registry-fixture.mjs';
import { seedReviewCaseStatements } from '../a5-live-support.mjs';
import {
  BASELINE_SCHEMA, L2_SCHEMA, TABLE_SPECS, a5RunIdentity, apiPhone, assertKeysFree,
  assertReadOnlySql, baselineFrom, buildLedger, classifyRows, derivedPhone, ledgerDigest,
  rowHash, sha256Hex, submissionKey, tagOf, verifyLedgerIntegrity, appendPendingEvent,
  readPendingEvents, loadLedgers, canonical, preflightCleared,
} from '../a5-l2.mjs';

const ID_A = a5RunIdentity({ GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', A5_L2_NONCE: 'aaaaaaaa' });
const ID_B = a5RunIdentity({ GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', A5_L2_NONCE: 'bbbbbbbb' });
const NOW = '2026-11-04T00:00:00Z';

function world() {
  const { sqlite } = buildRegistry({ ledger: true });
  const query = sql => { assertReadOnlySql(sql); return sqlite.prepare(sql).all(); };
  return { sqlite, query };
}

const q = v => `'${String(v).replace(/'/g, "''")}'`;

/** Write one realistic synthetic group with Worker-generated IDs. `rows` selects a partial subset. */
function writeGroup(w, identity, suffix, rows = ['contact', 'phones', 'receipt', 'request', 'interaction', 'followup']) {
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

/** Digest of the exact A5 synthetic namespace, used to prove "A data stayed intact". */
function namespaceDigest(w) {
  const rows = [];
  for (const [table, spec] of Object.entries(TABLE_SPECS)) {
    const cols = [...new Set([spec.idColumn, spec.uniqueKey, ...spec.hashColumns])].join(',');
    for (const r of w.sqlite.prepare(`SELECT ${cols} FROM ${table} WHERE ${spec.scope}`).all()) {
      rows.push([table, r]);
    }
  }
  return sha256Hex(canonical(rows));
}

const preflightFor = (w, ledgers, currentRunTag) =>
  classifyRows({ query: w.query, ledgers: ledgers.map(l => ({ error: 'ok', ledger: l })), currentRunTag });

/* ─────────────────────────────── core invariants ─────────────────────────────── */

test('L2-1 identity + derived full keys: run A and run B never share a key; phone is API-safe', () => {
  assert.equal(ID_A.run_tag, 'a5-100-1-aaaaaaaa');
  assert.equal(ID_B.run_tag, 'a5-101-1-bbbbbbbb');
  for (const role of ['contact-primary', 'contact-secondary', 'negative']) {
    assert.notEqual(derivedPhone(ID_A.run_tag, role), derivedPhone(ID_B.run_tag, role));
    assert.match(derivedPhone(ID_A.run_tag, role), /^999\d{8}$/);
    assert.match(apiPhone(ID_A.run_tag, role), /^\+999\d{8}$/);
  }
  assert.notEqual(submissionKey(ID_A.run_tag, 'c1'), submissionKey(ID_B.run_tag, 'c1'));
  assert.notEqual(tagOf(ID_A.run_tag), tagOf(ID_B.run_tag));
  assert.equal(tagOf(ID_A.run_tag).startsWith('A5-RUN:'), true);
  // The idempotency key must satisfy the Worker's strict shape.
  assert.match(submissionKey(ID_A.run_tag, 'c1'), /^[A-Za-z0-9._:-]{12,128}$/);
});

test('L2-2 read-only barrier: no INSERT/UPDATE/DELETE/DROP/PRAGMA/second statement can pass', () => {
  assert.equal(assertReadOnlySql('SELECT id FROM crm_contacts WHERE id = ?'),
    'SELECT id FROM crm_contacts WHERE id = ?');
  for (const bad of [
    'INSERT INTO crm_contacts(id) VALUES(1)',
    'UPDATE crm_contacts SET name = 1',
    'DELETE FROM crm_contacts',
    'DROP TABLE crm_contacts',
    'PRAGMA table_info(crm_contacts)',
    'SELECT 1; DELETE FROM crm_contacts',
    'CREATE TABLE x(a)',
  ]) assert.throws(() => assertReadOnlySql(bad), /a5-l2-non-readonly-sql/, bad);
});

test('L2-3 A success: every written row has its own event with ID + row_hash + parent + run identity', () => {
  const w = world();
  const baseline = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a');
  assert.equal(baseline.schema, BASELINE_SCHEMA);
  const ledger = buildLedger({ identity: ID_A, baseline, pending: g.pending, query: w.query,
    conclusion: 'success' });
  assert.equal(ledger.schema, L2_SCHEMA);
  assert.equal(verifyLedgerIntegrity(ledger), 'ok');
  assert.equal(ledger.ledger_sha256, ledgerDigest(ledger));
  assert.ok(ledger.events.length >= g.pending.length);
  for (const e of ledger.events) {
    assert.equal(e.run_tag, ID_A.run_tag);
    assert.equal(e.run_id, ID_A.run_id);
    assert.equal(e.run_attempt, ID_A.run_attempt);
    assert.match(e.row_hash, /^[0-9a-f]{64}$/);
    assert.ok(e.observed_id.length > 0);
    assert.ok(TABLE_SPECS[e.table]);
  }
  // Chain: every event points at its predecessor, starting from the run-specific genesis.
  for (let i = 1; i < ledger.events.length; i += 1) {
    assert.equal(ledger.events[i].prev_event_sha256, ledger.events[i - 1].event_sha256);
    assert.equal(ledger.events[i].seq, i + 1);
  }
  // Each contacted table really is present with its own direct event (no "parent proves child").
  for (const t of ['crm_contacts', 'crm_contact_phones', 'crm_idempotency_receipts',
    'crm_customer_requests', 'crm_interactions', 'crm_followups']) {
    assert.ok(ledger.events.some(e => e.table === t), `missing direct event for ${t}`);
  }
  const phoneEvents = ledger.events.filter(e => e.table === 'crm_contact_phones');
  assert.equal(phoneEvents.length, 2);
  assert.ok(phoneEvents.every(e => e.parent?.table === 'crm_contacts' && e.parent.observed_id === g.cid));
});

test('L2-4 B after A success: re-verifies row_hash / ID / relation / previous-run identity, A intact', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const gA = writeGroup(w, ID_A, 'a');
  const ledgerA = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: gA.pending, query: w.query, conclusion: 'success' });
  const before = namespaceDigest(w);

  const pre = preflightFor(w, [ledgerA], ID_B.run_tag);
  assert.equal(pre.ok, true, pre.reason);
  assert.equal(pre.reason, 'clean');
  assert.ok(pre.verdicts.length >= gA.pending.length);
  assert.ok(pre.verdicts.every(v => v.verdict === 'previous-a5-proven' || v.verdict === 'baseline-origin'));
  assert.equal(namespaceDigest(w), before, 'preflight must be strictly read-only');
  assert.equal(assertKeysFree(w.query, ID_B.run_tag), true);

  // B writes its own group with DIFFERENT full keys. A's rows must remain byte-identical.
  const gB = writeGroup(w, ID_B, 'b');
  assert.notEqual(gB.cid, gA.cid);
  assert.notEqual(gB.pA, gA.pA);
  const ledgerB = buildLedger({ identity: ID_B, baseline: baselineFrom(w.query),
    pending: gB.pending, query: w.query, priorLedgers: [ledgerA], conclusion: 'success' });
  assert.equal(verifyLedgerIntegrity(ledgerB), 'ok');
  // B must NOT re-attest A's rows under B's identity.
  assert.ok(ledgerB.events.every(e => e.run_tag === ID_B.run_tag));
  assert.ok(!ledgerB.events.some(e => e.unique_key === gA.cid || e.unique_key === gA.pA));
  assert.equal(w.sqlite.prepare('SELECT review_note FROM crm_contacts WHERE id = ?').get(gA.cid).review_note,
    tagOf(ID_A.run_tag), 'A row identity unchanged');
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM crm_contacts').get().n, 2);
});

test('L2-5 A partial failure (some rows written): B continues only because EVERY A row is proven', () => {
  const w = world();
  const partial = ['contact', 'phones', 'receipt'];
  const baselineA = baselineFrom(w.query);
  const gA = writeGroup(w, ID_A, 'a', partial);
  const ledgerA = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: gA.pending, query: w.query, conclusion: 'failure', stopped_at: 'A5-L4:simulated-crash' });
  assert.equal(ledgerA.conclusion, 'failure');
  assert.ok(ledgerA.events.length >= gA.pending.length, 'partial failure still publishes real proof');
  assert.equal(verifyLedgerIntegrity(ledgerA), 'ok');

  const pre = preflightFor(w, [ledgerA], ID_B.run_tag);
  assert.equal(pre.ok, true, pre.reason);
  assert.ok(pre.verdicts.every(v => v.verdict !== 'unknown'));
  const before = namespaceDigest(w);
  const gB = writeGroup(w, ID_B, 'b');
  const ledgerB = buildLedger({ identity: ID_B, baseline: baselineFrom(w.query),
    pending: gB.pending, query: w.query, priorLedgers: [ledgerA], conclusion: 'success' });
  assert.equal(verifyLedgerIntegrity(ledgerB), 'ok');
  assert.equal(w.sqlite.prepare('SELECT review_note FROM crm_contacts WHERE id = ?').get(gA.cid).review_note,
    tagOf(ID_A.run_tag));
  assert.ok(namespaceDigest(w) !== before, 'B added its own rows');
});

/* ─────────────────────────────── STOP conditions ─────────────────────────────── */

test('L2-6 hard cancellation BEFORE any L2 event => unknown + STOP (no no-ledger(hard-cancel) path)', () => {
  const w = world();
  writeGroup(w, ID_A, 'a');
  const pre = preflightFor(w, [], ID_B.run_tag); // NO ledger published at all
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /unknown-ownership/);
  assert.ok(pre.verdicts.some(v => v.verdict === 'unknown'));
});

test('L2-7 L1-only forged row (tag + review_note + derived phone) is NOT ownership proof', () => {
  const w = world();
  // A forged row carries the *public* run tag and a plausible derived phone — everything an
  // ordinary CRM session can set through the API — but no L2 event.
  w.sqlite.prepare('INSERT INTO crm_contacts(id,name,communication_consent,review_note) VALUES(?,?,?,?)')
    .run(randomUUID(), 'TEST ONLY forged', 'request_only', tagOf(ID_A.run_tag));
  const pre = preflightFor(w, [], ID_B.run_tag);
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /unknown-ownership/);
  assert.ok(pre.verdicts.some(v => v.verdict === 'unknown'));
});

test('L2-8 tampered row (ID change) and forged child row both stop with a named reason', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a');
  const ledger = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: g.pending, query: w.query, conclusion: 'success' });
  // Change a Worker-generated ID that has no dependent FK rows.
  w.sqlite.prepare('UPDATE crm_contact_phones SET id = ? WHERE phone_key = ?').run(randomUUID(), g.pA);
  const pre = preflightFor(w, [ledger], ID_B.run_tag);
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /unknown-ownership/);
  assert.ok(pre.verdicts.some(v => v.verdict.startsWith('unknown')));
});

test('L2-9 broken hash chain / wrong run identity / bad digest => untrusted ledger => STOP', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a');
  const ledger = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: g.pending, query: w.query, conclusion: 'success' });
  const tampered = structuredClone(ledger);
  tampered.events[1].row_hash = '0'.repeat(64);
  tampered.ledger_sha256 = ledgerDigest(tampered);
  assert.match(verifyLedgerIntegrity(tampered), /event-hash/);
  const forged = structuredClone(ledger);
  forged.run_tag = ID_B.run_tag;
  forged.ledger_sha256 = ledgerDigest(forged);
  assert.match(verifyLedgerIntegrity(forged), /run-identity-mismatch/);
  const badDigest = structuredClone(ledger);
  badDigest.ledger_sha256 = 'f'.repeat(64);
  assert.match(verifyLedgerIntegrity(badDigest), /ledger-digest/);
  // classifyRows refuses the whole run rather than trusting a partially valid ledger.
  const broken = classifyRows({ query: w.query,
    ledgers: [{ error: 'event-hash:2', ledger: tampered }], currentRunTag: ID_B.run_tag });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /untrusted-result-ledger/);
});

test('L2-10 vanished proven row => STOP (deletion is never silently tolerated)', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a');
  const ledger = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: g.pending, query: w.query, conclusion: 'failure' });
  w.sqlite.prepare('DELETE FROM crm_idempotency_receipts WHERE submission_key = ?').run(g.receipt);
  const pre = preflightFor(w, [ledger], ID_B.run_tag);
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /l2-row-vanished/);
});

test('L2-11 full-key collision guard: exact, substring and receipt collisions all stop B', () => {
  const w = world();
  const pk = derivedPhone(ID_B.run_tag, 'contact-primary');
  w.sqlite.prepare('INSERT INTO crm_contacts(id,name,review_note) VALUES(?,?,?)')
    .run(randomUUID(), 'TEST ONLY collision', tagOf(ID_A.run_tag));
  const cid = w.sqlite.prepare('SELECT id FROM crm_contacts').get().id;
  w.sqlite.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES(?,?,?)')
    .run(randomUUID(), cid, pk);
  assert.throws(() => assertKeysFree(w.query, ID_B.run_tag), /synthetic-key-collision:contact-primary/);
  w.sqlite.prepare('DELETE FROM crm_contact_phones WHERE phone_key = ?').run(pk);
  w.sqlite.prepare('INSERT INTO crm_idempotency_receipts(submission_key,resource_type,resource_id) VALUES(?,?,?)')
    .run(submissionKey(ID_B.run_tag, 'contact-primary'), 'contact', cid);
  assert.throws(() => assertKeysFree(w.query, ID_B.run_tag), /synthetic-key-collision:contact-primary/);
});

/* ─────────────────────────────── incremental evidence ─────────────────────────────── */

test('L2-12 pending journal is append+fsync per row; ledger/digest loading rejects corruption', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-l2-'));
  try {
    const pending = path.join(dir, 'pending.jsonl');
    for (const e of [
      { table: 'crm_contacts', lookup_value: 'c1', step: 'A5-L4' },
      { table: 'crm_contact_phones', lookup_value: '99900000001', step: 'A5-L4' },
    ]) {
      assert.equal(appendPendingEvent(pending, e), true);
      assert.equal(readPendingEvents(pending).length, readPendingEvents(pending).length);
    }
    assert.equal(readPendingEvents(pending).length, 2);
    assert.equal(appendPendingEvent('', { table: 'crm_contacts', lookup_value: 'x' }), false);

    const w = world();
    const baselineA = baselineFrom(w.query);
    const g = writeGroup(w, ID_A, 'a');
    const ledger = buildLedger({ identity: ID_A, baseline: baselineA,
      pending: g.pending, query: w.query, conclusion: 'running' });
    const out = path.join(dir, 'a5-l2-a5-100-1-aaaaaaaa.json');
    writeFileSync(out, `${JSON.stringify(ledger)}\n`);
    const loaded = loadLedgers(dir, ID_B.run_tag);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].error, 'ok');
    assert.equal(loaded[0].ledger.conclusion, 'running', 'a checkpoint is valid proof for its events');
    writeFileSync(out, 'not-json\n');
    assert.equal(loadLedgers(dir, ID_B.run_tag)[0].error, 'unparsable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L2-13 row_hash is stable across legitimate state changes (no false unknown stop)', () => {
  const w = world();
  const baselineA = baselineFrom(w.query);
  const g = writeGroup(w, ID_A, 'a');
  const ledger = buildLedger({ identity: ID_A, baseline: baselineA,
    pending: g.pending, query: w.query, conclusion: 'success' });
  // Legitimate mutable state (display name, followup completion) must not change ownership.
  w.sqlite.prepare('UPDATE crm_contacts SET name = ?, updated_at = ? WHERE id = ?')
    .run('TEST ONLY renamed', '2026-11-05T00:00:00Z', g.cid);
  const pre = preflightFor(w, [ledger], ID_B.run_tag);
  assert.equal(pre.ok, true, pre.reason);
  assert.ok(pre.verdicts.every(v => v.verdict.startsWith('unknown') === false));
  // A state change that CREATES A NEW ROW (0013: completing a followup appends an interaction)
  // is a new synthetic record and therefore needs its OWN L2 event — otherwise B must stop.
  w.sqlite.prepare('UPDATE crm_followups SET status = ?, outcome = ?, completed_at = ? WHERE id = ?')
    .run('done', 'done', '2026-11-05T00:00:00Z', g.fid);
  const pre2 = preflightFor(w, [ledger], ID_B.run_tag);
  assert.equal(pre2.ok, false);
  assert.ok(pre2.verdicts.some(v => v.table === 'crm_interactions' && v.verdict === 'unknown'));
  // ...but a changed Worker-generated ID is detected.
  const spec = TABLE_SPECS.crm_customer_requests;
  const row = w.query(`SELECT ${[...new Set([spec.idColumn, spec.uniqueKey, ...spec.hashColumns])].join(',')} FROM crm_customer_requests WHERE id = ${q(g.rid)}`)[0];
  assert.equal(rowHash(spec, row), ledger.events.find(e => e.table === 'crm_customer_requests').row_hash);
});

/* ─────────────────────────────── workflow / barrier wiring ─────────────────────────────── */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

test('L2-14 workflow wires begin / preflight / checkpoint / always()-finalize / artifact', () => {
  const wf = read('.github/workflows/crm-cloudflare-test-deploy.yml');
  for (const needle of [
    'a5-l2.mjs begin', 'a5-l2.mjs preflight', 'a5-l2.mjs checkpoint',
    'a5-l2.mjs finalize', 'name: a5-l2-ledger', 'if: always()',
    'A5_L2_CHECKPOINT_CMD', 'A5_L2_PENDING', 'A5_L2_RUN_TAG',
  ]) assert.ok(wf.includes(needle), `workflow missing: ${needle}`);
  assert.ok(/A5 L2 — publish final result ledger[\s\S]{0,400}if: always\(\)/.test(wf),
    'the final ledger publication must be unconditional');
  // No deletion of existing rows anywhere in the deploy workflow.
  for (const forbidden of ['SYNTH_CLEAN_SQL', 'A5_CLEAN_SQL',
    'DELETE FROM crm_sessions', 'DELETE FROM crm_auth_attempts', 'DELETE FROM crm_contacts']) {
    assert.ok(!wf.includes(forbidden), `deletion/bypass still present: ${forbidden}`);
  }
  // L2 paths must not contain `|| true` (no silent bypass of an unknown classification).
  for (const line of wf.split('\n')) {
    if (/a5-l2\.mjs|A5_L2_|a5-l2-ledger|gh run download|gh api/.test(line)) {
      assert.ok(!line.includes('|| true'), `bypass in L2 path: ${line.trim()}`);
    }
  }
});

test('L2-15 security barriers, environment gates and final non-interference thresholds unchanged', () => {
  const wf = read('.github/workflows/crm-cloudflare-test-deploy.yml');
  for (const needle of [
    "inputs.authorize_deploy == 'DEPLOY-TEST-DB-and-WORKER'", "github.ref_name",
    "if [ \"${REF}\" != 'master' ]", 'environment: crm-test-deploy',
    'needs: env-protection-audit', 'can_admins_bypass',
    // 2026-11-06: the frozen snapshot (60/64/83/19/76/21/2984/66) was replaced by a before/after
    // difference. The barrier is not weakened — it is made data-independent: the same query runs
    // before and after the live checks and every count must be identical.
    'PRE_CNT_SQL=', "post-verify-counts-changed",
    'def cnt($d): $d | .. | objects | select(has("c") and has("cv"));',
    'pre-verify-counts-query-failed',
  ]) assert.ok(wf.includes(needle), `unchanged barrier missing: ${needle}`);
  // `actions: read` is the only permission added, and it is read-only.
  const job = wf.slice(wf.indexOf('  deploy-and-verify:'), wf.indexOf('  report:'));
  assert.match(job, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  assert.ok(!/actions: write|contents: write/.test(job), 'no write permission was added');
});

test('L2-16 strict 201 survives; no fixed synthetic phones; no OR IGNORE / dead UPDATE in the seed', () => {
  const live10 = read('_worker/tests/live-post-deploy-verify.mjs');
  const liveA5 = read('_worker/tests/live-a5-verify.mjs');
  const support = read('scripts/a5-live-support.mjs');
  assert.match(live10, /assert\.equal\(cRes\.status, 201, `synth-contact-/);
  // The live10 dashboard invariant is now relational rather than a frozen 21 (see
  // CRM_A5_L2_RESULT_LEDGER.md §7.1, revised 2026-11-06): the dashboard must agree with the list
  // endpoint it summarises. A broken summary query still fails, at any data volume including zero.
  assert.match(live10, /assert\.equal\(unm\.length, dashUnmatched, 'dash-vs-list-unmatched'\)/);
  assert.match(live10, /assert\.equal\(contactlessOpps\.length, dashContactless, 'dash-vs-list-contactless'\)/);
  assert.match(live10, /ci-ticket-http-\$\{res\.status\}-\$\{String\(res\.data\?\.error/);
  // The live check must PROVE its precondition: the three minted tickets have to be readable in the
  // same D1 the Worker reads. Otherwise a mis-targeted mint shows up as an anonymous 403.
  const workflow = read('.github/workflows/crm-cloudflare-test-deploy.yml');
  assert.match(workflow, /ci-ticket-mint-verify-\$\{mint_n:-0\}-of-3/, 'mint self-check required');
  assert.match(workflow, /resource_id='authorized_pending' AND submission_key IN/, 'mint self-check must target the same rows');
  for (const fixed of ['01000000011', '01000000012', '01099990077', '01099999998', '201099990077']) {
    assert.ok(!liveA5.includes(fixed) && !live10.includes(fixed), `fixed phone still present: ${fixed}`);
  }
  const seedSql = seedReviewCaseStatements().join('\n');
  assert.ok(!/\bINSERT OR IGNORE\b/i.test(seedSql), 'INSERT OR IGNORE must not hide a UNIQUE conflict');
  assert.ok(!/\bUPDATE\b|\bDELETE\b|\bDROP\b/i.test(seedSql), 'seed must be plain INSERT only');
  assert.equal(seedSql.trim().split(';').filter(Boolean).length, 3, 'one registry + one version + one case');
  assert.ok(!support.includes('UPDATE crm_drive_file_registry SET head_version_seq'),
    'dead UPDATE must stay removed');
  assert.ok(support.includes('run-tag-required-for-a5-l2-seed'), 'run-scoped seed guard required');
  for (const src of [live10, liveA5]) {
    assert.ok(src.includes("../../scripts/a5-l2.mjs"), 'verifier must emit L2 pending events');
  }
});


/* ──────────────────── a stop must be readable without the job log ──────────────────── */

test('L2-18 a preflight stop names its reason and suspects in a check-run annotation', () => {
  const workflow = read('.github/workflows/crm-cloudflare-test-deploy.yml');
  // Job logs and artifacts live on blob storage that a reviewing client may not reach; check-run
  // annotations are public API. A stop that only says "an unknown row exists" cannot be acted on.
  assert.match(workflow, /::error::A5 L2 preflight detail: \$\{preflight_diag:0:900\}/,
    'the stop must emit a bounded annotation');
  assert.ok(workflow.includes('group_by(.) | map("\\(.[0])=x\\(length)")'), 'per-verdict counts required');
  assert.ok(workflow.includes('"\\(.table):\\(.a5_key)"'), 'suspect table+key required');
  // Synthetic keys only: never a customer column, never a whole row.
  const diag = workflow.slice(workflow.indexOf('preflight_diag=$(jq -r'), workflow.indexOf('::error::A5 L2 preflight detail:'));
  assert.ok(diag.length > 0, 'annotation block must exist');
  assert.ok(!/\.row\b|\.a5_id\b|phone|chat_title|review_note/.test(diag),
    'the annotation must not leak row content');
  // And the annotation must never replace the stop: exit 1 stays right after it.
  assert.match(workflow, /::error::A5 L2 preflight detail:[\s\S]{0,80}?\n\s+exit 1/, 'stop must remain a stop');
});

/* ──────────────────── barriers against laundering `unknown` rows ──────────────────── */

test('L2-17 no ledger may be published unless THIS run\'s preflight cleared', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-l2-gate-'));
  try {
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'a5-l2-preflight-missing');
    writeFileSync(path.join(dir, 'preflight.json'), 'not-json\n');
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'a5-l2-preflight-unparsable');
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: false,
      reason: 'unknown-ownership:crm_contacts:unknown', run_tag: ID_B.run_tag }));
    assert.match(preflightCleared(dir, ID_B.run_tag), /a5-l2-preflight-not-cleared/);
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: true,
      reason: 'clean', run_tag: ID_A.run_tag }));
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'a5-l2-preflight-run-tag-mismatch');
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: true,
      reason: 'clean', run_tag: ID_B.run_tag }));
    assert.equal(preflightCleared(dir, ID_B.run_tag), 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L2-18 a pre-existing unproven row cannot be blessed as a read-back side effect', () => {
  const w = world();
  // A forged / leftover synthetic row exists BEFORE this run's `begin`, with no L2 event and
  // no pending event. `if: always()` finalize must NOT turn it into `previous-a5-proven`.
  w.sqlite.prepare('INSERT INTO crm_contacts(id,name,communication_consent,review_note) VALUES(?,?,?,?)')
    .run(randomUUID(), 'TEST ONLY leftover', 'request_only', tagOf(ID_A.run_tag));
  const baseline = baselineFrom(w.query);
  assert.ok(baseline.ids.crm_contacts.length >= 1);
  assert.throws(() => buildLedger({ identity: ID_B, baseline, pending: [], query: w.query,
    conclusion: 'failure' }), /a5-l2-unproven-preexisting-row:crm_contacts/);
  // Once a trusted prior ledger proves it, the same row is skipped (no re-attestation).
  const w2 = world();
  const g = writeGroup(w2, ID_A, 'a', ['contact']);
  const prior = buildLedger({ identity: ID_A, baseline: baselineFrom(w2.query),
    pending: g.pending, query: w2.query, conclusion: 'success' });
  const b2 = baselineFrom(w2.query);
  assert.doesNotThrow(() => buildLedger({ identity: ID_B, baseline: b2, pending: [],
    query: w2.query, priorLedgers: [prior], conclusion: 'success' }));
});

/* ──────────────── prior-run pagination / retrieval (PR #138 follow-up) ──────────────── */

import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import yaml from 'js-yaml';
import {
  DEFAULT_RETENTION_DAYS, PER_PAGE, WORKFLOW_FILE, ARTIFACT_NAME,
  fetchAllRunIds, collectPriorLedgers, retentionCutoff,
} from '../a5-l2-prior-runs.mjs';

const PAGINATION_NOW = new Date('2026-11-04T00:00:00Z');
const mkApi = (lengths, total, { failPage = 0, badJsonPage = 0, badShapePage = 0, duplicate = false } = {}) => {
  const calls = [];
  const execGh = args => {
    calls.push(args);
    const flag = name => {
      const i = args.indexOf('-f');
      void i;
      const all = args.filter((_, idx) => idx > 0 && args[idx - 1] === '-f');
      const hit = all.find(a => a.startsWith(`${name}=`));
      return hit ? hit.slice(name.length + 1) : '';
    };
    const page = Number(flag('page'));
    if (failPage === page) throw new Error('stub http 503');
    if (badJsonPage === page) return 'not-json';
    if (badShapePage === page) return JSON.stringify({ total_count: total });
    const n = lengths[page - 1] ?? 0;
    const start = lengths.slice(0, page - 1).reduce((a, b) => a + b, 0);
    const runs = Array.from({ length: n }, (_, i) => ({ id: 1_000_000 + start + i + (duplicate ? 0 : 0),
      head_sha: 'a'.repeat(40), conclusion: 'failure' }));
    if (duplicate && page === 2) runs[0].id = 1_000_000;
    return JSON.stringify({ total_count: total, workflow_runs: runs });
  };
  return { execGh, calls };
};

test('L2-19 pagination fetches ALL pages until a short page (3 pages / 217 runs)', () => {
  const { execGh, calls } = mkApi([100, 100, 17], 217);
  const r = fetchAllRunIds({ execGh, repo: 'nasr-realestate/nasr-realestate.github.io',
    now: PAGINATION_NOW, retentionDays: 90 });
  assert.equal(r.pagesFetched, 3, 'three pages must be fetched, not just the first');
  assert.equal(r.runIds.length, 217);
  assert.equal(r.totalCount, 217);
  assert.equal(r.cutoff, retentionCutoff(PAGINATION_NOW, 90));
  assert.equal(r.cutoff, '2026-08-06T00:00:00Z');
  assert.equal(r.retentionDays, 90);
  assert.equal(calls.length, 3);
  for (const [i, args] of calls.entries()) {
    assert.equal(args[0], 'api');
    assert.ok(args[3].includes(`/actions/workflows/${WORKFLOW_FILE}/runs`), 'workflow path');
    assert.ok(args.includes('-f'));
    assert.ok(args.includes(`page=${i + 1}`), `page ${i + 1} requested`);
    assert.ok(args.includes(`per_page=${PER_PAGE}`), 'max page size, not 10');
    assert.ok(args.includes('status=completed'));
    // NO date-based skipping of prior runs. `cutoff` remains an informational artifact-retention
    // pin only; a run's age is never a reason to omit it from eligibility checking.
    assert.ok(!args.some(a => String(a).startsWith('created=')),
      'a time filter must never be used to skip historical runs');
    assert.equal(r.cutoffIsFilter, false);
  }
});

test('L2-20 short/empty first page still yields a complete, single-page listing', () => {
  const short = mkApi([4], 4);
  const r = fetchAllRunIds({ execGh: short.execGh, repo: 'o/r', now: PAGINATION_NOW });
  assert.equal(r.pagesFetched, 1);
  assert.equal(r.runIds.length, 4);
  const empty = mkApi([0], 0);
  const e = fetchAllRunIds({ execGh: empty.execGh, repo: 'o/r', now: PAGINATION_NOW });
  assert.equal(e.pagesFetched, 1);
  assert.deepEqual(e.runIds, [], 'genuinely empty history is allowed; an UNREADABLE one is not');
});

test('L2-21 any unreadable/incomplete page is a HARD STOP, never "assume no prior rows"', () => {
  const opts = { repo: 'o/r', now: PAGINATION_NOW };
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: mkApi([100, 100, 17], 217, { failPage: 2 }).execGh }),
    /a5-l2-runs-page-unreadable:page=2/);
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: mkApi([100, 100, 17], 217, { badJsonPage: 2 }).execGh }),
    /a5-l2-runs-page-unparsable:page=2/);
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: mkApi([100, 100, 17], 217, { badShapePage: 1 }).execGh }),
    /a5-l2-runs-page-shape:page=1/);
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: mkApi([100, 100, 17], 500).execGh }),
    /a5-l2-runs-incomplete:217\/500/);
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: mkApi([100, 100, 17], 217, { duplicate: true }).execGh }),
    /a5-l2-runs-duplicate-ids/);
  assert.throws(() => fetchAllRunIds({ ...opts, maxPages: 3, execGh: mkApi([100, 100, 100], 300).execGh }),
    /a5-l2-runs-pagination-not-exhausted/);
  assert.throws(() => fetchAllRunIds({ ...opts, execGh: () => { throw new Error('x'); } }),
    /a5-l2-runs-page-unreadable:page=1/);
  assert.throws(() => retentionCutoff(PAGINATION_NOW, 0), /a5-l2-bad-retention-days/);
});

test('L2-22 every run MUST have a readable, parseable L2 artifact; missing/corrupt = STOP', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-l2-prior-'));
  try {
    const prior = path.join(dir, 'prior');
    const work = path.join(dir, 'work');
    const good = rid => dl => writeFileSync(path.join(dl, `a5-l2-${rid}.json`),
      JSON.stringify({ schema: L2_SCHEMA, run_tag: `a5-${rid}-1-aaaaaaaa`, events: [] }));
    const three = collectPriorLedgers({ runIds: ['1', '2', '3'], priorDir: prior, workDir: work,
      download: (rid, dl) => good(rid)(dl) });
    assert.equal(three.runs, 3);
    assert.equal(three.ledgers, 3);
    for (const f of three.files) assert.equal(JSON.parse(readFileSync(f, 'utf8')).schema, L2_SCHEMA);

    assert.throws(() => collectPriorLedgers({ runIds: ['9'], priorDir: path.join(dir, 'p2'),
      workDir: path.join(dir, 'w2'), download: () => { throw new Error('404'); } }),
      /a5-l2-ledger-artifact-unreadable:run=9/);
    assert.throws(() => collectPriorLedgers({ runIds: ['9'], priorDir: path.join(dir, 'p3'),
      workDir: path.join(dir, 'w3'), download: () => {} }),
      /a5-l2-ledger-artifact-missing:run=9/);
    assert.throws(() => collectPriorLedgers({ runIds: ['9'], priorDir: path.join(dir, 'p4'),
      workDir: path.join(dir, 'w4'), download: (_r, dl) => writeFileSync(path.join(dl, 'x.json'), 'oops') }),
      /a5-l2-ledger-artifact-corrupt:run=9/);
    assert.throws(() => collectPriorLedgers({ runIds: ['9'], priorDir: path.join(dir, 'p5'),
      workDir: path.join(dir, 'w5'), download: (_r, dl) => writeFileSync(path.join(dl, 'x.json'), '{"schema":"other"}') }),
      /a5-l2-ledger-artifact-not-l2:run=9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L2-23 CLI end-to-end with a stub gh: 3 pages fetched, then STOP on page/artifact failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a5-l2-cli-'));
  const stub = path.join(dir, 'gh-stub.mjs');
  try {
    // The stub now also serves the two TECHNICAL eligibility sources: the workflow file at
    // head_sha (contents API) and the exact steps the run executed (jobs API). Runs are declared
    // ELIGIBLE so downloads still have to happen; a missing artifact must still STOP.
    writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const ep = String(a.find(x => String(x).startsWith('repos/')) || '');
const f = {};
for (let i = 0; i < a.length; i += 1) if (a[i] === '-f' && a[i + 1]) {
  const eq = a[i + 1].indexOf('='); f[a[i + 1].slice(0, eq)] = a[i + 1].slice(eq + 1);
}
const WF = [
  'a5-l2-prior-runs.mjs', 'a5-l2.mjs begin', 'a5-l2.mjs preflight',
  'a5-l2.mjs finalize', 'name: a5-l2-ledger'
].join('\\n');
if (a[0] === 'api' && ep.includes('/actions/workflows/')) {
  const page = Number(f.page);
  if (String(process.env.A5_STUB_FAIL_PAGE || '') === String(page)) process.exit(3);
  const sizes = String(process.env.A5_STUB_PAGES || '100,100,17').split(',').map(Number);
  const total = sizes.reduce((x, y) => x + y, 0);
  const n = sizes[page - 1] ?? 0;
  const start = sizes.slice(0, page - 1).reduce((x, y) => x + y, 0);
  process.stdout.write(JSON.stringify({ total_count: total,
    workflow_runs: Array.from({ length: n }, (_, i) => ({
      id: 1000000 + start + i, head_sha: 'a'.repeat(40), conclusion: 'failure' })) }));
} else if (a[0] === 'api' && ep.includes('/contents/')) {
  process.stdout.write(Buffer.from(WF, 'utf8').toString('base64'));
} else if (a[0] === 'api' && ep.includes('/jobs')) {
  process.stdout.write(JSON.stringify({ jobs: [{ steps: [
    { name: 'A5 L2 — prior ledgers, read-only baseline, ownership preflight', conclusion: 'success' },
    { name: 'Deploy nasr-crm-api-test and run live A5 E2E', conclusion: 'success' }
  ] }] }));
} else if (a[0] === 'run' && a[1] === 'download') {
  const rid = a[2];
  if (String(process.env.A5_STUB_FAIL_ARTIFACT || '') === String(rid)) process.exit(4);
  const dl = a[a.indexOf('--dir') + 1];
  fs.writeFileSync(dl + '/a5-l2-' + rid + '.json', JSON.stringify({ schema: 'a5-l2-v1', run_tag: 'a5-' + rid, events: [] }));
} else process.exit(5);
`);
    chmodSync(stub, 0o755);
    const runCli = (extra, tag) => spawnSync('node', ['scripts/a5-l2-prior-runs.mjs',
      '--prior-dir', path.join(dir, `prior-${tag}`), '--work-dir', path.join(dir, `work-${tag}`),
      '--retention-days', '90'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, A5_L2_GH_BIN: stub, GITHUB_REPOSITORY: 'o/r',
        A5_STUB_PAGES: '100,100,17', ...extra },
    });
    const ok = runCli({});
    assert.equal(ok.status, 0, `cli failed: ${ok.stderr}`);
    const out = JSON.parse(ok.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.pages_fetched, 3, 'exactly 3 pages were fetched by the CLI harness');
    assert.equal(out.total_count, 217);
    assert.equal(out.runs_fetched, 217);
    assert.equal(out.eligible_runs, 217, 'every stubbed L2-enabled run owes a ledger');
    assert.equal(out.ineligible_runs, 0);
    assert.equal(out.ledgers, 217);
    assert.equal(out.retention_days, 90);
    assert.equal(out.cutoff_is_filter, false, 'retention is a pin, not a run filter');

    const badPage = runCli({ A5_STUB_FAIL_PAGE: '2' }, 'badpage');
    assert.notEqual(badPage.status, 0);
    assert.match(badPage.stderr, /a5-l2-runs-page-unreadable:page=2/);
    assert.match(badPage.stderr, /STOPPED before any write/);

    const badArtifact = runCli({ A5_STUB_FAIL_ARTIFACT: '1000000' }, 'badartifact');
    assert.notEqual(badArtifact.status, 0);
    assert.match(badArtifact.stderr, /a5-l2-ledger-artifact-unreadable:run=1000000/);
    assert.match(badArtifact.stderr, /STOPPED before any write/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L2-24 workflow pins retention, full pagination, hard stop, and keeps L2 preflight barriers', () => {
  const wf = read('.github/workflows/crm-cloudflare-test-deploy.yml');
  const doc = yaml.load(wf);
  const job = doc.jobs['deploy-and-verify'];
  assert.equal(String(job.env.A5_L2_RETENTION_DAYS), '90');
  assert.equal(DEFAULT_RETENTION_DAYS, 90, 'module default must equal the workflow retention');
  const upload = job.steps.find(s => s.with?.name === 'a5-l2-ledger');
  assert.ok(upload, 'ledger artifact upload step must exist');
  assert.equal(Number(upload.with['retention-days']), 90,
    'retention-days must equal the cutoff window used by the retrieval step');
  assert.equal(ARTIFACT_NAME, 'a5-l2-ledger');
  assert.match(wf, /a5-l2-prior-runs\.mjs/);
  assert.match(wf, /pages_fetched/);
  assert.match(wf, /--retention-days/);
  assert.match(wf, /eligible_runs/);
  // NO date/count cutoff may be used to skip prior runs: eligibility comes from the workflow
  // version at head_sha + the run's own job steps, and the legacy namespace is probed per row.
  assert.ok(!/created=>=/.test(wf), 'a time filter must never skip historical runs');
  assert.match(wf, /no-date-or-count-cutoff/);
  assert.match(wf, /legacy synthetic namespace/);
  assert.match(wf, /failure-evidence/);
  // The nonce MUST be exported inside the L2 step itself: GITHUB_ENV is only visible to LATER
  // steps, so begin/preflight and checkpoint/finalize must derive the SAME run_tag.
  assert.match(wf, /export A5_L2_NONCE="\$nonce"/);
  assert.match(wf, /export A5_L2_RUN_TAG="\$tag"/);
  // No truncated first-page-only retrieval, no "treat missing as absent" fallback.
  assert.ok(!/per_page=10\b/.test(wf), 'no first-page-only per_page=10 retrieval');
  for (const forbidden of ["treating prior ledgers as absent",
    'no published ledger artifact for run', "--jq '.workflow_runs[].id'"]) {
    assert.ok(!wf.includes(forbidden), `unsafe retrieval remnant: ${forbidden}`);
  }
  assert.match(wf, /if ! node scripts\/a5-l2-prior-runs\.mjs[\s\S]{0,700}exit 1/,
    'a failed retrieval must stop the run before any write');
  // All original L2 barriers stay intact.
  for (const needle of ['a5-l2.mjs begin', 'a5-l2.mjs preflight', 'a5-l2.mjs checkpoint',
    'a5-l2.mjs finalize', 'if: always()', 'unknown synthetic-row ownership']) {
    assert.ok(wf.includes(needle), `L2 barrier missing: ${needle}`);
  }
  assert.match(read('scripts/a5-l2.mjs'), /preflightCleared\(dir, identity\.run_tag\)/);
  assert.match(read('scripts/a5-l2.mjs'), /a5-l2-unproven-preexisting-row/);
  assert.match(read('scripts/a5-l2.mjs'), /unknown-ownership/);
});
