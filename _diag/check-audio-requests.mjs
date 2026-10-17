// Request-audio gate: every request page must be consistent with its front matter.
// Usage after `bundle exec jekyll build`: node _diag/check-audio-requests.mjs [siteDir]
//
// ⚠️ إصلاح 2026-10-16 — كان هذا الفحص يفشل حتمًا على أي PR يلمس مسارًا من مسارات
//    verify-audio-pages.yml، بلا أي علاقة بالـ PR نفسه:
//
//      d0ff0fd  2026-10-16 01:51  System: Auto-cleanup of expired requests (7-day rule from front matter)
//
//    حذف الالتزام المجدول أعلاه طلب `shop-rent-request-beauty-center-nasr-city`
//    (date: 2026-10-09) عند حد السبعة أيام بالضبط، ودفع الحذف إلى master — تمامًا
//    كما وُعد في _diag/audio-requests-batch1-2026-10-15.md بأن الطلب «ينتهي أجله
//    وفق قاعدة السبعة أيام». لكن هذا الملف كان يشترط `collection.length >= 3`
//    ويطلب صفحة الطلب المحذوف ⇒ إخفاق مؤجَّل بمؤقّت، ظهر أول مرة على PR #61.
//    إعادة الملف ليست حلًا: الالتزام المجدول نفسه سيحذفه في أول تشغيل تالٍ
//    (2026-10-09 أصغر من أي حد لاحق)، فيعود الإخفاق يوميًا.
//
//    القاعدة المطبَّقة: **التوقعات تُشتق من المستودع**، لا من قائمة ملفات ثابتة.
//      • الطلبات الحيّة المحمية فقط مطلوبة؛ بصماتها لا تتغيّر.
//      • طلب الاستوديو الفني (2026-10-10) انتهى أجله وفق قاعدة السبعة أيام يوم 2026-10-17؛
//        لا يُشترط بقاؤه. إذا عاد الملف، تُراجع بصمته الأصلية المحفوظة أدناه.
//      • الطلب المنتهي ذو الإعلان الصوتي معروف بالاسم والبصمة: لو عاد الملف يُفحص
//        فورًا بكل صرامة الطلب الحيّ؛ ويُفحص ملفه الصوتي الباقي ولا يُسقط البناء.
//      • أي MP3 آخر بلا طلب حيّ = فشل: لا يتسلل ملف صوتي مجهول إلى المستودع.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { grab, id3Frames, occurrences, parseComm, parseTextFrame } from './audio-check-utils.mjs';

const outDir = process.argv[2] ?? '_site';
const AUDIO_DIR = path.join('assets', 'audio', 'requests');

/** طلبات لا يُسمح بتغييرها: بصمة الملف كما هي. */
const LOCKED_SOURCES = new Map([
  ['garage-rent-request-40-buses-ismail-qabbani', 'a187978538248425d46c941565e533a45aa28ebb69f7558c1da138c692cf9ed4'],
]);

/** طلب قديم انتهى أجله؛ لا يُشترط وجوده لكن إن عاد يجب أن يكون بايتًا كما كان. */
const RETIRED_SOURCE_ONLY = new Map([
  ['apartment-rent-request-art-studio-large-reception-nasr-city', 'dec0f7ab05797d413ca35f2d702414f189fcda4f879d1c8e82bddd8da6e7261e'],
]);

/**
 * طلب انتهى أجله وحُذف آليًا (قاعدة السبعة أيام) بينما بقي إعلانه الصوتي المنشور
 * في assets/audio/requests. البصمات هي نفسها المعلنة في درع batch 1 الأصلي،
 * فلو عاد الملف إلى `_requests` يُفحص فورًا بلا أي تخفيف.
 */
const RETIRED = {
  slug: 'shop-rent-request-beauty-center-nasr-city',
  /** بصمة الملف بعد إزالة سطور الصوت الأربعة (ثابتة من الفحص الأصلي). */
  originalSource: '3aec7689aa139d68be565b7420db81df62e9383361ca40595c96b56e38e7c3a9',
  mp3Sha: '7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b',
  titleIncludes: 'محل بيوتي سنتر',
  /** مدة الإعلان كما تُعرض: تقريب لأعلى من 16.368 ثانية. */
  duration: '17 ثانية',
};

const EXPECTED_MP3 = new Map([[RETIRED.slug, RETIRED.mp3Sha]]);
const EXPECTED_DURATION = new Map([[RETIRED.slug, RETIRED.duration]]);

const ID_FRAMES = ['TIT2', 'TPE1', 'TALB', 'TDRC', 'TCON', 'TSSE', 'COMM'];
const METADATA = new Map([
  ['TPE1', 'سمسار طلبك — طارق طنطاوي'],
  ['TALB', 'إعلانات سمسار طلبك'],
  ['TDRC', '2026-10-15'],
  ['TCON', 'إعلان عقاري'],
  ['TSSE', 'Lavf59.27.100'],
]);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isTrueField = (front, field) => new RegExp(`^${field}:\\s*true\\s*$`, 'm').test(front);
const isFalseField = (front, field) => new RegExp(`^${field}:\\s*false\\s*$`, 'm').test(front);

