#!/usr/bin/env python3
"""Pin a private address book and time for one filtered manual-upload cycle."""
import argparse
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile

from wa_sync import atomic_json, file_sha, load_json, validate_state, empty_state


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--vcf', type=Path, required=True)
    p.add_argument('--config', type=Path, default=Path('~/nasr-wa-sync/config.json').expanduser())
    args = p.parse_args()
    config_path = args.config.expanduser().resolve()
    vcf = args.vcf.expanduser().resolve()
    repo = Path(__file__).resolve().parents[2]
    if not vcf.is_file() or vcf == repo or repo in vcf.parents:
        raise ValueError('يجب أن يكون ملف الدفتر موجودًا خارج المستودع')
    config = load_json(config_path, None)
    if not isinstance(config, dict) or config.get('transport') != 'manual':
        raise ValueError('يلزم إعداد النقل اليدوي أولًا')
    state_dir = Path(config['state_dir']).expanduser().resolve()
    if state_dir == repo or repo in state_dir.parents or not state_dir.is_dir() or state_dir.stat().st_mode & 0o077:
        raise ValueError('مجلد الحالة غير آمن')
    lock = (state_dir / 'run.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = validate_state(load_json(state_dir / 'state.json', empty_state()))
    if any(row.get('uploaded') for row in state['chats'].values()):
        raise ValueError('توجد حالة رفع سابقة؛ يلزم مراجعتها قبل تغيير سياسة التصفية')
    checksum = file_sha(vcf)
    with tempfile.TemporaryDirectory(prefix='selection-check-', dir=state_dir) as td:
        index = Path(td) / 'index.json'
        result = subprocess.run([config.get('node_bin', 'node'), str(Path(__file__).with_name('selection.mjs')),
                                 str(vcf), str(index)], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=180)
        if result.returncode:
            raise ValueError('تعذر تحليل الدفتر أو التحقق من أرقام الاستبعاد؛ لم تتغير الإعدادات')
        summary = json.loads(index.read_text(encoding='utf-8'))
        if file_sha(vcf) != checksum:
            raise ValueError('تغير الدفتر أثناء الفحص؛ لم تتغير الإعدادات')
    # Fixed cutoff makes prepare and confirm reproduce exactly the same selection.
    config['selection'] = {'policy': 'marked-or-recent-v1', 'vcf_path': str(vcf),
                           'vcf_sha256': checksum, 'as_of': datetime.now(timezone.utc).isoformat()}
    atomic_json(config_path, config)
    config_path.chmod(0o600)
    print(json.dumps({'cards': summary['card_count'], 'excluded_marker_cards': summary['excluded_marker_cards'],
                      'excluded_closure_cards': summary['excluded_cards'], 'as_of': config['selection']['as_of']},
                     ensure_ascii=False))
    print('SELECTION_CONFIGURED')


if __name__ == '__main__':
    try:
        main()
    except (OSError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f'SELECTION_SETUP_FAILED: {exc}')
        raise SystemExit(1)
