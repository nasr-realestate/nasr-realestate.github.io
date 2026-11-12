# نقل WhatsApp Business إلى CRM من antiX 32-bit

مسار محلي متكرر ينسخ محادثات **WhatsApp Business على Android** من نسخة احتياطية مشفّرة، يفكّها ويصدّر النص على جهازك، ثم يرفع **المحادثات الجديدة أو المتغيّرة فقط** إلى مجلد Google Drive الموجود الذي يستقبل منه نظام CRM. لا يتصل بواتساب حيًا، ولا يرفع صورًا/صوتًا/مستندات، ولا يحذف أو يستبدل أي ملف موجود في Drive.

> كل الاختبارات المرفقة تستخدم بيانات اصطناعية. لا تضع نسخة حقيقية أو مفتاحًا أو ملف محادثة داخل مستودع Git العام.

## ما الذي يفعله الأمر الواحد؟

```text
msgstore.db.crypt15 (من الهاتف عبر USB)
        │  wadecrypt محليًا
        ▼
SQLite مؤقت الخاصة
        │  export_android.py (نص فقط)
        ▼
مقارنة مع state.json المحلي
        │  الجديد/المتغيّر فقط
        ▼
WA-SYNC__<ref>__<sha>.zip  (chat.txt + crm-sync.json)
        │  rclone copy --immutable
        ▼
مجلد Drive الموجود «قاعده العملاء نظام CRM»
        │  مسار CRM القائم
        ▼
build-whatsapp-import.mjs → sealed sync bundle
```

- الهوية محلية: `JID → conversation_uid` يتجمّد بعد أول رؤية، فتغيير اسم جهة الاتصال لا ينشئ محادثة ثانية.
- الحالة تُحفظ **بعد** التحقق من الحجم وMD5 في Drive، وليس قبله.
- إعادة تشغيل الأمر على نفس النسخة = `unchanged` وبلا رفع.
- التعديل/الحذف في تاريخ قديم = `hold_history_changed` وخروج 3 للمراجعة، لأن مسار CRM الحالي append-only ولا يصالح الرسائل المعدّلة بأمان.
- النسخة الفارغة لمحادثة معروفة = `hold_empty_backup`. تصادم اسم/هوية = `hold_identity_collision`.
- المحادثة المختفية من النسخة الجديدة تُعدّ في `missing_from_backup` ولا تُحذف من الحالة ولا من Drive.

## المتطلبات

- antiX 23 / Debian 12 تقريبًا، معمارية i686 أو x86_64.
- **Python 3.11** بالضبط (الحزم مثبتة ببصمات cp311). تحقّق: `python3 --version`.
- هاتف Android عليه **WhatsApp Business** (`com.whatsapp.w4b`)، ونسخة احتياطية محلية كاملة مشفّرة `crypt15`.
- مفتاح النسخ الاحتياطي 64 خانة hex من شاشة النسخ المشفر داخل WhatsApp Business. **لا يُكتب في المحادثة ولا في سجل الأوامر.**
- حساب Google Drive الذي فيه مجلد CRM، وعميل OAuth خاص بك لـ rclone (لم يعد العميل المشترك يعمل في 2026).

## 1) انسخ النسخة الاحتياطية عبر USB

بعد الضغط على **Back up** داخل WhatsApp Business، انسخ الملف الكامل عبر USB إلى مسار ثابت على الجهاز، مثلًا:

```text
~/nasr-wa-sync/inbox/msgstore.db.crypt15
```

مسار الملف على الهاتف غالبًا أحد هذين:

```text
/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Databases/msgstore.db.crypt15
/sdcard/WhatsApp Business/Databases/msgstore.db.crypt15
```

لا تستخدم ملفات `msgstore-increment-*`؛ الأمر يرفضها ويطلب النسخة الكاملة. ويرفض الأمر أيضًا `crypt14`: فعّل النسخ الاحتياطي المشفر طرفًا لطرف بمفتاح 64 خانة حتى تحصل على `msgstore.db.crypt15`.

## 2) جهّز rclone مرة واحدة

يثبّت `setup.sh` نسخة rclone مثبتة البصمة (`v1.76.0`) داخل `~/nasr-wa-sync/bin` ويُفضّلها على
نسخة النظام حتى لو كانت موجودة (Debian 12 يوفّر `1.60.1-DEV` القديمة). بعد التنزيل يتحقق أن
الثنائي يعمل فعلًا على المعالج؛ لو لم يعمل حُذف الملف واستُخدم rclone النظام مع تحذير في `doctor.py`.
لو ظهر عندك إصدار غير المراجعة، ثبّت النسخة المراجعة يدويًا:

```sh
python3 scripts/antix-wa-sync/install_rclone.py --home "$HOME/nasr-wa-sync"
"$HOME/nasr-wa-sync/bin/rclone" version
```

ثم أنشئ remote:

```sh
rclone config
```

اختر:

