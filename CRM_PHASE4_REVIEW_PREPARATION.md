# تجهيز المراجعة البشرية (Human Review Preparation) — تصميم وخطة واختبارات ومخاطر

> **حالة هذه الوثيقة:** تصميم فقط. **لم يُعدَّل أي كود، ولم تُنشأ أي هجرة، ولم تُمسّ أي قاعدة.** لم يبدأ أي استيراد أو ربط أو دمج أو نشر، ولم يُدمج PR #132. المطلوب: موافقتك على البنود في القسم 11 قبل أي تنفيذ.
> **المرجع:** `CRM_PHASE4_ANALYSIS_REPORT.md` (التحليل) و`CRM_PHASE4_REVIEW_REPORT.md` (المراجعة التكميلية). المراجع الحية: `41310500421`, `41310819463`, `41325455688`, `41325695420`.

---

## 1. نتيجة الفحص: ممكنة داخل CRM الحالي دون توسيع أي صلاحية

ما هو موجود فعلًا ويُبنى عليه (بمواضع الشواهد من الكود):

| القدرة المطلوبة | الموجود الآن | الموضع |
|---|---|---|
| مصادقة بجلسة + CSRF + منع طلبات المواقع الأخرى | `crm_sessions` (`token_hash`, `csrf_hash`, `expires_at`, `revoked_at`) + `x-crm-csrf` + `cross_site_forbidden` | `0002_crm_internal_auth.sql`، `crm-worker.js:336-390` |
| هوية «مَن قرّر» مقيَّدة برمز غير آلي | `recordHumanReviewDecision(...)` يرفض `approved/rejected` بدون `reviewer` صريح (≥3) وليس في قائمة `NON_HUMAN_REVIEWERS` (`auto`,`system`,…) وبلا `reviewedAt`/`reviewNotes` | `crm-drive-file-registry.js` |
| واجهة CRM بلوحات قابلة للإضافة | `_worker/crm-ui/crm.html` (لوحات `<section class="panel" hidden>`) + `crm-client.js`، تُقدَّم عبر `[assets] directory = "crm-ui"` مع `run_worker_first = true` | `wrangler.crm.toml` |
| مسارات API مركزية وسهلة الإضافة | جدول `GET` (سطر ~2455) وجدول `POST` (~2465) + `/api/ingest/sealed` | `crm-worker.js` |
| تحمّل «الجدول غير موجود بعد» | نمط `hasTable(db, …)` و`inspectSchema0006` المستعمل حاليًا | `crm-worker.js:1130-1311` |
| اختبارات واجهة ومسارات جاهزة للتوسيع | `crm-ui.test.mjs`, `crm-worker.test.mjs`, `worker-safety.test.mjs`, `crm-audit-remediation.test.mjs`, ومِشْبار DOM (`_dom-page.mjs`) وe2e حيّ (`live-e2e-runner.mjs`) | `_worker/tests/` |

**فجوتان حقيقيتان يجب أن تُسدا (وهذا سبب الحاجة إلى هجرة جديدة):**

1. **لا يوجد سجل تدقيق غير قابل للمحو:** لا يوجد ولا `CREATE TRIGGER` في كل الهجرات (`grep RAISE(ABORT|TRIGGER` = 0). والأسوأ: `crm_contact_audit_log` **قابل للتعديل فعليًا** — الكود ينفّذ `UPDATE crm_contact_audit_log SET contact_id = NULL …` (`crm-worker.js:1273`)، و`contact_id` فيه `ON DELETE CASCADE`، و`action_type` مقيّد بتسعة قيم تخصّ العملاء لا المراجعة. **لذلك لا يُعاد استخدامه**: قرار المراجعة يحتاج طاولته الخاصة + مشغّلات منع.
2. **لا وجود لكيان «حالة مراجعة»:** طاولات المرحلة الرابعة (0008) للتحليل فقط ولا تحمل حالة قرار؛ والقرار يجب ألا يُخزَّن في جدول عميل (يتعارض مع فصل البيانات).

**القيود التي لا يمسّها التصميم:** لا نقطة نهاية عامة (كل المسارات خلف الجلسة نفسها)، لا قراءة/كتابة في `nasr-market-db`، لا صلاحيات Drive جديدة للـ Worker، لا تعديل إعدادات إنتاجية، ولا أي مسار يغيّر `crm_contacts`/`crm_contact_phones`/`crm_opportunities`/`crm_conversations`.

