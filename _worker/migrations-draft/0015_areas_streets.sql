-- ═══════════════════════════════════════════════════════════════
--  0015_areas_streets.sql
--  إضافة شوارع مدينة نصر إلى جدول areas كياناتٍ معلنة + خريطة مطابقة
-- ═══════════════════════════════════════════════════════════════
--
--  السبب (مقيس، 2026-11-18): من 116 عرضًا منشورًا، 57 داخل المدينة كان
--  `zone` عندهم اسم شارع لا منطقة معلنة. وprice_snapshots لا يستطيع حمل
--  صف لشارع غير موجود في areas (FOREIGN KEY area_id → areas.id)، فكانت
--  51 عرضًا تسقط قبل التجميع أصلًا. هذه أهم سبب لبقاء الجدول عند 39 صفًا
--  بينما الموقع ينشر 105 عرضًا صالحًا.
--
--  القرار (بطلب من المالك): الشوارع تُصبح مناطق معلنة.
--  لكن ليس كل اسم: نضيف فقط ما يُنتج صفًا فعليًا — ثلاث عينات أو أكثر من
--  نفس (نوع × غرض). من 35 اسمًا غير متطابق، ثلاث شوارع فقط تستوفي الشرط.
--  إضافة اسم بعرض واحد تُلوّث جدول المناطق بصفوف لا تُنتج صفًا واحدًا.
--
--  المضافة (تُنتج 3 صفوف جديدة):
--    حسن المأمون     شقة بيع    n=5
--    مصطفى النحاس    شقة بيع    n=5
--    شارع الطيران    شقة إيجار  n=3
--
--  ⚠️ آمنة للتكرار: كل إدراج مشروط بـWHERE NOT EXISTS على name_ar (UNIQUE).
--  ⚠️ إدراج فقط: لا تُعدّل صفًا موجودًا ولا تحذف شيئًا.
--  ⚠️ المعرّفات لا تُكتب يدويًا — AUTOINCREMENT يمنحها، لأن الـworker يقرأ
--     areas ديناميكيًا. لا تفترض أن الشارع سيأخذ id=32.
-- ═══════════════════════════════════════════════════════════════

-- ── عمود المطابقة: كيف يُعرف أن نص `zone` في عرض يخص هذه المنطقة؟ ──
-- نمط LIKE مفصول بـ| (مثل 'مصطفى النحاس|النحاس'). الـgenerator يقرأ هذا
-- العمود من القاعدة ويستخدمه، فلا تُكتَب أنماط داخل الكود مبعثرة.
-- NULL للمناطق القديمة = مطابقة بالاسم فقط (سلوكها الحالي بلا تغيير).
ALTER TABLE areas ADD COLUMN zone_patterns TEXT;

INSERT INTO areas (name_ar, name_en, level, level_ar, description, area_type, zone_patterns, verified, created_at, updated_at)
SELECT 'حسن المأمون', 'Hassan El Maamoun', 'street', 'شارع', 'شارع حسن المأمون — مدينة نصر', 'street', 'حسن المأمون|المأمون', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM areas WHERE name_ar = 'حسن المأمون');

INSERT INTO areas (name_ar, name_en, level, level_ar, description, area_type, zone_patterns, verified, created_at, updated_at)
SELECT 'مصطفى النحاس', 'Mostafa El Nahas', 'street', 'شارع', 'شارع مصطفى النحاس — مدينة نصر', 'street', 'مصطفى النحاس|النحاس', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM areas WHERE name_ar = 'مصطفى النحاس');

INSERT INTO areas (name_ar, name_en, level, level_ar, description, area_type, zone_patterns, verified, created_at, updated_at)
SELECT 'شارع الطيران', 'El Tayaran Street', 'street', 'شارع', 'شارع الطيران — مدينة نصر', 'street', 'الطيران', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM areas WHERE name_ar = 'شارع الطيران');
