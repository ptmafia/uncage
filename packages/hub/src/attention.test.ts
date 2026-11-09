import type { ApprovalRequest, Session, UncageEvent } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttentionEvent } from './attention.js';
import type { HubStore } from './store/store.js';
import {
  connectFakeAgent,
  connectFakeHttpAgent,
  fakeMachine,
  fakeSession,
  makeEvent,
  sleep,
  startFaasHubs,
  startTestHub,
  until,
  upId,
  type FakeAgent,
  type TestHub,
} from './test-utils.js';
import type { HubOptions } from './types.js';
import { pgliteHubStore } from './node/index.js';

const MK = 'k'.repeat(43);
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
});

type Seen = { e: AttentionEvent; ctx: { waitUntil(p: Promise<unknown>): void } };

function recorder(impl?: (e: AttentionEvent) => void | Promise<void>) {
  const seen: Seen[] = [];
  const onAttention: NonNullable<HubOptions['onAttention']> = (e, ctx) => {
    seen.push({ e, ctx });
    return impl?.(e);
  };
  return { seen, onAttention };
}

const approval = (sessionId: string, id: string, state: ApprovalRequest['state'] = 'pending'): ApprovalRequest => ({
  id,
  sessionId,
  runId: 'run_1',
  runtimeId: 'fake',
  category: 'shell',
  title: 'Run ls',
  target: { command: 'ls' },
  allowedScopes: ['once'],
  availableDecisions: ['allow_once', 'deny'],
  state,
  ...(state === 'approved' ? { decision: 'allow' as const } : {}),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  version: 1,
});

const at = (e: UncageEvent, occurredAt: string): UncageEvent => ({ ...e, occurredAt });

/** A test hub plus a paired WebSocket agent named "Test Mac" for alice. */
async function setup(o: Partial<HubOptions> & { store?: HubStore } = {}): Promise<{ t: TestHub; a: FakeAgent; machineId: string; fm: ReturnType<typeof fakeMachine> }> {
  const t = await startTestHub(o);
  closers.push(() => t.close());
  const { machineId, machineToken } = await t.pair('alice', { machineKey: MK });
  const fm = fakeMachine();
  const a = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
  closers.push(() => a.close());
  return { t, a, machineId, fm };
}

/** Machine-mode events of a fresh session: created, run started, then `more`. */
function sessionEvents(sessionId: string, title = 'Fix the build'): UncageEvent[] {
  return [makeEvent(sessionId, 1, 'session.created', { session: { ...fakeSession(sessionId, title) } })];
}

