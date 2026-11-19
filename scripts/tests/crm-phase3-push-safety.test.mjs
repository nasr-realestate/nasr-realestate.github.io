import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

const workflow = yaml.load(fs.readFileSync('.github/workflows/crm-phase3-registry.yml', 'utf8'));
test('Phase 3 push checks cannot reach the live D1 job or expose Cloudflare credentials', () => {
  const local = workflow.jobs['push-local-checks'];
  assert.equal(local.if, "github.event_name == 'push'");
  assert.ok(!local.environment && !local.env && !local.needs);
  assert.doesNotMatch(JSON.stringify(local.steps), /secrets\.|CLOUDFLARE|wrangler|https?:\/\//i);
  assert.match(JSON.stringify(local), /verify-phase3-metadata-boundary/);
  assert.match(JSON.stringify(local), /drive-registry-envelope/);
  const live = workflow.jobs['registry-phase3'];
  assert.equal(live.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(live.needs, 'authorize-live-phase3');
  assert.equal(live.environment, 'crm-test-deploy');
  const auth = workflow.jobs['authorize-live-phase3'];
  assert.equal(auth.if, "github.event_name == 'workflow_dispatch'");
  assert.match(JSON.stringify(auth), /refs\/heads\/master/);
  assert.match(JSON.stringify(auth), /RUN-PHASE3-LIVE-MIGRATION-AND-SYNC/);
  assert.equal(workflow.on.workflow_dispatch.inputs.authorize_live_phase3.required, true);
  for (const id of ['p3-r1', 'p3-r2', 'p3-r3', 'p3-r4', 'p3-r5', 'p3-r6']) {
    assert.match(workflow.jobs[id].if, /github\.event_name == 'workflow_dispatch'/);
  }
});
