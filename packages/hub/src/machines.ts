import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { UncageError } from '@uncage/core';
import {
  CONNECTED_PROTOCOL,
  ErrorBodySchema,
  HubCommandResultSchemas,
  MAX_FRAME_BYTES,
  parseAgentFrame,
  type AgentFrame,
  type ErrorBody,
  type HubCommandArgs,
  type HubCommandOp,
  type HubCommandResults,
  type HubFrame,
  type UncageEvent,
} from '@uncage/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ClusterAdapter } from './cluster/cluster.js';
import { sha256 } from './device.js';
import type { HubStore, MachineRecord } from './store/store.js';

export interface HubLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Close codes the hub uses on machine sockets. */
export const CLOSE = {
  /** Protocol violation (malformed frame, no hello first). */
  policy: 1008,
  shutdown: 1001,
  helloTimeout: 4408,
  /** Another connection for the same machine took over. */
  replaced: 4409,
  /** The machine was revoked. */
  revoked: 4401,
  /** Agent too old (`upgrade_required` was sent first). */
  upgrade: 4426,
  /** Agent speaks a newer protocol than this hub. */
  hubTooOld: 4505,
  /** Missed heartbeats. */
  offline: 4000,
} as const;

const HELLO_TIMEOUT_MS = 10_000;
/** After sending a close frame to a retired socket, how long before the TCP connection is cut. */
export const CLOSE_GRACE_MS = 500;

/** Compares `x.y.z[-pre]` versions; unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

const toError = (body: ErrorBody): UncageError =>
  new UncageError(body.code, {
    message: body.message,
    ...(body.hint !== undefined ? { hint: body.hint } : {}),
    ...(body.details !== undefined ? { details: body.details } : {}),
  });

const errorBody = (e: unknown): ErrorBody =>
  (e instanceof UncageError ? e : new UncageError('internal_error')).toBody();

/** Messages on a node's cluster channel. */
type NodeMsg =
  | { k: 'cmd'; id: string; from: string; machineId: string; op: HubCommandOp; args: unknown }
  | { k: 'res'; id: string; ok: true; data: unknown }
  | { k: 'res'; id: string; ok: false; error: ErrorBody }
  | { k: 'kick'; machineId: string; reason: 'revoked' | 'replaced'; except?: string };

export const nodeChannel = (nodeId: string): string => `uncage:node:${nodeId}`;
export const sessionChannel = (sessionId: string): string => `uncage:session:${sessionId}`;

interface Conn {
  /** Unique per socket (a machine may reconnect while the old socket is still closing). */
  connId: string;
  ws: WebSocket;
  machine: MachineRecord;
  /** Commands forwarded to this machine, by command id → node waiting for the result. */
  inflight: Map<string, string>;
  awaitingPong: boolean;
  missed: number;
  timer?: NodeJS.Timeout;
  queue: Promise<void>;
  /** Revoked, replaced, offline or closed: its frames are ignored from now on. */
  dead: boolean;
  /** `welcome` sent; frames before that are ignored. */
  ready: boolean;
}

interface Pending {
  op: HubCommandOp;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: NodeJS.Timeout;
}

export interface MachineHubDeps {
  store: HubStore;
  cluster: ClusterAdapter;
  nodeId: string;
  minAgentVersion: string;
  pingIntervalMs: number;
  missedPings: number;
  commandTimeoutMs: number;
  logger: HubLogger;
  /** After `welcome`: e.g. send replication `ack`s. */
  onConnected(machine: MachineRecord, send: (f: HubFrame) => void): Promise<void>;
  /** An `events` frame from `machine` (each event already checked to carry `sessionId`). */
  onEvents(machine: MachineRecord, sessionId: string, events: UncageEvent[], send: (f: HubFrame) => void): Promise<void>;
  /** A `tool_call` frame; resolves the `tool_result` frame to send back. */
  onToolCall(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<HubFrame>;
}

/**
 * Machine WebSockets on this node plus cluster routing of commands to whichever node holds a
 * machine's socket.
 */
export class MachineHub {
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();
  private readonly servers: Array<{ server: Server; listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }> = [];
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private unsubscribe?: () => void;
  private closed = false;

  constructor(private readonly d: MachineHubDeps) {}

  async start(): Promise<void> {
    this.unsubscribe = await this.d.cluster.subscribe(nodeChannel(this.d.nodeId), (raw) => {
      let msg: NodeMsg;
      try {
        msg = JSON.parse(raw) as NodeMsg;
      } catch {
        return;
      }
      this.onNodeMessage(msg).catch((err) => this.d.logger.error({ err }, 'cluster message failed'));
    });
  }

  private get presenceTtlSec(): number {
    return Math.ceil((this.d.pingIntervalMs * (this.d.missedPings + 1)) / 1000) + 5;
  }

