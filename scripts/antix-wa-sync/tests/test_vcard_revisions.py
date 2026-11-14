import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('vcard_revisions', Path(__file__).resolve().parents[1] / 'audit_vcard_revisions.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Revisions(unittest.TestCase):
    def test_coverage_and_invalid_values(self):
        text = ('BEGIN:VCARD\nFN:private\nREV:20261112T120000Z\nEND:VCARD\n'
                'BEGIN:VCARD\nFN:private\nEND:VCARD\n'
                'BEGIN:VCARD\nREV:20260230T120000Z\nEND:VCARD\n'
                'BEGIN:VCARD\nREV:20261112T120000Z\nREV:20261113T120000Z\nEND:VCARD\n')
        self.assertEqual(mod.audit(text), {'cards': 4, 'utc_revision': 1, 'missing_revision': 1, 'ambiguous_or_invalid_revision': 2})
        self.assertNotIn('private', str(mod.audit(text)))

    def test_folded_revision_and_bad_structure(self):
        self.assertEqual(mod.audit('BEGIN:VCARD\r\nREV:20261112T\r\n 120000Z\r\nEND:VCARD\r\n')['utc_revision'], 1)
        for text in ('', 'BEGIN:VCARD\n', 'END:VCARD', 'BEGIN:VCARD\nBEGIN:VCARD'):
            with self.assertRaises(ValueError):
                mod.audit(text)


if __name__ == '__main__':
    unittest.main()
