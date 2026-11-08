import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOnce, toNextHandlers } from './fetch-adapters.js';
import { createHub } from './hub.js';
import { pgliteHubStore } from './node/index.js';
import { connectFakeAgent, fakeMachine, startTestHub, USER_HEADER } from './test-utils.js';
import type { Hub } from './types.js';

type Info = { clientIp?: string; waitUntil?(p: Promise<unknown>): void };

/** A stand-in hub: records `fetch` calls and `close`. */
function fakeHub(respond: (req: Request, info?: Info) => Response | Promise<Response> = () => new Response('ok')) {
  const fetch = vi.fn(async (req: Request, info?: Info) => respond(req, info));
  const close = vi.fn(async () => {});
  return { hub: { basePath: '/api/uncage', fetch, close } as unknown as Hub, fetch, close };
}

/** What a Next.js App Router route handler receives (a Web `Request` with the full URL). */
const nextReq = (method: string, path = '/api/uncage/machines', init: RequestInit = {}) =>
  new Request(`https://site.example${path}`, { method, ...init, ...(method === 'GET' || method === 'DELETE' ? {} : { body: init.body ?? '{}' }) });

/** A streamed body we control: `push` a chunk, `end` it. */
function controlledBody() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (ctl = c),
    cancel: cancelled,
  });
  return { stream, push: (s: string) => ctl.enqueue(new TextEncoder().encode(s)), end: () => ctl.close(), cancelled };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const NEXT_CTX = Symbol.for('@next/request-context');
const VERCEL_CTX = Symbol.for('@vercel/request-context');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[NEXT_CTX];
  delete (globalThis as Record<symbol, unknown>)[VERCEL_CTX];
  vi.unstubAllEnvs();
});

