import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createUncage, UncageError, type CallTool, type Uncage } from '@uncage/core';
import {
  CONNECTED_PROTOCOL,
  HubCommandArgsSchemas,
  MAX_FRAME_BYTES,
  newId,
  type AgentFrame,
  type AgentInfo,
  type ErrorBody,
  type HubCommandArgs,
  type HubCommandOp,
  type HubFrame,
  type PermissionMode,
  type RuntimeAdapter,
  type ToolCallResult,
  type TransportKind,
  type UncageEvent,
} from '@uncage/protocol';
import { ActivityLog } from './activity.js';
import { siteDir, type AgentConfig, type AgentSite } from './config.js';
import { offeredTransportUrl } from './device.js';
import { planPull, sendPull } from './files.js';
import { fitEvent } from './fit.js';
import { chooseTransport, fetchAgentInfo } from './transport/choose.js';
import { dialHttp } from './transport/http.js';
import { FrameTooLargeError, backoffDelay, type AgentLink, type AgentLogger, type AgentTiming, type DialOptions } from './transport/types.js';
import { dialWs } from './transport/ws.js';

export { HUB_CLOSE } from './transport/ws.js';
export { backoffDelay, DEFAULT_TIMING, type AgentLogger, type AgentTiming } from './transport/types.js';

/** Most chunked attachment uploads in progress at once (per site). */
const MAX_UPLOADS = 8;

/** Keep frames comfortably below the hub's 1 MiB limit. */
const FRAME_BUDGET = MAX_FRAME_BYTES - 16 * 1024;
/** Largest single event in a frame (room for the frame envelope). */
const EVENT_BUDGET = FRAME_BUDGET - 1024;
const READ_PAGE = 500;
/** Unacked batches tracked per session before concluding the hub does not ack (machine storage). */
const MAX_OUTSTANDING = 256;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

const errorBody = (e: unknown): ErrorBody =>
  (e instanceof UncageError ? e : new UncageError('internal_error', { message: e instanceof Error ? e.message : String(e) })).toBody();

