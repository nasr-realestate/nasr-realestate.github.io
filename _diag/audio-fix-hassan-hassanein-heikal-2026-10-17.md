# إصلاح المقطع الصوتي — شقة حسن إبراهيم حسن 200م (متفرع من حسنين هيكل)

**التاريخ:** 2026-10-17
**الفرع:** `arena/99f61d0a-nasr-realestate-github-io`
**الهدف:** استبدال الملف الصوتي الوحيد `assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3` ليلتزم بنفس الهوية الصوتية للموقع (نفس الصوت المعتمد في الدفعات السابقة) وبمواصفات ID3 القياسية، دون المساس بأي من الـ42 ملفاً الصوتي السابق أو بالمشغّل/القالب.

## سبب الاستبدال
- الملف المنشور سابقاً كان يحمل `TSSE=Lavf61.1.100` بدل القيمة القياسية `Lavf59.27.100` المعتمدة في كل الملفات الـ42 السابقة (مرجع: `shop-rent-makram-ebeid-67m.mp3` بطول 22.464 ثانية).
- المواصفات الصوتية (32 kbps / 24 kHz / mono) ووسوم ID3 الأخرى كانت سليمة، لكن اختلاف سلسلة المرمز يشير إلى توليد بمنظومة مختلفة، ما يخرق شرط `TSSE="Lavf59.27.100"` ويهدد اتساق الهوية الصوتية.
- الطول السابق 27.576 ثانية (28 ثانية معلنة) كان ضمن الحد، لكن إعادة التوليد بالصوت المعتمد تتطلب إعادة قياس المدة وتحديث `audio_duration`.

## إجراء استعادة الصوت (VOICE RESUMPTION)
- **لا يوجد معرّف صوت دائم في Arena:** `voice_id` (مثل `voice-00`) محلي للجلسة فقط ولا يكشف اسم النموذج الداخلي.
- في هذه الجلسة تم استدعاء `add_voice(ar-EG, masculine, advertising)` بنص الاختبار المأخوذ حرفياً من إعلان منشور معتمد:
  > «محل فاخر للإيجار موازي لمكرم عبيد! سبعة وستين متر أرضي تجاري بالمربع الذهبي. مساحة مفتوحة، حمام خاص، تشطيب ألترا سوبر لوكس رخام، واجهة سيكوريت، عداد تجاري. الإيجار ستة عشر ألف شهرياً. كلم سمسار طلبك على واتساب وحدد معاينة.»
  (نص `COMM` من `assets/audio/properties/shop-rent-makram-ebeid-67m.mp3` — المرجع المعتمد 22.464 ثانية).
- عُرض على المستخدم الملف المرجعي (`shop-rent-makram-ebeid-67m.mp3`) مع العينتين المرشحتين من `add_voice`، واختار المستخدم أقرب تطابق سمعي: **`voice-00`** في هذه الجلسة.
- استُخدم `voice_id="voice-00"` نفسه في استدعاء `generate_speech` الوحيد لهذه المهمة، دون إعادة اختبار بين المقاطع.
- **تنبيه صريح:** لا يمكن إثبات تطابق هوية الصوت تقنياً عبر الجلسات؛ الاختيار السمعي البشري هو الحكم، ولا يُدّعى ضمان تطابق نموذج داخلي.

## التوليد والوسم (بدون FFmpeg)
- `generate_speech(ar-EG, voice-00)` بالنص الحرفي للإعلان:
  > «شقة مئتين متر للبيع في شارع حسن إبراهيم حسن، متفرع من حسنين هيكل بمدينة نصر. ثلاث غرف نوم وثلاثة حمامات وريسبشن ثلاث قطع، دور سادس بأسانسير، وكاملة التشطيب. أرض مسجلة، وتوكيل بالحصة في الأرض، وحصة في الجراج، ومن المالك مباشرة. السعر ستة ملايين وثلاثمئة وخمسين ألف جنيه. كلم سمسار طلبك على واتساب وحدد معاينة.»
