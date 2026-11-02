// Phase 4 tooling module — WhatsApp transcript / vCard analysis used by the offline
// Drive analysis pipeline and its CI job.
//
// HARD BOUNDARIES (CRM_DATA_GOVERNANCE.md §2.2, §3, §4.2):
//  * Pure functions over bytes/strings. No filesystem, no network, no execution
//    of anything found inside a file.
//  * Every identity it emits is a one-way digest or a counter: names, phone
//    numbers, and message bodies never leave the analysis in cleartext.
//  * Never claims ownership: a phone number found *inside* message text is
//    reported as a text candidate only and is never attributed to the
//    conversation owner.
//  * Never merges two people because their names look alike.
//  * Not imported by `_worker/crm-worker.js`; no public endpoint exposes it.

import crypto from 'node:crypto';

import { normalizeInternationalPhone } from './crm-chat-intel.js';

const DIGIT_FOLD = new Map();
for (const [start, base] of [
  [0x0660, 0x30], // Arabic-Indic ٠-٩
  [0x06f0, 0x30], // Extended Arabic-Indic ۰-۹
  [0x0966, 0x30], // Devanagari
  [0xff10, 0x30], // Fullwidth ０-９
]) {
  for (let i = 0; i < 10; i += 1) {
    DIGIT_FOLD.set(start + i, String.fromCharCode(base + i));
  }
}

const TEMP_MARK = '\u2708'; // ✈ airplane marker used for temporary/unnamed contacts
const STATUS_MARKS = Object.freeze({
  '\u{1F7E2}': 'green',
  '\u{1F534}': 'red',
  '\u{1F7E0}': 'orange',
  '\u{1F535}': 'blue',
  '\u26AA': 'white',
  '\u26AB': 'black',
});

export const MATCH_CLASSES = Object.freeze([
  'exact_match',
  'probable_match',
  'name_only_match',
  'conflict',
  'unmatched',
  'third_party_review',
  'temporary_review',
]);

const EG_MOBILE_PREFIXES = new Set(['10', '11', '12', '15', '16', '17', '19']);

function foldDigits(text) {
  let out = '';
  for (const ch of String(text)) {
    const folded = DIGIT_FOLD.get(ch.codePointAt(0));
    out += folded === undefined ? ch : folded;
  }
  return out;
}

export function normalizeIdentifyingText(value) {
  const folded = foldDigits(String(value ?? ''));
  return folded
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '') // zero-width + bidi controls
    .replace(/[ً-ٰ]/g, '')                                            // Arabic diacritics
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One-way identifier so no cleartext phone/name ever reaches Git, CI logs or reports. */
export function hashIdentifier(kind, value, version = 'crm-p4-v1') {
  const normalized = String(value ?? '');
  if (normalized.length === 0) {
    return null;
  }
  return crypto.createHash('sha256').update(`${version}\n${kind}\n${normalized}`).digest('hex');
}

/**
 * Canonical phone key used for *both* sides of the matching problem: the CRM's own
 * trusted normalizer (`crm-chat-intel.normalizeInternationalPhone`) so a Drive-side
 * `+20 10 1234 5678`, a vCard `tel:0020101...` and a stored `phone_key` collapse to
 * the same digit string before hashing. Returns null when the value is not a
 * normalizable number, which is reported as a data-quality issue rather than guessed.
 */
export function canonicalPhoneKey(raw) {
  const decorated = String(raw ?? '')
    .replace(/^\s*(?:tel|callto|sms|whatsapp|fax)\s*:\s*/i, '')
    .replace(/(?:^|[\s(,;:])(?:ext\.?|extension|تحو?يل[هة])[\s:]*\d+/i, ' ');
  const normalized = normalizeInternationalPhone(decorated);
  if (!normalized) {
    return null;
  }
  const digits = String(normalized).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** One-way handle for a Drive id: lets a committed payload reference rows without naming them. */
export function driveRefHash(driveFileId) {
  return hashIdentifier('drive_ref', String(driveFileId ?? ''));
}

export function phoneHash(raw) {
  const key = canonicalPhoneKey(raw);
  return key === null ? null : hashIdentifier('phone_e164', key);
}

/** Convenience alias for hashing a value already stored in `crm_contact_phones.phone_key`. */
export function crmPhoneKeyToHash(phoneKey) {
  return phoneHash(phoneKey);
}

export function nameHash(value) {
  const normalized = normalizeIdentifyingText(value);
  return normalized.length === 0 ? null : hashIdentifier('person_name', normalized);
}

/**
 * Normalizes an Egyptian mobile number to E.164. Accepts Arabic-Indic digits and
 * the local writing variants that actually occur in this corpus:
 * `01012345678`, `+20 10 1234 5678`, `00201012345678`, `002 101...`,
 * `tel:+201012345678`, `+20-10-1234-5678 ext. 12`, `(010) 123 4567`.
 * Returns `{ ok:false, reason }` instead of guessing when the shape is not a
 * valid Egyptian mobile subscriber number.
 */
const PHONE_SCHEME_PREFIXES = new Set(['tel', 'callto', 'sms', 'whatsapp']);

/**
 * Peels a dial scheme (`tel:`, `sms:`, ...) by scanning rather than with
 * `(scheme)\s*:\s*`, whose two adjacent whitespace runs backtrack super-linearly
 * on the thousands of message bodies this parser walks.
 */
function stripPhoneScheme(value) {
  const start = value.length - value.trimStart().length;
  const colon = value.indexOf(':', start);
  if (colon <= 0) return value;
  const scheme = value.slice(start, colon).trim().toLowerCase();
  return PHONE_SCHEME_PREFIXES.has(scheme) ? value.slice(colon + 1) : value;
}
// `[ .]*` instead of `\s*\.?\s*`: adjacent whitespace quantifiers backtrack super-linearly
// over long message bodies, and the corpus separates the label from the digits with spaces/dots only.
const PHONE_EXTENSION_RE = /\b(?:ext|extension|تحويلة|ملاحق)\b[ .]*\d+/i;
const PHONE_TOKEN_CHARS = new Set(['(', ')', '.', '-', '+']);

function isAsciiDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isPhoneTokenChar(ch) {
  return isAsciiDigit(ch) || PHONE_TOKEN_CHARS.has(ch) || /\s/.test(ch);
}

/**
 * Left-most phone-shaped token, taken by scanning instead of by a greedy regex: a
 * `\+?\d[\d\s().-]*` pattern re-expands the same characters on every failure and the
 * analysis runs over every message body of every transcript.
 */
function firstPhoneToken(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!isAsciiDigit(ch) && !(ch === '+' && isAsciiDigit(text[i + 1]))) continue;
    let j = i;
    while (j < text.length && isPhoneTokenChar(text[j])) j += 1;
    return text.slice(i, j);
  }
  return null;
}

