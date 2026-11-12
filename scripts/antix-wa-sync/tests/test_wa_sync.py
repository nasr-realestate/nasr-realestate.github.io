"""Stdlib-only tests for the antiX WhatsApp Business intake orchestrator.

All names/messages are synthetic. No customer data, no network, no real Drive.
Run: python3 -m unittest discover -s scripts/antix-wa-sync/tests -v
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wa_sync  # noqa: E402


def synthetic_chat(n=4, title="عميل اصطناعي"):
    msgs = {}
    base = 1763000000
    for i in range(n):
        msgs[str(i + 1)] = {
            "timestamp": (base + i * 60) * 1000,
            "from_me": i % 2 == 1,
            "key_id": f"KEY{i}",
            "message_type": 0 if i < 3 else 3,
            "data": f"رسالة اصطناعية {i}" if i < 3 else None,
            "meta": False,
        }
    return {title and "synthetic@s.whatsapp.net": {"name": title, "messages": msgs}}


def minimal_db(path: Path):
    with sqlite3.connect(path) as c:
        c.executescript("""
        CREATE TABLE jid(_id INTEGER PRIMARY KEY, raw_string TEXT, type INTEGER);
        CREATE TABLE chat(_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT);
        CREATE TABLE message(_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER,
                             timestamp INTEGER, text_data TEXT, status INTEGER, message_type INTEGER);
        INSERT INTO jid VALUES(1,'synthetic@s.whatsapp.net',0);
        INSERT INTO chat VALUES(1,1,NULL);
        INSERT INTO message VALUES(1,1,0,1763000000000,'نص اصطناعي',0,0);
        """)


class RenderPlanTests(unittest.TestCase):
    def test_render_android_cairo_and_broker(self):
        exported = synthetic_chat()
        jid, chat = next(iter(exported.items()))
        title, text, fp = wa_sync.render_chat(jid, chat)
        self.assertEqual(title, "عميل اصطناعي")
        self.assertIn(" - عميل اصطناعي: رسالة اصطناعية 0", text)
        self.assertIn(f" - {wa_sync.BROKER}: رسالة اصطناعية 1", text)
        self.assertIn("[صوت]", text)
        self.assertEqual(len(fp), 4)
        # 1763000000 = 2025-11-13 02:13:20 UTC -> Cairo 04:13 (winter +2)
        self.assertTrue(text.startswith("13/11/2025, 04:13"))

    def test_plan_lifecycle(self):
        state = wa_sync.empty_state()
        exported = synthetic_chat()
        items, counts = wa_sync.plan_chats(exported, state)
        self.assertEqual(counts["new"], 1)
        item = items[0]
        # Simulate verified upload commit.
        with tempfile.TemporaryDirectory() as td:
            sd = Path(td)
            item["filename"] = "WA-SYNC__x__y.zip"
            wa_sync.commit_state(sd, items, True)
            state = wa_sync.load_json(sd / "state.json", None)
            items2, counts2 = wa_sync.plan_chats(exported, state)
            self.assertEqual(counts2["unchanged"], 1)
            # Append one message -> changed, same uid.
            grown = synthetic_chat(5)
            items3, counts3 = wa_sync.plan_chats(grown, state)
            self.assertEqual(counts3["changed"], 1)
            self.assertEqual(items3[0]["uid"], item["uid"])
            # Edit first message -> hold_history_changed.
            edited = synthetic_chat(5)
            edited["synthetic@s.whatsapp.net"]["messages"]["1"]["data"] = "معدّل"
            _, counts4 = wa_sync.plan_chats(edited, state)
            self.assertEqual(counts4["hold_history_changed"], 1)
            # Empty backup of known chat -> hold_empty_backup.
            empty = {"synthetic@s.whatsapp.net": {"name": "عميل اصطناعي", "messages": {}}}
            _, counts5 = wa_sync.plan_chats(empty, state)
            self.assertEqual(counts5["hold_empty_backup"], 1)
            # Missing chat is counted, never deleted from state.
            _, counts6 = wa_sync.plan_chats({}, state)
            self.assertEqual(counts6["missing_from_backup"], 1)
            self.assertIn(wa_sync.sha(b"synthetic@s.whatsapp.net"), state["chats"])

    def test_retry_upload_before_verified(self):
        state = wa_sync.empty_state()
        items, _ = wa_sync.plan_chats(synthetic_chat(), state)
        with tempfile.TemporaryDirectory() as td:
            wa_sync.commit_state(Path(td), items, False)
            state = wa_sync.load_json(Path(td) / "state.json", None)
            _, counts = wa_sync.plan_chats(synthetic_chat(), state)
            self.assertEqual(counts["retry_upload"], 1)

    def test_identity_collision_holds(self):
        state = wa_sync.empty_state()
        exported = {
            "a@s.whatsapp.net": {"name": "نفس الاسم", "messages": synthetic_chat()["synthetic@s.whatsapp.net"]["messages"]},
            "b@s.whatsapp.net": {"name": "نفس الاسم", "messages": synthetic_chat()["synthetic@s.whatsapp.net"]["messages"]},
        }
        _, counts = wa_sync.plan_chats(exported, state)
        self.assertEqual(counts.get("hold_identity_collision"), 1)
        self.assertEqual(counts.get("new"), 1)

    def test_rename_keeps_uid(self):
        state = wa_sync.empty_state()
        items, _ = wa_sync.plan_chats(synthetic_chat(), state)
        with tempfile.TemporaryDirectory() as td:
            items[0]["filename"] = "WA-SYNC__x__y.zip"
            wa_sync.commit_state(Path(td), items, True)
            state = wa_sync.load_json(Path(td) / "state.json", None)
            renamed = {"synthetic@s.whatsapp.net": {"name": "اسم جديد", "messages": synthetic_chat()["synthetic@s.whatsapp.net"]["messages"]}}
            renamed_items, _ = wa_sync.plan_chats(renamed, state)
            self.assertEqual(renamed_items[0]["uid"], items[0]["uid"])

    def test_state_validation_rejects_corruption(self):
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.validate_state({"schema": "other", "chats": {}})
        bad = wa_sync.empty_state()
        bad["chats"]["x"] = {}
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.validate_state(bad)


class PrepareTests(unittest.TestCase):
    def test_prepare_with_fake_tools_and_zip_contract(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            home = root / "home"; home.mkdir(mode=0o700)
            state_dir = home / "state"; state_dir.mkdir(mode=0o700)
            backup = home / "msgstore.db.crypt15"; backup.write_bytes(b"encrypted-synthetic")
            key = home / "encrypted_backup.key"; key.write_bytes(b"k" * 59); key.chmod(0o600)
            db_src = home / "plain.db"; minimal_db(db_src)
            config = {"backup_path": str(backup), "key_path": str(key), "rclone_remote": "test:"}

            def fake_run(argv, cwd, timeout=1800):
                if "wadecrypt" in argv[0] or argv[0].endswith("wadecrypt"):
                    Path(argv[3]).write_bytes(db_src.read_bytes())
                elif argv[1].endswith("export_android.py"):
                    out = Path(argv[argv.index("--out") + 1])
                    out.write_text(json.dumps(synthetic_chat(), ensure_ascii=False), encoding="utf-8")
                else:
                    raise AssertionError(argv)

            with mock.patch.object(wa_sync, "run_tool", side_effect=fake_run):
                chats, counts, outbox = wa_sync.prepare(config, state_dir)
            self.assertEqual(counts["new"], 1)
            zips = list(outbox.glob("WA-SYNC__*.zip"))
            self.assertEqual(len(zips), 1)
            import zipfile
            with zipfile.ZipFile(zips[0]) as z:
                self.assertEqual(set(z.namelist()), {"chat.txt", "crm-sync.json"})
                meta = json.loads(z.read("crm-sync.json"))
                text = z.read("chat.txt")
                self.assertEqual(meta["schema"], wa_sync.VERSION)
                self.assertEqual(meta["text_sha256"], hashlib.sha256(text).hexdigest())
                self.assertTrue(meta["conversation_uid"].startswith("wa:"))
            self.assertEqual(wa_sync.file_sha(backup), hashlib.sha256(b"encrypted-synthetic").hexdigest())
            self.assertFalse((state_dir / "state.json").exists(), "prepare alone must not commit state")

    def test_prepare_rejects_incremental_crypt14_and_bad_key_perms(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            backup = home / "msgstore-increment.db.crypt15"; backup.write_bytes(b"x")
            key = home / "key"; key.write_bytes(b"x"); key.chmod(0o600)
            with self.assertRaises(wa_sync.SyncError):
                wa_sync.prepare({"backup_path": str(backup), "key_path": str(key)}, home / "state")
            crypt14 = home / "msgstore.db.crypt14"; crypt14.write_bytes(b"x")
            with self.assertRaisesRegex(wa_sync.SyncError, "crypt15"):
                wa_sync.prepare({"backup_path": str(crypt14), "key_path": str(key)}, home / "state")
            backup2 = home / "msgstore.db.crypt15"; backup2.write_bytes(b"x")
            key.chmod(0o644)
            with self.assertRaises(wa_sync.SyncError):
                wa_sync.prepare({"backup_path": str(backup2), "key_path": str(key)}, home / "state")


FAKE_RCLONE = r'''#!/usr/bin/env python3
import hashlib, json, os, shutil, sys
from pathlib import Path
args = sys.argv[1:]
remote_root = Path(os.environ["FAKE_RCLONE_ROOT"])
remote_root.mkdir(parents=True, exist_ok=True)
if "copy" in args:
    i = args.index("copy"); src = Path(args[i+1])
    mode = os.environ.get("FAKE_MODE", "ok")
    for f in src.glob("WA-SYNC__*.zip"):
        dst = remote_root / f.name
        if dst.exists() and dst.read_bytes() != f.read_bytes():
            sys.exit(1)  # --immutable
        if mode == "corrupt":
            dst.write_bytes(b"corrupt")
        elif mode == "skip":
            pass
        else:
            shutil.copyfile(f, dst)
    sys.exit(0)
if "lsjson" in args:
    rows = []
    for f in sorted(remote_root.glob("WA-SYNC__*.zip")):
        rows.append({"Name": f.name, "Size": f.stat().st_size,
                     "Hashes": {"MD5": hashlib.md5(f.read_bytes()).hexdigest()}})
    if os.environ.get("FAKE_MODE") == "duplicate" and rows:
        rows.append(dict(rows[0]))
    print(json.dumps(rows)); sys.exit(0)
sys.exit(2)
'''


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.outbox = self.root / "outbox"; self.outbox.mkdir()
        self.remote = self.root / "remote"
        self.rclone = self.root / "rclone"; self.rclone.write_text(FAKE_RCLONE); self.rclone.chmod(0o700)
        self.item = {"ref": "a" * 64, "uid": "wa:test", "title": "عميل", "text": "نص\n",
                     "text_sha256": hashlib.sha256(b" text\n").hexdigest(), "status": "new",
                     "filename": "WA-SYNC__aaaaaaaaaaaaaaaa__bbbbbbbbbbbbbbbb.zip"}
        wa_sync.write_chat_zip(self.outbox / self.item["filename"], self.item)
        self.env = mock.patch.dict(os.environ, {"FAKE_RCLONE_ROOT": str(self.remote)})
        self.env.start()

    def tearDown(self):
        self.env.stop(); self.td.cleanup()

    def test_upload_verifies_md5_and_size(self):
        wa_sync.upload("test:", self.outbox, [self.item], str(self.rclone), self.root / "rclone.conf")
        self.assertTrue((self.remote / self.item["filename"]).exists())

    def test_upload_corrupt_fails(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": "corrupt"}):
            with self.assertRaises(wa_sync.SyncError):
                wa_sync.upload("test:", self.outbox, [self.item], str(self.rclone), self.root / "rclone.conf")

    def test_upload_missing_fails(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": "skip"}):
            with self.assertRaises(wa_sync.SyncError):
                wa_sync.upload("test:", self.outbox, [self.item], str(self.rclone), self.root / "rclone.conf")

    def test_upload_duplicate_name_fails(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": "duplicate"}):
            with self.assertRaises(wa_sync.SyncError):
                wa_sync.upload("test:", self.outbox, [self.item], str(self.rclone), self.root / "rclone.conf")

    def test_invalid_remote_rejected(self):
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.upload("--evil", self.outbox, [self.item], str(self.rclone))


if __name__ == "__main__":
    unittest.main()
