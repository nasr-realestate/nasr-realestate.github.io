// Isolated internal prototype; not wired to an endpoint and does not authorize writes.
// Snapshot must come from a trusted database read; it is never returned or logged.
import { buildAntixWriteGuards } from './crm-antix-write-guards.js';
import { writeAntixMetadataPrototype } from './crm-antix-metadata-write.js';

export async function readAntixWriteSnapshot(db, items) {
  if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('invalid-guard-batch');
  const placeholders = items.map(() => '?').join(',');
  const contacts = await db.prepare('SELECT id, name FROM crm_contacts').all();
  const phones = await db.prepare('SELECT phone_key, contact_id FROM crm_contact_phones').all();
  const conversations = await db.prepare(`SELECT conversation_uid, contact_id FROM crm_conversations WHERE conversation_uid IN (${placeholders})`)
    .bind(...items.map(item => item.conversation_uid)).all();
  if ([contacts, phones, conversations].some(r => r?.success === false || !Array.isArray(r?.results))) {
    throw new Error('unverified-snapshot');
  }
  return { contacts: contacts.results, phones: phones.results, conversations: conversations.results };
}

export async function writeGuardedAntixPrototype(db, items, snapshot, { now = new Date(), excludedNames = [] } = {}) {
  const guards = buildAntixWriteGuards(db, items, snapshot, excludedNames);
  return writeAntixMetadataPrototype(db, items, {
    now, createMissing: true, excludedNames, guardedSnapshot: snapshot, guardedStatements: guards,
  });
}
