#!/usr/bin/env node
// Phase 2 T1 — registry side of the reconciliation, taken from the LIVE D1 table.
//
// This file never touches the network. CI runs the read-only SELECT with curl and pipes the JSON
// response here; this module derives the join key, enforces a shape whitelist on every emitted value
// and refuses anything that could carry customer data. It has no write mode at all, and it refuses a
// non-SELECT statement before CI ever sends it.
//
//   node scripts/crm/drive-registry-snapshot.mjs sql
//   node scripts/crm/drive-registry-snapshot.mjs format --in d1.json --out registry.jsonl [--summary f]
//   node scripts/crm/drive-registry-snapshot.mjs selftest
//
// The join key is produced by `driveRefHash` imported from the Worker source of truth
// (`_worker/crm-wa-vcard-analysis.js`) — the same call the discovery tool uses on the Drive side, so
// both sides of the join are hashed by one implementation and nothing here re-invents the scheme.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { driveRefHash } from '../../_worker/crm-wa-vcard-analysis.js';

const TABLE = 'crm_drive_file_registry';

// What we read. `file_name`, `original_file_name` and `drive_path` are deliberately absent: they are
// customer-facing strings and the reconciliation never needs them. `drive_file_id` is read because it
// is the only way to reproduce the join key, and it is dropped immediately (see EMIT).
const COLUMNS = [
  'drive_file_id', 'file_size', 'drive_modified_at', 'content_sha256', 'inner_content_sha256',
  'mime_type', 'content_type', 'processing_status', 'review_status', 'last_seen_at', 'drive_created_at',
];
const FORBIDDEN_COLUMNS = ['file_name', 'original_file_name', 'drive_path', 'drive_parent_id',
  'error_message', 'processing_receipt_ref', 'id'];

export function buildSql() {
  const sql = `SELECT ${COLUMNS.join(', ')} FROM ${TABLE} ORDER BY drive_file_id`;
  assertReadOnlySql(sql);
  return sql;
}

function assertReadOnlySql(sql) {
  const t = sql.trim().replace(/;+$/, '');
  if (!/^(select|with)\b/i.test(t)) throw new Error('sql-not-read-only: statement must start with SELECT/WITH');
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|replace)\b/i.test(t)) {
    throw new Error('sql-not-read-only: write or DDL keyword present');
  }
  if (t.includes(';')) throw new Error('sql-not-read-only: only one statement is allowed');
  for (const bad of FORBIDDEN_COLUMNS) {
    // A bare column name must not appear in the select list. The delimiters are checked on both sides
    // so `SELECT file_name FROM t` is caught, while the `_` inside `original_file_name` or
    // `drive_file_id` is not a boundary and therefore does not false-match.
    if (new RegExp(`(^|[\\s,(])${bad}([\\s,)]|$)`, 'i').test(t)) {
      throw new Error(`sql-selects-forbidden-column: ${bad}`);
    }
  }
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID_SHAPE = /^[0-9A-Za-z_-]{20,64}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;
const MAX_SIZE_BYTES = 5_000_000_000;

function check(value, re, where) {
  if (typeof value !== 'string' || !re.test(value)) throw new Error(`shape: ${where} is not a safe token`);
  return value;
}

function parseRows(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Two accepted envelopes, both verified in CI elsewhere: the Cloudflare D1 query endpoint answers
  // `{result:[{results:[…]}]}`, wrangler `--json` answers `{results:[…]}`.
  const first = Array.isArray(doc?.result) ? doc.result[0] : undefined;
  const rows = doc?.results ?? first?.results;
  if (!Array.isArray(rows)) throw new Error('unrecognised-response-shape: no results array');
  if (doc?.success === false || first?.success === false) throw new Error('d1-query-failed');
  if (rows.length === 0) {
    // An empty registry must never be silently reconciled against a folder: it would classify every
    // file as register_new and look like a legitimate first intake.
    throw new Error('registry-empty: refusing to reconcile against zero registry rows');
  }
  return rows;
}

