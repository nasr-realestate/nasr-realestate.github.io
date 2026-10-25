// Tests: scripts/verify-deployment.mjs — تحقّق ما بعد النشر (قراءة فقط)
// كل الاختبارات بدون شبكة: fetch بديل يحاكي الموقع وبوابة MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  HEAD_TARGETS,
  requestHeadTargets,
  classifyAudioResponse,
  checkSocialHead,
  extractSocialMeta,
  listAudioFiles,
  mcpHealthUrl,
  pollUntil,
  verifyDeployment,
} from '../verify-deployment.mjs';
import { parseFrontMatter } from '../lib/front-matter.mjs';

// عدد العقارات الحقيقي في المستودع (كان رقمًا ثابتًا 103، فانكسر الاختبار فور
// إضافة عقار بشار بن برد 2026-10-19 رغم أن verifyDeployment نفسه سليم).
const REPO_COUNT = fs.readdirSync(new URL('../../_properties/', import.meta.url))
  .filter((f) => f.endsWith('.md')).length;

const AUDIO = listAudioFiles();
const PROPERTY_SRC = '_properties/2026-10-10-apartment-helmy-abdel-aaty-seraj-230m.md';
const REQUEST_TARGET = HEAD_TARGETS.find(t => t.kind === 'request');
const REQUEST_SRC = REQUEST_TARGET?.source;
const propertyDesc = String(parseFrontMatter(fs.readFileSync(PROPERTY_SRC, 'utf8')).data.description || '').replace(/\s+/g, ' ').trim();
const requestDesc = REQUEST_SRC ? String(parseFrontMatter(fs.readFileSync(REQUEST_SRC, 'utf8')).data.description || '').replace(/\s+/g, ' ').trim() : '';
const SIZE = new Map(AUDIO.map((a) => [a.url, a.bytes]));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function pageHtml({ title = 'عنوان الصفحة', description = '', ogImageType = 'image/webp', duplicateDescription = false } = {}) {
  const meta = [
    `<meta name="description" content="${description}">`,
    duplicateDescription ? `<meta name="description" content="${description}">` : '',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`,
    ogImageType ? `<meta property="og:image:type" content="${ogImageType}">` : '',
  ].filter(Boolean).join('\n');
  return `<!doctype html><html dir="rtl"><head><title>${title}</title>\n${meta}\n</head><body></body></html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function fakeSite({ sha = 'abc123', feedCount, mcpCount, audioStatus = 206, mcpStatus = 200, duplicateDescription = false, agentOgType = 'image/webp', deployInfo = 'ok', styleBody = null } = {}) {
  const properties = Array.from({ length: feedCount ?? REPO_COUNT }, (_, i) => ({ slug: `p-${i}` }));
  const calls = { audio: 0, feed: 0, health: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/deploy-info.json') {
      return deployInfo === 'ok' ? jsonResponse({ sha, ref: 'master' }) : htmlResponse('<html>404</html>', 404);
    }
    if (u.pathname === '/.well-known/mcp.json') return jsonResponse({ transport: { endpoint: 'https://mcp.test/mcp' } });
    if (u.pathname === '/properties/apartment-sale-helmy-abdel-aaty-seraj-mall-230m/') {
      return htmlResponse(pageHtml({ title: 'شقة 230م', description: propertyDesc, duplicateDescription }));
    }
    if (REQUEST_TARGET && u.pathname === REQUEST_TARGET.path) {
      return htmlResponse(pageHtml({ title: 'مطلوب شقة', description: requestDesc, duplicateDescription }));
    }
    if (u.pathname === '/agent.html') {
      return htmlResponse(pageHtml({ title: 'الوكيل العقاري الذكي', description: 'وصف صفحة الوكيل الذكي — احكي طلبك وابدأ المحادثة.', ogImageType: agentOgType }));
    }
    if (u.pathname === '/health') { calls.health += 1; return jsonResponse({ status: 'ok', properties: mcpCount ?? properties.length }, mcpStatus); }
    if (u.pathname === '/ai-feed.json') { calls.feed += 1; return jsonResponse({ total_count: properties.length, properties, generated_at: '2026-10-18T00:00:00Z' }); }
    if (['/', '/sw.js', '/assets/css/style.min.css'].includes(u.pathname)) {
      const body = u.pathname === '/assets/css/style.min.css' && styleBody !== null ? styleBody : 'ok';
      return new Response(body, { status: 200, headers: { 'content-type': u.pathname.endsWith('.css') ? 'text/css' : 'text/html' } });
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

test("extractSocialMeta: يعدّ الوسوم ويستخرج المحتوى", () => {
  const meta = extractSocialMeta(pageHtml({ title: 'تي', description: 'وصف كامل', duplicateDescription: true }));
  assert.equal(meta.descriptionCount, 2);
  assert.equal(meta.ogDescriptionCount, 1);
  assert.equal(meta.ogTitleCount, 1);
  assert.equal(meta.twitterTitleCount, 1);
  assert.equal(meta.description, 'وصف كامل');
  assert.equal(meta.ogImageType, 'image/webp');
});

test("checkSocialHead: يمرّ ويطابق وصف المصدر، ويفشل عند التكرار/عدم التطابق", () => {
  const good = checkSocialHead(pageHtml({ description: propertyDesc }), { kind: 'property' }, propertyDesc);
  assert.equal(good.ok, true, JSON.stringify(good.problems));

  const dup = checkSocialHead(pageHtml({ description: propertyDesc, duplicateDescription: true }), { kind: 'property' }, propertyDesc);
  assert.equal(dup.ok, false);
  assert.ok(dup.problems.some((p) => /عددها 2/.test(p)));

  const mismatch = checkSocialHead(pageHtml({ description: 'وصف مختلف تمامًا لا يبدأ بالمصدر' }), { kind: 'property' }, propertyDesc);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.problems.some((p) => /لا يبدأ بوصف المصدر/.test(p)));

  const badAgent = checkSocialHead(pageHtml({ description: 'وصف', ogImageType: 'image/png' }), { kind: 'agent' }, '');
  assert.equal(badAgent.ok, false);
  assert.ok(badAgent.problems.some((p) => /og:image:type/.test(p)));
});

test("verifyDeployment: نجاح كامل عندما يتطابق SHA والعدد والصوت", async () => {
  const { fetchImpl, calls } = fakeSite({ sha: 'abc123', feedCount: REPO_COUNT, mcpCount: REPO_COUNT });
  const r = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.report.feed.properties, REPO_COUNT);
  assert.equal(r.report.mcp.properties, REPO_COUNT);
  assert.equal(r.report.audio_checked, AUDIO.length);
  assert.equal(calls.audio, AUDIO.length);
  assert.equal(calls.feed, 1);
  assert.equal(r.report.head['property-helmy'].ok, true);
  assert.equal(r.report.head.agent.ok, true);
});

test("verifyDeployment: SHA مختلف أو MCP ناقص أو صوت مكسور ⇒ يفشل بصوت عالٍ", async () => {
  const badSha = fakeSite({ sha: 'older', feedCount: REPO_COUNT, mcpCount: REPO_COUNT });
  const r1 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badSha.fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(r1.ok, false);
  assert.ok(r1.failures.some((f) => f.check === 'deploy_convergence'));

  const badMcp = fakeSite({ sha: 'abc123', feedCount: REPO_COUNT, mcpCount: REPO_COUNT - 1 });
  const r2 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badMcp.fetchImpl, mcpAttempts: 2, mcpDelayMs: 1 });
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.check === 'mcp_count'), JSON.stringify(r2.failures));

  const badHead = fakeSite({ sha: 'abc123', feedCount: REPO_COUNT, mcpCount: REPO_COUNT, duplicateDescription: true });
  const rh = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badHead.fetchImpl });
  assert.equal(rh.ok, false);
  assert.ok(rh.failures.some((f) => f.check === 'head:property-helmy'), JSON.stringify(rh.failures));

  const badAgentHead = fakeSite({ sha: 'abc123', feedCount: REPO_COUNT, mcpCount: REPO_COUNT, agentOgType: 'image/png' });
  const ra = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badAgentHead.fetchImpl });
  assert.equal(ra.ok, false);
  assert.ok(ra.failures.some((f) => f.check === 'head:agent'));

  const badAudio = fakeSite({ sha: 'abc123', feedCount: REPO_COUNT, mcpCount: REPO_COUNT, audioStatus: 404 });
  const r3 = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: badAudio.fetchImpl });
  assert.equal(r3.ok, false);
  assert.equal(r3.report.audio_failed, AUDIO.length);
  assert.ok(r3.failures.some((f) => f.check === 'audio'));
});

