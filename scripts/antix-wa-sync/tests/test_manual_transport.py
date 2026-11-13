"""Manual (browser) transport: verify-before-commit, with no rclone and no OAuth.

Synthetic data only. The manifest carries names/sizes/MD5 exactly like a Drive listing.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wa_sync  # noqa: E402
from test_wa_sync import minimal_db, synthetic_chat  # noqa: E402

HERE = Path(__file__).resolve().parents[1]


def manifest_for(paths):
    return {"files": [{"name": p.name, "size": p.stat().st_size,
                       "md5": hashlib.md5(p.read_bytes()).hexdigest()} for p in paths]}


class VerifyManualUploadTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.outbox = Path(self._tmp.name)
        self.zip = self.outbox / "WA-SYNC__abc__def.zip"
        self.zip.write_bytes(b"synthetic zip bytes")
        self.pending = [{"filename": self.zip.name}]
        self.manifest = self.outbox / "drive-manifest.json"

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, data):
        self.manifest.write_text(json.dumps(data), encoding="utf-8")
        return self.manifest

    def test_matching_manifest_passes(self):
        wa_sync.verify_manual_upload(self.write(manifest_for([self.zip])), self.outbox, self.pending)

    def test_rclone_lsjson_shape_is_accepted(self):
        rows = [{"Name": self.zip.name, "Size": self.zip.stat().st_size,
                 "Hashes": {"MD5": hashlib.md5(self.zip.read_bytes()).hexdigest().upper()}}]
        wa_sync.verify_manual_upload(self.write(rows), self.outbox, self.pending)

    def test_wrong_md5_or_size_is_rejected(self):
        data = manifest_for([self.zip])
        data["files"][0]["md5"] = "0" * 32
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.verify_manual_upload(self.write(data), self.outbox, self.pending)
        data = manifest_for([self.zip])
        data["files"][0]["size"] += 1
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.verify_manual_upload(self.write(data), self.outbox, self.pending)

    def test_missing_and_duplicate_rows_are_rejected(self):
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.verify_manual_upload(self.write({"files": []}), self.outbox, self.pending)
        data = manifest_for([self.zip, self.zip])
        with self.assertRaisesRegex(wa_sync.SyncError, "مكرر"):
            wa_sync.verify_manual_upload(self.write(data), self.outbox, self.pending)

    def test_no_pending_needs_no_manifest(self):
        wa_sync.verify_manual_upload(self.outbox / "absent.json", self.outbox, [])


class ManualFlowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.state = self.home / "state"
        self.state.mkdir(mode=0o700)
        backup = self.home / "msgstore.db.crypt15"
        backup.write_bytes(b"encrypted-synthetic")
        key = self.home / "encrypted_backup.key"
        key.write_bytes(b"k" * 59)
        key.chmod(0o600)
        self.db = self.home / "plain.db"
        minimal_db(self.db)
        self.config_path = self.home / "config.json"
        self.config = {"backup_path": str(backup), "key_path": str(key), "rclone_remote": "nasr-wa:",
                       "transport": "manual", "state_dir": str(self.state)}
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

        def fake_run(argv, cwd, timeout=1800):
            if argv[0].endswith("wadecrypt"):
                Path(argv[3]).write_bytes(self.db.read_bytes())
            elif argv[1].endswith("export_android.py"):
                Path(argv[argv.index("--out") + 1]).write_text(
                    json.dumps(synthetic_chat(), ensure_ascii=False), encoding="utf-8")
            else:
                raise AssertionError(argv)

        self.patcher = mock.patch.object(wa_sync, "run_tool", side_effect=fake_run)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, *args):
        argv = ["wa_sync.py", "--config", str(self.config_path), *args]
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stdout") as out:
            code = wa_sync.main()
        printed = "".join(call.args[0] for call in out.write.call_args_list)
        return code, printed

    def test_prepare_then_confirm_commits_only_after_verification(self):
        code, printed = self.run_main("--prepare-only")
        self.assertEqual(code, 0, printed)
        self.assertEqual(json.loads(printed)["uploaded"], 0)
        zips = list((self.state / "outbox").glob("WA-SYNC__*.zip"))
        self.assertEqual(len(zips), 1)
        state = json.loads((self.state / "state.json").read_text(encoding="utf-8"))
        self.assertFalse(next(iter(state["chats"].values())).get("uploaded", False))

        bad = self.home / "bad.json"
        bad.write_text(json.dumps({"files": []}), encoding="utf-8")
        code, _ = self.run_main("--confirm-uploaded", str(bad))
        self.assertEqual(code, 1, "an unverified upload must not settle the state")
        state = json.loads((self.state / "state.json").read_text(encoding="utf-8"))
        self.assertFalse(next(iter(state["chats"].values())).get("uploaded", False))

        good = self.home / "drive-manifest.json"
        good.write_text(json.dumps(manifest_for(zips)), encoding="utf-8")
        code, printed = self.run_main("--confirm-uploaded", str(good))
        self.assertEqual(code, 0, printed)
        report = json.loads(printed)
        self.assertEqual(report["uploaded"], 1)
        self.assertEqual(report["transport"], "manual")
        state = json.loads((self.state / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(next(iter(state["chats"].values()))["uploaded"])
        self.assertEqual(list((self.state / "outbox").glob("WA-SYNC__*.zip")), [])
        # A second run has nothing pending: no duplicate upload, no manifest needed.
        code, printed = self.run_main("--prepare-only")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(printed)["counts"].get("unchanged"), 1)

    def test_plain_sync_in_manual_mode_stops_with_guidance(self):
        with mock.patch.object(sys, "argv", ["wa_sync.py", "--config", str(self.config_path)]), \
                mock.patch("sys.stderr") as err:
            code = wa_sync.main()
        message = "".join(call.args[0] for call in err.write.call_args_list)
        self.assertEqual(code, 1)
        self.assertIn("--confirm-uploaded", message)


class ConfigureManualTests(unittest.TestCase):
    def test_manual_configure_writes_transport_and_never_asks_for_a_remote(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            home = root / "private"
            venv = root / "venv"
            (venv / "bin").mkdir(parents=True)
            stub = venv / "bin" / "python"
            stub.write_text('#!/bin/sh\nexec /usr/bin/python3 -c \'import sys;open(sys.argv[1],"wb").write(b"k"*59)\' "$3"\n',
                            encoding="utf-8")
            stub.chmod(0o700)
            backup = root / "msgstore.db.crypt15"
            backup.write_bytes(b"synthetic")
            answers = f"{backup}\n\n" + "a" * 64 + "\n"
            result = subprocess.run([sys.executable, str(HERE / "configure.py"), "--home", str(home),
                                     "--venv", str(venv), "--transport", "manual"],
                                    input=answers, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            config = json.loads((home / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(config["transport"], "manual")
            self.assertEqual(config["rclone_remote"], "nasr-wa:")
            self.assertEqual((home / "config.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((home / "encrypted_backup.key").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("a" * 64, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
