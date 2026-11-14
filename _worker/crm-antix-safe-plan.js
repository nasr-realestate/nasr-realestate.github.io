// Offline planning only. This does not authorize or perform any CRM writes.
// Callers must take a new consistent snapshot and repeat all guards at write time.
import { validateAntixMetadata } from './crm-antix-metadata-write.js';
import { previewAntixPhoneMatches } from './crm-antix-phone-preview.js';

export function planAntixBatch(items, snapshot, excludedNames) {
  if (!Array.isArray(excludedNames) || !excludedNames.length ||
      excludedNames.some(n => typeof n !== 'string' || !/[\p{L}\p{N}]/u.test(n))) {
    throw new Error('private-exclusions-required');
  }
  validateAntixMetadata(items, excludedNames);
  if (!snapshot || ['phones', 'conversations', 'contacts'].some(k => !Array.isArray(snapshot[k]))) {
    throw new Error('unverified-snapshot');
  }
  const contacts = new Map();
  for (const row of snapshot.contacts) {
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim() || contacts.has(row.id)) {
      throw new Error('unverified-snapshot');
    }
    contacts.set(row.id, row.name);
  }
  if (snapshot.phones.some(row => !row || typeof row.phone_key !== 'string' || !/^\d{8,15}$/.test(row.phone_key) ||
      !contacts.has(row.contact_id)) || snapshot.conversations.some(row => !row ||
      typeof row.conversation_uid !== 'string' || !row.conversation_uid)) {
    throw new Error('unverified-snapshot');
  }
  const eligible = [];
  const held = [];
  for (const item of items) {
    const result = previewAntixPhoneMatches([item], snapshot.phones, snapshot.conversations,
      snapshot.contacts, excludedNames, true);
    // A preview classification is not identity verification or write authorization.
    if (result.exact_unique_phone === 1 || result.phone_not_found === 1) eligible.push(item);
    else held.push(item);
  }
  return { eligible, held };
}