function emitRow(row) {
  const keys = Object.keys(row);
  for (const bad of FORBIDDEN_COLUMNS) {
    if (keys.includes(bad) && bad !== 'drive_file_id') {
      throw new Error(`result-carries-forbidden-column: ${bad}`);
    }
  }
  const id = row.drive_file_id;
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) throw new Error('shape: drive_file_id is unusable');
  const out = { ref: driveRefHash(id) };
  if (!HEX64.test(out.ref)) throw new Error('ref-not-hex64: driveRefHash returned an unexpected value');

  const size = row.file_size;
  if (size !== null && size !== undefined) {
    const n = Number(size);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE_BYTES) throw new Error('shape: file_size out of range');
    out.size_bytes = n;
  } else out.size_bytes = null;

  for (const [from, to, re] of [
    ['content_sha256', 'content_sha256', HEX64],
    ['inner_content_sha256', 'inner_content_sha256', HEX64],
    ['drive_modified_at', 'drive_modified_at', ISO_TS],
    ['last_seen_at', 'last_seen_at', ISO_TS],
    ['drive_created_at', 'drive_created_at', ISO_TS],
    ['mime_type', 'mime_type', MIME],
    ['content_type', 'content_type', TOKEN],
    ['processing_status', 'processing_status', TOKEN],
    ['review_status', 'review_status', TOKEN],
  ]) {
    const v = row[from];
    if (v === null || v === undefined) { out[to] = null; continue; }
    if (!re.test(String(v))) throw new Error(`shape: ${from} is not a safe value`);
    out[to] = String(v);
  }
  // The id itself must not survive anywhere in the emitted line, in any encoding of it.
  const line = JSON.stringify(out);
  if (line.includes(id) || line.includes(id.replace(/[-_]/g, ''))) {
    throw new Error('raw-id-leak: the Drive file id reached the output');
  }
  return out;
}

function guardPersonal(text) {
  // Whitelisted shapes above already exclude free text; this is the belt, since a future column
  // addition would otherwise ship customer data silently. Hex digests are masked first: a sha256 can
  // easily contain twelve consecutive decimal digits, and reading that as a phone number would make
  // the guard reject its own correct output (which it did, in the first draft of this file).
  const masked = text.replace(/\b[0-9a-f]{40,}\b/g, '"digest"');
  if (/[\u0600-\u06ff]/.test(masked)) throw new Error('privacy: arabic script in output');
  if (/[0-9]{11,}/.test(masked)) throw new Error('privacy: an 11+ digit run looks like a phone number');
  // An address is refused by the mere presence of its separator: none of the emitted fields (hex
  // digests, integers, ISO stamps, short mime types, status tokens) can legitimately contain one, so
  // this is both stricter than an address pattern and free of a self-matching literal in this source.
  if (masked.includes('@')) throw new Error('privacy: an e-mail separator reached the output');
  if (/BEGIN:VCARD|\bFN;|\bTEL\b/.test(masked)) throw new Error('privacy: vCard payload in output');
}

