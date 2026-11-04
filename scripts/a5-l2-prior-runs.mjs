#!/usr/bin/env node
/**
 * A5 L2 — decide, for EVERY prior run of THIS workflow, whether that run was eligible to publish
 * an `a5-l2-ledger`, and deliver the eligible runs' ledgers BEFORE any write.
 *
 * WHY THIS EXISTS
 * ---------------
 * Requiring a ledger artifact from every historical run creates an unbreakable deadlock: the 39
 * runs that predate the L2 mechanism could never produce one, so the first L2 run stops, publishes
 * no ledger, becomes itself a completed run without a ledger, and every later run stops again.
 *
 * THE FIX (safe separation, not a bypass)
 * ---------------------------------------
 * Eligibility is decided from TWO independent, technical pieces of evidence about the exact run,
 * never from a date, a display name, a conclusion, or a fixed number of runs:
 *   1. the ACTUAL workflow file at the run's `head_sha` must contain every L2 mechanism marker;
 *   2. the run's OWN job steps must show that the L2 preflight step actually ran.
 * If either source is unreadable, or the two disagree, or a write step ran without the L2
 * preflight, this is a HARD STOP (fail-closed). An eligible run that is old / failed / cancelled
 * still owes a readable ledger; nothing is skipped by age, conclusion or count.
 *
 * An INELIGIBLE run is NOT assumed to have written no rows. Its rows (including the documented
 * legacy namespace: `TEST ONLY A5 ci-*`, the known synthetic phones, `ci-e2e-ticket:%`, …) are
 * inspected row-by-row by `enumerateLegacySuspects()` / `classifyRows()` in `a5-l2.mjs`; any row
 * without valid per-row L2 evidence is `unknown` and stops the run. Proof lives at ROW level, so
 * dropping an impossible artifact requirement cannot hide unowned data.
 *
 * INVARIANTS (every failure => non-zero exit => stop BEFORE any write)
 *   - Paginate ALL completed runs with per_page=100 until a short page proves exhaustion.
 *   - NO `created` / time filter and NO "first N runs" shortcut. `MAX_PAGES` is only an
 *     anti-infinite-loop guard; exceeding it STOPS, it never truncates-and-continues.
 *   - total_count, distinct ids, well-formed head_sha, and uniqueness are all verified.
 *   - Every eligible run must yield >=1 readable, parseable, schema-correct L2 JSON artifact.
 *   - No `|| true`, no "treat as absent", no guessing, no deletion, no DB write.
 *
 * L2 remains the ONLY ownership proof; this module only DELIVERS prior ledgers to
 * `loadLedgers()` / `classifyRows()` / `preflightCleared()` in `scripts/a5-l2.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { L2_SCHEMA } from './a5-l2.mjs';

/**
 * Artifact retention of the `a5-l2-ledger` upload step. INFORMATIONAL ONLY: it is pinned by an
 * offline test against `retention-days`, and is deliberately NOT used to filter/skip prior runs.
 */
export const DEFAULT_RETENTION_DAYS = 90;
export const PER_PAGE = 100;
export const MAX_PAGES = 1000; // anti-infinite-loop guard only; exceeding it STOPS
export const WORKFLOW_FILE = 'crm-cloudflare-test-deploy.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const ARTIFACT_NAME = 'a5-l2-ledger';

/**
 * Exact, controlled markers of the L2 mechanism in the workflow file at `head_sha`. A partial
 * match is ambiguous evidence => STOP, never "assume ineligible".
 */
export const L2_MECHANISM_MARKERS = Object.freeze([
  'a5-l2-prior-runs.mjs',
  'a5-l2.mjs begin',
  'a5-l2.mjs preflight',
  'a5-l2.mjs finalize',
  'name: a5-l2-ledger',
]);
/** Technical step evidence, taken from `GET /actions/runs/{id}/jobs` — never from the run name. */
export const L2_PREFLIGHT_STEP = 'A5 L2 — prior ledgers, read-only baseline, ownership preflight';
export const A5_WRITE_STEP = 'Deploy nasr-crm-api-test and run live A5 E2E';

