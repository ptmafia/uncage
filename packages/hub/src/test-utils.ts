/**
 * Test helpers: a hub on a real HTTP server, and an in-process fake agent (a `ws` client speaking
 * the connected-mode frames).
 */
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  CONNECTED_PROTOCOL,
  FILE_CHUNK_BYTES,
  formatEventId,
  parseHubFrame,
  parseStreamLine,
  type AgentFrame,
  type HttpConnectResponse,
  type HttpEventsRequest,
  type HttpEventsResponse,
  type StreamLine,
  type UpstreamMessage,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
  type EventType,
  type HubCommandOp,
  type HubFrame,
  type RuntimeInfo,
  type Session,
  type UncageEvent,
  type UncageEventMap,
} from '@uncage/protocol';
import { WebSocket } from 'ws';
import type { ClusterAdapter } from './cluster/cluster.js';
import { memoryCluster } from './cluster/memory.js';
import { createHub, type HubInternals } from './hub.js';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from './node/index.js';
import type { HubStore } from './store/store.js';
import type { Hub, HubOptions, HubUser } from './types.js';

export const USER_HEADER = 'x-test-user';

export interface TestHub {
  hub: Hub;
  store: HubStore;
  server: Server;
  /** e.g. `http://127.0.0.1:1234` */
  origin: string;
  /** `<origin>/api/uncage` */
  api: string;
  /** `ws://127.0.0.1:1234/api/uncage/agent` */
  wsUrl: string;
  /** fetch against the browser API as `user` (path relative to the API base). */
  as(user: string, path: string, init?: RequestInit): Promise<Response>;
  /** Device flow end to end; resolves the machine credentials. */
  pair(user: string, machine?: { name?: string; os?: string; machineKey?: string }): Promise<{ machineId: string; machineToken: string }>;
  close(): Promise<void>;
}

export async function startTestHub(o: Partial<HubOptions> & HubInternals = {}): Promise<TestHub> {
  const store = o.store ?? (await pgliteHubStore({ dataDir: 'memory://' }));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = await createHub({
    publicUrl: origin,
    getUser: async (req) => {
      const id = req.headers.get(USER_HEADER);
      return id ? ({ id } satisfies HubUser) : null;
    },
    ...o,
    store,
  });
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  attachWebSocket(hub, server);
  const api = `${origin}/api/uncage`;

  const as = (user: string, path: string, init: RequestInit = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { [USER_HEADER]: user, ...(init.headers as Record<string, string>) } });

  return {
    hub,
    store,
    server,
    origin,
    api,
    wsUrl: `${origin.replace('http', 'ws')}/api/uncage/agent`,
    as,
    async pair(user, machine = {}) {
      const code = (await (await fetch(`${api}/device/code`, { method: 'POST', body: JSON.stringify(machine) })).json()) as DeviceCodeResponse;
      if ((await hub.approveDevice(code.userCode, { id: user })) !== 'ok') throw new Error('approve failed');
      const tok = (await (
        await fetch(`${api}/device/token`, { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })
      ).json()) as DeviceTokenResponse;
      if (tok.status !== 'ok') throw new Error(`pair failed: ${tok.status}`);
      return { machineId: tok.machineId, machineToken: tok.machineToken };
    },
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!o.store) await store.close();
    },
  };
}

export const FAKE_RUNTIME: RuntimeInfo = { id: 'fake', displayName: 'Fake', status: 'available' };

type CommandFrame = Extract<HubFrame, { t: 'command' }>;
/** Return this from a command handler to never answer the command. */
export const NO_REPLY = Symbol('no reply');
/** Returns the command's `data` (or `NO_REPLY`), or throws `{ code, message }` to fail it. */
export type CommandHandler = (cmd: CommandFrame) => unknown;

