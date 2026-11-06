import { createHash } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  newId,
  type ActiveRunInfo,
  type ApprovalOutcome,
  type ErrorBody,
  type NativeApprovalInput,
  type ResolvedAttachment,
  type Run,
  type RunState,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type SessionSettings,
  type StartRunBody,
} from '@uncage/protocol';
import type { ApprovalBridge } from './approvals.js';
import { publicAttachment } from './attachments.js';
import { UncageError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Log } from './logger.js';
import type { AdapterRegistry } from './registry.js';
import type { WorkspaceConfig } from './sessions.js';
import type { SecurityPolicy } from './settings.js';
import type { Store } from './store/store.js';
import { resolveWorkspace } from './workspace.js';

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
  /** The session's settings when the run started; later changes apply from the next run. */
  settings: SessionSettings;
  attachments: ResolvedAttachment[];
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
/**
 * Drops stored settings the runtime no longer offers: `model`/`effort` fall back to the runtime
 * default (undefined), `permissionMode` to `default`. `reset` names the settings that changed.
 */
function effectiveSettings(
  current: SessionSettings,
  caps: RuntimeCapabilities,
): { settings: SessionSettings; reset: string[] } {
  const settings: SessionSettings = { ...current };
  const reset: string[] = [];
  if (settings.model !== undefined && caps.models.length > 0 && !caps.models.some((m) => m.id === settings.model)) {
    delete settings.model;
    reset.push('model');
  }
  if (settings.effort !== undefined && !caps.efforts.includes(settings.effort)) {
    delete settings.effort;
    reset.push('effort');
  }
  if (!caps.permissionModes.includes(settings.permissionMode) && settings.permissionMode !== 'default') {
    settings.permissionMode = 'default';
    reset.push('permission mode');
  }
  return { settings, reset };
}

