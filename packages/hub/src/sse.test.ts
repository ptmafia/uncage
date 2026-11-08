import type { UncageEvent } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { eventStreamResponse, type EventSource } from './sse.js';
import { fakeSession, makeEvent, readSse, sleep } from './test-utils.js';

const ev = (n: number): UncageEvent =>
  n === 1
    ? makeEvent('ses_1', 1, 'session.created', { session: fakeSession('ses_1') })
    : makeEvent('ses_1', n, 'message.delta', { messageId: 'm1', chunkIndex: n, text: `${n}` });

/** A store whose history shows only what has been "committed"; live events are pushed by hand. */
function laggingSource(committed: number[]) {
  const subs = new Set<(e: UncageEvent[]) => void>();
  const src: EventSource = {
    async history(after, limit) {
      return committed
        .filter((n) => n > after)
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map(ev);
    },
    async subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  const live = (...ns: number[]) => {
    for (const fn of subs) fn(ns.map(ev));
  };
  return { src, live, commit: (n: number) => committed.push(n), subscribed: () => subs.size > 0 };
}

const open = (src: EventSource, o: { gapWaitMs?: number; maxDurationMs?: number } = {}) =>
  eventStreamResponse(src, {
    after: 0,
    heartbeatMs: 10_000,
    maxDurationMs: o.maxDurationMs ?? 10_000,
    ...(o.gapWaitMs !== undefined ? { gapWaitMs: o.gapWaitMs } : {}),
    signals: [],
    requestId: 'req_1',
  });

async function collect(res: Response, frames: Array<{ id?: string; event?: string }>, stopAfter?: string) {
  for await (const f of readSse(res)) {
    if (f.comment) continue;
    frames.push(f);
    if (stopAfter && f.id === stopAfter) return;
  }
}

describe('eventStreamResponse: history lagging the live queue', () => {
  it('waits for the missing event in history and emits in order', async () => {
    const s = laggingSource([1]);
    const ac = new AbortController();
    const res = open(s.src, { gapWaitMs: 2000 });
    const frames: Array<{ id?: string; event?: string }> = [];
    const reading = collect(res, frames, ev(3).eventId);
    while (!s.subscribed()) await sleep(5);
    // 3 arrives live while 2 is not readable from history yet.
    s.live(3);
    await sleep(150);
    expect(frames.map((f) => f.id)).toEqual([ev(1).eventId]);
    s.commit(2);
    s.commit(3);
    await reading;
    expect(frames.map((f) => f.id)).toEqual([ev(1).eventId, ev(2).eventId, ev(3).eventId]);
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  });

  it('never emits past a gap: a still-missing event ends the stream with reconnect', async () => {
    const s = laggingSource([1]);
    const t0 = Date.now();
    const res = open(s.src, { gapWaitMs: 200 });
    const frames: Array<{ id?: string; event?: string }> = [];
    const reading = collect(res, frames);
    while (!s.subscribed()) await sleep(5);
    s.live(3);
    await reading;
    expect(frames.map((f) => f.event)).toEqual(['session.created', 'reconnect']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('reconnect event name', () => {
  it('@uncage/client and @uncage/server/wire agree on it', async () => {
    const client = await import('@uncage/client');
    const wire = await import('@uncage/server/wire');
    expect(client.STREAM_RECONNECT_EVENT).toBe(wire.STREAM_RECONNECT_EVENT);
    expect(wire.formatReconnectFrame()).toBe(`event: ${client.STREAM_RECONNECT_EVENT}\ndata: {}\n\n`);
  });
});
