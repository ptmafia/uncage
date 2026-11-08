/**
 * Tool-call delivery semantics (spec §5.9 item 5): exactly-once on a connection drop, at-most-once
 * (an `interrupted` error, never a re-run) when the instance running the handler is killed; file
 * pulls whose chunks land on other instances; run end on another instance.
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { HubFrame, MachineInfo, Run, Session } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sqlCluster } from './cluster/postgres.js';
import { PullAssembler } from './files.js';
import type { SqlClient } from './store/sql.js';
import {
  connectFakeAgent,
  connectFakeHttpAgent,
  fakeMachine,
  pullServer,
  sleep,
  startFaasHubs,
  startTestHub,
  until,
  type CommandHandler,
  type FaasHubs,
  type FakeAgent,
  type FakeHttpAgent,
} from './test-utils.js';
import { defineTool, type SiteTool } from './tools.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

type ToolResultFrame = Extract<HubFrame, { t: 'tool_result' }>;
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const machinesOf = async (hubs: FaasHubs, user: string) => (await (await hubs.as(user, '/machines')).json()) as MachineInfo[];
const isEvents = (req: Request) => new URL(req.url).pathname.endsWith('/agent/events');
const INTERRUPTED = { code: 'tool_failed', message: 'Site tool "slow" timed out on the website. Please try again.', details: { reason: 'interrupted' } };
const INTERRUPTED_QUICK = { ...INTERRUPTED, message: 'Site tool "quick" timed out on the website. Please try again.' };

/** FaaS hubs with `tools`, an HTTP fake agent paired to u1, one session and one run started through the hub. */
async function httpSetup(
  tools: SiteTool[],
  o: { hub?: Partial<Parameters<typeof startFaasHubs>[0]>; onFrame?: Parameters<typeof connectFakeHttpAgent>[0]['onFrame']; onCommand?: (fm: ReturnType<typeof fakeMachine>) => CommandHandler } = {},
) {
  const hubs = await startFaasHubs({ n: 3, tools, runIndexWaitMs: 2_000, ...o.hub });
  closers.push(() => hubs.close());
  const { token } = await hubs.pair('u1');
  const fm = fakeMachine();
  const agent = await connectFakeHttpAgent({ hubs, token, onCommand: o.onCommand?.(fm) ?? fm.handler, ...(o.onFrame ? { onFrame: o.onFrame } : {}) });
  closers.push(() => agent.close());
  await until(async () => (await machinesOf(hubs, 'u1'))[0]?.online);
  const s = (await (await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
  const r = await hubs.as('u1', `/sessions/${s.id}/runs`, json({ prompt: 'go' }, { 'idempotency-key': `k-${Math.random()}` }));
  expect(r.status).toBe(202);
  const run = (await r.json()) as Run;
  return { hubs, agent, fm, s, run, ctx: { sessionId: s.id, runId: run.id } };
}

/** Routes the next `next` upstream POSTs to instance `to`, every other request round-robin over `others`. */
function routeUpstream(hubs: FaasHubs, o: { to: number; next: number; others: number[] }) {
  let left = o.next;
  let rr = 0;
  hubs.route((req) => {
    if (left > 0 && isEvents(req)) {
      left--;
      return o.to;
    }
    return o.others[rr++ % o.others.length]!;
  });
}

describe('exactly-once on connection drops (HTTP, 3 instances)', () => {
  it('20 random connection cuts: every handler runs exactly once and every call gets exactly one result', async () => {
    const runs = new Map<number, number>(); // handler invocations per args.i
    const countMe = defineTool({
      name: 'count_me',
      description: 'x',
      input: z.object({ i: z.number() }),
      handler: async ({ i }) => {
        runs.set(i, (runs.get(i) ?? 0) + 1);
        await sleep(50 + Math.random() * 300);
        return `ran ${i}`;
      },
    });
    const { hubs, agent, s, ctx } = await httpSetup([countMe], { hub: { maxConcurrentToolCalls: 32 } });
    const cutter = setInterval(() => hubs.cutAll(), 150);
    let results: ToolResultFrame[];
    try {
      results = await Promise.all(Array.from({ length: 20 }, (_, i) => agent.callTool('count_me', { i }, ctx)));
    } finally {
      clearInterval(cutter);
    }
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect(runs.size).toBe(20);
    expect(results.every((r) => r.ok)).toBe(true);
    results.forEach((r, i) => expect(r).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: `ran ${i}` }] } }));
    const rows = await hubs.store.listToolCalls(s.id);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  }, 60_000);

  it('a retried POST of a finished call replays the stored result (inbox done)', async () => {
    let n = 0;
    const once = defineTool({ name: 'once', description: 'x', input: z.object({}), handler: async () => `run ${++n}` });
    const { agent, ctx } = await httpSetup([once]);
    const msg = { id: 'up_replay_0000000001', msg: { t: 'tool_call' as const, id: 'tc_replay', ...ctx, tool: 'once', args: {} } };
    const first = (await (await agent.post({ msgs: [msg] })).json()) as { processed: string[]; replies: HubFrame[] };
    const again = (await (await agent.post({ msgs: [msg] })).json()) as { processed: string[]; replies: HubFrame[] };
    expect(first.processed).toEqual([msg.id]);
    expect(again.processed).toEqual([msg.id]);
    expect(again.replies).toEqual(first.replies);
    expect(first.replies).toEqual([{ t: 'tool_result', id: 'tc_replay', ok: true, result: { content: [{ type: 'text', text: 'run 1' }] } }]);
    // A resend under a new message id (e.g. after reconnecting) is answered from the store too.
    const resent = (await (await agent.post({ msgs: [{ ...msg, id: 'up_replay_0000000002' }] })).json()) as { replies: HubFrame[] };
    expect(resent.replies).toEqual(first.replies);
    expect(n).toBe(1);
  });
});

