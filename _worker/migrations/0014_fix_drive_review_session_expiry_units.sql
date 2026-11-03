-- 0014_fix_drive_review_session_expiry_units.sql
--
-- What this fixes, in one sentence: the two database barriers that ask "is this session live right now?"
-- were comparing `crm_sessions.expires_at` in the wrong unit, so no real session could ever satisfy them
-- and every Drive-review decision except the explicitly exempt `noted` was refused with 403
-- `session_not_live` (`file_review_decision_session_not_live`), while the same defect made a 0009 review
-- event impossible for the same reason.
--
-- The measurement, from the deployed code path (not from a reading of it):
--   * `_worker/crm-worker.js` writes `expires_at = now + ttlSeconds` where `now = Math.floor(Date.now()/1000)`
--     → epoch SECONDS. A live session in the test database measured: created_at=1793711001,
--     expires_at=1793739801 (TTL 8h), while the triggers required `expires_at > 1793711001000`.
--   * `0002_crm_internal_auth.sql` declares `expires_at INTEGER` with no unit, and its own CHECK
--     (`expires_at > created_at`) is unit-agnostic — so the storage side was never wrong; the comparison was.
--
-- The fix is the narrowest one available: recreate exactly those two triggers with the comparison expressed
-- in the unit the sessions table actually holds. No migration is edited, no session storage unit changes,
-- no authentication / CSRF / Origin behaviour changes, and no barrier is lowered:
--   * `token_hash` must still match the inserted row's `session_hash`;
--   * `revoked_at IS NULL` is still required — a revoked session is still refused;
--   * `expires_at > strftime('%s','now')` is still required — an expired session is still refused;
--   * the `noted` exemption in 0011 §3.7 is kept exactly as written, so `noted` (and `link_proposed`, which
--     is not exempt before this change and is not exempt after it in its own right) keeps its current shape;
--   * every append-only guard, chain/snapshot digest trigger, anchor mirror, staleness guard, evidence
--     requirement and `link_applied`/`merge_authorized`/`contact_write_count` CHECK in 0009–0013 is untouched.
--
-- Deliberately NOT done here: accepting *either* unit (`OR expires_at > … * 1000`). That would let a hand
-- written row with an absurd millisecond value pass the liveness test, which is a weakening dressed up as a
-- fix. One unit, the one the writer uses, and 0002's CHECK keeps it honest.
--
-- Idempotent and safe to re-apply: DROP … IF EXISTS then CREATE, same trigger names, same bodies apart from
-- the unit, so the set of objects in `sqlite_master` is identical before and after this file runs.

-- ── (1) 0009 §5.9 — a review event must be signed by a live session ──────────────────────────────────
DROP TRIGGER IF EXISTS trg_review_event_session_live;

CREATE TRIGGER trg_review_event_session_live
  BEFORE INSERT ON crm_drive_review_event
  WHEN NOT EXISTS (SELECT 1 FROM crm_sessions s
                    WHERE s.token_hash = NEW.session_hash
                      AND s.revoked_at IS NULL
                      AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'review_event_session_not_live');
END;

-- ── (2) 0011 §3.7 — a state-changing file-review decision needs a live session (same shape, same exemption)
DROP TRIGGER IF EXISTS trg_file_review_decision_session_live;

CREATE TRIGGER trg_file_review_decision_session_live
  BEFORE INSERT ON crm_drive_file_review_decision
  WHEN NEW.decision <> 'noted'
       AND NOT EXISTS (SELECT 1 FROM crm_sessions s
                        WHERE s.token_hash = NEW.session_hash
                          AND s.revoked_at IS NULL
                          AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'file_review_decision_session_not_live');
END;
