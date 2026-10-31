// Tests: حوكمة بيانات CRM ومجلد Google Drive وإحالة تعليمات الوكلاء
//
// يتحقق هذا الاختبار من:
//   1) وجود الوثيقة المرجعية CRM_DATA_GOVERNANCE.md وملف AGENTS.md في جذر المستودع،
//      وصحة جميع مسارات الإحالة النسبية بينهما.
//   2) التزام AGENTS.md بمبدأ المصدر المرجعي الواحد (إحالة مختصرة دون نسخ الوثيقة)
//      والإفصاح الصريح عن قيود التحميل التلقائي في البيئات المختلفة.
//   3) استيفاء CRM_DATA_GOVERNANCE.md لدورة العمل الإلزامية، وقواعد سلامة البيانات الـ12،
//      وحدود قواعد البيانات متطابقةً مع _worker/wrangler.crm.toml، ومخطط سجل معالجة الملفات
//      القابل للتنفيذ فعليًا على محرك SQLite/D1 وصيغة JSON القياسية.
//   4) خلو الوثيقتين من أي أسرار أو روابط Drive حية أو بيانات عملاء شخصية، واستثنائهما
//      في _config.yml من النشر كصفحات عامة على الموقع.
//
// التشغيل:
//   node --test scripts/tests/crm-data-governance.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const GOVERNANCE_PATH = path.join(REPO_ROOT, 'CRM_DATA_GOVERNANCE.md');
const AGENTS_PATH = path.join(REPO_ROOT, 'AGENTS.md');
const WRANGLER_CRM_PATH = path.join(REPO_ROOT, '_worker', 'wrangler.crm.toml');
const CONFIG_YML_PATH = path.join(REPO_ROOT, '_config.yml');

test('CRM_DATA_GOVERNANCE.md و AGENTS.md موجودان في جذر المستودع وبلا YAML front matter', () => {
  assert.ok(fs.existsSync(GOVERNANCE_PATH), 'CRM_DATA_GOVERNANCE.md غير موجود في جذر المستودع');
  assert.ok(fs.existsSync(AGENTS_PATH), 'AGENTS.md غير موجود في جذر المستودع');

  const gov = fs.readFileSync(GOVERNANCE_PATH, 'utf8');
  const agents = fs.readFileSync(AGENTS_PATH, 'utf8');

  assert.ok(!gov.startsWith('---'), 'CRM_DATA_GOVERNANCE.md يجب ألا يبدأ بـ front matter');
  assert.ok(!agents.startsWith('---'), 'AGENTS.md يجب ألا يبدأ بـ front matter');
  assert.ok(gov.length > 3000, 'CRM_DATA_GOVERNANCE.md مختصر أكثر من اللازم ولا يغطي السياسة كاملة');
});

