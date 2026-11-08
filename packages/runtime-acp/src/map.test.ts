import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { approvalInput, chooseOption, createAcpMapper, toolCategory } from './map.js';

const mapper = () => {
  let n = 0;
  return createAcpMapper(() => `id_${++n}`);
};
const chunk = (text: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  ...(messageId ? { messageId } : {}),
});

describe('toolCategory', () => {
  it.each([
    ['execute', 'shell'],
    ['read', 'file'],
    ['edit', 'file'],
    ['delete', 'file'],
    ['move', 'file'],
    ['search', 'file'],
    ['fetch', 'network'],
    ['think', 'other'],
    ['switch_mode', 'other'],
    ['other', 'other'],
    [undefined, 'other'],
    [null, 'other'],
  ] as const)('%s → %s', (kind, category) => {
    expect(toolCategory(kind)).toBe(category);
  });
});

describe('createAcpMapper', () => {
  it('opens a message on the first chunk, appends deltas, and closes it at the end of the turn', () => {
    const m = mapper();
    expect([...m.update(chunk('Hel')), ...m.update(chunk('lo')), ...m.finish('end_turn')]).toEqual([
      { type: 'message.started', messageId: 'id_1' },
      { type: 'message.delta', messageId: 'id_1', text: 'Hel' },
      { type: 'message.delta', messageId: 'id_1', text: 'lo' },
      { type: 'message.completed', messageId: 'id_1', text: 'Hello' },
      { type: 'run.completed' },
    ]);
  });

  it('a new messageId closes the open message; a reused id gets a fresh one', () => {
    const m = mapper();
    const events = [...m.update(chunk('a', 'm1')), ...m.update(chunk('b', 'm2')), ...m.update(chunk('c', 'm1')), ...m.flush()];
    expect(events.filter((e) => e.type === 'message.completed')).toEqual([
      { type: 'message.completed', messageId: 'm1', text: 'a' },
      { type: 'message.completed', messageId: 'm2', text: 'b' },
      { type: 'message.completed', messageId: 'id_1', text: 'c' },
    ]);
  });

  it('drops thoughts, user chunks, usage, commands, notices and mode updates', () => {
    const m = mapper();
    const dropped: SessionUpdate[] = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
      { sessionUpdate: 'usage_update', used: 1, size: 2 },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'x' },
    ];
    expect(dropped.flatMap((u) => m.update(u))).toEqual([]);
  });

  it('maps a tool call lifecycle; a duplicate tool_call id is an update', () => {
    const m = mapper();
    const events = [
      ...m.update(chunk('before')),
      ...m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', rawInput: { command: 'ls' } }),
      ...m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] }),
      ...m.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'diff', path: '/w/a.txt', oldText: 'x\n', newText: 'y\n' }, { type: 'terminal', terminalId: 'term' }],
      }),
    ];
    expect(events).toEqual([
      { type: 'message.started', messageId: 'id_1' },
      { type: 'message.delta', messageId: 'id_1', text: 'before' },
      { type: 'message.completed', messageId: 'id_1', text: 'before' },
      { type: 'tool.started', toolId: 't1', name: 'execute', title: 'ls', category: 'shell', input: { command: 'ls' } },
      { type: 'tool.updated', toolId: 't1', output: 'a.txt' },
      { type: 'tool.completed', toolId: 't1', output: '/w/a.txt\n-x\n+y' },
    ]);
  });

  it('a failed tool is tool.failed, declined when the user rejected it; an unknown update id starts the tool', () => {
    const m = mapper();
    m.markDeclined('t2');
    expect([
      ...m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', title: 'Write', kind: 'edit', status: 'failed' }),
      ...m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' }),
    ]).toEqual([
      { type: 'tool.started', toolId: 't2', name: 'edit', title: 'Write', category: 'file' },
      { type: 'tool.failed', toolId: 't2', error: 'Declined', declined: true },
    ]);
    expect(m.update({ sessionUpdate: 'tool_call', toolCallId: 't3', title: 'x', name: 'mcp__x', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] })).toEqual([
      { type: 'tool.started', toolId: 't3', name: 'mcp__x', title: 'x', category: 'other' },
      { type: 'tool.failed', toolId: 't3', error: 'boom' },
    ]);
  });

  it('a plan is one synthetic step: started, updated, completed by the next message', () => {
    const m = mapper();
    const plan = (s: 'pending' | 'completed'): SessionUpdate => ({
      sessionUpdate: 'plan',
      entries: [
        { content: 'read', priority: 'high', status: 'completed' },
        { content: 'write', priority: 'low', status: s },
      ],
    });
    expect([...m.update(plan('pending')), ...m.update(plan('completed')), ...m.update(chunk('ok'))].slice(0, 4)).toEqual([
      { type: 'tool.started', toolId: 'plan_id_1', name: 'plan', title: 'Plan', category: 'other' },
      { type: 'tool.updated', toolId: 'plan_id_1', output: '- [x] read\n- [x] write' },
      { type: 'tool.completed', toolId: 'plan_id_1', output: '- [x] read\n- [x] write' },
      { type: 'message.started', messageId: 'id_2' },
    ]);
  });

  it.each([
    ['max_tokens', [{ type: 'warning', code: 'acp_max_tokens', message: expect.any(String) }, { type: 'run.completed' }]],
    ['max_turn_requests', [{ type: 'warning', code: 'acp_max_turn_requests', message: expect.any(String) }, { type: 'run.completed' }]],
    ['refusal', [{ type: 'warning', code: 'acp_refusal', message: expect.any(String) }, { type: 'run.completed' }]],
    ['cancelled', [{ type: 'run.interrupted', reason: 'aborted' }]],
    ['end_turn', [{ type: 'run.completed' }]],
  ] as const)('stop reason %s', (stop, expected) => {
    expect(mapper().finish(stop)).toEqual(expected);
  });
});

