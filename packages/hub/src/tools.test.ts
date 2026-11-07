import type { HubFrame, Run, Session } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  connectFakeAgent,
  fakeMachine,
  pullServer,
  sleep,
  startTestHub,
  until,
  type FakeAgent,
  type TestHub,
} from './test-utils.js';
import { defineTool, normalizeToolResult, toToolSpec, type SiteTool, type ToolContext } from './tools.js';

let th: TestHub | undefined;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await th?.close();
  th = undefined;
});

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type ToolResultFrame = Extract<HubFrame, { t: 'tool_result' }>;

/** A hub with `tools`, a fake machine paired to alice, one session and one run started through the hub. */
async function setup(
  tools: SiteTool[],
  o: { onFrame?: Parameters<typeof connectFakeAgent>[0]['onFrame']; hub?: Parameters<typeof startTestHub>[0] } = {},
) {
  const t = (th = await startTestHub({ tools, runIndexWaitMs: 200, ...o.hub }));
  const fm = fakeMachine();
  const { machineToken, machineId } = await t.pair('alice');
  const a = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler, ...(o.onFrame ? { onFrame: o.onFrame } : {}) });
  agents.push(a);
  const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
  const startRun = async (sessionId = s.id, key = `k-${Math.random()}`): Promise<Run> => {
    const res = await t.as('alice', `/sessions/${sessionId}/runs`, { ...post({ prompt: 'go' }), headers: { 'content-type': 'application/json', 'idempotency-key': key } });
    expect(res.status).toBe(202);
    return (await res.json()) as Run;
  };
  const run = await startRun();
  let n = 0;
  const send = (tool: string, args: unknown, runId = run.id, sessionId = s.id): string => {
    const id = `tc_${++n}`;
    a.send({ t: 'tool_call', id, sessionId, runId, tool, args });
    return id;
  };
  const result = async (id: string) => (await a.waitFor((f) => f.t === 'tool_result' && f.id === id, 8000)) as ToolResultFrame;
  const call = async (tool: string, args: unknown, runId = run.id): Promise<ToolResultFrame> => result(send(tool, args, runId));
  return { t, a, s, fm, machineId, run, startRun, send, result, call };
}

