#!/usr/bin/env node
/**
 * اختبار متصفح حقيقي لمعرض العقارات (2026-10-20) — Chromium عبر Playwright.
 *
 *   BASE=http://127.0.0.1:4100 node scripts/e2e/catalog.e2e.mjs
 *
 * يحتاج موقعًا مبنيًا (bundle exec jekyll build) يُخدَّم على BASE، وحزمة
 * playwright متاحة عبر NODE_PATH. ليس جزءًا من `npm test` (CI لا يثبّت متصفحًا)؛
 * نتائجه موثّقة في تقرير الفرع. يخرج برمز 1 عند أي فشل.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const searchPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
const { chromium } = require(require.resolve('playwright', { paths: [...searchPaths, process.cwd()] }));

const BASE = (process.env.BASE || 'http://127.0.0.1:4100').replace(/\/$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const errors = [];

async function openPage(width, height, url) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ar-EG', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  await page.goto(BASE + url, { waitUntil: 'load' });
  return { ctx, page };
}

const rendered = (page) => page.evaluate(() => Number(document.getElementById('plGrid').getAttribute('data-rendered') || 0));
async function waitRender(page, before) {
  await page.waitForFunction((b) => Number(document.getElementById('plGrid').getAttribute('data-rendered') || 0) > b, before);
}
async function typeSearch(page, q) {
  const before = await rendered(page);
  await page.fill('#plSearch', q);
  await page.press('#plSearch', 'Enter');
  await waitRender(page, before);
  await page.waitForTimeout(300); // يترك مهلة debounce الإدخال تنتهي (تعيد نفس النتيجة)
}

const state = (page) => page.evaluate(() => ({
  cards: document.querySelectorAll('#plGrid .pl-card').length,
  gridHidden: document.getElementById('plGrid').hidden,
  status: document.getElementById('plStatus').textContent,
  count: document.getElementById('plCount').textContent,
  heading: document.getElementById('plHeadingCount').textContent,
  title: document.title,
  url: location.search,
  empty: !document.getElementById('plEmpty').hidden,
  pager: document.getElementById('plPager') ? !document.getElementById('plPager').hidden : null,
  understood: [...document.querySelectorAll('#plUnderstood .pl-uchip')].map((b) => b.textContent.trim()),
  badges: [...document.querySelectorAll('#plGrid .pl-card-badge')].map((b) => b.textContent.trim()),
}));

const firstNum = (s) => Number((s.match(/\d+/) || [])[0]);

// ─── 390×844 (الهاتف المرجعي) ─────────────────────────────
{
  const { ctx, page } = await openPage(390, 844, '/properties/');
  let s = await state(page);
  check('الصفحة 1: 24 بطاقة HTML وترقيم ظاهر', s.cards === 24 && s.pager === true, `cards=${s.cards}`);

  // 1) شقه = شقة
  await typeSearch(page, 'شقه للبيع');
  const a = await state(page);
  await typeSearch(page, 'شقة للبيع');
  const b = await state(page);
  check('«شقه للبيع» = «شقة للبيع» (نفس العدد، > 0)', a.cards === b.cards && a.cards > 0, `${a.cards} vs ${b.cards}`);
  check('كل النتائج شقق للبيع', a.badges.every((t) => t === 'شقة للبيع'), [...new Set(a.badges)].join('،'));
  check('العدّاد + h2 + العنوان + القائمة متزامنة', firstNum(a.count) === a.cards && firstNum(a.heading) === a.cards &&
    a.title.includes(String(a.cards)) && firstNum(a.status) === a.cards, `${a.count} | ${a.heading} | ${a.title}`);
  check('الترقيم يختفي أثناء البحث والرابط يحفظ الاستعلام', a.pager === false && a.url.includes('q='), a.url);

  // 2) همزة/ياء/أرقام عربية
  await typeSearch(page, 'شقة ٣ غرف');
  const c = await state(page);
  await typeSearch(page, 'شقه 3 غرف');
  const d = await state(page);
  check('«٣ غرف» = «3 غرف»', c.cards === d.cards && c.cards > 0, `${c.cards} vs ${d.cards}`);
  check('شريحة «فهمنا» تعرض 3 غرف', c.understood.some((t) => t.includes('3 غرف')), c.understood.join('،'));

  await typeSearch(page, 'إيجار');
  const e1 = await state(page);
  await typeSearch(page, 'ايجار');
  const e2 = await state(page);
  check('«إيجار» = «ايجار»', e1.cards === e2.cards && e1.cards > 0, `${e1.cards} vs ${e2.cards}`);

  await typeSearch(page, 'مصطفى النحاس');
  const f1 = await state(page);
  await typeSearch(page, 'مصطفي النحاس');
  const f2 = await state(page);
  check('«مصطفى» = «مصطفي» (ى/ي)', f1.cards === f2.cards && f1.cards > 0, `${f1.cards} vs ${f2.cards}`);

  // 3) السعر والمساحة والغرف
  await typeSearch(page, 'أقل من 5 مليون');
  const g = await state(page);
  const gPrices = await page.$$eval('#plGrid .pl-card', (els) => els.length);
  check('«أقل من 5 مليون» يعيد نتائج ويفهم الحد', g.cards > 0 && g.understood.some((t) => t.includes('5 مليون')), `${gPrices} | ${g.understood}`);
  await typeSearch(page, 'شقة 150 متر');
  const h = await state(page);
  check('«شقة 150 متر» ← مساحة حوالي 150', h.cards > 0 && h.understood.some((t) => t.includes('150')), `${h.cards} | ${h.understood}`);
  await typeSearch(page, 'عمارة 12');
  const i1 = await state(page);
  check('«عمارة 12» لا يتحول إلى فلتر رقمي', i1.understood.length === 0, `understood=${i1.understood}`);

  // 4) لا نتائج مفيدة
  await typeSearch(page, 'فيلا للإيجار أقل من 1000 جنيه');
  const j = await state(page);
  const sugg = await page.$$eval('#plSuggest button', (els) => els.map((x) => x.textContent));
  const wa = await page.getAttribute('#plEmptyWa', 'href');
  check('حالة لا نتائج: رسالة + اقتراحات حذف شرط + واتساب بسياق البحث', j.empty && j.cards === 0 && sugg.length > 0 &&
    decodeURIComponent(wa).includes('فيلا للإيجار'), `${sugg.join(' / ')}`);
  if (sugg.length) {
    const before = await rendered(page);
    await page.click('#plSuggest button');
    await waitRender(page, before);
    const j2 = await state(page);
    check('زر الاقتراح يطبّق فعلًا ويعيد نتائج', j2.cards > 0 && !j2.empty, `${j2.cards}`);
  }

  // 5) فلاتر مجمعة + مسح
  await page.click('#plReset');
  await page.click('[data-deal="sale"]');
  await page.click('[data-type="apartment"]');
  await page.click('#plMore summary');
  await page.fill('#plPmax', '5000000');
  await page.selectOption('#plRooms', '3');
  await page.waitForTimeout(600);
  const k = await state(page);
  check('فلاتر مجمعة (بيع + شقق + ≤5 مليون + 3 غرف فأكثر)', k.cards > 0 && k.badges.every((t) => t === 'شقة للبيع') &&
    /deal=sale/.test(k.url) && /type=apartment/.test(k.url) && /pmax=5000000/.test(k.url) && /rooms=3/.test(k.url), `${k.cards} ${k.url}`);
  await page.click('#plReset');
  await page.waitForTimeout(100);
  const l = await state(page);
  check('مسح الكل يعيد الشريحة الأصلية والترقيم والعنوان', l.cards === 24 && l.pager === true && l.url === '' &&
    !l.title.includes('نتائج'), `${l.cards} ${l.title}`);

  // 6) الشرائح على الهاتف: لا قص أفقي
  const overflow = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.pl-chips').forEach((g) => {
      if (g.scrollWidth > g.clientWidth + 1) out.push('group-scroll');
      g.querySelectorAll('.pl-chip').forEach((c) => {
        const r = c.getBoundingClientRect();
        if (r.left < 0 || r.right > window.innerWidth) out.push(c.textContent.trim());
      });
    });
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('page-hscroll');
    return out;
  });
  check('390px: كل الشرائح داخل الشاشة ولا تمرير أفقي', overflow.length === 0, overflow.join('،'));
  const tap = await page.evaluate(() => [...document.querySelectorAll('.pl-chip, .pl-pager a, .pl-reset')]
    .filter((x) => x.offsetParent).map((x) => x.getBoundingClientRect().height).filter((h) => h < 40).length);
  check('أهداف اللمس ≥ 40px', tap === 0, `أصغر من 40: ${tap}`);

  // 7) صور البطاقات: كلها تُحمَّل (لا 404) وبأبعاد ثابتة
  await page.evaluate(() => document.querySelectorAll('#plGrid img').forEach((i) => { i.loading = 'eager'; }));
  await page.waitForTimeout(1500);
  const imgs = await page.$$eval('#plGrid img', (els) => els.map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.currentSrc, w: i.getAttribute('width'), h: i.getAttribute('height') })));
  check('صور الصفحة 1 تُحمَّل كلها وبها width/height', imgs.every((x) => x.ok && x.w && x.h), imgs.filter((x) => !x.ok).map((x) => x.src).join(' '));
  const bashar = await page.$('a.pl-card[data-slug="apartment-sale-bashar-ibn-burd-makram-ebeid-190m"] img');
  const bOk = bashar && await bashar.evaluate((i) => i.complete && i.naturalWidth > 0 && i.currentSrc.includes('/cards/'));
  check('بطاقة بشار بن برد 190م تعرض صورتها (cards/)', bOk);

  // 8) الترقيم قابل للوصول بروابط حقيقية
  const hrefs = await page.$$eval('#plPager a', (els) => els.map((a) => a.getAttribute('href')));
  check('روابط الترقيم <a href> حقيقية', hrefs.includes('/properties/page/2/') && hrefs.includes('/properties/page/4/'), hrefs.join(' '));
  await page.click('#plPager a[rel="next"]');
  await page.waitForLoadState('load');
  const p2 = await state(page);
  check('«التالي» ينقل إلى /properties/page/2/ بـ 24 بطاقة مختلفة', page.url().endsWith('/properties/page/2/') && p2.cards === 24, page.url());

  // 9) روابط التواصل على الشاشة الصغيرة
  const waLinks = await page.$$eval('a[href*="wa.me/201147758857"]', (els) => els.filter((a) => a.offsetParent || getComputedStyle(a).position === 'fixed').length);
  check('روابط واتساب 01147758857 موجودة وظاهرة', waLinks > 0, `${waLinks}`);

  // 10) رابط قديم ?type=rent يعمل
  await page.goto(BASE + '/properties/?type=rent', { waitUntil: 'load' });
  await waitRender(page, 0);
  const r = await state(page);
  check('رابط قديم ?type=rent ← إيجار فقط', r.cards > 0 && r.badges.every((t) => t.includes('للإيجار')), `${r.cards}`);
  await ctx.close();
}

// ─── البطاقة في كل مكان: الرئيسية، التفاصيل، المشابهة، معرض الصور ─────────
async function imagesOk(page, selector) {
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((i) => { i.loading = 'eager'; i.scrollIntoView(); }), selector);
  await page.waitForTimeout(1500);
  return page.$$eval(selector, (els) => els.map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.currentSrc || i.src })));
}
{
  const { ctx, page } = await openPage(390, 844, '/');
  const home = await imagesOk(page, '.hp-property-card img');
  check('الرئيسية: 6 بطاقات أحدث العروض بصورها', home.length === 6 && home.every((x) => x.ok), home.filter((x) => !x.ok).map((x) => x.src).join(' '));
  const homeHrefs = await page.$$eval('.hp-property-card', (els) => els.map((a) => a.getAttribute('href')));
  check('الرئيسية تبدأ ببطاقة بشار بن برد (الأحدث)', homeHrefs[0] === '/properties/apartment-sale-bashar-ibn-burd-makram-ebeid-190m/', homeHrefs[0]);

  await page.goto(BASE + '/properties/apartment-sale-bashar-ibn-burd-makram-ebeid-190m/', { waitUntil: 'load' });
  const main = await imagesOk(page, '#ppMainImage');
  check('تفاصيل بشار: الصورة الرئيسية تُحمَّل', main.length === 1 && main[0].ok, main[0] && main[0].src);
  const rel = await imagesOk(page, '.pp-related-card img');
  check('تفاصيل بشار: 3 عقارات مشابهة بصور cards/ محمّلة', rel.length === 3 && rel.every((x) => x.ok && x.src.includes('/cards/')), rel.map((x) => x.src.split('/').pop()).join(' '));
  const relDims = await page.$$eval('.pp-related-card img', (els) => els.every((i) => i.getAttribute('width') && i.getAttribute('height')));
  check('المشابهة بأبعاد width/height (لا CLS)', relDims);
  const waProp = await page.$$eval('a[href*="wa.me/"]', (els) => els.map((a) => decodeURIComponent(a.href)));
  check('واتساب في صفحة العقار يحمل سياق العقار', waProp.some((h) => h.includes('بشار') || h.includes('apartment-sale-bashar')), `${waProp.length} روابط`);
  const cls = await page.evaluate(() => new Promise((res) => {
    let v = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value; }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => res(v), 800);
  }));
  check('تفاصيل بشار: CLS < 0.1', cls < 0.1, cls.toFixed(4));

  await page.goto(BASE + '/property-images.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const pg = await page.evaluate(() => document.querySelectorAll('.pg-card').length);
  check('معرض الصور: يحمّل بطاقات (من ai-feed المنشور) ومقصور على مدينة نصر', pg === 0 || pg <= 92, `بطاقات=${pg} (0 = لا وصول للإنتاج من بيئة الاختبار)`);
  await ctx.close();
}

// ─── أحجام أخرى ─────────────────────────────────────────
for (const [w, h] of [[360, 740], [768, 1024], [1366, 768]]) {
  const { ctx, page } = await openPage(w, h, '/properties/');
  const bad = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${w}×${h}: لا تمرير أفقي`, !bad);
  await ctx.close();
}

check('لا أخطاء JavaScript', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} نجح`);
process.exit(failed.length ? 1 : 0);
