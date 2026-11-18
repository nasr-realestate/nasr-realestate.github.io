/* أدوات صور مجموعات دفتر جهات الاتصال — انحدار.
 *
 * ثلاثة أعطاب حقيقية كشفها تشغيل الأداة على `last.vcf` (2,370 كارت,
 * 18 نوفمبر 2026). كل واحد منها كان يفسد الملف بصمت — لا خطأ ولا تحذير:
 *
 *  1. `ORG` يأتي **بعد** `PHOTO` في الكارت، والحلقة القديمة كانت تقرأ
 *     المجموعة قبله ⇒ group = None ⇒ حُذفت صور كل المجموعات.
 *  2. `ORG` نفسه مقسوم على سطرين بـ soft-break (`=` في نهاية السطر).
 *     قراءته سطرًا واحدًا تعطي «الدفتر الشامل — ذكى من» فلا تطابق شيئًا.
 *  3. `--default-no-photo` كان **يحذف** صورة أي مجموعة خارج الأربع. في هذا
 *     الدفتر = محو 175 صورة شخص حقيقي («الأسماء الطبيعية») و42 في «جهات
 *     أخرى». الصحيح أن تبقى الصورة كما هي.
 *
 * الاختبارات تركّب ملفات vCard اصطناعية في مجلد مؤقت — لا بيانات عملاء.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join('tools', 'contact-labels', 'build-vcf.py');
const LABELS = path.join('tools', 'contact-labels', 'small');
const skip = fs.existsSync(SCRIPT) ? false : `${SCRIPT} غير موجود`;
const skipDeps = skip || (fs.existsSync(path.join(LABELS, 'hares.jpg')) ? false : 'صور المجموعات ناقصة');

/** يرمّز نصًا عربيًا إلى QUOTED-PRINTABLE كما في الملف الأصلي. */
function qp(text) {
  return [...Buffer.from(text, 'utf8')]
    .map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

/**
 * يقسم سلسلة QP بسطر soft-break — يحاكي الملف الحقيقي.
 * ⚠️ القسمة على حدّ بايت سليم (`=XX` كامل)، وإلا انقسم حرف UTF-8 بين
 * السطرين فصار فكّ الترميز يُنتج حرفًا تالفًا ويختلف عن الملف الأصلي.
 */
function qpSplit(text, atBytes = 4) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const head = bytes.slice(0, atBytes).map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0'));
  const tail = bytes.slice(atBytes).map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0'));
  return [head.join('') + '=', tail.join('')];
}

const PHOTO = 'PHOTO;ENCODING=BASE64;JPEG:' + 'A'.repeat(2000);

/** كارت مجموعته في ORG **بعد** PHOTO (كترتيب الملف الحقيقي). */
function cardAfter({ name, group, photo = true }) {
  const [a, b] = qpSplit(`الدفتر الشامل — ${group}`);
  return [
    'BEGIN:VCARD',
    'VERSION:2.1',
    `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qp(name)}`,
    'TEL;CELL:+201000000001',
    ...(photo ? [PHOTO] : []),
    `ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${a}`,
    b,
    'END:VCARD',
  ].join('\n');
}

function run(cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-'));
  const src = path.join(dir, 'in.vcf');
  const out = path.join(dir, 'out.vcf');
  fs.writeFileSync(src, cards.join('\n') + '\n');
  execFileSync('python3', [SCRIPT, '--src', src, '--labels', LABELS,
    '--default-no-photo', '--out', out], { encoding: 'utf8' });
  const text = fs.readFileSync(out, 'utf8');
  const parsed = text.split('BEGIN:VCARD').slice(1).map((c) => ({
    hasPhoto: /^PHOTO/m.test(c),
    photoLen: (c.match(/^PHOTO[^:]*:([\s\S]*?)(?=\n(?![ ]))/m) || [, ''])[1]
      .replace(/\s+/g, '').length,
  }));
  fs.rmSync(dir, { recursive: true, force: true });
  return { text, parsed };
}

test('المجموعة تُقرأ ولو جاء ORG بعد PHOTO', { skip: skipDeps }, () => {
  const { parsed } = run([cardAfter({ name: 'اختبار', group: 'حارس' })]);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].hasPhoto, 'الصورة اختفت — لم تُقرأ المجموعة');
  // صورة المجموعة المصغّرة ≈ 5.8 ألف حرف base64 لا 2,000
  assert.ok(parsed[0].photoLen > 4000, `صورة المجموعة لم تُستبدل (${parsed[0].photoLen})`);
});

test('ORG المقسوم بـ soft-break يُدمج قبل فكّ الترميز', { skip: skipDeps }, () => {
  const { parsed } = run([cardAfter({ name: 'اختبار', group: 'ذكى منير' })]);
  assert.ok(parsed[0].hasPhoto);
  assert.ok(parsed[0].photoLen > 4000, 'المجموعة لم تُطابق بسبب `=` في نهاية السطر');
});

test('صورة من ليس في المجموعات الأربع تبقى كما هي — لا تُحذف ولا تُستبدل', { skip: skipDeps }, () => {
  const { parsed } = run([
    cardAfter({ name: 'شخص حقيقي', group: 'الأسماء الطبيعية' }),
    cardAfter({ name: 'جهة', group: 'جهات أخرى' }),
  ]);
  assert.equal(parsed.length, 2);
  for (const p of parsed) {
    assert.ok(p.hasPhoto, 'صورة الشخص مُحيت — هذا طمس لصور الناس');
    assert.equal(p.photoLen, 2000, 'الصورة الأصلية استُبدلت بصورة مجموعة');
  }
});

test('لا تُفقد بطاقة ولا يتغيّر اسم أو رقم', { skip: skipDeps }, () => {
  const input = [
    cardAfter({ name: 'أ', group: 'حارس' }),
    cardAfter({ name: 'ب', group: 'الأسماء الطبيعية' }),
    cardAfter({ name: 'ج', group: 'الدولاب', photo: false }),
  ];
  const { text } = run(input);
  assert.equal(text.split('BEGIN:VCARD').length - 1, 3, 'عدد البطاقات تغيّر');
  const t = text.replace(/=\r?\n/g, '');
  for (const n of ['أ', 'ب', 'ج']) {
    assert.ok(t.includes(qp(n)), `الاسم ${n} تغيّر أو فُقد`);
  }
  assert.equal((text.match(/TEL;CELL:\+201000000001/g) || []).length, 3);
});
