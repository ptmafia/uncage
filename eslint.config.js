import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/.next/**', '**/next-env.d.ts', '**/test-results/**', '**/playwright-report/**', 'e2e/live/results/**', 'e2e/connected/results/**', 'apps/docs/.astro/**', 'apps/docs/.snippets/**', 'apps/site/.astro/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } },
  // Astro configs and the docs' nav run in Node at build time (they read SITE_URL from process.env).
  { files: ['apps/*/*.mjs', 'apps/*/src/**/*.mjs'], languageOptions: { globals: { process: 'readonly' } } },
);
