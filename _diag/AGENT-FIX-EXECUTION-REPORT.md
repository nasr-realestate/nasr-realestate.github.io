# تقرير تنفيذ قبل النشر — «سمسار طلبك | الوكيل العقاري الذكي»
### مواءمة v87/v92 + إصلاح خلل الخصوصية D-4b — **بدون أي Cloudflare Deploy**

| | |
|---|---|
| الفرع | `arena/054ff4c2-nasr-realestate-github-io` |
| Commit المُنفَّذ | **`6220d90`** (مدفوع إلى فرع الجلسة فقط) |
| `master` | لم يُلمس · لا PR · لا Deploy · لا Rollback · لا حذف Version · لا D1 · لا Secrets |
| تاريخ التنفيذ | 2026-10-08 |

---

## A. الملفات المعدلة

| الملف | التغيير | الحجم |
|---|---|---|
| `agent.html` | سطر واحد: `FORM_VERSION = "v87"` → `"v92"` | +1 / −1 |
| `_worker/worker.js` | إصلاح D-4b (patch داخلي، بلا إعادة كتابة) | +16 / −4 |
| `_worker/tests/_agent-harness.mjs` | fixture الحالة: `_version: "v87"` → `"v92"` | +1 / −1 |

**لم يُلمس إطلاقًا:**
`_worker/wrangler.agent.toml` · `_worker/wrangler.valuation.toml` · `_worker/wrangler.sync.toml` · `_worker/properties-sync-worker.js` · `_worker/valuation-worker.js` · `tools/valuation.html` · `.github/workflows/deploy-properties-sync.yml` · `_worker/README.md` · أي Workflow آخر · أي Cloudflare configuration · أي Secret · أي D1 schema/data.

**لم يُغيَّر أي منطق:** matching · valuation handoff · persona · WhatsApp attribution · CORS · rate limits · upload flow · Gemini model · `FORM_VERSION` في الـWorker (بقي `v92`).

---

## B. Git Diff (كامل)

```diff
diff --git a/agent.html b/agent.html
@@ -851,7 +851,7 @@ const TAREK_WA     = "201147758857";
 const MAX_IMAGES   = 5;
-const FORM_VERSION = "v87";
+const FORM_VERSION = "v92";
 const STATUS_ONLINE = "متصل الآن";

diff --git a/_worker/tests/_agent-harness.mjs b/_worker/tests/_agent-harness.mjs
@@ -69,7 +69,7 @@ export function rawAgentRequest(path, init = {}, env) {
 export function qualifiedOwnerState(over = {}) {
   return {
-    active: true, lifecycle: "active", type: "sale", stepIndex: 0, flowType: "owner", awaitingQ: true, imageUrls: [], _version: "v87",
+    active: true, lifecycle: "active", type: "sale", stepIndex: 0, flowType: "owner", awaitingQ: true, imageUrls: [], _version: "v92",
     data: {

diff --git a/_worker/worker.js b/_worker/worker.js
@@ -1160,10 +1160,19 @@ function safeDataForPrompt(data){
   return redactPII(JSON.stringify(out)).slice(0,500);
 }
+// العنوان الخام اللي العميل كتبه بنفسه — بيتحفظ قبل أي تطبيع لمنطقة عشان التنقية تلاقيه
+function rememberRawLocation(data, raw){
+  const t = String(raw||"").trim();
+  if(t.length<6) return data;
+  const list = Array.isArray(data?._rawLocations) ? data._rawLocations : [];
+  if(list.includes(t)) return data;
+  return { ...data, _rawLocations: [...list, t].slice(-5) };
+}
 function scrubAddresses(text,data){
   let t = String(text||"");
-  const known = [data?.location, data?.gps?.address].map(x=>String(x||"").trim()).filter(x=>x.length>=6);
-  for(const a of new Set(known)) t = t.split(a).join("[عنوان]");
+  const raw = Array.isArray(data?._rawLocations) ? data._rawLocations : [];
+  const known = [...new Set([data?.location, data?.gps?.address, ...raw].map(x=>String(x||"").trim()).filter(x=>x.length>=6))].sort((a,b)=>b.length-a.length);
+  for(const a of known) t = t.split(a).join("[عنوان]");
   return t;
 }

@@ -1474,7 +1483,8 @@ async function processOwner(fs, msg, env, history, lms){
   if(isSendNow(msg)) return completeOwnerCheck(fs, fs.data||{});
-  const data = {...(fs.data||{})};
+  let data = {...(fs.data||{})};
+  if(ADDRESS_STEP_IDS.has(step.id)) data = rememberRawLocation(data, msg);

@@ -1544,7 +1554,8 @@ async function processBuyer(fs, msg, env, history, lms){
   if(isCancel(msg)) return cancelFlow(fs);
-  const data = {...(fs.data||{})};
+  let data = {...(fs.data||{})};
+  if(ADDRESS_STEP_IDS.has(step.id)) data = rememberRawLocation(data, msg);

@@ -2247,6 +2258,7 @@ export default {
           const prev = fs.data?.[key];
           if(hasVal(prev) && String(prev) !== String(v)){
+            if(ADDRESS_STEP_IDS.has(key)) fs.data = rememberRawLocation(fs.data, prev);
             fs.data = { ...fs.data, [key]: v };
```

