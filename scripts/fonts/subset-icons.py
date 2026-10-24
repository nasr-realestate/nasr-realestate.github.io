#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
═══════════════════════════════════════════════════════════════════════
 scripts/fonts/subset-icons.py — توليد أيقونات Font Awesome مقتطعة
───────────────────────────────────────────────────────────────────────
 لماذا:
   كان الموقع يحمّل من cdnjs ثلاثة أصول لكل صفحة:
     all.min.css (~100 ك.ب) + fa-solid-900.woff2 (153 ك.ب) + fa-brands-400.woff2 (115 ك.ب)
   أي ≈368 ك.ب لكل زائر، وأغلبها أيقونات لا يستخدمها الموقع إطلاقًا (1950 أيقونة،
   نستخدم 171) — وهي أكبر بند منفرد في وزن الصفحة على الجوال.

 ما يفعله:
   1) يمسح المستودع ويجمع كل أصناف `fa-*` المستخدمة فعليًا (HTML + Liquid + Markdown + JS).
   2) يقرأ خريطة الصنف → نقطة الترميز من حزمة Font Awesome الرسمية.
   3) يقتطع خطَّي solid/brands إلى الرموز المستخدمة فقط (pyftsubset).
   4) يكتب assets/fonts/fa-solid-subset.woff2 و fa-brands-subset.woff2
      و assets/css/fa-subset.css (قواعد الأساس + أصناف الأيقونات المستخدمة فقط).

 المتطلبات:
   pip install fonttools brotli
   npm install            # لتوفّر node_modules/@fortawesome/fontawesome-free
                          # (موجود في devDependencies — أداة بناء فقط، لا وقت تشغيل)

 التشغيل:
   python3 scripts/fonts/subset-icons.py

 ⚠️ الملفات الناتجة مُتتبَّعة في Git (لا تُبنى في CI). أي أيقونة جديدة تُستخدم في
    الصفحات بلا إعادة تشغيل هذا السكربت تُسقط اختبار
    scripts/tests/icons-subset.test.mjs برسالة تشرح الخطوة المطلوبة.
═══════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FA_DIR = ROOT / "node_modules" / "@fortawesome" / "fontawesome-free"
OUT_FONTS = ROOT / "assets" / "fonts"
OUT_CSS = ROOT / "assets" / "css" / "fa-subset.css"

SCAN_GLOBS = (
    "*.html",
    "_layouts/*.html",
    "_includes/*.html",
    "_properties/*.md",
    "_requests/*.md",
    "properties/*.html",
    "properties/page/*.html",
    "assets/js/*.js",
)

# أصناف مساعدة (ليست أيقونات) — تُنسخ قواعدها كما هي
UTILITY_CLASSES = (
    "fa-spin", "fa-pulse", "fa-fw", "fa-border", "fa-ul", "fa-li",
    "fa-stack", "fa-stack-1x", "fa-stack-2x", "fa-inverse",
    "fa-rotate-90", "fa-rotate-180", "fa-rotate-270", "fa-flip-horizontal", "fa-flip-vertical",
)

