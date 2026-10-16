// ══════════════════════════════════════════════════════════════════════
//  فاحص بوابة MCP الحيّة — _diag/verify-mcp-gateway.mjs
// ──────────────────────────────────────────────────────────────────────
//  لماذا هذا الملف موجود؟
//    اختبار الوحدة (_worker/tests/mcp-gateway.test.mjs) يثبت أن **الكود**
//    صحيح، وخطوة الدخان في deploy-mcp-gateway.yml تثبت أن `GET /` يردّ 200.
//    ولا واحد منهما يثبت أن **البوابة المنشورة** تُجري مصافحة MCP فعلية
//    تصلح لأن يعتمد عليها نموذج. الفجوة بينهما هي بالضبط ما أبقى الحالة
//    `pending-deployment` رغم نجاح الـworkflow: النجاح كان «تخطّيًا بلطفًا»
//    بلا نشر، والدخان لم يُشغَّل أصلًا. هذا الفاحص يسدّ الفجوة.
//
//  ما يفحصه (مصافحة كاملة عبر الشبكة الحقيقية، بلا mocks):
//    card            GET  /            بطاقة الخدمة + read_only + الأدوات
//    health          GET  /health      status=ok · properties · read_only
//    initialize      POST /mcp         تفاوض إصدار البروتوكول + serverInfo
//    initialized     POST /mcp         إشعار ⇒ 202 بلا جسم (كما تقتضي المواصفة)
//    tools/list      POST /mcp         الأدوات = كتالوج المستودع
//    tools/call      POST /mcp         استدعاء فعلي على بيانات حقيقية
//    resources/read  POST /mcp         semsar://catalog + semsar://contact
//
//  مبدأ «لا تلفّق» مطبَّق على الفاحص نفسه:
//    • كل نتيجة تُقارَن بكتالوج المستودع (عدد الوحدات من `_properties`،
//      وأسماء الأدوات من `mcp.json`) — لا برقم متوقَّع مكتوب هنا.
//    • الغياب يبقى غيابًا: إن تعذّر الوصول يُقال «تعذّر الوصول من هذه
//      البيئة» ولا يُترجم إلى نجاح ولا إلى «غير منشورة» بالتخمين.
//    • `--flip` يرفض تبديل الحالة إلى `live` ما لم تنجح المصافحة فعلًا.
//
//  قيود بيئة التنفيذ (موثّقة لأنها تغيّر طريقة الاستخدام):
//    بيئة التطوير هنا لا تملك مخرجًا إلى *.workers.dev (الاتصال يفشل)،
//    بينما GitHub Actions يملكه. لذلك الفحص الحيّ يُشغَّل في CI، وتبديل
//    الحالة محليًا يتم عبر دليل مُتحقَّق منه من CI نفسه:
//      node _diag/verify-mcp-gateway.mjs --flip --ci-run <run-id>
//    ويقرأ الفاحص ذلك الدليل من GitHub API (لا من ملف محلي قابل للفبركة):
//    نجاح خطوة المصافحة + نسخة التقرير المضمّنة في ملخّص الفحص + تطابق
//    `commit` في التقرير مع `head_sha` للتشغيل.
//
//  التشغيل:
//    node _diag/verify-mcp-gateway.mjs                     # مصافحة مباشرة
//    node _diag/verify-mcp-gateway.mjs --ci                # + ملخّص لـGitHub
//    node _diag/verify-mcp-gateway.mjs --json=/tmp/r.json  # + تقرير آلي
//    node _diag/verify-mcp-gateway.mjs --flip --ci-run 123 # إعلان live بدليل
//
//  بلا أي اعتماديات خارجية (Node 22 فقط) — مثل بقية فاحصات _diag/.
// ══════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProperties } from '../scripts/lib/properties.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://nasr-ai-gateway.footcai-555.workers.dev';
const SITE = 'https://nasr-realestate.github.io';
const REPO = 'nasr-realestate/nasr-realestate.github.io';
const API = 'https://api.github.com';

/** أسماء الخطوات في deploy-mcp-gateway.yml — تُقرأ كما هي للتحقّق من الدليل. */
const STEP_DEPLOY = 'Deploy with Wrangler (this Worker only)';
const STEP_SMOKE = 'Smoke-test the live endpoint (GET only, never POST)';
const STEP_HANDSHAKE = 'MCP handshake against the live endpoint';
const WORKFLOW_PATH = '.github/workflows/deploy-mcp-gateway.yml';
const WORKFLOW_NAME = 'Deploy MCP Gateway';
const JOB_DEPLOY = 'Deploy nasr-ai-gateway';

/** ما تردّه Cloudflare عندما يكون العامل غير منشور إطلاقًا. */
const NOT_DEPLOYED_MARKER = 'There is nothing here yet';
/** وسم بداية نسخة التقرير داخل ملخّص الفحص — يُقرأ آليًا عند `--flip --ci-run`. */
const TRANSCRIPT_MARKER = '<!-- mcp-handshake-transcript -->';

const REQUEST_TIMEOUT_MS = 25_000;
const CARD_ATTEMPTS = 6;
const CARD_RETRY_DELAY_MS = 5_000;
const TODAY = new Date().toISOString().slice(0, 10);

/* ═══════════════════════ كتالوج المستودع (مصدر المقارنة) ═══════════════════════ */

/**
 * يقرأ الحقيقة من المستودع نفسه: عدد الوحدات من `_properties`، وأسماء
 * الأدوات والموارد المعلَنة في البطاقة `mcp.json`. لا رقم متوقَّع هنا.
 */
