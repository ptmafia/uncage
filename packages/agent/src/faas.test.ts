/**
 * The real SiteAgent (fake runtime adapter) against several in-process hub instances behind one
 * HTTP server (FaaS mode: no WebSocket server, every request may land on another instance).
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@uncage/hub';
import { CONNECTED_PROTOCOL, MAX_HTTP_BODY_BYTES, type MachineInfo, type Session, type UncageEvent } from '@uncage/protocol';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readActivity } from './activity.js';
import type { AgentSite } from './config.js';
import { DEFAULT_TIMING, SiteAgent, type AgentTiming } from './site.js';
import { FAST, memoryLogger, readSse, sleep, startFaasHubs, tmpHome, until, type FaasHubs, type MemoryLogger } from './test-helpers.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function faas(o: Parameters<typeof startFaasHubs>[0]): Promise<FaasHubs> {
  const h = await startFaasHubs(o);
  cleanups.push(() => h.close());
  return h;
}

interface Started {
  agent: SiteAgent;
  home: string;
  logger: MemoryLogger;
}

async function siteAgent(
  site: AgentSite,
  script: FakeStep[],
  o: { timing?: Partial<AgentTiming>; fetch?: typeof fetch; onUpgradeRequired?: (min: string | undefined) => Promise<number>; agentVersion?: string } = {},
): Promise<Started> {
  const { home, cleanup } = await tmpHome();
  cleanups.push(cleanup);
  const logger = memoryLogger();
  const agent = new SiteAgent({
    site,
    home,
    adapters: [createFakeAdapter({ script })],
    localPolicy: { allowBypass: false },
    logger,
    timing: { ...DEFAULT_TIMING, ...FAST, ...o.timing },
    machine: { name: 'Test Mac', os: 'darwin' },
    agentVersion: o.agentVersion ?? '0.3.0',
    ...(o.fetch ? { fetch: o.fetch } : {}),
    onStop: () => undefined,
    onUpgradeRequired: o.onUpgradeRequired ?? (async () => 60_000),
  });
  await agent.start();
  cleanups.push(() => agent.close());
  return { agent, home, logger };
}

/** Retries a browser request across connection cuts. */
async function browser(hubs: FaasHubs, path: string, init: RequestInit = {}): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await hubs.as('alice', path, init);
    } catch (err) {
      if (i > 50) throw err;
      await sleep(20);
    }
  }
}

const machines = async (hubs: FaasHubs): Promise<MachineInfo[]> => (await (await browser(hubs, '/machines')).json()) as MachineInfo[];
const online = (hubs: FaasHubs) => until(async () => (await machines(hubs))[0]?.online, 8000, 'machine online');

async function createSession(hubs: FaasHubs): Promise<Session> {
  const res = await hubs.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) });
  expect(res.status).toBe(201);
  return (await res.json()) as Session;
}

async function startRun(hubs: FaasHubs, sessionId: string, prompt = 'go'): Promise<void> {
  const res = await hubs.as('alice', `/sessions/${sessionId}/runs`, { method: 'POST', headers: { 'idempotency-key': `k-${Math.random()}` }, body: JSON.stringify({ prompt }) });
  expect(res.status).toBe(202);
}

const terminal = (evs: UncageEvent[]) => evs.find((e) => e.type === 'run.completed' || e.type === 'run.failed');

async function finished(hubs: FaasHubs, sessionId: string, timeoutMs = 15_000): Promise<UncageEvent[]> {
  return until(
    async () => {
      try {
        const res = await browser(hubs, `/sessions/${sessionId}/events?after=0`, { headers: { accept: 'application/json' } });
        if (res.status !== 200) return null;
        const all = (await res.json()) as UncageEvent[];
        return terminal(all) ? all : null;
      } catch {
        return null;
      }
    },
    timeoutMs,
    'run finished',
  );
}

const commandsRun = async (home: string, site: AgentSite, op: string) => (await readActivity(home, site.id)).filter((e) => e.kind === 'command' && e.name === op);

