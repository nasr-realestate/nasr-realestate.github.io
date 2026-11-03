/**
 * A5 (ب): طلب العميل العقاري كيان مستقل — خدمة التشغيل فوق `crm_customer_requests` (0012).
 *
 * What this layer is responsible for, and what it refuses to do:
 *   * it validates at the edge with the same bounds the database enforces, so a bad request is a clean 400
 *     code rather than a raw CHECK abort leaking into a log;
 *   * it never guesses who the customer is: `contact_id` must exist and is the only ownership rule;
 *   * it never auto-matches a property: a link needs an evidence reference, and confirmation needs a named
 *     human (0012 keeps that invariant in `trg_crm_request_link_decision_needs_human`);
 *   * it writes each create/status change as one atomic batch with the status history row and the audit row,
 *     so a half-recorded request cannot exist;
 *   * replay is idempotent-by-refusal: the derived `dedupe_key` is UNIQUE, and a collision returns 409 with
 *     the id it collided with instead of inserting a second copy of the same intent.
 */

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
  normalizePhoneKey,
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

export const SERVICE_CITY = 'مدينة نصر';
export const REQUEST_KINDS = new Set(['buy', 'rent']);
export const PROPERTY_TYPES = new Set([
  'apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'office', 'shop', 'land', 'other',
]);
export const REQUEST_STATUSES = new Set(['new', 'active', 'paused', 'closed', 'cancelled']);
export const REQUEST_SOURCES = new Set([
  'phone', 'whatsapp', 'walk_in', 'referral', 'website', 'facebook', 'drive_file', 'other',
]);
export const LINK_STATES = new Set(['proposed', 'confirmed', 'rejected']);

