# الاعتماد النهائي — هجرة `0009` لتصميم المراجعة البشرية (تقرير تصميم فقط)

**التاريخ:** 2026-11-01 · **الفرع:** `arena/1c171b6c-…` عند `f71d7d6` · **المطلوب:** تقرير مراجعة واعتماد أخير **دون** تطبيق.

> **حالة هذه الجولة:** تنقيح مسودة SQL + تشغيل مِحْكَّي الاختبار المحليين + هذا التقرير.
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
-      - _worker/crm-push.js
-      - _worker/crm-chat-intel.js
-      - _worker/crm-sync-and-match.js
-      - _worker/wrangler.crm.toml
-      - _worker/migrations/0002_crm_internal_auth.sql
-      - _worker/migrations/0003_crm_push_notifications.sql
-      - _worker/migrations/0004_crm_tracks_core.sql
-      - _worker/migrations/0005_sync_audit_and_intelligence.sql
-      - _worker/migrations/0006_decouple_opportunities_and_contact_levels.sql
-      - _worker/crm-ui/**
-      - _worker/tests/live-e2e-runner.mjs
-      - _worker/tests/live-browser-e2e.mjs
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
+        # …وحارس ثانٍ داخل الخطوة، لأن إعادة تشغيل قديمة قد تتجاوز `if:` الوظيفة
         run: |
+          if [ "${{ github.event.inputs.authorize_deploy }}" != "DEPLOY-TEST-DB-and-WORKER" ]; then
+            echo "::error::not authorized: migrations apply + Worker deploy need an explicit token"
+            exit 1
+          fi
```

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
+          APPLY="${{ github.event.inputs.authorize_apply }}"
+          if [ "$APPLY" != "APPLY-TO-TEST-DB" ]; then
+            echo "dry-run: skipping 'd1 migrations apply' (draft 0009 stays out of _worker/migrations)"
+            live_mig="migs=8,latest=0008_crm_phase4_analysis,phase4_tables=8,skipped=authorization"
+          else
+            npx --yes wrangler@4 d1 migrations apply "$TEST_DB_NAME" --remote --config "$WRANGLER_CFG" > "$TMP/live_mig.log" 2>&1
+          fi
```

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

**ناقص — لا يُروَّج قبل هذه الفحوص (كلها على قاعدة مؤقتة ما لم يُذكر تصريح صريح):**

1. **`d1-live-rehearsal` job في CI**: `wrangler d1 create` لقاعدة اسمها `crm-0009-rehearsal-<run_id>`، تطبيق
   `0001..0009` الحقيقي (لا سلاسل وهمية)، تشغيل نفس لائحة الفحوص، ثم `d1 delete` في `if: always()`.
   يزيل آخر فجوة بين `--local` و`--remote`.
2. **بوابة البنية بعد التطبيق**: `type/count = {table:5, trigger:18, view:4, index:8}` و
   `missing_messages = 0` و`d1_migrations.latest = 0009_crm_drive_review_workflow` و`migs = 9`.
3. **تدقيق الصلة (استعلام §2)** يجب أن يعود 0، بالإضافة إلى اختبار مضاد: إدخال قرار غير مربوط في
   **قاعدة اختبار** ثم التأكد أن البوابة تُحمِّر التشغيل (لا بوابة ميتة).
4. **نضارة الصفر**: `crm_review_chain_integrity` بـ `broken_links = 0 ∧ anchor_mismatches = 0 ∧
   events = head_event_count = anchors` بعد 64 قضية و~128 حدثًا (اختبار حجم، لا 3 قضايا فقط).
5. **سقف الخصوصية**: `pii_scan` على الدفتر والمنظرين — لا `GLOB '*[0-9]×9*'`، لا بريد، لا نص عربي
   في الأحداث، لا `drive_file_id` حقيقي، ولا معرّف جلسة؛ وبوابة على `crm_review_ci_summary` بأن
   أعمدته ثابتة (أي إضافة عمود نصّي يجب أن يُفشِل CI).
6. **مسار الكشف على مستوى HTTP** (بعد الموافقة على طبقة الخدمة): CSRF مطلوب؛ بلا جلسة ⇒ رفض؛
   جلسة منتهية/مسحوبة ⇒ `session_not_live` و**لا** بايت مشفَّر يُعاد؛ `no-store` حاضراً؛ رسالة الخطأ
   لا تحمل plaintext ولا padding؛ `seal_expired|revoked|missing` تُسجَّل كأحداث `denied`.
7. **اختبار التمارين الأربعة للحواجز الجديدة**: تدوير الختم ⇒ قرار مرفوض؛ مسح ختم `expired` ⇒ مسموح؛
   `retention_days = 90` ⇒ مسموح و`91` ⇒ مرفوض؛ حذف ختم حيّ ⇒ مرفوض حتى مع `PRAGMA foreign_keys` مطفأ.
8. **اختبار الاستعادة**: استنساخ قاعدة من نسخة احتياطية → تطبيق `0009` → التأكد أن `crm_sessions` الحيّة
   من `0002` تُقبل (لا قفل بعد الاستعادة) وأن المشغّلات الـ18 كلها موجودة.
9. **اختبار التراجع**: سُلّم §5 (R9) ثم إعادة التطبيق ⇒ نفس عدّاد الكائنات و0 صف مفقود في الدفتر.
10. **فحص خلوّ البيئة**: `git ls-files | grep -E 'seal_key|CRM_ACCESS_CODE'` فارغ، ولا `id` مجلد Drive في
    الملفات المتتبَّعة، ولا ملف `.enc`/`.key` من `/home/user/phase4_review` داخل المستودع.

**مغطّى ولا يُعاد كتابته:** parses/apply/idempotency، append-only، منع erase/rewind، كشف التزوير بعد إسقاط
الحواجز، رفض `link_applied/merge_authorized/contact_write_count = 1`، قائمة `reviewer` السوداء،
`reason` (طول/أسطر/أرقام/بريد/عربي)، 12 → 1000 مع `supersedes_id`.

---

## 7) إثبات أن قاعدة الاختبار والإنتاج والنسخة الاحتياطية لم تتغيّر

| الدليل | كيف يُتحقَّق | النتيجة لهذه الجولة |
|---|---|---|
| لا `--remote` إطلاقًا | `grep -n -- '--remote' _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py` | **0** — السكربت `--local` فقط على قاعدة `p9rev-*` مؤقتة داخل `/tmp` تُمحى بعد التشغيل |
| لا SQL موجَّه إلى `nasr-crm-test-db` | كل `d1 execute/ migrations` في الجولة استهدف `--config` محليًا باسم قاعدة مؤقت | لا استعلام واحد ذكر `nasr-crm-test-db` أو UUID ‏`65bfcb14-4b48-423b-916f-00eefdb9ae1e` |
| `nasr-market-db` ممنوعة وآمنة | لم تُذكر في أي أمر هذه الجولة | لم تُمسّ (آخر إقرار CI: `market_untouched=yes(nasr-market-db:905216:0)`) |
| النسخة الاحتياطية | لا أمر `restore`/`export`/`--remote` | `backup_untouched=yes(…20261101:3256320:0)` كما في آخر إقرار CI |
| لا نشر Worker / لا Deploy | `gh run list --branch arena/1c171b6c-… --limit 6` | آخر التشغيلات: **Worker & page tests** و**SonarCloud Scan** فقط؛ لا `crm-cloudflare-test-deploy`، لا `apply` حيّ |
| لا دمج، لا لمس `master` | `git log --oneline -1` · `git diff --stat master…HEAD` | `f71d7d6`؛ `origin/master` ما زال `4c42806`؛ PR #132 مفتوح ولم يُدمج؛ الفرق مستندات + `_worker/migrations-draft` + `_worker/tests-draft` |
| لا تطبيق هجرة | لا ملف في `_worker/migrations/` أضيف؛ `0009` داخل `migrations-draft` | لم يتغيّر عدّاد `d1_migrations` في أي قاعدة (الفحص المحلي أعلاه يُظهر `d1_migrations=2` **للقاعدة المؤقتة وحدها**) |
| لا لمس Drive | لا استدعاء `google_drive__*` هذه الجولة؛ `list`/`get` لم يُستعملا | الملفات الأصلية وأذوناتها لم تتغير (لا كتابة إطلاقًا منذ بداية المرحلة) |
| الهجرة لا تكتب على أي جدول قائم | تدقيق العبارات: كل `UPDATE/INSERT` داخل `0009` يستهدف طاولاتها هي فقط (سطور 330، 335، 396، 402 = `crm_drive_review_chain_head/chain_anchor/case`)، ولا `ALTER` إطلاقًا؛ `crm_sessions` تُقرأ بـ `SELECT` داخل `WHEN` فقط | **مؤكد** — لا كتابة على `0001..0008` |
| لا بيانات شخصية خرجت | فحص PII على الملفات الخمسة المغيَّرة | لا أسماء ولا هواتف ولا نص محادثة؛ النصوص الوحيدة مُولَّدة صراحةً (`TEST ONLY`/`اسم تجريبي`) وبصمة صفرية `0000…` كمُعامِل شكلي |
| لا شيء في Git من الأسرار | `git ls-files | grep -Ei 'wrangler\.secret|CRM_ACCESS_CODE|SEAL_KEY|\.key$|\.enc$'` | **0** — المفتاح يبقى سرًّا في Worker وحده إن نُفِّذ التصميم لاحقًا |
| عمق الاختبار الحقيقي | `node _worker/tests/*.test.mjs` · canary · مِحْكّا 0009 | ‏**406/406** · **14/14** · **97/97** و**84/84** (على قواعد `:memory:`/`/tmp` فقط) |

**حدود هذا الإثبات (بصدق):** الإقرار بقيم `backup_untouched` / `market_untouched` منقول من آخر تشغيل CI
موثَّق (`41330588815` وما بعده) لأن هذا الفرع لا يملك صلاحية قراءة قاعدة حيّة من الصندوق؛ ولم يُصدر
`gh workflow run crm-phase4-review.yml` إقرارًا جديدًا هذه الجولة (403 ‏«Resource not accessible by
integration»). أي إقرار حيّ إضافي = فعل **كتابة/قراءة** يحتاج تصريح طارق، وهو خارج هذه الجولة.

---

### ما نطلب اعتماده صراحةً (ولن يُنفَّذ شيء منه قبل كلمة «اعتماد»)

1. نقل `0009_crm_drive_review_workflow.sql` إلى `_worker/migrations/` ورفع `migs` من 8 إلى 9 في commit واحد.
2. تطبيق الحارس المزدوج على `crm-cloudflare-test-deploy.yml` (وحارس `authorize_apply` على
   `crm-phase4-analysis.yml`).
3. تشغيل محاكاة حيّة على قاعدة مؤقتة في CI (البند 6/1) قبل أي تطبيق على `nasr-crm-test-db`.
4. بعدها فقط: طبقة الخدمة `POST /api/review/{list,reveal,decide}` ثم الشاشة — بنفس القيود (بلا auto-link،
   بلا دمج بالاسم، لا `contact_write_count > 0`).

**متوقفون هنا.** `nasr-market-db` والنسخة الاحتياطية وDrive وأي استيراد/ربط/دمج لعميل: **لم تُمسّ،**
وستبقى كذلك حتى تعليمة صريحة.
