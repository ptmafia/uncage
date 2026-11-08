import { UncageError } from '@uncage/core/errors';
import {
  CONNECTED_PROTOCOL,
  MAX_FRAME_BYTES,
  SkillSpecSchema,
  type HubFrame,
  type SkillSpec,
  type ToolCallResult,
  type ToolSpec,
  type TransportKind,
  type TransportOffer,
  type UncageEvent,
} from '@uncage/protocol';
import { errorResponse } from '@uncage/server/wire';
import pkg from '../package.json' with { type: 'json' };
import { browserApi } from './browser-api.js';
import type { ClusterAdapter } from './cluster/cluster.js';
import { memoryCluster } from './cluster/memory.js';
import { deviceFlow, randomSecret } from './device.js';
import { DEFAULT_PULL_MAX_BYTES, DEFAULT_READ_MAX_BYTES, filePull } from './files.js';
import { httpTransport } from './http-transport.js';
import { assertVersionRange, defaultCliRange, installScript } from './install-script.js';
import { newNodeId } from './ids.js';
import { compareVersions, MachineHub, sessionChannel, type HubLogger } from './machines.js';
import { applyEvent, emptySnapshot, indexPatch } from './replica.js';
import { maintenance } from './maintenance.js';
import { storeRateLimiter } from './rate-limit.js';
import type { HubStore, MachineRecord, SessionRecord, ToolCallStatus, ToolResultFrame } from './store/store.js';
import { siteToolExecutor, toToolSpec, type ToolContext, type ToolExecutor } from './tools.js';
import { HUB_INTERNALS, type Hub, type HubOptions } from './types.js';
import { randomHex, sha256Hex, unrefTimer, utf8Length } from './web.js';

export const HUB_VERSION: string = pkg.version;

const DEFAULT_BASE_PATH = '/api/uncage';
/** Machine heartbeat defaults: a silent machine is offline within (missedPings + 1) × interval = 30 s. */
export const DEFAULT_HEARTBEAT = { pingIntervalMs: 10_000, missedPings: 2 } as const;
const DEFAULT_PING_MS = DEFAULT_HEARTBEAT.pingIntervalMs;
const DEFAULT_MISSED_PINGS = DEFAULT_HEARTBEAT.missedPings;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** Server-initiated rotation of the agent's HTTP stream (and, later, browser SSE). */
export const DEFAULT_STREAM_MAX_DURATION_MS = 250_000;
/** Adaptive outbox polling of an HTTP stream. */
export const DEFAULT_POLLING = { activeMs: 300, idleMs: 2_000, activeWindowMs: 30_000 } as const;
/** A tool call's inbox claim outlives its handler's timeout by this much. */
const TOOL_LEASE_GRACE_MS = 10_000;
/** How long a tool call for a run whose startRun result is still in flight waits for it. */
const DEFAULT_RUN_INDEX_WAIT_MS = 10_000;
/** Hub copies of attachments are deleted after this many days (`attachmentRetentionDays`). */
const DEFAULT_ATTACHMENT_RETENTION_DAYS = 30;
/** Maintenance (retention) at most this often across all instances (`maintenance.intervalMs`). */
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
/**
 * Finished inbox (upstream dedupe) rows are kept a day. An agent resends an unacknowledged upstream
 * message only while its link retries (minutes, bounded by its reconnect backoff and the outbox
 * expiry); a resend arriving after its dedupe row is gone would be processed twice, so this stays
 * far beyond that window.
 */
const INBOX_RETENTION_MS = 24 * 3_600_000;
const DEFAULT_USER_CODE_WINDOW_MS = 600_000;
const DEVICE_CODE_WINDOW_MS = 60_000;
/** Window of `rateLimits.agentAuthFailuresPerMinute`. */
const AGENT_AUTH_WINDOW_MS = 60_000;
/** Default `bodyTimeoutMs`. */
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
/** Rate-limit key when no client IP is known: one bucket for every caller. */
const SHARED_CLIENT_KEY = 'shared';
/** An unbound manifest (startRun never answered) is dropped after an hour. */
const UNBOUND_MANIFEST_TTL_MS = 3_600_000;
/**
 * A bound manifest is kept 7 days. The hub has no event-retention window to follow (replicated
 * events are kept), and a run still calling tools a week after it started is not a real case.
 */
