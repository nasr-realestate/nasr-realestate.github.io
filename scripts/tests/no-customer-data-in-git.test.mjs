// Tests: لا بيانات عملاء في Git (2026-11-05)
//
// الخطر الذي يحرسه هذا الملف: المستودع **عام** ويُبنى منه الموقع المنشور، فدخول
// ملف محادثة أو بطاقة vCard أو رقم عميل إلى Git = تسريب دائم (حتى لو حُذف لاحقًا
// يبقى في التاريخ). اليوم لا يوجد تسريب (0 ملف .vcf/.zip، 0 رقم عميل)، لكن لا
// شيء كان يمنع حدوثه: الحارس القائم (`crm-internal-docs-not-published`) يحمي
// الوثائق فقط، لا البيانات.
//
// لماذا القواعد ضيّقة ومسمّاة بدل «أي رقم»؟ لأن مسحًا ساذجًا يصطدم بـ300 ملف
// (اختبارات صناعية، أرقام الوسيط المعلنة، وأرقام تبدو هاتفية داخل بصمات SHA-256).
// الحارس الذي يُفشل نفسه كاذبًا يُعطَّل، فلا يحمي شيئًا. القواعد الأربع هنا تمسك
// سيناريوهات التسريب الفعلية فقط:
//   1) ملف عميل خام (.vcf / .vcard / .zip) متعقَّب.
//   2) نص تصدير WhatsApp خام (سطر «تاريخ، وقت - مرسل:») خارج مجلدات الاختبار.
//   3) رقم هاتف في مسار **منشور** خارج أرقام الوسيط المعلنة.
//   4) حقل موسوم صريحًا كرقم هاتف (`phone:`, `tel:`, `"phone":`) خارج الاختبارات.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** أرقام الوسيط المعلنة في الموقع نفسه (ليست بيانات عملاء). */
const PUBLIC_NUMBERS = new Set(['201147758857', '01147758857', '201022171667', '01022171667']);

/** مجلدات تحتوي أرقامًا صناعية مشروعة (اختبارات + أدلة تشخيص داخلية غير منشورة). */
const TEST_OR_INTERNAL = /^(_worker\/tests|_worker\/tests-draft|scripts\/tests|_diag)\//;

/** مسارات تُنشر فعليًا على الموقع العام. */
const PUBLISHED = /^(?:[^/]+\.html|[^/]+\.txt|[^/]+\.json|_properties\/|properties\/|api\/|_requests\/|_includes\/|_layouts\/|assets\/|\.well-known\/|tools\/)/;

/** أرقام هاتف مصرية، مع تجنّب المطابقة داخل بصمات سداسية عشرية. */
const PHONE = /(?<![0-9a-fA-F])(?:\+?20|0)1\d{9}(?![0-9a-fA-F])/g;

/** سطر تصدير WhatsApp الكلاسيكي: `12/03/2026, 9:41 - أحمد: ...` */
const WA_EXPORT_LINE = /^\s*\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*-\s/m;

/** حقل مُعلَن أنه رقم هاتف. */
const PHONE_FIELD = /(?:["']?phone(?:_number|_key)?["']?\s*[:=]\s*["']?|\btel:|wa\.me\/)((?:\+?20|0)?1\d{9})/gi;

const CUSTOMER_ARTIFACT = /\.(vcf|vcard|zip)$/i;

const TEXT_EXT = /\.(md|html|txt|json|yml|yaml|js|mjs|css|sql|toml|webmanifest|xml|svg|csv)$/i;

/** القاعدة الرابعة تخصّ ملفات البيانات (لا تعليقات الكود التوثيقية، مثل أمثلة الصيغ
 *  في `crm-wa-vcard-analysis.js` التي تعرض `tel:+201012345678` شرحًا لا بيانات). */
const DATA_FILE = /\.(json|yml|yaml|sql|csv)$/i;

/** يُعيد قائمة الانتهاكات لملف واحد — دالة نقية كي تُختبر بحالات اصطناعية. */
export function scanContent(relPath, content) {
  const findings = [];
  if (CUSTOMER_ARTIFACT.test(relPath)) findings.push(`ملف عميل خام متعقَّب: ${relPath}`);
  if (TEST_OR_INTERNAL.test(relPath)) return findings;
  if (WA_EXPORT_LINE.test(content)) findings.push(`${relPath}: نص تصدير WhatsApp خام`);
  if (PUBLISHED.test(relPath)) {
    for (const match of content.matchAll(PHONE)) {
      const digits = match[0].replace(/^\+/, '');
      const bare = digits.startsWith('20') ? digits.slice(2) : digits;
      const normalized = digits.startsWith('20') ? digits : `20${digits.slice(1)}`;
      if (PUBLIC_NUMBERS.has(digits) || PUBLIC_NUMBERS.has(bare) || PUBLIC_NUMBERS.has(normalized)) continue;
      findings.push(`${relPath}: رقم هاتف في مسار منشور (${match[0].slice(0, 4)}…)`);
    }
  }
  if (!DATA_FILE.test(relPath)) return findings;
  for (const match of content.matchAll(PHONE_FIELD)) {
    const digits = match[1].replace(/^\+/, '');
    if (PUBLIC_NUMBERS.has(digits)) continue;
    findings.push(`${relPath}: حقل هاتف (${digits.slice(0, 4)}…)`);
  }
  return findings;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('الحارس يمسك حالات التسريب الأربع (إثبات أنه ليس فحصًا فارغًا)', () => {
  assert.equal(scanContent('_site/customers.vcf', 'BEGIN:VCARD').length, 1, 'ملف vcf لم يُمسك');
  assert.equal(scanContent('exports/chat.zip', 'x').length, 1, 'ملف zip لم يُمسك');
  assert.equal(
    scanContent('_properties/leak.md', '12/03/2026, 9:41 - أحمد: عايز شقة').length >= 1,
    true,
    'نص تصدير WhatsApp لم يُمسك',
  );
  assert.equal(
    scanContent('properties/leak.html', 'اتصل 01012345678').length >= 1,
    true,
    'رقم في صفحة منشورة لم يُمسك',
  );
  assert.equal(
    scanContent('_includes/leak.html', '{"phone": "01098765432"}').length >= 1,
    true,
    'حقل phone لم يُمسك',
  );
  // ولا يُفشل نفسه كاذبًا على الحالات المشروعة:
  assert.deepEqual(scanContent('_properties/ok.md', 'اتصل بالوسيط 01147758857'), []);
  assert.deepEqual(scanContent('_worker/tests/x.test.mjs', "phone: '01012345678'"), []);
  assert.deepEqual(scanContent('_worker/analysis/x.json', '{"ref":"c6e80bc464e6d0c65a0decb41017546037498061b6ece10c89f37654"}'), []);
});

test('شجرة Git الحالية خالية من بيانات العملاء', () => {
  const findings = [];
  for (const rel of trackedFiles()) {
    if (!TEXT_EXT.test(rel) && !CUSTOMER_ARTIFACT.test(rel)) continue;
    if (CUSTOMER_ARTIFACT.test(rel)) {
      findings.push(`ملف عميل خام متعقَّب: ${rel}`);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanContent(rel, content));
  }
  assert.deepEqual(findings, [], `تسريب محتمل لبيانات عملاء في Git:\n${findings.join('\n')}`);
});