/** Legal moves only. A closed request is not resurrected: the correct answer is a new request row. */
export const STATUS_TRANSITIONS = Object.freeze({
  new: ['active', 'paused', 'cancelled'],
  active: ['paused', 'closed', 'cancelled'],
  paused: ['active', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
});

const SELECT_REQUEST = `SELECT r.*, c.name AS contact_name
  FROM crm_customer_requests r JOIN crm_contacts c ON c.id = r.contact_id`;

async function oneRow(db, sql, ...binds) {
  const row = await db.prepare(sql).bind(...binds).first();
  return row ?? null;
}

export async function requestExists(db, requestId) {
  return isId(requestId)
    ? Boolean(await oneRow(db, 'SELECT id FROM crm_customer_requests WHERE id = ?', String(requestId).trim()))
    : false;
}

/**
 * The dedupe key is a function of the *intent*, not of the submit: same customer, same kind, same property
 * type, same area and same budget window on the same day is the same request. A client that needs to retry
 * its own POST exactly may pass `client_key`, which is folded in so its retries collide and a genuinely
 * different second request does not.
 */
/** The key that makes a re-sent intent land on the request that already exists. It is derived from the
 *  *content* of the intent only — never from the clock: a retry an hour later, or after a restart, must not
 *  mint a second copy of the customer's standing demand. Two identical demands from one customer are one
 *  request; the operator reactivates the existing one through the status transitions instead. */
export async function deriveRequestDedupeKey({ contactId, kind, propertyType, area, subArea, rooms,
    areaMin, areaMax, budgetMin, budgetMax, clientKey }) {
  const parts = [
    'crm_request', 'v2', contactId, kind, propertyType, area ?? '', subArea ?? '', rooms ?? '',
    areaMin ?? '', areaMax ?? '', budgetMin ?? '', budgetMax ?? '',
  ];
  if (clientKey) parts.push(`client:${String(clientKey).slice(0, 80)}`);
  return sha256Hex(parts.join('|'));
}

async function validateShape(body) {
  const checks = {};
  checks.contactId = idField('contact_id', body?.contact_id);
  checks.kind = oneOf('kind', body?.kind, REQUEST_KINDS);
  checks.propertyType = oneOf('property_type', body?.property_type, PROPERTY_TYPES);
  checks.source = oneOf('source', body?.source, REQUEST_SOURCES);
  checks.area = textField('area', body?.area, { max: 80, min: 2, optional: true });
  checks.subArea = textField('sub_area', body?.sub_area, { max: 80, min: 2, optional: true });
  checks.requirements = textField('requirements', body?.requirements, { max: 2000, min: 1, optional: true });
  checks.rooms = numberField('rooms', body?.rooms, { min: 0, max: 12 });
  checks.areaMin = numberField('area_min_m2', body?.area_min_m2, { min: 0.01, max: 5000 });
  checks.areaMax = numberField('area_max_m2', body?.area_max_m2, { min: 0.01, max: 20000 });
  checks.budgetMin = numberField('budget_min', body?.budget_min, { min: 0, max: 1_000_000_000 });
  checks.budgetMax = numberField('budget_max', body?.budget_max, { min: 0, max: 1_000_000_000 });
  checks.clientKey = textField('client_key', body?.client_key, { max: 80, min: 4, optional: true });
  for (const [name, check] of Object.entries(checks)) {
    if (!check.ok) return { error: check.error, status: check.status, checks };
  }
  const pairs = [['area_min_m2', checks.areaMin.value, 'area_max_m2', checks.areaMax.value],
                 ['budget_min', checks.budgetMin.value, 'budget_max', checks.budgetMax.value]];
  for (const [lowName, low, highName, high] of pairs) {
    if (low !== null && high !== null && Number(low) > Number(high)) {
      return { error: 'invalid_range', status: 400, detail: `${lowName} exceeds ${highName}`, checks };
    }
  }
  return { ok: true, checks };
}

/** Create. The city is not user-supplied: this service serves one city, and the CHECK in 0012 makes that true. */
export async function createCustomerRequestPayload(db, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const shape = await validateShape(body);
  if (!shape.ok) return { error: shape.error, status: shape.status, detail: shape.detail };
  const c = shape.checks;
  const createdAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const contact = await oneRow(db, 'SELECT id, name FROM crm_contacts WHERE id = ?', c.contactId.value);
  if (!contact) return { error: 'contact_not_found', status: 404 };

  const requestId = newId('req');
  const dedupeKey = await deriveRequestDedupeKey({
    contactId: c.contactId.value, kind: c.kind.value, propertyType: c.propertyType.value,
    area: c.area.value, subArea: c.subArea.value, rooms: c.rooms.value,
    areaMin: c.areaMin.value, areaMax: c.areaMax.value,
    budgetMin: c.budgetMin.value, budgetMax: c.budgetMax.value,
    clientKey: c.clientKey.value,
  });
  const existing = await oneRow(db, 'SELECT id FROM crm_customer_requests WHERE dedupe_key = ?', dedupeKey);
  if (existing) {
    return { error: 'duplicate_request', status: 409, existing_request_id: existing.id };
  }

  const audit = await auditStatement(db, {
    entity: 'customer_request', entityId: requestId, contactId: c.contactId.value, action: 'created',
    actor: actorCheck.value, detail: { kind: c.kind.value, property_type: c.propertyType.value }, occurredAt: createdAt,
  });
  const refused = await commit(db, [
    db.prepare(`INSERT INTO crm_customer_requests
        (id, contact_id, kind, property_type, city, area, sub_area, rooms, area_min_m2, area_max_m2,
         budget_min, budget_max, requirements, status, source, dedupe_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`)
      .bind(requestId, c.contactId.value, c.kind.value, c.propertyType.value, SERVICE_CITY,
        c.area.value, c.subArea.value, c.rooms.value, c.areaMin.value, c.areaMax.value,
        c.budgetMin.value, c.budgetMax.value, c.requirements.value, c.source.value,
        dedupeKey, createdAt, createdAt),
    db.prepare(`INSERT INTO crm_request_status_history (request_id, from_status, to_status, actor, changed_at)
        VALUES (?, NULL, 'new', ?, ?)`)
      .bind(requestId, actorCheck.value, createdAt),
    audit,
  ]);
  if (refused) return refused;
  return { request: await readRequest(db, requestId), replayed: false };
}

async function readRequest(db, requestId) {
  const row = await oneRow(db, `${SELECT_REQUEST} WHERE r.id = ?`, requestId);
  if (!row) return null;
  const history = (await db.prepare(`SELECT from_status, to_status, reason, actor, changed_at
      FROM crm_request_status_history WHERE request_id = ? ORDER BY seq DESC`).bind(requestId).all()).results ?? [];
  const links = (await db.prepare(`SELECT l.id, l.listing_id, l.evidence_ref, l.state, l.proposed_by, l.decided_by,
          l.created_at, l.decided_at, li.title AS listing_title, li.url AS listing_url
        FROM crm_request_listing_link l LEFT JOIN listings li ON li.id = l.listing_id
        WHERE l.request_id = ? ORDER BY l.created_at DESC`).bind(requestId).all()).results ?? [];
  const interactions = (await db.prepare(`SELECT id, kind, occurred_at, summary, outcome, next_step
      FROM crm_interactions WHERE request_id = ? ORDER BY occurred_at DESC, id LIMIT 20`).bind(requestId).all()).results ?? [];
  return { ...row, status_history: history, listing_links: links, recent_interactions: interactions };
}

/** Only the fields that describe the wish. Ownership, kind and the identity of the row are not editable. */
export async function updateCustomerRequestPayload(db, requestId, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const idCheck = idField('request_id', requestId);
  if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
  const current = await oneRow(db, SELECT_REQUEST + ' WHERE r.id = ?', idCheck.value);
  if (!current) return { error: 'request_not_found', status: 404 };
  if (['closed', 'cancelled'].includes(current.status)) return { error: 'closed_request_is_final', status: 409 };

  const checks = {
    area: textField('area', body?.area, { max: 80, min: 2, optional: true }),
    subArea: textField('sub_area', body?.sub_area, { max: 80, min: 2, optional: true }),
    requirements: textField('requirements', body?.requirements, { max: 2000, min: 1, optional: true }),
    rooms: numberField('rooms', body?.rooms, { min: 0, max: 12 }),
    areaMin: numberField('area_min_m2', body?.area_min_m2, { min: 0.01, max: 5000 }),
    areaMax: numberField('area_max_m2', body?.area_max_m2, { min: 0.01, max: 20000 }),
    budgetMin: numberField('budget_min', body?.budget_min, { min: 0, max: 1_000_000_000 }),
    budgetMax: numberField('budget_max', body?.budget_max, { min: 0, max: 1_000_000_000 }),
  };
  for (const [name, check] of Object.entries(checks)) {
    if (!check.ok) return { error: check.error, status: check.status };
  }
  const merged = {
    area: checks.area.value ?? current.area,
    sub_area: checks.subArea.value ?? current.sub_area,
    requirements: checks.requirements.value ?? current.requirements,
    rooms: checks.rooms.value ?? current.rooms,
    area_min_m2: checks.areaMin.value ?? current.area_min_m2,
    area_max_m2: checks.areaMax.value ?? current.area_max_m2,
    budget_min: checks.budgetMin.value ?? current.budget_min,
    budget_max: checks.budgetMax.value ?? current.budget_max,
  };
  if (Number(merged.area_min_m2) > Number(merged.area_max_m2 ?? merged.area_min_m2)) return { error: 'invalid_range', status: 400, detail: 'area' };
  if (Number(merged.budget_min) > Number(merged.budget_max ?? merged.budget_min)) return { error: 'invalid_range', status: 400, detail: 'budget' };
  const updatedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'customer_request', entityId: current.id, contactId: current.contact_id, action: 'updated',
    actor: actorCheck.value, detail: merged, occurredAt: updatedAt,
  });
  const refused = await commit(db, [
    db.prepare(`UPDATE crm_customer_requests SET area = ?, sub_area = ?, requirements = ?, rooms = ?,
            area_min_m2 = ?, area_max_m2 = ?, budget_min = ?, budget_max = ?, updated_at = ? WHERE id = ?`)
      .bind(merged.area, merged.sub_area, merged.requirements, merged.rooms, merged.area_min_m2,
        merged.area_max_m2, merged.budget_min, merged.budget_max, updatedAt, current.id),
    audit,
  ]);
  if (refused) return refused;
  return { request: await readRequest(db, current.id) };
}

