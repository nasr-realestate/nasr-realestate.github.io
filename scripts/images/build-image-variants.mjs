#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/images/build-image-variants.mjs — نسخ الصور المحسّنة
 * ───────────────────────────────────────────────────────────────────
 *  لماذا (2026-10-24، بعد PageSpeed 65 على الجوال):
 *    • بطاقة الـHero في الرئيسية كانت تُخدَم بملف الصورة الأصلي الكامل
 *      (2048×1536 · 147 ك.ب) لعرض 358 بكسل على الجوال = إهدار 4 أضعاف.
 *      سببها الوحيد أن نسخة 4:3 (cards/) كانت مفقودة لهذا العرض.
 *    • خلفية قسم «المعرض السينمائي» ملف 1080×1420 · 82 ك.ب يُحمَّل دائمًا
 *      (CSS background) وهو أسفل الطية ومغطى بتدرّج أسود 92%.
 *    • صورة طارق 400×400 · 34 ك.ب تُعرض بحجم 54–96 بكسل.
 *
 *  ما يفعله (idempotent — لا يعيد التوليد لو الملف أحدث من مصدره):
 *    1) cards/<image> 4:3 (800×600 · q78) لكل وحدة تُستخدم صورتها الأصلية
 *       كبطاقة بلا نسخة cards/ (يقرأها scripts/lib/listing-facets.mjs).
 *    2) cinematic variant لخلفية المعرض السينمائي (1000px · q55).
 *    3) أحجام صورة الفريق: tareq-160 (160×160 · q80).
 *    4) نسخة 800px لكل صورة عقار (‑800w.webp · q72) — تُستخدم في srcset
 *       لصورة صفحة العقار، فتنزل على الجوال ~45 ك.ب بدل 147 ك.ب.
 *
 *  التشغيل:
 *    node scripts/images/build-image-variants.mjs
 *  المتطلبات: ImageMagick 6 (`convert`) — متوفر في GitHub Actions runners.
 * ═══════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROPS = path.join(ROOT, 'assets', 'img', 'properties');
const CARDS = path.join(PROPS, 'cards');
const TEAM = path.join(ROOT, 'assets', 'img', 'team');

const CARD = { width: 800, height: 600, quality: 78 };
const CINEMATIC = { width: 1000, quality: 55 };
const AVATAR = { size: 160, quality: 80 };
const WIDE = { width: 800, quality: 72 };

let made = 0;
let skipped = 0;

function newerThan(target, source) {
  try {
    return fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

function convert(args) {
  execFileSync('convert', args, { stdio: 'pipe' });
}

/** نسخة بطاقة 4:3 — تُقصّ من المنتصف بنفس نمط بقية ملفات cards/. */
function buildCard(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) return 'missing-source';
  // الملفات الموجودة مقصودة: صُنعت بمسار الصور التاريخي (_diag/image_process.py)
  // بمعايير قصّ/جودة مختلفة، ولا تُعاد كتابتها حتى لا يتغيّر شكل البطاقات المنشورة.
  if (fs.existsSync(targetFile)) { skipped += 1; return 'fresh'; }
  convert([
    sourceFile,
    '-auto-orient',
    '-resize', `${CARD.width}x${CARD.height}^`,
    '-gravity', 'center',
    '-extent', `${CARD.width}x${CARD.height}`,
    '-strip',
    '-quality', String(CARD.quality),
    targetFile,
  ]);
  made += 1;
  return 'built';
}

function buildCinematic(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) return 'missing-source';
  if (newerThan(targetFile, sourceFile)) { skipped += 1; return 'fresh'; }
  convert([
    sourceFile,
    '-auto-orient',
    '-resize', `${CINEMATIC.width}x`,
    '-strip',
    '-quality', String(CINEMATIC.quality),
    targetFile,
  ]);
  made += 1;
  return 'built';
}

/** نسخة 800px بنفس النسبة — لصورة صفحة العقار (LCP) على الجوال والشاشات المتوسطة. */
function buildWide(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) return 'missing-source';
  if (newerThan(targetFile, sourceFile)) { skipped += 1; return 'fresh'; }
  convert([
    sourceFile,
    '-auto-orient',
    '-resize', `${WIDE.width}x>`,
    '-strip',
    '-quality', String(WIDE.quality),
    targetFile,
  ]);
  made += 1;
  return 'built';
}

