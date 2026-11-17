import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDeviceApproval } from './hooks.js';
import { UncageProvider } from './provider.js';
import { fakeClient } from './test-fixtures.js';

// Its own file: the once-per-load warning flag starts fresh here.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('approve() on an unconfirmed link code warns exactly once and does nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const f = fakeClient();
  f.client.lookupDevice.mockResolvedValue({ name: 'Mac', expiresAt: '2026-11-09T01:00:00.000Z', repairsMachine: null });
  const wrapper = ({ children }: { children: ReactNode }) => <UncageProvider client={f.client}>{children}</UncageProvider>;
  const { result } = renderHook(() => useDeviceApproval('ABCD-EFGH'), { wrapper });
  await waitFor(() => expect(result.current.state).toBe('idle'));
  await act(() => result.current.approve());
  await act(() => result.current.approve());
  const warned = warn.mock.calls.filter((c) => String(c[0]).includes('useDeviceApproval'));
  expect(warned).toHaveLength(1);
  expect(String(warned[0]![0])).toContain('last 4 characters');
  expect(f.client.decideDevice).not.toHaveBeenCalled();
});
