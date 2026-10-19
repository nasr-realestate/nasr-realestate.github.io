# تقرير دفعة الصوت 2026-10-19 (batch9 — إتمام 104/104)

**الفرع الأول:** `arena/6f781a6b-nasr-realestate-github-io` (`voice-02`) · **فرع الإتمام:** `arena/8f28ddf9-nasr-realestate-github-io` (`voice-04` بموافقة المالك في الجلسة) · **التاريخ:** 2026-10-19 (Africa/Cairo)

## 1) الحالة الكاملة (104/104)

- **104** ملف عقار في `_properties/` · **104/104** منها بصفحة صوتية كاملة (`audio_ad: true` + `audio_file` + `audio_script` + `audio_duration`) — أي **صفر** صفحة عقار بلا صوت.
- **106** ملف MP3 تحت `assets/audio/`: **104** لعقارات + **2** لطلبات (خارج نطاق هذه الدفعة، لم تُمَس).
- **43 من 43** استبدالًا موثّقًا بالكامل للملفات القديمة الموروثة (28 في الجزء الأول + 15 في جزء الإتمام)، وكل أصل محفوظ البصمة في `_diag/audio-batch9-replacement-ledger.json` وفي قيد السجل.
- **5** عروض عقارية كانت مستثناة سابقًا أُنتج لها إعلانها الصوتي الموحّد بأمر المالك الصريح ليصبح المجموع **104/104**.
- الإعلانات المرجعية الستة محفوظة ببصماتها الأصلية حرفيًا دون مساس.

## 2) قيود لم تُخترق

| القيد | الحالة |
|---|---|
| الإعلانات المرجعية الستة بلا مساس | محفوظة ببصماتها (`fb1ff292…`، `c0729a26…`، `5eb24cc1…`، `38ffca64…`، `b85ae420…`، `e25747b5…`) |
| عدم استبدال ملف صامت أو بلا قيد في السجل | محفوظ — كل استبدال يتحقق من بصمة الأصل مقابل السجل قبل الكتابة |
| حفظ بصمة كل أصل مستبدَل (43/43) | في `_diag/audio-batch9-replacement-ledger.json` وتكرارها في قيد السجل |
| أرقام بالحروف المصرية | محفوظ — لا رقم رقمي في أي نص |
| عدم الإنتاج بلا `--plan` ناجح | محفوظ — كل نص مرّ بالفحص قبل التوليد وبلا `--ack-facts` |
| القياس الفعلي | كل قيمة `cos` مقيسة فعليًا بـ`scripts/audio/measure_voice_identity.py` |

## 3) الاستبدالات المنجزة في الجزء الأول (28)

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

## 4) الاستبدالات الـ15 المتبقية — أُنجزت بالكامل (`voice-04` · موافقة المالك في الجلسة)

