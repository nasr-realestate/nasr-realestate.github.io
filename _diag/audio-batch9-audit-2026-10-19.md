# تدقيق ما قبل الدفعة الشاملة — كل الإعلانات الصوتية العقارية القائمة

**التاريخ:** 2026-10-19 (Africa/Cairo)  
**النطاق:** ملفات `assets/audio/properties/*.mp3` (49 ملفًا) وصفحاتها في `_properties/` وسجل `_data/audio_voice_log.json`  
**الأدوات:** `scripts/audio/produce-audio-ad.mjs --verify` (ترميز + وسوم + مدة + بصمة)، `scripts/audio/measure_voice_identity.py` (GE2E/Resemblyzer 0.1.4، قياس فعلي)، قراءة front matter، مراجعة نصية آلية.  
**لا ادعاء استماع:** لم يُجرَ أي استماع بشري لهذه الملفات في هذه الجلسة. كل ما بالأسفل قياس آلي أو قراءة نص.  

## 1) الحصيلة العددية

| البند | العدد |
|---|---:|
| صفحات عقارات في `_properties/` | 104 |
| صفحات عقارات بصوت (`audio_ad: true`) | 49 |
| صفحات عقارات بلا صوت | 55 |
| ملفات MP3 عقارية | 49 |
| ملفات MP3 طلبات (خارج نطاق هذه الدفعة) | 2 |
| إعلانات «أقدم» = كل العقاري عدا الخمسة الأخيرة | 44 |

> **فرق موثَّق عن نص المطالبة:** المطالبة ذكرت 103 صفحة / 54 بلا صوت. المستودع الآن فيه **104** صفحة عقار: أُضيفت صفحة `apartment-sale-bashar-ibn-burd-makram-ebeid-190m` بتاريخ 2026-10-19 في الكوميت `c2f0a14` (نفس كوميت نقطة البداية). الفرق صفحة واحدة فقط، وهي داخلة في نطاق هذه الدفعة.

## 2) جرد الملفات الـ49: الصيغة والوسوم والمدة والبصمة

كل الملفات: MP3 / MPEG-2 Layer III / 576 عيّنة لكل إطار / 32 kbps / 24 kHz / أحادي — بلا استثناء. الوسوم ID3v2.3 بسبعة إطارات بالترتيب `TIT2 TPE1 TALB TDRC TCON TSSE COMM` وحشو 1024 بايت. بصمة كل ملف على القرص **مطابقة** لسطر السجل (صفر انحراف)، و`--verify` أعطى **صفر مشكلة** في 49/49.

