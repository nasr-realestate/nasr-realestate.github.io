# تقرير جاهزية الذكاء الاصطناعي — 2026-10-16

> **نوع العمل**: تدقيق + تنفيذ. طلب المالك صلاحيات كاملة للتعديل، فنُفِّذت الطبقة كاملة.
> **الفرع**: `arena/0ca3d709-nasr-realestate-github-io`
> **نطاق التغيير**: ملفات المخرجات والبيانات المنظمة وطبقة الذكاء الاصطناعي — **لم يُلمس** أي من العوامل الحيّة الثلاثة.

---

## 1) الإجابة المباشرة على السؤال المطروح

| السؤال | الإجابة |
| --- | --- |
| هل للموقع «لغة مشتركة» مع أدوات الذكاء الاصطناعي؟ | **قبل**: نعم جزئيًا — البنية موجودة (`llms.txt`, `ai-feed.json`, Schema.org, قواعد AI في robots). **بعد**: نعم بالكامل — أُضيفت طبقة استدعاء (callable) لا طبقة قراءة فقط. |
| هل «يفهمهم ويفهمونه»؟ | وكيل الموقع كان يفهم التغذية. النماذج الخارجية كانت تقرأ HTML أو `ai-feed.json`. الآن تقرأ كتالوج Markdown كاملًا، أو تستدعي JSON لكل وحدة، أو تنادي أدوات MCP مباشرة. |
| هل هناك «تنسيق سري» بين النماذج؟ | **لا، ولا يمكن.** لا توجد قناة خلفية بين ChatGPT/Claude/Gemini. ما يحدث فعليًا: كل نموذج يقرأ ملفًا عامًا ويستدل عليه. |
| هل وضعنا «شفرة سحرية» تجعلهم يرشّحون الوحدات؟ | لا يوجد ما يُجبر نموذجًا على التوصية. الموجود هو **تقليل الاحتمال المعاكس**: بيانات منظمة صحيحة + ملفات مقروءة آليًا + خادم قابل للاستدعاء + سياسة إسناد. هذا يرفع احتمال الاقتباس ولا يضمنه. |
| هل ستُعرض وحدات مفردة بدل ذكر اسم الوسيط فقط؟ | نعم — وهذا ما عالجته أهم إصلاحات اليوم (انظر §3 و§4). |

---

## 2) ما كان موجودًا قبل العمل (تدقيق)

| المكوّن | الحالة قبل |
| --- | --- |
| `llms.txt` | ✅ موجود — لكنه لم يُشِر إلى كتالوج كامل ولا إلى أي واجهة قابلة للاستدعاء |
| `ai-feed.json` | ✅ قالب Liquid — لكن الحقول الرقمية تُقرأ من front matter فقط، و Liquid `plus: 0` يفشل مع «180 متر مربع» |
| `robots.txt` | ⚠️ `Disallow: /*.json$` مكتوب **قبل** `Allow: /ai-feed.json` |
| Schema.org | ✅ موجود في كل صفحة — لكن `ItemList` مقطوع عند 20 وحدة، و`datePosted` في 8 صفحات بصيغة غير ISO 8601 |
| `search-data.json` | ❌ مذكور في `robots.txt` و`_config.yml` ولم يكن يُولَّد إطلاقًا |
| `llms-full.txt` | ❌ غير موجود |
| JSON لكل وحدة | ❌ غير موجود |
| واجهة قابلة للاستدعاء (API/MCP) | ❌ غير موجودة |
| `/.well-known/ai.txt` | ❌ غير موجود |

---

## 3) إصلاحات صحّة البيانات (أهم أثر على ظهور الوحدات)

### 3.1 ‏8 ملفات كانت تُنتج `offers.price = "0"`

الملفات الثمانية الأحدث (2026-09-28 → 2026-10-16) نُشرت بلا `priceNumeric` / `areaNumeric` / `roomsNumeric` / `bathsNumeric`.
قالب `_includes/schema-property.html` كان يقرأ الحقل فقط، فكانت النتيجة بيانات منظمة تقول **السعر صفر** لـ 8 وحدات — وهو أسوأ من غياب السعر.

**الإصلاح مزدوج:**

1. أُضيفت الحقول الرقمية إلى الملفات الثمانية، بقيم مستخرجة من النص المعلن فقط:
   `priceNumeric` ‏8 · `areaNumeric` ‏8 · `roomsNumeric` ‏6 · `bathsNumeric` ‏6.
   حيث لم يكن هناك رقم حقيقي (مثل «مساحة إدارية مفتوحة» أو «مجهزة بالكامل») **لم يُضف أي حقل**.
2. صار القالب نفسه يستخرج الرقم احتياطيًا من النص:
   `page.price | remove: "," | split: " " | first | plus: 0`
   فلو نُشِر ملف جديد بلا أرقام، لا يعود الخطأ. وحين لا يوجد رقم يُحذف حقل `price` من `Offer` بدل نشر صفر.

### 3.2 تصنيف المعاملة (بيع/إيجار)

كان أي ذكر لكلمة «شهري» في العنوان يجعل الوحدة «إيجار». أربع وحدات بيع حقيقية كانت تُصنَّف إيجارًا:

| الوحدة | السبب | التصنيف الصحيح |
| --- | --- | --- |
| محل 212م — **عائد شهري** 160 ألف | «شهري» في العنوان | بيع |
| شقة 130م مفروشة (**بعائد شهري**) | «شهري» في العنوان | بيع |
| فيلا دوبلكس 180م (8.5 مليون **أو إيجار 100 ألف**) | «إيجار» في السعر كخيار ثانوي | بيع |
| شقة 200م (عائد استثماري) | «شهري» في العنوان | بيع |

النتيجة بعد الإصلاح: **81 بيع / 21 إيجار** (كانت 83/19 بتصنيف غير دقيق)، ومدى الإيجار الشهري صار منطقيًا: **9,000 – 70,000 ج.م** بدل أن يظهر «30,000,000 ج.م شهريًا».

### 3.3 ‏8 صفحات كانت تحتوي بيانات منظمة مكرّرة ومتعارضة

كل ملف من الثمانية كان يحمل كتلة `<script type="application/ld+json">` داخل محتواه، بالعيوب الآتية:

- `"datePosted": "{{ page.date }}"` → في الإنتاج يُطبع `2026-10-16 00:00:00 +0200` — **ليست ISO 8601** ⇒ بيانات منظمة غير صالحة.
- `"image": "{{ site.url }}..."` بلا `baseurl` صحيح في بعض الحالات.
- بلا `@id` ولا `url` ولا `floorSize` ولا `numberOfRooms` ⇒ كيان ثانٍ متناقض عن نفس العقار.

حُذفت الكتل من الملفات الثمانية، وبقي مصدر واحد: `_includes/schema-property.html`. وتوجد كذلك كتلة **مثال موثَّق** داخل تعليق HTML في `schema-global.html` — مصدر الإنذار الكاذب في أي مدقّق يقرأ التعليقات.

### 3.4 تصنيف نوع العقار

