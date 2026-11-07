/**
 * The seven days — a request is perishable, a name is not.
 *
 * He put a request on the site with a seven-day life, because a buyer who wants
 * a 4M flat in Nasr City this week is not the same man in three weeks: either he
 * found something, or he found someone else. The window is not a marketing rule,
 * it is the physical half-life of the demand.
 *
 * So the mark ✈️ alone cannot decide anything. Two things are true at once:
 *
 *   - inside the window, a passer-by is the most urgent call of the day;
 *   - after it, he is a name in the book, never again a live request.
 *
 * Recomputing this later is possible — the timestamps are stored — but acting
 * later is not: a request that expired unmet cannot be served, only re-asked.
 *
 * Everything here is pure: `now` is passed in.
 */

export const REQUEST_WINDOW_DAYS = 7;
const DAY = 86_400_000;

/** The last two days of the window are the ones where silence costs the deal. */
export const CLOSING_DAYS_LEFT = 2;

/**
 * States, in the order they occur:
 *   fresh    — the request is alive and has room
 *   closing  — alive, and this is the last chance to answer it
 *   met      — an offer went out inside the window: he graduates
 *   expired  — the window shut with no offer: ask again, never pitch again
 */
export function requestState({ askedAt, servedAt = null, now }) {
  const asked = Date.parse(askedAt);
  if (Number.isNaN(asked)) return { state: 'unknown', daysLeft: null, elapsed: null, why: null };

  const elapsed = Math.floor((Date.parse(now) - asked) / DAY);
  const deadline = asked + REQUEST_WINDOW_DAYS * DAY;

  if (servedAt) {
    const served = Date.parse(servedAt);
    if (!Number.isNaN(served) && served <= deadline) {
      return { state: 'met', daysLeft: 0, elapsed, why: 'offer-inside-window' };
    }
  }
  if (elapsed < 0) return { state: 'fresh', daysLeft: REQUEST_WINDOW_DAYS, elapsed, why: 'not-started' };

  const daysLeft = Math.max(0, Math.ceil((deadline - Date.parse(now)) / DAY));
  if (daysLeft === 0) return { state: 'expired', daysLeft: 0, elapsed, why: 'window-closed-unmet' };
  if (daysLeft <= CLOSING_DAYS_LEFT) return { state: 'closing', daysLeft, elapsed, why: 'last-chance' };
  return { state: 'fresh', daysLeft, elapsed, why: 'alive' };
}

/**
 * What the broker is allowed to do today, in his own language.
 *
 * A live request is a pitch. An expired one is a question — "هل ما زلت تبحث؟" —
 * and the difference is the whole reason this file exists: pitching a man whose
 * window shut two months ago is how a broker becomes noise in his phone.
 */
export function requestAction({ state }) {
  switch (state) {
    case 'fresh': return 'اعرض عليه الآن — الطلب حيّ';
    case 'closing': return 'آخر فرصة — اعرض اليوم أو سيذهب لغيرك';
    case 'met': return 'خُدم داخل النافذة — رشّحه للتأهيل';
    case 'expired': return 'انتهت نافذته — اسأله: هل ما زلت تبحث؟ ولا تعرض';
    default: return 'تاريخ غير معروف — تحقّق قبل أي اتصال';
  }
}

/**
 * Graduation, not colouring.
 *
 * A passer-by becomes a client when two things are true together — that is what
 * separates a real buyer from a name that passed by:
 *
 *   1. he has a number (else there is nothing to call);
 *   2. something was exchanged: an offer went out and he answered, or he asked
 *      twice. One unanswered message is not a relationship.
 *
 * The colour itself is the owner's decision and is deliberately not chosen here.
 */
export function isReadyToGraduate({ hasNumber, servedInWindow, requests = 1, repliedAfterOffer = false }) {
  if (!hasNumber) return false;
  if (servedInWindow && repliedAfterOffer) return true;
  return requests >= 2;
}
