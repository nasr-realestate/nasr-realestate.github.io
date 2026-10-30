-- Additive CRM migration 0005:
-- 1) Listings schema alignment (status, price_updated_at) on isolated nasr-crm-test-db
-- 2) Phone provenance & contact audit log (communication_consent & phone lifecycle)
-- 3) Untruncated WhatsApp/chat raw storage, per-message timeline, safe links, and 21-chat review queue
-- 4) Internal Conversation Intelligence & Smart Follow-up Alerts with strict DB-level deduplication
-- Never apply to production nasr-market-db; apply only after restorable backup & isolated staging test.

ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'sold', 'rented', 'paused', 'archived'));
ALTER TABLE listings ADD COLUMN price_updated_at TEXT;
UPDATE listings SET price_updated_at = observed_at WHERE price_updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_listings_crm_match
  ON listings(source_id, area_id, status, transaction_type, price);

ALTER TABLE crm_contact_phones ADD COLUMN raw_input TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_contact_phones ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE crm_contact_phones ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_contact_phones ADD COLUMN verified_at TEXT;

ALTER TABLE crm_activities ADD COLUMN full_text TEXT;
ALTER TABLE crm_activities ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_activities ADD COLUMN original_sent_at TEXT;
ALTER TABLE crm_activities ADD COLUMN external_links_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE crm_activities ADD COLUMN conversation_id TEXT;

CREATE TABLE IF NOT EXISTS crm_contact_audit_log (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'name_updated',
    'consent_changed',
    'phone_added',
    'phone_updated',
    'phone_deleted',
    'primary_phone_changed',
    'phone_conflict_resolved',
    'conversation_linked',
    'source_synced'
  )),
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source_ref TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_audit_contact
  ON crm_contact_audit_log(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_conversations (
  id TEXT PRIMARY KEY,
  conversation_uid TEXT NOT NULL UNIQUE,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'whatsapp_export',
  source_ref TEXT NOT NULL DEFAULT '',
  chat_title TEXT NOT NULL,
  peer_sender_name TEXT NOT NULL DEFAULT '',
  match_status TEXT NOT NULL DEFAULT 'matched'
    CHECK (match_status IN ('matched', 'unmatched_review', 'conflict_review', 'resolved_manual')),
  match_method TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_message_at TEXT,
  last_message_at TEXT,
  parse_warnings_json TEXT NOT NULL DEFAULT '[]',
  analyzed_at TEXT,
  analyzed_rule_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_contact
  ON crm_conversations(contact_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_status
  ON crm_conversations(match_status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS crm_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  message_uid TEXT NOT NULL UNIQUE,
  seq_no INTEGER NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'broker', 'system', 'unknown')),
  sender_label TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  raw_timestamp_text TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL,
  links_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_conv_messages_conv_seq
  ON crm_conversation_messages(conversation_id, seq_no ASC);

CREATE TABLE IF NOT EXISTS crm_conversation_insights (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES crm_conversations(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  last_contact_at TEXT,
  last_customer_message_at TEXT,
  last_broker_message_at TEXT,
  last_confirmed_request_json TEXT,
  last_offer_sent_json TEXT,
  viewing_request_json TEXT,
  callback_promise_json TEXT,
  unanswered_question_json TEXT,
  stalled_status_json TEXT,
  spec_change_json TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  source_message_id TEXT REFERENCES crm_conversation_messages(id) ON DELETE SET NULL,
  analyzed_at TEXT NOT NULL,
  rule_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_conv_insights_contact
  ON crm_conversation_insights(contact_id, analyzed_at DESC);

CREATE TABLE IF NOT EXISTS crm_smart_alerts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES crm_conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES crm_conversation_messages(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  dedupe_conversation_key TEXT NOT NULL DEFAULT '0',
  dedupe_message_key TEXT NOT NULL DEFAULT '0',
  dedupe_contact_key TEXT NOT NULL DEFAULT '0',
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'needs_followup',
    'followup_approaching',
    'followup_overdue',
    'viewing_requested_unlogged',
    'offer_sent_no_followup',
    'request_specs_changed',
    'unanswered_question',
    'high_interest_stalled'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'snoozed', 'completed', 'dismissed')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('high', 'normal', 'low')),
  customer_name TEXT NOT NULL,
  alert_reason TEXT NOT NULL,
  source_message_at TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  due_at TEXT,
  snoozed_until TEXT,
  due_precision TEXT NOT NULL DEFAULT 'none'
    CHECK (due_precision IN ('exact', 'day', 'ambiguous', 'none')),
  date_origin TEXT NOT NULL DEFAULT 'system'
    CHECK (date_origin IN ('customer_promised', 'broker_scheduled', 'system')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  rule_version TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by_activity_id TEXT REFERENCES crm_activities(id) ON DELETE SET NULL,
  push_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dedupe_conversation_key, dedupe_message_key, dedupe_contact_key, alert_type)
);
CREATE INDEX IF NOT EXISTS idx_crm_smart_alerts_status_due
  ON crm_smart_alerts(status, due_at ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_smart_alerts_contact
  ON crm_smart_alerts(contact_id, status, updated_at DESC);
