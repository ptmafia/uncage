import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHub } from './hub.js';
import { maintenance } from './maintenance.js';
import { pgliteHubStore } from './node/index.js';
import type { HubStore, MachineRecord } from './store/store.js';
import type { Hub } from './types.js';

let store: HubStore;
const closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  store = await pgliteHubStore({ dataDir: 'memory://' });
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await store.close();
});

const silent = { warn: () => undefined, error: () => undefined };
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
const H = 3_600_000;
const D = 24 * H;

describe('maintenance()', () => {
  it('maybeRun runs at most once per interval per instance, and only while holding the lease', async () => {
    let now = 1_000_000;
    const task = vi.fn(async () => ({ x: 1 }));
    const onRun = vi.fn(async () => undefined);
    const a = maintenance({ store, nodeId: 'a', intervalMs: 1000, logger: silent, tasks: [task], onRun, now: () => now });
    const b = maintenance({ store, nodeId: 'b', intervalMs: 1000, logger: silent, tasks: [task], now: () => now });
    await a.maybeRun();
    await a.maybeRun();
    await b.maybeRun(); // lease held by a
    expect(task).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    now += 1001;
    await b.maybeRun(); // a's lease is over
    expect(task).toHaveBeenCalledTimes(2);
    await a.maybeRun(); // b holds it now
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('with waitUntil the run is handed to the platform instead of awaited', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let done = false;
    const m = maintenance({
      store,
      nodeId: 'a',
      intervalMs: 1000,
      logger: silent,
      tasks: [async () => {
        await gate;
        done = true;
        return {};
      }],
    });
    const handed: Array<Promise<unknown>> = [];
    await m.maybeRun((p) => handed.push(p));
    expect(handed).toHaveLength(1);
    expect(done).toBe(false);
    release();
    await handed[0];
    expect(done).toBe(true);
  });

  it('a failing task is logged and does not stop the others; interruptedToolCalls is reported apart', async () => {
    const errors: unknown[] = [];
    const m = maintenance({
      store,
      nodeId: 'a',
      intervalMs: 1000,
      logger: { warn: () => undefined, error: (o) => errors.push(o) },
      tasks: [
        async () => {
          throw new Error('boom');
        },
        async () => ({ outbox: 2, interruptedToolCalls: 3 }),
      ],
    });
    expect(await m.runNow()).toEqual({ ran: true, pruned: { outbox: 2 }, interruptedToolCalls: 3 });
    expect(errors).toHaveLength(1);
  });

  it('runNow reports ran: false while another instance holds the lease', async () => {
    const a = maintenance({ store, nodeId: 'a', intervalMs: 60_000, logger: silent, tasks: [] });
    const b = maintenance({ store, nodeId: 'b', intervalMs: 60_000, logger: silent, tasks: [] });
    expect((await a.runNow()).ran).toBe(true);
    expect(await b.runNow()).toEqual({ ran: false, pruned: {}, interruptedToolCalls: 0 });
    expect((await a.runNow()).ran).toBe(true); // its own lease renews
  });
});

describe('hub.maintain()', () => {
  const machine = (id: string): MachineRecord => ({
    id, userId: 'alice', tokenHash: `h_${id}`, name: id, os: 'darwin', agentVersion: '0.3.0', runtimes: [], createdAt: iso(), lastSeenAt: iso(),
  });
  async function hub(): Promise<Hub> {
    const h = await createHub({ publicUrl: 'https://app.example', store, getUser: async () => null, attachmentRetentionDays: 30 });
    closers.push(() => h.close());
    return h;
  }

  it('prunes expired outbox rows, done inbox rows older than a day, old rate-limit windows, unbound manifests and old attachments', async () => {
    await store.insertMachine(machine('m1'));
    await store.openLink('m1', { linkId: 'l1', transport: 'http', at: iso() });
    const msg = { t: 'ping', at: 1 } as const;
    await store.enqueueOutbox('m1', [{ msgId: 'old', msg, expiresAt: iso(-1000) }, { msgId: 'live', msg, expiresAt: iso(H) }], iso());
    await store.completeInbox('m1', ['done_2d'], iso(-2 * D));
    await store.completeInbox('m1', ['done_1h'], iso(-H));
    await store.hitRateLimit('device_code:x', { max: 5, windowMs: 60_000, nowMs: Date.now() - 2 * H });
    await store.hitRateLimit('device_code:y', { max: 5, windowMs: 60_000, nowMs: Date.now() });
    await store.putRunManifest({ key: 'unbound_old', sessionId: 's', tools: [], createdAt: iso(-2 * H), nonce: 'n' });
    await store.putRunManifest({ key: 'unbound_new', sessionId: 's', tools: [], createdAt: iso(), nonce: 'n' });
    const att = (id: string, createdAt: string) => ({ id, sessionId: 's', name: `${id}.txt`, mime: 'text/plain', size: 1, kind: 'file' as const, sha256: 'x', createdAt });
    await store.putAttachment({ attachment: att('att_old', iso(-40 * D)), userId: 'alice', data: new Uint8Array([1]), machineId: 'm1' });
    await store.putAttachment({ attachment: att('att_new', iso()), userId: 'alice', data: new Uint8Array([1]), machineId: 'm1' });

    const h = await hub();
    expect(await h.maintain()).toEqual({
      ran: true,
      pruned: { runManifests: 1, attachments: 1, outbox: 1, inbox: 1, rateLimits: 1, deviceCodes: 0 },
      interruptedToolCalls: 0,
    });
    expect((await store.pollLink('m1', 'l1', { after: 0, limit: 10, now: iso(-2000) })).items.map((i) => i.msgId)).toEqual(['live']);
    expect(await store.claimInbox('m1', ['done_2d', 'done_1h'], { leaseUntil: iso(1000), now: iso() })).toEqual({ done_2d: 'new', done_1h: 'done' });
    expect(await store.getAttachment('att_old')).toBeNull();
    expect(await store.getAttachment('att_new')).not.toBeNull();
  });

  it('a throwing waitUntil (e.g. an unbound ctx.waitUntil) never fails the request: maintenance runs inline', async () => {
    const warns: unknown[] = [];
    const h = await createHub({
      publicUrl: 'https://app.example',
      store,
      getUser: async () => ({ id: 'alice' }),
      logger: { warn: (o) => warns.push(o), error: () => undefined },
    });
    closers.push(() => h.close());
    const prune = vi.spyOn(store, 'pruneTransport');
    const res = await h.fetch(new Request('https://app.example/api/uncage/health'), {
      waitUntil: () => {
        throw new TypeError('Illegal invocation');
      },
    });
    expect(res.status).toBe(200);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(warns).toHaveLength(1);
  });

  it('maintain() after close() reports ran: false', async () => {
    const h = await createHub({ publicUrl: 'https://app.example', store, getUser: async () => null });
    await h.close();
    expect(await h.maintain()).toEqual({ ran: false, pruned: {}, interruptedToolCalls: 0 });
  });

  it('close() waits for a maintenance run still in flight', async () => {
    const h = await createHub({ publicUrl: 'https://app.example', store, getUser: async () => null });
    const prune = vi.spyOn(store, 'pruneTransport');
    let finished = false;
    prune.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 100));
      finished = true;
      return { outbox: 0, inbox: 0, rateLimits: 0, deviceCodes: 0 };
    });
    await h.fetch(new Request('https://app.example/api/uncage/health'), { waitUntil: () => undefined });
    await h.close();
    expect(finished).toBe(true);
  });
});
