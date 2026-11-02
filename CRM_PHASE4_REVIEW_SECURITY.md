# تجهيز المراجعة البشرية — مراجعة SQL (0009) والتصميم الأمني

> **حالة هذه الجولة:** صياغة ومراجعة مسودة الهجرة + تصميم أمني + إعادة محاكاة محلية **فقط**. لم تُطبَّق أي هجرة على أي قاعدة، ولم يُكتب على `nasr-crm-test-db` أو `nasr-market-db` أو النسخة الاحتياطية، ولم يُمسّ Drive، ولم يُنشَر شيء، ولم يُدمج PR #132. لا طبقة خدمة ولا واجهة بعد (انتظارًا لاعتماد SQL صراحة).

**مخرجات الجولة (كلها مسودات قابلة للمراجعة):**

| ملف | ما هو |
|---|---|
| `_worker/migrations-draft/0009_crm_drive_review_workflow.sql` | **ملف الهجرة الكامل** (5 طاولات، 15 مشغّلًا، منظَران، 7 فهارس، 30 عبارة) |
| `_worker/migrations-draft/README.md` | قاعدة الترحيل: لماذا المسودة خارج `_worker/migrations/`، وكيف تُروَّج |
| `_worker/tests-draft/crm-review-sql-0009.abuse.mjs` | مِحْك اختبارات الإساءة على `node:sqlite` — **78 فحصًا، 78/78** |
| `_worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | محاكاة على **محرك D1 الحقيقي** (wrangler `--local`, قاعدة مؤقتة) — **53 فحصًا، 53/53** |

---

## 1) لماذا المسودة في `_worker/migrations-draft/` وليس في `_worker/migrations/`

**كل** سير عمل CRM يطبّق الهجرات ينفّذ `wrangler d1 migrations apply` على **المجلد كاملًا** لا على ملف بعينه:

| سير العمل | السطر | يطبّق على |
|---|---|---|
| `crm-phase4-analysis.yml` | 232 (مؤقت) و651 | `nasr-crm-test-db` |
| `crm-phase3-registry.yml` | 190 و465 | `nasr-crm-test-db` |
| `crm-cloudflare-test-d1.yml` | 99 | `nasr-crm-test-db` |
| `crm-cloudflare-test-deploy.yml` | 313 و335 | مرحلة النشر + `nasr-crm-test-db` |

فبمجرد وجود `0009_*.sql` داخل `_worker/migrations/` سيُطبَّق على قاعدة الاختبار في أول تشغيل لأيٍّ منها — وهذا ما منعته صراحة. المسار الحالي `_worker/migrations-draft/` لا يقرأه أي سير عمل ولا `npm test` (`node --test _worker/tests/*.test.mjs`) ولا فاحص Sonar (`_worker/**/*.js`).

**بوابة مقترنة يجب تعديلها في نفس commit الترويج:** `.github/workflows/crm-phase4-analysis.yml:660` يحتوي `if [ "$p4_tbl" != '8' ] || [ "$migs" != '8' ]` ⇒ عند نقل الملف يجب أن يصبح `migs = 9` وإلا فشل التحقق **بعد** التطبيق (أسوأ ترتيب ممكن). موثّق في README الترحيل.

---

## 2) مخطط الجداول والقيود والـ Triggers

### 2.1 `crm_drive_review_case` — فهرس الحالات (يُعاد بناؤه؛ لا بيانات شخصية)

| عمود | غرض | فشل محتمل |
|---|---|---|
| `case_ref` PK | المرجع المستقر المطلوب في شرطك (2): `p4r-###` للملف/جهة و`p4c-##` لحالات تعدّد الملفات | `CHECK` بنمط GLOB يرفض أي صيغة أخرى |
| `case_kind` | `file_to_contact` أو `contact_fanout` — يفصل نظريًّا «هل هذه بطاقة؟» عن «هل هذا شخص مكرر؟» | قائمة مغلقة |
| `run_key` FK→`crm_drive_analysis_run` `ON DELETE CASCADE` | يربط الحالة ببصمة الحزمة المدروسة؛ حذف تشغيل التحليل يعيد بناء الفهرس فقط | كسر FK مرفوض |
| `drive_file_id`, `source_content_kind`, `card_index`, `files_count` | **مقابض مصدر** مقنّعة (hex بطول 8–64، لا معرّف Drive خام) + أي بطاقة داخل الملف | نمط hex + طول |
| `match_class`, `evidence_type`, `confidence`, `signal_kind`, `signal_digest` | ما جعل النظام يقترح المطابقة، مع بصمة الإشارة بلا الرقم نفسه | قوائم مغلقة + digest=64hex |
| `crm_contact_id` | جهة CRM المشتبه بها (لا اسم) | طول + charset |
| `basis` | **الأساس الوحيد** الذي يمكن أن يستند إليه اعتماد: `vcard_tel`, `sender_label_phone`, `transcript_overlap`, `name_digest`, `body_text` | قائمة مغلقة |
| `approve_allowed` | 0/1 محسوب وقت البناء؛ `CHECK (approve_allowed = 0 OR (basis IN (vcard_tel,sender_label_phone) AND case_kind='file_to_contact'))` | لا يمكن إنشاء حالة تسمح بالاعتماد على اسم |
| `case_snapshot_sha256` | بصمة «ما عُرض على المراجع» (لقطة مقنّعة)؛ تُربط بكل قرار وكل ختم | 64hex |
| `seal_state` | `pending/sealed/expired/revoked/unavailable` | قائمة مغلقة |
| قيد الشكل | `file_to_contact` ⇒ ملف+جهة؛ `contact_fanout` ⇒ بلا ملف، `files_count ≥ 2`، و`match_class='conflict'` | `CHECK` (اختُبر: حالة شخص بملف واحد تُرفض) |

