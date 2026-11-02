#!/usr/bin/env node
/**
 * The Phase 3 boundary, stated as it actually is after Phase 4 and draft 0010.
 *
 * `crm-phase3-registry.yml` used to assert `SUM(content_sha256 IS NOT NULL) = 0` on the registry. That was
 * written when the metadata inventory was the only thing that ever touched the table. Phase 4 records real
 * content fingerprints through the service layer, and 0010 turns a fingerprint into a projection of a version
 * ledger — so "no fingerprints anywhere" is no longer the rule, and keeping it as a literal would mean
 * either a permanently red check or a deleted barrier. Neither is acceptable, so this module states the
 * invariant the old assertion was reaching for:
 *
 *   1. the metadata pass neither writes, erases nor moves a fingerprint (descriptive phase ⊥ content phase);
 *   2. a fingerprint only exists where it is *documented* — by a receipt naming the measurement that
 *      produced it, or (once 0010 is applied) by a recorded head version carrying exactly that digest;
 *      `processed` additionally always needs the receipt, because that is the state that claims content was
 *      handled rather than merely hashed;
 *   3. a row may arrive without a fingerprint (that is the inventory doing its job) but never *with* one.
 *
 * The service enforces (1) by refusing `content_sha256` in `upsertDriveFileMetadata`
 * (`METADATA_CANNOT_SET_CONTENT_HASH`) and (2) by triggers; this is the outside check that the enforcement
 * held, so it must not be relaxed into a count. Every string it returns is safe to print: it identifies rows
 * by position and by an 8-hex fingerprint prefix, never by `drive_file_id`, which is the one thing governance
 * (§1.3, §5.5.2) forbids in Git or CI logs.
 *
 *   node scripts/crm/verify-phase3-metadata-boundary.mjs selftest     # no database, no network
 */

/** Receipts that name a real measurement. `p4a:` is Phase 4 content processing; the bootstrap one is
 *  written by draft 0010 §5 for fingerprints that existed before the ledger and are explicitly *not*
 *  claimed to be re-verified. Anything else — `manual`, a bare `true`, an empty string — documents nothing. */
export const DOCUMENTED_RECEIPT_RE = /^(?:p4a:sha256:[0-9a-f]{32}|phase2-0010-bootstrap)$/;

/** The states a fingerprint may legitimately sit on. `discovered`/`failed`/`ignored` never carry one. */
export const FINGERPRINT_STATES = new Set(['metadata_scanned', 'downloaded', 'hashed', 'processed', 'duplicate']);

/**
 * The one query that both the CI gate and the local tests read the registry through. Kept here so the gate
 * in the workflow cannot drift from the predicate the tests prove.
 *
 * `drive_ref` and the head columns are *added by draft 0010*, so the no-ledger projection must not name
 * them: on a database that has not been promoted yet (which is every database today) that query is simply
 * an error. The first version of this gate made exactly that mistake and the local suite caught it.
 */
export function registryProvenanceSql({ withLedger = false } = {}) {
  const ledgerCols = withLedger
    ? `r.drive_ref AS drive_ref, r.head_version_seq AS head_seq, r.versions_observed AS versions_observed,
       v.content_sha256 AS head_digest, v.evidence_class AS head_evidence`
    : 'NULL AS drive_ref, NULL AS head_seq, NULL AS versions_observed, NULL AS head_digest, NULL AS head_evidence';
  const join = withLedger
    ? 'LEFT JOIN crm_drive_file_version v ON v.drive_ref = r.drive_ref AND v.version_seq = r.head_version_seq'
    : '';
  return `SELECT
    r.drive_file_id AS drive_file_id,
    substr(r.content_sha256, 1, 8) AS digest8,
    r.content_sha256 AS digest,
    r.processing_status AS status,
    r.processing_receipt_ref AS receipt,
    r.last_processed_at AS processed_at,
    r.extracted_records_count AS extracted,
    ${ledgerCols}
  FROM crm_drive_file_registry r
  ${join}
  ORDER BY r.drive_file_id`;
}

/** Whether the version ledger is on this database — asked, never assumed, because the gate runs against
 *  a database that is mid-promotion for as long as the drafts stay unapplied. */
export const LEDGER_PROBE_SQL = `SELECT COUNT(*) AS n FROM sqlite_master
  WHERE type = 'table' AND name = 'crm_drive_file_version'`;

/** One line of a check report. Concatenation, not a nested template, so the printers stay lintable. */
function reportLine([ok, name, note]) {
  return `${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}\n`;
}
function missingBlock(failed) {
  const lines = failed.map(c => `  - ${c[1]} (${c[2]})`).join('\n');
  return `${lines}\n`;
}

function label(row, index) {
  const fp = row.digest8 ? ` fingerprint ${row.digest8}…` : '';
  return `row #${index + 1}${fp}`;
}

