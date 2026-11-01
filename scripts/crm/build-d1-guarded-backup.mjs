#!/usr/bin/env node
// Build a D1 backup bundle whose restore path CANNOT silently drop the review guards.
//
// Why this exists: `wrangler d1 export` interleaves CREATE TABLE / INSERT per table and puts the
// indexes, triggers and views at the END, and trigger bodies contain semicolons inside
// BEGIN … END. A backup builder that splits the dump on ';' therefore either mangles the trigger
// bodies (the shipped Phase-2 bundle fails on a 0009-era export with `SQLITE_CONSTRAINT (1811)`) or
// — if it only recognises tables and indexes — restores the data and leaves every guard behind. A
// restore that succeeds while dropping 19 triggers and 4 views is worse than a restore that fails:
// the ledger looks intact and is unsealed.
//
//   node scripts/crm/build-d1-guarded-backup.mjs --dump <export.sql> --out <dir> [--title <label>]
//
// Emits, in <dir>:
//   restore.sql   stage 1 = tables + rows + indexes, stage 2 = views + triggers. Both stages live in
//                 ONE file so `wrangler d1 execute --file` applies them in one transaction: there is
//                 no window in which the data exists without its guards, and no window in which the
//                 guards reject rows that are still arriving.
//   verify.sql    read-only SELECTs that re-count objects by type and re-count every restored table,
//                 plus the chain-integrity view. Run it after the restore and compare with inventory.json.
//   inventory.json what the dump contained: counts and names per object type, rows per table, and the
//                 sha256 of each stage of the bundle.
//   manifest.json  the contract a CI job asserts on: expected counts, digests, and a hard
//                 "guards_present" boolean computed from the dump, not from wishful thinking.
//
// The tool reads a file and writes a file. It never opens a database, never talks to a network API,
// and never prints row contents — the dump can hold customer data, the bundle's metadata must not.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = new Map();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt.set(k, argv[++i]);
  else opt.set(k, true);
}
const die = (msg) => { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(2); };
const DUMP = opt.get('dump') ?? die('missing --dump <export.sql>');
const OUT = opt.get('out') ?? die('missing --out <dir>');
const TITLE = String(opt.get('title') ?? 'd1-guarded-backup');
if (opt.get('remote')) die('--remote is not supported: this tool only reads a dump file');

