import { createHash } from 'node:crypto';
import {
  newId,
  type ApprovalOutcome,
  type ErrorBody,
  type NativeApprovalInput,
  type Run,
  type RunState,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StartRunBody,
} from '@uncage/protocol';
import type { ApprovalBridge } from './approvals.js';
import { UncageError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Log } from './logger.js';
import type { AdapterRegistry } from './registry.js';
import type { Store } from './store/store.js';

export const ACTIVE_RUN_STATES: RunState[] = ['queued', 'running', 'waiting_approval'];
const CANCEL_GRACE_MS = 5_000;

type Terminal =
  | { state: 'completed' }
  | { state: 'failed'; error: ErrorBody }
  | { state: 'cancelled' }
  | { state: 'interrupted'; reason: string };

interface ActiveRun {
  run: Run;
  sessionId: string;
  workspace: string;
  nativeSessionRef?: string;
  adapter: RuntimeAdapter;
  abort: AbortController;
  cancelRequested: boolean;
  closing: boolean;
  finished?: Promise<void>;
  pendingApprovals: number;
  /** Next `chunkIndex` per messageId. */
  chunks: Map<string, number>;
  /** Serialises run-state mutations (transitions and finish) so they commit in order. */
  chain: Promise<unknown>;
  /** Resolves when the drive loop has returned. */
  done: Promise<void>;
  markDone: () => void;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

const runIdemScope = (sessionId: string) => `run:${sessionId}`;
const hashPrompt = (prompt: string) => createHash('sha256').update(prompt).digest('hex');

/** Owns run execution: starting, driving adapter iterators, cancelling, and shutting down. */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly bySession = new Map<string, ActiveRun>();
  private readonly startLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly log: EventLog,
    private readonly bridge: ApprovalBridge,
    private readonly registry: AdapterRegistry,
    private readonly logger: Log,
  ) {}

  async get(id: string): Promise<Run> {
    const run = await this.store.getRun(id);
    if (!run) throw new UncageError('not_found', { message: `Run ${id} not found.` });
    return run;
  }

  /** Persists a queued run and starts driving it in the background. Serialised per session. */
  start(sessionId: string, body: StartRunBody & { idempotencyKey?: string }): Promise<Run> {
    const prev = this.startLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.startLocked(sessionId, body));
    this.startLocks.set(sessionId, next);
    void next
      .finally(() => {
        if (this.startLocks.get(sessionId) === next) this.startLocks.delete(sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  private async startLocked(sessionId: string, body: StartRunBody & { idempotencyKey?: string }): Promise<Run> {
    const { idempotencyKey: key, prompt } = body;
    const hash = hashPrompt(prompt);
    if (key !== undefined) {
      const prior = await this.store.getIdempotent(key, runIdemScope(sessionId));
      if (prior) {
        if (prior.requestHash !== hash) {
          throw new UncageError('invalid_request', {
            message: 'This idempotency key was already used with a different prompt.',
            hint: 'Use a new idempotency key for a new run.',
          });
        }
        return this.get((prior.response as { runId: string }).runId);
      }
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new UncageError('not_found', { message: `Session ${sessionId} not found.` });
    if (this.bySession.has(sessionId)) throw new UncageError('session_busy');
    const adapter = this.registry.find(session.runtimeId);
    if (!adapter) {
      throw new UncageError('runtime_unavailable', { message: `Runtime ${session.runtimeId} is not registered.` });
    }
    if (session.readOnly) throw new UncageError('session_read_only', { hint: 'Start a new session' });

    const run: Run = {
      id: newId('run'),
      sessionId,
      prompt,
      state: 'queued',
      createdAt: new Date().toISOString(),
    };
    let markDone!: () => void;
    const entry: ActiveRun = {
      run,
      sessionId,
      workspace: session.workspace,
      ...(session.nativeSessionRef !== undefined ? { nativeSessionRef: session.nativeSessionRef } : {}),
      adapter,
      abort: new AbortController(),
      cancelRequested: false,
      closing: false,
      pendingApprovals: 0,
      chunks: new Map(),
      chain: Promise.resolve(),
      done: new Promise<void>((r) => (markDone = r)),
      markDone: () => markDone(),
    };
    this.active.set(run.id, entry);
    this.bySession.set(sessionId, entry);
    try {
      await this.store.createRun(run);
      await this.store.updateSession(sessionId, { status: 'busy', activeRunId: run.id });
      await this.log.append(sessionId, 'run.started', { run }, run.id);
      if (key !== undefined) await this.store.putIdempotent(key, runIdemScope(sessionId), hash, { runId: run.id });
    } catch (e) {
      this.active.delete(run.id);
      this.bySession.delete(sessionId);
      entry.markDone();
      throw e;
    }
    this.logger.info({ runId: run.id, sessionId, runtime: adapter.id }, 'run queued');
    this.logger.debug({ runId: run.id, promptLength: prompt.length }, 'run prompt received');
    void this.drive(entry);
    return run;
  }

  /** Aborts the run, cancels its pending approvals, waits ≤5 s, and marks it cancelled. */
  async cancel(id: string): Promise<Run> {
    const run = await this.get(id);
    if (!ACTIVE_RUN_STATES.includes(run.state)) return run;
    const entry = this.active.get(id);
    if (!entry) {
      // Not driven by this process (should not happen after reconciliation): close it out directly.
      const now = new Date().toISOString();
      const cancelled = await this.store.updateRun(id, { state: 'cancelled', endedAt: now });
      await this.log.append(run.sessionId, 'run.cancelled', { runId: id }, id);
      await this.store.updateSession(run.sessionId, { status: 'ready', activeRunId: undefined });
      return cancelled;
    }
    entry.cancelRequested = true;
    entry.abort.abort();
    await this.bridge.abandonRun(entry.sessionId, id, 'cancelled');
    await Promise.race([entry.done, sleep(CANCEL_GRACE_MS)]);
    await this.finish(entry, { state: 'cancelled' });
    return this.get(id);
  }

  /** Aborts every active run and marks it interrupted; pending approvals expire. */
  async closeAll(): Promise<void> {
    const entries = [...this.active.values()];
    for (const e of entries) {
      e.closing = true;
      e.abort.abort();
    }
    // Release adapters blocked on an approval (they may not watch the signal), as cancel() does.
    await Promise.all(entries.map((e) => this.bridge.abandonRun(e.sessionId, e.run.id, 'expired')));
    await Promise.race([Promise.all(entries.map((e) => e.done)), sleep(CANCEL_GRACE_MS)]);
    await Promise.all(entries.map((e) => this.finish(e, { state: 'interrupted', reason: 'server_shutdown' })));
  }

  private async drive(entry: ActiveRun): Promise<void> {
    let terminal: Terminal | undefined;
    try {
      await this.transition(entry, 'running');
      const iterable = entry.adapter.run(
        {
          runId: entry.run.id,
          prompt: entry.run.prompt,
          cwd: entry.workspace,
          ...(entry.nativeSessionRef !== undefined ? { nativeSessionRef: entry.nativeSessionRef } : {}),
        },
        { signal: entry.abort.signal, requestApproval: (i) => this.requestApproval(entry, i) },
      );
      for await (const ev of iterable) {
        if (entry.finished) break;
        terminal = await this.translate(entry, ev);
        if (terminal) break;
      }
    } catch (e) {
      this.logger.warn({ err: e, runId: entry.run.id }, 'runtime adapter failed');
    }
    entry.markDone();
    await this.finish(entry, this.settle(entry, terminal));
  }

  private settle(entry: ActiveRun, t: Terminal | undefined): Terminal {
    // Once shutdown or cancel has begun, its outcome wins over whatever the adapter reports
    // afterwards (e.g. run.completed after its approval was released as expired/cancelled).
    if (entry.closing) return { state: 'interrupted', reason: 'server_shutdown' };
    if (entry.cancelRequested) return { state: 'cancelled' };
    return t ?? { state: 'interrupted', reason: 'runtime_disconnected' };
  }

  private async requestApproval(entry: ActiveRun, input: NativeApprovalInput): Promise<ApprovalOutcome> {
    if (entry.finished || entry.abort.signal.aborted) return { decision: 'cancelled' };
    const { outcome } = await this.bridge.request(
      { sessionId: entry.sessionId, runId: entry.run.id, runtimeId: entry.adapter.id },
      input,
    );
    if (entry.finished) await this.bridge.abandonRun(entry.sessionId, entry.run.id, 'cancelled');
    entry.pendingApprovals++;
    if (entry.pendingApprovals === 1) await this.transition(entry, 'waiting_approval');
    const result = await outcome;
    entry.pendingApprovals--;
    if (entry.pendingApprovals === 0) await this.transition(entry, 'running');
    return result;
  }

  private serial<T>(entry: ActiveRun, fn: () => Promise<T>): Promise<T> {
    const next = entry.chain.catch(() => undefined).then(fn);
    entry.chain = next;
    return next;
  }

  private transition(entry: ActiveRun, state: 'running' | 'waiting_approval'): Promise<void> {
    return this.serial(entry, async () => {
      // Once cancel/close has begun, only the terminal state may be written.
      if (entry.finished || entry.cancelRequested || entry.closing || entry.run.state === state) return;
      const patch: Partial<Run> = { state };
      if (state === 'running' && entry.run.startedAt === undefined) patch.startedAt = new Date().toISOString();
      entry.run = await this.store.updateRun(entry.run.id, patch);
      await this.log.append(entry.sessionId, 'run.updated', { runId: entry.run.id, state }, entry.run.id);
    });
  }

  private finish(entry: ActiveRun, t: Terminal): Promise<void> {
    entry.finished ??= this.serial(entry, async () => {
      const { sessionId } = entry;
      const runId = entry.run.id;
      try {
        await this.bridge.abandonRun(sessionId, runId, entry.closing ? 'expired' : 'cancelled');
        const endedAt = new Date().toISOString();
        entry.run = await this.store.updateRun(runId, {
          state: t.state,
          endedAt,
          ...(t.state === 'failed' ? { error: t.error } : {}),
        });
        if (t.state === 'completed') {
          const from = Date.parse(entry.run.startedAt ?? entry.run.createdAt);
          await this.log.append(sessionId, 'run.completed', { runId, durationMs: Date.parse(endedAt) - from }, runId);
        } else if (t.state === 'failed') {
          await this.log.append(sessionId, 'run.failed', { runId, error: t.error }, runId);
        } else if (t.state === 'cancelled') {
          await this.log.append(sessionId, 'run.cancelled', { runId }, runId);
        } else {
          await this.log.append(sessionId, 'run.interrupted', { runId, reason: t.reason }, runId);
        }
        await this.store.updateSession(sessionId, { status: 'ready', activeRunId: undefined });
        this.logger.info({ runId, sessionId, state: t.state }, 'run finished');
      } catch (e) {
        this.logger.error({ err: e, runId }, 'failed to finalise run');
      } finally {
        this.active.delete(runId);
        if (this.bySession.get(sessionId) === entry) this.bySession.delete(sessionId);
        entry.abort.abort();
      }
    });
    return entry.finished;
  }

  /** Maps one adapter event to envelopes; returns the terminal outcome when the adapter reports one. */
  private async translate(entry: ActiveRun, ev: RuntimeEvent): Promise<Terminal | undefined> {
    const { sessionId } = entry;
    const runId = entry.run.id;
    switch (ev.type) {
      case 'native.session': {
        const readOnly = !entry.adapter.capabilities().nativeResume;
        await this.store.updateSession(sessionId, { nativeSessionRef: ev.ref, ...(readOnly ? { readOnly } : {}) });
        return;
      }
      case 'message.started':
        await this.log.append(sessionId, 'message.started', { messageId: ev.messageId, role: 'assistant' }, runId);
        return;
      case 'message.delta': {
        const chunkIndex = entry.chunks.get(ev.messageId) ?? 0;
        entry.chunks.set(ev.messageId, chunkIndex + 1);
        await this.log.append(sessionId, 'message.delta', { messageId: ev.messageId, chunkIndex, text: ev.text }, runId);
        return;
      }
      case 'message.completed':
        await this.log.append(sessionId, 'message.completed', { messageId: ev.messageId, text: ev.text }, runId);
        return;
      case 'tool.started': {
        const { type, ...payload } = ev;
        await this.log.append(sessionId, type, payload, runId);
        return;
      }
      case 'tool.updated': {
        const { type, ...payload } = ev;
        await this.log.append(sessionId, type, payload, runId);
        return;
      }
      case 'tool.completed': {
        const { type, ...payload } = ev;
        await this.log.append(sessionId, type, payload, runId);
        return;
      }
      case 'tool.failed': {
        const { type, ...payload } = ev;
        await this.log.append(sessionId, type, payload, runId);
        return;
      }
      case 'warning':
        await this.log.append(sessionId, 'system.warning', { code: ev.code, message: ev.message }, runId);
        return;
      case 'run.completed':
        return { state: 'completed' };
      case 'run.failed':
        return { state: 'failed', error: ev.error };
      case 'run.interrupted':
        return { state: 'interrupted', reason: ev.reason };
    }
  }
}
