import { defineConfig } from 'tsup';

export default defineConfig({
  // `node` holds Node-only helpers; the root entry must stay usable in browsers.
  entry: { index: 'src/index.ts', node: 'src/node/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
});