/**
 * Strips whatever country/IDD prefix this corpus uses and returns the 10-digit national
 * number, or `null` when the digits carry a `00` international prefix we do not resolve.
 */
function egyptianNationalDigits(compact, plusLeading) {
  if (compact.startsWith('0020')) return compact.slice(4);
  if (plusLeading && compact.startsWith('20')) return compact.slice(2);
  if (plusLeading && compact.startsWith('0')) return compact.slice(1);
  if (compact.startsWith('00')) return null;
  if (compact.startsWith('0')) return compact.slice(1);
  return compact;
}

export function parseEgyptianPhone(rawInput) {
  const raw = foldDigits(String(rawInput ?? ''));
  if (raw.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  let body = stripPhoneScheme(raw);
  body = body.replace(PHONE_EXTENSION_RE, '');
  const token = firstPhoneToken(body);
  if (!token) {
    return { ok: false, reason: 'no_digits' };
  }
  const digits = [token];
  const plusLeading = digits[0].trimStart().startsWith('+');
  const compact = digits[0].replace(/\D/g, '');
  if (compact.length < 9) {
    return { ok: false, reason: 'too_short' };
  }
  if (compact.length > 15) {
    return { ok: false, reason: 'too_long' };
  }
  let national = egyptianNationalDigits(compact, plusLeading);
  if (national === null) {
    return { ok: false, reason: 'unknown_country_code' };
  }
  if (national.length === 10 && national.startsWith('20')) {
    national = national.slice(2);
  }
  if (national.length !== 10 || !national.startsWith('1')) {
    return { ok: false, reason: 'not_10_digit_egyptian_national' };
  }
  if (!EG_MOBILE_PREFIXES.has(national.slice(0, 2))) {
    return { ok: false, reason: 'unsupported_mobile_operator_prefix' };
  }
  const canonical = canonicalPhoneKey(raw);
  const e164 = canonical ? `+${canonical}` : `+${national}`;
  return {
    ok: true,
    e164,
    national,
    canonical_key_length: canonical ? canonical.length : null,
    phoneHash: hashIdentifier('phone_e164', canonical ?? national),
  };
}

export function parseInternationalPhone(raw) {
  const text = foldDigits(String(raw ?? ''));
  if (!text.includes('+')) {
    return { ok: false, reason: 'no_plus_prefix' };
  }
  const digits = text.replace(/[^+\d]/g, '').slice(1);
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, reason: 'length' };
  }
  const canonical = canonicalPhoneKey(digits);
  const e164 = `+${canonical ?? digits}`;
  return { ok: true, e164, phoneHash: hashIdentifier('phone_e164', canonical ?? digits), scope: 'international' };
}

/**
 * Egyptian mobile when the shape allows it, otherwise any E.164-style international
 * number. A foreign number is therefore recorded as recognised-but-out-of-scope
 * instead of being treated as a corrupt value or silently dropped.
 */
export function parsePhoneAnyScope(raw) {
  const eg = parseEgyptianPhone(raw);
  if (eg.ok) {
    return { ...eg, scope: 'egypt_mobile' };
  }
  const intl = parseInternationalPhone(raw);
  if (intl.ok) {
    return { ...intl, is_local: false };
  }
  // Egyptian landline / any value the trusted CRM normalizer accepts but that is not
  // a mobile subscriber number: hashed for matching, scoped explicitly, never
  // presented as a mobile.
  const canonical = canonicalPhoneKey(raw);
  if (canonical !== null) {
    return {
      ok: true,
      e164: `+${canonical}`,
      canonical_key_length: canonical.length,
      phoneHash: hashIdentifier('phone_e164', canonical),
      scope: 'other_normalized',
    };
  }
  return { ok: false, reason: 'unparsable_tel_value' };
}

/** Numbers appearing inside message bodies — candidates, never attributed. */
export function findPhoneCandidatesInText(text, limit = 20) {
  const scanned = foldDigits(String(text ?? ''));
  const matches = scanned.match(/(?:\+|00)?20?\s?1[0125679][\d\s().-]{7,14}?\d|01[0125679][\d\s().-]{7,14}?\d/g) ?? [];
  const out = [];
  const seen = new Set();
  for (const chunk of matches.slice(0, limit * 3)) {
    const parsed = parseEgyptianPhone(chunk);
    if (parsed.ok && !seen.has(parsed.e164)) {
      seen.add(parsed.e164);
      out.push({ e164: parsed.e164, phoneHash: parsed.phoneHash, digits_length: parsed.national.length });
      if (out.length >= limit) {
        break;
      }
    }
  }
  return out;
}