describe('at-most-once on instance kill', () => {
  it('killed instance: one interrupted error, handler started once, no late result', async () => {
    let started = 0;
    const slow = defineTool({
      name: 'slow',
      description: 'x',
      input: z.object({}),
      handler: () => {
        started++;
        return new Promise(() => undefined);
      },
    });
    const { hubs, agent, s, ctx } = await httpSetup([slow], { hub: { toolTimeoutMs: 400, toolLeaseGraceMs: 200 } });
    // The tool_call POST lands on instance 0; everything else (and every retry) on 1 and 2.
    routeUpstream(hubs, { to: 0, next: 1, others: [1, 2] });
    const pending = agent.callTool('slow', {}, ctx);
    await until(() => started === 1);
    hubs.kill(0);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: INTERRUPTED });
    expect(started).toBe(1);
    expect(await hubs.store.listToolCalls(s.id)).toMatchObject([{ status: 'interrupted' }]);
    // No late result: whatever reaches the agent for this call is the interrupted error.
    await sleep(800);
    const forCall = agent.frames.filter((f): f is ToolResultFrame => f.t === 'tool_result' && f.id === result.id);
    expect(forCall.length).toBeGreaterThanOrEqual(1);
    expect(forCall.every((f) => !f.ok && f.error.details?.reason === 'interrupted')).toBe(true);
    expect(started).toBe(1);
  }, 30_000);

  it('stale running call is interrupted by maintenance and the error is delivered to the machine', async () => {
    const slow = defineTool({ name: 'slow', description: 'x', input: z.object({}), handler: async () => 'x' });
    const { hubs, agent, s, run } = await httpSetup([slow], { hub: { maintenance: { intervalMs: 50 } } });
    const past = new Date(Date.now() - 60_000).toISOString();
    const claim = await hubs.store.claimToolCall(
      { id: 'tcl_stale0000001', callId: 'tc_stale', sessionId: s.id, runId: run.id, userId: 'u1', machineId: agent.machineId, tool: 'slow', args: {}, status: 'running', startedAt: past },
      { leaseUntil: past, now: past },
    );
    expect(claim.kind).toBe('new');
    let interrupted = 0;
    await until(async () => {
      for (const h of hubs.hubs) {
        const r = await h.maintain();
        if (r.ran) interrupted += r.interruptedToolCalls;
      }
      return (await hubs.store.listToolCalls(s.id))[0]?.status === 'interrupted';
    });
    const f = (await agent.waitFor((x) => x.t === 'tool_result' && x.id === 'tc_stale')) as ToolResultFrame;
    expect(f).toMatchObject({ ok: false, error: INTERRUPTED });
    // Counted once, whichever instance swept it (opportunistic runs from requests may have).
    expect(interrupted).toBeLessThanOrEqual(1);
    expect(await hubs.store.listToolCalls(s.id)).toMatchObject([{ status: 'interrupted', errorCode: 'tool_failed', result: { ok: false, error: INTERRUPTED } }]);
  });

  it('hub.maintain() reports interruptedToolCalls and a WebSocket machine gets the error', async () => {
    const t = await startTestHub({ maintenance: { intervalMs: 600_000 } });
    closers.push(() => t.close());
    const { machineToken, machineId } = await t.pair('alice');
    const a: FakeAgent = await connectFakeAgent({ url: t.wsUrl, token: machineToken });
    closers.push(() => a.close());
    const past = new Date(Date.now() - 60_000).toISOString();
    await t.store.claimToolCall(
      { id: 'tcl_stale0000002', callId: 'tc_ws_stale', sessionId: 'ses_x', runId: 'run_x', userId: 'alice', machineId, tool: 'slow', args: null, status: 'running', startedAt: past },
      { leaseUntil: past, now: past },
    );
    const report = await t.hub.maintain();
    expect(report).toMatchObject({ ran: true, interruptedToolCalls: 1 });
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_ws_stale')).toMatchObject({ ok: false, error: INTERRUPTED });
    expect((await t.hub.maintain()).interruptedToolCalls).toBe(0);
  });
});

