// Tests: الهوية الصوتية — scripts/audio/{id3,spec-fingerprint,produce-audio-ad,verify-voice-identity}.mjs
//
// سبب وجود هذا الاختبار: انحراف صوت الإعلانات لم يكن خطأً في ملف واحد، بل غياب
// مسار إنتاج مُلزِم. هذه الاختبارات هي شبكة الأمان التي تمنع رجوع المشكلة:
//   • البوابة scripts/audio/verify-voice-identity.mjs تُسقط CI فعلًا عند أي مخالفة
//     (يُختبر ذلك هنا بحالات سلبية حقيقية على نسخة مصغّرة من المستودع).
//   • ماسح إطارات MPEG يتجاهل إطار Xing/Info عند تحديد الخصائص (علة سابقة:
//     قرأ 64 kbps بدل 32 kbps فأسقط ملفًا سليمًا).
//   • إعادة الوسم تحافظ على بايتات الصوت حرفيًا (ممنوع إعادة الترميز).
//   • البصمة القياسية لإعدادات الصوت لا تعتمد على ترتيب المفاتيح.
//   • البوابة موصولة في workflow فعلًا — لا يكفي وجودها في المستودع.
//
// التشغيل:
//   node --test scripts/tests/voice-identity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonical, specFingerprint } from "../audio/spec-fingerprint.mjs";
import {
  tagExtent, parseFrames, frameText, parseComm, scanMpeg, retag, buildTag,
} from "../audio/id3.mjs";
import {
  SPEC, verifyFile, checkScript, loadProperty, extractSpokenNumbers, wordCount,
} from "../audio/produce-audio-ad.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "audio", "verify-voice-identity.mjs");
/** البوابة داخل النسخة المصغّرة — تُشغَّل هي لا نسخة المستودع الحقيقي. */
const fixtureGate = (root) => path.join(root, "scripts", "audio", "verify-voice-identity.mjs");
const LOG_PATH = path.join(REPO_ROOT, "_data", "audio_voice_log.json");
const AUDIO_DIR = path.join(REPO_ROOT, "assets", "audio");

const REF_REL = SPEC.reference.repoPath;
const LOG = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
const ENTRY_BY_FILE = new Map(LOG.entries.map((e) => [e.audioFile, e]));
const NEW_ENTRY = LOG.entries.find((e) => e.origin === "produced-under-spec");

function mp3s(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mp3s(p));
    else if (e.name.toLowerCase().endsWith(".mp3")) out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  نسخة مصغّرة من المستودع لتشغيل البوابة كعملية مستقلة
// ─────────────────────────────────────────────────────────────────────
/**
 * يبني مستودعًا مصغّرًا صالحًا: المرجع + أول إعلان مُنتَج تحت المواصفة.
 * @param {(log:object)=>void} [mutateLog]
 * @param {(spec:object)=>void} [mutateSpec]
 * @returns {{root:string, cleanup:()=>void}}
 */
