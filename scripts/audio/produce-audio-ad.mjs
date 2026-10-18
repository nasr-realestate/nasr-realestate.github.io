#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/audio/produce-audio-ad.mjs — مسار إنتاج الإعلان الصوتي
 * ───────────────────────────────────────────────────────────────────
 *  يقرأ المواصفة المركزية `_data/voice_identity.json` ويطبّقها. الهدف:
 *  منع أي إعلان جديد من الانحراف عن مواصفة الملف والصوت الموثّقة، ومنع تغيير إعدادات
 *  الصوت/الوسوم تلقائيًا.
 *
 *  الأوامر:
 *    --plan     فحص نص الإعلان + طباعة كتلة front matter الجاهزة
 *    --tag      إعادة وسم MP3 خام إلى ID3v2.3 بالمواصفة (بلا إعادة ترميز)
 *    --verify   تحقّق كامل من ملف مُنتَج (وسوم + ترميز + مدة + نص)
 *    --record   قيد النتيجة في _data/audio_voice_log.json
 *
 *  ما لا يفعله هذا الملف عن قصد: لا يختار صوتًا ولا يولّد صوتًا.
 *  اختيار الصوت قرار المالك عبر add_voice في الجلسة، والتوليد عبر
 *  generate_speech. انظر governance.productionPipeline في المواصفة.
 *
 *  الاستخدام:
 *    node scripts/audio/produce-audio-ad.mjs --plan --property _properties/x.md --script-file /tmp/s.txt
 *    node scripts/audio/produce-audio-ad.mjs --tag   --property _properties/x.md --mp3 assets/audio/properties/<slug>.mp3 --script-file /tmp/s.txt
 *    node scripts/audio/produce-audio-ad.mjs --verify --mp3 assets/audio/properties/<slug>.mp3 --property _properties/x.md
 *    node scripts/audio/produce-audio-ad.mjs --record --property _properties/x.md --mp3 ... --script-file /tmp/s.txt \
 *         --cosine 0.9071 --voice-id voice-00 --auditions 2 --approval owner-in-session
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseFrontMatter } from '../lib/front-matter.mjs';
import { firstNumber } from '../lib/properties.mjs';
import {
  tagExtent, parseFrames, frameText, parseComm, buildTag, retag, scanMpeg,
} from './id3.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPEC_PATH = path.join(ROOT, '_data', 'voice_identity.json');
const LOG_PATH = path.join(ROOT, '_data', 'audio_voice_log.json');
/** توقيت الموقع كما هو مُعلن في _config.yml */
const SITE_TIMEZONE = 'Africa/Cairo';

// ── قراءة المعاملات ──────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const MODES = ['plan', 'tag', 'verify', 'record'];
const mode = MODES.find((m) => flag(m));
/**
 * هل الملف مُشغَّل مباشرةً أم مستورد؟
 * scripts/audio/verify-voice-identity.mjs يستورد verifyFile/checkScript من هنا،
 * فلا يجوز أن يعمل واجهة الأوامر أو تُنهي العملية عند الاستيراد.
 */
export const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
const warn = (msg) => { console.warn(`⚠️  ${msg}`); };
const ok = (msg) => { console.log(`✅ ${msg}`); };

if (IS_MAIN && !mode) {
  console.error('استخدم أحد الأوامر: --plan | --tag | --verify | --record');
  process.exit(2);
}

export const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

// ── أدوات النص ───────────────────────────────────────────────────────

/** تطبيع خفيف للمقارنة: إزالة التشكيل والتوحيد بين الألف/الهاء/الياء */
function normalize(s) {
  return String(s ?? '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim();
}

/**
 * هل تظهر العبارة ككلمات كاملة داخل النص المطبَّع؟
 * `\b` في JS لا يعرف حروف العربية، لذا يُفحص الجار يدويًا حتى لا تتطابق
 * «ان» داخل «تاني» أو «هل» داخل كلمة أخرى (إيجاب كاذب يُسقط إعلانًا سليمًا).
 */
const ARABIC_LETTER = /[\u0621-\u064A\u0660-\u0669]/;
function hasPhrase(normalizedText, phrase) {
  const needle = normalize(phrase);
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = normalizedText.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? normalizedText[at - 1] : ' ';
    const after = at + needle.length < normalizedText.length ? normalizedText[at + needle.length] : ' ';
    if (!ARABIC_LETTER.test(before) && !ARABIC_LETTER.test(after)) return true;
    from = at + 1;
  }
}

