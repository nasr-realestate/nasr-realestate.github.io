#!/usr/bin/env node
/**
 * READ-ONLY diagnosis of an A5 L2 stop — answers "which row stopped the deploy?" without
 * deploying anything, writing anything, deleting anything, or weakening the gate.
 *
 * Why it exists (2026-11-07): the deploy gate stops with reasons like
 *   `l2-row-vanished:crm_drive_file_registry` / `unknown-ownership:<table>:...`
 * and the detail that says WHICH row lives in the job log, which is served from blob storage a
 * reviewing client may not be able to reach. The deploy workflow solves this by emitting a
 * check-run annotation; this script makes that annotation complete down to the exact key, and
 * does it as a separate, dispatch-only, read-only run so that diagnosis never costs a deploy slot.
 *
 * Guarantees, in the same spirit as `a5-l2.mjs`:
 *   * every statement goes through `readonlyQuery` (single SELECT, forbidden verbs refused);
 *   * the target DB is asserted to be the test DB by `assertTestOnlyConfig` before a single read;
 *   * no ledger is written, no artifact is produced, no row is touched, nothing is claimed;
 *   * output carries table names, key prefixes and run tags — synthetic identifiers only.
 */
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  enumerateLegacySuspects, enumerateRows, loadLedgers, readonlyQuery,
} from './a5-l2.mjs';
import { attestationIndex, loadDeletions } from './a5-l2-deletions.mjs';

const ROOT_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');

const KEY_PREFIX = 24;

const opt = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const brief = (value, max = KEY_PREFIX) => String(value ?? '').slice(0, max);

/** The first finding names the verdict: the gate stops on the first class it meets, and so do we. */
function verdictOf({ vanished, unknown, legacy }) {
  if (vanished.length) return 'row-vanished';
  if (unknown.length) return 'unknown-row';
  if (legacy.length) return 'legacy-row';
  return 'clean';
}

/** Keys the database currently holds, by both the ledger key and the observed row id. */
function indexPresent(rows) {
  const present = new Set();
  for (const { table, a5_key, a5_id } of rows) {
    present.add(`${table}|${a5_key}`);
    present.add(`${table}|observed:${a5_id}`);
  }
  return present;
}

/** Everything the prior ledgers claim: proven keys, plus the baseline rows they inherited. */
function indexEvidence(loaded) {
  const eventKeys = new Set();
  const baselineKeys = new Set();
  for (const { ledger } of loaded) {
    for (const e of ledger.events || []) eventKeys.add(`${e.table}|${e.unique_key}`);
    for (const [table, keys] of Object.entries(ledger.baseline?.ids || {})) {
      for (const key of keys) baselineKeys.add(`${table}|${key}`);
    }
  }
  return { eventKeys, baselineKeys };
}

/**
 * A proven row that is no longer there. A gap the book attests is reported separately: it is a
 * documented deletion, not a mystery, and mixing the two is how a real one gets lost in a list.
 */
function findVanished(loaded, present, attested) {
  const out = [];
  const seen = new Set();
  for (const { ledger } of loaded) {
    for (const e of ledger.events || []) {
      const k = `${e.table}|${e.unique_key}`;
      if (present.has(k) || present.has(`${e.table}|observed:${e.observed_id}`) || seen.has(k)) continue;
      seen.add(k);
      const obituary = attested.get(k);
      const record = {
        table: e.table, key: brief(e.unique_key), run_tag: brief(e.run_tag, 40),
        step: brief(e.step, 40), id_source: brief(e.id_source, 40),
      };
      if (obituary) {
        record.attested_by = brief(obituary.deleted_by, 40);
        record.attested_at = brief(obituary.deleted_at, 24);
      }
      out.push(record);
    }
  }
  return out;
}

/** A row that is here with nothing to vouch for it. */
function findUnknown(rows, { eventKeys, baselineKeys }) {
  const out = [];
  for (const { table, a5_key, a5_id } of rows) {
    if (eventKeys.has(`${table}|${a5_key}`) || eventKeys.has(`${table}|observed:${a5_id}`)) continue;
    if (baselineKeys.has(`${table}|${a5_key}`) || baselineKeys.has(`${table}|${a5_id}`)) continue;
    out.push({ table, key: brief(a5_key) });
  }
  return out;
}

