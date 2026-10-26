// Acceptance tests for the reliable search / owner draft / valuation evidence work (2026-10-26).
//
// Synthetic rows only: nothing here writes to _properties, sends a form, calls a Worker,
// opens WhatsApp or stores personal text. Boundary rows (exactly 150 m², exactly 20,000,
// exactly 5,000,000) exist precisely so strict and inclusive bounds can be told apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
import { app } from '../../server.js';
import { bootAgent } from '../../_worker/tests/_dom-agent.mjs';
import { createPageContext } from '../../_worker/tests/_dom-page.mjs';
import { normalizeProperty } from '../lib/properties.mjs';
import path from 'node:path';
import { buildListingFacets } from '../lib/listing-facets.mjs';
import { parseFrontMatter } from '../lib/front-matter.mjs';

const read = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const ctx = vm.createContext({});
for (const p of ['assets/js/catalog-search-core.js', 'assets/js/agent-request-core.js', 'assets/js/valuation-evidence.js']) {
  vm.runInContext(read(p), ctx);
}
const S = ctx.NasrSearch;
const A = ctx.NasrAgent;
const V = ctx.NasrValuationEvidence;
const plain = (x) => JSON.parse(JSON.stringify(x));

const rows = [
  { u: '/properties/test-sale-150/', t: 'شقة اختبار', l: 'عباس العقاد - مدينة نصر', d: 'sale', y: 'apartment', an: 150, pn: 5000000, rn: 3, p: '5,000,000 ج.م' },
  { u: '/properties/test-sale-151/', t: 'شقة اختبار', l: 'عباس العقاد - مدينة نصر', d: 'sale', y: 'apartment', an: 151, pn: 4999999, rn: 4, p: '4,999,999 ج.م' },
  { u: '/properties/test-sale-200/', t: 'شقة اختبار', l: 'مكرم عبيد - مدينة نصر', d: 'sale', y: 'apartment', an: 200, pn: 6000000, rn: 2, p: '6,000,000 ج.م' },
  { u: '/properties/test-rent-150/', t: 'شقة اختبار', l: 'عباس العقاد - مدينة نصر', d: 'rent', y: 'apartment', an: 150, pn: 20000, rn: 3, p: '20,000 ج.م شهرياً' },
  { u: '/properties/test-rent-149/', t: 'شقة مفروشة اختبار', l: 'عباس العقاد - مدينة نصر', d: 'rent', y: 'apartment', an: 149, pn: 19999, rn: 4, p: '19,999 ج.م شهرياً' },
  { u: '/properties/test-archive/', t: 'فيلا الرحاب', l: 'الرحاب', d: 'sale', y: 'villa', an: 150, pn: 10000, rn: 3, in_nasr_city: false },
];
const find = (q) => S.search(rows, S.parseQuery(q));
const areas = (list) => list.map((p) => p.an).sort((a, b) => a - b);

/* ═══════════════ the 20 required acceptance cases ═══════════════ */