describe('toNextHandlers', () => {
  it('toNextHandlers calls a lazy getter once and routes every method to hub.fetch', async () => {
    const f = fakeHub();
    const getHub = vi.fn(async () => f.hub);
    const h = toNextHandlers(getHub);
    // Defining the route (what `next build` does) never creates the hub.
    expect(getHub).not.toHaveBeenCalled();
    const reqs = [nextReq('GET'), nextReq('POST', '/api/uncage/sessions'), nextReq('PATCH', '/api/uncage/sessions/s1'), nextReq('DELETE', '/api/uncage/machines/m1')];
    // Concurrent first requests share one hub.
    const res = await Promise.all([h.GET(reqs[0]!), h.POST(reqs[1]!), h.PATCH(reqs[2]!), h.DELETE(reqs[3]!)]);
    expect(await Promise.all(res.map((r) => r.text()))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(getHub).toHaveBeenCalledTimes(1);
    // The very Request object reaches the hub (its `signal` — Next aborts it on client disconnect — included).
    expect(f.fetch.mock.calls.map((c) => c[0])).toEqual(reqs);
    await h.GET(nextReq('GET'));
    expect(getHub).toHaveBeenCalledTimes(1);
  });

  it('accepts a hub or a promise of one', async () => {
    const a = fakeHub();
    expect(await (await toNextHandlers(a.hub).GET(nextReq('GET'))).text()).toBe('ok');
    const b = fakeHub();
    expect(await (await toNextHandlers(Promise.resolve(b.hub)).POST(nextReq('POST'))).text()).toBe('ok');
    expect(a.fetch).toHaveBeenCalledTimes(1);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed getter is not memoized: the next request tries again', async () => {
    const f = fakeHub();
    const getHub = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(f.hub);
    const h = toNextHandlers(getHub as () => Promise<Hub>);
    await expect(h.GET(nextReq('GET'))).rejects.toThrow('db down');
    expect((await h.GET(nextReq('GET'))).status).toBe(200);
    expect(getHub).toHaveBeenCalledTimes(2);
  });

  it('passes clientIp from the option; without one it passes none, so the hub applies its rateLimits rules', async () => {
    const f = fakeHub();
    await toNextHandlers(f.hub, { clientIp: (req) => req.headers.get('x-real-ip') ?? undefined }).GET(
      nextReq('GET', '/api/uncage/machines', { headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } }),
    );
    expect(f.fetch.mock.calls[0]![1]?.clientIp).toBe('203.0.113.7');
    await toNextHandlers(f.hub).GET(nextReq('GET', '/api/uncage/machines', { headers: { 'x-forwarded-for': '1.1.1.1' } }));
    expect(f.fetch.mock.calls[1]![1]?.clientIp).toBeUndefined();
  });

  it('on Vercel (VERCEL set) and no clientIp option: x-real-ip, else the first x-vercel-forwarded-for entry', async () => {
    const f = fakeHub();
    const h = toNextHandlers(f.hub);
    const ipOf = async (headers: Record<string, string>) => {
      await h.GET(nextReq('GET', '/api/uncage/machines', { headers }));
      return f.fetch.mock.calls.at(-1)![1]?.clientIp;
    };
    vi.stubEnv('VERCEL', '1');
    expect(await ipOf({ 'x-real-ip': '203.0.113.9', 'x-vercel-forwarded-for': '198.51.100.1', 'x-forwarded-for': '6.6.6.6' })).toBe('203.0.113.9');
    expect(await ipOf({ 'x-vercel-forwarded-for': '198.51.100.1, 10.0.0.1' })).toBe('198.51.100.1');
    expect(await ipOf({ 'x-forwarded-for': '6.6.6.6' })).toBeUndefined();
    // An explicit option wins on Vercel too.
    await toNextHandlers(f.hub, { clientIp: () => '192.0.2.5' }).GET(nextReq('GET', '/api/uncage/machines', { headers: { 'x-real-ip': '203.0.113.9' } }));
    expect(f.fetch.mock.calls.at(-1)![1]?.clientIp).toBe('192.0.2.5');
    // Off Vercel those headers are client-controlled: never used.
    vi.unstubAllEnvs();
    vi.stubEnv('VERCEL', '');
    expect(await ipOf({ 'x-real-ip': '203.0.113.9', 'x-vercel-forwarded-for': '198.51.100.1' })).toBeUndefined();
  });

  it("prefers Vercel's request context waitUntil over Next's", async () => {
    const f = fakeHub((_req, info) => {
      info?.waitUntil?.(Promise.resolve());
      return new Response('ok');
    });
    const used: string[] = [];
    const ctxOf = (name: string) => ({ name, waitUntil(this: { name: string }) { used.push(this.name); } });
    const next = ctxOf('next');
    const vercel = ctxOf('vercel');
    (globalThis as Record<symbol, unknown>)[NEXT_CTX] = { get: () => next };
    (globalThis as Record<symbol, unknown>)[VERCEL_CTX] = { get: () => vercel };
    await toNextHandlers(f.hub).GET(nextReq('GET'));
    delete (globalThis as Record<symbol, unknown>)[VERCEL_CTX];
    await toNextHandlers(f.hub).GET(nextReq('GET'));
    expect(used).toEqual(['vercel', 'next']);
  });

  it('passes the given waitUntil (e.g. Next `after`), else the platform request context’s waitUntil bound to it', async () => {
    const f = fakeHub((_req, info) => {
      info?.waitUntil?.(Promise.resolve('bg'));
      return new Response('ok');
    });
    const after = vi.fn();
    await toNextHandlers(f.hub, { waitUntil: after }).GET(nextReq('GET'));
    expect(after).toHaveBeenCalledTimes(1);

    // Vercel (and Next's edge sandbox) expose `globalThis[Symbol.for('@next/request-context')].get().waitUntil`.
    const seen: unknown[] = [];
    const ctx = {
      promises: seen,
      waitUntil(this: { promises: unknown[] }, p: Promise<unknown>) {
        this.promises.push(p); // throws if called unbound
      },
    };
    (globalThis as Record<symbol, unknown>)[NEXT_CTX] = { get: () => ctx };
    await toNextHandlers(f.hub).GET(nextReq('GET'));
    expect(seen).toHaveLength(1);

    // No platform context (e.g. plain `next start` without `after`): no waitUntil, the hub runs maintenance inline.
    delete (globalThis as Record<symbol, unknown>)[NEXT_CTX];
    await toNextHandlers(f.hub).GET(nextReq('GET'));
    expect(f.fetch.mock.calls[2]![1]?.waitUntil).toBeUndefined();
  });

  it('routes Next-style requests through a real hub (install script, 401 without a user, unknown path 404)', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const hub = await createHub({ publicUrl: 'https://site.example', getUser: async () => null, store });
    try {
      const h = toNextHandlers(() => hub);
      const script = await h.GET(nextReq('GET', '/api/uncage/install.sh'));
      expect(script.status).toBe(200);
      expect(await script.text()).toContain('uncage');
      expect((await h.GET(nextReq('GET', '/api/uncage/machines'))).status).toBe(401);
      expect((await h.POST(nextReq('POST', '/api/uncage/nope'))).status).toBe(404);
    } finally {
      await hub.close();
      await store.close();
    }
  });
  it('aborting the route handler request (Next does on client disconnect) ends a streaming SSE response', async () => {
    const t = await startTestHub({ sseHeartbeatMs: 20 });
    try {
      const fm = fakeMachine();
      const { machineToken } = await t.pair('alice');
      const agent = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
      const s = (await (await t.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) })).json()) as { id: string };
      const ac = new AbortController();
      const req = new Request(`${t.api}/sessions/${s.id}/events?after=0`, {
        headers: { accept: 'text/event-stream', [USER_HEADER]: 'alice' },
        signal: ac.signal,
      });
      const res = await toNextHandlers(() => t.hub).GET(req);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      ac.abort();
      // Drains to the end promptly (no more heartbeats after the abort).
      const ended = (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })().catch(() => true);
      expect(await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 2000))])).toBe(true);
      agent.close();
    } finally {
      await t.close();
    }
  });
});

