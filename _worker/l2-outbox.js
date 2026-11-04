// Proposed isolated-test building block; NOT wired to any existing live writer.
// D1 batch executes these two prepared statements transactionally within one database.
// D1 does not guarantee atomicity across external systems: HTTP, artifact uploads,
// and other databases are outside this transaction. For HTTP callers, the Worker must
// commit each row and its evidence in the same D1 batch and return the outbox identity.
// This helper does not make an HTTP request and is not yet integrated with any route.
// Concurrent writers race on the same sequence; the loser rolls back and MUST retry from
// a fresh head. This helper does not retry implicitly and does not handle trigger-created rows.
export const OUTBOX_TABLES = Object.freeze({
  crm_contacts: 'id', crm_contact_phones: 'id', crm_opportunities: 'id',
  crm_customer_requests: 'id', crm_interactions: 'id', crm_followups: 'id',
  crm_conversations: 'id', crm_conversation_messages: 'id', crm_sessions: 'id',
  crm_idempotency_receipts: 'submission_key',
});
export const OUTBOX_RELATIONS = Object.freeze({
  crm_contact_phones: { contact_id: 'crm_contacts' },
  crm_opportunities: { contact_id: 'crm_contacts', conversation_id: 'crm_conversations' },
  crm_customer_requests: { contact_id: 'crm_contacts' },
  crm_interactions: { contact_id: 'crm_contacts', request_id: 'crm_customer_requests' },
  crm_followups: { contact_id: 'crm_contacts', request_id: 'crm_customer_requests' },
  crm_conversations: { contact_id: 'crm_contacts' },
  crm_conversation_messages: { conversation_id: 'crm_conversations' },
});
export const OUTBOX_ZERO = '0'.repeat(64);
const enc = new TextEncoder();
export const outboxCanonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(outboxCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${outboxCanonical(value[key])}`).join(',')}}`;
};
export async function outboxHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(outboxCanonical(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function writeIndustrialRow(db, { runId, table, row }) {
  const idColumn = Object.hasOwn(OUTBOX_TABLES, table) ? OUTBOX_TABLES[table] : undefined;
  if (!idColumn || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId || '') || !row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('l2-outbox-invalid-input');
  }
  const columns = Object.keys(row).sort();
  if (!columns.length || columns.some(k => !/^[a-z_][a-z0-9_]*$/.test(k)) ||
      typeof row[idColumn] !== 'string' || !row[idColumn] || row[idColumn].length > 256 ||
      columns.some(k => row[k] === undefined || (row[k] !== null && !['string','number'].includes(typeof row[k]) || (typeof row[k] === 'number' && !Number.isFinite(row[k]))))) {
    throw new Error('l2-outbox-invalid-row');
  }
  const head = await db.prepare('SELECT event_seq, entry_hash FROM l2_outbox WHERE run_id = ? ORDER BY event_seq DESC LIMIT 1').bind(runId).first();
  const eventSeq = head ? Number(head.event_seq) + 1 : 1;
  const prevHash = head?.entry_hash || OUTBOX_ZERO;
  const relations = Object.entries(OUTBOX_RELATIONS[table] || {})
    .filter(([column]) => row[column] != null)
    .map(([column, target]) => ({ column, table: target, row_id: String(row[column]) }));
  const columns_json = outboxCanonical(columns);
  const relations_json = outboxCanonical(relations);
  const rowHash = await outboxHash({ table, row });
  const event = { run_id: runId, event_seq: eventSeq, table_name: table, row_id: row[idColumn], row_hash: rowHash, prev_hash: prevHash, result: 'proven', columns_json, relations_json };
  const entryHash = await outboxHash(event);
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map(k => row[k]));
  const evidence = db.prepare('INSERT INTO l2_outbox (run_id,event_seq,table_name,row_id,row_hash,prev_hash,entry_hash,result,columns_json,relations_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(runId, eventSeq, table, row[idColumn], rowHash, prevHash, entryHash, 'proven', columns_json, relations_json);
  await db.batch([insert, evidence]);
  return { ...event, entry_hash: entryHash };
}
