#!/usr/bin/env python3
"""فحص محتوى فعلي لملفات الصور — تحليل بكسلات، لا أسماء ملفات."""
import os, sys, json
from PIL import Image
import numpy as np

Image.MAX_IMAGE_PIXELS = None

def laplacian_var(gray):
    """تباين Laplacian = مقياس الحدة. قيم منخفضة = ضبابية."""
    g = gray.astype(np.float64)
    lap = (np.roll(g,1,0)+np.roll(g,-1,0)+np.roll(g,1,1)+np.roll(g,-1,1)-4*g)
    return float(lap[2:-2,2:-2].var())

def crop_visible_fraction(w, h, target_ratio):
    """نسبة المساحة المرئية من الصورة عند object-fit:cover داخل إطار target_ratio (عرض/ارتفاع)."""
    src = w / h
    if src > target_ratio:      # أعرض من الإطار → قص أفقي
        return target_ratio / src
    else:                       # أطول من الإطار → قص رأسي
        return src / target_ratio

rows = []
root = "."
targets = []
for dirpath, _, files in os.walk(os.path.join(root, "assets/img")):
    for f in sorted(files):
        if f.lower().endswith((".webp", ".png", ".jpg", ".jpeg")):
            targets.append(os.path.join(dirpath, f))

for p in sorted(targets):
    try:
        im = Image.open(p)
        im.load()
        w, h = im.size
        fmt = im.format
        size = os.path.getsize(p)
        g = np.asarray(im.convert("L"))
        sharp = laplacian_var(g)
        mean_b = float(g.mean())
        # entropy via histogram
        hist = np.bincount(g.ravel(), minlength=256).astype(np.float64)
        pbb = hist / hist.sum(); pbb = pbb[pbb > 0]
        ent = float(-(pbb * np.log2(pbb)).sum())
        vis_card = crop_visible_fraction(w, h, 4/3)      # بطاقات properties
        vis_card_home = crop_visible_fraction(w, h, 2.0) # بطاقة الرئيسية height:200px عرض 400
        vis_detail = crop_visible_fraction(w, h, 16/10)  # صفحة التفاصيل
        rows.append(dict(path=p, w=w, h=h, fmt=fmt, kb=round(size/1024,1),
                         sharp=round(sharp,1), bright=round(mean_b,1), ent=round(ent,2),
                         vis43=round(vis_card*100,1), vis1610=round(vis_detail*100,1)))
    except Exception as e:
        rows.append(dict(path=p, error=str(e), kb=round(os.path.getsize(p)/1024,1)))

print(json.dumps(rows, ensure_ascii=False, indent=0))
