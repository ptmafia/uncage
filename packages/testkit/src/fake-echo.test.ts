import type { AdapterRunInput, RuntimeEvent } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeAdapter, describeRunInput } from './fake-adapter.js';

const base: AdapterRunInput = {
  runId: 'run_1',
  prompt: 'echo',
  cwd: '/tmp',
  settings: { permissionMode: 'default' },
  attachments: [],
};

const attachment = (name: string, kind: 'image' | 'file') => ({
  id: `att_${name}`,
  sessionId: 'ses_1',
  name,
  mime: kind === 'image' ? 'image/png' : 'text/markdown',
  size: 1,
  kind,
  sha256: 'x',
  createdAt: new Date(0).toISOString(),
  absPath: `/tmp/${name}`,
});

async function completedText(input: AdapterRunInput): Promise<string> {
  const adapter = createFakeAdapter({ script: [{ echo: true }] });
  const events: RuntimeEvent[] = [];
  const ctx = { signal: new AbortController().signal, requestApproval: () => Promise.reject(new Error('unused')) };
  for await (const e of adapter.run(input, ctx)) events.push(e);
  expect(events.at(-1)).toEqual({ type: 'run.completed' });
  const done = events.find((e) => e.type === 'message.completed');
  return done && done.type === 'message.completed' ? done.text : '';
}

describe('fake adapter echo step', () => {
  it('echoes the received settings and attachment names', async () => {
    const text = await completedText({
      ...base,
      settings: { model: 'fake-opus', effort: 'low', permissionMode: 'plan' },
      attachments: [attachment('a.png', 'image'), attachment('b.md', 'file')],
    });
    expect(text).toBe('settings: model=fake-opus effort=low mode=plan; attachments: a.png,b.md');
  });

  it('uses "-" for unset values and no attachments', async () => {
    expect(await completedText(base)).toBe('settings: model=- effort=- mode=default; attachments: -');
    expect(describeRunInput(base)).toBe('settings: model=- effort=- mode=default; attachments: -');
  });
});
