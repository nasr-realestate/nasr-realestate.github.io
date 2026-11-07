import test from 'node:test';
import assert from 'node:assert/strict';
import { SEGMENTS, segmentsOf, isInScope, isContactInScope, auditDirectory } from '../crm/segments.mjs';

test('SEG-1 the five marks are the whole taxonomy, named as he named them', () => {
  assert.equal(SEGMENTS.length, 5);
  assert.deepEqual(SEGMENTS.map((s) => s.key), ['sale', 'furnished', 'rent', 'commercial', 'transient']);
  assert.equal(SEGMENTS.find((s) => s.key === 'sale').label, 'تمليك');
  assert.equal(SEGMENTS.find((s) => s.key === 'furnished').label, 'مفروش');
  assert.equal(SEGMENTS.find((s) => s.key === 'transient').label, 'عميل عابر');
});

test('SEG-2 a mark anywhere in the label puts the man in scope', () => {
  assert.equal(segmentsOf('🟢عزت سلامه ش-د٣، المساحه ١٥٥م').key, 'sale');
  assert.equal(segmentsOf('✈️ هند تبحث عن شقه 4مليون').key, 'transient');
  assert.equal(segmentsOf('🔴 سامح في حلمي مفروش 200 متر').key, 'furnished');
  assert.equal(segmentsOf('🔵محمد وائل عندى شقة اريد تأجيرها').key, 'rent');
  assert.equal(segmentsOf('🟠راندا محمد محلات شيراتون 1300 متر').key, 'commercial');
});

test('SEG-3 two marks keep both and rank by precedence', () => {
  const s = segmentsOf('🟢 🔴طارق حامد خضر التوني،الاستاد ١٢٠م');
  assert.deepEqual(s.codes, ['🟢', '🔴']);
  assert.equal(s.key, 'sale', 'the sale mark ranks above the furnished one');
});

test('SEG-4 a name without a mark is stored, not worked', () => {
  assert.equal(isInScope('محمد سمير،شقه 200 م'), false);
  assert.equal(isInScope('Alaa2'), false);
  assert.equal(segmentsOf('محمد سمير').inScope, false);
  assert.equal(segmentsOf('').inScope, false);
});

test('SEG-5 the plain airplane glyph counts as the airplane mark', () => {
  assert.equal(segmentsOf('✈ باحث عن شقة').key, 'transient');
});

test('SEG-5b the role travels with the mark', () => {
  assert.equal(segmentsOf('✈️ باحث').role, 'transient');
  assert.equal(segmentsOf('🟢 مالك').role, 'supply');
  assert.equal(segmentsOf('محمد').role, null);
});

test('SEG-6 a contact is in scope if the name or any of its chats carries a mark', () => {
  assert.equal(isContactInScope('محمد سمير', ['🟢 محمد سمير،شقه 200 م']), true);
  assert.equal(isContactInScope('محمد سمير', ['محادثة بلا علامة']), false);
  assert.equal(isContactInScope('', []), false);
});

test('SEG-7 the two promises are measured: a number and a mark on every card', () => {
  const audit = auditDirectory([
    { fn: '🟢 عزت سلامه', phones: [{ e164: '201000000001' }] },
    { fn: '🔴 سامح', phones: [{ e164: '201000000002' }] },
    { fn: '✈️ عابر', phones: [{ e164: '201000000003' }] },
    { fn: 'بلا علامة', phones: [{ e164: '201000000004' }] },
    { fn: '🟢 بلا رقم', phones: [] },
  ]);
  assert.equal(audit.contacts, 5);
  assert.equal(audit.with_number, 4);
  assert.equal(audit.marked, 4);
  assert.deepEqual(audit.without_mark, ['بلا علامة']);
  assert.deepEqual(audit.without_number, ['🟢 بلا رقم']);
  assert.equal(audit.clean, false);
  assert.equal(auditDirectory([{ fn: '🟢 عزت', phones: [{ e164: '201000000001' }] }]).clean, true);
  assert.equal(auditDirectory([]).clean, true);
});
