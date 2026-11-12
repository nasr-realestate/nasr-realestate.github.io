#!/usr/bin/env python3
"""Interactive local configuration; the backup key is read without echo."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--home", type=Path, required=True)
p.add_argument("--venv", type=Path, required=True)
a = p.parse_args()
home = a.home.expanduser().resolve()
home.mkdir(mode=0o700, parents=True, exist_ok=True)
config_path = home / "config.json"
if config_path.exists():
    raise SystemExit("الإعدادات موجودة بالفعل؛ لم تُستبدل. عدّلها يدويًا عند الحاجة.")
backup = input("مسار msgstore.db.crypt15 المنسوخ من WhatsApp Business: ").strip()
remote = input("اسم rclone remote الخاص (ينتهي بنقطتين، مثل nasr-wa:): ").strip()
if not re.fullmatch(r"[A-Za-z0-9_-]+:", remote):
    raise SystemExit("اسم remote غير صالح؛ استخدم أحرفًا/أرقامًا/شرطة وينتهي بنقطتين مثل nasr-wa:")
key_path = home / "encrypted_backup.key"
if not key_path.exists():
    key = getpass.getpass("مفتاح واتساب الـ64 خانة hex (لن يظهر ولن يُحفظ في السجل): ").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise SystemExit("المفتاح ليس 64 خانة سداسية عشرية؛ لم يُحفظ شيء")
    # Pass through stdin to a short local Python program, never argv/shell history.
    code = "import sys; from pathlib import Path; from wa_crypt_tools.lib.key.key15 import Key15; Key15(keyarray=bytes.fromhex(sys.stdin.readline().strip())).file_dump(Path(sys.argv[1]))"
    subprocess.run([str(a.venv / "bin/python"), "-c", code, str(key_path)], input=key + "\n", text=True, check=True)
    del key
key_path.chmod(0o600)
local_rclone = home / "bin" / "rclone"
config = {"backup_path": str(Path(backup).expanduser()), "key_path": str(key_path),
          "rclone_remote": remote, "state_dir": str(home / "state"),
          "wadecrypt_bin": str(a.venv / "bin/wadecrypt"),
          "python_bin": str(a.venv / "bin/python"),
          "rclone_bin": str(local_rclone) if local_rclone.exists() else "rclone",
          "rclone_config": str(Path("~/.config/rclone/rclone.conf").expanduser())}
fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(config, f, ensure_ascii=False, indent=2)
print("حُفظت الإعدادات خارج Git. المفتاح يبقى على جهازك فقط.")
