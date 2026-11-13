import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../audit-address-book.mjs';

const card = (name, phones) => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\n${phones.map(p => 'TEL:' + p).join('\n')}\nEND:VCARD\n`;

test('exclusion takes priority and spreads over shared numbers, no PII in output', () => {
  const text = card('🌀 جهة اصطناعية', ['+201000000001'])
    + card('🔴 عميل اصطناعي', ['+201000000001', '+201000000002'])
    + card('اسم اصطناعي', ['+201000000002'])
    + card('🟢 آخر', ['+201000000003'])
    + card('🌀 دون رقم', []);
  const r = audit(text);
  assert.equal(r.cards, 5);
  assert.equal(r.excluded_marker_cards, 2);
  assert.equal(r.excluded_marker_without_number, 1);
  assert.equal(r.exclusion_closure_cards, 4);
  assert.equal(r.overlap_customer_exclusion_cards, 1);
  assert.equal(r.marked_customer_cards, 2);
  assert.doesNotMatch(JSON.stringify(r), /201000000001|اصطناعي/);
});
