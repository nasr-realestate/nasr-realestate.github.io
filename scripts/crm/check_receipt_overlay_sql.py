#!/usr/bin/env python3
"""Read-only, in-memory rehearsal of a receipt overlay from local SQL exports.

This never saves or uploads a backup. Use only in a private, trusted environment.
"""
import sqlite3
import sys
from pathlib import Path

from receipt_overlay_prototype import build_receipt_overlay


def load_export(path):
    sql = Path(path).read_text(encoding='utf-8')
    db = sqlite3.connect(':memory:')
    try:
        db.execute('PRAGMA foreign_keys=OFF')
        db.executescript(sql)
        db.execute('PRAGMA foreign_keys=ON')
        return db
    except BaseException:
        db.close()
        raise


def main():
    if len(sys.argv) != 3:
        raise ValueError('invalid-arguments')
    base, current, result = None, None, None
    try:
        base = load_export(sys.argv[1])
        current = load_export(sys.argv[2])
        result = build_receipt_overlay(base, current)
        print('RECEIPT_OVERLAY_IN_MEMORY_VERIFIED_NO_BACKUP_SAVED')
    finally:
        if result is not None:
            result.close()
        if current is not None:
            current.close()
        if base is not None:
            base.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never print paths, SQL, table contents, exception text, or fingerprints.
        print('RECEIPT_OVERLAY_IN_MEMORY_FAILED', file=sys.stderr)
        sys.exit(1)
