import { outboxCanonical, OUTBOX_ZERO } from './l2-outbox.js';

const encoder = new TextEncoder();
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Build (but do not persist) provenance events for existing rows. `conversations`
 * and `messages` contain conversation_uid and message_uid strings, respectively.
 * The caller must persist events and coordinate concurrent writers. This read-then-
 * build operation does not prove the rows' origin or atomicity with their creation.
 * `id` and `imported_at` are database-generated and are not part of the hash event.
 */
export async function recordDriveProvenance(db, { runId, fileId, fileHash, conversations, messages }) {
  const head = await db.prepare(
    'SELECT event_seq, entry_hash FROM crm_provenance_ledger WHERE run_id = ? ORDER BY event_seq DESC LIMIT 1',
  ).bind(runId).first();
  let eventSeq = head ? Number(head.event_seq) : 0;
  let prevHash = head ? head.entry_hash : OUTBOX_ZERO;
  const entries = [];
  const groups = [
    { table: 'crm_conversations', uidColumn: 'conversation_uid', fkColumn: 'contact_id', uids: conversations },
    { table: 'crm_conversation_messages', uidColumn: 'message_uid', fkColumn: 'conversation_id', uids: messages },
  ];
  for (const { table, uidColumn, fkColumn, uids } of groups) {
    for (const uid of uids) {
      const row = await db.prepare(`SELECT id, ${fkColumn} FROM ${table} WHERE ${uidColumn} = ?`).bind(uid).first();
      if (!row) throw new Error(`provenance-row-missing:${table}:${uid}`);
      const contentHash = await sha256Hex(outboxCanonical({ id: row.id, [fkColumn]: row[fkColumn] }));
      const event = {
        run_id: runId,
        table_name: table,
        row_id: row.id,
        drive_file_id: fileId,
        drive_file_hash: fileHash,
        content_hash: contentHash,
        event_seq: ++eventSeq,
        prev_hash: prevHash,
      };
      const entryHash = await sha256Hex(outboxCanonical(event));
      entries.push({ ...event, entry_hash: entryHash });
      prevHash = entryHash;
    }
  }
  return entries;
}
