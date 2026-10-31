import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import matter from 'gray-matter';
import { parseFrontMatter } from '../lib/front-matter.mjs';
import { loadProperties, normalizeProperty } from '../lib/properties.mjs';
import { __test as syncTest } from '../../_worker/properties-sync-worker.js';
import { app } from '../../server.js';

const slug = 'apartment-sale-golden-square-243m';
const imageFilename = 'golden-square-243m.webp';
const sourceUrl = new URL('../../_properties/2026-10-31-apartment-sale-golden-square-243m.md', import.meta.url);
const raw = fs.readFileSync(sourceUrl, 'utf8');
const { data, content } = parseFrontMatter(raw);

test('Golden Square 243m: front matter matches gray-matter and preserves all stated specs', () => {
  const gm = matter(raw);
  assert.equal(data.slug, slug);
  assert.equal(gm.data.slug, slug);
  assert.equal(data.id, 'golden-square-243m');
  assert.equal(data.image_file, imageFilename);
  assert.equal(data.image, '/assets/img/properties/og/golden-square-243m.jpg');
  assert.equal(data.category, 'apartments');
  assert.equal(data.priceNumeric, 7_000_000);
  assert.equal(data.areaNumeric, 243);
  assert.equal(data.roomsNumeric, 3);
  assert.equal(data.bathsNumeric, 2);
  assert.equal(data.furnished, false);
  assert.equal(data.status, 'available');
  assert.equal(data.audio_ad, true);
  assert.equal(data.audio_file, `/assets/audio/properties/${slug}.mp3`);
  assert.equal(data.audio_duration, '28 ثانية');
  assert.equal(data.description, data.meta_description);
  assert.ok(!data.title.includes('|') && !data.title.includes('سمسار طلبك'));
  assert.ok(!data.meta_title.includes('|') && !data.meta_title.includes('سمسار طلبك'));
});

test('Golden Square 243m: keeps unfurnished 7M price separated from rapid furniture agreement and invents zero unstated claims', () => {
  for (const requiredPhrase of [
    'مستويين',
    'شارع طرابلس',
    'المربع الذهبي',
    'بين عباس ومكرم',
    '243',
    'الرفع المساحي',
    'بدون المنافع',
    'الدور الثالث',
    'ناصية شارعين',
    '2 بلكونة',
    'حديقة كبيرة',
    'الزجاج المعشق والملون',
    'الرخام الفاخر',
    'عمرو حلمي',
    'الأرو الطبيعي',
    '25 م²',
    'بوتاجاز كبير',
    'بدون أجهزة كهربائية',
    'للثلاجة',
    'غسالة الأطباق',
    'غسالة الملابس',
    'مجفف الملابس',
    'ديكوراما',
    'العالمية',
    'السفرة والبوفيه والنيش',
    'ثلاث درجات من الرخام',
    'باركيه مسمار',
    'يانسن',
    '5 مكيفات سبليت',
    'حرير وصوف كاشان',
    'لوحات',
    'نجف ستراس',
    '7,000,000 ج.م',
    'بدون الفرش',
    'منفصل وسريع',
    'الأولوية للجادين فقط ولمن يرغب في شراء الشقة بالعفش',
  ]) {
    assert.match(raw, new RegExp(requiredPhrase), `missing required fact: ${requiredPhrase}`);
  }

  for (const unstatedClaim of [
    /أسانسير|اسانسير|مصعد/,
    /حصة في الأرض|حصه في الارض/,
    /شهر عقاري|مسجلة شهر/,
    /قابل للتفاوض/,
  ]) {
    assert.doesNotMatch(content, unstatedClaim);
  }
});

