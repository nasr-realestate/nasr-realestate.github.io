# CRM A5 — دليل التجهيز للتشغيل الفعلي (go-live runbook)

**Status: RUNBOOK ONLY — لم يُنفَّذ أيّ مما في §2.** لم يُدمَج PR #133، ولم يُنشَر أي Worker، ولم تُمسَّ
إعدادات GitHub ولا Cloudflare ولا أي secret، ولم تُقرأ أي محتويات من Drive. كل ما في هذا الملف إمّا
مقيس بأمر حقيقي (مع مصدره) أو خطوة منتظِرة من الإنسان.

سياق الكتابة: 2026-11-03 (Africa/Cairo) على فرع `arena/0c1573ca-nasr-realestate-github-io`، HEAD
`95ef843` + التغييرات غير المنشورة لهذا المهمة (فحوص A5 الحيّة + تصحيح GET في العامل + هذا الدليل).

---

## 1) أين نقف الآن — بالأرقام، لا بالوصف

| الحقيقة | الدليل المقيس |
|---|---|
| طبقة A5 (طلبات العميل، خط التفاعل الموحَّد، المتابعات، مراجعة Drive عبر API) مكتوبة ومختبَرة | `15cf209` + `9a0955d`؛ 42/42 في `crm-a5-drive-review` + `crm-a5-requests-and-followups` + `crm-a5-ui` + `crm-worker`؛ 765/765 في `npm test` |
| جهة القاعدة من A5 **حيّة** على `nasr-crm-test-db` | 0012/0013/0014 مطبَّقة عبر CI؛ `migs=14`، `latest=0014_fix_drive_review_session_expiry_units.sql` في سطر حواجز p3 |
| جهة **الكود المنشور** (Worker) من A5 **غير منشورة** | آخر تشغيل نشر أخضر في سجل Actions عند `c2e37d1` (2026-10-30)؛ رقم التشغيل لا يُنسخ هنا حتى لا يُقرأ كرقم هاتف، أي قبل A5؛ و`95ef843 ∉ master` (`git merge-base --is-ancestor` = false) |
| الحواجز المرجعية لم تتحرك | `c=60, ph=64, o=83, cl=19, cv=76, unm=21, m=2984`؛ `nasr-market-db` بـ `mdb0`؛ النسخة الاحتياطية `nasr-crm-test-db-backup-20261101` بلا كتابة |
| CI على HEAD | `gh pr checks 133` = 10 ناجح / 1 skipping / 0 فاشل |

**ما الذي كان ينقص قبل هذه المهمة، ولماذا:** فحوص النشر الحيّة القديمة
(`live-post-deploy-verify.mjs`, `live-e2e-runner.mjs`) كُتبت قبل A5 ولا تلمس `/api/requests` ولا
`/api/interactions` ولا `/api/queues` ولا `/api/followups*` ولا `/api/reviews/drive*` (عدّها grep: 0 / 0 /
مساران لـ `/api/followups` فقط). كانت ستظل خضراء ولو عطبت طبقة A5 كاملة بعد الترحيل. الآن `_worker/tests/
live-a5-verify.mjs` يسدّ هذه الفجوة، ويُقاد في CI بعد فحص العشر خطوات مباشرة.

## 2) خطوات الإنسان بالترتيب (لا يملكها الوكيل، ولا يُفترض أن يخترقها)

1. **دمج PR #133** إلى `master` (`gh pr merge 133 --squash`) — بوابة النشر ترفض أي `ref` غير `master`
   صراحةً (`if [ "${REF}" != 'master' ]; then ::error::not authorised: deploys run from master only`).
2. **إنشاء بيئة GitHub باسم `crm-test-deploy`** وربطها بـ `nasr-crm-api-test`، مع:
   `reviewers ≥ 1`، `wait_timer ≥ 600s`، `can_admins_bypass = false`. اليوم البيئة غير موجودة أصلًا
   (`GET /repos/…/environments/crm-test-deploy` → 404)، والوكيل لا يُنشئ إعدادات.
3. **تشغيل `crm-cloudflare-test-deploy.yml` بـ `workflow_dispatch`** على `master` بـ
   `DEPLOY-TEST-DB-and-WORKER` مفعَّلًا (الوكيل لا يستطيع: `POST …/dispatches` → 403).
4. **الموافقة على `Deployment pending`** عند طلبها البيئة.
5. **قراءة اسم الفحص** في نهاية الوظيفة: يجب أن ينتهي بـ `a5=all-10-pass`. أي `fail:A5-L…` يعني أن
   النشر تمّ لكن التشغيل الفعلي لـ A5 معطوب — لا يعتبر الأخضر كافيًا.
   الخطوة موصولة في **مسارَي** الوظيفة كليهما: مسار «الرمز في لوحة Cloudflare» يدخل بتذكرة CI لمرة
   واحدة، ومسار «مرآة الرمز في GitHub» يقرأ ملف الرمز 0600 — فلا يوجد طريق نشر يمرّ بلا تحقق من A5.

