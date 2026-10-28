-- Additive Web Push subscriptions & idempotent notification delivery log
-- Scoped strictly to private owner CRM notifications on nasr-crm-test-db.

CREATE TABLE IF NOT EXISTS crm_push_subscriptions (
  id TEXT PRIMARY KEY CHECK (length(id) = 16 AND id NOT GLOB '*[^0-9a-f]*'),
  endpoint_hash TEXT NOT NULL UNIQUE CHECK (length(endpoint_hash) = 64 AND endpoint_hash NOT GLOB '*[^0-9a-f]*'),
  endpoint TEXT NOT NULL CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 2048),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 120),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 20 AND 90),
  device_label TEXT NOT NULL DEFAULT '' CHECK (length(device_label) <= 80),
  morning_digest INTEGER NOT NULL DEFAULT 1 CHECK (morning_digest IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_push_notifications_log (
  dedupe_key TEXT PRIMARY KEY CHECK (length(trim(dedupe_key)) BETWEEN 4 AND 240),
  kind TEXT NOT NULL CHECK (kind IN ('morning_digest', 'followup_due', 'viewing_due', 'test')),
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_push_log_sent_at ON crm_push_notifications_log(sent_at);
