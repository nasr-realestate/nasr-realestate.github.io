#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  scripts/verify-deployment.mjs
 *  تحقّق ما بعد النشر — قراءة فقط، ويفشل بصوت عالٍ بعد أن يكون الموقع
 *  نُشر بالفعل (لا يوقف النشر ولا يعدّل أي شيء منشور).
 *
 *  ما يتحقق منه:
 *   1) تطابق الـSHA المنشور مع الـSHA المطلوب (ملف / .well-known/deploy-info.json
 *      الذي يكتبه deploy.yml داخل _site قبل الرفع).
 *   2) الصفحة الرئيسية و/agent.html و/sw.js و/assets/css/style.min.css → 200.
 *   3) عدد وحدات ai-feed.json = عدد ملفات _properties في المستودع.
 *   4) عدد وحدات بوابة MCP (/health) = عدد وحدات الـfeed.
 *   5) كل ملف MP3 منشور: 200/206 + Content-Type: audio/mpeg + Content-Range عند 206.
 *
 *  التشغيل:
 *    node scripts/verify-deployment.mjs
 *    EXPECTED_SHA=<sha> DEPLOY_VERIFY_TIMEOUT_S=300 node scripts/verify-deployment.mjs
 *
 *  ملاحظة: كل الطلبات GET/HEAD فقط. لا سرّ ولا مصادقة.
 * ═══════════════════════════════════════════════════════════════════════
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from './lib/front-matter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const SITE_DEFAULT = 'https://nasr-realestate.github.io';
export const MCP_CARD_PATH = '.well-known/mcp.json';

const AUDIO_PREFIX = '/assets/audio/';

// صفحات تُفحص بوكيل WhatsApp/Facebook (raw <head>) — نفس ما يراه مُولّد
// المعاينة عند مشاركة الرابط، بلا JS وبلا تسجيل دخول.
export const HEAD_TARGETS = [
  {
    id: 'property-helmy',
    path: '/properties/apartment-sale-helmy-abdel-aaty-seraj-mall-230m/',
    source: '_properties/2026-10-10-apartment-helmy-abdel-aaty-seraj-230m.md',
    kind: 'property',
  },
  {
    id: 'agent',
    path: '/agent.html',
    source: 'agent.html',
    kind: 'agent',
  },
  {
    id: 'request-current',
    path: '/requests/apartment-rent-request-art-studio-large-reception-2026-10-18/',
    source: '_requests/2026-10-18-apartment-rent-art-studio-large-reception.md',
    kind: 'request',
  },
];

