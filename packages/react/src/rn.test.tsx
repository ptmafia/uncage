import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { UncageClientError } from '@uncage/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceCodeTail, isWellFormedDeviceCode, maskDeviceCode, matchesDeviceCodeTail, useDeviceApproval, usePersistSession, useReconnect, useUncageStore } from './hooks.js';
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

const TYPED = { source: 'typed' } as const;
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

  it('an inline adapter (new object every render) reads once and still saves', async () => {
    const f = fakeClient(() => snapshot({ session: session({ id: 'ses_9' }) }));
    const get = vi.fn(async () => 'ses_9');
    const set = vi.fn(async () => undefined);
    const { rerender } = renderHook(() => usePersistSession({ get, set }), { wrapper: wrap(f.client) });
    await waitFor(() => expect(set).toHaveBeenCalledWith('ses_9'));
    rerender();
    rerender();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(get).toHaveBeenCalledTimes(1);
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
    const { result } = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
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
    const { result, rerender } = renderHook(({ c }) => useDeviceApproval(c, TYPED), {
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
    const { result, unmount } = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
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
    const { result } = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('error'));
    await act(async () => {
      await result.current.approve();
      await result.current.deny();
    });
    expect(f.client.decideDevice).not.toHaveBeenCalled();
    expect(result.current.error?.code).toBe('rate_limited');
  });

  it('retry() re-runs a failed lookup; does nothing in other states', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockRejectedValueOnce(err('rate_limited', 429));
    f.client.lookupDevice.mockResolvedValue(lookup);
    const { result } = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.lookup).toEqual(lookup);
    expect(f.client.lookupDevice).toHaveBeenCalledTimes(2);
    act(() => result.current.retry());
    await act(async () => Promise.resolve());
    expect(f.client.lookupDevice).toHaveBeenCalledTimes(2);
  });
});

describe('useDeviceApproval', () => {
  it('loads, approves, maps not_found/expired and rate_limited errors', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    const { result } = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.lookup).toEqual(lookup);
    await act(() => result.current.approve());
    expect(f.client.decideDevice).toHaveBeenCalledWith('ABCD', true);
    expect(result.current.state).toBe('approved');

    f.client.decideDevice.mockResolvedValueOnce('ok');
    const d = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(d.result.current.state).toBe('idle'));
    await act(() => d.result.current.deny());
    expect(f.client.decideDevice).toHaveBeenLastCalledWith('ABCD', false);
    expect(d.result.current.state).toBe('denied');

    f.client.lookupDevice.mockResolvedValueOnce(null);
    const nf = renderHook(() => useDeviceApproval('NOPE', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(nf.result.current.state).toBe('not_found'));

    f.client.decideDevice.mockResolvedValueOnce('expired');
    const ex = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(ex.result.current.state).toBe('idle'));
    await act(() => ex.result.current.approve());
    expect(ex.result.current.state).toBe('expired');

    f.client.decideDevice.mockRejectedValueOnce(err('rate_limited', 429));
    const rl = renderHook(() => useDeviceApproval('ABCD', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(rl.result.current.state).toBe('idle'));
    await act(() => rl.result.current.approve());
    expect(rl.result.current.state).toBe('idle');
    expect(rl.result.current.error).toEqual({ code: 'rate_limited', message: 'rate_limited msg' });

    f.client.lookupDevice.mockRejectedValueOnce(err('rate_limited', 429));
    const le = renderHook(() => useDeviceApproval('ZZZZ', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(le.result.current.error?.code).toBe('rate_limited'));
    expect(le.result.current.state).toBe('error');
  });
});

