# -*- coding: utf-8 -*-
import os
import json
import glob
from datetime import datetime

# ==========================================
# ⚙️ إعدادات الروبوت (Migration Script)
# ==========================================

# أين توجد البيانات القديمة؟
SOURCE_DIR = 'data' 

# أين نضع الملفات الجديدة؟
PROPS_DIR = '_properties'
REQS_DIR = '_requests'

# التأكد من وجود المجلدات الجديدة
if not os.path.exists(PROPS_DIR): os.makedirs(PROPS_DIR)
if not os.path.exists(REQS_DIR): os.makedirs(REQS_DIR)

def create_markdown_file(data, folder, category, is_request=False):
    """
    وظيفة هذا الجزء: تحويل بيانات JSON إلى صفحة Markdown فخمة
    """
    # 1. استخراج البيانات
    # نستخدم get لتجنب الأخطاء إذا كان الحقل ناقصاً
    item_id = data.get('id') or data.get('ref_id') or 'unknown'
    title = data.get('title', 'عرض عقاري').replace('"', "'") # تنظيف العنوان
    date = data.get('date', datetime.now().strftime('%Y-%m-%d'))
    
    # تحديد السعر أو الميزانية
    price = data.get('price_display') or data.get('price') or data.get('budget') or 'للاستفسار'
    
    # تحديد الموقع
    location = data.get('location', 'مدينة نصر')
    
    # الوصف
    description = data.get('description', 'لا يوجد وصف متاح.').replace('"', "'")
    
    # التفاصيل الإضافية
    extra = data.get('more_details') or data.get('extra_details') or ''
    
    # 2. بناء محتوى الملف الجديد (Front Matter)
    # هذا هو الشكل الذي يفهمه Jekyll وجوجل
    md_content = f"""---
layout: {'request_page' if is_request else 'property_page'}
title: "{title}"
date: {date}
location: "{location}"
price: "{price}"
category: "{category}"
id: "{item_id}"
"""

    # إضافة باقي الحقول (فقط إذا كانت موجودة)
    if 'area' in data: md_content += f'area: "{data["area"]}"\n'
    if 'rooms' in data: md_content += f'rooms: "{data["rooms"]}"\n'
    if 'bathrooms' in data: md_content += f'bathrooms: "{data["bathrooms"]}"\n'
    if 'floor' in data: md_content += f'floor: "{data["floor"]}"\n'
    if 'finish' in data: md_content += f'finish: "{data["finish"]}"\n'
    if 'budget' in data: md_content += f'budget: "{data["budget"]}"\n'
    if 'type' in data: md_content += f'property_type: "{data["type"]}"\n'
    
    # تفاصيل إضافية للوصف
    if extra: md_content += f'extra_details: "{extra}"\n'
    
    # إغلاق المنطقة العلوية
    md_content += "---\n\n"
    
    # 3. كتابة الوصف في جسم الصفحة
    md_content += f"{description}\n"

    # 4. حفظ الملف
    # نستخدم اسم الملف الأصلي لكن بامتداد .md
    filename = f"{item_id}.md" if 'id' in data else f"property-{datetime.now().microsecond}.md"
    
    # تنظيف اسم الملف من أي مسافات
    filename = filename.replace(" ", "-").lower()
    
    output_path = os.path.join(folder, filename)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(md_content)
    
    print(f"✅ تم تحويل: {filename}")


# ==========================================
# 🚀 بدء التشغيل
# ==========================================
print("--- 🚀 بدء الهجرة من JSON إلى Markdown ---")

# 1. تحويل العروض (Properties)
# نبحث في كل المجلدات الفرعية (apartments, shops, etc...)
for filepath in glob.glob(f"{SOURCE_DIR}/properties/*/*.json"):
    if "index.json" in filepath: continue # نتجاهل ملفات الفهرس القديمة
    
    # استنتاج القسم من اسم المجلد (مثلاً apartments)
    category = os.path.basename(os.path.dirname(filepath))
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            create_markdown_file(data, PROPS_DIR, category, is_request=False)
    except Exception as e:
        print(f"❌ خطأ في الملف {filepath}: {e}")

# 2. تحويل الطلبات (Requests)
for filepath in glob.glob(f"{SOURCE_DIR}/requests/*/*.json"):
    if "index.json" in filepath: continue
    
    category = os.path.basename(os.path.dirname(filepath))
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            create_markdown_file(data, REQS_DIR, category, is_request=True)
    except Exception as e:
        print(f"❌ خطأ في الطلب {filepath}: {e}")

print("--- 🎉 تمت الهجرة بنجاح! ---")
print(f"راجع المجلدات: {PROPS_DIR} و {REQS_DIR}")
