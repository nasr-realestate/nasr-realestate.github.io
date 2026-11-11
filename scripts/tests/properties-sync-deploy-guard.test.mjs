import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../properties-sync-deploy-guard.mjs';
const wf = '.github/workflows/deploy-properties-sync.yml';
const before = 'name: sync\n      IN_SCOPE_IDS: "a,b"\n';
const after = 'name: sync\n      IN_SCOPE_IDS: "a,b,c"\n';
test('classification-only changes skip the real sync', () => {
  assert.equal(decide({event:'push', files:[wf, '_properties/new.md'], beforeWorkflow:before, afterWorkflow:after}), 'skip');
});
test('worker and substantive workflow changes still deploy', () => {
  assert.equal(decide({event:'push', files:[wf,'_worker/properties-sync-worker.js'], beforeWorkflow:before, afterWorkflow:after}), 'run');
  assert.equal(decide({event:'push', files:[wf], beforeWorkflow:before, afterWorkflow:after+'# changed\n'}), 'run');
  assert.equal(decide({event:'workflow_dispatch'}), 'run');
});
test('one-time bootstrap skips only without Worker changes and fails closed', () => {
  assert.equal(decide({event:'push', files:[wf], beforeWorkflow:before, afterWorkflow:after+'guard', bootstrap:true}), 'skip');
  assert.throws(() => decide({event:'push', files:[wf,'_worker/wrangler.sync.toml'], bootstrap:true}));
  assert.throws(() => decide({event:'push', files:[], bootstrap:true}));
  assert.throws(() => decide({event:'other', files:[]}));
});
