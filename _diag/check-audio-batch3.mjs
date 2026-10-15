// Build-only regression check for batch 3 (ten audio ads) + the six earlier ads.
// Usage after `bundle exec jekyll build`: node _diag/check-audio-batch3.mjs
// The _diag/ directory is private to the source tree: Jekyll does not publish it.
// Supersedes check-audio-batch2.mjs (kept as the historical snapshot of batch 2):
// batch 3 intentionally widens the audio feature from 6 to 16 pages, so the new
// expected set lives here. Every assertion of batch 2 is preserved and extended.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const site = process.argv[2] || '_site';

// ── batch 2 (unchanged reference + five ads) ──
const batch2 = new Set([
  'apartment-sale-helmy-abdel-aaty-seraj-mall-230m', // PoC reference (batch 1)
  'furnished-apartment-rent-hayat-compound-safarat-200m',
  'luxury-apartment-rent-al-azhar-street-nasr-city-200m',
  'apartment-sale-gamal-afifi-ahly-club-250m',
  'office-storage-rent-hassanein-heikal-nasr-city-73m',
  'apartment-sale-egyptair-nasr-city-125m-furnished',
]);

// ── batch 3 (ten new ads) ──
const batch3 = new Set([
  'administrative-unit-rent-nasr-city-41m',
  'apartment-rent-gamal-dewidar-enppi-nasr-city-160m',
  'rent-waha-50th-street-163m',
  'makram-ebid-177m',
  'apartment-sale-makarif-6th-district-130m',
  'apartment-sale-rabaa-investment-abbas-elakkad-165m',
  'rent-abdel-hamid-lotfy-tayaran-150m',
  'apartment-sale-abdul-halim-abdullah-195m',
  'commercial-shop-for-rent-nozha-street-nasr-city',
  'rehab-villa-model-h-gate9',
]);

// Lock every MP3 produced so far (SHA-256): the six earlier ads must stay
// byte-identical, and the ten new ones must not change after approval.
const mp3SHA256 = {
  'apartment-sale-helmy-abdel-aaty-seraj-mall-230m': 'fb1ff292d14736bcb49593d834cfba58b246a1a6bc058f7ff83a74fda0e3720a',
  'furnished-apartment-rent-hayat-compound-safarat-200m': '42e7026d9dbca88d59483390760bf50bb457fa8b2ff762ba11f610211f8f85b9',
  'luxury-apartment-rent-al-azhar-street-nasr-city-200m': '9f5c4d9a4c1ad4a62f1a913070fc7dfdd95df3989db3f1ae974c1dd67aa3f064',
  'apartment-sale-gamal-afifi-ahly-club-250m': '2eb4e243fb6a4acdcd2ee316b8a558c75681c24b3ddc88dbf41aa1b754a85762',
  'office-storage-rent-hassanein-heikal-nasr-city-73m': '3905ec0ae9d9f2d84cb27fe2975a9c1981fab0e074c69e24c1ad2ce4c42e7ce6',
  'apartment-sale-egyptair-nasr-city-125m-furnished': '4e5346e80eb21b45009544b0982d7d28ba5de00e430595e1fc4a7da31e0105d4',
  'administrative-unit-rent-nasr-city-41m': '5d3e6fdc1419662f3e88109a5732e8f0c62387ec1564aa3c97b5791ed85c6ee2',
  'apartment-rent-gamal-dewidar-enppi-nasr-city-160m': '8156b84f42e0ee0fded536e04d8bcec6bf774e58c04eba2032a95fa67164a148',
  'rent-waha-50th-street-163m': '5ad389d1b121bf3fe310d678fdc70047e6ced38c84af25236d13400ef2430f1b',
  'makram-ebid-177m': 'a24a30befbf44af1973e3afe0525c10df8c85477d2fd80a0a2cb02b3ab7f196e',
  'apartment-sale-makarif-6th-district-130m': '4d5fc7d29eaf113f7c3e45246333ad9e3b3a64093f90107bd853d1b0411d68cb',
  'apartment-sale-rabaa-investment-abbas-elakkad-165m': '766a5f7a9f66691dee286c67016be883ae36be560f40a36e185b97a294950c3f',
  'rent-abdel-hamid-lotfy-tayaran-150m': '79b189395d25b0311353f35c4b074da4a41c1dbbfdb50809bec7724ee3e1b345',
  'apartment-sale-abdul-halim-abdullah-195m': '41144f92e1db328a326e9a49757dd603fe490f2d8fc9468f23a54c030584b3d6',
  'commercial-shop-for-rent-nozha-street-nasr-city': '89cbcf9f3056d8dd9e04f1fb89f701bd3e53ffb70d645f07bf5321f2f21e4d34',
  'rehab-villa-model-h-gate9': 'f49fb304f877e442a3fead8821354873fbadbd01652c50080e5b295daef20427',
};

const expected = new Set([...batch2, ...batch3]);
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
    assert.ok(!html.includes('id="ppAudio"'), `unexpected audio element on ${slug}`);
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
  assert.equal(createHash('sha256').update(bytes).digest('hex'), mp3SHA256[slug], `${slug}: MP3 changed`);
  assert.ok(html.includes('نص الإعلان الصوتي'), `${slug}: missing script disclosure`);
  const script = field(front, 'audio_script');
  assert.ok(script.length > 80 && html.includes(script.slice(0, 40)), `${slug}: script not printed`);
  const duration = field(front, 'audio_duration');
  assert.ok(/^\d+ ثانية$/.test(duration), `${slug}: audio_duration format`);
  assert.ok(parseInt(duration, 10) <= 30, `${slug}: over 30 seconds`);
  console.log(`${slug}: built page + local MP3 + scoped player OK (${bytes.length} bytes, ${duration})`);
}

assert.ok(properties.length >= 16, 'property collection missing');
assert.deepEqual(actual, expected, 'audio feature was widened, narrowed, or moved');
for (const slug of batch2) {
  assert.ok(actual.has(slug), `earlier ad lost: ${slug}`);
}
for (const slug of batch3) {
  assert.ok(actual.has(slug), `batch 3 ad missing: ${slug}`);
}
console.log(`${properties.length} property pages checked: 6 earlier ads + 10 batch-3 ads unchanged/locked; ${properties.length - 16} others without player.`);
