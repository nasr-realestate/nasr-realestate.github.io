import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sealBackup, openBackup } from '../crm/private-backup-crypto.mjs';

test('encrypted backup restores exactly only with its local RSA private key', () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
  const payload = Buffer.from('CREATE TABLE synthetic(id TEXT); INSERT INTO synthetic VALUES (\'private\');');
  const sealed = sealBackup(payload, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  assert.doesNotMatch(JSON.stringify(sealed), /private|synthetic/);
  assert.deepEqual(openBackup(sealed, keys.privateKey.export({ type: 'pkcs8', format: 'pem' })), payload);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
  assert.throws(() => openBackup(sealed, other.privateKey.export({ type: 'pkcs8', format: 'pem' })), /wrong-key/);
  const corrupt = { ...sealed, ciphertext: Buffer.concat([Buffer.from(sealed.ciphertext, 'base64'), Buffer.of(0)]).toString('base64') };
  assert.throws(() => openBackup(corrupt, keys.privateKey.export({ type: 'pkcs8', format: 'pem' })));
});

test('weak keys and empty backup fail closed', () => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => sealBackup(Buffer.from('synthetic'), key), /weak-key/);
  const strong = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => sealBackup(Buffer.alloc(0), strong), /invalid-backup/);
});

test('owner CLI decrypts synthetic SQL and tests its SQLite restore without writing plaintext', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-synthetic-backup-'));
  try {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
    const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const data = Buffer.from('CREATE TABLE crm_idempotency_receipts(submission_key TEXT PRIMARY KEY);');
    const encrypted = sealBackup(data, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const backupPath = path.join(dir, 'sealed.json'), keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(backupPath, JSON.stringify(encrypted), { mode: 0o600 });
    fs.writeFileSync(keyPath, pem, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/crm/verify-encrypted-backup.mjs', backupPath, keyPath], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOCAL_ENCRYPTED_BACKUP_DECRYPT_AND_SQLITE_RESTORE_VERIFIED/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['key.pem', 'sealed.json']);
    fs.chmodSync(keyPath, 0o644);
    const refused = spawnSync(process.execPath, ['scripts/crm/verify-encrypted-backup.mjs', backupPath, keyPath], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
