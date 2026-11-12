#!/usr/bin/env python3
"""Install a hash-pinned rclone binary into the private sync home (no root)."""
from __future__ import annotations

import argparse
import hashlib
import platform
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "v1.76.0"
# GitHub release asset digests for rclone v1.76.0.
ASSETS = {
    "386": ("rclone-v1.76.0-linux-386.zip", "ac5a696aff30c2806475d7c9ae6bbb4eeda47067e5add32448bf33db54552a09"),
    "amd64": ("rclone-v1.76.0-linux-amd64.zip", "b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7"),
}


def arch_asset() -> tuple[str, str]:
    machine = platform.machine().lower()
    if machine in {"i386", "i486", "i586", "i686", "x86"}:
        return ASSETS["386"]
    if machine in {"x86_64", "amd64"}:
        return ASSETS["amd64"]
    raise SystemExit(f"معمارية غير مدعومة لـ rclone المثبت: {machine}")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--home", type=Path, required=True)
    a = p.parse_args()
    home = a.home.expanduser().resolve()
    bin_dir = home / "bin"
    bin_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    target = bin_dir / "rclone"
    if target.exists():
        print(f"rclone موجود بالفعل: {target}")
        return 0
    name, digest = arch_asset()
    url = f"https://github.com/rclone/rclone/releases/download/{VERSION}/{name}"
    with tempfile.TemporaryDirectory(prefix="nasr-rclone-") as tmp:
        archive = Path(tmp) / name
        print(f"تنزيل rclone {VERSION} ({name}) والتحقق من البصمة…")
        with urllib.request.urlopen(url, timeout=120) as resp, archive.open("wb") as out:
            shutil.copyfileobj(resp, out)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != digest:
            raise SystemExit("بصمة rclone لا تطابق القيمة المثبتة؛ لم يُثبت شيء")
        with zipfile.ZipFile(archive) as z:
            members = [m for m in z.infolist() if Path(m.filename).name == "rclone" and not m.is_dir()]
            if len(members) != 1:
                raise SystemExit("أرشيف rclone لا يحتوي برنامجًا واحدًا")
            with z.open(members[0]) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
    target.chmod(0o700)
    print(f"تم التثبيت محليًا: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
