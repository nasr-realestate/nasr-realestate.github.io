#!/usr/bin/env node
// Optional browser test (not ordinary CI): supply puppeteer-core and axe-core
// through NODE_PATH and Chrome via CHROME_BIN. Uses BASE (default local preview).
// CHROME_ARGS_JSON is an optional JSON array for sandbox-specific Chrome flags.
// No real WhatsApp message/navigation: the combined primary button's native
// navigation is tested with a local probe after validating its WhatsApp URL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const paths = [...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), process.cwd()];
const puppeteer = require(require.resolve('puppeteer-core', { paths }));
const axePath = require.resolve('axe-core/axe.min.js', { paths });
const base = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const property = '/properties/apartment-sale-moussa-el-kazem-nasr-city-280m/';
const selector = '[data-availability-prompt]';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN,
  args: JSON.parse(process.env.CHROME_ARGS_JSON || '[]'), headless: true });

async function open(width, { noJs = false, blockedStorage = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, isMobile: width < 700, hasTouch: width < 700 });
  await page.setCacheEnabled(false);
  await page.setBypassServiceWorker(true);
  await page.setJavaScriptEnabled(!noJs);
  if (blockedStorage) await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.goto(base + property, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function enterDescription(page) {
  await page.$eval(selector, el => {
    document.documentElement.style.scrollBehavior = 'auto';
    el.scrollIntoView({ block: 'center' });
  });
}
async function visible(page) {
  await page.waitForFunction(s => document.querySelector(s).classList.contains('is-visible'), { timeout: 7000 }, selector);
}
try {
  for (const width of [320, 390, 1440]) {
    const page = await open(width);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await new Promise(r => setTimeout(r, 2100));
    assert.equal(await page.$eval(selector, el => el.classList.contains('is-visible')), false, 'must not show before reading');
    await enterDescription(page);
    await page.$eval('#ppWaBtn', el => el.focus({ preventScroll: true }));
    const before = await page.$eval(selector, el => el.getBoundingClientRect().height);
    await visible(page);
    await new Promise(r => setTimeout(r, 250)); // settle the optional .18s fade
    const after = await page.$eval(selector, el => el.getBoundingClientRect().height);
    assert.ok(Math.abs(after - before) < 1, 'reveal must not resize the card');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ppWaBtn', 'no automatic focus stealing');
    assert.equal(await page.$eval(selector, el => el.querySelectorAll('a').length), 0, 'reminder must have no duplicate contact button');
    const href = await page.$eval('#ppWaBtn', el => el.href);
    const url = new URL(href);
    assert.equal(url.hostname, 'wa.me');
    assert.equal(url.pathname, '/201147758857');
    const text = url.searchParams.get('text');
    assert.ok(text.includes(property));
    assert.ok(text.includes('موسى الكاظم'));
    assert.ok(text.includes('التأكد'));
    assert.ok(text.includes('معرفة التفاصيل'));
    assert.ok(text.includes('موعد للمعاينة'));
    assert.ok(await page.$eval('#ppWaBtn', el => el.textContent.includes('اسأل عن التفاصيل والتوافر')));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1);
    await page.addScriptTag({ path: axePath });
    const violations = await page.$eval(selector, async el => (await axe.run(el, {
      runOnly: ['color-contrast', 'button-name', 'link-name'],
    })).violations);
    assert.deepEqual(violations, []);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.$eval(selector, el => getComputedStyle(el).animationName), 'none');
    await page.emulateMediaType('print');
    assert.equal(await page.$eval(selector, el => getComputedStyle(el).display), 'none');
    await page.emulateMediaType('screen');
    await new Promise(r => setTimeout(r, 250));
    if (process.env.SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `availability-${width}.png`) });
    }

    // The one combined primary action keeps its native navigation.
    const probe = base + '/__availability_probe__';
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.url() === probe) return req.respond({ status: 200, contentType: 'text/html', body: '<p>Local CTA probe</p>' });
      return req.continue();
    });
    await page.$eval('#ppWaBtn', (el, destination) => {
      el.href = destination; el.target = '_self';
    }, probe);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#ppWaBtn')]);
    assert.equal(page.url(), probe);
    await page.goto(base + property, { waitUntil: 'load' });
    assert.equal(await page.$eval(selector, el => el.hidden), true, 'must not repeat for the same property/session');

    // A fresh viewing permits another invitation and keyboard dismissal.
    await page.$eval(selector, el => sessionStorage.removeItem('smsar:availability:' + el.getAttribute('data-property')));
    await page.reload({ waitUntil: 'load' });
    await enterDescription(page); await visible(page);
    await page.focus('[data-availability-close]'); await page.keyboard.press('Escape');
    assert.equal(await page.$eval(selector, el => el.hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ppDescription');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: reading trigger, stable text-only reminder, combined CTA, close, accessibility, print, session flag`);
    await page.close();
  }
  const oldBrowser = await open(390, { noJs: true });
  assert.equal(await oldBrowser.$eval(selector, el => getComputedStyle(el).visibility), 'visible');
  await oldBrowser.close();
  const restricted = await open(390, { blockedStorage: true });
  await enterDescription(restricted); await visible(restricted);
  await restricted.click('[data-availability-close]');
  assert.equal(await restricted.$eval(selector, el => el.hidden), true);
  await restricted.close();
  console.log('PASS disabled JavaScript and blocked sessionStorage');
} finally { await browser.close(); }
