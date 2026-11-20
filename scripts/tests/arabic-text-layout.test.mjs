/* انحدار راسم النص العربي (scripts/audio/arabic_text.py).
 *
 * العيب الأصل 2026-11-18: HarfBuzz يرصف العربية RTL ويُعيد الحروف بترتيب
 * بصري جاهز، لكن layout() كان يجمّع العروض تصاعديًا من صفر فينقلب ترتيب
 * الكلمة وتتراكب/تتكرر حروفها («مسستتوينن» بدل «مستويين») — رأى المالك
 * العيب في كل فيديوهات المعرض. الاختبارات هنا تحرس الإصلاح.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SCRIPT = 'scripts/audio/arabic_text.py';
const skip = existsSync(SCRIPT) ? false : `${SCRIPT} غير موجود`;

function py(code) {
  return execFileSync('python3', ['-c', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PYTHONPATH: 'scripts/audio', PYTHONDONTWRITEBYTECODE: '1' },
  }).trim();
}

/*
 * عيب 2026-11-20: كان الفحص `import uharfbuzz, freetype` — حزمتان فقط من
 * خمس. فكان نقص numpy أو fonttools أو brotli يُنتج SKIP «كل شيء سليم»
 * بينما الاختبارات الثلاثة تفشل فعلًا. حارس يتجاوز ما يحرسه = إشارة
 * تُعلّم الجميع التجاهل (نفس نمط عيب verify-deployment).
 *
 * الإصلاح: نستورد السكربت نفسه. أي تبعية ناقصة تُفشل الاستيراد هنا،
 * فتصير معروفة باسمها بدل أن تُخفى. لا قائمة أسماء تُنسى تحديثها.
 */
const importError = (() => {
  try {
    py('import arabic_text; print("ok")');
    return false;
  } catch (err) {
    const msg = String(err.stderr || err.message || err);
    const missing = msg.match(/No module named '([^']+)'/);
    return missing ? `حزمة بايثون ناقصة: ${missing[1]}` : msg.split('\n').filter(Boolean).pop();
  }
})();

if (importError) {
  console.error(
    `\n⚠️  اختبارات تشكيل النص العربي لم تُشغَّل: ${importError}\n` +
    '    ثبّت التبعيات: python3 -m pip install -r scripts/audio/requirements.txt\n',
  );
}
// ⚠️ `false` لا `''`: Node يعتبر { skip: '' } تجاوزًا (يفحص النوع لا القيمة)
// فيتخطى الاختبار بصمت وبلا سبب ظاهر. وقعتُ فيها فعليًا 2026-11-20.
const skipDeps = skip || importError;

test('layout: يرصف الحروف تصاعديًا بلا تراكب', { skip: skipDeps }, () => {
  const out = py(`
import json, arabic_text as AT
items, width = AT.layout('تشطيب', '900')
print(json.dumps({'x': [round(p, 4) for _, _, p, _ in items], 'w': round(width, 4)}))
`);
  const { x, w } = JSON.parse(out);
  assert.equal(x.length, 5, '«تشطيب» خمسة حروف');
  for (let i = 1; i < x.length; i++) {
    assert.ok(x[i] > x[i - 1], `الموضع ${i} يجب أن يكون أكبر من سابقه (${x})`);
  }
  assert.ok(Math.abs(x[0]) < 1e-6, 'أول حرف عند الصفر');
  assert.ok(x[x.length - 1] < w, 'آخر حرف داخل العرض الكلي');
  // 3.704em لا 5.077: الأخير كان مجموع العروض قبل التوليف (كان init/medi/fina
  // تُمرَّر يدويًا فتُعطّل الـligatures). الرقم يثبّت أن التوليف يعمل.
  assert.ok(Math.abs(w - 3.704) < 0.01, `عرض «تشطيب» 3.704em لا ${w}`);
});

test('layout: لا تكرار ولا تراكب لأي حرف في جملة عربية', { skip: skipDeps }, () => {
  const out = py(`
import json, arabic_text as AT
bad = []
for s in ['مستويين · شارع محمود البدري', 'كلم طارق على واتساب', 'تشطيب فندقي فاخر']:
    items, width = AT.layout(s, '700')
    xs = [p for _, _, p, _ in items]
    if any(b <= a for a, b in zip(xs, xs[1:])):
        bad.append(s)
print(json.dumps({'bad': bad}))
`);
  assert.deepEqual(JSON.parse(out).bad, [], 'كل حروف كل جملة بمواضع تصاعدية');
});

test('layout: توليف «ست» يبقى ligature ولا يُفكّ', { skip: skipDeps }, () => {
  const out = py(`
import json, arabic_text as AT, uharfbuzz as hb
items, _ = AT.layout('مستويين', '700')
fnt, _ = AT._hb(AT.FONT_AR['700'])
print(json.dumps([fnt.glyph_to_string(g) for g, _, _, _ in items]))
`);
  const glyphs = JSON.parse(out);
  assert.ok(
    glyphs.includes('uniFC94'),
    `«ست» يجب أن تبقى ligature (uniFC94) — تمرير init/medi/fina يدويًا يفكّها. glyphs=${glyphs}`,
  );
  assert.equal(new Set(glyphs).size, glyphs.length, 'لا glyph مكرّر');
});

test('make-listing-video: كتلة العلامة العلوية محذوفة', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/audio/make-listing-video.py', 'utf8');
  assert.ok(!src.includes('سمسار طلبك'), 'لا نص علامة أعلى الفيديو');
  assert.ok(!src.includes('منذ 2014'), 'لا شعار أعلى الفيديو');
});
