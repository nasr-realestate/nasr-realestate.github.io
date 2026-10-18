// Tests: scripts/verify-deployment.mjs — تحقّق ما بعد النشر (قراءة فقط)
// كل الاختبارات بدون شبكة: fetch بديل يحاكي الموقع وبوابة MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyAudioResponse,
  listAudioFiles,
  mcpHealthUrl,
  pollUntil,
  verifyDeployment,
} from '../verify-deployment.mjs';

const AUDIO = listAudioFiles();
const SIZE = new Map(AUDIO.map((a) => [a.url, a.bytes]));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function fakeSite({ sha = 'abc123', feedCount, mcpCount, audioStatus = 206, mcpStatus = 200 } = {}) {
  const properties = Array.from({ length: feedCount ?? 103 }, (_, i) => ({ slug: `p-${i}` }));
  const calls = { audio: 0, feed: 0, health: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/deploy-info.json') return jsonResponse({ sha, ref: 'master' });
    if (u.pathname === '/.well-known/mcp.json') return jsonResponse({ transport: { endpoint: 'https://mcp.test/mcp' } });
    if (u.pathname === '/health') { calls.health += 1; return jsonResponse({ status: 'ok', properties: mcpCount ?? properties.length }, mcpStatus); }
    if (u.pathname === '/ai-feed.json') { calls.feed += 1; return jsonResponse({ total_count: properties.length, properties, generated_at: '2026-10-18T00:00:00Z' }); }
    if (['/', '/agent.html', '/sw.js', '/assets/css/style.min.css'].includes(u.pathname)) {
      return new Response('ok', { status: 200, headers: { 'content-type': u.pathname.endsWith('.css') ? 'text/css' : 'text/html' } });
    }
    if (u.pathname.startsWith('/assets/audio/')) {
      calls.audio += 1;
      const total = SIZE.get(u.pathname) ?? 1;
      if (audioStatus === 206) {
        return new Response(null, { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-0/${total}` } });
      }
      return new Response(null, { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test("classifyAudioResponse: 206 يتطلب audio/mpeg + Content-Range صحيحًا", () => {
  assert.equal(classifyAudioResponse({ status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/108976' }, expectedBytes: 108976 }).ok, true);
  assert.equal(classifyAudioResponse({ status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/1' }, expectedBytes: 2 }).ok, false);
  assert.equal(classifyAudioResponse({ status: 206, headers: { 'content-type': 'audio/mpeg' } }).ok, false);
  assert.equal(classifyAudioResponse({ status: 206, headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-0/10' } }).ok, false);
  assert.equal(classifyAudioResponse({ status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 100-200/300' } }).ok, false, 'يجب أن يكون النطاق 0-0');
});

test("classifyAudioResponse: 200 و416 و404", () => {
  assert.equal(classifyAudioResponse({ status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '1000' }, expectedBytes: 1000 }).ok, true);
  assert.equal(classifyAudioResponse({ status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '999' }, expectedBytes: 1000 }).ok, false);
  assert.equal(classifyAudioResponse({ status: 200, headers: { 'content-type': 'text/html', 'content-length': '10' } }).ok, false);
  assert.equal(classifyAudioResponse({ status: 416, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes */1000' } }).ok, true);
  assert.equal(classifyAudioResponse({ status: 404, headers: {} }).ok, false);
});

test("mcpHealthUrl: يشتق /health من endpoint الـMCP", () => {
  assert.equal(mcpHealthUrl({ transport: { endpoint: 'https://nasr-ai-gateway.footcai-555.workers.dev/mcp' } }), 'https://nasr-ai-gateway.footcai-555.workers.dev/health');
  assert.equal(mcpHealthUrl({}), null);
});

test("listAudioFiles: كل MP3 منشور في assets/audio مذكور بمساره وحجمه", () => {
  assert.ok(AUDIO.length >= 46, `عدد ملفات الصوت غير متوقع: ${AUDIO.length}`);
  for (const a of AUDIO) {
    assert.match(a.url, /^\/assets\/audio\/[A-Za-z0-9._\-\/]+\.mp3$/);
    assert.ok(a.bytes > 0);
    const disk = fs.statSync(path.join(process.cwd(), a.url)).size;
    assert.equal(a.bytes, disk);
  }
  assert.equal(new Set(AUDIO.map((a) => a.url)).size, AUDIO.length, 'لا تكرار');
});

test("verifyDeployment: نجاح كامل عندما يتطابق SHA والعدد والصوت", async () => {
  const { fetchImpl, calls } = fakeSite({ sha: 'abc123', feedCount: 103, mcpCount: 103 });
  const r = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.report.feed.properties, 103);
  assert.equal(r.report.mcp.properties, 103);
  assert.equal(r.report.audio_checked, AUDIO.length);
  assert.equal(calls.audio, AUDIO.length);
  assert.equal(calls.feed, 1);
});

test("verifyDeployment: SHA مختلف أو MCP ناقص أو صوت مكسور ⇒ يفشل بصوت عالٍ", async () => {
  const badSha = fakeSite({ sha: 'older', feedCount: 103, mcpCount: 103 });
  const r1 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badSha.fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(r1.ok, false);
  assert.ok(r1.failures.some((f) => f.check === 'deploy_convergence'));

  const badMcp = fakeSite({ sha: 'abc123', feedCount: 103, mcpCount: 102 });
  const r2 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badMcp.fetchImpl, mcpAttempts: 2, mcpDelayMs: 1 });
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.check === 'mcp_count'), JSON.stringify(r2.failures));

  const badAudio = fakeSite({ sha: 'abc123', feedCount: 103, mcpCount: 103, audioStatus: 404 });
  const r3 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badAudio.fetchImpl });
  assert.equal(r3.ok, false);
  assert.equal(r3.report.audio_failed, AUDIO.length);
  assert.ok(r3.failures.some((f) => f.check === 'audio'));
});

test("verifyDeployment: feed أكثر من المستودع يفشل (لا نشر جزئي صامت)", async () => {
  const repoCount = fs.readdirSync(path.join(process.cwd(), '_properties')).filter((f) => f.endsWith('.md')).length;
  const { fetchImpl } = fakeSite({ sha: 'abc123', feedCount: repoCount - 1 });
  const r = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(r.ok, false);
  const feedFailure = r.failures.find((f) => f.check === 'ai_feed');
  assert.ok(feedFailure, JSON.stringify(r.failures));
  assert.match(feedFailure.reason, /_properties/);
});

test("pollUntil: يتوقف عند أول نجاح ويعيد عدد المحاولات", async () => {
  let n = 0;
  const r = await pollUntil(async () => { n += 1; return { ok: n === 3, value: n }; }, { attempts: 5, delayMs: 1, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});
