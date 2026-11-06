import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import type { ApprovalOutcome, ApprovalRequest, NativeApprovalInput, RuntimeAdapter } from '@uncage/protocol';
import { createUncage, type Uncage } from './uncage.js';
import type { SessionHandle } from './sessions.js';
import { eventsUntil, isTerminal } from './test-utils.js';

const approvalStep: FakeStep = {
  approval: { category: 'shell', title: 'Run ls', target: { command: 'ls' } },
};

/** Wraps an adapter so tests can observe what `requestApproval` resolved with. */
function recordingOutcomes(adapter: RuntimeAdapter): RuntimeAdapter & { outcomes: ApprovalOutcome[] } {
  const outcomes: ApprovalOutcome[] = [];
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    probe: () => adapter.probe(),
    capabilities: () => adapter.capabilities(),
    outcomes,
    run: (input, ctx) =>
      adapter.run(input, {
        signal: ctx.signal,
        requestApproval: async (i: NativeApprovalInput) => {
          const o = await ctx.requestApproval(i);
          outcomes.push(o);
          return o;
        },
      }),
  };
}

describe('approval bridge', () => {
  let uncage: Uncage | undefined;
  afterEach(async () => {
    await uncage?.close();
    uncage = undefined;
  });

  async function setup(opts: { ttlMs?: number; steps?: FakeStep[] } = {}) {
    const adapter = recordingOutcomes(
      createFakeAdapter({ script: opts.steps ?? [approvalStep, { text: 'done' }] }),
    );
    uncage = await createUncage({
      adapters: [adapter],
      dataDir: 'memory://',
      ...(opts.ttlMs !== undefined ? { approvals: { ttlMs: opts.ttlMs } } : {}),
    });
    const session = await uncage.sessions.create({ runtime: 'fake' });
    const run = await session.startRun({ prompt: 'hi' });
    const seen = await eventsUntil(session, (e) => e.type === 'approval.requested');
    const requested = seen.at(-1);
    if (requested?.type !== 'approval.requested') throw new Error('no approval');
    return { uncage, adapter, session, run, approval: requested.payload.approval };
  }

  const waitTerminal = (session: SessionHandle) => eventsUntil(session, isTerminal);

  it('allow resolves adapter promise and emits approval.resolved', async () => {
    const { uncage, adapter, session, approval, run } = await setup();
    expect(approval).toMatchObject({
      state: 'pending',
      version: 1,
      allowedScopes: ['once'],
      availableDecisions: ['allow_once', 'deny'],
      runId: run.id,
      runtimeId: 'fake',
    });
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBe(600_000);

    const decided = await uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'once' }, 'k1');
    expect(decided).toMatchObject({ id: approval.id, state: 'approved', decision: 'allow' });

    const events = await waitTerminal(session);
    expect(adapter.outcomes).toEqual([{ decision: 'allow' }]);
    const types = events.map((e) => e.type);
    expect(types).toContain('approval.resolved');
    expect(types.indexOf('run.updated')).toBeLessThan(types.indexOf('approval.requested'));
    const states = events.flatMap((e) => (e.type === 'run.updated' ? [e.payload.state] : []));
    expect(states).toEqual(['running', 'waiting_approval', 'running']);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(await uncage.approvals.list({ sessionId: session.id, pendingOnly: true })).toEqual([]);
  });

  it('two concurrent decide calls → one ok, one approval_already_resolved', async () => {
    const { uncage, approval, session } = await setup();
    const results = await Promise.allSettled([
      uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'once' }, 'a'),
      uncage.approvals.decide(approval.id, { decision: 'deny', scope: 'once' }, 'b'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({ code: 'approval_already_resolved' });
    await waitTerminal(session);
  });

  it('same idempotency key + same decision returns same result', async () => {
    const { uncage, approval, session } = await setup();
    const first = await uncage.approvals.decide(approval.id, { decision: 'deny', scope: 'once' }, 'key');
    const again = await uncage.approvals.decide(approval.id, { decision: 'deny', scope: 'once' }, 'key');
    expect(again).toEqual(first);
    expect(first.state).toBe('denied');
    await expect(
      uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'once' }, 'key'),
    ).rejects.toMatchObject({ code: 'approval_already_resolved' });
    await expect(
      uncage.approvals.decide(approval.id, { decision: 'deny', scope: 'once' }, 'other'),
    ).rejects.toMatchObject({ code: 'approval_already_resolved' });
    await waitTerminal(session);
  });

  it('rejects session scope with unsupported_capability', async () => {
    const { uncage, approval } = await setup();
    await expect(
      uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'session' }, 'k'),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(
      uncage.approvals.decide('apr_missing', { decision: 'allow', scope: 'once' }, 'k'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it("ttl expiry → expired, adapter receives {decision:'expired'}", async () => {
    const { uncage, adapter, session, approval } = await setup({ ttlMs: 50 });
    const events = await waitTerminal(session);
    expect(adapter.outcomes).toEqual([{ decision: 'expired' }]);
    const updated = events.find(
      (e): e is Extract<typeof e, { type: 'approval.updated' }> => e.type === 'approval.updated',
    );
    expect(updated?.payload.approval).toMatchObject({ id: approval.id, state: 'expired', version: 2 });
    await expect(
      uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'once' }, 'late'),
    ).rejects.toMatchObject({ code: 'approval_expired' });
  });

  it('cancel run → pending approval cancelled', async () => {
    const { uncage, session, approval, run } = await setup();
    const cancelled = await uncage.runs.cancel(run.id);
    expect(cancelled.state).toBe('cancelled');
    const [stored] = await uncage.approvals.list({ sessionId: session.id });
    expect(stored).toMatchObject<Partial<ApprovalRequest>>({ id: approval.id, state: 'cancelled' });
    const events = await waitTerminal(session);
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.filter((e) => e.type === 'run.interrupted')).toEqual([]);
    // Idempotent: cancelling a finished run returns it unchanged.
    await expect(uncage.runs.cancel(run.id)).resolves.toEqual(cancelled);
    await expect(
      uncage.approvals.decide(approval.id, { decision: 'allow', scope: 'once' }, 'late'),
    ).rejects.toMatchObject({ code: 'approval_already_resolved' });
  });
});
