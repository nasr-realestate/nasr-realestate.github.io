#!/usr/bin/env node
// Sign a short enrollment challenge with the existing owner-device key.
// Output contains only the public key and a signature, never the private key.
// The server must independently pin the public fingerprint. This does not
// enroll anyone, authenticate a human or approve a message import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { reviewerChallengeBytes } from '../../_worker/crm-antix-reviewer-key-proof.js';

const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
function loadKey(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd), real = fs.realpathSync(filename);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 512 ||
        real === repo || real.startsWith(repo + path.sep)) throw new Error('invalid-key');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function main() {
  if (process.argv.length !== 3 || !process.getuid || process.stdin.isTTY) throw new Error('invalid-input');
  const raw = fs.readFileSync(0);
  if (raw.length > 4096) throw new Error('invalid-input');
  const input = JSON.parse(raw.toString('utf8'));
  if (!input || Array.isArray(input) || Object.keys(input).length !== 4 ||
      ['reviewerId', 'fingerprint', 'nonce', 'expiresAt'].some(k => !Object.hasOwn(input, k))) throw new Error('invalid-input');
  const message = reviewerChallengeBytes(input.reviewerId, input.fingerprint, input.nonce, input.expiresAt);
  const now = Date.now();
  if (input.expiresAt <= now || input.expiresAt - now > 600000) throw new Error('expired-challenge');
  const material = loadKey(process.argv[2]);
  try {
    const key = createPrivateKey({ key: material, type: 'pkcs8', format: 'der' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('invalid-key');
    const pub = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (createHash('sha256').update(pub).digest('hex') !== input.fingerprint) throw new Error('fingerprint-mismatch');
    const signature = sign('sha256', message, { key, dsaEncoding: 'ieee-p1363' });
    process.stdout.write(JSON.stringify({ publicKey: pub.toString('base64url'), signature: signature.toString('base64url') }) + '\n');
  } finally { material.fill(0); }
}
try { main(); } catch { process.stderr.write('KEY_PROOF_FAILED_NO_ENROLLMENT\n'); process.exitCode = 1; }