**لماذا لا `FK` إلى `crm_drive_file_registry`:** كما في 0008 — الجرد يتقدّم أحيانًا على التحليل؛ والربط يتم بالتجزئة عبر مسارCI نفسه.

### 2.2 `crm_drive_review_seal` — البطاقة الأصلية **مشفّرة** (خيار A الذي اخترته)

عمود واحد فقط (`ciphertext_b64u`) يحمل المحتوى، وسائر الأعمدة بارامترات تشفير وقيود: `envelope_version='p4rev_v1'`, `algo='AES-256-GCM'`, `kdf='HKDF-SHA256'`, `aad_mode='case_bound_v1'`, `key_version 1..99`, `iv_b64u` (16 حرفًا), `tag_b64u` (22), `ciphertext_b64u` (24..8192), `ciphertext_sha256` UNIQUE, `plaintext_sha256`, `plaintext_len ≤ 4096`, `sealed_by ∈ {analysis_pipeline, manual_refresh}`, `created_at`, `expires_at > created_at`, `revoked_at`.

- **ليست append-only عمدًا:** يجب أن يظل ممكنًا الحذف/التقادم (سياسة البقاء) والتدوير؛ ولا يعتمد أي قرار عليها، لأن السجل لا يخزّن ما كُشف.
- `ON DELETE CASCADE` من الحالة ⇒ حذف حالة يعيد بناء ختمها دون يتيم.
- مشغّل `trg_review_seal_case_exists` يمنع ختمًا لحالة غير موجودة؛ و`trg_review_seal_after_insert/delete` يحدّثان `seal_state` للواجهة.

### 2.3 `crm_drive_review_event` — سجل القرارات (غير قابل للمحو)

