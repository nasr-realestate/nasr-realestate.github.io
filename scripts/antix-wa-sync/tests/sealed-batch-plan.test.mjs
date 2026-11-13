import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { b64u, fromB64u } from '../../crm/seal-ingest-bundle.mjs';
import { sealDryRunBatches } from '../sealed-batch-plan.mjs';

const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const pubkey = b64u(await crypto.subtle.exportKey('spki', keys.publicKey));
const conv = i => ({ conversation_uid: `wa:test-${i}`, title: `اختبار ${i}`, raw_txt: `رسالة اصطناعية ${i}` });
const bundle = conversations => ({ conversations, vcf_contacts: [], dry_run: false });

async function decrypt(envelope) {
  const [prefix, wrapped, iv, cipher] = envelope.split('.');
  assert.equal(prefix, 'enc_v1');
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keys.privateKey, fromB64u(wrapped));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(iv) }, aes, fromB64u(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}

test('batches are complete, bounded, encrypted and forced dry-run', async () => {
  const source = Array.from({ length: 23 }, (_, i) => conv(i));
  const batches = await sealDryRunBatches(bundle(source), pubkey);
  assert.deepEqual(batches.map(b => b.conversations), [10, 10, 3]);
  let count = 0;
  for (const b of batches) {
    assert.ok(b.envelope.length <= 65535);
    assert.doesNotMatch(b.envelope, /رسالة اصطناعية/);
    const decoded = await decrypt(b.envelope);
    assert.equal(decoded.dry_run, true);
    assert.equal(decoded.sync_bundle.vcf_contacts.length, 0);
    count += decoded.sync_bundle.conversations.length;
  }
  assert.equal(count, source.length);
});

test('never split or send oversized conversations; reject ambiguous identities and contacts', async () => {
  await assert.rejects(sealDryRunBatches(bundle([{ ...conv(1), raw_txt: 'س'.repeat(100000) }]), pubkey), /single-conversation-exceeds-limit/);
  await assert.rejects(sealDryRunBatches(bundle([conv(1), conv(1)]), pubkey), /duplicate/);
  await assert.rejects(sealDryRunBatches({ conversations: [conv(1)], vcf_contacts: [{ fn: '🌀 اختبار' }] }, pubkey), /no-contacts/);
});


test('CLI writes only private ciphertext and does not overwrite existing output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-plan-test-'));
  try {
    const file = path.join(dir, 'source.json');
    const keyfile = path.join(dir, 'key.txt');
    const output = path.join(dir, 'out');
    fs.mkdirSync(output, { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(bundle([conv(1), conv(2)])), { mode: 0o600 });
    fs.writeFileSync(keyfile, pubkey, { mode: 0o600 });
    const script = new URL('../sealed-batch-plan.mjs', import.meta.url).pathname;
    const command = () => spawnSync(process.execPath, ['--experimental-default-type=module', script, file, keyfile, output], { encoding: 'utf8' });
    const result = command();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BATCH_PLAN_OK_NO_DISPATCH/);
    assert.doesNotMatch(result.stdout, /اصطناعية/);
    const files = fs.readdirSync(output);
    assert.equal(files.length, 1);
    const envelopePath = path.join(output, files[0]);
    assert.equal(fs.statSync(envelopePath).mode & 0o777, 0o600);
    const decoded = await decrypt(fs.readFileSync(envelopePath, 'utf8').trim());
    assert.equal(decoded.dry_run, true);
    assert.equal(decoded.sync_bundle.conversations.length, 2);
    assert.notEqual(command().status, 0);
    assert.equal(fs.readdirSync(output).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
