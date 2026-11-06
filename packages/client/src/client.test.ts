import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUncageClient, UncageClientError, type ConnectionState } from './index.js';

type F = (u: string | URL | Request, i?: RequestInit) => Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const evt = (sequence: number) => ({
  eventId: `evt_${String(sequence).padStart(10, '0')}`,
  sequence,
  sessionId: 'ses_1',
  type: 'run.cancelled',
  occurredAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: '1.0',
  payload: { runId: 'run_1' },
});
const frame = (sequence: number) => `id: ${evt(sequence).eventId}\ndata: ${JSON.stringify(evt(sequence))}\n\n`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('REST', () => {
  it('error body becomes UncageClientError with code+hint', async () => {
    const fetch = vi.fn<F>(async () =>
      json({ error: { code: 'session_busy', message: 'busy', hint: 'wait', retryable: false, requestId: 'r' } }, 409),
    );
    const client = createUncageClient({ fetch });
    const err = await client.snapshot('ses_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncageClientError);
    expect(err).toMatchObject({ code: 'session_busy', hint: 'wait', status: 409, retryable: false });
    expect(fetch.mock.calls[0]![0]).toBe('/api/uncage/sessions/ses_1');
  });

  it('startRun sends Idempotency-Key', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'run_1' }, 202));
    const client = createUncageClient({ fetch, headers: () => ({ 'x-a': 'b' }) });
    await client.startRun('ses_1', { prompt: 'hi' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/uncage/sessions/ses_1/runs');
    const h = init!.headers as Record<string, string>;
    expect(h['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h['x-a']).toBe('b');
    expect(init!.body).toBe('{"prompt":"hi"}');
  });

  it('cancelRun sends an empty JSON object body', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'run_1' }, 202));
    await createUncageClient({ fetch }).cancelRun('run_1');
    expect(fetch.mock.calls[0]![1]!.body).toBe('{}');
  });
});

describe('subscribe', () => {
  it('reconnects with Last-Event-ID after stream end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi
      .fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(sseResponse([frame(1), frame(2)]))
      .mockImplementation(async () => sseResponse([frame(3)]));
    const events: number[] = [];
    const states: ConnectionState[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => events.push(e.sequence),
      onState: (s) => states.push(s),
    });
    await vi.advanceTimersByTimeAsync(1000);
    unsub();
    expect(events.slice(0, 3)).toEqual([1, 2, 3]);
    expect(fetch.mock.calls[0]![0]).toBe('/api/uncage/sessions/ses_1/events?after=0');
    const second = fetch.mock.calls[1]!;
    expect(second[0]).toBe('/api/uncage/sessions/ses_1/events?after=2');
    expect((second[1]!.headers as Record<string, string>)['last-event-id']).toBe(evt(2).eventId);
    expect(states.slice(0, 3)).toEqual(['connecting', 'live', 'reconnecting']);
  });

  it('replay_unavailable → onError, no reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = { code: 'event_replay_unavailable', message: 'gone', retryable: false };
    const fetch = vi.fn(async () => sseResponse([`event: error\ndata: ${JSON.stringify(body)}\n\n`]));
    const errors: UncageClientError[] = [];
    createUncageClient({ fetch }).subscribe('ses_1', { after: 5, onEvent: () => undefined, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors.map((e) => e.code)).toEqual(['event_replay_unavailable']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe aborts the in-flight fetch and stops reconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<F>(async (_u, i) => {
      signal = i?.signal ?? undefined;
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', { after: 0, onEvent: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('skips malformed frames with a single warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(async () => sseResponse(['data: {"nope":1}\n\n', 'data: not json\n\n', frame(1)]));
    const events: number[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', { after: 0, onEvent: (e) => events.push(e.sequence) });
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    expect(events).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
