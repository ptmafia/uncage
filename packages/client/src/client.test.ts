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

  it('a non-JSON error response and a network failure become tagged internal_error', async () => {
    const html = createUncageClient({ fetch: (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as F as typeof fetch });
    await expect(html.listSessions()).rejects.toMatchObject({ code: 'internal_error', status: 502, details: { reason: 'http_status', status: 502 } });
    const down = createUncageClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as F as typeof fetch,
    });
    const err = await down.listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncageClientError);
    expect(err).toMatchObject({ code: 'internal_error', status: 0, details: { reason: 'network' } });
    // An aborted upload still rejects with the abort, not a network error.
    const ac = new AbortController();
    ac.abort();
    const aborting = createUncageClient({
      fetch: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as F as typeof fetch,
    });
    await expect(aborting.uploadAttachment('ses_1', new File(['x'], 'a.md'), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
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

  it('updateSettings uses PATCH', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'ses_1' }));
    await createUncageClient({ fetch }).updateSettings('ses_1', { effort: 'high' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/uncage/sessions/ses_1/settings');
    expect(init!.method).toBe('PATCH');
    expect(init!.body).toBe('{"effort":"high"}');
  });

  it('upload sends raw blob + headers and parses Attachment', async () => {
    const att = { id: 'att_1', name: 'a b.png' };
    const fetch = vi.fn<F>(async () => json(att, 201));
    const file = new File([new Uint8Array([1, 2])], 'a b.png', { type: 'image/png' });
    const ctl = new AbortController();
    const out = await createUncageClient({ fetch, headers: () => ({ 'x-a': 'b' }) }).uploadAttachment('ses_1', file, {
      signal: ctl.signal,
    });
    expect(out).toEqual(att);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/uncage/sessions/ses_1/attachments');
    expect(init!.method).toBe('POST');
    expect(init!.body).toBe(file);
    expect(init!.signal).toBe(ctl.signal);
    const h = init!.headers as Record<string, string>;
    expect(h['content-type']).toBe('image/png');
    expect(h['x-filename']).toBe('a%20b.png');
    expect(h['x-a']).toBe('b');
  });

  it.each([
    ['', 'p.PNG', 'image/png'],
    ['', 'p.jpg', 'image/jpeg'],
    ['', 'p.jpeg', 'image/jpeg'],
    ['', 'p.gif', 'image/gif'],
    ['', 'p.webp', 'image/webp'],
    ['image/jpg', 'p.jpg', 'image/jpeg'],
    ['', 'notes.md', 'application/octet-stream'],
    ['', 'noext', 'application/octet-stream'],
    ['text/markdown', 'notes.md', 'text/markdown'],
  ])('upload content-type for type %j name %s is %s', async (type, name, expected) => {
    const fetch = vi.fn<F>(async () => json({ id: 'att_1' }, 201));
    await createUncageClient({ fetch }).uploadAttachment('s', new File(['x'], name, { type }));
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)['content-type']).toBe(expected);
  });

  it('413 becomes UncageClientError attachment_too_large', async () => {
    const fetch = vi.fn<F>(async () =>
      json({ error: { code: 'attachment_too_large', message: 'big', retryable: false, requestId: 'r' } }, 413),
    );
    const err = await createUncageClient({ fetch })
      .uploadAttachment('s', new File(['x'], 'a.png', { type: 'image/png' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncageClientError);
    expect(err).toMatchObject({ code: 'attachment_too_large', status: 413 });
  });

  it('attachmentUrl builds from baseUrl', () => {
    expect(createUncageClient({ baseUrl: '/x/' }).attachmentUrl('att 1')).toBe('/x/attachments/att%201');
  });

  it('listActiveRuns GET /runs?active=1', async () => {
    const fetch = vi.fn<F>(async () => json([{ runId: 'run_1' }]));
    expect(await createUncageClient({ fetch }).listActiveRuns()).toEqual([{ runId: 'run_1' }]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/uncage/runs?active=1');
    expect(init!.method).toBe('GET');
  });

  it('startRun forwards attachmentIds', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'run_1' }, 202));
    await createUncageClient({ fetch }).startRun('ses_1', { prompt: 'hi', attachmentIds: ['a1'] });
    expect(fetch.mock.calls[0]![1]!.body).toBe('{"prompt":"hi","attachmentIds":["a1"]}');
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
    const states: ConnectionState[] = [];
    createUncageClient({ fetch }).subscribe('ses_1', {
      after: 5,
      onEvent: () => undefined,
      onState: (s) => states.push(s),
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors.map((e) => e.code)).toEqual(['event_replay_unavailable']);
    expect(states.at(-1)).toBe('offline');
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

  it('a throwing onEvent does not tear down the stream or reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const fetch = vi.fn<F>(async () => sseResponse([frame(1), frame(2)]));
    const events: number[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => {
        events.push(e.sequence);
        if (e.sequence === 1) throw new Error('reducer bug');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    await new Promise((r) => setImmediate(r));
    process.off('uncaughtException', onUncaught);
    expect(events).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(uncaught).toHaveLength(1);
  });

  it('transient failures drive state only; terminal 4xx calls onError and goes offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const err = (code: string, status: number) =>
      json({ error: { code, message: 'm', retryable: status >= 500 } }, status);
    const fetch = vi
      .fn<F>()
      .mockResolvedValueOnce(err('internal_error', 503))
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(err('not_found', 404));
    const errors: string[] = [];
    const states: ConnectionState[] = [];
    createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: () => undefined,
      onState: (s) => states.push(s),
      onError: (e) => errors.push(e.code),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(errors).toEqual(['not_found']);
    expect(states).toEqual(['connecting', 'reconnecting', 'offline']);
  });

  it('a reconnect frame resumes at once with Last-Event-ID, no state change, no gap or duplicate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // A server that produces events 1..50 (one every 6 ms) and rotates each response after 100 ms.
    const log: number[] = [];
    const producer = setInterval(() => {
      if (log.length < 50) log.push(log.length + 1);
      else clearInterval(producer);
    }, 6);
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetch = vi.fn<F>(async (u, i) => {
      const headers = new Headers(i?.headers);
      requests.push({ url: String(u), headers });
      const lastId = headers.get('last-event-id');
      let sent = lastId ? Number(lastId.slice(4)) : Number(new URL(String(u), 'http://x').searchParams.get('after'));
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            const flush = () => {
              while (sent < log.length) c.enqueue(enc.encode(frame(++sent)));
            };
            flush();
            const tick = setInterval(flush, 3);
            setTimeout(() => {
              clearInterval(tick);
              flush();
              c.enqueue(enc.encode('event: reconnect\ndata: {}\n\n'));
              c.close();
            }, 100);
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: number[] = [];
    const states: ConnectionState[] = [];
    let lastIdOfFirstStream: string | undefined;
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => {
        seen.push(e.sequence);
        if (requests.length === 1) lastIdOfFirstStream = e.eventId;
      },
      onState: (s) => states.push(s),
    });
    await vi.advanceTimersByTimeAsync(330);
    unsub();
    expect(states).toEqual(['connecting', 'live']);
    expect(seen).toEqual(Array.from({ length: 50 }, (_, k) => k + 1));
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests[1]!.headers.get('last-event-id')).toBe(lastIdOfFirstStream);
    expect(requests[1]!.url).toBe(`/api/uncage/sessions/ses_1/events?after=${Number(lastIdOfFirstStream!.slice(4))}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a stream cut without the reconnect frame (platform timeout) still recovers with backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const times: number[] = [];
    const fetch = vi
      .fn<F>()
      // Cut mid-frame: the unterminated frame 3 is discarded and fetched again.
      .mockImplementationOnce(async () => {
        times.push(Date.now());
        return sseResponse([frame(1), frame(2), frame(3).slice(0, 20)]);
      })
      .mockImplementation(async () => {
        times.push(Date.now());
        return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(frame(3))) }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      });
    const seen: number[] = [];
    const states: ConnectionState[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => seen.push(e.sequence),
      onState: (s) => states.push(s),
    });
    await vi.advanceTimersByTimeAsync(2000);
    unsub();
    expect(seen).toEqual([1, 2, 3]);
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'live']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(375);
    expect((fetch.mock.calls[1]![1]!.headers as Record<string, string>)['last-event-id']).toBe(evt(2).eventId);
  });

  it('back-to-back reconnect frames with nothing in between back off instead of spinning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn<F>(async () => sseResponse(['event: reconnect\ndata: {}\n\n']));
    const states: ConnectionState[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', { after: 0, onEvent: () => undefined, onState: (s) => states.push(s) });
    await vi.advanceTimersByTimeAsync(3000);
    unsub();
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
    expect(states).toEqual(['connecting', 'live']);
  });
});

describe('structural guards (no zod in the browser path)', () => {
  it('isErrorBody accepts daemon error bodies and rejects partial ones', async () => {
    const { isErrorBody } = await import('./index.js');
    expect(isErrorBody({ code: 'session_busy', message: 'busy', retryable: false, hint: 'wait', details: { a: 1 } })).toBe(true);
    expect(isErrorBody({ code: 'session_busy', message: 'busy' })).toBe(false);
    expect(isErrorBody({ code: 1, message: 'x', retryable: true })).toBe(false);
    expect(isErrorBody({ code: 'x', message: 'x', retryable: true, hint: 3 })).toBe(false);
    expect(isErrorBody(null)).toBe(false);
  });

  it('isUncageEvent checks the envelope and lets unknown (newer) event types through', async () => {
    const { isUncageEvent } = await import('./index.js');
    expect(isUncageEvent(evt(1))).toBe(true);
    expect(isUncageEvent({ ...evt(1), type: 'future.thing' })).toBe(true);
    expect(isUncageEvent({ ...evt(1), sequence: -1 })).toBe(false);
    expect(isUncageEvent({ ...evt(1), sequence: 1.5 })).toBe(false);
    expect(isUncageEvent({ ...evt(1), payload: null })).toBe(false);
    expect(isUncageEvent({ ...evt(1), runId: 5 })).toBe(false);
    expect(isUncageEvent({ nope: 1 })).toBe(false);
  });

  it('isUncageEvent checks the ids React relies on for known types', async () => {
    const { isUncageEvent } = await import('./index.js');
    const e = (type: string, payload: unknown) => ({ ...evt(1), type, payload });
    expect(isUncageEvent(e('session.updated', { session: { id: 'ses_1' } }))).toBe(true);
    expect(isUncageEvent(e('session.created', { session: {} }))).toBe(false);
    expect(isUncageEvent(e('run.started', { run: { id: 'run_1' } }))).toBe(true);
    expect(isUncageEvent(e('run.started', { runId: 'run_1' }))).toBe(false);
    expect(isUncageEvent(e('run.completed', { runId: 'run_1', durationMs: 1 }))).toBe(true);
    expect(isUncageEvent(e('run.failed', {}))).toBe(false);
    expect(isUncageEvent(e('approval.requested', { approval: { id: 'apr_1' } }))).toBe(true);
    expect(isUncageEvent(e('approval.resolved', { approval: 'x' }))).toBe(false);
    expect(isUncageEvent(e('message.delta', { messageId: 'm1', chunkIndex: 0, text: 'x' }))).toBe(true);
    expect(isUncageEvent(e('message.delta', { chunkIndex: 0, text: 'x' }))).toBe(false);
    expect(isUncageEvent(e('tool.started', { toolId: 't1' }))).toBe(true);
    expect(isUncageEvent(e('tool.completed', {}))).toBe(false);
  });

  it('drops a malformed known-type frame with one warning and keeps streaming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = (seq: number) => `data: ${JSON.stringify({ ...evt(seq), type: 'run.completed', payload: {} })}\n\n`;
    const fetch = vi.fn(async () => sseResponse([bad(1), bad(2), frame(3)]));
    const events: number[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', { after: 0, onEvent: (ev) => events.push(ev.sequence) });
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    expect(events).toEqual([3]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-conforming error body becomes a generic http_status error', async () => {
    const fetch = vi.fn<F>(async () => json({ error: { code: 'session_busy' } }, 409));
    const err = await createUncageClient({ fetch }).listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncageClientError);
    expect(err).toMatchObject({ code: 'internal_error', status: 409, details: { reason: 'http_status', status: 409 } });
  });
});

describe('connected mode (hub machines)', () => {
  const machine = {
    id: 'mac_1',
    name: 'MacBook',
    os: 'darwin',
    agentVersion: '0.2.0',
    runtimes: [],
    online: true,
    lastSeenAt: '2026-11-07T00:00:00.000Z',
  };

  it('machines() GETs <base>/machines', async () => {
    const fetch = vi.fn<F>(async () => json([machine]));
    expect(await createUncageClient({ fetch, baseUrl: '/hub' }).machines()).toEqual([machine]);
    expect(fetch.mock.calls[0]![0]).toBe('/hub/machines');
    expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
  });

  it('machines() against a daemon (no /machines) rejects with status 404', async () => {
    const fetch = vi.fn<F>(async () => json({ error: { code: 'not_found', message: 'No route', retryable: false } }, 404));
    await expect(createUncageClient({ fetch }).machines()).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('installInfo() GETs <base>/machines/install', async () => {
    const info = { install: 'curl -fsSL https://x/install.sh | bash', setup: 'uncage setup https://x', windows: null };
    const fetch = vi.fn<F>(async () => json(info));
    expect(await createUncageClient({ fetch }).installInfo()).toEqual(info);
    expect(fetch.mock.calls[0]![0]).toBe('/api/uncage/machines/install');
  });

  it('revokeMachine() DELETEs <base>/machines/:id (encoded)', async () => {
    const fetch = vi.fn<F>(async () => json({ ok: true }));
    await createUncageClient({ fetch }).revokeMachine('mac 1');
    expect(fetch.mock.calls[0]![0]).toBe('/api/uncage/machines/mac%201');
    expect(fetch.mock.calls[0]![1]!.method).toBe('DELETE');
  });

  it('createSession forwards machineId', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'ses_1' }, 201));
    await createUncageClient({ fetch }).createSession({ runtime: 'claude', machineId: 'mac_1' });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ runtime: 'claude', machineId: 'mac_1' });
  });
});
