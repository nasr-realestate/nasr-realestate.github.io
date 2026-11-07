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
  assert.equal(rows[0].seg.key, 'owner');
});

test('DAY-2 silence outranks a quiet seeker, and a seeker still outranks a fresh owner', () => {
  const rows = buildRows([
    person('🟢 مالك ساكت', 'مالك ساكت', 45, 72),
    person('✈️ باحث جديد', 'باحث جديد', 49, 8),
    person('🔴 مفروش جديد', 'مفروش جديد', 3, 2),
  ], TODAY);
  assert.equal(rows[0].name, 'مالك ساكت', 'two months of silence is the top signal');
  assert.equal(rows[1].name, 'باحث جديد', 'scarcity lifts the seeker above a fresh owner');
  assert.equal(rows[2].name, 'مفروش جديد');
});

test('DAY-3 every name carries a reason in the broker language', () => {
  const rows = buildRows([
    person('✈️ باحث ساكت', 'باحث ساكت', 4, 40),
    person('🟢 مالك نشيط', 'مالك نشيط', 4, 3),
  ], TODAY);
  assert.match(rows.find((r) => r.name === 'باحث ساكت').reason, /باحث/);
  assert.equal(rows.find((r) => r.name === 'مالك نشيط').reason, 'متابعة عادية');
});

test('DAY-4 the archive extension never surfaces in a name', () => {
  const rows = buildRows([person('🟢 بيبو ارض الجولف', null, 5, 10)], TODAY);
  assert.equal(rows[0].name, '🟢 بيبو ارض الجولف');
  assert.equal(rows[0].hasNumber, false);
});

test('DAY-5 rendering lists the top N and separates demand from silent supply', () => {
  const rows = buildRows([
    person('✈️ باحث', 'باحث', 30, 40),
    person('🟢 مالك', 'مالك', 30, 70),
  ], TODAY);
  const md = render(rows, '2026-11-07', 1);
  assert.match(md, /# النهاردة/);
  assert.match(md, /## الطلب/);
  assert.match(md, /## العرض الساكت/);
  const tableRows = md.split('\n').filter((l) => l.startsWith('| ') && !l.includes('لماذا') && !l.includes('---'));
  assert.equal(tableRows.length, 1, 'the cap is respected');
});
