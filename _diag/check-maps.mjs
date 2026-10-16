#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   _diag/check-maps.mjs — فحص آلي لنظام الخرائط (2026-10-16) — بلا تبعيات
   ─────────────────────────────────────────────────────────────────
   يشغَّل من جذر المستودع:  node _diag/check-maps.mjs
   يغطي (مقابل مواصفة الإصلاح D1–D6 والاختبارات 2 و4 و5):
     1) عدّ صفحات العقارات: كم صفحة تعرض مربع الخريطة (has_map) — 44 متوقعًا.
     2) حساب bbox (500م) وترتيب OSM (minLon,minLat,maxLon,maxLat) و marker=lat,lng.
     3) اتساق منطق القالب (Liquid) مع منطق nasr-maps.js على كل الصفحات.
     4) روابط الـembed لكل صفحة + خريطة المكتب (300م).
     5) كشف الفشل لا يعتمد على tileerror وحده: مزوّد يعيد 200 بصورة موسومة
        (بلاطة مسطّحة/بعلامة) يُكشَف كفشل — سلوكيًا عبر attachTiles وembedOsmMap،
        وعبر HTTP حقيقي (خادم محلي يعيد 200 + PNG موسوم ثم فك البكسلات وتحليلها).
     6) التدهور الرشيق: nm-loaded + nm-failed + رسالة + رابط Google Maps.
     7) لا مفاتيح ولا أسرار في الملفات المعدَّلة (النمط يُبنى برمجيًا ويشمل ذاته).
   يخرج بـ 0 عند النجاح و 1 عند أي فشل.
   _diag/ لا تُنشر (مستثناة من Jekyll).
   ═══════════════════════════════════════════════════════════════════ */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.log('  FAIL  ' + label); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/* ════════════════ أ) هياكل DOM/Canvas/Image وهمية + تحميل nasr-maps.js ════════════════ */

function makeClassList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    _set: set
  };
}

function makeNode(tag) {
  const node = {
    tag,
    children: [],
    style: {},
    dataset: {},
    classList: makeClassList(),
    attributes: {},
    innerHTML: '',
    textContent: '',
    setAttribute(k, v) { node.attributes[k] = v; },
    appendChild(c) { node.children.push(c); return c; },
    remove() { node.removed = true; },
    getContext(kind) {
      if (kind !== '2d') return null;
      return {
        _img: null,
        drawImage(img) { this._img = img; },
        getImageData() {
          const px = this._img && this._img._pixels;
          return { data: px || new Uint8ClampedArray(0) };
        }
      };
    }
  };
  return node;
}

/* سيناريوهات المزوّد الوهمي: كل صورة «تحمل بنجاح» = ما يعادل HTTP 200 + صورة */
let imgScenario = { mode: 'good' }; // good | watermarked | solid | netfail | corsfail | hang
function scenarioPixels() {
  return imgScenario.pixels;
}
function ImageMock() {
  const img = makeNode('img');
  img.naturalWidth = imgScenario.w || 256;
  img.naturalHeight = imgScenario.h || 256;
  img.crossOrigin = null;
  img._pixels = scenarioPixels();
  img.onload = null;
  img.onerror = null;
  Object.defineProperty(img, 'src', {
    get() { return img._src; },
    set(v) {
      img._src = v;
      const mode = imgScenario.mode;
      if (mode === 'hang') return;
      setTimeout(() => {
        if (mode === 'netfail') { if (img.onerror) img.onerror(); return; }
        if (mode === 'corsfail' && img.crossOrigin === 'anonymous') { if (img.onerror) img.onerror(); return; }
        if (img.onload) img.onload();
      }, 0);
    }
  });
  return img;
}

const documentShim = {
  readyState: 'complete',
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  createElement: (tag) => (tag === 'iframe' || tag === 'canvas' ? makeNode(tag) : makeNode(tag)),
  head: { appendChild() {} },
  body: {}
};
const windowShim = {};
globalThis.window = windowShim;
globalThis.document = documentShim;
globalThis.Image = ImageMock;

