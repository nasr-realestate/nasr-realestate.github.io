# 🔍 تدقيق شامل لصور موقع سمسار طلبك — 2026-10-17

> **المرحلة:** فحص قراءة فقط + خطة معالجة. **لم تُعدَّل أي صورة أو كود بعد.**
> **الفرع:** `arena/82038d17-nasr-realestate-github-io` (لم يُدمج ولم يُنشر شيء).

---

## 1. منهجية الفحص (إثبات فحص الملفات الفعلية)

لم يُعتمد على أسماء الملفات أو قراءة الكود فقط، بل فُحصت **البكسلات الفعلية** لكل صورة:

| الأداة | ما فعلته |
|---|---|
| ImageMagick 6.9.11 (`identify`) | قراءة الأبعاد/الصيغة/عمق الألوان لكل ملف من الـ 131 ملف صورة |
| Pillow + NumPy (تحليل بكسلات) | لكل صورة: **تباين Laplacian** (قياس الحدة)، **طاقة الترددات العالية** (كشف الضبابية)، السطوع، الإنتروبيا، عدد الألوان الفريدة |
| حساب هندسي | نسبة المساحة **المرئية فعليًا** من كل صورة بعد قص `object-fit: cover` في إطار 4:3 (البطاقات) و16:10 (صفحة التفاصيل) |
| مقارنة مرجعية | مطابقة كل `image_file` في 103 ملف عقار + ملف الطلب مع الملفات الموجودة على القرص (صفر صور مكسورة المرجع) |
| أدلة بصرية مولّدة | صور PNG توضح بالأحمر الأجزاء المقصوصة — في `_diag/image-audit-assets/` |

- سكربت الفحص: `_diag/image_audit_scan.py` (قابل لإعادة التشغيل)
- سكربت الأدلة: `_diag/image_audit_evidence.py`
- البيانات الخام: `/tmp/pixel_analysis.json`

---

## 2. الجرد الكامل — 131 ملف صورة (6.7MB منها 5.2MB صور عقارات)

### 2.1 ملخص حسب التصنيف

| التصنيف | العدد | الملاحظات |
|---|---|---|
| صور عقارات (`assets/img/properties/`) | 104 | تُستخدم في البطاقات + صفحات التفاصيل + الوكيل + API |
| صور فريق (`assets/img/team/`) | 5 | أحدها (**sea.webp**) تالف تمامًا |
| صور سوشيال/OG | 9 | 3 منها PNG 1200×630 صحيحة، والباقي غير مرجع |
| أيقونات وPWA | 12 | 5 منها غير مرجعة (~964KB ميتة) |
| شعار (`logo.webp`) | 1 | 1024×1024 يُعرض بحجم 50px |
| أخرى | 2 | `hero-bg.webp` غير مرجع (تدرّج لوني 4.5KB) |

### 2.2 إحصاءات صور العقارات (الأهم)

| المقياس | القيمة |
|---|---|
| نسب العرض/الارتفاع | **62 طولية × 42 عرضية** — توزيع: 24 طولية شديدة (<0.7)، 38 طولية، 3 مربعة، 31 عرضية، 8 عرضية شديدة (>1.5) |
| أقصى نسبة | 0.46 (`duplex-andalus`) ← → 2.22 (`zuhair-sabri`) — **تباين 4.8 ضعف** |
| متوسط ما يظهر من الصورة في البطاقة (4:3) | **67%** فقط |
| متوسط ما يظهر في صفحة التفاصيل (16:10) | **59%** فقط |
| أسوأ حالة | `duplex-andalus.webp`: يظهر **28.8%** في صفحة التفاصيل و**34.6%** في البطاقة |
| الحدة (Laplacian) | الوسيط 184؛ **40 صورة حدة < 100**؛ **12 صورة شديدة الضبابية (2.6–12.8)** |
| الحجم | الوسيط 49KB؛ 8 صور ≥ 80KB (أكبرها `vila-nsftshtib` 113KB)؛ الإجمالي 5.05MB |
| أبعاد صغيرة | 3 صور: `ibrahim-nawara` (398×696)، `duplex-andalus` (590×1280)، `Lavida` (630×500) |

### 2.3 الجرد التفصيلي الكامل

الأبعاد بالبكسل، النسبة = عرض÷ارتفاع، الحجم بالكيلوبايت.

