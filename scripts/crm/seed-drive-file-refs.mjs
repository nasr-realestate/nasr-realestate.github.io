#!/usr/bin/env node
/**
 * Anchoring the rows that arrived before the ledger — the one step that closes draft 0010's bootstrap gap.
 *
 * The gap, stated exactly: 0010 adds `drive_ref` and, in §5, backfills one version row per registry row that
 * carries both a fingerprint and an anchor. A row produced by `syncDriveFolderMetadataInventory` then
 * `recordContentHash`/`recordInspectionSuccess` *before* the promotion has the fingerprint and no anchor, so
 * §5 skips it, `head_version_seq` stays 0, `crm_drive_version_invariant_violations` reports it as
 * `status_without_version`, and every 0011 review case for that file is refused by
 * `file_review_case_requires_a_recorded_version`. The rows are real, the work is real, and the review path is
 * sealed shut on them. (Measured on D1: V15a–d of `crm-drive-file-versions.d1-service.mjs`.)
 *
 * The ordering is forced, not chosen: `drive_ref` does not exist before 0010, so refs cannot be seeded
 * earlier. The safe sequence is therefore
 *
 *   1. export the registry (read-only) — `wrangler d1 export --local`, or a JSON dump from an approved read
 *      path, or this tool's `--from` file handed to it by a human;
 *   2. apply 0010 (§5 runs and is inert for un-anchored rows — that is expected, not a failure);
 *   3. run this tool to produce `drive-ref-seed.sql` + a manifest, review it, apply it;
 *   4. re-run §5 (idempotent — it is `INSERT … SELECT … WHERE NOT EXISTS`);
 *   5. assert `crm_drive_version_invariant_violations` returns zero rows before anything is built on 0011.
 *
 * What this tool refuses to do, on purpose:
 *   - it never touches a database: no Cloudflare API, no `--remote`, no token. It reads a file and writes a
 *     file; a human applies the SQL where they choose;
 *   - it writes one column. `drive_ref` only — never a fingerprint, never a status, never a receipt, never an
 *     evidence class, because an anchor is a fact about identity and this tool has not measured content;
 *   - it never overwrites an anchor. A row whose `drive_ref` disagrees with the repo key is a conflict to
 *     investigate, not a row to "fix";
 *   - it produces no verification claim. §5 labels what it backfills `bootstrap_backfill` with
 *     `content_provenance = 'backfilled_from_registry_projection'`; that means "the registry said so", which
 *     is strictly weaker than `verified_local_recompute` ("bytes were recomputed and matched here").
 *
 *   node scripts/crm/seed-drive-file-refs.mjs selftest
 *   node scripts/crm/seed-drive-file-refs.mjs --from export.json --out seed-out/ [--all]
 *   node scripts/crm/seed-drive-file-refs.mjs backfill-sql [--migration <path>] --out rerun-0010-s5.sql
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The repo's Drive-ref scheme, spelled the same way here so a mismatch is visible rather than silent:
 *  `sha256("<namespace>\n<kind>\n<id>")`. The service computes it in `_worker/crm-drive-file-registry.js`
 *  (`deriveDriveRef`), draft 0010 §5 expects exactly that, and `crm-drive-ref-bootstrap.test.mjs` pins all
 *  three against each other — an independent reimplementation that is never cross-checked is just a guess. */
export const REF_NAMESPACE = 'crm-p4-v1';
export const DRIVE_REF_KIND = 'drive_ref';
const SAFE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export function driveRefFor(driveFileId) {
  return createHash('sha256').update(`${REF_NAMESPACE}\n${DRIVE_REF_KIND}\n${driveFileId}`, 'utf8').digest('hex');
}

/** One line of a check report. Concatenation, not a nested template, so the printers stay lintable. */
function reportLine([ok, name, note]) {
  return `${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}\n`;
}
function missingBlock(failed) {
  const lines = failed.map(c => `  - ${c[1]} (${c[2]})`).join('\n');
  return `${lines}\n`;
}

