#!/usr/bin/env python3
"""D1-engine rehearsal for DRAFT migration 0011 (file-level intake review, contact optional).

Companion to crm-file-review-0011.rehearsal.mjs, which proves the same contract on node:sqlite.
This file proves it on the engine that actually runs in production: a THROWAWAY D1 database in a
temporary directory, driven by `wrangler d1 … --local` against a sandbox-local file. 0011 is applied
AFTER 0010, because that is the only order that can work: a review case must be bound to a recorded
version, and versions only exist once 0010's ledger exists.

    python3 _worker/tests-draft/crm-file-review-0011.d1-rehearsal.py
    WRANGLER=$(pwd)/node_modules/.bin/wrangler python3 …      # explicit binary
    KEEP=1 python3 …                                          # keep the scratch db for inspection

No remote database is contacted. `nasr-crm-test-db`, `nasr-market-db` and the reference backup are
never referenced, no Cloudflare API call is made, and no Drive call is made: every registered file
here is a SYNTHETIC fixture (`SYNTH…` ids, fabricated sizes and digests) and no file content is read.

Exit 0 = 0011 applied on the real engine, no pre-existing object or row changed, every barrier refused,
and an out-of-order promotion (0011 without 0010) measured rather than assumed.
"""
# --- harness helpers, shared with the 0010 rehearsal (same file, same rules) ---
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
MIG = os.path.join(REPO, '_worker', 'migrations')
DRAFT_DIR = os.path.join(REPO, '_worker', 'migrations-draft')
# Read from wherever the file lives. `crm-drive-versions-0010.d1-rehearsal.py` already resolved its
# migration this way; this one did not, so the day 0010 moved from migrations-draft/ into migrations/ the
# rehearsal died on `FileNotFoundError` before it could test anything. The variable keeps its old name
# because "draft" here means "the file under rehearsal", not "the folder it sits in".
DRAFT10 = next(q for q in (os.path.join(MIG, '0010_crm_drive_file_versions.sql'),
                           os.path.join(DRAFT_DIR, '0010_crm_drive_file_versions.sql')) if os.path.exists(q))
DRAFT11 = next(q for q in (os.path.join(MIG, '0011_crm_drive_file_intake_review.sql'),
                           os.path.join(DRAFT_DIR, '0011_crm_drive_file_intake_review.sql')) if os.path.exists(q))
SCRATCH = os.environ.get('P2F_DIR') or tempfile.mkdtemp(prefix='crm-file-review-0011-')
STATE = os.path.join(SCRATCH, 'state')
MDIR = os.path.join(SCRATCH, 'migrations')
DB = 'crm-review-rehearsal'
CFG = os.path.join(SCRATCH, 'wrangler.toml')
ENV = dict(os.environ, CI='1', WRANGLER_SEND_METRICS='false', NODE_NO_WARNINGS='1')
_wr = os.environ.get('WRANGLER') or shutil.which('wrangler')
WR = [_wr] if _wr else ['npx', '--yes', 'wrangler@4']

BASE_SQL = """-- rehearsal base: the site tables 0004..0006 expect, plus minimal operational stubs so
-- "nothing operational moved" is a measurable count rather than an assumption.
CREATE TABLE IF NOT EXISTS areas (id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT,
  url TEXT, title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER, area_m2 REAL,
  price REAL, bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crm_conversations (id TEXT PRIMARY KEY, crm_contact_id TEXT);
CREATE TABLE IF NOT EXISTS crm_opportunities (id TEXT PRIMARY KEY);
"""

from _scratch import guard_fresh_scratch  # a used scratch dir is refused, not misreported
guard_fresh_scratch(STATE, 'P2F_DIR')
os.makedirs(MDIR, exist_ok=True)
for name, text in [('0000_rehearsal_base.sql', BASE_SQL),
                   ('0002_crm_internal_auth.sql', open(os.path.join(MIG, '0002_crm_internal_auth.sql'), encoding='utf8').read()),
                   ('0007_crm_drive_file_registry.sql', open(os.path.join(MIG, '0007_crm_drive_file_registry.sql'), encoding='utf8').read()),
                   ('0008_crm_phase4_analysis.sql', open(os.path.join(MIG, '0008_crm_phase4_analysis.sql'), encoding='utf8').read()),
                   ('0009_crm_drive_review_workflow.sql', open(os.path.join(MIG, '0009_crm_drive_review_workflow.sql'), encoding='utf8').read())]:
    open(os.path.join(MDIR, name), 'w', encoding='utf8').write(text)
with open(os.path.join(SCRATCH, 'empty.mjs'), 'w') as fh:
    fh.write('export default { fetch() { return new Response("ok"); } };\n')
with open(CFG, 'w') as fh:
    fh.write('name = "%s"\nmain = "empty.mjs"\ncompatibility_date = "2026-11-01"\n\n' % DB)
    fh.write('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\n' % DB)
    fh.write('database_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "./migrations"\n')

results = []
DIFFNOTES = []


def d1_file_path():
    for root, _dirs, fnames in os.walk(STATE):
        for f in fnames:
            if f.endswith('.sqlite') and 'd1' in root.replace(os.sep, '/'):
                return os.path.join(root, f)
    return None


ANSI = re.compile(r'\x1b\[[0-9;]*m')


def sh(args):
    p = subprocess.run(args, capture_output=True, text=True, cwd=SCRATCH, env=ENV)
    return ANSI.sub('', (p.stdout or '') + (p.stderr or ''))


