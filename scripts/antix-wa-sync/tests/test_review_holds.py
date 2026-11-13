import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review_holds


class ReviewTests(unittest.TestCase):
    def test_report_is_private_and_does_not_touch_state_or_outbox(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {'HOME': td}):
            home = Path(td) / 'nasr-wa-sync'
            home.mkdir(mode=0o700)
            state = home / 'state'
            state.mkdir(mode=0o700)
            outbox = state / 'outbox'
            outbox.mkdir(mode=0o700)
            (outbox / 'WA-SYNC__old.zip').write_bytes(b'keep')
            (state / 'state.json').write_text('{"unchanged": true}')
            backup, key = home / 'msgstore.db.crypt15', home / 'key'
            backup.write_bytes(b'synthetic backup')
            key.write_bytes(b'synthetic key')
            key.chmod(0o600)
            config = {'transport': 'manual', 'state_dir': str(state), 'backup_path': str(backup),
                      'key_path': str(key), 'selection': {'vcf_sha256': 'b' * 64}}
            (home / 'config.json').write_text(json.dumps(config))
            now = datetime(2026, 11, 13, tzinfo=timezone.utc)
            exported = {
                '201000000001@s.whatsapp.net': {'messages': {'1': {'timestamp': now.timestamp(), 'data': 'private message'}}},
                '201000000002@s.whatsapp.net': {'messages': {'1': {'timestamp': now.timestamp(), 'data': 'excluded message'}}},
            }
            def fake_run(argv, work):
                if '--out' in argv:
                    Path(argv[argv.index('--out') + 1]).write_text(json.dumps(exported))
            stdout = io.StringIO()
            with patch.object(review_holds, 'selection_index', return_value=({'201000000002': {'excluded': True}}, now)), \
                 patch.object(review_holds, 'run_tool', side_effect=fake_run), \
                 patch.object(review_holds, 'open_message_db', return_value=Path('fake.db')), \
                 contextlib.redirect_stdout(stdout):
                review_holds.main()
            files = list(state.glob('holds-review-*.json'))
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
            report = json.loads(files[0].read_text())
            self.assertEqual(len(report['rows']), 1)
            self.assertNotIn('private message', files[0].read_text())
            self.assertNotIn('201000000002', files[0].read_text())
            self.assertNotIn('201000000001', stdout.getvalue())
            self.assertEqual((outbox / 'WA-SYNC__old.zip').read_bytes(), b'keep')
            self.assertEqual((state / 'state.json').read_text(), '{"unchanged": true}')


if __name__ == '__main__':
    unittest.main()