export function detectMarkers(value) {
  const text = String(value ?? '');
  const markers = { temporary: text.includes(TEMP_MARK), status_colors: [], has_emoji: false };
  for (const [ch, label] of Object.entries(STATUS_MARKS)) {
    if (text.includes(ch)) {
      markers.status_colors.push(label);
    }
  }
  const stripped = text
    .replace(EMOJI_CLASS, '').replace(MODIFIER_CLASS, '');
  markers.has_emoji = [...stripped].length !== [...text].length;
  return markers;
}

function looksQuotedPrintable(text) {
  const hits = (text.match(/=[0-9A-F]{2}/g) ?? []).length;
  const lines = text.split('\n').length || 1;
  return hits > 8 && hits / lines > 0.15;
}

function decodeQuotedPrintableBytes(text) {
  const bytes = [];
  const src = String(text).replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = src.codePointAt(i);
      if (code > 0xffff) {
        i += 1;
        continue;
      }
      bytes.push(code & 0x7f);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Best-effort charset detection for exported transcripts and vCards.
 * Never silently mangles text: the chosen encoding is reported and any
 * non-UTF-8 assumption is flagged for human review.
 */
/**
 * UTF-16 without a BOM is detectable from the alternating NUL pattern of mostly-ASCII
 * text. Treated as a warning-level encoding, never silently reinterpreted as UTF-8.
 */
function guessUtf16(buf) {
  if (buf.length < 16 || buf.length % 2 !== 0) {
    return null;
  }
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (buf[i] === 0x00) evenNul += 1;
    if (buf[i + 1] === 0x00) oddNul += 1;
  }
  const half = buf.length / 2;
  if (oddNul / half > 0.85) return 'utf16le';
  if (evenNul / half > 0.85) return 'utf16be';
  return null;
}

function stripNullBytes(text) {
  return text.split('\0').join('');
}

export function decodeMaybeText(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const warnings = [];
  if (bytes.length === 0) {
    return { text: '', encoding: 'empty', warnings: ['empty_payload'], high_ascii_ratio: 0 };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8-bom', warnings, high_ascii_ratio: 0 };
  }
  const utf16Guess = guessUtf16(bytes);
  if (utf16Guess) {
    warnings.push('utf16_without_bom');
    const text = stripNullBytes(bytes.toString(utf16Guess));
    return { text, encoding: utf16Guess === 'utf16be' ? 'utf-16be' : 'utf-16le', warnings, high_ascii_ratio: 0 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    warnings.push('utf16le_bom');
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf-16le', warnings, high_ascii_ratio: 0 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    warnings.push('utf16be_bom');
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', warnings, high_ascii_ratio: 0 };
  }
  return decodeWithoutBom(bytes, warnings);
}

/** Share of high bytes in the first 8 KiB decides which single-byte code page is assumed. */
function highByteRatio(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let high = 0;
  for (const b of sample) {
    if (b > 0x7f) high += 1;
  }
  return high / Math.max(sample.length, 1);
}

function decodeWithoutBom(bytes, warnings) {
  let strict;
  try {
    strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const ratio = highByteRatio(bytes);
    warnings.push('not_strict_utf8');
    if (ratio > 0.02) {
      warnings.push('assumed_windows_1256_arabic');
      return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'windows-1256', warnings, high_ascii_ratio: ratio };
    }
    warnings.push('lossy_latin1_fallback');
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', warnings, high_ascii_ratio: ratio };
  }
  if (looksQuotedPrintable(strict)) {
    const recoded = decodeQuotedPrintableBytes(strict);
    return { text: recoded.toString('utf8'), encoding: 'utf-8-quoted-printable', warnings, high_ascii_ratio: 0 };
  }
  return { text: strict, encoding: 'utf-8', warnings, high_ascii_ratio: 0 };
}

function unfoldVcfLines(text) {
  const logical = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && logical.length > 0) {
      logical[logical.length - 1] += rawLine.slice(1);
    } else if (rawLine.length > 0) {
      logical.push(rawLine);
    }
  }
  return logical;
}

function splitVcfProperty(line) {
  let name = '';
  const params = [];
  let value = null;
  let buf = '';
  let quoted = false;
  const parts = [];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
    } else if ((ch === ';' || ch === ':') && !quoted) {
      parts.push(buf);
      buf = '';
      if (ch === ':') {
        value = line.slice(i + 1);
        break;
      }
    } else {
      buf += ch;
    }
  }
  if (value === null) {
    return null;
  }
  name = (parts.shift() ?? '').toUpperCase();
  for (const param of parts) {
    const idx = param.indexOf('=');
    if (idx > 0) {
      params.push({ key: param.slice(0, idx).toUpperCase(), value: param.slice(idx + 1).replace(/^"|"$/g, '') });
    } else {
      params.push({ key: param.toUpperCase(), value: '' });
    }
  }
  return { name, params, value };
}

const ALWAYS_BINARY_PROPS = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY', 'BDAY']);

