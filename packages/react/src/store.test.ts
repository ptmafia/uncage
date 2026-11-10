import type { ActiveRunInfo, Attachment, RuntimeCapabilities, SessionSettings, UncageEvent } from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { createUncageClient, UncageClientError } from '@uncage/client';
import { describe, expect, it, vi } from 'vitest';
import { createUncageStore, UPLOAD_FAILED_REASON } from './store.js';
import { approval, clientError, eventFactory, fakeClient, machine, run, session, snapshot, T0 } from './test-fixtures.js';

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

  it('a non-terminal headers error from the stream is cleared once the stream is live again', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    const headersErr = new UncageClientError(
      { code: 'unauthorized', message: 'refresh failed', retryable: true, details: { reason: 'headers' } },
      0,
    );
    f.state('reconnecting');
    f.subs.at(-1)!.onError!(headersErr);
    expect(store.getState().lastError).toBe(headersErr);
    f.state('live');
    expect(store.getState().lastError).toBeUndefined();

    // Any other error stays until dismissed.
    f.state('reconnecting');
    f.subs.at(-1)!.onError!(clientError('rate_limited', 429));
    f.state('live');
    expect(store.getState().lastError?.code).toBe('rate_limited');
  });

  it('sessions are newest-first before and after a reload; a first-run title reaches the list', async () => {
    const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
    const old = session({ id: 'ses_old', title: 'Old', createdAt: at(0) });
    const mid = session({ id: 'ses_mid', title: 'Mid', createdAt: at(1) });
    const f = fakeClient(() => snapshot({ session: mid }));
    // The server lists oldest-first.
    f.client.listSessions.mockResolvedValue([old, mid]);
    const store = createUncageStore(f.client);
    await store.actions.loadSessions();
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['ses_mid', 'ses_old']);

    const fresh = session({ id: 'ses_new', title: 'ws', createdAt: at(2) });
    f.client.createSession.mockResolvedValue(fresh);
    await store.actions.createSession({ runtime: 'claude' });
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_mid', 'ses_old']);

    // Selecting an older session keeps the order (no move to the top).
    await store.actions.selectSession('ses_mid');
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_mid', 'ses_old']);

    // The run-scoped session.updated that titles a session updates the sidebar list too.
    const ev = eventFactory();
    f.emit(ev('session.updated', { session: { ...mid, title: 'Fix the login test' } }, 'run_1'));
    expect(store.getState().sessions.find((s) => s.id === 'ses_mid')?.title).toBe('Fix the login test');

    // Reload: same order as before.
    f.client.listSessions.mockResolvedValue([old, mid, fresh]);
    const reloaded = createUncageStore(f.client);
    await reloaded.actions.loadSessions();
    expect(reloaded.getState().sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_mid', 'ses_old']);
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

  it('rotation keeps the timeline intact', async () => {
    const ev = eventFactory();
    const words = ['The', ' rotation', ' is', ' seamless', ' for', ' the', ' reader', '.'];
    const events: UncageEvent[] = [
      ev('run.started', { run: run({ state: 'running' }) }),
      ev('message.started', { messageId: 'm1', role: 'assistant' }),
      ...words.map((text, chunkIndex) => ev('message.delta', { messageId: 'm1', chunkIndex, text })),
      ev('tool.started', { toolId: 't1', name: 'Bash', title: 'ls', category: 'shell' }),
      ev('message.completed', { messageId: 'm1', text: words.join('') }),
      ev('run.completed', { runId: 'run_1', durationMs: 1 }),
    ];
    // Reference: the same events on one uninterrupted subscription.
    const ref = fakeClient();
    const refStore = createUncageStore(ref.client);
    await refStore.actions.selectSession('ses_1');
    for (const e of events) ref.emit(e);

    // A server that ends every response after two events with `event: reconnect` (the real client).
    const enc = new TextEncoder();
    const requests: Headers[] = [];
    const fetch = vi.fn(async (_u: string | URL | Request, i?: RequestInit) => {
      const headers = new Headers(i?.headers);
      requests.push(headers);
      const lastId = headers.get('last-event-id');
      const from = lastId ? events.findIndex((e) => e.eventId === lastId) + 1 : 0;
      const chunk = events.slice(from, from + 2);
      const body = chunk.map((e) => `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      const tail = from + 2 < events.length ? 'event: reconnect\ndata: {}\n\n' : '';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(body + tail));
            if (tail) c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const real = createUncageClient({ fetch });
    const f = fakeClient();
    f.client.subscribe.mockImplementation(real.subscribe);
    const store = createUncageStore(f.client);
    const connections: string[] = [];
    store.subscribe(() => {
      const c = store.getState().active?.connection;
      if (c && c !== connections.at(-1)) connections.push(c);
    });
    await store.actions.selectSession('ses_1');
    await vi.waitFor(() => expect(store.getState().active!.lastSequence).toBe(events.length));
    const got = store.getState().active!;
    const want = refStore.getState().active!;
    expect(requests.length).toBe(Math.ceil(events.length / 2));
    expect(got.timeline).toEqual(want.timeline);
    expect(got.messages).toEqual(want.messages);
    expect(got.messages.m1!.text).toBe(words.join(''));
    expect(got.tools).toEqual(want.tools);
    expect(got.runs).toEqual(want.runs);
    expect(connections).toEqual(['connecting', 'live']);
    store.dispose();
    refStore.dispose();
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
  f.client.uploadAttachment.mockImplementation(async (sessionId: string, file) =>
    uploaded(sessionId, file as Blob & { name: string }, ++n),
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
    const patch = (settings: SessionSettings) =>
      f.emit({ ...ev('session.updated', { session: session({ capabilities: caps, settings }) }), runId: undefined } as UncageEvent);
    // A second change keeps the run-start values as the baseline...
    patch({ permissionMode: 'acceptEdits' });
    expect(store.getState().active!.pendingSettingsRunId).toBe('run_1');
    // ...so reverting to them (from either tab) clears the pending state.
    patch({ permissionMode: 'default' });
    expect(store.getState().active!.pendingSettingsRunId).toBeUndefined();
    patch({ permissionMode: 'plan' });
    expect(store.getState().active!.pendingSettingsRunId).toBe('run_1');
  });

  it('a send blocked by a failed upload records a tagged invalid_request (for localization)', async () => {
    const { f } = composerClient();
    f.client.uploadAttachment.mockRejectedValueOnce(clientError('attachment_too_large', 413));
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    store.actions.addAttachments([fileOf('notes.md', 10, 'text/markdown')]);
    await vi.waitFor(() => expect(store.getState().attachments.items[0]?.status).toBe('error'));
    expect(await store.actions.sendPrompt('x')).toBe(false);
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(store.getState().lastError).toMatchObject({
      code: 'invalid_request',
      details: { reason: UPLOAD_FAILED_REASON, name: 'notes.md' },
    });
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

  it('attachments: React Native file references ({ uri, name, type, size? }) are validated and uploaded as-is', async () => {
    const { f } = composerClient();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const store = createUncageStore(f.client);
    await store.actions.selectSession('ses_1');
    const photo = { uri: 'file:///cache/a.jpg', name: 'a.jpg', type: 'image/jpeg', size: 1000 };
    const doc = { uri: 'file:///cache/notes.md', name: 'notes.md', type: 'text/markdown' }; // size unknown
    store.actions.addAttachments([
      photo,
      doc,
      { uri: 'file:///cache/big.png', name: 'big.png', type: 'image/png', size: 5 * 1024 * 1024 + 1 },
      { uri: 'file:///cache/x.exe', name: 'x.exe', type: 'application/octet-stream' },
    ]);
    expect(store.getState().attachments.rejected).toEqual([
      { name: 'big.png', reason: 'size' },
      { name: 'x.exe', reason: 'type' },
    ]);
    expect(f.client.uploadAttachment.mock.calls.map((c) => c[1])).toEqual([photo, doc]);
    const items = store.getState().attachments.items;
    expect(items.map((i) => [i.name, i.kind, i.size, i.previewUrl])).toEqual([
      ['a.jpg', 'image', 1000, 'file:///cache/a.jpg'],
      ['notes.md', 'file', 0, undefined],
    ]);
    store.actions.removeAttachment(items[0]!.localId);
    expect(revoke).not.toHaveBeenCalled();
    revoke.mockRestore();
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
        (_s: string, _f: unknown, o?: { signal?: AbortSignal }) => (signals.push(o!.signal!), new Promise<never>(() => {})),
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

  it('an image is still added and uploaded when URL.createObjectURL throws (React Native on Android), without a preview', async () => {
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: () => {
        throw new Error('Cannot create URL for blob!');
      },
      revokeObjectURL: () => {
        throw new Error('should not be called');
      },
    }));
    try {
      const { f } = composerClient();
      const store = createUncageStore(f.client);
      await store.actions.selectSession('ses_1');
      // A named Blob, as a React Native app passes (no File there).
      const blob = Object.assign(new Blob([new Uint8Array(3)], { type: 'image/jpeg' }), { name: 'photo.jpg' });
      store.actions.addAttachments([blob]);
      const [item] = store.getState().attachments.items;
      expect(item).toMatchObject({ name: 'photo.jpg', kind: 'image', size: 3 });
      expect(item!.previewUrl).toBeUndefined();
      expect(f.client.uploadAttachment).toHaveBeenCalledWith('ses_1', blob, expect.anything());
      expect(() => store.actions.removeAttachment(item!.localId)).not.toThrow();
      expect(store.getState().attachments.items).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('commitDraft retry reuses the session it created when applying settings failed', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    await store.actions.updateSettings({ permissionMode: 'plan' });
    f.client.updateSettings.mockRejectedValueOnce(clientError('internal_error', 500));
    await expect(store.actions.commitDraft()).rejects.toMatchObject({ code: 'internal_error' });
    expect(store.getState().draft.sessionId).toBe('ses_1');
    expect(await store.actions.commitDraft()).toBe('ses_1');
    expect(f.client.createSession).toHaveBeenCalledTimes(1);
    expect(f.client.updateSettings).toHaveBeenCalledTimes(2);
    expect(f.client.updateSettings).toHaveBeenLastCalledWith('ses_1', { permissionMode: 'plan' });
    expect(store.getState().draft).toEqual({ open: false, settings: { permissionMode: 'default' } });
  });

  it('createSession in a draft delegates to commitDraft (settings and queued files are kept)', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    await store.actions.updateSettings({ effort: 'low' });
    store.actions.addAttachments([fileOf('a.txt', 1)]);
    expect(await store.actions.createSession({ runtime: 'fake' })).toBe('ses_1');
    expect(f.client.updateSettings).toHaveBeenCalledWith('ses_1', { effort: 'low' });
    expect(f.client.uploadAttachment).toHaveBeenCalledWith('ses_1', expect.objectContaining({ name: 'a.txt' }), expect.anything());
  });

  it('commitDraft racing a session switch does not rebind the other session\'s attachments', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    await store.actions.updateSettings({ effort: 'low' });
    store.actions.addAttachments([fileOf('draft.txt', 1)]);
    let created!: () => void;
    f.client.createSession.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (created = r));
      return session({ id: 'ses_new', capabilities: richCaps() });
    });
    const commit = store.actions.commitDraft();
    // Meanwhile the user opens another session and attaches a file there.
    await store.actions.selectSession('ses_other');
    store.actions.addAttachments([fileOf('other.txt', 1)]);
    created();
    expect(await commit).toBe('ses_new');
    expect(f.client.uploadAttachment.mock.calls.map((c) => [c[0], c[1].name])).toEqual([['ses_other', 'other.txt']]);
    expect(store.getState().attachments.sessionId).toBe('ses_other');
    // The draft's settings were not applied to the new session (the draft was abandoned).
    expect(f.client.updateSettings).not.toHaveBeenCalled();
  });

  it('commitDraft racing openDraft leaves the new draft alone', async () => {
    const { f } = composerClient();
    const store = createUncageStore(f.client);
    await store.actions.loadRuntimes();
    store.actions.openDraft('fake');
    store.actions.addAttachments([fileOf('a.txt', 1)]);
    let created!: () => void;
    f.client.createSession.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (created = r));
      return session({ id: 'ses_new', capabilities: richCaps() });
    });
    const commit = store.actions.commitDraft();
    store.actions.openDraft('other');
    created();
    await commit;
    expect(store.getState().draft).toMatchObject({ open: true, runtimeId: 'other' });
    expect(store.getState().attachments.sessionId).toBeUndefined();
    expect(f.client.uploadAttachment).not.toHaveBeenCalled();
  });

  it('an active-runs refresh in flight at dispose() does not update state', async () => {
    const { f } = composerClient();
    let resolve!: (r: ActiveRunInfo[]) => void;
    f.client.listActiveRuns.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const store = createUncageStore(f.client);
    const stop = store.actions.watchActiveRuns();
    store.dispose();
    resolve([{ runId: 'run_1', sessionId: 'ses_1', sessionTitle: 'T', state: 'running' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().activeRuns).toEqual([]);
    expect(f.client.listActiveRuns).toHaveBeenCalledTimes(1);
    stop();
    // A fresh watcher (provider remount) polls again.
    const again = store.actions.watchActiveRuns();
    expect(f.client.listActiveRuns).toHaveBeenCalledTimes(2);
    again();
  });
});

describe('machines (connected mode)', () => {
  const runtimeInfo = {
    id: 'fake',
    displayName: 'Fake',
    status: 'available' as const,
    capabilities: session().capabilities,
  };

  it('a daemon without /machines (404) is Local Mode: no list, no error, no machineId on create', async () => {
    const f = fakeClient();
    const store = createUncageStore(f.client);
    expect(store.getState().machines.mode).toBe('unknown');
    await store.actions.loadMachines();
    expect(store.getState().machines).toMatchObject({ mode: 'local', list: [], loading: false });
    expect(store.getState().lastError).toBeUndefined();
    await store.actions.createSession({ runtime: 'claude' });
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude' });
  });

  it('a hub lists machines, selects the first online one and creates sessions on it', async () => {
    const f = fakeClient(undefined, {
      machines: [machine({ id: 'mac_off', online: false }), machine({ id: 'mac_on', name: 'Studio' })],
    });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    expect(store.getState().machines).toMatchObject({ mode: 'connected', selectedId: 'mac_on' });
    expect(store.getState().machines.list).toHaveLength(2);
    f.client.createSession.mockResolvedValue(session({ id: 'ses_9' }));
    await store.actions.createSession({ runtime: 'claude' });
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude', machineId: 'mac_on' });
    store.actions.selectMachine('mac_off');
    expect(store.getState().machines.selectedId).toBe('mac_off');
    // An unknown id is ignored.
    store.actions.selectMachine('nope');
    expect(store.getState().machines.selectedId).toBe('mac_off');
  });

  it('commitDraft creates the draft session on the selected machine', async () => {
    const f = fakeClient(undefined, { machines: [machine()] });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    store.actions.openDraft('claude');
    await store.actions.commitDraft();
    expect(f.client.createSession).toHaveBeenCalledWith({ runtime: 'claude', machineId: 'mac_1' });
  });

  it('a failed refresh keeps the connected list and records machines.error, not lastError', async () => {
    const f = fakeClient(undefined, { machines: [machine()] });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    f.client.machines.mockRejectedValueOnce(clientError('rate_limited', 429));
    await store.actions.loadMachines();
    expect(store.getState().machines.mode).toBe('connected');
    expect(store.getState().machines.list).toHaveLength(1);
    expect(store.getState().machines.error?.code).toBe('rate_limited');
    expect(store.getState().lastError).toBeUndefined();
    await store.actions.loadMachines();
    expect(store.getState().machines.error).toBeUndefined();
  });

  it('a poll that changes nothing does not notify subscribers', async () => {
    const f = fakeClient(undefined, { machines: [machine()] });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    const fn = vi.fn();
    store.subscribe(fn);
    f.client.machines.mockResolvedValueOnce([machine()]);
    await store.actions.loadMachines();
    expect(fn).not.toHaveBeenCalled();
    f.client.machines.mockResolvedValueOnce([machine({ online: false })]);
    await store.actions.loadMachines();
    expect(fn).toHaveBeenCalled();
  });

  it('a non-404 failure on the first probe retries after 2 s, 5 s, 10 s, then every 30 s until it answers', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient(undefined, { machines: [machine()] });
      f.client.machines.mockRejectedValue(clientError('internal_error', 503));
      const store = createUncageStore(f.client);
      await store.actions.loadMachines();
      expect(store.getState().machines.mode).toBe('unknown');
      const calls = () => f.client.machines.mock.calls.length;
      for (const [wait, total] of [[2000, 2], [5000, 3], [10_000, 4], [30_000, 5], [30_000, 6]] as const) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(calls()).toBe(total - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls()).toBe(total);
      }
      f.client.machines.mockResolvedValue([machine()]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.getState().machines.mode).toBe('connected');
      const n = calls();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls()).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Local Mode (404) is never probed again; dispose stops pending retries', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient();
      const store = createUncageStore(f.client);
      await store.actions.loadMachines();
      expect(store.getState().machines.mode).toBe('local');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(f.client.machines).toHaveBeenCalledTimes(1);

      const g = fakeClient();
      g.client.machines.mockRejectedValue(clientError('internal_error', 503));
      const other = createUncageStore(g.client);
      await other.actions.loadMachines();
      other.dispose();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(g.client.machines).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the selection while that machine is listed; reselects when it disappears', async () => {
    const f = fakeClient(undefined, { machines: [machine({ id: 'a' }), machine({ id: 'b' })] });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    store.actions.selectMachine('b');
    f.client.machines.mockResolvedValueOnce([machine({ id: 'a' }), machine({ id: 'b', online: false })]);
    await store.actions.loadMachines();
    expect(store.getState().machines.selectedId).toBe('b');
    f.client.machines.mockResolvedValueOnce([machine({ id: 'a' })]);
    await store.actions.loadMachines();
    expect(store.getState().machines.selectedId).toBe('a');
  });

  it('in connected mode, runtimes are the selected computer\'s', async () => {
    const rt = (id: string) => ({ ...runtimeInfo, id, displayName: id });
    const f = fakeClient(undefined, {
      machines: [machine({ id: 'a', runtimes: [rt('claude')] }), machine({ id: 'b', runtimes: [rt('codex')] })],
    });
    f.client.runtimes.mockResolvedValue([rt('stale')]);
    const store = createUncageStore(f.client);
    const loading = store.actions.loadRuntimes();
    await store.actions.loadMachines();
    await loading;
    expect(store.getState().runtimes.map((r) => r.id)).toEqual(['claude']);
    store.actions.selectMachine('b');
    expect(store.getState().runtimes.map((r) => r.id)).toEqual(['codex']);
    await store.actions.loadRuntimes();
    expect(store.getState().runtimes.map((r) => r.id)).toEqual(['codex']);
    expect(f.client.runtimes).toHaveBeenCalledTimes(1);
  });

  it('watchMachines polls every 3 s while watched and visible', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient(undefined, { machines: [machine()] });
      const store = createUncageStore(f.client);
      const stop = store.actions.watchMachines();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.machines).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.client.machines).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(9000);
      expect(f.client.machines).toHaveBeenCalledTimes(2);
      // A slower watcher alone polls at its own interval.
      const slow = store.actions.watchMachines(10_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.machines).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.client.machines).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(7000);
      expect(f.client.machines).toHaveBeenCalledTimes(4);
      slow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchMachines in Local Mode stops polling after the 404', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient();
      const store = createUncageStore(f.client);
      const stop = store.actions.watchMachines();
      await vi.advanceTimersByTimeAsync(9000);
      expect(f.client.machines).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadInstallInfo caches the commands; revokeMachine drops the machine', async () => {
    const f = fakeClient(undefined, { machines: [machine({ id: 'a' }), machine({ id: 'b' })] });
    const store = createUncageStore(f.client);
    await store.actions.loadMachines();
    await store.actions.loadInstallInfo();
    expect(store.getState().machines.install?.setup).toBe('uncage setup https://site.test/api/uncage');
    await store.actions.loadInstallInfo();
    expect(f.client.installInfo).toHaveBeenCalledTimes(1);
    expect(await store.actions.revokeMachine('a')).toBe(true);
    expect(f.client.revokeMachine).toHaveBeenCalledWith('a');
    expect(store.getState().machines.list.map((m) => m.id)).toEqual(['b']);
    expect(store.getState().machines.selectedId).toBe('b');
    f.client.revokeMachine.mockRejectedValueOnce(clientError('machine_not_found', 404));
    expect(await store.actions.revokeMachine('b')).toBe(false);
    expect(store.getState().lastError?.code).toBe('machine_not_found');
  });
});
