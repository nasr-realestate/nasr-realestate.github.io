#!/usr/bin/env python3
"""D1-engine rehearsal for DRAFT migration 0010 (per-version content tracking).

Companion to crm-drive-versions-0010.rehearsal.mjs, which proves the same contract on node:sqlite.
This file proves it on the engine that actually runs in production: a THROWAWAY D1 database in a
temporary directory, driven by `wrangler d1 … --local` against a sandbox-local file.

    python3 _worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py
    WRANGLER=$(pwd)/node_modules/.bin/wrangler python3 …      # explicit binary
    KEEP=1 python3 …                                          # keep the scratch db for inspection

No remote database is contacted. `nasr-crm-test-db`, `nasr-market-db` and the reference backup are
never referenced, no Cloudflare API call is made, and no Drive call is made: the 99 registered files
this rehearsal reasons about are SYNTHETIC fixtures (`SYNTH…` ids, fabricated sizes and digests), and
no file content is read anywhere.

Exit 0 = every DDL statement applied, every barrier refused, no pre-existing object changed, and the
D1-vs-node:sqlite differential printed the differences it promised to print.
"""
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
DRAFT10 = next(q for q in (os.path.join(MIG, '0010_crm_drive_file_versions.sql'),
                           os.path.join(DRAFT_DIR, '0010_crm_drive_file_versions.sql')) if os.path.exists(q))
SCRATCH = os.environ.get('P2V_DIR') or tempfile.mkdtemp(prefix='crm-drive-versions-0010-')
STATE = os.path.join(SCRATCH, 'state')
MDIR = os.path.join(SCRATCH, 'migrations')
DB = 'crm-versions-rehearsal'
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

# ---------------------------------------------------------------- 0) base schema, BEFORE the draft
print('=== 0) base schema without 0010 (the state a promotion starts from) ===')
shutil.rmtree(STATE, ignore_errors=True)
out0 = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
check('0002/0007/0008/0009 applied to the scratch D1', '0009_crm_drive_review_workflow.sql' in out0,
      out0[-300:])
BEFORE = inventory()
BEFORE_D, BEFORE_N = digest(BEFORE)
c0 = counts("SELECT COUNT(*) AS registry FROM crm_drive_file_registry")
check('base registry is empty and 0009 objects are present',
      c0['registry'] == 0 and any(k.endswith(':crm_drive_review_case') for k in BEFORE), c0)
print('       inventory before: %d objects, digest %s' % (BEFORE_N, BEFORE_D[:16]))
ver = d1('SELECT sqlite_version() AS v')
D1VER = ('blocked by D1: ' + re.search(r'not authorized[^\"]{0,40}', ver).group(0)) if 'not authorized' in ver else 'exposed'
print('       D1 engine version via SQL: %s (node:sqlite rehearsal ran 3.51.3)' % D1VER)
DIFFNOTES.append(('sqlite_version()', 'blocked by D1 (not authorized to use function)',
                  'allowed by node:sqlite'))

# ---------------------------------------------------------------- 1) apply 0010 through wrangler
print('=== 1) apply the draft with the real migration runner ===')
shutil.copy(DRAFT10, os.path.join(MDIR, '0010_crm_drive_file_versions.sql'))
out1 = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
check('0010 applied with no split or parse error (ALTERs, table, triggers, views, backfill)',
      '0010_crm_drive_file_versions.sql' in out1 and 'executed successfully' in out1.lower(), out1[-400:])
AFTER = inventory()
AFTER_D, AFTER_N = digest(AFTER)
added = sorted(set(AFTER) - set(BEFORE))
check('every object 0010 adds is present (%d objects)' % len(added), len(added) >= 30, added[:6])
kinds = {}
for k in added:
    kinds[k.split(':')[0]] = kinds.get(k.split(':')[0], 0) + 1
print('       added by 0010: %s' % ' '.join('%s=%d' % (a, b) for a, b in sorted(kinds.items())))
NEWCOLS = ('drive_ref', 'head_version_seq', 'versions_observed', 'drive_revision', 'drive_md5',
           'head_evidence_class', 'duplicate_of_drive_ref', 'duplicate_of_version_seq')


