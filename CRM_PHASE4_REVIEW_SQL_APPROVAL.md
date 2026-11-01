# الاعتماد النهائي — هجرة `0009` لتصميم المراجعة البشرية (تقرير تصميم فقط)

**التاريخ:** 2026-11-01 · **الفرع:** `arena/1c171b6c-…` · **مسودة `0009` ومِحْكّاتها:** `48f9630` · **هذا التقرير:** `6f3f486` · **المطلوب:** تقرير مراجعة واعتماد أخير **دون** تطبيق.

> **حالة هذه الجولة:** تشغيل فحوص §6 كاملة على **قاعدة D1 محلية حقيقية** (`wrangler --local`) — سبع حزم،
> **152 فحصًا، كلها خضراء** (T-A 18 · T-B 27 · T-B2 8 · T-C 31 · T-D 8 · T-E 45 · T-F 15) — ونتج عنها
> أربع فجوات تصميم موثَّقة في §8، اثنان منها **تعديلان مطلوبان في المسودة نفسها** قبل الترويج.
> أُعيد تشغيل المِحْكَّيْن المودَعين على الأداة الحالية: `ABUSE 97/97` و`D1_REHEARSAL 84/84` و`406/0`.
> **لم يحدث:** تطبيق أي هجرة على أي قاعدة · أي كتابة على `nasr-crm-test-db` · أي لمس لـ `nasr-market-db`
> أو النسخة الاحتياطية أو Drive · أي نشر Worker · أي دمج لـ PR #132 · أي تعديل في `.github/workflows/*`
> (سير العمل مُدرَج هنا **كمقترح للمراجعة فقط**). لا طبقة خدمة ولا واجهة مراجعة بعد.
> **النتيجة:** بانتظار اعتماد طارق الصريح قبل أي ترويج أو تنفيذ.