export interface FakeAgent {
  ws: WebSocket;
  /** Every frame received, in order. */
  frames: HubFrame[];
  commands: CommandFrame[];
  /** Resolves the first frame matching `pred` (past or future). */
  waitFor<T extends HubFrame>(pred: (f: HubFrame) => f is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (f: HubFrame) => boolean, timeoutMs?: number): Promise<HubFrame>;
  send(f: AgentFrame): void;
  /** Make the client ignore the hub's close frame (never completes the closing handshake). */
  ignoreClose(): void;
  sendEvents(sessionId: string, events: UncageEvent[]): void;
  /** Stop answering pings (simulates a sleeping laptop whose TCP connection stays up). */
  autoPong: boolean;
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

/**
 * Connects like a real agent: Bearer token on upgrade, `hello` first. Answers `ping` with `pong`
 * and `command` with `onCommand` (default: fail with `internal_error`).
 */
export async function connectFakeAgent(o: {
  url: string;
  token: string;
  agentVersion?: string;
  protocol?: number;
  name?: string;
  os?: string;
  runtimes?: RuntimeInfo[];
  onCommand?: CommandHandler;
  /** Called for every hub frame (after `onCommand` handling). */
  onFrame?: (f: HubFrame, send: (f: AgentFrame) => void) => void;
  /** Resolve once `welcome` arrives (default true). */
  waitWelcome?: boolean;
}): Promise<FakeAgent> {
  const ws = new WebSocket(o.url, { headers: { authorization: `Bearer ${o.token}` } });
  const frames: HubFrame[] = [];
  const commands: CommandFrame[] = [];
  const waiters: Array<{ pred: (f: HubFrame) => boolean; resolve: (f: HubFrame) => void }> = [];
  const send = (f: AgentFrame) => ws.send(JSON.stringify(f));
  const agent: FakeAgent = {
    ws,
    frames,
    commands,
    autoPong: true,
    waitFor(pred: (f: HubFrame) => boolean, timeoutMs = 5000): Promise<HubFrame> {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(t);
            resolve(f);
          },
        });
      });
    },
    send,
    ignoreClose: () => {
      (ws as unknown as { close: () => void }).close = () => undefined;
    },
    sendEvents: (sessionId, events) => send({ t: 'events', sessionId, events }),
    closed: new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      WebSocket.prototype.close.call(ws);
      await agent.closed;
    },
  } as FakeAgent;

  ws.on('message', (data) => {
    const f = parseHubFrame(data.toString());
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
    if (f.t === 'ping' && agent.autoPong) send({ t: 'pong', at: f.at });
    o.onFrame?.(f, send);
    if (f.t === 'command') {
      commands.push(f);
      try {
        const data = (o.onCommand ?? defaultCommand)(f);
        if (data !== NO_REPLY) send({ t: 'result', id: f.id, ok: true, data });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        send({
          t: 'result',
          id: f.id,
          ok: false,
          error: { code: (err.code ?? 'internal_error') as never, message: err.message ?? 'failed', retryable: false },
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
  });
  send({
    t: 'hello',
    protocol: o.protocol ?? CONNECTED_PROTOCOL,
    agentVersion: o.agentVersion ?? '99.0.0',
    transport: 'ws',
    machine: { name: o.name ?? 'Test Mac', os: o.os ?? 'darwin', runtimes: o.runtimes ?? [FAKE_RUNTIME] },
  });
  if (o.waitWelcome ?? true) await agent.waitFor((f) => f.t === 'welcome');
  return agent;
}

const defaultCommand: CommandHandler = () => {
  throw Object.assign(new Error('no handler'), { code: 'internal_error' });
};

export function fakeSession(id: string, title = 'Untitled'): Session {
  return {
    id,
    runtimeId: 'fake',
    workspace: `/Users/test/Uncage/site/${id}`,
    title,
    status: 'ready',
    readOnly: false,
    createdAt: new Date().toISOString(),
    capabilities: {
      streaming: true,
      approval: { once: true, session: false, types: ['shell'] },
      nativeResume: false,
      diffEvents: false,
      mcp: true,
      skills: 'supported',
      siteTools: true,
      models: [],
      efforts: [],
      permissionModes: ['default'],
      attachments: { images: true, files: true, maxBytes: 10_000_000 },
    },
    settings: { permissionMode: 'default' },
  };
}

export function makeEvent<K extends EventType>(sessionId: string, sequence: number, type: K, payload: UncageEventMap[K], runId?: string): UncageEvent {
  return {
    eventId: formatEventId(sequence),
    sequence,
    sessionId,
    ...(runId ? { runId } : {}),
    type,
    occurredAt: new Date().toISOString(),
    schemaVersion: '1.0',
    payload,
  } as UncageEvent;
}

/** A minimal machine-side session store answering commands like a real agent would. */
export function fakeMachine() {
  const sessions = new Map<string, { session: Session; events: UncageEvent[] }>();
  const runsByKey = new Map<string, unknown>();
  /** The manifest each run was started with, by run id. */
  const manifests = new Map<string, { tools: Array<{ name: string }> }>();
  let n = 0;
  const handler: CommandHandler = (cmd) => {
    const a = cmd.args as Record<string, unknown>;
    const op = cmd.op as HubCommandOp;
    switch (op) {
      case 'createSession': {
        // Like the real agent: the hub's id when it sent one.
        const id = (a.id as string | undefined) ?? `ses_${String(++n).padStart(4, '0')}${Math.random().toString(16).slice(2, 10)}`;
        const session = fakeSession(id, (a.title as string | undefined) ?? 'Untitled');
        sessions.set(id, { session, events: [makeEvent(id, 1, 'session.created', { session })] });
        return session;
      }
      case 'startRun': {
        const s = sessions.get(a.sessionId as string);
        if (!s) throw Object.assign(new Error('Session not found.'), { code: 'not_found' });
        const key = a.idempotencyKey as string;
        const existing = runsByKey.get(`${s.session.id}:${key}`);
        if (existing) return existing;
        const run = { id: `run_${String(++n).padStart(4, '0')}${Math.random().toString(16).slice(2, 10)}`, sessionId: s.session.id, prompt: a.prompt as string, state: 'running', createdAt: new Date().toISOString() };
        runsByKey.set(`${s.session.id}:${key}`, run);
        manifests.set(run.id, a.manifest as { tools: Array<{ name: string }> });
        return run;
      }
      case 'listSessions':
        return [...sessions.values()].map((s) => s.session);
      case 'snapshot': {
        const s = sessions.get(a.sessionId as string);
        if (!s) throw Object.assign(new Error('Session not found.'), { code: 'not_found' });
        return { session: s.session, runs: [], pendingApprovals: [], lastSequence: s.events.length };
      }
      case 'readEvents': {
        const s = sessions.get(a.sessionId as string);
        if (!s) throw Object.assign(new Error('Session not found.'), { code: 'not_found' });
        return s.events.filter((e) => e.sequence > (a.after as number)).slice(0, a.limit as number);
      }
      default:
        throw Object.assign(new Error(`unhandled ${op}`), { code: 'internal_error' });
    }
  };
  /** Appends an event to the session's log (and returns it) so it can also be sent live. */
  const append = <K extends EventType>(sessionId: string, type: K, payload: UncageEventMap[K], runId?: string): UncageEvent => {
    const s = sessions.get(sessionId)!;
    const e = makeEvent(sessionId, s.events.length + 1, type, payload, runId);
    s.events.push(e);
    return e;
  };
  return { sessions, handler, append, manifests };
}

/** Reads SSE frames from a fetch Response. */
export async function* readSse(res: Response): AsyncGenerator<{ id?: string; event?: string; data: string; comment?: boolean }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += value;
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
        const [k, ...rest] = line.split(': ');
        const v = rest.join(': ');
        if (k === 'id') frame.id = v;
        else if (k === 'event') frame.event = v;
        else if (k === 'data') frame.data = v;
      }
      yield frame;
    }
  }
}