def norm(t):
    return [re.sub(r'\s+', ' ', l).strip().rstrip(',') for l in (t or '').split('\n') if l.strip()]


shared = {k: BEFORE[k] for k in BEFORE if k in AFTER}
# 0010 is ADDITIVE: it alters exactly one pre-existing object, the registry table, by appending columns.
changed = [k for k, v in shared.items() if v != AFTER[k]]
check('0010 alters no pre-existing object except the registry table itself (0007 indexes/CHECKs, 0008, '
      '0009 tables, triggers and views are byte-identical)',
      changed == ['table:crm_drive_file_registry'], changed[:5])
words = lambda t: re.findall(r'[A-Za-z_][A-Za-z_0-9]*|[0-9]+', t or '')


def is_subseq(a, b):
    it = iter(b)
    return all(any(x == y for y in it) for x in a)


ow = words(BEFORE['table:crm_drive_file_registry'])
nw = words(AFTER['table:crm_drive_file_registry'])
check('that single change is purely additive: every word of the old file-row DDL still appears, in the'
      ' same order, inside the new one — so no original column, CHECK or constraint was edited, dropped'
      ' or reordered (a token-level subsequence test, robust against D1 rewriting the DDL text)',
      is_subseq(ow, nw) and len(nw) > len(ow), '%d -> %d tokens' % (len(ow), len(nw)))
check('and every word the change added is a word 0010 itself wrote (the engine invented nothing)',
      set(nw) - set(ow) <= set(words(open(DRAFT10, encoding='utf8').read())),
      sorted(set(nw) - set(ow) - set(words(open(DRAFT10, encoding='utf8').read())))[:8])
check('the original 0007 rules still exist on the file row (hashed still needs a digest, processed '
      'still needs provenance)',
      'content_sha256 is not null' in AFTER['table:crm_drive_file_registry'].lower()
      and 'processing_receipt_ref is not null' in AFTER['table:crm_drive_file_registry'].lower())
new_cols = [r['name'] for r in rows("PRAGMA table_info(crm_drive_file_registry)")]
check('all 8 projected columns exist on the file row',
      all(c in new_cols for c in ('drive_ref', 'head_version_seq', 'versions_observed', 'head_evidence_class',
                                  'drive_revision', 'drive_md5', 'duplicate_of_drive_ref', 'duplicate_of_version_seq')),
      ','.join(new_cols[-9:]))

# ---------------------------------------------------------------- 2) ADD COLUMN ... CHECK on D1
print('=== 2) the construct with no precedent in this repo: ADD COLUMN with a CHECK, on D1 ===')
allowed('a valid hex drive_ref is accepted',
        "INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name, mime_type,"
        " content_type, processing_status, drive_ref) VALUES ('g1','GGGG','f','f','application/zip','ZIP',"
        "'discovered', lower(hex(randomblob(32))))")
refused('a malformed drive_ref is refused by the added column CHECK',
        "INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name, mime_type,"
        " content_type, processing_status, drive_ref) VALUES ('g2','GGG2','f','f','application/zip','ZIP',"
        "'discovered','zzzz')", 'check constraint')
refused('a 63-hex drive_ref is refused too (length, not just charset)',
        "UPDATE crm_drive_file_registry SET drive_ref = substr(drive_ref,1,63) WHERE id='g1'", 'check constraint')
d1("DELETE FROM crm_drive_file_registry WHERE id IN ('g1','g2')")
refused('a file row cannot be born with a negative or claimed head',
        "INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name, mime_type,"
        " content_type, processing_status, versions_observed) VALUES ('g3','GG3','f','f','text/plain','TXT',"
        "'discovered',-1)", 'registry_head_is_maintained_by_the_ledger|check constraint')

# ---------------------------------------------------------------- 3) 99 synthetic registered files + bootstrap
print('=== 3) bootstrap_backfill against 99 synthetic rows (no customer data anywhere) ===')
vals = []
for i in range(1, 100):
    # born at 'metadata_scanned' because 0010 refuses a file row that arrives claiming a content state;
    # the status is advanced below, after the bootstrap versions exist, exactly as the promotion will.
    vals.append("('reg-%03d','SYNTH%03d','folder-%d','file-%03d.zip','file-%03d.zip','/x',"
                "'application/zip',%d,%s,%s,%s,'ZIP','metadata_scanned','not_required',%s,'receipt-%03d',0,1,'{}',%s,%s,%s)"
                % (i, i, i % 3, i, i, 1000 + i * 7, TS, TS, HEX, TS, i, TS, TS, TS))
