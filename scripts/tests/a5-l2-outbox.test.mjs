import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { writeIndustrialRow } from '../../_worker/l2-outbox.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.exec(readFileSync('_worker/migrations-proposed/0015_l2_outbox.sql', 'utf8'));
  const api = { prepare(sql) { return { bind(...v) { return {
    first: async () => db.prepare(sql).get(...v) || null,
    run: () => db.prepare(sql).run(...v),
  }; } }; }, async batch(stmts) { db.exec('BEGIN'); try { for (const s of stmts) s.run(); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; } } };
  return { db, api };
}
test('outbox: row and chained evidence commit together locally', async () => {
  const {db,api}=fixture();
  const a=await writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}});
  const b=await writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'b',name:'synthetic'}});
  assert.equal(b.event_seq,2); assert.equal(b.prev_hash,a.entry_hash);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_contacts').get().n,2);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,2);
  assert.throws(()=>db.exec("UPDATE l2_outbox SET result='failed'"),/append-only/); db.close();
});
test('outbox: evidence failure rolls back the corresponding row (partial failure)', async () => {
  const {db,api}=fixture();
  await writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}});
  db.exec("CREATE TRIGGER fail_next BEFORE INSERT ON l2_outbox BEGIN SELECT RAISE(ABORT,'simulated'); END;");
  await assert.rejects(writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'b',name:'synthetic'}}),/simulated/);
  assert.equal(db.prepare("SELECT count(*) n FROM crm_contacts WHERE id='b'").get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,1); db.close();
});
test('outbox: duplicate replay fails deterministically without a second row or event', async () => {
  const {db,api}=fixture(); const arg={runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}};
  await writeIndustrialRow(api,arg); await assert.rejects(writeIndustrialRow(api,arg),/UNIQUE/);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_contacts').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,1); db.close();
});
test('T8 outbox: rejects a stale chain head without inserting evidence', () => {
  const {db}=fixture(); const z='0'.repeat(64), a='a'.repeat(64), b='b'.repeat(64);
  const ins=db.prepare('INSERT INTO l2_outbox VALUES (?,?,?,?,?,?,?,?)');
  ins.run('run-1',1,'crm_contacts','a',a,z,b,'proven');
  assert.throws(()=>ins.run('run-1',2,'crm_contacts','b',a,z,b,'proven'),/l2-outbox-previous-hash/);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,1); db.close();
});
