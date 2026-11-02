// Why a workflow file gets refused before it runs.
//
// On 2026-11-02, `crm-phase2-backup.yml` produced run 41517416869: status failure, zero jobs, zero
// check runs, created_at == updated_at, and the run named by its file path. The annotation, visible only
// in the Actions UI, was:
//
//   (Line: 58, Col: 14): Exceeded max expression length 21000
//
// GitHub renders any string property that contains `${{` through the expression engine, and that
// rendered property is capped at 21,000 characters — while a property with no expression in it is allowed
// far longer (the Phase 4 job's script is 43,195 characters and has always run). So a workflow stays
// editable for months, someone adds one `${{ inputs.x }}` inside a long `run:` block to save four lines,
// and from that commit the workflow cannot start at all. The failure looks like nothing: no log, no job,
// no check, and a CI-only workflow whose push filter names itself will not show the problem until the
// next time someone needs it — which, for the backup that has to run before a migration, is the worst
// possible moment to learn it.
//
// This test reads the raw YAML rather than parsing it: the assertion is about character counts of scalar
// blocks, and depending here on js-yaml (a transitive dep of eslint, not a declared one) would put a
// guardrail on a dependency that could disappear with the next lint upgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_EXPRESSION_PROP = 21000;   // GitHub's ceiling for a property that contains an expression
const MAX_WORKFLOW_BYTES = 65536;     // our own budget, not a GitHub rule (measured max today: 54,646)

// `run: |`, `env: |`, and the list form `      - run: |` — the leading dash is why the indent measured is
// the column of the dash, not of the key: block content is always deeper than both.
const BLOCK_PROP = /^([ \t]*)(?:-[ \t]*)?([A-Za-z0-9_.-]+):[ \t]*[|>][-+]?[0-9]*[ \t]*(?:#.*)?$/;

// Return a violation per property that carries an expression and is longer than the ceiling.
function findOverlongExpressionProps(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = BLOCK_PROP.exec(lines[i]);
    if (m) {
      const indent = m[1].length;
      const key = m[2];
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') { body.push(''); continue; }
        const lead = lines[j].match(/^[ \t]*/)[0].length;
        if (lead <= indent) break;
        body.push(lines[j]);
      }
      const value = body.join('\n');
      if (value.includes('${{') && value.length > MAX_EXPRESSION_PROP) {
        found.push({ line: i + 1, key, length: value.length });
      }
      i = j - 1;
      continue;
    }
    const one = /^[ \t]*(?:-[ \t]*)?([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (one && one[2] && one[2].includes('${{') && one[2].length > MAX_EXPRESSION_PROP) {
      found.push({ line: i + 1, key: one[1], length: one[2].length });
    }
  }
  return found;
}

test('no workflow property carries an expression past the length GitHub renders', () => {
  const dir = '.github/workflows';
  const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort();
  assert.ok(files.length >= 20, `expected the real workflow directory, found ${files.length} files`);
  const broken = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (Buffer.byteLength(text) > MAX_WORKFLOW_BYTES) broken.push(`${f}: file is over budget`);
    for (const hit of findOverlongExpressionProps(text)) {
      broken.push(`${f}: ${hit.key} at line ${hit.line} is ${hit.length} chars with an expression in it`);
    }
  }
  assert.deepEqual(broken, [], `these workflows cannot start:\n${broken.join('\n')}`);
});

test('the guard catches the shape that actually broke Phase 2, and only that shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-limit-'));
  try {
    // indented like real block content: a block scalar that dedents is not a long run, it is broken YAML
    const longRun = Array.from({ length: 4000 }, () => '          echo x').join('\n');
    assert.ok(longRun.length > MAX_EXPRESSION_PROP, 'the fixture must actually be over the ceiling');
    const fixture = [
      'name: broken',
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      `          v='\${{ github.event.inputs.x }}'`,
      longRun,
    ].join('\n');
    writeFileSync(join(dir, 'broken.yml'), fixture);
    const hits = findOverlongExpressionProps(readFileSync(join(dir, 'broken.yml'), 'utf8'));
    assert.equal(hits.length, 1, 'one over-long expression-bearing run block, one finding');
    assert.equal(hits[0].key, 'run');
    assert.ok(hits[0].length > MAX_EXPRESSION_PROP, 'the length reported is the block, not the line');

    // the same script without the expression is legal at any length — that is why Phase 4 runs at 43k
    writeFileSync(join(dir, 'ok-long.yml'), fixture.replace(`          v='\${{ github.event.inputs.x }}'\n`, ''));
    assert.deepEqual(findOverlongExpressionProps(readFileSync(join(dir, 'ok-long.yml'), 'utf8')), [],
      'the guard must not invent a rule GitHub does not enforce, or it will be deleted the first time it annoys someone');

    // and a short property with an expression is fine too
    writeFileSync(join(dir, 'ok-expr.yml'), 'name: x\njobs:\n  a:\n    steps:\n      - run: echo "${{ matrix.n }}"\n');
    assert.deepEqual(findOverlongExpressionProps(readFileSync(join(dir, 'ok-expr.yml'), 'utf8')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