---

## 2. مجموعة الحالات المعروضة للمراجعة (64 عنصرًا، مشتقّة بالاستعلام لا بالنسخ)

| مجموعة | العدد | المصدر | ملاحظة |
|---|---:|---|---|
| `f1e4b581` — بطاقات الملف الكبير | **49** | `exact_match` على الملف | 49 بطاقة ↔ 49 جهة |
| الملفات الثلاثة الأخرى | **12** | `exact_match` | `b8bdd086` (6) + `2856aeb9` (4) + `84a7f76f` (2) |
| الحالة `p4r-062` | **1** | `probable_match` | تداخل نصوص مع ملف مطابق (`8c52ae5c`, ZIP) |
| الجهتان متعدّدتا الملفات | **2** | `crm_contact_id` يظهر في ملفّين | `fan=2file:2contact` — مسألة «تكرار عميل» لا «ربط» |
| **الإجمالي** | **64** | | الـ 62 الأولى حالات «بطاقة↔جهة»؛ والاثنان الأخيران **حالتا جهة** تُعرضان بشكل مستقل |

قواعد التوليد (ثابتة وقابلة لإعادة الإنتاج، وهي نفس ترتيب الكشف في التقرير التكميلي):

```sql
-- حالات «بطاقة ↔ جهة»: 61 exact + 1 probable
WITH ordered AS (
  SELECT mc.*, fa.content_kind,
         ROW_NUMBER() OVER (ORDER BY CASE mc.match_class WHEN 'exact_match' THEN 1 ELSE 2 END,
                                mc.drive_file_id, mc.evidence, mc.crm_contact_id) AS n
    FROM crm_drive_match_candidate mc
    LEFT JOIN crm_drive_file_analysis fa ON fa.drive_file_id = mc.drive_file_id
   WHERE mc.match_class IN ('exact_match','probable_match')
)
SELECT printf('p4r-%03d', n) AS case_ref, * FROM ordered;      -- 62 صَفًّا

-- الجهتان متعدّدتا الملفات (تُرقَّم p4c-01, p4c-02 لأنها حالات جهة لا ملف)
SELECT crm_contact_id, COUNT(DISTINCT drive_file_id) AS files,
       GROUP_CONCAT(DISTINCT drive_file_id) AS file_ids
  FROM crm_drive_match_candidate
 WHERE match_class IN ('exact_match','probable_match') AND crm_contact_id IS NOT NULL
 GROUP BY 1 HAVING files > 1 ORDER BY crm_contact_id;           -- 2
```

`case_ref` مشتق من `run_key` + الترتيب التعريفي، فهو **مستقر** طالما لم تتغيّر الحزمة أو قاعدة CRM؛ وإذا تغيرت، تُعاد التوليد بنفس القاعدة ويُسجَّل `analysis_run` الجديد في الصف.

---

## 3. طبقة البيانات — مسودة `0009_crm_drive_review_workflow.sql` (غير مطبَّقة)

مبدأ: **حدث-منبع** (event-sourced) — الحالة الحالية تُشتق من سجل الأحداث؛ فلا يوجد عمود «قابل للتعديل» يضيع عنده التاريخ.

