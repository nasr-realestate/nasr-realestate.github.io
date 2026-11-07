import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRows, TABLE_SPECS } from '../a5-l2.mjs';
import {
  DELETIONS_SCHEMA, attestationIndex, deletionKey, loadDeletions, validateDeletions,
} from '../a5-l2-deletions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOK = path.join(ROOT, 'scripts', 'a5-l2-deletions.json');

/** Every table answers empty unless the fixture says otherwise: an empty namespace is the base. */
const emptyQuery = (fixture = {}) => (sql) => fixture[String(sql).match(/FROM\s+([a-z_]+)/i)?.[1] || ''] ?? [];

const ledgerWith = (events, baselineIds = {}) => ({
  error: 'ok', name: 'a5-l2-prior.json',
  ledger: { run_tag: 'a5-1-1-aaaaaaaa', events, baseline: { ids: baselineIds } },
});

const gap = (table = 'crm_drive_file_registry', key = 'gone-key') => ({
  table, unique_key: key, observed_id: 'obs-1', run_tag: 'a5-42314494090-1-80dff33a', step: 'ensure-review-case',
});

const entry = (over = {}) => ({
  table: 'crm_drive_file_registry', key: 'gone-key', run_tag: 'a5-42314494090-1-80dff33a',
  deleted_by: 'nasr-realestate (owner)', deleted_at: '2026-11-07',
  reason: 'المالك حذف الصف الصناعي بعد فشل التشغيل، وأُقرّ الحذف في الجلسة.', ...over,
});

const registryRow = (key) => ({
  id: 'obs-1', drive_ref: key, drive_file_id: `SYNTHLIVE-${key}`,
  content_sha256: 'f'.repeat(64), created_at: '2026-10-30T00:00:00Z',
});

test('DEL-1 the shipped book is valid and names the deletion the owner confirmed', () => {
  const book = loadDeletions(BOOK);
  assert.equal(book.ok, true, JSON.stringify(book.errors));
  assert.equal(book.present, true);
  assert.equal(book.entries.length, 3);
  for (const e of book.entries) {
    assert.equal(e.run_tag, 'a5-42314494090-1-80dff33a');
    assert.match(e.deleted_by, /owner/);
    assert.match(e.deleted_at, /^\d{4}-\d{2}-\d{2}/);
  }
  assert.deepEqual(book.entries.map((e) => e.table).sort(),
    ['crm_drive_file_registry', 'crm_drive_file_review_case', 'crm_drive_file_version']);
});

test('DEL-2 a gap with no entry in the book still stops the run', () => {
  const result = classifyRows({ query: emptyQuery(), ledgers: [ledgerWith([gap()])], currentRunTag: 'a5-2-1-bbbbbbbb' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^l2-row-vanished:crm_drive_file_registry$/);
  assert.equal(result.attested_deleted, 0);
});

test('DEL-3 an attested gap clears, is counted, and is never called vanished', () => {
  const result = classifyRows({
    query: emptyQuery(), ledgers: [ledgerWith([gap()])], currentRunTag: 'a5-2-1-bbbbbbbb',
    deletions: [entry()],
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.attested_deleted, 1);
  const v = result.verdicts.find((x) => x.verdict === 'attested-deleted');
  assert.equal(v.a5_key, 'gone-key');
  assert.equal(v.attested_at, '2026-11-07');
  assert.ok(!result.verdicts.some((x) => x.verdict.includes('vanished')));
});

test('DEL-4 an obituary for a row that is still there is a contradiction, not a licence', () => {
  const result = classifyRows({
    query: emptyQuery({ crm_drive_file_registry: [registryRow('gone-key')] }),
    ledgers: [ledgerWith([gap()])], currentRunTag: 'a5-2-1-bbbbbbbb', deletions: [entry()],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^l2-attestation-contradiction:crm_drive_file_registry$/);
});

test('DEL-4b an attested deletion does not excuse a different row that is present but unowned', () => {
  const result = classifyRows({
    query: emptyQuery({ crm_drive_file_registry: [registryRow('other-key')] }),
    ledgers: [ledgerWith([gap()])], currentRunTag: 'a5-2-1-bbbbbbbb', deletions: [entry()],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^unknown-ownership:/);
  assert.equal(result.attested_deleted, 1);
});

test('DEL-5 the book refuses every incomplete entry instead of reading it generously', () => {
  const cases = {
    'missing-reason': entry({ reason: '' }),
    'short-reason': entry({ reason: 'تنظيف' }),
    'bad-date': entry({ deleted_at: 'الأسبوع الماضي' }),
    'wildcard-key': entry({ key: '*' }),
    'no-run-tag': entry({ run_tag: '' }),
  };
  for (const [label, bad] of Object.entries(cases)) {
    const check = validateDeletions({ schema: DELETIONS_SCHEMA, deletions: [bad] });
    assert.equal(check.ok, false, label);
    assert.ok(check.errors.length > 0, label);
  }
  const duplicated = validateDeletions({ schema: DELETIONS_SCHEMA, deletions: [entry(), entry()] });
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.errors.some((e) => e.includes('duplicate')));
  assert.equal(validateDeletions({ schema: 'other', deletions: [] }).ok, false);
});

test('DEL-6 a missing book is an empty book, and the index is one key per row', () => {
  const missing = loadDeletions(path.join(ROOT, 'scripts', 'no-such-book.json'));
  assert.equal(missing.ok, true);
  assert.equal(missing.present, false);
  const index = attestationIndex([entry()]);
  assert.equal(index.get(deletionKey('crm_drive_file_registry', 'gone-key')).deleted_at, '2026-11-07');
  assert.equal(attestationIndex([]).size, 0);
});

test('DEL-6b the book and the diagnosis read the same tables the gate enumerates', () => {
  const book = loadDeletions(BOOK);
  for (const e of book.entries) {
    assert.ok(e.table in TABLE_SPECS, `${e.table} must be an enumerated table, not a guess`);
  }
  assert.ok(readFileSync(BOOK, 'utf8').includes(DELETIONS_SCHEMA));
});
