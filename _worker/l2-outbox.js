// Proposed isolated-test building block; NOT wired to any existing live writer.
// D1 batch executes these two prepared statements transactionally within one database.
// No claim of atomicity extends to HTTP requests, artifact uploads or other databases.
// Concurrent writers race on the same sequence; the loser rolls back and MUST retry from
// a fresh head. This helper does not retry implicitly and does not handle trigger-created rows.
const allowed = Object.freeze({
  crm_contacts: 'id', crm_contact_phones: 'id', crm_opportunities: 'id',
  crm_customer_requests: 'id', crm_interactions: 'id', crm_followups: 'id',
  crm_conversations: 'id', crm_conversation_messages: 'id', crm_sessions: 'id',
  crm_idempotency_receipts: 'submission_key',
});
const ZERO = '0'.repeat(64);
const enc = new TextEncoder();
const serialize = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
};
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(serialize(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function writeIndustrialRow(db, { runId, table, row }) {
  const idColumn = allowed[table];
  if (!idColumn || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId || '') || !row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('l2-outbox-invalid-input');
  }
  const columns = Object.keys(row).sort();
  if (!columns.length || columns.some(k => !/^[a-z_][a-z0-9_]*$/.test(k)) ||
      typeof row[idColumn] !== 'string' || !row[idColumn] || row[idColumn].length > 256 ||
      columns.some(k => row[k] === undefined || (row[k] !== null && !['string','number','boolean'].includes(typeof row[k])))) {
    throw new Error('l2-outbox-invalid-row');
  }
  const head = await db.prepare('SELECT event_seq, entry_hash FROM l2_outbox WHERE run_id = ? ORDER BY event_seq DESC LIMIT 1').bind(runId).first();
  const eventSeq = head ? Number(head.event_seq) + 1 : 1;
  const prevHash = head?.entry_hash || ZERO;
  const rowHash = await hash({ table, row });
  const event = { run_id: runId, event_seq: eventSeq, table_name: table, row_id: row[idColumn], row_hash: rowHash, prev_hash: prevHash, result: 'proven' };
  const entryHash = await hash(event);
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map(k => row[k]));
  const evidence = db.prepare('INSERT INTO l2_outbox (run_id,event_seq,table_name,row_id,row_hash,prev_hash,entry_hash,result) VALUES (?,?,?,?,?,?,?,?)')
    .bind(runId, eventSeq, table, row[idColumn], rowHash, prevHash, entryHash, 'proven');
  await db.batch([insert, evidence]);
  return { ...event, entry_hash: entryHash };
}
