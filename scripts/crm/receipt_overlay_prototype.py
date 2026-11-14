#!/usr/bin/env python3
"""Isolated in-memory restoration experiment; never accesses a remote database.

The caller supplies two already-verified SQLite snapshots. This is NOT a backup
or an authorization to restore production data. No input database is modified.
"""
import hashlib
import pickle
import sqlite3

RECEIPTS = 'crm_idempotency_receipts'
EXPECTED_COLUMNS = ('submission_key', 'resource_type', 'resource_id', 'received_at')


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _clone(conn):
    copy = sqlite3.connect(':memory:')
    try:
        conn.backup(copy)
        return copy
    except BaseException:
        copy.close()
        raise


def _fingerprint(conn):
    if conn.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise ValueError('integrity-failed')
    if conn.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('foreign-key-check-failed')
    schema = conn.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    stats = {}
    for name in names:
        table = _quote(name)
        cols = conn.execute(f'PRAGMA table_xinfo({table})').fetchall()
        if not cols or any(row[6] != 0 for row in cols):
            raise ValueError('unsupported-table')
        order = ','.join(_quote(row[1]) for row in cols)
        digest = hashlib.sha256()
        count = 0
        for row in conn.execute(f'SELECT * FROM {table} ORDER BY {order}'):
            blob = pickle.dumps(tuple(row), protocol=4)
            digest.update(len(blob).to_bytes(8, 'big'))
            digest.update(blob)
            count += 1
        stats[name] = (count, digest.digest())
    return schema, stats


def build_receipt_overlay(base, current):
    """Return an independent in-memory copy only when all full checks pass.

    Requires quiesced sources externally: the double read detects changes but
    cannot prevent subsequent concurrent changes. The returned database is not
    persisted or dispatched. Callers must close it.
    """
    if base.in_transaction or current.in_transaction:
        raise ValueError('input-transaction-open')
    base_copy = _clone(base)
    source_copy = None
    restored = None
    try:
        source_copy = _clone(current)
    except BaseException:
        base_copy.close()
        raise
    try:
        base_schema, base_stats = _fingerprint(base_copy)
        source_schema, source_stats = _fingerprint(source_copy)
        if base_schema != source_schema or base_stats.keys() != source_stats.keys() or RECEIPTS not in source_stats:
            raise ValueError('schema-mismatch')
        if any(base_stats[n] != source_stats[n] for n in source_stats if n != RECEIPTS):
            raise ValueError('non-receipt-data-differs')
        columns = tuple(row[1] for row in source_copy.execute(f'PRAGMA table_xinfo({_quote(RECEIPTS)})'))
        if columns != EXPECTED_COLUMNS:
            raise ValueError('unsupported-receipt-schema')
        if source_copy.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (RECEIPTS,)).fetchone():
            raise ValueError('receipt-trigger-present')
        for name in source_stats:
            if any(row[2] == RECEIPTS for row in source_copy.execute(f'PRAGMA foreign_key_list({_quote(name)})')):
                raise ValueError('receipt-foreign-key-present')
        restored = _clone(base_copy)
        restored.execute('BEGIN IMMEDIATE')
        try:
            restored.execute(f'DELETE FROM {_quote(RECEIPTS)}')
            restored.executemany(f'INSERT INTO {_quote(RECEIPTS)} VALUES (?,?,?,?)',
                                 source_copy.execute(f'SELECT * FROM {_quote(RECEIPTS)}'))
            restored.commit()
        except BaseException:
            restored.rollback()
            raise
        if _fingerprint(restored) != (source_schema, source_stats):
            raise ValueError('restored-copy-mismatch')
        latest = _clone(current)
        try:
            if _fingerprint(latest) != (source_schema, source_stats):
                raise ValueError('source-changed-during-check')
        finally:
            latest.close()
        result, restored = restored, None
        return result
    finally:
        base_copy.close()
        source_copy.close()
        if restored is not None:
            restored.close()
