#!/usr/bin/env python3
"""
مولّد فيديو العرض العقاري — صورة حقيقية + حركة خفيفة + نص عربي سليم + الصوت المعتمد.

المبادئ (لا تُخترق):
  1. الصورة هي صورة العرض المنشورة نفسها — لا توليد، لا توسيع، لا غرف مُختلقة.
  2. أقصى حركة: 6% زوم على مدى الفيديو. عرض لا تلاعب بالمساحة.
  3. كل رقم على الشاشة مأخوذ من front matter العرض — لا رقم مُختلق.
  4. الصوت هو الملف المعتمد (اختياريًا + موسيقى أصلية مولّدة، محفورة نطاق الكلام).
  5. لا تشغيل تلقائي في الموقع — هذا ملف يُطلب عند الطلب فقط.

الاستعمال:
  python3 scripts/audio/make-listing-video.py <slug> --out=/tmp/x.mp4 [--music]
"""
import subprocess, sys, os, json, re, argparse
from PIL import Image
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arabic_text as AT

FF = os.environ.get('FFMPEG') or ''
if not FF:
    try:
        import imageio_ffmpeg
        FF = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FF = 'ffmpeg'

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W, H = 480, 854   # 9:16 خفيف — الصفحة لا تحمّله إلا عند الطلب
TMP = '/tmp/_vid'

GREEN = (66, 197, 65)
WHITE = (255, 255, 255)
DIM = (176, 184, 176)


def read_front_matter(slug):
    # نطابق حقل slug في الـfront matter، لا اسم الملف: اسم الملف قد يخالفه
    md, hit = '', None
    for f in sorted(os.listdir(f'{ROOT}/_properties')):
        if not f.endswith('.md'):
            continue
        text = open(f'{ROOT}/_properties/{f}', encoding='utf-8').read()
        if re.search(rf'^slug:\s*"?{re.escape(slug)}"?\s*$', text, re.M):
            md, hit = text, f
            break
    if hit is None:
        raise SystemExit(f'لا يوجد عرض بالـslug: {slug}')
    fm = md.split('---')[1]

    def g(key):
        m = re.search(rf'^{key}:\s*"?(.*?)"?\s*$', fm, re.M)
        return m.group(1).strip() if m else ''

    return {k: g(k) for k in ('title', 'price', 'area', 'rooms', 'bathrooms', 'floor',
                              'finish', 'location', 'image_file', 'audio_file', 'audio_script')}


def audio_duration(path):
    out = subprocess.run([FF, '-i', path], capture_output=True).stderr.decode('utf8', 'replace')
    m = re.search(r'Duration:\s*(\d+):(\d+):([\d.]+)', out)
    if not m:
        raise SystemExit('لم أقرأ مدة الصوت')
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def short_title(title):
    """عنوان قصير للشاشة — يحذف البادئة واللواحق الإدارية فقط."""
    t = re.sub(r'^شقة\s*', '', title)
    t = re.sub(r'\s*للبيع.*$', '', t)
    t = re.sub(r'\s*-\s*مدينة نصر.*$', '', t)
    t = re.sub(r'\s*-\s*المنطقة.*$', '', t)
    return t.strip()


def show_title(L):
    """سطر وصفي تحت السعر: النعت ثم الموقع — بلا تكرار المساحة."""
    t = short_title(L['title'])
    t = re.sub(r'^\d+\s*م\s*', '', t).strip()          # احذف المساحة (معروضة كبيرة)
    t = re.sub(r'^\s*[-–—]\s*', '', t).strip()
    loc = (L.get('location') or '').split('(')[0].split('-')[0].strip()
    parts = [x for x in (t, loc) if x]
    out = ' · '.join(dict.fromkeys(parts))
    if len(out) > 34:
        out = out[:34].rsplit(' ', 1)[0]
    return out


