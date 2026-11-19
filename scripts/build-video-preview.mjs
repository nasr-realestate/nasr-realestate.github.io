#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  scripts/build-video-preview.mjs
 *  يولّد بطاقات صفحة «شقق بالفيديو» من بيانات المنشور — لا نسخ يدوي.
 * ───────────────────────────────────────────────────────────────────────
 *  لماذا هذا الملف (2026-11-18):
 *  الصفحة كانت تحمل بطاقتين مكتوبتين باليد، وفيهما سطور لا تخدم الزائر:
 *    «المقاس: 480×854 (9:16) · 12 إطار/ث»
 *    «الحجم: 615 ك.ب · المدة: 24.5 ثانية»
 *  هذه أرقام هندسية للفيديو، لا يُفيد الزائر منها شيء، وقد تُقرأ كعيب
 *  («ليه الجودة واطية»). والمفيد — غرف وحمامات ودور وتشطيب — كان غائبًا.
 *
 *  ما يفعله: يقرأ بيانات كل وحدة من `api/properties.json` ويبني بطاقة
 *  تعرض ما يسأل عنه المشتري فعلًا. وأي إضافة/تغيير سعر أو مواصفات تظهر
 *  تلقائيًا بلا تحرير HTML.
 *
 *  التشغيل: node scripts/build-video-preview.mjs
 *  التحقق:  node scripts/build-video-preview.mjs --check   (يفشل لو قديم)
 * ═══════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'video-preview.html');
const PROPS = path.join(ROOT, 'api', 'properties.json');
const VIDEOS = path.join(ROOT, 'assets', 'video', 'preview');

const START = '  <!-- ====VIDEO-CARDS-START==== -->';
const END = '  <!-- ====VIDEO-CARDS-END==== -->';

/**
 * حقول المواصفات التي تهمّ المشتري، بترتيب أولوية العرض.
 * `expect` يحمي من بيانات مصدر مكتوبة في الحقل الخطأ: وحدة محمود البدري
 * تحمل في `rooms` نص «مساحة واسعة على مستويين» وفي `baths` نص «تشطيب فندقي
 * فاخر». عرضها بلا فحص كان ينتج «الحمامات: تشطيب فندقي فاخر» — كلام غير
 * صحيح على صفحة منشورة. لا نخترع رقمًا بديلًا: نتخطّى الحقل ونعرض النص
 * كسطر مواصفة عام بلا عنوان مضلّل.
 */
const FACTS = [
  ['rooms', 'الغرف', /غرف|غرفة|ريسبشن|ليفينج|أوض|اوض/],
  ['baths', 'الحمامات', /حمام/],
  ['floor', 'الدور', /دور|أرضي|ارضي|روف/],
  ['finish', 'التشطيب', /تشطيب|سوبر لوكس|لوكس|نصف|طوب|محارة/],
  // `zone` في المصدر يحمل أحيانًا اسم شارع («شارع أحمد الزمر») لا حيًّا —
  // نصفّيه بالتعبير نفسه حتى لا يُعرض «المنطقة: شارع أحمد الزمر».
  ['zone', 'المنطقة', /^المنطقة|^الحي/],
];

/** بصمة محتوى الملف: إعادة البناء تكسر كاش المتصفح تلقائيًا. */
function fileHash(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 8);
}

/** المدّة بالثواني من رأس MP4 (mvhd) — بلا ffmpeg. */
function mp4Seconds(abs) {
  try {
    const b = fs.readFileSync(abs);
    const i = b.indexOf('mvhd');
    if (i === -1) return 0;
    const version = b[i + 4];
    // mvhd: 'mvhd' + version(1) + flags(3) + created + modified + timescale + duration
    const timescale = version === 1 ? b.readUInt32BE(i + 28) : b.readUInt32BE(i + 16);
    const duration = version === 1
      ? Number(b.readBigUInt64BE(i + 32))
      : b.readUInt32BE(i + 20);
    return timescale ? duration / timescale : 0;
  } catch {
    return 0;
  }
}

function fmtKg(bytes) {
  return `${(bytes / 1_048_576).toFixed(2)} م.ب`;
}

