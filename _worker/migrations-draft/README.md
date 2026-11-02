# migrations-draft — مجلد المسودات (0009 لم تعد هنا)

**الحالة (2026-11-02):** `0009_crm_drive_review_workflow.sql` **روِّجت** إلى
`_worker/migrations/0009_crm_drive_review_workflow.sql` بعد استيفاء شروط الاعتماد المسجلة في
`CRM_PHASE4_REVIEW_TEST_REPORT.md`. المحتوى لم يتغيّر عند النقل (`git mv` فقط، بلا تحرير).
لا توجد مسودة معلَّقة هنا الآن؛ المجلد يبقى للتالي: كل هجرة جديدة تبدأ هنا ولا تدخل
`_worker/migrations/` إلا بموافقة طارق الصريحة.

## لماذا ليس في `_worker/migrations/` قبل الموافقة

كل سير عمل يطبّق الهجرات ينفّذ `wrangler d1 migrations apply` على **المجلد كاملًا**:

- `.github/workflows/crm-phase4-analysis.yml` (المؤقت المعزول، ثم `nasr-crm-test-db` فقط)
- `.github/workflows/crm-phase3-registry.yml`
- `.github/workflows/crm-cloudflare-test-d1.yml`
- `.github/workflows/crm-cloudflare-test-deploy.yml` (على `master`، بعد موافقة Environment)

لذلك كانت المسودة محفوظة هنا حتى الموافقة الصريحة على SQL. بوابة النشر قُفِلت في
`1e183df`: لم يعد `crm-cloudflare-test-deploy.yml` يعمل تلقائيًا على `push` لأي فرع.

## كيف تراجع أي مسودة بدون لمس أي قاعدة

```bash
node _worker/tests-draft/crm-review-sql-0009.abuse.mjs              # 113 فحصًا، :memory: فقط
python3 _worker/tests-draft/crm-review-sql-0009.d1-rehearsal.py    # 116 فحصًا، محرك D1 في مجلد مؤقت
python3 _worker/tests-draft/crm-0009-backup-restore.rehearsal.py   # 33 فحصًا، حزمة احتياطية مُسيَّجة
```

الاختبارات الثلاثة تمشّط `_worker/migrations/` **و** `_worker/migrations-draft/` معًا، فلا تحتاج
تعديلًا عند الترويج. كلها محلية بالكامل: لا `--remote`، ولا اتصال بأي قاعدة حقيقية، ولا استدعاء Drive.
بوابة CI بلا أسرار: `.github/workflows/crm-review-0009-verify.yml`.

## قائمة الترويج (ما يُشترط في نفس الـ commit)

1. `git mv _worker/migrations-draft/0009_*.sql _worker/migrations/`.
2. عدّاد الهجرات في `.github/workflows/crm-phase4-analysis.yml`:
   القاعدة المعزولة `migCnt = 9` وسطر `latest = 0009_crm_drive_review_workflow`،
   وعلى قاعدة الاختبار `migs = 9` + `p4_tbl = 8` + `rev_tbl/trg/view/idx = 5/19/4/8` + `rev_rows = 0`،
   مع `PRAGMA integrity_check = ok` و`foreign_key_check` نظيفًا.
3. مسار `push.paths` في نفس الملف ليشمل ملف الهجرة المُروَّج.
4. **لا** تُضاف أسماء الجداول/المشغّلات يدويًا إلى أي مكان آخر: فاحص CI يقرأ الأسماء المعلنة من
   ملف الهجرة ويقارنها بـ `sqlite_master` الحيّ، فانحرافٌ واحد يُفشل التشغيل.
5. **قبل** أي push يمسّ `_worker/crm-ui/**` أو `_worker/crm-worker.js`: بوابة `crm-test-deploy`
   يجب أن تكون قائمة ومحميّة (قرار المستخدم، `CRM_PHASE4_REVIEW_SECURITY.md` §5).
