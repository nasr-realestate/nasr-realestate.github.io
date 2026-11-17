// Tests: الفرق الأسبوعي في دفتر الاتصال — من دخل، من خرج، من اكتمل.
//
// الخطر الذي يحرسه هذا الملف: تقرير يقول «كلهم جدد» في كل أسبوع، أو تقرير
// يقول «خرج» لشخص لسه موجود. الحالتان تجعلان الرقم بلا معنى وتُخفيان الحركة
// الحقيقية في الدفتر. الاختبارات هنا تبني أسابيع صناعية بحروفها.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  phoneFingerprint,
  weekKey,
  peopleFromVcf,
  diffWeeks,
  stateFromPeople,
} from '../crm/roster-weekly.mjs';

const card = (fn, tel) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${fn}\r\n${tel ? `TEL;TYPE=CELL:${tel}\r\n` : ''}END:VCARD\r\n`;
const vcf = (...cards) => cards.join('\r\n');

test('بصمة الرقم لا تحمل الرقم نفسه', () => {
  const fp = phoneFingerprint('201022171667');
  assert.equal(fp.length, 32);
  assert.doesNotMatch(fp, /201022171667/);
  assert.equal(fp, phoneFingerprint('201022171667'), 'ثابتة لنفس الرقم');
  assert.notEqual(fp, phoneFingerprint('201022171668'));
});

test('أسبوع ISO يبدأ الاثنين ويُعيد نفس المفتاح لكل أيامه', () => {
  assert.equal(weekKey('2026-11-16'), '2026-11-16'); // الاثنين
  assert.equal(weekKey('2026-11-17'), '2026-11-16'); // الثلاثاء
  assert.equal(weekKey('2026-11-22'), '2026-11-16'); // الأحد
  assert.equal(weekKey('2026-11-23'), '2026-11-23'); // الاثنين التالي
});

test('أول أسبوع: كل من له رقم «دخل»، ومن بلا رقم لا يُحسب عميلًا', () => {
  const people = peopleFromVcf({
    text: vcf(
      card('أحمد 🟢', '+201022171667'),
      card('سامي', '+201022171668'),
      card('بلا رقم 🟠'),
    ),
  });
  assert.equal(people.length, 2, 'صاحب البطاقة بلا رقم ليس عميلًا');
  const state = stateFromPeople(people, { week: '2026-11-16', generatedAt: 'now' });
  const { counts } = diffWeeks(people, null, { week: '2026-11-16' });
  assert.equal(counts.entered, 2);
  assert.equal(counts.exited, 0);
  assert.equal(Object.keys(state.persons).length, 2);
});

test('أسبوع ثانٍ: يميّز الداخل من الخارج من الثابت', () => {
  const week1 = peopleFromVcf({
    text: vcf(
      card('أحمد 🟢', '+201022171667'),
      card('سامي 🔴', '+201022171668'),
    ),
  });
  const prev = stateFromPeople(week1, { week: '2026-11-09', generatedAt: 'now' });

  const week2 = peopleFromVcf({
    text: vcf(
      card('أحمد 🟢', '+201022171667'), // ثابت
      card('جديد 🟠', '+201022171699'), // دخل
    ),
  });
  const { counts, enteredBySegment, exitedBySegment } = diffWeeks(week2, prev, { week: '2026-11-16' });
  assert.equal(counts.entered, 1);
  assert.equal(counts.exited, 1, 'سامي غاب من تصدير هذا الأسبوع');
  assert.equal(counts.stayed, 1);
  assert.deepEqual(enteredBySegment, { commercial: 1 });
  assert.deepEqual(exitedBySegment, { furnished: 1 });
});

test('نفس الرقم باسمين مختلفين = شخص واحد، فلا يُعدّ داخلًا مرتين', () => {
  const week1 = peopleFromVcf({ text: vcf(card('أحمد يوسف 🟢', '+201022171667')) });
  const prev = stateFromPeople(week1, { week: '2026-11-09', generatedAt: 'now' });
  const week2 = peopleFromVcf({
    text: vcf(
      card('أحمد يوسف 🟢', '+201022171667'),
      card('Ahmed Youssef', '+201022171667'), // نفس الرقم
    ),
  });
  assert.equal(week2.length, 1);
  const { counts } = diffWeeks(week2, prev, { week: '2026-11-16' });
  assert.equal(counts.entered, 0);
  assert.equal(counts.stayed, 1);
});

test('من خرج ورجع يُعرف أنه عائد — يحتفظ بأول أسبوع رؤية', () => {
  const week1 = peopleFromVcf({ text: vcf(card('أحمد 🟢', '+201022171667')) });
  const prev = stateFromPeople(week1, { week: '2026-11-02', generatedAt: 'now' });
  const gone = peopleFromVcf({ text: vcf(card('سامي 🔴', '+201022171668')) });
  const afterGone = diffWeeks(gone, prev, { week: '2026-11-09' });
  const back = peopleFromVcf({ text: vcf(card('أحمد 🟢', '+201022171667')) });
  const afterBack = diffWeeks(back, afterGone.state, { week: '2026-11-16' });

  const fp = phoneFingerprint('201022171667');
  assert.equal(afterBack.counts.returned, 1, "رجوع بعد غياب يُعدّ عائدًا، لا جديدًا");
  assert.equal(afterBack.counts.entered, 0);
  assert.equal(afterBack.state.persons[fp].firstSeenWeek, '2026-11-02', 'لكن تاريخ أول رؤية لا يتغيّر');
});

test('الانتقال بين العلامات لا يُحسب دخولًا ولا خروجًا', () => {
  const week1 = peopleFromVcf({ text: vcf(card('أحمد 🟢', '+201022171667')) });
  const prev = stateFromPeople(week1, { week: '2026-11-09', generatedAt: 'now' });
  const week2 = peopleFromVcf({ text: vcf(card('أحمد 🔵', '+201022171667')) });
  const { counts } = diffWeeks(week2, prev, { week: '2026-11-16' });
  assert.equal(counts.entered, 0);
  assert.equal(counts.exited, 0);
  assert.equal(counts.moved, 1);
});

test('اكتساب العلامة وفقدها يُقاسان منفصلين', () => {
  const week1 = peopleFromVcf({ text: vcf(card('أحمد', '+201022171667'), card('سامي 🟢', '+201022171668')) });
  const prev = stateFromPeople(week1, { week: '2026-11-09', generatedAt: 'now' });
  const week2 = peopleFromVcf({ text: vcf(card('أحمد 🟠', '+201022171667'), card('سامي', '+201022171668')) });
  const { counts } = diffWeeks(week2, prev, { week: '2026-11-16' });
  assert.equal(counts.marked, 1, 'أحمد اكتسب علامة');
  assert.equal(counts.unmarked, 1, 'سامي فقد علامته');
});

test('إعادة تشغيل نفس التصدير لا تُنتج حركة كاذبة', () => {
  const people = peopleFromVcf({ text: vcf(card('أحمد 🟢', '+201022171667'), card('سامي 🔴', '+201022171668')) });
  const prev = stateFromPeople(people, { week: '2026-11-09', generatedAt: 'now' });
  const { counts } = diffWeeks(people, prev, { week: '2026-11-16' });
  assert.deepEqual(counts, { entered: 0, returned: 0, exited: 0, marked: 0, unmarked: 0, moved: 0, stayed: 2 });
});