/**
 * Answers `file_pull` frames like a real agent from an in-memory tree (`'dir/a.txt' → bytes`):
 * every file under the requested path, 256 KiB chunks, then `file_done`. `fail` sends an error
 * `result` after the first chunk instead of finishing.
 */
export function pullServer(tree: Record<string, Uint8Array | string>, o: { fail?: boolean; skipped?: Array<{ path: string; reason: string }> } = {}) {
  const pulls: Array<Extract<HubFrame, { t: 'file_pull' }>> = [];
  const onFrame = (f: HubFrame, send: (f: AgentFrame) => void) => {
    if (f.t !== 'file_pull') return;
    pulls.push(f);
    const paths = Object.keys(tree)
      .filter((p) => p === f.path || p.startsWith(`${f.path}/`))
      .sort();
    if (paths.length === 0) {
      send({ t: 'result', id: f.id, ok: false, error: { code: 'not_found', message: `"${f.path}" does not exist in the session workspace.`, retryable: false } });
      return;
    }
    const files: Array<{ path: string; size: number }> = [];
    for (const path of paths) {
      const raw = tree[path]!;
      const data = Buffer.from(typeof raw === 'string' ? Buffer.from(raw) : raw);
      let seq = 0;
      for (let at = 0; ; at += FILE_CHUNK_BYTES) {
        const part = data.subarray(at, at + FILE_CHUNK_BYTES);
        const last = at + FILE_CHUNK_BYTES >= data.length;
        send({ t: 'file_chunk', id: f.id, path, seq: seq++, data: part.toString('base64'), last });
        if (o.fail) {
          send({ t: 'result', id: f.id, ok: false, error: { code: 'invalid_request', message: `"${path}" changed while it was being pulled.`, retryable: false } });
          return;
        }
        if (last) break;
      }
      files.push({ path, size: data.length });
    }
    send({ t: 'file_done', id: f.id, files, ...(o.skipped ? { skipped: o.skipped } : {}) });
  };
  return { pulls, onFrame };
}

