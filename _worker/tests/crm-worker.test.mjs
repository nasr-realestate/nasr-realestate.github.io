import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker, { normalizePhone } from '../crm-worker.js';

const migration = await readFile(new URL('../migrations/0001_crm_opportunities.sql', import.meta.url), 'utf8');
const ORIGIN = 'https://crm-test.example.invalid';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function accessToken(email = 'owner@example.com', aud = 'synthetic-audience') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const team = `synthetic-${Math.random().toString(36).slice(2)}.cloudflareaccess.com`;
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'synthetic-key';
  const makeToken = (overrides = {}) => {
    const header = encode({ alg: overrides.alg || 'RS256', typ: 'JWT', kid: jwk.kid });
    const now=Math.floor(Date.now()/1000);
    const payload = encode({ iss: overrides.iss || `https://${team}`, aud: overrides.aud ?? [aud], email: overrides.email ?? email, exp: overrides.exp ?? now+600, nbf: overrides.nbf ?? now-10 });
    const message = `${header}.${payload}`;
    return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
  };
  return { token:makeToken(), makeToken, jwk, team };
}
function sqliteFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE areas(id INTEGER PRIMARY KEY,name_ar TEXT NOT NULL); CREATE TABLE sources(id INTEGER PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE listings(id INTEGER PRIMARY KEY,source_id INTEGER,external_id TEXT,url TEXT,title TEXT,property_type TEXT,transaction_type TEXT,area_id INTEGER,area_m2 REAL,price REAL,bedrooms INTEGER,bathrooms INTEGER,finishing TEXT,observed_at TEXT);');
  sqlite.exec(migration);
  return sqlite;
}
// This adapter intentionally models D1.batch with a local SQLite transaction;
// it is a unit/integration test double, not a Cloudflare D1 emulator or live test.
class SQLiteD1 {
  constructor(sqlite) { this.sqlite=sqlite; }
  prepare(sql) {
    let params=[];
    const sqliteStatement=this.sqlite.prepare(sql);
    const wrapped={
      bind(...values) { params=values; return wrapped; },
      async first() { return sqliteStatement.get(...params)||null; },
      async all() { return {results:sqliteStatement.all(...params)}; },
      async run() { return sqliteStatement.run(...params); },
      runSync() { return sqliteStatement.run(...params); },
    };
    return wrapped;
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const result=statements.map(statement=>statement.runSync()); this.sqlite.exec('COMMIT'); return result; }
    catch(error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
function authenticatedEnv(auth, db = new SQLiteD1(sqliteFixture())) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys:[auth.jwk] }), { headers:{'content-type':'application/json'} });
  return { env:{ DB:db, ACCESS_TEAM_DOMAIN:auth.team, ACCESS_AUD:'synthetic-audience', ADMIN_EMAIL:'owner@example.com', CRM_ALLOWED_ORIGIN:ORIGIN, CRM_SITE_SOURCE_ID:'9009', CRM_NASR_AREA_IDS:'90001,90002' }, db, restore:()=>{globalThis.fetch=original;} };
}
function request(auth, path, method='GET', body, key='synthetic-request-identifier-0001', origin=ORIGIN, token=auth.token) {
  const headers={origin,'cf-access-jwt-assertion':token};
  if(body!==undefined) { headers['content-type']='application/json'; headers['idempotency-key']=key; }
  return new Request(`https://api.test${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
function newOpportunity(phone='01012345678', overrides={}) {
  return {phone,name:'عميل تجريبي',intent:'buy',source:'call',status:'active',next_action:'اتصال متابعة',next_followup_at:'2026-11-01T10:00:00Z',...overrides};
}

test('Egyptian phone canonicalization accepts Arabic digits and matches international/local variants', () => {
  assert.equal(normalizePhone('0101 234 5678'),'201012345678');
  assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'),'201012345678');
  assert.equal(normalizePhone('+20 1012345678'),'201012345678');
  assert.equal(normalizePhone('123'),null);
});

test('Access/CORS fail closed and the configured origin is not hard-coded', async () => {
  const auth=accessToken(), {env,restore}=authenticatedEnv(auth);
  try {
    const preflight=await worker.fetch(new Request('https://api.test/api/contacts',{method:'OPTIONS',headers:{origin:ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'content-type,idempotency-key'}}),env);
    assert.equal(preflight.status,204); assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);
    const evil=await worker.fetch(request(auth,'/api/contacts','GET',undefined,'', 'https://evil.invalid'),env);
    assert.equal(evil.status,403);
    const unauth=await worker.fetch(new Request('https://api.test/api/contacts',{headers:{origin:ORIGIN}}),env);
    assert.equal(unauth.status,401);
    const missingOriginConfig={...env,CRM_ALLOWED_ORIGIN:''};
    const closed=await worker.fetch(new Request('https://api.test/api/contacts'),missingOriginConfig);
    assert.equal(closed.status,503);
    const badScope={...env,CRM_NASR_AREA_IDS:'1,2); DROP TABLE listings;--'};
    const scopeClosed=await worker.fetch(new Request('https://api.test/api/contacts'),badScope);
    assert.equal(scopeClosed.status,503);
  } finally { restore(); }
});

test('Access JWT signature, issuer, audience, email, and expiry are enforced independently', async () => {
  const good=accessToken(), {env,restore}=authenticatedEnv(good);
  try {
    const ok=await worker.fetch(request(good,'/api/contacts'),env); assert.equal(ok.status,200);
    for(const claims of [
      {email:'attacker@example.com'},
      {aud:['wrong-application-audience']},
      {iss:'https://untrusted.example'},
      {exp:Math.floor(Date.now()/1000)-5},
    ]) {
      const bad=await worker.fetch(request(good,'/api/contacts','GET',undefined,'',ORIGIN,good.makeToken(claims)),env);
      assert.equal(bad.status,401,JSON.stringify(claims));
    }
    const malformed=good.token.slice(0,-8)+'invalid!';
    const signatureFailure=await worker.fetch(request(good,'/api/contacts','GET',undefined,'',ORIGIN,malformed),env);
    assert.equal(signatureFailure.status,401);
  } finally { restore(); }
});

test('contact creation accepts multiple labeled phones atomically and rejects repeated phone values', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  try {
    const response=await worker.fetch(request(auth,'/api/contacts','POST',{name:'عميل اختبار',phones:[
      {phone:'01012345678',label:'أساسي',is_primary:true},
      {phone:'+20 100 555 6677',label:'عمل'},
    ]},'multi-phone-contact-request-01'),env);
    const body=await response.json(); assert.equal(response.status,201); assert.equal(body.phone_count,2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contact_phones').get().n,2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contact_phones WHERE is_primary=1').get().n,1);
    const duplicate=await worker.fetch(request(auth,'/api/contacts','POST',{name:'مكرر',phones:[{phone:'01022223333'},{phone:'+20 10 2222 3333'}]},'multi-phone-contact-request-02'),env);
    assert.equal(duplicate.status,400);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,1);
  } finally { restore(); }
});

test('customer creation and phone methods are separate; one customer can have several phone numbers', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  try {
    const created=await worker.fetch(request(auth,'/api/contacts','POST',{name:'عميل بلا رقم'},'contact-request-identifier-0001'),env);
    const {contact_id}=await created.json(); assert.equal(created.status,201);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contact_phones').get().n,0);
    const added=await worker.fetch(request(auth,`/api/contacts/${contact_id}/phones`,'POST',{phone:'01012345678',label:'هاتف أساسي'}),env);
    assert.equal(added.status,200);
    const second=await worker.fetch(request(auth,`/api/contacts/${contact_id}/phones`,'POST',{phone:'+20 100 555 6677',label:'هاتف بديل'}),env);
    assert.equal(second.status,200);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contact_phones WHERE contact_id=?').get(contact_id).n,2);
    const listed=await worker.fetch(request(auth,'/api/contacts?q=عميل'),env);
    const result=await listed.json(); assert.equal(result.contacts[0].phone_numbers.split(',').length,2);
    const detail=await worker.fetch(request(auth,`/api/contacts/${contact_id}`),env);
    const profile=await detail.json(); assert.equal(profile.phones.length,2); assert.equal(profile.opportunities.length,0);
  } finally { restore(); }
});

test('CRM static assets are served only after the same Access JWT gate as API routes', async () => {
  const auth=accessToken(), {env,restore}=authenticatedEnv(auth);
  env.ASSETS={fetch:async request=>new Response(`private asset ${new URL(request.url).pathname}`,{headers:{'content-type':'text/html'}})};
  try {
    const denied=await worker.fetch(new Request('https://api.test/crm.html'),env);
    assert.equal(denied.status,401);
    const allowed=await worker.fetch(request(auth,'/crm.html'),env);
    assert.equal(allowed.status,200); assert.match(await allowed.text(),/private asset \/crm.html/);
    assert.equal(allowed.headers.get('cache-control'),'private, no-store');
    assert.equal(allowed.headers.get('x-content-type-options'),'nosniff');
  } finally { restore(); }
});

test('local SQLite-backed D1 test double: opportunity submission batches customer, phone, opportunity, receipt, and activity', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  try {
    const response=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity('٠١٠١٢٣٤٥٦٧٨',{source_url:'https://nasr-realestate.github.io/opportunities.html'}),'opportunity-request-identifier-01'),env);
    const body=await response.json(); assert.equal(response.status,201);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT phone_key FROM crm_contact_phones').get().phone_key,'201012345678');
    assert.equal(db.sqlite.prepare('SELECT contact_id FROM crm_opportunities').get().contact_id,body.contact_id);
    assert.equal(db.sqlite.prepare('SELECT source_url FROM crm_opportunities').get().source_url,'','unknown site hostnames are not accepted');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_idempotency_receipts').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_activities').get().n,1);
  } finally { restore(); }
});

test('local SQLite-backed D1 test double: injected opportunity failure rolls back customer, phone, receipt, and activity', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  db.sqlite.exec(`CREATE TRIGGER fail_test_opportunity BEFORE INSERT ON crm_opportunities WHEN NEW.notes='force-test-failure' BEGIN SELECT RAISE(ABORT,'synthetic opportunity insert failure'); END;`);
  try {
    const response=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity('01022223333',{notes:'force-test-failure'}),'atomic-failure-request-identifier'),env);
    assert.equal(response.status,500);
    for(const table of ['crm_contacts','crm_contact_phones','crm_opportunities','crm_idempotency_receipts','crm_activities']) {
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,`${table} must roll back`);
    }
  } finally { restore(); }
});

test('multiple opportunities can belong to one customer; conflicting phone names require review', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  try {
    const first=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity(),'opportunity-request-identifier-02'),env);
    const firstBody=await first.json();
    const second=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity('01012345678',{intent:'rent'}),'opportunity-request-identifier-03'),env);
    const secondBody=await second.json(); assert.equal(second.status,201); assert.equal(secondBody.contact_id,firstBody.contact_id);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_opportunities').get().n,2);
    const conflict=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity('01012345678',{name:'اسم مختلف'}),'opportunity-request-identifier-04'),env);
    assert.equal(conflict.status,409); assert.equal((await conflict.json()).review_required,true);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_opportunities').get().n,2);
  } finally { restore(); }
});

test('property links and activity history use synthetic Nasr City listings only', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  db.sqlite.exec(`INSERT INTO areas(id,name_ar) VALUES(90001,'مدينة نصر - اختبار'),(99999,'خارج النطاق - اختبار');
    INSERT INTO sources(id,name) VALUES(9009,'مصدر اختباري');
    INSERT INTO listings(id,source_id,external_id,url,title,property_type,transaction_type,area_id,area_m2,price,observed_at)
      VALUES(77,9009,'synthetic-listing','/properties/synthetic','شقة اختبار','apartment','sale',90001,120,2500000,'2026-10-27'),
            (78,9009,'outside-listing','/properties/outside','خارج النطاق','apartment','sale',99999,120,2500000,'2026-10-27');`);
  try {
    const created=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity(),'listing-opportunity-request-01'),env);
    const {opportunity_id}=await created.json();
    const linked=await worker.fetch(request(auth,`/api/opportunities/${opportunity_id}/properties`,'POST',{external_id:'synthetic-listing',presentation_status:'viewing_scheduled',viewing_at:'2026-11-03T12:00:00Z',presented_price:2500000}),env);
    assert.equal(linked.status,200);
    assert.equal(db.sqlite.prepare('SELECT listing_id FROM crm_opportunity_properties').get().listing_id,77);
    const outside=await worker.fetch(request(auth,`/api/opportunities/${opportunity_id}/properties`,'POST',{external_id:'outside-listing'}),env);
    assert.equal(outside.status,404);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_opportunity_properties').get().n,1);
    const activity=await worker.fetch(request(auth,`/api/opportunities/${opportunity_id}/activities`,'POST',{activity_type:'note',summary:'تمت مراجعة العقار',status:'paused'}),env);
    assert.equal(activity.status,200);
    assert.equal(db.sqlite.prepare('SELECT status FROM crm_opportunities WHERE id=?').get(opportunity_id).status,'paused');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_activities WHERE opportunity_id=?').get(opportunity_id).n,3);
  } finally { restore(); }
});

test('active opportunities require a dated next action or an explicit exception before writes', async () => {
  const auth=accessToken(), {env,db,restore}=authenticatedEnv(auth);
  try {
    const response=await worker.fetch(request(auth,'/api/opportunities','POST',newOpportunity('01012345678',{next_action:'',next_followup_at:''}),'opportunity-request-identifier-05'),env);
    assert.equal(response.status,400);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n,0);
  } finally { restore(); }
});
