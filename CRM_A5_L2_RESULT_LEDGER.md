# A5 — دفتر النتائج L2: الدليل الوحيد المقبول على ملكية السجلات الصناعية

> حالة المستند: تصميم + تنفيذ في الفرع الحالي. **لم يُنفَّذ أي نشر، ولم تُطبَّق أي Migration، ولم تُكتب أي قاعدة بيانات من هذا العمل.**
> قاعدة البيانات الوحيدة التي يُسمح بالكتابة فيها تبقى `nasr-crm-test-db`. `nasr-market-db` والنسخة الاحتياطية للقراءة فقط / محظورتان.

---

## 1) لماذا أُلغي L0 وL1 تمامًا

| الطبقة | ما كانت تثبته | سبب الرفض |
|---|---|---|
| L0 — نية ما قبل الكتابة | ملف manifest بـ `run_tag` ومفاتيح مشتقة + digest للملف | `run_tag` معلن (`GITHUB_RUN_ID` في عناوين URL وأسماء الـ artifacts)، والمستودع عام، و digest يثبت سلامة **الملف** فقط لا وجود **الصف** في D1. لا سرية فيه ولا دليل على صف. |
| L1 — الوسم داخل الصف | `review_note`، `phone_key`، `Idempotency-Key`، `source_ref`، `actor`/`reviewer`، `conversation_uid`، `contact_id` | **كلها حقول يتحكم بها العميل عبر HTTP عادي** (`crm-worker.js`: 1133–1135، 1344–1345، 2445–2448، 969–971). بوابة الجلسة عند 2643 لا تضيف بوابة صلاحية/دور، و`actorField` يقبل `A5-RUN:<tag>`. أي جلسة CRM صالحة تستطيع تزوير الوسم كاملًا. |
| `no-ledger(hard-cancel)` | قبول صفوف تشغيل سابق بلا دفتر عند الإلغاء القسري | **محذوف**. الإلغاء قبل أول حدث L2 ⇒ `unknown` ثم إيقاف صريح. لا حذف، لا تجاوز، لا إعادة تصنيف بالتخمين. |

**القاعدة الحاكمة:** ملكية أي صف صناعي تُثبت **فقط** بحدث L2 منشور، مُعرَّف بالتشغيل، داخل سلسلة تجزئة، يحمل `row_hash` مبنيًا على **معرّفات ولّدها Worker** لا يختارها مستدعي الـ API.

> ملاحظة أمنية مؤجلة عمدًا: حتى L2 هو «شهادة تشغيل موثوق» لا «توقيع تشفيري». الترقية إلى HMAC بمفتاح جديد أو بوابة دور داخل Worker مطلوبة لاحقًا؛ لم تُستبدل هنا بأي مسار بديل، ولم يُقرأ `CRM_SESSION_SECRET`.

---

## 2) هوية التشغيل والمفاتيح المشتقة

```
run_tag      = a5-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${nonce8}      // nonce8 = 8 hex، ثابت طوال التشغيل
TAG          = 'A5-RUN:' + run_tag                                       // يُوضع في review_note/actor/reviewer/source_ref
P(role)      = '999' + ( BigInt('0x'+sha256(run_tag+'|'+role).slice(0,16)) % 100000000 ).padStart(8,'0')
API(role)    = '+' + P(role)                                             // Worker يقبله و phone_key = P(role)
SUB(suffix)  = run_tag + ':' + suffix                                     // Idempotency-Key / submission_key
UID          = 'a5:' + run_tag + ':conv'                                 // conversation_uid
SEED         = 'A5-' + sha256('seed|'+run_tag).slice(0,16)                // Drive registry/case
```

`display name` (`TEST ONLY …`) **للعرض فقط**؛ لا يُستخدم في التصنيف ولا في العزل ولا في أي استعلام ملكية. لا يُستخدم `COUNT(*)` ولا `LIKE 'TEST ONLY%'` ولا «خلوّ النطاق» كشرط. لا تُشترط مساحة فارغة: المطلوب عدم تعارض **المفتاح الكامل** لهذا التشغيل فقط، وصفوف التشغيلات السابقة المُثبتة مسموح بوجودها.

### جدول «المصدر → الصيغة الدقيقة → قيد قاعدة البيانات → استعلام التحقق المسبق → استعلام التحقق اللاحق»

