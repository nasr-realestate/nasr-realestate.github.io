#!/usr/bin/env node
/**
 * Drive WhatsApp exports → the exact `sync_bundle` that /api/ingest/sealed accepts.
 *
 * The worker already knows how to parse a WhatsApp export (`parseWhatsAppExport`)
 * and already knows how to store it (`runSourceSyncBundle`). Neither is touched
 * here. What was missing is the step in between: two storerooms that do not use
 * the same name for the same person.
 *
 *   - the chat is called "‏دردشة في واتساب مع 🔴 حازم محل 80 م في جسر السويس…"
 *   - the phone book calls him "حازم عبد العال"
 *
 * The worker matches conversations to contacts by EXACT canonical name, so every
 * renamed export lands in `unmatched_review` — that is the `unknown` this import
 * exists to drive to zero. The fix belongs here, not in the worker: this script
 * resolves the name against the exported phone book, and only then hands the
 * worker a title it can match. The worker stays strict; the resolution stays
 * visible and reviewable in the report.
 *
 * Rules:
 *   - never guess. A name that resolves to 0 or 2+ contacts is reported as
 *     unresolved with its reason, and is imported with its original title so a
 *     human can place it. Nothing is invented, nothing is merged silently.
 *   - never leak. Output holds real client names; write it outside the
 *     repository entirely — `imports/` is git-ignored, but the privacy canary
 *     scans the working tree, and it is right to: a downloaded .vcf in the repo
 *     directory is a phone book on disk whether or not git sees it.
 *   - idempotent. `conversation_uid` derives from the text hash, so re-running
 *     the same folder cannot create a second copy of the same chat.
 *
 * Usage:
 *   node scripts/crm/build-whatsapp-import.mjs --dir ./imports/drive-crm --out ./imports/bundle.json
 *   node scripts/crm/build-whatsapp-import.mjs --dir ./imports/drive-crm --out ./imports/b.json --batch 10
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseWhatsAppExport, cleanBidiControls, normalizeInternationalPhone } from '../../_worker/crm-chat-intel.js';
import { canonSyncKey } from '../../_worker/crm-sync-and-match.js';

/** GitHub caps a workflow_dispatch payload at 65,535 characters for all inputs. */
export const DISPATCH_INPUT_LEDGER_BYTES = 65_535;
/** Sealing costs ~1.33× in base64 before the AES/RSA overhead. */
export const SEAL_OVERHEAD = 1.42;
export const DEFAULT_BATCH = 10;

// ---------------------------------------------------------------------------
// phone book
// ---------------------------------------------------------------------------

/**
 * Arabic that differs only in how it was typed is the same name. Remove the
 * tatweel, unify alef/ya/ta-marbuta and drop diacritics before comparing — but
 * never before displaying; the stored name keeps its original spelling.
 */
