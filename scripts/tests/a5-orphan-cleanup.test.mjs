import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ORPHANS, deleteStatement, planByTable, planOrphans, safeId,
} from '../crm/a5-orphan-cleanup.mjs';

const spec = { idColumn: 'id' };
const row = (table, key, id) => ({ table, spec, a5_key: key, a5_id: id, row: {} });
const ledger = (events, baselineIds = {}) => ({
  error: 'ok', name: 'x.json',
  ledger: { run_tag: 'a5-1-1-aaaaaaaa', events, baseline: { ids: baselineIds } },
});

test('ORP-1 a row nothing claims is an orphan; a claimed, baseline or legacy row is not', () => {
  const plan = planOrphans({
    rows: [row('crm_sessions', 's1', 'id-1'), row('crm_followups', 'f1', 'id-2'), row('crm_contacts', 'c1', 'id-3')],
    ledgers: [ledger([{ table: 'crm_followups', unique_key: 'f1', observed_id: 'id-2' }], { crm_contacts: ['c1'] })],
    legacy: [{ table: 'crm_contacts', a5_key: 'c1' }],
  });
  assert.deepEqual(plan.map((p) => [p.table, p.key]), [['crm_sessions', 's1']]);
});

test('ORP-2 a row proven only by its observed id is claimed, not orphaned', () => {
  const plan = planOrphans({
    rows: [row('crm_sessions', 'renamed', 'id-9')],
    ledgers: [ledger([{ table: 'crm_sessions', unique_key: 'old-key', observed_id: 'id-9' }])],
  });
  assert.equal(plan.length, 0);
});

test('ORP-3 the delete names one row and one column, never a range', () => {
  assert.equal(
    deleteStatement({ table: 'crm_sessions', id: 'id-1', id_column: 'id' }),
    "DELETE FROM crm_sessions WHERE id = 'id-1'",
  );
  for (const bad of ["id'; DROP TABLE x; --", 'a b', '*', '']) {
    assert.throws(() => safeId(bad), /orphan-unsafe-id/, bad);
  }
  assert.throws(() => deleteStatement({ table: 'crm_sessions; --', id: 'x', id_column: 'id' }), /orphan-unsafe-table/);
});

test('ORP-4 the plan is grouped by table for review, sorted and counted', () => {
  const grouped = planByTable([
    { table: 'crm_sessions', key: 'a' }, { table: 'crm_sessions', key: 'b' }, { table: 'crm_audit', key: 'c' },
  ]);
  assert.deepEqual(grouped, [{ table: 'crm_audit', rows: 1 }, { table: 'crm_sessions', rows: 2 }]);
});

test('ORP-5 the ceiling is small and explicit, so a surprise stops instead of deleting', () => {
  assert.equal(MAX_ORPHANS, 20);
});
