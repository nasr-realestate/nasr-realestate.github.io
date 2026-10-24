#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/build-css.mjs — تقسيم الأنماط حسب نوع الصفحة
 * ───────────────────────────────────────────────────────────────────
 *  المشكلة (قياس 2026-10-24): `style.css` ملف واحد 288 ك.ب (31 ك.ب gzip) يُحمَّل
 *  في كل صفحة، رغم أن 79% منه أنماط مُنطَّقة بصفحة واحدة:
 *      global 50 ك.ب · page-agent 38 ك.ب · homepage 24 · page-properties 17
 *      layout-property_page 16 · layout-request_page 13 · … إلخ
 *  فصفحة العقارات مثلًا كانت تحمّل أنماط الوكيل والرئيسية والتقييم بلا سبب.
 *
 *  الحل: نفس المصدر `assets/css/style.css` (يبقى غير مُقسَّم — مصدر حقيقة واحد)،
 *  ويُبنى منه:
 *      assets/css/core.min.css            ← القواعد العامة والمكوّنات المشتركة
 *      assets/css/page-<scope>.min.css    ← أنماط نوع صفحة واحد
 *      _data/css_scopes.json              ← خريطة (body_class|layout) → ملفات
 *
 *  قواعد الأمان في التصنيف:
 *    • أي قاعدة تحتوي على محدِّد عام (بلا scope) بجانب محدِّد مُنطَّق → تُوضع في
 *      core (زيادة آمنة: تحميلها دائمًا لا يُغيّر شيئًا).
 *    • @media يُصنَّف بمحدِّداته الداخلية؛ إن خَلَط نطاقين يُنسخ في كليهما.
 *    • @font-face و@keyframes و:root وhtml/body → core دائمًا.
 *
 *  التشغيل: node scripts/build-css.mjs
 *  التحقق: npm run css:check (يفشل لو الملفات الناتجة قديمة)
 * ═══════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CleanCSS from 'clean-css';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'css', 'style.css');
const OUT_DIR = path.join(ROOT, 'assets', 'css');
const MAP_FILE = path.join(ROOT, '_data', 'css_scopes.json');

/** كل نطاق صفحة له ملف مستقل — المفتاح هو ما يظهر في المحدِّد */
const SCOPES = [
  'page-agent', 'page-luxury', 'page-valuation', 'page-generator', 'page-pgimages',
  'page-add', 'page-about', 'page-contact', 'page-requests', 'page-properties',
  'layout-property_page', 'layout-request_page', 'layout-landing', 'layout-app',
  'homepage', 'page-404', 'page-privacy', 'page-notifications',
];

/**
 * خريطة (body_class|layout) → { name, scopes }.
 * مُشتقّة من زحف فعلي لكل صفحات الموقع (119 صفحة · 15 تركيبة) — راجع
 * _diag/perf-mobile-2026-10-24.md. أي تركيبة جديدة تُضاف هنا.
 */
const ROUTES = {
  'default-page|property_page': { name: 'property', scopes: ['layout-property_page'] },
  'page-properties page-landing|landing': { name: 'landing', scopes: ['page-properties', 'layout-landing'] },
  'page-properties|default': { name: 'properties', scopes: ['page-properties'] },
  'default-page|request_page': { name: 'request', scopes: ['layout-request_page'] },
  'homepage|default': { name: 'home', scopes: ['homepage'] },
  'page-requests|default': { name: 'requests', scopes: ['page-requests'] },
  'page-add|app': { name: 'add', scopes: ['page-add', 'layout-app'] },
  'page-agent|app': { name: 'agent', scopes: ['page-agent', 'layout-app'] },
  '|': { name: 'valuation', scopes: ['page-valuation'] },
  'page-pgimages|default': { name: 'pgimages', scopes: ['page-pgimages'] },
  'page-luxury|': { name: 'luxury', scopes: ['page-luxury'] },
  'page-notifications|default': { name: 'notifications', scopes: ['page-notifications'] },
  'page-about|default': { name: 'about', scopes: ['page-about'] },
  'page-contact|default': { name: 'contact', scopes: ['page-contact'] },
  'page-privacy|default': { name: 'privacy', scopes: ['page-privacy'] },
  'page-404|default': { name: 'notfound', scopes: ['page-404'] },
};

/** يُضاف تلقائيًا لو ظهرت تركيبة غير معروفة أثناء البناء */
function scopesForSelector(selector) {
  return SCOPES.filter((scope) => selector.includes(scope));
}

/** يفصل CSS إلى بلوكات عليا (قواعد + @media/@supports كاملة). */
function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let selectorStart = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = css.slice(selectorStart, i).trim();
        // ابحث عن نهاية البلوك بمطابقة الأقواس (يشمل ما بداخل @media)
        let d = 1;
        let j = i + 1;
        while (j < css.length && d) {
          if (css[j] === '{') d += 1;
          else if (css[j] === '}') d -= 1;
          j += 1;
        }
        blocks.push({ head, body: css.slice(selectorStart, j) });
        selectorStart = j;
        i = j - 1;
        continue;
      }
    } else if (ch === '}') {
      if (depth === 0) selectorStart = i + 1;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) depth = 0;
    start = start || 0;
  }
  return blocks;
}

const ALWAYS_CORE = /^(@font-face|@keyframes|@-webkit-keyframes|@charset|@import)/;