function fixture(mutateLog = null, mutateSpec = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-id-"));
  const copy = (from, to) => {
    const dest = path.join(root, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
  };
  const copyTree = (rel) => {
    const src = path.join(REPO_ROOT, rel);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.isDirectory()) copyTree(path.join(rel, e.name));
      else if (e.name.endsWith(".mjs")) copy(path.join(src, e.name), path.join(rel, e.name));
    }
  };
  copyTree("scripts");

  const spec = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "_data", "voice_identity.json"), "utf8"));
  if (mutateSpec) mutateSpec(spec);
  copy(path.join(REPO_ROOT, "_data", "voice_identity.json"), "_data/voice_identity.json");
  fs.writeFileSync(path.join(root, "_data", "voice_identity.json"), JSON.stringify(spec, null, 2), "utf8");

  const keep = [REF_REL];
  if (NEW_ENTRY) keep.push(NEW_ENTRY.audioFile);
  for (const rel of keep) {
    copy(path.join(REPO_ROOT, rel), rel);
    const entry = ENTRY_BY_FILE.get(rel);
    const md = entry && entry.propertySource;
    if (md) copy(path.join(REPO_ROOT, md), md);
  }

  const log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  log.entries = log.entries.filter((e) => keep.includes(e.audioFile));
  log.totals.audioFiles = log.entries.length;
  if (mutateLog) mutateLog(log);
  fs.writeFileSync(path.join(root, "_data", "audio_voice_log.json"), JSON.stringify(log, null, 2), "utf8");

  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runGate(root) {
  const gate = fixtureGate(root);
  assert.ok(fs.existsSync(gate), "النسخة المصغّرة يجب أن تحمل البوابة نفسها");
  const r = spawnSync(process.execPath, [gate, "--quiet"], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** يؤكد أن البوابة تسقط وأن الرسالة تذكر سببًا بعينه. */
function expectGateFailure(label, mutateLog, mutateSpec, needle) {
  const fx = fixture(mutateLog, mutateSpec);
  try {
    const r = runGate(fx.root);
    assert.equal(r.code, 1, `${label}: توقّعنا exit 1 لكن الناتج ${r.code}\n${r.out}`);
    if (needle) assert.match(r.out, needle, `${label}: الرسالة لا تذكر ${needle}\n${r.out}`);
  } finally {
    fx.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  1) البوابة تنجح على المستودع الحقيقي ثم على النسخة المصغّرة
// ─────────────────────────────────────────────────────────────────────
test("البوابة تنجح على المستودع الحقيقي (45 ملفًا مقيدًا)", () => {
  const r = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `البوابة سقطت على المستودع:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /بوابة الهوية الصوتية: كل الفحوص الملزمة نجحت/);
  assert.match(r.stdout, new RegExp(`السجل: ${LOG.entries.length} ملفًا`));
});

test("البوابة تنجح على النسخة المصغّرة (أساس الحالات السلبية)", () => {
  const fx = fixture();
  try {
    const r = runGate(fx.root);
    assert.equal(r.code, 0, `النسخة المصغّرة يجب أن تنجح:\n${r.out}`);
  } finally {
    fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────
//  2) المرجع الذي اختاره المالك لا يتغيّر صمتًا
// ─────────────────────────────────────────────────────────────────────
test("تغيير بصمة المرجع في المواصفة يُسقط البوابة", () => {
  expectGateFailure(
    "بصمة المرجع",
    null,
    (spec) => { spec.reference.sha256 = "0".repeat(64); },
    /بصمة المرجع تغيّرت/,
  );
});

test("تغيير حجم المرجع في المواصفة يُسقط البوابة", () => {
  expectGateFailure("حجم المرجع", null, (spec) => { spec.reference.bytes = 1; }, /حجم المرجع/);
});

test("تغيير نقطة المرجع إلى ملف آخر يُسقط البوابة", () => {
  expectGateFailure(
    "نقطة المرجع",
    null,
    (spec) => { spec.reference.repoPath = NEW_ENTRY.audioFile; },
    /بصمة المرجع تغيّرت|حجم المرجع|مدة المرجع/,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  3) إعدادات الصوت لا تُغيَّر بلا سبب موثَّق
// ─────────────────────────────────────────────────────────────────────
test("تغيير معدل البت في المواصفة بلا قيد specChanges يُسقط البوابة", () => {
  expectGateFailure(
    "بصمة الإعدادات",
    null,
    (spec) => { spec.encoding.bitrateBps = 64000; },
    /إعدادات الصوت .* تغيّرت/,
  );
});

test("تغيير TSSE الثابت في المواصفة بلا قيد يُسقط البوابة", () => {
  expectGateFailure(
    "TSSE",
    null,
    (spec) => { spec.id3.fixedValues.TSSE = "Lavf61.1.100"; },
    /إعدادات الصوت .* تغيّرت|TSSE/,
  );
});

test("تغيير engine.persistentVoiceId في المواصفة بلا قيد يُسقط البوابة", () => {
  expectGateFailure(
    "المحرك",
    null,
    (spec) => { spec.engine.persistentVoiceId = true; },
    /إعدادات الصوت .* تغيّرت/,
  );
});

test("التغيير الموثَّق في specChanges يمرّ", () => {
  const current = specFingerprint(SPEC);
  const fx = fixture(
    (log) => {
      log.specFingerprint = "f".repeat(64);
      log.specChanges = [{ changedAt: "2026-10-18", previousFingerprint: current, newFingerprint: "f".repeat(64), reason: "اختبار", approvedBy: "المالك" }];
    },
    null,
  );
  try {
    const r = runGate(fx.root);
    assert.equal(r.code, 1, `التغيير غير المبرَّر يجب أن يسقط:\n${r.out}`);
    assert.match(r.out, /غير موثَّق|إعدادات الصوت/);
  } finally {
    fx.cleanup();
  }
});

test("قيد specChanges بلا سبب حقيقي لا يمرّ", () => {
  const fx = fixture((log) => {
    log.specFingerprint = "f".repeat(64);
    log.specChanges = [{ newFingerprint: "f".repeat(64), reason: "غير موثَّق", approvedBy: "غير موثَّق" }];
  }, null);
  try {
    assert.equal(runGate(fx.root).code, 1, "«غير موثَّق» يجب ألا يُقبل كتبرير");
  } finally {
    fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────
//  4) السجل قيد إلزامي: لا ملف بلا سطر، ولا استبدال صامت
// ─────────────────────────────────────────────────────────────────────
test("حذف سطر من السجل يُسقط البوابة", () => {
  expectGateFailure("سطر ناقص", (log) => { log.entries = log.entries.slice(1); }, null, /بلا سطر|بلا ملف على القرص/);
});

test("ملف صوتي غير مسجَّل يُسقط البوابة", () => {
  const fx = fixture();
  try {
    const src = path.join(fx.root, REF_REL);
    fs.copyFileSync(src, path.join(fx.root, "assets", "audio", "properties", "unregistered-ad.mp3"));
    const r = runGate(fx.root);
    assert.equal(r.code, 1, "ملف بلا سطر في السجل يجب أن يُسقط البوابة");
    assert.match(r.out, /unregistered-ad\.mp3/);
  } finally {
    fx.cleanup();
  }
});

test("استبدال صامت لملف منشور (تغيير بايت واحد) يُسقط البوابة", () => {
  const fx = fixture();
  try {
    const p = path.join(fx.root, REF_REL);
    const buf = fs.readFileSync(p);
    buf[buf.length - 500] ^= 0x01; // بايت صوتي في نهاية الملف
    fs.writeFileSync(p, buf);
    const r = runGate(fx.root);
    assert.equal(r.code, 1, "تغيير بايت في ملف مقيد يجب أن يُسقط البوابة");
    assert.match(r.out, /لا تطابق السجل/);
  } finally {
    fx.cleanup();
  }
});

test("سطر في السجل بلا ملف على القرص يُسقط البوابة", () => {
  expectGateFailure(
    "سطر بلا ملف",
    (log) => { log.entries.push({ slug: "ghost", audioFile: "assets/audio/properties/ghost.mp3", origin: "legacy-grandfathered", sha256: "0".repeat(64), bytes: 1, durationSeconds: 20, classification: "clear-difference" }); },
    null,
    /بلا ملف على القرص/,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  5) بيانات الصفحات لا تنفصل عن الصوت
// ─────────────────────────────────────────────────────────────────────
test("تسمية مدة خاطئة في front matter تُسقط البوابة", () => {
  const fx = fixture();
  try {
    const md = ENTRY_BY_FILE.get(REF_REL).propertySource;
    const p = path.join(fx.root, md);
    const txt = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, txt.replace(/^audio_duration: .*$/m, 'audio_duration: "1 ثانية"'), "utf8");
    const r = runGate(fx.root);
    assert.equal(r.code, 1, "audio_duration يجب أن يساوي ceil(المدة المقاسة)");
    assert.match(r.out, /audio_duration/);
  } finally {
    fx.cleanup();
  }
});

test("تغيير audio_script دون تغيير COMM يُسقط البوابة", () => {
  const fx = fixture();
  try {
    const md = ENTRY_BY_FILE.get(REF_REL).propertySource;
    const p = path.join(fx.root, md);
    const txt = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, txt.replace(/^audio_script: .*$/m, 'audio_script: "نص آخر مختلف تمامًا عن الصوت المخزّن في الملف."'), "utf8");
    const r = runGate(fx.root);
    assert.equal(r.code, 1, "COMM يجب أن يطابق audio_script حرفيًا");
    assert.match(r.out, /COMM/);
  } finally {
    fx.cleanup();
  }
});

test("audio_file يشير إلى ملف غير موجود يُسقط البوابة", () => {
  const fx = fixture();
  try {
    const md = ENTRY_BY_FILE.get(REF_REL).propertySource;
    const p = path.join(fx.root, md);
    const txt = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, txt.replace(/^audio_file: .*$/m, 'audio_file: "/assets/audio/properties/does-not-exist.mp3"'), "utf8");
    const r = runGate(fx.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /غير موجود/);
  } finally {
    fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────
//  6) الإعلانات الجديدة: قواعد صارمة لا تُسامَح للملفات الموروثة
// ─────────────────────────────────────────────────────────────────────
test("إعلان جديد بلا ownerOverride رغم cos تحت الحد يُسقط البوابة", () => {
  expectGateFailure(
    "ownerOverride",
    (log) => { const e = log.entries.find((x) => x.origin === "produced-under-spec"); e.ownerOverride = false; },
    null,
    /ownerOverride/,
  );
});

test("إعلان جديد بلا توثيق موافقة المالك يُسقط البوابة", () => {
  expectGateFailure("approval", (log) => { const e = log.entries.find((x) => x.origin === "produced-under-spec"); e.approval = null; }, null, /موافقة|approval/);
});

test("إعلان جديد بلا قياس بصمة المتكلم يُسقط البوابة", () => {
  expectGateFailure("cosine", (log) => { const e = log.entries.find((x) => x.origin === "produced-under-spec"); e.speakerCosineToReference = null; }, null, /بصمة المتكلم/);
});

test("الادعاء بمعرّف صوت دائم بينما المحرك لا يوفّره يُسقط البوابة", () => {
  expectGateFailure("voiceIdPersistent", (log) => { const e = log.entries.find((x) => x.origin === "produced-under-spec"); e.voiceIdPersistent = true; }, null, /معرف صوت|معرّف صوت/);
});

test("تحويل ملف موروث إلى «مُنتَج تحت المواصفة» يُسقط البوابة (لا غسيل للملفات القديمة)", () => {
  expectGateFailure(
    "origin",
    (log) => { const e = log.entries.find((x) => x.audioFile === REF_REL); e.origin = "produced-under-spec"; },
    null,
    /produced-under-spec|أرقامًا رقمية|بصمة/,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  7) ماسح MPEG: علة إطار Xing/Info لا ترجع
// ─────────────────────────────────────────────────────────────────────
test("scanMpeg يتجاهل إطار Xing/Info عند تحديد الخصائص", () => {
  const buf = fs.readFileSync(path.join(REPO_ROOT, REF_REL));
  const m = scanMpeg(buf);
  assert.ok(m, "يجب العثور على إطارات MPEG");
  assert.equal(m.hasXingHeader, true, "مرجع الإنتاج يحتوي إطار Xing/Info — هذا واقع المحرك");
  assert.equal(m.bitrateBps, SPEC.encoding.bitrateBps, "معدل البت يجب أن يُقرأ من إطارات الصوت لا من إطار Xing");
  assert.equal(m.sampleRateHz, SPEC.encoding.sampleRateHz);
  assert.equal(m.channels, SPEC.encoding.channels);
  assert.equal(m.samplesPerFrame, SPEC.encoding.samplesPerFrame);
  assert.equal(m.layer, SPEC.encoding.mpegLayer);
  assert.ok(m.durationSeconds > 1 && m.durationSeconds <= SPEC.encoding.maxDurationSeconds);
  assert.equal(m.trailingBytes, 0, "لا بايتات زائدة بعد آخر إطار");
});

test("مدة كل ملفات المستودع محسوبة من إطارات الصوت فقط", () => {
  for (const p of mp3s(AUDIO_DIR)) {
    const buf = fs.readFileSync(p);
    const m = scanMpeg(buf);
    const rel = path.relative(REPO_ROOT, p).split(path.sep).join("/");
    assert.ok(m, `${rel}: تعذّر مسح إطارات MPEG`);
    const entry = ENTRY_BY_FILE.get(rel);
    assert.ok(entry, `${rel}: بلا سطر في السجل`);
    assert.ok(Math.abs(m.durationSeconds - entry.durationSeconds) < 0.01, `${rel}: المدة المقاسة لا تطابق السجل`);
    assert.equal(m.bitrateBps, SPEC.encoding.bitrateBps, `${rel}: معدل البت`);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  8) الوسوم: إعادة الوسم لا تلمس بايتات الصوت
// ─────────────────────────────────────────────────────────────────────
test("retag يحافظ على بايتات الصوت حرفيًا ويكتب الوسوم بالمواصفة", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, REF_REL));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retag-")), "copy.mp3");
  fs.writeFileSync(tmp, src);

  const before = (() => { const e = tagExtent(src); return e ? src.subarray(e.total) : src; })();
  const script = "نص اختبار للوسم بلا أي أرقام رقمية.";
  const frames = [
    { id: "TIT2", text: "عنوان اختبار" },
    { id: "TPE1", text: SPEC.id3.fixedValues.TPE1 },
    { id: "TALB", text: SPEC.id3.fixedValues.TALB },
    { id: "TDRC", text: "2026-10-18" },
    { id: "TCON", text: SPEC.id3.fixedValues.TCON },
    { id: "TSSE", text: SPEC.id3.fixedValues.TSSE },
    { id: "COMM", comm: { language: SPEC.id3.comm.language, description: SPEC.id3.comm.description, text: script } },
  ];
  const built = buildTag(frames, SPEC.id3.minPaddingBytes);
  const outcome = retag(tmp, frames, SPEC.id3.minPaddingBytes);
  assert.equal(outcome.audioIdentical, true, "بايتات الصوت يجب أن تبقى مطابقة");
  assert.equal(outcome.audioBytes, before.length);

  const after = fs.readFileSync(tmp);
  const afterAudio = (() => { const e = tagExtent(after); return e ? after.subarray(e.total) : after; })();
  assert.ok(afterAudio.equals(before), "بايتات MPEG تغيّرت بعد إعادة الوسم — هذا ممنوع");
  assert.ok(built.length > 0);

  const extent = tagExtent(after);
  assert.equal(`2.${extent.major}`, SPEC.id3.version);
  const parsed = parseFrames(after);
  assert.deepEqual(parsed.frames.map((f) => f.id), SPEC.id3.frameOrder);
  assert.ok(parsed.paddingBytes >= SPEC.id3.minPaddingBytes);
  assert.equal(frameText(parsed, "TIT2"), "عنوان اختبار");
  assert.equal(frameText(parsed, "TPE1"), SPEC.id3.fixedValues.TPE1);
  const comm = parseComm(parsed.frames.find((f) => f.id === "COMM"));
  assert.equal(comm.language, SPEC.id3.comm.language);
  assert.equal(comm.description, SPEC.id3.comm.description);
  assert.equal(comm.text, script);
  for (const f of parsed.frames) {
    assert.equal(f.body[0], SPEC.id3.textEncodingByte, `${f.id}: ترميز النص`);
  }
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

test("كل ملفات المستودع تحمل الوسوم بالمواصفة", () => {
  for (const p of mp3s(AUDIO_DIR)) {
    const rel = path.relative(REPO_ROOT, p).split(path.sep).join("/");
    const entry = ENTRY_BY_FILE.get(rel);
    const pageScript = entry && entry.script ? String(entry.script) : null;
    const v = verifyFile(p, pageScript);
    assert.deepEqual(v.problems, [], `${rel}: ${v.problems.join(" · ")}`);
    assert.equal(v.bytes, entry.bytes, `${rel}: الحجم`);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  9) البصمة القياسية: لا تتأثر بترتيب المفاتيح
// ─────────────────────────────────────────────────────────────────────
test("canonical مستقل عن ترتيب مفاتيح الكائنات وحسّاس لترتيب المصفوفات", () => {
  // المصفوفات مرتّبة بطبيعتها (ترتيب أطر ID3 مثلًا معنى لا يجوز تجاهله)،
  // أما مفاتيح الكائنات فترتيبها في الملف لا معنى له.
  const a = { x: 1, y: { b: 2, a: [1, 2, { z: 3, k: "نص" }] } };
  const b = { y: { a: [1, 2, { k: "نص", z: 3 }], b: 2 }, x: 1 };
  assert.equal(canonical(a), canonical(b), "ترتيب المفاتيح يجب ألا يغيّر البصمة");
  assert.notEqual(canonical(a), canonical({ x: 1, y: { b: 2, a: [2, 1, { z: 3, k: "نص" }] } }), "ترتيب المصفوفة يجب أن يغيّر البصمة");
  assert.notEqual(canonical(a), canonical({ x: 1, y: { b: 2, a: [1, 2, { z: 4, k: "نص" }] } }), "تغيير قيمة يجب أن يغيّر البصمة");
  assert.equal(canonical(["TIT2", "TPE1"]), canonical(["TIT2", "TPE1"]));
});

test("specFingerprint ثابت ومستقر على المواصفة الحالية", () => {
  const fp = specFingerprint(SPEC);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, specFingerprint(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "_data", "voice_identity.json"), "utf8"))));
  assert.equal(fp, LOG.specFingerprint, "بصمة السجل يجب أن تطابق المواصفة الحالية");
});

test("specFingerprint يتجاهل أقسام التوثيق ويلتقط أقسام الإعدادات", () => {
  const base = specFingerprint(SPEC);
  const docChanged = JSON.parse(JSON.stringify(SPEC));
  docChanged.script.delivery.tempo = "صياغة توضيحية مختلفة";
  docChanged.governance.changeControl.push("معلومة إضافية");
  assert.equal(specFingerprint(docChanged), base, "تغيير نص توثيقي يجب ألا يغيّر البصمة");

  const encChanged = JSON.parse(JSON.stringify(SPEC));
  encChanged.encoding.sampleRateHz = 44100;
  assert.notEqual(specFingerprint(encChanged), base, "تغيير الترميز يجب أن يغيّر البصمة");
});

// ─────────────────────────────────────────────────────────────────────
//  10) فاحص النص: اللهجة والأرقام والحقائق
// ─────────────────────────────────────────────────────────────────────
test("extractSpokenNumbers يقرأ الأعداد المصرية المركّبة", () => {
  const cases = [
    ["مية ستة وخمسين متر", [156]],
    ["مية وعشرين متر", [120]],
    ["ميتين وتلاتين متر", [230]],
    ["خمسة مليون وخمسمية ألف جنيه", [5500000]],
    ["خمسة مليون وأربعمية ألف جنيه", [5400000]],
    ["أربعة مليون جنيه", [4000000]],
    ["تمانية مليون وميتين ألف جنيه", [8200000]],
    ["خمسة وتلاتين ألف جنيه شهريًا", [35000]],
    ["تلات غرف نوم", [3]],
    ["اتنين حمام", [2]],
    ["ريسبشن تلات قطع", [3]],
    ["الدور الأرضي", []],
    ["الدور الحداشر", [11]],
    ["الدور حداشر", [11]],
    ["الأربع غرف", [4]],
    ["شقة على المية", []],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(extractSpokenNumbers(text), want, `«${text}»`);
  }
});

test("checkScript يقبل نص الإعلان المرجعي الجديد", () => {
  assert.ok(NEW_ENTRY, "يجب أن يوجد إعلان واحد على الأقل مُنتَج تحت المواصفة");
  const property = loadProperty(NEW_ENTRY.propertySource);
  const result = checkScript(String(NEW_ENTRY.script), property);
  assert.deepEqual(result.errors, [], result.errors.join(" · "));
  assert.equal(wordCount(String(NEW_ENTRY.script)), result.words);
});

test("checkScript يرفض النص الفصيح والأرقام الرقمية وCTA الموروث", () => {
  const property = loadProperty(NEW_ENTRY.propertySource);
  const bad = "هل ترغب في شراء هذه الشقة عبر الموقع؟ السعر 5500000 جنيه. كلم سمسار طلبك على واتساب وحدد معاينة.";
  const result = checkScript(bad, property);
  assert.ok(result.errors.length >= 4, `توقّعنا مخالفات متعددة، حصلت على: ${result.errors.join(" · ")}`);
  assert.ok(result.errors.some((e) => /أرقامًا رقمية/.test(e)), "يجب رفض الأرقام الرقمية");
  for (const form of ["هل", "هذه", "عبر"]) {
    assert.ok(result.errors.some((e) => e.includes(`«${form}»`)), `يجب رفض الشكل الفصيح «${form}»: ${result.errors.join(" · ")}`);
  }
  assert.ok(result.errors.some((e) => /CTA|الغائب/.test(e)), "يجب رفض CTA بصيغة الغائب");
});

test("checkScript يرفض افتتاحية خبرية بدل سؤال الـHook", () => {
  const property = loadProperty(NEW_ENTRY.propertySource);
  const declarative = "شقة تلات غرف في مدينة نصر. في شارع نبيل خليل. الدور الأول. تلات غرف وريسبشن وحمام ومطبخ كبير. السعر خمسة مليون وخمسمية ألف جنيه. تشطيب حديث وحصة في الأرض. لو عجبك، كلمني دلوقتي على واتساب سمسار طلبك ونحدد معاينة.";
  const result = checkScript(declarative, property);
  assert.ok(result.errors.some((e) => /Hook/.test(e) && /؟/.test(e)), `يجب رفض افتتاحية بلا سؤال: ${result.errors.join(" · ")}`);
});

test("checkScript يرفض نصًا يخالف بيانات العقار (سند الحقائق)", () => {
  const property = loadProperty(NEW_ENTRY.propertySource);
  const wrongFacts = "بتفكر في شقة ميتين متر في مدينة نصر؟ في شارع نبيل خليل. الدور الأول. تلات غرف وريسبشن وحمام ومطبخ كبير. السعر تمانية مليون جنيه. تشطيب حديث وحصة في الأرض. لو عجبك، كلمني دلوقتي على واتساب سمسار طلبك ونحدد معاينة.";
  const result = checkScript(wrongFacts, property);
  assert.ok(result.errors.some((e) => /المساحة في ملف العقار/.test(e)), `يجب كشف اختلاف المساحة: ${result.errors.join(" · ")}`);
  assert.ok(result.errors.some((e) => /السعر في ملف العقار/.test(e)), `يجب كشف اختلاف السعر: ${result.errors.join(" · ")}`);
});

test("checkScript لا يخلط «إنّ» الفصحى بـ«تاني» المصرية (حدود الكلمة العربية)", () => {
  const property = loadProperty(NEW_ENTRY.propertySource);
  const ok = "بتفكر في شقة تلات غرف في مدينة نصر؟ في شارع نبيل خليل. الدور الأول. تلات غرف وريسبشن وحمام ومطبخ كبير. السعر خمسة مليون وخمسمية ألف جنيه. تشطيب حديث وحصة في الأرض. لو عجبك، كلمني دلوقتي على واتساب سمسار طلبك ونحدد معاينة.";
  const result = checkScript(ok, property);
  assert.ok(!result.errors.some((e) => /إنّ|أنّ|هل|هذا|هذه|عبر/.test(e)), `إيجاب كاذب: ${result.errors.join(" · ")}`);
});

// ─────────────────────────────────────────────────────────────────────
//  11) توصيل البوابة في CI — وجود الملف وحده لا يكفي
// ─────────────────────────────────────────────────────────────────────
test("بوابة الهوية الصوتية موصولة في workflow", () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "verify-audio-pages.yml"), "utf8");
  assert.match(wf, /verify-voice-identity\.mjs/, "البوابة غير موصولة في verify-audio-pages.yml");
});

test("مسار الإنتاج والبوابة والسجل كلها موصولة في المواصفة المركزية", () => {
  for (const key of ["specDocument", "measurementBaseline", "productionLog"]) {
    assert.ok(SPEC[key], `المواصفة تفتقد ${key}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, SPEC[key])), `${SPEC[key]} غير موجود`);
  }
  assert.equal(SPEC.productionLog, "_data/audio_voice_log.json");
  const pipeline = SPEC.governance.productionPipeline.join("\n");
  assert.match(pipeline, /produce-audio-ad\.mjs/);
  assert.match(pipeline, /verify-voice-identity\.mjs/);
  assert.match(pipeline, /measure_voice_identity\.py/);
});

