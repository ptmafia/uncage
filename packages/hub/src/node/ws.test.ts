import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { DeviceCodeResponse, DeviceTokenResponse } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHub } from '../hub.js';
import { connectFakeAgent } from '../test-utils.js';
import type { Hub } from '../types.js';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from './index.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup(): Promise<{ hub: Hub; server: Server; origin: string }> {
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
  const hub = await createHub({ publicUrl: origin, store, getUser: async (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null) });
  closers.push(() => hub.close());
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  return { hub, server, origin };
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
});
