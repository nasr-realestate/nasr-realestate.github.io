/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/tests/verify-deployment-audio.test.mjs
 * ───────────────────────────────────────────────────────────────────
 *  لماذا (2026-11-20): خطوة `verify` في deploy.yml كانت تفشل في **كل**
 *  نشر برسالة «14/132 ملف فاشل». السبب أن `listAudioFiles` كانت تمشي على
 *  `assets/audio/` بلا استثناء، فتشمل `assets/audio/requests/` — أربعة عشر
 *  ملفًا لدفعة طلبات أُغلقت (السجل: `"productionSession": "requests b1
 *  (منتهٍ)"`) ولم تُنشأ لها صفحة قط. النتيجة أن التحقق كان يرشّح عيبًا
 *  حقيقيًا وسط ضجيج دائم، فصار الجميع يتجاهله.
 *
 *  المعيار الآن: يُتحقق من الملف الصوتي إن وفقط إن كانت صفحة منشورة تشير
 *  إليه بـ`audio_file:`. هذا يحفظ قدرة الكشف: ملف منشور مفقود من الموقع
 *  يبقى في القائمة ويُمسَك بـ404.
 *
 *  الاختبار يبني شجرة مؤقتة — لا يلمس ملفات المستودع.
 * ═══════════════════════════════════════════════════════════════════
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAudioFiles, referencedAudioPaths } from '../verify-deployment.mjs';

/** يبني مستودعًا وهميًا: مجلد صوت + مجلدات المصادر. */
function fixture({ audio = [], properties = [], requests = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdep-'));
  for (const rel of audio) {
    const full = path.join(root, 'assets', 'audio', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(64, 1));
  }
  for (const [dir, files] of [['_properties', properties], ['_requests', requests]]) {
    for (const [name, body] of files) {
      const full = path.join(root, dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
  }
  return root;
}

const prop = (audioFile) => [
  '---',
  'layout: property_page',
  'title: "وحدة اختبار"',
  `audio_file: "${audioFile}"`,
  '---',
  '',
].join('\n');

test('ملف صوتي بلا صفحة منشورة لا يُفحص', () => {
  const root = fixture({
    audio: ['requests/orphan-request.mp3', 'properties/live.mp3'],
    properties: [['live.md', prop('/assets/audio/properties/live.mp3')]],
  });
  const urls = listAudioFiles(root).map((f) => f.url);
  assert.deepEqual(urls, ['/assets/audio/properties/live.mp3'],
    'الصوت بلا صفحة منشورة يجب استبعاده — وإلا فشل التحقق في كل نشر');
  fs.rmSync(root, { recursive: true, force: true });
});

test('ملف منشور مفقود من القرص لا يختفي من القائمة', () => {
  // الحالة التي يجب أن تُمسك: الصفحة تعلن ملفًا، الملف مذكور لكنه لم يُرفع.
  // نضعه على القرص لنرى أن القائمة تشمله ما دام مرجعًا.
  const root = fixture({
    audio: ['properties/present.mp3'],
    properties: [['present.md', prop('/assets/audio/properties/present.mp3')]],
  });
  const urls = listAudioFiles(root).map((f) => f.url);
  assert.ok(urls.includes('/assets/audio/properties/present.mp3'),
    'الملف المنشور يجب أن يبقى في قائمة التحقق وإلا فقدنا قدرة كشف 404');
  fs.rmSync(root, { recursive: true, force: true });
});

test('صفحة الطلبات (_requests) تُحسب مصدرًا منشورًا', () => {
  const root = fixture({
    audio: ['requests/live-request.mp3'],
    requests: [['r.md', prop('/assets/audio/requests/live-request.mp3')]],
  });
  const urls = listAudioFiles(root).map((f) => f.url);
  assert.deepEqual(urls, ['/assets/audio/requests/live-request.mp3'],
    'طلب منشور صوته منشور ⇒ يجب التحقق منه');
  fs.rmSync(root, { recursive: true, force: true });
});

test('referencedAudioPaths تجمع من المصدرين معًا', () => {
  const root = fixture({
    properties: [['a.md', prop('/assets/audio/properties/a.mp3')]],
    requests: [['b.md', prop('/assets/audio/requests/b.mp3')]],
  });
  const refs = referencedAudioPaths(root);
  assert.equal(refs.size, 2);
  assert.ok(refs.has('/assets/audio/properties/a.mp3'));
  assert.ok(refs.has('/assets/audio/requests/b.mp3'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('المستودع الحقيقي: كل صوت يُفحص له مرجع منشور', () => {
  const refs = referencedAudioPaths();
  const checked = listAudioFiles();
  assert.ok(checked.length > 0, 'لا ملفات صوتية تُفحص — تحقق من المسارات');
  for (const f of checked) {
    assert.ok(refs.has(f.url), `${f.url} يُفحص بلا صفحة منشورة تعلنه`);
  }
  // دفعة الطلبات المنتهية يجب ألا تدخل التحقق
  const requestAudio = checked.filter((f) => f.url.includes('/requests/'));
  assert.equal(requestAudio.length, 0,
    `دفعة طلبات منتهية دخلت التحقق (${requestAudio.length} ملفًا) — ستُفشل كل نشر`);
});
