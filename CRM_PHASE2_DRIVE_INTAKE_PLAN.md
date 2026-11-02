# خطة المرحلة 2 — استقبال Google Drive (تصميم مُعَدّ، غير منفَّذ)

**الحالة:** تحضير فقط. لا كود إنتاج يعمل، لا هجرة مطبَّقة، لا استدعاء كتابة على Drive.
**المرجع الحاكم:** `CRM_DATA_GOVERNANCE.md` (12 قاعدة) و`AGENTS.md`. كل بند أدناه مُسند إلى آلية
موجودة فعلًا أو إلى هجرة مسودة تُكتب أولًا في `_worker/migrations-draft/`.
**المجلد:** «قاعده العملاء نظام CRM» — معرّفه الحقيقي لا يُكتب في أي ملف متتبَّع؛ يُستخدم `ref =
sha256(drive_file_id)` (نفس مخطط §5.5 في الحوكمة، ونفس `driveRefHash` في
`_worker/crm-wa-vcard-analysis.js`).

---

## 0) ما يملكه المشروع الآن (وقائع مقيسة، لا افتراض)

| أصل | الحالة المقيسة |
|---|---|
| `crm_drive_file_registry` (0007) | موجود على قاعدة الاختبار؛ `drive_file_id UNIQUE`، `content_sha256`، `duplicate_of_file_id`، آلتا حالة `processing_status` / `review_status` |
| طاولات التحليل (0008) | 8 طاولات؛ `auto_link` مثبَّت على 0؛ `import_performed = 0` مقيس في CI |
| مسار المراجعة (0009) | 5 طاولات · 8 فهارس · 19 مشغّلًا · 4 مناظر، **بصفر صفوف** (مقيس على `nasr-crm-test-db`) |
| قائمة Drive | 100 ملف في المجلد؛ لا جديد ولا تعديل منذ الجرد الأخير (قياس: `total_count=100`، ولا عنصر `modifiedTime` أحدث من بطاقة 514 بايت) |
| صلاحيات CI | لا يوجد أي سرّ Drive في أي workflow ⇒ الاستكشاف اليوم يعمل عبر مُصدِّر (export) يقرّؤه طارق/الوكيل، لا عبر عامل يعمل بمفرده |

النتيجة التصميمية الأهم: **الاستقبال لا يحتاج ساحة كتابة جديدة**; يحتاج حلقة «اكتشاف → بصمة → نسخة
→ ختم» حول الطاولة الموجودة، مع منع كل طريق يمسّ طاولات العملاء.

---

## 1) الاكتشاف: جديد / معدَّل / مكرر

**المدخلات:** ملف `listing.json` (ناتج `files.list` على المجلد: `id, name, mimeType, size,
md5Checksum, modifiedTime, version`) + `registry.json` (ناتج استعلام قراءة فقط على
`crm_drive_file_registry`). **المُخرَج:** خطة (`p2intake_plan_v1`) بأفعال، لا بيانات عملاء.

| قرار الخطة | متى | ملاحظة حوكمة |
|---|---|---|
| `register_new` | لا يوجد `ref` في السجل، ولا بنية محتوى مطابقة | أول ظهور |
| `register_duplicate` | `content_sha256` مطبَّق مسبقًا في هذا المجلد أو في السجل | القاعدة 4: تكرار بالمحتوى لا بالاسم/الحجم؛ القانوني هو الأقدم بـ `drive_modified_at` |
| `register_new_version` | نفس الملف وبصمة محتوى موثَّقة مختلفة | لا استبدال: نسخة جديدة والسابق يبقى |
| `link_verified_hash_pending` | تغيّر `modifiedTime`/`version`/`size` بدون بصمة محتوى موثَّقة | **لا يُسمَّى أبدًا نسخة ولا تكرارًا** حتى يُنزَّل ويُجزَّأ |
| `unchanged` | لا تغيير في أي مما سبق | لا كتابة |
| `missing_from_listing` | سجل به عنصر غير موجود في القائمة | يُبلَّغ فقط؛ لا حذف ولا أرشفة تلقائية |
| `ignore_trash` | القائمة تقول `trashed` | لا لمس |

**الأداة مُسلَّمة وتعمل:** `scripts/crm/drive-intake-discovery.mjs` — 17/17 فحصًا محليًّا
(`selftest`)، ثابتة تحت إعادة ترتيب المدخلات، ومضمونة عدم تسريب المعرّفات الخام.

## 2) قبول VCF / ZIP / غير ذلك بدون تصنيف يدوي