export const SOCIAL_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const normText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** استخراج وسوم <head> التي يهمّها مُولّد المعاينة (عدّ + محتوى) */
export function extractSocialMeta(html) {
  const text = String(html || '');
  const grab = (re) => [...text.matchAll(re)].map((m) => m[1]);
  const descriptions = grab(/<meta\s+name=["']description["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const ogDescription = grab(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const ogTitle = grab(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const twitterTitle = grab(/<meta\s+name=["']twitter:title["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const ogImageType = grab(/<meta\s+property=["']og:image:type["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const viewport = grab(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["'][^>]*>/gi);
  const title = grab(/<title[^>]*>([\s\S]*?)<\/title>/gi);
  return {
    description: normText(descriptions[0]),
    descriptionCount: descriptions.length,
    ogDescription: normText(ogDescription[0]),
    ogDescriptionCount: ogDescription.length,
    ogTitleCount: ogTitle.length,
    twitterTitleCount: twitterTitle.length,
    ogImageType: normText(ogImageType[0]).toLowerCase(),
    viewport: normText(viewport[0]),
    title: normText(title[0]),
  };
}

/** فحص واحد لصفحة: لا تكرار، وصف غير فارغ، ويطابق وصف المصدر */
export function checkSocialHead(html, target, sourceText = '') {
  const meta = extractSocialMeta(html);
  const problems = [];
  if (meta.descriptionCount !== 1) problems.push(`meta description عددها ${meta.descriptionCount} (المتوقع 1)`);
  if (meta.ogDescriptionCount !== 1) problems.push(`og:description عددها ${meta.ogDescriptionCount} (المتوقع 1)`);
  if (meta.ogTitleCount !== 1) problems.push(`og:title عددها ${meta.ogTitleCount} (المتوقع 1)`);
  if (meta.twitterTitleCount > 1) problems.push(`twitter:title مكرر (${meta.twitterTitleCount})`);
  if (!meta.description) problems.push('meta description فارغ');
  if (!meta.ogDescription) problems.push('og:description فارغ');
  if (!meta.title) problems.push('<title> فارغ');
  if (meta.description && meta.title && meta.description === meta.title) {
    problems.push('الوصف يساوي العنوان (سقط إلى fallback)');
  }
  if (sourceText && meta.description) {
    const head = normText(sourceText).slice(0, 25);
    if (head && !meta.description.startsWith(head)) {
      problems.push('وصف <head> لا يبدأ بوصف المصدر (meta_description لم يصل)');
    }
  }
  if (target.kind === 'agent') {
    if (meta.ogImageType !== 'image/webp') problems.push(`og:image:type=${meta.ogImageType || '<none>'} (المتوقع image/webp)`);
    if (!meta.viewport.includes('interactive-widget=resizes-content')) problems.push('viewport بلا interactive-widget=resizes-content');
    if (!meta.viewport.includes('viewport-fit=cover')) problems.push('viewport بلا viewport-fit=cover');
    if (/user-scalable=no|maximum-scale=1(\.0)?/.test(meta.viewport)) problems.push('viewport يعطّل التكبير');
  }
  return { ok: problems.length === 0, problems, meta };
}

/** قائمة كل ملفات MP3 المنشورة (مسار URL + حجم محلي للمقارنة) */
export function listAudioFiles(root = ROOT) {
  const base = path.join(root, 'assets', 'audio');
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
        const rel = path.relative(path.join(root, 'assets', 'audio'), full).split(path.sep).join('/');
        out.push({
          url: `${AUDIO_PREFIX}${rel}`,
          bytes: fs.statSync(full).size,
        });
      }
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * تصنيف استجابة MP3.
 * - 206 مقبول فقط لو Content-Range موجود بصيغة bytes 0-0/<total>
 * - 200 مقبول لو Content-Type audio/mpeg وContent-Length > 0
 * - 416 مقبول فقط لو Content-Range يذكر المجموع (بعض CDNs ترفض النطاق الصفري)
 */
export function classifyAudioResponse({ status, headers = {}, expectedBytes = null } = {}) {
  const type = String(headers['content-type'] || '').toLowerCase();
  const range = String(headers['content-range'] || '');
  const lengthHeader = headers['content-length'];
  const length = lengthHeader === undefined ? null : Number(lengthHeader);
  const isMpeg = type.startsWith('audio/mpeg') || type.startsWith('audio/mp3');

  if (status === 206) {
    if (!isMpeg) return { ok: false, reason: `content-type=${type || '<none>'} (المتوقع audio/mpeg)` };
    const m = range.match(/^bytes\s+0-0\/(\d+)$/i);
    if (!m) return { ok: false, reason: `content-range=${range || '<none>'} (المتوقع bytes 0-0/<total>)` };
    const total = Number(m[1]);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: `content-range total غير صالح: ${range}` };
    if (expectedBytes !== null && total !== expectedBytes) {
      return { ok: false, reason: `حجم المنشور ${total} ≠ حجم الملف ${expectedBytes}` };
    }
    return { ok: true, total };
  }
  if (status === 200) {
    if (!isMpeg) return { ok: false, reason: `content-type=${type || '<none>'} (المتوقع audio/mpeg)` };
    if (length !== null && !(length > 0)) return { ok: false, reason: `content-length=${lengthHeader}` };
    if (expectedBytes !== null && length !== null && length !== expectedBytes) {
      return { ok: false, reason: `حجم المنشور ${length} ≠ حجم الملف ${expectedBytes}` };
    }
    return { ok: true, total: length };
  }
  if (status === 416) {
    const m = range.match(/\/(\d+)$/);
    if (isMpeg && m) return { ok: true, total: Number(m[1]), note: 'CDN رفض النطاق الصفري لكنه أعلن الحجم' };
  }
  return { ok: false, reason: `HTTP ${status}` };
}

/** اقتراح رابط الصحة لبوابة MCP من بطاقة mcp.json المنشورة */
export function mcpHealthUrl(card) {
  const endpoint = card?.transport?.endpoint;
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (url.pathname.endsWith('/mcp')) url.pathname = url.pathname.slice(0, -4) + '/health';
    else url.pathname = '/health';
    return url.toString();
  } catch {
    return null;
  }
}

/** انتظار شرط مع مهلة — يُستخدم لتقارب Pages (CDN) بعد النشر */
export async function pollUntil(fn, { attempts = 20, delayMs = 10000, sleep = defaultSleep, onAttempt = () => {} } = {}) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      last = await fn(i);
      if (last && last.ok) return { ok: true, attempts: i, value: last.value };
    } catch (err) {
      last = { ok: false, error: String(err.message || err) };
    }
    onAttempt(i, last);
    if (i < attempts) await sleep(delayMs);
  }
  return { ok: false, attempts, error: last?.error || last?.reason || 'timeout' };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ليس JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

const STYLE_MIN_PATH = 'assets/css/style.min.css';

/**
 * تقارب بديل عندما لا يوجد ختم الـSHA على الموقع.
 * السبب الواقعي (2026-10-22): إعداد GitHub Pages لهذا المستودع
 * `build_type: legacy` (نشر من الفرع master)، فيبني GitHub الموقع بنفسه بعد
 * تشغيل deploy.yml ويمسح `_site/.well-known/deploy-info.json` الذي يختمه
 * الـworkflow — مع أن المحتوى المنشور مطابق للفرع. بدل تفشيل التحقق كذبًا،
 * نقارن بايتات `assets/css/style.min.css` المنشور بنسخة المستودع: أي اختلاف
 * يعني أن CDN يقدّم بناءً قديمًا (وهو ما يجب أن يفشل).
 */
async function contentConvergence(fetchImpl, site) {
  const localPath = path.join(ROOT, STYLE_MIN_PATH);
  let local;
  try { local = fs.readFileSync(localPath); } catch { return { ok: false, error: 'لا ملف style.min.css محليًا للمقارنة' }; }
  const localHash = crypto.createHash('sha256').update(local).digest('hex');
  try {
    const res = await fetchImpl(`${site}/${STYLE_MIN_PATH}?ts=${Date.now()}&n=${Math.random()}`, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    if (res.status !== 200) return { ok: false, error: `${STYLE_MIN_PATH} HTTP ${res.status}` };
    const remote = Buffer.from(await res.arrayBuffer());
    const remoteHash = crypto.createHash('sha256').update(remote).digest('hex');
    if (remoteHash !== localHash) return { ok: false, error: `style.min.css منشور مختلف عن المستودع (${remoteHash.slice(0, 12)} ≠ ${localHash.slice(0, 12)})` };
    return { ok: true, value: { method: 'style-hash', sha256: localHash } };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * التحقق الكامل. تُرجع { ok, failures, report } بلا أي استثناءات متوقعة.
 * @param {object} opts
 * @param {string} opts.site
 * @param {string} [opts.expectedSha]
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutS]
 */
export async function verifyDeployment(opts = {}) {
  const site = String(opts.site || SITE_DEFAULT).replace(/\/$/, '');
  const expectedSha = String(opts.expectedSha || '').trim().toLowerCase();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutS = Number(opts.timeoutS || process.env.DEPLOY_VERIFY_TIMEOUT_S || 300);
  const delayMs = Number(opts.delayMs || 10000);
  const mcpDelayMs = Number(opts.mcpDelayMs || 15000);
  const mcpAttempts = Number(opts.mcpAttempts || 24);
  const attempts = Math.max(1, Math.ceil(timeoutS / Math.max(1, delayMs / 1000)));
  const failures = [];
  const report = { site, expected_sha: expectedSha || null, checked_at: new Date().toISOString() };

  const fail = (check, reason) => failures.push({ check, reason });

  // 1) تقارب النشر: الـSHA المنشور = الـSHA المطلوب
  const stampUrl = `${site}/.well-known/deploy-info.json?ts=${Date.now()}`;
  const convergence = await pollUntil(async () => {
    const r = await getJson(fetchImpl, `${stampUrl}&n=${Math.random()}`);
    if (r.status !== 200 || !r.json) return { ok: false, error: `deploy-info HTTP ${r.status}` };
    if (!expectedSha) return { ok: true, value: r.json };
    const sha = String(r.json.sha || '').toLowerCase();
    return sha === expectedSha ? { ok: true, value: r.json } : { ok: false, error: `sha=${sha || '<none>'} ≠ ${expectedSha}` };
  }, { attempts, delayMs, onAttempt: (i, last) => { report.last_convergence_attempt = { attempt: i, error: last?.error || null }; } });

  if (convergence.ok) {
    report.deploy_info = convergence.value;
  } else if (/deploy-info HTTP 404/.test(String(convergence.error || ''))) {
    // لا ختم على الموقع ⇒ ناشر legacy يبني من الفرع. نقبل التقارب إن كان
    // الملف المنشور مطابقًا بايتًا ببايت لنسخة المستودع، وإلا نفشل بصوت عالٍ.
    const fallback = await contentConvergence(fetchImpl, site);
    report.stamp_missing = convergence.error || null;
    if (fallback.ok) report.deploy_info = { ...fallback.value, note: 'deploy-info.json غير موجود (ناشر legacy) — تم التحقق من بصمة style.min.css' };
    else fail('deploy_convergence', `${convergence.error} · بديل المحتوى فشل: ${fallback.error}`);
  } else {
    fail('deploy_convergence', convergence.error || 'timeout');
  }

  // 2) الصفحات والأصول الأساسية
  for (const p of ['/', '/agent.html', '/sw.js', '/assets/css/style.min.css']) {
    try {
      const res = await fetchImpl(site + p, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
      report[p] = { status: res.status, type: res.headers.get('content-type') };
      if (res.status !== 200) fail(`asset:${p}`, `HTTP ${res.status}`);
    } catch (err) {
      fail(`asset:${p}`, String(err.message || err));
    }
  }

  // 3) الـfeed = المستودع (مع انتظار تقارب CDN — لا فشل كاذب)
  const repoCount = fs.readdirSync(path.join(ROOT, '_properties')).filter((f) => f.endsWith('.md')).length;
  report.repo_properties = repoCount;
  let feedCount = null;
  const feedPoll = await pollUntil(async () => {
    const feed = await getJson(fetchImpl, `${site}/ai-feed.json?ts=${Date.now()}&n=${Math.random()}`);
    if (feed.status !== 200 || !feed.json) return { ok: false, error: `HTTP ${feed.status} أو JSON غير صالح` };
    const count = Array.isArray(feed.json.properties) ? feed.json.properties.length : null;
    report.feed = { status: feed.status, total_count: feed.json.total_count ?? null, properties: count, generated_at: feed.json.generated_at ?? null };
    if (!(count > 0)) return { ok: false, error: 'لا وحدات في الـfeed' };
    if (count !== repoCount) return { ok: false, error: `feed=${count} ≠ _properties=${repoCount}` };
    if (feed.json.total_count !== undefined && Number(feed.json.total_count) !== count) {
      return { ok: false, error: `total_count=${feed.json.total_count} ≠ properties=${count}` };
    }
    return { ok: true, value: count };
  }, { attempts: Math.max(6, Math.ceil(attempts / 2)), delayMs, onAttempt: () => {} });
  if (feedPoll.ok) feedCount = feedPoll.value;
  else fail('ai_feed', feedPoll.error || 'feed لم يتقارب');

  // 4) بوابة MCP: العدد نفسه — مع انتظار الكاش عندها (cf.cacheTtl = 300s)
  try {
    const card = await getJson(fetchImpl, `${site}/${MCP_CARD_PATH}?ts=${Date.now()}`);
    const healthUrl = mcpHealthUrl(card.json) || process.env.MCP_HEALTH_URL || null;
    report.mcp = { card_status: card.status, health_url: healthUrl };
    if (!healthUrl) fail('mcp', 'لا endpoint في بطاقة mcp.json ولا MCP_HEALTH_URL');
    else {
      const mcpPoll = await pollUntil(async () => {
        const health = await getJson(fetchImpl, `${healthUrl}?ts=${Date.now()}&n=${Math.random()}`);
        report.mcp.health_status = health.status;
        report.mcp.properties = health.json?.properties ?? null;
        if (health.status !== 200 || !health.json) return { ok: false, error: `HTTP ${health.status}` };
        if (feedCount !== null && Number(health.json.properties) !== feedCount) {
          return { ok: false, error: `MCP=${health.json.properties} ≠ feed=${feedCount} (قد يكون كاش البوابة)` };
        }
        return { ok: true, value: health.json.properties };
      }, { attempts: mcpAttempts, delayMs: mcpDelayMs });
      if (!mcpPoll.ok) fail('mcp_count', mcpPoll.error || 'MCP لم يتقارب');
    }
  } catch (err) {
    fail('mcp', String(err.message || err));
  }

  // 5) raw <head> كما يراه WhatsApp/Facebook (بلا JS)
  report.head = {};
  for (const target of HEAD_TARGETS) {
    try {
      const res = await fetchImpl(site + target.path, {
        headers: { 'user-agent': SOCIAL_CRAWLER_UA, 'cache-control': 'no-cache' },
        redirect: 'follow',
      });
      const html = await res.text();
      let sourceText = '';
      if (target.source.endsWith('.md')) {
        try { sourceText = String(parseFrontMatter(fs.readFileSync(path.join(ROOT, target.source), 'utf8')).data.description || ''); }
        catch { sourceText = ''; }
      }
      const checked = res.status === 200
        ? checkSocialHead(html, target, sourceText)
        : { ok: false, problems: [`HTTP ${res.status}`], meta: {} };
      report.head[target.id] = { path: target.path, status: res.status, ok: checked.ok, problems: checked.problems, description: checked.meta?.description || '' };
      for (const problem of checked.problems) fail(`head:${target.id}`, problem);
    } catch (err) {
      fail(`head:${target.id}`, String(err.message || err));
    }
  }

  // 6) كل ملفات الصوت
  const audio = listAudioFiles(ROOT);
  report.audio_total = audio.length;
  if (!audio.length) fail('audio', 'لا ملفات MP3 في المستودع');
  const audioResults = await mapLimit(audio, 6, async (file) => {
    try {
      const res = await fetchImpl(site + file.url, {
        method: 'HEAD',
        headers: { range: 'bytes=0-0', 'cache-control': 'no-cache', 'accept-encoding': 'identity' },
        redirect: 'follow',
      });
      const headers = {};
      res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const verdict = classifyAudioResponse({ status: res.status, headers, expectedBytes: file.bytes });
      return { url: file.url, status: res.status, ...verdict };
    } catch (err) {
      return { url: file.url, ok: false, reason: String(err.message || err) };
    }
  });
  const audioFailed = audioResults.filter((r) => !r.ok);
  report.audio_checked = audioResults.length;
  report.audio_failed = audioFailed.length;
  for (const bad of audioFailed.slice(0, 10)) fail(`audio:${bad.url}`, bad.reason);
  if (audioFailed.length) fail('audio', `${audioFailed.length}/${audioResults.length} ملف فاشل`);

  return { ok: failures.length === 0, failures, report, audio: audioResults };
}

// ───────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await verifyDeployment({
    site: process.env.SITE_URL || SITE_DEFAULT,
    expectedSha: process.env.EXPECTED_SHA || '',
    timeoutS: process.env.DEPLOY_VERIFY_TIMEOUT_S || 300,
  });
  console.log(JSON.stringify(result.report, null, 2));
  if (result.ok) {
    console.log(`✅ النشر متطابق: ${result.report.audio_checked} ملف صوت · ${result.report.feed?.properties} وحدة · MCP ${result.report.mcp?.properties}`);
  } else {
    console.error(`❌ فشل التحقق بعد النشر (${result.failures.length}):`);
    for (const f of result.failures) console.error(`  - ${f.check}: ${f.reason}`);
    process.exitCode = 1;
  }
}
