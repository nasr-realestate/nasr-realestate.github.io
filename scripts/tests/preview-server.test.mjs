// Tests: خادم المعاينة (server.js) — الاستجابات لا تُقطع تحت التحميل
//
// سبب الوجود (2026-10-24): وسيط ضغط gzip الذي أُضيف للمعاينة كان يحذف
// Content-Length بعد بدء ترويسات استجابة متدفقة، فيرمي استثناءً ويقطع الاتصال —
// فظهر في CI «fetch failed» أثناء زحف الروابط (اختبار preview-parity)، محليًا
// فقط عند تزامن عالٍ. هذه الاختبارات تمنع رجوع العيب.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app } from '../../server.js';

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((resolve) => server.close(resolve)));

const gz = { headers: { 'accept-encoding': 'gzip' } };

test('gzip: استجابات نصية مضغوطة، وثنائية كما هي', async () => {
  const css = await fetch(`${BASE}/assets/css/style.min.css`, gz);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  const cssText = await css.text();
  assert.ok(cssText.length > 10000, 'الجسم بعد فك الضغط سليم');

  const mp3 = await fetch(`${BASE}/assets/audio/properties/10th-district-180m.mp3`, { headers: { range: 'bytes=0-99', 'accept-encoding': 'gzip' } });
  assert.equal(mp3.status, 206);
  assert.equal(mp3.headers.get('content-encoding'), null, 'طلبات Range لا تُضغط أبدًا');
  assert.match(String(mp3.headers.get('content-range')), /^bytes 0-99\//);

  const head = await fetch(`${BASE}/assets/css/style.min.css`, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(head.status, 200);
});

test('gzip: 200 طلبًا متزامنًا على أنواع مختلفة ⇒ صفر إخفاق', async () => {
  const urls = [
    '/', '/agent.html', '/properties/', '/requests/',
    '/api/properties.json', '/api/properties/abdel-azim-ghalmi-200m-expat.md',
    '/assets/css/style.min.css', '/llms-full.txt', '/ai-feed.json', '/sw.js',
  ];
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) => fetch(BASE + urls[i % urls.length], {
      headers: { 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(20000),
    }).then(async (res) => {
      await res.arrayBuffer();
      return res.status === 200 ? null : `${urls[i % urls.length]} → ${res.status}`;
    }).catch((err) => `${urls[i % urls.length]} → ${err.message}`)),
  );
  const failures = results.filter(Boolean);
  assert.deepEqual(failures.slice(0, 5), [], `استجابات مقطوعة (${failures.length}/200)`);
});

test('gzip: المحتوى المضغوط يُفكّ إلى نفس البايتات', async () => {
  const plain = await (await fetch(`${BASE}/assets/css/style.min.css`, { headers: { 'accept-encoding': 'identity' } })).text();
  const zipped = await (await fetch(`${BASE}/assets/css/style.min.css`, gz)).text();
  assert.equal(zipped.length, plain.length);
  assert.equal(zipped, plain);
});
