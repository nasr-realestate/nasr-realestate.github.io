-- 0013_crm_interactions_and_followups.sql — A5 (ج/d): سجل تفاعلات موحَّد وإدارة متابعات.
--
-- WHY THIS EXISTS (measured, not assumed):
-- The timeline today is spread over `crm_conversation_messages` (0005), `crm_contact_audit_log` (0005/0006)
-- and `crm_activities` (0001/0006), and a follow-up is not a row at all: it is `crm_opportunities.next_followup_at`
-- plus a computed alert list (`/api/followups` reads `crm_smart_alerts`). That is enough to nag a broker, and
-- not enough to answer "who must be called today, for which request, and what was the outcome". There was no
-- `crm_interactions` table (verified against `_worker/migrations/*.sql`).
--
-- DESIGN DECISIONS A READER SHOULD SEE:
--   * append-only. A recorded interaction is evidence; editing or deleting it is refused (0011 sets the
--     precedent with `file_review_anchors_are_append_only`).
--   * legacy rows are LINKED, never copied or rewritten: `legacy_ref_table` + `legacy_ref_id` point at the
--     original row, and a partial UNIQUE index makes each source row linkable exactly once. So importing the
--     old conversations twice cannot double the timeline, and no old message is edited by this file.
--   * replay safety again by `dedupe_key UNIQUE`, so the same POST from the UI is a no-op, not a second event.
--   * a follow-up is bound to a customer AND to a request or an opportunity — a floating reminder is refused.
--   * nothing here auto-creates a follow-up and nothing infers continued interest: `no_interest` must be
--     written by a human with an outcome.
--
-- Ordering: 0012 first (it owns `crm_customer_requests` and `crm_operational_audit_log`).

CREATE TABLE IF NOT EXISTS crm_interactions (
  id             TEXT    NOT NULL PRIMARY KEY
                 CHECK (length(id) BETWEEN 8 AND 80 AND id NOT GLOB '*[^0-9a-zA-Z_-]*'),
  contact_id     TEXT    NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  request_id     TEXT    REFERENCES crm_customer_requests(id) ON DELETE RESTRICT,
  opportunity_id TEXT    REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  -- الأنواع المطلوبة في A5، بحروفها.
  kind           TEXT    NOT NULL CHECK (kind IN
                   ('call', 'whatsapp', 'conversation', 'followup', 'viewing', 'meeting',
                    'note', 'status_change')),
  occurred_at    TEXT    NOT NULL CHECK (datetime(occurred_at) IS NOT NULL),
  summary        TEXT    NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  -- نتيجة التواصل والخطوة التالية (البند المطلوب في A5-ج).
  outcome        TEXT    CHECK (outcome IS NULL OR (length(outcome) BETWEEN 1 AND 500 AND outcome = trim(outcome))),
  next_step      TEXT    CHECK (next_step IS NULL OR (length(next_step) BETWEEN 1 AND 500 AND next_step = trim(next_step))),
  next_followup_at TEXT  CHECK (next_followup_at IS NULL OR datetime(next_followup_at) IS NOT NULL),
  source         TEXT    NOT NULL CHECK (source IN ('manual', 'phone', 'whatsapp', 'import', 'drive', 'system')),
  created_by     TEXT    NOT NULL CHECK (length(created_by) BETWEEN 2 AND 120
                                         AND created_by = trim(created_by)),
  -- ربط مرجعي آمن بالسجلات القديمة؛ لا نسخة ولا تعديل للمصدر.
  legacy_ref_table TEXT  CHECK (legacy_ref_table IS NULL OR legacy_ref_table IN
                                  ('crm_conversation_messages', 'crm_contact_audit_log', 'crm_activities')),
  legacy_ref_id    TEXT  CHECK (legacy_ref_id IS NULL OR length(legacy_ref_id) BETWEEN 1 AND 80),
  dedupe_key       TEXT  NOT NULL UNIQUE
                     CHECK (length(dedupe_key) BETWEEN 16 AND 64 AND dedupe_key NOT GLOB '*[^0-9a-f]*'),
  created_at       TEXT  NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  CHECK ((legacy_ref_table IS NULL) = (legacy_ref_id IS NULL)),
  -- تفاعل بلا طلب ولا فرصة مسموح (مكالمة عامة/ملاحظة)، لكنه لا يكون أبدًا بلا عميل: الحقل NOT NULL أعلاه.
  CHECK (legacy_ref_table IS NULL OR source = 'import')
);

