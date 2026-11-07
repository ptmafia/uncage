import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/proxy.ts', 'src/wire.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
