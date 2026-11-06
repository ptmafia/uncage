import { runAdapterContract } from './contract.js';
import { createFakeAdapter, type FakeStep } from './fake-adapter.js';

const approvalInput = {
  category: 'shell' as const,
  title: 'Run ls',
  target: { command: 'ls' },
};

const scripts: Record<string, FakeStep[]> = {
  simple: [
    { text: 'Hello from the fake adapter', chunks: 3, delayMs: 1 },
    { tool: { name: 'read', title: 'Read file', category: 'file', output: 'ok' } },
  ],
  approval: [{ approval: approvalInput }, { text: 'done' }],
  crash: [{ text: 'partial' }, { crash: 'boom' }],
};

runAdapterContract('fake', () => createFakeAdapter({ script: (input) => scripts[input.prompt] ?? [] }), {
  simple: 'simple',
  approval: 'approval',
  crash: 'crash',
});
