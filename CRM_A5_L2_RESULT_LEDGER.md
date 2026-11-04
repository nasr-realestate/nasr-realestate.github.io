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
2. `scripts/a5-l2-prior-runs.mjs` يجلب **كل** التشغيلات ذات الصلة بـ pagination:
   - `gh api` مع `per_page=100` + `page=N` في حلقة حتى صفحة ناقصة تثبت النفاد (**لا صفحة أولى فقط**)، مع حارس `MAX_PAGES=100` يوقف التشغيل إن لم ينفد الاستعراض.
   - `created=>=<cutoff>` يقصر النتائج على نافذة الاحتفاظ الفعلية للـ artifacts، و`cutoff = now - A5_L2_RETENTION_DAYS` (90 يومًا، مطابق حرفيًا لـ `retention-days` في خطوة الرفع، ومُثبَّت باختبار ساكن).
   - حواجز الاكتمال: `total_count` من الصفحة الأولى، شرط `ids.length >= total_count`، عدم تكرار المعرّفات، وكل استجابة يجب أن تكون JSON صحيح الشكل.
   - **أي صفحة غير قابلة للقراءة/التحليل، أو نقص في المعرّفات، أو artifact مفقود/منتهي/تالف/ليس `a5-l2-v1` ⇒ خروج غير صفري و`::error::` ⇒ إيقاف قبل أي كتابة.** لا يُعتبر أيٌّ من ذلك دليلًا على «لا توجد سجلات سابقة».
   - الدلائل المُجمَّعة تُنسخ إلى `$A5_L2_PRIOR_DIR` لتقرأها `loadLedgers()`؛ صلاحية **قراءة فقط** `actions: read`.
3. `a5-l2.mjs preflight` ⇒ `verifyLedgerIntegrity` لكل دفتر، ثم `classifyRows`:
   - حدث L2 صالح ⇒ إعادة قراءة الصف والتحقق من `observed_id` + `row_hash` + `row_columns_sha256` + `parent` + هوية التشغيل السابق ⇒ `previous-a5-proven`.
   - صف داخل أساس تشغيل موثوق ⇒ `baseline-origin`.
   - أي شيء آخر ⇒ **`unknown` ⇒ إيقاف قبل أي كتابة**.
   - `assertKeysFree` يمنع تعارض المفتاح الكامل لهذا التشغيل (مطابقة تامة + `%full%` + receipt).
   - صف مُثبت اختفى ⇒ `l2-row-vanished` ⇒ إيقاف.
   - تُكتب نتيجة الـ preflight في `preflight.json`؛ **`preflightCleared()` تمنع نشر أي دفتر (checkpoint أو finalize) إذا لم ينجح هذا التشغيل بالذات**. هذا يسدّ ثغرة `if: always()`: لو فشل الـ preflight، لا يُصدر دفتر يحوّل صفوف `unknown` إلى `previous-a5-proven` في التشغيل التالي.
   - داخل `buildLedger`: أي صف كان موجودًا أصلًا في لقطة `begin`، بلا حدث سابق موثوق وبلا حدث صريح لهذا التشغيل ⇒ `a5-l2-unproven-preexisting-row` ⇒ لا دفتر. لا يُقبل كـ «أثر جانبي مقروء».

**أثناء الكتابة** — بعد كل خطوة ناجحة أنشأت صفوفًا:
- `appendPendingEvent` يكتب سطرًا لكل صف مع `fsync` (`A5_L2_PENDING`).
- `a5-l2.mjs checkpoint` يعيد بناء دفتر **مُحلول بالفعل** (`row_hash` حقيقي)، `conclusion='running'`، ويُكتب فوق الملف. أي إلغاء قسري بعد خطوة N يترك N صفًا مُثبتًا.

