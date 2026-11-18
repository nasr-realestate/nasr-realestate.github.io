#!/usr/bin/env python3
"""
راسِم نص عربي/لاتيني احترافي للفيديو — HarfBuzz + FreeType.

لماذا لا Pillow:
  • Pillow هنا مبني بدون libraqm ⇒ العربي بيطلع حروفًا مقطّعة.
  • دمج خطَّي Cairo العربي واللاتيني بـfontTools.merge أفسد جداول GSUB
    فصارت الأشكال متصلة ببعضها بغير موضعها.
الحل المعتمد:
  • HarfBuzz يحسب التشكيل والمواضع (init/medi/fina/rlig) — بدقة المتصفح.
  • FreeType يرسم الـglyph بالـglyph ID مباشرة (لا خريطة حروف ⇒ لا أخطاء).
  • تقسيم bidi يدوي: العربي RTL، الأرقام/اللاتيني LTR داخله.
  • Arabic font للعربي، Latin font للأرقام — حسب المقطع.
"""
import re
import numpy as np
import uharfbuzz as hb
from freetype import Face, FT_LOAD_RENDER, FT_LOAD_TARGET_NORMAL

# ── الخطوط (بدون دمج — كل خطّ في نطاقه) ──
# تُستخرج من assets/fonts/*.woff2 عند أول استعمال، وتُخزَّن في مجلد مؤقت
# قابل للتحديد بـCAIRO_TTF_DIR — حتى تعمل الأداة على أي جهاز بلا خطوات يدوية.
import os as _os
import tempfile as _tempfile

_SRC_FONTS = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))),
    'assets', 'fonts')
_TTF_DIR = _os.environ.get('CAIRO_TTF_DIR') or _os.path.join(
    _tempfile.gettempdir(), 'nasr-cairo-ttf')


def _ensure_fonts():
    """يحوّل woff2 ⇒ ttf مرة واحدة. يرجع مسار المجلد."""
    _os.makedirs(_TTF_DIR, exist_ok=True)
    need = []
    for w in ('400', '500', '700', '900'):
        for tag in ('arabic', 'latin'):
            out = _os.path.join(_TTF_DIR, f'ar_{tag}_{w}.ttf')
            if not _os.path.exists(out):
                need.append((f'cairo-{tag}-{w}-normal.woff2', out))
    if need:
        from fontTools.ttLib import TTFont
        for src_name, out in need:
            src = _os.path.join(_SRC_FONTS, src_name)
            if not _os.path.exists(src):
                continue
            f = TTFont(src)
            f.flavor = None
            f.save(out)
    return _TTF_DIR


_FD = _ensure_fonts()
FONT_AR = {w: _os.path.join(_FD, f'ar_arabic_{w}.ttf') for w in ('400', '500', '700', '900')}
FONT_LA = {w: _os.path.join(_FD, f'ar_latin_{w}.ttf') for w in ('400', '500', '700', '900')}

_ar_re = re.compile(r'[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]')
_digit_re = re.compile(r'[0-9\u0660-\u0669]')
_glue = set(',.:%+/-')      # يبقى ملتصقًا بالرقم

_c = {}


def _hb(path):
    k = ('hb', path)
    if k not in _c:
        blob = hb.Blob.from_file_path(path)
        face = hb.Face(blob)
        _c[k] = (hb.Font(face), face.upem)
    return _c[k]


def _ft(path):
    k = ('ft', path)
    if k not in _c:
        _c[k] = Face(path)
    return _c[k]


# ─────────────── تقسيم النص إلى مقاطع اتجاهية ───────────────

