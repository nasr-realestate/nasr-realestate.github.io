# تقرير تحقيق كامل — «سمسار طلبك | الوكيل العقاري الذكي»
### GitHub ↔ Cloudflare — الحالة الحقيقية، سبب العطل، خطة الإصلاح

| | |
|---|---|
| الفرع | `arena/054ff4c2-nasr-realestate-github-io` |
| المرجع | `master` = `f5fc3b8` (748 commit في التاريخ الكامل بعد `--unshallow`) |
| زمن التحقيق | 2026-10-08، 15:26Z → 15:45Z |
| طبيعة الجلسة | **تحقيق فقط** — لا Deploy، لا Rollback، لا حذف Version/Deployment، لا تغيير Secrets أو D1 أو Valuation Worker |

---

## 0) ملخص تنفيذي

1. **المنشور على Cloudflare هو نفس كود GitHub `master` (v9.2-FINAL، `FORM_VERSION = "v92"`)** — أُثبت بقياس حقيقي على الـendpoint العام: كل ردود الـWorker الحيّ مطابقة حرفيًا لردود `_worker/worker.js` في master، والـWorker يبصم ردوده بـ`_version:"v92"`.
2. **لا يوجد أي أثر لـ`v9.3-W` ولا `7751a7dc` في Git** (38 فرعًا، كل الـcommits، كل الـPRs/Issues). أقصى نسخة موجودة في Git هي **v9.2-FINAL**.
3. **سبب العطل الحالي مُثبت:** `agent.html` يعلن `FORM_VERSION = "v87"` بينما الـWorker المنشور يشترط **v92**. النتيجة الحيّة: أي حالة محادثة قديمة **تُلغى ويبدأ الفورم من الصفر**، ونتيجة التقييم العائدة من أداة التقييم **تُسقَط**.
4. **`CLOUDFLARE_API_TOKEN` لم يعد موجودًا** → Deployment History وVersion IDs (بما فيها `7751a7dc`) **غير قابلة للقراءة الآن**. آخر دليل Cloudflare API ناجح لدينا: **2026-10-06**.
5. **اختبار `worker-safety` فيه انحراف fixture**: 5 من 6 رسوبات سببها أن الـharness يبني حالة بـ`_version:"v87"`. مع ضبط الـfixture إلى v92 → رسوب **واحد** فقط، وهو **خلل حقيقي في الخصوصية**.
6. **الرسوب الحقيقي (D-4b):** العنوان المكتوب يتسرّب إلى Gemini على مسار السؤال الجانبي، لأن v9.2 صار يطبّع `data.location` إلى «المنطقة السادسة» فتتعمّى دالة `scrubAddresses` عن العنوان الأصلي.
7. `agent-page`: **5 رسوب/18** — جزء منه تغيّر تصميم متعمّد (شخصية طارق طنطاوي)، وجزء فقد أثناء استبدالات الملفات من واجهة GitHub، وجزء تنسيق متعمّد.
8. **الواتساب سليم**: outbound `wa.me` فقط — لا Webhook، لا Meta Cloud API، لا inbound، لا poller، لا gateway خارجي، لا `phone_number_id`/`verify_token`/`X-Hub-Signature`.
9. **لا حاجة لأي Rollback**. لا يوجد Version mismatch مبرّر، ولا كود Cloudflare غير موجود في GitHub.
10. **التنفيذ متوقّف على قرارك** (الخطة في القسم 15) + إرجاع الـSecret إن أردت التحقق الكامل من Cloudflare API.

---

## 1) قاعدة عدم الادعاء — ما استطعت الوصول إليه وما لم أستطع

| القناة | الحالة | التفصيل |
|---|---|---|
| شبكة هذه البيئة | ❌ | `api.cloudflare.com` و`*.workers.dev` غير مسموحين من هذه السانديوكس (SSL_ERROR_SYSCALL) |
| GitHub API + git + gh | ✅ | قراءة كاملة: تاريخ، فروع، PRs، workflows، deployments، environments |
| GitHub Actions (تشغيل) | ✅ | شغّلت workflow قراءة فقط على فرع الجلسة |
| Cloudflare API من Actions | ❌ | **لا يوجد أي credential يعمل** (فحص 8 أسماء = MISSING اليوم) |
| endpoint الـWorker العام من Actions | ✅ | **هذا ما أثبت الحالة الحيّة** |
| تحميل سجلات Actions الخام | ❌ | `results-receiver.actions.githubusercontent.com` محجوب من هنا → استخدمت قنوات بديلة (Contents API + check-run annotations + artifacts) |
| مقارنة المصدر المنشور بايت-بايت | ❌ | تحتاج Cloudflare API token. المقارنة المتاحة (سلوكية/تعاقدية) **قاطعة** لكنها ليست بايت-بايت |