export function normalizeArabicName(value) {
  return cleanBidiControls(value)
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Words that carry no identity in a chat title: titles, filler, property words. */
const NOISE_TOKENS = new Set([
  'ا', 'أ', 'ال', 'د', 'دكتور', 'دكتورة', 'م', 'مهندس', 'مهندسه', 'استاذ', 'استاذه', 'أستاذ',
  'حاج', 'حاجه', 'الحاج', 'الاستاذ', 'مدام', 'انسه', 'ابو', 'ام', 'امام', 'و', 'مع',
  'متر', 'م٢', 'م2', 'شقه', 'شقق', 'محل', 'محلات', 'مخزن', 'مقر', 'اداري', 'ادارى', 'عقار',
  'ايجار', 'للبيع', 'للإيجار', 'للايجار', 'مفروش', 'مفروشه', 'دور', 'ارضي', 'اول', 'تاني', 'تانى', 'ثالث',
  'غرف', 'غرفه', 'اوض', 'اوضه', 'سعر', 'مليون', 'الف', 'الفين', 'مليون', 'جديد', 'جديده', 'قديم',
]);

export function nameTokens(value) {
  return normalizeArabicName(value)
    .split(' ')
    .filter((t) => t.length >= 2 && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * vCard 2.1 predates UTF-8 in practice: Arabic names arrive as
 * `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=A7=D8=A8=D9=88`. Read literally
 * that is not a name, it is its own bytes — and every contact would silently
 * fail to match. Decode it, with the soft line breaks QP allows.
 */
export function decodeQuotedPrintable(value) {
  const raw = String(value ?? '');
  if (!/=[0-9A-Fa-f]{2}/.test(raw)) return raw;
  const joined = raw.replaceAll(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Parse an exported vCard file into the shape `normalizeVcfSyncItem` expects. */
export function parseVcfContacts(text, sourceRef = 'vcf') {
  // Order matters. A quoted-printable value breaks with "=" + newline (no space);
  // a vCard fold breaks with newline + space. Joining the QP break first is what
  // keeps a UTF-8 name from being cut in the middle of a byte sequence.
  const unfolded = String(text || '')
    .replaceAll(/=\r?\n/g, '')
    .replaceAll(/\r?\n[ \t]/g, '');
  const out = [];
  for (const block of unfolded.split(/END:VCARD/i)) {
    const fn = /^FN[^:]*:(.*)$/im.exec(block);
    const name = cleanBidiControls(decodeQuotedPrintable(fn ? fn[1] : '')).trim();
    const phones = [];
    const seen = new Set();
    for (const m of block.matchAll(/^TEL[^:]*:(.*)$/gim)) {
      const raw = cleanBidiControls(decodeQuotedPrintable(m[1])).trim();
      const e164 = normalizeInternationalPhone(raw);
      if (!e164 || seen.has(e164)) continue;
      seen.add(e164);
      phones.push({ e164, raw, label: 'أساسي (VCF)', source_ref: sourceRef });
    }
    const org = /^ORG[^:]*:(.*)$/im.exec(block);
    if (!name && phones.length === 0) continue;
    out.push({
      fn: name,
      phones,
      vcf_files: [sourceRef],
      ...(org ? { org: cleanBidiControls(org[1]).trim() } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolution — the whole point of this file
// ---------------------------------------------------------------------------

/**
 * Decide which phone-book contact owns a chat. Returns
 *   { contact, method }            on a confident single match
 *   { contact: null, reason, candidates }  otherwise
 *
 * Confidence ladder, strongest first. Each rung requires a UNIQUE candidate;
 * the moment two contacts qualify, we stop and report — a wrong merge is worse
 * than an unresolved chat, because a wrong merge writes one man's conversation
 * onto another man's record.
 */
export function resolveChatOwner({ title, peerSenderName, peerPhoneNorm }, contacts) {
  const byPhone = new Map();
  for (const c of contacts) {
    for (const p of c.phones || []) if (!byPhone.has(p.e164)) byPhone.set(p.e164, c);
  }
  if (peerPhoneNorm && byPhone.has(peerPhoneNorm)) {
    return { contact: byPhone.get(peerPhoneNorm), method: 'phone:peer-sender' };
  }

  const exact = exactNameMatch(peerSenderName, contacts) || exactNameMatch(title, contacts);
  if (exact) return exact;

  // Two probes, in order of trust: the name WhatsApp itself printed in the
  // transcript, then the name the broker typed into the file name. A phone-book
  // entry only has to be covered by ONE probe — he is called "حازم عبد العال"
  // in the phone book and "حازم" in the chat, and that is the same man.
  const probes = [nameTokens(peerSenderName), nameTokens(title)].filter((t) => t.length > 0);

  let diagnostic = { contact: null, reason: 'no-name-tokens', candidates: [] };
  for (const probe of probes) {
    const verdict = scoreAgainstPhoneBook(probe, contacts);
    if (verdict.contact) return verdict;
    // An ambiguity is the most useful thing to report; never overwrite it.
    if (verdict.reason === 'ambiguous') return verdict;
    diagnostic = verdict;
  }
  return diagnostic;
}

/** Two entries are the same man when they carry the same numbers. */
function sameNumbers(a, b) {
  const pa = [...new Set((a.phones || []).map((p) => p.e164))].sort().join(',');
  const pb = [...new Set((b.phones || []).map((p) => p.e164))].sort().join(',');
  return pa !== '' && pa === pb;
}

function exactNameMatch(name, contacts) {
  const key = canonSyncKey(name);
  if (!key) return null;
  const hits = contacts.filter((c) => canonSyncKey(c.fn) === key);
  if (hits.length === 1) return { contact: hits[0], method: 'name:exact' };
  // A 3000-contact book repeats people. Two rows with one name and one set of
  // numbers are one man saved twice, not an ambiguity to refuse — but two rows
  // with different numbers are two men, and that stays unanswered.
  if (hits.length > 1 && hits.every((h) => sameNumbers(h, hits[0]))) {
    return { contact: hits[0], method: 'name:exact-duplicate' };
  }
  return null;
}

function scoreAgainstPhoneBook(probe, contacts) {
  const scored = [];
  for (const c of contacts) {
    const ct = nameTokens(c.fn);
    if (ct.length === 0) continue;
    const shared = ct.filter((t) => probe.includes(t)).length;
    if (shared === 0) continue;
    // Either the whole phone-book name is in the probe, or the whole probe is
    // in the phone-book name. "محمد" inside a long title is not a match.
    const coversContact = shared / ct.length;
    const coversProbe = shared / probe.length;
    if (coversContact < 1 && coversProbe < 1) continue;
    scored.push({ contact: c, shared, covers: Math.max(coversContact, coversProbe) });
  }

  if (scored.length === 0) return { contact: null, reason: 'no-name-match', candidates: [] };

  scored.sort((a, b) => b.covers - a.covers || b.shared - a.shared);
  const best = scored[0];
  const rivals = scored.filter((s) => s.covers === best.covers && s.shared === best.shared);
  if (rivals.length > 1) {
    return { contact: null, reason: 'ambiguous', candidates: rivals.slice(0, 5).map((r) => r.contact.fn) };
  }
  if (best.covers < 1) return { contact: null, reason: 'partial-only', candidates: [best.contact.fn] };
  return { contact: best.contact, method: 'name:tokens' };
}

// ---------------------------------------------------------------------------
// reading the folder
// ---------------------------------------------------------------------------

/** Read the transcript out of a WhatsApp export zip without unpacking to disk. */
/** Absolute, so a caller cannot have PATH decide which unzip runs. */
const UNZIP_BIN = process.env.UNZIP_BIN || '/usr/bin/unzip';

export function readChatTextFromZip(zipPath) {
  const names = execFileSync(UNZIP_BIN, ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.some((n) => n.startsWith('__MACOSX/'))) {
    throw new Error(`zip-with-macosx-junk:${path.basename(zipPath)}`);
  }
  const chats = names.filter((e) => /\.txt$/i.test(e));
  if (chats.length === 0) throw new Error(`zip-without-txt:${path.basename(zipPath)}`);
  if (chats.length > 1) throw new Error(`zip-with-many-txt:${path.basename(zipPath)}`);
  // Extract by bulk, never by name: WhatsApp stores the transcript's file name in
  // the legacy OEM code page, so passing that name back to unzip cannot match it
  // (it comes out as question marks). The content itself is UTF-8 and intact.
  return { text: execFileSync(UNZIP_BIN, ['-p', zipPath], { encoding: 'utf8' }), entry: chats[0] };
}

export function listInputs(dir) {
  const files = fs.readdirSync(dir);
  return {
    vcf: files.filter((f) => /\.vcf$/i.test(f)).sort().map((f) => path.join(dir, f)),
    chats: files
      .filter((f) => /\.(zip|txt)$/i.test(f) && !/^bundle/i.test(f))
      .sort()
      .map((f) => path.join(dir, f)),
  };
}

/** Deterministic, collision-free id for a transcript. */
export function conversationUidFrom(rawSha256) {
  return `wadrive:${String(rawSha256).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/**
 * The same person is exported again in every vCard file the broker saves.
 * Collapse them once, by canonical name + numbers, so the bundle carries people
 * and not archive copies.
 */
export function dedupeContacts(contacts) {
  const byKey = new Map();
  for (const c of contacts) {
    const numbers = [...new Set((c.phones || []).map((p) => p.e164))].sort().join(',');
    const key = `${canonSyncKey(c.fn)}|${numbers}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.vcf_files = [...new Set([...(existing.vcf_files || []), ...(c.vcf_files || [])])];
      continue;
    }
    byKey.set(key, { ...c });
  }
  return [...byKey.values()];
}

export async function buildBundle({ vcfTexts, chatSources, sourceDirLabel = 'drive', contactsInBundle = 'matched' }) {
  const contacts = dedupeContacts(vcfTexts.flatMap(({ name, text }) => parseVcfContacts(text, name)));
  const referenced = new Map();

  const conversations = [];
  const report = [];

  for (const { label, text } of chatSources) {
    const parsed = await parseWhatsAppExport(text, { chatTitle: label });
    const title = cleanBidiControls(parsed.chatTitle) || label;
    const found = resolveChatOwner(
      { title, peerSenderName: parsed.peerSenderName, peerPhoneNorm: parsed.peerPhoneNorm },
      contacts,
    );

    // The worker matches on the canonical name, so a resolved chat is handed the
    // phone book's spelling; an unresolved one keeps its own and is marked.
    const wireTitle = found.contact ? found.contact.fn : title;
    if (found.contact) referenced.set(found.contact.fn, found.contact);

    conversations.push({
      title: wireTitle,
      sig: parsed.rawSha256.slice(0, 16),
      conversation_uid: conversationUidFrom(parsed.rawSha256),
      raw_txt: parsed.rawText,
      source_ref: `${sourceDirLabel}:${label}`,
      first_message_at: parsed.firstMessageAt,
      last_message_at: parsed.lastMessageAt,
    });

    report.push({
      file: label,
      chat_title: title,
      peer_sender: parsed.peerSenderName || null,
      messages: parsed.messages.length,
      first: parsed.firstMessageAt,
      last: parsed.lastMessageAt,
      resolved_to: found.contact ? found.contact.fn : null,
      method: found.method || null,
      reason: found.reason || null,
      candidates: found.candidates || [],
      warnings: parsed.parseWarnings.map((w) => w.code),
    });
  }

  // The phone book is a dictionary, not a client list: 3000 entries exist so that
  // ten conversations can be identified. Only the identified ones travel.
  const shipped = contactsInBundle === 'all' ? contacts : [...referenced.values()];

  return {
    bundle: { vcf_contacts: shipped, conversations, dry_run: true },
    report,
    stats: { contacts_in_phone_book: contacts.length, contacts_shipped: shipped.length },
  };
}

export function summarize(report) {
  const resolved = report.filter((r) => r.resolved_to);
  const unresolved = report.filter((r) => !r.resolved_to);
  const methods = {};
  for (const r of resolved) methods[r.method] = (methods[r.method] || 0) + 1;
  const reasons = {};
  for (const r of unresolved) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return {
    chats: report.length,
    resolved: resolved.length,
    unknown: unresolved.length,
    messages: report.reduce((n, r) => n + r.messages, 0),
    methods,
    reasons,
  };
}

/** Split into dispatch-sized batches by real sealed byte size, not by count. */
export function batchBundle(bundle, { batch = DEFAULT_BATCH, budgetBytes = DISPATCH_INPUT_LEDGER_BYTES } = {}) {
  const chunks = [];
  let current = [];
  let used = 0;
  const limit = Math.floor(budgetBytes / SEAL_OVERHEAD);
  for (const conv of bundle.conversations) {
    const size = Buffer.byteLength(JSON.stringify(conv), 'utf8');
    if (current.length > 0 && (current.length >= batch || used + size > limit)) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(conv);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((conversations) => ({ ...bundle, conversations }));
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const dir = get('--dir');
  if (!dir) {
    console.error('usage: build-whatsapp-import.mjs --dir <folder> --out <file> [--batch N]');
    process.exit(2);
  }
  const out = get('--out', path.join(dir, 'bundle.json'));
  const batch = Number(get('--batch', String(DEFAULT_BATCH)));

  const inputs = listInputs(dir);
  const vcfTexts = inputs.vcf.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
  const chatSources = inputs.chats.map((f) => ({
    label: path.basename(f),
    text: /\.zip$/i.test(f) ? readChatTextFromZip(f).text : fs.readFileSync(f, 'utf8'),
  }));

  const { bundle, report, stats } = await buildBundle({
    vcfTexts, chatSources, sourceDirLabel: path.basename(dir), contactsInBundle: get('--contacts', 'matched'),
  });
  const summary = summarize(report);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const chunks = batch ? batchBundle(bundle, { batch }) : [bundle];
  chunks.forEach((chunk, i) => {
    const suffix = `-${String(i + 1).padStart(2, '0')}.json`;
    const file = chunks.length === 1 ? out : out.replace(/\.json$/, suffix);
    fs.writeFileSync(file, `${JSON.stringify(chunk)}\n`, 'utf8');
  });
  fs.writeFileSync(`${out.replace(/\.json$/, '')}.report.json`, `${JSON.stringify({ summary, report }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ...summary,
    contacts_in_phone_book: stats.contacts_in_phone_book,
    contacts_shipped: stats.contacts_shipped,
    batches: chunks.length,
    batch_sizes: chunks.map((c) => c.conversations.length),
  }, null, 2));

  for (const r of report.filter((x) => !x.resolved_to)) {
    const hint = r.candidates.length ? ` → ${r.candidates.join(' | ')}` : '';
    console.log(`UNRESOLVED  ${r.reason.padEnd(16)} ${r.chat_title.slice(0, 60)}${hint}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`import-build-failed: ${err.message}`);
    process.exit(1);
  });
}