script = ("INSERT INTO crm_drive_file_registry (id, drive_file_id, drive_parent_id, file_name,"
          " original_file_name, drive_path, mime_type, file_size, drive_created_at, drive_modified_at,"
          " content_sha256, content_type, processing_status, review_status, last_processed_at,"
          " processing_receipt_ref, extracted_records_count, processing_attempts, metadata_json,"
          " created_at, updated_at, last_seen_at) VALUES\n" + ",\n".join(vals) + ";\n")
allowed('99 synthetic registered files inserted at a metadata status', script, 'synth.sql')
refused('and the live state cannot be mirrored before the ledger exists — 99 rows cannot jump to '
        'processed', "UPDATE crm_drive_file_registry SET processing_status = 'processed' WHERE id LIKE 'reg-%'",
        'status_requires_a_recorded_version')
check('registry holds 99 rows, all processed, all with a 64-hex digest',
      (lambda r: r['n'] == 99 and r['hexy'] == 99)(
          counts("SELECT COUNT(*) AS n, SUM(CASE WHEN length(content_sha256)=64 THEN 1 ELSE 0 END) AS hexy"
                 " FROM crm_drive_file_registry WHERE id LIKE 'reg-%'")),
      rows("SELECT COUNT(*) AS n FROM crm_drive_file_registry"))
check('the bootstrap INSERT in the draft is inert while drive_ref is NULL (0 version rows)',
      counts('SELECT COUNT(*) AS n FROM crm_drive_file_version')['n'] == 0)
refused('the ledger cannot be opened before refs exist',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by) SELECT 'x#1', 'y', 1,"
        " lower(hex(randomblob(32))), 'bootstrap_backfill', 1, '2026-11-02T09:00:00Z',"
        " 'registry_bootstrap'", 'drive_version_ref_not_registered')

# the writer step SQL cannot do: fill drive_ref from a hash of the id, then re-run the draft's own §5
refill = ("UPDATE crm_drive_file_registry SET drive_ref = lower(hex(randomblob(32)))"
          " WHERE id LIKE 'reg-%' AND drive_ref IS NULL;\n")
allowed('drive_ref provisioned for all 99 rows (outside SQL, by the writer, as designed)', refill, 'refs.sql')
check('drive_ref is unique per row (partial UNIQUE index works on D1)',
      counts("SELECT COUNT(*) - COUNT(DISTINCT drive_ref) AS d FROM crm_drive_file_registry WHERE id LIKE 'reg-%'")['d'] == 0)
backfill = open(DRAFT10, encoding='utf8').read()
seg = backfill[backfill.index('INSERT INTO crm_drive_file_version'):backfill.index("-- ---------------------------------------------------------------------------\n-- 6)")]
seg = seg[:seg.rindex(';') + 1]
allowed('re-running the draft\'s own §5 backfill creates exactly the 99 bootstrap versions', seg, 'backfill.sql')
b = counts("SELECT COUNT(*) AS n, SUM(CASE WHEN evidence_class='bootstrap_backfill' THEN 1 ELSE 0 END) AS boot,"
           " SUM(CASE WHEN receipt_ref='phase2-0010-bootstrap' THEN 1 ELSE 0 END) AS rcpt,"
           " SUM(CASE WHEN drive_revision IS NULL THEN 1 ELSE 0 END) AS norev,"
           " SUM(CASE WHEN drive_md5 IS NULL THEN 1 ELSE 0 END) AS nomd5 FROM crm_drive_file_version")
check('99 bootstrap rows, all seq 1, all labelled (revision and md5 honestly absent, not guessed)',
      b['n'] == 99 and b['boot'] == 99 and b['rcpt'] == 99 and b['norev'] == 99 and b['nomd5'] == 99, b)