- name: `nasr-wa`
- Storage: `drive`
- client_id / client_secret: من عميل OAuth خاص بك في Google Cloud (نوع Desktop app، مع تفعيل Google Drive API).
- scope: `drive` مع تقييد `root_folder_id` بمجلد CRM. إن اخترت `drive.file` فلن يرى rclone الملفات القديمة، وتبقى الحالة المحلية هي مرجع منع التكرار.
- root_folder_id: معرّف مجلد «قاعده العملاء نظام CRM» من رابط Drive.
- على جهاز بلا متصفح: اختر manual/headless config وأكمل التفويض من جهاز آخر.

تحقّق قراءة فقط:

```sh
rclone lsf nasr-wa: --max-depth 1
```

الأداة تستخدم `copy --immutable` و`lsjson` فقط؛ لا تستخدم `sync` ولا `delete` ولا تستبدل أصلًا موجودًا.

## 3) الإعداد المحلي الآمن

لتثبيت الأدوات فقط، بلا أي سؤال وبلا مفتاح (مناسب للتجهيز المسبق):

```sh
sh scripts/antix-wa-sync/setup.sh --deps-only
```

وللإعداد الكامل، من جذر المستودع:

```sh
sh scripts/antix-wa-sync/setup.sh
```

يسألك عن:

1. مسار `msgstore.db.crypt15` المنسوخ.
2. اسم remote المنتهي بنقطتين، مثل `nasr-wa:`.
3. المفتاح 64 hex عبر إدخال مخفي (`getpass`)، ويُحفظ في `~/nasr-wa-sync/encrypted_backup.key` بصلاحية 600.

كل شيء خاص يعيش خارج Git في `~/nasr-wa-sync` (أو `NASR_WA_HOME`).

### فحص الجاهزية (قراءة فقط)

```sh
python3 scripts/antix-wa-sync/doctor.py
python3 scripts/antix-wa-sync/doctor.py --require-config
```

يفحص: نسخة Python والمعمارية، صلاحيات المجلد الخاص، الحزم المثبتة داخل البيئة الافتراضية،
وجود `wadecrypt` و`rclone`، صيغة النسخة `crypt15` وحجمها وتاريخها، صلاحية المفتاح 600،
أن مجلد الحالة خارج Git، وأن remote معرّف ومربوط بـ OAuth ومضبوط على `root_folder_id`.
لا يفك تشفيرًا ولا يقرأ محتوى المفتاح ولا يطبع أي سر، وينتهي بـ `DOCTOR_OK` أو `DOCTOR_FAIL`.
رمز الخروج `1` عند وجود أي `FAIL`.

الأوامر المدمجة خطوة بخطوة موجودة في `EXECUTION_PLAN_AR.md` (كتل A ثم A2 ثم USB ثم B1 ثم B2 ثم C).

## 4) الأمر المتكرر

تجربة بلا رفع ولا تغيير الحالة:

```sh
sh scripts/antix-wa-sync/sync.sh --dry-run
```

تجهيز محلي فقط:

```sh
sh scripts/antix-wa-sync/sync.sh --prepare-only
```

النقل الفعلي بعد نسخ نسخة جديدة من الهاتف:

```sh
sh scripts/antix-wa-sync/sync.sh
```

 رموز الخروج:

- `0`: تم، أو لا جديد.
- `1`: توقف آمن (مفتاح/نسخة/أداة/تحقق فشل). لم تُحدَّث الحالة بعد رفع غير متحقق.
- `3`: توجد محادثات معلّقة للمراجعة (`hold_*`). اقرأ `~/nasr-wa-sync/state/last-run.json`.
- `4`: مزامنة أخرى تعمل بالفعل.

## cron بدون systemd

بعد نجاح التجربة اليدوية، يمكن جدولة الأمر عبر cron العادي (لا يحذف شيئًا):

```cron
*/30 * * * * /bin/sh /path/to/repo/scripts/antix-wa-sync/sync.sh >> $HOME/nasr-wa-sync/cron.log 2>&1
```

يبقى نسخ النسخة الاحتياطية من الهاتف عبر USB خطوة يدوية؛ cron يكرر التجهيز/الرفع فقط عندما تتغيّر النسخة الموجودة في المسار المحدد.

## الاختبارات

```sh
python3 -m unittest discover -s scripts/antix-wa-sync/tests -v
node --test scripts/tests/crm-whatsapp-import.test.mjs scripts/tests/antix-wa-sync.test.mjs
npm test
```

اختبارات Orchestrator تستخدم أدوات وهمية وrclone وهمي محلي؛ لا شبكة ولا Drive حقيقي. دورة crypt15 الاصطناعية الكاملة تُجرى محليًا قبل أي نقل حقيقي.

## حدود معروفة

- النص فقط؛ الوسائط placeholders مثل `[صورة]` / `[صوت]`.
- النسخة متعددة الملفات/Incremental غير مدعومة في هذا الإصدار؛ انسخ النسخة الكاملة.
- تعديل/حذف الرسائل القديمة يعلّق المحادثة للمراجعة بدل خلق تكرار غير آمن.
- المجلدات/الحالة/المفتاح يجب أن تبقى خارج مستودع Git العام وبصلاحيات 700/600.