**لذلك:** لم أقل «تم التحقق» إلا على ما قِسته فعليًا. كل ما هو غير مؤكد مذكور صراحة أنه غير مؤكد.

---

## 2) جرد المشروع (Inventory)

**Workers الثلاثة** (من `_worker/wrangler.*.toml` + قياس حيّ):

| الملف | Wrangler | Worker | Hero Version في المصدر | النسخة الحيّة (مقيسة) |
|---|---|---|---|---|
| `_worker/worker.js` | `wrangler.agent.toml` | `royal-snow-ea32` | v9.2-FINAL / FORM_VERSION `v92` | **v92** ✅ |
| `_worker/valuation-worker.js` | `wrangler.valuation.toml` | `noisy-bush-fd84` | v6.2 | **v6.2** ✅ |
| `_worker/properties-sync-worker.js` | `wrangler.sync.toml` | `nasr-properties-sync` | v1.0.4 | **v1.0.4** ✅ |

**ملفات ذات صلة:**
- `agent.html` (84,576 بايت / 1,951 سطر) — `WORKER_URL = https://royal-snow-ea32.footcai-555.workers.dev/`، `STORAGE_KEY = "simsar_wa_v92"`، **`FORM_VERSION = "v87"`**.
- `add-your-property.html` سطر 306 → نفس الـWorker URL.
- `tools/valuation.html` → `noisy-bush-fd84` (`/api`, `/areas`).
- الاختبارات: `_worker/tests/` → 12 ملفًا (8 ملفات اختبار + harnesses): `worker-safety`, `agent-page`, `market-integration`, `valuation-gift`, `valuation-handoff`, `valuation-page`, `valuation-worker`, `properties-sync`.
- Workflows: `deploy.yml` (Jekyll/Pages)، `deploy-properties-sync.yml`، `cleanup-requests.yml`، `send-notification.yml`، `arena-audit-temp.yml`، `arena-preview-build.yml`، `verify-pwa-live.yml`. **لا يوجد أي workflow ينشر Agent Worker.**
- `wrangler.agent.toml`: `name="royal-snow-ea32"`, `main="worker.js"`, `compatibility_date="2026-09-01"`, `workers_dev=true`, `[[d1_databases]] binding="DB" database_name="nasr-market-db" id="ace5c9a2-c6b1-47b3-adf1-77e84ac50abf"`.

---

## 3) الحالة الحالية: GitHub