/** الطلبات المقفلة: بصمتها لا تتغيّر. */
function checkLockedSource(slug, source) {
  const expected = LOCKED_SOURCES.get(slug);
  if (expected) assert.equal(sha(source), expected, `${slug}: a request that must stay untouched was modified`);
}

/** طلب منتهي عاد للظهور: يُفحص بنفس صرامة الطلب الحيّ. */
function checkRetiredSourceReturned(slug, source, front) {
  const restored = source.replace(/^audio_(?:ad|file|duration|script):.*\n/gm, '');
  assert.equal(sha(restored), RETIRED.originalSource, `${slug}: non-audio request data changed`);
  for (const field of ['audio_ad', 'audio_file', 'audio_duration', 'audio_script']) {
    assert.equal(occurrences(front, `${field}:`), 1, `${slug}: exactly one ${field} field`);
  }
  assert.match(front, /^date: 2026-10-09$/m, `${slug}: front-matter date (not Git date)`);
  assert.match(front, /^title: .*محل.*للإيجار/m, `${slug}: type and transaction`);
  assert.match(grab(front, 'meta_description'), /60 إلى 80 متر/, `${slug}: specified area in front matter`);
  assert.match(grab(front, 'budget'), /15,000 إلى 20,000/, `${slug}: numeric monthly budget`);
  assert.match(grab(front, 'location'), /شارع النزهة، المربع الذهبي/, `${slug}: specific location`);
  assert.ok(isTrueField(front, 'audio_ad'), `${slug}: audio opt-in`);
}

/** وسوم ID3 وبصمة الملف — تُفحص لأي إعلان صوتي موجود. */
function checkMp3Bytes(slug, bytes, script) {
  assert.ok(bytes.length > 1000, `${slug}: MP3 not empty`);
  const expected = EXPECTED_MP3.get(slug);
  if (expected) assert.equal(sha(bytes), expected, `${slug}: MP3 drifted`);
  assert.deepEqual(bytes.subarray(0, 5), Buffer.from([73, 68, 51, 3, 0]), `${slug}: ID3v2.3 header`);
  const frames = id3Frames(bytes);
  assert.ok(frames, `${slug}: malformed ID3 frames`);
  assert.deepEqual(frames.map((frame) => frame.id), ID_FRAMES, `${slug}: ID3 frame order / no extra tags`);
  for (const frame of frames) assert.equal(frame.body[0], 1, `${slug}: ${frame.id} must be UTF-16`);
  for (const [id, value] of METADATA) {
    assert.equal(parseTextFrame(frames.find((frame) => frame.id === id)), value, `${slug}: ${id} value`);
  }
  if (slug === RETIRED.slug) assert.ok(parseTextFrame(frames[0]).includes(RETIRED.titleIncludes), `${slug}: TIT2 request title`);
  const comm = frames.at(-1).body;
  assert.deepEqual([...comm.subarray(1, 8)], [97, 114, 97, 255, 254, 0, 0], `${slug}: COMM must be ara with an empty description`);
  // مقارنة COMM بنص الإعلان ممكنة فقط حين تكون الصفحة موجودة (النص مصدره front matter).
  if (script !== undefined) assert.equal(parseComm(bytes), script, `${slug}: COMM must equal audio_script verbatim`);
}

/** صفحة الطلب مع إعلان صوتي: المشغّل في مكانه، والنص كما هو، والمدة معقولة. */
function checkRequestWithPlayer(slug, front, html, bytes) {
  assert.equal(occurrences(html, 'id="rqAudioBox"'), 1, `${slug}: exactly one request player`);
  assert.match(html, /dir="rtl"/, `${slug}: RTL document`);
  assert.ok(html.includes('اسمع الإعلان الصوتي للطلب'), `${slug}: request player heading`);
  const contentAt = html.indexOf('class="rq-description"');
  const playerAt = html.indexOf('id="rqAudioBox"');
  const actionsAt = html.indexOf('class="rq-actions"');
  assert.ok(contentAt >= 0 && contentAt < playerAt && playerAt < actionsAt, `${slug}: player must sit between the description and the CTA`);

  const url = `/assets/audio/requests/${slug}.mp3`;
  assert.equal(grab(front, 'audio_file'), url, `${slug}: audio_file must mirror the front-matter slug`);
  assert.ok(html.includes(`<audio id="rqAudio" preload="none" src="${url}"></audio>`), `${slug}: src/preload, and no autoplay`);
  assert.equal(occurrences(html, 'id="rqAudio"'), 1, `${slug}: exactly one audio element`);
  assert.ok(html.includes('نص الإعلان الصوتي'), `${slug}: script disclosure`);

  const script = grab(front, 'audio_script');
  assert.ok(script && html.includes(script), `${slug}: verbatim script must be rendered`);

  const label = grab(front, 'audio_duration');
  assert.match(label, /^\d+ ثانية$/, `${slug}: duration label format`);
  assert.ok(Number.parseInt(label, 10) <= 30, `${slug}: label longer than 30s`);
  const expectedLabel = EXPECTED_DURATION.get(slug);
  if (expectedLabel) assert.equal(label, expectedLabel, `${slug}: duration rounded up from the measured length`);

  checkMp3Bytes(slug, bytes, script);
  console.log(`${slug}: page, script, ID3v2.3, SHA-256 and ${label} OK — ${bytes.length} B`);
}

