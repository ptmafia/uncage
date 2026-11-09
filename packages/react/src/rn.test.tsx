import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { UncageClientError } from '@uncage/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDeviceApproval, usePersistSession, useReconnect } from './hooks.js';
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

  it('default persist mode is a safe no-op without window.location', () => {
    vi.stubGlobal('window', {});
    for (const mode of ['url', 'localStorage'] as const) {
      const f = fakeClient();
      expect(() => renderHook(() => usePersistSession(mode), { wrapper: wrap(f.client) })).not.toThrow();
      expect(f.client.snapshot).not.toHaveBeenCalled();
    }
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
    expect(le.result.current.state).toBe('idle');
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
