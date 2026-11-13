#!/usr/bin/env python3
"""Filtered backup to encrypted batches; no remote calls or state changes."""
import argparse
import fcntl
import json
from pathlib import Path
import re
import subprocess
import sys

import wa_sync


def build_dry_bundle(chats, counts):
    if any(name.startswith('hold_') and value for name, value in counts.items()):
        raise wa_sync.SyncError('selection review required')
    conversations = []
    for item in chats:
        if item.get('status') not in wa_sync.PENDING_STATUSES:
            continue
        jid = item.get('jid', '')
        if not re.fullmatch(r'[0-9]{8,15}@(s\.whatsapp\.net|c\.us)', jid):
            raise wa_sync.SyncError('unverified direct phone')
        title = item.get('title', '')
        if not title or '🌀' in wa_sync.clean(title):
            raise wa_sync.SyncError('invalid selected title')
        conversations.append({
            'conversation_uid': item['uid'], 'title': title,
            'raw_txt': item['text'],
            # Evidence is the direct JID's exact number, not a name inference.
            # The current batch format intentionally carries no contacts, and
            # must not be used for a write until server-side verification exists.
            'selected_phone': '+' + jid.split('@', 1)[0],
        })
    if not conversations:
        raise wa_sync.SyncError('no pending conversations')
    return {'conversations': conversations, 'vcf_contacts': [], 'dry_run': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path('~/nasr-wa-sync/config.json').expanduser())
    parser.add_argument('--pubkey-file', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--exclude-decisions', type=Path)
    parser.add_argument('--prepare-write-batches', action='store_true')
    parser.add_argument('--backup-ref-file', type=Path)
    parser.add_argument('--confirm-metadata-only', action='store_true')
    args = parser.parse_args()
    if ((args.prepare_write_batches and not (args.backup_ref_file and args.confirm_metadata_only)) or
            (not args.prepare_write_batches and (args.backup_ref_file or args.confirm_metadata_only))):
        raise wa_sync.SyncError('explicit write batch confirmation and backup reference required')
    config = wa_sync.load_json(args.config, None)
    if not isinstance(config, dict) or not isinstance(config.get('selection'), dict):
        raise wa_sync.SyncError('selection required')
    repo = Path(__file__).resolve().parents[2]
    state_dir = wa_sync.private_dir(Path(config.get('state_dir', '~/nasr-wa-sync/state')).expanduser().resolve())
    if state_dir == repo or repo in state_dir.parents:
        raise wa_sync.SyncError('private state required')
    key_path = args.pubkey_file.expanduser().resolve(strict=True)
    out_dir = args.out_dir.expanduser().resolve(strict=True)
    if out_dir == state_dir or state_dir in out_dir.parents:
        raise wa_sync.SyncError('output must not be inside state directory')
    with (state_dir / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        decisions = None
        if args.exclude_decisions:
            decisions_path = args.exclude_decisions.expanduser().resolve(strict=True)
            if (not decisions_path.is_file() or decisions_path.stat().st_mode & 0o077 or
                    decisions_path == repo or repo in decisions_path.parents):
                raise wa_sync.SyncError('private decisions required')
            decisions = wa_sync.load_json(decisions_path, None)
        chats, counts, _ = wa_sync.prepare(config, state_dir, write_outbox=False, decisions=decisions)
        bundle = build_dry_bundle(chats, counts)
        script = Path(__file__).resolve().with_name('sealed-batch-plan.mjs')
        command = [config.get('node_bin', 'node'), '--experimental-default-type=module',
                   str(script), '--stdin', str(key_path), str(out_dir)]
        if args.prepare_write_batches:
            command += ['--write-ref-file', str(args.backup_ref_file.expanduser().resolve(strict=True))]
        result = subprocess.run(command,
                                input=json.dumps(bundle, ensure_ascii=False).encode('utf-8'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800, check=False)
        if result.returncode:
            raise wa_sync.SyncError('batch preparation failed')
        summary = result.stdout.decode('utf-8').splitlines()
        if len(summary) != 2 or summary[1] != 'BATCH_PLAN_OK_NO_DISPATCH':
            raise wa_sync.SyncError('invalid batch result')
        data = json.loads(summary[0])
        expected = 'write_envelopes_only' if args.prepare_write_batches else 'dry_run_only'
        if data.get('mode') != expected:
            raise wa_sync.SyncError('unexpected batch mode')
        print(json.dumps({'counts': counts, 'batches': data['batches'],
                          'conversations': data['conversations'], 'mode': expected}, sort_keys=True))
        print('BLOCK_BATCH_PREPARED_NO_DISPATCH' if args.prepare_write_batches else 'BLOCK_BATCH_DRY_RUN_OK_NO_DISPATCH')


if __name__ == '__main__':
    try:
        main()
    except (wa_sync.SyncError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        print('BLOCK_BATCH_DRY_RUN_FAILED_NO_DISPATCH', file=sys.stderr)
        sys.exit(1)