describe('approvals', () => {
  const options = [
    { optionId: 'a1', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'aa', name: 'Always', kind: 'allow_always' as const },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const },
    { optionId: 'ra', name: 'Never', kind: 'reject_always' as const },
  ];

  it('chooses allow_once / reject_once and never an "always" option', () => {
    expect(chooseOption(options, { decision: 'allow' })).toEqual({ outcome: 'selected', optionId: 'a1' });
    expect(chooseOption(options, { decision: 'deny' })).toEqual({ outcome: 'selected', optionId: 'r1' });
    expect(chooseOption(options, { decision: 'expired' })).toEqual({ outcome: 'selected', optionId: 'r1' });
    expect(chooseOption(options, { decision: 'cancelled' })).toEqual({ outcome: 'cancelled' });
    expect(chooseOption([options[1]!, options[3]!], { decision: 'allow' })).toEqual({ outcome: 'cancelled' });
    expect(chooseOption([options[1]!, options[3]!], { decision: 'deny' })).toEqual({ outcome: 'cancelled' });
  });

  it('builds the approval input from the tool call and what the mapper knows', () => {
    const m = mapper();
    m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'git push', kind: 'execute', rawInput: { command: 'git push' } });
    expect(approvalInput({ toolCallId: 't1' }, m.tool('t1'), '/w')).toEqual({
      toolId: 't1',
      category: 'shell',
      title: 'git push',
      availableDecisions: ['allow_once', 'deny'],
      target: { command: 'git push', cwd: '/w' },
    });
    expect(approvalInput({ toolCallId: 't2', title: 'Edit a.txt', kind: 'edit', locations: [{ path: '/w/a.txt' }] }, undefined, '/w')).toMatchObject({
      category: 'file',
      title: 'Edit a.txt',
      target: { path: '/w/a.txt' },
    });
    expect(approvalInput({ toolCallId: 't3', kind: 'fetch', rawInput: { url: 'https://example.com/x' } }, undefined, '/w')).toMatchObject({
      category: 'network',
      title: 'Tool',
      target: { host: 'example.com' },
    });
  });
});