`classify()` يقرّر بالترتيب: بايتات السطر (`PK\u0003\u0004` ⇒ zip، `BEGIN:VCARD` ⇒ vcf) ثم `mimeType`
ثم الامتداد. كل ملف لا يُعرف ⇒ `kind: other` مع `review_status: needs_manual_review`؛ **لا يُرفض أي
ملف صامتًا** (القاعدة 12). الأرشيفات تُفتح عبر `_worker/crm-safe-archive.js` القائم (سقف أدخلة،
منعZip-bomb، رفض باثات الخروج) — نفس المسار الذي أنتج `archive_rejected_entries=0` المقيس.

## 3) بيانات وصفية + بصمة + نسخ

`crm_drive_file_registry` تحمل البصمة والحجم والزمن وحالة المعالجة؛ النسخ تحتاج طاولة واحدة جديدة
(مسودة 0010، ليست مطبَّقة):

```sql
-- 0010_crm_drive_intake_versions.sql (مسودة مقترحة؛ تُراجَع كما روجع 0009)
CREATE TABLE IF NOT EXISTS crm_drive_file_version (
  version_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- المرجع في القاعدة هو المعرّف الحقيقي (السجل يخزّنه؛ المخارج تُسمّي فقط sha256)
  drive_file_id   TEXT NOT NULL REFERENCES crm_drive_file_registry(drive_file_id) ON DELETE CASCADE,
  drive_file_ref  TEXT NOT NULL CHECK (length(drive_file_ref) = 64 AND drive_file_ref NOT GLOB '*[^0-9a-f]*'),
  content_sha256  TEXT NOT NULL CHECK (length(content_sha256) = 64 AND ... hex),
  drive_version   TEXT, drive_modified_at TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 0),
  first_seen_at   TEXT NOT NULL, intake_run_key TEXT NOT NULL,
  UNIQUE (drive_file_id, content_sha256)           -- نفس البصمة لنفس الملف لا تُسجَّل مرتين
);
CREATE TABLE IF NOT EXISTS crm_drive_intake_run (
  run_key TEXT PRIMARY KEY, listing_sha256 TEXT NOT NULL, plan_sha256 TEXT NOT NULL,
  watermark_modified_at TEXT NOT NULL, files_seen INTEGER, files_new INTEGER,
  files_duplicate INTEGER, files_versioned INTEGER, files_other INTEGER,
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported = 0),   -- لا استيراد في أي تشغيل استقبال
  linked INTEGER NOT NULL DEFAULT 0 CHECK (linked = 0)        -- لا ربط تلقائي أبدًا
);
```
جدولة الاستكشاف: `watermark_modified_at` + مسح تطبيقي كامل أسبوعي (لأن `modifiedTime` لا يغطي كل
تغيّر، والمجلد قد يُعدَّل من خارج الأداة). `CHECK (imported = 0)` يجعل «الاستقبال لا يستورد» حقيقة
مفروضة في المخطط، لا عرفًا.

## 4) منع التكرار

بوحدته: `UNIQUE(drive_file_id, content_sha256)` داخل `crm_drive_file_version` + `duplicate_of_file_id`
في السجل. إعادة تشغيل نفس القائمة ⇒ نفس الخطة ⇒ `unchanged` للجميع (مقيس في `selftest`:
idempotent + ثابت تحت إعادة الترتيب). لا قرار تكرار يُبنى على الاسم أو الحجم — يرفضه المولّد أصلًا
(مقيس: «provisional fingerprint can never declare a duplicate»).

## 5) التحليل منفصل عن الاستقبال

الاستقبال يكتب: `crm_drive_file_registry` (+ 0010) و`crm_drive_review_seal`. التحليل يعمل كما هو في
0008 على مخرجات الاستقبال، ضمن `run_key` مستقلّ، ولا يقرأ Drive. بينهما عقد صريح: لا يستحق ملف
`processing_status='processed'` قبل `content_sha256` موثَّقة (القاعدة 8؛ موجود كفرض في 0007).

## 6) لا دخول تلقائي للعميل إلى CRM الفعّال

- لا كتابة من مسار الاستقبال في `crm_contacts` / `crm_contact_phones` / `crm_opportunities` /
  `crm_conversations` / `crm_conversation_messages`: **يفرضه** عدم وجود أي مسار كتابة، ويُقاس في CI
  بعدّ ما قبل/بعد (نفس `buildOperationalCountQueries` الذي يعطي اليوم `crm_rows_unchanged=yes(60:64:83:76:2984:4:66)`).