test('acceptance 1: «شقة 150 متر بالضبط» returns 150 m² only', () => {
  assert.deepEqual(areas(find('شقة 150 متر بالضبط')), [150, 150]);
});
test('acceptance 2: «شقة أكبر من 150 متر» excludes 150 m²', () => {
  assert.deepEqual(areas(find('شقة أكبر من 150 متر')), [151, 200]);
});
test('acceptance 3: strict monthly rent excludes exactly 20,000 and every sale', () => {
  const r = find('شقة للإيجار أقل من 20000 جنيه شهرياً');
  assert.deepEqual(r.map((x) => x.pn), [19999]);
  assert.ok(r.every((x) => x.d === 'rent'));
});
test('acceptance 4: «20 ألف» and «عشرين ألف» are equivalent to 20000', () => {
  const digits = plain(find('شقة للإيجار أقل من 20000 جنيه شهرياً'));
  assert.deepEqual(plain(find('شقة للإيجار أقل من 20 ألف جنيه شهرياً')), digits);
  assert.deepEqual(plain(find('شقة للإيجار أقل من عشرين ألف جنيه شهرياً')), digits);
});
test('acceptance 5: «حتى 20000 شهرياً» includes 20,000 and says the bound is inclusive', () => {
  const q = S.parseQuery('شقة للإيجار حتى 20000 جنيه شهرياً');
  assert.deepEqual(S.search(rows, q).map((x) => x.pn).sort(), [19999, 20000]);
  const label = q.understood.find((x) => x.kind === 'price').label;
  assert.match(label, /^حتى 20 ألف شهريًا$/);
  assert.equal(q.price.maxExclusive, undefined);
});
test('acceptance 6: «أقل من 5 مليون» excludes 5,000,000', () => {
  assert.deepEqual(find('شقة للبيع أقل من 5 مليون').map((x) => x.pn), [4999999]);
});
test('acceptance 7: «حتى 5 مليون» may include 5,000,000', () => {
  assert.deepEqual(find('شقة للبيع حتى 5 مليون').map((x) => x.pn).sort(), [4999999, 5000000]);
});
test('acceptance 8: «٣ غرف» ≡ «3 غرف», never fewer than three rooms', () => {
  const latin = find('شقة 3 غرف');
  assert.deepEqual(plain(find('شقة ٣ غرف')), plain(latin));
  assert.ok(latin.length > 0 && latin.every((x) => x.rn >= 3));
  assert.ok(latin.some((x) => x.rn === 4), 'a minimum, not an exact count');
  assert.equal(S.parseQuery('شقة 3 غرف').understood.find((u) => u.kind === 'rooms').label, '3 غرف أو أكثر');
});
test('acceptance 9: «200 متر تقريبًا» is an approximate window, not equality', () => {
  const q = S.parseQuery('شقة 200 متر تقريبًا');
  assert.deepEqual(plain(q.area), { min: 170, max: 230, approx: 200 });
  assert.match(q.understood.find((u) => u.kind === 'area').label, /^حوالي 200م²$/);
});
test('acceptance 10: text «للبيع» + manual «للإيجار» never mixes deals and reports the conflict', () => {
  const c = S.combine(S.parseQuery('شقة للبيع'), { deal: 'rent' });
  assert.equal(S.search(rows, c).length, 0);
  assert.ok(c.conflicts.length);
  const catalogJs = read('assets/js/catalog.js');
  assert.match(catalogJs, /لم نغيّر شروطك أو نوسّع البحث/);
});
test('acceptance 11: «فيلا للبيع في الرحاب» shows no out-of-area record and explains the scope', () => {
  assert.equal(find('فيلا للبيع في الرحاب').length, 0);
  assert.match(A.reduce(null, 'فيلا للبيع في الرحاب').response, /مدينة نصر فقط/);
  assert.match(read('assets/js/catalog.js'), /الترشيحات لمدينة نصر فقط/);
});
test('acceptance 12: «التجمع الخامس» never recommends an archive unit', () => {
  assert.equal(find('التجمع الخامس').length, 0);
  assert.match(A.reduce(null, 'التجمع الخامس').response, /الأرشيف/);
  // Even with no text constraint, an archive row cannot match.
  assert.ok(S.search(rows, {}).every((x) => x.in_nasr_city !== false));
});
test('acceptance 13: «متاح اليوم؟» never claims a live verification', () => {
  assert.match(A.reduce(null, 'هل العقار متاح اليوم؟').response, /لا نجري تحققًا لحظيًا/);
  assert.doesNotMatch(read('_includes/schema-property.html'), /"availability": "https:\/\/schema.org\/InStock"/);
  const p = normalizeProperty({ title: 'شقة', price: '5,000,000 ج.م', date: '2026-10-01' }, 'x');
  assert.equal(p.availability_status, 'needs_confirmation');
  assert.equal(p.last_confirmed_at, null, 'the publication date is not a verification date');
  const confirmed = normalizeProperty({ title: 'شقة', availability_confirmed_at: '2026-10-20' }, 'y');
  assert.equal(confirmed.last_confirmed_at, '2026-10-20');
});
test('acceptance 14: an owner message with price and area is not asked for the price again', () => {
  const r = A.reduce(null, 'عندي شقة للبيع في عباس العقاد 180 متر أطلب 8 ملايين');
  assert.equal(r.draft.role, 'owner');
  assert.deepEqual(plain(r.draft.criteria.price), { min: 8000000, max: 8000000, exact: 8000000 });
  assert.equal(r.draft.criteria.area.exact, 180);
  assert.equal(r.draft.awaiting, null);
  assert.doesNotMatch(r.response, /ما السعر المطلوب؟/);
  const review = A.reduce(r.draft, 'راجع المسودة');
  assert.match(review.response, /لم يُرسل ولم يُحفظ/);
  assert.match(review.response, /add-your-property/);
});

