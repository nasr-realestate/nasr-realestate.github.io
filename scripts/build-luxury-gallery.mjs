#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  scripts/build-luxury-gallery.mjs
 *  يولّد شريحة العرض في luxury-gallery.html من بيانات المنشور — لا نسخ يدوي.
 * ───────────────────────────────────────────────────────────────────────
 *  القاعدة (2026-11-18): «المعرض السينمائي = شقق فاخرة فقط، بيع، داخل النطاق،
 *  ابتداءً من 8,000,000 ج.م». قبل هذا كان 9 عروض مثبّتة يدويًا في الـHTML
 *  بينها «لقطة 1.65 مليون» — أي أن وعد «أفخم الوحدات» لم يكن مطابقًا للمحتوى،
 *  وأي عرض جديد أو تغيير سعر لا يظهر إلا بتحرير الملف يدويًا.
 *
 *  ما يولّده: مصفوفة `const properties = [...]` داخل الصفحة فقط.
 *  بقية الصفحة (المشغّل، السحب، الإيقاف) يبقى كما هو.
 *
 *  التشغيل: node scripts/build-luxury-gallery.mjs
 *  التحقق:  node scripts/build-luxury-gallery.mjs --check   (يفشل لو قديم)
 * ═══════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'luxury-gallery.html');
const FACETS = path.join(ROOT, '_data', 'listing_facets.json');
const PROPS = path.join(ROOT, 'api', 'properties.json');
const PROPS_DIR = path.join(ROOT, '_properties');

/** حدّ الفخامة: شقق بيع داخل مدينة نصر تبدأ من هذا الرقم. */
export const LUXURY_MIN_PRICE = 8_000_000;

/** أقصى عدد شرائح — أكثر من ذلك يُثقل الصفحة بلا فائدة. */
export const MAX_SLIDES = 10;

const START = '        const properties = [';
const END = '        ];';

/**
 * يقرأ عنوان كل عرض من front matter الملف المصدر مباشرة.
 * بعض الوحدات موجودة في listing_facets لكن ليست في api/properties.json؛
 * الاعتماد على الأول وحده كان يترك عنوانًا إنجليزيًا (الـslug) على الشاشة.
 */
function frontMatterTitles() {
  const map = new Map();
  if (!fs.existsSync(PROPS_DIR)) return map;
  for (const f of fs.readdirSync(PROPS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(PROPS_DIR, f), 'utf8');
    const fm = text.split('---')[1] || '';
    // نربط بالـid (وهو ما تستخدمه listing_facets) لا بالـslug:
    // 36 من 117 وحدة لها slug مختلف عن id — الاعتماد على slug كان يترك
    // عنوان الشريحة إنجليزيًا (مثال: mahmoud-elbadry-8th-district-380m).
    // حقل واحد لكل سطر: نقرأ السطر ثم ننزع علامات التنصيص.
    // (regex من نوع (?:\"?([^\"\\n]+)\"?) تُعدّ super-linear)
    const field = (name) => {
      const line = fm.split('\n').find((l) => l.startsWith(name + ':'));
      if (!line) return '';
      const v = line.slice(name.length + 1).trim();
      return v.replace(/^"/, '').replace(/"$/, '');
    };
    const id = field('id');
    const slug = field('slug');
    const title = field('title');
    if (title) {
      if (id) map.set(id.trim(), title.trim());
      if (slug) map.set(slug.trim(), title.trim());
    }
  }
  return map;
}