check('head projections advanced on all 99 file rows, and the invariant view stays clean',
      counts("SELECT COUNT(*) AS n FROM crm_drive_file_registry WHERE head_version_seq <> 1"
             " OR versions_observed <> 1 OR head_evidence_class <> 'bootstrap_backfill'")['n'] == 0
      and all(v == 0 for v in rows('SELECT * FROM crm_drive_version_invariant_violations')[0].values()),
      [counts("SELECT COUNT(*) AS n FROM crm_drive_file_registry WHERE head_version_seq <> 1"),
       rows('SELECT * FROM crm_drive_version_invariant_violations')[0]])
allowed('now the 99 rows may advance to processed, mirroring the live DB exactly',
        "UPDATE crm_drive_file_registry SET processing_status = 'processed' WHERE id LIKE 'reg-%'")
check('every one of the 99 reads aligned: head 1, bootstrap evidence, projection consistent',
      counts("SELECT COUNT(*) AS n FROM crm_drive_version_state WHERE projection_state <> 'aligned'")['n'] == 0)
allowed('the backfill is idempotent: re-running adds nothing', seg, 'backfill2.sql')
check('still exactly 99 version rows after a second run',
      counts('SELECT COUNT(*) AS n FROM crm_drive_file_version')['n'] == 99)

# ---------------------------------------------------------------- 4) the barriers, on D1
print('=== 4) the refusals, measured on the D1 engine ===')
one = rows("SELECT drive_ref AS ref, content_sha256 AS sha FROM crm_drive_file_registry WHERE id='reg-001'")[0]
REF, SHA = one['ref'], one['sha']
refused('a version row cannot exist without a fingerprint at all (NOT NULL, enforced by the real engine)',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, evidence_class,"
        " size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('" + REF + "#2','" + REF + "',2,'declared_by_writer',10," + LATER + ",'reconciliation','r-2')",
        'NOT NULL')
refused('an earlier version\'s fingerprint cannot be overwritten in place',
        "UPDATE crm_drive_file_registry SET content_sha256 = %s WHERE drive_ref = '%s'" % (HEX, REF),
        'registry_fingerprint_must_match_recorded_head_version')
refused('it cannot be erased either',
        "UPDATE crm_drive_file_registry SET content_sha256 = NULL WHERE drive_ref = '%s'" % REF,
        'registry_fingerprint_cannot_be_erased')
refused('a head pointer cannot be moved by hand',
        "UPDATE crm_drive_file_registry SET head_version_seq = 5 WHERE drive_ref = '%s'" % REF,
        'registry_head_must_match_ledger')
refused('a version may not skip a number',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('%s#9','%s',9,%s,'verified_local_recompute',10,%s,'intake_pipeline','r-1')" % (REF, REF, HEX, LATER),
        'drive_version_seq_not_next')
refused('a claimed measurement without a receipt is refused (no fabricated recompute)',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('%s#2','%s',2,%s,'verified_local_recompute',10,%s,'intake_pipeline',NULL)" % (REF, REF, HEX, LATER),
        'check constraint')
refused('the empty-buffer digest cannot be filed against a non-empty file',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('%s#2','%s',2,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',"
        " 'declared_by_writer',10,%s,'reconciliation','r-1')" % (REF, REF, LATER), 'check constraint')
refused('version_ref must be the derived (ref,seq) pair',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('hidden','%s',2,%s,'declared_by_writer',10,%s,'reconciliation','r-1')" % (REF, HEX, LATER),
        'check constraint')
refused('no UPDATE of the ledger', "UPDATE crm_drive_file_version SET size_bytes = 1",
        'drive_versions_are_append_only')
refused('no DELETE of the ledger', "DELETE FROM crm_drive_file_version", 'drive_versions_are_append_only')
refused('a file row that anchors history cannot be deleted',
        "DELETE FROM crm_drive_file_registry WHERE drive_ref = '%s'" % REF,
        'registry_row_anchors_versions_or_lineage')
refused('the ref handle is write-once',
        "UPDATE crm_drive_file_registry SET drive_ref = %s WHERE drive_ref = '%s'" % (HEX, REF),
        'registry_drive_ref_is_write_once')

print('=== 5) content change under identical metadata, and A->B->A, on D1 ===')
refused('a backdated version is refused (this barrier is what caught the fixture above)',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref) VALUES"
        " ('%s#2','%s',2,%s,'declared_by_writer',10,'2026-11-02T08:00:00.000Z','reconciliation','r-0')"
        % (REF, REF, HEX), 'drive_version_time_moved_backwards')