function decodeVcfValue(prop) {
  let value = prop.value;
  const flagKeys = prop.params.map(pp => pp.key);
  const enc = prop.params.find(p => p.key === 'ENCODING')?.value?.toUpperCase() ?? '';
  const charset = prop.params.find(p => p.key === 'CHARSET')?.value?.toUpperCase() ?? '';
  if (enc.includes('QUOTED-PRINTABLE')) {
    value = decodeQuotedPrintableBytes(value).toString(charset.includes('1256') ? 'windows-1256' : 'utf8');
  } else if (
    enc.includes('B64') || enc === 'BASE64' || enc === 'B' ||
    flagKeys.includes('BASE64') || flagKeys.includes('B64') ||
    ALWAYS_BINARY_PROPS.has(prop.name)
  ) {
    return { value: '', base64Length: value.length, isBase64: true };
  }
  return { value, base64Length: 0, isBase64: false };
}

/**
 * Parses a vCard 2.1/3.0/4.0 stream into one record per card with only the
 * fields the analysis needs. Photo/binary payloads are dropped (length only).
 */
// The parsers below are branch-per-input-format by nature: every branch exists because the
// corpus really does contain that shape, and each one is pinned by a synthetic test in
// _worker/tests/crm-phase4-analysis.test.mjs. A late-phase restructuring of working parsing
// code would carry more risk of silently changing results than the metric it improves.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function parseVcfCards(text) {
  const lines = unfoldVcfLines(text);
  const cards = [];
  let current = null;
  const orphans = [];
  for (const line of lines) {
    const prop = splitVcfProperty(line);
    if (!prop) {
      if (current) current.structure_issues.push('unparsable_line');
      else orphans.push('unparsable_line_outside_card');
      continue;
    }
    // iOS grouped properties use `item<N>.PROP`; strip the group, keep the real name.
    const dotIdx = prop.name.indexOf('.');
    const looksGrouped = dotIdx > 0 && /^item\d+$/i.test(prop.name.slice(0, dotIdx));
    const base = looksGrouped ? prop.name.slice(dotIdx + 1) : prop.name;
    const group = looksGrouped ? prop.name.slice(0, dotIdx).toLowerCase() : null;
    if (base === 'BEGIN' && prop.value.toUpperCase() === 'VCARD') {
      current = {
        index: cards.length,
        properties: [],
        groups: new Set(),
        structure_issues: [],
        version: null,
        has_end: false,
      };
      continue;
    }
    if (base === 'END' && prop.value.toUpperCase() === 'VCARD') {
      if (!current) {
        orphans.push('end_without_begin');
        continue;
      }
      current.has_end = true;
      cards.push(finalizeCard(current));
      current = null;
      continue;
    }
    if (!current) {
      orphans.push(`property_outside_card:${base}`);
      continue;
    }
    const decoded = decodeVcfValue(prop);
    if (decoded.isBase64) {
      current.properties.push({ name: base, group, params: prop.params, binaryBytes: decoded.base64Length });
      continue;
    }
    current.properties.push({ name: base, group, params: prop.params, value: decoded.value });
    if (base === 'VERSION') current.version = decoded.value.trim();
    if (group) current.groups.add(group);
  }
  if (current) {
    current.structure_issues.push('unterminated_card');
    cards.push(finalizeCard(current));
  }
  return { cards, orphanIssues: [...new Set(orphans)] };
}

function firstValue(card, name) {
  const prop = card.properties.find(p => p.name === name);
  return prop ? String(prop.value ?? '') : '';
}

// The parsers below are branch-per-input-format by nature: every branch exists because the
// corpus really does contain that shape, and each one is pinned by a synthetic test in
// _worker/tests/crm-phase4-analysis.test.mjs. A late-phase restructuring of working parsing
// code would carry more risk of silently changing results than the metric it improves.
// eslint-disable-next-line sonarjs/cognitive-complexity
function finalizeCard(card) {
  const tels = [];
  const labels = new Set();
  let binaryBytes = 0;
  for (const prop of card.properties) {
    if (prop.binaryBytes) {
      binaryBytes += prop.binaryBytes;
      continue;
    }
    if (prop.name === 'TEL') {
      const types = (prop.params.find(p => p.key === 'TYPE')?.value ?? '').toUpperCase();
      const parsed = parsePhoneAnyScope(prop.value);
      const rawTrimmed = String(prop.value).trim();
      tels.push({
        raw_length: rawTrimmed.length,
        types: types.split(',').filter(Boolean),
        label_hash: hashIdentifier('tel_label', rawTrimmed),
        normalized: parsed.ok ? parsed.e164 : null,
        parse_reason: parsed.ok ? null : parsed.reason,
        phone_hash: parsed.ok ? parsed.phoneHash : null,
        canonical_key: parsed.ok ? parsed.e164 : null,
        scope: parsed.ok ? parsed.scope : null,
      });
    }
    if (prop.name === 'X-ABLabel' || prop.name === 'X-ABELLABEL') {
      const cleaned = String(prop.value).replace(/_\$!<(\w+)>!_/g, '$1').trim().toUpperCase();
      if (cleaned) labels.add(cleaned);
    }
  }
  const fn = firstValue(card, 'FN');
  const n = firstValue(card, 'N');
  const nHasValue = n.split(';').some(part => part.trim().length > 0);
  const hasNField = card.properties.some(pr => pr.name === 'N');
  const markers = detectMarkers(`${fn} ${firstValue(card, 'N')}`);
  const normalizedTels = [...new Set(tels.map(t => t.normalized).filter(Boolean))];
  const uniqueHashes = [...new Set(tels.map(t => t.phone_hash).filter(Boolean))];
  const emailCount = card.properties.filter(p => p.name === 'EMAIL').length;
  const noteValue = firstValue(card, 'NOTE');
  const orgValue = firstValue(card, 'ORG');
  const issues = [...new Set(card.structure_issues)];
  if (!fn.trim()) issues.push('missing_fn');
  if (hasNField && !n.includes(';')) issues.push('malformed_n');
  if (tels.length === 0) issues.push('no_tel_property');
  if (tels.some(t => !t.normalized)) issues.push('unparsable_tel_value');
  const internationalCount = tels.filter(t => t.scope === 'international').length;
  if (!card.has_end) issues.push('unterminated_card');
  if (normalizedTels.length !== uniqueHashes.length) issues.push('hash_dedup_mismatch');
  const cardRest = { ...card };
  delete cardRest.properties;
  return {
    ...cardRest,
    fn_present: fn.trim().length > 0,
    fn_length: fn.trim().length,
    fn_hash: nameHash(fn),
    n_present: nHasValue,
    org_present: orgValue.trim().length > 0,
    email_count: emailCount,
    note_present: noteValue.trim().length > 0,
    tel_count: tels.length,
    international_phone_count: internationalCount,
    normalized_tel_count: normalizedTels.length,
    phone_hashes: uniqueHashes,
    tel_types: [...new Set(tels.flatMap(t => t.types))].sort(),
    labels: [...labels].sort(),
    grouped_property_count: card.groups.size,
    binary_payload_bytes: binaryBytes,
    vcf_version: card.version,
    temporary_mark: markers.temporary,
    status_colors: markers.status_colors,
    structure_issues: issues,
  };
}