/** Assembles chunked `attachment_*` uploads like a real agent and answers with an `Attachment`. */
export function uploadReceiver() {
  const received = new Map<string, { begin: Extract<HubFrame, { t: 'attachment_begin' }>; parts: Buffer[]; data?: Buffer; aborted?: boolean }>();
  const onFrame = (f: HubFrame, send: (f: AgentFrame) => void) => {
    if (f.t === 'attachment_begin') received.set(f.id, { begin: f, parts: [] });
    else if (f.t === 'attachment_chunk') received.get(f.id)?.parts.push(Buffer.from(f.data, 'base64'));
    else if (f.t === 'attachment_abort') {
      const u = received.get(f.id);
      if (u) u.aborted = true;
    } else if (f.t === 'attachment_end') {
      const u = received.get(f.id);
      if (!u) return;
      u.data = Buffer.concat(u.parts);
      const { begin } = u;
      send({
        t: 'result',
        id: f.id,
        ok: true,
        data: {
          id: `att_${f.id.replace(/[^a-z0-9]/gi, '').slice(-12)}`,
          sessionId: begin.sessionId,
          name: begin.name,
          mime: begin.mime,
          size: u.data.length,
          kind: 'file',
          sha256: createHash('sha256').update(u.data).digest('hex'),
          createdAt: new Date().toISOString(),
        },
      });
    }
  };
  return { received, onFrame };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns truthy. */
export async function until<T>(fn: () => Promise<T> | T, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('until: timed out');
    await sleep(10);
  }
}

// ---- FaaS mode: several hub instances behind one HTTP server, an HTTP-streaming fake agent ----

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
  stores: HubStore[];
  /** The shared store and cluster the instances wrap. */
  store: HubStore;
  cluster: ClusterAdapter;
  origin: string;
  api: string;
  /** Which instance served each request (method, path below the API base). */
  requests: Array<{ i: number; method: string; path: string }>;
  /** Raw request to the next instance (a WebSocket upgrade request reaches `fetch` too). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Browser request as `user`. */
  as(user: string, path: string, init?: RequestInit): Promise<Response>;
  pair(user: string): Promise<{ machineId: string; token: string }>;
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
 * goes to one instance through its own `toNodeHandler`), like a FaaS deployment: no WebSocket.
 */
