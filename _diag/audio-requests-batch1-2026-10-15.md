# الدفعة الأولى — إعلانات صوتية للطلبات — 2026-10-15

**النطاق الفعلي: طلب واحد (بدلاً من عشرة)، بناءً على اختيار صاحب الطلب بعد الجرد.** يوجد في `_requests/` ثلاثة ملفات Markdown فقط وملف `.gitkeep`؛ لا يوجد طلب سابق بحقل `audio_ad: true`، ولا تقرير سابق `_diag/audio-requests-batch*.md`. لم تُنشأ طلبات أو ميزانيات أو مساحات جديدة. **الإجمالي بعد النشر: 26 عقاراً صوتياً سابقاً + طلب صوتي واحد.**

## 1. الجرد والمستثنيات

| الطلب | تاريخ `date` في front matter | القرار | السبب |
|---|---|---|---|
| `shop-rent-request-beauty-center-nasr-city` | 2026-10-09 | مؤهل؛ طلب محل للإيجار | النوع في `title`، المساحة **60 إلى 80 متر** في `meta_description`، الموقع في `location`، الميزانية **15,000 إلى 20,000 ج.م شهرياً** في `budget`؛ جميعها موثقة في front matter. |
| `apartment-rent-request-art-studio-large-reception-nasr-city` | 2026-10-10 | مستثنى؛ **لم يُمسّ** | `budget` يقول «ميزانية مرنة» بلا مبلغ محدد؛ 70 متراً هي حد أدنى للريسبشن لا المساحة الإجمالية للشقة. SHA-256 للمصدر: `dec0f7ab05797d413ca35f2d702414f189fcda4f879d1c8e82bddd8da6e7261e`. |
| `garage-rent-request-40-buses-ismail-qabbani` | 2026-10-11 | مستثنى؛ **لم يُمسّ** | سعة 40 باص ليست مساحة بالمتر المربع؛ لا توجد مساحة محددة. SHA-256 للمصدر: `a187978538248425d46c941565e533a45aa28ebb69f7558c1da138c692cf9ed4`. |

**تدقيق مصدر كل رقم في النص:** «ستين لتمانين متر» ↔ `meta_description: 60 إلى 80 متر`؛ «خمستاشر لعشرين ألف جنيه في الشهر» ↔ `budget: 15,000 إلى 20,000 ج.م شهرياً`. «محل للإيجار / بيوتي سنتر» ↔ `title`؛ «مدينة نصر / شارع النزهة / المربع الذهبي» ↔ `location`. لا ميزات غير مثبتة، ولا وعد توافر أو تمويل أو عائد. تاريخ النشر من front matter، لا من Git.

## 2. الإعلان والرابط

