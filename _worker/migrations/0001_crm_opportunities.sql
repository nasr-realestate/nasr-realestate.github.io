-- Additive CRM schema intended for a separate, synthetic-data test D1.
-- Creates crm_* tables only. It does not alter listings, valuation, ingestion,
-- areas, or synchronization tables. Never apply to production; complete isolated
-- D1 and Access tests first.

-- A customer is the person/business record. Phone numbers are separate contact
-- methods so one customer can have several numbers and one number cannot silently
-- belong to two customers.
CREATE TABLE IF NOT EXISTS crm_contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  communication_consent TEXT NOT NULL DEFAULT 'request_only'
    CHECK (communication_consent IN ('request_only','marketing_yes','do_not_contact')),
  consent_captured_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_contact_phones (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  phone_key TEXT NOT NULL UNIQUE CHECK (length(phone_key) BETWEEN 7 AND 15 AND phone_key NOT GLOB '*[^0-9]*'),
  label TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contact_primary_phone
  ON crm_contact_phones(contact_id) WHERE is_primary=1;

CREATE TABLE IF NOT EXISTS crm_opportunities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  city TEXT NOT NULL DEFAULT 'مدينة نصر' CHECK (city = 'مدينة نصر'),
  area_label TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL CHECK (intent IN ('buy','rent','sell','lease','other')),
  source TEXT NOT NULL CHECK (source IN ('call','missed_call','referral','website','whatsapp','other')),
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','visit_scheduled','viewing_done','offer','negotiating','near_close','won','lost','paused','unqualified')),
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

CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('call','missed_call','whatsapp_note','visit','offer','objection','note','status_change')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0 AND length(summary) <= 1200),
  outcome TEXT NOT NULL DEFAULT '',
  next_action TEXT,
  next_followup_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_opportunity_properties (
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

CREATE TABLE IF NOT EXISTS crm_idempotency_receipts (
  submission_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('contact','opportunity')),
  resource_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_followup ON crm_opportunities(status, next_followup_at);
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_contact ON crm_opportunities(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity ON crm_activities(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_opportunity_properties_listing ON crm_opportunity_properties(listing_id);
CREATE INDEX IF NOT EXISTS idx_crm_phones_contact ON crm_contact_phones(contact_id, is_primary DESC, created_at);