كان منطق الأولويات الثابتة يقرأ «مكتب إداري / مخزن 73م» كمخزن، فيختفي من فلتر المكاتب.

القاعدة الآن: **أول كلمة نوع تظهر في العنوان هي الفائز** — أي نفس ما يقرأه إنسان.
«مقر» استُثنيت من كلمات المكتب لأن «مقر تجاري» في هذا السوق تعني وحدة تجارية.

الأثر: 6 وحدات عناوينها تبدأ بـ«شقة» كانت تُصنَّف مكاتب (لأن `category: admin-hq`) صارت شققًا.

| النوع | قبل | بعد |
| --- | --- | --- |
| شقة | 69 | **75** |
| مكتب إداري | 13 | 10 |
| محل تجاري | 12 | 10 |
| فيلا | 7 | 7 |
| مخزن | 1 | 0 (الوحدة المذكورة أعلاه عادت مكتبًا) |

---

## 4) ما أُضيف: طبقة استدعاء لا طبقة قراءة

### 4.1 ملفات ثابتة تُولَّد عند كل نشر

المُولّد: `scripts/build-ai-artifacts.mjs` — يُشغَّل **بعد** `jekyll build` داخل `_site`، ويكتب **215 ملفًا / ~1.0 ميجابايت**:

| المسار | الوصف |
| --- | --- |
| `/llms-full.txt` | الكتالوج الكامل — 102 وحدة في Markdown واحد مع فهرس بالنوع/المعاملة/المنطقة وجدول أسعار |
| `/ai-feed.json` | التغذية الأساسية (أُعيد بناؤها من مصدر واحد، بنفس أسماء الحقول القديمة كلها) |
| `/api/properties.json` | كل الوحدات + `facets` في وثيقة واحدة |
| `/api/properties/<slug>.json` | 102 ملف — وحدة واحدة كاملة |
| `/api/properties/<slug>.md` | 102 ملف — نفس الوحدة بصيغة Markdown |
| `/api/index.json` | دليل الواجهة: كل نقطة وصول + الفلاتر وقيمها المسموحة |
| `/api/openapi.json` | مواصفة OpenAPI 3.1 |
| `/search-data.json` | فهرس البحث الخفيف (كان مذكورًا ولم يكن موجودًا) |
| `/.well-known/ai.txt` + `/ai.txt` | سياسة الاستخدام الآلي (سماح/شروط/إسناد) |
| `/.well-known/mcp.json` + `/mcp.json` | بطاقة خادم MCP |
| `/.well-known/mcp/server-card.json` | المسار البديل للبطاقة |

> **لماذا نسختان جذرية ونقطية لنفس الملف؟**
> `actions/upload-pages-artifact@v3` (المستخدم حاليًا) يحجب `.git` و`.github` فقط.
> لكن الإصدار **v4 يحجب كل ما يبدأ بنقطة** (`--exclude=.[^/]*`) افتراضيًا — أي أن ترقية بسيطة للإصدار كانت ستُخفي `.well-known` بالكامل **بلا أي رسالة خطأ**. لذلك: نسخة نقطية (المسار القياسي RFC 8615) + نسخة جذرية (تأمين)، ومحتواهما متطابق حرفيًا — وهناك اختبار يتحقق من التطابق.

### 4.2 خادم MCP — `_worker/mcp-worker.js` (`nasr-ai-gateway`)

هذا هو الفرق بين «نموذج قد يذكر الوسيط» و«نموذج يُعيد وحدة بمعرّفها وسعرها ورابطها».

بروتوكول MCP على Streamable HTTP (JSON-RPC 2.0)، إصدار `2025-06-18`:

- `initialize` · `ping` · `tools/list` · `tools/call`
- `resources/list` · `resources/read` · `resources/templates/list`
- `prompts/list` · `prompts/get` · `logging/setLevel` · `completion/complete`
- الإشعارات (`notifications/initialized` …) → `202` بلا جسم

**الأدوات الخمس**:

| الأداة | ما تفعله |
| --- | --- |
| `search_properties` | فلترة بـ transaction · property_type · zone · min/max price · min/max area · min_rooms · furnished · query · limit (سقف 50) |
| `get_property` | وحدة واحدة بالـ slug أو الرابط أو اسم الملف |
| `market_summary` | وسيط/أقل/أعلى من الأسعار المعروضة، لكل نوع ومعاملة |
| `list_zones` | المناطق وعدد الوحدات في كل منها |
| `get_contact` | بيانات الوسيط الرسمية + التقييم |

**الموارد**: `semsar://catalog` · `semsar://llms-full` · `semsar://contact` · `semsar://stats`.
**البرومبت**: `recommend_units` — يُلزم النموذج بالتوسيع التدريجي للفلاتر بدل اختراع وحدة، وبذكر أن السعر سعر طلب.

**ضمانات التصميم** (كلها مغطاة باختبارات حاجزة):

| الضمان | كيف تحقّق |
| --- | --- |
| قراءة فقط | لا `DB` binding، ولا SQL، ولا طلب غير `GET` — الاختبار يجرّد التعليقات ويفحص غياب `import` و`env.DB` وكل أسماء الأسرار وكل كلمات الكتابة |
| بلا أسرار | لا `GEMINI_API_KEY` ولا غيره؛ يقرأ ملفًا عامًا + كاش حافة 300 ثانية + كاش ذاكرة 60 ثانية |
| لا أرقام ملفّقة | قيمة غائبة تُعاد `null`؛ وفلتر السعر لا يُطابقه وحدة سعرها مجهول |
| فشل صريح | تغذية معطوبة ⇒ `FEED_UNAVAILABLE` أو نسخة قديمة — لا إجابة فارغة تُقرأ كـ«لا توجد وحدات» |
| تطبيع النوع | على الحقل المهيكل لا على النص — النسخة النصية كانت تُمرّر `warehouse` في فلتر `shop` |
| العزل | الاختبارات تعمل أولًا، والنشر يستهدف `nasr-ai-gateway` فقط، ويتخطى نفسه بنجاح لو غاب توكن Cloudflare |

**لا يلمس** العوامل الحيّة: `royal-snow-ea32` (المحادثة) · `noisy-bush-fd84` (التقييم) · `nasr-properties-sync` (المزامنة). لم يُعدَّل `_worker/worker.js` إطلاقًا — نسخته الحيّة أسبق من نسخة المستودع، وبصمة النشر في CI كانت ستتوقف عن المطابقة.

### 4.3 إصلاح `robots.txt`

| قبل | بعد |
| --- | --- |
| `Disallow: /*.json$` **قبل** `Allow: /ai-feed.json` | كل `Allow` قبل أي `Disallow` داخل نفس الكتلة |
| `Disallow: /*.json$` يحجب `/manifest.json` و`/site.webmanifest` | القاعدة **محذوفة** — لا يوجد JSON داخلي منشور أصلًا |
| `Disallow: /tools/` يحجب أداة التقييم العامة | `Allow: /tools/valuation.html` |
| كتلتان مكرّرتان لـ `CCBot` | كتلة واحدة |
| لا ذكر للملفات الجديدة | كل الملفات الجديدة معلنة + `Sitemap` |

