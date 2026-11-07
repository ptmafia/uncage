import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createUncage, UncageError, type CallTool, type Uncage } from '@uncage/core';
import {
  CONNECTED_PROTOCOL,
  HubCommandArgsSchemas,
  MAX_FRAME_BYTES,
  newId,
  parseHubFrame,
  type AgentFrame,
  type ErrorBody,
  type HubCommandArgs,
  type HubCommandOp,
  type HubFrame,
  type PermissionMode,
  type RuntimeAdapter,
  type ToolCallResult,
  type UncageEvent,
} from '@uncage/protocol';
import { WebSocket } from 'ws';
import { ActivityLog } from './activity.js';
import { siteDir, type AgentConfig, type AgentSite } from './config.js';
import { agentWsUrl } from './device.js';
import { planPull, sendPull } from './files.js';
import { fitEvent } from './fit.js';

/** Close codes the hub uses (see @uncage/hub machines.ts). */
export const HUB_CLOSE = { revoked: 4401, replaced: 4409, upgrade: 4426, hubTooOld: 4505 } as const;

export interface AgentLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AgentTiming {
  /** Reconnect backoff: starts here, doubles per failed attempt (with jitter). Default 1 000. */
  backoffMinMs: number;
  /** Default 30 000. */
  backoffMaxMs: number;
  /** A `tool_call` without `tool_result` fails with `tool_failed` after this. Default 120 000. */
  toolTimeoutMs: number;
  /** No frame from the hub for this long → the connection is presumed dead. Default 35 000 (hub pings every 10 s). */
  idleTimeoutMs: number;
  /** The backoff only resets after a connection stayed up this long. Default 30 000. */
  stableMs: number;
  /** A chunked attachment upload with no frame for this long is dropped. Default 60 000. */
  uploadIdleMs: number;
}

export const DEFAULT_TIMING: AgentTiming = {
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  toolTimeoutMs: 120_000,
  idleTimeoutMs: 35_000,
  stableMs: 30_000,
  uploadIdleMs: 60_000,
};

/** Most chunked attachment uploads in progress at once (per site). */
const MAX_UPLOADS = 8;

/** Exponential backoff with jitter: a random delay in [base/2, base], base = min(max, min·2^attempt). */
export function backoffDelay(attempt: number, t: Pick<AgentTiming, 'backoffMinMs' | 'backoffMaxMs'>, random = Math.random): number {
  const base = Math.min(t.backoffMaxMs, t.backoffMinMs * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + random() * (base / 2));
}

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
  resolve(r: ToolCallResult): void;
  reject(e: unknown): void;
}

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
 * (`~/Uncage/<siteHost>/`), activity log and one WebSocket to its hub.
 *
 * Replication: every committed event is sent in an `events` frame as soon as the connection is up
 * (after `welcome`). Per session the agent keeps a cursor. A hub that keeps a replica ("site"
 * storage) acks each batch and, on connect, the last sequence it has for every session; an ack
 * that reveals a gap (lower than what was sent, with no batch in flight that would fill it) rewinds
 * the cursor and the agent resends from there. Since the hub only accepts `lastSequence + 1`
 * onward, resends never duplicate. A hub without a replica never acks; there the cursor is "sent
 * while connected", and events produced while offline are sent after the next `welcome`.
 */
