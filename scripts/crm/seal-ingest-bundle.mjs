#!/usr/bin/env node
/**
 * Seal an import bundle the way the worker opens it: RSA-OAEP-4096 wraps a
 * one-time AES-256-GCM key, the payload travels as `enc_v1.<wrapped>.<iv>.<cipher>`.
 *
 * The plaintext — a phone book and real client conversations — never leaves this
 * machine. Only the envelope is handed to GitHub, which is why the repository can
 * stay public while the data stays private.
 *
 * Usage:
 *   node scripts/crm/seal-ingest-bundle.mjs --bundle bundle.json --pubkey <spki-b64url> --out envelope.txt
 *   node scripts/crm/seal-ingest-bundle.mjs --bundle bundle.json --pubkey ... --dry-run false
 */
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENVELOPE_PREFIX = 'enc_v1';

export function b64u(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromB64u(text) {
  const s = String(text || '').replaceAll('-', '+').replaceAll('_', '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}

/**
 * The worker reads `sync_bundle` at the top level and takes `dry_run` from beside
 * it, so a bundle is wrapped exactly once — here, not by hand at the call site.
 */
export function toPayload(bundle, { dryRun } = {}) {
  const { dry_run: bundleDryRun, ...rest } = bundle;
  return {
    sync_bundle: rest,
    dry_run: dryRun === undefined ? bundleDryRun === true : dryRun === true,
  };
}

export async function sealPayload(payload, publicKeySpkiB64u) {
  const spki = fromB64u(publicKeySpkiB64u);
  if (!spki.length) throw new Error('empty-public-key');
  const rsaPub = await crypto.subtle.importKey(
    'spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
  );
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaPub, await crypto.subtle.exportKey('raw', aesKey));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(payload)));
  return `${ENVELOPE_PREFIX}.${b64u(wrapped)}.${b64u(iv)}.${b64u(cipher)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
  };
  const bundlePath = get('--bundle');
  const pubkey = get('--pubkey');
  if (!bundlePath || !pubkey) {
    console.error('usage: seal-ingest-bundle.mjs --bundle <json> --pubkey <spki-b64url> [--out <file>] [--dry-run true|false]');
    process.exit(2);
  }
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const dryFlag = get('--dry-run', undefined);
  const payload = toPayload(bundle, { dryRun: dryFlag === undefined ? undefined : dryFlag === 'true' });
  const envelope = await sealPayload(payload, pubkey);

  const out = get('--out', '');
  if (out) fs.writeFileSync(out, `${envelope}\n`, { mode: 0o600 });
  // Only the envelope is safe to print; the length is what the dispatch limit cares about.
  console.log(JSON.stringify({
    conversations: payload.sync_bundle.conversations?.length ?? 0,
    contacts: payload.sync_bundle.vcf_contacts?.length ?? 0,
    dry_run: payload.dry_run,
    envelope_chars: envelope.length,
    within_dispatch_limit: envelope.length <= 65_535,
    written_to: out ? path.basename(out) : null,
  }, null, 2));
  if (!out) console.log(envelope);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`seal-failed: ${err.message}`);
    process.exit(1);
  });
}
