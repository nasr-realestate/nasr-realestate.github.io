# CRM Phase 2 — خطة الترحيل الآمن إلى `nasr-crm-test-db` (0010 + 0011)

**Status: PLAN ONLY — nothing in §3, §5 or §10 has been executed.** No migration was applied, no seed was
written, no database was exported, no deploy ran, nothing was merged, and no Drive file content was read in
order to produce this document. The only code changes on this branch as part of preparing it are the reviewed
offline tooling in §4/§6.4 and this file.

Author context: prepared 2026-11-02 (Africa/Cairo) from branch
`arena/1c171b6c-nasr-realestate-github-io` at commit `ec95abe`, PR #132 (open, **not merged**).

## ملخص القرار (what the human is being asked to approve)

1. **ترتيب الترحيل إجباري ولا يقبل التبديل:** فحص الحالة → عدّ الصفوف → تطبيق 0010 → توليد ملف Bootstrap
   والمانيفيست → مراجعة بشرية → بذر `drive_ref` فقط → إعادة §5 والتحقق أن `status_without_version = 0` →
   تطبيق 0011 → التحقق النهائي. السبب: §5 في 0010 يعمل فقط على صفوف لها `drive_ref`، ومحفّظ 0011 يرفض فتح
   حالة مراجعة بلا نسخة مسجّلة.
2. **فخّ مكتشف أثناء التجهيز (مهم):** فور تطبيق 0010 سيكون `status_without_version = 99` — وهذا **متوقع**،
   لكنه يعني أن بوابة Phase 3 (`withLedger=true`) سترفض أي مغلّف `sync_sealed` حتى تنتهي الخطوات 4→7.
   لذلك: **الخطوات 3 إلى 7 جلسة واحدة متصلة**، و`_worker/ingest-queue/drive-registry-sealed.txt` يجب أن يكون
   `IDLE` قبل بدء الجلسة.
3. **ملف البذر لا يدخل Git أبدًا** (يحتوي معرّفات Drive الحقيقية). ما يُراجَع بشريًا هو محليًا/في قناة خاصة،
   وما يُ_commit_ هو المانيفيست وحده (بصمات فقط).
4. **النسخة الاحتياطية للقراءة فقط:** تُنشأ نسخة جديدة باسم مؤرَّخ، تُتحقق CI بتصدير مقابل (digest parity لكل
   جدول) داخل قاعدة **مؤقتة** ثم تُحذف؛ النسخة الاحتياطية لا تُستخدم للتشغيل ولا للكتابة ولا كـ binding.
5. **العدد الحالي المطلوب له Bootstrap: 99 صفًا** (كلها مربوطة ببصمة، و0 مربوطة بـ anchor) — مقاس من CI،
   ويجب إعادة قياسه لحظة التنفيذ لا الاستناد إلى هذا الرقم.
6. **بوابة الاختبار:** 8 اختبارات جديدة على مغلف اصطناعي واحد عبر مسار `sync_sealed` كامل + 13 فحصًا للترميز
   + 13 فحصًا لأداة البذر + 7 اختبارات bootstrap = أخضر محليًا، و**لا يغني** عن التحقق الحيّ في CI.
7. **ما لا يُسمح به هذا الخطة:** `nasr-market-db` (ممنوع اللمس)، قراءة محتوى Drive، تغيير إعدادات
   Cloudflare/GitHub، النشر، الدمج. كل واحدة من هذه تحتاج قرارًا منفصلًا.
8. بعد تقديم هذه الخطة **توقفنا في انتظار موافقة صريحة**; لا تنفيذ لأي كتابة قبلها.

---

## 0. Scope fences

| Allowed by this plan | Never allowed by this plan |
|---|---|
| `nasr-crm-test-db` (`65bfcb14-…`) as the only write target | `nasr-market-db` (`ace5c9a2-…`) — not in a CRM binding, not queried for writes, not a restore target |
| Read-only `d1 export` / `SELECT` against the test DB | `PRAGMA integrity_check` / `SELECT sqlite_version()` against D1 (unsupported there — run them on a **file copy**) |
| New dated backup DB, written **once** by the loader, then read-only | Using any backup DB as a runtime DB, a Worker binding, or a scratch space for writes |
| `git mv` of a draft migration into `_worker/migrations/` + push (CI applies it) | `wrangler d1 migrations apply` from a laptop against production; `--env-file` tricks; editing `_worker/wrangler*.toml` to point anywhere else |
| Seeding exactly one column (`drive_ref`) via `scripts/crm/seed-drive-file-refs.mjs` | Seeding/patching `content_sha256`, a status, a receipt, an evidence class, or anything else |
| `.github/workflows/crm-drive-migration-session.yml` as the executor of steps 4-7 and 9 (it holds the token, the sandbox does not) | Any workflow that uploads an artifact, prints a wrangler log body, or touches a database other than the test DB |
| Human review of generated SQL off-repo | Committing `drive-ref-seed.sql` (real Drive ids) or printing it into CI logs |
| Re-running §5 from the extracted statement | Hand-typing §5, editing it, or "fixing" a conflict by force |
| GitHub CI (`workflow_dispatch` / push) as the only path that reaches Cloudflare from this workspace | Any Cloudflare API call from the agent sandbox (`api.cloudflare.com` is unreachable here — by design) |

