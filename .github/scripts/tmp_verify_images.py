#!/usr/bin/env python3
"""فحص مؤقت (تدقيق الصور 2026-10-17): كل مسار صورة في HTML المبني يجب أن يكون ملفًا موجودًا في _site."""
import os, re, sys, glob

broken = []
checked = set()
pages = glob.glob('_site/**/*.html', recursive=True)
for p in pages:
    with open(p, encoding='utf-8', errors='replace') as fh:
        html = fh.read()
    srcs = re.findall(r'(?:src|content)="(/assets/img/[^"]+)"', html)
    srcs += [m for m in re.findall(r"this\.src='([^']+)'", html) if m.startswith('/assets/')]
    for s in srcs:
        if s in checked:
            continue
        checked.add(s)
        if not os.path.isfile('_site' + s):
            broken.append((p, s))

print(f"فُحص {len(pages)} صفحة HTML، {len(checked)} مسار صورة فريد")
print("مكسور:", len(broken))
for b in broken[:20]:
    print("  X", b)
sys.exit(1 if broken else 0)
