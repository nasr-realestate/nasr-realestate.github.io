#!/usr/bin/env node
/** Local-only batch preparation. Never dispatches or writes to CRM.
 * A conversation is never split: splitting changes message sequence identities.
 * No contacts are included until phone-based identity and exclusion are verified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealPayload, toPayload } from '../crm/seal-ingest-bundle.mjs';
import { parseWhatsAppExport, normalizeInternationalPhone } from '../../_worker/crm-chat-intel.js';
import { validateAntixMetadata, MAX_ANTIX_TITLE_LENGTH } from '../../_worker/crm-antix-metadata-write.js';

export const MAX_DISPATCH_CHARS = 65535;
export const MAX_CONVERSATIONS = 10;
export const MAX_RAW_BYTES = 4 * 1024 * 1024;

function validateBundle(bundle, limit, batchSize) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISPATCH_CHARS || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_CONVERSATIONS) {
    throw new Error('invalid-batch-limits');
  }
  if (!bundle || !Array.isArray(bundle.conversations) || !bundle.conversations.length ||
      !Array.isArray(bundle.vcf_contacts) || bundle.vcf_contacts.length !== 0) {
    throw new Error('expected-conversations-with-no-contacts');
  }
  const seen = new Set();
  for (const conv of bundle.conversations) {
    if (!conv || typeof conv.conversation_uid !== 'string' || !conv.conversation_uid.trim() ||
        typeof conv.raw_txt !== 'string' || !conv.raw_txt.trim() || seen.has(conv.conversation_uid)) {
      throw new Error('missing-or-duplicate-conversation-identity');
    }
    seen.add(conv.conversation_uid);
  }
}

/** Only structured timestamps/counts and verified source phone leave this machine. */
export async function extractMetadata(conv) {
  const phone = conv.selected_phone;
  const title = conv.title;
  if (typeof phone !== 'string' || !/^\+\d{8,15}$/.test(phone) ||
      normalizeInternationalPhone(phone) !== phone.slice(1) || typeof title !== 'string' ||
      !title.trim() || title.trimStart().startsWith('🌀') || title.length > MAX_ANTIX_TITLE_LENGTH ||
      Buffer.byteLength(conv.raw_txt, 'utf8') > MAX_RAW_BYTES) {
    throw new Error('invalid-source-metadata');
  }
  const parsed = await parseWhatsAppExport(conv.raw_txt, { chatTitle: title });
  if (!parsed.messages.length || parsed.parseWarnings.some(w => w.code === 'plain_text_fallback')) {
    throw new Error('unparseable-transcript');
  }
  return {
    conversation_uid: conv.conversation_uid,
    selected_phone: phone,
    title,
    message_count: parsed.messages.length,
    first_message_at: parsed.firstMessageAt,
    last_message_at: parsed.lastMessageAt,
    raw_sha256: parsed.rawSha256,
  };
}

async function extractValidatedMetadata(conversations) {
  const structured = [];
  const phones = new Set();
  for (const conversation of conversations) {
    const metadata = await extractMetadata(conversation);
    validateAntixMetadata([metadata]);
    if (phones.has(metadata.selected_phone)) throw new Error('duplicate-phone');
    phones.add(metadata.selected_phone);
    structured.push(metadata);
  }
  return structured;
}

export async function sealMetadataBatches(bundle, publicKey, { limit = MAX_DISPATCH_CHARS, batchSize = MAX_CONVERSATIONS, writeBackupRef = null } = {}) {
  validateBundle(bundle, limit, batchSize);
  const structured = await extractValidatedMetadata(bundle.conversations);
  const isWrite = writeBackupRef !== null;
  if (isWrite && (typeof writeBackupRef !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(writeBackupRef))) {
    throw new Error('invalid-backup-reference');
  }
  const make = async (conversations) => sealPayload(toPayload({
    conversations, vcf_contacts: [], dry_run: !isWrite,
    ...(isWrite ? { antix_mode: 'metadata_only_v1', backup_verified_ref: writeBackupRef } : {}),
  }, { dryRun: !isWrite }), publicKey);
  const out = [];
  let pending = [];
  let current = '';
  for (const conversation of structured) {
    const candidate = [...pending, conversation];
    if (candidate.length <= batchSize) {
      const encrypted = await make(candidate);
      if (encrypted.length <= limit) {
        pending = candidate;
        current = encrypted;
        continue;
      }
    }
    if (pending.length) out.push({ envelope: current, conversations: pending.length });
    pending = [conversation];
    current = await make(pending);
    if (current.length > limit) throw new Error('single-conversation-exceeds-limit');
  }
  if (pending.length) out.push({ envelope: current, conversations: pending.length });
  return out;
}

// This API intentionally cannot be switched into write mode by caller options.
export function sealDryRunBatches(bundle, publicKey, { limit = MAX_DISPATCH_CHARS, batchSize = MAX_CONVERSATIONS } = {}) {
  return sealMetadataBatches(bundle, publicKey, { limit, batchSize });
}

function outsideRepo(target) {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const absolute = fs.realpathSync(target);
  if (absolute === repo || absolute.startsWith(`${repo}${path.sep}`)) throw new Error('private-path-required');
  return absolute;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 && !(args.length === 5 && args[3] === '--write-ref-file')) throw new Error('invalid arguments');
  const input = args[0] === '--stdin' ? null : outsideRepo(args[0]);
  const [pubkey, output] = args.slice(1, 3).map(outsideRepo);
  const dirStat = fs.statSync(output);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) || fs.readdirSync(output).length) throw new Error('output-dir-must-be-private-and-empty');
  const bundle = JSON.parse(fs.readFileSync(input ?? 0, 'utf8'));
  const key = fs.readFileSync(pubkey, 'utf8').trim();
  let ref = null;
  if (args.length === 5) {
    const refFile = outsideRepo(args[4]);
    if (!fs.statSync(refFile).isFile() || (fs.statSync(refFile).mode & 0o077)) throw new Error('private-ref-required');
    ref = fs.readFileSync(refFile, 'utf8').trim();
  }
  const batches = await sealMetadataBatches(bundle, key, { writeBackupRef: ref });
  const written = [];
  try {
    for (let i = 0; i < batches.length; i++) {
      const target = path.join(output, `${ref === null ? 'dry-run' : 'write'}-${String(i + 1).padStart(4, '0')}.txt`);
      fs.writeFileSync(target, batches[i].envelope + '\n', { mode: 0o600, flag: 'wx' });
      written.push(target);
    }
  } catch (error) {
    for (const target of written) fs.unlinkSync(target);
    throw error;
  }
  console.log(JSON.stringify({ mode: ref === null ? 'dry_run_only' : 'write_envelopes_only', batches: batches.length,
    conversations: batches.reduce((n, b) => n + b.conversations, 0), max_envelope_chars: Math.max(...batches.map(b => b.envelope.length)) }));
  console.log('BATCH_PLAN_OK_NO_DISPATCH');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    // Never print an exception that may include an input path or customer data.
    console.error('BATCH_PLAN_FAILED_NO_DISPATCH');
    process.exitCode = 1;
  });
}