### لماذا هذه المواضع الثلاثة بالضبط
التتبّع أثبت أن العنوان الأصلي كان يُفقَد في **مسارين**:
1. **خطوة العنوان نفسها** — `extractRequestFacts` يكتب المنطقة المختصرة في `data.location` ثم يخرج مبكرًا، فلا يُحفظ النص الخام الذي كتبه العميل.
2. **مسار «تطبيق التصحيحات» في v9.2** — الذي **يستبدل** `data.location` بالمنطقة المختصرة (منطقة السادسة بدل «شارع إبراهيم نوارة …»)، فتصبح `scrubAddresses` عمياء.

**+ تعديل دقيق ثالث:** ترتيب الاستبدال في `scrubAddresses` أصبح **الأطول أولًا**. بدون ذلك، «المنطقة السادسة» (أقصر) تُستبدل أولًا فيبقى «شارع إبراهيم نوارة» مكشوفًا. اكتشفتها عمليًا في أول محاولة وأصلحتها.

---

## C. الاختبارات — قبل / بعد (قياس baseline حقيقي عبر `git stash`)

| Suite | قبل | بعد | الدلتا |
|---|---|---|---|
| **worker-safety** | 11 ✅ / **6 ❌** | **17 ✅ / 0 ❌** | **+6 ✅** |
| agent-page | 13 / 5 | 12 / **6** | ⚠️ **−1** (تفصيل في F) |
| **valuation-handoff** | 1 / **15** | **9** / 7 | **+8 ✅** |
| market-integration | 4 / 1 | 4 / 1 | = |
| valuation-worker | 16 / 0 | 16 / 0 | = |
| valuation-page | 19 / 0 | 19 / 0 | = |
| valuation-gift | 2 / 4 | 2 / 4 | = |
| properties-sync | 39 / 1 | 39 / 1 | = |
| **الإجمالي** | **105 ✅ / 32 ❌** | **118 ✅ / 19 ❌** | **+13 ✅ / −13 ❌** |

**`worker-safety` بعد الإصلاح (17/17):**
```
ok  1 - D-6: body cap 256KB
ok  2 - D-6: upload 12MB + JSON content type
ok  3 - D-6: image 6MB / 5 images / base64 only
ok  4 - D-6: uploads 4/min + 20/hour
ok  5 - chat rate limit 15/30s
ok  6 - D-5: mobiles + 14-digit IDs never reach Gemini
ok  7 - D-5: ordinary numbers survive
ok  8 - D-4: owner flow never sends address/GPS/phone
ok  9 - D-4b: known addresses are scrubbed   ← كان فاشلًا
ok 10 - D-4: valuation enters as numbers/enums only
ok 11 - D-1: tampered valuationResult rejected
ok 12 - D-1: valid payloads normalised
ok 13 - D-1: rounding tolerance only
ok 14 - D-1: no valuation without active flow
ok 15 - D-2: announcement layout
ok 16 - D-2: rent wording
ok 17 - D-2: optional fields drop their lines
```

---

## D. هل D-4b اتصلح فعلًا؟ ✅ نعم

قياس مباشر على حمولة Gemini:

| | قبل | بعد |
|---|---|---|
| `data._rawLocations` | `null` | `["شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة"]` |
| محتوى الرسالة إلى Gemini | العنوان **خام** | `العنوان [عنوان]` |
| النصوص المسرَّبة من قائمة `SENSITIVE` | `["إبراهيم نوارة","صيدلية العزبي"]` | **`[]`** |

كما أن `safeDataForPrompt` **يتخطّى كل مفتاح يبدأ بـ`_`** → `_rawLocations` **لا يدخل الـprompt أبدًا**.
و`geminiComment` محميّ أصلًا ببوابة `if(ADDRESS_STEP_IDS.has(currentStep?.id)) return result;`.

---

## E. هل mismatch v87/v92 اتصلح؟ ✅ نعم

- `agent.html` → `FORM_VERSION = "v92"` = نفس ما يعلنه الـWorker المنشور (v9.2-FINAL).
- القياس الحيّ السابق أثبت أن المنشور **يرفض** `v87` و**يقبل** `v92` → الصفحة الآن ترسل الصحيح.
- **`STORAGE_KEY` لم يُلمس** (باقي `simsar_wa_v92`) ✅
- **`FORM_VERSION` داخل الـWorker لم يُلمس** (باقي `v92`) ✅

---

## F. هل يوجد regression؟ لا يوجد regression وظيفي — مع بندين صريحين ⚠️

### 1) تكافؤ السلوك مع المنشور ✅
أعدت كل المسابر الحيّة على الـWorker المُعدَّل → **مطابقة حرفية** للمنشور:

| المسبار | النتيجة |
|---|---|
| تحية | `أهلاً بيك، أنا طارق طنطاوي … تشتري ولا تأجر ولا تبيع؟` + 4 خيارات + `_version:"v92"` |
| سؤال هوية | نفس نص المنشور |
| خارج الموضوع | نفس نص المنشور + 0 خيارات |
| حالة `v87` | تُصفَّر → `(1/9)` |
| حالة `v92` | تُحفظ → `(2/13)` + `ui:"map_picker"` |
| `GET /` | `405 {"error":"Method not allowed"}` |
| `POST /upload-images` (text/plain) | `415 {"error":"Unsupported content type"}` |
| CORS لأصل خارجي | يرجع للأصل المسموح (لا انعكاس) |

### 2) ⚠️ `agent-page #10` — رسوب جديد سببه **الاختبار نفسه**
الاختبار يشفّر `_version: "v87"` في 5 مواضع (166 / 228 / 238 / 255 / 259) ويثبّت `assert.equal(..., "v87")`.
**قِستُ الأثر مؤقتًا** (بلا حفظ أي تعديل): لو صُحّحت هذه المُثبِّتات → **يرجع Pass**.
**لم أعدّل الملف** لأنك طلبت عدم تعديل اختبارات أخرى بهدف تحويل failures إلى passes.

### 3) مسبق وغير متعلق بتعديلي (فاشل بنفس الأرقام قبل/بعد)
- `valuation-handoff`: **H10** و **H13** فقط بعد تصحيح fixture الخاص به مؤقتًا (14 ✅ / 2 ❌) — يحتاجان triage منفصل.
- `market-integration #4`، `valuation-gift` (4 بنود)، `properties-sync #27` («79 ≠ 78» في عدّاد ملفات الـ98).
- بقية رسوبات `valuation-handoff` السبعة (5 بنود) سببها `_version:"v87"` في السطر 55 داخل الاختبار نفسه.

### 4) مسجَّل كـknown/design differences (لم أُصلحه ولم أُعلنه obsolete)
`agent-page`: **#2** `--brand-chip` · **#3** تنسيق هيدر/حقل الإدخال · **#12** نص الهوية («وكيل ذكي» مقابل شخصية طارق) · **#17** CSS لوحة المفاتيح (`vv-keyboard`).

### 5) ملاحظة شفافية
`data._rawLocations` صار حقلًا جديدًا في الـstate الراجع للعميل: بادئة `_`، بحد أقصى 5 مدخلات، ولا يدخل الـprompt ولا رسالة الواتساب. اختبار `agent-page #13` (سلامة رابط أداة التقييم) **ما زال Pass** → لا شيء غير آمن في الرابط.
(قابل للإزالة من الـstate العائد في ثانية لو رغبت.)

