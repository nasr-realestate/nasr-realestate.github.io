#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
═══════════════════════════════════════════════════════════════════════
 scripts/audio/measure_voice_identity.py — قياس الهوية الصوتية
───────────────────────────────────────────────────────────────────────
 أداة قياس **جنائية/تدقيقية**، تعمل خارج CI عمدًا: تحتاج torch + resemblyzer
 (~5.4 GB) وهي غير متاحة في GitHub Actions لهذا المستودع، ولا يجوز أن يعتمد
 النشر عليها. بوابة CI الملزِمة هي scripts/audio/verify-voice-identity.mjs
 (بلا أي حزمة خارجية). انظر identityBand.notAvailableInCi في المواصفة.

 ما تقيسه فعليًا (لا أحكام سمعية ولا أرقام مخترعة):
   1. بصمة متحدث 256 بُعدًا لكل ملف (نموذج GE2E من حزمة resemblyzer على PyPI —
      النموذج مُضمَّن في الحزمة فلا حاجة إلى huggingface.co).
   2. تشابه جيب التمام مع المرجع الذي اختاره المالك.
   3. نطاق «نفس الصوت» من أزواج داخل جلسة إنتاج واحدة (من السجل)، واختبار
      ضابط بتقسيم الملف نفسه إلى أثلاث (نفس الصوت، كلمات مختلفة).
   4. تجميع single-linkage عند حدّ p5 لكشف جلسات الإنتاج المختلفة.
   5. الإيقاع والوقفات من غلاف الطاقة (معدل الكلمات/ثانية، عدد الوقفات،
      أطولها ومتوسطها، نسبة الكلام) — بديل موضوعي عن «الاستماع».
   6. خصائص صوتية: F0 (وسيط ونطاق)، centroid، rolloff85، peak/RMS، قصّ.

 حدود يجب ألا تُنسى (موثَّقة كذلك في المواصفة):
   • نموذج GE2E مُدرَّب على الإنجليزية؛ قيم جيب التمان **المطلقة** لا تنتقل
     إلى العربية. لذلك تُستخدم الحدود النسبية داخل المتن نفسه (نطاق «نفس
     الصوت» المقاس من أزواج مؤكَّدة الموديل) ولا يُدّعى أي حد عالمي.
   • لا يوجد ASR متاح (أوزانه على huggingface.co المحجوب)، فلا تحقق من صحة
     النطق كلمة بكلمة. الإيقاع والوقفات وF0 بدائل موضوعية معلنة.
   • لا شيء هنا يُغني عن معاينة المالك؛ القرار النهائي بشري.

 التشغيل:
   python3 scripts/audio/measure_voice_identity.py --mp3 assets/audio/properties/<slug>.mp3
   python3 scripts/audio/measure_voice_identity.py --all --out /tmp/baseline.json
   python3 scripts/audio/measure_voice_identity.py --band
═══════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SPEC_PATH = os.path.join(ROOT, "_data", "voice_identity.json")
LOG_PATH = os.path.join(ROOT, "_data", "audio_voice_log.json")
AUDIO_DIR = os.path.join(ROOT, "assets", "audio")

MISSING = []


def _need(module_name: str):
    """استيراد اختياري: يُسجَّل الاسم الناقص ويُبلَّغ عنه مرة واحدة في النهاية."""
    try:
        return __import__(module_name)
    except Exception:  # noqa: BLE001
        MISSING.append(module_name)
        return None


def load_dependencies():
    """استيراد التبعيات أو الفشل برسالة قابلة للتنفيذ (لا فشل صامت)."""
    np = _need("numpy")
    sf = _need("soundfile")
    librosa = _need("librosa")
    try:
        from resemblyzer import VoiceEncoder  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        MISSING.append("resemblyzer")
        VoiceEncoder = None
    if MISSING:
        sys.stderr.write(
            "\n❌ تبعيات ناقصة: " + ", ".join(sorted(set(MISSING))) + "\n"
            "   هذه الأداة تعمل خارج CI عمدًا. للتشغيل المحلي:\n"
            "     python3 -m venv /tmp/audio-venv && . /tmp/audio-venv/bin/activate\n"
            "     pip install numpy soundfile librosa resemblyzer\n"
            "   ملاحظات مثبتة بالتجربة:\n"
            "     • webrtcvad لا يُبنى بلا Python.h ⇒ لا تستدعِ preprocess_wav؛\n"
            "       مرّر PCM مفكوكًا مباشرةً إلى embed_utterance.\n"
            "     • resemblyzer يحتاج رقعة scipy.ndimage.morphology (أُزيلت في scipy≥1.11).\n"
            "     • فك ترميز MP3 يأتي من libsndfile ≥ 1.1 داخل soundfile.\n"
            "   بوابة CI لا تحتاج أيًا من هذا: scripts/audio/verify-voice-identity.mjs\n\n"
        )
        raise SystemExit(2)
    return np, sf, librosa, VoiceEncoder