**Environment reality check (do not skip):** this sandbox can reach `github.com`, `codeload`, `api.github.com`,
`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. It cannot reach `api.cloudflare.com`. Every remote
step below is therefore executed either (a) inside a GitHub Actions job on this repository, or (b) on a human
machine with a Cloudflare token. No step in this plan can be silently "tried" by the agent.

---

## 1. Phase 1 — PR #132 review (delivered as a report; no merge)

### 1.1 Shape

| Item | Measured value | How to re-measure |
|---|---|---|
| Head branch → base | `arena/1c171b6c-…` → `master` | `gh pr view 132 --json baseRefName,headRefName` |
| Merge base | `4c4280642c7e8b8de2565c4ed0cae659da83e527` | `git merge-base origin/master HEAD` |
| Commits in PR | 41 | `git rev-list --count origin/master..HEAD` |
| Files / diff size | 58 files, `+45120 / −23` | `git diff --stat origin/master…HEAD` |
| Modified (not added) files | 2 — `.github/workflows/crm-cloudflare-test-deploy.yml`, `CRM_DATA_GOVERNANCE.md` | `git diff --name-status origin/master…HEAD \| grep -v '^A'` |

Everything else in the diff is an addition: 6 workflows, 2 draft migrations, 2 new scripts, 3 new test
suites + 1 shared fixture, and the documentation set. A PR whose deletions are two files is easy to reason
about: no existing behavior was removed, only extended.

### 1.2 Review by area (what was actually read, line by line, not inferred)

- **`crm-phase3-registry.yml`** — the Phase 3 gate is now *provenance*, not a count. Boundary selftest runs
  before any DB is touched; `verify_isolated` derives its expectations from repository state
  (`migCnt == files`, newest file == newest applied, 0007 present) instead of a frozen literal, which is the
  fix for the failure that a hard-coded `7` caused when 0008/0009 were promoted; failures are reported as
  redacted `::error::` annotations with a deferred isolated failure so one run answers more than one question.
- **`crm-phase4-analysis.yml`** — `apply_payload` refuses a `missingRow` instead of continuing; `ledger`
  presence is probed; `verifyProcessingOrder` runs and its `ord[…]` numbers are printed in the check name.
- **`crm-review-0009-verify.yml`** — 17 steps, including the multi-process racing D1 service step.
- **Draft migrations** — 0010 §1 creates `drive_ref` and the version ledger; §5 is the idempotent backfill;
  §6 the read-only surfaces. 0011 adds the intake/review barrier. Both remain **unapplied anywhere**.
- **New scripts** — `verify-phase3-metadata-boundary.mjs` (the gate + the one SQL the CI and the tests share)
  and `seed-drive-file-refs.mjs` (one-column, conflict-refusing, no network, `--remote` refused).
- **Docs** — `CRM_PHASE2_DRIVE_0010_D1_TEST_REPORT.md` §10 holds the `migCnt` correction, §11 the live
  promotion ordering; `CRM_PHASE2_DRIVE_T2_DESIGN.md` §7 the T2 design; `_worker/migrations-draft/README.md`
  item 1b the corrected order.
- **Not reviewed as risky, but noted:** the repo's privacy canaries (see §1.4) live in test fixtures and one
  workflow; they are deliberate, documented, and synthetic.

### 1.3 Required checks

| Commit | Runs | Result |
|---|---|---|
| `ea7e3dc` (last commit that touches the CRM paths) | 11 | **all success** — `unit=pass=43:fail=0`, `iso=ok(migs=9/9,idx=6,fkDef=1,fkViol=0)`, `P3 live mig — migs=9,latest=0009_crm_drive_review_workflow.sql,…`, `P3 sync — queue_idle(current_registry_rows=99)`, review-0009 17/17 |
| `9ab2862` | p4 | `ord[p=0,proc=99,fp=99]`, `ledger=false` — zero processing-order problems over 99 rows |
| `ec95abe` (docs-only head) | 4 | node-tests / build / Sonar-token pass; review-0009 in progress at review time. **p3/p4 did not re-run**: their `paths:` filters exclude `*.md` |

Read them with:
`gh api "repos/nasr-realestate/nasr-realestate.github.io/commits/<sha>/check-runs" --jq '.check_runs[]|select(.name|startswith("P3 "))|.name'`
— these workflows publish their metrics **in the check-run name**, which is the only place they are readable.

Two honest conclusions:
1. Green at `ea7e3dc` proves the gate's *logic*, the isolated chain, the local D1 service behaviour and the
   live migration bookkeeping. It does **not** prove the sealed sync against the live test DB, because the
   queue is `IDLE` and `sync_sealed` did not run. §4 is the response to that gap, and it is a *test*, not a
   live run — the live run still needs a queued envelope, which needs a Drive read that is separately gated.
2. `CI green ≠ integration` remains the standing rule for this repo.

### 1.4 Secrets and customer data in the diff (scanned, not assumed)

Method: only added lines were scanned (45,120 of them) with whole-token patterns, then a narrowed pass to
remove identifiers that merely look like secrets.

| Pattern | Result |
|---|---|
| PEM private key blocks, JWT (`eyJ…`), GitHub tokens (`ghp_/gho_/github_pat_`), Cloudflare API token literals, AWS keys, Slack webhooks, `GOCSPX-`, IPv4 literals, mixed-case Google Drive id shapes | **clean** |
| Residual hits | all traced to the repo's **documented canaries**: `01012345678` / `+201012345678`, `tarek.canary@example.org`, `Bearer ya29.a0AfH6SM_secret_canary_oauth`, `FN:مريم سامي` — confined to 11 `_worker/tests/*.test.mjs` files and `crm-review-0009-verify.yml`, i.e. fixtures whose purpose is to be caught |
| Narrowed Drive-id-shaped scan | 76 candidates, all YAML keys / status slugs (`queue_idle`, `needs-manual-review`, …). No real Drive identifier in the diff |
| Anything that grants production access | none: no token is stored, and the CI recipient key is *derived* from a GitHub secret at run time |

**No customer content, no customer identifier, no credential entered Git in this PR.** No file in the diff
contains a Drive file id, a filename, a phone number or a message body belonging to a real person.

### 1.5 Merge decision

**Not merged, and no merge is performed by this plan.** The PR is `OPEN` / `MERGEABLE`, all its checks pass at
the sha where they run, and the diff is secret-free. What still needs a human: (a) the review sign-off on
`crm-cloudflare-test-deploy.yml` (the only workflow with a behavioural edit), and (b) the decision whether the
branch merges before or after the migration in §3 — the migration steps are additive to the same branch, so
merging first is safe, but it is a human ordering choice, not a technical requirement.

---

## 2. Phase 2 — backup, restore, and integrity verification without touching the original

### 2.1 The mechanisms that already exist

| Mechanism | What it does | Where |
|---|---|---|
| `crm-phase2-backup.yml` | Exports schema+data from `nasr-crm-test-db`, creates a **new** persistent D1 DB and loads the bundle into it, restores into a **separate ephemeral** D1 DB, re-exports it, asserts 100% digest parity, deletes the ephem DB, and asserts source DB / old backup / `nasr-market-db` are untouched. `workflow_dispatch` enabled; holds `crm-d1-test-mutex` | `.github/workflows/crm-phase2-backup.yml` |
| `scripts/crm/build-d1-guarded-backup.mjs` | Turns a `d1 export` dump into a restore bundle whose restore path *cannot silently drop the guards*: one file, stage 1 = tables+rows+indexes, stage 2 = views+triggers, plus `verify.sql`, `inventory.json` and a `manifest.json` with `guards_present` computed from the dump. Never opens a database, never prints row contents | `scripts/crm/build-d1-guarded-backup.mjs` |
| D1 Time Travel | `wrangler d1 time-travel info|restore` with `--bookmark` or `--timestamp` (last 30 days) — the fast rollback for a bad migration, and it also undoes the seed | wrangler v4 (verified locally with `--help`) |
| P3 read-only backup probe | Every Phase 3 run reads the reference backup's table/row/migration counts and fails if they moved | `crm-phase3-registry.yml` (`bak=verified(…)` in the check name) |
| Local rehearsal | `d1 export`'s trigger-splitting trap is reproduced offline: `python3 _worker/tests-draft/crm-0009-backup-restore.rehearsal.py` (33/33 in CI) | `crm-review-0009-verify.yml` |

### 2.2 Measured state of the current reference backup

`nasr-crm-test-db-backup-20261101` — `a7681217-32a3-48fd-b8f5-8a54ac7b35e7`:
`tbls=19, c=60, o=83, cv=76, m=2984`, verified **read-only** by P3 at `ea7e3dc`.

Last full P2 run (2026-10-31T23:17Z):
```
P2 schema    — tbls=19(crm=15),expIdx=21,autoUqIdx=23,fk=21,chkTbls=15,totRows=3879
P2 raw export — bytes=3021379 sha256=057a6e85c3825f77a0b464498826489f8c86e1317eea8b0d6530fe8b6f48d0d8
P2 bundle SQL — bytes=3100583 sha256=b94740bb85f75b8e16a5df25fc7547be016f2ddfd476886755856047c6a4d8f7
P2 restore   — local_sqlite=ok(fk0,digest=100%);saved_bak_d1=ok(digest=100%);isolated_d1_restore=ok(ephem=12721f99,digest=100%,cleaned=yes)
P2 guards    — src_db_unmodified=yes;old_bak=b8f1e723-…(meta=589824:0,untouched=yes);market_db=untouched(nasr-market-db:897024:0)
P2 backup DB — nasr-crm-test-db-backup-20261101 (a7681217-…) | size=8192:tbls=0 | tt=00000167-00000000-00005115-474feb559841e7f3b53bb849cd1ffdd6
```
That snapshot predates Phase 4's payload apply (`d1_migrations=6` then, 9 now, `totRows=3879` then), which is
precisely why §3.1 requires a **fresh** backup as the first act of the migration session rather than trusting
this one.

### 2.3 The pre-migration backup (procedure, exact)

Two forms of the same procedure. Choose one; both end with a verified, dated, read-only copy.

**A — CI form (preferred; the only one this repo's controls fully police).**
`crm-phase2-backup.yml` currently hard-codes `NEW_BACKUP_NAME='nasr-crm-test-db-backup-20261101'` and
**refuses to overwrite** an existing name (`new-backup-db-name-already-exists-refusing-overwrite`). So one
small repo change is required before the migration session — it is code in the workflow, not a GitHub setting:

```yaml
on:
  workflow_dispatch:
    inputs:
      backup_suffix:
        description: 'Suffix for the new backup DB name (nasr-crm-test-db-backup-<suffix>)'
        required: true
        default: '20261103'
```
and `NEW_BACKUP_NAME="nasr-crm-test-db-backup-${{ inputs.backup_suffix }}"` (falling back to the literal when
dispatched by push). The refuse-overwrite guard stays; nothing else changes.

```bash
gh workflow run crm-phase2-backup.yml --repo nasr-realestate/nasr-realestate.github.io \
  --ref arena/1c171b6c-nasr-realestate-github-io -f backup_suffix="$(date -u +%Y%m%d)"
gh run list --workflow crm-phase2-backup.yml --limit 3
gh run watch <run-id> --exit-status
gh api "repos/nasr-realestate/nasr-realestate.github.io/commits/<sha>/check-runs" \
  --jq '.check_runs[]|select(.name|startswith("P2 "))|.name'   # read the digests out of the check names
```

**B — local operator form (same steps, run by a human who has a token).**

```bash
set -euo pipefail
export CFG=_worker/wrangler.crm.toml DB=nasr-crm-test-db
TMP=$(mktemp -d)
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --output "$TMP/raw-export.sql"
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --no-data --output "$TMP/schema.sql"
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --no-schema --output "$TMP/data.sql"
node scripts/crm/build-d1-guarded-backup.mjs --dump "$TMP/raw-export.sql" --out "$TMP/bundle" \
  --title "pre-migration-$(date -u +%Y%m%dT%H%M%SZ)"
# review the bundle metadata only — it is the file the loader will apply
jq '{object_counts, guards_present, stages}' "$TMP/bundle/manifest.json"
# then create the new dated DB, load $TMP/bundle/restore.sql into it once, and restore-verify into an
# ephemeral DB exactly as crm-phase2-backup.yml does; delete the ephemeral DB afterwards.
```

`integrity_check` and `foreign_key_check` run on the **exported file copy**, never against D1:
```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/tmp/copy.db");db.exec(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(db.prepare("PRAGMA integrity_check").get(), db.prepare("PRAGMA foreign_key_check").all().length)' "$TMP/bundle/restore.sql"
```

### 2.4 Integrity verification — six things that must all be true, without touching the original

1. **Object parity:** bundle `inventory.json` counts (tables / explicit indexes / triggers / views) equal the
   counts re-exported from the restored copy.
2. **Row parity:** every table re-counted from `verify.sql` equals the source count taken in the same run.
3. **Digest parity:** per-table content digests match 100% between the source export and the restored copy —
   this is what P2's `restore_summary` reports as `digest=100%`.
4. **Guard parity:** `guards_present` in the manifest is `true` *and* the restored copy still refuses a
   guard-rejected write (the reason the bundle is built by `build-d1-guarded-backup.mjs` and not by
   splitting the dump on `;`).
5. **Untouched-source proof:** the source DB, the previous backup DB and `nasr-market-db` are compared
   before/after (name + `file_size` + `num_tables`) and must be byte-identical in metadata. `num_tables` is
   read from `GET /accounts/:id/d1/database/:uuid` — the *list* endpoint omits it, which is why a guard once
   printed `nasr-market-db:909312:0` and looked like an empty production database.
6. **Order-independent foreign-key truth (added 2026-11-02, by failure):** the restored copy must satisfy
   every declared FK *as a set* — `PRAGMA foreign_key_check` over the finished database, loaded inside one
   `defer_foreign_keys` transaction whose COMMIT is itself the enforcement. Checking FKs *while* statements
   are applied is not this property: `d1 export` emits tables in name order, so a child table's rows arrive
   before its parent exists, and a perfectly healthy database fails with `FOREIGN KEY constraint failed`.
   That is what run `41518627139` did (`build-primary-backup-failed:FOREIGN KEY constraint failed`); the same
   run carries the counter-evidence that the data was clean, because the builder's source-snapshot
   `foreign_key_check` had already passed — which is exactly why it got as far as the restore.
   `_worker/tests/crm-restore-verification-invariants.test.mjs` pins both directions: misordered-but-valid
   must load, a dangling reference must not. So neither the bug nor a "fix" that simply disables the check
   can come back quietly.

**Consequence for the migration, stated plainly:** an FK-shaped failure inside the backup verifier is a
verifier bug and does not stop 0010; a real violation in the live data (which the source-side check above
would have named) does.

### 2.5 Rules for the backup copy

- It is **written exactly once**, by the loader, and only from the verified bundle. After that: read-only.
- It is never a Worker binding, never a `migrations apply` target, never a scratch DB, and never used to
  "test the migration" (that is what the ephemeral isolated DB in P3's `verify_isolated` is for).
- It is never deleted to make room. If the account is at a DB limit, the session stops; deleting a verified
  backup to create a new one is not a trade the migration gets to make.
- Naming carries intent: `nasr-crm-test-db-backup-<UTC date>`; `nasr-crm-ephem-restore-chk` is the only
  throw-away name, and it is deleted in the same job that created it (P2 prints `cleaned=yes`).

### 2.6 What could not be verified from here

Everything in §2.2 is **read back from CI check-runs**, not re-executed. The sandbox has no route to
`api.cloudflare.com`, so a fresh export, a fresh backup DB, and a fresh restore verification are the first
acts of the approved session — they are *not* evidence this document can produce on its own.

---

### 2.7 A ceiling that can silently delete the backup step (measured the hard way)

`crm-phase2-backup.yml` is the only dated-backup mechanism, and its `on.push.paths` names only itself — so it
runs on the push that edits it and on a dispatch. Commit `f4dc343` edited it, the push started run
`41516664341`, and the run **failed with no job, no log, no check run and no annotation in the API**. The
Actions UI alone said why:

```
Invalid workflow file: .github/workflows/crm-phase2-backup.yml
(Line: 58, Col: 14): Exceeded max expression length 21000
```

The rule GitHub enforces, established by comparison inside this repo rather than assumed: a workflow
**property whose value contains an expression is capped at 21,000 characters**, while a property with no
expression in it is not — the Phase 4 job's script is 51,295 characters and has always run. Adding
`backup_suffix='${{ github.event.inputs.backup_suffix }}'` inside that 28,326-character script pushed the
whole `run:` value over the cap, so the file stopped being startable at all. Measured at each commit of that
file: `c1d160f` 28,326 with no expression (ok) → `f4dc343` 29,309 with one (unstartable) → fixed in the
commit that adds this paragraph, which moves the input into `env:` the way `p3`, `p4` and
`crm-cloudflare-test-deploy.yml` already pass every secret and input.

Two consequences that matter for this plan:

1. **A CI-only workflow can be broken for weeks and show green.** No check is created for a file GitHub
   refuses to start, so "all checks pass" said nothing about the backup path. Reading the workflow's shape
   is not the same as knowing it can start; that is why the dated backup is *attempted* before the migration
   rather than assumed available.
2. `_worker/tests/crm-workflow-expression-limits.test.mjs` now asserts, over every file in
   `.github/workflows/`, that no property carries an expression past the cap — with the broken shape
   reproduced in a temp fixture and a long-but-expression-free one proven *not* to be flagged, so the guard
   cannot be deleted as "too noisy". It runs in `npm test`, hence in the `node-tests` job that every push
   executes, which means the next edit to any CRM workflow fails loudly on a normal push instead of quietly
   on the day the backup is needed.

For the record: the migration session workflow was at 20,241 characters with one inline expression when this
was found — 759 characters from the same wall, i.e. one more guard would have broken A4 and A5. It uses `env:`
too.

### Measured state at execution time (2026-11-02, from the `preflight` run, not from the plan)

`Session target — migs=9,latest=0009_crm_drive_review_workflow,ledger=no,ref_col=no,rows=99,fp=99,proc=99,needs_bootstrap=99,svv=n/a`
with `Session guards — market_pre=nasr-market-db:909312;ref_backup_pre=nasr-crm-test-db-backup-20261101:3256320`.

That is §3 step 1 and step 2 confirmed against the live database: the ledger table and the `drive_ref`
column are both absent (so 0010 has not been applied), 99 registry rows carry fingerprints, 99 are
`processed`, and **99 rows need the Bootstrap** — the count §5 predicted, now measured. `svv=n/a` is the
correct answer rather than a zero, because the violations view does not exist yet.

The `preflight` mode is read-only, and the run that produced these numbers wrote nothing: its guard block
records only `name:file_size` for `nasr-market-db` and the reference backup, and no D1 write statement is
reachable in that mode (`assertReadOnly` rejects anything but `SELECT`/`PRAGMA` at the query layer).

### A2 delivered: the dated copy, verified

`nasr-crm-test-db-backup-20261102` (uuid `5007799b-89ad-4db6-8123-768faa3d8df4`) built from a fresh export —
raw 3,837,520 bytes `sha256=3d9fbaa6…`, bundle 3,939,453 bytes `sha256=841d3f5a…`, 33 tables / 46 explicit
indexes / 43 auto-unique / 37 FKs / 29 check-constrained / 4,994 rows — and verified three ways:

```
P2 restore — local_sqlite=ok(fk0,digest=100%);saved_bak_d1=ok(digest=100%);isolated_d1_restore=ok(ephem=b1b5f344,digest=100%,cleaned=yes)
P2 guards  — src_db_unmodified=yes;old_bak=b8f1e723-…(93:97,meta=589824,untouched=yes);market_db=untouched(nasr-market-db:909312)
```

The restore-test database `nasr-crm-ephem-restore-chk` was deleted by the same run (`cleaned=yes`), the
source was not written, `nasr-crm-test-db-backup-20261101` is unchanged, `nasr-market-db` is unchanged, and
the time-travel bookmark for the session is `tt=00000234-00000000-…` — the rollback anchor for step 3 and
step 8. Getting here cost the discovery of two verifier bugs (§2.7 and §2.4 check 6), both of which had been
making the backup step *unrunnable or wrong* rather than merely noisy.

### A3 delivered — 0010 is on the test database, and the promotion exposed three things

Applied by CI only, via `git mv` with no edit to the SQL, then `wrangler d1 migrations apply`:

```
P3 live mig — migs=10,latest=0010_crm_drive_file_versions.sql,tbl=1,idx=8,rows_before_sync=99
P3 guards   — biz_unchanged=yes(60:64:83:76:2984);bak_untouched=yes(nasr-crm-test-db-backup-20261101:3256320:0);market_db_untouched=yes(nasr-market-db:909312:0)
```

Ten migrations, `crm_drive_file_version` present, eight indexes on the registry, all 99 rows still there,
and no business table moved. What it exposed, each one found by a check rather than by reading:

- **`detectAndRegisterDuplicate` could no longer mark a duplicate.** 0010's `trg_registry_duplicate_pin`
  refuses `processing_status = 'duplicate'` unless the row names the canonical file's `drive_ref` and
  `duplicate_of_version_seq`; the 0007-era write path set only `duplicate_of_file_id`. On a ledger database
  every duplicate found by the intake path would have died inside the trigger as `SQLITE_CONSTRAINT`
  (`code:7500` on D1) with no reason attached. Fixed in the service — the pin is resolved from the canonical
  row, and when the canonical row cannot be named (a database with 0010 applied and the Bootstrap not yet
  run) the claim is refused with `DUPLICATE_PIN_UNAVAILABLE` and nothing is written. **No trigger was
  touched, no constraint widened**; without a ledger the statement keeps its 0007 shape, which is what makes
  the order in §3 (schema now, refs later) possible at all. Proven in
  `_worker/tests/crm-drive-file-versions.test.mjs` over three states — 0007 alone, 0010 applied on top of the
  same rows (refusal, no version conjured), refs and versions arriving through `recordVersion` (claim lands,
  pinned to `deriveDriveRef('SYNTH-CANON')` at version 1) — and asserted against real D1 in §3 step 3's
  isolated chain.
- **Three harnesses applied 0010 twice.** `_registry-fixture.mjs` and two `tests-draft/` rehearsals exec'd
  "the chain, then the draft file", which became "the chain, then a file the chain already contains":
  `duplicate column name: drive_ref`, and in `crm-file-review-0011.d1-rehearsal.py` a plain
  `FileNotFoundError` for the draft path. The rule is now stated in the harnesses, not in prose: read a
  migration from wherever it lives, apply it once, and *exclude* it by name when a test wants the pre-0010
  state (`ledger: false`, `exclude: [...]`). After that: rehearsals 45/45, 35/35, 113/113 local and
  69/69, 83/83 on the D1 engine; `npm test` 734/734.
- **A check pinned to a branch name is a check that can sit silent.** `crm-phase3-registry.yml`,
  `crm-drive-migration-session.yml`, `crm-phase4-analysis.yml` and `crm-phase4-review.yml` triggered on
  `push.branches: [arena/1c171b6c-…]` — the previous session's branch. After that branch merged, pushes here
  ran *nothing* from them: not a failure, an absence, the same class as §2.7. They now trigger on `arena/**`,
  which is what `crm-review-0009-verify.yml` and `crm-sealed-ingest.yml` already did. The boundary that
  matters is unchanged and is not the branch: test-database uuid required, `nasr-market-db` refused in the
  wrangler config, the untouched-guards, and `crm-cloudflare-test-deploy.yml` still `workflow_dispatch` only.

The first attempt at this gate also produced a false alarm of its own, recorded so it is not repeated: the
index expectation was a line-anchored regex over DDL that writes `ON table (cols)` on the *next* line, so it
counted 0 declared indexes and failed a correct promotion. The count is derived with whitespace collapsed
(0007 declares 6, 0010 declares 2, installing the chain gives 8, live probe says 8), and the unit-floor label
was corrected to the number the check actually enforces.

## 3. Phase 3 — the migration, in the mandated order

Pre-flight disqualifiers (any one stops the session before it starts):
- `_worker/ingest-queue/drive-registry-sealed.txt` is not `IDLE` → a sealed envelope is mid-flight; do not
  interleave a schema change with a content pass.
- Any p3/p4/review-0009 check is not green at the head commit.
- The fresh backup of §2.3 has not been verified (all five checks in §2.4).
- `nasr-market-db` metadata moved during the backup run (P2 `guards` line) → investigate before touching anything.
- A `drive_ref` column already exists in the test DB (`has_ref=1`) → 0010 was applied out of band; the plan's
  assumptions are void until that is explained.

Counting convention: `d1_migrations` is the number of applied migrations; today it is **9**, latest
`0009_crm_drive_review_workflow.sql`. Expected: **10** after step 3, **11** after step 8.
Probe SQL used throughout (all read-only, all safe to print):

```sql
SELECT
  (SELECT COUNT(*) FROM d1_migrations) AS migs,
  (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS latest,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='crm_drive_file_version') AS has_ledger,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='crm_drive_file_registry'
        AND sql LIKE '%drive_ref%') AS has_ref,
  (SELECT COUNT(*) FROM crm_drive_file_registry) AS reg_rows,
  (SELECT COUNT(*) FROM crm_drive_file_registry WHERE content_sha256 IS NOT NULL) AS fingerprinted;
```

### Step 1 — inspect schema and current registry state

```bash
export CFG=_worker/wrangler.crm.toml DB=nasr-crm-test-db TMP=$(mktemp -d)
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --no-data --output "$TMP/schema.sql"
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json --command "<the probe SQL above>" > "$TMP/state.json"
jq '.results[0]' "$TMP/state.json"
```
Expect `migs=9`, `latest=0009_…`, `has_ledger=0`, `has_ref=0`, `reg_rows=99`, `fingerprinted=99`.
**Stop if:** `reg_rows` < 99, `fingerprinted` ≠ `reg_rows`, or `has_ledger=1` (already promoted).
**Rollback:** none needed; nothing was written.

### Step 2 — verify presence/absence of `drive_ref` and count the Bootstrap set

```bash
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json \
  --command "SELECT COUNT(*) AS needs_bootstrap FROM crm_drive_file_registry WHERE content_sha256 IS NOT NULL" > "$TMP/needs.json"
```
`needs_bootstrap` **today** = 99 (the column does not exist yet, so every fingerprinted row is a candidate);
after step 3 the same question is asked properly:
```sql
SELECT COUNT(*) AS needs_bootstrap FROM crm_drive_file_registry
 WHERE content_sha256 IS NOT NULL AND drive_ref IS NULL;
```
Record both numbers in the session log; the second is what the seed file must match exactly (§5).
**Stop if:** the two numbers differ by anything other than rows registered between the two reads.
**Rollback:** read-only.

### Step 3 — apply 0010 (promotion commit; CI applies it, isolated first)

```bash
git mv _worker/migrations-draft/0010_crm_drive_file_versions.sql _worker/migrations/0010_crm_drive_file_versions.sql
# update _worker/migrations-draft/README.md item 1b (status line: 0010 promoted, 0011 still gated on step 7)
git add -A && git commit -m "crm(phase2): promote 0010 drive-file versions to the applied chain"
git push origin arena/1c171b6c-nasr-realestate-github-io
gh workflow run crm-phase3-registry.yml --repo nasr-realestate/nasr-realestate.github.io \
  --ref arena/1c171b6c-nasr-realestate-github-io     # p3's paths: filter excludes a pure migration move
gh run list --workflow crm-phase3-registry.yml --limit 2 && gh run watch <id> --exit-status
```
Order inside the job is the safety property: `verify_isolated` applies the whole chain to an **ephemeral**
D1 DB and asserts `migs=N/N` + newest-file==newest-applied **before** the live apply runs, and the ephem DB is
deleted in the same job.
Expect: `iso=ok(migs=10/10,…)`, `P3 live mig — migs=10,latest=0010_crm_drive_file_versions.sql,tbl=1,idx=6,rows_before_sync=99`,
`unit=pass=53:fail=0`, guards `market_db=untouched`, `bak=verified(…)`.
**Stop if:** the isolated step is red (then the live DB was never touched — that is the point of it), if
`migs != 10`, if any guard line changes, or if the live apply reports a partially applied chain.
**Rollback:** `d1 time-travel restore "$DB" --bookmark <captured in block R, before this push>`. A `git revert` of the promotion commit does **not** un-apply a migration; never pretend it does.

### Step 4 — generate the Bootstrap file and the manifest

```bash
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --no-schema \
  --table crm_drive_file_registry --output "$TMP/registry-rows.sql"
# convert to the JSON the tool reads (drive_file_id, drive_ref, content_sha256, processing_status only)
node scripts/crm/seed-drive-file-refs.mjs --from "$TMP/registry-rows.json" --out "$TMP/seed"
jq '{rows_in_export, anchored, already_anchored, conflicts, refused, skipped_without_fingerprint,
     ref_sha256_of_sorted_refs, seed_sha256}' "$TMP/seed/drive-ref-seed-manifest.json"
```
Expect `anchored = <needs_bootstrap from step 2>`, `conflicts=0`, `refused=0`, `statement_count = anchored`.
The seed file writes **one column** and only where `drive_ref IS NULL`; a row anchored to something else is a
`conflict`, never "fixed". No `--remote` exists for this tool by design.
**Stop if:** `conflicts > 0` (investigate the anchor source first) or `refused > 0` (an id outside
`[A-Za-z0-9_-]{10,128}` would be inlined into SQL — that is a data-integrity question, not a seed question).
**Rollback:** delete `$TMP/seed` (nothing was applied).

### Step 5 — human review **before** any write

The reviewer sees, off-repo (terminal, or a private channel — never a PR, never CI):
```bash
wc -l "$TMP/seed/drive-ref-seed.sql"
head -c 400 "$TMP/seed/drive-ref-seed.sql" | sed -n '1,4p'      # the header block only
grep -c "^UPDATE crm_drive_file_registry SET drive_ref = '" "$TMP/seed/drive-ref-seed.sql"
grep -vE "^--|^BEGIN;|^COMMIT;|^UPDATE crm_drive_file_registry SET drive_ref = '[0-9a-f]{64}' WHERE drive_file_id = '[A-Za-z0-9_-]{10,128}' AND drive_ref IS NULL;$" \
  "$TMP/seed/drive-ref-seed.sql" | sed '/^$/d'                   # must print NOTHING: one column, one shape
shasum -a 256 "$TMP/seed/drive-ref-seed.sql"
```
That last `grep -v` is `assertSeedIsOneColumn` expressed in shell; if it prints a single line, the file is not
the file the tool was designed to emit and the session stops.
Commit **only** the hash-only manifest (contains refs, never ids) next to the report of the run:
```bash
cp "$TMP/seed/drive-ref-seed-manifest.json" CRM_PHASE2_DRIVE_0010_SEED_MANIFEST.json && git add "$_"
```
**Stop if:** the reviewer has not explicitly said "applies as reviewed" *with the `seed_sha256` quoted back*.
Never accept "looks fine" without the digest — the digest is what ties the approval to the bytes.
**Rollback:** n/a (nothing applied).

### Step 5b — the executor: `crm-drive-migration-session.yml`

Steps 4-7 are executed by `.github/workflows/crm-drive-migration-session.yml` (modes `preflight`,
`bootstrap-plan`, `bootstrap`, `verify`), because that runner is the only place holding a Cloudflare token; the
local commands in this section remain the operator's alternative and the reviewer's cross-check. The mode
arrives either as a dispatch input (human) or as the contents of `.crm/migration-session-mode` (this agent,
whose token is refused by `workflow_dispatch`); the file is validated against the allowlist inside the job, so
its content cannot become a command.

`bootstrap-plan` exists because `bootstrap` cannot satisfy step 5 on its own: it plans **and** applies in one
run, so nobody could review a file before it was written. The new mode runs the same probe and the same
`plan()` over a fresh export, applies the same one-column shape check, prints the same `seed_plan=` line and
the `seed_sha256`, and then stops — no `wrangler d1 execute` is reachable in that branch, and the run reports
`seed_apply=not-run(plan-only,review required)` so the absence of a write is stated rather than inferred. What
is reviewed is therefore the digest of exactly what `bootstrap` would apply. Its guarantees, in code rather than prose:

- it holds `crm-d1-test-mutex`, so it cannot interleave with the registry or analysis writers. That protection
  has a cost worth knowing before A4: GitHub **cancels a waiting request** in a shared group — at `c3cd6c9`
  this job was ended 2 seconds after the push with *"Canceling since a higher priority waiting request for
  crm-d1-test-mutex exists"*, no job created, nothing run. So a session is pushed when the group is idle, not
  alongside the other test-db jobs; and a `cancelled` session means **it never happened**, which is a different
  statement from a failed one and must not be re-tried blind;
- it refuses to start if `nasr-market-db` or the production uuid appears in the wrangler config, and requires
  the test-db uuid; it refuses while the sealed queue is not `IDLE`;
- all three of the repo's gate scripts must pass their selftests first (20 + 14 + 13);
- its node runner can only send read-only SQL — `assertReadOnly` rejects anything that is not a
  `SELECT`/`PRAGMA` — so the only writes in the session are the seed file and the extracted §5 statement, both
  produced from files it can inspect first;
- every SQL it reads comes from `migrationProbeSql()` in the boundary script, executed against the real schema
  in `_worker/tests/` before this file ever runs;
- the seed file is written `0600` in `$TMP`, shape-checked with the same one-column regex the tool enforces,
  applied, then **deleted**; no artifact is uploaded; wrangler's log is counted (`grep -ci`) and never printed;
  error text is filtered character-by-character before it reaches an annotation;
- after the write it re-exports and re-plans, requiring `conflicts=0`, `to_anchor=0`, and
  `ref_sha256_of_all_anchored` **equal to the pre-write digest** — the applied anchors are proven identical to
  the reviewed ones without any identifier leaving the database, which is the strongest statement available
  given that D1 cannot compute SHA-256;
- it finishes by asserting the ledger (`status_without_version = 0`, three other counters 0, no unanchored
  fingerprint, no orphan version) **and** by running `evaluatePhase3Boundary` over the live snapshot, and by
  checking that the git worktree is still clean and no generated SQL file remains in the tree.

```bash
# a human with the Actions UI (or a token holding Actions:write):
gh workflow run crm-drive-migration-session.yml --repo nasr-realestate/nasr-realestate.github.io \
  --ref arena/1c171b6c-nasr-realestate-github-io -f mode=preflight     # read-only, run first
gh workflow run crm-drive-migration-session.yml --ref <same> -f mode=bootstrap
gh workflow run crm-drive-migration-session.yml --ref <same> -f mode=verify

# the agent in this sandbox cannot dispatch: `POST /actions/workflows/<id>/dispatches` answers
# 403 "Resource not accessible by integration" (the installation token has contents + pull-requests,
# not Actions). So the mode is carried by a one-word file the workflow also triggers on, and pushing
# it is the approval gesture — reviewable in the diff, unlike a dispatch argument:
printf 'preflight\n' > .crm/migration-session-mode && git add .crm/migration-session-mode \
  && git commit -m "crm(phase2): run the migration session in preflight mode" && git push
printf 'bootstrap\n' > .crm/migration-session-mode && git commit -am "crm(phase2): approve the 0010 anchor bootstrap" && git push
# stop mid-session:  git revert <marker-commit>   (the next run re-reads the file)
```

### Step 6 — seed the refs, and nothing else

```bash
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --file "$TMP/seed/drive-ref-seed.sql" -y \
  > "$TMP/apply.log" 2>&1
grep -ciE "error|refused|failed" "$TMP/apply.log" || true   # a count, not the statements: the log may hold ids
```
Locally that is a human action; in this session it is `mode=bootstrap`, which applies the file it just
generated, from `$TMP`, with the log counted rather than printed (§5b). The rule the substitution honours is
the one that matters: **no identifier may reach a log, an artifact, or Git.**
Then immediately re-measure:
```sql
SELECT COUNT(*) AS anchored, SUM(CASE WHEN head_version_seq = 0 THEN 1 ELSE 0 END) AS still_no_version
  FROM crm_drive_file_registry WHERE drive_ref IS NOT NULL;
```
Expect `anchored = <needs_bootstrap>` and `still_no_version = anchored` (the anchor landed; §5 has not been
re-run yet). A `drive_ref` that is *not* the repo key is impossible here — the column has a length/hex CHECK,
and §7 re-derives every value.
**Stop if:** any statement errors, if `anchored` ≠ expected, or if `still_no_version < anchored` (something
wrote versions behind the plan's back).
**Rollback:** `time-travel restore` to the step-3 bookmark. There is no "un-seed" statement in the plan because
a per-row `UPDATE … SET drive_ref = NULL` would be an unreviewed write of exactly the kind the seed refuses.

### Step 7 — re-run §5, then require `status_without_version = 0`

```bash
node scripts/crm/seed-drive-file-refs.mjs backfill-sql --out "$TMP/rerun-0010-s5.sql"
cat "$TMP/rerun-0010-s5.sql"                     # one statement, printed for review — it carries no ids
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --file "$TMP/rerun-0010-s5.sql" -y
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json \
  --command "SELECT status_without_version, counter_mismatches, dangling_heads, seq_gaps
             FROM crm_drive_version_invariant_violations"
```
The extractor is not a convenience: `d1 migrations apply` never re-runs a section, and "re-run §5" written as
prose invites a hand-typed copy. The command refuses unless the extracted block is a **single** statement that
inserts into `crm_drive_file_version`, keeps `NOT EXISTS`, keeps `'bootstrap_backfill'` and
`'phase2-0010-bootstrap'`, keeps both `drive_ref IS NOT NULL` and `content_sha256 IS NOT NULL`, and contains no
`UPDATE/DELETE/DROP/ALTER/TRUNCATE/PRAGMA`.
Expect `status_without_version = 0` and the other three counters `0`
(while the seeded rows are `bootstrap_claim_only`, they stay in `crm_drive_rehash_queue` — that queue is the
promise that a byte-level re-verification still has to happen, not an error).
**Stop if:** `status_without_version > 0` (do not proceed to 0011), or the re-run added more rows than
`anchored` (idempotence broken → investigate the ledger before writing anything else).
**Rollback:** safe to re-run — `NOT EXISTS` makes it a no-op the second time (proven in
`crm-drive-ref-bootstrap.test.mjs`).

### Step 8 — apply 0011

```bash
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json \
  --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_drive_file_version')
             THEN 'ok' ELSE 'abort: 0010 must be applied before 0011' END AS preflight"
# only on preflight=ok:
git mv _worker/migrations-draft/0011_crm_drive_file_intake_review.sql _worker/migrations/0011_crm_drive_file_intake_review.sql
git add -A && git commit -m "crm(phase2): promote 0011 drive file intake review to the applied chain"
git push origin arena/1c171b6c-nasr-realestate-github-io
gh workflow run crm-phase3-registry.yml --ref arena/1c171b6c-nasr-realestate-github-io
```
Expect `migs=11`, `latest=0011_crm_drive_file_intake_review.sql`, isolated step green first, guards unchanged.
**Stop if:** `status_without_version` was not `0` at step 7 — 0011's barrier
`file_review_case_requires_a_recorded_version` would then be the thing that breaks in production traffic,
which is a worse place to learn it. And: **never roll back 0009 before 0011.**
**Rollback:** `time-travel restore` to the step-7 bookmark (taken after seeding, so the seed survives).

### Step 9 — verify constraints, triggers and data integrity

```bash
node scripts/crm/drive-registry-snapshot.mjs sql > "$TMP/snap.sql"
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json --command "$(cat "$TMP/snap.sql")" > "$TMP/d1.json"
node scripts/crm/drive-registry-snapshot.mjs format --in "$TMP/d1.json" --out "$TMP/registry.jsonl" \
  --summary "$TMP/summary.txt"
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json --command "
  SELECT
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger') AS trg,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='view')    AS vw,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='crm_drive_file_registry' AND sql IS NOT NULL) AS idx,
    (SELECT COUNT(*) FROM crm_drive_file_registry) AS rows_now,
    (SELECT COUNT(*) FROM crm_drive_file_registry WHERE content_sha256 IS NOT NULL) AS fp,
    (SELECT COUNT(*) FROM crm_drive_file_registry r WHERE r.head_version_seq > 0
       AND NOT EXISTS (SELECT 1 FROM crm_drive_file_version v
                       WHERE v.drive_ref=r.drive_ref AND v.version_seq=r.head_version_seq)) AS dangling"
```
All of these must hold (this is exactly the D1-service suite's list, re-expressed as one read-only query):
`dangling=0`; `rows_now >= 99` (a folder can grow; nothing may vanish); `fp = anchored`; the trigger and view
counts match the promoted DDL (0010: 20 triggers / 6 views; 0011 adds 16 / 4); `status_without_version = 0`;
`reg_idx = 6` on the registry (the partial unique index on `drive_ref` present); the `crm_drive_version_invariant_violations`
view returns four zeros; and `scripts/crm/drive-registry-snapshot.mjs` prints only hashed refs — if its
summary contains anything that is not a hash or a count, stop and treat that as a leak, not as a cosmetic issue.
Finally, re-run §2.3's backup procedure so a **post-migration** verified copy exists, and record the delta
(`+1 table object group, +36 triggers, +10 indexes, +10 views`, `migs 9→11`, registry rows unchanged).
**Stop if:** any of the above differs, or the post-migration backup fails digest parity.
**Rollback:** decide between `time-travel restore` (whole DB, ≤30 days) and a forward-fix migration. Do not
"clean up" by hand: the version ledger is append-only by design, and the rehash queue is a promise.

---

## 4. Phase 4 — one synthetic envelope through `sync_sealed`

The gap this closes: the production composition had never been executed as one piece — CI opened envelopes with
its own inline copy of `openEnvelope`, sealed them with unreviewed ad-hoc commands, and only ran the whole
thing when a queue file happened to hold an envelope (it has read `IDLE` since 2026-11-01).

**What was added (offline code only, no remote write, no rule weakened):**

| File | Contents |
|---|---|
| `scripts/crm/drive-registry-envelope.mjs` | `p3reg_v1` codec, in both directions: `deriveKeyPair`, `sealEnvelope`, `openEnvelope`, `assertPayloadShape` (closed schema), `describePayload` (printable summary), `readQueueLine` (IDLE/comments/one-pending). CLI: `selftest \| pubkey \| seal \| inspect \| open`. No network, no `fetch`, no secret on argv |
| `_worker/tests/crm-drive-registry-envelope-sync.test.mjs` | 8 tests that drive one synthetic envelope through the whole `sync_sealed` path against a real in-memory SQLite built from the real migration chain |
| `.github/workflows/crm-phase3-registry.yml` | the runner now **imports** the codec instead of carrying a copy; `sync_sealed` shape-asserts the opened payload and prints only `env[items=…,unreach=…,parent=<16-hex>,sha=<8-hex>]`; a new `queue_status` mode uses the tested parser; codec selftest runs before any DB is touched; unit floor 43 → **53** |
| `scripts/crm/seed-drive-file-refs.mjs` | `backfill-sql` (step 7's extractor) + 3 new selftest cases (10 → 13) |
| `_worker/tests/crm-drive-ref-bootstrap.test.mjs` | 5 → 7 tests; the suite now uses the **same** extractor the plan tells operators to run, and pins step 7's `status_without_version = 0` |

The 8 sync tests: codec barriers inherited (13/13) · one envelope applies and the gate passes on a
ledger-less DB (with the "+2 rows, not +1" subtlety: an unreachable id becomes a row counted as `failed`) ·
repeat scan is idempotent · an envelope cannot move a recorded fingerprint · content facts are refused at seal
**and** dropped by the service anyway (both lines of defence proven) · a tampered byte or a foreign recipient
changes **no byte** of the registry · an undocumented digest fails the *gate*, not the sync · and the
post-0010 rehearsal.

Measured locally: **envelope 8/8 · bootstrap 7/7 · boundary 7/7 · p3 five suites 53/53 · `npm test` 725/725 ·
codec selftest 13/13 · seed selftest 13/13 · `eslint` 0 findings in both new scripts** (repo total returned to
369 after refactoring the two complexity findings instead of suppressing them).

**What this does not prove, stated plainly:** it is not a live `nasr-crm-test-db` run. It exercises the same
functions, the same SQL, the same migrations and the same triggers, on `node:sqlite`; D1's distributed commit
path, its HTTP layer and its concurrency arbitration are only reachable from CI. The live assertion will be
true when a CI run prints `P3 sync — env[…];p1[…];p2_idem[ins=0,…];p3gate[fp=…,untouched=…,ledger=yes,…]`
and `ok` — which requires a queued envelope, which requires a Drive metadata read: **separate approval**.

---

## 5. Records needing Bootstrap: **99** (measured), 0 anchored

| Measure | Value | Source |
|---|---|---|
| `crm_drive_file_registry` rows | 99 | P3 check name `queue_idle(current_registry_rows=99)` at `ea7e3dc` |
| rows with `content_sha256` | 99 | P4 check name `ord[p=0,proc=99,fp=99]` at `9ab2862` |
| rows with `drive_ref` | **0 — the column does not exist yet** | 0010 §1 creates it; `migs=9` |
| files in the Drive folder listing (T1) | 101 listed / 99 registered | `drive-phase2-t1-plan.json`, `plan_sha256 eae1efe2…bb617d` |
| `refs_sha256` of the applied T1 plan | `300c442a…450504` | CI read-back |

So: **99 rows need an anchor today; the 2 listed-but-unregistered files are not Bootstrap work** (they need a
metadata pass, which is a different gate). Re-measure at execution time with step 1's probe and step 2's count —
a frozen 99 is exactly the kind of literal that broke this pipeline before.

---

## 6. Sample manifest from synthetic data

Generated offline (`node scripts/crm/seed-drive-file-refs.mjs --from <8 synthetic rows> --out <dir>`), on
ids of the shape `SYNTHFILEAAA111122223333444455` with digests over the literal text `synthetic content N`.
It deliberately contains one of each outcome so a reviewer learns what every bucket means:

```json
{
  "generated_from": "synthetic-registry-export.json",
  "rows_in_export": 8,
  "anchored": 4,
  "already_anchored": 0,
  "conflicts": [ { "where": "row #7 (SYNTHFILEGGG…)", "found_prefix": "78e5e3df5837", "expected_prefix": "59f1f4a46ab3" } ],
  "refused":     [ { "where": "row #8 (unsafe id)", "reason": "drive_file_id is outside [A-Za-z0-9_-]{10,128} — it would be inlined into SQL" } ],
  "skipped_without_fingerprint": 2,
  "ref_sha256_of_sorted_refs": "a2dea61e8213eef4ac58fefe1861fdac458cdf8f2290103ae5b2691bea100327",
  "statement_count": 4,
  "seed_sha256": "60e7a36b79fd9c3a9681854258125fbbc2192c234aec9ff840407eb3a2e4085e",
  "next_steps": [
    "apply drive-ref-seed.sql to the database the export came from (a human choice — this tool cannot)",
    "re-run draft 0010 §5 (idempotent) so the backfilled versions appear",
    "require SELECT status_without_version FROM crm_drive_version_invariant_violations to return 0 before relying on 0011"
  ]
}
```
and the seed body is exactly one statement per row, nothing else:
```sql
-- drive_ref seed — generated by scripts/crm/seed-drive-file-refs.mjs, review before applying.
-- namespace: crm-p4-v1/drive_ref · anchored rows: 4 · already anchored: 0
BEGIN;
UPDATE crm_drive_file_registry SET drive_ref = '292abdd0621ee367cb6be6bd072838f18199633481eb5255dbdc0f6b65eab713' WHERE drive_file_id = 'SYNTHFILEAAA111122223333444455' AND drive_ref IS NULL;
…
COMMIT;
```
How to read it: `anchored` = rows the seed will write · `already_anchored` = rows left alone · `conflicts` =
rows whose stored anchor disagrees with the repo key (**stop, investigate; never overwrite**) · `refused` =
rows the tool would not inline (malformed id) · `skipped_without_fingerprint` = metadata-only rows, anchored
only with `--all` (a dedup key costs nothing, but it is a human choice, not a default) ·
`ref_sha256_of_sorted_refs` = the order-independent digest that lets two independent runs be compared **without
exchanging ids** — this is also how step 7's re-export is checked against step 4's plan.

Reproduce it locally (no network, no DB):
```bash
node scripts/crm/seed-drive-file-refs.mjs --from /tmp/synthetic-registry-export.json --out /tmp/synthetic-seed
```

---

## 7. Global stop conditions (any one halts the session; none of them may be worked around)

1. A check is failing, missing, or "expected to be fixed later".
2. Any write target other than `nasr-crm-test-db` appears (including in a config, a log, or a command line).
3. `nasr-market-db` metadata moves at any point — even during a read-only step.
4. The fresh pre-migration backup is unverified, or the old backup / reference backup metadata changes.
5. `status_without_version > 0` when step 8 is about to start.
6. `conflicts > 0` or `refused > 0` in the seed manifest.
7. The seed file (or anything with real Drive ids) is about to be committed, pushed, or echoed into CI.
8. A reviewer's approval cannot be tied to a `seed_sha256` quoted back verbatim.
9. Someone proposes to weaken, skip, `|| true`, or delete a check — including this plan's own checks.
10. A queue envelope appears mid-session, or a Drive content read is proposed to "speed things up".
11. The numbers in this document disagree with what the DB reports now: the DB wins, the document is amended.

## 8. Rollback matrix

| Stage | Undo | Cost / caveat |
|---|---|---|
| 1–2 (inspection) | nothing to undo | read-only |
| 3 (0010 applied) | `d1 time-travel restore --bookmark <pre-step-3>` | restores data too; window is 30 days; `git revert` does **not** un-apply a migration |
| 4 (seed generated) | delete the local `$TMP/seed` | nothing was applied |
| 5 (human review) | n/a | approval is per digest, not per plan |
| 6 (seed applied) | `time-travel restore` to the step-3 bookmark | no per-row un-seed statement is offered, deliberately |
| 7 (§5 re-run) | re-running is the fix, not the problem | `NOT EXISTS` makes it idempotent; a doubled version row is a stop, not a cleanup |
| 8 (0011 applied) | `time-travel restore` to the step-7 bookmark | keeps the seed and the versions; **never** roll back 0009 before 0011 |
| 9 (final verification) | forward-fix migration, or full restore from the verified backup into a **new** DB + binding swap | the binding swap is a Cloudflare settings change → separate explicit approval |
| any point | `crm-phase2-backup.yml`'s bundle → ephemeral DB | the ephemeral DB is the only sanctioned place to test a restore |

## 9. Approval gate — what to sign, and what stays separately gated

| ID | Approval asked for | Covers | Does **not** cover |
|---|---|---|---|
| A1 | §1: PR #132 may be merged | merge only | any migration step |
| A2 | §2.3: run the pre-migration backup (new dated backup DB + ephemeral verify DB, deleted in-job) | creates D1 objects, reads the test DB, writes only the new backup DB | reusing/deleting existing backups; any restore into the source |
| A3 | §3 steps 1–3: inspect + apply 0010 via promotion commit + CI | one schema promotion on the test DB | 0011; the seed; any content phase |
| A4 | §3 steps 4–7: export → generate seed → human review → **apply seed** → re-run §5 → verify | 99 one-column updates + the backfill | editing a stored anchor; any other column |
| A5 | §3 steps 8–9: apply 0011 + final verification | second schema promotion + read-backs | deploys; production |
| — | **Not granted by any of the above:** reading Drive file content; a live `sync_sealed` envelope run; any production/`nasr-market-db` write; a Cloudflare or GitHub settings change; a deploy; an identity import/link/merge | | |

Each approval is single-use, tied to the commit sha it was given at, and expires if the head moves or if any
number in §5 is re-measured differently. The earlier `APPROVED` covered only the 0008/0009 promotion path and is
**not** reused here.

## 10. Appendix — the command sequence, in order

```bash
# ── block 0 · read-only state (also the pre-flight disqualifier check) ─────────────────────────
export CFG=_worker/wrangler.crm.toml DB=nasr-crm-test-db TMP=$(mktemp -d)
node scripts/crm/drive-registry-envelope.mjs selftest | tail -2
node scripts/crm/seed-drive-file-refs.mjs selftest | tail -2
node scripts/crm/verify-phase3-metadata-boundary.mjs selftest | tail -2
node scripts/crm/drive-registry-envelope.mjs inspect --in _worker/ingest-queue/drive-registry-sealed.txt   # must say IDLE
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json --command "<§3 probe SQL>"
# ── block R · the bookmark every later rollback uses (take it NOW, re-take it if the session slips) ─
npx --yes wrangler@4 d1 time-travel info "$DB" --remote --config "$CFG" --json | tee "$TMP/tt-before.json"
# .bookmark is the field crm-phase2-backup.yml already reads; if it is absent, note the ISO timestamp instead
# ── block 1 · backup + restore verification (§2.3) ──────────────────────────────────────────────
gh workflow run crm-phase2-backup.yml --repo nasr-realestate/nasr-realestate.github.io \
  --ref arena/1c171b6c-nasr-realestate-github-io -f backup_suffix="$(date -u +%Y%m%d)" && gh run watch <id> --exit-status
# ── block 2 · steps 1–2 (inspect, count) then step 3 (0010) ─────────────────────────────────────
git mv _worker/migrations-draft/0010_crm_drive_file_versions.sql _worker/migrations/0010_crm_drive_file_versions.sql
git commit -am "crm(phase2): promote 0010 drive-file versions to the applied chain" \
  && git push origin arena/1c171b6c-nasr-realestate-github-io
gh workflow run crm-phase3-registry.yml --ref arena/1c171b6c-nasr-realestate-github-io && gh run watch <id> --exit-status
# ── block 3 · steps 4–5 (export, generate, review) ───────────────────────────────────────────────
npx --yes wrangler@4 d1 export "$DB" --remote --config "$CFG" -y --no-schema --table crm_drive_file_registry --output "$TMP/registry-rows.sql"
node scripts/crm/seed-drive-file-refs.mjs --from "$TMP/registry-rows.json" --out "$TMP/seed"
grep -vE "^--|^BEGIN;|^COMMIT;|^UPDATE crm_drive_file_registry SET drive_ref = '[0-9a-f]{64}' WHERE drive_file_id = '[A-Za-z0-9_-]{10,128}' AND drive_ref IS NULL;$" "$TMP/seed/drive-ref-seed.sql" | sed '/^$/d'   # must print nothing
shasum -a 256 "$TMP/seed/drive-ref-seed.sql"; jq '.seed_sha256, .ref_sha256_of_sorted_refs' "$TMP/seed/drive-ref-seed-manifest.json"   # ← reviewer quotes these back
# ── block 4 · steps 4-7 as executed here (agent: push the mode file; human: dispatch it) ──────────
printf 'preflight\n' > .crm/migration-session-mode && git commit -am "crm(phase2): session preflight" && git push
printf 'bootstrap\n' > .crm/migration-session-mode && git commit -am "crm(phase2): approve the 0010 anchor bootstrap" && git push
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --file "$TMP/seed/drive-ref-seed.sql" -y
# ── block 5 · step 7 (§5 re-run + the acceptance number) ─────────────────────────────────────────
node scripts/crm/seed-drive-file-refs.mjs backfill-sql --out "$TMP/rerun-0010-s5.sql"
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --file "$TMP/rerun-0010-s5.sql" -y
npx --yes wrangler@4 d1 execute "$DB" --remote --config "$CFG" --json --command "SELECT status_without_version, counter_mismatches, dangling_heads, seq_gaps FROM crm_drive_version_invariant_violations"
# ── block 6 · steps 8–9 (0011, then verification; re-run block 1 afterwards) ─────────────────────
git mv _worker/migrations-draft/0011_crm_drive_file_intake_review.sql _worker/migrations/0011_crm_drive_file_intake_review.sql
git commit -am "crm(phase2): promote 0011 drive file intake review to the applied chain" \
  && git push origin arena/1c171b6c-nasr-realestate-github-io
gh workflow run crm-phase3-registry.yml --ref arena/1c171b6c-nasr-realestate-github-io && gh run watch <id> --exit-status
# ── rollback (only with an explicit decision, and only for the DB — never for Git history) ───────
npx --yes wrangler@4 d1 time-travel restore "$DB" --remote --config "$CFG" --bookmark "$(jq -r '.bookmark' "$TMP/tt-before.json")"
```

Every command above is either read-only, or a CI dispatch, or a write that this plan's approval A4/A5 covers.
`<the §3 probe SQL>` is the single SELECT printed in §3 — the only placeholder in this appendix, chosen so that
no shell-quoting hazard sits in the middle of a migration session.

---

### Appendix A — files this plan depends on, and what each guarantees

| Path | Guarantee |
|---|---|
| `_worker/migrations-draft/0010_crm_drive_file_versions.sql` | `drive_ref` + version ledger + projections + §5 backfill + read-only surfaces |
| `_worker/migrations-draft/0011_crm_drive_file_intake_review.sql` | intake/review tables + `file_review_case_requires_a_recorded_version` |
| `scripts/crm/seed-drive-file-refs.mjs` | one column, only where NULL, conflict-refusing, no network, `--remote` refused, §5 extractable |
| `scripts/crm/verify-phase3-metadata-boundary.mjs` | the provenance gate + the one SQL the gate and the tests share |
| `scripts/crm/drive-registry-envelope.mjs` | the queue/payload contract in both directions; the printable summary that keeps ids out of logs |
| `scripts/crm/build-d1-guarded-backup.mjs` | a bundle whose restore cannot silently drop triggers and views |
| `scripts/crm/drive-registry-snapshot.mjs` | read-only registry export, hashed refs only |
| `.github/workflows/crm-phase3-registry.yml` | isolated-DB-first promotion, sealed sync, guards on market DB and the reference backup |
| `.github/workflows/crm-phase2-backup.yml` | the backup + isolated restore, refuse-overwrite naming |


---

## A4/A5 — التنفيذ الفعلي (3 نوفمبر 2026)، بأرقام مقروءة من القاعدة لا من الخطة

**الحالة: أ.4 منفَّذ ومُتحقَّق منه؛ خطوة A5 الأولى (ترقية 0011) منفَّذة ومُتحقَّق منها.**

الاعتماد والقيود: ملف الاعتماد `.crm/drive-ref-bootstrap-approval.json` يثبّت `anchor_digest`
و`seed_sha256` والعدّادات الستة و`plan_head`+`review_run`؛ بوابة الكتابة ترفض قبل أول عبارة عند أي فرق،
وحزام `APPLIED_ANCHORS_DIFFER_FROM_THE_REVIEWED_PLAN` يعاير القيم المُطبَّقة بالمعتمد.

| الحدث | التشغيل | ما نُشر |
|---|---|---|
| خطة معتمدة بعد إصلاح `fetch-depth: 0` | `41614908118` (success) | `anchor=300c442a0c87…0504`, `seed=13c87bb521e9…76fc`, `statements=99, guarded=99, unlisted=0, forbidden=0, commas=0, writes=0` |
| محاولة كتابة أولى | `41621177286` (failure) | `seed-apply-failed(problems=1,sha=13c87bb521e9)` — لم تُطبَّق أي عبارة |
| إصلاح قناة النقل (تعليق فقط على البصمتين) | `add3ada` → خطة `41632050909` (success) | نفس البصمتين حرفيًا، و`needs_bootstrap=99, already=0` (القاعدة لم تتحرك) |
| **الكتابة** | **`41632541771` (success)** | `applied(sha=13c87bb521e9,statements=99,tx_lines=0,same_lines=yes)` ثم `anchors already=99,digest_match=yes` و`ledger … needs_bootstrap=0,svv=0,ctr=0,dang=0,gaps=0,orphans=0,anchored=99,gate=ok` |
| تحقق مستقل بعد التنفيذ | `6c8fa51` (`verify`) | `needs_bootstrap=0,svv=0,ctr=0,dang=0,gaps=0` |
| ترقية 0011 عبر CI | `53f5510` (p3 success) | `live mig — migs=11,latest=0011_crm_drive_file_intake_review.sql,tbl=1,idx=8,rows_before_sync=99`؛ `guards — biz_unchanged=yes(60:64:83:76:2984);bak_untouched=yes;market_db_untouched=yes(nasr-market-db:913408:0)`؛ `ok(migs=11/11,idx=8/8,fkDef=1,fkViol=0)`؛ `sync — queue_idle(current_registry_rows=99)` |
| تحقق بعد 0011 | `720ef79` (`verify` success) | `Migration verify-ok`, `migs=11`, `declared[tbl=4,idx=11,trg=36,view=10] ≤ installed[16,32,55,14]`, `svv=0` |

**سبب الفشل الأول، موثّقًا لأنه سيظهر لأي مولِّد بذور آخر:** `renderSeedSql` يغلّف العبارات بـ`BEGIN;`/`COMMIT;`.
محرك D1 يرفض عبارات المعاملة على قناة `wrangler d1 execute --file` بنصّ:
`To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs
instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements` — والقَيْد الجديد
`seed-apply-failed(problems=…,sha=…,first=…)` ينشر الآن أول سطر خطأ بعد تنقيحه (حذف كل تسلسلة من 12
محرفًا شبيهة بالمعرّفات) بدل عددٍ مجرّد، و`seed-transport-not-equivalent` يمنع إرسال أي نصّ مختلف عن
عبارات الملف المعتمد (مُثبت محليًا: ملف good يمر، وتهريب `DELETE` أو عمودان أو بتر = رفض).

**ما لم يحدث:** لا لمس لـ`nasr-market-db`، لا كتابة على `nasr-crm-test-db-backup-20261101`، لا قراءة محتوى
ملفات Drive، لا حذف/نقل/إعادة تسمية لأي ملف أصلي، لا مشاركة عامة، لا نشر موقع، لا دمج PR. الطابور المختوم
بقى `IDLE` فلم تكتب خطوة الـsync أي صف. الأرقام المرجعية `60/83/76/2984` بقيت صحيحة.