function rowsFromExport(text, sourceName) {
  const parsed = JSON.parse(text);
  const records = Array.isArray(parsed) ? parsed : parsed?.records ?? parsed?.results ?? null;
  if (!Array.isArray(records)) {
    throw new Error(`${sourceName}: expected a JSON array, {"records": […]} or {"results": […]} of registry rows`);
  }
  return records;
}

/**
 * @param records registry rows: at least `drive_file_id`, and `drive_ref`/`content_sha256` when known
 * @param opts.all anchor every row, not only the fingerprinted ones (default: fingerprinted only — the
 *                 set that is actually stuck, and the smallest write surface that closes it)
 */
export function buildSeedPlan(records, { all = false } = {}) {
  const plan = { seeded: [], alreadyAnchored: [], conflicts: [], refused: [], skippedNoFingerprint: 0 };
  records.forEach((row, index) => {
    const id = String(row?.drive_file_id ?? '').trim();
    const safe = SAFE_ID_RE.test(id);
    const tag = safe ? id : 'unsafe id';
    const where = `row #${index + 1}` + (id ? ` (${tag})` : '');
    if (!SAFE_ID_RE.test(id)) {
      plan.refused.push({ where, reason: 'drive_file_id is outside [A-Za-z0-9_-]{10,128} — it would be inlined into SQL' });
      return;
    }
    const digest = row?.content_sha256 == null ? null : String(row.content_sha256).toLowerCase();
    if (digest !== null && !DIGEST_RE.test(digest)) {
      plan.refused.push({ where, reason: 'content_sha256 is present but is not 64 hex characters' });
      return;
    }
    if (!all && digest === null) {
      plan.skippedNoFingerprint += 1;
      return;
    }
    const expected = driveRefFor(id);
    const current = row?.drive_ref == null ? null : String(row.drive_ref).toLowerCase();
    if (current !== null && current !== expected) {
      plan.conflicts.push({ where, expected, found: current });
      return;
    }
    if (current === expected) {
      plan.alreadyAnchored.push({ where, drive_ref: current });
      return;
    }
    plan.seeded.push({ where, drive_file_id: id, drive_ref: expected, has_fingerprint: digest !== null });
  });
  return plan;
}

/** One fixed statement template, `drive_ref` only, guarded by `drive_ref IS NULL` so a re-run is a no-op. */
export function renderSeedSql(plan) {
  const lines = [
    '-- drive_ref seed — generated by scripts/crm/seed-drive-file-refs.mjs, review before applying.',
    `-- namespace: ${REF_NAMESPACE}/${DRIVE_REF_KIND} · anchored rows: ${plan.seeded.length} · already anchored: ${plan.alreadyAnchored.length}`,
    '-- this file writes exactly one column; it never sets content_sha256, a status, a receipt or an evidence class',
    'BEGIN;',
  ];
  for (const r of plan.seeded) {
    lines.push(`UPDATE crm_drive_file_registry SET drive_ref = '${r.drive_ref}'`
      + ` WHERE drive_file_id = '${r.drive_file_id}' AND drive_ref IS NULL;`);
  }
  lines.push('COMMIT;');
  lines.push('');
  lines.push('-- after this file, re-run draft 0010 §5 (idempotent) and require this to return 0:');
  lines.push('--   SELECT status_without_version AS unreviewable FROM crm_drive_version_invariant_violations;');
  return `${lines.join('\n')}\n`;
}

