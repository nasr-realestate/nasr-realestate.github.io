import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadProperty, checkScript, audioFileFor, isRequestSource, verifyFile } from '../audio/produce-audio-ad.mjs';
const source = '_requests/2026-10-24-shop-rent-women-beauty-center-150plus.md';
const ledger = JSON.parse(fs.readFileSync('_data/audio_voice_log.json', 'utf8'));
const saved = ledger.entries.find(e => e.propertySource === source);
// Requests are removed after seven days; audit the public snapshot after expiry,
// rather than adding a test that inevitably breaks scheduled cleanup.
const request = fs.existsSync(source) ? loadProperty(source)
  : { rel: source, slug: saved.slug, data: saved.publishedRequest };
const raw = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : JSON.stringify(saved.publishedRequest);

test('beauty request preserves strict area, budget, activity and client privacy', () => {
  assert.equal(request.data.date, '2026-10-24');
  assert.equal(request.data.property_type, 'shop');
  assert.equal(request.data.budget_num, 50000);
  assert.equal(request.data.budget_negotiable, false);
  assert.match(raw, /أكبر من 150/);
  assert.match(raw, /40,000/);
  assert.match(raw, /50,000/);
  assert.match(raw, /شارع رئيسي/);
  assert.match(raw, /نظيف/);
  assert.match(raw, /صالون تجميل نسائي/);
  assert.equal(request.data.area_min, undefined, 'do not turn >150 into an exact 150sqm floorSize');
  assert.doesNotMatch(raw, /\d{11,13}/, 'no private phone in source');
});

test('audio uses its collection for request and property paths', () => {
  assert.ok(isRequestSource(source));
  assert.equal(isRequestSource('_requests/../_properties/x.md'), false);
  assert.equal(audioFileFor(request), request.data.audio_file.slice(1));
  assert.equal(audioFileFor({ rel: '_properties/x.md', slug: 'x' }), 'assets/audio/properties/x.mp3');
});

test('landlord CTA is allowed only in requests; generic CTA rules still apply', () => {
  const text = request.data.audio_script;
  assert.deepEqual(checkScript(text, request).errors, []);
  assert.ok(checkScript(text, { rel: '_properties/x.md' }).errors.length > 0);
  assert.ok(checkScript(text.replace('واتساب سمسار طلبك', ''), request).errors.length > 0);
  assert.ok(checkScript(text + ' 50000', request).errors.length > 0);
});

test('published request audio is technically valid, measured and has no identity override', () => {
  const file = request.data.audio_file.slice(1);
  const check = verifyFile(file, request.data.audio_script);
  assert.deepEqual(check.problems, []);
  assert.equal(request.data.audio_duration, `${Math.ceil(check.durationSeconds)} ثانية`);
  const log = JSON.parse(fs.readFileSync('_data/audio_voice_log.json', 'utf8'));
  const e = log.entries.find(row => row.audioFile === file);
  assert.equal(e.origin, 'produced-under-spec');
  assert.equal(e.speakerCosineToReference, 0.9465);
  assert.equal(e.ownerOverride, false);
  assert.equal(e.retiresWithRequest, true);
  assert.equal(e.sha256, check.sha256);
});
