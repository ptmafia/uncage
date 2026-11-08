/**
 * Two real hub nodes sharing one Redis (ioredis-mock) and one store, with the real agent: the
 * machine is connected to node A, the browser only talks to node B.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool, redisCluster, type RedisLike } from '@uncage/hub';
import { pgliteHubStore } from '@uncage/hub/node';
import type { Attachment, Session, UncageEvent } from '@uncage/protocol';
import { createFakeAdapter } from '@uncage/testkit';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from './agent.js';
import { updateAgentSites } from './config.js';
import { FAST, memoryLogger, noExec, startTestHub, tmpHome, until, type TestHub } from './test-helpers.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers, body: JSON.stringify(body) });
const history = async (t: TestHub, sessionId: string): Promise<UncageEvent[]> =>
  (await (await t.as('alice', `/sessions/${sessionId}/events?after=0`, { headers: { accept: 'application/json' } })).json()) as UncageEvent[];

describe('real agent with two hub nodes (machine on A, browser on B)', () => {
  it('session, events, one approval decision, a site tool pulling a 3-file dir, an 8 MB upload', async () => {
    const redis = new RedisMock() as unknown as RedisLike;
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const clusterA = redisCluster({ client: redis });
    const clusterB = redisCluster({ client: redis });
    cleanups.push(() => store.close(), () => clusterA.close(), () => clusterB.close());

    const pulled: string[] = [];
    const publishSite = defineTool({
      name: 'publish_site',
      description: 'Publish a folder of the session workspace',
      input: z.object({ dir: z.string() }),
      handler: async (args, ctx) => {
        for await (const f of ctx.files.pull(args.dir)) pulled.push(`${f.path}=${Buffer.from(f.data).toString()}`);
        return `published ${pulled.length} files as ${ctx.user.id}`;
      },
    });
    const A = await startTestHub({ store, cluster: clusterA, tools: [publishSite] });
    const B = await startTestHub({ store, cluster: clusterB, tools: [publishSite] });
    cleanups.push(() => A.close(), () => B.close());

    const { home, cleanup } = await tmpHome();
    cleanups.push(cleanup);
    const site = await A.pair('alice'); // the machine dials node A
    await updateAgentSites(home, () => [site]);
    const adapter = createFakeAdapter({
      script: [
        { approval: { category: 'shell', title: 'Run ls', target: { command: 'ls' } } },
        { callTool: { name: 'publish_site', args: { dir: 'site' } } },
      ],
      capabilities: { attachments: { images: true, files: true, maxBytes: 10 * 1024 * 1024 } },
    });
    const agent = await createAgent({ config: { sites: [site], localPolicy: { allowBypass: false } }, adapters: () => [adapter], home, logger: memoryLogger(), timing: FAST, exec: noExec });
    cleanups.push(() => agent.close());

    // Browser on B: the machine (on A) is online; create a session through B.
    await until(async () => ((await (await B.as('alice', '/machines')).json()) as Array<{ online: boolean }>)[0]?.online, 8000, 'online via B');
    const created = await B.as('alice', '/sessions', json({ runtime: 'fake' }));
    expect(created.status).toBe(201);
    const session = (await created.json()) as Session;
    await mkdir(join(session.workspace, 'site', 'css'), { recursive: true });
    await writeFile(join(session.workspace, 'site', 'index.html'), '<h1>hi</h1>');
    await writeFile(join(session.workspace, 'site', 'css', 'app.css'), 'body{}');
    await writeFile(join(session.workspace, 'site', 'app.js'), 'go()');

    // Stream events from B while the run executes on the machine behind A.
    const sse = await B.as('alice', `/sessions/${session.id}/events?after=0`, { headers: { accept: 'text/event-stream' } });
    expect(sse.status).toBe(200);
    const run = await B.as('alice', `/sessions/${session.id}/runs`, json({ prompt: 'publish it' }, { 'idempotency-key': 'r1' }));
    expect(run.status).toBe(202);

    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const streamed: UncageEvent[] = [];
    const waitStreamed = async (pred: (e: UncageEvent) => boolean): Promise<UncageEvent> => {
      for (;;) {
        const hit = streamed.find(pred);
        if (hit) return hit;
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data && !block.startsWith(':') && !block.includes('event: error')) streamed.push(JSON.parse(data.slice(6)) as UncageEvent);
        }
      }
    };
    const requested = await waitStreamed((e) => e.type === 'approval.requested');
    if (requested.type !== 'approval.requested') throw new Error('unreachable');
    const approvalId = requested.payload.approval.id;

    // Two decisions race (B and A): the machine accepts exactly one.
    await until(() => store.getResource(approvalId, 'approval'), 5000, 'approval indexed');
    const decide = (t: TestHub, key: string) =>
      t.as('alice', `/approvals/${approvalId}/decision`, json({ decision: 'allow', scope: 'once' }, { 'idempotency-key': key }));
    const [fromB, fromA] = await Promise.all([decide(B, 'kb'), decide(A, 'ka')]);
    expect([fromB.status, fromA.status].sort()).toEqual([200, 409]);

    // The site tool runs on A (where the machine is) and pulls the 3-file directory.
    const done = await waitStreamed((e) => e.type === 'run.completed' || e.type === 'run.failed');
    reader.cancel().catch(() => undefined);
    const all = await history(B, session.id);
    expect(all.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);
    expect(done.type).toBe('run.completed');
    expect(pulled.sort()).toEqual(['site/app.js=go()', 'site/css/app.css=body{}', 'site/index.html=<h1>hi</h1>']);
    expect(all.some((e) => e.type === 'message.completed' && e.payload.text === 'published 3 files as alice')).toBe(true);
    const audit = await store.listToolCalls(session.id);
    expect(audit).toEqual([expect.objectContaining({ tool: 'publish_site', status: 'ok', userId: 'alice', args: { dir: 'site' } })]);

    // An 8 MB attachment uploaded through B lands on the machine intact.
    const data = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 997) data[i] = i % 256;
    const up = await B.as('alice', `/sessions/${session.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'report.pdf' },
      body: data,
    });
    expect(up.status).toBe(201);
    const att = (await up.json()) as Attachment;
    expect(att).toMatchObject({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    const dir = join(session.workspace, '.uncage', 'attachments', session.id);
    const stored = (await readdir(dir)).find((f) => f.startsWith(att.id))!;
    expect((await readFile(join(dir, stored))).equals(data)).toBe(true);
  }, 60_000);
});
