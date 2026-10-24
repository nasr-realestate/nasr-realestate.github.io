#!/usr/bin/env node
// Optional real-browser smoke test. Install puppeteer-core externally (NODE_PATH)
// and supply a local Chrome/Chromium with CHROME_BIN. No browser in ordinary CI.
// BASE=http://127.0.0.1:3000 CHROME_BIN=/path/to/chrome NODE_PATH=/path/to/node_modules \
//   node scripts/e2e/render-performance.e2e.mjs
// CHROME_ARGS_JSON may supply sandbox-specific launch arguments as a JSON array.
// No request interception/font substitution: verifies committed local assets.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const search = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
const puppeteer = require(require.resolve('puppeteer-core', { paths: [...search, process.cwd()] }));
const base = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const extra = JSON.parse(process.env.CHROME_ARGS_JSON || '[]');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, args: extra, headless: true });
const pages = ['/', '/properties/', '/properties/apartment-sale-moussa-el-kazem-nasr-city-280m/',
  '/requests/', '/agent.html', '/tools/valuation.html', '/luxury-gallery.html'];
try {
  for (const width of [390, 1440]) for (const url of pages) {
    const page = await browser.newPage();
    const errors = [];
    const fontRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) fontRequests.push(req.url()); });
    await page.setCacheEnabled(false);
    await page.setBypassServiceWorker(true);
    await page.setViewport({ width, height: width === 390 ? 844 : 900, isMobile: width === 390, hasTouch: width === 390 });
    await page.goto(base + url, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(fontRequests, [], `${url}: external font request`);
    assert.deepEqual(errors, [], `${url}: JS exception`);
    const font = await page.evaluate(() => [...document.fonts].some(f => f.family === 'Cairo' && f.status === 'loaded'));
    assert.ok(font, `${url}: Cairo did not load`);
    if (url === '/') {
      await page.evaluate(async () => {
        for (const section of document.querySelectorAll('.hp-section')) {
          section.scrollIntoView();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const title = section.querySelector('h2, h3, a');
          if (title && title.getBoundingClientRect().height <= 0) throw new Error('Unrendered section');
        }
        window.scrollTo(0, 0);
      });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const motion = await page.$eval('.agent-float-btn', el => getComputedStyle(el, '::after').animationName);
      assert.equal(motion, 'none');
      await page.emulateMediaType('print');
      const print = await page.$eval('.hp-section', el => getComputedStyle(el).contentVisibility);
      assert.equal(print, 'visible');
      await page.emulateMediaType('screen');
    }
    // Full-screen cinematic gallery deliberately has a horizontal track.
    if (url !== '/luxury-gallery.html') {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 1, `${width}px ${url}: horizontal overflow ${overflow}`);
    }
    console.log(`PASS ${width}px ${url}`);
    await page.close();
  }
} finally { await browser.close(); }
