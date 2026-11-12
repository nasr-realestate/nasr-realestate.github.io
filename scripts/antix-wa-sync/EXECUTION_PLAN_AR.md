# خطة التنفيذ خطوة بخطوة — antiX 32-bit + WhatsApp Business

هذه الخطة مرتبة بحيث **لا تنتقل إلى الخطوة التالية إلا بعد نجاح الخطوة الحالية**.  
كل خطوة فيها: **الفائدة**، **كيف تنفذها صح**، **الناتج المتوقع**، و**متى تتوقف**.

> قواعد ثابتة:
>
> - لا ترسل مفتاح الـ64 hex في المحادثة أبدًا.
> - لا تضع نسخة احتياطية حقيقية أو ملف محادثة أو `state.json` داخل مجلد المستودع.
> - لا تستخدم `rclone sync` أو `rclone delete` أو أي أمر حذف على Drive.
> - أول نقل حقيقي لا يحدث إلا بعد نجاح `--dry-run` ثم `--prepare-only`.

---

## المسار المدمج — كتل متسلسلة بدل 11 خطوة

نفس أوامر الخطوات بالأسفل، مجمّعة في كتل تُنفَّذ بلصقة واحدة. كل كتلة تعمل بـ `set -eu`:
**تتوقف عند أول خطأ** ولا تكمل فوقه، وتطبع في النهاية علامة نجاح أو فشل.

- **كتلة A**: فحص النظام + تثبيت الناقص + جلب الكود + تثبيت الأدوات + اختبارات السلامة. بلا مفاتيح وبلا Drive.
- **كتلة A2**: تثبيت rclone بالمراجعة `v1.76.0` إن كان النظام يوفّر إصدارًا أقدم.
- **كتلة USB**: نسخ `msgstore.db.crypt15` من الهاتف إلى المسار الخاص والتحقق من التطابق بايت ببايت.
- **كتلة B1**: ربط Drive بأمر واحد والتحقق قراءة فقط. لا يحتاج النسخة الاحتياطية، فيمكن تنفيذه بالتوازي مع تجهيز الهاتف.
- **كتلة B2**: الإعداد الآمن + فحص الجاهزية + تجربة جافة + تجهيز محلي. بلا رفع.
- **كتلة C**: أول رفع حقيقي ثم إعادة التشغيل لإثبات عدم التكرار. لا تُنفَّذ إلا بعد مراجعة ناتج B2.

أداة الفحص `doctor.py` قراءة فقط: لا تفك تشفيرًا، لا تقرأ المفتاح، لا ترفع شيئًا،
ولا تطبع أي سر. تطبع `PASS/WARN/FAIL` ثم `DOCTOR_OK` أو `DOCTOR_FAIL`.

### كتلة A — البيئة والأدوات (بلا أي سر)

```sh
( set -eu
  as_root() { if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else su -c "$*"; fi; }
  need=""
  command -v git >/dev/null 2>&1 || need="$need git"
  python3 -c 'import venv, ensurepip, ssl' >/dev/null 2>&1 || need="$need python3-venv"
  [ -d /etc/ssl/certs ] || need="$need ca-certificates"
  if [ -n "$need" ]; then as_root apt-get update; as_root apt-get install -y $need; fi
  python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 11) else 1)' || { echo PYTHON_NOT_3_11; exit 1; }
  mkdir -p "$HOME/nasr-crm"
  cd "$HOME/nasr-crm"
  if [ -d nasr-realestate.github.io/.git ]; then
    git -C nasr-realestate.github.io pull --ff-only
  else
    git clone --branch arena/610d583d-nasr-realestate-github-io --single-branch https://github.com/nasr-realestate/nasr-realestate.github.io.git
  fi
  cd nasr-realestate.github.io
  sh scripts/antix-wa-sync/setup.sh --deps-only
  mkdir -p "$HOME/nasr-wa-sync/inbox"
  chmod 700 "$HOME/nasr-wa-sync" "$HOME/nasr-wa-sync/inbox"
  "$HOME/nasr-wa-sync/venv/bin/python" -m unittest discover -s scripts/antix-wa-sync/tests
  echo BLOCK_A_OK
) || echo BLOCK_A_FAILED
```

