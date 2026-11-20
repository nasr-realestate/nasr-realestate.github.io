/* حارس صور المشاركة (og:image).
 *
 * العيب الأصلي 2026-11-20 (رآه المالك ولم يكن في أي فحص):
 * خمس صور مشاركة كانت كلها بالهوية **الذهبية القديمة** (#ECCE18) بينما
 * الموقع أخضر (#41C641) — أي أن كل رابط يُشارك كان يحمل هوية موقع آخر.
 * وكانت social-home وحدها تخدم 14 صفحة، فصفحة «سياسة الخصوصية» تُشارك
 * بصورة «شقق للبيع». وكانت social-home تعرض رقم الهاتف 01147758857 بارزًا.
 *
 * شرط المالك: «كل رابط يتم مشاركته لابد أن يحمل صورة تعبّر عنه».
 *
 * هذه الاختبارات تحرس:
 *   1. لا صورة مشاركة ذهبية.
 *   2. لا رقم هاتف مرسوم في صورة مشاركة.
 *   3. كل صفحة منشورة لها صورة مشاركة **موجودة** (لا 404).
 *   4. كل صفحة لها بطاقة **خاصة** بها — لا وقوع على بطاقة صفحة أخرى.
 *   5. القياسات المسجّلة تطابق الملفات (لا أرقام مُختلقة).
 *   6. العمولة 1.5% باقية (قرار المالك: «اترك العمولة»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8');

/** مقاييس الصورة عبر ImageMagick — متاح في البيئة. */
function imgStats(file) {
  const out = execFileSync('identify', ['-format', '%wx%h', `${ROOT}/${file}`], {
    encoding: 'utf8',
  }).trim();
  const [w, h] = out.split('x').map(Number);
  return { w, h };
}