export function evaluatePhase3Boundary({ before = [], after = [], withLedger = false } = {}) {
  const problems = [];
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return { ok: false, problems: ['before/after must be row arrays'], summary: { rows: 0, fingerprinted: 0 } };
  }
  if (after.length === 0) {
    // an empty result is not a clean result: a typo in the query would "pass" every rule below
    return { ok: false, problems: ['the after-snapshot returned no rows — the gate would be vacuous'], summary: { rows: 0, fingerprinted: 0 } };
  }

  const beforeById = new Map(before.map(r => [r.drive_file_id, r]));
  const afterById = new Map(after.map(r => [r.drive_file_id, r]));

  // 1) the metadata pass must not disturb fingerprints
  after.forEach((row, i) => {
    const was = beforeById.get(row.drive_file_id);
    const digest = row.digest ?? null;
    if (!was) {
      if (digest) problems.push(`${label(row, i)} arrived already fingerprinted — the inventory may register a file, not its content`);
      return;
    }
    const beforeDigest = was.digest ?? null;
    if (beforeDigest === digest) return;
    if (beforeDigest === null) {
      problems.push(`${label(row, i)} gained a fingerprint during a metadata pass`);
    } else if (digest === null) {
      problems.push(`${label(row, i)} lost its fingerprint during a metadata pass — erasing provenance is not a metadata update`);
    } else {
      problems.push(`${label(row, i)} had its fingerprint replaced (${was.digest8 ?? 'none'}… → ${row.digest8 ?? 'none'}…) outside recordContentHash`);
    }
  });
  for (const [id, row] of beforeById) {
    if (!afterById.has(id)) problems.push(`${label(row, [...beforeById.keys()].indexOf(id))} disappeared during the metadata pass`);
  }

  // 2) every fingerprint must be documented — by the registry's own receipt, or (once 0010 is live) by a
  // recorded head version carrying exactly that digest. `processed` always needs the receipt: it is the
  // claim that content was handled, not merely hashed, and a ledger row cannot retroactively prove that.
  let fingerprinted = 0;
  after.forEach((row, i) => {
    if (!row.digest) return;
    fingerprinted += 1;
    problems.push(...fingerprintDocumentationProblems(row, i, withLedger));
  });

  return {
    ok: problems.length === 0,
    problems,
    summary: {
      rows: after.length,
      fingerprinted,
      metadataOnly: after.length - fingerprinted,
      withLedger: withLedger === true,
    },
  };
}

/** What has to be true of a row that carries a fingerprint. Split out because "documented" is the whole
 *  rule, and reading it in one place is worth more than the inline version. */
function fingerprintDocumentationProblems(row, i, withLedger) {
  const problems = [];
  const receipt = String(row.receipt ?? '').trim();
  const receiptShown = receipt ? `“${receipt}”` : 'absent';
  const receiptOk = DOCUMENTED_RECEIPT_RE.test(receipt);
  const ledgerAgrees = withLedger === true && Number(row.head_seq ?? 0) >= 1
    && String(row.head_digest ?? '') === String(row.digest);
  if (!receiptOk && !ledgerAgrees) {
    problems.push(`${label(row, i)} carries a fingerprint with no measurement behind it (receipt ${receiptShown})`);
  }
    if (String(row.status) === 'processed' && !receiptOk) {
      problems.push(`${label(row, i)} claims processed on a fingerprint no receipt documents`);
    }
    if (!FINGERPRINT_STATES.has(String(row.status))) {
      problems.push(`${label(row, i)} carries a fingerprint while in state “${row.status}”`);
    }
  problems.push(...processedClaimProblems(row, i));
  if (withLedger) problems.push(...ledgerProblems(row, i));
  return problems;
}

/** `processed` is the state that says content was handled, so it carries its own evidence requirements. */
function processedClaimProblems(row, i) {
  if (String(row.status) !== 'processed') return [];
  const out = [];
  if (!row.processed_at) out.push(`${label(row, i)} claims processed with no last_processed_at`);
  const n = Number(row.extracted);
  if (!Number.isInteger(n) || n < 0) out.push(`${label(row, i)} claims processed with an unusable record count (${row.extracted})`);
  return out;
}

/** With 0010 live, the ledger is the authority a projection is measured against. */
function ledgerProblems(row, i) {
  const head = Number(row.head_seq ?? 0);
  if (head < 1) {
    return [`${label(row, i)} has a fingerprint the version ledger does not hold (head_version_seq=${head})`];
  }
  if (String(row.head_digest ?? '') !== String(row.digest)) {
    return [`${label(row, i)}'s fingerprint is not the head version's digest — the projection is ahead of, or behind, the ledger`];
  }
  return [];
}