/** Kept as a public helper (artifact-retention pin + tests); NOT a run filter. */
export function retentionCutoff(now = new Date(), days = DEFAULT_RETENTION_DAYS) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('a5-l2-bad-retention-days');
  return new Date(now.getTime() - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 'present' | 'absent' | 'ambiguous' — based ONLY on the workflow source at that commit. */
export function mechanismInWorkflow(text) {
  const t = String(text || '');
  const hits = L2_MECHANISM_MARKERS.filter(m => t.includes(m)).length;
  if (hits === 0) return 'absent';
  if (hits !== L2_MECHANISM_MARKERS.length) return 'ambiguous';
  return 'present';
}

/**
 * `execGh(args)` returns raw stdout of `gh api`. Fetch EVERY completed run of this workflow.
 * No `created` filter: a run's age must never be used to skip it.
 */
export function fetchAllRuns({ execGh, repo, workflow = WORKFLOW_FILE,
  retentionDays = DEFAULT_RETENTION_DAYS, now = new Date(), perPage = PER_PAGE,
  maxPages = MAX_PAGES, status = 'completed' }) {
  if (!repo || typeof execGh !== 'function') throw new Error('a5-l2-prior-runs-bad-config');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('a5-l2-bad-per-page');
  const cutoff = retentionCutoff(now, retentionDays); // informational pin, NEVER sent as a filter
  const runs = [];
  let page = 1;
  let pagesFetched = 0;
  let totalCount = null;
  let exhausted = false;

  while (page <= maxPages) {
    const args = ['api', '-X', 'GET', `repos/${repo}/actions/workflows/${workflow}/runs`,
      '-f', `status=${status}`, '-f', `per_page=${perPage}`, '-f', `page=${page}`];
    let raw;
    try { raw = execGh(args); }
    catch { throw new Error(`a5-l2-runs-page-unreadable:page=${page}`); }
    let parsed;
    try { parsed = JSON.parse(String(raw)); }
    catch { throw new Error(`a5-l2-runs-page-unparsable:page=${page}`); }
    if (!Array.isArray(parsed.workflow_runs) || !Number.isInteger(parsed.total_count)) {
      throw new Error(`a5-l2-runs-page-shape:page=${page}`);
    }
    pagesFetched += 1;
    if (totalCount === null) totalCount = parsed.total_count;
    for (const run of parsed.workflow_runs) {
      const id = String(run?.id ?? '');
      const headSha = String(run?.head_sha ?? '');
      if (!/^\d+$/.test(id)) throw new Error(`a5-l2-runs-bad-id:page=${page}`);
      if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`a5-l2-runs-bad-head-sha:page=${page}:run=${id}`);
      runs.push({ id, headSha, conclusion: String(run?.conclusion ?? ''),
        displayTitle: String(run?.display_title ?? '') }); // displayTitle is recorded, NEVER used
    }
    if (parsed.workflow_runs.length < perPage) { exhausted = true; break; }
    page += 1;
  }
  if (!exhausted) throw new Error(`a5-l2-runs-pagination-not-exhausted:max_pages=${maxPages}`);
  const runIds = runs.map(r => r.id);
  if (runIds.length < totalCount) throw new Error(`a5-l2-runs-incomplete:${runIds.length}/${totalCount}`);
  if (new Set(runIds).size !== runIds.length) throw new Error('a5-l2-runs-duplicate-ids');
  return { runs, runIds, pagesFetched, totalCount, cutoff, cutoffIsFilter: false,
    retentionDays: Number(retentionDays) };
}

/** Backwards-compatible name used by the existing pagination tests. */
export const fetchAllRunIds = fetchAllRuns;

/**
 * Classify each run's eligibility from its own technical evidence.
 * `readWorkflow(sha)` -> raw workflow text; `readJobs(runId)` -> [{ name, conclusion }].
 * ANY unreadable/contradictory evidence is a HARD STOP, never "assume ineligible".
 */
export function classifyEligibility({ runs, readWorkflow, readJobs }) {
  if (!Array.isArray(runs) || typeof readWorkflow !== 'function' || typeof readJobs !== 'function') {
    throw new Error('a5-l2-eligibility-bad-config');
  }
  const cache = new Map();
  const eligible = [];
  const ineligible = [];
  for (const run of runs) {
    const rid = run.id;
    let text;
    try {
      if (!cache.has(run.headSha)) cache.set(run.headSha, String(readWorkflow(run.headSha) ?? ''));
      text = cache.get(run.headSha);
    } catch { throw new Error(`a5-l2-eligibility-workflow-unreadable:run=${rid}:sha=${run.headSha.slice(0, 12)}`); }
    if (!text.trim()) throw new Error(`a5-l2-eligibility-workflow-empty:run=${rid}`);
    const mechanism = mechanismInWorkflow(text);
    if (mechanism === 'ambiguous') throw new Error(`a5-l2-eligibility-workflow-ambiguous:run=${rid}`);

    let steps;
    try { steps = readJobs(rid); }
    catch { throw new Error(`a5-l2-eligibility-jobs-unreadable:run=${rid}`); }
    if (!Array.isArray(steps)) throw new Error(`a5-l2-eligibility-jobs-unreadable:run=${rid}`);
    const ran = name => steps.some(s => String(s?.name ?? '') === name
      && String(s?.conclusion ?? '') !== 'skipped');
    const l2StepRan = ran(L2_PREFLIGHT_STEP);
    const writeStepRan = ran(A5_WRITE_STEP);

    // Contradictory evidence is never resolved by guessing.
    if (mechanism === 'absent' && l2StepRan) {
      throw new Error(`a5-l2-eligibility-mechanism-mismatch:run=${rid}`);
    }
    if (mechanism === 'present' && !l2StepRan && writeStepRan) {
      throw new Error(`a5-l2-eligibility-writes-without-preflight:run=${rid}`);
    }
    const isEligible = mechanism === 'present' && l2StepRan;
    const record = { id: rid, headSha: run.headSha, conclusion: run.conclusion,
      mechanism, l2StepRan, writeStepRan,
      reason: isEligible ? 'l2-mechanism-executed'
        : mechanism === 'absent' ? 'pre-l2-workflow-version' : 'l2-preflight-step-not-reached' };
    (isEligible ? eligible : ineligible).push(record);
  }
  return { eligible, ineligible, workflowsRead: cache.size };
}