test("verifyDeployment: ناشر legacy بلا deploy-info.json ⇒ يُقبل إن طابقت بصمة style.min.css", async () => {
  const localStyle = fs.readFileSync(new URL('../../assets/css/style.min.css', import.meta.url));
  const okSite = fakeSite({ feedCount: REPO_COUNT, mcpCount: REPO_COUNT, deployInfo: 'missing', styleBody: localStyle });
  const rOk = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: okSite.fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(rOk.ok, true, JSON.stringify(rOk.failures));
  assert.equal(rOk.report.deploy_info.method, 'style-hash');
  assert.match(String(rOk.report.stamp_missing), /404/);

  // ملف منشور قديم ⇒ فشل صريح رغم غياب الختم
  const staleSite = fakeSite({ feedCount: REPO_COUNT, mcpCount: REPO_COUNT, deployInfo: 'missing', styleBody: Buffer.from('/* old build */') });
  const rStale = await verifyDeployment({ site: 'https://site.test', expectedSha: 'abc123', fetchImpl: staleSite.fetchImpl, timeoutS: 1, delayMs: 1 });
  assert.equal(rStale.ok, false);
  assert.ok(rStale.failures.some((f) => f.check === 'deploy_convergence'));
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


test('request social targets follow live source files, including an empty collection after expiry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-head-targets-'));
  try {
    assert.deepEqual(requestHeadTargets(root), []);
    fs.mkdirSync(path.join(root, '_requests'));
    const file = path.join(root, '_requests', '2026-10-25-example.md');
    fs.writeFileSync(file, '---\nslug: sample-request\n---\n');
    assert.equal(requestHeadTargets(root)[0].path, '/requests/sample-request/');
    fs.unlinkSync(file);
    assert.deepEqual(requestHeadTargets(root), []);
    assert.ok(HEAD_TARGETS.every(t => fs.existsSync(t.source)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
