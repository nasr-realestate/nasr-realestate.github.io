// Tests: حرس مخرَج مولّد طبقة الذكاء (2026-11-05)
//
// السبب المقيس: `--out` بلا `=value` كان يُقرأ `true` منطقية، ثم `String(...)`
// تحوّلها إلى اسم مجلد، فكتب المولّد الطبقة كاملة داخل مجلد اسمه حرفيًا `true/`
// في جذر المستودع. النتيجة: 223 ملفًا مكرَّرًا دخلت Git، ونُشرت على الموقع العام
// بنسخة **قديمة** (`/true/api/properties.json` كان يرجع 200 بـ105 وحدة، بينما
// النسخة الحقيقية 109) — أي محتوى مكرَّر ومتقادم تحت عنوان عام.
//
// هذا الاختبار يثبّت ثلاثة أشياء:
//   1) المولّد يرفض `--out` بلا قيمة، ويرفض القيم المنطقية `true|false`.
//   2) لا توجد في الجذر شجرة ثانية لطبقة الذكاء (مجلد غير `_site` يحمل
//      `ai-feed.json` و`api/properties.json` معًا).
//   3) الهدف الافتراضي يبقى `_site` (لم يتغيّر سلوك النشر).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = 'scripts/build-ai-artifacts.mjs';

function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('المولّد يرفض --out بلا قيمة ولا يُنشئ مجلدًا بالاسم true', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'true')), false, 'المجلد true موجود في الجذر أصلًا');
  for (const args of [['--out', '--check'], ['--out=true', '--check'], ['--out=false', '--check']]) {
    const res = runGenerator(args);
    assert.notEqual(res.status, 0, `${args.join(' ')} كان يجب أن يفشل`);
    assert.match(String(res.stderr), /--out/, `${args.join(' ')}: الرسالة لا تذكر العلم`);
    assert.equal(fs.existsSync(path.join(ROOT, 'true')), false, `${args.join(' ')}: أُنشئ مجلد true رغم الرفض`);
  }
});

test('الجذر لا يحمل شجرة ثانية لطبقة الذكاء (لا مجلد غير _site فيه ai-feed + api/properties)', () => {
  const duplicates = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_site')
    .map((entry) => entry.name)
    .filter(
      (name) =>
        fs.existsSync(path.join(ROOT, name, 'ai-feed.json')) &&
        fs.existsSync(path.join(ROOT, name, 'api', 'properties.json')),
    );
  assert.deepEqual(duplicates, [], `شجرة مكرّرة للطبقة في الجذر: ${duplicates.join(', ')}`);
});

test('لا أثر لـ true/ في الملفات المتعقَّبة في Git', () => {
  const tracked = execFileSync('git', ['ls-files', 'true'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', `ملفات true/ ما زالت متعقَّبة:\n${tracked.slice(0, 400)}`);
});

test('الهدف الافتراضي للمولّد يبقى _site', () => {
  const res = runGenerator(['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(String(res.stdout), /الهدف: _site/, 'الهدف الافتراضي تغيّر — قد ينكسر مسار النشر');
});