النجاح: `OK` من الاختبارات ثم `DOCTOR_OK` ثم `BLOCK_A_OK`.
تحذير واحد متوقع هنا: «الإعدادات غير منشأة بعد» — طبيعي لأن المفتاح لم يُدخل بعد.

### كتلة A2 — لو ظهر rclone بإصدار قديم

Debian 12 يوفّر `rclone v1.60.1-DEV`. النسخة المراجعة هي `v1.76.0` المثبتة بالبصمة.
لو قال `doctor.py` إن rclone «ليس النسخة المراجعة»، نفّذ:

```sh
( set -eu
  cd "$HOME/nasr-crm/nasr-realestate.github.io"
  git pull --ff-only
  python3 scripts/antix-wa-sync/install_rclone.py --home "$HOME/nasr-wa-sync"
  "$HOME/nasr-wa-sync/bin/rclone" version
  python3 scripts/antix-wa-sync/doctor.py
  ls -l "$HOME/nasr-wa-sync/inbox"
  echo BLOCK_A2_OK
) || echo BLOCK_A2_FAILED
```

يتحقق الأمر أن الثنائي يعمل على معالجك فعلًا؛ لو رفض المعالج النسخة الرسمية حُذف الملف
وبقي rclone النظام كما هو، وتظهر ملاحظة تحذير لا خطأ.

### كتلة USB — انسخ النسخة من الهاتف وتحقّق منها

اختر على الهاتف وضع **نقل الملفات (MTP)** لا «الشحن فقط»، ثم وصّل الكابل.
الكتلة تبحث عن `msgstore.db.crypt15` في نقاط الترك المعتادة، وتنسخه، ثم تقارن البايتات:

```sh
( set -eu
  DEST="$HOME/nasr-wa-sync/inbox"
  mkdir -p "$DEST"
  chmod 700 "$HOME/nasr-wa-sync" "$DEST"
  SRC=$(find /media /mnt "/run/user/$(id -u)/gvfs" -maxdepth 12 -type f -name 'msgstore.db.crypt15' 2>/dev/null | head -1)
  [ -n "$SRC" ] || { echo NO_PHONE_FILE_FOUND; exit 1; }
  printf 'المصدر: %s\n' "$SRC"
  install -m 600 "$SRC" "$DEST/.msgstore.copy"
  cmp -s "$SRC" "$DEST/.msgstore.copy" || { rm -f "$DEST/.msgstore.copy"; echo COPY_MISMATCH; exit 1; }
  mv -f "$DEST/.msgstore.copy" "$DEST/msgstore.db.crypt15"
  ls -l "$DEST/msgstore.db.crypt15"
  sha256sum "$DEST/msgstore.db.crypt15" | cut -c1-16
  echo BLOCK_USB_OK
) || echo BLOCK_USB_FAILED
```

`NO_PHONE_FILE_FOUND` يعني أن الهاتف لم يُركَّب أو أن الملف ما زال `crypt14`؛ لا تُعِد تسمية أي ملف.
لو لم يُركَّب الهاتف تلقائيًا، انسخ الملف بمدير الملفات إلى `~/nasr-wa-sync/inbox/` ثم أعد الكتلة.

### كتلة USB2 — لو لم يُركَّب الهاتف تلقائيًا (antiX بلا gvfs)

antiX خفيف ولا يركّب هواتف MTP تلقائيًا، لذلك `NO_PHONE_FILE_FOUND` لا يعني أن الملف غير موجود.
النسخ من الهاتف صار أمرًا واحدًا مرفقًا: `pull_backup.sh` يجرّب ADB أولًا (بلا تركيب)،
ثم MTP/الفلاشة، ويتحقق من البصمة قبل اعتماد الملف، ويضبط الصلاحية 600.