function readRepoCatalog() {
  const properties = loadProperties(path.join(ROOT, '_properties'));
  const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'api/index.json'), 'utf8'));
  return {
    count: properties.length,
    index_count: index.total_count,
    card_counts_properties: card.counts?.properties ?? null,
    card_tools: (card.tools ?? []).map((tool) => tool.name),
    card_resources: (card.resources ?? []).map((resource) => resource.uri),
    card_status: card.availability?.status ?? null,
    sample_slug: properties[0]?.slug ?? null,
  };
}

/* ═══════════════════════════════ HTTP ═══════════════════════════════ */

/**
 * طلب واحد مع مهلة صريحة. لا يرمي عند حالة HTTP غير 200 — بل يعيد الحالة
 * والجسم، لأن «404 من Cloudflare» دليلٌ بحدّ ذاته ولا يجوز ابتلاعه.
 */
async function request(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // جسم غير JSON (صفحة Cloudflare الافتراضية مثلًا) — يُبلَّغ كما هو
    }
    return { url, status: response.status, text, json, headers: response.headers, transportError: null };
  } catch (error) {
    return { url, status: 0, text: '', json: null, headers: null, transportError: String(error?.cause?.code ?? error?.message ?? error) };
  }
}

const get = (url) => request(url);
const postRpc = (id, method, params) =>
  request(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
  });