const searchDraft = () => A.reduce(null, 'شقة للبيع في عباس العقاد 150 متر بالضبط حتى 7 مليون').draft;
test('acceptance 15: changing only the budget keeps location, area and deal', () => {
  const before = searchDraft();
  assert.equal(before.role, 'search', 'a stated ceiling is a buyer budget');
  const after = A.reduce(before, 'غيّر الميزانية فقط إلى 6 ملايين مع الاحتفاظ بالمنطقة والمساحة').draft;
  assert.equal(after.criteria.price.max, 6000000);
  assert.equal(after.location, 'عباس العقاد');
  assert.deepEqual(plain(after.criteria.area), plain(before.criteria.area));
  assert.equal(after.criteria.deal, 'sale');
  assert.equal(before.criteria.price.max, 7000000, 'the previous draft object is not mutated');
});
test('acceptance 16: sale → rent switches clearly and keeps the still-valid constraints', () => {
  const r = A.reduce(searchDraft(), 'بل أريدها إيجاراً لا شراء بحد أقصى 20 ألف جنيه شهرياً');
  assert.equal(r.draft.criteria.deal, 'rent');
  assert.equal(r.draft.criteria.price.max, 20000);
  assert.equal(r.draft.criteria.price.monthly, true);
  assert.equal(r.draft.location, 'عباس العقاد');
  assert.equal(r.draft.criteria.area.exact, 150);
  assert.match(r.response, /تم تغيير المعاملة من البيع إلى الإيجار الشهري/);
  const noBudget = A.reduce(searchDraft(), 'للإيجار');
  assert.equal(noBudget.draft.criteria.price, undefined, 'a total sale price is not reused as a monthly rent');
  assert.match(noBudget.response, /أزلت الميزانية السابقة/);
});
test('acceptance 17: licence, commission and deposit questions get no invented answer', () => {
  for (const q of ['ما رقم ترخيص العقار؟', 'كم العمولة؟', 'كم التأمين؟']) {
    const r = A.reduce(searchDraft(), q);
    assert.match(r.response, /غير منشورة/);
    assert.match(r.response, /تحتاج تأكيدًا/);
  }
});
test('acceptance 18: fallback valuation is disclosed before the number with limited confidence', () => {
  const e = V.assess({ area_found: 'مدينة نصر', fallback_used: true, confidence: 'high', sample_count: 49, calculated_at: '2026-10-20', notes: 'اختبار إدخال snapshot واحد' }, { area: 'عباس العقاد' }, Date.parse('2026-10-26'));
  assert.equal(e.fallback, true);
  assert.equal(e.confidence, 'low');
  assert.equal(e.count, 49);
  assert.equal(e.actual, 'مدينة نصر');
  assert.doesNotMatch(e.note, /snapshot واحد/, 'a seed note cannot describe a 49-sample snapshot');
  const html = read('tools/valuation.html');
  assert.ok(html.indexOf('id="fallbackNotice"') < html.indexOf('class="estimate-box"'), 'notice precedes the estimate');
  assert.ok(html.indexOf('id="valuationNature"') < html.indexOf('class="estimate-box"'));
  const page = createPageContext();
  page.run(`lastResult = ${JSON.stringify({ area_found: 'مدينة نصر', fallback_used: true, confidence: 'high', sample_count: 49, calculated_at: '2026-10-20', estimate: 100, notes: 'اختبار إدخال snapshot واحد' })};
    lastInputs = { area: 'عباس العقاد', size: 150, areaType: 'sale' }; showResult(lastResult, lastInputs, 0);`);
  assert.doesNotMatch(page.el('confidence').textContent, /عالية/);
  assert.equal(page.el('fallbackNotice').classList.contains('show'), true);
  assert.doesNotMatch(page.el('whatsappMessage').textContent, /الثقة: عالية/);
  assert.doesNotMatch(page.el('srcNote').textContent, /snapshot واحد/);
});
test('acceptance 19: the agent gallery shows only catalog-scope cards whose links match their record', async () => {
  let scopeDown = false;
  const feed = { properties: [
    { slug: 'test-city', image: '/assets/img/logo.webp', title: 'عقار اختبار', price: '1 ج.م', url: 'https://nasr-realestate.github.io/properties/test-city/' },
    { slug: 'test-archive', image: '/assets/img/logo.webp', title: 'أرشيف', in_nasr_city: false },
    { slug: 'test-not-in-catalog', image: '/assets/img/logo.webp', title: 'خارج القائمة' },
  ] };
  const page = bootAgent({ fetchImpl: async (url) => {
    if (String(url).includes('catalog.json')) return scopeDown ? new Response('', { status: 503 }) : new Response(JSON.stringify([{ u: '/properties/test-city/' }]));
    return new Response(JSON.stringify(feed));
  } });
  await page.run('fetchGalleryFeed()');
  assert.deepEqual(plain(page.run('_galleryProperties.map(p => p.slug)')), ['test-city']);
  const cards = page.el('galleryGrid').children;
  assert.equal(cards.length, 1);
  assert.equal(new URL(cards[0].href, 'https://nasr-realestate.github.io').pathname, '/properties/test-city/');
  scopeDown = true;
  await page.run('fetchGalleryFeed()');
  assert.equal(page.el('galleryEmpty').style.display, 'block', 'no scope list → no unscoped feed fallback');
});
test('acceptance 20: an unknown slug is an HTTP 404 page, never invented details', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/properties/nonexistent-synthetic-acceptance/`);
    assert.equal(r.status, 404);
    const html = await r.text();
    assert.match(html, /404/);
    assert.doesNotMatch(html, /RealEstateListing|id="ppWaBtn"/);
    const api = await fetch(`${base}/api/properties/nonexistent-synthetic-acceptance.json`);
    assert.equal(api.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

/* ═══════════════ parser unit tests ═══════════════ */

test('parser: units, Arabic digits, spelling variants and written amounts', () => {
  for (const q of ['شقه 150 م²', 'شقة ١٥٠ متر', 'شقة 150 sqm', 'شقة 150 م2', 'شقة مية وخمسين متر']) {
    const p = S.parseQuery(q);
    assert.equal(p.area.approx, 150, q);
    assert.deepEqual(plain(p.types), ['apartment'], q);
    assert.deepEqual(plain(p.text), [], q);
  }
  assert.equal(S.parseQuery('شقة مئتين وخمسين متر').area.approx, 250);
  assert.equal(S.parseQuery('بحد أقصى سبعة ملايين').price.max, 7000000);
  assert.equal(S.parseQuery('بميزانية لا تتجاوز 7 ملايين جنيه').price.max, 7000000);
  assert.equal(S.parseQuery('مليون ونص').price.approx, 1500000);
});
test('parser: monthly is a unit (rent), not a required title word', () => {
  for (const q of ['شقة أقل من 20000 شهرياً', 'شقة أقل من 20000 شهريًا', 'شقة أقل من 20000 في الشهر']) {
    const p = S.parseQuery(q);
    assert.equal(p.deal, 'rent', q);
    assert.equal(p.price.monthly, true, q);
    assert.deepEqual(plain(p.text), [], q);
  }
});
test('parser: conflicts — both deals, exactly + strict bound, implausible comparator areas', () => {
  assert.ok(S.parseQuery('شقة للبيع والإيجار معًا').conflicts.length);
  assert.ok(S.parseQuery('أريد شقة للبيع لكن الإيجار فقط').conflicts.length);
  assert.ok(S.parseQuery('شقة أكبر من 150 متر بالضبط').conflicts.length);
  assert.equal(S.parseQuery('max 7m').area, null, '«7m» is not an area of seven metres');
  const exactArea = S.parseQuery('شقة 150 متر بالضبط حتى 5 مليون');
  assert.equal(exactArea.area.exact, 150);
  assert.deepEqual(plain(exactArea.price), { min: null, max: 5000000 }, '«بالضبط» belongs to the area only');
  assert.equal(S.search(rows, { types: [] }).length, 0, 'an empty type intersection matches nothing');
});
test('parser: scope detection does not reject a Nasr City request that merely mentions a neighbour', () => {
  assert.equal(S.parseQuery('فيلا في الرحاب').outOfScope, true);
  assert.equal(S.parseQuery('apartment in New Cairo').outOfScope, true);
  assert.equal(S.parseQuery('شقة في مدينة نصر قريبة من مصر الجديدة').outOfScope, false);
});
test('parser: basic English request keeps the deal, type, area and ceiling', () => {
  const p = S.parseQuery('I want to buy an apartment in Nasr City, about 200 sqm, max EGP 7 million');
  assert.equal(p.deal, 'sale');
  assert.deepEqual(plain(p.types), ['apartment']);
  assert.equal(p.area.approx, 200);
  assert.deepEqual(plain(p.price), { min: null, max: 7000000 });
  assert.deepEqual(plain(p.text), []);
});

/* ═══════════════ dialogue / memory ═══════════════ */

test('dialogue: missing fields are asked once each; known ones are never asked again', () => {
  const a = A.reduce(null, 'عايز شقة');
  assert.equal(a.draft.role, 'search');
  assert.equal(a.draft.awaiting, 'deal');
  assert.match(a.response, /للبيع أم للإيجار؟/);
  const b = A.reduce(a.draft, 'للإيجار');
  assert.equal(b.draft.awaiting, 'location');
  assert.doesNotMatch(b.response, /للبيع أم للإيجار؟|شقة أم فيلا/);
  const c = A.reduce(b.draft, 'في عباس العقاد');
  assert.equal(c.ready, true);
  assert.match(c.response, /فهمنا: باحث عن عقار — شقة — إيجار شهري — عباس العقاد، مدينة نصر/);
});
test('dialogue: unclear or nonsense text is not turned into a purchase or rental', () => {
  for (const q of ['ضصث قفغ شسي ؤرلا تنم', 'كلام عشوائي غير مفهوم بلا أي طلب عقاري '.repeat(12)]) {
    const r = A.reduce(null, q);
    assert.equal(r.draft.role, null, q.slice(0, 20));
    assert.equal(r.draft.criteria.deal, undefined);
    assert.match(r.response, /أعد الصياغة/);
  }
  const amb = A.reduce(null, 'شقة للبيع في عباس العقاد 180 متر');
  assert.equal(amb.draft.role, null, 'a listing-like sentence without a role is ambiguous');
  assert.match(amb.response, /هل تبحث عن عقار/);
  assert.equal(amb.draft.criteria.area.approx, 180, 'the stated facts are kept while asking');
});
test('dialogue: conflicting deal stops the flow until resolved', () => {
  const r = A.reduce(null, 'أريد شقة للبيع لكن الإيجار فقط وميزانيتي 5 ملايين');
  assert.ok(r.draft.conflicts.length);
  assert.equal(r.ready, false);
  assert.match(r.response, /لن نبحث أو نكمل قبل أن تحسم/);
  const resolved = A.reduce(r.draft, 'للإيجار');
  assert.equal(resolved.draft.conflicts.length, 0);
  assert.equal(resolved.draft.criteria.deal, 'rent');
});
test('dialogue: nothing is claimed as registered; personal identifiers are refused and not stored', () => {
  assert.match(A.reduce(null, 'هل وصل طلبي أو تم تسجيله عند طارق؟').response, /لم يُرسل طلب، ولم يصل للمكتب/);
  const base = searchDraft();
  for (const q of ['رقمي 01000000000', 'بريدي test@example.invalid', 'الرقم القومي 29000000000000']) {
    const r = A.reduce(base, q);
    assert.match(r.response, /لا نحتاج اسمًا أو هاتفًا/);
    assert.deepEqual(plain(r.draft), plain(base), 'identifiers never enter the draft');
    assert.doesNotMatch(JSON.stringify(r.draft), /01000000000|example|29000000000000/);
  }
});
test('dialogue: explicit removal drops one constraint only; role change is announced', () => {
  const r = A.reduce(searchDraft(), 'بدون ميزانية');
  assert.equal(r.draft.criteria.price, undefined);
  assert.equal(r.draft.criteria.area.exact, 150);
  assert.equal(r.draft.location, 'عباس العقاد');
  const owner = A.reduce(searchDraft(), 'عندي شقة للبيع');
  assert.equal(owner.draft.role, 'owner');
  assert.match(owner.response, /تم التحويل إلى مسار المالك/);
  assert.equal(owner.draft.criteria.price, undefined, 'a buyer budget is not reused as an asking price');
});
test('dialogue: zero results explain why and propose single-condition changes only', () => {
  const d = A.reduce(null, 'بدور على شقة للبيع في عباس العقاد أقل من 1000 جنيه').draft;
  assert.equal(A.results(rows, d).length, 0);
  const alt = A.suggestions(rows, d);
  assert.ok(alt.length >= 1);
  for (const x of alt) assert.match(x.label, /^تغيير شرط «/);
  assert.ok(alt.every((x) => !x.label.includes('الرحاب')));
});

/* ═══════════════ session isolation ═══════════════ */

test('sessions: drafts are independent values; a new page never sees another page\u2019s draft', async () => {
  const first = searchDraft();
  const second = A.fresh();
  assert.deepEqual(plain(second.criteria), {});
  A.reduce(first, 'غيّر الميزانية إلى 3 مليون');
  assert.equal(first.criteria.price.max, 7000000);
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); return new Response(JSON.stringify(rows)); };
  const pageA = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl });
  pageA.run('window.NasrAgent = NasrAgent; document.getElementById("localRequestMode").checked = true');
  pageA.el('msgInput').value = 'عندي شقة للبيع في عباس العقاد 180 متر بسعر 8 ملايين';
  await pageA.run('sendMsg()');
  assert.equal(pageA.run('localDraft.criteria.price.exact'), 8000000);
  const pageB = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl, session: Object.fromEntries(pageA.sessionStorage._map) });
  pageB.run('window.NasrAgent = NasrAgent; document.getElementById("localRequestMode").checked = true');
  assert.equal(pageB.run('localDraft'), null, 'nothing about the draft survives into another page');
  pageA.run('deleteChat()');
  assert.equal(pageA.run('localDraft'), null);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
test('local UI: owner draft makes no request at all and writes no transcript to storage', async () => {
  const calls = [];
  const page = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl: async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); return new Response('[]'); } });
  page.run('window.NasrAgent = NasrAgent; document.getElementById("localRequestMode").checked = true');
  page.el('msgInput').value = 'عندي شقة للبيع في عباس العقاد 180 متر بسعر 8 ملايين';
  await page.run('sendMsg()');
  assert.deepEqual(calls, []);
  assert.equal(page.run('localDraft.role'), 'owner');
  for (const [, value] of page.sessionStorage._map) assert.doesNotMatch(value, /عباس العقاد|8 ملايين/);
  for (const [, value] of page.localStorage._map) assert.doesNotMatch(value, /عباس العقاد|8 ملايين/);
  assert.ok(page.chatArea.children.some((m) => /مسودة محلية فقط/.test(m.innerHTML)));
});
test('local UI: search results come from catalog.json (GET only), link to real slugs and never to archive rows', async () => {
  const calls = [];
  const page = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl: async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return new Response(JSON.stringify(rows));
  } });
  page.run('window.NasrAgent = NasrAgent; document.getElementById("localRequestMode").checked = true');
  page.el('msgInput').value = 'بدور على شقة للإيجار في عباس العقاد أقل من 20 ألف جنيه شهرياً';
  await page.run('sendMsg()');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/assets/data/catalog.json']]);
  const html = page.chatArea.children.map((m) => m.innerHTML).join('\n');
  assert.match(html, /test-rent-149/);
  assert.doesNotMatch(html, /test-rent-150|test-archive|test-sale/);
  assert.match(html, /التوافر يحتاج إلى تأكيد/);
});
test('local UI: an unknown slug answers 404 without fabricating details', async () => {
  const page = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl: async () => new Response('not found', { status: 404 }) });
  page.run('window.NasrAgent = NasrAgent; document.getElementById("localRequestMode").checked = true');
  page.el('msgInput').value = 'تفاصيل العقار nonexistent-synthetic-slug-280m';
  await page.run('sendMsg()');
  const last = page.chatArea.children.at(-1).innerHTML;
  assert.match(last, /404/);
  assert.doesNotMatch(last, /ج\.م|م²/);
});

/* ═══════════════ scope, MCP wording, privacy text vs implementation ═══════════════ */

test('MCP worker and card describe the same served area (Nasr City only)', () => {
  const worker = read('_worker/mcp-worker.js');
  assert.doesNotMatch(worker.replace(/\/\*[\s\S]*?\*\//g, ''), /مدينة نصر والقاهرة الجديدة/);
  const card = JSON.parse(read('.well-known/mcp.json'));
  assert.doesNotMatch(JSON.stringify(card), /القاهرة الجديدة\)|والقاهرة الجديدة،/);
  assert.match(card.description, /مدينة نصر/);
});
test('privacy text lists exactly what the valuation request sends and what local mode does not send', () => {
  const page = read('tools/valuation.html');
  const payload = page.match(/const payload = \{([\s\S]*?)\};/)[1];
  for (const key of ['area', 'areaType', 'propertyType', 'size', 'finishing', 'floor', 'age']) assert.match(payload, new RegExp(`\\b${key}:`));
  const policy = read('privacy-policy.html');
  for (const label of ['المنطقة', 'المعاملة', 'نوع العقار', 'المساحة', 'التشطيب', 'الدور', 'عمر المبنى', 'حالة التأثيث']) assert.ok(policy.includes(label), label);
  assert.match(policy, /لا ترسل سعر المقارنة أو اسمًا أو هاتفًا/);
  assert.match(policy, /لا يرسل نص المحادثة إلى Cloudflare Worker أو Gemini/);
  assert.match(policy, /آخر 20 رسالة/);
  assert.match(read('agent.html'), /history: state\.history\.slice\(-20\)/, 'the policy matches the actual cloud payload');
  assert.match(read('agent.html'), /id="localRequestMode" checked/, 'local mode is the default');
});
test('property page states availability needs confirmation and labels the publication date', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/properties/apartment-sale-moussa-el-kazem-nasr-city-280m/`)).text();
    assert.match(html, /class="pp-availability-status"[\s\S]*?يحتاج إلى تأكيد من المالك/);
    assert.match(html, /نُشر \d{2}\/\d{2}\/\d{4}/);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    assert.ok(ld.length > 0);
    assert.doesNotMatch(JSON.stringify(ld), /InStock/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
test('stale, undated or tiny-sample valuations never show high confidence; matching names are not fallback', () => {
  const now = Date.parse('2026-10-26');
  for (const override of [{ calculated_at: '2020-01-01' }, { calculated_at: '' }, { sample_count: 1 }, { sample_count: null }]) {
    const e = V.assess(Object.assign({ area_found: 'عباس العقاد', confidence: 'high', sample_count: 50, calculated_at: '2026-10-20' }, override), { area: 'عباس العقاد' }, now);
    assert.notEqual(e.confidence, 'high', JSON.stringify(override));
    assert.equal(e.limited, true);
  }
  const ok = V.assess({ area_found: 'مدينة نصر', confidence: 'high', sample_count: 50, calculated_at: '2026-10-20' }, { area: 'مدينة نصر (ككل)' }, now);
  assert.equal(ok.fallback, false);
  assert.equal(ok.confidence, 'high');
});

/* ═══════════════ the same acceptance queries on the real published source (read-only) ═══════════════ */
// Built from _properties + listing facets exactly like assets/data/catalog.json; no counts are hardcoded,
// so adding or removing a listing never breaks this test while every invariant is still checked.

const ROOT = new URL('../../', import.meta.url).pathname;
const facets = buildListingFacets(ROOT);
const front = {};
for (const f of fs.readdirSync(path.join(ROOT, '_properties')).filter((x) => x.endsWith('.md'))) {
  const { data } = parseFrontMatter(read(`_properties/${f}`));
  front[String(data.slug || f.replace(/\.md$/, '')).trim()] = data;
}
const REAL = facets.catalog.order.map((slug, o) => {
  const f = facets.listings[slug];
  return { u: `/properties/${slug}/`, t: front[slug].title, l: front[slug].location || 'مدينة نصر', d: f.deal, y: f.type, pn: f.price, an: f.area, rn: f.rooms, o };
});
const real = (q, ui = {}) => S.search(REAL, S.combine(S.parseQuery(q), ui));

test('real data: every catalog row is inside Nasr City and links to an existing property file', () => {
  const slugs = new Set(Object.keys(front));
  assert.ok(REAL.length > 0);
  for (const r of REAL) {
    assert.equal(facets.listings[r.u.split('/')[2]].in_area, true, r.u);
    assert.ok(slugs.has(r.u.split('/')[2]), r.u);
  }
  for (const archived of facets.out_of_area_slugs) assert.ok(!REAL.some((r) => r.u.includes(`/${archived}/`)), archived);
});
test('real data: acceptance queries 1–9 satisfy their constraint on the published listings', () => {
  const exact = real('شقة 150 متر بالضبط');
  assert.ok(exact.every((x) => x.an === 150 && x.y === 'apartment'));
  assert.equal(exact.length, REAL.filter((x) => x.an === 150 && x.y === 'apartment').length);
  const above = real('شقة أكبر من 150 متر');
  assert.ok(above.every((x) => x.an > 150));
  assert.equal(above.length, REAL.filter((x) => x.an > 150 && x.y === 'apartment').length);
  for (const q of ['شقة للإيجار أقل من 20000 جنيه شهرياً', 'شقة للإيجار أقل من 20 ألف جنيه شهرياً']) {
    const r = real(q);
    assert.ok(r.every((x) => x.d === 'rent' && x.pn < 20000), q);
    assert.equal(r.length, REAL.filter((x) => x.d === 'rent' && x.y === 'apartment' && x.pn > 0 && x.pn < 20000).length, q);
  }
  const inclusive = real('شقة للإيجار حتى 20000 جنيه شهرياً');
  assert.equal(inclusive.length, REAL.filter((x) => x.d === 'rent' && x.y === 'apartment' && x.pn > 0 && x.pn <= 20000).length);
  const strictSale = real('شقة للبيع أقل من 5 مليون');
  assert.ok(strictSale.every((x) => x.d === 'sale' && x.pn < 5000000));
  const inclusiveSale = real('شقة للبيع حتى 5 مليون');
  assert.equal(inclusiveSale.length, REAL.filter((x) => x.d === 'sale' && x.y === 'apartment' && x.pn > 0 && x.pn <= 5000000).length);
  assert.deepEqual(plain(real('شقة ٣ غرف')), plain(real('شقة 3 غرف')));
  assert.ok(real('شقة 3 غرف').every((x) => x.rn >= 3));
  const approx = real('شقة 200 متر تقريبًا');
  assert.ok(approx.every((x) => x.an >= 170 && x.an <= 230));
  assert.ok(approx.some((x) => x.an !== 200) || approx.length === REAL.filter((x) => x.an === 200 && x.y === 'apartment').length);
});
test('real data: acceptance queries 10–12 never mix deals or leave Nasr City', () => {
  assert.equal(real('شقة للبيع', { deal: 'rent' }).length, 0);
  assert.equal(real('فيلا للبيع في الرحاب').length, 0);
  assert.equal(real('التجمع الخامس').length, 0);
  assert.ok(real('شقة للبيع').every((x) => x.d === 'sale'));
});

test('result links: only https or a same-site /properties/<slug>/ path are rendered as links', () => {
  const page = bootAgent();
  assert.equal(page.run('safeLink("/properties/test-city/")'), '/properties/test-city/');
  assert.equal(page.run('safeLink("https://nasr-realestate.github.io/properties/x/")'), 'https://nasr-realestate.github.io/properties/x/');
  for (const bad of ['javascript:alert(1)', '/properties/../admin/', '//evil.example/properties/x/', 'http://insecure.example/', '/properties/x/"onmouseover=1']) {
    assert.equal(page.run(`safeLink(${JSON.stringify(bad)})`), '', bad);
  }
});
