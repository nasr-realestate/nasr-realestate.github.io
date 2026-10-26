// Tests: بوابة SONAR_TOKEN في sonarcloud.yml (حادثة 2026-10-26).
//
// السياق: من 2026-10-26 13:01 UTC صار SonarCloud يرفض SONAR_TOKEN
// ({"valid":false})، ففشل «SonarCloud Scan» على كل commit وظهرت علامة ❌
// على master رغم نجاح كل عمليات النشر. الـworkflow صار يتحقق من المفتاح أولًا
// ويتخطّى المسح (Skipped) بتحذير ظاهر عند رفضه، ويشغّله كالمعتاد عند قبوله.
//
// ما يثبته هذا الملف: بنية الـworkflow، وأن قيمة المفتاح لا تُطبع أبدًا، ومنطق
// التصنيف نفسه — بتشغيل سكربت الخطوة كما هو بـbash مع curl وهمي (بلا شبكة).
// ما لا يثبته: رد SonarCloud الحقيقي — ذلك يظهر فقط في تشغيل GitHub Actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'sonarcloud.yml'), 'utf8');
const WF = yaml.load(SRC);
const BASH = '/bin/bash';
const NO_BASH = fs.existsSync(BASH) ? false : 'لا يوجد /bin/bash على هذا الجهاز';
// قيمة اصطناعية بشكل مفتاح SonarCloud (40 حرف hex) — ليست مفتاحًا حقيقيًا.
const FAKE_TOKEN = 'deadbeef' + '0123456789abcdef'.repeat(2);

const checkStep = () => WF.jobs.token.steps.find((s) => s.id === 'check');

// curl وهمي: يسجّل وسائطه وما وصله على stdin، ثم يرد حسب STUB_MODE بنفس شكل
// مخرَج curl الحقيقي مع -w '\n%{http_code}'.
const STUB_CURL = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG.args"
cat > "$STUB_LOG.stdin"
case "$STUB_MODE" in
  valid)          printf '{"valid":true}\\n200' ;;
  invalid)        printf '{"valid":false}\\n200' ;;
  spaced-invalid) printf '{ "valid" : false }\\n200' ;;
  http401)        printf '\\n401' ;;
  html503)        printf '<html>busy</html>\\n503' ;;
  injected)       printf '::error title=x::boom-from-body\\n200' ;;
  down)           printf '\\n000'; exit 7 ;;
  *)              exit 2 ;;