/**
 * `download(runId, dir)` must place the artifact's files in `dir`. Zero files, an unreadable
 * download, or a non-L2 JSON file is a HARD STOP — never "no prior rows". Only ELIGIBLE run ids
 * are passed here by the CLI; ineligible runs are never asked for an artifact.
 */
export function collectPriorLedgers({ runIds, priorDir, workDir, download,
  copy = cpSync, list = readdirSync, read = readFileSync, exists = existsSync,
  ensureDir = mkdirSync }) {
  ensureDir(priorDir, { recursive: true });
  ensureDir(workDir, { recursive: true });
  const files = [];
  for (const rid of runIds) {
    const dl = join(workDir, `dl-${rid}`);
    ensureDir(dl, { recursive: true });
    try { download(rid, dl); }
    catch { throw new Error(`a5-l2-ledger-artifact-unreadable:run=${rid}`); }
    const candidates = list(dl).filter(n => n.endsWith('.json'));
    if (candidates.length === 0) throw new Error(`a5-l2-ledger-artifact-missing:run=${rid}`);
    let valid = 0;
    for (const name of candidates) {
      const src = join(dl, name);
      if (!exists(src)) throw new Error(`a5-l2-ledger-artifact-missing:run=${rid}`);
      let parsed;
      try { parsed = JSON.parse(String(read(src, 'utf8'))); }
      catch { throw new Error(`a5-l2-ledger-artifact-corrupt:run=${rid}`); }
      if (parsed?.schema !== L2_SCHEMA) throw new Error(`a5-l2-ledger-artifact-not-l2:run=${rid}`);
      const dest = join(priorDir, `dl-${rid}-${name}`);
      copy(src, dest);
      files.push(dest);
      valid += 1;
    }
    if (valid === 0) throw new Error(`a5-l2-ledger-artifact-missing:run=${rid}`);
  }
  return { files, runs: runIds.length, ledgers: files.length };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

function cli() {
  const argv = process.argv.slice(2);
  const opt = name => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = process.env;
  const ghBin = String(env.A5_L2_GH_BIN || 'gh').trim();
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  if (!repo) throw new Error('a5-l2-github-repository-missing');
  const priorDir = resolve(String(opt('prior-dir') || env.A5_L2_PRIOR_DIR || '').trim());
  const workDir = resolve(String(opt('work-dir') || env.A5_L2_WORK_DIR || '').trim());
  if (!opt('prior-dir') && !env.A5_L2_PRIOR_DIR) throw new Error('a5-l2-prior-dir-required');
  if (!opt('work-dir') && !env.A5_L2_WORK_DIR) throw new Error('a5-l2-work-dir-required');
  const retentionDays = Number(opt('retention-days') || env.A5_L2_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);

  const execGh = args => execFileSync(ghBin, args, {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const download = (rid, dir) => execFileSync(ghBin,
    ['run', 'download', String(rid), '--repo', repo, '--name', ARTIFACT_NAME, '--dir', dir],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  // Evidence source 1: the workflow file at the run's exact commit (read-only contents API).
  const readWorkflow = sha => {
    const raw = execGh(['api', `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${sha}`, '--jq', '.content']);
    return Buffer.from(String(raw).replace(/\s/g, ''), 'base64').toString('utf8');
  };
  // Evidence source 2: what the run ACTUALLY executed (read-only jobs API).
  const readJobs = rid => {
    const raw = execGh(['api', `repos/${repo}/actions/runs/${rid}/jobs?per_page=100`]);
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed.jobs)) throw new Error('jobs-shape');
    return parsed.jobs.flatMap(j => (Array.isArray(j.steps) ? j.steps : []))
      .map(s => ({ name: String(s.name ?? ''), conclusion: String(s.conclusion ?? '') }));
  };

  const runs = fetchAllRuns({ execGh, repo, retentionDays });
  const eligibility = classifyEligibility({ runs: runs.runs, readWorkflow, readJobs });
  const collected = collectPriorLedgers({
    runIds: eligibility.eligible.map(r => r.id), priorDir, workDir, download,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true, pages_fetched: runs.pagesFetched, total_count: runs.totalCount,
    runs_fetched: runs.runIds.length,
    eligible_runs: eligibility.eligible.length,
    ineligible_runs: eligibility.ineligible.length,
    ledgers: collected.ledgers,
    retention_days: runs.retentionDays, cutoff: runs.cutoff,
    cutoff_is_filter: runs.cutoffIsFilter,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { cli(); }
  catch (error) {
    const reason = String(error?.message || error).slice(0, 200);
    process.stderr.write(`::error::A5 L2 prior-ledger retrieval STOPPED before any write: ${reason}\n`);
    process.exitCode = 1;
  }
}
