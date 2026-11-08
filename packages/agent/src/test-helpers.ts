/** Test helpers: a real hub in-process, a cuttable TCP proxy, a tmp home, a silent logger. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, memoryCluster, type ClusterAdapter, type Hub, type HubOptions, type HubStore } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
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

/**
 * A `node:http` server for an in-process hub whose idle keep-alive connections are closed by the
 * client (fetch/undici's own idle timeout) or at teardown, never by the server. The test's fetch
 * and the hub share one event loop: after a stall longer than Node's server keep-alive timeout
 * (5 s + 1 s buffer; synchronous PGlite WASM or sync fs on a slow runner), the next request can go
 * out on the pooled connection before the server's idle timer runs, and the server then closes the
 * socket with that request unread: a connection reset (ECONNRESET) in the test.
 */
function inProcessServer(): Server {
  const server = createServer();
  server.keepAliveTimeout = 0;
  return server;
}

export async function startTestHub(o: Partial<HubOptions> & Record<string, unknown> = {}): Promise<TestHub> {
  // A store passed in is shared (e.g. by several hub nodes) and left open on close().
  const store = o.store ?? (await pgliteHubStore({ dataDir: 'memory://' }));
  const server = inProcessServer();
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
  attachWebSocket(hub, server);
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
      if (!o.store) await store.close();
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

// ---- FaaS mode (copied from @uncage/hub test-utils): several hub instances behind one server ----

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/**
 * Wraps `target` so that, after `kill()`, every method call returns a never-settling promise and
 * calls still in flight never settle either (a frozen, killed function instance).
 */
export function killable<T extends object>(target: T): { value: T; kill(): void } {
  let dead = false;
  const value = new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (dead) return never();
        const r = (v as (...a: unknown[]) => unknown).apply(t, args);
        if (r instanceof Promise) {
          return r.then(
            (x) => (dead ? never() : x),
            (e: unknown) => (dead ? never() : Promise.reject(e)),
          );
        }
        return r;
      };
    },
  });
  return { value, kill: () => void (dead = true) };
}

export interface FaasHubs {
  hubs: Hub[];
  /** The shared store and cluster the instances wrap. */
  store: HubStore;
  cluster: ClusterAdapter;
  origin: string;
  api: string;
  /** Which instance served each request (method, path below the API base). */
  requests: Array<{ i: number; method: string; path: string }>;
  /** Browser request as `user`. */
  as(user: string, path: string, init?: RequestInit): Promise<Response>;
  /** Device flow with programmatic approval → a site entry for agent.yaml. */
  pair(user: string): Promise<AgentSite>;
  /** Picks the instance for each request (default round-robin over live instances). */
  route(pick: (req: Request, n: number) => number): void;
  /** Destroys every open socket (a connection drop). */
  cutAll(): void;
  /** Stops routing to `i`, cuts its sockets, freezes its store and cluster. */
  kill(i: number): void;
  close(): Promise<void>;
}

/**
 * `n` hub instances sharing one store and one cluster behind one `node:http` server (each request
 * goes to one instance through its own `toNodeHandler`), like a FaaS deployment: no WebSocket
 * server (an upgrade request reaches `fetch`, which refuses it).
 */
