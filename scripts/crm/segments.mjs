/**
 * The marks — the broker's own taxonomy, and the only one the CRM keeps.
 *
 * He writes an emoji in front of a name so he knows what the man is before he
 * answers the call:
 *
 *   🟢  تمليك   — a unit that changes hands, sold
 *   🔴  مفروش   — a furnished let
 *   🔵  إيجار قانون جديد
 *   🟠  محلات وإداري
 *   ✈️  عابر    — someone who passed once and may need us later
 *
 * Two promises come with every folder he drops from now on, and this file is
 * where they are written down:
 *
 *   1. Every contact carries a number. A card without one is not a client, it is
 *      a note — it is counted and reported, never silently kept.
 *   2. Every contact carries exactly one mark. Whatever is outside the five is
 *      out of scope: it stays in the database (never delete a client row) but it
 *      never reaches a morning list.
 *
 * The marks are matched anywhere in the label, because he writes them in front
 * of the name, after it, or twice (🟢 🔴 on a furnished unit he also owns). When
 * two marks appear, the first in the order above wins as the primary.
 */

/**
 * `role` is what the mark means for the conversation, which is what the date
 * engine needs: supply is serviced, a passer-by is touched lightly and rarely.
 */
export const SEGMENTS = [
  { code: '🟢', key: 'sale', label: 'تمليك', role: 'supply' },
  { code: '🔴', key: 'furnished', label: 'مفروش', role: 'supply' },
  { code: '🔵', key: 'rent', label: 'إيجار قانون جديد', role: 'supply' },
  { code: '🟠', key: 'commercial', label: 'محلات وإداري', role: 'supply' },
  { code: '✈️', key: 'transient', label: 'عميل عابر', role: 'transient' },
];

/** The order above is also the precedence: the first mark found wins. */
const CODES = SEGMENTS.map((s) => s.code);

/** Variants a phone keyboard produces for the same mark. */
const VARIANTS = {
  '✈️': ['✈️', '✈'],
  '🟢': ['🟢'],
  '🔴': ['🔴'],
  '🔵': ['🔵'],
  '🟠': ['🟠'],
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
    // Supply is serviced, a passer-by is touched lightly: the role travels with the mark.
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

/**
 * The two promises, measured instead of assumed.
 *
 * A folder is "clean" when every card has a number and a mark. The importer runs
 * this before it ships anything, so a broken drop is caught at the door rather
 * than discovered three weeks later inside a morning list.
 */
export function auditDirectory(contacts = []) {
  const seen = new Map();
  for (const c of contacts) {
    const fn = String(c?.fn || c?.name || '').trim();
    if (!fn) continue;
    const phones = (c?.phones || [])
      .map((p) => String(p?.e164 || p?.phone || '').replace(/\D/g, ''))
      .filter(Boolean);
    const seg = segmentsOf(fn);
    const entry = seen.get(fn) || { fn, phones: new Set(), marks: new Set() };
    for (const p of phones) entry.phones.add(p);
    for (const code of seg.codes) entry.marks.add(code);
    seen.set(fn, entry);
  }
  const withoutNumber = [];
  const withoutMark = [];
  for (const entry of seen.values()) {
    if (entry.phones.size === 0) withoutNumber.push(entry.fn);
    if (entry.marks.size === 0) withoutMark.push(entry.fn);
  }
  return {
    contacts: seen.size,
    with_number: seen.size - withoutNumber.length,
    marked: seen.size - withoutMark.length,
    without_number: withoutNumber,
    without_mark: withoutMark,
    clean: withoutNumber.length === 0 && withoutMark.length === 0,
  };
}