قبلها على الهاتف: **الإعدادات → حول الهاتف → انقر على إصدار MIUI سبع مرات** لتفعيل خيارات المطوّر،
ثم **الإعدادات الإضافية → خيارات المطوّر → تصحيح أخطاء USB**، ووصّل الكابل واختر **نقل الملفات**،
واقبل نافذة «السماح بتصحيح أخطاء USB» على الهاتف.

```sh
( set -eu
  cd "$HOME/nasr-crm/nasr-realestate.github.io"
  git pull --ff-only
  as_root() { if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else su -c "$*"; fi; }
  need=""
  command -v adb >/dev/null 2>&1 || need="$need adb"
  command -v jmtpfs >/dev/null 2>&1 || need="$need jmtpfs"
  if [ -n "$need" ]; then as_root apt-get update; as_root apt-get install -y $need; fi
  sh scripts/antix-wa-sync/pull_backup.sh
) || echo BLOCK_USB2_FAILED
```

النجاح: `نُقل عبر: adb` ثم الملف بحجمه الحقيقي وبصمته، ثم `PULL_BACKUP_OK`.
لو ظهر `unauthorized` في `adb devices` فالهاتف ينتظر موافقتك على نافذة السماح.
لو نسخْتَ الملف إلى فلاشة أو ركّبت الهاتف يدويًا، مرّر مساره مباشرة:

```sh
sh scripts/antix-wa-sync/pull_backup.sh --source "/media/only/USB/msgstore.db.crypt15"
```

هذه هي الطريقة نفسها التي ستستخدمها في كل مرة تنقل فيها نسخة جديدة لاحقًا.
بعد الانتهاء يمكن فك تركيب MTP بأمر `fusermount -u "$HOME/phone"`.

### كتلة B1 — ربط Drive (لا يحتاج النسخة الاحتياطية)

شرطها: عميل OAuth من نوع Desktop جاهز (الخطوة 5أ). تُنفَّذ الآن أو بعد تجهيز الهاتف، لا فرق.

```sh
( set -eu
  cd "$HOME/nasr-crm/nasr-realestate.github.io"
  RC="$HOME/nasr-wa-sync/bin/rclone"
  [ -x "$RC" ] || RC=rclone
  printf 'OAuth client_id: '; read -r CID
  printf 'OAuth client_secret (مخفي): '; stty -echo; read -r CS; stty echo; printf '\n'
  printf 'معرّف مجلد CRM: '; read -r FOLDER
  "$RC" config create nasr-wa drive client_id="$CID" client_secret="$CS" scope=drive root_folder_id="$FOLDER" config_is_local=true --obscure
  unset CID CS
  "$RC" lsf nasr-wa: --max-depth 1 | head -5
  "$RC" lsf nasr-wa: --max-depth 1 | grep -c '^WA-SYNC__' || true
  echo BLOCK_B1_OK
) || echo BLOCK_B1_FAILED
```

لو الجهاز بلا متصفح، استبدل `config_is_local=true` بـ `config_is_local=false` ونفّذ أمر
`rclone authorize` الذي يطبعه على جهاز فيه متصفح، ثم الصق النتيجة.

النجاح: أسماء ملفات مجلد CRM، ثم `0` (لا ملفات `WA-SYNC` بعد)، ثم `BLOCK_B1_OK`.

### كتلة B2 — الإعداد والتجربة الجافة (بلا رفع)

شرطها: نجاح B1 ووجود `~/nasr-wa-sync/inbox/msgstore.db.crypt15`.

```sh
( set -eu
  cd "$HOME/nasr-crm/nasr-realestate.github.io"
  test -s "$HOME/nasr-wa-sync/inbox/msgstore.db.crypt15" || { echo NO_CRYPT15; exit 1; }
  if [ -f "$HOME/nasr-wa-sync/config.json" ]; then
    echo CONFIG_EXISTS
  else
    sh scripts/antix-wa-sync/setup.sh
  fi
  python3 scripts/antix-wa-sync/doctor.py --require-config
  sh scripts/antix-wa-sync/sync.sh --dry-run
  sh scripts/antix-wa-sync/sync.sh --prepare-only
  echo BLOCK_B2_OK
) || echo BLOCK_B2_FAILED
```