أُضيف أيضًا: `Claude-SearchBot` · `Claude-User` · `Perplexity-User` · `Operator` · `Google-CloudVertexBot` · `cohere-training-data-crawler` · `Bytespider` · `Timpibot` · `ImagesiftBot` · `ai2bot` · `Omgilibot` · `Scrapy`.

> ملاحظة دقيقة: Google يستخدم **أطول مطابقة** لا أول مطابقة، فالتغيير لا يؤثر على Google.
> لكن عددًا من الأدوات والزواحف الأخرى تستخدم أول مطابقة — وهي التي كانت ستحجب `ai-feed.json`.

### 4.4 البيانات المنظمة على الصفحات

| التغيير | التفصيل |
| --- | --- |
| `ItemList` من 20 إلى **102** | كان Google والذكاء الاصطناعي يرون 20 وحدة من 102 |
| كل `ListItem` صار كيانًا | `RealEstateListing` كامل + `Offer` بالسعر + `floorSize` + `PostalAddress` |
| `numberOfItems: 102` | صار مطابقًا للعدد الفعلي في القائمة |
| `Dataset` جديد | يوصف `ai-feed.json` بـ `variableMeasured` لكل حقل و`distribution` لكل صيغة و`spatialCoverage` و`temporalCoverage` و`size` |
| `mainEntity` في صفحة الوحدة | كيان `Accommodation`/`Store`/`Office` متداخل يحمل `floorSize` · `numberOfRooms` · `numberOfBathroomsTotal` · `floorLevel` · `additionalProperty` · `amenityFeature` · `address` |
| `amenityFeature` | يُستخرج من نص الصفحة بـ 13 قاعدة (جراج · أسانسير · تكييف · حديقة · روف · حصة · أمن · قانون جديد · مطبخ …) |
| `keywords` | مصفوفة نصية مبنية من العنوان والموقع |
| `priceSpecification` | للإيجار فقط (`unitCode: MON`) — البيع سعر إجمالي فلا يُلبَس وحدة زمنية |
| `petsAllowed` / `itemCondition` / `accommodationCategory` | **حُذفت** — ادّعاءات لا توجد بيانات تسندها |

**تصحيح مهم في استخراج التجهيزات**: المطابقة النصية المجرّدة كانت تُنتج «روف/تراس» من كلمة «مع**روف**» في وصف إعلان محل. القاعدة الآن تطابق الكلمات القصيرة الملتبسة (روف · أمن · حصة · مطبخ) ككلمة مستقلة — نُفضّل تفويت تجهيز حقيقي على ادّعاء تجهيز غير موجود.

**إصلاح تجهيزي على مستوى الجذر**: تعليق توثيقي داخل `schema-global.html` كان يحتوي `<script type="application/ld+json">` مكتوبًا حرفيًا، وهو ما يجعل أي مدقّق يقرأ التعليقات يبلّغ عن كتلة JSON غير صالحة. سبب الإنذار الكاذب موثَّق الآن في التقرير.

### 4.5 توضيح ما هو «قابل للاكتشاف» على كل صفحة

في `_layouts/default.html` أُضيف:

```html
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<meta name="ai-content-policy" content="allow-indexing, allow-summarization, allow-agent-use; attribution-required">
<link rel="alternate" type="application/json"  href="/ai-feed.json">
<link rel="alternate" type="text/markdown"      href="/llms-full.txt">
<link rel="alternate" type="text/plain"         href="/llms.txt">
<link rel="describedby"  type="application/json" href="/api/index.json">
<link rel="ai-catalog"   type="application/json" href="/api/properties.json">
<link rel="mcp-server"   href="https://nasr-ai-gateway.footcai-555.workers.dev/mcp">
<!-- ولملفات العقارات تحديدًا: -->
<link rel="alternate" type="application/json"  href="/api/properties/<slug>.json">
<link rel="alternate" type="text/markdown"      href="/api/properties/<slug>.md">
```

`max-snippet:-1` مهم عمليًا: بدونه تُقصّ مقتطفات الوحدات في إجابات المساعدين.

---

## 5) التحقّق

| الفحص | النتيجة |
| --- | --- |
| 102 صفحة عقار — JSON-LD | **0 غير صالح** · 306 كتلة · 3 وحدات بلا سعر معلن (صحيح) |
| 8 صفحات رئيسية — JSON-LD | 0 غير صالح · 16 كتلة |
| `ai-feed.json` | JSON صالح · 102 وحدة · كل الحقول القديمة موجودة |
| 215 ملف مُولَّد | كل ملفات `.json` صالحة (109 ملف) |
| المُولّد مع `--check` | لا يكتب أي ملف (آمن كبوابة CI) |
| اختبارات MCP | **24/24** |
| اختبارات طبقة AI | **23/23** |
| اختبارات قارئ front matter | **8/8** — منها تكافؤ كامل مع `gray-matter` على 104 ملفًا |
| مجموعة الاختبارات كاملة | **274/276** — الإخفاقان الوحيدان هما **المعروفان مسبقًا** والمسجّلان في `tests.yml` |
| مجموعة مسار النشر بعد حذف `node_modules` | **54/55** (واحد مُتخطّى تلقائيًا) · **0 إخفاق** — أي أن النشر لا يحتاج أي حزمة |

### الإخفاقان المعروفان مسبقًا (لم يُقدَّم أي إخفاق جديد)

مطابقان تمامًا لـ `KNOWN_FAILURES` في `.github/workflows/tests.yml`:
`stored sessions: a stale valuation|T1.5: the page says it is the agent` — وهما قرار محتوى لا قرار كود (موثّقان في `_diag/last-publish-sync-audit-2026-10-14.md`).

---

## 6) الملفات التي تغيّرت

**جديد**
```
scripts/lib/front-matter.mjs            قارئ front matter مستقل (بلا حزم)
scripts/lib/properties.mjs              نموذج البيانات الموحّد + الاستخراج
scripts/lib/ai-docs.mjs                 مُولّدات llms-full / Markdown / ai.txt / MCP / OpenAPI
scripts/build-ai-artifacts.mjs          المُولّد — 215 ملفًا
_worker/mcp-worker.js                   خادم MCP (v1.0.0)
_worker/wrangler.mcp.toml               إعداد النشر (بلا bindings)
_worker/tests/mcp-gateway.test.mjs      24 اختبارًا
_worker/tests/ai-artifacts.test.mjs     23 اختبارًا
scripts/tests/front-matter.test.mjs     8 اختبارات (منها تطابق كامل مع gray-matter)
.github/workflows/deploy-mcp-gateway.yml
_diag/ai-readiness-2026-10-16.md        هذا التقرير
```

