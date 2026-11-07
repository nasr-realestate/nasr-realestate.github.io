/**
 * A5 (ج/d): سجل التفاعلات الموحَّد وإدارة المتابعات — الخدمة التشغيلية فوق `crm_interactions` و
 * `crm_followups` (0013).
 *
 * Invariants this layer keeps, and why they are written this way:
 *   * the timeline is append-only at the database too, so this service never issues an UPDATE/DELETE against
 *     `crm_interactions` — a "fix a typo" path would be a rewrite of evidence;
 *   * old rows are *linked*, not copied: `linkLegacyInteraction` writes a reference (table + id) that 0013
 *     makes unique, so re-importing the same history is a no-op and the original row keeps being the source;
 *   * a follow-up always belongs to a customer AND to a request or an opportunity; the "floating reminder"
 *     case is refused before it reaches a CHECK, because the code is more useful than the abort;
 *   * nothing is auto-scheduled: no function in this file creates a follow-up on its own, and a follow-up
 *     that got no answer is recorded as `missed`/`cancelled` with a reason, never silently dropped;
 *   * each create carries a derived `dedupe_key`, so a double-click or a retry does not double the record.
 */

import { decorateRequest } from './crm-request-expiry.js';
import {
  sha256Hex,
  newId,
  textField,
  numberField,
  oneOf,
  idField,
  actorField,
  reasonField,
  limitParam,
  auditStatement,
  isId,
  refusalFromDatabaseError,
} from './crm-operational-shared.js';

/** One atomic write whose failure is a refusal, not a crash. Every coupled write in this layer goes through
 *  it, so `db.batch` stays the transaction boundary and a database abort still answers in vocabulary. */
async function commit(db, statements) {
  try {
    await db.batch(statements);
  } catch (error) {
    const refusal = refusalFromDatabaseError(error);
    if (refusal) return refusal;
    throw error;
  }
  return null;
}

export const INTERACTION_KINDS = new Set([
  'call', 'whatsapp', 'conversation', 'followup', 'viewing', 'meeting', 'note', 'status_change',
]);
export const INTERACTION_SOURCES = new Set(['manual', 'phone', 'whatsapp', 'import', 'drive', 'system']);
export const LEGACY_TABLES = new Set(['crm_conversation_messages', 'crm_contact_audit_log', 'crm_activities']);
export const FOLLOWUP_STATUSES = new Set(['pending', 'done', 'cancelled', 'missed']);
/** A follow-up is finished with one of these; `pending` is not an outcome. */
export const FOLLOWUP_OUTCOMES = new Set(['done', 'cancelled', 'missed']);

const CAIRO_OFFSET = '+2 hours';   // Africa/Cairo has no DST; the DB stores UTC text.

async function oneRow(db, sql, ...binds) {
  const row = await db.prepare(sql).bind(...binds).first();
  return row ?? null;
}

async function targetExists(db, table, id) {
  if (!isId(id)) return false;
  return Boolean(await oneRow(db, `SELECT id FROM ${table} WHERE id = ?`, String(id).trim()));
}

/** Interaction identity = what happened, when, to whom. Same triple twice is the same event. */
export async function deriveInteractionDedupeKey({ contactId, kind, occurredAt, summary, clientKey }) {
  const parts = ['crm_interaction', 'v1', contactId, kind, occurredAt, summary ?? ''];
  if (clientKey) parts.push(`client:${String(clientKey).slice(0, 80)}`);
  return sha256Hex(parts.join('|'));
}

