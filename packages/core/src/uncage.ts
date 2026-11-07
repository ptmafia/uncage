import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ActiveRunInfo,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CreateSessionBody,
  Run,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
  Session,
  SessionSettings,
  UncageEvent,
} from '@uncage/protocol';
import type { Logger } from 'pino';
import { ApprovalBridge } from './approvals.js';
import { AttachmentService, type AttachmentBody } from './attachments.js';
import { EventLog } from './event-log.js';
import { silentLog, type Log } from './logger.js';
import { AdapterRegistry } from './registry.js';
import { ACTIVE_RUN_STATES, RunManager } from './runs.js';
import { SessionService, type SessionHandle, type WorkspaceConfig } from './sessions.js';
import { applyPolicy, type SecurityPolicy } from './settings.js';
import { openPgliteStore } from './store/pglite-store.js';
import type { Store } from './store/store.js';
import { UncageError } from './errors.js';

export interface UncageOptions {
  adapters: RuntimeAdapter[];
  /** Custom persistence; defaults to `openPgliteStore({ dataDir })`. Closed by `close()`. */
  store?: Store;
  /** Defaults to `~/.uncage/data`; `'memory://'` keeps everything in memory. */
  dataDir?: string;
  /** Defaults: `allowedRoots: [process.cwd()]`, `default: process.cwd()`. */
  workspace?: { allowedRoots?: string[]; default?: string };
  /** `ttlMs` defaults to 600_000. */
  approvals?: { ttlMs?: number };
  /** Defaults to 7. */
  eventRetentionDays?: number;
  /** `allowBypass` (default false) enables the `bypassPermissions` permission mode. */
  security?: { allowBypass?: boolean };
  logger?: Logger;
  /**
   * Sees every committed event of every session (e.g. to replicate them elsewhere), in sequence
   * order per session, synchronously after commit. Keep it cheap and non-blocking; a throwing
   * listener is logged and never affects the run.
   */
  onEvent?(e: UncageEvent): void;
}