| الطلب | صفحة الإنتاج بعد النشر | ملف MP3 بعد النشر | المدة الحقيقية / الوسم | البايتات | SHA-256 |
|---|---|---|---|---:|---|
| محل بيوتي سنتر للإيجار | [صفحة الطلب](https://nasr-realestate.github.io/requests/shop-rent-request-beauty-center-nasr-city/) | [استمع](https://nasr-realestate.github.io/assets/audio/requests/shop-rent-request-beauty-center-nasr-city.mp3) | 16.368 ثانية / «17 ثانية» (تقريب لأعلى) | 67,484 | `7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b` |

**النص حرفياً (`audio_script` وID3 `COMM`):**

> فرصة لو عندك محل يناسب بيوتي سنتر! مطلوب محل للإيجار في مدينة نصر، شارع النزهة أو المربع الذهبي. المساحة من ستين لتمانين متر مربع، والميزانية من خمستاشر لعشرين ألف جنيه في الشهر. تواصل مع سمسار طلبك على واتساب لعرض خيارات.

توليد Arena `add_voice` ثم `generate_speech` باللغة `ar-EG`، صوت ذكوري اختاره المستخدم من عيّنة audition. لا MAGNeT ولا مفاتيح API ولا خدمات مدفوعة. التحويل المحلي بـ FFmpeg إلى MP3 ثابت **32 kbps، 24 kHz، mono**. وسوم **ID3v2.3** مرتبة `TIT2 TPE1 TALB TDRC TCON TSSE COMM`، كلها UTF-16 (encoding=1). `TPE1=سمسار طلبك — طارق طنطاوي`، `TALB=إعلانات سمسار طلبك`، `TDRC=2026-10-15`، `TCON=إعلان عقاري`، `TSSE=Lavf59.27.100`، `COMM` بلغته `ara` ووصف فارغ والنص مطابق حرفياً.

## 3. الاختبارات (بوابة ما قبل الدمج)

| الفحص | حالة التحقق المحلي | حالة Jekyll/CI |
|---|---|---|
| A — الصفحات الثلاث وMP3 وID3 والـSHA ووسم المدة وعدم تسرب المشغل | `_diag/check-audio-requests.mjs` ناجح على HTML ناتج خادم المعاينة، 1 مشغّل و2 بلا مشغّل؛ بصمات ملفّي الطلب المستثنيين محفوظة. | **بانتظار PR**: البناء الفعلي `bundle exec jekyll build` ثم نفس الفحص، مع `_diag/check-audio-batch3.mjs` للـ101 عقاراً (26 إعلاناً مقفلاً ببصمات SHA-256 و75 بلا مشغّل). |
| B — Chromium | Chromium 153 على 1440×900 و390×844 (لمس): تشغيل/إيقاف، تقديم RTL بالنقر واللمس إلى ~80%، موضع قبل `.rq-actions`، بلا autoplay أو overflow أو استثناءات JS. كلا الطلبين الآخرين بلا مشغّل، ومشغّل العقار السابق موجود. | — |
| C — HTTP/FFmpeg | GET MP3 `200 audio/mpeg`، و`Range: bytes=0-1023` ← `206` (خادم المعاينة)؛ FFmpeg فك بلا أخطاء، 16.368 ثانية، ذروة **−1.6 dB** (<0 dB). | فحص HTTP **الإنتاجي** بعد النشر عبر job يدوي للقراءة فقط (لا نشر). |
| D — مطابقة الوقائع | النوع/المساحة/الموقع/الميزانية روجعت مع حقول front matter أعلاه؛ بقية بيانات الطلب الأصلية ثابتة SHA-256 `3aec7689aa139d68be565b7420db81df62e9383361ca40595c96b56e38e7c3a9` عند حذف حقول الصوت الأربعة. | — |
| E — الموقع كامل | `npm run lint` ناجح؛ Worker **219/219** في المجموعة الحاجزة؛ المجموعة الخام 221 اختباراً: 219 ناجحاً والإخفاقان القديمان فقط (T1.5 / stored sessions). `git diff --check` ناجح. | **بانتظار PR**: Jekyll property gate + request gate + Worker + SonarCloud (0 issues، duplication ≤3%). |

المشغّل في `_includes/request-audio.html` نسخة من تصميم/منطق مشغّل العقارات مع CSS محصور بـ `.rq-audio`، تسميات «الطلب»، وتتبع `request_audio_play`؛ `preload="none"` وبدون autoplay. استدعاؤه **سطر شرطي واحد** في `_layouts/request_page.html` قبل أزرار الإجراءات، دون مساس بـ `_includes/property-audio.html` أو قالب العقارات أو CSS العام.

## 4. الملفات

- أُنشئت: `assets/audio/requests/shop-rent-request-beauty-center-nasr-city.mp3`، `_includes/request-audio.html`، `_diag/audio-check-utils.mjs`، `_diag/check-audio-requests.mjs`، `_diag/check-audio-production.mjs`، هذا التقرير.
- عُدلت: `_requests/2026-10-09-shop-rent-request-beauty-center-nasr-city.md` (**4 حقول صوت فقط**)؛ `_layouts/request_page.html` (**سطر شرطي واحد**)، `_diag/check-audio-batch3.mjs` (إعادة استخدام محلّل ID3 في الوحدة المشتركة، مع الحفاظ على بصمات الـ26 القديمة)، `.github/workflows/verify-audio-pages.yml` (**فحص فقط** في PR + HTTP على الإنتاج بعد النشر، بلا صلاحيات نشر).
- لم تُعدَّل: الطلبان المستثنيان، الـ26 ملف MP3 السابقة، `_includes/property-audio.html`، `_layouts/property_page.html`، Worker/D1/KV/Web Push/الوكيل، أسرار وإعدادات النشر و`deploy.yml`، SEO والروابط العامة.

**بوابة القرار:** لا دمج ولا نشر إلا بعد نجاح الفحص الحقيقي في CI وفحص SonarCloud. فحص الإنتاج يُنفّذ بعد نجاح workflow النشر ويُسجّل في التسليم النهائي.
