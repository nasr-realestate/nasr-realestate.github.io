#!/usr/bin/env python3
"""
يستبدل صور المجموعات في دفتر vCard بالصور الخمس المعتمدة، ويكتب ملفًا
بحجم يقبله Google Contacts (الحد الأقصى 20 ميجا).

سبب الحجم: كل كارت يحمل نسخة base64 من صورته. صورة 256×256 (26 كيلو)
كررت 1984 مرة ⇒ ملف 26 ميجا ⇒ رفضه جوجل. الحل: 144×144 بجودة 72
(≈4 كيلو) ⇒ الملف ≈ 11 ميجا، مع بقاء التمييز اللوني واضحًا.

الوضع الافتراضي (`--default-no-photo`):

    المجموعات الأربع المصبوغة (ذكى منير / حارس / الدولاب / قاعدة العملاء)
    تأخذ صورتها الملوّنة — يراها من بعيد فيعرف مصدر الاتصال.
    وكل ما عداها (الأسماء الطبيعية + جهات أخرى + أي اسم جديد) **بلا صورة**،
    فتظهر صورة الشخص الحقيقية كما وضعها هو.

أوضاع أخرى:
    `--no-photos`  : حذف كل الصور.
    بدون أي علامة  : صبغ كل الكروت (قديم، غير مستخدم).

Usage:
    .venv/bin/python tools/contact-labels/build-vcf.py \
        --src ./Diwan.vcf --labels ./tools/contact-labels/out \
        --default-no-photo --out ./Diwan.vcf
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
from pathlib import Path

# المجموعة → ملف الصورة. كل اسم غير مذكور هنا يأخذ default.
LABEL_FOR = {
    "ذكى منير": "zaki-mounir",
    "حارس": "hares",
    "الدولاب": "eldoulab",
    "قاعدة العملاء - النظام": "client-base",
}
DEFAULT = "default"
KEYS = ["zaki-mounir", "hares", "eldoulab", "client-base", DEFAULT]
LINE_WIDTH = 72


def fold(b64: str, width: int = LINE_WIDTH) -> str:
    return "\r\n ".join(b64[i:i + width] for i in range(0, len(b64), width))


def main() -> None:
    ap = argparse.ArgumentParser(description="استبدال صور مجموعات vCard")
    ap.add_argument("--src", required=True, help="ملف vCard الأصلي")
    ap.add_argument("--labels", default="./labels", help="مجلد صور المجموعات")
    ap.add_argument("--out", required=True, help="ملف الإخراج")
    ap.add_argument(
        "--default-no-photo",
        action="store_true",
        help="المجموعات الأربع الملوّنة فقط تأخذ صورة، والباقي بلا صورة",
    )
    ap.add_argument(
        "--no-photos",
        action="store_true",
        help="حذف الصور تمامًا بدل وضع صور المجموعات (تظهر صور الناس الحقيقية)",
    )
    args = ap.parse_args()

    if args.no_photos:
        b64 = {}
    else:
        labels = Path(args.labels)
        need = [k for k in KEYS if k != DEFAULT] if args.default_no_photo else KEYS
        missing = [k for k in need if not (labels / f"{k}.jpg").exists()]
        if missing:
            sys.exit(f"صور ناقصة في {labels}: {missing}")
        b64 = {k: base64.b64encode((labels / f"{k}.jpg").read_bytes()).decode() for k in need}

    out: list[str] = []
    cur: list[str] = []
    group: str | None = None
    in_photo = False
    stats: dict[str, int] = {}

    for raw in open(args.src, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\r\n")
        if line == "BEGIN:VCARD":
            cur, group, in_photo = [line], None, False
            continue
        if in_photo:
            if line.startswith(" "):
                continue          # سطر تكملة تابع لصورة قديمة — يُسقَط
            in_photo = False
        if line.startswith("ORG:"):
            group = line[4:].replace("الدفتر الشامل — ", "").strip()
            cur.append(line)
            continue
        if line.startswith("PHOTO"):
            in_photo = True
            if args.no_photos:
                stats["بدون صور"] = stats.get("بدون صور", 0) + 1
                continue
            named = group in LABEL_FOR
            if args.default_no_photo and not named:
                stats["بدون صور"] = stats.get("بدون صور", 0) + 1
                continue          # يُحذف الكارت بلا صورة — تظهر صورته الحقيقية
            key = LABEL_FOR.get(group, DEFAULT)
            stats[key] = stats.get(key, 0) + 1
            cur.append("PHOTO;ENCODING=b;TYPE=JPEG:" + fold(b64[key]))
            continue
        if line == "END:VCARD":
            cur.append(line)
            out.extend(cur)
            cur = []
            continue
        cur.append(line)

    Path(args.out).write_text("\r\n".join(out) + "\r\n", encoding="utf-8", newline="")
    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"{args.out}: {sum(stats.values())} صورة معالَجة ({size_mb:.2f} ميجا)")
    for key in KEYS + ["بدون صور"]:
        if key in stats:
            print(f"   {key}: {stats[key]}")
    if size_mb > 20:
        sys.exit("تحذير: الملف أكبر من 20 ميجا — جوجل سيرفضه.")


if __name__ == "__main__":
    main()
