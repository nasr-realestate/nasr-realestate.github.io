/**
 * The five marks — the broker's own taxonomy, and the only one the CRM keeps.
 *
 * He writes an emoji in front of a name in his phone so that he knows what the
 * man is before he answers the call. Those five marks are the business:
 * demand, supply, and the three ways a unit moves. Everything else in a phone
 * book of 1,931 numbers is people he does not work with.
 *
 * So this file is a whitelist, not a classifier: a contact outside the five is
 * not "unclassified", it is out of scope. It stays in the database (never
 * delete a client row) but it never appears on a day list.
 *
 * The marks are matched anywhere in the label, because he writes them in front
 * of the name, after it, or twice (🟢 🔴 on a furnished unit he owns).
 */

/**
 * `role` is what the mark means for the conversation, which is what the date
 * engine needs: a seeker is chased, an owner is reported to.
 */
export const SEGMENTS = [
  { code: '✈️', key: 'seeker', label: 'باحث — يشتري أو يستأجر', role: 'demand' },
  { code: '🟢', key: 'owner', label: 'مالك — يعرض وحدة للبيع', role: 'supply' },
  { code: '🔵', key: 'rent', label: 'إيجار قانون جديد', role: 'supply' },
  { code: '🟠', key: 'commercial', label: 'محلات وإداري', role: 'supply' },
  { code: '🔴', key: 'furnished', label: 'مفروش', role: 'supply' },
];

/** The order above is also the precedence: the first mark found wins. */
const CODES = SEGMENTS.map((s) => s.code);

/** Variants a phone keyboard produces for the same mark. */
const VARIANTS = {
  '✈️': ['✈️', '✈'],
  '🟢': ['🟢'],
  '🔵': ['🔵'],
  '🟠': ['🟠'],
  '🔴': ['🔴'],
};

function matches(text, code) {
  return (VARIANTS[code] || [code]).some((v) => text.includes(v));
}

/**
 * Every mark in the label, in precedence order, plus the segment record for the
 * first one. `null` means: in the database, out of the working set.
 */
export function segmentsOf(label) {
  const text = String(label || '');
  const codes = CODES.filter((code) => matches(text, code));
  const primary = codes.length > 0 ? SEGMENTS.find((s) => s.code === codes[0]) : null;
  return {
    codes,
    primary,
    key: primary ? primary.key : null,
    label: primary ? primary.label : null,
    // Demand and supply are chased differently, so the role travels with the mark.
    role: primary ? primary.role : null,
    inScope: primary !== null,
  };
}

/** The straight question the rest of the system asks. */
export function isInScope(label) {
  return segmentsOf(label).inScope;
}

/**
 * A contact is in scope when its own name or any of its chat titles carries a
 * mark: he may have typed the mark once and let the phone book keep the rest.
 */
export function isContactInScope(name, chatTitles = []) {
  return isInScope(name) || chatTitles.some((t) => isInScope(t));
}