| # | slug | المدة (ث) | التسمية | بايت | SHA-256 (16) | COMM | cos | التصنيف | CTA | Hook سؤال؟ | أرقام رقمية؟ |
|---:|---|---:|---|---:|---|---|---:|---|---|---|---|
| 1 | `apartment-sale-helmy-abdel-aaty-seraj-mall-230m` | 26.664 | 27 ثانية | 108,976 | `fb1ff292d14736bc…` | نص الإعلان | 1.0000 | reference | مرجعية (متكلم) | نعم | نعم |
| 2 | `10th-district-180m` | 24.768 | 25 ثانية | 101,302 | `c0729a2614e0219b…` | نص الإعلان | 0.9751 | compatible-with-reference | مرجعية (متكلم) | نعم | لا |
| 3 | `seraj-mall-apartment-170m` | 26.856 | 27 ثانية | 109,622 | `5eb24cc1f7ff5ac6…` | نص الإعلان | 0.9729 | compatible-with-reference | مرجعية (متكلم) | نعم | لا |
| 4 | `ahly-club-ext-158m` | 28.896 | 29 ثانية | 117,846 | `38ffca645030793c…` | نص الإعلان | 0.9600 | compatible-with-reference | مرجعية (متكلم) | نعم | لا |
| 5 | `hassan-al-sharif-150m` | 22.968 | 23 ثانية | 94,052 | `b85ae420f2d774d3…` | نص الإعلان | 0.9569 | compatible-with-reference | مرجعية (متكلم) | نعم | لا |
| 6 | `abbas-elakkad-220m-2026` | 25.416 | 26 ثانية | 103,930 | `e25747b530a25b99…` | نص الإعلان | 0.9705 | compatible-with-reference | مرجعية (متكلم) | نعم | لا |
| 7 | `apartment-sale-hassan-hassanein-heikal-200m` | 28.896 | 29 ثانية | 117,877 | `1b2289c91c1747ba…` | «» فارغ | 0.9143 | possible-deviation-review | موروثة (غائب) | **لا** | لا |
| 8 | `abdel-azim-ghalmi-200m-expat` | 20.856 | 21 ثانية | 85,445 | `e163142e8549afbe…` | «» فارغ | 0.9112 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 9 | `golden-square-garden-156m` | 27.408 | 28 ثانية | 111,836 | `bc8a10c088a1cf21…` | نص الإعلان | 0.9071 | clear-difference | مرجعية (متكلم) | نعم | لا |
| 10 | `apartment-sale-abbas-elakkad-refaai-200m-roi` | 27.288 | 28 ثانية | 111,353 | `29d1d678eaa2719c…` | «» فارغ | 0.9039 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 11 | `apartment-for-sale-khedr-eltouny-tayaran-120m` | 19.536 | 20 ثانية | 80,182 | `473cd73b187f9e79…` | «» فارغ | 0.8959 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 12 | `apartment-sale-al-hayat-towers-nasr-city-162m` | 19.248 | 20 ثانية | 78,993 | `6352bd42f3073a9f…` | «» فارغ | 0.8920 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 13 | `ismail-wahby-160m-luxury` | 18.816 | 19 ثانية | 77,337 | `3260fa3e57eafa34…` | «» فارغ | 0.8803 | clear-difference | موروثة (غائب) | **لا** | لا |
| 14 | `truegate-compound-waha-108m` | 24.864 | 25 ثانية | 101,633 | `1c70e7a51a98c75e…` | «» فارغ | 0.8735 | clear-difference | موروثة (غائب) | **لا** | لا |
| 15 | `abu-dawood-fakhry-167m` | 22.104 | 23 ثانية | 90,530 | `456d61fa435c7573…` | «» فارغ | 0.8707 | clear-difference | موروثة (غائب) | **لا** | لا |
| 16 | `shams-club-heliopolis-160m` | 23.256 | 24 ثانية | 95,179 | `fe06556889a78cba…` | «» فارغ | 0.8692 | clear-difference | موروثة (غائب) | **لا** | لا |
| 17 | `shaka-nour-deen` | 19.224 | 20 ثانية | 78,913 | `abf86029dffe077e…` | «» فارغ | 0.8669 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 18 | `villa-south-90th-120m` | 19.896 | 20 ثانية | 81,711 | `df397b9bcbbcc405…` | «» فارغ | 0.8659 | clear-difference | موروثة (غائب) | **لا** | لا |
| 19 | `shop-abbas-elakkad-60m-jan26` | 19.536 | 20 ثانية | 80,182 | `0e92ee4940e62938…` | «» فارغ | 0.8568 | clear-difference | موروثة (غائب) | **لا** | لا |
| 20 | `shop-rent-makram-ebeid-67m` | 22.464 | 23 ثانية | 91,944 | `d477736938387c15…` | «» فارغ | 0.8537 | clear-difference | موروثة (غائب) | **لا** | لا |
| 21 | `villa-new-cairo-1st-district-568m` | 29.376 | 30 ثانية | 119,769 | `0ad30545587d9c18…` | «» فارغ | 0.8491 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 22 | `apartment-sale-egyptair-nasr-city-125m-furnished` | 23.064 | 24 ثانية | 94,436 | `4e5346e80eb21b45…` | نص الإعلان | 0.8460 | clear-difference | غائبة/مختلفة | نعم | لا |
| 23 | `int-park-140m-furnished` | 23.616 | 24 ثانية | 96,612 | `7b46469c754a4f7a…` | «» فارغ | 0.8456 | clear-difference | موروثة (غائب) | **لا** | لا |
| 24 | `apartment-sale-gamal-afifi-ahly-club-250m` | 23.328 | 24 ثانية | 95,543 | `2eb4e243fb6a4acd…` | نص الإعلان | 0.8405 | clear-difference | موروثة (غائب) | نعم | لا |
| 25 | `genena-mall-186m-office-residence` | 26.904 | 27 ثانية | 109,859 | `668290009d62d6ae…` | «» فارغ | 0.8391 | clear-difference | موروثة (غائب) | **لا** | لا |
| 26 | `admin-rent-nozha-main-260m` | 22.824 | 23 ثانية | 93,451 | `326d70b377dae017…` | «» فارغ | 0.8321 | clear-difference | موروثة (غائب) | **لا** | لا |
| 27 | `apartment-sale-international-park-nasr-city-215m` | 26.304 | 27 ثانية | 107,483 | `b834abbc18332a6e…` | «» فارغ | 0.8282 | clear-difference | موروثة (غائب) | **لا** | لا |
| 28 | `furnished-apartment-rent-hayat-compound-safarat-200m` | 22.704 | 23 ثانية | 93,003 | `42e7026d9dbca88d…` | نص الإعلان | 0.8270 | clear-difference | غائبة/مختلفة | نعم | لا |
| 29 | `ibrahim-nawara-175m` | 18.888 | 19 ثانية | 77,617 | `964d0687973c4ec7…` | «» فارغ | 0.8253 | clear-difference | موروثة (غائب) | **لا** | لا |
| 30 | `makram-ebid-main-250m` | 18.504 | 19 ثانية | 75,988 | `6077222c9469a33d…` | «» فارغ | 0.8246 | clear-difference | موروثة (غائب) | **لا** | لا |
| 31 | `sanhoori-luxury-250m` | 20.736 | 21 ثانية | 84,958 | `ac9e1009533854ee…` | «» فارغ | 0.8246 | clear-difference | موروثة (غائب) | **لا** | لا |
| 32 | `apartment-sale-makarif-6th-district-130m` | 26.328 | 27 ثانية | 107,597 | `4d5fc7d29eaf113f…` | «» فارغ | 0.8231 | clear-difference | موروثة (غائب) | **لا** | لا |
| 33 | `kabul-st-makram-ebeid-260m` | 27.336 | 28 ثانية | 111,563 | `04c69a45044be866…` | «» فارغ | 0.8225 | clear-difference | موروثة (غائب) | **لا** | لا |
| 34 | `luxury-apartment-rent-al-azhar-street-nasr-city-200m` | 23.448 | 24 ثانية | 95,976 | `9f5c4d9a4c1ad4a6…` | نص الإعلان | 0.8201 | clear-difference | غائبة/مختلفة | نعم | لا |
| 35 | `administrative-unit-rent-nasr-city-41m` | 22.368 | 23 ثانية | 91,659 | `5d3e6fdc1419662f…` | «» فارغ | 0.8145 | clear-difference | موروثة (غائب) | نعم | لا |
| 36 | `commercial-hq-rent-kabul-street-nasr-city-130m` | 23.904 | 24 ثانية | 97,704 | `a0952c86b1dbdb0d…` | «» فارغ | 0.8144 | clear-difference | موروثة (غائب) | **لا** | لا |
| 37 | `apartment-sale-abdul-halim-abdullah-195m` | 24.168 | 25 ثانية | 98,892 | `41144f92e1db328a…` | «» فارغ | 0.8134 | clear-difference | موروثة (غائب) | **لا** | لا |
| 38 | `apartment-sale-rabaa-investment-abbas-elakkad-165m` | 24.024 | 25 ثانية | 98,328 | `766a5f7a9f66691d…` | «» فارغ | 0.8113 | clear-difference | موروثة (غائب) | نعم | لا |
| 39 | `office-storage-rent-hassanein-heikal-nasr-city-73m` | 24.048 | 25 ثانية | 98,438 | `3905ec0ae9d9f2d8…` | نص الإعلان | 0.8109 | clear-difference | غائبة/مختلفة | نعم | لا |
| 40 | `commercial-mohamed-hasan-elgamal` | 25.704 | 26 ثانية | 105,019 | `5b509764e3f0fb72…` | «» فارغ | 0.8104 | clear-difference | موروثة (غائب) | **لا** | لا |
| 41 | `degla-landmark-122m-rent` | 21.336 | 22 ثانية | 87,384 | `65e10976244b9eda…` | «» فارغ | 0.8067 | clear-difference | موروثة (غائب) | **لا** | لا |
| 42 | `safarat-safwa-170m` | 21.288 | 22 ثانية | 87,172 | `354f9b19411a5766…` | «» فارغ | 0.8054 | clear-difference | موروثة (غائب) | **لا** | لا |
| 43 | `ali-amer-240m` | 23.616 | 24 ثانية | 96,500 | `a98be4bc95f1aeaa…` | «» فارغ | 0.8053 | clear-difference | موروثة (غائب) | **لا** | لا |
| 44 | `rehab-villa-model-h-gate9` | 23.664 | 24 ثانية | 96,816 | `f49fb304f877e442…` | «» فارغ | 0.8034 | clear-difference | موروثة (غائب) | **لا** | نعم |
| 45 | `rent-abdel-hamid-lotfy-tayaran-150m` | 21.864 | 22 ثانية | 89,629 | `79b189395d25b031…` | «» فارغ | 0.7936 | clear-difference | موروثة (غائب) | **لا** | لا |
| 46 | `makram-ebid-177m` | 24.576 | 25 ثانية | 100,502 | `a24a30befbf44af1…` | «» فارغ | 0.7857 | clear-difference | موروثة (غائب) | نعم | لا |
| 47 | `apartment-rent-gamal-dewidar-enppi-nasr-city-160m` | 23.976 | 24 ثانية | 98,094 | `8156b84f42e0ee0f…` | «» فارغ | 0.7851 | clear-difference | موروثة (غائب) | **لا** | لا |
| 48 | `rent-waha-50th-street-163m` | 23.328 | 24 ثانية | 95,521 | `5ad389d1b121bf3f…` | «» فارغ | 0.7657 | clear-difference | موروثة (غائب) | نعم | لا |
| 49 | `commercial-shop-for-rent-nozha-street-nasr-city` | 25.056 | 26 ثانية | 102,456 | `89cbcf9f3056d8dd…` | «» فارغ | 0.7547 | clear-difference | موروثة (غائب) | نعم | لا |