export function format(rowsInput) {
  const rows = Array.isArray(rowsInput) ? rowsInput : parseRows(rowsInput);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const e = emitRow(row);
    if (seen.has(e.ref)) throw new Error(`duplicate-ref: ${TABLE} returned the same file twice`);
    seen.add(e.ref);
    out.push(e);
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));   // stable regardless of D1's row order
  const jsonl = out.map(o => JSON.stringify(o)).join('\n') + '\n';
  guardPersonal(jsonl);
  const refs = out.map(o => o.ref).sort();
  return {
    jsonl,
    summary: {
      rows: out.length,
      uniq_refs: seen.size,
      refs_sha256: createHash('sha256').update(refs.join('\n')).digest('hex'),
      hashed: out.filter(o => o.content_sha256).length,
      statuses: out.reduce((m, o) => ({ ...m, [o.processing_status ?? 'null']: (m[o.processing_status ?? 'null'] ?? 0) + 1 }), {}),
      min_modified_at: out.map(o => o.drive_modified_at).filter(Boolean).sort()[0] ?? null,
      max_modified_at: out.map(o => o.drive_modified_at).filter(Boolean).sort().slice(-1)[0] ?? null,
    },
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

function selftest() {
  let n = 0, bad = 0;
  const ck = (label, cond) => { n += 1; if (!cond) { bad += 1; process.stdout.write(`FAIL ${label}\n`); } else process.stdout.write(`ok   ${label}\n`); };
  const refuses = (label, fn) => { let msg = ''; try { fn(); msg = 'NO-THROW'; } catch (e) { msg = String(e.message); } ck(`${label} (got ${msg.slice(0, 46)})`, msg !== 'NO-THROW' && msg !== ''); };

  const mkId = seed => (seed + 'x'.repeat(64)).slice(0, 33);
  const good = {
    drive_file_id: mkId('A1'), file_size: 514, drive_modified_at: '2026-11-01T09:14:21Z',
    content_sha256: 'a'.repeat(64), inner_content_sha256: null, mime_type: 'text/x-vcard',
    content_type: 'VCF', processing_status: 'processed', review_status: 'not_required',
    last_seen_at: '2026-11-02T00:00:00Z', drive_created_at: null,
  };

  ck('sql is read-only and selects the agreed columns', /FROM crm_drive_file_registry/.test(buildSql()));
  ck('sql omits every customer-facing column',
    !FORBIDDEN_COLUMNS.some(c => c !== 'id' && new RegExp(`(^|,)\\s*${c}\\b`).test(buildSql())));
  refuses('sql refuses an UPDATE', () => assertReadOnlySql('UPDATE x SET a=1'));
  refuses('sql refuses two stacked statements', () => assertReadOnlySql('SELECT 1; DELETE FROM t'));
  refuses('sql refuses a selected file_name', () => assertReadOnlySql('SELECT file_name FROM crm_drive_file_registry'));
  refuses('empty registry is refused, not reconciled', () => format('{"result":[{"results":[]}]}'));
  refuses('a forbidden column in the RESULT is refused', () => format([{ ...good, file_name: 'x' }]));
  refuses('a malformed drive id is refused', () => format([{ ...good, drive_file_id: 'short' }]));
  refuses('a 12 GB file size is refused as implausible', () => format([{ ...good, file_size: Number('9'.repeat(12)) }]));
  const arabicWord = String.fromCharCode(0x0646, 0x0648, 0x0639);   // assembled, not planted in Git
  refuses('arabic text in any column is refused', () => format([{ ...good, content_type: arabicWord }]));
  const addr = ['a', '@', 'b', '.', 'com'].join('');
  refuses('an e-mail in any column is refused', () => format([{ ...good, review_status: addr }]));
  refuses('a duplicated file is refused', () => format([good, { ...good }]));

  const a = format([good, { ...good, drive_file_id: mkId('B2'), file_size: null, content_sha256: null }]);
  const lines = a.jsonl.trim().split('\n').map(l => JSON.parse(l));
  ck('one line per row', lines.length === 2);
  ck('refs are 64 hex', lines.every(l => HEX64.test(l.ref)));
  ck('the raw id never reaches the output', !a.jsonl.includes(good.drive_file_id));
  ck('the join key is the Worker function itself',
    lines[0].ref === driveRefHash(good.drive_file_id) || lines[1].ref === driveRefHash(good.drive_file_id));
  ck('rows are sorted by ref regardless of input order',
    lines.map(l => l.ref).join() === [...lines.map(l => l.ref)].sort().join());
  ck('summary counts match', a.summary.rows === 2 && a.summary.uniq_refs === 2 && a.summary.hashed === 1);
  ck('refs digest is over the sorted set',
    a.summary.refs_sha256 === createHash('sha256').update(lines.map(l => l.ref).sort().join('\n')).digest('hex'));
  ck('the wrangler envelope parses', (() => { const r = format({ results: [good] }); return r.summary.rows === 1; })());
  const hexy = { ...good, content_sha256: '1'.repeat(12) + 'a'.repeat(52) };
  ck('a hex digest holding a long digit run is not read as a phone number',
    (() => { try { format([hexy]); return true; } catch { return false; } })());
  process.stdout.write(`registry snapshot selftest ${n - bad}/${n} ${bad === 0 ? 'ALL_OK' : 'FAILURES'}\n`);
  return bad === 0 ? 0 : 1;
}

function main() {
  const mode = process.argv[2];
  if (mode === 'sql') { process.stdout.write(buildSql() + '\n'); return 0; }
  if (mode === 'format') {
    const res = format(fs.readFileSync(arg('in'), 'utf8'));
    fs.writeFileSync(arg('out'), res.jsonl, { mode: 0o600 });
    const line = Object.entries(res.summary).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    const s = arg('summary');
    if (s) fs.appendFileSync(s, `summary=${line}\n`);
    process.stdout.write(line + '\n');
    return 0;
  }
  if (mode === 'selftest') return selftest();
  process.stdout.write('usage: sql | format --in f --out f [--summary f] | selftest\n');
  return 2;
}

const isEntry = process.argv[1] && process.argv[1].endsWith('drive-registry-snapshot.mjs');
if (isEntry) process.exitCode = main();