/** Asserts the gate itself: a problem string must never quote an identifier, only positions and prefixes. */
export function assertRedaction(rows, problems, sampleId) {
  const joined = problems.join('\n');
  if (sampleId && joined.includes(sampleId)) {
    throw new Error('REDACTION_FAILURE: a drive_file_id reached the report text');
  }
  const shape = rows.map(r => r.drive_file_id).filter(Boolean);
  for (const id of shape) {
    if (id.length > 20 && joined.includes(id)) throw new Error('REDACTION_FAILURE: an identifier leaked into the report');
  }
  return true;
}

// ------------------------------------------------------------------ selftest (no database, no network)
function row(over) {
  return {
    drive_file_id: 'SYNTH-FILE-1', digest8: null, digest: null, status: 'metadata_scanned',
    receipt: null, processed_at: null, extracted: 0, drive_ref: 'f'.repeat(64),
    head_seq: null, head_digest: null, head_evidence: null,
    ...over,
  };
}
const GOOD_DIGEST = 'a'.repeat(64);
const GOOD_RECEIPT = `p4a:sha256:${'b'.repeat(32)}`;

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
  const refuses = (name, args, needle) => {
    const v = evaluatePhase3Boundary(args);
    if (v.ok) throw new Error(`${name}: the gate accepted what it must refuse`);
    if (!v.problems.some(p => p.includes(needle))) {
      throw new Error(`${name}: refused for the wrong reason → ${v.problems.join(' | ')}`);
    }
    assertRedaction(args.after, v.problems, args.after[0]?.drive_file_id);
    return v.problems.length === 1 ? 'one named problem' : `${v.problems.length} problems`;
  };
  const accepts = (name, args) => {
    const v = evaluatePhase3Boundary(args);
    if (!v.ok) throw new Error(`${name}: the gate refused a legal state → ${v.problems.join(' | ')}`);
    return `ok (${v.summary.fingerprinted} fingerprinted of ${v.summary.rows})`;
  };

  const fingerprinted = extra => row({
    digest: GOOD_DIGEST, digest8: GOOD_DIGEST.slice(0, 8), status: 'processed',
    processed_at: '2026-11-02T09:00:00Z', receipt: GOOD_RECEIPT, ...extra,
  });

  check('S1 the state Phase 4 leaves behind is accepted — the gate is not anti-content', () =>
    accepts('S1', { before: [fingerprinted()], after: [fingerprinted()] }));
  check('S2 a pure metadata-only registry is accepted too (the old expectation, kept as a case not a rule)', () =>
    accepts('S2', { before: [row({})], after: [row({})] }));
  check('S3 a metadata pass that writes a fingerprint is refused', () =>
    refuses('S3', { before: [row({})], after: [fingerprinted()] }, 'gained a fingerprint'));
  check('S4 a metadata pass that erases a fingerprint is refused (erasing provenance is not an update)', () =>
    refuses('S4', { before: [fingerprinted()], after: [row({})] }, 'lost its fingerprint'));
  check('S5 a metadata pass that swaps a fingerprint is refused', () =>
    refuses('S5', {
      before: [fingerprinted({ digest: 'c'.repeat(64), digest8: 'cccccccc' })],
      after: [fingerprinted()],
    }, 'replaced'));
  check('S6 a file may be registered by the inventory — but not registered already fingerprinted', () =>
    refuses('S6', { before: [], after: [fingerprinted()] }, 'arrived already fingerprinted'));
  check('S7 and a row may not vanish during a metadata pass', () =>
    refuses('S7', { before: [row({}), row({ drive_file_id: 'SYNTH-FILE-2' })], after: [row({})] }, 'disappeared'));
  check('S8 an undocumented fingerprint (no receipt) is refused', () =>
    refuses('S8', { before: [fingerprinted({ receipt: null })], after: [fingerprinted({ receipt: null })] }, 'no measurement behind it'));
  check('S9 a hand-typed receipt is refused — provenance is a pattern, not a prose field', () =>
    refuses('S9', {
      before: [fingerprinted({ receipt: 'manual:trust-me' })],
      after: [fingerprinted({ receipt: 'manual:trust-me' })],
    }, 'no measurement behind it'));
  check('S10 the 0010 bootstrap receipt is accepted as what it claims to be (backfilled, not re-verified)', () =>
    accepts('S10', {
      before: [fingerprinted({ receipt: 'phase2-0010-bootstrap' })],
      after: [fingerprinted({ receipt: 'phase2-0010-bootstrap' })],
    }));
  check('S11 a fingerprint sitting on a non-content state is refused', () =>
    refuses('S11', {
      before: [fingerprinted({ status: 'ignored' })],
      after: [fingerprinted({ status: 'ignored' })],
    }, 'while in state'));
  check('S12 processed without a time, or with an unusable count, is refused', () => {
    refuses('S12a', { before: [fingerprinted({ processed_at: null })], after: [fingerprinted({ processed_at: null })] }, 'no last_processed_at');
    refuses('S12b', { before: [fingerprinted({ extracted: -1 })], after: [fingerprinted({ extracted: -1 })] }, 'unusable record count');
    return 'both refusals';
  });
  check('S13 with the ledger present, a fingerprint ahead of an empty version table is refused', () =>
    refuses('S13', {
      withLedger: true,
      before: [fingerprinted({ head_seq: 0 })],
      after: [fingerprinted({ head_seq: 0 })],
    }, 'the version ledger does not hold'));
  check('S14 …and so is one that is not the head version (the projection drifted)', () =>
    refuses('S14', {
      withLedger: true,
      before: [fingerprinted({ head_seq: 2, head_digest: 'd'.repeat(64) })],
      after: [fingerprinted({ head_seq: 2, head_digest: 'd'.repeat(64) })],
    }, 'not the head version'));
  check('S15 with the ledger present and agreeing, the same row passes', () =>
    accepts('S15', {
      withLedger: true,
      before: [fingerprinted({ head_seq: 2, head_digest: GOOD_DIGEST, head_evidence: 'verified_local_recompute' })],
      after: [fingerprinted({ head_seq: 2, head_digest: GOOD_DIGEST, head_evidence: 'verified_local_recompute' })],
    }));
  check('S16 an empty snapshot is a broken query, not a clean database', () =>
    refuses('S16', { before: [], after: [] }, 'vacuous'));
  check('S17 the SQL names only columns the database really has, in either promotion state', () => {
    const bare = registryProvenanceSql({ withLedger: false });
    for (const col of ['drive_file_id', 'content_sha256', 'processing_status', 'processing_receipt_ref',
      'last_processed_at', 'extracted_records_count']) {
      if (!bare.includes(`r.${col}`)) throw new Error(`the query stopped projecting ${col}`);
    }
    // 0010's own columns must never be named on a database that has not been promoted: that query errors,
    // and an erroring gate is how a check ends up disabled rather than fixed.
    for (const drafted of ['r.drive_ref', 'r.head_version_seq', 'r.versions_observed', 'crm_drive_file_version']) {
      if (bare.includes(drafted)) throw new Error(`the no-ledger query names ${drafted}, which only draft 0010 creates`);
    }
    const withL = registryProvenanceSql({ withLedger: true });
    if (!withL.includes('LEFT JOIN crm_drive_file_version')) throw new Error('the ledger query lost its join');
    for (const col of ['r.drive_ref', 'r.head_version_seq']) {
      if (!withL.includes(col)) throw new Error(`the ledger query stopped projecting ${col}`);
    }
    return 'two shapes, each naming only what its database has';
  });
  check('S19 the ledger alone documents a hashed fingerprint (no receipt needed before “processed”)', () =>
    accepts('S19', {
      withLedger: true,
      before: [fingerprinted({ status: 'hashed', receipt: null, processed_at: null, head_seq: 1, head_digest: GOOD_DIGEST })],
      after: [fingerprinted({ status: 'hashed', receipt: null, processed_at: null, head_seq: 1, head_digest: GOOD_DIGEST })],
    }));
  check('S20 …but “processed” still needs its own receipt, ledger or no ledger', () =>
    refuses('S20', {
      withLedger: true,
      before: [fingerprinted({ receipt: null, head_seq: 1, head_digest: GOOD_DIGEST })],
      after: [fingerprinted({ receipt: null, head_seq: 1, head_digest: GOOD_DIGEST })],
    }, 'claims processed on a fingerprint'));
  check('S21 redaction: a problem never quotes the identifier it was triggered by', () => {
    const secretId = 'SYNTH-PRIVATE-DRIVE-ID-DO-NOT-PRINT';
    const v = evaluatePhase3Boundary({ before: [row({ drive_file_id: secretId })], after: [fingerprinted({ drive_file_id: secretId })] });
    if (v.ok) throw new Error('expected a refusal');
    assertRedaction([row({ drive_file_id: secretId })], v.problems, secretId);
    if (v.problems.some(p => p.includes(secretId))) throw new Error('the id was printed');
    return `reported as “${v.problems[0]}”`;
  });

  return checks;
}

if (process.argv[1] && process.argv[1].endsWith('verify-phase3-metadata-boundary.mjs') && process.argv[2] === 'selftest') {
  const checks = selftest();
  const held = checks.filter(c => c[0]).length;
  for (const c of checks) process.stdout.write(reportLine(c));
  process.stdout.write(`\nP3_BOUNDARY ${held}/${checks.length} checks held\n`);
  if (held !== checks.length) {
    process.stdout.write(`P3_BOUNDARY_BARRIERS_MISSING:\n${missingBlock(checks.filter(c => !c[0]))}`);
    process.exit(1);
  }
  process.stdout.write('P3_BOUNDARY_ALL_HELD\n');
}
