// Offline prototype only: deliberately not wired to the ingest endpoint.
// A source file modification time is not evidence that an individual name is newer.
import { cleanBidiControls } from './crm-chat-intel.js';
import { isExcludedAntixName, isProtectedAntixOwner } from './crm-antix-exclusions.js';

const marker = /^(🟢|🔴|🔵|🟡|✈️|✈)/u;
function iso(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

// Caller must independently verify both source provenance and per-contact timestamp.
// Matching an old CRM name without a marker exactly permits only addition of the
// incoming marker; the existing name is never replaced. Everything else is held.
export async function applyExistingContactMarkerPrototype(db, item, evidence, excludedNames = []) {
  if (!item || typeof item.selected_phone !== 'string' || !/^\+\d{8,15}$/.test(item.selected_phone) ||
      typeof item.title !== 'string' || !iso(evidence?.verifiedContactModifiedAt) ||
      !/^antix-vcf-sha256:[a-f0-9]{64}$/.test(evidence?.sourceRef || '') ||
      !iso(evidence?.processedAt) || evidence.verifiedContactModifiedAt > evidence.processedAt ||
      !Array.isArray(excludedNames) || !excludedNames.length ||
      excludedNames.some(n => typeof n !== 'string' || !/[\p{L}\p{N}]/u.test(n))) {
    throw new Error('invalid-verified-evidence');
  }
  const title = cleanBidiControls(item.title).trim();
  const match = title.match(marker);
  if (!match || isExcludedAntixName(title, excludedNames) || /^TEST ONLY/i.test(title)) return { outcome: 'review' };
  const body = title.slice(match[0].length).trim();
  if (!body) return { outcome: 'review' };
  const rows = await db.prepare(`SELECT c.id, c.name, c.updated_at FROM crm_contact_phones p
    JOIN crm_contacts c ON c.id=p.contact_id WHERE p.phone_key=?`).bind(item.selected_phone.slice(1)).all();
  if (rows?.success === false || !Array.isArray(rows?.results)) throw new Error('unverified-owner-snapshot');
  if (rows.results.length !== 1) return { outcome: 'review' };
  const owner = rows.results[0];
  if (typeof owner.id !== 'string' || typeof owner.name !== 'string' ||
      isProtectedAntixOwner(owner.name, excludedNames) || owner.name !== body ||
      marker.test(owner.name.trimStart())) return { outcome: 'review' };
  const oldTime = Date.parse(owner.updated_at);
  if (!Number.isFinite(oldTime) || Date.parse(evidence.verifiedContactModifiedAt) <= oldTime) return { outcome: 'review' };
  const newName = `${match[0]} ${owner.name}`;
  if (newName.length > 4096) return { outcome: 'review' };
  // Update and audit are issued in one transactional D1 batch. A failing audit
  // rolls the update back; changes() gates the audit on the preceding update.
  const update = db.prepare(`UPDATE crm_contacts SET name=?, updated_at=?
    WHERE id=? AND name=? AND updated_at=? AND EXISTS
      (SELECT 1 FROM crm_contact_phones WHERE contact_id=? AND phone_key=?)
      AND (SELECT COUNT(*) FROM crm_contact_phones WHERE phone_key=?)=1`)
    .bind(newName, evidence.processedAt, owner.id, owner.name, owner.updated_at,
      owner.id, item.selected_phone.slice(1), item.selected_phone.slice(1));
  const audit = db.prepare(`INSERT INTO crm_contact_audit_log
    (id, contact_id, action_type, field_name, old_value, new_value, source_ref, actor, created_at)
    SELECT ?, ?, 'name_updated', 'name', ?, ?, ?, 'source_sync', ? WHERE changes()=1`)
    .bind(crypto.randomUUID(), owner.id, owner.name, newName, evidence.sourceRef, evidence.processedAt);
  const result = await db.batch([update, audit]);
  const changes = row => row?.meta?.changes ?? row?.changes;
  if (!Array.isArray(result) || result.length !== 2 ||
      ![0, 1].includes(changes(result[0])) || changes(result[0]) !== changes(result[1])) {
    throw new Error('unverified-atomic-result');
  }
  return { outcome: changes(result[1]) === 1 ? 'marker_added' : 'review' };
}
