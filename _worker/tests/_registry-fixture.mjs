// Shared registry fixture (helper module — NOT a test file; `node --test` only runs `*.test.mjs`).
//
// Everything here is in-memory and synthetic: `node:sqlite` in `:memory:`, the real applied migration chain
// from `_worker/migrations/` plus the drafts under `_worker/migrations-draft/`, and files whose ids are
// `SYNTH-*`. No network, no wrangler, no Google Drive, no reference to `nasr-crm-test-db` or
// `nasr-market-db`. New suites import this instead of re-typing the adapter. The two suites written before
// it (crm-drive-file-registry, crm-drive-file-versions) keep their own local copies untouched — they are
// green, and refactoring passing tests to share a helper is churn, not progress.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIG_DIR = path.join(workerDir, 'migrations');
export const DRAFT_DIR = path.join(workerDir, 'migrations-draft');
export const draft = name => {
  const applied = path.join(MIG_DIR, name);
  return existsSync(applied) ? applied : path.join(DRAFT_DIR, name);
};
export const DRAFT_0010 = draft('0010_crm_drive_file_versions.sql');
export const DRAFT_0011 = draft('0011_crm_drive_file_intake_review.sql');

export const T0 = '2026-10-01T09:00:00.000Z';
export const T1 = '2026-11-02T09:00:00.000Z';
export const T2 = '2026-11-03T09:00:00.000Z';
export const sha = text => createHash('sha256').update(text).digest('hex');

export const rowsOf = (sqlite, sql) => sqlite.prepare(sql).all();
export const oneOf = (sqlite, sql) => sqlite.prepare(sql).get();

/** The D1-shaped binding the service expects, over node:sqlite, with `batch()` as one savepoint — which is
 *  what makes "the version row and its projection land together, or neither" testable in-process. */
export function wrapD1(sqlite, { failOnBatchStep = null } = {}) {
  const makeStmt = (sql, values = []) => ({
    bind: (...next) => makeStmt(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => sqlite.prepare(sql).run(...values),
    _exec: () => sqlite.prepare(sql).run(...values),
    _sql: sql,
  });
  return {
    prepare: sql => makeStmt(sql),
    batch: async statements => {
      sqlite.exec('SAVEPOINT d1_batch');
      try {
        for (let i = 0; i < statements.length; i += 1) {
          if (failOnBatchStep === i) throw new Error('simulated crash after the first statement');
          statements[i]._exec();
        }
        sqlite.exec('RELEASE d1_batch');
      } catch (err) {
        sqlite.exec('ROLLBACK TO d1_batch');
        sqlite.exec('RELEASE d1_batch');
        throw err;
      }
    },
  };
}

/**
 * A database that looks like the one CRM runs on: the applied chain in order, then whichever drafts the
 * test asked for. Migrations whose tables this fixture deliberately omits are skipped — the registry chain
 * does not depend on them, and the point is the DDL the service writes against.
 */
export function buildRegistry({ ledger = true, intake = false, failOnBatchStep = null } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT,
      title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
      bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL);
  `);
  // `ledger: false` does not mean "no drafts" any more. 0010 was promoted, so the version ledger now arrives
  // with the applied chain: the flag has to *exclude* that file, or every test that claims "before the ledger
  // existed" would run against a schema that has the very table it says is absent. The mirror case matters
  // just as much: when the migration is already in the applied chain there is nothing to exec, and applying
  // `CREATE TABLE crm_drive_file_version` a second time throws `already exists` — which kills every suite in
  // a file at the fixture, where a reader would see 13 failures and no assertion.
  const LEDGER_FILE = '0010_crm_drive_file_versions.sql';
  const INTAKE_FILE = '0011_crm_drive_file_intake_review.sql';
  const promoted = f => existsSync(path.join(MIG_DIR, f));
  for (const file of readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (!ledger && file === LEDGER_FILE) continue;
    try { sqlite.exec(readFileSync(path.join(MIG_DIR, file), 'utf8')); } catch { /* unrelated tables */ }
  }
  if (ledger && !promoted(LEDGER_FILE)) sqlite.exec(readFileSync(DRAFT_0010, 'utf8'));
  if (intake && !promoted(INTAKE_FILE)) sqlite.exec(readFileSync(DRAFT_0011, 'utf8'));
  return { sqlite, db: wrapD1(sqlite, { failOnBatchStep }) };
}

/** One synthetic file registered exactly the way the intake path registers a newly discovered file. */
export async function newRegistryFile(db, tag, { size = 1024, modifiedAt = T0, parentId = 'SYNTH-FOLDER' } = {}) {
  const { insertNewDriveFileStrict } = await import('../crm-drive-file-registry.js');
  const row = await insertNewDriveFileStrict(db, {
    drive_file_id: `SYNTH-${tag}`,
    file_name: `${tag}.zip`,
    mime_type: 'application/zip',
    file_size: size,
    drive_parent_id: parentId,
    drive_created_at: T0,
    drive_modified_at: modifiedAt,
    last_seen_at: modifiedAt,
  });
  if (!row) throw new Error(`the synthetic file SYNTH-${tag} was not registered`);
  return row;
}
