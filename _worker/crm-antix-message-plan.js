// Offline, non-authorizing planning prototype. No endpoint, database writes, or
// production-data output. A source key must be independently proven stable;
// a local database row number or shifting sequence is not sufficient evidence.
import { isProtectedAntixOwner } from './crm-antix-exclusions.js';

const encoder = new TextEncoder();
const DAY = 86400000;
const MAX_MESSAGES = 200;
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(x => x.toString(16).padStart(2, '0')).join('');

function checkedDate(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('invalid-date');
  return ms;
}

/**
 * Plan messages against one already-matched metadata-only conversation.
 * Existing message hashes must come from a trusted snapshot, not the caller's
 * assertions; this prototype does not establish that trust. Result contains
 * aggregate counts only, not customer identifiers, message hashes, or text.
 */
export async function previewAntixMessagePlan(input, snapshot, excludedNames) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.messages) ||
      !input.messages.length || input.messages.length > MAX_MESSAGES ||
      !/^wa:\S{1,240}$/u.test(input.conversation_uid || '') ||
      !/^\+\d{8,15}$/.test(input.selected_phone || '') ||
      !Array.isArray(excludedNames) || !excludedNames.length ||
      excludedNames.some(n => typeof n !== 'string' || !/[\p{L}\p{N}]/u.test(n))) throw new Error('invalid-plan');
  const end = checkedDate(input.window_end);
  if (!snapshot || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.phones) ||
      !Array.isArray(snapshot.contacts) || !Array.isArray(snapshot.messages)) throw new Error('invalid-snapshot');
  const chats = snapshot.conversations.filter(x => x.conversation_uid === input.conversation_uid);
  const phones = snapshot.phones.filter(x => x.phone_key === input.selected_phone.slice(1));
  if (chats.length !== 1 || phones.length !== 1 || !chats[0].contact_id ||
      chats[0].contact_id !== phones[0].contact_id || chats[0].source_ref !== 'antix_metadata_v1') throw new Error('identity-review');
  const owners = snapshot.contacts.filter(x => x.id === chats[0].contact_id);
  if (owners.length !== 1 || typeof owners[0].name !== 'string' || !owners[0].name.trim() ||
      isProtectedAntixOwner(owners[0].name, excludedNames)) throw new Error('identity-review');
  return countMessages(input, snapshot.messages, chats[0].id, end);
}

async function countMessages(input, existingMessages, conversationId, end) {
  const seen = new Set();
  let inserted = 0, unchanged = 0, held = 0;
  for (const msg of input.messages) {
    if (!msg || msg.key_kind !== 'wa_key_id' || typeof msg.source_key !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(msg.source_key) || seen.has(msg.source_key) ||
        typeof msg.body_text !== 'string' || !msg.body_text.trim() || msg.body_text.length > 8192 ||
        !['customer', 'broker'].includes(msg.sender_role)) throw new Error('invalid-message');
    seen.add(msg.source_key);
    const sent = checkedDate(msg.sent_at);
    if (sent < end - 15 * DAY || sent > end) throw new Error('outside-window');
    const key = await digest(JSON.stringify(['antix-message-key-v1', input.conversation_uid, msg.source_key]));
    const content = await digest(JSON.stringify([msg.sent_at, msg.sender_role, msg.body_text]));
    const old = existingMessages.filter(row => row.message_uid === key);
    if (old.length > 1 || (old.length === 1 && (old[0].conversation_id !== conversationId ||
        !/^[a-f0-9]{64}$/.test(old[0].content_sha256 || '')))) throw new Error('invalid-snapshot');
    if (!old.length) inserted++;
    else if (old[0].content_sha256 === content) unchanged++;
    else held++;
  }
  return { candidates: inserted, unchanged, held };
}
