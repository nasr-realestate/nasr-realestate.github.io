# migrations-draft — هجرات معدّة للمراجعة، غير مطبَّقة

كل ملف هنا **مسودة للمراجعة فقط**: لا يطبّقه أي سير عمل ولا `npm test` ولا فاحص Sonar.

## لماذا ليس في `_worker/migrations/`

كل سير عمل CRM يطبّق الهجرات ينفّذ `wrangler d1 migrations apply` على **المجلد كاملًا**:

- `.github/workflows/crm-phase4-analysis.yml` (سطر 232 مؤقت، 651 على `nasr-crm-test-db`)
- `.github/workflows/crm-phase3-registry.yml` (190، 465)
- `.github/workflows/crm-cloudflare-test-d1.yml` (99)
- `.github/workflows/crm-cloudflare-test-deploy.yml` (313، 335)

فوجود `0009_*.sql` داخل `_worker/migrations/` يعني تطبيقه على قاعدة الاختبار في أول تشغيل لأيٍّ من
هذه الأربعة (وأحدها يعمل تلقائيًا على `push` لأي فرع `arena/**`). لذلك تُحفظ المسودة هنا حتى
الموافقة الصريحة على SQL.

## كيف تراجع المسودة بدون لمس أي قاعدة

```bash
node _worker/tests-draft/crm-review-sql-0009.abuse.mjs              # 78 فحصًا، :memory: فقط
python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py    # 53 فحصًا، محرك D1 في مجلد مؤقت
```

كلاهما محلي بالكامل: لا `--remote`، ولا اتصال بأي قاعدة حقيقية، ولا استدعاء Drive.

## قائمة الترويج (بعد الموافقة فقط)

1. `git mv _worker/migrations-draft/0009_*.sql _worker/migrations/` في **نفس** الـ commit الذي يحدّث
   `.github/workflows/crm-phase4-analysis.yml:660` من `migs = 8` إلى `migs = 9`.
2. نقل الاختبارين إلى `_worker/tests/crm-phase4-review-sql.test.mjs` (صيغة `node --test`).
3. بوابة CI إضافية: `d1_review_triggers = 15`، `latest_mig = 0009_crm_drive_review_workflow`،
   ومنظَر `crm_review_chain_integrity` بصفر انحراف.
4. **قبل** أي push يمسّ `_worker/crm-ui/**` أو `_worker/crm-worker.js`: بوابة صريحة في
   `crm-cloudflare-test-deploy.yml` تمنع النشر التلقائي (قرار المستخدم، القسم 5 من
   `CRM_PHASE4_REVIEW_SECURITY.md`).