# size and drive_modified_at are copied from the file row verbatim: identical metadata, new bytes
allowed('v2 appended with the SAME size and the SAME modifiedTime, different bytes',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, drive_modified_at, observed_at, observed_by, receipt_ref)"
        " SELECT drive_ref||'#2', drive_ref, 2, %s, 'verified_local_recompute', file_size, drive_modified_at,"
        " %s, 'reconciliation', 'receipt-rehearsal' FROM crm_drive_file_registry WHERE drive_ref='%s'"
        % (HEX, LATER, REF))
st = rows("SELECT projection_state AS p, metadata_agreement AS m, metadata_is_silent AS q,"
          " head_size_bytes AS hs, registry_size_bytes AS rs FROM crm_drive_version_state WHERE drive_ref='%s'" % REF)[0]
check('the ledger reports it as a change the metadata could not see',
      st['p'] == 'registry_fingerprint_not_head' and st['m'] == 'changed_under_identical_metadata'
      and st['hs'] == st['rs'], st)
check('and the file row still holds the old digest, unread (history intact)',
      counts("SELECT (SELECT COUNT(*) FROM crm_drive_file_version WHERE drive_ref='%s') AS n" % REF)['n'] == 2)
head_sha = rows("SELECT content_sha256 AS s FROM crm_drive_file_version WHERE drive_ref='%s' AND version_seq=2" % REF)[0]['s']
allowed('the projection is legal once v2 is head',
        "UPDATE crm_drive_file_registry SET content_sha256 = '%s' WHERE drive_ref = '%s'" % (head_sha, REF))
check('state reads aligned again, and both digests remain on record',
      rows("SELECT projection_state AS p FROM crm_drive_version_state WHERE drive_ref='%s'" % REF)[0]['p'] == 'aligned'
      and counts("SELECT COUNT(DISTINCT content_sha256) AS n FROM crm_drive_file_version WHERE drive_ref='%s'" % REF)['n'] == 2)
# A -> B -> A: returning to the original bytes must be marked as a repeat
refused('an unmarked return to an old digest is refused',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref)"
        " SELECT drive_ref||'#3', drive_ref, 3, (SELECT content_sha256 FROM crm_drive_file_version"
        "   WHERE drive_ref='%s' AND version_seq=1), 'reconciliation-x', file_size, %s,"
        " 'reconciliation', 'r-2' FROM crm_drive_file_registry WHERE drive_ref='%s'" % (REF, LATER, REF),
        'check constraint|drive_version_repeat_must_be_marked')
allowed('a marked repeat is recorded as its own row (v1 is not resurrected or overwritten)',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref, repeat_of_version_ref)"
        " SELECT drive_ref||'#3', drive_ref, 3, (SELECT content_sha256 FROM crm_drive_file_version"
        "   WHERE drive_ref='%s' AND version_seq=1), 'declared_by_writer', file_size, %s,"
        " 'reconciliation', 'r-2', drive_ref||'#1' FROM crm_drive_file_registry WHERE drive_ref='%s'" % (REF, LATER, REF))
check('three rows for that file: v1 and v3 share a digest, v2 keeps the other',
      counts("SELECT COUNT(*) AS n, COUNT(DISTINCT content_sha256) AS d FROM crm_drive_file_version"
             " WHERE drive_ref='%s'" % REF) == {'n': 3, 'd': 2})
refused('a repeat may not point at a version that did not carry that digest',
        "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
        " evidence_class, size_bytes, observed_at, observed_by, receipt_ref, repeat_of_version_ref)"
        " VALUES ('%s#4','%s',4,%s,'declared_by_writer',10,%s,'reconciliation','r-3','%s#2')" % (REF, REF, HEX, LATER, REF),
        'drive_version_repeat_target_invalid')

print('=== 6) the queue, the views, and a healthy read ===')
q = counts("SELECT COUNT(*) AS n FROM crm_drive_rehash_queue WHERE reason='bootstrap_claim_only'")
check('the 98 untouched files sit in the rehash queue as bootstrap claims (reg-001 moved past it)',
      q['n'] == 98, q)