/**
 * Pure core: given a read-only query and the prior ledgers, say exactly what is wrong.
 * Returns lists, never throws for a row-level finding — a diagnosis that dies on the first
 * surprise is how people end up guessing.
 */
export function diagnose({ query, ledgers, deletions = [] }) {
  const loaded = ledgers.filter((x) => x.error === 'ok');
  const untrusted = ledgers.filter((x) => x.error !== 'ok').map((x) => ({ name: x.name, error: x.error }));
  const rows = enumerateRows(query);
  const gaps = findVanished(loaded, indexPresent(rows), attestationIndex(deletions));
  const found = {
    attested: gaps.filter((g) => g.attested_at),
    vanished: gaps.filter((g) => !g.attested_at),
    unknown: findUnknown(rows, indexEvidence(loaded)),
    legacy: enumerateLegacySuspects(query).map((s) => ({ table: s.table, key: brief(s.a5_key), label: brief(s.label, 40) })),
  };
  return {
    verdict: verdictOf(found), attested_count: found.attested.length,
    ledgers: loaded.length, untrusted, rows: rows.length,
    ...found,
  };
}

/**
 * GitHub shows at most ten annotations per step, and a wall of text is not a diagnosis.
 * One summary line, then the most specific findings, capped — the rest stays in stdout.
 */
export function annotationLines(result, cap = { vanished: 4, unknown: 3, legacy: 2 }) {
  const lines = [
    `::error::A5 L2 DIAG verdict=${result.verdict} vanished=${result.vanished.length} `
    + `attested=${(result.attested || []).length} unknown=${result.unknown.length} legacy=${result.legacy.length} `
    + `ledgers=${result.ledgers} untrusted=${result.untrusted.length} rows=${result.rows}`,
  ];
  for (const a of (result.attested || []).slice(0, cap.attested ?? 2)) {
    lines.push(`::notice::A5 L2 DIAG attested table=${a.table} key=${a.key} by=${a.attested_by} at=${a.attested_at}`);
  }
  for (const v of result.vanished.slice(0, cap.vanished)) {
    lines.push(`::error::A5 L2 DIAG vanished table=${v.table} key=${v.key} run=${v.run_tag} step=${v.step}`);
  }
  for (const u of result.unknown.slice(0, cap.unknown)) {
    lines.push(`::error::A5 L2 DIAG unknown table=${u.table} key=${u.key}`);
  }
  for (const l of result.legacy.slice(0, cap.legacy)) {
    lines.push(`::warning::A5 L2 DIAG legacy table=${l.table} key=${l.key} label=${l.label}`);
  }
  if (result.untrusted.length) {
    lines.push(`::error::A5 L2 DIAG untrusted-ledger ${result.untrusted[0].name}:${result.untrusted[0].error}`);
  }
  return lines;
}

function main() {
  const ledgersDir = resolve(opt('ledgers') || process.env.A5_L2_PRIOR_DIR || '');
  if (!ledgersDir) throw new Error('a5-l2-diagnose-ledgers-dir-required');
  const ledgers = loadLedgers(ledgersDir, '');
  const bookFile = opt('deletions') || process.env.A5_L2_DELETIONS_FILE
    || join(ROOT_DIR, 'scripts', 'a5-l2-deletions.json');
  const book = loadDeletions(bookFile);
  if (!book.ok) {
    process.stdout.write(`::error::A5 L2 DIAG deletion book is not readable: ${book.errors.slice(0, 3).join(',') || 'invalid'}\n`);
    process.exitCode = 1;
    return;
  }
  const result = diagnose({ query: (sql) => readonlyQuery(sql, process.env), ledgers, deletions: book.entries });
  result.deletions_book = brief(bookFile.replace(`${ROOT_DIR}/`, ''), 60);
  for (const line of annotationLines(result)) process.stdout.write(`${line}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stdout.write(`::error::A5 L2 DIAG stopped: ${String(error?.message || error).slice(0, 160)}\n`);
    process.exitCode = 1;
  }
}
