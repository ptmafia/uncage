import { PGlite } from '@electric-sql/pglite';
import {
  AgentInfoSchema,
  CONNECTED_PROTOCOL,
  DeviceTokenResponseSchema,
  HTTP_STREAM_CONTENT_TYPE,
  HttpConnectResponseSchema,
  type DeviceCodeResponse,
  type HttpEventsResponse,
  type MachineInfo,
  type Run,
  type Session,
} from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sqlCluster } from './cluster/postgres.js';
import { createHub } from './hub.js';
import { HTTP_PRESENCE, machineChannel, sessionChannel } from './machines.js';
import { pgliteHubStore } from './node/index.js';
import type { SqlClient } from './store/sql.js';
import type { HubStore } from './store/store.js';
import { HUB_INTERNALS } from './types.js';
import {
  connectFakeAgent,
  connectFakeHttpAgent,
  fakeMachine,
  fakeSession,
  makeEvent,
  NO_REPLY,
  readStreamLines,
  sleep,
  startFaasHubs,
  startTestHub,
  until,
  upId,
  type FaasHubs,
  type FakeHttpAgent,
} from './test-utils.js';
import { defineTool } from './tools.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const hello = (o: { protocol?: number; agentVersion?: string } = {}) => ({
  t: 'hello',
  protocol: o.protocol ?? CONNECTED_PROTOCOL,
  agentVersion: o.agentVersion ?? '99.0.0',
  transport: 'http',
  machine: { name: 'Test Mac', os: 'darwin', runtimes: [{ id: 'fake', displayName: 'Fake', status: 'available' }] },
});

async function faas(o: Parameters<typeof startFaasHubs>[0] = { n: 3 }): Promise<FaasHubs> {
  const hubs = await startFaasHubs(o);
  closers.push(() => hubs.close());
  return hubs;
}

async function agentFor(hubs: FaasHubs, token: string, o: Partial<Parameters<typeof connectFakeHttpAgent>[0]> = {}): Promise<FakeHttpAgent> {
  const agent = await connectFakeHttpAgent({ hubs, token, ...o });
  closers.push(() => agent.close());
  return agent;
}

type ErrorJson = { error: { code: string; message: string; details?: Record<string, unknown> } };
const errorOf = async (r: Response) => ((await r.json()) as ErrorJson).error;
const machinesOf = async (hubs: FaasHubs, user: string) => (await (await hubs.as(user, '/machines')).json()) as MachineInfo[];

/** Connects over raw HTTP and resolves the welcome. */
async function rawConnect(hubs: FaasHubs, token: string) {
  const res = await hubs.fetch('/agent/connect', json(hello(), { authorization: `Bearer ${token}` }));
  expect(res.status).toBe(200);
  const w = HttpConnectResponseSchema.parse(await res.json());
  if (w.t !== 'welcome') throw new Error('expected welcome');
  return w;
}

const command = (n: number) => ({ t: 'command' as const, id: `cmd_test_${n}`, op: 'listSessions' as const, args: {} });

