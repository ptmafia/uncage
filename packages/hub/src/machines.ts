import { UncageError } from '@uncage/core/errors';
import {
  AgentFrameSchema,
  CONNECTED_PROTOCOL,
  ErrorBodySchema,
  FILE_CHUNK_BYTES,
  HubCommandOpSchema,
  HubCommandResultSchemas,
  HubFrameSchema,
  MAX_FRAME_BYTES,
  type AgentFrame,
  type Attachment,
  type ErrorBody,
  type HubCommandArgs,
  type HubCommandOp,
  type HubCommandResults,
  type HubFrame,
  type TransportKind,
  type UncageEvent,
} from '@uncage/protocol';
import { z } from 'zod';
import type { ClusterAdapter } from './cluster/cluster.js';
import { PullAssembler, type PullOutcome } from './files.js';
import { routedId, routeOf } from './ids.js';
import type { HubStore, MachineRecord, ToolResultFrame } from './store/store.js';
import { randomHex, sha256Hex, toBase64, unrefTimer, utf8Length } from './web.js';

/** Where the hub logs (`HubOptions.logger`): `obj` carries the context (`err`, ids), `msg` the text. */
export interface HubLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Codes a link is retired with by the hub itself. The WebSocket link uses them verbatim as close
 * codes (see `CLOSE` in `node/ws.ts`, which adds the socket-only ones).
 */
export const LINK_CLOSE = {
  shutdown: 1001,
  /** The hub failed while handling the link. */
  error: 1011,
  /** The machine was revoked. */
  revoked: 4401,
  /** Another connection for the same machine took over. */
  replaced: 4409,
} as const;

/** A pull with no frame from the machine for this long fails. */
const PULL_IDLE_MS = 30_000;

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


const toError = (body: ErrorBody): UncageError =>
  new UncageError(body.code, {
    message: body.message,
    ...(body.hint !== undefined ? { hint: body.hint } : {}),
    ...(body.details !== undefined ? { details: body.details } : {}),
  });

const errorBody = (e: unknown): ErrorBody =>
  (e instanceof UncageError ? e : new UncageError('internal_error')).toBody();

/** The cluster reply carrying a machine's `result` frame. */
const resMsg = (machineId: string, frame: Extract<AgentFrame, { t: 'result' }>): NodeMsg =>
  frame.ok ? { k: 'res', id: frame.id, ok: true, data: frame.data, machineId } : { k: 'res', id: frame.id, ok: false, error: frame.error, machineId };

/**
 * Messages on a node's cluster channel. Replies (`res`) go to the node encoded in the command or
 * upload id (`routeOf`).
 */
type NodeMsg =
  | { k: 'cmd'; id: string; machineId: string; op: HubCommandOp; args: unknown }
  /** `machineId`: the machine that answered (checked against the command's target). */
  | { k: 'res'; id: string; ok: true; data: unknown; machineId?: string }
  | { k: 'res'; id: string; ok: false; error: ErrorBody; machineId?: string }
  | { k: 'kick'; machineId: string; reason: 'revoked' | 'replaced'; except?: string }
  /** One frame of a chunked upload, forwarded as-is to the machine (`begin` registers the upload on the link). */
  | { k: 'up'; id: string; machineId: string; frame: HubFrame }
  /** A file-pull frame from the machine that reached another instance, to the instance assembling the pull. */
  | { k: 'pull'; id: string; machineId: string; frame: PullFrame }
  /** A frame for a machine whose WebSocket this node holds (`deliver`). */
  | { k: 'deliver'; machineId: string; frame: HubFrame };

/** Machine → hub frames of a file pull. */
type PullFrame = Extract<AgentFrame, { t: 'file_chunk' | 'file_done' | 'result' }>;
const PULL_FRAMES = new Set(['file_chunk', 'file_done', 'result']);

/** Shape check for cluster messages: anything else on a node channel is dropped. */
const NodeMsgSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('cmd'), id: z.string(), machineId: z.string(), op: HubCommandOpSchema, args: z.unknown() }),
  z.object({ k: z.literal('res'), id: z.string(), ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional(), machineId: z.string().optional() }),
  z.object({ k: z.literal('kick'), machineId: z.string(), reason: z.enum(['revoked', 'replaced']), except: z.string().optional() }),
  z.object({ k: z.literal('up'), id: z.string(), machineId: z.string(), frame: HubFrameSchema }),
  z.object({ k: z.literal('pull'), id: z.string(), machineId: z.string(), frame: AgentFrameSchema }),
  z.object({ k: z.literal('deliver'), machineId: z.string(), frame: HubFrameSchema }),
]);
const UPLOAD_FRAMES = new Set(['attachment_begin', 'attachment_chunk', 'attachment_end', 'attachment_abort']);

export const nodeChannel = (nodeId: string): string => `uncage:node:${nodeId}`;
export const sessionChannel = (sessionId: string): string => `uncage:session:${sessionId}`;
/** Presence value of a machine connected over the HTTP streaming transport (any instance serves it). */
export const HTTP_PRESENCE = 'http';
/** Wake-up channel of a machine's HTTP stream: `'wake'` is published after each outbox write. */
export const machineChannel = (machineId: string): string => `uncage:machine:${machineId}`;
/** A `file_pull` in the outbox expires after this long. */
const PULL_OUTBOX_TTL_MS = 30_000;
/** Default expiry of a frame `deliver` writes to the outbox. */
const DELIVER_OUTBOX_TTL_MS = 600_000;
/** Upload frames are written to the outbox this many at a time. */
const UPLOAD_OUTBOX_BATCH = 8;

