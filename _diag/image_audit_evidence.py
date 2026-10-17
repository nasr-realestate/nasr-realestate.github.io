#!/usr/bin/env python3
"""توليد أدلة بصرية: كم من الصورة الأصلية يُقص فعليًا في صفحة التفاصيل (16:10) وفي البطاقات (4:3)."""
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("_diag/image-audit-assets", exist_ok=True)
FONT = None
for cand in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
    if os.path.exists(cand):
        FONT = ImageFont.truetype(cand, 22); break

def label(draw, xy, text, fill="#ffffff"):
    draw.text(xy, text, font=FONT, fill=fill)

def make_evidence(src, out_prefix):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    for name, tr in [("detail-16x10", 16/10), ("card-4x3", 4/3)]:
        src_ratio = w / h
        # ما الذي يظهر داخل إطار object-fit:cover بنسبة tr
        if src_ratio > tr:   # قص أفقي
            vis_w = int(h * tr); vis_h = h
            x0 = (w - vis_w)//2; y0 = 0
        else:                # قص رأسي
            vis_w = w; vis_h = int(w / tr)
            x0 = 0; y0 = (h - vis_h)//2
        frac = (vis_w*vis_h)/(w*h)

        # نسخة الأصل مع تعتيم المنطقة المقصوصة
        orig = im.copy()
        d = ImageDraw.Draw(orig, "RGBA")
        # رسم أحمر شفاف على كل شيء ثم "ثقب" المنطقة المرئية
        overlay = Image.new("RGBA", orig.size, (220, 20, 20, 150))
        mask = Image.new("L", orig.size, 255)
        md = ImageDraw.Draw(mask)
        md.rectangle([x0, y0, x0+vis_w-1, y0+vis_h-1], fill=0)
        orig = Image.composite(overlay, orig.convert("RGBA"), mask).convert("RGB")
        d = ImageDraw.Draw(orig)
        d.rectangle([x0, y0, x0+vis_w-1, y0+vis_h-1], outline="#00ff66", width=5)
        label(d, (12, 10), f"ORIGINAL {w}x{h}  (ratio {src_ratio:.2f})", "#ffffff")

        # الإطار كما يُعرض فعليًا
        frame_w = 640
        frame_h = int(frame_w / tr)
        shown = im.crop((x0, y0, x0+vis_w, y0+vis_h)).resize((frame_w, frame_h), Image.LANCZOS)
        d2 = ImageDraw.Draw(shown)
        label(d2, (12, 10), f"ACTUALLY SHOWN ({name}) - {frac*100:.0f}% of photo", "#00ff66")

        # تجميع جنبًا إلى جنب
        H = max(orig.height, frame_h) + 60
        canvas = Image.new("RGB", (orig.width + frame_w + 30, H), (10, 10, 10))
        canvas.paste(orig, (10, 40))
        canvas.paste(shown, (orig.width + 20, 40))
        dd = ImageDraw.Draw(canvas)
        label(dd, (10, 8), "ORIGINAL (red = cut off by object-fit:cover)", "#ff8080")
        label(dd, (orig.width + 20, 8), "WHAT THE VISITOR SEES", "#80ff80")
        out = f"_diag/image-audit-assets/{out_prefix}-{name}.png"
        canvas.save(out, optimize=True)
        print(f"saved {out}  visible={frac*100:.1f}%")

make_evidence("assets/img/properties/Al-Hayat-Towers-7th-District-162m.webp", "hayat-towers")
make_evidence("assets/img/properties/Hassan-Hassanein-Heikal-200m.webp", "heikal")
make_evidence("assets/img/properties/zuhair-sabri.webp", "zuhair-wide")

# عيّنة أضبط الصور (للمراجعة البصرية للجودة)
blurry = ["zhraa-nasr.webp", "Ismail-Qabbani-Street-Genena-Mall.webp", "hai-elswfarat.webp",
          "moez-al-Dawla-administrator.webp", "mfroosh-tiran.webp", "sheraton-nozha.webp"]
th = 300
sheet = Image.new("RGB", (th*3 + 40, th*2 + 70), (10, 10, 10))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(blurry):
    im = Image.open("assets/img/properties/" + f)
    im.thumbnail((th, th))
    x = 10 + (i % 3) * (th + 10); y = 40 + (i // 3) * (th + 30)
    sheet.paste(im, (x, y))
    d.text((x, y - 26), f, font=FONT, fill="#ffd166")
d.text((10, 8), "LOWEST-SHARPNESS SAMPLES (blurriest property photos)", font=FONT, fill="#ffffff")
sheet.save("_diag/image-audit-assets/blurry-samples.png", optimize=True)
print("saved blurry-samples.png")
