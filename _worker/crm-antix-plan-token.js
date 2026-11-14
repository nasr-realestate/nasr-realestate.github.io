// Prototype only: no endpoint or write authorization. Tokens reveal no customer data.
import { planAntixBatch } from './crm-antix-safe-plan.js';

const enc = new TextEncoder();
const MAX_SCOPE_AGE_MS = 60 * 60 * 1000;
const MAX_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (typeof value !== 'string') throw new Error('invalid-scope');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('invalid-scope');
  return time;
}

function scopeIsFresh(items, scopeEnd, now) {
  const end = parseTime(scopeEnd);
  if (!Number.isSafeInteger(now) || end > now || now - end > MAX_SCOPE_AGE_MS) throw new Error('stale-scope');
  for (const item of items) {
    if (item.message_count === 0) continue;
    const first = parseTime(item.first_message_at), last = parseTime(item.last_message_at);
    if (first < end - WINDOW_MS || last > end || first > last) throw new Error('outside-window');
  }
}

function canonicalPlan(items, snapshot, excludedNames, backupRef, scopeEnd, expires) {
  if (typeof backupRef !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(backupRef)) throw new Error('invalid-backup-ref');
  const plan = planAntixBatch(items, snapshot, excludedNames);
  const candidates = plan.eligible.map(item => {
    const phones = snapshot.phones.filter(row => row.phone_key === item.selected_phone.slice(1));
    const owner = phones.length ? snapshot.contacts.find(c => c.id === phones[0].contact_id) : null;
    return { uid: item.conversation_uid, owner_id: owner?.id ?? null, owner_name: owner?.name ?? null };
  }).sort((a, b) => a.uid.localeCompare(b.uid));
  const normalizedItems = items.map(item => ({ uid: item.conversation_uid, phone: item.selected_phone, title: item.title,
    count: item.message_count, first: item.first_message_at, last: item.last_message_at, sha: item.raw_sha256 }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  return { payload: JSON.stringify({ domain: 'antix-plan-token-v1', scopeEnd, expires, backupRef,
    exclusions: [...excludedNames].sort(), items: normalizedItems, candidates }), candidates: plan.eligible, held: plan.held };
}

async function hmacKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('missing-plan-secret');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function hex(bytes) { return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join(''); }

export async function issuePlanToken(items, snapshot, { secret, excludedNames, backupRef, scopeEnd, now }) {
  if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('invalid-plan-size');
  scopeIsFresh(items, scopeEnd, now);
  const expires = now + MAX_TOKEN_LIFETIME_MS;
  const plan = canonicalPlan(items, snapshot, excludedNames, backupRef, scopeEnd, expires);
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(plan.payload));
  return { token: `v1.${expires}.${hex(signature)}`, candidates: plan.candidates.length, held: plan.held.length };
}

export async function verifyPlanToken(items, snapshot, token, { secret, excludedNames, backupRef, scopeEnd, now }) {
  if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('invalid-plan-size');
  scopeIsFresh(items, scopeEnd, now);
  const match = typeof token === 'string' && /^v1\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw new Error('invalid-plan-token');
  const expires = Number(match[1]);
  if (expires <= now || expires - now > MAX_TOKEN_LIFETIME_MS) throw new Error('expired-plan-token');
  const plan = canonicalPlan(items, snapshot, excludedNames, backupRef, scopeEnd, expires);
  const signature = new Uint8Array(match[2].match(/../g).map(n => Number.parseInt(n, 16)));
  if (!await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, enc.encode(plan.payload))) throw new Error('stale-plan-token');
  return { candidates: plan.candidates, held: plan.held.length };
}
