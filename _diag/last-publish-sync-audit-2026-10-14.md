# تدقيق آخر نشر — 2026-10-14 (v9.3)

مرجع: `master` عند `6dbee2b` («Update worker.js to version 9.3») + النشر السابق `91af108a`.

## 1) الملفات التي تغيّرت في آخر نشر

| الكوميت | الملف | الحجم |
|---|---|---|
| `91af108a` «Enhance message rendering and header layout» | `agent.html` | +28 / −6 |
| `6dbee2b` «Update worker.js to version 9.3» | `_worker/worker.js` | +45 / −33 |

- `deploy.yml` (Jekyll) نجح على الكوميتين، و`pages build and deployment` نجح — أي أن التغييرين منشوران فعلًا على الموقع.
- الـWorker على Cloudflare يُنشَر يدويًا؛ آخر تشغيل لـ`agent-worker-readonly-audit.yml` كان **2026-10-09**، أي قبل v9.3. لم يُتحقق بعد أن النسخة الحيّة = النسخة الموجودة في المستودع.

### ملخّص ما جاء في v9.3

**`agent.html`:** مساحة آمنة أعلى الهيدر (`env(safe-area-inset-top)`)، هيدر مضغوط وقت الكيبورد (`.vv-active`)، `renderMsg(..., noScroll)` عند استعادة التاريخ (نزول واحد بدل مؤقّتات لكل رسالة)، تأخير الكتابة محسوب من زمن الرد الفعلي، وإلغاء كسر الكاش على `ai-feed.json`.

**`_worker/worker.js`:** حدود كلمات عربية (`AR_B`) في `OFF_TOPIC_RE` و«بوت» (أرض الجولف/بوتاجاز)، الردود الجاهزة لا تخطف المحادثة وسط التسجيل (`inFlow`)، بوابة `matchInterrupt`، مهلة 2.5 ثانية لتعليق Gemini، كاش Cloudflare على الـfeed، تأخير كتابة 250–600ms، و`env.GEMINI_MODEL` — **مع تغييرين في البيانات** (رابط جوجل + عدد المشاهدات) وردا في القسم 3.

## 2) الاختبارات: قبل/بعد

`node --test "_worker/tests/*.test.mjs"` (221 اختبارًا):

| الحالة | ناجح | فاشل |
|---|---|---|
| ما قبل التعديلين (`81082794`) | 218 | 3 (قديمة) |
| بعد نشر v9.3 كما هو | 209 | **12** |
| بعد التصحيح (هذا الكوميت) | 218 | 3 (نفس القديمة) |

التسعة الفاشلة الجديدة كان سببها تعديلين فقط (عُزلا بالتشغيل المنفرد لكل ملف):

1. **`agent.html` — `performance.now()` غير مُعرَّف في كل بيئة.** كان `const t0 = performance.now()` داخل `try`، فأي بيئة بلا `performance` (بيئة الاختبار، WebView قديم) ترمي `ReferenceError` قبل `fetch` → لا يُرسَل الطلب أصلًا، ويظهر للمستخدم «الرد وصل بشكل غير مكتمل».
   الإصلاح: ساعة آمنة `nowMs()` (سطر 959) تستخدم `performance.now()` عند توفّرها وإلا `Date.now()`.
2. **`_worker/worker.js` — بوابة `matchInterrupt` كانت تشمل الاستفهام فقط.** «ممكن أشوف التقييم» طلب لا سؤال، فكان يمرّ للـflow بدل إعادة إعلان التقييم المحفوظ.
   الإصلاح: `looksLikeAsk` تشمل صيغ الطلب (`عايز/محتاج/ممكن/التقييم…`) مع بقاء سقف الـ80 حرفًا.

> لا يوجد أي job في CI يشغّل هذه الاختبارات (فقط `properties-sync.test.mjs` داخل `deploy-properties-sync.yml`) — لهذا مرّت الإخفاقات الثمانية على الصفحة دون أن يوقفها أحد.

