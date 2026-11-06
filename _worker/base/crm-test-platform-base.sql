-- مخطط المنصّة الأساسي الذي تفترضه هجرات CRM (2026-11-06)
--
-- لماذا هذا الملف موجود: هجرات `_worker/migrations/*.sql` لا تُنشئ `listings`؛ تفترضه موجودًا
-- (`REFERENCES listings(id)` في 0001/0006/0012، و`ALTER TABLE listings` في 0005). ولذلك يفشل
-- `d1 migrations apply` على قاعدة فارغة بـ:
--   ERROR no such table: listings: SQLITE_ERROR
--
-- هذا الملف هو **نفس** المخطط والذرّتين الصناعيتين المستخدمين في
-- `.github/workflows/crm-cloudflare-test-d1.yml` (الوصفة التي أنشأت قاعدة الاختبار الحالية)،
-- مستخرجًا إلى ملف واحد حتى لا يتباعد نسختان. اختبار في
-- `scripts/tests/d1-provision-v2.test.mjs` يمنع أي انحراف بين الملف والوصفة الأصلية.
--
-- لا يمسّ الإنتاج: أسماء وصفوف كلها TEST ONLY، وتُنشأ على قاعدة الاختبار وحدها.

CREATE TABLE areas(id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL);
CREATE TABLE sources(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE listings(
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT NOT NULL, property_type TEXT NOT NULL, transaction_type TEXT NOT NULL, area_id INTEGER NOT NULL,
  area_m2 REAL, price REAL, bedrooms INTEGER, bathrooms INTEGER, finishing TEXT, observed_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES sources(id), FOREIGN KEY(area_id) REFERENCES areas(id)
);
INSERT INTO areas(id,name_ar) VALUES(90001,'TEST ONLY Nasr City'),(99999,'TEST ONLY out of scope');
INSERT INTO sources(id,name) VALUES(9009,'TEST ONLY synthetic CRM source');
INSERT INTO listings(id,source_id,external_id,url,title,property_type,transaction_type,area_id,area_m2,price,observed_at)
  VALUES(900001,9009,'crm-test-only-inside','/test-only/inside','TEST ONLY — synthetic listing','test','sale',90001,NULL,NULL,'2026-10-28'),
        (900002,9009,'crm-test-only-outside','/test-only/outside','TEST ONLY — out-of-scope listing','test','sale',99999,NULL,NULL,'2026-10-28');
