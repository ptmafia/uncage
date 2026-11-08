import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceCodeResponse, Session } from '@uncage/protocol';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_GRACE_MS, CLOSE } from './node/ws.js';
import { createHub, DEFAULT_HEARTBEAT } from './hub.js';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from './node/index.js';
import { memoryCluster } from './cluster/memory.js';
import type { ClusterAdapter } from './cluster/cluster.js';
import { connectFakeAgent, fakeMachine, makeEvent, fakeSession, NO_REPLY, sleep, startTestHub, until, USER_HEADER, type FakeAgent, type TestHub } from './test-utils.js';
import type { Hub } from './types.js';

let th: TestHub | undefined;
const agents: FakeAgent[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await th?.close();
  th = undefined;
  for (const c of cleanups.splice(0)) await c();
});
const start = async (o: Parameters<typeof startTestHub>[0] = {}) => (th = await startTestHub(o));
const connect = async (o: Parameters<typeof connectFakeAgent>[0]) => {
  const a = await connectFakeAgent(o);
  agents.push(a);
  return a;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('toNodeHandler alongside website routes (Express)', () => {
  async function site(mount: 'root' | 'prefix'): Promise<{ url: string; hub: Hub }> {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const app = express();
    const server: Server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hub = await createHub({ publicUrl: url, store, getUser: async (req) => (req.headers.get(USER_HEADER) ? { id: req.headers.get(USER_HEADER)! } : null) });
    app.get('/', (_req, res) => {
      res.send('home');
    });
    if (mount === 'root') app.use(toNodeHandler(hub));
    else app.use('/api/uncage', toNodeHandler(hub));
    app.post('/other', (_req, res) => {
      res.json({ site: true });
    });
    app.put('/api/uncagexyz', (_req, res) => {
      res.send('not the hub');
    });
    attachWebSocket(hub, server);
    cleanups.push(async () => {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
    });
    return { url, hub };
  }

  for (const mount of ['root', 'prefix'] as const) {
    it(`mounted at ${mount}: only basePath is the hub's, everything else reaches the website`, async () => {
      const { url } = await site(mount);
      expect(await (await fetch(`${url}/`)).text()).toBe('home');
      expect(await (await fetch(`${url}/other`, { method: 'POST' })).json()).toEqual({ site: true });
      // Methods the hub does not serve, outside basePath: not a hub 405.
      expect(await (await fetch(`${url}/api/uncagexyz`, { method: 'PUT' })).text()).toBe('not the hub');
      const missing = await fetch(`${url}/no-such-page`, { method: 'OPTIONS' });
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type') ?? '').not.toContain('application/json'); // Express's 404, not the hub's
      // The hub answers under basePath.
      const health = await fetch(`${url}/api/uncage/health`, { headers: { [USER_HEADER]: 'alice' } });
      expect(health.status).toBe(200);
      expect((await j(health)).ok).toBe(true);
      const nope = await fetch(`${url}/api/uncage/nope`, { headers: { [USER_HEADER]: 'alice' } });
      expect(nope.status).toBe(404);
      expect((await j(nope)).error.code).toBe('not_found');
    });
  }

  it('plain node:http (no next): outside basePath → bare 404', async () => {
    const t = await start();
    const res = await fetch(`${t.origin}/elsewhere`, { method: 'PUT' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });
});

describe('retired connections stop at once', () => {
  it('revoke: frames after the revoke are ignored and the socket is cut even if the client never answers the close', async () => {
    const t = await start({ sessionStorage: 'site' });
    const { machineId, machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    a.ignoreClose();
    const startedAt = Date.now();
    expect((await t.as('alice', `/machines/${machineId}`, { method: 'DELETE' })).status).toBe(200);
    // The stale client keeps talking.
    a.sendEvents('ses_stale', [makeEvent('ses_stale', 1, 'session.created', { session: fakeSession('ses_stale') })]);
    const closed = await a.closed;
    expect(Date.now() - startedAt).toBeLessThan(CLOSE_GRACE_MS + 1500);
    expect(closed.code).toBe(CLOSE.revoked);
    await sleep(50);
    expect(await t.store.getSession('ses_stale')).toBeNull();
    expect(a.frames.some((f) => f.t === 'ack')).toBe(false);
  });

  it('replacement: the old socket is dropped at once, its in-flight commands fail immediately, its late results are ignored', async () => {
    const t = await start();
    const { machineToken } = await t.pair('alice');
    const old = await connect({ url: t.wsUrl, token: machineToken, onCommand: () => NO_REPLY });
    old.ignoreClose();
    const startedAt = Date.now();
    const pending = t.as('alice', '/sessions', post({ runtime: 'fake' }));
    await until(() => old.commands.length === 1);
    const fm = fakeMachine();
    const fresh = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe('machine_offline');
    expect(Date.now() - startedAt).toBeLessThan(3000); // not the 30 s command timeout
    // A late answer from the old socket changes nothing.
    old.send({ t: 'result', id: old.commands[0]!.id, ok: true, data: fakeSession('ses_late') });
    expect((await old.closed).code).toBe(CLOSE.replaced);
    expect(await t.store.getSession('ses_late')).toBeNull();
    // The new connection serves requests.
    const ok = await t.as('alice', '/sessions', post({ runtime: 'fake' }));
    expect(ok.status).toBe(201);
    expect(fresh.commands.map((c) => c.op)).toEqual(['createSession']);
  });
});

describe('heartbeat defaults', () => {
  it('detects a silent machine within 30 s', () => {
    expect(DEFAULT_HEARTBEAT).toEqual({ pingIntervalMs: 10_000, missedPings: 2 });
    expect(DEFAULT_HEARTBEAT.pingIntervalMs * (DEFAULT_HEARTBEAT.missedPings + 1)).toBeLessThanOrEqual(30_000);
  });
});

describe('rate limits', () => {
  it('POST /device/code per client IP (X-Forwarded-For does not bypass it through toNodeHandler)', async () => {
    const t = await start({ rateLimits: { deviceCodesPerMinute: 2 } });
    const code = (xff: string) => fetch(`${t.api}/device/code`, post({}, { 'x-forwarded-for': xff }));
    expect((await code('1.1.1.1')).status).toBe(200);
    expect((await code('2.2.2.2')).status).toBe(200);
    const limited = await code('3.3.3.3');
    expect(limited.status).toBe(429);
    const body = (await j(limited)).error;
    expect(body.code).toBe('rate_limited');
    expect(body.details.retryAfterSec).toBeGreaterThan(0);
  });

  async function directHub(rateLimits: NonNullable<Parameters<typeof createHub>[0]['rateLimits']>): Promise<Hub> {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const hub = await createHub({ publicUrl: 'https://app.example', store, getUser: async () => null, rateLimits });
    cleanups.push(async () => {
      await hub.close();
      await store.close();
    });
    return hub;
  }
  const codeReq = (headers: Record<string, string> = {}) =>
    new Request('https://app.example/api/uncage/device/code', { method: 'POST', headers });

  it('handler() without a client IP ignores X-Forwarded-For by default (one shared bucket)', async () => {
    const hub = await directHub({ deviceCodesPerMinute: 1 });
    expect((await hub.fetch(codeReq({ 'x-forwarded-for': '1.1.1.1' }))).status).toBe(200);
    // A spoofed X-Forwarded-For does not buy a fresh bucket.
    expect((await hub.fetch(codeReq({ 'x-forwarded-for': '2.2.2.2' }))).status).toBe(429);
    expect((await hub.fetch(codeReq())).status).toBe(429);
    // An explicit client IP does.
    expect((await hub.fetch(codeReq(), { clientIp: '9.9.9.9' })).status).toBe(200);
  });

  it('trustForwardedFor uses the rightmost entry, so a spoofed leading entry cannot bypass the limit', async () => {
    const hub = await directHub({ deviceCodesPerMinute: 1, trustForwardedFor: true });
    // The proxy appends the real client (5.5.5.5); the client forged the leading entries.
    expect((await hub.fetch(codeReq({ 'x-forwarded-for': '1.1.1.1, 5.5.5.5' }))).status).toBe(200);
    expect((await hub.fetch(codeReq({ 'x-forwarded-for': '2.2.2.2, 5.5.5.5' }))).status).toBe(429);
    expect((await hub.fetch(codeReq({ 'x-forwarded-for': '6.6.6.6' }))).status).toBe(200);
  });

  it('a custom clientIp wins over the socket address passed by toNodeHandler', async () => {
    const t = await start({ rateLimits: { deviceCodesPerMinute: 1, clientIp: (req) => req.headers.get('x-real-client') ?? undefined } });
    const code = (who: string) => fetch(`${t.api}/device/code`, post({}, { 'x-real-client': who }));
    expect((await code('a')).status).toBe(200);
    expect((await code('b')).status).toBe(200); // same socket address, different custom key
    expect((await code('a')).status).toBe(429);
  });

  it('toNodeHandler uses Express req.ip (trust proxy) when present', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const app = express();
    app.set('trust proxy', 1);
    const server: Server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hub = await createHub({ publicUrl: url, store, getUser: async () => null, rateLimits: { deviceCodesPerMinute: 1 } });
    app.use(toNodeHandler(hub));
    cleanups.push(async () => {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
    });
    const code = (xff: string) => fetch(`${url}/api/uncage/device/code`, post({}, { 'x-forwarded-for': xff }));
    // One trusted proxy: req.ip is the rightmost entry.
    expect((await code('9.9.9.9, 1.1.1.1')).status).toBe(200);
    expect((await code('8.8.8.8, 1.1.1.1')).status).toBe(429);
    expect((await code('2.2.2.2')).status).toBe(200);
  });

  it('parallel guesses cannot exceed the per-user failure limit', async () => {
    const t = await start({ rateLimits: { userCodeFailures: 3 } });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => t.hub.approveDevice('ZZZZ-ZZZZ', { id: 'mallory' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'rate_limited')).toBe(true);
  });

  it('approve/deny/lookup throw rate_limited after too many unknown codes from one user', async () => {
    const t = await start({ rateLimits: { userCodeFailures: 3 } });
    const code = (await (await fetch(`${t.api}/device/code`, post({}))).json()) as DeviceCodeResponse;
    for (let i = 0; i < 3; i++) expect(await t.hub.approveDevice('ZZZZ-ZZZZ', { id: 'mallory' })).toBe('not_found');
    await expect(t.hub.approveDevice(code.userCode, { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(t.hub.lookupDevice(code.userCode, { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await t.hub.approveDevice(code.userCode, { id: 'alice' })).toBe('ok');
  });

  it('/device/token answers slow_down when polled faster than intervalSec', async () => {
    const t = await start();
    const code = (await (await fetch(`${t.api}/device/code`, post({}))).json()) as DeviceCodeResponse;
    const poll = async () => (await fetch(`${t.api}/device/token`, post({ deviceCode: code.deviceCode }))).json();
    expect(await poll()).toEqual({ status: 'pending' });
    expect(await poll()).toEqual({ status: 'slow_down' });
  });
});

describe('stable machine identity (machineKey)', () => {
  it('re-pairing the same machine for the same user keeps its id and sessions, rotates its token', async () => {
    const t = await start({ sessionStorage: 'site' });
    const machineKey = 'A'.repeat(43);
    const fm = fakeMachine();
    const first = await t.pair('alice', { name: 'MBP', machineKey });
    const a = await connect({ url: t.wsUrl, token: first.machineToken, onCommand: fm.handler });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;

    const second = await t.pair('alice', { name: 'MBP', machineKey });
    expect(second.machineId).toBe(first.machineId);
    expect(second.machineToken).not.toBe(first.machineToken);
    // The connection on the old token is closed; the old token no longer works.
    expect((await a.closed).code).toBe(CLOSE.replaced);
    await expect(connectFakeAgent({ url: t.wsUrl, token: first.machineToken })).rejects.toThrow(/401/);
    await connect({ url: t.wsUrl, token: second.machineToken, onCommand: fm.handler });
    const machines = await (await t.as('alice', '/machines')).json();
    expect(machines).toHaveLength(1);
    expect(((await (await t.as('alice', '/sessions')).json()) as Session[]).map((x) => x.id)).toEqual([s.id]);
    expect((await t.as('alice', `/sessions/${s.id}`)).status).toBe(200);
  });

  it('another user with the same key, or no key, gets a new machine; bad keys are refused', async () => {
    const t = await start();
    const machineKey = 'B'.repeat(43);
    const fm = fakeMachine();
    const alice = await t.pair('alice', { machineKey });
    const a = await connect({ url: t.wsUrl, token: alice.machineToken, onCommand: fm.handler });
    const s = (await j(t.as('alice', '/sessions', post({ runtime: 'fake' })))) as Session;
    // Bob's approve page does not claim it re-pairs anything of his.
    const code = (await j(fetch(`${t.api}/device/code`, post({ machineKey })))) as DeviceCodeResponse;
    expect(await t.hub.lookupDevice(code.userCode, { id: 'bob' })).toMatchObject({ repairsMachine: null });
    expect(await t.hub.lookupDevice(code.userCode, { id: 'alice' })).toMatchObject({ repairsMachine: { id: alice.machineId, name: 'Test Mac' } });
    const bob = await t.pair('bob', { machineKey });
    expect(bob.machineId).not.toBe(alice.machineId);
    // Alice is untouched: still connected, token still valid, sessions hers only.
    await sleep(CLOSE_GRACE_MS + 100);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    expect((await j(t.as('alice', '/machines')))[0]).toMatchObject({ id: alice.machineId, online: true });
    expect((await t.as('alice', `/sessions/${s.id}`)).status).toBe(200);
    const extra = await connectFakeAgent({ url: t.wsUrl, token: alice.machineToken });
    await extra.close(); // (token accepted; this replaced alice's socket, so reconnect her)
    await connect({ url: t.wsUrl, token: alice.machineToken, onCommand: fm.handler });
    expect(await j(t.as('bob', '/sessions'))).toEqual([]);
    expect((await t.as('bob', `/sessions/${s.id}`)).status).toBe(404);
    expect((await j(t.as('bob', '/machines'))).map((m: { id: string }) => m.id)).toEqual([bob.machineId]);
    const again = await t.pair('alice', {});
    expect(again.machineId).not.toBe(alice.machineId);
    // A revoked machine is not revived.
    await t.hub.revokeMachine(alice.machineId, { id: 'alice' });
    const after = await t.pair('alice', { machineKey });
    expect(after.machineId).not.toBe(alice.machineId);
    expect((await fetch(`${t.api}/device/code`, post({ machineKey: 'short' }))).status).toBe(400);
  });
});

describe('presence race', () => {
  it('a socket that closes while presence is being set does not leave the machine online', async () => {
    const inner = memoryCluster();
    let gate: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredP = new Promise<void>((r) => (entered = r));
    const cluster: ClusterAdapter = {
      ...inner,
      async setPresence(...args) {
        if (!gate) {
          entered?.();
          await new Promise<void>((r) => (gate = r));
        }
        return inner.setPresence(...args);
      },
    };
    const t = await start({ cluster });
    cleanups.push(() => inner.close());
    const { machineId, machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, waitWelcome: false });
    await enteredP;
    a.ws.terminate();
    await sleep(100); // the hub sees the close while setPresence is still pending
    gate!();
    await sleep(100);
    expect(await inner.getPresence(machineId)).toBeNull();
    expect((await j(t.as('alice', '/machines')))[0].online).toBe(false);
  });
});
