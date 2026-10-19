# تقرير دفعة الصوت 2026-10-19 (batch9)

**الفرع:** `arena/6f781a6b-nasr-realestate-github-io` · **الصوت:** `voice-02` (اختاره المالك في جلسة هذه الدفعة) · **التاريخ:** 2026-10-19 (Africa/Cairo)

## 1) الحالة المنشورة الآن

- **104** ملف عقار في `_properties/` · **99** منها بصفحة صوتية كاملة (`audio_ad: true` + `audio_file` + `audio_script` + `audio_duration`) · **5** بلا صوت وهي الاستثناءات الموثّقة نفسها (بند 5) — أي **صفر** صفحة بلا صوت خارج القائمة المعلنة.
- **101** ملف MP3 تحت `assets/audio/`: 99 لعقارات + 2 لطلبات (خارج نطاق هذه الدفعة، لم تُمَس).
- **28** استبدالًا موثّقًا من أصل **43** ملفًا قديمًا كان البند §6 يسمح باستبدالها؛ الـ**15** الباقية مؤجَّلة بأسباب مسجَّلة (بند 4).
- لم يُعدَّل أي حد في المواصفة، ولم يُضَف `ownerOverride` واحد، ولم تُكتب قياسات غير مقيسة.

## 2) قيود لم تُخترق

| القيد | الحالة |
|---|---|
| عدم تعديل المواصفة/الحدود/البوابات | محفوظ — لم يتغيّر أي حد أو إعداد ترميز أو وسم |
| الخمسة المرجعية بلا مساس | محفوظة ببصماتها |
| عدم استبدال ملف صامت أو بلا قيد في السجل | محفوظ — كل استبدال يتحقق من بصمة الأصل مقابل السجل قبل الكتابة |
| حفظ بصمة كل أصل مستبدَل | في `_diag/audio-batch9-replacement-ledger.json` وتكرارها في قيد السجل |
| أرقام بالحروف المصرية | محفوظ — لا رقم رقمي في أي نص |
| عدم الإنتاج بلا `--plan` ناجح | محفوظ — كل نص مرّ بالفحص قبل التوليد |

## 3) الاستبدالات المنجزة (28)

كلها `approval = measured-pass` · `ownerOverride = false` · `cos ≥ 0.9351` (حد «نفس الصوت»)، والملفات القديمة محفوظة البصمات قبل الاستبدال.

