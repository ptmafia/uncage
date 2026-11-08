import { build } from 'tsup';

/** Tests run from src/, but agents spawn the built stdio bridge: build it first. */
export default async function setup(): Promise<void> {
  await build({
    config: false,
    entry: { 'mcp-stdio-bridge': 'src/mcp-stdio-bridge.ts' },
    format: ['esm'],
    outDir: 'dist',
    clean: false,
    dts: false,
    silent: true,
    target: 'node22',
  });
  // process.test.ts runs startAcpProcess in a child Node process that then calls process.exit().
  await build({
    config: false,
    entry: { process: 'src/process.ts' },
    format: ['esm'],
    outDir: 'node_modules/.cache/uncage-acp-test',
    clean: false,
    dts: false,
    silent: true,
    target: 'node22',
  });
}
