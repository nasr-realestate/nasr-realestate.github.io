// Isolated internal prototype; not wired to an endpoint and does not authorize writes.
// Snapshot must come from a trusted database read; it is never returned or logged.
import { buildAntixWriteGuards } from './crm-antix-write-guards.js';
import { writeAntixMetadataPrototype } from './crm-antix-metadata-write.js';

export async function writeGuardedAntixPrototype(db, items, snapshot, { now = new Date(), excludedNames = [] } = {}) {
  const guards = buildAntixWriteGuards(db, items, snapshot, excludedNames);
  return writeAntixMetadataPrototype(db, items, {
    now, createMissing: true, excludedNames, guardedSnapshot: snapshot, guardedStatements: guards,
  });
}