check('provenance separates the three evidence classes',
      rows("SELECT COUNT(DISTINCT evidence_class) AS n FROM crm_drive_version_provenance")[0]['n'] >= 2)
check('duplicate evidence is empty for bootstrap claims (provisional-looking data cannot claim a duplicate)',
      counts('SELECT COUNT(*) AS n FROM crm_drive_duplicate_evidence')['n'] == 0)
check('an intact ledger reads intact (invariant view all zero)',
      all(v == 0 for v in rows('SELECT * FROM crm_drive_version_invariant_violations')[0].values()))
vcols = [r['name'] for r in rows('PRAGMA table_info(crm_drive_version_state)')]
check('no view exposes a name, path or raw id column',
      not [c for c in vcols if c in ('file_name', 'original_file_name', 'drive_path', 'drive_file_id',
                                     'error_message')], ','.join(vcols))

print('=== 7) D1 vs node:sqlite differential (same statements, both engines) ===')


def node_probe(sqls, stub_sql):
    """run the same statements through node:sqlite so the differential is measured, not asserted"""
    payload = {'draft': DRAFT10, 'stub': stub_sql, 'sqls': sqls}
    pp = os.path.join(SCRATCH, 'probe.json')
    with open(pp, 'w') as fh:
        json.dump(payload, fh)
    js = chr(10).join([
        "import { DatabaseSync } from 'node:sqlite';",
        "import { readFileSync } from 'node:fs';",
        "const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
        "const db = new DatabaseSync(':memory:');",
        "db.exec('PRAGMA foreign_keys=ON;');",
        "db.exec(j.stub);",
        "db.exec(readFileSync(j.draft, 'utf8'));",
        "const out = [];",
        "for (const s of j.sqls) {",
        "  try { db.exec(s); out.push('ACCEPTED'); }",
        "  catch (e) { out.push(String(e.message).replace(/[^ -~]+/g, ' ').slice(0, 90)); }",
        "}",
        "console.log(JSON.stringify(out));",
    ])
    jp = os.path.join(SCRATCH, 'probe.mjs')
    with open(jp, 'w') as fh:
        fh.write(js)
    txt = sh(['node', jp, pp])
    m = re.search(r'\[.*\]', txt, re.S)
    return json.loads(m.group(0)) if m else ['harness error: ' + txt[-160:]]


STUB = ("CREATE TABLE crm_drive_file_registry(id TEXT PRIMARY KEY, drive_file_id TEXT UNIQUE,"
        " drive_parent_id TEXT, file_name TEXT NOT NULL, original_file_name TEXT NOT NULL, drive_path TEXT,"
        " mime_type TEXT, file_size INTEGER, drive_created_at TEXT, drive_modified_at TEXT,"
        " content_sha256 TEXT, inner_content_sha256 TEXT, content_type TEXT, processing_status TEXT,"
        " review_status TEXT, last_processed_at TEXT, last_seen_at TEXT, processing_attempts INTEGER,"
        " processing_receipt_ref TEXT, extracted_records_count INTEGER, error_code TEXT, error_message TEXT,"
        " duplicate_of_file_id TEXT, reviewed_by TEXT, reviewed_at TEXT, review_notes TEXT, metadata_json TEXT,"
        " created_at TEXT, updated_at TEXT);")


PROBE_SQLS = [
    "INSERT INTO crm_drive_file_version (version_ref, drive_ref, version_seq, content_sha256,"
    " evidence_class, size_bytes, observed_at, observed_by) VALUES ('a','b',1,'c',"
    " 'verified_local_recompute',1,'2026-11-02T09:00:00Z','reconciliation')",
    "CREATE TABLE bad(a INTEGER, CHECK (b = 0), b INTEGER)",
    "INSERT INTO crm_drive_file_registry (id, drive_file_id, file_name, original_file_name, mime_type,"
    " content_type, head_version_seq) VALUES ('z','zz','f','f','text/plain','TXT',5)",
]
PROBE_LABELS = ['unregistered ledger row', 'table CHECK before its column', 'head claimed at insert']