| المفتاح | المصدر | الصيغة الدقيقة | قيد المخطط | استعلام التحقق المسبق (قراءة فقط، مفتاح كامل) | استعلام التحقق اللاحق (قراءة فقط) |
|---|---|---|---|---|---|
| `crm_contacts.id` | جسم استجابة `POST /api/contacts` **201** | `contact_id` كما أرجعه Worker | `PRIMARY KEY` + `review_note TEXT NOT NULL DEFAULT ''` | `SELECT id FROM crm_contacts WHERE id = '<contact_id>' LIMIT 2` (في `finalize`) | `SELECT id FROM crm_contacts WHERE review_note LIKE 'A5-RUN:%' OR id IN (SELECT contact_id FROM crm_contact_phones WHERE phone_key LIKE '999%')` |
| `crm_contact_phones.phone_key` | `apiPhone(run_tag, role)`، من استجابة 201 / `addPhone` | `999` + 8 أرقام | `UNIQUE(phone_key)` + `CHECK(length 7..15 AND digits)` + `FK contact_id → crm_contacts(id)` | `SELECT id FROM crm_contact_phones WHERE phone_key = '<P(role)>' LIMIT 2` **و** `SELECT id FROM crm_contact_phones WHERE phone_key LIKE '%<P(role)>%' LIMIT 2` | `SELECT id,contact_id,phone_key FROM crm_contact_phones WHERE phone_key = '<P(role)>' LIMIT 2` |
| `crm_idempotency_receipts.submission_key` | `SUB(suffix)` | `run_tag + ':' + suffix` | `PRIMARY KEY` + نمط Worker `^[A-Za-z0-9._:-]{12,128}$` | `SELECT submission_key FROM crm_idempotency_receipts WHERE submission_key = '<SUB(suffix)>' LIMIT 2` | `SELECT submission_key,resource_type,resource_id FROM crm_idempotency_receipts WHERE submission_key = '<SUB(suffix)>' LIMIT 2` |
| `crm_customer_requests.id` / `dedupe_key` | جسم استجابة 201 | `request.id`؛ `dedupe_key` hash يُولّده Worker | `PK(id)` + `UNIQUE(dedupe_key)` + `FK contact_id` | `SELECT id FROM crm_customer_requests WHERE id = '<request_id>' LIMIT 2` | `SELECT id,contact_id,dedupe_key,… FROM crm_customer_requests WHERE id = '<request_id>' LIMIT 2` |
| `crm_interactions.id` / `dedupe_key` | جسم استجابة 201 | `interaction.id`؛ `dedupe_key` Worker-derived hex | `PK` + `UNIQUE(dedupe_key)` + append-only trigger | `SELECT id FROM crm_interactions WHERE id = '<id>' LIMIT 2` | `SELECT id,contact_id,request_id,dedupe_key,… FROM crm_interactions WHERE id = '<id>' LIMIT 2` |
| `crm_followups.id` / `dedupe_key` | جسم استجابة 201 | `followup.id` | `PK` + `UNIQUE(dedupe_key)` + `FK contact_id/request_id` | `SELECT id FROM crm_followups WHERE id = '<id>' LIMIT 2` | `SELECT id,contact_id,request_id,dedupe_key,… FROM crm_followups WHERE id = '<id>' LIMIT 2` |
| `crm_conversations.conversation_uid` | `UID` المرسل + `conversation_id` من الاستجابة | `a5:<run_tag>:conv` | `UNIQUE(conversation_uid)`؛ `source_ref` حر | `SELECT id FROM crm_conversations WHERE conversation_uid = '<UID>' LIMIT 2` | `SELECT id,conversation_uid,source_type,source_ref,raw_sha256 FROM crm_conversations WHERE conversation_uid = '<UID>' LIMIT 2` |
| `crm_drive_file_review_case.case_ref` | `seedReviewCaseStatements(seedTagFor(run_tag))` | `frw-<sha256('SYNTHLIVE'+SEED)[0:16]>-1` | `PRIMARY KEY(case_ref)` + `UNIQUE(drive_ref, bound_version_seq)` + `FK drive_ref` | `SELECT drive_ref FROM crm_drive_file_registry WHERE drive_file_id = 'SYNTHLIVE<SEED>' LIMIT 2` | `SELECT case_ref,drive_ref,… FROM crm_drive_file_review_case WHERE case_ref = '<case_ref>' LIMIT 2` |
| `crm_drive_file_review_decision.decision_sha256` | جسم استجابة `recordDriveReviewDecision` | digest سلسلة القرار (append-only) | `UNIQUE(decision_sha256)` + `UNIQUE(case_ref,decision_seq)` + `FK case_ref` | `SELECT decision_sha256 FROM crm_drive_file_review_decision WHERE decision_sha256 = '<digest>' LIMIT 2` | `SELECT id,case_ref,decision_seq,reviewer,session_hash,decision_sha256,… FROM crm_drive_file_review_decision WHERE decision_sha256 = '<digest>' LIMIT 2` |
| `crm_sessions.csrf_hash` | `sha256(csrf_token)` المستلم من الدخول (بلا سر) | 64 hex | `token_hash UNIQUE`؛ `csrf_hash` عمود عادي | `SELECT COUNT(*) … WHERE csrf_hash = '<hash>' AND revoked_at IS NULL` (حاجز 0014، صف واحد بالضبط) | `SELECT id,token_hash,created_at FROM crm_sessions WHERE csrf_hash = '<hash>' LIMIT 2` |
| `crm_request_status_history.seq` / audit / anchors / messages / insights | قراءة لاحقة فقط (`id_source='read-back'`) | `seq`/`id` ولّدتها القاعدة | append-only triggers + `UNIQUE` مركّبة | لا يوجد (تُنشأ كأثر جانبي) | استعلام الحصر `SELECT … FROM <table> WHERE <scope>` ثم حدث L2 مستقل لكل صف مع `parent` |

**لماذا `row_hash` على أعمدة الهوية فقط؟** لأن B يغيّر حالة صفوفه مشروعًا (`status`، `match_status`، `expires_at`، `head_version_seq`، `review_status`، `link_state` …). إدخال هذه الأعمدة في `row_hash` كان سيولّد `unknown` كاذبًا في كل تشغيل. لذلك تُستبعد صراحةً، ويُثبت `row_hash` على `PK` + المفتاح الفريد + الأب + بصمات المحتوى + أختام الإنشاء. **أي صف جديد** ينشأ عن trigger (مثل 0013 عند إكمال متابعة ⇒ سطر `crm_interactions`) هو سجل جديد بلا حدث ⇒ `unknown` وإيقاف؛ لا يُعتبر «تغيير حالة» ولا يُعفى.

### جدول تغطية الجداول (المصدر التنفيذي: `TABLE_SPECS` في `scripts/a5-l2.mjs`)

