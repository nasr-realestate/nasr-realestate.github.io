// Post-deploy smoke test, run manually by the non-deployment audio verification workflow.
// Unlike the build-only gate, this fetches the public GitHub Pages origin itself.
//
// ⚠️ 2026-10-16 — الطلب `shop-rent-request-beauty-center-nasr-city` انتهى أجله
//    (date: 2026-10-09) فحذفه الالتزام المجدول d0ff0fd («قاعدة السبعة أيام»)، وبذلك
//    اختفت صفحته من الموقع المنشور. كان هذا الملف يقرأ ملف الطلب في أول سطر فيسقط
//    بـ ENOENT عند أي تشغيل يدوي بعد الحذف. صار الآن يميّز حالتين ولا يفترض واحدة:
//      • حيّ: صفحة الطلب موجودة ⇒ كل التحققات كما كانت بالضبط (مشغّل + نص + 17 ثانية).
//      • منتهٍ: ملف الطلب محذوف ⇒ يتأكد أن الصفحة **لم تعد تُنشر**، ويبقي فحص الأصل
//        الصوتي المنشور (200 + audio/mpeg + SHA-256 + Range) لأنه ما زال رابطًا عامًا.
//    لا يُخفَّف أي تحقق قائم في الحالتين.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { grab } from './audio-check-utils.mjs';

const origin = 'https://nasr-realestate.github.io';
const slug = 'shop-rent-request-beauty-center-nasr-city';
const sourcePath = '_requests/2026-10-09-shop-rent-request-beauty-center-nasr-city.md';
const audioUrl = `/assets/audio/requests/${slug}.mp3`;
const expectedHash = '7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b';
const otherRequests = [
  'apartment-rent-request-art-studio-large-reception-nasr-city',
  'garage-rent-request-40-buses-ismail-qabbani',
];

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** ملف الطلب نفسه موجود في المستودع؟ (غيابه = انتهى الأجل، لا خطأ في الفحص) */
const source = await readFile(sourcePath, 'utf8').catch(() => null);
if (!source) {
  console.log(`ℹ️  ${sourcePath} غير موجود: الطلب انتهى أجله وحُذف آليًا (7 أيام) — وضع «منتهٍ».`);
}
const script = source ? grab(source.split(/^---\s*$/m)[1], 'audio_script') : null;

async function get(path, options) {
  const response = await fetch(origin + path, { redirect: 'error', ...options });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}

/** هل الصفحة غير منشورة الآن؟ (404 صريح، أو منع إعادة التوجيه عند غياب المورد) */
async function isGone(path) {
  try {
    const response = await fetch(origin + path, { redirect: 'error' });
    return response.status === 404;
  } catch {
    return true;
  }
}

async function checkPages() {
  const path = `/requests/${slug}/`;
  if (script) {
    const response = await get(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`<audio id="rqAudio" preload="none" src="${audioUrl}"></audio>`), `${path}: no player`);
    assert.ok(html.includes(script), `${path}: script not rendered`);
    assert.ok(html.includes('17 ثانية'), `${path}: duration missing`);
  } else {
    assert.ok(await isGone(path), `${path}: an expired request must not stay published`);
  }
  for (const other of otherRequests) {
    const page = await get(`/requests/${other}/`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes('id="rqAudioBox"'), `${other}: unexpected player`);
  }
  console.log(
    script
      ? 'Production: request player + script + 17s; 2 others unchanged (200).'
      : `Production: ${path} not published (expired request), 2 others unchanged (200).`,
  );
}

async function checkAudio() {
  const response = await get(audioUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /audio\/mpeg/, 'MP3 MIME');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha(bytes), expectedHash, 'production MP3 hash differs from committed asset');
  const range = await get(audioUrl, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206, 'production Range request');
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
  console.log(`Production: ${audioUrl} HTTP 200 audio/mpeg, Range 206, SHA-256 ${expectedHash}.`);
}

async function checkNewPropertyAudio() {
  const slug = 'apartment-sale-hassan-hassanein-heikal-200m';
  const source = await readFile(`_properties/2026-10-17-${slug}.md`, 'utf8');
  const front = source.split(/^---\s*$/m)[1];
  const script = grab(front, 'audio_script');
  const pagePath = `/properties/${slug}/`;
  const audioPath = `/assets/audio/properties/${slug}.mp3`;
  const page = await get(pagePath);
  const html = await page.text();
  assert.ok(html.includes(`src="${audioPath}"`), `${pagePath}: player source missing`);
  assert.ok(html.includes(script), `${pagePath}: script missing`);
  assert.ok(html.includes('28 ثانية'), `${pagePath}: duration missing`);

  const response = await get(audioPath);
  assert.match(response.headers.get('content-type') ?? '', /audio\/mpeg/, 'property MP3 MIME');
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = '7d738755536bb4a0808c0ebfb1bfce963d8c9b7992d89e3620123141b7966629';
  assert.equal(sha(bytes), expected, 'new property MP3 differs from committed asset');
  const range = await get(audioPath, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206, 'new property MP3 Range request');
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
  assert.equal(bytes.subarray(0, 3).toString(), 'ID3');
  assert.equal(bytes[3], 3, 'new property MP3 must use ID3v2.3');
  console.log(`Production: ${pagePath} + ${audioPath} HTTP 200, audio/mpeg, Range 206, SHA-256 ${expected}.`);
}

await checkPages();
await checkAudio();
await checkNewPropertyAudio();
const property = await get('/properties/apartment-sale-helmy-abdel-aaty-seraj-mall-230m/');
assert.ok((await property.text()).includes('id="ppAudioBox"'), 'old property player missing in production');
console.log('Production: existing property player still present.');