| عمود | غرض | القاعدة التي تنفّذها |
|---|---|---|
| `event_seq` + `prev_event_sha256` + `event_sha256` | سلسلة عامة لكل `run_key`، قابلة للتحقق بـ SQL فقط | `UNIQUE(run_key,event_seq)` + `trg_review_event_chain_sequence` |
| `case_seq` | تسلسل داخل الحالة، يُشتق من `COUNT(*)` وقت الإدراج | `UNIQUE(case_ref,case_seq)` + `trg_review_event_case_sequence` |
| `event_type` | `approve/exclude/defer/conflict_investigation/reveal/note` — **لا وجود لأي** `link`/`merge`/`import` | قائمة مغلقة |
| `decision_state` | مرتبط إجباريًا بالنوع (approve⇒approved … reveal/note⇒NULL) | `CHECK` بالاقتران |
| `reviewer` | نص إلزامي (3..120) مع **قائمة منع آلية داخل SQL**: `auto, system, bot, worker, cron, pipeline, operator, unknown, none, na, -` | `CHECK` (محاكاة نفس `NON_HUMAN_REVIEWERS`) |
| `reviewer_attestation` | ثابت على `session_label_not_independent_identity` — يوثّق قرارَك الرابع: النص وحده ليس إثبات هوية مستقلًا | `CHECK` |
| `session_hash` | تجزئة الجلسة التي اتُّخذ القرار تحتها (ربط بالجلسة الحالية، دون تسريب التوكن) | 64hex |
| `reason` | السبب: 12..1000، بلا tab/LF/CR، و**بلا 9 أرقام متتابعة** (يمنع الأرقام المصرية والهوية الوطنية) | `CHECK` (الاختبار: `01012345678` مرفوض؛ «2026-11-01» مقبول) |
| `reason_sha256` | بصمة السبب ليتأكد لاحقًا دون تخزين نص طويل في الفهارس | 64hex |
| `reveal_purpose/outcome/seal_ciphertext_sha256` | مقرونة بنوع `reveal` فقط (`= (…)` في BOTH directions) | `CHECK` ×2 |
| `basis_at_event` + `case_snapshot_sha256` | «على أي أساس ومتى كانت اللقطة المعروضة» | `trg_review_event_snapshot_binding` |
| `link_applied=0`, `merge_authorized=0`, `contact_write_count=0` | **أربعة مسامير**: لا ربط محادثة، لا دمج جهات، لا كتابة تشغيلية | `CHECK (x = 0)` لكلٍّ |
| `supersedes_id` | التصحيح = حدث جديد يشير إلى القديم؛ لا تعديل أبدًا | `trg_review_event_supersedes_target` (نفس الحالة) |
| `occurred_at` | وقت القرار بصيغة ISO مع تحقّق `datetime()` ورفض الرجوع للوراء | `CHECK` + مشغّل السلسلة |
| **بلا** `run_key` FK | لا cascade يمسح قرارًا بشريًا أبدًا | بنية الجدول |

### 2.4 `crm_drive_review_chain_head` و`crm_drive_review_chain_anchor`

`head` نقطة تحقّق سريعة **قابلة للتحديث** (لا يُمحى: `trg_review_head_no_delete`)؛ `anchor` **مرآة غير قابلة للتحديث/الحذف** تُكتب لكل حدث بواسطة `trg_review_event_after_insert`. الفرق الجوهري: أي التواء في `head` يظهر فورًا مقابل `anchor` (أُثبت بالمحاكاة: «التاريخ الذي فقده head ما زال في anchor»).

### 2.5 المشغّلات الخمسة عشر (بالرسالة التي يرفعها كلٌّ)

