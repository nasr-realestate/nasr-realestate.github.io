// Tests: ناشر الصفحات الوحيد + تحقّق ما بعد النشر (المحور أ)
// يقرأ ملفات .github/workflows كما هي، بلا شبكة وبلا GitHub API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');
const read = (name) => fs.readFileSync(path.join(WF, name), 'utf8');
const workflows = () => fs.readdirSync(WF).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

test("ناشر واحد فقط لـPages: deploy.yml هو الوحيد الذي يرفع/ينشر", () => {
  const publishers = workflows().filter((f) => {
    const s = read(f);
    return /deploy-pages@|upload-pages-artifact@/.test(s);
  });
  assert.deepEqual(publishers, ['deploy.yml']);
});

test("deploy.yml: master فقط، بلا main، ومجموعة concurrency واحدة بلا إلغاء", () => {
  const s = read('deploy.yml');
  const push = s.match(/on:\s*\n([\s\S]*?)\npermissions:/);
  assert.ok(push, 'لم أجد قسم on');
  assert.match(push[1], /branches:\s*\[\s*"master"\s*\]/, 'المصدر لازم يكون master وحده');
  assert.doesNotMatch(push[1], /"main"/, 'لا مسار نشر من main');

  const conc = s.match(/concurrency:\s*\n\s*group:\s*"([^"]+)"\s*\n\s*cancel-in-progress:\s*(\w+)/);
  assert.ok(conc, 'قسم concurrency مفقود');
  assert.equal(conc[1], 'pages-production', 'اسم المجموعة الموحّد');
  assert.equal(conc[2], 'false', 'لا نلغي نشرًا جاريًا في منتصفه');
});

test("deploy.yml: يختم SHA داخل _site، والتحقق بعد النشر يعتمد عليه", () => {
  const s = read('deploy.yml');
  assert.match(s, /_site\/\.well-known\/deploy-info\.json/);
  assert.match(s, /\$\{\{\s*github\.sha\s*\}\}/);
  const verifyJob = s.slice(s.indexOf('  verify:'));
  assert.match(verifyJob, /needs:\s*deploy/);
  assert.match(verifyJob, /node scripts\/verify-deployment\.mjs/);
  assert.match(verifyJob, /EXPECTED_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
});

test("cleanup-requests: بعد الدفع يُطلق deploy.yml صراحةً (GITHUB_TOKEN لا يُطلق workflows)", () => {
  const s = read('cleanup-requests.yml');
  assert.match(s, /actions:\s*write/, 'صلاحية actions مطلوبة لـworkflow_dispatch');
  assert.match(s, /gh workflow run deploy\.yml --ref master/);
  assert.match(s, /steps\.commit\.outputs\.pushed == 'true'/);
  assert.match(s, /"pushed=true" >> "\$GITHUB_OUTPUT"/);
});

test("لا نشر لأي Worker من فرع مراجعة: master فقط + حارس ref", () => {
  for (const file of ['deploy-properties-sync.yml', 'deploy-mcp-gateway.yml']) {
    const s = read(file);
    // قسم on فقط، بلا تعليقات (التعليقات تشرح الحادثة وتذكر arena/ بالضرورة).
    const on = s.slice(s.indexOf('\non:'), s.indexOf('permissions:'))
      .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(on, /arena\//, `${file}: لا يجوز أن يعمل على فروع arena`);
    assert.doesNotMatch(on, /"main"/, `${file}: لا فرع main`);
    assert.match(on, /branches:\s*\[\s*"master"\s*\]/, `${file}: master فقط`);
    assert.match(s, /if:\s*github\.ref == 'refs\/heads\/master'/, `${file}: حارس ref مطلوب قبل النشر`);
  }
});

test("ملف package-lock مُتتبَّع فعلًا، وتعليق deploy.yml لا يدّعي العكس", () => {
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, 'package-lock.json');
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.doesNotMatch(gitignore, /^package-lock\.json\s*$/m);
  const s = read('deploy.yml');
  assert.doesNotMatch(s, /package-lock\.json مستثنى من Git/);
  assert.match(s, /package-lock\.json \*\*مُتتبَّع في Git\*\*/);
});

test("قوائم تصنيف deploy-properties-sync تغطّي كل ملفات _properties بلا نقص أو تكرار", () => {
  // سبب الاختبار: القوائم مكتوبة يدويًا داخل الـworkflow، وأي عقار جديد يُضاف
  // إلى _properties ويُنسى هنا يجعل التحقّق الحقيقي بعد النشر يفشل بسبب قديم
  // لا علاقة له بالكود. الفحص هنا ثابت (بلا شبكة) ويفشل برسالة تسمّي الناقص.
  const s = read('deploy-properties-sync.yml');
  const pick = (key) => {
    const m = s.match(new RegExp(`${key}:\\s*"([^"]*)"`));
    assert.ok(m, `${key} مفقود من الـworkflow`);
    return m[1].split(',').map((x) => x.trim()).filter(Boolean);
  };
  const inScope = pick('IN_SCOPE_IDS');
  const outScope = pick('OUT_OF_SCOPE_IDS');
  const invalid = pick('INVALID_IDS');
  const all = [...inScope, ...outScope, ...invalid];

  assert.equal(new Set(all).size, all.length, 'معرّف مكرر بين القوائم');
  assert.equal(outScope.length, 12, 'عدد خارج النطاق يجب أن يطابق اختبارات الـWorker');
  assert.equal(invalid.length, 8, 'عدد غير الصالح يجب أن يطابق اختبارات الـWorker');

  const dir = path.join(ROOT, '_properties');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const fileIds = files.map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = raw.startsWith('---') ? raw.split('---')[1] : '';
    const m = fm.match(/^id:\s*"?([^"\n]+)"?/m);
    assert.ok(m, `${f}: id مفقود من الـfront matter`);
    return m[1].trim();
  });

  const listed = new Set(all);
  const missing = fileIds.filter((id) => !listed.has(id));
  assert.deepEqual(missing, [], `عقارات غير مصنّفة في الـworkflow: ${missing.join(', ')}`);
  const ghosts = all.filter((id) => !fileIds.includes(id));
  assert.deepEqual(ghosts, [], `معرّفات في الـworkflow بلا ملف: ${ghosts.join(', ')}`);
  assert.equal(inScope.length + outScope.length + invalid.length, fileIds.length);
});

test("sync verification: يكمل عبر تشغيلات عند غياب source_sha256 بدل فشل مستحيل", () => {
  // النشر من الفرع (legacy) لا يولّد source_sha256، ومعه يستحيل complete في تشغيل
  // واحد (كل الملفات تحتاج قراءة وحد الميزانية 40). الفحص هنا يضمن أن الـworkflow
  // يقرأ تغطية الـsha من الـfeed ويخفّف شرط complete فقط في هذه الحالة.
  const s = read('deploy-properties-sync.yml');
  // مصدر الحقيقة هو إعلان الـWorker نفسه، لا استجابة قد يخدعها كاش CDN.
  assert.match(s, /github\.source_sha_present/);
  assert.ok(!s.includes('SHA_COVER'), 'لا نستنتج البصمات من الموقع');
  assert.ok(s.includes('.github.source_sha_present'), 'القرار من إعلان الـWorker');
  assert.match(s, /check "final_pass_complete"/);
  assert.match(s, /check "state_files_tracked"/);
  assert.match(s, /check "null_area_not_cleared"/);
});

test("أسماء ملفات workflows على master فريدة (لا تصادم عند تبديل المصدر)", () => {
  const names = workflows().map((f) => path.basename(f, path.extname(f)));
  assert.equal(new Set(names).size, names.length);
});
