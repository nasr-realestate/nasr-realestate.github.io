#!/usr/bin/env node
/**
 * Browser acceptance test for the reliable search / owner draft / valuation evidence work (2026-10-26).
 * Optional — not part of `npm test` (CI installs no browser). Arabic RTL at 320, 390 and 1440 px.
 *
 *   BASE=http://127.0.0.1:3000 CHROME_BIN=/path/to/chromium \
 *   NODE_PATH=/path/with/puppeteer-core/node_modules node scripts/e2e/reliable-journeys.e2e.mjs
 *
 * Optional: CHROME_ARGS_JSON='["--no-sandbox", ...]', SCREENSHOT_DIR=/tmp/shots.
 *
 * Safety: every request that is not to BASE is aborted, except the valuation Worker, which is
 * answered by a local mock (no network). Any POST from the agent page fails the test. Input is
 * synthetic; nothing is submitted, stored on a server, or sent to WhatsApp.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const searchPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
const puppeteer = require(require.resolve('puppeteer-core', { paths: [...searchPaths, process.cwd()] }));

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME_BIN;
const ARGS = JSON.parse(process.env.CHROME_ARGS_JSON || '["--no-sandbox"]');
const SHOTS = process.env.SCREENSHOT_DIR || '';
const VALUATION_WORKER = 'https://noisy-bush-fd84.footcai-555.workers.dev';
const VIEWPORTS = [[320, 640], [390, 844], [1440, 900]];
if (!CHROME) { console.error('CHROME_BIN is required'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const catalog = await (await fetch(`${BASE}/assets/data/catalog.json`)).json();
const catalogUrls = new Set(catalog.map((r) => r.u));

const fallbackResult = {
  api_contract: 'd1-price-snapshots-v2', source_table: 'price_snapshots', price_basis: 'median_price_m2',
  estimate: 7200000, range: { low: 6500000, high: 7900000 }, price_per_meter: 48000,
  price_per_m2_range: { low: 43000, high: 52000 }, market_bounds: { min_price_per_m2: 38000, max_price_per_m2: 60000 },
  area_found: 'مدينة نصر', requested_area: 'عباس العقاد', fallback_used: true, confidence: 'high',
  sample_count: 49, calculated_at: '2026-10-20T00:00:00Z', period: '2026-10', data_source: 'price_snapshots',
  notes: 'اختبار إدخال snapshot واحد', disclaimer: 'مؤشر أسعار طلب وليس سعر إتمام مؤكدًا.',
};

const browser = await puppeteer.launch({ executablePath: CHROME, args: ARGS, headless: 'shell' });

async function openPage(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('simsar_privacy_v1', '1'); } catch {} });
  const log = { external: [], posts: [], valuationBodies: [], errors: [] };
  page.on('pageerror', (e) => log.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') log.posts.push(`${req.method()} ${url}`);
    if (url.startsWith(`${VALUATION_WORKER}/areas`)) {
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ available_areas: ['عباس العقاد', 'المنطقة السادسة', 'مدينة نصر'] }) });
    }
    if (url.startsWith(`${VALUATION_WORKER}/api`)) {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' } });
      log.valuationBodies.push(req.postData() || '');
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fallbackResult) });
    }
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return req.continue();
    log.external.push(url);
    return req.abort();
  });
  return { page, log };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

async function say(page, text, expect) {
  const before = await page.$$eval('#chatArea .msg-bot', (n) => n.length);
  await page.click('#msgInput');
  await page.$eval('#msgInput', (el) => { el.value = ''; });
  await page.type('#msgInput', text);
  await page.click('#sendBtn');
  await page.waitForFunction((count, re) => {
    const bots = [...document.querySelectorAll('#chatArea .msg-bot')];
    return bots.length > count && new RegExp(re).test(bots.map((b) => b.textContent).slice(count).join('\n'));
  }, { timeout: 15000 }, before, expect.source);
  return page.$$eval('#chatArea .msg-bot', (n, c) => n.slice(c).map((b) => b.textContent).join('\n'), before);
}

for (const [width, height] of VIEWPORTS) {
  const tag = `${width}px`;

  // ── 1) Agent: local mode by default, owner draft, search results, scope, no POST ──
  {
    const { page, log } = await openPage(width, height);
    await page.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    const boot = await page.evaluate(() => ({
      local: document.getElementById('localRequestMode').checked,
      dir: getComputedStyle(document.body).direction,
      bar: (() => { const r = document.getElementById('requestModeBar').getBoundingClientRect(); return r.width > 0 && r.height >= 44; })(),
    }));
    check(`${tag} agent: local mode is the default, RTL, toggle has a 44px target`, boot.local && boot.dir === 'rtl' && boot.bar, JSON.stringify(boot));
    const owner = await say(page, 'عندي شقة للبيع في عباس العقاد 180 متر بسعر 8 ملايين', /مسودة محلية فقط/);
    check(`${tag} agent: owner price/area captured, no price re-question`, /السعر المطلوب: بالضبط 8 مليون/.test(owner) && !/ما السعر المطلوب؟/.test(owner));
    const review = await say(page, 'راجع المسودة', /لم يُرسل ولم يُحفظ/);
    check(`${tag} agent: review summary before any future submission`, /add-your-property/.test(review));
    await page.click('#localRequestMode'); await page.click('#localRequestMode'); // a fresh local draft
    const search = await say(page, 'بدور على شقة للإيجار في مدينة نصر أقل من 20 ألف جنيه شهرياً', /المطابقة لكل القيود|لا توجد عروض منشورة/);
    check(`${tag} agent: understood summary shown before results`, /فهمنا: باحث عن عقار — شقة — إيجار شهري — الميزانية: أقل من 20 ألف شهريًا/.test(search));
    const links = await page.$$eval('#chatArea .msg-bot a', (as) => as.map((a) => new URL(a.href).pathname));
    const propertyLinks = links.filter((u) => u.startsWith('/properties/'));
    const hadResults = /المطابقة لكل القيود/.test(search);
    check(`${tag} agent: results are linked, and every link is a Nasr City catalog record`, (!hadResults || propertyLinks.length > 0) && propertyLinks.every((u) => catalogUrls.has(u)), `${propertyLinks.length} links`);
    const rehab = await say(page, 'فيلا للبيع في الرحاب', /مدينة نصر فقط/);
    check(`${tag} agent: out-of-area request is not recommended`, !/\/properties\/rehab/.test(rehab));
    const rtl = await page.$$eval('#chatArea .msg', (ms) => ms.every((m) => getComputedStyle(m).direction === 'rtl'));
    check(`${tag} agent: messages are RTL`, rtl);
    check(`${tag} agent: no horizontal overflow`, await noOverflow(page));
    check(`${tag} agent: no POST and no Worker call from local mode`, log.posts.length === 0 && !log.external.some((u) => /workers\.dev/.test(u)), log.posts.join(' | '));
    check(`${tag} agent: no page errors`, log.errors.length === 0, log.errors.join(' | '));
    await shot(page, `agent-${width}`);
    await page.close();
  }

  // ── 2) Catalog: understood chips, strict bound, scope message ──
  {
    const { page, log } = await openPage(width, height);
    await page.goto(`${BASE}/properties/?q=${encodeURIComponent('شقة أكبر من 150 متر')}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => Number(document.getElementById('plGrid').getAttribute('data-rendered') || 0) > 0, { timeout: 15000 });
    const view = await page.evaluate(() => ({
      chips: document.getElementById('plUnderstood').textContent,
      areas: [...document.querySelectorAll('#plGrid .pl-card-specs')].map((s) => Number((s.textContent.match(/(\d+)\s*م²/) || [])[1] || 0)),
    }));
    check(`${tag} catalog: understood constraint and scope are shown`, /أكبر من 150م²/.test(view.chips) && /مدينة نصر/.test(view.chips), view.chips.trim().slice(0, 80));
    check(`${tag} catalog: «أكبر من 150» shows no 150 m² card`, view.areas.length > 0 && view.areas.every((a) => a === 0 || a > 150), `${view.areas.length} cards`);
    check(`${tag} catalog: no horizontal overflow`, await noOverflow(page));
    await shot(page, `catalog-${width}`);
    await page.goto(`${BASE}/properties/?q=${encodeURIComponent('فيلا للبيع في الرحاب')}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => Number(document.getElementById('plGrid').getAttribute('data-rendered') || 0) > 0, { timeout: 15000 });
    const empty = await page.evaluate(() => ({ text: document.getElementById('plEmptyText').textContent, cards: document.querySelectorAll('#plGrid .pl-card').length, buttons: [...document.querySelectorAll('#plSuggest button')].map((b) => b.textContent) }));
    check(`${tag} catalog: Rehab query → zero cards, scope explained, suggestions say they change a condition`,
      empty.cards === 0 && /مدينة نصر فقط/.test(empty.text) && empty.buttons.every((b) => /^تغيير شرط/.test(b)), empty.buttons.join(' | '));
    check(`${tag} catalog: no page errors`, log.errors.length === 0, log.errors.join(' | '));
    await page.close();
  }

  // ── 3) Valuation: fallback disclosed before the number, limited confidence (mocked Worker) ──
  {
    const { page, log } = await openPage(width, height);
    await page.goto(`${BASE}/tools/valuation.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#area option').length > 1, { timeout: 15000 });
    await page.select('#area', 'عباس العقاد');
    await page.$eval('#size', (el) => { el.value = '150'; });
    await page.evaluate(() => runValuation());
    await page.waitForFunction(() => document.getElementById('result').classList.contains('show'), { timeout: 15000 });
    const v = await page.evaluate(() => {
      const top = (id) => document.getElementById(id).getBoundingClientRect().top;
      return {
        noticeVisible: document.getElementById('fallbackNotice').classList.contains('show'),
        noticeFirst: top('fallbackNotice') < top('estimate'),
        natureFirst: top('valuationNature') < top('estimate'),
        confidence: document.getElementById('confidence').textContent,
        samples: document.getElementById('sampleCount').textContent,
        updated: document.getElementById('snapshotUpdated').textContent,
        area: document.getElementById('areaFound').textContent,
        source: document.getElementById('srcNote').textContent,
      };
    });
    check(`${tag} valuation: fallback notice and non-appraisal statement precede the estimate`, v.noticeVisible && v.noticeFirst && v.natureFirst, JSON.stringify({ a: v.noticeFirst, b: v.natureFirst }));
    check(`${tag} valuation: no «high» confidence on fallback; real scope, samples and date shown`,
      !/عالية/.test(v.confidence) && v.samples === '49' && /2026-10-20/.test(v.updated) && /مدينة نصر — بديل عن «عباس العقاد»/.test(v.area), v.confidence);
    check(`${tag} valuation: misleading seed note is not displayed`, !/snapshot واحد/.test(v.source));
    const body = JSON.parse(log.valuationBodies[0] || '{}');
    check(`${tag} valuation: request carries property fields only (no price/name/phone)`,
      !('askingPrice' in body) && !('asking' in body) && !('phone' in body) && !('name' in body) && body.area === 'عباس العقاد', Object.keys(body).join(','));
    check(`${tag} valuation: no horizontal overflow`, await noOverflow(page));
    await shot(page, `valuation-${width}`);
    await page.close();
  }

  // ── 4) Property page + 404 ──
  {
    const { page } = await openPage(width, height);
    await page.goto(`${BASE}${catalog[0].u}`, { waitUntil: 'domcontentloaded' });
    const p = await page.evaluate(() => ({
      status: document.querySelector('.pp-availability-status')?.textContent || '',
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(''),
    }));
    check(`${tag} property: availability «needs confirmation», no InStock`, /يحتاج إلى تأكيد/.test(p.status) && !/InStock/.test(p.ld));
    check(`${tag} property: no horizontal overflow`, await noOverflow(page));
    const r = await page.goto(`${BASE}/properties/nonexistent-synthetic-e2e/`, { waitUntil: 'domcontentloaded' });
    check(`${tag} 404: unknown slug returns 404 without a property layout`, r.status() === 404 && !(await page.$('#ppWaBtn')));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed.`);
process.exit(failed.length ? 1 : 0);