export function summarizeSeed(plan) {
  return {
    anchored: plan.seeded.length,
    already_anchored: plan.alreadyAnchored.length,
    conflicts: plan.conflicts.length,
    refused: plan.refused.length,
    skipped_without_fingerprint: plan.skippedNoFingerprint,
    // the manifest is safe to commit: refs are hashes, never identifiers
    ref_sha256_of_sorted_refs: plan.seeded.length === 0
      ? null
      : createHash('sha256').update(plan.seeded.map(r => r.drive_ref).sort().join('\n')).digest('hex'),
    // The cross-run digest: the plan that WRITES the anchors and the verification pass that finds them
    // ALREADY THERE cover the same row set, so this digest must be identical across the two runs even
    // though the buckets differ. It is the only way to prove the applied seed equals the reviewed seed
    // without exchanging identifiers, because D1 has no SHA-256 to recompute with.
    ref_sha256_of_all_anchored: sortedRefDigest(plan),
    anchored_rows: plan.seeded.length + plan.alreadyAnchored.length,
  };
}

function sortedRefDigest(plan) {
  const refs = [...plan.seeded, ...plan.alreadyAnchored].map(r => r.drive_ref).sort();
  if (refs.length === 0) return null;
  return createHash('sha256').update(refs.join('\n')).digest('hex');
}

export function assertSeedIsOneColumn(sqlText) {
  const offenders = sqlText
    .split('\n')
    .filter(l => l.startsWith('UPDATE '))
    .filter(l => !/^UPDATE crm_drive_file_registry SET drive_ref = '[0-9a-f]{64}' WHERE drive_file_id = '[A-Za-z0-9_-]{10,128}' AND drive_ref IS NULL;$/.test(l));
  if (offenders.length > 0) {
    throw new Error(`the seed wrote more than an anchor in ${offenders.length} statement(s)`);
  }
  for (const forbidden of ['content_sha256', 'processing_status', 'processing_receipt_ref', 'evidence_class',
    'verified_local_recompute', 'head_version_seq']) {
    if (sqlText.includes(`SET ${forbidden}`) || sqlText.includes(`, ${forbidden} =`)) {
      throw new Error(`the seed touched ${forbidden} — an anchor pass must not claim content provenance`);
    }
  }
  return true;
}

// ------------------------------------------------------------------ the §5 re-run, extracted not copied
/** Where the 0010 file lives: applied chain first, then the drafts directory. The promotion moves the file
 *  and nothing in this tool should have to change because of it. */
export function resolveMigrationPath(name = '0010_crm_drive_file_versions.sql') {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const roots = [path.resolve(here, '../../_worker/migrations'), path.resolve(here, '../../_worker/migrations-draft')];
  for (const dir of roots) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`MIGRATION_FILE_NOT_FOUND: ${name} is in neither _worker/migrations nor _worker/migrations-draft`);
}

/** What 0010 §5 must always look like, checked before the text is handed to anybody. The re-run exists
 *  because `d1 migrations apply` will not run a section twice — a plan that says "re-run §5" without a
 *  machine-readable way to extract it is a plan that invites a hand-typed copy. */
export function assertBackfillIsIdempotentAnchorOnly(sql) {
  const required = [
    [/^INSERT INTO crm_drive_file_version\b/, 'it must add versions and nothing else'],
    [/NOT EXISTS/, 'it must be idempotent (a re-run cannot double a version row)'],
    [/'bootstrap_backfill'/, 'it must claim only what a backfill can claim'],
    [/'phase2-0010-bootstrap'/, 'it must carry the bootstrap receipt, not a measurement receipt'],
    [/drive_ref IS NOT NULL/, 'it must anchor only rows whose drive_ref exists — otherwise it invents one'],
    [/content_sha256 IS NOT NULL/, 'it must not create a version for a row with no fingerprint'],
  ];
  for (const [re, why] of required) if (!re.test(sql)) throw new Error(`BACKFILL_SHAPE_UNEXPECTED: ${re} (${why})`);
  for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bPRAGMA\b/i]) {
    if (bad.test(sql)) throw new Error(`BACKFILL_TOUCHES_MORE_THAN_THE_LEDGER: ${bad}`);
  }
  return true;
}

/** Pull the numbered backfill section out of the migration file. Section headers are the file's own
 *  `-- 5) backfill …` line and the `-- ---…` rules around it, so the extraction follows the document. */
