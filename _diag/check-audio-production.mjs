// Post-deploy smoke test, run manually by the non-deployment audio verification workflow.
// Unlike the build-only gate, this fetches the public GitHub Pages origin itself.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { grab } from './audio-check-utils.mjs';

const origin = 'https://nasr-realestate.github.io';
const slug = 'shop-rent-request-beauty-center-nasr-city';
const audioUrl = `/assets/audio/requests/${slug}.mp3`;
const expectedHash = '7d2de3cbe4b1496bafba873266907913be1af3dd45660a82b14a110d5cf4fa5b';
const front = (await readFile('_requests/2026-10-09-shop-rent-request-beauty-center-nasr-city.md', 'utf8'))
  .split(/^---\s*$/m)[1];
const script = grab(front, 'audio_script');

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function get(path, options) {
  const response = await fetch(origin + path, { redirect: 'error', ...options });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}

async function checkPage() {
  const path = `/requests/${slug}/`;
  const response = await get(path);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes(`<audio id="rqAudio" preload="none" src="${audioUrl}"></audio>`), `${path}: no player`);
  assert.ok(html.includes(script), `${path}: script not rendered`);
  assert.ok(html.includes('17 ثانية'), `${path}: duration missing`);
  for (const other of [
    'apartment-rent-request-art-studio-large-reception-nasr-city',
    'garage-rent-request-40-buses-ismail-qabbani',
  ]) {
    const page = await get(`/requests/${other}/`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes('id="rqAudioBox"'), `${other}: unexpected player`);
  }
  console.log('Production: request player + script + 17s; 2 others unchanged (200).');
}

async function checkAudio() {
  const response = await get(audioUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /audio\/mpeg/, 'MP3 MIME');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha(bytes), expectedHash, 'production MP3 hash differs from committed asset');
  const range = await get(audioUrl, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206, 'production Range request');
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
  console.log(`Production: ${audioUrl} HTTP 200 audio/mpeg, Range 206, SHA-256 ${expectedHash}.`);
}

await checkPage();
await checkAudio();
const property = await get('/properties/apartment-sale-helmy-abdel-aaty-seraj-mall-230m/');
assert.ok((await property.text()).includes('id="ppAudioBox"'), 'old property player missing in production');
console.log('Production: existing property player still present.');
