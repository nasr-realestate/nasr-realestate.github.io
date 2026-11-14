// Isolated prototype: no endpoint, dispatch, backup authorization or data writes.
// Each guard must be executed INSIDE the same D1 batch transaction as its writes.
import { cleanBidiControls } from './crm-chat-intel.js';
import { planAntixBatch } from './crm-antix-safe-plan.js';

// SQLite trim is made equivalent to ECMAScript trim, after the same bidi removal.
const removed = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0xfeff];
const whitespace = [9, 10, 11, 12, 13, 32, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const removeBidiSql = removed.reduce((sql, n) => `replace(${sql},char(${n}),'')`, 'c.name');
const trimCharactersSql = whitespace.map(n => `char(${n})`).join('||');
const cleanSql = `trim(${removeBidiSql},${trimCharactersSql})`;

/** Candidate/owner snapshots stay in memory only. No held item may enter a write batch.
 * Caller must arrange a real D1 transactional batch and fail the entire batch on
 * any failed guard; SELECT guards alone are NOT a write authorization.
 */
export function buildAntixWriteGuards(db, items, snapshot, excludedNames) {
  if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('invalid-guard-batch');
  const plan = planAntixBatch(items, snapshot, excludedNames);
  if (plan.held.length) throw new Error('held-item-in-write-batch');
  return items.map(item => {
    const phone = item.selected_phone.slice(1);
    const owners = snapshot.phones.filter(row => row.phone_key === phone);
    const uid = item.conversation_uid;
    const fail = "abs(-9223372036854775808)"; // SQLite overflow aborts the whole transactional batch.
    if (!owners.length) {
      return db.prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM crm_contact_phones WHERE phone_key=?)
        AND NOT EXISTS (SELECT 1 FROM crm_conversations WHERE conversation_uid=?)
        AND NOT EXISTS (SELECT 1 FROM crm_contacts c WHERE ${cleanSql}=?)
        THEN 1 ELSE ${fail} END AS guard`).bind(phone, uid, cleanBidiControls(item.title));
    }
    if (owners.length !== 1 || item.message_count === 0) throw new Error('unverified-owner');
    const owner = snapshot.contacts.find(row => row.id === owners[0].contact_id);
    if (!owner) throw new Error('unverified-owner');
    return db.prepare(`SELECT CASE WHEN
      (SELECT COUNT(*) FROM crm_contact_phones WHERE phone_key=?)=1
      AND EXISTS (SELECT 1 FROM crm_contact_phones p JOIN crm_contacts c ON c.id=p.contact_id
                  WHERE p.phone_key=? AND c.id=? AND c.name=?)
      AND NOT EXISTS (SELECT 1 FROM crm_conversations WHERE conversation_uid=?)
      THEN 1 ELSE ${fail} END AS guard`).bind(phone, phone, owner.id, owner.name, uid);
  });
}
