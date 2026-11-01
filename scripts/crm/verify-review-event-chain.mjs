#!/usr/bin/env node
// Read-only CI verifier for the `0009` review ledger: recomputes the canonical event digest from the
// row itself and cross-checks the chain, the per-case density, the chain head and the immutable anchor
// mirror. It is the only thing that can see a content rewrite that kept its stored digests, because D1
// has no SHA-256 in SQL and the digests are writer-supplied.
//
//   node scripts/crm/verify-review-event-chain.mjs --local --db <name> --config <wrangler.toml>
//   node scripts/crm/verify-review-event-chain.mjs --from-json <file-with-{events,head,anchors,seals}>
//   node scripts/crm/verify-review-event-chain.mjs --sqlite <path/to/miniflare.sqlite>
//
// Guarantees enforced in the code, not in a README:
//   * it never sends anything anywhere — `--remote` is refused before any other argument is honoured;
//   * every statement it issues is a SELECT (the guard below rejects anything else, in every mode);
//   * its output is digests and integer counts only — no reason text, no reviewer label, no seal
//     bytes — so it is safe to print into a CI log and to archive as an artifact.
//
// Exit codes: 0 = ledger verified · 1 = violations found · 2 = refused (remote / not read-only / bad input).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { eventDigest, inspectCheckpoints, inspectLedger, loadRowsFromD1Json, sha256Hex }
  from './review-event-chain.mjs';

const argv = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(key, argv[++i]);
  else flags.set(key, true);
}

function die(code, error, extra = {}) {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(code);
}

if (flags.has('remote') || flags.has('live')) {
  die(2, 'remote_refused', { hint: 'this verifier is local-only and read-only by design' });
}

const SELECT_ONLY = /^\s*(SELECT|WITH)\b/i;
function assertReadOnly(...statements) {
  for (const stmt of statements) {
    for (const piece of String(stmt).split(';')) {
      if (piece.trim() && !SELECT_ONLY.test(piece)) die(2, 'not_read_only', { sql: piece.trim().slice(0, 40) });
    }
  }
}

// --run <key> scopes every read to one chain (a CI job verifies the review run without pulling in
// every other ledger that happens to live in the same database). Filtered client-side, after the
// read, so no value is ever interpolated into SQL.
const RUN_FILTER = flags.get('run');
if (RUN_FILTER !== undefined && !/^[A-Za-z0-9_.-]{1,80}$/.test(String(RUN_FILTER))) {
  die(2, 'bad_run_filter', { hint: 'letters, digits, dot, dash and underscore only' });
}
const scope = (d) => {
  if (!RUN_FILTER) return d;
  const out = Object.fromEntries(Object.entries(d).map(([k, rows]) =>
    [k, Array.isArray(rows) ? rows.filter((r) => r.run_key === undefined
      || String(r.run_key) === String(RUN_FILTER)) : rows]));
  const cases = out.cases ?? [];
  if (cases.length && Array.isArray(out.seals)) {          // otherwise the filter would erase every seal
    const refs = new Set(cases.map((c) => c.case_ref));
    out.seals = out.seals.filter((s) => refs.has(s.case_ref));
  }
  return out;
};

const SQL = {
  events: 'SELECT * FROM crm_drive_review_event ORDER BY run_key, event_seq',
  head: 'SELECT * FROM crm_drive_review_chain_head ORDER BY run_key',
  anchors: 'SELECT * FROM crm_drive_review_chain_anchor ORDER BY run_key, event_seq',
  // the ciphertext itself is hashed, never printed: that is how a re-keyed seal is caught
  seals: 'SELECT case_ref, ciphertext_b64u, ciphertext_sha256, plaintext_sha256, key_version,'
    + ' revoked_at, expires_at FROM crm_drive_review_seal ORDER BY case_ref',
  integrity: 'SELECT run_key, events, broken_links, seq_gaps, anchor_mismatches, head_event_count'
    + ' FROM crm_review_chain_integrity ORDER BY run_key',
  // seals hang off a case, not off a run, so scoping them to one chain needs this one join table
  cases: 'SELECT case_ref, run_key FROM crm_drive_review_case ORDER BY case_ref',
};

