import { CONNECTED_PROTOCOL, type AgentFrame, type AgentInfo, type HubFrame, type TransportKind } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMING, type AgentTiming } from './site.js';
import { FAST, memoryLogger, startFaasHubs, until, type FaasHubs } from './test-helpers.js';
import { chooseTransport, compareVersions, fetchAgentInfo } from './transport/choose.js';
import { dialHttp } from './transport/http.js';
import type { AgentLink, DialOptions } from './transport/types.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

const info = (kinds: TransportKind[]): AgentInfo => ({
  protocol: CONNECTED_PROTOCOL,
  minAgentVersion: '0.3.0',
  transports: kinds.map((kind) => ({ kind, url: kind === 'ws' ? 'ws://h/agent' : 'http://h/agent' })),
});
const t = { wsFallbackAfter: 3, wsReprobeMs: 1_800_000 };
const now = 1_700_000_000_000;

describe('chooseTransport', () => {
  it('chooseTransport: ws when offered; http when only http; http after 3 ws failures; ws again after wsReprobeMs', () => {
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 0, now }, t)).toBe('ws');
    expect(chooseTransport(info(['http']), { wsFailures: 0, now }, t)).toBe('http');
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 3, fellBackAt: now, now }, t)).toBe('http');
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 3, fellBackAt: now, now: now + 1_800_000 }, t)).toBe('ws');
  });

  it('ws-only sites stay on ws whatever fails; unknown offers (no /agent/info) behave like ws+http', () => {
    expect(chooseTransport(info(['ws']), { wsFailures: 10, fellBackAt: now, now }, t)).toBe('ws');
    expect(chooseTransport(null, { wsFailures: 0, now }, t)).toBe('ws');
    expect(chooseTransport(null, { wsFailures: 3, fellBackAt: now, now: now + 1000 }, t)).toBe('http');
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 2, now }, t)).toBe('ws');
  });

  it('defaults: 3 failures, 30 min re-probe, 10 s upstream retry cap, 150 s tool timeout', () => {
    expect(DEFAULT_TIMING).toMatchObject({ wsFallbackAfter: 3, wsReprobeMs: 1_800_000, httpRetryMaxMs: 10_000, toolTimeoutMs: 150_000 });
  });

  it('compareVersions', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.2.9', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.30.0')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
  });
});

describe('fetchAgentInfo', () => {
  it('reads a real hub, and returns null for a non-hub, an error status or an unreachable host', async () => {
    const hubs = await startFaasHubs({ n: 1 });
    cleanups.push(() => hubs.close());
    const got = await fetchAgentInfo(fetch, hubs.api);
    expect(got).toMatchObject({ protocol: CONNECTED_PROTOCOL, transports: [{ kind: 'http', url: `${hubs.api}/agent` }] });
    expect(await fetchAgentInfo((async () => new Response('<html>', { status: 200 })) as typeof fetch, hubs.api)).toBeNull();
    expect(await fetchAgentInfo((async () => Response.json({ protocol: 2 })) as typeof fetch, hubs.api)).toBeNull();
    expect(await fetchAgentInfo((async () => new Response('nope', { status: 404 })) as typeof fetch, hubs.api)).toBeNull();
    expect(await fetchAgentInfo(fetch, 'http://127.0.0.1:1/api/uncage')).toBeNull();
  });
});

