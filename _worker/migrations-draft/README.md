# migrations-draft — مجلد المسودات (0009 لم تعد هنا)

**الحالة (2026-11-02، بعد الاعتماد A3):** `0009` و`0010` رُوِّجتا إلى `_worker/migrations/`
(`git mv` فقط، بلا تحرير للنصّ) — ترويج `0010` يعني أن `crm-phase3-registry.yml` سيطبّقه على
`nasr-crm-test-db` في CI؛ هذا هو التطبيق المقصود، وليس هذا المجلد. بقيت هنا مسوّدة واحدة معلَّقة:

- `0011_crm_drive_file_intake_review.sql` — **لا تُروَّج** إلا بعد أن قراءة `status_without_version = 0`
  على قاعدة الاختبار (أي بعد زرع `drive_ref` وإعادة §5 من `0010`)؛ الشرط في `CRM_PHASE2_DRIVE_MIGRATION_PLAN.md` §3 خطوة 8.

وفي هذا المجلد قاعدة الترويج نفسها: كل هجرة جديدة تبدأ هنا ولا تدخل `_worker/migrations/` إلا بموافقة صريحة.

| مسودة | تعالج | أشياء جديدة | لا تلمس |
| --- | --- | --- | --- |
| `0010_crm_drive_file_versions.sql` | *(رُوِّجت — انظر `_worker/migrations/`)* | جدول `crm_drive_file_version` + 8 أعمدة إسقاطية في `crm_drive_file_registry` + 20 مشغّلًا + 6 عروض | لا `DROP`، لا `UPDATE` على صفوف قائمة، لا حذف أي قيد |
| `0011_crm_drive_file_intake_review.sql` | حالة مراجعة لملف بلا عميل | `crm_drive_file_review_case` + `..._decision` + `..._anchor` + 4 عروض + 16 مشغّلًا | **لا تعديل ولا إعادة بناء لجدول 0009**; العزل مقصود |

كل هجرة جديدة تبدأ هنا ولا تدخل `_worker/migrations/` إلا بموافقة طارق الصريحة.

## لماذا ليس في `_worker/migrations/` قبل الموافقة

كل سير عمل يطبّق الهجرات ينفّذ `wrangler d1 migrations apply` على **المجلد كاملًا**:

- `.github/workflows/crm-phase4-analysis.yml` (المؤقت المعزول، ثم `nasr-crm-test-db` فقط)
- `.github/workflows/crm-phase3-registry.yml`
- `.github/workflows/crm-cloudflare-test-d1.yml`
- `.github/workflows/crm-cloudflare-test-deploy.yml` (على `master`، بعد موافقة Environment)

لذلك كانت المسودة محفوظة هنا حتى الموافقة الصريحة على SQL. بوابة النشر قُفِلت في
`1e183df`: لم يعد `crm-cloudflare-test-deploy.yml` يعمل تلقائيًا على `push` لأي فرع.

## كيف تراجع أي مسودة بدون لمس أي قاعدة

```bash
node _worker/tests-draft/crm-review-sql-0009.abuse.mjs              # 113 فحصًا، :memory: فقط
node _worker/tests-draft/crm-drive-versions-0010.rehearsal.mjs     # 45 فحصًا: الإصدارات لا تُستبدل
node _worker/tests-draft/crm-file-review-0011.rehearsal.mjs        # 35 فحصًا: لا ربط بلا إنسان
python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py    # 116 فحصًا، محرك D1 في مجلد مؤقت
python3 _worker/tests-draft/crm-drive-versions-0010.d1-rehearsal.py  # 69 فحصًا على D1: 0010 (تقرير:
                                                                     #   CRM_PHASE2_DRIVE_0010_D1_TEST_REPORT.md)
python3 _worker/tests-draft/crm-file-review-0011.d1-rehearsal.py     # 83 فحصًا على D1: 0011 (تقرير:
                                                                     #   CRM_PHASE2_DRIVE_0011_D1_TEST_REPORT.md)
python3 _worker/tests-draft/crm-0009-backup-restore.rehearsal.py   # 33 فحصًا، حزمة احتياطية مُسيَّجة
node _worker/tests-draft/crm-drive-file-versions.d1-service.mjs    # 27 فحصًا على D1 لطبقة الخدمة نفسها
node --test _worker/tests/crm-drive-file-versions.test.mjs         # 17 فحصًا في-process (node:sqlite)
node scripts/crm/drive-registry-envelope.mjs selftest       # 13 فحصًا: ترميز p3reg_v1 في الاتجاهين
node scripts/crm/seed-drive-file-refs.mjs selftest          # 13 فحصًا: الزرع بعمود واحد + استخراج §5
node --test _worker/tests/crm-drive-registry-envelope-sync.test.mjs  # 8: مغلف اصطناعي عبر sync_sealed كامل
```

