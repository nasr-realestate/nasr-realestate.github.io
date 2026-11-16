#!/usr/bin/env python3
"""
صور مجموعات دفتر جهات الاتصال (vCard labels) — بطاقات 256×256.

المشكلة التي يحلّها: الصور القديمة كانت متشابهة جدًا (نفس التصميم، أسماء
داخلية مختلفة عن أسماء المجموعات)، فالتبس الأمر على المستخدم. هذه النسخة
ترسم اسم المجموعة الحقيقي بلونها، فلا لبس.

التشكيل العربي: PIL في هذه البيئة مبني بلا raqm، فلو رُسم النص مباشرة تظهر
الحروف منفصلة ومقلوبة. لذلك يُشكَّل النص بـ HarfBuzz (ligatures + RTL) ثم
يُرسم كل glyph بـ FreeType. لا تُستخدم arabic_reshaper ولا bidi.

المتطلبات:
    python3 -m venv .venv
    .venv/bin/pip install Pillow uharfbuzz freetype-py fonttools brotli

التشغيل:
    .venv/bin/python tools/contact-labels/make-labels.py --out ./labels

الخط: يُستخرج من assets/fonts/cairo-arabic-900-normal.woff2 إلى مجلد مؤقت
(لا يُكتب أي ملف خط داخل المستودع).
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

try:
    import freetype
    import uharfbuzz as hb
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("نقص في المتطلبات: pip install Pillow uharfbuzz freetype-py fonttools brotli")

REPO = Path(__file__).resolve().parents[2]
SIZE = 256

# ---------------------------------------------------------------------------
# المجموعات: (الاسم المعروض, لون الخلفية, لون التمييز, اسم الملف)
# الألوان الأربعة الأولى هي هوية المستخدم — لا تُغيَّر بغير طلب صريح.
# المجموعتان الأخيرتان هما الافتراضي لأي اسم آخر وللأسماء القديمة.
# ---------------------------------------------------------------------------
GROUPS = [
    ("ذكى منير",       "#F5751A", "#FFFFFF", "zaki-mounir"),
    ("حارس",           "#1D4ED7", "#FFFFFF", "hares"),
    ("الدولاب",        "#8B4512", "#FFFFFF", "eldoulab"),
    ("قاعدة العملاء",   "#17A34A", "#F2C94C", "client-base"),
    ("جهات الاتصال",    "#1F2933", "#9AA5B1", "default"),  # الافتراضي: كل ما تبقّى
]
HEADER = "الدفتر الشامل"
FOOTER = "مرجع موثق"


# ---------------------------------------------------------------------------
# الخط
# ---------------------------------------------------------------------------
def font_path() -> str:
    """Cairo Arabic 900 بصيغة ttf في مجلد مؤقت."""
    cache = Path(tempfile.gettempdir()) / "cairo-arabic-900.ttf"
    if not cache.exists():
        from fontTools.ttLib import TTFont

        src = REPO / "assets" / "fonts" / "cairo-arabic-900-normal.woff2"
        if not src.exists():
            sys.exit(f"خط Cairo غير موجود: {src}")
        ttf = TTFont(str(src))
        ttf.flavor = None
        ttf.save(str(cache))
    return str(cache)


_FT: dict[str, freetype.Face] = {}
_HB: dict[str, tuple[hb.Font, hb.Buffer]] = {}


def _shaped(text: str, px: int):
    """يرجع (glyph ids, advance, offset) بعد تشكيل HarfBuzz."""
    path = font_path()
    key = f"{path}:{px}"
    if key not in _HB:
        blob = hb.Blob.from_file_path(path)
        face = hb.Face(blob)
        font = hb.Font(face)
        font.scale = (px * 64, px * 64)
        _HB[key] = font
    font = _HB[key]
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf)
    return buf.glyph_infos, buf.glyph_positions


def _ft(px: int) -> freetype.Face:
    path = font_path()
    if path not in _FT:
        _FT[path] = freetype.Face(path)
    face = _FT[path]
    face.set_char_size(px * 64)
    return face


def text_alpha(text: str, px: int) -> Image.Image:
    """نص عربي متصل وصحيح الاتجاه، كقناع شفافية (L)."""
    infos, poss = _shaped(text, px)
    ft = _ft(px)
    pen = 0
    placed = []
    for info, pos in zip(infos, poss):
        placed.append((pen + pos.x_offset, pos.y_offset, info.codepoint))
        pen += pos.x_advance
    width = max(1, int(pen / 64) + px)
    ascender = int(ft.size.ascender / 64)
    descender = int(-ft.size.descender / 64)
    height = max(1, ascender + descender + px)

    canvas = Image.new("L", (width, height), 0)
    base = ascender + px // 2
    for x_off, y_off, gid in placed:
        ft.load_glyph(gid, freetype.FT_LOAD_RENDER)
        bmp = ft.glyph.bitmap
        if not bmp.width or not bmp.rows:
            continue
        glyph = Image.frombytes("L", (bmp.width, bmp.rows), bytes(bmp.buffer))
        gx = int(x_off / 64 + ft.glyph.bitmap_left)
        gy = int(base - y_off / 64 - ft.glyph.bitmap_top)
        canvas.paste(glyph, (gx, gy), glyph)
    box = canvas.getbbox()
    return canvas.crop(box) if box else canvas


def compose(alpha: Image.Image, fill: str, outline: str, stroke: int) -> Image.Image:
    """يحوّل قناع الشفافية إلى نص ملون بحدود سوداء."""
    if stroke <= 0:
        layer = Image.new("RGBA", alpha.size, fill)
        layer.putalpha(alpha)
        return layer
    grown = alpha.filter(ImageFilter.MaxFilter(stroke * 2 + 1))
    pad = stroke + 2
    size = (alpha.size[0] + pad * 2, alpha.size[1] + pad * 2)
    grown = Image.new("L", size, 0).paste(grown, (pad, pad)) or Image.new("L", size, 0)
    canvas = Image.new("L", size, 0)
    canvas.paste(alpha.filter(ImageFilter.MaxFilter(stroke * 2 + 1)), (pad, pad))
    border = Image.new("RGBA", size, outline)
    border.putalpha(canvas)
    inside = Image.new("L", size, 0)
    inside.paste(alpha, (pad, pad))
    body = Image.new("RGBA", size, fill)
    body.putalpha(inside)
    return Image.alpha_composite(border, body)


def hex_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))


def fit(text: str, max_w: int, max_h: int, start: int) -> Image.Image:
    """يقلّص حتى يدخل النص في المساحة المتاحة."""
    px = start
    while px > 7:
        alpha = text_alpha(text, px)
        if alpha.size[0] <= max_w and alpha.size[1] <= max_h:
            return compose(alpha, "white", "black", 2)
        px -= 2
    return compose(text_alpha(text, 7), "white", "black", 1)


def render(name: str, bg: str, accent: str) -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), hex_rgb(bg))
    draw = ImageDraw.Draw(img)

    # إطار داخلي رقيق يوحّد الستة
    draw.rounded_rectangle([8, 8, SIZE - 9, SIZE - 9], radius=42,
                           outline=hex_rgb(accent), width=2)

    header = fit(HEADER, int(SIZE * 0.80), 30, 26)
    img.paste(header, ((SIZE - header.size[0]) // 2, 26), header)

    draw.line([(SIZE // 2 - 34, 66), (SIZE // 2 + 34, 66)],
              fill=hex_rgb(accent), width=2)

    main = fit(name, int(SIZE * 0.88), 62, 54)
    img.paste(main, ((SIZE - main.size[0]) // 2, 96), main)

    footer = fit(FOOTER, int(SIZE * 0.62), 26, 22)
    img.paste(footer, ((SIZE - footer.size[0]) // 2, 204), footer)
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description="توليد صور مجموعات دفتر جهات الاتصال")
    ap.add_argument("--out", default="./labels", help="مجلد الإخراج")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, bg, accent, slug in GROUPS:
        target = out / f"{slug}.jpg"
        render(name, bg, accent).save(target, "JPEG", quality=94, subsampling=0)
        print(f"✓ {target}  ({name})")
    print(f"\nتم توليد {len(GROUPS)} صورة في {out.resolve()}")


if __name__ == "__main__":
    main()
