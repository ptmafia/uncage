/**
 * The Uncage daemon the mock E2E runs against: real core + real server over a fake "Claude Code"
 * runtime whose script is picked by the prompt's first word. Started (and restarted) as a child
 * process by mock-supervisor.ts; env MOCK_PORT and MOCK_DATA_DIR are required.
 */
import { createUncage } from '@uncage/core';
import type { AdapterRunInput } from '@uncage/protocol';
import { createUncageServer } from '@uncage/server';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';

export const MOCK_TOKEN = 'test-token';

const SCRIPTS: Record<string, FakeStep[]> = {
  simple: [{ text: '你好，我是模拟运行时。Streaming works end to end.', chunks: 6, delayMs: 40 }],
  approval: [
    {
      approval: { category: 'shell', title: 'echo hi', description: 'Print a greeting', target: { command: 'echo hi' } },
      onDeny: 'continue',
    },
    { text: 'All done.' },
  ],
  slow: [{ text: 'Working on it…' }, { waitMs: 60_000 }, { text: 'Finished.' }],
  crash: [{ text: 'Starting up…' }, { crash: 'runtime_disconnected' }],
};

export const byPrompt = (input: AdapterRunInput): FakeStep[] =>
  SCRIPTS[input.prompt.trim().split(/\s+/)[0]?.toLowerCase() ?? ''] ?? [{ text: `Echo: ${input.prompt}` }];

const port = Number(process.env.MOCK_PORT);
const dataDir = process.env.MOCK_DATA_DIR;
if (!port || !dataDir) throw new Error('mock-server: MOCK_PORT and MOCK_DATA_DIR are required');

const uncage = await createUncage({
  adapters: [createFakeAdapter({ id: 'claude', displayName: 'Claude Code', script: byPrompt })],
  dataDir,
  workspace: { allowedRoots: [dataDir], default: dataDir },
});
const server = await createUncageServer({ uncage, token: MOCK_TOKEN, port });
const url = await server.listen();
process.stdout.write(`ready ${url}\n`);

const stop = async (): Promise<void> => {
  await server.close();
  await uncage.close();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