test('AGENTS.md يحيل بمسار صحيح ومختصر إلى CRM_DATA_GOVERNANCE.md دون نسخها ويفصح عن قيود التحميل التلقائي', () => {
  const gov = fs.readFileSync(GOVERNANCE_PATH, 'utf8');
  const agents = fs.readFileSync(AGENTS_PATH, 'utf8');

  // جمع كل الروابط النسبية بصيغة Markdown داخل AGENTS.md والتحقق من وجود ملفاتها فعليًا
  const links = [...agents.matchAll(/\]\((\.\/[^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.includes('./CRM_DATA_GOVERNANCE.md'), 'AGENTS.md لا يتضمن رابطًا نسبيًا إلى ./CRM_DATA_GOVERNANCE.md');

  for (const rel of links) {
    const resolved = path.resolve(REPO_ROOT, rel);
    assert.ok(fs.existsSync(resolved), `مسار محال إليه في AGENTS.md غير موجود: ${rel}`);
  }

  // مبدأ المصدر المرجعي الواحد: AGENTS.md مختصر ولا ينسخ جدول السجل أو المتن الكامل
  assert.ok(agents.length < gov.length * 0.4, 'AGENTS.md طويل على نحو يخالف مبدأ الإحالة المختصرة والمصدر الواحد');
  assert.doesNotMatch(agents, /CREATE TABLE IF NOT EXISTS crm_drive_file_registry/, 'لا تنسخ مخطط الوثيقة داخل AGENTS.md');

  // الإفصاح الواضح عن عدم ضمان التحميل التلقائي في كل البيئات
  assert.match(agents, /لا يكون التحميل التلقائي مضمونًا|لا تُحمّل نص/);
});

test('CRM_DATA_GOVERNANCE.md يغطي اسم المجلد التاريخي والحالي، ودورة العمل، والقواعد الـ12، وحدود قواعد البيانات', () => {
  const gov = fs.readFileSync(GOVERNANCE_PATH, 'utf8');
  const wranglerCrm = fs.readFileSync(WRANGLER_CRM_PATH, 'utf8');

  // المصدر الأصلي وتطور اسمه
  assert.match(gov, /قائمة البيع/);
  assert.match(gov, /قاعده العملاء نظام CRM/);

  // مراحل دورة العمل الإلزامية وواجب الإفصاح عند غياب الاتصال
  assert.match(gov, /قبل التنفيذ/);
  assert.match(gov, /أثناء التنفيذ/);
  assert.match(gov, /بعد التنفيذ/);
  assert.match(gov, /الإفصاح/);

  // القواعد الإلزامية الـ12 مرقّمة بوضوح من 1 إلى 12 في قسم قواعد سلامة البيانات
  const rulesSection = gov.split('## 3. قواعد سلامة البيانات')[1]?.split('## 4.')[0] ?? '';
  assert.ok(rulesSection.length > 500, 'قسم قواعد سلامة البيانات مفقود أو ناقص');
  for (let n = 1; n <= 12; n += 1) {
    assert.match(rulesSection, new RegExp(`^${n}\\.\\s+\\*\\*`, 'm'), `القاعدة رقم ${n} مفقودة في قسم قواعد سلامة البيانات`);
  }

  // تطابق حدود البيئة مع ملف التكوين الفعلي _worker/wrangler.crm.toml
  assert.match(wranglerCrm, /name\s*=\s*"nasr-crm-api-test"/);
  assert.match(wranglerCrm, /database_name\s*=\s*"nasr-crm-test-db"/);
  assert.match(gov, /nasr-crm-api-test/);
  assert.match(gov, /nasr-crm-test-db/);
  assert.match(gov, /nasr-market-db/);
  assert.match(gov, /خارج نطاق إدارة CRM/);
});

test('مخطط سجل معالجة الملفات (SQL DDL + JSON) في CRM_DATA_GOVERNANCE.md صالح آليًا ويفرض قيود السلامة', () => {
  const gov = fs.readFileSync(GOVERNANCE_PATH, 'utf8');

  const sqlMatch = gov.match(/```sql\r?\n([\s\S]*?)```/);
  assert.ok(sqlMatch, 'مخطط SQL لسجل معالجة الملفات مفقود في CRM_DATA_GOVERNANCE.md');

  const jsonMatch = gov.match(/```json\r?\n([\s\S]*?)```/);
  assert.ok(jsonMatch, 'مثال JSON القياسي لسجل معالجة الملفات مفقود في CRM_DATA_GOVERNANCE.md');

  const parsedJson = JSON.parse(jsonMatch[1]);
  for (const requiredKey of [
    'drive_file_id',
    'file_name',
    'drive_path',
    'mime_type',
    'size_bytes',
    'drive_modified_time',
    'content_sha256',
    'last_processed_at',
    'processing_status',
    'extracted_records_count',
    'crm_deltas',
    'review_or_skip_reason',
    'crm_result_refs',
  ]) {
    assert.ok(Object.hasOwn(parsedJson, requiredKey), `حقل السجل القياسي مفقود في JSON: ${requiredKey}`);
  }

  // التحقق الفعلي من قابلية تنفيذ الـ DDL على SQLite/D1 وسلامة قيود CHECK
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sqlMatch[1]);
    db.prepare(`
      INSERT INTO crm_drive_file_registry (
        drive_file_id, file_name, original_file_name, drive_path, mime_type,
        file_category, size_bytes, drive_modified_time, content_sha256,
        last_processed_at, processing_status, extracted_records_count,
        contacts_added, phones_added, opportunities_added, conversations_added,
        review_or_skip_reason, crm_result_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsedJson.drive_file_id,
      parsedJson.file_name,
      parsedJson.original_file_name,
      parsedJson.drive_path,
      parsedJson.mime_type,
      parsedJson.file_category,
      parsedJson.size_bytes,
      parsedJson.drive_modified_time,
      parsedJson.content_sha256,
      parsedJson.last_processed_at,
      parsedJson.processing_status,
      parsedJson.extracted_records_count,
      parsedJson.crm_deltas.contacts_added,
      parsedJson.crm_deltas.phones_added,
      parsedJson.crm_deltas.opportunities_added,
      parsedJson.crm_deltas.conversations_added,
      parsedJson.review_or_skip_reason,
      JSON.stringify(parsedJson.crm_result_refs),
    );

    const stored = db.prepare('SELECT processing_status, size_bytes FROM crm_drive_file_registry WHERE drive_file_id = ?')
      .get(parsedJson.drive_file_id);
    assert.equal(stored.processing_status, 'processed');
    assert.equal(stored.size_bytes, 184320);

    // رفض حالة معالجة غير معرّفة أو بصمة SHA-256 غير صالحة
    assert.throws(() => {
      db.prepare(`
        INSERT INTO crm_drive_file_registry (
          drive_file_id, file_name, mime_type, file_category, drive_modified_time, processing_status
        ) VALUES ('bad_status', 'x.vcf', 'text/x-vcard', 'vcf', '2026-10-31T00:00:00Z', 'invented_status')
      `).run();
    });
    assert.throws(() => {
      db.prepare(`
        INSERT INTO crm_drive_file_registry (
          drive_file_id, file_name, mime_type, file_category, drive_modified_time, content_sha256
        ) VALUES ('bad_hash', 'x.vcf', 'text/x-vcard', 'vcf', '2026-10-31T00:00:00Z', 'NOT_A_VALID_SHA256')
      `).run();
    });
  } finally {
    db.close();
  }
});

test('خلو الوثيقتين من الأسرار وروابط Drive الحية وأرقام الهواتف، واستثناؤهما من النشر العام في _config.yml', () => {
  for (const filePath of [GOVERNANCE_PATH, AGENTS_PATH]) {
    const content = fs.readFileSync(filePath, 'utf8');
    const name = path.basename(filePath);
    assert.ok(!content.toLowerCase().includes('drive.google.com/drive/folders/'), `${name}: يتضمن رابط مجلد Google Drive حي`);
    assert.ok(!content.toLowerCase().includes('@gmail.com'), `${name}: يتضمن بريد Gmail شخصي`);
    assert.doesNotMatch(content, /\b(?:\+20|0)1[0125]\d{8}\b/, `${name}: يتضمن رقم هاتف محمول مصري`);
    assert.doesNotMatch(content, /pbkdf2-sha256\$|ya29\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+/, `${name}: يتضمن سرًا أو رمز وصول`);
  }

  const configLines = fs.readFileSync(CONFIG_YML_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.ok(configLines.includes('- AGENTS.md'), 'AGENTS.md غير مستبعد في _config.yml');
  assert.ok(configLines.includes('- CRM_DATA_GOVERNANCE.md'), 'CRM_DATA_GOVERNANCE.md غير مستبعد في _config.yml');
});
