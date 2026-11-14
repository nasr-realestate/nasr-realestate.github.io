#!/usr/bin/env node
// Offline owner-side verification. The plaintext SQL exists only in memory.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openBackup } from './private-backup-crypto.mjs';

try {
  const [encryptedPath, privateKeyPath] = process.argv.slice(2);
  if (!encryptedPath || !privateKeyPath || process.argv.length !== 4) throw new Error('invalid-args');
  const stat = fs.statSync(privateKeyPath);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('private-key-permissions');
  const encryptedStat = fs.statSync(encryptedPath);
  if (!encryptedStat.isFile() || encryptedStat.size > 192 * 1024 * 1024) throw new Error('invalid-backup');
  const encrypted = JSON.parse(fs.readFileSync(encryptedPath, 'utf8'));
  const plaintext = openBackup(encrypted, fs.readFileSync(privateKeyPath));
  const verify = `import sqlite3,sys\ntext=sys.stdin.read()\ndb=sqlite3.connect(':memory:')\ndb.execute('PRAGMA foreign_keys=OFF')\ndb.executescript(text)\ndb.execute('PRAGMA foreign_keys=ON')\nassert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]\nassert not db.execute('PRAGMA foreign_key_check').fetchall()\nassert db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='crm_idempotency_receipts'").fetchone()[0]==1\ndb.close()\n`;
  const result = spawnSync('/usr/bin/python3', ['-c', verify], { input: plaintext, stdio: ['pipe', 'ignore', 'ignore'], timeout: 120000 });
  plaintext.fill(0);
  if (result.status !== 0 || result.error) throw new Error('restore-check-failed');
  console.log('LOCAL_ENCRYPTED_BACKUP_DECRYPT_AND_SQLITE_RESTORE_VERIFIED');
} catch {
  console.error('LOCAL_ENCRYPTED_BACKUP_VERIFICATION_FAILED');
  process.exitCode = 1;
}