describe('WebSocket reconnect', () => {
  it('WS: the agent resends a pending tool_call after reconnecting and gets the stored result', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = defineTool({
      name: 'gated',
      description: 'x',
      input: z.object({}),
      handler: async (_a, ctx) => {
        runs++;
        await gate;
        return ctx.signal.aborted ? 'aborted' : 'finished';
      },
    });
    const t = await startTestHub({ tools: [gated], runIndexWaitMs: 500 });
    closers.push(() => t.close());
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    closers.push(() => a.close());
    const s = (await (await t.as('alice', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
    const run = (await (await t.as('alice', `/sessions/${s.id}/runs`, json({ prompt: 'go' }, { 'idempotency-key': 'k1' }))).json()) as Run;
    const call = { t: 'tool_call' as const, id: 'tc_resend', sessionId: s.id, runId: run.id, tool: 'gated', args: {} };
    a.send(call);
    await until(() => runs === 1);
    await a.close(); // the connection drops while the handler runs
    release();
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'ok');
    const b = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    closers.push(() => b.close());
    b.send(call);
    expect(await b.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_resend')).toEqual({
      t: 'tool_result',
      id: 'tc_resend',
      ok: true,
      result: { content: [{ type: 'text', text: 'finished' }] },
    });
    expect(runs).toBe(1);
  });
});

