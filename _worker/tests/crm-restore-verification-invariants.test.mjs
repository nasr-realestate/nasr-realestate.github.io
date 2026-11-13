// How a restored database may and may not be checked.
//
// `crm-phase2-backup.yml` proves a backup by loading the generated bundle into an empty SQLite database and
// asserting that it is intact. Until 2026-11-02 it did that with `PRAGMA foreign_keys = ON` *during* the
// load, which does not check "is this a faithful copy" — it checks "did the dump list every parent table
// before every child table". A D1 export lists tables by name, so `a_child` sorts before `z_parent`, the
// child insert is rejected, and a healthy database fails. That is exactly what happened in run 41518627139
// (`build-primary-backup-failed:FOREIGN KEY constraint failed`), on data that `PRAGMA foreign_key_check`
// finds completely clean. The same shape passes an unfaithful copy whose bad rows happen to sort last.
//
// The fix is not to stop checking foreign keys. It is to check them over the whole dataset, which is what
// SQLite's own deferral is for: enforce inside one deferred transaction, and the COMMIT fails if anything
// is still unsatisfied. Both directions are asserted below, because a verifier that only ever sees good
// data proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// A parent whose name sorts AFTER its child: the shape a per-table export produces.
const SCHEMA = `
  CREATE TABLE "a_child" ("id" INTEGER PRIMARY KEY, "p" INTEGER NOT NULL REFERENCES "z_parent"("id"));
  CREATE TABLE "z_parent" ("id" INTEGER PRIMARY KEY, "label" TEXT);
`;
// Statements per table, tables in name order — which is what `d1 export --no-schema` emits, and why the
// child's rows arrive before its parent exists.
const GOOD_DATA = `
  INSERT INTO "a_child" ("id", "p") VALUES (1, 1);
  INSERT INTO "a_child" ("id", "p") VALUES (2, 1);
  INSERT INTO "z_parent" ("id", "label") VALUES (1, 'SYNTH-PARENT');
`;
const BAD_DATA = `
  INSERT INTO "a_child" ("id", "p") VALUES (1, 99);
  INSERT INTO "z_parent" ("id", "label") VALUES (1, 'SYNTH-PARENT');
`;

function loadNaive(data) {
  // the shape that broke the backup workflow: enforcement on, statement by statement
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`${SCHEMA}\n${data}`);
  return db;
}

function loadDeferredAndCheck(data) {
  // the shape the verifier uses now: enforcement kept, insert order made irrelevant
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; BEGIN; PRAGMA defer_foreign_keys = ON;');
  db.exec(`${SCHEMA}\n${data}`);
  db.exec('COMMIT;');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(violations.length, 0, 'post-load check is part of the load, not an afterthought');
  return db;
}

test('insertion order is not an integrity property: valid misordered data must load', () => {
  assert.throws(() => loadNaive(GOOD_DATA), /FOREIGN KEY constraint failed/,
    'this fixture must reproduce the failure the CI job hit, or the test below is decoration');
  const db = loadDeferredAndCheck(GOOD_DATA);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM "a_child"').get().c), 2);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM "z_parent"').get().c), 1);
});

test('deferral defers checking, it does not waive it: a dangling reference still fails', () => {
  assert.throws(() => loadDeferredAndCheck(BAD_DATA),
    /FOREIGN KEY constraint failed|foreign_key_check|violations/,
    'a bundle with an unsatisfied key must not be called restorable');
});

test('the backup verifier keeps the deferred shape and the post-load check', () => {
  const dir = '.github/workflows';
  const file = 'crm-phase2-backup.yml';
  assert.ok(readdirSync(dir).includes(file), `${file} must still exist for this guard to mean anything`);
  const text = readFileSync(`${dir}/${file}`, 'utf8');
  const builder = text.slice(text.indexOf("cat << 'EOF_NODE'"), text.indexOf('EOF_NODE', text.indexOf("cat << 'EOF_NODE'") + 10));
  assert.ok(builder.length > 2000, 'the embedded builder was found — otherwise these assertions are vacuous');
  assert.match(builder, /PRAGMA defer_foreign_keys = ON/,
    'the restored copy must be loaded in one deferred transaction, not enforced statement-by-statement');
  assert.match(builder, /COMMIT;/, 'the deferred transaction has to be committed for the check to bind');
  assert.match(builder, /PRAGMA foreign_key_check/,
    'and the whole-dataset foreign-key check must run after the load — deferral without a check is a hole');
  assert.match(builder, /PRAGMA integrity_check/, 'the restored copy is checked for structural damage too');
  assert.doesNotMatch(builder, /localRestoreDb\.exec\('PRAGMA foreign_keys = ON;'\);\s*\n\s*localRestoreDb\.exec\(bundleText\)/,
    'the naive load-then-hope shape is what failed on valid data; it must not come back by accident');
});

test('backup restore uses a unique scratch name and never deletes a pre-existing database', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/crm-phase2-backup.yml', import.meta.url), 'utf8');
  assert.match(workflow, /EPHEM_RESTORE_NAME="nasr-crm-restore-\$backup_suffix"/);
  assert.match(workflow, /scratch-db-name-exists-refusing-delete/);
  assert.doesNotMatch(workflow, /database\/\$old_ephem/);
});