## 3) قياس هوية المتكلم (فعلي، لا تقديري)

القياس أُعيد في هذه الجلسة على الملفات الـ51 كلها بأداة المشروع نفسها. المرجع = `apartment-sale-helmy-abdel-aaty-seraj-mall-230m.mp3` (cos = 1.0).

| المجموعة | العدد | المدى المقاس |
|---|---:|---|
| الخمسة الأخيرة (الدفعة 8) | 5 | 0.9569 – 0.9751 (كلها ≥ حد «نفس الصوت» 0.9351) |
| الـ44 الأقدم | 44 | 0.7547 – 1.0000 |
| منها عند المرجع نفسه | 1 | 1.0000 |
| منها في النطاق الحرج (0.9116–0.9351) | 1 | 0.9143 |
| منها فوق 0.85 وتحت 0.9116 | 3 | 0.9039 – 0.9112 |
| منها تحت 0.85 | 39 | 0.7245 – 0.8491 |

النطاق المرجعي المقاس من السجل للمقارنة: «نفس الصوت» min=0.9116 · p5=0.9351 · median=0.9539. تصنيف الملفات الـ44 لا يغيّر حكمها التاريخي (موروثة) لكنه يثبت أن **39 ملفًا منها بعيد تمامًا** عن صوت المرجع، و4 في نطاق يحتاج موافقة/تجاوزًا. هذا سبب دمجها في التوحيد.