CREATE INDEX IF NOT EXISTS idx_crm_interaction_timeline
  ON crm_interactions(contact_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_crm_interaction_request
  ON crm_interactions(request_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_interaction_opportunity
  ON crm_interactions(opportunity_id, occurred_at DESC);
-- كل صف مصدرى يُربَط مرة واحدة فقط: إعادة الاستيراد لا تُضاعف الخط الزمني.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interaction_legacy_once
  ON crm_interactions(legacy_ref_table, legacy_ref_id) WHERE legacy_ref_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_crm_interaction_append_only
  BEFORE UPDATE ON crm_interactions
BEGIN
  SELECT RAISE(ABORT, 'interactions_are_append_only');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_interaction_no_delete
  BEFORE DELETE ON crm_interactions
BEGIN
  SELECT RAISE(ABORT, 'interactions_are_append_only');
END;
-- نوع التفاعل لا يُعاد تعريفه بعد الكتابة (منع "إعادة تصنيف" تُخفي سجلًا).
CREATE TRIGGER IF NOT EXISTS trg_crm_interaction_kind_immutable
  BEFORE UPDATE OF kind, contact_id, occurred_at, dedupe_key ON crm_interactions
BEGIN
  SELECT RAISE(ABORT, 'interaction_identity_is_immutable');
END;

CREATE TABLE IF NOT EXISTS crm_followups (
  id             TEXT    NOT NULL PRIMARY KEY
                 CHECK (length(id) BETWEEN 8 AND 80 AND id NOT GLOB '*[^0-9a-zA-Z_-]*'),
  contact_id     TEXT    NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  request_id     TEXT    REFERENCES crm_customer_requests(id) ON DELETE RESTRICT,
  opportunity_id TEXT    REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  due_at         TEXT    NOT NULL CHECK (datetime(due_at) IS NOT NULL),
  status         TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done', 'cancelled', 'missed')),
  outcome        TEXT    CHECK (outcome IS NULL OR (length(outcome) BETWEEN 1 AND 500 AND outcome = trim(outcome))),
  completed_at   TEXT    CHECK (completed_at IS NULL OR datetime(completed_at) IS NOT NULL),
  reason         TEXT    CHECK (reason IS NULL OR (length(reason) BETWEEN 3 AND 500 AND reason = trim(reason))),
  created_by     TEXT    NOT NULL CHECK (length(created_by) BETWEEN 2 AND 120
                                         AND lower(created_by) NOT IN
                                           ('auto','system','agent','ai','bot','unknown','none','na','-')),
  dedupe_key     TEXT    NOT NULL UNIQUE
                 CHECK (length(dedupe_key) BETWEEN 16 AND 64 AND dedupe_key NOT GLOB '*[^0-9a-f]*'),
  created_at     TEXT    NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  -- متابعة بلا طلب ولا فرصة = صف عائم؛ مرفوض.
  CHECK (request_id IS NOT NULL OR opportunity_id IS NOT NULL),
  CHECK (status <> 'done' OR (outcome IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status = 'pending' OR completed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR reason IS NOT NULL)
);

-- متابعة مفتوحة واحدة لنفس الهدف: إعادة الضغط على الزر لا تُنشئ موعدين.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_followup_open_target
  ON crm_followups(COALESCE(request_id, ''), COALESCE(opportunity_id, '')) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crm_followup_due
  ON crm_followups(status, due_at);

-- إغلاق المتابعة forward-only: لا إعادة فتح سجل مُغلق، ولا تغيير لموعد متابعة مُنجزة.
CREATE TRIGGER IF NOT EXISTS trg_crm_followup_transition_forward
  BEFORE UPDATE OF status ON crm_followups
  WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'followup_is_already_final');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_followup_identity_immutable
  BEFORE UPDATE OF contact_id, request_id, opportunity_id, dedupe_key, created_at ON crm_followups
BEGIN
  SELECT RAISE(ABORT, 'followup_identity_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_followup_no_delete
  BEFORE DELETE ON crm_followups
  WHEN OLD.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'open_followup_cannot_be_deleted');
END;

-- إنجاز المتابعة يترك أثرًا في الخط الزمني بقوة القاعدة لا بحسن نية المُشغِّل: صف `followup` واحد لكل
-- متابعة مُنجزة، بنفس dedupe_key، فلا يمكن أن يُنجز أحدهم المتابعة مرتين أو يُسجّلها دون أثر.
CREATE TRIGGER IF NOT EXISTS trg_crm_followup_done_records_interaction
  AFTER UPDATE OF status ON crm_followups
  WHEN NEW.status = 'done'
BEGIN
  INSERT INTO crm_interactions (id, contact_id, request_id, opportunity_id, kind, occurred_at,
                                summary, outcome, source, created_by, dedupe_key, created_at)
  VALUES ('fu-' || substr(hex(randomblob(9)), 1, 10), NEW.contact_id, NEW.request_id, NEW.opportunity_id,
          'followup', NEW.completed_at,
          'متابعة مُنجزة (' || NEW.id || ')', NEW.outcome, 'manual', NEW.created_by, NEW.dedupe_key,
          datetime('now'));
END;

-- قوائم العمل (قراءة فقط، لا تكتب شيئًا):
--   1) متابعات مستحقة/متأخرة    2) عملاء بلا تواصل lately   3) فرص بلا تواصل منذ فترة
CREATE VIEW IF NOT EXISTS crm_followups_queue_v AS
SELECT f.id, f.contact_id, f.request_id, f.opportunity_id, f.due_at, f.created_by,
       CASE WHEN datetime(f.due_at) < datetime('now', '+2 hours') THEN 'overdue' ELSE 'due' END AS bucket,
       strftime('%s', datetime('now', '+2 hours')) - strftime('%s', datetime(f.due_at)) AS overdue_seconds
  FROM crm_followups f
 WHERE f.status = 'pending';

