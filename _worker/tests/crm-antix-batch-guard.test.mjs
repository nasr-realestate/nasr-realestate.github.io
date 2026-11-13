import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSourceSyncBundle } from '../crm-sync-and-match.js';

test('antiX phone evidence cannot be written or mixed with name-matching contacts', async () => {
  const db = { prepare() { throw new Error('guard must reject before database access'); } };
  const conversations = [{ title: 'اسم اصطناعي', selected_phone: '+201111111111', raw_txt: 'نص اصطناعي' }];
  for (const bundle of [
    { conversations },
    { conversations, dry_run: true, vcf_contacts: [{ fn: 'اسم اصطناعي' }] },
    { conversations, dry_run: true, restore_opportunities: [{}] },
  ]) {
    assert.deepEqual(await runSourceSyncBundle(db, bundle), { ok: false, error: 'antix_phone_verified_write_not_available' });
  }
});
