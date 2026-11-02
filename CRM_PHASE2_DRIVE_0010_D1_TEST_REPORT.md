# Draft 0010 on the Cloudflare D1 engine — rehearsal report (nothing applied anywhere real)

Scope of this task, exactly: **run the already-written draft `0010_crm_drive_file_versions.sql` and its
contract against the database engine production actually uses**, in a throwaway local file, and report
what that engine does differently from `node:sqlite`. No migration was applied to any real database.
Nothing was written to `nasr-crm-test-db`; `nasr-market-db` and the reference backup were not touched.
No file content was read, no Drive call was made, no Worker or Pages deploy happened, PR #132 was not
merged, and no contact was imported, linked or merged.

Harness: `_worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py`
Engine: `wrangler 4.156.0` → `d1 migrations apply --local` / `d1 execute --local`, `--persist-to` a
temporary directory, `api.cloudflare.com` never contacted.
Result: **`D1_VERSIONS 69/69 checks held` · `ALL_BARRIERS_HELD_ON_D1` · exit 0.**

| what it does | file | result |
| --- | --- | --- |
| D1 engine rehearsal, 0010 (re-run after the §3.2 change described in §9) | `_worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py` | **69/69 held** |
| node:sqlite rehearsal, 0010 (same re-run) | `_worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs` | **45/45** `ALL_BARRIERS_HELD` — was 42; one check became four |
| `recordVersion()` service suite, in-process (`node:sqlite`, real migrations applied) | `_worker/tests/crm-drive-file-versions.test.mjs` | **19/19**, runs inside `npm test` |
| `recordVersion()` on the D1 engine — the same module, unmodified | `_worker/tests-draft/crm-drive-file-versions.d1-service.mjs` | **27/27** `SERVICE_ALL_BARRIERS_HELD_ON_D1`, 193 wrangler spawns, all `--local` |
| CI gate now running all four | `.github/workflows/crm-review-0009-verify.yml` | 16 steps |

---

## 1. Why a second harness was needed

The draft's first proof ran on `node:sqlite`, which is the same SQLite dialect but **not the same
environment**: D1 wraps the engine in an authorizer, exposes SQL only through `wrangler d1 execute`,
and runs migrations through wrangler's own runner (statement splitting, a `_cf_*_d1_migrations` counter,
per-file transaction behaviour). Every one of those is a place where "it works in node" could have been
wrong. Three of them turned out to matter, and the harness now measures rather than assumes:

* `PRAGMA integrity_check` and `SELECT sqlite_version()` are **refused by D1's authorizer**
  (`not authorized: SQLITE_AUTH`, `not authorized to use function`) while `node:sqlite` allows both.
  The integrity check in §9 therefore runs against **the file D1 wrote**, with python's `sqlite3`.
  This changes the repo's own promotion checklist (see §5).
* `ALTER TABLE … ADD COLUMN … CHECK (…)` has no precedent anywhere in 0001–0009. On D1 the column CHECK
  is live: a valid 64-hex `drive_ref` is accepted, `zzzz` and a 63-character value are both refused (§2).
* The runner is what turns a `.sql` file into applied DDL. It applied all 515 lines of the draft —
  8 `ALTER`s, 1 table, 20 triggers, 6 views, 6 indexes, 19 `RAISE(ABORT …)` — with no split error.

## 2. What was measured, section by section

| § | what it proves | checks |
| --- | --- | --- |
| 0 | the state a promotion starts from: 0002/0007/0008/0009 applied, 74 objects, inventory digest `97a419360af43f36`, empty registry | 2/2 |
| 1 | the runner applies 0010; **33 objects added** (`index=6 table=1 trigger=20 view=6`); the *only* pre-existing object whose DDL changed is `table:crm_drive_file_registry`; 0007 indexes/CHECKs and every 0008/0009 object byte-identical; all 8 projected columns present | 7/7 |
| 2 | `ADD COLUMN … CHECK` on the real engine, in both directions (accepted / refused / refused by length) | 4/4 |
| 3 | 99 **synthetic** `SYNTH…` file rows; the bootstrap; the projection; idempotency | 14/14 |
| 4 | 12 tampering attempts, each refused with the named trigger firing | 12/12 |
| 5 | content change under identical metadata, backdating, and A→B→A | 10/10 |
| 6 | the rehash queue, provenance view, duplicate-evidence view, and that no view exposes a name or path | 5/5 |
| 7 | D1 vs `node:sqlite` on the same three statements | 5/5 |
| 8 | what a failed migration file does to the database | 1/1 |
| 9 | integrity, foreign keys, schema drift, rollback | 9/9 |