describe('file pulls across instances', () => {
  const big = Buffer.alloc(700 * 1024).map((_, i) => (i * 7) % 251);
  const tree = { 'site/a.bin': big, 'site/index.html': '<h1>hi</h1>', 'site/z.txt': 'zzz' };
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  async function pullAcross(hubOpts: Partial<Parameters<typeof startFaasHubs>[0]>, others: number[]) {
    let got: Array<{ path: string; sha: string }> | undefined;
    const publish = defineTool({
      name: 'publish_site',
      description: 'x',
      input: z.object({}),
      handler: async (_a, ctx) => {
        const out: Array<{ path: string; sha: string }> = [];
        for await (const f of ctx.files.pull('site')) out.push({ path: f.path, sha: sha(f.data) });
        got = out;
        return `published ${out.length}`;
      },
    });
    const ps = pullServer(tree);
    const { hubs, agent, ctx } = await httpSetup([publish], { hub: hubOpts, onFrame: ps.onFrame });
    // The first upstream message processed after the pull started fails to complete once (the
    // store write after its chunk was forwarded): the agent retries the same POST.
    const completeInbox = hubs.store.completeInbox.bind(hubs.store);
    let failed = 0;
    hubs.store.completeInbox = async (machineId, ids, at) => {
      if (ps.pulls.length > 0 && failed === 0) {
        failed++;
        throw new Error('transient store failure');
      }
      return completeInbox(machineId, ids, at);
    };
    routeUpstream(hubs, { to: 0, next: 1, others });
    const start = hubs.requests.length;
    const result = await agent.callTool('publish_site', {}, ctx);
    expect(result).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'published 3' }] } });
    expect(failed).toBe(1);
    expect(got).toEqual([
      { path: 'site/a.bin', sha: sha(big) },
      { path: 'site/index.html', sha: sha(Buffer.from('<h1>hi</h1>')) },
      { path: 'site/z.txt', sha: sha(Buffer.from('zzz')) },
    ]);
    // The chunks reached instances other than the one running the tool.
    const chunkPosts = hubs.requests.slice(start).filter((r) => r.path === '/agent/events' && r.i !== 0);
    expect(chunkPosts.length).toBeGreaterThanOrEqual(4);
    return agent as FakeHttpAgent;
  }

  it('file pull across instances survives a retried POST (duplicate chunk ignored, bytes intact)', async () => {
    await pullAcross({ n: 3 }, [1, 2]);
  }, 30_000);

  it('two hubs on one store + sqlCluster: the pull is assembled on the instance that started it', async () => {
    const pg = new PGlite('memory://');
    await pg.waitReady;
    closers.push(() => pg.close());
    await pullAcross({ n: 2, makeCluster: () => sqlCluster(pg as unknown as SqlClient, { activePollMs: 20, idlePollMs: 200 }) }, [1]);
  }, 30_000);

  it('PullAssembler ignores an exact duplicate chunk and still refuses gaps and changed data', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const a = new PullAssembler('d', 1_000);
    a.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 0, data: b64('ab'), last: false });
    a.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 0, data: b64('ab'), last: false }); // duplicate
    a.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 1, data: b64('cd'), last: true });
    a.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 1, data: b64('cd'), last: true }); // duplicate of a finished file's last chunk
    a.chunk({ t: 'file_chunk', id: 'p', path: 'd/b', seq: 0, data: b64('e'), last: true });
    const out = a.done({ t: 'file_done', id: 'p', files: [{ path: 'd/a', size: 4 }, { path: 'd/b', size: 1 }] });
    expect(out.files.map((f) => [f.path, Buffer.from(f.data).toString()])).toEqual([
      ['d/a', 'abcd'],
      ['d/b', 'e'],
    ]);
    const gap = new PullAssembler('d', 1_000);
    gap.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 0, data: b64('ab'), last: false });
    expect(() => gap.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 2, data: b64('cd'), last: true })).toThrow(/order/);
    const changed = new PullAssembler('d', 1_000);
    changed.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 0, data: b64('ab'), last: false });
    expect(() => changed.chunk({ t: 'file_chunk', id: 'p', path: 'd/a', seq: 0, data: b64('xx'), last: false })).toThrow(/order/);
  });
});

