import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { DeviceCodeResponse, DeviceTokenResponse } from '@uncage/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClusterAdapter } from '../cluster/cluster.js';
import { memoryCluster } from '../cluster/memory.js';
import type { HubInternals } from '../hub.js';
import type { HubStore } from '../store/store.js';
import { WebSocket } from 'ws';
import { createHub } from '../hub.js';
import { connectFakeAgent, fakeMachine, sleep, until } from '../test-utils.js';
import type { Hub, HubOptions } from '../types.js';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from './index.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup(o: { cluster?: ClusterAdapter; maintenance?: HubOptions['maintenance'] } & HubInternals = {}): Promise<{ hub: Hub; server: Server; origin: string; store: HubStore }> {
  const store = await pgliteHubStore({ dataDir: 'memory://' });
  closers.push(() => store.close());
  const server = createServer();
  // Upgrade sockets nobody handled are not tracked by closeAllConnections: destroy them too.
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = await createHub({ publicUrl: origin, store, getUser: async (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null), ...o });
  closers.push(() => hub.close());
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  return { hub, server, origin, store };
}

async function pair(hub: Hub, origin: string): Promise<Extract<DeviceTokenResponse, { status: 'ok' }>> {
  const api = `${origin}/api/uncage`;
  const code = (await (await fetch(`${api}/device/code`, { method: 'POST', body: '{}' })).json()) as DeviceCodeResponse;
  expect(await hub.approveDevice(code.userCode, { id: 'alice' })).toBe('ok');
  const tok = (await (await fetch(`${api}/device/token`, { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })).json()) as DeviceTokenResponse;
  if (tok.status !== 'ok') throw new Error(tok.status);
  return tok;
}

/**
 * Dials and resolves how it ended: `open`, the HTTP status / socket error of a refused upgrade, or
 * `timeout` (nobody handled the upgrade).
 */
function dial(url: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const t = setTimeout(() => {
      ws.terminate();
      resolve('timeout');
    }, 1000);
    ws.once('close', () => clearTimeout(t));
    ws.once('open', () => {
      ws.terminate();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
    ws.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
  });
}

describe('attachWebSocket', () => {
  it('attachWebSocket accepts a machine; the detach function stops new upgrades', async () => {
    const { hub, server, origin } = await setup();
    const detach = attachWebSocket(hub, server);
    const tok = await pair(hub, origin);
    const wsUrl = `${origin.replace('http', 'ws')}/api/uncage/agent`;
    expect(tok.transports).toEqual([{ kind: 'ws', url: wsUrl }]);
    const agent = await connectFakeAgent({ url: wsUrl, token: tok.machineToken });
    closers.push(() => agent.close());
    expect(agent.frames[0]).toMatchObject({ t: 'welcome', machineId: tok.machineId });

    detach();
    expect(await dial(wsUrl, tok.machineToken)).not.toBe('open');
    // The connected machine stays until the hub closes.
    expect(agent.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a custom path: sockets are accepted there and the offered URL follows it', async () => {
    const { hub, server, origin } = await setup();
    attachWebSocket(hub, server, { path: '/machines/ws' });
    const tok = await pair(hub, origin);
    const wsUrl = `${origin.replace('http', 'ws')}/machines/ws`;
    expect(tok.transports).toEqual([{ kind: 'ws', url: wsUrl }]);
    const agent = await connectFakeAgent({ url: wsUrl, token: tok.machineToken });
    closers.push(() => agent.close());
    expect(agent.frames[0]?.t).toBe('welcome');
    expect(await dial(`${origin.replace('http', 'ws')}/api/uncage/agent`, tok.machineToken)).not.toBe('open');
  });

  it('refuses a bad token with 401 and closes connected machines when the hub closes', async () => {
    const { hub, server, origin } = await setup();
    attachWebSocket(hub, server);
    const wsUrl = `${origin.replace('http', 'ws')}/api/uncage/agent`;
    expect(await dial(wsUrl, 'x'.repeat(43))).toBe('401');
    const tok = await pair(hub, origin);
    const agent = await connectFakeAgent({ url: wsUrl, token: tok.machineToken });
    await hub.close();
    expect((await agent.closed).code).toBe(1001);
    expect(await dial(wsUrl, tok.machineToken)).not.toBe('open');
  });

  it('a second attach throws until the first is detached', async () => {
    const { hub, server } = await setup();
    const detach = attachWebSocket(hub, server);
    expect(() => attachWebSocket(hub, server)).toThrow(/already has a WebSocket server attached/);
    detach();
    attachWebSocket(hub, server, { path: '/again' });
  });

  it('runs the retention sweep on a timer while attached, and stops after detach', async () => {
    const { hub, server, store } = await setup({ maintenance: { intervalMs: 30 } });
    const prune = vi.spyOn(store, 'pruneRunManifests');
    await sleep(100);
    expect(prune).not.toHaveBeenCalled(); // createHub alone runs nothing
    const detach = attachWebSocket(hub, server);
    await until(() => prune.mock.calls.length >= 2);
    detach();
    await sleep(50);
    const n = prune.mock.calls.length;
    await sleep(120);
    expect(prune.mock.calls.length).toBe(n);
  });
});

describe('node-channel subscription', () => {
  /** A memory cluster whose first `failures` node-channel subscribes reject. */
  function flakyCluster(failures: number): ClusterAdapter & { attempts: number } {
    const inner = memoryCluster();
    const c = {
      ...inner,
      attempts: 0,
      async subscribe(channel: string, fn: (msg: string) => void) {
        if (channel.startsWith('uncage:node:') && c.attempts++ < failures) throw new Error('subscribe failed');
        return inner.subscribe(channel, fn);
      },
    };
    return c;
  }

  it('a failed subscribe at attach is retried by the next hello; commands then reach the machine', async () => {
    const cluster = flakyCluster(1);
    closers.push(() => cluster.close());
    const { hub, server, origin } = await setup({ cluster });
    attachWebSocket(hub, server);
    const tok = await pair(hub, origin);
    const fm = fakeMachine();
    const agent = await connectFakeAgent({ url: `${origin.replace('http', 'ws')}/api/uncage/agent`, token: tok.machineToken, onCommand: fm.handler });
    closers.push(() => agent.close());
    expect(cluster.attempts).toBe(2);
    const res = await fetch(`${origin}/api/uncage/sessions`, { method: 'POST', headers: { 'x-user': 'alice' }, body: JSON.stringify({ runtime: 'fake' }) });
    expect(res.status).toBe(201);
  });

  it('a hello fails with 1011 (and takes no presence) while the subscribe keeps failing', async () => {
    const cluster = flakyCluster(Infinity);
    closers.push(() => cluster.close());
    const { hub, server, origin } = await setup({ cluster });
    attachWebSocket(hub, server);
    const tok = await pair(hub, origin);
    const agent = await connectFakeAgent({ url: `${origin.replace('http', 'ws')}/api/uncage/agent`, token: tok.machineToken, waitWelcome: false });
    expect((await agent.closed).code).toBe(1011);
    expect(agent.frames.some((f) => f.t === 'welcome')).toBe(false);
    expect(await cluster.getPresence(tok.machineId)).toBeNull();
  });
});