export async function startFaasHubs(
  o: { n: number; makeStore?: () => Promise<HubStore>; makeCluster?: () => ClusterAdapter } & Partial<HubOptions> & HubInternals,
): Promise<FaasHubs> {
  const { n, makeStore, makeCluster, ...rest } = o;
  const ownStore = !rest.store;
  const store = rest.store ?? (makeStore ? await makeStore() : await pgliteHubStore({ dataDir: 'memory://' }));
  const ownCluster = !rest.cluster;
  const cluster = rest.cluster ?? (makeCluster ? makeCluster() : memoryCluster());
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = `${origin}/api/uncage`;

  const hubs: Hub[] = [];
  const stores: HubStore[] = [];
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
        return id ? ({ id } satisfies HubUser) : null;
      },
      ...rest,
      store: ks.value,
      cluster: kc.value,
    });
    hubs.push(hub);
    stores.push(ks.value);
    handlers.push(toNodeHandler(hub));
    kills.push(() => {
      dead = true;
      ks.kill();
      kc.kill();
    });
  }

  const killed = new Set<number>();
  const active = new Map<Socket, Set<number>>();
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
    fetch(`${api}${path}`, { ...init, headers: { [USER_HEADER]: user, ...(init.headers as Record<string, string>) } });

  return {
    hubs,
    stores,
    store,
    cluster,
    origin,
    api,
    requests,
    fetch(path, init = {}) {
      const h = new Headers(init.headers);
      if (h.has('upgrade')) return rawRequest(`${api}${path}`, init.method ?? 'GET', h);
      return fetch(`${api}${path}`, init);
    },
    as,
    async pair(user) {
      const code = (await (await fetch(`${api}/device/code`, { method: 'POST', body: '{}' })).json()) as DeviceCodeResponse;
      if ((await hubs[0]!.approveDevice(code.userCode, { id: user })) !== 'ok') throw new Error('approve failed');
      const tok = (await (await fetch(`${api}/device/token`, { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })).json()) as DeviceTokenResponse;
      if (tok.status !== 'ok') throw new Error(`pair failed: ${tok.status}`);
      return { machineId: tok.machineId, token: tok.machineToken };
    },
    route(p) {
      pick = p;
    },
    cutAll() {
      for (const s of sockets) s.destroy();
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

/** A request `fetch` refuses to send (e.g. with `Upgrade`), over `node:http`. */
function rawRequest(url: string, method: string, headers: Headers): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: Object.fromEntries(headers) });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: h }));
      });
    });
    req.on('upgrade', () => reject(new Error('unexpected upgrade')));
    req.on('error', reject);
    req.end();
  });
}

/** Reads NDJSON stream lines until the body ends (or `stop` returns true for a line). */
export async function readStreamLines(res: Response, stop?: (l: StreamLine) => boolean): Promise<StreamLine[]> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const out: StreamLine[] = [];
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue;
        const l = parseStreamLine(line);
        out.push(l);
        if (stop?.(l)) return out;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

let upSeq = 0;
/** A fresh upstream message id. */
export const upId = (): string => `up_${Date.now().toString(36)}${(upSeq++).toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2, 10)}`;

