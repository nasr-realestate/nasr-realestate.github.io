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

### بعد الدمج على master (`19f3d3a`، 2026-10-26 الساعة 19:00 UTC)
| الفحص | النتيجة |
|---|---|
| Deploy Jekyll with Plugins (run 40382794014) — build / deploy / verify | ✅ ✅ ✅ |
| خطوة verify: «Verify the live deployment (SHA · feed · MCP · raw head · every MP3)» | ✅ الموقع الحي بيقدّم `19f3d3a` |
| pages build and deployment (run 40382792985) | ✅ |
| Worker & page tests (run 40382794050) | ✅ |
| SonarCloud Scan (run 40382793915) | ✅ `SonarCloud token check` + تحذير «SONAR_TOKEN rejected»؛ و`SonarCloud Scan Action` ⊘ Skipped |
| نشرتين `github-pages` (7340899809 و 7340899074) | ✅ `success` |

كل الـcheck suites بتاعة GitHub Actions على `19f3d3a` نتيجتها `success`، ومفيش ولا فحص بـ`failure`.

## 6) لرجوع المسح الكامل (صاحب حساب SonarCloud بس، دقيقتين)
1. في sonarcloud.io: My Account > Security > Generate Token. لازم يكون من حساب له صلاحية على منظمة `nasr-realestate`، ومدة صلاحية المفتاح طويلة.
2. في GitHub: Settings > Secrets and variables > Actions > `SONAR_TOKEN` > Update secret.

أول push أو PR بعدها هيشغّل المسح تلقائيًا، من غير تعديل أي ملف.

### ⚠️ مهم قبل التجديد: بوابة الجودة على master فاشلة من 2026-10-12
فيه علامة حمرا تانية أقدم، ومش بتبان في تبويب Actions.
- **مصدرها:** فحص **«SonarCloud Code Analysis»**، وده بيتنشر من تطبيق SonarQube Cloud نفسه بعد كل مسح ناجح.
- **آخر مرة نجحت على master:** PR #45 (`c7f1e8f`، 2026-10-12 الساعة 17:10 UTC).
- **أول فشل:** `e8e3692` «feat: migrate from Jekyll to Node.js server» (2026-10-12 الساعة 22:55 UTC).
  - الـcommit ده اتدفع على master **مباشرة من غير PR**.
  - ضاف `server.js` (395 سطر) و`package.json` و`.env.example` و`metadata.json`.
  - الشروط اللي فشلت فيه: `E Security Rating on New Code`، و`9.7% Duplication on New Code`.
- **من وقتها:** كل merge على master لحد `035eae6` (2026-10-25) كان `Quality Gate failed`.
  - آخر الشروط الفاشلة: `E Security Rating on New Code`، و`D Reliability Rating on New Code` (المطلوب ≥ A).
- **الـPRs نفسها كانت نظيفة:** مثلًا PR #46 كان `Quality Gate passed` و`0 New issues`.
  - تحليل الـPR بيبص على تغييرات الـPR بس.
  - أما فشل master فجاي من كود دخل من غير PR.
- **قائمة الأخطاء بالتحديد:** محتاجة صلاحية على SonarCloud. المشروع خاص، والـAPI العامة بترد على أي زائر بـ«Project doesn't exist».
- **ليه فضلت فاشلة:**
  - تعريف «New Code» الافتراضي للمنظمة هو `previous_version`، والمشروع ما بيحددش `sonar.projectVersion`.
  - فغالبًا نافذة «الكود الجديد» مفتوحة من أول تحليل، وأي مشكلة دخلت من وقتها بتفضل محسوبة.
- **النتيجة:**
  - دلوقتي العلامة دي مش ظاهرة، لأن المسح متوقف لحد ما المفتاح يتجدد.
  - بعد التجديد هيشتغل المسح، وتشغيلة Actions غالبًا هتفضل خضرا.
  - بس فحص «SonarCloud Code Analysis» ممكن يرجّع ❌ جنب الـcommits لحد ما المشاكل دي تتصلح.
- **الخطوة الجاية بعد التجديد:**
  - نسحب القائمة بالتحديد بخطوة CI مؤقتة. هتستخدم المفتاح الجديد من غير ما تطبعه، وهتقرأ `api/issues/search` للـ`master` و`sinceLeakPeriod=true`.
  - وبعدها نصلّح المشاكل، وغالبًا أولها في `server.js`. ده خادم المعاينة المحلي، ومش هو اللي بيخدم الموقع الحي؛ اللي بيخدمه GitHub Pages.
  - أو صاحب الحساب يفتح صفحة المشاكل على SonarCloud مباشرة.

## 7) ملاحظات (مش أخطاء دلوقتي)
- **أداة `SonarSource/sonarcloud-github-action`** مؤرشفة من SonarSource وبيوصوا ببديلها `sonarqube-scan-action`.
  - سيبناها زي ما هي لأنها الإعداد اللي اشتغل فعلًا.
  - تغييرها يستاهل يتعمل بعد تجديد المفتاح، عشان يتجرب.
- **تحذيرات Node.js 20 وإشعار انتقال `ubuntu-latest` لـUbuntu 26** بتظهر على كل الـjobs كتحذيرات بس، ومحدش فيهم سبب فشل.
- **الـcommits القديمة هتفضل بعلامتها الحمرا في السجل.** ده مش بيتغير بأثر رجعي.
  - إعادة تشغيل فحص قديم بتستخدم ملف الـworkflow القديم، فهتفشل تاني.
  - المهم هو آخر commit.
