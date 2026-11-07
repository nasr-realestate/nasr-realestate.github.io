/**
 * إشعارات CRM — الوجهة والنص (2026-11-07).
 *
 * ما كان معطوبًا وقياسه: كل حمولة كانت تحمل `url: '/'`، فالنقر يفتح الجذر لا الصفحة المقصودة؛
 * والتنبيهات الذكية كانت تُبنى من `alert_reason`/`suggested_action` بقيم افتراضية واحدة، فتصل
 * إشعارات متتالية بنصّ واحد. وحتى لو صحّت الوجهة، كان عامل الخدمة يكتفي بـ`focus()` على نافذة
 * مفتوحة على أي تبويب — فيبدو النقر كأنه لم يفعل شيئًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildDueFollowupPayload, buildSmartAlertPayload } from '../crm-push.js';

const QUEUES = '/crm.html#a5-work-panel';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const opp = (over = {}) => ({
  id: 'opp-11111111', track: 'sale_apt', intent: 'buy', property_type: 'شقة',
  area_label: 'الحي السابع', next_action: 'إرسال وحدتين', next_followup_at: '2026-11-07T09:30:00.000Z', ...over,
});

test('DEEP-1 كل إشعار يسمّي وجهته: قوائم العمل، لا جذر الموقع', () => {
  assert.equal(buildDueFollowupPayload(opp()).url, QUEUES);
  assert.equal(buildSmartAlertPayload({ id: 'a-1', alert_type: 'followup_overdue' }).url, QUEUES);
  const source = read('../crm-push.js');
  assert.equal(/url:\s*'\/'/.test(source), false, 'لا وجهة جذرية باقية في أي حمولة');
});

test('DEEP-2 إشعاران لمتابعتين مختلفتين لا يتشابهان — الوقت يميّز العنوان', () => {
  const first = buildDueFollowupPayload(opp({ next_followup_at: '2026-11-07T09:30:00.000Z' }));
  const second = buildDueFollowupPayload(opp({ id: 'opp-22222222', next_followup_at: '2026-11-07T14:05:00.000Z' }));
  assert.notEqual(first.title, second.title, 'العنوان يحمل وقته');
  assert.notEqual(first.tag, second.tag);
  assert.match(first.title, /متابعة مستحقة/);
});

test('DEEP-3 نوع التنبيه يظهر في النص، فلا تُقرأ أربعة تنبيهات كجملة واحدة', () => {
  const types = ['followup_approaching', 'followup_overdue', 'viewing_requested_unlogged', 'unanswered_question'];
  const bodies = types.map((alert_type) => buildSmartAlertPayload({ id: `a-${alert_type}`, alert_type }).body);
  assert.equal(new Set(bodies).size, types.length, 'كل نوع بجملته');
  assert.match(bodies[0], /متابعة تقترب/);
  assert.match(bodies[1], /متابعة متأخرة/);
});

test('DEEP-4 بلا اسم عميل وبلا هاتف على شاشة القفل', () => {
  const payload = buildSmartAlertPayload({
    id: 'a-1', alert_type: 'followup_overdue', alert_reason: 'عميل اسمه محمد — 01000000000',
    suggested_action: 'اتصل به', due_at: '2026-11-07T08:00:00.000Z',
  });
  assert.equal(/\d{8,}/.test(payload.body), false, 'لا أرقام هواتف');
});

test('DEEP-5 عامل الخدمة ينقل النافذة إلى الهدف لا يكتفي بإحضارها', () => {
  const sw = read('../crm-ui/crm-sw.js');
  assert.match(sw, /notificationclick/);
  assert.match(sw, /\.navigate\(targetUrl\)/, 'النقر يوجّه النافذة إلى الوجهة');
  assert.match(sw, /openWindow\(targetUrl\)/, 'وبلا نافذة مفتوحة يفتح الوجهة');
  const handler = sw.slice(sw.indexOf("addEventListener('notificationclick'"));
  assert.equal(/return client\.focus\(\);/.test(handler.slice(0, 400)), false, 'لا focus بلا وجهة');
});

test('DEEP-6 الصفحة تحترم الوسم: النقر يفتح اللوحة المسمّاة', () => {
  const app = read('../crm-ui/crm-assets/app.js');
  assert.match(app, /function openPanelFromHash/);
  assert.match(app, /addEventListener\('hashchange'/);
  assert.match(app, /\.tab\[data-panel=/);
  const html = read('../crm-ui/crm.html');
  assert.match(html, /data-panel="a5-work-panel"/, 'اللوحة التي تشير إليها الإشعارات موجودة فعلًا');
});
