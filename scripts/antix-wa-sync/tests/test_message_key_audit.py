import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import message_key_audit as audit
import wa_sync


class MessageKeyAuditTests(unittest.TestCase):
    def setUp(self):
        self.when = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
        self.msg = {'key_id': 'source-key-1', 'timestamp': 1794398400000, 'from_me': False,
                    'message_type': 0, 'data': 'نص عميل اصطناعي سري', 'meta': False}

    def run_audit(self, messages):
        return audit.audit_filtered_messages({'201111111111@s.whatsapp.net': {'messages': messages}}, self.when)

    def test_aggregate_only_and_no_text_or_identity(self):
        out = self.run_audit({'100': self.msg})
        self.assertEqual(out['usable_keys'], 1)
        self.assertEqual(out['outside_window'], 0)
        self.assertEqual(out['text_messages'], 1)
        self.assertNotIn('سري', json.dumps(out, ensure_ascii=False))
        self.assertNotIn('201111111111', json.dumps(out))
        self.assertNotIn('source-key-1', json.dumps(out))

    def test_missing_duplicate_direction_and_nontext(self):
        messages = {'1': self.msg, '2': {**self.msg},
                    '3': {**self.msg, 'key_id': None, 'from_me': None, 'data': None, 'message_type': 3}}
        out = self.run_audit(messages)
        self.assertEqual((out['messages'], out['usable_keys'], out['duplicate_keys'],
                          out['missing_or_invalid_keys'], out['invalid_direction'], out['nontext_or_empty']),
                         (3, 1, 1, 1, 1, 1))

    def test_outside_window_and_meta_counted(self):
        messages = {'1': {**self.msg, 'timestamp': 1763000000000}, '2': {**self.msg, 'key_id': 'second', 'meta': True}}
        self.assertEqual(self.run_audit(messages)['outside_window'], 2)

    def test_in_memory_text_candidates_use_real_keys_and_preserve_direction(self):
        chat = {'messages': {'1': self.msg,
                '2': {**self.msg, 'key_id': 'outgoing-key', 'from_me': True},
                '3': {**self.msg, 'key_id': 'media-key', 'message_type': 3, 'data': None}}}
        result = audit.build_text_candidates(chat, self.when)
        self.assertEqual(len(result), 2)
        self.assertEqual([m['sender_role'] for m in result], ['customer', 'broker'])
        self.assertEqual(result[0]['source_key'], 'source-key-1')
        self.assertTrue(result[0]['sent_at'].endswith('Z'))
        for bad in [None, 'invalid key']:
            with self.assertRaises(ValueError):
                audit.build_text_candidates({'messages': {'1': {**self.msg, 'key_id': bad}}}, self.when)
        with self.assertRaises(ValueError):
            audit.build_text_candidates({'messages': {'1': self.msg, '2': self.msg}}, self.when)
        with self.assertRaises(ValueError):
            audit.build_text_candidates({'messages': {'1': {**self.msg, 'from_me': None}}}, self.when)
        with self.assertRaises(ValueError):
            audit.build_text_candidates({'messages': {'1': {**self.msg, 'meta': True}}}, self.when)

    def test_callback_cannot_be_used_for_outbox_or_legacy_selection(self):
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.prepare({'selection': {'policy': 'marked-plus-recent-window-v3'}}, Path('/unused'),
                            write_outbox=True, selected_audit=lambda *_: None)
        with self.assertRaises(wa_sync.SyncError):
            wa_sync.prepare({}, Path('/unused'), write_outbox=False, selected_audit=lambda *_: None)


if __name__ == '__main__':
    unittest.main()
