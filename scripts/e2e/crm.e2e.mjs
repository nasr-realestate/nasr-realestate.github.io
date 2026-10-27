#!/usr/bin/env node
/**
 * Browser acceptance test for «دفتر العملاء» (/crm.html) — 2026-10-27.
 * Optional — not part of `npm test` (CI installs no browser). Arabic RTL at 390 and 320 px.
 *
 *   BASE=http://127.0.0.1:3000 CHROME_BIN=/path/to/chromium \
 *   NODE_PATH=/path/with/puppeteer-core/node_modules node scripts/e2e/crm.e2e.mjs
 *
 * Optional: CHROME_ARGS_JSON='["--no-sandbox", ...]', SCREENSHOT_DIR=/tmp/shots.
 *
 * Data: 100% synthetic (fake names and numbers generated below) — never real contacts.
 * Safety: every request that is not BASE is aborted and recorded (the page must make none).
 * WhatsApp/tel links are inspected, never opened; window.open is stubbed and must stay unused.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const searchPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
const puppeteer = require(require.resolve('puppeteer-core', { paths: [...searchPaths, process.cwd()] }));
let axeSource = '';
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [...searchPaths, process.cwd()] }), 'utf8'); } catch { /* optional */ }

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME_BIN;
const ARGS = JSON.parse(process.env.CHROME_ARGS_JSON || '["--no-sandbox"]');
const SHOTS = process.env.SCREENSHOT_DIR || '';
if (!CHROME) { console.error('CHROME_BIN is required'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ───────── synthetic files ─────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-e2e-'));
const DL = path.join(TMP, 'downloads');
fs.mkdirSync(DL);
const n = (i) => '0100000' + String(1000 + i);        // 0100000100x — fake
const contactsTxt = [
  '                               Contact Directory', '',
  'حاج سمير مالك شقة 180م مكرم', '', `   Phone (Mobile): ${n(1)}`, '',
  'مدام هدى طالبة شقة مفروشة للإيجار', '', `   Phone (Mobile): ${n(2)}`, '',
  'كريم مشتري شقة جرين هيلز', '', `   Phone (Mobile): ${n(3)}`, '',
  'عم سيد بواب العمارة', '', `   Phone (Mobile): ${n(4)}`, '   حارس', '',
  'أبو علي سمسار الحي العاشر', '', `   Phone (Mobile): ${n(5)}`, '',
  'قريب العيلة', '', `   Phone (Mobile): ${n(6)}`, '',
  'مطلوب مقر إداري مكرم', '', '   No contact details provided.', '',
  '<img src=x onerror=alert(1)> مالك محل', '', `   Phone (Mobile): ${n(7)}`, '',
  'شقة 150م الحي السابع', '', `   Phone (Mobile): ${n(8)}`, '',
].join('\n');
const txtPath = path.join(TMP, 'contacts.txt');
fs.writeFileSync(txtPath, contactsTxt);
const now = Date.now();
const callsXml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><calls count="4">
<call number="${n(2)}" duration="40" date="${now - 86400000}" type="1" contact_name="مدام هدى" />
<call number="01111009999" duration="20" date="${now - 2 * 86400000}" type="1" contact_name="(Unknown)" />
<call number="01111009999" duration="0" date="${now - 3 * 86400000}" type="3" contact_name="(Unknown)" />
<call number="${n(1)}" duration="15" date="${now - 5 * 86400000}" type="2" contact_name="حاج سمير" />
</calls>`;
const xmlPath = path.join(TMP, 'calls.xml');
fs.writeFileSync(xmlPath, callsXml);

const browser = await puppeteer.launch({ executablePath: CHROME, args: ARGS, headless: 'shell' });
const foreign = [];
const pageErrors = [];
try {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) r.continue();
    else { foreign.push(u); r.abort(); }
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) pageErrors.push('console: ' + m.text()); });
  let alerts = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'alert') { alerts++; await d.dismiss(); return; }
    if (d.type() === 'prompt') await d.accept('امسح'); else await d.accept();
  });
  await page.evaluateOnNewDocument(() => { window.__opened = 0; window.open = () => { window.__opened++; return null; }; });

  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
  const text = (sel) => page.$eval(sel, (e) => e.textContent);
  const visible = (sel) => page.$eval(sel, (e) => !e.closest('[hidden]') && e.getClientRects().length > 0).catch(() => false);
  const clickText = async (sel, label) => {
    const ok = await page.evaluate((s, l) => {
      const b = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(l) && x.getClientRects().length);
      if (b) b.click();
      return Boolean(b);
    }, sel, label);
    if (!ok) throw new Error(`لم أجد «${label}» في ${sel}`);
  };
  const settle = () => new Promise((r) => setTimeout(r, 250));

  // 1) أول مرة: تبويب البيانات + الخصوصية
  await page.goto(BASE + '/crm.html', { waitUntil: 'networkidle0' });
  check('أول فتح: تبويب «البيانات» ظاهر', await visible('#tab-data'));
  check('شرح الخصوصية ظاهر (على جهازك بس)', /على الجهاز ده بس/.test(await text('.privacy')));
  check('robots noindex في الصفحة', await page.$eval('meta[name="robots"]', (m) => m.content.includes('noindex')));
  await shot('01-data-first-run');

  // 2) استيراد ملف txt
  await (await page.$('#dImport')).uploadFile(txtPath);
  await page.waitForFunction(() => /اتحفظ على جهازك/.test(document.getElementById('dResult').textContent), { timeout: 8000 });
  const res = await text('#dResult');
  check('ملخص الاستيراد: 9 اتقروا و9 اتضافوا', /اتقرا 9/.test(res) && /اتضاف 9/.test(res), res.replace(/\s+/g, ' ').slice(0, 120));
  check('تذكير النسخة الاحتياطية بعد الاستيراد', await visible('#notice'));
  const stored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('simsar_crm_v1')).contacts).length);
  check('الدفتر محفوظ في localStorage على الجهاز', stored === 9, String(stored));
  check('XSS: الاسم المستورد ما اتنفذش كـHTML', alerts === 0 && (await page.$$('img[src="x"]')).length === 0);

  // 3) الطابور
  await clickText('.tabs button', 'التأكيد');
  await page.waitForSelector('#qCard h2');
  await settle();
  const first = await text('#qName');
  check('أول جهة في الطابور = مالك', /مالك/.test(first), first);
  const wa = await page.$eval('#qCard a.btn.wa', (a) => a.href);
  const tel = await page.$eval('#qCard a.btn.primary', (a) => a.href);
  check('زر واتساب = رابط wa.me برقم دولي ونص جاهز', /^https:\/\/wa\.me\/2010000010\d\d\?text=/.test(wa), wa.slice(0, 60));
  check('النص يبدأ بالتحية والتوقيع', decodeURIComponent(wa.split('text=')[1] || '').includes('معاك طارق طنطاوي من «سمسار طلبك»'));
  check('زر الاتصال tel:+20…', /^tel:\+2010000010\d\d$/.test(tel), tel);
  await shot('02-queue-owner');
  const before = await page.evaluate(() => document.querySelectorAll('#qStats b')[2].textContent);
  await clickText('#qCard .q-out button', 'لسه متاح');
  await settle();
  const after = await page.evaluate(() => document.querySelectorAll('#qStats b')[2].textContent);
  check('«لسه متاح» يسجّل ويطلّع الجهة من الطابور', Number(after) === Number(before) - 1 && (await text('#qName')) !== first, `${before}→${after}`);
  check('عداد النهارده = 1', (await page.evaluate(() => document.querySelectorAll('#qStats b')[0].textContent)) === '1');
  // تراجع
  const second = await text('#qName');
  await clickText('#qCard .q-out button', 'مردّش');
  await settle();
  await clickText('#toast button', 'تراجع');
  await settle();
  check('«تراجع» يرجّع آخر نتيجة', (await text('#qName')) === second, second);

  // 4) طالب يناسبه إعلان + الموافقة
  await clickText('#qFilter button', 'طالبين');
  await settle();
  let found = false;
  for (let i = 0; i < 4 && !found; i++) {
    found = await page.$('#qCard .box a[href^="/properties/"]') !== null;
    if (!found) { await clickText('#qCard .q-more button', 'تخطي'); await settle(); }
  }
  check('طالب يظهر معاه إعلانات مطابقة من الموقع', found);
  if (found) {
    const offer = await page.$eval('#qCard .box a.btn.wa', (a) => decodeURIComponent(a.href));
    check('زر «ابعت العرض» فيه رابط الإعلان', /\/properties\//.test(offer));
    await shot('03-queue-seeker-match');
  }
  await clickText('#qCard .box button', 'آه، وافق');
  await settle();
  check('الموافقة على العروض تتسجل وتظهر', /موافق على العروض/.test(await text('#qCard .chips')));

  // 5) تعديل
  await clickText('#qCard .q-more button', 'تعديل');
  await page.waitForSelector('#editor[open]');
  await page.$eval('#e_zones', (i) => { i.value = 'الحي العاشر'; });
  await page.$eval('#e_notes', (i) => { i.value = 'ملاحظة اختبار'; });
  await clickText('#editor button', 'حفظ');
  await settle();
  check('حفظ التعديل يقفل النافذة', !(await page.$('#editor[open]')));
  const edited = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('simsar_crm_v1')).contacts).find((c) => c.notes === 'ملاحظة اختبار'));
  check('التعديل اليدوي اتحفظ ومتعلّم manual', edited && edited.zones[0] === 'الحي العاشر' && edited.manual && edited.manual.zones === true);

  // 6) جهاتي + بحث
  await page.reload({ waitUntil: 'networkidle0' });
  check('بعد إعادة التحميل البيانات لسه موجودة', /1/.test(await page.evaluate(() => document.querySelectorAll('#qStats b')[0].textContent)));
  await clickText('.tabs button', 'جهاتي');
  await page.type('#lSearch', 'بواب');
  await new Promise((r) => setTimeout(r, 400));
  check('البحث يلاقي البواب', /1 جهة/.test(await text('#lCount')) && /بواب/.test(await text('#lItems')));
  const xssItem = await page.evaluate(() => [...document.querySelectorAll('#lItems .t')].map((e) => e.textContent));
  await page.$eval('#lSearch', (i) => { i.value = ''; i.dispatchEvent(new Event('input')); });
  await new Promise((r) => setTimeout(r, 400));
  const allNames = await page.evaluate(() => [...document.querySelectorAll('#lItems .t')].map((e) => e.textContent).join('|'));
  check('الاسم الخبيث معروض كنص', allNames.includes('<img src=x onerror=alert(1)>') && alerts === 0, xssItem.join(','));
  await shot('04-list');

  // 7) إضافة سريعة + منع التكرار
  await clickText('.tabs button', 'إضافة');
  await page.type('#aPaste', 'أستاذ رامي 0100 000 2001 عايز شقة إيجار في الحي العاشر لحد 15 ألف');
  await clickText('#tab-add button', 'افهم الرسالة');
  await settle();
  const filled = await page.evaluate(() => ({ role: document.getElementById('a_role').value, deal: document.getElementById('a_deal').value,
    zones: document.getElementById('a_zones').value, price: document.getElementById('a_price').value, phones: document.getElementById('a_phones').value }));
  check('«افهم الرسالة» يملا الدور والمعاملة والمنطقة والميزانية والرقم',
    filled.role === 'seeker' && filled.deal === 'rent' && /الحي العاشر/.test(filled.zones) && filled.price === '15000' && /0100 000 2001/.test(filled.phones), JSON.stringify(filled));
  await page.$eval('#a_name', (i) => { i.value = 'أستاذ رامي'; });
  await clickText('#aForm button', 'حفظ');
  await settle();
  check('الإضافة تتحفظ', /اتضافت/.test(await text('#toast')));
  await page.type('#aPaste', 'رامي تاني 01000002001 بقى عايز مفروش');
  await clickText('#tab-add button', 'افهم الرسالة');
  await settle();
  await page.$eval('#a_name', (i) => { i.value = 'رامي'; });
  await clickText('#aForm button', 'حفظ');
  await settle();
  check('نفس الرقم = تحديث مش تكرار', /اتحدّثت الجهة الموجودة/.test(await text('#toast')));
  await shot('05-add');

  // 8) الإعلانات + تقرير التأكيد
  await clickText('.tabs button', 'الإعلانات');
  await page.waitForFunction(() => document.querySelectorAll('#rItems > li').length > 0, { timeout: 8000 });
  const rows = await page.$$eval('#rItems > li', (l) => l.length);
  check('إعلانات الموقع اتحمّلت للمطابقة', rows > 10, String(rows));
  await clickText('#tab-listings button', 'انسخ تقرير');
  await settle();
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check('تقرير التأكيد اتنسخ', /تقرير تأكيد إعلانات/.test(clip) || /اتنسخ التقرير/.test(await text('#toast')));
  await shot('06-listings');

  // 9) سجل المكالمات + نسخة احتياطية + CSV
  await clickText('.tabs button', 'البيانات');
  await (await page.$('#dImport')).uploadFile(xmlPath);
  await page.waitForFunction(() => /مكالمة/.test(document.getElementById('dResult').textContent), { timeout: 8000 });
  check('سجل المكالمات: رقم متكرر مش متسجل ظهر', await visible('#dUnsavedCard') && /0111 100 9999/.test(await text('#dUnsaved')));
  await clickText('.tabs button', 'التأكيد');
  await clickText('#qFilter button', 'اتكلمتوا قريب');
  await settle();
  check('فلتر «اتكلمتوا قريب»: الأحدث مكالمة الأول', /مدام هدى/.test(await text('#qName')), await text('#qName'));
  await clickText('#qFilter button', 'الكل');
  await clickText('.tabs button', 'البيانات');
  await clickText('#tab-data button', 'نسخة احتياطية (JSON)');
  await clickText('#tab-data button', 'تصدير لـ Excel');
  await new Promise((r) => setTimeout(r, 1500));
  const files = fs.readdirSync(DL);
  const json = files.find((f) => f.endsWith('.json'));
  const csv = files.find((f) => f.endsWith('.csv'));
  let backupOk = false;
  if (json) { const b = JSON.parse(fs.readFileSync(path.join(DL, json), 'utf8')); backupOk = b.app === 'simsar-crm' && Object.keys(b.db.contacts).length === 10; }
  check('النسخة الاحتياطية نزلت وفيها كل الجهات', backupOk, files.join(','));
  check('ملف CSV نزل بـBOM للعربي', Boolean(csv) && fs.readFileSync(path.join(DL, csv), 'utf8').startsWith('\uFEFFالاسم'));
  check('بعد النسخة: «آخر نسخة احتياطية» اتسجلت', /آخر نسخة احتياطية/.test(await text('#dBackupInfo')));
  await shot('07-data');

  // 10) 320px بلا تمرير أفقي
  await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
  for (const tab of ['التأكيد', 'جهاتي', 'إضافة', 'الإعلانات', 'البيانات']) {
    await clickText('.tabs button', tab);
    await settle();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`320px «${tab}»: بلا تمرير أفقي`, overflow <= 1, String(overflow));
  }
  await clickText('.tabs button', 'التأكيد');
  await shot('08-queue-320');

  // 11) axe (اختياري)
  if (axeSource) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); // قياس الألوان بعد الحركة
    await clickText('.tabs button', 'التأكيد');
    await settle();
    // CSP الصفحة تمنع أي سكربت مضمَّن (وده المطلوب) — axe يتحقن عبر DevTools (Runtime.evaluate).
    await page.evaluate(axeSource);
    const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
      .filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => x.id + ':' + x.nodes.map((nd) => nd.target.join(' ') + ' ' + ((nd.any[0] || {}).message || '').slice(0, 120)).join(' ; ')));
    check('axe: بلا مخالفات serious/critical', v.length === 0, v.join(' '));
  }

  // 12) مسح
  await clickText('.tabs button', 'البيانات');
  await clickText('#tab-data button', 'امسح الدفتر');
  await settle();
  check('المسح يفضّي الدفتر بعد كتابة «امسح»', await page.evaluate(() => localStorage.getItem('simsar_crm_v1') === null));

  check('ولا طلب لأي أصل خارجي', foreign.length === 0, foreign.slice(0, 3).join(' '));
  check('window.open ما اتنداش', (await page.evaluate(() => window.__opened)) === 0);
  check('بلا أخطاء JavaScript', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('تنفيذ السيناريو', false, String(e && e.stack || e).slice(0, 400));
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
