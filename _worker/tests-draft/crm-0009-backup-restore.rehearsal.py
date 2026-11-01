#!/usr/bin/env python3
"""Backup/restore rehearsal for the DRAFT migration 0009: does a bundle preserve EVERY object?

The shipped Phase-2 bundle builder is unsafe on a 0009-era export: it splits statements on ';' while a
trigger body contains semicolons inside BEGIN … END (so it fails outright), and a bundle built from
tables and indexes only restores the data and leaves all 19 triggers and 4 views behind. This rehearsal
proves the replacement, `scripts/crm/build-d1-guarded-backup.mjs`, does not have that hole — end to end
on the real Cloudflare D1 engine, against throwaway local databases:

    build a source DB from the draft + a guarded ledger
      -> wrangler d1 export --local
      -> build the bundle (restore.sql / verify.sql / inventory.json / manifest.json)
      -> restore into an EMPTY second database with `wrangler d1 execute --file`
      -> compare object counts, table names, per-table content digests and d1_migrations
      -> re-run the write probes: every barrier must still refuse on the restored copy
      -> control: restore the same data WITHOUT the guard stage and show the barriers are gone

Nothing here touches a remote database: no `nasr-crm-test-db`, no `nasr-market-db`, no reference
backup, no Drive call. Every seeded row is synthetic filler and no row content is printed.

    python3 _worker/tests-draft/crm-0009-backup-restore.rehearsal.py
    KEEP=1 … # keep the scratch databases for inspection

Exit 0 = the bundle round-trips the schema, the data and every guard.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DRAFT = os.path.join(REPO, '_worker', 'migrations-draft', '0009_crm_drive_review_workflow.sql')
BUILDER = os.path.join(REPO, 'scripts', 'crm', 'build-d1-guarded-backup.mjs')
ROOT = os.environ.get('P9BK_DIR') or tempfile.mkdtemp(prefix='crm-0009-backup-')
ENV = dict(os.environ, CI='1', WRANGLER_SEND_METRICS='false')
_wr = os.environ.get('WRANGLER') or shutil.which('wrangler')
WRANGLER = [_wr] if _wr else ['npx', '--yes', 'wrangler@4']

RUN = 'p9bk-source'
LIVE = '1' * 64
HEX32 = 'lower(hex(randomblob(32)))'
TS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
DB_A, DB_B, DB_C = (os.path.join(ROOT, n) for n in ('a', 'b', 'c'))
results = []

# The export is taken from wrangler's default local-state directory (d1 export has no --persist-to
# flag), so every database gets its own directory and we never pass --persist-to at all.
BASE = """CREATE TABLE IF NOT EXISTS crm_drive_analysis_run (
  run_key TEXT PRIMARY KEY CHECK (length(trim(run_key)) BETWEEN 3 AND 160),
  payload_fingerprint TEXT NOT NULL UNIQUE CHECK (length(payload_fingerprint) = 64),
  analysis_version TEXT NOT NULL,
  drive_parent_id TEXT NOT NULL,
  files_expected INTEGER NOT NULL DEFAULT 0,
  files_analyzed INTEGER NOT NULL DEFAULT 0,
  files_processed INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE crm_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR typeof(revoked_at) = 'integer')
);
INSERT INTO crm_sessions(id, token_hash, created_at, expires_at, revoked_at) VALUES
  ('live', '{live}', CAST(strftime('%s','now') AS INTEGER)*1000 - 60000,
   CAST(strftime('%s','now') AS INTEGER)*1000 + 3600000, NULL);
""".format(live=LIVE)

SEED = """
INSERT INTO crm_drive_analysis_run (run_key, payload_fingerprint, analysis_version, drive_parent_id,
  files_expected, files_analyzed, files_processed, files_failed)
  VALUES ('{run}', {fp}, 'p9bk-1', 'FOLDERID', 64, 64, 64, 0);
INSERT INTO crm_drive_review_case (case_ref, case_kind, run_key, drive_file_id, source_content_kind,
  match_class, evidence_type, confidence, signal_kind, crm_contact_id, basis, approve_allowed,
  case_snapshot_sha256, built_at) VALUES
  ('p4r-001','file_to_contact','{run}',{f1},'VCF','exact_match','vcard_tel_digest_equal_primary','high',
   'phone','c0ffee00c0ffee00c0ffee00c0ffee0042','vcard_tel',1,{s1},'2026-11-01T12:00:00.000Z'),
  ('p4r-002','file_to_contact','{run}',{f2},'ZIP','probable_match','transcript_overlap_with_matched_file',
   'low','name','c0ffee00c0ffee00c0ffee00c0ffee0043','name_digest',0,{s2},'2026-11-01T12:00:00.000Z');
