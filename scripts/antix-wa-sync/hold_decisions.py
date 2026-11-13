#!/usr/bin/env python3
"""Make an explicitly pending, private review decision template; never approves identities."""
import argparse
import json
import os
from pathlib import Path
import re
import sys


def make_template(report):
    if not isinstance(report, dict) or report.get('schema') != 'antix-wa-holds-review-v1':
        raise ValueError('bad report')
    for field in ('backup_sha256', 'vcf_sha256'):
        if not re.fullmatch(r'[0-9a-f]{64}', str(report.get(field, ''))):
            raise ValueError('report is missing a fingerprint; regenerate it')
    if not isinstance(report.get('as_of'), str) or not isinstance(report.get('rows'), list):
        raise ValueError('bad report')
    rows = []
    seen = set()
    for row in report['rows']:
        if (not isinstance(row, dict) or not re.fullmatch(r'[0-9a-f]{64}', str(row.get('ref', '')))
                or row['ref'] in seen or row.get('reason') not in
                {'hold_contact_ambiguous', 'hold_unknown_recent', 'hold_unresolved_jid'}):
            raise ValueError('bad report row')
        seen.add(row['ref'])
        rows.append({'ref': row['ref'], 'reason': row['reason'], 'action': 'pending'})
    return {'schema': 'antix-hold-decisions-v1', 'backup_sha256': report['backup_sha256'],
            'vcf_sha256': report['vcf_sha256'], 'as_of': report['as_of'], 'rows': rows}


def safe_display(value):
    # Contact names are untrusted input; do not execute terminal escapes.
    return ''.join(c for c in str(value or '') if c.isprintable())[:300]


def review_each(source_rows, decisions, ask=input, display=print):
    for index, (source, decision) in enumerate(zip(source_rows, decisions), 1):
        # The report is private and should be viewed only on the user's device.
        display(f"\n[{index}/{len(decisions)}] سبب: {source['reason']}")
        display(f"المعرف: {safe_display(source.get('jid'))} | الاسم: {safe_display(source.get('title'))}")
        if isinstance(source.get('candidates'), list) and source['candidates']:
            display('الأسماء المحتملة: ' + ' | '.join(safe_display(value) for value in source['candidates'][:20]))
        while True:
            choice = ask('اكتب e للاستبعاد أو p للإبقاء معلّقًا: ').strip().lower()
            if choice in {'e', 'p'}:
                decision['action'] = 'exclude' if choice == 'e' else 'pending'
                break
            display('اختر e أو p فقط؛ لا يمكن اعتماد إدخال من هذه الشاشة.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--review', action='store_true', help='review locally, one item at a time')
    mode.add_argument('--defer-all', action='store_true', help='exclude every currently held case from this batch only')
    parser.add_argument('--confirm-defer-all', action='store_true')
    args = parser.parse_args()
    if args.defer_all != args.confirm_defer_all:
        raise ValueError('explicit defer-all confirmation required')
    repo = Path(__file__).resolve().parents[2]
    report_path = args.report.expanduser().resolve(strict=True)
    output = args.out.expanduser().absolute()
    parent = output.parent.resolve(strict=True)
    if (not report_path.is_file() or report_path.stat().st_mode & 0o077 or
            report_path == repo or repo in report_path.parents or
            parent == repo or repo in parent.parents or parent.stat().st_mode & 0o077):
        raise ValueError('private paths required')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    template = make_template(report)
    if args.review:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ValueError('interactive review requires a local terminal')
        review_each(report['rows'], template['rows'])
    if args.defer_all:
        for row in template['rows']:
            row['action'] = 'exclude'
    fd = os.open(parent / output.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(template, handle, ensure_ascii=False, indent=2)
    except Exception:
        (parent / output.name).unlink(missing_ok=True)
        raise
    print(json.dumps({'pending': sum(row['action'] == 'pending' for row in template['rows']),
                      'excluded': sum(row['action'] == 'exclude' for row in template['rows'])}))
    if args.defer_all:
        print('BLOCK_HOLDS_DEFERRED_NO_UPLOAD')
    else:
        print('BLOCK_HOLD_REVIEW_OK_NO_UPLOAD' if args.review else 'BLOCK_HOLD_TEMPLATE_OK_NO_DECISIONS')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, EOFError, KeyboardInterrupt):
        print('BLOCK_HOLD_TEMPLATE_FAILED', file=sys.stderr)
        sys.exit(1)
