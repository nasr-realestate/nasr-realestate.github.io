"""Read-only doctor tests. Synthetic paths only; no key material, no network.

Run: python3 -m unittest discover -s scripts/antix-wa-sync/tests -v
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DOCTOR = Path(__file__).resolve().parents[1] / "doctor.py"
SECRET = "SUPER-SECRET-TOKEN-VALUE"


def run_doctor(home: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(DOCTOR), "--home", str(home), *extra],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)


def write_config(home: Path, backup: Path, key: Path, **overrides) -> Path:
    config = {"backup_path": str(backup), "key_path": str(key), "rclone_remote": "nasr-wa:",
              "state_dir": str(home / "state"), "rclone_bin": str(home / "bin" / "rclone"),
              "rclone_config": str(home / "rclone.conf")}
    config.update(overrides)
    path = home / "config.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)
    return path


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / "nasr-wa-sync"
        self.home.mkdir(mode=0o700)
        (self.home / "state").mkdir(mode=0o700)
        self.backup = self.home / "msgstore.db.crypt15"
        self.backup.write_bytes(b"synthetic-backup-bytes")
        self.key = self.home / "encrypted_backup.key"
        self.key.write_bytes(b"\x00" * 32)
        self.key.chmod(0o600)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_config_is_warning_unless_required(self):
        result = run_doctor(self.home)
        self.assertIn("WARN", result.stdout)
        self.assertIn("الإعدادات غير منشأة بعد", result.stdout)
        strict = run_doctor(self.home, "--require-config")
        self.assertEqual(strict.returncode, 1, strict.stdout + strict.stderr)
        self.assertIn("DOCTOR_FAIL", strict.stdout)

    def test_crypt14_and_incremental_are_failures(self):
        old = self.home / "msgstore.db.crypt14"
        old.write_bytes(b"synthetic")
        write_config(self.home, old, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertEqual(result.returncode, 1)
        self.assertIn("crypt15", result.stdout)
        inc = self.home / "msgstore-increment-2-2026-11-11.1.db.crypt15"
        inc.write_bytes(b"synthetic")
        write_config(self.home, inc, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Incremental", result.stdout)

    def test_key_permissions_and_never_reading_key(self):
        self.key.chmod(0o644)
        write_config(self.home, self.backup, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertEqual(result.returncode, 1)
        self.assertIn("600", result.stdout)
        self.key.chmod(0o600)
        result = run_doctor(self.home, "--require-config")
        self.assertIn("لم يُقرأ محتواه", result.stdout)

    def test_state_inside_repo_is_failure(self):
        repo_state = DOCTOR.parents[2] / "scripts" / "antix-wa-sync"
        write_config(self.home, self.backup, self.key, state_dir=str(repo_state))
        result = run_doctor(self.home, "--require-config")
        self.assertEqual(result.returncode, 1)
        self.assertIn("داخل مستودع Git", result.stdout)

    def fake_rclone(self, section: dict) -> None:
        """A stand-in rclone whose config dump contains a secret; no network."""
        bin_dir = self.home / "bin"
        bin_dir.mkdir(mode=0o700, exist_ok=True)
        fake = bin_dir / "rclone"
        dump = json.dumps({"nasr-wa": section})
        fake.write_text(
            "#!/bin/sh\n"
            'for a in "$@"; do\n'
            '  case "$a" in\n'
            '    version) echo "rclone v1.76.0"; exit 0 ;;\n'
            '    listremotes) echo "nasr-wa:"; exit 0 ;;\n'
            "    dump) cat <<'JSON'\n" + dump + "\nJSON\nexit 0 ;;\n"
            "  esac\n"
            "done\n"
            "exit 0\n", encoding="utf-8")
        fake.chmod(0o700)
        (self.home / "rclone.conf").write_text("[nasr-wa]\ntype = drive\n", encoding="utf-8")

    def test_remote_checks_never_print_secrets(self):
        section = {"type": "drive", "scope": "drive", "root_folder_id": "FOLDER123",
                   "client_id": "cid", "client_secret": SECRET,
                   "token": json.dumps({"refresh_token": SECRET})}
        self.fake_rclone(section)
        write_config(self.home, self.backup, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertIn("رمز OAuth موجود", result.stdout)
        self.assertIn("root_folder_id مضبوط", result.stdout)

    def test_missing_root_folder_id_is_failure(self):
        # Without it, uploads would land in the Drive root instead of the CRM folder.
        self.fake_rclone({"type": "drive", "scope": "drive", "client_id": "cid",
                          "client_secret": SECRET, "token": json.dumps({"refresh_token": SECRET})})
        write_config(self.home, self.backup, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertEqual(result.returncode, 1)
        self.assertIn("root_folder_id فارغ", result.stdout)
        self.assertNotIn(SECRET, result.stdout + result.stderr)

    def test_distro_rclone_is_a_warning_not_a_pass(self):
        # Debian 12 ships rclone 1.60.1-DEV; the reviewed build is pinned to 1.76.0.
        self.fake_rclone({"type": "drive", "scope": "drive", "root_folder_id": "FOLDER123",
                          "client_id": "cid", "client_secret": SECRET,
                          "token": json.dumps({"refresh_token": SECRET})})
        fake = self.home / "bin" / "rclone"
        fake.write_text(fake.read_text(encoding="utf-8").replace("rclone v1.76.0", "rclone v1.60.1-DEV"),
                        encoding="utf-8")
        write_config(self.home, self.backup, self.key)
        result = run_doctor(self.home, "--require-config")
        self.assertIn("ليس النسخة المراجعة", result.stdout)
        self.assertIn("install_rclone.py", result.stdout)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        # Only the deliberately absent venv fails in this synthetic home.
        self.assertNotIn("FAIL  rclone", result.stdout)
        self.assertIn("DOCTOR_FAIL failures=1", result.stdout)

    def test_setup_installs_pinned_rclone_even_when_system_rclone_exists(self):
        setup = (DOCTOR.parent / "setup.sh").read_text(encoding="utf-8")
        self.assertNotIn("if ! command -v rclone", setup)
        self.assertIn('if [ ! -x "$HOME_DIR/bin/rclone" ]; then', setup)
        installer = (DOCTOR.parent / "install_rclone.py").read_text(encoding="utf-8")
        self.assertIn('"version"', installer)
        self.assertIn("target.unlink(missing_ok=True)", installer)

    def test_arabic_plan_shell_blocks_parse(self):
        """Every ```sh block in the Arabic plan must be valid POSIX shell."""
        plan = (DOCTOR.parent / "EXECUTION_PLAN_AR.md").read_text(encoding="utf-8")
        blocks, current = [], None
        for line in plan.splitlines():
            if line.startswith("```sh"):
                current = []
            elif line.startswith("```") and current is not None:
                blocks.append("\n".join(current) + "\n")
                current = None
            elif current is not None:
                current.append(line)
        self.assertIsNone(current, "unterminated shell block in the plan")
        self.assertGreaterEqual(len(blocks), 10)
        for index, block in enumerate(blocks, 1):
            result = subprocess.run(["sh", "-n"], input=block, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertEqual(result.returncode, 0, f"block {index}: {result.stderr}")

    def test_setup_deps_only_is_documented_and_skips_configure(self):
        setup = (DOCTOR.parent / "setup.sh").read_text(encoding="utf-8")
        self.assertIn("--deps-only", setup)
        guard = setup.index('if [ "$DEPS_ONLY" = 1 ]')
        self.assertLess(guard, setup.index("configure.py"))
        self.assertIn("exit 0", setup[guard:setup.index("configure.py")])
        syntax = subprocess.run(["sh", "-n", str(DOCTOR.parent / "setup.sh")],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)


if __name__ == "__main__":
    unittest.main()
