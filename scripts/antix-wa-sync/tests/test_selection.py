import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wa_sync import select_chats

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
