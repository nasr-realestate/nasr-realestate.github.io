#!/usr/bin/env node
// Phase 2 intake — discovery / dedup / version planner (T0, planning only).
//
// This tool turns a Google Drive folder listing into an *intake plan*: which files are new, which
// have a new revision, which are already known, which duplicate another file's content. It writes
// nothing to any database and never touches Drive: the plan is the contract that the intake worker
// later executes, and reviewing the plan is a human act (CRM_DATA_GOVERNANCE.md rules 1–12).
//
// Privacy by construction: a Drive file id never appears in the output. Every file is named by
// `ref = sha256(drive_file_id)`, which is exactly how the registry stores it (`crm_drive_file_registry`
// carries a hashed reference, governance §5.5). Raw ids stay in the input, which is never committed.
//
// Fingerprint rule (governance rule 4): duplicates are decided by *content*, never by name or size.
// A listing only gives md5/size/version, so those are recorded as `provisional` and can only ever
// produce a `link_verified_hash_pending` action — never `duplicate_of`. Content hash proven by
// download is the only thing that can declare a duplicate.
//
// Usage:
//   node scripts/crm/drive-intake-discovery.mjs plan --listing listing.json [--registry registry.json]
//   node scripts/crm/drive-intake-discovery.mjs selftest

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REF_VERSION = 'p2ref_v1';
const refOf = id => createHash('sha256').update(`${REF_VERSION}|${id}`).digest('hex');
const stableStringify = v => (v === null || typeof v !== 'object'
  ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stableStringify).join(',')}]`
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`);

const MIME_KIND = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/x-vcard': 'vcf',
  'text/vcard': 'vcf',
};

// Content-type is decided from the bytes when they are available, otherwise from the Drive mime,
// otherwise from the extension. A file that cannot be classified is still INTAKE-able: it becomes
// `other` and is routed to review, never rejected (requirement: accept VCF/ZIP/other without a human
// having to classify the folder first).
export function classify(item) {
  const head = item.head_base64 ? Buffer.from(item.head_base64, 'base64') : null;
  if (head && head.length >= 4) {
    const s = head.subarray(0, 4).toString('latin1');
    if (s.startsWith('PK\u0003\u0004') || s.startsWith('PK\u0005\u0006') || s.startsWith('PK\u0007\u0008')) return { kind: 'zip', basis: 'magic' };
    if (/^\s*BEGIN:VCARD/i.test(head.subarray(0, 64).toString('utf8'))) return { kind: 'vcf', basis: 'magic' };
    if (/^\s*BEGIN:VCALENDAR/i.test(head.subarray(0, 64).toString('utf8'))) return { kind: 'other', basis: 'magic:icalendar' };
  }
  if (MIME_KIND[item.mimeType]) return { kind: MIME_KIND[item.mimeType], basis: 'mime' };
  const ext = String(item.name || '').toLowerCase().split('.').pop();
  if (ext === 'zip') return { kind: 'zip', basis: 'extension' };
  if (ext === 'vcf' || ext === 'vcard') return { kind: 'vcf', basis: 'extension' };
  return { kind: 'other', basis: 'unrecognised' };
}

function fingerprint(item) {
  if (item.content_sha256 && /^[0-9a-f]{64}$/.test(item.content_sha256)) {
    return { level: 'content', content_sha256: item.content_sha256, provisional_sha256: null };
  }
  const prov = item.md5Checksum || item.size || item.version
    ? createHash('sha256').update(`prov|${item.md5Checksum ?? ''}|${item.size ?? ''}|${item.version ?? ''}`).digest('hex')
    : null;
  return { level: 'provisional', content_sha256: null, provisional_sha256: prov };
}

function normaliseListing(listing) {
  const rows = [];
  for (const item of listing) {
    if (!item || typeof item.id !== 'string' || item.id.length < 8) continue;   // not a Drive file
    const cls = classify(item);
    const fp = fingerprint(item);
    rows.push({
      ref: refOf(item.id),
      kind: cls.kind,
      kind_basis: cls.basis,
      fingerprint_level: fp.level,
      content_sha256: fp.content_sha256,
      provisional_sha256: fp.provisional_sha256,
      drive_modified_at: item.modifiedTime ?? null,
      drive_version: item.version ?? null,
      size_bytes: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
      original_name_present: typeof item.name === 'string' && item.name.length > 0,
      mime_type: item.mimeType ?? null,
      trashed: item.trashed === true,
    });
  }
  return rows;
}