> **ما لن يفعله هذا الدليل:** لا يُشغَّل A6، ولا يقرأ محتوى ملفات Drive (فقط قراءة السجل والقرار)، ولا
> يكتب في `nasr-market-db`، ولا يمسّ قاعدة الإنتاج. الترحيلات تُطبَّق عبر CI وحده.

## 3) ماذا يفحص التشغيل عند كل نشر (`A5-L1 … A5-L10`)

| # | الفحص | ما يثبته |
|---|---|---|
| L1 | البنية المنشورة تعرف مسارات A5 | `GET /api/requests` بلا جلسة → 401 `authentication_required`. أي 404 يُسمَّى `a5-not-in-deployed-build` ويسرّع الفشل بدل فحص غامض |
| L2 | الدخول ينتج جلسة + CSRF | رمز ≥ 32 حرفًا، كوكي `__Host-crm_session`، ووضع `access_code` أو `ci_ticket` |
| L3 | الحواجز الثلاثة | بلا جلسة 401، بأصل خاطئ 403 `origin_not_allowed`/`cross_site_forbidden`، بلا CSRF 403 `csrf_invalid` |
| L4 | عميل صناعي برقمين + البحث برقم الهاتف | يجد الرقمين ولا يعطي إيجابية كاذبة لرقم غير مسجَّل |
| L5 | طلب شراء/إيجار | إنشاء، قراءة تفصيلية، `total=2`، تكرار 409 `duplicate_request`، إغلاق بلا سبب مرفوض |
| L6 | الخط الزمني + المتابعات | تفاعل، replay 409 `duplicate_interaction`، متابعة مستحقة → متأخرة → `done` تخرج من القائمتين، وطفلية بلا طلب 400 |
| L7 | قوائم العمل | غير المرتبطة، المستحقات، والميزانية الزمنية تُقرأ كلها |
| L8 | مراجعة Drive | القائمة تُقرأ، حالة وهمية 404، سبب قصير 400، والكتابة في دفتر المراجعة **لا تجري** إلا بتفويض صريح |
| L9 | الجلسة | الحيّة تعمل؛ وبعد إنهاء الصلاحية تُرفض (401 من بوابة العامل أو 403 `session_not_live` من حارس الدفتر) وبلا كتابة؛ ثم logout → 401 |
| L10 | ملاحظة ختامية | يلخّص ما كُتب فعليًا (ids فقط، لا أرقام هواتف ولا نصوص عملاء) |

كل `skip` مسمّى في `notes` — لا يوجد تخطٍّ صامت.

## 4) التشغيل اليدوي

```bash
# أ) مقابل نسخة منشورة (قاعدة الاختبار فقط):
CRM_TEST_BASE_URL=https://nasr-crm-api-test.<account>.workers.dev \
CRM_A5_ORIGIN=https://nasr-crm-api-test.<account>.workers.dev \
CRM_LIVE_ACCESS_CODE_FILE=/tmp/crm_access_code \
CRM_A5_RUN_TAG=manual-$(date +%y%m%d) \
  node _worker/tests/live-a5-verify.mjs --json

# ب) بلا رمز وصول — بتذكرة CI لمرة واحدة (هو مسار الـ workflow نفسه):
#    اطبع التذكرة أولًا في crm_idempotency_receipts بنفس صيغة CI
#    ('ci-e2e-ticket:' || sha256(nonce)، resource_type='contact'، resource_id='authorized_pending')
#    ثم: CRM_A5_TICKET=<nonce> … (تُستهلك التذكرة عند أول استعمال، وعمرها 90 ثانية)
```

| المتغير | اللازم | ملاحظة |
|---|---|---|
| `CRM_TEST_BASE_URL` | نعم | أساس http(s) بلا شرطة مائلة أخيرة؛ `CRMClient` يرفض عنوانًا مطلقًا في `apiBase` لهذا يُمرَّر الأصل منفصلًا |
| `CRM_A5_ORIGIN` | للنشر | يوضع في ترويسة `Origin` مع `Sec-Fetch-Site: same-origin`؛ بدونه يرفض العامل كل شيء قبل التوجيه |
| `CRM_A5_ACCESS_CODE` / `CRM_LIVE_ACCESS_CODE_FILE` / `CRM_A5_TICKET` | واحد منها | ملف 0600 مُفضَّل على تمرير الرمز في البيئة |
| `CRM_A5_STATE_FILE` | لبروفة الإنهاء | يُكتب فيه رمز الجلسة بصلاحية 0600 ليقرأه `CRM_A5_EXPIRE_CMD` |
| `CRM_A5_EXPIRE_CMD` | اختياري | أمر shell يُنهي صلاحية **تلك الجلسة وحدها** في القاعدة؛ إن غاب تُفحص «logout ثم 401» بدلًا |
| `CRM_A5_WRITE_DECISION` | اختياري | `none` (الافتراضي) / `noted` / `state-changing` — راجع §6 قبل رفعها. في CI لا يُعرض على نموذج التشغيل إلا `none` و`noted` (حقل `a5_write_decision`)، لأن `state-changing` يُغلق حالة مراجعة بلا رجعة |
| `CRM_A5_RUN_TAG` | اختياري | يوسم كل سطر صناعي: `TEST ONLY A5 <tag>` |