```sql
-- (1) فهرس حالات المراجعة — يُعاد بناؤه idempotent لكل run_key
CREATE TABLE IF NOT EXISTS crm_drive_review_case (
  case_ref      TEXT NOT NULL PRIMARY KEY CHECK (case_ref GLOB 'p4r-[0-9][0-9][0-9]' OR case_ref GLOB 'p4c-[0-9][0-9]'),
  case_kind     TEXT NOT NULL CHECK (case_kind IN ('file_to_contact','contact_fanout')),
  run_key       TEXT NOT NULL REFERENCES crm_drive_analysis_run(run_key) ON DELETE CASCADE,
  drive_file_id TEXT CHECK (drive_file_id IS NULL OR length(trim(drive_file_id)) > 0),
  match_class   TEXT CHECK (match_class IS NULL OR match_class IN
                 ('exact_match','probable_match','name_only_match','conflict',
                  'third_party_review','temporary_review','unmatched')),
  evidence_type TEXT NOT NULL CHECK (length(trim(evidence_type)) BETWEEN 3 AND 200),
  confidence    TEXT NOT NULL CHECK (confidence IN ('none','low','medium','high')),
  signal_kind   TEXT CHECK (signal_kind IS NULL OR signal_kind IN ('phone','name')),
  signal_digest TEXT CHECK (signal_digest IS NULL OR
                 (length(signal_digest) = 64 AND signal_digest NOT GLOB '*[^0-9a-f]*')),
  crm_contact_id TEXT CHECK (crm_contact_id IS NULL OR length(trim(crm_contact_id)) > 0),
  source_content_kind TEXT CHECK (source_content_kind IS NULL OR source_content_kind IN ('ZIP','VCF','TXT')),
  -- الأساس الموثوق الذي يسمح بالاعتماد: هاتف من vCard TEL أو تسمية مُرسِل — لا اسم، لا نص رسالة
  basis TEXT NOT NULL CHECK (basis IN ('vcard_tel','sender_label_phone','transcript_overlap','name_digest','body_text')),
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                 AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  built_at      TEXT NOT NULL,
  UNIQUE (run_key, case_ref)
);

-- (2) سجل الأحداث: القرار + الكشف + الملاحظة — append-only بصرامة
CREATE TABLE IF NOT EXISTS crm_drive_review_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_sha256  TEXT NOT NULL UNIQUE CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'),
  case_ref      TEXT NOT NULL CHECK (case_ref GLOB 'p4r-[0-9][0-9][0-9]' OR case_ref GLOB 'p4c-[0-9][0-9]'),
  event_type    TEXT NOT NULL CHECK (event_type IN
                 ('approve','exclude','defer','conflict_investigation','reveal','note')),
  reviewer      TEXT NOT NULL CHECK (length(trim(reviewer)) BETWEEN 3 AND 120),
  reason        TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 12 AND 1000),
  case_snapshot_sha256 TEXT NOT NULL CHECK (length(case_snapshot_sha256) = 64
                 AND case_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  basis_at_event TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  session_hash  TEXT NOT NULL CHECK (length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  -- (5) اعتماد بطاقة لا يربط ولا يدمج شيئًا — مسمار في المخطط لا في النص
  link_applied  INTEGER NOT NULL DEFAULT 0 CHECK (link_applied = 0),
  merge_authorized INTEGER NOT NULL DEFAULT 0 CHECK (merge_authorized = 0),
  supersedes_id INTEGER CHECK (supersedes_id IS NULL OR typeof(supersedes_id) = 'integer'),
  prev_sha256   TEXT NOT NULL CHECK (length(prev_sha256) = 64 AND prev_sha256 NOT GLOB '*[^0-9a-f]*'),
  chain_sha256  TEXT NOT NULL CHECK (length(chain_sha256) = 64 AND chain_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- (6) لا اعتماد建立在 تشابه الاسم وحده
  CHECK (event_type != 'approve' OR basis_at_event IN ('vcard_tel','sender_label_phone')),
  CHECK (event_type NOT IN ('approve','exclude') OR length(trim(reviewer)) >= 3)
);
CREATE INDEX IF NOT EXISTS idx_crm_drive_review_event_case ON crm_drive_review_event(case_ref, id DESC);

-- (3) عدم القابلية للمحو: لا تعديل ولا حذف (المسار الوحيد للتصحيح هو حدث جديد يستبدل السابق)
CREATE TRIGGER IF NOT EXISTS trg_review_event_no_update BEFORE UPDATE ON crm_drive_review_event
BEGIN SELECT RAISE(ABORT, 'review_events_are_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_event_no_delete BEFORE DELETE ON crm_drive_review_event
BEGIN SELECT RAISE(ABORT, 'review_events_are_append_only'); END;

-- (4) رأس السلسلة مُعلَن ومُثبَّت: يمنع إعادة كتابة تاريخ السلسلة بصمت
CREATE TABLE IF NOT EXISTS crm_drive_review_chain_head (
  run_key    TEXT NOT NULL PRIMARY KEY REFERENCES crm_drive_analysis_run(run_key) ON DELETE CASCADE,
  head_sha256 TEXT NOT NULL CHECK (length(head_sha256) = 64 AND head_sha256 NOT GLOB '*[^0-9a-f]*'),
  events     INTEGER NOT NULL CHECK (events >= 0),
  updated_at TEXT NOT NULL
);
```