  attach(server: Server, path: string): void {
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://hub').pathname;
      } catch {
        return;
      }
      if (pathname !== path) return; // someone else's upgrade (e.g. a dev server's HMR)
      this.authenticate(req)
        .then((machine) => {
          if (!machine || this.closed) {
            socket.end(
              `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
                JSON.stringify({ error: new UncageError('unauthorized', { message: 'Missing or invalid machine token.', hint: 'Run `uncage setup <site>` again to pair this machine.' }).toBody() }),
            );
            return;
          }
          this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, machine));
        })
        .catch((err) => {
          this.d.logger.error({ err }, 'machine upgrade failed');
          socket.destroy();
        });
    };
    server.on('upgrade', listener);
    this.servers.push({ server, listener });
  }

  private async authenticate(req: IncomingMessage): Promise<MachineRecord | null> {
    const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(req.headers.authorization ?? '');
    if (!m?.[1]) return null;
    return this.d.store.findMachineByTokenHash(sha256(m[1]));
  }

  private onSocket(ws: WebSocket, machine: MachineRecord): void {
    const helloTimer = setTimeout(() => closeSoon(ws, CLOSE.helloTimeout, 'hello timeout'), HELLO_TIMEOUT_MS);
    let conn: Conn | undefined;
    ws.on('error', () => undefined);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (conn?.dead || ws.readyState !== WebSocket.OPEN) return;
      let frame: AgentFrame;
      try {
        if (isBinary) throw new Error('binary frame');
        frame = parseAgentFrame(rawToString(data));
      } catch (err) {
        this.d.logger.warn({ machineId: machine.id, err: (err as Error).message }, 'malformed agent frame');
        if (conn) void this.retire(conn, { close: [CLOSE.policy, 'malformed frame'] });
        else closeSoon(ws, CLOSE.policy, 'malformed frame');
        return;
      }
      if (!conn) {
        if (frame.t !== 'hello') {
          closeSoon(ws, CLOSE.policy, 'expected hello');
          return;
        }
        clearTimeout(helloTimer);
        conn = this.newConn(ws, machine);
        const c = conn;
        c.queue = c.queue
          .then(() => this.onHello(c, frame as Extract<AgentFrame, { t: 'hello' }>))
          .catch((err) => {
            this.d.logger.error({ err, machineId: machine.id }, 'machine hello failed');
            void this.retire(c, { close: [1011, 'hub error'] });
          });
        return;
      }
      this.onFrame(conn, frame);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn) void this.retire(conn);
    });
  }

  private newConn(ws: WebSocket, machine: MachineRecord): Conn {
    return {
      connId: randomBytes(8).toString('hex'),
      ws,
      machine,
      inflight: new Map(),
      awaitingPong: false,
      missed: 0,
      queue: Promise.resolve(),
      dead: false,
      ready: false,
    };
  }

  private send(c: Conn, f: HubFrame): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(f));
  }

  private async onHello(c: Conn, hello: Extract<AgentFrame, { t: 'hello' }>): Promise<void> {
    if (hello.protocol > CONNECTED_PROTOCOL) {
      await this.retire(c, { close: [CLOSE.hubTooOld, 'protocol not supported by this hub'] });
      return;
    }
    if (hello.protocol < CONNECTED_PROTOCOL || compareVersions(hello.agentVersion, this.d.minAgentVersion) < 0) {
      this.send(c, { t: 'upgrade_required', minAgentVersion: this.d.minAgentVersion });
      await this.retire(c, { close: [CLOSE.upgrade, 'upgrade required'] });
      return;
    }
    // Revoked between upgrade and hello?
    const current = await this.d.store.getMachine(c.machine.id);
    if (!current || current.tokenHash !== c.machine.tokenHash) {
      await this.retire(c, { close: [CLOSE.revoked, 'revoked'] });
      return;
    }
    const lastSeenAt = new Date().toISOString();
    const patch = {
      name: hello.machine.name.slice(0, 100) || current.name,
      os: hello.machine.os.slice(0, 100) || current.os,
      agentVersion: hello.agentVersion.slice(0, 64),
      runtimes: hello.machine.runtimes,
      lastSeenAt,
    };
    await this.d.store.updateMachine(c.machine.id, patch);
    c.machine = { ...current, ...patch };

    if (c.dead || c.ws.readyState !== WebSocket.OPEN) return; // went away during the awaits
    const previous = this.conns.get(c.machine.id);
    this.conns.set(c.machine.id, c);
    if (previous && previous !== c) {
      void this.retire(previous, { close: [CLOSE.replaced, 'replaced by a newer connection'], keepPresence: true });
    }
    const elsewhere = await this.d.cluster.getPresence(c.machine.id);
    if (elsewhere && elsewhere !== this.d.nodeId) {
      await this.publish(elsewhere, { k: 'kick', machineId: c.machine.id, reason: 'replaced' });
    }
    await this.d.cluster.setPresence(c.machine.id, this.d.nodeId, this.presenceTtlSec);
    if (c.dead || c.ws.readyState !== WebSocket.OPEN) {
      // Closed while we were registering: its retire() may have cleared presence before the
      // setPresence above re-added it. Clear it again unless a newer live connection holds it.
      c.dead = true;
      if (this.conns.get(c.machine.id) === c) this.conns.delete(c.machine.id);
      if (!this.conns.has(c.machine.id)) await this.d.cluster.clearPresence(c.machine.id, this.d.nodeId);
      return;
    }

    c.ready = true;
    this.send(c, { t: 'welcome', machineId: c.machine.id, protocol: CONNECTED_PROTOCOL, minAgentVersion: this.d.minAgentVersion });
    c.timer = setInterval(() => this.heartbeat(c), this.d.pingIntervalMs);
    c.timer.unref();
    await this.d.onConnected(c.machine, (f) => this.send(c, f));
  }

  /** Each tick: an unanswered previous ping counts as missed; `missedPings` in a row → offline. */
  private heartbeat(c: Conn): void {
    if (c.awaitingPong) c.missed++;
    if (c.missed >= this.d.missedPings) {
      this.d.logger.warn({ machineId: c.machine.id }, 'machine missed heartbeats; marking offline');
      void this.retire(c, { terminate: true });
      return;
    }
    c.awaitingPong = true;
    this.send(c, { t: 'ping', at: Date.now() });
  }

  private onFrame(c: Conn, frame: AgentFrame): void {
    if (c.dead || !c.ready) return;
    // Any frame proves the machine is alive.
    c.awaitingPong = false;
    c.missed = 0;
    switch (frame.t) {
      case 'pong': {
        const lastSeenAt = new Date().toISOString();
        c.machine.lastSeenAt = lastSeenAt;
        void Promise.all([
          this.d.cluster.setPresence(c.machine.id, this.d.nodeId, this.presenceTtlSec),
          this.d.store.updateMachine(c.machine.id, { lastSeenAt }),
        ]).catch((err) => this.d.logger.error({ err }, 'heartbeat bookkeeping failed'));
        return;
      }
      case 'hello':
        return; // duplicate hello: ignore
      case 'result': {
        const to = c.inflight.get(frame.id);
        if (!to) return;
        c.inflight.delete(frame.id);
        const msg: NodeMsg = frame.ok
          ? { k: 'res', id: frame.id, ok: true, data: frame.data }
          : { k: 'res', id: frame.id, ok: false, error: frame.error };
        void this.publish(to, msg);
        return;
      }
      case 'events': {
        if (frame.events.some((e) => e.sessionId !== frame.sessionId)) {
          this.d.logger.warn({ machineId: c.machine.id }, 'events frame with mismatched sessionId dropped');
          return;
        }
        // Serialized per connection so replication applies events in order.
        c.queue = c.queue
          .then(() => this.d.onEvents(c.machine, frame.sessionId, frame.events, (f) => this.send(c, f)))
          .catch((err) => this.d.logger.error({ err, machineId: c.machine.id }, 'events handling failed'));
        return;
      }
      case 'tool_call':
        // Not serialized: a slow tool must not hold up events.
        void this.d
          .onToolCall(c.machine, frame)
          .then((f) => this.send(c, f))
          .catch((err) => this.send(c, { t: 'tool_result', id: frame.id, ok: false, error: errorBody(err) }));
        return;
      case 'file_chunk':
      case 'file_done':
        return; // file channel: no pulls are issued by this build
    }
  }

  /**
   * Takes a connection out of service at once: later frames are ignored, its in-flight commands
   * fail with `machine_offline`, and (unless replaced) presence is cleared. With `close`, a close
   * frame is sent and the socket is cut after `CLOSE_GRACE_MS` whether or not the client answers;
   * `terminate` cuts it immediately.
   */
  private async retire(c: Conn, o: { close?: [number, string]; terminate?: boolean; keepPresence?: boolean } = {}): Promise<void> {
    if (o.terminate) c.ws.terminate();
    else if (o.close && c.ws.readyState === WebSocket.OPEN) {
      c.ws.close(o.close[0], o.close[1]);
      setTimeout(() => c.ws.terminate(), CLOSE_GRACE_MS).unref();
    }
    if (c.dead) return;
    c.dead = true;
    if (c.timer) clearInterval(c.timer);
    c.timer = undefined;
    const offline = new UncageError('machine_offline').toBody();
    for (const [id, to] of c.inflight) void this.publish(to, { k: 'res', id, ok: false, error: offline });
    c.inflight.clear();
    if (this.conns.get(c.machine.id) !== c) return;
    this.conns.delete(c.machine.id);
    await Promise.all([
      o.keepPresence ? undefined : this.d.cluster.clearPresence(c.machine.id, this.d.nodeId),
      this.d.store.updateMachine(c.machine.id, { lastSeenAt: new Date().toISOString() }),
    ]).catch((err) => this.d.logger.error({ err }, 'machine close bookkeeping failed'));
  }

  private async publish(nodeId: string, msg: NodeMsg): Promise<void> {
    try {
      await this.d.cluster.publish(nodeChannel(nodeId), JSON.stringify(msg));
    } catch (err) {
      this.d.logger.error({ err }, 'cluster publish failed');
    }
  }

  private async onNodeMessage(msg: NodeMsg): Promise<void> {
    if (msg.k === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!msg.ok) {
        const body = ErrorBodySchema.safeParse(msg.error);
        p.reject(body.success ? toError(body.data) : new UncageError('internal_error'));
        return;
      }
      const parsed = HubCommandResultSchemas[p.op].safeParse(msg.data);
      if (parsed.success) p.resolve(parsed.data);
      else {
        this.d.logger.warn({ op: p.op, issue: parsed.error.issues[0]?.message }, 'machine sent an invalid result');
        p.reject(new UncageError('internal_error', { message: 'The machine sent an invalid response.' }));
      }
      return;
    }
    if (msg.k === 'kick') {
      const c = this.conns.get(msg.machineId);
      if (c && c.connId !== msg.except) {
        await this.retire(c, { close: msg.reason === 'revoked' ? [CLOSE.revoked, 'revoked'] : [CLOSE.replaced, 'replaced'] });
      }
      return;
    }
    // k === 'cmd': forward to the machine if its socket is here.
    const c = this.conns.get(msg.machineId);
    const frame = JSON.stringify({ t: 'command', id: msg.id, op: msg.op, args: msg.args } satisfies HubFrame);
    if (!c || c.ws.readyState !== WebSocket.OPEN) {
      await this.publish(msg.from, { k: 'res', id: msg.id, ok: false, error: new UncageError('machine_offline').toBody() });
      return;
    }
    c.inflight.set(msg.id, msg.from);
    c.ws.send(frame);
  }

  /** Whether the machine currently has a connection on any node. */
  async isOnline(machineId: string): Promise<boolean> {
    return (await this.d.cluster.getPresence(machineId)) !== null;
  }

  /** Sends a command to the machine (wherever it is connected) and resolves its validated result. */
  async command<K extends HubCommandOp>(machineId: string, op: K, args: HubCommandArgs[K]): Promise<HubCommandResults[K]> {
    if (this.closed) throw new UncageError('machine_offline');
    const node = await this.d.cluster.getPresence(machineId);
    if (!node) throw new UncageError('machine_offline');
    const id = `cmd_${randomBytes(12).toString('hex')}`;
    const frameBytes = byteLength(JSON.stringify({ t: 'command', id, op, args }));
    if (frameBytes > MAX_FRAME_BYTES) {
      throw new UncageError('invalid_request', {
        message: `The ${op} command is too large to send to the machine (${frameBytes} bytes, max ${MAX_FRAME_BYTES}).`,
      });
    }
    return new Promise<HubCommandResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UncageError('machine_offline', { message: 'The machine did not respond in time.' }));
      }, this.d.commandTimeoutMs);
      timer.unref();
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
      void this.d.cluster
        .publish(nodeChannel(node), JSON.stringify({ k: 'cmd', id, from: this.d.nodeId, machineId, op, args } satisfies NodeMsg))
        .catch((err) => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** Disconnects a machine (revoked, or its token rotated) wherever it is connected. */
  async kick(machineId: string, reason: 'revoked' | 'replaced' = 'revoked'): Promise<void> {
    const node = await this.d.cluster.getPresence(machineId);
    const local = this.conns.get(machineId);
    if (local) await this.retire(local, { close: reason === 'revoked' ? [CLOSE.revoked, 'revoked'] : [CLOSE.replaced, 'replaced'] });
    if (node && node !== this.d.nodeId) await this.publish(node, { k: 'kick', machineId, reason });
    if (node) await this.d.cluster.clearPresence(machineId, node);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    for (const { server, listener } of this.servers) server.off('upgrade', listener);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new UncageError('machine_offline'));
    }
    this.pending.clear();
    const conns = [...this.conns.values()];
    await Promise.all(conns.map((c) => this.retire(c, { close: [CLOSE.shutdown, 'hub shutting down'] })));
    this.wss.close();
  }
}

/** Close a socket that has no registered connection yet, cutting it if the client does not answer. */
function closeSoon(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