| الملف | الأبعاد | النسبة | الحجم | الصيغة | الاستخدام | ملاحظات الفحص |
|---|---|---|---|---|---|---|
| `assets/img/favicons/apple-touch-icon.png` | 180×180 | 1.00 | 39.0 | png | أيقونات (غير مرجعة) | — |
| `assets/img/favicons/favicon-96x96.png` | 96×96 | 1.00 | 14.9 | png | أيقونات (غير مرجعة) | — |
| `assets/img/favicons/web-app-manifest-192x192.png` | 512×512 | 1.00 | 215.9 | png | أيقونات (غير مرجعة) | 🔴 الاسم يقول 192 لكن المحتوى 512×512 |
| `assets/img/favicons/web-app-manifest-512x512-1.png` | 512×512 | 1.00 | 215.9 | png | أيقونات (غير مرجعة) | — |
| `assets/img/google-local.webp` | 1424×752 | 1.89 | 54.2 | webp | سوشيال/OG | — |
| `assets/img/hero-bg.webp` | 1080×2023 | 0.53 | 4.5 | webp | أخرى (غير مرجعة) | — |
| `assets/img/icon-192.png` | 192×192 | 1.00 | 36.1 | png | أيقونات | — |
| `assets/img/icon-512.png` | 512×512 | 1.00 | 136.1 | png | أيقونات | — |
| `assets/img/icon-maskable-512.png` | 512×512 | 1.00 | 104.6 | png | أيقونات | — |
| `assets/img/logo.webp` | 1024×1024 | 1.00 | 22.6 | webp | شعار | — |
| `assets/img/properties/Abbas-Elakkad-Main-View.webp` | 719×941 | 0.76 | 25.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Abbas-Elakkad-Refaai-View-200m.webp` | 720×953 | 0.76 | 53.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Abbas-Elakkad-Shop-60m.webp` | 719×932 | 0.77 | 57.6 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Abdel-Azim-Ghalmi-200m-Expats.webp` | 1024×1024 | 1.00 | 76.6 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Abdul-Halim-Balcony-View-195m.webp` | 720×532 | 1.35 | 66.9 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Abu-Dawood-Ahmed-Fakhry-View.webp` | 720×1242 | 0.58 | 19.1 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.58 |
| `assets/img/properties/Al-Azhar-Street-Luxury-Rent-200m.webp` | 720×1081 | 0.67 | 15.1 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.67 |
| `assets/img/properties/Al-Hayat-Towers-7th-District-162m.webp` | 1080×1920 | 0.56 | 86.8 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/Al-Rehab-Villa-Model-H-Gate9.webp` | 719×945 | 0.76 | 107.8 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/Apartment-Rent-Waha-50th-Street-163m.webp` | 720×948 | 0.76 | 15.7 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/Commercial-Saudi-Buildings-Golf-110m.webp` | 720×529 | 1.36 | 28.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Duplex-the-Seventh-district-150m².webp` | 1075×1910 | 0.56 | 38.1 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/Egyptair-Bilal-Mosque-Nasr-City-125m.webp` | 720×974 | 0.74 | 28.2 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/El-Shams-Club-Heliopolis-160m.webp` | 720×927 | 0.78 | 59.1 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Gamal-Afifi-Ahly-Club-Nasr-City-250m.webp` | 720×1240 | 0.58 | 19.8 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.58 |
| `assets/img/properties/Gamal-Dewidar-ENPPI-Rent-160m.webp` | 1280×960 | 1.33 | 28.3 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/Ground-Floor-Admin-Seraj-Mall.webp` | 720×1198 | 0.60 | 19.8 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.60 |
| `assets/img/properties/Hassan-Hassanein-Heikal-200m.webp` | 960×1280 | 0.75 | 48.3 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/Hassanein-Heikal-Office-Storage-73m.webp` | 1600×1200 | 1.33 | 43.9 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/Hayat-Compound-Safarat-Furnished-200m.webp` | 720×963 | 0.75 | 28.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Helmy-Abdel-Aaty-Seraj-Garden-View-230m.webp` | 720×540 | 1.33 | 11.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/International-Park-Furnished-140m.webp` | 720×941 | 0.77 | 31.3 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/International-Park-View-215m.webp` | 720×531 | 1.36 | 37.5 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Ismail-Qabbani-Street-Genena-Mall.webp` | 719×1266 | 0.57 | 11.0 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/Ismail-Wahby-Street-9th-District-160m.webp` | 720×955 | 0.75 | 59.3 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Kabul-Commercial-HQ-130m.webp` | 1200×1600 | 0.75 | 84.7 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/Kabul-Street-Makram-Ebeid-260m.webp` | 699×945 | 0.74 | 54.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Khedr-Eltouny-Stadium-120m.webp` | 720×716 | 1.01 | 24.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Lavida-Compound-Pool-View.webp` | 630×500 | 1.26 | 47.8 | webp | بطاقة + تفاصيل عقار | 🟡 أبعاد صغيرة للعرض |
| `assets/img/properties/Luxury-Administrative-Unit-41m.webp` | 961×960 | 1.00 | 93.4 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/Luxury-Shop-Makram-Ebeid-67m.webp` | 720×540 | 1.33 | 51.1 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Makarif-Street-6th-District-130m.webp` | 720×552 | 1.30 | 27.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/New-Cairo-Villa-1st-District-Pool.webp` | 719×547 | 1.31 | 49.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Next-to-al-siraj-mall.webp` | 1065×485 | 2.20 | 45.4 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 2.20 |
| `assets/img/properties/Nozha-Street-Shop-Rent-190m.webp` | 720×540 | 1.33 | 12.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Pharmacy-for-sale.webp` | 1920×1080 | 1.78 | 35.8 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 1.78 |
| `assets/img/properties/Rabaa-Investment-Abbas-Elakkad-165m.webp` | 720×952 | 0.76 | 83.4 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/Shinzo-Abe-Main-View-262m.webp` | 719×953 | 0.75 | 33.4 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/South-90th-St-Villa-Dusit-View.webp` | 719×954 | 0.75 | 84.0 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/True-Gate-Compound-Waha-108m.webp` | 709×496 | 1.43 | 30.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/Unfurnished-Apartment-Rent-Abdel-Hamid-Lotfy-Nasr-City.webp` | 720×1123 | 0.64 | 21.7 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.64 |
| `assets/img/properties/abdul-razzaq-al-sanhuri.webp` | 1080×1881 | 0.57 | 54.9 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/administrative-headquarters-next-enppi.webp` | 1080×799 | 1.35 | 53.1 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/administrator-abdullah-al-arabi.webp` | 1080×490 | 2.20 | 52.5 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 2.20 |
| `assets/img/properties/ahly-club-extension-apartment.webp` | 1080×496 | 2.18 | 43.1 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 2.18 |
| `assets/img/properties/ahmed-kasem-gooda.webp` | 1080×1834 | 0.59 | 47.4 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.59 |
| `assets/img/properties/al-Tayaranstreet.webp` | 1200×1600 | 0.75 | 65.3 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/al-muqrafi-street.webp` | 1055×816 | 1.29 | 74.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/ali-amer.webp` | 1066×815 | 1.31 | 29.2 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/apartment-180m-nasr-city.webp` | 1080×1420 | 0.76 | 81.9 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/apartment-garden-golden-square-nasr-city.webp` | 719×950 | 0.76 | 37.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/bethment-banfseg.webp` | 1080×1432 | 0.75 | 62.8 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/classic-heliopolis-apartment-150m.webp` | 1080×1426 | 0.76 | 28.5 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا |
| `assets/img/properties/commercial-mohamed-hasan-elgamal-main.webp` | 720×1176 | 0.61 | 62.1 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 0.61 |
| `assets/img/properties/duplex-andalus.webp` | 590×1280 | 0.46 | 22.9 | webp | بطاقة + تفاصيل عقار | 🟡 أبعاد صغيرة للعرض، 🟡 نسبة متطرفة 0.46 |
| `assets/img/properties/edari400m.webp` | 1080×795 | 1.36 | 49.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/el-nozha-saudi-apartment-170m.webp` | 1080×1433 | 0.75 | 41.0 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا |
| `assets/img/properties/elhai-elsabe.webp` | 1072×1421 | 0.75 | 79.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/elsfarat-duplex.webp` | 1080×809 | 1.33 | 67.6 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/fouad-nassim-sonesta-nasr-city.webp` | 1080×1429 | 0.76 | 67.5 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/greenhilz.webp` | 1080×1420 | 0.76 | 72.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/hai-elswfarat.webp` | 1078×1915 | 0.56 | 34.6 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/hassan-al-sharif-apartment-150m.webp` | 1080×1898 | 0.57 | 64.6 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/hassan-maamoun-nahas-apartment-175m.webp` | 1080×1423 | 0.76 | 58.1 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/heliopolis-merghany-classic-180m.webp` | 1080×823 | 1.31 | 41.0 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/helmy-hassan-160m.webp` | 1080×1523 | 0.71 | 51.6 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/helmy-hassan-ali-street-220m-nasr-city.webp` | 1077×797 | 1.35 | 61.9 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/ibrahim-nawara-street-nasr-city.webp` | 398×696 | 0.57 | 14.3 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 أبعاد صغيرة للعرض، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/maamar-al-murshidi.webp` | 1080×1428 | 0.76 | 47.1 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/makram-ebid-177m.webp` | 720×1237 | 0.58 | 76.3 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 0.58 |
| `assets/img/properties/makram-obeid-sqlia.webp` | 720×965 | 0.75 | 50.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/mfroosh-tiran.webp` | 1080×1870 | 0.58 | 33.2 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.58 |
| `assets/img/properties/mkram-ebid.webp` | 1080×617 | 1.75 | 43.4 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 1.75 |
| `assets/img/properties/moez-al-Dawla-administrator.webp` | 1080×1427 | 0.76 | 21.1 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا |
| `assets/img/properties/mohiedin.webp` | 1280×720 | 1.78 | 68.6 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 1.78 |
| `assets/img/properties/mustafa-nahas-extension-160m.webp` | 1080×793 | 1.36 | 33.5 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/nasr-st.webp` | 1077×810 | 1.33 | 65.9 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/nasr-street.webp` | 1079×1917 | 0.56 | 26.4 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/new-plus-compound.webp` | 1080×1414 | 0.76 | 73.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/nour-deen-main.webp` | 720×552 | 1.30 | 22.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/nour-mahmoud-st.webp` | 1068×790 | 1.35 | 56.4 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/nozha-main-street-administrative-hq.webp` | 705×553 | 1.27 | 30.8 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/othman-buildings.webp` | 1079×604 | 1.79 | 64.2 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 1.79 |
| `assets/img/properties/raba-nasr.webp` | 1200×1600 | 0.75 | 69.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/rabia-Investment.webp` | 1077×807 | 1.33 | 38.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/region-nine.webp` | 1080×1771 | 0.61 | 67.5 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 0.61 |
| `assets/img/properties/rent-diplomatic-quarter.webp` | 1078×1436 | 0.75 | 32.9 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/rent-furnished-batrawy-nasr-city.webp` | 1080×1429 | 0.76 | 69.7 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/republican-guard.webp` | 1080×1868 | 0.58 | 33.8 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.58 |
| `assets/img/properties/salah-salemal-abour.webp` | 1080×1884 | 0.57 | 36.7 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/sheraton-nozha.webp` | 1079×1438 | 0.75 | 25.6 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا |
| `assets/img/properties/shopp212m.webp` | 1080×855 | 1.26 | 63.0 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/social-requests.webp` | 1264×848 | 1.49 | 48.9 | webp | طلب (غير معروض) | — |
| `assets/img/properties/sun-view.webp` | 1080×1432 | 0.75 | 36.2 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/sunrise.webp` | 1080×800 | 1.35 | 72.5 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/tawfiqal-Bakri-st.webp` | 1080×753 | 1.43 | 17.1 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة |
| `assets/img/properties/tawnit.webp` | 1080×802 | 1.35 | 70.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/the-ninth-district-toukhi.webp` | 1080×1425 | 0.76 | 59.2 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/togari-400m.webp` | 1080×1898 | 0.57 | 56.8 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.57 |
| `assets/img/properties/trade-fair.webp` | 1078×808 | 1.33 | 61.4 | webp | بطاقة + تفاصيل عقار | — |
| `assets/img/properties/vila-nsftshtib.webp` | 1063×1416 | 0.75 | 113.1 | webp | بطاقة + تفاصيل عقار | 🟡 حجم كبير |
| `assets/img/properties/zahraa-thirdfloor.webp` | 1068×1898 | 0.56 | 65.8 | webp | بطاقة + تفاصيل عقار | 🟡 حدة منخفضة، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/zhraa-nasr.webp` | 1080×1944 | 0.56 | 22.6 | webp | بطاقة + تفاصيل عقار | 🔴 ضبابية جدًا، 🟡 نسبة متطرفة 0.56 |
| `assets/img/properties/zuhair-sabri.webp` | 1600×720 | 2.22 | 63.9 | webp | بطاقة + تفاصيل عقار | 🟡 نسبة متطرفة 2.22 |
| `assets/img/social-add-property.png` | 1200×630 | 1.90 | 122.2 | png | سوشيال/OG | 🟡 حجم كبير |
| `assets/img/social-contact.webp` | 1080×726 | 1.49 | 82.2 | webp | سوشيال/OG | 🟡 حجم كبير |
| `assets/img/social-details-default.webp` | 1080×714 | 1.51 | 77.2 | webp | سوشيال/OG | — |
| `assets/img/social-home.png` | 1200×630 | 1.90 | 112.9 | png | سوشيال/OG | 🟡 حجم كبير |
| `assets/img/social-properties.png` | 1200×630 | 1.90 | 107.8 | png | سوشيال/OG | 🟡 حجم كبير |
| `assets/img/social-requests.png` | 1200×630 | 1.90 | 105.2 | png | سوشيال/OG | 🟡 حجم كبير |
| `assets/img/team/alaa.webp` | 500×600 | 0.83 | 4.2 | webp | فريق | 🟡 حدة منخفضة |
| `assets/img/team/mohamed.webp` | 500×600 | 0.83 | 12.5 | webp | فريق | 🟡 حدة منخفضة |
| `assets/img/team/sea.webp` | — | — | 0.0 | webp | فريق | 🔴 **تالف: 1 بايت فقط** |
| `assets/img/team/tareq.webp` | 400×400 | 1.00 | 33.9 | webp | فريق | — |
| `assets/img/team/walid.webp` | 500×600 | 0.83 | 12.5 | webp | فريق | 🟡 حدة منخفضة |


---

## 3. المشكلات المكتشفة (مرتبة حسب الخطورة)

### 🔴 حرجة

**P1 — ملف صورة تالف: `assets/img/team/sea.webp` (1 بايت فقط)**
لا يمكن فتحه إطلاقًا (فشل PIL وImageMagick معًا). غير مرجع في أي صفحة حاليًا، لكنه يقبع في مجلد الفريق وقد يُستخدم مستقبلًا فيعرض صورة مكسورة. لا توجد نسخة أصلية للاستعادة منها داخل المستودع.

**P2 — صفحة تفاصيل العقار تقص أكثر من نصف الصورة**
قالب `property_page.html` يعرض الصورة داخل إطار ثابت `aspect-ratio: 16/10` مع `object-fit: cover`. بما أن 62 صورة عقار طولية (نسبة 0.46–0.77):
- متوسط ما يظهر من الصورة: **59%** — أي أن **41% من الصورة (غالبًا الأدوار العلوية/السفلية للعقار) مخفي**.
- الحالات الأسوأ: `duplex-andalus` 28.8%، `zhraa-nasr` 34.7%، `Al-Hayat-Towers` 35.2%.
- أيضًا سمات `width="1200" height="750"` في الوسم لا تطابق الأبعاد الحقيقية للصور (كلها أصغر من 1200 عرضًا وأغلبها طولية).
- **دليل بصري:** `_diag/image-audit-assets/hayat-towers-detail-16x10.jpg` و `heikal-detail-16x10.png` (الأحمر = المقصوص).

### 🟠 عالية

**P3 — تضارب نسب عرض الصور بين صفحات الموقع نفسه**
- صفحة العقارات `properties.html` (بطاقات `pl-card`): إطار **4:3**.
- الصفحة الرئيسية `index.html` (بطاقات `hp-property-card`): إطار **4:3** ✓ متوافقة.
- لكن CSS قديم موجود: `.card-image { height: 200px }` (نسبة متغيرة حسب عرض البطاقة ~1.4–2.0) مع `width="400" height="200"` — يخص `_includes/property_card.html` الذي **لا يستخدمه أي صفحة** (كود ميت لكنه فخ مستقبلي لو أُعيد استخدامه).

**P4 — الجودة غير الموحدة: 40 صورة حدة منخفضة، منها 12 شديدة الضبابية**
الصور الـ 12 الأسوأ (Laplacian 2.6–12.8 مقابل وسيط 184): `zhraa-nasr` (2.6)، `Ismail-Qabbani-Street-Genena-Mall` (3.0)، `hai-elswfarat` (4.2)، `moez-al-Dawla-administrator` (4.4)، `mfroosh-tiran` (4.5)، `Duplex-the-Seventh-district-150m²` (5.8)، `republican-guard` (6.2)، `sheraton-nozha` (7.4)، `ahmed-kasem-gooda` (7.6)، `Al-Azhar-Street-Luxury-Rent-200m` (8.0)، `abdul-razzaq-al-sanhuri` (10.9)، `el-nozha-saudi-apartment-170m` (12.8).
هذه غالبًا لقطات معاد ضغطها من واتساب — **لا يمكن استرجاع تفاصيل غير موجودة**؛ المعالجة الآلية الوحيدة المفيدة هي تحسين خفيف عند توليد نسخ البطاقات المصغّرة. البديل الحقيقي: صور بديلة من المصدر.
**دليل بصري:** `_diag/image-audit-assets/blurry-samples.jpg`.

**P5 — تحميل النسخ الكاملة في البطاقات (إهدار نقل)**
البطاقات (بعرض CSS حتى ~420px، أي ≤840px حتى في شاشات 2x) تحمّل الصور الأصلية الكاملة حتى 1080×1920 و113KB. متوسط الحجم 49KB لكل بطاقة. توليد نسخة بطاقة 800×600 ستخفض النقل تقديريًا 40–60% في صفحة تعرض 94+ بطاقة.

**P6 — صور OG للعقارات طولية**
`og:image` لصفحات العقارات = الصورة الأصلية الطولية (0.46–0.77). فيسبوك/واتساب/تويتر تقصها إلى ~1.91:1 فتُخفى أجزاء من العقار في المعاينة الاجتماعية. (ملاحظة: `google-local.webp` 1.89 و`socail PNG` 1200×630 = 1.905 ✓ صحيحة.)

### 🟡 متوسطة

**P7 — صور الفريق غير متناسقة:** `tareq` 400×400 (مربع) مقابل `alaa/mohamed/walid` 500×600 (0.833) — تُعرض معًا في صفحة "من نحن" بارتفاعات بصرية مختلفة، إضافة إلى `sea.webp` التالف. `alaa.webp` (4.2KB فقط لـ 500×600) ناعمة/منخفضة الجودة نسبيًا.

**P8 — `logo.webp` بأبعاد 1024×102** يُعرض في النافبار بارتفاع 50px وفي أماكن أخرى 40–70px — أبعاد أكبر من اللازم بـ 20 ضعفًا (الحجم 23KB مقبول لكنه قابل للتحسين لنسخة صغيرة). يُستخدم أيضًا كصورة احتياطية للبطاقات (`onerror`) وهنا يحتاج فعليًا ~512px.

**P9 — `index.html`: وسوم صور البطاقات بلا `width/height`** (بينما `properties.html` فيها 400×300) — CLS محتمل قبل تحميل CSS، وأفضلية مفقودة.

**P10 — 3 صور عقارات بأبعاد صغيرة** (398–630px عرضًا) ستبدو أقل وضوحًا من بقية البطاقات على شاشات 2x.

### 🔵 منخفضة / تنظيفية (كلها غير مرجعة في أي صفحة)

**P11 — ~964KB ملفات ميتة:**
- مجلد `assets/img/favicons/` كاملًا (510KB) — من ضمنه `web-app-manifest-192x192.png` الذي **محتواه فعليًا 512×512** وليس 192 (اسم مضلل)، ونسختان متطابقتان بالبايت (221,099 بايت لكل منهما).
- جذور: `android-chrome-192x192.png`، `android-chrome-512x512.png`، `maskable-512x512.png` (غير مرجعة؛ `manifest.json` يستخدم `assets/img/icon-*`).
- `assets/img/hero-bg.webp` (تدرّج لوني بسيط، 19 لونًا فقط).
- `assets/img/social-contact.webp` و`assets/img/social-details-default.webp` (نسبهما 1.49/1.51 لا تطابق معيار OG أصلًا).

**P12 — `social-requests.webp` موضوع في مجلد صور العقارات** ويُشار إليه في ملف الطلب (`image_file:`) لكن قالب `request_page.html` لا يعرض `image_file` إطلاقًا — أي مرجع بلا أثر بصري.

**P13 — اسم ملف بمحرف خاص:** `Duplex-the-Seventh-district-150m².webp` (محرف ²) — يعمل حاليًا لكنه مصدر ألم مستقبلي مع أدوات النقل/CI.

**P14 — كود ميت:** `_includes/property_card.html` + CSS `.property-card/.card-image` غير مستخدمَين في أي صفحة (البطاقات الفعلية: `pl-card` في properties.html و`hp-property-card` في index.html).

### ✅ ما هو سليم (تأكيدات مهمة)

- **صفر مرجعيات مكسورة**: كل الـ 103 `image_file` في ملفات العقارات موجودة فعليًا على القرص (تحقق آلي بمطابقة القوائم).
- البطاقتان الفعليتان (رئيسية + عقارات) متوافقتان على 4:3 مع `object-fit: cover` وارتفاع موحد للشبكة — لا اختلاف ارتفاعات بطاقات بسبب الصور حاليًا.
- كل صور العقارات WebP أصلًا (صيغة حديثة).
- صور السوشيال الرئيسية PNG 1200×630 مطابقة لمعيار OG.
- الأيقونات المستخدمة فعليًا (favicon 16/32/ico، apple-touch 180، icon-192/512، maskable) كلها مربعة وبأبعاد صحيحة.
- ملف `image_2..image_5` غير مستخدم في أي عقار (لا معارض متعددة حاليًا رغم دعم القالب لها).

---

## 4. الأدلة البصرية (افحصها بنفسك)

| الملف | ماذا يوضح |
|---|---|
| `_diag/image-audit-assets/hayat-towers-card-4x3.jpg` | صورة طولية 1080×1920: 42% فقط يظهر في البطاقة |
| `_diag/image-audit-assets/hayat-towers-detail-16x10.jpg` | نفس الصورة: 35% فقط يظهر في صفحة التفاصيل |
| `_diag/image-audit-assets/heikal-card-4x3.jpg` / `-detail-16x10.png` | حالة 960×1280: 56% / 47% مرئي |
| `_diag/image-audit-assets/zuhair-wide-card-4x3.jpg` / `-detail-16x10.png` | حالة عكسية (صورة عرضية 2.22): القص أفقي |
| `_diag/image-audit-assets/blurry-samples.jpg` | عيّنة الـ 6 صور الأكثر ضبابية |

---

## 5. خطة المعالجة المقترحة (تنفيذ بعد موافقتك)

> **المبدأ الحاكم:** الأصول الأصلية **لا تُمس** — كل المعالجة تُنشئ ملفات جديدة، والأصل يبقى مرجعًا وقابلًا للتراجع الفوري.

### المرحلة A — نسخ بطاقات موحدة 4:3 (معالجة صور حقيقية)
1. توليد `assets/img/properties/cards/<نفس-الاسم>.webp` بدقة **800×600 (4:3)** لكل عقار:
   - قص ذكي: نافذة القص تُختار بموضع **أعلى كثافة تفاصيل (edge-energy)** مع انحياز طفيف لأعلى الصورة (واجهات المباني) — وليس قصًا مركزيًا أعمى. يُسجَّل موضع القص المختار لكل صورة للتدقيق.
   - تصغير بمرشّع Lanczos + تحسين حدة خفيف (unsharp معتدل) لتعويض فقد الحدة عند التصغير.
   - ترميز WebP بجودة ~80 مع فحص أن الحجم الناتج ≤ 60KB.
2. ربط البطاقات بالنسخ الجديدة في: `properties.html`، `index.html`، `property-images.html`، `luxury-gallery.html`، وبطاقات الوكيل في `agent.html` (عرض `imageFile` من API).
3. **التحقق قبل الاعتماد:** مقارنة بكسلية بين كل نسخة جديدة وأصلها (تُفتح، تُقارن الأبعاد والنسبة، فحص بصري لعينة)؛ الأصل لا يُحذف إطلاقًا في هذه المرحلة.

**النتيجة:** بطاقات موحدة النسبة 100% على الهاتف والكمبيوتر، لا فرق ارتفاعات، ونقل أقل بـ 40–60%.

### المرحلة B — إصلاح قص صفحة التفاصيل (P2)
- توليد `_data/image_dims.yml` بأبعاد كل صورة عقار (من الفحص الفعلي أعلاه).
- في `property_page.html`: قراءة الأبعاد وضبط `style="aspect-ratio: W/H"` للإطار + `width/height` صحيحة على الوسم، مع `object-fit: contain` وخلفية داكنة و`max-height: 85vh` كحد أقصى.
- **النتيجة:** الصورة الأصلية تظهر **كاملة بدون قص ولا تشويه** في كل صفحة عقار، مع حجز مساحة صحيح (صفر CLS) وبدون جافاسكربت.

### المرحلة C — الجودة (بدون معالجة جماعية عمياء)
- التحسين الخفيف يُطبق على نسخ البطاقات فقط (المرحلة A) — **لا إعادة ترميز للأصول الأصلية**.
- الصور الـ 12 شديدة الضبابية + الـ 3 صغيرة الأبعاد: تُدرج في قائمة "تحتاج صورًا بديلة من المصدر" وتُترك كما هي (أي معالجة قوية ستضيف ضوضاء لا تفاصيل).

### المرحلة D — صور OG للعقارات (اختياري — يحتاج قرارك)
توليد `assets/img/properties/og/<الاسم>.jpg` بمقاس **1200×630** (قص ذكي من الصورة الأصلية) وضبط `og:image` في صفحات العقارات. يمنع قص فيسبوك/واتساب العشوائي. التكلفة: ~103 ملفات جديدة (~4–6MB إجمالي).

### المرحلة E — إصلاحات مستهدفة
| # | الإجراء |
|---|---|
| 1 | `sea.webp` التالف: **أحتاج منك الصورة الأصلية** (أو نحذفه — لا يمكن إصلاح 1 بايت) |
| 2 | إضافة `width="800" height="600"` لصور البطاقات في `index.html` |
| 3 | نسخة شعار صغيرة `logo-96.webp` للنافبار/القائمة العائمة مع إبقاء `logo.webp` للـ fallback والمانيفست |
| 4 | توحيد صور الفريق إلى 500×600 (0.833): قص `tareq` 400×400 سيُنقص من محتواه — **يفضل صورة أصلية بديلة؛ أو نكتفي بقص contain ذكي** |
| 5 | تنظيف الأيتام (P11) — **لن يُحذف شيء قبل موافقتك الصريحة**؛ البديل الآمن: نقلها لمجلد `_diag/unused-images/` |

### المرحلة F — الاختبار والتحقق النهائي
1. بناء Jekyll محليًا والتحقق من: صفر صور 404 (فحص آلي لكل `src` مقابل الملفات المبنية).
2. تشغيل خادم معاينة وفحص: الرئيسية، العقارات، عينة صفحات تفاصيل (صورة طولية + عرضية + مربعة) على عرض هاتف (375px) وكمبيوتر (1280px).
3. التحقق من تساوي ارتفاعات البطاقات في الشبكة (فحص هندسي لعلب الصور).
4. تأكيد عدم المساس بـ: الوكيل (`agent.html` منطق العمل)، API، Worker/Cloudflare، قاعدة بيانات العقارات (ملفات md لا تُعدّل إطلاقًا في المراحل A–C).

### ما سيُترك دون تغيير (مقصدًا)
- كل الصور الأصلية في `assets/img/properties/` (104 ملف) — تُستخدم في صفحات التفاصيل بكامل جودتها.
- صور السوشيال PNG 1200×630 (صحيحة).
- الأيقونات المستخدمة فعليًا.
- `google-local.webp` (نسبته صحيحة للـ OG).

---

## 6. المخاطر وضمانات الأمان

| الخطر | الضمان |
|---|---|
| كسر صورة مستخدمة | كل التغييرات ملفات **جديدة**؛ الأصول الأصلية لا تُستبدل ولا تُحذف؛ فحص آلي لكل المسارات بعد البناء |
| تراجع جودة | لا إعادة ترميز للأصول؛ الترميز الجديد للبطاقات فقط وبجودة مضبوطة، مع مقارنة قبل/بعد |
| تأثير على الوظائف | لا تعديل على md العقارات (المرحلة A–C) ولا على منطق الوكيل/API/Worker |
| التراجع | حذف مجلد `cards/` وإرجاع سطرين في القوالب يعيد كل شيء كما كان |

---

*أُعد هذا التقرير بفحص فعلي لملفات الصور (بكسل-بكسل) عبر ImageMagick وPillow/NumPy. بانتظار موافقتك على الخطة لبدء التنفيذ، أو تعديلها حسب أولوياتك.*

---

# 🛠️ ملحق التنفيذ — ما نُفّذ فعليًا (2026-10-17)

> نُفّذت المراحل A+B+C+D+E كاملة بعد موافقتك. **كل الأصول الأصلية محفوظة دون أي تعديل** —
> كل المعالجة أنتجت ملفات جديدة، والأيتام نُقلت بأمان (git mv) إلى أرشيف بدل الحذف.

## أ. الملفات الجديدة المُولّدة (معالجة صور حقيقية بالبكسل)

| المجموعة | العدد | المواصفات | الإجمالي |
|---|---|---|---|
| `assets/img/properties/cards/*.webp` | 103 | نسبة 4:3 موحدة، عرض ≤800px (لا تكبير أبدًا)، قص ذكي عند أعلى كثافة حواف مع انحياز طفيف لأعلى + شرط أمان (طاقة النافذة ≥90% من الأمثل)، Lanczos + unsharp خفيف للمصادر الحادة فقط، WebP q58–80 بسقف ≤60KB و ≤90% من حجم الأصل | 3.3MB (كانت الأصول 4.9MB — وفر 32% في البطاقات) |
| `assets/img/properties/og/*.jpg` | 103 | 1200×630 (أو العرض الأصلي إن أصغر — بلا تكبير)، نفس القص الذكي، JPG q52–78 بسقف ≤80KB | 5.2MB |
| `assets/img/logo-120.webp` | 1 | 120×120 من الشعار الأصلي 1024×1024 | 6.1KB (الأصل 22.6KB) |
| `_data/image_dims.yml` | 1 | أبعاد كل صورة أصلية (103 إدخالات) — يغذي صفحة التفاصيل | — |

**منهجية القص الذكي (وليست قصًا مركزيًا أعمى):** لكل صورة تُحسب خريطة طاقة الحواف (مقدار التدرج)،
وتُختبر كل النوافذ الممكنة بنسبة الهدف بخطوة 4px، وتُختار النافذة الأعلى تفاصيل مع تعزيز غاوسي
طفيف (25%) حول 42% من الارتفاع (واجهات المباني عادة أعلى الصورة). شرط الأمان يمنع اختيار نافذة
طاقتها أقل من 90% من الأفضل. المصادر شديدة الضبابية (Laplacian < 15) لا يُطبق عليها unsharp
الحدة لأنه يضخم ضوضاء الضغط؛ وعند تعذر النزول تحت السقف يُطبق تمويه 0.5px لقتل ضوضاء إعادة
الترميز (7 صور فقط).

### جدول المعالجة الكامل (قبل → بعد)

| الملف | الأبعاد الأصلية | KB الأصل | بطاقة (بعديها) | KB | الوفر | OG (بعديها وKB) |
|---|---|---|---|---|---|---|
| **الإجمالي (103 ملفات)** | — | — | **5006** | **3418** | **-32%** | **5364** |
| Abbas-Elakkad-Main-View.webp | 719x941 | 26 | 719x539 | 18 | -30% | 719x377 (25) |
| Abbas-Elakkad-Refaai-View-200m.webp | 720x953 | 53 | 720x540 | 36 | -32% | 720x378 (42) |
| Abbas-Elakkad-Shop-60m.webp | 719x932 | 58 | 719x539 | 40 | -31% | 719x377 (46) |
| Abdel-Azim-Ghalmi-200m-Expats.webp | 1024x1024 | 77 | 800x600 | 57 | -25% | 1024x538 (76) |
| Abdul-Halim-Balcony-View-195m.webp | 720x532 | 67 | 709x532 | 60 | -11% | 720x378 (71) |
| abdul-razzaq-al-sanhuri.webp | 1080x1881 | 55 | 800x600 | 21 | -62% | 1080x567 (46) |
| Abu-Dawood-Ahmed-Fakhry-View.webp | 720x1242 | 19 | 720x540 | 12 | -36% | 720x378 (21) |
| administrative-headquarters-next-enppi.webp | 1080x799 | 53 | 800x600 | 44 | -18% | 1080x567 (75) |
| administrator-abdullah-al-arabi.webp | 1080x490 | 52 | 653x490 | 38 | -28% | 933x490 (76) |
| ahly-club-extension-apartment.webp | 1080x496 | 43 | 661x496 | 28 | -35% | 945x496 (64) |
| ahmed-kasem-gooda.webp | 1080x1834 | 47 | 800x600 | 23 | -51% | 1080x567 (50) |
| Al-Azhar-Street-Luxury-Rent-200m.webp | 720x1081 | 15 | 720x540 | 10 | -32% | 720x378 (17) |
| Al-Hayat-Towers-7th-District-162m.webp | 1080x1920 | 87 | 800x600 | 59 | -32% | 1080x567 (76) |
| al-muqrafi-street.webp | 1055x816 | 75 | 800x600 | 58 | -22% | 1055x554 (78) |
| Al-Rehab-Villa-Model-H-Gate9.webp | 719x945 | 108 | 719x539 | 57 | -47% | 719x377 (78) |
| al-Tayaranstreet.webp | 1200x1600 | 65 | 800x600 | 50 | -23% | 1200x630 (79) |
| ali-amer.webp | 1066x815 | 29 | 800x600 | 23 | -23% | 1066x560 (48) |
| apartment-180m-nasr-city.webp | 1080x1420 | 82 | 800x600 | 59 | -27% | 1080x567 (78) |
| apartment-garden-golden-square-nasr-city.webp | 719x950 | 38 | 719x539 | 29 | -24% | 719x377 (34) |
| Apartment-Rent-Waha-50th-Street-163m.webp | 720x948 | 16 | 720x540 | 12 | -26% | 720x378 (19) |
| bethment-banfseg.webp | 1080x1432 | 63 | 800x600 | 38 | -39% | 1080x567 (65) |
| classic-heliopolis-apartment-150m.webp | 1080x1426 | 28 | 800x600 | 12 | -60% | 1080x567 (29) |
| commercial-mohamed-hasan-elgamal-main.webp | 720x1176 | 62 | 720x540 | 33 | -47% | 720x378 (40) |
| Commercial-Saudi-Buildings-Golf-110m.webp | 720x529 | 28 | 705x529 | 25 | -12% | 720x378 (38) |
| duplex-andalus.webp | 590x1280 | 23 | 590x442 | 15 | -35% | 590x310 (20) |
| Duplex-the-Seventh-district-150m².webp | 1075x1910 | 38 | 800x600 | 18 | -54% | 1075x564 (41) |
| edari400m.webp | 1080x795 | 50 | 800x600 | 40 | -20% | 1080x567 (76) |
| Egyptair-Bilal-Mosque-Nasr-City-125m.webp | 720x974 | 28 | 720x540 | 24 | -13% | 720x378 (33) |
| el-nozha-saudi-apartment-170m.webp | 1080x1433 | 41 | 800x600 | 21 | -50% | 1080x567 (48) |
| El-Shams-Club-Heliopolis-160m.webp | 720x927 | 59 | 720x540 | 44 | -26% | 720x378 (46) |
| elhai-elsabe.webp | 1072x1421 | 79 | 800x600 | 58 | -26% | 1072x563 (79) |
| elsfarat-duplex.webp | 1080x809 | 68 | 800x600 | 55 | -19% | 1080x567 (79) |
| fouad-nassim-sonesta-nasr-city.webp | 1080x1429 | 68 | 800x600 | 39 | -43% | 1080x567 (66) |
| Gamal-Afifi-Ahly-Club-Nasr-City-250m.webp | 720x1240 | 20 | 720x540 | 12 | -40% | 720x378 (21) |
| Gamal-Dewidar-ENPPI-Rent-160m.webp | 1280x960 | 28 | 800x600 | 15 | -46% | 1200x630 (45) |
| greenhilz.webp | 1080x1420 | 72 | 800x600 | 51 | -30% | 1080x567 (76) |
| Ground-Floor-Admin-Seraj-Mall.webp | 720x1198 | 20 | 720x540 | 11 | -46% | 720x378 (18) |
| hai-elswfarat.webp | 1078x1915 | 35 | 800x600 | 16 | -55% | 1078x566 (36) |
| hassan-al-sharif-apartment-150m.webp | 1080x1898 | 65 | 800x600 | 22 | -66% | 1080x567 (46) |
| Hassan-Hassanein-Heikal-200m.webp | 960x1280 | 48 | 800x600 | 32 | -33% | 960x504 (51) |
| hassan-maamoun-nahas-apartment-175m.webp | 1080x1423 | 58 | 800x600 | 36 | -37% | 1080x567 (64) |
| Hassanein-Heikal-Office-Storage-73m.webp | 1600x1200 | 44 | 800x600 | 22 | -50% | 1200x630 (53) |
| Hayat-Compound-Safarat-Furnished-200m.webp | 720x963 | 29 | 720x540 | 20 | -29% | 720x378 (27) |
| heliopolis-merghany-classic-180m.webp | 1080x823 | 41 | 800x600 | 33 | -19% | 1080x567 (58) |
| Helmy-Abdel-Aaty-Seraj-Garden-View-230m.webp | 720x540 | 12 | 720x540 | 11 | -10% | 720x378 (18) |
| helmy-hassan-160m.webp | 1080x1523 | 52 | 800x600 | 29 | -43% | 1080x567 (54) |
| helmy-hassan-ali-street-220m-nasr-city.webp | 1077x797 | 62 | 800x600 | 56 | -10% | 1077x565 (79) |
| ibrahim-nawara-street-nasr-city.webp | 398x696 | 14 | 398x298 | 8 | -48% | 398x209 (10) |
| International-Park-Furnished-140m.webp | 720x941 | 31 | 720x540 | 22 | -30% | 720x378 (33) |
| International-Park-View-215m.webp | 720x531 | 38 | 708x531 | 33 | -12% | 720x378 (48) |
| Ismail-Qabbani-Street-Genena-Mall.webp | 719x1266 | 11 | 719x539 | 7 | -36% | 719x377 (14) |
| Ismail-Wahby-Street-9th-District-160m.webp | 720x955 | 59 | 720x540 | 46 | -22% | 720x378 (52) |
| Kabul-Commercial-HQ-130m.webp | 1200x1600 | 85 | 800x600 | 36 | -57% | 1200x630 (69) |
| Kabul-Street-Makram-Ebeid-260m.webp | 699x945 | 54 | 699x524 | 31 | -42% | 699x367 (36) |
| Khedr-Eltouny-Stadium-120m.webp | 720x716 | 24 | 720x540 | 19 | -19% | 720x378 (28) |
| Lavida-Compound-Pool-View.webp | 630x500 | 48 | 630x472 | 43 | -10% | 630x331 (59) |
| Luxury-Administrative-Unit-41m.webp | 961x960 | 93 | 800x600 | 57 | -39% | 961x505 (79) |
| Luxury-Shop-Makram-Ebeid-67m.webp | 720x540 | 51 | 720x540 | 45 | -12% | 720x378 (51) |
| maamar-al-murshidi.webp | 1080x1428 | 47 | 800x600 | 27 | -43% | 1080x567 (53) |
| Makarif-Street-6th-District-130m.webp | 720x552 | 27 | 720x540 | 24 | -11% | 720x378 (39) |
| makram-ebid-177m.webp | 720x1237 | 76 | 720x540 | 46 | -40% | 720x378 (49) |
| makram-obeid-sqlia.webp | 720x965 | 51 | 720x540 | 42 | -18% | 720x378 (50) |
| mfroosh-tiran.webp | 1080x1870 | 33 | 800x600 | 14 | -58% | 1080x567 (36) |
| mkram-ebid.webp | 1080x617 | 43 | 800x600 | 34 | -21% | 1080x567 (73) |
| moez-al-Dawla-administrator.webp | 1080x1427 | 21 | 800x600 | 10 | -53% | 1080x567 (27) |
| mohiedin.webp | 1280x720 | 69 | 800x600 | 57 | -16% | 1200x630 (80) |
| mustafa-nahas-extension-160m.webp | 1080x793 | 34 | 800x600 | 26 | -22% | 1080x567 (51) |
| nasr-st.webp | 1077x810 | 66 | 800x600 | 60 | -9% | 1077x565 (78) |
| nasr-street.webp | 1079x1917 | 26 | 800x600 | 8 | -70% | 1079x566 (23) |
| New-Cairo-Villa-1st-District-Pool.webp | 719x547 | 50 | 719x539 | 44 | -12% | 719x377 (61) |
| new-plus-compound.webp | 1080x1414 | 74 | 800x600 | 58 | -22% | 1080x567 (77) |
| Next-to-al-siraj-mall.webp | 1065x485 | 45 | 647x485 | 38 | -16% | 924x485 (67) |
| nour-deen-main.webp | 720x552 | 23 | 720x540 | 20 | -10% | 720x378 (34) |
| nour-mahmoud-st.webp | 1068x790 | 56 | 800x600 | 50 | -11% | 1068x561 (78) |
| nozha-main-street-administrative-hq.webp | 705x553 | 31 | 705x529 | 27 | -13% | 705x370 (43) |
| Nozha-Street-Shop-Rent-190m.webp | 720x540 | 13 | 720x540 | 12 | -10% | 720x378 (26) |
| othman-buildings.webp | 1079x604 | 64 | 800x600 | 53 | -17% | 1079x566 (75) |
| Pharmacy-for-sale.webp | 1920x1080 | 36 | 800x600 | 20 | -44% | 1200x630 (51) |
| raba-nasr.webp | 1200x1600 | 69 | 800x600 | 51 | -27% | 1200x630 (80) |
| Rabaa-Investment-Abbas-Elakkad-165m.webp | 720x952 | 83 | 720x540 | 57 | -31% | 720x378 (74) |
| rabia-Investment.webp | 1077x807 | 39 | 800x600 | 30 | -23% | 1077x565 (57) |
| region-nine.webp | 1080x1771 | 68 | 800x600 | 53 | -21% | 1080x567 (74) |
| rent-diplomatic-quarter.webp | 1078x1436 | 33 | 800x600 | 18 | -46% | 1078x566 (40) |
| rent-furnished-batrawy-nasr-city.webp | 1080x1429 | 70 | 800x600 | 55 | -21% | 1080x567 (78) |
| republican-guard.webp | 1080x1868 | 34 | 800x600 | 20 | -41% | 1080x567 (49) |
| salah-salemal-abour.webp | 1080x1884 | 37 | 800x600 | 21 | -43% | 1080x567 (48) |
| sheraton-nozha.webp | 1079x1438 | 26 | 800x600 | 9 | -64% | 1079x566 (24) |
| Shinzo-Abe-Main-View-262m.webp | 719x953 | 33 | 719x539 | 27 | -20% | 719x377 (36) |
| shopp212m.webp | 1080x855 | 63 | 800x600 | 46 | -27% | 1080x567 (74) |
| South-90th-St-Villa-Dusit-View.webp | 719x954 | 84 | 719x539 | 46 | -45% | 719x377 (48) |
| sun-view.webp | 1080x1432 | 36 | 800x600 | 20 | -43% | 1080x567 (44) |
| sunrise.webp | 1080x800 | 72 | 800x600 | 59 | -19% | 1080x567 (80) |
| tawfiqal-Bakri-st.webp | 1080x753 | 17 | 800x600 | 14 | -19% | 1080x567 (35) |
| tawnit.webp | 1080x802 | 70 | 800x600 | 53 | -24% | 1080x567 (77) |
| the-ninth-district-toukhi.webp | 1080x1425 | 59 | 800x600 | 36 | -40% | 1080x567 (62) |
| togari-400m.webp | 1080x1898 | 57 | 800x600 | 25 | -56% | 1080x567 (48) |
| trade-fair.webp | 1078x808 | 61 | 800x600 | 51 | -17% | 1078x566 (77) |
| True-Gate-Compound-Waha-108m.webp | 709x496 | 30 | 661x496 | 27 | -11% | 709x372 (45) |
| Unfurnished-Apartment-Rent-Abdel-Hamid-Lotfy-Nasr-City.webp | 720x1123 | 22 | 720x540 | 16 | -28% | 720x378 (27) |
| vila-nsftshtib.webp | 1063x1416 | 113 | 800x600 | 58 | -48% | 1063x558 (80) |
| zahraa-thirdfloor.webp | 1068x1898 | 66 | 800x600 | 29 | -56% | 1068x561 (52) |
| zhraa-nasr.webp | 1080x1944 | 23 | 800x600 | 8 | -65% | 1080x567 (22) |
| zuhair-sabri.webp | 1600x720 | 64 | 800x600 | 50 | -22% | 1200x630 (79) |

## ب. تعديلات القوالب والكود (كلها موثقة بتاريخ 2026-10-17 داخل الملفات)

| الملف | التعديل |
|---|---|
| `properties.html` | بطاقات `pl-card` تعرض `cards/` الموحدة + احتياطي للأصل عند فقدها بدل الشعار |
| `index.html` | بطاقات الرئيسية تعرض `cards/` + إضافة `width/height` (منع CLS) + **إصلاح خلل إنتاجي قائم**: حلقة البطاقات كانت تكرر على متغير غير معرّف (`latest_props`) فكان قسم بطاقات الرئيسية **فارغًا تمامًا** في الموقع المباشر |
| `_layouts/property_page.html` | إطار المعرض يقرأ الأبعاد الحقيقية من `_data/image_dims.yml`: `aspect-ratio` متكيف + `object-fit: contain` + width/height صحيحة بدل 1200×750 الثابتة الخاطئة — **الصورة كاملة بلا قص** مع سقف 85vh للطويلة جدًا، وسلوك قديم كاحتياطي عند غياب الإدخال |
| `assets/css/style.css` + `style.min.css` | قاعدتا `.pp-gallery-main--natural` (أعيد توليد min بالأداة نفسها clean-css -O1 مع إبقاء اللافتة) |
| `agent.html` | بطاقات معرض الوكيل تعرض `cards/` (إعادة كتابة المسار زمن التشغيل) |
| `property-images.html` | مثلها |
| `_includes/navbar.html` `floating-menu.html` `footer.html` | الشعار الصغير `logo-120.webp` بدل 1024×1024 (يُستخدم في ~50px) |
| `_properties/*.md` (103) | تحديث جراحي لسطر `image:` فقط → نسخة OG (95 تعديلًا + 8 إضافات لملفات لم يكن لديها الحقل أصلًا وكانت تسقط على الصورة الافتراضية). **حقل `image_file` (مصدر صفحة التفاصيل وAPI والوكيل) لم يُمس** — تحقق: `git diff` يظهر سطرًا واحدًا لكل ملف |
| `server.js` | تحميل `_data/*.yml` إلى `site.data` (كانت المعاينة المحلية تفتقده بينما Jekyll الحقيقي يقرأه) |
| أرشفة (git mv — لا حذف) | `assets/img/favicons/` كاملًا، `android-chrome-*.png`، `maskable-512x512.png`، `hero-bg.webp`، `social-contact.webp`، `social-details-default.webp`، `social/social-home.svg`، و`team/sea.webp` التالف (كـ `team-sea.webp.corrupt`) → `_diag/unused-images/` |

**لماذا تعديل `image:` آمن على الوكيل وقاعدة البيانات:** فحصت `scripts/lib/properties.mjs` —
حقل `image` في API/ai-feed/الوكيل **يُبنى من `image_file`** وليس من `image` في الـ front matter،
أي أن الوكيل وAPI وطبقة الذكاء لم يتغيّر فيها شيء إطلاقًا. حقل `image:` يغذي og:image فقط.

## ج. نتائج التحقق (كلها فعلية لا نظرية)

| الفحص | النتيجة |
|---|---|
| اشتقاق كل نسخة من أصلها | ✅ 103 بطاقة + 103 OG: أقصى متوسط فرق بكسل عن نافذة القص المتوقعة = **6.1/255** (آثار ترميز فقط) |
| النسب | ✅ كل بطاقات 4:3 بالضبط (±0.6%)، كل OG بنسبة 1200:630 |
| لا تكبير أبدًا | ✅ صفر بطاقة أعرض من مصدرها |
| السقوف | ✅ كل بطاقة ≤60KB و ≤90% من حجم أصلها (استثناء وحيد موثق: nasr-st بفارق 0.7KB فوق السقف الثانوي) |
| الاختبارات | ✅ 283/285 (الإخفاقان = المعروفان مسبقًا والموثقان في CI — لا علاقة لهما بالصور) |
| فحص 116 صفحة مُصيَّرة | ✅ 323 مسار صورة فريد، **صفر مكسور** |
| فحص HTTP للملفات الجديدة | ✅ 206/206 ترجع 200 من الخادم |
| صفحة تفاصيل عقار طولي 960×1280 | ✅ تُصيَّر بـ `aspect-ratio: 960/1280` + `width="960" height="1280"` + contain |
| og:image لصفحات العقارات | ✅ كلها تشير إلى `og/*.jpg` 1200×630 |

## د. الأدلة البصرية الجديدة

- `_diag/image-audit-assets/verify-grid-mobile.jpg` — شبكة 375px بالبطاقات الفعلية (نسبة موحدة)
- `_diag/image-audit-assets/verify-grid-desktop.jpg` — شبكة 1200px (4 أعمدة بارتفاعات متساوية)
- `_diag/image-audit-assets/verify-detail-before-after.jpg` — صفحة التفاصيل قبل (كان يظهر 47% من صورة Heikal) وبعد (الصورة كاملة)
- المعاينة الحية المتاحة لك عبر خادم المعاينة قبل الدمج

## هـ. ما تُرك دون تغيير (مقصدًا)

- **104 صورة أصلية في `assets/img/properties/`** — تُستخدم بكامل جودتها في صفحات التفاصيل والـ lightbox
- `image_file` في كل ملفات العقارات + كل حقول البيانات (سعر/مساحة/غرف...) — لم يتغير بايت واحد خارج سطر `image:`
- الوكيل `agent.html` (منطق العمل) و`_worker/` وCloudflare وAPI وشروط النشر — لم تُمس
- `luxury-gallery.html` (عرض شرائح كبير يستحق الأصول الكاملة) و`og-generator.html`
- صور السوشيال PNG 1200×630 وكل الأيقونات المستخدمة فعليًا
- الصور الـ 12 شديدة الضبابية + 3 صغيرة الأبعاد — لا يمكن "استرجاع" تفاصيل غير موجودة؛ **التوصية تبقى: صور بديلة من المصدر** عند توفرها
- `sea.webp`: ملف 1 بايت لا يمكن إصلاحه — مؤرشف باسم `team-sea.webp.corrupt`؛ **أرسل الصورة الأصلية وسأعيدها فورًا**
- `sw.js`: لم يُمس (شعار الاحتياط المخزن مسبقًا `logo.webp` موجود وباقٍ)

---

## 🚀 النشر — مُنجز

| المرحلة | الحالة |
|---|---|
| PR #68 مفتوح من فرع الجلسة | ✅ |
| فحوص PR: node-tests + build-only ×2 + SonarCloud ×2 | ✅ كلها خضراء |
| بناء Jekyll حقيقي (GitHub Pages gem, بيئة إنتاج) عبر سير عمل تحقق مؤقت | ✅ 104 صفحات عقار، 103 إطار متكيف، 103 مرجع OG، cards=103 og=103، صفر مسارات مكسورة، _diag مستثنى من البناء (ثم حُذف سير العمل المؤقت قبل الدمج كما وُعد) |
| **الدمج في master** | ✅ `Merge pull request #68` |
| سير عمل النشر deploy.yml على master | ✅ Build with Jekyll → توليد طبقة الذكاء والتحقق من صحتها → Upload artifact → **Deploy to GitHub Pages** |
| حالة GitHub Pages | ✅ **built** — الموقع المباشر يعمل بالتعديلات |

**رابط التحقق:** https://nasr-realestate.github.io — البطاقات موحدة النسبة في الرئيسية وصفحة العقارات،
وصفحات التفاصيل تعرض الصور كاملة بنسبتها الأصلية، وog:image بمعيار 1200×630 لكل عقار.