خصائص مقصودة: لا عمود اسم/هاتف/نص رسالة في الطاولتين؛ `case_ref` بلا FK إلى الجرد حتى لا يكسر إعادة البناء؛ `run_key` يربط الحالة ببصمة الحزمة (`payload_fingerprint`)؛ الأحداث تُصحَّح بحدث `supersedes_id` لا بتعديل؛ والحالة الحالية = آخر حدث لكل حالة (استعلام `ROW_NUMBER()` موثَّق).

---

## 4. طبقة الخدمة — 5 مسارات جديدة فقط، كلها خلف الجلسة الحالية

| المسار | وظيفة | قواعد صارمة |
|---|---|---|
| `GET /api/review/cases` | قائمة الحالات (تصفية: `state`, `file`, `class`, `fanout`) | بدون أسماء/أرقام؛ `limit ≤ 100`؛ حقول: `case_ref`, `match_class`, `evidence_type`, `confidence`, `basis`, `file_ref8`, `content_kind`, `card_summary` |
| `GET /api/review/case?ref=` | تفاصيل حالة + تاريخ قراراتها + بصمة اللقطة | نفس سياسة المنع + `no-store` |
| `POST /api/review/decision` | تسجيل قرار: `approve` / `exclude` / `defer` / `conflict_investigation` | `reason ≥ 12`؛ `reviewer` ≥3 وغير آلي (نفس `NON_HUMAN_REVIEWERS`)؛ CSRF؛ لا يُقبل `approve` إن `basis` ليس `vcard_tel`/`sender_label_phone`؛ لا يوجد أي حقل `contact_id`/`link` في الجسم |
| `POST /api/review/reveal` | عرض بيانات البطاقة الأصلية عند الحاجة فقط | يتطلب `reason` و`purpose ∈ {'identity_check','duplicate_check','contact_clarify'}`؛ يكتب حدث `reveal`؛ **لا يُخزَّن المُظهِر في السجل ولا في الاستجابة المؤقتة خارج الطلب** |
| `GET /api/review/integrity` | التحقق من سلسلة التدقيق وإرجاع `head_sha256` | قراءة فقط؛ يُستدعى من CI لتثبيت الرأس في Git |

مساران إداريان فقط (خارج واجهة المستخدم، تشغيلهما عبر سير عملCI كبقية المراحل): `POST /api/review/rebuild` (إعادة توليد `crm_drive_review_case` من آخر `run_key`) و`GET /api/review/export?format=digest` (تصدير غير كاشف: `case_ref` + رموز فقط، لا أسماء ولا أرقام — لتوليد كشف مثل `p4r-…`).

**لا يوجد أي مسار يربط أو يدمج** (لا `POST /api/review/link`، لا `merge`) — الحظر مزدوج: المخطط (`link_applied=0`, `merge_authorized=0`) وغياب المسار أصلًا (القيد 5 و6).

### الوصول الآمن إلى بيانات البطاقة الأصلية — ثلاثة خيارات

مصدر الحقيقة اليوم: المحتوى موجود في Drive فقط؛ **لا شيء منه في القاعدة** (بهذا صُمِّمت المرحلة الرابعة). للخيارات:

| خيار | الآلية | المزايا | الكلفة/المخاطر | قرار مقترح |
|---|---|---|---|---|
| **A. حزمة مفاتيح مغلّفة في القاعدة** | وقت التطبيق يُخزَّن لكل حالة `sealed_blob` (AES-256-GCM/ECDH بنفس نمط `p3reg_v1`) بحجم ≤ 4 KB، وفكّه داخل Worker بمفتاح من **Worker secret** | كشف فوري من الشاشة، مع دليل «ماذا رُئي» (`case_snapshot_sha256`) | سرّ جديد في Cloudflare + PII مشفّر داخل القاعدة (بحدّ بقاء)؛ يتطلب موافقتك الصريحة | **موصى به** إن أردت الكشف داخل الشاشة |
| **B. كشف دون اتصال (بدون أي PII في القاعدة)** | ملف محلي مشفّر كما في التقرير التكميلي (`phase4-review-register.tsv.enc`) للمراجعة، والقرار يُدخل في الشاشة بالمرجع فقط | لا إضافة أسرار، لا PII في D1، أقل مساحة هجوم | نقل يدوي بسيط بين الملف والشاشة | **المسار الافتراضي** لو أردت أقل تغيير ممكن |
| **C. قراءة من Drive وقت العرض** | Worker يحمّل الملف عند الطلب | لا تخزين إطلاقًا | **مرفوض**: يتطلب صلاحيات Drive جديدة للـ Worker ويخالف «عدم توسيع الصلاحيات/المصادقة» | لا |