| # | المشغّل | يمنع | رسالة الرفض |
|---|---|---|---|
| 1 | `trg_review_event_no_update` | أي تعديل على سجل القرارات | `review_events_are_append_only` |
| 2 | `trg_review_event_no_delete` | أي حذف من السجل | `review_events_are_append_only` |
| 3 | `trg_review_anchor_no_update` | إعادة كتابة نقاط التحقّق | `review_anchors_are_append_only` |
| 4 | `trg_review_anchor_no_delete` | محو تاريخ التحقّق | `review_anchors_are_append_only` |
| 5 | `trg_review_head_no_delete` | إسقاط الرأس لبدء سجل مزوّر | `review_chain_head_required` |
| 6 | `trg_review_event_case_exists` | حدث لحالة غير موجودة في هذا التشغيل | `review_event_case_not_found` |
| 7 | `trg_review_event_snapshot_binding` | قرار يقرّر على لقطة/أساس غير المعروض | `review_event_snapshot_mismatch` |
| 8 | `trg_review_event_chain_sequence` | فجوة في `event_seq`، `prev` خاطئ، أو زمن إلى الوراء | `review_event_chain_sequence_broken` |
| 9 | `trg_review_event_case_sequence` | قفز/إعادة ترتيب داخل الحالة | `review_event_case_seq_broken` |
| 10 | `trg_review_event_approve_basis` | **`approve` بلا أساس هاتفي موثوق، أو على حالة تعدّد ملفات** | `review_approve_requires_phone_backed_basis` |
| 11 | `trg_review_event_supersedes_target` | تصحيح يشير إلى حدث لحالة أخرى | `review_supersedes_target_invalid` |
| 12 | `trg_review_event_after_insert` | (تقدّم) يحدّث الرأس ويضيف مرساة | — |
| 13 | `trg_review_seal_case_exists` | ختم لحالة غير موجودة | `review_seal_case_not_found` |
| 14 | `trg_review_seal_after_insert` | (تحديث) `seal_state='sealed'` | — |
| 15 | `trg_review_seal_after_delete` | (تحديث) `seal_state='unavailable'` | — |

**لمسة متعمَّدة في 6 و7 و10:** شرط `WHEN` يبدأ بعدد الحالات المطابقة، لأن SQLite **لا يضمن ترتيب اشتعال مشغّلات نفس الحدث**؛ فبغير ذلك الحاجز «الحالة غير موجودة» قد تبتلعه رسالة مشغّل آخر (هذا ما حدث فعليًّا في المحاكاة، وصحّحناه).

### 2.6 المنظَران

- `crm_review_chain_integrity` — لكل `run_key`: `events`, `first_seq`, `last_seq`, `broken_links`, `anchor_mismatches`, `head_event_count`, `anchors`. سجل سليم ⇐ `broken_links = 0` و`anchor_mismatches = 0` و`events = head_event_count = anchors`؛ أي انحراف = تعديل أو حذف أو إعادة ترتيب أو تراجع الرأس. **لا يحتاج حساب أي hash**، لذا يعمل في CI بلا أدوات.
- `crm_review_case_state` — الحالة الجارية لكل حالة (`current_decision`, `decided_at`, `decided_by`, `events`, `reveals`, `seal_state`, `approve_allowed`) مشتقّة من آخر قرار، دون أي عمود قابل للتعديل.

---

## 3) آلية التشفير وإدارة السر

**لا يُعاد استخدام مفتاح الاستيعاب (`ingest-public-key.txt` / `enc_v1`)** — فصل غرض كامل: لو تسرّب مفتاح الاستيعاب لوجب أن يظل مخزن المراجعة معزولًا (والعكس). المخطط:

```
CRM_REVIEW_SEAL_KEY  = 32 عشوائية بايت (base64url) — Worker secret على nasr-crm-api-test فقط
DEK(case)            = HKDF-SHA256(ikm=KEY, salt=run_key||case_ref, info="p4rev_seal_v1"||case_snapshot_sha256, len=32)
AAD                  = "p4rev_v1"||case_ref||case_snapshot_sha256||run_key||"v"<<key_version>>
ciphertext           = AES-256-GCM(DEK, iv=12 عشوائية, plaintext=canonical JSON للبطاقة+المصدر, AAD)
الصفيف المخزن        = envelope_version, key_version, iv_b64u, tag_b64u, ciphertext_b64u,
                       ciphertext_sha256, plaintext_sha256, plaintext_len(≤4096), created_at, expires_at
```

