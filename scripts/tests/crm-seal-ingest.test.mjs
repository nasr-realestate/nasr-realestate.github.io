import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { sealPayload, toPayload, b64u } from '../crm/seal-ingest-bundle.mjs';

const ENVELOPE_RE = /^enc_v1\.([A-Za-z0-9_-]{64,1200})\.([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{24,12000000})$/;

async function keyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeySpki: b64u(new Uint8Array(spki)) };
}

test('SEAL-1 the envelope matches the pattern the worker accepts', async () => {
  const { publicKeySpki } = await keyPair();
  const envelope = await sealPayload({ entries: [] }, publicKeySpki);
  assert.match(envelope, ENVELOPE_RE);
});

test('SEAL-2 what is sealed is what the worker will unseal', async () => {
  const { privateKey, publicKeySpki } = await keyPair();
  const payload = { sync_bundle: { conversations: [{ title: 'س' }], vcf_contacts: [] }, dry_run: true };
  const envelope = await sealPayload(payload, publicKeySpki);
  const [, wrapped, iv, cipher] = ENVELOPE_RE.exec(envelope);

  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, Buffer.from(wrapped, 'base64'));
  const aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, aesKey, Buffer.from(cipher, 'base64'),
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), payload);
});

test('SEAL-3 the bundle is wrapped the way unsealIngestPayload reads it', () => {
  const payload = toPayload({ vcf_contacts: [], conversations: [], dry_run: true });
  // The worker looks for `sync_bundle` at the top level and takes `dry_run` beside it.
  assert.ok(Array.isArray(payload.sync_bundle.conversations));
  assert.ok(!('dry_run' in payload.sync_bundle), 'dry_run must not be buried inside the bundle');
  assert.equal(payload.dry_run, true);
  // An explicit flag wins: the same bundle can be replayed as a write.
  assert.equal(toPayload({ dry_run: true }, { dryRun: false }).dry_run, false);
});

test('SEAL-4 an empty public key is refused, not sealed with nothing', async () => {
  await assert.rejects(() => sealPayload({ entries: [] }, ''), /empty-public-key/);
});