/** يقرأ الوحدات الفاخرة مرتّبة تنازليًا بالسعر. */
export function selectLuxury(facets, properties, titles = new Map()) {
  const all = Array.isArray(facets.listings)
    ? facets.listings
    : Object.entries(facets.listings || {}).map(([k, v]) => ({ ...v, __key: k }));
  const byId = new Map();
  for (const p of properties.properties) {
    byId.set(p.slug, p);
    if (p.id) byId.set(p.id, p);
  }

  // مفتاح listing_facets هو الـslug المنشور؛ حقل id قد يخالفه (36 من 117).
  // الروابط في المعرض يجب أن تكون slug وإلا صارت 404 داخل الموقع نفسه.
  const withKey = all.map((u) => ({ ...u, slug: u.slug || u.__key }));

  return withKey
    .filter(
      (u) =>
        u.in_area === true &&
        u.deal === 'sale' &&
        u.type === 'apartment' &&
        typeof u.price === 'number' &&
        u.price >= LUXURY_MIN_PRICE &&
        u.image,
    )
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_SLIDES)
    .map((u) => {
      const p = byId.get(u.slug) || byId.get(u.id) || {};
      const rawTitle = p.title || titles.get(u.slug) || titles.get(u.id) || u.slug;
      const big = u.area >= 250 ? 'مساحة واسعة' : 'تشطيب فاخر';
      const area = u.area ? `${u.area}م` : '';
      const desc = [area, big, p.finish || ''].filter(Boolean).join(' · ');
      // فيديو الوحدة: يُضمَّن فقط لو ملفه موجود فعلًا — لا مسار مكسور في الصفحة.
      // الوزن لا يتأثر: كل مشغّل `preload="none"` فلا يُحمَّل شيء قبل الضغط.
      const videoAbs = path.join(ROOT, 'assets', 'video', 'preview', `${u.slug}.mp4`);
      const hasVideo = fs.existsSync(videoAbs);
      // بصمة قصيرة على اسم الملف: إعادة بناء الفيديو تغيّر البصمة فيجلب
      // المتصفح النسخة الجديدة بدل نسخته المخزّنة (الفيديوهات كانت تُقدَّم
      // بلا أي كاسح كاش، فالمالك ظل يرى العربية المكسورة بعد الإصلاح).
      const videoFile = hasVideo
        ? `/assets/video/preview/${u.slug}.mp4?v=${crypto
            .createHash('sha256')
            .update(fs.readFileSync(videoAbs))
            .digest('hex')
            .slice(0, 8)}`
        : '';
      return {
        title: shortTitle(rawTitle, u),
        price: fmtPrice(u.price, p.price),
        priceNumeric: u.price,
        img: path.basename(u.image),
        desc,
        url: `/properties/${u.slug}/`,
        video: hasVideo ? videoFile : '',
      };
    });
}

/**
 * عنوان الشريحة: «<مكان> | <مساحة>م».
 *
 * تحليل النص الحرّ بالاستبعاد جرّبناه وفشل: خلّف بقايا مثل «كالقصور بعباس
 * العقاد عقاري» و«في حسن المأمون حتى». الحل الحاسم: **قائمة أعلام** —
 * نبحث عن أسماء الشوارع والمناطق المعروفة في مدينة نصر داخل عنوان العرض،
 * وإن لم نجدها نرجع إلى أقصر جزء مكاني معقول.
 */
export const LANDMARKS = [
  'عباس العقاد', 'مكرم عبيد', 'الطيران', 'مصطفى النحاس', 'حسن المأمون',
  'محمود البدري', 'أحمد الزمر', 'كابول', 'السلاب', 'عبد الرزاق السنهوري',
  'السنهوري', 'حسن الشريف', 'الحي العاشر', 'المنطقة العاشرة', 'المنطقة الأولى',
  'المنطقة الثامنة', 'المنطقة السادسة', 'المنطقة السابعة', 'مدينة نصر',
  'شينزو آبي', 'النصر', 'رابعة', 'السفارات', 'الميرغني', 'الزهراء',
  'الحي السادس', 'الحي السابع', 'الحي الثامن', 'الحي التاسع',
];

/** أول رقم يليه «م» في العنوان («شقة 380م …» ⇒ «380»). بلا regex متداخلة. */
function areaFromTitle(t) {
  const tok = t.split(/\s+/).find((w) => /^\d{2,4}م/.test(w));
  return tok ? tok.replace('م', '') : '';
}

/** «شقة X» ⇒ «X» */
function stripSh(a) {
  return a.startsWith('شقة') ? a.slice(3).trim() : a;
}

