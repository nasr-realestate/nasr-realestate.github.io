/**
 * The morning list — the only thing the broker has to read.
 *
 * Everything else in this repository exists to produce one column of names and
 * one sentence of reason per name. The five marks decide who is in; silence and
 * depth decide the order.
 *
 * Why this order, and not "newest first"? Because a unit that stops moving costs
 * him the whole commission, and because a passer-by is not a deal: 🟢 is تمليك,
 * 🔴 is مفروش, ✈️ is someone who came once and may come back years later.
 * Servicing supply is the work; touching a passer-by is a courtesy, kept cheap.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS, segmentsOf } from './segments.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DAY = 86_400_000;

/** Weights are the whole opinion of this file; keep them in one place. */
const WEIGHTS = {
  transient: 10,     // may need us later: never dropped, never chased
  silentOver60: 30,  // two months of silence is not a follow-up, it is a loss
  silentOver30: 20,
  deepOver30: 10,    // a long conversation that stopped is a deal that stalled
  deepOver10: 5,
};

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function silenceLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days === 0) return 'اليوم';
  return `${days} يومًا`;
}

/** One sentence, in the broker's language, for why this name is on the list. */
function reasonFor(person) {
  const { seg, days, messages } = person;
  if (seg.role === 'transient') {
    if (days !== null && days > 60) return 'عابر سكت شهرين — رسالة واحدة تكفي';
    if (days !== null && days > 30) return 'عابر — تذكير خفيف بلا إلحاح';
    return 'عابر جديد — قد يحتاجنا لاحقًا';
  }
  if (days !== null && days > 60) return 'مالك ساكت شهرين — وحدته بلا تسويق';
  if (days !== null && days > 30) return 'مالك ساكت شهرًا — تقرير سعر متأخر';
  if (messages >= 30) return 'كلام طويل توقّف — قرار معلّق';
  return 'متابعة عادية';
}

function scoreOf(person) {
  const { seg, days, messages } = person;
  let score = seg.role === 'transient' ? WEIGHTS.transient : 0;
  if (days !== null && days > 60) score += WEIGHTS.silentOver60;
  else if (days !== null && days > 30) score += WEIGHTS.silentOver30;
  if (messages >= 30) score += WEIGHTS.deepOver30;
  else if (messages >= 10) score += WEIGHTS.deepOver10;
  return score;
}

export function buildRows(report, today) {
  return report
    .map((r) => {
      const seg = segmentsOf(`${r.chat_title || ''} ${r.resolved_to || ''}`);
      const last = r.last ? Date.parse(r.last) : null;
      return {
        name: String(r.resolved_to || r.chat_title || '').replace(/\.(zip|txt)$/i, ''),
        seg,
        messages: r.messages || 0,
        days: last ? Math.round((today - last) / DAY) : null,
        hasNumber: Boolean(r.resolved_to),
      };
    })
    .filter((p) => p.seg.inScope)
    .map((p) => ({ ...p, reason: reasonFor(p), score: scoreOf(p) }))
    .sort((a, b) => b.score - a.score || (a.days ?? 1e9) - (b.days ?? 1e9));
}

export function render(rows, todayIso, limit) {
  const lines = [];
  const withNumber = rows.filter((r) => r.hasNumber);
  const total = rows.length;
  lines.push('# النهاردة', '', `_${todayIso} · ${total} عميلًا في نطاقك · ${withNumber.length} بأرقامهم_`, '');
  lines.push('## اتصل بهؤلاء', '');
  lines.push('| # | العميل | العلامة | رسائل | منذ | لماذا |', '|---|---|---|---|---|---|');
  rows.slice(0, limit).forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name.slice(0, 46)} | ${r.seg.codes.join(' ')} | ${r.messages} | ${silenceLabel(r.days)} | ${r.reason} |`);
  });
  lines.push('');
  lines.push('## العابرون — يُحفظون ولا يُلاحقون', '');
  const transient = rows.filter((r) => r.seg.role === 'transient');
  lines.push(transient.length === 0
    ? 'لا عابر واحد في النطاق.'
    : transient.map((r) => `- ${r.name.slice(0, 50)} — ${silenceLabel(r.days)}`).join('\n'));
  lines.push('');
  lines.push('## العرض الساكت', '');
  const quiet = rows.filter((r) => r.seg.role === 'supply' && (r.days ?? 0) > 30);
  lines.push(quiet.length === 0
    ? 'لا مالك ساكت أكثر من شهر.'
    : quiet.map((r) => `- ${r.seg.codes[0]} ${r.name.slice(0, 46)} — ${silenceLabel(r.days)}`).join('\n'));
  lines.push('');
  return lines.join('\n');
}

function main() {
  const reportPath = arg('--report');
  const outPath = arg('--out');
  const todayIso = arg('--today', '2026-11-01');
  const limit = Number(arg('--limit', '10'));

  if (!reportPath || !outPath) {
    console.error('usage: build-daily-list.mjs --report <bundle.report.json> --out <file.md> [--today YYYY-MM-DD] [--limit N]');
    process.exit(2);
  }
  if (path.resolve(outPath).startsWith(`${REPO_ROOT}${path.sep}`)) {
    console.error('refused: the daily list carries customer PII and must be written outside the repository');
    process.exit(3);
  }

  const { report } = JSON.parse(readFileSync(reportPath, 'utf8'));
  const rows = buildRows(report, Date.parse(`${todayIso}T00:00:00Z`));

  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(outPath, render(rows, todayIso, limit), 'utf8');

  const bySegment = {};
  for (const s of SEGMENTS) bySegment[s.key] = rows.filter((r) => r.seg.key === s.key).length;
  console.log(JSON.stringify({
    in_scope: rows.length,
    with_number: rows.filter((r) => r.hasNumber).length,
    by_segment: bySegment,
    transient: rows.filter((r) => r.seg.role === 'transient').length,
    silent_over_30d: rows.filter((r) => (r.days ?? 0) > 30).length,
    written_to: outPath,
  }));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
