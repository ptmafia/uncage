import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ActiveRunInfo, SessionSettings } from '@uncage/protocol';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useApprovals,
  useAttachments,
  useAttachmentUrl,
  useMessages,
  useRun,
  useRunningSessions,
  useSession,
  useSessions,
  useSessionSettings,
} from './hooks.js';
import { UncageProvider } from './provider.js';
import { approval, eventFactory, fakeClient, run, session, snapshot } from './test-fixtures.js';

afterEach(cleanup);

function Chat() {
  const { timeline, messages } = useMessages();
  const { run: current, isActive, send } = useRun();
  const { connection } = useSession();
  const { pending } = useApprovals();
  return (
    <div>
      <button onClick={() => void send('hi there')}>send</button>
      <span data-testid="state">{`${current?.state ?? 'none'}:${String(isActive)}:${connection}:${pending.length}`}</span>
      <ul>
        {timeline.map((item) =>
          item.kind === 'message' ? (
            <li key={item.id}>{`${messages[item.id]!.role}: ${messages[item.id]!.text}`}</li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

function Select({ id }: { id: string }) {
  const { activeSessionId, select } = useSessions();
  return activeSessionId ? null : <button onClick={() => void select(id)}>open</button>;
}

describe('hooks', () => {
  it('useRun().send then events → useMessages renders assistant text', async () => {
    const f = fakeClient();
    render(
      <UncageProvider client={f.client}>
        <Select id="ses_1" />
        <Chat />
      </UncageProvider>,
    );
    await waitFor(() => expect(f.client.listSessions).toHaveBeenCalled());
    await act(async () => screen.getByText('open').click());
    act(() => f.state('live'));
    await act(async () => screen.getByText('send').click());
    expect(f.client.startRun).toHaveBeenCalledWith('ses_1', { prompt: 'hi there' });
    expect(screen.getByText('user: hi there')).toBeTruthy();
    expect(screen.getByTestId('state').textContent).toBe('queued:true:live:0');

    const ev = eventFactory();
    act(() => {
      f.emit(ev('run.started', { run: run({ prompt: 'hi there' }) }));
      f.emit(ev('run.updated', { runId: 'run_1', state: 'running' }));
      f.emit(ev('message.started', { messageId: 'm1', role: 'assistant' }));
      f.emit(ev('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'Hello, ' }));
      f.emit(ev('message.delta', { messageId: 'm1', chunkIndex: 1, text: '世界' }));
    });
    expect(screen.getByText('assistant: Hello, 世界')).toBeTruthy();
    act(() => f.emit(ev('approval.requested', { approval: approval() })));
    expect(screen.getByTestId('state').textContent).toBe('running:true:live:1');
    act(() => {
      f.emit(ev('approval.resolved', { approval: approval({ state: 'approved', version: 2 }) }));
      f.emit(ev('run.completed', { runId: 'run_1', durationMs: 3 }));
    });
    expect(screen.getByTestId('state').textContent).toBe('completed:false:live:0');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('provider survives StrictMode remount and disposes the subscription on unmount', async () => {
    const f = fakeClient();
    function AutoSelect() {
      const { select } = useSessions();
      useEffect(() => void select('ses_1'), [select]);
      return null;
    }
    const view = render(
      <StrictMode>
        <UncageProvider client={f.client}>
          <AutoSelect />
          <Chat />
        </UncageProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(f.subs.filter((s) => !s.closed)).toHaveLength(1));
    const ev = eventFactory();
    act(() => {
      f.emit(ev('run.started', { run: run({ prompt: 'restored' }) }));
    });
    expect(screen.getByText('user: restored')).toBeTruthy();
    view.unmount();
    expect(f.subs.every((s) => s.closed)).toBe(true);
  });
});

describe('composer hooks', () => {
  const wrapper = (f: ReturnType<typeof fakeClient>) =>
    function W({ children }: { children: ReactNode }) {
      return <UncageProvider client={f.client}>{children}</UncageProvider>;
    };

  it('update during active run sets pendingForNextRun until the run ends', async () => {
    const caps = { ...session().capabilities, efforts: ['low' as const, 'high' as const] };
    const f = fakeClient(() => snapshot({ session: session({ capabilities: caps }) }));
    f.client.updateSettings.mockImplementation(async (_id: string, patch: Partial<SessionSettings>) =>
      session({ capabilities: caps, settings: { permissionMode: 'default', ...patch } }),
    );
    const { result } = renderHook(
      () => ({ settings: useSessionSettings(), sessions: useSessions(), run: useRun() }),
      { wrapper: wrapper(f) },
    );
    expect(result.current.settings.settings).toEqual({ permissionMode: 'default' });
    await act(async () => result.current.sessions.select('ses_1'));
    expect(result.current.settings.capabilities?.efforts).toEqual(['low', 'high']);
    await act(async () => void (await result.current.settings.update({ effort: 'low' })));
    expect(result.current.settings.pendingForNextRun).toBe(false);
    await act(async () => void (await result.current.run.send('go')));
    await act(async () => void (await result.current.settings.update({ effort: 'high' })));
    expect(result.current.settings.settings.effort).toBe('high');
    expect(result.current.settings.pendingForNextRun).toBe(true);
    // Back to the run-start values: nothing is pending any more.
    await act(async () => void (await result.current.settings.update({ effort: 'low' })));
    expect(result.current.settings.pendingForNextRun).toBe(false);
    await act(async () => void (await result.current.settings.update({ effort: 'high' })));
    expect(result.current.settings.pendingForNextRun).toBe(true);
    const ev = eventFactory();
    act(() => f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 })));
    expect(result.current.settings.pendingForNextRun).toBe(false);
  });

  it('useAttachments exposes items, ready and rejections; useAttachmentUrl uses the client', async () => {
    const f = fakeClient();
    let release!: () => void;
    f.client.uploadAttachment.mockImplementation(async (sessionId: string, file: Blob & { name: string }) => {
      await new Promise<void>((r) => (release = r));
      return { id: 'att_1', sessionId, name: file.name, mime: 'text/plain', size: 1, kind: 'file' as const, sha256: '', createdAt: '' };
    });
    const caps = { ...session().capabilities, attachments: { images: true, files: true, maxBytes: 100 } };
    f.client.snapshot.mockResolvedValue(snapshot({ session: session({ capabilities: caps }) }));
    const { result } = renderHook(
      () => ({ att: useAttachments(), sessions: useSessions(), url: useAttachmentUrl('att_9') }),
      { wrapper: wrapper(f) },
    );
    expect(result.current.url).toBe('/api/uncage/attachments/att_9');
    expect(result.current.att.ready).toBe(true);
    await act(async () => result.current.sessions.select('ses_1'));
    act(() => result.current.att.add([new File(['x'], 'a.txt'), new File([new Uint8Array(101)], 'b.txt')]));
    expect(result.current.att.items.map((i) => i.name)).toEqual(['a.txt']);
    expect(result.current.att.rejected).toEqual([{ name: 'b.txt', reason: 'size' }]);
    expect(result.current.att.ready).toBe(false);
    await act(async () => release());
    expect(result.current.att.items[0]!.status).toBe('ready');
    expect(result.current.att.ready).toBe(true);
    act(() => result.current.att.clear());
    expect(result.current.att.items).toEqual([]);
    expect(result.current.att.rejected).toEqual([]);
  });

  describe('useRunningSessions', () => {
    let visibility: DocumentVisibilityState = 'visible';
    beforeEach(() => {
      vi.useFakeTimers();
      visibility = 'visible';
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    const setVisibility = (v: DocumentVisibilityState) => {
      visibility = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const info: ActiveRunInfo = { runId: 'run_9', sessionId: 'ses_9', sessionTitle: 'Other', state: 'running' };

    it('useRunningSessions polls and stops when hidden', async () => {
      const f = fakeClient();
      f.client.listActiveRuns.mockResolvedValue([info]);
      const { result, unmount } = renderHook(() => useRunningSessions(), { wrapper: wrapper(f) });
      await act(async () => {});
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(1);
      expect(result.current).toEqual({ runs: [info], count: 1 });
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(3);

      act(() => setVisibility('hidden'));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(3);

      f.client.listActiveRuns.mockResolvedValue([]);
      await act(async () => setVisibility('visible'));
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(4);
      expect(result.current.count).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(5);

      unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.client.listActiveRuns).toHaveBeenCalledTimes(5);
    });

    it('refreshes on local run events', async () => {
      const f = fakeClient();
      const { result } = renderHook(() => ({ running: useRunningSessions(), sessions: useSessions(), run: useRun() }), {
        wrapper: wrapper(f),
      });
      await act(async () => result.current.sessions.select('ses_1'));
      const before = f.client.listActiveRuns.mock.calls.length;
      f.client.listActiveRuns.mockResolvedValue([{ ...info, runId: 'run_1', sessionId: 'ses_1' }]);
      await act(async () => void (await result.current.run.send('go')));
      expect(f.client.listActiveRuns.mock.calls.length).toBe(before + 1);
      expect(result.current.running.count).toBe(1);
      f.client.listActiveRuns.mockResolvedValue([]);
      const ev = eventFactory();
      await act(async () => f.emit(ev('run.completed', { runId: 'run_1', durationMs: 1 })));
      expect(f.client.listActiveRuns.mock.calls.length).toBe(before + 2);
      expect(result.current.running.count).toBe(0);
    });
  });
});
