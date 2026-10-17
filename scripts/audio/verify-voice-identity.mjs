#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/audio/verify-voice-identity.mjs — بوابة الهوية الصوتية
 * ───────────────────────────────────────────────────────────────────
 *  هذا هو الجزء الذي يُصلح مسار الإنتاج نفسه بدل معالجة الأعراض.
 *  يعمل على المصدر فقط: بلا بناء Jekyll وبلا أي حزمة خارجية، فيصلح لـ CI.
 *
 *  تُسقط (exit 1) في الحالات:
 *   1. تغيّر المرجع الذي اختاره المالك — بصمة SHA-256 أو حجم أو ترميز أو وسوم.
 *   2. أي ملف MP3 تحت assets/audio/** بلا سطر في _data/audio_voice_log.json
 *      (إعلان أُنتج خارج مسار الإنتاج الموحّد).
 *   3. أي استبدال صامت لملف مسجَّل — بصمة لا تطابق السجل.
 *   4. أي تغيير في encoding/id3/engine داخل المواصفة بلا قيد specChanges موثَّق.
 *   5. أي صفحة audio_ad: true بملف ناقص، أو وسوم غير مطابقة، أو تسمية مدة
 *      لا تساوي ceil(المدة المقاسة)، أو مدة تتجاوز السقف.
 *   6. أي إعلان origin=produced-under-spec يخالف قواعد النص/المدة/الموافقة
 *      أو سياسة identityBand.policy.
 *
 *  الفحص الفني نفسه مُعاد الاستخدام من مسار الإنتاج (verifyFile) — مصدر
 *  واحد للحقيقة، لا نسختان قد تختلفان.
 *
 *  الاستخدام:
 *    node scripts/audio/verify-voice-identity.mjs           # فحص كامل
 *    node scripts/audio/verify-voice-identity.mjs --quiet   # أخطاء فقط
 *    SPEC_CHANGE_REASON="…" SPEC_CHANGE_APPROVED_BY="…" \
 *      node scripts/audio/verify-voice-identity.mjs --init  # توثيق تغيير مقصود
 * ═══════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFrontMatter } from '../lib/front-matter.mjs';
import { SPEC, verifyFile, checkScript, loadProperty } from './produce-audio-ad.mjs';
import { specFingerprint } from './spec-fingerprint.mjs';

/**
 * جذر المستودع يُشتق من موقع هذا الملف لا من cwd — حتى تتطابق قراءته تمامًا مع
 * scripts/audio/produce-audio-ad.mjs الذي يستورده (وإلا قرأ أحدهما مواصفة
 * المستودع الحقيقي والآخر مواصفة مجلد التشغيل)، وحتى تعمل الاختبارات على نسخة
 * مصغّرة من المستودع بلا التباس.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPEC_PATH = path.join(ROOT, '_data', 'voice_identity.json');
const LOG_PATH = path.join(ROOT, '_data', 'audio_voice_log.json');

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const errors = [];
const warnings = new Set();
const fail = (m) => errors.push(m);
const warn = (m) => warnings.add(m);
const note = (m) => { if (!quiet) console.log(`ℹ️  ${m}`); };

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function mp3s(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...mp3s(p));
    else if (e.name.toLowerCase().endsWith('.mp3')) found.push(p);
  }
  return found;
}

// ---------------------------------------------------------------- السجل
let LOG = null;
if (!fs.existsSync(LOG_PATH)) fail(`${path.relative(ROOT, LOG_PATH)} غير موجود — سجل الإنتاج الملزم مفقود.`);
else {
  try { LOG = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch (err) { fail(`السجل ليس JSON صالحًا: ${err.message}`); }
}
const ENTRIES = LOG && Array.isArray(LOG.entries) ? LOG.entries : [];

// ------------------------------------------- بصمة إعدادات الصوت (تغيير موثَّق)
function initFingerprint() {
  if (!LOG) { console.error('❌ لا يوجد سجل لتهيئته'); process.exit(1); }
  const current = specFingerprint(SPEC);
  if (LOG.specFingerprint === current) { console.log(`البصمة محدَّثة بالفعل: ${current}`); process.exit(0); }
  const reason = process.env.SPEC_CHANGE_REASON || '';
  const approvedBy = process.env.SPEC_CHANGE_APPROVED_BY || '';
  LOG.specChanges = LOG.specChanges || [];
  LOG.specChanges.push({
    changedAt: SPEC.updatedAt || new Date().toISOString().slice(0, 10),
    previousFingerprint: LOG.specFingerprint || null,
    newFingerprint: current,
    reason: reason || 'غير موثَّق — أعد التشغيل مع SPEC_CHANGE_REASON',
    approvedBy: approvedBy || 'غير موثَّق — أعد التشغيل مع SPEC_CHANGE_APPROVED_BY',
  });
  LOG.specFingerprint = current;
  fs.writeFileSync(LOG_PATH, `${JSON.stringify(LOG, null, 2)}\n`, 'utf8');
  console.log(`✅ حُدِّثت البصمة إلى ${current} وأُضيف قيد في specChanges.`);
  if (!reason || !approvedBy) console.error('❌ السبب والموافقة غير موثَّقين — أعد التشغيل بالمتغيرين.');
  process.exit(reason && approvedBy ? 0 : 1);
}
if (argv.includes('--init')) initFingerprint();

// ---------------------------------------- 1) المرجع الذي اختاره المالك
function checkReference() {
  const ref = SPEC.reference;
  const abs = path.join(ROOT, ref.repoPath);
  if (!fs.existsSync(abs)) { fail(`ملف المرجع الذي اختاره المالك مفقود: ${ref.repoPath}`); return; }

  const got = sha256File(abs);
  if (got !== ref.sha256) {
    fail(`بصمة المرجع تغيّرت!\n   ${ref.repoPath}\n   المتوقع: ${ref.sha256}\n   الفعلي: ${got}\n   المرجع اختاره المالك ولا يُستبدل. أي تبديل مقصود يحتاج تحديث ${path.relative(ROOT, SPEC_PATH)} وقيدًا في specChanges.`);
  } else note(`المرجع سليم: ${path.basename(ref.repoPath)} · ${ref.sha256.slice(0, 16)}…`);

  const size = fs.statSync(abs).size;
  if (ref.bytes && size !== ref.bytes) fail(`حجم المرجع ${size} بايت ≠ ${ref.bytes}`);

  const v = verifyFile(abs, ref.script);
  for (const p of v.problems) fail(`المرجع: ${p}`);
  if (v.durationSeconds !== null && Math.abs(v.durationSeconds - ref.durationSeconds) > 0.01) {
    fail(`مدة المرجع ${v.durationSeconds.toFixed(3)} ث ≠ ${ref.durationSeconds} ث`);
  }
  const measured = ref.measured || {};
  for (const key of ['peakDbfs', 'rmsDbfs', 'clippedSamples']) {
    if (typeof measured[key] === 'number' && key === 'clippedSamples' && measured[key] !== 0) {
      fail(`المرجع فيه ${measured[key]} عيّنة مقصوصة`);
    }
  }
}

// ---------------------------------------- 2) صفحات audio_ad: true
function pagesByAudioFile() {
  const map = new Map();
  for (const coll of ['_properties', '_requests']) {
    const dir = path.join(ROOT, coll);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      const parsed = parseFrontMatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!parsed.hasFrontMatter) continue;
      const d = parsed.data;
      if (d.audio_ad !== true || !d.audio_file) continue;
      const key = String(d.audio_file).replace(/^\//, '');
      if (map.has(key)) fail(`صفحتان تشيران إلى نفس الملف الصوتي: ${key} (${map.get(key).rel} و ${coll}/${f})`);
      map.set(key, { rel: `${coll}/${f}`, slug: d.slug, duration: d.audio_duration, script: d.audio_script });
    }
  }
  return map;
}

// ---------------------------------------- 3) قواعد الإعلان الجديد
function checkNewAd(entry, rel, v, page) {
  const property = entry.propertySource ? loadProperty(entry.propertySource) : null;
  const script = String(entry.script || (page && page.script) || '');
  if (!script) { fail(`${rel}: لا يوجد نص موثَّق في السجل`); return; }

  // نفس فاحص النص المستخدم في مسار الإنتاج — لا نسخة ثانية
  const result = checkScript(script, property);
  for (const e of result.errors) fail(`${rel}: ${e}`);
  for (const w of result.warnings) warn(`${rel}: ${w}`);

  if (!v || v.durationSeconds === null) return;
  const dur = v.durationSeconds;
  const target = SPEC.encoding.targetDurationSeconds || {};
  const lo = target.min ?? 18;
  const hi = target.max ?? 29;
  if (dur < lo || dur > hi) fail(`${rel}: المدة ${dur.toFixed(2)} ث خارج النطاق المستهدف ${lo}–${hi} ث`);
  if (page && String(page.duration) !== `${Math.ceil(dur - 1e-9)} ثانية`) {
    fail(`${rel}: audio_duration «${page.duration}» والمطلوب «${Math.ceil(dur - 1e-9)} ثانية»`);
  }

  if (!entry.voiceId || !entry.voiceIdScope) fail(`${rel}: إعلان جديد بلا توثيق معرّف الصوت ونطاقه`);
  if (entry.voiceIdPersistent === true) {
    fail(`${rel}: السجل يدّعي معرّف صوت دائمًا والمحرك لا يوفّره (engine.persistentVoiceId=false)`);
  }
  if (!entry.approval) fail(`${rel}: إعلان جديد بلا توثيق معاينة/موافقة المالك (approval)`);

  const band = SPEC.identityBand.thresholds;
  const c = entry.speakerCosineToReference;
  if (typeof c !== 'number') { fail(`${rel}: إعلان جديد بلا قياس بصمة المتكلم`); return; }
  if (c >= band.identicalVoice) return;                                   // يُنشر تلقائيًا
  if (c < band.unacceptable) { fail(`${rel}: بصمة المتكلم ${c} تحت الحد المرفوض ${band.unacceptable}`); return; }
  if (c < band.borderlineNeedsOwnerApproval) {                            // يحتاج تجاوزًا صريحًا
    if (entry.ownerOverride !== true) fail(`${rel}: بصمة ${c} تحت حد «نفس الصوت» ${band.borderlineNeedsOwnerApproval} وتتطلب ownerOverride=true`);
    if (!entry.ownerOverrideReason) fail(`${rel}: ownerOverride بلا ownerOverrideReason موثَّق`);
  } else if (!entry.approval) {                                           // النطاق الحرج
    fail(`${rel}: بصمة ${c} في النطاق الحرج (${band.borderlineNeedsOwnerApproval}–${band.identicalVoice}) وتتطلب موافقة صريحة من المالك`);
  }
}

// ---------------------------------------- 4) السجل = قيد إلزامي لكل ملف
function checkRegistry() {
  const files = mp3s(path.join(ROOT, 'assets', 'audio'))
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
  const byFile = new Map(ENTRIES.map((e) => [e.audioFile, e]));
  const pages = pagesByAudioFile();

  for (const e of ENTRIES) {
    if (!files.includes(e.audioFile)) fail(`سطر في السجل بلا ملف على القرص: ${e.audioFile}`);
    const required = ['slug', 'audioFile', 'origin', 'sha256', 'bytes', 'durationSeconds'];
    for (const k of required) {
      if (e[k] === undefined || e[k] === null) fail(`السطر ${e.slug || e.audioFile} يفتقد الحقل ${k}`);
    }
  }

  for (const f of files) {
    const entry = byFile.get(f);
    if (!entry) {
      fail(`ملف صوتي بلا سطر في ${path.relative(ROOT, LOG_PATH)}: ${f}\n   كل إعلان يجب أن يُنتَج عبر مسار الإنتاج الموحّد ويُقيَّد في السجل.`);
      continue;
    }
    const abs = path.join(ROOT, f);
    const got = sha256File(abs);
    if (entry.sha256 && got !== entry.sha256) {
      fail(`بصمة ${f} لا تطابق السجل (استبدال صامت؟)\n   السجل: ${entry.sha256}\n   الفعلي: ${got}`);
    }
    const size = fs.statSync(abs).size;
    if (entry.bytes && size !== entry.bytes) fail(`${f}: الحجم ${size} ≠ ${entry.bytes} في السجل`);

    const page = pages.get(f) || null;
    if (!page && !entry.legacyNote) fail(`${f} غير مرتبط بأي صفحة audio_ad: true وليس موثَّقًا بـ legacyNote`);

    const v = verifyFile(abs, page ? String(page.script) : null);
    for (const p of v.problems) fail(`${f}: ${p}`);
    if (v.durationSeconds !== null && Math.abs(v.durationSeconds - entry.durationSeconds) > 0.01) {
      fail(`${f}: المدة ${v.durationSeconds.toFixed(3)} ث ≠ ${entry.durationSeconds} ث في السجل`);
    }
    if (entry.origin === 'produced-under-spec') checkNewAd(entry, f, v, page);
    else if (entry.classification === 'cannot-assess') warn(`${f}: مُصنَّف «تعذّر التقييم»`);
  }

  for (const [f, page] of pages) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { fail(`${page.rel}: audio_file يشير إلى ملف غير موجود: /${f}`); continue; }
    if (!byFile.has(f)) fail(`${page.rel}: الملف /${f} غير مسجَّل في ${path.relative(ROOT, LOG_PATH)}`);
    const v = verifyFile(abs, null);
    if (v.durationSeconds === null) continue;
    const want = `${Math.ceil(v.durationSeconds - 1e-9)} ثانية`;
    if (String(page.duration) !== want) {
      fail(`${page.rel}: audio_duration «${page.duration}» والمطلوب «${want}» (قيس ${v.durationSeconds.toFixed(3)} ث)`);
    }
    if (!page.script || String(page.script).length < 80) fail(`${page.rel}: audio_script ناقص أو قصير جدًا`);
    if (page.slug && f !== `assets/audio/properties/${page.slug}.mp3`) {
      warn(`${page.rel}: مسار الصوت لا يتبع نمط /assets/audio/properties/<slug>.mp3`);
    }
  }
  note(`السجل: ${ENTRIES.length} سطر · ملفات على القرص: ${files.length} · صفحات audio_ad: ${pages.size}`);
}

// ---------------------------------------- 5) ملخّص التصنيف
function reportClassification() {
  const totals = {};
  for (const e of ENTRIES) totals[e.classification] = (totals[e.classification] || 0) + 1;
  const order = ['reference', 'compatible-with-reference', 'possible-deviation-review', 'clear-difference', 'cannot-assess'];
  note(`التصنيف المقاس: ${order.filter((k) => totals[k]).map((k) => `${k}=${totals[k]}`).join(' · ')}`);
  const stale = (LOG && LOG.totals && LOG.totals.audioFiles) !== ENTRIES.length;
  if (stale) fail(`totals.audioFiles في السجل (${LOG?.totals?.audioFiles}) ≠ عدد الأسطر (${ENTRIES.length})`);

  // شفافية: الانحرافات الموروثة الموثَّقة التي لا تُصلَح (لأن إصلاحها يبدّل بصمة ملف ناجح)
  const legacyComm = ENTRIES.filter((e) => e.technical && e.technical.commDescription === '').length;
  const orphaned = ENTRIES.filter((e) => !e.linkedToPublishedPage).length;
  const overridden = ENTRIES.filter((e) => e.ownerOverride === true).length;
  if (legacyComm) note(`انحراف موروث موثَّق: ${legacyComm} ملفًا بـ COMM بلا وصف «${SPEC.id3.comm.description}» — لا يُصلَح`);
  if (orphaned) note(`أصول متقاعدة موثَّقة: ${orphaned} ملفًا غير مرتبط بصفحة منشورة`);
  if (overridden) note(`تجاوزات موافقة المالك الموثَّقة: ${overridden}`);
}

checkReference();
if (!LOG || !LOG.specFingerprint) {
  fail(`السجل لا يحمل specFingerprint — شغّل: node scripts/audio/verify-voice-identity.mjs --init`);
} else {
  const current = specFingerprint(SPEC);
  if (LOG.specFingerprint === current) note(`إعدادات الصوت مطابقة للسجل · ${current.slice(0, 16)}…`);
  else {
    const ok = (LOG.specChanges || []).some((c) => c.newFingerprint === current && c.reason && c.approvedBy
      && !/غير موثَّق/.test(String(c.reason)) && !/غير موثَّق/.test(String(c.approvedBy)));
    if (!ok) fail(`إعدادات الصوت (encoding/id3/engine) تغيّرت في ${path.relative(ROOT, SPEC_PATH)} بلا قيد موثَّق.\n   بصمة السجل: ${LOG.specFingerprint}\n   بصمة الملف: ${current}\n   وثِّق السبب والموافقة ثم شغّل --init، أو أرجِع الإعدادات.`);
    else note('تغيير الإعدادات موثَّق في specChanges ✓');
  }
}
checkRegistry();
reportClassification();

if (errors.length) {
  console.error(`\n❌ بوابة الهوية الصوتية: ${errors.length} مخالفة`);
  errors.forEach((e, i) => console.error(`\n[${i + 1}] ${e}`));
  process.exit(1);
}
if (!quiet) {
  console.log('\n✅ بوابة الهوية الصوتية: كل الفحوص الملزمة نجحت');
  console.log(`   المرجع: ${SPEC.reference.repoPath}`);
  console.log(`   السجل: ${ENTRIES.length} ملفًا مقيدًا · تنبيهات موروثَة موثَّقة: ${warnings.size}`);
}
process.exit(0);