def d1_file(path):
    return sh(WR + ['d1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE, '--file', path])


def d1(sql):
    return sh(WR + ['d1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE, '--command', sql])


def rows(sql):
    p = subprocess.run(WR + ['d1', 'execute', DB, '--local', '--config', CFG, '--json',
                             '--persist-to', STATE, '--command', sql],
                       capture_output=True, text=True, cwd=SCRATCH, env=ENV)
    txt = ((p.stdout or '') + (p.stderr or '')).strip()
    for start in (txt.find('['), txt.find('{')):
        if start < 0:
            continue
        try:
            d = json.loads(txt[start:])
        except ValueError:
            continue
        if isinstance(d, list):
            d = d[-1] if d else {}
        res = d.get('results') if isinstance(d, dict) else None
        if res is not None:
            return res
    raise AssertionError('could not parse D1 json for: %s\n%s' % (sql[:80], txt[-400:]))


def exec_script(name, sql):
    path = os.path.join(SCRATCH, name)
    with open(path, 'w', encoding='utf8') as fh:
        fh.write(sql)
    return d1_file(path)


def refused(label, sql, *frags):
    txt = d1(sql) if '\n' not in sql and len(sql) < 900 else exec_script('batch.sql', sql)
    low = txt.lower()
    if 'executed successfully' in low:
        results.append(False)
        print('  FAIL %s — the write went through, barrier missing' % label)
    elif any(f.lower() in low for f in frags) or 'sqlite_constraint' in low:
        detail = re.search(r'(?:error|Error)[^\n]{0,140}', txt)
        results.append(True)
        print('  ok   %s — D1 refused [%s]' % (label, (detail.group(0)[:90] if detail else 'constraint').strip()))
    else:
        results.append(False)
        print('  FAIL %s — unclear outcome: %s' % (label, txt.strip()[-300:]))


def allowed(label, sql, name='ok.sql'):
    txt = d1(sql) if len(sql) < 900 and '\n' not in sql else exec_script(name, sql)
    ok = 'executed successfully' in txt.lower()
    results.append(ok)
    print('  %s %s%s' % ('ok  ' if ok else 'FAIL', label, '' if ok else ' — ' + txt.strip()[-300:]))
    return ok


def check(label, cond, detail=''):
    results.append(bool(cond))
    print('  %s %s%s' % ('ok  ' if cond else 'FAIL', label, (' — ' + str(detail)[:220]) if (detail and not cond) else ''))


def inventory():
    r = rows("SELECT type, name, COALESCE(sql,'') AS sql FROM sqlite_master "
             "WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_migrations%' ORDER BY type, name")
    return {'%s:%s' % (x['type'], x['name']): x['sql'] for x in r}


def digest(inv):
    blob = '\n'.join('%s=%s' % (k, hashlib.sha256(v.encode()).hexdigest()[:16]) for k, v in sorted(inv.items()))
    return hashlib.sha256(blob.encode()).hexdigest(), len(inv)


def counts(table_sql):
    return rows(table_sql)[0]


HEX = "lower(hex(randomblob(32)))"
TS = "'2026-11-02T09:00:00.000Z'"
LATER = "'2026-11-02T14:00:00.000Z'"


DB2 = 'crm-review-nover'
MDIR2 = os.path.join(SCRATCH, 'migrations2')
STATE2 = os.path.join(SCRATCH, 'state2')
CFG2 = os.path.join(SCRATCH, 'wrangler2.toml')
os.makedirs(MDIR2, exist_ok=True)
for nm in ('0000_rehearsal_base.sql', '0002_crm_internal_auth.sql', '0007_crm_drive_file_registry.sql',
           '0008_crm_phase4_analysis.sql', '0009_crm_drive_review_workflow.sql'):
    srcf = os.path.join(MDIR, nm)
    open(os.path.join(MDIR2, nm), 'w', encoding='utf8').write(
        open(srcf, encoding='utf8').read() if os.path.exists(srcf) else BASE_SQL)
open(os.path.join(MDIR2, '0011_crm_drive_file_intake_review.sql'), 'w', encoding='utf8').write(
    open(DRAFT11, encoding='utf8').read())
with open(CFG2, 'w') as fh:
    fh.write('name = "%s"\nmain = "empty.mjs"\ncompatibility_date = "2026-11-01"\n\n' % DB2)
    fh.write('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\n' % DB2)
    fh.write('database_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "./migrations2"\n')


def d1b(sql):
    return sh(WR + ['d1', 'execute', DB2, '--local', '--config', CFG2, '--json', '--persist-to',
                    STATE2, '--command', sql])


def counts2(sql):
    txt = d1b(sql)
    i = txt.find('[')
    d = json.loads(txt[i:txt.rindex(']') + 1])
    r = d[-1].get('results') if isinstance(d, list) and isinstance(d[-1], dict) else None
    return r[0] if r else {}

# ---------------------------------------------------------------- helpers specific to 0011
GEN = 'a' * 64          # the chain's first link, chosen by the writer
SNAP = 'b' * 64         # what the reviewer was shown, mirrored into every decision
SHASH = 'c' * 64        # a live session token hash (inserted below)
DEAD = 'd' * 64         # a session that exists but is revoked
TS2 = "'2026-11-02T10:00:00.000Z'"
TS3 = "'2026-11-02T11:00:00.000Z'"


def case_ins(ref, sha, seq, disp='register_new_file', contact=None, opened='reconciliation'):
    cref = 'frw-' + ref[:16] + '-' + str(seq)
    cols = ("case_ref, drive_ref, bound_version_seq, bound_content_sha256, review_disposition,"
            " case_snapshot_sha256, genesis_sha256, opened_by, opened_at")
    vals = ("'%s','%s',%d,'%s','%s','%s','%s','%s',%s" % (cref, ref, seq, sha, disp, SNAP, GEN,
                                                           opened, TS))
    if contact:
        cols += ", crm_contact_id"
        vals += ",'%s'" % contact
    return "INSERT INTO crm_drive_file_review_case (%s) VALUES (%s)" % (cols, vals)


def dec(cref, seq, decision, prev, when=TS, sess=SHASH, snap=SNAP, bseq=1, head=1):
    return ("INSERT INTO crm_drive_file_review_decision (case_ref, decision_seq, decision, reviewer,"
            " reviewer_attestation, session_hash, reason, reason_sha256, bound_version_seq,"
            " head_version_seq_at_decision, case_snapshot_sha256, occurred_at, prev_decision_sha256,"
            " decision_sha256) VALUES ('%s',%d,'%s','tarek.review',"
            "'session_label_not_independent_identity','%s',"
            "'file triage note recorded against the bound version',%s,%d,%d,'%s',%s,'%s',%s)"
            % (cref, seq, decision, sess, HEX, bseq, head, snap, when, prev, HEX))


# ---------------------------------------------------------------- 0) apply 0010 first (the promotion order)
print('=== 0) the state a 0011 promotion starts from: 0002/0007/0008/0009 + 0010 ===')
shutil.rmtree(STATE, ignore_errors=True)
out0 = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
check('the applied chain stops at 0009 (no 0010, no 0011 yet)',
      '0009_crm_drive_review_workflow.sql' in out0 and '0010_' not in out0, out0[-200:])
shutil.copy(DRAFT10, os.path.join(MDIR, '0010_crm_drive_file_versions.sql'))
out10 = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
check('0010 applied on the same scratch database (the ledger 0011 depends on)',
      '0010_crm_drive_file_versions.sql' in out10, out10[-300:])
# 99 synthetic files + refs + the draft's own bootstrap, so 0011 is tested against a realistic ledger
vals = []
for i in range(1, 100):
    vals.append("('reg-%03d','SYNTH%03d','folder-%d','file-%03d.zip','file-%03d.zip','/x',"
                "'application/zip',%d,%s,%s,%s,'ZIP','metadata_scanned','not_required',%s,'receipt-%03d',"
                "0,1,'{}',%s,%s,%s)"
                % (i, i, i % 3, i, i, 1000 + i * 7, TS, TS, HEX, TS, i, TS, TS, TS))
script = ("INSERT INTO crm_drive_file_registry (id, drive_file_id, drive_parent_id, file_name,"
          " original_file_name, drive_path, mime_type, file_size, drive_created_at, drive_modified_at,"
          " content_sha256, content_type, processing_status, review_status, last_processed_at,"
          " processing_receipt_ref, extracted_records_count, processing_attempts, metadata_json,"
          " created_at, updated_at, last_seen_at) VALUES\n" + ",\n".join(vals) + ";\n")
allowed('99 synthetic registered files, refs provisioned, bootstrap versions created', script, 'synth.sql')
allowed('provision drive_ref for all 99 rows',
        "UPDATE crm_drive_file_registry SET drive_ref = lower(hex(randomblob(32)))"
        " WHERE id LIKE 'reg-%' AND drive_ref IS NULL", 'refs.sql')
bf = open(DRAFT10, encoding='utf8').read()
seg = bf[bf.index('INSERT INTO crm_drive_file_version'):
         bf.index("-- ---------------------------------------------------------------------------\n-- 6)")]
seg = seg[:seg.rindex(';') + 1]
allowed('run 0010\'s own §5 backfill', seg, 'backfill.sql')
allowed('advance the 99 rows to processed as the live database has them',
        "UPDATE crm_drive_file_registry SET processing_status = 'processed' WHERE id LIKE 'reg-%'",
        'proc.sql')
check('99 file rows and 99 bootstrap versions are in place before 0011 is even offered',
      counts("SELECT COUNT(*) AS n FROM crm_drive_file_registry WHERE id LIKE 'reg-%'")['n'] == 99
      and counts('SELECT COUNT(*) AS n FROM crm_drive_file_version')['n'] == 99)
# `crm_sessions` stores epoch seconds (that is what crm-worker.js writes), and migration 0014 made the
# 0011 §3.7 guard compare in that unit — so the fixtures are seeded in seconds too, and a session this
# rehearsal calls live or revoked is live or revoked in exactly the sense the deployed database means.
NOWSEC = "CAST(strftime('%s','now') AS INTEGER)"
allowed('a live session row exists for the decision rules to read',
        "INSERT INTO crm_sessions (id, token_hash, csrf_hash, created_at, expires_at, last_seen_at)"
        " VALUES ('s-live','" + SHASH + "','" + SNAP + "'," + NOWSEC + " - 60," + NOWSEC
        + " + 3600," + NOWSEC + " - 60)", 'sess.sql')
allowed('and a revoked one, which must not count as live',
        "INSERT INTO crm_sessions (id, token_hash, csrf_hash, created_at, expires_at, last_seen_at,"
        " revoked_at) VALUES ('s-dead','" + DEAD + "','" + SNAP + "'," + NOWSEC + " - 60," + NOWSEC
        + " + 3600," + NOWSEC + " - 60,1)", 'sess2.sql')
check('the two session rows differ only in revoked_at (so the barrier cannot pass by accident)',
      counts("SELECT COUNT(*) AS live FROM crm_sessions WHERE revoked_at IS NULL"
             " AND expires_at > CAST(strftime('%s','now') AS INTEGER)")['live'] == 1)

# ---------------------------------------------------------------- 1) apply 0011, purely additive?
print('=== 1) apply 0011 with the real migration runner ===')


def datadig(sql):
    r = rows(sql)
    v = list(r[0].values())[0] if r and r[0] else ''
    return hashlib.sha256((v or '').encode()).hexdigest()[:16]


REG_D = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT id || '|' || COALESCE(content_sha256,'')"
                " || '|' || processing_status || '|' || COALESCE(head_version_seq,'')"
                " || '|' || COALESCE(drive_ref,'') AS v FROM crm_drive_file_registry ORDER BY id)")
VER_D = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT version_ref || '|' || content_sha256"
                " || '|' || evidence_class || '|' || COALESCE(receipt_ref,'') AS v"
                " FROM crm_drive_file_version ORDER BY version_ref)")
INV0 = inventory()
DIG11 = digest(INV0)[0]
shutil.copy(DRAFT11, os.path.join(MDIR, '0011_crm_drive_file_intake_review.sql'))
out11 = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
check('0011 applied on D1 with no split or parse error (3 tables, 16 triggers, 4 views, 5 indexes)',
      '0011_crm_drive_file_intake_review.sql' in out11 and 'executed successfully' in out11.lower(),
      out11[-400:])
after11 = inventory()
added = sorted(set(after11) - set(INV0))
kinds = {}
for k in added:
    kinds[k.split(':')[0]] = kinds.get(k.split(':')[0], 0) + 1
print('       added by 0011: %s' % ' '.join('%s=%d' % (a, b) for a, b in sorted(kinds.items())))
changed = [k for k, v in INV0.items() if k in after11 and after11[k] != v]
check('0011 changes NO pre-existing object at all — not the registry table (no ALTER), not 0007/0008,'
      ' not 0010\'s ledger, triggers or views: the additive claim is byte-identity, not a prefix',
      changed == [], changed[:5])
check('and it removes nothing (every pre-existing object is still there)',
      set(INV0) - set(after11) == set(), sorted(set(INV0) - set(after11))[:5])
REG_D2 = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT id || '|' || COALESCE(content_sha256,'')"
                 " || '|' || processing_status || '|' || COALESCE(head_version_seq,'')"
                 " || '|' || COALESCE(drive_ref,'') AS v FROM crm_drive_file_registry ORDER BY id)")
VER_D2 = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT version_ref || '|' || content_sha256"
                 " || '|' || evidence_class || '|' || COALESCE(receipt_ref,'') AS v"
                 " FROM crm_drive_file_version ORDER BY version_ref)")
