#!/usr/bin/env python3
"""Text-only adapter around the pinned whatsapp-chat-exporter Android reader.

It deliberately does not run the upstream CLI's media/vCard/call exporters: those
write attachments and assume optional tables that some Business backups lack.
The CRM intake is text-only, so this adapter reads messages and writes one JSON.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
from pathlib import Path
import sqlite3
import sys

EXPECTED_EXPORTER = "0.13.1"


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Read an Android WhatsApp msgstore.db as text-only JSON")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--wa", type=Path, default=None)
    args = parser.parse_args()
    try:
        version = importlib.metadata.version("whatsapp-chat-exporter")
        if version != EXPECTED_EXPORTER:
            return fail(f"نسخة whatsapp-chat-exporter غير المدعومة: {version}")
        from Whatsapp_Chat_Exporter import android_handler
        from Whatsapp_Chat_Exporter.data_model import ChatCollection, Timing
        from Whatsapp_Chat_Exporter.utility import check_jid_map, get_transcription_selection
    except ImportError:
        return fail("أدوات فك التشفير/الاستخراج غير مثبتة؛ شغّل setup.sh أولًا")

    logging.disable(logging.CRITICAL)
    data = ChatCollection()
    try:
        uri = args.db.resolve().as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as db:
            db.row_factory = sqlite3.Row
            db.text_factory = lambda b: b.decode("utf-8", errors="replace")
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            modern_cols = {r[1] for r in db.execute("PRAGMA table_info(message)")} if "message" in tables else set()
            use_modern = {"text_data", "from_me", "chat_row_id"} <= modern_cols
            data.set_system("jid_map_exists", check_jid_map(db))
            data.set_system("transcription_selection", get_transcription_selection(db))
            cursor = db.cursor()
            # Prefer the modern `message` table when it exists. Some Business DBs keep
            # an empty legacy `messages` stub; trying legacy first can read the wrong one.
            if use_modern:
                content_cursor = android_handler._get_messages_cursor_new(
                    cursor, False, None, (None, None),
                    data.get_system("transcription_selection"), data.get_system("jid_map_exists"),
                )
            else:
                content_cursor = android_handler._get_messages_cursor_legacy(cursor, False, None, (None, None))
            # Bounded fetch: upstream _fetch_row_safely retries OperationalError forever.
            while True:
                row = cursor.fetchone()
                if row is None:
                    break
                android_handler._process_single_message(data, row, use_modern, Timing(0))
                # The upstream constructor derives from_me from sender_jid_row_id;
                # the backup's own from_me flag is the authoritative direction bit.
                chat = data.get_chat(row["key_remote_jid"]) if row["key_remote_jid"] is not None else None
                if chat is not None:
                    message = chat.get_message(row["_id"])
                    if message is not None:
                        message.from_me = bool(row["key_from_me"])

        # Enrich only chats that actually have messages; never export the whole phone book.
        if args.wa and args.wa.is_file():
            uri = args.wa.resolve().as_uri() + "?mode=ro"
            with sqlite3.connect(uri, uri=True) as contacts_db:
                contacts_db.row_factory = sqlite3.Row
                contacts_db.text_factory = lambda b: b.decode("utf-8", errors="replace")
                has_contacts = contacts_db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wa_contacts'"
                ).fetchone()
                if has_contacts:
                    names = {r["jid"]: r["display_name"] for r in contacts_db.execute(
                        "SELECT jid, COALESCE(display_name, wa_name) AS display_name FROM wa_contacts"
                    ) if r["display_name"]}
                    for jid, chat in data.items():
                        if not chat.name and jid in names:
                            chat.name = names[jid]
        args.out.write_text(json.dumps(data.to_dict(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return 0
    except sqlite3.Error:
        return fail("تعذّرت قراءة جداول رسائل WhatsApp Business؛ النسخة غير مدعومة أو تالفة")
    except (OSError, ValueError, TypeError, KeyError):
        return fail("تعذّر استخراج النص من قاعدة الرسائل")


if __name__ == "__main__":
    raise SystemExit(main())
