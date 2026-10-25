import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.equal(data.image_file, undefined);
  assert.notEqual(data.audio_ad, true);
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
  assert.equal(property.image, null);
  const feed = JSON.parse(fs.readFileSync(new URL('../../ai-feed.json', import.meta.url), 'utf8'));
  const item = feed.properties.find(p => p.slug === slug);
  assert.equal(item.transaction, 'sale');
  assert.equal(item.priceNumeric, 8000000);
  assert.match(item.description, /23,000/);
  assert.match(item.description, /2027/);
});

test('Hassan Maamoun: live renderer has valid sale schema, tenancy warning and no phantom image or unpublished player', async () => {
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
    assert.equal(listing.image, undefined);
    assert.equal(listing.offers.price, '8000000');
    assert.ok(JSON.stringify(listing).includes('https://schema.org/ForSale'));
    assert.ok(!JSON.stringify(listing).includes('https://schema.org/ForRent'));
    assert.match(html, /23,000 جنيه شهريًا/);
    assert.match(html, /نهاية 2027/);
    assert.match(html, /سيتي ستارز/);
    assert.doesNotMatch(html, /id="ppMainImage"|<audio\b/);
    const primary = html.match(/<a[^>]+id="ppWaBtn"[^>]*>/)[0];
    const href = primary.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
    assert.equal(new URL(href).pathname, '/201147758857');
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /class="hp-hero-visual"/);
    assert.ok(home.includes(`/properties/${slug}/`));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
