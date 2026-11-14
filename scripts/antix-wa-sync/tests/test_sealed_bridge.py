"""Synthetic only: selection-to-sealed bridge is fail-closed and changes no state."""
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_sealed_batches as bridge
import wa_sync
from test_wa_sync import synthetic_chat


class SealedBridgeTests(unittest.TestCase):
    def test_scope_to_phone_evidence_and_no_contacts(self):
        synthetic = next(iter(synthetic_chat().values()))
        exported = {
            '201111111111@s.whatsapp.net': {**synthetic, 'name': '🟢 عميل اصطناعي'},
            '201222222222@s.whatsapp.net': {**synthetic, 'name': '🌀 مستبعد'},
            'group@g.us': synthetic,
            'unknown@lid': synthetic,
        }
        index = {'201111111111': {'name': '🟢 عميل اصطناعي', 'marked': True, 'ambiguous': False},
                 '201222222222': {'excluded': True}}
        selected, counts = wa_sync.select_chats(exported, index, datetime(2025, 11, 14, tzinfo=timezone.utc))
        chats, plan = wa_sync.plan_chats(selected, wa_sync.empty_state())
        self.assertEqual(len(chats), 1)
        self.assertEqual(counts['excluded_spiral'], 1)
        self.assertEqual(counts['excluded_non_direct'], 1)
        with self.assertRaises(wa_sync.SyncError):
            bridge.build_dry_bundle(chats, {**counts, **plan})
        del counts['hold_unresolved_jid']
        bundle = bridge.build_dry_bundle(chats, {**counts, **plan})
        self.assertEqual(bundle['vcf_contacts'], [])
        self.assertTrue(bundle['dry_run'])
        self.assertEqual(bundle['conversations'][0]['selected_phone'], '+201111111111')
        self.assertNotIn('مستبعد', json.dumps(bundle, ensure_ascii=False))

    def test_blocks_unknown_jid_and_spiral_even_if_misclassified(self):
        base = {'status': 'new', 'jid': 'group@g.us', 'title': 'test', 'uid': 'wa:test', 'text': 'fake'}
        with self.assertRaises(wa_sync.SyncError):
            bridge.build_dry_bundle([base], {})
        with self.assertRaises(wa_sync.SyncError):
            bridge.build_dry_bundle([{**base, 'jid': '201111111111@s.whatsapp.net', 'title': '🌀 test'}], {})

    def test_embedded_spiral_is_never_selected_or_bundled(self):
        chat = next(iter(synthetic_chat().values()))
        jid = '201111111111@s.whatsapp.net'
        selected, counts = wa_sync.select_chats({jid: {**chat, 'name': 'اسم 🌀 مستبعد'}},
            {jid.split('@')[0]: {'name': 'اسم عادي', 'marked': True}}, datetime(2025, 11, 14, tzinfo=timezone.utc))
        self.assertFalse(selected)
        self.assertEqual(counts['excluded_spiral'], 1)
        with self.assertRaises(wa_sync.SyncError):
            bridge.build_dry_bundle([{'status': 'new', 'jid': jid, 'title': 'اسم 🌀 مستبعد', 'uid': 'wa:test', 'text': 'fake'}], {})

    def test_bridge_main_seals_selected_data_without_state_write(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state = root / 'state'
            state.mkdir(mode=0o700)
            out = root / 'sealed'
            out.mkdir(mode=0o700)
            keys = root / 'keys.json'
            subprocess.run(['node', '-e',
                "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync(process.argv[1],JSON.stringify({pub:publicKey.export({type:'spki',format:'der'}).toString('base64url'),priv:privateKey.export({type:'pkcs8',format:'pem'})}));", str(keys)], check=True)
            key = root / 'public.txt'
            key.write_text(json.loads(keys.read_text())['pub'])
            config = root / 'config.json'
            config.write_text(json.dumps({'state_dir': str(state), 'selection': {'policy': 'marked-plus-recent-window-v2'}}))
            item = {'status': 'new', 'jid': '201111111111@s.whatsapp.net', 'title': '🟢 عميل اصطناعي',
                    'uid': 'wa:fake', 'text': '13/11/2025, 04:13 - عميل: رسالة اصطناعية'}
            argv = ['bridge', '--config', str(config), '--pubkey-file', str(key), '--out-dir', str(out)]
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(wa_sync, 'prepare', return_value=([item], {'selected_marked': 1}, None)):
                bridge.main()
            self.assertFalse((state / 'state.json').exists())
            envelope = next(out.iterdir())
            self.assertEqual(envelope.stat().st_mode & 0o777, 0o600)
            js = """const c=require('crypto'),fs=require('fs');const k=JSON.parse(fs.readFileSync(process.argv[1]));const p=fs.readFileSync(process.argv[2],'utf8').trim().split('.');const aes=c.privateDecrypt({key:k.priv,oaepHash:'sha256'},Buffer.from(p[1],'base64url'));const b=Buffer.from(p[3],'base64url');const d=c.createDecipheriv('aes-256-gcm',aes,Buffer.from(p[2],'base64url'));d.setAuthTag(b.subarray(-16));const x=JSON.parse(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]));if(!x.dry_run||x.sync_bundle.vcf_contacts.length||x.sync_bundle.conversations[0].selected_phone!=='+201111111111'||JSON.stringify(x).includes('رسالة اصطناعية')||x.sync_bundle.conversations[0].raw_txt)process.exit(1);"""
            subprocess.run(['node', '-e', js, str(keys), str(envelope)], check=True)

    def test_explicit_write_batch_stays_local_and_is_encrypted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state, out = root / 'state', root / 'sealed'
            state.mkdir(mode=0o700)
            out.mkdir(mode=0o700)
            keys = root / 'keys.json'
            subprocess.run(['node', '-e',
                "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync(process.argv[1],JSON.stringify({pub:publicKey.export({type:'spki',format:'der'}).toString('base64url'),priv:privateKey.export({type:'pkcs8',format:'pem'})}));", str(keys)], check=True)
            key = root / 'public.txt'
            key.write_text(json.loads(keys.read_text())['pub'])
            ref = root / 'backup.txt'
            ref.write_text('synthetic-backup-01')
            ref.chmod(0o600)
            config = root / 'config.json'
            config.write_text(json.dumps({'state_dir': str(state), 'selection': {'policy': 'marked-plus-recent-window-v2'}}))
            item = {'status': 'new', 'jid': '201111111111@s.whatsapp.net', 'title': '🟢 عميل اصطناعي',
                    'uid': 'wa:fake', 'text': '13/11/2025, 04:13 - عميل: محتوى اصطناعي'}
            argv = ['bridge', '--config', str(config), '--pubkey-file', str(key), '--out-dir', str(out),
                    '--prepare-write-batches', '--backup-ref-file', str(ref), '--confirm-metadata-only']
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(wa_sync, 'prepare', return_value=([item], {'selected_marked': 1}, None)):
                bridge.main()
            envelope = next(out.iterdir())
            self.assertTrue(envelope.name.startswith('write-'))
            self.assertEqual(envelope.stat().st_mode & 0o777, 0o600)
            self.assertFalse((state / 'state.json').exists())
            js = """const c=require('crypto'),fs=require('fs');const k=JSON.parse(fs.readFileSync(process.argv[1]));const p=fs.readFileSync(process.argv[2],'utf8').trim().split('.');const aes=c.privateDecrypt({key:k.priv,oaepHash:'sha256'},Buffer.from(p[1],'base64url'));const b=Buffer.from(p[3],'base64url');const d=c.createDecipheriv('aes-256-gcm',aes,Buffer.from(p[2],'base64url'));d.setAuthTag(b.subarray(-16));const x=JSON.parse(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]));if(x.dry_run||x.sync_bundle.antix_mode!=='metadata_only_v1'||x.sync_bundle.backup_verified_ref!=='synthetic-backup-01'||JSON.stringify(x).includes('محتوى اصطناعي'))process.exit(1);"""
            subprocess.run(['node', '-e', js, str(keys), str(envelope)], check=True)

    def test_ref_or_confirmation_without_write_flag_is_rejected_before_config(self):
        for flags in (['--confirm-metadata-only'], ['--backup-ref-file', 'anything'], ['--prepare-write-batches']):
            with self.subTest(flags=flags), mock.patch.object(sys, 'argv', ['bridge', '--pubkey-file', 'x', '--out-dir', 'y', *flags]):
                with self.assertRaises(wa_sync.SyncError):
                    bridge.main()

    def test_no_outbox_cleanup_for_non_zip_preparation(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            backup = home / 'msgstore.db.crypt15'
            backup.write_bytes(b'encrypted')
            key = home / 'key'
            key.write_bytes(b'key')
            key.chmod(0o600)
            outbox = home / 'outbox'
            outbox.mkdir()
            existing = outbox / 'WA-SYNC__old.zip'
            existing.write_bytes(b'keep')
            config = {'backup_path': str(backup), 'key_path': str(key)}
            with mock.patch.object(wa_sync, 'run_tool', side_effect=wa_sync.SyncError('stop')):
                with self.assertRaises(wa_sync.SyncError):
                    wa_sync.prepare(config, home, write_outbox=False)
            self.assertEqual(existing.read_bytes(), b'keep')


if __name__ == '__main__':
    unittest.main()