المخرَج سطر JSON واحد: `{ok, build, checks[], created{}, notes[], counts{}}`، وقيمة الخروج 0 عند نجاح
الكل و1 عند أي فشل — قابل للتحليل بـ `jq` كما يفعل CI.

## 5) بروفة قبل النشر (على نسخة الاختبار، لا على الإنتاج)

```bash
# 1) الفحوص العشرة على نسخة الاختبار، مع قرار «ملاحَظ» فقط (لا يُغلق أي حالة):
CRM_TEST_BASE_URL=… CRM_A5_ORIGIN=… CRM_LIVE_ACCESS_CODE_FILE=/tmp/crm_access_code \
CRM_A5_STATE_FILE=/tmp/a5_state.token CRM_A5_WRITE_DECISION=noted \
  node _worker/tests/live-a5-verify.mjs --json

# 2) إثبات 0014 على D1 الحقيقي: أنهِ صلاحية الجلسة التي صنعها التشغيل هو، لا جلسة أحد آخر.
#    يُحسب الهاش كما يحسبه العامل تمامًا: hmacSha256(CRM_SESSION_SECRET, 'session:' + token).
cat > /tmp/a5-expire.sh <<'EXP'
set -eu
hash=$(node -e 'const{createHmac}=require("node:crypto"),{readFileSync}=require("node:fs");
process.stdout.write(createHmac("sha256",readFileSync("/tmp/crm_session_secret","utf8").trim())
  .update("session:"+readFileSync("/tmp/a5_state.token","utf8").trim()).digest("hex"))')
[ -n "$hash" ] || exit 2
npx --yes wrangler@4 d1 execute nasr-crm-test-db --remote --config _worker/wrangler.crm.toml \
  --command "UPDATE crm_sessions SET created_at = CAST(strftime('%s','now') - 7200 AS INTEGER), expires_at = CAST(strftime('%s','now') - 60 AS INTEGER) WHERE token_hash = '$hash' AND revoked_at IS NULL;"
EXP
# ابدأ باستعلام عدّاي يتأكد أنه يصيب صفًّا واحدًا قبل أي UPDATE:
#   SELECT COUNT(*) FROM crm_sessions WHERE token_hash = '<hash>' AND revoked_at IS NULL;
# ثم أعد التشغيل مع:
CRM_A5_EXPIRE_CMD='bash /tmp/a5-expire.sh' CRM_A5_STATE_FILE=/tmp/a5_state.token \
CRM_TEST_BASE_URL=… CRM_A5_ORIGIN=… CRM_LIVE_ACCESS_CODE_FILE=/tmp/crm_access_code \
  node _worker/tests/live-a5-verify.mjs --json
```

> `SELECT` العدّاي قبل أي `UPDATE` ليس تحفّظًا زائدًا: صفوف `crm_sessions` تشمل كل من سجّل دخولًا،
> والشرط `token_hash = '<hash>' AND revoked_at IS NULL` يجب أن يُصيب صفًّا واحدًا — صفر يعني أن الرمز
> المستعمل ليس رمز العامل المنشور، وأكثر من واحد يعني أنك تُنهي جلسات غيرك.
> في CI الخطوتان مبنيتان داخل `run_a5_live()` بنفس المقياس (ثوانٍ، كما وحّده 0014)، وبروفة الإنهاء لا
> تُفعَّل إلا حين تكون الوظيفة هي التي كتبت الرمز المستعمل؛ وإلا صار الرفض دليلًا كاذبًا، فتُترك
> خطوة «logout ثم 401» وحدها.

**برهان أن الفحوص ليست فارغة** (يجري محليًا في `crm-a5-live-contract.test.mjs`):
- LIVE-1: العشرة تمرّ عبر HTTP على `worker.fetch` الحقيقي وقاعدة SQLite بنفس DDL الاختبار، والقرار يصل
  `seq=1` وتحالة المراجعة تغلق بـ `closed_no_action` بفعل حواجز 0011 نفسها.
