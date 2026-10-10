#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   إرسال إشعارات Web Push عند إضافة عقار/طلب جديد — 2026-10-10
   ─────────────────────────────────────────────────────────────
   يعمل داخل GitHub Actions بدون أي اعتماديات npm (مشغّل خفيف).
   يكتشف الملفات المُضافة فقط (ليست المعدّلة أو المحذوفة)، يقرأ
   بياناتها العامة فقط، ثم يطلب من Cloudflare Worker الإرسال.

   الحماية:
   • بيانات عامة فقط: العنوان/السعر/الموقع/الرابط — لا هواتف أو أسماء.
   • idempotency عبر commit SHA + مسار الملف (الـWorker يمنع التكرار).
   • الإرسال التجريبي يتطلب معرّف جهاز واحد — لا إرسال جماعي تجريبي.
   • فشل الإرسال يفشل الـWorkflow (exit 1) وليس نجاحًا ظاهريًا.
   ═══════════════════════════════════════════════════════════════ */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_URL = process.env.PUSH_WORKER_URL || 'https://royal-snow-ea32.footcai-555.workers.dev';
const SITE_URL = 'https://nasr-realestate.github.io';
const SEND_PATH = '/push/send';
const MAX_FILES_PER_RUN = 20;

const eventName = process.env.GITHUB_EVENT_NAME || '';
const eventPath = process.env.GITHUB_EVENT_PATH || '';
const sha = process.env.GITHUB_SHA || '';
const runId = process.env.GITHUB_RUN_ID || '0';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
const token = (process.env.PUSH_SEND_TOKEN || '').trim();

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (!token) fail('PUSH_SEND_TOKEN غير متاح — تحقق من إعدادات المستودع (الأسرار).');
if (!sha) fail('GITHUB_SHA غير متاح.');

let event = {};
if (eventPath && existsSync(eventPath)) {
  try { event = JSON.parse(readFileSync(eventPath, 'utf8')); } catch { /* ignore */ }
}

const isDispatch = eventName === 'workflow_dispatch';
const mode = isDispatch ? String(event.inputs?.mode || 'none') : 'push';
const targetInput = isDispatch ? String(event.inputs?.target || '').trim() : '';
const fileInput = isDispatch ? String(event.inputs?.file_path || '').trim() : '';

// ─── قراءة Front Matter بسيطة (حقول مسموحة فقط) ───
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!m) return data;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*"?([^"]*)"?\s*$/.exec(line.trim());
    if (kv) data[kv[1]] = kv[2].replace(/\\/g, '').trim();
  }
  return data;
}

function payloadFromFile(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`الملف غير موجود: ${filePath}`);
  const data = parseFrontMatter(readFileSync(abs, 'utf8'));
  const isRequest = filePath.replace(/\\/g, '/').startsWith('_requests/');
  const kind = isRequest ? 'request' : 'property';
  const slug = String(data.slug || '').trim();
  if (!slug) throw new Error(`الملف بلا slug: ${filePath}`);
  const folder = isRequest ? 'requests' : 'properties';
  return {
    kind,
    title: String(data.title || (isRequest ? 'طلب جديد' : 'عقار جديد')),
    price: String(data.price || ''),
    budget: String(data.budget || ''),
    location: String(data.location || ''),
    url: `${SITE_URL}/${folder}/${slug}/`,
    filePath: filePath.replace(/\\/g, '/'),
  };
}

