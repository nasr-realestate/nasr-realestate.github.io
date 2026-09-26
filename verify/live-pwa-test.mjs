/**
 * اختبار حقيقي على الموقع المنشور — Chromium فعلي (CI)
 * ⚠️ ملف مؤقت للتحقق بعد النشر — يُحذف بعد انتهاء الاختبار.
 *
 * يتحقق من:
 *  1) المانيفست: يُقرأ، بلا أخطاء، وبدون أخطاء تثبيت (installability)
 *  2) Service Worker: مُسجَّل + activated وماسك نطاق الجذر
 *  3) الكاش: القشرة الأساسية موجودة، وبلا أي مسار محظور
 *  4) فتح التطبيق بلا شبكة (نفس ما يحدث عند الضغط على الأيقونة)
 */
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = 'https://nasr-realestate.github.io';
const report = {};
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

// ── 1) تحميل صفحة الوكيل الذكي (start_url) ──
await page.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 40000 }).catch(() => {});

report.page = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  const regs = await navigator.serviceWorker.getRegistrations();
  return {
    title: document.title,
    manifestHref: link ? link.getAttribute('href') : null,
    themeColor: document.querySelector('meta[name="theme-color"]')?.content || null,
    appleCapable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
    appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || null,
    hasRegisterCall: /serviceWorker/.test(document.documentElement.innerHTML),
    controller: !!navigator.serviceWorker.controller,
    registrations: regs.map((r) => ({
      scope: r.scope,
      active: r.active?.state || null,
      script: r.active?.scriptURL || r.installing?.scriptURL || null,
    })),
  };
});

// ── 2) المانيفست + أخطاء التثبيت ──
const client = await page.createCDPSession();
const man = await client.send('Page.getAppManifest');
report.manifest = { url: man.url, errors: man.errors };
try {
  report.installabilityErrors = (await client.send('Page.getInstallabilityErrors')).installabilityErrors;
} catch (e) {
  report.installabilityErrors = 'n/a: ' + e.message;
}

// ── 3) محتوى الكاش ──
report.cache = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = { caches: names, entries: {}, forbidden: [] };
  for (const n of names) {
    const c = await caches.open(n);
    out.entries[n] = (await c.keys()).map((k) => new URL(k.url).pathname);
  }
  out.forbidden = Object.values(out.entries).flat()
    .filter((p) => p.startsWith('/upload-images') || p.startsWith('/api/'));
  return out;
});

// ── 4) فتح التطبيق بلا شبكة ──
await page.setOfflineMode(true);
try {
  const resp = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  report.offlineOpen = {
    httpStatus: resp ? resp.status() : 'served-by-sw',
    h1: await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || null),
    headerRendered: await page.evaluate(() => {
      const h = document.querySelector('.header');
      return h ? getComputedStyle(h).display !== 'none' : false;
    }),
    htmlBytes: (await page.content()).length,
    ok: true,
  };
} catch (e) {
  report.offlineOpen = { ok: false, error: String(e) };
}
await page.setOfflineMode(false);

// ── 5) الملفات المطلوبة عبر الشبكة (حالة + نوع المحتوى) ──
report.files = await page.evaluate(async (base) => {
  const out = {};
  for (const p of ['/sw.js', '/manifest.json', '/assets/img/icon-192.png',
                   '/assets/img/icon-512.png', '/assets/img/icon-maskable-512.png']) {
    const r = await fetch(base + p, { cache: 'no-store' });
    out[p] = { status: r.status, type: r.headers.get('content-type') };
  }
  return out;
}, BASE);

const json = JSON.stringify(report, null, 2);
writeFileSync('verify/live-report.json', json + '\n');
console.log('===PWA-LIVE-REPORT===');
console.log(json);
console.log('===END===');
await browser.close();
