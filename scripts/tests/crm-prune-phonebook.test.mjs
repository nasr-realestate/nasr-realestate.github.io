import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_ROOT,
  assertOutDirOutsideRepo,
  buildPruneReport,
  toCsv,
  toVcard3,
} from '../crm/prune-phonebook.mjs';

// Synthetic cards only. These numbers belong to nobody; they exist to exercise rules.
const qpName = (text) => Buffer.from(text, 'utf8').toString('hex').match(/../g).map((b) => `=${b.toUpperCase()}`).join('');

function card({ fn, phones, mark = '' }) {
  const encoded = qpName(`${mark}${fn}`);
  const folded = `${encoded.slice(0, 40)}=\r\n${encoded.slice(40)}`;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:;${folded};;;`,
    `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${folded}`,
    ...phones.map((p) => `TEL;CELL;PREF:${p}`),
    'END:VCARD',
    '',
  ];
  return lines.join('\r\n');
}

test('PRUNE-1: a quoted-printable, folded Arabic name is decoded and written as vCard 3.0', () => {
  const text = card({ fn: 'عميل تجريبي', phones: ['+201000000001'] });
  const { current, stats } = buildPruneReport({ vcfTexts: [{ name: 'a.vcf', text }], keep: 'all' });
  assert.equal(stats.cards, 1);
  assert.equal(current.length, 1);
  assert.equal(current[0].fn, 'عميل تجريبي', 'the folded QP name comes back whole');
  assert.deepEqual(current[0].phones, ['201000000001']);

  const vcard = toVcard3(current);
  assert.match(vcard, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.ok(vcard.includes('FN:عميل تجريبي'), 'unmarked card still keeps its name');
  assert.ok(vcard.includes('TEL;TYPE=CELL:+201000000001'), 'number is written international');
  assert.ok(vcard.trimEnd().endsWith('END:VCARD'), 'one block, properly closed');
  assert.equal(vcard.split('BEGIN:VCARD').length - 1, 1);
});

test('PRUNE-2: the same number under two spellings is one card, and the marked spelling wins', () => {
  const day1 = card({ fn: 'حازم عبد العال', phones: ['+201000000002'] });
  const day2 = card({ fn: 'حازم محل', phones: ['0100 000 0002'], mark: '🟢 ' });
  const { current, stats, rows } = buildPruneReport({
    vcfTexts: [{ name: 'a.vcf', text: day1 }, { name: 'b.vcf', text: day2 }],
    keep: 'marked',
  });
  assert.equal(stats.people, 1, 'two cards, one person');
  assert.equal(current.length, 1);
  assert.equal(current[0].fn, '🟢 حازم محل', 'the mark decides which spelling is shown');
  assert.equal(current[0].marked, true);
  assert.equal(current[0].phones.length, 1, 'the same number is not written twice');
  const merged = rows.find((r) => r.name === 'حازم عبد العال');
  assert.match(merged.reason, /دُمج في/);
});

test('PRUNE-3: an unmarked card stays out of the current file and lands in the archive instead', () => {
  const text = [
    card({ fn: 'معرفة قديمة', phones: ['+201000000003'] }),
    card({ fn: 'محل تجريبي', phones: ['+201000000004'], mark: '🟠 ' }),
  ].join('');
  const marked = buildPruneReport({ vcfTexts: [{ name: 'a.vcf', text }], keep: 'marked' });
  assert.equal(marked.current.length, 1);
  assert.equal(marked.current[0].fn, '🟠 محل تجريبي');
  assert.equal(marked.archive.length, 1, 'nothing is deleted: the rest is archived');
  assert.equal(marked.archive[0].fn, 'معرفة قديمة');

  const all = buildPruneReport({ vcfTexts: [{ name: 'a.vcf', text }], keep: 'all' });
  assert.equal(all.current.length, 2, '--keep all keeps every card that has a number');
  assert.equal(all.archive.length, 0);
});

test('PRUNE-4: a card without a number is reported, never written', () => {
  const noNumber = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN:ملاحظة بلا رقم\r\nEND:VCARD\r\n';
  const { current, archive, rows, stats } = buildPruneReport({
    vcfTexts: [{ name: 'a.vcf', text: noNumber }],
    keep: 'all',
  });
  assert.equal(stats.without_number, 1);
  assert.equal(current.length, 0);
  assert.equal(archive.length, 0);
  assert.equal(rows[0].reason, 'no_number');
  assert.equal(current.length === 0 ? toVcard3(current) : 'x', '', 'an empty kept set writes no fake card');
});

test('PRUNE-5: the report csv quotes what needs quoting and keeps every input row', () => {
  const text = [
    card({ fn: 'اسم, بفاصلة', phones: ['+201000000005'] }),
    card({ fn: 'اسم "باقتباس"', phones: ['+201000000006'], mark: '🔵 ' }),
  ].join('');
  const { rows } = buildPruneReport({ vcfTexts: [{ name: 'a.vcf', text }], keep: 'marked' });
  const csv = toCsv(rows);
  assert.equal(rows.length, 2);
  assert.match(csv, /^name,phones,result,reason\r\n/);
  assert.match(csv, /"اسم, بفاصلة"/, 'a comma inside a name cannot break the columns');
  assert.match(csv, /"🔵 اسم ""باقتباس"""/, 'a quote is doubled, not dropped');
});

test('PRUNE-7: --only takes one complete group and leaves everything else in the archive', () => {
  const text = [
    card({ fn: 'بتاع الشغل', phones: ['+201000000007'], mark: '🌀 ' }),
    card({ fn: 'بتاع الشغل 2', phones: ['+201000000008'], mark: '🌀 ' }),
    card({ fn: 'محل تجريبي', phones: ['+201000000009'], mark: '🟠 ' }),
    card({ fn: 'بلا علامة', phones: ['+201000000010'] }),
  ].join('');
  const { current, archive, stats } = buildPruneReport({
    vcfTexts: [{ name: 'a.vcf', text }],
    only: '🌀',
  });
  assert.equal(stats.only, '🌀');
  assert.equal(current.length, 2, 'the whole group, not part of it');
  assert.ok(current.every((p) => p.fn.includes('🌀')));
  assert.equal(archive.length, 2, 'the marked 🟠 card is NOT dragged in by --only');
  assert.equal(current[0].segment.label, '🌀', 'an unknown mark becomes its own label');

  const vcard = toVcard3(current);
  assert.equal(vcard.split('BEGIN:VCARD').length - 1, 2);
  assert.ok(vcard.includes('CATEGORIES:🌀'), 'the mark travels to the phone');
});

test('PRUNE-8: --include adds an extra mark to the five instead of replacing them', () => {
  const text = [
    card({ fn: 'بتاع الشغل', phones: ['+201000000011'], mark: '🌀 ' }),
    card({ fn: 'محل تجريبي', phones: ['+201000000012'], mark: '🟠 ' }),
    card({ fn: 'بلا علامة', phones: ['+201000000013'] }),
  ].join('');
  const { current } = buildPruneReport({
    vcfTexts: [{ name: 'a.vcf', text }],
    include: ['🌀'],
  });
  assert.equal(current.length, 2, '🌀 joins the five; the unmarked card still stays out');
  assert.deepEqual(current.map((p) => p.fn).sort(), ['🌀 بتاع الشغل', '🟠 محل تجريبي']);
});

test('PRUNE-6: writing inside the repository is refused before any file is created', () => {
  assert.throws(() => assertOutDirOutsideRepo(path.join(REPO_ROOT, 'imports', 'out')), /refusing-to-write-inside-repository/);
  assert.throws(() => assertOutDirOutsideRepo(REPO_ROOT), /refusing-to-write-inside-repository/);
  const outside = path.join(path.dirname(REPO_ROOT), 'phonebook-out');
  assert.equal(assertOutDirOutsideRepo(outside), outside);
});
