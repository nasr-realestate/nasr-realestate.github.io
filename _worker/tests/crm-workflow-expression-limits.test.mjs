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
import { execFileSync } from 'node:child_process';
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

// A YAML file that parses can still contain a shell script that does not: one `if` eaten by a bad find-and-
// replace in a `run: |` block leaves an orphan `fi`, GitHub starts the job happily, and the only evidence is
// a failed step in a log this repository's automation cannot read. `bash -n` on the block costs milliseconds
// and catches it on push. Expressions are replaced before parsing, because `${{ ... }}` is not shell — the
// substitution can mask an unbalanced quote next to an expression, which is what the length test above is
// for; the two checks together cover the file.
test('every workflow run block is a script bash can actually parse', () => {
  const dir = '.github/workflows';
  const blocks = [];
  for (const f of readdirSync(dir).filter(x => /\.ya?ml$/.test(x)).sort()) {
    // Scoped to the CRM workflows, which is what this project edits and what the migration session runs.
    // Two legacy files here write heredocs whose delimiters land at the block's own indentation column, which
    // an indentation-based extractor reads as a cut; `bash -n` then reports a truncated here-document for a
    // workflow GitHub parses and runs every day. Asserting about those would be asserting about the
    // extractor, and a guard that is wrong about someone else's file is a guard that gets deleted.
    if (!f.startsWith('crm-')) continue;
    const lines = readFileSync(`${dir}/${f}`, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^([ \t]*)(?:-[ \t]*)?([A-Za-z0-9_.-]+):[ \t]*[|>][-+]?[0-9]*[ \t]*(?:#.*)?$/.exec(lines[i]);
      if (!m || m[2] !== 'run') continue;
      const indent = m[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') { body.push(''); continue; }
        if (lines[j].match(/^[ \t]*/)[0].length <= indent) break;
        body.push(lines[j]);
      }
      i = j - 1;
      const script = body.join('\n').replace(/\$\{\{.*?\}\}/gs, 'X');
      if (script.length < 400 || !/(^|\n)\s*set -|\$\(|\|\|/.test(script)) continue;
      blocks.push({ f, line: i + 1, script });
    }
  }
  const dir2 = mkdtempSync(join(tmpdir(), 'wf-bash-'));
  try {
    const broken = [];
    for (const [n, b] of blocks.entries()) {
      const path = join(dir2, `blk-${n}.sh`);
      writeFileSync(path, b.script);
      try {
        execFileSync('bash', ['-n', path], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        const why = String(e.stderr || e.message);
        // Only real parse errors count. A `warning: here-document … delimited by end-of-file` is this test's
        // own reading of the block: an indentation scan ends a `run: |` where the YAML does, and a heredoc
        // whose delimiter sits at that column looks truncated to the extractor while the workflow itself is
        // fine. Flagging it would put two unrelated workflows under a rule they do not violate, and a test
        // that cries once is a test that gets silenced.
        if (/syntax error|unexpected token|unexpected end of file/i.test(why)) {
          broken.push(`${b.f} (near its line ${b.line}): ${why.split('\n')[0].slice(0, 140)}`);
        }
      }
    }
    assert.ok(blocks.length >= 8, `expected the CRM run blocks to be found, got ${blocks.length} — a broken extractor is not a pass`);
    assert.deepEqual(broken, [], `these workflow scripts cannot be parsed:\n${broken.join('\n')}`);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('the bash guard rejects an orphan fi, which is the mistake it exists for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-bash-neg-'));
  try {
    const script = ['          set -euo pipefail', '          if [ -n "x" ]; then', '            echo yes', '          fi'].join('\n');
    writeFileSync(join(dir, 'good.sh'), script);
    writeFileSync(join(dir, 'bad.sh'), `${script}\n          fi\n`);
    const ok = (() => { try { execFileSync('bash', ['-n', join(dir, 'good.sh')], { stdio: 'ignore' }); return true; } catch { return false; } })();
    const bad = (() => { try { execFileSync('bash', ['-n', join(dir, 'bad.sh')], { stdio: 'ignore' }); return true; } catch { return false; } })();
    assert.equal(ok, true, 'the good fixture must parse, or the fixture is wrong');
    assert.equal(bad, false, 'an orphan `fi` must be rejected — that is the shape a bad edit leaves behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