**لماذا هذا بالضبط:** مفتاح لكل حالة (لا مفتاح واحد لكل شيء) ⇒ تسريب ختم واحد لا يفكّ البقية؛ و`info` تحمل بصمة اللقطة و`AAD` يحمل `case_ref` ⇒ **لا يمكن نقل صورة مشفّرة إلى حالة أخرى ولا استبدال المراسل بصمت** (أُثبت: `UPDATE` بنقل الختم إلى حالة أخرى ⇒ فكّ التشفير يفشل بـ `Unable to authenticate data`)؛ و`plaintext_sha256` يربط المشفَّر باللقطة المعروضة بدون كشفها.

**ما الذي يدخل النصّ المفكَّر (≤ 4 KB):** حقول الـ vCard الخاصة بالبطاقة الواحدة (`FN`, `TEL`, `EMAIL`, `NOTE` ما وُجد)، مرجع المصدر (مقطع `file_ref8`، النوع، فهرس البطاقة، بصمة المحتوى)، وسطر منشأ واحد. **لا نص محادثة، لا مجلد كامل، ولا سجلات الملف.** لو تجاوز 4 KB تُرفض الحالة إلى `unavailable` وتوثَّق فيCI كعدد فقط.

**مسار الكشف (حصريًا بعد تحقّق الجلسة، كما اشترطت):**

1. `POST /api/review/reveal` ← يجب أن تمر على نفس بوابة `x-crm-csrf` + فحص `cross_site_forbidden` + `session_hash` صالح وغير منتهٍ.
2. تحميل صف الحالة + صف الختم؛ رفض إن `seal_state ∈ {expired, revoked, unavailable}` أو `expires_at < now` أو `key_version` غير معروف.
3. فكّ التشفير داخليًا، ومقارنة `sha256(plaintext) === plaintext_sha256`، ثم الرد بصلاحيات عدم التخزين `Cache-Control: no-store`.
4. كتابة حدث `reveal` **قبل** إرجاع Bytes (فإن فشل التسجيل تُرفض الاستجابة كلها: لا كشف بلا أثر).
5. الأخطاء: `seal_missing`, `seal_expired`, `seal_revoked`, `key_version_unavailable`, `seal_auth_failed`, `reveal_barrier_hit:<رسالة D1>` — بلا أي جزء من النص المفكَّر عند الفشل.

**إدارة السرّ:** يُنشأ بـ `wrangler secret put CRM_REVIEW_SEAL_KEY` على **Worker الاختبار** فقط (لا `.dev.vars` في Git، لا في `vars`، لا في CI logs، لا ملف في المستودع). دوّار: `key_version` في كل صف؛ التدوير = إضافة `CRM_REVIEW_SEAL_KEY_V2` مع إبقاء V1 للقراءة فقط حتى تُعاد ختم الحالة من Drive ثم تُسحب V1. **إلغاء التفعيل الفوري** = حذف السرّ ⇒ كل الأختام تصبح غير قابلة للفك (ميزة خصوصية، لا كارثة: المصدر الأصلي يبقى في Drive ويمكن إعادة الختم). لا escrow للمفتاح في المستودع؛ إن أردت نسخة طوارئ تُشفَّر كما في نمط `PHASE3_KEY_ESCROW_KEY` (قرار مستقل).

**بقايا المخاطر (معلنة لا مخفية):** من يملك حساب Cloudflare يستطيع قراءة صفوف D1 (مشفّرة)؛ ومن يملك السرّ **+** القاعدة يستطيع فكّها. لا يوجد فصل مستخدمين في Worker، فلا «عزل المراجع عن المدير» داخل D1؛ التعويض: لا نص مكشوف أبدًا، سقف 4 KB، بقاء 90 يومًا، سجل كشف إلزامي، ورفض أي قراءة بعد `expires_at`.

---

## 4) اختبارات الإساءة والتلاعب (أداتان، وكلاهما أخضر)