The three findings worth pulling out of §1 and §3:

* **"Purely additive" was proved at token level, not by eyeballing text.** D1 rewrites the stored DDL of
  an altered table, so a line diff is meaningless. The harness instead asserts that every word of the old
  `crm_drive_file_registry` DDL still appears, in the same order, inside the new one (subsequence), and
  that every word the change *added* is a word 0010 itself wrote. So nothing was edited, dropped,
  reordered, or invented by the engine.
* **The live state cannot be mirrored before the ledger exists.** Inserting a file row at
  `processing_status='processed'` — which is exactly what a naive bootstrap would do to the 99 real rows —
  is refused on D1 by `trg_registry_status_needs_version`. The 99 rows may only advance *after* the
  bootstrap versions are recorded. The promotion order in the design report is therefore not cosmetic;
  it is enforced by the schema.
* The bootstrap creates exactly 99 versions, all `version_seq = 1`, all `evidence_class =
  'bootstrap_backfill'`, all with `drive_revision` and `drive_md5` **NULL** — the draft does not guess
  values it cannot observe — and re-running it adds nothing.

## 3. The refusals (§4, §5) — every one with the named barrier

`registry_fingerprint_must_match_recorded_head_version` · `registry_fingerprint_cannot_be_erased` ·
`registry_head_is_maintained_by_the_ledger` · `drive_version_seq_not_next` ·
`drive_version_verified_needs_recompute_evidence` · `drive_version_digest_must_be_derived` ·
`file_versions_are_append_only` (UPDATE and DELETE) · `file_versions_anchor_registry_rows` ·
`drive_ref_is_write_once` · `check constraint` (non-hex `drive_ref`, 63-hex `drive_ref`, a row born
claiming a head, a version with no fingerprint at all — `NOT NULL`) ·
`drive_version_time_moved_backwards` · `drive_version_repeat_needs_same_sha`.

Two of these earned their keep in a way I did not expect. The harness originally failed because a
backdated version was refused — and the reason was real: `crm_drive_file_registry.last_seen_at` has
`DEFAULT CURRENT_TIMESTAMP`, and the bootstrap derives `observed_at` from `COALESCE(r.last_seen_at,
r.created_at)`. A file row whose `last_seen_at` was never written therefore stamps its bootstrap version
with "now". On the live database `last_seen_at` *is* written by the scanner, so the semantic is correct
("the version was observed as of the last time the file row saw it"), but it is now stated explicitly in
the design report instead of being an accident of defaults.

§5 then does the thing T2 exists for: a second version with **the same size and the same
`modifiedTime`, different bytes** is recorded as a new row, the ledger reports it as a change the
metadata could not see, the file row keeps pointing at the old digest until the projection is legally
advanced, an unmarked return to an old digest is refused, and a *marked* repeat gets its own row pointing
at the earliest version carrying that digest — so `A→B→A` leaves three rows and two distinct digests.
History is never resurrected or overwritten.

## 4. What D1 does with the file, and with a bad file (§7, §8, §9)

* **The differential came back clean.** Three statements were run against both engines. Same verdict in
  all three, and after normalising only the CLI banner and the `at offset N` annotation, **the same
  sentence**: `drive_version_ref_not_registered`, `near "b": syntax error`, and
  `registry_head_is_maintained_by_the_ledger` appear identically on both. The only two real differences
  are capability differences, printed by the harness rather than remembered: `sqlite_version()` and
  `PRAGMA integrity_check` are blocked by D1's authorizer, allowed by `node:sqlite`.
  This is what makes the 45-check node rehearsal evidence *about D1* rather than about a similar engine.
* **A failed migration file does not leave a half-built schema.** A deliberately broken file (a valid
  `CREATE TABLE` followed by an invalid `ALTER`) was applied: local D1 **rolled back** the statement that
  had succeeded (`probe_atomic` present = 0), and re-applying 0010 afterwards lands on exactly the schema
  digest a clean apply produces. Whatever a future runner does with a mid-file failure, the draft is
  re-runnable and idempotent — that is the property the promotion plan depends on.