INSERT INTO crm_drive_review_seal (case_ref, run_key, envelope_version, algo, kdf, aad_mode,
  key_version, iv_b64u, tag_b64u, ciphertext_b64u, ciphertext_sha256, plaintext_sha256, plaintext_len,
  retention_days, sealed_by, created_at, expires_at) VALUES
  ('p4r-001','{run}','p4rev_v1','AES-256-GCM','HKDF-SHA256','case_bound_v1',1,'AAAAAAAAAAAAAAAA',
   'AAAAAAAAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAAAA','{ct}','{ct}',120,90,'analysis_pipeline',
   '2026-11-01T12:00:00.000Z','2027-01-30T12:00:00.000Z');
INSERT INTO crm_drive_review_chain_head (run_key, head_sha256, event_count, updated_at)
  VALUES ('{run}','{zero}',0,'2026-11-01T12:00:00.000Z');
INSERT INTO crm_drive_review_chain_anchor (run_key, event_seq, head_sha256, event_count, anchor_source,
  anchored_at) SELECT run_key, 0, head_sha256, event_count, 'genesis', '2026-11-01T12:00:00.000Z'
  FROM crm_drive_review_chain_head WHERE run_key='{run}';
""".format(run=RUN, fp=HEX32, f1=HEX32, f2=HEX32, s1=HEX32, s2=HEX32, ct='c' * 64, zero='0' * 64)

EV = """INSERT INTO crm_drive_review_event
  (run_key,event_seq,case_seq,case_ref,event_type,decision_state,reviewer,reviewer_attestation,
   session_hash,reason,reason_sha256,basis_at_event,case_snapshot_sha256,link_applied,merge_authorized,
   contact_write_count,occurred_at,prev_event_sha256,event_sha256,reveal_purpose,reveal_outcome,
   seal_ciphertext_sha256)
 SELECT '{run}', (SELECT event_count+1 FROM crm_drive_review_chain_head WHERE run_key='{run}'),
        (SELECT COUNT(*)+1 FROM crm_drive_review_event e WHERE e.case_ref='{ref}'),
        '{ref}','note',NULL,'nasr.owner','session_label_not_independent_identity',
        '{sess}', '{why}', lower(hex(randomblob(32))),
        (SELECT basis FROM crm_drive_review_case WHERE case_ref='{ref}'),
        (SELECT case_snapshot_sha256 FROM crm_drive_review_case WHERE case_ref='{ref}'),
        0,0,0, {ts},
        (SELECT head_sha256 FROM crm_drive_review_chain_head WHERE run_key='{run}'),
        lower(hex(randomblob(32))), NULL, NULL, NULL
   FROM crm_drive_review_case WHERE case_ref='{ref}';"""


def setup(path, name, with_migrations=True):
    os.makedirs(os.path.join(path, 'migrations'), exist_ok=True)
    with open(os.path.join(path, 'empty.mjs'), 'w') as fh:
        fh.write('export default { fetch() { return new Response("ok"); } };\n')
    with open(os.path.join(path, 'wrangler.toml'), 'w') as fh:
        fh.write('name = "%s"\nmain = "empty.mjs"\ncompatibility_date = "2026-11-01"\n\n' % name)
        fh.write('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\n' % name)
        fh.write('database_id = "00000000-0000-0000-0000-000000000000"\n'
                 'migrations_dir = "./migrations"\n')
    if with_migrations:
        shutil.copy(DRAFT, os.path.join(path, 'migrations', '0009_crm_drive_review_workflow.sql'))
        with open(os.path.join(path, 'migrations', '0001_base.sql'), 'w') as fh:
            fh.write(BASE)


def d1(path, name, sql=None, sql_file=None, json_out=False):
    cmd = WRANGLER + ['d1', 'execute', name, '--local', '--config', os.path.join(path, 'wrangler.toml')]
    if json_out:
        cmd.append('--json')
    cmd += (['--file', sql_file] if sql_file else ['--command', sql])
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=path, env=ENV)
    return (p.stdout or '') + (p.stderr or '')


def rows(path, name, sql):
    txt = d1(path, name, sql=sql, json_out=True).strip()
    for start in (txt.find('['), txt.find('{')):
        if start < 0:
            continue
        try:
            d = json.loads(txt[start:])
        except ValueError:
            continue
        if isinstance(d, list):
            d = d[-1] if d else {}
        if 'results' in d:
            return d['results'] if isinstance(d['results'], list) else []
    raise RuntimeError('unparsable d1 output: ' + txt[-220:])


def check(label, cond, detail=''):
    results.append(bool(cond))
    tail = (' — %s' % str(detail)[:300]) if (detail and not cond) else ''
    print('  %s %s%s' % ('ok  ' if cond else 'FAIL', label, tail))


def allowed(label, path, name, sql):
    txt = d1(path, name, sql=sql)
    check(label, 'executed successfully' in txt, txt.strip()[-180:])


def refused(label, path, name, sql, fragment):
    txt = d1(path, name, sql=sql)
    check(label, fragment in txt and 'executed successfully' not in txt, txt.strip()[-180:])


def table_list(path, name):
    # _cf_* is D1's own bookkeeping (reading it is prohibited: SQLITE_AUTH), sqlite_* is SQLite's
    return [r['name'] for r in rows(path, name,
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            " AND name NOT LIKE '_cf_%' ORDER BY name")]


def digest_of(path, name, table):
    data = rows(path, name, 'SELECT * FROM "%s"' % table)
    blob = json.dumps(sorted(json.dumps(r, sort_keys=True, default=str) for r in data),
                      ensure_ascii=False)
    return hashlib.sha256(blob.encode('utf8')).hexdigest(), len(data)


# ---------------------------------------------------------------- 1) the source database
print('=== 1) build a source database from the draft and fill it with guarded rows ===')
shutil.rmtree(ROOT, ignore_errors=True)
setup(DB_A, 'p9bk-a')
out = subprocess.run(WRANGLER + ['d1', 'migrations', 'apply', 'p9bk-a', '--local',
                                 '--config', os.path.join(DB_A, 'wrangler.toml')],
                     capture_output=True, text=True, cwd=DB_A, env=ENV).stdout
check('the base stub + 0009 applied to the source database through wrangler itself',
      'applied' in out or 'skipped' in out, out.strip()[-160:])
allowed('seed the run, two cases, a live seal and a genesis head', DB_A, 'p9bk-a', SEED)
for i in (1, 2, 3):
    allowed('append event %d through the chain triggers' % i, DB_A, 'p9bk-a',
            EV.format(run=RUN, ref='p4r-001', sess=LIVE, ts=TS, why='event %d for the backup rehearsal' % i))
    d1(DB_A, 'p9bk-a', sql="UPDATE crm_drive_review_chain_head SET"
       " event_count = (SELECT MAX(event_seq) FROM crm_drive_review_event WHERE run_key='%s'),"
       " head_sha256 = (SELECT event_sha256 FROM crm_drive_review_event WHERE run_key='%s'"
       " AND event_seq = (SELECT MAX(event_seq) FROM crm_drive_review_event WHERE run_key='%s'))"
       " WHERE run_key='%s';" % (RUN, RUN, RUN, RUN))
# no manual mirror insert: the after-insert trigger writes the 'trigger' anchors itself, and the
# anchor_source CHECK refuses any other label — which is itself part of the design
check('the anchor mirrors were written by the trigger, not by the seed',
      rows(DB_A, 'p9bk-a', "SELECT COUNT(*) AS n FROM crm_drive_review_chain_anchor"
           " WHERE run_key='%s' AND anchor_source='trigger'" % RUN)[0]['n'] == 3)
OBJ_SQL = ("SELECT type, COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
           " AND name NOT LIKE '_cf_%' GROUP BY type")
counts_before = {r['type']: r['n'] for r in rows(DB_A, 'p9bk-a', OBJ_SQL)}
check('the source really has 19 review triggers and 4 review views that a bad restore could lose',
      counts_before.get('trigger') == 19 and counts_before.get('view') == 4, json.dumps(counts_before))
check('the source ledger reads intact through its own view before any of this',
      rows(DB_A, 'p9bk-a', "SELECT broken_links + seq_gaps + anchor_mismatches AS bad"
           " FROM crm_review_chain_integrity")[0]['bad'] == 0)
tables = table_list(DB_A, 'p9bk-a')
digests_before = {t: digest_of(DB_A, 'p9bk-a', t) for t in tables}

# ---------------------------------------------------------------- 2) export and build the bundle
print('=== 2) export the source and build the guarded bundle ===')
dump = os.path.join(ROOT, 'source-export.sql')
txt = subprocess.run(WRANGLER + ['d1', 'export', 'p9bk-a', '--local', '--output', dump,
                                 '--config', os.path.join(DB_A, 'wrangler.toml')],
                     capture_output=True, text=True, cwd=DB_A, env=ENV).stdout
check('wrangler d1 export produced a dump', os.path.exists(dump) and os.path.getsize(dump) > 1000,
      txt.strip()[-140:])
bundle = os.path.join(ROOT, 'bundle')
env = dict(ENV)
if _wr:
    env['WRANGLER'] = _wr
p = subprocess.run(['node', BUILDER, '--dump', dump, '--out', bundle, '--title', 'rehearsal'],
                   capture_output=True, text=True, cwd=REPO, env=env)
man = json.loads(p.stdout.strip().splitlines()[-1])
check('the builder exits 0 and reports guards_present',
      p.returncode == 0 and man.get('guards_present') is True, (p.stdout + p.stderr)[-200:])
inv = json.load(open(os.path.join(bundle, 'inventory.json')))
check('the bundle carries every object the dump had (tables / indexes / triggers / views)',
      all(inv['counts'][k] == counts_before[k] for k in ('table', 'index', 'trigger', 'view')),
      json.dumps([inv['counts'], counts_before]))
check('and it carries all 19 guards by name, not just as a count',
      len([n for n in inv['objects']['trigger'] if n.startswith('trg_review')]) == 19
      and len([n for n in inv['objects']['view'] if n.startswith('crm_review')]) == 4,
      json.dumps(inv['objects']['trigger'][:6]))
true_count = (sum(inv['counts'][k] for k in ('table', 'index', 'trigger', 'view'))
              + inv['counts']['insert_statements'] + inv['counts']['unclassified'])
naive = len(open(dump).read().split(';'))
check('a split-on-semicolon would have produced %d fragments for %d real statements — the bug this'
      ' builder exists to avoid' % (naive, true_count), naive > true_count, naive)
check('nothing in the dump went unclassified except the PRAGMA and SQLite housekeeping',
      inv['counts']['unclassified'] <= 2, json.dumps(inv['unclassified']))

# ---------------------------------------------------------------- 3) restore into an empty database
print('=== 3) restore into a second, empty database (no migrations applied there) ===')
setup(DB_B, 'p9bk-b', with_migrations=False)
rest = d1(DB_B, 'p9bk-b', sql_file=os.path.join(bundle, 'restore.sql'))
check('restore.sql applies cleanly to an empty database', 'executed successfully' in rest, rest.strip()[-220:])
counts_after = {r['type']: r['n'] for r in rows(DB_B, 'p9bk-b', OBJ_SQL)}
check('the restored database reports the SAME object counts as the source',
      counts_after == counts_before, json.dumps([counts_after, counts_before]))
verify = d1(DB_B, 'p9bk-b', sql_file=os.path.join(bundle, 'verify.sql'), json_out=True)
txt = verify.strip()
vg = json.loads(txt[txt.find('[') if txt.find('[') >= 0 else txt.find('{'):])
blocks = vg if isinstance(vg, list) else [vg]
flat = [r for blk in blocks if isinstance(blk, dict) and isinstance(blk.get('results'), list)
        for r in blk['results']]
vrows = {r['kind']: r['n'] for r in flat if isinstance(r, dict) and 'kind' in r}
check('verify.sql runs on the restored copy and re-counts the guards independently: %s' % json.dumps(vrows),
      vrows.get('review_triggers') == 19 and vrows.get('review_views') == 4
      and vrows.get('review_indexes') == 8 and vrows.get('migrations') == 2, verify[-200:])
tables_b = table_list(DB_B, 'p9bk-b')
check('every table came back, by name', tables_b == tables, json.dumps([tables_b, tables]))
digests_after = {t: digest_of(DB_B, 'p9bk-b', t) for t in tables_b}
diff = [t for t in tables_b if digests_after[t][0] != digests_before.get(t, ('',))[0]]
check('and every table is identical by content digest (%d/%d tables, rows included)'
      % (len(tables_b) - len(diff), len(tables_b)), not diff and len(tables_b) == len(tables), json.dumps(diff))
check('d1_migrations survived the round-trip, so a restored database still knows its schema version',
      rows(DB_B, 'p9bk-b', "SELECT COUNT(*) AS n FROM d1_migrations")[0]['n']
      == rows(DB_A, 'p9bk-a', "SELECT COUNT(*) AS n FROM d1_migrations")[0]['n'])
led = rows(DB_B, 'p9bk-b', "SELECT events, broken_links + seq_gaps + anchor_mismatches AS bad"
           " FROM crm_review_chain_integrity")
check('the restored ledger reads intact through the restored view (the view is the thing the CI gate'
      ' and the review screen both read)', bool(led) and led[0]['bad'] == 0 and led[0]['events'] == 3,
      json.dumps(led))

# ---------------------------------------------------------------- 4) the barriers must still bite
print('=== 4) the guards on the restored copy must refuse the same writes ===')
refused('deleting a ledger event', DB_B, 'p9bk-b',
        "DELETE FROM crm_drive_review_event WHERE run_key='%s';" % RUN, 'review_events_are_append_only')
refused('rewriting a recorded event', DB_B, 'p9bk-b',
        "UPDATE crm_drive_review_event SET reason='rewritten after restore' WHERE run_key='%s'"
        " AND event_seq=1;" % RUN, 'review_events_are_append_only')
refused('re-keying the live seal with different bytes', DB_B, 'p9bk-b',
        "UPDATE crm_drive_review_seal SET ciphertext_b64u = '%s' WHERE case_ref='p4r-001';" % ('B' * 32),
        'review_seal_ciphertext_immutable_while_live')
refused('deleting a live seal', DB_B, 'p9bk-b', "DELETE FROM crm_drive_review_seal WHERE case_ref='p4r-001';",
        'review_seal_delete_before_expiry')
refused('rewriting the anchor mirror', DB_B, 'p9bk-b',
        "UPDATE crm_drive_review_chain_anchor SET head_sha256 = '%s' WHERE run_key='%s' AND event_seq=2;"
        % ('9' * 64, RUN), 'review_anchors_are_append_only')
refused('an event_seq that skips ahead of the head', DB_B, 'p9bk-b',
        "INSERT INTO crm_drive_review_event (run_key,event_seq,case_seq,case_ref,event_type,reviewer,"
        "reviewer_attestation,session_hash,reason,occurred_at,prev_event_sha256,event_sha256,link_applied,"
        "merge_authorized,contact_write_count) VALUES ('%s',99,4,'p4r-001','note','nasr.owner',"
        "'session_label_not_independent_identity','%s','gap','2026-11-02T12:00:00.000Z','%s','%s',0,0,0);"
        % (RUN, LIVE, '0' * 64, '0' * 64), 'review_event_chain_sequence_broken')
allowed('and a legitimate next event is still accepted, so the restored guards are functional rather'
        ' than merely present', DB_B, 'p9bk-b', EV.format(run=RUN, ref='p4r-001', sess=LIVE, ts=TS,
        why='written after the restore'))

# ---------------------------------------------------------------- 5) control: guards stripped
print('=== 5) control: the same data restored WITHOUT the guard stage ===')
raw = open(os.path.join(bundle, 'restore.sql')).read()
cut = raw.index('-- stage 2: the guards')
open(os.path.join(ROOT, 'restore-no-guards.sql'), 'w').write(raw[:cut])
setup(DB_C, 'p9bk-c', with_migrations=False)
rest2 = d1(DB_C, 'p9bk-c', sql_file=os.path.join(ROOT, 'restore-no-guards.sql'))
check('a guard-free bundle restores without any error — which is exactly why nobody notices it',
      'executed successfully' in rest2, rest2.strip()[-180:])
cnt = rows(DB_C, 'p9bk-c', "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'")[0]['n']
rows_before = rows(DB_C, 'p9bk-c', "SELECT COUNT(*) AS n FROM crm_drive_review_event")[0]['n']
allowed('and on that copy the ledger CAN be emptied', DB_C, 'p9bk-c',
        "DELETE FROM crm_drive_review_event WHERE 1=1;")
gone = rows(DB_C, 'p9bk-c', "SELECT COUNT(*) AS n FROM crm_drive_review_event")[0]['n']
check('the control demonstrates the failure mode: %d triggers restored, and %d ledger rows deleted'
      % (cnt, rows_before - gone), cnt == 0 and gone == 0 and rows_before == 3, json.dumps([cnt, rows_before, gone]))
check('the guarded copy, by contrast, still holds its ledger',
      rows(DB_B, 'p9bk-b', "SELECT COUNT(*) AS n FROM crm_drive_review_event")[0]['n'] == 4)
check('and its seal is still there and still unreadable-by-edit',
      rows(DB_B, 'p9bk-b', "SELECT COUNT(*) AS n FROM crm_drive_review_seal")[0]['n'] == 1
      and rows(DB_B, 'p9bk-b', "SELECT length(ciphertext_b64u) AS l FROM crm_drive_review_seal")[0]['l'] == 24)

print()
print('BACKUP_REHEARSAL %d/%d checks passed' % (sum(1 for r in results if r), len(results)))
print('engine=Cloudflare D1 (wrangler --local) scratch=%s remote_databases_touched=none' % ROOT)
if os.environ.get('KEEP') != '1':
    shutil.rmtree(ROOT, ignore_errors=True)
sys.exit(0 if all(results) else 1)