describe('useDeviceApproval with a code from a link (phishing guard)', () => {
  it('approve does nothing until the last 4 characters are typed; deny needs nothing', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue({ ...lookup, requestedAt: '2026-11-09T00:50:00.000Z', requestIp: '203.0.113.7' });
    // The default source is 'link'.
    const { result } = renderHook(() => useDeviceApproval('ABCD-EFGH'), { wrapper: wrap(f.client) });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.confirmation).toMatchObject({ required: true, typed: '', matched: false });
    await act(() => result.current.approve());
    expect(f.client.decideDevice).not.toHaveBeenCalled();
    act(() => result.current.confirmation.setTyped('ABCD'));
    expect(result.current.confirmation.matched).toBe(false);
    await act(() => result.current.approve());
    expect(f.client.decideDevice).not.toHaveBeenCalled();
    act(() => result.current.confirmation.setTyped(' efgh '));
    expect(result.current.confirmation.matched).toBe(true);
    await act(() => result.current.approve());
    expect(f.client.decideDevice).toHaveBeenCalledWith('ABCD-EFGH', true);
    expect(result.current.state).toBe('approved');

    const d = renderHook(() => useDeviceApproval('ABCD-EFGH', { source: 'link' }), { wrapper: wrap(f.client) });
    await waitFor(() => expect(d.result.current.state).toBe('idle'));
    await act(() => d.result.current.deny());
    expect(f.client.decideDevice).toHaveBeenLastCalledWith('ABCD-EFGH', false);
  });

  it('a typed code needs no extra step; a new code clears what was typed', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    const typed = renderHook(() => useDeviceApproval('ABCD-EFGH', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(typed.result.current.state).toBe('idle'));
    expect(typed.result.current.confirmation).toMatchObject({ required: false, matched: true });

    const { result, rerender } = renderHook(({ c }) => useDeviceApproval(c), { wrapper: wrap(f.client), initialProps: { c: 'AAAA-EFGH' } });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    act(() => result.current.confirmation.setTyped('EFGH'));
    expect(result.current.confirmation.matched).toBe(true);
    rerender({ c: 'BBBB-WXYZ' });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.confirmation).toMatchObject({ typed: '', matched: false });
  });

  it('a malformed link code (padded dashes, spaces) is not looked up and cannot be approved', async () => {
    const f = fakeClient();
    f.client.lookupDevice.mockResolvedValue(lookup);
    for (const bad of ['ABCD-EFGH----', 'AB-CD-EF-GH', 'ABCD EFGH', 'ABCD-EFGH WXYZ', '-ABCD-EFGH']) {
      const { result, unmount } = renderHook(() => useDeviceApproval(bad), { wrapper: wrap(f.client) });
      await waitFor(() => expect(result.current.state).toBe('not_found'));
      expect(result.current.linkInvalid).toBe(true);
      act(() => result.current.confirmation.setTyped(deviceCodeTail(bad)));
      expect(result.current.confirmation.matched).toBe(false);
      unmount();
    }
    expect(f.client.lookupDevice).not.toHaveBeenCalled();
    // Typed codes are normalized by the hub as before.
    const typed = renderHook(() => useDeviceApproval('abcd efgh', TYPED), { wrapper: wrap(f.client) });
    await waitFor(() => expect(typed.result.current.state).toBe('idle'));
    expect(typed.result.current.linkInvalid).toBe(false);
  });

  it('isWellFormedDeviceCode / maskDeviceCode', () => {
    expect(isWellFormedDeviceCode(' abcd-efgh ')).toBe(true);
    expect(isWellFormedDeviceCode('ABCDEFGH')).toBe(true);
    for (const bad of ['ABCD-EFGH----', 'ABCD--EFGH', 'AB-CD-EF-GH', 'ABCD EFGH', 'ABCD-EFG', 'ABCD-EFGH1']) expect(isWellFormedDeviceCode(bad), bad).toBe(false);
    expect(maskDeviceCode('abcd-efgh')).toBe('ABCD-••••');
    expect(maskDeviceCode('ABCDEFGH')).toBe('ABCD-••••');
    // Built from the compacted code: padding never reveals the tail.
    expect(maskDeviceCode('ABCD-EFGH----')).toBe('ABCD-••••');
    expect(maskDeviceCode('A B-C D E F G H')).toBe('ABCD-••••');
  });

  it('deviceCodeTail / matchesDeviceCodeTail', () => {
    expect(deviceCodeTail('abcd-efgh')).toBe('EFGH');
    expect(matchesDeviceCodeTail('ABCD-EFGH', 'e f-g h')).toBe(true);
    expect(matchesDeviceCodeTail('ABCD-EFGH', 'DEFGH')).toBe(false);
    expect(matchesDeviceCodeTail('ABCD-EFGH', '')).toBe(false);
    expect(matchesDeviceCodeTail('', '')).toBe(false);
  });
});

describe('useReconnect', () => {
  it('calls client.reconnect', () => {
    const f = fakeClient();
    const { result } = renderHook(() => useReconnect(), { wrapper: wrap(f.client) });
    result.current();
    expect(f.client.reconnect).toHaveBeenCalledTimes(1);
    expect(f.client.reconnect).toHaveBeenLastCalledWith(undefined);
    result.current({ force: true });
    expect(f.client.reconnect).toHaveBeenLastCalledWith({ force: true });
  });
});
void render;
