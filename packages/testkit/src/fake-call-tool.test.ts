import type { AdapterRunInput, RunTool, RuntimeEvent, ToolCallResult } from '@uncage/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdapter } from './fake-adapter.js';

const base: AdapterRunInput = {
  runId: 'run_1',
  prompt: 'p',
  cwd: '/tmp',
  settings: { permissionMode: 'default' },
  attachments: [],
};

const tool = (name: string, call: (args: unknown) => Promise<ToolCallResult>): RunTool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  requiresConfirmation: false,
  call,
});

async function reply(input: AdapterRunInput, name: string, args: unknown = {}): Promise<string[]> {
  const adapter = createFakeAdapter({ script: [{ callTool: { name, args } }] });
  const events: RuntimeEvent[] = [];
  const ctx = { signal: new AbortController().signal, requestApproval: () => Promise.reject(new Error('unused')) };
  for await (const e of adapter.run(input, ctx)) events.push(e);
  expect(events.at(-1)).toEqual({ type: 'run.completed' });
  return events.flatMap((e) => (e.type === 'message.completed' ? [e.text] : []));
}

describe('fake adapter callTool step', () => {
  it('calls the named run tool and replies with its result as text', async () => {
    const call = vi.fn(() =>
      Promise.resolve<ToolCallResult>({ content: [{ type: 'text', text: 'hi' }, { type: 'json', json: { n: 1 } }] }),
    );
    expect(await reply({ ...base, tools: [tool('other', call), tool('greet', call)] }, 'greet', { who: 'x' })).toEqual([
      'hi\n{"n":1}',
    ]);
    expect(call).toHaveBeenCalledWith({ who: 'x' });
  });

  it('reports unknown tools, thrown errors and isError results as text', async () => {
    expect(await reply(base, 'missing')).toEqual(['tool error: unknown tool missing']);
    const boom = tool('boom', () => Promise.reject(new Error('nope')));
    expect(await reply({ ...base, tools: [boom] }, 'boom')).toEqual(['tool error: nope']);
    const bad = tool('bad', () => Promise.resolve({ content: [{ type: 'text', text: 'denied' }], isError: true }));
    expect(await reply({ ...base, tools: [bad] }, 'bad')).toEqual(['tool error: denied']);
  });
});
