/**
 * Test helpers: a hub on a real HTTP server, and an in-process fake agent (a `ws` client speaking
 * the connected-mode frames).
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CONNECTED_PROTOCOL,
  FILE_CHUNK_BYTES,
  formatEventId,
  parseHubFrame,
  type AgentFrame,
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
import { createHub, type HubInternals } from './hub.js';
import { toNodeHandler } from './node.js';
import { pgliteHubStore } from './store/pglite.js';
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
  hub.attach(server);
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
