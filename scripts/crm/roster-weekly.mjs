#!/usr/bin/env node
/**
 * Weekly roster delta — من دخل، ومن خرج، ومن اكتمل.
 *
 * WHY THIS EXISTS (measured, not assumed):
 * `scripts/crm/prune-phonebook.mjs` answers «مين يستاهل يكون في التليفون دلوقتي»
 * لكل تصدير على حدة. لكنه لا يعرف الدفتر السابق، فلا يستطيع أن يقول: النهاردة
 * دخل كام عميل، وخرج كام، ومين الجديد من آخر مرة. والفرق بين «عدد الكروت» و«عدد
 * الناس اللي دخلوا النهاردة» هو الفرق بين جرد حسابٍ ودفترٍ حيّ.
 *
 * WHAT IT DOES, IN ORDER:
 *   1. يقرأ تصدير `.vcf` الجديد (نفس مُحلِّل prune-phonebook — لا مُحلِّل ثانٍ).
 *   2. يدمج بالناس بالرقم، لا بالاسم (نفس قاعدة prune-phonebook).
 *   3. يقارن بالحالة الأسبوع السابق (`roster-state-<week>.json`) فيصنّف كل شخص:
 *        entered   — رقم لم يكن في الحالة السابقة
 *        returned  — كان معروفًا، غاب أسبوعًا أو أكثر، ورجع
 *        exited    — كان في السابق وغاب الآن
 *        marked    — كان موجودًا وحصل على واحدة من العلامات الخمس
 *        unmarked  — كان موسومًا وفقد العلامة
 *        moved     — بدّل تصنيفه بين العلامات
 *        stayed    — كما هو
 *   4. يكتب الحالة الجديدة + تقريرًا رقميًا. **لا أرقام هواتف ولا أسماء في
 *      الحالة أو التقرير**: بصمة `sha256(phone)` فقط، لأن المستودع عام
 *      (الحارس: `scripts/tests/no-customer-data-in-git.test.mjs`).
 *
 * THE ONE RULE THIS FILE WILL NOT BREAK:
 *   لا يحذف شيئًا. «خرج» تعني «ليس في تصدير هذا الأسبوع»؛ الكارت يبقى في ملف
 *   الأرشيف الذي ينتجه prune-phonebook، والحالة تحتفظ ببصمته للأبد حتى لو خرج
 *   ورجع — فيُعرَف أنه عائد لا جديد.
 *
 * Usage:
 *   node scripts/crm/roster-weekly.mjs --vcf <export.vcf> \
 *        --state <out/roster-state.json> --out <out/weekly-report.json> [--today YYYY-MM-DD]
 *
 * `--state` و`--out` يجب أن يكونا خارج المستودع (نفس قاعدة prune-phonebook).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { parseVcfContacts } from './build-whatsapp-import.mjs';
import { cleanName, assertOutDirOutsideRepo } from './prune-phonebook.mjs';
import { segmentsOf } from './segments.mjs';

/** بصمة الرقم — الشيء الوحيد من العميل الذي يُسمح له بدخول ملف حالة. */
export function phoneFingerprint(e164) {
  return createHash('sha256').update(`tel:${e164}`).digest('hex').slice(0, 32);
}

/** يوم الأسبوع ISO: الاثنين بداية الأسبوع (تسلسل زمني مصري شائع للعمل). */
export function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad-date:${dateStr}`);
  const day = d.getUTCDay();
  const shift = (day + 6) % 7; // الاثنين = 0
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/**
 * يجمع كروت الـvcf إلى أشخاص بالرقم — نفس دمج prune-phonebook (اتحاد على الأرقام)
 * لأن رجلًا محفوظًا مرتين باسمين مختلفين هو رجل واحد.
 */
export function peopleFromVcf({ name = 'export.vcf', text }) {
  const cards = parseVcfContacts(text, name).map((c) => {
    const phones = [];
    for (const phone of c?.phones || []) {
      const e164 = String(phone?.e164 || '').replaceAll(/\D/g, '');
      if (e164 && !phones.includes(e164)) phones.push(e164);
    }
    const fn = cleanName(c?.fn);
    return { fn, phones, segment: segmentsOf(fn) };
  });
  const parent = cards.map((_, i) => i);
  const find = (i) => {
    if (parent[i] === i) return i;
    const root = find(parent[i]);
    parent[i] = root;
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const owner = new Map();
  cards.forEach((card, i) => {
    for (const phone of card.phones) {
      if (owner.has(phone)) union(owner.get(phone), i);
      else owner.set(phone, i);
    }
  });
  const groups = new Map();
  items(cards).forEach(({ card, i }) => {
    const root = find(i);
    const group = groups.get(root) || { cards: [], phones: [] };
    group.cards.push(card);
    for (const phone of card.phones) if (!group.phones.includes(phone)) group.phones.push(phone);
    groups.set(root, group);
  });
  return [...groups.values()]
    .filter((group) => group.phones.length > 0)
    .map((group) => {
      const marked = group.cards.filter((card) => card.segment.inScope);
      const primary = marked[0]?.segment.primary ?? null;
      const pool = marked.length > 0 ? marked : group.cards;
      const display = pool.reduce((best, card) => (card.fn.length > best.fn.length ? card : best), pool[0]);
      return {
        fp: phoneFingerprint(group.phones[0]),
        phones: group.phones.map(phoneFingerprint).sort(),
        segment: primary?.key ?? null,
        marks: [...new Set(group.cards.flatMap((c) => c.segment.codes))].sort(),
        nameLength: display.fn.length,
      };
    });
}

/** صغير ومقصود: نلفّ المصفوفة بأسمائها بدل `forEach` بمؤشر خارجي. */
function items(arr) {
  return arr.map((card, i) => ({ card, i }));
}

/**
 * يشيل بصمات الأرقام المستعملة بالفعل في تطبيع الاتحاد (كل شخص متعدد الأرقام
 * يُسجَّل بأول رقم، وباقي أرقامه تُسجَّل كأسماء مستعارة لنفس الشخص).
 */
export function stateFromPeople(people, { week, generatedAt }) {
  const byFp = {};
  for (const person of people) {
    byFp[person.fp] = {
      segment: person.segment,
      marks: person.marks,
      aliases: person.phones.filter((p) => p !== person.fp),
      firstSeenWeek: week,
      lastSeenWeek: week,
    };
  }
  return { week, generatedAt, persons: byFp };
}

/** عدد أسابيع الاثنين بين تاريخين — 1 تعني أسبوعين متتاليين. */
export function gapWeeks(fromWeek, toWeek) {
  const a = new Date(`${fromWeek}T00:00:00Z`);
  const b = new Date(`${toWeek}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.round((b - a) / (7 * 86_400_000));
}