**توصيتي:** ابدأ بـ B (قادر على العمل فور 0009 دون أي سرّ جديد)، وأضِف A لاحقًا كخيار محسَّن إن احتجت الكشف داخل الشاشة. في الحالتين: الاستجابة لا تحتوي نص المحادثة ولا مجلدات كاملة، ولا تُسجَّل نتائجُه في سجلات الخادم (لا `console.log` لمحتوى الكشف — اختبار ثابت يضمن ذلك).

---

## 5. طبقة الواجهة — لوحة «مراجعة مصادر CRM» داخل `crm.html`

- لوحة جديدة `<section class="panel" id="review-panel" hidden>` + تبويب في القائمة الحالية، بلا لمس لوحات العملاء/الفرص/المحادثات (فصل البيانات: لا تعرض اللوحة أيًّا منها، وكل رابط إلى جهة اتصال يكون `case_ref` فقط).
- عمودا العمل: **قائمة يسار** (64 حالة: المرجع، النوع، الدليل، الثقة، `file_ref8`، «متعدد الملفات» للجهتين) + **لوحة يمين** (الحالة: سبب الثقة، التاريخ الكامل للقرارات، زر «طلب كشف» مع حقل سبب + قائمة غرض).
- أزرار القرار الأربعة بلون دلالي + ملاحظة نصية إلزامية (12 حرفًا) + تأكيد قبل `approve` يشرح صراحةً: «الاعتماد لا يربط أي محادثة أو فرصة».
- اختصارات: `A` اعتماد، `X` استبعاد، `D` تأجيل، `C` تعارض، `R` كشف، `↑/↓` تنقّل؛ وشريط تقدّم `17/64`؛ وحالة «فارغ» تعرض سبب الفراغ (لا حالة صامتة).
- اللوحة تعمل offline-read (PWA): القائمة تُخزَّن مؤقتًا **بلا** أي بيانات كشف؛ الكشف لا يُعرض إلا طلب حيّ ناجح، ولا يُكتب في `localStorage` إطلاقًا.
- اللوحة لا تظهر أصلًا إن لم تكن 0009 مطبَّقة (`hasTable` → عرض «غير مُفعَّلة بعد» بدل خطأ)، وهي نفس العادة الحالية في الكود.

---

## 6. كيف تُترجَم قيودك إلى حواجز ملموسة

| # | قيودك | الحاجز | أين يُختبَر |
|---|---|---|---|
| 5 | اعتماد بطاقة ≠ ربط محادثة/فرصة | لا مسار ربط؛ `CHECK (link_applied = 0)`؛ `case_ref` لا يحمل `conversation_id` | اختبار: `INSERT … link_applied=1` يفشل؛ اختبار: لا يوجد مسار في الجدول |
| 6 | لا دمج بالاسم وحده | لا قرار `merge` أصلًا؛ `CHECK (event_type != 'approve' OR basis_at_event IN ('vcard_tel','sender_label_phone'))`؛ `CHECK (merge_authorized = 0)` | اختبار: محاولة `approve` على حالة `basis='name_digest'` تُرفض (وليس فقط واجهة) |
| 4 | من/متى/لماذا + سجل غير قابل للمحو | `reviewer` ≥3 و`NON_HUMAN_REVIEWERS` و`occurred_at` و`reason ≥ 12` + `BEFORE UPDATE/DELETE` → `RAISE(ABORT)` + سلسلة `prev_sha256/chain_sha256` + رأس معلَن | اختبار: `UPDATE`/`DELETE` يفشل بالرسالة؛ اختبار: كسر السلسلة يُكتشف |
| 7 | لا PII في Git/CI/التقارير | لا اسم/هاتف/نص في أي طاولة مراجعة؛ سِجل CI يطبع `case_ref` وعدّادات فقط؛ اختبار «canary» خاص بمسارات المراجعة | اختبار + فحص ساكن على الـ diff مثل `privacy-canary.test.mjs` |
| 1 | فصل الشخص/الهاتف/الفرصة/المحادثة | طاولتا مراجعة منفصلتان؛ لا `ALTER` على الطاولات التشغيلية؛ لا `UPDATE` عليهما في أي مسار جديد | اختبار: مجموعة عبارات SQL للمراجعة لا تذكر إلا الطاولات الثلاث |
| 9 | لا استيراد/ربط/دمج/تعديل تشغيلي | لا كتابة إلا على `crm_drive_review_case/event/chain_head` + `crm_conversations` و`crm_contacts` خارج قائمة الكتابة برمجيًا (allow-list) | اختبار + بوابة CI (عدّادات قبل/بعد) |

