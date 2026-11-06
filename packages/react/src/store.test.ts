import { describe, expect, it, vi } from 'vitest';
import { createUncageStore } from './store.js';
import { approval, clientError, eventFactory, fakeClient, run, snapshot } from './test-fixtures.js';

describe('createUncageStore', () => {
  it('selectSession replays history from sequence 0 on top of the snapshot', async () => {
    const f = fakeClient(() => snapshot({ runs: [run({ state: 'completed' })], lastSequence: 3 }));
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    expect(f.client.subscribe).toHaveBeenCalledWith('ses_1', expect.objectContaining({ after: 0 }));
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run() }));
    f.emit(ev('message.completed', { messageId: 'm1', text: 'done' }));
    f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 }));
    const active = store.getState().active!;
    expect(active.timeline).toEqual([
      { kind: 'message', id: 'user_run_1' },
      { kind: 'message', id: 'm1' },
    ]);
    expect(active.runs.run_1!.state).toBe('completed');
    f.state('live');
    expect(store.getState().active!.connection).toBe('live');
  });

  it('sendPrompt while active is a no-op (no duplicate run)', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    // Two rapid sends: the second must not POST while the first is in flight.
    await Promise.all([store.actions.sendPrompt('one'), store.actions.sendPrompt('two')]);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    // The run returned by startRun is visible before run.started arrives.
    expect(store.getState().active!.runs.run_1).toMatchObject({ prompt: 'one', state: 'queued' });
    expect(store.getState().active!.messages.user_run_1!.text).toBe('one');
    await store.actions.sendPrompt('three');
    expect(f.client.startRun).toHaveBeenCalledTimes(1);

    // run.started for the same run does not duplicate the user message.
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run({ prompt: 'one' }) }));
    expect(store.getState().active!.timeline).toEqual([{ kind: 'message', id: 'user_run_1' }]);

    f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 }));
    await store.actions.sendPrompt('four');
    expect(f.client.startRun).toHaveBeenCalledTimes(2);
  });

  it('decide 409 treated as resolved and snapshot reloaded', async () => {
    let snap = snapshot({ runs: [run({ state: 'waiting_approval' })], pendingApprovals: [approval()], lastSequence: 2 });
    const f = fakeClient(() => snap);
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    let release!: () => void;
    f.client.decide.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      throw clientError('approval_already_resolved', 409);
    });
    snap = snapshot({ runs: [run({ state: 'running' })], pendingApprovals: [], lastSequence: 4 });
    const pending = store.actions.decide('apr_1', 'allow');
    expect(store.getState().pendingDecisions).toEqual({ apr_1: 'allow' });
    // A second click while in flight does not send a second decision.
    await store.actions.decide('apr_1', 'deny');
    expect(f.client.decide).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(f.client.decide).toHaveBeenCalledWith('apr_1', { decision: 'allow', scope: 'once' });
    expect(f.client.snapshot).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingDecisions).toEqual({});
    expect(store.getState().lastError).toBeUndefined();
    expect(store.getState().active!.runs.run_1!.state).toBe('running');
  });

  it('decide 410 marks the approval expired', async () => {
    const f = fakeClient(() => snapshot({ pendingApprovals: [approval()] }));
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    f.client.decide.mockRejectedValueOnce(clientError('approval_expired', 410));
    await store.actions.decide('apr_1', 'allow');
    expect(store.getState().active!.approvals.apr_1!.state).toBe('expired');
    expect(store.getState().lastError).toBeUndefined();
    expect(store.getState().pendingDecisions).toEqual({});
  });

  it('replay_unavailable → reload snapshot, replayIncomplete true', async () => {
    const f = fakeClient(() =>
      snapshot({ runs: [run({ state: 'completed' })], pendingApprovals: [], lastSequence: 40 }),
    );
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    f.fail(clientError('event_replay_unavailable', 200));
    await vi.waitFor(() => expect(f.client.subscribe).toHaveBeenCalledTimes(2));
    expect(f.client.snapshot).toHaveBeenCalledTimes(2);
    expect(f.client.subscribe).toHaveBeenLastCalledWith('ses_1', expect.objectContaining({ after: 40 }));
    const active = store.getState().active!;
    expect(active.replayIncomplete).toBe(true);
    expect(active.lastSequence).toBe(40);
    expect(active.timeline).toEqual([{ kind: 'message', id: 'user_run_1' }]);
    expect(store.getState().lastError).toBeUndefined();
  });

  it('other terminal stream errors set lastError without resubscribing', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    f.fail(clientError('not_found', 404));
    expect(store.getState().lastError?.code).toBe('not_found');
    expect(store.getState().active!.connection).toBe('offline');
    expect(f.client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('switching sessions closes the previous subscription', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    await store.actions.selectSession('ses_2');
    expect(f.subs[0]!.closed).toBe(true);
    expect(store.getState().activeSessionId).toBe('ses_2');
  });
});