describe('run end across instances', () => {
  it('run end on another instance aborts the handler signal', async () => {
    let signal: AbortSignal | undefined;
    const waits = defineTool({
      name: 'waits',
      description: 'x',
      input: z.object({}),
      handler: (_a, ctx) => {
        signal = ctx.signal;
        return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('late')));
      },
    });
    const { hubs, agent, fm, s, run, ctx } = await httpSetup([waits]);
    // The tool_call runs on instance 0; the run.cancelled events land on 1 or 2.
    routeUpstream(hubs, { to: 0, next: 1, others: [1, 2] });
    const pending = agent.callTool('waits', {}, ctx);
    await until(() => signal !== undefined);
    await agent.events(s.id, [fm.append(s.id, 'run.cancelled', { runId: run.id }, run.id)]);
    await until(() => signal!.aborted);
    // The call is recorded cancelled; the agent's retry gets the stored outcome, never 'late'.
    expect(await pending).toMatchObject({ ok: false, error: { code: 'tool_failed', message: 'Site tool "waits" was cancelled.' } });
    expect(await hubs.store.listToolCalls(s.id)).toMatchObject([{ status: 'cancelled' }]);
  });
});

describe('approvals', () => {
  it('approvals: decide retried after a cut reaches the machine once (same idempotency key)', async () => {
    const applied = new Map<string, number>(); // decision applications per idempotency key
    const commandIds: string[] = [];
    const approval = (sessionId: string, state: 'pending' | 'approved') => ({
      id: 'apr_1',
      sessionId,
      runId: 'run_1',
      runtimeId: 'fake',
      category: 'shell',
      title: 'Run ls',
      target: { command: 'ls' },
      allowedScopes: ['once'],
      availableDecisions: ['allow_once', 'deny'],
      state,
      ...(state === 'approved' ? { decision: 'allow' } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      version: state === 'approved' ? 2 : 1,
    });
    let sid = '';
    let decided: Promise<void> | undefined;
    const { hubs } = await httpSetup([], {
      onCommand: (fm) => async (cmd) => {
        if (cmd.op !== 'decide') return fm.handler(cmd);
        commandIds.push(cmd.id);
        const { idempotencyKey } = cmd.args as { idempotencyKey: string };
        // Like the real agent: a decision is applied once per idempotency key.
        if (!applied.has(idempotencyKey)) applied.set(idempotencyKey, 0);
        if (applied.get(idempotencyKey) === 0) {
          applied.set(idempotencyKey, 1);
          decided = sleep(300).then(() => undefined);
        }
        await decided;
        return approval(sid, 'approved');
      },
    });
    const s = (await (await hubs.as('u1', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
    sid = s.id;
    await hubs.store.putResource('apr_1', 'approval', s.id);
    const decide = () => hubs.as('u1', '/approvals/apr_1/decision', json({ decision: 'allow', scope: 'once' }, { 'idempotency-key': 'dk-1' }));
    const cut = setTimeout(() => hubs.cutAll(), 100);
    let res: Response | undefined;
    let attempts = 0;
    while (!res) {
      attempts++;
      res = await decide().catch(() => undefined);
      if (res && res.status !== 200) res = undefined;
      if (attempts > 50) throw new Error('decide never succeeded');
    }
    clearTimeout(cut);
    expect(await res.json()).toMatchObject({ id: 'apr_1', state: 'approved', decision: 'allow' });
    expect(applied.get('dk-1')).toBe(1);
    expect([...applied.keys()]).toEqual(['dk-1']);
    // Each command the hub sent was dispatched once (no redelivery past the agent's cursor).
    expect(new Set(commandIds).size).toBe(commandIds.length);
  }, 30_000);
});

/** One WebSocket hub with `tools`, a fake machine paired to alice, a session and a run. */
async function wsSetup(tools: SiteTool[], hub: Partial<Parameters<typeof startTestHub>[0]> = {}) {
  const t = await startTestHub({ tools, runIndexWaitMs: 500, maintenance: { intervalMs: 600_000 }, ...hub });
  closers.push(() => t.close());
  const fm = fakeMachine();
  const { machineToken, machineId } = await t.pair('alice');
  const a = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
  closers.push(() => a.close());
  const s = (await (await t.as('alice', '/sessions', json({ runtime: 'fake' }))).json()) as Session;
  const run = (await (await t.as('alice', `/sessions/${s.id}/runs`, json({ prompt: 'go' }, { 'idempotency-key': `k-${Math.random()}` }))).json()) as Run;
  const frame = (id: string, tool: string, args: unknown = {}) => ({ t: 'tool_call' as const, id, sessionId: s.id, runId: run.id, tool, args });
  const resultsFor = (id: string) => a.frames.filter((f): f is ToolResultFrame => f.t === 'tool_result' && f.id === id);
  return { t, a, fm, s, run, machineId, machineToken, frame, resultsFor };
}

describe('stored results come first; one outcome per call', () => {
  it('a resend of a finished call gets its stored result while 8 calls run on the instance, and after its session is gone', async () => {
    let quick = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tools = [
      defineTool({ name: 'quick', description: 'x', input: z.object({}), handler: async () => `quick ${++quick}` }),
      defineTool({ name: 'gated', description: 'x', input: z.object({}), handler: async () => ((await gate), 'gated') }),
    ];
    const { t, a, s, frame } = await wsSetup(tools);
    a.send(frame('tc_done', 'quick'));
    const stored = await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_done');
    for (let i = 0; i < 8; i++) a.send(frame(`tc_g${i}`, 'gated'));
    await until(async () => (await t.store.listToolCalls(s.id)).filter((r) => r.status === 'running').length === 8);
    a.send(frame('tc_over', 'gated'));
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_over')).toMatchObject({ ok: false, error: { details: { reason: 'too_many_concurrent' } } });
    a.frames.length = 0;
    a.send(frame('tc_done', 'quick'));
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_done')).toEqual(stored);
    release();
    await until(async () => (await t.store.listToolCalls(s.id)).every((r) => r.status !== 'running'));
    await t.store.deleteSession(s.id);
    a.frames.length = 0;
    a.send(frame('tc_done', 'quick'));
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_done')).toEqual(stored);
    expect(quick).toBe(1);
  });

  it('a failed result write is retried: fails twice, then stored and sent once', async () => {
    const tool = defineTool({ name: 'quick', description: 'x', input: z.object({}), handler: async () => 'done' });
    const { t, a, s, frame, resultsFor } = await wsSetup([tool]);
    const finish = t.store.finishToolCall.bind(t.store);
    let failures = 0;
    t.store.finishToolCall = async (id, r) => {
      if (failures < 2) {
        failures++;
        throw new Error('store down');
      }
      return finish(id, r);
    };
    a.send(frame('tc_w', 'quick'));
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_w')).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'done' }] } });
    expect(failures).toBe(2);
    expect(await t.store.listToolCalls(s.id)).toMatchObject([{ status: 'ok' }]);
    await sleep(200);
    expect(resultsFor('tc_w')).toHaveLength(1);
  });

  it('a result that can never be stored is never sent: the call ends interrupted, its only outcome', async () => {
    const tool = defineTool({ name: 'quick', description: 'x', input: z.object({}), handler: async () => 'done' });
    const { t, a, s, frame, resultsFor } = await wsSetup([tool], { toolTimeoutMs: 200, toolLeaseGraceMs: 200 });
    const finish = t.store.finishToolCall.bind(t.store);
    t.store.finishToolCall = async (id, r) => {
      if (r.status !== 'interrupted') throw new Error('store down');
      return finish(id, r);
    };
    a.send(frame('tc_never', 'quick'));
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'running');
    await sleep(500); // past the lease (400 ms): the handler gave up
    expect(resultsFor('tc_never')).toEqual([]);
    expect((await t.hub.maintain()).interruptedToolCalls).toBe(1);
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_never')).toMatchObject({ ok: false, error: INTERRUPTED_QUICK });
    await sleep(100);
    expect(resultsFor('tc_never').every((f) => !f.ok)).toBe(true);
  });

  it('lease over while the handler still runs on a live instance: its late result loses to the interrupted one', async () => {
    const tool = defineTool({ name: 'quick', description: 'x', input: z.object({}), handler: async () => 'late ok' });
    const { t, a, s, frame, resultsFor } = await wsSetup([tool], { toolTimeoutMs: 100, toolLeaseGraceMs: 100 });
    const finish = t.store.finishToolCall.bind(t.store);
    t.store.finishToolCall = async (id, r) => {
      if (r.status !== 'interrupted') await sleep(500); // the live instance is slow to store its result
      return finish(id, r);
    };
    a.send(frame('tc_late', 'quick'));
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'running');
    await sleep(300);
    expect((await t.hub.maintain()).interruptedToolCalls).toBe(1);
    await sleep(500);
    const got = resultsFor('tc_late');
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.every((f) => !f.ok && f.error.details?.reason === 'interrupted')).toBe(true);
    expect(await t.store.listToolCalls(s.id)).toMatchObject([{ status: 'interrupted' }]);
  });

  it('cross-node deliver: an interrupted error swept on node A reaches the WebSocket held by node B', async () => {
    const { pgliteHubStore } = await import('./node/index.js');
    const { memoryCluster } = await import('./cluster/memory.js');
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const cluster = memoryCluster();
    closers.push(() => store.close());
    const A = await startTestHub({ store, cluster, maintenance: { intervalMs: 600_000 } });
    closers.push(() => A.close());
    const B = await startTestHub({ store, cluster, maintenance: { intervalMs: 600_000 } });
    closers.push(() => B.close());
    const { machineToken, machineId } = await A.pair('alice');
    const b = await connectFakeAgent({ url: B.wsUrl, token: machineToken });
    closers.push(() => b.close());
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.claimToolCall(
      { id: 'tcl_xnode000001', callId: 'tc_xnode', sessionId: 'ses_x', runId: 'run_x', userId: 'alice', machineId, tool: 'slow', args: null, status: 'running', startedAt: past },
      { leaseUntil: past, now: past },
    );
    expect(await A.hub.maintain()).toMatchObject({ ran: true, interruptedToolCalls: 1 });
    expect(await b.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_xnode')).toMatchObject({ ok: false, error: INTERRUPTED });
    // Nothing went to the outbox: B sent it on the socket.
    expect((await store.pollLink(machineId, '', { after: 0, limit: 10, now: new Date().toISOString() })).items).toEqual([]);
  });

  it('hub.close() lets a running handler finish within toolDrainMs; past it the call ends interrupted', async () => {
    const tools = [
      defineTool({ name: 'quick', description: 'x', input: z.object({}), handler: async () => ((await sleep(200)), 'drained') }),
      defineTool({ name: 'slow', description: 'x', input: z.object({}), handler: () => new Promise(() => undefined) }),
    ];
    const one = await wsSetup(tools, { toolDrainMs: 2_000 });
    one.a.send(one.frame('tc_drain', 'quick'));
    await until(async () => (await one.t.store.listToolCalls(one.s.id))[0]?.status === 'running');
    await one.t.hub.close();
    expect(await one.t.store.listToolCalls(one.s.id)).toMatchObject([{ status: 'ok', result: { ok: true } }]);

    const two = await wsSetup(tools, { toolDrainMs: 100 });
    two.a.send(two.frame('tc_cut', 'slow'));
    await until(async () => (await two.t.store.listToolCalls(two.s.id))[0]?.status === 'running');
    const started = Date.now();
    await two.t.hub.close();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await two.t.store.listToolCalls(two.s.id)).toMatchObject([{ status: 'interrupted', result: { ok: false, error: INTERRUPTED } }]);
  });
});