/**
 * Conservative vCard verdict. `complete` requires a display name, at least one
 * E.164-normalizable number, and no structural issue; anything else is stated
 * explicitly rather than guessed, and never merges cards with similar names.
 */
const BLOCKING_CARD_ISSUES = new Set(['unterminated_card', 'hash_dedup_mismatch', 'unparsable_tel_value']);
const INFORMATIONAL_CARD_ISSUES = new Set(['malformed_n', 'unparsable_line', 'no_tel_property']);

/**
 * Severity-aware classification. Only issues that change what would be imported are
 * escalated to human review; cosmetic structural notes stay informational so review
 * queues are not flooded.
 */
export function classifyVcardCard(card) {
  const reasons = [];
  const issues = new Set(card.structure_issues ?? []);
  const hasPhone = card.normalized_tel_count > 0;
  if (card.temporary_mark) {
    reasons.push('airplane_temporary_mark');
  }
  if (!hasPhone && !card.fn_present) {
    reasons.push('no_name_and_no_phone');
  } else if (!hasPhone) {
    reasons.push('no_normalizable_phone');
  }
  if (hasPhone && !card.fn_present) {
    reasons.push('no_display_name');
  }
  if ((card.international_phone_count ?? 0) > 0) {
    reasons.push('non_egyptian_number_in_scope');
  }
  const blocking = [...issues].filter(i => BLOCKING_CARD_ISSUES.has(i));
  if (blocking.length > 0) {
    reasons.push(...blocking);
  }
  const notes = [...issues].filter(i => INFORMATIONAL_CARD_ISSUES.has(i));
  let classification = 'complete_card';
  if (card.temporary_mark) {
    classification = 'temporary_review';
  } else if (reasons.length > 0) {
    const needsReview = reasons.some(r => r !== 'no_normalizable_phone' && r !== 'no_display_name');
    classification = needsReview ? 'needs_human_review' : 'incomplete_card';
  }
  return {
    classification,
    reasons,
    informational_notes: notes,
    needs_human_review: classification === 'needs_human_review' || classification === 'temporary_review',
  };
}

/**
 * How a conversation's counterpart could be identified from the transcript itself.
 * Never inferred from message bodies: numbers found in text are reported as
 * `body_candidate_only` and are never attributed to the owner.
 */
export function classifyIdentityBasis(parsed) {
  const identity = parsed.identity ?? {};
  const stats = parsed.stats ?? {};
  const phones = identity.sender_phone_hashes ?? [];
  const names = identity.sender_name_hashes ?? [];
  const body = identity.body_phone_candidate_hashes ?? [];
  if (phones.length > 0 && names.length > 0) return { basis: 'label_phone_and_name', confidence: 'medium' };
  if (phones.length > 0) return { basis: 'label_phone', confidence: 'medium' };
  if (body.length > 0) return { basis: 'body_candidate_only', confidence: 'low' };
  if (names.length > 0 || (stats.unique_sender_labels ?? 0) > 0) return { basis: 'label_name_only', confidence: 'low' };
  return { basis: 'none', confidence: 'none' };
}

/* ── WhatsApp text exports ───────────────────────────────────────────────── */

// Emoji ranges and the joining variation selectors are stripped separately: a ZWJ or a
// U+FE0F inside a class would be matched as a *character* of a grapheme cluster.
const EMOJI_CLASS = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
const MODIFIER_CLASS = /[\u{FE0F}\u{200D}]/gu;

const TS_DATE = '(\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4})';
const TS_MERIDIEM = '(?:[APap][.\\s]?[Mm]|[صم])';
const TS_TIME = `(\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?(?:\\s*${TS_MERIDIEM})?)`;
const TS_TAIL = '\\s*(.*)$';