function classify(block) {
  const head = block.head;
  if (ALWAYS_CORE.test(head)) return { core: true, scopes: [] };
  if (head.startsWith('@')) {
    // @media/@supports: صنّف بمحدِّدات الداخل
    const inner = block.body.slice(block.body.indexOf('{') + 1, block.body.lastIndexOf('}'));
    const innerScopes = new Set();
    let hasGlobal = false;
    for (const line of inner.split('}')) {
      const sel = line.split('{')[0].trim();
      if (!sel) continue;
      const found = scopesForSelector(sel);
      if (found.length) found.forEach((s) => innerScopes.add(s));
      // A comma list may mix a shared selector and a page-scoped one. Keep the
      // entire block in every route so the shared selector is never dropped
      // (notably reduced-motion on the contact ring).
      if (sel.split(',').some((part) => part.trim() && !scopesForSelector(part).length)) {
        hasGlobal = true;
      }
    }
    if (innerScopes.size === 0) return { core: true, scopes: [] };
    if (hasGlobal) return { core: true, scopes: [] };
    return { core: false, scopes: [...innerScopes] };
  }
  const found = scopesForSelector(head);
  if (!found.length) return { core: true, scopes: [] };
  // محدِّد مختلط (عام + مُنطَّق) → core للأمان
  const anyGlobal = head
    .split(',')
    .map((s) => s.trim())
    .some((s) => s && !scopesForSelector(s).length);
  if (anyGlobal) return { core: true, scopes: [] };
  return { core: false, scopes: found };
}

function minify(css) {
  const out = new CleanCSS({ level: { 1: { all: true }, 2: { all: false } } }).minify(css);
  if (out.errors?.length) throw new Error(out.errors.join('; '));
  return out.styles;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const raw = fs.readFileSync(SRC, 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = topLevelBlocks(css);
  const classified = blocks.map((block) => ({ block, ...classify(block) }));

  const written = [];
  const stale = [];
  const manifest = {};

  for (const [routeKey, route] of Object.entries(ROUTES)) {
    // ⚠️ الترتيب شرط صحّة: نفس ترتيب style.css حرفيًا، مع إسقاط ما لا يخصّ
    // الصفحة فقط. التقسيم إلى (core + ملف صفحة) كان يُغيّر ترتيب التتالي
    // (cascade) فتتغيّر أحجام بعض العناصر في الرئيسية — رصده فحص الانحدار
    // البصري. هنا ملف واحد لكل مسار فلا مجال لأي انحراف.
    const parts = [];
    for (const entry of classified) {
      const keep = entry.core || entry.scopes.some((sc) => route.scopes.includes(sc));
      if (keep) parts.push(entry.block.body);
    }
    const joined = parts.join('\n');
    const min = `${minify(joined)}\n`;
    const file = `route-${route.name}.min.css`;
    const full = path.join(OUT_DIR, file);
    const existing = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (existing !== min) {
      if (checkOnly) stale.push(file);
      else fs.writeFileSync(full, min, 'utf8');
    }
    written.push({ route: routeKey, file, rawKb: joined.length / 1024, minKb: min.length / 1024 });
    manifest[routeKey] = [file];
  }

  // ملفات التقسيم القديم (core/page-*) لم تعد مستخدمة — لا نتركها في المستودع
  for (const legacy of ['core']) {
    const stale = path.join(OUT_DIR, `${legacy}.min.css`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
  for (const scope of SCOPES) {
    const stale = path.join(OUT_DIR, `${scope}.min.css`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }

  // ⚠️ 2026-10-24: style.min.css هو احتياط أي مسار غير مسجّل (وسابقًا يُبنى
  // بأمر يدوي `npx cleancss` فلا يبقى متزامنًا مع المصدر). صار يُبنى هنا مع
  // البقية، و`--check` يتحقق منه أيضًا — فلا ينشر الموقع احتياطًا قديمًا.
  const fullMin = `${minify(css)}\n`;
  const fullPath = path.join(OUT_DIR, 'style.min.css');
  const fullExisting = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
  if (fullExisting !== fullMin) {
    if (checkOnly) stale.push('style.min.css');
    else fs.writeFileSync(fullPath, fullMin, 'utf8');
  }

  const mapJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const mapStale = fs.existsSync(MAP_FILE) ? fs.readFileSync(MAP_FILE, 'utf8') !== mapJson : true;
  if (checkOnly) {
    if (mapStale) stale.push('_data/css_scopes.json');
    if (stale.length) {
      console.error(`✖ ملفات أنماط قديمة (${stale.length}): ${stale.join(', ')}`);
      console.error('   الحل: node scripts/build-css.mjs');
      process.exitCode = 1;
      return;
    }
    console.log('✅ ملفات الأنماط محدَّثة ومطابقة لـ style.css');
    return;
  }
  fs.writeFileSync(MAP_FILE, mapJson, 'utf8');

  const total = written.reduce((a, b) => a + b.minKb, 0);
  const biggest = [...written].sort((a, b) => b.minKb - a.minKb).slice(0, 4);
  const smallest = [...written].sort((a, b) => a.minKb - b.minKb).slice(0, 3);
  console.log(`ℹ️  ${blocks.length} بلوك · ${written.length} ملف مسار · إجمالي ${total.toFixed(1)} KB`);
  console.log(`   أكبر: ${biggest.map((w) => `${w.file.replace('route-', '').replace('.min.css', '')} ${w.minKb.toFixed(1)}`).join(' · ')}`);
  console.log(`   أصغر: ${smallest.map((w) => `${w.file.replace('route-', '').replace('.min.css', '')} ${w.minKb.toFixed(1)}`).join(' · ')}`);
  const old = fs.statSync(path.join(OUT_DIR, 'style.min.css')).size / 1024;
  console.log(`   بدل الملف الواحد style.min.css ${old.toFixed(1)} KB في كل صفحة`);
}

main();
