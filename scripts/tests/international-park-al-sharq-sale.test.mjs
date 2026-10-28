import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { app } from '../../server.js';
import { parseFrontMatter } from '../lib/front-matter.mjs';
import { normalizeProperty } from '../lib/properties.mjs';
import { __test as syncTest } from '../../_worker/properties-sync-worker.js';

const slug = 'apartment-sale-international-park-al-sharq-225m';
const source = fs.readFileSync(new URL(`../../_properties/2026-10-28-${slug}.md`, import.meta.url), 'utf8');
const { data } = parseFrontMatter(source);
const NON_BROKER_CONTACT_RE = /(?:\+?20\s*1[025]|\b01[025])[\s-]?\d|حارس\s*العقار|المفتاح\s*مع/;

test('International Park 225m: exact authorized facts without invented specs or private seller/doorman data', () => {
  assert.equal(data.id, 'international-park-al-sharq-225m');
  assert.equal(data.category, 'apartments');
  assert.equal(data.priceNumeric, 6500000);
  assert.equal(data.areaNumeric, 225);
  assert.equal(data.roomsNumeric, 4);
  assert.equal(data.bathsNumeric, 2);
  assert.equal(data.floor, 'الدور الثاني عشر (عمارة 14 دورًا — بحري صريح)');
  assert.equal(data.finish, 'بورسلين الجوهر مستويين — تحتاج وش نظافة');
  assert.equal(data.furnished, undefined);
  assert.equal(data.negotiable, undefined);
  assert.equal(data.image_file, 'international-park-al-sharq-225m.webp');
  assert.equal(data.image, '/assets/img/properties/og/international-park-al-sharq-225m.jpg');
  assert.equal(data.audio_ad, true);
  assert.equal(data.audio_file, `/assets/audio/properties/${slug}.mp3`);
  assert.equal(data.audio_duration, '29 ثانية');
  assert.match(data.location, /بجوار الحديقة الدولية/);
  assert.match(source, /عمارة شركة الشرق للتأمين/);
  assert.match(source, /بحري صريح/);
  assert.match(source, /بورسلين الجوهر/);
  assert.match(source, /التكييفات/);
  assert.match(source, /وش نظافة/);
  assert.match(source, /2 أسانسير/);
  assert.match(source, /حصة في الأرض/);
  assert.match(source, /شقتين مضمومتين برسم هندسي/);
  assert.doesNotMatch(source, NON_BROKER_CONTACT_RE);
  assert.doesNotMatch(source, /جنيه قابل للتفاوض|سوبر لوكس|الترا سوبر لوكس|مسجلة شهر عقاري/);
});

test('International Park 225m: AI layer, facets and D1 sync classify listing as in-scope Nasr City sale with zero PII leakage', () => {
  const property = normalizeProperty(data, slug);
  assert.equal(property.transaction, 'sale');
  assert.equal(property.priceIsMonthly, false);
  assert.equal(property.furnished, null);

  const facets = JSON.parse(fs.readFileSync(new URL('../../_data/listing_facets.json', import.meta.url), 'utf8'));
  assert.equal(facets.listings[slug].deal, 'sale');
  assert.equal(facets.listings[slug].type, 'apartment');
  assert.equal(facets.listings[slug].in_area, true);
  assert.ok(facets.catalog.order.includes(slug));

  const feed = JSON.parse(fs.readFileSync(new URL('../../ai-feed.json', import.meta.url), 'utf8'));
  const item = feed.properties.find(p => p.slug === slug);
  assert.ok(item);
  assert.equal(item.transaction, 'sale');
  assert.equal(item.scope, 'city');
  assert.equal(item.priceNumeric, 6500000);
  assert.equal(item.areaNumeric, 225);
  assert.equal(item.roomsNumeric, 4);
  assert.equal(item.bathsNumeric, 2);

  const d1 = syncTest.buildRecord(
    data,
    `2026-10-28-${slug}.md`,
    [{ id: 1, name: 'مدينة نصر', names: ['مدينة نصر'] }],
  );
  assert.equal(d1.outOfScope, false);
  assert.deepEqual(d1.problems, []);
  assert.equal(d1.record.externalId, 'international-park-al-sharq-225m');
  assert.equal(d1.record.areaId, 1);
  assert.equal(d1.record.transactionType, 'sale');
  assert.equal(d1.record.propertyType, 'apartment');
  assert.equal(d1.record.price, 6500000);
  assert.equal(d1.record.areaM2, 225);
  assert.equal(d1.record.rooms, 4);
  assert.equal(d1.record.bathrooms, 2);

  for (const rel of [
    `../../api/properties/${slug}.json`,
    `../../api/properties/${slug}.md`,
  ]) {
    const content = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(content, NON_BROKER_CONTACT_RE, rel);
  }
});