---

## 7. الاختبارات المخطَّطة (قبل أي نشر، وعلى قاعدة معزولة أولًا)

**وحدات (تُضاف إلى `_worker/tests/crm-phase4-review.test.mjs`، مُسماة 1..18):**
1. توليد الحالات: 62 + 2، وترتيب `case_ref` مستقر عبر إعادة بناء مزدوجة.
2. `case_snapshot_sha256` يتغير لو تغيّر أي حقل مُعترَض به (برهان «ماذا رُئي»).
3. منع `approve` عندما `basis='name_digest'` أو `'body_text'` (قيد 6).
4. منع `approve` بدون `reviewer` بشري (إعادة استعمال `NON_HUMAN_REVIEWERS`) وبدون `reviewedAt`.
5. `UPDATE` و`DELETE` على `crm_drive_review_event` → `review_events_are_append_only`.
6. تصحيح القرار = حدث جديد بـ `supersedes_id`، والحالة المشتقة تُظهر الأحدث فقط.
7. سلسلة `prev/chain` سليمة؛ وطمس/إعادة ترتيب حدث يكسر `head_sha256`.
8. `link_applied=1` و`merge_authorized=1` مرفوضان.
9. إعادة بناء الحالات idempotent: لا مضاعفة ولا فقد قرارات (القرارات مرتبطة بـ `case_ref` لا بمعرّف متغيّر).
10. `reason` < 12 حرفًا مرفوض؛ و`reason` يُطهَّر من وسوم/تحكم.
11. استجابات `cases`/`case` لا تحتوي حقلًا اسمه `name|phone|body|transcript` ولا نصًّا عربيًا (canary داخلي).
12. `reveal` يكتب حدثًا ولا يخزن القيمة المكشوفة؛ ولا `console.log` لها (اختبار ثابت على المصدر).
13. المسارات تُنكر بلا جلسة (401) وبلا CSRF (403) ومن أصل مخالف (403 `cross_site_forbidden`).
14. اللوحة مخفية و`/api/review/*` يرجع `503 review_not_installed` قبل تطبيق 0009.
15. حدّ حجم حزمة الكشف (≤ 4 KB) ورفض `sealed_blob` أكبر؛ وقابلية فك التشفير round-trip.
16. لا مسار ولا عبارة SQL تكتب على أي طاولة تشغيلية (فحص allow-list لمولّد العبارات).
17. الأرقام الستون للجهات/الملفات في اللوحة تطابق قاعدة الاختبار (اختبار تكاملي على D1 معزولة).
18. خصوصية CI: لا سطر في مخرجات سير العمل يطابق نمط هاتف/بريد/معرّف Drive (نفس فحوص المرحلة الرابعة).

**تكامل/CI (سير عمل جديد `crm-phase4-review-ui.yml` بنفس قالب المراحل السابقة):** قاعدة D1 معزولة (0001..0009) أولًا → `d1_migrations = 9` → تطبيق 0009 على `nasr-crm-test-db` → توليد الحالات → 18 اختبارًا محليًا يجب أن تمر → **إثبات عدم التغيير**: 12 عدّادًا تشغيليًا قبل/بعد متطابقة (`60:64:83:76:2984:4:66:21:21:99:99:191`) + `crm_drive_review_*` معزولة + `backup_untouched` + `market_untouched` + تثبيت `head_sha256` في اسم الوظيفة (لا في ملف).