**مُعدَّل**
```
_properties/*.md (8 ملفات)              إضافة الأرقام الرقمية + حذف JSON-LD المكرّر
robots.txt                              ترتيب القواعد + الملفات الجديدة + وكلاء جدد
llms.txt                                إعادة كتابة كاملة: الطبقات · الحقول · قواعد الإلزام
properties.html                         ItemList كامل + Dataset
_includes/schema-property.html          أرقام احتياطية + mainEntity + تجهيزات
_layouts/default.html                   وسوم robots/AI + روابط الموارد
_config.yml                             keep_files للأصول الجديدة
package.json                            سكربتات build:ai · build:site · test · test:ai
server.js                               معاينة محلية لكل نقاط الوصول الجديدة
humans.txt                              قائمة ما تقرأه الآلات
_worker/README.md                       صف + قسم لخادم MCP
.github/workflows/deploy.yml            خطوة توليد + تحقّق + ملاحظتا إصدار النشر و npm
.github/workflows/tests.yml             بوابة حاجزة منفصلة لطبقة AI + اختبارات scripts/
```

---

## 7) ما تبقّى (اختياري، لم يُنفَّذ)

1. **نشر خادم MCP فعليًا** — يحتاج توكن Cloudflare في أسرار المستودع. الـworkflow جاهز ويتخطى نفسه بنجاح لو غاب التوكن، فلا يوجد إخفاق أحمر. بمجرد وجود التوكن، أي تعديل على `_worker/mcp-worker.js` ينشره ويعمل فحص دخان على `GET /`.
2. **توحيد أرقام Google** — `4.7 / 102 مراجعة` ثابتة في `llms.txt` و`schema-global.html` و`mcp-worker.js`. لو تغيّر عدد المراجعات، توجد ثلاثة مواضع تحتاج تحديثًا يدويًا (لم أُدخل مصدرًا واحدًا لأن العدد يتغيّر خارج المستودع).
3. **`<link rel="alternate">` في `sitemap.xml`** — `jekyll-sitemap` لا يدعمها أصلًا؛ لا حاجة عملية.
4. **إضافة `_plugins/*.rb`** — رُفض عن قصد: بناء الإنتاج يستخدم `bundle exec jekyll build`، وخطأ Ruby واحد يُسقط الموقع كله، ولا يوجد مفسّر Ruby في بيئة التطوير للتحقق. مُولّد Node بعد البناء يحقّق نفس النتيجة بلا هذه المخاطرة.

---

## 9) عثرات تشغيلية اكتُشفت أثناء التنفيذ (لم تكن ظاهرة في التدقيق النظري)

هذه ثلاثة أعطال كانت ستُبقي الطبقة الجديدة **صحيحة على القرص ومكسورة في الإنتاج** — كشفها تشغيل خط النشر الفعلي لا قراءة الكود:

### 9.1 `package-lock.json` مستثنى من Git ⇒ `npm ci` يفشل  — وقد عُوّض الحل في 2026-10-16 (§10)

`.gitignore` يحتوي `package-lock.json` (وهو غير متتبَّع فعليًا: `git cat-file -e HEAD:package-lock.json` يفشل).
و`npm ci` **يشترط** وجود قفل، و`actions/setup-node` مع `cache: npm` يشترطه أيضًا. أول نسخة من خطوة النشر كانت ستفشل عند أول تشغيل.

**الحل**: أُزيلت `npm` من مسار النشر بالكامل. المُولّد صار **مستقلًا تمامًا** عبر `scripts/lib/front-matter.mjs` — قارئ front matter مكتوب لهذا الغرض (المدعوم: `key: value`، تنصيص مفرد/مزدوج، تعليقات، أسطر فارغة، قوائم سطر واحد، booleans/أرقام).
والضمان ليس «الثقة في الكود» بل **اختبار تكافؤ** يقارن مخرجاته بـ `gray-matter` على **كل ملفات `_properties` و`_requests` (104 ملفًا)**: 0 اختلاف.
وأُضيف اختبار يمنع أي `import` من خارج `node:` والمسارات النسبية في ملفات مسار النشر، حتى لا يعود الاعتماد على npm صامتًا.
و`_worker/worker.js` و`mcp-worker.js` لم يعتمدا على أي حزمة أصلًا.

### 9.2 `upload-pages-artifact` وحجب الملفات النقطية

`actions/upload-pages-artifact@v3` (المستخدم) يحجب `.git` و`.github` فقط — أي أن `.well-known` يصل.
لكن الإصدار **v4** يحجب `--exclude=.[^/]*` افتراضيًا، فتُحذف `.well-known` بالكامل **بلا أي خطأ**. وهو تغيير من سطر واحد في ملف الـworkflow.

**الحل**: ملاحظة تحذيرية في `deploy.yml` عند خطوة الرفع + إنتاج نسختين جذريتين (`/ai.txt` و`/mcp.json`) بنفس المحتوى حرفيًا، مع اختبار يتحقق من تطابق النسختين.

### 9.3 Liquid ‏4 لا يدعم `push` ولا `concat`

أول نسخة من بناء `keywords`/`amenityFeature` استخدمت `| concat:` و`| push:`. الفلتران أُضيفا في Liquid 5، وJekyll (عبر github-pages م231) يستخدم Liquid 4.
والمشكلة أن Jekyll بضبطه الافتراضي **لا يُسقط البناء** على فلتر مجهول — بل يُعيد المدخل كما هو. أي أن الخطأ كان سيمر صامتًا ويُنشر قائمة تجهيزات فارغة.

**الحل**: بُني كل التجميع بنمط `append` + `split` فقط، وهو مدعوم في Liquid 3 وما بعده، ومُتحقَّق منه محليًا بمحرّك LiquidJS على 102 صفحة.
(كذلك: `{{ }}` لا يعمل داخل وسوم Liquid — الرابط المطلق للوصف الصوتي كان سيُنشر كنص حرفي `{{ site.url }}`، وصُحّح ببناء الرابط في `assign` منفصل.)

---

## 10) تصحيح جوهره اكتُشف بعد النشر الأول: من ينشر الموقع فعلًا (2026-10-16 مساءً)

هذا القسم يُصحّح فهمًا كان مبنيًا على قراءة ملفات الـworkflow بدل مراقبة الناتج الحيّ.

### 10.1 الحقيقة التشغيلية

`GET /repos/.../pages` يقول: `build_type: "legacy"` و`source: {branch: "master", path: "/"}`.

أي أن **الناشر الفعلي هو بناء الفرع (مجلد الجذر كما هو)**، لا مخرَج `_site` الذي يرفعه `deploy.yml`.
والدليل الحيّ: بعد نجاح «Deploy Jekyll with Plugins» (تشغيل 38959048782) و«pages build and deployment» معًا،
كانت النتيجة على الموقع المنشور:

| المسار | الحالة قبل هذا التصحيح |
|---|---|
| `/ai-feed.json` · `/llms.txt` · `/robots.txt` | ✅ منشورة (ملفات جذرية يحفظها المستودع) |
| `/llms-full.txt` · `/api/**` · `/.well-known/**` · `/search-data.json` · `/ai.txt` · `/mcp.json` | ❌ **404** — لأنها كانت تُولَّد في `_site` فقط |

فطبقة الذكاء كانت **نصف منشورة**: النصف الذي يعتمد على المولّد لم يصل إلى الإنترنت.
وهذا يعني أيضًا أن `_worker/mcp-worker.js` (لو نُشر العامل لاحقًا) كان سيفشل في قراءة `/llms-full.txt`.

