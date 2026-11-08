import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/.next/**', '**/next-env.d.ts', '**/test-results/**', '**/playwright-report/**', 'e2e/live/results/**', 'e2e/connected/results/**', 'apps/docs/.astro/**', 'apps/docs/.snippets/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
