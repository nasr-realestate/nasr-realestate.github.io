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
import quopri
import re
import sys
from pathlib import Path

# المجموعة → ملف الصورة. كل اسم غير مذكور هنا يأخذ default.
#
# ⚠️ عيب مُصلَح (2026-11-18): «الأسماء الطبيعية» (175) و«جهات أخرى» (1,578)
# كانتا تأخذان `default.jpg` — أي أن 1,753 شخصًا حقيقيًا كانوا سيظهرون
# بالصورة الرمادية الرسمية بدل صورهم. أي مجموعة **ليست** من الأربع أدناه
# يجب أن تبقى بلا صورة مطلقًا، لا أن تأخذ صورة بديلة.
LABEL_FOR = {
    "ذكى منير": "zaki-mounir",
    "حارس": "hares",
    "الدولاب": "eldoulab",
    "قاعدة العملاء - النظام": "client-base",
}
DEFAULT = "default"
KEYS = ["zaki-mounir", "hares", "eldoulab", "client-base", DEFAULT]
LINE_WIDTH = 72


def _join(value: str, nxt: str) -> str:
    """يدمج سطر تكملة بقيمته الأصلية.

    حالتان في هذا الدفتر:
      - soft-break: السطر ينتهي بـ `=` ⇒ يُحذف `=` ويُلصق التالي مباشرة.
      - طيّ عادي: السطر التالي يبدأ بمسافة ⇒ تُحذف المسافة ويُلصق.
    الخلط بينهما يُبقي بايتات مُقتبَسة في آخر القيمة فلا تُطابق اسم مجموعة.
    """
    if value.endswith("="):
        # soft-break: "=" في نهاية السطر علامة استمرار تُحذف، والتالي يُلصق.
        return value[:-1] + nxt.lstrip()
    return value + nxt.lstrip()


