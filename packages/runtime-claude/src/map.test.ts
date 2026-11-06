import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { RuntimeEventSchema, type RuntimeEvent } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import executionError from './fixtures/execution-error.json' with { type: 'json' };
import toolError from './fixtures/tool-error.json' with { type: 'json' };
import unknown from './fixtures/unknown.json' with { type: 'json' };
import { categorize, createMapper, DENIED_MESSAGE } from './map.js';
import { FIXTURES, fixture } from './test-utils.js';

const mapAll = (messages: SDKMessage[], denials?: Map<string, string>): RuntimeEvent[] => {
  const map = createMapper(denials);
  const events = messages.flatMap((m) => map(m));
  for (const e of events) expect(RuntimeEventSchema.safeParse(e).success).toBe(true);
  return events;
};

describe('createMapper', () => {
  it('init → native.session', () => {
    const events = mapAll(FIXTURES.text);
    const sessions = events.filter((e) => e.type === 'native.session');
    expect(sessions).toEqual([{ type: 'native.session', ref: '5f1c2b9e-8a3d-4c7e-9b1a-2d6f0e4c8a17' }]);
  });

  it('emits native.session only once per run', () => {
    const init = FIXTURES.text.find((m) => m.type === 'system' && m.subtype === 'init')!;
    expect(mapAll([init, init]).filter((e) => e.type === 'native.session')).toHaveLength(1);
  });

  it('text deltas concatenate', () => {
    const events = mapAll(FIXTURES.text);
    expect(events).toEqual([
      { type: 'native.session', ref: '5f1c2b9e-8a3d-4c7e-9b1a-2d6f0e4c8a17' },
      { type: 'message.started', messageId: 'msg_01Text' },
      { type: 'message.delta', messageId: 'msg_01Text', text: 'Hello' },
      { type: 'message.delta', messageId: 'msg_01Text', text: ', ' },
      { type: 'message.delta', messageId: 'msg_01Text', text: 'world!' },
      { type: 'message.completed', messageId: 'msg_01Text', text: 'Hello, world!' },
      { type: 'run.completed' },
    ]);
  });

  it('tool_use/tool_result pair → started/completed same toolId', () => {
    const events = mapAll(FIXTURES.toolWrite);
    const started = events.find((e) => e.type === 'tool.started');
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(started).toMatchObject({
      toolId: 'toolu_01WriteHello',
      name: 'Write',
      title: '/tmp/uncage-fixture/hello.txt',
      category: 'file',
      input: { file_path: '/tmp/uncage-fixture/hello.txt', content: 'hi' },
    });
    expect(completed).toMatchObject({
      toolId: 'toolu_01WriteHello',
      output: 'File created successfully at: /tmp/uncage-fixture/hello.txt',
    });
    // A tool-only message with no text is never completed; the follow-up text message is.
    expect(events.filter((e) => e.type === 'message.completed')).toEqual([
      { type: 'message.completed', messageId: 'msg_02Done', text: 'Created hello.txt.' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'run.completed' });
  });

  it('is_error result → tool.failed', () => {
    const events = mapAll(fixture(toolError));
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({
      toolId: 'toolu_01BashFail',
      title: 'cat missing.txt',
      category: 'shell',
    });
    expect(events.find((e) => e.type === 'tool.failed')).toEqual({
      type: 'tool.failed',
      toolId: 'toolu_01BashFail',
      error: 'cat: missing.txt: No such file or directory\nExit code 1',
    });
    expect(events.some((e) => e.type === 'tool.completed')).toBe(false);
  });

  it('tool_result carrying the deny message we sent → tool.failed declined', () => {
    const denied = (content: string): SDKMessage[] =>
      FIXTURES.toolWrite.map((m) =>
        m.type === 'user'
          ? ({
              ...m,
              message: {
                ...m.message,
                content: [{ type: 'tool_result', tool_use_id: 'toolu_01WriteHello', content, is_error: true }],
              },
            } as SDKMessage)
          : m,
      );
    const failed = (events: RuntimeEvent[]) => events.find((e) => e.type === 'tool.failed');
    expect(failed(mapAll(denied(DENIED_MESSAGE)))).toMatchObject({ declined: true });
    const reasons = new Map([['toolu_01WriteHello', 'Not in this repo']]);
    expect(failed(mapAll(denied('Not in this repo'), reasons))).toMatchObject({ declined: true });
    expect(failed(mapAll(denied('Permission to use Write has been denied.')))).not.toHaveProperty('declined');
  });

  it('long Bash commands are truncated to 80 chars in the title', () => {
    const cmd = 'echo ' + 'x'.repeat(200);
    const msgs = fixture(toolError).map((m) =>
      m.type === 'assistant'
        ? ({
            ...m,
            message: { ...m.message, content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: cmd } }] },
          } as SDKMessage)
        : m,
    );
    const started = mapAll(msgs).find((e) => e.type === 'tool.started');
    expect(started).toMatchObject({ title: cmd.slice(0, 80) });
  });

  it('auth error → run.failed auth_required', () => {
    const events = mapAll(FIXTURES.authError);
    expect(events.at(-1)).toEqual({
      type: 'run.failed',
      error: {
        code: 'auth_required',
        message: 'Not logged in · Please run /login',
        hint: 'Run `claude` and log in',
        retryable: false,
      },
    });
    expect(events.filter((e) => e.type === 'run.failed' || e.type === 'run.completed')).toHaveLength(1);
  });

  it('result error subtype → run.failed internal_error', () => {
    const last = mapAll(fixture(executionError)).at(-1);
    expect(last).toMatchObject({
      type: 'run.failed',
      error: { code: 'internal_error', message: 'Claude Code process exited with code 1', retryable: false },
    });
  });

  it('unknown message types ignored', () => {
    expect(mapAll(fixture(unknown))).toEqual([]);
  });

  it('subagent stream events do not interleave with the main message', () => {
    const sub = FIXTURES.text
      .filter((m) => m.type === 'stream_event')
      .map((m) => ({ ...m, parent_tool_use_id: 'toolu_task' }) as SDKMessage);
    expect(mapAll(sub)).toEqual([]);
  });
});

describe('categorize', () => {
  it.each([
    ['Bash', 'shell'],
    ['Write', 'file'],
    ['Edit', 'file'],
    ['MultiEdit', 'file'],
    ['NotebookEdit', 'file'],
    ['WebFetch', 'network'],
    ['WebSearch', 'network'],
    ['mcp__github__create_issue', 'mcp'],
    ['Read', 'other'],
    ['Task', 'other'],
  ])('%s → %s', (tool, category) => {
    expect(categorize(tool)).toBe(category);
  });
});