export function buildPlan(listing, registry) {
  const items = normaliseListing(listing).sort((a, b) => a.ref.localeCompare(b.ref));
  const known = new Map((registry ?? []).map(r => [r.ref ?? refOf(r.drive_file_id), r]));
  const byContent = new Map();
  for (const [ref, r] of known) {
    const c = r.content_sha256 ?? null;
    if (c && !byContent.has(c)) byContent.set(c, ref);      // the registry always wins: it is the record
  }
  // Among files that are all new, the canonical one is the oldest by Drive modification time (then by
  // ref). Deciding it by listing order would make the plan depend on how the API happened to page.
  const newByContent = new Map();
  for (const it of items) {
    if (it.trashed || known.has(it.ref) || !it.content_sha256) continue;
    const prev = newByContent.get(it.content_sha256);
    if (!prev) { newByContent.set(it.content_sha256, it); continue; }
    const older = `${String(prev.drive_modified_at ?? '9')}\u0000${prev.ref}`;
    const cand = `${String(it.drive_modified_at ?? '9')}\u0000${it.ref}`;
    if (cand < older) newByContent.set(it.content_sha256, it);
  }
  for (const [content, it] of newByContent) if (!byContent.has(content)) byContent.set(content, it.ref);
  const actions = [];
  for (const it of items) {
    const prev = known.get(it.ref) ?? null;
    const a = {
      ref: it.ref, kind: it.kind, fingerprint_level: it.fingerprint_level,
      content_sha256: it.content_sha256, drive_modified_at: it.drive_modified_at,
      drive_version: it.drive_version, size_bytes: it.size_bytes,
    };
    if (it.trashed) {
      actions.push({ ...a, action: 'ignore_trash', reason: 'listing reported the file as trashed' });
      continue;
    }
    if (!prev) {
      if (it.content_sha256 && byContent.get(it.content_sha256) !== it.ref) {
        actions.push({ ...a, action: 'register_duplicate', duplicate_of_ref: byContent.get(it.content_sha256),
          reason: 'content_sha256 already claimed by an earlier file in this folder or by the '
            + 'registry (governance rule 4: dedupe by content, never by name or size)' });
      } else {
        actions.push({ ...a, action: 'register_new',
          review_status: it.kind === 'other' ? 'needs_manual_review' : 'not_required',
          reason: 'first sighting of this file reference' });

      }
      continue;
    }
    const modified = (prev.drive_modified_at !== null && it.drive_modified_at !== null
      && String(prev.drive_modified_at) !== String(it.drive_modified_at))
      || (prev.drive_version != null && it.drive_version != null && String(prev.drive_version) !== String(it.drive_version))
      || (prev.size_bytes != null && it.size_bytes != null && Number(prev.size_bytes) !== Number(it.size_bytes));
    const contentChanged = prev.content_sha256 && it.content_sha256 && prev.content_sha256 !== it.content_sha256;
    if (contentChanged) {
      actions.push({ ...a, action: 'register_new_version', previous_content_sha256: prev.content_sha256,
        reason: 'verified content differs from the registered version' });
    } else if (modified) {
      actions.push({ ...a, action: 'link_verified_hash_pending',
        reason: 'listing changed (mtime/version/size) but no verified content hash yet — never called a duplicate on that basis' });
    } else {
      actions.push({ ...a, action: 'unchanged', reason: 'same reference, same verified fingerprint' });
    }
  }
  for (const [ref, r] of [...known.entries()].sort()) {
    if (!items.some(i => i.ref === ref)) {
      // Absent from the listing is NOT evidence of deletion: the folder is never written by intake.
      actions.push({ ref, action: 'missing_from_listing', kind: null, fingerprint_level: 'none',
        reason: 'recorded in the registry but not in this listing; keep the row, set last_seen_at unchanged' });
    }
  }
  const counts = {};
  for (const a of actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  return {
    schema: 'p2intake_plan_v1',
    ref_version: REF_VERSION,
    files_in_listing: items.length,
    files_in_registry: known.size,
    actions,
    counts,
    // What this plan can never authorise, stated in the artifact itself.
    not_authorized: ['import_to_crm', 'link_contact', 'merge_contact', 'drive_write',
      'declare_duplicate_from_provisional_fingerprint'],
    provenance: {
      plan_sha256: null,
      kinds: items.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {}),
      provisional_only: items.filter(i => i.fingerprint_level !== 'content').length,
    },
  };
}

