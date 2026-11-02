#!/usr/bin/env node
/**
 * The Phase 3 inventory envelope: `p3reg_v1` = ECDH-X25519 + HKDF-SHA256 + AES-256-GCM.
 *
 * Why this module exists: until now the only implementation of this format lived inside
 * `.github/workflows/crm-phase3-registry.yml`, in the *opening* direction, with the sealing done by
 * ad-hoc commands nobody reviewed. That makes the sealed path (`sync_sealed`) untestable offline — and a
 * gate that can only be exercised against a live database is a gate that gets trusted rather than checked.
 * So the codec, the queue-line parsing and the payload shape rules are here, imported by the workflow and
 * exercised by `_worker/tests/crm-drive-registry-envelope.test.mjs` on synthetic payloads.
 *
 * Governance (`CRM_DATA_GOVERNANCE.md` §5.4) is what the shape checks enforce:
 *   - the queue carries *metadata only* — a payload may not carry `content_sha256`, an inner digest, a
 *     processing status or a receipt, because §5.4.2 says metadata is never a content fingerprint. Refusing
 *     it here means an envelope never reaches the database at all, rather than being refused row by row
 *     mid-write;
 *   - plaintext Drive ids, filenames and folder ids appear only inside ciphertext, never in Git — which is
 *     why this file takes a payload path as input and writes a queue file as output, and prints counts only;
 *   - `IDLE` is the resting state of the queue file.
 *
 *   node scripts/crm/drive-registry-envelope.mjs selftest
 *   node scripts/crm/drive-registry-envelope.mjs pubkey    --secret-from-env   # recipient fingerprint
 *   node scripts/crm/drive-registry-envelope.mjs seal      --from payload.json --pubkey <b64url> --out queue.txt
 *   node scripts/crm/drive-registry-envelope.mjs inspect   --in queue.txt      # shape + counts, no plaintext
 *   node scripts/crm/drive-registry-envelope.mjs open      --in queue.txt --secret-from-env   # CI-side check
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { driveRefFor } from './seed-drive-file-refs.mjs';

export const ENVELOPE_PREFIX = 'p3reg_v1';
export const HKDF_INFO = 'p3-reg-aes256gcm';
export const KEY_DERIVATION_LABEL = 'nasr-crm-phase3-drive-registry-envelope-v1';
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The recipient key is derived from a secret that only CI holds, so the same secret always yields the same
 *  key pair and no key material is ever stored in the repository. */
export function deriveKeyPair(secret) {
  const text = String(secret ?? '');
  if (text.length < 16) throw new Error('ENVELOPE_SECRET_TOO_SHORT: refusing to derive a key from that');
  const seed = createHmac('sha256', text).update(KEY_DERIVATION_LABEL).digest();
  const privKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, seed]), format: 'der', type: 'pkcs8',
  });
  const pubKey = createPublicKey(privKey);
  return { privKey, pubSpkiB64u: pubKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
}

function recipientPublicKey(pubSpkiB64u) {
  return createPublicKey({ key: Buffer.from(String(pubSpkiB64u), 'base64url'), format: 'der', type: 'spki' });
}

function aesKeyFrom(shared) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(HKDF_INFO), 32));
}

/** Encrypts the payload for one recipient. Ephemeral key per envelope: no nonce reuse, no forward tracing. */
export function sealEnvelope(payload, pubSpkiB64u) {
  const checked = assertPayloadShape(payload);
  const recipient = recipientPublicKey(pubSpkiB64u);
  const { privateKey: ephemPriv, publicKey: ephemPub } = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemPriv, publicKey: recipient });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', aesKeyFrom(shared), iv);
  const pt = Buffer.from(JSON.stringify(checked), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const raw = Buffer.concat([ct, cipher.getAuthTag()]);
  return [
    ENVELOPE_PREFIX,
    ephemPub.export({ format: 'der', type: 'spki' }).toString('base64url'),
    iv.toString('base64url'),
    raw.toString('base64url'),
  ].join('.');
}