**أ) `node _worker/tests-draft/crm-review-sql-0009.abuse.mjs` — 78 فحصًا على SQLite 3.51** (يبني قاعدة `:memory:` بتطبيق 0001..0008 الحقيقي ثم مسودة 0009). مجموعات: مسار شريف (قرار/ملاحظة/تأجيل/تعارض/تصحيح بالـ supersede) • 10 محاولات تعديل/حذف على السجل والمراسي والرأس • 8 حالات تزوير (لقطة أخرى، أساس أقوى، `link_applied/merge_authorized/contact_write_count`, حالة غير معروفة) • 5 أحداث أثرية ممنوعة (`merge_contacts`, `link_conversation`, `import_customer`, `delete_contact`, `set_owner`) • 9 أسماء غير بشرية • 3 أسباب غير مقيّدة + هاتف + نص ملتصق + attestation مبالغ + 3 كشف بلا غرض • 4 شكل الحالة/الختم • 6 مقابلات (اختيار A حقيقي: HKDF+AES-GCM، round-trip، نقل الختم، مفتاح خاطئ، حجم زائد) • 4 عبث بعد حذف المشغّلات (يُكتشف) + مسح السجل وإعادة بنائه (يُكتشف بالمراسي) • 4 فحوص PII على نص الهجرة • idempotency • إثبات بقاء الطاولات التشغيلية في الذاكرة فارغة.

**ب) `python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` — 53 فحصًا على محرك D1 نفسه** (wrangler `--local` في مجلد مؤقت، يُحذف في النهاية). يثبت ما لا تثبته SQLite وحدها:
- `wrangler d1 migrations apply` يبتلع الملف كاملًا: **30 عبارة نجحت**، و**15 مشغّلًا** بقيت سليمة (أجسام `BEGIN…END;` لم تُقطَّع).
- الرسائل المخصّصة تصل من D1 نصًا (`review_events_are_append_only: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`) ⇒ يمكن للـ API أن يعرض «أي حاجز صادمه» بدل خطأ عام.
- إعادة التطبيق no-op، و**يعيد المشغّلات التي حذفها المعتدي** (self-healing)؛ ثم `No migrations to apply!` و`d1_migrations=2`.

**عيبان حقيقيان كشفتهما المحاكاة وصُحّحا في المسودة:** (1) `reason NOT GLOB '*[0-9]×10*'` كان يفجّر الهجرة وقت الإدراج في D1: `LIKE or GLOB pattern too complex` — الحد في D1 هو **9** أصناف متتابعة، فاختُصر القيد إلى 9 أرقام متتابعة (الهاتف 10–11 رقمًا، الهوية الوطنية 14 ⇒ كلها تُلتقط؛ والأرقام المتباعدة يعالجها التطبيع في طبقة الخدمة قبل الإدراج). (2) ترتيب اشتعال المشغّلات غير مضمون ⇒ أُضيف عدّاد وجود الحالة في `WHEN` (القسم 2.5).

**قبل الاعتماد (P1)** تُنقل الأداتان إلى `_worker/tests/crm-phase4-review-sql.test.mjs` بعدد الحالات نفسه + توحيد الصياغة مع `node --test`، ويُضاف إلى الـ workflow بوابة `d1_review_triggers = 15` و`latest_mig = 0009_crm_drive_review_workflow`.

---

## 5) خطة التراجع والمخاطر