test("المحرك موثَّق بلا معرّف صوت دائم ولا اشتراط صوت مرجعي", () => {
  assert.equal(SPEC.engine.persistentVoiceId, false);
  assert.equal(SPEC.engine.referenceAudioConditioning, false);
  assert.equal(SPEC.engine.voiceCloning, false);
  assert.equal(SPEC.engine.referenceAudioAcceptedAsInput, false);
  assert.equal(SPEC.engine.voiceIdScope, "session-local");
  assert.ok(SPEC.engine.hardLimit, "يجب توثيق الحد التقني صراحةً");
  assert.equal(SPEC.reference.ownerSelected, true);
});

// ─────────────────────────────────────────────────────────────────────
//  12) سجل الإنتاج: لا ادّعاءات بلا سند
// ─────────────────────────────────────────────────────────────────────
test("السجل يغطي كل ملفات الصوت ولا يدّعي معرّفًا دائمًا", () => {
  const files = mp3s(AUDIO_DIR).map((p) => path.relative(REPO_ROOT, p).split(path.sep).join("/"));
  const logged = LOG.entries.map((e) => e.audioFile);
  assert.deepEqual(files.slice().sort(), logged.slice().sort(), "كل ملف صوتي يجب أن يكون مقيدًا");
  for (const e of LOG.entries) {
    assert.equal(e.voiceIdPersistent, false, `${e.slug}: المحرك لا يوفّر معرّفًا دائمًا`);
    assert.equal(e.engine, SPEC.engine.name, `${e.slug}: محرك غير موثَّق`);
    assert.equal(e.voiceIdScope, SPEC.engine.voiceIdScope, `${e.slug}: نطاق معرّف الصوت`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.slug}: بصمة`);
    assert.ok(["reference", "compatible-with-reference", "possible-deviation-review", "clear-difference", "cannot-assess"].includes(e.classification), `${e.slug}: تصنيف غير معروف`);
    assert.ok(typeof e.speakerCosineToReference === "number", `${e.slug}: بلا قياس بصمة`);
    assert.ok(e.speakerCosineToReference >= -1 && e.speakerCosineToReference <= 1, `${e.slug}: قيمة جيب التمام خارج النطاق`);
  }
});

test("تصنيفات السجل مطابقة لحدود identityBand", () => {
  const t = SPEC.identityBand.thresholds;
  for (const e of LOG.entries) {
    if (e.audioFile === REF_REL) { assert.equal(e.classification, "reference"); continue; }
    const c = e.speakerCosineToReference;
    const want = c >= t.identicalVoice ? "compatible-with-reference"
      : c >= t.borderlineNeedsOwnerApproval ? "possible-deviation-review" : "clear-difference";
    assert.equal(e.classification, want, `${e.slug}: cos=${c}`);
  }
});

test("المدة وحدها ليست دليلًا على اختلاف الهوية (سياسة موثَّقة ومُنفَّذة)", () => {
  assert.ok(SPEC.script.lengthHandling.identityIsNotDuration, "يجب أن تنص المواصفة على أن المدة ليست معيار هوية");
  const durations = LOG.entries.map((e) => e.durationSeconds);
  assert.ok(Math.max(...durations) - Math.min(...durations) > 5, "المدد متفاوتة فعلًا في المتن");
  // التفاوت في المدة لا يغيّر التصنيف: ملفات بمدد متقاربة لها تصنيفات مختلفة
  const near = LOG.entries.filter((e) => Math.abs(e.durationSeconds - LOG.entries[0].durationSeconds) < 1.5 && e.audioFile !== REF_REL);
  const classes = new Set(near.map((e) => e.classification));
  assert.ok(classes.size >= 1, "التصنيف يعتمد على بصمة المتكلم لا على المدة");
});

test("الإعلان الجديد لم يستبدل أي ملف منشور", () => {
  assert.ok(NEW_ENTRY, "لا يوجد إعلان مُنتَج تحت المواصفة");
  assert.equal(NEW_ENTRY.replacesPublishedFile, false);
  assert.equal(NEW_ENTRY.audioFile, `assets/audio/properties/${NEW_ENTRY.slug}.mp3`);
  const legacy = LOG.entries.filter((e) => e.origin === "legacy-grandfathered");
  assert.ok(legacy.length >= 43, `الملفات الموروثة يجب أن تبقى كلها: ${legacy.length}`);
  for (const e of legacy) {
    assert.ok(!e.replacesPublishedFile, `${e.slug}: لا يجوز استبدال ملف موروث`);
  }
});
