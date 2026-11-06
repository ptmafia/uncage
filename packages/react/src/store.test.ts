import type { Attachment, RuntimeCapabilities, SessionSettings, UncageEvent } from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createUncageStore } from './store.js';
import { approval, clientError, eventFactory, fakeClient, run, session, snapshot, T0 } from './test-fixtures.js';

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
    expect(await Promise.all([store.actions.sendPrompt('one'), store.actions.sendPrompt('two')])).toEqual([true, false]);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    // The run returned by startRun is visible before run.started arrives.
    expect(store.getState().active!.runs.run_1).toMatchObject({ prompt: 'one', state: 'queued' });
    expect(store.getState().active!.messages.user_run_1!.text).toBe('one');
    expect(await store.actions.sendPrompt('three')).toBe(false);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);

    // run.started for the same run does not duplicate the user message.
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run({ prompt: 'one' }) }));
    expect(store.getState().active!.timeline).toEqual([{ kind: 'message', id: 'user_run_1' }]);

    f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 }));
    expect(await store.actions.sendPrompt('four')).toBe(true);
    expect(f.client.startRun).toHaveBeenCalledTimes(2);
  });

  it('sendPrompt resolves false and records lastError when startRun fails, or with no session', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    expect(await store.actions.sendPrompt('no session')).toBe(false);
    await store.actions.selectSession('ses_1');
    f.client.startRun.mockRejectedValueOnce(clientError('session_busy', 409));
    expect(await store.actions.sendPrompt('x')).toBe(false);
    expect(store.getState().lastError?.code).toBe('session_busy');
    expect(await store.actions.sendPrompt('y')).toBe(true);
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
    // The live stream owns runs: the snapshot reload does not overwrite them. The approval stays
    // `pending` locally until the stream delivers `approval.resolved`.
    expect(store.getState().active!.runs.run_1!.state).toBe('waiting_approval');
    expect(store.getState().active!.approvals.apr_1!.state).toBe('pending');
  });

  it('decide 409 with a live stream: snapshot ahead does not drop events, snapshot behind does not regress', async () => {
    let snap = snapshot({ runs: [run({ state: 'waiting_approval' })], pendingApprovals: [approval()], lastSequence: 2 });
    const f = fakeClient(() => snap);
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    f.state('live');
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run({ state: 'running' }) }));
    f.emit(ev('approval.requested', { approval: approval() }));

    // Snapshot is ahead of the stream (sequence 6) and claims the run is still running.
    snap = snapshot({ runs: [run({ state: 'running' })], pendingApprovals: [], lastSequence: 6 });
    f.client.decide.mockRejectedValueOnce(clientError('approval_already_resolved', 409));
    await store.actions.decide('apr_1', 'allow');
    expect(store.getState().active!.lastSequence).toBe(2);
    expect(store.getState().active!.approvals.apr_1!.state).toBe('pending');

    f.emit(ev('approval.resolved', { approval: approval({ state: 'approved', decision: 'allow', version: 3 }) }));
    f.emit(ev('tool.started', { toolId: 'tool_1', name: 'Bash', title: 'ls', category: 'shell' }));
    f.emit(ev('tool.completed', { toolId: 'tool_1', output: 'ok' }));
    f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 }));
    let active = store.getState().active!;
    expect(active.lastSequence).toBe(6);
    expect(active.approvals.apr_1!.state).toBe('approved');
    expect(active.tools.tool_1!.status).toBe('completed');
    expect(active.runs.run_1!.state).toBe('completed');

    // Snapshot behind (run still running) after the stream completed the run: no regression.
    f.client.decide.mockRejectedValueOnce(clientError('approval_already_resolved', 409));
    await store.actions.decide('apr_1', 'deny');
    active = store.getState().active!;
    expect(active.runs.run_1!.state).toBe('completed');
    expect(active.lastSequence).toBe(6);
    await store.actions.sendPrompt('next');
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
  });

  it('cancelRun returning a terminal run settles messages and tools even with the stream down', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run({ state: 'running' }) }));
    f.emit(ev('message.started', { messageId: 'm1', role: 'assistant' }));
    f.emit(ev('tool.started', { toolId: 't1', name: 'Bash', title: 'ls', category: 'shell' }));
    f.state('reconnecting');
    await store.actions.cancelRun();
    const active = store.getState().active!;
    expect(f.client.cancelRun).toHaveBeenCalledWith('run_1');
    expect(active.runs.run_1!.state).toBe('cancelled');
    expect(active.messages.m1!.streaming).toBe(false);
    expect(active.tools.t1!.status).toBe('failed');
  });

  it('dispose closes the subscription and ignores late events; selectSession resumes', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    const ev = eventFactory();
    const late = f.subs[0]!;
    store.dispose();
    expect(late.closed).toBe(true);
    late.onEvent(ev('run.started', { run: run() }));
    expect(store.getState().active!.timeline).toEqual([]);
    expect(store.getState().activeSessionId).toBe('ses_1');
    await store.actions.selectSession('ses_1');
    expect(f.subs.filter((s) => !s.closed)).toHaveLength(1);
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


const richCaps = (over: Partial<RuntimeCapabilities['attachments']> = {}): RuntimeCapabilities => ({
  ...session().capabilities,
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
  efforts: ['low', 'high'],
  permissionModes: ['default', 'acceptEdits', 'plan'],
  attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes, maxImageBytes: 5 * 1024 * 1024, ...over },
});