def _decode(line: str) -> str:
    """يفكّ QUOTED-PRINTABLE (وكذلك soft-break "=" في نهاية السطر).

    سبب الحاجة: ORG في هذا الدفتر مكتوب
    `ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=A7...` — قراءته كما هي
    تعطي بايتات مُقتبَسة لا اسمًا عربيًا، فتفشل كل مطابقة مجموعة.
    """
    if ":" not in line:
        return ""
    val = line.split(":", 1)[1]
    if "QUOTED-PRINTABLE" in line.upper():
        val = re.sub(r"=\r?\n", "", val)
        try:
            return quopri.decodestring(val.encode("latin-1", "replace")).decode(
                "utf-8", "replace"
            )
        except Exception:  # pragma: no cover - ترميز شاذ
            return val
    return val


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
    ap.add_argument(
        "--org-prefix",
        default="",
        help=(
            "بادئة تُضاف إلى اسم المجموعة في ORG وTITLE، مثل 'مؤسسة '. "
            "الغرض: البحث باسم المؤسسة في Google Contacts يجد كل بطاقات "
            "المجموعة مجتمعة تحت اسم واحد."
        ),
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
    stats: dict[str, int] = {}

    def emit(card: list[str]) -> None:
        """يعالج كارتًا كاملًا: يقرأ مجموعته ثم يقرّر صورته.

        ⚠️ عيبان مُصلَحان (2026-11-18):
        1. الحلقة القديمة كانت ترمي `PHOTO` لحظة رؤيته وتعتمد على `group`
           المقروء من `ORG` **قبله** — و`ORG` في هذا الدفتر يأتي بعده.
        2. `ORG` نفسه مقسوم على سطرين بـ soft-break (`=` في نهاية السطر)،
           فقراءته سطرًا واحدًا تعطي «الدفتر الشامل — ذكى من» فقط ⇒ لا
           تطابق أي مجموعة. لا بد من دمج أسطر التكملة أولًا.
        """
        # ندمج كل حقل بأسطر تكملته
        fields: list[tuple[str, str]] = []
        for line in card:
            if line.startswith(" ") and fields:
                name, value = fields[-1]
                fields[-1] = (name, _join(value, line))
            elif ":" in line:
                name = line.split(":", 1)[0].upper()
                fields.append((name, line.split(":", 1)[1]))
            elif line.startswith("=") and fields:
                name, value = fields[-1]
                fields[-1] = (name, _join(value, line))

        candidates = []
        for name, value in fields:
            if name.startswith("ORG") or name.startswith("TITLE"):
                candidates.append(_clean(value))
            elif name.startswith("NOTE") and "المجموعة:" in _clean(value):
                candidates.append(
                    _clean(value).split("المجموعة:", 1)[1].split("\n")[0].strip()
                )
        # احتياط أخير: عشرات البطاقات تكتب المجموعة في الاسم نفسه
        # («حارس | ام يوسف») مع ORG وTITLE فارغين. بلا هذا السطر تبقى بلا
        # صورة فتفقد المجموعة توحّدها البصري.
        if not any(candidates):
            for name, value in fields:
                if name.startswith("FN"):
                    head = _clean(value).split("|")[0].strip()
                    if head in LABEL_FOR:
                        candidates.append(head)
                        break
        group = next((c for c in candidates if c), "")
        _write(card, group, stats)

    def _label(group: str) -> str:
        """اسم المجموعة كما يُكتب في ORG/TITLE — مع بادئة المؤسسة إن طُلبت."""
        if not group or not args.org_prefix:
            return group
        prefix = args.org_prefix
        return group if group.startswith(prefix.strip()) else prefix + group

    def _clean(value: str) -> str:
        """يفكّ QUOTED-PRINTABLE وينزع بادئة الدفتر."""
        if "=" in value or "%" in value:
            try:
                value = quopri.decodestring(value.encode("latin-1", "replace")).decode(
                    "utf-8", "replace"
                )
            except Exception:  # pragma: no cover
                pass
        for prefix in ("الدفتر الشامل — ", "الدفتر الشامل - "):
            if value.startswith(prefix):
                value = value[len(prefix):]
        return value.replace("\r", "").strip()

    def _group_of(line: str) -> str:
        val = _decode(line).replace("الدفتر الشامل — ", "").replace(
            "الدفتر الشامل - ", ""
        ).strip()
        return val.split("\n")[0].strip()

    def _write(card: list[str], group: str, stats: dict[str, int]) -> None:
        out_card: list[str] = []
        in_photo = False
        for line in card:
            if in_photo:
                if line.startswith(" "):
                    continue          # سطر تكملة تابع لصورة قديمة — يُسقَط
                in_photo = False
            if line.upper().startswith("PHOTO"):
                in_photo = True
                if args.no_photos:
                    stats["بدون صور"] = stats.get("بدون صور", 0) + 1
                    continue
                if args.default_no_photo:
                    # الوضع المعتمد: المجموعات الأربع تحمل صورتها الملوّنة.
                    #
                    # ⚠️ عيب مُصلَح (2026-11-18): النسخة السابقة كانت **تحذف**
                    # صورة أي مجموعة خارج الأربع. في هذا الدفتر يعني ذلك محو
                    # 175 صورة شخص حقيقي في «الأسماء الطبيعية» و42 في «جهات
                    # أخرى» — طمسٌ لصور الناس لا «توحيد». الصحيح: نترك الصورة
                    # الأصلية كما هي، ولا نكتب default.jpg فوقها.
                    if group not in LABEL_FOR:
                        stats["صور محفوظة كما هي"] = (
                            stats.get("صور محفوظة كما هي", 0) + 1
                        )
                        out_card.append(line)   # الصورة الأصلية — لا تُمسّ
                        continue
                    stats[LABEL_FOR[group]] = stats.get(LABEL_FOR[group], 0) + 1
                    out_card.append(
                        "PHOTO;ENCODING=b;TYPE=JPEG:" + fold(b64[LABEL_FOR[group]])
                    )
                    continue
                key = LABEL_FOR.get(group, DEFAULT)
                stats[key] = stats.get(key, 0) + 1
                out_card.append("PHOTO;ENCODING=b;TYPE=JPEG:" + fold(b64[key]))
                continue
            if args.org_prefix and group in LABEL_FOR:
                head = line.split(":", 1)[0].upper()
                if head.startswith("ORG") or head.startswith("TITLE"):
                    sep = line.find(":")
                    if sep != -1:
                        value = line[sep + 1:]
                        label = _label(group)
                        if "QUOTED-PRINTABLE" in head:
                            encoded = "".join(
                                f"={b:02X}" if (b < 32 or b > 126 or b in (61, 63, 95))
                                else chr(b)
                                for b in label.encode("utf-8")
                            )
                            out_card.append(line[:sep + 1] + encoded)
                            continue
                        out_card.append(line[:sep + 1] + label)
                        continue
            out_card.append(line)

        # ⚠️ عيب مُصلَح (2026-11-18): 33 بطاقة في «حارس» تحمل ORG صحيحًا
        # لكن **بلا سطر PHOTO إطلاقًا** (لم تُسجَّل لها صورة قط). الحلقة
        # السابقة كانت تُضيف صورة المجموعة فقط عند مصادفة PHOTO موجود،
        # فبقيت هذه البطاقات بلا صورة رغم انتمائها للمجموعة. نُضيف الصورة
        # هنا إن كانت المجموعة من الأربع ولم تُكتب لها صورة بعد. N
        # TITLE فارغ في عشرات البطاقات ⇒ نكتبه ليكتمل اسم المؤسسة في البحث
        # (Google Contacts يعرض ORG وTITLE معًا في البطاقة والبحث).
        if args.org_prefix and group in LABEL_FOR:
            label = _label(group)
            has_title = any(
                ln.upper().split(":", 1)[0].startswith("TITLE") for ln in out_card
            )
            if not has_title:
                encoded = "".join(
                    f"={b:02X}" if (b < 32 or b > 126 or b in (61, 63, 95))
                    else chr(b)
                    for b in label.encode("utf-8")
                )
                out_card.insert(
                    len(out_card) - 1
                    if out_card and out_card[-1] == "END:VCARD"
                    else len(out_card),
                    "TITLE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:" + encoded,
                )

        wants = (
            args.default_no_photo
            and not args.no_photos
            and group in LABEL_FOR
        )
        if wants and not any(l.upper().startswith("PHOTO") for l in out_card):
            stats[LABEL_FOR[group]] = stats.get(LABEL_FOR[group], 0) + 1
            # قبل END:VCARD — الترتيب لا يهم في vCard لكن النظافة تفيد
            out_card.insert(
                len(out_card) - 1 if out_card and out_card[-1] == "END:VCARD" else len(out_card),
                "PHOTO;ENCODING=b;TYPE=JPEG:" + fold(b64[LABEL_FOR[group]]),
            )
        out.extend(out_card)

    for raw in open(args.src, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\r\n")
        if line == "BEGIN:VCARD":
            cur = [line]
            continue
        if line == "END:VCARD":
            cur.append(line)
            emit(cur)
            cur = []
            continue
        if cur:
            cur.append(line)

    Path(args.out).write_text("\r\n".join(out) + "\r\n", encoding="utf-8", newline="")
    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"{args.out}: {sum(stats.values())} صورة معالَجة ({size_mb:.2f} ميجا)")
    for key in KEYS + ["صور محفوظة كما هي", "بدون صور"]:
        if key in stats:
            print(f"   {key}: {stats[key]}")
    if size_mb > 20:
        sys.exit("تحذير: الملف أكبر من 20 ميجا — جوجل سيرفضه.")


if __name__ == "__main__":
    main()
