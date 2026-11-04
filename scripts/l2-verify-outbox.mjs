#!/usr/bin/env node
// Read-only verification of the proposed L2 outbox. The caller supplies a read-only
// database query adapter; this module has no Cloudflare or network client. Hash chaining
// detects corruption, not a malicious writer who can rewrite a whole chain. A verified
// entry is not by itself authorization to claim ownership without a trusted run boundary.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { OUTBOX_TABLES, OUTBOX_RELATIONS, OUTBOX_ZERO, outboxCanonical } from '../_worker/l2-outbox.js';

const identifier = name => typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name);
const failure = (reason, checked) => ({ ok: false, reason, checked });

// One verification engine for async D1-shaped adapters and synchronous SQLite/read-only
// query adapters. Hash serialization is identical to the Worker's WebCrypto helper.
const digest = value => createHash('sha256').update(outboxCanonical(value), 'utf8').digest('hex');
function* verifyOutboxSteps(runId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId || '')) return failure('invalid-input', 0);
  let entries;
  try {
    entries = yield ['SELECT run_id,event_seq,table_name,row_id,row_hash,prev_hash,entry_hash,result,columns_json,relations_json FROM l2_outbox WHERE run_id = ? ORDER BY event_seq', [runId]];
    if (!Array.isArray(entries)) return failure('outbox-query-shape', 0);
  } catch { return failure('outbox-unreadable', 0); }
  let previous = OUTBOX_ZERO;
  let checked = 0;
  const proven = [];
  for (const entry of entries) {
    const {run_id, event_seq, table_name, row_id, row_hash, prev_hash, entry_hash, result, columns_json, relations_json} = entry;
    const idColumn = Object.hasOwn(OUTBOX_TABLES, table_name) ? OUTBOX_TABLES[table_name] : undefined;
    if (run_id !== runId || !Number.isSafeInteger(event_seq) || event_seq !== checked + 1 || prev_hash !== previous) return failure('sequence-or-chain', checked);
    if (!idColumn || typeof row_id !== 'string' || !row_id || !['proven','unknown','failed'].includes(result)) return failure('entry-fields', checked);
    if (![row_hash, prev_hash, entry_hash].every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) return failure('hash-shape', checked);
    let columns, relations;
    try { columns = JSON.parse(columns_json); relations = JSON.parse(relations_json); }
    catch { return failure('invalid-json', checked); }
    if (!Array.isArray(columns) || !columns.length || !columns.every(identifier) || new Set(columns).size !== columns.length ||
        !columns.includes(idColumn) || outboxCanonical([...columns].sort()) !== columns_json ||
        !Array.isArray(relations) || outboxCanonical(relations) !== relations_json) return failure('invalid-columns-or-relations', checked);
    const event = {run_id, event_seq, table_name, row_id, row_hash, prev_hash, result, columns_json, relations_json};
    if (digest(event) !== entry_hash) return failure('entry-hash', checked);
    let rows;
    const relationColumns = Object.keys(OUTBOX_RELATIONS[table_name] || {});
    const fetchedColumns = [...new Set([...columns, ...relationColumns])];
    try { rows = yield [`SELECT ${fetchedColumns.join(',')} FROM ${table_name} WHERE ${idColumn} = ? LIMIT 2`, [row_id]]; }
    catch { return failure('row-unreadable', checked); }
    if (!Array.isArray(rows) || rows.length !== 1) return failure('row-missing-or-nonunique', checked);
    const row = {};
    for (const col of columns) row[col] = rows[0][col];
    if (row[idColumn] !== row_id || digest({table: table_name, row}) !== row_hash) return failure('row-hash', checked);
    // The list is derived from schema-known FK columns, not trusted from the event.
    const expected = Object.entries(OUTBOX_RELATIONS[table_name] || {})
      .filter(([column]) => rows[0][column] != null)
      .map(([column, table]) => ({column, table, row_id: String(rows[0][column])}));
    if (outboxCanonical(expected) !== relations_json) return failure('relations-mismatch', checked);
    for (const relation of expected) {
      const targetId = OUTBOX_TABLES[relation.table];
      if (!targetId) return failure('relation-table-unknown', checked);
      try {
        const target = yield [`SELECT ${targetId} FROM ${relation.table} WHERE ${targetId} = ? LIMIT 2`, [relation.row_id]];
        if (!Array.isArray(target) || target.length !== 1) return failure('relation-missing-or-nonunique', checked);
      } catch { return failure('relation-unreadable', checked); }
    }
    if (result === 'proven') proven.push({ table: table_name, row_id, run_id, event_seq, entry_hash });
    previous = entry_hash;
    checked += 1;
  }
  return { ok: true, reason: 'verified', checked, proven };
}

/** query(sql, params) returns rows; the verifier emits SELECT statements only. */
export async function verifyOutbox({ query, runId }) {
  if (typeof query !== 'function') return failure('invalid-input', 0);
  const steps = verifyOutboxSteps(runId);
  let step = steps.next();
  while (!step.done) {
    try { step = steps.next(await query(...step.value)); }
    catch (error) { step = steps.throw(error); }
  }
  return step.value;
}

/** Synchronous adapter for classifyRows, which uses a synchronous read-only query. */
export function verifyOutboxSync({ query, runId }) {
  if (typeof query !== 'function') return failure('invalid-input', 0);
  const steps = verifyOutboxSteps(runId);
  let step = steps.next();
  while (!step.done) {
    try {
      const rows = query(...step.value);
      if (rows && typeof rows.then === 'function') throw new Error('async-query-not-supported');
      step = steps.next(rows);
    } catch (error) { step = steps.throw(error); }
  }
  return step.value;
}

// Offline executable demonstration: opens only an in-memory SQLite DB, never D1.
async function selfTest() {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const { writeIndustrialRow } = await import('../_worker/l2-outbox.js');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    db.exec(readFileSync(new URL('../_worker/migrations-proposed/0015_l2_outbox.sql', import.meta.url), 'utf8'));
    const api = { prepare(sql) { return { bind(...params) { return {
      first: async () => db.prepare(sql).get(...params) || null,
      run: () => db.prepare(sql).run(...params),
    }; } }; }, async batch(statements) { db.exec('BEGIN'); try { for (const s of statements) s.run(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } } };
    await writeIndustrialRow(api, { runId: 'offline-demo', table: 'crm_contacts', row: { id: 'synthetic-id', name: 'synthetic' } });
    const result = await verifyOutbox({ query: (sql, params) => db.prepare(sql).all(...params), runId: 'offline-demo' });
    console.log(JSON.stringify({ok: result.ok, reason: result.reason, checked: result.checked, proven_count: result.proven?.length || 0}));
    if (!result.ok || result.proven.length !== 1) process.exitCode = 1;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--self-test') { console.error('Only --self-test is supported; no live D1 client is provided.'); process.exitCode = 2; }
  else await selfTest();
}