test('Golden Square 243m: normalizes cleanly in facets, AI feed, API JSON, and D1 sync', () => {
  const imageExistsOnDisk = fs.existsSync(new URL(`../../assets/img/properties/${imageFilename}`, import.meta.url));
  const property = normalizeProperty(data, slug);
  assert.equal(property.transaction, 'sale');
  assert.equal(property.propertyType, 'apartment');
  assert.equal(property.zone, 'شارع طرابلس');
  assert.equal(property.furnished, 'unfurnished');
  assert.equal(property.priceNumeric, 7_000_000);
  assert.equal(property.areaNumeric, 243);
  assert.equal(property.roomsNumeric, 3);
  assert.equal(property.bathsNumeric, 2);
  assert.equal(property.imageFile, imageFilename);

  const facets = JSON.parse(fs.readFileSync(new URL('../../_data/listing_facets.json', import.meta.url), 'utf8'));
  const facet = facets.listings[slug];
  assert.ok(facet);
  assert.equal(facet.in_area, true);
  assert.equal(facet.deal, 'sale');
  assert.equal(facet.type, 'apartment');
  assert.equal(facet.furnished, 'unfurnished');
  assert.ok(facets.catalog.order.includes(slug));
  assert.ok(facet.segments.includes('apartments-for-sale'));

  const feed = JSON.parse(fs.readFileSync(new URL('../../ai-feed.json', import.meta.url), 'utf8'));
  const item = feed.properties.find(p => p.slug === slug);
  assert.ok(item);
  assert.equal(item.scope, 'city');
  assert.equal(item.furnished, 'unfurnished');
  assert.equal(item.image, imageExistsOnDisk ? `https://nasr-realestate.github.io/assets/img/properties/${imageFilename}` : null);

  const apiUnit = JSON.parse(fs.readFileSync(new URL(`../../api/properties/${slug}.json`, import.meta.url), 'utf8'));
  assert.equal((apiUnit.property ?? apiUnit).image, item.image);

  const built = syncTest.buildRecord(
    data,
    `2026-10-31-${slug}.md`,
    [{ id: 1, name: 'مدينة نصر', names: ['مدينة نصر'] }],
  );
  assert.equal(built.outOfScope, false);
  assert.deepEqual(built.problems, []);
  assert.equal(built.record.externalId, 'golden-square-243m');
  assert.equal(built.record.areaId, 1);
  assert.equal(built.record.transactionType, 'sale');
  assert.equal(built.record.propertyType, 'apartment');
  assert.equal(built.record.price, 7_000_000);
  assert.equal(built.record.areaM2, 243);
  assert.equal(built.record.rooms, 3);
  assert.equal(built.record.bathrooms, 2);
});

test('Golden Square 243m: loadProperties activates image URL automatically once image file exists', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-square-img-'));
  try {
    const propsDir = path.join(tmpRoot, '_properties');
    const imgDir = path.join(tmpRoot, 'assets', 'img', 'properties');
    fs.mkdirSync(propsDir, { recursive: true });
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(propsDir, `2026-10-31-${slug}.md`), raw, 'utf8');

    const beforeUpload = loadProperties(propsDir);
    assert.equal(beforeUpload[0].image, null);
    assert.equal(beforeUpload[0].imageFile, imageFilename);

    fs.writeFileSync(path.join(imgDir, imageFilename), 'RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary');
    const afterUpload = loadProperties(propsDir);
    assert.equal(afterUpload[0].image, `https://nasr-realestate.github.io/assets/img/properties/${imageFilename}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Golden Square 243m: original uploaded photo is untouched and rendered page serves responsive gallery, ForSale schema, and audio player', async () => {
  const origImg = fs.readFileSync(new URL(`../../assets/img/properties/${imageFilename}`, import.meta.url));
  assert.equal(createHash('sha256').update(origImg).digest('hex'), 'cc42823e02736d525b98d8aa54ac17de0ed095e3e62bb512f76e9cf3fe56f208');

  const facets = JSON.parse(fs.readFileSync(new URL('../../_data/listing_facets.json', import.meta.url), 'utf8'));
  assert.equal(facets.listings[slug].card_image, '/assets/img/properties/cards/golden-square-243m.webp');
  assert.equal(facets.listings[slug].image, `/assets/img/properties/${imageFilename}`);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/properties/${slug}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /7,000,000 ج\.م \(بدون الفرش\)/);
    assert.match(html, /شارع طرابلس/);
    assert.match(html, /المربع الذهبي/);
    assert.match(html, /id="ppMainImage"/);
    assert.match(html, /golden-square-243m-800w\.webp/);
    assert.equal((html.match(/<audio\b/g) || []).length, 1);
    const audioRes = await fetch(`${base}/assets/audio/properties/${slug}.mp3`);
    assert.equal(audioRes.status, 200);
    const cardRes = await fetch(`${base}/assets/img/properties/cards/golden-square-243m.webp`);
    assert.equal(cardRes.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Golden Square 243m: audio ad is registered under voice identity spec with compatible-with-reference GE2E cosine', () => {
  const log = JSON.parse(fs.readFileSync(new URL('../../_data/audio_voice_log.json', import.meta.url), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(new URL('../../_data/voice_identity.json', import.meta.url), 'utf8'));
  const entry = log.entries.find(e => e.slug === slug);
  assert.ok(entry);
  assert.equal(entry.origin, 'produced-under-spec');
  assert.equal(entry.script, data.audio_script);
  assert.equal(entry.approval, 'owner-in-session');
  assert.equal(entry.ownerOverride, false);
  assert.equal(entry.voiceIdPersistent, false);
  assert.equal(entry.classification, 'compatible-with-reference');
  assert.ok(entry.speakerCosineToReference >= spec.identityBand.thresholds.identicalVoice);
  assert.ok(entry.durationSeconds <= spec.encoding.maxDurationSeconds);
});