* **`integrity_check` is `ok` on the file D1 wrote** after the apply *and* after 12 refused tampering
  attempts; `PRAGMA foreign_key_check` (which D1 does allow) is empty; the inventory digest is unchanged
  across the whole run; and a rollback removes 0010's own 33 objects while 0007/0008/0009 come through
  byte-identical — with one honest exception the harness names out loud: the 8 added columns **cannot** be
  dropped (SQLite has no `DROP COLUMN`), so a rollback leaves the empty projection columns behind. The
  99 file rows are untouched in either direction, and the migration counter is rewound for 0010 only.

## 5. Consequences for the promotion checklist

Two wording changes are needed in `_worker/migrations-draft/README.md` (applied in the same commit as
this report):

1. `PRAGMA integrity_check = ok` **cannot be executed through D1's SQL interface** — local or remote. It
   must run on a downloaded copy or a backup of the database file (as this rehearsal does), or be
   replaced by `foreign_key_check` plus the CI object-count comparison.
2. The bootstrap's `observed_at` derives from `last_seen_at`/`created_at`, and `last_seen_at` defaults
   to `CURRENT_TIMESTAMP`. That is now written down as item 3b of the design report's promotion effects,
   so nobody reads a bootstrap timestamp as a Drive timestamp.

## 6. Limits of this evidence — what is still not proven

* **Remote D1 was never contacted.** `api.cloudflare.com` is unreachable from this sandbox and no token
  exists, so `--remote` was not exercised. The scratch database is the same engine and the same runner,
  not the same network path or the same console.
* **The 99 real rows were never backfilled.** Everything here uses synthetic `SYNTH…` fixtures with
  fabricated digests; no file content was read, so no real `content_sha256` exists anywhere in this work.
* **The service layer now exists, and only in this repository.** `_worker/crm-drive-file-registry.js`
  gained `recordVersion()` / `verifyVersionBinding()` / `hasVersionLedger()`, `recordContentHash()` delegates
  to the ledger, and `recordInspectionSuccess()` refuses `processed` unless the binding verifies. Nothing was
  deployed and no database outside a scratch directory has ever seen these writes; the intake runner change
  in `.github/workflows/crm-phase4-analysis.yml` is inert until 0010 is applied, because every new branch is
  taken on `hasVersionLedger(db)`.
* **`drive_revision`/`drive_md5` stay NULL** for anything the API did not supply; the design keeps them
  nullable so the schema cannot be filled with guesses.
* Duplicate detection across files is still *evidence*, not a conclusion: `crm_drive_duplicate_evidence`
  shows nothing for bootstrap claims, and declaring two files duplicates remains a human act.

## 7. Effect on existing data (unchanged by this task)

Applied for real, 0010 would: add 8 columns to `crm_drive_file_registry` (all nullable or defaulted, no
row rewritten), create one append-only table, 20 triggers, 6 views, 6 indexes, and run a backfill that is
**inert until `drive_ref` is populated by the writer**. It would not update, delete or re-type any
existing value, not relax any 0007/0008/0009 rule, not touch a file row's `processing_receipt_ref`, and
not create a single review case. Today it creates nothing at all: it is a file in a directory
`wrangler d1 migrations apply` does not read.

## 8. What T2 still needs from you

1. Approval of the *design* as written (version ledger, projection columns, evidence classes) — and the
   two engine-level consequences in §5.
2. Approval of the companion service change, which is now on this branch for review rather than
   hypothetical: `recordVersion()`'s write order (validate → version row → projection, one `batch()`,
   then a read-back), and the two-line intake-runner change that stops pre-emptively claiming `downloaded`
   once the ledger exists. Without the service the migration is inert, and any attempt to mirror the live
   `processed` state is refused by design.
3. Permission to read Drive file content (the digests are the point of the ledger; nothing can be
   *verified* — only declared — until then). That is the gate I have stopped at, and it is why every
   digest in this rehearsal is fabricated.
4. A decision on the `crm-test-deploy` environment gate (`CRM_PHASE4_REVIEW_SECURITY.md` §5) before any
   push that touches `_worker/crm-ui/**` or `_worker/crm-worker.js`.

## 9. What writing the service changed in the migration (§3.2), and what D1 proved about it

Two things had to move once a real writer existed, and both were measured on both engines before and after.

