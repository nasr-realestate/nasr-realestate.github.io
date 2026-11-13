import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The orchestrator is stdlib-only Python; keep its safety tests in the normal npm gate.
test('antiX WhatsApp sync orchestrator safety tests', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/antix-wa-sync/tests', '-v'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr + result.stdout, /OK/);
});
