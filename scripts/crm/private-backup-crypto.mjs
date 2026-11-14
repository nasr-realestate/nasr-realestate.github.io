// Hybrid encryption for a private, independently recoverable backup. No network calls.
import crypto from 'node:crypto';
import fs from 'node:fs';

export function sealBackup(plaintext, publicPem) {
  const publicKey = crypto.createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 4096) throw new Error('weak-key');
  if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > 128 * 1024 * 1024) throw new Error('invalid-backup');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const keyDer = publicKey.export({ type: 'spki', format: 'der' });
  return { version: 'crm-backup-sealed-v1', public_key_sha256: crypto.createHash('sha256').update(keyDer).digest('hex'),
    wrapped_key: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64') };
}

export function openBackup(sealed, privatePem) {
  if (!sealed || sealed.version !== 'crm-backup-sealed-v1' || typeof sealed.public_key_sha256 !== 'string') throw new Error('invalid-backup');
  const privateKey = crypto.createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 4096) throw new Error('weak-key');
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (crypto.createHash('sha256').update(der).digest('hex') !== sealed.public_key_sha256) throw new Error('wrong-key');
  const key = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed.wrapped_key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
}

// Used only on an ephemeral runner, never prints plaintext or encryption keys.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const [sql, pubkey, output] = process.argv.slice(2);
    if (!sql || !pubkey || !output || process.argv.length !== 5) throw new Error('invalid-args');
    const result = sealBackup(fs.readFileSync(sql), fs.readFileSync(pubkey));
    fs.writeFileSync(output, JSON.stringify(result) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('ENCRYPTED_BACKUP_CREATED_NO_RESTORE_VERIFIED');
  } catch {
    console.error('ENCRYPTED_BACKUP_FAILED');
    process.exitCode = 1;
  }
}
