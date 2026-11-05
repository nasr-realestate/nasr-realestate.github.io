// Tests: حراسة سيرَي التحقق من توكن Cloudflare (2026-11-05)
//
// السبب المقيس: في 2026-11-04 ظهر جزء من توكن Cloudflare داخل **اسم فحص عام** لأن السير
// أخذ آخر 40 حرفًا من stderr الخام وحقنها في اسم التشغيل. و`add-mask` يحمي السجل فقط،
// ولا يحمي قيمة تُكتب في اسم فحص أو في summary. أي أداة تشغيل جديدة على التوكن يجب أن
// تُثبِّت هذه القواعد الخمس قبل أن يُسمح لها بالوجود:
//
//   1) تشغيل يدوي فقط: لا `push` ولا `pull_request` ولا `schedule`. الأداة تحمل توكنًا،
//      فلا يجوز أن يبدأها دفعُ فرع أو إعادة تشغيل قديمة (وهذا بالضبط ما كان معطوبًا في
//      `crm-cloudflare-readonly-preflight.yml` قبل اليوم: trigger على فرع arena واحد).
//   2) `::add-mask::` قبل أول نداء `curl`، ولا `set -x` في أي مكان.
//   3) لا يُطبع التوكن ولا يُكتب في ملف أو artifact: لا `echo` للمتغير، ولا stderr خام
//      يُمرَّر إلى اسم فحص.
//   4) إثبات الكتابة لا يُقبل إلا بعبارة يفهمها إنسان، ولا يكتب إلا في قاعدة الاختبار،
//      ولا يذكر قاعدة الإنتاج كهدف طلب.
//   5) أي كتابة تُنظِّف نفسها: DROP موجود، وtrap يعيد المحاولة حتی عند الفشل.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const READONLY = '.github/workflows/crm-cloudflare-readonly-preflight.yml';
const WRITE_PROOF = '.github/workflows/crm-cloudflare-write-proof.yml';

const TEST_DB_UUID = '65bfcb14-4b48-423b-916f-00eefdb9ae1e';
const PROD_DB_UUID = 'ace5c9a2-c6b1-47b3-adf1-77e84ac50abf';

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function lines(text) {
  return text.split('\n');
}

/** Top-level `on:` block: only a dispatch trigger may appear. */
function triggerLines(text) {
  const all = lines(text);
  const start = all.findIndex((line) => /^on:\s*$/.test(line));
  assert.notEqual(start, -1, 'the workflow must declare a top-level `on:` block');
  const body = [];
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i];
    if (/^\S/.test(line)) break; // next top-level key
    if (line.trim() === '') continue;
    if (/^\s{2}\S/.test(line)) body.push(line);
  }
  return body;
}

for (const file of [READONLY, WRITE_PROOF]) {
  test(`${file}: dispatch only, never push/pull_request/schedule`, () => {
    const triggers = triggerLines(read(file));
    assert.ok(triggers.length > 0, 'the on: block must not be empty');
    for (const line of triggers) {
      assert.match(line, /^\s{2}workflow_dispatch:/, `unexpected trigger in ${file}: ${line}`);
    }
  });

  test(`${file}: the token is masked before the first curl, and xtrace is never enabled`, () => {
    const text = read(file);
    const maskAt = text.indexOf('::add-mask::');
    const firstCurl = text.indexOf('curl ');
    assert.notEqual(maskAt, -1, '::add-mask:: is mandatory in a token-holding job');
    assert.notEqual(firstCurl, -1, 'expected at least one curl in this file');
    assert.ok(maskAt < firstCurl, 'the token must be masked BEFORE the first request is made');
    assert.ok(!/set\s+-[a-z]*x/.test(text), 'set -x would echo the Authorization header into the log');
    assert.ok(!/shellcheck-quiet-xtrace-disabled/.test(text));
  });

  test(`${file}: the secret value is never echoed or captured into a name or artifact`, () => {
    const text = read(file);
    const forbidden = [
      /echo\s+"?\$\{?(CLOUDFLARE_API_TOKEN|CLOUDFLARE_TOKEN|CF_TOKEN)/,
      /echo\s+"?\$\{?auth_header/,
      /2>&1\s*\|\s*tail\s+-c/, // the 2026-11-04 leak shape: raw stderr tail into a check name
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `forbidden token-echo pattern ${pattern} matched in ${file}`);
    }
    // A secret binding and a published line must never share a line: same check, bounded to one line
    // so the assertion cannot be satisfied (or broken) by text far away in the file.
    for (const line of lines(text)) {
      const bindsSecret = /secrets\.[A-Z_]+/.test(line);
      const publishes = /::notice::|::error::|::warning::|GITHUB_STEP_SUMMARY/.test(line);
      assert.ok(!(bindsSecret && publishes),
        `a secret binding must not share a line with a published value: ${line.trim()}`);
    }
    // Every use of the raw token must be either the mask line, the auth header, or the secret binding.
    for (const line of lines(text)) {
      if (!line.includes('CLOUDFLARE_API_TOKEN')) continue;
      const allowed =
        line.includes('::add-mask::')
        // The ONLY legitimate place for the raw token is a request header held in a local variable —
        // whatever the variable is called — plus the secret binding and the emptiness guard.
        || /^\s*(auth_header|AUTH)="Authorization: Bearer \$\{?CLOUDFLARE_API_TOKEN\}?"$/.test(line)
        || line.includes('secrets.ARENA_CLOUDFLARE_TOKEN')
        || line.includes('CLOUDFLARE_API_TOKEN:')
        || line.trimStart().startsWith('#')
        || line.includes('[ -z "${CLOUDFLARE_API_TOKEN:-}" ]');
      assert.ok(allowed, `unreviewed use of the raw token in ${file}: ${line.trim()}`);
    }
  });
}