| الجدول | المفتاح الفريد `unique_key` | معرّف الصف `idColumn` | عمود الاسترجاع | الأعمدة الداخلة في `row_hash` | العلاقة الأبوية |
|---|---|---|---|---|---|
| `crm_contacts` | `id` | `id` | `id` | `id` | — |
| `crm_contact_phones` | `phone_key` | `id` | `phone_key` | `id`، `contact_id`، `phone_key` | `crm_contacts.contact_id` |
| `crm_idempotency_receipts` | `submission_key` | `submission_key` | `submission_key` | `submission_key`، `resource_type`، `resource_id` | `crm_contacts.resource_id` |
| `crm_customer_requests` | `dedupe_key` | `id` | `id` | `id`، `contact_id`، `dedupe_key`، `kind`، `property_type`، `source`، `created_at` | `crm_contacts.contact_id` |
| `crm_request_status_history` | `seq` | `seq` | `seq` | `seq`، `request_id`، `from_status`، `to_status`، `actor`، `changed_at` | `crm_customer_requests.request_id` |
| `crm_interactions` | `dedupe_key` | `id` | `id` | `id`، `contact_id`، `request_id`، `dedupe_key`، `kind`، `created_by`، `occurred_at` | `crm_contacts.contact_id` |
| `crm_followups` | `dedupe_key` | `id` | `id` | `id`، `contact_id`، `request_id`، `dedupe_key`، `created_by` | `crm_contacts.contact_id` |
| `crm_operational_audit_log` | `seq` | `seq` | `seq` | `seq`، `entity`، `entity_id`، `contact_id`، `action`، `actor`، `detail_sha256`، `occurred_at` | — |
| `crm_contact_audit_log` | `id` | `id` | `id` | `id`، `contact_id`، `action_type`، `field_name`، `source_ref`، `actor`، `created_at` | `crm_contacts.contact_id` |
| `crm_conversations` | `conversation_uid` | `id` | `conversation_uid` | `id`، `conversation_uid`، `source_type`، `source_ref`، `raw_sha256` | — |
| `crm_conversation_messages` | `message_uid` | `id` | `message_uid` | `id`، `conversation_id`، `message_uid`، `seq_no`، `sender_role`، `sent_at` | `crm_conversations.conversation_id` |
| `crm_conversation_insights` | `conversation_id` | `id` | `conversation_id` | `id`، `conversation_id` | `crm_conversations.conversation_id` |
| `crm_sessions` | `token_hash` | `id` | `csrf_hash` | `id`، `token_hash`، `created_at` | — |
| `crm_drive_file_registry` | `drive_ref` | `id` | `drive_ref` | `id`، `drive_file_id`، `drive_ref`، `content_sha256`، `created_at` | — |
| `crm_drive_file_version` | `version_ref` | `version_ref` | `version_ref` | `version_ref`، `drive_ref`، `version_seq`، `content_sha256`، `evidence_class`، `size_bytes`، `observed_by`، `receipt_ref`، `observed_at` | — |
| `crm_drive_file_review_case` | `case_ref` | `case_ref` | `case_ref` | `case_ref`، `drive_ref`، `bound_version_seq`، `bound_content_sha256`، `case_snapshot_sha256`، `genesis_sha256`، `opened_by`، `opened_at` | — |
| `crm_drive_file_review_decision` | `decision_sha256` | `id` | `decision_sha256` | `id`، `case_ref`، `decision_seq`، `decision`، `reviewer`، `reason_sha256`، `case_snapshot_sha256`، `session_hash`، `occurred_at`، `prev_decision_sha256`، `decision_sha256` | `crm_drive_file_review_case.case_ref` |
| `crm_drive_file_review_anchor` | `seq` | `seq` | `seq` | `seq`، `case_ref`، `decision_seq`، `anchor_source`، `anchored_at` | — |

> `crm_drive_file_review_anchor` لا يملك FK على `case_ref` في 0011؛ لذلك `parent = null`، والرابط يُثبت بـ `case_ref ∈` مفاتيح الحالات المُثبتة. لا يُثبت أي صف تابع بإثبات `contact`/`phone` وحده. `crm_customer_requests` لا يملك عمود `actor`؛ و`dedupe_key` يُولّده Worker لا العميل.

---

## 3) بنية الحدث والسلسلة

```json
{
  "seq": 7,
  "table": "crm_customer_requests",
  "unique_key": "<dedupe_key>",
  "observed_id": "<request.id>",
  "id_source": "http-201-body | http-response | d1-exact-key | read-back",
  "row_columns_sha256": { "id": "…", "contact_id": "…", "…": "…" },
  "row_hash": "sha256(canonical(row_columns_sha256))",
  "parent": { "table": "crm_contacts", "key": "<contact id>", "observed_id": "<contact id>" },
  "step": "A5-L5",
  "run_id": "…", "run_attempt": "…", "run_tag": "a5-…-…-…",
  "prev_event_sha256": "<genesis|prev event_sha256>",
  "event_sha256": "sha256(canonical(event without event_sha256))"
}
```

- `genesis = sha256('a5-l2-genesis|' + run_tag)` ⇒ السلسلة مرتبطة بهوية التشغيل، وليست سلسلة عامة قابلة للنقل.
- `ledger_sha256 = sha256(canonical(ledger without ledger_sha256))`.
- **لا تُخزَّن قيم الأعمدة، بل بصمات SHA-256 فقط** ⇒ لا بيانات عملاء في Git ولا في تقارير CI.
- كل استعلام في طبقة L2 يمرّ بـ `assertReadOnlySql`: `SELECT` واحد فقط، بلا `INSERT/UPDATE/DELETE/REPLACE/DROP/ALTER/CREATE/PRAGMA/ATTACH/TRIGGER`، وبلا فاصلة منقوطة داخلية. `d1Query` يستخدم UUID قاعدة الاختبار الثابت + `assertTestOnlyConfig`.

---

## 4) التدفق: A ثم B

