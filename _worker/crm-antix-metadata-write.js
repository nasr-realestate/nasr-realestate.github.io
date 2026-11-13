// Isolated prototype, not wired to any endpoint. Matching is by phone only.
// This deliberately stores no transcript, message bodies, insights, or alerts.
import { normalizeInternationalPhone, cleanBidiControls } from './crm-chat-intel.js';

export const MAX_ANTIX_TITLE_LENGTH = 4096;

const ALLOWED = new Set(['conversation_uid', 'selected_phone', 'title', 'message_count',
  'first_message_at', 'last_message_at', 'raw_sha256']);

function validDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateAntixMetadata(items) {
  if (!Array.isArray(items) || !items.length || items.length > 10) throw new Error('invalid-batch');
  const seenUid = new Set();
  const seenPhone = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !ALLOWED.has(k)) ||
        typeof item.conversation_uid !== 'string' || !/^wa:\S{1,240}$/u.test(item.conversation_uid) ||
        typeof item.selected_phone !== 'string' || !/^\+\d{8,15}$/.test(item.selected_phone) ||
        normalizeInternationalPhone(item.selected_phone) !== item.selected_phone.slice(1) ||
        typeof item.title !== 'string' || !item.title.trim() || item.title.length > MAX_ANTIX_TITLE_LENGTH ||
        (cleanBidiControls(item.title).includes('🌀') || /^TEST ONLY/i.test(cleanBidiControls(item.title).trimStart())) || !Number.isSafeInteger(item.message_count) || item.message_count < 1 ||
        !validDate(item.first_message_at) || !validDate(item.last_message_at) ||
        (item.first_message_at && item.last_message_at && item.first_message_at > item.last_message_at) ||
        typeof item.raw_sha256 !== 'string' || !/^[a-f\d]{64}$/.test(item.raw_sha256) ||
        seenUid.has(item.conversation_uid) || seenPhone.has(item.selected_phone)) {
      throw new Error('invalid-conversation-metadata');
    }
    seenUid.add(item.conversation_uid);
    seenPhone.add(item.selected_phone);
  }
}

/** Internal prototype. Not connected to any ingest endpoint. */
export async function writeAntixMetadataPrototype(db, items, { now = new Date(), createMissing = false } = {}) {
  validateAntixMetadata(items); // Validate the whole batch before issuing any SQL.
  const nowIso = now.toISOString();
  const statements = [];
  for (const item of items) {
    const contactId = crypto.randomUUID();
    if (createMissing) {
      // A UID collision or an exact name collision is a review case, not a new
      // person and not evidence for linking to the existing name's owner.
      statements.push(db.prepare(
        `INSERT INTO crm_contacts(id, name, communication_consent, created_at, updated_at)
         SELECT ?, ?, 'request_only', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM crm_contact_phones WHERE phone_key = ?)
           AND NOT EXISTS (SELECT 1 FROM crm_conversations WHERE conversation_uid = ?)
           AND NOT EXISTS (SELECT 1 FROM crm_contacts WHERE name = ?)`,
      ).bind(contactId, cleanBidiControls(item.title).trim(), nowIso, nowIso, item.selected_phone.slice(1),
        item.conversation_uid, cleanBidiControls(item.title).trim()));
      statements.push(db.prepare(
        `INSERT INTO crm_contact_phones(id, contact_id, phone_key, label, is_primary, raw_input, source_type, source_ref, verified_at)
         SELECT ?, id, ?, 'واتساب', 1, '', 'vcf', 'antix_metadata_v1', ? FROM crm_contacts WHERE id = ?`,
      ).bind(crypto.randomUUID(), item.selected_phone.slice(1), nowIso, contactId));
      statements.push(db.prepare(
        `INSERT INTO crm_contact_audit_log(id, contact_id, action_type, field_name, old_value, new_value, source_ref, actor, created_at)
         SELECT ?, id, 'source_synced', 'contact_created', NULL, NULL, 'antix_metadata_v1', 'source_sync', ?
         FROM crm_contacts WHERE id = ?`,
      ).bind(crypto.randomUUID(), nowIso, contactId));
    }
    statements.push(db.prepare(
      `INSERT INTO crm_conversations (
        id, conversation_uid, contact_id, source_type, source_ref, chat_title,
        peer_sender_name, match_status, match_method, review_reason, raw_text, raw_sha256,
        message_count, first_message_at, last_message_at, parse_warnings_json, created_at, updated_at
      ) SELECT ?, ?, c.id, 'whatsapp_export', 'antix_metadata_v1', c.name,
        '', 'matched', 'exact_phone', '', '', ?, ?, ?, ?, '[]', ?, ?
        FROM crm_contact_phones p JOIN crm_contacts c ON c.id = p.contact_id
        WHERE p.phone_key = ? AND ltrim(c.name) NOT LIKE 'TEST ONLY%' AND c.name NOT LIKE '%🌀%'
        ON CONFLICT(conversation_uid) DO NOTHING`,
    ).bind(crypto.randomUUID(), item.conversation_uid, item.raw_sha256, item.message_count,
      item.first_message_at, item.last_message_at, nowIso, nowIso, item.selected_phone.slice(1)));
  }
  // D1 batch is transactional: any constraint error rolls back the entire batch.
  const result = await db.batch(statements);
  if (!Array.isArray(result) || result.length !== statements.length ||
      result.some(row => !Number.isInteger(row?.meta?.changes ?? row?.changes))) {
    throw new Error('unverified-write-result');
  }
  const changes = row => row.meta?.changes ?? row.changes;
  const stride = createMissing ? 4 : 1;
  let inserted = 0;
  let createdContacts = 0;
  for (let i = 0; i < items.length; i++) {
    if (createMissing) createdContacts += changes(result[i * stride]);
    inserted += changes(result[i * stride + stride - 1]);
  }
  return { attempted: items.length, inserted, not_inserted: items.length - inserted, ...(createMissing ? { created_contacts: createdContacts } : {}) };
}