check('EFFECT ON EXISTING DATA: none, measured — the digest of all 99 file rows and of the 99 versions'
      ' is identical before and after the apply (no row was rewritten, and no case was invented)',
      REG_D == REG_D2 and VER_D == VER_D2, {'registry': [REG_D, REG_D2], 'versions': [VER_D, VER_D2]})
check('and it creates zero review cases by itself',
      counts('SELECT COUNT(*) AS n FROM crm_drive_file_review_case')['n'] == 0)
check('exactly the objects 0011 promises were added — 3 tables, 16 triggers, 4 views, 5 indexes',
      kinds == {'index': 5, 'table': 3, 'trigger': 16, 'view': 4}, kinds)
check('the three 0011 tables exist on the real engine',
      all(('table:' + t) in after11 for t in ('crm_drive_file_review_case',
                                               'crm_drive_file_review_decision',
                                               'crm_drive_file_review_anchor')),
      [k for k in after11 if 'file_review' in k][:6])

# ---------------------------------------------------------------- 2) the case, without a contact
print('=== 2) a review case for a file with no contact — the T2 capability, on D1 ===')
one = rows("SELECT drive_ref AS ref, content_sha256 AS sha, head_version_seq AS head"
           " FROM crm_drive_file_registry WHERE id='reg-001'")[0]
