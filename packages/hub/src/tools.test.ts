import type { HubFrame, Session } from '@uncage/protocol';
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

/** A hub with `tools`, a fake machine paired to alice, and one session. */
async function setup(tools: SiteTool[], o: { onFrame?: Parameters<typeof connectFakeAgent>[0]['onFrame']; toolTimeoutMs?: number } = {}) {
  const t = (th = await startTestHub({ tools, ...(o.toolTimeoutMs ? { toolTimeoutMs: o.toolTimeoutMs } : {}) }));
  const fm = fakeMachine();
  const { machineToken, machineId } = await t.pair('alice');
  const a = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler, ...(o.onFrame ? { onFrame: o.onFrame } : {}) });
  agents.push(a);
  const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
  let n = 0;
  const call = async (tool: string, args: unknown, runId = 'run_1'): Promise<ToolResultFrame> => {
    const id = `tc_${++n}`;
    a.send({ t: 'tool_call', id, sessionId: s.id, runId, tool, args });
    return (await a.waitFor((f) => f.t === 'tool_result' && f.id === id, 8000)) as ToolResultFrame;
  };
  return { t, a, s, fm, machineId, call };
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
    const { t, s, call, machineId } = await setup([lookup]);
    const r = await call('lookup_order', { id: 'A-1' });
    expect(r).toEqual({ t: 'tool_result', id: 'tc_1', ok: true, result: { content: [{ type: 'json', json: { order: 'A-1', user: 'alice' } }] } });
    expect(seen!.args).toEqual({ id: 'A-1', limit: 5 }); // parsed (defaults applied)
    expect(seen!.ctx).toMatchObject({ user: { id: 'alice' }, sessionId: s.id, runId: 'run_1' });
    const audit = await until(async () => {
      const rows = await t.store.listToolCalls(s.id);
      return rows[0]?.status === 'ok' ? rows : null;
    });
    expect(audit!).toEqual([
      expect.objectContaining({ callId: 'tc_1', sessionId: s.id, runId: 'run_1', userId: 'alice', machineId, tool: 'lookup_order', args: { id: 'A-1' }, status: 'ok' }),
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
    const { t, s, call } = await setup([tool], { toolTimeoutMs: 150 });
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
    const { t, a, s, fm } = await setup([tool]);
    a.send({ t: 'tool_call', id: 'tc_x', sessionId: s.id, runId: 'run_9', tool: 'waits', args: {} });
    await until(() => signal !== undefined);
    a.sendEvents(s.id, [fm.append(s.id, 'run.cancelled', { runId: 'run_9' }, 'run_9')]);
    await until(() => signal!.aborted);
    await sleep(100);
    expect(a.frames.some((f) => f.t === 'tool_result' && f.id === 'tc_x')).toBe(false);
    await until(async () => (await t.store.listToolCalls(s.id))[0]?.status === 'cancelled');
  });

  it('refuses unknown tools, foreign sessions and runs of another session', async () => {
    const tool = defineTool({ name: 'ok_tool', description: 'x', input: z.object({}), handler: async () => 'ok' });
    const { t, a, s, call, fm } = await setup([tool]);
    expect(await call('nope_tool', {})).toMatchObject({ ok: false, error: { code: 'tool_failed', message: expect.stringContaining('Unknown site tool') } });
    a.send({ t: 'tool_call', id: 'tc_f', sessionId: 'ses_other', runId: 'run_1', tool: 'ok_tool', args: {} });
    expect(await a.waitFor((f) => f.t === 'tool_result' && f.id === 'tc_f')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // run_b belongs to another session of this machine
    const s2 = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    a.sendEvents(s2.id, [fm.append(s2.id, 'run.started', { run: { id: 'run_b', sessionId: s2.id, state: 'running', createdAt: new Date().toISOString(), prompt: 'x' } as never }, 'run_b')]);
    await until(async () => (await t.store.getResource('run_b', 'run'))?.sessionId === s2.id);
    expect(await call('ok_tool', {}, 'run_b')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await call('ok_tool', {}, 'run_1')).toMatchObject({ ok: true });
    void s;
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
    const tool = defineTool({
      name: 'inspect',
      description: 'x',
      input: z.object({}),
      handler: async (_a, ctx) => {
        const pull = ctx.files.pull('site', { maxBytes: 5 * 1024 * 1024 });
        for await (const f of pull) void f;
        skipped = pull.skipped;
        text = Buffer.from(await ctx.files.read('notes.txt')).toString();
        dirErr = await ctx.files.read('site').catch((e: unknown) => e);
        return 'ok';
      },
    });
    const ps = pullServer(tree, { skipped: [{ path: 'site/link.bin', reason: 'more than one hard link' }] });
    const { call } = await setup([tool], { onFrame: ps.onFrame });
    expect(await call('inspect', {})).toMatchObject({ ok: true });
    expect(skipped).toEqual([{ path: 'site/link.bin', reason: 'more than one hard link' }]);
    expect(text).toBe('n');
    expect(dirErr).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('directory') });
    expect(ps.pulls.map((p) => p.maxBytes)).toEqual([5 * 1024 * 1024, 10 * 1024 * 1024, 10 * 1024 * 1024]);
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