**الخطة التشغيلية للترحيل الآمن** (نسخة احتياطية مُتحقَّق منها ← 0010 ← زرع ← §5 ← 0011 ← تحقق):
`CRM_PHASE2_DRIVE_MIGRATION_PLAN.md` — فيها أوامر كل خطوة، وشروط التوقف، والتراجع لكل مرحلة، وما لا يُسمح به
(لا `nasr-market-db`، لا قراءة محتوى، لا تغيير إعدادات، لا deploy، لا دمج). وتُثبّت الفخّ الذي لا يظهر إلا أثناء
التنفيذ: بعد 0010 مباشرة يكون `status_without_version = 99` **متوقعًا**، لذلك الخطوات 3→7 جلسة واحدة متصلة،
ولابد أن يكون `_worker/ingest-queue/drive-registry-sealed.txt` على `IDLE` قبل البدء. إذا تعارض هذا الملف مع
الخطة، تُصحَّح المسودة هنا — لا العكس.

`crm-drive-file-versions.d1-service.mjs` هو الملف الذي يُشغّل **دالة `recordVersion()` الحقيقية** (لا
SQL مُعاد كتابتها) على محرك D1: كل عبارة تُرسل عبر `wrangler d1 execute --local` إلى قاعدة مؤقتة في مجلد
مُهمل، والملف يرفض أي أمر ليس `wrangler`، ويفشل إذا غاب `--local`، ويحذف كل سحابة/Drive من بيئة الأبناء.
هو أيضًا المكان الذي قِيِس فيه فعليًا: ذرّية `batch()`، وترتيب المشغّلات داخل الدفعة الواحدة.

كل عداءات D1 تعمل على `wrangler d1 … --local` بملف مؤقت في مجلد مهمل (`KEEP=1` يُبقيه للفحص)، وتحتاج
`npm install --no-save wrangler@4.156.0`. لا شيء منها يلمس `api.cloudflare.com`.

الاختبارات الثلاثة تمشّط `_worker/migrations/` **و** `_worker/migrations-draft/` معًا، فلا تحتاج
تعديلًا عند الترويج. كلها محلية بالكامل: لا `--remote`، ولا اتصال بأي قاعدة حقيقية، ولا استدعاء Drive.
بوابة CI بلا أسرار: `.github/workflows/crm-review-0009-verify.yml`.

## طبقة الخدمة (لا SQL وحده)

كتابة الإصدارات ليست مسؤولية المُهاجِر بل مسؤولية `_worker/crm-drive-file-registry.js`:

- `recordVersion(db, {…})` هي القارئ والوحيد لجدول `crm_drive_file_version`. ترتيبها مُتعمَّد:
  تحقّق من المدخلات أولًا (بصمة 64 خانة سداسية صغيرة، حجم، صنف دليل، راصد، إيصال) ← فحص وجود الدفتر ←
  قراءة السطر ← اشتقاق `drive_ref` بالمفتاح المعتمد في المستودع
  (`deriveDriveRef` = `sha256("crm-p4-v1\ndrive_ref\n<id>")`، لا مفتاح خاص) ←
  **إدراج صف الإصدار ثم تحديث الإسقاط في `batch()` واحدة** ← قراءة رجوعية (`verifyVersionBinding`)
  تُثبت أن الرقم والبصمة والمرجع متفقون، وإلا `VERSION_NOT_PROJECTED`.
- `recordContentHash` تُفوّض الدفتر أولًا ثم تعمل تحديثها كما كانت؛ و`recordInspectionSuccess` ترفض
  `processed` ما لم تكن الرابطة موثَّقة (`VERSION_BINDING_MISSING` / `VERSION_BINDING_MISMATCH`).
  بدون 0010 كل هذا ينحدر إلى سلوك ما قبل 0010 بلا انكسار (مقيس في الاتجاهين).
- **لماذا ليّن §3.2 بند `content_sha256 IS NOT NULL`** (2026-11-02): كان البند مع §4 يُحدث طريقًا
  مسدودًا — ملف عند `metadata_scanned` ببصمة فارغة لا يستطيع إدراج أول إصدار (البند يمنعه) ولا يستطيع
  كتابة أول بصمة (§4 يرفض كل بصمة ليست رأسًا مسجَّلًا، ورأسه صفر). مقيس في `/tmp/deadlock.mjs` ثم في
  `V1/T1` من العدّائين. الرفض المتبقي مطلوب ولا يزال ساريًا: لا بصمة لسطر ملف لا تحملها نسخة رأس مسجَّلة.