**بعد التشغيل** — خطوة `if: always()`:
- `a5-l2.mjs finalize` ⇒ `conclusion=success|failure` + `stopped_at` + `ledger_sha256`، ثم رفع artifact.
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
| 19 | pagination كاملة: **3 صفحات** (100 + 100 + 17 = 217 تشغيلًا) مع `per_page=100` و`created=>=cutoff` | PASS |
| 20 | صفحة واحدة قصيرة / سجل تشغيلات فارغ فعلًا ⇒ صفحة واحدة كاملة (الفراغ معلوم، لا مُفترض) | PASS |
| 21 | صفحة غير قابلة للقراءة/التحليل، شكل خاطئ، نقص معرّفات، تكرار، عدم نفاد الصفحات ⇒ إيقاف مسمّى | PASS |
| 22 | artifact مفقود / تنزيل فاشل / JSON تالف / ليس L2 ⇒ إيقاف مسمّى لكل تشغيل | PASS |
| 23 | CLI من البداية مع `gh` stub ⇒ `pages_fetched=3` و217 دفترًا؛ وعند فشل صفحة 2 أو artifact ⇒ خروج 1 مع `STOPPED before any write` | PASS |
| 24 | الـ workflow يثبّت `A5_L2_RETENTION_DAYS=90` = `retention-days: 90`، بلا `per_page=10` وبلا «تعامل مع الغياب كعدم وجود»، وتبقى كل حواجز `unknown`/`preflight`/`preflightCleared` | PASS |

```
node --test scripts/tests/a5-l2-result-ledger.test.mjs  -> 24/24 pass
npm test                                              -> 819/819 pass
node --check / js-yaml / bash -n (10 run blocks)       -> OK
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
2. **سجلات صناعية قديمة / تشغيلات ما قبل نشر هذا الإصلاح بلا artifact.** التشغيلات السابقة (#37/#38/#39 وما قبلها) لم تكن تنشر `a5-l2-ledger`، لذا سيُوقف أول تشغيل بعد هذا الإصلاح في خطوة الجلب نفسها (`a5-l2-ledger-artifact-missing`) قبل أي كتابة، حتى لو كانت كل الصفوف نظيفة. هذا مقصود: الدفتر المفقود ليس دليلًا على غياب السجلات. القرار بشري: مراجعة يدوية موثّقة، أو إجراء منفصل يثبت تلك الصفوف، أو تغيير أمني لاحق (HMAC/بوابة دور). لا حذف، لا تجاوز، لا وسم بأثر رجعي.
3. **الإلغاء القسري قبل أول حدث** ⇒ لا دفتر ⇒ `unknown` ⇒ إيقاف التشغيل التالي. هذا مقصود وليس خللًا.
4. **مدة الاحتفاظ بالـ artifact (90 يومًا)** محدودة. الجلب مقصور على `created=>=now-90d`؛ أي artifact منتهٍ لتشغيل داخل النافذة ⇒ إيقاف فوري. وتشغيلات ما قبل النافذة إن خلّفت صفوفًا ما زالت موجودة فستُصنَّف `unknown` في الـ preflight ⇒ إيقاف؛ لا يُعاد تصنيفها.
5. **L2 شهادة تشغيل موثوقة، لا توقيع تشفيري.** من يملك صلاحية كتابة الـ artifact يملك صلاحية إصدار دفتر. الترقية إلى HMAC بمفتاح جديد أو بوابة دور في Worker مؤجلة عن قصد (تتطلب تغيير سر/Worker، وكلاهما خارج الصلاحية الحالية).
6. **نطاق الحصر** هو السجلات الصناعية A5 بمفاتيحها المشتقة (`999%`، `A5-RUN:%`، `a5-%`، `SYNTHLIVE-%`، `a5:%`، وصلات FK). سجلات تذاكر دخول CI (`ci-e2e-ticket:%`) ليست سجلات A5 صناعية ولا تُحذف ولا تُصنَّف؛ الجلسات تُحصر فقط عندما ترتبط بقرار Drive موسوم. أي توسيع للتغطية يجب أن يضيف جدولًا إلى `TABLE_SPECS` صراحةً.
7. **كلفة الـ checkpoints:** كل خطوة تنشئ صفوفًا تُصدر دفترًا مُحلولًا عبر استعلامات D1 للقراءة فقط؛ قد يزيد زمن التشغيل. لم يُلغَ أي حاجز لتقليله.
8. **الصلاحية `actions: read`** أُضيفت على مستوى وظيفة `deploy-and-verify` فقط، وهي قراءة-only لجلب دفاتر التشغيلات السابقة. ليست صلاحية كتابة، ولا تغيير بيئة/موافقة، ولا تخفيض حاجز؛ ومع ذلك فهي تغيير في `permissions` وتستحق مراجعة بشرية في الـ PR.
9. **لا يزال A5 الحي غير مُكتمل تشغيليًا:** لم يُنفَّذ Dispatch/Rerun/Deploy/Approve، ولم تظهر نتيجة `a5=all-10-pass`. هذا العمل يقدّم آلية العزل وإثباتها Offline فقط، ولا يدّعي نجاحًا حيًا.
