#!/usr/bin/env node
/**
 * Browser acceptance test for the Gemini-first agent page (2026-10-27).
 * Optional — not part of `npm test` (CI installs no browser). Arabic RTL at 320, 390 and 1440 px.
 *
 *   BASE=http://127.0.0.1:3000 CHROME_BIN=/path/to/chromium \
 *   NODE_PATH=/path/with/puppeteer-core/node_modules node scripts/e2e/gemini-agent.e2e.mjs
 *
 * Optional: CHROME_ARGS_JSON='["--no-sandbox", ...]', SCREENSHOT_DIR=/tmp/shots.
 *
 * How it works: the page's POST /chat is intercepted and answered by the REAL agent Worker module
 * (_worker/worker.js) running here in Node. Inside that Worker, Gemini is a scripted MOCK and
 * ai-feed.json is the repository's real feed. So this proves the page ⇄ Worker contract, rendering,
 * grounding and layout — it does NOT prove anything about live Gemini quality or availability.
 *
 * Safety: every other non-BASE request is aborted and recorded. Nothing is submitted, uploaded,
 * stored on a server or sent to WhatsApp; window.open is stubbed and must never be called.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const searchPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
const puppeteer = require(require.resolve('puppeteer-core', { paths: [...searchPaths, process.cwd()] }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME_BIN;
const ARGS = JSON.parse(process.env.CHROME_ARGS_JSON || '["--no-sandbox"]');
const SHOTS = process.env.SCREENSHOT_DIR || '';
const CHAT_URL = 'https://royal-snow-ea32.footcai-555.workers.dev/chat';
const VIEWPORTS = [[320, 640], [390, 844], [1440, 900]];
if (!CHROME) { console.error('CHROME_BIN is required'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  const suffix = detail ? ' — ' + detail : '';
  console.log(`${ok ? '✔' : '✘'} ${name}${suffix}`);
}

// ───────── the real Worker, with Gemini mocked and the real feed ─────────
const feedText = fs.readFileSync(path.join(ROOT, 'ai-feed.json'), 'utf8');
const realFetch = globalThis.fetch;
let geminiDown = false;
let geminiCalls = 0;
const SCRIPT = [
  [/أشتري شقة 180 متر/, { intent: 'search_buy', patch: { role: 'seeker', operation: 'buy', property_type: 'apartment', location: 'مدينة نصر', area_value: 180, price_value: 7000000, price_mode: 'max', rooms: 3 }, reply: 'تمام، دي النتائج المطابقة من الموقع تحت. تحب نضيّقها بحتة معينة في مدينة نصر؟' }],
  [/غيّر الميزانية فقط/, { intent: 'update_details', patch: { price_value: 6000000 }, reply: 'تمام، غيّرت الميزانية إلى 6 ملايين، وباقي المواصفات زي ما هي.' }],
  [/عندي شقة للبيع، 180 متر/, { intent: 'offer_sell', patch: { role: 'owner', operation: 'sell', property_type: 'apartment', area_value: 180, price_value: 8000000 }, reply: 'تمام، شقة 180 متر وطالب فيها 8 ملايين. الشقة في أنهي منطقة أو شارع في مدينة نصر؟' }],
  [/في عباس العقاد/, { intent: 'update_details', patch: { location: 'عباس العقاد' }, reply: 'حلو. المقارنة الاسترشادية تحت من الإعلانات المنشورة. فيها كام أوضة؟ (اختياري)' }],
  [/عايز شقة إيجار/, { intent: 'search_rent', patch: { role: 'seeker', operation: 'rent', property_type: 'apartment' }, reply: 'تمام! تحب تكون في أنهي حتة في مدينة نصر؟' }],
];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('ai-feed.json')) return new Response(feedText, { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('generativelanguage.googleapis.com')) {
    geminiCalls += 1;
    if (geminiDown) return new Response('{}', { status: 500 });
    const body = JSON.parse(init.body);
    const last = body.contents.at(-1).parts[0].text.split('\n').at(-1);
    const hit = SCRIPT.find(([re]) => re.test(last));
    const json = hit ? { needs_clarification: false, ...hit[1] } : { intent: 'unclear', needs_clarification: false, reply: 'تمام، قولّي أكتر.' };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected Worker fetch: ${url}`);
};
const { default: agentWorker } = await import(path.join(ROOT, '_worker/worker.js'));
const workerEnv = { GEMINI_API_KEY: 'e2e-mock-key', ALLOWED_ORIGINS: BASE };
let ipSeq = 0;

const catalog = JSON.parse(await (await realFetch(`${BASE}/assets/data/catalog.json`)).text());
const catalogUrls = new Set(catalog.map((r) => r.u));
const browser = await puppeteer.launch({ executablePath: CHROME, args: ARGS, headless: 'shell' });

async function openPage(width, height, { consent = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument((withConsent) => {
    window.__opened = [];
    window.open = (...a) => { window.__opened.push(a.map(String)); return null; };
    try { if (withConsent) localStorage.setItem('simsar_gemini_consent_v1', 'gemini-v1'); else localStorage.removeItem('simsar_gemini_consent_v1'); } catch {}
  }, consent);
  const log = { external: [], chatPosts: [], otherPosts: [], errors: [] };
  // الطلبات الخارجية المحظورة على صفحة المساعد: أي Worker/رفع/واتساب/Gemini مباشر (تحليلات القالب GTM GET مستثناة — مش من السكربت)
  log.forbidden = () => log.external.filter((u) => /workers\.dev|imgbb|wa\.me|whatsapp|generativelanguage/.test(u));
  page.on('pageerror', (e) => log.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (url === CHAT_URL) {
      const cors = { 'access-control-allow-origin': BASE, 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'Content-Type' };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      log.chatPosts.push(JSON.parse(req.postData() || '{}'));
      const res = await agentWorker.fetch(new Request('https://agent.test/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': `e2e-${++ipSeq}` }, body: req.postData(),
      }), workerEnv);
      return req.respond({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') log.otherPosts.push(`${req.method()} ${url}`);
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return req.continue();
    log.external.push(url);
    return req.abort();
  });
  return { page, log };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1
  && [...document.querySelectorAll('#app *')].every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.right <= window.innerWidth + 1 && r.left >= -1) || getComputedStyle(el).position === 'fixed' || el.closest('.action-rail-scroll, .gallery-overlay, .menu-glass'); }));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 72 }); };
async function typeAndSend(page, text) {
  await page.click('#msgInput');
  await page.$eval('#msgInput', (el) => { el.value = ''; });
  await page.type('#msgInput', text);
  await page.click('#sendBtn');
}
async function waitForAi(page, count) {
  await page.waitForFunction((c) => document.querySelectorAll('#chatArea .msg-ai').length > c, { timeout: 15000 }, count);
  await page.waitForFunction(() => !document.getElementById('typingBubble').classList.contains('active'), { timeout: 15000 });
}
const aiCount = (page) => page.$$eval('#chatArea .msg-ai', (n) => n.length);

for (const [width, height] of VIEWPORTS) {
  const tag = `${width}px`;

  // ── 1) start + consent + seeker journey + budget-only change + editable summary ──
  {
    const { page, log } = await openPage(width, height);
    await page.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    const boot = await page.evaluate(() => ({
      welcome: document.querySelector('#chatArea .msg-bot')?.textContent || '',
      chips: [...document.querySelectorAll('#actionRail .chip')].map((c) => c.textContent),
      overlay: document.getElementById('privacyOverlay').classList.contains('show'),
      dir: getComputedStyle(document.getElementById('app')).direction,
      status: document.getElementById('statusText').textContent,
      localBar: getComputedStyle(document.getElementById('requestModeBar')).display,
      inputH: document.getElementById('msgInput').getBoundingClientRect().height,
    }));
    check(`${tag} start: one welcome, three optional chips, free typing, Gemini mode, RTL`,
      /أهلًا! بتدور على عقار، عندك عقار للبيع أو الإيجار، ولا عندك سؤال؟ اكتب براحتك/.test(boot.welcome)
      && boot.chips.join('|') === 'أبحث عن عقار|أعرض عقاري|عندي سؤال' && !boot.overlay && boot.dir === 'rtl'
      && boot.status === 'مساعد ذكي بـGemini • جاهز' && boot.localBar === 'none' && boot.inputH >= 40, JSON.stringify({ chips: boot.chips.length, status: boot.status }));
    check(`${tag} start: no horizontal overflow`, await noOverflow(page));
    await shot(page, `start-${width}`);

    await typeAndSend(page, 'أنا عايز أشتري شقة 180 متر في مدينة نصر، 3 غرف، بحد أقصى 7 ملايين.');
    await page.waitForFunction(() => document.getElementById('privacyOverlay').classList.contains('show'), { timeout: 5000 });
    const consent = await page.evaluate(() => ({
      text: document.querySelector('.privacy-sheet').textContent,
      buttons: [...document.querySelectorAll('.privacy-sheet button, .privacy-sheet a.privacy-alt')].map((b) => b.textContent.trim()),
    }));
    check(`${tag} consent: shown before the first Gemini message, nothing sent yet, three real choices`,
      log.chatPosts.length === 0 && /آخر 10 رسائل/.test(consent.text) && /مدة احتفاظ Google ببيانات الطلبات مش مضمونة/.test(consent.text)
      && consent.buttons.some((b) => /موافق — ابعت لـGemini/.test(b)) && consent.buttons.some((b) => /ابحث محليًا بدون ذكاء اصطناعي/.test(b)) && consent.buttons.some((b) => /واتساب/.test(b)),
      consent.buttons.join(' | '));
    await new Promise((r) => setTimeout(r, 700)); // نهاية حركة ظهور الشيت (translateY 0.4s)
    check(`${tag} consent: the whole sheet fits inside the viewport (scrolls if taller)`, await page.evaluate(() => {
      const el = document.querySelector('.privacy-sheet'); const r = el.getBoundingClientRect();
      return r.width <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1;
    }));
    await shot(page, `consent-${width}`);
    await page.click('#consentAccept');
    await waitForAi(page, 0);
    const turn1 = await page.evaluate(() => ({
      ai: [...document.querySelectorAll('#chatArea .msg-ai')].at(-1).textContent,
      data: [...document.querySelectorAll('#chatArea .msg-data')].at(-1)?.textContent || '',
      links: [...document.querySelectorAll('#chatArea .msg-data a.result-link')].map((a) => new URL(a.href).pathname),
      summary: document.getElementById('summaryLine').textContent,
      summaryVisible: !document.getElementById('summaryBar').hidden,
    }));
    check(`${tag} turn 1: Gemini reply is labelled, results are a separate site-data panel`, /Gemini/.test(turn1.ai) && /من بيانات الموقع — مش من Gemini/.test(turn1.data), turn1.ai.slice(0, 60));
    check(`${tag} turn 1: every card links to a real Nasr City catalog record`, turn1.links.length > 0 && turn1.links.every((u) => catalogUrls.has(u)), `${turn1.links.length} cards`);
    check(`${tag} turn 1: availability is «needs owner confirmation» on every card`, (turn1.data.match(/التوافر يحتاج تأكيد من المالك/g) || []).length === turn1.links.length);
    check(`${tag} turn 1: compact summary «شراء · … · حتى 7 ملايين · 180م»`, turn1.summaryVisible && turn1.summary === 'شراء · شقة · مدينة نصر · حتى 7 ملايين · 180م · 3 غرف أو أكثر', turn1.summary);
    check(`${tag} turn 1: request carried consent, no history yet`, log.chatPosts[0]?.consent === 'gemini-v1' && Array.isArray(log.chatPosts[0]?.history) && log.chatPosts[0].history.length === 0);
    check(`${tag} turn 1: no horizontal overflow with cards`, await noOverflow(page));
    await shot(page, `results-${width}`);

    const before = await aiCount(page);
    await typeAndSend(page, 'غيّر الميزانية فقط إلى 6 ملايين.');
    await waitForAi(page, before);
    const turn2 = await page.evaluate(() => ({
      change: [...document.querySelectorAll('#chatArea .msg-data .is-change')].at(-1)?.textContent || '',
      summary: document.getElementById('summaryLine').textContent,
    }));
    check(`${tag} turn 2: only the budget changed, and the change is shown`, /الميزانية: حتى 6 ملايين — وباقي المواصفات زي ما هي/.test(turn2.change)
      && turn2.summary === 'شراء · شقة · مدينة نصر · حتى 6 ملايين · 180م · 3 غرف أو أكثر', turn2.summary);
    check(`${tag} turn 2: the state and bounded history travel with the message`, log.chatPosts[1]?.state?.price?.value === 7000000 && log.chatPosts[1].history.length === 2);
    await page.click('#summaryBtn');
    const panel = await page.evaluate(() => ({ open: !document.getElementById('summaryPanel').hidden, chips: document.querySelectorAll('#summaryChips .sum-chip').length, hint: document.getElementById('summaryHint').textContent }));
    check(`${tag} summary: expands into editable chips and never claims a saved request`, panel.open && panel.chips >= 5 && /مش طلب متسجل ومفيش حاجة اتبعتت/.test(panel.hint));
    check(`${tag} summary: no horizontal overflow when expanded`, await noOverflow(page));
    await shot(page, `summary-${width}`);
    check(`${tag} journey 1: only POST /chat — no other POST, no Worker/upload/WhatsApp request`, log.otherPosts.length === 0 && log.forbidden().length === 0, [...log.otherPosts, ...log.forbidden()].join(' | '));
    check(`${tag} journey 1: nothing opened automatically`, (await page.evaluate(() => window.__opened.length)) === 0);
    check(`${tag} journey 1: no page errors`, log.errors.length === 0, log.errors.join(' | '));
    check(`${tag} journey 1: nothing about the chat in storage`, await page.evaluate(() => sessionStorage.length === 0 && Object.keys(localStorage).every((k) => k === 'simsar_gemini_consent_v1')));
    await page.close();
  }

  // ── 2) owner: price not re-asked, comparison with count/date/caveat, explicit WhatsApp + 💎 ──
  {
    const { page, log } = await openPage(width, height, { consent: true });
    await page.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    await typeAndSend(page, 'عندي شقة للبيع، 180 متر، وأطلب 8 ملايين.');
    await waitForAi(page, 0);
    const ask = await page.evaluate(() => [...document.querySelectorAll('#chatArea .msg-ai')].at(-1).textContent);
    check(`${tag} owner: the price is not asked again; the next question is the location`, /في أنهي منطقة/.test(ask) && !/طالب فيها كام|السعر كام/.test(ask), ask.slice(0, 70));
    await typeAndSend(page, 'في عباس العقاد');
    await waitForAi(page, 1);
    const owner = await page.evaluate(() => ({
      data: [...document.querySelectorAll('#chatArea .msg-data')].at(-1)?.textContent || '',
      wa: document.getElementById('waWrapper').classList.contains('show') ? decodeURIComponent(document.getElementById('waBtn').href) : '',
      gem: document.querySelector('#valuationSlot .valuation-link')?.getAttribute('href') || '',
    }));
    const cmpOk = /مقارنة استرشادية/.test(owner.data) ? /(إعلان واحد|إعلانين|إعلانات|إعلانًا) منشورة/.test(owner.data) && /البيانات بتاريخ \d{4}-\d{2}-\d{2}/.test(owner.data) && /مش أسعار صفقات مكتملة ولا تقييم مهني/.test(owner.data)
      : /مش كفاية لمقارنة موثوقة/.test(owner.data);
    check(`${tag} owner: comparison shows count, data date and the «asking prices, not deals or appraisal» caveat (or says data is insufficient)`, cmpOk, (owner.data.match(/📊[^\n]{0,90}/) || [''])[0]);
    check(`${tag} owner: WhatsApp is an explicit link with the summary; 💎 links to the tool`, /^https:\/\/wa\.me\/201147758857\?text=/.test(owner.wa) && /عندي عقار: بيع · شقة · عباس العقاد · مطلوب 8 ملايين · 180م/.test(owner.wa) && /^\/tools\/valuation\.html\?from=agent&journey=seller/.test(owner.gem), owner.gem);
    check(`${tag} owner: nothing opened, nothing posted except /chat`, (await page.evaluate(() => window.__opened.length)) === 0 && log.otherPosts.length === 0 && log.forbidden().length === 0);
    check(`${tag} owner: no horizontal overflow`, await noOverflow(page));
    await shot(page, `owner-${width}`);
    await page.close();
  }

  // ── 3) outage: clear error + retry + explicit local search; typing never stuck ──
  {
    const { page, log } = await openPage(width, height, { consent: true });
    await page.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    geminiDown = true;
    await typeAndSend(page, 'عايز شقة إيجار');
    await page.waitForFunction(() => document.querySelector('#chatArea .msg-error'), { timeout: 15000 });
    const err = await page.evaluate(() => ({
      text: document.querySelector('#chatArea .msg-error').textContent,
      typing: document.getElementById('typingBubble').classList.contains('active'),
      ai: document.querySelectorAll('#chatArea .msg-ai').length,
      input: document.getElementById('msgInput').value,
      local: document.getElementById('localRequestMode').checked,
    }));
    check(`${tag} outage: explicit message with retry and an optional local search, no invented reply, typing cleared`,
      /مساعد Gemini متوقف مؤقتًا/.test(err.text) && /جرّب تاني/.test(err.text) && /ابحث محليًا بدون ذكاء اصطناعي/.test(err.text) && !err.typing && err.ai === 0 && err.input === 'عايز شقة إيجار' && !err.local, JSON.stringify(err).slice(0, 120));
    check(`${tag} outage: no horizontal overflow`, await noOverflow(page));
    await shot(page, `error-${width}`);
    geminiDown = false;
    await page.click('#chatArea .msg-error .retry-btn');
    await waitForAi(page, 0);
    check(`${tag} outage: retry resends the same text and recovers`, log.chatPosts.at(-1).message === 'عايز شقة إيجار' && (await aiCount(page)) === 1);
    geminiDown = true;
    const errorsBefore = await page.$$eval('#chatArea .msg-error', (n) => n.length);
    await typeAndSend(page, 'في مكرم عبيد');
    await page.waitForFunction((c) => document.querySelectorAll('#chatArea .msg-error').length > c && !document.getElementById('typingBubble').classList.contains('active'), { timeout: 15000 }, errorsBefore);
    const postsBefore = log.chatPosts.length;
    await page.evaluate(() => [...document.querySelectorAll('#chatArea .msg-error .local-btn')].at(-1).click());
    await page.waitForFunction(() => document.getElementById('localRequestMode').checked, { timeout: 5000 });
    await page.waitForFunction(() => /بحث محلي في كتالوج الموقع/.test(document.getElementById('chatArea').textContent), { timeout: 5000 });
    const local = await page.evaluate(() => ({ bar: getComputedStyle(document.getElementById('requestModeBar')).display, status: document.getElementById('statusText').textContent }));
    check(`${tag} local search: only after the visitor chose it, announced, and without /chat`, local.bar !== 'none' && local.status === 'بحث محلي • بدون ذكاء اصطناعي' && log.chatPosts.length === postsBefore, JSON.stringify(local));
    geminiDown = false;
    check(`${tag} outage journey: no page errors`, log.errors.length === 0, log.errors.join(' | '));
    await page.close();
  }
}

await browser.close();
globalThis.fetch = realFetch;
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed (Gemini mocked in-process; ${geminiCalls} mock Gemini calls).`);
process.exit(failed.length ? 1 : 0);
