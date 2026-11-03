-- 0012_crm_customer_requests.sql — A5 (ب): كيان مستقل لطلب العميل العقاري.
--
-- WHY THIS EXISTS (measured against 0001..0011, not assumed):
-- Before this file a customer's *want* had no row of its own: `crm_opportunities` (0001/0006) carries the
-- broker-side pursuit, and `crm_opportunity_properties.listing_id` points at a *listed property*. So
-- "client is looking for a 3-room apartment in الأندalus up to 4M" was only expressible as an opportunity
-- glued to a specific listing, which is why `P3 live mig — rows_before_sync=99` and the request-shaped
-- counts in the phase reports always came from opportunity fields. A request and an offered property are
-- different entities; this file makes the request a first-class row and keeps the relation to a listing
-- explicit, evidenced, and reversible.
--
-- INVARIANTS THIS FILE OWNS:
--   * scope: one city, مدينة نصر, by CHECK — a request outside the service range cannot be stored.
--   * ownership: contact_id is a RESTRICT FK, so a request can never outlive or silently re-point to
--     another customer. No name/phone similarity matching exists here at all (A5 rule: عرض التعارض
--     للمراجعة، لا دمج تلقائي).
--   * replay safety: `dedupe_key` is UNIQUE, so re-sending the same create never doubles the row.
--   * history: status changes go to an append-only history table; open requests cannot be deleted.
--   * privacy: `crm_operational_audit_log` stores digests of free text, never the text, so a CI log or a
--     report cannot leak a phone number through an audit trail.
--
-- Ordering: 0001 (contacts/phones/opportunities), 0005 (audit/conversations) and 0010/0011 (drive ledger
-- and review) must be applied first. Nothing in this file mutates those tables.

CREATE TABLE IF NOT EXISTS crm_customer_requests (
  id            TEXT    NOT NULL PRIMARY KEY
                CHECK (length(id) BETWEEN 8 AND 80 AND id NOT GLOB '*[^0-9a-zA-Z_-]*'),
  contact_id    TEXT    NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
  -- طلب شراء أم طلب إيجار. لا حالة وسطى: العقار المعروض ليس طلبًا.
  kind          TEXT    NOT NULL CHECK (kind IN ('buy', 'rent')),
  property_type TEXT    NOT NULL CHECK (property_type IN
                  ('apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'office', 'shop', 'land', 'other')),
  city          TEXT    NOT NULL DEFAULT 'مدينة نصر' CHECK (city = 'مدينة نصر'),
  -- المنطقة داخل مدينة نصر، والحي الفرعي عند توفره. nullable على قصد: الطلب قد يصل قبل تحديد المنطقة.
  area          TEXT    CHECK (area IS NULL OR (length(area) BETWEEN 2 AND 80 AND area = trim(area))),
  sub_area      TEXT    CHECK (sub_area IS NULL OR (length(sub_area) BETWEEN 2 AND 80 AND sub_area = trim(sub_area))),
  rooms         INTEGER CHECK (rooms IS NULL OR (typeof(rooms) = 'integer' AND rooms BETWEEN 0 AND 12)),
  area_min_m2   REAL    CHECK (area_min_m2 IS NULL OR (area_min_m2 > 0 AND area_min_m2 <= 5000)),
  area_max_m2   REAL    CHECK (area_max_m2 IS NULL OR (area_max_m2 > 0 AND area_max_m2 <= 20000
                                       AND (area_min_m2 IS NULL OR area_max_m2 >= area_min_m2))),
  budget_min    INTEGER CHECK (budget_min IS NULL OR budget_min >= 0),
  budget_max    INTEGER CHECK (budget_max IS NULL OR (budget_max >= 0 AND (budget_min IS NULL OR budget_max >= budget_min))),
  currency      TEXT    NOT NULL DEFAULT 'EGP' CHECK (currency IN ('EGP')),
  requirements  TEXT    CHECK (requirements IS NULL OR length(requirements) <= 2000),
  -- جديد، نشط، متوقف مؤقتًا، مغلق، ملغي — بالحرف.
  status        TEXT    NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'active', 'paused', 'closed', 'cancelled')),
  -- سبب الإيقاف/الإغلاق إلزامي عند التوقف: "أسباب توقف الفرصة أو إغلاقها" مطلوبة في التقرير.
  stop_reason   TEXT    CHECK (stop_reason IS NULL OR (length(stop_reason) BETWEEN 3 AND 500 AND stop_reason = trim(stop_reason))),
  source        TEXT    NOT NULL CHECK (source IN
                  ('phone', 'whatsapp', 'walk_in', 'referral', 'website', 'facebook', 'drive_file', 'other')),
  closed_at     TEXT    CHECK (closed_at IS NULL OR datetime(closed_at) IS NOT NULL),
  -- مشتق من نية الطلب (اتصال + نوع + نوع العقار + المنطقة + نطاق الميزانية + تاريخ اليوم). لا يُخترع ولا
  -- يُعاد استخدامه لطلب مختلف؛ تكرار نفس العملية لا يُنشئ صفًا ثانيًا.
  dedupe_key    TEXT    NOT NULL UNIQUE
                CHECK (length(dedupe_key) BETWEEN 16 AND 64 AND dedupe_key NOT GLOB '*[^0-9a-f]*'),
  created_at    TEXT    NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  updated_at    TEXT    NOT NULL CHECK (datetime(updated_at) IS NOT NULL),
  CHECK (status NOT IN ('closed', 'cancelled') OR closed_at IS NOT NULL),
  CHECK (status <> 'paused' OR stop_reason IS NOT NULL)
);

