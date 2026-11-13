#!/usr/bin/env python3
"""Create a local private report of held identities; never uploads or changes state."""
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timezone

from wa_sync import (SyncError, file_sha, load_json, open_message_db, private_dir,
                     read_export, run_tool, select_chats, selection_index)


def main():
    config = load_json(Path('~/nasr-wa-sync/config.json').expanduser(), None)
    if not isinstance(config, dict) or config.get('transport') != 'manual':
        raise SyncError('الإعداد اليدوي غير موجود')
    repo = Path(__file__).resolve().parents[2]
    state_dir = Path(config['state_dir']).expanduser().resolve()
    if state_dir == repo or repo in state_dir.parents:
        raise SyncError('مجلد الحالة يجب أن يكون خارج المستودع')
    private_dir(state_dir)
    backup = Path(config['backup_path']).expanduser().resolve()
    key = Path(config['key_path']).expanduser().resolve()
    if not backup.is_file() or backup.suffix.lower() != '.crypt15' or not key.is_file() or key.stat().st_mode & 0o077:
        raise SyncError('النسخة أو المفتاح غير صالحين')
    with (state_dir / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = file_sha(backup)
        with tempfile.TemporaryDirectory(prefix='nasr-review-', dir=state_dir) as tmp:
            work = Path(tmp)
            index, as_of = selection_index(config, work)
            decrypted = work / 'decrypted.bin'
            run_tool([config.get('wadecrypt_bin', 'wadecrypt'), str(key), str(backup), str(decrypted), '--no-mem'], work)
            db = open_message_db(decrypted, work)
            exported = work / 'export.json'
            argv = [config.get('python_bin', sys.executable), str(Path(__file__).with_name('export_android.py')),
                    '--db', str(db), '--out', str(exported)]
            if config.get('wa_db_path'):
                argv += ['--wa', str(Path(config['wa_db_path']).expanduser().resolve())]
            run_tool(argv, work)
            review = []
            _, counts = select_chats(read_export(exported), index, as_of, review)
            if before != file_sha(backup):
                raise SyncError('تغيرت النسخة أثناء القراءة؛ لم يُكتب تقرير')
            # This report is informational; it cannot authorize an upload.
            output = state_dir / ('holds-review-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump({'schema': 'antix-wa-holds-review-v1', 'as_of': as_of.isoformat(),
                           'backup_sha256': before, 'vcf_sha256': config['selection']['vcf_sha256'], 'rows': review}, handle, ensure_ascii=False, indent=2)
            print(json.dumps({'review_file': str(output), 'held': len(review),
                              'counts': {k: v for k, v in counts.items() if k.startswith('hold_')}}, ensure_ascii=False))
            print('REVIEW_REPORT_OK')


if __name__ == '__main__':
    try:
        main()
    except (SyncError, OSError, KeyError, ValueError, TypeError):
        print('REVIEW_REPORT_FAILED: تعذّر إنشاء التقرير المحلي؛ لم يُرفع شيء', file=sys.stderr)
        raise SystemExit(1)
