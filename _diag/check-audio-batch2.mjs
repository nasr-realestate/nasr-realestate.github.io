// Build-only regression check for the five audio ads (no site/runtime dependencies).
// Usage after `bundle exec jekyll build`: node _diag/check-audio-batch2.mjs
// The _diag/ directory is private to the source tree: Jekyll does not publish it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const site = process.argv[2] || '_site';
const expected = new Set([
  'furnished-apartment-rent-hayat-compound-safarat-200m',
  'luxury-apartment-rent-al-azhar-street-nasr-city-200m',
  'apartment-sale-gamal-afifi-ahly-club-250m',
  'office-storage-rent-hassanein-heikal-nasr-city-73m',
  'apartment-sale-egyptair-nasr-city-125m-furnished',
]);
const reference = 'apartment-sale-helmy-abdel-aaty-seraj-mall-230m';
const referenceSHA256 = 'fb1ff292d14736bcb49593d834cfba58b246a1a6bc058f7ff83a74fda0e3720a';
const actual = new Set();
const properties = (await readdir('_properties')).filter(name => name.endsWith('.md'));

function field(frontMatter, key) {
  const match = frontMatter.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm'));
  assert.ok(match, `missing ${key}`);
  return match[1];
}

for (const property of properties) {
  const source = await readFile(path.join('_properties', property), 'utf8');
  const front = source.split(/^---\s*$/m)[1];
  assert.ok(front, `front matter missing in ${property}`);
  const slug = field(front, 'slug');
  const html = await readFile(path.join(site, 'properties', slug, 'index.html'), 'utf8');
  const audioEnabled = /^audio_ad:\s*true\s*$/m.test(front);
  if (!audioEnabled) {
    assert.ok(!html.includes('id="ppAudioBox"'), `unexpected player on ${slug}`);
    continue;
  }
  actual.add(slug);
  assert.equal((html.match(/id="ppAudioBox"/g) || []).length, 1, `${slug}: player count`);
  assert.ok(html.includes('dir="rtl"'), `${slug}: document direction`);
  assert.ok(html.includes('اسمع الإعلان الصوتي للعقار'), `${slug}: original player label`);
  assert.ok(html.includes('class="pp-specs"') && html.includes('class="pp-actions"'), `${slug}: position`);
  const mp3URL = field(front, 'audio_file');
  assert.equal(mp3URL, `/assets/audio/properties/${slug}.mp3`, `${slug}: wrong MP3 link`);
  assert.ok(html.includes(`<audio id="ppAudio" preload="none" src="${mp3URL}"></audio>`),
    `${slug}: wrong src, autoplay, or eager loading`);
  const bytes = await readFile(path.join(site, mp3URL.slice(1)));
  assert.ok(bytes.length > 1000 && bytes.subarray(0, 3).toString() === 'ID3', `${slug}: missing MP3 bytes`);
  assert.ok(html.includes('نص الإعلان الصوتي'), `${slug}: missing script disclosure`);
  console.log(`${slug}: built page + local MP3 + scoped player OK (${bytes.length} bytes)`);
}
assert.ok(properties.length >= 6, 'property collection missing');
assert.deepEqual(actual, new Set([...expected, reference]), 'audio feature was widened, narrowed, or moved');
const referenceBytes = await readFile(`assets/audio/properties/${reference}.mp3`);
assert.equal(createHash('sha256').update(referenceBytes).digest('hex'), referenceSHA256, 'reference audio changed');
console.log(`${properties.length} property pages checked: five new ads + unchanged reference; ${properties.length - 6} others without player.`);