/** يختار أفضل مقطع مكاني من أجزاء العنوان. */
function pickPlace(t) {
  const ADMIN_WORDS = ['مدينة', 'مسجلة', 'عقاري', 'سعر', 'تفاوض', 'كاش',
    'تمليك', 'بيع', 'إيجار', 'الدور', 'بالكامل', 'مستوي', 'فاخر', 'قصور',
    'نخبة', 'حديث', 'تشطيب', 'فرصة', 'لقطة', 'مؤجر', 'غرف', 'حمام'];
  const isAdmin = (v) => ADMIN_WORDS.some((w) => v.indexOf(w) !== -1);
  const parts = t.split('-').map((c) => c.trim()).filter(Boolean);
  const good = parts.find((c) => !isAdmin(c) && stripSh(c).length >= 5);
  if (!good) return '';
  return stripSh(good).split(/\s+/).filter((w) => !/^\d+م$/.test(w)).join(' ');
}

export function shortTitle(t, unit = {}) {
  const area = areaFromTitle(t) || (unit.area ? String(unit.area) : '');
  const place = landmarkPlace(t) || streetPlace(t) || pickPlace(t) || 'مدينة نصر';
  return area ? `${place} | ${area}م` : place;
}

/** أول علامة معروفة في مدينة نصر تظهر في العنوان — أدقّ مصدر للمكان. */
function landmarkPlace(t) {
  const hit = LANDMARKS.find((lm) => t.includes(lm));
  return hit || '';
}

/** «… شارع محمود البدري …» ⇒ «شارع محمود البدري» (٣ كلمات كحد أقصى). */
function streetPlace(t) {
  const i = t.indexOf('شارع ');
  if (i === -1) return '';
  const tail = t.slice(i + 5).split(/[-–—]/)[0].trim();
  const words = tail.split(/\s+/).filter(Boolean).slice(0, 3);
  return words.length ? `شارع ${words.join(' ')}` : '';
}

function fmtPrice(num, original) {
  // نُبقي نص العرض الأصلي إن وُجد؛ وإلا ننسّق الرقم
  if (original && /ج\.م/.test(original)) return original;
  return `${num.toLocaleString('en-US')} ج.م`;
}

/** يبني كتلة JS منسّقة. */
export function renderBlock(items) {
  const body = items
    .map(
      (p) => `            {
                title: ${JSON.stringify(p.title)},
                price: ${JSON.stringify(p.price)},
                img: ${JSON.stringify(p.img)},
                desc: ${JSON.stringify(p.desc)},
                url: ${JSON.stringify(p.url)},
                video: ${JSON.stringify(p.video || '')}
            }`,
    )
    .join(',\n');
  return `${START}\n${body}\n${END}`;
}

/**
 * ItemList JSON-LD — يُبنى من نفس `items` المستخدمة في الشرائح، فلا يمكن
 * أن يختلف ما يراه محرك البحث عمّا يراه الزائر.
 */
export function renderSchema(items) {
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'شقق فاخرة للبيع في مدينة نصر — ابتداءً من 8 مليون جنيه',
    description:
      'معرض شقق مدينة نصر الفاخرة: مساحات من 220م، بيع، بأسعار تبدأ من 8,000,000 جنيه مصري. ' +
      'كل عرض بصورة حقيقية وسعر المالك المعلن، بلا وسطاء ولا أسعار مُقدَّرة.',
    url: 'https://nasr-realestate.github.io/luxury-gallery.html',
    numberOfItems: items.length,
    itemListElement: items.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Apartment',
        name: p.title,
        description: p.desc,
        url: `https://nasr-realestate.github.io${p.url}`,
        image: `https://nasr-realestate.github.io/assets/img/properties/${p.img}`,
        offers: {
          '@type': 'Offer',
          price: p.priceNumeric,
          priceCurrency: 'EGP',
          availability: 'https://schema.org/InStock',
          seller: { '@type': 'RealEstateAgent', name: 'سمار طلبك — طارق طنطاوي' },
        },
      },
    })),
  };
  return JSON.stringify(list, null, 2);
}