/** Status moves write history + audit in one batch, and stop/close reasons are mandatory where 0012 says so. */
export async function setCustomerRequestStatusPayload(db, requestId, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const idCheck = idField('request_id', requestId);
  if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
  const toCheck = oneOf('status', body?.status, REQUEST_STATUSES);
  if (!toCheck.ok) return { error: toCheck.error, status: toCheck.status };
  const current = await oneRow(db, SELECT_REQUEST + ' WHERE r.id = ?', idCheck.value);
  if (!current) return { error: 'request_not_found', status: 404 };
  if (current.status === toCheck.value) return { error: 'status_unchanged', status: 409, current_status: current.status };
  if (!STATUS_TRANSITIONS[current.status].includes(toCheck.value)) {
    return { error: 'illegal_status_transition', status: 409, from: current.status, to: toCheck.value };
  }
  const needsReason = toCheck.value !== 'active';
  const reason = needsReason
    ? reasonField('reason', body?.reason, { min: 3, max: 500 })
    : reasonField('reason', body?.reason, { min: 3, max: 500, optional: true });
  if (!reason.ok) return { error: reason.error, status: reason.status };
  const changedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const closing = toCheck.value === 'closed' || toCheck.value === 'cancelled';
  const audit = await auditStatement(db, {
    entity: 'request_status', entityId: current.id, contactId: current.contact_id, action: `status_${toCheck.value}`,
    actor: actorCheck.value, detail: { from: current.status, to: toCheck.value }, occurredAt: changedAt,
  });
  const refused = await commit(db, [
    db.prepare(`UPDATE crm_customer_requests SET status = ?, stop_reason = ?, closed_at = ?, updated_at = ?
        WHERE id = ?`)
      .bind(toCheck.value, reason.value ?? current.stop_reason, closing ? changedAt : null, changedAt, current.id),
    db.prepare(`INSERT INTO crm_request_status_history (request_id, from_status, to_status, reason, actor, changed_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(current.id, current.status, toCheck.value, reason.value, actorCheck.value, changedAt),
    audit,
  ]);
  if (refused) return refused;
  return { request: await readRequest(db, current.id) };
}

/**
 * Linking a request to a listed property. `evidence_ref` is mandatory and structural (`wa:msg:…`,
 * `drive:file:…`, `call:log:…`): a link without a documented source is the speculative matching this
 * project refuses. Linking never changes either entity beyond the link row itself.
 */
export async function linkRequestListingPayload(db, requestId, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const idCheck = idField('request_id', requestId);
  if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
  const request = await oneRow(db, SELECT_REQUEST + ' WHERE r.id = ?', idCheck.value);
  if (!request) return { error: 'request_not_found', status: 404 };
  if (['closed', 'cancelled'].includes(request.status)) return { error: 'closed_request_accepts_no_new_link', status: 409 };
  const listingId = Number(body?.listing_id);
  if (!Number.isInteger(listingId) || listingId <= 0) return { error: 'listing_id_invalid', status: 400 };
  const listing = await oneRow(db, 'SELECT id, title FROM listings WHERE id = ?', listingId);
  if (!listing) return { error: 'listing_not_found', status: 404 };
  const evidence = textField('evidence_ref', body?.evidence_ref, { max: 120, min: 8 });
  if (!evidence.ok) return { error: evidence.value ? evidence.error : 'evidence_ref_required', status: evidence.status ?? 400 };
  const existing = await oneRow(db, 'SELECT id FROM crm_request_listing_link WHERE request_id = ? AND listing_id = ?',
    request.id, listingId);
  if (existing) return { error: 'link_already_exists', status: 409, existing_link_id: existing.id };
  const linkId = newId('rll');
  const createdAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'request_listing_link', entityId: linkId, contactId: request.contact_id, action: 'proposed',
    actor: actorCheck.value, detail: { listing_id: listingId }, occurredAt: createdAt,
  });
  const refused = await commit(db, [
    db.prepare(`INSERT INTO crm_request_listing_link (id, request_id, listing_id, evidence_ref, state, proposed_by, created_at)
        VALUES (?, ?, ?, ?, 'proposed', ?, ?)`)
      .bind(linkId, request.id, listingId, evidence.value, actorCheck.value, createdAt),
    audit,
  ]);
  if (refused) return refused;
  return { link: await oneRow(db, `SELECT id, request_id, listing_id, evidence_ref, state, proposed_by, created_at
      FROM crm_request_listing_link WHERE id = ?`, linkId) };
}

/** Confirming or rejecting a proposal is a named human act; 0012 refuses it otherwise, and so do we. */
export async function decideRequestListingLinkPayload(db, requestId, linkId, body, { actor, now } = {}) {
  const actorCheck = actorField('actor', actor);
  if (!actorCheck.ok) return { error: actorCheck.error, status: actorCheck.status };
  const stateCheck = oneOf('state', body?.state, LINK_STATES);
  if (!stateCheck.ok) return { error: stateCheck.error, status: stateCheck.status };
  if (stateCheck.value === 'proposed') return { error: 'state_not_a_decision', status: 400 };
  const link = await oneRow(db, `SELECT id, request_id, state FROM crm_request_listing_link WHERE id = ? AND request_id = ?`,
    String(linkId ?? '').trim(), String(requestId ?? '').trim());
  if (!link) return { error: 'link_not_found', status: 404 };
  if (link.state !== 'proposed') return { error: 'link_already_decided', status: 409, current_state: link.state };
  const decidedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const audit = await auditStatement(db, {
    entity: 'request_listing_link', entityId: link.id, action: `link_${stateCheck.value}`,
    actor: actorCheck.value, detail: { state: stateCheck.value }, occurredAt: decidedAt,
  });
  const refused = await commit(db, [
    db.prepare(`UPDATE crm_request_listing_link SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?`)
      .bind(stateCheck.value, actorCheck.value, decidedAt, link.id),
    audit,
  ]);
  if (refused) return refused;
  return { link: await oneRow(db, `SELECT id, request_id, listing_id, evidence_ref, state, proposed_by, decided_by,
      created_at, decided_at FROM crm_request_listing_link WHERE id = ?`, link.id) };
}

/**
 * The work queue the A5 report is asked to show: active requests that have not reached a confirmed property.
 * Read-only, bounded, and it never invents a follow-up from an unanswered request.
 */
export async function listCustomerRequestsPayload(db, params = {}) {
  const filters = [];
  const binds = [];
  if (params.contact_id) {
    const idCheck = idField('contact_id', params.contact_id);
    if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
    filters.push('r.contact_id = ?'); binds.push(idCheck.value);
  }
  if (params.status) {
    const statusCheck = oneOf('status', params.status, REQUEST_STATUSES);
    if (!statusCheck.ok) return { error: statusCheck.error, status: statusCheck.status };
    filters.push('r.status = ?'); binds.push(statusCheck.value);
  }
  if (params.kind) {
    const kindCheck = oneOf('kind', params.kind, REQUEST_KINDS);
    if (!kindCheck.ok) return { error: kindCheck.error, status: kindCheck.status };
    filters.push('r.kind = ?'); binds.push(kindCheck.value);
  }
  if (params.unmatched === '1' || params.unmatched === 'true') {
    filters.push(`NOT EXISTS (SELECT 1 FROM crm_request_listing_link l WHERE l.request_id = r.id AND l.state = 'confirmed')`);
  }
  if (params.q) {
    const raw = String(params.q).trim();
    const phone = normalizePhoneKey(raw);
    if (phone) {
      filters.push(`(c.name LIKE ? OR EXISTS (SELECT 1 FROM crm_contact_phones p WHERE p.contact_id = c.id AND p.phone_key = ?))`);
      binds.push(`%${raw.slice(0, 40)}%`, phone);
    } else if (raw.length >= 2) {
      filters.push('c.name LIKE ?');
      binds.push(`%${raw.slice(0, 40)}%`);
    } else {
      return { error: 'q_too_short', status: 400 };
    }
  }
  const limit = limitParam(params.limit, { fallback: 50 });
  const offset = Math.max(0, Number(params.offset ?? 0) || 0);
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const rows = (await db.prepare(`${SELECT_REQUEST}${where} ORDER BY r.updated_at DESC, r.id LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset).all()).results ?? [];
  const total = await oneRow(db, `SELECT COUNT(*) AS count FROM crm_customer_requests r JOIN crm_contacts c ON c.id = r.contact_id${where}`, ...binds);
  return { requests: rows, count: rows.length, total: Number(total?.count ?? 0), limit, offset };
}

export async function getCustomerRequestPayload(db, requestId) {
  const idCheck = idField('request_id', requestId);
  if (!idCheck.ok) return { error: idCheck.error, status: idCheck.status };
  const request = await readRequest(db, idCheck.value);
  return request ? { request } : { error: 'request_not_found', status: 404 };
}