* **A deadlock in the draft, not a preference.** `trg_drive_version_ref_registered` also required
  `r.content_sha256 IS NOT NULL`, while §4 (`trg_registry_fingerprint_is_a_projection`) refuses any write of
  a fingerprint that is not the recorded head. A file at `metadata_scanned` with no digest — which is every
  newly discovered file — could therefore neither insert its first version row (the ledger trigger refused)
  nor receive its first fingerprint (§4 refused, because its head was 0). Only a destructive
  `INSERT OR REPLACE` slipped past, which is not a path the service may take. Reproduced standalone
  (`/tmp/deadlock.mjs`, first version refused, projection refused), then the clause was dropped and all four
  rehearsals re-run: the first version is now accepted, the projection lands, and both refusals that still
  matter — a fingerprint that is not the head, and a version for an unregistered file — refuse exactly as
  before. §4 is untouched, so *"every projected fingerprint must equal a recorded head version"* still holds;
  what the removed conjunct actually encoded was *"no file may ever get its first version"*, which is why the
  0010 node rehearsal's T1 grew from one check into four and the D1 rehearsal still holds at 69/69.
* **The engine answers questions `node:sqlite` cannot.** `_worker/tests-draft/crm-drive-file-versions.d1-service.mjs`
  runs the module itself — same file, no test-only branch — with every statement sent through
  `wrangler d1 execute --local`. Measured there, and only there:
  `db.batch()` is atomic (a poisoned final statement leaves the version row *and* the projection absent, and
  the retry records it once); the ledger's `AFTER INSERT` trigger moves `head_version_seq`/`versions_observed`
  for a row inserted inside the same script, so the projection the service writes afterwards is checked
  against a head the engine already advanced; and an upper-case digest is normalised rather than refused,
  which is why it is no longer in the refusal list.
* **A hole in the promotion plan, reported rather than patched.** The §5 bootstrap selects
  `WHERE r.drive_ref IS NOT NULL`, so a row that already carries `content_sha256` but no `drive_ref` — which
  is any row written before 0010 by a path that never derived refs — is invisible to the backfill and stays
  flagged by `crm_drive_version_invariant_violations` (`status_without_version=1`, measured as `V15a`).
  Anchoring the ref and re-running the draft's own bootstrap statement (the rehearsal slices it out of the
  migration file rather than retyping it) clears the view, and a second pass adds no rows (`V15b`, `V15d`).
  The README's checklist carries this as item 1b.
* **One harness lesson worth repeating for the next D1 script:** wrangler's `--json` reports a failed
  statement as `{"error":{"text":…}}` with no `✘` banner and exit status 1, so "did it refuse?" must read
  that shape rather than grep for the banner — otherwise every refusal looks like an empty response.

Reproduce locally (nothing external is touched):

```bash
npm install --no-save wrangler@4.156.0
KEEP=1 WRANGLER=$PWD/node_modules/.bin/wrangler \
  python3 _worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py
rm -rf /tmp/d1srv && KEEP=1 P2S_DIR=/tmp/d1srv WRANGLER=$PWD/node_modules/.bin/wrangler \
  node _worker/tests-draft/crm-drive-file-versions.d1-service.mjs   # the service itself, on D1
node --test _worker/tests/crm-drive-file-versions.test.mjs          # 19 checks of the same contract, in-process
```

Both need `wrangler` on disk (`npm install --no-save wrangler@4.156.0`) and nothing else: no network, no
token (the service rehearsal *strips* `CLOUDFLARE_*`/`GDRIVE_*`/`GOOGLE_*` from every child process and
fails if a spawn would omit `--local`), and no Drive file — every digest in it is `sha256` of a literal.

---

## 10. بوابة Phase 3 وزرع المراجع (2026-11-02) — ما تغيّر بعد كتابة الخدمة

### 10.1 البوابة: كانت عدًّا، صارت إثبات مصدر

`crm-phase3-registry.yml` كانت تشترط `hashed_cnt = 0` على قاعدة الاختبار الحية. ذلك الشرط وُضع
قبل أن يسجّل Phase 4 أي محتوى؛ اليوم كل الـ99 سطرًا تحمل بصمات مشروعة، فالبوابة صارت تفشل على
حالة سليمة (ظهر هذا عند أول تعديل لوحدة السجل في `47b3db7`). البديل المطبَّق ليس تخفيفًا ولا
تعطيلاً: الفحص صار يقرأ لقطة السجل **قبل** مرور المخزون و**بعده** ويشترط