### 10.2 الإصلاح المطبَّق

1. **حفظ مخرجات المولّد في الجذر** (`node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json`) — 215 ملفًا/859 كيلوبايت،
   و`ai-feed.json` **مستثنى**: مصدره الجذري قالب Liquid يبنيه Jekyll من `_properties` مباشرة، فلا يُستبدل بمخرج ثابت.
2. **Markdown آمن لـJekyll**: كان كل ملف `api/properties/<slug>.md` يبدأ بـfront matter بين `---`،
   وJekyll يعدّ ذلك «صفحة» فيحذف الوصف الميكانيكي ويخدم HTML بدل Markdown — **بلا أي رسالة خطأ**.
   صار الوصف سطرًا واحدًا في تعليق HTML: `<!-- ai-property {…} -->` + `--` مُهرَّبة بـ`\u002d`،
   فالملف يبقى «ملفًا ثابتًا» يُخدَم كما هو، ويبقى الوصف مقروءًا للآلات والنماذج.
3. **`include: ['.well-known']`** في `_config.yml`: Jekyll يتجاهل ما يبدأ بنقطة إلا بتصريح صريح.
4. **حرس انحراف** (`scripts/check-ai-artifacts-in-sync.mjs`، بلا npm): يعيد التوليد في مجلد مؤقت ويقارن 214 ملفًا
   بعد تطبيع الطوابع الزمنية وحدها، ويفشل بكود 1 عند أي اختلاف — فلا تبقى النسخة المنشورة قديمة بصمت.
   (اختبار سلبي مُنفَّذ: تعديل بايت واحد في `api/index.json` ⇒ فشل؛ تعديل سعر عقار بلا إعادة توليد ⇒ 4 انحرافات.)
5. **بوابة جديدة** `.github/workflows/verify-ai-layer.yml`: تبني بنفس بناء النشر (`bundle exec jekyll build`) ثم
   يشغّل `_diag/check-ai-layer-published.mjs` — يتحقق أن 317 ملفًا نُشرت **حرفيًا** (لا تحويل ولا حذف)،
   ويمنع بعينه الخطأين الصامتين: معالجة `.md` كصفحة، وإهمال `.well-known`.

### 10.3 ما لم أستطع فعله من هنا (يحتاج قرارك)

**البديل الأنظف**: تحويل مصدر النشر إلى GitHub Actions (Settings → Pages → Source: *GitHub Actions*)،
فيصبح مخرَج `deploy.yml` هو المنشور، ويختفي الحاجة إلى حفظ أي ملف مولَّد في Git.
طلب `PUT /repos/.../pages {build_type: "workflow"}` ردّ بـ**403 «Resource not accessible by integration»** —
صلاحية `pages: write` غير ممنوحة لهذا التكامل، وهذا التغيير من لوحة الإعدادات عندك بضغطة واحدة.
حتى ذلك الحين، الطريقة العاملة والمُتحقَّق منها هي حفظ المخرجات في الجذر أعلاه.

---

## 8) الخلاصة في سطر واحد

> الموقع كان **يُقرأ**؛ صار **يُستدعى**. وأهم مكسب عملي ليس الملفات الجديدة، بل أن **8 وحدات كانت تعلن سعرًا صفرًا** و**20 من 102 كانت وحدها مرئية للفهرسة** و**6 شقق كانت مُصنَّفة مكاتب** — أي أن جزءًا من سبب «عدم ظهور الوحدات» لم يكن في طبقة الذكاء الاصطناعي، بل في البيانات نفسها.

---

## 11) تصحيح لاحق (نفس اليوم مساءً): المضيدة الرابعة — إضافة Pages الافتراضية

**كيف اكتُشفت**: بعد حفظ طبقة الذكاء في الجذر، أضفت بوابة `.github/workflows/verify-ai-layer.yml`
تبني بنفس بناء النشر (`bundle exec jekyll build`) ثم تشغّل `_diag/check-ai-layer-published.mjs`.
أول تشغيل لها فشل برسالة:

> `api: 102 ملفًا في _site ليس في المستودع (properties/<slug>/index.html …)`

**السبب**: GitHub Pages تُفعّل تلقائيًا الإضافة `jekyll-optional-front-matter` — اسمها في
`DEFAULT_PLUGINS` داخل `github/pages-gem` v231، أي أنها تعمل **بلا أن نطلبها، وعلى الإنتاج أيضًا**.
وهي تأخذ كل ملف Markdown ساكن بلا front matter (فوقع عليها `api/properties/*.md` الـ102) وتحوّله
إلى «صفحة» ذات رابط pretty، فيُنشر الملف **مرتين**:

* `api/properties/<slug>.md` — نسخة حرفية صحيحة (الأصل يُحتفظ به افتراضيًا: `remove_originals: false`)،
* `api/properties/<slug>/index.html` — 102 صفحة HTML مكرّرة تدخل `sitemap.xml`، وتتقدّم على واجهة
  JSON/Markdown التي نعد بها النماذج.

**الإصلاح في `_config.yml`، لا في الفحص**:

```yaml
optional_front_matter:
  enabled: false
```

ولماذا لا `require_front_matter: true`؟ لأن الإضافة تُفعّل معها `remove_originals` فتُحذف النسخ
الأصلية من `_site` بدل أن تُنشر حرفيًا — استبدال عيب بعيب.

**الحراسة**: `scripts/tests/publish-config.test.mjs` (6 اختبارات، تُنجَز محليًا في أقل من ثانية)
تحرس المضائد الأربع معًا: إطفاء الإضافة، غياب `require_front_matter`، وجود `.well-known` في
`include`، واكتمال `keep_files` مع غياب طبقة الذكاء عن `exclude` — إضافة إلى أن كل ملف وصف في
`api/properties` يبدأ بـ`<!-- ai-property` لا بـ`---`.
اختبارات سلبية مُنفَّذة: `enabled: true` ⇒ فشل فوري؛ حذف `.well-known` من `include` ⇒ فشلان؛
إضافة `api` إلى `exclude` ⇒ فشل. وأُضيف `Gemfile`/`Gemfile.lock` إلى مسارات تشغيل البوابة، لأن
سلوك النشر يتغيّر بتغيّر إصدار `github-pages`.

**الدرس**: البوابة كانت محقّة والخطأ كان في الإعداد. الاستجابة الخاطئة كانت ستكون «تجاهُل ملفات
`index.html` في الفحص» — أي إخفاء عيب حقيقي في الموقع بدل إصلاحه.

---

## 12) حالة النشر النهائية — تحقّق حيّ على الموقع (2026-10-16، بعد دمجه في master)

الدمج: PR #62 ⇒ `7ec5a7b` على master · تشغيل النشر `pages build and deployment` **نجح** ·
`build_type: legacy` · `status: built`. كل ما يلي جُلِب من الموقع الحيّ فعلًا (لا من المستودع):