## 3) ⚠️ تنازع البيانات: النسخة vs الموقع الموثّق

الموقع يوثّق قاعدة صريحة في `_includes/schema-global.html` و`llms.txt`:

- **صفحة النشاط «سمسار طلبك»** `maps.app.goo.gl/jQBJvzfxA4vzo6Qe7`: 4.7 من 102 مراجعة ← مصدر `aggregateRating` فقط.
- **ملف المرشد المحلي لطارق** `maps.app.goo.gl/8QWS1BCPBViggDfa7` (تحقق 2026-10-12): Level 7 · 7,741 نقطة · 151 مراجعة كتبها (+28 تقييم) · 430 صورة · **أكثر من 17 مليون** مشاهدة.
- وتحذير صريح: الخلط بين المقياسين = بيانات منظمة مضلّلة.

`GOOGLE_PROFILE` في v9.3 خالف ذلك من جهتين:

| الحقل | v9.2 (قبل) | v9.3 (بعد) | الموقع الموثّق |
|---|---|---|---|
| `url` | ملف طارق الشخصي | **صفحة النشاط** | ملفه الشخصي (الرابط مربوط بجملة «شوف بروفايلي») |
| `formattedViews` / `totalViews` | أكثر من 17 مليون | **16.3 مليون / 16,273,294** | أكثر من 17 مليون (تحقق 2026-10-12) |
| `photosCount` | 468 | 468 | 430 |
| `reviewsCount` / `ratingsCount` | 195 / 39 | 195 / 39 | 151 / 28 |

النتيجة الحالية: البوت يقول «🏆 طارق طنطاوي — Google Local Guide Level 7 … 🎯 7,741 نقطة … 🗺️ شوف بروفايلي:» ثم يرسل **رابط صفحة النشاط** — نفس الخلط الذي يحذّر منه الملف. كما أن 17→16.3 مليون تراجع زمني مستحيل (المشاهدات تزيد لا تنقص) إلا إذا كان الرقم لمقياس آخر.

## 4) قائمة «ما يجب أن يواكب»

### أ) قرار بيانات مطلوب (يمسّ دلالة الأرقام)
`_worker/worker.js:73` `GOOGLE_PROFILE` + `agent.html:933` `GOOGLE_URL` + `agent.html:914` زر «شوف بروفايلي» + `add-your-property.html:314` (نسخة ثانية من `GOOGLE_PROFILE`).

### ب) تحديث ميكانيكي بعد القرار — 17M+ → الرقم المعتمد
`index.html` (‏3 مواضع + عناوين `title`) · `about-us.html` · `agent.html` (نافذة «عن الوكيل») · `contact-us.html` · `og-generator.html:569` · `_layouts/property_page.html:292` · `_layouts/request_page.html:249` · `_includes/schema-global.html:16,205,207` · `llms.txt:20` · `assets/css/style.css:7289` (تعليق).

### ج) دفتر الإصدارات
- `agent-worker-readonly-audit.yml` يبحث عن `v9.3-W` بينما ترويسة الملف تقول `v9.3` → إمّا توحيد الاسم أو تعديل الـworkflow.
- `FORM_VERSION = "v92"` في الملفين: متعمّد (عقد wire بين الصفحة والـworker) — لا يُرفع مع كل إصدار، لكن يستحسن تعليق يوضّح ذلك.
- `_worker/README.md` + `wrangler.agent.toml`: توثيق أن `GEMINI_MODEL` صار فعّالًا فعلاً (كان binding موجودًا وبلا استخدام) وأن الكاش صار على حافة Cloudflare (تأخر ظهور العقارات الجديدة حتى 5 دقائق).