const BOUND_MANIFEST_TTL_MS = 7 * 24 * 3_600_000;
/** A `tool_result` must fit one frame with room for the envelope. */
const TOOL_RESULT_BUDGET = MAX_FRAME_BYTES - 16 * 1024;
/** Tool arguments larger than this are not stored in the audit table. */
const MAX_AUDIT_ARGS_BYTES = 16 * 1024;
/**
 * `./a//b/` → `a/b`: the machine's file paths are workspace-relative with single forward slashes.
 * Paths that leave the workspace are refused here (the machine refuses them too).
 */
export function normalizeWorkspacePath(p: string): string {
  const refuse = () => new UncageError('invalid_request', { message: `"${p}" is not a path inside the session workspace.` });
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/')) throw refuse();
  // Resolve `.` and `..` segment by segment (like `posix.normalize`); climbing above the root is refused.
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) throw refuse();
      out.pop();
    } else out.push(seg);
  }
  if (out.length === 0) throw refuse();
  return out.join('/');
}

const RUN_END = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

/** Hooks not (yet) part of the public options: the tool executor seam and a logger. */
export interface HubInternals {
  toolExecutor?: ToolExecutor;
  /** See DEFAULT_RUN_INDEX_WAIT_MS (tests shorten it). */
  runIndexWaitMs?: number;
  /** Run-manifest retention (tests shorten it). */
  manifestSweep?: { unboundTtlMs?: number; boundTtlMs?: number };
  logger?: HubLogger;
}

const silent: HubLogger = { warn: () => undefined, error: () => undefined };

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