BASE_RULES = """\
.fa,.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands{
  -moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;
  display:var(--fa-display,inline-block);font-style:normal;font-variant:normal;
  line-height:1;text-rendering:auto;}
.fas,.fa-solid{font-family:'Font Awesome 6 Free';font-weight:900;}
.fab,.fa-brands{font-family:'Font Awesome 6 Brands';font-weight:400;}
.far,.fa-regular{font-family:'Font Awesome 6 Free';font-weight:400;}
.fa-spin{animation:fa-spin 2s infinite linear;}
.fa-pulse{animation:fa-spin 1s infinite steps(8);}
@keyframes fa-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
.fa-fw{text-align:center;width:1.25em;}
.fa-li{position:absolute;left:-2em;width:2em;line-height:inherit;text-align:center;}
.fa-ul{list-style-type:none;margin-left:2.5em;padding-left:0;}
.fa-ul>li{position:relative;}
.fa-border{border:.08em solid #eee;border-radius:.1em;padding:.2em .25em .15em;}
.fa-inverse{color:var(--fa-inverse,#fff);}
.fa-stack{display:inline-block;height:2em;line-height:2em;position:relative;vertical-align:middle;width:2.5em;}
.fa-stack-1x,.fa-stack-2x{left:0;position:absolute;text-align:center;width:100%;}
.fa-stack-1x{line-height:inherit;}
.fa-stack-2x{font-size:2em;}
.fa-rotate-90{transform:rotate(90deg);}
.fa-rotate-180{transform:rotate(180deg);}
.fa-rotate-270{transform:rotate(270deg);}
.fa-flip-horizontal{transform:scaleX(-1);}
.fa-flip-vertical{transform:scaleY(-1);}
.fa-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0;}
@media (prefers-reduced-motion:reduce){.fa-spin,.fa-pulse{animation:none;}}
"""


def fail(msg: str) -> None:
    print(f"✖ {msg}", file=sys.stderr)
    raise SystemExit(1)


def used_classes() -> dict[str, set[str]]:
    """كل صنف fa-* مستخدم في المستودع → ملفات ظهوره (للتشخيص)."""
    found: dict[str, set[str]] = {}
    seen_files: list[Path] = []
    for pattern in SCAN_GLOBS:
        seen_files.extend(sorted(ROOT.glob(pattern)))
    for path in seen_files:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for match in re.finditer(r'class="([^"]*)"', text):
            for token in match.group(1).split():
                if re.fullmatch(r"fa-[a-z0-9-]+", token):
                    found.setdefault(token, set()).add(str(path.relative_to(ROOT)))
        # أصناف داخل قوالب نصية في JavaScript: `fas fa-xxx`
        for match in re.finditer(r"\bfa-[a-z0-9-]+", text):
            token = match.group(0)
            found.setdefault(token, set()).add(str(path.relative_to(ROOT)))
    return found


def parse_fa_css() -> tuple[dict[str, int], dict[str, int]]:
    """(أصناف solid → كودبوينت، أصناف brands → كودبوينت) من all.css الرسمي."""
    css_path = FA_DIR / "css" / "all.css"
    if not css_path.is_file():
        fail(f"لم أجد {css_path} — نفّذ `npm install` أولًا.")
    lines = css_path.read_text(encoding="utf-8").split("\n")
    brands_start = next(
        (i for i, line in enumerate(lines) if "--fa-style-family-brands" in line),
        None,
    )
    if brands_start is None:
        fail("تعذّر تحديد بداية قسم brand في all.css — تغيّر تنسيق الحزمة؟")

    families: tuple[dict[str, int], dict[str, int]] = ({}, {})
    pattern = re.compile(r"^\.fa-([a-z0-9-]+)(?:::before|::before|:before)\s*\{\s*$")
    for index, line in enumerate(lines):
        match = pattern.match(line.strip())
        if not match:
            continue
        # السطر التالي يحمل content: "\e123";
        content = None
        for probe in lines[index + 1: index + 3]:
            cmatch = re.search(r'content:\s*"\\([0-9a-fA-F]+)"', probe)
            if cmatch:
                content = int(cmatch.group(1), 16)
                break
        if content is None:
            continue
        target = families[1] if index > brands_start else families[0]
        target.setdefault(match.group(1), content)
    return families


def run_pyftsubset(src: Path, dst: Path, codepoints: list[int]) -> None:
    unicodes = ",".join(f"U+{cp:04X}" for cp in sorted(set(codepoints)))
    exe = Path(sys.executable).parent / "pyftsubset"
    cmd = [
        str(exe) if exe.is_file() else "pyftsubset",
        str(src),
        f"--unicodes={unicodes}",
        f"--output-file={dst}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--drop-tables+=DSIG",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"فشل اقتطاع {src.name}: {result.stderr.strip()[:400]}")