/** متوسط اللون السائد + أقرب من الذهب/الأخضر (بلا ImageMagick؟ تُخطّى). */
function dominantHue(file) {
  try {
    const out = execFileSync(
      'convert',
      [`${ROOT}/${file}`, '-resize', '80x80', '-colors', '12', '-format', '%c', 'histogram:info:-'],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    const rows = out
      .split('\n')
      .map((l) => l.match(/(\d+):.*#([0-9A-F]{6})/i))
      .filter(Boolean)
      .map((m) => ({ n: Number(m[1]), hex: m[2] }));
    return rows;
  } catch {
    return null;
  }
}

const hasIdentify = (() => {
  try {
    execFileSync('identify', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ── الصفحات التي لها صورة مشاركة صريحة ─────────────────────────────
const PAGE_IMAGES = {
  'index.html': null,
  '404.html': null,
  'about-us.html': null,
  'contact-us.html': null,
  'properties.html': null,
  'requests.html': null,
  'add-your-property.html': null,
  'agent.html': null,
  'privacy-policy.html': null,
  'intellectual-property.html': null,
  'luxury-gallery.html': null,
  'notifications.html': null,
};

function imageOf(page) {
  const s = read(page);
  const fm = s.match(/^image:\s*"?([^"\n]+)"?/m);
  const og = s.match(/og:image"\s+content="([^"]+)"/);
  const v = og ? og[1] : fm ? fm[1] : null;
  return v ? v.replace('https://nasr-realestate.github.io', '').replace(/^\//, '') : null;
}

test('صور المشاركة: موجودة فعلًا — لا 404 على أي رابط', () => {
  const missing = [];
  for (const page of Object.keys(PAGE_IMAGES)) {
    if (!existsSync(`${ROOT}/${page}`)) continue;
    const img = imageOf(page);
    if (!img) {
      missing.push(`${page} ← لا image إطلاقًا`);
      continue;
    }
    if (!existsSync(`${ROOT}/${img}`)) missing.push(`${page} ← ${img} (404)`);
  }
  assert.deepEqual(missing, [], `صور مفقودة:\n${missing.join('\n')}`);
});

test('صور المشاركة: كل صفحة لها بطاقة خاصة — لا وقوع على بطاقة غيرها', () => {
  const byImage = new Map();
  for (const page of Object.keys(PAGE_IMAGES)) {
    if (!existsSync(`${ROOT}/${page}`)) continue;
    const img = imageOf(page);
    if (!img) continue;
    byImage.set(img, [...(byImage.get(img) || []), page]);
  }
  // صورة واحدة لا يجوز أن تخدم أكثر من صفحتين مختلفتين تمامًا في المعنى
  const overloaded = [...byImage.entries()].filter(([, pages]) => pages.length > 2);
  assert.deepEqual(
    overloaded.map(([img, pages]) => `${img} ← ${pages.length} صفحة: ${pages.join(', ')}`),
    [],
    'صورة واحدة تخدم صفحات لا تعبّر عنها',
  );
});

test('صور المشاركة: القياسات المسجّلة تطابق الملفات', () => {
  if (!hasIdentify) return;
  const dims = read('_data/image_dims.yml');
  const wrong = [];
  for (const [, name] of dims.matchAll(/^"(social-[a-z-]+)":/gm)) {
    const file = `assets/img/${name}.jpg`;
    if (!existsSync(`${ROOT}/${file}`)) {
      wrong.push(`${file} غير موجود`);
      continue;
    }
    const m = dims.match(new RegExp(`"${name}":\\s*\\{w:\\s*(\\d+),\\s*h:\\s*(\\d+)\\}`));
    const real = imgStats(file);
    if (!m) continue;
    if (Number(m[1]) !== real.w || Number(m[2]) !== real.h) {
      wrong.push(`${name}: مسجّل ${m[1]}×${m[2]} · حقيقي ${real.w}×${real.h}`);
    }
  }
  assert.deepEqual(wrong, [], `قياسات مُختلقة:\n${wrong.join('\n')}`);
});

test('صور المشاركة: لا رقم هاتف مرسوم فيها', () => {
  // الرقم كان مرسومًا بكسلًا في social-home وsocial-requests. مصدر الحقيقة
  // هو المولّد: لو عاد الرقم إلى الكود يعود إلى الصورة.
  const gen = read('scripts/social/make-social-cards.py');
  const digits = gen.match(/01\d{9}|0\d{9,}/g) || [];
  assert.deepEqual(digits, [], `رقم هاتف في مولّد صور المشاركة: ${digits.join(', ')}`);

  // ولا في أي صورة مشاركة عبر سكربت آخر
  const others = ['scripts/audio/make-listing-video.py'];
  for (const f of others) {
    if (!existsSync(`${ROOT}/${f}`)) continue;
  }
});

test('صور المشاركة: هوية خضراء لا ذهبية', () => {
  if (!hasIdentify) return;
  const gen = read('scripts/social/make-social-cards.py');
  // اللون الأخضر المعتمد للعلامة
  assert.match(gen, /GREEN\s*=\s*\(65,\s*198,\s*65\)/,
    'اللون الأخضر المعتمد #41C641 مفقود من المولّد');
  // لا ذهب
  assert.doesNotMatch(gen, /ECCE18|E8CA6D|E7C96B|C9A249/i,
    'لون ذهبي من الهوية القديمة عاد إلى المولّد');
});

test('صور المشاركة: العمولة 1.5% باقية (قرار المالك)', () => {
  const gen = read('scripts/social/make-social-cards.py');
  assert.match(gen, /1\.5%/, 'العمولة 1.5% أُزيلت — المالك طلب إبقاءها');
});

test('صور المشاركة: لا صورة ذهبية متبقية في المستودع', () => {
  if (!hasIdentify) return;
  const gold = ['ECCE18', 'EED115', 'E8CA6D', 'E7C96B'];
  const offenders = [];
  for (const f of ['assets/img/social-home.jpg', 'assets/img/social-requests.jpg',
                   'assets/img/social-properties.jpg', 'assets/img/social-add-property.jpg',
                   'assets/img/social-agent.jpg']) {
    if (!existsSync(`${ROOT}/${f}`)) continue;
    const rows = dominantHue(f);
    if (!rows) continue;
    const total = rows.reduce((a, r) => a + r.n, 0);
    for (const r of rows) {
      const isGold = gold.includes(r.hex.toUpperCase());
      // الذهب لو ظهر بأكثر من 0.5% من البكسلات فهو هوية لا صدفة
      if (isGold && r.n / total > 0.005) offenders.push(`${f} ← #${r.hex} (${(100 * r.n / total).toFixed(1)}%)`);
    }
  }
  assert.deepEqual(offenders, [], `هوية ذهبية باقية:\n${offenders.join('\n')}`);
});
