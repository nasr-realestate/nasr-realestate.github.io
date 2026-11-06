// Tests: ثابت واحد للقاعدة، أو لا شيء (2026-11-06).
//
// لماذا: بعد بناء `nasr-crm-test-db-v2` صار في المستودع ثابتان — القديم والجديد — وأي ملف يبقى على
// القديم سيكتب في قاعدة لم تعد هدفًا (أو يقرأ صفوفًا لن تُثبت أبدًا). هذه الاختبارات تجعل التباعد
// مستحيلًا: التكوين هو المصدر، وكل سير عمل وكل ثابت A5 يجب أن يطابقه. والاستثناء الوحيد مُعلَن
// صراحةً: سير التجهيز يقرأ صف المفتاح العام من القاعدة القديمة، فوجوده هناك مقصود.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DB_NAME, TEST_DB_UUID, PROD_DB_UUID } from '../a5-live-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const LEGACY_UUID = '65bfcb14-4b48-423b-916f-00eefdb9ae1e';
const PROVISION = '.github/workflows/crm-d1-provision-v2.yml';
const workflowFiles = readdirSync(path.join(ROOT, '.github', 'workflows'))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => path.join('.github', 'workflows', name));

test('the pinned config is the single source for the test database identity', () => {
  const config = read('_worker/wrangler.crm.toml');
  const name = /database_name\s*=\s*"([^"]+)"/.exec(config)?.[1];
  const uuid = /database_id\s*=\s*"([^"]+)"/.exec(config)?.[1];
  assert.equal(name, TEST_DB_NAME);
  assert.equal(uuid, TEST_DB_UUID);
  assert.notEqual(uuid, PROD_DB_UUID, 'the test database must never be production');
  assert.notEqual(uuid, LEGACY_UUID, 'the pinned database must be the new one, not the retired one');
});

test('no workflow or script still targets the retired database, except the declared reader', () => {
  const offenders = [];
  for (const file of workflowFiles) {
    const text = read(file);
    if (!text.includes(LEGACY_UUID)) continue;
    if (file.split(path.sep).join('/') !== PROVISION) offenders.push(file);
    // In the provisioning file it may only appear as the read-only source of the ingest key row.
    for (const line of text.split('\n')) {
      if (!line.includes(LEGACY_UUID)) continue;
      assert.match(line, /OLD_DB_UUID/, `the retired uuid must only live in OLD_DB_UUID: ${line.trim()}`);
    }
  }
  for (const file of ['scripts/a5-l2.mjs', 'scripts/a5-live-support.mjs', '_worker/crm-push.js',
    '_worker/crm-drive-file-registry.js', 'scripts/crm/build-review-case-register.mjs',
    'scripts/crm/drive-intake-discovery.mjs']) {
    assert.ok(!read(file).includes(LEGACY_UUID), `${file} still points at the retired database`);
  }
  assert.deepEqual(offenders, [], 'only the provisioning workflow may mention the retired uuid');
});

test('every workflow that pins a test uuid pins the same one', () => {
  const mismatched = [];
  for (const file of workflowFiles) {
    const text = read(file);
    for (const match of text.matchAll(/TEST_DB_UUID:\s*([0-9a-f-]{36})/g)) {
      if (match[1] !== TEST_DB_UUID) mismatched.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test('a stale database name cannot survive the rename', () => {
  // `nasr-crm-test-db` is a prefix of the new name, so a naive rename leaves both spellings valid.
  // Real backup databases (`-backup-…`) legitimately keep the old prefix and are excluded here.
  const stale = /nasr-crm-test-db(?!-v2|-backup-|-not-verified)/;
  const offenders = [];
  for (const file of workflowFiles) {
    if (stale.test(read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'these workflows still name the retired database as a target');
});

test('the rename never produced a doubled suffix', () => {
  const doubled = [];
  for (const file of [...workflowFiles, '_worker/wrangler.crm.toml', 'scripts/a5-live-support.mjs']) {
    if (read(file).includes('-v2-v2') || read(file).includes('nasr-crm-test-db-v2-v2')) doubled.push(file);
  }
  assert.deepEqual(doubled, []);
});