describe('HTTP streaming transport', () => {
  it('connect → stream → command on another instance → result on a third instance', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const from = hubs.requests.length;
    const res = await hubs.as('u1', '/sessions', { method: 'POST', body: '{"runtime":"fake"}' });
    expect(res.status).toBe(201);
    expect(agent.commands.map((c) => c.op)).toEqual(['createSession']);
    // The browser request, the stream that delivered the command and the result POST.
    const later = hubs.requests.slice(from);
    const browser = later.find((r) => r.path === '/sessions')!;
    const resultPost = later.find((r) => r.path === '/agent/events')!;
    const stream = [...hubs.requests].reverse().find((r) => r.path === '/agent/stream')!;
    expect(new Set([browser.i, resultPost.i]).size).toBe(2);
    expect(stream).toBeDefined();
    const info = (await machinesOf(hubs, 'u1'))[0]!;
    expect(info).toMatchObject({ online: true, transport: 'http', agentOutdated: false });
  });

  it('stream with cursor n delivers exactly the items > n; reopening with the same cursor redelivers them', async () => {
    const hubs = await faas({ n: 3, stream: { maxDurationMs: 300 } });
    const { token, machineId } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    expect(w.cursor).toBe(0);
    const at = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await hubs.store.enqueueOutbox(machineId, [1, 2, 3].map((n) => ({ msgId: `m${n}`, msg: command(n), expiresAt })), at)).toEqual([1, 2, 3]);
    const open = async (cursor: number) => {
      const res = await hubs.fetch(`/agent/stream?link=${w.linkId}&cursor=${cursor}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(HTTP_STREAM_CONTENT_TYPE);
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      return (await readStreamLines(res)).filter((l) => !('ctl' in l && l.ctl === 'ping'));
    };
    const first = await open(1);
    expect(first).toEqual([{ seq: 2, msg: command(2) }, { seq: 3, msg: command(3) }, { ctl: 'rotate' }]);
    // Not acknowledged beyond 1: the same cursor gets the same items again.
    expect(await open(1)).toEqual(first);
    // Cursor 3 acknowledges everything: nothing left, and an older cursor cannot bring them back.
    expect(await open(3)).toEqual([{ ctl: 'rotate' }]);
    expect(await open(1)).toEqual([{ ctl: 'rotate' }]);
  });

  it('rotates at stream.maxDurationMs with a rotate line; nothing is lost across 5 rotations of 200 ms', async () => {
    const hubs = await faas({ n: 3, stream: { maxDurationMs: 200 }, polling: { activeMs: 20, idleMs: 100 } });
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const started = Date.now();
    const created: Session[] = [];
    let i = 0;
    while (agent.rotations < 5 || Date.now() - started < 1100) {
      const batch = await Promise.all(
        Array.from({ length: 3 }, () => hubs.as('u1', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake', title: `s${i++}` }) })),
      );
      for (const r of batch) {
        expect(r.status).toBe(201);
        created.push((await r.json()) as Session);
      }
    }
    expect(agent.rotations).toBeGreaterThanOrEqual(5);
    expect(agent.lines.filter((l) => 'ctl' in l && l.ctl === 'rotate').length).toBeGreaterThanOrEqual(5);
    // Every request reached the machine exactly once.
    const ids = agent.commands.filter((c) => c.op === 'createSession').map((c) => c.id);
    expect(ids.length).toBe(created.length);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it('batch stops at the first busy message: later messages are returned in retry, unprocessed', async () => {
    const hubs = await faas();
    const { token, machineId } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    const ev = (sessionId: string) => ({ t: 'events' as const, sessionId, events: [makeEvent(sessionId, 1, 'session.created', { session: fakeSession(sessionId) })] });
    const [a, b, c] = [upId(), upId(), upId()];
    // Another instance is processing `b` right now.
    const now = Date.now();
    expect(await hubs.store.claimInbox(machineId, [b], { leaseUntil: new Date(now + 60_000).toISOString(), now: new Date(now).toISOString() })).toEqual({ [b]: 'new' });
    const res = await hubs.fetch(
      '/agent/events',
      json({ linkId: w.linkId, busy: false, msgs: [{ id: a, msg: ev('ses_a') }, { id: b, msg: ev('ses_b') }, { id: c, msg: ev('ses_c') }] }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as HttpEventsResponse;
    expect(body.processed).toEqual([a]);
    expect(body.retry).toEqual([b, c]);
    expect(await hubs.store.getSession('ses_a')).not.toBeNull();
    expect(await hubs.store.getSession('ses_c')).toBeNull();
    // `c` was not claimed: resent alone, it is processed now.
    const again = (await (await hubs.fetch('/agent/events', json({ linkId: w.linkId, busy: false, msgs: [{ id: c, msg: ev('ses_c') }] }, { authorization: `Bearer ${token}` }))).json()) as HttpEventsResponse;
    expect(again.processed).toEqual([c]);
    expect(await hubs.store.getSession('ses_c')).not.toBeNull();
  });

  it('duplicate upstream ids are listed as processed and not applied twice (events published once)', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    const published: string[] = [];
    const unsub = await hubs.cluster.subscribe(sessionChannel('ses_dup'), (m) => published.push(m));
    closers.push(async () => unsub());
    const msg = { id: upId(), msg: { t: 'events', sessionId: 'ses_dup', events: [makeEvent('ses_dup', 1, 'session.created', { session: fakeSession('ses_dup') })] } };
    const post = async (msgs: unknown[]) =>
      (await (await hubs.fetch('/agent/events', json({ linkId: w.linkId, busy: false, msgs }, { authorization: `Bearer ${token}` }))).json()) as HttpEventsResponse;
    expect(await post([msg, msg])).toMatchObject({ processed: [msg.id, msg.id], retry: [] });
    expect(await post([msg])).toMatchObject({ processed: [msg.id], retry: [] }); // another instance (round-robin)
    expect(await post([msg])).toMatchObject({ processed: [msg.id], retry: [] });
    await sleep(50);
    expect(published).toHaveLength(1);
  });

  it('a body over 1 MB is refused with 400', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    const big = JSON.stringify({ linkId: w.linkId, busy: false, msgs: [], pad: 'x'.repeat(1_100_000) });
    const res = await hubs.fetch('/agent/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: big });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_request');
    // Without a Content-Length (chunked): reading stops at the cap.
    const enc = new TextEncoder().encode(big);
    const chunked = new ReadableStream<Uint8Array>({
      start(c) {
        for (let at = 0; at < enc.length; at += 64 * 1024) c.enqueue(enc.subarray(at, at + 64 * 1024));
        c.close();
      },
    });
    const res2 = await hubs.fetch('/agent/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: chunked, duplex: 'half' } as RequestInit);
    expect(res2.status).toBe(400);
    expect((await errorOf(res2)).code).toBe('invalid_request');
  });

  it('/agent/info offers http only without attachWebSocket and ws+http with it', async () => {
    const hubs = await faas({ n: 1 });
    const info = AgentInfoSchema.parse(await (await hubs.fetch('/agent/info')).json());
    expect(info).toEqual({ protocol: CONNECTED_PROTOCOL, minAgentVersion: expect.any(String), transports: [{ kind: 'http', url: `${hubs.api}/agent` }] });
    // The device token offers the same.
    const code = (await (await hubs.fetch('/device/code', json({}))).json()) as DeviceCodeResponse;
    await hubs.hubs[0]!.approveDevice(code.userCode, { id: 'u1' });
    const tok = DeviceTokenResponseSchema.parse(await (await hubs.fetch('/device/token', json({ deviceCode: code.deviceCode }))).json());
    expect(tok.status === 'ok' && tok.transports).toEqual([{ kind: 'http', url: `${hubs.api}/agent` }]);

    const t = await startTestHub();
    closers.push(() => t.close());
    const withWs = AgentInfoSchema.parse(await (await fetch(`${t.api}/agent/info`)).json());
    expect(withWs.transports).toEqual([
      { kind: 'ws', url: t.wsUrl },
      { kind: 'http', url: `${t.api}/agent` },
    ]);
  });

  it('HubOptions.transports: ws is offered without attachWebSocket when listed', async () => {
    const hubs = await faas({ n: 1, transports: ['ws', 'http'] });
    const info = AgentInfoSchema.parse(await (await hubs.fetch('/agent/info')).json());
    expect(info.transports.map((x) => x.kind)).toEqual(['ws', 'http']);
    expect(info.transports[0]!.url).toBe(`${hubs.origin.replace('http', 'ws')}/api/uncage/agent`);
  });

  it('a 0.2-style WebSocket upgrade reaching fetch gets 426 upgrade_required and the machine shows agentOutdated', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const res = await hubs.fetch('/agent', { headers: { upgrade: 'websocket', connection: 'Upgrade', authorization: `Bearer ${token}` } });
    expect(res.status).toBe(426);
    const error = await errorOf(res);
    expect(error.code).toBe('upgrade_required');
    expect(error.message).toBe('This website needs Uncage agent 0.3.0 or newer. On this computer run: npm i -g @uncage/cli@latest');
    expect((await machinesOf(hubs, 'u1'))[0]!.agentOutdated).toBe(true);
  });

  it('protocol 1 hello on /agent/connect gets upgrade_required (426)', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const v1: Record<string, unknown> = hello({ protocol: 1, agentVersion: '0.2.0' });
    delete v1.transport; // protocol 1 had no transport field
    const res = await hubs.fetch('/agent/connect', json(v1, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(426);
    expect(HttpConnectResponseSchema.parse(await res.json())).toMatchObject({ t: 'upgrade_required' });
    expect((await machinesOf(hubs, 'u1'))[0]!.agentOutdated).toBe(true);
    // An outdated version with protocol 2 too.
    const old = await hubs.fetch('/agent/connect', json(hello({ agentVersion: '0.0.1' }), { authorization: `Bearer ${token}` }));
    expect(old.status).toBe(426);
    // A bad token is 401.
    expect((await hubs.fetch('/agent/connect', json(hello(), { authorization: 'Bearer nope-nope-nope-nope-nope' }))).status).toBe(401);
  });

  it('machine shows online while streaming and offline within presence TTL after the stream stops', async () => {
    const hubs = await faas({ n: 3, heartbeat: { pingIntervalMs: 100, missedPings: 2 } });
    const { token } = await hubs.pair('u1');
    const agent = await agentFor(hubs, token);
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    // Pings keep it online well past the TTL (0.3 s).
    await sleep(700);
    expect((await machinesOf(hubs, 'u1'))[0]).toMatchObject({ online: true, transport: 'http' });
    expect(agent.lines.some((l) => 'ctl' in l && l.ctl === 'ping')).toBe(true);
    agent.stop();
    const stoppedAt = Date.now();
    await until(async () => !(await machinesOf(hubs, 'u1'))[0]?.online, 3000);
    expect(Date.now() - stoppedAt).toBeLessThan(1500);
    expect((await machinesOf(hubs, 'u1'))[0]!.transport).toBeNull();
  });

  it('disconnect takes the machine offline at once', async () => {
    const hubs = await faas();
    const { token } = await hubs.pair('u1');
    const agent = await agentFor(hubs, token);
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    await agent.close();
    expect((await machinesOf(hubs, 'u1'))[0]!.online).toBe(false);
  });

  it('revoke ends the stream with ctl revoked; a second connect ends the first stream with ctl replaced', async () => {
    const hubs = await faas();
    const { token, machineId } = await hubs.pair('u1');
    const first = await agentFor(hubs, token);
    await until(() => first.streams > 0);
    const second = await agentFor(hubs, token);
    expect(await first.ended).toBe('replaced');
    // The first link is refused upstream.
    const res = await first.post({ msgs: [] });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details).toMatchObject({ reason: 'link_replaced' });
    await until(() => second.streams > 0);
    expect((await hubs.as('u1', `/machines/${machineId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await second.ended).toBe('revoked');
  });

  it('a link closed while the machine still exists ends the stream with closed (connect again); revoked only for a deleted machine', async () => {
    const hubs = await faas({ n: 2 });
    const { token } = await hubs.pair('u1');
    const a = await agentFor(hubs, token);
    await until(() => a.streams > 0);
    await a.close(); // POST /agent/disconnect closes the link; the machine row stays
    const res = await hubs.fetch(`/agent/stream?link=${a.linkId}&cursor=0`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await readStreamLines(res)).filter((l) => !('ctl' in l && l.ctl === 'ping'))).toEqual([{ ctl: 'closed' }]);

    // A token rotated by re-pairing closes the old link too: closed, and the old token then gets 401.
    const b = await agentFor(hubs, token);
    await until(() => b.streams > 0);
    await hubs.hubs[0]![HUB_INTERNALS].machines.kick(b.machineId, 'replaced');
    expect(await b.ended).toBe('closed');
  });

  it('a late result for a command that already timed out is accepted and dropped quietly', async () => {
    const errors: unknown[] = [];
    const logger = { info: () => undefined, warn: () => undefined, error: (o: unknown) => void errors.push(o) };
    const hubs = await faas({ n: 2, commandTimeoutMs: 300, logger } as Parameters<typeof startFaasHubs>[0]);
    const { token } = await hubs.pair('u1');
    const held: Array<{ id: string }> = [];
    const a = await agentFor(hubs, token, {
      onCommand: (cmd) => {
        if (cmd.op === 'listSessions') {
          held.push(cmd);
          return NO_REPLY;
        }
        return [];
      },
    });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const r = await hubs.as('u1', '/sessions?scope=machine');
    void r.body?.cancel();
    await until(() => held.length > 0);
    await sleep(400); // the hub gave up on the command
    await a.send({ t: 'result', id: held[0]!.id, ok: true, data: [] }); // processed, not retried
    await sleep(100);
    expect(errors).toEqual([]);
  });

  it('a WebSocket-era hello over HTTP replaces a link the same way when the machine reconnects over HTTP', async () => {
    // Same machine, new connect while the old stream is open on another instance.
    const hubs = await faas({ n: 2 });
    const { token } = await hubs.pair('u1');
    const a = await agentFor(hubs, token);
    await until(() => a.streams > 0);
    const w = await rawConnect(hubs, token);
    expect(await a.ended).toBe('replaced');
    expect(w.linkId).not.toBe(a.linkId);
  });

  it('idle stream polls the outbox at most every idleMs; busy stream every activeMs', async () => {
    let polls = 0;
    const hubs = await faas({
      n: 1,
      polling: { activeMs: 25, idleMs: 200, activeWindowMs: 100 },
      makeStore: async () => {
        const s = await pgliteHubStore({ dataDir: 'memory://' });
        const orig = s.pollLink.bind(s);
        s.pollLink = (...args) => {
          polls++;
          return orig(...args);
        };
        return s;
      },
    });
    const { token } = await hubs.pair('u1');
    const agent = await agentFor(hubs, token);
    await until(() => agent.streams > 0);
    await sleep(500); // back off to idle
    polls = 0;
    await sleep(1000);
    expect(polls).toBeLessThanOrEqual(6);
    expect(polls).toBeGreaterThanOrEqual(3);
    // The machine reports work in flight: fast polling.
    agent.busy = true;
    expect((await agent.post({ busy: true })).status).toBe(200);
    await sleep(100);
    polls = 0;
    await sleep(1000);
    expect(polls).toBeGreaterThanOrEqual(20);
  });

  it('a wake-up on the machine channel polls at once', async () => {
    const hubs = await faas({ n: 2, polling: { activeMs: 5000, idleMs: 5000 } });
    const { token, machineId } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    const res = await hubs.fetch(`/agent/stream?link=${w.linkId}&cursor=0`, { headers: { authorization: `Bearer ${token}` } });
    await sleep(100);
    const t0 = Date.now();
    await hubs.store.enqueueOutbox(machineId, [{ msgId: 'x', msg: command(1), expiresAt: new Date(Date.now() + 60_000).toISOString() }], new Date().toISOString());
    await hubs.cluster.publish(machineChannel(machineId), 'wake');
    const lines = await readStreamLines(res, (l) => 'seq' in l);
    expect(lines.at(-1)).toEqual({ seq: 1, msg: command(1) });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('events and acks: site-mode acks come back in the reply; ack deletes delivered outbox items', async () => {
    const hubs = await faas({ n: 2, sessionStorage: 'site' });
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const s = (await (await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
    await agent.events(s.id, fm.sessions.get(s.id)!.events);
    await agent.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 1);
    expect((await hubs.store.getSession(s.id))!.lastSequence).toBe(1);
    // The createSession command was acknowledged by the cursor: no outbox rows left after the next POST.
    expect((await agent.post({})).status).toBe(200);
    const poll = await hubs.store.pollLink(agent.machineId, agent.linkId, { after: 0, limit: 10, now: new Date().toISOString() });
    expect(poll.items).toEqual([]);
  });

  it('a site tool call over HTTP runs on the receiving instance and the result comes back in the reply', async () => {
    const echo = defineTool({ name: 'echo', description: 'Echo', input: z.object({ v: z.string() }), handler: async ({ v }) => `got ${v}` });
    const hubs = await faas({ n: 3, tools: [echo], runIndexWaitMs: 500 });
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const s = (await (await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
    const r = await hubs.as('u1', `/sessions/${s.id}/runs`, json({ prompt: 'go' }, { 'idempotency-key': 'k1' }));
    expect(r.status).toBe(202);
    const run = (await r.json()) as Run;
    const result = await agent.callTool('echo', { v: 'x' }, { sessionId: s.id, runId: run.id });
    expect(result).toMatchObject({ t: 'tool_result', ok: true, result: { content: [{ type: 'text', text: 'got x' }] } });
  });

  it('attachments and file pulls reach an HTTP machine through the outbox', async () => {
    const hubs = await faas({ n: 1 });
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const received: Buffer[] = [];
    const agent = await agentFor(hubs, token, {
      onCommand: fm.handler,
      onFrame: (f, send) => {
        if (f.t === 'attachment_chunk') received.push(Buffer.from(f.data, 'base64'));
        if (f.t === 'attachment_end') {
          send({
            t: 'result',
            id: f.id,
            ok: true,
            data: { id: 'att_000000000001', sessionId: sid, name: 'big.bin', mime: 'application/octet-stream', size: 1_200_000, kind: 'file', sha256: '0'.repeat(64), createdAt: new Date().toISOString() },
          });
        }
      },
    });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const s = (await (await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
    const sid = s.id;
    const data = new Uint8Array(1_200_000).map((_, i) => i % 251);
    const res = await hubs.as('u1', `/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'x-filename': 'big.bin', 'content-type': 'application/octet-stream' }, body: data });
    expect(res.status).toBe(201);
    expect(Buffer.concat(received).equals(Buffer.from(data))).toBe(true);
    expect(agent.frames.filter((f) => f.t === 'attachment_begin')).toHaveLength(1);
  });

  it('two hubs on one PGlite store + sqlCluster: commands and presence work across instances', async () => {
    const pg = new PGlite('memory://');
    await pg.waitReady;
    closers.push(() => pg.close());
    const db = pg as unknown as SqlClient;
    let store: HubStore | undefined;
    const hubs = await faas({
      n: 2,
      makeStore: async () => (store = await pgliteHubStore({ dataDir: 'memory://' })),
      makeCluster: () => sqlCluster(db, { activePollMs: 30, idlePollMs: 200 }),
    });
    expect(store).toBeDefined();
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    for (let i = 0; i < 4; i++) expect((await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).status).toBe(201);
    expect(agent.commands).toHaveLength(4);
  }, 30_000);

  it('hub.fetch without Node: connect, stream and events on a bare Fetch handler', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    closers.push(() => store.close());
    const hub = await createHub({ publicUrl: 'https://app.example.com', getUser: async (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null), store, stream: { maxDurationMs: 300 } });
    closers.push(() => hub.close());
    const base = 'https://app.example.com/api/uncage';
    const code = (await (await hub.fetch(new Request(`${base}/device/code`, json({}))))
      .json()) as DeviceCodeResponse;
    await hub.approveDevice(code.userCode, { id: 'u1' });
    const tok = DeviceTokenResponseSchema.parse(await (await hub.fetch(new Request(`${base}/device/token`, json({ deviceCode: code.deviceCode })))).json());
    if (tok.status !== 'ok') throw new Error('pair failed');
    expect(tok.transports).toEqual([{ kind: 'http', url: `${base}/agent` }]);
    const auth = { authorization: `Bearer ${tok.machineToken}` };
    const w = HttpConnectResponseSchema.parse(await (await hub.fetch(new Request(`${base}/agent/connect`, json(hello(), auth)))).json());
    if (w.t !== 'welcome') throw new Error('expected welcome');
    const stream = await hub.fetch(new Request(`${base}/agent/stream?link=${w.linkId}&cursor=0`, { headers: auth }));
    const lines = readStreamLines(stream, (l) => 'seq' in l);
    const listed = hub.fetch(new Request(`${base}/sessions`, { headers: { 'x-user': 'u1' } }));
    const got = await lines;
    const cmd = got.at(-1)!;
    if (!('seq' in cmd) || cmd.msg.t !== 'command') throw new Error('expected a command');
    const ev = await hub.fetch(
      new Request(`${base}/agent/events`, json({ linkId: w.linkId, ack: cmd.seq, busy: false, msgs: [{ id: upId(), msg: { t: 'result', id: cmd.msg.id, ok: true, data: [] } }] }, auth)),
    );
    expect(((await ev.json()) as HttpEventsResponse).processed).toHaveLength(1);
    expect((await listed).status).toBe(200);
    expect(await (await listed).json()).toEqual([]);
  });
});

describe('HTTP transport — fix round 1', () => {
  it('a WebSocket hello during an HTTP stream keeps the node id as presence; a stale stream cannot take it back', async () => {
    const hubs = await faas({ n: 1, heartbeat: { pingIntervalMs: 50, missedPings: 2 } });
    const t = await startTestHub({ store: hubs.store, cluster: hubs.cluster });
    closers.push(() => t.close());
    const { token, machineId } = await hubs.pair('u1');
    const http = await agentFor(hubs, token);
    await until(() => http.lines.some((l) => 'ctl' in l && l.ctl === 'ping'));
    const ws = await connectFakeAgent({ url: t.wsUrl, token });
    closers.push(() => ws.close());
    expect(await http.ended).toBe('replaced');
    const nodeId = t.hub[HUB_INTERNALS].machines.nodeId;
    expect(await hubs.cluster.getPresence(machineId)).toBe(nodeId);
    // The old stream's late ping (its link was current when it checked) must not overwrite it.
    const machines = hubs.hubs[0]![HUB_INTERNALS].machines;
    const machine = (await hubs.store.getMachine(machineId))!;
    expect(await machines.touchHttp(machine, http.linkId)).toBe(false);
    expect(await hubs.cluster.getPresence(machineId)).toBe(nodeId);
    // Even with the link still current in the store (the race window), presence held by a node stays.
    const lnk = `lnk_${'a'.repeat(24)}`;
    await hubs.store.openLink(machineId, { linkId: lnk, transport: 'http', at: new Date().toISOString() });
    expect(await machines.touchHttp(machine, lnk)).toBe(false);
    expect(await hubs.cluster.getPresence(machineId)).toBe(nodeId);
    await sleep(200);
    expect((await machinesOf(hubs, 'u1'))[0]).toMatchObject({ online: true, transport: 'ws' });
  });

  it('after disconnect or revoke a late ping of the old stream does not bring the machine back online', async () => {
    const hubs = await faas({ n: 2, heartbeat: { pingIntervalMs: 50, missedPings: 2 } });
    const { token, machineId } = await hubs.pair('u1');
    const machines = hubs.hubs[1]![HUB_INTERNALS].machines;
    const a = await agentFor(hubs, token);
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    const machine = (await hubs.store.getMachine(machineId))!;
    await a.close();
    expect(await machines.touchHttp(machine, a.linkId)).toBe(false);
    await sleep(300);
    expect((await machinesOf(hubs, 'u1'))[0]!.online).toBe(false);

    const b = await agentFor(hubs, token);
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    expect((await hubs.as('u1', `/machines/${machineId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await b.ended).toBe('revoked');
    expect(await machines.touchHttp(machine, b.linkId)).toBe(false);
    expect(await hubs.cluster.getPresence(machineId)).toBeNull();
  });

  it('a transient failure releases the claim: the retry runs at once and later result frames are not stalled', async () => {
    let failNext = false;
    const hubs = await faas({
      n: 2,
      makeStore: async () => {
        const s = await pgliteHubStore({ dataDir: 'memory://' });
        const orig = s.getSession.bind(s);
        s.getSession = (id) => {
          if (failNext && id === 'ses_flaky') {
            failNext = false;
            return Promise.reject(new Error('connection reset'));
          }
          return orig(id);
        };
        return s;
      },
    });
    const { token } = await hubs.pair('u1');
    const fm = fakeMachine();
    const agent = await agentFor(hubs, token, { onCommand: fm.handler });
    await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
    failNext = true;
    const ev = { id: upId(), msg: { t: 'events' as const, sessionId: 'ses_flaky', events: [makeEvent('ses_flaky', 1, 'session.created', { session: fakeSession('ses_flaky') })] } };
    const first = (await (await agent.post({ msgs: [ev] })).json()) as HttpEventsResponse;
    expect(first).toMatchObject({ processed: [], retry: [ev.id] });
    const t0 = Date.now();
    const second = (await (await agent.post({ msgs: [ev] })).json()) as HttpEventsResponse;
    expect(second).toMatchObject({ processed: [ev.id], retry: [] });
    expect(Date.now() - t0).toBeLessThan(1000); // not the 30 s lease
    // A command's result posted right after is handled normally.
    expect((await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).status).toBe(201);
  });

  it('connection cuts while commands are in flight: each command is dispatched exactly once and the agent resumes from its cursor', async () => {
    const hubs = await faas({ n: 3, stream: { maxDurationMs: 400 }, polling: { activeMs: 20, idleMs: 100 } });
    const { token, machineId } = await hubs.pair('u1');
    const agent = await agentFor(hubs, token, { onCommand: () => [] });
    await until(() => agent.streams > 0);
    const cutter = setInterval(() => hubs.cutAll(), 70);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `cmd_cut_${i}`;
      ids.push(id);
      await hubs.store.enqueueOutbox(machineId, [{ msgId: id, msg: { t: 'command', id, op: 'listSessions', args: {} }, expiresAt: new Date(Date.now() + 60_000).toISOString() }], new Date().toISOString());
      await hubs.cluster.publish(machineChannel(machineId), 'wake');
      await sleep(15);
    }
    await until(() => agent.commands.length >= 40, 10_000);
    clearInterval(cutter);
    await sleep(200);
    expect(agent.commands.map((c) => c.id)).toEqual(ids); // in order, once each
    expect(agent.streams).toBeGreaterThan(2);
    // Redelivered lines (seq <= cursor after a cut) were skipped, never dispatched twice.
    const delivered = agent.lines.filter((l) => 'seq' in l).length;
    expect(delivered).toBeGreaterThanOrEqual(40);
    // Once the agent's cursor is acknowledged nothing is left in the outbox.
    expect((await agent.post({})).status).toBe(200);
    expect((await hubs.store.pollLink(machineId, agent.linkId, { after: 0, limit: 100, now: new Date().toISOString() })).items).toEqual([]);
  }, 30_000);

  it('wrong machine tokens on agent routes are rate limited per client IP through the store', async () => {
    const hubs = await faas({ n: 2, rateLimits: { agentAuthFailuresPerMinute: 3 } });
    const { token } = await hubs.pair('u1');
    const bad = { authorization: 'Bearer wrong-wrong-wrong-wrong' };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await hubs.fetch('/agent/connect', json(hello(), bad))).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]); // counted across both instances
    // A valid token is never limited.
    expect((await hubs.fetch('/agent/connect', json(hello(), { authorization: `Bearer ${token}` }))).status).toBe(200);
  });

  it('a request body that does not arrive within bodyTimeoutMs is refused', async () => {
    const hubs = await faas({ n: 1, bodyTimeoutMs: 200 });
    const { token } = await hubs.pair('u1');
    const w = await rawConnect(hubs, token);
    let cancel!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"linkId":"${w.linkId}",`));
        cancel = () => c.close();
      },
    });
    const t0 = Date.now();
    const res = await hubs.fetch('/agent/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: slow, duplex: 'half' } as RequestInit);
    cancel();
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toMatch(/did not arrive/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('presence written for HTTP is the http marker', async () => {
    const hubs = await faas({ n: 1 });
    const { token, machineId } = await hubs.pair('u1');
    await agentFor(hubs, token);
    await until(async () => (await hubs.cluster.getPresence(machineId)) === HTTP_PRESENCE);
  });
});