/**
 * Thrown from `handleUpstream` when a message cannot be handled yet (a tool call running on another
 * instance): the HTTP transport gives its inbox claim back and lists it in `retry`, without logging.
 */
export class UpstreamRetry extends Error {
  constructor(message = 'retry later') {
    super(message);
    this.name = 'UpstreamRetry';
  }
}

/** One connection of a machine to the hub, whatever carries it. */
export interface MachineLink {
  readonly kind: TransportKind;
  /** Unique per connection (a machine may reconnect while the old connection is still closing). */
  readonly linkId: string;
  machine: MachineRecord;
  /** Aborts when the connection goes away (cancels its tool calls and pulls). */
  readonly signal: AbortSignal;
  /** ws: write now; http: collected into the response's `replies`. */
  send(f: HubFrame): Promise<void>;
  /** http: the acknowledged outbox seq, set by `hello` when it opens the link. */
  cursor?: number;
}

/** A link whose connection is held by this node (a WebSocket): commands for its machine are routed here. */
export type LocalLink = MachineLink & { close(code: number, reason: string): void };

/** What the hub keeps per local link. */
interface LinkState {
  link: LocalLink;
  /** Commands and uploads forwarded to this link and not answered yet (failed at once when it goes). */
  inflight: Set<string>;
  queue: Promise<void>;
  /** Retired (revoked, replaced, offline or closed): its frames are ignored from now on. */
  dead: boolean;
  /** `welcome` sent; frames before that are ignored. */
  ready: boolean;
  /** Aborted when the link is retired or its connection goes. */
  abort: AbortController;
}

type Timer = ReturnType<typeof setTimeout>;

interface PullState {
  /** The local (WebSocket) link the pull was sent on; unset for a pull sent through the outbox. */
  state?: LinkState;
  machineId: string;
  asm: PullAssembler;
  path: string;
  resolve(r: PullOutcome): void;
  reject(e: unknown): void;
  timer: Timer;
  cleanup(): void;
}

interface Pending {
  op: HubCommandOp;
  machineId: string;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: Timer;
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
  /** `waitUntil`: the platform hook of the request that carried the events (HTTP transport on FaaS). */
  onEvents(machine: MachineRecord, sessionId: string, events: UncageEvent[], send: (f: HubFrame) => void, waitUntil?: (p: Promise<unknown>) => void): Promise<void>;
  /**
   * A `tool_call` frame; resolves the `tool_result` frame to send back, or `null` to send nothing
   * now (running elsewhere, or abandoned because its run ended: over HTTP the message is retried).
   * A dropped connection never abandons the call.
   */
  onToolCall(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null>;
}

/**
 * Machine links plus cluster routing of commands to whichever node holds a machine's connection.
 * Transport-neutral: the WebSocket server (`@uncage/hub/node`) builds a `MachineLink` per socket
 * and feeds it `hello` / `handleMessage`.
 */
export class MachineHub {
  /** Local links by link id (registered before `hello`). */
  private readonly links = new Map<string, LinkState>();
  /** The welcomed local link of each machine. */
  private readonly active = new Map<string, LinkState>();
  private readonly pending = new Map<string, Pending>();
  private readonly pulls = new Map<string, PullState>();
  private readonly closeHooks: Array<() => void> = [];
  /** Node-channel subscription: refcounted while replies are awaited, permanent once WebSockets are served. */
  private subRefs = 0;
  private subscription?: Promise<() => void>;
  /** `enableWebSocket()` ran: this node must hold its node-channel subscription for good. */
  private wsEnabled = false;
  /** The permanent subscription (pending or live); unset after a failed subscribe so it is retried. */
  private wsReady?: Promise<void>;
  private closed = false;

  constructor(private readonly d: MachineHubDeps) {}

  get nodeId(): string {
    return this.d.nodeId;
  }