/** عدد الكلمات (المعيار الحقيقي للمدة: المرجع 58 كلمة / 26.664 ثانية) */
export function wordCount(s) {
  return String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

const REF_WORDS = 58;
const REF_SECONDS = SPEC.reference.durationSeconds;
const WORDS_PER_SECOND = REF_WORDS / REF_SECONDS;              // ≈ 2.176
const MAX_WORDS = Math.floor(SPEC.encoding.maxDurationSeconds * WORDS_PER_SECOND);

/**
 * قراءة الأرقام المكتوبة بالحروف المصرية → قيم رقمية.
 * استشاري: يكشف الأرقام المذكورة في النص لمقارنتها ببيانات العقار.
 */
const UNITS_RAW = {
  'واحد': 1, 'اتنين': 2, 'اثنين': 2, 'تلاتة': 3, 'ثلاثة': 3, 'تلته': 3, 'تلات': 3,
  'أربعة': 4, 'اربعة': 4, 'أربع': 4, 'اربع': 4, 'خمسة': 5, 'خمس': 5, 'ستة': 6, 'ست': 6,
  'سبعة': 7, 'سبع': 7, 'ثمانية': 8, 'تمانية': 8, 'تماني': 8, 'ثمان': 8, 'تسعة': 9, 'تسع': 9,
};
const TEENS_RAW = {
  'عشرة': 10, 'عشر': 10, 'حداشر': 11, 'اتناشر': 12, 'تناشر': 12, 'تلطعشر': 13, 'أربعتاشر': 14,
  'اربعتاشر': 14, 'خمستاشر': 15, 'ستاشر': 16, 'سبعتاشر': 17, 'تمانتاشر': 18, 'تسعتاشر': 19,
};
const TENS_RAW = {
  'عشرين': 20, 'تلاتين': 30, 'ثلاثين': 30, 'أربعين': 40, 'اربعين': 40, 'خمسين': 50,
  'ستين': 60, 'سبعين': 70, 'ثمانين': 80, 'تمانين': 80, 'تسعين': 90,
};
const HUNDREDS_RAW = {
  'مية': 100, 'مئة': 100, 'ميتين': 200, 'مئتين': 200, 'تلتمية': 300, 'ثلاثمئة': 300,
  'ثلاثمية': 300, 'أربعمية': 400, 'اربعمية': 400, 'أربعمئة': 400, 'اربعمئة': 400,
  'خمسمية': 500, 'خمسمئة': 500, 'ستمية': 600, 'ستمئة': 600, 'سبعمية': 700, 'سبعمئة': 700,
  'تمانمية': 800, 'ثمانمئة': 800, 'تسعمية': 900, 'تسعمئة': 900,
};

/** المفاتيح تُطبَّع بنفس دالة تطبيع النص حتى لا تختلف الكتابة عن المقارنة */
function normalizedDict(raw) {
  const out = {};
  for (const [word, value] of Object.entries(raw)) out[normalize(word)] = value;
  return out;
}
const SMALL = { ...normalizedDict(UNITS_RAW), ...normalizedDict(TEENS_RAW), ...normalizedDict(TENS_RAW), ...normalizedDict(HUNDREDS_RAW) };
const SCALES = { 'ألف': 1000, 'الف': 1000, 'آلاف': 1000, 'الاف': 1000,
  'مليون': 1_000_000, 'ملايين': 1_000_000, 'مليار': 1_000_000_000 };
/** صيغ المثنى المبنية (تحمل معاملها معها) */
const DUALS = { 'مليونين': 2_000_000, 'ميينين': 2_000_000, 'ألفين': 2000, 'الفين': 2000 };
const SCALES_N = (() => { const o = {}; for (const [k, v] of Object.entries(SCALES)) o[normalize(k)] = v; return o; })();
const DUALS_N = (() => { const o = {}; for (const [k, v] of Object.entries(DUALS)) o[normalize(k)] = v; return o; })();

/**
 * كلمات تبدأ بـ«ال» وليست أعدادًا في السياق العقاري رغم أن جذرها عددي —
 * «المية» بالعامية تعني الماء. تُستثنى من تجريد أل التعريف حتى لا يُقرأ
 * «على المية» كأنه الرقم 100.
 */
const ARTICLE_AMBIGUOUS = new Set([normalize('المية'), normalize('المئات')]);

/**
 * يطابق كلمة واحدة كعدد. يجرّب الكلمة كما هي أولًا، ثم بلا واو العطف، ثم بلا
 * أل التعريف — بهذا «وخمسين» تُقرأ 50 و«الحداشر» تُقرأ 11، بينما «واحد» لا
 * تتحول إلى «احد» (الواو جزء من الكلمة) و«المية» لا تُقرأ 100.
 */
function resolveToken(rawToken) {
  const candidates = [rawToken];
  if (rawToken.startsWith('و') && rawToken.length > 1) candidates.push(rawToken.slice(1));
  for (const withArticle of [...candidates]) {
    if (withArticle.startsWith('ال') && withArticle.length > 2 && !ARTICLE_AMBIGUOUS.has(withArticle)) {
      candidates.push(withArticle.slice(2));
    }
  }
  for (const token of candidates) {
    if (SMALL[token]) return { kind: 'small', value: SMALL[token] };
    if (DUALS_N[token]) return { kind: 'dual', value: DUALS_N[token] };
    if (SCALES_N[token]) return { kind: 'scale', value: SCALES_N[token] };
  }
  return null;
}

/**
 * قراءة الأرقام المكتوبة بالحروف المصرية → قيم رقمية (جمع عربي صحيح).
 * «خمسة مليون وخمسمية ألف جنيه» ⇒ 5500000 (لا 5000000 و500000 منفصلتين).
 * «مليونين وستمئة ألف» ⇒ 2600000 · «مئة وعشرين مليون» ⇒ 120000000 · «ميتين وتلاتين» ⇒ 230.
 * استشاري: يكشف الأرقام المذكورة في النص لمقارنتها ببيانات العقار.
 */
export function extractSpokenNumbers(text) {
  const values = [];
  let total = 0;
  let current = 0;
  let dirty = false;
  const emit = () => {
    if (dirty) { total += current; current = 0; dirty = false; }
    if (total > 0) { values.push(total); total = 0; }
  };
  for (const rawToken of normalize(text).split(' ')) {
    const hit = resolveToken(rawToken);
    if (!hit) { emit(); continue; }
    if (hit.kind === 'small') { current += hit.value; dirty = true; continue; }
    if (hit.kind === 'dual') { total += hit.value; current = 0; dirty = false; continue; }
    // مقياس (ألف/مليون): أساسه العدد الجاري، أو 1 لو لم يُذكر («ألف جنيه»)
    const base = current > 0 ? current : 1;
    total += base * hit.value;
    current = 0;
    dirty = false;
  }
  emit();
  return [...new Set(values.filter((v) => v > 0))];
}

// ── بيانات العقار ────────────────────────────────────────────────────

export function loadProperty(propertyPath) {
  const file = abs(propertyPath);
  if (!fs.existsSync(file)) fail(`ملف العقار غير موجود: ${propertyPath}`);
  const raw = fs.readFileSync(file, 'utf8');
  const { data } = parseFrontMatter(raw);
  if (!data.slug) fail(`${propertyPath}: لا يوجد حقل slug`);
  return {
    file, rel: path.relative(ROOT, file), data,
    slug: String(data.slug),
    priceNumeric: Number(data.priceNumeric) || firstNumber(data.price) || null,
    areaNumeric: Number(data.areaNumeric) || firstNumber(data.area) || null,
    roomsNumeric: Number(data.roomsNumeric) || firstNumber(data.rooms) || null,
    bathsNumeric: Number.isFinite(Number(data.bathsNumeric)) ? Number(data.bathsNumeric) : firstNumber(data.bathrooms),
  };
}

// ── 1) فحص النص ─────────────────────────────────────────────────────

export function checkScript(script, property) {
  const errors = [];
  const warnings = [];
  const norm = normalize(script);

  if (!script || script.trim().length < 80) errors.push('النص أقصر من 80 حرفًا — إعلان غير مكتمل.');

  // أرقام بالحروف لا بالأرقام (قاعدة المواصفة للإعلانات الجديدة)
  const digits = script.match(/\d+/g);
  if (digits && !flag('allow-digits')) {
    errors.push(`النص يحتوي أرقامًا رقمية (${digits.join('، ')}). القاعدة: تُكتب بالحروف المصرية لضبط النطق.`);
  }

  // أشكال فصحى / غير مصرية — مطابقة على مستوى الكلمة الكاملة (انظر hasPhrase)
  for (const bad of SPEC.language.forbidden.msaForms) {
    if (hasPhrase(norm, bad)) errors.push(`شكل فصيح مرفوض: «${bad.trim()}» — الهوية مصرية عامية.`);
  }
  for (const bad of SPEC.language.forbidden.nonEgyptianForms) {
    if (hasPhrase(norm, bad)) errors.push(`شكل غير مصري مرفوض: «${bad.trim()}».`);
  }

  // الـ Hook: أول علامة إنهاء في النص يجب أن تكون «؟»
  const trimmed = script.trim();
  const firstTerminal = trimmed.search(/[؟?!.,،]/);
  const firstSentence = firstTerminal > -1 ? trimmed.slice(0, firstTerminal) : trimmed;
  if (firstTerminal === -1 || trimmed[firstTerminal] !== '؟') {
    errors.push('المقطع 1 (Hook) يجب أن يكون سؤالًا ينتهي بـ«؟» قبل أي نقطة أو علامة تعجب.');
  }
  if (wordCount(firstSentence) > 16) warnings.push('الـHook أطول من 16 كلمة — المرجع 10-11 كلمة.');

  // الـ CTA
  const ctaOk = [SPEC.script.cta.canonical, ...SPEC.script.cta.canonicalVariants]
    .some((c) => norm.includes(normalize(c)));
  if (!ctaOk) {
    const legacy = norm.includes(normalize(SPEC.script.cta.legacyThirdPerson));
    if (legacy) errors.push(`الـCTA بصيغة الغائب الموروثة. الجديد يعتمد الصيغة المرجعية: «${SPEC.script.cta.canonical}»`);
    else errors.push('لا توجد دعوة تواصل (CTA) مطابقة للمواصفة، ولا ذكر لـ«واتساب سمسار طلبك».');
  }
  if (!norm.includes('واتساب')) errors.push('الـCTA يجب أن يذكر «واتساب» (نفس قناة الموقع).');

  // الطول
  const words = wordCount(script);
  const estSeconds = words / WORDS_PER_SECOND;
  if (words > MAX_WORDS) errors.push(`النص ${words} كلمة ≈ ${estSeconds.toFixed(1)} ثانية — يتجاوز حد ${SPEC.encoding.maxDurationSeconds} ثانية (الأقصى ${MAX_WORDS} كلمة).`);
  else if (estSeconds > SPEC.encoding.targetDurationSeconds.max) warnings.push(`النص ${words} كلمة ≈ ${estSeconds.toFixed(1)} ثانية — قريب من الحد.`);
  else if (estSeconds < SPEC.encoding.targetDurationSeconds.min) warnings.push(`النص ${words} كلمة ≈ ${estSeconds.toFixed(1)} ثانية — أقصر من النطاق المستهدف (لا بأس إن كانت البيانات قليلة).`);

  // سند الأرقام في بيانات العقار (استشاري)
  if (property) {
    const spoken = extractSpokenNumbers(script);
    const expected = [
      ['المساحة', property.areaNumeric],
      ['السعر', property.priceNumeric],
      ['الغرف', property.roomsNumeric],
    ].filter(([, v]) => Number.isFinite(v) && v > 0);
    for (const [label, value] of expected) {
      const found = spoken.some((v) => v === value || Math.abs(v - value) <= 1);
      if (!found) {
        const msg = `${label} في ملف العقار = ${value} ولم يُعثر عليه بين الأرقام المنطوقة (${spoken.join('، ') || 'لا شيء'}).`;
        if (flag('ack-facts')) warnings.push(msg);
        else errors.push(`${msg} — راجع النص، أو مرّر --ack-facts بعد التأكد البشري.`);
      }
    }
  }

  return { errors, warnings, words, estSeconds, spokenNumbers: extractSpokenNumbers(script) };
}

// ── 2) كتلة front matter ────────────────────────────────────────────

function frontMatterBlock(slug, script, durationLabel) {
  return [
    '',
    '# ── 🎙️ الإعلان الصوتي — مُنتَج عبر مسار الإنتاج الموحّد ──',
    '# المصدر الوحيد للإعدادات: _data/voice_identity.json (المواصفة المركزية)',
    '# لا تُعدَّل هذه الحقول يدويًا ولا تُغيَّر إعدادات الصوت دون قيد في',
    '# _data/audio_voice_log.json — البوابة scripts/audio/verify-voice-identity.mjs تمنع النشر.',
    'audio_ad: true',
    `audio_file: "/assets/audio/properties/${slug}.mp3"`,
    `audio_duration: "${durationLabel}"`,
    `audio_script: "${script.replace(/"/g, '\\"')}"`,
  ].join('\n');
}

// ── 3) الوسم ────────────────────────────────────────────────────────

function tagFrames(title, date, script) {
  return [
    { id: 'TIT2', text: title },
    { id: 'TPE1', text: SPEC.id3.fixedValues.TPE1 },
    { id: 'TALB', text: SPEC.id3.fixedValues.TALB },
    { id: 'TDRC', text: date },
    { id: 'TCON', text: SPEC.id3.fixedValues.TCON },
    { id: 'TSSE', text: SPEC.id3.fixedValues.TSSE },
    { id: 'COMM', comm: { language: SPEC.id3.comm.language, description: SPEC.id3.comm.description, text: script } },
  ];
}

/** عنوان TIT2 من بيانات العقار: «<نوع> <مساحة> <موقع مختصر>» */
function deriveTitle(property) {
  const explicit = arg('title');
  if (explicit) return explicit;
  const t = String(property.data.title ?? property.slug);
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
}

function productionDate() {
  const explicit = arg('date');
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) fail('--date يجب أن يكون بصيغة YYYY-MM-DD');
    return explicit;
  }
  // TDRC هو تاريخ الإنتاج بتوقيت الموقع (_config.yml: timezone Africa/Cairo)،
  // لا بتوقيت UTC — وإلا انزلق التاريخ يومًا كاملًا في نصف الليل الثاني.
  return new Date().toLocaleDateString('en-CA', { timeZone: SITE_TIMEZONE });
}