export async function startFaasHubs(o: { n: number } & Partial<HubOptions> & Record<string, unknown>): Promise<FaasHubs> {
  const { n, ...rest } = o;
  const ownStore = !rest.store;
  const store = (rest.store as HubStore | undefined) ?? (await pgliteHubStore({ dataDir: 'memory://' }));
  const ownCluster = !rest.cluster;
  const cluster = (rest.cluster as ClusterAdapter | undefined) ?? memoryCluster();
  const server = inProcessServer();
  const sockets = new Set<NetSocket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = `${origin}/api/uncage`;

  const hubs: Hub[] = [];
  const kills: Array<() => void> = [];
  const handlers: Array<ReturnType<typeof toNodeHandler>> = [];
  for (let i = 0; i < n; i++) {
    const ks = killable(store);
    let dead = false;
    const kc = killable<ClusterAdapter>({
      ...cluster,
      publish: (c, m) => cluster.publish(c, m),
      setPresence: (a, b, c) => cluster.setPresence(a, b, c),
      getPresence: (a) => cluster.getPresence(a),
      clearPresence: (a, b) => cluster.clearPresence(a, b),
      // A killed instance no longer receives anything.
      subscribe: (c, fn) => cluster.subscribe(c, (m) => void (dead || fn(m))),
      close: async () => undefined,
    });
    const hub = await createHub({
      publicUrl: origin,
      getUser: async (req) => {
        const id = req.headers.get(USER_HEADER);
        return id ? { id } : null;
      },
      heartbeat: { pingIntervalMs: 200, missedPings: 3 },
      ...rest,
      store: ks.value,
      cluster: kc.value,
    } as HubOptions);
    hubs.push(hub);
    handlers.push(toNodeHandler(hub));
    kills.push(() => {
      dead = true;
      ks.kill();
      kc.kill();
    });
  }

  const killed = new Set<number>();
  const active = new Map<NetSocket, Set<number>>();
  const requests: FaasHubs['requests'] = [];
  let rr = 0;
  let pick = (_req: Request, count: number): number => {
    for (let k = 0; k < count; k++) {
      const i = rr++ % count;
      if (!killed.has(i)) return i;
    }
    throw new Error('every instance is killed');
  };
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let i: number;
    try {
      i = pick(new Request(url, { method: req.method ?? 'GET', headers }), n);
    } catch {
      res.socket?.destroy();
      return;
    }
    if (killed.has(i)) {
      res.socket?.destroy();
      return;
    }
    requests.push({ i, method: req.method ?? 'GET', path: url.pathname.replace(/^\/api\/uncage/, '') });
    const sock = req.socket;
    let set = active.get(sock);
    if (!set) active.set(sock, (set = new Set()));
    set.add(i);
    res.on('close', () => active.get(sock)?.delete(i));
    handlers[i]!(req, res);
  });

  const as = (user: string, path: string, init: RequestInit = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { [USER_HEADER]: user, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });

  return {
    hubs,
    store,
    cluster,
    origin,
    api,
    requests,
    as,
    async pair(user) {
      const code = (await (await fetch(`${api}/device/code`, { method: 'POST', body: '{}' })).json()) as DeviceCodeResponse;
      if ((await hubs[0]!.approveDevice(code.userCode, { id: user })) !== 'ok') throw new Error('approve failed');
      const tok = (await (await fetch(`${api}/device/token`, { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })).json()) as DeviceTokenResponse;
      if (tok.status !== 'ok') throw new Error(`pair failed: ${tok.status}`);
      return { id: tok.site.id, name: tok.site.name, url: tok.site.url, machineId: tok.machineId, token: tok.machineToken };
    },
    route(p) {
      pick = p;
    },
    cutAll() {
      for (const sock of sockets) sock.destroy();
    },
    kill(i) {
      killed.add(i);
      kills[i]!();
      for (const [sock, set] of active) if (set.has(i)) sock.destroy();
    },
    async close() {
      // A killed instance may never finish closing (its store hangs): do not wait for it.
      await Promise.all(hubs.map((h, i) => (killed.has(i) ? Promise.race([h.close(), sleep(200)]) : h.close())));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownCluster) await cluster.close();
      if (ownStore) await store.close();
    },
  };
}

/** Reads SSE frames from a fetch Response. */
export async function* readSse(res: Response): AsyncGenerator<{ id?: string; event?: string; data: string; comment?: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.startsWith(':')) {
          yield { data: block, comment: true };
          continue;
        }
        const frame: { id?: string; event?: string; data: string } = { data: '' };
        for (const line of block.split('\n')) {
          const [k, ...v] = line.split(': ');
          if (k === 'id') frame.id = v.join(': ');
          else if (k === 'event') frame.event = v.join(': ');
          else if (k === 'data') frame.data = v.join(': ');
        }
        yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