/** تصنيف سبب عدم الوصول — الفرق بين «غير منشورة» و«بيئتي لا تصل» فرق جوهري. */
function diagnose(res) {
  if (res.transportError) return `UNREACHABLE (${res.transportError})`;
  if (typeof res.text === 'string' && res.text.includes(NOT_DEPLOYED_MARKER)) return 'NOT_DEPLOYED';
  return `HTTP_${res.status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ═══════════════════════════ أدوات التسجيل ═══════════════════════════ */

/**
 * يسجّل نتيجة فحص واحدة. `checks` قائمة ادعاءات، وكل ادعاء له سبب مقروء
 * حتى عندما يفشل — فلا يخرج من CI رقم أحمر بلا تفسير.
 */
function step(id, title) {
  const record = { id, title, ok: true, checks: [], evidence: {}, error: null };
  return {
    record,
    expect(label, ok, detail = '') {
      record.checks.push({ label, ok: Boolean(ok), detail });
      if (!ok) record.ok = false;
      return Boolean(ok);
    },
    note(key, value) {
      record.evidence[key] = value;
      return value;
    },
    fail(message) {
      record.ok = false;
      record.error = message;
      return record;
    },
  };
}

/* ═══════════════════════════════ الفحوص ═══════════════════════════════ */

/** 1) بطاقة الخدمة: `GET /` — الهوية والقراءة فقط والأدوات المعلَنة. */
async function checkCard(catalog) {
  const s = step('card', 'GET / — service card');
  const res = await get(`${BASE}/`);
  if (!res.json) return s.fail(`بطاقة الخدمة غير مقروءة: ${diagnose(res)}`);
  s.expect('HTTP 200', res.status === 200, `الواقع ${res.status}`);
  s.expect("service === 'semsar-talabk'", res.json.service === 'semsar-talabk', `الواقع ${String(res.json.service)}`);
  s.expect('read_only === true', res.json.read_only === true, `الواقع ${String(res.json.read_only)}`);
  s.expect('requires_secrets === false', res.json.requires_secrets === false, `الواقع ${String(res.json.requires_secrets)}`);
  s.expect("protocol.endpoint === '/mcp'", res.json.protocol?.endpoint === '/mcp', `الواقع ${String(res.json.protocol?.endpoint)}`);

  const live = (res.json.tools ?? []).map((tool) => tool.name);
  s.note('tools', live);
  s.note('service', res.json.service ?? null);
  s.note('read_only', res.json.read_only ?? null);
  s.note('release', res.json.release ?? null);
  const missing = catalog.card_tools.filter((name) => !live.includes(name));
  s.expect('كل أداة معلَنة في بطاقة المستودع موجودة حيّة', missing.length === 0, missing.length ? `ناقصة: ${missing.join(', ')}` : `${live.length} أداة`);
  const extra = live.filter((name) => !catalog.card_tools.includes(name));
  if (extra.length) s.note('tools_live_only', extra); // زيادة حيّة تُبلَّغ ولا تُفشل
  return s.record;
}

/** 2) الصحة: `GET /health` — ويجب أن يساوي عدد الوحدات كتالوجَ المستودع. */
async function checkHealth(catalog) {
  const s = step('health', 'GET /health — live data freshness');
  const res = await get(`${BASE}/health`);
  if (!res.json) return s.fail(`فحص الصحة غير مقروء: ${diagnose(res)}`);
  s.expect('HTTP 200', res.status === 200, `الواقع ${res.status}`);
  s.expect("status === 'ok'", res.json.status === 'ok', `الواقع ${String(res.json.status)}`);
  s.expect('read_only === true', res.json.read_only === true, `الواقع ${String(res.json.read_only)}`);
  s.expect(
    `properties === ${catalog.count} (كتالوج المستودع)`,
    res.json.properties === catalog.count,
    `الواقع ${String(res.json.properties)} · المستودع ${catalog.count}`,
  );
  s.expect('feed_generated_at غير فارغ', Boolean(res.json.feed_generated_at), `الواقع ${String(res.json.feed_generated_at)}`);
  s.note('status', res.json.status ?? null);
  s.note('properties', res.json.properties ?? null);
  s.note('read_only', res.json.read_only ?? null);
  s.note('feed_generated_at', res.json.feed_generated_at ?? null);
  s.note('release', res.json.release ?? null);
  return s.record;
}

/** 3) المصافحة: `initialize` — تفاوض الإصدار وهوية الخادم والقدرات. */
async function checkInitialize() {
  const s = step('initialize', 'POST /mcp — initialize');
  const res = await postRpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nasr-repo-verifier', version: '1.0.0' },
  });
  if (!res.json) return s.fail(`initialize لم يُجب بـJSON: ${diagnose(res)}`);
  s.expect('HTTP 200', res.status === 200, `الواقع ${res.status}`);
  s.expect('jsonrpc === 2.0', res.json.jsonrpc === '2.0', `الواقع ${String(res.json.jsonrpc)}`);
  s.expect('id محفوظ (1)', res.json.id === 1, `الواقع ${String(res.json.id)}`);
  s.expect('بلا خطأ JSON-RPC', !res.json.error, res.json.error ? JSON.stringify(res.json.error) : 'لا خطأ');

  const result = res.json.result ?? {};
  s.expect('protocolVersion مدعوم', ['2025-06-18', '2025-03-26', '2024-11-05'].includes(result.protocolVersion), `الواقع ${String(result.protocolVersion)}`);
  s.expect("serverInfo.name === 'semsar-talabk'", result.serverInfo?.name === 'semsar-talabk', `الواقع ${String(result.serverInfo?.name)}`);
  s.expect('capabilities.tools معلَنة', Boolean(result.capabilities?.tools), JSON.stringify(result.capabilities ?? null));
  s.expect('capabilities.resources معلَنة', Boolean(result.capabilities?.resources), JSON.stringify(result.capabilities?.resources ?? null));
  s.expect('instructions غير فارغة', String(result.instructions ?? '').length > 40, `${String(result.instructions ?? '').length} حرفًا`);
  s.expect('ترويسة MCP-Protocol-Version موجودة', Boolean(res.headers?.get('mcp-protocol-version')), String(res.headers?.get('mcp-protocol-version') ?? ''));
  s.note('protocol_version', result.protocolVersion ?? null);
  s.note('server_version', result.serverInfo?.version ?? null);
  return s.record;
}

/** 4) الإشعار: `notifications/initialized` ⇒ 202 بلا جسم. */
async function checkInitialized() {
  const s = step('initialized', 'POST /mcp — notifications/initialized (202, empty body)');
  const res = await postRpc(null, 'notifications/initialized');
  s.expect('HTTP 202', res.status === 202, `الواقع ${res.status}`);
  s.expect('الجسم فارغ', res.text.trim() === '', `الواقع ${JSON.stringify(res.text.slice(0, 80))}`);
  s.note('status', res.status);
  return s.record;
}

/** 5) `tools/list` — يجب أن يطابق كتالوج المستودع تمامًا. */
async function checkToolsList(catalog) {
  const s = step('tools/list', 'POST /mcp — tools/list');
  const res = await postRpc(2, 'tools/list');
  const tools = res.json?.result?.tools;
  if (!Array.isArray(tools)) return s.fail(`tools/list لم يُعِد قائمة: ${diagnose(res)} · ${JSON.stringify(res.json?.error ?? null)}`);
  const live = tools.map((tool) => tool.name);
  s.note('tools', live);
  const missing = catalog.card_tools.filter((name) => !live.includes(name));
  const extra = live.filter((name) => !catalog.card_tools.includes(name));
  s.expect('لا أداة معلَنة ناقصة', missing.length === 0, missing.length ? `ناقصة: ${missing.join(', ')}` : 'مكتملة');
  s.expect('لا أداة حيّة غير معلَنة في البطاقة', extra.length === 0, extra.length ? `زائدة عن البطاقة: ${extra.join(', ')}` : 'مطابقة');
  s.expect('كل أداة لها inputSchema صارم', tools.every((tool) => tool.inputSchema?.type === 'object' && tool.inputSchema?.additionalProperties === false), `${tools.length} أداة`);
  s.expect('كل أداة لها وصف قابل للتصرّف', tools.every((tool) => String(tool.description ?? '').length > 30), 'طول الوصف > 30');
  return s.record;
}

/** 6) `tools/call` — استدعاء حقيقي على بيانات حقيقية، لا مجرد شكل صحيح. */
async function checkToolsCall(catalog) {
  const s = step('tools/call', 'POST /mcp — tools/call (search_properties · get_property · market_summary · get_contact)');

  const search = await postRpc(3, 'tools/call', { name: 'search_properties', arguments: { limit: 3 } });
  const searchOut = search.json?.result;
  s.expect('search_properties: بلا isError', searchOut?.isError !== true, JSON.stringify(searchOut?.structuredContent?.error ?? search.json?.error ?? null));
  s.expect('search_properties: نص النتيجة غير فارغ', String(searchOut?.content?.[0]?.text ?? '').length > 20, `${String(searchOut?.content?.[0]?.text ?? '').length} حرفًا`);
  s.expect(
    'search_properties: total_count === كتالوج المستودع',
    searchOut?.structuredContent?.total_count === catalog.count,
    `الواقع ${String(searchOut?.structuredContent?.total_count)} · المستودع ${catalog.count}`,
  );
  s.expect('search_properties: أعاد وحدات', (searchOut?.structuredContent?.properties?.length ?? 0) > 0, `${searchOut?.structuredContent?.properties?.length ?? 0} وحدة`);
  s.note('search_returned', searchOut?.structuredContent?.returned ?? null);
  s.note('search_total_count', searchOut?.structuredContent?.total_count ?? null);

  const summary = await postRpc(4, 'tools/call', { name: 'market_summary', arguments: {} });
  const summaryOut = summary.json?.result;
  s.expect('market_summary: بلا isError', summaryOut?.isError !== true, JSON.stringify(summary.json?.error ?? null));
  s.expect('market_summary: total === كتالوج المستودع', summaryOut?.structuredContent?.total === catalog.count, `الواقع ${String(summaryOut?.structuredContent?.total)}`);
  s.note('market_total', summaryOut?.structuredContent?.total ?? null);

  const contact = await postRpc(5, 'tools/call', { name: 'get_contact', arguments: {} });
  const contactOut = contact.json?.result;
  s.expect('get_contact: بلا isError', contactOut?.isError !== true, JSON.stringify(contact.json?.error ?? null));
  s.expect('get_contact: يسمّي الوسيط', String(contactOut?.structuredContent?.broker ?? '').length > 2, String(contactOut?.structuredContent?.broker ?? ''));
  s.note('contact_broker', contactOut?.structuredContent?.broker ?? null);

  // وحدة حقيقية من كتالوج المستودع — لا slug مُختلَق.
  const one = await postRpc(6, 'tools/call', { name: 'get_property', arguments: { id: catalog.sample_slug } });
  const oneOut = one.json?.result;
  s.expect(`get_property(${catalog.sample_slug}): بلا isError`, oneOut?.isError !== true, JSON.stringify(one.json?.error ?? oneOut?.structuredContent?.error ?? null));
  s.expect('get_property: أعاد رابط الوحدة', String(oneOut?.structuredContent?.url ?? '').startsWith(SITE), String(oneOut?.structuredContent?.url ?? ''));
  s.note('property_slug', oneOut?.structuredContent?.slug ?? null);
  s.note('property_url', oneOut?.structuredContent?.url ?? null);
  return s.record;
}

/** 7) `resources/read` — الكتالوج والتواصل، مع مقارنة العدد بالمستودع. */
async function checkResourcesRead(catalog) {
  const s = step('resources/read', 'POST /mcp — resources/read (semsar://catalog · semsar://contact)');

  const listed = await postRpc(7, 'resources/list');
  const live = (listed.json?.result?.resources ?? []).map((resource) => resource.uri);
  s.note('resources', live);
  const missing = catalog.card_resources.filter((uri) => !live.includes(uri));
  s.expect('كل مورد معلَن في البطاقة موجود حيّ', missing.length === 0, missing.length ? `ناقصة: ${missing.join(', ')}` : `${live.length} مورد`);

  const catalogRead = await postRpc(8, 'resources/read', { uri: 'semsar://catalog' });
  const text = catalogRead.json?.result?.contents?.[0]?.text ?? '';
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  s.expect('semsar://catalog: JSON صالح', Boolean(payload), `${String(text).length} حرفًا`);
  s.expect('semsar://catalog: total_count === كتالوج المستودع', payload?.total_count === catalog.count, `الواقع ${String(payload?.total_count)} · المستودع ${catalog.count}`);
  s.expect('semsar://catalog: properties مصفوفة كاملة', Array.isArray(payload?.properties) && payload.properties.length === catalog.count, `${payload?.properties?.length ?? 'null'} عنصرًا`);
  s.note('catalog_total_count', payload?.total_count ?? null);

  const contactRead = await postRpc(9, 'resources/read', { uri: 'semsar://contact' });
  const contactText = contactRead.json?.result?.contents?.[0]?.text ?? '';
  s.expect('semsar://contact: يذكر الوسيط', contactText.includes('طارق'), `${contactText.length} حرفًا`);

  const unknown = await postRpc(10, 'resources/read', { uri: 'semsar://does-not-exist' });
  s.expect('مورد غير موجود ⇒ خطأ JSON-RPC لا 500', Boolean(unknown.json?.error) && unknown.status === 200, `HTTP ${unknown.status} · ${JSON.stringify(unknown.json?.error ?? null)}`);
  return s.record;
}

/* ═══════════════════════════════ المصافحة ═══════════════════════════════ */

/**
 * يجري المصافحة كاملة. يحاول خطوة البطاقة مرات عدة لأن النشر على حافة
 * Cloudflare قد يستغرق ثوانٍ بعد `wrangler deploy` — أما بقية الخطوات فتُجرى
 * مرة واحدة بعد أن تثبت البطاقة.
 */
async function handshake(catalog) {
  const attempts = [];
  let cardRecord = null;
  for (let attempt = 1; attempt <= CARD_ATTEMPTS; attempt += 1) {
    const probe = await get(`${BASE}/health`);
    attempts.push({ attempt, result: probe.status === 200 ? 'HTTP 200' : diagnose(probe) });
    if (probe.status === 200) break;
    if (attempt < CARD_ATTEMPTS) await sleep(CARD_RETRY_DELAY_MS);
  }

  cardRecord = await checkCard(catalog);
  const steps = [cardRecord];
  if (cardRecord.ok) {
    steps.push(await checkHealth(catalog));
    steps.push(await checkInitialize());
    steps.push(await checkInitialized());
    steps.push(await checkToolsList(catalog));
    steps.push(await checkToolsCall(catalog));
    steps.push(await checkResourcesRead(catalog));
  } else {
    // لا معنى لمصافحة على بوابة لا تردّ: يُبلَّغ السبب وحده بوضوح.
    steps.push({ id: 'skipped', title: 'بقية خطوات المصافحة', ok: false, checks: [], evidence: {}, error: 'تخطّيت لأن خطوة البطاقة فشلت' });
  }
  return { steps, attempts };
}

/* ═══════════════════════════════ التقرير ═══════════════════════════════ */

/** يقتطع النصوص الطويلة حتى تبقى نسخة التقرير صغيرة بما يكفي لملخّص الفحص. */
function compact(value) {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = compact(item);
    return out;
  }
  return value;
}

function buildReport(catalog, result, verdictNote) {
  const ok = result.steps.every((entry) => entry.ok);
  return {
    verdict: ok ? 'pass' : 'fail',
    generated_at: new Date().toISOString(),
    base: BASE,
    site: SITE,
    commit: process.env.GITHUB_SHA ?? null,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    ref: process.env.GITHUB_REF ?? null,
    repo_catalog: catalog,
    verdict_note: verdictNote ?? null,
    attempts: result.attempts,
    steps: compact(result.steps),
  };
}

/** يطبع خطوة واحدة من تقرير المصافحة (مفصولة عن الطباعة العامة لتبقى بسيطة). */
function printStep(entry) {
  console.log(`   ${entry.ok ? '✅' : '❌'} ${entry.id} — ${entry.title}`);
  if (entry.error) console.log(`      السبب: ${entry.error}`);
  for (const check of entry.checks ?? []) {
    if (!check.ok) {
      const suffix = check.detail ? ` — ${check.detail}` : '';
      console.log(`      ✗ ${check.label}${suffix}`);
    }
  }
}

function printReport(report) {
  const mark = report.verdict === 'pass' ? '✅' : '❌';
  console.log(`${mark} MCP gateway handshake — ${report.base} — ${report.verdict.toUpperCase()}`);
  console.log(`   كتالوج المستودع: ${report.repo_catalog.count} وحدة · أدوات معلَنة: ${report.repo_catalog.card_tools.join(', ')}`);
  for (const attempt of report.attempts) console.log(`   محاولة ${attempt.attempt}: ${attempt.result}`);
  for (const entry of report.steps) printStep(entry);
}

/* ══════════════ وقائع المصافحة — القناة المقروءة برمجيًا ══════════════ */

const NOTICE_TITLE_PASS = 'MCP Gateway handshake passed';
const NOTICE_TITLE_FAIL = 'MCP Gateway handshake failed';

const evidenceOf = (report, stepId) => report.steps.find((entry) => entry.id === stepId)?.evidence ?? {};
const formatFacts = (facts) => Object.entries(facts).map(([key, value]) => `${key}=${value}`).join(' · ');

/** يحلّل سطر الوقائع: `verdict=pass · properties=102/102 · …` */
function parseMachineLine(message) {
  const facts = {};
  for (const part of String(message ?? '').split(' · ')) {
    const eq = part.indexOf('=');
    if (eq > 0) facts[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return facts;
}

/**
 * وقائع رقمية قصيرة مستخلصة من التقرير.
 *
 * لماذا قناة ثانية غير ملخّص الخطوات؟ لأن REST API **لا يكشف** ملخّصات الخطوات
 * أصلًا: `check-runs/{id}.output.summary` رجع فارغًا (طول 0) لتشغيل ناجح فعلًا
 * — تحقّق مباشر 2026-10-16 على التشغيل 38971312205 — وسجلات الخطوات في هذا
 * المستودع غير مقروءة (EOF من blob storage). القناة الوحيدة المقروءة برمجيًا
 * هي annotations، لذلك تُكتب الوقائع في `::notice` بسطر واحد قابل للتحليل،
 * ومنها يقرأ `--flip --ci-run` دليله ويربطه برأس التشغيل.
 */
function factsFromReport(report) {
  const health = evidenceOf(report, 'health');
  const card = evidenceOf(report, 'card');
  const init = evidenceOf(report, 'initialize');
  const tools = evidenceOf(report, 'tools/list');
  const resources = evidenceOf(report, 'resources/read');
  const facts = {
    verdict: report.verdict,
    properties: `${String(health.properties ?? 'null')}/${report.repo_catalog.count}`,
    health_status: String(health.status ?? 'null'),
    read_only: String(health.read_only ?? card.read_only ?? 'null'),
    protocol: String(init.protocol_version ?? 'null'),
    tools: `${(tools.tools ?? []).length}/${report.repo_catalog.card_tools.length}`,
    resources: String((resources.resources ?? []).length),
    release: String(health.release ?? card.release ?? 'null'),
    commit: String(report.commit ?? 'local'),
  };
  const failed = report.steps.filter((entry) => !entry.ok).map((entry) => entry.id);
  if (failed.length) facts.failed = failed.join(',');
  return facts;
}

/** يكتب ملخّص التشغيل للبشر (واجهة Actions) + سطر الوقائع كـannotation للآلة. */
function writeCiSummary(report) {
  const facts = factsFromReport(report);
  const title = report.verdict === 'pass' ? NOTICE_TITLE_PASS : NOTICE_TITLE_FAIL;
  console.log(`::notice title=${title}::${formatFacts(facts)}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const icon = report.verdict === 'pass' ? '✅' : '❌';
  const lines = [
    `### ${icon} MCP handshake — ${report.verdict.toUpperCase()}`,
    '',
    '```',
    formatFacts(facts),
    '```',
    '',
    '| الخطوة | النتيجة |',
    '|---|---|',
    ...report.steps.map((entry) => `| \`${entry.id}\` | ${entry.ok ? '✅' : '❌'} |`),
    '',
    TRANSCRIPT_MARKER,
    '```json',
    JSON.stringify(report),
    '```',
    '',
  ];
  fs.appendFileSync(summary, `${lines.join('\n')}\n`);
}