-- طلب واحد مفتوح بنفس المفتاح لا يُخزَّن مرتين؛ والمفتاح نفسه يُستخدم لضمان أن إعادة الإرسال no-op.
CREATE INDEX IF NOT EXISTS idx_crm_request_contact_status
  ON crm_customer_requests(contact_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_request_queue
  ON crm_customer_requests(status, kind, area);

-- ترويسة الطلب لا تُعاد كتابتها: من يملك الطلب، وما هو، وأي مُعرّف مثبَّت. التصحيح الوحيد المسموح هو
-- إغلاق الطلب ثم فتح طلب جديد بمفتاح مختلف — وهذا مقصود لأنه يترك أثرًا.
CREATE TRIGGER IF NOT EXISTS trg_crm_request_identity_immutable
  BEFORE UPDATE OF contact_id, kind, city, dedupe_key, created_at ON crm_customer_requests
BEGIN
  SELECT RAISE(ABORT, 'customer_request_identity_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_crm_request_open_undeletable
  BEFORE DELETE ON crm_customer_requests
  WHEN OLD.status NOT IN ('closed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'open_customer_request_cannot_be_deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_crm_request_timestamp_forward
  BEFORE UPDATE OF updated_at ON crm_customer_requests
  WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'customer_request_updated_at_moved_backwards');
END;

CREATE TABLE IF NOT EXISTS crm_request_status_history (
  seq         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT    NOT NULL REFERENCES crm_customer_requests(id) ON DELETE CASCADE,
  from_status TEXT    CHECK (from_status IS NULL OR from_status IN ('new','active','paused','closed','cancelled')),
  to_status   TEXT    NOT NULL CHECK (to_status IN ('new','active','paused','closed','cancelled')),
  reason      TEXT    CHECK (reason IS NULL OR (length(reason) BETWEEN 3 AND 500 AND reason = trim(reason))),
  actor       TEXT    NOT NULL CHECK (length(actor) BETWEEN 2 AND 80),
  changed_at  TEXT    NOT NULL CHECK (datetime(changed_at) IS NOT NULL),
  CHECK (from_status IS NULL OR from_status <> to_status)
);
CREATE INDEX IF NOT EXISTS idx_crm_request_history_request
  ON crm_request_status_history(request_id, seq DESC);

-- سجل الحالة append-only: لا تعديل ولا حذف، تمامًا كسجل المراجعة في 0009/0011.
CREATE TRIGGER IF NOT EXISTS trg_crm_request_history_no_update
  BEFORE UPDATE ON crm_request_status_history
BEGIN
  SELECT RAISE(ABORT, 'request_history_is_append_only');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_request_history_no_delete
  BEFORE DELETE ON crm_request_status_history
BEGIN
  SELECT RAISE(ABORT, 'request_history_is_append_only');
END;

-- الربط بعقار معروض: علاقة موثّقة فقط. `evidence_ref` إلزامي (مرجع رسالة/ملف/مكالمة)، ولا يوجد
-- "مطابقة تلقائية" هنا: مُنشئ الربط بشر مُعرَّف، والاسماء الآلية مرفوضة كما في 0011.
CREATE TABLE IF NOT EXISTS crm_request_listing_link (
  id           TEXT    NOT NULL PRIMARY KEY
                 CHECK (length(id) BETWEEN 8 AND 80 AND id NOT GLOB '*[^0-9a-zA-Z_-]*'),
  request_id   TEXT    NOT NULL REFERENCES crm_customer_requests(id) ON DELETE CASCADE,
  listing_id   INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  evidence_ref TEXT    NOT NULL CHECK (length(evidence_ref) BETWEEN 8 AND 120
                                       AND evidence_ref = trim(evidence_ref)
                                       AND evidence_ref NOT GLOB '*[^0-9a-zA-Z_.:-]*'),
  state        TEXT    NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'confirmed', 'rejected')),
  proposed_by  TEXT    NOT NULL CHECK (length(proposed_by) BETWEEN 3 AND 120
                                       AND lower(proposed_by) NOT IN
                                         ('auto','system','agent','ai','bot','worker','cron','pipeline',
                                          'matcher','algorithm','unknown','none','na','-')),
  decided_by   TEXT    CHECK (decided_by IS NULL OR (length(decided_by) BETWEEN 3 AND 120
                                       AND lower(decided_by) NOT IN
                                         ('auto','system','agent','ai','bot','worker','cron','pipeline',
                                          'matcher','algorithm','unknown','none','na','-'))),
  created_at   TEXT    NOT NULL CHECK (datetime(created_at) IS NOT NULL),
  decided_at   TEXT    CHECK (decided_at IS NULL OR datetime(decided_at) IS NOT NULL),
  CHECK (state = 'proposed' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_request_listing_once
  ON crm_request_listing_link(request_id, listing_id);

CREATE TRIGGER IF NOT EXISTS trg_crm_request_link_identity_immutable
  BEFORE UPDATE OF request_id, listing_id, evidence_ref, proposed_by, created_at ON crm_request_listing_link
BEGIN
  SELECT RAISE(ABORT, 'request_listing_link_evidence_is_immutable');
END;

-- التأكيد قرار بشري: لا يُنتقل من proposed إلى confirmed بلا مُقرِّر مُعرَّف وبلا timestamp.
CREATE TRIGGER IF NOT EXISTS trg_crm_request_link_decision_needs_human
  BEFORE UPDATE OF state ON crm_request_listing_link
  WHEN NEW.state <> 'proposed'
       AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'request_link_decision_requires_a_named_human');
END;

-- ---------------------------------------------------------------------------
-- سجل تدقيق التشغيل: يُطبَّق على الطلبات والتفاعلات والمتابعات وقرارات المراجعة (0013 تستفيد منه).
-- لا نصّ حر هنا: ما قد يحمل رقم هاتف يُخزَّن كبصمة فقط.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_operational_audit_log (
  seq           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  entity        TEXT    NOT NULL CHECK (entity IN
                  ('customer_request', 'request_status', 'request_listing_link',
                   'interaction', 'followup', 'drive_review_decision')),
  entity_id     TEXT    NOT NULL CHECK (length(entity_id) BETWEEN 4 AND 80),
  contact_id    TEXT    REFERENCES crm_contacts(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL CHECK (length(action) BETWEEN 2 AND 48
                                        AND action = lower(action) AND action NOT GLOB '*[^a-z_]*'),
  actor         TEXT    NOT NULL CHECK (length(actor) BETWEEN 2 AND 120
                                        AND lower(actor) NOT IN
                                          ('auto','system','agent','ai','bot','unknown','none','na','-')),
  detail_sha256 TEXT    CHECK (detail_sha256 IS NULL
                                OR (length(detail_sha256) = 64 AND detail_sha256 NOT GLOB '*[^0-9a-f]*')),
  occurred_at   TEXT    NOT NULL CHECK (datetime(occurred_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_operational_audit_entity
  ON crm_operational_audit_log(entity, entity_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_crm_operational_audit_contact
  ON crm_operational_audit_log(contact_id, seq DESC);

CREATE TRIGGER IF NOT EXISTS trg_crm_operational_audit_no_update
  BEFORE UPDATE ON crm_operational_audit_log
BEGIN
  SELECT RAISE(ABORT, 'operational_audit_is_append_only');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_operational_audit_no_delete
  BEFORE DELETE ON crm_operational_audit_log
BEGIN
  SELECT RAISE(ABORT, 'operational_audit_is_append_only');
END;

-- ملاحظة: قوائم العمل (crm_requests_unmatched_v وغيرُها) تُعرَّف في 0013 بعد أن توجد
-- crm_interactions، لا هنا، حتى لا يُنشأ عرض يشير إلى جدول لم يُطبَّق بعد.
