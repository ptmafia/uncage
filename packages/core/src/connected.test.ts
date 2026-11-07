import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import type { RuntimeAdapter, RuntimeCapabilities, SessionManifest, ToolCallResult, UncageEvent } from '@uncage/protocol';
import type { CallTool } from './runs.js';
import { createUncage, type Uncage, type UncageOptions } from './uncage.js';
import { eventsUntil, isTerminal } from './test-utils.js';

const manifest: SessionManifest = {
  tools: [{ name: 'lookup_order', description: 'Look up an order', inputSchema: { type: 'object' }, requiresConfirmation: false }],
  skills: [{ name: 'brand-voice', description: 'Write in brand voice', markdown: '# Brand voice', files: [] }],
};

describe('connected-mode core hooks', () => {
  const open: Uncage[] = [];
  afterEach(async () => {
    for (const u of open.splice(0)) await u.close();
  });

  async function make(adapters: RuntimeAdapter[], extra: Partial<UncageOptions> = {}) {
    const u = await createUncage({ adapters, dataDir: 'memory://', ...extra });
    open.push(u);
    return u;
  }
  const fake = (script: FakeStep[], capabilities: Partial<RuntimeCapabilities> = {}) =>
    createFakeAdapter({ script, capabilities });

  it('onEvent fires once per committed event, in sequence order, for every session', async () => {
    const seen: UncageEvent[] = [];
    const u = await make([fake([{ text: 'Hello world!', chunks: 3 }])], { onEvent: (e) => seen.push(e) });
    const a = await u.sessions.create({ runtime: 'fake', title: 'A' });
    const b = await u.sessions.create({ runtime: 'fake', title: 'B' });
    await a.startRun({ prompt: 'one' });
    await b.startRun({ prompt: 'two' });
    const evA = await eventsUntil(a, isTerminal);
    const evB = await eventsUntil(b, isTerminal);

    for (const [sid, committed] of [
      [a.id, evA],
      [b.id, evB],
    ] as const) {
      const mine = seen.filter((e) => e.sessionId === sid);
      expect(mine.map((e) => e.sequence)).toEqual(committed.map((e) => e.sequence));
      expect(mine.map((e) => e.eventId)).toEqual(committed.map((e) => e.eventId));
    }
  });

  it('a throwing onEvent listener never breaks the run', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as UncageOptions['logger'];
    const u = await make([fake([{ text: 'ok' }])], {
      onEvent: () => {
        throw new Error('listener boom');
      },
      logger,
    });
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'go' });
    const events = await eventsUntil(s, isTerminal);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(error).toHaveBeenCalled();
  });

  it('events.readAfter pages by sequence with a default and maximum limit', async () => {
    const u = await make([fake([{ text: 'abcdefghij', chunks: 10 }])]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'go' });
    const all = await eventsUntil(s, isTerminal);
    expect(all.length).toBeGreaterThan(10);

    expect(await u.events.readAfter(s.id, 0)).toEqual(all);
    const page = await u.events.readAfter(s.id, 2, 3);
    expect(page.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(await u.events.readAfter(s.id, all.at(-1)!.sequence)).toEqual([]);
    // Bad limits are clamped to 1..1000.
    expect(await u.events.readAfter(s.id, 0, 0)).toHaveLength(1);
    expect(await u.events.readAfter(s.id, 0, 5000)).toHaveLength(all.length);
    await expect(u.events.readAfter('ses_missing', 0)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('caps readAfter at 1000 events and defaults to 500', async () => {
    const u = await make([fake([{ text: 'x'.repeat(1200), chunks: 1200 }])]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'go' });
    await eventsUntil(s, isTerminal, { timeoutMs: 20_000 });
    expect(await u.events.readAfter(s.id, 0)).toHaveLength(500);
    expect(await u.events.readAfter(s.id, 0, 1000)).toHaveLength(1000);
    expect(await u.events.readAfter(s.id, 0, 1001)).toHaveLength(1000);
  }, 30_000);

  it('passes manifest tools (wired to callTool) and skills to the adapter', async () => {
    const adapter = fake([{ callTool: { name: 'lookup_order', args: { id: 42 } } }]);
    const u = await make([adapter]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const callTool = vi.fn<CallTool>(() => Promise.resolve({ content: [{ type: 'text', text: 'order 42: shipped' }] }));
    const run = await s.startRun({ prompt: 'where is my order', manifest, callTool });
    const events = await eventsUntil(s, isTerminal);

    const input = adapter.calls[0]!;
    expect(input.skills).toEqual(manifest.skills);
    expect(input.tools?.map((t) => ({ ...t, call: undefined }))).toEqual(manifest.tools.map((t) => ({ ...t, call: undefined })));
    expect(callTool).toHaveBeenCalledWith('lookup_order', { id: 42 }, {
      sessionId: s.id,
      runId: run.id,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    const text = events.filter((e) => e.type === 'message.completed').map((e) => e.payload.text);
    expect(text).toEqual(['order 42: shipped']);
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('runs without a manifest pass no tools or skills', async () => {
    const adapter = fake([{ text: 'hi' }]);
    const u = await make([adapter]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'hi' });
    await eventsUntil(s, isTerminal);
    expect(adapter.calls[0]).not.toHaveProperty('tools');
    expect(adapter.calls[0]).not.toHaveProperty('skills');
  });

  it('rejects a manifest with tools when the runtime lacks siteTools', async () => {
    const adapter = fake([{ text: 'hi' }], { siteTools: false });
    const u = await make([adapter]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const callTool = () => Promise.resolve({ content: [] } as ToolCallResult);
    await expect(s.startRun({ prompt: 'hi', manifest, callTool })).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(adapter.calls).toHaveLength(0);
    // Skills alone are fine.
    await s.startRun({ prompt: 'hi', manifest: { tools: [], skills: manifest.skills } });
    await eventsUntil(s, isTerminal);
    expect(adapter.calls[0]?.skills).toEqual(manifest.skills);
    expect(adapter.calls[0]).not.toHaveProperty('tools');
  });

  it('rejects manifest tools without callTool, and invalid manifests', async () => {
    const u = await make([fake([{ text: 'hi' }])]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(s.startRun({ prompt: 'hi', manifest })).rejects.toMatchObject({ code: 'invalid_request' });
    const bad = { tools: [{ ...manifest.tools[0]!, name: 'mcp__x__y' }], skills: [] };
    await expect(
      s.startRun({ prompt: 'hi', manifest: bad, callTool: () => Promise.resolve({ content: [] }) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  describe('in-flight tool calls', () => {
    /** A run that calls `lookup_order` and then reports what came back. */
    async function pendingCall(u: Uncage) {
      const s = await u.sessions.create({ runtime: 'fake' });
      let ctxSeen: Parameters<CallTool>[2] | undefined;
      let reached!: () => void;
      const called = new Promise<void>((r) => (reached = r));
      // Never settles on its own: only the run's abort can release it.
      const callTool = vi.fn<CallTool>((_t, _a, ctx) => {
        ctxSeen = ctx;
        reached();
        return new Promise<ToolCallResult>(() => undefined);
      });
      const run = await s.startRun({ prompt: 'go', manifest, callTool });
      await called;
      return { s, run, ctx: () => ctxSeen! };
    }

    it('a pending call rejects promptly on cancel and its ctx signal aborts', async () => {
      const u = await make([fake([{ callTool: { name: 'lookup_order', args: {} } }, { text: 'after' }])]);
      const { s, run, ctx } = await pendingCall(u);
      expect(ctx().signal.aborted).toBe(false);
      const t0 = Date.now();
      expect(await u.runs.cancel(run.id)).toMatchObject({ state: 'cancelled' });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(ctx().signal.aborted).toBe(true);
      const events = await eventsUntil(s, isTerminal);
      expect(events.at(-1)?.type).toBe('run.cancelled');
    });

    it('closeAll does not wait on a pending call', async () => {
      const u = await createUncage({
        adapters: [fake([{ callTool: { name: 'lookup_order', args: {} } }])],
        dataDir: 'memory://',
      });
      const { ctx } = await pendingCall(u);
      const t0 = Date.now();
      await u.close();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(ctx().signal.aborted).toBe(true);
    });

    it('a call after the run ended is rejected without reaching callTool', async () => {
      const adapter = fake([{ text: 'done' }]);
      const u = await make([adapter]);
      const s = await u.sessions.create({ runtime: 'fake' });
      const callTool = vi.fn<CallTool>(() => Promise.resolve({ content: [] }));
      await s.startRun({ prompt: 'go', manifest, callTool });
      await eventsUntil(s, isTerminal);
      await expect(adapter.calls[0]!.tools![0]!.call({})).rejects.toMatchObject({ code: 'tool_failed' });
      expect(callTool).not.toHaveBeenCalled();
    });
  });

  it('a listener returning a rejected promise is logged, not unhandled', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as UncageOptions['logger'];
    const onEvent = async (): Promise<void> => Promise.reject(new Error('async boom'));
    const u = await make([fake([{ text: 'ok' }])], { onEvent, logger });
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'go' });
    await eventsUntil(s, isTerminal);
    await new Promise((r) => setTimeout(r, 10));
    expect(error).toHaveBeenCalled();
  });

  it('sessions.create accepts a caller-chosen session id (agent per-session workspaces)', async () => {
    const u = await make([fake([])]);
    const s = await u.sessions.create({ runtime: 'fake' }, { id: 'ses_0123456789abcdef0123456789abcdef' });
    expect(s.id).toBe('ses_0123456789abcdef0123456789abcdef');
    expect((await u.sessions.get(s.id)).id).toBe(s.id);
    await expect(u.sessions.create({ runtime: 'fake' }, { id: '../evil' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(u.sessions.create({ runtime: 'fake' }, { id: s.id })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('readAfter clamps after to an integer >= 0', async () => {
    const u = await make([fake([{ text: 'ok' }])]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'go' });
    const all = await eventsUntil(s, isTerminal);
    expect(await u.events.readAfter(s.id, Number.NaN)).toEqual(all);
    expect(await u.events.readAfter(s.id, -5)).toEqual(all);
    expect((await u.events.readAfter(s.id, 1.7)).map((e) => e.sequence)[0]).toBe(2);
  });
});