/* المؤقتات الطويلة (≥5 ثوانٍ) لا تُبقي العملية حيّة في نهاية الفحص */
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const handle = origSetTimeout(fn, ms, ...args);
  if (ms >= 5000 && handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

await import(pathToFileURL(path.join(ROOT, 'assets/js/nasr-maps.js')).href);
const NM = windowShim.NasrMaps;
const NI = NM._internals;

/* مولّدات البكسلات: بلاطة موسومة (خلفية مسطّحة + نص) / بلاطة خريطة حقيقية (عالية التنوع) */
function watermarkedPixels(w = 256, h = 256) {
  // ما يعادل بلاطة «API KEY REQUIRED»: خلفية رمادية فاتحة + أشرطة داكنة (نص)
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const isText = (y > 96 && y < 160 && (y % 12) < 7 && x > 40 && x < 216 && ((x + y) % 9) < 6);
      const c = isText ? 70 : 242;
      px[i] = c; px[i + 1] = c; px[i + 2] = c; px[i + 3] = 255;
    }
  }
  return px;
}
function solidPixels(w = 256, h = 256) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = 60; px[i + 2] = 60; px[i + 3] = 255; }
  return px;
}
function mapLikePixels(w = 256, h = 256) {
  // تنوع عالٍ (مبانٍ/طرق/أسماء) — LCG ثابت البذرة للحتمية
  const px = new Uint8ClampedArray(w * h * 4);
  let s = 123456789;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const palette = [[242, 236, 220], [255, 255, 255], [220, 210, 190], [200, 200, 205], [180, 190, 170],
    [250, 240, 160], [160, 160, 165], [235, 220, 200], [120, 120, 125], [90, 90, 95], [210, 180, 140], [60, 60, 65]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const road = (x % 47 < 3) || (y % 53 < 3);
      const c = road ? [255, 255, 255] : palette[Math.floor(rnd() * palette.length)];
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

/* ════════════════ ب) PNG حقيقي (توليد + فك) لاختبار HTTP 200 بصورة بديلة ════════════════ */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let pos = 8, w = 0, h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (1 + w * 4)], 0, 'filter byte 0');
    px.set(raw.subarray(y * (1 + w * 4) + 1, y * (1 + w * 4) + 1 + w * 4), y * w * 4);
  }
  return { w, h, px };
}

/* ════════════════ ج) Leaflet وهمي لاختبار attachTiles سلوكيًا ════════════════ */
function leafletShim() {
  const layers = [];
  return {
    layers,
    L: {
      map: () => ({ attributionControl: { setPrefix() {} }, removeLayer() {}, on() {} }),
      tileLayer: (url, opts) => {
        const handlers = {};
        const layer = {
          url,
          opts,
          on(ev, cb) { handlers[ev] = cb; return layer; },
          off() {},
          addTo() { layers.push({ url, handlers }); return layer; }
        };
        return layer;
      },
      control: { zoom: () => ({ addTo() {} }) }
    }
  };
}

const delay = (ms) => new Promise((r) => origSetTimeout(r, ms));

/* ══════════════════════════════ الفحوص ══════════════════════════════ */

/* 1) عدّ صفحات العقارات + منطق has_map في القالب */
section('1) عدّ الصفاحات ومنطق has_map (القالب Liquid)');
const template = read('_layouts/property_page.html');
const knownMatch = /nm_known = "([^"]+)"/.exec(template);
ok(!!knownMatch, 'قالب property_page.html يحمل قائمة nm_known');
const templateKeys = knownMatch[1].split('|');
const files = readdirSync(path.join(ROOT, '_properties')).filter((n) => n.endsWith('.md')).sort();

function frontMatter(text) {
  const m = /^---\s*$/m.exec(text);
  return m ? text.split(/^---\s*$/m)[1] : '';
}
function fmGet(front, key) {
  const hit = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(front);
  return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : '';
}
function templateHasMap(front) {
  const lat = fmGet(front, 'lat'), lng = fmGet(front, 'lng');
  const loc = fmGet(front, 'location');
  if (lat && lng) return true;
  let hit = false;
  for (const k of templateKeys) if (loc.includes(k)) hit = true;
  if (loc.includes('امتداد') || loc.includes('كمبوند')) hit = false;
  return hit;
}