## 4) مطابقة النص واللهجة والافتتاحية والـCTA

| البند | النتيجة المقاسة |
|---|---:|
| نصوص تستخدم CTA المرجعية بالمتكلم | 7 (المرجع + الخمسة الأخيرة + `golden-square-garden-156m`) |
| نصوص تستخدم صيغة الغائب الموروثة («كلم سمسار طلبك…») | 42 |
| افتتاحيات تبدأ بسؤال ينتهي بـ«؟» | 17 من 49 |
| افتتاحيات خبرية (جملة تقريرية تبدأ بـ«شقة … للبيع») | 32 من 49 |
| نصوص فيها أرقام رقمية بدل الحروف | 8 |
| متوسط عدد الكلمات | 44.3 (المرجع 58) |

**قراءة الأسلوب:** الخمسة الأخيرة تتنوع في الخطاف (سؤال مساحة، سؤال موقع، «محتاج…»، جملة سكنية بسؤال، «عايز…») وتُنهي كلها بالـCTA المرجعية بالمتكلم، وبلا أرقام رقمية، وبمتوسط 52.8 كلمة. الـ44 القديمة تغلب عليها الافتتاحية الخبرية «شقة … للبيع/للإيجار»، وصيغة CTA بالغائب، و8 منها بأرقام رقمية، ومداها 33–58 كلمة. لذلك **التوحيد المطلوب حقيقي ومقاس**، وليس تجميلًا.