export async function recordInteractionPayload(db, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };

  const contact = idField('contact_id', body?.contact_id);
  if (!contact.ok) return { error: contact.error, status: contact.status };
  if (!await targetExists(db, 'crm_contacts', contact.value)) return { error: 'contact_not_found', status: 404 };

  const kind = oneOf('kind', body?.kind, INTERACTION_KINDS);
  if (!kind.ok) return { error: kind.error, status: kind.status };
  const source = oneOf('source', body?.source ?? 'manual', INTERACTION_SOURCES);
  if (!source.ok) return { error: source.error, status: source.status };
  const summary = textField('summary', body?.summary, { max: 2000, min: 1 });
  if (!summary.ok) return { error: summary.error, status: summary.status };
  const outcome = reasonField('outcome', body?.outcome, { min: 1, max: 500, optional: true });
  if (!outcome.ok) return { error: outcome.error, status: outcome.status };
  const nextStep = textField('next_step', body?.next_step, { max: 500, min: 1, optional: true });
  if (!nextStep.ok) return { error: nextStep.error, status: nextStep.status };
  const clientKey = textField('client_key', body?.client_key, { max: 80, min: 4, optional: true });
  if (!clientKey.ok) return { error: clientKey.error, status: clientKey.status };

  // optional links, each validated: a typo id must not silently drop the relation.
  const links = {};
  for (const [field, table] of [['request_id', 'crm_customer_requests'], ['opportunity_id', 'crm_opportunities']]) {
    if (body?.[field] === undefined || body?.[field] === null || body?.[field] === '') { links[field] = null; continue; }
    const check = idField(field, body[field]);
    if (!check.ok) return { error: check.error, status: check.status };
    if (!await targetExists(db, table, check.value)) return { error: `${field}_not_found`, status: 404 };
    links[field] = check.value;
  }

  const occurredAt = body?.occurred_at ? new Date(String(body.occurred_at)).toISOString() : (now ? new Date(now).toISOString() : new Date().toISOString());
  if (Number.isNaN(Date.parse(occurredAt))) return { error: 'occurred_at_invalid', status: 400 };
  let nextFollowupAt = null;
  if (body?.next_followup_at) {
    const parsed = new Date(String(body.next_followup_at));
    if (Number.isNaN(parsed.getTime())) return { error: 'next_followup_at_invalid', status: 400 };
    nextFollowupAt = parsed.toISOString();
  }

  const dedupeKey = await deriveInteractionDedupeKey({
    contactId: contact.value, kind: kind.value, occurredAt, summary: summary.value, clientKey: clientKey.value,
  });
  const collision = await oneRow(db, 'SELECT id FROM crm_interactions WHERE dedupe_key = ?', dedupeKey);
  if (collision) return { error: 'duplicate_interaction', status: 409, existing_interaction_id: collision.id };

  const id = newId('int');
  const createdAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'interaction', entityId: id, contactId: contact.value, action: 'recorded',
    actor: actorCheck.value, detail: { kind: kind.value, has_outcome: outcome.value !== null }, occurredAt: createdAt,
  });
  const refused = await commit(db, [
    db.prepare(`INSERT INTO crm_interactions
        (id, contact_id, request_id, opportunity_id, kind, occurred_at, summary, outcome, next_step,
         next_followup_at, source, created_by, dedupe_key, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, contact.value, links.request_id, links.opportunity_id, kind.value, occurredAt, summary.value,
        outcome.value, nextStep.value, nextFollowupAt, source.value, actorCheck.value, dedupeKey, createdAt),
    audit,
  ]);
  if (refused) return refused;
  return { interaction: await readInteraction(db, id) };
}

async function readInteraction(db, id) {
  return oneRow(db, `SELECT i.*, c.name AS contact_name FROM crm_interactions i
      JOIN crm_contacts c ON c.id = i.contact_id WHERE i.id = ?`, id);
}

/**
 * Safe reference-link to an existing history row. It writes only (table, id) plus a short note, and 0013's
 * partial UNIQUE index means one source row can be linked exactly once — so the old conversations stay where
 * they are, and importing them twice cannot double the timeline.
 */
export async function linkLegacyInteractionPayload(db, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const contact = idField('contact_id', body?.contact_id);
  if (!contact.ok) return { error: contact.error, status: contact.status };
  if (!await targetExists(db, 'crm_contacts', contact.value)) return { error: 'contact_not_found', status: 404 };
  const table = oneOf('legacy_ref_table', body?.legacy_ref_table, LEGACY_TABLES);
  if (!table.ok) return { error: table.error, status: table.status };
  const refId = textField('legacy_ref_id', body?.legacy_ref_id, { max: 80, min: 1 });
  if (!refId.ok) return { error: refId.error, status: refId.status };
  const kind = oneOf('kind', body?.kind ?? 'conversation', new Set(['conversation', 'note', 'whatsapp', 'call']));
  if (!kind.ok) return { error: kind.error, status: kind.status };
  const summary = textField('summary', body?.summary ?? 'ربط سجل تاريخي بالخط الزمني', { max: 2000, min: 1 });
  if (!summary.ok) return { error: summary.error, status: summary.status };

  const existing = await oneRow(db, `SELECT id FROM crm_interactions WHERE legacy_ref_table = ? AND legacy_ref_id = ?`,
    table.value, refId.value);
  if (existing) return { error: 'already_linked', status: 200, existing_interaction_id: existing.id, replayed: true };
  const sourceRow = await oneRow(db, `SELECT id FROM ${table.value} WHERE id = ?`, refId.value);
  if (!sourceRow) return { error: 'legacy_row_not_found', status: 404 };

  const occurredAt = body?.occurred_at ? new Date(String(body.occurred_at)).toISOString() : new Date().toISOString();
  const dedupeKey = await sha256Hex(['crm_interaction', 'legacy', table.value, refId.value].join('|'));
  const id = newId('int');
  const createdAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'interaction', entityId: id, contactId: contact.value, action: 'legacy_linked',
    actor: actorCheck.value, detail: { source_table: table.value }, occurredAt: createdAt,
  });
  const refused = await commit(db, [
    // 0013 requires source = 'import' whenever a legacy reference is present.
    db.prepare(`INSERT INTO crm_interactions
        (id, contact_id, kind, occurred_at, summary, source, created_by, legacy_ref_table, legacy_ref_id,
         dedupe_key, created_at)
        VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?)`)
      .bind(id, contact.value, kind.value, occurredAt, summary.value, actorCheck.value, table.value, refId.value,
        dedupeKey, createdAt),
    audit,
  ]);
  if (refused) return refused;
  return { interaction: await readInteraction(db, id), replayed: false };
}

export async function listInteractionsPayload(db, params = {}) {
  const filters = [];
  const binds = [];
  for (const field of ['contact_id', 'request_id', 'opportunity_id']) {
    if (!params[field]) continue;
    const check = idField(field, params[field]);
    if (!check.ok) return { error: check.error, status: check.status };
    filters.push(`i.${field} = ?`); binds.push(check.value);
  }
  if (!filters.length) return { error: 'filter_required', status: 400, detail: 'contact_id, request_id or opportunity_id is required' };
  if (params.kind) {
    const kind = oneOf('kind', params.kind, INTERACTION_KINDS);
    if (!kind.ok) return { error: kind.error, status: kind.status };
    filters.push('i.kind = ?'); binds.push(kind.value);
  }
  if (params.before) {
    const parsed = new Date(String(params.before));
    if (Number.isNaN(parsed.getTime())) return { error: 'before_invalid', status: 400 };
    filters.push('i.occurred_at < ?'); binds.push(parsed.toISOString());
  }
  const limit = limitParam(params.limit, { fallback: 50, max: 200 });
  const rows = (await db.prepare(`SELECT i.*, c.name AS contact_name,
        (SELECT COUNT(*) FROM crm_followups f WHERE f.contact_id = i.contact_id AND f.status = 'pending') AS open_followups
      FROM crm_interactions i JOIN crm_contacts c ON c.id = i.contact_id
      WHERE ${filters.join(' AND ')} ORDER BY i.occurred_at DESC, i.id DESC LIMIT ?`)
    .bind(...binds, limit).all()).results ?? [];
  return { interactions: rows, count: rows.length };
}

/** A customer needs attention when a pending follow-up is due and nothing has been recorded since it. */
export async function contactsNeedingFollowupPayload(db, { now, limit = 50 } = {}) {
  const at = now ? new Date(now).toISOString() : new Date().toISOString();
  const rows = (await db.prepare(`
      SELECT c.id AS contact_id, c.name AS contact_name,
             MIN(f.due_at) AS earliest_due_at,
             COUNT(*) AS pending_followups,
             (SELECT MAX(i.occurred_at) FROM crm_interactions i WHERE i.contact_id = c.id) AS last_interaction_at,
             (SELECT COUNT(*) FROM crm_customer_requests r WHERE r.contact_id = c.id AND r.status IN ('new','active')) AS open_requests
        FROM crm_followups f JOIN crm_contacts c ON c.id = f.contact_id
       WHERE f.status = 'pending' AND datetime(f.due_at) <= datetime(?, ?) AND c.archived_at IS NULL
       GROUP BY c.id, c.name
       ORDER BY earliest_due_at ASC LIMIT ?`)
    .bind(at, CAIRO_OFFSET, limitParam(limit, { fallback: 50, max: 200 })).all()).results ?? [];
  return { contacts: rows, count: rows.length, as_of: at };
}

const EXPIRING_STATES = new Set(['closing', 'expired']);

/** Last-chance rows come before already-expired ones; inside a state, the nearer deadline first. */
function expiringRank(row) {
  return row.window?.state === 'closing' ? 0 : 1;
}

/** The three queues A5 asks for, in one read: due/overdue follow-ups, stale opportunities, unmatched requests. */
export async function operationalQueuesPayload(db, { now, limit = 50 } = {}) {
  const at = now ? new Date(now).toISOString() : new Date().toISOString();
  const size = limitParam(limit, { fallback: 50, max: 200 });
  const [due, overdue, stale, unmatched, stages] = await Promise.all([
    db.prepare(`SELECT q.* FROM crm_followups_queue_v q
        WHERE datetime(q.due_at) > datetime(?, ?) ORDER BY q.due_at ASC LIMIT ?`).bind(at, CAIRO_OFFSET, size).all(),
    db.prepare(`SELECT q.* FROM crm_followups_queue_v q
        WHERE datetime(q.due_at) <= datetime(?, ?) ORDER BY q.due_at ASC LIMIT ?`).bind(at, CAIRO_OFFSET, size).all(),
    db.prepare(`SELECT * FROM crm_stale_opportunities_v
        WHERE days_silent >= 14 ORDER BY days_silent DESC LIMIT ?`).bind(size).all(),
    db.prepare(`SELECT * FROM crm_requests_unmatched_v ORDER BY updated_at ASC LIMIT ?`).bind(size).all(),
    db.prepare(`SELECT * FROM crm_opportunity_stages_v ORDER BY updated_at DESC LIMIT ?`).bind(size).all(),
  ]);
  // A missing requests table (an environment where A5 was never migrated) must
  // not take the whole queue down: the clock is an extra line, not a dependency.
  let openRequests = { results: [] };
  try {
    openRequests = await db.prepare(`SELECT r.id, r.kind, r.status, r.created_at, r.area, r.budget_min, r.budget_max, c.name AS contact_name
        FROM crm_customer_requests r JOIN crm_contacts c ON c.id = r.contact_id
        WHERE r.status IN ('new', 'active') ORDER BY r.created_at ASC LIMIT ?`).bind(size).all();
  } catch { openRequests = { results: [] }; }
  const expiring = (openRequests.results ?? [])
    .map((r) => decorateRequest(r, at))
    .filter((r) => EXPIRING_STATES.has(r.window?.state))
    .sort((a, b) => expiringRank(a) - expiringRank(b) || (a.window?.days_left ?? 0) - (b.window?.days_left ?? 0));
  return {
    as_of: at, timezone: 'Africa/Cairo',
    due: due.results ?? [], overdue: overdue.results ?? [],
    expiring_requests: expiring,
    stale_opportunities: stale.results ?? [], unmatched_requests: unmatched.results ?? [],
    opportunity_stages: stages.results ?? [],
    counts: {
      due: (due.results ?? []).length, overdue: (overdue.results ?? []).length,
      stale: (stale.results ?? []).length, unmatched: (unmatched.results ?? []).length,
      expiring: expiring.length,
    },
  };
}

export async function createFollowupPayload(db, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const contact = idField('contact_id', body?.contact_id);
  if (!contact.ok) return { error: contact.error, status: contact.status };
  if (!await targetExists(db, 'crm_contacts', contact.value)) return { error: 'contact_not_found', status: 404 };
  const links = {};
  for (const [field, table] of [['request_id', 'crm_customer_requests'], ['opportunity_id', 'crm_opportunities']]) {
    if (body?.[field]) {
      const check = idField(field, body[field]);
      if (!check.ok) return { error: check.error, status: check.status };
      if (!await targetExists(db, table, check.value)) return { error: `${field}_not_found`, status: 404 };
      links[field] = check.value;
    } else links[field] = null;
  }
  // 0013 refuses the floating reminder; the same refusal here gives the operator the sentence, not the abort.
  if (!links.request_id && !links.opportunity_id) {
    return { error: 'followup_needs_request_or_opportunity', status: 400 };
  }
  if (!body?.due_at) return { error: 'due_at_required', status: 400 };
  const due = new Date(String(body.due_at));
  if (Number.isNaN(due.getTime())) return { error: 'due_at_invalid', status: 400 };
  // The appointment date is part of the identity: re-sending the same request for the same day and time is a
  // replay, while a *new* date on the same target is a real, separate obligation.
  const dedupeKey = await sha256Hex(['crm_followup', 'v2', links.request_id ?? '', links.opportunity_id ?? '',
    due.toISOString()].join('|'));
  const open = await oneRow(db, `SELECT id FROM crm_followups
      WHERE COALESCE(request_id,'') = ? AND COALESCE(opportunity_id,'') = ? AND status = 'pending'`,
    links.request_id ?? '', links.opportunity_id ?? '');
  if (open) return { error: 'followup_already_open', status: 409, existing_followup_id: open.id };
  const id = newId('fu');
  const createdAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'followup', entityId: id, contactId: contact.value, action: 'scheduled',
    actor: actorCheck.value, detail: { due_at: due.toISOString() }, occurredAt: createdAt,
  });
  const refused = await commit(db, [
    db.prepare(`INSERT INTO crm_followups (id, contact_id, request_id, opportunity_id, due_at, status, created_by, dedupe_key, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .bind(id, contact.value, links.request_id, links.opportunity_id, due.toISOString(), actorCheck.value, dedupeKey, createdAt),
    audit,
  ]);
  if (refused) {
    /* 0013's UNIQUE dedupe_key and its one-open partial index are the last word, and both mean the same thing
     * to the operator: this obligation already exists. Name it and point at the row instead of failing. */
    const existing = await oneRow(db, `SELECT id, status FROM crm_followups
        WHERE COALESCE(request_id,'') = ? AND COALESCE(opportunity_id,'') = ?
          AND (dedupe_key = ? OR status = 'pending')`,
      links.request_id ?? '', links.opportunity_id ?? '', dedupeKey);
    return { error: 'followup_already_open', status: 409,
      ...(existing ? { existing_followup_id: existing.id, existing_status: existing.status } : {}) };
  }
  return { followup: await oneRow(db, 'SELECT * FROM crm_followups WHERE id = ?', id) };
}

