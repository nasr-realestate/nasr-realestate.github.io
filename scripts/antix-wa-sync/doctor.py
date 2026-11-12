#!/usr/bin/env python3
"""Read-only readiness report for the antiX WhatsApp -> CRM intake path.

It never decrypts a backup, never opens the key or chat files, never uploads, and
never prints a secret: rclone's config is parsed in memory and only the presence
of fields is reported. Safe to run before and after setup, and inside cron logs.

Exit codes: 0 = no failure (warnings allowed), 1 = at least one failure.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime

PINNED_RCLONE = "v1.76.0"
REMOTE_RE = re.compile(r"^[A-Za-z0-9_-]+:$")
MODULES = ("wa_crypt_tools", "Cryptodome", "Whatsapp_Chat_Exporter", "jinja2",
           "bleach", "google.protobuf", "javaobj")
REQUIRED_CONFIG = ("backup_path", "key_path", "rclone_remote")
PROBE = ("import importlib.util, json, sys; "
         "print(json.dumps({m: importlib.util.find_spec(m) is not None for m in sys.argv[1:]}))")


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str]] = []

    def add(self, status: str, message: str) -> None:
        self.rows.append((status, message))
        print(f"{status:4}  {message}")

    def ok(self, message: str) -> None:
        self.add("PASS", message)

    def warn(self, message: str) -> None:
        self.add("WARN", message)

    def fail(self, message: str) -> None:
        self.add("FAIL", message)

    @property
    def failures(self) -> int:
        return sum(1 for status, _ in self.rows if status == "FAIL")


def run(argv: list[str], timeout: int = 60) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None


def mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def check_env(rep: Report, home: Path) -> Path | None:
    if sys.version_info[:2] == (3, 11):
        rep.ok(f"Python {platform.python_version()} مطابق للحزم المثبتة")
    else:
        rep.fail(f"Python {platform.python_version()} غير مدعوم؛ المطلوب 3.11")
    machine = platform.machine().lower()
    if machine in {"i386", "i486", "i586", "i686", "x86", "x86_64", "amd64"}:
        rep.ok(f"المعمارية مدعومة: {machine}")
    else:
        rep.fail(f"المعمارية غير مدعومة: {machine}")
    if not home.is_dir():
        rep.fail(f"المجلد الخاص غير موجود: {home}؛ شغّل setup.sh")
        return None
    if mode(home) & 0o077:
        rep.fail(f"صلاحيات {home} يجب أن تكون 700")
    else:
        rep.ok(f"المجلد الخاص بصلاحية 700: {home}")
    vpy = home / "venv" / "bin" / "python"
    if not vpy.is_file():
        rep.fail("البيئة الافتراضية غير موجودة؛ شغّل setup.sh")
        return None
    result = run([str(vpy), "-c", PROBE, *MODULES])
    if result is None or result.returncode:
        rep.fail("تعذّر فحص حزم البيئة الافتراضية؛ أعد setup.sh")
    else:
        try:
            found = json.loads(result.stdout)
        except ValueError:
            found = {}
        missing = [name for name in MODULES if not found.get(name)]
        if missing:
            rep.fail("حزم ناقصة في البيئة الافتراضية: " + ", ".join(missing))
        else:
            rep.ok("كل الحزم المثبتة موجودة داخل البيئة الافتراضية")
    if (home / "venv" / "bin" / "wadecrypt").is_file():
        rep.ok("أداة فك التشفير wadecrypt موجودة")
    else:
        rep.fail("wadecrypt غير موجود؛ أعد setup.sh")
    return vpy


def check_rclone(rep: Report, home: Path, config: dict | None) -> tuple[str, Path] | None:
    configured = (config or {}).get("rclone_bin")
    local = home / "bin" / "rclone"
    candidate = None
    for value in (configured, str(local) if local.is_file() else None, shutil.which("rclone")):
        if value and Path(value).is_file():
            candidate = Path(value)
            break
    if candidate is None:
        rep.fail("rclone غير مثبت؛ شغّل setup.sh أو install_rclone.py")
        return None
    result = run([str(candidate), "version"], timeout=30)
    first = (result.stdout.splitlines() or [""])[0] if result and result.returncode == 0 else ""
    if first and PINNED_RCLONE in first:
        rep.ok(f"rclone بالنسخة المراجعة: {first}")
    elif first:
        rep.warn(f"rclone ليس النسخة المراجعة {PINNED_RCLONE}: {first} ({candidate})؛ "
                 "شغّل install_rclone.py --home '$HOME/nasr-wa-sync'")
    else:
        rep.warn(f"rclone موجود لكن تعذّر قراءة نسخته: {candidate}")
    raw = (config or {}).get("rclone_config") or "~/.config/rclone/rclone.conf"
    return str(candidate), Path(raw).expanduser()


def check_remote(rep: Report, rclone: str, config_path: Path, remote: str) -> None:
    if not REMOTE_RE.fullmatch(remote):
        rep.fail("اسم remote غير صالح؛ استخدم شكل nasr-wa:")
        return
    if not config_path.is_file():
        rep.fail(f"ملف إعدادات rclone غير موجود: {config_path}")
        return
    listing = run([rclone, "--config", str(config_path), "listremotes"], timeout=30)
    names = listing.stdout.split() if listing and listing.returncode == 0 else []
    if remote not in names:
        rep.fail(f"remote غير معرّف في rclone: {remote}")
        return
    rep.ok(f"remote معرّف: {remote}")
    # The dump holds secrets; parse it in memory and report presence only.
    dump = run([rclone, "--config", str(config_path), "config", "dump"], timeout=30)
    try:
        data = json.loads(dump.stdout) if dump and dump.returncode == 0 else {}
    except ValueError:
        data = {}
    section = data.get(remote.rstrip(":")) if isinstance(data, dict) else None
    if not isinstance(section, dict):
        rep.warn("تعذّر فحص تفاصيل remote؛ سيظهر أي نقص عند أول تشغيل")
        return
    token = section.get("token")
    if isinstance(token, str) and token.strip().startswith("{"):
        try:
            token = json.loads(token)
        except ValueError:
            token = {}
    if isinstance(token, dict) and (token.get("refresh_token") or token.get("access_token")):
        rep.ok("رمز OAuth موجود (لم يُعرض أي سر)")
    else:
        rep.warn("لم يُربط OAuth بعد؛ نفّذ rclone config reconnect ثم أعد الفحص")
    if str(section.get("root_folder_id", "")).strip():
        rep.ok("root_folder_id مضبوط؛ الرفع داخل مجلد CRM لا جذر Drive")
    else:
        rep.fail("root_folder_id فارغ؛ الرفع سيذهب إلى جذر Drive. اضبطه على معرّف مجلد CRM")
    scope = str(section.get("scope", ""))
    if scope in {"drive", "drive.file"}:
        rep.ok(f"نطاق Drive مناسب: {scope}")
    elif scope:
        rep.warn(f"نطاق Drive غير متوقع: {scope}")
    if not str(section.get("client_id", "")).strip() or not str(section.get("client_secret", "")).strip():
        rep.fail("client_id/client_secret خاصان بك غير مضبوطين؛ العميل المشترك لم يعد مدعومًا")


def check_paths(rep: Report, config: dict, repo: Path) -> None:
    backup = Path(str(config.get("backup_path", ""))).expanduser()
    key = Path(str(config.get("key_path", ""))).expanduser()
    state = Path(str(config.get("state_dir", ""))).expanduser()
    if not backup.is_file():
        rep.fail(f"النسخة الاحتياطية غير موجودة: {backup}")
    elif "increment" in backup.name.lower():
        rep.fail("النسخة Incremental جزئية؛ انسخ msgstore.db.crypt15 الكامل بعد Back up")
    elif backup.suffix.lower() != ".crypt15":
        rep.fail("صيغة النسخة ليست crypt15؛ فعّل النسخ المشفر طرفًا لطرف بمفتاح 64 خانة")
    elif backup.stat().st_size == 0:
        rep.fail("النسخة الاحتياطية فارغة؛ أعد النسخ من الهاتف")
    else:
        size_mb = backup.stat().st_size / (1024 * 1024)
        stamp = datetime.fromtimestamp(backup.stat().st_mtime).isoformat(timespec="minutes")
        rep.ok(f"نسخة كاملة بصيغة crypt15: {size_mb:.1f} ميجابايت، آخر تعديل {stamp}")
    if not key.is_file():
        rep.fail(f"ملف المفتاح غير موجود: {key}")
    elif mode(key) & 0o077:
        rep.fail("ملف المفتاح يجب أن يكون بصلاحية 600")
    elif key.stat().st_size == 0:
        rep.fail("ملف المفتاح فارغ")
    else:
        rep.ok("ملف المفتاح موجود بصلاحية 600 (لم يُقرأ محتواه)")
    if not str(state):
        rep.fail("state_dir غير مضبوط")
    else:
        resolved = state.resolve()
        if resolved == repo or repo in resolved.parents:
            rep.fail("مجلد الحالة داخل مستودع Git العام؛ انقله إلى المجلد الخاص")
        elif resolved.is_dir() and mode(resolved) & 0o077:
            rep.fail(f"صلاحيات مجلد الحالة يجب أن تكون 700: {resolved}")
        else:
            rep.ok(f"مجلد الحالة خارج المستودع: {resolved}")


def main() -> int:
    parser = argparse.ArgumentParser(description="فحص جاهزية محلي للقراءة فقط: بلا فك تشفير وبلا رفع")
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("NASR_WA_HOME", "~/nasr-wa-sync")).expanduser())
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--require-config", action="store_true", help="اعتبر غياب الإعدادات فشلًا لا تحذيرًا")
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    config_path = (args.config or home / "config.json").expanduser()
    repo = Path(__file__).resolve().parents[2]
    rep = Report()
    check_env(rep, home)
    config = None
    if not config_path.is_file():
        message = f"الإعدادات غير منشأة بعد: {config_path}"
        if args.require_config:
            rep.fail(message)
        else:
            rep.warn(message + "؛ تُنشأ في خطوة الإعداد بعد تجهيز النسخة والمفتاح")
    else:
        if mode(config_path) & 0o077:
            rep.fail(f"صلاحيات ملف الإعدادات يجب أن تكون 600: {config_path}")
        try:
            loaded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            loaded = None
            rep.fail("ملف الإعدادات غير صالح؛ لم يُعدّل")
        if isinstance(loaded, dict) and set(REQUIRED_CONFIG) <= loaded.keys():
            config = loaded
            rep.ok("ملف الإعدادات صالح")
            check_paths(rep, config, repo)
        elif isinstance(loaded, dict):
            rep.fail("ملف الإعدادات لا يحتوي المفاتيح المطلوبة؛ شغّل setup.sh")
    resolved = check_rclone(rep, home, config)
    if resolved and config:
        check_remote(rep, resolved[0], resolved[1], str(config.get("rclone_remote", "")))
    failures = rep.failures
    warnings = sum(1 for status, _ in rep.rows if status == "WARN")
    print(f"\n{'DOCTOR_FAIL' if failures else 'DOCTOR_OK'} failures={failures} warnings={warnings}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