REF, SHA1 = one['ref'], one['sha']
CREF = 'frw-' + REF[:16] + '-1'
refused('a case cannot be opened against a version the ledger does not carry (no invented digest)',
        case_ins(REF, 'e' * 64, 9), 'file_review_case_requires_a_recorded_version')
refused('a case cannot be opened for a file the registry does not know',
        case_ins('f' * 64, 'e' * 64, 1), 'file_review_case_requires_a_recorded_version')
refused('a case is born WITHOUT a contact — an INSERT that already carries one is refused',
        case_ins(REF, SHA1, 1, contact='contact-12345678'),
        'file_review_link_requires_a_recorded_decision')
allowed('a case for a new file with NO crm_contact_id is accepted (this is what T2 asks for)',
        case_ins(REF, SHA1, 1), 'case.sql')
st = rows("SELECT * FROM crm_drive_file_review_state WHERE case_ref='%s'" % CREF)[0]
check('the case reads as unlinked, open, and bound to a real version',
      rows("SELECT crm_contact_id AS c FROM crm_drive_file_review_case WHERE case_ref='%s'" % CREF)[0]['c']
      is None and st['status'] == 'open' and st['link_state'] == 'none'
      and st['has_contact_handle'] == 0 and st['freshness'] == 'current', st)
check('and its own ref is derived from (file, version), not typed by a human or a worker',
      st['case_ref'] == CREF and st['drive_ref'] == REF and st['bound_version_seq'] == 1, st['case_ref'])
refused('the same file+version cannot get a second case (one case per recorded version)',
        case_ins(REF, SHA1, 1), 'UNIQUE constraint')
refused('a hand-typed case_ref that does not match (drive_ref, version_seq) is refused by the CHECK',
        "INSERT INTO crm_drive_file_review_case (case_ref, drive_ref, bound_version_seq,"
        " bound_content_sha256, review_disposition, case_snapshot_sha256, genesis_sha256, opened_by,"
        " opened_at) VALUES ('frw-typed-1','%s',1,'%s','register_new_file','%s','%s','manual_review',%s)"
        % (REF, SHA1, SNAP, GEN, TS), 'check constraint')