/** `host[-port]` of a hub URL: the per-site workspace root `~/Uncage/<siteHost>/`. */
export const siteHost = (url: string): string => {
  const u = new URL(url);
  const host = `${u.hostname}${u.port ? `-${u.port}` : ''}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  if (/^[.-]*$/.test(host) || host.includes('..')) throw new Error(`Cannot derive a workspace folder from "${url}".`);
  return host;
};

/** Replication cursor of one session (see `SiteAgent` doc). */
interface Rep {
  /** Highest sequence believed to be at the hub (carried across connections). */
  delivered: number;
  /** Highest sequence sent (or known present) on the current connection. */
  sentHigh: number;
  /** `[first, last]` of batches sent on this connection and not yet acked. */
  outstanding: Array<[number, number]>;
  pumping: boolean;
  dirty: boolean;
  /** Bumped by rewinds and reconnects: an in-progress pump iteration starts over. */
  gen: number;
}

/**
 * A single-consumer byte stream: chunks pushed by the hub's `attachment_chunk` frames, consumed by
 * core's `attachments.add` (which writes them to a `.tmp-*` file inside the session's attachment
 * directory and renames it on success, or removes it when the stream fails).
 */
class ChunkStream implements AsyncIterable<Uint8Array> {
  private readonly backlog: Uint8Array[] = [];
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;

  push(chunk: Uint8Array): void {
    this.backlog.push(chunk);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  fail(err: unknown): void {
    if (this.error === undefined) this.error = err;
    this.backlog.length = 0;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      if (this.error !== undefined) throw this.error;
      const next = this.backlog.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

interface Upload {
  stream: ChunkStream;
  size: number;
  received: number;
  nextSeq: number;
  timer: NodeJS.Timeout;
}

interface PendingTool {
  /** Re-sent (same id) after every welcome until the hub answers. */
  frame: Extract<AgentFrame, { t: 'tool_call' }>;
  resolve(r: ToolCallResult): void;
  reject(e: unknown): void;
}

/** Commands remembered for dedupe (a redelivered command is answered from here, never run again). */
const COMMAND_CACHE = 1000;
/** Byte budget of the cached results (dedupe cache, and results not yet accepted by the hub). */
const COMMAND_CACHE_BYTES = 32 * 1024 * 1024;
/** An unsent result is given up after this many send attempts (one per welcome) or this age. */
const UNSENT_MAX_ATTEMPTS = 5;
const UNSENT_MAX_AGE_MS = 10 * 60_000;
/** Read-only commands: running one again is harmless, so their (possibly large) results are not cached. */
const READ_ONLY_OPS = new Set<HubCommandOp>(['readEvents', 'snapshot', 'listSessions']);
/** `GET /agent/info` is re-read at most this often. */
const INFO_TTL_MS = 5 * 60_000;
/** While busy, an HTTP link waits this long before checking again whether WebSocket can be retried. */
const REPROBE_BUSY_RECHECK_MS = 60_000;

export type SiteStop = 'revoked' | 'replaced' | 'upgrade' | 'closed';
/** Live state of a site's connection. */
export type SiteState = 'connecting' | 'connected' | 'upgrade_failed' | 'revoked' | 'replaced' | 'closed';

export interface SiteAgentOptions {
  site: AgentSite;
  home: string;
  adapters: RuntimeAdapter[];
  localPolicy: AgentConfig['localPolicy'];
  logger: AgentLogger;
  timing: AgentTiming;
  machine: { name: string; os: string };
  agentVersion: string;
  /** HTTP client for `/agent/info` and the HTTP transport. Default: the global `fetch` (tests inject one). */
  fetch?: typeof fetch;
  /** Byte budget of cached command results. Default 32 MiB (tests lower it). */
  commandCacheBytes?: number;
  /** The site stopped for good (revoked or replaced). */
  onStop(reason: 'revoked' | 'replaced'): void;
  /**
   * The hub requires a newer agent. On success the process exits; otherwise resolves how long this
   * site stays disconnected before trying again.
   */
  onUpgradeRequired(minAgentVersion: string | undefined): Promise<number>;
}

/**
 * One website: its own core instance (`~/.uncage/sites/<id>/data`), workspace root
 * (`~/Uncage/<siteHost>/`), activity log and one link to its hub.
 *
 * Transport: before each dial the agent reads `GET <hub>/agent/info` (cached 5 min) and picks
 * WebSocket when offered, HTTP streaming when only that is offered or after `wsFallbackAfter`
 * failed WebSocket attempts in a row (WebSocket is retried `wsReprobeMs` later). Everything above
 * the link (replication, commands, site tools, file pulls, uploads) is transport-neutral.
 *
 * Replication: every committed event is sent in an `events` frame as soon as the connection is up
 * (after `welcome`). Per session the agent keeps a cursor. A hub that keeps a replica ("site"
 * storage) acks each batch and, on connect, the last sequence it has for every session; an ack
 * that reveals a gap (lower than what was sent, with no batch in flight that would fill it) rewinds
 * the cursor and the agent resends from there. Since the hub only accepts `lastSequence + 1`
 * onward, resends never duplicate. A hub without a replica never acks; there the cursor is "sent
 * while connected", and events produced while offline are sent after the next `welcome`.
 *
 * Exactly-once: commands are deduped by id (the cached result is re-sent); a pending site tool call
 * survives a dropped connection and its `tool_call` is re-sent with the same id after every welcome
 * (the hub answers from its stored outcome); a `tool_result` for an unknown id is ignored.
 */
export class SiteAgent {
  readonly site: AgentSite;
  private uncage!: Uncage;
  private activity: ActivityLog;
  private root: string;
  private link: AgentLink | undefined;
  private linkKind: TransportKind | null = null;
  private connected = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly reps = new Map<string, Rep>();
  private acksOnConn = false;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly pulls = new Set<AbortController>();
  private readonly uploads = new Map<string, Upload>();
  /**
   * Command id → its result frame (`null` while it runs), for dedupe. Insertion-ordered: the oldest
   * is evicted past `COMMAND_CACHE` entries or `COMMAND_CACHE_BYTES`. Read-only ops are not kept.
   */
  private readonly commands = new Map<string, { frame: AgentFrame | null; bytes: number }>();
  private commandBytes = 0;
  /**
   * Results the hub has not accepted yet (the link ended first): re-sent after every welcome. The hub
   * routes a late result to the waiting request, or drops it quietly if that request gave up.
   */
  private readonly unsentResults = new Map<string, { frame: AgentFrame; bytes: number; firstAt: number; attempts: number }>();
  private unsentBytes = 0;
  private runningCommands = 0;
  /** Frames handed to the link and not yet accepted (HTTP: not yet `processed`). */
  private sending = 0;
  private readonly activeRuns = new Set<string>();
  /** HTTP transport: highest outbox seq dispatched (process lifetime). */
  private cursor = 0;
  private info: { value: AgentInfo; at: number } | undefined;
  private wsFailures = 0;
  private fellBackAt: number | undefined;
  private httpFailures = 0;
  private reprobing = false;
  /** See `SiteState`. */
  state: SiteState = 'connecting';

  constructor(private readonly o: SiteAgentOptions) {
    this.site = o.site;
    this.activity = new ActivityLog(o.home, o.site.id, (err) => o.logger.error({ err, site: o.site.id }, 'activity log write failed'));
    this.root = join(o.home, 'Uncage', siteHost(o.site.url));
  }

  private get log(): AgentLogger {
    return this.o.logger;
  }

  /** Transport of the live (welcomed) link, `null` while not connected. */
  get transport(): TransportKind | null {
    return this.connected ? this.linkKind : null;
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const dataDir = join(siteDir(this.o.home, this.site.id), 'data');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    this.uncage = await createUncage({
      adapters: this.o.adapters,
      dataDir,
      workspace: { allowedRoots: [this.root], default: this.root },
      security: { allowBypass: this.o.localPolicy.allowBypass },
      onEvent: (e) => this.onEvent(e),
    });
    try {
      // Sessions from earlier runs: assume delivered up to their last sequence (a replicating hub's
      // acks correct this on connect). Events already seen (startup reconciliation) keep their cursor.
      for (const s of await this.uncage.sessions.list()) {
        if (this.reps.has(s.id)) continue;
        const { lastSequence } = await (await this.uncage.sessions.get(s.id)).snapshot();
        this.reps.set(s.id, this.newRep(lastSequence));
      }
    } catch (err) {
      await this.uncage.close().catch(() => undefined);
      throw err;
    }
    this.loopDone = this.loop();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.state === 'connecting' || this.state === 'connected') this.state = 'closed';
    this.wake?.();
    this.link?.close();
    await this.loopDone;
    for (const p of [...this.pendingTools.values()]) p.reject(new UncageError('tool_failed', { message: 'The agent is shutting down.' }));
    await this.uncage?.close();
    await this.activity.flush();
  }

  // ---- connection -------------------------------------------------------------------------

  private get fetchFn(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  private async agentInfo(): Promise<AgentInfo | null> {
    if (this.info && Date.now() - this.info.at < INFO_TTL_MS) return this.info.value;
    const value = await fetchAgentInfo(this.fetchFn, this.site.url);
    if (value) this.info = { value, at: Date.now() };
    return value ?? this.info?.value ?? null;
  }

  /**
   * Work in flight: a run, a site tool call, a command still running, a frame the hub has not
   * accepted yet, a file pull or an upload. Keeps the hub polling fast; a WebSocket re-probe waits
   * until this is false.
   */
  private busy(): boolean {
    return (
      this.activeRuns.size > 0 ||
      this.pendingTools.size > 0 ||
      this.runningCommands > 0 ||
      this.sending > 0 ||
      this.unsentResults.size > 0 ||
      this.pulls.size > 0 ||
      this.uploads.size > 0
    );
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    const t = this.o.timing;
    while (!this.stopped) {
      const info = await this.agentInfo();
      if (this.stopped) return;
      const kind = chooseTransport(info, { wsFailures: this.wsFailures, ...(this.fellBackAt !== undefined ? { fellBackAt: this.fellBackAt } : {}), now: Date.now() }, t);
      if (kind === 'ws' && this.wsFailures >= t.wsFallbackAfter) {
        // Re-probe after a fallback: one more failure goes straight back to HTTP.
        this.log.info({ site: this.site.id }, 'trying WebSocket again');
        this.wsFailures = t.wsFallbackAfter - 1;
        this.fellBackAt = undefined;
      }
      const runtimes = await this.uncage.runtimes.list().catch(() => []);
      if (this.stopped) return;
      // The URL the hub offers for this transport (e.g. a custom attachWebSocket path), when it is
      // on the site's host with a safe scheme; else `<site.url>/agent`.
      const offered = offeredTransportUrl(kind, info?.transports.find((x) => x.kind === kind)?.url, this.site.url);
      const opts: DialOptions = {
        hubUrl: this.site.url,
        ...(offered ? { url: offered } : {}),
        token: this.site.token,
        hello: {
          t: 'hello',
          protocol: CONNECTED_PROTOCOL,
          agentVersion: this.o.agentVersion,
          machine: { name: this.o.machine.name, os: this.o.machine.os, runtimes },
        },
        onWelcome: (w) => this.onWelcome(link, w.replies),
        onFrame: (f) => this.onFrame(link, f),
        cursor: { get: () => this.cursor, set: (seq) => void (this.cursor = Math.max(this.cursor, seq)) },
        busy: () => this.busy(),
        timing: t,
        fetch: this.fetchFn,
        logger: this.log,
        siteId: this.site.id,
      };
      const link: AgentLink = kind === 'ws' ? dialWs(opts) : dialHttp(opts);
      this.link = link;
      this.linkKind = kind;
      const reprobe = kind === 'http' ? this.scheduleReprobe(info, link) : undefined;
      const r = await link.ended;
      reprobe?.cancel();
      if (this.link === link) this.link = undefined;
      this.onDisconnect();
      if (r.welcomed) void this.activity.append({ kind: 'disconnected' });
      if (this.stopped) return;

      if (!r.stop) this.countFailure(kind, info, r);
      if (r.stop === 'upgrade') {
        void this.activity.append({ kind: 'upgrade', detail: { minAgentVersion: r.minAgentVersion ?? 'unknown' } });
        // Resolves only if the upgrade did not happen (on success the process exits): this site
        // stays offline until the retry time, the other sites keep running.
        const retryInMs = await this.o.onUpgradeRequired(r.minAgentVersion);
        if (this.stopped) return;
        this.state = 'upgrade_failed';
        this.log.warn({ site: this.site.id, retryInMs }, 'staying disconnected until the upgrade can be retried');
        await this.sleep(retryInMs);
        if (!this.stopped) this.state = 'connecting';
        attempt = 0;
        continue;
      }
      if (r.stop) {
        if (r.stop === 'revoked') {
          this.log.warn({ site: this.site.id }, 'machine token revoked by the website; not reconnecting');
          void this.activity.append({ kind: 'revoked' });
        } else {
          this.log.warn({ site: this.site.id }, 'replaced by a newer connection for this machine; stopping this one');
          void this.activity.append({ kind: 'replaced' });
        }
        this.stopped = true;
        this.state = r.stop;
        this.o.onStop(r.stop);
        return;
      }
      if (this.reprobing) {
        this.reprobing = false;
        continue;
      }
      // Only a connection that stayed up resets the backoff (a hub that accepts then drops at once
      // must not be hammered every second).
      if (r.upMs >= t.stableMs) attempt = 0;
      const delay = backoffDelay(attempt++, t);
      this.log.info({ site: this.site.id, delayMs: delay, transport: kind }, 'reconnecting');
      await this.sleep(delay);
    }
  }

  /** Tracks consecutive failures per transport (drives `chooseTransport`). */
  private countFailure(kind: TransportKind, info: AgentInfo | null, r: { welcomed: boolean; upMs: number }): void {
    const t = this.o.timing;
    if (this.reprobing) return;
    const failed = !r.welcomed || r.upMs < t.stableMs;
    // Nothing to fall back to: no bookkeeping.
    if (kind === 'ws' && !info?.transports.some((x) => x.kind === 'http')) return;
    if (kind === 'ws') {
      if (!failed) {
        this.wsFailures = 0;
        this.fellBackAt = undefined;
        return;
      }
      this.wsFailures++;
      if (this.wsFailures >= t.wsFallbackAfter && this.fellBackAt === undefined) {
        this.fellBackAt = Date.now();
        {
          this.log.warn({ site: this.site.id, failures: this.wsFailures }, 'WebSocket keeps failing; falling back to HTTP streaming');
        }
      }
      return;
    }
    // HTTP that never even connects while WebSocket is the one we fell back from: try WebSocket again.
    if (r.welcomed) this.httpFailures = 0;
    else if (++this.httpFailures >= t.wsFallbackAfter && this.wsFailures >= t.wsFallbackAfter) {
      this.httpFailures = 0;
      this.wsFailures = 0;
      this.fellBackAt = undefined;
    }
  }

  /**
   * On an HTTP link chosen as a fallback from WebSocket: once `wsReprobeMs` has passed and nothing
   * is in flight, ends the link so the next dial tries WebSocket again.
   */
  private scheduleReprobe(info: AgentInfo | null, link: AgentLink): { cancel(): void } | undefined {
    if (this.fellBackAt === undefined || (info && !info.transports.some((x) => x.kind === 'ws'))) return undefined;
    let timer: NodeJS.Timeout;
    const check = () => {
      if (this.link !== link || this.stopped) return;
      if (this.busy()) {
        timer = setTimeout(check, Math.min(REPROBE_BUSY_RECHECK_MS, this.o.timing.wsReprobeMs));
        timer.unref();
        return;
      }
      this.reprobing = true;
      link.close();
    };
    timer = setTimeout(check, Math.max(0, this.fellBackAt + this.o.timing.wsReprobeMs - Date.now()));
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.wake = undefined;
  }

  /** Records an entry in this site's activity log. */
  recordActivity(e: Parameters<ActivityLog['append']>[0]): Promise<void> {
    return this.activity.append(e);
  }

  private onWelcome(link: AgentLink, replies: HubFrame[]): void {
    if (this.link !== link) return;
    this.connected = true;
    this.state = 'connected';
    this.acksOnConn = false;
    this.log.info({ site: this.site.id, transport: link.kind }, 'connected');
    // `name`: the transport (`ws` / `http`), shown by `uncage dashboard`.
    void this.activity.append({ kind: 'connected', name: link.kind });
    for (const rep of this.reps.values()) {
      rep.sentHigh = rep.delivered;
      rep.outstanding = [];
      rep.gen++;
    }
    for (const f of replies) this.onFrame(link, f);
    // Site tool calls still waiting for their result: ask again (same id; the hub never runs one twice).
    for (const p of this.pendingTools.values()) this.sendToolCall(p);
    // Command results the previous link never got accepted (e.g. it died right after the ack).
    for (const [id, u] of this.unsentResults) void this.deliverResult(id, u.frame);
    void this.backfillAll();
  }

  private onDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    if (this.state === 'connected') this.state = this.stopped ? 'closed' : 'connecting';
    for (const rep of this.reps.values()) {
      rep.delivered = this.acksOnConn && rep.outstanding.length > 0 ? rep.outstanding[0]![0] - 1 : rep.sentHigh;
      rep.outstanding = [];
      rep.gen++;
    }
    // Pending tool calls are kept: they are re-sent after the next welcome (their own timeout still runs).
    for (const ac of this.pulls) ac.abort();
    for (const u of this.uploads.values()) u.stream.fail(new UncageError('machine_offline', { message: 'The connection to the website was lost during the upload.' }));
  }

  /** Sends on the current, welcomed link. */
  private send(f: AgentFrame): Promise<void> {
    if (!this.connected || !this.link) return Promise.reject(new UncageError('machine_offline'));
    this.sending++;
    return this.link.send(f).finally(() => this.sending--);
  }

  private onFrame(link: AgentLink, f: HubFrame): void {
    if (this.link !== link || !this.connected) return;
    switch (f.t) {
      case 'command':
        void this.onCommand(f.id, f.op, f.args);
        return;
      case 'ack':
        this.onAck(f.sessionId, f.sequence);
        return;
      case 'tool_result': {
        const p = this.pendingTools.get(f.id);
        if (!p) return; // answered already (a duplicate) or given up
        this.pendingTools.delete(f.id);
        if (f.ok) p.resolve(f.result);
        else p.reject(new UncageError(f.error.code, { message: f.error.message }));
        return;
      }
      case 'file_pull':
        void this.onFilePull(f);
        return;
      case 'attachment_begin':
        this.onUploadBegin(f);
        return;
      case 'attachment_chunk':
        this.onUploadChunk(f);
        return;
      case 'attachment_end': {
        const u = this.uploads.get(f.id);
        if (!u) return;
        if (u.received !== u.size) u.stream.fail(new UncageError('invalid_request', { message: `The upload ended after ${u.received} of ${u.size} bytes (size mismatch).` }));
        else u.stream.end();
        return;
      }
      case 'attachment_abort':
        this.uploads.get(f.id)?.stream.fail(new UncageError('invalid_request', { message: 'The upload was aborted by the website.' }));
        return;
      default:
        return;
    }
  }

  // ---- commands ---------------------------------------------------------------------------

  private async onCommand(id: string, op: HubCommandOp, rawArgs: unknown): Promise<void> {
    const seen = this.commands.get(id);
    if (seen) {
      // Redelivered (overlapping streams, a resend): answer from the cache, never run it again.
      if (seen.frame && !this.unsentResults.has(id)) await this.sendResult(seen.frame).catch(() => undefined);
      return;
    }
    const readOnly = READ_ONLY_OPS.has(op);
    this.cacheCommand(id, null);
    this.runningCommands++;
    let frame: AgentFrame;
    try {
      frame = await this.runCommand(id, op, rawArgs);
    } finally {
      this.runningCommands--;
    }
    if (readOnly) this.uncacheCommand(id);
    else if (this.commands.has(id)) this.cacheCommand(id, frame);
    await this.deliverResult(id, frame);
  }

  /** Sends a command result; until the hub accepts it, it waits in `unsentResults` (re-sent after the next welcome). */
  private async deliverResult(id: string, frame: AgentFrame): Promise<void> {
    let u = this.unsentResults.get(id);
    if (!u) {
      u = { frame, bytes: byteLength(JSON.stringify(frame)), firstAt: Date.now(), attempts: 0 };
      this.unsentResults.set(id, u);
      this.unsentBytes += u.bytes;
      this.trimCache();
    }
    if (u.attempts >= UNSENT_MAX_ATTEMPTS || Date.now() - u.firstAt > UNSENT_MAX_AGE_MS) {
      this.dropUnsent(id, 'the website did not accept it in time');
      return;
    }
    u.attempts++;
    try {
      await this.sendResult(frame);
      this.dropUnsent(id);
    } catch (err) {
      // Only a lost link is worth another try (after the next welcome); a refusal is permanent.
      if (err instanceof UncageError && err.code === 'machine_offline') {
        this.log.warn({ site: this.site.id, err: err.message }, 'could not send result; will retry after reconnecting');
      } else this.dropUnsent(id, (err as Error).message);
    }
  }

  /** Forgets an unsent result; with `why`, logs once that it was given up. */
  private dropUnsent(id: string, why?: string): void {
    const u = this.unsentResults.get(id);
    if (!u) return;
    this.unsentResults.delete(id);
    this.unsentBytes -= u.bytes;
    if (why) this.log.error({ site: this.site.id, commandId: id, why }, 'command result given up');
  }

  private cacheCommand(id: string, frame: AgentFrame | null): void {
    this.uncacheCommand(id);
    const bytes = frame ? byteLength(JSON.stringify(frame)) : 0;
    this.commands.set(id, { frame, bytes });
    this.commandBytes += bytes;
    this.trimCache();
  }

  /**
   * One byte budget (`commandCacheBytes`, default 32 MiB) for the dedupe cache and the unsent results
   * together: the oldest dedupe entries go first, then the oldest unsent results. At most
   * `COMMAND_CACHE` dedupe entries. The newest entry always stays, and so do commands still running
   * (a redelivery of one must not start it twice).
   */
  private trimCache(): void {
    const budget = this.o.commandCacheBytes ?? COMMAND_CACHE_BYTES;
    /** The oldest finished entry other than the newest one, if any. */
    const evictable = (): string | undefined => {
      let newest: string | undefined;
      for (const id of this.commands.keys()) newest = id;
      for (const [id, c] of this.commands) if (c.frame !== null && id !== newest) return id;
      return undefined;
    };
    for (let id; this.commands.size > COMMAND_CACHE && (id = evictable()) !== undefined; ) this.uncacheCommand(id);
    for (let id; this.commandBytes + this.unsentBytes > budget && (id = evictable()) !== undefined; ) this.uncacheCommand(id);
    while (this.commandBytes + this.unsentBytes > budget && this.unsentResults.size > 1) {
      this.dropUnsent(this.unsentResults.keys().next().value!, 'over the memory budget for unsent results');
    }
  }

  private uncacheCommand(id: string): void {
    const c = this.commands.get(id);
    if (!c) return;
    this.commands.delete(id);
    this.commandBytes -= c.bytes;
  }

  private async runCommand(id: string, op: HubCommandOp, rawArgs: unknown): Promise<AgentFrame> {
    const parsed = HubCommandArgsSchemas[op].safeParse(rawArgs);
    if (!parsed.success) {
      const err = new UncageError('invalid_request', { message: `Invalid ${op} arguments: ${parsed.error.issues[0]?.message ?? 'bad shape'}` });
      void this.activity.append({ kind: 'command', name: op, ok: false, code: err.code });
      return { t: 'result', id, ok: false, error: err.toBody() };
    }
    try {
      const data = await this.execute(op, parsed.data as HubCommandArgs[typeof op]);
      void this.activity.append({ kind: 'command', name: op, ok: true, detail: this.activityArgs(op, parsed.data) });
      return { t: 'result', id, ok: true, data };
    } catch (err) {
      const body = errorBody(err);
      if (body.code === 'internal_error') this.log.error({ err, site: this.site.id, op }, 'command failed');
      void this.activity.append({ kind: 'command', name: op, ok: false, code: body.code, detail: this.activityArgs(op, parsed.data) });
      return { t: 'result', id, ok: false, error: body };
    }
  }

  /** Read-only, high-volume ops carry no detail in the activity log. */
  private activityArgs(op: HubCommandOp, args: unknown): unknown {
    return op === 'readEvents' || op === 'snapshot' || op === 'listSessions' ? undefined : args;
  }

  /** A result too large for one frame: `readEvents` pages shrink; anything else fails cleanly. */
  private async sendResult(f: AgentFrame): Promise<void> {
    if (f.t !== 'result' || !f.ok || byteLength(JSON.stringify(f)) <= FRAME_BUDGET) return this.send(f);
    if (Array.isArray(f.data) && f.data.length > 1) {
      let events = f.data as unknown[];
      while (events.length > 1 && byteLength(JSON.stringify({ ...f, data: events })) > FRAME_BUDGET) {
        events = events.slice(0, Math.ceil(events.length / 2));
      }
      if (byteLength(JSON.stringify({ ...f, data: events })) <= FRAME_BUDGET) return this.send({ ...f, data: events });
    }
    return this.send({
      t: 'result',
      id: f.id,
      ok: false,
      error: new UncageError('internal_error', { message: 'The result is too large to send to the website.' }).toBody(),
    });
  }

  private assertMode(mode: PermissionMode | undefined): void {
    if (mode === undefined) return;
    const { allowBypass, allowedPermissionModes } = this.o.localPolicy;
    if (mode === 'bypassPermissions' && !allowBypass) {
      throw new UncageError('policy_denied', {
        message: 'bypassPermissions can only be enabled on this computer (localPolicy.allowBypass in ~/.uncage/agent.yaml).',
      });
    }
    if (allowedPermissionModes && !allowedPermissionModes.includes(mode)) {
      throw new UncageError('policy_denied', {
        message: `Permission mode "${mode}" is not allowed on this computer (localPolicy.allowedPermissionModes).`,
        details: { allowed: allowedPermissionModes },
      });
    }
  }

  private async execute<K extends HubCommandOp>(op: K, args: HubCommandArgs[K]): Promise<unknown> {
    const u = this.uncage;
    switch (op) {
      case 'createSession': {
        const a = args as HubCommandArgs['createSession'];
        const id = a.id ?? newId('ses');
        const dir = join(this.root, id);
        await mkdir(dir, { mode: 0o700 });
        try {
          const h = await u.sessions.create({ runtime: a.runtime, workspace: dir, ...(a.title !== undefined ? { title: a.title } : {}) }, { id });
          return await h.get();
        } catch (err) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw err;
        }
      }
      case 'startRun': {
        const a = args as HubCommandArgs['startRun'];
        const h = await u.sessions.get(a.sessionId);
        this.assertMode((await h.get()).settings.permissionMode);
        return h.startRun({
          prompt: a.prompt,
          ...(a.attachmentIds !== undefined ? { attachmentIds: a.attachmentIds } : {}),
          idempotencyKey: a.idempotencyKey,
          manifest: a.manifest,
          ...(a.warnings?.length ? { warnings: a.warnings } : {}),
          callTool: this.callTool,
        });
      }
      case 'cancelRun':
        return u.runs.cancel((args as HubCommandArgs['cancelRun']).runId);
      case 'decide': {
        const a = args as HubCommandArgs['decide'];
        return u.approvals.decide(a.approvalId, a.decision, a.idempotencyKey);
      }
      case 'updateSettings': {
        const a = args as HubCommandArgs['updateSettings'];
        this.assertMode(a.patch.permissionMode);
        return u.sessions.updateSettings(a.sessionId, a.patch);
      }
      case 'addAttachment': {
        // Single-frame path (small attachments); larger ones arrive as attachment_* frames.
        const a = args as HubCommandArgs['addAttachment'];
        return u.attachments.add(a.sessionId, { name: a.name, mime: a.mime, body: Buffer.from(a.data, 'base64') });
      }
      case 'snapshot':
        return (await u.sessions.get((args as HubCommandArgs['snapshot']).sessionId)).snapshot();
      case 'listSessions':
        return u.sessions.list();
      case 'readEvents': {
        const a = args as HubCommandArgs['readEvents'];
        return (await u.events.readAfter(a.sessionId, a.after, a.limit)).map((e) => this.fit(e));
      }
    }
    throw new UncageError('invalid_request', { message: `Unknown command "${String(op)}".` });
  }

  // ---- site tools -------------------------------------------------------------------------

  /**
   * A site tool call: `tool_call` to the hub, resolved by its `tool_result`. A dropped connection
   * does not fail it (nor does starting while disconnected): the call is (re-)sent with the same id
   * after every welcome until the hub answers, the run is cancelled or `toolTimeoutMs` passes.
   */
  private readonly callTool: CallTool = (tool, args, ctx) =>
    new Promise<ToolCallResult>((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new UncageError('tool_failed', { message: 'The run was cancelled.' }));
      const id = `tc_${randomUUID().replaceAll('-', '')}`;
      // `input` is opaque to the activity-log redaction: tool arguments never show, not even key names.
      const detail = { sessionId: ctx.sessionId, runId: ctx.runId, input: args };
      const finish = () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        this.pendingTools.delete(id);
      };
      const onAbort = () => {
        finish();
        void this.activity.append({ kind: 'tool_call', name: tool, ok: false, code: 'cancelled', detail });
        reject(new UncageError('tool_failed', { message: 'The run was cancelled.' }));
      };
      const timer = setTimeout(() => {
        finish();
        void this.activity.append({ kind: 'tool_call', name: tool, ok: false, code: 'timeout', detail });
        reject(new UncageError('tool_failed', { message: `Site tool "${tool}" did not answer within ${Math.round(this.o.timing.toolTimeoutMs / 1000)} s.` }));
      }, this.o.timing.toolTimeoutMs);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const pending: PendingTool = {
        frame: { t: 'tool_call', id, sessionId: ctx.sessionId, runId: ctx.runId, tool, args },
        resolve: (r) => {
          finish();
          void this.activity.append({ kind: 'tool_call', name: tool, ok: !r.isError, detail });
          resolve(r);
        },
        reject: (e) => {
          finish();
          void this.activity.append({ kind: 'tool_call', name: tool, ok: false, code: errorBody(e).code, detail });
          reject(e);
        },
      };
      this.pendingTools.set(id, pending);
      if (this.connected) this.sendToolCall(pending);
    });

  /** Sends (or re-sends) a pending call. Only an unsendable frame fails it; a lost link waits for the next welcome. */
  private sendToolCall(p: PendingTool): void {
    this.send(p.frame).catch((e: unknown) => {
      if (e instanceof FrameTooLargeError && this.pendingTools.get(p.frame.id) === p) {
        p.reject(new UncageError('tool_failed', { message: `Could not send the call to the website: ${e.message}` }));
      }
    });
  }

  // ---- file channel -----------------------------------------------------------------------

  private async onFilePull(f: Extract<HubFrame, { t: 'file_pull' }>): Promise<void> {
    const ac = new AbortController();
    this.pulls.add(ac);
    const detail = { sessionId: f.sessionId, path: f.path, maxBytes: f.maxBytes };
    try {
      const session = await (await this.uncage.sessions.get(f.sessionId)).get();
      const plan = await planPull(session.workspace, f.path, f.maxBytes);
      await sendPull(f.id, plan, (frame) => this.send(frame), ac.signal);
      void this.activity.append({ kind: 'file_pull', ok: true, detail: { ...detail, files: plan.files.length } });
    } catch (err) {
      const body = errorBody(err);
      void this.activity.append({ kind: 'file_pull', ok: false, code: body.code, detail });
      // There is no dedicated error frame for pulls: a failed pull answers with a `result` frame
      // carrying the pull id (the hub's file channel treats it as the pull's failure).
      await this.send({ t: 'result', id: f.id, ok: false, error: body }).catch(() => undefined);
    } finally {
      this.pulls.delete(ac);
    }
  }

  // ---- chunked attachment uploads ---------------------------------------------------------

  private onUploadBegin(f: Extract<HubFrame, { t: 'attachment_begin' }>): void {
    const fail = (err: UncageError) => void this.send({ t: 'result', id: f.id, ok: false, error: err.toBody() }).catch(() => undefined);
    if (this.uploads.has(f.id)) return fail(new UncageError('invalid_request', { message: 'Duplicate upload id.' }));
    if (this.uploads.size >= MAX_UPLOADS) {
      return fail(new UncageError('rate_limited', { message: `At most ${MAX_UPLOADS} attachment uploads can run at once.` }));
    }
    const stream = new ChunkStream();
    const upload: Upload = { stream, size: f.size, received: 0, nextSeq: 0, timer: undefined as unknown as NodeJS.Timeout };
    this.uploads.set(f.id, upload);
    this.armUpload(upload);
    const detail = { sessionId: f.sessionId, name: f.name, mime: f.mime, size: f.size, chunked: true };
    void this.uncage.attachments
      .add(f.sessionId, { name: f.name, mime: f.mime, body: stream })
      .then(
        (data): AgentFrame => {
          void this.activity.append({ kind: 'command', name: 'addAttachment', ok: true, detail });
          return { t: 'result', id: f.id, ok: true, data };
        },
        (err: unknown): AgentFrame => {
          const body = errorBody(err);
          void this.activity.append({ kind: 'command', name: 'addAttachment', ok: false, code: body.code, detail });
          return { t: 'result', id: f.id, ok: false, error: body };
        },
      )
      .then((frame) => {
        clearTimeout(upload.timer);
        // Rejected early (unknown session, unsupported type): later chunks for this id are ignored.
        stream.fail(new UncageError('invalid_request', { message: 'upload finished' }));
        if (this.uploads.get(f.id) === upload) this.uploads.delete(f.id);
        return this.send(frame);
      })
      .catch(() => undefined);
  }

  private armUpload(u: Upload): void {
    clearTimeout(u.timer);
    u.timer = setTimeout(
      () => u.stream.fail(new UncageError('invalid_request', { message: `The upload stalled (no data for ${Math.round(this.o.timing.uploadIdleMs / 1000)} s).` })),
      this.o.timing.uploadIdleMs,
    );
    u.timer.unref();
  }

  private onUploadChunk(f: Extract<HubFrame, { t: 'attachment_chunk' }>): void {
    const u = this.uploads.get(f.id);
    if (!u) return;
    if (f.seq !== u.nextSeq) {
      u.stream.fail(new UncageError('invalid_request', { message: `Upload chunk out of order (got ${f.seq}, expected ${u.nextSeq}).` }));
      return;
    }
    const bytes = Buffer.from(f.data, 'base64');
    u.nextSeq++;
    u.received += bytes.byteLength;
    if (u.received > u.size) {
      u.stream.fail(new UncageError('invalid_request', { message: `The upload is larger than its declared size of ${u.size} bytes.` }));
      return;
    }
    this.armUpload(u);
    u.stream.push(bytes);
  }

  // ---- replication ------------------------------------------------------------------------

  private newRep(delivered: number): Rep {
    return { delivered, sentHigh: delivered, outstanding: [], pumping: false, dirty: false, gen: 0 };
  }

  private onEvent(e: UncageEvent): void {
    if (e.type === 'run.started') this.activeRuns.add(e.payload.run.id);
    else if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled' || e.type === 'run.interrupted') {
      this.activeRuns.delete(e.payload.runId);
    }
    if (e.type === 'approval.requested' || e.type === 'approval.resolved') {
      const a = e.payload.approval;
      void this.activity.append({ kind: 'approval', name: e.type, detail: { approvalId: a.id, sessionId: e.sessionId, state: a.state, category: a.category } });
    }
    let rep = this.reps.get(e.sessionId);
    if (!rep) {
      rep = this.newRep(e.sequence - 1);
      this.reps.set(e.sessionId, rep);
    }
    if (!this.connected) return;
    if (!rep.pumping && e.sequence === rep.sentHigh + 1) {
      const sessionId = e.sessionId;
      void this.sendBatch(sessionId, rep, [this.fit(e)]).then((ok) => {
        if (!ok && this.connected) void this.pump(sessionId);
      });
      return;
    }
    void this.pump(e.sessionId);
  }

  /**
   * Sends one `events` frame and advances the cursor. Resolves false — cursor untouched — when it
   * cannot be sent (not connected, frame too large); if the socket write itself fails, the cursor is
   * rewound so those events are sent again.
   */
  private sendBatch(sessionId: string, rep: Rep, events: UncageEvent[]): Promise<boolean> {
    if (!this.connected || !this.link || events.length === 0) return Promise.resolve(false);
    const frame: AgentFrame = { t: 'events', sessionId, events };
    if (byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
      this.log.error({ site: this.site.id, sessionId, first: events[0]!.sequence }, 'events frame too large; not sent');
      return Promise.resolve(false);
    }
    const first = events[0]!.sequence;
    const last = events.at(-1)!.sequence;
    const gen = rep.gen;
    rep.sentHigh = last;
    rep.outstanding.push([first, last]);
    if (!this.acksOnConn && rep.outstanding.length > MAX_OUTSTANDING) rep.outstanding = [];
    return this.send(frame).then(
      () => true,
      (err: unknown) => {
        this.log.warn({ site: this.site.id, err: (err as Error).message }, 'could not send events');
        if (rep.gen === gen && rep.sentHigh >= first) {
          rep.sentHigh = first - 1;
          rep.outstanding = rep.outstanding.filter(([f]) => f < first);
          rep.gen++;
        }
        return false;
      },
    );
  }

  private onAck(sessionId: string, seq: number): void {
    this.acksOnConn = true;
    const rep = this.reps.get(sessionId);
    if (!rep) return;
    rep.outstanding = rep.outstanding.filter(([, last]) => last > seq);
    if (seq > rep.sentHigh) {
      rep.sentHigh = seq;
      rep.gen++;
    } else if (
      seq < rep.sentHigh &&
      (rep.outstanding.length === 0 || rep.outstanding[0]![0] > seq + 1)
    ) {
      // The hub is missing events that nothing in flight will fill: resend from its sequence.
      rep.sentHigh = seq;
      rep.outstanding = [];
      rep.gen++;
      void this.pump(sessionId);
    }
  }

  private async backfillAll(): Promise<void> {
    try {
      for (const s of await this.uncage.sessions.list()) {
        if (!this.reps.has(s.id)) this.reps.set(s.id, this.newRep(0));
        void this.pump(s.id);
      }
    } catch (err) {
      this.log.error({ err, site: this.site.id }, 'backfill failed');
    }
  }

  /** Sends everything after the cursor, page by page, until caught up. One pump per session. */
  private async pump(sessionId: string): Promise<void> {
    const rep = this.reps.get(sessionId);
    if (!rep) return;
    if (rep.pumping) {
      rep.dirty = true;
      return;
    }
    rep.pumping = true;
    try {
      while (this.connected) {
        rep.dirty = false;
        const gen = rep.gen;
        const from = rep.sentHigh;
        let page: UncageEvent[];
        try {
          page = await this.uncage.events.readAfter(sessionId, from, READ_PAGE);
        } catch (err) {
          if (err instanceof UncageError && err.code === 'event_replay_unavailable') {
            // Retention pruned what the hub is missing: skip to what we still have.
            const { lastSequence } = await (await this.uncage.sessions.get(sessionId)).snapshot();
            this.log.warn({ site: this.site.id, sessionId, from, lastSequence }, 'events pruned before replication; skipping');
            rep.sentHigh = lastSequence;
            continue;
          }
          throw err;
        }
        if (rep.gen !== gen) continue;
        let failed = false;
        if (page.length === 0) {
          if (rep.dirty) continue;
          break;
        }
        for (const batch of this.pack(page)) {
          if (rep.gen !== gen || !this.connected) break;
          if (!(await this.sendBatch(sessionId, rep, batch))) {
            failed = true;
            break;
          }
        }
        // Not sendable right now: retried on the next event, ack or reconnect (no hot loop).
        if (failed) break;
      }
    } catch (err) {
      this.log.error({ err, site: this.site.id, sessionId }, 'replication failed');
    } finally {
      rep.pumping = false;
    }
  }

  /**
   * Splits events into frames under the size budget. An event too large for a frame on its own is
   * never skipped (that would leave a gap in the replica): its big string fields are truncated.
   */
  private pack(events: UncageEvent[]): UncageEvent[][] {
    const out: UncageEvent[][] = [];
    let cur: UncageEvent[] = [];
    let size = 200;
    for (const raw of events) {
      const e = this.fit(raw);
      const n = byteLength(JSON.stringify(e)) + 1;
      if (size + n > FRAME_BUDGET && cur.length > 0) {
        out.push(cur);
        cur = [];
        size = 200;
      }
      cur.push(e);
      size += n;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  private fit(e: UncageEvent): UncageEvent {
    const fitted = fitEvent(e, EVENT_BUDGET);
    if (fitted !== e) this.log.warn({ site: this.site.id, sessionId: e.sessionId, sequence: e.sequence }, 'event too large for one frame; replicated truncated');
    return fitted;
  }
}