| المسار | الحالة |
|---|---|
| `/api/index.json` | ✅ JSON · `schema_version 3.0` · `total_count 102` |
| `/api/properties/<slug>.json` | ✅ بطاقة كاملة (citation · broker · property + `markdown_url`/`json_url`) |
| `/api/properties/<slug>.md` | ✅ **Markdown خام** يبدأ بـ`<!-- ai-property {…} -->` — لا HTML ولا front matter |
| `/.well-known/ai.txt` و`/ai.txt` | ✅ سياسة الاستخدام كاملة |
| `/.well-known/mcp.json` و`/mcp.json` | ✅ مطابقة بايتًا لبعضها (3 نسخ: الجذر + .well-known + server-card) |
| `/llms-full.txt` | ✅ الكتالوج الكامل: 102 وحدة + فهرس + جدول أسعار |
| `/search-data.json` | ✅ فهرس خفيف بـ102 وحدة |
| `/ai-feed.json` | ✅ JSON صالح · `total_count 102` (قالب Liquid يُصيَّر بواسطة Jekyll — لم يُستبدل) |
| `/api/properties/<slug>/` | ✅ **404** — صفحات HTML المكرّرة غير موجودة (تأكيد حيّ لإصلاح §11) |
| `/properties/<slug>/` | ✅ صفحة الوحدة الحقيقية سليمة (لم يتأثر الموقع) |
| `/sitemap.xml` | ✅ فيه روابط `/properties/**` فقط — لا تسرّب لمسارات `/api/**` |

### 12.1 قرار صيانة: بطاقة MCP صارت تصرّح بحالتها

جلب مباشر لـ`https://nasr-ai-gateway.footcai-555.workers.dev/mcp` أعاد صفحة Cloudflare
«There is nothing here yet» — أي أن البوابة **غير منشورة** (أسرار Cloudflare غير مضافة إلى
المستودع، فخطوة النشر في `deploy-mcp-gateway.yml` تُتخطّى بلطف). وكانت `mcp.json` و`ai.txt`
و`llms.txt` تعلنها «أدوات جاهزة» — ادّعاء غير صحيح في عقد موجَّه للنماذج. فصار:

* `mcp.json` (والنسختان المطابقتان) يحمل `availability.status = "pending-deployment"` مع
  `verified_at` و`note` و`guaranteed_fallback` و`guaranteed_paths` (خمسة مسارات تعمل اليوم).
* `api/index.json` صار يحمل `mcp.status` و`mcp.fallback`.
* `ai.txt` صار يحمل `AI-MCP-Status:` و`AI-MCP-Fallback:`.
* `llms.txt` (مكتوب يدويًا) أُزيل منه ادّعاء الجاهزية من الموضعين، وأُشير إلى الحقل
  `availability` في البطاقة. و`humans.txt` وُسم بوسم `(pending deployment)`.

مصدر الحقيقة واحد: `MCP_GATEWAY_STATUS` في `scripts/lib/ai-docs.mjs`. وبعد إضافة مفتاح
Cloudflare وتشغيل `deploy-mcp-gateway.yml`: بدّل `status` إلى `live` وحدّث `verified_at`
ثم `node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json` — واختبار الوحدة
الجديد يفرض وجود الحالة والمسار المضمون فلا يُنسى الحقل لاحقًا.

**الوحيد المتبقّي**: نشر بوابة MCP — يحتاج سرًّا من Cloudflare (أي اسم من السبعة التي
يقرأها الـworkflow) ولا يمكن نشرها من هذه البيئة.

---

## 13) خطة نشر البوابة، ولماذا فاحص جديد (2026-10-16)

### 13.1 تدقيق قبل التنفيذ: ما كان مُدّعى مقابل ما كان موجودًا فعلًا

قاعدة «لا تلفّق» تُطبَّق أولًا على التسليم نفسه، لذلك قِيس كل ادّعاء قبل البناء عليه:

| الادّعاء الوارد في التكليف | الواقع المقاس في الشجرة |
|---|---|
| رأس الفرع المحلي `6703ebe` أقدم من master | `git rev-parse HEAD` = `a70f7e3` = `origin/master` تمامًا، والشجرة نظيفة (`nothing to commit`). ولا وجود لكائن `6703ebe` أصلًا: `git cat-file -t 6703ebe` ⇒ `fatal: Not a valid object name` |
| `_diag/verify-mcp-gateway.mjs` موجود على القرص | **غير موجود** (لا على القرص ولا في شجرة Git) — كُتب الآن من الصفر |
| الـworkflow معدَّل عن master بـ19 سطرًا | **مطابق لـmaster بايتًا ببايت** (`git show origin/master:… \| diff - …` ⇒ فارغ) — التعديل أُضيف الآن |
| هذا الملف فيه §13 | آخر قسم كان §12.1 والملف 440 سطرًا — أي أن §13 كُتب الآن أيضًا |
| السر `ARENA_CLOUDFLARE_TOKEN` أُنشئ | لا يُثبَت من هنا: `gh secret list` ⇒ **403**، وآخر تشغيل على master (`38959048723`) طبع كل الأسرار السبعة `no` وتخطّى النشر. ما أُثبت لاحقًا أضعف وأدق: **توكنًا ما في السلسلة موجود** لأن خطوة النشر اشتغلت فعلًا في `38971312205` بدل أن تُتخطّى — أمّا اسمه فبقي غير مقروء (السبب في §14.3) |
| `workflow_dispatch` يشغّل النشر عند الحاجة | `gh workflow run deploy-mcp-gateway.yml --ref master` ⇒ **403 Resource not accessible by integration**؛ فالدفعة على فرع `arena/**` هي المُشغّل الوحيد المتاح فعلًا |

الخلاصة: لم يكن هناك عمل جاهز للدفع، بل مواصفة لعمل. لذلك كُتب الفاحص وعُدّل الـworkflow
وفق المواصفة نفسها (نفس المسارات، نفس موضع الخطوة بعد الدخان)، ثم قِيس كل شيء.

### 13.2 لماذا لا تكفي الاختبارات ولا خطوة الدخان

ثلاث طبقات كانت موجودة، ولا واحدة منها تُجيب عن السؤال المطلوب:

1. `_worker/tests/mcp-gateway.test.mjs` — يثبت صحة **الكود** (fetch موك بالكامل، شبكة مقطوعة
   عن قصد). لا يعرف شيئًا عن النسخة المنشورة.
2. `Deploy with Wrangler` — تُتخطّى بلطف (`if: has_token`) عند غياب التوكن، فينجح التشغيل
   بلا أي نشر. هذا بالضبط ما جعل كل التشغيلات السابقة خضراء والبوابة فارغة.
3. `Smoke-test` — معلّقة على **نفس الشرط** (`has_token == 'true'`)، فلا تُشغَّل حين يُتخطّى
   النشر؛ وحتى حين تُشغَّل فهي `GET /` فقط: بطاقة JSON تردّ 200 لا تُثبت أن خادم
   JSON-RPC يعمل.

الفجوة: لا شيء يثبت أن **البوابة المنشورة** تُجري مصافحة MCP فعلًا. من هنا جاء الفاحص.

