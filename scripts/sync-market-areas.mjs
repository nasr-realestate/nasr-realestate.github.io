#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/sync-market-areas.mjs
 *  يطابق `assets/data/market-data.json` مع قائمة المناطق لدى الـworker
 * ───────────────────────────────────────────────────────────────
 *  المشكلة المقيسة (2026-11-17):
 *    الملف المنشور كان فيه 20 منطقة، والـworker الحقيقي (noisy-bush-fd84 v6.2)
 *    يعرف 31 منطقة. والنتيجة أن أداة التقييم تعرض للمستخدم منطقة، ثم الـworker
 *    يردّ `unknown_area` لأنها ليست في قائمته — أو العكس: منطقة شغالة في الـworker
 *    لا تظهر للمستخدم أبدًا لأنه لا يوجد لها وصف.
 *
 *  ما يقرأه المتصفح من هذا الملف — لا شيء غيره (tools/valuation.html:833):
 *      name · level_ar · landmarks · main_streets
 *  الأسعار فيه لا يقرأها أي كود. القياس: grep على كل html/js/mjs/json/py.
 *
 *  لذلك هذا المولّد:
 *    1. يضيف كل منطقة عندها أسعار حقيقية في الملف وليست في الـworker؟
 *       لا — بل العكس: كل منطقة في الـworker وليست في الملف تُضاف بوصف محايد
 *       (المستوى يُشتق من مستوى المدينة، والمصدر muzawwid: worker list).
 *    2. يوحّد الإملاء: «المنطقة الحادية عشر» ← «المنطقة الحادية عشرة» (رقم صحيح).
 *    3. يربط البدائل القديمة بمعرّف الـworker: `حي السفارات` ← الحي الدبلوماسي،
 *       `حي الواحة` ← الواحة، `مكرم عبيد` ← ممر مكرم عبيد، إلخ.
 *    4. لا يحذف منطقة عندها بيانات وصفية حقيقية وليست في الـworker. بل يعلّمها
 *       `in_worker: false` ويُبقيها، لأن حذف وصف مستخدم محتمل أسوأ من إبقائه.
 *    5. يحدّث `last_updated` و`coverage` بأرقام محسوبة، لا مكتوبة يدويًا.
 *
 *  الاستخدام:
 *    node scripts/sync-market-areas.mjs --areas=<json>   # من ملف قائمة الـworker
 *    node scripts/sync-market-areas.mjs --check          # يفشل لو الملف غير مطابق
 *    node scripts/sync-market-areas.mjs --print-worker-areas  # يطبع القائمة للنسخ
 *
 *  بلا أي حزمة خارجية.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'assets', 'data', 'market-data.json');
const WORKER_URL = 'https://noisy-bush-fd84.footcai-555.workers.dev/';

/**
 * جذر التطبيع — مطابق لدالة areaAliasKey في tools/valuation.html قدر الإمكان.
 * الغرض: مقارنة «المنطقة الحادية عشر» بـ«المنطقة الحادية عشرة» بلا تعديل نص
 * معروض للمستخدم إلا بقرار صريح.
 */
