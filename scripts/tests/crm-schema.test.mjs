import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const migration = await readFile(new URL('../../_worker/migrations/0001_crm_opportunities.sql', import.meta.url), 'utf8');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, area_id INTEGER, price REAL, FOREIGN KEY(area_id) REFERENCES areas(id));
    CREATE TABLE price_snapshots (id INTEGER PRIMARY KEY, area_id INTEGER, median_price_m2 REAL, FOREIGN KEY(area_id) REFERENCES areas(id));
    CREATE TABLE ingestion_runs (id INTEGER PRIMARY KEY, source_id INTEGER, status TEXT);
    CREATE TABLE properties_sync_state (source_id INTEGER, external_id TEXT, last_synced_at TEXT, PRIMARY KEY(source_id, external_id));`);
  return db;
}
function errorOf(fn) { try { fn(); return null; } catch (e) { return e; } }

test('CRM migration is additive and leaves every pre-existing market/valuation table unchanged', () => {
  const db = fixture();
  const before = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  db.exec(migration);
  const after = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'crm_%' ORDER BY name").all();
  assert.deepEqual(after, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'crm_%'").get().n, 6);
  db.close();
});

test('phone methods are separate from customers, unique across customers, and customers support multiple opportunities', () => {
  const db = fixture(); db.exec(migration);
  db.prepare('INSERT INTO crm_contacts(id, name) VALUES(?,?)').run('c1','Test Contact');
  db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,is_primary) VALUES(?,?,?,1)').run('p1','c1','201012345678');
  db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES(?,?,?)').run('p2','c1','201055566677');
  const opp = db.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,next_action,next_followup_at)
    VALUES(?,?,?,?,?,?)`);
  opp.run('o1','c1','buy','call','Send suitable listings','2026-11-01T10:00:00Z');
  opp.run('o2','c1','rent','whatsapp','Call about rent','2026-11-02T10:00:00Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_opportunities WHERE contact_id=?').get('c1').n,2);
  db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').run('c2','Other Contact');
  assert.ok(errorOf(()=>db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES(?,?,?)').run('p3','c2','201012345678')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_contact_phones WHERE contact_id=?').get('c1').n,2);
  assert.ok(errorOf(()=>db.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key,is_primary) VALUES(?,?,?,1)').run('p4','c1','201077788899')));
  db.close();
});

test('active pipeline items require a dated next action or an explicit no-follow-up reason', () => {
  const db = fixture(); db.exec(migration);
  db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').run('c1','Test Contact');
  const base = db.prepare('INSERT INTO crm_opportunities(id,contact_id,intent,source,status) VALUES(?,?,?,?,?)');
  assert.ok(errorOf(()=>base.run('bad','c1','buy','call','active')));
  db.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,status,no_followup_reason) VALUES(?,?,?,?,?,?)`)
    .run('ok','c1','buy','call','active','العميل طلب عدم التواصل حتى يرسل مواعدته');
  assert.ok(errorOf(()=>db.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,status,closed_at) VALUES(?,?,?,?,?,?)`).run('lost-bad','c1','buy','call','lost','2026-10-27T12:00:00Z')));
  db.close();
});

test('City scope, lost reason, follow-up due lists, and listing links are constrained', () => {
  const db = fixture(); db.exec(migration);
  db.prepare('INSERT INTO sources(id,name) VALUES(1,?)').run('fixture');
  db.prepare('INSERT INTO areas(id,name_ar) VALUES(1,?)').run('مدينة نصر');
  db.prepare('INSERT INTO listings(id,source_id,area_id,price) VALUES(1,1,1,1000000)').run();
  db.prepare('INSERT INTO crm_contacts(id,name) VALUES(?,?)').run('c1','Test Contact');
  const add = db.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,status,next_action,next_followup_at,closed_at,loss_reason)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  add.run('due','c1','buy','website','active','Call back','2026-10-27T10:00:00Z',null,null);
  add.run('overdue','c1','rent','call','active','Send options','2026-10-20T10:00:00Z',null,null);
  add.run('won','c1','sell','referral','won',null,null,'2026-10-27T12:00:00Z',null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_opportunities WHERE status IN ('active','visit_scheduled','viewing_done','offer','negotiating','near_close') AND next_followup_at <= ?").get('2026-10-27T23:59:59Z').n,2);
  assert.ok(errorOf(()=>db.prepare(`INSERT INTO crm_opportunities(id,contact_id,city,intent,source,status,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?,?)`).run('out','c1','القاهرة الجديدة','buy','call','active','call','2026-10-30T10:00:00Z')));
  assert.ok(errorOf(()=>db.prepare(`INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id) VALUES(?,?,?)`).run('link','due',999)));
  db.prepare(`INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id,presented_price) VALUES(?,?,?,?)`).run('link','due',1,900000);
  db.prepare(`INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id,presentation_status,presented_price) VALUES(?,?,?,?,?)`).run('link2','due',1,'viewed',875000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_opportunity_properties WHERE opportunity_id=? AND listing_id=?').get('due',1).n,2);
  assert.equal(db.prepare('SELECT listing_id FROM crm_opportunity_properties WHERE opportunity_id=?').get('due').listing_id,1);
  db.close();
});
