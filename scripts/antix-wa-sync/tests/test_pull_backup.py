"""Phone-copy tests with a stand-in adb. Synthetic bytes only; no device, no network.

The fake `adb shell` re-splits its arguments exactly like a real device shell, so a
remote path containing "WhatsApp Business" breaks unless the caller quotes it.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "pull_backup.sh"
REL = "Android/media/com.whatsapp.w4b/WhatsApp Business/Databases/msgstore.db.crypt15"


class PullBackupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.home = root / "home"
        self.home.mkdir()
        self.phone = root / "phone-root"
        (self.phone / Path(REL).parent).mkdir(parents=True)
        self.payload = b"synthetic-crypt15-payload" * 100
        (self.phone / REL).write_bytes(self.payload)
        self.bin = root / "bin"
        self.bin.mkdir()
        # toybox-style sha256sum that maps /sdcard/ onto the synthetic phone root.
        self.write_tool("sha256sum", '#!/bin/sh\n'
                        'case "$1" in\n'
                        '  /sdcard/*)\n'
                        '    f="$FAKE_PHONE_ROOT/${1#/sdcard/}"\n'
                        '    [ -f "$f" ] || { echo "sha256sum: $1: No such file or directory" >&2; exit 1; }\n'
                        "    exec python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],\"rb\").read()).hexdigest()+\"  \"+sys.argv[2])' \"$f\" \"$1\" ;;\n"
                        '  *) exec /usr/bin/sha256sum "$@" ;;\n'
                        'esac\n')
        self.fake_adb("device")

    def tearDown(self):
        self._tmp.cleanup()

    def write_tool(self, name, body):
        path = self.bin / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o700)
        return path

    def fake_adb(self, state, corrupt=False):
        pull = 'cp "$FAKE_PHONE_ROOT/${2#/sdcard/}" "$3"'
        if corrupt:
            pull = 'printf truncated > "$3"'
        self.write_tool("adb", '#!/bin/sh\n'
                        'case "$1" in\n'
                        '  start-server) exit 0 ;;\n'
                        f'  devices) printf "List of devices attached\\nTESTSERIAL\\t{state}\\n" ;;\n'
                        f'  pull) {pull} ;;\n'
                        '  shell) shift; exec sh -c "$*" ;;\n'
                        'esac\n'
                        'exit 0\n')

    def run_script(self, *args):
        env = {**os.environ, "HOME": str(self.home), "PATH": f"{self.bin}:{os.environ['PATH']}",
               "FAKE_PHONE_ROOT": str(self.phone), "NASR_WA_HOME": str(self.home / "nasr-wa-sync")}
        return subprocess.run(["sh", str(SCRIPT), *args], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def inbox_file(self):
        return self.home / "nasr-wa-sync" / "inbox" / "msgstore.db.crypt15"

    def test_adb_pull_handles_space_in_remote_path(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PULL_BACKUP_OK", result.stdout)
        self.assertIn("نُقل عبر: adb", result.stdout)
        landed = self.inbox_file()
        self.assertEqual(landed.read_bytes(), self.payload)
        self.assertEqual(landed.stat().st_mode & 0o777, 0o600)
        self.assertIn(hashlib.sha256(self.payload).hexdigest(), result.stdout)

    def test_hash_mismatch_removes_the_copy(self):
        self.fake_adb("device", corrupt=True)
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("COPY_MISMATCH", result.stdout)
        self.assertFalse(self.inbox_file().exists())

    def test_unauthorized_device_stops_without_a_file(self):
        self.fake_adb("unauthorized")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("NO_PHONE_FILE_FOUND", result.stdout)
        self.assertFalse(self.inbox_file().exists())

    def test_explicit_source_is_byte_compared(self):
        source = Path(self._tmp.name) / "flash" / "msgstore.db.crypt15"
        source.parent.mkdir()
        source.write_bytes(self.payload)
        result = self.run_script("--source", str(source))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.inbox_file().read_bytes(), self.payload)
        missing = self.run_script("--source", str(source) + ".absent")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("SOURCE_NOT_FOUND", missing.stdout)

    def test_unknown_option_is_rejected(self):
        result = self.run_script("--delete-everything")
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown option", result.stderr)


if __name__ == "__main__":
    unittest.main()