- LIVE-2: نفس الفحوص على سلسلة أُرجعت فيها حواجز 0014 إلى المللي ثانية **تسقط** عند `A5-L8` بـ
  `decision-not-recorded:403:session_not_live` — دليل أن الفحص يقيس الإصلاح.
- LIVE-3: وضع القراءة فقط يترك دفتر القرارات فارغًا (عدًّا = 0)، وأمام بنية بلا A5 يقول `build="a5-not-in-deployed-build"` ولا يخترع نجاحًا.
- LIVE-4/5: سطر الأوامر يُخرِج JSONآلًا قابلًا للقراءة، وتذكرة CI تمرّر الفحوص نفسها وتُستهلك لمرة واحدة.

## 6) ما تلمسه خطوة التحقق فعليًا في القاعدة (ولا يمكن إخفاؤه)

يكتب كل تشغيل: صفا واحدًا في `crm_contacts` باسم يبدأ `TEST ONLY A5` + صفّين في `crm_contact_phones`،
وصفين في `crm_customer_requests`، وصفًّا في `crm_followups`، وتفاعُلين في `crm_interactions`، وصفوف
`crm_request_status_history` و`crm_operational_audit_log` (وإن رُفع `CRM_A5_WRITE_DECISION` فصفّ قرار في
`crm_drive_file_review_decision`).

ثم يمسح CI ما يسمح به مخطط الجداول: الروابط، والمتابعات بعد إنهازها، والطلبات بعد إغلاقها، وأرقام الهاتف.
أما `crm_interactions` و`crm_request_status_history` و`crm_operational_audit_log`
و`crm_drive_file_review_decision` ف**append-only بحاجز قاعدة** (0011/0012/0013) — لا حذف ولا تعديل، وهذا
معنى كونها سجل تدقيق، لذا تُترك موسومة بـ `TEST ONLY A5` ويُعلَن عددها في سطر `::notice::` في آخر الوظيفة
(`inter=… hist=… audit=… review=…`). عدادات الثبات تستثني `TEST ONLY%` أصلًا، فلا تتأثر `60/83/76/2984`.

**لا ترفع `CRM_A5_WRITE_DECISION` فوق `noted` على قاعدة بها حالات حقيقية**: القرار `state-changing` يُغلق
حالة المراجعة نهائيًا ولا رجعة فيه، ولهذا يُجرى في الاختبار المحلي على قاعدة خاملة لا هنا.

## 7) كيف تعرف أن «التشغيل الفعلي جاهز» — قائمة قبول

- [ ] `master` يحتوي A5 (`git merge-base --is-ancestor <sha-of-A5> origin/master` = true).
- [ ] بيئة `crm-test-deploy` فيها reviewer ≥ 1 و`wait_timer ≥ 600s` و`can_admins_bypass=false`.
- [ ] تشغيل النشر ينتهي باسم فحص يحوي `dep=yes` و`v=60c-64ph-83o[19]-76cv[21]-2984m-…-mdb0` **و**
      `a5=all-10-pass`.
- [ ] سطر notice للبقايا يذكر أرقامًا صغيرة (≤ 6 صفوف) كلها موسومة، ولا صفرًا مضللًا.
- [ ] من متصفح حقيقي على `https://…workers.dev/crm.html`: لوحات A5 تظهر (طلب جديد، خط زمني، قوائم عمل،
      مراجعة Drive). **هذه الخطوة لا يستطيع الوكيل أداءها**: لا منفذ من هذه البيئة إلى `workers.dev`
      (`curl` → `SSL_ERROR_SYSCALL`)، ولا يستطيع `fetch_page` إرسال كوكي/CSRF، ولا يوجد هاتف حقيقي هنا —
      لذا تُذكر صراحةً على أنها من الإنسان، ولا تُنسَّب إلى اختبار أخضر.

## 8) أسباب التوقف المسجَّلة (لا طرق ملتوية)

1. بوابة `ref != master` في `crm-cloudflare-test-deploy.yml` — رفض صريح للتشغيل من فرع.
2. `GET /repos/…/environments/crm-test-deploy` → 404: البيئة غير موجودة، والوكيل لا يُنشئ إعدادات.
3. `POST /repos/…/actions/workflows/398764968/dispatches` → 403 `Resource not accessible by integration`.
4. `95ef843` غير موجود في `master` — أي نشر «مرآة» من master سينشر بنية بلا A5.
5. لا يمكن إجراء اختبار HTTP موثَّق من هذه البيئة (منفذ محجوب + لا سيطرة على الترويسات).

الحل الوحيد المقبول هو 1–5 من الإنسان أعلاه؛ لا تخفيف حاجز، ولا مسار بديل، ولا ادّعاء بأن فحصًا جرى.
