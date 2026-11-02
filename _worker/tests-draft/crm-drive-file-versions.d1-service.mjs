/**
 * Service rehearsal on the real engine: the production `recordVersion()` implementation, imported
 * unmodified from _worker/crm-drive-file-registry.js, driven against a THROWAWAY D1 database that
 * lives only in a temporary directory in this sandbox.
 *
 *     node _worker/tests-draft/crm-drive-file-versions.d1-service.mjs
 *     WRANGLER=$(pwd)/node_modules/.bin/wrangler node _worker/tests-draft/crm-drive-versions…  # explicit binary
 *     KEEP=1 node _worker/tests-draft/crm-drive-file-versions.d1-service.mjs                    # keep the scratch db
 *
 * Why it exists: _worker/tests/crm-drive-file-versions.test.mjs proves the same contract on
 * node:sqlite, which is a different driver over the same library. Only D1 answers "does
 * `db.batch()` really roll back?", "does a trigger body see what the statement before it wrote?",
 * and "does the service's SQL survive wrangler's parser?".
 *
 * There is no Google Drive here, and there cannot be: the digests are computed over in-memory
 * synthetic buffers (`SYNTH-*` ids, fabricated sizes), no Drive client is imported, and every D1
 * statement is spawned with `--local` — this file throws if a spawn would omit it, and counts any
 * `--remote` flag as a hard failure. `nasr-crm-test-db` and `nasr-market-db` are never named; the
 * scratch database is `crm-versions-service` with a nil UUID, so wrangler cannot resolve a real one.
 * Cloudflare credentials are stripped from the child environment before anything is spawned.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');
const MIG = path.join(REPO, '_worker', 'migrations');
const DRAFT = path.join(REPO, '_worker', 'migrations-draft');
const DB = 'crm-versions-service';
const SCRATCH = process.env.P2S_DIR || fs_mkdtemp();
const MDIR = path.join(SCRATCH, 'migrations');
const STATE = path.join(SCRATCH, 'state');
const CFG = path.join(SCRATCH, 'wrangler.toml');
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = s => (s || '').replace(ANSI, '');

function fs_mkdtemp() {
  const base = path.join(os.tmpdir(), `crm-drive-versions-service-${Date.now().toString(36)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

// no credential can reach a child process: this rehearsal must not be able to touch an account
const ENV = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLOUDFLARE|CF_|GDRIVE|GOOGLE|GCLOUD|WRANGLER_LOGIN)/i.test(k)) continue;
  ENV[k] = v;
}
Object.assign(ENV, { CI: '1', WRANGLER_SEND_METRICS: 'false', NODE_NO_WARNINGS: '1' });
const CREDENTIALS_PASSED_TO_CHILDREN = Object.keys(ENV).filter(k =>
  /^(CLOUDFLARE|CF_|GDRIVE|GOOGLE|GCLOUD|WRANGLER_LOGIN)/i.test(k)).length;
const WR = process.env.WRANGLER ? [process.env.WRANGLER] : ['npx', '--yes', 'wrangler@4'];

// the scratch project: a real migration chain (0002/0007/0008/0009) + 0010 then 0011 in order
const BASE_SQL = `-- rehearsal base: the tables 0004..0006 expect, so the chain applies in order
CREATE TABLE IF NOT EXISTS areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT,
  title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL, price REAL,
  bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crm_conversations (id TEXT PRIMARY KEY, crm_contact_id TEXT);
CREATE TABLE IF NOT EXISTS crm_opportunities (id TEXT PRIMARY KEY);
`;
mkdirSync(MDIR, { recursive: true });
const files = [['0000_rehearsal_base.sql', BASE_SQL]];
for (const n of ['0002_crm_internal_auth.sql', '0007_crm_drive_file_registry.sql',
  '0008_crm_phase4_analysis.sql', '0009_crm_drive_review_workflow.sql']) {
  files.push([n, readFileSync(path.join(MIG, n), 'utf8')]);
}
files.forEach(([n, t], i) => writeFileSync(path.join(MDIR, `${String(i).padStart(4, '0')}_${n}`), t));
// the drafts under rehearsal are applied by hand, in order, after this chain
writeFileSync(path.join(SCRATCH, 'empty.mjs'), 'export default { fetch() { return new Response("ok"); } };\n');
writeFileSync(CFG, `name = "${DB}"\nmain = "empty.mjs"\ncompatibility_date = "2026-11-01"\n\n`
  + `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${DB}"\n`
  + `database_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "./migrations"\n`);

let spawns = 0, withoutLocal = 0, remoteFlagged = 0, splitBatches = 0;
function shRaw(args) {
  spawns++;
  const r = spawnSync(args[0], args.slice(1), { cwd: SCRATCH, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`);
  return { out: strip(r.stdout) + strip(r.stderr), status: r.status ?? -1 };
}
// wrangler's --json mode reports failure as {"error":{"text":…}} with no ✘ marker, so the real error
// has to be pulled out of that shape before anything is parsed as a result set.
function errText(out) {
  const j = /"error"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(out);
  if (j) { try { return JSON.parse(`"${j[1]}"`); } catch { return j[1]; } }
  const e = /✘\s*\[ERROR\]\s*([\s\S]{0,400})/.exec(out);
  return e ? e[1].trim() : null;
}
function sh(args, { label = '' } = {}) {
  if (args.includes('--remote')) remoteFlagged++;
  if (args[0] !== WR[0] && !String(args[0]).endsWith('wrangler')) {
    // only wrangler may be spawned from here
    throw new Error(`refusing to spawn a non-wrangler command: ${label || args[0]}`);
  }
  if (args.includes('execute') && !args.includes('--local')) withoutLocal++;
  const { out, status } = shRaw(args);
  const t = errText(out);
  if (t) throw new Error(`${label || 'wrangler'}: ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
  if (status !== 0) throw new Error(`${label || 'wrangler'} exited ${status}: ${out.replace(/\s+/g, ' ').slice(0, 400)}`);
  return out;
}
function json(out, what) {
  const a = out.indexOf('['), b = out.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error(`${what}: no JSON from wrangler:\n${out.slice(0, 1500)}`);
  try { return JSON.parse(out.slice(a, b + 1)); }
  catch (e) { throw new Error(`${what}: unparseable JSON (${e.message}):\n${out.slice(0, 1500)}`); }
}
function execFile(p, what) {
  const out = sh([...WR, 'd1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE,
    '--file', p, '--json'], { label: what });
  const rs = json(out, what);
  for (const r of rs) {
    if (r && r.success === false) {
      throw new Error(`${what}: ${JSON.stringify(r.error ?? r).replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  return rs;
}
const tmpCount = { n: 0 };
function terminate(text) {
  // each statement must end with ';': a file of two unseparated statements is one syntax error, and
  // that is exactly what a batch() of two library SQL strings looks like once the binds are inlined
  return text.trim().endsWith(';') ? `${text.trim()}\n` : `${text.trim()};\n`;
}
function runScript(sql, what) {
  const f = path.join(SCRATCH, `stmt-${String(++tmpCount.n).padStart(4, '0')}.sql`);
  writeFileSync(f, terminate(sql));
  return execFile(f, what);
}
function quote(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function render(sql, binds) {
  if (!binds.length) return sql;
  let i = 0, out = '';
  for (const ch of sql) out += (ch === '?' && i < binds.length) ? quote(binds[i++]) : ch;
  if (i !== binds.length) throw new Error(`bind count mismatch (${i}/${binds.length}) for: ${sql.slice(0, 160)}`);
  return out;
}
// a D1-shaped binding over the CLI, so the service module needs no test-only code path.
// `mode` lets one rehearsal force the failure shapes the service must survive.
const knobs = { failAfterVersionInsert: false, breakLastStatementOfBatch: false };
function makeDb() {
  class Stmt {
    constructor(sql) { this._sql = sql; this._binds = []; }
    bind(...b) { this._binds = b; return this; }
    allSync() { const rs = runScript(render(this._sql, this._binds), 'select'); return rs.flatMap(r => r.results || []); }
    async all() { return { results: this.allSync() }; }
    async first() { return this.allSync()[0] ?? null; }
    async run() {
      const rs = runScript(render(this._sql, this._binds), 'run');
      const changes = rs.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
      return { meta: { changes, last_row_id: rs.at(-1)?.meta?.last_row_id ?? null } };
    }
    toString() { return render(this._sql, this._binds); }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(statements) {
      const parts = statements.map(s => s.toString());
      if (knobs.failAfterVersionInsert) {
        // a crash between the ledger write and the projection: the first statement is committed, the
        // rest never run — the exact partial-failure shape the service must be able to recover from
        splitBatches++;
        runScript(terminate(parts[0]), 'split');
        throw new Error('simulated crash after the version insert');
      }
      if (knobs.breakLastStatementOfBatch) parts.push('SELECT * FROM table_that_does_not_exist');
      runScript(parts.map(terminate).join('\n'), 'batch');
      return statements.map(() => ({ results: [], meta: { changes: 0 } }));
    },
  };
}

const DIFFNOTES = [];
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(q));
    else out.push(q);
  }
  return out;
}
// a rehearsal that mutates its scratch database proves nothing on a used one: the "no draft applied yet"
// precondition is already consumed and the object counts describe the previous run. Refuse, don't misreport.
const heldState = walk(STATE).filter(f => /\.sqlite(-wal|-shm|-reset)?$/.test(f));
if (heldState.length && process.env.REUSE_SCRATCH !== '1') {
  process.stderr.write(`refusing to rehearse on a used scratch database: ${STATE} holds ${heldState.map(f => path.basename(f)).join(', ').slice(0, 160)}\n`
    + `start a clean run (export P2S_DIR=$(mktemp -d)) or set REUSE_SCRATCH=1 to proceed anyway\n`);
  process.exit(1);
}

const checks = [];
function check(name, fn) {
  try { const note = fn(); checks.push([true, name, note || '']); }
  catch (e) { checks.push([false, name, String(e.message || e).split('\n')[0]]); }
}
async function acheck(name, fn) {
  try { const note = await fn(); checks.push([true, name, note && typeof note === 'string' ? note : '']); }
  catch (e) { checks.push([false, name, String(e.message || e).split('\n')[0]]); }
}
function expectRefusal(name, promise, code) {
  return promise.then(
    () => { throw new Error(`was accepted, expected ${code}`); },
    err => {
      const m = String(err && err.message || err);
      if (!m.includes(code)) throw new Error(`failed with the wrong reason: ${m.slice(0, 160)} (expected ${code})`);
      return `refused ${code}`;
    });
}
const sha = s => createHash('sha256').update(s).digest('hex');
const T0 = '2026-10-01T09:00:00.000Z', T1 = '2026-11-02T09:00:00.000Z', T2 = '2026-11-03T09:00:00.000Z';

// ---------------------------------------------------------------- the database, then the service
const db = makeDb();
const sql = (text, ...binds) => runScript(render(text, binds), 'probe').flatMap(r => r.results || []);
const one = (text, ...binds) => sql(text, ...binds)[0] ?? null;
const regRow = (tag, cols = '*') => {
  const fileId = `SYNTH-${tag}`;
  return one(`SELECT ${cols} FROM crm_drive_file_registry WHERE drive_file_id = ${quote(fileId)}`);
};
const rows = (ref, ...rest) => sql(`SELECT version_seq AS seq, content_sha256 AS digest, evidence_class AS e,
    size_bytes AS n, repeat_of_version_ref AS rep FROM crm_drive_file_version WHERE drive_ref = ?
    ORDER BY version_seq`, ref, ...rest);
const inventory = () => {
  const m = {};
  for (const r of sql("SELECT type AS t, name AS n FROM sqlite_master ORDER BY 1, 2")) m[`${r.t}:${r.n}`] = 1;
  return m;
};
// an inventory of `type:name` keys that only ever GROWS: an additive migration must remove none, and the
// ordering of a word list is not a reliable subsequence test after `ALTER TABLE ADD COLUMN` renames things
const objectsOnlyGrew = (before, after) => Object.keys(before).every(k => k in after);

const REG_PATH = path.join(REPO, '_worker', 'crm-drive-file-registry.js');
const REG = await import(pathToFileURL(REG_PATH).href);
const { deriveDriveRef, hasVersionLedger, insertNewDriveFileStrict, recordContentHash,
  recordInspectionSuccess, recordVersion, verifyVersionBinding } = REG;

const beforeMigrations = inventory();
check('M0 the scratch database starts with no registry at all', () => {
  const n = one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'
    AND name = 'crm_drive_file_registry'`).c;
  if (n !== 0) throw new Error('a previous rehearsal left state behind — use a fresh P2S_DIR');
  return 'a new file in a new directory';
});
check('M1 the 0002/0007/0008/0009 chain applies in order', () => {
  sh([...WR, 'd1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE],
    { label: 'migrations' });
  const mt = one("SELECT name AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%d1_migrations' ORDER BY 1").n;
  if (!mt) throw new Error('no migration ledger table on the scratch database');
  const t = one(`SELECT name AS n FROM ${mt} ORDER BY id DESC LIMIT 1`).n;
  if (!/0009/.test(t)) throw new Error(`latest migration is ${t}`);
  return `latest=${t}`;
});

// 1) the ledger is not there yet — the service must degrade, not improvise
await acheck('D1 without 0010 the service refuses instead of writing a projection nobody can verify', async () => {
  await insertNewDriveFileStrict(db, { drive_file_id: 'SYNTH-NOLEDGER', file_name: 'n.zip',
    mime_type: 'application/zip', file_size: 1024, drive_created_at: T0, drive_modified_at: T0, last_seen_at: T0 });
  let code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-NOLEDGER', contentSha256: sha('x'), sizeBytes: 1024, observedAt: T0 });
  } catch (e) { code = String(e.message).split(':')[0]; }
  if (code !== 'VERSION_LEDGER_UNAVAILABLE') throw new Error(`got ${code}`);
  const ledger = one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'
    AND name = 'crm_drive_file_version'`).c;
  if (ledger !== 0) throw new Error('the ledger is already here; this check needs a pre-0010 database');
  const after = one(`SELECT content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-NOLEDGER'`);
  if (after.c !== null) throw new Error('the refusal changed state');
  const legacy = await recordContentHash(db, { driveFileId: 'SYNTH-NOLEDGER', contentSha256: sha('x'), hashedAt: T0 });
  if (legacy.processing_status !== 'hashed') throw new Error('the pre-0010 caller broke, too');
  return 'ledger absent -> pre-0010 behaviour intact';
});

const migDir = f => (existsSync(path.join(MIG, f)) ? path.join(MIG, f) : path.join(DRAFT, f));
check('M2 0010 applies on D1 and only adds objects', () => {
  sh([...WR, 'd1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE,
    '--file', migDir('0010_crm_drive_file_versions.sql')], { label: 'apply 0010' });
  const after = inventory();
  const added = Object.keys(after).filter(k => !(k in beforeMigrations));
  if (!added.length) throw new Error('nothing was added');
  if (!objectsOnlyGrew(beforeMigrations, after)) throw new Error('a pre-existing object disappeared');
  const reg = one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE tbl_name = 'crm_drive_file_registry'
    AND type = 'index'`).c;
  return `+${added.length} objects, registry indexes now ${reg}`;
});
check('M3 0011 applies right after 0010 (the promotion order that is documented)', () => {
  sh([...WR, 'd1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE,
    '--file', migDir('0011_crm_drive_file_intake_review.sql')], { label: 'apply 0011' });
  const t = one("SELECT name AS n FROM sqlite_master WHERE name = 'crm_drive_file_review_case'").n;
  if (t !== 'crm_drive_file_review_case') throw new Error('0011 did not land');
  return '0010 then 0011, both accepted';
});

async function newFile(tag, { size = 1024, modifiedAt = T0 } = {}) {
  return insertNewDriveFileStrict(db, { drive_file_id: `SYNTH-${tag}`, file_name: `${tag}.zip`,
    mime_type: 'application/zip', file_size: size, drive_created_at: T0, drive_modified_at: modifiedAt,
    last_seen_at: modifiedAt });
}

// 2) the write itself, and the order it happens in
const refA = await deriveDriveRef('SYNTH-A');
await acheck('V1 a first version is recorded and the projection is moved by the ledger, not by hand', async () => {
  await newFile('A');
  if (await hasVersionLedger(db) !== true) throw new Error('the probe says the ledger is absent');
  const dA = sha('A-v1');
  const out = await recordVersion(db, { driveFileId: 'SYNTH-A', contentSha256: dA, sizeBytes: 1024,
    evidenceClass: 'declared_by_writer', observedBy: 'intake_pipeline', observedAt: T0 });
  if (out.status !== 'recorded' || out.version_seq !== 1) throw new Error(JSON.stringify(out).slice(0, 160));
  if (out.version_ref !== `${refA}#1`) throw new Error(`version_ref=${out.version_ref}`);
  const r = regRow('A', 'content_sha256 AS c, head_version_seq AS h, versions_observed AS n, head_evidence_class AS e');
  if (r.c !== dA || r.h !== 1 || r.n !== 1 || r.e !== 'declared_by_writer') throw new Error(JSON.stringify(r));
  const ok = await verifyVersionBinding(db, 'SYNTH-A');
  if (ok.aligned !== true || ok.head_version_seq !== 1) throw new Error(`read-back refused: ${JSON.stringify(ok)}`);
  return 'row first, projection second, both agreeing';
});
check('V1b D1 ran the ledger\'s own projection trigger inside the same batch', () => {
  const r = regRow('A', 'head_version_seq AS h, versions_observed AS n, drive_ref AS d');
  if (r.h !== 1 || r.n !== 1) throw new Error(`head=${r.h} observed=${r.n}`);
  if (r.d !== refA) throw new Error('the file row was never anchored to its ref');
  return 'head and counters moved in-engine, not by the service';
});

// 3) idempotency and retry
await acheck('V2 the same digest again is not a new version, and 6 retries leave one row', async () => {
  const dA = sha('A-v1');
  for (let i = 0; i < 6; i++) {
    const again = await recordVersion(db, { driveFileId: 'SYNTH-A', contentSha256: dA, sizeBytes: 1024, observedAt: T0 });
    if (again.status !== 'unchanged') throw new Error(`retry ${i} said ${again.status}`);
  }
  const rs = rows(refA);
  if (rs.length !== 1) throw new Error(`${rs.length} rows after retries`);
  const r = regRow('A', 'processing_attempts AS a, versions_observed AS v');
  if (r.a !== 0 || r.v !== 1) throw new Error(`attempts=${r.a} versions=${r.v}`);
  return '6 calls, 1 row, no counter churn';
});
await acheck('V3 a change of content at identical size and mtime is a version; a return to old bytes is a repeat', async () => {
  const dB = sha('A-v2');
  const second = await recordVersion(db, { driveFileId: 'SYNTH-A', contentSha256: dB, sizeBytes: 1024,
    driveModifiedAt: T0, observedAt: T1 });
  if (second.status !== 'recorded' || second.version_seq !== 2) throw new Error(JSON.stringify(second).slice(0, 160));
  const dA = sha('A-v1');
  const back = await recordVersion(db, { driveFileId: 'SYNTH-A', contentSha256: dA, sizeBytes: 1024, observedAt: T2 });
  if (back.status !== 'recorded' || back.version_seq !== 3) throw new Error(`the return to old bytes said ${back.status}@${back.version_seq}`);
  if (back.repeat_of_version_ref !== `${refA}#1`) throw new Error(`repeat pointer=${back.repeat_of_version_ref}`);
  const rs = rows(refA);
  if (rs.length !== 3) throw new Error(`${rs.length} rows, expected 3`);
  if (rs[2].seq !== 3 || rs[2].digest !== dA) throw new Error(JSON.stringify(rs[2]));
  if (rs[2].rep !== `${refA}#1`) throw new Error(`repeat_of=${rs[2].rep}`);
  const reg = regRow('A', 'content_sha256 AS c, head_version_seq AS h, versions_observed AS v');
  if (reg.c !== dA || reg.h !== 3 || reg.v !== 3) throw new Error(JSON.stringify(reg));
  return 'A,B,A -> 3 rows, the last pointing at the first';
});

// 4) content verified before it is recorded
await acheck('V4 the digest is checked against the bytes before any row is written', async () => {
  await newFile('V');
  const bytes = new TextEncoder().encode('synthetic archive body');
  const good = sha('synthetic archive body');
  let code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-V', contentSha256: sha('a different claim'), sourceBytes: bytes,
      sizeBytes: bytes.length, observedAt: T0, receiptRef: 'p2s:v' });
  } catch (e) { code = String(e.message).split(':')[0]; }
  if (code !== 'DIGEST_MISMATCH') throw new Error(`claimed digest: got ${code}`);
  if (rows(await deriveDriveRef('SYNTH-V')).length !== 0) throw new Error('a row was written for a mismatched digest');
  code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-V', contentSha256: good, sourceBytes: bytes, sizeBytes: bytes.length,
      observedAt: T0 });
  } catch (e) { code = String(e.message).split(':')[0]; }
  if (code !== 'MISSING_RECOMPUTE_RECEIPT') throw new Error(`receipt-less recompute: got ${code}`);
  const rec = await recordVersion(db, { driveFileId: 'SYNTH-V', contentSha256: good, sourceBytes: bytes,
    sizeBytes: bytes.length, evidenceClass: 'verified_local_recompute', receiptRef: 'p2s:v/1', observedAt: T0 });
  if (rec.status !== 'recorded' || rec.evidence_class !== 'verified_local_recompute') throw new Error(JSON.stringify(rec).slice(0, 160));
  return 'hash first; only a verified claim earns the strong evidence class';
});

// 5) the ten malformed / dishonest claims, refused by name
await acheck('V5 twelve dishonest or malformed claims are refused with a code, and change nothing', async () => {
  const ref0 = await deriveDriveRef('SYNTH-A');
  const n0 = rows(ref0).length;
  const cases = [
    ['no digest at all', { driveFileId: 'SYNTH-A', sizeBytes: 10, observedAt: T0 }, 'MISSING_CONTENT_SHA256'],
    ['digest too short', { driveFileId: 'SYNTH-A', contentSha256: 'abc123', sizeBytes: 10, observedAt: T2 }, 'INVALID_SHA256_DIGEST'],
    ['digest too long', { driveFileId: 'SYNTH-A', contentSha256: 'a'.repeat(65), sizeBytes: 10, observedAt: T2 }, 'INVALID_SHA256_DIGEST'],
    ['non-hex digest', { driveFileId: 'SYNTH-A', contentSha256: 'z'.repeat(64), sizeBytes: 10, observedAt: T2 }, 'INVALID_SHA256_DIGEST'],
    ['digest of empty bytes for a non-empty file', { driveFileId: 'SYNTH-A', contentSha256: sha(''), sizeBytes: 10, observedAt: T2 }, 'DIGEST_OF_EMPTY_INPUT'],
    ['negative size', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: -1, observedAt: T2 }, 'INVALID_FILE_SIZE'],
    ['unknown evidence class', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, evidenceClass: 'trust_me', observedAt: T2 }, 'INVALID_EVIDENCE_CLASS'],
    ['an unproven recompute claim', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, evidenceClass: 'verified_local_recompute', observedAt: T2 }, 'MISSING_RECOMPUTE_BYTES'],
    ['unknown observer', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, observedBy: 'ghost', observedAt: T2 }, 'INVALID_OBSERVER'],
    ['drive revision with letters', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, observedAt: T2, driveRevision: 'r1x' }, 'INVALID_DRIVE_REVISION'],
    ['drive md5 of the wrong length', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, observedAt: T2, driveMd5: 'd'.repeat(31) }, 'INVALID_DRIVE_MD5'],
    ['a receipt ref with a space', { driveFileId: 'SYNTH-A', contentSha256: sha('y'), sizeBytes: 10, observedAt: T2, receiptRef: 'p2s:has space' }, 'INVALID_RECEIPT_REF'],
  ];
  const seen = [];
  for (const [what, args, code] of cases) {
    try {
      await recordVersion(db, args);
      throw new Error(`${what} was accepted`);
    } catch (e) {
      const m = String(e.message);
      if (!m.includes(code)) throw new Error(`${what}: ${m.slice(0, 120)} (expected ${code})`);
      seen.push(code);
    }
  }
  if (rows(ref0).length !== n0) throw new Error('a refusal wrote a row');
  return `${cases.length} claims refused, ${new Set(seen).size} distinct codes`;
});
await acheck('V5b an upper-case digest is normalised, not treated as different content', async () => {
  const upper = sha('A-v1').toUpperCase();
  const out = await recordVersion(db, { driveFileId: 'SYNTH-A', contentSha256: upper, sizeBytes: 1024,
    observedAt: T2 });
  if (out.status !== 'unchanged') throw new Error(`status=${out.status}`);
  if (rows(refA).length !== 3) throw new Error(`${rows(refA).length} rows: a case change must not create a version`);
  return 'same bytes, same version — the ledger is case-insensitive like the rest of the module';
});
await acheck('V6 a drive_file_id the registry does not know has nowhere to record to', async () => {
  let code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-NEVER-SEEN', contentSha256: sha('x'), sizeBytes: 10, observedAt: T0 });
  } catch (e) { code = String(e.message).split(':')[0]; }
  if (code !== 'DRIVE_FILE_NOT_FOUND') throw new Error(`got ${code}`);
  return 'unknown file, no rows';
});

// 6) the state may not outrun the ledger
await acheck('V7 processed is refused while the file row has no version behind its fingerprint', async () => {
  runScript(`INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name, mime_type,
      content_type, processing_status, content_sha256, file_size, drive_created_at, drive_modified_at,
      last_seen_at, created_at, updated_at)
    VALUES ('mirror1','SYNTH-MIRROR','m.zip','m.zip','application/zip','ZIP','metadata_scanned',
      ${quote(sha('mirrored'))},10,${quote(T0)},${quote(T0)},${quote(T0)},${quote(T0)},${quote(T0)});`, 'mirror');
  const gate = await expectRefusal('gate', recordInspectionSuccess(db, { driveFileId: 'SYNTH-MIRROR',
    processedAt: T1, receiptRef: 'p2s:mirror', extractedRecordsCount: 1 }), 'VERSION_BINDING_MISSING');
  const s = one(`SELECT processing_status AS s FROM crm_drive_file_registry WHERE id = 'mirror1'`).s;
  if (s !== 'metadata_scanned') throw new Error(`the refusal moved the state to ${s}`);
  await recordContentHash(db, { driveFileId: 'SYNTH-MIRROR', contentSha256: sha('mirrored'), hashedAt: T0 });
  const done = await recordInspectionSuccess(db, { driveFileId: 'SYNTH-MIRROR', processedAt: T1,
    receiptRef: 'p2s:mirror', extractedRecordsCount: 1 });
  if (done.processing_status !== 'processed') throw new Error(`status=${done.processing_status}`);
  return `${gate}; then the version made it a fact`;
});
await acheck('V8 a head that moved past the projected fingerprint blocks the state until the retry converges', async () => {
  await newFile('DRIFT');
  const refD = await deriveDriveRef('SYNTH-DRIFT');
  await recordContentHash(db, { driveFileId: 'SYNTH-DRIFT', contentSha256: sha('drift-v1'), hashedAt: T0 });
  runScript(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
      evidence_class, size_bytes, observed_at, observed_by)
    VALUES (${quote(`${refD}#2`)},${quote(refD)},2,${quote(sha('drift-v2'))},'declared_by_writer',11,
      ${quote(T1)},'reconciliation');`, 'bare version');
  const msg = await expectRefusal('drift', recordInspectionSuccess(db, { driveFileId: 'SYNTH-DRIFT',
    processedAt: T1, receiptRef: 'p2s:drift', extractedRecordsCount: 1 }), 'VERSION_BINDING_MISMATCH');
  const fixed = await recordVersion(db, { driveFileId: 'SYNTH-DRIFT', contentSha256: sha('drift-v2'),
    sizeBytes: 11, observedAt: T2 });
  if (fixed.status !== 'projection_repaired') throw new Error(`retry said ${fixed.status}`);
  if (one(`SELECT content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-DRIFT'`).c !== sha('drift-v2')) {
    throw new Error('the retry did not move the projection onto the head');
  }
  const done = await recordInspectionSuccess(db, { driveFileId: 'SYNTH-DRIFT', processedAt: T2,
    receiptRef: 'p2s:drift', extractedRecordsCount: 1 });
  if (done.processing_status !== 'processed') throw new Error(`status=${done.processing_status}`);
  return `${msg}; one retry aligned it, no third row`;
});

// 7) failure shapes: what the real engine does with a half-finished batch
await acheck('V9 a statement failing at the end of the batch leaves nothing behind (D1 atomicity, measured)', async () => {
  await newFile('ATOMIC');
  const ref = await deriveDriveRef('SYNTH-ATOMIC');
  const before = rows(ref).length;
  knobs.breakLastStatementOfBatch = true;
  let code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-ATOMIC', contentSha256: sha('atomic-v1'), sizeBytes: 1024, observedAt: T0 });
  } catch (e) { code = String(e.message).slice(0, 60); }
  knobs.breakLastStatementOfBatch = false;
  if (code === 'ACCEPTED') throw new Error('a poisoned batch was reported as success');
  const after = rows(ref).length;
  if (after !== before) throw new Error(`${after - before} rows survived a rolled-back batch`);
  const reg = one(`SELECT content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-ATOMIC'`).c;
  if (reg !== null) throw new Error('the projection moved anyway');
  const retry = await recordVersion(db, { driveFileId: 'SYNTH-ATOMIC', contentSha256: sha('atomic-v1'),
    sizeBytes: 1024, observedAt: T0 });
  if (retry.status !== 'recorded' || retry.version_seq !== 1) throw new Error(`retry said ${retry.status}`);
  return 'rolled back whole, and the retry recorded it once';
});
await acheck('V10 a crash between the version row and the projection is repaired by the next call', async () => {
  await newFile('HALF');
  const ref = await deriveDriveRef('SYNTH-HALF');
  knobs.failAfterVersionInsert = true;
  let code = 'ACCEPTED';
  try {
    await recordVersion(db, { driveFileId: 'SYNTH-HALF', contentSha256: sha('half-v1'), sizeBytes: 1024, observedAt: T0 });
  } catch (e) { code = String(e.message).slice(0, 60); }
  knobs.failAfterVersionInsert = false;
  if (code === 'ACCEPTED') throw new Error('the simulated crash was not surfaced');
  const rs = rows(ref);
  if (rs.length !== 1) throw new Error(`${rs.length} rows after a crash between the halves`);
  const reg = one(`SELECT content_sha256 AS c, head_version_seq AS h FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-HALF'`);
  if (reg.h !== 1) throw new Error(`the ledger trigger did not move the head (h=${reg.h})`);
  const again = await recordVersion(db, { driveFileId: 'SYNTH-HALF', contentSha256: sha('half-v1'),
    sizeBytes: 1024, observedAt: T0 });
  if (!['already_recorded', 'unchanged', 'projection_repaired'].includes(again.status)) {
    throw new Error(`retry said ${again.status}`);
  }
  if (rows(ref).length !== 1) throw new Error('the retry duplicated the version');
  const now = one(`SELECT content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-HALF'`).c;
  if (now !== sha('half-v1')) throw new Error('the projection is still behind the head');
  return `crash surfaced (${splitBatches} split batches), retry converged on 1 row`;
});

// 8) the ledger cannot be edited, whatever route is taken
function refusedBy(statement, barrier, what) {
  let code = 'ACCEPTED';
  try { runScript(statement, what); }
  catch (e) { code = String(e.message); }
  if (code === 'ACCEPTED') throw new Error(`${what} was allowed`);
  if (!code.includes(barrier)) throw new Error(`${what}: ${code.slice(0, 140)} (expected ${barrier})`);
  return barrier;
}
check('V11 history cannot be rewritten or erased through raw SQL on D1', () => {
  // a refusal that matches zero rows would "pass" as a hole, so the ledger is compared before and after
  const snapshot = JSON.stringify([rows(refA), one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c,
    one('SELECT COUNT(*) AS c FROM crm_drive_file_registry').c]);
  const notes = [];
  notes.push(refusedBy(`UPDATE crm_drive_file_version SET content_sha256 = ${quote(sha('rewrite'))}
    WHERE drive_ref = ${quote(refA)};`, 'drive_versions_are_append_only', 'rewriting a version'));
  notes.push(refusedBy(`DELETE FROM crm_drive_file_version WHERE drive_ref = ${quote(refA)} AND version_seq = 1;`,
    'drive_versions_are_append_only', 'deleting a version'));
  // two head guards exist: the INSERT-side one that forbids arriving with a head, and the UPDATE-side
  // one that requires the head to equal the ledger. A hand-set 9 fails the second, which is the stronger claim.
  notes.push(refusedBy(`UPDATE crm_drive_file_registry SET head_version_seq = 9, updated_at = ${quote(T2)}
    WHERE drive_file_id = 'SYNTH-A';`, 'registry_head_must_match_ledger', 'moving a head by hand'));
  notes.push(refusedBy(`UPDATE crm_drive_file_registry SET versions_observed = 42, updated_at = ${quote(T2)}
    WHERE drive_file_id = 'SYNTH-A';`, 'registry_head_must_match_ledger', 'inflating the counter'));
  notes.push(refusedBy(`UPDATE crm_drive_file_registry SET content_sha256 = ${quote(sha('forged'))}, updated_at = ${quote(T2)}
    WHERE drive_file_id = 'SYNTH-A';`, 'registry_fingerprint_must_match_recorded_head_version', 'forging a fingerprint'));
  notes.push(refusedBy(`DELETE FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-A';`,
    'registry_row_anchors_versions_or_lineage', 'dropping a file that has history'));
  if (JSON.stringify([rows(refA), one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c,
    one('SELECT COUNT(*) AS c FROM crm_drive_file_registry').c]) !== snapshot) {
    throw new Error('a refused write still changed the data');
  }
  return `${notes.length} refusals, every row still in place`;
});
await acheck('V12 the sequence stays dense under repeat writes, and nothing is skipped', async () => {
  await newFile('RACE');
  const ref = await deriveDriveRef('SYNTH-RACE');
  const times = [T0, T1, T2];
  for (let i = 1; i <= 3; i++) {
    const r = await recordVersion(db, { driveFileId: 'SYNTH-RACE', contentSha256: sha(`race-v${i}`),
      sizeBytes: 1024, observedAt: times[i - 1] });
    if (r.version_seq !== i) throw new Error(`write ${i} landed on ${r.version_seq}`);
  }
  const rs = rows(ref);
  if (rs.map(r => r.seq).join(',') !== '1,2,3') throw new Error(`sequences=${rs.map(r => r.seq).join(',')}`);
  return '1,2,3 with no gap and no duplicate';
});
check('V13 a gap in the sequence is refused by the engine itself', () => {
  const gapRef = `${refA}#9`;
  const gapDigest = sha('gap');
  refusedBy(`INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,
      evidence_class, size_bytes, observed_at, observed_by)
    VALUES (${quote(gapRef)},${quote(refA)},9,${quote(gapDigest)},'declared_by_writer',1,${quote(T2)},'reconciliation');`,
    'drive_version_seq_not_next', 'skipping a version number');
  return 'drive_version_seq_not_next';
});

// 9) 0011 sits on top of what this service recorded, unchanged
check('V14 a review case can be opened against a version this service recorded, and only that', () => {
  const head = one(`SELECT head_version_seq AS h, content_sha256 AS c FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-A'`);
  const snap = sha('case-snapshot'), genesis = sha('case-genesis');
  refusedBy(`INSERT INTO crm_drive_file_review_case (case_ref, drive_ref, bound_version_seq, bound_content_sha256,
      review_disposition, status, case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
    VALUES ('frw-' || substr(${quote(refA)},1,16) || '-99',${quote(refA)},99,${quote(head.c)},
      'verify_content_digest','open',${quote(snap)},${quote(genesis)},'intake_pipeline',${quote(T1)});`,
    'file_review_case_requires_a_recorded_version', 'a case pinned to a version nobody recorded');
  runScript(`INSERT INTO crm_drive_file_review_case (case_ref, drive_ref, bound_version_seq, bound_content_sha256,
      review_disposition, status, case_snapshot_sha256, genesis_sha256, opened_by, opened_at)
    VALUES ('frw-' || substr(${quote(refA)},1,16) || '-${head.h}',${quote(refA)},${head.h},${quote(head.c)},
      'verify_content_digest','open',${quote(snap)},${quote(genesis)},'intake_pipeline',${quote(T1)});`, 'open case');
  const n = one('SELECT COUNT(*) AS c FROM crm_drive_file_review_case').c;
  if (n !== 1) throw new Error(`${n} cases`);
  refusedBy('DELETE FROM crm_drive_file_review_case;', 'file_review_cases_are_permanent', 'deleting a case');
  return `case bound to ${refA.slice(0, 8)}#${head.h}, and it cannot be erased`;
});

// 10) the engine's own verdict, then the privacy and locality guards
check('V15a the invariant view reports exactly the row the bootstrap cannot see, and nothing else', () => {
  const v = one('SELECT * FROM crm_drive_version_invariant_violations');
  const bad = Object.entries(v).filter(([, x]) => Number(x) !== 0);
  if (bad.length !== 1 || bad[0][0] !== 'status_without_version' || Number(bad[0][1]) !== 1) {
    throw new Error(bad.map(([k, x]) => `${k}=${x}`).join(',') || 'no violations at all');
  }
  const who = one(`SELECT drive_file_id AS f, drive_ref AS d, processing_status AS s
    FROM crm_drive_file_registry WHERE head_version_seq < 1 AND processing_status IN ('downloaded','hashed','processed','duplicate')`);
  if (who.f !== 'SYNTH-NOLEDGER' || who.d !== null) throw new Error(JSON.stringify(who));
  DIFFNOTES.push('a row that arrived before 0010 without a drive_ref is invisible to the §5 bootstrap — it needs drive_ref first');
  return `1 expected orphan: ${who.f} (drive_ref NULL, status ${who.s})`;
});
check('V15b anchoring that orphan and re-running the draft\'s own bootstrap clears the view', () => {
  const d = sha(String.raw`crm-p4-v1
drive_ref
SYNTH-NOLEDGER`);
  runScript(`UPDATE crm_drive_file_registry SET drive_ref = ${quote(d)}, updated_at = ${quote(T2)}
    WHERE drive_file_id = 'SYNTH-NOLEDGER';`, 'anchor');
  // the §5 statement, taken from the draft itself rather than retyped, so this proves the shipped repair path
  const draft = readFileSync(migDir('0010_crm_drive_file_versions.sql'), 'utf8');
  const at = draft.indexOf('INSERT INTO crm_drive_file_version', draft.indexOf('5) backfill'));
  const stmt = draft.slice(at, draft.indexOf(';', at) + 1);
  if (!stmt.startsWith('INSERT INTO crm_drive_file_version')) throw new Error('could not find the bootstrap statement');
  runScript(stmt, 'bootstrap');
  const v = one('SELECT * FROM crm_drive_version_invariant_violations');
  const bad = Object.entries(v).filter(([, x]) => Number(x) !== 0);
  if (bad.length) throw new Error(bad.map(([k, x]) => `${k}=${x}`).join(','));
  const r = sql(`SELECT version_seq AS q, content_sha256 AS c, evidence_class AS e, observed_by AS b
    FROM crm_drive_file_version WHERE drive_ref = ${quote(d)}`);
  if (r.length !== 1 || r[0].q !== 1 || r[0].e !== 'bootstrap_backfill' || r[0].b !== 'registry_bootstrap') {
    throw new Error(JSON.stringify(r));
  }
  const again = one(`SELECT head_version_seq AS h, versions_observed AS n FROM crm_drive_file_registry
    WHERE drive_file_id = 'SYNTH-NOLEDGER'`);
  if (again.h !== 1 || again.n !== 1) throw new Error(`head=${again.h} observed=${again.n}`);
  runScript(stmt, 'bootstrap-again');
  if (one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c === 0) throw new Error('bootstrap wrote nothing');
  return 'the file the migration could not see became a version-1 row, idempotently';
});
check('V15c the engine\'s own checks are clean', () => {
  const fk = sql('PRAGMA foreign_key_check;');
  if (fk.length) throw new Error(`foreign_key_check: ${fk.length} problems`);
  const loose = one(`SELECT COUNT(*) AS c FROM crm_drive_file_version v
    LEFT JOIN crm_drive_file_registry r ON r.drive_ref = v.drive_ref
    WHERE r.id IS NULL`).c;
  if (loose !== 0) throw new Error(`${loose} version rows with no file row`);
  const malformed = one(`SELECT COUNT(*) AS c FROM crm_drive_file_version
    WHERE length(content_sha256) <> 64 OR content_sha256 GLOB '*[^0-9a-f]*'`).c;
  if (malformed !== 0) throw new Error(`${malformed} malformed digests`);
  const v = one('SELECT * FROM crm_drive_version_invariant_violations');
  if (Object.values(v).some(x => Number(x) !== 0)) throw new Error('the invariant view is not empty');
  const total = one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c;
  return `${total} version rows, zero violations`;
});
check('V15d a second bootstrap pass adds no rows (idempotent, as 0010 promises)', () => {
  const before = one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c;
  const draft = readFileSync(migDir('0010_crm_drive_file_versions.sql'), 'utf8');
  const at = draft.indexOf('INSERT INTO crm_drive_file_version', draft.indexOf('5) backfill'));
  runScript(draft.slice(at, draft.indexOf(';', at) + 1), 'bootstrap-again');
  const after = one('SELECT COUNT(*) AS c FROM crm_drive_file_version').c;
  if (after !== before) throw new Error(`${before} -> ${after}`);
  return `${after} rows, unchanged`;
});
check('V16 the service never invented a key: drive_ref on disk is the repo hash of the id', () => {
  const r = one(`SELECT drive_ref AS d FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTH-A'`).d;
  if (r !== refA) throw new Error('the ref the service derived is not the ref stored');
  return `${refA.slice(0, 12)}… (${refA.length} hex chars, the real id nowhere)`;
});
check('X1 every D1 statement went to a local file, and no credential was passed to a child', () => {
  if (withoutLocal) throw new Error(`${withoutLocal} executes without --local`);
  if (remoteFlagged) throw new Error(`${remoteFlagged} --remote flags`);
  if (CREDENTIALS_PASSED_TO_CHILDREN) throw new Error(`${CREDENTIALS_PASSED_TO_CHILDREN} credential env vars reached a child`);
  const sent = readdirSync(SCRATCH).filter(f => f.startsWith('stmt-')).map(f => readFileSync(path.join(SCRATCH, f), 'utf8')).join('\n');
  const banned = [`${'nasr'}-${'crm'}-${'test'}-${'db'}`, `${'nasr'}-${'market'}-${'db'}`, '65bfcb14', 'ace5c9a2',
    ['api', 'cloudflare', 'com'].join('.')];
  const hit = banned.find(b => sent.includes(b) || readFileSync(CFG, 'utf8').includes(b));
  if (hit) throw new Error(`something reached the database naming ${hit}`);
  if (process.env.CLOUDFLARE_API_TOKEN) throw new Error('a token was present in the parent environment');
  const src = readFileSync(REG_PATH, 'utf8');
  if (/googleapis|drive\.google\.com|fetch\s*\(/.test(src)) throw new Error('the module under rehearsal can reach the network');
  return `${spawns} wrangler spawns, all --local; no Drive client in the module graph`;
});

const held = checks.filter(c => c[0]).length;
for (const [ok, name, note] of checks) {
  const mark = ok ? 'ok  ' : 'FAIL';
  const tail = note ? ` — ${note}` : '';
  process.stdout.write(`${mark} ${name}${tail}\n`);
}
process.stdout.write(`\nSERVICE_D1 ${held}/${checks.length} checks held\n`);
if (DIFFNOTES.length) {
  const notes = DIFFNOTES.map(n => `  - ${n}`).join('\n');
  process.stdout.write(`ENGINE_NOTES:\n${notes}\n`);
}
process.stdout.write(`LOCALITY spawns=${spawns} without_local=${withoutLocal} remote=${remoteFlagged} creds=${CREDENTIALS_PASSED_TO_CHILDREN}\n`);
if (!process.env.KEEP) rmSync(SCRATCH, { recursive: true, force: true });
else process.stdout.write(`scratch kept at ${SCRATCH}\n`);
if (held !== checks.length) {
  const missing = checks.filter(c => !c[0]).map(c => `  - ${c[1]} (${c[2]})`).join('\n');
  process.stdout.write(`SERVICE_BARRIERS_MISSING:\n${missing}\n`);
  process.exit(1);
}
process.stdout.write('SERVICE_ALL_BARRIERS_HELD_ON_D1\n');
