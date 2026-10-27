// Tests: صفحة «دفتر العملاء» (/crm.html) — خصوصية وأمان ونشر (2026-10-27)
//
// الصفحة أداة خاصة: البيانات في متصفح صاحب الموقع فقط. هذه الاختبارات تمنع أي تراجع:
// فهرسة، طرف ثالث، HTML ديناميكي من بيانات مستوردة، شبكة غير إعلانات الموقع، فتح واتساب
// تلقائيًا، أو بيانات حقيقية داخل المستودع العام.
//
// node --test scripts/tests/crm-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('crm.html');
const APP = read('assets/js/crm-app.js');
const CORE = read('assets/js/crm-core.js');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('crm.html: noindex وخارج sitemap وبلا front matter (ملف ساكن)', () => {
  assert.match(HTML, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.ok(!HTML.startsWith('---'), 'بلا front matter: Jekyll ينسخها كما هي');
  assert.doesNotMatch(HTML, /\{\{|\{%/, 'بلا Liquid');
  const cfg = read('_config.yml');
  assert.match(cfg, /path: "crm\.html"\n    values:\n      sitemap: false/);
});

test('crm.html: CSP صارمة، بلا سكربت مضمَّن، بلا أي أصل خارجي، وخطوط ذاتية الاستضافة', () => {
  const csp = HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'CSP مفقودة');
  for (const rule of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(rule), rule);
  }
  assert.doesNotMatch(csp[1], /script-src[^;]*unsafe-inline/);
  assert.match(HTML, /<meta name="referrer" content="no-referrer">/);
  const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const s of scripts) {
    assert.equal(s[2].trim(), '', 'لا سكربت مضمَّن');
    assert.match(s[1], /src="\/assets\/js\/crm-(core|app)\.js\?v=[\w-]+"/);
  }
  assert.doesNotMatch(HTML.replace(/<!--[\s\S]*?-->/g, ''), /(?:src|href)="https?:/, 'لا طرف ثالث');
  assert.doesNotMatch(HTML, /fonts\.googleapis|gtag|googletagmanager|analytics|facebook\.net/);
  assert.match(HTML, /href="\/assets\/css\/cairo\.css\?v=/);
  assert.doesNotMatch(HTML, /\bfa-[a-z0-9-]+\b/, 'بلا أيقونات Font Awesome');
  for (const m of HTML.matchAll(/(?:src|href)="(\/[^"?#]+)/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), `ملف مفقود: ${m[1]}`);
  }
});

test('crm-app.js: لا HTML ديناميكي، لا eval، الشبكة لإعلانات الموقع فقط، وواتساب روابط يضغط عليها المستخدم', () => {
  const c = code(APP);
  assert.doesNotMatch(c, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  const fetches = [...c.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ['CATALOG_URL'], 'fetch واحد بس');
  assert.match(c, /var CATALOG_URL = '\/assets\/data\/catalog\.json';/);
  assert.doesNotMatch(c, /XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  assert.doesNotMatch(c, /window\.open\(|location\.(?:href|assign|replace)\s*[=(]/, 'لا فتح تلقائي لواتساب أو غيره');
  assert.match(c, /var KEY = 'simsar_crm_v1';/);
  assert.doesNotMatch(c, /sessionStorage|indexedDB|document\.cookie/);
  assert.match(c, /credentials: 'omit'/);
});

test('crm-core.js: دوال صافية — بلا DOM ولا شبكة ولا تخزين', () => {
  const c = code(CORE);
  assert.doesNotMatch(c, /document\.|window\.|localStorage|fetch\(|XMLHttpRequest|navigator\./);
  assert.match(CORE, /root\.SimsarCRM = \{/);
});

test('لا بيانات عملاء حقيقية في ملفات الأداة المنشورة (المستودع عام)', () => {
  for (const [name, src] of [['crm.html', HTML], ['crm-app.js', APP], ['crm-core.js', CORE]]) {
    const phones = src.match(/(?:\+?20|0)1[0125][\s-]?\d{3,4}[\s-]?\d{4}/g) || [];
    assert.deepEqual(phones, [], `${name}: أرقام موبايل داخل الكود`);
    assert.doesNotMatch(src, /@(gmail|yahoo|hotmail|outlook)\./i, `${name}: إيميلات`);
  }
});

test('المعاينة المحلية (server.js) تخدم الصفحة والنواة وإعلانات المطابقة', async () => {
  const { app } = await import('../../server.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/crm.html', '/crm']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /دفتر العملاء/);
    }
    for (const p of ['/assets/js/crm-core.js', '/assets/js/crm-app.js']) assert.equal((await fetch(base + p)).status, 200, p);
    const rows = await (await fetch(base + '/assets/data/catalog.json')).json();
    assert.ok(Array.isArray(rows) && rows.length > 0);
    assert.ok(rows.every((r) => r.u && r.t && r.d && r.y), 'حقول المطابقة موجودة');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
