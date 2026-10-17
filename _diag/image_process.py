#!/usr/bin/env python3
"""
معالجة صور موقع سمسار طلبك — 2026-10-17
═══════════════════════════════════════
يُنشئ نسخًا جديدة دون المساس بالأصول الأصلية إطلاقًا:
  1. assets/img/properties/cards/<name>.webp  — بطاقات 4:3 (قص ذكي 800×600)
  2. assets/img/properties/og/<name>.jpg      — صور اجتماعية 1200×630
  3. assets/img/logo-120.webp                 — نسخة شعار صغيرة للواجهة
  4. _data/image_dims.yml                     — أبعاد كل صورة أصلية (لصفحة التفاصيل)

القص الذكي: نافذة بأعلى كثافة حواف (تفاصيل) مع انحياز طفيف لأعلى الصورة
(واجهات المباني)، وشرط أمان: طاقة النافذة المختارة ≥ 90% من أعلى نافذة.
"""
import os, sys, json, re, glob
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROPS_DIR = os.path.join(ROOT, "_properties")
IMG_DIR = os.path.join(ROOT, "assets/img/properties")
CARDS_DIR = os.path.join(IMG_DIR, "cards")
OG_DIR = os.path.join(IMG_DIR, "og")
DATA_DIR = os.path.join(ROOT, "_data")

CARD_RATIO = 4/3
OG_RATIO = 1200/630
CARD_W = 800
OG_W = 1200
CARD_MAX_KB = 60
OG_MAX_KB = 90