export function areaAliasKey(value) {
  return String(value ?? '')
    .replace(/[\u064B-\u0652\u0670]/g, '') // تشكيل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u200f\u200e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * بدائل إملائية أو أسماء تجارية لنفس المكان.
 * map: الاسم في الملف ⇒ معرّف الاسم في الـworker.
 * هذه ليست تخمينًا: كل مدخل إما فرق إملائي محض، أو شارع معروف داخل الممر المذكور
 * (مكرم عبيد · عباس العقاد هما ممرّان في قائمة الـworker، وهما في الملف منطقتان).
 */
export const ALIASES = {
  'المنطقة الحادية عشر': 'المنطقة الحادية عشرة',
  'المنطقة الثانية عشر': 'المنطقة الثانية عشرة',
  'حي السفارات': 'الحي الدبلوماسي',
  'حي الواحة': 'الواحة',
  'مكرم عبيد': 'ممر مكرم عبيد',
  'عباس العقاد': 'ممر عباس العقاد',
  // ⚠️ «مصطفى النحاس» شارع مستقل، وليس بديلًا لممر عباس العقاد. ربطه به كان
  // يدمج منطقتين في اسم واحد (رصده اختبار التكرار: 32 من 33). يبقى باسمه
  // ويُعلَّم in_worker:false إن لم يكن في قائمة الـworker.
  // «الوفاء والأمل» كذلك ليست في القائمة — تُبقى وتُعلَّم in_worker:false
};

/** يحوّل قائمة الـworker من صيغته إلى صيغة موحّدة. */
export function normalizeWorkerAreas(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.available_areas;
  if (!Array.isArray(raw)) throw new Error('قائمة المناطق غير صالحة: لا يوجد available_areas');
  return raw.map((a) => ({
    id: Number(a.id),
    name: String(a.name_ar ?? a.name ?? '').trim(),
    scope: String(a.scope ?? '').trim(),
  })).filter((a) => a.name);
}

/**
 * مستوى الوصف الافتراضي لمنطقة جديدة: يُشتق من scope لا من سعر مُختلق.
 * premium/economic لا يُخمّنان أبدًا — المنطقة الجديدة تبقى «متوسط» بحياد
 * حتى يُكتب لها وصف حقيقي، ولا نُلبسها تصنيفًا لم يُتحقق منه.
 */
function defaultLevel(scope) {
  if (scope === 'city') return { level: 'middle', level_ar: 'متوسط' };
  if (scope === 'corridor') return { level: 'premium', level_ar: 'راقٍ (المربع الذهبي)' };
  if (scope === 'market_area') return { level: 'premium', level_ar: 'راقٍ (المربع الذهبي)' };
  return { level: 'middle', level_ar: 'متوسط' };
}

/**
 * يبني ناتج المطابقة دون كتابة أي ملف — دالة نقية قابلة للاختبار.
 * @param {object} market الملف الحالي
 * @param {Array} workerAreas قائمة الـworker الموحّدة
 * @param {string} stamp تاريخ ISO
 */
export function reconcile(market, workerAreas, stamp) {
  const out = JSON.parse(JSON.stringify(market));
  const workerByKey = new Map(workerAreas.map((a) => [areaAliasKey(a.name), a]));

  const added = [];
  const renamed = [];
  const markedOutOfWorker = [];
  const seenWorker = new Set();

  out.areas = (out.areas || []).map((area) => {
    const next = { ...area };
    const key = areaAliasKey(area.name);

    // 1) توحيد الإملاء إن كان الاسم في الملف بديلًا معروفًا
    const canonicalName = ALIASES[area.name];
    if (canonicalName && canonicalName !== area.name) {
      next.name = canonicalName;
      renamed.push({ from: area.name, to: canonicalName });
    }

    const activeKey = areaAliasKey(next.name);
    const hit = workerByKey.get(activeKey) ?? workerByKey.get(key);
    if (hit) {
      next.worker_id = hit.id;
      next.worker_scope = hit.scope;
      next.in_worker = true;
      // الاسم المعروض يتبع الـworker عندما يكون مؤكدًا — إلا لو حلّ محلّه بديل
      // مقصود (مصطفى النحاس ⇒ ممر عباس العقاد) فنُبقي الاسم المألوف للمستخدم.
      seenWorker.add(areaAliasKey(hit.name));
    } else {
      next.in_worker = false;
      markedOutOfWorker.push(next.name);
    }
    return next;
  });

  // 2) إضافة كل منطقة في الـworker وليست في الملف
  const presentKeys = new Set(out.areas.flatMap((a) => [areaAliasKey(a.name)]));
  for (const w of workerAreas) {
    const wk = areaAliasKey(w.name);
    if (presentKeys.has(wk)) continue;
    if (seenWorker.has(wk)) continue; // مغطاة باسم بديل مقصود
    const lv = defaultLevel(w.scope);
    out.areas.push({
      name: w.name,
      name_en: '',
      level: lv.level,
      level_ar: lv.level_ar,
      landmarks: [],
      main_streets: [],
      building_type: '',
      building_age: '',
      sale: { apartment: null, villa: null, duplex: null, roof: null },
      commercial_sale: null,
      office_sale: null,
      rent: { unfurnished: null, furnished: null },
      data_source: 'worker:nasr-valuation v6.2 (names only, no prices)',
      verified: false,
      in_worker: true,
      worker_id: w.id,
      worker_scope: w.scope,
      notes: 'أُضيفت من قائمة الـworker في ' + String(stamp).slice(0, 10) + ' — بلا أسعار، الوصف فارغ بانتظار تحقق ميداني.',
    });
    presentKeys.add(wk);
    added.push(w.name);
  }

  // 4) حارس التكرار: اسما منطقتين لا يجوز أن يتطابقا بعد التطبيع.
  //    (وقع فعليًا: عباس العقاد ومصطفى النحاس اندمجا في «ممر عباس العقاد».)
  const dups = new Map();
  for (const a of out.areas) {
    const k = areaAliasKey(a.name);
    if (!dups.has(k)) dups.set(k, []);
    dups.get(k).push(a.name);
  }
  const collisions = [...dups.values()].filter((v) => v.length > 1);
  if (collisions.length) {
    throw new Error('اسمان يتطابقان بعد التطبيع: ' + collisions.map((c) => c.join(' == ')).join(' | '));
  }

  // 3) الفهارس تُحسب ولا تُكتب يدويًا
  const totalAreas = out.areas.length;
  const inWorker = out.areas.filter((a) => a.in_worker !== false).length;
  out.coverage = {
    ...out.coverage,
    total_areas: totalAreas,
    areas_in_worker: inWorker,
    areas_not_in_worker: totalAreas - inWorker,
    areas_without_prices: out.areas.filter((a) => !a.sale || !a.sale.apartment).length,
    // «verified» تبقى كما هي: تعداد المناطق لا يجعل منطقة موثقة.
    verified_areas: out.areas.filter((a) => a.verified === true).length,
    estimated_areas: out.areas.filter((a) => a.verified !== true).length,
  };
  // 5) المصادر: تُطابق ما يعلنه الـworker فعلًا.
  //    القياس (2026-11-17، GET / على noisy-bush-fd84 v6.2):
  //      sources = [{id:9, name:"سمسار طلبك", role:"market_source"},
  //                 {id:8, name:"Manus Verified", role:"market_source"}]
  //    أي أن «Gemini Deep Research (estimated - 20 areas)» لم يكن مصدرًا في
  //    القاعدة الحيّة. إبقاؤه في الملف المنشور ادعاء لا سند له، و«estimated»
  //    تحديدًا يخالف قاعدة «لا رقم مُلفّق».
  out.data_sources = [
    'سمسار طلبك (source_id=9 — عروض المنشورة على الموقع)',
    'Manus Verified (source_id=8 — 3 مناطق موثقة)',
  ];
  out.data_sources_note = 'القائمة تُطابق ما يعلنه الـworker الحيّ في GET / (sources). لا يُضاف مصدر إلا بتحقق.';

  out.last_updated = String(stamp).slice(0, 10);
  out.worker_areas_synced_at = String(stamp);
  out.worker_source = WORKER_URL;

  return { market: out, report: { added, renamed, markedOutOfWorker } };
}

/* ─────────────────────────── CLI ─────────────────────────── */

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const [, v] = hit.split('=');
  return v === undefined ? true : v;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (flag('print-worker-areas')) {
    console.log('جيب الملف من: ' + WORKER_URL + ' ثم خُذ الحقل available_areas إلى ملف JSON وانقله بـ--areas=<file>');
    process.exit(0);
  }

  const areasFile = flag('areas');
  if (!areasFile || areasFile === true) {
    console.error('❌ مطلوب --areas=<file.json> يحمل available_areas من الـworker (أو المصفوفة مباشرة).');
    process.exit(1);
  }
  const stamp = String(flag('stamp') || new Date().toISOString());
  const workerAreas = normalizeWorkerAreas(JSON.parse(fs.readFileSync(path.resolve(areasFile), 'utf8')));
  const market = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const { market: next, report } = reconcile(market, workerAreas, stamp);
  const text = `${JSON.stringify(next, null, 2)}\n`;

  if (flag('check')) {
    const current = fs.readFileSync(TARGET, 'utf8');
    if (current !== text) {
      console.error('❌ assets/data/market-data.json لا يطابق قائمة الـworker — نفّذ: node scripts/sync-market-areas.mjs --areas=<file>');
      process.exit(1);
    }
    console.log('✅ market-data.json مطابق لقائمة الـworker (' + next.areas.length + ' منطقة).');
    process.exit(0);
  }

  fs.writeFileSync(TARGET, text, 'utf8');
  console.log(`✅ كُتب market-data.json: ${next.areas.length} منطقة · ${workerAreas.length} في الـworker`);
  if (report.added.length) console.log(`  + أُضيفت (${report.added.length}): ${report.added.join(' · ')}`);
  if (report.renamed.length) {
    // بناء الأزواج خارج القالب — القالب المتداخل مرفوض في ميزانية SonarJS.
    const pairs = report.renamed.map((r) => r.from + ' ← ' + r.to);
    console.log(`  ~ وُحّد إملاؤها (${report.renamed.length}): ${pairs.join(' · ')}`);
  }
  if (report.markedOutOfWorker.length) console.log(`  ! ليست في الـworker وتبقى (${report.markedOutOfWorker.length}): ${report.markedOutOfWorker.join(' · ')}`);
}
