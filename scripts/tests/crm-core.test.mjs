// Tests: نواة «دفتر العملاء» (assets/js/crm-core.js) — 2026-10-27
//
// كل البيانات هنا اصطناعية (أسماء وأرقام وهمية). لا يجوز إضافة بيانات عملاء حقيقية
// لهذا الملف أو لأي ملف في المستودع: المستودع عام على GitHub.
//
// node --test scripts/tests/crm-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// النواة سكربت متصفح عادي — نشغّلها في سياق معزول كما يشغّلها المتصفح.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/crm-core.js'), 'utf8'), ctx);
const C = ctx.SimsarCRM;
const plain = (x) => JSON.parse(JSON.stringify(x));
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const DAY = 86400000;

test('normalizePhone: كل صيغ الموبايل المصري تتوحّد إلى 20…، والدولي يتعرّف، والغلط يتكشف', () => {
  const eg = '201001234567';
  for (const raw of ['01001234567', '+20 100 123 4567', '0020 100-123-4567', '+020 1001234567', '+20 01001234567',
    '1001234567', '٠١٠٠١٢٣٤٥٦٧', '(+20) 100 123 4567']) {
    assert.equal(C.normalizePhone(raw).id, eg, raw);
    assert.equal(C.normalizePhone(raw).kind, 'eg-mobile', raw);
  }
  assert.equal(C.normalizePhone('0222345678').id, '20222345678');
  assert.equal(C.normalizePhone('0222345678').kind, 'eg-landline');
  const sa = C.normalizePhone('+966 50 123 4567');
  assert.equal(sa.kind, 'intl');
  assert.equal(sa.country, 'السعودية');
  assert.equal(C.normalizePhone('+249 91 234 5678').country, 'السودان');
  assert.equal(C.normalizePhone('1234').kind, 'short');
  assert.equal(C.normalizePhone('0100').id, null);
  assert.equal(C.normalizePhone('abc').kind, 'invalid');
  assert.equal(C.displayPhone('201001234567'), '0100 123 4567');
  assert.equal(C.displayPhone('966501234567'), '+966501234567');
});

test('parseContactDirectory: الاسم بلا مسافة بادئة، التفاصيل بمسافة، «No contact details» والتسميات', () => {
  const txt = [
    '                               Contact Directory', '',
    'حاج سمير مالك شقة 180م مكرم', '', '   Phone (Mobile): +20 100 000 0001', '   حارس', '',
    'مطلوب مقر إداري', '', '   No contact details provided.', '',
    '+20 111 000 0002', '', '   No contact details provided.', '',
    'Test Person', '', '   Email (Home): test@example.com', '   Address (Home): Egypt', '   Phone: 0122 000 0003', '',
  ].join('\r\n');
  const out = plain(C.parseContactDirectory(txt));
  assert.equal(out.length, 4);
  assert.deepEqual(out[0].phones, ['+20 100 000 0001']);
  assert.deepEqual(out[0].labels, ['حارس']);
  assert.equal(out[1].noDetails, true);
  assert.deepEqual(out[1].phones, []);
  assert.equal(out[2].name, '', 'اسم هو رقم فقط ⇒ يتحوّل لرقم');
  assert.deepEqual(out[2].phones, ['+20 111 000 0002']);
  assert.deepEqual(out[3].emails, ['test@example.com']);
  assert.equal(out[3].address, '', 'Address = Egypt لا قيمة له');
  assert.equal(C.detectFormat(txt, 'contacts.txt'), 'txt');
});

test('parseVcf: vCard 2.1 عربي QUOTED-PRINTABLE (أندرويد) + طيّ أسطر + itemN + CATEGORIES', () => {
  const qp = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  const fn = qp('مدام هدى طالبة إيجار الحي العاشر');
  const vcf = [
    'BEGIN:VCARD', 'VERSION:2.1',
    `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${fn.slice(0, 60)}=`, fn.slice(60),
    'TEL;CELL:010-0000-0004', 'TEL;CELL;PREF:+201000000004', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Kamel;Karim;;;', 'item1.TEL;type=pref:+20 122 000 0005', 'item1.X-ABLabel:mobile',
    'NOTE:عايز محل\\, مكرم', 'CATEGORIES:myContacts,عملاء', 'ORG:شركة اختبار', '  للتسويق', 'END:VCARD',
  ].join('\r\n');
  const out = plain(C.parseVcf(vcf));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'مدام هدى طالبة إيجار الحي العاشر');
  assert.deepEqual(out[0].phones, ['010-0000-0004', '+201000000004']);
  assert.equal(out[1].name, 'Karim Kamel', 'بلا FN ⇒ من N');
  assert.deepEqual(out[1].phones, ['+20 122 000 0005']);
  assert.equal(out[1].notes, 'عايز محل, مكرم');
  assert.deepEqual(out[1].labels, ['عملاء', 'شركة اختبار للتسويق'], 'بترتيب الملف');
  assert.equal(C.detectFormat(vcf, 'x.vcf'), 'vcf');
});

