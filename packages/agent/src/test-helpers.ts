/** Test helpers: a real hub in-process, a cuttable TCP proxy, a tmp home, a silent logger. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, pgliteHubStore, toNodeHandler, type Hub, type HubOptions, type HubStore } from '@uncage/hub';
import type { DeviceCodeResponse, DeviceTokenResponse } from '@uncage/protocol';
import type { AgentSite } from './config.js';
import type { AgentLogger } from './site.js';

export const USER_HEADER = 'x-test-user';

export interface TestHub {
  hub: Hub;
  store: HubStore;
  origin: string;
  api: string;
  as(user: string, path: string, init?: RequestInit): Promise<Response>;
  /** Device flow with programmatic approval → a site entry for agent.yaml. */
  pair(user: string, o?: { machineKey?: string; url?: string }): Promise<AgentSite>;
  close(): Promise<void>;
}

export async function startTestHub(o: Partial<HubOptions> & Record<string, unknown> = {}): Promise<TestHub> {
  const store = await pgliteHubStore({ dataDir: 'memory://' });
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = await createHub({
    publicUrl: origin,
    getUser: async (req) => {
      const id = req.headers.get(USER_HEADER);
      return id ? { id } : null;
    },
    heartbeat: { pingIntervalMs: 200, missedPings: 3 },
    ...o,
    store,
  } as HubOptions);
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  hub.attach(server);
  const api = `${origin}/api/uncage`;
  const as = (user: string, path: string, init: RequestInit = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { [USER_HEADER]: user, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  return {
    hub,
    store,
    origin,
    api,
    as,
    async pair(user, p = {}) {
      const code = (await (
        await fetch(`${api}/device/code`, { method: 'POST', body: JSON.stringify(p.machineKey ? { machineKey: p.machineKey } : {}) })
      ).json()) as DeviceCodeResponse;
      if ((await hub.approveDevice(code.userCode, { id: user })) !== 'ok') throw new Error('approve failed');
      const tok = (await (await fetch(`${api}/device/token`, { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })).json()) as DeviceTokenResponse;
      if (tok.status !== 'ok') throw new Error(`pair failed: ${tok.status}`);
      return { id: tok.site.id, name: tok.site.name, url: p.url ?? tok.site.url, machineId: tok.machineId, token: tok.machineToken };
    },
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
    },
  };
}

/** A TCP proxy to `target` whose connections can be cut (simulates Wi-Fi drop / laptop sleep). */
export async function startProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  let accepting = true;
  const server = createTcpServer((client) => {
    if (!accepting) return client.destroy();
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client).add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/api/uncage`,
    /** Cut every connection and refuse new ones until `restore()`. */
    cut() {
      accepting = false;
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    restore() {
      accepting = true;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export async function tmpHome(): Promise<{ home: string; cleanup(): Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'uncage-agent-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export interface MemoryLogger extends AgentLogger {
  lines: Array<{ level: string; msg?: string; obj: object }>;
}

export function memoryLogger(): MemoryLogger {
  const lines: MemoryLogger['lines'] = [];
  const at = (level: string) => (obj: object, msg?: string) => void lines.push({ level, obj, ...(msg !== undefined ? { msg } : {}) });
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T> | T, timeoutMs = 8000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`until: timed out waiting for ${what}`);
    await sleep(20);
  }
}

export const FAST = { backoffMinMs: 30, backoffMaxMs: 200, idleTimeoutMs: 3000 };
