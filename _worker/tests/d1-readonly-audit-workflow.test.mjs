import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../.github/workflows/d1-readonly-audit.yml', import.meta.url), 'utf8');
test('D1 audit is manually runnable and its one-time branch trigger is narrow', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches:\s*\n\s*- arena\/7414ed79-nasr-realestate-github-io/);
  assert.match(workflow, /paths:\s*\n\s*- \.github\/workflows\/d1-readonly-audit\.yml/);
  assert.match(workflow, /secrets\.ARENA_CLOUDFLARE_TOKEN/);
});
test('the only database operation queries schema metadata, not customer rows', () => {
  assert.match(workflow, /SELECT type, name, tbl_name, sql FROM sqlite_schema/);
  assert.match(workflow, /type IN \('table','index','view','trigger'\)/);
  assert.doesNotMatch(workflow, /INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE/i);
});
test('schema output is encrypted before an expiring artifact upload and no token is printed', () => {
  assert.match(workflow, /createCipheriv\('aes-256-gcm'/);
  assert.match(workflow, /publicEncrypt/);
  assert.match(workflow, /retention-days: 1/);
  assert.match(workflow, /fs\.rmSync\('\/tmp\/d1-schema\.json'/);
  assert.doesNotMatch(workflow, /echo .*\$\{?CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /echo .*\$AUTH/);
});