// Built from parts instead of three long literals: each export dialect differs only in how
// the timestamp is delimited, and the pieces are checked against real exports one at a time.
const TS_PATTERNS = [
  { key: 'bracket_ios', re: new RegExp(`^\\[\\s*${TS_DATE}[,\\s]+${TS_TIME}?\\]${TS_TAIL}`) },
  { key: 'dash_android', re: new RegExp(`^${TS_DATE}[,\\s]+${TS_TIME}\\s*[-–—]\\s*(.*)$`) },
  { key: 'dash_no_time', re: new RegExp(`^${TS_DATE}\\s*[-–—]\\s*(.*)$`) },
];

const SYSTEM_LINE_RES = [
  /التشفير من طرف إلى طرف/i,
  /end-to-end encrypted/i,
  /لا يستطيع أحد خارج هذا/i,
  /No one outside of this chat/i,
  /تم تصدير/i,
  /exported from whatsapp/i,
  /Missing a phone number/i,
  /not supported on this device/i,
  /^\s*[-–—*_]{3,}\s*$/,
];

const DELETED_MESSAGE_RES = [
  /تم حذف هذه الرسالة/i,
  /هذا الرسائل? تم حذفها/i,
  /messages?(?: was| were)? deleted/i,
  /you deleted this message/i,
  /this message was deleted/i,
];

const MEDIA_MESSAGE_RES = [
  /<\s*(?:image|video|audio|document|sticker|gif|contact|location)(?:\s+attached)?\s*>/i,
  /\b(?:image|video|audio|document|sticker)\s+attached\b/i,
  /الوسائط/i,
  /(فيديو|صورة|صوت|ملف ملحق|ملصق) (?:مرفق|غير مدعوم)/i,
];

const UNSUPPORTED_MESSAGE_RES = [
  /غير\s*مدعوم/i,
  /not\s*supported/i,
  /لم\s*يتم\s*تحميل\s*الوسائط/i,
  /تم\s*استبعاد\s*الوسائط/i,
];

/**
 * Arabic WhatsApp exports write digits as Arabic-Indic numerals, embed RTL marks
 * inside the timestamp and use an Arabic comma before the time. Line *parsing*
 * needs the visual shape, so those are normalised first; hashing always uses the
 * original body text, never this folded form.
 */
export function normalizeTranscriptLine(line) {
  return foldDigits(String(line ?? ''))
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2060]/g, '')
    .replace(/\u060c/g, ',')
    .replace(/\u061b/g, ';')
    .replace(/\u061f/g, '?');
}

function matchTranscriptLine(line) {
  const normalized = normalizeTranscriptLine(line);
  for (const pattern of TS_PATTERNS) {
    const m = normalized.match(pattern.re);
    if (!m) continue;
    if (pattern.key === 'dash_no_time') {
      return { key: pattern.key, date: m[1], time: null, rest: m[2] ?? '' };
    }
    return { key: pattern.key, date: m[1], time: m[2] ?? null, rest: m[3] ?? '' };
  }
  return null;
}

function splitSenderAndBody(rest) {
  const text = String(rest ?? '');
  const colon = text.indexOf(': ');
  const looksLikeLabel = colon > 0 && colon <= 64 && !/^\s*\d{6,}$/.test(text.slice(0, colon));
  if (!looksLikeLabel) {
    return { sender: '', body: text.trim(), system: true };
  }
  const sender = text.slice(0, colon).trim();
  const body = text.slice(colon + 2).trim();
  const system = SYSTEM_LINE_RES.some(re => re.test(body));
  return { sender, body, system };
}

function classifyBody(body) {
  const text = String(body ?? '');
  const stripped = text
    .replace(EMOJI_CLASS, '').replace(MODIFIER_CLASS, '');
  const phoneCount = findPhoneCandidatesInText(text, 5).length;
  return {
    deleted_messages: DELETED_MESSAGE_RES.some(re => re.test(text)),
    media_messages: MEDIA_MESSAGE_RES.some(re => re.test(text)),
    unsupported_messages: UNSUPPORTED_MESSAGE_RES.some(re => re.test(text)),
    body_is_phone_only: phoneCount > 0 && stripped.replace(/[^\d+]/g, '').length >= 8,
    phone_candidate_count: phoneCount,
    has_url: /https?:\/\/|www\./i.test(text),
    has_emoji: [...stripped].length !== [...text].length,
  };
}

function to2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Day-first date handling (`dd/mm/yyyy`), which is what WhatsApp writes in Arabic
 * locales. A day component of 12 or less could also read as a month, so that case
 * is flagged as ambiguous instead of being presented as certain.
 */
const MERIDIEM_TESTS = [
  [/ص/, 'am'],
  [/م/, 'pm'],
  [/[Pp]\.?\s*[Mm]/, 'pm'],
  [/[Aa]\.?\s*[Mm]/, 'am'],
];

/** Arabic exports use ص/م, English ones A.M./P.M. — first match wins, as before. */
function detectMeridiem(value) {
  for (const [re, meridiem] of MERIDIEM_TESTS) {
    if (re.test(value)) return meridiem;
  }
  return null;
}

/** Clock half of a timestamp: `h:mm[:ss]` with an optional Arabic or Latin meridiem. */
function parseClockPart(timeStr) {
  const t = String(timeStr ?? '').trim();
  if (t.length === 0) {
    return { hhmm: null, hasSeconds: false };
  }
  const hasSeconds = (t.match(/[:.]/g) ?? []).length > 1;
  const parts = t.split(/[:.]/).map(x => Number(x)).filter(Number.isFinite);
  const meridiem = detectMeridiem(t);
  if (parts.length < 2) {
    return { hhmm: null, hasSeconds };
  }
  let hour = parts[0];
  const minute = parts[1];
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const hhmm = hour <= 23 && minute <= 59 ? `${to2(hour)}:${to2(minute)}` : null;
  return { hhmm, hasSeconds };
}

