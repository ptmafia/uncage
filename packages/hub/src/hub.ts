import { randomBytes } from 'node:crypto';
import { UncageError } from '@uncage/core';
import { SkillSpecSchema, type HubFrame, type SkillSpec, type ToolSpec, type UncageEvent } from '@uncage/protocol';
import { errorResponse } from '@uncage/server/wire';
import pkg from '../package.json' with { type: 'json' };
import { browserApi } from './browser-api.js';
import type { ClusterAdapter } from './cluster/cluster.js';
import { memoryCluster } from './cluster/memory.js';
import { deviceFlow, randomSecret, sha256 } from './device.js';
import { assertVersionRange, defaultCliRange, installScript } from './install-script.js';
import { compareVersions, MachineHub, sessionChannel, type HubLogger } from './machines.js';
import { applyEvent, emptySnapshot, indexPatch } from './replica.js';
import { SlidingWindow } from './rate-limit.js';
import { pgliteHubStore } from './store/pglite.js';
import type { HubStore, MachineRecord, SessionRecord } from './store/store.js';
import { notImplementedToolExecutor, toToolSpec, type ToolExecutor } from './tools.js';
import type { Hub, HubOptions } from './types.js';

export const HUB_VERSION: string = pkg.version;

const DEFAULT_BASE_PATH = '/api/uncage';
/** Machine heartbeat defaults: a silent machine is offline within (missedPings + 1) × interval = 30 s. */
export const DEFAULT_HEARTBEAT = { pingIntervalMs: 10_000, missedPings: 2 } as const;
const DEFAULT_PING_MS = DEFAULT_HEARTBEAT.pingIntervalMs;
const DEFAULT_MISSED_PINGS = DEFAULT_HEARTBEAT.missedPings;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Hooks not (yet) part of the public options: the tool executor seam and a logger. */
export interface HubInternals {
  toolExecutor?: ToolExecutor;
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
  const logger = o.logger ?? silent;
  const executor = o.toolExecutor ?? notImplementedToolExecutor;
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

  const ownsStore = !o.store;
  const ownsCluster = !o.cluster;
  const store: HubStore = o.store ?? (await pgliteHubStore({ dataDir: './.uncage-hub' }));
  const cluster: ClusterAdapter = o.cluster ?? memoryCluster();
  const nodeId = `node_${randomBytes(8).toString('hex')}`;
  const shutdown = new AbortController();

  const device = deviceFlow({
    store,
    verificationUri: `${origin}/${trimSlashes(o.verificationPath ?? '/device')}`,
    site,
    async createMachine({ userId, name, os, machineKeyHash }) {
      const machineToken = randomSecret();
      const now = new Date().toISOString();
      // Same machine re-paired by the same user: keep its id (and sessions), rotate its token.
      const known = machineKeyHash ? await store.findMachineByKey(userId, machineKeyHash) : null;
      if (known && (await store.rotateMachineToken(known.id, sha256(machineToken)))) {
        // A connection still using the old token must not outlive it.
        await machines.kick(known.id, 'replaced');
        return { machineId: known.id, machineToken };
      }
      const machineId = `mch_${randomBytes(16).toString('hex')}`;
      await store.insertMachine({
        id: machineId,
        userId,
        tokenHash: sha256(machineToken),
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
      userFailures: new SlidingWindow(o.rateLimits?.userCodeFailures ?? 10, o.rateLimits?.userCodeWindowMs ?? 600_000),
      codesPerClient: new SlidingWindow(o.rateLimits?.deviceCodesPerMinute ?? 20, 60_000),
    },
  });
  /** Rate-limit key: custom `clientIp` > `info.clientIp` > (opt-in) rightmost X-Forwarded-For > shared. */
  const clientKey = (req: Request, info?: { clientIp?: string }): string =>
    o.rateLimits?.clientIp?.(req) ||
    info?.clientIp ||
    (o.rateLimits?.trustForwardedFor ? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined) ||
    'shared';

  /** Index (and in site mode replicate) events from `machine`; returns the events to fan out. */
  async function ingest(machine: MachineRecord, sessionId: string, events: UncageEvent[], send: (f: HubFrame) => void): Promise<UncageEvent[]> {
    if (events.length === 0) return [];
    let rec: SessionRecord | null = await store.getSession(sessionId);
    if (!rec) {
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
    logger,
    async onConnected(machine, send) {
      if (sessionStorage !== 'site') return;
      // Tell the agent where replication stands so it backfills what the hub is missing.
      for (const s of await store.listSessions(machine.userId)) {
        if (s.machineId === machine.id) send({ t: 'ack', sessionId: s.id, sequence: s.lastSequence });
      }
    },
    async onEvents(machine, sessionId, events, send) {
      const out = await ingest(machine, sessionId, events, send);
      if (out.length > 0) await cluster.publish(sessionChannel(sessionId), JSON.stringify({ events: out }));
    },
    async onToolCall(machine, call) {
      const rec = await store.getSession(call.sessionId);
      if (!rec || rec.machineId !== machine.id) {
        return { t: 'tool_result', id: call.id, ok: false, error: new UncageError('not_found', { message: `Session ${call.sessionId} not found.` }).toBody() };
      }
      if (!tools.has(call.tool)) {
        return { t: 'tool_result', id: call.id, ok: false, error: new UncageError('tool_failed', { message: `Unknown site tool "${call.tool}".` }).toBody() };
      }
      try {
        const result = await executor.execute({
          user: { id: rec.userId },
          machineId: machine.id,
          sessionId: rec.id,
          runId: call.runId,
          tool: call.tool,
          args: call.args,
        });
        return { t: 'tool_result', id: call.id, ok: true, result };
      } catch (err) {
        const uerr = err instanceof UncageError ? err : new UncageError('tool_failed');
        return { t: 'tool_result', id: call.id, ok: false, error: uerr.toBody() };
      }
    },
  });
  await machines.start();

  const setupUrl = basePath === DEFAULT_BASE_PATH ? origin : hubUrl;
  const api = browserApi({
    store,
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
    version: HUB_VERSION,
    sseHeartbeatMs: o.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
    shutdown: shutdown.signal,
  });

  let closing: Promise<void> | undefined;
  return {
    basePath,
    async handler(req, info) {
      const requestId = `req_${randomBytes(12).toString('hex')}`;
      try {
        const url = new URL(req.url);
        if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
          throw new UncageError('not_found', { message: `No route for ${req.method} ${url.pathname}.` });
        }
        return await api.handle(req, url, url.pathname.slice(basePath.length) || '/', requestId, clientKey(req, info));
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
    attach(server, opts = {}) {
      machines.attach(server, opts.path ?? `${basePath}/agent`);
    },
    approveDevice: (code, user) => device.approve(code, user),
    denyDevice: (code, user) => device.deny(code, user),
    lookupDevice: (code, user) => device.lookup(code, user),
    revokeMachine: (id, user) => api.revokeMachine(id, user),
    close: () =>
      (closing ??= (async () => {
        shutdown.abort();
        await machines.close();
        if (ownsCluster) await cluster.close();
        if (ownsStore) await store.close();
      })()),
  };
}
