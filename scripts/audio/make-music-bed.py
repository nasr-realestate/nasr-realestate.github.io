#!/usr/bin/env python3
"""
توليد موسيقى خلفية أصلية (Royalty-free 100%) لعروض العقارات.
لا تُستخدم أي عيّنة أو ملف موسيقي خارجي — كل النغمات تُحسب رياضيًا.
"""
import numpy as np
from scipy.io import wavfile
import sys

SR = 44100

def env_ad(n, attack, decay, sr=SR):
    """مغلّف هجوم/انحلال ناعم."""
    a = int(attack * sr)
    d = max(n - a, 1)
    e = np.ones(n)
    if a > 0:
        e[:a] = np.linspace(0, 1, a) ** 0.6
    e[a:] = np.exp(-np.linspace(0, 1, d) * decay)
    return e

def note(freq, dur, amp=1.0, attack=0.01, decay=3.0, harm=(1, 0.5, 0.25, 0.12), detune=0.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for i, h in enumerate(harm, start=1):
        f = freq * i * (1 + detune * i)
        out += h * np.sin(2 * np.pi * f * t)
    out *= env_ad(n, attack, decay) * amp
    return out

def pad(freqs, dur, amp=0.2):
    """طبقة دافئة بطيئة الهجوم — التشاور الموسيقي يغطي الصوت بلا تشويش."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in freqs:
        # كسر توافق خفيف = دفء (chorus طبيعي)
        for d in (-0.15, 0.0, 0.15):
            ff = f * (1 + d / 100)
            out += (np.sin(2 * np.pi * ff * t) + 0.3 * np.sin(4 * np.pi * ff * t)) / (len(freqs) * 3)
    # هجوم/خروج ناعم جدًا
    out *= env_ad(n, dur * 0.35, 1.2) * amp
    return out

def reverb(x, amount=0.22, decay=1.4):
    """ريفيرب بسيط: التفاف بطيف متراجع."""
    ir_len = int(decay * SR)
    ir = np.random.randn(ir_len) * np.exp(-np.linspace(0, 6, ir_len))
    ir /= np.abs(ir).sum() ** 0.5
    wet = np.convolve(x, ir, mode='full')[: len(x)]
    return (1 - amount) * x + amount * wet

def whoosh(dur=0.9, amp=0.16):
    """متدرّج دخول ناعم (فلتر ضوضاء يفتح)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.random.randn(n)
    # مرشح منخفض بسيط يفتح تدريجيًا
    out = np.zeros(n)
    lp = 0.0
    for i in range(n):  # بطيء لكن مقبول لمرة واحدة
        k = 0.02 + 0.30 * (i / n)
        lp += k * (noise[i] - lp)
        out[i] = lp
    env = np.sin(np.linspace(0, np.pi, n)) ** 2
    out = out * env * amp
    out /= (np.abs(out).max() or 1)
    return out * amp

def sparkle(dur=1.1, amp=0.10):
    """لمعة ختامية (نداء للتواصل) — نغمات عالية متتابعة."""
    n = int(dur * SR)
    out = np.zeros(n)
    freqs = [1318.5, 1568.0, 1760.0, 2093.0]  # E6 G6 A6 C7
    for i, f in enumerate(freqs):
        start = int(i * 0.09 * SR)
        seg = note(f, dur - i * 0.09, amp=amp * (1 - i * 0.15), attack=0.005, decay=5.0,
                   harm=(1, 0.2, 0.08))
        out[start:start + len(seg)] += seg[: n - start]
    return out

# ─── نغمة A الصغيرة ───
A3, C4, E4, F3, G3, A4, C5, E5, D4, B3 = 220.0, 261.63, 329.63, 174.61, 196.0, 440.0, 523.25, 659.25, 293.66, 246.94

def build_bed(total=30.0, bpm=92, intensity=1.0):
    beats = total * bpm / 60
    out = np.zeros(int((total + 3) * SR))

    # ◼ التتابع: Am → F → C → G (دافئ، غير حزين، لا يُشتّت)
    prog = [
        ([A3, C4, E4], [A4, C5, E5]),
        ([F3, A3, C4], [F3 * 2, A4, C5]),
        ([C4, E4, G3 * 2], [C5, E5, G3 * 4]),
        ([G3, B3, D4], [G3 * 2, B3 * 2, D4 * 2]),
    ]
    chord_dur = 4 * 60 / bpm  # 4 ضربات

    tpos = 0.0
    ci = 0
    while tpos < total:
        root, tones = prog[ci % len(prog)]
        d = min(chord_dur, total - tpos)
        if d <= 0:
            break
        s = int(tpos * SR)

        # الطبقة (pad) — خافتة تحت الصوت
        p = pad(root, d, amp=0.11 * intensity)
        out[s:s + len(p)] += p[: len(out) - s] if s + len(p) > len(out) else p

        # بيانو خفيف على نغمات الكورد
        for j, f in enumerate(tones):
            nt = note(f, min(d, 2.4), amp=0.10 * intensity, attack=0.02, decay=3.2,
                      harm=(1, 0.45, 0.18, 0.07), detune=0.0008)
            off = int((j * 0.5) * SR)
            if s + off < len(out):
                seg = nt[: len(out) - (s + off)]
                out[s + off: s + off + len(seg)] += seg

        tpos += chord_dur
        ci += 1

    out = reverb(out, amount=0.25, decay=1.6)
    out = out[: int(total * SR)]

    # ═══ حَفر نطاق الكلام ═══
    # الموسيقى لازم تفضل *تحت* الصوت. نطاق الكلام 300–3000 هرتز هو اللي
    # بيدفع المعلومة للأذن. لو الموسيقى فيها طاقة هناك، العميل مش هيسمع
    # السعر والمساحة — وده أسوأ من مفيش موسيقى.
    # الحل: مرشح منخفض يقطع فوق 900 هرتز + حزمة مقصوصة عند 1.8 ك.
    from scipy.signal import butter, sosfilt, iirnotch, filtfilt

    sos = butter(6, 900, btype='low', fs=SR, output='sos')
    out = sosfilt(sos, out)

    # قصّ إضافي ضيق عند نطاق الوضوح (1.5–2.5 ك) — ~-10 دسيبل
    for f0 in (1600.0, 2200.0):
        b_, a_ = iirnotch(f0, Q=1.2, fs=SR)
        out = filtfilt(b_, a_, out)

    # تطبيع
    peak = np.abs(out).max() or 1
    out = out / peak * 0.55
    return out

def main():
    total = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    out_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bed.wav'

    bed = build_bed(total=total)

    # مؤثرات: دخول ناعم في البداية + لمعة في النهاية
    w = whoosh(0.9, amp=0.05)
    bed[: len(w)] += w
    sp = sparkle(1.2, amp=0.045)
    start = len(bed) - len(sp) - int(0.15 * SR)
    bed[start:start + len(sp)] += sp

    # خفض تدريجي في الخروج (fade out)
    fo = int(1.8 * SR)
    bed[-fo:] *= np.linspace(1, 0, fo)
    fi = int(0.6 * SR)
    bed[:fi] *= np.linspace(0, 1, fi)

    peak = np.abs(bed).max() or 1
    bed = bed / peak * 0.85
    wavfile.write(out_path, SR, (bed * 32767).astype(np.int16))
    print('OK', out_path, f'{total}s')

if __name__ == '__main__':
    main()