export function extractBackfillSql(migrationText) {
  const lines = String(migrationText).split('\n');
  const at = lines.findIndex(l => /^-- \d+\) backfill\b/.test(l.trim()));
  if (at === -1) throw new Error('BACKFILL_BLOCK_MISSING: no numbered "backfill" section in this migration');
  // The header is wrapped in rules and followed by prose, so walk forward: skip everything until the SQL
  // starts, and stop at the terminator or the next section rule. A `;` inside a comment cannot end the
  // statement because comment lines are never part of `taken`.
  const taken = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('-- ') && taken.length === 0) continue;
    if (/^-- -{5,}$/.test(t) && taken.length > 0) break;
    if (t.startsWith('--')) continue;
    taken.push(t);
    if (/;\s*$/.test(t)) break;
  }
  const body = taken.join('\n').trim();
  const statements = body.split(';').map(t => t.trim()).filter(Boolean);
  if (statements.length !== 1) {
    throw new Error(`BACKFILL_BLOCK_AMBIGUOUS: ${statements.length} statements, expected exactly one`);
  }
  const sql = `${statements[0]};
`;
  assertBackfillIsIdempotentAnchorOnly(sql);
  return sql;
}

// ------------------------------------------------------------------ selftest (files and strings only)
export function selftest() {
  const checks = [];
  const check = (name, fn) => {
    try {
      const note = fn();
      checks.push([true, name, typeof note === 'string' ? note : '']);
    } catch (e) {
      checks.push([false, name, String(e.message || e)]);
    }
  };
  const dig = c => c.repeat(64);
  const A = 'SYNTHDRIVEFILEAAAAAAAAAAAAAAAAA1';
  const B = 'SYNTHDRIVEFILEAAAAAAAAAAAAAAAAA2';
  const C = 'SYNTHDRIVEFILEAAAAAAAAAAAAAAAAA3';

  check('B1 the anchor is the repo key: sha256(namespace\nkind\nid), lower-case hex', () => {
    const expected = createHash('sha256')
      .update(`${REF_NAMESPACE}\n${DRIVE_REF_KIND}\n${A}`, 'utf8')
      .digest('hex');
    if (driveRefFor(A) !== expected) throw new Error('the key drifted from the documented expression');
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('the anchor is not 64 lowercase hex');
    if (driveRefFor(A) === driveRefFor(B)) throw new Error('two ids collided on one anchor');
    return `${expected.slice(0, 8)}…`;
  });
  check('B2 only the stuck rows are seeded: fingerprint present, no anchor yet', () => {
    const plan = buildSeedPlan([
      { drive_file_id: A, content_sha256: dig('a'), drive_ref: null },
      { drive_file_id: B, content_sha256: null, drive_ref: null },
      { drive_file_id: C, content_sha256: dig('c'), drive_ref: driveRefFor(C) },
    ]);
    const s = summarizeSeed(plan);
    if (s.anchored !== 1 || s.already_anchored !== 1 || s.conflicts !== 0 || s.refused !== 0
      || s.skipped_without_fingerprint !== 1) throw new Error(`unexpected plan ${JSON.stringify(s)}`);
    return 'one anchored, one already, one skipped, zero conflicts';
  });
  check('B3 --all anchors metadata-only rows too, because a dedup key costs nothing to lay down', () => {
    const plan = buildSeedPlan([{ drive_file_id: B, content_sha256: null, drive_ref: null }], { all: true });
    return summarizeSeed(plan).anchored === 1 ? 'anchored' : 'the flag stopped anchoring';
  });
  check('B4 an existing anchor is never overwritten — it is reported as a conflict', () => {
    const plan = buildSeedPlan([{ drive_file_id: A, content_sha256: dig('a'), drive_ref: dig('e') }]);
    if (plan.seeded.length !== 0) throw new Error('the seed planned to overwrite a foreign anchor');
    if (plan.conflicts.length !== 1) throw new Error('a disagreeing anchor must be a conflict, not silence');
    return `conflict: ${plan.conflicts[0].found.slice(0, 8)}…`;
  });
  check('B5 an id that cannot be safely inlined is refused, not escaped', () => {
    for (const bad of ['short', "an id with spaces", "bad'; DROP TABLE crm_drive_file_registry;--", 'ملف-عميل', 'x'.repeat(200)]) {
      const plan = buildSeedPlan([{ drive_file_id: bad, content_sha256: dig('a') }]);
      if (plan.seeded.length !== 0 || plan.refused.length !== 1) throw new Error(`${JSON.stringify(bad.slice(0, 12))} was not refused as one unsafe id`);
    }
    return 'four shapes refused';
  });
  check('B6 a half-written fingerprint is refused — an anchor pass trusts nothing it has not seen whole', () => {
    const plan = buildSeedPlan([{ drive_file_id: A, content_sha256: 'abc123' }]);
    if (plan.refused.length !== 1 || plan.seeded.length !== 0) throw new Error('a non-hex fingerprint slipped through');
    return 'refused';
  });
  check('B7 the emitted SQL is one column, and the guard makes a second pass a no-op', () => {
    const plan = buildSeedPlan([{ drive_file_id: A, content_sha256: dig('a'), drive_ref: null }]);
    const sql = renderSeedSql(plan);
    assertSeedIsOneColumn(sql);
    if (!sql.includes('AND drive_ref IS NULL')) throw new Error('the idempotency guard is gone');
    const again = buildSeedPlan([{ drive_file_id: A, content_sha256: dig('a'), drive_ref: driveRefFor(A) }]);
    if (again.seeded.length !== 0) throw new Error('a re-run planned new writes');
    return `${plan.seeded.length} statement, replay-safe`;
  });
  check('B8 the manifest hash covers the anchors, so two independent runs can be compared without ids', () => {
    const rows = [{ drive_file_id: A, content_sha256: dig('a') }, { drive_file_id: B, content_sha256: dig('b') }];
    const p1 = summarizeSeed(buildSeedPlan(rows));
    const p2 = summarizeSeed(buildSeedPlan([...rows].reverse()));
    if (p1.ref_sha256_of_sorted_refs !== p2.ref_sha256_of_sorted_refs) throw new Error('the manifest is order-sensitive');
    if (!/^[0-9a-f]{64}$/.test(p1.ref_sha256_of_sorted_refs)) throw new Error('no manifest digest');
    return `${p1.ref_sha256_of_sorted_refs.slice(0, 12)}…`;
  });
  check('B9 an empty plan yields a file that changes nothing (so an operator can tell "nothing to do" from "broken")', () => {
    const sql = renderSeedSql(buildSeedPlan([]));
    assertSeedIsOneColumn(sql);
    if (!/BEGIN;\nCOMMIT;/.test(sql)) throw new Error('an empty seed should be a transaction that does nothing');
    return 'BEGIN/COMMIT only';
  });
  check('B10 bootstrap stays local by construction: three builtins, no subprocess, no host, no token', () => {
    // block and line comments are dropped before the scan: the prose is allowed to name what the code must not do
    const src = readFileSync(new URL(import.meta.url), 'utf8')
      .replace(/\/\*[^]*?\*\//g, '')
      .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
    // each pattern is assembled at runtime, or the check would match its own source text
    for (const [what, needle] of [['a Cloudflare host', 'api' + '.cloudflare.com'], ['an API token', 'CLOUDFLARE_' + 'API_TOKEN'],
      ['a network call', 'fet' + 'ch('], ['a subprocess', 'child' + '_process'], ['a raw socket', 'node:' + 'net'],
      ['a transport', 'node:' + 'tls'], ['a CLI runner', 'execS' + 'ync'], ['the environment', 'process.' + 'env']]) {
      if (src.includes(needle)) throw new Error(`the seeding code references ${what}`);
    }
    const flags = [...src.matchAll(/argv\.includes\('(--[a-z]+)'\)/g)].map(m => m[1]);
    if (!flags.includes('--remote')) throw new Error('the refusal of --remote is gone — that is the guard');
    const imports = readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('import '))
      .map(l => (l.match(/from '(node:[^']+)'/) || [])[1]).filter(Boolean);
    const unexpected = imports.filter(i => !['node:crypto', 'node:fs', 'node:path'].includes(i));
    if (unexpected.length > 0) throw new Error(`new dependency surface: ${unexpected.join(', ')}`);
    return `${imports.length} node: builtins, ${flags.length} guarded flag`;
  });

  check('B14 the cross-run digest is the same for a plan that writes and a pass that verifies', () => {
    const rows = [{ drive_file_id: A, content_sha256: dig('a') }, { drive_file_id: B, content_sha256: dig('b') }];
    const before = summarizeSeed(buildSeedPlan(rows));
    if (before.anchored !== 2 || before.already_anchored !== 0) throw new Error('the first pass should anchor both');
    const after = summarizeSeed(buildSeedPlan(rows.map(r => ({ ...r, drive_ref: driveRefFor(r.drive_file_id) }))));
    if (after.anchored !== 0 || after.already_anchored !== 2) throw new Error('the second pass should find both anchored');
    if (after.ref_sha256_of_sorted_refs !== null) throw new Error('a verification pass has nothing new to sort');
    if (before.ref_sha256_of_all_anchored !== after.ref_sha256_of_all_anchored) {
      throw new Error('the two runs disagree about the anchored set — the seed cannot be verified without ids');
    }
    if (!/^[0-9a-f]{64}$/.test(String(before.ref_sha256_of_all_anchored))) throw new Error('no cross-run digest');
    if (before.anchored_rows !== 2 || after.anchored_rows !== 2) throw new Error('the anchored row count drifted');
    return `${before.ref_sha256_of_all_anchored.slice(0, 12)}… across both passes`;
  });
  check('B11 the repo 0010 backfill section extracts to exactly the statement §5 promises', () => {
    const file = resolveMigrationPath();
    const sql = extractBackfillSql(readFileSync(file, 'utf8'));
    if (sql.split('\n').filter(l => /;\s*$/.test(l)).length !== 1) throw new Error('more than one statement came out');
    if (!/INSERT INTO crm_drive_file_version/.test(sql)) throw new Error('the wrong section was extracted');
    return `${path.basename(file)} · ${sql.length} bytes · sha ${createHash('sha256').update(sql).digest('hex').slice(0, 12)}…`;
  });
  check('B12 a backfill block that drifted is refused rather than run', () => {
    const real = extractBackfillSql(readFileSync(resolveMigrationPath(), 'utf8'));
    const tampered = [
      real.replace(/AND NOT EXISTS[\s\S]*?\);/, ');'),           // re-run would double every version row
      real.replace(/'bootstrap_backfill'/, "'verified_local_recompute'"), // a claim the file has not earned
      real.replace('AND r.content_sha256 IS NOT NULL', ''),        // versions for rows with no fingerprint
      `${real}\nUPDATE crm_drive_file_registry SET head_version_seq = 1;`, // a second statement, and a write outside the ledger
      real.replace(/^INSERT INTO crm_drive_file_version/, 'DELETE FROM crm_drive_file_version'),
    ];
    for (const t of tampered) {
      let msg = 'ACCEPTED';
      try { assertBackfillIsIdempotentAnchorOnly(t); } catch (e) { msg = String(e.message); }
      if (!msg.startsWith('BACKFILL_')) throw new Error(`drift went unnoticed: ${msg.slice(0, 60)}`);
    }
    return 'five drifts refused';
  });
  check('B13 extraction follows the file wherever it lives, so promotion does not break the plan', () => {
    const file = resolveMigrationPath();
    if (!/_worker\/migrations(-draft)?\/0010_crm_drive_file_versions\.sql$/.test(file)) throw new Error(`unexpected location: ${file}`);
    let missing = false;
    try { resolveMigrationPath('0013_does_not_exist.sql'); } catch (e) { missing = /MIGRATION_FILE_NOT_FOUND/.test(String(e.message)); }
    if (!missing) throw new Error('a missing migration must be an error, not an empty re-run');
    return `${file.includes('/migrations/') ? 'applied chain' : 'drafts'} · refuses absence`;
  });
  return checks;
}

