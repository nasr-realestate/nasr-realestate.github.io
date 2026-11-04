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
    '.c == 60 and .ph == 64 and .o == 83 and .cl == 19 and .cv == 76 and .unm == 21 and .m == 2984 and .al >= 66',
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
  // The live10 dashboard invariant is deliberately UNCHANGED (see CRM_A5_L2_RESULT_LEDGER.md §7.1).
  assert.match(live10, /counts\?\.unmatched_review_chats \?\? 0\), 21, 'dash-unm-21'/);
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