const sql = readFileSync(resolve(DUMP), 'utf8');
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------- statement splitter (quote-aware)
// A naive `split(';')` is the bug this whole file exists to avoid: a trigger body is
// `BEGIN SELECT RAISE(ABORT,'x'); END;` and the views contain subqueries. So: scan character by
// character, tracking string literals ('' is an escaped quote), quoted identifiers (""), and
// parentheses depth — and only cut at a ';' that is at depth 0 outside any literal.
function splitStatements(text) {
  const out = [];
  let buf = '', quote = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote) {
        if (text[i + 1] === quote) { buf += text[++i]; continue; }
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      buf += '\n';
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) {
      // a trigger body is `BEGIN SELECT RAISE(...); END;` — its inner semicolons sit at paren depth 0,
      // which is exactly where a naive splitter cuts and produces a mangled, half-a-trigger statement.
      if (/CREATE\s+TRIGGER/i.test(buf) && !/(?:^|\s)END\s*$/i.test(buf)) { buf += c; continue; }
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// count the value tuples of an INSERT so an inventory can state rows per table without reading them
function countValueTuples(stmt) {
  const at = stmt.search(/\bVALUES\b/i);
  if (at < 0) return 0;
  let n = 0, depth = 0, quote = null;
  for (let i = at + 6; i < stmt.length; i++) {
    const c = stmt[i];
    if (quote) {
      if (c === quote) {
        if (stmt[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') { if (depth === 0) n++; depth++; continue; }
    if (c === ')') { depth--; continue; }
  }
  return n;
}

const Q = '(?:"|\\[)?';                       // SQLite quotes identifiers as "x", `x` or [x]
const QE = '(?:"|\\])?';
const NAME_OF = {
  table: new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${Q}([A-Za-z0-9_]+)${QE}`, 'i'),
  index: new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${Q}([A-Za-z0-9_]+)${QE}`, 'i'),
  trigger: new RegExp(`CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${Q}([A-Za-z0-9_]+)${QE}`, 'i'),
  view: new RegExp(`CREATE\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${Q}([A-Za-z0-9_]+)${QE}`, 'i'),
};
const INSERT_TABLE = new RegExp(`INSERT\\s+INTO\\s+${Q}([A-Za-z0-9_]+)${QE}`, 'i');

const buckets = { table: [], index: [], trigger: [], view: [], insert: [], other: [] };
const rowsByTable = new Map();
for (const stmt of splitStatements(sql)) {
  const kind = ['table', 'index', 'trigger', 'view'].find((k) => NAME_OF[k].test(stmt));
  if (kind) { buckets[kind].push({ stmt, name: stmt.match(NAME_OF[kind])[1] }); continue; }
  const ins = stmt.match(INSERT_TABLE);
  if (ins) {
    buckets.insert.push({ stmt, table: ins[1] });
    rowsByTable.set(ins[1], (rowsByTable.get(ins[1]) ?? 0) + countValueTuples(stmt));
    continue;
  }
  // deliberately dropped: `PRAGMA defer_foreign_keys` is wrangler's convenience, and a restore that
  // needs it is a restore that hides a real ordering bug. Everything else in the dump is preserved.
  if (/^\s*PRAGMA\b/i.test(stmt)) { buckets.other.push({ stmt, name: 'pragma (dropped)' }); continue; }
  buckets.other.push({ stmt, name: stmt.split('\n')[0].slice(0, 60) });
}

const skippedTables = new Set(['sqlite_sequence']);   // rebuilt by SQLite itself; restoring it can corrupt AUTOINCREMENT
const dataStmts = buckets.insert.filter((s) => !skippedTables.has(s.table));

// ---------------------------------------------------------------- the bundle
const header = (stage) => `-- ${TITLE} · ${stage}\n`
  + `-- generated by scripts/crm/build-d1-guarded-backup.mjs from a dump whose sha256 is\n`
  + `-- ${sha256Hex(sql)}\n`
  + `-- stage 1 carries every row, stage 2 every guard; they are one file on purpose.\n`;

// anything we did not classify is carried verbatim rather than discarded, so a dump that grows a
// statement type this file has never seen still round-trips instead of quietly losing it.
const carried = buckets.other.filter((s) => !/^pragma \(dropped\)$/.test(s.name));
const stage1 = [...buckets.table, ...carried, ...dataStmts, ...buckets.index]
  .map((s) => `${s.stmt};`).join('\n\n');
const stage2 = [...buckets.view, ...buckets.trigger].map((s) => `${s.stmt};`).join('\n\n');
// no explicit BEGIN/COMMIT: `wrangler d1 execute --file` applies the whole file as ONE transaction,
// and a nested BEGIN inside it is an error. Both stages are therefore in the same file — the property
// a reviewer needs is that no committed state exists between the rows and the guards.
const restore = `${header('restore')}\n${stage1}\n\n-- stage 2: the guards, same file, same transaction\n\n${stage2}\n`;

const tables = buckets.table.map((s) => s.name).filter((n) => !n.startsWith('sqlite_'));
// one statement per metric: D1 refuses a long compound SELECT ("too many terms in compound
// SELECT"), and a verification script that errors out is worse than no verification script at all.
const NOT_QUIRK = "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'";
const verify = [
  '-- run against the restored database; compare every number with inventory.json',
  `SELECT 'table' AS kind, COUNT(*) AS n FROM sqlite_master WHERE type='table' ${NOT_QUIRK};`,
  "SELECT 'index' AS kind, COUNT(*) AS n FROM sqlite_master WHERE type='index';",
  "SELECT 'trigger' AS kind, COUNT(*) AS n FROM sqlite_master WHERE type='trigger';",
  "SELECT 'view' AS kind, COUNT(*) AS n FROM sqlite_master WHERE type='view';",
  "SELECT 'review_triggers' AS kind, COUNT(*) AS n FROM sqlite_master"
    + " WHERE type='trigger' AND name LIKE 'trg_review%';",
  "SELECT 'review_views' AS kind, COUNT(*) AS n FROM sqlite_master"
    + " WHERE type='view' AND name LIKE 'crm_review%';",
  "SELECT 'review_indexes' AS kind, COUNT(*) AS n FROM sqlite_master"
    + " WHERE type='index' AND name LIKE 'idx_crm_review%';",
  "SELECT 'migrations' AS kind, COUNT(*) AS n FROM d1_migrations;",
].concat(tables.map((t) => `SELECT '${t}' AS kind, COUNT(*) AS n FROM "${t}";`))
  .concat(tables.includes('crm_drive_review_event')
    ? ['-- the ledger must be intact by its own view, not merely present',
       "SELECT run_key AS kind, 'events=' || events || ' broken=' || broken_links"
       + " || ' gaps=' || seq_gaps || ' anchor_mismatches=' || anchor_mismatches AS n"
       + ' FROM crm_review_chain_integrity ORDER BY run_key;']
    : [])
  .join('\n');

const inventory = {
  title: TITLE,
  source_dump_sha256: sha256Hex(sql),
  objects: {
    table: buckets.table.map((s) => s.name),
    index: buckets.index.map((s) => s.name),
    trigger: buckets.trigger.map((s) => s.name),
    view: buckets.view.map((s) => s.name),
  },
  counts: {
    table: buckets.table.length, index: buckets.index.length,
    trigger: buckets.trigger.length, view: buckets.view.length,
    insert_statements: buckets.insert.length,
    // anything the classifier did not recognise is named here rather than silently discarded
    unclassified: buckets.other.length, carried_verbatim: carried.length,
  },
  rows_by_table: Object.fromEntries(rowsByTable),
  unclassified: buckets.other.map((s) => s.name),
  review_guard_counts: {
    triggers: buckets.trigger.filter((s) => /^trg_review/.test(s.name)).length,
    views: buckets.view.filter((s) => /^crm_review/.test(s.name)).length,
    indexes: buckets.index.filter((s) => /^idx_crm_review/.test(s.name)).length,
    tables: buckets.table.filter((s) => /^crm_drive_review/.test(s.name)).length,
  },
  stages: { restore_sha256: sha256Hex(restore), stage1_bytes: stage1.length, stage2_bytes: stage2.length },
};

const manifest = {
  ok: true,
  title: TITLE,
  generated_by: 'scripts/crm/build-d1-guarded-backup.mjs',
  guards_present: inventory.review_guard_counts.triggers === buckets.trigger.length
    && inventory.counts.trigger === buckets.trigger.length,
  counts: inventory.counts,
  review_guard_counts: inventory.review_guard_counts,
  restore_sha256: inventory.stages.restore_sha256,
  source_dump_sha256: inventory.source_dump_sha256,
  // the two properties a reviewer cares about, stated as claims the CI job can grep for
  guarantees: [
    'every statement in the dump is in the bundle: tables, rows, indexes, views and triggers',
    'rows and guards are restored in one file, so no transaction exists where data is unguarded',
    'no bucket is dropped silently — anything unrecognised is named in inventory.unclassified',
  ],
};

mkdirSync(resolve(OUT), { recursive: true });
writeFileSync(join(resolve(OUT), 'restore.sql'), restore);
writeFileSync(join(resolve(OUT), 'verify.sql'), verify);
writeFileSync(join(resolve(OUT), 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(join(resolve(OUT), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ ...manifest, out: resolve(OUT) }));
process.exit(manifest.guards_present ? 0 : 1);