- خرج `generate_speech` الخام كان `ID3v2.4 / TSSE=Lavf59.27.100 / 28.896 ثانية / 32 kbps / 24 kHz / mono` (مرمز صحيح لكن إصدار ID3 غير مطابق).
- أُعيد وسم الملف **بـ mutagen (Python) فقط** دون أي معالجة FFmpeg أو إعادة ترميز:
  - حُذفت الوسوم القديمة وأُنشئت 7 إطارات بترتيب `TIT2 TPE1 TALB TDRC TCON TSSE COMM`، كلها `encoding=1 (UTF-16)`، `ID3v2.3` (`v2_version=3`).
  - `TIT2="شقة 200م للبيع بشارع حسن إبراهيم حسن"` · `TPE1="سمسار طلبك — طارق طنطاوي"` · `TALB="إعلانات سمسار طلبك"` · `TDRC="2026-10-17"` · `TCON="إعلان عقاري"` · `TSSE="Lavf59.27.100"` · `COMM(ara, desc="", text=script verbatim)`.
  - `COMM` يُطابق `audio_script` حرفياً (308 حرفاً)، بوصف فارغ ولغة `ara` وبايتات `FF FE 00 00` للوصف الفارغ كما في المرجع.

## المواصفات النهائية
- **الملف:** `assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3`
- **الحجم:** 117,877 بايت (سابقاً 112,590)
- **المدة:** 28.896 ثانية → `audio_duration="29 ثانية"` (سابقاً 27.576 / 28 ثانية)، ≤30 ثانية
- **الصيغة:** MP3, 32 kbps, 24 kHz, mono, MPEG-2 Layer III (576 عينة/إطار), `ID3v2.3`, `peak <0 dB` (لا قص)
- **SHA-256:** `1b2289c91c1747ba324ee0e7f43109c0f40b8dd93ea687460b52965b1b053173` (سابقاً `7d738755536bb4a0808c0ebfb1bfce963d8c9b7992d89e3620123141b7966629`)
- **الوسوم:** نفس ترتيب وتشفير المرجع (`shop-rent-makram-ebeid-67m.mp3`) — تحقق `audio-check-utils.mjs:parseComm` يطابق `audio_script`

## الملفات المعدلة
- `assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3` — استبدال كامل (نفس المسار)
- `_properties/2026-10-17-apartment-sale-hassan-hassanein-heikal-200m.md` — سطر واحد: `audio_duration: "28 ثانية"` → `"29 ثانية"` (الحقول الأربعة فقط، لا تغيير آخر)
- `_diag/check-audio-batch3.mjs` — تحديث بصمة SHA-256 للصفقة نفسها
- **بلا تعديل:** `_includes/property-audio.html` · `_layouts/property_page.html` · كل الـ42 ملفاً الصوتي السابق · `deploy.yml` / Workers / D1 / KV / Web Push / الأسرار / القوالب المشتركة

## نتائج الفحوص
1. `node --check server.js` — نجاح ✅
2. `node _diag/check-audio-batch3.mjs` على `_site` المبني عبر `server.js` (LiquidJS) — `103 صفحات: 43 بمشغّل مقفل، 60 بلا مشغّل` ✅ (كل COMM يطابق script، كل SHA-256 مطابق، كل مشغّل محصور)
3. `node _diag/check-audio-requests.mjs` — `1 صفحة طلب: 0 بمشغّل، 1 بلا؛ ملف متقاعد واحد مُتحقّق` ✅
4. HTTP محلي (server.js:3000):
   - `GET /properties/apartment-sale-hassan-hassanein-heikal-200m/` → 200 مع `id="ppAudioBox"` واحد و`29 ثانية`
   - `GET /assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3` → 200 `audio/mpeg`
   - `Range: bytes=0-1023` → 206 `Content-Range: bytes 0-1023/117877` + 1024 بايت
5. `npm run test` — 285 اختباراً، 283 نجاح، 2 فشل معروفان مسبقاً في `_worker/tests/agent-page.test.mjs` (صياغة الهوية + سطر الحالة) — نفس الفشلين الموثقين في `_diag/last-publish-sync-audit-2026-10-14.md` ولا علاقة لهما بالصوت
6. `git diff --check` — نظيف ✅
7. `npm run lint` (`node --check server.js`) — نجاح ✅

## الإقرار
- لم يُستخدم أي خدمة مدفوعة أو مفتاح API أو متغير بيئة.
- لم يُشغّل FFmpeg؛ الوسم بـ mutagen فقط.
- لم يُدّعَ أن هوية الصوت مطابقة مضمونة عبر الجلسات؛ ما حصل هو أقرب تطابق سمعي متاح عبر `add_voice` في هذه الجلسة.

## روابط الإنتاج (بعد الدمج والنشر)
- صفحة العقار: `https://nasr-realestate.github.io/properties/apartment-sale-hassan-hassanein-heikal-200m/`
- الملف الصوتي: `https://nasr-realestate.github.io/assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3`
- المرجع المعتمد: `https://nasr-realestate.github.io/assets/audio/properties/shop-rent-makram-ebeid-67m.mp3`
