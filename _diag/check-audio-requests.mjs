// Request-audio batch 1: one eligible ad; the other two requests have incomplete data.
// Usage after `bundle exec jekyll build`: node _diag/check-audio-requests.mjs [siteDir]
// The existing property gate runs separately and locks the 26 earlier MP3s.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { grab, id3Frames, occurrences, parseComm, parseTextFrame } from './audio-check-utils.mjs';

const outDir = process.argv[2] ?? '_site';
const slug = 'shop-rent-request-beauty-center-nasr-city';
const audioHash = '7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b';
const originalSource = '3aec7689aa139d68be565b7420db81df62e9383361ca40595c96b56e38e7c3a9';
const untouchedSources = new Map([
  ['apartment-rent-request-art-studio-large-reception-nasr-city', 'dec0f7ab05797d413ca35f2d702414f189fcda4f879d1c8e82bddd8da6e7261e'],
  ['garage-rent-request-40-buses-ismail-qabbani', 'a187978538248425d46c941565e533a45aa28ebb69f7558c1da138c692cf9ed4'],
]);
const ids = ['TIT2', 'TPE1', 'TALB', 'TDRC', 'TCON', 'TSSE', 'COMM'];
const metadata = new Map([
  ['TPE1', 'سمسار طلبك — طارق طنطاوي'],
  ['TALB', 'إعلانات سمسار طلبك'],
  ['TDRC', '2026-10-15'],
  ['TCON', 'إعلان عقاري'],
  ['TSSE', 'Lavf59.27.100'],
]);

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkOriginalSource(source, front) {
  const restored = source.replace(/^audio_(?:ad|file|duration|script):.*\n/gm, '');
  assert.equal(sha(restored), originalSource, 'non-audio request data changed');
  for (const field of ['audio_ad', 'audio_file', 'audio_duration', 'audio_script']) {
    assert.equal(occurrences(front, `${field}:`), 1, `exactly one ${field} field`);
  }
  assert.match(front, /^date: 2026-10-09$/m, 'front-matter date (not Git date)');
  assert.match(front, /^title: .*محل.*للإيجار/m, 'type and transaction');
  assert.match(grab(front, 'meta_description'), /60 إلى 80 متر/, 'specified area in front matter');
  assert.match(grab(front, 'budget'), /15,000 إلى 20,000/, 'numeric monthly budget');
  assert.match(grab(front, 'location'), /شارع النزهة، المربع الذهبي/, 'specific location');
  assert.match(front, /^audio_ad: true$/m);
}

function checkMetadata(bytes, script) {
  assert.ok(bytes.length > 1000, 'MP3 not empty');
  assert.equal(sha(bytes), audioHash, 'new MP3 drifted');
  assert.deepEqual(bytes.subarray(0, 5), Buffer.from([73, 68, 51, 3, 0]), 'ID3v2.3 header');
  const frames = id3Frames(bytes);
  assert.ok(frames, 'malformed ID3 frames');
  assert.deepEqual(frames.map((frame) => frame.id), ids, 'ID3 frame order / no extra tags');
  for (const frame of frames) assert.equal(frame.body[0], 1, `${frame.id}: UTF-16`);
  for (const [id, expected] of metadata) {
    assert.equal(parseTextFrame(frames.find((frame) => frame.id === id)), expected, `${id}: value`);
  }
  assert.ok(parseTextFrame(frames[0]).includes('محل بيوتي سنتر'), 'TIT2: request title');
  const comm = frames.at(-1).body;
  assert.deepEqual([...comm.subarray(1, 8)], [97, 114, 97, 255, 254, 0, 0], 'COMM: ara, empty description');
  assert.equal(parseComm(bytes), script, 'COMM must equal audio_script verbatim');
}

function checkPlayer(front, html, bytes) {
  checkOriginalSource(sourceBySlug.get(slug), front);
  assert.equal(occurrences(html, 'id="rqAudioBox"'), 1, 'exactly one request player');
  assert.match(html, /dir="rtl"/, 'RTL document');
  assert.ok(html.includes('اسمع الإعلان الصوتي للطلب'), 'request player heading');
  const contentAt = html.indexOf('class="rq-description"');
  const playerAt = html.indexOf('id="rqAudioBox"');
  const actionsAt = html.indexOf('class="rq-actions"');
  assert.ok(contentAt >= 0 && contentAt < playerAt && playerAt < actionsAt, 'position before CTA');
  const url = `/assets/audio/requests/${slug}.mp3`;
  assert.equal(grab(front, 'audio_file'), url, 'audio_file mirrors front-matter slug');
  assert.ok(html.includes(`<audio id="rqAudio" preload="none" src="${url}"></audio>`), 'src/preload/no autoplay');
  assert.equal(occurrences(html, 'id="rqAudio"'), 1, 'exactly one audio element');
  assert.ok(html.includes('نص الإعلان الصوتي'), 'script disclosure');
  const script = grab(front, 'audio_script');
  assert.ok(html.includes(script), 'verbatim script rendered');
  const label = grab(front, 'audio_duration');
  assert.match(label, /^\d+ ثانية$/, 'duration label format');
  assert.ok(Number.parseInt(label, 10) <= 30, 'label longer than 30s');
  assert.equal(label, '17 ثانية', 'duration rounded up from the measured 16.368s');
  checkMetadata(bytes, script);
  console.log(`${slug}: built page, script, ID3v2.3, SHA-256 and ${label} OK (${bytes.length} B)`);
}

const collection = (await readdir('_requests')).filter((name) => name.endsWith('.md'));
const sourceBySlug = new Map();
const seen = new Set();
for (const name of collection) {
  const source = await readFile(path.join('_requests', name), 'utf8');
  const front = source.split(/^---\s*$/m)[1];
  assert.ok(front, `${name}: front matter missing`);
  const id = grab(front, 'slug');
  assert.ok(!sourceBySlug.has(id), `${id}: duplicate slug`);
  sourceBySlug.set(id, source);
  const html = await readFile(path.join(outDir, 'requests', id, 'index.html'), 'utf8');
  if (id !== slug) {
    assert.ok(!/^audio_ad:\s*true\s*$/m.test(front), `${id}: unexpected audio opt-in`);
    assert.ok(!html.includes('id="rqAudioBox"') && !html.includes('id="rqAudio"'), `${id}: player leaked`);
    if (untouchedSources.has(id)) assert.equal(sha(source), untouchedSources.get(id), `${id}: modified excluded request`);
    continue;
  }
  seen.add(id);
  const file = path.join('assets', 'audio', 'requests', `${id}.mp3`);
  const bytes = await readFile(path.join(outDir, file));
  assert.equal(sha(await readFile(file)), sha(bytes), 'built MP3 differs from source');
  checkPlayer(front, html, bytes);
}
assert.ok(collection.length >= 3, 'request collection shrank');
assert.deepEqual([...seen], [slug], 'selected request missing from build');
const audioFiles = (await readdir('assets/audio/requests')).filter((name) => name.endsWith('.mp3'));
assert.deepEqual(audioFiles, [`${slug}.mp3`], 'unexpected request audio file');
console.log(`${collection.length} request pages: 1 with audio; ${collection.length - 1} unchanged without player.`);