/** يصف حالة شخص واحد بالنسبة لحالته السابقة — كلمة واحدة تُجمَع بعدها. */
export function classifyPerson(person, before, week) {
  if (!before) return 'entered';
  if (before.lastSeenWeek && before.lastSeenWeek !== week
    && gapWeeks(before.lastSeenWeek, week) > 1) return 'returned';
  if (before.segment === person.segment) return 'stayed';
  if (!before.segment) return 'marked';
  if (!person.segment) return 'unmarked';
  return 'moved';
}

/**
 * الفرق بين أسبوعين. `previous` قد تكون `null` (أول أسبوع) — وكل شخص يكون
 * `entered` حينها، وهذا صحيح: أول مرة نعرف فيك شيء أنت جديد في الدفتر.
 *
 * القاعدة التي تُثبّت المعنى: `entered` تعني «لم يكن لنا به علم»، و`returned`
 * تعني «كان لنا به علم وغاب». خلطهما يجعل الرقم بلا معنى في الأسبوع الثالث.
 */
export function diffWeeks(people, previous, { week }) {
  const prev = previous?.persons || {};
  const seen = new Set();
  const counts = { entered: 0, returned: 0, exited: 0, marked: 0, unmarked: 0, moved: 0, stayed: 0 };
  const enteredBySegment = {};
  const exitedBySegment = {};
  const merged = { ...prev };

  for (const person of people) {
    seen.add(person.fp);
    const before = prev[person.fp];
    const kind = classifyPerson(person, before, week);
    counts[kind] += 1;
    if (kind === 'entered') {
      const seg = person.segment || 'unmarked';
      enteredBySegment[seg] = (enteredBySegment[seg] || 0) + 1;
    }
    merged[person.fp] = {
      segment: person.segment,
      marks: person.marks,
      aliases: person.phones.filter((p) => p !== person.fp),
      firstSeenWeek: before?.firstSeenWeek ?? week,
      lastSeenWeek: week,
    };
  }

  for (const [fp, before] of Object.entries(prev)) {
    if (seen.has(fp) || before.lastSeenWeek === week) continue;
    counts.exited += 1;
    const seg = before.segment || 'unmarked';
    exitedBySegment[seg] = (exitedBySegment[seg] || 0) + 1;
  }

  return {
    counts,
    enteredBySegment,
    exitedBySegment,
    state: { week, generatedAt: new Date().toISOString(), persons: merged },
  };
}

/** إجمالي الدفتر بعد الدمج، مقسّمًا على العلامات الخمس — لقراءة الرقم وحده. */
export function totalsBySegment(people) {
  const totals = {};
  for (const person of people) {
    const seg = person.segment || 'unmarked';
    totals[seg] = (totals[seg] || 0) + 1;
  }
  return totals;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  const vcf = arg('--vcf');
  const stateFile = arg('--state');
  const outFile = arg('--out');
  const today = arg('--today', new Date().toISOString().slice(0, 10));
  if (!vcf || !stateFile || !outFile) {
    console.error('usage: roster-weekly.mjs --vcf <export.vcf> --state <out/roster-state.json> --out <out/weekly-report.json> [--today YYYY-MM-DD]');
    process.exit(2);
  }
  assertOutDirOutsideRepo(stateFile);
  assertOutDirOutsideRepo(outFile);

  const week = weekKey(today);
  const people = peopleFromVcf({ name: path.basename(vcf), text: fs.readFileSync(vcf, 'utf8') });
  const previous = readJson(stateFile, null);
  const { counts, enteredBySegment, exitedBySegment, state } = diffWeeks(people, previous, { week });
  const report = {
    week,
    day: today,
    comparedWith: previous?.week ?? null,
    people: people.length,
    totalsBySegment: totalsBySegment(people),
    counts,
    enteredBySegment,
    exitedBySegment,
    marked: people.filter((p) => p.segment).length,
    unmarked: people.filter((p) => !p.segment).length,
    // ملاحظة صريحة: «خرج» = غاب من تصدير هذا الأسبوع، لا حذف.
    exitNote: 'exited = not present in this week export; the card is kept in the archive file, never deleted',
  };

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) await main();