export class SiteAgent {
  readonly site: AgentSite;
  private uncage!: Uncage;
  private activity: ActivityLog;
  private root: string;
  private ws: WebSocket | undefined;
  private connected = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly reps = new Map<string, Rep>();
  private acksOnConn = false;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly pulls = new Set<AbortController>();
  private readonly uploads = new Map<string, Upload>();
  private upgradeMin: string | undefined;
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
    const ws = this.ws;
    if (ws) {
      ws.close(1000, 'agent shutting down');
      setTimeout(() => ws.terminate(), 500).unref();
    }
    await this.loopDone;
    await this.uncage?.close();
    await this.activity.flush();
  }

  // ---- connection -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const r = await this.connectOnce();
      if (this.stopped) return;
      if (r.stop === 'upgrade') {
        // Resolves only if the upgrade did not happen (on success the process exits): this site
        // stays offline until the retry time, the other sites keep running.
        const retryInMs = await this.o.onUpgradeRequired(this.upgradeMin);
        if (this.stopped) return;
        this.upgradeMin = undefined;
        this.state = 'upgrade_failed';
        this.log.warn({ site: this.site.id, retryInMs }, 'staying disconnected until the upgrade can be retried');
        await this.sleep(retryInMs);
        if (!this.stopped) this.state = 'connecting';
        attempt = 0;
        continue;
      }
      if (r.stop) {
        this.stopped = true;
        this.state = r.stop;
        this.o.onStop(r.stop);
        return;
      }
      // Only a connection that stayed up resets the backoff (a hub that accepts then drops at once
      // must not be hammered every second).
      if (r.upMs >= this.o.timing.stableMs) attempt = 0;
      const delay = backoffDelay(attempt++, this.o.timing);
      this.log.info({ site: this.site.id, delayMs: delay }, 'reconnecting');
      await this.sleep(delay);
    }
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

  private connectOnce(): Promise<{ welcomed: boolean; upMs: number; stop?: Exclude<SiteStop, 'closed'> }> {
    return new Promise((resolve) => {
      let welcomed = false;
      let welcomedAt = 0;
      const done = (r: { welcomed: boolean; stop?: Exclude<SiteStop, 'closed'> }) =>
        resolve({ ...r, upMs: welcomedAt ? Date.now() - welcomedAt : 0 });
      let httpStatus: number | undefined;
      let idle: NodeJS.Timeout | undefined;
      let ws: WebSocket;
      try {
        ws = new WebSocket(agentWsUrl(this.site.url), {
          headers: { authorization: `Bearer ${this.site.token}` },
          maxPayload: MAX_FRAME_BYTES,
          handshakeTimeout: 15_000,
        });
      } catch (err) {
        this.log.error({ err, site: this.site.id }, 'cannot connect');
        done({ welcomed: false });
        return;
      }
      this.ws = ws;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          this.log.warn({ site: this.site.id }, 'no frames from the hub; reconnecting');
          ws.terminate();
        }, this.o.timing.idleTimeoutMs);
        idle.unref();
      };

      ws.on('unexpected-response', (req, res) => {
        httpStatus = res.statusCode;
        res.resume();
        req.destroy();
        ws.terminate();
      });
      ws.on('error', (err) => {
        if (httpStatus === undefined) this.log.warn({ site: this.site.id, err: err.message }, 'connection error');
      });
      ws.on('open', () => {
        armIdle();
        void this.hello(ws);
      });
      ws.on('message', (data) => {
        armIdle();
        let frame: HubFrame;
        try {
          frame = parseHubFrame(data.toString());
        } catch (err) {
          this.log.warn({ site: this.site.id, err: (err as Error).message }, 'malformed frame from hub');
          return;
        }
        if (frame.t === 'welcome') {
          welcomed = true;
          welcomedAt = Date.now();
          this.onWelcome(ws);
        } else this.onFrame(ws, frame);
      });
      ws.on('close', (code, reason) => {
        clearTimeout(idle);
        const wasConnected = welcomed;
        if (this.ws === ws) {
          this.ws = undefined;
          this.onDisconnect();
        }
        if (wasConnected) void this.activity.append({ kind: 'disconnected', detail: { code } });
        if (httpStatus === 401 || code === HUB_CLOSE.revoked) {
          this.log.warn({ site: this.site.id }, 'machine token revoked by the website; not reconnecting');
          void this.activity.append({ kind: 'revoked' });
          return done({ welcomed, stop: 'revoked' });
        }
        if (code === HUB_CLOSE.replaced) {
          this.log.warn({ site: this.site.id }, 'replaced by a newer connection for this machine; stopping this one');
          void this.activity.append({ kind: 'replaced' });
          return done({ welcomed, stop: 'replaced' });
        }
        if (code === HUB_CLOSE.upgrade || this.upgradeMin) {
          void this.activity.append({ kind: 'upgrade', detail: { minAgentVersion: this.upgradeMin ?? 'unknown' } });
          return done({ welcomed, stop: 'upgrade' });
        }
        if (code === HUB_CLOSE.hubTooOld) this.log.warn({ site: this.site.id }, 'this website runs an older hub than the agent supports');
        else if (httpStatus !== undefined) this.log.warn({ site: this.site.id, status: httpStatus }, 'hub refused the connection');
        else this.log.info({ site: this.site.id, code, reason: reason.toString().slice(0, 200) }, 'disconnected');
        done({ welcomed });
      });
    });
  }

  private async hello(ws: WebSocket): Promise<void> {
    const runtimes = await this.uncage.runtimes.list().catch(() => []);
    if (ws.readyState !== WebSocket.OPEN) return;
    this.rawSend(ws, {
      t: 'hello',
      protocol: CONNECTED_PROTOCOL,
      agentVersion: this.o.agentVersion,
      machine: { name: this.o.machine.name, os: this.o.machine.os, runtimes },
    });
  }

  private onWelcome(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.connected = true;
    this.state = 'connected';
    this.acksOnConn = false;
    this.log.info({ site: this.site.id }, 'connected');
    void this.activity.append({ kind: 'connected' });
    for (const rep of this.reps.values()) {
      rep.sentHigh = rep.delivered;
      rep.outstanding = [];
      rep.gen++;
    }
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
    const lost = new UncageError('tool_failed', { message: 'The connection to the website was lost.' });
    for (const p of this.pendingTools.values()) p.reject(lost);
    this.pendingTools.clear();
    for (const ac of this.pulls) ac.abort();
    for (const u of this.uploads.values()) u.stream.fail(new UncageError('machine_offline', { message: 'The connection to the website was lost during the upload.' }));
  }

  private rawSend(ws: WebSocket, f: AgentFrame): Promise<void> {
    const raw = JSON.stringify(f);
    if (byteLength(raw) > MAX_FRAME_BYTES) return Promise.reject(new Error(`frame "${f.t}" too large`));
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new UncageError('machine_offline'));
      ws.send(raw, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Sends on the current, welcomed connection. */
  private send(f: AgentFrame): Promise<void> {
    if (!this.connected || !this.ws) return Promise.reject(new UncageError('machine_offline'));
    return this.rawSend(this.ws, f);
  }

  private onFrame(ws: WebSocket, f: HubFrame): void {
    if (f.t === 'upgrade_required') {
      this.upgradeMin = f.minAgentVersion;
      this.log.warn({ site: this.site.id, minAgentVersion: f.minAgentVersion }, 'the website requires a newer agent');
      return;
    }
    if (this.ws !== ws || !this.connected) return;
    switch (f.t) {
      case 'ping':
        void this.send({ t: 'pong', at: f.at }).catch(() => undefined);
        return;
      case 'command':
        void this.onCommand(f.id, f.op, f.args);
        return;
      case 'ack':
        this.onAck(f.sessionId, f.sequence);
        return;
      case 'tool_result': {
        const p = this.pendingTools.get(f.id);
        if (!p) return;
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
    let frame: AgentFrame;
    const parsed = HubCommandArgsSchemas[op].safeParse(rawArgs);
    if (!parsed.success) {
      const err = new UncageError('invalid_request', { message: `Invalid ${op} arguments: ${parsed.error.issues[0]?.message ?? 'bad shape'}` });
      void this.activity.append({ kind: 'command', name: op, ok: false, code: err.code });
      frame = { t: 'result', id, ok: false, error: err.toBody() };
    } else {
      try {
        const data = await this.execute(op, parsed.data as HubCommandArgs[typeof op]);
        frame = { t: 'result', id, ok: true, data };
        void this.activity.append({ kind: 'command', name: op, ok: true, detail: this.activityArgs(op, parsed.data) });
      } catch (err) {
        const body = errorBody(err);
        if (body.code === 'internal_error') this.log.error({ err, site: this.site.id, op }, 'command failed');
        void this.activity.append({ kind: 'command', name: op, ok: false, code: body.code, detail: this.activityArgs(op, parsed.data) });
        frame = { t: 'result', id, ok: false, error: body };
      }
    }
    await this.sendResult(frame).catch((err: unknown) => this.log.warn({ site: this.site.id, op, err: (err as Error).message }, 'could not send result'));
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
        const id = newId('ses');
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

  private readonly callTool: CallTool = (tool, args, ctx) =>
    new Promise<ToolCallResult>((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new UncageError('tool_failed', { message: 'The run was cancelled.' }));
      if (!this.connected) {
        void this.activity.append({ kind: 'tool_call', name: tool, ok: false, code: 'machine_offline', detail: { sessionId: ctx.sessionId, runId: ctx.runId } });
        return reject(new UncageError('tool_failed', { message: 'The website is not connected.' }));
      }
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
      this.pendingTools.set(id, {
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
      });
      this.send({ t: 'tool_call', id, sessionId: ctx.sessionId, runId: ctx.runId, tool, args }).catch((e: unknown) =>
        this.pendingTools.get(id)?.reject(new UncageError('tool_failed', { message: `Could not reach the website: ${(e as Error).message}` })),
      );
    });

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
    if (!this.connected || !this.ws || events.length === 0) return Promise.resolve(false);
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