- `import_performed = 0` و`auto_link = 0` مقيسان فعليًّا في كل تشغيل (`P4 payload guard`, `iso=ok(...)`).
- المرشّحات تُكتب في `crm_drive_match_candidate` بحالة `unmatched_review` وتُفتح لها **حالة مراجعة** في
  0009؛ الموافقة قرار إنسان بعد `reveal` (بوابة `trg_review_event_approve_needs_fresh_reveal`).

## 7) توجيه الجديد إلى المراجعة/الاعتماد

**الختم عند الاستقبال** هو ما ينقص فعلًا: لا سطر `crm_drive_review_seal` يمكن إنتاجه لاحقًا لأن bytes
الأصل لم تُحفَظ قط (ثغرة المرحلة 4 المسجَّلة في تقرير الإغلاق). لذا في 0009:
عند اكتمال تجزئة عنصر ⇒ يُختم نصّه (بطاقة vCard كاملة أو مقطع المحادثة ذو الصلة) بـ AES-256-GCM،
المفتاح في سرّ Worker منفصل لا يُقرأ من قاعدة البيانات، والسطر محكوم بـ:
`retention_days 1..90`، سقف 4 KiB، منع حذف الختم الحيّ، ومنع إعادة التشفير بمفتاح آخر
(`trg_review_seal_no_rekey`) — كلها موجودة ومُجرَّبة (113/113 + 116/116).
بدون ختم عند الاستقبال لا يوجد «كشف» لاحقًا ⇒ **لا تُقبل أي دفعة بدون `seal_written = files_sealed`**.

## 8) الأصول بلا تعديل

الاستقبال **قراءة فقط** على Drive: `files.get`/`files.list`/`files.copy` على نسخة مؤقتة عند الحاجة،
ولا `files.update`/`delete`/`patch` ولا تغيير أذونات ولا `anyoneWithLink`. النقل إلى
`90_archive_processed` / `91_archive_duplicates` / `99_review_hold` يبقى مؤجَّلًا إلى ما بعد اعتماد
إنساني صريح (المرحلة 3+)، ويُوثَّق لكل ملف إجراءٌ في سجل الإجراءات (القاعدة 11). أي حالة صلاحية غير
متوقعة ⇒ توقّف وتوثيق، لا تخمين.

---

## 9) البوابات التي يجب أن تُضاف مع 0010

1. `crm-review-0010-verify.yml` على غرار بوابة 0009: عدّ الكائنات، `abuse harness` على `node:sqlite`،
   و rehearsal على محرّك D1 المحلي — كلها بلا أسرار وبلا `--remote`.
2. `phase4-analysis` يظل الوحيد المخوَّل بلمس `nasr-crm-test-db`، وبوابة `authorize_apply =
   'APPLY-TO-TEST-DB'` لا تتغيّر؛ النشر يبقى مشروطًا بـ `crm-test-deploy` + `master` + النص الحرفي.
3. قياس «لم يُستورد شيء» في كل تشغيل استقبال: `imported=0`, `linked=0`, `crm_rows_unchanged=yes(...)`.
4. كناري خصوصية على كل مخرَج وسيط (لا أسماء/هواتف/نصوص في اللوجات أو الـ artifacts).
5. لا سرّ Drive في المستودع: إن أُقرّت آلية تشغيل تلقائي، تُضاف كـ `secret` في بيئة محميّة فقط، مع
   سجل تشغيل مقروء في اسم الفحص لا في الـ artifact.

## 10) أول مهمة تنفيذية (T0: مسلَّمة، و T1: التالية)

**T0 (مُنجزة في هذا الدور):** `scripts/crm/drive-intake-discovery.mjs` — مولّد خطة الاستقبال، مع
`selftest` داخلي (17/17) وضعَي `plan --listing … --registry …`؛ موثَّقة هنا، وقابلة للتشغيل على مخرَج
حقيقي من Drive بلا أن تلمس أي قاعدة.

