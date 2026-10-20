#!/usr/bin/env node
// فحص سلامة الموقع المبني (2026-10-20) — بلا اعتماديات.
//
//   bundle exec jekyll build -d _site && node scripts/check-built-site.mjs _site
//
// يفحص ما لا تراه اختبارات الوحدة لأنه ناتج Liquid النهائي:
//   1) كل href/src داخلي يشير إلى ملف موجود (لا روابط مكسورة).
//   2) كل رابط في sitemap.xml موجود، canonical ذاتي، وليس noindex.
//   3) الوحدات خارج مدينة نصر وصفحة 404: noindex وخارج sitemap.
//   4) كل صفحة في sitemap: H1 واحد، عنوان غير مكرر وبلا تكرار اسم العلامة.
//   5) JSON-LD صالح في كل الصفحات، ولا AggregateRating/Review (لا تقييمات غير مثبتة).
//   6) صفحات المعرض 1..N متصلة بروابط <a href> من الصفحة الأولى.
//   7) صفحات الهبوط المفهرسة في sitemap وكل بطاقاتها داخل مدينة نصر.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const ORIGIN = 'https://nasr-realestate.github.io';
const facets = JSON.parse(fs.readFileSync(path.join(ROOT, '_data/listing_facets.json'), 'utf8'));
const segments = JSON.parse(fs.readFileSync(path.join(ROOT, '_data/landing_segments.json'), 'utf8')).segments;

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const stripNoise = (h) => h.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '');

function fileFor(urlPath) {
  let u = decodeURIComponent(urlPath.split('#')[0].split('?')[0]);
  if (!u.startsWith('/')) return null;
  const p = path.join(SITE, u);
  if (u.endsWith('/')) return fs.existsSync(path.join(p, 'index.html')) ? path.join(p, 'index.html') : null;
  for (const c of [p, `${p}.html`, path.join(p, 'index.html')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const meta = (h, re) => { const m = h.match(re); return m ? decode(m[1]) : null; };
const canonicalOf = (h) => meta(h, /<link rel="canonical" href="([^"]+)"/);
const robotsOf = (h) => meta(h, /<meta name="robots" content="([^"]+)"/) || '';
const titleOf = (h) => meta(h, /<title>([^<]*)<\/title>/);

if (!fs.existsSync(path.join(SITE, 'sitemap.xml'))) {
  console.error(`❌ لا يوجد موقع مبني في ${SITE}`);
  process.exit(2);
}

// ─── 1) الروابط الداخلية ─────────────────────────────────
const pages = walk(SITE);
const broken = new Map();
const pageHtml = new Map();
for (const f of pages) {
  const raw = fs.readFileSync(f, 'utf8');
  pageHtml.set(f, raw);
  const h = stripNoise(raw);
  for (const m of h.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let u = decode(m[1]);
    if (u.startsWith(ORIGIN)) u = u.slice(ORIGIN.length) || '/';
    if (!u.startsWith('/') || u.startsWith('//')) continue;
    if (!fileFor(u)) {
      if (!broken.has(u)) broken.set(u, new Set());
      broken.get(u).add(path.relative(SITE, f));
    }
  }
}
for (const [u, from] of broken) fail(`رابط مكسور ${u} ← ${[...from].slice(0, 3).join('، ')}${from.size > 3 ? ` (+${from.size - 3})` : ''}`);

// ─── 2) sitemap ──────────────────────────────────────────
const sitemap = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const titles = new Map();
for (const loc of locs) {
  const u = loc.replace(ORIGIN, '') || '/';
  const f = fileFor(u);
  if (!f) { fail(`sitemap: ${u} غير موجود`); continue; }
  if (!f.endsWith('.html')) continue;
  const h = pageHtml.get(f) || fs.readFileSync(f, 'utf8');
  const can = canonicalOf(h);
  if (can !== loc) fail(`sitemap: ${u} canonical = ${can}`);
  if (/noindex/.test(robotsOf(h))) fail(`sitemap: ${u} noindex لكنه في sitemap`);
  // ─── 4) H1 والعنوان (صفحات Jekyll فقط؛ الأدوات الساكنة لها قوالبها) ───
  if (robotsOf(h)) {
    const h1 = (stripNoise(h).match(/<h1\b/gi) || []).length;
    if (h1 !== 1) fail(`${u}: عدد H1 = ${h1}`);
    const t = titleOf(h) || '';
    const brandCount = (t.match(/سمسار طلبك/g) || []).length;
    if (brandCount > 1) fail(`${u}: اسم العلامة مكرر في العنوان «${t}»`);
    if (titles.has(t)) fail(`عنوان مكرر «${t}»: ${titles.get(t)} و${u}`);
    titles.set(t, u);
  }
}

// ─── 3) خارج النطاق و404 ─────────────────────────────────
for (const slug of facets.out_of_area_slugs) {
  if (locs.some((l) => l.endsWith(`/properties/${slug}/`))) fail(`وحدة خارج مدينة نصر في sitemap: ${slug}`);
  const f = fileFor(`/properties/${slug}/`);
  if (f && !/noindex/.test(robotsOf(pageHtml.get(f)))) fail(`وحدة خارج مدينة نصر بلا noindex: ${slug}`);
}
const nf = path.join(SITE, '404.html');
if (fs.existsSync(nf) && !/noindex/.test(robotsOf(pageHtml.get(nf)))) fail('404.html بلا noindex');
if (locs.some((l) => /\/404(\.html)?$/.test(l))) fail('404 في sitemap');

// ─── 5) JSON-LD ──────────────────────────────────────────
let ldCount = 0;
for (const [f, raw] of pageHtml) {
  const h = raw.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    ldCount++;
    try {
      const txt = JSON.stringify(JSON.parse(m[1]));
      if (/"@type":"(AggregateRating|Review)"/.test(txt)) fail(`${path.relative(SITE, f)}: AggregateRating/Review في JSON-LD`);
    } catch (e) {
      fail(`${path.relative(SITE, f)}: JSON-LD غير صالح (${e.message.slice(0, 60)})`);
    }
  }
}