### 13.3 تصميم `_diag/verify-mcp-gateway.mjs`

* سبع مراحل على الشبكة الحقيقية بلا mocks: `card` · `health` · `initialize` · `initialized`
  (إشعار ⇒ 202 بلا جسم) · `tools/list` · `tools/call` · `resources/read`.
* **كل نتيجة تُقارَن بكتالوج المستودع** لا برقم متوقَّع مكتوب في الفاحص: عدد الوحدات من
  `_properties` عبر `scripts/lib/properties.mjs` (102)، وأسماء الأدوات من `mcp.json`،
  وأسماء الموارد من `mcp.json`. والوحدة المُختبَرة بـ`get_property` هي `slug` حقيقي من
  الكتالوج لا مُختلَق.
* الغياب يبقى غيابًا: `UNREACHABLE` (بيئة لا مخرج لها) غير `NOT_DEPLOYED` (صفحة
  Cloudflare الافتراضية «There is nothing here yet») غير `HTTP_xxx` — ولا يُترجم أيٌّ منها
  إلى نجاح أو إلى تشخيص بالتخمين.
* `--flip` يرفض الإعلان إن لم تنجح المصافحة، ويرفض كذلك «النجاح الأخضر الذي تخطّت خطواته»:
  يشترط أن تكون `Deploy` و`Smoke-test` و`MCP handshake` كلها `success` **لا `skipped`**.
* بلا اعتماديات (Node 22 فقط) مثل بقية فاحصات `_diag/`.

عطلان حقيقيان اكتُشفا أثناء الكتابة وعولجا في الفاحص نفسه:

* **TLS**: بيئة التنفيذ تعترض الاتصالات بشهادة من مخزن النظام، وNode لا يثق إلا بمخزنه
  المضمَّن ⇒ `fetch` إلى `api.github.com` يفشل بـ`UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
  الحل: قناتان — fetch مباشر، ثم عملية Node فرعية بـ`--use-system-ca` (نفس
  `process.execPath`، بلا أمر من PATH حتى لا تُخرق `sonarjs/no-os-command-from-path`،
  وبلا توكن في argv).
* **قناة الدليل**: انظر §14.1 — ملخّصات الخطوات غير مكشوفة برمجيًا، فالدليل يُكتب
  في annotation.

### 13.4 ما لم يُلمس عن قصد

`royal-snow-ea32` · `noisy-bush-fd84` · `nasr-properties-sync` (لا أمر deploy لها في
الـworkflow ولم يُنشَر أي منها) · `build_type=legacy` لنشر Pages · `optional_front_matter`
في `_config.yml` · قالب `ai-feed.json` السائل (لم يُعَد توليده: `--skip=ai-feed.json`).

---

## 14) النتيجة المقاسة: البوابة `live` (2026-10-16)

كل قيمة أدناه **قراءة فعلية** من تشغيل أو من endpoint حيّ، لا قيمة متوقَّعة.

### 14.1 النشر والمصافحة في CI

| التشغيل | الفرع / الرأس | ماذا أثبت |
|---|---|---|
| `38959048723` | master · `253f39a` | **قبل** العمل: كل الأسرار السبعة `no` ⇒ `Deploy` متخطّاة ⇒ «نجاح» بلا نشر. دليل على أن الخضرة السابقة كانت خادعة |
| `38971312205` | `arena/11d8e9c0…` · `eba073a` | أول نشر حقيقي: `Deploy` ✓ `Smoke-test` ✓ `MCP handshake` ✓ — annotation: «المصافحة الكاملة نجحت على البوابة الحيّة» |
| `38972182779` | `arena/11d8e9c0…` · `aca2cf6` | نفس النجاح + دليل آلي مقروء برمجيًا (أدناه) — وهو الدليل الذي قُبل لتبديل الحالة |

سطر الوقائع كما ورد حرفيًا في annotation التشغيل `38972182779`
(`check-runs/117212992726/annotations`):

```
verdict=pass · properties=102/102 · health_status=ok · read_only=true ·
protocol=2025-06-18 · tools=5/5 · resources=4 · release=v1.0.0 ·
commit=aca2cf68f388090a0efdb92233b854749b4769ec
```

خطوات وظيفة `Deploy nasr-ai-gateway` في ذلك التشغيل (من `/actions/runs/…/jobs`):
`Report the artifact` ✓ · `Diagnose credential availability` ✓ · `Skip gracefully…` ✓ ·
`Resolve the account id…` ✓ · `Install Wrangler…` ✓ · **`Deploy with Wrangler (this Worker only)` ✓** ·
**`Smoke-test the live endpoint` ✓** · **`MCP handshake against the live endpoint` ✓** ·
وخاتمته `success` على الرأس `aca2cf6` = رأس الفرع المدفوع.

**عطل قناة اكتُشف هنا (ولهذا يوجد سطر الوقائع):** بعد التشغيل الناجح الأول قُرئ
`check-runs/117210151244` فرجع `output.summary` **فارغًا (طوله 0)** رغم أن الخطوة كتبت في
`$GITHUB_STEP_SUMMARY` فعلًا — أي أن ملخّصات الخطوات تُعرض في الواجهة فقط ولا تُكشف عبر
REST API. ومع سجلات الخطوات غير المقروءة في هذا المستودع (EOF من blob storage) لم تبقَ
قناة مقروءة برمجيًا إلا **annotations**. لذلك صارت الوقائع تُكتب في `::notice` بسطر واحد
قابل للتحليل ومربوط بـ`commit`، ومنها يقرأ `--flip --ci-run` دليله.

### 14.2 قراءات حيّة من البوابة نفسها (جلب مباشر)

`GET https://nasr-ai-gateway.footcai-555.workers.dev/health` — كما رجع حرفيًا:

```json
{
  "status": "ok",
  "release": "v1.0.0",
  "properties": 102,
  "feed_generated_at": "2026-10-16T23:24:25+03:00",
  "feed_url": "https://nasr-realestate.github.io/ai-feed.json",
  "checked_at": "2026-10-16T21:44:43.830Z",
  "read_only": true
}
```

أي: `status: ok` ✓ · `properties: 102` ✓ (= كتالوج `_properties`) · `read_only: true` ✓.

`GET /` (بطاقة الخدمة) — القيم المقاسة: `service: semsar-talabk` · `release: v1.0.0` ·
`status: running` · `protocol: model-context-protocol 2025-06-18 · streamable-http · /mcp` ·
`read_only: true` · `requires_secrets: false` · **5 أدوات** (`search_properties` ·
`get_property` · `market_summary` · `list_zones` · `get_contact`) مطابقة تمامًا للبطاقة
المستودعية · **4 موارد** (`semsar://catalog` · `semsar://llms-full` · `semsar://contact` ·
`semsar://stats`) · **برومبت واحد** (`recommend_units`) · `contact.broker: طارق طنطاوي`.