- أن البصمات لم تتحرك: لا جديدة كُتبت، ولا قديمة مُسحت أو استُبدلت، ولا سطر اختفى، ولا سطر وصل
  ومعه بصمة (يسجّل المخزون ملفات، لا محتواها)؛
- أن كل بصمة موثَّقة: إيراد `p4a:sha256:<32hex>` أو `phase2-0010-bootstrap`، أو رأس إصدار في دفتر
  0010 يحمل نفس البصمة؛ و`processed` تحتاج إيرادًا دائمًا؛
- أن النتيجة ليست فارغة (فحص بلا صفوف يُرفض كفحص بلا معنى)، وأن الرسائل لا تذكر `drive_file_id`.

المنطق كله في `scripts/crm/verify-phase3-metadata-boundary.mjs` ويشغّله CI بنفسه (`selftest`، 20
حالة) قبل أي اتصال بقاعدة، إضافة إلى 7 اختبارات `node --test` على الـ SQL الحقيقي وعلى مسار الخدمة
(`upsertDriveFileMetadata` يرفض `content_sha256`، و`recordContentHash` لا يرفض) — أي أن البوابة
تُثبت أنها تملك أسنانًا: بصمة مهربة بـ raw SQL تُرفض، مع أن المحرك يسمح بها عند `metadata_scanned`.

