"""Private human exclusions only; no held identities can be approved by this path."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hold_decisions import make_template, review_each
from wa_sync import SyncError, apply_hold_exclusions


class HoldDecisionsTests(unittest.TestCase):
    def setUp(self):
        self.report = {'schema': 'antix-wa-holds-review-v1', 'backup_sha256': 'a' * 64,
                       'vcf_sha256': 'b' * 64, 'as_of': '2026-11-13T00:00:00+00:00',
                       'rows': [{'ref': '1' * 64, 'reason': 'hold_unknown_recent', 'jid': 'private', 'title': 'private'},
                                {'ref': '2' * 64, 'reason': 'hold_contact_ambiguous'}]}
        self.selection = {'vcf_sha256': 'b' * 64, 'as_of': self.report['as_of']}
        self.counts = {'hold_unknown_recent': 1, 'hold_contact_ambiguous': 1, 'selected_marked': 5}
        self.decisions = make_template(self.report)

    def apply(self, decisions):
        return apply_hold_exclusions(decisions, self.report['rows'], self.counts, 'a' * 64, self.selection)

    def test_template_is_pending_and_contains_no_private_names_or_jids(self):
        self.assertNotIn('private', str(self.decisions))
        self.assertEqual([r['action'] for r in self.decisions['rows']], ['pending', 'pending'])
        self.assertEqual(self.apply(self.decisions), self.counts)

    def test_explicit_exclusion_only_removes_hold_not_select(self):
        self.decisions['rows'][0]['action'] = 'exclude'
        counts = self.apply(self.decisions)
        self.assertEqual(counts['hold_unknown_recent'], 0)
        self.assertEqual(counts['hold_contact_ambiguous'], 1)
        self.assertEqual(counts['excluded_human_review'], 1)
        self.assertEqual(counts['selected_marked'], 5)

    def test_reject_stale_fingerprints_unknown_refs_duplicates_and_approval(self):
        cases = []
        d = copy.deepcopy(self.decisions); d['backup_sha256'] = 'c' * 64; cases.append(d)
        d = copy.deepcopy(self.decisions); d['vcf_sha256'] = 'c' * 64; cases.append(d)
        d = copy.deepcopy(self.decisions); d['as_of'] = 'old'; cases.append(d)
        d = copy.deepcopy(self.decisions); d['rows'][0]['ref'] = '3' * 64; cases.append(d)
        d = copy.deepcopy(self.decisions); d['rows'].append(d['rows'][0]); cases.append(d)
        d = copy.deepcopy(self.decisions); d['rows'][0]['reason'] = 'hold_unresolved_jid'; cases.append(d)
        d = copy.deepcopy(self.decisions); d['rows'][0]['action'] = 'include'; cases.append(d)
        for case in cases:
            with self.subTest(case=case), self.assertRaises(SyncError):
                self.apply(case)

    def test_interactive_choices_never_allow_approval(self):
        answers = iter(['yes', 'e', 'p'])
        messages = []
        review_each(self.report['rows'], self.decisions['rows'], ask=lambda _: next(answers), display=messages.append)
        self.assertEqual([r['action'] for r in self.decisions['rows']], ['exclude', 'pending'])
        self.assertTrue(any('e أو p' in msg for msg in messages))

    def test_old_report_without_vcf_fingerprint_is_rejected(self):
        del self.report['vcf_sha256']
        with self.assertRaises(ValueError):
            make_template(self.report)


if __name__ == '__main__':
    unittest.main()