describe('onAttention', () => {
  it('fires once per approval, run.completed and run.failed', async () => {
    const r = recorder();
    const { a, machineId } = await setup({ onAttention: r.onAttention });
    const sid = 'ses_attn1';
    const ev = [
      ...sessionEvents(sid),
      makeEvent(sid, 2, 'message.started', { messageId: 'm1', role: 'assistant' }, 'run_1'),
      makeEvent(sid, 3, 'approval.requested', { approval: approval(sid, 'apr_1') }, 'run_1'),
      makeEvent(sid, 4, 'run.completed', { runId: 'run_1', durationMs: 5 }, 'run_1'),
      makeEvent(sid, 5, 'run.failed', { runId: 'run_2', error: { code: 'internal_error', message: 'boom', retryable: false } }, 'run_2'),
      makeEvent(sid, 6, 'run.cancelled', { runId: 'run_3' }, 'run_3'),
    ];
    a.sendEvents(sid, ev);
    await until(() => r.seen.length === 3);
    await sleep(50);
    // Delivered concurrently: order is not guaranteed.
    const byKind = (k: AttentionEvent['kind']) => r.seen.find((s) => s.e.kind === k)!;
    expect(r.seen.map((s) => s.e.kind).sort()).toEqual(['approval_requested', 'run_completed', 'run_failed']);
    expect(byKind('approval_requested').e).toEqual({
      kind: 'approval_requested',
      userId: 'alice',
      sessionId: sid,
      sessionTitle: 'Fix the build',
      machineId,
      machineName: 'Test Mac',
      runtime: 'fake',
      approval: { id: 'apr_1', title: 'Run ls', kind: 'shell' },
      at: ev[2]!.occurredAt,
    });
    expect(byKind('run_completed').e).toMatchObject({ kind: 'run_completed', sessionId: sid, machineId, at: ev[3]!.occurredAt });
    expect(byKind('run_completed').e).not.toHaveProperty('approval');
    expect(byKind('run_failed').e).toMatchObject({ kind: 'run_failed', at: ev[4]!.occurredAt });
    expect(typeof r.seen[0]!.ctx.waitUntil).toBe('function');
  });

  it('agent resend and a second node do not double-notify (claimOnce)', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    closers.push(() => store.close());
    const r = recorder();
    const { t, a } = await setup({ store, onAttention: r.onAttention });
    const sid = 'ses_attn2';
    const ev = [...sessionEvents(sid), makeEvent(sid, 2, 'approval.requested', { approval: approval(sid, 'apr_2') }, 'run_1')];
    a.sendEvents(sid, ev);
    a.sendEvents(sid, ev); // resend (lost ack)
    await until(() => r.seen.length === 1);
    await sleep(100);
    // The machine reconnects to a second node on the same store (re-paired: same id, new token)
    // and backfills the same events there.
    const r2 = recorder();
    const t2 = await startTestHub({ store, onAttention: r2.onAttention });
    closers.push(() => t2.close());
    const again = await t.pair('alice', { machineKey: MK });
    const b = await connectFakeAgent({ url: t2.wsUrl, token: again.machineToken });
    closers.push(() => b.close());
    b.sendEvents(sid, ev);
    await sleep(200);
    expect(r.seen.length + r2.seen.length).toBe(1);
  });

  it('falls back to per-node dedupe without claimOnce', async () => {
    const base = await pgliteHubStore({ dataDir: 'memory://' });
    closers.push(() => base.close());
    const store: HubStore = { ...base, claimOnce: undefined, pruneClaims: undefined };
    const r = recorder();
    const { a } = await setup({ store, onAttention: r.onAttention });
    const sid = 'ses_attn3';
    const ev = [...sessionEvents(sid), makeEvent(sid, 2, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1')];
    a.sendEvents(sid, ev);
    a.sendEvents(sid, ev);
    const run2Event = at(makeEvent(sid, 3, 'run.completed', { runId: 'run_2', durationMs: 1 }, 'run_2'), new Date(Date.now() + 1).toISOString());
    a.sendEvents(sid, [run2Event]);
    await until(() => r.seen.length === 2);
    await sleep(100);
    const run2 = r.seen.find((x) => x.e.at !== ev[1]!.occurredAt);
    expect(r.seen.map((x) => x.e.at).sort()).toEqual([ev[1]!.occurredAt, run2Event.occurredAt].sort());
    expect(r.seen).toHaveLength(2);
    expect(run2?.e).toMatchObject({ kind: 'run_completed', at: run2Event.occurredAt });
  });

  it('skips events older than 10 minutes and already-resolved approvals', async () => {
    const r = recorder();
    const { t, a, fm } = await setup({ sessionStorage: 'site', onAttention: r.onAttention });
    const s = (await (await t.as('alice', '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'fake' }) })).json()) as Session;
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const recent = new Date(Date.now() - 9 * 60_000).toISOString();
    // Backfill after a reconnect: an hour-old approval and run end, then fresh ones.
    a.sendEvents(s.id, [
      fm.sessions.get(s.id)!.events[0]!, // session.created
      at(fm.append(s.id, 'approval.requested', { approval: approval(s.id, 'apr_old') }, 'run_1'), old),
      at(fm.append(s.id, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1'), old),
      // Requested and already answered (the snapshot shows it resolved): no push.
      fm.append(s.id, 'approval.requested', { approval: approval(s.id, 'apr_done') }, 'run_2'),
      fm.append(s.id, 'approval.resolved', { approval: approval(s.id, 'apr_done', 'approved') }, 'run_2'),
      at(fm.append(s.id, 'approval.requested', { approval: approval(s.id, 'apr_live') }, 'run_2'), recent),
    ]);
    await until(() => r.seen.length === 1);
    await sleep(150);
    expect(r.seen.map((x) => x.e.approval?.id)).toEqual(['apr_live']);
    expect((await t.store.getSession(s.id))?.lastSequence).toBe(6); // all stored (session.created + 5)

    // Answered while the notification was still on its way: the stored snapshot wins.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const claimOnce = t.store.claimOnce!.bind(t.store);
    t.store.claimOnce = async (key, o) => ((await gate), claimOnce(key, o));
    a.sendEvents(s.id, [fm.append(s.id, 'approval.requested', { approval: approval(s.id, 'apr_race') }, 'run_3')]);
    await a.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 7);
    a.sendEvents(s.id, [fm.append(s.id, 'approval.resolved', { approval: approval(s.id, 'apr_race', 'approved') }, 'run_3')]);
    await a.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 8);
    release();
    await sleep(150);
    expect(r.seen.map((x) => x.e.approval?.id)).toEqual(['apr_live']);

    // Machine mode, same batch: a resolved approval is skipped too.
    const r2 = recorder();
    const m = await setup({ onAttention: r2.onAttention });
    const sid = 'ses_attn4';
    m.a.sendEvents(sid, [
      ...sessionEvents(sid),
      makeEvent(sid, 2, 'approval.requested', { approval: approval(sid, 'apr_m') }, 'run_1'),
      makeEvent(sid, 3, 'approval.resolved', { approval: approval(sid, 'apr_m', 'approved') }, 'run_1'),
      makeEvent(sid, 4, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1'),
    ]);
    await until(() => r2.seen.length === 1);
    await sleep(100);
    expect(r2.seen.map((x) => x.e.kind)).toEqual(['run_completed']);
  });

  it('warns (once per machine) when a whole batch is stale: the computer clock is probably behind', async () => {
    const warns: Array<[Record<string, unknown>, string | undefined]> = [];
    const logger = { warn: (o: unknown, m?: string) => void warns.push([o as Record<string, unknown>, m]), error: () => undefined };
    const r = recorder();
    const { a, machineId } = await setup({ onAttention: r.onAttention, logger });
    const sid = 'ses_skew';
    const skewed = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    // Real backfill: old events, but the batch ends with a recent one: no warning.
    a.sendEvents(sid, [
      at(makeEvent(sid, 1, 'run.completed', { runId: 'run_0', durationMs: 1 }, 'run_0'), skewed(60)),
      makeEvent(sid, 2, 'message.started', { messageId: 'm0', role: 'assistant' }, 'run_1'),
    ]);
    // A clock 30 min behind: even the newest event looks stale.
    a.sendEvents(sid, [at(makeEvent(sid, 3, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1'), skewed(30))]);
    a.sendEvents(sid, [at(makeEvent(sid, 4, 'run.failed', { runId: 'run_2', error: { code: 'internal_error', message: 'x', retryable: false } }, 'run_2'), skewed(30))]);
    await until(() => warns.some(([, m]) => m?.includes('check the computer clock')));
    await sleep(100);
    const skew = warns.filter(([, m]) => m?.includes('check the computer clock'));
    expect(skew).toHaveLength(1);
    expect(skew[0]![0]).toMatchObject({ machineId });
    expect(skew[0]![0].skewMs as number).toBeGreaterThan(29 * 60_000);
    expect(r.seen).toHaveLength(0);
  });

  it('site mode: a failing resource index after the append still notifies', async () => {
    const errors: unknown[] = [];
    const r = recorder();
    const { t, a, fm } = await setup({ sessionStorage: 'site', onAttention: r.onAttention, logger: { warn: () => undefined, error: (o: unknown) => void errors.push(o) } });
    const s = (await (await t.as('alice', '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'fake' }) })).json()) as Session;
    const put = t.store.putResource.bind(t.store);
    t.store.putResource = async (id, kind, sessionId) => {
      if (id === 'apr_idx') throw new Error('index down');
      return put(id, kind, sessionId);
    };
    a.sendEvents(s.id, [fm.sessions.get(s.id)!.events[0]!, fm.append(s.id, 'approval.requested', { approval: approval(s.id, 'apr_idx') }, 'run_1')]);
    await until(() => r.seen.length === 1);
    expect(r.seen[0]!.e.approval?.id).toBe('apr_idx');
    expect((await t.store.getSession(s.id))?.lastSequence).toBe(2);
    await until(() => errors.length > 0);
  });

  it('a throwing onAttention never breaks ingest', async () => {
    const errors: Array<[unknown, string | undefined]> = [];
    const logger = { warn: () => undefined, error: (o: unknown, m?: string) => void errors.push([o, m]) };
    let n = 0;
    const onAttention: NonNullable<HubOptions['onAttention']> = (e) => {
      n++;
      if (e.kind === 'run_completed') throw new Error('sync boom');
      return Promise.reject(new Error('async boom'));
    };
    const { t, a, fm } = await setup({ sessionStorage: 'site', onAttention, logger });
    const s = (await (await t.as('alice', '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'fake' }) })).json()) as Session;
    a.sendEvents(s.id, [
      fm.sessions.get(s.id)!.events[0]!, // session.created
      fm.append(s.id, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1'),
      fm.append(s.id, 'run.failed', { runId: 'run_2', error: { code: 'internal_error', message: 'x', retryable: false } }, 'run_2'),
    ]);
    await a.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 3);
    expect((await t.store.getSession(s.id))?.lastSequence).toBe(3);
    await until(() => errors.length === 2);
    expect(n).toBe(2);
    expect(errors.map(([, m]) => m)).toEqual(['onAttention failed', 'onAttention failed']);
    expect(errors.map(([o]) => String((o as { err: Error }).err.message)).sort()).toEqual(['async boom', 'sync boom']);
    // Later events still flow.
    a.sendEvents(s.id, [fm.append(s.id, 'message.started', { messageId: 'm1', role: 'assistant' }, 'run_3')]);
    await a.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 4);
  });

  it('uses waitUntil on FaaS', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let finished = false;
    const extra: Array<Promise<unknown>> = [];
    const r = recorder(async () => {
      await gate;
      finished = true;
    });
    const hubs = await startFaasHubs({
      n: 1,
      maintenance: { intervalMs: 3_600_000 },
      onAttention: (e, ctx) => {
        const p = Promise.resolve('extra');
        extra.push(p);
        ctx.waitUntil(p);
        return r.onAttention(e, ctx);
      },
    });
    closers.push(() => hubs.close());
    const { token } = await hubs.pair('alice');
    const agent = await connectFakeHttpAgent({ hubs, token });
    closers.push(() => agent.close());
    const sid = 'ses_attn5';
    const waited: Array<Promise<unknown>> = [];
    const res = await hubs.hubs[0]!.fetch(
      new Request(`${hubs.api}/agent/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          linkId: agent.linkId,
          busy: false,
          msgs: [{ id: upId(), msg: { t: 'events', sessionId: sid, events: [...sessionEvents(sid), makeEvent(sid, 2, 'run.completed', { runId: 'run_1', durationMs: 1 }, 'run_1')] } }],
        }),
      }),
      { waitUntil: (p) => void waited.push(p) },
    );
    // The response does not wait for the notification.
    expect(res.status).toBe(200);
    await until(() => r.seen.length === 1 && waited.length === 2);
    expect(finished).toBe(false);
    // The handler's promise and its own ctx.waitUntil work (extra) both went to the platform.
    expect(extra).toHaveLength(1);
    let settled = false;
    const all = Promise.all(waited).then(() => (settled = true));
    await sleep(30);
    expect(settled).toBe(false);
    release();
    await all;
    expect(finished).toBe(true);
  });
});