  get heartbeat(): { pingIntervalMs: number; missedPings: number } {
    return { pingIntervalMs: this.d.pingIntervalMs, missedPings: this.d.missedPings };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private get presenceTtlSec(): number {
    return Math.ceil((this.d.pingIntervalMs * (this.d.missedPings + 1)) / 1000) + 5;
  }

  /**
   * HTTP presence lasts (missedPings + 1) ping intervals: the stream refreshes it on every ping, so
   * a machine whose stream stopped (and did not reconnect) shows offline within that time.
   */
  get httpPresenceTtlSec(): number {
    return (this.d.pingIntervalMs * (this.d.missedPings + 1)) / 1000;
  }

  /** The presence value of a machine: a node id (WebSocket), `HTTP_PRESENCE`, or `null` (offline). */
  presenceOf(machineId: string): Promise<string | null> {
    return this.d.cluster.getPresence(machineId);
  }

  /**
   * Refreshes the HTTP presence (and `lastSeenAt`) of a machine streaming on `linkId`. A stale
   * stream must never bring presence back or take it from a newer connection, so:
   * 1. the link must still be current (else nothing is written);
   * 2. presence is written only if it is free or already `HTTP_PRESENCE` (`refreshPresence`,
   *    atomic in the bundled adapters; a check-then-set for adapters without it), so a WebSocket
   *    node id that took over is never overwritten;
   * 3. if the link was closed (disconnect, revoke, token rotation) between 1 and 2, the write is
   *    undone. (Replaced by a newer HTTP link: the `http` presence is right for that link, kept.)
   * Resolves whether presence is held for this link.
   */
  async touchHttp(machine: MachineRecord, linkId: string): Promise<boolean> {
    const at = new Date().toISOString();
    if ((await this.d.store.updateLink(machine.id, linkId, { at })) !== 'current') return false;
    const { cluster } = this.d;
    const set = cluster.refreshPresence
      ? await cluster.refreshPresence(machine.id, HTTP_PRESENCE, this.httpPresenceTtlSec)
      : await (async () => {
          const cur = await cluster.getPresence(machine.id);
          if (cur !== null && cur !== HTTP_PRESENCE) return false;
          await cluster.setPresence(machine.id, HTTP_PRESENCE, this.httpPresenceTtlSec);
          return true;
        })();
    if (!set) return false; // a WebSocket took over; the next poll sees the link replaced
    const after = await this.d.store.updateLink(machine.id, linkId, { at });
    if (after === 'gone') {
      await cluster.clearPresence(machine.id, HTTP_PRESENCE);
      return false;
    }
    machine.lastSeenAt = at;
    await this.d.store.updateMachine(machine.id, { lastSeenAt: at });
    return after === 'current';
  }

  /** Clears the HTTP presence of a machine (it disconnected). */
  async clearHttp(machineId: string): Promise<void> {
    await this.d.cluster.clearPresence(machineId, HTTP_PRESENCE);
  }

  /** Wakes the machine's HTTP stream (wherever it is served) so it polls the outbox at once. */
  async wake(machineId: string): Promise<void> {
    try {
      await this.d.cluster.publish(machineChannel(machineId), 'wake');
    } catch (err) {
      this.d.logger.error({ err }, 'cluster publish failed');
    }
  }

  /**
   * Makes `linkId` the machine's current HTTP link: older links (HTTP on any instance, or a
   * WebSocket here or on another node) are replaced, presence becomes `HTTP_PRESENCE`. Resolves
   * the acknowledged outbox seq (the stream's starting cursor).
   */
  private async openHttpLink(machineId: string, linkId: string): Promise<number> {
    const { ackedSeq } = await this.d.store.openLink(machineId, { linkId, transport: 'http', at: new Date().toISOString() });
    const local = this.active.get(machineId);
    if (local) void this.retire(local, { close: [LINK_CLOSE.replaced, 'replaced by a newer connection'], keepPresence: true });
    const elsewhere = await this.d.cluster.getPresence(machineId);
    if (elsewhere && elsewhere !== HTTP_PRESENCE && elsewhere !== this.d.nodeId) {
      await this.publishQuiet(elsewhere, { k: 'kick', machineId, reason: 'replaced' });
    }
    await this.d.cluster.setPresence(machineId, HTTP_PRESENCE, this.httpPresenceTtlSec);
    // An older HTTP stream sees `replaced` on its next poll: make that now.
    await this.wake(machineId);
    return ackedSeq;
  }

  /**
   * This node holds machine connections (WebSockets): it listens on its node channel for good, so
   * commands for its machines reach it. Idempotent.
   */
  enableWebSocket(): void {
    if (this.closed) return;
    this.wsEnabled = true;
    if (this.wsReady) return;
    const p: Promise<void> = this.acquire().catch((err: unknown) => {
      if (this.wsReady === p) this.wsReady = undefined;
      this.d.logger.error({ err }, 'cluster subscribe failed');
      throw err;
    });
    this.wsReady = p;
    p.catch(() => undefined);
  }

  /** Runs `fn` when the hub closes (e.g. detaching a WebSocket server). */
  onClose(fn: () => void): void {
    this.closeHooks.push(fn);
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new UncageError('machine_offline'));
    this.subRefs++;
    if (!this.subscription) {
      const p = this.d.cluster.subscribe(nodeChannel(this.d.nodeId), (raw) => this.onRaw(raw));
      p.catch(() => {
        if (this.subscription === p) this.subscription = undefined;
      });
      this.subscription = p;
    }
    return this.subscription.then(
      () => undefined,
      (err: unknown) => {
        this.release();
        throw err;
      },
    );
  }

  private release(): void {
    if (this.subRefs === 0) return;
    if (--this.subRefs > 0) return;
    const p = this.subscription;
    this.subscription = undefined;
    void p?.then(
      (unsubscribe) => unsubscribe(),
      () => undefined,
    );
  }

  private onRaw(raw: string): void {
    let msg: NodeMsg;
    try {
      const parsed = NodeMsgSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.d.logger.warn({ issue: parsed.error.issues[0]?.message }, 'malformed cluster message dropped');
        return;
      }
      msg = parsed.data as NodeMsg;
    } catch {
      return;
    }
    this.onNodeMessage(msg).catch((err) => this.d.logger.error({ err }, 'cluster message failed'));
  }

