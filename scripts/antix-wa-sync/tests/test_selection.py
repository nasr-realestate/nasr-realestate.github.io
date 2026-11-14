import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wa_sync import select_chats, marked_coverage_gaps, prepare_missing_marked_contacts

NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)

def conversation(stamp, meta=False):
    return {'messages': {'1': {'timestamp': stamp, 'from_me': True, 'meta': meta, 'data': 'synthetic'}}}

class SelectionTests(unittest.TestCase):
    def test_scope_and_exclusion_precedence(self):
        n = NOW.timestamp()
        chats = {
            '201000000001@s.whatsapp.net': conversation(n - 90 * 86400),
            '201000000002@s.whatsapp.net': conversation(n - 10),
            '201000000003@s.whatsapp.net': conversation(n - 15 * 86400),
            '201000000004@s.whatsapp.net': conversation(n - 15 * 86400 - 1),
            '201000000005@s.whatsapp.net': conversation(n - 1),
            '123456789@g.us': conversation(n - 1),
            '123456789@lid': conversation(n - 1),
            '201000000006@s.whatsapp.net': conversation(n - 1, True),
            '201000000007@s.whatsapp.net': conversation(n + 1),
            '201000000008@s.whatsapp.net': conversation(n - 1),
        }
        idx = {'201000000001': {'marked': True, 'name': '🟢 عميل اصطناعي'},
               '201000000002': {'excluded': True, 'marked': True},
               '201000000005': {'ambiguous': True},
               '201000000003': {'name': 'synthetic', 'marked': False}}
        selected, counts = select_chats(chats, idx, NOW)
        self.assertEqual(set(selected), {'201000000001@s.whatsapp.net', '201000000003@s.whatsapp.net'})
        self.assertEqual(counts['excluded_spiral'], 1)
        self.assertEqual(counts['hold_unknown_recent'], 1)
        self.assertEqual(counts['hold_unresolved_jid'], 1)
        self.assertEqual(counts['hold_contact_ambiguous'], 1)
        self.assertEqual(counts['excluded_non_direct'], 1)
        self.assertEqual(counts['excluded_old_unmarked'], 3)
        self.assertEqual(selected['201000000001@s.whatsapp.net']['name'], '🟢 عميل اصطناعي')


    def test_v2_keeps_all_marked_but_only_recent_messages_for_everyone(self):
        n = NOW.timestamp()
        marked = '201000000001@s.whatsapp.net'
        active = '201000000002@s.whatsapp.net'
        stale = '201000000003@s.whatsapp.net'
        excluded = '201000000004@s.whatsapp.net'
        chats = {
            marked: {'messages': {'old': {'timestamp': n-20*86400, 'data': 'OLD'},
                                  'boundary': {'timestamp': n-15*86400, 'data': 'BOUNDARY'},
                                  'future': {'timestamp': n+1, 'data': 'FUTURE'},
                                  'meta': {'timestamp': n-2, 'meta': True, 'data': 'SYSTEM'}}},
            active: {'messages': {'sent': {'timestamp': n-1, 'from_me': True, 'data': 'SENT'},
                                  'received': {'timestamp': n-2, 'from_me': False, 'data': 'RECEIVED'},
                                  'old': {'timestamp': n-15*86400-1, 'data': 'OLD'}}},
            stale: conversation(n-20*86400),
            excluded: {**conversation(n-1), 'name': 'عميل 🌀'},
            '201000000005@s.whatsapp.net': conversation(n-1),
        }
        idx = {'201000000001': {'marked': True, 'name': '🟡 زبون'},
               '201000000002': {'marked': False, 'name': 'زبون آخر'},
               '201000000003': {'marked': True, 'name': '✈ مسافر'},
               '201000000004': {'marked': True, 'name': '🟢 زبون'}}
        rows = []
        selected, counts = select_chats(chats, idx, NOW, rows, policy='marked-plus-recent-window-v2')
        self.assertEqual(set(selected), {marked, active, stale})
        self.assertEqual(set(selected[marked]['messages']), {'boundary'})
        self.assertEqual(set(selected[active]['messages']), {'sent', 'received'})
        self.assertEqual(selected[stale]['messages'], {})
        self.assertEqual(counts['excluded_spiral'], 1)
        self.assertEqual(counts['hold_unknown_recent'], 1)
        self.assertEqual(len(rows), 1)

    def test_marked_coverage_does_not_count_an_alternative_phone_as_missing(self):
        index = {'__marked_phone_groups__': [['201000000001', '201000000002'], ['201000000003'], []]}
        chats = {'201000000002@s.whatsapp.net': conversation(NOW.timestamp())}
        self.assertEqual(marked_coverage_gaps(index, chats), {'hold_marked_without_phone': 1,
                                                              'hold_marked_not_in_backup': 1})

    def test_vcf_only_marked_clients_do_not_fabricate_jids_or_choose_ambiguous_phones(self):
        index = {'__marked_phone_groups__': [['201000000001'], ['201000000002', '201000000003'], [],
                                            ['201000000004'], ['201000000005']],
                 '201000000001': {'marked': True, 'name': '🟢 عميل اصطناعي', 'ambiguous': False},
                 '201000000004': {'marked': True, 'name': '🟡 متداخل', 'ambiguous': True},
                 '201000000005': {'marked': True, 'name': '🌀 مستبعد', 'excluded': True}}
        pending, counts = prepare_missing_marked_contacts(index, {})
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]['vcf_phone'], '201000000001')
        self.assertEqual(pending[0]['status'], 'contact_only')
        self.assertNotIn('jid', pending[0])
        self.assertEqual(counts, {'hold_marked_without_phone': 1, 'hold_marked_not_in_backup': 3})

    def test_private_review_omits_excluded_and_message_contents(self):
        n = NOW.timestamp()
        chats = {
            '201000000001@s.whatsapp.net': conversation(n),
            '201000000002@s.whatsapp.net': conversation(n),
            '201000000003@s.whatsapp.net': conversation(n),
            'abc@lid': {**conversation(n), 'name': '🌀 مستبعد'},
        }
        idx = {'201000000001': {'excluded': True},
               '201000000002': {'ambiguous': True, 'candidates': ['اختبار ١', 'اختبار ٢']}}
        rows = []
        _, counts = select_chats(chats, idx, NOW, rows)
        self.assertEqual(counts['excluded_spiral'], 2)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['candidates'], ['اختبار ١', 'اختبار ٢'])
        self.assertFalse(any('synthetic' in str(row) for row in rows))
        self.assertFalse(any(row['jid'].startswith('201000000001') or row['jid'] == 'abc@lid' for row in rows))

if __name__ == '__main__':
    unittest.main()
