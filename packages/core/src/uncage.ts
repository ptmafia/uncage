import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionBody,
  Run,
  RuntimeAdapter,
  RuntimeInfo,
  Session,
} from '@uncage/protocol';
import type { Logger } from 'pino';
import { ApprovalBridge } from './approvals.js';
import { EventLog } from './event-log.js';
import { silentLog, type Log } from './logger.js';
import { AdapterRegistry } from './registry.js';
import { ACTIVE_RUN_STATES, RunManager } from './runs.js';
import { SessionService, type SessionHandle, type WorkspaceConfig } from './sessions.js';
import { openPgliteStore } from './store/pglite-store.js';
import type { Store } from './store/store.js';

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
  logger?: Logger;
}

export interface Uncage {
  runtimes: { list(): Promise<RuntimeInfo[]>; get(id: string): Promise<RuntimeInfo> };
  sessions: {
    create(b: CreateSessionBody): Promise<SessionHandle>;
    get(id: string): Promise<SessionHandle>;
    list(): Promise<Session[]>;
  };
  runs: { get(id: string): Promise<Run>; cancel(id: string): Promise<Run> };
  approvals: {
    list(q: { sessionId: string; pendingOnly?: boolean }): Promise<ApprovalRequest[]>;
    decide(id: string, d: ApprovalDecision, idempotencyKey: string): Promise<ApprovalRequest>;
  };
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function createUncage(opts: UncageOptions): Promise<Uncage> {
  const logger: Log = opts.logger ?? silentLog;
  const registry = new AdapterRegistry(opts.adapters);
  const store = opts.store ?? (await openPgliteStore({ dataDir: opts.dataDir ?? join(homedir(), '.uncage', 'data') }));
  const log = new EventLog(store);
  const bridge = new ApprovalBridge(store, log, opts.approvals?.ttlMs ?? DEFAULT_TTL_MS, logger);
  const cwd = process.cwd();
  const workspace: WorkspaceConfig = {
    allowedRoots: opts.workspace?.allowedRoots ?? [cwd],
    default: opts.workspace?.default ?? cwd,
  };
  const runs = new RunManager(store, log, bridge, registry, logger, workspace);
  const sessions = new SessionService(store, log, registry, runs, workspace);

  const retentionMs = (opts.eventRetentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  const prune = async () => {
    const n = await store.pruneEvents(new Date(Date.now() - retentionMs));
    if (n > 0) logger.info({ pruned: n }, 'pruned old events');
  };

  try {
    await reconcile(store, log, registry, logger);
    await prune();
  } catch (e) {
    await store.close().catch(() => undefined);
    throw e;
  }
  const pruneTimer = setInterval(() => {
    prune().catch((e: unknown) => logger.error({ err: e }, 'event pruning failed'));
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let closing: Promise<void> | undefined;
  return {
    runtimes: { list: () => registry.list(), get: (id) => registry.info(id) },
    sessions: { create: (b) => sessions.create(b), get: (id) => sessions.get(id), list: () => sessions.list() },
    runs: { get: (id) => runs.get(id), cancel: (id) => runs.cancel(id) },
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
 */
async function reconcile(store: Store, log: EventLog, registry: AdapterRegistry, logger: Log): Promise<void> {
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
  }
  await log.drain();
}
