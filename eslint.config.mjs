// لينت محلي بطقم قواعد SonarJS — يمنع تكرار إخفاق بوابة SonarCloud قبل الدفع.
//
// التشغيل: npm run lint:sonar   (يتطلب npm ci أولًا)
//
// القاعدتان اللتان أوقفتا بوابة PR #61 بالضبط، وكلتاهما مفعّلة هنا:
//   • sonarjs/super-linear-regex        ← S5852 · تعبير نمطي متغيّر التراجع (أمان)
//   • sonarjs/no-alphabetical-sort      ← S2871 · sort بلا دالة مقارنة (موثوقية)
//
// الحالة الفعلية (قِيست 2026-11-05، لا يُترك هذا التعليق ادّعاءً):
//   • no-alphabetical-sort = 0        ← نظيفة كما كانت.
//   • super-linear-regex   = 26 خطأًا ← **عادت للظهور** بعد أن أُصلحت 2026-10-16،
//     في 13 ملفًا منها إنتاجي: worker.js · mcp-worker.js · properties-sync-worker.js
//     · crm-chat-intel.js · scripts/lib/front-matter.mjs.
//   • إجمالي أخطاء الطقم = 412 في 44 ملفًا (تعقيد إدراكي 106، ternaries 68، …).
//
// ولهذا لا يشغّل أي سير عمل `eslint .` كحاجز: تشغيله اليوم يُسقط كل بناء.
// الحاجز الفعلي هو **سقف محكم** في `scripts/tests/sonar-barrier-budget.test.mjs`:
// القاعدتان أعلاه لا تتجاوزان عددهما الحالي، والإجمالي لا يزيد — أي أن أي كود جديد
// يخالفهما يُسقط CI، بينما الروائح القائمة لا تُوقف العمل. تخفيض رقم في السقف
// يُطلب فقط بعد إصلاح فعلي، لا بتعديله.
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  { ignores: ['node_modules/**', '_site/**', 'assets/**', 'scripts/tests/**', '_worker/tests/**'] },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    plugins: { sonarjs },
    rules: {
      ...sonarjs.configs.recommended.rules,
      // مُعلنة صراحةً كي لا يختفي الفحص لو غيّر الطقم قائمة الموصى بها
      'sonarjs/super-linear-regex': 'error',
      'sonarjs/no-alphabetical-sort': 'error',
    },
  },
];