// ─── 6) ترقيم المعرض ─────────────────────────────────────
const seen = new Set();
const queue = ['/properties/'];
while (queue.length) {
  const u = queue.shift();
  if (seen.has(u)) continue;
  seen.add(u);
  const f = fileFor(u);
  if (!f) continue;
  for (const m of pageHtml.get(f).matchAll(/href="(\/properties\/page\/\d+\/)"/g)) queue.push(m[1]);
}
for (let n = 2; n <= facets.catalog.total_pages; n++) {
  if (!seen.has(`/properties/page/${n}/`)) fail(`صفحة المعرض ${n} غير متصلة بروابط من /properties/`);
}
const catalogSlugs = new Set();
for (const u of seen) {
  for (const m of pageHtml.get(fileFor(u)).matchAll(/class="pl-card" data-slug="([^"]+)"/g)) catalogSlugs.add(m[1]);
}
if (catalogSlugs.size !== facets.catalog.order.length) fail(`المعرض المرقّم يعرض ${catalogSlugs.size} عرضًا بدل ${facets.catalog.order.length}`);
for (const s of catalogSlugs) if (facets.out_of_area_slugs.includes(s)) fail(`المعرض يعرض وحدة خارج النطاق ${s}`);

// ─── 7) صفحات الهبوط ─────────────────────────────────────
for (const seg of segments) {
  const st = facets.segments[seg.key];
  const f = fileFor(seg.path);
  if (!f) { fail(`صفحة الهبوط ${seg.path} غير مبنية`); continue; }
  const h = pageHtml.get(f);
  const inSitemap = locs.includes(ORIGIN + seg.path);
  if (st.indexable !== inSitemap) fail(`${seg.path}: indexable=${st.indexable} لكن sitemap=${inSitemap}`);
  const cards = [...h.matchAll(/class="pl-card" data-slug="([^"]+)"/g)].map((m) => m[1]);
  if (cards.length !== st.count) fail(`${seg.path}: ${cards.length} بطاقة بدل ${st.count}`);
  for (const s of cards) {
    const l = facets.listings[s];
    if (!l || !l.in_area || !l.segments.includes(seg.key)) fail(`${seg.path}: بطاقة لا تنتمي ${s}`);
  }
}

notes.push(`${pages.length} صفحة HTML`, `${locs.length} رابط في sitemap`, `${ldCount} كتلة JSON-LD`,
  `المعرض: ${seen.size} صفحات / ${catalogSlugs.size} عرضًا`, `${segments.length} صفحات هبوط`);
console.log(`[check-built-site] ${notes.join(' · ')}`);
if (failures.length) {
  console.error(`❌ ${failures.length} مشكلة:`);
  for (const f of failures.slice(0, 60)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('✅ لا روابط مكسورة؛ sitemap/canonical/noindex/JSON-LD/الترقيم/صفحات الهبوط سليمة');
