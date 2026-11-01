#!/usr/bin/env python3
"""D1-engine rehearsal for the DRAFT migration 0009 (human review workflow).

It builds a THROWAWAY database in a temporary directory and drives it with `wrangler d1 … --local`,
i.e. the Cloudflare D1 SQL engine against a sandbox-local file. No remote database is contacted:
`nasr-crm-test-db`, `nasr-market-db` and the reference backup are never referenced, and no Drive
call is made. The file under test is read straight from `_worker/migrations-draft/`, so the
rehearsal always matches exactly what is being reviewed.

    python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py
    WRANGLER=$(which wrangler) python3 …      # use a local wrangler binary
    KEEP=1 python3 …                          # keep the scratch database for inspection

Exit 0 means every barrier was refused by D1 and every tampering attempt was detected.
Companion: crm-review-sql-0009.abuse.mjs (same contract against node:sqlite, 78 checks).
"""
import json
import os
import shutil
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DRAFT = os.path.join(REPO, '_worker', 'migrations-draft', '0009_crm_drive_review_workflow.sql')
SCRATCH = os.environ.get('P9REV_DIR') or tempfile.mkdtemp(prefix='crm-review-sql-0009-')
STATE = os.path.join(SCRATCH, 'state')
DB = 'crm-review-sql-rehearsal'
RUN = 'p9-d1-rehearsal'
CFG = os.path.join(SCRATCH, 'wrangler.toml')
ENV = dict(os.environ, CI='1', WRANGLER_SEND_METRICS='false')
_wr = os.environ.get('WRANGLER') or shutil.which('wrangler')
WRANGLER = [_wr] if _wr else ['npx', '--yes', 'wrangler@4']

os.makedirs(os.path.join(SCRATCH, 'migrations'), exist_ok=True)
shutil.copy(DRAFT, os.path.join(SCRATCH, 'migrations', '0009_crm_drive_review_workflow.sql'))
with open(os.path.join(SCRATCH, 'empty.mjs'), 'w') as fh:
    fh.write('export default { fetch() { return new Response("ok"); } };\n')
with open(CFG, 'w') as fh:
    fh.write('name = "%s"\nmain = "empty.mjs"\ncompatibility_date = "2026-11-01"\n\n' % DB)
    fh.write('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\n' % DB)
    fh.write('database_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "./migrations"\n')
BASE = """-- rehearsal base: only the parent table the draft references
CREATE TABLE IF NOT EXISTS crm_drive_analysis_run (
  run_key TEXT PRIMARY KEY CHECK (length(trim(run_key)) BETWEEN 3 AND 160),
  payload_fingerprint TEXT NOT NULL UNIQUE CHECK (length(payload_fingerprint) = 64
                            AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
  analysis_version TEXT NOT NULL,
  drive_parent_id TEXT NOT NULL,
  files_expected INTEGER NOT NULL DEFAULT 0,
  files_analyzed INTEGER NOT NULL DEFAULT 0,
  files_processed INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0
);
"""
BASE += """-- crm_sessions comes from 0002 in the real chain; 0009's liveness trigger reads it, so the stub
-- keeps the columns that trigger uses plus their typeof CHECKs.
CREATE TABLE crm_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR typeof(revoked_at) = 'integer')
);
INSERT INTO crm_sessions(id, token_hash, created_at, expires_at, revoked_at) VALUES
  ('live', '{live}', CAST(strftime('%s','now') AS INTEGER)*1000 - 60000, CAST(strftime('%s','now') AS INTEGER)*1000 + 3600000, NULL),
  ('live2', '{live2}', CAST(strftime('%s','now') AS INTEGER)*1000 - 60000, CAST(strftime('%s','now') AS INTEGER)*1000 + 3600000, NULL),
  ('expired', '{expired}', CAST(strftime('%s','now') AS INTEGER)*1000 - 7200000, CAST(strftime('%s','now') AS INTEGER)*1000 - 3600000, NULL),
  ('revoked', '{revoked}', CAST(strftime('%s','now') AS INTEGER)*1000 - 60000, CAST(strftime('%s','now') AS INTEGER)*1000 + 3600000, CAST(strftime('%s','now') AS INTEGER)*1000 - 1000);
"""
LIVE = "1" * 64
LIVE2 = "2" * 64
EXPIRED = "3" * 64
REVOKED = "4" * 64
with open(os.path.join(SCRATCH, 'migrations', '0001_base.sql'), 'w') as fh:
    fh.write(BASE.format(live=LIVE, live2=LIVE2, expired=EXPIRED, revoked=REVOKED))