**واجهة:** توسيع `crm-ui.test.mjs` (تخطيط اللوحة، شارات الحالة، اختصارات، «الحالة فارغة»، عدم عرض أسماء) و`worker-safety.test.mjs` (منع تسريب حقول PII)، ثم e2e حيّ عبر `live-e2e-runner.mjs` على `nasr-crm-api-test` بقراءة حالة واحدة فقط.

---

## 8. خطة التنفيذ (كل مرحلة متوقفة على موافقتك)

| مرحلة | عمل | ناتج ملموس | تقدير | بوابة |
|---|---|---|---|---|
| P0 | تثبيت مجموعة الحالات: `GET /api/review/cases` على صيغة قراءة فقط + كشف `p4r` نهائي بعدد 64 | وثيقة «ما ستراجعه» + أسماء الوظائف في CI | 0.5 يوم | موافقتك على القائمة |
| P1 | `0009_crm_drive_review_workflow.sql` + 18 اختبارًا + CI على قاعدة معزولة (بدون تطبيق حيّ) | هجرة + خضرة الاختبارات | 1 يوم | مراجعة الـ DDL منك |
| P2 | طبقة الخدمة: `crm-drive-review.js` (توليد/قرار/كشف/سلسلة) + مسارات API + `hasTable` gate | كود + اختباراته (لا تطبيق بعد) | 1 يوم | — |
| P3 | لوحة `crm.html` + `crm-client.js` + اختبارات DOM | واجهة تعمل محليًا | 1 يوم | — |
| P4 | تطبيق 0009 على `nasr-crm-test-db` عبر CI (مع كل البوابات) وحده، **بدون Worker deploy** | العدّادات قبل/بعد + `head_sha256` | 0.5 يوم | موافقة صريحة على كتابة القاعدة |
| P5 | نشر على **Worker الاختبار** `nasr-crm-api-test` فقط + e2e حيّ + تقرير تحقق | شاشة تعمل | 0.5 يوم | موافقة صريحة على النشر |
| P6 | (اختياري) خيار A: حزم `sealed_blob` + سرّ Worker + سياسة بقاء 30 يومًا | كشف داخل الشاشة | 1 يوم | موافقة مستقلة |

**خطة التراجع:** P1–P3 قابلة للتراجع بحذف الملفات (لا أثر على البيانات). P4 لا يمسّ أي طاولة تشغيلية؛ التراجع = `DROP` من مشغّل D1 يدويًا (موثَّق، ولا يُنفَّذ تلقائيًا). P5 = إعادة نشر النسخة السابقة من Worker. السجل append-only **لا يُمحى** بالتراجع (وهو القصد).

---

## 9. المخاطر والتخفيف