export interface Uncage {
  runtimes: { list(): Promise<RuntimeInfo[]>; get(id: string): Promise<RuntimeInfo> };
  sessions: {
    create(b: CreateSessionBody): Promise<SessionHandle>;
    get(id: string): Promise<SessionHandle>;
    list(): Promise<Session[]>;
    /** Validated against the policy and the runtime's capabilities; emits `session.updated`. */
    updateSettings(id: string, patch: Partial<SessionSettings>): Promise<Session>;
  };
  attachments: {
    /** `body` may be a byte array or a stream (e.g. a Node request); stored under the session workspace. */
    add(sessionId: string, input: { name: string; mime: string; body: AttachmentBody }): Promise<Attachment>;
    get(id: string): Promise<{ attachment: Attachment; absPath: string }>;
    /** Deletes attachments never sent with a run and created before `olderThan`. */
    pruneOrphans(olderThan: Date): Promise<number>;
  };
  runs: {
    get(id: string): Promise<Run>;
    cancel(id: string): Promise<Run>;
    /** Active runs across all sessions, newest first. */
    listActive(): Promise<ActiveRunInfo[]>;
  };
  approvals: {
    list(q: { sessionId: string; pendingOnly?: boolean }): Promise<ApprovalRequest[]>;
    decide(id: string, d: ApprovalDecision, idempotencyKey: string): Promise<ApprovalRequest>;
  };
  events: {
    /**
     * At most `limit` (default 500, max 1000) committed events of the session with sequence > `after`,
     * in sequence order: a page for catch-up / replication. `not_found` for an unknown session;
     * `event_replay_unavailable` when retention already pruned part of the range.
     */
    readAfter(sessionId: string, after: number, limit?: number): Promise<UncageEvent[]>;
  };
  /** The resolved workspace config: new sessions default to `default`, all live under `allowedRoots`. */
  readonly workspace: { readonly default: string; readonly allowedRoots: readonly string[] };
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_ATTACHMENT_MS = DAY_MS;

export async function createUncage(opts: UncageOptions): Promise<Uncage> {
  const logger: Log = opts.logger ?? silentLog;
  const policy: SecurityPolicy = { allowBypass: opts.security?.allowBypass === true };
  const registry = new AdapterRegistry(opts.adapters, policy);
  const store = opts.store ?? (await openPgliteStore({ dataDir: opts.dataDir ?? join(homedir(), '.uncage', 'data') }));
  const onEvent = opts.onEvent;
  const log = new EventLog(store, onEvent ? (e) => onEvent(e) : undefined, logger);
  const bridge = new ApprovalBridge(store, log, opts.approvals?.ttlMs ?? DEFAULT_TTL_MS, logger);
  const cwd = process.cwd();
  const workspace: WorkspaceConfig = {
    allowedRoots: opts.workspace?.allowedRoots ?? [cwd],
    default: opts.workspace?.default ?? cwd,
  };
  registry.onCapabilities = (runtimeId, caps) =>
    refreshSessionCapabilities(store, log, runtimeId, caps).catch((e: unknown) =>
      logger.error({ err: e, runtime: runtimeId }, 'failed to refresh session capabilities'),
    );
  const runs = new RunManager(store, log, bridge, registry, logger, workspace, policy);
  const sessions = new SessionService(store, log, registry, runs, workspace, policy);
  const attachments = new AttachmentService(
    store,
    workspace,
    async (sessionId) => {
      const s = await store.getSession(sessionId);
      if (!s) throw new UncageError('not_found', { message: `Session ${sessionId} not found.` });
      return registry.find(s.runtimeId) ? registry.capabilities(s.runtimeId) : s.capabilities;
    },
    logger,
  );

  const retentionMs = (opts.eventRetentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  const prune = async () => {
    const n = await store.pruneEvents(new Date(Date.now() - retentionMs));
    if (n > 0) logger.info({ pruned: n }, 'pruned old events');
    const a = await attachments.pruneOrphans(new Date(Date.now() - ORPHAN_ATTACHMENT_MS));
    if (a > 0) logger.info({ pruned: a }, 'pruned unsent attachments');
  };

  try {
    await reconcile(store, log, registry, logger, policy);
    await prune();
  } catch (e) {
    await store.close().catch(() => undefined);
    throw e;
  }
  const pruneTimer = setInterval(() => {
    prune().catch((e: unknown) => logger.error({ err: e }, 'retention pruning failed'));
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let closing: Promise<void> | undefined;
  return {
    workspace: { default: workspace.default, allowedRoots: [...workspace.allowedRoots] },
    runtimes: { list: () => registry.list(), get: (id) => registry.info(id) },
    sessions: {
      create: (b) => sessions.create(b),
      get: (id) => sessions.get(id),
      list: () => sessions.list(),
      updateSettings: (id, patch) => sessions.updateSettings(id, patch),
    },
    attachments: {
      add: (sessionId, input) => attachments.add(sessionId, input),
      get: (id) => attachments.get(id),
      pruneOrphans: (olderThan) => attachments.pruneOrphans(olderThan),
    },
    events: {
      readAfter: async (sessionId, after, limit) => {
        if (!(await store.getSession(sessionId))) {
          throw new UncageError('not_found', { message: `Session ${sessionId} not found.` });
        }
        return log.readAfter(sessionId, after, limit);
      },
    },
    runs: { get: (id) => runs.get(id), cancel: (id) => runs.cancel(id), listActive: () => runs.listActive() },
    approvals: {
      list: (q) =>
        store.listApprovals({ sessionId: q.sessionId, ...(q.pendingOnly ? { states: ['pending', 'submitting'] } : {}) }),
      decide: (id, d, key) => bridge.decide(id, d, key),
    },
    close: () =>
      (closing ??= (async () => {
        clearInterval(pruneTimer);
        await runs.closeAll();
        bridge.close();
        await log.drain();
        await registry.dispose();
        await store.close();
      })()),
  };
}

/**
 * Startup reconciliation: native callbacks and adapter iterators do not survive a restart, so
 * open approvals become `expired` and unfinished runs `interrupted` (reason `server_restart`).
 * When the policy no longer allows bypass, sessions stop advertising it and leave bypass mode.
 */
/** Equality as stored (jsonb drops `undefined` and reorders keys). */
const sameCaps = (a: RuntimeCapabilities, b: RuntimeCapabilities) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

/** Brings every open session of `runtimeId` up to date with freshly probed capabilities. */
async function refreshSessionCapabilities(
  store: Store,
  log: EventLog,
  runtimeId: string,
  capabilities: RuntimeCapabilities,
): Promise<void> {
  for (const s of await store.listSessions()) {
    if (s.runtimeId !== runtimeId || s.status === 'closed' || sameCaps(s.capabilities, capabilities)) continue;
    const session = await store.updateSession(s.id, { capabilities });
    await log.append(s.id, 'session.updated', { session });
  }
}

async function reconcile(
  store: Store,
  log: EventLog,
  registry: AdapterRegistry,
  logger: Log,
  policy: SecurityPolicy,
): Promise<void> {
  const sessions = await store.listSessions();
  for (const s of sessions) {
    for (const a of await store.listApprovals({ sessionId: s.id, states: ['pending', 'submitting'] })) {
      const next = await store.casApproval(a.id, { state: a.state, version: a.version }, { state: 'expired', version: a.version + 1 });
      if (next) await log.append(s.id, 'approval.updated', { approval: next }, next.runId);
    }
  }
  const stale = await store.listRunsInState(ACTIVE_RUN_STATES);
  for (const r of stale) {
    await store.updateRun(r.id, { state: 'interrupted', endedAt: new Date().toISOString() });
    await log.append(r.sessionId, 'run.interrupted', { runId: r.id, reason: 'server_restart' }, r.id);
  }
  if (stale.length > 0) logger.warn({ runs: stale.length }, 'interrupted runs left over from a previous process');

  for (const { id } of sessions) {
    const s = await store.getSession(id);
    if (!s || s.status === 'closed') continue;
    const adapter = registry.find(s.runtimeId);
    const readOnly = s.readOnly || (s.nativeSessionRef !== undefined && adapter?.capabilities().nativeResume === false);
    const status = adapter ? 'ready' : 'unavailable';
    if (s.status !== status || s.readOnly !== readOnly || s.activeRunId !== undefined) {
      await store.updateSession(id, { status, readOnly, activeRunId: undefined });
    }
    // Stored capabilities follow the runtime and the current policy (e.g. a restart that turns
    // allowBypass on or off); a session left in bypass leaves it when the policy forbids it.
    const capabilities = adapter ? registry.staticCapabilities(s.runtimeId) : applyPolicy(s.capabilities, policy);
    const leaveBypass = s.settings.permissionMode === 'bypassPermissions' && !policy.allowBypass;
    if (!sameCaps(capabilities, s.capabilities) || leaveBypass) {
      const settings = leaveBypass ? { ...s.settings, permissionMode: 'default' as const } : s.settings;
      const session = await store.updateSession(id, { capabilities, settings });
      await log.append(id, 'session.updated', { session });
      if (leaveBypass) logger.warn({ sessionId: id }, 'bypass permissions disabled by policy; session reset to default');
    }
  }
  await log.drain();
}