results = []


def d1(sql):
    p = subprocess.run(WRANGLER + ['d1', 'execute', DB, '--local', '--config', CFG,
                                   '--persist-to', STATE, '--command', sql],
                       capture_output=True, text=True, cwd=SCRATCH, env=ENV)
    return (p.stdout or '') + (p.stderr or '')


def rows(sql):
    p = subprocess.run(WRANGLER + ['d1', 'execute', DB, '--local', '--config', CFG, '--json',
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
        if 'results' in d:
            r = d['results']
            return r if isinstance(r, list) else []
    raise RuntimeError('unparsable d1 output: ' + txt[-200:])


def refused(label, sql, fragment):
    txt = d1(sql)
    frags = fragment if isinstance(fragment, tuple) else (fragment,)
    if any(f in txt for f in frags):
        results.append(True)
        print(f'  ok   {label} — refused by D1 [{"/".join(frags)} possible]')
    elif 'executed successfully' in txt:
        results.append(False)
        print(f'  FAIL {label} — the write went through, barrier missing')
    else:
        results.append(False)
        print(f'  FAIL {label} — refused for another reason: {txt.strip()[-400:]}')


def allowed(label, sql):
    txt = d1(sql)
    if 'executed successfully' in txt:
        results.append(True)
        print(f'  ok   {label} — allowed')
    else:
        results.append(False)
        print(f'  FAIL {label} — unexpectedly refused: {txt.strip()[-160:]}')


def check(label, cond, detail=''):
    results.append(bool(cond))
    tail = f' — {detail}' if (detail and not cond) else ''
    print(f'  {"ok  " if cond else "FAIL"} {label}{tail}')


EXPECTED = {'table': 5, 'index': 8, 'trigger': 18, 'view': 4}   # the design's object inventory
HEX32 = 'lower(hex(randomblob(32)))'
TS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

# ------------------------------------------------------- 1) apply the draft through wrangler itself
shutil.rmtree(STATE, ignore_errors=True)
out = subprocess.run(WRANGLER + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG,
                                  '--persist-to', STATE],
                     capture_output=True, text=True, cwd=SCRATCH, env=ENV).stdout
print('=== 1) apply the draft through wrangler (the real migration runner) ===')
check('wrangler applied 0009 without a split or parse error',
      '0009_crm_drive_review_workflow.sql' in out and 'No migrations to apply' not in out, out[-300:])
check('every statement of the file executed (trigger bodies intact)', 'executed successfully' in out, out[-200:])
inv = rows("SELECT type, COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'crm_drive_review%' "
           "OR name LIKE 'trg_review%' OR name LIKE 'crm_review%' OR name LIKE 'idx_crm_review%' GROUP BY type")
got = {r['type']: r['c'] for r in inv}
check('object inventory matches the design (5 tables, 18 triggers, 4 views, 8 indexes)',
      got == EXPECTED, str(got))
tg = rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_review%'")[0]['n']
check('all 18 guard triggers survived the statement splitter', tg == 18, f'got {tg}')

# ---------------------------------------------------------- 2) seed: run, genesis head, two cases
print('=== 2) seed: one analysis run, a genesis head and two cases ===')
allowed('analysis run row', f"INSERT INTO crm_drive_analysis_run (run_key, payload_fingerprint, analysis_version, drive_parent_id) VALUES ('{RUN}', {HEX32}, 'p4a-v1-rehearsal', {HEX32});")
allowed('chain head at genesis', f"INSERT INTO crm_drive_review_chain_head (run_key, head_sha256, event_count, updated_at) SELECT '{RUN}', {HEX32}, 0, '2026-11-01T12:00:00.000Z';")
allowed('genesis anchor', f"INSERT INTO crm_drive_review_chain_anchor (run_key, event_seq, head_sha256, event_count, anchor_source, anchored_at) SELECT '{RUN}', 0, head_sha256, 0, 'genesis', '2026-11-01T12:00:00.000Z' FROM crm_drive_review_chain_head WHERE run_key='{RUN}';")
CASE_COLS = ("INSERT INTO crm_drive_review_case (case_ref, case_kind, run_key, drive_file_id, "
             "source_content_kind, match_class, evidence_type, confidence, signal_kind, crm_contact_id, "
             "basis, approve_allowed, case_snapshot_sha256, built_at) VALUES ")
allowed('phone-backed case', CASE_COLS + f"('p4r-001','file_to_contact','{RUN}', {HEX32},'VCF','exact_match','vcard_tel_digest_equal_primary','high','phone','c0ffee00c0ffee00c0ffee00c0ffee0042','vcard_tel',1, {HEX32},'2026-11-01T12:00:00.000Z');")
allowed('name-only case', CASE_COLS + f"('p4r-002','file_to_contact','{RUN}', {HEX32},'ZIP','probable_match','transcript_overlap_with_matched_file','low','name','c0ffee00c0ffee00c0ffee00c0ffee0043','name_digest',0, {HEX32},'2026-11-01T12:00:00.000Z');")
allowed('an unsealed phone-backed case (no reveal possible)', CASE_COLS + f"('p4r-003','file_to_contact','{RUN}', {HEX32},'VCF','exact_match','vcard_tel_digest_equal_primary','high','phone','c0ffee00c0ffee00c0ffee00c0ffee0045','vcard_tel',1, {HEX32},'2026-11-01T12:00:00.000Z');")
refused('a name-only case cannot advertise approve_allowed', CASE_COLS + f"('p4r-003','file_to_contact','{RUN}', {HEX32},'ZIP','name_only_match','name_digest_equal_primary_name','low','name','c0ffee00c0ffee00c0ffee00c0ffee0044','name_digest',1, {HEX32},'2026-11-01T12:00:00.000Z');", 'CHECK constraint failed')
refused('a person case needs two files', "INSERT INTO crm_drive_review_case (case_ref, case_kind, run_key, "
        "drive_file_id, match_class, evidence_type, confidence, signal_kind, files_count, crm_contact_id, "
        "basis, approve_allowed, case_snapshot_sha256, built_at) VALUES "
        f"('p4c-09','contact_fanout','{RUN}',NULL,'conflict','same_contact_id_from_two_files','none','none',1,"
        f"'c0ffee00c0ffee00c0ffee00c0ffee0042','name_digest',0, {HEX32},'2026-11-01T12:00:00.000Z');",
        'CHECK constraint failed')
refused('a file case must name its file', "INSERT INTO crm_drive_review_case (case_ref, case_kind, run_key, "
        "drive_file_id, match_class, evidence_type, confidence, crm_contact_id, basis, approve_allowed, "
        f"case_snapshot_sha256, built_at) VALUES ('p4r-005','file_to_contact','{RUN}',NULL,'exact_match',"
        f"'vcard_tel_digest_equal_primary','high','c0ffee00c0ffee00c0ffee00c0ffee0042','vcard_tel',1,"
        f"{HEX32},'2026-11-01T12:00:00.000Z');", 'CHECK constraint failed')
refused('a case ref must keep its stable shape', CASE_COLS + f"('p4r-7','file_to_contact','{RUN}', {HEX32},'VCF','exact_match','vcard_tel_digest_equal_primary','high','phone','c0ffee00c0ffee00c0ffee00c0ffee0042','vcard_tel',1, {HEX32},'2026-11-01T12:00:00.000Z');", 'CHECK constraint failed')
refused('a seal needs a real case', "INSERT INTO crm_drive_review_seal (case_ref, run_key, envelope_version, "
        "algo, kdf, aad_mode, key_version, iv_b64u, tag_b64u, ciphertext_b64u, ciphertext_sha256, "
        "plaintext_sha256, plaintext_len, sealed_by, created_at, expires_at) VALUES "
        "('%s','%s','p4rev_v1','AES-256-GCM','HKDF-SHA256','case_bound_v1',1,'AAAAAAAAAAAAAAAAAAAAAA',"
        "'AAAAAAAAAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',"
        "'0000000000000000000000000000000000000000000000000000000000000001',"
        f"'0000000000000000000000000000000000000000000000000000000000000002',120,'analysis_pipeline',"
        f"'2026-11-01T12:00:00.000Z','2027-01-30T00:00:00.000Z');" % ('p4r-777', RUN),
        'review_seal_case_not_found')

# ------------------------------------------------------------------ 2b) seals for the two cases
SEAL_CT = "c" * 64                       # the ciphertext_sha256 of p4r-001's stored blob
SEAL_CT2 = "d" * 64                      # and of p4r-002's
SEAL_INS = ("INSERT INTO crm_drive_review_seal (case_ref, run_key, envelope_version, algo, kdf, aad_mode,"
            " key_version, iv_b64u, tag_b64u, ciphertext_b64u, ciphertext_sha256, plaintext_sha256,"
            " plaintext_len, retention_days, sealed_by, created_at, expires_at) VALUES "
            "('{ref}', '{run}', 'p4rev_v1', 'AES-256-GCM', 'HKDF-SHA256', 'case_bound_v1', 1,"
            " 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA',"
            " '{ct}', '{ct}', 120, 90, 'analysis_pipeline',"
            " strftime('%Y-%m-%dT%H:%M:%fZ','now'),"
            " strftime('%Y-%m-%dT%H:%M:%fZ','now', '+90 days'));")
print('=== 2b) seal the two card cases (option A: ciphertext only) ===')
allowed('seal for the phone-backed case', SEAL_INS.format(ref='p4r-001', run=RUN, ct=SEAL_CT))
allowed('seal for the name-only case', SEAL_INS.format(ref='p4r-002', run=RUN, ct=SEAL_CT2))

# ------------------------------------------------------- 3) decisions: what the schema allows and not
EV = """INSERT INTO crm_drive_review_event
  (run_key,event_seq,case_seq,case_ref,event_type,decision_state,reviewer,reviewer_attestation,session_hash,
   reason,reason_sha256,basis_at_event,case_snapshot_sha256,link_applied,merge_authorized,
   contact_write_count,occurred_at,prev_event_sha256,event_sha256,reveal_purpose,reveal_outcome,
   seal_ciphertext_sha256)
 SELECT '{run}', (SELECT event_count+1 FROM crm_drive_review_chain_head WHERE run_key='{run}'),
        (SELECT COUNT(*)+1 FROM crm_drive_review_event e WHERE e.case_ref='{ref}'),
        '{ref}','{type}',{state},'nasr.owner','session_label_not_independent_identity',
        '{sess}', '{reason}', lower(hex(randomblob(32))),
        (SELECT basis FROM crm_drive_review_case WHERE case_ref='{ref}'),
        (SELECT case_snapshot_sha256 FROM crm_drive_review_case WHERE case_ref='{ref}'),
        {link},{merge},{write}, {ts},
        (SELECT head_sha256 FROM crm_drive_review_chain_head WHERE run_key='{run}'),
        lower(hex(randomblob(32))), {purpose}, {outcome}, {blob}
   FROM crm_drive_review_case WHERE case_ref='{ref}'"""


def ev(**kw):
    kw.setdefault('link', 0)
    kw.setdefault('merge', 0)
    kw.setdefault('write', 0)
    kw.setdefault('state', 'NULL')
    kw.setdefault('run', RUN)
    kw.setdefault('ts', TS)
    kw.setdefault('sess', LIVE)
    kw.setdefault('purpose', 'NULL')
    kw.setdefault('outcome', 'NULL')
    kw.setdefault('blob', 'NULL')
    return EV.format(**kw) + ';'


def reveal(**kw):
    kw['type'] = 'reveal'
    kw.setdefault('purpose', "'identity_check'")
    kw.setdefault('outcome', "'granted'")
    kw.setdefault('blob', "'%s'" % (SEAL_CT if kw.get('ref') == 'p4r-001' else SEAL_CT2))
    return ev(**kw)


print('=== 3) decisions: what the schema allows and refuses ===')
allowed('a granted reveal of the sealed card', reveal(ref='p4r-001',
      reason='the reviewer opened the sealed vCard to compare the telephone before deciding'))
allowed('approve on a phone-backed case', ev(type='approve', state="'approved'", ref='p4r-001',
      reason='vCard telephone equals the stored CRM row so identity is confirmed'))
after = rows('SELECT (SELECT COUNT(*) FROM crm_drive_review_event) AS e, '
             '(SELECT event_count FROM crm_drive_review_chain_head) AS h, '
             '(SELECT COUNT(*) FROM crm_drive_review_chain_anchor) AS a')[0]
check('ledger advanced and mirrored into the anchor table', after == {'e': 2, 'h': 2, 'a': 3}, str(after))
allowed('note on the same case', ev(type='note', ref='p4r-001',
      reason='the card also carries a landline, kept as detail only'))
allowed('defer on the name-only case', ev(type='defer', state="'deferred'", ref='p4r-002',
      reason='no phone-backed identifier yet so identity stays unconfirmed'))
allowed('an ISO date in a reason is fine (no false positive)', ev(type='note', ref='p4r-002',
      reason='the source file was exported on 2026-11-01 before the inventory ran'))
allowed('the name-only card was opened too', reveal(ref='p4r-002',
      reason='the reviewer read the card even though it can never be approved on this basis'))
refused('approve on a name-only basis', ev(type='approve', state="'approved'", ref='p4r-002',
      reason='the names look identical so approve this card now'),
      'review_approve_requires_phone_backed_basis')
refused('link_applied = 1', ev(type='note', ref='p4r-001', link=1,
      reason='an event trying to assert a side effect on the CRM'), 'CHECK constraint failed')
refused('merge_authorized = 1', ev(type='note', ref='p4r-001', merge=1,
      reason='an event trying to authorize merging two contacts'), 'CHECK constraint failed')
refused('contact_write_count = 1', ev(type='note', ref='p4r-001', write=1,
      reason='an event claiming it wrote an operational row'), 'CHECK constraint failed')
refused('automation cannot sign a human decision',
      ev(type='note', ref='p4r-001', reason='automation signing a decision on behalf of a person')
      .replace("'nasr.owner'", "'system'"), 'CHECK constraint failed')
refused('reason cannot carry a phone number', ev(type='note', ref='p4r-001',
      reason='call him on 01012345678 before deciding anything here'), 'CHECK constraint failed')
refused('reason cannot hold pasted transcript lines', ev(type='note', ref='p4r-001',
      reason='line one\nline two of transcript content pasted in'), 'CHECK constraint failed')
refused('reveal without a purpose', ev(type='reveal', ref='p4r-001',
      reason='the reviewer opened the sealed card once for an identity check'), 'CHECK constraint failed')
UNKNOWN = ("INSERT INTO crm_drive_review_event (run_key,event_seq,case_seq,case_ref,event_type,reviewer,"
           "reviewer_attestation,session_hash,reason,reason_sha256,basis_at_event,case_snapshot_sha256,"
           f"occurred_at,prev_event_sha256,event_sha256) VALUES ('{RUN}',"
           " (SELECT event_count+1 FROM crm_drive_review_chain_head),"
           " (SELECT COUNT(*)+1 FROM crm_drive_review_event WHERE case_ref='p4r-999'),'p4r-999','note',"
           f" 'nasr.owner','session_label_not_independent_identity', '{LIVE}',"
           " 'a decision recorded against an invented case reference', lower(hex(randomblob(32))),"
           f" 'vcard_tel', lower(hex(randomblob(32))), {TS},"
           " (SELECT head_sha256 FROM crm_drive_review_chain_head), lower(hex(randomblob(32))));")
# the session is pinned to a live one on purpose: D1 fires same-event triggers in an order SQLite
# does not guarantee, so each probe must leave exactly one barrier standing.
refused('event for an unknown case', UNKNOWN, 'review_event_case_not_found')
refused('event bound to another snapshot',
        ev(type='note', ref='p4r-001', reason='a decision quoting data never shown to the reviewer')
        .replace("(SELECT case_snapshot_sha256 FROM crm_drive_review_case WHERE case_ref='p4r-001')",
                 "'0000000000000000000000000000000000000000000000000000000000000000'"),
        'review_event_snapshot_mismatch')

# ----------------------------- 3b) reveal->approve binding, session liveness, retention policy
print('=== 3b) reveal->approve binding, session liveness, retention ceiling ===')
refused('approve with no reveal ever granted', ev(type='approve', state="'approved'", ref='p4r-003',
      reason='approve on a case whose card was never opened by this reviewer'),
      'review_approve_requires_fresh_reveal')
allowed('a reveal on an unsealed case is still recorded (nothing to match yet)',
        ev(type='reveal', ref='p4r-003', purpose="'identity_check'", outcome="'granted'",
           blob="'0000000000000000000000000000000000000000000000000000000000000000'",
           reason='a reveal that pins a blob the seal table does not hold'))
refused('approve still refused when the reveal pins the wrong blob',
        ev(type='approve', state="'approved'", ref='p4r-003',
           reason='approve after opening a card digest that was never stored'),
        'review_approve_requires_fresh_reveal')
refused('a decision on an expired session', ev(type='note', ref='p4r-001', sess=EXPIRED,
      reason='the session lapsed between opening the panel and clicking exclude'),
      'review_event_session_not_live')
refused('a decision on a revoked session', ev(type='note', ref='p4r-001', sess=REVOKED,
      reason='the reviewer logged out on another device and the session was revoked'),
      'review_event_session_not_live')
refused('a reveal on a revoked session', ev(type='reveal', ref='p4r-001', sess=REVOKED,
      purpose="'identity_check'", outcome="'granted'", blob="'%s'" % SEAL_CT,
      reason='opening a sealed card after the session was revoked'),
      'review_event_session_not_live')
refused('approve under a second live session', ev(type='approve', state="'approved'", ref='p4r-001',
      sess=LIVE2, reason='approve using another device session that never opened the card'),
      'review_approve_requires_fresh_reveal')
refused('approve reusing the reveal of another reviewer',
        ev(type='approve', state="'approved'", ref='p4r-001',
           reason='a different reviewer tries to ride on the reveal already recorded')
        .replace("'nasr.owner'", "'other.reviewer'"), 'review_approve_requires_fresh_reveal')
refused('approve on a reveal older than the 24 hour window',
        ev(type='approve', state="'approved'", ref='p4r-003', ts="'2027-01-01T00:00:00.000Z'",
           reason='a month later the reviewer approves using the reveal they made once'),
        'review_approve_requires_fresh_reveal')
refused('a granted reveal must pin the ciphertext it opened',
        ev(type='reveal', ref='p4r-001', purpose="'identity_check'", outcome="'granted'", blob='NULL',
           reason='the reveal was granted but no blob identity was recorded'),
        'CHECK constraint failed')
refused('a seal may not promise 180 days of retention',
        SEAL_INS.format(ref='p4r-003', run=RUN, ct='e' * 64).replace('120, 90,', '120, 180,'),
        'CHECK constraint failed')
refused('a seal may not outlive 90 days even with retention_days = 90',
        SEAL_INS.format(ref='p4r-003', run=RUN, ct='f' * 64).replace(
            "strftime('%Y-%m-%dT%H:%M:%fZ','now', '+90 days')",
            "strftime('%Y-%m-%dT%H:%M:%fZ','now', '+120 days')"),
        'CHECK constraint failed')
refused('retention_days cannot be pushed past the policy ceiling',
        "UPDATE crm_drive_review_seal SET retention_days = 180 WHERE case_ref='p4r-001';",
        'CHECK constraint failed')
avail = rows('SELECT case_ref, availability FROM crm_review_seal_availability ORDER BY case_ref')
check('the availability view reports the two sealed cases and the unsealed one',
      [r['availability'] for r in avail] == ['available', 'available', 'missing'], json.dumps(avail))
check('no plaintext column is reachable through the availability view',
      all(set(r) <= {'case_ref', 'availability', 'expires_at', 'age_minutes'} for r in avail),
      json.dumps(avail))
cols = [c['name'] for c in rows('PRAGMA table_info(crm_review_ci_summary)')]
check('the CI summary view exposes only counts and chain hashes',
      not [c for c in cols if c in ('reviewer', 'signal_digest', 'drive_file_id', 'session_hash',
                                    'reason', 'crm_contact_id')], ','.join(cols))

# --------------------------------------------------- 4) the ledger cannot be edited, erased or rewound
print('=== 4) the ledger cannot be edited, erased or rewound ===')
eid = rows('SELECT MIN(id) AS id FROM crm_drive_review_event')[0]['id']
for label, sql, frag in [
    ('rewrite a recorded reason', f"UPDATE crm_drive_review_event SET reason='the reviewer never wrote this' WHERE id={eid}", 'review_events_are_append_only'),
    ('swap the decision owner', f"UPDATE crm_drive_review_event SET reviewer='someone.else' WHERE id={eid}", 'review_events_are_append_only'),
    ('back-date the timestamp', f"UPDATE crm_drive_review_event SET occurred_at='2019-01-01T00:00:00.000Z' WHERE id={eid}", 'review_events_are_append_only'),
    ('erase one event', f"DELETE FROM crm_drive_review_event WHERE id={eid}", 'review_events_are_append_only'),
    ('erase the whole ledger', 'DELETE FROM crm_drive_review_event', 'review_events_are_append_only'),
    ('rewrite a checkpoint', 'UPDATE crm_drive_review_chain_anchor SET event_count=99', 'review_anchors_are_append_only'),
    ('erase the anchor history', 'DELETE FROM crm_drive_review_chain_anchor', 'review_anchors_are_append_only'),
    ('erase the chain head', f"DELETE FROM crm_drive_review_chain_head WHERE run_key='{RUN}'", 'review_chain_head_required'),
]:
    refused(label, sql + ';', frag)
check('the ledger is intact after eight erase attempts', rows('SELECT COUNT(*) AS c FROM crm_drive_review_event')[0]['c'] == 7)
allowed('the head checkpoint stays rewritable (mutable by design)', f"UPDATE crm_drive_review_chain_head SET event_count=0 WHERE run_key='{RUN}';")
allowed('rewinding the head hash too (full rollback attempt)', f"UPDATE crm_drive_review_chain_head SET head_sha256 = (SELECT MIN(event_sha256) FROM crm_drive_review_event), event_count = 0 WHERE run_key='{RUN}';")
refused('appending after a rewind is refused', ev(type='note', ref='p4r-001',
      reason='trying to restart the ledger from an older checkpoint'), 'SQLITE_CONSTRAINT')
integ = rows('SELECT * FROM crm_review_chain_integrity')[0]
check('the integrity view flags what a rewind did (density vs head)',
      integ['events'] == 7 and (integ['events'] != integ['head_event_count'] or integ['broken_links'] > 0),
      json.dumps(integ))
check('every event keeps its own trigger anchor (genesis rows are not counted by the view)',
      integ['anchors'] == integ['events'], json.dumps(integ))
check('the genesis checkpoint is still there as well',
      rows("SELECT COUNT(*) AS c FROM crm_drive_review_chain_anchor WHERE anchor_source='genesis'")[0]['c'] == 1)

# ---------------------------------------------- 5) tampering after removing the guards is DETECTED
print('=== 5) tampering after removing the guard triggers is DETECTED ===')
allowed('drop the immutability triggers (privileged raw write)',
        'DROP TRIGGER IF EXISTS trg_review_event_no_update; DROP TRIGGER IF EXISTS trg_review_event_no_delete;')
refused('the anchors still protect themselves', 'DELETE FROM crm_drive_review_chain_anchor;',
        'review_anchors_are_append_only')
allowed('edit a decision with the guard gone', f"UPDATE crm_drive_review_event SET reviewer='intruder' WHERE id={eid};")
integ2 = rows('SELECT * FROM crm_review_chain_integrity')[0]
check('the verification view detects the forged edit',
      integ2['broken_links'] > 0 or integ2['anchor_mismatches'] > 0, json.dumps(integ2))
st = rows('SELECT case_ref, current_decision, decided_by FROM crm_review_case_state ORDER BY case_ref')
check('the derived state view still answers the reviewer',
      len(st) == 3 and st[0]['current_decision'] == 'approve' and st[1]['current_decision'] == 'defer',
      json.dumps(st, ensure_ascii=False))

# ----------------------------------------------------- 5b) seal lifecycle: revoke now, sweep later
print('=== 5b) seal lifecycle: a live seal cannot be destroyed, an expired one can ===')
allowed('the operator repairs the head checkpoint to the true tip',
        "UPDATE crm_drive_review_chain_head SET event_count = (SELECT MAX(event_seq) FROM crm_drive_review_event),"
        " head_sha256 = (SELECT event_sha256 FROM crm_drive_review_event"
        " WHERE event_seq = (SELECT MAX(event_seq) FROM crm_drive_review_event)) WHERE run_key='%s';" % RUN)
refused('a live seal cannot be deleted', "DELETE FROM crm_drive_review_seal WHERE case_ref='p4r-002';",
        'review_seal_delete_before_expiry')
allowed('a seal may be re-keyed in place (rotation is allowed by design)',
        "UPDATE crm_drive_review_seal SET key_version = 2 WHERE case_ref='p4r-002';")
allowed('mark a seal revoked (the only way to end availability early)',
        f"UPDATE crm_drive_review_seal SET revoked_at = {TS} WHERE case_ref='p4r-002';")
avail2 = rows("SELECT availability FROM crm_review_seal_availability WHERE case_ref='p4r-002'")[0]
check('the availability view flips to revoked', avail2['availability'] == 'revoked', json.dumps(avail2))
allowed('a revoked seal may be swept away', "DELETE FROM crm_drive_review_seal WHERE case_ref='p4r-002';")
after_sweep = rows("SELECT COUNT(*) AS c FROM crm_drive_review_event WHERE case_ref='p4r-002'")[0]['c']
check('sweeping the blob leaves the decision ledger untouched', after_sweep == 3, str(after_sweep))
state_after = rows("SELECT seal_state FROM crm_drive_review_case WHERE case_ref='p4r-002'")[0]
check('the case row notices its seal is gone (seal_state = unavailable)',
      state_after['seal_state'] == 'unavailable', json.dumps(state_after))
refused('and after that sweep, approving this case is unreachable again',
        ev(type='approve', state="'approved'", ref='p4r-002',
           reason='approve after the blob was swept, with only a stale reveal on record'),
        ('review_approve_requires_fresh_reveal', 'review_approve_requires_phone_backed_basis'))
# D1 reports only the first-firing trigger, and for two simultaneous barriers that order is not
# contractual — so the rehearsal accepts either, while CI's audit predicate below counts both.

# ------------------------------------------------------------------ 6) idempotency of re-applying
print('=== 6) idempotency ===')
before = rows('SELECT (SELECT COUNT(*) FROM crm_drive_review_case) AS c, (SELECT COUNT(*) FROM crm_drive_review_event) AS e')[0]
out3 = subprocess.run(WRANGLER + ['d1', 'execute', DB, '--local', '--config', CFG, '--persist-to', STATE,
                                   '--file', os.path.join(SCRATCH, 'migrations',
                                                          '0009_crm_drive_review_workflow.sql')],
                      capture_output=True, text=True, cwd=SCRATCH, env=ENV).stdout
check('re-running the whole file succeeds (everything is IF NOT EXISTS)', 'executed successfully' in out3, out3[-200:])
after2 = rows('SELECT (SELECT COUNT(*) FROM crm_drive_review_case) AS c, (SELECT COUNT(*) FROM crm_drive_review_event) AS e')[0]
check('rows unchanged on re-apply', before == after2, f'{before} -> {after2}')
restored = rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_review%'")[0]['n']
check('re-applying restores the triggers an attacker dropped (self-healing)', restored == 18, str(restored))
out2 = subprocess.run(WRANGLER + ['d1', 'migrations', 'apply', DB, '--local', '--config', CFG,
                                  '--persist-to', STATE],
                      capture_output=True, text=True, cwd=SCRATCH, env=ENV).stdout
check('wrangler reports no pending migrations afterwards', 'No migrations to apply' in out2, out2[-160:])
migs = rows('SELECT COUNT(*) AS n FROM d1_migrations')[0]['n']
check('d1_migrations recorded exactly the two rehearsal files', migs == 2, str(migs))

ok = sum(1 for r in results if r)
print(f'\nD1_REHEARSAL {ok}/{len(results)} checks passed')
print(f'engine=Cloudflare D1 (wrangler --local) scratch={SCRATCH} remote_databases_touched=none')
if not os.environ.get('KEEP'):
    shutil.rmtree(SCRATCH, ignore_errors=True)
raise SystemExit(0 if ok == len(results) else 1)
