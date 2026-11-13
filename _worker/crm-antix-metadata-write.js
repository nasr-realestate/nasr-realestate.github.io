// Isolated, not wired to any endpoint. Only exact existing phone owners are eligible.
// This deliberately stores no transcript, message bodies, insights, or alerts.
import { normalizeInternationalPhone } from './crm-chat-intel.js';

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
        typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 ||
        item.title.trimStart().startsWith('🌀') || !Number.isSafeInteger(item.message_count) || item.message_count < 1 ||
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

/** Internal prototype. Must not be connected to the ingest endpoint without a go-live review. */
export async function writeAntixMetadataPrototype(db, items, { now = new Date() } = {}) {
  validateAntixMetadata(items); // Validate the whole batch before issuing any SQL.
  const nowIso = now.toISOString();
  const statements = items.map(item => db.prepare(
    `INSERT INTO crm_conversations (
      id, conversation_uid, contact_id, source_type, source_ref, chat_title,
      peer_sender_name, match_status, match_method, review_reason, raw_text, raw_sha256,
      message_count, first_message_at, last_message_at, parse_warnings_json, created_at, updated_at
    ) SELECT ?, ?, c.id, 'whatsapp_export', 'antix_metadata_v1', c.name,
      '', 'matched', 'exact_phone', '', '', ?, ?, ?, ?, '[]', ?, ?
      FROM crm_contact_phones p JOIN crm_contacts c ON c.id = p.contact_id
      WHERE p.phone_key = ? AND c.name NOT LIKE 'TEST ONLY%' AND ltrim(c.name) NOT LIKE '🌀%'
      ON CONFLICT(conversation_uid) DO NOTHING`,
  ).bind(crypto.randomUUID(), item.conversation_uid, item.raw_sha256, item.message_count,
    item.first_message_at, item.last_message_at, nowIso, nowIso, item.selected_phone.slice(1)));
  const result = await db.batch(statements);
  if (!Array.isArray(result) || result.length !== items.length ||
      result.some(row => !Number.isInteger(row?.meta?.changes ?? row?.changes))) {
    throw new Error('unverified-write-result');
  }
  const inserted = result.reduce((total, row) => total + (row.meta?.changes ?? row.changes), 0);
  return { attempted: items.length, inserted, not_inserted: items.length - inserted };
}
