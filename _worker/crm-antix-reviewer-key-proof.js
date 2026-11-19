// Short-lived proof of possession for a separately pinned reviewer public key.
// This endpoint cannot enroll a reviewer, write data, or establish identity:
// an authorized operator must obtain and pin the fingerprint independently.
const encoder = new TextEncoder();
const MAX_CHALLENGE_MS = 10 * 60 * 1000;
const b64url = bytes => {
  let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
function decode(value, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max * 2) throw new Error('invalid-proof');
  const text = value.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(text + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length > max || b64url(bytes) !== value) throw new Error('invalid-proof');
  return bytes;
}
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export function reviewerChallengeBytes(reviewerId, fingerprint, nonce, expiresAt) {
  if (typeof reviewerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(reviewerId) ||
      typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
      decode(nonce, 32).length !== 32 || !Number.isSafeInteger(expiresAt)) throw new Error('invalid-challenge');
  return encoder.encode(JSON.stringify(['antix-reviewer-key-proof-v1', reviewerId, fingerprint, nonce, expiresAt]));
}
export async function validateReviewerPublicKey(value, fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('invalid-proof');
  const publicKey = decode(value, 256);
  if (hex(await crypto.subtle.digest('SHA-256', publicKey)) !== fingerprint) throw new Error('invalid-proof');
  try { return await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  catch { throw new Error('invalid-proof'); }
}
export async function verifyReviewerKeyProof(input, env, now = Date.now()) {
  if (env.CRM_ANTIX_ENROLL_PROOF_ENABLED !== 'true') throw new Error('not-configured');
  const reviewerId = env.CRM_ANTIX_ENROLL_REVIEWER_ID, fingerprint = env.CRM_ANTIX_ENROLL_PUBLIC_SHA256;
  const nonce = env.CRM_ANTIX_ENROLL_CHALLENGE;
  const expiryText = env.CRM_ANTIX_ENROLL_EXPIRES_AT;
  if (typeof expiryText !== 'string' || !/^\d{13}$/.test(expiryText)) throw new Error('not-configured');
  const expiry = Number(expiryText);
  let challenge;
  try { challenge = reviewerChallengeBytes(reviewerId, fingerprint, nonce, expiry); } catch { throw new Error('not-configured'); }
  if (!Number.isSafeInteger(now) || expiry <= now || expiry - now > MAX_CHALLENGE_MS) throw new Error('not-configured');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'publicKey') || !Object.hasOwn(input, 'signature')) throw new Error('invalid-proof');
  const signature = decode(input.signature, 64);
  if (signature.length !== 64) throw new Error('invalid-proof');
  const key = await validateReviewerPublicKey(input.publicKey, fingerprint);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, challenge)) throw new Error('invalid-proof');
  return { mode: 'key_possession_only_not_enrolled', verified: true };
}
