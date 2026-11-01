// The canonical pre-image of a review-ledger event, plus the pure checks that need no hashing engine.
//
// Why this file exists: D1 cannot compute SHA-256 in SQL, and `event_sha256` / `reason_sha256` are
// supplied by the writer. A verification VIEW can therefore prove *linkage* (who follows whom, whether
// an anchor still matches, whether the sequence is dense) but it can never see a content rewrite that
// kept its digests. Recomputing the digest outside the database closes exactly that gap, and it only
// works if the pre-image is specified once, here, and used by every writer and every verifier:
//
//   event_sha256 = hex(sha256("p4rev_event_v1" + "\u0000" + JSON.stringify(fields)))
//
// `fields` is an array of 21 [name, value] pairs in CANONICAL_FIELDS order. A value is normalised so
// that the encoding is unambiguous: NULL becomes null, numbers stay numbers (SQLite may hand back a
// BigInt), everything else becomes a string. The event's own `id`, its free-text `reason` (covered by
// reason_sha256) and `event_sha256` itself are not part of the pre-image.
//
// Nothing in this module logs or returns personal data: the only values that leave it are digests and
// integer counts.

import { createHash } from 'node:crypto';

export const CANONICAL_VERSION = 'p4rev_event_v1';
export const GENESIS_PREFIX = 'p4rev_genesis';

// the 21 hashed columns, in the order the pre-image fixes them
export const CANONICAL_FIELDS = Object.freeze([
  'run_key', 'event_seq', 'case_seq', 'case_ref', 'event_type', 'decision_state', 'reviewer',
  'reviewer_attestation', 'session_hash', 'reason_sha256', 'reveal_purpose', 'reveal_outcome',
  'seal_ciphertext_sha256', 'basis_at_event', 'case_snapshot_sha256', 'link_applied',
  'merge_authorized', 'contact_write_count', 'supersedes_id', 'occurred_at', 'prev_event_sha256',
]);

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalise(name, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (name.endsWith('_seq') || ['link_applied', 'merge_authorized', 'contact_write_count',
    'supersedes_id', 'key_version'].includes(name)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return String(value);
}

export function canonicalPreimage(row) {
  const fields = CANONICAL_FIELDS.map(name => [name, normalise(name, row[name])]);
  return CANONICAL_VERSION + '\u0000' + JSON.stringify(fields);
}

export function eventDigest(row) {
  return sha256Hex(canonicalPreimage(row));
}

export function reasonDigest(reason) {
  return sha256Hex(reason ?? '');
}

export function genesisDigest(runKey) {
  return sha256Hex(`${GENESIS_PREFIX}|${runKey}`);
}

// ---------------------------------------------------------------------- the pure structural checks
// These run over the rows the caller already read; they never touch a database, so the same function
// can serve a CI job, a rehearsal script and a reviewer's laptop with identical results.
export function inspectLedger(rows) {
  const violations = [];
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_key)) byRun.set(row.run_key, []);
    byRun.get(row.run_key).push(row);
  }
  for (const [runKey, list] of byRun) {
    list.sort((a, b) => Number(a.event_seq) - Number(b.event_seq));
    for (const row of list) {
      if (eventDigest(row) !== row.event_sha256) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'digest_mismatch',
          detail: 'the stored event_sha256 no longer matches the row it is stamped on' });
      }
      if (row.reason !== undefined && reasonDigest(row.reason) !== row.reason_sha256) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'reason_mismatch',
          detail: 'reason was rewritten in place without re-signing' });
      }
    }
    const first = list[0];
    if (first && first.event_seq !== 1) {
      violations.push({ runKey, seq: Number(first.event_seq), kind: 'genesis_offset',
        detail: `the ledger starts at ${first.event_seq}, so the head/anchor history has lost rows` });
    }
    list.forEach((row, i) => {
      if (i === 0) return;
      const prev = list[i - 1];
      if (row.event_seq !== prev.event_seq + 1) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'seq_gap',
          detail: `predecessor is ${prev.event_seq}` });
      }
      if (row.prev_event_sha256 !== prev.event_sha256) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'broken_link',
          detail: 'prev_event_sha256 does not match the event before it' });
      }
    });
    // per-case density: a deleted or moved event shows up here even if every digest was re-forged
    const perCase = new Map();
    for (const row of list) {
      if (!perCase.has(row.case_ref)) perCase.set(row.case_ref, []);
      perCase.get(row.case_ref).push(Number(row.case_seq));
    }
    for (const [caseRef, caseSeqs] of perCase) {
      const dense = caseSeqs.length * (caseSeqs.length + 1) / 2;
      const sum = caseSeqs.reduce((a, b) => a + b, 0);
      if (sum !== dense) {
        violations.push({ runKey, caseRef, kind: 'case_seq_density',
          detail: `${caseSeqs.length} events do not occupy 1..${caseSeqs.length}` });
      }
    }
  }
  return { runs: byRun.size, events: rows.length, violations };
}

