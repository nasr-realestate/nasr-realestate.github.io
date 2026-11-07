#!/usr/bin/env node
/**
 * A5 L2 — orphan cleanup (test DB only, counted, dry-run by default).
 *
 * WHY (2026-11-07)
 * ----------------
 * The deploy gate refuses to start while a row in the synthetic namespace has no
 * ownership evidence: `unknown-ownership:<table>:...`. Some of those rows are leftovers of
 * runs that created them and died before publishing a ledger — they exist, nothing claims
 * them, and nothing ever will. A row that exists cannot be "attested as deleted": the book
 * in `scripts/a5-l2-deletions.mjs` records deletions, not absences.
 *
 * So the honest repair is removal, done the way every write in this repo is done:
 *   * SCOPE IS IMPORTED, NOT RESTATED. The rows deleted here are exactly the ones the gate
 *     itself calls `unknown` — enumerated by `enumerateRows()` from `a5-l2.mjs`, minus every
 *     row an event claims, minus every baseline row, minus the documented legacy namespace
 *     (which has its own tool, `legacy-synthetic-cleanup.mjs`). There is no second predicate
 *     that could drift away from the gate.
 *   * DRY-RUN IS THE DEFAULT. With `mode=dry-run` this only counts and names tables; no
 *     DELETE is built at all. `--apply` additionally needs `CRM_ORPHAN_APPLY=1`.
 *   * EVERY DELETE NAMES ONE ROW, BY ITS PRIMARY KEY. No `DELETE FROM t`, no range, no `LIKE`.
 *   * COUNTED ON BOTH SIDES: rows before, `meta.changes` per delete, rows after. The run FAILS
 *     if any planned row survives.
 *   * SAFETY CEILING: more than 20 orphans aborts BEFORE any write. That is no longer leftover
 *     residue; it is a database state a person must look at first.
 *   * TEST DB ONLY: `assertTestOnlyConfig()` runs before the first statement and refuses
 *     `nasr-market-db` and any non-test uuid. The production database is never a target.
 */
import { existsSync } from 'node:fs';
import { assertTestOnlyConfig, d1Query } from '../a5-live-support.mjs';
import {
  enumerateLegacySuspects, enumerateRows, loadLedgers, readonlyQuery,
} from '../a5-l2.mjs';

export const MAX_ORPHANS = 20;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const SAFE_TABLE = /^[a-z_]+$/;

export const safeId = (value) => {
  const text = String(value ?? '');
  if (!SAFE_ID.test(text)) throw new Error('orphan-unsafe-id');
  return text;
};

/**
 * Pure planning step: which rows does the gate call `unknown`, given the ledgers and the
 * current database? Returns the delete plan without touching anything.
 */
/** Every key a trusted ledger already accounts for — by ledger key or by observed row id. */
function claimedKeys(ledgers) {
  const eventKeys = new Set();
  const baselineKeys = new Set();
  for (const { ledger } of ledgers.filter((x) => x.error === 'ok')) {
    for (const e of ledger.events || []) {
      eventKeys.add(`${e.table}|${e.unique_key}`);
      if (e.observed_id) eventKeys.add(`${e.table}|observed:${e.observed_id}`);
    }
    for (const [table, keys] of Object.entries(ledger.baseline?.ids || {})) {
      for (const key of keys) baselineKeys.add(`${table}|${key}`);
    }
  }
  return { eventKeys, baselineKeys };
}

/** True when nothing in the evidence accounts for this row under either of its two names. */
function isUnclaimed(entry, { eventKeys, baselineKeys }) {
  const { table, a5_key: key, a5_id: id } = entry;
  if (eventKeys.has(`${table}|${key}`) || eventKeys.has(`${table}|observed:${id}`)) return false;
  if (baselineKeys.has(`${table}|${key}`) || baselineKeys.has(`${table}|${id}`)) return false;
  return true;
}

/**
 * Pure planning step: which rows does the gate call `unknown`, given the ledgers and the
 * current database? Returns the delete plan without touching anything.
 */
export function planOrphans({ rows, ledgers, legacy }) {
  const claimed = claimedKeys(ledgers);
  const legacyKeys = new Set((legacy || []).map((s) => `${s.table}|${s.a5_key}`));
  return rows
    .filter((entry) => isUnclaimed(entry, claimed) && !legacyKeys.has(`${entry.table}|${entry.a5_key}`))
    .map(({ table, spec, a5_key: key, a5_id: id }) => ({ table, id, key, id_column: spec.idColumn }));
}

/** Group the plan by table so a reviewer sees "what" before "how many". */
export function planByTable(plan) {
  const counts = new Map();
  for (const row of plan) counts.set(row.table, (counts.get(row.table) || 0) + 1);
  return [...counts.entries()].map(([table, rows]) => ({ table, rows })).sort((a, b) => a.table.localeCompare(b.table));
}

export function deleteStatement({ table, id, id_column: idColumn }) {
  if (!SAFE_TABLE.test(String(table)) || !SAFE_TABLE.test(String(idColumn))) throw new Error('orphan-unsafe-table');
  return `DELETE FROM ${table} WHERE ${idColumn} = '${safeId(id)}'`;
}

export function census(query) {
  const rows = enumerateRows(query);
  const ledgers = loadLedgers(process.env.A5_L2_PRIOR_DIR || '', '');
  const legacy = enumerateLegacySuspects(query);
  return { rows: rows.length, legacy: legacy.length, plan: planOrphans({ rows, ledgers, legacy }) };
}

function main() {
  const apply = process.argv.includes('--apply');
  const env = process.env;
  assertTestOnlyConfig(env);
  if (apply && env.CRM_ORPHAN_APPLY !== '1') throw new Error('orphan-apply-not-authorised');

  const read = (sql) => readonlyQuery(sql, env);
  if (!existsSync(env.A5_L2_PRIOR_DIR || '')) throw new Error('orphan-prior-ledgers-missing');

  const before = census(read);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    before_total: before.plan.length,
    namespace_rows: before.rows,
    legacy_suspects: before.legacy,
    tables: planByTable(before.plan),
    deleted: [],
    after_total: null,
    errors: [],
  };
  if (before.plan.length > MAX_ORPHANS) {
    summary.errors.push(`orphans=${before.plan.length} exceeds ceiling ${MAX_ORPHANS}; nothing deleted`);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  for (const row of before.plan) {
    try {
      const out = d1Query(deleteStatement(row), env);
      const changes = Number(out?.[0]?.meta?.changes ?? 0);
      summary.deleted.push({ table: row.table, changes });
    } catch (error) {
      summary.errors.push(`${row.table}: ${String(error?.message || error).slice(0, 120)}`);
    }
  }
  const after = census(read);
  summary.after_total = after.plan.length;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.after_total !== 0 || summary.errors.length) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('a5-orphan-cleanup.mjs')) {
  try { main(); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ errors: [String(error?.message || error).slice(0, 160)] })}\n`);
    process.exitCode = 1;
  }
}
