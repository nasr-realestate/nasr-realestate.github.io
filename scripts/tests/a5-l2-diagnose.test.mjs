import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, annotationLines } from '../a5-l2-diagnose.mjs';
import { TABLE_SPECS } from '../a5-l2.mjs';

/** A read-only stub: each table answers with the fixture rows registered for it. */
const stubbed = (fixture) => (sql) => {
  const table = String(sql).match(/FROM\s+([a-z_]+)/i)?.[1] || '';
  return fixture[table] ?? [];
};

const ledgerOf = (events, baselineIds = {}) => ({
  error: 'ok', name: 'a5-l2-test.json',
  ledger: { run_tag: 'a5-1-1-aaaaaaaa', events, baseline: { ids: baselineIds } },
});

const registryRow = (driveRef, id = 'd1') => ({
  id, drive_ref: driveRef, drive_file_id: `SYNTHLIVE-${driveRef}`,
  content_sha256: 'f'.repeat(64), created_at: '2026-10-30T00:00:00Z',
});

test('DIA-1 a proven row that no longer exists is named, with its run tag and step', () => {
  const result = diagnose({
    query: stubbed({}),
    ledgers: [ledgerOf([
      { table: 'crm_drive_file_registry', unique_key: 'dr-live-1', observed_id: 'd1', run_tag: 'a5-1-1-aaaaaaaa', step: 'A5-L8' },
    ])],
  });
  assert.equal(result.verdict, 'row-vanished');
  assert.deepEqual(result.vanished.map((v) => [v.table, v.key, v.step]), [['crm_drive_file_registry', 'dr-live-1', 'A5-L8']]);
});

test('DIA-2 a row that is still there is not reported as vanished, even by observed id only', () => {
  const sameKey = diagnose({
    query: stubbed({ crm_drive_file_registry: [registryRow('dr-live-1')] }),
    ledgers: [ledgerOf([{ table: 'crm_drive_file_registry', unique_key: 'dr-live-1', observed_id: 'd1', run_tag: 'a5-1-1-aaaaaaaa', step: 'A5-L8' }])],
  });
  assert.equal(sameKey.vanished.length, 0);
  assert.equal(sameKey.unknown.length, 0);
  assert.equal(sameKey.verdict, 'clean');

  const sameId = diagnose({
    query: stubbed({ crm_drive_file_registry: [registryRow('renamed-key', 'd1')] }),
    ledgers: [ledgerOf([{ table: 'crm_drive_file_registry', unique_key: 'dr-live-1', observed_id: 'd1', run_tag: 'a5-1-1-aaaaaaaa', step: 'A5-L8' }])],
  });
  assert.equal(sameId.vanished.length, 0, 'the observed id proves the row still exists');
});

test('DIA-3 a row with no event and no baseline is unknown; a baseline row is not', () => {
  const result = diagnose({
    query: stubbed({ crm_drive_file_registry: [registryRow('dr-a', 'a'), registryRow('dr-b', 'b')] }),
    ledgers: [ledgerOf([], { crm_drive_file_registry: ['dr-b'] })],
  });
  assert.deepEqual(result.unknown.map((u) => u.table), ['crm_drive_file_registry']);
  assert.equal(result.unknown[0].key, 'dr-a');
  assert.equal(result.verdict, 'unknown-row');
});

test('DIA-4 an unreadable ledger is reported, not silently dropped', () => {
  const result = diagnose({
    query: stubbed({}),
    ledgers: [{ error: 'sha256-mismatch', name: 'a5-l2-bad.json', ledger: null }],
  });
  assert.deepEqual(result.untrusted, [{ name: 'a5-l2-bad.json', error: 'sha256-mismatch' }]);
  assert.equal(result.verdict, 'clean');
});

test('DIA-5 annotations stay within the ten-per-step budget and lead with the verdict', () => {
  const many = (n, kind) => Array.from({ length: n }, (_, i) => ({ table: kind, key: `k${i}`, run_tag: 'a5-1-1-aaaaaaaa', step: 's', label: 'l' }));
  const result = {
    verdict: 'row-vanished', ledgers: 9, rows: 53, untrusted: [], attested: [],
    vanished: many(9, 'crm_drive_file_registry'), unknown: many(9, 'crm_sessions'), legacy: many(9, 'crm_contacts'),
  };
  const lines = annotationLines(result);
  assert.ok(lines.length <= 10, `annotations=${lines.length}`);
  assert.match(lines[0], /verdict=row-vanished vanished=9 attested=0 unknown=9 legacy=9 ledgers=9/);
  assert.ok(lines.slice(1).every((l) => l.startsWith('::error::A5 L2 DIAG vanished') || l.startsWith('::error::A5 L2 DIAG unknown') || l.startsWith('::warning::')));
});

test('DIA-5b an attested deletion is reported apart from a mystery, never inside it', () => {
  const result = diagnose({
    query: stubbed({}),
    ledgers: [{ error: 'ok', name: 'x.json', ledger: { run_tag: 'a5-1-1-aaaaaaaa', baseline: { ids: {} }, events: [
      { table: 'crm_drive_file_registry', unique_key: 'k1', observed_id: 'o1', run_tag: 'a5-1-1-aaaaaaaa', step: 'S' },
      { table: 'crm_drive_file_registry', unique_key: 'k2', observed_id: 'o2', run_tag: 'a5-1-1-aaaaaaaa', step: 'S' },
    ] } }],
    deletions: [{ table: 'crm_drive_file_registry', key: 'k1', run_tag: 'a5-1-1-aaaaaaaa',
      deleted_by: 'owner', deleted_at: '2026-11-07', reason: 'حُذف صفٌّ صناعي بقرار المالك.' }],
  });
  assert.deepEqual(result.attested.map((a) => a.key), ['k1']);
  assert.deepEqual(result.vanished.map((v) => v.key), ['k2']);
  assert.equal(result.verdict, 'row-vanished');
  assert.ok(annotationLines(result).some((l) => l.startsWith('::notice::A5 L2 DIAG attested table=crm_drive_file_registry key=k1')));
});

test('DIA-6 every table the diagnosis reads is one the gate itself enumerates', () => {
  for (const table of Object.keys(TABLE_SPECS)) {
    assert.equal(typeof TABLE_SPECS[table].scope, 'string', `${table} must carry a scope`);
  }
});