/* ═══════════════════════ الدليل من CI (لـ`--flip --ci-run`) ═══════════════════════ */

/**
 * قراءة واحدة من GitHub API.
 *
 * لماذا قناتان؟ بيئة التنفيذ المعزولة تعترض TLS بشهادة من مخزن النظام،
 * وNode لا يثق إلا بمخزنه المضمَّن ⇒ fetch المباشر يفشل بـ
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE (عطل حقيقي وقع عند كتابة هذا الفاحص).
 * الحل: محاولة مباشرة أولًا، ثم عملية Node فرعية بـ`--use-system-ca`
 * (نفس `process.execPath` — بلا أمر من PATH، وبلا توكن في argv).
 * لا تُبتلع الأخطاء: سبب كلتا المحاولتين يُطبع معًا.
 */
async function ghApi(urlPath) {
  const failures = [];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const direct = await request(`${API}${urlPath}`, {
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (direct.json) return direct.json;
  failures.push(`direct: ${diagnose(direct)}`);

  try {
    const child = readWithSystemCa(urlPath);
    if (child.status >= 200 && child.status < 300) {
      const parsed = JSON.parse(child.body);
      if (parsed && typeof parsed === 'object') return parsed;
      failures.push(`system-ca: HTTP ${child.status} بجسم غير كائن`);
    } else {
      failures.push(`system-ca: HTTP ${child.status}`);
    }
  } catch (error) {
    failures.push(`system-ca: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  throw new Error(`تعذّرت قراءة GitHub API ${urlPath} — ${failures.join(' · ')}`);
}

/** جلب واحد من عملية فرعية تثق بمخزن شهادات النظام (التوكن يُقرأ من البيئة). */
function readWithSystemCa(urlPath) {
  const program = [
    'const url = process.argv[1];',
    'const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };',
    'const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;',
    'if (token) headers.Authorization = "Bearer " + token;',
    'const res = await fetch(url, { headers });',
    'const body = await res.text();',
    'process.stdout.write(JSON.stringify({ status: res.status, body }));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--use-system-ca', '--input-type=module', '-e', program, `${API}${urlPath}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** يحمّل التشغيل ويتحقّق من هويته ونجاحه ونجاح خطواته الثلاث. */
async function loadVerifiedRun(runId) {
  const run = await ghApi(`/repos/${REPO}/actions/runs/${runId}`);
  if (run.name !== WORKFLOW_NAME || run.path !== WORKFLOW_PATH) {
    return { reason: `التشغيل ${runId} ليس نشر بوابة MCP (الواقع: ${String(run.name)} · ${String(run.path)})` };
  }
  if (run.conclusion !== "success") return { reason: `التشغيل ${runId} خاتمته ${String(run.conclusion)} لا success` };
  const jobs = await ghApi(`/repos/${REPO}/actions/runs/${runId}/jobs`);
  const job = (jobs.jobs ?? []).find((entry) => entry.name === JOB_DEPLOY);
  if (!job) return { reason: `لا وظيفة «${JOB_DEPLOY}» في التشغيل ${runId}` };
  const stepReason = checkSteps(job, runId);
  if (stepReason) return { reason: stepReason };
  return { run, job };
}

/**
 * النشر والدخان والمصافحة يجب أن تكون كلها success **لا skipped**.
 * هذا هو الفخّ الذي وقع فيه المستودع: تشغيل أخضر وخطوات متخطّاة بلا توكن.
 */
function checkSteps(job, runId) {
  const byName = new Map((job.steps ?? []).map((entry) => [entry.name, entry]));
  for (const name of [STEP_DEPLOY, STEP_SMOKE, STEP_HANDSHAKE]) {
    const found = byName.get(name);
    if (!found) return `الخطوة «${name}» غير موجودة في التشغيل ${runId}`;
    if (found.conclusion === "skipped") return `الخطوة «${name}» تخطّت (skipped) — أي أن النشر لم يحدث أصلًا`;
    if (found.conclusion !== "success") return `الخطوة «${name}» خاتمته ${String(found.conclusion)}`;
  }
  return null;
}

/** كل ما يجب أن يقوله سطر الوقائع — تُجمع المشاكل كلها بدل أول واحدة فقط. */
function factsProblems(facts, catalog, headSha) {
  const [liveCount, catalogCount] = String(facts.properties ?? "/").split("/");
  const problems = [];
  if (facts.verdict !== "pass") problems.push(`verdict=${String(facts.verdict)} لا pass`);
  if (Number(liveCount) !== catalog.count || Number(catalogCount) !== catalog.count) {
    problems.push(`عدد الوحدات في دليل CI (${String(facts.properties)}) ≠ كتالوج المستودع (${catalog.count})`);
  }
  if (facts.read_only !== "true") problems.push(`read_only=${String(facts.read_only)} لا true`);
  if (facts.health_status !== "ok") problems.push(`حالة الصحة=${String(facts.health_status)} لا ok`);
  if (facts.commit && facts.commit !== "local" && facts.commit !== headSha) {
    problems.push(`الدليل مرتبط بـ${String(facts.commit)} بينما رأس التشغيل ${String(headSha)}`);
  }
  return problems;
}

/** يقرأ وقائع المصافحة من annotation الخطوة — القناة الوحيدة المقروءة برمجيًا. */
async function readCiFacts(job, run, catalog) {
  const annotations = await ghApi(`/repos/${REPO}/check-runs/${job.id}/annotations`);
  const list = Array.isArray(annotations) ? annotations : [];
  const notice = list.find((entry) => String(entry.title ?? "").startsWith("MCP Gateway handshake"));
  if (!notice) return { reason: `لا annotation لمصافحة MCP في التشغيل ${run.id} — لا دليل مقروء على إجرائها` };
  if (String(notice.title) !== NOTICE_TITLE_PASS) {
    return { reason: `annotation المصافحة ليس نجاحًا: «${String(notice.title)}» — ${String(notice.message ?? "").slice(0, 240)}` };
  }
  const facts = parseMachineLine(notice.message);
  const problems = factsProblems(facts, catalog, run.head_sha);
  if (problems.length) return { reason: problems.join(" · ") };
  return { facts };
}

/**
 * يتحقّق من أن تشغيل CI معيّن أجرى المصافحة ونجحت — من GitHub API مباشرة.
 * الدليل مُرتبط بالتشغيل ورأس الـcommit، فلا يكفي ملف محلي مكتوب باليد.
 */
async function verifyCiRun(runId, catalog) {
  const loaded = await loadVerifiedRun(runId);
  if (loaded.reason) return { ok: false, reason: loaded.reason };
  const evidence = await readCiFacts(loaded.job, loaded.run, catalog);
  if (evidence.reason) return { ok: false, reason: evidence.reason };
  return { ok: true, facts: evidence.facts, run: loaded.run };
}

/* ═══════════════════════════════ التبديل إلى live ═══════════════════════════════ */

const AI_DOCS = path.join(ROOT, 'scripts/lib/ai-docs.mjs');

/** استبدال مثبت بمرساة: إن لم توجد المرساة يفشل التبديل بدل أن يتخطّى صامتًا. */
function replaceAnchored(file, anchor, replacement) {
  const before = fs.readFileSync(file, 'utf8');
  if (anchor === replacement || (before.includes(replacement) && !before.includes(anchor))) return { changed: false, already: true };
  if (!before.includes(anchor)) throw new Error(`المرساة غير موجودة في ${path.relative(ROOT, file)}: ${anchor.slice(0, 60)}`);
  // دالة الاستبدال تُبطل معنى `$` في البديل — لا مفاجآت من أنماط الاستبدال.
  fs.writeFileSync(file, before.replace(anchor, () => replacement));
  return { changed: true, already: false };
}

/**
 * يقرأ سطر حقل واحد من كتلة MCP_GATEWAY_STATUS.
 * بالقراءة السطرية لا بتعبير نمطي: أبسط، وأدقّ (المرساة هي السطر نفسه)،
 * ولا تقع في الأداء التراجعي الفائق الخطية (S5852) الذي أوقف بوابة الجودة سابقًا.
 */
function statusFieldLine(key) {
  const docs = fs.readFileSync(AI_DOCS, 'utf8');
  const start = docs.indexOf('export const MCP_GATEWAY_STATUS = {');
  if (start < 0) throw new Error('MCP_GATEWAY_STATUS غير موجود في scripts/lib/ai-docs.mjs');
  const end = docs.indexOf('\n};', start);
  const block = docs.slice(start, end < 0 ? docs.length : end);
  const line = block.split('\n').find((entry) => entry.trimStart().startsWith(`${key}:`));
  if (!line) throw new Error(`الحقل ${key} غير موجود داخل MCP_GATEWAY_STATUS — لا تبديل بلا مرساة دقيقة`);
  return { line, indent: line.slice(0, line.length - line.trimStart().length) };
}

/**
 * يكتب الحالة `live` في مصدر الحقيقة الوحيد (MCP_GATEWAY_STATUS)، ويصلح
 * الادّعاءات المكتوبة يدويًا في llms.txt وhumans.txt حتى لا يبقى تناقض
 * بين ما تُعلنه البطاقة وما يقوله النص المكتوب للبشر والنماذج.
 */
/** نص الملاحظة الذي يستبدل ملاحظة «لم تُضَف الأسرار بعد» عند إعلان live. */
const LIVE_NOTE =
  'البوابة منشورة ومتحقَّق منها بمصافحة MCP كاملة (initialize · tools/list · tools/call · resources/read). المسارات المضمونة أدناه تبقى متاحة بلا مصادقة كبديل دائم.';

function writeLiveStatus(evidenceLine) {
  const edited = [];
  const status = statusFieldLine('status');
  const verified = statusFieldLine('verified_at');
  const note = statusFieldLine('note');

  edited.push(['scripts/lib/ai-docs.mjs', replaceAnchored(AI_DOCS, status.line, `${status.indent}status: 'live',`)]);
  edited.push(['scripts/lib/ai-docs.mjs', replaceAnchored(AI_DOCS, verified.line, `${verified.indent}verified_at: '${TODAY}',`)]);
  edited.push(['scripts/lib/ai-docs.mjs', replaceAnchored(AI_DOCS, note.line, `${note.indent}note: '${LIVE_NOTE}',`)]);

  // سطر توثيقي داخل تعليق المصدر نفسه — حتى يبقى دليل التبديل مع الكود.
  const commentAnchor = ' *   node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json\n */';
  edited.push(['scripts/lib/ai-docs.mjs', replaceAnchored(AI_DOCS, commentAnchor, ` *   node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json\n * ${TODAY} (تحديث آلي): ${evidenceLine}\n */`)]);

  const llms = path.join(ROOT, 'llms.txt');
  edited.push(['llms.txt', replaceAnchored(llms, '**فلم يُفعَّل بعد**', '**مُفعَّل ومتحقَّق منه بمصافحة MCP كاملة**')]);
  edited.push(['llms.txt', replaceAnchored(llms, '— **قيد التفعيل**، والحالة في', `— **live (تحقّق ${TODAY})**، والحالة في`)]);

  const humans = path.join(ROOT, 'humans.txt');
  edited.push(['humans.txt', replaceAnchored(humans, '(pending deployment — see availability in /mcp.json)', `(live — verified ${TODAY}, see availability in /mcp.json)`)]);

  return edited.filter(([, result]) => result.changed).map(([file]) => file);
}

/** يعيد توليد طبقة الذكاء ثم يفحص الانحراف ثم يشغّل اختبارات الطبقة. */
function regenerateAndGuard() {
  const results = [];
  const run = (label, args) => {
    try {
      execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe' });
      results.push({ label, ok: true });
    } catch (error) {
      const out = String(error?.stdout ?? '') + String(error?.stderr ?? '');
      results.push({ label, ok: false, detail: out.slice(-1200) });
    }
  };
  run('توليد طبقة الذكاء', ['scripts/build-ai-artifacts.mjs', '--out=.', '--skip=ai-feed.json']);
  run('حرس الانحراف', ['scripts/check-ai-artifacts-in-sync.mjs']);
  run('اختبارات طبقة الذكاء', ['--test', '_worker/tests/ai-artifacts.test.mjs', '_worker/tests/mcp-gateway.test.mjs']);
  return results;
}

async function flip(catalog, options) {
  let evidenceLine = null;
  let facts = null;

  if (options.ciRun) {
    let verified;
    try {
      verified = await verifyCiRun(options.ciRun, catalog);
    } catch (error) {
      // أي عطل في قراءة الدليل = رفض، لا استثناء متطاير: لا يُمَس أي ملف.
      verified = { ok: false, reason: String(error?.message ?? error) };
    }
    if (!verified.ok) {
      console.error(`❌ رفضتُ إعلان live: ${verified.reason}`);
      console.error('   لم يُمَس أي ملف. أصلح السبب ثم أعد المحاولة — لا تكتب live يدويًا.');
      return 2;
    }
    facts = verified.facts;
    const sha = String(verified.run.head_sha).slice(0, 7);
    console.log(`✅ دليل CI مقبول: تشغيل ${options.ciRun} · ${sha} · خطوات النشر والدخان والمصافحة كلها success`);
    evidenceLine = `نُشرت البوابة وتحقّقت المصافحة الكاملة في تشغيل CI رقم ${options.ciRun} على ${sha} — ${formatFacts(facts)}`;
  } else {
    const result = await handshake(catalog);
    const report = buildReport(catalog, result, 'direct handshake');
    printReport(report);
    if (report.verdict !== 'pass') {
      console.error('❌ رفضتُ إعلان live: المصافحة المباشرة لم تنجح.');
      console.error('   إن كانت بيئتك لا تصل إلى workers.dev، فالطريق الوحيد هو CI:');
      console.error('     node _diag/verify-mcp-gateway.mjs --flip --ci-run <run-id>');
      console.error('   لم يُمَس أي ملف.');
      return 2;
    }
    facts = factsFromReport(report);
    evidenceLine = `نُشرت البوابة وتحقّقت المصافحة الكاملة مباشرةً من هذا الجهاز (${report.generated_at}) — ${formatFacts(facts)}`;
  }

  console.log(`   القراءة الحيّة: ${formatFacts(facts)}`);

  const changed = writeLiveStatus(evidenceLine);
  console.log(changed.length ? `✍️  عُدّلت: ${changed.join(' · ')}` : 'ℹ️  الحالة live أصلًا — لا تعديل مطلوب');

  const guard = regenerateAndGuard();
  for (const entry of guard) {
    console.log(`   ${entry.ok ? '✅' : '❌'} ${entry.label}`);
    if (!entry.ok) console.log(entry.detail);
  }
  if (guard.some((entry) => !entry.ok)) {
    console.error('❌ التبديل تمّ لكن الحرس فشل — لا تدفع قبل إصلاح ما سبق.');
    return 1;
  }
  console.log('✅ الحالة live معلَنة ومتحقَّق منها، وطبقة الذكاء متّسقة.');
  console.log('   التالي: فحص الموقع الحيّ بعد نشر Pages (~10 دقائق كاش).');
  return 0;
}

/* ═══════════════════════════════ الإقلاع ═══════════════════════════════ */

function parseArgs(argv) {
  const options = { flip: false, ci: false, ciRun: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--flip') options.flip = true;
    else if (arg === '--ci') options.ci = true;
    else if (arg.startsWith('--ci-run=')) options.ciRun = arg.slice('--ci-run='.length);
    else if (arg === '--ci-run') {
      options.ciRun = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--json=')) options.json = arg.slice('--json='.length);
    else if (arg === '--json') {
      options.json = argv[i + 1] ?? null;
      i += 1;
    } else if (arg !== '--help' && arg !== '-h') console.error(`⚠️  وسيط غير معروف: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readRepoCatalog();
  if (catalog.count !== catalog.index_count) {
    console.error(`⚠️  المستودع نفسه غير متّسق: _properties=${catalog.count} · api/index.json=${catalog.index_count}`);
  }

  if (options.flip) return flip(catalog, options);

  const result = await handshake(catalog);
  const report = buildReport(catalog, result, options.ci ? 'ci handshake' : 'direct handshake');
  printReport(report);
  if (options.json) {
    fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`📄 التقرير: ${options.json}`);
  }
  if (options.ci) writeCiSummary(report);
  return report.verdict === 'pass' ? 0 : 1;
}

process.exitCode = await main();