---

## G. Commit SHA

```
6220d9030a79e54b087822db9c71d468e60a714c
```

**الرسالة:**
```
fix(agent): align page form version with the deployed Worker + close the D-4b address leak
```

- مدفوع إلى: `arena/054ff4c2-nasr-realestate-github-io` فقط (‎16b9b4e..6220d90).
- **`master` لم يُلمس** · **لا PR** · **لا Deploy** · **لا Rollback** · **لا حذف Version**.
- تأكدت أن الـpush **لم يُطلق أي workflow** (سجل التشغيلات ما زال يظهر مسابر التحقيق فقط).
- ملاحظة: عند الـpush، البيئة عادت باستنساخ جديد (الفرع المحلي كان عند `f5fc3b8` بينما الريموت عليه commits الـprobe) → عملت `rebase` نظيف، فأصبح الـSHA النهائي `6220d90` بدل `479cb43`، وتحققت أن محتوى الملفات الثلاثة **مطابق للمُختبَر** قبل الـpush.

---

## H. هل يحتاج Cloudflare Deploy؟

| الجزء | أين يعيش الإصلاح | هل يحتاج Cloudflare Deploy؟ |
|---|---|---|
| **mismatch v87/v92** (العطل الأساسي) | `agent.html` → موقع **GitHub Pages** | ❌ **لا**. يحتاج فقط دمج/نشر على **Pages** (`master` → `Deploy Jekyll` تلقائيًا) |
| **إصلاح D-4b** (خصوصية) | `_worker/worker.js` → Worker `royal-snow-ea32` | ✅ **نعم** ليصبح فعّالًا في الإنتاج. الـWorker الحيّ **ما زال به التسريب** |

**الخلاصة:** المشكلة الأساسية (v87/v92) **مشكلة GitHub Pages فقط** ويحلّها تعديل `agent.html`.
أما D-4b فنشره متوقف على **`CLOUDFLARE_API_TOKEN` (ما زال غير موجود)** أو نشر يدوي من عندك:
```bash
npx wrangler deploy --config _worker/wrangler.agent.toml
```
الفرق المنشور سيكون **4 hunks فقط** فوق نسخة **مطابقة حاليًا للمنشور بايت-سلوكيًا** ⇒ مخاطرة منخفضة.

---

## i. سجل العمليات — ما نُفّذ وما لم يُنفَّذ

**نُفِّذ:**
1. تعديل 3 ملفات فقط (المذكورة في A).
2. قياس baseline عبر `git stash` (سحب/إرجاع) لتحديد الرسوبات المسبقة بدقة، ثم تحقق أن الملفات المُختبَرة هي نفسها المدموجة.
3. تشغيل 8 ملفات اختبار قبل وبعد + قياسات مؤقتة (لم تُحفَظ) داخل `/tmp` لتحديد أثر انحراف fixtures.
4. Commit + push إلى **فرع الجلسة فقط**.

**لم يُنفَّذ:**
❌ Cloudflare Deploy · ❌ Rollback · ❌ حذف Version/Deployment · ❌ تغيير Secrets · ❌ تغيير D1 · ❌ تعديل Valuation Worker · ❌ Webhook / Meta WhatsApp Cloud API / inbound / poller · ❌ تعديل أي Workflow · ❌ إعلان أي اختبار obsolete · ❌ تغيير أي تصميم.

**تنظيف مطلوب قبل أي دمج إلى `master`:**
- `.github/workflows/arena-cf-probe.yml` (مؤقت، على فرع الجلسة)
- `_diag/probe-*` (مخرجات المسبار، على فرع الجلسة)

---

## j. بانتظار قرارك

1. **دمج ونشر على Pages؟** (يحل العطل الأساسي فورًا — بدون Cloudflare)
2. **أرفع PR إلى `master`؟**
3. **أنفّذ الـCloudflare Deploy** لإصلاح D-4b؟ (يحتاج إرجاع `CLOUDFLARE_API_TOKEN`، أو تنفّذه أنت بالأمر أعلاه)
4. **أحذف ملفات التحقيق المؤقتة** من فرع الجلسة؟
5. **أُزيل `_rawLocations` من الـstate العائد للعميل** لو تفضّل عدم إضافة أي حقل جديد؟