/** Finishing a follow-up records the outcome; 0013 then writes the timeline row itself, so no path can
 *  complete a follow-up and leave no trace. `dedupe_key` stays identical to the follow-up's, which is what
 *  makes the pair unique. */
export async function completeFollowupPayload(db, followupId, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const idCheck = idField('followup_id', followupId);
  if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
  const current = await oneRow(db, 'SELECT * FROM crm_followups WHERE id = ?', idCheck.value);
  if (!current) return { error: 'followup_not_found', status: 404 };
  if (current.status !== 'pending') return { error: 'followup_already_final', status: 409, current_status: current.status };
  const statusCheck = oneOf('status', body?.status ?? 'done', FOLLOWUP_OUTCOMES);
  if (!statusCheck.ok) return { error: statusCheck.error, status: statusCheck.status };
  const needsOutcome = statusCheck.value !== 'cancelled';
  const outcome = needsOutcome
    ? reasonField('outcome', body?.outcome, { min: 1, max: 500 })
    : reasonField('outcome', body?.outcome, { min: 1, max: 500, optional: true });
  if (!outcome.ok) return { error: outcome.error, status: outcome.status };
  const reason = statusCheck.value === 'cancelled'
    ? reasonField('reason', body?.reason, { min: 3, max: 500 })
    : reasonField('reason', body?.reason, { min: 3, max: 500, optional: true });
  if (!reason.ok) return { error: reason.error, status: reason.status };
  const completedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'followup', entityId: current.id, contactId: current.contact_id, action: `followup_${statusCheck.value}`,
    actor: actorCheck.value, detail: { status: statusCheck.value }, occurredAt: completedAt,
  });
  const refused = await commit(db, [
    db.prepare(`UPDATE crm_followups SET status = ?, outcome = ?, reason = ?, completed_at = ? WHERE id = ?`)
      .bind(statusCheck.value, outcome.value, reason.value, completedAt, current.id),
    audit,
  ]);
  if (refused) return refused;
  const written = await oneRow(db, `SELECT COUNT(*) AS c FROM crm_interactions WHERE dedupe_key = ? AND kind = 'followup'`,
    current.dedupe_key);
  return {
    followup: await oneRow(db, 'SELECT * FROM crm_followups WHERE id = ?', current.id),
    timeline_row_recorded: Number(written?.c ?? 0) > 0,
  };
}

