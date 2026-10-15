// Batch-7 gate: five new audio ads (batch 7) + the 36 earlier ones, built-page verification only.
// Usage after `bundle exec jekyll build`: node _diag/check-audio-batch3.mjs [siteDir]
// _diag/ stays private to the source tree (Jekyll does not publish it).
// Successor of the batch-2 snapshot check: batch 7 widens the audio feature to 41
// pages and locks every MP3 with SHA-256 (all earlier files must remain byte-identical).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { grab, occurrences, parseComm } from './audio-check-utils.mjs';

const outDir = process.argv[2] ?? '_site';

// slug -> sha256 of the committed MP3 (batches 1–7)
const lockedAudio = {
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
  'apartment-sale-international-park-nasr-city-215m': 'b834abbc18332a6e4fa35e568c4f5f3d8876328608d42daec2dfc9efa1853935',
  'truegate-compound-waha-108m': '1c70e7a51a98c75edbbdce4267963463835a64a86794514c13022c8a540ad647',
  'commercial-mohamed-hasan-elgamal': '5b509764e3f0fb729ea8908861108cd8fcfbaf6efb9d7ebe370eef470e8bc259',
  'kabul-st-makram-ebeid-260m': '04c69a45044be8663af88912ae35fa93dd12c5c73817a4aeec5b37d10319a222',
  'shams-club-heliopolis-160m': 'fe06556889a78cbac07959cf49eaaf0fe6430069c1a2eeae61d72b7f8f5faac4',
  'villa-new-cairo-1st-district-568m': '0ad30545587d9c185324d3d41e15a7f5fb729b8c3a9896d7f33921f75ec7432d',
  'int-park-140m-furnished': '7b46469c754a4f7adf303163e1c8862feeb70f6af5ae3c8f76e11a497044ede8',
  'shop-rent-makram-ebeid-67m': 'd477736938387c1507427b3b44ad709849e77a5c074c2c433d384e55506236f6',
  'genena-mall-186m-office-residence': '668290009d62d6ae8b9761af42c783a3e971538a59fb1d31ffa9716f0e4aff70',
  'admin-rent-nozha-main-260m': '326d70b377dae0175846deebfe8c8a84e23d0ef15076a1878709dabe3aea8397',
  'apartment-sale-abbas-elakkad-refaai-200m-roi': '29d1d678eaa2719c34d7ba2f9aaeafeffb56f3f281cb4cfaedae73db151d511a',
  'apartment-for-sale-khedr-eltouny-tayaran-120m': '473cd73b187f9e797d09eaa73946365af732d1855d61d0d23a9a0dc6b60f9d06',
  'apartment-sale-al-hayat-towers-nasr-city-162m': '6352bd42f3073a9f90aef0fb69a6cf2806baf01e601c2f1b4c74f0236f1e4972',
  'shaka-nour-deen': 'abf86029dffe077e14cc93d3bc4c1516679db82662bbf86dc605d3f53b5752b4',
  'abdel-azim-ghalmi-200m-expat': 'e163142e8549afbe02007b9b153d2731057595b4721a454cd032fd6d7333a5a9',
  'ibrahim-nawara-175m': '964d0687973c4ec7133c06ed5a38793a3d7c948bf070f7638c0c788f266298d5',
  'villa-south-90th-120m': 'df397b9bcbbcc405485247843cdb8a635dd34af392ea535013793e1303aa9c02',
  'abu-dawood-fakhry-167m': '456d61fa435c7573694e099fda3db57a8fde42a3e2fbb0bf4a259deecd00f4e8',
  'ismail-wahby-160m-luxury': '3260fa3e57eafa34205c55605170aa6f395b20cd2bb8003b159eaa2710c17315',
  'shop-abbas-elakkad-60m-jan26': '0e92ee4940e629389af53f7cca2b4e632d501644662eb2d367af9232cb6ded3c',
  'makram-ebid-main-250m': '6077222c9469a33d70b3fcecdb23a6702bc034bc908678ab4b1f55652ee942c3',
  'ali-amer-240m': 'a98be4bc95f1aeaa68ae98ac17fec20932018d3c181e4ab32323f7c2eca93775',
  'sanhoori-luxury-250m': 'ac9e1009533854eed93a2d3e44c1888e5e9a59f594c6a83f59d3804c70b6ea2a',
  'safarat-safwa-170m': '354f9b19411a5766e2d646462f4c52d371d7f2e6da8b1319265d8b3724e614cf',
  'degla-landmark-122m-rent': '65e10976244b9eda573541497a14f6efea58a211203933cb3d5ff5471434671e',
};