// ─── اكتشاف الملفات المُضافة فقط عند الدفع ───
function addedFiles() {
  const before = String(event.before || '');
  let range = null;
  if (/^[0-9a-f]{40}$/.test(before) && !/^0{40}$/.test(before)) {
    try {
      execFileSync('git', ['cat-file', '-e', before], { stdio: 'ignore' });
      range = `${before}..${sha}`;
    } catch { /* fallback below */ }
  }
  if (!range) {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^`], { stdio: 'ignore' });
      range = `${sha}^..${sha}`;
    } catch {
      console.log('⚠️ لا يوجد commit سابق للمقارنة — لا إرسال.');
      return [];
    }
  }
  const out = execFileSync(
    'git', ['diff', '--name-only', '--diff-filter=A', range, '--', '_properties/', '_requests/'],
    { encoding: 'utf8' }
  );
  return out.split('\n').map(s => s.trim())
    .filter(f => /^_(properties|requests)\/.+\.md$/.test(f));
}

// ─── الإرسال إلى الـWorker (فشله يفشل الـWorkflow) ───
async function sendOne(payload, { test, target, idemKey }) {
  const body = {
    kind: payload.kind,
    title: payload.title,
    price: payload.price || payload.budget || '',
    location: payload.location || '',
    url: payload.url,
    filePath: payload.filePath,
    commitSha: sha,
    test: Boolean(test),
    idempotencyKey: idemKey,
  };
  if (target) body.target = target;
  const res = await fetch(WORKER_URL + SEND_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,   // لا يُطبع أبدًا
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

function report(label, r) {
  const j = r.json || {};
  if (r.status === 200 && j.ok) {
    if (j.deduped) {
      console.log(`⏭ ${label} — مُرسَل سابقًا (idempotent) · لا تكرار.`);
    } else {
      console.log(`✅ ${label} · attempted=${j.attempted ?? 0} success=${j.success ?? 0} failed=${j.failed ?? 0} removed=${j.removed ?? 0}${j.note ? ' · ' + j.note : ''}`);
    }
    return true;
  }
  console.error(`❌ ${label} · HTTP ${r.status} · ${JSON.stringify(j)}`);
  return false;
}

async function main() {
  if (isDispatch && mode === 'none') {
    console.log('ℹ️ تشغيل يدوي بدون وضع الإرسال — لا إشعار يُرسل (الحماية من التكرار والإرسال العرضي).');
    return;
  }

  // ── الإرسال التجريبي: جهاز واحد فقط ──
  if (isDispatch && mode === 'test-single') {
    if (!/^[0-9a-f]{12,64}$/.test(targetInput)) {
      fail('وضع الاختبار يتطلب معرّف اشتراك جهاز واحد (target) — من صفحة /notifications.html.');
    }
    let payload;
    if (fileInput) {
      payload = payloadFromFile(fileInput);
    } else {
      payload = {
        kind: 'property',
        title: 'رسالة اختبارية من سمسار طلبك',
        price: '',
        location: 'مدينة نصر',
        url: `${SITE_URL}/properties/`,
        filePath: '_properties/test-notification.md',
      };
    }
    const idemKey = `${sha}:${payload.filePath}#test-${runId}-${runAttempt}`;
    console.log(`🧪 إرسال تجريبي إلى جهاز واحد (${targetInput.slice(0, 8)}…) — لا يشمل باقي المشتركين.`);
    const r = await sendOne(payload, { test: true, target: targetInput, idemKey });
    if (!report('test-single', r)) fail('فشل الإرسال التجريبي.');
    return;
  }

  // ── الدفع: ملفات جديدة فقط ──
  const files = addedFiles();
  if (!files.length) {
    console.log('ℹ️ لا توجد ملفات جديدة مُضافة في _properties/ أو _requests/ — لا إشعار (التعديلات والحذف لا تُرسل).');
    return;
  }
  const batch = files.slice(0, MAX_FILES_PER_RUN);
  if (files.length > MAX_FILES_PER_RUN) {
    console.log(`⚠️ ${files.length} ملفًا جديدًا — تُرسل أول ${MAX_FILES_PER_RUN} فقط في هذا التشغيل.`);
  }

  let okCount = 0;
  const failures = [];
  for (const file of batch) {
    let payload;
    try {
      payload = payloadFromFile(file);
    } catch (err) {
      failures.push(`${file}: ${err.message}`);
      continue;
    }
    const idemKey = `${sha}:${payload.filePath}`;
    const r = await sendOne(payload, { test: false, idemKey });
    if (report(file, r)) okCount += 1;
    else failures.push(file);
  }

  console.log(`📊 الملخص: ${okCount}/${batch.length} ملفًا أُرسلت بنجاح · فشل ${failures.length}.`);
  if (failures.length) fail(`فشل إرسال الإشعارات لملفات: ${failures.join(', ')}`);
}

main().catch(err => fail(err?.message || String(err)));