/** يختار الوحدات التي لها فيديو مبني فعلًا، مرتّبة تنازليًا بالسعر. */
export function selectVideos(properties, videosDir = VIDEOS) {
  const has = (slug) => fs.existsSync(path.join(videosDir, `${slug}.mp4`));
  return properties.properties
    .filter((p) => p.transaction === 'sale' && p.propertyType === 'apartment')
    .filter((p) => has(p.slug))
    .sort((a, b) => (b.priceNumeric ?? 0) - (a.priceNumeric ?? 0))
    .map((p) => {
      const abs = path.join(videosDir, `${p.slug}.mp4`);
      return {
        ...p,
        videoAbs: abs,
        videoSrc: `/assets/video/preview/${p.slug}.mp4?v=${fileHash(abs)}`,
        bytes: fs.statSync(abs).size,
        seconds: mp4Seconds(abs),
      };
    });
}

/** عنوان البطاقة: المكان ثم المساحة — بلا تكرار للمساحة. */
export function cardTitle(p) {
  const zone = (p.zone || '').trim();
  const street = (p.location || '').split(/[-–—]/)[0].trim();
  const head = zone && street.includes(zone) === false ? `${street} — ${zone}` : street;
  return `${head} · ${p.areaNumeric || ''}م`.replace(' · م', '');
}

export function renderCards(items) {
  const cards = items
    .map((p) => {
      const title = cardTitle(p);
      const facts = FACTS.map(([k, label, expect]) => {
        const v = (p[k] || '').trim();
        if (!v) return '';
        if (!expect.test(v)) {
          // النص لا يطابق عنوانه ⇒ سطر مواصفة عام بلا تسمية كاذبة — إلا لو
          // كان مكرّرًا حرفيًا في عنوان البطاقة (اسم الشارع) فلا فائدة منه.
          if (/^(شارع|طريق)\s/.test(v) && title.includes(v)) return '';
          return `        <li class="vp-fact-free"><b>${escapeHtml(v)}</b></li>`;
        }
        return `        <li><span>${label}</span> <b>${escapeHtml(v)}</b></li>`;
      })
        .filter(Boolean)
        .join('\n');
      return `
    <div class="vp-card">
      <h2>${escapeHtml(cardTitle(p))}</h2>
      <p class="vp-meta">${escapeHtml(p.price)} · ${escapeHtml(p.area || '')}</p>
      <video controls preload="none" playsinline
             poster="{{ '/assets/img/properties/${p.imageFile || ''}' | relative_url }}">
        <source src="{{ '${p.videoSrc.replace(/&/g, '&amp;')}' | relative_url }}" type="video/mp4">
        متصفحك لا يدعم تشغيل الفيديو.
      </video>
      <ul class="vp-facts">
${facts}
      </ul>
      <a class="vp-link" href="{{ '/properties/${p.slug}/' | relative_url }}">صفحة العرض كاملة ←</a>
    </div>`;
    })
    .join('\n');

  const total = items.length;
  const minPrice = items.length
    ? Math.min(...items.map((p) => p.priceNumeric || Infinity))
    : 0;
  const meta = total
    ? `<p class="vp-count">${total} وحدة بفيديو · تبدأ من ${minPrice.toLocaleString('en-US')} ج.م</p>`
    : '<p class="vp-count">لا توجد وحدات بفيديو منشورة الآن.</p>';

  return `${START}\n${meta}\n\n    <div class="vp-grid">${cards}\n\n    </div>\n  ${END}`;
}

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

export function buildPage(html, items) {
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  if (i === -1 || j === -1) {
    throw new Error(`علامتا البناء غير موجودتين في ${path.basename(PAGE)}`);
  }
  return html.slice(0, i) + renderCards(items) + html.slice(j + END.length);
}

function main() {
  const check = process.argv.includes('--check');
  const html = fs.readFileSync(PAGE, 'utf8');
  const properties = JSON.parse(fs.readFileSync(PROPS, 'utf8'));
  const items = selectVideos(properties);
  const next = buildPage(html, items);

  if (check) {
    if (next !== html) {
      console.error('❌ الصفحة لا تطابق المولّد — شغّل: node scripts/build-video-preview.mjs');
      process.exit(1);
    }
    console.log(`✅ صفحة الفيديو مطابقة للمولّد (${items.length} وحدة)`);
    return;
  }

  fs.writeFileSync(PAGE, next);
  console.log(`✅ ${items.length} بطاقة فيديو مولَّدة`);
  for (const p of items) {
    // الحجم والمدة يظهران هنا للتشخيص فقط — لا يُطبعان في الصفحة.
    console.log(
      `   ${String(p.areaNumeric).padStart(3)}م · ${p.price.padEnd(30)} · ` +
        `${fmtKg(p.bytes)} · ${p.seconds.toFixed(1)}ث`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
