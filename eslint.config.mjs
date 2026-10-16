// لينت محلي بطقم قواعد SonarJS — يمنع تكرار إخفاق بوابة SonarCloud قبل الدفع.
//
// التشغيل: npm run lint:sonar   (يتطلب npm ci أولًا)
//
// القاعدتان اللتان أوقفتا بوابة PR #61 بالضبط، وكلتاهما مفعّلة هنا:
//   • sonarjs/super-linear-regex        ← S5852 · تعبير نمطي متغيّر التراجع (أمان)
//   • sonarjs/no-alphabetical-sort      ← S2871 · sort بلا دالة مقارنة (موثوقية)
// بعد إصلاح مواضعهما (2026-10-16) صار عددهما صفرًا في المستودع.
//
// ما يظهر هنا غير ذلك (تعقيد إدراكي، ternaries متداخلة، قوالب متداخلة) روائح
// كود لا تُسقط بوابة الجودة الحالية — تبقى ظاهرة بوصفها تحسينات مقترحة.
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