test(`${READONLY}: the first measured gate is the account read`, () => {
  const text = read(READONLY);
  assert.ok(text.includes('record token ok'), 'the real first gate is the account read');
  assert.ok(text.includes('record token fail "accounts-http='), 'and it fails only when /accounts fails');
  assert.ok(!/record token fail "http=\$verify_code/.test(text), 'a 401 there must never be a hard stop');
});

// The class, not the instance. On 2026-11-05 the same false gate was written into two workflows:
// `/user/tokens/verify` answers 401 to an account-owned token (ARENA_CLOUDFLARE_TOKEN is one), and
// each copy of the mistake stopped a run before it measured or wrote anything. Fixing one file left
// the other armed, so the rule is now global: no workflow may CALL that endpoint at all — not as a
// gate, not as "info", not as a log line that reads like an auth failure which does not exist.
test('no workflow may call /user/tokens/verify (account-owned tokens get a false 401)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 10, 'expected the real workflow directory');
  const offenders = [];
  for (const name of files) {
    const relative = `.github/workflows/${name}`;
    for (const line of lines(read(relative))) {
      if (!line.includes('user/tokens/verify')) continue;
      if (line.trimStart().startsWith('#')) continue; // explaining the ban is allowed
      offenders.push(`${relative}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `these lines call an endpoint that lies about this token: ${offenders.join(' | ')}`);
});

test(`${READONLY}: the production database is read for presence only, never queried`, () => {
  const text = read(READONLY);
  assert.ok(text.includes('record proddb'), 'the deploy asserts a production-DB signature, so invisibility is a gate');
  for (const line of lines(text)) {
    if (!line.includes('PROD_DB_UUID')) continue;
    assert.ok(
      !/(post_sql|\/query|--data|crm_contacts)/.test(line),
      `the production database must never be a query target in a read-only probe: ${line.trim()}`,
    );
  }
});

test(`${WRITE_PROOF}: write mode needs a typed human string and pins the test database`, () => {
  const text = read(WRITE_PROOF);
  assert.ok(text.includes("== 'PROVE-CLOUDFLARE-WRITE'"), 'the job must be gated on the typed string');
  assert.ok(text.includes(TEST_DB_UUID), 'the test DB uuid must be pinned in the file itself');
  assert.ok(text.includes("read_const TEST_DB_UUID"), 'and cross-checked against the A5 constants');
  assert.ok(text.includes("constants-drift-refused"), 'a drifted constant must fail closed');
  assert.ok(text.includes("!= 'nasr-crm-test-db'"), 'the target must be confirmed by name, not only by uuid');
});

test(`${WRITE_PROOF}: the production database is never a request target`, () => {
  const text = read(WRITE_PROOF);
  assert.ok(!text.includes(PROD_DB_UUID), 'the production uuid must not appear at all in a write probe');
  for (const line of lines(text)) {
    if (!line.includes('nasr-market-db')) continue;
    assert.ok(
      !/(curl|--data|\/query|workers\/scripts)/.test(line),
      `the production database name must never sit on a request line: ${line.trim()}`,
    );
  }
});

test(`${WRITE_PROOF}: every write cleans up, including on failure`, () => {
  const text = read(WRITE_PROOF);
  assert.ok(text.includes('CREATE TABLE _cf_probe_write_proof'), 'the probe table must be a throwaway');
  assert.ok(text.includes('DROP TABLE _cf_probe_write_proof'), 'the run must drop it explicitly');
  assert.ok(text.includes('DROP TABLE IF EXISTS _cf_probe_write_proof'), 'and the trap must drop it again');
  assert.match(text, /trap '[^']*drop_probe_table[^']*' EXIT/, 'the EXIT trap must attempt the drop');
  assert.ok(text.includes('verified-absent'), 'the run must prove the table is gone, not assume it');
  assert.ok(!/DELETE FROM|DROP TABLE crm_/.test(text), 'the probe must never delete CRM rows or tables');
});