export interface FakeHttpAgent {
  machineId: string;
  linkId: string;
  /** Highest outbox seq dispatched. */
  readonly cursor: number;
  /** Every stream line received, in order (redeliveries included). */
  lines: StreamLine[];
  /** Commands dispatched (each seq once). */
  commands: CommandFrame[];
  /** Hub frames dispatched from the stream plus replies from POSTs. */
  frames: HubFrame[];
  /** Streams opened / ended with `rotate`. */
  readonly streams: number;
  readonly rotations: number;
  /** The last run started through a `startRun` command (used by `callTool` by default). */
  readonly lastRun: { sessionId: string; runId: string } | undefined;
  waitFor(pred: (f: HubFrame) => boolean, timeoutMs?: number): Promise<HubFrame>;
  /** Sends a `tool_call` in its own POST (retried with the same id) and resolves its `tool_result`. */
  callTool(tool: string, args: unknown, ctx?: { sessionId: string; runId: string }): Promise<Extract<HubFrame, { t: 'tool_result' }>>;
  /** Sends an `events` frame through the serialized upstream queue. */
  events(sessionId: string, events: UncageEvent[]): Promise<void>;
  /** Queues an upstream frame (resolves once the hub listed it as processed). */
  send(f: AgentFrame): Promise<void>;
  /** One raw `POST /agent/events`. */
  post(body: Partial<HttpEventsRequest>): Promise<Response>;
  /** Whether the agent reports work in flight (`busy`) on its POSTs. */
  busy: boolean;
  /** Resolves why the stream loop stopped. */
  ended: Promise<'replaced' | 'revoked' | 'closed'>;
  /** Stops streaming without telling the hub (a killed process). */
  stop(): void;
  /** Stops and sends `POST /agent/disconnect`. */
  close(): Promise<void>;
}

/**
 * A fake agent on the HTTP streaming transport, like the real one: connect, a stream reconnected
 * with its cursor (immediately after `rotate` or a cut), commands answered through `onCommand`,
 * upstream frames POSTed with idempotent ids and retried until processed.
 */
