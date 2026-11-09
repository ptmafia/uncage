import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/errors.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