export function parseTimestamp(dateStr, timeStr) {
  const date = String(dateStr ?? '').trim().replace(/\./g, '/').replace(/-/g, '/');
  const seg = date.split('/').filter(Boolean);
  let year = null;
  let month = null;
  let day = null;
  let ambiguous = false;
  if (seg.length === 3) {
    if (seg[0].length === 4) {
      [year, month, day] = seg;
    } else {
      [day, month, year] = seg;
      ambiguous = Number(day) <= 12 && Number(month) <= 12;
    }
  }
  if (!year || !month || !day || year.length !== 4 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
    return { iso: null, hhmm: null, ambiguous: false, has_seconds: false };
  }
  const iso = `${year}-${to2(Number(month))}-${to2(Number(day))}`;
  const clock = parseClockPart(timeStr);
  return { iso, hhmm: clock.hhmm, ambiguous, has_seconds: clock.hasSeconds };
}

function digestOf(values) {
  return crypto.createHash('sha256').update((values ?? []).join('\n')).digest('hex');
}

export function buildConversationFingerprint(messages) {
  const counted = (messages ?? []).filter(m => !m.flags?.system);
  const raw = counted.map(m => m.body_hash ?? hashIdentifier('message_body', m.body));
  const normalized = counted.map(m => hashIdentifier('message_body_norm', normalizeIdentifyingText(m.body)));
  const set = [...new Set(normalized)].sort();
  return {
    count: counted.length,
    hashes: normalized,
    raw_hashes: raw,
    set_size: set.length,
    full_sha256: digestOf(raw),
    normalized_sha256: digestOf(normalized),
    set_sha256: digestOf(set),
    prefix20_sha256: digestOf(normalized.slice(0, 20)),
    suffix20_sha256: digestOf(normalized.slice(-20)),
  };
}

/**
 * Similarity between two transcripts, expressed only as counts and ratios.
 * `normalized_identical` with differing raw digests means "same text, different
 * formatting" and must never be reported as a byte-level duplicate.
 */
export function compareConversationFingerprints(a, b) {
  if (!a || !b) {
    return { comparable: false, verdict: 'missing_fingerprint' };
  }
  const setA = new Set(a.hashes ?? []);
  const setB = new Set(b.hashes ?? []);
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  let shared = 0;
  for (const value of smaller) {
    if (larger.has(value)) shared += 1;
  }
  const ratio = smaller.size > 0 ? shared / smaller.size : 0;
  const identical = a.full_sha256 === b.full_sha256;
  const normalizedIdentical = a.normalized_sha256 === b.normalized_sha256;
  let verdict = 'different';
  if (identical) verdict = 'identical_transcript';
  else if (normalizedIdentical) verdict = 'same_text_different_formatting';
  else if (ratio === 1 && larger.size > smaller.size) verdict = 'contained_within';
  else if (ratio >= 0.5 && shared >= 8) verdict = 'heavy_overlap';
  else if (shared > 0) verdict = 'phrase_similarity';
  return {
    comparable: true,
    verdict,
    identical,
    normalized_identical: normalizedIdentical,
    shared_message_count: shared,
    overlap_ratio: Number(ratio.toFixed(4)),
    only_in_first_count: setA.size - shared,
    only_in_second_count: setB.size - shared,
  };
}

/**
 * Parses a WhatsApp text export into counted messages plus structural statistics.
 * Message bodies stay inside the returned message objects only for the duration of
 * the analysis; consumers receive digests, counts and dates.
 */
