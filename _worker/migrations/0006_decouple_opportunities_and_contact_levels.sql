-- Additive CRM migration 0006 (isolated nasr-crm-test-db only):
-- 1) Three-level data separation:
--    * Complete contact: name + verified phone (archived_at IS NULL, >=1 phone)
--    * Incomplete contact: name/chat identifier without phone (archived_at IS NULL, 0 phones, flagged for review)
--    * Real-estate opportunity: independent record (nullable contact_id, lead_label, direct conversation_id)
-- 2) Decouples contact delete/archive from opportunities, conversations, activities, property links, and smart alerts
--    (replaces ON DELETE RESTRICT / ON DELETE CASCADE on contact references with ON DELETE SET NULL).
-- Never apply to production nasr-market-db; apply only after restorable backup & isolated staging test.

ALTER TABLE crm_contacts ADD COLUMN archived_at TEXT;
ALTER TABLE crm_contacts ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_crm_contacts_archived ON crm_contacts(archived_at, updated_at DESC);

CREATE TABLE _mig0006_conv_opp AS
  SELECT id, opportunity_id FROM crm_conversations WHERE opportunity_id IS NOT NULL;
CREATE TABLE _mig0006_ins_opp AS
  SELECT id, opportunity_id FROM crm_conversation_insights WHERE opportunity_id IS NOT NULL;

UPDATE crm_conversations SET opportunity_id = NULL WHERE opportunity_id IS NOT NULL;
UPDATE crm_conversation_insights SET opportunity_id = NULL WHERE opportunity_id IS NOT NULL;

CREATE TABLE _mig0006_alerts_bak AS SELECT * FROM crm_smart_alerts;
DROP TABLE crm_smart_alerts;

CREATE TABLE _mig0006_activities_bak AS SELECT * FROM crm_activities;
DROP TABLE crm_activities;

CREATE TABLE _mig0006_opp_props_bak AS SELECT * FROM crm_opportunity_properties;
DROP TABLE crm_opportunity_properties;

CREATE TABLE _mig0006_opps_bak AS SELECT * FROM crm_opportunities;
DROP TABLE crm_opportunities;

CREATE TABLE crm_opportunities (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES crm_conversations(id) ON DELETE SET NULL,
  lead_label TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'مدينة نصر' CHECK (city = 'مدينة نصر'),
  area_label TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL CHECK (intent IN ('buy','rent','sell','lease','other')),
  source TEXT NOT NULL CHECK (source IN ('call','missed_call','referral','website','whatsapp','other')),
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','visit_scheduled','viewing_done','offer','negotiating','near_close','won','lost','paused','unqualified')),
  track TEXT NOT NULL DEFAULT 'sale_apt' CHECK (track IN ('sale_apt', 'furnished_apt', 'new_rent_apt', 'admin_hq', 'transient')),
  budget_min REAL,
  budget_max REAL,
  size_min_m2 REAL,
  size_max_m2 REAL,
  property_type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  next_action TEXT,
  next_followup_at TEXT,
  no_followup_reason TEXT,
  closed_at TEXT,
  loss_reason TEXT CHECK (loss_reason IS NULL OR loss_reason IN ('price','location','size','financing','timing','no_response','competition','unsuitable','other')),
  loss_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (budget_min IS NULL OR budget_min >= 0),
  CHECK (budget_max IS NULL OR budget_max >= 0),
  CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max),
  CHECK (size_min_m2 IS NULL OR size_min_m2 >= 0),
  CHECK (size_max_m2 IS NULL OR size_max_m2 >= 0),
  CHECK (size_min_m2 IS NULL OR size_max_m2 IS NULL OR size_min_m2 <= size_max_m2),
  CHECK (status NOT IN ('active','visit_scheduled','viewing_done','offer','negotiating','near_close') OR
    ((length(trim(COALESCE(next_action,''))) > 0 AND next_followup_at IS NOT NULL) OR length(trim(COALESCE(no_followup_reason,''))) > 0)),
  CHECK (status != 'won' OR closed_at IS NOT NULL),
  CHECK (status != 'lost' OR (closed_at IS NOT NULL AND loss_reason IS NOT NULL))
);

INSERT INTO crm_opportunities (
  id, contact_id, conversation_id, lead_label, city, area_label, intent, source, source_url,
  status, track, budget_min, budget_max, size_min_m2, size_max_m2, property_type, notes,
  next_action, next_followup_at, no_followup_reason, closed_at, loss_reason, loss_notes, created_at, updated_at
)
SELECT
  b.id,
  b.contact_id,
  (SELECT co.id FROM _mig0006_conv_opp co WHERE co.opportunity_id = b.id LIMIT 1),
  COALESCE((SELECT c.name FROM crm_contacts c WHERE c.id = b.contact_id), ''),
  b.city, b.area_label, b.intent, b.source, b.source_url,
  b.status, b.track, b.budget_min, b.budget_max, b.size_min_m2, b.size_max_m2, b.property_type, b.notes,
  b.next_action, b.next_followup_at, b.no_followup_reason, b.closed_at, b.loss_reason, b.loss_notes, b.created_at, b.updated_at