/** أي صفحة طلب أخرى: لا يتسرّب إليها مشغّل صوتي. */
function checkRequestWithoutPlayer(slug, html) {
  assert.ok(!html.includes('id="rqAudioBox"') && !html.includes('id="rqAudio"'), `${slug}: an audio player leaked into a request that did not opt in`);
}

// ─── الطلبات الحيّة ───────────────────────────────────────────────────────
const collection = (await readdir('_requests')).filter((name) => name.endsWith('.md')).sort();
assert.ok(collection.length > 0, 'the request collection is empty');

const sourceBySlug = new Map();
for (const name of collection) {
  const source = await readFile(path.join('_requests', name), 'utf8');
  const front = source.split(/^---\s*$/m)[1];
  assert.ok(front, `${name}: front matter missing`);
  const slug = grab(front, 'slug');
  assert.ok(slug, `${name}: slug missing`);
  assert.ok(!sourceBySlug.has(slug), `${slug}: duplicate slug`);
  sourceBySlug.set(slug, { source, front });
}

// الطلب المنتهي لا يُطلب بقاؤه؛ إن عاد، يمنع هذا الفحص تغيّر بياناته الأصلية.
for (const [slug, expectedHash] of RETIRED_SOURCE_ONLY) {
  const restored = sourceBySlug.get(slug);
  if (restored) assert.equal(sha(restored.source), expectedHash, `${slug}: retired request changed if restored`);
}

// حرس ضد الحذف غير المقصود للطلبات الحيّة المعروفة.
for (const slug of LOCKED_SOURCES.keys()) {
  assert.ok(sourceBySlug.has(slug), `${slug}: a known live request disappeared from _requests`);
}

const withAudio = new Set();
for (const [slug, { source, front }] of sourceBySlug) {
  const html = await readFile(path.join(outDir, 'requests', slug, 'index.html'), 'utf8');
  if (isTrueField(front, 'audio_ad')) {
    withAudio.add(slug);
    const built = await readFile(path.join(outDir, AUDIO_DIR, `${slug}.mp3`));
    if (slug === RETIRED.slug) checkRetiredSourceReturned(slug, source, front);
    checkRequestWithPlayer(slug, front, html, built);
  } else {
    assert.ok(!isTrueField(front, 'audio_ad') && (isFalseField(front, 'audio_ad') || !/^audio_ad:/m.test(front)), `${slug}: unclear audio opt-out`);
    checkRequestWithoutPlayer(slug, html);
  }
  checkLockedSource(slug, source);
}

// ─── الملاذات الصوتية: نسخة البناء مطابقة، ولا يتيم إلا المعروف ────────────
const mp3Files = (await readdir(AUDIO_DIR)).filter((name) => name.endsWith('.mp3')).sort();
const orphans = [];
for (const file of mp3Files) {
  const slug = file.replace(/\.mp3$/, '');
  const sourceBytes = await readFile(path.join(AUDIO_DIR, file));
  // Jekyll ينسخ assets كما هي: غياب النسخة المبنية = رابط 404 في الإنتاج.
  const builtBytes = await readFile(path.join(outDir, AUDIO_DIR, file));
  assert.equal(sha(builtBytes), sha(sourceBytes), `${slug}: built MP3 differs from the source asset`);
  checkMp3Bytes(slug, sourceBytes, undefined);
  if (withAudio.has(slug)) continue;
  assert.equal(slug, RETIRED.slug, `${slug}: an audio file exists for a request that is neither live-and-opted-in nor the known retired one`);
  orphans.push(file);
}

if (orphans.length) {
  console.log(`ℹ️  ${orphans.join(', ')}: طلب منتهي حُذف آليًا بقاعدة السبعة أيام (d0ff0fd) وصفحته لم تعد في البناء؛ الملف الصوتي المنشور باقٍ ومُتحقَّق منه.`);
}
console.log(
  `${collection.length} request page(s): ${withAudio.size} with an audio player, ${collection.length - withAudio.size} without` +
  (orphans.length ? `; ${orphans.length} retired audio file(s) verified and left published.` : '.'),
);