let withMap = 0, withoutMap = 0, withLat = 0;
const pageRows = [];
for (const name of files) {
  const front = frontMatter(read(path.join('_properties', name)));
  const loc = fmGet(front, 'location');
  const lat = fmGet(front, 'lat'), lng = fmGet(front, 'lng');
  if (lat && lng) withLat++;
  const hm = templateHasMap(front);
  if (hm) withMap++; else withoutMap++;
  const jsRes = NI.resolvePropertyLevel({ lat, lng, precision: fmGet(front, 'map_precision'), location: loc });
  pageRows.push({ name, loc, lat, lng, hm, jsLevel: jsRes.level, jsRes });
}
console.log(`  المجموع ${files.length} صفحة: ${withMap} مع مربع خريطة، ${withoutMap} بدون، ${withLat} فيها إحداثيات`);
ok(files.length === 102, '102 صفحة عقار في _properties');
ok(withMap === 44, '44 صفحة تعرض مربع الخريطة (has_map)');
ok(withoutMap === 58, '58 صفحة بدون خريطة (area)');
ok(withLat === 0, '0 صفحة فيها lat/lng (لا pins دقيقة)');

/* 2) اتساق القالب ↔ nasr-maps.js على كل الصفحات */
section('2) اتساق منطق القالب مع nasr-maps.js');
const mismatches = pageRows.filter((r) => r.hm !== (r.jsLevel !== 'area'));
ok(mismatches.length === 0, `0 اختلاف بين has_map في القالب و resolvePropertyLevel في JS (${mismatches.length} اختلاف)`);
for (const m of mismatches) console.log('    mismatch: ' + m.name + ' template=' + m.hm + ' js=' + m.jsLevel);
const streetPages = pageRows.filter((r) => r.jsLevel === 'street');
ok(streetPages.length === 44, 'كل صفحات الخريطة الـ44 تُحلّ كمستوى street (نطاق 500م)');

/* 3) حساب bbox + صيغة الرابط (تحقق مستقل بنفس معادلات المواصفة) */
section('3) حساب bbox وصيغة رابط OSM embed');
const spec = NM.bboxAround(30.05, 31.33, 500);
const expDLat = 500 / 111320;
const expDLng = 500 / (111320 * Math.cos(30.05 * Math.PI / 180));
ok(Math.abs((spec.maxLat - spec.minLat) / 2 - expDLat) < 1e-9, 'Δlat = 500/111320 ≈ 0.0044916');
ok(Math.abs((spec.maxLon - spec.minLon) / 2 - expDLng) < 1e-9, 'Δlng = 500/(111320×cos(lat)) ≈ 0.005188 عند 30.05');
ok(expDLat > 0.00449 && expDLat < 0.00450, 'Δlat ضمن نطاق 0.0044916 المذكور');
ok(expDLng > 0.00518 && expDLng < 0.00520, 'Δlng ضمن نطاق 0.005188 المذكور');

const sample = NM.osmEmbedUrl(30.0622, 31.3452, 500);
ok(sample.startsWith('https://www.openstreetmap.org/export/embed.html?bbox='), 'قاعدة الرابط embed.html?bbox=');
ok(sample.includes('&layer=mapnik&marker='), 'layer=mapnik و marker موجودان');
const bboxPart = /bbox=([^&]+)/.exec(sample)[1];
const nums = bboxPart.split('%2C').map(Number);
ok(nums.length === 4 && bboxPart.split('%2C').every((p) => /^-?\d+(\.\d+)?$/.test(p)), 'bbox = 4 أرقام مفصولة بـ %2C');
ok(nums[0] < nums[2] && nums[1] < nums[3], 'ترتيب OSM: minLon,minLat,maxLon,maxLat (min<max)');
ok(Math.abs((nums[2] - nums[0]) / 2 - 500 / (111320 * Math.cos(30.0622 * Math.PI / 180))) < 2e-6,
  'نصف قطر bbox الأفقي = 500/(111320×cos(lat الصفحة))');
