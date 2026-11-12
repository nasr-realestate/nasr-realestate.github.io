# دليل نشر إعلان عقاري جديد — من رسالة واحدة إلى النشر (`LISTING_PUBLISH_RUNBOOK.md`)

**الغرض:** عندما يرسل المالك رسالة مثل «انشئ وادمج وانشر هذا العرض» مع صورة وتفاصيل الوحدة،
هذا الملف هو المرجع الكامل لتنفيذ كل الخطوات دون أسئلة إضافية. آخر تحديث: 2026-11-08.

---

## 0. عقد المالك (اتفاقات دائمة لا تُناقَش)

- **صورة واحدة لكل إعلان**، جودتها متفق عليها كما أُرسلت: **لا تعديل محتوى إطلاقًا**
  (لا توليد بالذكاء الاصطناعي، لا إضافة عناصر، لا «تحسين» يغيّر الواقع). المسموح فقط:
  المعالجة التقنية المعيارية — قص واجهات مشغّل فيديو إن وُجدت، تحجيم، ضغط، تنسيق WebP/JPG.
- **الدمج والنشر فوريان** بعد خضرة الفحوص — لا انتظار موافقة إضافية ما دام الطلب الأصلي قال ذلك.
- الصوت دائمًا عبر مسار الإنتاج الموحّد (البند 4) — لا استثناءات صامتة.

## 1. المدخلات المتوقعة من المالك

- الصورة: مرفق محادثة (تصل إلى `/tmp/arena-coding-uploads/`) أو ملف على Google Drive.
- التفاصيل: المنطقة، المساحة، الدور/المصعد، السعر (بيع و/أو إيجار)، أي مميزات.
- إن غاب معطى جوهري (السعر مثلًا) اسأل سؤالًا واحدًا مجمّعًا ثم تابع.

## 2. التسمية

- `id`: لاتيني قصير `<مكان>-<مساحة>m` مثل `al-hayaa-al-arabia-110m`.
- `slug`: `<نوع>-<غرض>-<id>` مثل `apartment-sale-al-hayaa-al-arabia-110m`.
- ملف الصفحة: `_properties/YYYY-MM-DD-<slug>.md` (تاريخ اليوم).

## 3. الصورة (ImageMagick متاح؛ PIL غير مثبَّت في الصندوق)

1. انسخ الأصل إلى `assets/img/properties/<id>.webp` (حوّل الصيغة إن لزم).
2. إن كانت لقطة شاشة من مشغّل فيديو: **قص شريط التحكم** (`convert -crop`) قبل أي شيء.
3. شغّل `node scripts/images/build-image-variants.mjs` — يولّد تلقائيًا:
   `-800w.webp` و`cards/<id>.webp` (800×600) ويضيف سطر الأبعاد في `_data/image_dims.yml`.
4. صورة المشاركة `assets/img/properties/og/<id>.jpg` بنسبة ≈1.91:1 (مثال 710×373):
   - أصل أفقي: قصّ/تحجيم مباشر.
   - أصل رأسي: خلفية ضبابية من نفس الصورة + الصورة كاملة في المنتصف:
     `convert src -resize WxH^ -gravity center -extent WxH -blur 0x10 -modulate 88 bg.jpg`
     ثم `composite` للصورة بارتفاع الإطار.
5. في front matter: `image_file: "<id>.webp"` و`image: "/assets/img/properties/og/<id>.jpg"`.
   **لا تضف `image:` لملف غير موجود** — بوابة الصور تفشل.

## 4. الصفحة والصوت

- انسخ front matter من أحدث إعلان مشابه في `_properties/` (المرجع الحي للحقول:
  title/location/price/priceNumeric/category/area/areaNumeric/floor/status/meta_*).
- `category` بدون علامات اقتباس وبالقيم المعتمدة (`apartments`, `apartments-rent`,
  `commercial`, `offices`, `shops`, `villas`, `admin-hq`).
- الصوت: **المصدر الوحيد** `_data/voice_identity.json` عبر `scripts/audio/produce-audio-ad.mjs`؛
  القيد في `_data/audio_voice_log.json`؛ البوابة `scripts/audio/verify-voice-identity.mjs`.
  النص بالعامية المصرية ≈25–30 ثانية وينتهي بدعوة واتساب «سمسار طلبك».

## 5. طبقة الذكاء — في نفس الـcommit إلزاميًا

بعد أي إضافة/تعديل في `_properties/`:

```
node scripts/build-ai-artifacts.mjs --out=.
node scripts/build-listing-facets.mjs
node scripts/check-ai-artifacts-in-sync.mjs
```

`verify-ai-layer` في CI يفشل إذا اختلف `ai-feed.json.total_count` عن عدد ملفات `_properties/*.md`.

## 6. الاختبار ثم النشر

1. `npm ci` إن لم تكن `node_modules` موجودة، ثم `npm test` (الكل أخضر، لا استثناءات).
2. commit واحد شامل → push → `gh pr create` → انتظر خضرة الفحوص →
   `gh pr merge <N> --squash` → تأكد أن تشغيل `deploy.yml` على master انتهى **success**.

## 7. مطبات معروفة في بيئة الصندوق (لا تُعِد اكتشافها)

- `curl` إلى الموقع الحقيقي يرجع `000` (حجب شبكة) ⇒ تحقَّق من النشر عبر CI فقط.
- لا Ruby/Jekyll محليًا ⇒ لا بناء `_site` محلي؛ اعتمد على CI.
- سجلات `gh run view --log-failed` قد تفشل بـ`EOF` ⇒ استخدم check-run annotations
  (`gh api repos/…/check-runs/<id>/annotations`) أو أعد الفحص محليًا.
- `_requests` قد تكون فارغة (`.gitkeep` فقط) — هذا طبيعي ولا يُعاد شرط `length > 0`.

> هذا الملف مرجع داخلي: مستبعد من النشر العلني عبر `exclude` في `_config.yml`،
> ومُشار إليه من [`AGENTS.md`](./AGENTS.md) §3.
