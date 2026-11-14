#!/usr/bin/env python3
"""Aggregate-only audit of filtered messages; no message bodies or IDs leave antiX.

This audits format and availability only. Presence or uniqueness within one
snapshot is NOT proof a key remains stable across backups. No network or writes.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import wa_sync

KEY_RE = re.compile(r'^[A-Za-z0-9_-]{1,256}$')


def audit_filtered_messages(exported, as_of):
    """Require the v3-selected snapshot. Return aggregate counts only."""
    cutoff = (as_of - timedelta(days=15)).timestamp()
    until = as_of.timestamp()
    counts = {'chats': 0, 'messages': 0, 'usable_keys': 0, 'missing_or_invalid_keys': 0,
              'duplicate_keys': 0, 'invalid_direction': 0, 'outside_window': 0,
              'text_messages': 0, 'nontext_or_empty': 0}
    for chat in exported.values():
        counts['chats'] += 1
        keys = set()
        for message in chat.get('messages', {}).values():
            counts['messages'] += 1
            key = message.get('key_id')
            if not isinstance(key, str) or not KEY_RE.fullmatch(key):
                counts['missing_or_invalid_keys'] += 1
            elif key in keys:
                counts['duplicate_keys'] += 1
            else:
                keys.add(key)
                counts['usable_keys'] += 1
            if not isinstance(message.get('from_me'), bool):
                counts['invalid_direction'] += 1
            timestamp = wa_sync.epoch_seconds(message.get('timestamp'))
            if not cutoff <= timestamp <= until or message.get('meta'):
                counts['outside_window'] += 1
            body = message.get('data')
            if (message.get('message_type') == 0 and isinstance(body, str) and body.strip()
                    and 'The message is binary data and its base64 is' not in body):
                counts['text_messages'] += 1
            else:
                counts['nontext_or_empty'] += 1
    return counts


def build_text_candidates(chat, as_of):
    """In-memory prototype; do not log or persist the returned customer text.

    A syntactically present key is not proof of stability across backups. Media,
    captions and system events are not transferred by this prototype.
    """
    if as_of.tzinfo is None or not isinstance(chat, dict) or not isinstance(chat.get('messages'), dict):
        raise ValueError('invalid source')
    cutoff = (as_of - timedelta(days=15)).timestamp()
    until = as_of.timestamp()
    keys, result = set(), []
    for message in chat['messages'].values():
        if not isinstance(message, dict) or message.get('meta'):
            raise ValueError('unfiltered source')
        timestamp = wa_sync.epoch_seconds(message.get('timestamp'))
        if not cutoff <= timestamp <= until:
            raise ValueError('outside window')
        body = message.get('data')
        if message.get('message_type') != 0 or not isinstance(body, str) or not body.strip():
            continue
        if 'The message is binary data and its base64 is' in body:
            continue
        key = message.get('key_id')
        if not isinstance(key, str) or not KEY_RE.fullmatch(key) or key in keys or not isinstance(message.get('from_me'), bool):
            raise ValueError('unverified message key or direction')
        keys.add(key)
        body = wa_sync.clean(body).strip()
        if not body or len(body) > 8192:
            raise ValueError('invalid message text')
        sent = datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        result.append({'key_kind': 'wa_key_id', 'source_key': key, 'sent_at': sent,
                       'sender_role': 'broker' if message['from_me'] else 'customer', 'body_text': body})
        if len(result) > 200:
            raise ValueError('batch too large')
    return result


def main():
    if len(sys.argv) != 3:
        raise ValueError('expected config and decisions paths')
    config = wa_sync.load_json(Path(sys.argv[1]).expanduser(), None)
    decisions_path = Path(sys.argv[2]).expanduser().resolve(strict=True)
    if not decisions_path.is_file() or decisions_path.stat().st_mode & 0o077:
        raise ValueError('private decisions required')
    decisions = wa_sync.load_json(decisions_path, None)
    if not isinstance(config, dict) or config.get('selection', {}).get('policy') != 'marked-plus-recent-window-v3':
        raise ValueError('v3 selection required')
    state = wa_sync.private_dir(Path(config.get('state_dir', '~/nasr-wa-sync/state')).expanduser().resolve())
    import fcntl
    with (state / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = {}
        def record(selected, as_of):
            result.update(audit_filtered_messages(selected, as_of))
        _, counts, _ = wa_sync.prepare(config, state, write_outbox=False, decisions=decisions,
                                        selected_audit=record)
        # All selection holds must have valid decision coverage.
        if any(k.startswith('hold_') and v for k, v in counts.items()):
            raise ValueError('selection has unresolved holds')
        print(json.dumps(result, sort_keys=True))
        print('MESSAGE_KEY_AUDIT_ONLY_NO_UPLOAD')


if __name__ == '__main__':
    try:
        main()
    except (wa_sync.SyncError, OSError, ValueError, TypeError, KeyError):
        print('MESSAGE_KEY_AUDIT_FAILED_NO_UPLOAD', file=sys.stderr)
        sys.exit(1)