describe('defineTool / normalizeToolResult', () => {
  it('turns zod input into JSON Schema for the manifest', () => {
    const spec = toToolSpec(
      defineTool({ name: 'find_order', description: 'Find', input: z.object({ id: z.string(), limit: z.number().default(5) }), handler: async () => 'x' }),
    );
    expect(spec).toMatchObject({ name: 'find_order', requiresConfirmation: false, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
  });

  it('normalizes strings, objects and ToolCallResults', () => {
    expect(normalizeToolResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(normalizeToolResult({ a: 1 })).toEqual({ content: [{ type: 'json', json: { a: 1 } }] });
    expect(normalizeToolResult([1, 2])).toEqual({ content: [{ type: 'json', json: [1, 2] }] });
    const r = { content: [{ type: 'text' as const, text: 'x' }], isError: true };
    expect(normalizeToolResult(r)).toEqual(r);
    expect(normalizeToolResult(undefined)).toEqual({ content: [] });
  });
});

describe('site tool execution on the hub', () => {
  it('validates args with the zod input, runs the handler as the session owner, normalizes and audits', async () => {
    let seen: { args: unknown; ctx: ToolContext } | undefined;
    const lookup = defineTool({
      name: 'lookup_order',
      description: 'Look up an order',
      input: z.object({ id: z.string(), limit: z.number().default(5) }),
      handler: async (args, ctx) => {
        seen = { args, ctx };
        return { order: args.id, user: ctx.user.id };
      },
    });
    const { t, s, call, machineId, run } = await setup([lookup]);
    const r = await call('lookup_order', { id: 'A-1' });
    expect(r).toEqual({ t: 'tool_result', id: 'tc_1', ok: true, result: { content: [{ type: 'json', json: { order: 'A-1', user: 'alice' } }] } });
    expect(seen!.args).toEqual({ id: 'A-1', limit: 5 }); // parsed (defaults applied)
    expect(seen!.ctx).toMatchObject({ user: { id: 'alice' }, sessionId: s.id, runId: run.id });
    const audit = await until(async () => {
      const rows = await t.store.listToolCalls(s.id);
      return rows[0]?.status === 'ok' ? rows : null;
    });
    expect(audit!).toEqual([
      expect.objectContaining({ callId: 'tc_1', sessionId: s.id, runId: run.id, userId: 'alice', machineId, tool: 'lookup_order', args: { id: 'A-1' }, status: 'ok' }),
    ]);
    expect(audit![0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses args that fail the zod input (handler not called) with invalid_request', async () => {
    let called = false;
    const tool = defineTool({ name: 'strict_tool', description: 'x', input: z.object({ n: z.number().int().max(10) }), handler: async () => ((called = true), 'x') });
    const { t, s, call } = await setup([tool]);
    const r = await call('strict_tool', { n: 99 });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringContaining('n:') } });
    expect(called).toBe(false);
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'invalid');
  });

  it('a handler error becomes tool_failed with its message', async () => {
    const tool = defineTool({ name: 'boom', description: 'x', input: z.object({}), handler: async () => { throw new Error('inventory service down'); } });
    const { t, s, call } = await setup([tool]);
    expect(await call('boom', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', message: 'inventory service down' } });
    const row = await until(async () => (await t.store.listToolCalls(s.id)).find((x) => x.status === 'error'));
    expect(row).toMatchObject({ errorCode: 'tool_failed', errorMessage: 'inventory service down' });
  });

  it('times out slow handlers (and aborts their signal)', async () => {
    let signal: AbortSignal | undefined;
    const tool = defineTool({
      name: 'slow',
      description: 'x',
      input: z.object({}),
      handler: (_a, ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      },
    });
    const { t, s, call } = await setup([tool], { hub: { toolTimeoutMs: 150 } });
    expect(await call('slow', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', message: expect.stringContaining('did not finish') } });
    expect(signal?.aborted).toBe(true);
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'timeout');
  });

  it('drops a pending call when its run ends (no tool_result, handler signal aborted)', async () => {
    let signal: AbortSignal | undefined;
    const tool = defineTool({
      name: 'waits',
      description: 'x',
      input: z.object({}),
      handler: (_a, ctx) => {
        signal = ctx.signal;
        return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('late')));
      },
    });
    const { t, a, s, fm, run, send } = await setup([tool]);
    const id = send('waits', {});
    await until(() => signal !== undefined);
    a.sendEvents(s.id, [fm.append(s.id, 'run.cancelled', { runId: run.id }, run.id)]);
    await until(() => signal!.aborted);
    await sleep(100);
    expect(a.frames.some((f) => f.t === 'tool_result' && f.id === id)).toBe(false);
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'cancelled');
  });

  it('refuses unknown tools, foreign sessions, runs of another session and runs not started through the hub', async () => {
    let calls = 0;
    const tool = defineTool({ name: 'ok_tool', description: 'x', input: z.object({}), handler: async () => ((calls++), 'ok') });
    const { s, call, send, result, startRun } = await setup([tool]);
    expect(await call('nope_tool', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', details: { reason: 'not_in_manifest' } } });
    expect(await result(send('ok_tool', {}, undefined, 'ses_other'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // A run of another session of this machine.
    const s2 = (await (await th!.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    const run2 = await startRun(s2.id);
    expect(await call('ok_tool', {}, run2.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // A run id the hub never started (and never sees bound): refused after the short wait.
    expect(await call('ok_tool', {}, 'run_made_up')).toMatchObject({ ok: false, error: { code: 'not_found', details: { reason: 'run_not_indexed' } } });
    expect(calls).toBe(0);
    expect(await call('ok_tool', {})).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    void s;
  });

  it('only tools in the run\'s manifest can be called: a registered tool selectManifest withheld is refused', async () => {
    let secretRuns = 0;
    const open = defineTool({ name: 'open_tool', description: 'x', input: z.object({}), handler: async () => 'open' });
    const secret = defineTool({ name: 'admin_tool', description: 'x', input: z.object({}), handler: async () => ((secretRuns++), 'secret') });
    const { call, fm, run } = await setup([open, secret], { hub: { selectManifest: async () => ({ tools: ['open_tool'], skills: [] }) } });
    expect(fm.manifests.get(run.id)?.tools.map((x) => x.name)).toEqual(['open_tool']);
    expect(await call('admin_tool', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', details: { reason: 'not_in_manifest' } } });
    expect(secretRuns).toBe(0);
    expect(await call('open_tool', {})).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'open' }] } });
  });

  it('a tool call racing the startRun result waits for the run to be bound', async () => {
    const tool = defineTool({ name: 'ok_tool', description: 'x', input: z.object({}), handler: async () => 'ok' });
    const { t, s, fm, run, send, result, a } = await setup([tool], { hub: { runIndexWaitMs: 5000 } });
    // Hold the hub's binding of the next run id back: the machine calls the tool before it lands.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bind = t.store.bindRunManifest.bind(t.store);
    t.store.bindRunManifest = async (k, id) => {
      await gate;
      return bind(k, id);
    };
    const pending = t.as('alice', `/sessions/${s.id}/runs`, { ...post({ prompt: 'go' }), headers: { 'content-type': 'application/json', 'idempotency-key': 'race' } });
    const runId = await until(() => [...fm.manifests.keys()].find((id) => id !== run.id));
    const id = send('ok_tool', {}, runId);
    await sleep(300);
    expect(a.frames.some((f) => f.t === 'tool_result' && f.id === id)).toBe(false);
    release();
    expect(await result(id)).toMatchObject({ ok: true });
    expect((await pending).status).toBe(202);
  });

  it('caps concurrent tool calls per connection (too_many_concurrent)', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<string>((r) => (release = () => r('done')));
    const tool = defineTool({ name: 'slow_tool', description: 'x', input: z.object({}), handler: async () => ((started++), gate) });
    const { send, result } = await setup([tool], { hub: { maxConcurrentToolCalls: 2 } });
    const ids = [send('slow_tool', {}), send('slow_tool', {}), send('slow_tool', {})];
    expect(await result(ids[2]!)).toMatchObject({ ok: false, error: { code: 'tool_failed', details: { reason: 'too_many_concurrent' } } });
    await until(() => started === 2);
    release();
    expect(await result(ids[0]!)).toMatchObject({ ok: true });
    expect(await result(ids[1]!)).toMatchObject({ ok: true });
    expect(await result(send('slow_tool', {}))).toMatchObject({ ok: true }); // slots freed
  });

  it('fails cleanly when the result is too large for one frame', async () => {
    const tool = defineTool({ name: 'huge', description: 'x', input: z.object({}), handler: async () => 'x'.repeat(2_000_000) });
    const { call } = await setup([tool]);
    expect(await call('huge', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', message: expect.stringContaining('too large') } });
  });
});

describe('ctx.files (file channel)', () => {
  const big = Buffer.alloc(600 * 1024, 120);
  const tree = { 'site/index.html': '<h1>hi</h1>', 'site/css/app.css': big, 'site/js/app.js': 'console.log(1)', 'notes.txt': 'n' };

  it('pull streams every file of a directory (multi-chunk files reassembled)', async () => {
    const got: Array<{ path: string; size: number; text?: string }> = [];
    const tool = defineTool({
      name: 'publish_site',
      description: 'x',
      input: z.object({ dir: z.string() }),
      handler: async (args, ctx) => {
        for await (const f of ctx.files.pull(args.dir)) got.push({ path: f.path, size: f.data.byteLength, ...(f.data.byteLength < 100 ? { text: Buffer.from(f.data).toString() } : {}) });
        return `published ${got.length} files`;
      },
    });
    const ps = pullServer(tree);
    const { call, s } = await setup([tool], { onFrame: ps.onFrame });
    expect(await call('publish_site', { dir: 'site' })).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'published 3 files' }] } });
    expect(got).toEqual([
      { path: 'site/css/app.css', size: big.length },
      { path: 'site/index.html', size: 11, text: '<h1>hi</h1>' },
      { path: 'site/js/app.js', size: 14, text: 'console.log(1)' },
    ]);
    expect(ps.pulls[0]).toMatchObject({ sessionId: s.id, path: 'site', maxBytes: 50 * 1024 * 1024 });
  });

  it('an error result mid-pull discards received chunks and rejects the pull', async () => {
    let yielded = 0;
    const tool = defineTool({
      name: 'pull_fail',
      description: 'x',
      input: z.object({}),
      handler: async (_a, ctx) => {
        for await (const f of ctx.files.pull('site')) yielded += f ? 1 : 0;
        return 'unreachable';
      },
    });
    const ps = pullServer(tree, { fail: true });
    const { call } = await setup([tool], { onFrame: ps.onFrame });
    const r = await call('pull_fail', {});
    expect(r).toMatchObject({ ok: false, error: { code: 'tool_failed', message: expect.stringContaining('changed while it was being pulled') } });
    expect(yielded).toBe(0);
  });

  it('reports files the machine skipped; read() returns one file and refuses directories', async () => {
    let skipped: unknown;
    let text = '';
    let dirErr: unknown;
    let missingErr: unknown;
    let escapeErr: unknown;
    const tool = defineTool({
      name: 'inspect',
      description: 'x',
      input: z.object({}),
      handler: async (_a, ctx) => {
        const pull = ctx.files.pull('site', { maxBytes: 5 * 1024 * 1024 });
        for await (const f of pull) void f;
        skipped = pull.skipped;
        text = Buffer.from(await ctx.files.read('./notes.txt')).toString(); // normalized to notes.txt
        dirErr = await ctx.files.read('site/').catch((e: unknown) => e);
        missingErr = await ctx.files.read('nope.txt').catch((e: unknown) => e);
        escapeErr = await ctx.files.read('../etc/passwd').catch((e: unknown) => e);
        return 'ok';
      },
    });
    const ps = pullServer(tree, { skipped: [{ path: 'site/link.bin', reason: 'more than one hard link' }] });
    const { call } = await setup([tool], { onFrame: ps.onFrame });
    expect(await call('inspect', {})).toMatchObject({ ok: true });
    expect(skipped).toEqual([{ path: 'site/link.bin', reason: 'more than one hard link' }]);
    expect(text).toBe('n');
    expect(dirErr).toMatchObject({ code: 'invalid_request', message: '"site" is a directory, not a file.', details: { reason: 'is_directory' } });
    expect(missingErr).toMatchObject({ code: 'not_found', message: '"nope.txt" does not exist in the session workspace.' });
    expect(escapeErr).toMatchObject({ code: 'invalid_request' });
    expect(ps.pulls.map((p) => [p.path, p.maxBytes])).toEqual([
      ['site', 5 * 1024 * 1024],
      ['notes.txt', 10 * 1024 * 1024],
      ['site', 10 * 1024 * 1024],
      ['nope.txt', 10 * 1024 * 1024],
    ]);
  });

  it('refuses chunks that break the stream rules (out of order / more than maxBytes)', async () => {
    const errors: unknown[] = [];
    const tool = defineTool({
      name: 'strict_pull',
      description: 'x',
      input: z.object({ max: z.number() }),
      handler: async (a, ctx) => {
        try {
          for await (const f of ctx.files.pull('x', { maxBytes: a.max })) void f;
        } catch (e) {
          errors.push(e);
        }
        return 'done';
      },
    });
    const onFrame: Parameters<typeof connectFakeAgent>[0]['onFrame'] = (f, send) => {
      if (f.t !== 'file_pull') return;
      if (f.maxBytes === 1) {
        send({ t: 'file_chunk', id: f.id, path: 'x/a', seq: 0, data: Buffer.from('abc').toString('base64'), last: true });
      } else {
        send({ t: 'file_chunk', id: f.id, path: 'x/a', seq: 1, data: '', last: true });
      }
      send({ t: 'file_done', id: f.id, files: [{ path: 'x/a', size: 3 }] });
    };
    const { call } = await setup([tool], { onFrame });
    await call('strict_pull', { max: 1 });
    await call('strict_pull', { max: 100 });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('maxBytes') });
    expect(errors[1]).toMatchObject({ message: expect.stringContaining('order') });
  });
});