os.makedirs(CARDS_DIR, exist_ok=True)
os.makedirs(OG_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# ── 1) اجمع أسماء الصور المستخدمة فعليًا من ملفات العقارات ──
used = []
for md in sorted(glob.glob(os.path.join(PROPS_DIR, "*.md"))):
    txt = open(md, encoding="utf-8").read()
    m = re.search(r'^image_file:\s*"?([^"\n]+?)"?\s*$', txt, re.M)
    if m and m.group(1).strip():
        used.append(m.group(1).strip())
used = sorted(set(used))
print(f"[i] صور عقارات مستخدمة: {len(used)}")
assert len(used) == len(set(u.split(".")[0] for u in used)), "تعارض أسماء بلا امتداد!"

def edge_energy(gray):
    """طاقة الحواف = مقدار التدرج الرمادي."""
    g = gray.astype(np.float32)
    gy = np.abs(np.diff(g, axis=0, prepend=g[:1]))
    gx = np.abs(np.diff(g, axis=1, prepend=g[:, :1]))
    return gx + gy

def smart_crop(im, target_ratio, up_bias=True):
    """اختيار نافذة قص بنسبة target_ratio عند أعلى تفاصيل، مع انحياز لأعلى."""
    w, h = im.size
    src = w / h
    if abs(src - target_ratio) / target_ratio < 0.01:
        return im, "no-crop"
    gray = np.asarray(im.convert("L"))
    e = edge_energy(gray)
    if src > target_ratio:  # عرضية: نافذة بعرض أقل — انزلاق أفقي
        vis_w = int(round(h * target_ratio)); vis_h = h
        col = e.sum(axis=0)
        csum = np.concatenate([[0.0], np.cumsum(col)])
        best_x, max_s = 0, -1.0
        for x in range(0, w - vis_w + 1, 4):
            s = csum[x + vis_w] - csum[x]
            if s > max_s: max_s, best_x = s, x
        return im.crop((best_x, 0, best_x + vis_w, vis_h)), f"x={best_x}"
    else:  # طولية: نافذة بارتفاع أقل — انزلاق رأسي مع انحياز أعلى
        vis_h = int(round(w / target_ratio)); vis_w = w
        row = e.sum(axis=1)
        csum = np.concatenate([[0.0], np.cumsum(row)])
        cy, sigma = 0.42 * h, 0.30 * h
        best_y, best_score, max_s, max_y = 0, -1e18, -1.0, 0
        for y in range(0, h - vis_h + 1, 4):
            s = csum[y + vis_h] - csum[y]
            if s > max_s: max_s, max_y = s, y
            yc = y + vis_h / 2
            boost = 1.0 + 0.25 * np.exp(-((yc - cy) ** 2) / (2 * sigma ** 2)) if up_bias else 1.0
            score = s * boost
            if score > best_score: best_score, best_y = score, y
        # شرط الأمان: النافذة المختارة ≥ 90% من طاقة أفضل نافذة
        if csum[best_y + vis_h] - csum[best_y] < 0.9 * max_s:
            best_y = max_y
            return im.crop((0, best_y, vis_w, best_y + vis_h)), f"y={best_y} (max-energy)"
        return im.crop((0, best_y, vis_w, best_y + vis_h)), f"y={best_y} (biased)"

def laplacian_var(gray):
    g = gray.astype(np.float64)
    lap = (np.roll(g,1,0)+np.roll(g,-1,0)+np.roll(g,1,1)+np.roll(g,-1,1)-4*g)
    return float(lap[2:-2,2:-2].var())

def save_webp_under(im, path, orig_kb, qualities=(80, 75, 72, 70, 66, 62, 58)):
    """القبول: ≤60KB و ≤90% من حجم الأصل (لا يعقل بطاقة أثقل من مصدرها).
    المصادر المليئة بضوضاء ضغط سابقة: تمويه خفيف 0.5px يقتل الضوضاء ويخفض الحجم
    دون أثر بصري يُذكر في حجم بطاقة."""
    cap = min(CARD_MAX_KB, orig_kb * 0.9)
    for q in qualities:
        im.save(path, "WEBP", quality=q, method=6)
        if os.path.getsize(path) <= cap * 1024:
            return q, os.path.getsize(path)
    denoised = im.filter(ImageFilter.GaussianBlur(0.5))
    for q in (72, 68, 64, 60, 56, 52):
        denoised.save(path, "WEBP", quality=q, method=6)
        if os.path.getsize(path) <= cap * 1024:
            return f"{q}+denoise", os.path.getsize(path)
    return "52+denoise", os.path.getsize(path)

def save_jpg_under(im, path, qualities=(78, 74, 70, 66, 62), max_kb=80):
    for q in qualities:
        im.save(path, "JPEG", quality=q, optimize=True)
        if os.path.getsize(path) <= max_kb * 1024:
            return q, os.path.getsize(path)
    denoised = im.filter(ImageFilter.GaussianBlur(0.5))
    for q in (72, 68, 64, 60, 56, 52):
        denoised.save(path, "JPEG", quality=q, optimize=True)
        if os.path.getsize(path) <= max_kb * 1024:
            return f"{q}+denoise", os.path.getsize(path)
    return "52+denoise", os.path.getsize(path)

log = []
dims_yml = ["# أبعاد الصور الأصلية — مولّد آليًا بواسطة _diag/image_process.py",
            "# يُستخدم في _layouts/property_page.html لحجز نسبة العرض الصحيحة (منع CLS والقص)", ""]

for name in used:
    src_path = os.path.join(IMG_DIR, name)
    if not os.path.exists(src_path):
        print(f"[!] مفقود: {name}"); continue
    im = Image.open(src_path); im.load()
    w, h = im.size
    orig_kb = os.path.getsize(src_path) / 1024

    # ── بطاقة 4:3 ──
    crop, how = smart_crop(im, CARD_RATIO)
    cw, ch = crop.size
    out_w = min(CARD_W, cw)
    out_h = round(out_w / CARD_RATIO)
    downscaled = (out_w < cw)
    sharp_src = laplacian_var(np.asarray(im.convert("L")))
    card = crop.resize((out_w, out_h), Image.LANCZOS)
    # تحسين حدة خفيف فقط للمصادر الحادة — الضبابية يضخم فيها الضوضاء وحجم الملف
    if downscaled and sharp_src >= 15:
        card = card.filter(ImageFilter.UnsharpMask(radius=1.0, percent=55, threshold=2))
    card_path = os.path.join(CARDS_DIR, name)
    q, csize = save_webp_under(card, card_path, orig_kb)

    # ── OG 1200×630 ──
    crop2, how2 = smart_crop(im, OG_RATIO)
    cw2, ch2 = crop2.size
    out_w2 = min(OG_W, cw2)
    out_h2 = round(out_w2 / OG_RATIO)
    og = crop2.resize((out_w2, out_h2), Image.LANCZOS)
    if out_w2 < cw2 and sharp_src >= 15:
        og = og.filter(ImageFilter.UnsharpMask(radius=1.0, percent=55, threshold=2))
    if og.mode != "RGB":
        og = og.convert("RGB")
    og_path = os.path.join(OG_DIR, os.path.splitext(name)[0] + ".jpg")
    q2, osize = save_jpg_under(og, og_path)

    base = os.path.splitext(name)[0]
    dims_yml.append(f'"{base}": {{w: {w}, h: {h}}}')
    log.append(dict(name=name, orig=f"{w}x{h}", orig_kb=round(orig_kb, 1),
                    card_crop=how, card_out=f"{out_w}x{out_h}", card_kb=round(csize/1024, 1), card_q=q,
                    og_crop=how2, og_out=f"{out_w2}x{out_h2}", og_kb=round(osize/1024, 1), og_q=q2))

# ── شعار صغير ──
logo = Image.open(os.path.join(ROOT, "assets/img/logo.webp"))
logo_small = logo.resize((120, 120), Image.LANCZOS)
logo_small.save(os.path.join(ROOT, "assets/img/logo-120.webp"), "WEBP", quality=90, method=6)

# ── ملف الأبعاد ──
with open(os.path.join(DATA_DIR, "image_dims.yml"), "w", encoding="utf-8") as f:
    f.write("\n".join(dims_yml) + "\n")

json.dump(log, open(os.path.join(ROOT, "_diag", "image_process_log.json"), "w"), ensure_ascii=False, indent=1)
print(f"[✓] بطاقات: {len(log)} | og: {len(log)} | logo-120 | image_dims.yml")
tot_orig = sum(l["orig_kb"] for l in log); tot_card = sum(l["card_kb"] for l in log)
print(f"[i] حجم الصور الأصلية المستخدمة في البطاقات: {tot_orig:.0f}KB → نسخ البطاقات: {tot_card:.0f}KB (وفر {100-100*tot_card/tot_orig:.0f}%)")
