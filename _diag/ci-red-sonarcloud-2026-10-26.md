# العلامة الحمراء على كل commit — التشخيص والإصلاح (2026-10-26)

## 1) الخلاصة
**النشر ما فشلش.** كل عمليات النشر والاختبارات كانت ناجحة.
الـ❌ اللي ظاهر جنب كل commit من 2026-10-26 الساعة 13:01 UTC سببه فحص واحد بس، هو **SonarCloud Scan**. الفحص ده لجودة الكود وما بينشرش أي حاجة.
SonarCloud بقى يرفض المفتاح `SONAR_TOKEN` المحفوظ في أسرار المستودع، لأنه انتهى أو اتلغى.

## 2) الدليل: آخر commit على master قبل الإصلاح (`42d556a`)
| الفحص | النتيجة |
|---|---|
| Deploy Jekyll with Plugins — build / deploy / verify (run 40378474734) | ✅ ✅ ✅ |
| pages build and deployment (run 40378473292) | ✅ |
| Worker & page tests (run 40378474835) | ✅ |
| Push Notifications Setup — verify (run 40378474700) | ✅ `VERIFY_OK` |
| نشرتين `github-pages` (7340266414 و 7340264836) | ✅ `success` |
| **SonarCloud Scan Action** (run 40378474716) | ❌ خطوة `SonarCloud Scan` فشلت بعد ثانيتين |

## 3) السبب
- **آخر مسح ناجح:** 2026-10-25 الساعة 19:31 UTC (run 40226436293).
- **أول فشل:** 2026-10-26 الساعة 13:01 UTC (run 40327053147). بعده فشل على كل commit، سواء على master أو في الـPRs.
- **الإعدادات ما اتغيرتش:** `git diff 035eae6 821dd26` على `sonar-project.properties` و`sonarcloud.yml` فاضي.
- **فحص المفتاح** (run 40327759067، سجل تاريخي من جلسة قبل كده):
  `SONAR_TOKEN present; validate={"valid":false}`.
- **ليه إعادة التشغيل فشلت:** إعادة تشغيل الفحص الأحمر بتستخدم نفس المفتاح، فبتفشل تاني بنفس السبب. ومش بتنشر ولا بتلغي أي نشر.

## 4) الإصلاح (`.github/workflows/sonarcloud.yml`)
- **job جديد اسمه `SonarCloud token check`** بيسأل `api/authentication/validate` قبل المسح.
  - قيمة المفتاح ما بتتطبعش أبدًا.
  - بتوصل لـcurl عن طريق stdin (ملف إعداد) مش سطر الأوامر.
- **مقبول:** `SonarCloud Scan Action` بيشتغل عادي. ولو فشل لسبب حقيقي هيفضل أحمر.
- **مرفوض أو مش موجود** (زي PR من fork أو Dependabot):
  - job المسح بيظهر **Skipped** (رمادي) مش ناجح.
  - بيظهر معاه تحذير، وملخص فيه خطوات التجديد.
  - مفيش ادعاء إن المسح نجح.
- **ماقدرناش نتأكد** (SonarCloud مش بيرد): المسح بيشتغل عادي وهو اللي يقرر، فمفيش تخطي صامت.
- **أداة المسح:** نفس الإصدار v3.1.0 اللي كان شغال لحد 2026-10-25، بس مثبتة على SHA كاملة `383f7e52…`.
- **الصلاحيات:** قراءة بس.

## 5) التحقق
### محليًا
- `scripts/tests/sonarcloud-workflow.test.mjs`: **9 اختبارات**.
  - بتشغّل سكربت الخطوة نفسه بـbash، بنفس طريقة GitHub (`-eo pipefail`)، مع curl وهمي.
  - الحالات: missing / valid / invalid / مسافات في الـJSON / 401 / SonarCloud مش بيرد / 503 / رد فيه محاولة حقن.
  - وبتتأكد إن المفتاح ما ظهرش في stdout ولا stderr ولا `GITHUB_OUTPUT` ولا الملخص ولا وسائط curl.
- **تعديلات متعمدة:** 7 تعديلات اتعملت على الـworkflow للتأكد إن الاختبارات بتمسك الأخطاء، واتكشفت كلها (7/7). من ضمنها:
  - المفتاح المرفوض يشغّل المسح.
  - المفتاح يتحط في سطر أوامر curl.
  - طباعة المفتاح.
  - إلغاء شرط المسح.
  - إزالة تثبيت الـSHA.
- **curl الحقيقي:**
  - على خادم محلي: مفتاح صحيح أعطى `valid`، ومفتاح غلط أعطى `invalid`. والمفتاح وصل كـBasic auth من stdin.
  - على sonarcloud.io من غير ما يوصل له: أعطى `unknown` والمسح اشتغل.
- **أدوات الفحص:** shellcheck 0.11 (style) من غير ملاحظات، وaction-validator: كل الـworkflows سليمة.
- **`npm test`:** 570/570.

### على GitHub Actions (رد SonarCloud الحقيقي)
- **PR #107، run 40382322656:**
  - `SonarCloud token check`: ✅ في 4 ثواني، مع التحذير `SonarCloud scan skipped (SONAR_TOKEN rejected)`. يعني SonarCloud رفض المفتاح الحالي فعلًا.
  - `SonarCloud Scan Action`: Skipped.
- **باقي فحوص الـPR:** `node-tests` و`build-only` ✅. حالة الدمج `CLEAN`.

## 6) لرجوع المسح الكامل (صاحب حساب SonarCloud بس، دقيقتين)
1. في sonarcloud.io: My Account > Security > Generate Token. لازم يكون من حساب له صلاحية على منظمة `nasr-realestate`، ومدة صلاحية المفتاح طويلة.
2. في GitHub: Settings > Secrets and variables > Actions > `SONAR_TOKEN` > Update secret.

أول push أو PR بعدها هيشغّل المسح تلقائيًا، من غير تعديل أي ملف.

## 7) ملاحظات (مش أخطاء دلوقتي)
- **أداة `SonarSource/sonarcloud-github-action`** مؤرشفة من SonarSource وبيوصوا ببديلها `sonarqube-scan-action`.
  - سيبناها زي ما هي لأنها الإعداد اللي اشتغل فعلًا.
  - تغييرها يستاهل يتعمل بعد تجديد المفتاح، عشان يتجرب.
- **تحذيرات Node.js 20 وإشعار انتقال `ubuntu-latest` لـUbuntu 26** بتظهر على كل الـjobs كتحذيرات بس، ومحدش فيهم سبب فشل.
- **الـcommits القديمة هتفضل بعلامتها الحمرا في السجل.** ده مش بيتغير بأثر رجعي.
  - إعادة تشغيل فحص قديم بتستخدم ملف الـworkflow القديم، فهتفشل تاني.
  - المهم هو آخر commit.
