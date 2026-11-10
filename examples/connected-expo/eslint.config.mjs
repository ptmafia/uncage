// The repo's ESLint config, plus Node's CommonJS globals for metro.config.js (Metro loads it with require).
import root from '../../eslint.config.js';

export default [
  ...root,
  { ignores: ['.expo/**', 'android/**', 'ios/**'] },
  {
    files: ['metro.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
