-- Additive 5-track operational core for Nasr City CRM (isolated test D1 only):
--   sale_apt      -> 🟢 شقق للبيع
--   furnished_apt -> 🔴 شقق مفروشة
--   new_rent_apt  -> 🔵 شقق للإيجار الجديد
--   admin_hq      -> 🟡 مقرات ومكاتب إدارية وتجارية
--   transient     -> ✈️ طيارة (عميل عابر / أرشيف خارج المتابعات اليومية)

ALTER TABLE crm_opportunities
  ADD COLUMN track TEXT NOT NULL DEFAULT 'sale_apt'
  CHECK (track IN ('sale_apt', 'furnished_apt', 'new_rent_apt', 'admin_hq', 'transient'));

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_track
  ON crm_opportunities(track, status, updated_at DESC);