| المخرج | الحالة |
|---|---|
| `_worker/migrations-draft/0009_crm_drive_review_workflow.sql` | 507 سطرًا · 54 عبارة · 5 طاولات · **18 مشغّلًا** · **4 مناظر** · 8 فهارس · 72 `CHECK` · 15 رسالة `RAISE` |
| `_worker/tests-draft/crm-review-sql-0009.abuse.mjs` | `ABUSE 97/97 checks held` + `ALL_BARRIERS_HELD` (كانت 78) |
| `_worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | `D1_REHEARSAL 84/84 checks passed` على **محرك D1 الحقيقي** (كانت 53) |
| `.github/workflows/*` | **لم يُمسّ** — الفرق المقترح في §4 معروض للمراجعة |

---

## 1) التغييرات SQL الدقيقة المقترحة

كل شيء داخل `_worker/migrations-draft/`. الجدول أدناه هو **الفرق عن النسخة التي راجعها طارق سابقًا**
(15 مشغّلًا / منظران / 7 فهارس / 30 عبارة ← 18 / 4 / 8 / 54). لا تغيير في أي جدول تشغيلي قائم:
الهجرة **تُنشئ كائنات جديدة فقط** (`CREATE TABLE/VIEW/INDEX/TRIGGER IF NOT EXISTS`) ولا تحتوي `ALTER` ولا
`UPDATE` ولا `DELETE` على أي جدول من `0001..0008`.

### 1أ) إضافات هذا التنقيح (استجابةً لقرارات طارق السبعة)

| # | الكائن | التغيير | لماذا |
|---|---|---|---|
| 1 | `trg_review_event_session_live` (BEFORE INSERT على `crm_drive_review_event`) | `WHEN NOT EXISTS (SELECT 1 FROM crm_sessions s WHERE s.token_hash = NEW.session_hash AND s.revoked_at IS NULL AND s.expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000)` → `RAISE(ABORT,'review_event_session_not_live')` | صلاحية الجلسة تُفحص **وقت القرار** في القاعدة نفسها، لا في المعالج فقط: جلسة منتهية أو مسحوبة لا تستطيع تسجيل قرار مهما كان مصدر الطلب |
| 2 | `trg_review_event_approve_needs_fresh_reveal` (BEFORE INSERT) | البند الكامل في §2 | `approve` مشروط بـ `reveal` **سابق وناجح ومطابق** |
| 3 | `trg_review_seal_delete_window` (BEFORE DELETE على `crm_drive_review_seal`) | `WHEN OLD.revoked_at IS NULL AND datetime(OLD.expires_at) > datetime('now')` → `review_seal_delete_before_expiry` | الوفاء لمدة 90 يومًا **نافذةُ حذف** لا رخصة إتلاف مبكر: لا أحد (ولا حتى مدير القاعدة) يحذف ختمًا ما زال صالحًا |
| 4 | `CHECK` على `crm_drive_review_seal` | `retention_days INTEGER NOT NULL DEFAULT 90 CHECK (typeof='integer' AND retention_days BETWEEN 1 AND 90)` | سياسة 90 يومًا مكتوبة في المخطط؛ لا يمكن promised retention أطول |
| 5 | `CHECK` على `crm_drive_review_seal` | `CHECK (julianday(expires_at) - julianday(created_at) BETWEEN 1 AND 90)` | حتى لو كُتب `expires_at` يدويًا خارج النافذة يُرفض — الحقلان لا يتناقضان |
| 6 | `CHECK` على `crm_drive_review_event` | `CHECK (NOT (event_type='reveal' AND reveal_outcome='granted') OR seal_ciphertext_sha256 IS NOT NULL)` | كل كشف ناجح يجب أن يُثبّت هوية الـ blob الذي فُتح؛ بلا ذلك لا يمكن ربط قرار به |
| 7 | `idx_crm_review_event_reveal` | `CREATE INDEX … ON crm_drive_review_event (case_ref, event_type, reveal_outcome, event_seq DESC)` | البند 2 يعمل بحث `reveal` عند **كل** `approve`؛ بدون فهرس يتحول إلى مسح كامل للدفتر |
| 8 | `crm_review_seal_availability` (منظر) | `availability ∈ available\|expired\|revoked\|missing` + `age_minutes` + `key_version` + أختام زمنية — **بلا أي عمود محتوى** | مسار الكشف يسأل «هل يُسمح؟» من خلال هذا المنظر وحده، فلا يحتاج قراءة نص مشفَّر ولا كشف حالة داخليًا |
| 9 | `crm_review_ci_summary` (منظر) | لكل تشغيل: `cases, undecided, approved, excluded, deferred, conflicts, reveals, expired_seals, events, broken_links, anchor_mismatches, head_event_count, head_sha256` — **بلا** `reviewer` ولا `signal_digest` ولا `drive_file_id` ولا `session_hash` ولا `reason` | الشكل الوحيد المسموح بطباعته في سجلات CI (بند «لا بيانات شخصية في CI») |
| 10 | ترويسة الملف | أُعْلِن صراحةً: `0009` تعتمد على `0002` (`crm_sessions`) و`0008` (`crm_drive_analysis_run`) | `CREATE TRIGGER` يحلّ الأسماء وقت الإنشاء؛ قاعدة بلا `0002` ستفشل في الترحيل — يجب أن يُقرأ هذا من الملف لا من التخمين |

### 1ب) ما بقي كما صُمّم سابقًا (تلخيص بلا تغيير)

- **`crm_drive_review_case`** — مرجع قضية مستقر (`p4r-[0-9][0-9][0-9]` أو `p4c-[0-9][0-9]`)، أعمدة **مقنَّعة
  فقط** (مُلخّصات 16-خانة لـ Drive/contact، لا أسماء ولا هواتف)، `basis ∈ vcard_tel|sender_label_phone|
  transcript_overlap|name_digest|body_text`، و`approve_allowed = 0 OR (basis IN ('vcard_tel',
  'sender_label_phone') AND case_kind='file_to_contact')`، وشكل `contact_fanout` يتطلب
  `files_count >= 2 AND match_class='conflict'`، و`run_key` بمفتاح خارجي `ON DELETE CASCADE`، و
  `case_snapshot_sha256` (بصمة البطاقة المُقرَّرة التي عُرضت)، و`seal_state`.
- **`crm_drive_review_seal`** — مفتاح أولي `case_ref`؛ غلاف `p4rev_v1` / `AES-256-GCM` / `HKDF-SHA256` /
  `case_bound_v1` / `key_version 1..99`؛ `iv_b64u` (16) و`tag_b64u` (22) و`ciphertext_b64u` (24..8192)؛
  `ciphertext_sha256 UNIQUE`؛ `plaintext_len BETWEEN 1 AND 4096` (**سقف 4 ك.ب كما قرر طارق**).
- **`crm_drive_review_event`** — 24 عمودًا، **بلا مفتاح خارجي** على الجدول: لا cascade يمحو قرارًا.
  `UNIQUE(run_key,event_seq)` و`UNIQUE(case_ref,case_seq)`؛ `event_type` مربوط بـ `decision_state`
  في الاتجاهين؛ قائمة سوداء لـ `reviewer` (`auto,system,bot,worker,cron,pipeline,operator,unknown,none,na,-`)
  + `reviewer_attestation='session_label_not_independent_identity'` إلزامي؛ `session_hash` = 64 خانة
  ست-عشرية من `crm_sessions.token_hash` (**الرمز نفسه لا يُخزَّن أبدًا**); `reason` بين 12 و1000 حرف،
  بلا Tab/LF/CR، و`reason NOT GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'` (سقف D1 عند 10
  عناصر نمط، لذا 9 لا 10) + `reason_sha256`؛ ثلاث رايات ثابتة `link_applied=0` و`merge_authorized=0`
  و`contact_write_count=0`؛ `supersedes_id` للتصحيح؛ `prev_event_sha256`/`event_sha256 UNIQUE` للسلسلة.
- **`crm_drive_review_chain_head`** (قابل للتحديث، `BEFORE DELETE` ممنوع) +
  **`crm_drive_review_chain_anchor`** (مرآة إلحاقية فقط) — genesis يُبذَر من التطبيق بـ
  `sha256('p4rev_genesis|'||run_key)`؛ غياب الرأس يمنع كل إلحاق.
- **`crm_review_chain_integrity`** و**`crm_review_case_state`** — كما هما؛ السليم ⇔
  `broken_links = 0 ∧ anchor_mismatches = 0 ∧ events = head_event_count = anchors`، والحالة الحالية =
  آخر قرار فقط (لا حالة مخزَّنة قابلة للتحريف).

---

## 2) كيف تُثبَت صلة `reveal` ↔ `approve`

القرار 3 لطارق: «`approve` يتطلب `reveal` ناجحًا سابقًا على نفس `case_ref` ونفس
`case_snapshot_sha256`، مع فحص الجلسة والصحة **وقت القرار** — لا مجرد وجود حدث قديم».
التنفيذ في مشغّل واحد يمكن ترجمته حرفيًا إلى استعلام تدقيق في CI:

```sql
CREATE TRIGGER IF NOT EXISTS trg_review_event_approve_needs_fresh_reveal
  BEFORE INSERT ON crm_drive_review_event
  WHEN NEW.event_type = 'approve'
      AND NOT EXISTS (
        SELECT 1 FROM crm_drive_review_event r
          WHERE r.case_ref              = NEW.case_ref             -- نفس القضية
            AND r.event_type            = 'reveal'
            AND r.reveal_outcome        = 'granted'               -- ناجح، لا denied/unavailable
            AND r.case_snapshot_sha256  = NEW.case_snapshot_sha256 -- نفس البطاقة المُقرَّرة
            AND r.reviewer              = NEW.reviewer             -- نفس المراجع
            AND r.session_hash          = NEW.session_hash         -- نفس الجلسة
            AND r.event_seq             < NEW.event_seq            -- سابق في السلسلة
            AND julianday(NEW.occurred_at) - julianday(r.occurred_at) <= 1.0  -- ≤ 24 ساعة
            AND (SELECT se.ciphertext_sha256 FROM crm_drive_review_seal se
                  WHERE se.case_ref = NEW.case_ref) IS r.seal_ciphertext_sha256
      )
BEGIN
  SELECT RAISE(ABORT, 'review_approve_requires_fresh_reveal');
END;
```

**لماذا كل بند ضروري** (ولا يكفي أي واحد بمفرده):

| البند | يقطع طريق… |
|---|---|
| `event_type='reveal' AND reveal_outcome='granted'` | «رأيت الكرت» بعد رفض/انتهاء — `CHECK` يُلزم كل كشف ناجح بتثبيت `seal_ciphertext_sha256` |
| `case_ref` + `case_snapshot_sha256` | القرار بعد إعادة بناء القضية ببيانات مختلفة؛ لا يفتح «قرارًا على بيانات لم تُعرض» |
| `reviewer` + `session_hash` | ركوب كشف شخص/جلسة آخرين (تجربة `approve under a second live session` و`reusing the reveal of another reviewer` مرفوضتان فعليًا) |
| `event_seq < NEW.event_seq` | كشف **لاحق** يُستخدم لتبرير قرار سابق زمنيًا |
| `julianday` ≤ 1.0 | قرار من الشهر الماضي بكشف قديم (تجربة `approve on a reveal older than the 24 hour window`) |
| `IS r.seal_ciphertext_sha256` (عبر `IS` ليقبل NULL=NULL) | **تدوير الختم**: بعد `re-seal` لم يعد الـ blob الحالي هو ما فُتح ⇒ الكشف يُعَدّ غير صالح (مُثبَت بتجربة `approve after the seal was rotated`) |
| `trg_review_event_session_live` منفصل | القرار لا يُقبل أبدًا من جلسة منتهية/مسحوبة، حتى لو وُجد كشف صالح؛ والكشف نفسه يخضع لنفس الفحص |

**لا وجود لـ «مجرد حدث قديم»:** لأن الربط لا يسأل عن وجود كشف، بل عن كشف **مطابق وسابق وحيّ ومطابق للـ blob
الحالي**. والفحص يتم داخل عبارة الإدراج نفسها (BEFORE INSERT)، فقرار مكتوب في نفس المعاملة يخضع لنفس
القاعدة التي يخضع لها كشف القراءة.

**تدقيق CI (نفس المحمول، قراءة فقط)** — يجب أن يكون الصفري هو المعيار، لا رسالة الخطأ:

```sql
SELECT COUNT(*) AS unbound_approves
  FROM crm_drive_review_event a
 WHERE a.event_type = 'approve'
   AND NOT EXISTS (SELECT 1 FROM crm_drive_review_event r
          WHERE r.case_ref = a.case_ref AND r.event_type = 'reveal' AND r.reveal_outcome = 'granted'
            AND r.case_snapshot_sha256 = a.case_snapshot_sha256 AND r.reviewer = a.reviewer
            AND r.session_hash = a.session_hash AND r.event_seq < a.event_seq
            AND julianday(a.occurred_at) - julianday(r.occurred_at) <= 1.0
            AND (SELECT se.ciphertext_sha256 FROM crm_drive_review_seal se
                  WHERE se.case_ref = a.case_ref) IS r.seal_ciphertext_sha256);
```

**ما يُثبِت ذلك فعليًا الآن:** المِحْكان يشغّلان نفس المحامل، لا نصوصًا مزيفة:

- `node …abuse.mjs` → **97/97** و`ALL_BARRIERS_HELD`، منها 9 فحوصات جديدة على هذا الربط
  (مرفوض: بلا كشف، بـ blob خاطئ، بجلسة ثانية، بمراجع آخر، بكشف عفا عليه الزمن، كشف ناجح بلا تثبيت blob،
  قرار بجلسة منتهية، قرار/كشف بجلسة مسحوبة؛ ومسموح: `approve` بعد كشف مطابق — **ضبط إيجابي** حتى لا يكون
  الرفض من عطل في الاختبار).
- `python3 …d1-rehearsal.py` → **84/84** على **محرك D1 الحقيقي** (`wrangler d1 execute --local`، قاعدة مؤقتة
  تُمحى ذاتيًا)، وتُثبت أن الرسائل تظهر كما هي من D1 وأن `datetime('…Z')`/`julianday`/`strftime('%s','now')`
  تعمل في D1 كما في `node:sqlite`.
- **ملاحظة هندسية مُستخرَجة من D1:** ترتيب إشعال مشغّلات على نفس الجدول ونفس الحدث **غير مضمون**
  (رُصد `…_session_not_live` و`…_needs_fresh_reveal` قبل `…_case_not_found` و`…_phone_backed_basis`).
  لذا كل فحص يترك حاجزًا واحدًا قائمًا، والحالات متعددة الحواجز تقبل أيًّا منها، ولا يُعتمد على الرسالة
  كعقد — الاعتماد على استعلام التدقيق أعلاه.

---

## 3) سياسة الاحتفاظ 90 يومًا والإبطال بعد انتهائها

**المبدأ:** الاحتفاظ حقُّ المراجع في أن يرى الأصل أثناء المراجعة؛ **والإبطال** بعد ذلك **توثيقٌ وحظرُ قراءة**،
لا حذف للدفتر.

| العنصر | السياسة | أين مكتوبة |
|---|---|---|
| مدة الختم | 1..90 يومًا، الافتراضي **90** | `retention_days DEFAULT 90 CHECK (BETWEEN 1 AND 90)` + `julianday(expires_at)-julianday(created_at) BETWEEN 1 AND 90` |
| سقف المحتوى | 4 ك.ب للأصل المُقرَّر (بطاقة واحدة `FN/TEL/EMAIL/NOTE` + مراجع مقنَّعة) | `plaintext_len BETWEEN 1 AND 4096` |
| حذف الختم حيًّا | **ممنوع** قبل `expires_at` ما لم يُلغَ صراحةً | `trg_review_seal_delete_window` → `review_seal_delete_before_expiry` |
| الإلغاء المبكر | `UPDATE … SET revoked_at = now` مسموح دائمًا، ويُطفئ الإتاحية فورًا | لا مشغّل على `UPDATE` للختم (بما فيه تدوير `key_version`)؛ `availability` تصبح `revoked` |
| المسح (sweep) | وظيفته حذف ما هو **`expired` أو `revoked` فقط**؛ كل حذف آخر مرفوض من القاعدة | مِحوَل المسح المقترح في طبقة الخدمة لاحقًا؛ مُثبَت في المِحْكين |
| ماذا يحدث عند الانتهاء؟ | المسار يرفض الكشف: `seal_expired` (و`seal_revoked`, `seal_missing`, `key_version_unavailable`, `seal_auth_failed`)، ويسجّل حدث `reveal` بنتيجة `denied` **قبل** عدم الإرجاع بأي بايت | `crm_review_seal_availability` يعطي الإجابة بلا قراءة المحتوى؛ `availability ∈ available\|expired\|revoked\|missing` |
| الدفتر | **لا حذف تلقائيًا أبدًا.** قرارات/ملاحظات/كشوف تبقى بلا حد زمني، وتبقى غير قابلة للتعديل أو الحذف | `trg_review_event_no_update/no_delete`, `trg_review_head_no_delete` |
| إبطال البيانات المشفَّرة | حذف `CRM_REVIEW_SEAL_KEY` من `nasr-crm-api-test` = عدم قراءة فوري لكل الأختام مع بقاء الدفتر والقرارات سليمة؛ النصوص الواضحة لم تُكتب قط في D1 | §3 من `CRM_PHASE4_REVIEW_SECURITY.md` |
| إبطال معلَن لا صامت | بعد انتهاء 90 يومًا تُحدَّث `seal_state` إلى `unavailable` بواسطة `trg_review_seal_after_delete`، ويبقى `note` في الدفتر يشرح السبب عند أي عملية مسح مجدولة | مشغّلا `AFTER DELETE/AFTER INSERT` على الختم + `note` إلزامي للمسح |
| البصمات | `seal_ciphertext_sha256` و`plaintext_sha256` و`reason_sha256` تبقى بعد الإبطال — إثبات على ما فُتح دون إبقاء ما فُتح | أعمدة الجدولين |
| الأثر الحجمي | ≤ 64 قضية × ~4 ك.ب ≈ **256 ك.ب**峰值 ثم تتجه إلى **0** بعد 90 يومًا إلا إذا أُعيد الختم | لا شيء إضافي مطلوب من D1 (نفس القاعدة، نفس الخطة) |

**ما لا تغيّره هذه السياسة (مهم لطارق):** لا حذف ولا تحريك ولا تعديل لأي ملف Drive أصلي؛ السجل
`crm_drive_file_registry` (هجرة 0007) **ليس** جدول تشغيلي ولا يُكتب عليه من مسار المراجعة؛ قاعدة备份
`nasr-crm-test-db-backup-20261101` لا تُلمَس؛ `nasr-market-db` ممنوعة؛ ولا يوجد أي مسار في `0009` يمس
`contacts`/`opportunities`/`conversations`/`followups`. بعد الانتهاء: **الأصل مشفَّر بلا مفتاح، القرار
موثَّق للأبد، والطريق إلى قراءة الأصل مغلق من القاعدة نفسها.**

---

## 4) التغيير المقترح في `crm-cloudflare-test-deploy.yml` (للمراجعة فقط — لم يُطبَّق)

**المشكلة كما هي اليوم:** `on.push.branches: [master, 'arena/**']` بلا أي بوابة على مستوى الوظيفة ⇒ أي دفع
إلى أي فرع `arena/**` يمس أحد 21 مسارًا المُدرجة يُنشئ قاعدة مرحّلة **و** يطبّق الهجرات `--remote`
(سطر 313 قاعدة مرحّلة، سطر 335 `nasr-crm-test-db`) **و** ينشر Worker الاختبار. النشر يجب أن يكون
**فعالا صريحا مصرَّحا به** (قرار طارق 5).

```diff
 on:
-  push:
-    branches:
-      - master
-      - 'arena/**'
-    paths:
-      - .github/workflows/crm-cloudflare-test-deploy.yml
-      - scripts/crm/build-crm-site-seed-sql.mjs
-      - _worker/crm-worker.js
-      - … (18 مسارًا آخر) …
-      - _worker/tests/live-post-deploy-verify.mjs
-  workflow_dispatch:
+  # لا تشغيل تلقائي عند أي push. النشر إلى قاعدة الاختبار ونشر Worker = فعل صريح مُصرَّح به.
+  workflow_dispatch:
+    inputs:
+      authorize_deploy:
+        description: 'اكتب DEPLOY-TEST-DB-and-WORKER للتصريح بتطبيق الهجرات ونشر Worker الاختبار'
+        required: true
+        type: string
 
 jobs:
   deploy-and-verify:
+    # حارس على مستوى الوظيفة…
+    if: github.event.inputs.authorize_deploy == 'DEPLOY-TEST-DB-and-WORKER'
     …
       - name: Backup D1, stage-test 0005 migration, deploy nasr-crm-api-test, and run live E2E
+        # القيمة تصل كمتغيّر بيئة، **لا** داخل نص السكربت (انظر «ما أُثبت بالتجربة» أدناه)
+        env:
+          AUTHORIZE_DEPLOY: ${{ github.event.inputs.authorize_deploy }}
+        # …وحارس ثانٍ داخل الخطوة، مقارنة نصّية صارمة قبل أي أمر wrangler
         run: |
+          if [ "${AUTHORIZE_DEPLOY:-}" != 'DEPLOY-TEST-DB-and-WORKER' ]; then
+            echo "::error::not authorized: migrations apply + Worker deploy need an explicit token"
+            exit 1
+          fi
           set -euo pipefail
```

**ما أُثبت بالتجربة على هذا المقترح (T-E، 45 فحصًا):** نموذج حتمي لنصّ الحارس شُغِّل محليًا مع مُسجِّل
يحلّ محل واجهة Cloudflare، و 7 نسخ مُرقَّعة من `crm-cloudflare-test-deploy.yml` في **العمل المؤقت** (لم
يُمسّ ملف المستودع) فُحصت بنيويًا بـ js-yaml ثم شُغِّل جسم الخطوة بـ `npx` مزيف. النتائج:

| المُعطى | الصيغة الساذجة (`[ "${{ inputs.x }}" != "TOKEN" ]`) | الصيغة المُصحَّحة (`env` + `!=` نصّي) |
|---|---|---|
| push/إعادة تشغيل بلا مُدخلات | لا تنشر (لأن `inputs` فارغة فقط — ليست سياسة) | مرفوضة ✅ |
| رمز خاطئ / فارغ / بحرف مسافات زائدة / بحجم أحرف مختلف / بادئة الرمز | — | مرفوضة كلها ✅ (9 سيناريوهات) |
| `TOKEN` + سطر جديد أو سطر قمامة | **مقبولة** مع `grep -Eqx` (تطابق أي سطر) | مرفوضة ✅ — لذلك قارنّا نصيًّا لا بنمط |
| قيمة تحمل `x" ]; then … ; fi; #` | **تنفّذ أوامر اعتباطية** (الحقن داخل نص السكربت) | مجرد سلسلة في متغيّر؛ لا شيء ينفَّذ ✅ |
| إعادة تشغيل dispatch مُعتمد سابقًا | تعيد الاعتماد (المدخلات مُخزَّنة في الحدث) | **نفس الشيء** — انظر المخاطرة المتبقية |
| ترتيب الحارس قبل أول أمر مميز | — | ✅ مُثبت بنيويًا في النسخة المُرقَّعة |
| حماية `nasr-market-db` القائمة | تبقى فعّالة حتى مع تشغيل مُصرَّح ✅ | ✅ |

**المخاطرة المتبقية (لا تُغلق بالحارس):** إعادة تشغيل أي run مُعتمد تُعيد استخدام مُدخلاته، فلا `if:` الوظيفة
ولا الحارس داخل الخطوة يفرّقان بين «أعد التشغيل» و«أدخل الرمز». الإغلاق الوحيد هو **environment protection
rule** على الوظيفة (`environment: crm-test-db-approval` بمُوافِقين)، ويُنبَّه طارق أنه يضيف سلوك انتظار في CI.

**ونفس النمط مطلوب على سير عمل التحليل (لأنه يطبّق المجلد كاملًا):**

```diff
 on:
   push:
     branches: [ 'arena/**' ]
   workflow_dispatch:
+    inputs:
+      authorize_apply:
+        description: 'اكتب APPLY-TO-TEST-DB للتصريح بتطبيق الهجرات على nasr-crm-test-db'
+        required: true
+        default: 'DRY-RUN'
+        type: string
```
```diff
-          # 9) Apply migration 0008 (idempotent) and verify the barrier columns exist.
-          npx --yes wrangler@4 d1 migrations apply "$TEST_DB_NAME" --remote --config "$WRANGLER_CFG" > "$TMP/live_mig.log" 2>&1
+          # 9) Apply migrations — only on an explicitly authorized dispatch.
+          AUTHORIZE_APPLY='${{ github.event.inputs.authorize_apply }}'
+          if [ "${AUTHORIZE_APPLY:-}" = "APPLY-TO-TEST-DB" ]; then
+            echo "authorize=apply" >> "$GITHUB_STEP_SUMMARY"
+            npx --yes wrangler@4 d1 migrations apply "$TEST_DB_NAME" --remote --config "$WRANGLER_CFG" > "$TMP/live_mig.log" 2>&1
+          else
+            echo "dry-run: skipping 'd1 migrations apply'" >> "$GITHUB_STEP_SUMMARY"
+          fi
+          # **القراءة في الحالتين** — لا تُختلق قيمة في فرع dry-run:
+          npx --yes wrangler@4 d1 execute "$TEST_DB_NAME" --remote --json --config "$WRANGLER_CFG" \
+            --command "SELECT (SELECT COUNT(*) FROM d1_migrations) AS m, (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'crm_drive_%') AS t" > "$TMP/live.json"
+          live_mig=$(node -e '…read $TMP/live.json, validate numbers…' || echo "migs=?,phase4_tables=?")
```

ثلاث ملاحظات مفروضة نتجت عن الفحص (كلها مُثبتة في T-E):

1. **فرع dry-run في المقترح الأصلي كان يكتب `live_mig="migs=8,…"` نصًّا** ⇒ أي فحص عدّاد يليه يمرّ على قيم
   مُختلَقة حتى لو كانت القاعدة عند 9 (أو 7 طاولات). الصواب: **قراءة القياس في الحالتين**، و`migs=?` عند تعذّر
   القراءة (لا اختلاق 8) — مُختبَر على الحالتين ✅.
2. **`--quiet` ليست واسطة معروفة في `wrangler d1 execute` (4.156.0)** ⇒ «Unknown argument: quiet» وقتل
   الخطوة. أي أمر قياس في سير العمل يستخدم `--json` وحده.
3. **الرقم «الصادق» ليس ما كتبه المقترح:** على قاعدة محلية نظيفةقياس `0001..0008` هو
   `migs=8,phase4_tables=7` وبعد `0009` هو `migs=9,phase4_tables=12` (لأن طاولات المسودة الخمس تدخل نمط
   `crm_drive_%`). أي ثابت في سير العمل يجب أن يُشتَق من **قياس** لا من كتابة يدوية — وهذا بالضبط سبب بقاء
   الفحص كما هو في §5 (R2/R3) حتى يُحدَّث في commit الترويج نفسه.

**مسارات التنفيذ البديلة إن رفض طارق تعديل سير العمل الآن:** (أ) إبقاء `0009` في `migrations-draft` إلى
الأبد مع «ترحيل يدوي مُصرَّح به»؛ (ب) نقل بوابة `migrations apply` إلى ملف قابل لإعادة الاستخدام
(`.github/actions/apply-crm-migrations`) يحمل الحارس في مكان واحد. **التوصية:** الخيار أعلاه (حارس مزدوج)
لأن (أ) يُبقي خطر تشغيل عرضي و(ب) يضيف سطح صيانة.

**توضيح مهم:** `paths:` في `crm-cloudflare-test-deploy.yml` يذكر ملفات `0002..0006` بأسمائها ولا يتضمن
`_worker/migrations/**` عامًّا — أي أن نقل `0009` وحده لا **يُشغّل** هذا السير، لكنه يطبّق المجلد كاملًا
عند أي تشغيل لآخر سبب ⇒ لذلك الحارس لازم على **الخطوة**، لا على `paths:` فقط.

---

## 5) مخاطر ترويج `0009` إلى `_worker/migrations/` ورفع العدّاد 8→9

| # | الخطر | الأثر | التخفيف المطلوب في نفس Commit |
|---|---|---|---|
| R1 | **تطبيق مبكّر**: أول دفع مُشغِّل لأي سير عمل يطبّق المجلد ⇒ `0009` تُطبَّق على `nasr-crm-test-db` بلا موافقة | لا رجعة نظيفة بعد وجود الأرقام في `d1_migrations` | لا يُروَّج الملف إلا مع §4 مُطبَّقًا، أو يُطبَّق يدويًا بأمر واحد مُصرَّح به |
| R2 | **فحص `migs` الصارم** في `crm-phase4-analysis.yml:660` (`migs != '8'` ⇒ فشل) | كل تشغيل تحليل لاحق يفشل فورًا بعد الترويج | تغييره إلى `'9'` **في نفس commit** نقل الملف، مع `latest_mig = 0009_crm_drive_review_workflow` |
| R3 | **العكس**: تحديث الفحص قبل نقل الملف ⇒ تشغيل «أخضر» وقاعدة متأخرة | كذب بوابة الجودة | لا يُقبل commit يعدّل 660 دون rename؛ يراقَب `latest_mig` لا العدد وحده |
| R4 | **اعتماد على `0002`**: `trg_review_event_session_live` يحلّ `crm_sessions` وقت الإنشاء | قاعدة بلا `0002` تفشل في الترحيل (نصف مطبَّق) | الترحيل مرتّب في D1؛ إضافة بوابة CI: `SELECT COUNT(*) FROM sqlite_master WHERE name='crm_sessions'` = 1 **قبل** التطبيق |
| R5 | **قفل الكتابة**: كل `INSERT` على الدفتر صار يتطلب جلسة D1 حيّة | عطل في `crm_sessions` أو رمز قديم ⇒ يتعطل مسار المراجعة كاملًا | توثيد في طبقة الخدمة: رفض مبكر برسالة `session_not_live` **قبل** محاولة الكتابة؛ لا توسيع صلاحيات Worker (قاعدة قائمة) |
| R6 | **ترتيب المشغّلات غير مضمون في D1** | رسائل خاطئة مختلفة عن `node:sqlite`؛ كسر اختبارات تربط برسالة | اختبارات تقبل أي حاجز/محامل منفصلة؛ CI يعتمد استعلام §2 لا الرسائل |
| R7 | **قفل القرار الخاطئ**: `approve` غير قابل للتراجع بحذف | خطأ بشري يبقى | هذا مقصود؛ التصحيح بحدث `supersedes_id`. **الشفاء** لا يُلغى بدفتر |
| R8 | **عدم وجود FK من `crm_drive_review_event`** ⇒ حذف `case` ممكن نظريًا مع بقاء الأحداث (يتيّم) | يتعطل كل إلحاق لاحق على تلك القضية | بوابة CI بعد الترويج: لا `case_ref` في الدفتر بلا صف قضية؛ لا حذف للأحداث أصلًا |
| R9 | **العودة للوراء ليست `ALTER`**: لا يمكن «تراجع» مشغّل/منظر بـ `d1 migrations` | — | سُلَّم محدد: `DROP VIEW ×4`، `DROP TRIGGER ×18`، `DROP TABLE ×5`، ثم `DELETE FROM d1_migrations WHERE name LIKE '0009%'`، **والدفتر لا يُلغى** (التراجع عن قرار = حدث `exclude`)؛ رجوع Worker عبر Cloudflare Versions |
| R10 | **إعادة الترقيم**: تغيير اسم الملف أو ترتيبه لاحقًا يجعل `d1_migrations` يعتبره هجرة جديدة | تطبيق مزدوج أو «لا شيء» | `0009` هو الاسم النهائي؛ لا إعادة تسمية بعد الترويج؛ كل العبارات `IF NOT EXISTS` (أُثبت: إعادة التطبيق **no-op** وتُعيد المشغّلات المحذوفة) |
| R11 | **أداء الإلحاق**: كل `approve` يضيف بحثًا مفهرسًا + كل إدراج يفحص `crm_sessions` | negligible على 64 قضية | `idx_crm_review_event_reveal` أُضيف لهذا؛ يبقى < 1ms/إدراج محليًا |
| R12 | **سقف 4 ك.ب** يقصّ بطاقات `NOTE` طويلة | فقدان تفصيل داخل الختم (لا في Drive) | يبقى الرفض صريحًا (`plaintext_len` CHECK) بدل قصّ صامت؛ التوثيق في `reason` |
| R13 | **الخصوصية**: `reviewer` و`reason` حساسان داخل الدفتر | تسرّب عبر سجلات CI/تقارير | `crm_review_ci_summary` محجوب الأعمدة؛ يُمنع طباعة `signal_digest`/`decided_by` في أي تقرير |
| R14 | **المفتاح**: ضياع `CRM_REVIEW_SEAL_KEY` قبل انتهاء المراجعة | الأصل غير مقروء، القرارات سليمة | مقبول ومصمَّم (إبطال ذاتي)؛ لا نسخة من المفتاح في Git/CI؛ لا يُعاد استخدام مفتاح `enc_v1` |

**commit الترويج المقترح (غير منفَّذ):** `git mv _worker/migrations-draft/0009_crm_drive_review_workflow.sql
_worker/migrations/0009_crm_drive_review_workflow.sql` + تعديل `crm-phase4-analysis.yml` (660 → `'9'`،
بوابة `latest_mig`، بوابات `d1_review_triggers = 18` و`d1_review_views = 4` واستعلام §2 عند 0) + تحديث
`_worker/migrations-draft/README.md` + خطوة «سلسلة كاملة» في القاعدة المؤقتة (سطر 232) تطبّق
`0001..0009` قبل أي تطبيق حيّ — **كله في commit واحد** حتى لا تُرى القاعدة والعدّاد غير متفقين.

---

## 6) الاختبارات الإضافية المطلوبة قبل الترويج

**موجود وأخضر:** `ABUSE 97/97` (‏node:sqlite) · `D1_REHEARSAL 84/84` (محرك D1، `--local`، قاعدة مؤقتة) ·
`_worker/tests` ‏**406/406** · canary الخصوصية **14/14** · eslint (SonarJS 4.2.2) نظيف على الملفات المغيَّرة.

**منفَّذ في هذه الجولة — على قاعدة D1 محلية حقيقية (`wrangler --local`)، بسبع حزم و152 فحصًا:**

| الحزمة | الفحوص | ما تثبته (بإيجاز) |
|---|---|---|
| **T-A** سلسلة الهجرات | 18/18 | `0001..0008` تُطبَّق فوق مخطط الأساس بـ `migs=8`؛ `0001..0009` تُطبَّق بترتيبها مع ids متصلة؛ البوابة scoped تُعطي بالضبط `{table:5,index:8,trigger:18,view:4}`؛ رسائل الحواجز الـ13 كلها موجودة؛ **67 كائنًا قائمًا DDL الخاص به بايت-ببايت بلا تغيير**؛ لا كائن خارج نطاق `0009`؛ إعادة التطبيق no-op ويُعيد المشغّلات المحذوفة؛ `foreign_key_check` فارغ و`run_key` يتيم مرفوض؛ قاعدة بلا `0008` ⇒ التطبيق ينجح وأول كتابة تُرفض؛ قاعدة بلا `0002` ⇒ التطبيق ينجح وكل كتابة تُرفض بـ `no such table: main.crm_sessions` (وهو ما تلتقطه بوابة «قبل التطبيق» المقترحة) |
| **T-B** النسخة الاحتياطية | 27/27 | تصدير `d1 export --local` (raw/‏--no-data/‏--no-schema) ينجح ويحمل المشغّلات الـ18 والمناظر الأربعة؛ **لكن مُجمِّع الحزمة في مسار Phase-2 يفشل على تصدير ما بعد `0009` (`errcode 1811`)** لأن إدراجاتها تُصادف مشغّلات الدفتر، والحزمة الناجحة تُعدّ الطاولات/الفهارس فقط ⇒ **0 مشغّل و0 منظر**. الوصفة الصحيحة مُثبتة: استعادة على مرحلتين (1231 سطر جداول/فهارس/بيانات ثم 237 سطر مشغّلات/مناظر) ⇒ نفس البصمات للثماني طاولات المراقبة، lost=0/changed=0، الحواجز 18/18، `d1_migrations` محفوظة، وكل الفحوص الستة بعد الاستعادة تنجح |
| **T-B2** ترتيب الاستعادة | 8/8 | الاستعادة الخام تحفظ الصفوف والحواجز وتفرض منع الكتابة فوق القرار/المسح/الموافقة العمياء؛ **تكرار نفس الإدراجات يُرفض بصوت عالٍ** (الاستعادة ليست idempotent)؛ وبوضع صف الـ checkpoint أولًا **تفشل الاستعادة ذرّيًا (0 كائن مراجعة)** ⇒ لا دفتر نصف مستعاد؛ الإنعاش = تطبيق `0009` وحده ثم وصفة المرحلتين |
| **T-C** الحجم والحواجز | 31/31 | 64 قضية/40 ختمًا/104 أحداث في ملف واحد ~2.0 ث؛ منظر السلامة المُودَع يُعطي `broken_links=1` على دفتر **سليم** (عيوب مولّد السلسلة) والنموذج الواعي بالـ genesis يُعطي 0 ويلتقط حذف وسط/إعادة لفّ الرأس وتزوير بصمة المولد؛ تدقيق الصلة = 0 على السليم و**غير فارغ بعد إسقاط الحاجز** (لا بوابة ميتة)؛ ثقب إعادة مفتاح الختم مُثبت (تغيير `ciphertext_b64u` وحده يُبقي الموافقة مربوطة) والنموذج `trg_review_seal_no_rekey` يرفعه (18⇒19) مع إبقاء الإبطال وتقصير المدّة مسموحًا؛ 91 يومًا مرفوضة؛ حذف ختم حيّ مرفوض حتى مع FK مطفأ، ومسوّح بعد الإبطال؛ التوفّر `{available:37,expired:1,missing:25,revoked:1}`؛ الكمون 1.48–2.04 ث/إلحاق عبر CLI؛ نظافة PII: 0 تسلسلات هاتف، 0 بريد، 24 عمود حدث لا شكل شخصي فيها، و`crm_review_ci_summary` يمرّ قائمة 14 عمودًا ويسقط لو أُضيف `reviewer` |
| **T-D** إعادة حساب البصمة | 8/8 | السلسلة القانونية `p4rev_event_v1` (17 حقلًا) تعيد نفس بصمات D1، والمدقئ القارئ-only يرى 0 انتهاك على السليم؛ **تعديل `reason` في المحل لا يراه المنظر لكنه يُلتقط**؛ إعادة التوقيع بعد التزوير تُلتقط 3 مرّات وبالمنظر؛ إعادة `0009` تُعيد المشغّلات الـ18. الاستنتاج: لا منظر وحده يكفي — يجب إعادة حساب في CI (لا عمود جديد مطلوب) |
| **T-E** البوابتان | 45/45 | انظر §4: 9 سيناريوهات رفض + حقن مُثبت ومُغلق + قراءة صادقة للعدّاد + 7 نسخ مُرقَّعة من YAML (كل خاصية بمفردها، والسلبيات تُرفض للسبب المقصود فقط) |
| **T-F** الأداة والحالة | 15/15 | `HEAD=48f9630` على فرع الجلسة وشجرة العمل نظيفة و`git status .github/workflows` فارغ (البوابة لم تُطبَّق)؛ commit الاعتماد لمس 4 ملفات فقط (لا سير عمل/لا Worker/لا موقع)؛ wrangler 4.156.0/node v22.22.3/Python 3.11.2؛ لا `--remote` في المِحْكَّيْن المودَعين؛ **إعادة تشغيل المِحْكَّيْن الآن**: `ABUSE 97/97` و`D1_REHEARSAL 84/84` (`remote_databases_touched=none`) و`_worker/tests` **406/0**؛ فحص PII على الملفات الثمانية المراجعة نظيف (باستثناء المُثْبَط السلبي الوحيد `01012345678` المستخدم لإثبات الرفض)؛ سجل 191 قضية ما زال خارج المستودع بوضع 0600 |

**باقٍ قبل الترويج (اثنان فقط، وكلاهما يحتاج صلاحيات/تصريحًا خارج هذه الجولة):**

1. **محاكاة على قاعدة D1 مؤقّتة حقيقية في CI** (`wrangler d1 create crm-0009-rehearsal-<run_id>` ⇒ تطبيق
   `0001..0009` الحقيقي ⇒ نفس اللائحة ⇒ `d1 delete` في `if: always()`). هذا هو الفرق الوحيد المتبقي بين
   `--local` و`--remote`؛ لم يُشغَّل لأن إصدار تشغيل CI على هذا الفرع أعاد 403 ولا صلاحية قراءة/كتابة لأي
   قاعدة حيّة من الصندوق. **البقية العشرة في القائمة السابقة مُنفَّذة أعلاه** (بوابة البنية، تدقيق الصلة
   واختباره المضاد، نضارة الصفر بالوعي بالـ genesis، سقف الخصوصية، تمارين الحواجز الأربعة، اختبار الاستعادة،
   اختبار التراجع، فحص خلوّ البيئة).
2. **مسار الكشف على مستوى HTTP** (بعد الموافقة على طبقة الخدمة): CSRF مطلوب؛ بلا جلسة ⇒ رفض؛ جلسة منتهية/
   مسحوبة ⇒ `session_not_live` ولا بايت مشفَّر يُعاد؛ `no-store` حاضر؛ رسالة الخطأ لا تحمل plaintext ولا padding؛
   `seal_expired|revoked|missing` تُسجَّل كأحداث `denied`.

**مغطّى ولا يُعاد كتابته:** parses/apply/idempotency، append-only، منع erase/rewind، كشف التزوير بعد إسقاط
الحواجز، رفض `link_applied/merge_authorized/contact_write_count = 1`، قائمة `reviewer` السوداء،
`reason` (طول/أسطر/أرقام/بريد/عربي)، 12 → 1000 مع `supersedes_id`.

---

## 7) إثبات أن قاعدة الاختبار والإنتاج والنسخة الاحتياطية لم تتغيّر

| الدليل | كيف يُتحقَّق | النتيجة لهذه الجولة |
|---|---|---|
| لا `--remote` إطلاقًا | `grep -n -- '--remote' _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | **0** — السكربت `--local` فقط على قاعدة `p9rev-*` مؤقتة داخل `/tmp` تُمحى بعد التشغيل |
| لا SQL موجَّه إلى `nasr-crm-test-db` | كل `d1 execute/migrations/export` في الجولة استهدف قواعد مؤقتة باسم `ta-*`/`tb-*`/`tc-*`/`td-*`/`te2-*` داخل `/home/user/p9gate` بـ `--local` وحده | **0** استعلام ذُكر فيه `nasr-crm-test-db` أو UUID ‏`65bfcb14-4b48-423b-916f-00eefdb9ae1e`؛ و`git status .github/workflows` فارغ ⇒ لا سير عمل عُدِّل (T-F) |
| كل كتابة كانت على قواعد إسقاط | حواجز `d1.py`: لا تبني `--remote` إطلاقًا، وكل قاعدة لها `database_id = 00000000-…` صوري | الفحوص الخضراء في T-A..T-F كلها `engine=Cloudflare D1 (wrangler --local)`؛ لا قاعدة Cloudflare حقيقية استُخدمت (ولا ephemeral remote — انظر §6/1) |
| `nasr-market-db` ممنوعة وآمنة | لم تُذكر في أي أمر هذه الجولة | لم تُمسّ (آخر إقرار CI: `market_untouched=yes(nasr-market-db:905216:0)`) |
| النسخة الاحتياطية | لا أمر `restore`/`export`/`--remote` | `backup_untouched=yes(…20261101:3256320:0)` كما في آخر إقرار CI |
| لا نشر Worker / لا Deploy | `gh run list --branch arena/1c171b6c-… --limit 6` | آخر تشغيلين على `48f9630`: **Worker & page tests** و**SonarCloud Scan** فقط (كلاهما نجح)؛ لا `crm-cloudflare-test-deploy`، لا `apply` حيّ |
| لا دمج، لا لمس `master` | `git log --oneline -1` · `git diff --stat master…HEAD` | `48f9630`؛ `origin/master` ما زال `4c42806`؛ PR #132 مفتوح ولم يُدمج؛ الفرق مستندات + `_worker/migrations-draft` + `_worker/tests-draft` (4 ملفات، +814/−74) |
| لا تطبيق هجرة | لا ملف في `_worker/migrations/` أضيف؛ `0009` داخل `migrations-draft` | عدّاد `d1_migrations` في قاعدة الاختبار الحيّة لم يتغيّر (ما زال `migs=8` كما أقرّ CI)؛ القيم `8`/`9` التي تظهر في هذا التقرير هي **لقواعد مؤقتة** فقط (`ta-baseline`=8، `te2-full`=9) |
| لا لمس Drive | لا استدعاء `google_drive__*` هذه الجولة؛ `list`/`get` لم يُستعملا | الملفات الأصلية وأذوناتها لم تتغير (لا كتابة إطلاقًا منذ بداية المرحلة) |
| الهجرة لا تكتب على أي جدول قائم | تدقيق العبارات: كل `UPDATE/INSERT` داخل `0009` يستهدف طاولاتها هي فقط (سطور 330، 335، 396، 402 = `crm_drive_review_chain_head/chain_anchor/case`)، ولا `ALTER` إطلاقًا؛ `crm_sessions` تُقرأ بـ `SELECT` داخل `WHEN` فقط | **مؤكد** — لا كتابة على `0001..0008` |
| لا بيانات شخصية خرجت | فحص PII على الملفات الثمانية المراجعة (T-F/‏Fd: هاتف 9+، بريد، `bearer=`، رمز وصول) | لا أسماء ولا هواتف ولا نص محادثة؛ النصوص الوحيدة مُولَّدة صراحةً (`TEST ONLY`/`اسم تجريبي`) وبصمة صفرية `0000…` كمُعامِل شكلي |
| لا شيء في Git من الأسرار | `git ls-files | grep -Ei 'wrangler\.secret|CRM_ACCESS_CODE|SEAL_KEY|\.key$|\.enc$'` | **0** — المفتاح يبقى سرًّا في Worker وحده إن نُفِّذ التصميم لاحقًا |
| عمق الاختبار الحقيقي | `node _worker/tests/*.test.mjs` · canary · مِحْكّا 0009 | ‏**406/406** · **14/14** · **97/97** و**84/84** (على قواعد `:memory:`/`/tmp` فقط) |

**حدود هذا الإثبات (بصدق):** الإقرار بقيم `backup_untouched` / `market_untouched` منقول من آخر تشغيل CI
موثَّق (`41330588815` وما بعده) لأن هذا الفرع لا يملك صلاحية قراءة قاعدة حيّة من الصندوق؛ ولم يُصدر
`gh workflow run crm-phase4-review.yml` إقرارًا جديدًا هذه الجولة (403 ‏«Resource not accessible by
integration»). أي إقرار حيّ إضافي = فعل **كتابة/قراءة** يحتاج تصريح طارق، وهو خارج هذه الجولة.

---

## 8) ما نتج عن الفحص المحلي — فجوات تصميم تحتاج قرارًا (لا تنفيذ بعد)

| # | الفجوة | الدليل | ما نقترحه (يحتاج اعتمادًا قبل أي تعديل) |
|---|---|---|---|
| D1 | **منظر السلامة أعمّى عند المولد**: `crm_review_chain_integrity.broken_links = 1` على دفتر **سليم** ⇒ أي بوابة `broken_links = 0` حمراء دائمًا، والحل الحالي (تجاهل 1) يُعمي الفحص عن حشو صفوف في البداية | T-C: القراءة على 104 أحداث سليمة | تعديل مطلوب **في المسودة**: بند السلفة الواعي بالـ genesis (`prev_event_sha256 IS NULL WHEN e.case_seq = 1`) + `seq_gaps`؛ النموذج المُجرَّب أعاد `{events:104,head:104,anchors:104,gaps:0,broken_links:0,anchor_mismatches:0}` والتقط الحذف/اللفّ/تزوير المولد |
| D2 | **إعادة مفتاح الختم تُبقي الموافقة مربوطة**: كتابة `ciphertext_b64u` مع تثبيت `ciphertext_sha256` وتمرير الموافقة القديمة | T-C: المحاولة نجحت على المسودة المُودَعة | **مشغّل تاسع عشر** `trg_review_seal_no_rekey` (لا يغيّر الختم إلا بصحبة `resealed`؛ الإبطال وتقصير المدّة يبقيان مسموحين) — مُجرَّب في `tc-work/proto_seal_guard.sql` ⇒ تُحدَّث بوابات العدد 18⇒19 في §5/§6 |
| D3 | **لا منظر يرى تعديل المحتوى**: `event_sha256` و`ciphertext_sha256` قيم تُقدّمها الطبقة؛ D1 لا يملك `SHA256()` ⇒ `UPDATE … SET reason='…'` بعد إسقاط الحاجز لا يُغيّر أي بصمة | T-D: المنظر نظيف والتزوير موجود | **خطوة CI إعادة حساب** فوق سلسلة قانونية موثَّقة (`p4rev_event_v1` + 17 حقلًا بالترتيب الموثَّق في §6/T-D)؛ قارئ-only، لا عمود جديد، ~ثانية على 128 حدثًا؛ تُضاف للبوابة مع اختبار «تزوير مُعاد التوقيع ⇒ أحمر» |
| D4 | **النسخة الاحتياطية لا تستطيع استعادة دفتر مُحرَّس**: مُجمِّع Phase-2 يفشل على تصدير ما بعد `0009` (`errcode 1811`)، والحزمة التي ينجح في بنائها تُعرِّف الطاولات/الفهارس فقط ⇒ **تسقط المشغّلات الـ18 والمناظر الأربعة** (وبذلك تُسقط كل حواجز الدفتر) | T-B: بناء الحزمة يفشل؛ والحزمة الناجحة `{trigger:0,view:0}` | لا تعديل الآن (خارج نطاق `0009`). **مطلوب كقرار مستقل:** مسار استعادة على مرحلتين (جداول/فهارس/بيانات ثم `schema.sql` للحواجز) مثبت في T-B/T-B2، أو إضافة مخرج «DDL كامل بالمشغّلات» إلى `crm-phase2-backup.yml`. حتى يُقرَّر، يجب أن يقول أي تقرير استعادة صراحةً إن **الحواجز ليست في الحزمة** |
| D5 | **ثمن الحواجز على الكتابة**: كل إدراج حدث يفحص `crm_sessions` + بحث إلزام reveal مفهرس | T-C: 1.48–2.04 ث/إلحاق **عبر CLI المحلي** (لا عبر Worker) | لا تغيير في المخطط؛ على طبقة الخدمة أن تقيس زمن `/decide` الحقيقي قبل إطلاق الشاشة، وتُخطئ مبكرًا بـ `session_not_live` بدل رسالة D1 الخام (R5) |
| D6 | **لا بوابة عدد للمخطوط الكلي**: فحوص على كامل القاعدة (33 طاولة/89 فهرس) لا ترى غياب تبعية كسولة (D1 يحلّ أجسام المشغّلات وFK عند الكتابة) | T-A: مشغّل يشير إلى جدول غائب يُقبل عند الإنشاء | البوابات تظل scoped بنطاق `crm_drive_review%`/`trg_review%` كما صُمّم، مع فحص «الجدول المعتمد موجود» **قبل** التطبيق (R4) |

**خلاصة القرار:** المسودة قابلة للترويج بعد D1 وD2 (تعديلان صغيران، كلاهما مُجرَّب محليًا)، وD3 خطوة CI
لازمة حتى لا يكون «سجل لا يُمحى» عبارة عن وعد بلا دليل. D4 قرار مستقل عن `0009` لكنه يخصّ سلامة النسخ
الاحتياطية لكل شيء بنيناه.

---

## 9) إغلاق الملاحظات الأربع — تقرير الاختبار لهذه الجولة (فحصٌ وتعديلٌ في الفرع فقط؛ لا تطبيق، لا نشر)

### 9.1 ما أُغلق، وبأي دليل قابل لإعادة التشغيل

| الملاحظة | الإغلاق في هذا الفرع | الدليل |
|---|---|---|
| **D1** منظر السلامة أعمّى عند المولد | بند واعٍ بالـ genesis + عمود `seq_gaps` في `crm_review_chain_integrity` و`crm_review_ci_summary` | `ABUSE 113/113` (سطر «an intact ledger reads intact…») و`D1_REHEARSAL 116/116` §3c |
| **D2** إعادة مفتاح الختم تُبقي الموافقة مربوطة بملفات أخرى | `trg_review_seal_no_rekey` (المشغّل التاسع عشر): يرفض تغيير `ciphertext_b64u` أو `iv_b64u` أو `tag_b64u` أو `key_version` على ختمٍ حيّ، ويسمح بالإبطال دائمًا وبالتدوير بعد الإبطال فقط | ٥ رفضات على D1 الحقيقي (§3c) + ٤ في المِحَك، مع «التدوير بعد الإبطال مسموح» كإيجابية مضادة |
| **D3** لا شيء يعيد حساب البصمة | `scripts/crm/review-event-chain.mjs` (الصيغة القانونية `p4rev_event_v1` فوق **21** حقلًا = كل عمود ما عدا `id` و`reason` و`event_sha256`) + `scripts/crm/verify-review-event-chain.mjs` (قارئ-only: يرفض `--remote`، `SELECT` فقط، لا يطبع إلا بصماتٍ وأعدادًا) | §5c على D1: سلسلة قانونية ⇒ نظيفة؛ تعديل `reason` وحده ⇒ `digest_mismatch` + `reason_mismatch`؛ تزوير **مُعاد التوقيع بالكامل** ⇒ `anchor_mismatch` + `broken_link`؛ والقراءة الحيّة `--local` تُعطي النتيجة نفسها بلا ملف وسيط |
| **D4** النسخة الاحتياطية تُسقط الحواجز | `scripts/crm/build-d1-guarded-backup.mjs`: مقسِّم عبارات واعٍ بالاقتباسات والأقواس وأجسام `BEGIN…END`، يُخرج `restore.sql` (جداول+صفوف+فهارس، ثم مناظر+مشغّلات — في ملف واحد تُطبِّقه `wrangler d1 execute --file` كمعاملة واحدة) مع `verify.sql` و`inventory.json` و`manifest.json` | `BACKUP_REHEARSAL 33/33`: تساوي أعداد الأشياء (5/8/19/4) وأسماء الطاولات و**بصمة محتوى كل طاولة**، ثم رفض الكتابة على النسخة المُستعادَة، **والمجموعة الضابطة**: حزمة بلا الحواجز تُطبَّق بلا خطأ وتمحو الدفتر (0 مشغّل و3 أحداث حُذفت) |

**لم يُعدَّل `crm-phase2-backup.yml`** لأن النسخة الاحتياطية خارج ما صرّحت به هذه الجولة؛ خطوة الربط المقترحة في 9.5.

### 9.2 الاختبارات ونتائجها (كلها على قواعد إسقاط محلية داخل الصندوق)

| التشغيل | الفحوص | النتيجة |
|---|---|---|
| `node --test _worker/tests-draft/crm-review-sql-0009.abuse.mjs` | 113 | **113/113 ‏`ALL_BARRIERS_HELD`** — ثلاث تشغيلات متتالية بلا تفاوت |
| `python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | 116 | **116/116** · `engine=Cloudflare D1 (wrangler --local)` · `remote_databases_touched=none` |
| `python3 _worker/tests-draft/crm-0009-backup-restore.rehearsal.py` | 33 | **33/33** |
| `node --test _worker/tests/*.test.mjs` (ال suite القائم) | 406 | **406 pass / 0 fail** |
| محاكاة خطوة الحارس المأخوذة نصًّا من `crm-cloudflare-test-deploy.yml` المُعدَّل | 8 | **8/8** |

إصلاح مصداقية أُجري أثناء هذه الجولة: فحص «تبديل النصّ المشفَّر وحده» كان يبني القيمة بـ `'A' || substr(ct,2)` على مُولَّد عشوائي، فإذا بدأ الـ base64url بحرف `A` (≈ مرة من ٦٤) كتبت العبارة **نفس** البايتات فمرّ الفحص بلا معنى (الحاجز يمنع تغيّرًا لا كتابة-مماثلة). الصيغة اليوم تقلب الحرف الأول إلى `B` أو `C` دائمًا. يُذكر هذا لأن «فحصًا أخضر بلا سبب» هو بالضبط ما نحاول منعه في سجلّ المراجعة.

### 9.3 لماذا لا يمكن الالتفاف على بوابات الاعتماد

1. **بلا `on.push` إطلاقًا**: حُذف من `crm-cloudflare-test-deploy.yml`. لا دفعة — ولا على `master` — تستطيع الوصول إلى النشر؛ النشر صار `workflow_dispatch` فقط.
2. **`if:` على مستوى الوظيفة** ⇒ `inputs.authorize_deploy == 'DEPLOY-TEST-DB-and-WORKER'`: التشغيل غير المفوَّن لا يحصل على runner ولا على secrets أصلًا (لا مجرد فشل لاحق).
3. **خطوة حارس** تعيد المقارنة نصّيًا: `[ "${AUTHORIZE_DEPLOY:-}" != 'DEPLOY-TEST-DB-and-WORKER' ]`، والقيمة تصل عبر `env:` لا بلصق في النص. المقارنة النصية ترفض مسافةً لاحقة، وحالةً مختلفة، وبادئة، ورمزًا يتبعه سطر جديد — وهي حالات يُخطئ فيها `grep -Eqx`. القياس: **8/8**.
4. **`environment: crm-test-deploy`** على الوظيفة: هذا هو الضابط الوحيد الذي يمنع «إعادة تشغيل تنفيذ قديم» من أن تُحسب اعتمادًا جديدًا، لأن GitHub يعيد استعمال **إدخالات التشغيل المخزَّنة** عند أي re-run فلا يسأل عن شيء آخر. **بشرط صريح**: على طارق أن يُنشئ البيئة ويضيف `Required reviewers`؛ القاعدة لا تُنشأ تلقائيًا، ونحن لا نملك صلاحية إنشاء إعدادات المستودع — فبدون ذلك يبقى البند 4 نموذجًا بلا أسنان.
5. **لا تسريب تطبيق**: `0009` بقي في `_worker/migrations-draft/`، ولا سير عمل يطبّق هذا المجلد؛ النشر يطبّق `_worker/migrations` فقط.
6. **بوابة CI الجديدة لا تصلح قناةً التفافية**: `crm-review-0009-verify.yml` بلا `secrets:` وبلا `--remote` وبلا رفع artifacts، وخطوةٌ فيه تفحص أن الرفض لـ `--remote` سلوكٌ في الكود لا نيةٌ في ملف.

### 9.4 العدد الفعلي للأشياء بعد التعديل (مقاسٌ، لا منقولٌ عن التصميم)

- ملفات الهجرات في المستودع: **8** مطبَّقة + مسودة واحدة = **9**. قاعدة الاختبار الحيّة: `migs=8` (لم تُمسّ هذه الجولة؛ لا أمر `--remote`).
- `0009_crm_drive_review_workflow.sql`: **551** سطرًا، طاولات **5**، فهارس **8**، مشغّلات **19**، مناظر **4**، `CHECK` **73**، `RAISE` **16**، `ALTER` **0**.
- السلسلة كاملةً بعدّ الملفات (8 + المسودة): طاولات **41**، فهارس **54**، مشغّلات **19**، مناظر **4**.
- بوابات العدد تفحص النطاق `crm_drive_review% | crm_review% | trg_review% | idx_crm_review%` فقط — لا أعداد القاعدة الكلية (الحيّة: 33 طاولة/89 فهرسًا)، لأن بوابةً على الكل لا ترى غياب تبعية كسولة.
- فحوص خاصة بالمراجعة في هذه الجولة: **113 + 116 + 33 = 262**، زائد **406** فحصًا قائمًا للـ Worker والموقع.

### 9.5 ملفات هذه الجولة، وما نقترح ربطه (ولن نُنفِّذه بلا اعتماد)

| ملف | الحالة |
|---|---|
| `_worker/migrations-draft/0009_crm_drive_review_workflow.sql` | تعديل 45 سطرًا: بنود الـ genesis و`seq_gaps` و`trg_review_seal_no_rekey` (مجموع هذه الجولة عبر الملفات الأربعة المُعدَّلة: +481/−36) |
| `_worker/tests-draft/crm-review-sql-0009.abuse.mjs` | تعديل: بصمات قانونية، §6b الحواجز، إصلاح الفحص المتذبذب، جرد الأشياء 19/4 |
| `_worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | تعديل: 19 مشغّلًا، §3c حاجر إعادة المفتاح، §5c/§5d round-trip عبر مُتحقِّق CI |
| `.github/workflows/crm-cloudflare-test-deploy.yml` | تعديل: بوابة الاعتماد (بنود 9.3/1–4) |
| `.github/workflows/crm-review-0009-verify.yml` | جديد: البوابة المحلية (151 سطرًا) |
| `scripts/crm/review-event-chain.mjs` | جديد (180): الصيغة القانونية + الفحوص الخالصة، يستوردها المِحَك والمتحقق معًا فلا يتباعدان |
| `scripts/crm/verify-review-event-chain.mjs` | جديد (203): متحقق CI قارئ-only (`--local/--from-json/--sqlite`، يرفض `--remote`) |
| `scripts/crm/build-d1-guarded-backup.mjs` | جديد (236): حزمة نسخة احتياطية تُبقي الحواجز |
| `_worker/tests-draft/crm-0009-backup-restore.rehearsal.py` | جديد (337): محاكاة البناء/الاستعادة/الضابط |
| `CRM_PHASE4_REVIEW_SQL_APPROVAL.md` | هذا القسم |

الخطوة المقترحة لربطها في `crm-phase2-backup.yml` (وظيفة التحقّق)، تُفشل البناء إن غاب حاجز واحد:

```yaml
- name: Guard inventory of the bundle (fail closed if triggers or views are missing)
  run: |
    node scripts/crm/build-d1-guarded-backup.mjs --dump "$TMP/live-export.sql" \
         --out "$TMP/guarded" --title phase2
    jq -e '.guards_present and .counts.trigger > 0 and .counts.view > 0' \
       "$TMP/guarded/manifest.json"
```

### 9.6 ما لم يُمسّ — برهان هذه الجولة

- **لا `--remote`**: لا أمر `d1 execute|migrations|export|backup|restore` وجّهته إلى قاعدة حقيقية؛ كل ما شُغِّل استهدف قواعد باسم `p9bk-a/b/c` و`crm-review-sql-rehearsal` داخل `/home/user/h/*` بـ `--local` و`database_id = 00000000-…` صوري.
- **`nasr-crm-test-db` و`nasr-market-db` والنسخة الاحتياطية**: لم تُقرأ ولم تُكتب هذه الجولة. القيم `backup_untouched=yes(…20261101:3256320:0)` و`market_untouched=yes(nasr-market-db:905216:0)` منقولة من آخر إقرار CI موثَّق — وهذا حدٌّ صادق لا ادّعاء: لا صلاحية قراءة حيّة من هذا الصندوق.
- **لا نشر، لا دمج، لا deploy**: PR #132 ما زال مفتوحًا؛ لم نُشغِّل أي workflow (`gh workflow run` يُرجع 403 لهذا الدور)؛ لم تبدأ المرحلة 5.
- **Drive**: لا استدعاء هذه الجولة؛ لا تعديل ملفات ولا أذونات. ملاحظة صدق: مجلّد `phase4_review/` المحلي (السجلّ المُشفَّر لـ191 حالة) **فُقد مع إعادة ضبط الصندوق** — لا بيانات عميل ضاعت لأن مصدر الحقيقة قاعدة الاختبار وDrive، لكن إعادة توليد السجل مطلوبة قبل أي مراجعة بشرية.
- **النظافة**: مجلدات الإسقاط حُذفت بعد التشغيل (ما استُخدم بـ `KEEP=1` أُزيل قبل الإنهاء)، ولا مخرَج في Git يحمل نص محادثة أو اسمًا أو هاتفًا.

---

### ما نطلب اعتماده صراحةً (ولن يُنفَّذ شيء منه قبل كلمة «اعتماد»)

0. **ما صار جاهزًا في الفرع** (هذه الجولة، بلا تطبيق ولا نشر): تعديلا المسودة D1 وD2، ومتحقق البصمة D3
مع بوابته CI، ومُجمِّع الحزمة المُحرَّس مع محاكاته D4، وبوابة النشر في §4 مطبَّقة على الملف.
1. نقل `0009_crm_drive_review_workflow.sql` من `migrations-draft` إلى `_worker/migrations/` **ورفع**
`crm-phase4-analysis.yml:660` من `'8'` إلى `'9'` مع `latest_mig = 0009_crm_drive_review_workflow` — في
**commit واحد** (قرار طارق، ثم يُطبَّق على `nasr-crm-test-db` بحذافيره لا قبلها).
2. تطبيق الحارس المزدوج بصيغته المُصحَّحة في §4 (قيمة عبر `env:`، مقارنة نصّية صارمة، قراءة صادقة للعدّاد،
   بلا `--quiet`) على `crm-cloudflare-test-deploy.yml`، وحارس `authorize_apply` على `crm-phase4-analysis.yml`
   (وعلى سيرَي التحليل الآخرين اللذين يطبّقان المجلد).
3. تشغيل محاكاة حيّة على قاعدة D1 مؤقتة في CI (البند 6/1) + خطوة إعادة حساب البصمة (D3) قبل أي تطبيق على
   `nasr-crm-test-db`.
4. بعدها فقط: طبقة الخدمة `POST /api/review/{list,reveal,decide}` ثم الشاشة — بنفس القيود (بلا auto-link،
   بلا دمج بالاسم، لا `contact_write_count > 0`).

**متوقفون هنا.** `nasr-market-db` والنسخة الاحتياطية وDrive وأي استيراد/ربط/دمج لعميل: **لم تُمسّ،**
وستبقى كذلك حتى تعليمة صريحة.
