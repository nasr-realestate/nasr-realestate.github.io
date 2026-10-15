const sonarjs = require('eslint-plugin-sonarjs');
module.exports = [
  {
    files: ['_diag/check-audio-batch3.mjs'],
    plugins: { sonarjs },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' } },
    rules: { ...sonarjs.configs.recommended.rules },
  },
];