**قبل أي كتابة** — خطوة `A5 L2 — prior ledgers, read-only baseline, ownership preflight`:
1. `a5-l2.mjs begin` ⇒ لقطة أساس `baseline.json` (مفاتيح النطاق الصناعي + `digest`) و `pending.jsonl` فارغ.
2. `scripts/a5-l2-prior-runs.mjs` يجلب **كل** التشغيلات المكتملة لهذا الـ workflow بـ pagination:
   - `gh api` مع `per_page=100` + `page=N` في حلقة حتى صفحة ناقصة تثبت النفاد (**لا صفحة أولى فقط**)، مع حارس `MAX_PAGES=1000` يوقف التشغيل إن لم ينفد الاستعراض (حارس ضد الحلقة اللانهائية فقط، وليس حدًّا لتجاوز تشغيلات).
   - **لا يوجد `created=...` ولا أي حد زمني أو عددٍ محدود لتخطي التشغيلات السابقة.** `A5_L2_RETENTION_DAYS=90` بقي **تثبيتًا لمدة بقاء الـ artifact فقط** (مطابق حرفيًا لـ `retention-days` في خطوة الرفع)، و`cutoff` يُسجَّل كقيمة معلوماتية مع `cutoff_is_filter=false` ولا يُرسل إلى الـ API.
   - **الأهلية (eligibility) تُحدَّد من دليلين تقنيين مستقلين عن التاريخ واسم العرض والنتيجة:** (أ) ملف الـ workflow الفعلي عند `head_sha` للتشغيل عبر contents API، ويجب أن يحوي كل علامات آلية L2 (`a5-l2-prior-runs.mjs`، `begin`، `preflight`، `finalize`، `name: a5-l2-ledger`)؛ (ب) خطوات التشغيل نفسها عبر jobs API، ويجب أن تكون خطوة الـ preflight قد نفذت فعلًا. أي تعارض أو مصدر غير قابل للقراءة أو كتابة بلا preflight ⇒ إيقاف مسمّى. «مؤهل» = الأمران معًا؛ «غير مؤهل» = نسخة سابقة لـ L2 أو خطوة لم تُنفَّذ (مثل وظيفة نُشرت دون صلاحية/إدخال). تشغيل مؤهل قديم/فاشل/ملغى يظل مؤهلًا ولا يُستثنى.
   - حواجز الاكتمال: `total_count`، شرط `ids.length >= total_count`، عدم تكرار المعرّفات، صحة `head_sha` (40 hex)، وكل استجابة JSON صحيح الشكل.
   - **فقط** التشغيلات المؤهلة يُطلب منها artifact: مفقود/منتهٍ/غير قابل للتنزيل/تالف/ليس `a5-l2-v1` ⇒ خروج غير صفري و`::error::` ⇒ إيقاف قبل أي كتابة. التشغيلات غير المؤهلة **لا يُفترض أنها لم تكتب صفوفًا**؛ تُفحص صفوفها في الـ preflight (انظر أدناه).
   - الدلائل المُجمَّعة تُنسخ إلى `$A5_L2_PRIOR_DIR` لتقرأها `loadLedgers()`؛ صلاحية **قراءة فقط** `actions: read`.
3. `a5-l2.mjs preflight` ⇒ `verifyLedgerIntegrity` لكل دفتر، ثم `classifyRows`:
   - حدث L2 صالح ⇒ إعادة قراءة الصف والتحقق من `observed_id` + `row_hash` + `row_columns_sha256` + `parent` + هوية التشغيل السابق ⇒ `previous-a5-proven`.
   - صف داخل أساس تشغيل موثوق ⇒ `baseline-origin`.
   - أي شيء آخر ⇒ **`unknown` ⇒ إيقاف قبل أي كتابة**.
   - `assertKeysFree` يمنع تعارض المفتاح الكامل لهذا التشغيل (مطابقة تامة + `%full%` + receipt).
   - صف مُثبت اختفى ⇒ `l2-row-vanished` ⇒ إيقاف.
   - **النطاق الصناعي القديم الموثَّق** يُفحص صفًّا بصف عبر `enumerateLegacySuspects()` / `LEGACY_PROBES` (استعلامات SELECT فقط): أسماء `TEST ONLY A5 ci-*`، الهواتف الصناعية المعروفة بالضبط (`201000000011` / `201000000012` / `201099990077`)، `ci-e2e-ticket:%` و`post-deploy-synth-%`، محادثات `post_deploy_e2e_synthetic`، وصفوف الأبناء المرتبطة، مع **استبعاد صريح** لصفوف L2 الجديدة (`A5-RUN:%` / `a5:%` / `999%`) حتى لا تُصنَّف بيانات عملاء حقيقية صناعية. أي صف قديم بلا حدث L2 مستقل ⇒ **`unknown:legacy-unproven` ⇒ إيقاف**، ولا يُقبل كـ `baseline-origin`، ولا يُنشأ له أثر بأثر رجعي، ولا يُحذَف أو يُعدَّل أو يُنقل. `buildLedger` يرفض نشر أي دفتر (`a5-l2-unproven-legacy-row`) ما دام مثل هذا الصف قائمًا.
   - تُكتب نتيجة الـ preflight في `preflight.json`؛ **`preflightCleared()` تمنع نشر أي دفتر (checkpoint أو finalize) إذا لم ينجح هذا التشغيل بالذات**. هذا يسدّ ثغرة `if: always()`: لو فشل الـ preflight، لا يُصدر دفتر يحوّل صفوف `unknown` إلى `previous-a5-proven` في التشغيل التالي.
   - داخل `buildLedger`: أي صف كان موجودًا أصلًا في لقطة `begin`، بلا حدث سابق موثوق وبلا حدث صريح لهذا التشغيل ⇒ `a5-l2-unproven-preexisting-row` ⇒ لا دفتر. لا يُقبل كـ «أثر جانبي مقروء».

**أثناء الكتابة** — بعد كل خطوة ناجحة أنشأت صفوفًا:
- `appendPendingEvent` يكتب سطرًا لكل صف مع `fsync` (`A5_L2_PENDING`).
- `a5-l2.mjs checkpoint` يعيد بناء دفتر **مُحلول بالفعل** (`row_hash` حقيقي)، `conclusion='running'`، ويُكتب فوق الملف. أي إلغاء قسري بعد خطوة N يترك N صفًا مُثبتًا.

