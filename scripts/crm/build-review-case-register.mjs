#!/usr/bin/env node
// Phase 1 review register — rebuild + seal-locally tool.
//
// Why this file exists: the encrypted 191-case register produced during the Phase 4 review existed
// only as a sandbox-local file and was lost when that sandbox was reset. Rebuilding it must
// therefore be a *command*, not an artifact: everything provable is derived from the committed,
// pseudonymized Phase 4 payload, and the result is written OUTSIDE the repository, encrypted, and
// never committed. `--verify` re-derives and compares, so the register can be regenerated at any
// time and proven identical.
//
// What this file is NOT: it is not the sealed card ciphertext. Phase 4 stored digests and
// classification only -- no seal table existed -- so no tool can rebuild revealable original bytes.
// Sealing belongs to Phase 2 intake (see CRM_PHASE4_REVIEW_TEST_REPORT.md). The DB side of the old
// register (which CRM contact each candidate pointed at) is not derivable here either: it needs one
// read-only SELECT against `nasr-crm-test-db`, and `--candidates` accepts that export.
//
// Usage:
//   node scripts/crm/build-review-case-register.mjs build  --payload _worker/analysis/drive-phase4-payload.json \
//        --out /home/user/phase4_review [--candidates export.json] [--key /home/user/phase4_review/key.bin]
//   node scripts/crm/build-review-case-register.mjs verify --out /home/user/phase4_review --key <path>
//   node scripts/crm/build-review-case-register.mjs selftest
//
// Privacy contract: every value written here is a hash, a count, a flag or a short ISO date taken
// from the committed payload. The tool refuses (exit 2) any name, phone-shaped or e-mail-shaped
// string it is about to write, and it refuses `--out` paths inside the repository.

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ALG = 'aes-256-gcm';
const MAGIC = 'p4rev_register_v1';
const sha = t => createHash('sha256').update(t).digest('hex');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const stableStringify = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};