`setup.sh` يسأل 3 أسئلة فقط: مسار النسخة، ثم `nasr-wa:`، ثم مفتاح الـ64 hex في شاشة مخفية.
الكتلة قابلة للإعادة: لو أُُنشئت الإعدادات سابقًا تتخطّى الأسئلة ولا تستبدل شيئًا.

النجاح: `DOCTOR_OK failures=0`، ثم سطر JSON فيه `"uploaded": 0`، ثم `BLOCK_B2_OK`.

### كتلة C — أول رفع ثم إثبات عدم التكرار

```sh
( set -eu
  cd "$HOME/nasr-crm/nasr-realestate.github.io"
  sh scripts/antix-wa-sync/sync.sh
  sh scripts/antix-wa-sync/sync.sh
  echo BLOCK_C_OK
) || echo BLOCK_C_FAILED
```

النجاح: التشغيل الأول `"uploaded": N`، والتشغيل الثاني مباشرة `"uploaded": 0` مع `unchanged: N`.
لو ظهر `hold_history_changed` أو أي `hold_` فتوقّف وأرسل لي سطر JSON فقط.

---

## الخطوة 0 — أرسل لي 3 معلومات فقط من جهاز antiX

**الفائدة:**  
أتأكد أن جهازك متوافق مع الحزم المثبتة قبل أن تبدأ تثبيتًا أو نقلًا. الحزم الحالية مضبوطة على Python 3.11 ومعمارية i686 أو x86_64.

**كيف تنفذها صح:**  
افتح Terminal على جهاز antiX ونفذ:

```sh
python3 --version
uname -m
grep PRETTY_NAME /etc/os-release
```

**الناتج المتوقع:**  
ثلاثة أسطر، مثلًا:

```text
Python 3.11.x
i686
PRETTY_NAME="antiX ..."
```

**أرسل لي:**  
هذه الأسطر الثلاثة فقط.

**توقف إذا:**

- لم يظهر `Python 3.11`.
- لم تكن المعمارية `i686` أو `x86_64`.
- ظهر خطأ أن `python3` غير موجود.

في هذه الحالات لا تكمل؛ سأعطيك أمر التثبيت المناسب لنسختك.

---

## الخطوة 1 — اجلب نسخة الكود التي تحتوي الأداة على جهازك

**الفائدة:**  
تشغل النسخة التي اختُبرت، وليس نسخة قديمة من `master` لا تحتوي `scripts/antix-wa-sync`.

**كيف تنفذها صح:**  
إذا كان `git` موجودًا:

```sh
mkdir -p "$HOME/nasr-crm"
cd "$HOME/nasr-crm"
git clone --branch arena/610d583d-nasr-realestate-github-io --single-branch https://github.com/nasr-realestate/nasr-realestate.github.io.git
cd nasr-realestate.github.io
test -f scripts/antix-wa-sync/sync.sh && echo CODE_OK
```

إذا لم يكن `git` موجودًا، ثبته أولًا. على antiX/Debian غالبًا:

```sh
sudo apt-get update
sudo apt-get install -y git
```

إذا لم يكن `sudo` مضبوطًا عندك، استخدم مدير الحزم في antiX أو أخبرني بالخطأ الذي يظهر.

**الناتج المتوقع:**

```text
CODE_OK
```

**توقف إذا:**  
لم يظهر `CODE_OK`، أو ظهر خطأ وصول إلى GitHub. أرسل نص الخطأ فقط.

---

## الخطوة 2 — جهّز نسخة احتياطية كاملة من WhatsApp Business على الهاتف

**الفائدة:**  
الأداة تقرأ نسخة محلية مشفّرة كاملة. لو النسخة ناقصة أو Incremental سيتوقف النقل عمدًا حتى لا تُفقد محادثات.

**كيف تنفذها صح:**

