import test from 'node:test';
import assert from 'node:assert/strict';
import { SEGMENTS, segmentsOf, isInScope, isContactInScope } from '../crm/segments.mjs';

test('SEG-1 the five marks are the whole taxonomy', () => {
  assert.equal(SEGMENTS.length, 5);
  assert.deepEqual(SEGMENTS.map((s) => s.key), ['seeker', 'owner', 'rent', 'commercial', 'furnished']);
});

test('SEG-2 a mark anywhere in the label puts the man in scope', () => {
  assert.equal(segmentsOf('🟢عزت سلامه ش-د٣، المساحه ١٥٥م').key, 'owner');
  assert.equal(segmentsOf('✈️ هند تبحث عن شقه 4مليون').key, 'seeker');
  assert.equal(segmentsOf('🔴 سامح في حلمي مفروش 200 متر').key, 'furnished');
  assert.equal(segmentsOf('🔵محمد وائل عندى شقة اريد تأجيرها').key, 'rent');
  assert.equal(segmentsOf('🟠راندا محمد محلات شيراتون 1300 متر').key, 'commercial');
});

test('SEG-3 two marks keep both and rank by precedence', () => {
  const s = segmentsOf('🟢 🔴طارق حامد خضر التوني،الاستاد ١٢٠م');
  assert.deepEqual(s.codes, ['🟢', '🔴']);
  assert.equal(s.key, 'owner', 'the owner mark ranks above the furnished one');
});

test('SEG-4 a name without a mark is stored, not worked', () => {
  assert.equal(isInScope('محمد سمير،شقه 200 م'), false);
  assert.equal(isInScope('Alaa2'), false);
  assert.equal(segmentsOf('محمد سمير').inScope, false);
  assert.equal(segmentsOf('').inScope, false);
});

test('SEG-5 the plain airplane glyph counts as the airplane mark', () => {
  assert.equal(segmentsOf('✈ باحث عن شقة').key, 'seeker');
});

test('SEG-6 a contact is in scope if the name or any of its chats carries a mark', () => {
  assert.equal(isContactInScope('محمد سمير', ['🟢 محمد سمير،شقه 200 م']), true);
  assert.equal(isContactInScope('محمد سمير', ['محادثة بلا علامة']), false);
  assert.equal(isContactInScope('', []), false);
});
