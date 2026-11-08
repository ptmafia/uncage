import { defineConfig } from 'tsup';

export default defineConfig({
  // The stdio MCP bridge is a standalone script run by ACP agents without HTTP MCP (see site-mcp.ts).
  entry: { index: 'src/index.ts', 'mcp-stdio-bridge': 'src/mcp-stdio-bridge.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  target: 'node22',
});
