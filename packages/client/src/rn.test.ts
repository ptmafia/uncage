import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUncageClient, parseSSE, type RNFile } from './index.js';

/**
 * A simulated React Native (Hermes + expo/fetch) environment: no `location`, `localStorage`,
 * `EventSource` or `crypto.randomUUID`; the app passes a fetch whose `Response.body` is a
 * `ReadableStream` read with `getReader()`.
 */
type F = (u: string | URL | Request, i?: RequestInit) => Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

/** An event stream the test pushes frames into; `hang` keeps it open (an app in the background). */
function liveStream(frames: string[], opts: { hang?: boolean } = {}) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (!opts.hang) c.close();
    },
  });
}
const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => {
  vi.stubGlobal('location', undefined);
  vi.stubGlobal('localStorage', undefined);
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('crypto', {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('@uncage/client in React Native', () => {
  it('streams events with a body-reader fetch and no EventSource', async () => {
    expect(globalThis.EventSource).toBeUndefined();
    const fetch = vi.fn<F>(async () => sse(liveStream([frame(1), frame(2)], { hang: true })));
    const events: number[] = [];
    const unsub = createUncageClient({ baseUrl: 'https://app.example/api/uncage', fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => events.push(e.sequence),
    });
    await vi.waitFor(() => expect(events).toEqual([1, 2]));
    unsub();
    expect(fetch.mock.calls[0]![0]).toBe('https://app.example/api/uncage/sessions/ses_1/events?after=0');
  });

  it('startRun and decide work without crypto.randomUUID (Hermes)', async () => {
    const fetch = vi.fn<F>(async () => json({ id: 'run_1' }, 202));
    const client = createUncageClient({ fetch });
    await client.startRun('ses_1', { prompt: 'hi' });
    await client.decide('apr_1', { decision: 'allow', scope: 'once' });
    const keys = fetch.mock.calls.map(([, i]) => (i!.headers as Record<string, string>)['idempotency-key']);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('async headers are awaited on every request and stream', async () => {
    let n = 0;
    const headers = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { authorization: `Bearer t${++n}` };
    };
    const fetch = vi.fn<F>(async (u) => {
      if (String(u).includes('/events')) return sse(liveStream([frame(1)], { hang: true }));
      if (String(u).includes('/attachments')) return json({ id: 'att_1' }, 201);
      return json([]);
    });
    const client = createUncageClient({ fetch, headers });
    await client.listSessions();
    await client.uploadAttachment('ses_1', new File(['x'], 'a.md'));
    const seen: number[] = [];
    const unsub = client.subscribe('ses_1', { after: 0, onEvent: (e) => seen.push(e.sequence) });
    await vi.waitFor(() => expect(seen).toEqual([1]));
    unsub();
    const auth = fetch.mock.calls.map(([, i]) => (i!.headers as Record<string, string>).authorization);
    expect(auth).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t3']);
  });

  it('uploads an RN file reference {uri,name,type}', async () => {
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    // React Native's built-in fetch reads file:// and content:// URIs into a Blob.
    const localFetch = vi.fn<F>(async () => new Response(photo));
    vi.stubGlobal('fetch', localFetch);
    const fetch = vi.fn<F>(async () => json({ id: 'att_1', name: 'IMG 1.jpg' }, 201));
    const file: RNFile = { uri: 'file:///data/user/0/cache/IMG_1.jpg', name: 'IMG 1.jpg', type: 'image/jpg' };
    const out = await createUncageClient({ fetch, headers: async () => ({ authorization: 'Bearer x' }) }).uploadAttachment(
      'ses_1',
      file,
    );
    expect(out).toEqual({ id: 'att_1', name: 'IMG 1.jpg' });
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(localFetch.mock.calls[0]![0]).toBe(file.uri);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/uncage/sessions/ses_1/attachments');
    expect(init!.method).toBe('POST');
    expect(init!.body).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (init!.body as Blob).arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    const h = init!.headers as Record<string, string>;
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['x-filename']).toBe('IMG%201.jpg');
    expect(h.authorization).toBe('Bearer x');
  });

  it('an unreadable RN file reference rejects with a network-tagged error before uploading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<F>(async () => {
        throw new TypeError('Network request failed');
      }),
    );
    const fetch = vi.fn<F>(async () => json({}, 201));
    const err = await createUncageClient({ fetch })
      .uploadAttachment('ses_1', { uri: 'file:///gone.jpg', name: 'gone.jpg', type: 'image/jpeg' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal_error', details: { reason: 'network' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reconnect() resumes after the last sequence without duplicates', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    // Worst case: the stream of a backgrounded app is torn down silently and the fetch ignores
    // the abort signal; the body just never yields again.
    const fetch = vi
      .fn<F>()
      .mockImplementationOnce(async (_u, i) => {
        signals.push(i!.signal!);
        return sse(liveStream([frame(1), frame(2)], { hang: true }));
      })
      .mockImplementation(async (_u, i) => {
        signals.push(i!.signal!);
        // The server replays from Last-Event-ID; an overlapping event must not be delivered twice.
        return sse(liveStream([frame(2), frame(3), frame(4)], { hang: true }));
      });
    const client = createUncageClient({ fetch });
    client.reconnect(); // no-op without subscriptions
    expect(fetch).not.toHaveBeenCalled();
    const events: number[] = [];
    const states: string[] = [];
    const unsub = client.subscribe('ses_1', {
      after: 0,
      onEvent: (e) => events.push(e.sequence),
      onState: (s) => states.push(s),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([1, 2]);
    // Minutes in the background: nothing arrives, no reconnect happens on its own.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Foreground: resume at once (no backoff wait).
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[0]!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('/api/uncage/sessions/ses_1/events?after=2');
    expect((init!.headers as Record<string, string>)['last-event-id']).toBe(evt(2).eventId);
    expect(events).toEqual([1, 2, 3, 4]);
    expect(states.at(-1)).toBe('live');
    unsub();
    expect(signals[1]!.aborted).toBe(true);
    client.reconnect(); // unsubscribed: nothing restarts
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reconnect() during the backoff wait retries at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi
      .fn<F>()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockImplementation(async () => sse(liveStream([frame(1)], { hang: true })));
    const client = createUncageClient({ fetch });
    const events: number[] = [];
    const unsub = client.subscribe('ses_1', { after: 0, onEvent: (e) => events.push(e.sequence) });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([1]);
    unsub();
  });

  it('reconnect() is not held up by a hung stream fetch that ignores its abort signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi
      .fn<F>()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockImplementation(async () => sse(liveStream([frame(1)], { hang: true })));
    const client = createUncageClient({ fetch });
    const events: number[] = [];
    const unsub = client.subscribe('ses_1', { after: 0, onEvent: (e) => events.push(e.sequence) });
    await vi.advanceTimersByTimeAsync(0);
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([1]);
    unsub();
  });

  it('lookupDevice / decideDevice call GET /device/lookup?code= and POST /device/decision', async () => {
    const lookup = { name: 'MacBook', os: 'darwin', expiresAt: '2026-11-09T00:10:00.000Z', repairsMachine: null };
    const fetch = vi.fn<F>(async (u, i) => {
      const url = String(u);
      if (url.startsWith('https://h.example/api/uncage/device/lookup?code=ABCD-EFGH')) return json(lookup);
      if (url.includes('/device/lookup')) return json(null);
      const body = JSON.parse(String(i!.body)) as { code: string; approve: boolean };
      return json({ result: body.code === 'OLD' ? 'expired' : body.approve ? 'ok' : 'not_found' });
    });
    const client = createUncageClient({ baseUrl: 'https://h.example/api/uncage/', fetch, headers: async () => ({ authorization: 'Bearer x' }) });
    await expect(client.lookupDevice('ABCD-EFGH')).resolves.toEqual(lookup);
    await expect(client.lookupDevice('a b&c')).resolves.toBeNull();
    expect(fetch.mock.calls[1]![0]).toBe('https://h.example/api/uncage/device/lookup?code=a%20b%26c');
    expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
    await expect(client.decideDevice('ABCD-EFGH', true)).resolves.toBe('ok');
    await expect(client.decideDevice('ABCD-EFGH', false)).resolves.toBe('not_found');
    await expect(client.decideDevice('OLD', true)).resolves.toBe('expired');
    const [url, init] = fetch.mock.calls[2]!;
    expect(url).toBe('https://h.example/api/uncage/device/decision');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ code: 'ABCD-EFGH', approve: true });
    const h = init!.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/json');
    expect(h.authorization).toBe('Bearer x');
  });

  it('device errors (rate_limited) reject with UncageClientError', async () => {
    const fetch = vi.fn<F>(async () =>
      json({ error: { code: 'rate_limited', message: 'slow down', retryable: true, details: { retryAfterSec: 60 } } }, 429),
    );
    await expect(createUncageClient({ fetch }).decideDevice('X', true)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });
});

describe('parseSSE without TextDecoder', () => {
  it('decodes split multi-byte UTF-8 without TextDecoder', async () => {
    const bytes = new TextEncoder().encode('data: héllo 你好🙂 ok\n\n');
    vi.stubGlobal('TextDecoder', undefined);
    expect(typeof TextDecoder).toBe('undefined');
    for (let i = 1; i < bytes.length; i++) {
      for (let j = i; j < bytes.length; j++) {
        const parts = [bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)].filter((p) => p.length > 0);
        const s = new ReadableStream<Uint8Array>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        });
        const frames = [];
        for await (const f of parseSSE(s)) frames.push(f);
        expect(frames).toEqual([{ data: 'héllo 你好🙂 ok' }]);
      }
    }
  });

  it('replaces invalid and truncated sequences with U+FFFD', async () => {
    vi.stubGlobal('TextDecoder', undefined);
    const bytes = new Uint8Array([...new TextEncoder().encode('data: a'), 0xff, 0x62, 0xe4, 0xbd, 0x0a, 0x0a]);
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const frames = [];
    for await (const f of parseSSE(s)) frames.push(f);
    expect(frames).toEqual([{ data: 'a�b�' }]);
  });
});
