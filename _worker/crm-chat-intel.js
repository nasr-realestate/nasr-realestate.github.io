// Internal Conversation Intelligence, WhatsApp Parser, Africa/Cairo Clock & Smart Alerts Engine.
// 100% deterministic local execution inside the CRM Worker — zero external AI calls, zero data sharing.

export const CURRENT_RULE_VERSION = 'chat-intel-v1.0';

const BIDI_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g;
const BROKER_NAMES = new Set(['سمسارطلبك', 'سمسار طلبك', 'طارق', 'طارق طنطاوي', 'tarek', 'tarek tantawy']);

const MSG_ANDROID_RE = /^(\d{1,4}\/\d{1,2}\/\d{1,4})\s*[،,]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[صم]|AM|PM|am|pm))?)\s*-\s*(.*)$/;
const MSG_IOS_RE = /^\[(\d{1,4}\/\d{1,2}\/\d{1,4})\s*[،,]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[صم]|AM|PM|am|pm))?)\]\s*(.*)$/;

const URL_TOKEN_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{1,15}:[^\s<>"')\]،]+|https?:\/\/[^\s<>"')\]،]+)/g;
const DANGEROUS_SCHEME_RE = /^(?:javascript|data|vbscript|file|blob):/i;

const NASR_AREAS_PATTERNS = [
  'الحديقة الدولية', 'الحديقه الدوليه', 'حسن المأمون', 'حسن المامون', 'مكرم عبيد',
  'عباس العقاد', 'مصطفى النحاس', 'مصطفي النحاس', 'الحي السابع', 'الحى السابع',
  'الحي الثامن', 'الحى الثامن', 'الحي العاشر', 'الحى العاشر', 'المنطقة الأولى',
  'المنطقه الاولى', 'المنطقة السادسة', 'المنطقه السادسه', 'المنطقة الثامنة',
  'المنطقة التاسعة', 'المنطقة العاشرة', 'حي السفارات', 'زهراء مدينة نصر',
  'الواحة', 'الواحه', 'الطيران', 'رابعة الاستثماري', 'رابعه الاستثماري', 'رابعة',
  'السنهوري', 'السنهورى', 'النزهة', 'مصر الجديدة', 'عمارات المروة', 'عمارات المروه',
  'أرض الجولف', 'ارض الجولف', 'موسى الكاظم', 'حسنين هيكل', 'ذاكر حسين', 'امتداد رمسيس',
];

const WEEKDAY_MAP = [
  { re: /(?:يوم\s+)?السبت/, dow: 6, label: 'السبت' },
  { re: /(?:يوم\s+)?(?:الأحد|الاحد|الحد)/, dow: 0, label: 'الأحد' },
  { re: /(?:يوم\s+)?(?:الاثنين|الإثنين|الاتنين)/, dow: 1, label: 'الاثنين' },
  { re: /(?:يوم\s+)?(?:الثلاثاء|التلات|الثلاث)/, dow: 2, label: 'الثلاثاء' },
  { re: /(?:يوم\s+)?(?:الأربعاء|الاربعاء|الأربع|الاربع)/, dow: 3, label: 'الأربعاء' },
  { re: /(?:يوم\s+)?الخميس/, dow: 4, label: 'الخميس' },
  { re: /(?:يوم\s+)?(?:الجمعة|الجمعه)/, dow: 5, label: 'الجمعة' },
];

const encoder = new TextEncoder();

export function cleanBidiControls(value) {
  return String(value || '').replaceAll(BIDI_MARKS_RE, '').trim();
}

export function toAsciiDigits(value) {
  return String(value || '')
    .replaceAll(/[\u0660-\u0669]/g, ch => String(ch.codePointAt(0) - 0x0660))
    .replaceAll(/[\u06f0-\u06f9]/g, ch => String(ch.codePointAt(0) - 0x06f0));
}

export async function sha256HexText(value) {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeInternationalPhone(raw) {
  const cleaned = toAsciiDigits(cleanBidiControls(raw));
  if (!cleaned) return null;
  const hasIntlPrefix = /^\s*\+/.test(cleaned) || cleaned.startsWith('00');
  let digits = cleaned.replaceAll(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^01[0125]\d{8}$/.test(digits)) {
    digits = `20${digits.slice(1)}`;
  } else if (/^1[0125]\d{8}$/.test(digits) && !hasIntlPrefix) {
    digits = `20${digits}`;
  } else if (/^0201[0125]\d{8}$/.test(digits)) {
    digits = digits.slice(1);
  } else if (/^0[2-9]\d{7,9}$/.test(digits) && !hasIntlPrefix) {
    digits = `20${digits.slice(1)}`;
  }
  if (digits.length < 8 || digits.length > 15 || !/^\d+$/.test(digits)) return null;
  if (digits.startsWith('20') && !/^20(?:1[0125]\d{8}|[2-9]\d{7,9})$/.test(digits)) return null;
  if (!digits.startsWith('20') && !hasIntlPrefix) {
    // Allow already-normalized common country codes when stored or searched directly (e.g. 97150..., 9665..., 965..., 249..., 336..., 642...)
    if (!/^(?:971|966|965|974|973|968|962|961|249|218|33|44|49|39|34|64|1)\d{6,12}$/.test(digits)) {
      return null;
    }
  }
  return digits;
}

export function buildPhoneSearchVariants(rawQuery) {
  const ascii = toAsciiDigits(cleanBidiControls(rawQuery));
  const strippedFormatting = ascii.replaceAll(/[\s().+-]/g, '');
  if (!/^\d{4,16}$/.test(strippedFormatting)) return [];
  const variants = new Set();
  const fullNorm = normalizeInternationalPhone(ascii);
  if (fullNorm) variants.add(fullNorm);
  let digits = strippedFormatting;
  if (digits.startsWith('00') && digits.length >= 9) digits = digits.slice(2);
  variants.add(digits);
  if (/^01[0125]\d{2,8}$/.test(digits)) {
    variants.add(`20${digits.slice(1)}`);
    variants.add(digits.slice(1));
  } else if (/^201[0125]\d{2,8}$/.test(digits)) {
    variants.add(digits.slice(2));
  } else if (/^0201[0125]\d{2,8}$/.test(digits)) {
    variants.add(digits.slice(1));
  }
  return [...variants].filter(v => v.length >= 4 && v.length <= 15);
}

export function getCairoClock(nowInput = new Date()) {
  const d = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour === '24' ? 0 : map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  return {
    dayKey: `${map.year}-${map.month}-${map.day}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
  };
}

export function cairoLocalToUtcDate(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  // Two-pass IANA Africa/Cairo offset solver (exact across UTC+2 standard time and UTC+3 summer DST).
  const targetUtcLike = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let guessMs = targetUtcLike - 2 * 3600_000;
  for (let pass = 0; pass < 2; pass += 1) {
    const c = getCairoClock(new Date(guessMs));
    const observedUtcLike = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, ms);
    guessMs += targetUtcLike - observedUtcLike;
  }
  return new Date(guessMs);
}

export function cairoLocalToUtcIso(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return cairoLocalToUtcDate(year, month, day, hour, minute, second, ms).toISOString();
}

export function getCairoDayBoundsUtc(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return {
    dayKey: `${m[1]}-${m[2]}-${m[3]}`,
    startUtcIso: cairoLocalToUtcIso(year, month, day, 0, 0, 0, 0),
    endUtcIso: cairoLocalToUtcIso(year, month, day, 23, 59, 59, 999),
  };
}

export function toCairoDayKey(isoOrDate) {
  if (!isoOrDate) return '';
  if (typeof isoOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate.trim())) {
    return isoOrDate.trim();
  }
  const parsed = new Date(isoOrDate);
  if (Number.isNaN(parsed.valueOf())) return '';
  return getCairoClock(parsed).dayKey;
}

export function parseFollowupInstantMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, mo, d] = raw.split('-').map(Number);
    return cairoLocalToUtcDate(y, mo, d, 23, 59, 59, 0).getTime();
  }
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function extractSafeUrls(rawText) {
  const text = String(rawText || '');
  const links = [];
  const blockedSchemes = [];
  const seen = new Set();
  for (const match of text.matchAll(URL_TOKEN_RE)) {
    const candidate = match[1].replace(/[.,;!?؟،]+$/, '');
    if (DANGEROUS_SCHEME_RE.test(candidate)) {
      blockedSchemes.push(candidate.split(':')[0].toLowerCase());
      continue;
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname.includes('.')) {
        continue;
      }
      const href = parsed.toString();
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({
        url: href,
        host: parsed.hostname.toLowerCase(),
        is_site_property: parsed.hostname.toLowerCase() === 'nasr-realestate.github.io',
      });
    } catch {
      // Ignore malformed URL fragments safely.
    }
  }
  return { links, blockedSchemes };
}

export function extractSafeLinks(rawText) {
  const { links, blockedSchemes } = extractSafeUrls(rawText);
  return { safe: links.map(item => item.url), blocked: blockedSchemes };
}

export function sanitizeExternalOrSiteUrl(value) {
  const raw = typeof value === 'string' ? value.trim().slice(0, 800) : '';
  if (!raw) return '';
  if (DANGEROUS_SCHEME_RE.test(raw)) return '';
  if (/^\/(?!\/)[A-Za-z0-9_./?=#%&+-]*$/.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.includes('.')) {
        return parsed.toString();
      }
    } catch {
      return '';
    }
  }
  return '';
}

function detectDateOrderForChat(rawHeaders) {
  // Egyptian WhatsApp exports use DD/MM/YYYY; iOS US-locale exports use MM/DD/YY(YY).
  for (const dStr of rawHeaders) {
    const parts = dStr.split('/').map(Number);
    if (parts.length !== 3) continue;
    if (parts[0] > 1900) return 'YMD';
    if (parts[0] > 12 && parts[1] <= 12) return 'DMY';
    if (parts[1] > 12 && parts[0] <= 12) return 'MDY';
  }
  return 'DMY';
}

function parseHeaderTimestampToCairoIso(dateStr, timeStr, order) {
  const dParts = dateStr.split('/').map(Number);
  if (dParts.length !== 3 || dParts.some(n => !Number.isFinite(n))) return null;
  let year;
  let month;
  let day;
  if (order === 'YMD') {
    [year, month, day] = dParts;
  } else if (order === 'MDY') {
    [month, day, year] = dParts;
  } else {
    [day, month, year] = dParts;
  }
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const tClean = timeStr.trim();
  const isPm = /(?:م|PM|pm)\s*$/.test(tClean);
  const isAm = /(?:ص|AM|am)\s*$/.test(tClean);
  const clockOnly = tClean.replace(/(?:[صم]|AM|PM|am|pm)\s*$/g, '').trim();
  const tParts = clockOnly.split(':').map(Number);
  if (tParts.length < 2 || tParts.some(n => !Number.isFinite(n))) return null;
  let hour = tParts[0];
  const minute = tParts[1];
  const second = tParts[2] || 0;
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return cairoLocalToUtcIso(year, month, day, hour, minute, second, 0);
}

function classifySenderRole(senderLabel) {
  const clean = cleanBidiControls(senderLabel);
  if (!clean) return 'system';
  const lowered = clean.toLowerCase();
  if (BROKER_NAMES.has(clean) || BROKER_NAMES.has(lowered) || clean.includes('سمسارطلبك') || clean.includes('سمسار طلبك')) {
    return 'broker';
  }
  return 'customer';
}

function matchTimestampedLine(rawLine) {
  const cleanAscii = toAsciiDigits(cleanBidiControls(rawLine));
  const mAndroid = MSG_ANDROID_RE.exec(cleanAscii);
  if (mAndroid) {
    const rawNoBidi = cleanBidiControls(rawLine);
    const sepIdx = rawNoBidi.indexOf(' - ');
    const bodyPart = sepIdx >= 0 ? rawNoBidi.slice(sepIdx + 3) : mAndroid[3];
    return { format: 'android', dateStr: mAndroid[1], timeStr: mAndroid[2], bodyPart };
  }
  const mIos = MSG_IOS_RE.exec(cleanAscii);
  if (mIos) {
    const rawNoBidi = cleanBidiControls(rawLine);
    const sepIdx = rawNoBidi.indexOf('] ');
    const bodyPart = sepIdx >= 0 ? rawNoBidi.slice(sepIdx + 2) : mIos[3];
    return { format: 'ios', dateStr: mIos[1], timeStr: mIos[2], bodyPart };
  }
  return null;
}

export async function parseWhatsAppExport(rawInput, { chatTitle = '' } = {}) {
  const rawText = String(rawInput || '');
  const rawSha256 = await sha256HexText(rawText);
  const lines = rawText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const parseWarnings = [];
  const preParsed = [];
  const leadingLines = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const hit = matchTimestampedLine(rawLine);
    if (hit) {
      preParsed.push({ lineNo: idx + 1, ...hit });
    } else if (preParsed.length > 0) {
      preParsed[preParsed.length - 1].bodyPart += `\n${rawLine.trimEnd()}`;
    } else if (rawLine.trim()) {
      leadingLines.push({ lineNo: idx + 1, text: cleanBidiControls(rawLine) });
    }
  }

  if (preParsed.length === 0 && leadingLines.length > 0) {
    parseWarnings.push({
      code: 'plain_text_fallback',
      line_no: 1,
      message: 'النص لا يحتوي على ترويسة زمنية قياسية لواتساب (Android/iOS)؛ تم حفظ النص الكامل كرسالة خام دون إسقاط أي سطر.',
    });
    const combined = leadingLines.map(l => l.text).join('\n');
    const urlCheck = extractSafeUrls(combined);
    if (urlCheck.blockedSchemes.length > 0) {
      parseWarnings.push({
        code: 'blocked_unsafe_url_scheme',
        line_no: 1,
        message: `تم حظر رابط غير آمن (${urlCheck.blockedSchemes.join(', ')}) مع الاحتفاظ بالنص.`,
      });
    }
    return {
      chatTitle: cleanBidiControls(chatTitle) || 'محادثة نصية',
      peerSenderName: '',
      peerPhoneNorm: null,
      rawText,
      rawSha256,
      firstMessageAt: null,
      lastMessageAt: null,
      parseWarnings,
      messages: [
        {
          seq_no: 1,
          sender_role: 'customer',
          sender_label: cleanBidiControls(chatTitle) || 'العميل',
          sent_at: null,
          raw_timestamp_text: '',
          body_text: combined,
          links: urlCheck.links,
        },
      ],
    };
  }

  if (leadingLines.length > 0) {
    parseWarnings.push({
      code: 'leading_unparsed_lines',
      line_no: leadingLines[0].lineNo,
      count: leadingLines.length,
      message: `توجد ${leadingLines.length} أسطر تمهيدية غير مهيكلة قبل أول رسالة مؤرخة؛ تم الاحتفاظ بها في النص الخام وفي سجل التحذيرات.`,
    });
  }

  const dateOrder = detectDateOrderForChat(preParsed.map(p => p.dateStr));
  const messages = [];
  const customerSenders = new Map();

  for (let i = 0; i < preParsed.length; i += 1) {
    const item = preParsed[i];
    const sentAt = parseHeaderTimestampToCairoIso(item.dateStr, item.timeStr, dateOrder);
    if (!sentAt) {
      parseWarnings.push({
        code: 'timestamp_parse_warning',
        line_no: item.lineNo,
        message: `تعذّر تحويل التوقيت (${item.dateStr} ${item.timeStr}) في السطر ${item.lineNo}؛ حُفظ النص بالتوقيت النصي الأصلي.`,
      });
    }
    const colonIdx = item.bodyPart.indexOf(':');
    let senderLabel = '';
    let bodyText = item.bodyPart.trim();
    let senderRole = 'system';
    if (colonIdx > 0 && colonIdx <= 140 && !item.bodyPart.slice(0, colonIdx).includes('\n')) {
      senderLabel = cleanBidiControls(item.bodyPart.slice(0, colonIdx));
      bodyText = item.bodyPart.slice(colonIdx + 1).trim();
      senderRole = classifySenderRole(senderLabel);
      if (senderRole === 'customer' && senderLabel) {
        customerSenders.set(senderLabel, (customerSenders.get(senderLabel) || 0) + 1);
      }
    }
    const urlCheck = extractSafeUrls(bodyText);
    if (urlCheck.blockedSchemes.length > 0) {
      parseWarnings.push({
        code: 'blocked_unsafe_url_scheme',
        line_no: item.lineNo,
        message: `تم حظر رابط غير آمن (${urlCheck.blockedSchemes.join(', ')}) في السطر ${item.lineNo}.`,
      });
    }
    messages.push({
      seq_no: i + 1,
      sender_role: senderRole,
      sender_label: senderLabel,
      sent_at: sentAt,
      raw_timestamp_text: `${item.dateStr}, ${item.timeStr}`,
      body_text: bodyText,
      links: urlCheck.links,
    });
  }

  let peerSenderName = '';
  let bestCount = 0;
  for (const [sName, cnt] of customerSenders.entries()) {
    if (cnt > bestCount) {
      peerSenderName = sName;
      bestCount = cnt;
    }
  }
  const cleanTitle = cleanBidiControls(chatTitle)
    .replace(/^دردشة في واتساب مع\s*/, '')
    .replace(/\.txt$/i, '')
    .trim();
  const peerPhoneNorm = normalizeInternationalPhone(peerSenderName) || normalizeInternationalPhone(cleanTitle);
  const dated = messages.map(m => m.sent_at).filter(Boolean);

  return {
    chatTitle: cleanTitle || peerSenderName || 'محادثة واتساب',
    peerSenderName,
    peerPhoneNorm,
    rawText,
    rawSha256,
    firstMessageAt: dated[0] || null,
    lastMessageAt: dated.length ? dated[dated.length - 1] : null,
    parseWarnings,
    messages,
  };
}

function extractHourHintCairo(asciiText) {
  const explicitHour = /الساع[ةه]\s*(\d{1,2})(?::(\d{2}))?\s*(الصبح|صباح[اًا]?|الظهر|الضهر|ظهر[اًا]?|ضهر[اًا]?|العصر|المغرب|مساء[اًا]?|بالليل)?/.exec(asciiText);
  if (explicitHour) {
    let h = Number(explicitHour[1]);
    const min = explicitHour[2] ? Number(explicitHour[2]) : 0;
    const period = explicitHour[3] || '';
    if (/الظهر|الضهر|ظهر|ضهر|العصر|المغرب|مساء|بالليل/.test(period) && h < 12) h += 12;
    else if (!period && h >= 1 && h <= 7) h += 12;
    return { hour: Math.min(23, Math.max(0, h)), minute: min, precision: 'exact' };
  }
  if (/الصبح|صباح/.test(asciiText)) return { hour: 10, minute: 0, precision: 'day' };
  if (/الظهر|الضهر|ظهر|ضهر/.test(asciiText)) return { hour: 13, minute: 0, precision: 'day' };
  if (/العصر/.test(asciiText)) return { hour: 16, minute: 30, precision: 'day' };
  if (/المغرب/.test(asciiText)) return { hour: 18, minute: 0, precision: 'day' };
  if (/بالليل|مساء/.test(asciiText)) return { hour: 20, minute: 0, precision: 'day' };
  return { hour: 13, minute: 0, precision: 'day' };
}

export function parseEgyptianTemporalSignal(rawText, baseSentAtIso, senderRole = 'customer') {
  const text = cleanBidiControls(rawText);
  const ascii = toAsciiDigits(text);
  const dateOrigin = senderRole === 'broker' ? 'broker_scheduled' : 'customer_promised';
  const hasActionContext = /(?:كلمن[يى]|هكلمك|أكلمك|اكلمك|نتكلم|تواصل|نتواصل|أرد عليك|ارد عليك|هرد عليك|ميعاد|موعد|معاين[ةه]|نتقابل|ذكرن[يى]|فكرن[يى]|نتابع|أرجعلك|ارجعلك|شوفها|اشوفها|أشوفها)/.test(ascii);

  // 1) Ambiguous / non-fixed Egyptian expressions -> NEVER invent a confirmed date!
  const ambiguousPatterns = [
    { re: /بعد القبض/, phrase: 'بعد القبض' },
    { re: /بعد العيد/, phrase: 'بعد العيد' },
    { re: /لما [أا]فض[ىي]|اول ما [أا]فض[ىي]/, phrase: 'لما أفضى' },
    { re: /لما [أا]رجع من السفر|لما نرجع من السفر|بعد الرجوع من السفر|بعد السفر/, phrase: 'بعد الرجوع من السفر' },
    { re: /لما الظروف تسمح|حسب الظروف/, phrase: 'حسب الظروف' },
    { re: /قريب [إا]ن شاء الله|قريب ان شاء الله|[إا]ن شاء الله قريب/, phrase: 'قريب إن شاء الله' },
    { re: /هشوف و\s*[أا]رد عليك|أفكر و\s*[أا]رد|افكر و\s*[أا]رد/, phrase: 'هشوف وأرد عليك' },
    { re: /(?:[أا]ول|[آا]خر) الشهر(?!\s*\d)/, phrase: 'أول/آخر الشهر' },
  ];
  for (const amb of ambiguousPatterns) {
    if (amb.re.test(ascii)) {
      return {
        matched: true,
        is_ambiguous: true,
        phrase: amb.phrase,
        due_at: null,
        due_precision: 'ambiguous',
        date_origin: dateOrigin,
        confidence: 0.84,
      };
    }
  }

  const baseDate = baseSentAtIso ? new Date(baseSentAtIso) : new Date();
  if (Number.isNaN(baseDate.valueOf())) return null;
  const cairoBase = getCairoClock(baseDate);
  const hourHint = extractHourHintCairo(ascii);

  // 2) Clear relative Egyptian expressions resolved in Africa/Cairo
  if (/بعد بكر[ةه]/.test(ascii) && (hasActionContext || ascii.length <= 90)) {
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'بعد بكرة',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + 2, hourHint.hour, hourHint.minute),
      due_precision: hourHint.precision,
      date_origin: dateOrigin,
      confidence: 0.91,
    };
  }

  if (/(?:بكر[ةه]|غد[اًا])/.test(ascii) && (hasActionContext || ascii.length <= 90)) {
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'بكرة',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + 1, hourHint.hour, hourHint.minute),
      due_precision: hourHint.precision,
      date_origin: dateOrigin,
      confidence: 0.93,
    };
  }

  if (/(?:الأسبوع الجا[يى]|الاسبوع الجا[يى]|الأسبوع القادم|الاسبوع القادم)/.test(ascii)) {
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'الأسبوع الجاي',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + 7, hourHint.hour, hourHint.minute),
      due_precision: 'day',
      date_origin: dateOrigin,
      confidence: 0.88,
    };
  }

  if (/[أا]ول الأسبوع|[أا]ول الاسبوع/.test(ascii)) {
    const baseDow = new Date(Date.UTC(cairoBase.year, cairoBase.month - 1, cairoBase.day)).getUTCDay();
    const daysUntilSat = ((6 - baseDow + 7) % 7) || 7;
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'أول الأسبوع',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + daysUntilSat, hourHint.hour, hourHint.minute),
      due_precision: 'day',
      date_origin: dateOrigin,
      confidence: 0.86,
    };
  }

  if (/(?:آخر الأسبوع|اخر الاسبوع|نهاي[ةه] الأسبوع|نهاي[ةه] الاسبوع)/.test(ascii)) {
    const baseDow = new Date(Date.UTC(cairoBase.year, cairoBase.month - 1, cairoBase.day)).getUTCDay();
    const daysUntilThu = ((4 - baseDow + 7) % 7) || 7;
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'آخر الأسبوع',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + daysUntilThu, hourHint.hour, hourHint.minute),
      due_precision: 'day',
      date_origin: dateOrigin,
      confidence: 0.85,
    };
  }

  if (hasActionContext) {
    for (const wd of WEEKDAY_MAP) {
      if (wd.re.test(ascii)) {
        const baseDow = new Date(Date.UTC(cairoBase.year, cairoBase.month - 1, cairoBase.day)).getUTCDay();
        const delta = ((wd.dow - baseDow + 7) % 7) || 7;
        return {
          matched: true,
          is_ambiguous: false,
          phrase: `يوم ${wd.label}`,
          due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day + delta, hourHint.hour, hourHint.minute),
          due_precision: hourHint.precision,
          date_origin: dateOrigin,
          confidence: 0.89,
        };
      }
    }
  }

  if (/(?:النهارده|اليوم)\s*(?:بالليل|مساء|العصر|المغرب)/.test(ascii) && hasActionContext) {
    return {
      matched: true,
      is_ambiguous: false,
      phrase: 'اليوم',
      due_at: cairoLocalToUtcIso(cairoBase.year, cairoBase.month, cairoBase.day, hourHint.hour, hourHint.minute),
      due_precision: hourHint.precision,
      date_origin: dateOrigin,
      confidence: 0.87,
    };
  }

  return null;
}

function parsePriceEgpFromMessage(asciiText) {
  const scrubbed = asciiText.replaceAll(/(?:\+?20|0020)?0?1[0125]\d{8}/g, ' ');
  const mMillionHalf = /(\d{1,2})\s*مليون\s*و\s*نص/.exec(scrubbed);
  if (mMillionHalf) return Number(mMillionHalf[1]) * 1_000_000 + 500_000;
  const mMillion = /(\d{1,3}(?:\.\d{1,3})?)\s*مليون/.exec(scrubbed);
  if (mMillion) return Math.round(Number(mMillion[1]) * 1_000_000);
  const mThousand = /(\d{2,4})\s*(?:ألف|الف)\b/.exec(scrubbed);
  if (mThousand) {
    const val = Number(mThousand[1]) * 1_000;
    if (val >= 5_000) return val;
  }
  return null;
}

function parseSizeM2FromMessage(asciiText) {
  const m = /\b(\d{2,4})\s*(?:متر|م2|م²)\b/.exec(asciiText);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 35 && v <= 2500 ? v : null;
}

function parseAreaFromMessage(text) {
  for (const area of NASR_AREAS_PATTERNS) {
    if (text.includes(area)) return area;
  }
  return null;
}

function parsePropertyTypeFromMessage(text) {
  if (/مقر\s*[إا]دار[يى]|[إا]دار[يى]|مكتب/.test(text)) return 'مقر إداري';
  if (/محل|تجار[يى]/.test(text)) return 'محل تجاري';
  if (/عياد[ةه]/.test(text)) return 'عيادة';
  if (/دوبلكس/.test(text)) return 'دوبلكس';
  if (/فيلا|توين/.test(text)) return 'فيلا';
  if (/شاليه/.test(text)) return 'شاليه';
  if (/شقة مفروش[ةه]|شقه مفروش[ةه]|مفروش/.test(text)) return 'شقة مفروشة';
  if (/شق[ةه]|شقق/.test(text)) return 'شقة';
  return null;
}

function parseCustomerRequestSpec(msg) {
  if (msg.sender_role !== 'customer') return null;
  const text = msg.body_text || '';
  if (!text || text.includes('تم حذف هذه الرسالة') || text.includes('<تم استبعاد الوسائط>')) return null;
  const ascii = toAsciiDigits(text);
  const budget = parsePriceEgpFromMessage(ascii);
  const sizeM2 = parseSizeM2FromMessage(ascii);
  const area = parseAreaFromMessage(text);
  const propType = parsePropertyTypeFromMessage(text);
  const signalCount = [budget, sizeM2, area, propType].filter(Boolean).length;
  if (signalCount === 0) return null;

  let intent = null;
  if (/(?:مطلوب|عايز [أا]شتري|عاوز [أا]شتري|[أا]بحث عن|بدور عل[ىي]|ميزانيت[يى]|شراء)/.test(text)) {
    intent = /(?:إيجار|ايجار|مفروش)/.test(text) ? 'rent' : 'buy';
  } else if (/(?:للبيع|عندي شق[ةه]|عندى شق[ةه]|مالك|أبيع|ابيع)/.test(text)) {
    intent = 'sell';
  } else if (/(?:للإيجار|للايجار)/.test(text)) {
    intent = 'lease';
  }

  return {
    message_id: msg.id || null,
    seq_no: msg.seq_no,
    sent_at: msg.sent_at,
    budget_egp: budget,
    size_m2: sizeM2,
    area_label: area,
    property_type: propType,
    intent,
    excerpt: shortExcerpt(text),
    confidence: Math.min(0.95, 0.58 + signalCount * 0.1),
  };
}

export function shortExcerpt(text, maxLen = 150) {
  const cleaned = cleanBidiControls(text).replaceAll(/\s+/g, ' ');
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function isMediaOrNoiseOnly(text) {
  const c = cleanBidiControls(text);
  return !c || /^<تم استبعاد الوسائط>$|^<Media omitted>$|^تم حذف هذه الرسالة\.?$/i.test(c);
}

function detectViewingRequest(messages) {
  let latest = null;
  for (const msg of messages) {
    if (msg.sender_role !== 'customer' || isMediaOrNoiseOnly(msg.body_text)) continue;
    if (/(?:معاين[ةه]|نعاين|[أا]عاين|عايز [أا]شوف|عاوز [أا]شوف|ممكن نشوف|ننزل نشوف|[أا]شوف الشق[ةه]|[أا]شوف العقار|موعد معاين[ةه]|ميعاد معاين[ةه]|نتقابل نشوف)/.test(msg.body_text)) {
      latest = {
        message_id: msg.id || null,
        seq_no: msg.seq_no,
        sent_at: msg.sent_at,
        excerpt: shortExcerpt(msg.body_text),
        confidence: 0.9,
      };
    }
  }
  return latest;
}

function detectBrokerOffer(messages) {
  let latest = null;
  for (const msg of messages) {
    if (msg.sender_role !== 'broker' || isMediaOrNoiseOnly(msg.body_text)) continue;
    const hasSiteLink = (msg.links || []).some(l => l.is_site_property || l.url.includes('/properties/'));
    const ascii = toAsciiDigits(msg.body_text);
    const hasOfferSpecs = Boolean(parsePriceEgpFromMessage(ascii) && (parseSizeM2FromMessage(ascii) || parsePropertyTypeFromMessage(msg.body_text)));
    if (hasSiteLink || hasOfferSpecs || /(?:اتفضل تفاصيل|إليك تفاصيل|عرض مناسب لطلبك|دي تفاصيل الشق[ةه])/.test(msg.body_text)) {
      latest = {
        message_id: msg.id || null,
        seq_no: msg.seq_no,
        sent_at: msg.sent_at,
        has_site_link: hasSiteLink,
        excerpt: shortExcerpt(msg.body_text),
        confidence: hasSiteLink ? 0.94 : 0.82,
      };
    }
  }
  return latest;
}

function detectSpecChanges(customerSpecs, linkedOpp, mergedRequest = null) {
  if (customerSpecs.length === 0) return null;
  const latest = mergedRequest || customerSpecs[customerSpecs.length - 1];

  // Compare against linked CRM opportunity first if available, or earlier customer spec in the conversation
  if (linkedOpp) {
    const oppBudget = Number(linkedOpp.budget_max || linkedOpp.budget_min || 0);
    const oppSize = Number(linkedOpp.size_max_m2 || linkedOpp.size_min_m2 || 0);
    const oppArea = cleanBidiControls(linkedOpp.area_label || '');
    const diffs = [];
    if (latest.budget_egp && oppBudget > 0 && Math.abs(latest.budget_egp - oppBudget) / oppBudget >= 0.1) {
      diffs.push(`الميزانية من ${oppBudget.toLocaleString('en-US')} إلى ${latest.budget_egp.toLocaleString('en-US')} ج.م`);
    }
    if (latest.size_m2 && oppSize > 0 && Math.abs(latest.size_m2 - oppSize) >= 20) {
      diffs.push(`المساحة من ${oppSize} م² إلى ${latest.size_m2} م²`);
    }
    if (latest.area_label && oppArea && !oppArea.includes(latest.area_label) && !latest.area_label.includes(oppArea)) {
      diffs.push(`المنطقة من «${oppArea}» إلى «${latest.area_label}»`);
    }
    if (diffs.length > 0) {
      return {
        message_id: latest.message_id,
        seq_no: latest.seq_no,
        sent_at: latest.sent_at,
        changes: diffs,
        proposed_spec: latest,
        excerpt: latest.excerpt,
        confidence: 0.88,
      };
    }
  }

  if (customerSpecs.length >= 2) {
    const firstWithBudget = customerSpecs.find(s => s.budget_egp);
    const firstWithArea = customerSpecs.find(s => s.area_label);
    const firstWithSize = customerSpecs.find(s => s.size_m2);
    const diffs = [];
    if (firstWithBudget && latest.budget_egp && latest.seq_no > firstWithBudget.seq_no && Math.abs(latest.budget_egp - firstWithBudget.budget_egp) / firstWithBudget.budget_egp >= 0.1) {
      diffs.push(`تعديل الميزانية في المحادثة من ${firstWithBudget.budget_egp.toLocaleString('en-US')} إلى ${latest.budget_egp.toLocaleString('en-US')} ج.م`);
    }
    if (firstWithSize && latest.size_m2 && latest.seq_no > firstWithSize.seq_no && Math.abs(latest.size_m2 - firstWithSize.size_m2) >= 20) {
      diffs.push(`تعديل المساحة المطلوبة من ${firstWithSize.size_m2} م² إلى ${latest.size_m2} م²`);
    }
    if (firstWithArea && latest.area_label && latest.seq_no > firstWithArea.seq_no && firstWithArea.area_label !== latest.area_label) {
      diffs.push(`تغيير المنطقة المفضلة من «${firstWithArea.area_label}» إلى «${latest.area_label}»`);
    }
    if (diffs.length > 0) {
      return {
        message_id: latest.message_id,
        seq_no: latest.seq_no,
        sent_at: latest.sent_at,
        changes: diffs,
        proposed_spec: latest,
        excerpt: latest.excerpt,
        confidence: 0.85,
      };
    }
  }
  return null;
}

function detectUnansweredCustomerQuestion(userMessages) {
  if (!userMessages.length) return null;
  const tailCustomer = [];
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const m = userMessages[i];
    if (m.sender_role === 'broker') break;
    if (m.sender_role === 'customer' && !isMediaOrNoiseOnly(m.body_text)) {
      tailCustomer.unshift(m);
    }
  }
  if (!tailCustomer.length) return null;
  for (let i = tailCustomer.length - 1; i >= 0; i -= 1) {
    const m = tailCustomer[i];
    const t = m.body_text;
    const hasQuestion = /[؟?]/.test(t) || /(?:بكام|كام المطلوب|السعر كام|متاح[ةه]?|موجود[ةه]?|الدور الكام|فيها رخص[ةه]|حص[ةه] في الأرض|تفاصيل|العنوان فين|المكان فين|قابل للتفاوض|آخر كلام|اخر كلام|غالي|السعر عالي)/.test(t);
    if (hasQuestion) {
      return {
        message_id: m.id || null,
        seq_no: m.seq_no,
        sent_at: m.sent_at,
        excerpt: shortExcerpt(t),
        confidence: /[؟?]/.test(t) ? 0.92 : 0.83,
      };
    }
  }
  return null;
}

export function analyzeMessagesDeterministic(messages, { linkedOpp = null, hasLoggedViewingAfter = false, hasNewerActivityAfter = false, now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const userMessages = messages.filter(m => m.sender_role === 'customer' || m.sender_role === 'broker');
  const customerMessages = userMessages.filter(m => m.sender_role === 'customer' && !isMediaOrNoiseOnly(m.body_text));
  const brokerMessages = userMessages.filter(m => m.sender_role === 'broker' && !isMediaOrNoiseOnly(m.body_text));

  const datedAll = userMessages.map(m => m.sent_at).filter(Boolean);
  const datedCustomer = customerMessages.map(m => m.sent_at).filter(Boolean);
  const datedBroker = brokerMessages.map(m => m.sent_at).filter(Boolean);

  const lastContactAt = datedAll.length ? datedAll[datedAll.length - 1] : null;
  const lastCustomerMessageAt = datedCustomer.length ? datedCustomer[datedCustomer.length - 1] : null;
  const lastBrokerMessageAt = datedBroker.length ? datedBroker[datedBroker.length - 1] : null;

  // Merge cumulative confirmed request specs from customer messages while tracking spec changes
  const customerSpecs = customerMessages.map(parseCustomerRequestSpec).filter(Boolean);
  const mergedRequest = customerSpecs.length
    ? customerSpecs.reduce((acc, item) => ({
      message_id: item.message_id || acc.message_id,
      seq_no: item.seq_no,
      sent_at: item.sent_at || acc.sent_at,
      budget_egp: item.budget_egp ?? acc.budget_egp ?? null,
      size_m2: item.size_m2 ?? acc.size_m2 ?? null,
      area_label: item.area_label ?? acc.area_label ?? null,
      property_type: item.property_type ?? acc.property_type ?? null,
      intent: item.intent ?? acc.intent ?? null,
      excerpt: item.excerpt,
      confidence: Math.max(acc.confidence || 0, item.confidence),
    }), {})
    : null;

  const specChange = detectSpecChanges(customerSpecs, linkedOpp, mergedRequest);
  const lastOfferSent = detectBrokerOffer(userMessages);
  const viewingRequest = detectViewingRequest(userMessages);

  // Temporal / callback promise detection across messages (keep most recent relevant signal)
  let callbackPromise = null;
  for (const msg of userMessages) {
    if (isMediaOrNoiseOnly(msg.body_text)) continue;
    const temporal = parseEgyptianTemporalSignal(msg.body_text, msg.sent_at, msg.sender_role);
    if (temporal?.matched) {
      const repliedAfter = userMessages.some(later => later.seq_no > msg.seq_no && later.sent_at && temporal.due_at && Date.parse(later.sent_at) >= Date.parse(temporal.due_at));
      if (!repliedAfter) {
        callbackPromise = {
          ...temporal,
          message_id: msg.id || null,
          seq_no: msg.seq_no,
          source_message_at: msg.sent_at,
          excerpt: shortExcerpt(msg.body_text),
        };
      }
    }
  }

  const unansweredQuestion = hasNewerActivityAfter ? null : detectUnansweredCustomerQuestion(userMessages);

  // Stalled high-interest check
  let stalledStatus = null;
  const lastContactMs = lastContactAt ? Date.parse(lastContactAt) : null;
  const daysSilent = lastContactMs ? (nowMs - lastContactMs) / 86_400_000 : 0;
  const hasStrongInterest = customerMessages.some(m => /(?:مناسب|معاين[ةه]|نعاين|جاد|كاش|تفاوض|عجبان[يى]|أشوف|اشوف|مهتم|جاهز للتعاقد)/.test(m.body_text));
  const oppClosed = linkedOpp && ['won', 'lost', 'unqualified'].includes(linkedOpp.status);
  const oppFutureScheduled = linkedOpp?.next_followup_at && parseFollowupInstantMs(linkedOpp.next_followup_at) > nowMs;
  if (hasStrongInterest && daysSilent >= 5 && !oppClosed && !oppFutureScheduled && !hasNewerActivityAfter) {
    const anchorMsg = customerMessages[customerMessages.length - 1];
    stalledStatus = {
      message_id: anchorMsg?.id || null,
      seq_no: anchorMsg?.seq_no || 0,
      sent_at: anchorMsg?.sent_at || lastContactAt,
      days_silent: Math.floor(daysSilent),
      excerpt: shortExcerpt(anchorMsg?.body_text || ''),
      confidence: 0.84,
    };
  }

  // Build candidate smart alerts
  const alerts = [];

  if (unansweredQuestion) {
    alerts.push({
      alert_type: 'unanswered_question',
      priority: 'high',
      message_id: unansweredQuestion.message_id,
      source_message_at: unansweredQuestion.sent_at,
      excerpt: unansweredQuestion.excerpt,
      alert_reason: 'سؤال أو استفسار مباشر من العميل في نهاية المحادثة لم يُرد عليه بعد',
      suggested_action: 'الرد على سؤال العميل عبر واتساب أو الاتصال الهاتفي وتوضيح التفاصيل المطلوبة',
      confidence: unansweredQuestion.confidence,
      due_at: now instanceof Date ? now.toISOString() : new Date(nowMs).toISOString(),
      due_precision: 'day',
      date_origin: 'system',
    });
  }

  if (viewingRequest) {
    const brokerConfirmedViewing = userMessages.some(
      m => m.seq_no > viewingRequest.seq_no && m.sender_role === 'broker' && /(?:تم تحديد|ميعادنا|نتقابل الساع[ةه]|أكدنا المعاين[ةه])/.test(m.body_text),
    );
    const oppHasScheduledVisit = linkedOpp && linkedOpp.status === 'visit_scheduled';
    if (!hasLoggedViewingAfter && !oppHasScheduledVisit && !brokerConfirmedViewing) {
      alerts.push({
        alert_type: 'viewing_requested_unlogged',
        priority: 'high',
        message_id: viewingRequest.message_id,
        source_message_at: viewingRequest.sent_at,
        excerpt: viewingRequest.excerpt,
        alert_reason: 'العميل طلب معاينة عقار في المحادثة دون وجود معاينة مسجلة في جدول المتابعة',
        suggested_action: 'تأكيد موعد المعاينة مع المالك والعميل وتسجيلها كمعاينة مجدولة في الـCRM',
        confidence: viewingRequest.confidence,
        due_at: viewingRequest.sent_at,
        due_precision: 'day',
        date_origin: 'customer_promised',
      });
    }
  }

  if (lastOfferSent && !hasNewerActivityAfter) {
    const anyAfterOffer = userMessages.some(m => m.seq_no > lastOfferSent.seq_no);
    const offerMs = lastOfferSent.sent_at ? Date.parse(lastOfferSent.sent_at) : null;
    const hoursSinceOffer = offerMs ? (nowMs - offerMs) / 3_600_000 : 48;
    if (!anyAfterOffer && hoursSinceOffer >= 24) {
      alerts.push({
        alert_type: 'offer_sent_no_followup',
        priority: 'normal',
        message_id: lastOfferSent.message_id,
        source_message_at: lastOfferSent.sent_at,
        excerpt: lastOfferSent.excerpt,
        alert_reason: 'تم إرسال عرض عقاري للعميل ومرت أكثر من 24 ساعة دون رد أو متابعة لاحقة',
        suggested_action: 'إرسال رسالة متابعة لمعرفة رأي العميل في العرض المرسل أو ترشيح بديل أقرب',
        confidence: lastOfferSent.confidence,
        due_at: lastOfferSent.sent_at,
        due_precision: 'day',
        date_origin: 'broker_scheduled',
      });
    }
  }

  if (specChange) {
    alerts.push({
      alert_type: 'request_specs_changed',
      priority: 'normal',
      message_id: specChange.message_id,
      source_message_at: specChange.sent_at,
      excerpt: specChange.excerpt,
      alert_reason: `تغيّر مواصفات طلب العميل في الرسائل الأحدث (${specChange.changes.join(' · ')}) — يحتاج مراجعة وتأكيد يدوي`,
      suggested_action: 'مراجعة المواصفات الجديدة وتحديث الفرصة يدويًا بعد التأكيد وإعادة فحص العقارات المطابقة',
      confidence: specChange.confidence,
      due_at: null,
      due_precision: 'none',
      date_origin: 'system',
      metadata: { changes: specChange.changes, proposed_spec: specChange.proposed_spec },
    });
  }

  if (callbackPromise && !hasNewerActivityAfter) {
    const originAr = callbackPromise.date_origin === 'broker_scheduled'
      ? 'موعد حدده طارق للمتابعة'
      : 'وعد من العميل بالتواصل/الرد';
    if (callbackPromise.is_ambiguous) {
      alerts.push({
        alert_type: 'needs_followup',
        priority: 'normal',
        message_id: callbackPromise.message_id,
        source_message_at: callbackPromise.source_message_at,
        excerpt: callbackPromise.excerpt,
        alert_reason: `${originAr} بتعبير زمني غير محدد («${callbackPromise.phrase}») يحتاج مراجعة وتقدير موعد متابعة يدوي`,
        suggested_action: 'مراجعة المحادثة وتحديد تاريخ تذكير تقديري مناسب دون افتراض موعد مؤكد',
        confidence: callbackPromise.confidence,
        due_at: null,
        due_precision: 'ambiguous',
        date_origin: callbackPromise.date_origin,
        metadata: { phrase: callbackPromise.phrase },
      });
    } else if (callbackPromise.due_at) {
      const dueMs = Date.parse(callbackPromise.due_at);
      const diffHours = (dueMs - nowMs) / 3_600_000;
      let alertType = 'needs_followup';
      let priority = 'normal';
      let timingDesc = `موعد مستقبلي (${callbackPromise.phrase})`;
      if (dueMs < nowMs) {
        alertType = 'followup_overdue';
        priority = 'high';
        timingDesc = `موعد متابعة متأخر (${callbackPromise.phrase})`;
      } else if (diffHours <= 24) {
        alertType = 'followup_approaching';
        priority = 'high';
        timingDesc = `موعد متابعة يقترب خلال ساعات (${callbackPromise.phrase})`;
      }
      alerts.push({
        alert_type: alertType,
        priority,
        message_id: callbackPromise.message_id,
        source_message_at: callbackPromise.source_message_at,
        excerpt: callbackPromise.excerpt,
        alert_reason: `${originAr} — ${timingDesc}`,
        suggested_action: callbackPromise.date_origin === 'broker_scheduled'
          ? 'تنفيذ المتابعة التي تم الاتفاق عليها مع العميل في الموعد المحدد'
          : 'التواصل الهادئ مع العميل وفق الموعد الذي وعد بالرد فيه',
        confidence: callbackPromise.confidence,
        due_at: callbackPromise.due_at,
        due_precision: callbackPromise.due_precision,
        date_origin: callbackPromise.date_origin,
        metadata: { phrase: callbackPromise.phrase },
      });
    }
  }

  if (stalledStatus) {
    alerts.push({
      alert_type: 'high_interest_stalled',
      priority: 'normal',
      message_id: stalledStatus.message_id,
      source_message_at: stalledStatus.sent_at,
      excerpt: stalledStatus.excerpt,
      alert_reason: `عميل أبدى اهتمامًا واضحًا وتوقفت المحادثة منذ ${stalledStatus.days_silent} يومًا دون خطوة تالية مجدولة`,
      suggested_action: 'إعادة تنشيط العميل بعرض محدث أو سؤال مختصر عن استمرار الطلب',
      confidence: stalledStatus.confidence,
      due_at: null,
      due_precision: 'none',
      date_origin: 'system',
      metadata: { days_silent: stalledStatus.days_silent },
    });
  }

  const topConfidence = alerts.length
    ? Math.max(...alerts.map(a => a.confidence))
    : (mergedRequest?.confidence || 0.7);
  const anchorSourceMsgId = alerts[0]?.message_id || mergedRequest?.message_id || (userMessages[userMessages.length - 1]?.id ?? null);

  return {
    lastContactAt,
    lastCustomerMessageAt,
    lastBrokerMessageAt,
    lastConfirmedRequest: mergedRequest,
    lastOfferSent,
    viewingRequest,
    callbackPromise,
    unansweredQuestion,
    stalledStatus,
    specChange,
    confidence: Number(topConfidence.toFixed(2)),
    sourceMessageId: anchorSourceMsgId,
    alerts,
  };
}

async function syncOpportunityConversationRef(db, oppId, convId) {
  if (!oppId || !convId) return;
  try {
    await db.prepare(
      'UPDATE crm_opportunities SET conversation_id = COALESCE(conversation_id, ?) WHERE id = ?',
    ).bind(convId, oppId).run();
  } catch {
    // Pre-0006 schema without conversation_id column on crm_opportunities.
  }
}

async function upsertSingleSmartAlert(db, {
  convId,
  resolvedContactId,
  resolvedOppId,
  resolvedCustomerName,
  alert,
  nowIso,
}) {
  const dConv = convId || '0';
  const dMsg = alert.message_id || '0';
  const dContact = resolvedContactId || '0';
  let existingAlert = await db.prepare(
    `SELECT id, status FROM crm_smart_alerts
     WHERE dedupe_conversation_key = ? AND dedupe_message_key = ? AND dedupe_contact_key = ? AND alert_type = ?
     LIMIT 1`,
  ).bind(dConv, dMsg, dContact, alert.alert_type).first();

  if (!existingAlert && resolvedContactId) {
    existingAlert = await db.prepare(
      `SELECT id, status FROM crm_smart_alerts
       WHERE dedupe_conversation_key = ? AND dedupe_message_key = ? AND dedupe_contact_key = '0' AND alert_type = ?
       LIMIT 1`,
    ).bind(dConv, dMsg, alert.alert_type).first();
  }

  if (existingAlert) {
    if (existingAlert.status === 'open') {
      await db.prepare(
        `UPDATE crm_smart_alerts SET
          contact_id = ?, dedupe_contact_key = ?, opportunity_id = ?, priority = ?, customer_name = ?,
          alert_reason = ?, due_at = ?, due_precision = ?, date_origin = ?,
          confidence = ?, rule_version = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      ).bind(
        resolvedContactId,
        dContact,
        resolvedOppId,
        alert.priority,
        resolvedCustomerName,
        alert.alert_reason,
        alert.due_at,
        alert.due_precision || 'none',
        alert.date_origin || 'system',
        alert.confidence,
        CURRENT_RULE_VERSION,
        nowIso,
        existingAlert.id,
      ).run();
    }
    return 0;
  }

  await db.prepare(
    `INSERT INTO crm_smart_alerts(
      id, conversation_id, message_id, contact_id, opportunity_id,
      dedupe_conversation_key, dedupe_message_key, dedupe_contact_key,
      alert_type, status, priority, customer_name, alert_reason,
      source_message_at, excerpt, suggested_action, confidence,
      due_at, due_precision, date_origin, metadata_json, rule_version,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    crypto.randomUUID(),
    convId,
    alert.message_id || null,
    resolvedContactId,
    resolvedOppId,
    dConv,
    dMsg,
    dContact,
    alert.alert_type,
    alert.priority || 'normal',
    resolvedCustomerName,
    alert.alert_reason,
    alert.source_message_at || null,
    alert.excerpt || '',
    alert.suggested_action,
    alert.confidence,
    alert.due_at || null,
    alert.due_precision || 'none',
    alert.date_origin || 'system',
    JSON.stringify(alert.metadata || {}),
    CURRENT_RULE_VERSION,
    nowIso,
    nowIso,
  ).run();
  return 1;
}

export async function upsertConversationAndAnalyze(db, {
  conversationUid,
  contactId = null,
  opportunityId = null,
  customerName = '',
  sourceType = 'whatsapp_export',
  sourceRef = '',
  chatTitle = '',
  rawText = '',
  matchStatus = 'matched',
  matchMethod = '',
  reviewReason = '',
  now = new Date(),
  forceAnalyze = false,
}) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const parsed = await parseWhatsAppExport(rawText, { chatTitle });
  const uid = conversationUid || `conv:${await sha256HexText(`${parsed.chatTitle}\n${parsed.rawSha256}`)}`;

  const existing = await db.prepare(
    'SELECT id, contact_id, opportunity_id, match_status, raw_sha256, analyzed_rule_version FROM crm_conversations WHERE conversation_uid = ? LIMIT 1',
  ).bind(uid).first();

  const resolvedContactId = contactId || existing?.contact_id || null;
  let resolvedOppId = opportunityId || existing?.opportunity_id || null;
  if (!resolvedOppId && existing?.id) {
    try {
      const byConv = await db.prepare(
        'SELECT id FROM crm_opportunities WHERE conversation_id = ? LIMIT 1',
      ).bind(existing.id).first();
      if (byConv?.id) resolvedOppId = byConv.id;
    } catch {
      // Pre-0006 schema without conversation_id column on crm_opportunities.
    }
  }
  if (!resolvedOppId && resolvedContactId) {
    const oppRow = await db.prepare(
      'SELECT id FROM crm_opportunities WHERE contact_id = ? ORDER BY updated_at DESC LIMIT 2',
    ).bind(resolvedContactId).all();
    if (oppRow?.results?.length === 1) {
      resolvedOppId = oppRow.results[0].id;
    }
  }

  const effectiveMatchStatus = resolvedContactId
    ? (existing?.match_status === 'resolved_manual' ? 'resolved_manual' : 'matched')
    : (matchStatus || 'unmatched_review');

  // Incremental fast-path: skip full message/insight rewrite if raw text, linkage, and rule version are unchanged!
  if (
    existing
    && !forceAnalyze
    && existing.raw_sha256 === parsed.rawSha256
    && existing.analyzed_rule_version === CURRENT_RULE_VERSION
    && (existing.contact_id || null) === resolvedContactId
    && (existing.opportunity_id || null) === resolvedOppId
  ) {
    return {
      conversation_id: existing.id,
      conversation_uid: uid,
      created: false,
      incremental_skipped: true,
      message_count: parsed.messages.length,
      parse_warnings: parsed.parseWarnings,
      alerts_created: 0,
    };
  }

  const convId = existing?.id || crypto.randomUUID();
  if (!existing) {
    await db.prepare(
      `INSERT INTO crm_conversations(
        id, conversation_uid, contact_id, opportunity_id, source_type, source_ref,
        chat_title, peer_sender_name, match_status, match_method, review_reason,
        raw_text, raw_sha256, message_count, first_message_at, last_message_at,
        parse_warnings_json, analyzed_at, analyzed_rule_version, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      convId,
      uid,
      resolvedContactId,
      resolvedOppId,
      sourceType,
      sourceRef,
      parsed.chatTitle,
      parsed.peerSenderName,
      effectiveMatchStatus,
      matchMethod,
      reviewReason,
      parsed.rawText,
      parsed.rawSha256,
      parsed.messages.length,
      parsed.firstMessageAt,
      parsed.lastMessageAt,
      JSON.stringify(parsed.parseWarnings),
      nowIso,
      CURRENT_RULE_VERSION,
      nowIso,
      nowIso,
    ).run();
  } else {
    await db.prepare(
      `UPDATE crm_conversations SET
        contact_id = ?, opportunity_id = ?, source_ref = COALESCE(NULLIF(?, ''), source_ref),
        chat_title = ?, peer_sender_name = ?, match_status = ?, match_method = COALESCE(NULLIF(?, ''), match_method),
        review_reason = ?, raw_text = ?, raw_sha256 = ?, message_count = ?,
        first_message_at = ?, last_message_at = ?, parse_warnings_json = ?,
        analyzed_at = ?, analyzed_rule_version = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      resolvedContactId,
      resolvedOppId,
      sourceRef,
      parsed.chatTitle,
      parsed.peerSenderName,
      effectiveMatchStatus,
      matchMethod,
      reviewReason,
      parsed.rawText,
      parsed.rawSha256,
      parsed.messages.length,
      parsed.firstMessageAt,
      parsed.lastMessageAt,
      JSON.stringify(parsed.parseWarnings),
      nowIso,
      CURRENT_RULE_VERSION,
      nowIso,
      convId,
    ).run();
  }

  // Upsert messages deterministically by message_uid (incremental for appended messages!)
  const existingMsgsRes = await db.prepare(
    'SELECT id, message_uid, seq_no FROM crm_conversation_messages WHERE conversation_id = ?',
  ).bind(convId).all();
  const msgIdByUid = new Map((existingMsgsRes?.results || []).map(r => [r.message_uid, r.id]));

  const newMsgRows = [];
  const enrichedMessages = [];
  for (const m of parsed.messages) {
    const msgUid = await sha256HexText(`${uid}:${m.seq_no}:${m.raw_timestamp_text}:${m.sender_label}:${m.body_text}`);
    let msgId = msgIdByUid.get(msgUid);
    if (!msgId) {
      msgId = crypto.randomUUID();
      msgIdByUid.set(msgUid, msgId);
      newMsgRows.push([
        msgId,
        convId,
        msgUid,
        m.seq_no,
        m.sender_role,
        m.sender_label,
        m.sent_at,
        m.raw_timestamp_text,
        m.body_text,
        JSON.stringify(m.links || []),
        nowIso,
      ]);
    }
    enrichedMessages.push({ ...m, id: msgId, message_uid: msgUid });
  }

  // Group into multi-row INSERTs of up to 8 rows (88 <= 100 D1 bound parameters) and batch in chunks of 40
  const msgBatch = [];
  for (let i = 0; i < newMsgRows.length; i += 8) {
    const slice = newMsgRows.slice(i, i + 8);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
    msgBatch.push(
      db.prepare(
        `INSERT OR IGNORE INTO crm_conversation_messages(
          id, conversation_id, message_uid, seq_no, sender_role, sender_label,
          sent_at, raw_timestamp_text, body_text, links_json, created_at
        ) VALUES ${placeholders}`,
      ).bind(...slice.flat()),
    );
  }
  for (let i = 0; i < msgBatch.length; i += 40) {
    await db.batch(msgBatch.slice(i, i + 40));
  }

  // Load linked opportunity & recent CRM activities to avoid false-positive alerts
  let linkedOpp = null;
  let hasLoggedViewingAfter = false;
  let hasNewerActivityAfter = false;
  if (resolvedOppId) {
    linkedOpp = await db.prepare('SELECT * FROM crm_opportunities WHERE id = ? LIMIT 1').bind(resolvedOppId).first();
    if (linkedOpp) {
      const actRow = await db.prepare(
        `SELECT MAX(CASE WHEN source_ref IN ('crm_ui', 'smart_alert_resolution') AND activity_type IN ('call', 'whatsapp_note', 'visit', 'offer') THEN created_at ELSE NULL END) AS latest_act,
                MAX(CASE WHEN activity_type = 'visit' THEN created_at ELSE NULL END) AS latest_visit
         FROM crm_activities WHERE opportunity_id = ?`,
      ).bind(resolvedOppId).first();
      if (actRow?.latest_visit && (!parsed.lastMessageAt || Date.parse(actRow.latest_visit) >= Date.parse(parsed.lastMessageAt))) {
        hasLoggedViewingAfter = true;
      }
      if (actRow?.latest_act && parsed.lastMessageAt && Date.parse(actRow.latest_act) > Date.parse(parsed.lastMessageAt) + 60_000) {
        hasNewerActivityAfter = true;
      }
    }
  }

  let resolvedCustomerName = cleanBidiControls(customerName);
  if (!resolvedCustomerName && resolvedContactId) {
    const cRow = await db.prepare('SELECT name FROM crm_contacts WHERE id = ? LIMIT 1').bind(resolvedContactId).first();
    resolvedCustomerName = cleanBidiControls(cRow?.name || '');
  }
  if (!resolvedCustomerName) {
    resolvedCustomerName = parsed.chatTitle || parsed.peerSenderName || 'عميل محادثة قيد المراجعة';
  }

  const analysis = analyzeMessagesDeterministic(enrichedMessages, {
    linkedOpp,
    hasLoggedViewingAfter,
    hasNewerActivityAfter,
    now,
  });

  // Upsert crm_conversation_insights
  await db.prepare(
    `INSERT INTO crm_conversation_insights(
      id, conversation_id, contact_id, opportunity_id, last_contact_at,
      last_customer_message_at, last_broker_message_at, last_confirmed_request_json,
      last_offer_sent_json, viewing_request_json, callback_promise_json,
      unanswered_question_json, stalled_status_json, spec_change_json,
      confidence, source_message_id, analyzed_at, rule_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      opportunity_id = excluded.opportunity_id,
      last_contact_at = excluded.last_contact_at,
      last_customer_message_at = excluded.last_customer_message_at,
      last_broker_message_at = excluded.last_broker_message_at,
      last_confirmed_request_json = excluded.last_confirmed_request_json,
      last_offer_sent_json = excluded.last_offer_sent_json,
      viewing_request_json = excluded.viewing_request_json,
      callback_promise_json = excluded.callback_promise_json,
      unanswered_question_json = excluded.unanswered_question_json,
      stalled_status_json = excluded.stalled_status_json,
      spec_change_json = excluded.spec_change_json,
      confidence = excluded.confidence,
      source_message_id = excluded.source_message_id,
      analyzed_at = excluded.analyzed_at,
      rule_version = excluded.rule_version`,
  ).bind(
    crypto.randomUUID(),
    convId,
    resolvedContactId,
    resolvedOppId,
    analysis.lastContactAt,
    analysis.lastCustomerMessageAt,
    analysis.lastBrokerMessageAt,
    analysis.lastConfirmedRequest ? JSON.stringify(analysis.lastConfirmedRequest) : null,
    analysis.lastOfferSent ? JSON.stringify(analysis.lastOfferSent) : null,
    analysis.viewingRequest ? JSON.stringify(analysis.viewingRequest) : null,
    analysis.callbackPromise ? JSON.stringify(analysis.callbackPromise) : null,
    analysis.unansweredQuestion ? JSON.stringify(analysis.unansweredQuestion) : null,
    analysis.stalledStatus ? JSON.stringify(analysis.stalledStatus) : null,
    analysis.specChange ? JSON.stringify(analysis.specChange) : null,
    analysis.confidence,
    analysis.sourceMessageId,
    nowIso,
    CURRENT_RULE_VERSION,
  ).run();

  await syncOpportunityConversationRef(db, resolvedOppId, convId);

  const isTransientArchivedChat = (linkedOpp && linkedOpp.track === 'transient')
    || (!linkedOpp && parsed.chatTitle.includes('✈'));
  const alertsToPersist = isTransientArchivedChat ? [] : analysis.alerts;

  // Deduplicated Smart Alert insertion: NEVER re-open completed/dismissed alerts!
  let alertsCreated = 0;
  for (const alert of alertsToPersist) {
    alertsCreated += await upsertSingleSmartAlert(db, {
      convId,
      resolvedContactId,
      resolvedOppId,
      resolvedCustomerName,
      alert,
      nowIso,
    });
  }

  return {
    conversation_id: convId,
    conversation_uid: uid,
    created: !existing,
    incremental_skipped: false,
    message_count: parsed.messages.length,
    parse_warnings: parsed.parseWarnings,
    insight: {
      last_contact_at: analysis.lastContactAt,
      last_confirmed_request: analysis.lastConfirmedRequest,
      last_offer_sent: analysis.lastOfferSent,
      viewing_request: analysis.viewingRequest,
      callback_promise: analysis.callbackPromise,
      unanswered_question: analysis.unansweredQuestion,
      stalled_status: analysis.stalledStatus,
      spec_change: analysis.specChange,
      confidence: analysis.confidence,
      rule_version: CURRENT_RULE_VERSION,
    },
    alerts_created: alertsCreated,
  };
}