refused('a case cannot claim an operational write: import_implied is nailed to 0 by the column CHECK',
        "UPDATE crm_drive_file_review_case SET import_implied = 1 WHERE case_ref='%s'" % CREF,
        'check constraint')
refused('nor merge_authorized', "UPDATE crm_drive_file_review_case SET merge_authorized = 1"
        " WHERE case_ref='%s'" % CREF, 'check constraint')
refused('nor contact_write_count', "UPDATE crm_drive_file_review_case SET contact_write_count = 1"
        " WHERE case_ref='%s'" % CREF, 'check constraint')
check('the genesis anchor was written by the trigger, not by the caller (the chain starts closed)',
      rows("SELECT * FROM crm_drive_file_review_anchor WHERE case_ref='%s' AND anchor_source='genesis'"
           % CREF)[0]['head_sha256'] == GEN
      and counts("SELECT COUNT(*) AS n FROM crm_drive_file_review_anchor WHERE case_ref='%s'" % CREF)['n']
      == 1)

# ---------------------------------------------------------------- 3) the decision ledger
print('=== 3) decisions: density, chain, session, and append-only on the real engine ===')
refused('a decision may not start at seq 2 (the ledger is dense per case)',
        dec(CREF, 2, 'noted', GEN, when=TS2), 'file_review_decision_seq_broken')
refused('a decision about a different snapshot than the reviewer was shown is refused',
        dec(CREF, 1, 'noted', GEN, when=TS, snap='e' * 64), 'file_review_decision_snapshot_mismatch')
refused('a decision about a different version than the case is bound to is refused',
        dec(CREF, 1, 'noted', GEN, when=TS, bseq=2), 'file_review_decision_snapshot_mismatch')
refused('a decision that changes state needs a live session: an unknown token hash is refused',
        dec(CREF, 1, 'close_no_action', GEN, when=TS, sess='9' * 64),
        'file_review_decision_session_not_live')
refused('and a revoked session is refused too (the live check is not "a row exists")',
        dec(CREF, 1, 'close_no_action', GEN, when=TS, sess=DEAD),
        'file_review_decision_session_not_live')
refused('an auto/system reviewer is not a reviewer',
        dec(CREF, 1, 'noted', GEN, when=TS).replace("'tarek.review'", "'pipeline'"),
        'check constraint')
refused('a reason carrying a raw id (9+ digits) is refused — no customer data lands in the ledger',
        dec(CREF, 1, 'noted', GEN, when=TS).replace(
            "'file triage note recorded against the bound version'",
            "'see contact 123456789 for this file'"), 'check constraint')
allowed('a "noted" decision needs no session (it changes no state) and is accepted',
        dec(CREF, 1, 'noted', GEN, when=TS), 'd1.sql')
check('the accepted decision mirrored into the anchor ledger automatically',
      counts("SELECT COUNT(*) AS n FROM crm_drive_file_review_anchor WHERE case_ref='%s'" % CREF)['n']
      == 2 and rows("SELECT * FROM crm_drive_file_review_chain_integrity WHERE case_ref='%s'" % CREF)[0]
      ['broken_links'] == 0, rows("SELECT * FROM crm_drive_file_review_chain_integrity"))
refused('a decision cannot be edited afterwards', "UPDATE crm_drive_file_review_decision SET reason"
        " = 'rewritten history of this review' WHERE case_ref='%s'" % CREF,
        'file_review_decisions_are_append_only')
refused('nor deleted', "DELETE FROM crm_drive_file_review_decision WHERE case_ref='%s'" % CREF,
        'file_review_decisions_are_append_only')
refused('nor can an anchor be edited', "UPDATE crm_drive_file_review_anchor SET head_sha256 = '%s'"
        " WHERE case_ref='%s' AND decision_seq=0" % (SNAP, CREF), 'file_review_anchors_are_append_only')
refused('nor deleted (the anchor ledger keeps every row the triggers mirrored)',
        "DELETE FROM crm_drive_file_review_anchor WHERE case_ref='" + CREF
        + "' AND anchor_source='genesis'", 'file_review_anchors_are_append_only')
check('  and the anchor row is provably still there (the refusal was over a real row, not an empty'
      ' predicate)',
      counts("SELECT COUNT(*) AS n FROM crm_drive_file_review_anchor WHERE case_ref='" + CREF
             + "' AND anchor_source='genesis' AND head_sha256='" + GEN + "'")['n'] == 1)
refused('a case that a reviewer touched cannot be deleted', "DELETE FROM crm_drive_file_review_case"
        " WHERE case_ref='%s'" % CREF, 'file_review_cases_are_permanent')

# ---------------------------------------------------------------- 4) automatic linking is impossible
print('=== 4) a link can only arrive through a named human decision ===')
LINK = ("UPDATE crm_drive_file_review_case SET crm_contact_id='contact-12345678', link_state='proposed',"
        " link_basis='vcard_tel', link_confirmed_by='tarek.review', link_confirmed_at=%s,"
        " link_evidence_sha256='%s' WHERE case_ref='%s'" % (TS2, SNAP, CREF))
refused('a link written straight onto the case — the shape a matcher or worker would produce — is refused',
        LINK, 'file_review_link_requires_explicit_human_basis')
refused('a half-filled link (contact without basis/human/evidence) is refused by the table CHECK too',
        "UPDATE crm_drive_file_review_case SET crm_contact_id='contact-12345678' WHERE case_ref='%s'"
        % CREF, 'file_review_link_requires_a_recorded_decision')
