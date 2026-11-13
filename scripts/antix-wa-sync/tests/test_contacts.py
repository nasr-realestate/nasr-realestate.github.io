"""Address-book filtering: only known contacts become CRM conversations.

Synthetic names/numbers only. No real address book, no network.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contacts as vcf  # noqa: E402
import wa_sync  # noqa: E402

CARDS = """BEGIN:VCARD
VERSION:3.0
FN:عميل اصطناعي
TEL;TYPE=CELL:+20 100 000 0001
END:VCARD
BEGIN:VCARD
VERSION:2.1
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D9=85=D8=AD=D9=85=D8=AF
TEL;TYPE=CELL:01000000002
END:VCARD
BEGIN:VCARD
VERSION:3.0
item1.TEL;waid=201000000003:0020 100 000 0003
FN:عميل ثالث
item1.X-ABLabel:mobile
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:بلا رقم
END:VCARD
"""


def chat(number, name=None, domain="s.whatsapp.net"):
    return {f"{number}@{domain}": {"name": name, "messages": {
        "1": {"timestamp": 1763000000000, "from_me": False, "key_id": "K1",
              "message_type": 0, "data": "رسالة اصطناعية", "meta": False}}}}


class VcfTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "contacts.vcf"
        self.path.write_text(CARDS, encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def test_formats_and_encodings(self):
        mapping, stats = vcf.parse_vcf(self.path)
        self.assertEqual(mapping["201000000001"], "عميل اصطناعي")
        self.assertEqual(mapping["201000000002"], "محمد")
        self.assertEqual(mapping["201000000003"], "عميل ثالث")
        self.assertEqual(stats["cards"], 4)
        self.assertEqual(len(mapping), 3)

    def test_number_normalisation(self):
        for raw in ["+20 100 000 0001", "00201000000001", "01000000001", "201000000001"]:
            self.assertEqual(vcf.normalize_number(raw), "201000000001", raw)
        self.assertEqual(vcf.normalize_number("123"), "")
        self.assertEqual(vcf.normalize_number(""), "")
        self.assertEqual(vcf.normalize_number("0512345678", "966"), "966512345678")

    def test_jid_helpers(self):
        self.assertEqual(vcf.number_of("201000000001:12@s.whatsapp.net"), "201000000001")
        self.assertEqual(vcf.domain_of("12345@g.us"), "g.us")


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.contacts = {"201000000001": "عميل اصطناعي", "201000000002": "محمد"}

    def plan(self, exported, state=None, only_contacts=True):
        return wa_sync.plan_chats(exported, state or wa_sync.empty_state(), self.contacts, only_contacts)

    def test_only_known_direct_chats_survive(self):
        exported = {}
        exported.update(chat("201000000001"))
        exported.update(chat("201099999999"))            # not in the address book
        exported.update(chat("120363000000000000", "مجموعة", "g.us"))
        exported.update(chat("120363111111111111", "قناة", "newsletter"))
        exported.update(chat("status", None, "broadcast"))
        items, counts = self.plan(exported)
        self.assertEqual(counts["new"], 1)
        self.assertEqual(counts["skipped_not_contact"], 1)
        self.assertEqual(counts["skipped_non_direct"], 3)
        kept = [i for i in items if i["status"] == "new"]
        self.assertEqual(kept[0]["title"], "عميل اصطناعي")
        self.assertEqual(kept[0]["uid"], "wa:عميلاصطناعي")
        self.assertIn("عميل اصطناعي: رسالة اصطناعية", kept[0]["text"])

    def test_skipped_rows_carry_no_jid_so_state_ignores_them(self):
        items, _ = self.plan(chat("201099999999"))
        self.assertNotIn("jid", items[0])
        with tempfile.TemporaryDirectory() as td:
            wa_sync.commit_state(Path(td), items, True)
            state = json.loads((Path(td) / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["chats"], {})

    def test_without_filter_everything_is_kept_but_still_named(self):
        exported = {}
        exported.update(chat("201000000001"))
        exported.update(chat("201099999999"))
        _, counts = self.plan(exported, only_contacts=False)
        self.assertEqual(counts["new"], 2)
        self.assertNotIn("skipped_not_contact", counts)

    def test_numeric_identity_is_corrected_only_before_upload(self):
        exported = chat("201000000001")
        state = wa_sync.empty_state()
        # First pass without an address book: the uid is the bare number.
        items, _ = wa_sync.plan_chats(exported, state)
        with tempfile.TemporaryDirectory() as td:
            sd = Path(td)
            wa_sync.commit_state(sd, items, False)
            state = wa_sync.load_json(sd / "state.json", None)
            self.assertTrue(next(iter(state["chats"].values()))["conversation_uid"].startswith("wa:201"))
            named, _ = self.plan(exported, state)
            self.assertEqual(named[0]["uid"], "wa:عميلاصطناعي")
            # Once uploaded, the identity is frozen even if a name appears later.
            items[0]["filename"] = "WA-SYNC__x__y.zip"
            wa_sync.commit_state(sd, items, True)
            uploaded_state = wa_sync.load_json(sd / "state.json", None)
            frozen, _ = self.plan(exported, uploaded_state)
            self.assertTrue(frozen[0]["uid"].startswith("wa:201"))


class UseContactsScriptTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.state = self.home / "state"
        (self.state / "outbox").mkdir(parents=True)
        (self.state / "outbox" / "WA-SYNC__a__b.zip").write_bytes(b"local only")
        self.vcf = self.home / "contacts.vcf"
        self.vcf.write_text(CARDS, encoding="utf-8")
        self.config = self.home / "config.json"
        self.write_config()

    def write_config(self):
        self.config.write_text(json.dumps({"backup_path": "x", "key_path": "y", "rclone_remote": "nasr-wa:",
                                           "transport": "manual", "state_dir": str(self.state)}), encoding="utf-8")
        self.config.chmod(0o600)

    def tearDown(self):
        self._tmp.cleanup()

    def run_script(self, *extra):
        import subprocess
        script = Path(__file__).resolve().parents[1] / "use_contacts.py"
        return subprocess.run([sys.executable, str(script), "--config", str(self.config),
                               "--vcf", str(self.vcf), *extra], text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def test_attaches_contacts_and_archives_unuploaded_state(self):
        state = wa_sync.empty_state()
        state["chats"]["f" * 64] = {"conversation_uid": "wa:201000000001", "text_sha256": "a" * 64,
                                    "messages": []}
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        config = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertTrue(config["only_contacts"])
        self.assertEqual(config["contacts_vcf"], str(self.vcf))
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.state / "state.json").exists())
        self.assertEqual(len(list(self.state.glob("state.before-contacts-*.json"))), 1)
        self.assertEqual(len(list(self.home.glob("config.before-contacts-*.json"))), 1)
        self.assertEqual(list((self.state / "outbox").glob("*.zip")), [])
        self.assertNotIn("عميل اصطناعي", result.stdout)

    def test_uploaded_state_is_never_archived(self):
        state = wa_sync.empty_state()
        state["chats"]["f" * 64] = {"conversation_uid": "wa:201000000001", "text_sha256": "a" * 64,
                                    "messages": [], "uploaded": True}
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.state / "state.json").exists())
        self.assertIn("هوياتها مجمّدة", result.stdout)


if __name__ == "__main__":
    unittest.main()