def main() -> None:
    solid_map, brands_map = parse_fa_css()
    found = used_classes()

    # المفاتيح في found تحمل البادئة (fa-house) وخريطة Font Awesome بلا بادئة (house)
    def stem(cls: str) -> str:
        return cls[3:] if cls.startswith("fa-") else cls

    solid_used = sorted(c for c in found if stem(c) in solid_map)
    brands_used = sorted(c for c in found if stem(c) in brands_map)
    utilities_used = sorted(c for c in found if c in UTILITY_CLASSES)
    unknown = sorted(
        c for c in found
        if stem(c) not in solid_map and stem(c) not in brands_map and c not in UTILITY_CLASSES
    )

    print(f"ℹ️  أصناف fa-* المستخدمة: {len(found)} — solid {len(solid_used)} · brands {len(brands_used)} · أدوات {len(utilities_used)}")
    if unknown:
        print(f"⚠️  أصناف غير معروفة في Font Awesome 6.5.1 (تُتجاهل): {', '.join(unknown)}")

    if not solid_used and not brands_used:
        fail("لم أجد أي أيقونة مستخدمة — تحقّق من مسارات المسح.")

    OUT_FONTS.mkdir(parents=True, exist_ok=True)

    # ⚠️ نُبقي المقاييس الأصلية (.notdef + مسافة) حتى لا تتغيّر أحجام الأيقونات
    solid_src = FA_DIR / "webfonts" / "fa-solid-900.woff2"
    brands_src = FA_DIR / "webfonts" / "fa-brands-400.woff2"
    solid_out = OUT_FONTS / "fa-solid-subset.woff2"
    brands_out = OUT_FONTS / "fa-brands-subset.woff2"

    run_pyftsubset(solid_src, solid_out, [solid_map[stem(c)] for c in solid_used])
    run_pyftsubset(brands_src, brands_out, [brands_map[stem(c)] for c in brands_used])

    css_parts = [
        "/* ═══════════════════════════════════════════════════════════════",
        "   fa-subset.css — ملف مُولَّد. لا تُعدّله يدويًا.",
        "   المولّد: python3 scripts/fonts/subset-icons.py",
        f"   الأيقونات: solid {len(solid_used)} · brands {len(brands_used)} من 1950",
        "   ═══════════════════════════════════════════════════════════════ */",
        "@font-face{font-family:'Font Awesome 6 Free';font-style:normal;font-weight:900;",
        "  font-display:swap;src:url('../fonts/fa-solid-subset.woff2') format('woff2');}",
        "@font-face{font-family:'Font Awesome 6 Brands';font-style:normal;font-weight:400;",
        "  font-display:swap;src:url('../fonts/fa-brands-subset.woff2') format('woff2');}",
        BASE_RULES,
    ]
    for name in solid_used:
        css_parts.append(f'.{name}::before{{content:"\\{solid_map[stem(name)]:x}";}}')
    for name in brands_used:
        css_parts.append(f'.{name}::before{{content:"\\{brands_map[stem(name)]:x}";}}')

    OUT_CSS.parent.mkdir(parents=True, exist_ok=True)
    OUT_CSS.write_text("\n".join(css_parts) + "\n", encoding="utf-8")

    solid_kb = solid_out.stat().st_size / 1024
    brands_kb = brands_out.stat().st_size / 1024
    css_kb = OUT_CSS.stat().st_size / 1024
    print(f"✔ fa-solid-subset.woff2  {solid_kb:6.1f} ك.ب  (الأصل 153.0)")
    print(f"✔ fa-brands-subset.woff2 {brands_kb:6.1f} ك.ب  (الأصل 115.0)")
    print(f"✔ fa-subset.css          {css_kb:6.1f} ك.ب  (بدل all.min.css ≈100)")
    print(f"  الإجمالي بعد: {solid_kb + brands_kb + css_kb:.1f} ك.ب · قبل: ≈368 ك.ب")


if __name__ == "__main__":
    main()