def segments(text):
    """[(kind, str)] حيث kind ∈ R (عربي) / L (أرقام-لاتيني) / W (محايد)."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if _ar_re.match(c):
            j = i
            while j < n:
                if _ar_re.match(text[j]):
                    j += 1
                elif text[j] == ' ':
                    k = j
                    while k < n and text[k] == ' ':
                        k += 1
                    if k < n and _ar_re.match(text[k]):
                        j = k
                    else:
                        break
                else:
                    break
            out.append(('R', text[i:j]))
            i = j
        elif _digit_re.match(c):
            j = i
            while j < n:
                if _digit_re.match(text[j]):
                    j += 1
                elif text[j] in _glue and j + 1 < n and _digit_re.match(text[j + 1]):
                    j += 1
                else:
                    break
            out.append(('L', text[i:j]))
            i = j
        elif c.isascii() and c.isalpha():
            j = i
            while j < n and text[j].isascii() and text[j].isalnum():
                j += 1
            out.append(('L', text[i:j]))
            i = j
        else:
            if out and out[-1][0] == 'W':
                out[-1] = ('W', out[-1][1] + c)
            else:
                out.append(('W', c))
            i += 1
    return [s for s in out if s[1]]


def _shape_run(text, font_path, rtl=False):
    """
    يرجّع (قائمة gid, قائمة (advance, x_offset, y_offset) بالـem) بترتيب بصري.

    ⚠️ 2026-11-18: كان هذا العيب يجعل كل نص عربي في الفيديو معكوسًا —
    «تشطيب» تُرسم «بيطشت»، و«مستويين» تبدو «مسستتويينن». القياس:
    HarfBuzz يرصف المقطع RTL بمواضع متناقصة، فالأولى منطقيًا (ت) تأخذ
    أكبر x. الكود كان يجمع الـadvance تصاعديًا من 0، فيضعها في أقصى
    اليسار = انعكاس كامل. الحل: نطرح من العرض الكلي للمقطع بدل الجمع.
    وأُضيف x_offset المهمَل (همزات وألف خنجرية تُزحزَح أفقيًا).
    """
    fnt, upem = _hb(font_path)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(fnt, buf, {'kern': True, 'liga': True, 'rlig': True, 'calt': True,
                        'init': True, 'medi': True, 'fina': True, 'ccmp': True})
    gids = [i.codepoint for i in buf.glyph_infos]
    # x_advance[i] = العرض الذي *يسبق* الحرف i (لأن HarfBuzz يرصف من اليمين).
    # فالموضع النهائي للحرف i = مجموع عروض ما يليه. نجمع هنا ونعيد المواضع
    # الجاهزة بدل الإزاحات — لا لبس بعد اليوم.
    raw = [p.x_advance / upem for p in buf.glyph_positions]
    xo = [p.x_offset / upem for p in buf.glyph_positions]
    yo = [p.y_offset / upem for p in buf.glyph_positions]
    total = sum(raw)
    # مؤشر يجري من اليمين (total) نحو اليسار
    advs, pos = [], total
    for i in range(len(raw)):
        pos -= raw[i]
        advs.append((pos, xo[i], yo[i]))
    return gids, advs


def layout(text, weight='700'):
    """
    يرجّع ([(gid, font_path, pen_x_em, dy_em)], عرض_كلي_em) بترتيب بصري من
    اليسار لليمين — وهو نظام الرسم على اللوحة.

    ⚠️ سجلّ عيب (2026-11-18) — سبب «الحروف المبعثرة» في كل فيديو:
    HarfBuzz يرصف المقطع العربي ويُعيد الحروف **بترتيب بصري جاهز من اليسار**،
    مع x_advance عرض كل حرف في موضعه. الكود القديم:
        for g, (a, dy) in zip(gids, advs):
            items.append((g, path, x, dy)); x += a
    كان يمرّر dy مكان الإزاحة ويستخدم عروض الحروف بلا مواضع صحيحة، فانقلب
    ترتيب الكلمة وتباعدت حروفها. الصحيح: تراكم بسيط بترتيب HarfBuzz نفسه.
    """
    items, x = [], 0.0
    for kind, s in reversed(segments(text)):
        path = FONT_AR[weight] if kind == 'R' else FONT_LA[weight]
        fnt, upem = _hb(path)
        buf = hb.Buffer()
        buf.add_str(s)
        buf.guess_segment_properties()
        # ⚠️ لا تُمرّر init/medi/fina يدويًا: HarfBuzz يطبّقها تلقائيًا
        # لسكربت Arabic، وتمريرها صريحًا يُعطّل الـligatures فيفكّ «ست»
        # (uniFC94) و«ي» النهائية (uniFEF3) ⇒ «مسستتوينن».
        hb.shape(fnt, buf, {'kern': True, 'liga': True, 'calt': True, 'ccmp': True})
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            items.append((info.codepoint, path,
                          x + pos.x_offset / upem,
                          pos.y_offset / upem))
            x += pos.x_advance / upem
    return items, x


def measure(text, size, weight='700'):
    _, w = layout(text, weight)
    return w * size


# ─────────────── الرسم على مصفوفة رمادية ───────────────

def _blit(canvas, bitmap, gx, gy):
    """يدمج bitmap الرمادي في اللوحة عند (gx, gy) أعلى-يسار."""
    H, W = canvas.shape
    rows, w = bitmap.rows, bitmap.width
    if not rows or not w:
        return
    x0, y0 = int(gx), int(gy)
    sx0 = max(0, -x0)
    sy0 = max(0, -y0)
    dx0 = max(0, x0)
    dy0 = max(0, y0)
    cw = min(w - sx0, W - dx0)
    ch = min(rows - sy0, H - dy0)
    if cw <= 0 or ch <= 0:
        return
    buf = bitmap.buffer
    if isinstance(buf, list):
        src = np.array(buf, dtype=np.uint8)
    else:
        src = np.frombuffer(buf, dtype=np.uint8)
    src = src.reshape(rows, w)
    src = src[sy0:sy0 + ch, sx0:sx0 + cw]
    dst = canvas[dy0:dy0 + ch, dx0:dx0 + cw]
    np.maximum(dst, src, out=dst)


def draw(canvas, xy, text, size, weight='700', color=(255, 255, 255), anchor='ra'):
    """
    يرسم نصًا على لوحة رمادية (H,W,3) بالألوان.
    anchor: أفقياً r/l/m · رأسياً a/m/b
    """
    items, w_em = layout(text, weight)
    width = w_em * size
    x, y = xy
    x0 = x - width if anchor[0] == 'r' else (x - width / 2 if anchor[0] == 'm' else x)

    # خط الأساس
    ref = FONT_AR[weight]
    ft = _ft(ref)
    ft.set_char_size(int(size * 64))
    asc = ft.size.ascender / 64.0
    desc = -ft.size.descender / 64.0
    if anchor[1] == 'm':
        base = y + (asc - desc) / 2
    elif anchor[1] == 'b':
        base = y - desc
    else:
        base = y + asc

    H, W = canvas.shape[:2]
    mask = np.zeros((H, W), dtype=np.uint8)
    for gid, path, pen_em, dy_em in items:
        f = _ft(path)
        f.set_char_size(int(size * 64))
        f.load_glyph(gid, FT_LOAD_RENDER | FT_LOAD_TARGET_NORMAL)
        gl = f.glyph
        _blit(mask,
              gl.bitmap,
              x0 + pen_em * size + gl.bitmap_left,
              base - gl.bitmap_top)

    col = np.array(color, dtype=np.float32)
    m = (mask.astype(np.float32) / 255.0)[..., None]
    canvas[:] = (canvas * (1 - m) + col * m).astype(np.uint8)
    return width


def draw_image(img_arr, xy, text, size, weight='700', color=(255, 255, 255), anchor='ra'):
    """نفس draw لكن على مصفوفة الصورة مباشرة (RGB)."""
    return draw(img_arr, xy, text, size, weight, color, anchor)


def wrap(text, size, max_width, weight='700'):
    words = text.split()
    lines, cur = [], ''
    for w in words:
        cand = (cur + ' ' + w).strip()
        if measure(cand, size, weight) <= max_width or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines
