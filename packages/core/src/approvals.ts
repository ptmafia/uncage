import { createHash } from 'node:crypto';
import {
  newId,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
  type NativeApprovalInput,
} from '@uncage/protocol';
import { UncageError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Log } from './logger.js';
import type { Store } from './store/store.js';

interface Pending {
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/** Terminal outcomes the bridge can impose on a pending approval without a user decision. */
export type ApprovalAbandonment = 'expired' | 'cancelled';

const alreadyResolved = () => new UncageError('approval_already_resolved');
const expired = () => new UncageError('approval_expired');
const idemScope = (approvalId: string) => `approval:${approvalId}`;
const hashDecision = (d: ApprovalDecision) =>
  createHash('sha256').update(JSON.stringify([d.decision, d.scope])).digest('hex');

/**
 * Bridges adapter `requestApproval` promises to user decisions. Persistent state lives in the
 * store (state + version CAS); the native callback handles live only in memory, so after a
 * restart they are gone and the approvals are expired by startup reconciliation.
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly inflight = new Map<string, { hash: string; result: Promise<ApprovalRequest> }>();

  constructor(
    private readonly store: Store,
    private readonly log: EventLog,
    private readonly ttlMs: number,
    private readonly logger: Log,
  ) {}

  /** Persists a pending ApprovalRequest, emits `approval.requested`, and returns the outcome promise. */
  async request(
    ctx: { sessionId: string; runId: string; runtimeId: string },
    input: NativeApprovalInput,
  ): Promise<{ approval: ApprovalRequest; outcome: Promise<ApprovalOutcome> }> {
    const now = Date.now();
    const approval: ApprovalRequest = {
      id: newId('apr'),
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      ...(input.toolId !== undefined ? { toolId: input.toolId } : {}),
      runtimeId: ctx.runtimeId,
      category: input.category,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      target: input.target,
      allowedScopes: ['once'],
      availableDecisions: input.availableDecisions ?? ['allow_once', 'deny'],
      state: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      version: 1,
    };
    await this.store.createApproval(approval);
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => void this.expire(approval.id).catch((e: unknown) => this.logError(e)), this.ttlMs);
      timer.unref();
      this.pending.set(approval.id, { resolve, timer });
    });
    await this.log.append(ctx.sessionId, 'approval.requested', { approval }, ctx.runId);
    return { approval, outcome };
  }

  async decide(id: string, d: ApprovalDecision, idempotencyKey: string): Promise<ApprovalRequest> {
    if (d.scope !== 'once') {
      throw new UncageError('unsupported_capability', {
        message: `Approval scope '${d.scope}' is not supported.`,
        details: { scope: d.scope },
      });
    }
    const hash = hashDecision(d);
    const flightKey = `${id}\u0000${idempotencyKey}`;
    const flying = this.inflight.get(flightKey);
    if (flying) {
      if (flying.hash !== hash) throw alreadyResolved();
      return flying.result;
    }
    const result = this.decideOnce(id, d, idempotencyKey, hash);
    this.inflight.set(flightKey, { hash, result });
    try {
      return await result;
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  private async decideOnce(
    id: string,
    d: ApprovalDecision,
    idempotencyKey: string,
    hash: string,
  ): Promise<ApprovalRequest> {
    const prior = await this.store.getIdempotent(idempotencyKey, idemScope(id));
    if (prior) {
      if (prior.requestHash !== hash) throw alreadyResolved();
      return prior.response as ApprovalRequest;
    }

    const current = await this.store.getApproval(id);
    if (!current) throw new UncageError('not_found', { message: `Approval ${id} not found.` });
    if (current.state === 'expired') throw expired();
    if (current.state !== 'pending') throw alreadyResolved();
    if (Date.parse(current.expiresAt) <= Date.now()) {
      await this.expire(id);
      throw expired();
    }

    const claimed = await this.store.casApproval(
      id,
      { state: 'pending', version: current.version },
      { state: 'submitting', decision: d.decision, version: current.version + 1 },
    );
    if (!claimed) {
      const latest = await this.store.getApproval(id);
      throw latest?.state === 'expired' ? expired() : alreadyResolved();
    }

    const handle = this.pending.get(id);
    if (!handle) {
      // The native callback is gone (e.g. its run already ended); never pretend it can be resolved.
      const gone = await this.store.casApproval(
        id,
        { state: 'submitting', version: claimed.version },
        { state: 'expired', version: claimed.version + 1 },
      );
      if (gone) await this.log.append(gone.sessionId, 'approval.updated', { approval: gone }, gone.runId);
      throw expired();
    }
    this.forget(id);

    const resolved = await this.store.casApproval(
      id,
      { state: 'submitting', version: claimed.version },
      { state: d.decision === 'allow' ? 'approved' : 'denied', version: claimed.version + 1 },
    );
    if (!resolved) throw new UncageError('internal_error', { message: `Approval ${id} changed while submitting.` });
    await this.log.append(resolved.sessionId, 'approval.resolved', { approval: resolved }, resolved.runId);
    await this.store.putIdempotent(idempotencyKey, idemScope(id), hash, resolved);
    // Resolve after `approval.resolved` is committed so it precedes the adapter's follow-up events.
    handle.resolve(
      d.decision === 'allow'
        ? { decision: 'allow' }
        : { decision: 'deny', ...(d.reason !== undefined ? { reason: d.reason } : {}) },
    );
    return resolved;
  }

  /** TTL expiry: CAS pending → expired, emit `approval.updated`, resolve `{decision:'expired'}`. */
  private async expire(id: string): Promise<void> {
    await this.abandon(id, 'expired');
  }

  /** Moves every pending approval of `runId` to `to` and resolves its adapter promise with it. */
  async abandonRun(sessionId: string, runId: string, to: ApprovalAbandonment): Promise<void> {
    const open = await this.store.listApprovals({ sessionId, states: ['pending'] });
    for (const a of open) if (a.runId === runId) await this.abandon(a.id, to, a);
  }

  private async abandon(id: string, to: ApprovalAbandonment, known?: ApprovalRequest): Promise<void> {
    const current = known ?? (await this.store.getApproval(id));
    if (current?.state !== 'pending') return;
    const next = await this.store.casApproval(
      id,
      { state: 'pending', version: current.version },
      { state: to, version: current.version + 1 },
    );
    if (!next) return; // a concurrent decide claimed it; that path resolves the adapter
    const handle = this.pending.get(id);
    this.forget(id);
    await this.log.append(next.sessionId, 'approval.updated', { approval: next }, next.runId);
    handle?.resolve({ decision: to });
  }

  private forget(id: string): void {
    const h = this.pending.get(id);
    if (!h) return;
    clearTimeout(h.timer);
    this.pending.delete(id);
  }

  /** Stops all timers and releases waiting adapters with `cancelled` (no store writes). */
  close(): void {
    for (const [id, h] of [...this.pending]) {
      this.forget(id);
      h.resolve({ decision: 'cancelled' });
    }
  }

  private logError(e: unknown): void {
    this.logger.error({ err: e }, 'approval expiry failed');
  }
}
