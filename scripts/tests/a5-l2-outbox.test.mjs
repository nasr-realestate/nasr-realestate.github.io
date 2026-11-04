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
  const ins=db.prepare('INSERT INTO l2_outbox VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('run-1',1,'crm_contacts','a',a,z,b,'proven','[]','[]');
  assert.throws(()=>ins.run('run-1',2,'crm_contacts','b',a,z,b,'proven'),/l2-outbox-previous-hash/);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,1); db.close();
});

test('verifier: checks hashes and row presence without trusting chain shape alone', async () => {
  const {verifyOutbox} = await import('../l2-verify-outbox.mjs');
  const {db,api}=fixture();
  await writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}});
  const query = (sql,params) => db.prepare(sql).all(...params);
  assert.equal((await verifyOutbox({query,runId:'run-1'})).ok,true);
  db.prepare('UPDATE crm_contacts SET name=? WHERE id=?').run('changed','a');
  assert.equal((await verifyOutbox({query,runId:'run-1'})).reason,'row-hash');
  db.prepare('DELETE FROM crm_contacts WHERE id=?').run('a');
  assert.equal((await verifyOutbox({query,runId:'run-1'})).reason,'row-missing-or-nonunique'); db.close();
});

test('verifier: missing relation target cannot be proven', async () => {
  const {verifyOutbox} = await import('../l2-verify-outbox.mjs');
  const {db,api}=fixture();
  db.exec('CREATE TABLE crm_contact_phones (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, phone_key TEXT NOT NULL)');
  await writeIndustrialRow(api,{runId:'run-1',table:'crm_contact_phones',row:{id:'p',contact_id:'missing',phone_key:'99900000000'}});
  const result = await verifyOutbox({query:(sql,params)=>db.prepare(sql).all(...params),runId:'run-1'});
  assert.equal(result.ok,false); assert.equal(result.reason,'relation-missing-or-nonunique'); db.close();
});

test('verifier: rejects sequence gaps and forged entry hashes', async () => {
  const {verifyOutbox} = await import('../l2-verify-outbox.mjs');
  const {db,api}=fixture(); const query=(sql,params)=>db.prepare(sql).all(...params);
  await writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}});
  db.exec('DROP TRIGGER l2_outbox_no_update');
  db.prepare('UPDATE l2_outbox SET entry_hash=?').run('a'.repeat(64));
  assert.equal((await verifyOutbox({query,runId:'run-1'})).reason,'entry-hash');
  db.exec('UPDATE l2_outbox SET event_seq=2');
  assert.equal((await verifyOutbox({query,runId:'run-1'})).reason,'sequence-or-chain'); db.close();
});

test('outbox: row insert failure never leaves an outbox entry', async () => {
  const {db,api}=fixture();
  db.prepare('INSERT INTO crm_contacts VALUES (?,?)').run('a','existing');
  await assert.rejects(writeIndustrialRow(api,{runId:'run-1',table:'crm_contacts',row:{id:'a',name:'synthetic'}}),/UNIQUE/);
  assert.equal(db.prepare('SELECT count(*) n FROM l2_outbox').get().n,0); db.close();
});

test('outbox: same isolated input reproduces the hash chain and verifier result', async () => {
  const {verifyOutbox} = await import('../l2-verify-outbox.mjs');
  async function once() {
    const {db,api}=fixture();
    for (const id of ['a','b']) await writeIndustrialRow(api,{runId:'replay-1',table:'crm_contacts',row:{id,name:'synthetic'}});
    const result=await verifyOutbox({query:(sql,params)=>db.prepare(sql).all(...params),runId:'replay-1'});
    db.close(); return result;
  }
  const first=await once(), second=await once(); assert.equal(first.ok,true); assert.deepEqual(first,second);
});
