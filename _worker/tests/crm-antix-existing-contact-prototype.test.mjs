import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { applyExistingContactMarkerPrototype as apply } from '../crm-antix-existing-contact-prototype.js';

const phone = '+201111111111';
const evidence = { verifiedContactModifiedAt: '2026-11-12T10:00:00.000Z', processedAt: '2026-11-14T10:00:00.000Z', sourceRef: `antix-vcf-sha256:${'a'.repeat(64)}` };
async function setup(name = 'اسم اصطناعي') {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec('CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, area_id INTEGER, transaction_type TEXT, price REAL, observed_at TEXT)');
  for (const file of ['0001_crm_opportunities.sql', '0002_crm_internal_auth.sql', '0003_crm_push_notifications.sql', '0004_crm_tracks_core.sql', '0005_sync_audit_and_intelligence.sql'])
    sqlite.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO crm_contacts(id,name,updated_at) VALUES(?,?,?)').run('c',name,'2026-11-10T10:00:00.000Z');
  sqlite.prepare('INSERT INTO crm_contact_phones(id,contact_id,phone_key) VALUES(?,?,?)').run('p','c',phone.slice(1));
  const db = { prepare(sql) { return { bind(...args) { return { all: async () => ({ results: sqlite.prepare(sql).all(...args) }), run: () => sqlite.prepare(sql).run(...args) }; } }; },
    async batch(statements) { sqlite.exec('SAVEPOINT batch'); try { const rows = statements.map(s => s.run()); sqlite.exec('RELEASE batch'); return rows; } catch (err) { sqlite.exec('ROLLBACK TO batch'); sqlite.exec('RELEASE batch'); throw err; } } };
  return { db, sqlite };
}
const item = title => ({ selected_phone: phone, title });
const excluded = ['مثال محظور'];

test('adds a marker without replacing the name, records old and new values, and is repeat-safe', async () => {
  const { db, sqlite } = await setup();
  try {
    assert.deepEqual(await apply(db, item('🟡 اسم اصطناعي'), evidence, excluded), { outcome: 'marker_added' });
    assert.equal(sqlite.prepare('SELECT name FROM crm_contacts').get().name, '🟡 اسم اصطناعي');
    const audit = sqlite.prepare('SELECT action_type,old_value,new_value,source_ref FROM crm_contact_audit_log').get();
    assert.deepEqual({ ...audit }, { action_type: 'name_updated', old_value: 'اسم اصطناعي', new_value: '🟡 اسم اصطناعي', source_ref: evidence.sourceRef });
    assert.deepEqual(await apply(db, item('🟡 اسم اصطناعي'), evidence, excluded), { outcome: 'review' });
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contact_audit_log').get().n, 1);
  } finally { sqlite.close(); }
});

test('refuses conflicting names, old sources, exclusions and existing markers', async () => {
  for (const [owner, title, ev] of [
    ['اسم اصطناعي', '🔴 اسم آخر', evidence],
    ['اسم اصطناعي', '🔴 اسم اصطناعي', { ...evidence, verifiedContactModifiedAt: '2026-11-09T00:00:00.000Z' }],
    ['🟢 اسم اصطناعي', '🔴 اسم اصطناعي', evidence],
    ['اسم 🌀 اصطناعي', '🔴 اسم 🌀 اصطناعي', evidence],
    ['مثال محظور', '🔴 مثال محظور', evidence],
  ]) {
    const { db, sqlite } = await setup(owner);
    try {
      assert.deepEqual(await apply(db, item(title), ev, excluded), { outcome: 'review' });
      assert.equal(sqlite.prepare('SELECT name FROM crm_contacts').get().name, owner);
      assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contact_audit_log').get().n, 0);
    } finally { sqlite.close(); }
  }
});

test('a racing contact change is not overwritten or audited', async () => {
  const { db, sqlite } = await setup();
  try {
    const batch = db.batch;
    db.batch = async statements => { sqlite.prepare('UPDATE crm_contacts SET name=? WHERE id=?').run('اسم آخر', 'c'); return batch(statements); };
    assert.deepEqual(await apply(db, item('🔵 اسم اصطناعي'), evidence, excluded), { outcome: 'review' });
    assert.equal(sqlite.prepare('SELECT name FROM crm_contacts').get().name, 'اسم آخر');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contact_audit_log').get().n, 0);
  } finally { sqlite.close(); }
});

test('audit failure rolls the name update back and unverified source is refused', async () => {
  const { db, sqlite } = await setup();
  try {
    await assert.rejects(apply(db, item('✈️ اسم اصطناعي'), { ...evidence, verifiedContactModifiedAt: null }, excluded), /invalid-verified-evidence/);
    sqlite.exec("CREATE TRIGGER test_audit_fail BEFORE INSERT ON crm_contact_audit_log BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(apply(db, item('✈️ اسم اصطناعي'), evidence, excluded));
    assert.equal(sqlite.prepare('SELECT name FROM crm_contacts').get().name, 'اسم اصطناعي');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contact_audit_log').get().n, 0);
  } finally { sqlite.close(); }
});