**T1 (أول مهمة يجب أن تُنفَّذ — واضحة ومغلقة النطاق):**
> توليد `listing.json` + `registry.json` الحقيقيين وتشغيل الخطة عليهما، ثم مراجعة بشرية للحصيلة.
> 1. قراءة فقط: `files.list` على المجلد القانوني (المعرّف معروف لطارق ولا يُكتب في المستودع) ⇒
>    `/tmp/p2/listing.json`؛ واستعلام قراءة فقط على `nasr-crm-test-db` لجدول السجل ⇒
>    `/tmp/p2/registry.json` (أعمدة: `drive_file_ref`, `content_sha256`, `drive_modified_at`,
>    `drive_version`, `size_bytes` — بلا أسماء ولا هواتف).
> 2. `node scripts/crm/drive-intake-discovery.mjs plan --listing /tmp/p2/listing.json --registry /tmp/p2/registry.json > /tmp/p2/plan.json`
> 3. المطلوب كدليل: `counts` مُطابِقة للواقع Known (`unchanged = 100` هو المتوقع اليوم، وكل زيادة أو
>    نقصان سبب للمراجعة)، `plan_sha256` مسجَّل، ولا سطر في `plan.json` يحوي رقمًا من 9 أرقام أو بريدًا
>    (يُتحقَّق بنفس حارس الـ manifest)، ولا `register_duplicate` مبنية على بصمة `provisional`.
> 4. لا كتابة لأي قاعدة، ولا `git add` لملفات `/tmp/p2/*`. إن ظهر أي `register_new` ⇒ يفتح دفعة مراجعة
>    في 0009 بقواعد هذه الخطة، ولا استيراد.
> **حالة التوقف:** أي تعذّر لضمان هدف الكتابة، أو ظهور حالة صلاحية غير متوقعة على Drive ⇒ توقّف
> وتوثيق في التقرير، لا تجاوز.

**T1 (منجزة بالنسخة النهائية — التقرير: `CRM_PHASE2_DRIVE_T1_RECONCILIATION.md`):**
المصدران قُرئا من أصلهما، ولا إعادة بناء لأي جانب:
- Drive: لقطة مقيّدة بنافذة مجمّدة (`modifiedTime <= W`) وترتيب حتمي، على صفحتين (51 + 50)، مع شاهد
  `modifiedTime > W`返回 0 صفا ⇒ لا شيء وصل أثناء الالتقاط. **المجلد يحوي 101 ملفا** (90 ZIP + 11 VCF):
  ظهر بطاقة 1540 بايت اليوم 2026-11-02T11:05:06Z.
- السجل: استعلام قراءة فقط `SELECT` واحد على `nasr-crm-test-db.crm_drive_file_registry` شغّله
  `.github/workflows/crm-drive-registry-snapshot.yml` ونشر الناتج المزيَّف كتعليق على PR، تُسحبُه
  الأداة برمجيا؛ لا نسخ يدوي ولا artifacts ولا قراءات سجل. **99 صفا**، كلها `processed` وببصمة محتوى.
- مفتاح المطابقة في الطرفين هو `driveRefHash` من نفس الملف المصدر (`_worker/crm-wa-vcard-analysis.js`)،
  بلا أي صيغة بديلة.

الحصيلة: `unchanged=99`, `register_new=2`, وبقية الحالات `0`؛
`plan_sha256 = eae1efe2a36283913c01bf53ed942e4063159348d52023e44513e1f2c0bb617d`.
الاختلاف (101 مقابل 99) مُبلَّغ كما هو؛ لم يُحذف الملف المئة من القائمة لإجبار التطابق، ولم تُخترع
صف للسجل. الملفان غير المسجَّلَين (1540 و514 بايت) أكّدهما قراءة `files.get` فردية لكل منهما.

ما بقي انحرافا معلنا واحدا: قائمة Drive تمرّ هذه الدورة عبر نص المحادثة لأن موصل Drive لا يملك أي
أداة تحفظ ناتج `list` في مساحة العمل (جرى فحص الأدوات الـ49 كلها)؛ لذلك لم تُوثَق الثقة بل القابلية
للتكذيب: مجموعة الـ99 refs المحسوبة من معرّفات D1 نفسها تساوي بالضبط مجموعة أقدم 99 ملفا في لقطة
Drive (نفس `refs_sha256` الذي نشره CI)، وأي حرف منقول خطأ كان سيكسر الوصل.

اكتشاف هندسي لتصميم T2: لا يوجد عمود نسخة في `0007` (`drive_version`/md5/etag غائبة) رغم أن ملفات
المجلد عند نسخ 2–6، فلا تُرى استبدالات المحتوى بنفس الحجم والتاريخ؛ ولا تُبنى حالة مراجعة في 0009
لملف بلا جهة (`crm_contact_id NOT NULL`). لا تطبيق migration، ولا كتابة لـ D1، ولا تعديل Drive،
ولا نشر، ولا دمج لأي PR — بانتظار موافقتك على T2.