| # | العقار (slug) | cos | المدة (`audio_duration`) | SHA-256 (جديد) | SHA-256 (الأصل المستبدَل) | ملف النص |
|---|---|---|---|---|---|---|
| 29 | `genena-mall-186m-office-residence` | 0.8321 | 26.568 ث (27 ثانية) | `542756746567ae01386584aff3048b521813807f9600a64a32c902f93ed04991` | `668290009d62d6ae8b9761af42c783a3e971538a59fb1d31ffa9716f0e4aff70` | `_diag/audio-batch9-scripts/genena-mall-186m-office-residence.txt` |
| 30 | `makram-ebid-main-250m` | 0.8559 | 24.264 ث (25 ثانية) | `43c1c033c53c7199466399e851037668dbe160a441a7175cfc72588e87271560` | `6077222c9469a33d70b3fcecdb23a6702bc034bc908678ab4b1f55652ee942c3` | `_diag/audio-batch9-scripts/makram-ebid-main-250m.txt` |
| 31 | `office-storage-rent-hassanein-heikal-nasr-city-73m` | 0.8680 | 26.136 ث (27 ثانية) | `3b6c06814233adccad7f8cf55643a8dc547427632ee77156a657d9a33f5a6bbb` | `3905ec0ae9d9f2d84cb27fe2975a9c1981fab0e074c69e24c1ad2ce4c42e7ce6` | `_diag/audio-batch9-scripts/office-storage-rent-hassanein-heikal-nasr-city-73m.txt` |
| 32 | `rehab-villa-model-h-gate9` | 0.8511 | 26.976 ث (27 ثانية) | `791cac682a30a38b6871c8e19de3dfb9eed5207c05b7c3e2bcde1cfeb281a8b1` | `f49fb304f877e442a3fead8821354873fbadbd01652c50080e5b295daef20427` | `_diag/audio-batch9-scripts/rehab-villa-model-h-gate9.txt` |
| 33 | `rent-abdel-hamid-lotfy-tayaran-150m` | 0.8865 | 21.624 ث (22 ثانية) | `9ccc29ac2270daabd6df8b148f0352e22ed97400aac4354e9f79ea707f803dfb` | `79b189395d25b0311353f35c4b074da4a41c1dbbfdb50809bec7724ee3e1b345` | `_diag/audio-batch9-scripts/rent-abdel-hamid-lotfy-tayaran-150m.txt` |
| 34 | `rent-waha-50th-street-163m` | 0.8700 | 24.216 ث (25 ثانية) | `1a4652401d5d0d97659ed1d6ee9480b232809d7e3bbb14b80cd58a90cd97d1b7` | `5ad389d1b121bf3fe310d678fdc70047e6ced38c84af25236d13400ef2430f1b` | `_diag/audio-batch9-scripts/rent-waha-50th-street-163m.txt` |
| 35 | `safarat-safwa-170m` | 0.8634 | 27.096 ث (28 ثانية) | `bfdfdd4953964f5a8df2bb5c350b5c4b41511f6c9c93455a187f80d4f622e2e9` | `354f9b19411a5766e2d646462f4c52d371d7f2e6da8b1319265d8b3724e614cf` | `_diag/audio-batch9-scripts/safarat-safwa-170m.txt` |
| 36 | `sanhoori-luxury-250m` | 0.8710 | 24.528 ث (25 ثانية) | `89ede7535e9ffd0087c054f738666dd3af2b86ddea1c011776da1422b28b8c40` | `ac9e1009533854eed93a2d3e44c1888e5e9a59f594c6a83f59d3804c70b6ea2a` | `_diag/audio-batch9-scripts/sanhoori-luxury-250m.txt` |
| 37 | `shaka-nour-deen` | 0.8815 | 23.664 ث (24 ثانية) | `1dc779db1c1c29efb306055506ec39d8b74224cb01df7afcbe62c1d3f4b88441` | `abf86029dffe077e14cc93d3bc4c1516679db82662bbf86dc605d3f53b5752b4` | `_diag/audio-batch9-scripts/shaka-nour-deen.txt` |
| 38 | `shams-club-heliopolis-160m` | 0.8954 | 23.688 ث (24 ثانية) | `17f25132eba228ec49b865d5d88e9222d672acabdf5bd8b64523ee1875e038dd` | `fe06556889a78cbac07959cf49eaaf0fe6430069c1a2eeae61d72b7f8f5faac4` | `_diag/audio-batch9-scripts/shams-club-heliopolis-160m.txt` |
| 39 | `shop-abbas-elakkad-60m-jan26` | 0.8610 | 23.664 ث (24 ثانية) | `437fb89f65f841200e452263289ffef52b680db2ad5af44a5d80e43849eec946` | `0e92ee4940e629389af53f7cca2b4e632d501644662eb2d367af9232cb6ded3c` | `_diag/audio-batch9-scripts/shop-abbas-elakkad-60m-jan26.txt` |
| 40 | `shop-rent-makram-ebeid-67m` | 0.8504 | 25.368 ث (26 ثانية) | `c366ab9723a301a0a1fa4b1d1855663f0f37925004c460275c1685f0dfde9664` | `d477736938387c1507427b3b44ad709849e77a5c074c2c433d384e55506236f6` | `_diag/audio-batch9-scripts/shop-rent-makram-ebeid-67m.txt` |
| 41 | `truegate-compound-waha-108m` | 0.8601 | 24.264 ث (25 ثانية) | `5ae309cb72cd244dc8a67761147e726625ec6241bd7cdd4bed7be0bac3f71b52` | `1c70e7a51a98c75edbbdce4267963463835a64a86794514c13022c8a540ad647` | `_diag/audio-batch9-scripts/truegate-compound-waha-108m.txt` |
| 42 | `villa-new-cairo-1st-district-568m` | 0.8558 | 25.776 ث (26 ثانية) | `fa32bbfc4ed6f9c3435e9dbaa680f9efeda872096be42e98f5a6e71ec4450c92` | `0ad30545587d9c185324d3d41e15a7f5fb729b8c3a9896d7f33921f75ec7432d` | `_diag/audio-batch9-scripts/villa-new-cairo-1st-district-568m.txt` |
| 43 | `villa-south-90th-120m` | 0.8727 | 24.816 ث (25 ثانية) | `a0d07cea2b0240bdec8e59c6c17997c7b1d72dbacaaa2ae298ec199018db4811` | `df397b9bcbbcc405485247843cdb8a635dd34af392ea535013793e1303aa9c02` | `_diag/audio-batch9-scripts/villa-south-90th-120m.txt` |

