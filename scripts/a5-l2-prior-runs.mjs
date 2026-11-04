#!/usr/bin/env node
/**
 * A5 L2 — fetch EVERY relevant prior run's result ledger before any write.
 *
 * The previous implementation used a single `per_page=10` GitHub API call and treated both an
 * unreadable run history and a missing artifact as "no prior rows exist". Both assumptions are
 * unsafe: a run beyond the first page may have created synthetic rows that are still in the test
 * DB, and a missing/unreadable artifact is NOT evidence that no rows were written.
 *
 * INVARIANTS (all failures => non-zero exit => the workflow stops BEFORE any write):
 *   - Paginate with `per_page=100` until a short page proves exhaustion (no arbitrary first page).
 *   - Only runs inside the artifact retention window are "relevant"; `created=>=<cutoff>` filters
 *     them server-side. An artifact that expired for a run inside the window is a HARD STOP.
 *   - Every reported run id must be collected (`ids.length >= total_count`) and must be distinct.
 *   - A run without a readable, parseable, schema-correct ledger artifact is a HARD STOP.
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

/** Must equal `retention-days` of the `a5-l2-ledger` upload step (pinned by an offline test). */
export const DEFAULT_RETENTION_DAYS = 90;
export const PER_PAGE = 100;
export const MAX_PAGES = 100; // guard against a broken API looping forever; exceeding it STOPS
export const WORKFLOW_FILE = 'crm-cloudflare-test-deploy.yml';
export const ARTIFACT_NAME = 'a5-l2-ledger';

export function retentionCutoff(now = new Date(), days = DEFAULT_RETENTION_DAYS) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('a5-l2-bad-retention-days');
  return new Date(now.getTime() - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `execGh(args)` returns the raw stdout of `gh api`. Any throw becomes a named, fatal stop. */
export function fetchAllRunIds({ execGh, repo, workflow = WORKFLOW_FILE,
  retentionDays = DEFAULT_RETENTION_DAYS, now = new Date(), perPage = PER_PAGE,
  maxPages = MAX_PAGES, status = 'completed' }) {
  if (!repo || typeof execGh !== 'function') throw new Error('a5-l2-prior-runs-bad-config');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('a5-l2-bad-per-page');
  const cutoff = retentionCutoff(now, retentionDays);
  const ids = [];
  let page = 1;
  let pagesFetched = 0;
  let totalCount = null;
  let exhausted = false;

  while (page <= maxPages) {
    const args = ['api', '-X', 'GET', `repos/${repo}/actions/workflows/${workflow}/runs`,
      '-f', `status=${status}`, '-f', `per_page=${perPage}`, '-f', `page=${page}`,
      '-f', `created=>=${cutoff}`];
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
      if (!/^\d+$/.test(id)) throw new Error(`a5-l2-runs-bad-id:page=${page}`);
      ids.push(id);
    }
    if (parsed.workflow_runs.length < perPage) { exhausted = true; break; }
    page += 1;
  }
  if (!exhausted) throw new Error(`a5-l2-runs-pagination-not-exhausted:max_pages=${maxPages}`);
  if (ids.length < totalCount) throw new Error(`a5-l2-runs-incomplete:${ids.length}/${totalCount}`);
  if (new Set(ids).size !== ids.length) throw new Error('a5-l2-runs-duplicate-ids');
  return { runIds: ids, pagesFetched, totalCount, cutoff, retentionDays: Number(retentionDays) };
}

/**
 * `download(runId, dir)` must place the artifact's files in `dir`. Zero files, an unreadable
 * download, or a non-L2 JSON file is a HARD STOP — never "no prior rows".
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

  const runs = fetchAllRunIds({ execGh, repo, retentionDays });
  const collected = collectPriorLedgers({ runIds: runs.runIds, priorDir, workDir, download });
  process.stdout.write(`${JSON.stringify({
    ok: true, pages_fetched: runs.pagesFetched, total_count: runs.totalCount,
    runs_fetched: runs.runIds.length, ledgers: collected.ledgers,
    retention_days: runs.retentionDays, cutoff: runs.cutoff,
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
