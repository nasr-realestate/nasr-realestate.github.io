/**
 * The seven-day window, attached to the request rows that already exist.
 *
 * `crm_customer_requests` (0012) stores a want with a status the broker owns:
 * new, active, paused, closed, cancelled. What it does not store — on purpose —
 * is an expiry. The site gives a request seven days of life, but that is a clock,
 * not a state: the broker may still close or pause the file afterwards.
 *
 * Deriving it here rather than adding a column keeps three promises at once:
 *   * no table rebuild, no migration, no backfill;
 *   * the row's own history is untouched, so an expired request is still a row;
 *   * one definition of the window, shared with the importer and the morning list.
 *
 * Opt-in by `with_window=1`: the default payload stays exactly as it was, so no
 * existing caller or test changes behaviour by accident.
 */
import { requestState, requestAction, REQUEST_WINDOW_DAYS } from '../scripts/crm/request-window.mjs';

/** A closed or cancelled file has no window: the decision was already taken. */
const SETTLED = new Set(['closed', 'cancelled']);

export function decorateRequest(request, nowIso) {
  if (!request || typeof request !== 'object') return request;
  if (SETTLED.has(String(request.status || ''))) {
    return { ...request, window: { state: 'settled', days_left: null, action: 'ملف مغلق — لا نافذة' } };
  }
  const win = requestState({ askedAt: request.created_at, servedAt: null, now: nowIso });
  return {
    ...request,
    window: {
      state: win.state,
      days_left: win.daysLeft,
      elapsed_days: win.elapsed,
      window_days: REQUEST_WINDOW_DAYS,
      action: requestAction({ state: win.state }),
    },
  };
}

/** Decorate a list payload without changing its shape or its order. */
export function withWindows(payload, nowIso) {
  if (!payload || !Array.isArray(payload.requests)) return payload;
  return { ...payload, requests: payload.requests.map((r) => decorateRequest(r, nowIso)) };
}
