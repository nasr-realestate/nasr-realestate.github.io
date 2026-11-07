/**
 * The date engine — the spine of the CRM.
 *
 * Two laws, and nothing else in this file matters as much as them:
 *
 *   1. No touch without a next date.
 *   2. No next date without a reason.
 *
 * Law 1 is what stops a client being lost. Law 2 is what stops the system
 * becoming the thing that loses him: a broker who keeps messaging a 10M
 * buyer with nothing new to say loses the buyer AND the reputation his whole
 * business runs on. So a date is only allowed to fire when it can point at
 * something real — a matching property, a promised viewing, a report to an
 * owner, or an honest question that closes the file.
 *
 * Everything here is pure: no clock, no network, no database. `today` is
 * always passed in, so the behaviour is testable and the same on every machine.
 */

/** A week is the unit a broker actually thinks in, so gaps are in days. */
export const DAY = 86_400_000;

/**
 * Each state answers three questions:
 *   - gap:   after how many days do we come back?
 *   - why:   what is the only honest reason to come back?
 *   - after: how many unanswered attempts before we stop trying?
 *
 * Cadence is tuned for 5–10M units: the cycle runs weeks to months, so a
 * 2-day rhythm is the right pace only immediately after a viewing. Chasing
 * hard early and going quiet later is how a broker looks desperate and then
 * forgetful — we do the opposite.
 */
export const STATES = {
  'new-inquiry': {
    label: 'سأل للتو',
    gap: 2,
    why: 'offer-match',
    after: 3,
  },
  'viewing-booked': {
    label: 'موعد معاينة',
    gap: 0, // due on the appointment day itself, not N days later
    why: 'confirm-appointment',
    after: 2,
  },
  viewed: {
    label: 'شاف وعجبه',
    gap: 2,
    why: 'offer-match',
    after: 3,
  },
  considering: {
    label: 'بيفكر / بيسأل أهله',
    gap: 5,
    why: 'nudge-decision',
    after: 3,
  },
  'no-match': {
    label: 'باحث جاد بلا عقار مطابق',
    gap: 7,
    why: 'ask-still-looking',
    after: 3,
  },
  'owner-listing': {
    label: 'مالك عقار معروض',
    gap: 7,
    why: 'report-views',
    after: 4,
  },
  closing: {
    label: 'عربون / عقد',
    gap: 1,
    why: 'move-paperwork',
    after: 5,
  },
  'closed-won': {
    label: 'تمت',
    gap: 3, // thank + ask for a referral while the happiness is fresh
    why: 'thank-and-ask-referral',
    after: 2,
  },
  'not-now': {
    label: 'مش دلوقتي',
    gap: 45,
    why: 'ask-still-looking',
    after: 2,
  },
};

/** States that end the relationship; no date is ever produced for them. */
export const TERMINAL = new Set(['dormant', 'lost']);

/**
 * The reasons, ordered by how much they justify interrupting someone.
 * Higher wins when two clients fall due on the same day and the day is capped.
 */
export const WHY_PRIORITY = [
  'move-paperwork',
  'confirm-appointment',
  'offer-match',
  'nudge-decision',
  'report-views',
  'thank-and-ask-referral',
  'ask-still-looking',
];

/**
 * The reason a follow-up can fire. `ask-still-looking` is the weakest and is
 * the only one that may be *suppressed* — see `nextDate`.
 *
 * `hasNewProperty` is the broker's own fact: a property entered or re-priced
 * since the last touch that matches the client's need. If it is false we do
 * not invent an offer, because a 10M buyer who is told about a flat that does
 * not exist is gone for good.
 */
export function nextDate({ state, from, attempts = 0, hasNewProperty = false }) {
  if (TERMINAL.has(state)) return { state, at: null, why: null };
  const spec = STATES[state];
  if (!spec) throw new Error(`unknown-state:${state}`);

  // Unanswered attempts erode the right to come back.
  if (attempts >= spec.after) return { state: 'dormant', at: null, why: null };

  const lastTouch = toMs(from);

  // An appointment is a date, not an interval: it falls due on the day itself.
  if (spec.gap === 0) return { state, at: iso(startOfDay(lastTouch)), why: spec.why };

  let why = spec.why;
  let gap = spec.gap;

  // Law two: without a matching property there is no offer to make, so the
  // reason weakens and the gap widens. We never manufacture the offer.
  if (why === 'offer-match' && !hasNewProperty) {
    why = 'ask-still-looking';
    gap = 3;
  }

  // Each ignored nudge stretches the next gap instead of repeating it:
  // 5 → 8 → 13 days, and after the state's allowance, dormant.
  gap = Math.max(1, Math.round(gap * 1.6 ** attempts));

  return { state, at: iso(lastTouch + gap * DAY), why };
}

/**
 * Bucket one due client against today.
 * `overdue` is the bucket that actually matters: it is the list of people
 * who are waiting on a promise the broker already made.
 */
export function bucketOf(dueAt, today) {
  if (!dueAt) return 'none';
  const d = startOfDay(toMs(dueAt));
  const t = startOfDay(toMs(today));
  if (d < t) return 'overdue';
  if (d === t) return 'today';
  return 'upcoming';
}

/**
 * The day's list.
 *
 * The cap is not a technical limit, it is a behavioural one: a list of 60 is
 * read as zero. A broker with a handful of 5–10M clients can send 7 honest
 * messages a day; anything beyond that turns into copy-paste, which the client
 * can smell. So we cap, and we cap by reason — paperwork and appointments
 * first, "still looking?" last.
 */
export function buildDayList(clients, today, { cap = 7 } = {}) {
  const scored = [];

  for (const c of clients) {
    const bucket = bucketOf(c.due_at, today);
    if (bucket === 'none' || bucket === 'upcoming') continue;

    const why = c.why ?? STATES[c.state]?.why ?? null;
    if (!why) continue;

    // A weak reason is not allowed to fire on an overdue pile-up; it waits
    // until the day has room. Paperwork never waits.
    scored.push({
      id: c.id,
      name: c.name,
      state: c.state,
      why,
      bucket,
      due_at: c.due_at,
      days_late: daysBetween(c.due_at, today),
      priority: WHY_PRIORITY.length - WHY_PRIORITY.indexOf(why),
    });
  }

  scored.sort((a, b) => {
    // Overdue before today, then the strongest reason, then the longest wait.
    // A contract due today outranks a three-week-old "still looking?". Only
    // when the reasons weigh the same does "who has waited longest" decide.
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.bucket !== b.bucket) return a.bucket === 'overdue' ? -1 : 1;
    return b.days_late - a.days_late;
  });

  const chosen = scored.slice(0, cap);
  return {
    items: chosen,
    held_back: scored.length - chosen.length,
    counts: {
      overdue: scored.filter((s) => s.bucket === 'overdue').length,
      today: scored.filter((s) => s.bucket === 'today').length,
    },
  };
}

/** Days from a to b, both clamped to midnight so a partial day never rounds. */
export function daysBetween(a, b) {
  return Math.round((startOfDay(toMs(b)) - startOfDay(toMs(a))) / DAY);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`bad-date:${value}`);
  return ms;
}

function startOfDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