1. افتح **WhatsApp Business** على الهاتف.
2. ادخل إلى **الإعدادات** ثم **الدردشات** ثم **النسخ الاحتياطي للدردشات**.
3. تأكد أن **النسخ الاحتياطي المشفر تمامًا بين الطرفين** مفعّل، وأنك اخترت **مفتاح تشفير من 64 خانة** وليس كلمة مرور فقط.
   - إذا لم يكن مفعّلًا: فعّله، واختر استخدام مفتاح 64 خانة، واحفظ المفتاح في مكان آمن.
   - إذا كان مفعّلًا بكلمة مرور فقط: أخبرني قبل المتابعة؛ نحتاج مسارًا يعطيك مفتاح 64 خانة أو ملف مفتاح مناسب.
4. اضغط **نسخ احتياطي** وانتظر حتى يكتمل.
5. افتح مدير الملفات وتأكد أن الملف الحديث اسمه:

```text
msgstore.db.crypt15
```

**الناتج المتوقع:**  
نسخة احتياطية محلية حديثة باسم:

```text
msgstore.db.crypt15
```

**مهم إذا رأيت `crypt14`:**
ملفات `msgstore.db.crypt14` صحيحة كنوع نسخة احتياطية، لكن مسارنا الحالي يستخدم مفتاح 64 خانة لـ `crypt15`. إذا كان الموجود عندك `crypt14` فقط، فلا تنقله بعد؛ فعّل النسخ المشفر بين الطرفين بمفتاح 64 خانة ثم اعمل نسخًا احتياطيًا جديدًا حتى يظهر `msgstore.db.crypt15`.

**ملاحظة مهمة عن رسالة «جارٍ التشفير للمرة الأولى»:**
قد يستمر واتساب في عرض شريط التشفير/الرفع إلى Google Drive بعد أن تكون الملفات المحلية
`msgstore.db.crypt15` قد كُتبت فعلًا. مسارنا يقرأ **الملف المحلي فقط** ولا ينتظر سحابة جوجل.
العلامة الصحيحة أن ترى `msgstore.db.crypt15` بحجم مقارب لبقية النسخ وبتوقيت حديث.
الحماية ضد ملف يُكتب أثناء النسخ موجودة أصلًا: مقارنة بايت ببايت عند النسخ، ثم بصمة قبل
القراءة وبعدها، ثم فحص سلامة SQLite — أي تغيير يوقف النقل بدل أن يمرّ نصف ملف.

الملفات المؤرخة مثل `msgstore-2026-11-13.1.db.crypt15` نسخ دوّية احتياطية؛ لا نستخدمها.
المطلوب دائمًا الملف غير المؤرخ `msgstore.db.crypt15`.

**توقف إذا:**

- لم يكتمل النسخ الاحتياطي.
- لا تعرف مكان مفتاح الـ64 hex.
- ظهر لك فقط ملف اسمه `msgstore-increment-...`.
- الموجود `crypt14` وليس `crypt15`.

أخبرني بالحالة التي تراها، ولا تخمّن المفتاح.

---

## الخطوة 3 — انسخ النسخة الاحتياطية عبر USB إلى مسار خاص خارج المستودع

**الفائدة:**  
نجعل مصدر القراءة ملفًا محليًا ثابتًا، بعيدًا عن Git وبعيدًا عن أي اتصال واتساب حي.

**كيف تنفذها صح:**  
على جهاز antiX:

```sh
mkdir -p "$HOME/nasr-wa-sync/inbox"
chmod 700 "$HOME/nasr-wa-sync"
chmod 700 "$HOME/nasr-wa-sync/inbox"
```

ثم وصّل الهاتف عبر USB واختَر نقل الملفات. انسخ الملف الكامل إلى:

```text
~/nasr-wa-sync/inbox/msgstore.db.crypt15
```

مسار الملف على الهاتف غالبًا أحد هذين:

```text
/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Databases/msgstore.db.crypt15
/sdcard/WhatsApp Business/Databases/msgstore.db.crypt15
```