حدود هذه البيئة (موثّقة لا مُجمَّلة): لا مخرج إلى `*.workers.dev` من بيئة التنفيذ —
القياس المباشر أعلاه جرى عبر أداة الجلب، أمّا مراحل `POST /mcp` (initialize ·
tools/call · resources/read) فلا تُقاس من هنا إطلاقًا (`ECONNRESET`، وست محاولات كلها
`UNREACHABLE`)؛ دليلها هو مصافحة CI في §14.1، وهي التي أجرت الفاحص نفسه على الشبكة.

### 14.3 ما تعذّرت قراءته (بلا تجميل)

* **اسم السرّ الموجود**: `gh secret list` ⇒ 403؛ وتشخيص الأسماء (`ARENA_CLOUDFLARE_TOKEN=yes/no`)
  يُطبع في stdout (سجلات غير مقروءة: EOF) وفي ملخّص الخطوات (غير مكشوف برمجيًا: §14.1).
  المثبت فقط أن `has_token=true` لأن خطوة النشر **اشتغلت ولم تُتخطَّ**، وأن العامل
  `nasr-ai-gateway` صار يردّ. لا يُدّعى هنا اسم سرّ بعينه.
* **`POST /mcp` محليًا**: مستحيل من هذه البيئة (لا مخرج) — انظر §14.2.

### 14.4 التبديل إلى `live` وما غيّره فعلًا

الأمر: `node _diag/verify-mcp-gateway.mjs --flip --ci-run 38972182779` ⇒ exit 0، بعد أن
قبل الدليل (`✅ دليل CI مقبول: تشغيل 38972182779 · aca2cf6 · خطوات النشر والدخان
والمصافحة كلها success`).

* `scripts/lib/ai-docs.mjs`: `status: 'live'` · `verified_at: '2026-10-16'` · `note` جديدة
  (بلا ادّعاء «لم تُضَف الأسرار بعد») + سطر توثيقي داخل تعليق المصدر يحمل دليل التبديل
  (رقم التشغيل والرأس وسطر الوقائع).
* أعيد التوليد بالأمر الوحيد المسموح: `node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json`.
* انعكس على: `mcp.json` · `.well-known/mcp.json` · `.well-known/mcp/server-card.json`
  (`availability.status: live`) · `ai.txt` · `.well-known/ai.txt` (`AI-MCP-Status: live`) ·
  `api/index.json` (`mcp.status: live`).
* وصُلحت الادّعاءات المكتوبة يدويًا حتى لا يبقى تناقض: `llms.txt` (موضعان) و`humans.txt`
  (كانا يقولان «لم يُفعَّل بعد» / «قيد التفعيل» / «pending deployment»).
* **9 ملفات فقط تغيّرت تغيّرًا حقيقيًا.** أمّا الـ104 الباقية التي لمسها التوليد
  (`api/properties/*.json` و`api/properties.json` و`search-data.json`) فكان تغيّرها
  `generated_at`/`updated_at` **فقط** (سطر واحد لكل ملف)، فأُعيدت إلى أصلها
  (`git checkout --`) إبقاءً على فرق PR مقروءًا — وحرس الانحراف يتسامح مع الطوابع
  بالتطبيع، وقد أُعيد تشغيله بعد الإرجاع فبقي أخضر.

الفحوص بعد التبديل (كلها مقاسة):

| الفحص | النتيجة |
|---|---|
| `scripts/check-ai-artifacts-in-sync.mjs` | ✅ **214 ملفًا** مطابق لمخرجات المولّد |
| الحزمة الكاملة مع `--test-skip-pattern` | ✅ **282/282** · fail 0 · skipped 0 (النمطان المعروفان لم يعودا موجودين، فالقفز لم يلزم) · ~4.0s |
| `_worker/tests/ai-artifacts.test.mjs` + `mcp-gateway.test.mjs` داخل التبديل | ✅ نجحا كجزء من حرس `--flip` |
| `npx eslint --no-ignore --no-warn-ignored _diag/verify-mcp-gateway.mjs` | ✅ **0 مخالفات** |
| `npx eslint … scripts/lib/ai-docs.mjs` | 5 مخالفات **سابقة للتغيير**: نفس الخمس على `origin/master` (سطور 67/72/106/140/245 ⇒ صارت 68/73/107/141/246 بإزاحة سطر التعليق المضاف). أي أن التبديل لم يُدخل مخالفة واحدة، وهي من الفئات التي يوثّق `eslint.config.mjs` أنها «روائح لا تُسقط بوابة الجودة الحالية» (تعقيد إدراكي وقوالب متداخلة) |

حالات الرفض الثلاث التي قِيست على الفاحص قبل استعماله (ولم يُمَس فيها أي ملف):

| الحالة | النتيجة |
|---|---|
| `--flip` مباشرًا من هذه البيئة | رفض: 6 محاولات كلها `UNREACHABLE (ECONNRESET)` ⇒ exit 2 |
| `--flip --ci-run 38959048723` (التشغيل الأخضر القديم) | رفض: «الخطوة «Deploy with Wrangler» تخطّت (skipped) — أي أن النشر لم يحدث أصلًا» |
| `--flip --ci-run 38971312205` (annotation بصيغة قديمة) | رفض مع جمع كل المشاكل: `verdict=undefined لا pass · عدد الوحدات (undefined) ≠ 102 · read_only=undefined · حالة الصحة=undefined` |
| `--flip --ci-run 1` (تشغيل غير موجود) | رفض: `direct: UNABLE_TO_VERIFY_LEAF_SIGNATURE · system-ca: HTTP 404` |

### 14.5 فحص الموقع الحيّ بعد النشر من master

`availability.status = live` لا يظهر على الموقع إلا بعد بناء Pages من **master**
(`build_type=legacy`)، أي بعد الدمج — لذلك لم يُكتب هنا كقيمة مقاسة. يُفحص بعد الدمج بـ:
`https://nasr-realestate.github.io/mcp.json?1` (كاش Pages ~10 دقائق) والمتوقَّع
`availability.status: live` و`verified_at: 2026-10-16`، و`AI-MCP-Status: live` في `/ai.txt`،
و`mcp.status: live` في `/api/index.json`.

### 14.6 ملاحظات متابعة (لا تعطّل الإعلان)

* البطاقة المستودعية تُعلن **3** موارد بينما البوابة الحيّة تخدم **4** (`semsar://stats`
  زائدة حيّة). الفاحص يتعامل مع البطاقة كمجموعة جزئية (يُبلّغ الزيادة ولا يُفشلها) —
  والأصح إضافة `semsar://stats` إلى `renderMcpCard` في دورة تالية، لأن العقد الموجَّه
  للنماذج يبقى ناقصًا موردًا موجودًا فعلًا.
* `recommend_units` برومبت لا أداة، وغيابه عن `tools` في البطاقة صحيح (وتؤكده الاختبارات:
  `tools/list` = خمس أدوات بالضبط).
* دليل التبديل مربوط بـannotation؛ لو كشفت GitHub ملخّصات الخطوات برمجيًا يومًا، يمكن
  إعادة ربطه بنسخة التقرير الكاملة (الوسم `<!-- mcp-handshake-transcript -->` ما زال
  يُكتب في الملخّص لقارئ الواجهة البشرية).
