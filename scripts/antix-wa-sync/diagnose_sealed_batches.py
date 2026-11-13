#!/usr/bin/env python3
"""Read-only local diagnostic: aggregate error codes only, no message content or network."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

import wa_sync
from prepare_sealed_batches import build_dry_bundle

# Text goes over stdin only. Errors are reduced to a fixed allowlist, not raw
# exception messages (which can contain customer data, paths, or keys).
NODE_SCRIPT = r'''
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const load = p => import(pathToFileURL(path.resolve(p)).href);
const { extractMetadata, sealMetadataBatches, MAX_RAW_BYTES } = await load('scripts/antix-wa-sync/sealed-batch-plan.mjs');
const { validateAntixMetadata } = await load('_worker/crm-antix-metadata-write.js');
const { normalizeInternationalPhone } = await load('_worker/crm-chat-intel.js');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const counts = {};
const inc = k => { counts[k] = (counts[k] || 0) + 1; };
const seen = new Set();
for (const c of input.conversations) {
  if (Buffer.byteLength(c.raw_txt || '', 'utf8') > MAX_RAW_BYTES) { inc('text_over_4mib'); continue; }
  if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 100) { inc('title_invalid_or_over_100'); continue; }
  if (typeof c.selected_phone !== 'string' || !/^\+\d{8,15}$/.test(c.selected_phone) ||
      normalizeInternationalPhone(c.selected_phone) !== c.selected_phone.slice(1)) { inc('phone_invalid'); continue; }
  if (seen.has(c.selected_phone)) { inc('duplicate_phone'); continue; }
  seen.add(c.selected_phone);
  try {
    const meta = await extractMetadata(c);
    try { validateAntixMetadata([meta]); }
    catch { inc('metadata_invalid'); }
  } catch (error) {
    inc(error?.message === 'unparseable-transcript' ? 'unparseable_transcript' : 'source_metadata_invalid');
  }
}
let seal = 'not_attempted';
if (Object.keys(counts).length === 0) {
  try {
    const key = fs.readFileSync(process.env.NASR_DIAG_PUBLIC_KEY, 'utf8').trim();
    const ref = fs.readFileSync(process.env.NASR_DIAG_BACKUP_REF, 'utf8').trim();
    const batches = await sealMetadataBatches(input, key, { writeBackupRef: ref });
    seal = 'ok';
    counts.batches = batches.length;
  } catch (error) {
    const known = new Set(['invalid-backup-reference', 'single-conversation-exceeds-limit',
      'invalid-batch-limits', 'missing-or-duplicate-conversation-identity', 'duplicate-phone',
      'invalid-conversation-metadata', 'invalid-source-metadata', 'unparseable-transcript']);
    seal = known.has(error?.message) ? error.message : 'crypto_or_runtime_error';
  }
}
console.log(JSON.stringify({ conversations: input.conversations.length, problems: counts, seal }));
'''


def main():
    if len(sys.argv) != 2:
        raise ValueError('expected batch directory')
    work = Path(sys.argv[1]).expanduser().resolve(strict=True)
    if not work.is_dir() or work.stat().st_mode & 0o077:
        raise ValueError('private directory required')
    config = wa_sync.load_json(Path('~/nasr-wa-sync/config.json').expanduser(), None)
    if not isinstance(config, dict) or not isinstance(config.get('selection'), dict):
        raise ValueError('selection required')
    state = wa_sync.private_dir(Path(config['state_dir']).expanduser().resolve())
    decisions_path = (work / 'decisions.json').resolve(strict=True)
    if not decisions_path.is_file() or decisions_path.stat().st_mode & 0o077:
        raise ValueError('private decisions required')
    decisions = wa_sync.load_json(decisions_path, None)
    with (state / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            chats, counts, _ = wa_sync.prepare(config, state, write_outbox=False, decisions=decisions)
        except (wa_sync.SyncError, OSError, ValueError, KeyError):
            print('BLOCK_DIAGNOSTIC_PREPARE_FAILED')
            return 1
        print(json.dumps({'selection_counts': counts}, sort_keys=True))
        try:
            bundle = build_dry_bundle(chats, counts)
        except (wa_sync.SyncError, KeyError, TypeError):
            print('BLOCK_DIAGNOSTIC_SELECTION_HELD')
            return 1
        env = {**os.environ, 'NASR_DIAG_PUBLIC_KEY': str(work / 'public-key.txt'),
               'NASR_DIAG_BACKUP_REF': str(work / 'backup-ref.txt')}
        try:
            node = subprocess.run([config.get('node_bin', 'node'), '--experimental-default-type=module',
                                   '--input-type=module', '-e', NODE_SCRIPT],
                                  input=json.dumps(bundle, ensure_ascii=False).encode(),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800, env=env)
        except (OSError, subprocess.TimeoutExpired):
            print('BLOCK_DIAGNOSTIC_NODE_FAILED')
            return 1
        if node.returncode:
            print('BLOCK_DIAGNOSTIC_NODE_FAILED')
            return 1
        result = json.loads(node.stdout)
        print(json.dumps(result, sort_keys=True))
        print('BLOCK_DIAGNOSTIC_OK_NO_UPLOAD')
        return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError):
        print('BLOCK_DIAGNOSTIC_FAILED_NO_UPLOAD', file=sys.stderr)
        sys.exit(1)