FROM _mig0006_opps_bak b;

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_followup ON crm_opportunities(status, next_followup_at);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_contact ON crm_opportunities(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_track ON crm_opportunities(track, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_conversation ON crm_opportunities(conversation_id);

CREATE TABLE crm_activities (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('call','missed_call','whatsapp_note','visit','offer','objection','note','status_change')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0 AND length(summary) <= 1200),
  outcome TEXT NOT NULL DEFAULT '',
  next_action TEXT,
  next_followup_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  full_text TEXT,
  source_ref TEXT NOT NULL DEFAULT '',
  original_sent_at TEXT,
  external_links_json TEXT NOT NULL DEFAULT '[]',
  conversation_id TEXT
);

INSERT INTO crm_activities (
  id, opportunity_id, activity_type, summary, outcome, next_action, next_followup_at,
  created_at, full_text, source_ref, original_sent_at, external_links_json, conversation_id
)
SELECT
  id, opportunity_id, activity_type, summary, outcome, next_action, next_followup_at,
  created_at, full_text, source_ref, original_sent_at, external_links_json, conversation_id
FROM _mig0006_activities_bak;

CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity ON crm_activities(opportunity_id, created_at DESC);

CREATE TABLE crm_opportunity_properties (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  presentation_status TEXT NOT NULL DEFAULT 'presented' CHECK (presentation_status IN ('presented','viewing_scheduled','viewed','offer_made','negotiating','rejected','selected')),
  presented_price REAL CHECK (presented_price IS NULL OR presented_price >= 0),
  viewing_at TEXT,
  viewing_result TEXT NOT NULL DEFAULT '',
  objection_reason TEXT CHECK (objection_reason IS NULL OR objection_reason IN ('price','location','size','financing','timing','no_response','other')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO crm_opportunity_properties (
  id, opportunity_id, listing_id, presentation_status, presented_price,
  viewing_at, viewing_result, objection_reason, notes, created_at
)
SELECT
  id, opportunity_id, listing_id, presentation_status, presented_price,
  viewing_at, viewing_result, objection_reason, notes, created_at
FROM _mig0006_opp_props_bak;

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_properties_listing ON crm_opportunity_properties(listing_id);

CREATE TABLE crm_smart_alerts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES crm_conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES crm_conversation_messages(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
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

INSERT INTO crm_smart_alerts (
  id, conversation_id, message_id, contact_id, opportunity_id,
  dedupe_conversation_key, dedupe_message_key, dedupe_contact_key,
  alert_type, status, priority, customer_name, alert_reason, source_message_at,
  excerpt, suggested_action, confidence, due_at, snoozed_until, due_precision,
  date_origin, metadata_json, rule_version, resolved_at, resolution_note,
  resolved_by_activity_id, push_sent_at, created_at, updated_at
)
SELECT
  id, conversation_id, message_id, contact_id, opportunity_id,
  dedupe_conversation_key, dedupe_message_key, dedupe_contact_key,
  alert_type, status, priority, customer_name, alert_reason, source_message_at,
  excerpt, suggested_action, confidence, due_at, snoozed_until, due_precision,
  date_origin, metadata_json, rule_version, resolved_at, resolution_note,
  resolved_by_activity_id, push_sent_at, created_at, updated_at
FROM _mig0006_alerts_bak;

CREATE INDEX IF NOT EXISTS idx_crm_smart_alerts_status_due
  ON crm_smart_alerts(status, due_at ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_smart_alerts_contact
  ON crm_smart_alerts(contact_id, status, updated_at DESC);

UPDATE crm_conversations
SET opportunity_id = (SELECT co.opportunity_id FROM _mig0006_conv_opp co WHERE co.id = crm_conversations.id)
WHERE id IN (SELECT id FROM _mig0006_conv_opp);

UPDATE crm_conversation_insights
SET opportunity_id = (SELECT io.opportunity_id FROM _mig0006_ins_opp io WHERE io.id = crm_conversation_insights.id)
WHERE id IN (SELECT id FROM _mig0006_ins_opp);

CREATE TABLE _mig0006_audit_bak AS SELECT * FROM crm_contact_audit_log;
DROP TABLE crm_contact_audit_log;

CREATE TABLE crm_contact_audit_log (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'name_updated',
    'consent_changed',
    'phone_added',
    'phone_updated',
    'phone_deleted',
    'primary_phone_changed',
    'phone_conflict_resolved',
    'conversation_linked',
    'source_synced',
    'contact_archived',
    'contact_unarchived',
    'contact_deleted_detached'
  )),
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source_ref TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO crm_contact_audit_log (
  id, contact_id, action_type, field_name, old_value, new_value, source_ref, actor, created_at
)
SELECT
  id, contact_id, action_type, field_name, old_value, new_value, source_ref, actor, created_at
FROM _mig0006_audit_bak;

CREATE INDEX IF NOT EXISTS idx_crm_contact_audit_contact
  ON crm_contact_audit_log(contact_id, created_at DESC);

DROP TABLE _mig0006_conv_opp;
DROP TABLE _mig0006_ins_opp;
DROP TABLE _mig0006_alerts_bak;
DROP TABLE _mig0006_activities_bak;
DROP TABLE _mig0006_opp_props_bak;
DROP TABLE _mig0006_opps_bak;
DROP TABLE _mig0006_audit_bak;
