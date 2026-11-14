import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import diagnose_sealed_batches as diagnostic
import wa_sync


class DiagnosticTests(unittest.TestCase):
    def test_detects_problem_without_exposing_private_content(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            home = root / 'nasr-wa-sync'
            home.mkdir(mode=0o700)
            state = home / 'state'
            state.mkdir(mode=0o700)
            work = home / 'batch'
            work.mkdir(mode=0o700)
            (home / 'config.json').write_text(json.dumps({'state_dir': str(state), 'selection': {'policy': 'marked-plus-recent-window-v2'}}))
            decisions = work / 'decisions.json'
            decisions.write_text('{}')
            decisions.chmod(0o600)
            (work / 'public-key.txt').write_text('not-used')
            (work / 'backup-ref.txt').write_text('not-used')
            item = {'status': 'new', 'jid': '201111111111@s.whatsapp.net', 'title': 'ز' * 4097,
                    'uid': 'wa:synthetic', 'text': '13/11/2025, 04:13 - عميل: PRIVATE-SYNTHETIC-MESSAGE'}
            out = io.StringIO()
            with mock.patch.dict('os.environ', {'HOME': str(root)}), \
                 mock.patch.object(sys, 'argv', ['diagnostic', str(work)]), \
                 mock.patch.object(wa_sync, 'prepare', return_value=([item], {'selected_marked': 1}, None)), \
                 contextlib.redirect_stdout(out):
                self.assertEqual(diagnostic.main(), 0)
            value = out.getvalue()
            self.assertIn('title_invalid_or_over_limit', value)
            self.assertIn('BLOCK_DIAGNOSTIC_OK_NO_UPLOAD', value)
            self.assertNotIn('PRIVATE-SYNTHETIC-MESSAGE', value)
            self.assertNotIn('201111111111', value)
            self.assertFalse((state / 'state.json').exists())

    def test_success_uses_private_key_file_without_writing_envelopes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            home = root / 'nasr-wa-sync'
            home.mkdir(mode=0o700)
            state = home / 'state'
            state.mkdir(mode=0o700)
            work = home / 'batch'
            work.mkdir(mode=0o700)
            (home / 'config.json').write_text(json.dumps({'state_dir': str(state), 'selection': {'policy': 'marked-plus-recent-window-v2'}}))
            decisions = work / 'decisions.json'
            decisions.write_text('{}')
            decisions.chmod(0o600)
            key = subprocess.run(['node', '-e', "const c=require('crypto');const {publicKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});process.stdout.write(publicKey.export({type:'spki',format:'der'}).toString('base64url'))"], capture_output=True, text=True, check=True).stdout
            (work / 'public-key.txt').write_text(key)
            (work / 'backup-ref.txt').write_text('synthetic-backup-01')
            item = {'status': 'new', 'jid': '201111111111@s.whatsapp.net', 'title': 'عميل اصطناعي',
                    'uid': 'wa:synthetic', 'text': '13/11/2025, 04:13 - عميل: PRIVATE-MESSAGE'}
            out = io.StringIO()
            with mock.patch.dict('os.environ', {'HOME': str(root)}), \
                 mock.patch.object(sys, 'argv', ['diagnostic', str(work)]), \
                 mock.patch.object(wa_sync, 'prepare', return_value=([item], {'selected_marked': 1}, None)), \
                 contextlib.redirect_stdout(out):
                self.assertEqual(diagnostic.main(), 0)
            self.assertIn('"seal": "ok"', out.getvalue())
            self.assertNotIn('PRIVATE-MESSAGE', out.getvalue())
            self.assertEqual(sorted(p.name for p in work.iterdir()), ['backup-ref.txt', 'decisions.json', 'public-key.txt'])

    def test_selection_hold_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            home = root / 'nasr-wa-sync'
            home.mkdir(mode=0o700)
            state = home / 'state'
            state.mkdir(mode=0o700)
            work = home / 'batch'
            work.mkdir(mode=0o700)
            (home / 'config.json').write_text(json.dumps({'state_dir': str(state), 'selection': {'policy': 'marked-plus-recent-window-v2'}}))
            decisions = work / 'decisions.json'
            decisions.write_text('{}')
            decisions.chmod(0o600)
            out = io.StringIO()
            with mock.patch.dict('os.environ', {'HOME': str(root)}), \
                 mock.patch.object(sys, 'argv', ['diagnostic', str(work)]), \
                 mock.patch.object(wa_sync, 'prepare', return_value=([], {'hold_identity_collision': 1}, None)), \
                 contextlib.redirect_stdout(out):
                self.assertEqual(diagnostic.main(), 1)
            self.assertIn('BLOCK_DIAGNOSTIC_SELECTION_HELD', out.getvalue())


if __name__ == '__main__':
    unittest.main()