  /** The machine for a bearer machine token, or `null` (unknown, revoked, malformed, hub closed). */
  async authenticate(token: string): Promise<MachineRecord | null> {
    if (this.closed || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null;
    return this.d.store.findMachineByTokenHash(await sha256Hex(token));
  }

  /** Registers a connection held by this node (before its `hello`). */
  addLocalLink(link: LocalLink): void {
    const abort = new AbortController();
    if (link.signal.aborted) abort.abort();
    else link.signal.addEventListener('abort', () => abort.abort(), { once: true });
    this.links.set(link.linkId, { link, inflight: new Set(), queue: Promise.resolve(), dead: false, ready: false, abort });
  }

  /** The connection went away: retires the link (in-flight commands fail with `machine_offline`). */
  removeLocalLink(link: MachineLink): void {
    const s = this.links.get(link.linkId);
    if (!s) return;
    this.links.delete(link.linkId);
    void this.retire(s);
  }

  /**
   * Handles the link's `hello`: version checks (`upgrade_required` is sent before `'upgrade'`),
   * revocation, the machine's record, then — for a local link — takes over from any older
   * connection of the machine and sends `welcome`. The caller closes the link on anything but
   * `'ok'`.
   */
  async hello(link: MachineLink, hello: Extract<AgentFrame, { t: 'hello' }>): Promise<'ok' | 'upgrade' | 'hub_too_old' | 'revoked'> {
    if (hello.protocol > CONNECTED_PROTOCOL) return 'hub_too_old';
    if (hello.protocol < CONNECTED_PROTOCOL || compareVersions(hello.agentVersion, this.d.minAgentVersion) < 0) {
      // The website shows "agent update needed" for this machine.
      await this.markOutdated(link.machine.id);
      await link.send({ t: 'upgrade_required', minAgentVersion: this.d.minAgentVersion });
      return 'upgrade';
    }
    // Revoked between authentication and hello?
    const current = await this.d.store.getMachine(link.machine.id);
    if (!current || current.tokenHash !== link.machine.tokenHash) return 'revoked';
    const lastSeenAt = new Date().toISOString();
    const patch = {
      name: hello.machine.name.slice(0, 100) || current.name,
      os: hello.machine.os.slice(0, 100) || current.os,
      agentVersion: hello.agentVersion.slice(0, 64),
      runtimes: hello.machine.runtimes,
      lastSeenAt,
    };
    await this.d.store.updateMachine(link.machine.id, patch);
    link.machine = { ...current, ...patch };

    const s = this.links.get(link.linkId);
    if (s) {
      const gone = () => s.dead || link.signal.aborted;
      if (gone()) return 'ok'; // went away during the awaits
      // Commands for this machine are routed to our node channel: be listening before taking presence.
      if (this.wsEnabled) {
        // A failed subscribe is retried here; if it fails again the hello fails (the socket closes
        // with 1011) instead of taking presence that commands could never reach.
        if (!this.wsReady) this.enableWebSocket();
        await this.wsReady;
      }
      if (gone()) return 'ok';
      const machineId = link.machine.id;
      const previous = this.active.get(machineId);
      this.active.set(machineId, s);
      if (previous && previous !== s) {
        void this.retire(previous, { close: [LINK_CLOSE.replaced, 'replaced by a newer connection'], keepPresence: true });
      }
      const elsewhere = await this.d.cluster.getPresence(machineId);
      if (elsewhere === HTTP_PRESENCE) {
        // An HTTP link: take its place in the store, so its stream ends with `replaced`.
        await this.d.store.openLink(machineId, { linkId: link.linkId, transport: 'ws', at: new Date().toISOString() });
        await this.wake(machineId);
      } else if (elsewhere && elsewhere !== this.d.nodeId) {
        await this.publishQuiet(elsewhere, { k: 'kick', machineId, reason: 'replaced' });
      }
      await this.d.cluster.setPresence(machineId, this.d.nodeId, this.presenceTtlSec);
      if (gone()) {
        // Closed while we were registering: its retire() may have cleared presence before the
        // setPresence above re-added it. Clear it again unless a newer live link holds it.
        s.dead = true;
        if (this.active.get(machineId) === s) this.active.delete(machineId);
        if (!this.active.has(machineId)) await this.d.cluster.clearPresence(machineId, this.d.nodeId);
        return 'ok';
      }
      s.ready = true;
    } else if (link.kind === 'http') {
      link.cursor = await this.openHttpLink(link.machine.id, link.linkId);
    }
    await link.send({ t: 'welcome', machineId: link.machine.id, protocol: CONNECTED_PROTOCOL, minAgentVersion: this.d.minAgentVersion });
    // Every frame onConnected sends (site-mode acks) is in the link before hello resolves: an HTTP
    // connect returns them as its replies.
    const sent: Array<Promise<void>> = [];
    await this.d.onConnected(link.machine, (f) => void sent.push(link.send(f)));
    await Promise.all(sent);
    return 'ok';
  }

  /**
   * One frame from a welcomed link. Resolves when the frame is handled (an `events` frame once its
   * place in the link's queue ran, a `tool_call` once its result was sent).
   */
  async handleMessage(link: MachineLink, frame: AgentFrame): Promise<void> {
    const s = this.links.get(link.linkId);
    if (!s || s.dead || !s.ready) return;
    const send = (f: HubFrame) => void link.send(f);
    switch (frame.t) {
      case 'pong': {
        const lastSeenAt = new Date().toISOString();
        link.machine.lastSeenAt = lastSeenAt;
        await Promise.all([
          this.d.cluster.setPresence(link.machine.id, this.d.nodeId, this.presenceTtlSec),
          this.d.store.updateMachine(link.machine.id, { lastSeenAt }),
        ]).catch((err) => this.d.logger.error({ err }, 'heartbeat bookkeeping failed'));
        return;
      }
      case 'hello':
        return; // duplicate hello: ignore
      case 'result': {
        const pull = this.pulls.get(frame.id);
        if (pull && pull.state === s) {
          this.pullResult(frame.id, pull, frame);
          return;
        }
        // Only answers to commands this link was sent; the reply goes to the node in the id.
        if (!s.inflight.delete(frame.id)) return;
        const to = routeOf(frame.id);
        if (!to) return;
        await this.publishQuiet(to, resMsg(link.machine.id, frame));
        return;
      }
      case 'events': {
        if (frame.events.some((e) => e.sessionId !== frame.sessionId)) {
          this.d.logger.warn({ machineId: link.machine.id }, 'events frame with mismatched sessionId dropped');
          return;
        }
        // Serialized per link so replication applies events in order.
        const done = s.queue
          .then(() => this.d.onEvents(link.machine, frame.sessionId, frame.events, send))
          .catch((err) => this.d.logger.error({ err, machineId: link.machine.id }, 'events handling failed'));
        s.queue = done;
        return done;
      }
      case 'tool_call': {
        // Not serialized: a slow tool must not hold up events. The call outlives this connection:
        // if it went away meanwhile, the result goes wherever the machine is now.
        const f = await this.runToolCall(link.machine, frame);
        if (!f) return;
        if (!s.dead && !link.signal.aborted) send(f);
        else await this.deliver(link.machine.id, f).catch((err: unknown) => this.d.logger.error({ err, machineId: link.machine.id }, 'tool result delivery failed'));
        return;
      }
      case 'file_chunk':
      case 'file_done': {
        const pull = this.pulls.get(frame.id);
        if (!pull || pull.state !== s) return; // unknown, finished or abandoned pull
        this.pullFrame(frame.id, pull, frame);
        return;
      }
    }
  }

  /** A pull that failed on the machine (possibly mid-stream): drop what arrived so far. */
  private pullResult(id: string, pull: PullState, frame: Extract<AgentFrame, { t: 'result' }>): void {
    const err = frame.ok
      ? new UncageError('internal_error', { message: 'The machine answered a file pull with a result.' })
      : new UncageError(frame.error.code === 'not_found' || frame.error.code === 'invalid_request' ? frame.error.code : 'tool_failed', {
          message: `Could not pull "${pull.path}": ${frame.error.message}`,
          ...(frame.error.details !== undefined ? { details: frame.error.details } : {}),
        });
    this.endPull(id, err);
  }

  /**
   * Runs one tool call (`onToolCall`: claim, the per-machine concurrency cap, execution). An
   * unexpected failure becomes an error `tool_result` (never a retry: a tool that ran is not re-run
   * because it failed).
   */
  private async runToolCall(machine: MachineRecord, frame: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null> {
    try {
      return await this.d.onToolCall(machine, frame);
    } catch (err) {
      return { t: 'tool_result', id: frame.id, ok: false, error: errorBody(err) };
    }
  }

  /**
   * One upstream message from an HTTP link (`POST /agent/events`), handled on whichever instance
   * received it. Resolves once it is handled (an `events` frame applied, a `tool_call`'s result
   * sent into the link's replies); rejects when handling failed, so the message is retried.
   */
  async handleUpstream(link: MachineLink, frame: AgentFrame, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
    // Sends are awaited before this resolves, so the response's replies are complete.
    const sent: Array<Promise<void>> = [];
    const send = (f: HubFrame) => void sent.push(link.send(f));
    try {
      await this.upstream(link, frame, send, waitUntil);
    } finally {
      await Promise.all(sent);
    }
  }

  private async upstream(link: MachineLink, frame: AgentFrame, send: (f: HubFrame) => void, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
    const machineId = link.machine.id;
    /** A pull sent through the outbox by this instance for this machine. */
    const pullOf = (id: string) => {
      const p = this.pulls.get(id);
      return p && !p.state && p.machineId === machineId ? p : undefined;
    };
    switch (frame.t) {
      case 'hello':
      case 'pong':
        return;
      case 'result': {
        const pull = pullOf(frame.id);
        if (pull) {
          this.pullResult(frame.id, pull, frame);
          return;
        }
        // The command (or pull) may have been sent by any instance: the reply goes to the node in the id.
        const to = routeOf(frame.id);
        if (!to) return;
        if (frame.id.startsWith('pull_')) {
          if (to !== this.d.nodeId) await this.publish(to, { k: 'pull', id: frame.id, machineId, frame });
          return;
        }
        await this.publish(to, resMsg(machineId, frame));
        return;
      }
      case 'events': {
        if (frame.events.some((e) => e.sessionId !== frame.sessionId)) {
          this.d.logger.warn({ machineId }, 'events frame with mismatched sessionId dropped');
          return;
        }
        // The agent sends one batch at a time and the batch is processed in order.
        await this.d.onEvents(link.machine, frame.sessionId, frame.events, send, waitUntil);
        return;
      }
      case 'tool_call': {
        // Exactly-once through the store's tool-call state (`onToolCall`): a retried message of a
        // finished call is answered with the stored result; one still running on another instance
        // (or abandoned because its run ended) is retried by the agent until its outcome is stored;
        // one whose instance died is answered with the interrupted error, never re-run.
        const f = await this.runToolCall(link.machine, frame);
        if (!f) throw new UpstreamRetry();
        send(f);
        return;
      }
      case 'file_chunk':
      case 'file_done': {
        const pull = pullOf(frame.id);
        if (pull) {
          this.pullFrame(frame.id, pull, frame);
          return;
        }
        // Started by another instance: forward it there (in order: the agent sends one message at
        // a time and this resolves only once it is published). A failed publish rejects → retried.
        const to = routeOf(frame.id);
        if (to && to !== this.d.nodeId && frame.id.startsWith('pull_')) await this.publish(to, { k: 'pull', id: frame.id, machineId, frame });
        return;
      }
    }
  }

  private pullFrame(id: string, pull: PullState, frame: Extract<AgentFrame, { t: 'file_chunk' | 'file_done' }>): void {
    try {
      if (frame.t === 'file_chunk') {
        pull.asm.chunk(frame);
        pull.timer = this.rearm(pull.timer, () => this.pullIdle(id, pull.path), PULL_IDLE_MS);
      } else this.endPull(id, null, pull.asm.done(frame));
    } catch (err) {
      this.endPull(id, err);
    }
  }

  /** Records that the machine's agent was refused as too old (the website asks for an update). */
  async markOutdated(machineId: string): Promise<void> {
    await this.d.store.markMachineOutdated(machineId, new Date().toISOString()).catch((err: unknown) => this.d.logger.error({ err }, 'markMachineOutdated failed'));
  }

  private rearm(t: Timer, fn: () => void, ms: number): Timer {
    clearTimeout(t);
    const next = setTimeout(fn, ms);
    unrefTimer(next);
    return next;
  }

  private pullIdle(id: string, path: string): void {
    this.endPull(id, new UncageError('tool_failed', { message: `The machine stopped sending "${path}" (no data for ${PULL_IDLE_MS / 1000} s).` }));
  }

  /**
   * Takes a link out of service at once: later frames are ignored, its in-flight commands fail
   * with `machine_offline`, and (unless replaced) presence is cleared. With `close`, the link's
   * connection is closed with that code.
   */
  private async retire(s: LinkState, o: { close?: [number, string]; keepPresence?: boolean } = {}): Promise<void> {
    if (o.close) s.link.close(o.close[0], o.close[1]);
    if (s.dead) return;
    s.dead = true;
    s.abort.abort();
    for (const [id, p] of this.pulls) if (p.state === s) this.endPull(id, new UncageError('machine_offline', { message: 'The machine disconnected during the file pull.' }));
    const offline = new UncageError('machine_offline').toBody();
    for (const id of s.inflight) {
      const to = routeOf(id);
      if (to) void this.publishQuiet(to, { k: 'res', id, ok: false, error: offline });
    }
    s.inflight.clear();
    const machineId = s.link.machine.id;
    if (this.active.get(machineId) !== s) return;
    this.active.delete(machineId);
    await Promise.all([
      o.keepPresence ? undefined : this.d.cluster.clearPresence(machineId, this.d.nodeId),
      this.d.store.updateMachine(machineId, { lastSeenAt: new Date().toISOString() }),
    ]).catch((err) => this.d.logger.error({ err }, 'machine close bookkeeping failed'));
  }

  private publish(nodeId: string, msg: NodeMsg): Promise<void> {
    return this.d.cluster.publish(nodeChannel(nodeId), JSON.stringify(msg));
  }

  private async publishQuiet(nodeId: string, msg: NodeMsg): Promise<void> {
    try {
      await this.publish(nodeId, msg);
    } catch (err) {
      this.d.logger.error({ err }, 'cluster publish failed');
    }
  }

  /** The machine's welcomed local link, if it is live. */
  private live(machineId: string): LinkState | undefined {
    const s = this.active.get(machineId);
    return s && s.ready && !s.dead && !s.link.signal.aborted ? s : undefined;
  }

  private async onNodeMessage(msg: NodeMsg): Promise<void> {
    if (msg.k === 'pull') {
      // Synchronous on purpose: chunks must reach the assembler in publish order.
      const p = this.pulls.get(msg.id);
      if (!p || p.state || p.machineId !== msg.machineId || !PULL_FRAMES.has(msg.frame.t) || msg.frame.id !== msg.id) return;
      if (msg.frame.t === 'result') this.pullResult(msg.id, p, msg.frame);
      else this.pullFrame(msg.id, p, msg.frame);
      return;
    }
    if (msg.k === 'deliver') {
      const s = this.live(msg.machineId);
      if (s) await s.link.send(msg.frame);
      else await this.deliver(msg.machineId, msg.frame, { viaOutbox: true }).catch((err: unknown) => this.d.logger.error({ err }, 'delivery failed'));
      return;
    }
    if (msg.k === 'up') {
      // Only upload frames of this very upload are forwarded, nothing else.
      if (!UPLOAD_FRAMES.has(msg.frame.t) || !('id' in msg.frame) || msg.frame.id !== msg.id) {
        this.d.logger.warn({ t: msg.frame.t }, 'cluster upload message with a foreign frame dropped');
        return;
      }
      // Synchronous on purpose: upload frames must reach the link in publish order.
      const s = this.live(msg.machineId);
      if (msg.frame.t === 'attachment_begin') {
        if (!s) {
          const to = routeOf(msg.id);
          if (to) await this.publishQuiet(to, { k: 'res', id: msg.id, ok: false, error: new UncageError('machine_offline').toBody() });
          return;
        }
        s.inflight.add(msg.id);
      } else if (!s || !s.inflight.has(msg.id)) return;
      void s.link.send(msg.frame);
      return;
    }
    if (msg.k === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.machineId !== undefined && msg.machineId !== p.machineId) {
        this.d.logger.warn({ machineId: msg.machineId }, 'a machine answered a command sent to another machine; dropped');
        return;
      }
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
      const s = this.active.get(msg.machineId);
      if (s && s.link.linkId !== msg.except) {
        await this.retire(s, { close: msg.reason === 'revoked' ? [LINK_CLOSE.revoked, 'revoked'] : [LINK_CLOSE.replaced, 'replaced'] });
      }
      return;
    }
    // k === 'cmd': forward to the machine if its link is here.
    const s = this.active.get(msg.machineId);
    if (!s || s.dead || s.link.signal.aborted) {
      const to = routeOf(msg.id);
      if (to) await this.publishQuiet(to, { k: 'res', id: msg.id, ok: false, error: new UncageError('machine_offline').toBody() });
      return;
    }
    s.inflight.add(msg.id);
    void s.link.send({ t: 'command', id: msg.id, op: msg.op, args: msg.args });
  }

  /**
   * Durable delivery of a frame to wherever the machine is: its WebSocket on this node, the node
   * holding its WebSocket (cluster `deliver`), or its outbox (HTTP, and an offline machine: the
   * frame waits there until `expiresInMs`, read once the machine streams over HTTP; a WebSocket
   * agent gets a tool result again by resending the call).
   */
  async deliver(machineId: string, frame: HubFrame, o: { expiresInMs?: number; viaOutbox?: boolean } = {}): Promise<void> {
    if (!o.viaOutbox) {
      const local = this.live(machineId);
      if (local) {
        await local.link.send(frame);
        return;
      }
      const node = await this.d.cluster.getPresence(machineId);
      if (node && node !== HTTP_PRESENCE && node !== this.d.nodeId) {
        await this.publish(node, { k: 'deliver', machineId, frame });
        return;
      }
    }
    await this.enqueue(machineId, [{ msgId: `dlv_${randomHex(12)}`, msg: frame, ttlMs: o.expiresInMs ?? DELIVER_OUTBOX_TTL_MS }]);
  }

  /** Whether the machine currently has a connection on any node. */
  async isOnline(machineId: string): Promise<boolean> {
    return (await this.d.cluster.getPresence(machineId)) !== null;
  }

  /** Settles a pending command or upload once. */
  private settle(id: string, err: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.reject(err);
  }

  /**
   * Writes frames to the machine's durable outbox (HTTP transport) and wakes its stream. Rejects
   * with `machine_offline` when the machine no longer exists.
   */
  async enqueue(machineId: string, items: Array<{ msgId: string; msg: HubFrame; ttlMs: number }>): Promise<void> {
    const now = Date.now();
    const r = await this.d.store.enqueueOutbox(
      machineId,
      items.map((it) => ({ msgId: it.msgId, msg: it.msg, expiresAt: new Date(now + it.ttlMs).toISOString() })),
      new Date(now).toISOString(),
    );
    if (r === 'gone') throw new UncageError('machine_offline');
    await this.wake(machineId);
  }

  /**
   * Sends a command to the machine (wherever it is connected) and resolves its validated result.
   * WebSocket: through the cluster to the node holding the socket. HTTP: through the durable outbox
   * (expiring with the command timeout); the result may arrive on any instance and is routed back
   * by the node encoded in the id.
   */
  async command<K extends HubCommandOp>(machineId: string, op: K, args: HubCommandArgs[K]): Promise<HubCommandResults[K]> {
    if (this.closed) throw new UncageError('machine_offline');
    const node = await this.d.cluster.getPresence(machineId);
    if (!node) throw new UncageError('machine_offline');
    const id = routedId('cmd', this.d.nodeId);
    const frameBytes = utf8Length(JSON.stringify({ t: 'command', id, op, args }));
    if (frameBytes > MAX_FRAME_BYTES) {
      throw new UncageError('invalid_request', {
        message: `The ${op} command is too large to send to the machine (${frameBytes} bytes, max ${MAX_FRAME_BYTES}).`,
      });
    }
    // The reply comes back on our node channel.
    await this.acquire();
    try {
      if (this.closed) throw new UncageError('machine_offline');
      const result = new Promise<HubCommandResults[K]>((resolve, reject) => {
        const timer = setTimeout(() => this.settle(id, new UncageError('machine_offline', { message: 'The machine did not respond in time.' })), this.d.commandTimeoutMs);
        unrefTimer(timer);
        this.pending.set(id, { op, machineId, resolve: resolve as (v: unknown) => void, reject, timer });
      });
      const sent =
        node === HTTP_PRESENCE
          ? this.enqueue(machineId, [{ msgId: id, msg: { t: 'command', id, op, args }, ttlMs: this.d.commandTimeoutMs }])
          : this.publish(node, { k: 'cmd', id, machineId, op, args });
      sent.catch((err: unknown) => this.settle(id, err));
      return await result;
    } finally {
      this.release();
    }
  }

  /**
   * Uploads an attachment to the machine (wherever it is connected) in 256 KiB `attachment_chunk`
   * frames — for attachments too large for one `addAttachment` command. Resolves the machine's
   * `Attachment`.
   */
  async upload(machineId: string, args: { sessionId: string; name: string; mime: string }, data: Uint8Array): Promise<Attachment> {
    if (this.closed) throw new UncageError('machine_offline');
    const node = await this.d.cluster.getPresence(machineId);
    if (!node) throw new UncageError('machine_offline');
    const id = routedId('upl', this.d.nodeId);
    const http = node === HTTP_PRESENCE;
    /** HTTP: frames are written to the outbox in batches. */
    let batch: HubFrame[] = [];
    let n = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const frames = batch;
      batch = [];
      await this.enqueue(
        machineId,
        frames.map((msg) => ({ msgId: `${id}:${n++}`, msg, ttlMs: this.d.commandTimeoutMs })),
      );
    };
    const send = async (frame: HubFrame): Promise<void> => {
      if (!http) return this.publish(node, { k: 'up', id, machineId, frame });
      batch.push(frame);
      if (batch.length >= UPLOAD_OUTBOX_BATCH || frame.t === 'attachment_end' || frame.t === 'attachment_abort') await flush();
    };
    await this.acquire();
    try {
      const timedOut = () => {
        if (!this.pending.has(id)) return;
        void send({ t: 'attachment_abort', id }).catch(() => undefined);
        this.settle(id, new UncageError('machine_offline', { message: 'The machine did not respond in time.' }));
      };
      /** The timeout is about the machine going silent, not the size of the upload: re-armed after each frame. */
      const arm = () => {
        const p = this.pending.get(id);
        if (p) p.timer = this.rearm(p.timer, timedOut, this.d.commandTimeoutMs);
      };
      const result = new Promise<Attachment>((resolve, reject) => {
        const timer = setTimeout(timedOut, this.d.commandTimeoutMs);
        unrefTimer(timer);
        this.pending.set(id, { op: 'addAttachment', machineId, resolve: resolve as (v: unknown) => void, reject, timer });
      });
      result.catch(() => undefined);
      try {
        await send({ t: 'attachment_begin', id, sessionId: args.sessionId, name: args.name, mime: args.mime, size: data.byteLength });
        for (let at = 0, seq = 0; at < data.byteLength; at += FILE_CHUNK_BYTES, seq++) {
          if (!this.pending.has(id)) break; // already answered (e.g. refused at begin)
          await send({ t: 'attachment_chunk', id, seq, data: toBase64(data.subarray(at, at + FILE_CHUNK_BYTES)) });
          arm();
        }
        if (this.pending.has(id)) {
          await send({ t: 'attachment_end', id });
          arm();
        }
      } catch (err) {
        if (this.pending.has(id)) {
          void send({ t: 'attachment_abort', id }).catch(() => undefined);
          this.settle(id, err);
        }
      }
      return await result;
    } finally {
      this.release();
    }
  }