إذا نسخته يدويًا باسم مختلف، أعد تسميته إلى `msgstore.db.crypt15`.

تحقق على الجهاز:

```sh
ls -lh "$HOME/nasr-wa-sync/inbox/msgstore.db.crypt15"
```

**الناتج المتوقع:**  
ملف موجود وحجمه ليس صفرًا.

**توقف إذا:**

- الملف غير موجود.
- حجمه صفر.
- اسمه يحتوي `increment`.
- امتداده `crypt14` أو أي امتداد غير `crypt15`.
- نسخته بالخطأ داخل مجلد المستودع.

---

## الخطوة 4 — ثبّت الأدوات محليًا وأنشئ الإعدادات الآمنة

**الفائدة:**  
ينشئ بيئة Python معزولة وبصمات مثبتة، ويحفظ المفتاح بصلاحية 600 خارج Git.

**كيف تنفذها صح:**  
من جذر المستودع الذي جلبته في الخطوة 1، ثبّت الأدوات أولًا بلا أسئلة:

```sh
cd "$HOME/nasr-crm/nasr-realestate.github.io"
sh scripts/antix-wa-sync/setup.sh --deps-only
```

ثم الإعداد الكامل بعد جهوزية النسخة والمفتاح وremote:

```sh
sh scripts/antix-wa-sync/setup.sh
python3 scripts/antix-wa-sync/doctor.py --require-config
```

سيسألك بالترتيب:

1. مسار النسخة الاحتياطية. اكتب:

   ```text
   ~/nasr-wa-sync/inbox/msgstore.db.crypt15
   ```

2. اسم remote. اكتب:

   ```text
   nasr-wa:
   ```

3. مفتاح الـ64 hex. اكتبه أو الصقه في الشاشة المخفية.  
   لن يظهر على الشاشة ولن يُحفظ في سجل الأوامر.

إذا ظهر خطأ أن `venv` غير متاح، ثبّت حزمة Python venv من مدير حزم antiX، مثلًا:

```sh
sudo apt-get install -y python3-venv
```

ثم أعد تشغيل `setup.sh`.

**الناتج المتوقع:**

```text
Setup complete. Test: .../sync.sh --dry-run
```

**توقف إذا:**

- قال إن Python ليس 3.11.
- رفض المفتاح لأنه ليس 64 خانة hex.
- فشل تنزيل rclone أو الحزم.

أرسل رسالة الخطأ فقط، بلا مفتاح وبلا محتوى محادثات.

---

## الخطوة 5 — اربط Google Drive مرة واحدة عبر rclone

**الفائدة:**  
نعطي الأداة صلاحية رفع الملفات الجديدة فقط إلى مجلد CRM الموجود، بدون متصفح واتساب وبدون حذف أو استبدال.

**كيف تنفذها صح:**

### أ) أنشئ عميل OAuth خاصًا بك

1. ادخل إلى Google Cloud Console بحساب Google الذي يملك مجلد Drive.
2. أنشئ مشروعًا جديدًا باسم مناسب، مثل `nasr-wa-sync`.
3. فعّل **Google Drive API** داخل المشروع.
4. جهّز شاشة موافقة OAuth، وأضف بريدك كمستخدم اختبار إذا كانت في وضع الاختبار.
5. أنشئ **OAuth client ID** من نوع **Desktop app**.
6. احتفظ بـ `client_id` و`client_secret` لاستخدامهما في rclone. لا ترسلهما لي.

### ب) اعرف معرّف مجلد CRM

افتح مجلد «قاعده العملاء نظام CRM» في Google Drive من المتصفح.  
معرّف المجلد هو الجزء الأخير من الرابط بعد `/folders/`.

لا تكتبه في المستودع. ستضعه في إعداد rclone فقط.

### ج) اضبط remote

إذا ثبت الأداة rclone محليًا، استخدم:

```sh
"$HOME/nasr-wa-sync/bin/rclone" config
```

إذا كان rclone موجودًا في النظام مسبقًا، يمكنك استخدام:

```sh
rclone config
```

اختر إعدادًا جديدًا:

```text
name> nasr-wa
Storage> drive
client_id>ضع client_id الخاص بك
client_secret>ضع client_secret الخاص بك
scope> drive
root_folder_id>ضع معرّف مجلد CRM
```

استخدم `scope drive` مع `root_folder_id` حتى يرى المجلد الموجود.  
لو اخترت `drive.file` فقد لا يرى الملفات القديمة، وتبقى الحالة المحلية هي مرجع منع التكرار.

إذا كان الجهاز بلا متصفح، اختر الوضع اليدوي/headless وأكمل التفويض من جهاز آخر.

### د) تحقق قراءة فقط

```sh
"$HOME/nasr-wa-sync/bin/rclone" lsf nasr-wa: --max-depth 1 | head
```

أو إذا كان rclone في النظام:

```sh
rclone lsf nasr-wa: --max-depth 1 | head
```

**الناتج المتوقع:**  
أسماء ملفات موجودة في مجلد CRM، بدون تعديل شيء.

**توقف إذا:**

- ظهر خطأ مصادقة.
- لم يرى المجلد.
- طلب صلاحيات غير متوقعة.

أرسل نص الخطأ فقط.

---

## الخطوة 6 — تجربة جافة بلا رفع وبلا تغيير الحالة

**الفائدة:**  
تثبت أن المفتاح والنسخة الاحتياطية والاستخراج يعملون على جهازك، قبل أي رفع إلى Drive.

**كيف تنفذها صح:**

```sh
cd "$HOME/nasr-crm/nasr-realestate.github.io"
sh scripts/antix-wa-sync/sync.sh --dry-run
```

**الناتج المتوقع:**  
سطر JSON فيه عدادات، مثل:

```json
{"counts":{"new":1},"prepared":1,"uploaded":0}
```

الأرقام عندك ستكون مختلفة. المهم:

- `uploaded` يساوي 0.
- لا يوجد خطأ مفتاح أو نسخة احتياطية.

**أرسل لي:**  
سطر JSON فقط، أو رسالة الخطأ فقط. لا ترسل أسماء عملاء ولا نصوص محادثات.

**توقف إذا:**

- ظهر فشل فك تشفير.
- ظهر أن النسخة Incremental.
- ظهر خطأ في الجداول أو الاستخراج.

---

## الخطوة 7 — تجهيز محلي فقط ومراجعة ما سيُرفع

**الفائدة:**  
ترى عدد الملفات وأشكالها محليًا قبل أن تلمس Drive. هذه بوابة الأمان قبل أول نقل حقيقي.

**كيف تنفذها صح:**

```sh
sh scripts/antix-wa-sync/sync.sh --prepare-only
ls -lh "$HOME/nasr-wa-sync/state/outbox" | head
```

يمكنك فحص أسماء الملفات فقط. لا تفتح محتوى المحادثات ولا ترسله.

**الناتج المتوقع:**  
ملفات ZIP أسماؤها تبدأ بـ:

```text
WA-SYNC__
```

**أرسل لي:**

- عدد ملفات ZIP.
- آخر سطر JSON ظهر من الأمر.

**توقف إذا:**

- لم ينشئ أي ملف رغم وجود محادثات.
- ظهر `hold_` في العدادات.
- طلب منك مراجعة تصادم هوية.

---

## الخطوة 8 — أول رفع حقيقي، ثم إعادة تشغيل لإثبات عدم التكرار

**الفائدة:**  
ينقل الجديد/المتغيّر فقط، ثم يثبت أن إعادة الأمر لا ترفع نفس الملفات مرة ثانية.

**كيف تنفذها صح:**

```sh
sh scripts/antix-wa-sync/sync.sh
```

انتظر حتى ينتهي. ثم أعد نفس الأمر مرة ثانية:

```sh
sh scripts/antix-wa-sync/sync.sh
```

**الناتج المتوقع:**

المرة الأولى:

```json
{"uploaded":N}
```

المرة الثانية على نفس النسخة:

```json
{"counts":{"unchanged":N},"uploaded":0}
```

