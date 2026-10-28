-- Additive internal authentication schema for Worker-managed sessions and login rate limiting.
-- Stores only SHA-256 / HMAC-SHA256 hex digests; raw access codes, session tokens, CSRF tokens,
-- and raw IP addresses are never stored. Never apply to production before isolated live tests pass.

CREATE TABLE IF NOT EXISTS crm_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  last_seen_at INTEGER NOT NULL CHECK (typeof(last_seen_at) = 'integer'),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR typeof(revoked_at) = 'integer')
);

CREATE INDEX IF NOT EXISTS idx_crm_sessions_active
  ON crm_sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_sessions_expires
  ON crm_sessions(expires_at);

CREATE TABLE IF NOT EXISTS crm_auth_attempts (
  bucket_key TEXT PRIMARY KEY CHECK (length(bucket_key) BETWEEN 6 AND 80),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crm_auth_attempts_window
  ON crm_auth_attempts(window_started_at);