/** Request fingerprint for idempotency: the prompt, plus the attachment ids when there are any. */
const hashRequest = (prompt: string, attachmentIds: string[]) =>
  createHash('sha256')
    .update(attachmentIds.length === 0 ? prompt : `${prompt}\0${attachmentIds.join(',')}`)
    .digest('hex');

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
    private readonly workspaceConfig: WorkspaceConfig,
    private readonly policy: SecurityPolicy,
  ) {}

  async get(id: string): Promise<Run> {
    const run = await this.store.getRun(id);
    if (!run) throw new UncageError('not_found', { message: `Run ${id} not found.` });
    return run;
  }

  /** Runs in `queued | running | waiting_approval` across all sessions, newest first. */
  async listActive(): Promise<ActiveRunInfo[]> {
    const runs = await this.store.listRunsInState(ACTIVE_RUN_STATES);
    const titles = new Map<string, string>();
    for (const sid of new Set(runs.map((r) => r.sessionId))) {
      const s = await this.store.getSession(sid);
      if (s) titles.set(sid, s.title);
    }
    return runs
      .filter((r) => titles.has(r.sessionId))
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
      .map((r) => ({
        runId: r.id,
        sessionId: r.sessionId,
        sessionTitle: titles.get(r.sessionId) as string,
        state: r.state,
        ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
      }));
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
    const attachmentIds = body.attachmentIds ?? [];
    if (attachmentIds.some((a) => a === '') || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new UncageError('invalid_request', { message: 'attachmentIds must be distinct, non-empty ids.' });
    }
    if (attachmentIds.length > ATTACHMENT_LIMITS.maxPerMessage) {
      throw new UncageError('invalid_request', {
        message: `At most ${ATTACHMENT_LIMITS.maxPerMessage} attachments can be sent with one message.`,
      });
    }
    const hash = hashRequest(prompt, attachmentIds);
    if (key !== undefined) {
      const prior = await this.store.getIdempotent(key, runIdemScope(sessionId));
      if (prior) {
        if (prior.requestHash !== hash) {
          throw new UncageError('invalid_request', {
            message: 'This idempotency key was already used with a different request.',
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
    if (session.settings.permissionMode === 'bypassPermissions' && !this.policy.allowBypass) {
      throw new UncageError('policy_denied', { message: 'Bypass permissions mode is disabled on this server.' });
    }
    // allowedRoots may have changed since the session was created (config edit, another --workspace).
    const workspace = await resolveWorkspace(session.workspace, this.workspaceConfig).catch((e: unknown) => {
      throw new UncageError('invalid_workspace', {
        message: "This session's workspace is outside the allowed roots.",
        hint: "This session's workspace is outside the allowed roots; start a new session",
        details: { workspace: session.workspace },
        cause: e,
      });
    });

    const attachments = await this.resolveAttachments(sessionId, attachmentIds);
    const { settings, reset } = effectiveSettings(session.settings, await this.registry.capabilities(session.runtimeId));

    const run: Run = {
      id: newId('run'),
      sessionId,
      prompt,
      state: 'queued',
      createdAt: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments: attachments.map(publicAttachment) } : {}),
    };
    let markDone!: () => void;
    const entry: ActiveRun = {
      run,
      sessionId,
      workspace,
      ...(session.nativeSessionRef !== undefined ? { nativeSessionRef: session.nativeSessionRef } : {}),
      settings,
      attachments,
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
    // Claim the attachments atomically before the run exists, so a concurrent prune (or anything
    // else that changed them since they were checked) fails the start instead of the run.
    if (attachmentIds.length > 0 && (await this.store.markAttachmentsReferenced(attachmentIds, run.id)) !== attachmentIds.length) {
      throw new UncageError('invalid_request', {
        message: 'Some attachments are no longer available.',
        hint: 'Upload the files again and resend.',
      });
    }
    this.active.set(run.id, entry);
    this.bySession.set(sessionId, entry);
    try {
      await this.store.createRun(run);
      const updated = await this.store.updateSession(sessionId, {
        status: 'busy',
        activeRunId: run.id,
        ...(reset.length > 0 ? { settings } : {}),
      });
      await this.log.append(sessionId, 'run.started', { run }, run.id);
      if (reset.length > 0) {
        await this.log.append(sessionId, 'session.updated', { session: updated }, run.id);
        await this.log.append(
          sessionId,
          'system.warning',
          {
            code: 'setting_reset',
            message: `The runtime no longer supports the selected ${reset.join(' and ')}; using the runtime default.`,
          },
          run.id,
        );
      }
      if (key !== undefined) await this.store.putIdempotent(key, runIdemScope(sessionId), hash, { runId: run.id });
    } catch (e) {
      if (attachmentIds.length > 0) await this.store.releaseAttachments(run.id).catch(() => undefined);
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

  /**
   * Every id must exist, belong to this session and not have been sent with a run yet; otherwise
   * `invalid_request` and no run is created. Returned oldest first, as runs are hydrated.
   */
  private async resolveAttachments(sessionId: string, ids: string[]): Promise<ResolvedAttachment[]> {
    if (ids.length === 0) return [];
    const rows = await this.store.listAttachments(ids);
    const usable = rows.filter((a) => a.sessionId === sessionId && a.referencedByRun === undefined);
    if (usable.length !== ids.length) {
      const ok = new Set(usable.map((a) => a.id));
      throw new UncageError('invalid_request', {
        message: 'Some attachments are unknown, belong to another session, or were already sent.',
        hint: 'Upload the files again and resend.',
        details: { attachmentIds: ids.filter((id) => !ok.has(id)) },
      });
    }
    return usable.map((a) => ({ ...publicAttachment(a), absPath: a.absPath }));
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
          settings: entry.settings,
          attachments: entry.attachments,
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
      case 'native.session_lost': {
        // The runtime can't resume this conversation any more: keep the history readable, but
        // never start another run on it.
        const session = await this.store.updateSession(sessionId, { readOnly: true });
        await this.log.append(sessionId, 'session.updated', { session }, runId);
        const message = ev.message ?? 'The runtime could not resume this session.';
        await this.log.append(sessionId, 'system.warning', { code: 'session_resume_failed', message }, runId);
        this.logger.warn({ runId, sessionId, runtime: entry.adapter.id }, 'native session lost; session is now read-only');
        const error = new UncageError('session_read_only', {
          message: 'This session can no longer be continued; its history is still available.',
          hint: 'Start a new session',
          details: { reason: message },
        });
        return { state: 'failed', error: error.toBody() };
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
