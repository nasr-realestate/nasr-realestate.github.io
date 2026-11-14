#!/usr/bin/env python3
"""Aggregate-only vCard REV coverage diagnostic. Never prints card content.

REV is only a candidate per-card timestamp. This does not establish that the
exporter supplied trustworthy name/marker modification times or authorize writes.
"""
import datetime
import json
import re
import sys
from pathlib import Path

REV = re.compile(r'^REV(?:;[^:]*)?:(.*)$', re.IGNORECASE)
UTC = re.compile(r'^\d{8}T\d{6}Z$')


def audit(text):
    unfolded = re.sub(r'\r?\n[ \t]', '', text)
    inside = False
    revisions = []
    counts = {'cards': 0, 'utc_revision': 0, 'missing_revision': 0,
              'ambiguous_or_invalid_revision': 0}
    for line in unfolded.splitlines():
        line = line.rstrip('\r')
        if line.upper() == 'BEGIN:VCARD':
            if inside:
                raise ValueError('invalid structure')
            inside, revisions = True, []
        elif line.upper() == 'END:VCARD':
            if not inside:
                raise ValueError('invalid structure')
            counts['cards'] += 1
            if not revisions:
                counts['missing_revision'] += 1
            elif len(revisions) == 1 and UTC.fullmatch(revisions[0]):
                try:
                    datetime.datetime.strptime(revisions[0], '%Y%m%dT%H%M%SZ')
                    counts['utc_revision'] += 1
                except ValueError:
                    counts['ambiguous_or_invalid_revision'] += 1
            else:
                counts['ambiguous_or_invalid_revision'] += 1
            inside = False
        elif inside:
            match = REV.match(line)
            if match:
                revisions.append(match.group(1))
    if inside or not counts['cards']:
        raise ValueError('invalid structure')
    return counts


def main():
    if len(sys.argv) != 2:
        raise ValueError('bad arguments')
    text = Path(sys.argv[1]).read_text(encoding='utf-8-sig')
    print('VCARD_REV_COUNTS ' + json.dumps(audit(text), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, UnicodeError, ValueError):
        print('VCARD_REV_AUDIT_FAILED', file=sys.stderr)
        sys.exit(1)
