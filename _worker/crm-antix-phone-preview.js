// A read-only preflight. No title-based matching and no persistence of chat text.
import { cleanBidiControls, normalizeInternationalPhone } from './crm-chat-intel.js';
import { isProtectedAntixOwner } from './crm-antix-exclusions.js';

function existingOwnerConflict(chat, owner, contacts, excludedNames) {
  if (!owner) return null;
  if (isProtectedAntixOwner(contacts.get(owner) || '', excludedNames)) return 'protected_owner';
  if (chat.message_count === 0) return 'contact_only_existing_phone';
  return null;
}

function classifyContactName(incomingName, current) {
  const incoming = cleanBidiControls(incomingName || '').trim();
  const marked = incoming.match(/^([🟢🔴🔵🟡]|✈️|✈)\s*/u);
  if (current && incoming === current) return 'exact_name_and_marker';
  if (current && marked && !/^[🟢🔴🔵🟡✈]/u.test(current) && incoming.slice(marked[0].length) === current) {
    return 'marker_missing_same_name';
  }
  return 'other_or_unknown';
}

function recordPhoneConflict(reason, chat, owner, contacts, counts, detail, contactNameDetail) {
  counts.phone_conflict++;
  detail[reason]++;
  if (reason === 'contact_only_existing_phone') {
    contactNameDetail[classifyContactName(chat.title, contacts.get(owner) || '')]++;
  }
}

function indexPhones(phoneRows) {
  const phones = new Map();
  for (const row of phoneRows) {
    if (!row.phone_key || !row.contact_id) continue;
    const ids = phones.get(row.phone_key) || new Set();
    ids.add(row.contact_id);
    phones.set(row.phone_key, ids);
  }
  return phones;
}

export function previewAntixPhoneMatches(conversations, phoneRows, conversationRows, contactRows = [], excludedNames = [], includeConflictDetails = false) {
  const phones = indexPhones(phoneRows);
  const existing = new Map(conversationRows.map(row => [row.conversation_uid, row]));
  const names = new Set(contactRows.map(row => cleanBidiControls(row.name || '').trim()).filter(Boolean));
  const contacts = new Map(contactRows.map(row => [row.id, cleanBidiControls(row.name || '').trim()]));
  const counts = { exact_unique_phone: 0, phone_not_found: 0, phone_conflict: 0, conversation_conflict: 0, name_conflict: 0, invalid: 0 };
  const detail = { multiple_owners: 0, protected_owner: 0, contact_only_existing_phone: 0 };
  // Diagnostic only: classification never changes an existing name or upgrades
  // a phone conflict to a match, and name equality is not identity evidence.
  const contactNameDetail = { exact_name_and_marker: 0, marker_missing_same_name: 0, other_or_unknown: 0 };
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
    if (matches.size > 1) { counts.phone_conflict++; detail.multiple_owners++; continue; }
    const owner = matches.values().next().value || null;
    // Existing UIDs never insert, including an unlinked or same-owner conversation.
    if (previous) { counts.conversation_conflict++; continue; }
    // Contact-only writes create a new contact and would skip an existing phone.
    // An excluded existing owner must never be linked even for a recent chat.
    const reason = existingOwnerConflict(chat, owner, contacts, excludedNames);
    if (reason) {
      recordPhoneConflict(reason, chat, owner, contacts, counts, detail, contactNameDetail);
      continue;
    }
    // Name equality is only a warning for the write guard, never identity evidence.
    if (!owner && names.has(cleanBidiControls(chat.title || '').trim())) { counts.name_conflict++; continue; }
    if (!owner) { counts.phone_not_found++; continue; }
    counts.exact_unique_phone++;
  }
  return includeConflictDetails ? { ...counts, phone_conflict_detail: detail, contact_only_name_detail: contactNameDetail } : counts;
}
