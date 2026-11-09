/**
 * Three hub instances sharing one store (and one cluster) like a FaaS deployment: no WebSocket, no
 * sticky routing. The machine's stream is always served by instance X, the browser by Y and every
 * tool-call / upstream POST by Z, until instances are killed. Shared by the in-process test (PGlite +
 * sqlCluster) and the Docker test (one Postgres 16, `postgresHubStore` + `postgresCluster`, own pool
 * per instance).
 */
import { createHash } from 'node:crypto';
import type { ApprovalRequest, Attachment, Session, UncageEvent } from '@uncage/protocol';
import { expect } from 'vitest';
import { z } from 'zod';
import type { ClusterAdapter } from './cluster/cluster.js';
import type { HubStore } from './store/store.js';
import {
  connectFakeHttpAgent,
  fakeMachine,
  pullServer,
  readSse,
  sleep,
  startFaasHubs,
  until,
  uploadReceiver,
  type CommandHandler,
  type FaasHubs,
} from './test-utils.js';
import { defineTool } from './tools.js';

const X = 0; // machine stream
const Y = 1; // browser API + SSE
const Z = 2; // tool calls, upstream POSTs, approval decisions
const MAINTENANCE_INTERVAL_MS = 5_000;
const PING_MS = 150;
const MISSED_PINGS = 2;
const sha = (d: Uint8Array | Buffer): string => createHash('sha256').update(d).digest('hex');
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** A browser reading `GET /sessions/:id/events` like EventSource: resumes after the last event on `reconnect`, a cut or an error. */
function browserStream(hubs: FaasHubs, user: string, sessionId: string) {
  const got: UncageEvent[] = [];
  const state = { last: 0, reconnects: 0, opens: 0 };
  const ac = new AbortController();
  const loop = (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await hubs.as(user, `/sessions/${sessionId}/events?after=${state.last}`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          await sleep(50);
          continue;
        }
        state.opens++;
        for await (const f of readSse(res)) {
          if (f.comment) continue;
          if (f.event === 'reconnect') {
            state.reconnects++;
            break;
          }
          if (f.event === 'error') break;
          const e = JSON.parse(f.data) as UncageEvent;
          got.push(e);
          state.last = e.sequence;
        }
      } catch {
        if (!ac.signal.aborted) await sleep(30); // a cut socket: resume
      }
    }
  })();
  return {
    got,
    state,
    async stop() {
      ac.abort();
      await loop;
    },
  };
}

