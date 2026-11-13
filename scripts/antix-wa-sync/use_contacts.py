#!/usr/bin/env python3
"""Attach an exported address book to the local config, safely and reversibly.

Only known contacts become CRM conversations. Nothing is uploaded here and no
address-book name is printed. If nothing has been uploaded yet, the pre-upload
state is archived (never deleted) so number-only identities can be re-derived
from real contact names.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

from contacts import parse_vcf


def write_private_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser(description="اربط دفتر العناوين بالإعدادات المحلية واقصر النقل على جهات الاتصال")
    parser.add_argument("--config", type=Path, default=Path("~/nasr-wa-sync/config.json").expanduser())
    parser.add_argument("--vcf", type=Path, required=True)
    parser.add_argument("--country-code", default=None)
    parser.add_argument("--all-chats", action="store_true", help="لا تقصر النقل على جهات الاتصال (غير مستحسن)")
    args = parser.parse_args()
    config_path = args.config.expanduser()
    vcf_path = args.vcf.expanduser().resolve()
    if not config_path.is_file():
        print("الإعدادات غير موجودة؛ شغّل setup.sh --manual أولًا")
        return 1
    if not vcf_path.is_file():
        print("ملف دفتر العناوين غير موجود")
        return 1
    config = json.loads(config_path.read_text(encoding="utf-8"))
    country = str(args.country_code or config.get("country_code", "20"))
    mapping, stats = parse_vcf(vcf_path, country)
    if not mapping:
        print("دفتر العناوين لا يحتوي أسماءً وأرقامًا صالحة؛ لم يتغيّر شيء")
        return 1
    print(f"جهات اتصال بأسماء وأرقام: {len(mapping)} (بطاقات: {stats['cards']}، أرقام مكررة: {stats['duplicate_numbers']})")

    backup = config_path.with_name(f"config.before-contacts-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json")
    shutil.copyfile(config_path, backup)
    backup.chmod(0o600)
    config.update(contacts_vcf=str(vcf_path), country_code=country, only_contacts=not args.all_chats)
    write_private_json(config_path, config)

    state_dir = Path(config.get("state_dir", "~/nasr-wa-sync/state")).expanduser()
    state_path = state_dir / "state.json"
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        rows = state.get("chats", {}) if isinstance(state, dict) else {}
        if any(row.get("uploaded") for row in rows.values()):
            print("توجد محادثات مرفوعة سابقًا؛ هوياتها مجمّدة ولم تُلمَس الحالة")
        else:
            archive = state_dir / f"state.before-contacts-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"
            shutil.move(str(state_path), str(archive))
            archive.chmod(0o600)
            print(f"لا رفع سابقًا: أُرشفت الحالة القديمة في {archive.name} لتُشتق الهويات من الأسماء")
    outbox = state_dir / "outbox"
    if outbox.is_dir():
        removed = 0
        for old in outbox.glob("WA-SYNC__*.zip"):
            old.unlink()
            removed += 1
        print(f"حُذفت ملفات محلية غير مرفوعة: {removed}")
    print("جاهز: sh scripts/antix-wa-sync/sync.sh --dry-run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