esac
`;

function runGate({ token, mode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-gate-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), STUB_CURL, { mode: 0o755 });
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, checkStep().run);
  const out = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const log = path.join(dir, 'curl');
  fs.writeFileSync(out, '');
  fs.writeFileSync(summary, '');
  // نفس طريقة GitHub Actions في تشغيل خطوات run على ubuntu.
  const res = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      SONAR_TOKEN: token ?? '',
      STUB_MODE: mode ?? 'unused',
      STUB_LOG: log,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  const readIf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const outputs = Object.fromEntries(
    fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')),
  );
  const result = {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    outputs,
    summary: fs.readFileSync(summary, 'utf8'),
    curlArgs: readIf(`${log}.args`),
    curlStdin: readIf(`${log}.stdin`),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function assertTokenNeverPrinted(r) {
  for (const [where, text] of [
    ['stdout', r.stdout],
    ['stderr', r.stderr],
    ['GITHUB_OUTPUT', JSON.stringify(r.outputs)],
    ['GITHUB_STEP_SUMMARY', r.summary],
    ['curl argv', r.curlArgs ?? ''],
  ]) {
    assert.ok(!text.includes(FAKE_TOKEN), `قيمة المفتاح ظهرت في ${where}`);
  }
}

test('sonarcloud.yml: نفس المشغّلات القديمة (push على master/main + pull_request) وصلاحيات قراءة فقط', () => {
  assert.deepEqual(WF.on.push.branches, ['master', 'main']);
  assert.deepEqual(WF.on.pull_request.types, ['opened', 'synchronize', 'reopened']);
  assert.deepEqual(WF.permissions, { contents: 'read', 'pull-requests': 'read' });
});

test('sonarcloud.yml: job المسح يعمل فقط بعد قبول المفتاح، وبنفس اسمه القديم', () => {
  const { token, sonarcloud } = WF.jobs;
  assert.equal(token.outputs.scan, '${{ steps.check.outputs.scan }}');
  assert.equal(sonarcloud.name, 'SonarCloud Scan Action');
  assert.equal(sonarcloud.needs, 'token');
  assert.equal(sonarcloud.if, "needs.token.outputs.scan == 'true'");
  assert.ok(checkStep(), 'خطوة التحقق (id: check) مفقودة');
  assert.equal(checkStep().env.SONAR_TOKEN, '${{ secrets.SONAR_TOKEN }}');
});

test('sonarcloud.yml: أداة المسح نفس v3.1.0 لكن مثبّتة على SHA كاملة، وبنفس متغيرات البيئة', () => {
  const steps = WF.jobs.sonarcloud.steps;
  const scan = steps.find((s) => s.name === 'SonarCloud Scan');
  assert.equal(scan.uses, 'SonarSource/sonarcloud-github-action@383f7e52eae3ab0510c3cb0e7d9d150bbaeab838');
  assert.match(SRC, /sonarcloud-github-action@383f7e52eae3ab0510c3cb0e7d9d150bbaeab838 # v3\.1\.0/);
  assert.deepEqual(scan.env, {
    GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}',
  });
  const checkout = steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
  assert.match(checkout.uses, /@[0-9a-f]{40}$/);
  assert.equal(checkout.with['fetch-depth'], 0);
});

test('سكربت التحقق: لا يطبع المفتاح، ولا يمرره في سطر أوامر curl، ولا تعبيرات ${{ }} داخله', () => {
  const run = checkStep().run;
  // الأسطر التنفيذية فقط (التعليقات تشرح القاعدة وتذكر set -x بالضرورة).
  const code = run.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /set -x|set -o xtrace|set -v/);
  assert.doesNotMatch(code, /(echo|printf)[^\n|]*\$\{?SONAR_TOKEN[^\n]*>>/, 'لا كتابة للمفتاح في ملفات GitHub');
  assert.doesNotMatch(code, /echo[^\n]*\$\{?SONAR_TOKEN/);
  assert.doesNotMatch(code, /curl[^\n]*\s-u\s/);
  // الاستخدام الوحيد للقيمة: printf (أمر داخلي في bash) إلى stdin الخاص بـcurl.
  const uses = code.match(/\$\{?SONAR_TOKEN/g) ?? [];
  assert.equal(uses.length, 2, 'المفتاح يُستخدم مرتين فقط: فحص الوجود + stdin لـcurl');
  assert.match(code, /printf 'user = "%s:"\\n' "\$SONAR_TOKEN" \\\n\s*\| curl [^\n]*-K -/);
  assert.doesNotMatch(run, /\$\{\{/);
});

test('بلا مفتاح (سر غير موجود أو PR من fork): تخطٍّ بتحذير، وبلا أي اتصال', { skip: NO_BASH }, () => {
  const r = runGate({ token: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { state: 'missing', scan: 'false' });
  assert.equal(r.curlArgs, null, 'لا يجوز الاتصال بـSonarCloud بلا مفتاح');
  assert.match(r.stdout, /::warning title=SonarCloud scan skipped \(no token\)::/);
  assert.match(r.summary, /تم تخطي المسح \(missing\)/);
});

test('مفتاح مقبول ({"valid":true}): المسح يعمل كالمعتاد، بلا تحذير ولا ملخص تخطٍّ', { skip: NO_BASH }, () => {
  const r = runGate({ token: FAKE_TOKEN, mode: 'valid' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { state: 'valid', scan: 'true' });
  assert.doesNotMatch(r.stdout, /::warning/);
  assert.equal(r.summary, '');
  assertTokenNeverPrinted(r);
  assert.equal(r.curlStdin, `user = "${FAKE_TOKEN}:"\n`, 'المفتاح يصل إلى curl عبر stdin فقط');
  assert.match(r.curlArgs, /https:\/\/sonarcloud\.io\/api\/authentication\/validate/);
});

test('مفتاح مرفوض ({"valid":false} — حالة 2026-10-26): تخطٍّ بتحذير وخطوات تجديد واضحة', { skip: NO_BASH }, () => {
  for (const mode of ['invalid', 'spaced-invalid', 'http401']) {
    const r = runGate({ token: FAKE_TOKEN, mode });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(r.outputs, { state: 'invalid', scan: 'false' }, mode);
    assert.match(r.stdout, /::warning title=SonarCloud scan skipped \(SONAR_TOKEN rejected\)::/, mode);
    assert.match(r.stdout, /نشر الموقع غير متأثر/, mode);
    assert.match(r.summary, /تم تخطي المسح \(invalid\)/, mode);
    assert.match(r.summary, /My Account > Security > Generate Token/, mode);
    assert.match(r.summary, /Secrets and variables > Actions > `SONAR_TOKEN` > Update secret/, mode);
    assertTokenNeverPrinted(r);
  }
});

test('تعذّر التحقق (SonarCloud لا يرد أو 503): المسح يعمل كالمعتاد ليقرر بنفسه — لا تخطٍّ صامت', { skip: NO_BASH }, () => {
  for (const [mode, http] of [['down', '000'], ['html503', '503']]) {
    const r = runGate({ token: FAKE_TOKEN, mode });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(r.outputs, { state: 'unknown', scan: 'true' }, mode);
    assert.match(r.stdout, new RegExp(`::warning title=SonarCloud token check::.*HTTP ${http}`), mode);
    assert.equal(r.summary, '', mode);
    assertTokenNeverPrinted(r);
  }
});

test('رد غريب من الخادم لا يُطبع في السجل (لا حقن أوامر workflow)', { skip: NO_BASH }, () => {
  const r = runGate({ token: FAKE_TOKEN, mode: 'injected' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { state: 'unknown', scan: 'true' });
  assert.doesNotMatch(r.stdout, /boom-from-body|::error/);
  assertTokenNeverPrinted(r);
});