- `master` = `f5fc3b8` (MERGE PR #36 «WhatsApp lead attribution»).
- **آخر تغيير على `_worker/worker.js`: `6ca97d6`** بتاريخ **2026-10-07 23:04:18 +0300**، المؤلف `Tarek Tantawy` عبر **واجهة GitHub** (committer: GitHub)، بلا رسالة مفيدة («Update worker.js»)، بلا PR، و**إعادة كتابة كاملة**: `1190 insertions(+), 1297 deletions(-)`.
- نتيجة: v9.2-FINAL · `FORM_VERSION="v92"` · 133,102 بايت · 2,302 سطر · `md5=3145c970445040531c36e59adb8c8dc8` · `sha256=95b1f39d…83a7837`.
- آخر تغييرات `agent.html`: `7e3ac58` (2026-10-08، PR #36)، `41304b3` (2026-10-07)، `f78bef3` (2026-10-07 PR #34)…
- **ملاحظة جودة مصدر:** سلسلة استبدالات من واجهة GitHub (`Delete agent.html` → `Rename agent (8).html` → … → `Rename agent (9).html`) في 2026-10-06 → مصدر واضح لفقد أجزاء CSS/JS.

---

## 4) الحالة الحالية: Cloudflare (مُثبتة بالقياس)

### 4.1 حقائق Cloudflare API (آخر قراءة ناجحة: 2026-10-06، محفوظة في `ci/sync-report`)
- الحساب: `717c46b0d78a6f06589b8367a1a3cc5b` — «Footcai.555@gmail.com's Account».
- الـScripts في الحساب: **`nasr-properties-sync`**, **`noisy-bush-fd84`**, **`royal-snow-ea32`**.
- workers.dev subdomain: `footcai-555`.
- آخر نشر Sync: Version ID `426683d1-0ef3-4b4c-948b-c72d25d4e748` (2026-10-06T11:59Z).
- D1 `nasr-market-db` (وقتها): listings=102، source9=102، source9 بلا منطقة=2، areas=31، price_snapshots=39، duplicates=0، foreign_key_check=0.

### 4.2 قياس حيّ للـWorker (2026-10-08T15:35Z، بلا صلاحيات)
| القياس | النتيجة |
|---|---|
| `OPTIONS /` (Origin = الموقع) | `204` + `Access-Control-Allow-Origin: https://nasr-realestate.github.io` + `Allow-Methods: POST,OPTIONS` + `Allow-Headers: Content-Type` + `Cache-Control: no-store` + `Vary: Origin` ✅ |
| `GET /` (وأيضًا `/health`, `/version`, `/status`) | `405 {"error":"Method not allowed"}` — متوافق مع «POST-only» في الكود |
| `POST /` تحية | `{"أهلاً بيك، أنا طارق طنطاوي — وكيل عقاري في مدينة نصر.\nتشتري ولا تأجر ولا تبيع؟"}` + `_version:"v92"` + 4 خيارات |
| `POST /` سؤال هوية | نص `IDENTITY_RESPONSE` مطابق للمصدر + `_version:"v92"` |
| `POST /` خارج الموضوع | نص `OFF_TOPIC_RESPONSE` مطابق + `_version:"v92"` |
| حالة مفعّلة `_version:"v92"` | «العقار فين بالضبط؟ … (2/13)» + `ui:"map_picker"`, `uiRequired:true`, `flowType:"owner"` |
| حالة مفعّلة `_version:"v87"` أو `v93` أو `v90` | ❌ تُلغى الحالة ويبدأ من «(1/9)» |
| `POST /upload-images` (text/plain) | `415 {"error":"Unsupported content type"}` |
| `POST /upload-images` (JSON بلا صور) | `400 {"error":"No images"}` |
| كل الطلبات | زمن 0.15–0.76 ثانية — **لا بطء ولا timeout** |

### 4.3 الصفحات الحيّة (GitHub Pages)
- `agent.html` حيّ: `FORM_VERSION="v87"`، `WORKER_URL` = royal-snow-ea32، `STORAGE_KEY="simsar_wa_v92"`، لا webhook ولا `graph.facebook.com`، `wa.me` ×3.
- `ai-feed.json` حيّ: 99 عقارًا، `generated_at 2026-10-08T13:42:33+03:00`.
- (مقارنة البايتات بين المصدر المحلي والصفحة الحيّة **غير صحيحة منهجيًا** لأن Jekyll يعالج Liquid/front-matter — لذلك اعتمدت على العلامات الدلالية: FORM_VERSION / WORKER_URL / absence of webhook.)

---

## 5) الأجوبة A–J المطلوبة

| # | السؤال | الجواب |
|---|---|---|
| A | كود GitHub | v9.2-FINAL / `FORM_VERSION="v92"` — `_worker/worker.js` @ `6ca97d6` |
| B | كود Cloudflare المنشور | **نفس الكود سلوكيًا وتعاقديًا** — يبصم v92، كل الردود مطابقة |
| C | الـDeployment الحالي | **غير قابل للقراءة الآن** (لا token). آخر دليل ناجح: 2026-10-06 |
| D | Version/Deployment IDs | المعروف: Sync = `426683d1-0ef3-4b4c-948b-c72d25d4e748`. الـAgent: غير متاح بلا token |
| E | نسخة في Cloudflare غير موجودة في GitHub؟ | **لا دليل على وجودها**. القياس يدعم التطابق |
| F | نسخة في GitHub غير منشورة؟ | **لا** — v9.2 منشور فعليًا؛ لكن **لا يوجد أي أتمتة نشر** للـAgent (نشر يدوي فقط) |
| G | اختلاف agent.html ↔ worker.js | **نعم وهو العطل**: v87 مقابل v92 |
| H | اختلاف FORM_VERSION | **نعم**: المصدر `"v92"` / الصفحة `"v87"` / الـStorage key `…v92` |
| I | اختلاف Worker URL | **لا** — `agent.html` و`add-your-property.html` يشيران لـ`royal-snow-ea32` الصحيح |
| J | Env vars / Bindings | الـWorker الحيّ: يرفض الرفع بـ`Upload unavailable` بدون `IMGBB_API_KEY`→ دليل أن الـSecret **غير مضبوط أو غير متاح** (سلوك المصدر نفسه). `GEMINI_API_KEY`: المسارات الحتمية لا تحتاجه، daher غير مُثبت. **Bindings الخاصة بـAgent غير مُتحقَّقة بايت-بايت (تحتاج API)** — `wrangler.agent.toml` يعلن `DB → nasr-market-db` |

---

## 6) تاريخ `_worker/worker.js` الكامل (15 Commit)

| SHA | التاريخ | الحجم | ترويسة | FORM_VERSION | الأسطر | الرسالة |
|---|---|---|---|---|---|---|
| `cabc6d7` | 2026-09-23 | 83,705 | v8.3-FINAL | v83 | 1,659 | Update print statement |
| `a3a7e69` | 2026-09-24 | 83,705 | v8.3-FINAL | v83 | 1,659 | chore(audit) |
| `a51d7a1` | 2026-09-24 | 84,255 | v8.3-FINAL | v83 | 1,663 | إحصائيات Local Guide |
| `630843f` | 2026-09-26 | 106,814 | v8.4-HARDENED | v83 | 2,053 | Change Hello→Goodbye |
| `fc6ea6a` | 2026-09-26 | 116,151 | v8.5-MAPS | v83 | 2,209 | feat(maps) |
| `2432acf` | 2026-09-26 | 106,814 | v8.4-HARDENED | v83 | 2,053 | Revert maps |
| `4bdb946` | 2026-09-26 | 109,234 | v8.4-HARDENED | v83 | 2,091 | feat(maps) إعادة بناء |
| `43f781f` | 2026-09-26 | 112,856 | v8.4-HARDENED | v83 | 2,140 | P0.1 توحيد الهوية |
| `86aedee` | 2026-09-29 | 130,293 | v8.5-MAPS | v83 | 2,477 | Integrate D1 snapshots (#19) |
| `e024970` | 2026-09-29 | 143,642 | v8.7-MAPS | v83 | 2,658 | valuation → agent |
| `eeac048` | 2026-10-01 | 107,760 | v8.7-GIFT | **v87** | 2,170 | Update worker.js |
| `5d92dad` | 2026-10-01 | 110,506 | v8.7-GIFT | v87 | 2,197 | P25–P75 + rent bug |
| `4525fce` | 2026-10-02 | 118,594 | v8.7-GIFT | v87 | 2,259 | comprehensive hardening |
| `f324891` | 2026-10-03 | 129,248 | v8.7-GIFT | v87 | 2,409 | Tarek persona |
| `6ca97d6` | **2026-10-07** | **133,102** | **v9.2-FINAL** | **v92** | 2,302 | Update worker.js |

**ملاحظة:** القفزة **v87 → v92** جاءت في **Commit واحد ضخم** (`6ca97d6`) بلا PR وبلا Deploy آلي — وهو **بعد** آخر نشر Sync معروف (2026-10-06) بـ19 ساعة.

---

## 7) تحقيق الإصدارات: v9.0-FINAL / v9.2-FINAL / v9.3-W / 7751a7dc

- **v9.0-INTELLIGENCE**: مذكور **داخل تعليق الترويسة** في `worker.js` («v9.2-FINAL — فوق v9.0-INTELLIGENCE») — **لا يوجد Commit/وسم بهذا الاسم**. (قاعدة 14 مطبَّقة: التعليق لا يثبت الهوية.)
- **v8.3/v8.4/v8.5/v8.7/v9.2** — كلها **موثّقة بـCommits فعلية** (الجدول أعلاه).
- **v9.3-W**: **غير موجود في أي مكان في GitHub** (لا Commit، لا فرع، لا PR، لا Issue). فإن كان منشورًا يومًا، فقد أُزيح بلا أثر في Git — و**المنشور الحيّ الآن v92** قطعًا.
- **`7751a7dc`**: هذا **ليس SHA في هذا المستودع** (`git cat-file` → not a valid object). صيغته تشبه **Worker Version/Deployment ID من Cloudflare**. **لا أستطيع تأكيده** لأنه يحتاج Cloudflare API (المقفول الآن). لا تخمين.

---

## 8) كيف أثبتُ أن المنشور = GitHub (الطريقة)

1. **التعقب المحلي:** شغّلت نفس الطلبات على `_worker/worker.js` (عبر `_agent-harness.mjs` مع fetch وهمي) → إجابات **مطابقة حرفيًا** للحية، بما في ذلك `_version:"v92"`، `ui:"map_picker"`، عدّادات `(1/9)`/`(2/13)`، 405 لـGET، و415 لرفع `text/plain`.
2. **الحالة المتقادمة:** أرسلت حالات بـ`v87/v92/v93/v90` → السلوك مطابق للنص المصدري: `sanitizeState` يبطل كل ما ليس v92.
3. **القيد الواجب ذكره:** هذه **مكافئة سلوكية/تعاقدية عبر أكثر من 12 مسبارًا**، وليست **مقارنة بايت-بايت** للمصدر المنشور (تحتاج `Workers Scripts:Read`).

---

## 9) الاختبارات — النتائج والتصنيف

### 9.1 مصفوفة التجارب المضبوطة (`worker-safety`)
| السيناريو | النتيجة |
|---|---|
| الـWorker الحالي (v92) + fixture الحالي (v87) | **6 رسوب / 17** |
| الـWorker الحالي (v92) + fixture معدَّل إلى v92 | **1 رسوب / 17** |
| Worker v8.7 (`f324891`) + fixture كما هو (v87) | **0 رسوب / 17** |

⇒ 5 رسوبات = **انحراف fixture** سببها رفع `FORM_VERSION` في `6ca97d6` (قاعدة 16/17: لم أغيّر `FORM_VERSION` ولم أعدّل الاختبارات — استخدمت نسخة في `/tmp`).

### 9.2 التصنيف (البنود العشرة)
| # | التصنيف | البنود |
|---|---|---|
| 1 | Backend/Worker failure حقيقي | **D-4b** (تسريب عنوان إلى Gemini) |
| 2 | Frontend/agent.html | 4 بنود (`T1.1b`, التنسيق، الهوية النصية، CSS الكيبورد) |
| 3 | Version mismatch | **D-5, D-5 ordinary-numbers, D-4b, D-1 valid payloads, D-1 rounding** + `agent-page#11` |
| 4 | UI-only | بندان (`padding-bottom`، `input-field`) — تنسيق متعمّد |
| 5 | Gemini/API | لا شيء (لا يوجد فشل Gemini) |
| 6 | Matching | لا شيء |
| 7 | Valuation | لا شيء (منطق التقييم سليم) |
| 8 | WhatsApp attribution | لا شيء (PR #36 سليم، والاختبارات لم تُنفَّذ بعد) |
| 9 | Tests obsolete | بنود الهوية/التنسيق بعد تحول شخصية «طارق طنطاوي» (2026-10-03) — **قرارك** |
| 10 | Test يكشف Bug حقيقي | **D-4b** فقط |

### 9.3 تفصيل `agent-page` (5/18)
- `T1.1b`: asserts على `--brand-chip` — المتغير **كان موجودًا** في `0a34a8a`/`7ff2099`/`2573c23` (2026-10-03) و**ضاع** أثناء استبدالات `agent.html` من واجهة GitHub.
- تنسيق حقل الكتابة: الكود الحالي `padding-bottom: max(10px, env(safe-area-inset-bottom,0px))` ≠ المتوقع (تصميم متعمّد).
- `#11` فقدان الجلسة عند اختلاف النسخة (v87 المعلن vs v92 المتوقع).
- `#12` النصوص القديمة («أنا وكيل طارق طنطاوي الذكي…») — شخصية جديدة متعمّدة.
- `#17` قواعد `vv-keyboard` (`min-width:0; flex:1 1 0%` بدلًا من المتوقع) — تنسيق متعمّد.

---

## 10) العطل الجذري (السبب المرجّح — مُثبت)

**v87 (الصفحة) مقابل v92 (الـWorker).**

السلوك الحيّ المُقاس: عند وصول حالة محادثة فعلية بـ`_version:"v87"` → `sanitizeState` يُرجع حالة ملغاة → **يُصفَّر الفورم** (`(1/9)`) ويُفقد كل ما جمعه العميل. وإذا كان العميل عائدًا من **أداة التقييم**، فـ`valuationResult` يُحقَن **فقط إذا كانت الجلسة `active`** → **يُسقط التقييم**.

**النتيجة العملية:** «تعذّر الاتصال / بدأ من الأول / بيسأل من جديد» — وهذا أفضل تفسير للمشكلة التي وصفتها. **لا علاقة للـGemini ولا للـtimeout ولا لـحجم الطلب** (زمن الاستجابة 0.15–0.76 ث، ولا خطأ واحد في الردود).

**تصنيف المشكلة:** `Frontend + Version mismatch` — وليس `Worker` ولا `Deployment` ولا `Gemini` ولا `UI-only`.

---

## 11) تسريب D-4b — السبب الدقيق

`scrubAddresses(text, data)` تعتمد على `data.location` و`data.gps.address` لتُحوِّل العنوان إلى `[عنوان]`.

- في v8.7 كانت `data.location` تحتفظ بالنص الذي كتبه العميل (`شارع إبراهيم نوارة …`).
- في v9.2 أصبحت القيمة `«المنطقة السادسة»` (تطبيع)، ولم يُحفَظ النص الأصلي في أي مكان.
- لذلك الرسالة الواردة (التي يحتوي على العنوان) **لا تُنقّى**، وكذلك تاريخ المحادثة.

**القياس:** `geminiContextual` → النظام ينقّي (`اللي عارفه عنه: {"propertyType":"شقة","area":180,"price":9500000}` ✅) لكن **المحتوى (contents)** يحمل `إبراهيم نوارة` ❌.

**الأثر:** أسماء شوارع/علامات مميزة قد تصل إلى Gemini على مسار السؤال الجانبي — **خلل خصوصية حقيقي** (الاختبار الرسمي `D-4b` يرصده). ليس له علاقة بـ«توسعة عقل الوكيل»؛ الدالة نفسها لم تتغيّر (v8.7 = v9.2 حرفيًا) والمشكلة في المصدر الذي تُصقَّل به البيانات.

---

## 12) الواتساب — فحص مطابقة للممنوعات
| المطلوب منعُه | المصدر (`worker.js`) | المنشور (قياس) | `agent.html` |
|---|---|---|---|
| Webhook | ❌ غير موجود | ❌ | ❌ |
| Meta WhatsApp Cloud API | ❌ | ❌ | ❌ |
| inbound / hub.challenge / X-Hub-Signature | ❌ | ❌ | ❌ |
| phone_number_id / verify_token | ❌ | ❌ | ❌ |
| polling / Twilio / 360dialog / UltraMsg / CallMeBot / WATI | ❌ | ❌ | ❌ |
| outbound `wa.me` مع attribution | ✅ `waURL()` | ✅ | ✅ `TAREK_WA` |

---

## 13) D1 والتقييم — لم يُلمس

لم أنفّذ أي كتابة أو تعديل. المنطق المعتمد لم يتغيّر في أي من الملفات: `median` كمؤشر مركزي، `P25–P75` كـCore Range، `Min/Max` كحدود مرصودة، `>=30 high / 10–29 medium / <10 low`، «لا تخترع قيمة»، وfallback لمدينة نصر `area_id=1` بالقواعد القائمة. القياس الحيّ للـValuation Worker: **v6.2** و31 منطقة، والمنطقة الأولى `id=1 مدينة نصر (ككل)`.

---

## 14) سجل العمليات والملفات المؤقتة

**ما نفّذته (كل ما هو غير قراءة):**
1. `git fetch --unshallow` + جلب كل الفروع (محلي، قابل للتراجع).
2. إضافة Commits على **فرع الجلسة فقط**:
   - `d5bdcb1`, `a8d560e`, `5b9e45c`, `61e169f`, `a44x…` (نسخ workflow التحقيق) و`cd24fbb` (المسبار النهائي).
3. تشغيل workflow **قراءة فقط** (GET/OPTIONS + POST محادثة واحد) — بلا أي Deploy أو كتابة على Cloudflare.
4. كتابة ملفات `_diag/*` على فرع الجلسة (عبر Contents API) + artifacts.

**لم أنفّذ إطلاقًا:** Deploy · Rollback · حذف Version/Deployment · تغيير Secrets · تغيير D1 · تعديل Valuation Worker · إعادة Webhook · إضافة WhatsApp Cloud API · pollers · ملفات معرفة جديدة.

**يجب تنظيفه قبل أي دمج إلى `master`:**
- `.github/workflows/arena-cf-probe.yml` (مؤقت)
- `_diag/probe-*.txt`, `_diag/probe-*-live-agent-worker.js`, `_diag/probe-*-live-vs-repo.diff`

---

## 15) الخطة المقترحة للتنفيذ (تنتظر موافقتك)

| # | التغيير | الملف | السبب |
|---|---|---|---|
| أ | `FORM_VERSION` v87 → **v92** | `agent.html` | مصدر العطل الحيّ؛ والـ`STORAGE_KEY` أصلًا v92 |
| ب | إصلاح تسريب D-4b: الاحتفاظ بالعنوان الأصلي وإدخاله في `scrubAddresses` | `_worker/worker.js` | خلل خصوصية حقيقي (patch محدود، بلا إعادة كتابة) |
| ج | `_version:"v87"` → `"v92"` في fixture الحالة | `_worker/tests/_agent-harness.mjs` | انحراف fixture — **ليس** تعديل اختبار لإسكاته |
| د | قرارك في 5 بنود `agent-page`: إحياء CSS/تنسيق مفقود أم إعلانها obsolete | `agent.html` / `agent-page.test.mjs` | تغيير تصميم متعمّد مقابل فقد غير مقصود |
| هـ | تصحيح التعليق المضلِّل: «the agent Worker live build is ahead of the repository copies on purpose» + `README.md` (يقول v8.7.2) | `.github/workflows/deploy-properties-sync.yml` L16-18، `_worker/README.md` L7 | الواقع المقيس: التطابق التام |

**الملفات المتغيرة متوقعة:** `agent.html` · `_worker/worker.js` · `_worker/tests/_agent-harness.mjs` · (اختياريًا) `_worker/tests/agent-page.test.mjs` · `_worker/README.md` · `.github/workflows/deploy-properties-sync.yml`.

**Git Commit؟** نعم — Commit واحد على فرع الجلسة، قابل للمراجعة.
**Cloudflare Deploy؟** **نعم إذا رغبت** في إصلاح D-4b على البيئة الحيّة — و**متوقف على `CLOUDFLARE_API_TOKEN`**.
**Rollback؟** **لا — غير مطلوب إطلاقًا.**
**Version mismatch؟** لا يوجد؛ Cloudflare = GitHub.

---

## 16) العوائق وخياراتك

1. **الـSecret مفقود:** `CLOUDFLARE_API_TOKEN` (وكل الأسماء البديلة) لم يعد موجودًا للمستودع → لا استطيع قراءة Deployment/Versions ولا النشر. خياراتك: (أ) إرجاعه في Settings → Secrets، (ب) أن تفحص Dashboard بنفسك، (ج) الاكتفاء بالتحقق السلوكي.
2. **حماية الفرع:** GitHub رفض تشغيل أحد runs ووضعه `action_required` بسبب اقتباس سياق `secrets` — معالَج (النسخة الحالية لا تقتبس أي قيمة).
3. **قرارك في بنود الواجهة** (اختبارات الهوية/التنسيق) — لا يمكن أن أقرره عنك، لأنه قرار تصميم.

---

## 17) ما تبقّى غير مُثبت + طريقة إثباته

| البند | الطريقة |
|---|---|
| Deployment IDs للـAgent / `7751a7dc` | إرجاع `CLOUDFLARE_API_TOKEN` ثم: `GET /accounts/{acc}/workers/scripts/royal-snow-ea32/deployments` و`/versions` (الـworkflow جاهز وينفّذها تلقائيًا) |
| مطابقة المصدر المنشور بايت-بايت | نفس الـtoken + `GET …/content/v2` (الـworkflow يكتب diff تلقائيًا) |
| Bindings/Env vars للـAgent | `GET …/royal-snow-ea32/settings` |
| هل `gemini-3.5-flash-lite` المذكور في المصدر متاح فعلًا لحساب Gemini | يحتاج `GEMINI_API_KEY` + اختبار مسار إبداعي حقيقي |

---

**الخلاصة النهائية:** المصدر النهائي للحقيقة هو **GitHub** (Cloudflare مطابق له، لا نسخة يدوية مخصّصة)، والعطل الحالي = **`agent.html` يعلن v87 بينما الـWorker v92**، زائد **خلل خصوصية D-4b**، زائد **انحراف fixture** في الاختبارات، زائد **ديناميكية نشر غير مؤتمتة** للـAgent Worker تستحق معالجة منفصلة.
