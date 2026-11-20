#!/usr/bin/env python3
"""مولّد صور المشاركة (og:image) — هوية خضراء، صورة تعبّر عن صفحتها.

سبب الوجود (2026-11-20):
صور المشاركة الخمس كانت كلها بالهوية الذهبية القديمة (لون ذهبي) بينما
الموقع أخضر (#41C641). وكانت صورة واحدة (social-home) تخدم 14 صفحة —
فصفحة «سياسة الخصوصية» تُشارك بصورة «شقق للبيع»، مخالفةً لشرط المالك:
«كل رابط يتم مشاركته لابد أن يحمل صورة تعبّر عنه».

كما كانت social-home تعرض رقم الهاتف بارزًا — أُزيل.
العمولة 1.5% تبقى (قرار المالك: «اترك العمولة»).

ملاحظة تقنية مهمة:
arabic_text.draw() يضع النص بعلوّ الخط (ascender)، وهو أعلى من الحروف
الفعلية بكثير في Cairo — فكان الشريط الأخضر يعبر العنوان. الحل هنا:
نرسم كل سطر على طبقة مستقلة، نقيس **مربّع الحبر الفعلي** (ink bbox)
بالبكسل، ثم نضع الطبقة بموضع محسوب. لا تخمين ولا تراكب.

الاستخدام:
    python3 scripts/social/make-social-cards.py --out=assets/img
    python3 scripts/social/make-social-cards.py --only=home,properties
    python3 scripts/social/make-social-cards.py --list
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'audio'))
import arabic_text as AT  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
W, H = 1200, 630
MARGIN = 56

# ألوان العلامة — من _data/brand_assets.json (مقيسة من logo.webp)
# لا ذهب هنا عن قصد: الهوية الحالية سوداء وبيضاء وخضراء فقط.
BLACK = (8, 8, 8)
GREEN = (65, 198, 65)        # #41C641
WHITE = (245, 245, 243)
DIM = (158, 166, 158)
CARD = (20, 21, 20)


# ───────────────────────────────────────────────────────────────────
# محرّك النص: طبقة معزولة + قياس الحبر الفعلي
# ───────────────────────────────────────────────────────────────────
def ink_layer(text, size, weight='700', color=WHITE):
    """يرسم نصًا على طبقة شفافة ويقيس حبره. يرجع (rgba, w, h)."""
    # لوحة عالية كفاية: خط الأساس عند 2.5×المقاس، وأسفله 3.5× للمدّات
    # (كانت 3× فتقطع حروف «عقارات» — أُثبت بالقياس: حبر يبلغ حافة اللوحة)
    canvas = np.zeros((size * 6, W, 3), dtype=np.uint8)
    AT.draw(canvas, (W - MARGIN, int(size * 2.5)), text, size, weight, (255, 255, 255), 'ra')
    mask = canvas[..., 0]
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return Image.new('RGBA', (1, 1), color + (0,)), 0, 0
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    m = mask[y0:y1, x0:x1]
    rgba = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = color
    rgba[..., 3] = m
    return Image.fromarray(rgba), x1 - x0, y1 - y0


def put(img, layer, y, align='right'):
    """يلصق طبقة نصية بموضع رأسي = أعلى الحبر. يرجع الارتفاع المستهلك."""
    w, h = layer.size
    x = W - MARGIN - w if align == 'right' else (W - w) // 2 if align == 'center' else MARGIN
    img.alpha_composite(layer, (x, y))
    return h


def text(img, s, size, y, weight='700', color=WHITE, align='right'):
    layer, _, h = ink_layer(s, size, weight, color)
    return y + put(img, layer, y, align) if h else y


def fit(text_s, max_w, start, floor=40, weight='900'):
    """يصغّر الخط حتى يتّسع في سطر واحد — أفضل من قصّ بلا داعٍ."""
    size = start
    while size > floor and AT.measure(text_s, size, weight) > max_w:
        size -= 2
    return size


def block(img, s, size, y, weight='900', color=WHITE, max_w=W - 2 * MARGIN, lead=1.22):
    """سطر واحد إن أمكن، وإلا قصّ متوازن. يرجع y الجديد."""
    size = fit(s, max_w, size, max(34, size // 2), weight)
    return text(img, s, size, y, weight, color) + int(size * lead)


# ───────────────────────────────────────────────────────────────────
# الخلفية والزخارف
# ───────────────────────────────────────────────────────────────────
def background(tint=GREEN):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.zeros((H, W, 3), dtype=np.float32)
    v = (yy / H) * 0.30
    for i in range(3):
        base[..., i] = BLACK[i] + (CARD[i] - BLACK[i]) * (1 - v)

    # هالة لونية من أعلى اليمين
    dist = np.sqrt((xx - W * 0.84) ** 2 + (yy - H * 0.06) ** 2) / (W * 0.60)
    glow = np.clip(1 - dist, 0, 1) ** 2.3 * 0.20
    for i in range(3):
        base[..., i] += tint[i] * glow

    # هالة خافتة أسفل اليسار
    dist2 = np.sqrt((xx - W * 0.08) ** 2 + (yy - H * 0.98) ** 2) / (W * 0.68)
    glow2 = np.clip(1 - dist2, 0, 1) ** 3 * 0.09
    for i in range(3):
        base[..., i] += tint[i] * glow2

    # شبكة 50px خفيفة جدًا
    grid = ((xx % 50 < 1) | (yy % 50 < 1)).astype(np.float32) * 0.014
    base += grid[..., None] * 255

    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert('RGBA')


def logo_badge(img, size=86):
    logo = Image.open(os.path.join(ROOT, 'assets/img/logo-512.webp')).convert('RGBA')
    logo = logo.resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    img.paste(logo, (W - size - MARGIN + 4, 40), mask)
    return img


def rule(img, y, width=260, thick=5):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((W - MARGIN - width, y, W - MARGIN, y + thick),
                        radius=thick // 2, fill=GREEN + (255,))
    return img


def chip(img, s, y, size=20, fg=BLACK, bg=GREEN, weight='900'):
    """كبسولة نصية."""
    layer, w, h = ink_layer(s, size, weight, fg)
    pw, ph = w + 44, h + 26
    x0 = W - MARGIN - pw
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((x0, y, x0 + pw, y + ph), radius=ph // 2, fill=bg + (255,))
    img.alpha_composite(layer, (x0 + 22, y + 13))
    return y + ph


def stat_strip(img, y, items, height=104):
    """شريط إحصاءات عريض — يملأ الفراغ ويؤكد الاحتراف."""
    n = len(items)
    gap = 14
    total = W - 2 * MARGIN
    cw = (total - gap * (n - 1)) // n
    x = MARGIN
    for label, value in items:
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((x, y, x + cw, y + height), radius=14, fill=CARD + (255,))
        d.rounded_rectangle((x, y, x + cw, y + 4), radius=2, fill=GREEN + (255,))
        ly, lw, lh = ink_layer(value, 34, '900', WHITE)
        img.alpha_composite(ly, (x + (cw - lw) // 2, y + 26))
        ly2, lw2, _ = ink_layer(label, 18, '500', DIM)
        img.alpha_composite(ly2, (x + (cw - lw2) // 2, y + height - 30))
        x += cw + gap
    return y + height


def footer(img, s, size=17):
    text(img, s, size, H - 52, '500', DIM)
    return img


# ───────────────────────────────────────────────────────────────────
# القوالب
# ───────────────────────────────────────────────────────────────────
def card_hero(eyebrow, title, subtitle, footer_s, stats=None, title_size=76):
    img = logo_badge(background())
    text(img, eyebrow, 21, 62, '700', GREEN, 'left')
    y = 176
    y = block(img, title, title_size, y)
    img = rule(img, y + 4)
    y = text(img, subtitle, 27, y + 34, '500', DIM) + 40

    if stats:
        stat_strip(img, y + 8, stats)
    footer(img, footer_s)
    return img


def card_grid(eyebrow, title, subtitle, items, footer_s):
    img = logo_badge(background())
    text(img, eyebrow, 21, 62, '700', GREEN, 'left')
    y = block(img, title, 64, 168)
    y = text(img, subtitle, 26, y + 2, '500', DIM) + 36
    stat_strip(img, y, items, height=118)
    footer(img, footer_s)
    return img


def card_list(eyebrow, title, subtitle, rows, footer_s):
    img = logo_badge(background())
    text(img, eyebrow, 21, 62, '700', GREEN, 'left')
    y = block(img, title, 64, 168)
    img = rule(img, y + 2, 220)
    y = text(img, subtitle, 26, y + 30, '500', DIM) + 54

    for r in rows:
        d = ImageDraw.Draw(img)
        d.ellipse((W - MARGIN - 14, y + 15, W - MARGIN, y + 29), fill=GREEN + (255,))
        layer, lw, lh = ink_layer(r, 27, '700', WHITE)
        img.alpha_composite(layer, (W - MARGIN - 34 - lw, y))
        y += lh + 30
    footer(img, footer_s)
    return img


def card_cta(eyebrow, title, subtitle, cta, footer_s):
    img = logo_badge(background())
    text(img, eyebrow, 21, 62, '700', GREEN, 'left')
    y = block(img, title, 76, 172)
    img = rule(img, y + 2, 280)
    y = text(img, subtitle, 27, y + 34, '500', DIM) + 58
    chip(img, cta, y, 25)
    footer(img, footer_s)
    return img


# ───────────────────────────────────────────────────────────────────
# البطاقات — صورة لكل صفحة، تعبّر عنها
# ───────────────────────────────────────────────────────────────────
CARDS = {
    'home': ('social-home.jpg', lambda: card_hero(
        'مدينة نصر · منذ 2014',
        'عقارات مدينة نصر',
        'شقق · فيلات · مكاتب · محلات · إيجار وتمليك · استشارات مجانية',
        'عمولة البيع 1.5%',
        stats=[('معاينة', 'مجانية'), ('تقييم', 'احترافي'), ('استشارة', 'مجانية'), ('تسويق', 'مباشر')],
    )),
    'properties': ('social-properties.jpg', lambda: card_grid(
        'معرض العقارات',
        'كل العقارات المتاحة',
        'شقق · فيلات · دوبلكس · محلات · مكاتب — مدينة نصر',
        [('بلا رسوم', 'معاينة مجانية'), ('احترافي', 'تقييم فوري'),
         ('كامل', 'فحص قانوني'), ('مالك ← مشتري', 'تسويق مباشر')],
        'مدينة نصر · تحديث مستمر',
    )),
    'requests': ('social-requests.jpg', lambda: card_list(
        'طلبات العملاء',
        'طلبات عملاء جادون',
        'اعرض عقارك على عميل جاهز للتعاقد — بلا رسوم مبدئية',
        ['متابعة مباشرة مع كل عميل',
         'توصية بالعقار المناسب لطلبه',
         'عرض مجاني — لا رسوم قبل التعاقد'],
        'طلبات محدّثة باستمرار',
    )),
    'add-property': ('social-add-property.jpg', lambda: card_cta(
        'أضف عقارك',
        'اعرض عقارك بذكاء',
        'تقييم فوري احترافي · تسويق مباشر · بلا رسوم مبدئية',
        'أضف عقارك الآن',
        'رد خلال 24 ساعة',
    )),
    'agent': ('social-agent.jpg', lambda: card_cta(
        'الوكيل العقاري الذكي',
        'احكي طلبك للوكيل',
        'وخليه يساعدك تختار — على مدار الساعة',
        'ابدأ المحادثة الآن',
        'متاح على مدار الساعة',
    )),
    'about': ('social-about.jpg', lambda: card_grid(
        'عن سمسار طلبك',
        'خبرة في مدينة نصر',
        'وسيط عقاري يعمل لصالح الطرفين — منذ 2014',
        [('البداية', '2014'), ('النطاق', 'مدينة نصر'),
         ('الدور', 'وسيط'), ('الخدمة', 'استشارات')],
        'سمسار طلبك · عقارات مدينة نصر',
    )),
    'contact': ('social-contact.jpg', lambda: card_cta(
        'تواصل معنا',
        'كلّمنا عن عقارك',
        'استشارة مجانية · معاينة مجانية · تقييم فوري',
        'تواصل عبر الموقع',
        'واتساب ومكالمة من صفحة التواصل',
    )),
    'privacy': ('social-privacy.jpg', lambda: card_list(
        'سياسة الخصوصية',
        'بياناتك محفوظة',
        'ما نجمعه · لماذا · وكيف تحذفه',
        ['لا نبيع بياناتك لأي طرف',
         'لا نجمع إلا ما تحتاجه الخدمة',
         'حقك في الحذف متاح دائمًا'],
        'سمسار طلبك · مدينة نصر',
    )),
    'intellectual-property': ('social-ip.jpg', lambda: card_list(
        'الملكية الفكرية',
        'حقوق الموقع محفوظة',
        'المحتوى والصور والتصميم ملك لسمسار طلبك',
        ['الصور والتصميم ملكية خاصة',
         'لا يُسمح بالنسخ التجاري',
         'العلامة «سمسار طلبك» محفوظة'],
        'سمسار طلبك · مدينة نصر',
    )),
    'luxury': ('social-luxury.jpg', lambda: card_hero(
        'المعرض السينمائي',
        'الشقق الفاخرة',
        'وحدات مختارة تبدأ من 8 ملايين جنيه — فيديو لكل وحدة',
        'مدينة نصر · وحدات محدودة',
        title_size=80,
    )),
    'opportunities': ('social-opportunities.jpg', lambda: card_list(
        'الفرص',
        'فرص عقارية مختارة',
        'وحدات بأسعار ومزايا تستحق النظر',
        ['مراجعة سعرية حديثة',
         'بيانات موثّقة لكل وحدة',
         'تقييم قبل العرض'],
        'مدينة نصر · تحديث مستمر',
    )),
    'crm': ('social-crm.jpg', lambda: card_hero(
        'إدارة المتابعة',
        'لوحة إدارة العملاء',
        'متابعة الطلبات والعروض والمواعيد في مكان واحد',
        'داخلي · سمسار طلبك',
        title_size=68,
    )),
    'notifications': ('social-notifications.jpg', lambda: card_list(
        'الإشعارات',
        'تنبيهات العقارات الجديدة',
        'اعرف أول ما يُضاف عقار يناسب طلبك',
        ['إشعارات فورية على جهازك',
         'تُبنى على طلبك المسجّل',
         'يمكنك إيقافها في أي وقت'],
        'مدينة نصر · تحديث مستمر',
    )),
    'video-preview': ('social-video.jpg', lambda: card_hero(
        'فيديوهات الوحدات',
        'شاهد قبل أن تزور',
        'فيديو لكل وحدة — المساحة والفيو والتشطيب',
        'مدينة نصر · معرض سينمائي',
        title_size=78,
    )),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets/img'))
    ap.add_argument('--only', default='')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--quality', type=int, default=92)
    args = ap.parse_args()

    if args.list:
        for k, (f, _) in CARDS.items():
            print(f'{k:24s} → {f}')
        return 0

    os.makedirs(args.out, exist_ok=True)
    keys = [k.strip() for k in args.only.split(',') if k.strip()] or list(CARDS)
    for k in keys:
        if k not in CARDS:
            print(f'✗ غير معروف: {k}')
            continue
        fname, build = CARDS[k]
        img = build()
        path = os.path.join(args.out, fname)
        img.convert('RGB').save(path, 'JPEG', quality=args.quality,
                                optimize=True, progressive=True)
        print(f'✅ {fname:32s} {img.width}x{img.height}  {os.path.getsize(path)/1024:6.1f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