**قبل أي كتابة، في خطوة الـ L2 نفسها**: يُنشر `a5-l2.mjs failure-evidence` مبدئيًّا (دفتر حقيقي، `conclusion='failure'`، **صفر أحداث وأساس فارغ** ⇒ صفر ادعاءات ملكية). checkpoint/finalize يكتبان فوق الملف نفسه عند توفر الدليل الحقيقي.

**بعد التشغيل** — خطوة `if: always()`:
- إذا نجح `preflight.json` لهذا التشغيل ⇒ `a5-l2.mjs finalize` ⇒ `conclusion=success|failure` + `stopped_at` + `ledger_sha256` وحدث مستقل لكل صف؛ لا يُدعى نجاحًا عند فشل E2E.
- إذا فشل الـ preflight أو غابت مخرجاته أو رمى `finalize` ⇒ `a5-l2.mjs failure-evidence` ينشر دليل الفشل **بصفر ادعاءات**، ثم `exit 1`. بذلك لا يتحوّل التشغيل إلى «تشغيل مكتمل بلا دليل» يوقف كل ما بعده، ولا يُغسل أي صف `unknown`، ولا يُثبَت أي صف قديم بأثر رجعي. `preflightCleared()` بقي حارسًا **للدفاتر التي تحمل ادعاءات** فقط.
- خطوة الرفع `if: always()` مع `if-no-files-found: error` (بدل `warn`): غياب ملف الدفتر فشل صريح، لا «تعامل مع الغياب كعدم وجود».
- **لا توجد أي SQL تنظيف**: حُذفت `SYNTH_CLEAN_SQL` و`A5_CLEAN_SQL` بالكامل (كانت تحذف كل الجلسات الملغاة وكل `crm_auth_attempts`، أي صفوفًا غير صناعية أيضًا، وتحذف بأسماء العرض).

**B بعد فشل جزئي لـ A**: يُسمح بالاستمرار **فقط** إذا كان كل صف موجود من A يملك حدثًا صالحًا أُعيد التحقق منه. دفتر A ذو `conclusion='failure'` مقبول كدليل على صفوفه؛ ولا يُعاد إثبات صفوف A تحت هوية B (`alreadyProven`).

---

## 5) اختبار Offline ذو تشغيلين (النتائج الفعلية)

`scripts/tests/a5-l2-result-ledger.test.mjs` — 24 اختبارًا على **مخطط SQLite الحقيقي بالـ 14 Migration**، بلا Worker منشور، بلا شبكة، بلا قاعدة إنتاج، بلا حذف صفوف في مسار L2:

| # | السيناريو | النتيجة |
|---|---|---|
| 1 | مفاتيح A وB لا تتقاطع؛ `+999…` مقبول؛ نمط idempotency صالح | PASS |
| 2 | حاجز القراءة فقط يرفض INSERT/UPDATE/DELETE/DROP/PRAGMA/عبارة ثانية | PASS |
| 3 | نجاح A: حدث مستقل لكل صف بـ ID + `row_hash` + أب + هوية تشغيل + سلسلة متصلة | PASS |
| 4 | **A نجاح ⇒ B** يعيد التحقق من `row_hash`/ID/العلاقة/هوية A، و`namespaceDigest` قبل/بعد الـ preflight متطابق، وصفوف A بلا تغيير | PASS |
| 5 | **A فشل جزئي** (3 صفوف فقط، `conclusion='failure'`) ⇒ B يستمر لأن كل صف مُثبت؛ A بلا تغيير، B يضيف صفوفه | PASS |
| 6 | إلغاء قسري قبل أي حدث ⇒ `unknown` + إيقاف (لا `no-ledger(hard-cancel)`) | PASS |
| 7 | صف مزوّر بوسم L1 كامل بلا حدث ⇒ `unknown` + إيقاف | PASS |
| 8 | تغيير معرّف ولّده Worker ⇒ `unknown` + إيقاف | PASS |
| 9 | سلسلة مكسورة / هوية تشغيل مزوّرة / digest خاطئ ⇒ `untrusted-result-ledger` | PASS |
| 10 | صف مُثبت اختفى ⇒ `l2-row-vanished` | PASS |
| 11 | تعارض المفتاح الكامل (مطابقة/جزء/receipt) ⇒ إيقاف B | PASS |
| 12 | مجلّة `pending.jsonl` append+fsync لكل صف؛ تحميل الدفاتر يرفض الملف التالف ويتحقق من `running` | PASS |
| 13 | تغيير حالة مشروع لا يكسر `row_hash`؛ لكن **صف جديد** من trigger 0013 ⇒ `unknown` وإيقاف | PASS |
| 14 | الـ workflow يربط `begin`/`preflight`/`checkpoint`/`finalize` + `if: always()` + artifact؛ ولا يحتوي أي SQL حذف أو `|| true` في مسارات L2 | PASS |
| 15 | بوابات `authorize_deploy`/`master`/`PROTECTION`/البيئة/المراجع وعتبات الأعداد النهائية لم تتغير؛ `actions: read` فقط هو المضاف | PASS |
| 16 | شرط 201 الصارم باقٍ؛ لا هواتف ثابتة؛ البذر بلا `INSERT OR IGNORE` وبلا `UPDATE` ميت؛ المتحققان يُصدران أحداث L2 | PASS |
| 17 | لا يُنشر دفتر إلا بعد نجاح `preflight` هذا التشغيل بالذات (يمنع غسل `unknown` عبر `if: always()`) | PASS |
| 18 | صف سابق غير مُثبت لا يُقبل كأثر جانبي (`a5-l2-unproven-preexisting-row`)، وصف مُثبت بدفتر سابق لا يُعاد إثباته | PASS |
| 19 | pagination كاملة: **3 صفحات** (100 + 100 + 17 = 217 تشغيلًا) مع `per_page=100` و**بلا** `created=...` ولا حد زمني/عددي لتخطي تشغيل | PASS |
| 20 | صفحة واحدة قصيرة / سجل تشغيلات فارغ فعلًا ⇒ صفحة واحدة كاملة (الفراغ معلوم، لا مُفترض) | PASS |
| 21 | صفحة غير قابلة للقراءة/التحليل، شكل خاطئ، نقص معرّفات، تكرار، عدم نفاد الصفحات ⇒ إيقاف مسمّى | PASS |
| 22 | artifact مفقود / تنزيل فاشل / JSON تالف / ليس L2 ⇒ إيقاف مسمّى لكل **تشغيل مؤهل** | PASS |
| 23 | CLI من البداية مع `gh` stub (runs + contents + jobs + download) ⇒ `pages_fetched=3` و217 دفترًا؛ وعند فشل صفحة 2 أو artifact ⇒ خروج 1 مع `STOPPED before any write` | PASS |
| 24 | الـ workflow يثبّت `A5_L2_RETENTION_DAYS=90` = `retention-days: 90` كتثبيت احتفاظ فقط، بلا `created=>=` وبلا `per_page=10`، مع `eligible_runs`/`legacy synthetic namespace`/`failure-evidence`، وتبقى كل حواجز `unknown`/`preflight`/`preflightCleared` | PASS |

