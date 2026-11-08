import type { UncageEvent } from '@uncage/protocol';
import { createUncageClient } from '@uncage/client';
import { describe, expect, it } from 'vitest';
import { eventStreamResponse, type EventSource } from './sse.js';
import { fakeSession, makeEvent, readSse, sleep } from './test-utils.js';

const ev = (n: number): UncageEvent =>
  n === 1
    ? makeEvent('ses_1', 1, 'session.created', { session: fakeSession('ses_1') })
    : makeEvent('ses_1', n, 'message.delta', { messageId: 'm1', chunkIndex: n, text: `${n}` });

/** A store whose history shows only what has been "committed"; live events are pushed by hand. */
function laggingSource(committed: number[], o: { occurredAt?: string } = {}) {
  const make = (n: number): UncageEvent => (o.occurredAt ? { ...ev(n), occurredAt: o.occurredAt } : ev(n));
  const subs = new Set<(e: UncageEvent[]) => void>();
  const src: EventSource = {
    async history(after, limit) {
      return committed
        .filter((n) => n > after)
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map(make);
    },
    async subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  const live = (...ns: number[]) => {
    for (const fn of subs) fn(ns.map(make));
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

describe('eventStreamResponse: history lagging during catch-up', () => {
  it('a missing event in history (3, 4 readable, 2 not yet) is waited for: the client gets 1, 2, 3, 4', async () => {
    const s = laggingSource([1, 3, 4]);
    setTimeout(() => s.commit(2), 300);
    const fetch = async () => open(s.src);
    const seen: number[] = [];
    const states: string[] = [];
    const unsub = createUncageClient({ fetch }).subscribe('ses_1', {
      after: 0,
      onEvent: (e) => seen.push(e.sequence),
      onState: (st) => states.push(st),
    });
    const t0 = Date.now();
    while (seen.length < 4 && Date.now() - t0 < 3000) await sleep(10);
    unsub();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(states).toEqual(['connecting', 'live']);
  });

  it('a young gap in history that does not fill ends the stream with reconnect, never emitting past it', async () => {
    const s = laggingSource([1, 3]);
    const res = open(s.src, { gapWaitMs: 200 });
    const frames: Array<{ id?: string; event?: string }> = [];
    await collect(res, frames);
    expect(frames.map((f) => f.event)).toEqual(['session.created', 'reconnect']);
  });

  it('a gap whose next event is long past is a permanent hole: emitted past after the wait (no reconnect loop)', async () => {
    const s = laggingSource([1, 3], { occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
    const res = open(s.src, { gapWaitMs: 100 });
    const frames: Array<{ id?: string; event?: string }> = [];
    await collect(res, frames, ev(3).eventId);
    expect(frames.map((f) => f.id)).toEqual([ev(1).eventId, ev(3).eventId]);
    await res.body?.cancel().catch(() => undefined);
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