/** Wraps `fetch`: the first stream chunk that matches `hit` is swallowed and the stream dies (a drop after the hub wrote it). */
function dropOnce(hit: (chunk: string) => boolean) {
  let armed = true;
  let matches = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (!String(input).includes('/agent/stream') || !res.body) return res;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        let r;
        try {
          r = await reader.read();
        } catch (err) {
          return c.error(err);
        }
        if (r.done) return c.close();
        if (hit(dec.decode(r.value))) {
          matches++;
          if (armed) {
            armed = false;
            await reader.cancel().catch(() => undefined);
            return c.error(new Error('connection lost'));
          }
        }
        c.enqueue(r.value);
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetch: f, matches: () => matches, fired: () => !armed };
}

describe('real agent over HTTP streaming (FaaS hubs)', () => {
  it('connects over HTTP when the site offers only http and runs a session end to end', async () => {
    const hubs = await faas({ n: 3 });
    const site = await hubs.pair('alice');
    const { agent, logger } = await siteAgent(site, [{ text: 'Hello over HTTP', chunks: 3 }]);
    await online(hubs);
    expect(agent.transport).toBe('http');
    expect((await machines(hubs))[0]).toMatchObject({ online: true, transport: 'http', runtimes: [expect.objectContaining({ id: 'fake' })] });

    const session = await createSession(hubs);
    await startRun(hubs, session.id);
    const evs = await finished(hubs, session.id);
    expect(terminal(evs)?.type).toBe('run.completed');
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'Hello over HTTP')).toBe(true);
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    // Requests were spread over the instances.
    expect(new Set(hubs.requests.map((r) => r.i)).size).toBe(3);
    expect(logger.lines.some((l) => l.msg === 'connected' && (l.obj as { transport?: string }).transport === 'http')).toBe(true);
  });

  it('cut after delivery before processing: command executed once', async () => {
    const hubs = await faas({ n: 3 });
    const site = await hubs.pair('alice');
    // The hub writes the startRun command, the connection dies before the agent reads it.
    const cut = dropOnce((chunk) => chunk.includes('"op":"startRun"'));
    const { home } = await siteAgent(site, [{ text: 'once' }], { fetch: cut.fetch });
    await online(hubs);
    const session = await createSession(hubs);
    await startRun(hubs, session.id);
    const evs = await finished(hubs, session.id);
    expect(cut.fired()).toBe(true);
    expect(cut.matches()).toBeGreaterThanOrEqual(2); // redelivered on the reopened stream
    expect(evs.filter((e) => e.type === 'run.started')).toHaveLength(1);
    expect(terminal(evs)?.type).toBe('run.completed');
    expect(await commandsRun(home, site, 'startRun')).toHaveLength(1);
    expect(await commandsRun(home, site, 'createSession')).toHaveLength(1);
  });

  it('cut after processing before the ack: not executed again (cursor resume), the lost result reply is retried with the same id', async () => {
    const hubs = await faas({ n: 3 });
    const site = await hubs.pair('alice');
    let streamCut = false;
    let replyLost = false;
    const resultIds: string[] = [];
    const cursors: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/agent/stream')) cursors.push(new URL(url).searchParams.get('cursor') ?? '');
      if (url.endsWith('/agent/events') && typeof init?.body === 'string' && init.body.includes('"t":"result"')) {
        const body = JSON.parse(init.body) as { msgs: Array<{ id: string; msg: { t: string } }> };
        resultIds.push(...body.msgs.filter((m) => m.msg.t === 'result').map((m) => m.id));
        const res = await fetch(input, init);
        // The hub processed the result, the reply never reaches the agent.
        if (!replyLost) {
          replyLost = true;
          await res.body?.cancel();
          throw new TypeError('fetch failed');
        }
        return res;
      }
      const res = await fetch(input, init);
      if (!url.includes('/agent/stream') || !res.body || streamCut) return res;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let die = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (die) {
              await reader.cancel().catch(() => undefined);
              return c.error(new Error('connection lost'));
            }
            const r = await reader.read().catch((err: unknown) => ({ err }));
            if ('err' in r) return c.error(r.err);
            if (r.done) return c.close();
            c.enqueue(r.value);
            // The agent gets the command; the stream dies before anything is acknowledged.
            if (dec.decode(r.value).includes('"op":"createSession"')) streamCut = die = true;
          },
          cancel: () => reader.cancel(),
        }),
        { status: res.status, headers: res.headers },
      );
    }) as typeof fetch;
    const { home } = await siteAgent(site, [{ text: 'x' }], { fetch: f });
    await online(hubs);
    const res = await hubs.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) });
    expect(res.status).toBe(201);
    await until(() => streamCut && replyLost && resultIds.length >= 2, 5000, 'cut and lost reply');
    await sleep(300);
    expect(await commandsRun(home, site, 'createSession')).toHaveLength(1);
    expect(resultIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resultIds).size).toBe(1); // the same upstream id, deduped by the hub
    expect(Number(cursors.at(-1))).toBeGreaterThan(0); // reopened past the processed command
  });

  it('streams rotate every 300 ms for 5 s: events in the browser SSE are contiguous with no duplicates', async () => {
    const hubs = await faas({ n: 3, stream: { maxDurationMs: 300 } });
    const site = await hubs.pair('alice');
    const { logger } = await siteAgent(site, [{ text: 'z'.repeat(500), chunks: 50, delayMs: 100 }]);
    await online(hubs);
    const session = await createSession(hubs);

    const seqs: number[] = [];
    let lastId: string | undefined;
    let done = false;
    const reader = (async () => {
      while (!done) {
        const res = await hubs.as('alice', `/sessions/${session.id}/events?after=0`, {
          headers: { accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) },
        });
        for await (const fr of readSse(res)) {
          if (fr.comment || !fr.data || fr.event === 'error') continue;
          const e = JSON.parse(fr.data) as UncageEvent;
          seqs.push(e.sequence);
          if (fr.id) lastId = fr.id;
          if (e.type === 'run.completed' || e.type === 'run.failed') {
            done = true;
            break;
          }
        }
      }
    })();
    await startRun(hubs, session.id);
    await Promise.race([reader, sleep(20_000).then(() => Promise.reject(new Error('SSE timed out')))]);
    expect(seqs.length).toBeGreaterThan(50);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(logger.lines.filter((l) => l.msg === 'http stream rotated').length).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it('random cuts every 150 ms during a run with 10 site tool calls: each handler runs once, the run completes', async () => {
    const counts = new Map<number, number>();
    const tool = defineTool({
      name: 'count',
      description: 'Counts its calls',
      input: z.object({ i: z.number() }),
      handler: async (a) => {
        counts.set(a.i, (counts.get(a.i) ?? 0) + 1);
        await sleep(40 + Math.random() * 120);
        return `ok ${a.i}`;
      },
    });
    const hubs = await faas({ n: 3, tools: [tool] });
    const site = await hubs.pair('alice');
    const script: FakeStep[] = Array.from({ length: 10 }, (_, i) => ({ callTool: { name: 'count', args: { i } } }));
    await siteAgent(site, script);
    await online(hubs);
    const session = await createSession(hubs);
    await startRun(hubs, session.id);
    const timer = setInterval(() => hubs.cutAll(), 150);
    let evs: UncageEvent[];
    try {
      evs = await finished(hubs, session.id, 40_000);
    } finally {
      clearInterval(timer);
    }
    expect(terminal(evs)?.type).toBe('run.completed');
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    const texts = evs.filter((e) => e.type === 'message.completed').map((e) => (e.type === 'message.completed' ? e.payload.text : ''));
    expect(texts).toEqual(Array.from({ length: 10 }, (_, i) => `ok ${i}`));
  }, 60_000);

  it('an upstream body never exceeds 1 MB (large events and file chunks are split)', async () => {
    const bodies: number[] = [];
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/agent/events') && typeof init?.body === 'string') bodies.push(Buffer.byteLength(init.body));
      return fetch(input, init);
    }) as typeof fetch;
    let digest = '';
    const publish = defineTool({
      name: 'publish',
      description: 'Pulls a big file',
      input: z.object({}),
      handler: async (_a, ctx) => {
        const h = createHash('sha256');
        for await (const f of ctx.files.pull('big.bin')) h.update(f.data);
        digest = h.digest('hex');
        return 'published';
      },
    });
    const hubs = await faas({ n: 3, tools: [publish] });
    const site = await hubs.pair('alice');
    const big = 'b'.repeat(900_000);
    const { agent } = await siteAgent(site, [{ text: big }, { text: big }, { callTool: { name: 'publish', args: {} } }], { fetch: recording });
    await online(hubs);
    expect(agent.transport).toBe('http');
    const session = await createSession(hubs);
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 7) data[i] = (i * 31) % 256;
    await writeFile(join(session.workspace, 'big.bin'), data);
    await startRun(hubs, session.id);
    const evs = await finished(hubs, session.id, 30_000);
    expect(terminal(evs)?.type).toBe('run.completed');
    expect(digest).toBe(createHash('sha256').update(data).digest('hex'));
    expect(evs.filter((e) => e.type === 'message.completed' && e.payload.text === big)).toHaveLength(2);
    expect(Math.max(...bodies)).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES);
    expect(bodies.filter((b) => b > 600_000).length).toBeGreaterThanOrEqual(4); // packed, not one message per POST
  }, 60_000);

  it('falls back to HTTP when WebSocket upgrades fail 3 times in a row', async () => {
    // The site offers ws + http, but nothing serves WebSockets (the upgrade reaches fetch: 426).
    const hubs = await faas({ n: 2, transports: ['ws', 'http'] });
    const site = await hubs.pair('alice');
    const { agent, logger } = await siteAgent(site, [{ text: 'fallback ok' }]);
    await until(() => agent.transport === 'http', 10_000, 'http transport');
    const refusals = logger.lines.filter((l) => l.msg === 'hub refused the connection' || l.msg === 'connection error');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(logger.lines.some((l) => l.msg === 'WebSocket keeps failing; falling back to HTTP streaming')).toBe(true);
    await online(hubs);
    const session = await createSession(hubs);
    await startRun(hubs, session.id);
    const evs = await finished(hubs, session.id);
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'fallback ok')).toBe(true);
  });

  it('426 on connect triggers the self-upgrade path (onUpgradeRequired)', async () => {
    const hubs = await faas({ n: 1, minAgentVersion: '9.9.9' });
    const site = await hubs.pair('alice');
    const onUpgradeRequired = vi.fn(async () => 60_000);
    const { agent, home } = await siteAgent(site, [], { onUpgradeRequired });
    await until(() => onUpgradeRequired.mock.calls.length > 0, 5000, 'upgrade');
    expect(onUpgradeRequired).toHaveBeenCalledWith('9.9.9');
    await until(() => agent.state === 'upgrade_failed');
    expect(await until(async () => (await readActivity(home, site.id)).find((e) => e.kind === 'upgrade'))).toBeTruthy();
  });
});