```
node --test scripts/tests/a5-l2-result-ledger.test.mjs  -> 24/24 pass  (سابقة، أُعيدت لسبب تقني: تعديل دوال مشتركة)
node --test scripts/tests/a5-l2-eligibility-fix.test.mjs -> 7/7 pass   (جديدة، منفصلة)
npm test                                              -> 826/826 pass  (= 819 سابقة + 7 جديدة)
node --check / js-yaml / bash -n (run blocks)          -> OK
```

كما بقي اختبار العقد الحي `_worker/tests/crm-a5-live-contract.test.mjs` أخضر`: فحوص A5 العشرة تعمل عبر HTTP على Worker حقيقي + SQLite بنفس الـ DDL، و**شرط 201 الصارم** في `live-post-deploy-verify.mjs:231` لم يُخفَّض.

---

## 6) عدم التداخل مع الإنتاج / الحواجز التي لم تُمسّ

- كل استعلامات L2 تمرّ عبر UUID `65bfcb14-…` (`nasr-crm-test-db`) فقط؛ `assertTestOnlyConfig` يرفض أي إعداد يحمل اسم/UUID قاعدة الإنتاج أو عاملًا غير عامل الاختبار.
- خطوة `Verify nasr-market-db invariance (read-only)` بقيت كما هي، و`jq` النهائي للعدد **`c==60 / ph==64 / o==83 / cl==19 / cv==76 / unm==21 / m==2984 / al>=66` لم يتغير**. هذه الأعداد تستبعد أسماء العرض `TEST ONLY` أصلًا، فبقاء الصفوف الصناعية المُثبتة لا يغيّرها؛ وبذلك تُقاس عدم التداخل بصفوف الأصل لا بـ `COUNT(*)` للنطاق الصناعي.
- لم تُغيَّر: بوابات `authorize_deploy` / `REF=master` / `PROTECTION=verified|attested`، بيئة `crm-test-deploy`، المراجع، مؤقت الانتظار، `can_admins_bypass`، عتبات الاختبار، شروط 201، حاجز 0014 للجلسة، ولا `CRM_SESSION_SECRET`.
- لم تُطبَّق Migration، ولم يُعدَّل `_worker/crm-worker.js`، ولم يُنشر Worker، ولم يُكتب في `nasr-market-db` أو النسخة الاحتياطية، ولم يُحذف أي صف موجود.

---

## 7) توقفات مقصودة وقيود متبقية (تُعرض ولا تُتجاوز)

1. **تعارض حقيقي مع ثابت `dash-unm-21` عند فشل جزئي ترك محادثة صناعية `unmatched_review`.** كان التنظيف القديم يحذف محادثات `TEST ONLY`، فيبقى `dashboard.counts.unmatched_review_chats = 21` (استعلام العامل `SELECT COUNT(*) FROM crm_conversations WHERE match_status='unmatched_review'` **بلا استبعاد** للأسماء الصناعية). بعد منع الحذف، إذا فشل A بعد استيراد المحادثة وقبل `link-contact`، يصبح العدد 22 فيرى B فشل `dash-unm-21` رغم أن كل صفوف A مُثبتة بـ L2. **لم يُحلّ هذا بالحذف ولا بتخفيض/تغيير عتبة الاختبار** (كلاهما محظور)؛ يُعرض كتوقف مقصود يحتاج قرارًا بشريًا: إما تعديل معلّل لاستعلام اللوحة/العتبة في مهمة منفصلة، أو تغيير ترتيب الخطوة بحيث لا تُترك محادثة غير مرتبطة. اختبارات A→B المطلوبة Offline لا تلمس هذا الثابت، وهي تظل خضراء؛ لكن المسار الحي بعد هذا النوع من الفشل متوقف حتى القرار البشري.

   **مراجعة 2026-11-06 (قرار بشري صريح: «نسبي»):** حُسم التوقف أعلاه **بلا حذف وبلا إسقاط حاجز**، بتحويل الشرطين المجمّدين إلى شرطين نسبيين:
   - `dash-unm-21` صار `assert.equal(unm.length, dashUnmatched)` — اللوحة يجب أن تطابق القائمة التي تلخّصها. الاستعلام المكسور يفشل كما كان، عند أي حجم بيانات بما فيه الصفر؛ واللقطة التاريخية لم تعد شرطًا.
   - المقارنة النهائية `60/64/83/19/76/21/2984/66` صارت **فرقًا قبل/بعد**: نفس استعلام العدّ يُنفَّذ قبل الفحوص الحيّة وبعدها، وكل عدّاد يجب أن يبقى متطابقًا (`post-verify-counts-changed`). هذا يحقق الغرض الأصلي (عدم التداخل) دون ربطه بلقطة بيانات واحدة، وكانت اللقطة تمنع أي قاعدة نظيفة من المرور وتعود لتفشل بعد أي استيراد مشروع.
   - أُضيف كذلك رمز خطأ تذكرة CI إلى اسم الفحص (`ci-ticket-http-<status>-<error_code>`) لأن 403 كانت تعني «تذكرة مجهولة» أو «منتهية» بلا تفريق.
2. **سجلات صناعية قديمة غير قابلة للإثبات.** انتهى توقف «تشغيل مكتمل بلا artifact مستحيل»: تشغيلات ما قبل L2 تُصنَّف غير مؤهلة من نسخة الـ workflow وخطوات التشغيل، فلا يُطلب منها دفتر. لكن **غياب الدفتر ليس دليلًا على غياب الصفوف**؛ النطاق القديم الموثَّق يُفحص صفًّا بصف، وأي صف قديم بلا حدث L2 مستقل ⇒ `unknown:legacy-unproven` ⇒ إيقاف قبل أي كتابة. هذا توقف **سلامة بيانات** مقصود (يحتاج مراجعة بشرية موثّقة لصف بعينه)، لا حلقة توقف ناتجة عن منطق الجلب. لا حذف، لا تعديل، لا نقل، لا إثبات بأثر رجعي، لا تجاوز، ولا طلب اختيار قاعدة جديدة.
3. **الإلغاء القسري / فشل الـ preflight / غياب المخرجات** ⇒ يُنشر `failure-evidence` أو `checkpoint` بـ `if: always()`، فلا يبقى «تشغيل مكتمل بلا دليل». إن كانت هناك صفوف أُنشئت بلا حدث ⇒ تُصنَّف `unknown` في التشغيل التالي ⇒ إيقاف (fail-closed مقصود). أمّا إن لم تُنشأ صفوف ⇒ يمرّ التشغيل التالي بعد فحص الصفوف. لا مسار `no-ledger(hard-cancel)` ولا ادعاء نجاح. **الاستثناء الوحيد المتبقي**: قتل الـ runner قسريًا قبل أن تُنفَّذ خطوات `if: always()` أصلًا — حينها يبقى التشغيل المؤهل بلا artifact ويقف الجلب التالي (`a5-l2-ledger-artifact-unreadable`)؛ هذا توقف متعلق بالبنية التحتية صريح لا يُعالَج بتجاوز، ويحتاج تدخلًا بشريًا موثّقًا.
4. **مدة الاحتفاظ بالـ artifact (90 يومًا)** محدودة، لكنها **تثبيت احتفاظ فقط وليست مرشحًا زمنيًا** (`cutoff_is_filter=false`، ولا `created=...` في الاستعلام): تُستعرض كل التشغيلات المكتملة بلا استثناء بالعمر أو العدد. أي artifact منتهٍ/مفقود لتشغيل **مؤهل** ⇒ إيقاف فوري. وتشغيلات ما قبل النافذة إن خلّفت صفوفًا ما زالت موجودة تُفحص في الـ preflight وتُصنَّف `unknown` ⇒ إيقاف؛ لا يُعاد تصنيفها.
5. **L2 شهادة تشغيل موثوقة، لا توقيع تشفيري.** من يملك صلاحية كتابة الـ artifact يملك صلاحية إصدار دفتر. الترقية إلى HMAC بمفتاح جديد أو بوابة دور في Worker مؤجلة عن قصد (تتطلب تغيير سر/Worker، وكلاهما خارج الصلاحية الحالية).
6. **نطاق الحصر**طبقتان: (أ) `TABLE_SPECS` للصفوف الجديدة بمفاتيحها المشتقة (`999%`، `A5-RUN:%`، `a5-%`، `SYNTHLIVE-%`، `a5:%`، وصلات FK)؛ (ب) `LEGACY_PROBES` للنطاق القديم الموثَّق، ومنه `ci-e2e-ticket:%` و`TEST ONLY A5 ci-*` والهواتف الصناعية المعروفة بالضبط. تذاكر CI تُفحص الآن **كصفوف مشتبه بها للإيقاف فقط**، لا تُحذف ولا تُمنح ملكية ولا تُوسَّم بأثر رجعي. المطابقة مقصورة على قيم مشروعية موثّقة مع استبعاد صريح لوسوم L2، فلا تُصنَّف بيانات عملاء حقيقية صناعية؛ الجلسات تُحصر فقط عندما ترتبط بقرار Drive موسوم. أي توسيع للتغطية يجب أن يضيف جدولًا/تحقيقًا صريحًا.
7. **كلفة الـ checkpoints:** كل خطوة تنشئ صفوفًا تُصدر دفترًا مُحلولًا عبر استعلامات D1 للقراءة فقط؛ قد يزيد زمن التشغيل. لم يُلغَ أي حاجز لتقليله.
8. **الصلاحية `actions: read`** أُضيفت على مستوى وظيفة `deploy-and-verify` فقط، وهي قراءة-only لجلب دفاتر التشغيلات السابقة. ليست صلاحية كتابة، ولا تغيير بيئة/موافقة، ولا تخفيض حاجز؛ ومع ذلك فهي تغيير في `permissions` وتستحق مراجعة بشرية في الـ PR.
9. **لا يزال A5 الحي غير مُكتمل تشغيليًا:** لم يُنفَّذ Dispatch/Rerun/Deploy/Approve، ولم تظهر نتيجة `a5=all-10-pass`. هذا العمل يقدّم آلية العزل وإثباتها Offline فقط، ولا يدّعي نجاحًا حيًا.


---

## 8) الإصلاح النهائي المحدود لعائق L2 (داخل PR #138 فقط)

**سبب العائق:** `collectPriorLedgers` كان يطلب artifact `a5-l2-ledger` من **كل** تشغيل سابق، بما فيه 39 تشغيلًا سابقًا لآلية L2 لم تكن قادرة أصلًا على إنتاجه. أول تشغيل بآلية L2 كان يقف قبل أي كتابة، ثم ينشر `if: always()` دفترًا فارغًا/لا دفتر، فيصبح هو نفسه «تشغيلًا مكتملًا بلا دليل» ويوقف كل تشغيل لاحق إلى الأبد. كان الجلب أيضًا مقصورًا على `created=>=now-90d` مع `MAX_PAGES=100`، أي حدّ زمني/عددي لتجاوز التشغيلات.

**الإصلاح (فصل آمن، لا تجاوز):**
- الأهلية من **نسخة الـ workflow عند `head_sha` + خطوات التشغيل الفعلية** (دليلان تقنيان)، لا من التاريخ ولا اسم العرض ولا النتيجة ولا عدد محدود. مؤهل قديم/فاشل/ملغى ⇒ لا يزال يُطلب دفتره؛ غير مؤهل ⇒ لا يُطلب منه مستحيل. أي تعارض/مصدر غير مقروء ⇒ إيقاف.
- غياب artifact ≠ غياب بيانات: `LEGACY_PROBES` يفحص النطاق القديم صفًّا بصف؛ غير قابل للإثبات ⇒ `unknown` + إيقاف، بلا حذف/تعديل/نقل/إثبات بأثر رجعي، وبلا توسيع يطابق عملاء حقيقيين.
- `failure-evidence` (صفر أحداث + أساس فارغ + `conclusion=failure` + سلسلة هاش صحيحة) يُنشر مبكرًا وعند فشل preflight/finalize، فيكسر حلقة «بلا دليل» **دون أن يثبت أي صف**؛ `preflightCleared` بقي حارس الدفاتر ذات الادعاءات، و`if-no-files-found: error`.
- **عائق ثانٍ اكتُشف وأُصلح:** `GITHUB_ENV` لا يُرى داخل الخطوة التي تكتبه، فكان `begin`/`preflight` يشتقّان `run_tag` بـ nonce عشوائي مختلف عن `checkpoint`/`finalize` في الخطوات اللاحقة ⇒ `a5-l2-preflight-run-tag-mismatch` دائمًا ⇒ صفوف حقيقية بلا دليل ⇒ حلقة توقف. أُضيف `export A5_L2_NONCE` و`export A5_L2_RUN_TAG` داخل خطوة L2 نفسها، ومُثبَّت باختبار ساكن؛ الآن كل أوامر التشغيل تشتقّ نفس `run_tag` وتكتب فوق نفس الملف.
- بقي: فحص الملكية الشامل قبل الكتابة، دليل مستقل لكل صف جديد (`row_hash` / `observed_id` / الصلات / بيانات التشغيل / سلسلة الهاش)، دليل الفشل الجزئي عبر `checkpoint`، fail-closed على `unknown`، العتبات والبوابات والـ 201 الصارم كما هي.

**ملفات معدّلة:** `.github/workflows/crm-cloudflare-test-deploy.yml`، `scripts/a5-l2-prior-runs.mjs`، `scripts/a5-l2.mjs`، `scripts/tests/a5-l2-result-ledger.test.mjs` (تحديث اختبارات قائمة لسبب تقني)، `scripts/tests/a5-l2-eligibility-fix.test.mjs` (جديد: 7 اختبارات)، `CRM_A5_L2_RESULT_LEDGER.md`. لا Migration، لا تعديل/نشر Worker، لا قاعدة D1 جديدة، لا كتابة/حذف/تعديل في قاعدة البيانات، لا Workflow حي، لا Merge/Pages، لا أسرار/بيئات/عتبات/صلاحيات نشر، ولا بيانات عملاء شخصية في Git أو CI.

**الاختبارات الجديدة (منفصلة عن 24/24 و819/819 السابقة):** 7/7 في `scripts/tests/a5-l2-eligibility-fix.test.mjs` — F1 تشغيل سابق لـ L2 بلا artifact لا يوقف؛ F2 تشغيل مؤهل بلا artifact يوقف ولا يُستثنى بالعمر/الإلغاء/العدد؛ F3 صف قديم غير مُثبت يوقف مع عدم مطابقة صفوف حقيقية وعدم غسل بدفتر صفر الادعاءات؛ F4 دليل مستقل لكل صف؛ F5 فشل جزئي يُثبت الصفوف المُنشأة؛ F6 إعادة قراءة B والتحقق من الهاش والصلات وهوية A؛ F7 عدم التداخل واعتبار الغياب عدم نجاح. النتيجة الكاملة بعد الإصلاح: **826/826 (819 سابقة + 7 جديدة)**، واختبارات L2 القائمة **24/24** أُعيدت لسبب تقني هو تغيّر دوال مشتركة وواجهة الجلب.

**حالة التسليم:** PR #138 ما زال **OPEN**؛ لم يُنفَّذ دمج أو نشر أو كتابة أو Dispatch/Deploy/Migration. القراءة الحية لـ `nasr-crm-test-db` ما زالت متعذّرة تقنيًا من هذه الجلسة (لا بيانات اتصال/رمز D1، وشبكة `api.cloudflare.com`/نطاق Worker الاختباري محجوبة)؛ لذلك لم تُقَس أعداد الصفوف الحية، ولم تُعتبر صفرًا، ولم يُدعَ فحص حيّ.