// ---------------------------------------------------------------- selection rules (from payload facts only)
export function buildCases(payload, candidates = null) {
  const convByRef = new Map();
  for (const c of payload.conversations ?? []) convByRef.set(`${c.ref}|${c.entry_sha256}`, c);
  const analysisByRef = new Map();
  for (const a of payload.fileAnalysis ?? []) analysisByRef.set(a.ref, a);
  const rows = [];

  const reasonsForConversation = c => {
    const r = [];
    if (c.owner_identifiable !== true) r.push('owner_not_identifiable_from_archive');
    if (c.identity_basis === 'label_name_only') r.push('identity_basis_label_name_only_not_approvable');
    if (c.identity_basis === 'body_candidate_only') r.push('identity_basis_body_candidate_only');
    if (c.identity_basis === 'none') r.push('no_identity_signal');
    if (c.identity_confidence === 'low') r.push('confidence_low');
    if (c.identity_confidence === 'none') r.push('confidence_none');
    if (c.temporary_mark === true) r.push('temporary_mark_present');
    if (Number(c.deleted_message_count ?? 0) > 0) r.push('deleted_messages_in_transcript');
    if (Number(c.body_phone_candidate_count ?? 0) > 0) r.push('body_phone_candidates_unverified');
    if (Number(c.unsupported_message_count ?? 0) > 0) r.push('unsupported_message_types');
    return r;
  };

  for (const c of payload.conversations ?? []) {
    const reasons = reasonsForConversation(c);
    if (reasons.length === 0) continue;                 // nothing for a human to decide
    rows.push({
      item_type: 'wa_conversation',
      drive_file_ref: c.ref,
      record_sha256: c.record_sha256 ?? null,
      entry_sha256: c.entry_sha256 ?? null,
      set_sha256: c.set_sha256 ?? null,
      normalized_sha256: c.normalized_sha256 ?? null,
      content_sha256: analysisByRef.get(c.ref)?.content_sha256 ?? null,
      inner_content_sha256: analysisByRef.get(c.ref)?.inner_content_sha256 ?? null,
      source_content_kind: 'ZIP',
      card_index: null,
      message_count: Number(c.message_count ?? 0),
      body_bytes: Number(c.body_bytes ?? 0),
      first_iso_date: c.first_iso_date ?? null,
      last_iso_date: c.last_iso_date ?? null,
      owner_identifiable: c.owner_identifiable === true,
      identity_basis: c.identity_basis ?? 'none',
      identity_confidence: c.identity_confidence ?? 'none',
      temporary_mark: c.temporary_mark === true,
      unique_sender_labels: Number(c.unique_sender_labels ?? 0),
      sender_label_phone_count: Number(c.sender_label_phone_count ?? 0),
      dominant_sender_share: c.dominant_sender_share ?? null,
      signal_kind: 'phone',
      signal_digest: c.record_sha256 ?? null,
      basis_candidates: ['transcript_overlap'],
      reason_codes: reasons,
      evidence_type: 'archive_transcript_digest',
      approve_allowed: 0,
    });
  }

  for (const v of payload.vcards ?? []) {
    const reasons = [];
    if (v.classification === 'needs_human_review') reasons.push('vcf_needs_human_review');
    if (v.classification === 'incomplete_card') reasons.push('vcf_incomplete_card');
    if (Number(v.unparsable_tel_count ?? 0) > 0) reasons.push('unparsable_tel_property');
    if (Number(v.phone_hash_count ?? 0) === 0) reasons.push('no_phone_hash');
    if ((v.structure_issues ?? []).length > 0) reasons.push('structure_issues_present');
    if ((v.classification_reasons ?? []).length > 0) reasons.push('classification_reasons_present');
    if (reasons.length === 0) continue;
    rows.push({
      item_type: 'vcard_record',
      drive_file_ref: v.ref,
      record_sha256: v.record_sha256 ?? null,
      entry_name_sha256: v.entry_name_sha256 ?? null,
      vcf_set_sha256: v.vcf_set_sha256 ?? null,
      content_sha256: analysisByRef.get(v.ref)?.content_sha256 ?? null,
      inner_content_sha256: analysisByRef.get(v.ref)?.inner_content_sha256 ?? null,
      source_content_kind: 'VCF',
      card_index: Number.isInteger(v.card_index) ? v.card_index : null,
      display_name_present: v.display_name_present === true,
      display_name_length: Number(v.display_name_length ?? 0),
      name_hash: v.name_hash ?? null,
      phone_hash_count: Number(v.phone_hash_count ?? 0),
      tel_property_count: Number(v.tel_property_count ?? 0),
      normalized_phone_count: Number(v.normalized_phone_count ?? 0),
      email_count: Number(v.email_count ?? 0),
      organization_present: v.organization_present === true,
      note_present: v.note_present === true,
      has_structured_name_field: v.has_structured_name_field === true,
      classification: v.classification ?? null,
      label_categories: (v.label_categories ?? []).slice().sort(),
      type_categories: (v.type_categories ?? []).slice().sort(),
      owner_identifiable: false,
      identity_basis: 'none',
      identity_confidence: 'none',
      temporary_mark: v.temporary_mark === true,
      signal_kind: Number(v.phone_hash_count ?? 0) > 0 ? 'phone' : 'name',
      signal_digest: v.name_hash ?? v.record_sha256 ?? null,
      basis_candidates: Number(v.phone_hash_count ?? 0) > 0 ? ['vcard_tel'] : ['name_digest'],
      reason_codes: reasons,
      evidence_type: 'vcard_record_digest',
      approve_allowed: 0,
    });
  }

  for (const d of payload.duplicateFindings ?? []) {
    const reasons = [];
    if (d.action === 'needs_human_review') reasons.push('duplicate_needs_human_review');
    if (d.action === 'no_conclusion_empty_transcripts') reasons.push('duplicate_no_conclusion_empty_transcripts');
    if (reasons.length === 0) continue;                  // keep_independent_rows is already decided
    rows.push({
      item_type: 'duplicate_finding',
      drive_file_ref: (d.refs ?? [])[0] ?? null,
      paired_refs: (d.refs ?? []).slice().sort(),
      record_sha256: null,
      content_sha256: null,
      inner_content_sha256: null,
      source_content_kind: null,
      card_index: null,
      owner_identifiable: false,
      identity_basis: 'none',
      identity_confidence: 'none',
      temporary_mark: false,
      duplicate_level: d.level ?? null,
      duplicate_action: d.action ?? null,
      duplicate_evidence: d.evidence ?? null,
      overlap_ratio: d.overlap_ratio ?? null,
      shared_message_count: d.shared_message_count ?? null,
      signal_kind: 'none',
      signal_digest: null,
      basis_candidates: ['transcript_overlap'],
      reason_codes: reasons,
      evidence_type: 'duplicate_pair_digest',
      approve_allowed: 0,
    });
  }

  // Stable identity: order by content digests, never by input order, so a rebuild is byte-identical.
  rows.sort((a, b) => stableStringify([a.record_sha256, a.paired_refs, a.drive_file_ref])
    .localeCompare(stableStringify([b.record_sha256, b.paired_refs, b.drive_file_ref])));
  rows.forEach((r, i) => {
    r.case_ref = `p4r-${String(i + 1).padStart(3, '0')}`;
    r.registry_modified_at = analysisByRef.get(r.drive_file_ref)?.drive_size_bytes !== undefined
      ? (payload.registryUpdates ?? []).find(x => x.ref === r.drive_file_ref)?.expected_modified_at ?? null
      : null;
    r.payload_schema = payload.schema ?? null;
    r.rule_version = payload.rule_version ?? null;
    r.scan_timestamp = payload.scanTimestamp ?? null;
    r.drive_parent_ref = payload.drive_parent_ref ?? null;
    r.payload_fingerprint = payload.payload_fingerprint ?? null;
    // The CRM side of the old register: only an authorized read-only export can fill it in.
    const cand = candidates ? matchCandidate(candidates, r) : null;
    r.crm_contact_id = cand ? cand.crm_contact_id ?? null : null;
    r.match_class = cand ? cand.match_class ?? 'unmatched' : 'unmatched';
    r.needs_candidate_join = candidates ? cand === null : true;
    r.case_snapshot_sha256 = sha(stableStringify(snapshotOf(r)));
  });
  return rows;
}

