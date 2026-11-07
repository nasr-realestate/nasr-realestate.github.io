/**
 * ثبات شاشة CRM — «الشاشة تميل يمينًا وشمالًا وتُقطع الأطراف» (2026-11-07).
 *
 * الشكوى كانت عن انزلاق أفقي للصفحة كلها، لا عن شكل البطاقات. سببان ملموسان في CSS:
 *   1) الصفحة لا تحجز مساحة شريط التمرير، فإغلاقه وفتحه (فتح ورقة العميل تفتح body.sheet-open
 *      الذي يضبط overflow:hidden) يزحزح العرض كله أفقيًا مع كل فتح وإغلاق.
 *   2) أبناء الشبكات/الصفوف بلا min-width:0 يتمددون بنص طويل واحد (رابط أو بريد أو رقم)
 *      فيخرج المحتوى عن الشاشة بدل أن يُكسر داخل البطاقة.
 *
 * والحل المرفوض هو إخفاء الفائض (overflow:hidden/overflow-x:clip) لأنه «يُخفي الأطراف».
 * الاختبار يمنع الاثنين: يثبّت قواعد الثبات، ويمنع عودة الحل الذي يقطع المحتوى.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CSS = await readFile(new URL('../crm-ui/crm-assets/app.css', import.meta.url), 'utf8');

/** كل قاعدة في الملف: الخريطة الأولى لكل مُحدِّد. */
const blocks = new Map();
for (const match of CSS.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim();
  if (!blocks.has(selector)) blocks.set(selector, match[2]);
}
const declarations = (selector) => {
  assert.ok(blocks.has(selector), `قاعدة مفقودة: ${selector}`);
  return blocks.get(selector);
};

test('الصفحة تحجز مساحة شريط التمرير: فتح ورقة العميل لا يزحزح الشاشة أفقيًا', () => {
  const html = declarations('html');
  assert.match(html, /scrollbar-gutter:stable/, 'بدون حجز المساحة يقفز العرض عند كل فتح/إغلاق');
  assert.match(html, /overscroll-behavior-x:none/, 'لا ارتداد أفقي عند السحب على اللمس');
});

test('لا استخدام لوحدة 100vw في التخطيط: مع شريط التمرير تصبح أوسع من المساحة الفعلية فيميل المحتوى', () => {
  assert.doesNotMatch(CSS, /100vw/, 'استخدم 100% (نسبة إلى مساحة المحتوى) لا 100vw');
  assert.match(declarations('.topbar'), /calc\(\(100% - 1180px\)\/2/, 'حشو الشريط العلوي يتمركز بالمساحة المتاحة');
  assert.match(declarations('main'), /max-width:1180px/, 'والشريطني على نفس عمود المحتوى');
});

test('الشريط العلوي وصف الأزرار يلتفان بدل أن يفيضا أفقيًا خارج الشاشة', () => {
  const topbar = declarations('.topbar');
  assert.match(topbar, /flex-wrap:wrap/);
  assert.match(declarations('.top-actions'), /flex-wrap:wrap/);
  assert.match(declarations('.brand,.top-actions,.brand>div'), /min-width:0/, 'بلا min-width:0 لا يتقلص العنصر داخل flex');
});

test('أبناء الشبكات يتمكنون من التقلص، والنص الطويل يُكسر داخل البطاقة بدل أن يمدّ الصفحة', () => {
  const children = declarations('.card,.metric,.record,.a5-item,.a5-detail,.sheet-panel,.panel,.columns>*,.contacts-layout>*,.form-grid>*,.phone-row>*');
  assert.match(children, /min-width:0/);
  const longText = declarations('.record strong,.record small,.notes-box,.sheet-hero p,.a5-facts dd,.a5-event p,.chat-bubble-body,.raw-chat-pre,.property-option small,.match-card,.footer-note');
  assert.match(longText, /overflow-wrap:anywhere/);
  assert.match(declarations('body'), /overflow-wrap:break-word/);
});

test('الحل ليس إخفاء الأطراف: لا overflow مخفي على الصفحة أو الشريط العلوي', () => {
  for (const selector of ['html', 'html,body', 'body', '.topbar', 'main']) {
    if (!blocks.has(selector)) continue;
    assert.doesNotMatch(blocks.get(selector), /overflow(-x)?\s*:\s*(hidden|clip)/, `${selector} لا يخفي الفائض`);
  }
  assert.doesNotMatch(CSS, /overflow-x\s*:\s*(hidden|clip)/, 'لا قصّ أفقي صامت في أي مكان');
  // قفل التمرير عند فتح الورقة يبقى محصورًا في الحالة نفسها.
  assert.match(declarations('body.sheet-open'), /overflow:hidden/);
});

test('ورقة العميل تبقى داخل عرض الشاشة، ورابط التخطي لا يمدّ الصفحة بألف بكسل', () => {
  assert.match(declarations('.sheet-panel'), /width:min\(780px,100%\)/);
  assert.doesNotMatch(CSS, /-10000px/, 'طريقة inset-inline-start:-10000px تُبقي عنصرًا ضخمًا خارج الشاشة');
  assert.match(declarations('.skip'), /clip-path:inset\(50%\)/);
  assert.match(declarations('.skip:focus'), /clip-path:none/, 'الرابط يظهر كاملًا عند التركيز');
});
