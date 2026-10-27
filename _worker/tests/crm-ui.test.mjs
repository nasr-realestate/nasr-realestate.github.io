import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CRMApiError, CRMClient } from '../crm-ui/crm-client.js';

function jsonResponse(payload, status=200) {
  return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json; charset=utf-8'}});
}
function fakeFetch(response=jsonResponse({ok:true})) {
  const calls=[];
  const fetchImpl=async (url,init)=>{calls.push({url,init});return typeof response==='function'?response(url,init):response;};
  return {calls,fetchImpl};
}

test('CRM client only accepts same-origin relative API bases', () => {
  assert.doesNotThrow(()=>new CRMClient({apiBase:'/api/v2',fetchImpl:async()=>jsonResponse({})}));
  for(const apiBase of ['https://other.example/api','//other.example/api','/api?token=x','/api#fragment']) {
    assert.throws(()=>new CRMClient({apiBase,fetchImpl:async()=>jsonResponse({})}),error=>error instanceof CRMApiError&&error.kind==='configuration');
  }
});

test('client sends no-store same-origin requests and encodes search parameters', async () => {
  const fake=fakeFetch(jsonResponse({contacts:[]})), api=new CRMClient({fetchImpl:fake.fetchImpl});
  await api.searchContacts('اسم + رقم');
  assert.equal(fake.calls[0].url,'/api/contacts?q=%D8%A7%D8%B3%D9%85%20%2B%20%D8%B1%D9%82%D9%85');
  assert.equal(fake.calls[0].init.credentials,'same-origin');
  assert.equal(fake.calls[0].init.cache,'no-store');
  assert.equal(fake.calls[0].init.headers.accept,'application/json');
});

test('customer submission supports explicit multi-phone data and idempotency without importing phonebook data', async () => {
  const fake=fakeFetch(jsonResponse({contact_id:'12345678'})), api=new CRMClient({fetchImpl:fake.fetchImpl});
  const customer={name:'عميل اختباري',phones:[{phone:'01012345678',label:'أساسي',is_primary:true},{phone:'01022223333',label:'عمل',is_primary:false}],communication_consent:'request_only'};
  await api.createContact(customer,'manual-entry-key-0001');
  const call=fake.calls[0];
  assert.equal(call.url,'/api/contacts'); assert.equal(call.init.method,'POST');
  assert.equal(call.init.headers['idempotency-key'],'manual-entry-key-0001');
  assert.deepEqual(JSON.parse(call.init.body),customer);
  assert.equal(call.init.headers.authorization,undefined);
});

test('API response categories distinguish authentication, conflicts, configuration, validation, and server failures', async () => {
  const cases=[[401,'authentication'],[403,'authentication'],[409,'conflict'],[503,'configuration'],[422,'validation'],[500,'server']];
  for(const [status,kind] of cases) {
    const api=new CRMClient({fetchImpl:async()=>jsonResponse({error:'fixture'},status)});
    await assert.rejects(()=>api.getDashboard(),error=>error instanceof CRMApiError&&error.status===status&&error.kind===kind);
  }
  const htmlApi=new CRMClient({fetchImpl:async()=>new Response('<html>access login</html>',{status:200,headers:{'content-type':'text/html'}})});
  await assert.rejects(()=>htmlApi.getDashboard(),error=>error.kind==='authentication');
  const offlineApi=new CRMClient({fetchImpl:async()=>{throw new TypeError('offline');}});
  await assert.rejects(()=>offlineApi.getDashboard(),error=>error.kind==='offline');
});

test('opportunity, follow-up, and property methods map to the protected CRM API routes', async () => {
  const fake=fakeFetch(url=>jsonResponse({url})), api=new CRMClient({fetchImpl:fake.fetchImpl});
  await api.createOpportunity({contact_id:'12345678',intent:'rent'},'opportunity-key-00001');
  await api.addActivity('12345678',{activity_type:'call',summary:'متابعة'});
  await api.searchListings('الحي العاشر');
  await api.linkProperty('12345678',{external_id:'synthetic-property'});
  assert.equal(fake.calls[0].url,'/api/opportunities');
  assert.equal(fake.calls[0].init.headers['idempotency-key'],'opportunity-key-00001');
  assert.equal(fake.calls[1].url,'/api/opportunities/12345678/activities');
  assert.match(fake.calls[2].url,/^\/api\/listings\?q=/);
  assert.equal(fake.calls[3].url,'/api/opportunities/12345678/properties');
});

test('private UI is same-origin, noindex, API-configurable, and contains no local import/storage or HTML injection sinks', async () => {
  const [html,app]=await Promise.all([
    readFile(new URL('../crm-ui/crm.html',import.meta.url),'utf8'),
    readFile(new URL('../crm-ui/crm-assets/app.js',import.meta.url),'utf8'),
  ]);
  assert.match(html,/<html lang="ar" dir="rtl" data-crm-api="\/api">/);
  assert.match(html,/noindex,nofollow,noarchive,nosnippet/);
  assert.match(html,/connect-src 'self'/);
  assert.doesNotMatch(html,/type="file"|vcf|phonebook|دفتر محلي/);
  assert.doesNotMatch(app,/\b(?:localStorage|sessionStorage|indexedDB|FileReader|innerHTML)\b/);
  assert.match(app,/textContent/);
  assert.match(app,/createElement/);
  const clientRequestPath=new URL('../crm-client.js','https://crm.example/crm-assets/app.js').pathname;
  assert.equal(clientRequestPath,'/crm-client.js');
  await readFile(new URL('../crm-ui/crm-client.js',import.meta.url),'utf8');
});
