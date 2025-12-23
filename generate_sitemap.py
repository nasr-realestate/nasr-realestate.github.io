cat > generate_sitemap.py << 'EOF'
import os
import glob
from datetime import datetime

print("🚀 إنشاء خريطة موقع شاملة...")
base_url = "https://nasr-realestate.github.io"
today = datetime.now().strftime("%Y-%m-%d")

sitemap = '''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- الصفحات الأساسية -->
  <url>
    <loc>''' + base_url + '''/</loc>
    <lastmod>''' + today + '''</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>''' + base_url + '''/about-us.html</loc>
    <lastmod>''' + today + '''</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>''' + base_url + '''/property/</loc>
    <lastmod>''' + today + '''</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>''' + base_url + '''/request/</loc>
    <lastmod>''' + today + '''</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>\n'''

# إضافة العقارات
properties = glob.glob("_properties/*.md")
for prop in properties:
    name = os.path.basename(prop).replace('.md', '')
    sitemap += f'''  <url>
    <loc>{base_url}/property/{name}/</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>\n'''

# إضافة الطلبات
requests = glob.glob("_requests/*.md")
for req in requests:
    name = os.path.basename(req).replace('.md', '')
    sitemap += f'''  <url>
    <loc>{base_url}/request/{name}/</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>\n'''

sitemap += '</urlset>'

with open('sitemap.xml', 'w', encoding='utf-8') as f:
    f.write(sitemap)

print(f"✅ تم إنشاء sitemap.xml بنجاح!")
print(f"📊 يحتوي على: {len(properties)} عقار + {len(requests)} طلب + 4 صفحات أساسية")
EOF