## 5) الملفات القديمة المختلفة فعلًا (المستهدفة بالاستبدال)

العدد: **43** ملفًا = الـ44 الأقدم ناقص **المرجع** الذي اختاره المالك (لا يُلمس: بصمته مثبتة في المواصفة وتتحقق منها البوابة). كل بصمة أصلية محفوظة قبل أي تغيير في `_diag/audio-batch9-replacement-ledger.json`.

| # | slug | SHA-256 الأصلي | cos الأصلي | الجلسة الأصلية |
|---:|---|---|---:|---|
| 1 | `commercial-shop-for-rent-nozha-street-nasr-city` | `89cbcf9f3056d8dd9e04f1fb89f701bd3e53ffb70d645f07bf5321f2f21e4d34` | 0.7547 | batch3 (2026-10-15) |
| 2 | `rent-waha-50th-street-163m` | `5ad389d1b121bf3fe310d678fdc70047e6ced38c84af25236d13400ef2430f1b` | 0.7657 | batch3 (2026-10-15) |
| 3 | `apartment-rent-gamal-dewidar-enppi-nasr-city-160m` | `8156b84f42e0ee0fded536e04d8bcec6bf774e58c04eba2032a95fa67164a148` | 0.7851 | batch3 (2026-10-15) |
| 4 | `makram-ebid-177m` | `a24a30befbf44af1973e3afe0525c10df8c85477d2fd80a0a2cb02b3ab7f196e` | 0.7857 | batch3 (2026-10-15) |
| 5 | `rent-abdel-hamid-lotfy-tayaran-150m` | `79b189395d25b0311353f35c4b074da4a41c1dbbfdb50809bec7724ee3e1b345` | 0.7936 | batch3 (2026-10-15) |
| 6 | `rehab-villa-model-h-gate9` | `f49fb304f877e442a3fead8821354873fbadbd01652c50080e5b295daef20427` | 0.8034 | batch3 (2026-10-15) |
| 7 | `ali-amer-240m` | `a98be4bc95f1aeaa68ae98ac17fec20932018d3c181e4ab32323f7c2eca93775` | 0.8053 | batch7 (2026-10-16) |
| 8 | `safarat-safwa-170m` | `354f9b19411a5766e2d646462f4c52d371d7f2e6da8b1319265d8b3724e614cf` | 0.8054 | batch7 (2026-10-16) |
| 9 | `degla-landmark-122m-rent` | `65e10976244b9eda573541497a14f6efea58a211203933cb3d5ff5471434671e` | 0.8067 | batch7 (2026-10-16) |
| 10 | `commercial-mohamed-hasan-elgamal` | `5b509764e3f0fb729ea8908861108cd8fcfbaf6efb9d7ebe370eef470e8bc259` | 0.8104 | batch4 (2026-10-16) |
| 11 | `office-storage-rent-hassanein-heikal-nasr-city-73m` | `3905ec0ae9d9f2d84cb27fe2975a9c1981fab0e074c69e24c1ad2ce4c42e7ce6` | 0.8109 | batch2 (2026-10-15) |
| 12 | `apartment-sale-rabaa-investment-abbas-elakkad-165m` | `766a5f7a9f66691dee286c67016be883ae36be560f40a36e185b97a294950c3f` | 0.8113 | batch3 (2026-10-15) |
| 13 | `apartment-sale-abdul-halim-abdullah-195m` | `41144f92e1db328a326e9a49757dd603fe490f2d8fc9468f23a54c030584b3d6` | 0.8134 | batch3 (2026-10-15) |
| 14 | `commercial-hq-rent-kabul-street-nasr-city-130m` | `a0952c86b1dbdb0d1e04cc91d3d8b00e5985aca995568fab9a0501771baafad5` | 0.8144 | batch7 (2026-10-16) |
| 15 | `administrative-unit-rent-nasr-city-41m` | `5d3e6fdc1419662f3e88109a5732e8f0c62387ec1564aa3c97b5791ed85c6ee2` | 0.8145 | batch3 (2026-10-15) |
| 16 | `luxury-apartment-rent-al-azhar-street-nasr-city-200m` | `9f5c4d9a4c1ad4a62f1a913070fc7dfdd95df3989db3f1ae974c1dd67aa3f064` | 0.8201 | batch2 (2026-10-15) |
| 17 | `kabul-st-makram-ebeid-260m` | `04c69a45044be8663af88912ae35fa93dd12c5c73817a4aeec5b37d10319a222` | 0.8225 | batch4 (2026-10-16) |
| 18 | `apartment-sale-makarif-6th-district-130m` | `4d5fc7d29eaf113f7c3e45246333ad9e3b3a64093f90107bd853d1b0411d68cb` | 0.8231 | batch3 (2026-10-15) |
| 19 | `makram-ebid-main-250m` | `6077222c9469a33d70b3fcecdb23a6702bc034bc908678ab4b1f55652ee942c3` | 0.8246 | batch7 (2026-10-16) |
| 20 | `sanhoori-luxury-250m` | `ac9e1009533854eed93a2d3e44c1888e5e9a59f594c6a83f59d3804c70b6ea2a` | 0.8246 | batch7 (2026-10-16) |
| 21 | `ibrahim-nawara-175m` | `964d0687973c4ec7133c06ed5a38793a3d7c948bf070f7638c0c788f266298d5` | 0.8253 | batch6 (2026-10-16) |
| 22 | `furnished-apartment-rent-hayat-compound-safarat-200m` | `42e7026d9dbca88d59483390760bf50bb457fa8b2ff762ba11f610211f8f85b9` | 0.8270 | batch2 (2026-10-15) |
| 23 | `apartment-sale-international-park-nasr-city-215m` | `b834abbc18332a6e4fa35e568c4f5f3d8876328608d42daec2dfc9efa1853935` | 0.8282 | batch4 (2026-10-16) |
| 24 | `admin-rent-nozha-main-260m` | `326d70b377dae0175846deebfe8c8a84e23d0ef15076a1878709dabe3aea8397` | 0.8321 | batch4 (2026-10-16) |
| 25 | `genena-mall-186m-office-residence` | `668290009d62d6ae8b9761af42c783a3e971538a59fb1d31ffa9716f0e4aff70` | 0.8391 | batch4 (2026-10-16) |
| 26 | `apartment-sale-gamal-afifi-ahly-club-250m` | `2eb4e243fb6a4acdcd2ee316b8a558c75681c24b3ddc88dbf41aa1b754a85762` | 0.8405 | batch2 (2026-10-15) |
| 27 | `int-park-140m-furnished` | `7b46469c754a4f7adf303163e1c8862feeb70f6af5ae3c8f76e11a497044ede8` | 0.8456 | batch4 (2026-10-16) |
| 28 | `apartment-sale-egyptair-nasr-city-125m-furnished` | `4e5346e80eb21b45009544b0982d7d28ba5de00e430595e1fc4a7da31e0105d4` | 0.8460 | batch2 (2026-10-15) |
| 29 | `villa-new-cairo-1st-district-568m` | `0ad30545587d9c185324d3d41e15a7f5fb729b8c3a9896d7f33921f75ec7432d` | 0.8491 | batch4 (2026-10-16) |
| 30 | `shop-rent-makram-ebeid-67m` | `d477736938387c1507427b3b44ad709849e77a5c074c2c433d384e55506236f6` | 0.8537 | batch4 (2026-10-16) |
| 31 | `shop-abbas-elakkad-60m-jan26` | `0e92ee4940e629389af53f7cca2b4e632d501644662eb2d367af9232cb6ded3c` | 0.8568 | batch6 (2026-10-16) |
| 32 | `villa-south-90th-120m` | `df397b9bcbbcc405485247843cdb8a635dd34af392ea535013793e1303aa9c02` | 0.8659 | batch6 (2026-10-16) |
| 33 | `shaka-nour-deen` | `abf86029dffe077e14cc93d3bc4c1516679db82662bbf86dc605d3f53b5752b4` | 0.8669 | batch5 (2026-10-16) |
| 34 | `shams-club-heliopolis-160m` | `fe06556889a78cbac07959cf49eaaf0fe6430069c1a2eeae61d72b7f8f5faac4` | 0.8692 | batch4 (2026-10-16) |
| 35 | `abu-dawood-fakhry-167m` | `456d61fa435c7573694e099fda3db57a8fde42a3e2fbb0bf4a259deecd00f4e8` | 0.8707 | batch6 (2026-10-16) |
| 36 | `truegate-compound-waha-108m` | `1c70e7a51a98c75edbbdce4267963463835a64a86794514c13022c8a540ad647` | 0.8735 | batch4 (2026-10-16) |
| 37 | `ismail-wahby-160m-luxury` | `3260fa3e57eafa34205c55605170aa6f395b20cd2bb8003b159eaa2710c17315` | 0.8803 | batch6 (2026-10-16) |
| 38 | `apartment-sale-al-hayat-towers-nasr-city-162m` | `6352bd42f3073a9f90aef0fb69a6cf2806baf01e601c2f1b4c74f0236f1e4972` | 0.8920 | batch5 (2026-10-16) |
| 39 | `apartment-for-sale-khedr-eltouny-tayaran-120m` | `473cd73b187f9e797d09eaa73946365af732d1855d61d0d23a9a0dc6b60f9d06` | 0.8959 | batch5 (2026-10-16) |
| 40 | `apartment-sale-abbas-elakkad-refaai-200m-roi` | `29d1d678eaa2719c34d7ba2f9aaeafeffb56f3f281cb4cfaedae73db151d511a` | 0.9039 | batch5 (2026-10-16) |
| 41 | `golden-square-garden-156m` | `bc8a10c088a1cf21e28a3145fbaf33d7c9dad93220b4d1b3000c88945833544f` | 0.9071 | test-ad (2026-10-18) — مسار الإنتاج الموحّد |
| 42 | `abdel-azim-ghalmi-200m-expat` | `e163142e8549afbe02007b9b153d2731057595b4721a454cd032fd6d7333a5a9` | 0.9112 | batch5 (2026-10-16) |
| 43 | `apartment-sale-hassan-hassanein-heikal-200m` | `1b2289c91c1747ba324ee0e7f43109c0f40b8dd93ea687460b52965b1b053173` | 0.9143 | fix (2026-10-17) |

## 6) الصفحات الـ55 بلا صوت — فرز الأهلية

كل صفحة فُحصت بياناتها الأساسية. الصفحات التي سعرها غير رقمي أو ملتبس تُستبعد من الإنتاج وتُحصر صراحةً في تقرير الدفعة بدل إخفائها. النتيجة التفصيلية في `_diag/audio-batch9-2026-10-19.md`.

## 7) حدود هذا التدقيق (بلا تجميل)

- **لا ASR متاح** ⇒ لا تحقق من صحة النطق كلمة بكلمة؛ الفحص نصي (لهجة/أرقام/بنية) وقياسي (إيقاع، F0، طيف).
- **لا استماع بشري** لهذه الملفات في هذه الجلسة؛ الحكم السمعي الوحيد المسجَّل هو معاينات المالك السابقة.
- **GE2E مُدرَّب على الإنجليزية**؛ قيم cos تُقرأ **نسبيًا** إلى نطاق هذا المتن، لا كحدود عالمية.
- **المحرك لا يوفّر معرّف صوت دائم**؛ استمرارية الصوت في هذه الدفعة مضمونة داخل الجلسة الواحدة فقط، وهي مسجَّلة كقيد في التقرير النهائي.