const fileOf = (name: string, size: number, type = '') => new File([new Uint8Array(size)], name, { type });

const uploaded = (sessionId: string, file: Blob & { name: string }, n: number): Attachment => ({
  id: `att_${n}`,
  sessionId,
  name: file.name,
  mime: file.type,
  size: file.size,
  kind: file.type.startsWith('image/') ? 'image' : 'file',
  sha256: 'x',
  createdAt: T0,
});

/** A client whose sessions and runtime advertise `richCaps()`, with a counting upload stub. */
function composerClient() {
  const caps = richCaps();
  const f = fakeClient(() => snapshot({ session: session({ capabilities: caps }) }));
  let n = 0;
  f.client.runtimes.mockResolvedValue([{ id: 'fake', displayName: 'Fake', status: 'available', capabilities: caps }]);
  f.client.createSession.mockResolvedValue(session({ capabilities: caps }));
  f.client.uploadAttachment.mockImplementation(async (sessionId: string, file: Blob & { name: string }) =>
    uploaded(sessionId, file, ++n),
  );
  f.client.updateSettings.mockImplementation(async (_id: string, patch: Partial<SessionSettings>) =>
    session({ capabilities: caps, settings: { permissionMode: 'default', ...patch } }),
  );
  return { f, caps };
}

describe('composer: settings and attachments', () => {
  it('draft settings applied to new session before first run', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    // Values the runtime does not offer are refused client-side, like the server would.
    expect(await store.actions.updateSettings({ effort: 'max' })).toBe(false);
    expect(store.getState().lastError?.code).toBe('unsupported_capability');
    store.actions.dismissError();
    expect(await store.actions.updateSettings({ model: 'opus', permissionMode: 'plan' })).toBe(true);
    expect(store.getState().draft.settings).toEqual({ model: 'opus', permissionMode: 'plan' });
    expect(f.client.updateSettings).not.toHaveBeenCalled();

    const id = await store.actions.commitDraft();
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'fake' });
    // Only keys that differ from the new session's defaults are sent.
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { model: 'opus', permissionMode: 'plan' });
    await store.actions.selectSession(id);
    expect(await store.actions.sendPrompt('go')).toBe(true);
    expect(f.client.updateSettings.mock.invocationCallOrder[0]!).toBeLessThan(
      f.client.startRun.mock.invocationCallOrder[0]!,
    );
    expect(store.getState().draft).toEqual({ open: false, settings: { permissionMode: 'default' } });
  });

  it('commitDraft rejects (and keeps the draft) when draft settings cannot be applied', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    await store.actions.updateSettings({ permissionMode: 'plan' });
    f.client.updateSettings.mockRejectedValueOnce(clientError('policy_denied', 403));
    await expect(store.actions.commitDraft()).rejects.toMatchObject({ code: 'policy_denied' });
    expect(store.getState().lastError?.code).toBe('policy_denied');
    expect(store.getState().draft.settings.permissionMode).toBe('plan');
  });

  it('update on a session patches it; during an active run it is pending for the next run', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    expect(await store.actions.updateSettings({ effort: 'low' })).toBe(true);
    expect(store.getState().active!.session.settings.effort).toBe('low');
    expect(store.getState().active!.pendingSettingsRunId).toBeUndefined();

    await store.actions.sendPrompt('x');
    expect(await store.actions.updateSettings({ effort: 'high' })).toBe(true);
    expect(f.client.updateSettings).toHaveBeenLastCalledWith('ses_1', { effort: 'high' });
    expect(store.getState().active!.pendingSettingsRunId).toBe('run_1');

    f.client.updateSettings.mockRejectedValueOnce(clientError('policy_denied', 403));
    expect(await store.actions.updateSettings({ permissionMode: 'acceptEdits' })).toBe(false);
    expect(store.getState().lastError?.code).toBe('policy_denied');
  });

  it('session.updated from another tab during a run marks pending; a run-scoped reset does not', async () => {
    const { f, caps } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    const ev = eventFactory();
    f.emit(ev('run.started', { run: run({ state: 'running' }) }));
    const reset = ev('session.updated', { session: session({ capabilities: caps, settings: { permissionMode: 'default' } }) });
    f.emit(reset);
    expect(store.getState().active!.pendingSettingsRunId).toBeUndefined();
    f.emit({ ...ev('session.updated', { session: session({ capabilities: caps, settings: { permissionMode: 'plan' } }) }), runId: undefined } as UncageEvent);
    expect(store.getState().active!.session.settings.permissionMode).toBe('plan');
    expect(store.getState().active!.pendingSettingsRunId).toBe('run_1');
  });

  it('attachments: oversize/unsupported rejected client-side without upload', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    store.actions.addAttachments([
      fileOf('virus.exe', 10),
      fileOf('fake.png', 10, 'image/svg+xml'),
      fileOf('big.png', 5 * 1024 * 1024 + 1, 'image/png'), // over the runtime's maxImageBytes
      fileOf('huge.txt', ATTACHMENT_LIMITS.maxBytes + 1, 'text/plain'),
      fileOf('notes.md', 20),
      fileOf('ok.jpg', 5 * 1024 * 1024, 'image/jpg'),
    ]);
    expect(store.getState().attachments.rejected).toEqual([
      { name: 'virus.exe', reason: 'type' },
      { name: 'fake.png', reason: 'type' },
      { name: 'big.png', reason: 'size' },
      { name: 'huge.txt', reason: 'size' },
    ]);
    expect(f.client.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(f.client.uploadAttachment.mock.calls.map((c) => c[1].name)).toEqual(['notes.md', 'ok.jpg']);
    expect(store.getState().attachments.items.map((i) => [i.name, i.kind, i.status])).toEqual([
      ['notes.md', 'file', 'uploading'],
      ['ok.jpg', 'image', 'uploading'],
    ]);
    await vi.waitFor(() => expect(store.getState().attachments.items.every((i) => i.status === 'ready')).toBe(true));
  });

  it('attachments of a kind the runtime does not accept are rejected as type', async () => {
    const f = fakeClient(() => snapshot({ session: session({ capabilities: richCaps({ images: false }) }) }));
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    store.actions.addAttachments([fileOf('a.png', 5, 'image/png')]);
    expect(store.getState().attachments.rejected).toEqual([{ name: 'a.png', reason: 'type' }]);
    expect(f.client.uploadAttachment).not.toHaveBeenCalled();
  });

  it('11th file rejected with reason count', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    store.actions.addAttachments(Array.from({ length: 7 }, (_, i) => fileOf(`f${i}.txt`, 1)));
    store.actions.addAttachments(Array.from({ length: 4 }, (_, i) => fileOf(`g${i}.txt`, 1)));
    expect(store.getState().attachments.items).toHaveLength(10);
    expect(store.getState().attachments.rejected).toEqual([{ name: 'g3.txt', reason: 'count' }]);
    expect(f.client.uploadAttachment).toHaveBeenCalledTimes(10);
  });

  it('sendPrompt sends attachmentIds and clears drafts on success, keeps them on failure', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    store.actions.addAttachments([fileOf('a.txt', 1), fileOf('b.png', 1, 'image/png')]);
    // Uploads are still in flight: sendPrompt waits for them.
    f.client.startRun.mockRejectedValueOnce(clientError('session_busy', 409));
    expect(await store.actions.sendPrompt('one')).toBe(false);
    expect(f.client.startRun).toHaveBeenLastCalledWith('ses_1', { prompt: 'one', attachmentIds: ['att_1', 'att_2'] });
    expect(store.getState().attachments.items).toHaveLength(2);

    expect(await store.actions.sendPrompt('two')).toBe(true);
    expect(f.client.startRun).toHaveBeenLastCalledWith('ses_1', { prompt: 'two', attachmentIds: ['att_1', 'att_2'] });
    expect(store.getState().attachments.items).toEqual([]);
  });

  it('sendPrompt resolves false with a clear reason when an upload failed', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    f.client.uploadAttachment.mockRejectedValueOnce(clientError('attachment_too_large', 413));
    store.actions.addAttachments([fileOf('a.txt', 1)]);
    expect(await store.actions.sendPrompt('x')).toBe(false);
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(store.getState().attachments.items[0]).toMatchObject({ status: 'error', error: { code: 'attachment_too_large' } });
    expect(store.getState().lastError).toMatchObject({ code: 'invalid_request' });
    expect(store.getState().lastError?.message).toContain('a.txt');
    store.actions.removeAttachment(store.getState().attachments.items[0]!.localId);
    expect(await store.actions.sendPrompt('x')).toBe(true);
    expect(f.client.startRun).toHaveBeenLastCalledWith('ses_1', { prompt: 'x' });
  });

  it('draft attachments queue (validated against the draft runtime) and upload right after commitDraft', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    store.actions.addAttachments([fileOf('big.png', 5 * 1024 * 1024 + 1, 'image/png'), fileOf('a.txt', 1)]);
    expect(store.getState().attachments.rejected).toEqual([{ name: 'big.png', reason: 'size' }]);
    expect(store.getState().attachments.items.map((i) => i.status)).toEqual(['uploading']);
    expect(f.client.uploadAttachment).not.toHaveBeenCalled();

    const id = await store.actions.commitDraft();
    expect(f.client.uploadAttachment).toHaveBeenCalledWith('ses_1', expect.objectContaining({ name: 'a.txt' }), expect.anything());
    await store.actions.selectSession(id);
    expect(await store.actions.sendPrompt('go')).toBe(true);
    expect(f.client.startRun).toHaveBeenCalledWith('ses_1', { prompt: 'go', attachmentIds: ['att_1'] });
  });

  it('remove/clear abort uploads and revoke image preview URLs; switching sessions drops them', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: () => {
        created.push(`blob:${created.length}`);
        return created.at(-1)!;
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    }));
    try {
      const { f } = composerClient();
      const signals: AbortSignal[] = [];
      f.client.uploadAttachment.mockImplementation(
        (_s: string, _f: Blob, o?: { signal?: AbortSignal }) => (signals.push(o!.signal!), new Promise<never>(() => {})),
      );
      const store = createUncageStore(f.client);
      await store.actions.selectSession('ses_1');
      store.actions.addAttachments([fileOf('a.png', 1, 'image/png'), fileOf('b.txt', 1), fileOf('c.gif', 1, 'image/gif')]);
      const [a, b] = store.getState().attachments.items;
      expect(a!.previewUrl).toBe('blob:0');
      expect(b!.previewUrl).toBeUndefined();
      store.actions.removeAttachment(a!.localId);
      expect(revoked).toEqual(['blob:0']);
      expect(signals[0]!.aborted).toBe(true);
      store.actions.clearAttachments();
      expect(revoked).toEqual(['blob:0', 'blob:1']);
      expect(signals.every((s) => s.aborted)).toBe(true);

      store.actions.addAttachments([fileOf('d.png', 1, 'image/png')]);
      await store.actions.selectSession('ses_2');
      expect(store.getState().attachments.items).toEqual([]);
      expect(revoked).toEqual(['blob:0', 'blob:1', 'blob:2']);
      store.actions.addAttachments([fileOf('e.png', 1, 'image/png')]);
      store.dispose();
      expect(revoked).toEqual(['blob:0', 'blob:1', 'blob:2', 'blob:3']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