def make_poster(L, out_png):
    """كادر ثابت: الصورة الحقيقية + تدرّج + نصوص العرض."""
    src = f"{ROOT}/assets/img/properties/{L['image_file']}"
    im = Image.open(src).convert('RGB')

    # قص لتغطية 9:16 مع الحفاظ على أقصى قدر من الصورة
    tr = max(W / im.width, H / im.height)
    im = im.resize((max(1, int(im.width * tr)), max(1, int(im.height * tr))), Image.LANCZOS)
    x = (im.width - W) // 2
    y = max(0, int((im.height - H) * 0.35))
    im = im.crop((x, y, x + W, y + H))

    arr = np.array(im, dtype=np.float32)

    # تدرّج: تعتيم أعلى وأسفل — النص يبان، الصورة نفسها بلا تعديل في المحتوى
    yy = np.arange(H, dtype=np.float32)[:, None]
    # التعتيم العلوي أُزيل مع النصوص العلوية ⇒ الصورة تظهر بسطوعها الكامل
    top = np.clip(1 - yy / (H * 0.34), 0, 1) ** 1.4 * 0.0
    bot = np.clip((yy - H * 0.56) / (H * 0.44), 0, 1) ** 1.15 * 0.88
    shade = np.clip(np.maximum(top, bot), 0, 0.88)
    arr = arr * (1 - shade[..., None])

    canvas = arr.astype(np.uint8)
    pad = 22

    # ⚠️ النصوص العلوية (العلامة + الشعار + المساحة) حُذفت بطلب المالك
    # 2026-11-18: «ولا داعي للنصوص الموجوده في اعلي الفيديو». المساحة
    # مذكورة أصلًا في العنوان. لا تُعِدها.

    # ── العنوان + السعر (أسفل) ──
    # من الأسفل للأعلى (لأننا نرصّ فوق الشريط الأخضر):
    bar_h = 52
    base_y = H - bar_h - 20          # آخر سطر (المواصفات)
    specs = []
    if L['bathrooms']:
        specs.append(L['bathrooms'])
    if L['floor']:
        specs.append(L['floor'])
    if L['finish']:
        specs.append(L['finish'])
    # نبني السطر من الأهم للأقل، ونوقف قبل تجاوز العرض المتاح
    spec_line, limit = '', W - pad * 2 - 6
    for part in [x for x in specs if x]:
        cand = part if not spec_line else spec_line + ' · ' + part
        if AT.measure(cand, 17, '400') > limit:
            break
        spec_line = cand
    if spec_line:
        AT.draw(canvas, (W - pad, base_y - 16), spec_line, 17, '400', (226, 234, 226), 'rb')

    price_y = base_y - 52
    AT.draw(canvas, (W - pad, price_y), L['price'], 34, '900', WHITE, 'rb')

    title_y = price_y - 54
    title = show_title(L)
    for ln in reversed(AT.wrap(title, 20, W - pad * 2, '700')[:2]):
        AT.draw(canvas, (W - pad, title_y), ln, 20, '700', (238, 242, 238), 'rb')
        title_y -= 27

    # ── شريط أخضر سفلي: الدعوة ──
    bar_h = 52
    arr2 = canvas.astype(np.float32)
    arr2[H - bar_h:, :] = np.array(GREEN, dtype=np.float32)
    canvas = arr2.astype(np.uint8)
    AT.draw(canvas, (W // 2, H - bar_h + 8), 'كلم طارق على واتساب · 01147758857',
            17, '900', (5, 5, 5), 'ma')

    Image.fromarray(canvas).save(out_png)
    return out_png


def build_audio(L, slug, want_music):
    src = f"{ROOT}{L['audio_file']}"
    if not want_music:
        return src
    dur = audio_duration(src)
    bed = f'{TMP}/bed.wav'
    subprocess.run([sys.executable, f'{ROOT}/scripts/audio/make-music-bed.py',
                    str(dur + 1), bed], check=True, capture_output=True)
    out = f'{TMP}/mix.mp3'
    fc = ("[1:a]volume=0.11,afade=t=in:st=0:d=1.2,"
          f"afade=t=out:st={max(dur - 2.2, 1):.1f}:d=2.2[m];"
          "[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]")
    subprocess.run([FF, '-y', '-i', src, '-i', bed, '-filter_complex', fc,
                    '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '40k',
                    '-ar', '24000', '-ac', '1', out], check=True, capture_output=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('slug')
    ap.add_argument('--out', required=True)
    ap.add_argument('--music', action='store_true')
    ap.add_argument('--zoom', type=float, default=0.05)
    a = ap.parse_args()

    os.makedirs(TMP, exist_ok=True)
    d = os.path.dirname(a.out)
    if d:
        os.makedirs(d, exist_ok=True)

    L = read_front_matter(a.slug)
    poster = make_poster(L, f'{TMP}/{a.slug}_poster.png')
    aud = build_audio(L, a.slug, a.music)
    dur = audio_duration(aud)

    # 12 إطارًا/ث: صورة شبه ثابتة بزوم بطيء — النصف حجمًا بلا فرق محسوس
    fps = 12
    frames = max(1, int(dur * fps))
    vf = (f"zoompan=z='min(1+{a.zoom}*on/{frames},1+{a.zoom})':"
          f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={fps}")

    subprocess.run([FF, '-y', '-loop', '1', '-i', poster, '-i', aud,
                    '-vf', vf, '-t', f'{dur:.2f}',
                    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '30',
                    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.0',
                    '-g', str(fps * 2),
                    '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-ar', '24000',
                    '-shortest', '-movflags', '+faststart',
                    a.out], check=True, capture_output=True)

    sz = os.path.getsize(a.out)
    print(json.dumps({'slug': a.slug, 'out': a.out, 'kb': round(sz / 1024),
                      'bytes': sz, 'seconds': round(dur, 2), 'music': a.music},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
