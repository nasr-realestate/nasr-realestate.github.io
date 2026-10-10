# تنبيهات Web Push — تشغيل وصيانة النظام (2026-10-10)

ملخص معماري للنظام الجديد (بديل Firebase/FCM) على `royal-snow-ea32`.

## المكوّنات

| المكوّن | الملف | الدور |
|---|---|---|
| مسارات الإشعارات | `_worker/worker.js` (قسم WEB PUSH) | `/push/config` · `/push/subscribe` · `/push/unsubscribe` · `/push/send` |
| Service Worker | `sw.js` (معالجا `push` و`notificationclick` فقط) | عرض الإشعار وفتح رابطه الرسمي — الكاش كما هو |
| واجهة المستخدم | `notifications.html` + `_includes/push-notifications.html` + `assets/js/push-notifications.js` | «فعّل التنبيهات» / «أوقف التنبيهات» — الإذن عند الضغط فقط |
| مشغّل الإرسال | `.github/workflows/send-notification.yml` + `.github/scripts/push-notify.mjs` | يفعّل عند **إضافة** ملف إلى `_properties/` أو `_requests/` فقط |
| الإعداد المحكوم | `.github/workflows/push-notify-setup.yml` | verify (قراءة) / configure (KV + أسرار + نشر مُحكم) |

## البنية التحتية الحيّة (حساب `717c46b0d78a6f06589b8367a1a3cc5b`)

- Worker: `royal-snow-ea32` — bindings الحية كلها محفوظة:
  `d1/DB` (nasr-market-db) · `plain_text/GEMINI_MODEL` · `secret_text/GEMINI_API_KEY` · `secret_text/IMGBB_API_KEY`
  + إضافات الإشعارات: `kv_namespace/PUSH_SUBS` · `secret_text/VAPID_PRIVATE_KEY` · `secret_text/VAPID_PUBLIC_KEY` · `secret_text/PUSH_SEND_SECRET`.
- KV: namespace `nasr-push-subs` (id `6987204b82e146c897127283daa7bea5`) — مفاتيحه:
  `push:sub:<sha256(endpoint)>` للاشتراكات و`push:sent:<commitSha>:<path>` لذاكرة منع التكرار (30 يومًا).
- المفتاح العام VAPID يُقرأ من `/push/config` وقت التشغيل — لا يُدمج في الكود.

## الأسرار (كلها خارج Git والسجلات)

- `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY`: زوج VAPID (يُولَّد داخل المشغّل ولا يُطبع).
  **لا تُدار من المتصفح أو من Git.** تدويرها يلغي الاشتراكات القائمة فعليًا.
- `PUSH_SEND_SECRET`: يحمي `/push/send`. قيمته إما سر GitHub صريح `PUSH_SEND_SECRET`
  أو (افتراضيًا) اشتقاق `HMAC-SHA256(<CLOUDFLARE_API_TOKEN>, "nasr-realestate/push-send/v1")`
  — نفس التحويل في `send-notification.yml` و`push-notify-setup.yml`.
  عند تدوير توكن Cloudflare: أعد تشغيل `push-notify-setup` بوضع `configure` لتحديثه.
- إن أردت سرًا مستقلًا: أنشئ قيمة عشوائية (`openssl rand -hex 32`) وضعها في
  GitHub Secret باسم `PUSH_SEND_SECRET` وفي Worker Secret بنفس الاسم — بدون طباعتها هنا.

## قواعد الإرسال (مطبّقة على الطرفين)

- إضافة ملف فقط (`--diff-filter=A`) إلى `_properties/` أو `_requests/`؛ التعديل والحذف لا يُرسلان.
- idempotency: `commitSha:filePath` في KV — إعادة تشغيل الـWorkflow لا تكرر الإشعار.
- التشغيل اليدوي (`workflow_dispatch`) لا يرسل شيئًا إلا بوضع `test-single`
  مع معرّف جهاز واحد (من صفحة `/notifications.html`) — **لا إرسال جماعي تجريبي**.
- بيانات عامة فقط في النص (العنوان/السعر/الموقع) + حارس PII في الـWorker
  (يرفض أي نص يشبه أرقام الهواتف) + روابط ضمن نطاق الموقع الرسمي فقط.
- الاشتراكات المنتهية (404/410 من مزود Push) تُحذف تلقائيًا وتُحتسب في `removed`.
- فشل كل التسليمات → HTTP 502 → **يفشل الـWorkflow**؛ الفشل الجزئي يُبلَّغ بالأعداد.

## الاختبار بعد النشر (جهاز واحد)

1. افتح `https://nasr-realestate.github.io/notifications.html` على الجهاز واضغط «فعّل التنبيهات».
2. اضغط «نسخ معرّف الاشتراك» (16 حرفًا — ليس سرًا).
3. من GitHub: Actions ← «إرسال إشعار عند إضافة عقار أو طلب جديد» ← Run workflow
   ← mode=`test-single`، والصق المعرّف في `target` (اختياري: `file_path` لملف حقيقي).
4. يجب أن يصل إشعار «🧪 اختبار: …» على ذلك الجهاز فقط. اضغط عليه فيفتح الرابط الصحيح.

## iPhone/iPad (iOS)

- Apple تتطلب تثبيت الموقع كتطبيق (Share ⬆︎ ← Add to Home Screen) وفتحه من الشاشة
  الرئيسية، وiOS 16.4+. داخل Safari العادي لا تعمل تنبيهات الويب على iOS.
- الواجهة تعرض الإرشادات تلقائيًا عند اكتشاف iOS غير المثبَّت، وبديل واتساب عند عدم الدعم.

## إزالة Firebase (لاحقًا — لا الآن)

`firebase-messaging-sw.js` وسر `FIREBASE_SERVICE_ACCOUNT` ومشروع Firestore (`fcmTokens`)
مُبقاة عمدًا حتى ينجح النظام الجديد في اختبار جهاز حقيقي. بعد النجاح:
1. احذف `firebase-messaging-sw.js` + إدخال `keep_files` في `_config.yml`.
2. احذف سر `FIREBASE_SERVICE_ACCOUNT` من GitHub وcollection `fcmTokens` من Firestore
   (أو المشروع كاملًا إن لم يُستخدم لغير ذلك) — بعد التأكد من عدم وجود اعتماد آخر.

## الاختبارات

`node --test _worker/tests/push-notifications.test.mjs` — 18 اختبارًا تشمل
متجه RFC 8291 الرسمية (Appendix A) والتحقق من توقيع VAPID (RFC 8292) وحدود
المعدّل ومنع التكرار وتنظيف الاشتراكات وحارس الخصوصية.

## فحص الحالة الحيّة

شغّل «Push Notifications Setup» بوضع `verify` (أو ادفع تعديلًا على ملفه):
مخرجاته توثّق bindings والمعرّفات و`live_sha` وفحوصات GET/OPTIONS دون أي تغيير.