ok(Math.abs((nums[3] - nums[1]) / 2 - expDLat) < 2e-6, 'نصف قطر bbox الرأسي = Δlat');
const markerPart = /marker=([^&]+)/.exec(sample)[1];
const [mLat, mLng] = markerPart.split('%2C').map(Number);
ok(Math.abs(mLat - 30.0622) < 1e-6 && Math.abs(mLng - 31.3452) < 1e-6, 'ترتيب marker = lat%2Clng (مركز الشارع)');
ok(!sample.includes('api' + 'key') && !sample.includes('key' + '='), 'الرابط بلا معاملات مفاتيح');
console.log('    رابط نموذجي: ' + sample);

/* روابط الـembed لكل صفحات الخريطة + المكتب */
let embedUrlsOk = 0;
for (const r of pageRows) {
  if (!r.hm) continue;
  const meters = r.jsLevel === 'street' ? 500 : 250;
  const url = NM.osmEmbedUrl(r.jsRes.lat, r.jsRes.lng, meters);
  const b = /bbox=([^&]+)/.exec(url)[1].split('%2C').map(Number);
  const good = url.startsWith('https://www.openstreetmap.org/export/embed.html?bbox=')
    && url.includes('&layer=mapnik&marker=')
    && b.length === 4 && b[0] < b[2] && b[1] < b[3]
    && (b[3] - b[1]) / 2 < 0.005 && (b[3] - b[1]) / 2 > 0.0044; // ≈500م أو أضيق
  if (good) embedUrlsOk++;
}
ok(embedUrlsOk === 44, 'روابط embed سليمة لكل الصفحات الـ44 (bbox + marker)');
const office = NM.osmEmbedUrl(30.0673165, 31.3391426, 300);
const ob = /bbox=([^&]+)/.exec(office)[1].split('%2C').map(Number);
ok(Math.abs((ob[3] - ob[1]) / 2 - 300 / 111320) < 2e-6, 'خريطة المكتب: نطاق ≈300م');
ok(office.includes('marker=30.067316%2C31.339143') || office.includes('marker=30.067317%2C31.339143'),
  'خريطة المكتب: marker على 30.0673165, 31.3391426');
console.log('    رابط المكتب: ' + office);

/* 4) كشف البلاطة المزوّرة/الموسومة (تحليل البكسلات) */
section('4) كشف البلاطة ذات اللون الواحد أو الموسومة');
const vWater = NI.classifyTilePixels(watermarkedPixels(), 256, 256);
ok(vWater.ok === false && vWater.reason === 'flat-or-watermarked-tile', `بلاطة موسومة (خلفية + نص) → فشل (لون مسيطر ${(vWater.dominantFraction)})`);
const vSolid = NI.classifyTilePixels(solidPixels(), 256, 256);
ok(vSolid.ok === false, 'بلاطة لون واحد → فشل');
const vGood = NI.classifyTilePixels(mapLikePixels(), 256, 256);
ok(vGood.ok === true, `بلاطة خريطة حقيقية (تنوّع ${vGood.distinctColors} لونًا) → سليمة`);
const vDimsBad = NI.classifyDimensions({ naturalWidth: 128, naturalHeight: 128 });
ok(vDimsBad.ok === false, 'أبعاد غير قياسية (≠256/512) → فشل (بصمة الحجم)');