  /**
   * Pulls `path` from the session workspace of a machine connected to this node (site tools run
   * on the node holding the machine's connection). All-or-nothing; see `PullAssembler`.
   */
  async pull(machineId: string, sessionId: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<PullOutcome> {
    const s = this.live(machineId);
    // Over HTTP the pull request goes through the outbox and the chunks come back in POSTs.
    const http = !s && (await this.d.cluster.getPresence(machineId)) === HTTP_PRESENCE;
    if (!s && !http) throw new UncageError('machine_offline');
    if (signal?.aborted) throw new UncageError('tool_failed', { message: 'The tool call was abandoned.' });
    const id = routedId('pull', this.d.nodeId);
    if (http) {
      // Its frames may reach any instance, which forwards them on our node channel.
      await this.acquire();
      try {
        return await this.startPull(id, machineId, sessionId, path, maxBytes, undefined, signal);
      } finally {
        this.release();
      }
    }
    return this.startPull(id, machineId, sessionId, path, maxBytes, s, signal);
  }

  private startPull(id: string, machineId: string, sessionId: string, path: string, maxBytes: number, s: LinkState | undefined, signal?: AbortSignal): Promise<PullOutcome> {
    return new Promise<PullOutcome>((resolve, reject) => {
      const onAbort = () => this.endPull(id, new UncageError('tool_failed', { message: 'The tool call was abandoned.' }));
      const timer = setTimeout(() => this.pullIdle(id, path), PULL_IDLE_MS);
      unrefTimer(timer);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pulls.set(id, {
        ...(s ? { state: s } : {}),
        machineId,
        asm: new PullAssembler(path, maxBytes),
        path,
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      const frame: HubFrame = { t: 'file_pull', id, sessionId, path, maxBytes };
      if (s) void s.link.send(frame);
      else this.enqueue(machineId, [{ msgId: id, msg: frame, ttlMs: PULL_OUTBOX_TTL_MS }]).catch((err: unknown) => this.endPull(id, err));
    });
  }

  /** Settles a pull once; later frames for its id are ignored. */
  private endPull(id: string, err: unknown, outcome?: PullOutcome): void {
    const p = this.pulls.get(id);
    if (!p) return;
    this.pulls.delete(id);
    clearTimeout(p.timer);
    p.cleanup();
    if (err) p.reject(err);
    else p.resolve(outcome!);
  }

  /** Disconnects a machine (revoked, or its token rotated) wherever it is connected. */
  async kick(machineId: string, reason: 'revoked' | 'replaced' = 'revoked'): Promise<void> {
    const node = await this.d.cluster.getPresence(machineId);
    const local = this.active.get(machineId);
    if (local) await this.retire(local, { close: reason === 'revoked' ? [LINK_CLOSE.revoked, 'revoked'] : [LINK_CLOSE.replaced, 'replaced'] });
    if (node === HTTP_PRESENCE) {
      // Revoked: the machine's link rows are gone with it. Token rotated (re-paired): close the
      // link the old token opened. Either way its stream ends on its next poll — now.
      if (reason === 'replaced') await this.d.store.closeLink(machineId, null);
      await this.d.cluster.clearPresence(machineId, HTTP_PRESENCE);
      await this.wake(machineId);
      return;
    }
    if (node && node !== this.d.nodeId) await this.publishQuiet(node, { k: 'kick', machineId, reason });
    if (node) await this.d.cluster.clearPresence(machineId, node);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeHooks.splice(0)) {
      try {
        fn();
      } catch (err) {
        this.d.logger.error({ err }, 'close hook failed');
      }
    }
    for (const id of [...this.pending.keys()]) this.settle(id, new UncageError('machine_offline'));
    const links = [...this.links.values()];
    this.links.clear();
    await Promise.all(links.map((s) => this.retire(s, { close: [LINK_CLOSE.shutdown, 'hub shutting down'] })));
    this.subRefs = 1;
    this.release();
  }
}
