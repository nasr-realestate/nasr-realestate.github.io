import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { app } from '../../server.js';
import { parseFrontMatter } from '../lib/front-matter.mjs';
import { normalizeProperty } from '../lib/properties.mjs';

const slug = 'apartment-sale-hassan-maamoun-220m-rented-2027';
const source = fs.readFileSync(new URL(`../../_properties/2026-10-25-${slug}.md`, import.meta.url), 'utf8');
const { data } = parseFrontMatter(source);

test('Hassan Maamoun: sale price and existing tenancy remain distinct, without invented specifications', () => {
  assert.equal(data.priceNumeric, 8000000);
  assert.equal(data.areaNumeric, 220);
  assert.equal(data.roomsNumeric, 3);
  assert.equal(data.bathsNumeric, 3);
  assert.equal(data.floor, 'الدور الرابع');
  assert.equal(data.furnished, false);
  assert.equal(data.occupancy, 'tenanted');
  assert.equal(data.current_rent_monthly, 23000);
  assert.equal(data.lease_end_year, 2027);
  assert.equal(data.finish, undefined);
  assert.equal(data.image_file, 'hassan-maamoun-220m.webp');
  assert.equal(data.image, '/assets/img/properties/og/hassan-maamoun-220m.jpg');
  assert.equal(data.audio_ad, true);
  assert.equal(data.audio_file, `/assets/audio/properties/${slug}.mp3`);
  assert.equal(data.audio_duration, '27 ثانية');
  assert.match(data.audio_script, /مؤجرة لحد نهاية ألفين سبعة وعشرين/);
  assert.match(data.audio_script, /بتلاتة وعشرين ألف جنيه شهريًا/);
  assert.match(source, /3 بلكونات/);
  assert.match(source, /ليست خالية للتسليم الفوري/);
  assert.match(source, /نسخة عقد الإيجار/);
  assert.doesNotMatch(source, /دقائق|مصعد|سوبر لوكس|عائد مضمون/);
});

test('Hassan Maamoun: sale classification, eight-million price and tenancy reach AI artifacts', () => {
  const property = normalizeProperty(data, slug);
  assert.equal(property.transaction, 'sale');
  assert.equal(property.priceIsMonthly, false);
  assert.equal(property.furnished, 'unfurnished');
  assert.equal(property.image, 'https://nasr-realestate.github.io/assets/img/properties/hassan-maamoun-220m.webp');
  const feed = JSON.parse(fs.readFileSync(new URL('../../ai-feed.json', import.meta.url), 'utf8'));
  const item = feed.properties.find(p => p.slug === slug);
  assert.equal(item.transaction, 'sale');
  assert.equal(item.priceNumeric, 8000000);
  assert.match(item.description, /23,000/);
  assert.match(item.description, /2027/);
  assert.equal(item.image, property.image);
});

test('Hassan Maamoun: live renderer has valid sale schema, tenancy warning, actual gallery image and one published audio player', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/properties/${slug}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
    const listing = schemas.find(s => s['@type'] === 'RealEstateListing');
    assert.ok(listing);
    assert.ok(listing.image[0].endsWith('/assets/img/properties/hassan-maamoun-220m.webp'));
    assert.equal(listing.offers.price, '8000000');
    assert.ok(JSON.stringify(listing).includes('https://schema.org/ForSale'));
    assert.ok(!JSON.stringify(listing).includes('https://schema.org/ForRent'));
    assert.match(html, /23,000 جنيه شهريًا/);
    assert.match(html, /نهاية 2027/);
    assert.match(html, /سيتي ستارز/);
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
    const gallery = html.match(/<img[^>]+id="ppMainImage"[^>]*>/)[0];
    assert.match(gallery, /src="[^"]*\/hassan-maamoun-220m.webp"/);
    assert.match(gallery, /width="1280" height="960"/);
    assert.match(gallery, /hassan-maamoun-220m-800w.webp 800w/);
    assert.match(html, /<meta property="og:image" content="[^"]*\/og\/hassan-maamoun-220m.jpg"/);
    const primary = html.match(/<a[^>]+id="ppWaBtn"[^>]*>/)[0];
    const href = primary.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
    assert.equal(new URL(href).pathname, '/201147758857');
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /class="hp-hero-visual"/);
    assert.ok(home.includes(`/properties/${slug}/`));
    assert.ok(home.includes('/assets/img/properties/cards/hassan-maamoun-220m.webp'));
    const catalog = await (await fetch(base + '/properties/')).text();
    assert.ok(catalog.includes('/assets/img/properties/cards/hassan-maamoun-220m.webp'));
    for (const file of ['hassan-maamoun-220m.webp', 'hassan-maamoun-220m-800w.webp', 'cards/hassan-maamoun-220m.webp', 'og/hassan-maamoun-220m.jpg']) {
      const image = await fetch(`${base}/assets/img/properties/${file}`);
      assert.equal(image.status, 200, file);
      assert.match(image.headers.get('content-type'), /^image\//);
      assert.ok((await image.arrayBuffer()).byteLength > 1000);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('Hassan Maamoun: original owner photo is unchanged and every image variant is present', () => {
  const image = fs.readFileSync(new URL('../../assets/img/properties/hassan-maamoun-220m.webp', import.meta.url));
  assert.equal(createHash('sha256').update(image).digest('hex'), '384f8119c7eb3e2aa10fcd439e07ff04965ad729b38088588bae8030c331ee99');
  const facets = JSON.parse(fs.readFileSync(new URL('../../_data/listing_facets.json', import.meta.url), 'utf8'));
  assert.equal(facets.listings[slug].card_image, '/assets/img/properties/cards/hassan-maamoun-220m.webp');
  assert.ok(facets.catalog.order.includes(slug));
});


test('Hassan Maamoun: audio is registered under the unchanged standard with session-approved review-band identity', () => {
  const log = JSON.parse(fs.readFileSync(new URL('../../_data/audio_voice_log.json', import.meta.url), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(new URL('../../_data/voice_identity.json', import.meta.url), 'utf8'));
  const entry = log.entries.find(e => e.slug === slug);
  assert.equal(entry.origin, 'produced-under-spec');
  assert.equal(entry.script, data.audio_script);
  assert.equal(entry.approval, 'owner-in-session');
  assert.equal(entry.ownerOverride, false);
  assert.equal(entry.voiceIdPersistent, false);
  assert.equal(entry.classification, 'possible-deviation-review');
  assert.ok(entry.speakerCosineToReference >= spec.identityBand.thresholds.borderlineNeedsOwnerApproval);
  assert.ok(entry.speakerCosineToReference < spec.identityBand.thresholds.identicalVoice);
  assert.ok(entry.durationSeconds <= spec.encoding.maxDurationSeconds);
});
