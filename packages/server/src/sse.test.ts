import { openPgliteStore } from '@uncage/core';
import type { UncageEvent } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { openSse, serverFactory, TOKEN, type TestServer } from './test-utils.js';

const servers = serverFactory();
afterEach(() => servers.closeAll());

const authz = { authorization: `Bearer ${TOKEN}` };
const parse = (data?: string) => JSON.parse(data ?? '') as UncageEvent;

async function finishedSession(s: TestServer) {
  const session = await s.uncage.sessions.create({ runtime: 'fake' });
  await session.startRun({ prompt: 'p' });
  for await (const e of session.events({ signal: AbortSignal.timeout(3000) })) if (e.type === 'run.completed') break;
  return session;
}

describe('SSE', () => {
  it('Last-Event-ID resumes without duplicates (T09)', async () => {
    const s = await servers.make([{ text: 'abcdef', chunks: 3 }, { waitMs: 100 }, { text: 'more', chunks: 2 }], { port: 0 });
    const base = await s.listen();
    const session = await s.uncage.sessions.create({ runtime: 'fake' });
    await session.startRun({ prompt: 'p' });

    const first = await openSse(`${base}/v1/sessions/${session.id}/events`, authz);
    const before = await first.until((f) => f.event === 'message.completed');
    first.close();
    const lastId = before.at(-1)?.id;
    expect(lastId).toMatch(/^evt_\d{10}$/);

    const second = await openSse(`${base}/v1/sessions/${session.id}/events?after=0`, {
      ...authz,
      'last-event-id': lastId ?? '',
    });
    const after = await second.until((f) => f.event === 'run.completed');
    second.close();

    const seqs = [...before, ...after].filter((f) => f.event).map((f) => parse(f.data).sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(parse(after[0]?.data).sequence).toBe(parse(before.at(-1)?.data).sequence + 1);
  });

  it('?after resumes when there is no Last-Event-ID', async () => {
    const s = await servers.make([{ text: 'hi' }], { port: 0 });
    const base = await s.listen();
    const session = await finishedSession(s);
    const sse = await openSse(`${base}/v1/sessions/${session.id}/events?after=3`, authz);
    const frames = await sse.until((f) => f.event === 'run.completed');
    sse.close();
    expect(parse(frames[0]?.data).sequence).toBe(4);
  });

  it('invalid Last-Event-ID → 400', async () => {
    const s = await servers.make([], { port: 0 });
    const base = await s.listen();
    const session = await s.uncage.sessions.create({ runtime: 'fake' });
    const res = await fetch(`${base}/v1/sessions/${session.id}/events`, { headers: { ...authz, 'last-event-id': 'garbage' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('unknown session → 404 JSON, not a stream', async () => {
    const s = await servers.make([], { port: 0 });
    const base = await s.listen();
    const res = await fetch(`${base}/v1/sessions/ses_nope/events`, { headers: authz });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('heartbeat comment sent', async () => {
    const s = await servers.make([], { port: 0, heartbeatMs: 20 });
    const base = await s.listen();
    const session = await s.uncage.sessions.create({ runtime: 'fake' });
    const sse = await openSse(`${base}/v1/sessions/${session.id}/events`, authz);
    const frames = await sse.until((f) => f.comment === 'ping');
    sse.close();
    expect(frames.at(-1)).toEqual({ comment: 'ping' });
  });

  it('event_replay_unavailable frame when pruned', async () => {
    const store = await openPgliteStore({ dataDir: 'memory://' });
    const s = await servers.make([{ text: 'hi' }], { port: 0 }, { store });
    const base = await s.listen();
    const session = await finishedSession(s);
    await store.pruneEvents(new Date(Date.now() + 60_000));

    const sse = await openSse(`${base}/v1/sessions/${session.id}/events?after=0`, authz);
    expect(sse.res.status).toBe(200);
    const frames = await sse.all();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('error');
    expect(frames[0]?.id).toBeUndefined();
    expect(JSON.parse(frames[0]?.data ?? '')).toMatchObject({ code: 'event_replay_unavailable', retryable: false });
  });

  it('client disconnect aborts the core event iterator', async () => {
    const s = await servers.make([], { port: 0 });
    const base = await s.listen();
    const session = await s.uncage.sessions.create({ runtime: 'fake' });
    const signals: AbortSignal[] = [];
    const get = s.uncage.sessions.get.bind(s.uncage.sessions);
    s.uncage.sessions.get = async (id) => {
      const h = await get(id);
      return {
        ...h,
        events: (opts) => {
          if (opts?.signal) signals.push(opts.signal);
          return h.events(opts);
        },
      };
    };
    const sse = await openSse(`${base}/v1/sessions/${session.id}/events`, authz);
    await sse.until((f) => f.event === 'session.created');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    sse.close();
    await expect.poll(() => signals[0]?.aborted).toBe(true);
  });

  it('server close ends open streams', async () => {
    const s = await servers.make([], { port: 0 });
    const base = await s.listen();
    const session = await s.uncage.sessions.create({ runtime: 'fake' });
    const sse = await openSse(`${base}/v1/sessions/${session.id}/events`, authz);
    await sse.until((f) => f.event === 'session.created');
    const reading = sse.all();
    await s.close();
    await expect(reading).resolves.toEqual([]);
  });
});
