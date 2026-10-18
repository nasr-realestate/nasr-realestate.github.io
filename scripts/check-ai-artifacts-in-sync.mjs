// حرس الانحراف: ملفات طبقة الذكاء المحفوظة في الجذر يجب أن تساوي مخرجات المولّد.
//
// لماذا هذا الملف موجود؟
//   النشر الفعلي على GitHub Pages يأتي من **بناء الفرع** (master/الجذر) لا من
//   مخرَج Actions، لذلك تُحفظ مخرجات المُولّد في الجذر كي تُنشر. والثمن أن أي
//   تعديل على `_properties` أو على أدوات المُولّد قد يجعل النسخة المنشورة قديمة
//   بلا أي إشارة. هذا الفحص يفشل في CI عند أي انحراف، فالرسالة واضحة:
//       node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json
//
// ما لا ينحرف: القيم المتغيّرة بطبيعتها تُطبَّع قبل المقارنة (طوابع التوليد
// والتحديث فقط) — أما تواريخ العقارات والأرقام فتُقارَن كما هي بدقة.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** المسارات التي تُنشر من الجذر (ai-feed.json مستثنى: مصدره قالب Liquid يبنيه Jekyll). */
const PUBLISHED = ['llms-full.txt', 'ai.txt', 'mcp.json', 'search-data.json', 'api', '.well-known'];

/** يُطبّع القيم المتغيّرة بطبيعتها: طوابع التوليد/التحديث وطوابع «آخر تحديث» اليومية. */
function normalize(text) {
  return text
    .replace(/("(?:generated_at|updated_at)":\s*)"[^"]*"/g, '$1"<timestamp>"')
    .split('\n')
    .map((line) => {
      if (line.startsWith('# آخر تحديث:')) return line.replace(/\d{4}-\d{2}-\d{2}.*$/, '<date>');
      // ختم llms-full.txt نفسه بصيغة ماركداون — طابع يومي متغيّر بطبيعته مثل
      // الخطين أعلاه، وكان يفلت من التطبيع فيُسقط الفاحص فحشًا زائفًا كل يوم
      // جديد (الفرق الوحيد: التاريخ). المحتوى العقاري يُقارن كما هو.
      if (line.startsWith('- **آخر تحديث**:')) return line.replace(/\d{4}-\d{2}-\d{2}.*$/, '<date>');
      if (line.startsWith('Data-Freshness:')) return line.replace(/\d{4}-\d{2}-\d{2}\s*$/, '<date>');
      return line;
    })
    .join('\n');
}

/** كل الملفات تحت مسار، كنسبٍ من الجذر، مرتّبة. */
function walk(absolute, prefix = '') {
  const out = [];
  if (statSync(absolute).isFile()) return [prefix];
  for (const name of readdirSync(absolute).sort()) {
    out.push(...walk(path.join(absolute, name), prefix ? `${prefix}/${name}` : name));
  }
  return out;
}

const generated = mkdtempSync(path.join(tmpdir(), 'ai-artifacts-'));
let failures = 0;
try {
  execFileSync(process.execPath, ['scripts/build-ai-artifacts.mjs', `--out=${generated}`, '--skip=ai-feed.json'], {
    cwd: ROOT,
    stdio: 'pipe',
  });

  let checked = 0;
  for (const relative of PUBLISHED) {
    const committed = path.join(ROOT, relative);
    const fresh = path.join(generated, relative);
    let committedFiles;
    try {
      committedFiles = walk(committed);
    } catch {
      console.error(`❌ ${relative}: غير محفوظ في الجذر — نفّذ: node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json`);
      failures += 1;
      continue;
    }
    const freshFiles = walk(fresh);
    const missing = freshFiles.filter((f) => !committedFiles.includes(f));
    const extra = committedFiles.filter((f) => !freshFiles.includes(f));
    for (const file of missing) {
      console.error(`❌ ${relative}/${file}: موجود في مخرجات المولّد وغير محفوظ في الجذر`);
    }
    for (const file of extra) {
      console.error(`❌ ${relative}/${file}: محفوظ في الجذر ولا يُنتجه المولّد (ملف يدوي أو مهجور)`);
    }
    failures += missing.length + extra.length;

    for (const file of freshFiles.filter((f) => committedFiles.includes(f))) {
      const a = normalize(readFileSync(path.join(committed, file), 'utf8'));
      const b = normalize(readFileSync(path.join(fresh, file), 'utf8'));
      checked += 1;
      if (a !== b) {
        console.error(`❌ ${relative}/${file}: المحفوظ في الجذر لا يطابق مخرجات المولّد`);
        failures += 1;
      }
    }
  }

  assert.ok(checked > 100, `expected the AI layer to hold many files, compared only ${checked}`);
  if (failures) {
    console.error(`\n${failures} انحرافًا. الإصلاح: node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${checked} ملفًا في طبقة الذكاء مطابق لمخرجات المولّد (${PUBLISHED.join(', ')}).`);
  }
} finally {
  rmSync(generated, { recursive: true, force: true });
}
