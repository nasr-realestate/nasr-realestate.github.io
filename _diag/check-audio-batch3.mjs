// Property-audio gate: every property page that declares audio_ad: true.
// Usage after `bundle exec jekyll build`: node _diag/check-audio-batch3.mjs [siteDir]
// _diag/ stays private to the source tree (Jekyll does not publish it).
//
// البصمات لم تعد لقطة مجمَّدة من دفعة بعينها (كانت 49 صفحة) لأن الدفعة الموحّدة
// توسّع مجموعة الصفحات وتستبدل ملفات قديمة بموافقة المالك صراحةً. المرجع الآن
// _data/audio_voice_log.json — نفس المصدر الذي تتحقق منه بوابة الصوت — وكل
// ملف لا بد أن يطابق بصمته المقيدة حرفيًا. الإعلانات المرجعية الستة تبقى مقفولة
// هنا أيضًا ببصمات صريحة حتى لا يُعاد توليدها أبدًا، حتى لو تغيّر السجل.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { grab, occurrences, parseComm } from './audio-check-utils.mjs';

const outDir = process.argv[2] ?? '_site';

// الإعلانات المرجعية الستة — بصمات ثابتة لا يجوز أن تتغير مهما تغيّر السجل.
const referenceLock = {
  'apartment-sale-helmy-abdel-aaty-seraj-mall-230m': 'fb1ff292d14736bcb49593d834cfba58b246a1a6bc058f7ff83a74fda0e3720a',
  '10th-district-180m': 'c0729a2614e0219b2aec6c635d1b6b615ed2e5b9d082a91b7bf060785b12c788',
  'seraj-mall-apartment-170m': '5eb24cc1f7ff5ac6b6ded80de48b25a6b52f98eefcf414ac3d365fc21662b19f',
  'ahly-club-ext-158m': '38ffca645030793c7841022496b8e7c2473b89f4522ac3c71a2c6aa392c1d209',
  'hassan-al-sharif-150m': 'b85ae420f2d774d3b38fb4344ba62fd2d548550751ff61894472fb974d8aac56',
  'abbas-elakkad-220m-2026': 'e25747b530a25b99480520dc42b7521770e41ca06ab3d2f6e07ed005f0802992',
};

// السجل هو مصدر الحقيقة للبصمات: كل قيد مرتبط بصفحة منشورة لا بد أن يطابق ملفه.
const log = JSON.parse(await readFile('_data/audio_voice_log.json', 'utf8'));
const recorded = new Map(
  (log.entries ?? [])
    .filter((e) => String(e.propertySource ?? '').startsWith('_properties/'))
    .map((e) => [e.slug, e]),
);

// كل صفحة لها إعلان صوتي مقيد في السجل يجب أن تُبنى بلاعب واحد بالضبط
const withPlayer = new Set(recorded.keys());

function checkEnabledPage(slug, front, html, mp3bytes, expectedSha) {
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
  assert.equal(createHash('sha256').update(mp3bytes).digest('hex'), expectedSha, `${slug}: MP3 drifted from its recorded SHA-256`);
  assert.ok(html.includes('نص الإعلان الصوتي'), `${slug}: script disclosure missing`);
  if (referenceLock[slug]) {
    assert.equal(createHash('sha256').update(mp3bytes).digest('hex'), referenceLock[slug], `${slug}: reference ad must never be regenerated`);
  }
  if (slug === 'apartment-sale-hassan-hassanein-heikal-200m') {
    assert.ok(!html.includes('<summary>هل السعر قابل للتفاوض؟</summary>'), `${slug}: generic negotiation FAQ is unconfirmed`);
  }
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
  const record = recorded.get(slug);
  assert.ok(record, `${slug}: page has audio_ad but no entry in _data/audio_voice_log.json`);
  const mp3bytes = await readFile(path.join(outDir, 'assets', 'audio', 'properties', `${slug}.mp3`));
  checkEnabledPage(slug, front, page, mp3bytes, record.sha256);
}

assert.ok(collection.length >= 16, 'property collection shrank');
assert.equal(seen.size, withPlayer.size, 'audio-enabled count drifted from the production log');
for (const slug of Object.keys(referenceLock)) assert.ok(seen.has(slug), `reference ad missing: ${slug}`);
for (const id of withPlayer) assert.ok(seen.has(id), `audio page missing from build: ${id}`);
console.log(`${collection.length} property pages: ${seen.size} with locked audio players, ${collection.length - seen.size} untouched without player.`);
