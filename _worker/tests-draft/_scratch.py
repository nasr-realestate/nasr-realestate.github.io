"""Shared guard for the D1 rehearsals in this directory.

A rehearsal that mutates its scratch database measures nothing when it starts on a used one: the
"the chain stops at 0009, no draft applied yet" precondition is already consumed, the object-count
comparison sees the previous run's objects, and the failures look like schema regressions. This happened
once for real (2026-11-02, a reused P2F_DIR reported 75/83 for a draft that had not changed). So a used
scratch is refused here, loudly, rather than reported as a barrier.
"""
import os
import sys


def guard_fresh_scratch(state_dir, env_var):
    """Return 'fresh' | 'reused'. Exits with an instruction when a scratch was handed over dirty."""
    held = []
    for root, _dirs, files in os.walk(state_dir):
        held += [f for f in files if f.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-reset'))]
    if not held:
        return 'fresh'
    if os.environ.get('REUSE_SCRATCH') == '1':
        print('  scratch REUSED: %s already holds %s — counts below describe a database that has been '
              'written to before' % (state_dir, ', '.join(sorted(held))[:160]))
        return 'reused'
    sys.exit(
        'refusing to rehearse on a used scratch database: %s holds %s.\n'
        'Start a clean run (e.g. `export %s=$(mktemp -d)`) or set REUSE_SCRATCH=1 to proceed anyway.'
        % (state_dir, ', '.join(sorted(held))[:160], env_var)
    )