// The parsers below are branch-per-input-format by nature: every branch exists because the
// corpus really does contain that shape, and each one is pinned by a synthetic test in
// _worker/tests/crm-phase4-analysis.test.mjs. A late-phase restructuring of working parsing
// code would carry more risk of silently changing results than the metric it improves.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function parseWhatsAppTranscript(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const messages = [];
  const warnings = new Set();
  let format = null;
  let unparsed = 0;
  let continuation = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const shape = matchTranscriptLine(line);
    if (shape) {
      format = format ?? shape.key;
      const stamp = parseTimestamp(shape.date, shape.time);
      const { sender, body, system } = splitSenderAndBody(shape.rest);
      const flags = classifyBody(body);
      messages.push({
        iso: stamp.iso,
        hhmm: stamp.hhmm,
        ambiguous_date: stamp.ambiguous,
        has_seconds: stamp.has_seconds,
        sender_raw: sender,
        sender_is_phone: sender ? /^\+?[\d\s().-]{8,}$/.test(normalizeTranscriptLine(sender)) : false,
        sender_label_hash: sender ? hashIdentifier('sender_label', normalizeIdentifyingText(sender)) : null,
        body,
        body_hash: hashIdentifier('message_body', body),
        flags: { ...flags, system: system || SYSTEM_LINE_RES.some(re => re.test(line)) },
      });
    } else if (messages.length > 0) {
      // WhatsApp keeps multi-line message bodies unindented; they belong to the
      // previous message, so appending preserves transcript semantics.
      continuation += 1;
      const last = messages[messages.length - 1];
      last.body = `${last.body}\n${line}`;
      last.body_hash = hashIdentifier('message_body', last.body);
    } else {
      unparsed += 1;
      warnings.add('leading_unparsed_lines');
    }
  }
  if (format === null) {
    warnings.add('no_timestamp_format_detected');
  }
  const counted = messages.filter(m => !m.flags.system);
  const fingerprint = buildConversationFingerprint(messages);
  const isoDates = counted.map(m => m.iso).filter(Boolean).sort();
  const labels = new Set(counted.map(m => m.sender_label_hash).filter(Boolean));
  const senderLabelCounts = new Map();
  const senderPhoneHashes = [];
  const senderNameHashes = [];
  for (const msg of counted) {
    if (!msg.sender_raw) continue;
    senderLabelCounts.set(msg.sender_label_hash, (senderLabelCounts.get(msg.sender_label_hash) ?? 0) + 1);
    const parsedLabel = parsePhoneAnyScope(msg.sender_raw);
    if (parsedLabel.ok && parsedLabel.scope === 'egypt_mobile') {
      if (!senderPhoneHashes.some(h => h.phone_hash === parsedLabel.phoneHash)) {
        senderPhoneHashes.push({ phone_hash: parsedLabel.phoneHash, label_length: String(msg.sender_raw).trim().length });
      }
    } else {
      const hashed = nameHash(msg.sender_raw);
      if (hashed && !senderNameHashes.includes(hashed)) senderNameHashes.push(hashed);
    }
  }
  let dominantHash = null;
  let dominantCount = 0;
  for (const [h, n] of senderLabelCounts) {
    if (n > dominantCount) {
      dominantHash = h;
      dominantCount = n;
    }
  }
  const bodyPhoneHashes = [];
  const seenBody = new Set();
  for (const msg of counted) {
    for (const cand of findPhoneCandidatesInText(msg.body, 12)) {
      if (!seenBody.has(cand.phoneHash)) {
        seenBody.add(cand.phoneHash);
        bodyPhoneHashes.push(cand.phoneHash);
      }
    }
  }
  return {
    format,
    warnings: [...warnings],
    identity: {
      sender_phone_hashes: senderPhoneHashes,
      sender_name_hashes: senderNameHashes,
      body_phone_candidate_hashes: bodyPhoneHashes,
      dominant_sender_label_hash: dominantHash,
      dominant_sender_share: counted.length > 0 ? Number((dominantCount / counted.length).toFixed(3)) : 0,
    },
    stats: {
      lines_total: lines.length,
      messages_total: counted.length,
      raw_message_blocks: messages.length,
      system_lines: messages.length - counted.length,
      continuation_lines: continuation,
      unparsed_lines: unparsed,
      unique_sender_labels: labels.size,
      sender_labels_matching_phone_shape: counted.filter(m => m.sender_is_phone).length,
      deleted_messages: counted.filter(m => m.flags.deleted_messages).length,
      media_messages: counted.filter(m => m.flags.media_messages).length,
      unsupported_messages: counted.filter(m => m.flags.unsupported_messages).length,
      body_is_phone_only_messages: counted.filter(m => m.flags.body_is_phone_only).length,
      text_only_messages: counted.filter(m => !m.flags.media_messages && !m.flags.deleted_messages && !m.flags.unsupported_messages).length,
      total_body_chars: counted.reduce((n, m) => n + m.body.length, 0),
      ambiguous_date_lines: counted.filter(m => m.ambiguous_date).length,
      time_only_seconds_present: counted.some(m => m.has_seconds),
    },
    fingerprint,
    first_iso_date: isoDates[0] ?? null,
    last_iso_date: isoDates[isoDates.length - 1] ?? null,
    ordered_message_hashes: fingerprint.raw_hashes,
  };
}


export function classifyTranscriptOwnership(parsed, archiveLabel) {
  const markers = detectMarkers(archiveLabel ?? '');
  const stats = parsed?.stats ?? {};
  const reasons = [];
  if (markers.temporary) reasons.push('airplane_temporary_mark');
  if ((stats.unique_sender_labels ?? 0) === 0) reasons.push('no_sender_labels');
  if ((stats.unique_sender_labels ?? 0) > 2) reasons.push('more_than_two_participants');
  const basis = classifyIdentityBasis(parsed);
  if (basis.basis !== 'label_phone' && basis.basis !== 'label_phone_and_name') {
    reasons.push('no_phone_in_sender_labels');
  }
  if ((stats.messages_total ?? 0) === 0) {
    reasons.push('no_messages_parsed');
  } else if ((stats.continuation_lines ?? 0) > (stats.messages_total ?? 0) * 4) {
    reasons.push('low_parse_confidence');
  }
  if (!parsed?.first_iso_date && (stats.messages_total ?? 0) > 0) reasons.push('no_dates_parsed');
  return {
    owner_identifiable: reasons.length === 0,
    temporary: markers.temporary,
    status_colors: markers.status_colors,
    identity_basis: basis.basis,
    identity_confidence: basis.confidence,
    reasons,
  };
}

export function extractPhoneNumbersFromCards(cards) {
  const out = [];
  for (const card of cards) {
    for (const hash of card.phone_hashes ?? []) {
      out.push({ phone_hash: hash, card_index: card.index, fn_hash: card.fn_hash, temporary: card.temporary_mark });
    }
  }
  return out;
}

export function aggregateVcardClassifications(cards) {
  const tally = {};
  for (const card of cards) {
    const { classification, reasons } = classifyVcardCard(card);
    tally[classification] = (tally[classification] ?? 0) + 1;
    if (reasons.length > 0) {
      tally[`reason:${reasons[0]}`] = (tally[`reason:${reasons[0]}`] ?? 0) + 1;
    }
  }
  return tally;
}