/** Decrypts. A tampered ciphertext fails on the GCM tag, and a wrong recipient key fails on the derive. */
export function openEnvelope(envelope, privKey) {
  const parts = String(envelope || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new Error('invalid_p3_envelope_header');
  }
  const ephemPub = createPublicKey({
    key: Buffer.from(parts[1], 'base64url'), format: 'der', type: 'spki',
  });
  const shared = diffieHellman({ privateKey: privKey, publicKey: ephemPub });
  const raw = Buffer.from(parts[3], 'base64url');
  if (raw.length <= TAG_BYTES) throw new Error('invalid_p3_envelope_length');
  const ct = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', aesKeyFrom(shared), Buffer.from(parts[2], 'base64url'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ------------------------------------------------------------------ the payload contract (fail closed)
const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TOP_KEYS = ['driveParentId', 'items', 'scanTimestamp'];
const ITEM_KEYS = ['drive_file_id', 'file_name', 'mime_type', 'file_size', 'drive_parent_id',
  'drive_created_at', 'drive_modified_at', 'created_time', 'modified_time', 'unreachable',
  'error_code', 'error_message', 'metadata', 'owned_by_me', 'shared', 'name_verified'];
/** Fields that would let a *metadata* envelope write content facts. §5.4.2 says they belong to another phase. */
const CONTENT_KEYS = ['content_sha256', 'contentSha256', 'inner_content_sha256', 'innerContentSha256',
  'processing_status', 'processingStatus', 'processing_receipt_ref', 'processingReceiptRef',
  'extracted_records_count', 'review_status', 'reviewStatus', 'head_version_seq'];
const METADATA_KEYS = ['inventory_source', 'owned_by_me', 'shared', 'name_verified'];
const MAX_ITEMS = 5000;

function fail(reason, where) {
  const e = new Error(`ENVELOPE_PAYLOAD_REJECTED:${reason}`);
  e.where = where;
  throw e;
}

/**
 * Validates the inventory payload. The point of a closed schema here is not tidiness: an envelope is the
 * only untrusted input this path has, and the DB layer's rules are the *second* line. Unknown keys are
 * refused so a future field cannot ride along into a write without a reviewed change to this function.
 */
/** Keys an item may not carry: they belong to a phase that measured bytes. */
function assertItemKeys(item, at) {
  for (const key of Object.keys(item)) {
    if (CONTENT_KEYS.includes(key)) fail(`content-phase field "${key}" in a metadata envelope`, at);
    if (!ITEM_KEYS.includes(key)) fail(`unknown item key "${key}"`, at);
  }
}

/** Everything except the identity check, which the whole file hinges on. */
function assertItemFields(item, at) {
  const name = String(item.file_name ?? '');
  if (!name || name.length > 240 || /[\u0000-\u001f\u007f]/.test(name)) fail('file_name must be 1..240 printable chars', at);
  if (!/^[A-Za-z0-9/+.-]{3,120}$/.test(String(item.mime_type ?? ''))) fail('mime_type is required and must be a simple type', at);
  const size = item.file_size;
  if (!Number.isInteger(size) || size < 0 || size > 5_000_000_000) fail('file_size must be an integer 0..5e9', at);
  for (const key of ['drive_created_at', 'drive_modified_at', 'created_time', 'modified_time']) {
    const value = item[key];
    if (value !== undefined && value !== null && !ISO_RE.test(String(value))) fail(`${key} must be ISO-8601 UTC or absent`, at);
  }
  if (item.metadata !== undefined) assertItemMetadata(item.metadata, at);
}

function assertItemMetadata(metadata, at) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('metadata must be an object', `${at}.metadata`);
  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.includes(key)) fail(`unknown metadata key "${key}"`, `${at}.metadata`);
  }
}