### د) سلامة النشر
- `sw.js`: `CACHE_NAME = 'smsar-v1'` لم يتغيّر مع تغيّر `agent.html`، والـprecache يعمل فقط عند تغيّر ملف الـSW → المستخدمون المثبَّتون للـPWA يحتفظون بالقشرة القديمة. الأفضل رفع `CACHE_NAME` إلى `smsar-v2`.
- إضافة job في CI يشغّل `node --test "_worker/tests/*.test.mjs"` (أو على الأقل `agent-page`/`valuation-*`) كبوابة قبل النشر.
- تشغيل `agent-worker-readonly-audit.yml` يدويًا للتأكد أن النسخة الحيّة على Cloudflare = `_worker/worker.js` بعد v9.3.

## 5) إخفاقات قديمة (خارج نطاق v9.3)

- `agent-page.test.mjs` T1.3/T1.5: الاختبارات تتوقع «وكيل ذكي • متصل الآن» ورسالة ترحيب لا تقول «أنا طارق طنطاوي»، بينما الصفحة الحالية تقول «أنا طارق طنطاوي … 🏆 Google Local Guide 7» والـstatus «متصل الآن». تعارض قديم بين النص والاختبار يحتاج قرارًا (تصحيح النص أم تحديث الاختبار) — لاحظ أن `IDENTITY_RESPONSE` في الـworker يقول «أنا وكيل ذكي بيشتغل لصالح طارق طنطاوي»، فالصفحة والـworker يختلفان في تعريف الهوية.
- `properties-sync.test.mjs` (98 ملفًا → insert بلا duplicates): فشل قائم قبل التعديلين.
- «15 سنة خبرة» في `asset.html`/الـworker مقابل «منذ 2014» (أي 12 سنة) و«أكثر من 10 سنوات» في `index.html`.

## 6) القرارات المنفَّذة (2026-10-14)

- **عدد المشاهدات:** يُعتمد «أكثر من 17 مليون» (كما الموقع، تحقق 2026-10-12) — أُرجع `formattedViews` و`totalViews` في `_worker/worker.js`، ولم تُمسّ أرقام الموقع.
- **رابط جوجل:** فصل الكيانين داخل الـworker — `GOOGLE_BUSINESS` (صفحة النشاط: 4.7 من 102) و`GOOGLE_PROFILE` (الملف الشخصي للمرشد: Level 7 · 7,741 نقطة · 151 مراجعة + 28 تقييم · 430 صورة · أكثر من 17 مليون مشاهدة).
- نصوص البوت (`buildGoogleAuthorityMsg` / `buildGoogleAuthorityShort` / `buildTrustBar` / توقيع رسالة واتساب) أصبحت تنسب كل رقم لصاحبه وتُظهر الرابطين بأرقامهما.
- إرجاع `photosCount` إلى 430 و`reviewsCount/ratingsCount` إلى 151/28 لتطابق ما تحقق منه الموقع.
- `add-your-property.html` و`agent.html` لم يتغيّرا: أرقامهما (430 صورة · 151 مراجعة · 17 مليون · رابط المرشد) مطابقة للسياسة الموثّقة أصلًا.

**المتبقّي (يحتاج قرارًا/وقتًا لاحقًا):** مزامنة عنوان «17M+» إن تغيّر الرقم مستقبلًا في الملفات المذكورة في 4-ب · توحيد اسم الإصدار مع `agent-worker-readonly-audit.yml` (`v9.3-W`) · رفع `CACHE_NAME` في `sw.js` · إضافة job اختبارات في CI · تشغيل التدقيق اليدوي للتأكد أن النسخة الحيّة على Cloudflare = `_worker/worker.js` · حسم تعارض الهوية («أنا طارق طنطاوي» في الصفحة vs «أنا وكيل ذكي» في الـworker) وإخفاقَي T1.3/T1.5 القديمين.

---

**الخلاصة:** تصحيحات المنطق في v9.3 جيدة وتستحق الإبقاء؛ المشكلة كانت في تعديلَي **الرابط وعدد المشاهدات** داخل `GOOGLE_PROFILE` لأنهما خالفا الأرقام الموثّقة بالتاريخ في الموقع وأكملا خلط «النشاط» بـ«المرشد المحلي» — وقد عُولجا بفصل الكيانين وإرجاع 17 مليون.

