// Tests: migration 0015 (الشوارع كمناطق) — تُنفَّذ على SQLite حقيقي
//
// هذا الملف يختبر الـSQL نفسه لا الكود الـJS. الحاجة: migration يأمر قاعدة
// حيّة؛ خطأ فيه يُلوّث جدول areas ولا رجعة سهلة.
//
// ⚠️ لا يلمس أي قاعدة حقيقية. يبني SQLite مؤقتًا بنفس مخطط areas المقيس من
//    sqlite_master (run 44197828562) وينفّذ الـmigration عليه.
//    يستخدم node:sqlite المدمج — بلا اعتماد خارجي ولا ثنائي مثبَّت.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// مسوّدة لا هجرة معتمدة: هذا الملف لقاعدة السوق (nasr-market-db)، و_worker/migrations
// مخصّص لهجرات قاعدة CRM التي يطبّقها wrangler d1 migrations apply على المجلد كاملًا.
// وضعه هناك كان سيطبّق ALTER TABLE areas على قاعدة CRM (لا يوجد فيها areas) — عيب مقيس.
const MIGRATION = path.join(ROOT, '_worker', 'migrations-draft', '0015_areas_streets.sql');

/** المخطط الحقيقي كما قُرئ من sqlite_master — لا كما نفترضه. */
const AREAS_SCHEMA = `CREATE TABLE areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL UNIQUE,
  name_en TEXT,
  level TEXT,
  level_ar TEXT,
  description TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  area_type TEXT NOT NULL DEFAULT 'neighborhood'
)`;

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync ? false : 'node:sqlite غير متاح في هذه النسخة';

/** قاعدة مؤقتة + المناطق الـ31 الأصلية كما هي في الإنتاج. */
function makeDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'areas15-')), 't.db');
  const db = new DatabaseSync(file);
  db.exec(AREAS_SCHEMA);
  for (let i = 1; i <= 31; i += 1) db.exec(`INSERT INTO areas (name_ar) VALUES ('منطقة ${i}');`);
  return db;
}

const migrationSql = () => fs.readFileSync(MIGRATION, 'utf8');

/** الـSQL بلا تعليقات — للفحص النصي. */
const migrationBody = () => migrationSql()
  .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('migration 0015: موجود ويحمل إدراجًا فقط (لا حذف ولا تعديل)', () => {
  const body = migrationBody();
  for (const forbidden of ['DELETE ', 'DROP ', 'UPDATE ']) {
    assert.ok(!body.includes(forbidden), `migration يحمل ${forbidden}`);
  }
  assert.match(body, /INSERT INTO areas/);
  // ALTER واحد مسموح: إضافة عمود أنماط المطابقة
  assert.equal((body.match(/ALTER TABLE/g) || []).length, 1);
  assert.match(body, /ADD COLUMN zone_patterns/);
});

test('migration 0015: يضيف الشوارع الثلاثة بمعرّفات 32+', { skip }, () => {
  const db = makeDb();
  db.exec(migrationSql());
  const rows = db.prepare("SELECT id, name_ar, level, area_type, zone_patterns FROM areas WHERE level = 'street' ORDER BY id;").all();
  assert.equal(rows.length, 3, `أُضيف ${rows.length} شارعًا لا 3`);
  assert.deepEqual(rows.map((r) => r.name_ar), ['حسن المأمون', 'مصطفى النحاس', 'شارع الطيران']);
  // المعرّفات تبدأ بعد 31 — لم تُكتب يدويًا بل منحها AUTOINCREMENT
  assert.deepEqual(rows.map((r) => Number(r.id)), [32, 33, 34]);
  assert.ok(rows.every((r) => r.area_type === 'street'));
  // كل شارع يحمل نمطًا واحدًا على الأقل — «شارع الطيران» نمط واحد بلا «|»
  assert.ok(rows.every((r) => r.zone_patterns && r.zone_patterns.trim().length > 0));
  assert.ok(rows.every((r) => r.zone_patterns.split('|').every((x) => x.trim().length > 0)));
});

test('migration 0015: آمن للتكرار — الإدراج مشروط بـNOT EXISTS', { skip }, () => {
  const db = makeDb();
  db.exec(migrationSql());
  const first = Number(db.prepare('SELECT COUNT(*) AS n FROM areas;').get().n);

  // تشغيل الإدراجات مرة أخرى كما يفعل مشغّل واعٍ (ALTER يُتخطى لأنه موجود)
  const insertsOnly = migrationBody()
    .split('\n').filter((l) => !l.trim().startsWith('ALTER')).join('\n');
  db.exec(insertsOnly);

  const second = Number(db.prepare('SELECT COUNT(*) AS n FROM areas;').get().n);
  assert.equal(second, first, 'التشغيل الثاني أضاف صفًا — الإدراج ليس مشروطًا');
});

