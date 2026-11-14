// A read-only preflight. No title-based matching and no persistence of chat text.
import { cleanBidiControls, normalizeInternationalPhone } from './crm-chat-intel.js';

export function previewAntixPhoneMatches(conversations, phoneRows, conversationRows, contactRows = []) {
  const phones = new Map();
  for (const row of phoneRows) {
    if (!row.phone_key || !row.contact_id) continue;
    const ids = phones.get(row.phone_key) || new Set();
    ids.add(row.contact_id);
    phones.set(row.phone_key, ids);
  }
  const existing = new Map(conversationRows.map(row => [row.conversation_uid, row]));
  const names = new Set(contactRows.map(row => cleanBidiControls(row.name || '').trim()).filter(Boolean));
  const counts = { exact_unique_phone: 0, phone_not_found: 0, phone_conflict: 0, conversation_conflict: 0, name_conflict: 0, invalid: 0 };
  const uids = new Set();
  for (const chat of conversations) {
    const uid = chat?.conversation_uid;
    const value = chat?.selected_phone;
    if (typeof uid !== 'string' || !uid.startsWith('wa:') || uid.length > 243 || /\s/.test(uid) || uids.has(uid) ||
        typeof value !== 'string' || !/^\+\d{8,15}$/.test(value) ||
        normalizeInternationalPhone(value) !== value.slice(1)) {
      counts.invalid++;
      continue;
    }
    uids.add(uid);
    const matches = phones.get(value.slice(1)) || new Set();
    const previous = existing.get(uid);
    if (matches.size > 1) { counts.phone_conflict++; continue; }
    const owner = matches.values().next().value || null;
    // Existing UIDs never insert, including an unlinked or same-owner conversation.
    if (previous) { counts.conversation_conflict++; continue; }
    // Name equality is only a warning for the write guard, never identity evidence.
    if (!owner && names.has(cleanBidiControls(chat.title || '').trim())) { counts.name_conflict++; continue; }
    if (!owner) { counts.phone_not_found++; continue; }
    counts.exact_unique_phone++;
  }
  return counts;
}