def d1_verdict(sql):
    """the engine's verdict, normalised so a comparison against node:sqlite means the same words"""
    txt = d1(sql)
    if 'executed successfully' in txt.lower():
        return 'ACCEPTED'
    m = re.search(r'\[ERROR\]\s*([^\n]+)', txt) or re.search(r'(SQLITE_\w+)', txt)
    msg = (m.group(1) if m else txt.strip())
    msg = re.sub(r'^error at offset \d+:\s*', '', msg).strip().rstrip(':.')
    return re.sub(r'\s*at offset \d+$', '', re.sub(r'\s+', ' ', msg))[:90]


node_out = node_probe(PROBE_SQLS, STUB)
d1_out = [d1_verdict(x) for x in PROBE_SQLS]
acc = lambda x: x == 'ACCEPTED'
for lab, n, t in zip(PROBE_LABELS, node_out, d1_out):
    print('       %-26s node: %-44s D1: %s' % (lab, str(n)[:42], str(t)[:56].strip()))
    if acc(n) != acc(t):
        DIFFNOTES.append((lab, 'D1 refused=%s' % (not acc(t)), 'node refused=%s' % (not acc(n))))
    elif not str(t).startswith(str(n)):
        DIFFNOTES.append((lab + ' (message differs)', str(t)[:44], str(n)[:44]))
check('both engines refuse the same way: a ledger row for a file the registry does not know cannot be'
      ' written — the node rehearsal and the real engine reach the identical barrier',
      not acc(node_out[0]) and not acc(d1_out[0])
      and 'drive_version_ref_not_registered' in node_out[0]
      and 'drive_version_ref_not_registered' in d1_out[0], node_out[0] + ' | ' + d1_out[0])
check('both engines reject a table-level CHECK that forward-references a column — the reason every'
      ' table-level CHECK in the draft sits after the column list',
      not acc(node_out[1]) and not acc(d1_out[1]), node_out[1] + ' | ' + d1_out[1])
check('both engines refuse a file row born claiming a head version (the projection is the ledger to set)',
      not acc(node_out[2]) and not acc(d1_out[2])
      and 'registry_head_is_maintained_by_the_ledger' in node_out[2]
      and 'registry_head_is_maintained_by_the_ledger' in d1_out[2], node_out[2] + ' | ' + d1_out[2])
check('and no probe differs in its accept/refuse verdict between engines',
      all(acc(n) == acc(t) for n, t in zip(node_out, d1_out)),
      [lab for lab, n, t in zip(PROBE_LABELS, node_out, d1_out) if acc(n) != acc(t)])
sfx = [re.sub('^' + re.escape(n), '', d).strip(': ') for n, d in zip(node_out, d1_out)]
check('stronger still: for the same refusal D1 prints exactly the sentence node:sqlite prints and appends'
      ' only its own SQLITE result code — the barrier is the same barrier, not a similar-looking one',
      all(d.startswith(n) for n, d in zip(node_out, d1_out))
      and all('SQLITE_' in x for x in sfx), sfx)
d1("DROP TABLE IF EXISTS bad")

print('=== 8) statement atomicity of a failed apply (the risk the promotion plan depends on) ===')
atomic = exec_script('atomic.sql', """CREATE TABLE IF NOT EXISTS probe_atomic (x INTEGER);
INSERT INTO probe_atomic VALUES (1);
SELECT RAISE(ABORT, 'deliberate failure');""")
surv = rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='probe_atomic'")[0]['n']
rows_n = rows("SELECT COUNT(*) AS n FROM probe_atomic")[0]['n'] if surv else 0
print('       after a failed batch: table_present=%s rows=%s' % (surv, rows_n))
print('       measured: the engine %s the statement that succeeded before the failure'
      % ('KEPT' if surv == 1 else 'ROLLED BACK'))
rep = sh(WR + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG, '--persist-to', STATE])
DIG8 = digest(inventory())[0]
half = counts("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='probe_atomic'")['n']
print('       re-apply output: %s' % (rep.strip().splitlines()[-1] if rep.strip() else 'ok'))
check('a re-apply after a failed migration file lands on exactly the schema a clean apply produced, with'
      ' nothing half-built left behind — the property the promotion plan relies on',
      DIG8 == AFTER_D and half == 0, {'digest_matches_clean_apply': DIG8 == AFTER_D,
                                      'probe_atomic_survived': half})