- **الفجوة، مقيسة ومغلقة:** عمود `drive_ref` نفسه يخلقه §1 من 0010، فأي سطر كُتبت بصمته قبل الترقية
  (مسار المخزون ثم `recordContentHash`) لا يرى مُهاجِر §5 شيئًا يزرعه فيه: يبقى `head_version_seq=0`
  ويظهر `status_without_version=1` في عرض الانتهاكات، وترفض 0011 فتح حالة مراجعة عليه
  (`file_review_case_requires_a_recorded_version`). الزرع لذلك **ليس خطوة قبل 0010** — هو خطوة بعدها:
  `scripts/crm/seed-drive-file-refs.mjs` يولّد `UPDATE` لعمود واحد من تصدير مقروء، ثم تُعاد عبارة §5
  (idempotent). مُثبت على D1 في `V15a–V15d` + `C/S`، وعلى node:sqlite في
  `_worker/tests/crm-drive-ref-bootstrap.test.mjs` (٧ اختبارات: الفجوة، الإغلاق، عدم التكرار،
  تعارض مرجع مفروض، منع ادّعاء تحقّق غير مُثبت، وأن **الملف الذي ستُطبّقه الخطة هو نفسه المُختبَر**
  (لا نسخة ثانية من استخراج §5)، ورقم القبول `status_without_version = 0` بعد الزرع وإعادة §5).

## قائمة الترويج (ما يُشترط في نفس الـ commit)

0. **المسوّدتان غير مطبَّقتين، ولا تُطبَّقان قبل قراءة محتوى الملفات** — هذا هو الحدّ الذي
   يفتح T2؛ كل ما هنا تصميم + اختبارات محلية فقط.
1. `git mv _worker/migrations-draft/<00XX>_*.sql _worker/migrations/` عند الموافقة على الواحدة تلو
   الأخرى (0010 أولًا لأن 0011 يقرأ `crm_drive_file_version`).
1b. **زرع `drive_ref` لصفوف السجل القائمة — بالترتيب الذي يسمح به المحرك فقط:**
   `drive_ref` عمودٌ يُنشئه §1، فلا يوجد معنى لـ"ازرعه قبل 0010" (مقيس: `PRAGMA table_info` قبل 0010
   لا يذكر العمود، والاختبار الأول في `crm-drive-ref-bootstrap.test.mjs` يُثبّت ذلك حتى لا تتقادم القائمة).
   الترتيب الآمن، وكل خطوة محلية لا تمسّ قاعدة بعيدة:

   ```bash
   # 1) تصدير مقروء فقط (لا كتابة): ملف JSON لسطر السجل — من نسخة محلية بـ `wrangler d1 … export --local`
   #    أو من أي مسار قراءة مُصادق عليه. المطلوب أعمدة قليلة: drive_file_id, drive_ref, content_sha256.
   #    لا تشغّل الأداة على قاعدة بعيدة: هي لا تعرف قاعدة أصلًا (لا شبكة، لا token).
   # 2) طُبِّقت 0010 (§5 يعمل ويكون بلا أثر على الصفوف غير المُرساة — متوقَّع، لا فشل)
   # 3) توليد خطة الزرع ومراجعتها
   node scripts/crm/seed-drive-file-refs.mjs --from /tmp/reg.json --out /tmp/seed
   #    يرفض: id خارج [A-Za-z0-9_-]{10,128}، بصمة غير 64 سداسية، ومرجعًا موجودًا يختلف عن المفتاح
   #    (تعارض يُترك لإنسان؛ لا يُكتب فوقه أبدًا). لا يلمس أي عمود غير `drive_ref`.
   # 4) طبِّق /tmp/seed/drive-ref-seed.sql ثم أعد عبارة §5 — بلا نسخ يدوي:
   node scripts/crm/seed-drive-file-refs.mjs backfill-sql --out /tmp/rerun-0010-s5.sql
   #    يرفض الأداة إن لم يكن المستخرَج عبارة واحدة `INSERT INTO crm_drive_file_version` فيها
   #    NOT EXISTS و'bootstrap_backfill' و'phase2-0010-bootstrap'، وما زال شرطا drive_ref/content_sha256،
   #    ولا UPDATE/DELETE/DROP/ALTER/PRAGMA. الملف يتغيّر بمسارته الجديدة بعد الترويج — والمُستخرِج يتبعه.
   # 5) الفحص الواجب قبل أي اعتماد على 0011:
   #    SELECT status_without_version FROM crm_drive_version_invariant_violations;   -- يجب أن يكون 0
   ```

   **الحدّ الصادق:** D1 لا يملك `sha256`، فلا يستطيع المحرك أن يتحقق أن المرجع *مشتق* من المعرّف — يتحقق
   من شكله ووجوده فقط. لذلك أداة الزرع لا تكتب مرجعًا موجودًا، ولابد من مراجعة `drive-ref-seed.sql`
   بشريًا قبل التطبيق. الإصدارات الناتجة تُسمَّى `bootstrap_backfill` (راصد: `registry_bootstrap`)
   وتبقى ظاهرة في `crm_drive_rehash_queue` كـ`bootstrap_claim_only`: إغلاقُ الفجوة لا يحوّل ادّعاءً قديمًا
   إلى إعادة قياس.