// head + anchors are the out-of-band memory of the ledger: they are immutable by trigger, so a
// re-signed forgery of the whole event table still has to agree with them or it is reported here.
export function inspectCheckpoints({ events = [], head = null, anchors = [] }) {
  const violations = [];
  const byRun = new Map();
  for (const row of events) {
    if (!byRun.has(row.run_key)) byRun.set(row.run_key, []);
    byRun.get(row.run_key).push(row);
  }
  const headByRun = new Map((head ?? []).map(h => [h.run_key, h]));
  const anchorsByRun = new Map();
  for (const a of anchors ?? []) {
    if (!anchorsByRun.has(a.run_key)) anchorsByRun.set(a.run_key, []);
    anchorsByRun.get(a.run_key).push(a);
  }
  for (const [runKey, list] of byRun) {
    list.sort((a, b) => Number(a.event_seq) - Number(b.event_seq));
    const last = list[list.length - 1];
    const h = headByRun.get(runKey);
    if (!h) {
      violations.push({ runKey, kind: 'head_missing', detail: 'no chain head row for a non-empty ledger' });
    } else if (String(h.head_sha256) !== String(last.event_sha256)) {
      violations.push({ runKey, kind: 'head_diverged',
        detail: 'the head pointer is not the newest event — the ledger was rewound or replaced' });
    } else if (Number(h.event_count) !== list.length && Number(h.event_count) !== Number(last.event_seq)) {
      violations.push({ runKey, kind: 'head_count',
        detail: `head says ${h.event_count} events, the ledger has ${list.length}` });
    }
    const anchorBySeq = new Map((anchorsByRun.get(runKey) ?? []).map(a => [Number(a.event_seq), a]));
    const genesis = anchorBySeq.get(0);
    if (!genesis) {
      violations.push({ runKey, kind: 'genesis_anchor_missing', detail: 'no checkpoint for the empty ledger' });
    } else if (list[0] && String(list[0].prev_event_sha256) !== String(genesis.head_sha256)) {
      violations.push({ runKey, seq: Number(list[0].event_seq), kind: 'genesis_link',
        detail: 'the first event does not chain to the genesis checkpoint' });
    }
    for (const row of list) {
      const a = anchorBySeq.get(Number(row.event_seq));
      if (!a) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'anchor_missing',
          detail: 'no immutable mirror row for this event' });
      } else if (String(a.head_sha256) !== String(row.event_sha256)) {
        violations.push({ runKey, seq: Number(row.event_seq), kind: 'anchor_mismatch',
          detail: 'the event digest no longer matches its mirror — a rewrite, however well signed' });
      }
    }
  }
  return violations;
}

export function loadRowsFromD1Json(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const chunks = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const chunk of chunks) {
    if (Array.isArray(chunk?.results)) rows.push(...chunk.results);
  }
  return rows;
}