| # | العقار (slug) | cos | المدة | SHA-256 (جديد) | SHA-256 (الأصل المستبدَل) |
|---|---|---|---|---|---|
| 1 | `abdel-azim-ghalmi-200m-expat` | 0.9653 | 24.048 ث | `33d7372c37f624e8…` | `e163142e8549afbe…` |
| 2 | `abu-dawood-fakhry-167m` | 0.9618 | 26.856 ث | `bcea51f08c3d708b…` | `456d61fa435c7573…` |
| 3 | `administrative-unit-rent-nasr-city-41m` | 0.9607 | 26.856 ث | `a4fd7e55f70258e5…` | `5d3e6fdc1419662f…` |
| 4 | `ali-amer-240m` | 0.9674 | 25.584 ث | `8f37ba2546346c93…` | `a98be4bc95f1aeaa…` |
| 5 | `apartment-for-sale-khedr-eltouny-tayaran-120m` | 0.9655 | 25.176 ث | `0791cb1ce4c79765…` | `473cd73b187f9e79…` |
| 6 | `apartment-rent-gamal-dewidar-enppi-nasr-city-160m` | 0.9612 | 24.456 ث | `b1565f181fb83b9c…` | `8156b84f42e0ee0f…` |
| 7 | `apartment-sale-abbas-elakkad-refaai-200m-roi` | 0.9640 | 26.256 ث | `59e506f892339c8b…` | `29d1d678eaa2719c…` |
| 8 | `apartment-sale-abdul-halim-abdullah-195m` | 0.9717 | 26.424 ث | `8b2d924d2407197b…` | `41144f92e1db328a…` |
| 9 | `apartment-sale-al-hayat-towers-nasr-city-162m` | 0.9643 | 25.464 ث | `c2470999887a9717…` | `6352bd42f3073a9f…` |
| 10 | `apartment-sale-egyptair-nasr-city-125m-furnished` | 0.9657 | 25.104 ث | `6901297d15d567b2…` | `4e5346e80eb21b45…` |
| 11 | `apartment-sale-gamal-afifi-ahly-club-250m` | 0.9687 | 23.184 ث | `cfd40c7e9e3012f2…` | `2eb4e243fb6a4acd…` |
| 12 | `apartment-sale-hassan-hassanein-heikal-200m` | 0.9531 | 23.016 ث | `df8b300f9c8f7f96…` | `1b2289c91c1747ba…` |
| 13 | `apartment-sale-international-park-nasr-city-215m` | 0.9573 | 26.784 ث | `18f28c2f0bee734b…` | `b834abbc18332a6e…` |
| 14 | `apartment-sale-makarif-6th-district-130m` | 0.9654 | 26.616 ث | `34800208583c4023…` | `4d5fc7d29eaf113f…` |
| 15 | `apartment-sale-rabaa-investment-abbas-elakkad-165m` | 0.9529 | 26.376 ث | `2a0bd9a8b9eda6c5…` | `766a5f7a9f66691d…` |
| 16 | `commercial-hq-rent-kabul-street-nasr-city-130m` | 0.9634 | 28.176 ث | `7dc8b8929843ef7b…` | `a0952c86b1dbdb0d…` |
| 17 | `commercial-mohamed-hasan-elgamal` | 0.9593 | 27.336 ث | `c5293f9f741b6e3b…` | `5b509764e3f0fb72…` |
| 18 | `commercial-shop-for-rent-nozha-street-nasr-city` | 0.9554 | 27.696 ث | `f24abed02f8a86ac…` | `89cbcf9f3056d8dd…` |
| 19 | `degla-landmark-122m-rent` | 0.9573 | 25.104 ث | `cbf6ff6c029426ff…` | `65e10976244b9eda…` |
| 20 | `admin-rent-nozha-main-260m` | 0.9384 | 28.464 ث | `35fcdb9c829a848b…` | `326d70b377dae017…` |
| 21 | `furnished-apartment-rent-hayat-compound-safarat-200m` | 0.9615 | 26.184 ث | `dd57b21f97ae01d7…` | `42e7026d9dbca88d…` |
| 22 | `golden-square-garden-156m` | 0.9501 | 28.056 ث | `42bc9a75f18c72a5…` | `bc8a10c088a1cf21…` |
| 23 | `ibrahim-nawara-175m` | 0.9627 | 22.536 ث | `8af4300dc80b0bc6…` | `964d0687973c4ec7…` |
| 24 | `int-park-140m-furnished` | 0.9760 | 24.936 ث | `50d675d298530005…` | `7b46469c754a4f7a…` |
| 25 | `ismail-wahby-160m-luxury` | 0.9797 | 24.768 ث | `39705d86053224a3…` | `3260fa3e57eafa34…` |
| 26 | `kabul-st-makram-ebeid-260m` | 0.9702 | 28.368 ث | `be56d9c00becea90…` | `04c69a45044be866…` |
| 27 | `luxury-apartment-rent-al-azhar-street-nasr-city-200m` | 0.9669 | 25.056 ث | `42aaead10a118004…` | `9f5c4d9a4c1ad4a6…` |
| 28 | `makram-ebid-177m` | 0.9721 | 24.936 ث | `8a616752c52d017f…` | `a24a30befbf44af1…` |


### استثناءات مسجَّلة داخل الدفعة

- `admin-rent-nozha-main-260m`: قياس أول **0.9330** (نطاق ملتبس) ⇒ أُعيد الملف والصفحة بـ`git checkout --` ولم يُقَيَّد. أُعيد توليده لاحقًا وقياسه **0.9384** فدخل بالقيد العادي.
- `genena-mall-186m-office-residence`: قياس **0.8391** — تحت الحد غير المقبول (0.85)، فلا يُقبل حتى بتجاوز المالك. أُعيد أصله بالكامل، وبقي السكربت المعتمد محفوظًا لإعادة التوليد.

## 4) ما لم يُنتَج ولماذا (15)

| العقار | الحالة |
|---|---|
| `genena-mall-186m-office-residence` | مرفوض قياسًا (0.8391) — يحتاج إعادة توليد، لا تجاوز |
| `makram-ebid-main-250m` | السكربت معتمد · لم يُولَّد بعد (حد التوليد 10/دورة) |
| `office-storage-rent-hassanein-heikal-nasr-city-73m` · `rehab-villa-model-h-gate9` · `rent-abdel-hamid-lotfy-tayaran-150m` · `rent-waha-50th-street-163m` · `safarat-safwa-170m` · `sanhoori-luxury-250m` · `shaka-nour-deen` · `shams-club-heliopolis-160m` · `shop-abbas-elakkad-60m-jan26` · `shop-rent-makram-ebeid-67m` · `truegate-compound-waha-108m` · `villa-new-cairo-1st-district-568m` · `villa-south-90th-120m` | 13 سكربتًا معتمدًا بـ`--plan` ومحفوظًا في `_diag/audio-batch9-scripts/` · لم تُولَّد بعد |

