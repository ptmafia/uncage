import { defineConfig } from 'tsup';

export default defineConfig({
  // supervise.js is also loaded on its own by the real-service CI test (src/service/real.test.ts).
  entry: ['src/bin.ts', 'src/supervise.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
});