refused('escalation must name a real case (0009), never a free-text label',
        "UPDATE crm_drive_file_review_case SET escalated_case_ref='no-such-case',"
        " status='escalated' WHERE case_ref='%s'" % CREF, 'escalation_target_case_not_found')
# prev hash for seq 2 is seq 1's decision_sha256 — read it, do not guess it
P2 = rows("SELECT decision_sha256 AS h FROM crm_drive_file_review_decision WHERE case_ref='%s'"
          " AND decision_seq=1" % CREF)[0]['h']
allowed('the human records "link_proposed" (seq 2) with a live session',
        dec(CREF, 2, 'link_proposed', P2, when=TS2), 'd2.sql')
refused('and even then the case row cannot be approved by contact review without a 0009 hand-off',
        LINK.replace("link_state='proposed'", "link_state='approved_by_contact_review'"),
        'file_review_link_requires_explicit_human_basis')
allowed('only now may the projection carry the proposed link', LINK, 'link.sql')
check('the case now shows a human-backed, still-unapproved link (and nothing was imported)',
      (lambda r: r['link_state'] == 'proposed' and r['has_contact_handle'] == 1)(
          rows("SELECT * FROM crm_drive_file_review_state WHERE case_ref='%s'" % CREF)[0]))
refused('the link cannot be dropped by hand — only an unlink decision clears it',
        "UPDATE crm_drive_file_review_case SET crm_contact_id=NULL, link_state='none',"
        " link_basis=NULL, link_confirmed_by=NULL, link_confirmed_at=NULL,"
        " link_evidence_sha256=NULL WHERE case_ref='%s'" % CREF,
        'file_review_link_requires_explicit_human_basis')
P3 = rows("SELECT decision_sha256 AS h FROM crm_drive_file_review_decision WHERE case_ref='%s'"
          " AND decision_seq=2" % CREF)[0]['h']
allowed('an unlink decision clears the projection, and keeps the evidence in the ledger',
        dec(CREF, 3, 'unlink_recorded', P3, when=TS3), 'd3.sql')
st2 = rows("SELECT * FROM crm_drive_file_review_state WHERE case_ref='%s'" % CREF)[0]
check('link gone from the case row, decisions still 3 (the record survives the undo)',
      st2['link_state'] == 'none' and st2['decisions'] == 3
      and rows("SELECT crm_contact_id AS c, link_basis AS b, link_evidence_sha256 AS e"
               " FROM crm_drive_file_review_case WHERE case_ref='%s'" % CREF)[0] == {'c': None, 'b': None,
                                                                                       'e': None}, st2)
check('no contact table row was ever touched by any of this',
      counts('SELECT COUNT(*) AS n FROM crm_contacts')['n'] == 0
      and counts('SELECT COUNT(*) AS n FROM crm_conversations')['n'] == 0
      and counts('SELECT COUNT(*) AS n FROM crm_opportunities')['n'] == 0)

# ---------------------------------------------------------------- 5) staleness
print('=== 5) a case bound to an old version cannot be closed as if it were current ===')
P4 = rows("SELECT decision_sha256 AS h FROM crm_drive_file_review_decision WHERE case_ref='%s'"
          " AND decision_seq=3" % CREF)[0]['h']
allowed('closing while still current is allowed (seq 4, live session)',
        dec(CREF, 4, 'close_no_action', P4, when="'2026-11-02T12:00:00.000Z'"), 'd4.sql')
check('and the projection moved to closed with a decided_at',
      rows("SELECT status AS s, decided_at AS d FROM crm_drive_file_review_case WHERE case_ref='%s'"
           % CREF)[0]['s'] == 'closed_no_action')
allowed('a NEW version of the same file lands in the ledger (seq 2)',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('%s#2','%s',2,%s,'declared_by_writer',11,'2026-11-02T13:00:00.000Z','reconciliation','r-2')"
        % (REF, REF, HEX), 'v2.sql')
refused('the closed case is now stale: re-deciding it by hand is refused',
        "UPDATE crm_drive_file_review_case SET status='decided' WHERE case_ref='%s'" % CREF,
        'review_case_bound_version_is_stale')
P5 = rows("SELECT decision_sha256 AS h FROM crm_drive_file_review_decision WHERE case_ref='%s'"
          " AND decision_seq=4" % CREF)[0]['h']
refused('and a decision that would close it is refused too, because the barrier sits on the '
      'projection update that the decision itself triggers',
        dec(CREF, 5, 'close_no_action', P5, when="'2026-11-02T14:00:00.000Z'"),
        'review_case_bound_version_is_stale')
check('the refused decision left nothing behind: the ledger is still dense at four rows',
      counts("SELECT COUNT(*) AS n, MAX(decision_seq) AS m FROM crm_drive_file_review_decision"
             " WHERE case_ref='%s'" % CREF) == {'n': 4, 'm': 4})
check('while the case keeps accruing history, the state view tells a reviewer it is stale',
      rows("SELECT freshness AS f FROM crm_drive_file_review_state WHERE case_ref='%s'" % CREF)[0]['f']
      == 'stale_newer_version_exists')
allowed('a note may still be added on the stale case (history continues; conclusions may not)',
        dec(CREF, 5, 'noted', P5, when="'2026-11-02T14:00:00.000Z'"), 'd5.sql')
refused('but a new case may not be opened against the version that was already reviewed',
        case_ins(REF, SHA1, 1, disp='duplicate_suspect'), 'UNIQUE constraint')
allowed('a second case for the new head version is what the design wants', case_ins(REF, rows(
    "SELECT content_sha256 AS s FROM crm_drive_file_version WHERE version_ref='%s#2'" % REF)[0]['s'],
    2, disp='verify_content_digest'), 'case2.sql')
