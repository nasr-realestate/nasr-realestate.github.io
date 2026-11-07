import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, render } from '../crm/build-daily-list.mjs';

const TODAY = Date.parse('2026-11-07T00:00:00Z');
const daysAgo = (n) => new Date(TODAY - n * 86_400_000).toISOString();

const person = (title, resolved, messages, days) => ({
  chat_title: `${title}.zip`, resolved_to: resolved, messages, last: daysAgo(days),
});

test('DAY-1 only the five marks reach the list', () => {
  const rows = buildRows([
    person('🟢 مالك شقة', 'مالك شقة', 10, 5),
    person('محمد سمير،شقه 200 م', null, 40, 120),
  ], TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seg.key, 'sale');
});

test('DAY-2 silence leads, and a passer-by never outranks a stalled unit', () => {
  const rows = buildRows([
    person('🟢 تمليك ساكت', 'تمليك ساكت', 45, 72),
    person('✈️ عابر نشيط', 'عابر نشيط', 49, 2),
    person('🔴 مفروش ساكت', 'مفروش ساكت', 20, 45),
  ], TODAY);
  assert.equal(rows[0].name, 'تمليك ساكت', 'two months of silence is the top signal');
  assert.equal(rows[1].name, 'مفروش ساكت', 'a stalled unit beats a fresh passer-by');
  assert.equal(rows[2].name, 'عابر نشيط', 'the passer-by is kept, at the bottom');
});

test('DAY-3 every name carries a reason in the broker language', () => {
  const rows = buildRows([
    person('✈️ عابر ساكت', 'عابر ساكت', 4, 40),
    person('🟢 مالك نشيط', 'مالك نشيط', 4, 3),
  ], TODAY);
  assert.match(rows.find((r) => r.name === 'عابر ساكت').reason, /عابر/);
  assert.equal(rows.find((r) => r.name === 'مالك نشيط').reason, 'متابعة عادية');
});

test('DAY-4 the archive extension never surfaces in a name', () => {
  const rows = buildRows([person('🟢 بيبو ارض الجولف', null, 5, 10)], TODAY);
  assert.equal(rows[0].name, '🟢 بيبو ارض الجولف');
  assert.equal(rows[0].hasNumber, false);
});

test('DAY-5 rendering lists the top N and separates demand from silent supply', () => {
  const rows = buildRows([
    person('✈️ عابر', 'عابر', 30, 40),
    person('🟢 مالك', 'مالك', 30, 70),
  ], TODAY);
  const md = render(rows, '2026-11-07', 1);
  assert.match(md, /# النهاردة/);
  assert.match(md, /## العابرون/);
  assert.match(md, /## العرض الساكت/);
  const tableRows = md.split('\n').filter((l) => l.startsWith('| ') && !l.includes('لماذا') && !l.includes('---'));
  assert.equal(tableRows.length, 1, 'the cap is respected');
});
