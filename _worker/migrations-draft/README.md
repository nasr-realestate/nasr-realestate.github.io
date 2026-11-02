# migrations-draft — مجلد المسودات (0009 لم تعد هنا)

**الحالة (2026-11-02):** `0009` رُوِّجت سابقًا إلى `_worker/migrations/` (`git mv` فقط، بلا تحرير)،
وفي هذا المجلد الآن مسوّدتان معلَّقتان من Phase 2 / T2، ولا يُطبَّق أيٌّ منهما على أي قاعدة:

| مسودة | تعالج | أشياء جديدة | لا تلمس |
| --- | --- | --- | --- |
| `0010_crm_drive_file_versions.sql` | تتبّع إصدارات محتوى ملف Drive | جدول `crm_drive_file_version` + 8 أعمدة إسقاطية في `crm_drive_file_registry` + 20 مشغّلًا + 6 عروض | لا `DROP`، لا `UPDATE` على صفوف قائمة، لا حذف أي قيد |
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
```

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
  قراءة السطر ← اشتقاق `drive_ref` (نفس مفتاح T1: `hashIdentifier('drive_ref', id)`، لا مفتاح خاص) ←
  **إدراج صف الإصدار ثم تحديث الإسقاط في `batch()` واحدة** ← قراءة رجوعية (`verifyVersionBinding`)
  تُثبت أن الرقم والبصمة والمرجع متفقون، وإلا `VERSION_NOT_PROJECTED`.
- `recordContentHash` تُفوّض الدفتر أولًا ثم تعمل تحديثها كما كانت؛ و`recordInspectionSuccess` ترفض
  `processed` ما لم تكن الرابطة موثَّقة (`VERSION_BINDING_MISSING` / `VERSION_BINDING_MISMATCH`).
  بدون 0010 كل هذا ينحدر إلى سلوك ما قبل 0010 بلا انكسار (مقيس في الاتجاهين).
- **لماذا ليّن §3.2 بند `content_sha256 IS NOT NULL`** (2026-11-02): كان البند مع §4 يُحدث طريقًا
  مسدودًا — ملف عند `metadata_scanned` ببصمة فارغة لا يستطيع إدراج أول إصدار (البند يمنعه) ولا يستطيع
  كتابة أول بصمة (§4 يرفض كل بصمة ليست رأسًا مسجَّلًا، ورأسه صفر). مقيس في `/tmp/deadlock.mjs` ثم في
  `V1/T1` من العدّائين. الرفض المتبقي مطلوب ولا يزال ساريًا: لا بصمة لسطر ملف لا تحملها نسخة رأس مسجَّلة.
- **ملاحظة مقيسة للترقية:** مُهاجِر §5 لا يرى صفوفًا بلا `drive_ref` (مثل أي سطر كُتبت بصمته قبل 0010
  ولم يشتق مرجعه). هذه تبقى `status_without_version=1` في عرض الانتهاكات حتى يُزرع `drive_ref` ثم تُعاد
  عبارة §5 (مُثبت في `V15a/V15b`؛ العبارة مُكرَّرة من ملف الهجرة نفسه، وهي idempotent: `V15d`).

## قائمة الترويج (ما يُشترط في نفس الـ commit)

0. **المسوّدتان غير مطبَّقتين، ولا تُطبَّقان قبل قراءة محتوى الملفات** — هذا هو الحدّ الذي
   يفتح T2؛ كل ما هنا تصميم + اختبارات محلية فقط.
1. `git mv _worker/migrations-draft/<00XX>_*.sql _worker/migrations/` عند الموافقة على الواحدة تلو
   الأخرى (0010 أولًا لأن 0011 يقرأ `crm_drive_file_version`).
1b. **لا تُطبَّق 0010 قبل أن تُزرع مراجع `drive_ref` لصفوف السجل القائمة**، وإلا ستبقى تلك الصفوف
   بلا إصدار أول وتظهر في `crm_drive_version_invariant_violations`. الفحص: عدد الصفوف التي لها
   `content_sha256` وليس لها `drive_ref` يجب أن يكون صفرًا قبل §5 وبعده.
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
