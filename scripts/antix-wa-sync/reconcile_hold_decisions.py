#!/usr/bin/env python3
"""Carry forward only existing exclusions onto a fresh private review report."""
import json
import os
from pathlib import Path
import sys

from hold_decisions import make_template


def reconcile(old, report):
    current = make_template(report)
    if not isinstance(old, dict) or old.get('schema') != 'antix-hold-decisions-v1':
        raise ValueError('invalid decisions')
    if any(old.get(k) != current[k] for k in ('backup_sha256', 'vcf_sha256', 'as_of')):
        raise ValueError('source mismatch')
    rows = old.get('rows')
    if not isinstance(rows, list) or len(rows) != 116:
        raise ValueError('unexpected original count')
    previous = {}
    for row in rows:
        if (not isinstance(row, dict) or row.get('action') != 'exclude' or
                not isinstance(row.get('ref'), str) or row['ref'] in previous):
            raise ValueError('invalid prior decision')
        previous[row['ref']] = row.get('reason')
    for row in current['rows']:
        if previous.get(row['ref']) != row['reason']:
            raise ValueError('new or changed held case')
        row['action'] = 'exclude'
    return current, len(rows) - len(current['rows'])


def main():
    if len(sys.argv) != 4:
        raise ValueError('invalid arguments')
    oldpath, reportpath, output = (Path(p).expanduser().absolute() for p in sys.argv[1:])
    for p in (oldpath, reportpath):
        if not p.is_file() or p.stat().st_mode & 0o077:
            raise ValueError('private input required')
    if not output.parent.is_dir() or output.parent.stat().st_mode & 0o077:
        raise ValueError('private output required')
    old = json.loads(oldpath.read_text(encoding='utf-8'))
    report = json.loads(reportpath.read_text(encoding='utf-8'))
    result, removed = reconcile(old, report)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    print(json.dumps({'previous_exclusions': 116, 'current_exclusions': len(result['rows']),
                      'no_longer_held': removed, 'new_or_changed': 0}))
    print('BLOCK_DECISIONS_RECONCILED_NO_UPLOAD')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print('BLOCK_DECISIONS_RECONCILE_FAILED_NO_UPLOAD', file=sys.stderr)
        sys.exit(1)