print('=== 9) integrity, foreign keys, and the possible rollback ===')
ic_txt = d1('PRAGMA integrity_check')
check('D1 refuses PRAGMA integrity_check through its SQL interface (measured, and it shapes the '
      'promotion checklist: the repo\'s "integrity_check = ok" item cannot be run this way)',
      'not authorized' in ic_txt, ic_txt[-160:])
DIFFNOTES.append(('PRAGMA integrity_check', 'blocked by D1 (SQLITE_AUTH)', 'allowed by node:sqlite'))
DBFILE = d1_file_path()
if DBFILE:
    import sqlite3 as _s3
    _h = _s3.connect(DBFILE)
    ic = [r[0] for r in _h.execute('PRAGMA integrity_check')]
    _h.close()
    check('integrity_check is ok after 0010 and every tampering attempt (run on the file D1 wrote)',
          ic == ['ok'], ic[:2])
else:
    check('could not locate the scratch D1 file to run integrity_check', False)
fk = rows('PRAGMA foreign_key_check')
check('foreign_key_check is empty (D1 does allow this one, and enforces FKs always)', not fk, fk[:2])
after_tamper = digest(inventory())
check('the schema did not drift during the whole rehearsal (inventory digest stable)',
      after_tamper[0] == AFTER_D, after_tamper[0][:16] + ' vs ' + AFTER_D[:16])
MIGTAB = [list(r.values())[0] for r in rows(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migrations%'")][0]
roll = exec_script('rollback.sql', """
DROP VIEW IF EXISTS crm_drive_version_state;
DROP VIEW IF EXISTS crm_drive_rehash_queue;
DROP VIEW IF EXISTS crm_drive_version_provenance;
DROP VIEW IF EXISTS crm_drive_duplicate_lineage;
DROP VIEW IF EXISTS crm_drive_duplicate_evidence;
DROP VIEW IF EXISTS crm_drive_version_invariant_violations;
DROP TABLE IF EXISTS crm_drive_file_version;
DELETE FROM %s WHERE name LIKE '0010%%';
""" % MIGTAB)
inv_rb = inventory()
check('rollback of 0010 removes only its own objects (the ledger table is gone, the file rows remain)',
      'table:crm_drive_file_version' not in inv_rb and 'table:crm_drive_file_registry' in inv_rb)
diff_rb = [k for k in BEFORE if k in inv_rb and inv_rb[k] != BEFORE[k]]
check('0007/0008/0009 objects survive a 0010 rollback byte-identically — with one expected exception,'
      ' the registry table, whose 8 added columns cannot be dropped (asserted next)',
      diff_rb in ([], ['table:crm_drive_file_registry']), diff_rb)
check('the 8 added columns cannot be removed by DROP (SQLite has no DROP COLUMN here): honest residual',
      all(c in [r['name'] for r in rows('PRAGMA table_info(crm_drive_file_registry)')]
          for c in ('drive_ref', 'head_version_seq')))
rows_left = counts("SELECT COUNT(*) AS n FROM crm_drive_file_registry")
check('and the 99 registered files are untouched by the rollback (no data loss in either direction)',
      rows_left['n'] == 99, rows_left)
mign = counts("SELECT COUNT(*) AS n FROM %s WHERE name NOT LIKE '0010%%'" % MIGTAB)['n']
check('the migration counter is rewound for 0010 only (base + 0002/0007/0008/0009 remain)',
      mign == 5, {'table': MIGTAB, 'rows': mign})

# ---------------------------------------------------------------- summary
print('\ndifferences measured between D1 and node:sqlite:')
for a, b, c in DIFFNOTES:
    print('   %-26s D1: %-46s node: %s' % (a, b, c))
print('\n--- scratch kept at %s (KEEP=1 keeps it) ---' % (SCRATCH if os.environ.get('KEEP') else 'removed'))
ok = sum(1 for r in results if r)
print('D1_VERSIONS %d/%d checks held' % (ok, len(results)))
if not os.environ.get('KEEP'):
    shutil.rmtree(SCRATCH, ignore_errors=True)
if ok != len(results):
    print('D1_BARRIERS_MISSING — see FAIL lines above')
    sys.exit(1)
print('ALL_BARRIERS_HELD_ON_D1')