NP, SF, LIBROSA, VOICE_ENCODER = None, None, None, None


def load_spec() -> dict:
    with open(SPEC_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def load_log() -> dict:
    if not os.path.exists(LOG_PATH):
        return {"entries": []}
    with open(LOG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def audio_files() -> list[str]:
    found = []
    for base, _dirs, names in os.walk(AUDIO_DIR):
        for n in sorted(names):
            if n.lower().endswith(".mp3"):
                found.append(os.path.relpath(os.path.join(base, n), ROOT).replace(os.sep, "/"))
    return sorted(found)


def read_pcm16k(rel: str) -> "NP.ndarray":
    """فك الترميز إلى أحادي 16 kHz كما يتوقعه مشفّر GE2E."""
    x, sr = SF.read(os.path.join(ROOT, rel), dtype="float32", always_2d=True)
    mono = x.mean(axis=1)
    if sr != 16000:
        mono = LIBROSA.resample(mono, orig_sr=sr, target_sr=16000).astype("float32")
    return mono


def unit(vec) -> "NP.ndarray":
    v = NP.asarray(vec, dtype=float)
    return v / (NP.linalg.norm(v) or 1.0)


def acoustic_profile(rel: str) -> dict:
    """خصائص الإشارة: F0، الطيف، الذروة/الـRMS، القصّ."""
    x, sr = SF.read(os.path.join(ROOT, rel), dtype="float32", always_2d=True)
    mono = x.mean(axis=1).astype("float64")
    peak = float(NP.max(NP.abs(mono))) or 1e-12
    rms = float(NP.sqrt(NP.mean(mono ** 2))) or 1e-12
    db = lambda v: round(20.0 * float(NP.log10(v)), 2)  # noqa: E731

    # F0 بتتبّع ذاتي على إطارات 40ms (نطاق 70–400Hz لصوت رجل بالغ)
    frame = int(0.040 * sr)
    hop = int(0.020 * sr)
    n_frames = 1 + max(0, (len(mono) - frame) // hop)
    f0s = []
    for i in range(n_frames):
        seg = mono[i * hop: i * hop + frame]
        if len(seg) < frame or float(NP.sqrt(NP.mean(seg ** 2))) < 0.01:
            continue
        seg = seg - seg.mean()
        corr = NP.correlate(seg, seg, mode="full")[len(seg) - 1:]
        lo, hi = int(sr / 400.0), int(sr / 70.0)
        if hi >= len(corr):
            continue
        window = corr[lo:hi]
        if window.size == 0 or corr[0] <= 0:
            continue
        lag = lo + int(NP.argmax(window))
        if corr[lag] / corr[0] > 0.4:
            f0s.append(sr / lag)
    f0 = NP.array(f0s) if f0s else NP.array([0.0])
    centroid = float(LIBROSA.feature.spectral_centroid(y=mono, sr=sr).mean())
    rolloff = float(LIBROSA.feature.spectral_rolloff(y=mono, sr=sr, roll_percent=0.85).mean())
    return {
        "peakDbfs": db(peak),
        "rmsDbfs": db(rms),
        "clippedSamples": int(NP.sum(NP.abs(mono) >= 0.999)),
        "voicedFrames": int(len(f0s)),
        "f0MedianHz": round(float(NP.median(f0)), 1),
        "f0P05Hz": round(float(NP.percentile(f0, 5)), 1),
        "f0P95Hz": round(float(NP.percentile(f0, 95)), 1),
        "f0IqrHz": round(float(NP.percentile(f0, 75) - NP.percentile(f0, 25)), 1),
        "spectralCentroidHz": round(centroid, 1),
        "spectralRolloff85Hz": round(rolloff, 1),
    }


def rhythm_profile(rel: str, words: int | None) -> dict:
    """الإيقاع والوقفات من غلاف الطاقة — بديل موضوعي عن الاستماع."""
    x, sr = SF.read(os.path.join(ROOT, rel), dtype="float32", always_2d=True)
    mono = x.mean(axis=1)
    win = int(0.020 * sr)
    k = len(mono) // win
    if k < 3:
        return {}
    env = NP.abs(mono[: k * win]).reshape(k, win).mean(axis=1)
    thr = max(1e-4, float(NP.percentile(env, 18)) * 1.6)
    voiced = env > thr
    min_gap = int(0.080 / 0.020)      # أقصر من هذا = فاصل بين الكلمات لا وقفة
    min_speech = int(0.120 / 0.020)

    runs, gaps, i = [], [], 0
    while i < len(voiced):
        j = i
        while j < len(voiced) and voiced[j] == voiced[i]:
            j += 1
        (runs if voiced[i] else gaps).append((i, j - i))
        i = j
    pauses = [ln * 0.020 for st, ln in gaps if ln >= min_gap and 0 < st and st + ln < len(voiced)]
    speech = sum(ln for _s, ln in runs if ln >= min_speech) * 0.020
    total = len(voiced) * 0.020
    out = {
        "audioSeconds": round(total, 3),
        "voicedSeconds": round(speech, 3),
        "silenceSeconds": round(total - speech, 3),
        "voicedRatio": round(speech / total, 3) if total else None,
        "pauseCount": len(pauses),
        "pauseTotalSeconds": round(sum(pauses), 3),
        "pauseMaxSeconds": round(max(pauses), 3) if pauses else 0.0,
        "pauseMeanSeconds": round(sum(pauses) / len(pauses), 3) if pauses else None,
    }
    if words:
        out["words"] = words
        out["wordsPerSecondOverall"] = round(words / total, 3) if total else None
        out["wordsPerSecondVoiced"] = round(words / speech, 3) if speech else None
    return out


def third_embeddings(encoder, mono):
    """اختبار ضابط: ثلاثة مقاطع من نفس الملف (نفس الصوت، كلمات مختلفة)."""
    n = len(mono) // 3
    if n < 16000:
        return []
    return [unit(encoder.embed_utterance(mono[i * n:(i + 1) * n])) for i in range(3)]


def same_voice_band(entries: dict, embeds: dict) -> dict:
    """نطاق «نفس الصوت» من أزواج داخل جلسة إنتاج واحدة مؤكَّدة."""
    sessions: dict[str, list[str]] = {}
    for rel, e in entries.items():
        sessions.setdefault(str(e.get("productionSession") or "?"), []).append(rel)
    pairs = []
    for members in sessions.values():
        for a, b in itertools.combinations(sorted(members), 2):
            if a in embeds and b in embeds:
                pairs.append(round(float(NP.dot(embeds[a], embeds[b])), 4))
    if not pairs:
        return {"n": 0}
    arr = NP.array(pairs)
    return {
        "n": int(arr.size),
        "min": round(float(arr.min()), 4),
        "p1": round(float(NP.percentile(arr, 1)), 4),
        "p5": round(float(NP.percentile(arr, 5)), 4),
        "p25": round(float(NP.percentile(arr, 25)), 4),
        "median": round(float(NP.median(arr)), 4),
        "p75": round(float(NP.percentile(arr, 75)), 4),
        "max": round(float(arr.max()), 4),
        "mean": round(float(arr.mean()), 4),
    }


def classify(cosine: float | None, thresholds: dict) -> str:
    """نفس قواعد السجل — لا تصنيفات ارتجالية."""
    if cosine is None:
        return "cannot-assess"
    if cosine >= thresholds["identicalVoice"]:
        return "compatible-with-reference"
    if cosine >= thresholds["borderlineNeedsOwnerApproval"]:
        return "possible-deviation-review"
    return "clear-difference"


def single_linkage(names, embeds, threshold):
    parent = {n: n for n in names}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in itertools.combinations(names, 2):
        if float(NP.dot(embeds[a], embeds[b])) >= threshold:
            parent[find(a)] = find(b)
    groups: dict[str, list[str]] = {}
    for n in names:
        groups.setdefault(find(n), []).append(n)
    return sorted(groups.values(), key=lambda g: (-len(g), min(g)))


def script_words(entry: dict) -> int | None:
    text = entry.get("script")
    if not text:
        return None
    return len([w for w in str(text).split() if w.strip()])


def build_embeddings(rels: list[str]):
    encoder = VOICE_ENCODER(device="cpu", verbose=False)
    return {rel: unit(encoder.embed_utterance(read_pcm16k(rel))) for rel in rels}, encoder


def cmd_mp3(target: str) -> int:
    spec, log = load_spec(), load_log()
    ref_rel = spec["reference"]["repoPath"]
    rels = sorted({target, ref_rel})
    embeds, encoder = build_embeddings(rels)
    cosine = 1.0 if target == ref_rel else round(float(NP.dot(embeds[target], embeds[ref_rel])), 4)
    thr = spec["identityBand"]["thresholds"]
    band = spec["identityBand"]["sameVoicePairs"]
    entry = next((e for e in log["entries"] if e["audioFile"] == target), {})
    mono = read_pcm16k(target)
    thirds = third_embeddings(encoder, mono)
    cross = [round(float(NP.dot(a, b)), 4) for a, b in itertools.combinations(thirds, 2)] if len(thirds) == 3 else []

    print(f"\nالملف: {target}")
    print(f"  المرجع: {ref_rel}")
    print(f"  تشابه جيب التمام مع المرجع: {cosine}")
    print(f"  التصنيف وفق identityBand.thresholds: {classify(cosine, thr)}")
    print(f"  نطاق «نفس الصوت» المقاس سابقًا: min={band.get('min')} p5={band.get('p5')} median={band.get('median')}")
    print(f"  قرار السياسة: ", end="")
    if cosine >= thr["identicalVoice"]:
        print("يُنشر ويُقيَّد تلقائيًا")
    elif cosine >= thr["borderlineNeedsOwnerApproval"]:
        print("يتطلب موافقة المالك في نفس الجلسة (نطاق حرج)")
    elif cosine >= thr["unacceptable"]:
        print("يتطلب ownerOverride موثَّقًا من المالك — لا يُنشر صمتًا")
    else:
        print("مرفوض — تحت الحد غير المقبول")
    if cross:
        print(f"  اتساق داخلي (أثلاث نفس الملف): {cross} — المتوسط {round(sum(cross)/len(cross),4)}")
    print(f"  الإيقاع: {json.dumps(rhythm_profile(target, script_words(entry)), ensure_ascii=False)}")
    print(f"  الصوتيات: {json.dumps(acoustic_profile(target), ensure_ascii=False)}")
    print("\n⚠️  GE2E مُدرَّب على الإنجليزية: القيمة **النسبية** إلى نطاق المتن هي المعنى، لا الرقم المطلق.")
    print("    لا شيء هنا يُغني عن معاينة المالك عبر add_voice.\n")
    return 0


def cmd_all(out_path: str | None) -> int:
    spec, log = load_spec(), load_log()
    ref_rel = spec["reference"]["repoPath"]
    entries = {e["audioFile"]: e for e in log["entries"]}
    rels = audio_files()
    for rel in rels:
        if rel not in entries:
            sys.stderr.write(f"❌ {rel} غير مقيَّد في السجل — شغّل بوابة CI أولًا.\n")
            return 1
    embeds, encoder = build_embeddings(rels)
    thr = spec["identityBand"]["thresholds"]

    per_file = {}
    control_pairs = []
    for rel in rels:
        entry = entries[rel]
        mono = read_pcm16k(rel)
        thirds = third_embeddings(encoder, mono)
        if len(thirds) == 3:
            control_pairs += [float(NP.dot(a, b)) for a, b in itertools.combinations(thirds, 2)]
        cosine = 1.0 if rel == ref_rel else round(float(NP.dot(embeds[rel], embeds[ref_rel])), 4)
        per_file[rel] = {
            "slug": os.path.basename(rel)[:-4],
            "cosineToReference": cosine,
            "classification": "reference" if rel == ref_rel else classify(cosine, thr),
            "productionSession": entry.get("productionSession"),
            "origin": entry.get("origin"),
            "rhythm": rhythm_profile(rel, script_words(entry)),
            "acoustic": acoustic_profile(rel),
        }

    groups = single_linkage(rels, embeds, thr["identicalVoice"])
    ctrl = NP.array(control_pairs) if control_pairs else NP.array([0.0])
    result = {
        "_comment": [
            "ناتج scripts/audio/measure_voice_identity.py --all",
            "كل رقم قياس فعلي قابل للتكرار. GE2E مُدرَّب على الإنجليزية ⇒",
            "الحدود نسبية إلى هذا المتن ولا تُقرأ كحدود عالمية.",
        ],
        "reference": {"path": ref_rel, "embedding256": [round(float(v), 5) for v in embeds[ref_rel]]},
        "sameVoiceBand": same_voice_band(entries, embeds),
        "withinFileControl": {
            "definition": "أثلاث نفس الملف — نفس الصوت، كلمات مختلفة (اختبار ضابط)",
            "n": int(ctrl.size),
            "min": round(float(ctrl.min()), 4),
            "median": round(float(NP.median(ctrl)), 4),
            "max": round(float(ctrl.max()), 4),
        },
        "voiceGroups": [
            {
                "id": f"G{i + 1}",
                "size": len(g),
                "members": [os.path.basename(x) for x in sorted(g)],
                "cosineToReference": [per_file[x]["cosineToReference"] for x in sorted(g)],
            }
            for i, g in enumerate(groups)
        ],
        "files": per_file,
    }
    text = json.dumps(result, ensure_ascii=False, indent=1) + "\n"
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"✅ كُتب {out_path} ({len(rels)} ملفًا)")
    else:
        sys.stdout.write(text)
    return 0


def cmd_band() -> int:
    """طباعة الحدود المقاسة المخزَّنة في المواصفة مع تفسيرها — بلا قياس جديد."""
    spec = load_spec()
    band = spec["identityBand"]
    print("\nحدود الهوية الصوتية (مقاسة، من _data/voice_identity.json)")
    print(f"  الطريقة: {band['method']}")
    print(f"  مصدر النموذج: {band['modelSource']}")
    print(f"  متاحة في CI؟ {band['notAvailableInCi']}")
    s = band["sameVoicePairs"]
    print(f"  أزواج «نفس الصوت» (n={s['n']}): min={s['min']} p1={s['p1']} p5={s['p5']} "
          f"median={s['median']} max={s['max']}")
    c = band["withinFilePairs"]
    print(f"  الاختبار الضابط (n={c['n']}): min={c['min']} median={c['median']} max={c['max']}")
    r = band["referenceVsCorpus"]
    print(f"  المرجع مقابل المتن (n={r['n']}): min={r['min']} median={r['median']} max={r['max']}")
    a = band["achievedCeilingThisSession"]
    print(f"  أقصى ما بلغه المحرك في جلسة 2026-10-18 بعد معاينتين: {a['selected']} = {a['selectedCosine']}")
    print(f"  الحدود: {json.dumps(band['thresholds'], ensure_ascii=False)}")
    print("\n  السياسة:")
    for k, v in band["policy"].items():
        print(f"    • {k}: {v}")
    print(f"\n  الحد التقني للمحرك: {spec['engine']['hardLimit']}\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="قياس الهوية الصوتية لإعلانات سمسار طلبك")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--mp3", metavar="PATH", help="قياس ملف واحد مقابل المرجع")
    group.add_argument("--all", action="store_true", help="قياس كل المتن وكتابة خط أساس")
    group.add_argument("--band", action="store_true", help="طباعة الحدود المقاسة المخزَّنة")
    parser.add_argument("--out", metavar="PATH", help="مسار ناتج --all")
    args = parser.parse_args()

    if args.band:
        return cmd_band()

    global NP, SF, LIBROSA, VOICE_ENCODER
    NP, SF, LIBROSA, VOICE_ENCODER = load_dependencies()

    if args.mp3:
        target = args.mp3.replace(os.sep, "/")
        if target.startswith("./"):
            target = target[2:]
        if os.path.isabs(target):
            target = os.path.relpath(target, ROOT).replace(os.sep, "/")
        if not os.path.exists(os.path.join(ROOT, target)):
            sys.stderr.write(f"❌ الملف غير موجود: {target}\n")
            return 1
        return cmd_mp3(target)
    return cmd_all(args.out)


if __name__ == "__main__":
    raise SystemExit(main())