function planDigest(plan) {
  const { ...rest } = plan;
  rest.provenance = { ...rest.provenance, plan_sha256: null };
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

function readJson(p) {
  return p ? JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')) : null;
}

function selftest() {
  const listing = [
    { id: 'syntheticVcfNew000000000000000', name: 'vcards_20261101.vcf', mimeType: 'text/x-vcard', size: '514', modifiedTime: '2026-11-01T09:14:21.221Z', version: '1', content_sha256: 'a'.repeat(64) },
    { id: 'syntheticZipNew0000000000000000', name: 'درردشة في واتساب مع X', mimeType: 'application/zip', size: '972', modifiedTime: '2026-10-29T18:08:42.378Z', version: '1', content_sha256: 'b'.repeat(64) },
    { id: 'syntheticDup000000000000000000', name: 'copy.zip', mimeType: 'application/zip', size: '972', modifiedTime: '2026-10-29T18:09:42.378Z', version: '1', content_sha256: 'b'.repeat(64) },
    { id: 'syntheticKnown000000000000000', name: 'old.zip', mimeType: 'application/zip', size: '100', modifiedTime: '2026-10-01T00:00:00.000Z', version: '1', content_sha256: 'c'.repeat(64) },
    { id: 'syntheticChanged0000000000000', name: 'old2.zip', mimeType: 'application/zip', size: '140', modifiedTime: '2026-10-05T00:00:00.000Z', version: '2', content_sha256: 'd'.repeat(64) },
    { id: 'syntheticOther000000000000000', name: 'notes.txt', mimeType: 'text/plain', size: '12', modifiedTime: '2026-11-02T00:00:00.000Z', version: '1' },
    { id: 'syntheticMagic000000000000000', name: 'mislabeled', mimeType: 'application/octet-stream', size: '8', modifiedTime: '2026-11-02T00:00:01.000Z', version: '1', head_base64: Buffer.from('PK\u0003\u0004\u0000\u0000\u0000\u0000').toString('base64') },
    { id: 'syntheticTrash000000000000000', name: 'gone.zip', mimeType: 'application/zip', size: '9', modifiedTime: '2026-11-02T00:00:02.000Z', version: '1', trashed: true },
  ];
  const regRef0 = refOf('syntheticKnown000000000000000');
  const regRef1 = refOf('syntheticChanged0000000000000');
  const registry = [
    { ref: regRef0, content_sha256: 'c'.repeat(64), drive_modified_at: '2026-10-01T00:00:00.000Z', drive_version: '1', size_bytes: 100 },
    { ref: regRef1, content_sha256: 'c'.repeat(64), drive_modified_at: '2026-10-01T00:00:00.000Z', drive_version: '1', size_bytes: 100 },
    { ref: refOf('syntheticGone0000000000000000'), content_sha256: 'e'.repeat(64), drive_modified_at: null, drive_version: null, size_bytes: 5 },
  ];
  const plan = buildPlan(listing, registry);
  const act = Object.fromEntries(plan.actions.map(a => [a.ref, a.action]));
  const checks = [];
  const ck = (label, cond) => checks.push({ label, ok: !!cond });
  ck('new vCard is registered, not classified by hand',
    act[refOf('syntheticVcfNew000000000000000')] === 'register_new');
  ck('a second copy of identical content becomes a duplicate, not a new customer source',
    act[refOf('syntheticDup000000000000000000')] === 'register_duplicate'
    && plan.actions.find(a => a.ref === refOf('syntheticDup000000000000000000')).duplicate_of_ref === refOf('syntheticZipNew0000000000000000'));
  ck('unchanged file produces no action beyond `unchanged`',
    act[regRef0] === 'unchanged');
  ck('verified content change opens a new version, keeping the old hash on record',
    act[regRef1] === 'register_new_version');
  ck('an unrecognised file is still intaken and routed to manual review',
    plan.actions.find(a => a.ref === refOf('syntheticOther000000000000000'))?.action === 'register_new'
    && plan.actions.find(a => a.ref === refOf('syntheticOther000000000000000'))?.review_status === 'needs_manual_review');
  ck('magic bytes outrank a wrong mime type',
    plan.actions.find(a => a.ref === refOf('syntheticMagic000000000000000'))?.kind === 'zip');
  ck('trashed listing entries are ignored, never deleted from the registry',
    act[refOf('syntheticTrash000000000000000')] === 'ignore_trash');
  ck('a registry row missing from the listing is reported but kept',
    Object.values(act).includes('missing_from_listing') && !plan.actions.some(a => /delete/i.test(a.action)));
  ck('no raw Drive id ever reaches the plan',
    !listing.some(i => JSON.stringify(plan).includes(i.id)));
  ck('every emitted file handle is a sha256 reference',
    plan.actions.every(a => a.ref === null || /^[0-9a-f]{64}$/.test(a.ref)));
  ck('provisional fingerprint can never declare a duplicate',
    plan.actions.filter(a => a.fingerprint_level !== 'content').every(a => a.action !== 'register_duplicate'));
  ck('the plan authorises no CRM write, no link, no merge, no Drive write',
    plan.not_authorized.length === 5 && plan.not_authorized.includes('import_to_crm'));
  ck('idempotent: the same inputs produce the same plan',
    planDigest(buildPlan(listing, registry)) === planDigest(buildPlan(listing, registry)));
  ck('stable under input reordering',
    planDigest(buildPlan([...listing].reverse(), [...registry].reverse())) === planDigest(buildPlan(listing, registry)));
  ck('an empty registry yields only new/duplicate/trash actions',
    Object.values(Object.fromEntries(buildPlan(listing, []).actions.map(a => [a.ref, a.action])))
      .every(v => v === 'register_new' || v === 'register_duplicate' || v === 'ignore_trash'));
  ck('the duplicate verdict does not depend on listing order',
    (() => {
      const m = p => JSON.stringify(Object.fromEntries(p.actions.map(a => [a.ref, a.action])));
      const a = m(buildPlan(listing, []));
      const b = m(buildPlan([...listing].reverse(), []));
      return a === b && JSON.parse(a)[refOf('syntheticDup000000000000000000')] === 'register_duplicate';
    })());
  plan.provenance.plan_sha256 = planDigest(plan);
  const lines = plan.actions.map(a => stableStringify(a)).join('\n') + '\n';
  const masked = lines.replace(/\b[0-9a-f]{40,}\b/g, '"dig"');      // a hex digest is not personal data
  ck('output carries no name, phone, e-mail or key material',
    !/[0-9]{9,}|@[A-Za-z0-9-]+\.(com|net|org|eg)|BEGIN (RSA|EC|OPENSSH)/.test(masked)
    && !lines.includes('vcards_20261101') && !lines.includes('notes.txt'));
  let fail = 0;
  for (const c of checks) { if (!c.ok) fail += 1; process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}\n`); }
  process.stdout.write(`discovery selftest ${checks.length - fail}/${checks.length} ${fail === 0 ? 'ALL_OK' : 'FAILED'}\n`);
  if (fail) process.exit(1);
}

const args = process.argv.slice(2);
const mode = args[0];
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
if (mode === 'selftest') selftest();
else if (mode === 'plan') {
  const plan = buildPlan(readJson(opt('listing')), readJson(opt('registry')));
  plan.provenance.plan_sha256 = planDigest(plan);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
  process.stdout.write('usage: plan --listing f [--registry f] | selftest\n');
  process.exit(2);
}