/* 5) مزوّد يعيد HTTP 200 بصورة بديلة/موسومة يُكشَف كفشل — بلا tileerror إطلاقًا */
section('5) HTTP 200 + صورة بديلة = فشل (لا اعتماد على tileerror)');
{
  // (أ) على مستوى probeTileProvider: الصورة «تُحمَّل بنجاح» تمامًا
  imgScenario = { mode: 'good', pixels: watermarkedPixels() };
  const verdict = await NI.probeTileProvider('https://tile.openstreetmap.org/13/1/1.png', {
    timeout: 200, imgFactory: ImageMock, createCanvas: () => makeNode('canvas')
  });
  ok(verdict.ok === false, 'فحص المزوّد: 200 + بلاطة موسومة → ok=false (' + verdict.reason + ')');

  imgScenario = { mode: 'good', pixels: mapLikePixels() };
  const verdict2 = await NI.probeTileProvider('https://tile.openstreetmap.org/13/1/1.png', {
    timeout: 200, imgFactory: ImageMock, createCanvas: () => makeNode('canvas')
  });
  ok(verdict2.ok === true, 'فحص المزوّد: 200 + بلاطة حقيقية → ok=true (' + verdict2.reason + ')');

  imgScenario = { mode: 'netfail' };
  const verdict3 = await NI.probeTileProvider('https://tile.openstreetmap.org/13/1/1.png', {
    timeout: 200, imgFactory: ImageMock, createCanvas: () => makeNode('canvas')
  });
  ok(verdict3.ok === false && verdict3.method === 'network', 'انقطاع الشبكة → ok=false (method=network)');

  imgScenario = { mode: 'corsfail', pixels: mapLikePixels() };
  const verdict4 = await NI.probeTileProvider('https://tile.openstreetmap.org/13/1/1.png', {
    timeout: 200, imgFactory: ImageMock, createCanvas: () => makeNode('canvas')
  });
  ok(verdict4.ok === true && verdict4.method === 'size', 'بلا CORS: البديل الموثّق = بصمة الأبعاد (method=size)');

  // (ب) على مستوى attachTiles: البلاطة نفسها تُطلق tileload (نجاح كاذب) ثم يُكشف التزييف
  imgScenario = { mode: 'good', pixels: watermarkedPixels() };
  const shim = leafletShim();
  const el = makeNode('div');
  const { ready } = NM.createMap(shim.L, el, { center: [30.05, 31.33], zoom: 13 });
  ok(shim.layers.length === 1 && shim.layers[0].url === 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'attachTiles يستخدم بلاطات OSM القياسية فقط');
  shim.layers[0].handlers.tileload(); // ← يُطلق قبل الفحص — الحدث الذي كان «نجاحًا» في المنطق القديم
  const readyVal = await Promise.race([ready, delay(300).then(() => 'timeout')]);
  ok(readyVal === false, 'attachTiles: tileload حدث + مزوّد يعيد 200 موسوم → ready=false (فشل، لا اعتماد على tileerror)');

  imgScenario = { mode: 'good', pixels: mapLikePixels() };
  const shim2 = leafletShim();
  const el2 = makeNode('div');
  const { ready: ready2 } = NM.createMap(shim2.L, el2, { center: [30.05, 31.33], zoom: 13 });
  shim2.layers[0].handlers.tileload();
  const readyVal2 = await Promise.race([ready2, delay(300).then(() => 'timeout')]);
  ok(readyVal2 === true, 'attachTiles: بلاطة حقيقية + tileload → ready=true (المسار السليم يعمل)');
}

