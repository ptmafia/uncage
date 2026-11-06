import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useApprovals, useMessages, useRun, useSession, useSessions } from './hooks.js';
import { UncageProvider } from './provider.js';
import { approval, eventFactory, fakeClient, run } from './test-fixtures.js';

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
