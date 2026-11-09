import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { UncageClientError } from '@uncage/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDeviceApproval, usePersistSession, useReconnect, useUncageStore } from './hooks.js';
import { UncageProvider } from './provider.js';
import { fakeClient, session, snapshot } from './test-fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (client: ReturnType<typeof fakeClient>['client']) =>
  function W({ children }: { children: ReactNode }) {
    return <UncageProvider client={client}>{children}</UncageProvider>;
  };

const lookup = { name: 'Mac', os: 'darwin', expiresAt: '2026-11-09T01:00:00.000Z', repairsMachine: null };
const err = (code: string, status: number) =>
  new UncageClientError({ code: code as never, message: `${code} msg`, retryable: false }, status);

describe('usePersistSession with a storage adapter', () => {
  it('restores and saves', async () => {
    const f = fakeClient(() => snapshot({ session: session({ id: 'ses_9' }) }));
    const storage = { get: vi.fn(async () => 'ses_9'), set: vi.fn(async () => undefined) };
    renderHook(() => usePersistSession(storage), { wrapper: wrap(f.client) });
    await waitFor(() => expect(f.client.snapshot).toHaveBeenCalledWith('ses_9'));
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith('ses_9'));
  });

  it('default persist mode is a safe no-op without window.location', async () => {
    vi.stubGlobal('window', {});
    for (const mode of ['url', 'localStorage'] as const) {
      const f = fakeClient();
      expect(() => renderHook(() => usePersistSession(mode), { wrapper: wrap(f.client) })).not.toThrow();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(f.client.snapshot).not.toHaveBeenCalled();
    }
  });
});

describe('usePersistSession races and failures', () => {
  it('does not restore over a session chosen before get() resolves, and does not write before the read', async () => {
    const f = fakeClient();
    let release!: (v: string) => void;
    const storage = {
      get: vi.fn(() => new Promise<string>((r) => (release = r))),
      set: vi.fn(async () => undefined),
    };
    const { result } = renderHook(() => ({ store: useUncageStore(), p: usePersistSession(storage) }), {
      wrapper: wrap(f.client),
    });
    await act(async () => {
      await result.current.store.actions.selectSession('ses_new');
    });
    expect(storage.set).not.toHaveBeenCalled();
    await act(async () => release('ses_old'));
    expect(f.client.snapshot).not.toHaveBeenCalledWith('ses_old');
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith('ses_new'));
  });

  it('does not restore over an open draft', async () => {
    const f = fakeClient();
    const storage = { get: vi.fn(async () => 'ses_old'), set: vi.fn(async () => undefined) };
    const { result } = renderHook(() => ({ store: useUncageStore(), p: usePersistSession(storage) }), {
      wrapper: wrap(f.client),
    });
    act(() => result.current.store.actions.openDraft());
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith(undefined));
    expect(f.client.snapshot).not.toHaveBeenCalledWith('ses_old');
  });

  it('a failing adapter never throws', async () => {
    const f = fakeClient();
    const storage = {
      get: vi.fn(async (): Promise<string> => {
        throw new Error('boom');
      }),
      set: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { result } = renderHook(() => ({ store: useUncageStore(), p: usePersistSession(storage) }), {
      wrapper: wrap(f.client),
    });
    await act(async () => {
      await result.current.store.actions.selectSession('ses_1');
    });
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith('ses_1'));
    expect(f.client.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('useDeviceApproval guards', () => {
  it('ignores a second approve while one is in flight', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    let finish!: (v: 'ok') => void;
    f.client.decideDevice.mockImplementation(() => new Promise((r) => (finish = r)));
    const { result } = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await act(async () => {
      void result.current.approve();
      void result.current.approve();
      void result.current.deny();
    });
    expect(f.client.decideDevice).toHaveBeenCalledTimes(1);
    await act(async () => finish('ok'));
    expect(result.current.state).toBe('approved');
  });

  it('a result for a previous code does not leak into the new code', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    let finish!: (v: 'ok') => void;
    f.client.decideDevice.mockImplementation(() => new Promise((r) => (finish = r)));
    const { result, rerender } = renderHook(({ c }) => useDeviceApproval(c), {
      wrapper: wrap(f.client),
      initialProps: { c: 'AAAA' },
    });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await act(async () => {
      void result.current.approve();
    });
    rerender({ c: 'BBBB' });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await act(async () => finish('ok'));
    expect(result.current.state).toBe('idle');
    expect(f.client.decideDevice).toHaveBeenCalledTimes(1);
  });

  it('unmount mid-request does not throw or update', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    let finish!: (v: 'ok') => void;
    f.client.decideDevice.mockImplementation(() => new Promise((r) => (finish = r)));
    const { result, unmount } = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    await act(async () => {
      void result.current.approve();
    });
    unmount();
    await expect(Promise.resolve().then(() => finish('ok'))).resolves.toBeUndefined();
  });

  it('a failed lookup is state error and approve/deny do nothing', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockRejectedValue(err('rate_limited', 429));
    const { result } = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('error'));
    await act(async () => {
      await result.current.approve();
      await result.current.deny();
    });
    expect(f.client.decideDevice).not.toHaveBeenCalled();
    expect(result.current.error?.code).toBe('rate_limited');
  });
});

describe('useDeviceApproval', () => {
  it('loads, approves, maps not_found/expired and rate_limited errors', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    const { result } = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.lookup).toEqual(lookup);
    await act(() => result.current.approve());
    expect(f.client.decideDevice).toHaveBeenCalledWith('ABCD', true);
    expect(result.current.state).toBe('approved');

    f.client.decideDevice.mockResolvedValueOnce('ok');
    const d = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(d.result.current.state).toBe('idle'));
    await act(() => d.result.current.deny());
    expect(f.client.decideDevice).toHaveBeenLastCalledWith('ABCD', false);
    expect(d.result.current.state).toBe('denied');

    f.client.lookupDevice.mockResolvedValueOnce(null);
    const nf = renderHook(() => useDeviceApproval('NOPE'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(nf.result.current.state).toBe('not_found'));

    f.client.decideDevice.mockResolvedValueOnce('expired');
    const ex = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(ex.result.current.state).toBe('idle'));
    await act(() => ex.result.current.approve());
    expect(ex.result.current.state).toBe('expired');

    f.client.decideDevice.mockRejectedValueOnce(err('rate_limited', 429));
    const rl = renderHook(() => useDeviceApproval('ABCD'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(rl.result.current.state).toBe('idle'));
    await act(() => rl.result.current.approve());
    expect(rl.result.current.state).toBe('idle');
    expect(rl.result.current.error).toEqual({ code: 'rate_limited', message: 'rate_limited msg' });

    f.client.lookupDevice.mockRejectedValueOnce(err('rate_limited', 429));
    const le = renderHook(() => useDeviceApproval('ZZZZ'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(le.result.current.error?.code).toBe('rate_limited'));
    expect(le.result.current.state).toBe('error');
  });
});

describe('useReconnect', () => {
  it('calls client.reconnect', () => {
    const f = fakeClient();
    const { result } = renderHook(() => useReconnect(), { wrapper: wrap(f.client) });
    result.current();
    expect(f.client.reconnect).toHaveBeenCalledTimes(1);
  });
});
void render;