**تصحيح مهم بعد أول تشغيل في CI (2026-11-02):** شريط `hashed_cnt` كان فعلاً قاعدة بالية، لكنه لم يكن سبب
احمرار Phase 3. السبب المقاس — بعدما صار للفشل تعليق يصف نفسه — هو في الاختبار المعزول:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:  9 !== 7
```

أي `assert.equal(Number(migCnt), 7)` على قاعدة مؤقتة تُطبَّق عليها سلسلة المستودع كلها، بينما صارت السلسلة
تسع هجرات منذ ترقية 0008 و0009. رقم «7» كان يشرعن جزئيًا: إمّا أن تُطبَّق سبع وتسقط ثلاث بصمت `>/dev/null`،
وإمّا أن يحمرّ الشريط للأبد. الصواب الآن مشتق من المستودع نفسه: `migCnt == عدد ملفات _worker/migrations`،
وآخر مُطبَّق هو أحدث ملف، و`0007_crm_drive_file_registry` يجب أن يكون ضمن المجموعة قبل أي فحص للسجل.
ملاحظة إضافية أُضيفت لنفس السبب: الشريط كان يفشل بصمت «exit code 1» لا يراه أحد؛ صار لكل فشل محلي تعليق
`::error::` منقًّى من المعرّفات، والفشل المعزول **مُجَّل** حتى تُشغَّل بقية الخطوات ثم يُحسم به النتيجة —
لا شيء صار اختياريًا، لكن دورة واحدة تجيب أكثر من سؤال. هذا أيضًا يصحّح استنتاجًا سابقًا في هذه الجلسة كان
مفاده أن الاحمرار من عدّاد البصمات وحده.

### 10.2 فجوة §5 أُغلقت بأداة زرع، وبقي حدّها مكتوبًا

الحالة المعطوبة: سطر سُجّل بالمخزون ثم خُتمت بصمته قبل 0010 ⇒ `drive_ref IS NULL` ⇒ §5 لا يراه ⇒
`status_without_version=1` ⇒ كل محاولة فتح حالة مراجعة (0011) تُرفض. الترتيب الآمن موثَّق في
`_worker/migrations-draft/README.md` (البند 1b) وأداةٌ تنفّذه:
`scripts/crm/seed-drive-file-refs.mjs` (10 حالات `selftest` + ملف `drive-ref-seed.sql` و manifest
بأرقام فقط). العمود لا يوجد قبل 0010، فليست هناك «خطوة زرع قبل الترقية» — مقيس لا مُستنتج
(الاختبار الأول في `crm-drive-ref-bootstrap.test.mjs` يفحص `PRAGMA table_info` ويُثبت أن العمود
غائب، حتى لا تتقادم القائمة).

بعد الزرع وإعادة §5: الإصدار يُدرج بـ `evidence_class='bootstrap_backfill'` و
`observed_by='registry_bootstrap'`، ويبقى مدرجًا في `crm_drive_rehash_queue` كـ
`bootstrap_claim_only`، ولا يظهر أي `verified_local_recompute` من هذه الطريق (مقيس على
node:sqlite؛ وعلى D1 في `V15a–V15d`). **الحد:** المحرك يتحقق من شكل المرجع ووجوده فقط، لا أنه
اشتقاق — لأن D1 بلا `sha256`؛ لذا المراجعة البشرية لملف الـ SQL إلزامية، ولذا لا تكتب الأداة فوق
مرجع موجود أبدًا.

---

## 11. سباق حقيقي بين كاتبين على D1 محلية (2026-11-02) — 32/32

أُضيفت إلى `_worker/tests-draft/crm-drive-file-versions.d1-service.mjs` خمس حالات `C`. المتسابقون
ليسوا `Promise.all` على نفس الاتصال: كل متسابق **عملية node منفصلة** تعيد تشغيل نفس الملف بدور
`P2S_ROLE`، وتستورد `recordVersion()` الحقيقية، وتكتب في **نفس ملف القاعدة المحلية**. لا طابور ولا
قفل في الاختبار — المحكِّم الوحيد هو SQLite ثم مشغّلات 0010. ولمدة السباق يُوسَّع نافذة القراءة←الكتابة
بمهل `mid_pause_ms` داخل دفعة المتسابق، فيدخل منافسه بين قراءة الرأس والكتابة.

| الحالة | ما جرى | ما يُثبَت |
|---|---|---|
| C1 | عمليتان، نفس البصمة، النتيجة `already_recorded` + `recorded` | سطر إصدار واحد فقط، `seq=1`؛ الرابح مَن كتب، والآخر وجد الحقيقة ولم يخترع صفًّا |
| C2 | عمليتان، بصمتان مختلفتان | صفّان، `1,2` بلا تكرار رقم، الرأس 2، والإسقاط = بصمة الرأس |
| C3 | ثلاث عمليات (واحدة متأخرة 600ms وموقوفة 1500ms)، محاولاتها `1/1/2` | الكثافة `1..3` كاملة، لا صفّاه sharing نفس `version_ref`، ولا إصدار ضاع ولا فُقد |
| C4 | إعادة محاولة الخاسر لاحقًا، ثم تكرار بصمة الرأس | `recorded` مربوط بالإصدار الذي كرّره (`repeat_of_version_ref`)، ثم `unchanged` بلا صف جديد |
| C5 | قراءة الدفتر كله بعد كل السباقات | `counter_mismatches=dangling_heads=seq_gaps=status_without_version=0`، ولا تكرار في `version_ref`؛ **٧ عمليات، 60 استدعاء ابنًا كلها `--local`، 3 إعادة محاولة من جهة المستدعي** |

النتيجة الكاملة: `SERVICE_D1 32/32` (كانت 27/27)،
`LOCALITY spawns=221 without_local=0 remote=0 creds=0` — أي أن السباق كله جرى بدون token، بدون
Drive، وبدون أي احتمال لمسّ قاعدة حقيقية (الحارس في الملف يرفض أي spawn ليس `wrangler … --local`).

**ما يثبته هذا بالضبط:** أن قيود 0010 (UNIQUE على `version_ref`، وكثافة `version_seq`، ومطابقة الرأس،
و`batch()` الذرّية) هي التي تُبقي الدفتر سليمًا تحت تنافس فعلي، وأن تسامح الخدمة (تبنّي الرابح أو
إلحاق خسارتها) يعمل عبر حدود العمليات. **ما لا يثبته:** سلوك D1 الموزّع — العزل بين Worker isolates،
جدولة الشبكة، إعادة محاولة HTTP عندtimeout، وتأثير `begin/abort` عبر المناطق. اختبار محلي لا يستطيع
ذلك، ولا يُسمَّى هنا دليلاً عليه. البديل المطروح عند الحاجة: سباقان على `nasr-crm-test-db` بصفّ
اختبار مخصَّص (موافقة طارق + بدون أي بيانات عميل)، أو اختبار عميلين HTTP على `wrangler dev` حين يوجد
Worker حيّ للخدمة — وكلاهما يبقى *إضافة* إلى هذه الأدلة لا بديلًا عنها.
