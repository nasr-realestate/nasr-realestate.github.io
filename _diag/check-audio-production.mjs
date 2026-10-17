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
//
// ⚠️ 2026-10-18 — إصلاح عطل قائم: هذا الفحص كان يحمل بصمة SHA-256 وتسمية مدة
//    مكتوبتين يدويًا لإعلان `apartment-sale-hassan-hassanein-heikal-200m`. بعد
//    إعادة توليد ذلك الملف (تقرير _diag/audio-fix-hassan-hassanein-heikal-2026-10-17.md)
//    صارت القيمتان قديمتين (7d738755… و«28 ثانية» بدل 1b2289c9… و«29 ثانية»)،
//    فكان أي تشغيل يدوي بعد النشر يفشل حتمًا. صار الفحص الآن يقرأ البصمة من
//    `_data/audio_voice_log.json` وتسمية المدة من front matter العقار نفسه —
//    مصدر واحد للحقيقة فلا يتقادم مرة أخرى. وأُضيف إليه أول إعلان مُنتَج عبر
//    مسار الإنتاج الموحّد.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { grab } from './audio-check-utils.mjs';

const origin = 'https://nasr-realestate.github.io';
const slug = 'shop-rent-request-beauty-center-nasr-city';
const sourcePath = '_requests/2026-10-09-shop-rent-request-beauty-center-nasr-city.md';
const audioUrl = `/assets/audio/requests/${slug}.mp3`;
const expectedHash = '7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b';
const otherLiveRequests = ['garage-rent-request-40-buses-ismail-qabbani'];
const expiredOtherRequests = ['apartment-rent-request-art-studio-large-reception-nasr-city'];

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** سجل الإنتاج — مصدر البصمات والأحجام (انظر scripts/audio/verify-voice-identity.mjs) */
const PRODUCTION_LOG = JSON.parse(await readFile('_data/audio_voice_log.json', 'utf8'));

/** الإعلانات التي يُتحقق منها على الإنتاج بعد كل نشر. */
/** المرجع الصوتي الذي اختاره المالك — يُقرأ من المواصفة المركزية ولا يُكتب يدويًا. */
const SPEC_REFERENCE_SLUG = JSON.parse(await readFile('_data/voice_identity.json', 'utf8')).reference.slug;

const PRODUCTION_AUDIO_SLUGS = [
  'apartment-sale-hassan-hassanein-heikal-200m', // أُعيد توليده 2026-10-17
  'golden-square-garden-156m',                   // أول إعلان عبر مسار الإنتاج الموحّد 2026-10-18
];

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
  for (const other of otherLiveRequests) {
    const page = await get(`/requests/${other}/`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes('id="rqAudioBox"'), `${other}: unexpected player`);
  }
  for (const retired of expiredOtherRequests) {
    assert.ok(await isGone(`/requests/${retired}/`), `${retired}: expired request must not stay published`);
  }
  console.log(
    script
      ? 'Production: request player + script + 17s; live request unchanged (200), expired request absent.'
      : `Production: ${path} not published (expired request); live request unchanged (200), expired request absent.`,
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

/**
 * فحص إعلان عقاري منشور على الإنتاج: الصفحة + المشغّل + النص + المدة + الأصل الصوتي.
 * البصمة والحجم يُقرآن من سجل الإنتاج، وتسمية المدة من front matter العقار نفسه —
 * لا قيم مكتوبة يدويًا تتقادم.
 */
async function checkPropertyAudio(slug) {
  const entry = PRODUCTION_LOG.entries.find((e) => e.slug === slug);
  assert.ok(entry, `${slug}: لا سطر له في _data/audio_voice_log.json`);
  assert.ok(entry.propertySource, `${slug}: السطر لا يحدد ملف العقار`);
  const source = await readFile(entry.propertySource, 'utf8');
  const front = source.split(/^---\s*$/m)[1];
  const script = grab(front, 'audio_script');
  const label = grab(front, 'audio_duration');
  assert.ok(script && script.length > 80, `${slug}: audio_script ناقص`);
  assert.match(label, /^\d+ ثانية$/, `${slug}: تسمية مدة غير صالحة`);

  const pagePath = `/properties/${slug}/`;
  const audioPath = `/assets/audio/properties/${slug}.mp3`;
  assert.equal(grab(front, 'audio_file'), audioPath, `${slug}: audio_file يجب أن يعكس الـslug`);

  const page = await get(pagePath);
  const html = await page.text();
  assert.ok(html.includes(`<audio id="ppAudio" preload="none" src="${audioPath}"></audio>`), `${pagePath}: المشغّل مفقود`);
  assert.ok(html.includes(script), `${pagePath}: نص الإعلان غير ظاهر`);
  assert.ok(html.includes(label), `${pagePath}: تسمية المدة ${label} غير ظاهرة`);

  const response = await get(audioPath);
  assert.match(response.headers.get('content-type') ?? '', /audio\/mpeg/, `${audioPath}: MIME`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha(bytes), entry.sha256, `${audioPath}: بصمة الإنتاج ≠ الأصل الملتزم في المستودع`);
  assert.equal(bytes.length, entry.bytes, `${audioPath}: حجم الإنتاج ≠ الحجم الملتزم`);
  assert.equal(bytes.subarray(0, 3).toString(), 'ID3', `${audioPath}: ليس MP3 موسومًا`);
  assert.equal(bytes[3], 3, `${audioPath}: يجب أن يكون ID3v2.3`);

  const range = await get(audioPath, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206, `${audioPath}: طلب Range`);
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`, `${audioPath}: content-range`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024), `${audioPath}: محتوى Range`);
  console.log(`Production: ${pagePath} + ${audioPath} HTTP 200, audio/mpeg, Range 206, SHA-256 ${entry.sha256.slice(0, 16)}… (${label}).`);
}

await checkPages();
await checkAudio();
for (const productionSlug of PRODUCTION_AUDIO_SLUGS) await checkPropertyAudio(productionSlug);

// المرجع الذي اختاره المالك: يُتحقق من صفحته وأصله الصوتي كاملًا لا من وجود المشغّل فقط.
await checkPropertyAudio(SPEC_REFERENCE_SLUG);
const property = await get(`/properties/${SPEC_REFERENCE_SLUG}/`);
assert.ok((await property.text()).includes('id="ppAudioBox"'), 'old property player missing in production');
console.log('Production: existing property player still present.');