function validateItem(raw, index) {
  const at = `.items[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('item must be an object', at);
  assertItemKeys(raw, at);
  const id = String(raw.drive_file_id ?? '');
  if (!ID_RE.test(id)) fail('drive_file_id must match [A-Za-z0-9_-]{10,64}', at);
  // an unreachable file is a record of a problem, so it is deliberately not held to the fields we could only
  // guess at; everything else has to look like a Drive metadata response.
  if (raw.unreachable !== true) assertItemFields(raw, at);
  return { ...raw, drive_file_id: id };
}

function assertItems(items) {
  if (!Array.isArray(items)) fail('items must be an array', '.items');
  if (items.length === 0) fail('items must not be empty — an empty inventory is a mistake, not a scan', '.items');
  if (items.length > MAX_ITEMS) fail(`items exceeds ${MAX_ITEMS}`, '.items');
  const validated = items.map((item, i) => validateItem(item, i));
  const seen = new Map();
  validated.forEach((item, i) => {
    if (seen.has(item.drive_file_id)) {
      fail(`duplicate drive_file_id at index ${i}, first seen at ${seen.get(item.drive_file_id)}`, '.items');
    }
    seen.set(item.drive_file_id, i);
  });
  return validated;
}

export function assertPayloadShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object', '$');
  for (const k of Object.keys(payload)) if (!TOP_KEYS.includes(k)) fail(`unknown top-level key "${k}"`, '$');
  if (!ID_RE.test(String(payload.driveParentId ?? ''))) fail('driveParentId must match [A-Za-z0-9_-]{10,64}', '.driveParentId');
  if (!ISO_RE.test(String(payload.scanTimestamp ?? ''))) fail('scanTimestamp must be an ISO-8601 UTC instant', '.scanTimestamp');
  return {
    driveParentId: payload.driveParentId,
    items: assertItems(payload.items),
    scanTimestamp: payload.scanTimestamp,
  };
}

/** A summary safe to print in Git, CI or a chat message: counts and digests, never identifiers or names. */
export function describePayload(payload) {
  const p = assertPayloadShape(payload);
  const names = p.items.map(it => it.file_name ?? '');
  return {
    envelope: ENVELOPE_PREFIX,
    items: p.items.length,
    unreachable: p.items.filter(it => it.unreachable === true).length,
    parent_ref: driveRefFor(p.driveParentId).slice(0, 16),
    scanTimestamp: p.scanTimestamp,
    kinds: p.items.reduce((acc, it) => {
      const ext = String(it.file_name ?? '').toLowerCase().split('.').pop() || 'none';
      acc[ext] = (acc[ext] ?? 0) + 1;
      return acc;
    }, {}),
    bytes: p.items.reduce((n, it) => n + (Number(it.file_size) || 0), 0),
    name_shapes: { with_spaces: names.filter(n => /\s/.test(n)).length, non_ascii: names.filter(n => /[^\x20-\x7e]/.test(n)).length },
    payload_sha256: createHash('sha256').update(JSON.stringify(p)).digest('hex'),
  };
}

/**
 * The queue file: comments and blanks ignored, the first content line is the envelope, and `IDLE` means
 * nothing is pending. Extracted from the workflow so the same rules the CI job depends on have tests.
 */
export function readQueueLine(fileText) {
  const lines = String(fileText ?? '').split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return null;
  if (lines[0].toUpperCase() === 'IDLE') return null;
  if (lines.length > 1) throw new Error(`ENVELOPE_QUEUE_AMBIGUOUS: ${lines.length} pending envelopes queued; the path applies one at a time`);
  return lines[0];
}

// ------------------------------------------------------------------ selftest (no network, no database)
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
  const secret = 'synthetic-test-secret-0123456789';
  const other = 'another-synthetic-secret-9876543210';
  const payload = () => ({
    driveParentId: 'SYNTH_PARENT_FOLDER_ID',
    scanTimestamp: '2026-11-03T09:00:00Z',
    items: [
      { drive_file_id: 'SYNTHFILEAAAAAAAAAAAAAAAAAAAA1', file_name: 'one.zip', mime_type: 'application/zip',
        file_size: 1024, created_time: '2026-10-01T09:00:00Z', modified_time: '2026-11-01T09:00:00Z' },
      { drive_file_id: 'SYNTHFILEAAAAAAAAAAAAAAAAAAAA2', file_name: 'two.vcf', mime_type: 'text/x-vcard',
        file_size: 514, created_time: '2026-10-02T09:00:00Z', modified_time: '2026-11-02T09:00:00Z',
        metadata: { name_verified: false } },
      { drive_file_id: 'SYNTHFILEAAAAAAAAAAAAAAAAAAAA3', unreachable: true,
        error_code: 'DRIVE_METADATA_UNREACHABLE', error_message: 'metadata call failed' },
    ],
  });

  check('E1 the derived key pair is deterministic for a secret and shaped as CI prints it', () => {
    const a = deriveKeyPair(secret);
    const b = deriveKeyPair(secret);
    if (a.pubSpkiB64u !== b.pubSpkiB64u) throw new Error('the same secret produced two recipient keys');
    if (deriveKeyPair(other).pubSpkiB64u === a.pubSpkiB64u) throw new Error('two secrets share a key');
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(a.pubSpkiB64u)) throw new Error(`unexpected pubkey shape (${a.pubSpkiB64u.length})`);
    return `fp-${a.pubSpkiB64u.length}:${a.pubSpkiB64u.slice(-6)}`;
  });
  check('E2 a weak secret is refused rather than silently weakened', () => {
    for (const bad of ['', 'short', undefined, null]) {
      let threw = false;
      try { deriveKeyPair(bad); } catch (e) { threw = /ENVELOPE_SECRET_TOO_SHORT/.test(String(e.message)); }
      if (!threw) throw new Error(`accepted secret ${JSON.stringify(bad)}`);
    }
    return 'four shapes refused';
  });
  check('E3 seal → open round-trips the payload exactly', () => {
    const p = payload();
    const { privKey, pubSpkiB64u } = deriveKeyPair(secret);
    const env = sealEnvelope(p, pubSpkiB64u);
    if (env.includes('SYNTHFILE') || env.includes('one.zip')) throw new Error('plaintext leaked into the envelope line');
    const back = openEnvelope(env, privKey);
    if (JSON.stringify(back) !== JSON.stringify(assertPayloadShape(p))) throw new Error('the payload changed in transit');
    return `${env.split('.').length} parts, ${env.length} chars, ${back.items.length} items recovered`;
  });
  check('E4 the wrong recipient key cannot open it', () => {
    const { pubSpkiB64u } = deriveKeyPair(secret);
    const env = sealEnvelope(payload(), pubSpkiB64u);
    let opened = false;
    try { opened = openEnvelope(env, deriveKeyPair(other).privKey) !== null; } catch { opened = false; }
    if (opened) throw new Error('a foreign key opened the envelope');
    return 'refused';
  });
  check('E5 a flipped ciphertext byte is refused by the GCM tag (no silent truncation)', () => {
    const { privKey, pubSpkiB64u } = deriveKeyPair(secret);
    const parts = sealEnvelope(payload(), pubSpkiB64u).split('.');
    const raw = Buffer.from(parts[3], 'base64url');
    raw[0] ^= 0x01;
    parts[3] = raw.toString('base64url');
    let ok = true;
    try { openEnvelope(parts.join('.'), privKey); } catch { ok = false; }
    if (ok) throw new Error('tampering went unnoticed');
    return 'detected';
  });
  check('E6 the header is versioned, and a foreign version is refused', () => {
    const { privKey, pubSpkiB64u } = deriveKeyPair(secret);
    const env = sealEnvelope(payload(), pubSpkiB64u);
    for (const bad of [env.replace(/^p3reg_v1/, 'p3reg_v2'), env.replace(/^p3reg_v1/, 'p4a_v1'), 'IDLE', '', 'a.b.c']) {
      let ok = true;
      try { openEnvelope(bad, privKey); } catch { ok = false; }
      if (ok) throw new Error(`accepted ${JSON.stringify(bad.slice(0, 12))}`);
    }
    return 'four headers refused';
  });
  check('E7 a metadata envelope carrying content facts is refused before encryption', () => {
    for (const extra of [{ content_sha256: 'a'.repeat(64) }, { processing_status: 'processed' },
      { processing_receipt_ref: 'p4a:sha256:' + 'b'.repeat(32) }, { review_status: 'approved' },
      { extracted_records_count: 9 }, { inner_content_sha256: 'c'.repeat(64) }]) {
      const p = payload();
      p.items[0] = { ...p.items[0], ...extra };
      let rejected = false;
      try { assertPayloadShape(p); } catch (e) { rejected = /content-phase field/.test(String(e.message)); }
      if (!rejected) throw new Error(`a content field slipped through: ${JSON.stringify(extra).slice(0, 40)}`);
    }
    return 'six content fields refused at the envelope';
  });
  check('E8 unknown keys, junk ids and bad timestamps are refused (closed schema)', () => {
    const cases = [
      [p => { p.surprise = 1; }, 'unknown top-level key'],
      [p => { p.items[0].download_url = 'https://x'; }, 'unknown item key'],
      [p => { p.driveParentId = 'short'; }, 'driveParentId'],
      [p => { p.items[0].drive_file_id = 'has space'; }, 'drive_file_id'],
      [p => { p.items[0].file_size = '1024'; }, 'file_size'],
      [p => { p.items[0].modified_time = 'yesterday'; }, 'must be ISO-8601'],
      [p => { p.items[0].mime_type = 'application/zip; charset=\\'; }, 'mime_type'],
      [p => { p.items = []; }, 'must not be empty'],
      [p => { p.items[0].metadata = { anything: 1 }; }, 'unknown metadata key'],
      [p => { p.items.push({ ...p.items[0] }); }, 'duplicate drive_file_id'],
    ];
    for (const [mutate, needle] of cases) {
      const p = payload();
      mutate(p);
      let msg = '';
      try { assertPayloadShape(p); msg = 'ACCEPTED'; } catch (e) { msg = String(e.message); }
      if (!msg.includes(needle)) throw new Error(`${needle}: got "${msg.slice(0, 80)}"`);
    }
    return 'ten shapes refused';
  });
  check('E9 an unreachable item needs no name/size, because inventing either would be fabrication', () => {
    const p = payload();
    p.items = [{ drive_file_id: 'SYNTHFILEAAAAAAAAAAAAAAAAAAAA9', unreachable: true }];
    const out = assertPayloadShape(p);
    if (out.items[0].file_size !== undefined) throw new Error('a default size was invented');
    return 'accepted as-is';
  });
  check('E10 describePayload prints counts without identifiers, names or the folder id', () => {
    const d = describePayload(payload());
    const text = JSON.stringify(d);
    for (const banned of ['SYNTHFILE', 'SYNTH_PARENT', 'one.zip', 'two.vcf']) {
      if (text.includes(banned)) throw new Error(`${banned} leaked into the summary`);
    }
    if (d.items !== 3 || d.unreachable !== 1 || d.envelope !== ENVELOPE_PREFIX) throw new Error(`wrong counts: ${text.slice(0, 120)}`);
    if (!/^[0-9a-f]{16}$/.test(d.parent_ref)) throw new Error('no hashed parent ref');
    if (!/^[0-9a-f]{64}$/.test(d.payload_sha256)) throw new Error('no payload digest');
    return `items=${d.items} kinds=${JSON.stringify(d.kinds)} sha=${d.payload_sha256.slice(0, 8)}…`;
  });
  check('E11 the queue file rules — comments, blank lines, IDLE, and only one pending envelope', () => {
    if (readQueueLine('# note\nIDLE\n') !== null) throw new Error('IDLE should read as nothing pending');
    if (readQueueLine('\n\n#only comments\n') !== null) throw new Error('a comment-only file is not an envelope');
    if (readQueueLine('p3reg_v1.aa.bb.cc\n') !== 'p3reg_v1.aa.bb.cc') throw new Error('a queued envelope was not picked up');
    let ambiguous = false;
    try { readQueueLine('p3reg_v1.1.1.1\np3reg_v1.2.2.2\n'); } catch { ambiguous = true; }
    if (!ambiguous) throw new Error('two pending envelopes must be refused, not silently ordered');
    return 'IDLE/comments/one-pending enforced';
  });
  check('E12 sealing is non-deterministic per envelope, so a queue line is not a fingerprint of its payload', () => {
    const { pubSpkiB64u } = deriveKeyPair(secret);
    const a = sealEnvelope(payload(), pubSpkiB64u);
    const b = sealEnvelope(payload(), pubSpkiB64u);
    if (a === b) throw new Error('the same payload sealed to the same ciphertext: an ephemeral key is missing');
    return 'two seals of one payload differ';
  });
  check('E13 the CLI never reads a secret from argv (it would land in shell history and CI logs)', () => {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*[*\/]/.test(l)).join('\n');
    // built at runtime so this line is not itself a match for the pattern it forbids
    const secretFlag = '--' + 'secret';
    if (new RegExp(`${secretFlag}(?![-a-z])`).test(code)) {
      // the message is assembled so reading this file never re-triggers the rule it enforces
      throw new Error(`a ${secretFlag} flag exists; secrets come from the environment only`);
    }
    if (/\bfetch\s*\(/.test(code)) throw new Error('this module must not make network calls — it only transforms files');
    if (/cloudflare\.com/.test(code)) throw new Error('a Cloudflare endpoint appears in a codec that must stay offline');
    return 'file-in/file-out only, no argv secret';
  });
  return checks;
}

function flags(argv) {
  return name => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
}

/** The recipient key is derived from a secret that lives only in the environment — never argv, where it
 *  would land in shell history and in a CI command echo. */
function secretFromEnvironment() {
  const value = process.env.CLOUDFLARE_API_TOKEN ?? process.env.ENVELOPE_TEST_SECRET;
  if (!value) throw new Error('no secret in the environment (CLOUDFLARE_API_TOKEN in CI, ENVELOPE_TEST_SECRET locally)');
  return value;
}

function runSelftest() {
  const checks = selftest();
  const held = checks.filter(c => c[0]).length;
  for (const c of checks) process.stdout.write(`${c[0] ? 'ok  ' : 'FAIL'} ${c[1]}${c[2] ? ' — ' + c[2] : ''}\n`);
  process.stdout.write(`\nP3_ENVELOPE ${held}/${checks.length} checks held\n`);
  if (held !== checks.length) {
    const missing = checks.filter(c => !c[0]).map(c => `  - ${c[1]} (${c[2]})`).join('\n');
    process.stdout.write(`P3_ENVELOPE_BARRIERS_MISSING:\n${missing}\n`);
    return 1;
  }
  process.stdout.write('P3_ENVELOPE_ALL_HELD\n');
  return 0;
}

function runSeal(flag) {
  const from = flag('--from');
  const to = flag('--out');
  const pub = flag('--pubkey') ?? readFileSync(flag('--pubkey-file'), 'utf8').trim();
  if (!from || !to || !pub) {
    throw new Error('usage: seal --from payload.json --pubkey <b64url>|--pubkey-file <path> --out queue.txt');
  }
  const payload = JSON.parse(readFileSync(from, 'utf8'));
  writeFileSync(to, `# sealed Drive metadata registry queue — read-only in Git, applied once then returned to IDLE.\n${sealEnvelope(payload, pub)}\n`);
  process.stdout.write(`${JSON.stringify(describePayload(payload), null, 2)}\n`);
  return 0;
}

