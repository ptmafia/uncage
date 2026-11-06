import { defineConfig } from 'tsup';

export default defineConfig({
  // The fake app-server is a standalone executable; esbuild keeps its `#!/usr/bin/env node` line.
  entry: { index: 'src/index.ts', 'fake-codex': 'src/fake-codex/server.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  target: 'node22',
});