test('parseCsv: Google Contacts (أعمدة Phone N - Value، «:::»، حقل بسطور وفواصل)', () => {
  const csv = '\uFEFFFirst Name,Middle Name,Last Name,Notes,Labels,Phone 1 - Label,Phone 1 - Value,Phone 2 - Value\r\n' +
    'أحمد,,مشتري,"عايز شقة، الحي السابع\nميزانية 3 مليون","* myContacts ::: مشترين",Mobile,+20 100 000 0006 ::: 0111 000 0007,\r\n' +
    ',,,,,Mobile,,\r\n' +
    'سمسار اختبار,,,,,Work,0122 000 0008,"=HYPERLINK(""x"")"\r\n';
  const out = plain(C.parseCsv(csv));
  assert.equal(out.length, 2, 'صف فاضي يتشال');
  assert.equal(out[0].name, 'أحمد مشتري');
  assert.deepEqual(out[0].phones, ['+20 100 000 0006', '0111 000 0007']);
  assert.match(out[0].notes, /الحي السابع\nميزانية 3 مليون/);
  assert.deepEqual(out[0].labels, ['مشترين']);
  assert.equal(C.detectFormat(csv, 'contacts.csv'), 'csv');
});

test('سجل المكالمات: آخر مكالمة لكل جهة + أرقام متكررة مش متسجلة', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><calls count="4">
    <call number="+201000000009" duration="40" date="${NOW - 2 * DAY}" type="1" contact_name="ع" />
    <call number="01000000009" duration="0" date="${NOW - DAY}" type="3" contact_name="ع" />
    <call number="01111000010" duration="12" date="${NOW - 3 * DAY}" type="2" contact_name="(Unknown)" />
    <call number="01111000010" duration="30" date="${NOW - 5 * DAY}" type="1" contact_name="(Unknown)" />
  </calls>`;
  assert.equal(C.detectFormat(xml, 'calls.xml'), 'calls');
  const calls = C.parseCallLogXml(xml);
  assert.equal(calls.length, 4);
  const db = C.emptyDb();
  C.mergeImport(db, [{ name: 'ع اختبار', phones: ['01000000009'] }], { now: NOW });
  const res = C.applyCallLog(db, calls, { now: NOW });
  assert.equal(res.matched, 1);
  const c = Object.values(db.contacts)[0];
  assert.equal(c.lastCallAt, NOW - DAY);
  assert.equal(c.calls, 2);
  assert.equal(res.unsaved.length, 1);
  assert.equal(res.unsaved[0].phone, '201111000010');
  assert.equal(res.unsaved[0].name, '', '(Unknown) مش اسم');
});

test('classify: الدور والمعاملة والنوع والمنطقة والمساحة والسعر من طريقة تسجيل السماسرة', () => {
  const k = (s) => plain(C.classify(s));
  let r = k('حاج سمير مالك شقة 180م مكرم');
  assert.equal(r.role, 'owner'); assert.deepEqual(r.types, ['apartment']); assert.deepEqual(r.zones, ['مكرم عبيد']); assert.equal(r.size, 180);
  r = k('مدام هدى طالبة إيجار الحي العاشر لحد 15 ألف');
  assert.equal(r.role, 'seeker'); assert.equal(r.deal, 'rent'); assert.deepEqual(r.zones, ['الحي العاشر']); assert.equal(r.price, 15000);
  r = k('مشتري شقة جرين هيلز 3 مليون ونص');
  assert.equal(r.deal, 'sale'); assert.deepEqual(r.zones, ['جرين هيلز']); assert.equal(r.price, 3500000);
  assert.equal(k('أبو علي سمسار مكرم').role, 'broker');
  assert.equal(k('عم سيد بواب العمارة').role, 'doorman');
  assert.equal(k('حسن النقاش').role, 'trade');
  assert.equal(k('محل 60 متر للبيع في المنطقة الأولى').zones[0], 'المنطقة الأولى');
  assert.equal(k('ام هايدي شقة سيتي ستارز ومفروشة').furnished, true, 'مفروشة بعد «و»');
  assert.deepEqual(k('عايز شقة الاستثمار').zones, ['رابعة الاستثماري']);
  assert.deepEqual(k('شراء في الجمل').zones, ['المنطقة السادسة']);
  assert.deepEqual(k('شقة السابع').zones, ['الحي السابع'], '«السابع» وحدها = الحي');
  assert.deepEqual(k('شقة الدور السابع').zones, [], 'لكن «الدور السابع» دور مش حي');
  assert.equal(k('ربيع محمد').deal, '', '«ربيع» مش «بيع»');
  assert.equal(k('أحمد سمسار طلبك').role, 'broker');
  assert.notEqual(k('علا تبع سمسار طلبك').role, 'seeker', '«طلبك» مش «طلب»');
  assert.deepEqual(k('منة البنك الأهلي طلب مقر').zones, [], 'البنك الأهلي مش النادي الأهلي');
  assert.equal(k('أرض 2 الف متر').size, 2000);
  assert.equal(k('أرض 2 الف متر').price, null, '«ألف متر» مساحة مش سعر');
  assert.equal(k('أحمد').role, 'other');
  assert.equal(k('شقة 150م').role, 'unit');
  assert.deepEqual(k('شقة التجمع للبيع').zones, ['التجمع']);
  assert.equal(C.isNasrZone('التجمع'), false);
  assert.equal(C.isNasrZone('الحي العاشر'), true);
});

test('greetingName: اسم التحية بس — من غير الوصف ولا الأرقام ولا الإيموجي', () => {
  assert.equal(C.greetingName('حاج سمير مالك شقة 180م مكرم'), 'حاج سمير');
  assert.equal(C.greetingName('🌀 مدام هدى طالبة إيجار'), 'مدام هدى');
  assert.equal(C.greetingName('Karim مشتري شقة'), 'Karim');
  assert.equal(C.greetingName('مطلوب شقة التجمع'), '');
  assert.equal(C.greetingName('ابو شقة السابع'), '', 'لقب لوحده مش اسم');
  assert.equal(C.greetingName('أ/منة، البنك، طلب مقر'), 'أ منة');
  assert.equal(C.greetingName('فريد عنده دوبلكس'), 'فريد');
});

test('نصوص واتساب: خدمة ومتابعة بالدور، بتحية الاسم، وروابط wa.me/tel صحيحة', () => {
  const owner = { name: 'حاج سمير مالك شقة 180م مكرم', role: 'owner', types: ['apartment'], zones: ['مكرم عبيد'], size: 180, deal: 'sale' };
  const m = C.messageFor(owner);
  assert.match(m, /^أهلًا حاج سمير، معاك طارق طنطاوي من «سمسار طلبك»\./);
  assert.match(m, /شقة 180م في مكرم عبيد للبيع — لسه متاحة؟/);
  const seeker = { name: 'مدام هدى', role: 'seeker', zones: ['الحي العاشر'], deal: 'rent', price: 15000, types: [] };
  assert.match(C.messageFor(seeker), /لسه بتدوّر؟/);
  assert.match(C.messageFor(seeker), /تحب أبعتلك المتاح المناسب أول بأول/, 'سؤال الموافقة على العروض');
  assert.equal(C.messageFor({ name: 'x', role: 'other' }), '', 'غير المصنّف: بلا رسالة جاهزة');
  assert.equal(C.describe(seeker), 'في الحي العاشر للإيجار بميزانية 15 ألف');
  const url = C.waLink('201000000001', 'أهلًا & سلام');
  assert.equal(url, 'https://wa.me/201000000001?text=' + encodeURIComponent('أهلًا & سلام'));
  assert.equal(C.telLink('201000000001'), 'tel:+201000000001');
  assert.equal(C.waLink('', 'x'), '');
  const offer = C.offerMessage(seeker, { t: 'شقة 160م للإيجار', p: '14,000 ج.م', u: '/properties/x/' }, 'https://nasr-realestate.github.io');
  assert.match(offer, /عندي شقة 160م للإيجار بسعر 14,000 ج\.م/);
  assert.match(offer, /https:\/\/nasr-realestate\.github\.io\/properties\/x\/$/);
});

test('mergeImport: يدمج بالرقم، ويحافظ على الحالة والتاريخ والتعديل اليدوي في إعادة الاستيراد', () => {
  const db = C.emptyDb();
  let st = C.mergeImport(db, [
    { name: 'حاج سمير مالك شقة 180م مكرم', phones: ['01000000001'] },
    { name: 'حاج سمير (نسخة)', phones: ['+20 100 000 0001'] },          // نفس الرقم ⇒ نفس الجهة
    { name: 'مطلوب مقر إداري مكرم', phones: [] },                       // أرشيف بلا رقم
    { name: 'أحمد', phones: [] },
    { name: 'أحمد', phones: ['01111111112'] },                         // اسم قصير شائع ⇒ لا دمج بالاسم
    { name: 'رقم غلط', phones: ['01001234'] },
  ], { now: NOW, file: 'a.txt' });
  assert.equal(st.added, 5);
  assert.equal(st.updated, 1);
  assert.equal(st.noPhone, 3);
  assert.equal(st.badPhones, 1);
  const samir = Object.values(db.contacts).find((c) => c.phones.includes('201000000001'));
  assert.equal(samir.status, 'new');
  assert.equal(samir.role, 'owner');
  // المستخدم أكّد وعدّل الدور يدويًا
  C.recordOutcome(samir, 'active', NOW);
  samir.role = 'broker'; samir.manual.role = true;
  st = C.mergeImport(db, [
    { name: 'حاج سمير مالك شقة 180م مكرم', phones: ['01000000001'], labels: ['عمارة 5'] },
    { name: 'مطلوب مقر إداري مكرم', phones: ['01222222223'] },          // نفس الاسم الوصفي ⇒ ياخد الرقم
  ], { now: NOW + DAY, file: 'b.vcf' });
  assert.equal(st.added, 0);
  assert.equal(st.updated, 2);
  assert.equal(samir.status, 'active', 'الحالة محفوظة');
  assert.equal(samir.role, 'broker', 'التعديل اليدوي محفوظ');
  assert.equal(samir.history.filter((h) => h.action === 'active').length, 1);
  assert.equal(samir.name, 'حاج سمير مالك شقة 180م مكرم', 'الاسم الأوصف يفضل للعرض');
  assert.deepEqual(plain(samir.labels), ['حاج سمير (نسخة)', 'عمارة 5'], 'الاسم التاني يتحفظ كتسمية');
  const office = Object.values(db.contacts).find((c) => c.name === 'مطلوب مقر إداري مكرم');
  assert.deepEqual(plain(office.phones), ['201222222223']);
  assert.equal(Object.values(db.contacts).filter((c) => c.name === 'أحمد').length, 2);
  assert.equal(db.meta.imports.length, 2);
});

test('buildQueue: الترتيب بالأهمية، والاستبعاد (بلا رقم، شخصي، مؤجَّل، اتأكد قريب)', () => {
  const db = C.emptyDb();
  C.mergeImport(db, [
    { name: 'سمسار تجربة', phones: ['01000000011'] },
    { name: 'مالك شقة الحي العاشر', phones: ['01000000012'] },
    { name: 'عايز شقة إيجار الحي العاشر', phones: ['01000000013'] },
    { name: 'عم سيد بواب', phones: ['01000000014'] },
    { name: 'قريب العيلة', phones: ['01000000015'] },
    { name: 'مالك محل مكرم', phones: [] },
    { name: 'مالك فيلا التجمع', phones: ['01000000016'] },
  ], { now: NOW });
  const all = Object.values(db.contacts);
  const by = (n) => all.find((c) => c.name === n);
  by('مالك فيلا التجمع').listing = '/properties/v/';
  const seeker = by('عايز شقة إيجار الحي العاشر');
  let q = C.buildQueue(all, { now: NOW, matchCounts: { [seeker.id]: 1 } });
  assert.deepEqual(q.map((x) => x.group), ['listing', 'owner', 'seeker-match', 'doorman', 'broker']);
  assert.ok(!q.some((x) => x.c.name === 'قريب العيلة'), 'غير المصنّف خارج الطابور');
  assert.ok(!q.some((x) => x.c.name === 'مالك محل مكرم'), 'بلا رقم خارج الطابور');
  C.recordOutcome(by('مالك شقة الحي العاشر'), 'active', NOW);
  C.recordOutcome(by('عم سيد بواب'), 'noanswer', NOW);
  C.recordOutcome(by('سمسار تجربة'), 'stop', NOW);
  q = C.buildQueue(all, { now: NOW + DAY });
  assert.deepEqual(q.map((x) => x.c.name), ['مالك فيلا التجمع', 'عايز شقة إيجار الحي العاشر']);
  q = C.buildQueue(all, { now: NOW + 4 * DAY });
  assert.ok(q.some((x) => x.c.name === 'عم سيد بواب'), 'المتابعة ترجع في ميعادها');
  q = C.buildQueue(all, { now: NOW + 31 * DAY });
  assert.ok(q.some((x) => x.c.name === 'مالك شقة الحي العاشر'), 'اللي اتأكد يرجع بعد 30 يوم');
  assert.ok(!q.some((x) => x.c.name === 'سمسار تجربة'), '«مش عايز تواصل» ما يرجعش أبدًا');
});

test('recordOutcome / setConsent: المحاولات والمواعيد والموافقة', () => {
  const c = { name: 'x', status: 'new', history: [] };
  C.recordOutcome(c, 'noanswer', NOW);
  assert.equal(c.status, 'followup'); assert.equal(c.nextAt, NOW + 3 * DAY); assert.equal(c.attempts, 1);
  C.recordOutcome(c, 'noanswer', NOW); C.recordOutcome(c, 'noanswer', NOW);
  assert.equal(c.nextAt, NOW + 14 * DAY, 'بعد 3 محاولات: أسبوعين');
  C.recordOutcome(c, 'active', NOW);
  assert.equal(c.confirmedAt, NOW); assert.equal(c.attempts, 0); assert.equal(c.nextAt, 0);
  C.setConsent(c, 'yes', NOW);
  assert.equal(c.consent, 'yes'); assert.equal(c.consentAt, NOW);
  C.recordOutcome(c, 'stop', NOW);
  assert.equal(c.consent, 'no', '«مش عايز تواصل» يلغي الموافقة');
  assert.deepEqual(c.history.map((h) => h.action), ['noanswer', 'noanswer', 'noanswer', 'active', 'consent-yes', 'stop']);
  assert.throws(() => C.recordOutcome(c, 'nope', NOW));
});

const ROWS = [
  { u: '/properties/a/', t: 'شقة 160م للإيجار بالحي العاشر', l: 'الحي العاشر — مدينة نصر', d: 'rent', y: 'apartment', pn: 14000, an: 160, o: 0 },
  { u: '/properties/b/', t: 'شقة 190م - أبراج جرين هيلز', l: 'مدينة نصر', d: 'sale', y: 'apartment', pn: 4000000, an: 190, o: 1 },
  { u: '/properties/c/', t: 'شقة 200م مفروشة للإيجار - حي السفارات', l: 'حي السفارات', d: 'rent', y: 'apartment', pn: 30000, an: 200, o: 2 },
  { u: '/properties/d/', t: 'وحدة إدارية / عيادة 41م للإيجار', l: 'مكرم عبيد', d: 'rent', y: 'office', pn: 12000, an: 41, o: 3 },
  { u: '/properties/e/', t: 'شقة 250م للبيع بالحي العاشر', l: 'الحي العاشر', d: 'sale', y: 'apartment', pn: 9000000, an: 250, o: 4 },
];

test('المطابقة مع إعلانات الموقع: صارمة ومحددة', () => {
  const seeker = (s) => ({ ...plain(C.classify(s)), role: 'seeker', name: s, id: s, status: 'new', phones: ['201000000020'] });
  const t = (s) => C.matchListings(seeker(s), ROWS, 3).map((m) => m.row.u);
  assert.deepEqual(t('عايز شقة إيجار الحي العاشر لحد 15 ألف'), ['/properties/a/']);
  assert.deepEqual(t('مشتري شقة جرين هيلز'), ['/properties/b/']);
  assert.deepEqual(t('مشتري شقة جرين هيلز 2 مليون'), [], 'فوق الميزانية بأكتر من 15%');
  assert.deepEqual(t('طلب مفروش'), ['/properties/c/'], 'مفروش شرط');
  assert.deepEqual(t('عايزة عيادة مكرم'), ['/properties/d/'], 'العيادة تطابق وحدة إدارية مكتوب فيها عيادة');
  assert.deepEqual(t('عايز شقة للشراء'), [], 'عام جدًا ⇒ بلا مطابقة');
  assert.deepEqual(t('عايز شقة التجمع'), [], 'منطقة برا مدينة نصر');
  assert.deepEqual(t('عايز شقة الحي العاشر 3 مليون'), [], 'ميزانية بيع ⇒ لا إيجار، والبيع فوقها');
  assert.equal(C.matchListings({ role: 'owner', zones: ['الحي العاشر'], types: ['apartment'] }, ROWS).length, 0, 'المطابقة للطالبين بس');
  const people = [seeker('عايز شقة إيجار الحي العاشر'), { ...seeker('عايزة شقة إيجار الحي العاشر مفروش'), status: 'closed' },
    { ...seeker('طالب شقة إيجار في الحي العاشر'), consent: 'yes', id: 'yes' }, { ...seeker('شقة إيجار الحي العاشر'), phones: [] }];
  const ms = C.matchSeekers(ROWS[0], people, 10);
  assert.deepEqual(ms.map((x) => x.c.id), ['yes', 'عايز شقة إيجار الحي العاشر'], 'الموافق الأول، والمغلق/بلا رقم برا');
});

test('تقرير تأكيد الإعلانات: متاح / اتباع / مستني / مش مربوط', () => {
  const people = [
    { name: 'م1', listing: '/properties/a/', status: 'active', confirmedAt: NOW },
    { name: 'م2', listing: '/properties/b/', status: 'closed', confirmedAt: NOW },
    { name: 'م3', listing: '/properties/c/', status: 'new' },
  ];
  const r = C.listingReport(ROWS, people, NOW);
  assert.match(r, /✅ متاح: شقة 160م للإيجار بالحي العاشر \(2026-10-27\) \/properties\/a\//);
  assert.match(r, /❌ اتباع\/اتأجر: شقة 190م - أبراج جرين هيلز/);
  assert.match(r, /لسه مستني رد المالك: 1/);
  assert.match(r, /مش مربوطة بمالك في الدفتر: 2/);
});

test('parseQuick: رقم ودور ومعاملة ومنطقة وميزانية من رسالة واتساب', () => {
  const p = plain(C.parseQuick('أستاذ كريم 0100 000 0021 عايز شقة إيجار في الحي العاشر لحد 15 ألف مفروشة'));
  assert.deepEqual(p.phones, ['201000000021']);
  assert.equal(p.role, 'seeker'); assert.equal(p.deal, 'rent'); assert.deepEqual(p.types, ['apartment']);
  assert.deepEqual(p.zones, ['الحي العاشر']); assert.equal(p.price, 15000); assert.equal(p.furnished, true);
  assert.equal(C.parseQuick('عندي محل 60 متر للبيع في مكرم').role, 'owner');
  assert.deepEqual(plain(C.findPhones('لحد 15000 010 0000 0024 أو +20 111 000 0025')), ['201000000024', '201110000025']);
  assert.deepEqual(plain(C.findPhones('السعر 3500000 والمساحة 180')), [], 'سعر ومساحة مش أرقام تليفون');
});

test('نسخة احتياطية: استرجاع كامل، ورفض الملف الغلط، وCSV آمن من حقن الصيغ', () => {
  const db = C.emptyDb();
  C.mergeImport(db, [{ name: '=cmd|"/c calc"!A1 مالك', phones: ['01000000022'] }, { name: 'سطر، "فيه" فاصلة', phones: ['01000000023'] }], { now: NOW });
  const back = C.restore(C.backup(db, NOW));
  assert.deepEqual(Object.keys(back.contacts).sort(), Object.keys(db.contacts).sort());
  assert.throws(() => C.restore('{"hello":1}'));
  assert.throws(() => C.restore('not json'));
  const csv = C.toCsv(Object.values(db.contacts));
  assert.ok(csv.startsWith('\uFEFFالاسم,'), 'BOM عشان Excel يقرا العربي');
  assert.match(csv, /'=cmd/, 'خلية تبدأ بـ= تتحوّل لنص');
  assert.match(csv, /"سطر، ""فيه"" فاصلة"/);
  assert.match(csv, /0100 000 0022/);
});