## 5) العروض الـ5 التي أُضيفت لإتمام 104/104 عرض عقاري

| # | العقار (slug) | ملف العقار | cos | المدة (`audio_duration`) | SHA-256 | ملف النص |
|---|---|---|---|---|---|---|
| 1 | `andalus1-duplex-285m` | `_properties/andalus1-duplex-285m.md` | 0.8824 | 26.304 ث (27 ثانية) | `b13f41854a4d50da3d7de1d326f3502c5b21dc022618c6f8cc4a3858eb97fd7e` | `_diag/audio-batch9-scripts/andalus1-duplex-285m.txt` |
| 2 | `shinzo-abe-262m-4th-floor` | `_properties/2026-01-13-shinzo-abe-axis-luxury-262m.md` | 0.8460 | 24.888 ث (25 ثانية) | `3e71ec3b2e22f6f0e7f24fca0ff9dabc0657c5dd457deeba32934e6e7ece4674` | `_diag/audio-batch9-scripts/shinzo-abe-262m-4th-floor.txt` |
| 3 | `saudi-buildings-golf-110m` | `_properties/2026-05-11-commercial-saudi-buildings-golf-110m.md` | 0.8436 | 23.736 ث (24 ثانية) | `80051bfd80644eecc07f753c62f46be783954714b17a13243281607534329ac4` | `_diag/audio-batch9-scripts/saudi-buildings-golf-110m.txt` |
| 4 | `showroom-ahmed-fakhry-600m` | `_properties/showroom-ahmed-fakhry-600m.md` | 0.8583 | 24.216 ث (25 ثانية) | `90c46db6b82c4d4d80924aeefd19f2873d2d121cff33bb5ee6ec44b7b3e51777` | `_diag/audio-batch9-scripts/showroom-ahmed-fakhry-600m.txt` |
| 5 | `sherif-samy-ground-admin` | `_properties/2026-04-15-ground-floor-admin-seraj-mall.md` | 0.8631 | 25.224 ث (26 ثانية) | `bf22f3bdc9450b9420d40b0a8957932b1ad700d991887bcd3238eb8c6aa882b2` | `_diag/audio-batch9-scripts/sherif-samy-ground-admin.txt` |

## 6) البوابات المنفَّذة ونتائجها

| الفحص | النتيجة |
|---|---|
| `scripts/audio/verify-voice-identity.mjs` | ✅ نجح — 106 قيدًا (104 عقار + 2 طلب)، 0 مخالفة |
| `scripts/tests/voice-identity.test.mjs` | ✅ 44/44 |
| `_worker/tests/ai-artifacts.test.mjs` | ✅ 24/24 |
| `_worker/tests/mcp-gateway.test.mjs` | ✅ 26/26 |
| `scripts/tests/front-matter.test.mjs` | ✅ 7/7 |
| `scripts/check-ai-artifacts-in-sync.mjs` | ✅ 218/218 ملفًا مطابقة للمولّد |
| `git diff --check` | ✅ نظيف |
| مجاميع السجل (`_data/audio_voice_log.json`) | `audioFiles: 106` · `linkedToPublishedPages: 105` (104 عقار + 1 طلب) · `retiredOrphans: 1` · `ownerChosenReference: 1` · `producedUnderSpec: 103` · `legacyGrandfathered: 1` |

## 7) إخفاقات سابقة للدفعة (لا علاقة لها بالصوت)

5 اختبارات فاشلة على `master` قبل هذا العمل: `verifyDeployment (2)` · `deploy-properties-sync: قوائم التصنيف لا تغطي 104 ملفًا` · `preview-parity` · وصف `/api` غير كامل لعقار واحد.

## 8) عقد الملفات

MPEG-2 Layer III · 32 kbps · 24 kHz · أحادي · ≤30 ثانية · peak ≤ −0.5 dBFS · RMS −22…−17 dBFS · ID3v2.3 (`TIT2`/`TPE1`/`TALB`/`TDRC`/`TCON`/`TSSE`/`COMM`) · `TPE1 = سمسار طلبك — طارق طنطاوي` · `COMM = audio_script` حرفيًا · وسم الصفحة `audio_file` يعكس الـslug.