| خطر | احتمال/أثر | تخفيف |
|---|---|---|
| «غير قابل للمحو» نسبي: من يملك حساب Cloudflare يستطيع SQL خام | متوسط / متوسط | مشغّلات + سلسلة hash + **رأس السلسلة مُثبَّت في اسم وظيفة CI وفي Git كل تشغيل** (بصمة فقط، لا PII) → أي إعادة كتابة تُكتشف؛ لا حل مطلق داخل D1 (لا فصل مستخدمين) — نقبله صراحة |
| رمز وصول مشترك = لا تمييز بين مراجِعَين تقنيًا | مؤكد / متوسط | `reviewer` إلزامي بنص حر + `session_hash` + رفض القيم الآلية؛ تمييز حقيقي يتطلب مصادقة متعددة المستخدمين (مرحلة مستقلة، خارج نطاق هذا) |
| إدخال PII عرضًا إلى جدول المراجعة (حقل ملاحظة) | متوسط / مرتفع | `reason` مُطهَّر ومحدود 1000؛ اختبار يمنع أنطماط هاتف/بريد داخل `reason`؛ تحذير في الواجهة «لا تكتب أرقامًا أو أسماء في الملاحظة» |
| الكشف يوسّع سطح التسريب (لو خُيِّر خيار A) | منخفض / مرتفع | حجم ≤ 4 KB، لا تخزين للنتيجة، حدث `reveal` إلزامي، لا رد في سجلات الخادم، ومفتاح في Worker secret لا في Git |
| زحف النطاق: «اعتماد» يُقرأ كتصريح ربط | متوسط / مرتفع | نص التأكيد في الواجهة + لا يوجد مسار ربط + `CHECK` في المخطط + قسم «ما لا يعنيه الاعتماد» في الوثيقة |
| عدم استقرار `case_ref` لو أُعيد التطبيق بعد تغيّر CRM | متوسط / متوسط | `case_ref` مثبَّت بـ `run_key` + `payload_fingerprint`؛ أي حزمة جديدة تولّد مجموعة بحالة جديدة ويُعلَن الفرق في CI |
| تعارض مع 0008/CI الحالي أو كسر بوابة الخصوصية | منخفض / مرتفع | هجرة إضافة خالصة (لا `ALTER` على جداول قائمة)؛ مسارCI خاص بنفس البوابات؛ `privacy-canary.test.mjs` يبقى أخضر |
| الجهتان متعدّدتا الملفات تُفهمان كـ«دمج» | متوسط / متوسط | عرضهما كحالة `contact_fanout` بقرار وحيد متاح `conflict_investigation`/`defer`، و`approve` غير متاح لهما برمجيًا |

---

## 10. ما لم يُنفَّذ في هذه الجولة (بالتحديد)

- لا كود مطبَّق: لا `0009`، لا `crm-drive-review.js`، لا مسارات، لا تعديلات على `crm.html`. (هذه الوثيقة تصميم فقط.)
- لا كتابة على أي قاعدة: لا DDL، لا DML؛ القراءة فقط جرت عبر `41325455688`/`41325695420` سابقًا.
- لم يُسجَّل ملف VCF 514 بايت ولم يُحلَّل؛ تقرير مصدره في `CRM_PHASE4_VCF514_PROVENANCE.md` وهو **بانتظار قرارك**.
- لا استيراد، لا ربط، لا دمج، لا تعديل جداول تشغيلية، لا `nasr-market-db`، لا نسخة احتياط، لا ملفات Drive (فوق ذلك: فحص `get_file` وصف بيانات فقط — لم يُنزَّل محتوى الملف الجديد ولم يُقرأ).
- لا نشر: لا Worker إنتاجي ولا اختبار، ولا GitHub Pages، ولا دمج PR #132 (ما زال `OPEN`/`mergedAt=null`).

---

## 11. قرارات أحتاجها منك (خمس نقاط)

1. **مجموعة الحالات:** 62 (بطاقة↔جهة) + 2 (جهة متعددة الملفات) = **64** كما في القسم 2 — هل نضيف أيضًا الحالات الـ 13 ✈ والـ 10 «أرقام نصية لها صف CRM» إلى نفس الشاشة لاحقًا (مرحلة تالية)، أم تبقى خارجها الآن؟
2. **الكشف الآمن:** خيار **B** (محلي مشفّر، بلا PII في القاعدة، بلا سرّ جديد) أم **A** (حزم مغلَّفة في القاعدة + سرّ Worker)؟ الافتراضي المقترح: B أولاً.
3. **هجرة 0009:** هل أعرضها للمراجعة كـ SQL فقط (P1) أم ننتقل مباشرة إلى P1+P2 معًا؟ ولا شيء يُطبَّق على القاعدة قبل موافقة P4.
4. **هوية المراجع:** هل نكتفي بـ `reviewer` نصي إلزامي (آلية المرحلة الثالثة نفسها) أم تُطلب مصادقة متعددة المستخدمين كمرحلة مستقلة قبل هذه الشاشة؟
5. **ملف 514 بايت:** هل تسجّله في الجرد الآن (خطوة إدارية، بلا تحليل ولا استيراد) بعد قراءة تقرير المصدر، أم تنتظر حتى نهاية شاشة المراجعة؟

> **توقّف:** لن أُعدّل كودًا ولا قاعدة بيانات قبل موافقتك على البنود 1–5. لا استيراد ولا ربط ولا دمج ولا نشر ولا دمج PR.