test('migration 0015: لا يمسّ الصفوف الـ31 الموجودة', { skip }, () => {
  const db = makeDb();
  const before = JSON.stringify(db.prepare('SELECT id, name_ar FROM areas ORDER BY id;').all());
  db.exec(migrationSql());
  const after = JSON.stringify(db.prepare('SELECT id, name_ar FROM areas WHERE id <= 31 ORDER BY id;').all());
  assert.equal(after, before, 'الصفوف الأصلية تغيّرت');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM areas;').get().n), 34);
});

test('migration 0015: أسماء الشوارع مطابقة تمامًا لما في العروض', () => {
  // لو تغيّر الاسم حرفًا واحدًا لن تُطابق أي عرض ولن تُنتج الصفوف الموعودة.
  const sql = migrationSql();
  for (const name of ['حسن المأمون', 'مصطفى النحاس', 'شارع الطيران']) {
    assert.ok(sql.includes(`'${name}'`), `الاسم «${name}» غير موجود في الـmigration`);
  }
});

test('migration 0015: الأنماط تُطابق فعليًا نصوص zone في العروض', async () => {
  if (skip) return;
  const db = makeDb();
  db.exec(migrationSql());
  const areas = db.prepare('SELECT id, name_ar, zone_patterns FROM areas WHERE zone_patterns IS NOT NULL;').all();

  const { useAreas, resolveAreaId } = await import('../crm/price-snapshot-candidates.mjs');
  useAreas(areas);

  // نصوص zone الحقيقية من _properties كما كُتبت
  assert.equal(resolveAreaId('حسن المأمون')?.id, Number(areas.find((a) => a.name_ar === 'حسن المأمون').id));
  assert.equal(resolveAreaId('مصطفى النحاس')?.id, Number(areas.find((a) => a.name_ar === 'مصطفى النحاس').id));
  assert.equal(resolveAreaId('شارع الطيران')?.id, Number(areas.find((a) => a.name_ar === 'شارع الطيران').id));
  // نص غريب لا يُقرب إلى شارع
  assert.equal(resolveAreaId('كمبوند حياة'), null);
});

// ═══════════════════════════════════════════════════════════════
//  تقسيم الجمل — العيب الذي أوقف أول dry_run
// ═══════════════════════════════════════════════════════════════
//  التقسيم السابق بـawk RS=";" كسر كل INSERT متعدد الأسطر إلى ثلاثة أجزاء
//  (INSERT… / SELECT… / WHERE…): 13 جملة بدل 4. تنفيذ الأجزاء منفصلة على
//  قاعدة الإنتاج كان سيولّد SQL مبتورًا. هذه الاختبارات تمنع رجوعه.

test('تقسيم المسوّدة: 4 جمل سليمة لا 13 جزءًا مبتورًا', async () => {
  const { splitStatements } = await import('../lib/sql-split.mjs');
  const stmts = splitStatements(migrationSql());
  assert.equal(stmts.length, 4, `عدد الجمل ${stmts.length} لا 4 — التقسيم انكسر`);
  assert.match(stmts[0], /^ALTER TABLE areas ADD COLUMN zone_patterns TEXT$/);
  for (const s of stmts.slice(1)) {
    // كل إدراج جملة كاملة: INSERT + SELECT + WHERE NOT EXISTS
    assert.match(s, /^INSERT INTO areas/);
    assert.match(s, /WHERE NOT EXISTS \(SELECT 1 FROM areas WHERE name_ar = '/);
    // ولا جزء مبتور
    assert.ok(!/^\s*$/.test(s));
  }
});

test('الـmigration المقسَّم يُنفَّذ فعلًا على SQLite (لا أجزاء مبتورة)', async () => {
  if (skip) return;
  const { splitStatements } = await import('../lib/sql-split.mjs');
  const db = makeDb();
  for (const stmt of splitStatements(migrationSql())) db.exec(stmt);
  const streets = db.prepare("SELECT name_ar FROM areas WHERE level='street' ORDER BY id;").all();
  assert.deepEqual(streets.map((r) => r.name_ar), ['حسن المأمون', 'مصطفى النحاس', 'شارع الطيران']);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM areas;').get().n), 34);
});

test('تقسيم: يحترم الفاصلة المنقوطة داخل النص العربي', async () => {
  const { splitStatements } = await import('../lib/sql-split.mjs');
  const sql = "INSERT INTO t (a) SELECT 'نص; يحمل فاصلة'\nWHERE NOT EXISTS (SELECT 1);\n";
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 1, 'انقسم عند فاصلة داخل النص');
  assert.match(stmts[0], /نص; يحمل فاصلة/);
});
