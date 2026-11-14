// A server-side enable flag alone never grants an open-ended write window.
// The lease is independent of the sealed envelope and expires even if a job is cancelled.
export function antixWriteLeaseEnabled(env, now = Date.now()) {
  const expiry = Number(env?.CRM_ANTIX_WRITE_EXPIRES_MS);
  return env?.CRM_ANTIX_METADATA_WRITE_ENABLED === 'true' && Number.isSafeInteger(now) &&
    Number.isSafeInteger(expiry) && expiry > now && expiry - now <= 30 * 60 * 1000;
}
