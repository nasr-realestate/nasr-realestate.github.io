#!/usr/bin/env python3
"""Local Android Business backup -> changed-chat ZIPs -> existing CRM Drive intake.

Stdlib only. Third-party decrypt/export programs run in a private temporary directory.
No WhatsApp connection, media upload, Drive deletion, or remote overwrite is performed.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from contacts import domain_of, normalize_number, number_of, parse_vcf

VERSION = "antix-wa-sync-v1"
BROKER = "طارق طنطاوي"
CAIRO = ZoneInfo("Africa/Cairo")
BIDI = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]")
UID_RE = re.compile(r"^wa:[^\s]{1,240}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
REMOTE_RE = re.compile(r"^[A-Za-z0-9_-]+:$")
PENDING_STATUSES = {"new", "changed", "retry_upload"}
MEDIA_PLACEHOLDERS = {
    1: "[صورة]", 2: "[فيديو]", 3: "[صوت]", 4: "[ملف]", 5: "[موقع]",
    8: "[مكالمة]", 9: "[مستند]", 13: "[صورة متحركة]", 20: "[ملصق]",
}


class SyncError(Exception):
    """A safe-to-display operational error (never includes chat content)."""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def clean(value) -> str:
    return BIDI.sub("", str(value or ""))


def title_key(value: str) -> str:
    """Mirror canonSyncKey in _worker/crm-sync-and-match.js."""
    value = clean(value)
    value = re.sub(r"^دردشة(?:\s+في)?\s+واتساب\s+مع\s*", "", value)
    value = re.sub(r"\.zip$", "", value, flags=re.I)
    value = re.sub(r"\.txt$", "", value, flags=re.I)
    return re.sub(r"[\s/_؟?:]+", "", value).lower()


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise SyncError(f"ملف حالة تالف؛ أوقف النقل ولا تحذف الحالة: {path.name}") from exc


def private_dir(path: Path) -> Path:
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise SyncError("مجلد البيانات الخاصة يسمح بوصول مستخدمين آخرين؛ أصلح الصلاحيات إلى 700")
    return path


def epoch_seconds(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SyncError("طابع زمني غير صالح في مخرجات المستخرج")
    number = float(value)
    if number > 99_999_999_999:
        number /= 1000
    if not 0 < number < 4_102_444_800:
        raise SyncError("طابع زمني خارج النطاق المدعوم")
    return number


def message_body(msg: dict) -> str:
    data = msg.get("data")
    if isinstance(data, str) and "The message is binary data and its base64 is" in data:
        return "[رسالة غير نصية]"
    text = clean(msg.get("caption") or data or "")
    text = re.sub(r"\s*<br\s*/?>\s*", "\n", text, flags=re.I)
    if not text.strip():
        kind = msg.get("message_type")
        text = MEDIA_PLACEHOLDERS.get(kind, "[رسالة غير نصية]" if msg.get("media") else "")
    if not text.strip() and msg.get("meta"):
        text = "[رسالة نظام]"
    return text.strip()


def render_chat(jid: str, chat: dict) -> tuple[str, str, list[dict]]:
    title = clean(chat.get("name") or jid.split("@")[0]).strip() or "محادثة واتساب"
    rows = []
    for db_id, msg in chat.get("messages", {}).items():
        body = message_body(msg)
        if not body:
            continue
        stamp = epoch_seconds(msg.get("timestamp"))
        if msg.get("from_me") is True:
            sender = BROKER
        elif msg.get("meta"):
            sender = ""
        else:
            sender = clean(msg.get("sender") or chat.get("name") or jid.split("@")[0]).strip()
        sender = sender.replace("\n", " ").replace("\r", " ")
        try:
            order = int(db_id)
        except (TypeError, ValueError):
            order = 0
        rows.append((stamp, order, str(msg.get("key_id") or db_id), sender, body))
    rows.sort(key=lambda row: (row[0], row[1], row[2]))
    lines, fingerprints = [], []
    for stamp, order, key, sender, body in rows:
        local = datetime.fromtimestamp(stamp, timezone.utc).astimezone(CAIRO)
        header = local.strftime("%d/%m/%Y, %H:%M")
        lines.append(f"{header} - {sender}: {body}" if sender else f"{header} - {body}")
        fingerprints.append({"key": key, "sha256": sha(json.dumps(
            [stamp, order, key, sender, body], ensure_ascii=False, separators=(",", ":")).encode())})
    return title, "\n".join(lines) + ("\n" if lines else ""), fingerprints


def read_export(path: Path) -> dict:
    data = load_json(path, None)
    if not isinstance(data, dict):
        raise SyncError("مخرجات المستخرج ليست قاموس محادثات")
    for jid, chat in data.items():
        if not isinstance(jid, str) or "@" not in jid or not isinstance(chat, dict):
            raise SyncError("شكل JSON غير مدعوم من المستخرج")
        if not isinstance(chat.get("messages", {}), dict):
            raise SyncError("قائمة رسائل غير صالحة في مخرجات المستخرج")
    return data


def empty_state() -> dict:
    return {"schema": VERSION, "chats": {}}


def validate_state(state: dict) -> dict:
    if not isinstance(state, dict) or state.get("schema") != VERSION or not isinstance(state.get("chats"), dict):
        raise SyncError("إصدار حالة المزامنة غير مدعوم")
    for ref, row in state["chats"].items():
        if not SHA_RE.fullmatch(ref) or not isinstance(row, dict):
            raise SyncError("صف حالة تالف؛ لا تحذف الحالة")
        if not isinstance(row.get("conversation_uid"), str) or not UID_RE.fullmatch(row["conversation_uid"]):
            raise SyncError("معرّف محادثة تالف في الحالة")
        if not isinstance(row.get("text_sha256"), str) or not SHA_RE.fullmatch(row["text_sha256"]):
            raise SyncError("بصمة حالة تالفة")
        if not isinstance(row.get("messages"), list):
            raise SyncError("سجل رسائل الحالة تالف")
    return state


def assign_uid(jid: str, title: str, state: dict) -> str:
    ref = sha(jid.encode())
    existing = state["chats"].get(ref)
    key = title_key(title)
    if existing:
        old_uid = existing["conversation_uid"]
        # Before the first verified upload an identity may still be corrected: a
        # number-only title gains the address-book name. After upload it is frozen,
        # because the CRM already knows that conversation under the old uid.
        if (not existing.get("uploaded") and key and len(key) <= 240
                and old_uid.startswith("wa:") and old_uid[3:].isdigit()):
            return f"wa:{key}"
        return old_uid
    if key and len(key) <= 240:
        return f"wa:{key}"
    return f"wa:antix:{ref}"


def plan_chats(exported: dict, state: dict, contacts: dict | None = None,
               only_contacts: bool = False, country_code: str = "20") -> tuple[list[dict], dict]:
    prepared, used_keys, used_uids = [], {}, {}
    for ref, row in state["chats"].items():
        used_uids[row["conversation_uid"]] = ref
        if row.get("title_key"):
            used_keys[row["title_key"]] = ref
    for jid, chat in sorted(exported.items()):
        ref = sha(jid.encode())
        domain = domain_of(jid)
        if contacts is not None:
            # Groups, channels, broadcasts and status are not CRM clients.
            if domain != "s.whatsapp.net":
                if only_contacts:
                    prepared.append({"ref": ref, "status": "skipped_non_direct"})
                    continue
            else:
                name = contacts.get(normalize_number(number_of(jid), country_code))
                if name:
                    chat = {**chat, "name": name}
                elif only_contacts:
                    prepared.append({"ref": ref, "status": "skipped_not_contact"})
                    continue
        title, text, messages = render_chat(jid, chat)
        uid = assign_uid(jid, title, state)
        key = title_key(title)
        if key and key in used_keys and used_keys[key] != ref:
            prepared.append({"ref": ref, "status": "hold_identity_collision"})
            continue
        if uid in used_uids and used_uids[uid] != ref:
            prepared.append({"ref": ref, "status": "hold_identity_collision"})
            continue
        if key:
            used_keys[key] = ref
        used_uids[uid] = ref
        text_sha = sha(text.encode())
        old = state["chats"].get(ref)
        status = "new"
        if old:
            if old["text_sha256"] == text_sha:
                status = "unchanged" if old.get("uploaded") else "retry_upload"
            elif not messages:
                status = "hold_empty_backup"
            elif len(messages) < len(old["messages"]) or old["messages"] != messages[:len(old["messages"])]:
                # Edits/deletes/order changes are real changes, but the current CRM
                # message_uid includes seq_no. Never pretend an append-only import
                # can reconcile them; keep the last verified version for review.
                status = "hold_history_changed"
            else:
                status = "changed"
        elif not messages:
            status = "empty"
        prepared.append({"ref": ref, "jid": jid, "uid": uid, "title": title, "title_key": key,
                         "text": text, "text_sha256": text_sha, "messages": messages, "status": status})
    counts = {}
    for item in prepared:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    seen_refs = {sha(j.encode()) for j in exported}
    counts["missing_from_backup"] = sum(1 for ref in state["chats"] if ref not in seen_refs)
    return prepared, counts


def write_chat_zip(path: Path, item: dict) -> None:
    import zipfile
    metadata = {"schema": VERSION, "conversation_uid": item["uid"],
                "chat_title": item["title"], "text_sha256": item["text_sha256"]}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in (("chat.txt", item["text"].encode()),
                           ("crm-sync.json", json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode())):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            z.writestr(info, data)


def run_tool(argv: list[str], cwd: Path, timeout: int = 1800) -> None:
    env = {**os.environ, "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION": "python", "PYTHONUTF8": "1"}
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise SyncError("انتهت مهلة أداة محلية؛ لم تُحدَّث حالة المزامنة") from exc
    if result.returncode:
        raise SyncError(f"فشلت أداة محلية ({Path(argv[0]).name}, exit={result.returncode})؛ راجع النسخة والمفتاح ومسار النسخة الاحتياطية")


def open_message_db(decrypted: Path, work: Path) -> Path:
    with decrypted.open("rb") as f:
        magic = f.read(16)
    if magic == b"SQLite format 3\x00":
        db = decrypted
    else:
        import zipfile
        if not zipfile.is_zipfile(decrypted):
            raise SyncError("فك التشفير لم ينتج SQLite ولا ZIP متعدد الملفات")
        with zipfile.ZipFile(decrypted) as z:
            candidates = [i for i in z.infolist() if Path(i.filename).name == "msgstore.db"
                          and not i.is_dir() and ".." not in Path(i.filename).parts]
            if len(candidates) != 1 or candidates[0].file_size > 2_000_000_000:
                raise SyncError("النسخة متعددة الملفات لا تحتوي msgstore.db واحدًا صالحًا؛ انسخ النسخة الكاملة لا Incremental")
            db = work / "msgstore.db"
            with z.open(candidates[0]) as src, db.open("wb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
    uri = db.resolve().as_uri() + "?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as conn:
        if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise SyncError("فحص سلامة SQLite فشل")
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not ({"message", "chat", "jid"} <= tables or {"messages", "jid"} <= tables):
            raise SyncError("الجداول المتوقعة لمخزن رسائل WhatsApp Business غير موجودة")
    return db


def prepare(config: dict, state_dir: Path) -> tuple[list[dict], dict, Path]:
    backup = Path(config["backup_path"]).expanduser().resolve()
    key = Path(config["key_path"]).expanduser().resolve()
    if not backup.is_file() or not key.is_file():
        raise SyncError("مسار النسخة الاحتياطية أو المفتاح غير موجود")
    if "increment" in backup.name.lower():
        raise SyncError("هذه نسخة Incremental وليست كاملة؛ انسخ msgstore.db.crypt15 بعد Back up")
    if backup.suffix.lower() != ".crypt15":
        raise SyncError("صيغة النسخة ليست crypt15؛ فعّل النسخ الاحتياطي المشفر طرفًا لطرف بمفتاح 64 خانة ثم انسخ msgstore.db.crypt15. لا تستخدم crypt14 أو increment")
    if key.stat().st_mode & 0o077:
        raise SyncError("ملف المفتاح يجب أن يكون بصلاحية 600")
    before = file_sha(backup)
    outbox = private_dir(state_dir / "outbox")
    # Only generated intake ZIPs are cleared; Drive originals are never touched.
    for old in outbox.glob("WA-SYNC__*.zip"):
        old.unlink()
    state = validate_state(load_json(state_dir / "state.json", empty_state()))
    with tempfile.TemporaryDirectory(prefix="nasr-wa-", dir=state_dir) as tmp:
        work = Path(tmp)
        decrypted = work / "decrypted.bin"
        run_tool([config.get("wadecrypt_bin", "wadecrypt"), str(key), str(backup), str(decrypted), "--no-mem"], work)
        db = open_message_db(decrypted, work)
        exported = work / "export.json"
        argv = [config.get("python_bin", sys.executable), str(Path(__file__).resolve().with_name("export_android.py")),
                "--db", str(db), "--out", str(exported)]
        if config.get("wa_db_path"):
            argv += ["--wa", str(Path(config["wa_db_path"]).expanduser().resolve())]
        run_tool(argv, work)
        contacts_map = None
        only_contacts = False
        country_code = str(config.get("country_code", "20"))
        if config.get("contacts_vcf"):
            vcf_path = Path(config["contacts_vcf"]).expanduser()
            if not vcf_path.is_file():
                raise SyncError("دفتر العناوين .vcf غير موجود؛ صدّره من الهاتف أو احذف contacts_vcf من الإعدادات")
            contacts_map, _ = parse_vcf(vcf_path, country_code)
            if not contacts_map:
                raise SyncError("دفتر العناوين لا يحتوي أسماءً وأرقامًا صالحة")
            only_contacts = bool(config.get("only_contacts", True))
        chats, counts = plan_chats(read_export(exported), state, contacts_map, only_contacts, country_code)
        if before != file_sha(backup):
            raise SyncError("النسخة الاحتياطية تغيّرت أثناء القراءة؛ أعد النسخ من الهاتف")
        for item in chats:
            if item["status"] in PENDING_STATUSES:
                item["filename"] = f"WA-SYNC__{item['ref'][:16]}__{item['text_sha256'][:16]}.zip"
                write_chat_zip(outbox / item["filename"], item)
    return chats, counts, outbox


def md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def upload(remote: str, outbox: Path, pending: list[dict], rclone: str, config_path: Path | None = None) -> None:
    if not pending:
        return
    if not REMOTE_RE.fullmatch(remote):
        raise SyncError("اسم rclone remote غير صالح")
    config_path = config_path or Path("~/.config/rclone/rclone.conf").expanduser()
    base = [rclone, "--config", str(config_path),
            "--contimeout", "30s", "--timeout", "5m", "--retries", "3", "--low-level-retries", "3"]
    run_tool(base + ["copy", str(outbox), remote, "--immutable", "--no-traverse", "--include", "WA-SYNC__*.zip"], outbox)
    try:
        result = subprocess.run(base + ["lsjson", remote, "--files-only", "--hash", "--include", "WA-SYNC__*.zip"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    except subprocess.TimeoutExpired as exc:
        raise SyncError("تم الرفع لكن مهلة التحقق انتهت؛ أعد الأمر ولن يستبدل الأصول") from exc
    if result.returncode:
        raise SyncError("تم الرفع لكن التحقق من القائمة فشل؛ أعد الأمر ولن يستبدل الأصول")
    try:
        rows = json.loads(result.stdout)
    except ValueError as exc:
        raise SyncError("قائمة التحقق من Drive غير صالحة") from exc
    listing = {}
    for row in rows:
        name = row.get("Name")
        if name in listing:
            raise SyncError("اسم مكرر في Drive؛ أوقف النقل للمراجعة")
        listing[name] = row
    for item in pending:
        row = listing.get(item["filename"])
        local = outbox / item["filename"]
        hashes = row.get("Hashes", {}) if row else {}
        if not row or row.get("Size") != local.stat().st_size or hashes.get("MD5", "").lower() != md5(local):
            raise SyncError("ملف مرفوع لم يجتز تحقق الحجم/البصمة؛ لا تُعدّل الأصل وأعد المحاولة")


def verify_manual_upload(manifest: Path, outbox: Path, pending: list[dict]) -> None:
    """Verify a browser upload against a Drive listing, without any network call.

    The manifest carries names, sizes and MD5 only (rclone `lsjson` shape or the
    simple {"files":[{"name","size","md5"}]} shape). Nothing is committed unless
    every pending ZIP matches a unique remote row byte-for-byte by size and MD5.
    """
    if not pending:
        return
    data = load_json(manifest, None)
    rows = data.get("files") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise SyncError("بيان الرفع اليدوي غير صالح؛ المتوقع قائمة ملفات Drive")
    listing = {}
    for row in rows:
        if not isinstance(row, dict):
            raise SyncError("صف غير صالح في بيان الرفع اليدوي")
        name = row.get("Name") or row.get("name")
        if not isinstance(name, str) or not name:
            raise SyncError("صف بلا اسم في بيان الرفع اليدوي")
        if name in listing:
            raise SyncError("اسم مكرر في بيان Drive؛ أوقف النقل للمراجعة")
        hashes = row.get("Hashes") if isinstance(row.get("Hashes"), dict) else {}
        digest = row.get("md5") or hashes.get("MD5") or ""
        listing[name] = (row.get("Size", row.get("size")), str(digest).lower())
    for item in pending:
        local = outbox / item["filename"]
        row = listing.get(item["filename"])
        if not row or row[0] != local.stat().st_size or row[1] != md5(local):
            raise SyncError(f"لم يُتحقق من هذا الملف في Drive: {item['filename']}؛ لم تُحدَّث الحالة")


def commit_state(state_dir: Path, chats: list[dict], uploaded: bool) -> None:
    state = validate_state(load_json(state_dir / "state.json", empty_state()))
    now = datetime.now(timezone.utc).isoformat()
    for item in chats:
        if "jid" not in item or item["status"].startswith("hold_"):
            continue
        old = state["chats"].get(item["ref"], {})
        row = {**old, "conversation_uid": item["uid"], "title_key": item.get("title_key", ""),
               "text_sha256": item["text_sha256"], "messages": item["messages"], "last_seen_at": now}
        if uploaded and item["status"] in PENDING_STATUSES:
            row.update(uploaded=True, uploaded_at=now, last_filename=item["filename"])
        state["chats"][item["ref"]] = row
    atomic_json(state_dir / "state.json", state)


def main() -> int:
    parser = argparse.ArgumentParser(description="نقل تحديثات WhatsApp Business إلى مسار CRM Drive الموجود")
    parser.add_argument("--config", type=Path, default=Path("~/nasr-wa-sync/config.json").expanduser())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="جهّز واعرض العدادات فقط، بلا رفع ولا تغيير الحالة")
    mode.add_argument("--prepare-only", action="store_true", help="جهّز الملفات الخاصة محليًا بلا رفع")
    mode.add_argument("--confirm-uploaded", type=Path, metavar="MANIFEST",
                      help="تحقّق من رفع يدوي عبر بيان Drive ثم اعتمد الحالة بلا رفع")
    args = parser.parse_args()
    try:
        config = load_json(args.config, None)
        if not isinstance(config, dict) or not {"backup_path", "key_path", "rclone_remote"} <= config.keys():
            raise SyncError("شغّل setup.sh أولًا لإنشاء الإعدادات خارج المستودع")
        state_dir = private_dir(Path(config.get("state_dir", "~/nasr-wa-sync/state")).expanduser().resolve())
        repo = Path(__file__).resolve().parents[2]
        if state_dir == repo or repo in state_dir.parents:
            raise SyncError("مجلد الحالة والمخرجات يجب أن يكون خارج مستودع Git العام")
        with (state_dir / "run.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            chats, counts, outbox = prepare(config, state_dir)
            pending = [x for x in chats if x["status"] in PENDING_STATUSES]
            manual = config.get("transport") == "manual"
            confirmed = args.confirm_uploaded is not None
            if manual and not (args.dry_run or args.prepare_only or confirmed):
                raise SyncError("وضع النقل اليدوي: شغّل --prepare-only ثم ارفع الملفات من المتصفح ثم --confirm-uploaded MANIFEST")
            do_upload = not (args.dry_run or args.prepare_only or confirmed)
            if do_upload:
                upload(config["rclone_remote"], outbox, pending, config.get("rclone_bin", "rclone"),
                       Path(config["rclone_config"]).expanduser() if config.get("rclone_config") else None)
            if confirmed:
                verify_manual_upload(args.confirm_uploaded, outbox, pending)
            settled = do_upload or confirmed
            if not args.dry_run:
                commit_state(state_dir, chats, settled)
            if settled or args.dry_run:
                for item in pending:
                    (outbox / item["filename"]).unlink(missing_ok=True)
            report = {"schema": VERSION, "at": datetime.now(timezone.utc).isoformat(),
                      "transport": "manual" if manual else "rclone",
                      "uploaded": len(pending) if settled else 0, "prepared": len(pending), "counts": counts}
            atomic_json(state_dir / "last-run.json", report)
            print(json.dumps(report, ensure_ascii=False, sort_keys=True))
            if any(k.startswith("hold_") for k in counts):
                return 3
            return 0
    except BlockingIOError:
        print("مزامنة أخرى تعمل بالفعل؛ لم يبدأ رفع ثانٍ.", file=sys.stderr)
        return 4
    except (SyncError, OSError, KeyError, ValueError) as exc:
        print(f"توقف آمن: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