-- الفرص التي لم يحدث عليها تواصل منذ فترة (الخط الزمني الموحَّد هو المرجع، لا حقول الفرصة وحدها).
CREATE VIEW IF NOT EXISTS crm_stale_opportunities_v AS
SELECT o.id AS opportunity_id, o.contact_id, o.status, o.next_followup_at,
       (SELECT MAX(i.occurred_at) FROM crm_interactions i WHERE i.opportunity_id = o.id) AS last_interaction_at,
       CAST((julianday('now', '+2 hours') - julianday(COALESCE(
              (SELECT MAX(i.occurred_at) FROM crm_interactions i WHERE i.opportunity_id = o.id),
              o.updated_at))) * 24 * 60 AS INTEGER) / 1440 AS days_silent
  FROM crm_opportunities o
 WHERE o.status NOT IN ('won', 'lost');   -- مفردات crm_opportunities status الفعلية من 0006، لا مفردات مخترعة

-- طلب نشط لم يصل إلى عقار مؤكَّد (البند "طلبات لم يتم الوصول إلى عقار مناسب لها").
CREATE VIEW IF NOT EXISTS crm_requests_unmatched_v AS
SELECT r.id AS request_id, r.contact_id, r.kind, r.property_type, r.area, r.status,
       r.created_at, r.updated_at,
       (SELECT COUNT(*) FROM crm_request_listing_link l
         WHERE l.request_id = r.id AND l.state = 'confirmed') AS confirmed_links,
       (SELECT MAX(i.occurred_at) FROM crm_interactions i WHERE i.request_id = r.id) AS last_interaction_at
  FROM crm_customer_requests r
 WHERE r.status IN ('new', 'active');

-- مراحل الفرص وأسباب التوقف/الإغلاق، كما هي مخزَّنة (لا استنتاج).
CREATE VIEW IF NOT EXISTS crm_opportunity_stages_v AS
SELECT o.id AS opportunity_id, o.contact_id, o.status, o.track,
       o.next_action, o.next_followup_at, o.no_followup_reason, o.updated_at,
       (SELECT COUNT(*) FROM crm_opportunity_properties p WHERE p.opportunity_id = o.id) AS linked_properties,
       (SELECT COUNT(*) FROM crm_interactions i WHERE i.opportunity_id = o.id AND i.kind = 'viewing') AS viewings
  FROM crm_opportunities o;