/* 6) HTTP حقيقي: خادم محلي يعيد 200 + PNG موسوم → يُكشَف كفشل */
section('6) خادم محلي (HTTP 200 + صورة بديلة) → كشف الفشل');
{
  const pngBad = encodePng(256, 256, watermarkedPixels());
  const pngGood = encodePng(256, 256, mapLikePixels());
  const server = http.createServer((req, res) => {
    const bad = req.url.includes('wm');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(bad ? pngBad : pngGood);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const rBad = await fetch(`http://127.0.0.1:${port}/13/4808/3377-wm.png`);
  const bufBad = Buffer.from(await rBad.arrayBuffer());
  ok(rBad.status === 200 && (rBad.headers.get('content-type') || '').includes('image/png'),
    'المزوّد البديل أعاد HTTP 200 مع image/png (نجاح كاذب أمام كود ينظر للحالة فقط)');
  ok(bufBad.length < 8192, `بصمة الحجم: بلاطة موسومة مسطّحة صغيرة (${bufBad.length} B < 8KB)`);
  const decBad = decodePng(bufBad);
  const vHttp = NI.classifyTilePixels(decBad.px, decBad.w, decBad.h);
  ok(vHttp.ok === false, 'فك PNG الموسوم من HTTP 200 وتحليله → فشل مكتشف (' + vHttp.reason + ')');

  const rGood = await fetch(`http://127.0.0.1:${port}/13/4808/3377.png`);
  const bufGood = Buffer.from(await rGood.arrayBuffer());
  const decGood = decodePng(bufGood);
  const vHttpGood = NI.classifyTilePixels(decGood.px, decGood.w, decGood.h);
  ok(vHttpGood.ok === true, 'بلاطة حقيقية عبر HTTP 200 → سليمة (لا إيجابيات كاذبة)');
  server.close();
}

/* 7) embedOsmMap: النجاح = onload + فحص سليم، والفشل = watchdog/فحص فاشل + تدهور رشيق */
section('7) embedOsmMap: watchdog 8 ثوانٍ + التدهور الرشيق');
{
  // (أ) نجاح: onload + فحص سليم
  imgScenario = { mode: 'good', pixels: mapLikePixels() };
  const wrap = makeNode('div');
  const mapEl = makeNode('div');
  let failed = false;
  NM.embedOsmMap(mapEl, {
    lat: 30.0622, lng: 31.3452, meters: 500,
    title: 'خريطة تقريبية لموقع العقار — نطاق Makram Ebeid Street',
    wrap, onFail: () => { failed = true; },
    watchdogMs: 500, probeTimeoutMs: 500
  });
  const ifr = mapEl.children[0];
  ok(!!ifr && ifr.tag === 'iframe', 'يُحقن iframe داخل .nm-map-target');
  ok(ifr.loading === 'lazy', 'loading="lazy" (تحميل كسول)');
  ok(ifr.referrerPolicy === 'strict-origin-when-cross-origin', 'referrerpolicy="strict-origin-when-cross-origin"');
  ok(typeof ifr.title === 'string' && ifr.title.includes('خريطة'), 'title وصفي عربي');
  ok(ifr.style.cssText === 'width:100%;height:100%;border:0;display:block', 'الإطار يملأ الحاوية بلا CSS إضافي');
  ok(!('sandbox' in ifr.attributes), 'لا sandbox (لم يُثبت أنه لا يعطّل الخريطة)');
  ifr.onload();
  await delay(30);
  ok(!failed && wrap.classList.contains('nm-loaded'), 'onload + فحص سليم → nm-loaded بدون فشل');

  // (ب) فشل الفحص (200 موسوم) رغم onload → تدهور رشيق
  imgScenario = { mode: 'good', pixels: watermarkedPixels() };
  const wrap2 = makeNode('div');
  const mapEl2 = makeNode('div');
  let failed2 = false;
  NM.embedOsmMap(mapEl2, {
    lat: 30.0622, lng: 31.3452, meters: 500, title: 'خريطة',
    wrap: wrap2,
    onFail: () => {
      failed2 = true;
      wrap2.classList.add('nm-loaded', 'nm-failed');
      mapEl2.innerHTML = NM.failMessageHtml('https://maps.google.com/?q=30.0622,31.3452');
    },
    watchdogMs: 500, probeTimeoutMs: 500
  });
  mapEl2.children[0].onload();
  await delay(30);
  ok(failed2, 'فحص البلاطة الموسومة يُفشل الخريطة رغم إطلاق onload');
  ok(wrap2.classList.contains('nm-loaded') && wrap2.classList.contains('nm-failed'), 'D5: nm-loaded + nm-failed');
  ok(String(mapEl2.innerHTML).includes('nm-fail-msg') && String(mapEl2.innerHTML).includes('تعذّر تحميل الخريطة حاليًا'),
    'D5: رسالة «تعذّر تحميل الخريطة حاليًا»');
  ok(String(mapEl2.innerHTML).includes('Google Maps') && String(mapEl2.innerHTML).includes('maps.google.com'),
    'D5: رابط Google Maps في رسالة الفشل (لا مربع فارغ ولا skeleton)');

  // (ج) watchdog: onload لا يُطلق إطلاقًا → فشل بعد المهلة
  imgScenario = { mode: 'hang' };
  const wrap3 = makeNode('div');
  const mapEl3 = makeNode('div');
  let failed3 = false;
  NM.embedOsmMap(mapEl3, {
    lat: 30.0622, lng: 31.3452, meters: 500, title: 'خريطة',
    wrap: wrap3, onFail: () => { failed3 = true; },
    watchdogMs: 30, probeTimeoutMs: 5000
  });
  await delay(80);
  ok(failed3, 'watchdog: لا onload خلال المهلة (30ms في الاختبار / 8000ms في الإنتاج) → فشل');
  ok(NI.EMBED_WATCHDOG_MS === 8000, 'مهلة watchdog الإنتاجية = 8000ms');
}

/* 8) renderProperty/renderOffice سلوكيًا: النصوص + المسارات */
section('8) renderProperty/renderOffice: النصوص والمسارات');
function makeSectionMock(data) {
  const nodes = {
    '.nm-map-wrap': makeNode('div'),
    '.nm-map-target': makeNode('div'),
    '.nm-caption': makeNode('div'),
    '.nm-note': makeNode('div'),
    '.nm-gmaps': makeNode('a')
  };
  return {
    dataset: Object.assign({ nm: 'property', lat: '', lng: '', precision: '', location: '', title: '' }, data),
    classList: makeClassList(),
    querySelector: (sel) => nodes[sel] || null,
    _nodes: nodes
  };
}
{
  imgScenario = { mode: 'good', pixels: mapLikePixels() };
  const sec = makeSectionMock({ location: 'شارع مكرم عبيد الرئيسي - قلب مدينة نصر', title: 'شقة للبيع — مكرم عبيد' });
  NM.renderProperty(sec);
  const ifr = sec._nodes['.nm-map-target'].children[0];
  ok(!!ifr, 'street: يُحقن iframe');
  ok(ifr && ifr.src.includes('marker=30.0622%2C31.3452'), 'street: marker على مركز شارع مكرم عبيد');
  ok(ifr && /bbox=[^&]+/.test(ifr.src) && ifr.src.includes('layer=mapnik'), 'street: bbox + layer=mapnik');
  const noteHtml = sec._nodes['.nm-note'].innerHTML;
  ok(noteHtml.includes('موقع تقريبي — الإطار يوضّح نطاق') && noteHtml.includes('Makram Ebeid Street') && noteHtml.includes('500 متر'),
    'street: نص nm-note المحدَّث (الإطار يوضّح نطاق {streetEn})');
  ok(sec._nodes['.nm-caption'].textContent === 'شارع مكرم عبيد الرئيسي - قلب مدينة نصر', 'nm-caption يحتفظ بنص الموقع');
  ok(sec._nodes['.nm-gmaps'].href.includes('google.com/maps'), 'رابط Google Maps .nm-gmaps محفوظ');
  ifr.onload();
  await delay(30);
  ok(sec._nodes['.nm-map-wrap'].classList.contains('nm-loaded'), 'street: نجاح التحميل → nm-loaded');

  // area: يبقى السلوك الحالي (إزالة المربع + التنويه)
  const sec2 = makeSectionMock({ location: 'مدينة الرحاب - مجموعة 13 - خطوات من بوابة 9' });
  NM.renderProperty(sec2);
  ok(sec2._nodes['.nm-map-wrap'].removed === true, 'area: يُزال مربع الخريطة');
  ok(sec2._nodes['.nm-note'].innerHTML.includes('الموقع الدقيق للعقار يُحدَّد عند التواصل'), 'area: التنويه الحالي كما هو');
  ok(sec2._nodes['.nm-map-target'].children.length === 0, 'area: لا iframe');

  // المكتب
  imgScenario = { mode: 'good', pixels: mapLikePixels() };
  const officeSec = {
    dataset: { nm: 'office', lat: '30.0673165', lng: '31.3391426' },
    classList: makeClassList(),
    querySelector: (sel) => ({ '.nm-map-wrap': officeWrap, '.nm-map-target': officeEl })[sel] || null
  };
  const officeWrap = makeNode('div');
  const officeEl = makeNode('div');
  NM.renderOffice(officeSec);
  const oIf = officeEl.children[0];
  ok(!!oIf && oIf.src.includes('marker=30.0673'), 'المكتب: iframe + marker على إحداثيات المكتب');
  ok(oIf && /bbox=/.test(oIf.src), 'المكتب: نطاق ≈300م');
  ok(oIf && oIf.title.includes('مكتب سمسار طلبك'), 'المكتب: title وصفي');
}

/* 9) المُنتقي (agent.html): TILES = OSM فقط + الإسناد + مسار الفشل */
section('9) المُنتقي: بلاطات OSM القياسية فقط');
const tiles = NI.TILES;
ok(tiles.length === 1, 'مزود بلاطات واحد فقط');
ok(tiles[0].url === 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 'tile.openstreetmap.org/{z}/{x}/{y}.png');
ok(String(tiles[0].opts.attribution).includes('openstreetmap.org/copyright') && String(tiles[0].opts.attribution).includes('OpenStreetMap'),
  'إسناد OpenStreetMap إلزامي وظاهر');
const mapsSrc = read('assets/js/nasr-maps.js');
ok(!mapsSrc.includes('cartocdn') && !mapsSrc.includes('stadiamaps') && !mapsSrc.includes('carto.com'),
  'لا أثر لـ cartocdn/stadiamaps في nasr-maps.js');
ok(mapsSrc.includes("loading = 'lazy'") && mapsSrc.includes('strict-origin-when-cross-origin'), 'سمات الـiframe الآمنة موجودة');
ok(mapsSrc.includes('EMBED_WATCHDOG_MS = 8000'), 'watchdog 8000ms معرّف');
ok(mapsSrc.includes('probeTileProvider') && /attachTiles[\s\S]*probeTileProvider/.test(mapsSrc), 'attachTiles يفحص المزوّد (لا tileerror وحده)');
ok(mapsSrc.includes("document.createElement('iframe')"), 'الخريطة عبر iframe (D1)');
ok(mapsSrc.includes('nm-pk-manual') && mapsSrc.includes('onManual'), 'زر «اكتب يدويًا» ومسار fail() في المُنتقي محفوظان');
ok(mapsSrc.includes('minGap : 1000'), 'معدل طلب واحد/ثانية للترميز الجغرافي محفوظ');

/* 10) لا مفاتيح ولا أسرار في الملفات المعدَّلة */
section('10) لا مفاتيح ولا أسرار (يشمل ذاته)');
const SCAN_RE = new RegExp(['api', '[_-]?', 'key', '|', 'key', '=', '|', 'to', 'ken', '|', 'sec', 'ret'].join(''), 'i');
for (const f of ['assets/js/nasr-maps.js', '_diag/check-maps.mjs', '_diag/map-fix-report-2026-10-16.md']) {
  const p = path.join(ROOT, f);
  if (!existsSync(p)) { ok(f.endsWith('map-fix-report-2026-10-16.md'), '(التقرير يُكتب لاحقًا — تخطي إن لم يوجد)'); continue; }
  const text = readFileSync(p, 'utf8');
  const lines = text.split('\n');
  const hits = lines.map((l, i) => ({ l, i: i + 1 })).filter((x) => SCAN_RE.test(x.l));
  ok(hits.length === 0, f + ': صفر مطابقات لأنماط المفاتيح/الأسرار');
  for (const h of hits) console.log('    hit line ' + h.i + ': ' + h.l.slice(0, 80));
}

/* ══════════════════════════════ الملخص ══════════════════════════════ */
console.log('\n══════════════════════════════════');
if (failures.length) {
  console.log('FAILED: ' + failures.length + ' اختبارًا فشل، ' + passed + ' نجح');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL GREEN: ' + passed + ' فحصًا ناجحًا');
process.exit(0);
