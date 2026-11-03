/**
 * Shared primitives for the A5 operational layer (requests, interactions, follow-ups, Drive review).
 *
 * Why a module of its own: every one of these rules has to hold whether the caller is the HTTP worker, a
 * scheduled job or a test. Duplicating them per endpoint is how an endpoint ends up more permissive than
 * the others, and in this project the permissive one is the bug that reaches the database.
 *
 * Deliberate choices a reviewer should notice:
 *   * nothing here throws for a bad user input — validation returns `{ error, status }` so the route layer
 *     decides the HTTP shape, and a refusal can never half-write.
 *   * free text is bounded and trimmed at the edge, because the database CHECKs are the backstop, not the
 *     first line.
 *   * a "human" actor is required wherever the ledger requires one (0011 refuses `auto`/`system`/`bot`),
 *     so the same vocabulary is used here rather than a friendlier local list.
 *   * digests, never raw personal data, go to the audit trail — `crm_operational_audit_log` has no free-text
 *     column at all for exactly that reason.
 */

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MACHINE_ACTORS = new Set([
  'auto', 'system', 'agent', 'ai', 'bot', 'worker', 'cron', 'pipeline',
  'matcher', 'algorithm', 'unknown', 'none', 'na', '-',
]);

/** The phone-shaped run the 0011 ledger refuses inside a reason: nine digits or more. */
const DIGIT_RUN_RE = /\d{9,}/;

export const LIMITS = Object.freeze({
  name: 100, note: 500, summary: 2000, reason: 1000, ref: 120, actor: 120, list: 200,
});

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function newId(prefix) {
  const raw = new Uint8Array(9);
  globalThis.crypto.getRandomValues(raw);
  const tail = [...raw].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${tail}`.slice(0, 80);
}

export function isId(value) {
  return ID_RE.test(String(value ?? '').trim());
}

export function isHex64(value) {
  return HEX64_RE.test(String(value ?? ''));
}

export function nowIso(value) {
  if (value && !Number.isNaN(Date.parse(String(value)))) return new Date(String(value)).toISOString();
  return new Date().toISOString();
}

/**
 * Turns a SQLite abort into the refusal the operator should see.
 *
 * The database is the last word on every invariant here (0012 and 0013 carry the triggers), so an abort that
 * survives input validation is not a server error to be hidden behind a 500: it is a refusal with a name.
 * Only the constraint / trigger identifier is echoed — never the raw message, which can contain the value
 * that was refused (a phone number, a name).
 */
export function refusalFromDatabaseError(error) {
  const raw = String(error?.message || '');
  const named = /constraint failed: ([A-Za-z0-9_.]+)/.exec(raw)?.[1]
    ?? (/^[A-Za-z0-9_]{3,80}$/.test(raw) ? raw : null);
  if (!named) return null;
  if (/^FOREIGN KEY constraint/.test(raw)) return { error: 'reference_not_found', status: 400, barrier: named };
  if (/^UNIQUE constraint failed: ([A-Za-z0-9_.]+)/.test(raw)) {
    const column = /UNIQUE constraint failed: [^(]*\(?([A-Za-z0-9_.]*)/.exec(raw)?.[1] || named;
    return { error: /dedupe_key/.test(column) ? 'duplicate_record' : 'already_exists', status: 409, barrier: named };
  }
  return { error: 'constraint_refused', status: 409, barrier: named };
}

/** A trimmed, length-checked string. `optional` allows null; otherwise an empty value is a refusal. */
export function textField(field, value, { max, min = 1, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return optional ? { ok: true, value: null } : { ok: false, error: `${field}_required`, status: 400 };
  }
  if (typeof value !== 'string') return { ok: false, error: `${field}_must_be_text`, status: 400 };
  const trimmed = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed.length < min) return { ok: false, error: `${field}_too_short`, status: 400 };
  if (trimmed.length > max) return { ok: false, error: `${field}_too_long`, status: 413 };
  return { ok: true, value: trimmed };
}

export function numberField(field, value, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    return optional ? { ok: true, value: null } : { ok: false, error: `${field}_required`, status: 400 };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: `${field}_must_be_number`, status: 400 };
  if (num < min || num > max) return { ok: false, error: `${field}_out_of_range`, status: 400 };
  return { ok: true, value: num };
}

export function oneOf(field, value, allowed, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return optional ? { ok: true, value: null } : { ok: false, error: `${field}_required`, status: 400 };
  }
  const raw = String(value).trim();
  if (!allowed.has(raw)) return { ok: false, error: `${field}_not_allowed`, status: 400 };
  return { ok: true, value: raw };
}

export function idField(field, value) {
  const raw = String(value ?? '').trim();
  if (!ID_RE.test(raw)) return { ok: false, error: `${field}_invalid`, status: 400 };
  return { ok: true, value: raw };
}

/** The actor that must be a person: same vocabulary the 0011 ledger triggers use. */
export function actorField(field = 'actor', value) {
  const text = textField(field, value, { max: LIMITS.actor, min: 3 });
  if (!text.ok) return text;
  if (MACHINE_ACTORS.has(text.value.toLowerCase())) return { ok: false, error: `${field}_not_human`, status: 403 };
  return { ok: true, value: text.value };
}

/** A free-text reason that must not smuggle a phone number (the ledger's own rule, applied at the edge). */
export function reasonField(field, value, { min = 12, max = LIMITS.reason, optional = false } = {}) {
  const text = textField(field, value, { max, min, optional });
  if (!text.ok) return text;
  if (text.value !== null && DIGIT_RUN_RE.test(text.value)) {
    return { ok: false, error: `${field}_contains_identifier_like_digits`, status: 400 };
  }
  return text;
}

export function limitParam(value, { fallback = 50, max = LIMITS.list } = {}) {
  const num = Number(value ?? fallback);
  if (!Number.isInteger(num) || num <= 0) return fallback;
  return Math.min(num, max);
}

/** `phone_key` in the registry is digits only, 7..15 — the same normalization the contact layer uses. */
export function normalizePhoneKey(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Shared audit row. No free text is stored: only the digest of what the caller decided. */
export const AUDIT_INSERT_SQL = `INSERT INTO crm_operational_audit_log
  (entity, entity_id, contact_id, action, actor, detail_sha256, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

export async function auditStatement(db, { entity, entityId, contactId = null, action, actor, detail = null, occurredAt }) {
  const digest = detail === null || detail === undefined
    ? null
    : await sha256Hex(typeof detail === 'string' ? detail : JSON.stringify(detail));
  return db.prepare(AUDIT_INSERT_SQL).bind(entity, entityId, contactId, action, actor, digest, occurredAt);
}

export { MACHINE_ACTORS, ID_RE, HEX64_RE, DIGIT_RUN_RE };
