import { test } from 'node:test';
import assert from 'node:assert/strict';
import { antixWriteLeaseEnabled } from '../crm-antix-write-lease.js';

test('write lease requires both enable flag and bounded, unexpired server time', () => {
  const now = 1800000000000;
  const env = { CRM_ANTIX_METADATA_WRITE_ENABLED: 'true', CRM_ANTIX_WRITE_EXPIRES_MS: String(now + 1000) };
  assert.equal(antixWriteLeaseEnabled(env, now), true);
  for (const expiry of [undefined, '', 'NaN', String(now), String(now - 1), String(now + 1800001)]) {
    assert.equal(antixWriteLeaseEnabled({ ...env, CRM_ANTIX_WRITE_EXPIRES_MS: expiry }, now), false);
  }
  assert.equal(antixWriteLeaseEnabled({ ...env, CRM_ANTIX_METADATA_WRITE_ENABLED: 'false' }, now), false);
  assert.equal(antixWriteLeaseEnabled(env, now + 1000), false);
});
