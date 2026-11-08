import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/proxy.ts', 'src/wire.ts', 'src/node-handler.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