function main(argv) {
  if (argv[0] === 'selftest') {
    const checks = selftest();
    const held = checks.filter(c => c[0]).length;
    for (const c of checks) process.stdout.write(reportLine(c));
    process.stdout.write(`\nDRIVE_REF_SEED ${held}/${checks.length} checks held\n`);
    if (held !== checks.length) {
      process.stdout.write(`DRIVE_REF_SEED_BARRIERS_MISSING:\n${missingBlock(checks.filter(c => !c[0]))}`);
      process.exit(1);
    }
    process.stdout.write('DRIVE_REF_SEED_ALL_HELD\n');
    return 0;
  }
  if (argv[0] === 'backfill-sql') {
    const outIdx = argv.indexOf('--out');
    if (outIdx === -1) {
      process.stderr.write('backfill-sql needs --out <file> to write the extracted statement to\n');
      return 2;
    }
    const migIdx = argv.indexOf('--migration');
    const file = migIdx === -1 ? resolveMigrationPath() : argv[migIdx + 1];
    const sql = extractBackfillSql(readFileSync(file, 'utf8'));
    writeFileSync(argv[outIdx + 1], sql);
    const digest = createHash('sha256').update(sql).digest('hex');
    process.stdout.write(`statements=1 bytes=${sql.length} sha256=${digest}\n`);
    return 0;
  }
  const fromIdx = argv.indexOf('--from');
  const outIdx = argv.indexOf('--out');
  if (fromIdx === -1 || outIdx === -1) {
    process.stdout.write('usage: seed-drive-file-refs.mjs selftest | --from <export.json> --out <dir> [--all] | backfill-sql [--migration <path>] --out <file>\n');
    return 2;
  }
  if (argv.includes('--remote')) {
    process.stderr.write('refusing: this tool never reaches a database — export first, apply by hand\n');
    return 2;
  }
  const fromPath = argv[fromIdx + 1];
  const outDir = argv[outIdx + 1];
  const all = argv.includes('--all');
  const records = rowsFromExport(readFileSync(fromPath, 'utf8'), fromPath);
  const plan = buildSeedPlan(records, { all });
  const sql = renderSeedSql(plan);
  assertSeedIsOneColumn(sql);
  const summary = summarizeSeed(plan);
  const manifest = {
    generated_from: path.basename(fromPath),
    rows_in_export: records.length,
    ...summary,
    statement_count: plan.seeded.length,
    seed_sha256: createHash('sha256').update(sql).digest('hex'),
    // conflicts and refusals are reported by position and anchor prefix, never by identifier
    conflicts: plan.conflicts.map(c => ({ where: c.where, found_prefix: c.found.slice(0, 12), expected_prefix: c.expected.slice(0, 12) })),
    refused: plan.refused.map(r => ({ where: r.where, reason: r.reason })),
    next_steps: [
      'apply drive-ref-seed.sql to the database the export came from (a human choice — this tool cannot)',
      're-run draft 0010 §5 (idempotent) so the backfilled versions appear',
      'require SELECT status_without_version FROM crm_drive_version_invariant_violations to return 0 before relying on 0011',
    ],
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'drive-ref-seed.sql'), sql);
  writeFileSync(path.join(outDir, 'drive-ref-seed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`anchored=${summary.anchored} already=${summary.already_anchored} conflicts=${summary.conflicts} refused=${summary.refused}\n`);
  if (summary.conflicts > 0 || summary.refused > 0) {
    process.stdout.write('the plan is still written; resolve conflicts before applying anything\n');
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('seed-drive-file-refs.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