| مرحلة | تراجع | ملاحظات |
|---|---|---|
| P1 (مسودة SQL) | حذف المجلد `migrations-draft` | لا أثر على أي قاعدة؛ الحالة الآن هنا |
| P4 تطبيق 0009 | `DROP VIEW crm_review_case_state; DROP VIEW crm_review_chain_integrity; DROP TRIGGER …×15; DROP TABLE …×5;` ثم `DELETE FROM d1_migrations WHERE name='0009_crm_drive_review_workflow.sql';` | لا يلمس أي طاولة تشغيلية (لا `ALTER` إطلاقًا). يُنفَّذ يدويًا من مشغّل D1 بعد موافقة، لا تلقائيًا |
| P4 بعد قرارات | **لا تراجع عن السجل**: `DELETE` ممنوع بالمشغّلات؛ التراجع الصحيح هو حدث `exclude`/تصحيح بـ `supersedes_id`. هذه ميزة مقصودة | لو أُريد محو حقيقي لأسباب خصوصية: حذف مفتاح الكشف يُلغي إمكانية القراءة، ويبقى الأثر (المناسب لحالة الطوارئ) |
| P5 نشر Worker الاختبار | إعادة نشر النسخة السابقة من `nasr-crm-api-test` (سجل الإصدارات Versions في Cloudflare) + `rollback` عبر wrangler | اللوحة مخفية تلقائيًا بلا 0009 (`hasTable` → `503 review_not_installed`) فلا كسر للواجهة الحالية |
| الكود (P2/P3) | `git revert` لكل commit (كلها إضافة خالصة) | لا هجرة عكسية مطلوبة ما لم تُطبَّق 0009 |

| خطر | احتمال/أثر | تخفيف |
|---|---|---|
| **نشر تلقائي**: `crm-cloudflare-test-deploy.yml` يعمل على `push` لأي `arena/**` و مساراته تشمل `_worker/crm-ui/**` و`_worker/crm-worker.js`، ويطبّق الهجرات **ثم** ينشر Worker الاختبار **بلا أي بوابة `if`** | مرتفع/مرتفع | **لا push** لأي مسار من تلك القوائم قبل وضع بوابة صريحة (مثلاً `if: github.event_name == 'workflow_dispatch' && inputs.deploy == 'true'`) أو استبدال المسارات بقائمة لا تشمل `crm-ui`. قرارك مطلوب (القسم 7) |
| `migs = 8` في `crm-phase4-analysis.yml:660` | مؤكَّد عند الترويج/مرتفع | تعديل الحارس في نفس الـ commit الذي ينقل 0009 (وثيق في README الترحيل) |
| «غير قابل للمحو» نسبي (SQL خام + إسقاط مشغّل) | متوسط/مرتفع | مراسي مستقلة + منظَر تحقّق + تثبيت `head_event_count` في اسم وظيفة CI كل تشغيل + self-healing عند إعادة التطبيق |
| رمز وصول مشترك ⇒ `reviewer` نصي، لا هوية تقنية | مؤكّد/متوسط | قيد `attestation` الصريح + `session_hash` + رفض الأسماء الآلية؛ هوية حقيقية = مرحلة مصادقة متعددة المستخدمين منفصلة |
| تسرّب PII في `reason` (أرقام متباعدة، أسماء) | متوسط/مرتفع | قاعدة 9 أرقام في SQL + تطبيع/فحص في الخدمة + تحذير في الواجهة + canary على استجابات `/api/review/*` |
| كشف الزائدين عن الحاجة (سرّ مسرّب + D1) | منخفض/مرتفع | 4 KB، بقاء 90 يومًا، `expires_at` إلزامي، حدث `reveal` قبل الإرجاع، `no-store`، سرّ مستقل قابل للدوّران/الإلغاء |
| تفسّر «الاعتماد» كتصريح ربط | متوسط/مرتفع | `CHECK` ×3 + غياب أحداث الربط + نصّ تأكيد في الواجهة + اختبار CI يطالب بـ `link_applied` غائبًا من أي مسار |
| انزياح `case_ref` بين تشغيلين | متوسط/متوسط | `run_key` + `payload_fingerprint` يثبّتان المجموعة؛ أي حزمة جديدة تولّد مجموعة جديدة |
| كسر خصوصية CI بنشر عدّادات حساسة | منخفض/متوسط | لا أسماء/أرقام؛ التثبيت في اسم الوظيفة يقتصر على `head_event_count` وعدّاد المراسي (لا PII) |