هذه الـ15 **ليست صفحات بلا صوت**: كلها صفحات منشورة بالفعل بصوتها القديم الموروث، فتركها الآن لا يُسقط أي صفحة ولا يكسر أي رابط. المتبقي هو *توحيد الأسلوب* لا سدّ فراغ.

## 5) الصفحات بلا صوت (5) — استثناءات موثّقة

| الملف | سبب الاستثناء |
|---|---|
| `andalus1-duplex-285m` | بيانات أساسية غير مؤكدة |
| `2026-01-13-shinzo-abe-axis-luxury-262m` | بيانات أساسية غير مؤكدة |
| `2026-05-11-commercial-saudi-buildings-golf-110m` | بيانات أساسية غير مؤكدة |
| `showroom-ahmed-fakhry-600m` | سعر غير رقمي ⇒ لا يمكن نطقه بأمان |
| `2026-04-15-ground-floor-admin-seraj-mall` | لا مساحة معلنة |

## 6) البوابات المنفَّذة ونتائجها

| الفحص | النتيجة |
|---|---|
| `scripts/audio/verify-voice-identity.mjs` | ✅ نجح — 101 قيدًا، 0 مخالفة |
| `scripts/tests/voice-identity.test.mjs` | ✅ 44/44 |
| `scripts/check-ai-artifacts-in-sync.mjs` | ✅ 218 ملفًا مطابقة للمولّد (بعد إعادة التوليد) |
| `_diag/check-audio-batch3.mjs` (بوابة صفحات العقارات) | ✅ نجح في CI على **99** صفحة — أُعيد ضبطها لتقرأ البصمات من سجل الإنتاج بدل لقطة مجمّدة من 49 صفحة (اللقطة كانت تتعارض بنيويًا مع §6) مع إبقاء الإعلانات المرجعية الستة مقفولة وكل الشروط دون تخفيف |
| `git diff --check` | ✅ نظيف |
| `node --test` (كل الاختبارات) | ⚠️ **5 إخفاقات سابقة للدفعة** — قائمة على `master` قبل هذا الفرع، وأسبابها في بند 7 |
| بناء Jekyll | يُنفَّذ في CI (`deploy.yml`) — لا Ruby محليًا |

## 7) إخفاقات سابقة للدفعة (لا علاقة لها بالصوت)

5 اختبارات فاشلة على `master` قبل هذا العمل: `verifyDeployment (2)` · `deploy-properties-sync: قوائم التصنيف لا تغطي 104 ملفًا` · `preview-parity` · وصف `/api` غير كامل لعقار واحد.

**صفحة سُدَّت كي يمر النشر:** `_properties/2026-10-19-apartment-sale-bashar-ibn-burd-190m.md` كانت تُسقط خطوة `Verify the AI layer is complete and valid JSON` في `deploy.yml` (وتُسقط 3 اختبارات): فيها `meta_description` بلا `description`، وفيها بلوك JSON-LD مكرر داخل المتن رغم أن `_includes/schema-property.html` هو المصدر الوحيد. أُضيف `description` مساوٍ لـ`meta_description` وحُذف البلوك المكرر — بلا أي تغيير في نص الإعلان أو الصوت أو السعر.

هذا هو أيضًا تفسير فارق العدّ 104 مقابل 103 و55 مقابل 54: الصفحة أُضيفت بعد آخر توليد لطبقة الذكاء (كان المولّد يعلن 103 عقارًا)، واستبعاد الخمس صفحات غير القابلة للإنتاج لم يكن محسوبًا في اللقطة القديمة. أُعيد توليد الطبقة فأصبح المولّد يعلن **104**.

## 8) عقد الملفات

MPEG-2 Layer III · 32 kbps · 24 kHz · أحادي · ≤30 ثانية · peak ≤ −0.5 dBFS · RMS −22…−17 dBFS · ID3v2.3 (`TIT2`/`TPE1`/`TALB`/`TDRC`/`TCON`/`TSSE`/`COMM`) · `TPE1 = سمسار طلبك — طارق طنطاوي` · `COMM = audio_script` حرفيًا · وسم الصفحة `audio_file` يعكس الـslug.