test('International Park 225m: live renderer serves valid ForSale schema, verified audio player/MP3 and safe gallery state', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/properties/${slug}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, NON_BROKER_CONTACT_RE);

    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
    const listing = schemas.find(s => s['@type'] === 'RealEstateListing');
    assert.ok(listing);
    assert.equal(listing.offers.price, '6500000');
    assert.ok(JSON.stringify(listing).includes('https://schema.org/ForSale'));
    assert.ok(!JSON.stringify(listing).includes('https://schema.org/ForRent'));

    assert.equal((html.match(/<audio\b/g) || []).length, 1);
    const player = html.match(/<audio\b[^>]*>/)[0];
    assert.match(player, /preload="none"/);
    assert.doesNotMatch(player, /autoplay/);
    assert.ok(player.includes(data.audio_file));

    const audioResponse = await fetch(base + data.audio_file);
    assert.equal(audioResponse.status, 200);
    assert.match(audioResponse.headers.get('content-type'), /audio\/mpeg/);
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    const registered = JSON.parse(fs.readFileSync(new URL('../../_data/audio_voice_log.json', import.meta.url), 'utf8')).entries.find(e => e.slug === slug);
    assert.equal(audio.length, registered.bytes);
    assert.equal(createHash('sha256').update(audio).digest('hex'), registered.sha256);

    const rangeResponse = await fetch(base + data.audio_file, { headers: { range: 'bytes=0-0' } });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-0/${registered.bytes}`);

    const primary = html.match(/<a[^>]+id="ppWaBtn"[^>]*>/)[0];
    const href = primary.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
    assert.equal(new URL(href).pathname, '/201147758857');

    const gallery = html.match(/<img[^>]+id="ppMainImage"[^>]*>/)[0];
    assert.match(gallery, /src="[^"]*\/international-park-al-sharq-225m\.webp"/);
    assert.match(gallery, /width="720" height="1228"/);
    assert.match(gallery, /international-park-al-sharq-225m-800w\.webp 800w/);
    assert.match(html, /<meta property="og:image" content="[^"]*\/og\/international-park-al-sharq-225m\.jpg"/);

    const home = await (await fetch(`${base}/`)).text();
    assert.ok(home.includes(`/properties/${slug}/`));
    assert.ok(home.includes('/assets/img/properties/cards/international-park-al-sharq-225m.webp'));
    const catalog = await (await fetch(`${base}/properties/`)).text();
    assert.ok(catalog.includes('/assets/img/properties/cards/international-park-al-sharq-225m.webp'));

    for (const file of [
      'international-park-al-sharq-225m.webp',
      'international-park-al-sharq-225m-800w.webp',
      'cards/international-park-al-sharq-225m.webp',
      'og/international-park-al-sharq-225m.jpg',
    ]) {
      const imgRes = await fetch(`${base}/assets/img/properties/${file}`);
      assert.equal(imgRes.status, 200, file);
      assert.match(imgRes.headers.get('content-type'), /^image\//);
      assert.ok((await imgRes.arrayBuffer()).byteLength > 1000);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('International Park 225m: original uploaded photo is untouched and catalog order places listing first', () => {
  const image = fs.readFileSync(new URL('../../assets/img/properties/international-park-al-sharq-225m.webp', import.meta.url));
  assert.equal(createHash('sha256').update(image).digest('hex'), 'ebf107abb8b4cc95e3dd772aa428130db2b9e39825c5e5ba8b75e4e5811c7347');
  const facets = JSON.parse(fs.readFileSync(new URL('../../_data/listing_facets.json', import.meta.url), 'utf8'));
  assert.equal(facets.listings[slug].card_image, '/assets/img/properties/cards/international-park-al-sharq-225m.webp');
  assert.equal(facets.catalog.order[0], slug);
});

test('International Park 225m: audio is registered under voice identity spec with compatible-with-reference GE2E cosine', () => {
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