function buildAvatar(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) return 'missing-source';
  if (newerThan(targetFile, sourceFile)) { skipped += 1; return 'fresh'; }
  convert([
    sourceFile,
    '-auto-orient',
    '-resize', `${AVATAR.size}x${AVATAR.size}^`,
    '-gravity', 'center',
    '-extent', `${AVATAR.size}x${AVATAR.size}`,
    '-strip',
    '-quality', String(AVATAR.quality),
    targetFile,
  ]);
  made += 1;
  return 'built';
}

/** يقرأ أبعاد صورة عبر ImageMagick. */
function dimensions(file) {
  const out = execFileSync('identify', ['-format', '%w %h', file], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(' ').map(Number);
  return { w, h };
}

/**
 * يُكمل _data/image_dims.yml بكل صورة بلا إدخال.
 * وجود الإدخال هو ما يمنح صفحة العقار نسبة العرض الصحيحة (بلا قص وبلا CLS)
 * وهو أيضًا ما يفعّل srcset في القالب.
 */
function syncImageDims() {
  const dimsPath = path.join(ROOT, '_data', 'image_dims.yml');
  const current = fs.existsSync(dimsPath) ? fs.readFileSync(dimsPath, 'utf8') : '';
  const known = new Set([...current.matchAll(/^"([^"]+)":/gm)].map((m) => m[1]));
  const additions = [];
  for (const name of fs.readdirSync(PROPS).filter((f) => /\.webp$/i.test(f)).sort()) {
    if (name.endsWith('-cinematic.webp') || /-\d+w\.webp$/.test(name)) continue;
    const key = name.replace(/\.webp$/i, '');
    if (known.has(key)) continue;
    try {
      const { w, h } = dimensions(path.join(PROPS, name));
      additions.push(`"${key}": {w: ${w}, h: ${h}}`);
    } catch { /* ملف غير قابل للقراءة — يُتجاهل */ }
  }
  if (!additions.length) return 0;
  const base = current.endsWith('\n') || current === '' ? current : `${current}\n`;
  fs.writeFileSync(dimsPath, `${base}${additions.join('\n')}\n`, 'utf8');
  return additions.length;
}

function main() {
  fs.mkdirSync(CARDS, { recursive: true });

  // 1) كل صورة في assets/img/properties تحتاج نسخة بطاقة 4:3
  // نستبعد النسخ المولَّدة نفسها حتى لا تُولَّد لها نسخ متسلسلة بلا نهاية
  const isVariant = (f) => /-\d+w\.webp$/i.test(f) || f.endsWith('-cinematic.webp');
  // social-*.webp صور مشاركة (OG) وليست صور عقارات — لا تحتاج نسخة بطاقة
  const isSocial = (f) => /^social-/i.test(f);
  const sources = fs.readdirSync(PROPS)
    .filter((f) => /\.webp$/i.test(f) && !isVariant(f) && !isSocial(f))
    .sort();
  const built = [];
  for (const name of sources) {
    const source = path.join(PROPS, name);
    const state = buildCard(source, path.join(CARDS, name));
    if (state === 'built') built.push(name);
  }

  // 1b) نسخة 800px لكل صورة عقار (صفحة العقار على الجوال)
  let wide = 0;
  for (const name of sources) {
    const target = path.join(PROPS, name.replace(/\.webp$/i, '-800w.webp'));
    if (buildWide(path.join(PROPS, name), target) === 'built') wide += 1;
  }

  // 2) خلفية المعرض السينمائي
  const cineSource = path.join(PROPS, 'apartment-180m-nasr-city.webp');
  const cineTarget = path.join(PROPS, 'apartment-180m-nasr-city-cinematic.webp');
  buildCinematic(cineSource, cineTarget);

  // 3) صورة طارق بحجم العرض الفعلي
  buildAvatar(path.join(TEAM, 'tareq.webp'), path.join(TEAM, 'tareq-160.webp'));

  const kb = (p) => (fs.existsSync(p) ? `${(fs.statSync(p).size / 1024).toFixed(0)}KB` : '—');
  const dimsAdded = syncImageDims();
  console.log(`ℹ️  مصادر: ${sources.length} · بطاقات جديدة: ${made} · محدَّثة مسبقًا: ${skipped} · أبعاد مُضافة: ${dimsAdded}`);
  if (built.length) console.log(`   ${built.slice(0, 8).join(', ')}${built.length > 8 ? ' …' : ''}`);
  console.log(`✔ cinematic: ${kb(cineTarget)} · avatar: ${kb(path.join(TEAM, 'tareq-160.webp'))} · نسخ 800px: ${wide}`);
}

main();