describe('fetchOnce', () => {
  it('fetchOnce closes the hub only after a streamed body finished or was cancelled', async () => {
    // Finished.
    const body = controlledBody();
    const f = fakeHub(() => new Response(body.stream));
    const res = await fetchOnce(async () => f.hub, nextReq('GET'));
    const reader = res.body!.getReader();
    body.push('a');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('a');
    await flush();
    expect(f.close).not.toHaveBeenCalled();
    body.end();
    expect((await reader.read()).done).toBe(true);
    await flush();
    expect(f.close).toHaveBeenCalledTimes(1);

    // Cancelled (the client went away).
    const body2 = controlledBody();
    const g = fakeHub(() => new Response(body2.stream));
    const res2 = await fetchOnce(async () => g.hub, nextReq('GET'));
    await flush();
    expect(g.close).not.toHaveBeenCalled();
    await res2.body!.cancel('gone');
    await flush();
    expect(body2.cancelled).toHaveBeenCalledWith('gone');
    expect(g.close).toHaveBeenCalledTimes(1);
  });

  it('keeps status and headers, passes clientIp, and hands the close to waitUntil', async () => {
    const f = fakeHub(() => new Response('{"a":1}', { status: 201, headers: { 'content-type': 'application/json', 'x-k': 'v' } }));
    const waited: Promise<unknown>[] = [];
    const req = nextReq('POST');
    const res = await fetchOnce(async () => f.hub, req, { clientIp: '198.51.100.2', waitUntil: (p) => void waited.push(p) });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-k')).toBe('v');
    expect(f.fetch.mock.calls[0]![0]).toBe(req);
    expect(f.fetch.mock.calls[0]![1]?.clientIp).toBe('198.51.100.2');
    expect(await res.json()).toEqual({ a: 1 });
    await flush();
    // The hub's own background work and the close both go to waitUntil, so the platform keeps the isolate alive.
    expect(waited.length).toBeGreaterThanOrEqual(1);
    await Promise.all(waited);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('a response without a body closes at once; then { close } and deferred cleanups (last first)', async () => {
    const order: string[] = [];
    const f = fakeHub(() => new Response(null, { status: 204 }));
    f.close.mockImplementation(async () => void order.push('hub'));
    const res = await fetchOnce(async (defer) => {
      defer(() => void order.push('pool'));
      defer(async () => void order.push('client'));
      return { hub: f.hub, close: async () => void order.push('created') };
    }, nextReq('DELETE'));
    expect(res.status).toBe(204);
    await flush();
    expect(order).toEqual(['hub', 'created', 'client', 'pool']);
  });

  it('create() rejecting after opening a pool: the deferred cleanup closes it (via waitUntil), the error is rethrown', async () => {
    const pool = { end: vi.fn(async () => {}) };
    const waited: Promise<unknown>[] = [];
    await expect(
      fetchOnce(
        async (defer) => {
          defer(() => pool.end());
          throw new Error('migration failed');
        },
        nextReq('GET'),
        { waitUntil: (p) => void waited.push(p) },
      ),
    ).rejects.toThrow('migration failed');
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('a failing cleanup is logged and the others still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeHub();
    const end = vi.fn();
    const res = await fetchOnce(async (defer) => {
      defer(end);
      return { hub: f.hub, close: () => Promise.reject(new Error('close failed')) };
    }, nextReq('GET'));
    expect(await res.text()).toBe('ok');
    await flush();
    await flush();
    expect(err).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('a hub.fetch that throws still closes the hub; a failing create() rejects', async () => {
    const f = fakeHub(() => {
      throw new Error('boom');
    });
    await expect(fetchOnce(async () => f.hub, nextReq('GET'))).rejects.toThrow('boom');
    await flush();
    expect(f.close).toHaveBeenCalledTimes(1);
    await expect(fetchOnce(() => Promise.reject(new Error('no db')), nextReq('GET'))).rejects.toThrow('no db');
  });

  it('a close that fails is logged, never thrown into the response', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeHub();
    f.close.mockRejectedValue(new Error('close failed'));
    const res = await fetchOnce(async () => f.hub, nextReq('GET'));
    expect(await res.text()).toBe('ok');
    await flush();
    await flush();
    expect(err).toHaveBeenCalled();
  });

  it('serves a real hub per request and closes it after the response', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    let close: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const res = await fetchOnce(async () => {
        const hub = await createHub({ publicUrl: 'https://site.example', getUser: async () => null, store });
        close = vi.spyOn(hub, 'close');
        return hub;
      }, nextReq('GET', '/api/uncage/install.sh'));
      expect(res.status).toBe(200);
      expect(close).not.toHaveBeenCalled();
      await res.text();
      await flush();
      expect(close).toHaveBeenCalledTimes(1);
      await close!.mock.results[0]!.value;
    } finally {
      await store.close();
    }
  });
});