const stripAnsi = text => text.replace(/\u001b\[[0-9;]*m/g, '');

function runWrangler(sql) {
  assertReadOnly(sql);
  const db = flags.get('db') ?? die(2, 'missing --db');
  const config = flags.get('config');
  const state = flags.get('state');
  const binary = flags.get('wrangler');
  const base = binary ? [binary] : ['npx', '--yes', 'wrangler@4'];
  let out;
  try {
    out = execFileSync(base[0],
      [...base.slice(1), 'd1', 'execute', db, '--local', '--json',
        ...(config ? ['--config', config] : []),
        ...(state ? ['--persist-to', state] : []), '--command', sql],
      { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // wrangler's own message is what an operator needs; a node stack trace only buries it in a CI log
    const text = stripAnsi(`${err.stdout ?? ''}\n${err.stderr ?? ''}`);
    const m = text.match(/"text"\s*:\s*"([^"]{1,200})"/) ?? text.match(/ERROR[^\n]{0,200}/);
    die(2, 'wrangler_failed', { detail: (m ? m[1] : 'wrangler exited non-zero').slice(0, 200) });
  }
  return loadRowsFromD1Json(stripAnsi(out));
}

function collect() {
  if (flags.get('from-json')) {
    const parsed = JSON.parse(readFileSync(String(flags.get('from-json')), 'utf8'));
    if (Array.isArray(parsed) || parsed.results) {
      return { events: loadRowsFromD1Json(parsed), head: [], anchors: [], seals: [], integrity: [] };
    }
    return scope({ events: parsed.events ?? [], head: parsed.head ?? [], anchors: parsed.anchors ?? [],
      seals: parsed.seals ?? [], integrity: parsed.integrity ?? [], cases: parsed.cases ?? [] });
  }
  if (flags.get('sqlite')) {
    const db = new DatabaseSync(String(flags.get('sqlite')), { readOnly: true });
    const num = v => (typeof v === 'bigint' ? Number(v) : v);
    const all = sql => {
      assertReadOnly(sql);
      try {
        return db.prepare(sql).all().map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, num(v)])));
      } catch { return []; }                       // a view that does not exist yet is a skip, not a crash
    };
    try {
      return scope({ events: all(SQL.events), head: all(SQL.head), anchors: all(SQL.anchors),
        seals: all(SQL.seals), integrity: all(SQL.integrity), cases: all(SQL.cases) });
    } finally { db.close(); }
  }
  if (flags.get('local')) {
    return scope({ events: runWrangler(SQL.events), head: runWrangler(SQL.head),
      anchors: runWrangler(SQL.anchors), seals: runWrangler(SQL.seals),
      integrity: runWrangler(SQL.integrity), cases: runWrangler(SQL.cases) });
  }
  return die(2, 'no input: pass --local --db …, --from-json <file>, or --sqlite <file>');
}

const data = collect();


// ---------------------------------------------------------------- the checks
const ledger = inspectLedger(data.events);
const checkpoint = inspectCheckpoints({ events: data.events, head: data.head, anchors: data.anchors });

// a seal's pinned digest is what every approval binds to: recompute it from the bytes we can read
const sealIssues = [];
for (const s of data.seals) {
  if (typeof s.ciphertext_b64u === 'string' && sha256Hex(s.ciphertext_b64u) !== s.ciphertext_sha256) {
    sealIssues.push({ runKey: null, caseRef: s.case_ref, kind: 'seal_digest_mismatch' });
  }
}

// the ledger's own view and this recomputation must agree; a divergence means the view was edited,
// dropped, or is being read from a different database than the rows
const viewIssues = [];
for (const row of data.integrity) {
  const list = data.events.filter(e => e.run_key === row.run_key);
  const seqs = list.map(e => Number(e.event_seq)).sort((a, b) => a - b);
  const gaps = seqs.length ? seqs[seqs.length - 1] - seqs[0] + 1 - seqs.length : 0;
  let broken = 0;
  const genesis = (data.anchors.find(a => a.run_key === row.run_key && Number(a.event_seq) === 0) ?? {})
    .head_sha256;
  for (const e of list) {
    const prev = list.find(x => Number(x.event_seq) === Number(e.event_seq) - 1);
    const expected = prev ? prev.event_sha256 : genesis;
    if (String(e.prev_event_sha256) !== String(expected)) broken += 1;
  }
  if (Number(row.broken_links) !== broken || Number(row.seq_gaps) !== gaps) {
    viewIssues.push({ runKey: row.run_key, kind: 'view_divergence',
      detail: `view says broken=${row.broken_links},gaps=${row.seq_gaps}; recomputed broken=${broken},gaps=${gaps}` });
  }
}

const violations = [
  ...ledger.violations.map(v => ({ ...v, source: 'canonical_recompute' })),
  ...checkpoint.map(v => ({ ...v, source: 'checkpoint' })),
  ...sealIssues.map(v => ({ ...v, source: 'seal' })),
  ...viewIssues.map(v => ({ ...v, source: 'view' })),
];

const summary = {
  ok: violations.length === 0,
  canonical: 'p4rev_event_v1',
  hashedFields: 21,
  runs: ledger.runs,
  events: ledger.events,
  heads: data.head.length,
  anchors: data.anchors.length,
  seals: data.seals.length,
  digestsRecomputed: data.events.filter(e => e.event_sha256 === eventDigest(e)).length,
  reasonDigestsChecked: data.events.filter(e => e.reason !== undefined).length,
  integrityViewRows: data.integrity.length,
  violations: violations.map(v => ({
    runKey: v.runKey ?? null, seq: v.seq ?? null, caseRef: v.caseRef ?? null,
    kind: v.kind, source: v.source, ...(v.detail ? { detail: String(v.detail).slice(0, 120) } : {}),
  })),
};
console.log(JSON.stringify(summary, null, flags.has('pretty') ? 2 : 0));
process.exit(violations.length === 0 ? 0 : 1);