/** A scripted hub behind `fetch`: connect → welcome, each stream request → the next scripted body. */
function scriptedFetch(streams: string[][], o: { connectStatus?: number; connectBody?: unknown; eventsStatus?: number; eventsBody?: unknown } = {}) {
  const calls: Array<{ path: string; body?: unknown; search: string }> = [];
  let s = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/uncage/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path, body, search: url.search });
    if (path === '/agent/connect') {
      return Response.json(
        o.connectBody ?? { t: 'welcome', machineId: 'mch_1', protocol: CONNECTED_PROTOCOL, minAgentVersion: '0.3.0', linkId: `lnk_${'a'.repeat(24)}`, cursor: 0, replies: [] },
        { status: o.connectStatus ?? 200 },
      );
    }
    if (path === '/agent/stream') {
      const lines = streams[s++];
      if (!lines) return new Promise<Response>(() => undefined); // no more scripted streams: hang
      return new Response(lines.map((l) => `${l}\n`).join(''), { status: 200 });
    }
    if (path === '/agent/events') {
      const msgs = (body as { msgs: Array<{ id: string }> }).msgs;
      return Response.json(o.eventsBody ?? { processed: msgs.map((m) => m.id), retry: [], replies: [] }, { status: o.eventsStatus ?? 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function dial(fetchFn: typeof fetch, extra: Partial<DialOptions> = {}) {
  const frames: HubFrame[] = [];
  let cursor = 0;
  const logger = memoryLogger();
  let welcomed = 0;
  const link: AgentLink = dialHttp({
    hubUrl: 'http://127.0.0.1:9/api/uncage',
    token: 'tok',
    hello: { t: 'hello', protocol: CONNECTED_PROTOCOL, agentVersion: '0.3.0', machine: { name: 'm', os: 'darwin', runtimes: [] } },
    onWelcome: () => void welcomed++,
    onFrame: (f) => void frames.push(f),
    cursor: { get: () => cursor, set: (v) => void (cursor = v) },
    busy: () => false,
    timing: { ...DEFAULT_TIMING, ...FAST } as AgentTiming,
    fetch: fetchFn,
    logger,
    ...extra,
  });
  cleanups.push(async () => link.close());
  return { link, frames, logger, cursor: () => cursor, welcomed: () => welcomed };
}

const cmd = (seq: number, id: string) => JSON.stringify({ seq, msg: { t: 'command', id, op: 'listSessions', args: {} } });

describe('dialHttp (scripted hub)', () => {
  it('skips unknown control lines and unreadable frames, skips seq <= cursor, logs every rotate, resumes with the cursor', async () => {
    const { fetch: f, calls } = scriptedFetch([
      [cmd(1, 'c1'), '{"ctl":"ping","at":1}', '{"ctl":"brand-new-thing"}', JSON.stringify({ seq: 2, msg: { t: 'from_the_future' } }), cmd(3, 'c3'), '{"ctl":"rotate"}'],
      [cmd(3, 'c3'), cmd(4, 'c4'), '{"ctl":"rotate"}'],
    ]);
    const d = dial(f);
    await until(() => d.frames.length === 3, 3000, 'three commands');
    expect(d.frames.map((x) => (x as { id: string }).id)).toEqual(['c1', 'c3', 'c4']);
    expect(d.cursor()).toBe(4);
    expect(d.logger.lines.filter((l) => l.msg === 'http stream rotated')).toHaveLength(2);
    const streams = calls.filter((c) => c.path === '/agent/stream').map((c) => new URLSearchParams(c.search).get('cursor'));
    expect(streams.slice(0, 3)).toEqual(['0', '3', '4']);
  });

  it('acks the cursor on the next POST; packs the serialized queue; a replaced line stops the link', async () => {
    const { fetch: f, calls } = scriptedFetch([[cmd(1, 'c1'), cmd(2, 'c2')]]);
    const d = dial(f);
    await until(() => d.cursor() === 2);
    const sends = [1, 2, 3].map((i) => d.link.send({ t: 'result', id: `c${i}`, ok: true, data: i } as AgentFrame));
    await Promise.all(sends);
    const posts = calls.filter((c) => c.path === '/agent/events').map((c) => c.body as { ack: number; msgs: unknown[] });
    expect(posts[0]!.ack).toBe(2);
    expect(posts.reduce((n, p) => n + p.msgs.length, 0)).toBe(3);
    expect(posts.length).toBeLessThanOrEqual(2); // queued messages share a body

    const r = scriptedFetch([['{"ctl":"replaced"}']]);
    expect(await dial(r.fetch).link.ended).toMatchObject({ welcomed: true, stop: 'replaced' });
  });

  it('401 → revoked, 426 → upgrade with the minimum version, 400 link_replaced → replaced, 400 link_closed → ends to reconnect', async () => {
    expect(await dial(scriptedFetch([], { connectStatus: 401, connectBody: { code: 'unauthorized', message: 'x' } }).fetch).link.ended).toMatchObject({
      welcomed: false,
      stop: 'revoked',
    });
    expect(await dial(scriptedFetch([], { connectStatus: 426, connectBody: { t: 'upgrade_required', minAgentVersion: '9.0.0' } }).fetch).link.ended).toMatchObject({
      stop: 'upgrade',
      minAgentVersion: '9.0.0',
    });
    for (const [reason, stop] of [
      ['link_replaced', 'replaced'],
      ['link_closed', undefined],
    ] as const) {
      const d = dial(scriptedFetch([], { eventsStatus: 400, eventsBody: { code: 'invalid_request', message: 'x', details: { reason } } }).fetch);
      await until(() => d.welcomed() === 1);
      const sent = d.link.send({ t: 'result', id: 'c', ok: true, data: 1 } as AgentFrame);
      await expect(sent).rejects.toMatchObject({ code: 'machine_offline' });
      const end = await d.link.ended;
      expect(end.welcomed).toBe(true);
      expect(end.stop).toBe(stop);
    }
  });

  it('re-sends `retry` ids with the same id after a growing backoff', async () => {
    const seen: string[] = [];
    let n = 0;
    const base = scriptedFetch([]);
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/agent/events')) {
        const body = JSON.parse(init!.body as string) as { msgs: Array<{ id: string }> };
        seen.push(body.msgs[0]!.id);
        const done = ++n >= 3;
        return Response.json({ processed: done ? [body.msgs[0]!.id] : [], retry: done ? [] : [body.msgs[0]!.id], replies: [] });
      }
      return base.fetch(input, init);
    }) as typeof fetch;
    const d = dial(f, { timing: { ...DEFAULT_TIMING, ...FAST, httpRetryMaxMs: 100 } });
    await until(() => d.welcomed() === 1);
    const t0 = Date.now();
    await d.link.send({ t: 'result', id: 'c', ok: true, data: 1 } as AgentFrame);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});

describe('dialHttp (real hubs)', () => {
  async function faas(o: Parameters<typeof startFaasHubs>[0]): Promise<FaasHubs> {
    const h = await startFaasHubs(o);
    cleanups.push(() => h.close());
    return h;
  }

  it('a machine revoked on the website ends the link with revoked; close() takes the machine offline at once', async () => {
    const hubs = await faas({ n: 2 });
    const site = await hubs.pair('alice');
    const d = dial(fetch, { hubUrl: site.url, token: site.token });
    await until(() => d.welcomed() === 1);
    await until(async () => ((await (await hubs.as('alice', '/machines')).json()) as Array<{ online: boolean }>)[0]?.online, 5000, 'online');
    d.link.close();
    expect((await d.link.ended).stop).toBeUndefined();
    await until(async () => ((await (await hubs.as('alice', '/machines')).json()) as Array<{ online: boolean }>)[0]?.online === false, 2000, 'offline');

    const again = dial(fetch, { hubUrl: site.url, token: site.token });
    await until(() => again.welcomed() === 1);
    await hubs.hubs[1]!.revokeMachine(site.machineId, { id: 'alice' });
    expect(await again.link.ended).toMatchObject({ welcomed: true, stop: 'revoked' });
  });

  it('a second connect for the same machine replaces the first link', async () => {
    const hubs = await faas({ n: 2 });
    const site = await hubs.pair('alice');
    const a = dial(fetch, { hubUrl: site.url, token: site.token });
    await until(() => a.welcomed() === 1);
    const b = dial(fetch, { hubUrl: site.url, token: site.token });
    await until(() => b.welcomed() === 1);
    expect(await a.link.ended).toMatchObject({ stop: 'replaced' });
  });
});