## 7) ما نُفِّذ فعليًا (2026-10-14 — الدفعة الثانية)

### أ) الحالة الحيّة للـWorkers (أدلة من تشغيلات المستودع)
- **agent (royal-snow-ea32):** تقرير `_diag/push-setup-38052254442.txt` (2026-10-10) يثبت `live == repo worker.js` عند البصمة `c3aae4d0…` = نسخة `08b58691` (10-10) التي تحمل «16.3M + رابط صفحة النشاط». أي أن **الحيّ متأخر** عن المستودع: لم يستقبل تعديل 10-12 (`adfa2996`: 17M + رابط ملف المرشد) ولا v9.3. ⇒ نشر v9.3-W هو ترقية حقيقية لا تراجع.
- **valuation (noisy-bush-fd84):** المستودع `v6.2` = الحيّ `v6.2` ونفس العقد `d1-price-snapshots-v2` (موثّق في `_worker/README.md` + فحوص ما بعد النشر). لا تغيير مطلوب؛ لا يوجد Workflow ينشره (بحسب ملاحظة `deploy-properties-sync.yml`).
- **properties-sync (nasr-properties-sync):** يُنشر ويُتحقق منه تلقائيًا من `deploy-properties-sync.yml` (v1.0.4).

### ب) ملفات الـWorkers الثلاثة
| الملف | التغيير |
|---|---|
| `_worker/worker.js` | `release: v9.3-W` في الترويسة · فصل `GOOGLE_BUSINESS`/`GOOGLE_PROFILE` · **fallback للموديل**: لو رفض Google اسم `env.GEMINI_MODEL` (400/404) يُعاد مرة واحدة بالموديل المدمج · ترويسة تشير إلى بوابة `EXPECTED_WORKER_SHA256` |
| `_worker/valuation-worker.js` | سطر مراجعة موثّق (لا تغيير سلوك) — نسخة المستودع = الحيّة v6.2 |
| `_worker/properties-sync-worker.js` | سطر مراجعة موثّق (لا تغيير سلوك) — يُنشر تلقائيًا مع اختباراته |

### ج) باقي الإصلاحات
- `.github/workflows/tests.yml`: **بوابة اختبارات جديدة** (advisory للمجموعة كاملة + خطوة حاجزة تستثني الإخفاقين المعروفين فقط). لم يكن هناك أي job يشغّل هذه المجموعة قبل اليوم.
- `_worker/tests/properties-sync.test.mjs`: العدد المتوقع صار مشتقًّا من العدد الحقيقي للملفات (كان 98/78 ثابتًا، والواقع 101/81). الإخفاق الثلاثي القديم (test 99) انتهى.
- `.github/workflows/deploy-properties-sync.yml`: `IN_SCOPE_IDS` +3 (`luxury-admin-unit-41m-rent`, `helmy-abdel-aaty-seraj-230m`, `hayat-compound-furnished-200m`).
- `.github/workflows/agent-worker-readonly-audit.yml`: رُفع فحص `7751a7dc`/`v9.3-W` المكتوب يدويًا واستُبدل بفحص **علامة `release:` المقروءة من المستودع** فتُقارَن بالحيّ دائمًا.
- `.github/workflows/push-notify-setup.yml`: `EXPECTED_WORKER_SHA256` = بصمة v9.3-W الجديدة، ووضع `AUTO_MODE=configure` للنشر ثم يُعاد إلى `verify`، ووسم النشر على Cloudflare صار `agent-v9.3`.
- `sw.js`: `CACHE_NAME` → `smsar-v2` (كان `smsar-v1`، فالـprecache لا يتحدّث مع تغيّر `agent.html`).
- `_worker/README.md` · `wrangler.agent.toml` · `.env.example`: توثيق v9.3-W، وبيانات الـWorkers الصحيحة (كان الجدول يذكر v8.7.2 وv1.0.0)، وسلوك `GEMINI_MODEL` والكاش على الحافة (5 دقائق)، وبوابة البصمة، وأمر الاختبارات الجديد.