**أرسل لي:**  
نتيجتي الأمرين JSON فقط.

**توقف إذا:**

- رمز الخروج كان 1.
- رمز الخروج كان 3 وظهر `hold_history_changed` أو `hold_empty_backup` أو `hold_identity_collision`.
- رمز الخروج كان 4، فهذا يعني أن هناك مزامنة أخرى تعمل؛ انتظر حتى تنتهي.

---

## الخطوة 9 — تحقق من Drive ومن CRM بدون تعديل الأصول

**الفائدة:**  
نتأكد أن الملفات وصلت إلى مجلد الاستقبال، وأن الأصول القديمة لم تُستبدل أو تُحذف.

**كيف تنفذها صح:**

1. افتح مجلد «قاعده العملاء نظام CRM» في Google Drive.
2. تأكد أن الملفات الجديدة تبدأ بـ `WA-SYNC__`.
3. لا تحذف أي ملف قديم.
4. أخبرني أن الرفع تم، وسأراجع المجلد قراءة فقط من جهتي إذا كان اتصال Drive مفعلًا.
5. بعد ذلك نكمل مسار CRM الموجود للاستيراد/المراجعة حسب الصلاحيات والحوكمة. لا نشغل أي حذف أو دمج غير مصرح.

**الناتج المتوقع:**  
ملفات `WA-SYNC__` جديدة موجودة، والملفات القديمة كما هي.

**توقف إذا:**  
لم تظهر الملفات، أو ظهر ملف مكرر غير متوقع، أو ظهر خطأ تحقق MD5/الحجم.

---

## الخطوة 10 — الروتين المتكرر بعد ذلك

**الفائدة:**  
تحويل العملية إلى عادة بسيطة: نسخة جديدة من الهاتف، ثم أمر واحد.

**كيف تنفذها صح:**

1. على الهاتف: اعمل نسخًا احتياطيًا كاملًا.
2. عبر USB: استبدل الملف المحلي فقط:

   ```text
   ~/nasr-wa-sync/inbox/msgstore.db.crypt15
   ```

3. على antiX:

   ```sh
   cd "$HOME/nasr-crm/nasr-realestate.github.io"
   sh scripts/antix-wa-sync/sync.sh
   ```

**الناتج المتوقع:**

- محادثات جديدة: `new`.
- محادثات زادت رسائلها: `changed`.
- لا تغيير: `unchanged`.
- رفع فقط للجديد/المتغيّر.

**لا تفعل:**

- لا تحذف `~/nasr-wa-sync/state`.
- لا تنقل `state.json` إلى مستودع Git.
- لا تستخدم `rclone sync` أو `delete`.

---

## جدول سريع: ماذا تعني رموز الخروج؟

| الرمز | المعنى | التصرف الصحيح |
|---:|---|---|
| 0 | نجح أو لا جديد | أكمل الروتين |
| 1 | توقف آمن | أرسل رسالة الخطأ فقط |
| 3 | توجد محادثات معلّقة للمراجعة | أرسل `last-run.json` ولا تحذف الحالة |
| 4 | مزامنة أخرى تعمل | انتظر ثم أعد المحاولة |

---

## ماذا ترسل لي في كل مرحلة؟

- الخطوة 0: مخرجات الأوامر الثلاثة.
- الخطوة 1: `CODE_OK` أو خطأ git.
- الخطوة 4: `Setup complete` أو رسالة الخطأ.
- الخطوة 5: نجاح `rclone lsf` أو خطأ المصادقة.
- الخطوة 6: JSON الخاص بـ `--dry-run`.
- الخطوة 7: عدد ZIP وJSON الخاص بـ `--prepare-only`.
- الخطوة 8: JSON أول رفع وJSON إعادة التشغيل.
- الخطوة 9: تأكيد ظهور ملفات `WA-SYNC__` في Drive.

**لا ترسل أبدًا:** المفتاح، `client_secret`، محتوى محادثة، أسماء عملاء، أو ملف نسخة احتياطية.
