import { describe, expect, it } from 'vitest';
import type { AttentionEvent } from '../attention.js';
import { EXPO_PUSH_ENDPOINT, expoPushNotifier } from './expo.js';

const event = (over: Partial<AttentionEvent> = {}): AttentionEvent => ({
  kind: 'approval_requested',
  userId: 'alice',
  sessionId: 'ses_1',
  sessionTitle: 'Fix the build',
  machineId: 'mch_1',
  machineName: 'MacBook',
  runtime: 'claude',
  approval: { id: 'apr_1', title: 'Run npm test', kind: 'shell' },
  at: new Date().toISOString(),
  ...over,
});
const ctx = { waitUntil: () => undefined };

type Msg = { to: string; title: string; body: string; data: Record<string, unknown> };

/** A fake Expo push endpoint: answers each message with a ticket (`ticket(to)` or ok). */
function fakeExpo(ticket: (to: string) => unknown = () => ({ status: 'ok', id: 'tkt' })) {
  const calls: Array<{ url: string; headers: Headers; messages: Msg[] }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const messages = JSON.parse(String(init?.body)) as Msg[];
    calls.push({ url: String(url), headers: new Headers(init?.headers), messages });
    return new Response(JSON.stringify({ data: messages.map((m) => ticket(m.to)) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const tokens = (n: number) => Array.from({ length: n }, (_, i) => `ExponentPushToken[t${i}]`);

describe('expoPushNotifier', () => {
  it('batches 250 tokens into 3 requests', async () => {
    const expo = fakeExpo();
    const notify = expoPushNotifier({ tokensFor: async (u) => (u === 'alice' ? tokens(250) : []), accessToken: 'secret', fetch: expo.fetch });
    await notify(event(), ctx);
    expect(expo.calls.map((c) => c.messages.length)).toEqual([100, 100, 50]);
    expect(expo.calls.every((c) => c.url === EXPO_PUSH_ENDPOINT)).toBe(true);
    expect(EXPO_PUSH_ENDPOINT).toBe('https://exp.host/--/api/v2/push/send');
    expect(expo.calls[0]!.headers.get('authorization')).toBe('Bearer secret');
    expect(expo.calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(expo.calls.flatMap((c) => c.messages.map((m) => m.to))).toEqual(tokens(250));
    expect(expo.calls[0]!.messages[0]).toMatchObject({
      to: 'ExponentPushToken[t0]',
      title: 'Approval needed',
      body: 'Fix the build: Run npm test',
      data: { sessionId: 'ses_1', approvalId: 'apr_1', kind: 'approval_requested' },
    });
    // Run ends carry no approvalId; no access token → no Authorization header.
    const expo2 = fakeExpo();
    await expoPushNotifier({ tokensFor: async () => tokens(1), fetch: expo2.fetch, endpoint: 'https://push.test/send' })(
      event({ kind: 'run_completed', approval: undefined }),
      ctx,
    );
    expect(expo2.calls[0]!.url).toBe('https://push.test/send');
    expect(expo2.calls[0]!.headers.get('authorization')).toBeNull();
    expect(expo2.calls[0]!.messages[0]!.data).toEqual({ sessionId: 'ses_1', kind: 'run_completed' });
    expect(expo2.calls[0]!.messages[0]).toMatchObject({ title: 'Run finished', body: 'Fix the build' });
    // No tokens: no request.
    const expo3 = fakeExpo();
    await expoPushNotifier({ tokensFor: async () => [], fetch: expo3.fetch })(event(), ctx);
    expect(expo3.calls).toHaveLength(0);
  });

  it('reports DeviceNotRegistered via onInvalidToken', async () => {
    const dead = 'ExponentPushToken[t1]';
    const expo = fakeExpo((to) =>
      to === dead
        ? { status: 'error', message: `"${to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered', expoPushToken: to } }
        : to === 'ExponentPushToken[t2]'
          ? { status: 'error', message: 'Message too big', details: { error: 'MessageTooBig' } }
          : { status: 'ok', id: 'x' },
    );
    const invalid: string[] = [];
    await expoPushNotifier({ tokensFor: async () => tokens(3), fetch: expo.fetch, onInvalidToken: (t) => void invalid.push(t) })(event(), ctx);
    expect(invalid).toEqual([dead]);
    // A failing request is reported (the hub logs it), not swallowed.
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(expoPushNotifier({ tokensFor: async () => tokens(1), fetch: failing })(event(), ctx)).rejects.toThrow(/500/);
  });

  it('message() null skips', async () => {
    const expo = fakeExpo();
    let asked = 0;
    const notify = expoPushNotifier({
      tokensFor: async () => (asked++, tokens(2)),
      fetch: expo.fetch,
      message: (e) => (e.kind === 'run_completed' ? null : { title: `T ${e.kind}`, body: 'B' }),
    });
    await notify(event({ kind: 'run_completed', approval: undefined }), ctx);
    expect(expo.calls).toHaveLength(0);
    expect(asked).toBe(0);
    await notify(event({ kind: 'run_failed', approval: undefined }), ctx);
    expect(expo.calls).toHaveLength(1);
    expect(expo.calls[0]!.messages[0]).toMatchObject({ title: 'T run_failed', body: 'B' });
  });
});
