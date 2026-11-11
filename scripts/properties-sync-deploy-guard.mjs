#!/usr/bin/env node
// Prevent a classification-only workflow edit from deploying a Worker or syncing D1.
// An explicit bootstrap marker is needed once while installing this guard itself.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const workflow = '.github/workflows/deploy-properties-sync.yml';
const workerPaths = new Set([
  '_worker/properties-sync-worker.js',
  '_worker/tests/properties-sync.test.mjs',
  '_worker/wrangler.sync.toml',
]);
const classificationKeys = ['IN_SCOPE_IDS', 'OUT_OF_SCOPE_IDS', 'INVALID_IDS', 'NULL_AREA_IDS'];
const normalize = (s) => s.split('\n').map((line) => {
  const trimmed = line.trimStart();
  const key = classificationKeys.find((k) => trimmed.startsWith(`${k}: "`) && trimmed.endsWith('"'));
  return key ? `${line.slice(0, line.length - trimmed.length)}${key}: "<classification>"` : line;
}).join('\n');
export function decide({ event, files, beforeWorkflow, afterWorkflow, bootstrap }) {
  if (event === 'workflow_dispatch') return 'run';
  if (event !== 'push') throw new Error('Unexpected event; refusing to deploy');
  if (files.some(f => workerPaths.has(f))) {
    if (bootstrap) throw new Error('Bootstrap marker with Worker changes; refusing to deploy');
    return 'run';
  }
  if (!files.includes(workflow)) throw new Error('Unexpected push scope; refusing to deploy');
  if (bootstrap || normalize(beforeWorkflow) === normalize(afterWorkflow)) return 'skip';
  return 'run';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { EVENT_NAME: event, BEFORE_SHA: before, AFTER_SHA: after, COMMIT_MESSAGE: message = '' } = process.env;
    if (event === 'workflow_dispatch') { console.log('run'); process.exit(0); }
    if (!/^[0-9a-f]{40}$/.test(before || '') || /^0+$/.test(before) || !/^[0-9a-f]{40}$/.test(after || '')) throw new Error('Missing valid push revisions; refusing to deploy');
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
    const files = git('diff', '--name-only', before, after).split('\n').filter(Boolean);
    const bootstrap = message.includes('[skip-properties-sync-bootstrap]');
    const beforeWorkflow = git('show', `${before}:${workflow}`);
    const afterWorkflow = git('show', `${after}:${workflow}`);
    console.log(decide({ event, files, beforeWorkflow, afterWorkflow, bootstrap }));
  } catch (error) { console.error(error.message); process.exit(1); }
}
