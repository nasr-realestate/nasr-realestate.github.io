#!/usr/bin/env node
/**
 * A5 L2 — the documented-deletion book.
 *
 * WHY (2026-11-07)
 * ----------------
 * The gate proves ownership row by row. When a published ledger names a row that no longer exists,
 * `classifyRows()` stops with `l2-row-vanished`: a deletion nobody recorded is exactly the thing a
 * barrier must refuse. But a deletion performed deliberately — by the owner, on synthetic test rows
 * left behind by a failed run — is not evidence of tampering; it is a fact with a witness.
 *
 * The wrong repairs, both refused here:
 *   * delete the ledger that claims the row  → an eligible run with no ledger is a worse stop;
 *   * re-create the row                      → we hold its digests, never its values, and inventing
 *                                             values would be a fabricated proof.
 *
 * So the only honest repair is to WRITE DOWN the deletion: one entry per row, with who, when and
 * why. The gate then reads an attested gap as `attested-deleted` instead of `vanished`, and still
 * refuses every unattested one. The barrier is not opened; a book is added beside it.
 *
 * RULES, enforced by `validateDeletions()`:
 *   * the file is a fixed schema and an append-only list — nothing here is generated at runtime;
 *   * six fields are mandatory and must be non-empty strings: table, key, run_tag, deleted_by,
 *     deleted_at, reason;
 *   * `deleted_at` is an ISO date (`YYYY-MM-DD`) or an ISO timestamp — a plausible-looking string
 *     is not a date, and a deletion with no date cannot be reviewed later;
 *   * `reason` has a floor of 12 characters: "cleanup" is not a reason a stranger can audit;
 *   * no duplicate (table, key) pairs, and no wildcards — an entry names one row.
 * A malformed book is a HARD STOP, not a warning: a gate that reads a half-understood book is worse
 * than one that reads none.
 */
import { existsSync, readFileSync } from 'node:fs';

export const DELETIONS_SCHEMA = 'a5-l2-deletions-v1';
export const REQUIRED_FIELDS = Object.freeze(['table', 'key', 'run_tag', 'deleted_by', 'deleted_at', 'reason']);
export const MIN_REASON_LENGTH = 12;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

export const deletionKey = (table, key) => `${table}|${key}`;

/** Six mandatory, non-empty strings. A field that is present but blank is missing. */
function fieldErrors(entry, at) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${at}:missing-${field}`);
  }
  return errors;
}

/** Shape of the values themselves: a name, a date, a reason someone else can audit. */
function formatErrors(entry, at) {
  const errors = [];
  if (typeof entry.table === 'string' && !IDENTIFIER.test(entry.table)) errors.push(`${at}:bad-table`);
  if (typeof entry.key === 'string' && (entry.key.includes('*') || !IDENTIFIER.test(entry.key))) errors.push(`${at}:bad-key`);
  const { deleted_at: at0 } = entry;
  if (typeof at0 === 'string' && !ISO_DATE.test(at0) && !ISO_TIMESTAMP.test(at0)) errors.push(`${at}:deleted_at-not-iso`);
  if (typeof entry.reason === 'string' && entry.reason.trim().length < MIN_REASON_LENGTH) errors.push(`${at}:reason-too-short`);
  return errors;
}

function entryErrors(entry, at) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${at}:not-an-object`];
  return [...fieldErrors(entry, at), ...formatErrors(entry, at)];
}

/**
 * Pure validation of a parsed book. Returns every error, not the first one: a person fixing a
 * document needs the whole list, and a reviewer needs to see that the list was the whole list.
 */
export function validateDeletions(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['book-is-not-an-object'], entries: [] };
  }
  const errors = [];
  if (doc.schema !== DELETIONS_SCHEMA) errors.push(`schema-mismatch:${String(doc.schema ?? '')}`);
  if (!Array.isArray(doc.deletions)) return { ok: false, errors: [...errors, 'deletions-is-not-an-array'], entries: [] };

  const seen = new Set();
  doc.deletions.forEach((entry, i) => {
    errors.push(...entryErrors(entry, `deletions[${i}]`));
    if (!entry || typeof entry.table !== 'string' || typeof entry.key !== 'string') return;
    const id = deletionKey(entry.table, entry.key);
    if (seen.has(id)) errors.push(`deletions[${i}]:duplicate:${id}`);
    seen.add(id);
  });
  return { ok: errors.length === 0, errors, entries: doc.deletions };
}

/** Read the book from disk. A missing file is an empty book, not an error; an unreadable one stops. */
export function loadDeletions(file) {
  if (!file || !existsSync(file)) return { ok: true, errors: [], entries: [], present: false };
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { ok: false, errors: ['book-unparsable'], entries: [], present: true }; }
  return { ...validateDeletions(doc), present: true };
}

/** Lookup index: `table|key` → entry. Two entries for one row are refused by validation. */
export function attestationIndex(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.table && entry?.key) index.set(deletionKey(entry.table, entry.key), entry);
  }
  return index;
}
