/**
 * The Uncage daemon the mock E2E runs against: real core + real server over a fake "Claude Code"
 * runtime whose script is picked by the prompt's first word. Started (and restarted) as a child
 * process by mock-supervisor.ts; env MOCK_PORT and MOCK_DATA_DIR are required, MOCK_ALLOW_BYPASS=1
 * turns on `security.allowBypass`. The fake runtime advertises the composer's controls (models,
 * efforts, every permission mode, image + file attachments); the `echo` prompt replies with the
 * settings and attachment names the run received.
 */
import { createUncage } from '@uncage/core';
import { ATTACHMENT_LIMITS, type AdapterRunInput, type RuntimeCapabilities } from '@uncage/protocol';
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
  echo: [{ echo: true }],
};

/** What the composer reads; core drops `bypassPermissions` unless allowBypass is on. */
export const MOCK_CAPABILITIES: Partial<RuntimeCapabilities> = {
  models: [
    { id: 'default', label: 'Default', description: 'The runtime default' },
    { id: 'fake-opus', label: 'Fake Opus', description: 'Most capable fake model' },
    { id: 'fake-haiku', label: 'Fake Haiku', description: 'Fastest fake model' },
  ],
  modelsAuthoritative: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes, maxImageBytes: 5 * 1024 * 1024 },
};

export const byPrompt = (input: AdapterRunInput): FakeStep[] =>
  SCRIPTS[input.prompt.trim().split(/\s+/)[0]?.toLowerCase() ?? ''] ?? [{ text: `Echo: ${input.prompt}` }];

const port = Number(process.env.MOCK_PORT);
const dataDir = process.env.MOCK_DATA_DIR;
const allowBypass = process.env.MOCK_ALLOW_BYPASS === '1';
if (!port || !dataDir) throw new Error('mock-server: MOCK_PORT and MOCK_DATA_DIR are required');

const uncage = await createUncage({
  adapters: [createFakeAdapter({ id: 'claude', displayName: 'Claude Code', script: byPrompt, capabilities: MOCK_CAPABILITIES })],
  dataDir,
  workspace: { allowedRoots: [dataDir], default: dataDir },
  security: { allowBypass },
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