/**
 * محتوى نصي للمحركات (وبلا JS) — قائمة العروض نفسها.
 *
 * السبب المقيس: الصفحة كلها تُبنى بـJavaScript داخل `<main class="stage">`،
 * فمحرك البحث يرى صفحة فارغة تقريبًا. وبلا نصّ لا يوجد ما يُرشَّح.
 * هذا القسم مخفي بصريًا (المعرض يبقى تجربة كاملة الشاشة) لكنه في الـHTML
 * للقراءة والزحف، وفيه روابط حقيقية لكل عرض.
 */
export function renderSeoList(items) {
  const li = items
    .map(
      (p, i) =>
        `        <li>\n` +
        `          <a href="${p.url}">${p.title}</a>\n` +
        `          <span> — ${p.price}${p.desc ? ' · ' + p.desc : ''}</span>\n` +
        `        </li>`,
    )
    .join('\n');
  return `      <h2>شقق فاخرة للبيع في مدينة نصر — من 8 مليون جنيه</h2>
      <p>
        ${items.length} شقة فاخرة منشورة الآن للبيع في مدينة نصر، تبدأ من
        8,000,000 جنيه مصري. المساحات من 220 مترًا. كل عرض بسعره المعلن من
        صاحبه وبصورته الحقيقية — بلا أسعار مُقدَّرة ولا وحدات غير موجودة.
      </p>
      <ol>
${li}
      </ol>
      <p>
        للاستفسار عن أي وحدة: طارق طنطاوي — عقارات مدينة نصر فقط منذ 2014.
      </p>`;
}

export function buildPage(html, items) {
  const i = html.indexOf(START);
  const j = html.indexOf(END, i);
  if (i === -1 || j === -1) throw new Error('لم أجد مصفوفة properties في luxury-gallery.html');
  let out = html.slice(0, i) + renderBlock(items) + html.slice(j + END.length);

  // كتلة JSON-LD بين علامتين — تُستبدل كاملة في كل بناء
  // المحتوى النصي
  const C0 = '<!-- ====LUXURY-SEO-START==== -->';
  const C1 = '<!-- ====LUXURY-SEO-END==== -->';
  const c0 = out.indexOf(C0);
  const c1 = out.indexOf(C1);
  if (c0 === -1 || c1 === -1) throw new Error('لم أجد علامتي المحتوى النصي في luxury-gallery.html');
  out = out.slice(0, c0) + `${C0}\n${renderSeoList(items)}\n      ${C1}` + out.slice(c1 + C1.length);

  const S0 = '<!-- ====LUXURY-SCHEMA-START==== -->';
  const S1 = '<!-- ====LUXURY-SCHEMA-END==== -->';
  const a = out.indexOf(S0);
  const b = out.indexOf(S1);
  if (a === -1 || b === -1) throw new Error('لم أجد علامتي schema في luxury-gallery.html');
  out =
    out.slice(0, a) +
    `${S0}\n    <script type="application/ld+json">\n${renderSchema(items)}\n    </script>\n    ${S1}` +
    out.slice(b + S1.length);
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const facets = JSON.parse(fs.readFileSync(FACETS, 'utf8'));
  const props = JSON.parse(fs.readFileSync(PROPS, 'utf8'));
  const items = selectLuxury(facets, props, frontMatterTitles());
  const current = fs.readFileSync(PAGE, 'utf8');
  const next = buildPage(current, items);

  if (check) {
    if (next !== current) {
      console.error('❌ luxury-gallery.html لا يطابق المولّد — شغّل: node scripts/build-luxury-gallery.mjs');
      process.exit(1);
    }
    console.log(`✅ المعرض مطابق للمولّد (${items.length} شريحة · حد ${LUXURY_MIN_PRICE.toLocaleString('en-US')} ج.م)`);
    return;
  }

  fs.writeFileSync(PAGE, next);
  console.log(`✅ ${items.length} شريحة فاخرة (≥ ${LUXURY_MIN_PRICE.toLocaleString('en-US')} ج.م):`);
  for (const p of items) console.log(`   ${p.price.padEnd(28)} ${p.title}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-luxury-gallery.mjs')) main();