function siteDefaults(url: URL): { id: string; name: string } {
  const id = `${url.hostname}${url.port ? `-${url.port}` : ''}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  return { id, name: url.hostname };
}

export async function createHub(o: HubOptions & HubInternals): Promise<Hub> {
  let publicUrl: URL;
  try {
    publicUrl = new URL(o.publicUrl);
  } catch {
    throw new Error(`createHub: publicUrl must be an absolute http(s) URL (got "${o.publicUrl}")`);
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw new Error('createHub: publicUrl must be http(s)');
  const origin = publicUrl.origin;
  const basePath = `/${trimSlashes(o.basePath ?? DEFAULT_BASE_PATH)}`;
  const hubUrl = `${origin}${basePath}`;
  const minAgentVersion = o.minAgentVersion ?? HUB_VERSION;
  if (compareVersions(minAgentVersion, '0.0.0') < 0) throw new Error(`createHub: invalid minAgentVersion "${minAgentVersion}"`);
  const range = assertVersionRange(o.cliVersionRange ?? defaultCliRange(HUB_VERSION));
  const sessionStorage = o.sessionStorage ?? 'machine';
  const attachmentRetentionDays = o.attachmentRetentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS;
  if (!(attachmentRetentionDays > 0)) throw new Error(`createHub: attachmentRetentionDays must be > 0 (got ${attachmentRetentionDays})`);
  const logger = o.logger ?? silent;
  const executor = o.toolExecutor ?? siteToolExecutor(o.tools ?? []);
  const toolTimeoutMs = o.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const runIndexWaitMs = o.runIndexWaitMs ?? DEFAULT_RUN_INDEX_WAIT_MS;
  /** Site tool calls executing on this node; aborted when their run ends. */
  const activeCalls = new Set<{ machineId: string; runId: string; abort(): void }>();
  const defaults = siteDefaults(publicUrl);
  const site = { id: o.site?.id ?? defaults.id, name: o.site?.name ?? defaults.name, url: hubUrl };

  const tools = new Map<string, ToolSpec>();
  for (const t of o.tools ?? []) {
    const spec = toToolSpec(t);
    if (tools.has(spec.name)) throw new Error(`createHub: duplicate site tool "${spec.name}"`);
    tools.set(spec.name, spec);
  }
  const skills = new Map<string, SkillSpec>();
  for (const s of o.skills ?? []) {
    const r = SkillSpecSchema.safeParse(s);
    if (!r.success) throw new Error(`createHub: invalid skill "${s.name}": ${r.error.issues[0]?.message ?? 'bad shape'}`);
    if (skills.has(r.data.name)) throw new Error(`createHub: duplicate skill "${r.data.name}"`);
    skills.set(r.data.name, r.data);
  }

  if (!o.store) {
    throw new Error(
      'createHub: store is required (pgliteHubStore({ dataDir }) from @uncage/hub/node for one Node process, postgresHubStore for several nodes or serverless)',
    );
  }
  const store: HubStore = o.store;
  const ownsCluster = !o.cluster;
  const cluster: ClusterAdapter = o.cluster ?? memoryCluster();
  const nodeId = newNodeId();
  const shutdown = new AbortController();
  /** Set by `attachWebSocket`: this process serves machine WebSockets at this path. */
  let wsPath: string | undefined;
  if (o.transports !== undefined && (o.transports.length === 0 || o.transports.some((k) => k !== 'ws' && k !== 'http'))) {
    throw new Error(`createHub: transports must be a non-empty list of "ws" and "http" (got ${JSON.stringify(o.transports)})`);
  }
  const bodyTimeoutMs = o.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  if (!(bodyTimeoutMs > 0)) throw new Error(`createHub: bodyTimeoutMs must be > 0 (got ${bodyTimeoutMs})`);
  const streamMaxMs = o.stream?.maxDurationMs ?? DEFAULT_STREAM_MAX_DURATION_MS;
  if (!(streamMaxMs > 0)) throw new Error(`createHub: stream.maxDurationMs must be > 0 (got ${streamMaxMs})`);
  const polling = {
    activeMs: o.polling?.activeMs ?? DEFAULT_POLLING.activeMs,
    idleMs: o.polling?.idleMs ?? DEFAULT_POLLING.idleMs,
    activeWindowMs: o.polling?.activeWindowMs ?? DEFAULT_POLLING.activeWindowMs,
  };
  if (!(polling.activeMs > 0) || !(polling.idleMs >= polling.activeMs) || !(polling.activeWindowMs >= 0)) {
    throw new Error(`createHub: polling needs activeMs > 0, idleMs >= activeMs, activeWindowMs >= 0 (got ${JSON.stringify(polling)})`);
  }
  /**
   * What agents are offered (device token and `GET /agent/info`): `ws` when this process serves
   * WebSockets (`attachWebSocket`) or `transports` lists it; `http` (served by `fetch`) unless
   * `transports` leaves it out.
   */
  const transportOffers = (): [TransportOffer, ...TransportOffer[]] => {
    const kinds: TransportKind[] = o.transports ?? (wsPath ? ['ws', 'http'] : ['http']);
    const offers: TransportOffer[] = [];
    if (kinds.includes('ws')) offers.push({ kind: 'ws', url: `${origin.replace(/^http/, 'ws')}${wsPath ?? `${basePath}/agent`}` });
    if (kinds.includes('http')) offers.push({ kind: 'http', url: `${hubUrl}/agent` });
    return offers as [TransportOffer, ...TransportOffer[]];
  };

  const userCodeWindowMs = o.rateLimits?.userCodeWindowMs ?? DEFAULT_USER_CODE_WINDOW_MS;
  const device = deviceFlow({
    store,
    verificationUri: `${origin}/${trimSlashes(o.verificationPath ?? '/device')}`,
    site,
    transports: transportOffers,
    async createMachine({ userId, name, os, machineKeyHash }) {
      const machineToken = randomSecret();
      const now = new Date().toISOString();
      // Same machine re-paired by the same user: keep its id (and sessions), rotate its token.
      const known = machineKeyHash ? await store.findMachineByKey(userId, machineKeyHash) : null;
      if (known && (await store.rotateMachineToken(known.id, await sha256Hex(machineToken)))) {
        // A connection still using the old token must not outlive it.
        await machines.kick(known.id, 'replaced');
        return { machineId: known.id, machineToken };
      }
      const machineId = `mch_${randomHex(16)}`;
      await store.insertMachine({
        id: machineId,
        userId,
        tokenHash: await sha256Hex(machineToken),
        name: name ?? 'My computer',
        os: os ?? 'unknown',
        agentVersion: '0.0.0',
        runtimes: [],
        createdAt: now,
        lastSeenAt: now,
        ...(machineKeyHash ? { machineKeyHash } : {}),
      });
      return { machineId, machineToken };
    },
    limits: {
      userFailures: storeRateLimiter(store, { name: 'user_code', max: o.rateLimits?.userCodeFailures ?? 10, windowMs: userCodeWindowMs }),
      codesPerClient: storeRateLimiter(store, { name: 'device_code', max: o.rateLimits?.deviceCodesPerMinute ?? 20, windowMs: DEVICE_CODE_WINDOW_MS }),
    },
  });
  /** Rate-limit key: custom `clientIp` > `info.clientIp` > (opt-in) rightmost X-Forwarded-For > shared. */
  const clientKey = (req: Request, info?: { clientIp?: string }): string =>
    o.rateLimits?.clientIp?.(req) ||
    info?.clientIp ||
    (o.rateLimits?.trustForwardedFor ? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined) ||
    SHARED_CLIENT_KEY;
  let warnedSharedKey = false;

  /** Index (and in site mode replicate) events from `machine`; returns the events to fan out. */
  async function ingest(machine: MachineRecord, sessionId: string, events: UncageEvent[], send: (f: HubFrame) => void): Promise<UncageEvent[]> {
    if (events.length === 0) return [];
    let rec: SessionRecord | null = await store.getSession(sessionId);
    if (!rec && sessionStorage === 'site') {
      // Site mode replicates only sessions this hub created (recorded before createSession is sent).
      // No ack either: nothing is stored for it.
      logger.warn({ machineId: machine.id, sessionId }, 'events for a session the hub did not create ignored');
      return [];
    }
    if (!rec) {
      // Machine mode: index it so it can be listed (history stays on the machine).
      const created = events.find((e) => e.type === 'session.created');
      rec = await store.insertSession({
        id: sessionId,
        userId: machine.userId,
        machineId: machine.id,
        createdAt: created?.type === 'session.created' ? created.payload.session.createdAt : events[0]!.occurredAt,
        title: '',
        lastSequence: 0,
      });
    }
    // A machine may only report its own sessions.
    if (rec.machineId !== machine.id || rec.userId !== machine.userId) {
      logger.warn({ machineId: machine.id, sessionId }, 'events for a session owned by another machine dropped');
      return [];
    }

    let accepted = events;
    if (sessionStorage === 'site') {
      accepted = [];
      let next = rec.lastSequence;
      for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
        if (e.sequence === next + 1) {
          accepted.push(e);
          next = e.sequence;
        } else if (e.sequence > next + 1) break; // gap: the agent resends from the ack
      }
      if (accepted.length > 0) {
        const snapshot = accepted.reduce(applyEvent, rec.snapshot ?? emptySnapshot());
        const ok = await store.appendEvents(rec.id, rec.lastSequence, accepted, { ...indexPatch(rec, accepted), snapshot });
        if (!ok) {
          accepted = [];
          next = (await store.getSession(rec.id))?.lastSequence ?? rec.lastSequence;
        }
      }
      send({ t: 'ack', sessionId: rec.id, sequence: next });
    } else {
      const patch = indexPatch(rec, accepted);
      if (Object.keys(patch).length > 0) await store.updateSession(rec.id, patch);
    }

    for (const e of accepted) {
      if (e.type === 'run.started') await store.putResource(e.payload.run.id, 'run', rec.id);
      else if (e.type === 'approval.requested' || e.type === 'approval.updated' || e.type === 'approval.resolved') {
        await store.putResource(e.payload.approval.id, 'approval', rec.id);
      }
    }
    return accepted;
  }

  const machines = new MachineHub({
    store,
    cluster,
    nodeId,
    minAgentVersion,
    pingIntervalMs: o.heartbeat?.pingIntervalMs ?? DEFAULT_PING_MS,
    missedPings: o.heartbeat?.missedPings ?? DEFAULT_MISSED_PINGS,
    commandTimeoutMs: o.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxConcurrentToolCalls: o.maxConcurrentToolCalls ?? 8,
    logger,
    async onConnected(machine, send) {
      if (sessionStorage !== 'site') return;
      // Tell the agent where replication stands so it backfills what the hub is missing.
      for (const s of await store.listSessions(machine.userId)) {
        if (s.machineId === machine.id) send({ t: 'ack', sessionId: s.id, sequence: s.lastSequence });
      }
    },
    async onEvents(machine, sessionId, events, send) {
      // A run that ended abandons its pending tool calls (the machine no longer waits for them).
      for (const e of events) {
        if (!RUN_END.has(e.type) || !e.runId) continue;
        for (const call of activeCalls) if (call.machineId === machine.id && call.runId === e.runId) call.abort();
      }
      const out = await ingest(machine, sessionId, events, send);
      if (out.length > 0) await cluster.publish(sessionChannel(sessionId), JSON.stringify({ events: out }));
    },
    onToolCall: (machine, call, connSignal) => runToolCall(machine, call, connSignal),
  });

  /**
   * Executes one site tool call on this node (the one holding the machine's connection): ownership
   * re-check, execution with a timeout, frame-size check, audit row. Resolves `null` (send nothing)
   * when the call was abandoned because its run ended or the machine went away.
   */
  async function runToolCall(
    machine: MachineRecord,
    call: { id: string; sessionId: string; runId: string; tool: string; args: unknown },
    connSignal: AbortSignal,
  ): Promise<HubFrame | null> {
    const fail = (e: UncageError): ToolResultFrame => ({ t: 'tool_result', id: call.id, ok: false, error: e.toBody() });
    const rec = await store.getSession(call.sessionId);
    // The session must be this machine's, and its owner the machine's user (ctx.user).
    if (!rec || rec.machineId !== machine.id || rec.userId !== machine.userId) {
      return fail(new UncageError('not_found', { message: `Session ${call.sessionId} not found.` }));
    }
    // Only runs started through this hub, and only the tools their manifest offered. The startRun
    // result (which binds the run id) may still be in flight: wait for it briefly.
    let runTools = await store.getRunTools(call.runId);
    for (const until = Date.now() + runIndexWaitMs; !runTools && Date.now() < until && !connSignal.aborted; ) {
      await new Promise((r) => setTimeout(r, 50));
      runTools = await store.getRunTools(call.runId);
    }
    if (!runTools || runTools.sessionId !== rec.id) {
      return fail(new UncageError('not_found', { message: `Run ${call.runId} not found.`, details: { reason: 'run_not_indexed' } }));
    }
    if (!tools.has(call.tool) || !runTools.tools.includes(call.tool)) {
      return fail(new UncageError('tool_failed', { message: `Site tool "${call.tool}" is not available in this run.`, details: { reason: 'not_in_manifest' } }));
    }

    const ac = new AbortController();
    let why: 'timeout' | 'cancelled' | undefined;
    const abort = (reason: 'timeout' | 'cancelled') => {
      why ??= reason;
      ac.abort();
    };
    const entry = { machineId: machine.id, runId: call.runId, abort: () => abort('cancelled') };
    const onConnGone = () => abort('cancelled');
    connSignal.addEventListener('abort', onConnGone, { once: true });
    if (connSignal.aborted) abort('cancelled');
    activeCalls.add(entry);
    const timer = setTimeout(() => abort('timeout'), toolTimeoutMs);
    unrefTimer(timer);

    const auditId = `tcl_${randomHex(12)}`;
    const startedAt = Date.now();
    const argsJson = JSON.stringify(call.args ?? null);
    await store
      .insertToolCall({
        id: auditId,
        callId: call.id,
        sessionId: rec.id,
        runId: call.runId,
        userId: rec.userId,
        machineId: machine.id,
        tool: call.tool,
        args: utf8Length(argsJson) <= MAX_AUDIT_ARGS_BYTES ? (call.args ?? null) : null,
        status: 'running',
        startedAt: new Date(startedAt).toISOString(),
      })
      .catch((err: unknown) => logger.error({ err, tool: call.tool }, 'tool-call audit insert failed'));
    const finish = (status: ToolCallStatus, result: ToolResultFrame, err?: { code?: string; message?: string }) =>
      store
        .finishToolCall(auditId, {
          status,
          ...(err?.code ? { errorCode: err.code } : {}),
          ...(err?.message ? { errorMessage: err.message.slice(0, 2000) } : {}),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          result,
        })
        .catch((e: unknown) => logger.error({ err: e, tool: call.tool }, 'tool-call audit update failed'));

    const files: ToolContext['files'] = {
      pull: (raw, opts) =>
        filePull(async () => {
          const path = normalizeWorkspacePath(raw);
          const max = opts?.maxBytes ?? DEFAULT_PULL_MAX_BYTES;
          if (!Number.isInteger(max) || max < 1) throw new UncageError('invalid_request', { message: 'maxBytes must be a positive integer.' });
          return machines.pull(machine.id, rec.id, path, Math.min(max, DEFAULT_PULL_MAX_BYTES), ac.signal);
        }),
      read: async (raw) => {
        const path = normalizeWorkspacePath(raw);
        let r;
        try {
          r = await machines.pull(machine.id, rec.id, path, DEFAULT_READ_MAX_BYTES, ac.signal);
        } catch (err) {
          if (err instanceof UncageError && err.code === 'not_found') {
            throw new UncageError('not_found', { message: `"${path}" does not exist in the session workspace.` });
          }
          throw err;
        }
        const f = r.files.length === 1 && r.files[0]!.path === path ? r.files[0]! : undefined;
        if (!f) throw new UncageError('invalid_request', { message: `"${path}" is a directory, not a file.`, details: { reason: 'is_directory' } });
        return f.data;
      },
    };
    const abandoned = new Promise<never>((_, reject) =>
      ac.signal.addEventListener('abort', () => reject(new UncageError('tool_failed')), { once: true }),
    );
    abandoned.catch(() => undefined);
    try {
      const result: ToolCallResult = await Promise.race([
        executor.execute({ user: { id: rec.userId }, machineId: machine.id, sessionId: rec.id, runId: call.runId, tool: call.tool, args: call.args, callId: call.id }, { signal: ac.signal, files }),
        abandoned,
      ]);
      const frame: ToolResultFrame = { t: 'tool_result', id: call.id, ok: true, result };
      const bytes = utf8Length(JSON.stringify(frame));
      if (bytes > TOOL_RESULT_BUDGET) {
        const e = new UncageError('tool_failed', { message: `The result of site tool "${call.tool}" is too large (${bytes} bytes, max ${TOOL_RESULT_BUDGET}).` });
        await finish('error', fail(e), e);
        return fail(e);
      }
      await finish(result.isError ? 'error' : 'ok', frame);
      return frame;
    } catch (err) {
      if (why === 'cancelled') {
        await finish('cancelled', fail(new UncageError('tool_failed', { message: `Site tool "${call.tool}" was cancelled.` })));
        return null;
      }
      if (why === 'timeout') {
        const e = new UncageError('tool_failed', { message: `Site tool "${call.tool}" did not finish within ${Math.round(toolTimeoutMs / 1000)} s.` });
        await finish('timeout', fail(e), e);
        return fail(e);
      }
      const e = err instanceof UncageError ? err : new UncageError('tool_failed', { message: err instanceof Error ? err.message : String(err) });
      await finish(e.code === 'invalid_request' ? 'invalid' : 'error', fail(e), e);
      return fail(e);
    } finally {
      clearTimeout(timer);
      activeCalls.delete(entry);
      connSignal.removeEventListener('abort', onConnGone);
      ac.abort();
    }
  }
  const sweep = {
    unboundTtlMs: o.manifestSweep?.unboundTtlMs ?? UNBOUND_MANIFEST_TTL_MS,
    boundTtlMs: o.manifestSweep?.boundTtlMs ?? BOUND_MANIFEST_TTL_MS,
  };
  const maintenanceIntervalMs = o.maintenance?.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  if (!(maintenanceIntervalMs > 0)) throw new Error(`createHub: maintenance.intervalMs must be > 0 (got ${maintenanceIntervalMs})`);
  /** Rate-limit windows older than the longest window are dead. */
  const longestWindowMs = Math.max(DEVICE_CODE_WINDOW_MS, AGENT_AUTH_WINDOW_MS, userCodeWindowMs);
  /** No timer here (FaaS instances must not keep background work): requests, `attachWebSocket` or a cron run it. */
  const upkeep = maintenance({
    store,
    nodeId,
    intervalMs: maintenanceIntervalMs,
    logger,
    ...(o.maintenance?.onRun ? { onRun: o.maintenance.onRun } : {}),
    tasks: [
      async () => {
        const now = Date.now();
        return {
          runManifests: await store.pruneRunManifests({
            unboundBefore: new Date(now - sweep.unboundTtlMs).toISOString(),
            boundBefore: new Date(now - sweep.boundTtlMs).toISOString(),
          }),
        };
      },
      async (): Promise<Record<string, number>> =>
        Number.isFinite(attachmentRetentionDays)
          ? { attachments: await store.pruneAttachments(new Date(Date.now() - attachmentRetentionDays * 86_400_000).toISOString()) }
          : {},
      async () => {
        const now = Date.now();
        return store.pruneTransport({
          now: new Date(now).toISOString(),
          inboxBefore: new Date(now - INBOX_RETENTION_MS).toISOString(),
          rateLimitBeforeMs: now - longestWindowMs,
        });
      },
    ],
  });

  const agentTransport = httpTransport({
    store,
    cluster,
    machines,
    logger,
    minAgentVersion,
    agentInfo: () => ({ protocol: CONNECTED_PROTOCOL, minAgentVersion, transports: transportOffers() }),
    stream: { maxDurationMs: streamMaxMs },
    polling,
    pingIntervalMs: machines.heartbeat.pingIntervalMs,
    toolLeaseMs: toolTimeoutMs + TOOL_LEASE_GRACE_MS,
    shutdown: shutdown.signal,
    authFailures: storeRateLimiter(store, { name: 'agent_auth', max: o.rateLimits?.agentAuthFailuresPerMinute ?? 60, windowMs: AGENT_AUTH_WINDOW_MS }),
    bodyTimeoutMs,
  });

  const setupUrl = basePath === DEFAULT_BASE_PATH ? origin : hubUrl;
  const api = browserApi({
    store,
    minAgentVersion,
    cluster,
    machines,
    device,
    getUser: o.getUser,
    selectManifest: o.selectManifest ?? (async () => ({ tools: [...tools.keys()], skills: [...skills.keys()] })),
    tools,
    skills,
    sessionStorage,
    publicOrigin: origin,
    install: { install: `curl -fsSL ${hubUrl}/install.sh | bash`, setup: `uncage setup ${setupUrl}`, windows: null },
    installScript: installScript(range),
    maintenance: { secret: o.maintenance?.secret, run: () => upkeep.runNow() },
    version: HUB_VERSION,
    sseHeartbeatMs: o.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
    bodyTimeoutMs,
    shutdown: shutdown.signal,
  });

  let closing: Promise<void> | undefined;
  return {
    basePath,
    async fetch(req, info) {
      const requestId = `req_${randomHex(12)}`;
      try {
        const url = new URL(req.url);
        if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
          throw new UncageError('not_found', { message: `No route for ${req.method} ${url.pathname}.` });
        }
        const path = url.pathname.slice(basePath.length) || '/';
        // Opportunistic maintenance (the cron endpoint runs it itself). Never throws.
        if (path !== '/maintenance' && !shutdown.signal.aborted) await upkeep.maybeRun(info?.waitUntil?.bind(info));
        const key = clientKey(req, info);
        if (key === SHARED_CLIENT_KEY && path === '/device/code' && !warnedSharedKey) {
          warnedSharedKey = true;
          logger.warn(
            { path },
            'no client IP for per-IP rate limits: every caller shares one bucket, so one client can use up deviceCodesPerMinute for everyone. Pass info.clientIp to hub.fetch, set rateLimits.clientIp, or rateLimits.trustForwardedFor behind a proxy that appends X-Forwarded-For (e.g. Vercel).',
          );
        }
        // Machine routes (HTTP streaming transport) first, then the browser API.
        return (await agentTransport.handle(req, url, path, key)) ?? (await api.handle(req, url, path, requestId, key));
      } catch (err) {
        const uerr = err instanceof UncageError ? err : new UncageError('internal_error');
        if (!(err instanceof UncageError)) logger.error({ err, requestId }, 'hub request failed');
        return errorResponse(uerr.code, {
          message: uerr.message,
          ...(uerr.hint !== undefined ? { hint: uerr.hint } : {}),
          ...(uerr.details !== undefined ? { details: uerr.details } : {}),
          requestId,
        });
      }
    },
    approveDevice: (code, user) => device.approve(code, user),
    denyDevice: (code, user) => device.deny(code, user),
    lookupDevice: (code, user) => device.lookup(code, user),
    revokeMachine: (id, user) => api.revokeMachine(id, user),
    maintain: () => upkeep.runNow(),
    close: () =>
      (closing ??= (async () => {
        shutdown.abort();
        upkeep.stop();
        await upkeep.idle();
        await machines.close();
        if (ownsCluster) await cluster.close();
      })()),
    [HUB_INTERNALS]: {
      machines,
      basePath,
      logger,
      enableWebSocket(opts = {}) {
        wsPath = opts.path ?? `${basePath}/agent`;
        machines.enableWebSocket();
      },
      disableWebSocket() {
        wsPath = undefined;
      },
      heartbeat: machines.heartbeat,
      maintenance: { intervalMs: maintenanceIntervalMs },
    },
  };
}