2. عدّاد الهجرات في `.github/workflows/crm-phase4-analysis.yml`:
   القاعدة المعزولة `migCnt = 9` وسطر `latest = 0009_crm_drive_review_workflow`،
   وعلى قاعدة الاختبار `migs = 9` + `p4_tbl = 8` + `rev_tbl/trg/view/idx = 5/19/4/8` + `rev_rows = 0`،
   مع `foreign_key_check` نظيفًا. **تنبيه مقيس على المحرك:** `PRAGMA integrity_check` مرفوض من مُخيِّل
   الأمان في D1 (`SQLITE_AUTH`) — محليًا وبعيدًا — فلا يمكن تشغيله من واجهة SQL؛ يُقاس على نسخة ملف
   القاعدة (كما يفعل عداء 0010) أو يُستبدل بعدّ الأشياء في `sqlite_master` + `foreign_key_check`.
2b. **فحص ترتيب قبل 0011** (مقيس، لا افتراض): SQLite لا يحلّ جسم المُشغِّل مقابل جداول غائبة، فـ
   `wrangler d1 migrations apply` يقبل 0011 حتى لو لم تكن 0010 مطبَّقة، والفشل يظهر عند أول كتابة حالة
   مراجعة فقط. الترويج لذلك يجب أن يسبقه هذا السطر، ولا يُعتمد على رفض المحرك:

   ```sql
   SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master
                             WHERE type='table' AND name='crm_drive_file_version')
               THEN 'ok' ELSE 'abort: 0010 must be applied before 0011' END AS preflight;
   ```
3. مسار `push.paths` في نفس الملف ليشمل ملف الهجرة المُروَّج.
4. **لا** تُضاف أسماء الجداول/المشغّلات يدويًا إلى أي مكان آخر: فاحص CI يقرأ الأسماء المعلنة من
   ملف الهجرة ويقارنها بـ `sqlite_master` الحيّ، فانحرافٌ واحد يُفشل التشغيل.
5. **قبل** أي push يمسّ `_worker/crm-ui/**` أو `_worker/crm-worker.js`: بوابة `crm-test-deploy`
   يجب أن تكون قائمة ومحميّة (قرار المستخدم، `CRM_PHASE4_REVIEW_SECURITY.md` §5).

---

## سجل الترقية — 0011 (3 نوفمبر 2026)

رُفِّع `0011_crm_drive_file_intake_review.sql` إلى `_worker/migrations/` بعد أن تحققت الشروط المقيسة لا المزعومة:

| الشرط (المطلوب في §7 أعلاه) | القيمة المقيسة من CI | المصدر |
|---|---|---|
| `status_without_version = 0` | `svv=0` (وقبلها `needs_bootstrap=0, ctr=0, dang=0, gaps=0, orphans=0`) | تشغيل التوثيق المستقل `41632541771` ثم `verify` على `6c8fa51` |
| 0010 مطبَّقة أولًا | `migs=10,latest=0010_crm_drive_file_versions` قبل الترقية | `Session ledger` في نفس التشغيل |
| زرع المراجع مكتمل ومطابق للخطة | `anchored=99, digest_match=yes` مع `anchor_digest=300c442a0c87…0504` | `Session anchors` |
| تمرينات 0011 خضراء على الحالة الجديدة | `FILE_REVIEW 35/35 ALL_BARRIERS_HELD` و`D1_FILE_REVIEW 83/83 ALL_BARRIERS_HELD_ON_D1` | `node _worker/tests-draft/crm-file-review-0011.rehearsal.mjs` + `python3 …d1-rehearsal.py` محليًا |
| الحزمة الكاملة | `734/734` (`fail 0`) مع 0011 داخل `_worker/migrations/` | `npm test` |
| طابور ingest مختوم لا يكتب شيئًا عرضيًا | `IDLE` | `_worker/ingest-queue/drive-registry-sealed.txt` |

التطبيق على `nasr-crm-test-db` يتم حصريًا عبر CI (خطوة `d1 migrations apply` في `crm-phase3-registry.yml`، وهي نفس القناة التي طبّقت 0010). لا تُطبَّق يدويًا من أي جهاز. ملاحظة صريحة للجلسة التالية: `crm-phase4-analysis.yml` ينفّذ `d1 migrations apply` في الخطوة 9 **قبل** فرع المؤشر `.crm/p4-diagnostic-read-only`، فوصف المؤشر بأنه "قراءة فقط" لا يشمل تلك الخطوة؛ من يريد brake حقيقيًا على تطبيق migration عبر p4 يجب أن ينقل الفحص إلى ما قبل الخطوة 9 (لم يُفعَّل هنا لأنه يغيّر سلوك مرحلة مغلقة).