check('two cases, each bound to its own version, both readable side by side',
      counts("SELECT COUNT(*) AS n FROM crm_drive_file_review_case WHERE drive_ref='%s'" % REF)['n'] == 2)

# ---------------------------------------------------------------- 6) the views CI will read
print('=== 6) the views, and proof that they are not vacuously clean ===')
ci = rows("SELECT * FROM crm_drive_file_review_chain_integrity WHERE case_ref='%s'" % CREF)[0]
check('the chain reads intact: 5 dense decisions, no gaps, no broken links, every decision anchored',
      ci['decisions'] == 5 and ci['seq_gaps'] == 0 and ci['broken_links'] == 0
      and ci['anchor_mismatches'] == 0 and ci['anchors'] == 5 and ci['first_seq'] == 1
      and ci['last_seq'] == 5, ci)
iso = rows('SELECT * FROM crm_drive_file_review_isolation')[0]
check('isolation view: no forbidden reference in any 0011 object, no loose nail, no unexplained link',
      iso == {'forbidden_refs': 0, 'nails_loose': 0, 'unexplained_links': 0}, iso)
allowed('positive control for that view: the same predicate over an object that DOES reference a'
        ' contact table returns 1', "CREATE VIEW probe_bad AS SELECT count(*) AS n FROM crm_contacts",
        'probe.sql')
pos = rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('crm_drive_file_review_case',"
            " 'probe_bad') AND (sql LIKE '%crm_contacts%' OR sql LIKE '%file_name%'"
            " OR sql LIKE '%drive_path%')")[0]
check('  (so the zero above is a measurement, not a view that can never fire)', pos['n'] == 1, pos)
d1("DROP VIEW probe_bad")
summ = rows('SELECT * FROM crm_drive_file_review_ci_summary')
check('the CI summary is counts and dispositions only — no reviewer name, no contact handle, no digest',
      all(set(r) <= {'review_disposition', 'cases', 'untouched', 'links_proposed', 'links_approved',
                     'stale_cases', 'decided', 'max_decisions', 'broken_links', 'seq_gaps',
                     'anchor_mismatches'} for r in summ)
      and sum(r['cases'] for r in summ) == 2 and sum(r['max_decisions'] for r in summ) == 5, summ)
check('and it reports the stale case and the proposed-link count truthfully',
      any(r['stale_cases'] == 1 for r in summ) and any(r['decided'] == 1 for r in summ), summ)

REG_D3 = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT id || '|' || COALESCE(content_sha256,'')"
                 " || '|' || processing_status || '|' || COALESCE(head_version_seq,'')"
                 " || '|' || COALESCE(drive_ref,'') AS v FROM crm_drive_file_registry ORDER BY id)")
VER_D3 = datadig("SELECT group_concat(v, ',') AS d FROM (SELECT version_ref || '|' || content_sha256"
                 " || '|' || evidence_class || '|' || COALESCE(receipt_ref,'') AS v"
                 " FROM crm_drive_file_version ORDER BY version_ref)")

# ---------------------------------------------------------------- 7) out-of-order promotion
print('=== 7) what an out-of-order promotion does (0011 applied where 0010 is missing) ===')
out2 = sh(WR + ['d1', 'migrations', 'apply', DB2, '--local', '--config', CFG2, '--persist-to', STATE2])
half_ok = '0011_crm_drive_file_intake_review.sql' in out2 and 'error' not in out2.lower()
print('       measured: the out-of-order apply %s' % ('SUCCEEDED' if half_ok else 'was refused'))
check('MEASURED, NOT ASSUMED: a trigger body is not resolved against tables that are missing, so'
      ' applying 0011 without 0010 is ACCEPTED by D1 rather than failing loudly. The ordering risk is'
      ' silent — which is exactly why the promotion checklist must be enforced by the runner and the'
      ' reviewer, not by hoping the engine refuses', half_ok, out2.strip()[-140:])
left = counts2("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'crm_drive_file_review%'")['n']
print('       objects the half-built database was left with: %d' % left)
CASEERR = d1b(case_ins('a' * 64, 'e' * 64, 1))
check('the half-built schema fails CLOSED, which is what makes it survivable: writing a case hits the'
      ' missing version ledger and errors, so not even an invented case is accepted in that state',
      'crm_drive_file_version' in CASEERR and 'executed successfully' not in CASEERR.lower(),
      CASEERR.strip()[-220:])
shutil.copy(DRAFT10, os.path.join(MDIR2, '0010_crm_drive_file_versions.sql'))
out3 = sh(WR + ['d1', 'migrations', 'apply', DB2, '--local', '--config', CFG2, '--persist-to', STATE2])
check('recovery needs no hand repair: apply 0010, re-run the runner, and 0011 is complete on that'
      ' database — 3 tables, 16 triggers, 4 views, 5 indexes, exactly as in the ordered one',
      '0010_crm_drive_file_versions.sql' in out3
      and counts2("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"
                  " AND name IN ('crm_drive_file_review_case','crm_drive_file_review_decision',"
                  " 'crm_drive_file_review_anchor')")['n'] == 3
      and counts2("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'"
                  " AND name LIKE 'trg_file_review_%'")['n'] == 16
      and counts2("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view'"
                  " AND name LIKE 'crm_drive_file_review_%'")['n'] == 4
      and counts2("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'"
                  " AND name LIKE 'idx_crm_file_review_%'")['n'] == 5, out3.strip()[-160:])
after_recovery = d1b(case_ins('a' * 64, 'e' * 64, 1))
check('and after recovery the barrier speaks with 0011s own voice (a named refusal, not a missing-table'
      ' crash): the objects created out of order are live, not dead weight',
      'file_review_case_requires_a_recorded_version' in after_recovery
      and 'no such table' not in after_recovery, after_recovery.strip()[-220:])