// slugs that must show exactly one player (batches 1–7)
const withPlayer = new Set(Object.keys(lockedAudio));

function checkEnabledPage(slug, front, html, mp3bytes) {
  assert.equal(occurrences(html, 'id="ppAudioBox"'), 1, `${slug}: exactly one player`);
  assert.match(html, /dir="rtl"/, `${slug}: rtl`);
  assert.ok(html.includes('اسمع الإعلان الصوتي للعقار'), `${slug}: stock player title`);
  assert.ok(html.includes('class="pp-specs"') && html.includes('class="pp-actions"'), `${slug}: player sandwiched`);
  const expectedURL = `/assets/audio/properties/${slug}.mp3`;
  assert.equal(grab(front, 'audio_file'), expectedURL, `${slug}: audio_file mirrors slug`);
  assert.ok(html.includes(`<audio id="ppAudio" preload="none" src="${expectedURL}"></audio>`),
    `${slug}: src/preload/autoplay contract`);
  assert.ok(mp3bytes.length > 1000, `${slug}: empty audio`);
  assert.equal(mp3bytes.subarray(0, 3).toString(), 'ID3', `${slug}: not ID3-tagged MP3`);
  assert.equal(createHash('sha256').update(mp3bytes).digest('hex'), lockedAudio[slug], `${slug}: MP3 drifted`);
  assert.ok(html.includes('نص الإعلان الصوتي'), `${slug}: script disclosure missing`);
  const spoken = grab(front, 'audio_script');
  const comm = parseComm(mp3bytes);
  assert.equal(comm, spoken, `${slug}: ID3 COMM mismatch`);
  assert.ok(spoken.length > 80 && html.includes(spoken.slice(0, 40)), `${slug}: script text not rendered`);
  const label = grab(front, 'audio_duration');
  assert.match(label, /^\d+ ثانية$/, `${slug}: duration label format`);
  assert.ok(Number.parseInt(label, 10) <= 30, `${slug}: longer than 30s`);
  console.log(`${slug}: page + MP3 + player OK (${mp3bytes.length} B, ${label})`);
}

const collection = (await readdir('_properties')).filter((n) => n.endsWith('.md'));
const seen = new Set();

for (const name of collection) {
  const md = await readFile(path.join('_properties', name), 'utf8');
  const front = /^---\s*$/m.exec(md) ? md.split(/^---\s*$/m)[1] : '';
  assert.ok(front, `${name}: front matter missing`);
  const slug = grab(front, 'slug');
  const page = await readFile(path.join(outDir, 'properties', slug, 'index.html'), 'utf8');
  const enabled = /^audio_ad:\s*true\s*$/m.test(front);
  if (!enabled) {
    assert.ok(!page.includes('id="ppAudioBox"') && !page.includes('id="ppAudio"'), `${slug}: player leaked`);
    continue;
  }
  seen.add(slug);
  const mp3bytes = await readFile(path.join(outDir, 'assets', 'audio', 'properties', `${slug}.mp3`));
  checkEnabledPage(slug, front, page, mp3bytes);
}

assert.ok(collection.length >= 16, 'property collection shrank');
assert.equal(seen.size, withPlayer.size, 'audio-enabled count drifted');
for (const id of withPlayer) assert.ok(seen.has(id), `audio page missing from build: ${id}`);
console.log(`${collection.length} property pages: ${seen.size} with locked audio players, ${collection.length - seen.size} untouched without player.`);