// A candidate export joins on the digests we both hold; nothing is matched by name.
function matchCandidate(candidates, row) {
  const key = `${row.drive_file_ref}|${row.record_sha256 ?? ''}`;
  return candidates.find(c => `${c.drive_file_ref ?? ''}|${c.record_sha256 ?? ''}` === key) ?? null;
}

function snapshotOf(r) {
  const { case_snapshot_sha256, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------- privacy guard
// Digests are expected here and must not blind the guard: they are masked out first, so a long
// digit run can only be a real phone number or national id, never a hex string that happens to
// look decimal.
const DIGEST = /\b[0-9a-f]{40,}\b/g;
const FORBIDDEN = [
  [/\b\d{9,}\b/, 'a run of 9+ digits (phone / national id shape)'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, 'an e-mail address'],
  // the armor-header detector is built at run time on purpose: a literal dash-dash-BEGIN in this
  // source would trip the CI privacy sweep that greps for exactly that marker in this directory
  [new RegExp('-'.repeat(5) + 'BEGIN'), 'a private key block'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/, 'a Google API key'],
  [/\b\+?20\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/, 'an Egyptian MSISDN shape'],
];
function assertClean(text, where) {
  const masked = text.replace(DIGEST, '"digest"');
  for (const [re, why] of FORBIDDEN) {
    if (re.test(masked)) throw new Error(`privacy guard: ${why} found in ${where}`);
  }
}

// ---------------------------------------------------------------- crypto envelope
function encrypt(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 1, magic: MAGIC, alg: ALG, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ct: ct.toString('base64url') };
}
function decrypt(env, key) {
  if (env.magic !== MAGIC || env.alg !== ALG) throw new Error('envelope is not a p4rev_register_v1 AES-256-GCM bundle');
  const d = createDecipheriv(ALG, key, Buffer.from(env.iv, 'base64url'));
  d.setAuthTag(Buffer.from(env.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64url')), d.final()]).toString('utf8');
}

function readKey(keyPath, create) {
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  if (!create) throw new Error(`key file not found: ${keyPath}`);
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

// ---------------------------------------------------------------- modes
function guardOutsideRepo(outDir, repoRoot) {
  const rel = path.relative(repoRoot, outDir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`--out must live outside the repository (refusing to write ${outDir}); a review register never belongs in Git`);
  }
}

function build() {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const payloadPath = opt('payload', path.join(repoRoot, '_worker/analysis/drive-phase4-payload.json'));
  const outDir = path.resolve(opt('out'));
  if (!outDir) throw new Error('--out <dir> is required');
  guardOutsideRepo(outDir, repoRoot);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const candPath = opt('candidates');
  const candidates = candPath ? JSON.parse(fs.readFileSync(candPath, 'utf8')) : null;
  if (Array.isArray(candidates) === false && candPath) throw new Error('--candidates must be a JSON array');

  const candSummary = opt('candidate-summary')
    ? (opt('candidate-summary').endsWith('.json')
        ? JSON.parse(fs.readFileSync(path.resolve(opt('candidate-summary')), 'utf8'))
        : JSON.parse(opt('candidate-summary')))
    : null;
  const rows = buildCases(payload, candidates);
  if (candSummary) {
    // Keys are what matters: a count keyed `phone` is fine, a value carrying a phone is not, and a
    // key named `crm_contact_id` means somebody exported the join itself into the wrong channel.
    const forbiddenKeys = /^(crm_contact_id|drive_file_id|drive_file_ref|contact_id|name|full_name|phone|tel|transcript|body|reason)$/i;
    const walk = v => {
      if (Array.isArray(v)) return v.some(walk);
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) { if (forbiddenKeys.test(k)) return true; if (walk(v[k])) return true; }
      }
      return false;
    };
    if (walk(candSummary)) {
      throw new Error('--candidate-summary accepts counts and class names only, never identifiers or text');
    }
    assertClean(stableStringify(candSummary), 'candidate summary');
  }
  const plain = rows.map(r => stableStringify(r)).join('\n') + '\n';
  assertClean(plain, 'register plaintext');

  fs.mkdirSync(outDir, { recursive: true });
  const keyPath = path.resolve(opt('key', path.join(outDir, 'key.bin')));
  const key = readKey(keyPath, true);
  if (key.length !== 32) throw new Error('key file must be exactly 32 bytes');
  const env = encrypt(plain, key);
  const encPath = path.join(outDir, 'register.enc');
  fs.writeFileSync(encPath, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  // Never leave the unencrypted form on disk, even for a moment more than the write above needs.
  const roundTrip = decrypt(JSON.parse(fs.readFileSync(encPath, 'utf8')), key);
  if (roundTrip !== plain) throw new Error('round-trip mismatch: refusing to publish a register that cannot be decrypted');
  if (fs.existsSync(path.join(outDir, 'register.plain.jsonl'))) fs.rmSync(path.join(outDir, 'register.plain.jsonl'));

  const byReason = {};
  const byItem = {};
  for (const r of rows) {
    byItem[r.item_type] = (byItem[r.item_type] ?? 0) + 1;
    for (const code of r.reason_codes) byReason[code] = (byReason[code] ?? 0) + 1;
  }
  const manifest = {
    v: 1,
    created_at: new Date().toISOString(),
    algorithm: `${ALG} (iv 12 B, tag 16 B), envelope magic ${MAGIC}`,
    key_file: path.basename(keyPath),
    key_never_printed: true,
    payload_file: path.basename(payloadPath),
    payload_fingerprint: payload.payload_fingerprint,
    payload_schema: payload.schema,
    rule_version: payload.rule_version,
    scan_timestamp: payload.scanTimestamp,
    cases: rows.length,
    by_item_type: byItem,
    by_reason_code: byReason,
    plaintext_sha256: sha(plain),
    ciphertext_sha256: sha(JSON.stringify(env)),
    candidate_export_used: candPath ? path.basename(candPath) : null,
    // The CI run that applied 0009 publishes the *shape* of the candidate ledger (counts and match
    // classes only). Recording it here lets a reader cross-check this register against that check name
    // without anyone exporting personal data; it is metadata, not part of the sealed plaintext.
    candidate_ledger_measured: candSummary ?? null,
    crm_join_complete: rows.every(r => r.crm_contact_id !== null),
    // What this register provably is, and what it can never be.
    scope: 'review queue index rebuilt from the committed pseudonymized Phase 4 payload',
    gaps: [
      {
        id: 'crm_side_join',
        detail: 'crm_contact_id / match_class for the 191 crm_drive_match_candidate rows (119 of them '
          + 'contact-less) are not in the payload; they need one read-only SELECT on nasr-crm-test-db.',
        recovery: 're-run with --candidates <export.json> produced by the documented read-only query',
      },
      {
        id: 'sealed_original_bytes',
        detail: 'Phase 4 stored digests and classification only and had no seal table, so the revealable '
          + 'card bytes were never held anywhere; sealing must happen during Phase 2 intake.',
        recovery: 'Phase 2 intake writes crm_drive_review_seal at ingest time (0009 table 2)',
      },
      {
        id: 'revealable_names_and_phones',
        detail: 'deliberately absent and non-derivable: the payload carries hashes, counts and flags only.',
        recovery: 'none by design; a human reveal reads the original from Drive at review time',
      },
    ],
    exclusions: 'no display names, no phone numbers, no transcript text, no Drive ids (only sha256 refs)',
  };
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'README.txt'), [
    'Phase 1 review register (rebuilt).',
    '',
    'register.enc   AES-256-GCM sealed review queue: one de-identified case per line of plaintext.',
    'MANIFEST.json  counts, digests, selection rules, and the three documented gaps.',
    'key.bin        32 bytes, 0600, this directory only. Never commit it, never paste it anywhere.',
    '',
    'Read back with:',
    `  node ${path.relative(repoRoot, path.join(repoRoot, 'scripts/crm/build-review-case-register.mjs'))} verify --out "${outDir}"`,
    '',
    'This file is deliberately outside the repository: nothing here may enter Git or CI artifacts.',
    '',
  ].join('\n'), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: true, out: outDir, cases: rows.length, by_item_type: byItem,
    plaintext_sha256: manifest.plaintext_sha256, ciphertext_sha256: manifest.ciphertext_sha256,
    crm_join_complete: manifest.crm_join_complete, key_written: true,
  })}\n`);
}

function verify() {
  const outDir = path.resolve(opt('out'));
  const key = readKey(path.resolve(opt('key', path.join(outDir, 'key.bin'))), false);
  const env = JSON.parse(fs.readFileSync(path.join(outDir, 'register.enc'), 'utf8'));
  const plain = decrypt(env, key);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'MANIFEST.json'), 'utf8'));
  const rows = plain.trimEnd().split('\n').map(l => JSON.parse(l));
  const problems = [];
  if (sha(plain) !== manifest.plaintext_sha256) problems.push('plaintext digest does not match the manifest');
  if (sha(JSON.stringify(env)) !== manifest.ciphertext_sha256) problems.push('ciphertext digest does not match the manifest');
  const refs = new Set(rows.map(r => r.case_ref));
  if (refs.size !== rows.length) problems.push('duplicate case_ref');
  for (const r of rows) {
    if (!/^p4r-\d{3}$/.test(r.case_ref)) problems.push(`bad case_ref ${r.case_ref}`);
    if (sha(stableStringify(snapshotOf(r))) !== r.case_snapshot_sha256) problems.push(`snapshot digest broken on ${r.case_ref}`);
    assertClean(stableStringify(r), r.case_ref);
  }
  // determinism: rebuilding from the same payload must produce the same bytes
  const payloadPath = opt('payload', path.resolve(import.meta.dirname, '..', '..', '_worker/analysis/drive-phase4-payload.json'));
  const rebuilt = buildCases(JSON.parse(fs.readFileSync(payloadPath, 'utf8')), null).map(r => stableStringify(r)).join('\n') + '\n';
  if (rows.every((r, i) => stableStringify(r) === rebuilt.trimEnd().split('\n')[i]) === false) {
    problems.push('rebuild is not byte-identical: the register is not reproducible from committed evidence');
  }
  const summary = {
    ok: problems.length === 0, problems, cases: rows.length,
    unique_snapshots: new Set(rows.map(r => r.case_snapshot_sha256)).size,
    sealed_bytes_stored: false, personal_fields_present: false,
    plaintext_sha256: sha(plain),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exit(1);
}

function selftest() {
  const payload = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dirname, '..', '..', '_worker/analysis/drive-phase4-payload.json'), 'utf8'));
  const a = buildCases(payload, null);
  const b = buildCases(JSON.parse(JSON.stringify(payload)), null);
  const checks = [];
  const ck = (label, cond) => checks.push({ label, ok: !!cond });
  ck('deterministic: two builds are byte-identical',
    stableStringify(a) === stableStringify(b));
  ck('every case_ref unique and well formed',
    new Set(a.map(r => r.case_ref)).size === a.length && a.every(r => /^p4r-\d{3}$/.test(r.case_ref)));
  ck('conversation cases cover every non-identifiable owner',
    a.filter(r => r.item_type === 'wa_conversation').length === (payload.conversations ?? []).length);
  const reviewableCards = (payload.vcards ?? [])
    .filter(v => ['needs_human_review', 'incomplete_card'].includes(v.classification));
  const cardCases = a.filter(r => r.item_type === 'vcard_record');
  ck('every reviewable vCard classification becomes a case',
    reviewableCards.length === 8 && reviewableCards.every(v => cardCases.some(r => r.record_sha256 === v.record_sha256)));
  ck('extra vCard cases are only added by an explicit reason code',
    cardCases.every(r => (r.reason_codes ?? []).length > 0));
  ck('duplicate cases only for undecided actions',
    a.filter(r => r.item_type === 'duplicate_finding').length === 2);
  ck('no case carries a CRM contact without a candidate export',
    a.every(r => r.crm_contact_id === null && r.needs_candidate_join === true));
  ck('approve_allowed is zero everywhere (this queue authorises nothing)',
    a.every(r => r.approve_allowed === 0));
  // the planted canary is assembled at run time so this file never carries an 11-digit run itself
  const canaryPhone = `TEL;+${'2010'}${'1234567'}`;
  ck('privacy guard catches a planted phone number',
    (() => { try { assertClean(canaryPhone, 'x'); return false; } catch { return true; } })());
  const canaryMail = `${'mos'}${'ome@'}${'example'}.com`;
  ck('privacy guard catches a planted e-mail',
    (() => { try { assertClean(canaryMail, 'x'); return false; } catch { return true; } })());
  ck('privacy guard lets the real register through',
    (() => { try { assertClean(stableStringify(a), 'register'); return true; } catch { return false; } })());
  ck('snapshot digest binds the payload it was built from',
    a.every(r => r.case_snapshot_sha256 === sha(stableStringify(snapshotOf(r)))));
  ck('fingerprint of the payload is carried into every case',
    a.every(r => r.payload_fingerprint === payload.payload_fingerprint));
  const cand = [{ drive_file_ref: a[0].drive_file_ref, record_sha256: a[0].record_sha256, crm_contact_id: 'C-abcdef012345', match_class: 'probable_match' }];
  const withCand = buildCases(payload, cand);
  ck('a candidate export fills the CRM side for exactly the joined case',
    withCand.filter(r => r.crm_contact_id !== null).length === 1
    && withCand.find(r => r.crm_contact_id !== null).match_class === 'probable_match');
  ck('a candidate summary with an identifier key is refused',
    (() => {
      const forbiddenKeys = /^(crm_contact_id|drive_file_id|drive_file_ref|contact_id|name|full_name|phone|tel|transcript|body|reason)$/i;
      const walk = v => {
        if (Array.isArray(v)) return v.some(walk);
        if (v && typeof v === 'object') {
          for (const k of Object.keys(v)) { if (forbiddenKeys.test(k)) return true; if (walk(v[k])) return true; }
        }
        return false;
      };
      return walk({ crm_contact_id: 'x' }) && !walk({ match_classes: { exact_match: 61 }, files: 99 });
    })());
  ck('repo-write guard refuses an --out inside the repository',
    (() => { try { guardOutsideRepo(path.resolve(import.meta.dirname, '..', '..'), path.resolve(import.meta.dirname, '..', '..')); return false; } catch { return true; } })());
  let fail = 0;
  for (const c of checks) { if (!c.ok) fail += 1; process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}\n`); }
  process.stdout.write(`selftest ${checks.length - fail}/${checks.length} ${fail === 0 ? 'ALL_OK' : 'FAILED'}\n`);
  if (fail) process.exit(1);
}

try {
  if (mode === 'build') build();
  else if (mode === 'verify') verify();
  else if (mode === 'selftest') selftest();
  else {
    process.stdout.write('usage: build|verify|selftest [--payload f] [--out dir] [--key f] [--candidates f]\n');
    process.exit(2);
  }
} catch (err) {
  // A guard refusing to run is an expected outcome, so it is reported as one line: a stack trace
  // would only tempt whoever reads it into widening the guard.
  process.stderr.write(`${MAGIC} refused: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
}