---

## 6) إثبات: لا كتابة في هذه الجولة

| ما طُلب | البرهان |
|---|---|
| لا تطبيق هجرة | لم يُنفَّذ أي `wrangler d1 migrations apply --remote` ولا `d1 execute --remote`؛ كل أمر wrangler كان `--local --persist-to <scratch>` داخل `/tmp`/`/home/user/p9rev` (مجلد مؤقت، حُذف). `nasr-crm-test-db` لم يُذكر في أي أمر هذه الجولة |
| لا كتابة على الجداول التشغيلية | المحاكاة وحدها تعمل على `:memory:`/مؤقت؛ والاختبار الأخير في المِحْك node يؤكد أن 7 طاولات تشغيلية **فارغة** في قاعدة الاختبار المحلية |
| لا `nasr-market-db`، لا نسخة احتياط | لا ذكر لأيٍّ منهما في أي أمر؛ لا `--remote`؛ لا `wrangler.crm.toml` استُخدم في الكتابة |
| لا Drive | لا استدعاء connector واحد هذه الجولة (لم يُنزَّل ولم يُقرأ ولا سُجِّل ملف 514B؛ بقي `reg514=0, analysis514=0`) |
| لا نشر ولا دمج | لم ينفّذ أي deploy؛ PR #132 ما زال `OPEN` و`mergedAt = null`؛ `origin/master` لم يتغيّر (`4c42806`) |
| ما تغيّر فعلًا | ملفات في فرع العمل المراجَع فقط: `M CRM_PHASE4_REVIEW_SECURITY.md` و`A _worker/migrations-draft/*` و`A _worker/tests-draft/*` — **لا كود Worker، لا SQL مطبَّقًا، لا CI yml معدَّلًا** |
| نظافة المستودع | لا بيانات شخصية في المسودة: فحوص PII داخل المِحْك (لا 10 أرقام متتابعة، لا نص عربي، لا بريد، لا معرّفات Drive) + `privacy-canary.test.mjs` أخضر |

**مهم:** هذه الجولة **لم تُشغّل أي workflow جديدًا**؛ أحدث تشغيلين بقيا `41325455688` و`41325695420` (فحص قراءة فقط، من الجولة السابقة).

---

## 7) قرارك مطلوب قبل أي خطوة تنفيذية

1. **اعتماد SQL 0009** كما هو (5 طاولات / 15 مشغّلًا / 2 منظر)، أو طلب تعديلات (مثلًا: حذف `seal` من 0009 ونقله إلى هجرة مستقلة، أو رفع سقف `plaintext_len`، أو مدة البقاء غير 90 يومًا).
2. **بوابة النشر التلقائي:** هل أضيف شرطًا صريحًا في `crm-cloudflare-test-deploy.yml` (يعطّل النشر على `push` ويحتاج `workflow_dispatch` مع إدخال صريح) **قبل** أي push يمسّ `_worker/crm-ui/**` أو `crm-worker.js`؟ بدونها، أول commit تنفيذي سيُنشر ويطبّق الهجرات تلقائيًا — وهو ما منعته.
3. **ترتيب الترويج:** نقل `0009` إلى `_worker/migrations/` مع تحديث `migs = 9` في commit واحد، أم مرحلتان؟
4. **مدة بقاء الأختام:** 90 يومًا افتراضيًا في التصميم — أم 30؟
5. **تصلّب «الكشف قبل الاعتماد»:** هل أجعل `approve` مرفوضًا برمجيًا إن لم يسبقه `reveal granted` على نفس الحالة (حاجز إضافي اختياري)، أم يبقى توصية في الواجهة؟

> **توقّفت هنا.** لا تطبيق لـ 0009، لا طبقة خدمة، لا واجهة، لا نشر، لا استيراد/ربط/دمج، لا مرحلة خامسة. بانتظار موافقتك الصريحة على البنود 1–5.
