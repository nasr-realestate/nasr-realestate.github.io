/**
 * The core report — the only list the broker is asked to look at.
 *
 * Reads the importer's report and prints the five segments he actually works
 * in, newest conversation first, with how long each man has been silent.
 *
 * It refuses to write inside the repository: this file carries names, numbers
 * and addresses, and the repo is public.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS, segmentsOf } from './segments.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DAY = 86_400_000;

const args = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const reportPath = arg('--report');
const outPath = arg('--out');
const today = Date.parse(`${arg('--today', '2026-11-01')}T00:00:00Z`);

if (!reportPath || !outPath) {
  console.error('usage: build-core-report.mjs --report <bundle.report.json> --out <file.md> [--today YYYY-MM-DD]');
  process.exit(2);
}
if (path.resolve(outPath).startsWith(`${REPO_ROOT}${path.sep}`)) {
  console.error('refused: the core report carries customer PII and must be written outside the repository');
  process.exit(3);
}

const { report } = JSON.parse(readFileSync(reportPath, 'utf8'));
const clean = (t) => String(t || '').replace(/\.(zip|txt)$/i, '');

/** How long a man has been silent, in the words a broker uses. */
function silenceLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days === 0) return 'اليوم';
  return `${days} يومًا`;
}

const people = report.map((r) => {
  const label = r.resolved_to || clean(r.chat_title);
  const seg = segmentsOf(`${r.chat_title || ''} ${r.resolved_to || ''}`);
  const last = r.last ? Date.parse(r.last) : null;
  return { ...r, label: clean(label), seg, last, days: last ? Math.round((today - last) / DAY) : null };
});

const inScope = people.filter((p) => p.seg.inScope);
const outOfScope = people.filter((p) => !p.seg.inScope);

const lines = [];
lines.push('# الخمسة', '');
lines.push(`_${arg('--today', '2026-11-01')} · من ${report.length} محادثة حقيقية_`, '');
lines.push('| العلامة | المعنى | عملاء | رسائل |');
lines.push('|---|---|---|---|');
for (const s of SEGMENTS) {
  const list = inScope.filter((p) => p.seg.key === s.key);
  lines.push(`| ${s.code} | ${s.label} | **${list.length}** | ${list.reduce((n, p) => n + (p.messages || 0), 0)} |`);
}
lines.push(`| | **المجموع** | **${inScope.length}** | ${inScope.reduce((n, p) => n + (p.messages || 0), 0)} |`);
lines.push('');
if (outOfScope.length > 0) {
  lines.push(`> ${outOfScope.length} بلا علامة — محفوظة في القاعدة، وخارج عملك: ${outOfScope.map((p) => p.label).join(' · ')}`);
  lines.push('');
}

for (const s of SEGMENTS) {
  const list = inScope.filter((p) => p.seg.key === s.key).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  if (list.length === 0) continue;
  lines.push(`## ${s.code} ${s.label} — ${list.length}`, '');
  lines.push('| العميل | رسائل | آخر كلام |', '|---|---|---|');
  for (const p of list) {
    lines.push(`| ${p.label.slice(0, 60)} | ${p.messages ?? 0} | ${silenceLabel(p.days)} |`);
  }
  lines.push('');
}

const silent = inScope.filter((p) => (p.days ?? 0) > 30).length;
lines.push('## الحساب', '');
lines.push(`${inScope.length} عميلًا في نطاقك · ${silent} منهم ساكتون أكثر من شهر · ${outOfScope.length} خارج النطاق.`);
lines.push('');

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({
  in_scope: inScope.length,
  out_of_scope: outOfScope.length,
  by_segment: SEGMENTS.map((s) => [s.key, inScope.filter((p) => p.seg.key === s.key).length]),
  silent_over_30d: silent,
  written_to: outPath,
}));
