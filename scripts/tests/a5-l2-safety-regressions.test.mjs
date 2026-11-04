import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LEGACY_PROBES, TABLE_SPECS, BASELINE_SCHEMA, a5RunIdentity, buildLedger, classifyRows, createLedger, finalizeLedger } from '../a5-l2.mjs';
const identity = a5RunIdentity({GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',A5_L2_NONCE:'aaaaaaaa'});
const baseline = {schema:BASELINE_SCHEMA, ids:{}, digest:''};
const empty = () => [];
const contact = {id:'example', review_note:'A5-RUN:a5-1-1-aaaaaaaa'};
const queryContact = sql => sql.startsWith('SELECT *') ? [] : sql.includes('FROM crm_contacts') ? [contact] : [];

test('T1 legacy nullable markers do not hide suspect contacts and conversations', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE crm_contacts(id TEXT,name TEXT,review_note TEXT); CREATE TABLE crm_conversations(id TEXT,source_ref TEXT,chat_title TEXT,conversation_uid TEXT); INSERT INTO crm_contacts VALUES ('c','TEST ONLY old',NULL); INSERT INTO crm_conversations VALUES ('v','post_deploy_e2e_synthetic','x',NULL)");
  for (const label of ['legacy-contact-name','legacy-conversation']) {
    const p=LEGACY_PROBES.find(x=>x.label===label);
    assert.equal(db.prepare(`SELECT * FROM ${p.table} WHERE ${p.where}`).all().length,1);
  }
  db.close();
});
test('T2 baseline is not ownership evidence', () => {
  const l=createLedger(identity,{...baseline,ids:{crm_contacts:['example']}}); finalizeLedger(l,'success');
  assert.equal(classifyRows({query:queryContact,ledgers:[{error:'ok',ledger:l}],currentRunTag:'other'}).ok,false);
});
test('T3 pending cannot attest a pre-existing record', () => {
  assert.throws(()=>buildLedger({identity,baseline:{...baseline,ids:{crm_contacts:['example']}},pending:[{table:'crm_contacts',lookup_value:'example'}],query:queryContact}),/unproven-preexisting/);
});
test('T4 new read-back alone cannot attest a record', () => {
  assert.throws(()=>buildLedger({identity,baseline,pending:[],query:queryContact}),/unproven-row/);
});
test('T5 legacy markers are suspects only, not proof of customer classification', () => {
  const result=classifyRows({query:sql=>sql.startsWith('SELECT * FROM crm_contacts')?[contact]:[],ledgers:[],currentRunTag:'other'});
  assert.equal(result.ok,false); assert.match(result.verdicts[0].verdict,/unknown/);
});
test('T6 opportunities participate in both scopes', () => {
  assert.ok(TABLE_SPECS.crm_opportunities); assert.ok(LEGACY_PROBES.some(p=>p.table==='crm_opportunities'));
});
test('T7 deploy path fails closed while live writes lack contemporary evidence', () => {
  const wf=readFileSync('.github/workflows/crm-cloudflare-test-deploy.yml','utf8');
  assert.ok(wf.indexOf('Stop until complete contemporaneous L2 coverage') < wf.indexOf('Deploy nasr-crm-api-test and run live A5 E2E'));
  assert.match(wf,/Stop until complete contemporaneous L2 coverage[\s\S]*?exit 1/);
});
test('T11 zero-event failure evidence does not grant ownership', () => {
  const ledger=createLedger(identity,{...baseline,ids:{}}); ledger.evidence_class='failure-no-ownership-claims';
  finalizeLedger(ledger,'failure','preflight-not-cleared');
  const result=classifyRows({query:queryContact,ledgers:[{error:'ok',ledger}],currentRunTag:'other'});
  assert.equal(result.ok,false); assert.ok(result.verdicts.every(v=>v.verdict!=='previous-a5-proven'));
});
test('artifact evidence alone never yields proven without transactional outbox verification', async () => {
  const { appendEvent, rowColumnsSha256, rowHash } = await import('../a5-l2.mjs');
  const spec=TABLE_SPECS.crm_contacts, ledger=createLedger(identity,baseline);
  appendEvent(ledger,{table:'crm_contacts',unique_key:'example',observed_id:'example',id_source:'http-201-body',row_columns_sha256:rowColumnsSha256(spec,contact),row_hash:rowHash(spec,contact)});
  finalizeLedger(ledger,'success');
  const result=classifyRows({query:queryContact,ledgers:[{error:'ok',ledger}],currentRunTag:'other'});
  assert.equal(result.ok,false);
  assert.ok(result.verdicts.some(v=>v.verdict==='unknown:outbox-evidence-required'));
});