describe('command dedupe (scripted hub)', () => {
  it('a command redelivered under another seq runs once; its cached result is sent again', async () => {
    const posted: Array<{ id: string; ok: boolean; data?: unknown }> = [];
    const cmd = (seq: number) => JSON.stringify({ seq, msg: { t: 'command', id: 'cmd_same', op: 'createSession', args: { runtime: 'fake' } } });
    let streams = 0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/agent/info')) return Response.json({ protocol: CONNECTED_PROTOCOL, minAgentVersion: '0.3.0', transports: [{ kind: 'http', url: 'x' }] });
      if (path.endsWith('/agent/connect')) {
        return Response.json({ t: 'welcome', machineId: 'mch_1', protocol: CONNECTED_PROTOCOL, minAgentVersion: '0.3.0', linkId: `lnk_${'b'.repeat(24)}`, cursor: 0, replies: [] });
      }
      if (path.endsWith('/agent/stream')) {
        streams++;
        if (streams === 1) return new Response(`${cmd(1)}\n{"ctl":"rotate"}\n`);
        if (streams === 2) {
          await until(() => posted.length >= 1, 5000);
          return new Response(`${cmd(2)}\n{"ctl":"rotate"}\n`);
        }
        return new Promise<Response>(() => undefined);
      }
      if (path.endsWith('/agent/events')) {
        const body = JSON.parse(init!.body as string) as { msgs: Array<{ id: string; msg: { t: string; id: string; ok: boolean; data?: unknown } }> };
        for (const m of body.msgs) if (m.msg.t === 'result') posted.push(m.msg);
        return Response.json({ processed: body.msgs.map((m) => m.id), retry: [], replies: [] });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const site: AgentSite = { id: 'scripted', name: 'S', url: 'http://127.0.0.1:9/api/uncage', machineId: 'mch_1', token: 't' };
    const { home } = await siteAgent(site, [], { fetch: f });
    await until(() => posted.length >= 2, 5000, 'two results');
    expect(posted[0]).toMatchObject({ id: 'cmd_same', ok: true });
    expect(posted[1]).toEqual(posted[0]);
    expect(await commandsRun(home, site, 'createSession')).toHaveLength(1);
  });
});
