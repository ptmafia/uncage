import { describe, expect, it } from 'vitest';
import { applyEvent, initialSessionState } from './apply-event.js';
import type { SessionState } from './state.js';
import { approval, eventFactory, run, snapshot } from './test-fixtures.js';
import type { UncageEvent } from '@uncage/protocol';

const reduce = (events: UncageEvent[], s: SessionState = initialSessionState(snapshot())) =>
  events.reduce(applyEvent, s);

describe('applyEvent', () => {
  it('duplicate sequence ignored (T03)', () => {
    const ev = eventFactory();
    const started = ev('run.started', { run: run() });
    const msg = ev('message.started', { messageId: 'm1', role: 'assistant' });
    const delta = ev('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'Hi' });
    const once = reduce([started, msg, delta]);
    const replayed = reduce([started, msg, delta, msg, delta], once);
    expect(applyEvent(once, delta)).toBe(once);
    expect(replayed).toBe(once);
    expect(replayed.messages.m1!.text).toBe('Hi');
    expect(replayed.timeline).toEqual([
      { kind: 'message', id: 'user_run_1' },
      { kind: 'message', id: 'm1' },
    ]);
    expect(replayed.lastSequence).toBe(3);
  });

  it('deltas concatenate in chunk order even if delivered out of order', () => {
    const ev = eventFactory();
    const s = reduce([
      ev('run.started', { run: run() }),
      ev('message.started', { messageId: 'm1', role: 'assistant' }),
      ev('message.delta', { messageId: 'm1', chunkIndex: 2, text: 'C' }),
      ev('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'A' }),
    ]);
    expect(s.messages.m1!.text).toBe('A');
    const s2 = reduce([ev('message.delta', { messageId: 'm1', chunkIndex: 1, text: 'B' })], s);
    expect(s2.messages.m1!.text).toBe('ABC');
    expect(s2.messages.m1!.streaming).toBe(true);
    const s3 = reduce([ev('message.completed', { messageId: 'm1', text: 'ABC!' })], s2);
    expect(s3.messages.m1).toMatchObject({ text: 'ABC!', streaming: false, endedAt: expect.any(String) });
  });

  it('tools grouped per run between messages', () => {
    const ev = eventFactory();
    const tool = (toolId: string) =>
      ev('tool.started', { toolId, name: 'Bash', title: `run ${toolId}`, category: 'shell' });
    const s = reduce([
      ev('run.started', { run: run() }),
      tool('t1'),
      tool('t2'),
      ev('tool.completed', { toolId: 't1', output: 'ok', durationMs: 5 }),
      ev('message.started', { messageId: 'm1', role: 'assistant' }),
      tool('t3'),
      ev('approval.requested', { approval: approval({ toolId: 't3' }) }),
      tool('t4'),
      ev('run.started', { run: run({ id: 'run_2', createdAt: '2026-11-06T00:01:00.000Z' }) }, 'run_2'),
      ev('tool.started', { toolId: 't5', name: 'Read', title: 'read', category: 'file' }, 'run_2'),
    ]);
    expect(s.timeline).toEqual([
      { kind: 'message', id: 'user_run_1' },
      { kind: 'tools', runId: 'run_1', toolIds: ['t1', 't2'] },
      { kind: 'message', id: 'm1' },
      { kind: 'tools', runId: 'run_1', toolIds: ['t3'] },
      { kind: 'approval', id: 'apr_1' },
      { kind: 'tools', runId: 'run_1', toolIds: ['t4'] },
      { kind: 'message', id: 'user_run_2' },
      { kind: 'tools', runId: 'run_2', toolIds: ['t5'] },
    ]);
    expect(s.tools.t1).toMatchObject({ status: 'completed', output: 'ok', durationMs: 5, runId: 'run_1' });
    expect(s.tools.t2!.status).toBe('running');
    expect(s.messages.user_run_2).toMatchObject({ role: 'user', text: 'hello', runId: 'run_2' });
  });

  it('approval.resolved leaves tool running', () => {
    const ev = eventFactory();
    const s = reduce([
      ev('run.started', { run: run() }),
      ev('tool.started', { toolId: 'tool_1', name: 'Bash', title: 'ls', category: 'shell' }),
      ev('approval.requested', { approval: approval() }),
      ev('approval.resolved', { approval: approval({ state: 'approved', decision: 'allow', version: 2 }) }),
    ]);
    expect(s.tools.tool_1!.status).toBe('running');
    expect(s.approvals.apr_1).toMatchObject({ state: 'approved', version: 2 });
    // A stale (lower-version) update is ignored and the timeline holds the approval once.
    const s2 = reduce([ev('approval.updated', { approval: approval() })], s);
    expect(s2.approvals.apr_1!.state).toBe('approved');
    expect(s2.timeline.filter((i) => i.kind === 'approval')).toHaveLength(1);
  });

  it('tool.failed with declined marks the tool declined', () => {
    const ev = eventFactory();
    const s = reduce([
      ev('run.started', { run: run() }),
      ev('tool.started', { toolId: 't1', name: 'Bash', title: 'ls', category: 'shell' }),
      ev('tool.updated', { toolId: 't1', output: 'a' }),
      ev('tool.updated', { toolId: 't1', output: 'b' }),
      ev('tool.failed', { toolId: 't1', error: 'user declined', declined: true }),
    ]);
    expect(s.tools.t1).toMatchObject({ status: 'declined', output: 'ab', error: 'user declined' });
  });

  it('run.interrupted marks streaming messages done', () => {
    const ev = eventFactory();
    const s = reduce([
      ev('run.started', { run: run() }),
      ev('run.updated', { runId: 'run_1', state: 'running' }),
      ev('message.started', { messageId: 'm1', role: 'assistant' }),
      ev('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'part' }),
      ev('tool.started', { toolId: 't1', name: 'Bash', title: 'ls', category: 'shell' }),
      ev('run.interrupted', { runId: 'run_1', reason: 'server_restart' }),
    ]);
    expect(s.runs.run_1).toMatchObject({ state: 'interrupted', endedAt: expect.any(String) });
    expect(s.messages.m1).toMatchObject({ streaming: false, text: 'part' });
    expect(s.tools.t1!.status).toBe('failed');
    // A replayed earlier state never resurrects a terminal run.
    const s2 = reduce([ev('run.updated', { runId: 'run_1', state: 'running' })], s);
    expect(s2.runs.run_1!.state).toBe('interrupted');
  });

  it('an unknown (newer) event type leaves the state intact and only advances lastSequence', () => {
    const ev = eventFactory();
    const before = reduce([ev('run.started', { run: run({ state: 'running' }) })]);
    const unknown = { ...ev('run.cancelled', { runId: 'run_1' }), type: 'future.thing', payload: { x: 1 } } as unknown as UncageEvent;
    const after = applyEvent(before, unknown);
    expect(after).toEqual({ ...before, lastSequence: unknown.sequence });
    expect(after.session).toBe(before.session);
  });

  it('initialSessionState seeds runs, user prompts and pending approvals from the snapshot', () => {
    const s = initialSessionState(
      snapshot({
        runs: [run({ state: 'waiting_approval' })],
        pendingApprovals: [approval()],
        lastSequence: 7,
      }),
    );
    expect(s.lastSequence).toBe(7);
    expect(s.connection).toBe('connecting');
    expect(s.timeline).toEqual([
      { kind: 'message', id: 'user_run_1' },
      { kind: 'approval', id: 'apr_1' },
    ]);
  });

  it('system.warning is kept as lastWarning with its run', () => {
    const ev = eventFactory();
    const s = reduce([
      ev('run.started', { run: run() }),
      ev('system.warning', { code: 'setting_reset', message: 'The runtime no longer supports the selected model.' }),
    ]);
    expect(s.lastWarning).toEqual({
      code: 'setting_reset',
      message: 'The runtime no longer supports the selected model.',
      runId: 'run_1',
    });
  });

  it('a system.warning without a run is tagged with the latest run at the time', () => {
    const ev = eventFactory();
    const w = ev('system.warning', { code: 'setting_reset', message: 'm' });
    const s = reduce([ev('run.started', { run: run() }), { ...w, sequence: 5, runId: undefined } as UncageEvent]);
    expect(s.lastWarning).toEqual({ code: 'setting_reset', message: 'm', runId: 'run_1' });
    const none = reduce([{ ...w, runId: undefined } as UncageEvent]);
    expect(none.lastWarning).toEqual({ code: 'setting_reset', message: 'm' });
  });
});