export async function connectFakeHttpAgent(o: {
  hubs: Pick<FaasHubs, 'api'>;
  token: string;
  onCommand?: CommandHandler;
  onFrame?: (f: HubFrame, send: (f: AgentFrame) => void) => void;
  agentVersion?: string;
  runtimes?: RuntimeInfo[];
}): Promise<FakeHttpAgent> {
  const { api } = o.hubs;
  const auth = { authorization: `Bearer ${o.token}` };
  const res = await fetch(`${api}/agent/connect`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      t: 'hello',
      protocol: CONNECTED_PROTOCOL,
      agentVersion: o.agentVersion ?? '99.0.0',
      transport: 'http',
      machine: { name: 'Test Mac', os: 'darwin', runtimes: o.runtimes ?? [FAKE_RUNTIME] },
    }),
  });
  const welcome = (await res.json()) as HttpConnectResponse;
  if (welcome.t !== 'welcome') throw new Error(`connect failed: ${res.status} ${JSON.stringify(welcome)}`);
  const ac = new AbortController();
  let cursor = welcome.cursor;
  let streams = 0;
  let rotations = 0;
  let lastRun: { sessionId: string; runId: string } | undefined;
  const lines: StreamLine[] = [];
  const commands: CommandFrame[] = [];
  const frames: HubFrame[] = [];
  const waiters: Array<{ pred: (f: HubFrame) => boolean; resolve: (f: HubFrame) => void }> = [];
  let endResolve!: (r: 'replaced' | 'revoked' | 'closed') => void;
  const ended = new Promise<'replaced' | 'revoked' | 'closed'>((r) => (endResolve = r));

  const push = (f: HubFrame) => {
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  };

  const post = (body: Partial<HttpEventsRequest>) =>
    fetch(`${api}/agent/events`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: welcome.linkId, ack: cursor, busy: agent.busy, msgs: [], ...body }),
    });

  /** POSTs `msgs` until every id is processed; resolves the replies. */
  const deliver = async (msgs: UpstreamMessage[]): Promise<HubFrame[]> => {
    let left = msgs;
    const replies: HubFrame[] = [];
    while (left.length > 0) {
      if (ac.signal.aborted) throw new Error('agent stopped');
      try {
        const r = await post({ msgs: left });
        if (r.status !== 200) throw new Error(`events ${r.status}: ${await r.text()}`);
        const body = (await r.json()) as HttpEventsResponse;
        for (const f of body.replies) {
          replies.push(f);
          push(f);
        }
        const done = new Set(body.processed);
        left = left.filter((m) => !done.has(m.id));
        if (left.length > 0) await sleep(50);
      } catch (err) {
        if ((err as Error).message.startsWith('events 4')) throw err;
        await sleep(50); // cut: resend the same ids
      }
    }
    return replies;
  };

  let queue: Promise<unknown> = Promise.resolve();
  const send = (f: AgentFrame): Promise<void> => {
    const p = queue.then(() => deliver([{ id: upId(), msg: f as UpstreamMessage['msg'] }]));
    queue = p.catch(() => undefined);
    return p.then(() => undefined);
  };

  const dispatch = async (f: HubFrame) => {
    push(f);
    o.onFrame?.(f, (x) => void send(x).catch(() => undefined));
    if (f.t !== 'command') return;
    commands.push(f);
    try {
      const data = await (o.onCommand ?? defaultCommand)(f);
      if (data === NO_REPLY) return;
      if (f.op === 'startRun') {
        const run = data as { id: string; sessionId: string };
        lastRun = { sessionId: run.sessionId, runId: run.id };
      }
      void send({ t: 'result', id: f.id, ok: true, data }).catch(() => undefined);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      void send({ t: 'result', id: f.id, ok: false, error: { code: (err.code ?? 'internal_error') as never, message: err.message ?? 'failed', retryable: false } }).catch(
        () => undefined,
      );
    }
  };

  const loop = async () => {
    while (!ac.signal.aborted) {
      let delivered = false;
      let ctl: string | undefined;
      try {
        const r = await fetch(`${api}/agent/stream?link=${welcome.linkId}&cursor=${cursor}`, { headers: auth, signal: ac.signal });
        if (r.status === 401) return endResolve('revoked');
        if (r.status !== 200) throw new Error(`stream ${r.status}`);
        streams++;
        await readStreamLines(r, (l) => {
          lines.push(l);
          if ('ctl' in l) {
            if (l.ctl !== 'ping') ctl = l.ctl;
            return l.ctl !== 'ping';
          }
          delivered = true;
          if (l.seq <= cursor) return false;
          cursor = l.seq;
          void dispatch(l.msg);
          return false;
        });
      } catch {
        // cut or aborted
      }
      if (ctl === 'replaced' || ctl === 'revoked') return endResolve(ctl);
      if (ctl === 'closed') return endResolve('closed');
      if (ctl === 'rotate') rotations++;
      else if (!delivered && !ac.signal.aborted) await sleep(50);
    }
    endResolve('closed');
  };
  void loop();

  const agent: FakeHttpAgent = {
    machineId: welcome.machineId,
    linkId: welcome.linkId,
    get cursor() {
      return cursor;
    },
    lines,
    commands,
    frames,
    get streams() {
      return streams;
    },
    get rotations() {
      return rotations;
    },
    get lastRun() {
      return lastRun;
    },
    busy: false,
    waitFor(pred, timeoutMs = 5000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(t);
            resolve(f);
          },
        });
      });
    },
    async callTool(tool, args, ctx) {
      const c = ctx ?? lastRun;
      if (!c) throw new Error('callTool: no run started yet');
      const id = `tc_${Math.random().toString(16).slice(2, 14)}`;
      const replies = await deliver([{ id: upId(), msg: { t: 'tool_call', id, sessionId: c.sessionId, runId: c.runId, tool, args } as UpstreamMessage['msg'] }]);
      const r = replies.find((f): f is Extract<HubFrame, { t: 'tool_result' }> => f.t === 'tool_result' && f.id === id);
      if (!r) throw new Error('callTool: no tool_result in the reply');
      return r;
    },
    events: (sessionId, events) => send({ t: 'events', sessionId, events }),
    send,
    post,
    ended,
    stop() {
      ac.abort();
    },
    async close() {
      ac.abort();
      await fetch(`${api}/agent/disconnect`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ linkId: welcome.linkId }),
      }).catch(() => undefined);
      await ended;
    },
  };
  // Seed with the connect replies (e.g. replication acks).
  for (const f of welcome.replies) push(f);
  return agent;
}