// ── 4) التحقّق من ملف مُنتَج ────────────────────────────────────────

export function verifyFile(mp3Path, expectedScript = null, label = null) {
  const bytes = fs.readFileSync(mp3Path);
  const problems = [];
  const notes = [];
  const name = label ?? path.basename(mp3Path);

  const extent = tagExtent(bytes);
  if (!extent) problems.push('لا توجد وسوم ID3v2');
  else {
    if (`2.${extent.major}` !== SPEC.id3.version) problems.push(`إصدار الوسوم 2.${extent.major} والمطلوب ${SPEC.id3.version}`);
    if (extent.flags !== SPEC.id3.headerFlagsByte) problems.push(`بايت الأعلام ${extent.flags} والمطلوب ${SPEC.id3.headerFlagsByte}`);
  }

  const parsed = parseFrames(bytes);
  const ids = parsed ? parsed.frames.map((f) => f.id) : [];
  const required = SPEC.id3.requiredFrames;
  for (const id of required) if (!ids.includes(id)) problems.push(`إطار ناقص: ${id}`);
  if (SPEC.id3.forbiddenExtraFrames) {
    for (const id of ids) if (!required.includes(id)) problems.push(`إطار زائد غير مسموح: ${id}`);
  }
  const orderGot = ids.filter((id) => required.includes(id)).join(',');
  const orderWant = required.join(',');
  if (orderGot !== orderWant) {
    notes.push(`ترتيب الإطارات ${ids.join(',')} مقابل المرجع ${orderWant}`);
    problems.push('ترتيب الإطارات لا يطابق المواصفة');
  }
  if (parsed && parsed.paddingBytes < SPEC.id3.minPaddingBytes) {
    problems.push(`الحشو ${parsed.paddingBytes} بايت والأدنى ${SPEC.id3.minPaddingBytes}`);
  }

  for (const frame of parsed?.frames ?? []) {
    if (frame.id === 'COMM') continue;
    if (frame.body[0] !== SPEC.id3.textEncodingByte) {
      problems.push(`${frame.id}: الترميز ${frame.body[0]} والمطلوب ${SPEC.id3.textEncodingByte} (UTF-16)`);
    }
  }

  for (const [id, value] of Object.entries(SPEC.id3.fixedValues)) {
    const got = frameText(parsed, id);
    if (got !== value) problems.push(`${id} = «${got}» والمطلوب «${value}»`);
  }
  const tdrc = frameText(parsed, 'TDRC');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tdrc ?? '')) problems.push(`TDRC = «${tdrc}» وليس بصيغة YYYY-MM-DD`);
  if (!frameText(parsed, 'TIT2')) problems.push('TIT2 فارغ');

  const comm = parseComm(parsed?.frames?.find((f) => f.id === 'COMM'));
  if (!comm) problems.push('تعذّر قراءة إطار COMM بالبنية المطلوبة');
  else {
    if (comm.language !== SPEC.id3.comm.language) problems.push(`COMM لغة «${comm.language}» والمطلوب «${SPEC.id3.comm.language}»`);
    const allowed = [SPEC.id3.comm.description, SPEC.id3.comm.legacyDescriptionAccepted];
    if (!allowed.includes(comm.description)) problems.push(`COMM وصف «${comm.description}» غير مقبول`);
    if (expectedScript !== null && comm.text !== expectedScript) problems.push('نص COMM لا يطابق audio_script حرفيًا');
  }

  const mpeg = scanMpeg(bytes);
  if (!mpeg) problems.push('تعذّر مسح إطارات MPEG — الملف قد يكون تالفًا');
  else {
    const enc = SPEC.encoding;
    if (mpeg.bitrateBps !== enc.bitrateBps) problems.push(`معدل البت ${mpeg.bitrateBps} والمطلوب ${enc.bitrateBps}`);
    if (mpeg.sampleRateHz !== enc.sampleRateHz) problems.push(`معدل العينة ${mpeg.sampleRateHz} والمطلوب ${enc.sampleRateHz}`);
    if (mpeg.channels !== enc.channels) problems.push(`القنوات ${mpeg.channels} والمطلوب ${enc.channels}`);
    if (mpeg.layer !== enc.mpegLayer) problems.push(`الطبقة ${mpeg.layer} والمطلوب ${enc.mpegLayer}`);
    if (mpeg.samplesPerFrame !== enc.samplesPerFrame) problems.push(`عيّنات/إطار ${mpeg.samplesPerFrame} والمطلوب ${enc.samplesPerFrame}`);
    if (mpeg.durationSeconds > enc.maxDurationSeconds) problems.push(`المدة ${mpeg.durationSeconds.toFixed(3)} ثانية تتجاوز ${enc.maxDurationSeconds}`);
    if (mpeg.durationSeconds < 1) problems.push(`المدة ${mpeg.durationSeconds.toFixed(3)} ثانية — ملف شبه فارغ`);
    notes.push(`مدة ${mpeg.durationSeconds.toFixed(3)} ث · ${mpeg.bitrateBps / 1000} kbps · ${mpeg.sampleRateHz} Hz · ${mpeg.channelMode} · ${mpeg.frameCount} إطار`);
  }

  return {
    name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    durationSeconds: mpeg?.durationSeconds ?? null, problems, notes, commText: comm?.text ?? null,
  };
}

