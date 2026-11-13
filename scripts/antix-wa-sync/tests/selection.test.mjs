import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../selection.mjs';

const card = (fn, phones) => `BEGIN:VCARD\nVERSION:3.0\nFN:${fn}\n${phones.map(p => 'TEL:' + p).join('\n')}\nEND:VCARD\n`;
test('excluded numbers and transitive aliases override marked clients', () => {
  const i = buildIndex(card('🌀 مستبعد', ['+201000000001'])
    + card('🟢 عميل اصطناعي', ['+201000000001', '+201000000002'])
    + card('اسم آخر', ['+201000000002'])
    + card('🔴 عميل آخر', ['+201000000003']));
  assert.equal(i.excluded_marker_cards, 1);
  assert.equal(i.excluded_cards, 3);
  assert.equal(i.index['201000000002'].excluded, true);
  assert.equal(i.index['201000000003'].marked, true);
});
test('missing excluded numbers fails closed', () => {
  assert.throws(() => buildIndex(card('🌀 مستبعد', [])));
  assert.throws(() => buildIndex(card('🟢 عميل', ['+201000000003'])));
});
test('ambiguous names are held', () => {
  const i = buildIndex(card('🌀 مستبعد', ['+201000000001'])
    + card('واحد', ['+201000000002']) + card('اثنان', ['+201000000002']));
  assert.equal(i.index['201000000002'].ambiguous, true);
});