export async function runFaasScenario(o: { makeStore(): Promise<HubStore>; makeCluster(): ClusterAdapter; streamMaxMs: number }): Promise<void> {
  const pulled: Array<{ path: string; size: number; sha: string }> = [];
  const started = { publish: 0, hang: 0, echo: 0 };
  const publishSite = defineTool({
    name: 'publish_site',
    description: 'Publish the site folder',
    input: z.object({ dir: z.string() }),
    handler: async (args, ctx) => {
      started.publish++;
      for await (const f of ctx.files.pull(args.dir)) pulled.push({ path: f.path, size: f.data.length, sha: sha(f.data) });
      return `published ${pulled.length} files for ${ctx.user.id}`;
    },
  });
  const hang = defineTool({
    name: 'hang_site',
    description: 'Never finishes (its instance is killed)',
    input: z.object({}),
    handler: () => {
      started.hang++;
      return new Promise<string>(() => undefined);
    },
  });
  const echo = defineTool({
    name: 'echo_site',
    description: 'Returns at once',
    input: z.object({}),
    handler: async () => {
      started.echo++;
      return 'echoed';
    },
  });
  const maintenanceRuns: number[] = [];
  /** Runs started by requests (not by an explicit `maintain()` call of this scenario). */
  const opportunisticRuns: number[] = [];
  let explicitCalls = 0;
  const hubs = await startFaasHubs({
    n: 4, // X, Y, Z and a spare: three of them are killed during the run
    perInstance: true,
    makeStore: o.makeStore,
    makeCluster: o.makeCluster,
    tools: [publishSite, hang, echo],
    stream: { maxDurationMs: o.streamMaxMs },
    heartbeat: { pingIntervalMs: PING_MS, missedPings: MISSED_PINGS },
    maintenance: { intervalMs: MAINTENANCE_INTERVAL_MS, onRun: async () => void (maintenanceRuns.push(Date.now()), explicitCalls === 0 && opportunisticRuns.push(Date.now())) },
    toolTimeoutMs: 3_000,
    toolLeaseGraceMs: 500,
    commandTimeoutMs: 15_000,
  } as Parameters<typeof startFaasHubs>[0]);
  const scenarioStart = Date.now();
  const killed = new Set<number>();
  const alive = (i: number): number => (killed.has(i) ? [0, 1, 2, 3].find((k) => !killed.has(k))! : i);
  let rr = 0;
  let approvalHits = 0;
  hubs.route((req) => {
    const path = new URL(req.url).pathname.replace(/^\/api\/uncage/, '');
    if (path === '/agent/events') return alive(Z);
    if (path.startsWith('/agent/')) return alive(X);
    if (path.startsWith('/approvals/')) return alive(approvalHits++ % 2 === 0 ? Z : Y); // duplicate decisions land on two instances
    if (path === '/machines' && rr++ % 4 !== 0) return alive(rr % 4); // spread presence reads over every instance
    return alive(Y);
  });
  const kill = (i: number): void => {
    killed.add(i);
    hubs.kill(i);
  };

  const fm = fakeMachine();
  /** Every `decide` command the hub forwarded (a retry of the same decision is forwarded again: the hub does not dedupe) and the ones the agent applied (it dedupes by idempotency key, like the real agent). */
  const forwarded: Array<{ idempotencyKey: string }> = [];
  const decisions: unknown[] = [];
  const appliedKeys = new Set<string>();
  const approval: ApprovalRequest = {
    id: 'apr_1',
    sessionId: '',
    runId: 'run_1',
    runtimeId: 'fake',
    category: 'shell',
    title: 'Run ls',
    target: { command: 'ls' },
    allowedScopes: ['once'],
    availableDecisions: ['allow_once', 'deny'],
    state: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    version: 1,
  };
  const onCommand: CommandHandler = (cmd) => {
    if (cmd.op === 'decide') {
      const a = cmd.args as { idempotencyKey: string };
      forwarded.push({ idempotencyKey: a.idempotencyKey });
      if (!appliedKeys.has(a.idempotencyKey)) {
        appliedKeys.add(a.idempotencyKey);
        decisions.push(cmd.args);
      }
      return { ...approval, state: 'approved', decision: (cmd.args as { decision: { decision: 'allow' | 'deny' } }).decision.decision, version: 2 };
    }
    return fm.handler(cmd);
  };
  const big = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 7) big[i] = (i / 7) % 251;
  const ps = pullServer({ 'site/index.html': '<h1>hi</h1>', 'site/assets/big.bin': big, 'site/css/app.css': 'body{}', 'other.txt': 'no' });
  const up = uploadReceiver();
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const { token, machineId } = await hubs.pair('alice');
    const agent = await connectFakeHttpAgent({
      hubs,
      token,
      onCommand,
      onFrame: (f, send) => {
        ps.onFrame(f, send);
        up.onFrame(f, send);
      },
    });
    cleanup.push(() => agent.close());

    // ---- presence: online on every instance; the stream is on X ----
    const online = async (): Promise<boolean> => {
      const list = (await (await hubs.as('alice', '/machines')).json()) as Array<{ online: boolean; transport?: string }>;
      return list[0]?.online === true;
    };
    await until(online, 5_000);
    for (let i = 0; i < 6; i++) expect(await online()).toBe(true);
    expect(hubs.requests.filter((r) => r.path === '/agent/stream').every((r) => r.i === X)).toBe(true);

    // ---- sessions: create and list on Y ----
    const created = await hubs.as('alice', '/sessions', json({ runtime: 'fake' }));
    expect(created.status).toBe(201);
    const session = (await created.json()) as Session;
    const listed = (await (await hubs.as('alice', '/sessions')).json()) as Session[];
    expect(listed.map((s) => s.id)).toContain(session.id);
    expect(hubs.requests.filter((r) => r.path === '/sessions' && r.method === 'POST').every((r) => r.i === Y)).toBe(true);
    approval.sessionId = session.id;

    // ---- events over browser SSE on Y, rotated by maxDurationMs, with socket cuts; contiguous, no duplicates ----
    const browser = browserStream(hubs, 'alice', session.id);
    cleanup.push(() => browser.stop());
    const TOTAL_A = 40;
    const cutter = setInterval(() => hubs.cutAll(), Math.round(o.streamMaxMs * 2.5));
    try {
      for (let i = 0; i < TOTAL_A; i++) {
        const e = i === 4 ? fm.append(session.id, 'approval.requested', { approval }, 'run_1') : fm.append(session.id, 'run.updated', { runId: 'run_1', state: 'running' }, 'run_1');
        await agent.events(session.id, [e]);
        await sleep(80);
      }
      await until(() => browser.state.last >= TOTAL_A + 1, 15_000);
    } finally {
      clearInterval(cutter);
    }
    expect(browser.got.map((e) => e.sequence)).toEqual(Array.from({ length: TOTAL_A + 1 }, (_, i) => i + 1));
    expect(browser.state.reconnects).toBeGreaterThanOrEqual(2); // server-initiated rotations
    expect(hubs.requests.filter((r) => r.path.endsWith('/events') && r.path.startsWith('/sessions')).every((r) => r.i === Y)).toBe(true);

    // ---- one approval decided twice at once (two instances, one idempotency key): the hub forwards the key, the agent applies it once ----
    await until(() => hubs.store.getResource(approval.id, 'approval'), 5_000);
    const decide = () => hubs.as('alice', `/approvals/${approval.id}/decision`, json({ decision: 'allow', scope: 'once' }, { 'idempotency-key': 'k1' }));
    const [d1, d2] = await Promise.all([decide(), decide()]);
    expect([d1.status, d2.status]).toEqual([200, 200]);
    expect(await d1.json()).toEqual(await d2.json());
    expect(forwarded.length).toBeGreaterThanOrEqual(1);
    expect(forwarded.every((f) => f.idempotencyKey === 'k1')).toBe(true);
    expect(decisions).toEqual([{ approvalId: approval.id, decision: { decision: 'allow', scope: 'once' }, idempotencyKey: 'k1' }]);
    expect(new Set(hubs.requests.filter((r) => r.path.startsWith('/approvals/')).map((r) => r.i))).toEqual(new Set([Y, Z]));

    // ---- a tool call POSTed to Z pulls a 3-file directory (one 2 MB) while the stream is on X ----
    const started1 = await hubs.as('alice', `/sessions/${session.id}/runs`, json({ prompt: 'publish' }, { 'idempotency-key': 'run-1' }));
    expect(started1.status).toBe(202);
    await until(() => agent.lastRun, 5_000);
    const cutter2 = setInterval(() => hubs.cutAll(), 500);
    let result;
    try {
      result = await agent.callTool('publish_site', { dir: 'site' });
    } finally {
      clearInterval(cutter2);
    }
    expect(result).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'published 3 files for alice' }] } });
    expect(started.publish).toBe(1);
    expect(pulled).toEqual([
      { path: 'site/assets/big.bin', size: big.length, sha: sha(big) },
      { path: 'site/css/app.css', size: 6, sha: sha(Buffer.from('body{}')) },
      { path: 'site/index.html', size: 11, sha: sha(Buffer.from('<h1>hi</h1>')) },
    ]);
    expect(hubs.requests.filter((r) => r.path === '/agent/events').every((r) => r.i === Z)).toBe(true);

    // ---- an 8 MB attachment uploaded from Y reaches the machine intact ----
    const data = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1000) data[i] = (i / 1000) % 256;
    const upRes = await hubs.as('alice', `/sessions/${session.id}/attachments`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-filename': 'big.pdf' }, body: data });
    expect(upRes.status).toBe(201);
    const att = (await upRes.json()) as Attachment;
    expect(att).toMatchObject({ sessionId: session.id, size: data.length, sha256: sha(data) });
    expect(up.received.size).toBe(1);
    const got = [...up.received.values()][0]!;
    expect(got.begin).toMatchObject({ sessionId: session.id, name: 'big.pdf', mime: 'application/pdf', size: data.length });
    expect(got.data!.equals(data)).toBe(true);

    // ---- maintenance: one run per interval across instances (store lease); it prunes expired outbox rows ----
    const past = new Date(Date.now() - 60_000).toISOString();
    const stale = [1, 2, 3].map((n) => ({ msgId: `stale_${n}`, msg: { t: 'ping' as const, at: n }, expiresAt: past }));
    expect(await hubs.store.enqueueOutbox(machineId, stale, new Date().toISOString())).not.toBe('gone');
    const rows = async () =>
      (await hubs.store.pollLink(machineId, agent.linkId, { after: 0, limit: 100, now: '1970-01-01T00:00:00.000Z' })).items.filter((i) => i.msgId.startsWith('stale_')).length;
    expect(await rows()).toBe(3);
    // Acknowledged rows are deleted as the agent acks them: nothing at or below its cursor is left.
    expect((await agent.post({})).status).toBe(200);
    const left = (await hubs.store.pollLink(machineId, agent.linkId, { after: 0, limit: 1_000, now: '1970-01-01T00:00:00.000Z' })).items;
    expect(left.filter((i) => !i.msgId.startsWith('stale_') && i.seq <= agent.cursor)).toEqual([]);
    explicitCalls++;
    const reports = await Promise.all(hubs.hubs.map((h) => h.maintain()));
    const winners = reports.flatMap((r, i) => (r.ran ? [i] : []));
    expect(winners).toHaveLength(1); // a call on the lease holder runs; the others find the lease taken
    expect(await rows()).toBe(0);
    // Within the interval no other instance runs it again.
    const again = await Promise.all(hubs.hubs.map((h, i) => (i === winners[0] ? Promise.resolve({ ran: false }) : h.maintain())));
    expect(again.every((r) => !r.ran)).toBe(true);
    explicitCalls--;

    // ---- Y is killed while the browser reads: it resumes on another instance, nothing lost or repeated ----
    const TOTAL_B = 20;
    for (let i = 0; i < TOTAL_B; i++) {
      await agent.events(session.id, [fm.append(session.id, 'run.updated', { runId: 'run_1', state: 'running' }, 'run_1')]);
      if (i === 5) kill(Y);
      await sleep(40);
    }
    await until(() => browser.state.last >= TOTAL_A + TOTAL_B + 1, 15_000);
    expect(browser.got.map((e) => e.sequence)).toEqual(Array.from({ length: TOTAL_A + TOTAL_B + 1 }, (_, i) => i + 1));
    expect((await (await hubs.as('alice', '/sessions')).json()) as Session[]).toHaveLength(1); // the API still answers on the others

    // ---- Z is killed mid-handler: at-most-once, one interrupted error, the handler started once ----
    const hanging = agent.callTool('hang_site', {});
    await until(() => started.hang === 1, 5_000);
    kill(Z);
    const interrupted = await hanging;
    expect(interrupted).toMatchObject({ ok: false, error: { details: { reason: 'interrupted' } } });
    expect(started.hang).toBe(1);
    await until(async () => (await hubs.store.listToolCalls(session.id)).every((r) => r.status !== 'running'), 15_000);
    const audit = await hubs.store.listToolCalls(session.id);
    expect(audit.filter((r) => r.tool === 'publish_site').map((r) => r.status)).toEqual(['ok']);
    expect(audit.filter((r) => r.tool === 'hang_site').map((r) => r.status)).toEqual(['interrupted']);

    // ---- X (the machine's stream host) is killed: the agent reconnects through another instance, events flow, a tool call still completes ----
    const TOTAL_C = 15;
    for (let i = 0; i < TOTAL_C; i++) {
      await agent.events(session.id, [fm.append(session.id, 'run.updated', { runId: 'run_1', state: 'running' }, 'run_1')]);
      if (i === 4) kill(X);
      await sleep(40);
    }
    const total = TOTAL_A + TOTAL_B + TOTAL_C + 1;
    await until(() => browser.state.last >= total, 15_000);
    expect(browser.got.map((e) => e.sequence)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(await agent.callTool('echo_site', {})).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'echoed' }] } });
    expect(started.echo).toBe(1);
    expect(hubs.requests.filter((r) => r.path === '/agent/stream').some((r) => r.i === 3)).toBe(true);

    // ---- the agent disconnects without a goodbye: offline on a live instance within the presence TTL ----
    expect(await online()).toBe(true);
    const ttlMs = PING_MS * (MISSED_PINGS + 1);
    agent.stop();
    const t0 = Date.now();
    await until(async () => !(await online()), ttlMs + 4_000);
    expect(Date.now() - t0).toBeLessThan(ttlMs * 4 + 2_000);

    // Maintenance ran about once per interval for the whole scenario, not once per instance.
    const elapsedMs = Date.now() - scenarioStart;
    expect(maintenanceRuns.length).toBeLessThanOrEqual(Math.floor(elapsedMs / MAINTENANCE_INTERVAL_MS) + 3);
    // Runs started by requests on any instance are at least an interval apart (the timestamp is a run's end: allow its duration).
    for (let i = 1; i < opportunisticRuns.length; i++) expect(opportunisticRuns[i]! - opportunisticRuns[i - 1]!).toBeGreaterThan(MAINTENANCE_INTERVAL_MS - 1_000);

    // Every command reached the machine once.
    const ops = agent.commands.map((c) => c.op);
    expect(ops.filter((op) => op === 'decide')).toHaveLength(forwarded.length); // each forwarded decision dispatched once; applied once (above)
    expect(ops.filter((op) => op === 'startRun')).toHaveLength(1);
    expect(new Set(agent.commands.map((c) => c.id)).size).toBe(agent.commands.length);
  } finally {
    for (const c of cleanup.reverse()) await c().catch(() => undefined);
    await hubs.close();
  }
}
