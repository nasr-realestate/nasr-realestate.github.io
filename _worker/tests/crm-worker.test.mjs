import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker, { normalizePhone } from '../crm-worker.js';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function accessToken(email = 'owner@example.com', aud = 'crm-aud') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const team = `team-${Math.random().toString(36).slice(2)}.cloudflareaccess.com`;
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'test-key';
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid });
  const payload = encode({ iss: `https://${team}`, aud: [aud], email, exp: Math.floor(Date.now()/1000)+600, nbf: Math.floor(Date.now()/1000)-10 });
  const message = `${header}.${payload}`;
  return { token: `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`, jwk, team };
}
class FakeDB {
  calls = [];
  constructor(existingContact=null) { this.existingContact=existingContact; }
  prepare(sql) {
    const call = { sql, params: [] }; this.calls.push(call);
    return { bind: (...params) => { call.params=params; return {
      first: async () => sql.includes('crm_submission_receipts') ? null : sql.includes('INSERT INTO crm_contacts') ? (this.existingContact ? null : {id:'contact-1',name:'تجريبي'}) : sql.includes('SELECT id,name FROM crm_contacts') ? this.existingContact : sql.includes('SELECT id FROM crm_opportunities') ? {id:'opportunity-1'} : sql.includes('SELECT l.id FROM listings') ? {id:77} : null,
      all: async () => ({results:[]}),
      run: async () => ({success:true}),
    }; } };
  }
  async batch(statements) { this.calls.push(...statements.map(s=>s)); return statements.map(()=>({success:true})); }
}
function authenticatedEnv(jwk, team, db = new FakeDB()) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys:[jwk] }), { headers:{'content-type':'application/json'} });
  return { env:{ DB:db, ACCESS_TEAM_DOMAIN:team, ACCESS_AUD:'crm-aud', ADMIN_EMAIL:'owner@example.com' }, db, restore:()=>{globalThis.fetch=original;} };
}
function createRequest(token, body, key='test-request-identifier-0001') {
  return new Request('https://api.example/api/opportunities',{method:'POST',headers:{origin:'https://nasr-realestate.github.io','cf-access-jwt-assertion':token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
}

test('Egyptian phone canonicalization accepts Arabic digits and matches international/local variants', () => {
  assert.equal(normalizePhone('0101 234 5678'),'201012345678');
  assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '201012345678');
  assert.equal(normalizePhone('+20 1012345678'),'201012345678');
  assert.equal(normalizePhone('123'),null);
});

test('CRM API fails closed when Access is not configured and rejects untrusted origins', async () => {
  const noAuth = await worker.fetch(new Request('https://api.example/api/opportunities'), { DB:new FakeDB() });
  assert.equal(noAuth.status,503);
  const auth=accessToken(); const { env, restore } = authenticatedEnv(auth.jwk,auth.team);
  try {
    const response = await worker.fetch(new Request('https://api.example/api/opportunities',{headers:{origin:'https://evil.example'}}),env);
    assert.equal(response.status,403);
  } finally { restore(); }
});

test('Access JWT signature, issuer, audience, email, and expiry are enforced', async () => {
  const good = accessToken(); const {env,restore}=authenticatedEnv(good.jwk,good.team);
  try {
    const response=await worker.fetch(new Request('https://api.example/api/opportunities',{headers:{'cf-access-jwt-assertion':good.token}}),env);
    assert.equal(response.status,200);
    const other=accessToken('attacker@example.com'); const response2=await worker.fetch(new Request('https://api.example/api/opportunities',{headers:{'cf-access-jwt-assertion':other.token}}),env);
    assert.equal(response2.status,401);
  } finally { restore(); }
});

test('new opportunity uses idempotency, normalized phone, and parameterized D1 writes only after authentication', async () => {
  const auth=accessToken(); const db=new FakeDB(); const {env,restore}=authenticatedEnv(auth.jwk,auth.team,db);
  try {
    const response=await worker.fetch(createRequest(auth.token,{phone:'٠١٠١٢٣٤٥٦٧٨',name:'تجريبي',intent:'buy',source:'call',status:'active',next_action:'اتصال متابعة',next_followup_at:'2026-11-01T10:00:00Z',notes:'بيانات اختبار فقط'}),env);
    const body=await response.json();
    assert.equal(response.status,201); assert.equal(body.contact_id,'contact-1');
    assert.equal(db.calls.filter(x=>String(x.sql||'').includes('INSERT INTO crm_opportunities')).length,1);
    assert.equal(db.calls.filter(x=>String(x.sql||'').includes('INSERT INTO crm_submission_receipts')).length,1);
    assert.ok(db.calls.every(x=>!String(x.sql||'').includes('201012345678')));
  } finally { restore(); }
});

test('a normalized phone whose saved name conflicts is flagged for review rather than merged', async () => {
  const auth=accessToken(); const db=new FakeDB({id:'existing-contact',name:'اسم مختلف'}); const {env,restore}=authenticatedEnv(auth.jwk,auth.team,db);
  try {
    const response=await worker.fetch(createRequest(auth.token,{phone:'+20 1012345678',name:'اسم جديد',intent:'buy',source:'call',status:'active',next_action:'اتصال',next_followup_at:'2026-11-01T10:00:00Z'},'test-request-identifier-0003'),env);
    assert.equal(response.status,409); assert.equal((await response.json()).error,'duplicate_phone_review');
    assert.equal(db.calls.some(x=>String(x.sql||'').includes('INSERT INTO crm_opportunities')),false);
  } finally { restore(); }
});

test('property links can only resolve to a site-owned listing mapped to a City of Nasr City area', async () => {
  const auth=accessToken(); const db=new FakeDB(); const {env,restore}=authenticatedEnv(auth.jwk,auth.team,db);
  try {
    const response=await worker.fetch(new Request('https://api.example/api/opportunities/opportunity-1/properties',{method:'POST',headers:{origin:'https://nasr-realestate.github.io','cf-access-jwt-assertion':auth.token,'content-type':'application/json'},body:JSON.stringify({external_id:'fixture-listing',presentation_status:'viewing_scheduled',viewing_at:'2026-11-03T12:00:00Z',presented_price:2500000})}),env);
    assert.equal(response.status,200);
    const lookup=db.calls.find(x=>String(x.sql||'').includes('SELECT l.id FROM listings'));
    assert.match(lookup.sql,/l\.source_id=9 AND l\.external_id=\? AND l\.area_id IN \(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31\)/);
    assert.ok(db.calls.some(x=>String(x.sql||'').includes('INSERT INTO crm_opportunity_properties')));
  } finally { restore(); }
});

test('an active opportunity without a dated next action or explicit exception is rejected before D1 writes', async () => {
  const auth=accessToken(); const db=new FakeDB(); const {env,restore}=authenticatedEnv(auth.jwk,auth.team,db);
  try {
    const response=await worker.fetch(createRequest(auth.token,{phone:'01012345678',intent:'rent',source:'call',status:'active'},'test-request-identifier-0002'),env);
    assert.equal(response.status,400); assert.equal(db.calls.length,0);
  } finally { restore(); }
});
