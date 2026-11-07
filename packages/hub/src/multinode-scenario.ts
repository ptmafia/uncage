/**
 * Two hub nodes sharing one cluster adapter and one store: the machine connects to node A, the
 * browser talks to node B only. Shared by the in-process test (ioredis-mock + PGlite) and the
 * Docker test (real Redis + Postgres).
 */
import { createHash } from 'node:crypto';
import type { ApprovalRequest, Attachment, Session, UncageEvent } from '@uncage/protocol';
import { expect } from 'vitest';
import { z } from 'zod';
import type { ClusterAdapter } from './cluster/cluster.js';
import type { HubStore } from './store/store.js';
import {
  connectFakeAgent,
  fakeMachine,
  makeEvent,
  pullServer,
  readSse,
  startTestHub,
  until,
  uploadReceiver,
  type CommandHandler,
} from './test-utils.js';
import { defineTool } from './tools.js';

export async function runMultiNodeScenario(o: { clusterA: ClusterAdapter; clusterB: ClusterAdapter; store: HubStore }): Promise<void> {
  const pulled: Array<{ path: string; text: string }> = [];
  const publishSite = defineTool({
    name: 'publish_site',
    description: 'Publish the site folder',
    input: z.object({ dir: z.string() }),
    handler: async (args, ctx) => {
      for await (const f of ctx.files.pull(args.dir)) pulled.push({ path: f.path, text: Buffer.from(f.data).toString() });
      return `published ${pulled.length} files for ${ctx.user.id}`;
    },
  });
  const A = await startTestHub({ store: o.store, cluster: o.clusterA, tools: [publishSite], commandTimeoutMs: 15_000 });
  const B = await startTestHub({ store: o.store, cluster: o.clusterB, tools: [publishSite], commandTimeoutMs: 15_000 });
  const fm = fakeMachine();
  const decisions: unknown[] = [];
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
      decisions.push(cmd.args);
      return { ...approval, state: 'approved', decision: (cmd.args as { decision: { decision: 'allow' | 'deny' } }).decision.decision, version: 2 };
    }
    return fm.handler(cmd);
  };
  const ps = pullServer({ 'site/index.html': '<h1>hi</h1>', 'site/css/app.css': 'body{}', 'site/js/app.js': 'go()', 'other.txt': 'no' });
  const up = uploadReceiver();
  try {
    const { machineToken } = await A.pair('alice');
    const agent = await connectFakeAgent({
      url: A.wsUrl,
      token: machineToken,
      onCommand,
      onFrame: (f, send) => {
        ps.onFrame(f, send);
        up.onFrame(f, send);
      },
    });
    try {
      // The browser on B sees the machine on A as online.
      await until(async () => ((await (await B.as('alice', '/machines')).json()) as Array<{ online: boolean }>)[0]?.online, 5000);

      // Create a session through B.
      const res = await B.as('alice', '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'fake' }) });
      expect(res.status).toBe(201);
      const session = (await res.json()) as Session;
      expect(fm.sessions.has(session.id)).toBe(true);

      // Stream events from B while the machine sends them to A.
      const sse = await B.as('alice', `/sessions/${session.id}/events?after=1`, { headers: { accept: 'text/event-stream' } });
      expect(sse.status).toBe(200);
      const frames = readSse(sse);
      const nextEvent = async (): Promise<UncageEvent> => {
        for (;;) {
          const { value, done } = await frames.next();
          if (done) throw new Error('stream ended');
          if (!value.comment && value.event !== 'error') return JSON.parse(value.data) as UncageEvent;
        }
      };
      approval.sessionId = session.id;
      const requested = fm.append(session.id, 'approval.requested', { approval }, 'run_1');
      // The machine sends the event to A (B gets it live over the cluster or from history,
      // whichever comes first; the stream dedupes by sequence).
      agent.sendEvents(session.id, [requested]);
      for (;;) {
        const e = await nextEvent();
        if (e.type === 'approval.requested') {
          expect(e.sequence).toBe(requested.sequence);
          break;
        }
      }
      // An event the machine's history does not have can only reach B live, through the cluster.
      const live = makeEvent(session.id, requested.sequence + 1, 'run.updated', { runId: 'run_1', state: 'running' }, 'run_1');
      const resend = setInterval(() => agent.sendEvents(session.id, [live]), 50);
      try {
        for (;;) {
          const e = await nextEvent();
          if (e.sequence === live.sequence) {
            expect(e.type).toBe('run.updated');
            break;
          }
        }
      } finally {
        clearInterval(resend);
      }
      await frames.return(undefined);

      // Approve once from B: exactly one decision reaches the machine.
      await until(() => o.store.getResource(approval.id, 'approval'), 5000);
      const dec = await B.as('alice', `/approvals/${approval.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
        body: JSON.stringify({ decision: 'allow', scope: 'once' }),
      });
      expect(dec.status).toBe(200);
      expect(decisions).toEqual([{ approvalId: approval.id, decision: { decision: 'allow', scope: 'once' }, idempotencyKey: 'k1' }]);

      // Tool call on A (where the machine is) pulls a 3-file directory over the file channel.
      agent.send({ t: 'tool_call', id: 'tc_1', sessionId: session.id, runId: 'run_1', tool: 'publish_site', args: { dir: 'site' } });
      const result = await agent.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_1', 8000);
      expect(result).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'published 3 files for alice' }] } });
      expect(pulled).toEqual([
        { path: 'site/css/app.css', text: 'body{}' },
        { path: 'site/index.html', text: '<h1>hi</h1>' },
        { path: 'site/js/app.js', text: 'go()' },
      ]);

      // An 8 MB attachment uploaded through B reaches the machine on A intact.
      const data = Buffer.alloc(8 * 1024 * 1024);
      for (let i = 0; i < data.length; i += 1000) data[i] = (i / 1000) % 256;
      const upRes = await B.as('alice', `/sessions/${session.id}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-filename': 'big.pdf' },
        body: data,
      });
      expect(upRes.status).toBe(201);
      const att = (await upRes.json()) as Attachment;
      expect(att).toMatchObject({ sessionId: session.id, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      const got = [...up.received.values()][0]!;
      expect(got.begin).toMatchObject({ sessionId: session.id, name: 'big.pdf', mime: 'application/pdf', size: data.length });
      expect(got.data!.equals(data)).toBe(true);
      // Served back from the shared store by either node.
      const dl = await A.as('alice', `/attachments/${att.id}`);
      expect(Buffer.from(await dl.arrayBuffer()).equals(data)).toBe(true);

      // The tool call was audited in the shared store.
      const audit = await until(async () => (await o.store.listToolCalls(session.id)).find((r) => r.status === 'ok'));
      expect(audit).toMatchObject({ tool: 'publish_site', userId: 'alice', callId: 'tc_1' });
    } finally {
      await agent.close();
    }
  } finally {
    await A.close();
    await B.close();
  }
}
