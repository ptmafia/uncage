import { defineConfig } from 'tsup';

export default defineConfig({
  // The fake app-server and fake ACP agent are standalone executables; esbuild keeps its `#!/usr/bin/env node` line.
  entry: { index: 'src/index.ts', 'fake-codex': 'src/fake-codex/server.ts', 'fake-acp': 'src/fake-acp/server.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  target: 'node22',
});
