import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reconcile_hold_decisions import reconcile


def fixtures():
    fields = {'backup_sha256': 'a' * 64, 'vcf_sha256': 'b' * 64, 'as_of': '2025-11-13T00:00:00+00:00'}
    rows = [{'ref': format(i, '064x'), 'reason': 'hold_unknown_recent'} for i in range(116)]
    old = {'schema': 'antix-hold-decisions-v1', **fields,
           'rows': [{**row, 'action': 'exclude'} for row in rows]}
    report = {'schema': 'antix-wa-holds-review-v1', **fields, 'rows': rows[2:]}
    return old, report


class ReconcileTests(unittest.TestCase):
    def test_only_previous_exclusions_carried_forward(self):
        old, report = fixtures()
        decisions, removed = reconcile(old, report)
        self.assertEqual(removed, 2)
        self.assertEqual(len(decisions['rows']), 114)
        self.assertTrue(all(row['action'] == 'exclude' for row in decisions['rows']))

    def test_reject_new_or_changed_holds_or_source(self):
        for mode in ('new', 'changed', 'source', 'pending', 'duplicate'):
            old, report = fixtures()
            if mode == 'new': report['rows'][0]['ref'] = 'f' * 64
            if mode == 'changed': report['rows'][0]['reason'] = 'hold_unresolved_jid'
            if mode == 'source': report['backup_sha256'] = 'c' * 64
            if mode == 'pending': old['rows'][0]['action'] = 'pending'
            if mode == 'duplicate': old['rows'][0]['ref'] = old['rows'][1]['ref']
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                reconcile(old, report)


if __name__ == '__main__':
    unittest.main()