### د) الاختبارات بعد الدفعة الثانية
`node --test _worker/tests/*.test.mjs` → **219 ناجح / 2 فاشل** (الإخفاقان المعروفان: صياغة الهوية + سطر الحالة). الخطوة الحاجزة في CI: 219/0.

## 8) النشر الفعلي — النتائج بالأدلة (2026-10-14)

### Workers الثلاثة
| Worker | الحالة | الدليل |
|---|---|---|
| **agent** `royal-snow-ea32` | **v9.3-W منشور** | run `38631030666` (configure): `upload http=200 success=true` · `live module sha after = f861131d…` = بصمة المستودع · `live == repo build: yes` · `VERDICT: SUCCESS` · bindings قبل=بعد · `/push/config` يعمل. ثم run `38631193270` (verify): `live == repo worker.js: yes` + `VERIFY_OK`. وتدقيق `38633244990`: `repo_worker_sha=f861131d…` |
| **properties-sync** `nasr-properties-sync` | **منشور + تحقق حقيقي كامل** | run `38634093234` (الفرع) و `38635023287` (master): `Deploy sync Worker → success` · `POST-DEPLOY CHECKS PASSED` · `ALL CHECKS PASSED` · `101 ملفًا: in-scope 81 · out-of-scope 12 · invalid 8` · `duplicates=0` · `foreign_key_check=0` · `no_rows_deleted=true` · `price_snapshots=39` · `areas=31` · `null_area=2` |
| **valuation** `noisy-bush-fd84` | **بلا تغيير (مقصود)** | ليس له أي Workflow نشر (بحسب ملاحظة `deploy-properties-sync.yml`)، ونسخة المستودع = الحيّة `v6.2` بنفس العقد — فلا داعي لنشر شيء |

### الموقع
- `Deploy Jekyll with Plugins` نجح على `bb973b43` ثم على `20ee528a`، والنسخة الحيّة تُثبت التغيير:
  `https://nasr-realestate.github.io/sw.js` → `const CACHE_NAME = 'smsar-v2'` ✅
  و`agent.html` الحيّ يعرض «17M+ · 430 صورة · 151 مراجعة كتبها» مع رابط **ملف المرشد** ✅

### بوابة الاعتماد — درس مهم
- `push-notify-setup.yml` نجح بالسرّ `ARENA_CLOUDFLARE`، بينما `deploy-properties-sync.yml` كان يبحث في
  أسماء أخرى فقط (`CLOUDFLARE_API_TOKEN` …) فكان **يتوقف بصمت** (`credential: MISSING`).
  أُضيفت `ARENA_CLOUDFLARE`/`ARENA_CLOUDFLARE_TOKEN` إلى سلسلته، فصار ينشر ويتحقق فعليًا.

### المتبقّي بوعي (لا يوقف شيئًا)
1. إخفاقان معروفان في `agent-page` (صياغة الهوية: «أنا طارق طنطاوي» في الصفحة مقابل «وكيل ذكي» في الـworker والاختبار، وسطر الحالة) — قرار محتوى، وهما مستثنيان صراحةً في بوابة CI.
2. تشغيل `master` القديم `38633244891` (بالأرقام المثبتة 98/78) سينتهي بالفشل المعلوم؛ superseded بتشغيل `38635023287` الناجح.
3. قيمة `GEMINI_MODEL` الحيّة غير مقروءة من المستودع (bindings تُطبع بالأسماء فقط). وُضِع لها fallback في الكود، فلو كانت مرفوضة من Google يعود الـWorker تلقائيًا للموديل المدمج بدل أن تصمت ردوده.