// ── 5) القيد في السجل ───────────────────────────────────────────────

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return { _comment: [], entries: [] };
  return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
}

// ── التنفيذ ─────────────────────────────────────────────────────────

function main() {
  const propertyPath = arg('property');
  const scriptFile = arg('script-file');
  const mp3 = arg('mp3');
  const script = scriptFile ? fs.readFileSync(abs(scriptFile), 'utf8').trim()
    : arg('script');
  const property = propertyPath ? loadProperty(propertyPath) : null;

  if (mode === 'plan') {
    if (!script) fail('--plan يحتاج --script-file أو --script');
    if (!property) fail('--plan يحتاج --property');
    const result = checkScript(script, property);
    result.warnings.forEach(warn);
    if (result.errors.length) result.errors.forEach((e) => console.error(`❌ ${e}`));
    const seconds = Math.ceil((result.words / WORDS_PER_SECOND) - 1e-9);
    console.log(`\nالكلمات: ${result.words} · المدة التقديرية: ${result.estSeconds.toFixed(1)} ث · audio_duration المقترح: «${seconds} ثانية»`);
    console.log(`الأرقام المنطوقة المكتشفة: ${result.spokenNumbers.join('، ') || 'لا شيء'}`);
    console.log(`بيانات العقار: المساحة=${property.areaNumeric} السعر=${property.priceNumeric} الغرف=${property.roomsNumeric}`);
    if (result.errors.length) fail(`${result.errors.length} مخالفة في النص — لا يُنتَج صوت قبل إصلاحها.`);
    ok('النص مطابق للمواصفة المركزية.');
    console.log(`\n--- كتلة front matter (تُضاف قبل --- الختامية في ${property.rel}) ---`);
    console.log(frontMatterBlock(property.slug, script, `${seconds} ثانية`));
    process.exit(0);
  }

  if (mode === 'tag') {
    if (!script) fail('--tag يحتاج --script-file أو --script');
    if (!mp3) fail('--tag يحتاج --mp3');
    const result = checkScript(script, property);
    result.warnings.forEach(warn);
    if (result.errors.length) { result.errors.forEach((e) => console.error(`❌ ${e}`)); fail('النص غير مطابق — رُفض الوسم.'); }
    const mp3Path = abs(mp3);
    if (!fs.existsSync(mp3Path)) fail(`الملف غير موجود: ${mp3}`);
    const before = fs.readFileSync(mp3Path);
    const beforeAudio = (() => { const e = tagExtent(before); return e ? before.subarray(e.total) : before; })();
    const frames = tagFrames(deriveTitle(property ?? { slug: path.basename(mp3, '.mp3'), data: {} }), productionDate(), script);
    const outcome = retag(mp3Path, frames, SPEC.id3.minPaddingBytes);
    if (!outcome.audioIdentical) fail('بايتات الصوت تغيّرت أثناء إعادة الوسم — هذا ممنوع.');
    const after = fs.readFileSync(mp3Path);
    const afterAudio = (() => { const e = tagExtent(after); return e ? after.subarray(e.total) : after; })();
    if (!afterAudio.equals(beforeAudio)) fail('تحقّق ثانٍ فشل: بايتات MPEG ليست مطابقة للأصل.');
    const v = verifyFile(mp3Path, script);
    v.problems.forEach((p) => console.error(`❌ ${p}`));
    v.notes.forEach((n) => console.log(`   ${n}`));
    if (v.problems.length) fail('الملف الموسوم لا يطابق المواصفة.');
    ok(`أُعيد وسم ${mp3} إلى ID3v2.3 — بايتات الصوت محفوظة حرفيًا (${outcome.audioBytes} بايت).`);
    console.log(`   SHA-256 الجديد: ${v.sha256}`);
    console.log(`   المدة: ${v.durationSeconds.toFixed(3)} ثانية → audio_duration: «${Math.ceil(v.durationSeconds - 1e-9)} ثانية»`);
    process.exit(0);
  }

  if (mode === 'verify') {
    if (!mp3) fail('--verify يحتاج --mp3');
    let expected = null;
    if (property) {
      expected = property.data.audio_script ?? null;
      if (!expected) fail(`${property.rel}: لا يوجد audio_script في front matter`);
      const declared = property.data.audio_file;
      const want = `/assets/audio/properties/${property.slug}.mp3`;
      if (declared !== want) fail(`audio_file = «${declared}» والمطلوب «${want}» (المسار يجب أن يعكس الـslug)`);
    } else if (script) expected = script;
    const v = verifyFile(abs(mp3), expected);
    v.notes.forEach((n) => console.log(`   ${n}`));
    v.problems.forEach((p) => console.error(`❌ ${p}`));
    if (v.problems.length) fail(`${v.problems.length} مخالفة في ${v.name}`);
    ok(`${v.name}: مطابق للمواصفة (${v.bytes} بايت · ${v.durationSeconds.toFixed(3)} ث · SHA-256 ${v.sha256.slice(0, 16)}…)`);
    process.exit(0);
  }

  if (mode === 'record') {
    if (!property || !mp3) fail('--record يحتاج --property و --mp3');
    const cosine = Number(arg('cosine', Number.NaN));
    if (!Number.isFinite(cosine)) fail('--record يحتاج --cosine <رقم من measure_voice_identity.py>');
    const voiceId = arg('voice-id');
    if (!voiceId) fail('--record يحتاج --voice-id (مثل voice-00) — لا يجوز تركه فارغًا');
    const approval = arg('approval');
    if (!approval) fail('--record يحتاج --approval (owner-in-session | owner-override | measured-pass)');

    // ── سياسة identityBand.policy — نفس حدود البوابة ونفس مفردات السجل ──
    const band = SPEC.identityBand.thresholds;
    /** مفردات التصنيف الموحَّدة مع السجل وتقرير التدقيق وبوابة CI */
    const classification = cosine >= band.identicalVoice ? 'compatible-with-reference'
      : cosine >= band.borderlineNeedsOwnerApproval ? 'possible-deviation-review'
        : 'clear-difference';
    const needsOverride = cosine < band.borderlineNeedsOwnerApproval;
    if (cosine < band.unacceptable) {
      fail(`cos=${cosine} تحت الحد غير المقبول ${band.unacceptable} — لا يُنشر ولا يُقيَّد.`);
    }
    if (needsOverride && approval !== 'owner-override' && approval !== 'owner-in-session') {
      fail(`cos=${cosine} تحت حد الهوية ${band.borderlineNeedsOwnerApproval}. لا يُنشر إلا بموافقة المالك الصريحة (--approval owner-in-session) أو تجاوز موثق (--approval owner-override --reason "…").`);
    }
    if (needsOverride && !arg('reason')) {
      fail(`cos=${cosine} يتطلب --reason يوثّق سبب الموافقة على النشر تحت حد الهوية.`);
    }
    if (approval === 'owner-override' && !arg('reason')) fail('--approval owner-override يحتاج --reason موثقًا.');
    if (!needsOverride && classification === 'possible-deviation-review' && approval === 'measured-pass') {
      fail(`cos=${cosine} في النطاق الحرج — يتطلب موافقة المالك، لا measured-pass.`);
    }

    const v = verifyFile(abs(mp3), property.data.audio_script ?? null);
    if (v.problems.length) { v.problems.forEach((p) => console.error(`❌ ${p}`)); fail('لا يُقيَّد ملف غير مطابق للمواصفة.'); }
    const audioFile = `assets/audio/properties/${property.slug}.mp3`;
    if (path.relative(ROOT, abs(mp3)).split(path.sep).join('/') !== audioFile) {
      fail(`مسار الملف يجب أن يكون ${audioFile} (يعكس الـslug) — وُجد ${path.relative(ROOT, abs(mp3))}`);
    }
    const declared = property.data.audio_file;
    if (declared !== `/${audioFile}`) fail(`audio_file في ${property.rel} = «${declared}» والمطلوب «/${audioFile}»`);
    const wantLabel = `${Math.ceil(v.durationSeconds - 1e-9)} ثانية`;
    if (String(property.data.audio_duration) !== wantLabel) {
      fail(`audio_duration في ${property.rel} = «${property.data.audio_duration}» والمطلوب «${wantLabel}» (قيس ${v.durationSeconds.toFixed(3)} ث)`);
    }

    const log = readLog();
    const scriptText = property.data.audio_script ?? script;
    const entry = {
      slug: property.slug,
      audioFile,
      propertySource: property.rel,
      origin: 'produced-under-spec',
      productionSession: arg('session', `unified-pipeline (${productionDate()})`),
      producedAt: productionDate(),
      engine: SPEC.engine.name,
      voiceId,
      voiceIdScope: SPEC.engine.voiceIdScope,
      // المحرك لا يوفّر معرّفًا دائمًا — البوابة تُسقط أي ادعاء بعكس ذلك
      voiceIdPersistent: false,
      auditionRounds: Number(arg('auditions', 1)),
      auditionLanguage: SPEC.language.bcp47,
      auditionTextSource: arg('audition-text-source', SPEC.reference.repoPath),
      speakerCosineToReference: Number(cosine.toFixed(4)),
      sameVoiceBandMin: band.borderlineNeedsOwnerApproval,
      sameVoiceBandP5: band.identicalVoice,
      classification,
      approval,
      approvalReason: arg('reason'),
      ownerOverride: needsOverride,
      ownerOverrideReason: needsOverride ? arg('reason') : null,
      ownerOverrideApprovedBy: needsOverride ? (arg('approved-by') ?? 'مالك المشروع') : null,
      identityLimit: needsOverride ? SPEC.engine.consequence : null,
      durationSeconds: Number(v.durationSeconds.toFixed(3)),
      durationLabel: wantLabel,
      bytes: v.bytes,
      sha256: v.sha256,
      script: scriptText,
      words: wordCount(scriptText),
      linkedToPublishedPage: property.data.audio_ad === true,
      replacesPublishedFile: flag('replaces'),
      originalSha256BeforeReplacement: arg('original-sha256'),
      note: arg('note'),
    };
    if (entry.replacesPublishedFile && !entry.originalSha256BeforeReplacement) {
      fail('--replaces يحتاج --original-sha256 <بصمة الملف المستبدَل> — لا استبدال بلا أثر.');
    }
    log.entries = (log.entries ?? []).filter((e) => e.slug !== entry.slug || e.replacesPublishedFile);
    log.entries.push(entry);

    // مجاميع السجل تُحدَّث هنا حتى لا تتقادم (البوابة تتحقق من تطابقها)
    const byClassification = {};
    for (const e of log.entries) byClassification[e.classification] = (byClassification[e.classification] || 0) + 1;
    log.measuredAt = productionDate();
    log.totals = {
      audioFiles: log.entries.length,
      linkedToPublishedPages: log.entries.filter((e) => e.linkedToPublishedPage).length,
      retiredOrphans: log.entries.filter((e) => !e.linkedToPublishedPage).length,
      ownerChosenReference: log.entries.filter((e) => e.origin === 'owner-chosen-reference').length,
      producedUnderSpec: log.entries.filter((e) => e.origin === 'produced-under-spec').length,
      legacyGrandfathered: log.entries.filter((e) => e.origin === 'legacy-grandfathered').length,
      byClassification,
    };
    fs.writeFileSync(LOG_PATH, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
    ok(`قُيّد ${entry.slug} في ${path.relative(ROOT, LOG_PATH)}`);
    console.log(`   cos=${entry.speakerCosineToReference} · ${classification} · ${approval} · ${entry.durationLabel} · ${v.bytes} بايت`);
    console.log(`   SHA-256: ${v.sha256}`);
    if (needsOverride) console.log('   ⚠️  تحت حد الهوية: التجاوز موثَّق بـ ownerOverride + سبب. لا يُتّخذ سابقةً لإعلانات لاحقة.');
    process.exit(0);
  }
}

if (IS_MAIN) main();