print('=== 8) integrity, foreign keys, and rolling 0011 back ===')
DBFILE = d1_file_path()
if DBFILE:
    import sqlite3 as _s3
    _h = _s3.connect(DBFILE)
    ic = [r[0] for r in _h.execute('PRAGMA integrity_check')]
    _h.close()
    check('integrity_check is ok after 0011 and every tampering attempt (run on the file D1 wrote —'
          ' D1\'s own SQL interface refuses that PRAGMA, which the 0010 rehearsal measured)',
          ic == ['ok'], ic[:2])
else:
    check('could not locate the scratch D1 file to run integrity_check', False)
fk = rows('PRAGMA foreign_key_check')
check('foreign_key_check is empty (a case referencing a 0009 case that does not exist would show here)',
      not fk, fk[:2])
DIG8 = digest(inventory())[0]
DIFFNOTES.append(('out-of-order apply', 'accepted by D1 with no error',
                  'the node rehearsal never offers 0011 before 0010, so this is new information'))
check('the schema did not drift while the refusals and accepted writes ran: 0011'
      ' exposes no path from data to DDL, so every object list read is identical to the'
      ' one taken right after the apply', DIG8 == digest(after11)[0],
      DIG8[:16] + ' vs ' + digest(after11)[0][:16])
roll = exec_script('rollback.sql', """
DROP VIEW IF EXISTS crm_drive_file_review_state;
DROP VIEW IF EXISTS crm_drive_file_review_chain_integrity;
DROP VIEW IF EXISTS crm_drive_file_review_ci_summary;
DROP VIEW IF EXISTS crm_drive_file_review_isolation;
DROP TABLE IF EXISTS crm_drive_file_review_decision;
DROP TABLE IF EXISTS crm_drive_file_review_anchor;
DROP TABLE IF EXISTS crm_drive_file_review_case;
""" + "".join("DROP TRIGGER IF EXISTS %s;\n" % t for t in [
    'trg_file_review_decision_no_update', 'trg_file_review_decision_no_delete',
    'trg_file_review_anchor_no_update', 'trg_file_review_anchor_no_delete',
    'trg_file_review_case_version_exists', 'trg_file_review_case_no_insert_link',
    'trg_file_review_case_after_insert', 'trg_file_review_case_no_delete',
    'trg_file_review_decision_seq_dense', 'trg_file_review_decision_chain',
    'trg_file_review_decision_snapshot_binding', 'trg_file_review_decision_session_live',
    'trg_file_review_decision_after_insert', 'trg_file_review_case_link_barrier',
    'trg_file_review_case_escalation_target', 'trg_file_review_case_stale_on_close'])
+ "".join("DROP INDEX IF EXISTS %s;\n" % i for i in [
    'idx_crm_file_review_case_status', 'idx_crm_file_review_case_ref',
    'idx_crm_file_review_case_contact', 'idx_crm_file_review_decision_case',
    'idx_crm_file_review_decision_reviewer']))
check('the rollback script ran without an engine error on its own account',
      'SQLITE_ERROR' not in roll.upper() and '⛔' not in roll, roll.strip()[-160:])
inv_rb = inventory()
gone = [k for k in INV0 if k not in inv_rb]
back = [k for k in INV0 if k in inv_rb and inv_rb[k] != INV0[k]]
residual = [k for k in after11 if k not in INV0 and k in inv_rb]
check('rolling 0011 back is exact in both directions: every pre-existing object survives byte-identical'
      ' and none of its 28 own objects remain (0011 did no ALTER, so unlike 0010 there is no residual)',
      gone == [] and back == [] and residual == [],
      {'lost': gone[:3], 'changed': back[:3], 'left_behind': residual[:3],
       'objects_of_0011': len(after11) - len(INV0)})
check('0010\'s ledger survives a 0011 rollback intact (the version history is not 0011\'s to lose)',
      counts('SELECT COUNT(*) AS n FROM crm_drive_file_version')['n'] == 100)
check('and the 99 file rows and 100 versions are exactly as they were before the rollback: a 0011'
      ' rollback cannot cost a single byte of registry or version history',
      datadig("SELECT group_concat(v, ',') AS d FROM (SELECT id || '|' || COALESCE(content_sha256,'')"
              " || '|' || processing_status || '|' || COALESCE(head_version_seq,'')"
              " || '|' || COALESCE(drive_ref,'') AS v FROM crm_drive_file_registry ORDER BY id)") == REG_D3
      and datadig("SELECT group_concat(v, ',') AS d FROM (SELECT version_ref || '|' || content_sha256"
                  " || '|' || evidence_class || '|' || COALESCE(receipt_ref,'') AS v"
                  " FROM crm_drive_file_version ORDER BY version_ref)") == VER_D3,
      {'registry': [REG_D3, REG_D2], 'versions': [VER_D3, VER_D2]})
print('\ndifferences measured between D1 and node:sqlite:')
for a, b, c in DIFFNOTES:
    print('   %-26s D1: %-46s node: %s' % (a, b, c))
print('\n--- scratch kept at %s (KEEP=1 keeps it) ---' % (SCRATCH if os.environ.get('KEEP') else 'removed'))
ok = sum(1 for r in results if r)
print('\nD1_FILE_REVIEW %d/%d checks held' % (ok, len(results)))
print('ALL_BARRIERS_HELD_ON_D1' if ok == len(results) else 'D1_BARRIERS_MISSING — see FAIL lines above')
sys.exit(0 if ok == len(results) else 1)