function runOpen(flag) {
  const { privKey } = deriveKeyPair(secretFromEnvironment());
  const line = readQueueLine(readFileSync(flag('--in'), 'utf8'));
  if (!line) {
    process.stdout.write('queue=IDLE (nothing pending)\n');
    return 0;
  }
  // CI-side only, and it reports the shape summary — never the payload it just decrypted
  process.stdout.write(`${JSON.stringify(describePayload(openEnvelope(line, privKey)))}\n`);
  return 0;
}

function runInspect(flag) {
  const line = readQueueLine(readFileSync(flag('--in'), 'utf8'));
  if (!line) {
    process.stdout.write('queue=IDLE (nothing pending)\n');
    return 0;
  }
  process.stdout.write(`queued envelope: ${line.split('.')[0]}, ${line.length} chars, ${line.split('.').length} parts\n`);
  return 0;
}

const COMMANDS = {
  selftest: () => runSelftest(),
  pubkey: () => {
    process.stdout.write(`${deriveKeyPair(secretFromEnvironment()).pubSpkiB64u}\n`);
    return 0;
  },
  seal: argv => runSeal(flags(argv)),
  open: argv => runOpen(flags(argv)),
  inspect: argv => runInspect(flags(argv)),
};

function main(argv) {
  const handler = COMMANDS[argv[0]];
  if (!handler) {
    process.stdout.write('usage: drive-registry-envelope.mjs selftest | pubkey | seal | inspect | open\n');
    return 2;
  }
  return handler(argv);
}

if (process.argv[1] && process.argv[1].endsWith('drive-registry-envelope.mjs')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${String(e.message || e).slice(0, 200)}\n`);
    process.exitCode = 1;
  }
}
