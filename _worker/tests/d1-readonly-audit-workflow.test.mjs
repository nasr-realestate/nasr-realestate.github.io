import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../.github/workflows/d1-readonly-audit.yml', import.meta.url), 'utf8');
test('D1 audit is manual, uses the protected secret, and issues schema-only SQL', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s{2}(push|pull_request):/);
  assert.match(workflow, /secrets\.ARENA_CLOUDFLARE_TOKEN/);
  assert.match(workflow, /sqlite_schema/);
  assert.match(workflow, /type IN \('table','index','view','trigger'\)/);
  assert.doesNotMatch(workflow, /INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE/i);
  assert.match(workflow, /set \+x/);
  assert.doesNotMatch(workflow, /echo .*\$\{?CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /echo .*\$AUTH/);
});
