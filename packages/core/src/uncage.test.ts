import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import type {
  AdapterRunInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  UncageEvent,
} from '@uncage/protocol';
import { openPgliteStore } from './store/pglite-store.js';
import { createUncage, type Uncage } from './uncage.js';
import { eventsUntil, isTerminal } from './test-utils.js';

const CAPS: RuntimeCapabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ['shell'] },
  nativeResume: true,
  diffEvents: false,
  mcp: false,
  skills: 'unknown',
};

/** A minimal hand-written adapter: `body` produces the events for each run. */
function inlineAdapter(
  body: (input: AdapterRunInput) => AsyncGenerator<RuntimeEvent>,
  caps: Partial<RuntimeCapabilities> = {},
): RuntimeAdapter & { calls: AdapterRunInput[] } {
  const calls: AdapterRunInput[] = [];
  return {
    id: 'inline',
    displayName: 'Inline',
    calls,
    probe: () => Promise.resolve({ status: 'available' }),
    capabilities: () => ({ ...CAPS, ...caps }),
    run: (input) => {
      calls.push(input);
      return body(input);
    },
  };
}

const types = (events: UncageEvent[]) => events.map((e) => e.type);

describe('createUncage', () => {
  const open: Uncage[] = [];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uncage-core-'));
  });
  afterEach(async () => {
    for (const u of open.splice(0)) await u.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function make(adapters: RuntimeAdapter[], extra: Partial<Parameters<typeof createUncage>[0]> = {}) {
    const u = await createUncage({ adapters, dataDir: 'memory://', ...extra });
    open.push(u);
    return u;
  }
  const fake = (script: FakeStep[]) => createFakeAdapter({ script });

  it('golden path event order', async () => {
    const u = await make([fake([{ text: 'Hello world!', chunks: 3 }])]);
    const session = await u.sessions.create({ runtime: 'fake', title: 'Demo' });
    expect(await session.get()).toMatchObject({ runtimeId: 'fake', title: 'Demo', status: 'ready', readOnly: false });
    const run = await session.startRun({ prompt: 'say hello' });
    expect(run).toMatchObject({ sessionId: session.id, prompt: 'say hello', state: 'queued' });

    const events = await eventsUntil(session, isTerminal);
    expect(types(events)).toEqual([
      'session.created',
      'run.started',
      'run.updated',
      'message.started',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.completed',
      'run.completed',
    ]);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events[2]).toMatchObject({ type: 'run.updated', payload: { runId: run.id, state: 'running' } });
    const deltas = events.flatMap((e) => (e.type === 'message.delta' ? [e.payload] : []));
    expect(deltas.map((d) => d.chunkIndex)).toEqual([0, 1, 2]);
    expect(deltas.map((d) => d.text).join('')).toBe('Hello world!');
    for (const e of events.slice(1)) expect(e.runId).toBe(run.id);
    const stamps = events.map((e) => Date.parse(e.occurredAt));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);

    const done = await u.runs.get(run.id);
    expect(done).toMatchObject({ state: 'completed' });
    expect(done.startedAt).toBeDefined();
    expect(done.endedAt).toBeDefined();
    const snap = await session.snapshot();
    expect(snap).toMatchObject({ lastSequence: events.length, pendingApprovals: [] });
    expect(snap.session).not.toHaveProperty('activeRunId');
    expect(snap.session.status).toBe('ready');
    expect(snap.runs.map((r) => r.id)).toEqual([run.id]);
    expect(await u.sessions.list()).toHaveLength(1);
    expect(await u.runtimes.get('fake')).toMatchObject({ id: 'fake', status: 'available', version: 'fake-1.0.0' });
  });

  it('deny keeps run completed', async () => {
    const u = await make([fake([{ approval: { category: 'shell', title: 'rm', target: { command: 'rm x' } } }])]);
    const session = await u.sessions.create({ runtime: 'fake' });
    const run = await session.startRun({ prompt: 'p' });
    const seen = await eventsUntil(session, (e) => e.type === 'approval.requested');
    const req = seen.at(-1);
    if (req?.type !== 'approval.requested') throw new Error('expected approval');
    await u.approvals.decide(req.payload.approval.id, { decision: 'deny', scope: 'once' }, 'd');
    const events = await eventsUntil(session, isTerminal);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.find((e) => e.type === 'tool.failed')?.payload).toMatchObject({ declined: true });
    expect((await u.runs.get(run.id)).state).toBe('completed');
  });

  it('session_busy on second startRun', async () => {
    const u = await make([fake([{ waitMs: 5_000 }])]);
    const session = await u.sessions.create({ runtime: 'fake' });
    const run = await session.startRun({ prompt: 'one' });
    await expect(session.startRun({ prompt: 'two' })).rejects.toMatchObject({ code: 'session_busy', status: 409 });
    expect((await session.get()).activeRunId).toBe(run.id);
    expect((await u.runs.cancel(run.id)).state).toBe('cancelled');
    expect((await session.get()).activeRunId).toBeUndefined();
  });

  it('same idempotencyKey returns same run', async () => {
    const u = await make([fake([{ waitMs: 20 }])]);
    const session = await u.sessions.create({ runtime: 'fake' });
    const [a, b] = await Promise.all([
      session.startRun({ prompt: 'x', idempotencyKey: 'idem' }),
      session.startRun({ prompt: 'x', idempotencyKey: 'idem' }),
    ]);
    expect(b.id).toBe(a.id);
    await eventsUntil(session, isTerminal);
    const later = await session.startRun({ prompt: 'x', idempotencyKey: 'idem' });
    expect(later.id).toBe(a.id);
    expect(later.state).toBe('completed');
  });

  it('restart reconciliation', async () => {
    const adapter = () => fake([{ approval: { category: 'shell', title: 'ls', target: { command: 'ls' } } }]);
    const u1 = await createUncage({ adapters: [adapter()], dataDir: dir });
    const s1 = await u1.sessions.create({ runtime: 'fake' });
    const run = await s1.startRun({ prompt: 'p' });
    const seen = await eventsUntil(s1, (e) => e.type === 'approval.requested');
    const lastSeq = seen.at(-1)?.sequence ?? 0;
    await u1.close();

    const u2 = await make([adapter()], { dataDir: dir });
    const s2 = await u2.sessions.get(s1.id);
    expect((await u2.runs.get(run.id)).state).toBe('interrupted');
    const [approval] = await u2.approvals.list({ sessionId: s1.id });
    expect(approval?.state).toBe('expired');
    expect(await u2.approvals.list({ sessionId: s1.id, pendingOnly: true })).toEqual([]);
    const after = await eventsUntil(s2, isTerminal, { after: lastSeq });
    expect(types(after)).toContain('approval.updated');
    expect(after.at(-1)?.type).toBe('run.interrupted');
    expect((await s2.get()).status).toBe('ready');
    // The session is usable again.
    await expect(s2.startRun({ prompt: 'again' })).resolves.toMatchObject({ state: 'queued' });
  });

  it('restart reconciliation after a crash (no close)', async () => {
    const store = await openPgliteStore({ dataDir: dir });
    const now = new Date().toISOString();
    await store.createSession({
      id: 'ses_1',
      runtimeId: 'fake',
      workspace: process.cwd(),
      title: 't',
      status: 'busy',
      readOnly: false,
      createdAt: now,
      capabilities: CAPS,
      activeRunId: 'run_1',
    });
    await store.createRun({ id: 'run_1', sessionId: 'ses_1', prompt: 'p', state: 'waiting_approval', createdAt: now });
    for (const [id, state] of [['apr_1', 'pending'], ['apr_2', 'submitting']] as const) {
      await store.createApproval({
        id,
        sessionId: 'ses_1',
        runId: 'run_1',
        runtimeId: 'fake',
        category: 'shell',
        title: 'ls',
        target: {},
        allowedScopes: ['once'],
        availableDecisions: ['allow_once', 'deny'],
        state,
        createdAt: now,
        expiresAt: now,
        version: 1,
      });
    }
    await store.close();

    const u = await make([fake([])], { dataDir: dir });
    const run = await u.runs.get('run_1');
    expect(run.state).toBe('interrupted');
    expect(run.endedAt).toBeDefined();
    const approvals = await u.approvals.list({ sessionId: 'ses_1' });
    expect(approvals.map((a) => a.state)).toEqual(['expired', 'expired']);
    const session = await u.sessions.get('ses_1');
    const events = await eventsUntil(session, isTerminal);
    expect(types(events)).toEqual(['approval.updated', 'approval.updated', 'run.interrupted']);
    expect(events.at(-1)?.payload).toEqual({ runId: 'run_1', reason: 'server_restart' });
    expect(await session.get()).toMatchObject({ status: 'ready' });
    expect((await session.get()).activeRunId).toBeUndefined();
  });

  it('adapter throw → interrupted', async () => {
    const adapter = inlineAdapter(async function* () {
      yield { type: 'message.started', messageId: 'm1' };
      throw new Error('process exited');
    });
    const u = await make([adapter]);
    const session = await u.sessions.create({ runtime: 'inline' });
    const run = await session.startRun({ prompt: 'p' });
    const events = await eventsUntil(session, isTerminal);
    expect(events.at(-1)).toMatchObject({
      type: 'run.interrupted',
      payload: { runId: run.id, reason: 'runtime_disconnected' },
    });
    expect((await u.runs.get(run.id)).state).toBe('interrupted');
    expect((await session.get()).status).toBe('ready');
  });

  it('iterator ending without a terminal event → interrupted, approvals cancelled', async () => {
    const adapter = inlineAdapter(async function* () {
      yield { type: 'message.started', messageId: 'm1' };
    });
    const u = await make([adapter]);
    const session = await u.sessions.create({ runtime: 'inline' });
    await session.startRun({ prompt: 'p' });
    const events = await eventsUntil(session, isTerminal);
    expect(events.at(-1)).toMatchObject({ type: 'run.interrupted', payload: { reason: 'runtime_disconnected' } });
  });

  it('adapter crash event → interrupted with its reason; run.failed → failed', async () => {
    const u = await make([fake([{ crash: 'codex exited' }])]);
    const session = await u.sessions.create({ runtime: 'fake' });
    const run = await session.startRun({ prompt: 'p' });
    const events = await eventsUntil(session, isTerminal);
    expect(events.at(-1)?.payload).toEqual({ runId: run.id, reason: 'codex exited' });

    const u2 = await make([fake([{ fail: { code: 'internal_error', message: 'bad', retryable: false } }])]);
    const s2 = await u2.sessions.create({ runtime: 'fake' });
    const r2 = await s2.startRun({ prompt: 'p' });
    await eventsUntil(s2, isTerminal);
    expect(await u2.runs.get(r2.id)).toMatchObject({ state: 'failed', error: { code: 'internal_error' } });
  });

  it('events({after}) replays then streams live', async () => {
    const u = await make([fake([{ text: 'hi' }])]);
    const session = await u.sessions.create({ runtime: 'fake' });
    await session.startRun({ prompt: 'one' });
    const first = await eventsUntil(session, isTerminal);
    const cut = 3;

    const ac = new AbortController();
    const got: UncageEvent[] = [];
    const reader = (async () => {
      for await (const e of session.events({ after: cut, signal: ac.signal })) {
        got.push(e);
        if (got.length === first.length - cut) void session.startRun({ prompt: 'two' });
        if (e.type === 'run.completed' && got.length > first.length - cut) ac.abort();
      }
    })();
    await reader;
    expect(got.map((e) => e.sequence)).toEqual(
      Array.from({ length: got.length }, (_, i) => cut + 1 + i),
    );
    expect(got.slice(0, first.length - cut)).toEqual(first.slice(cut));
    expect(types(got).filter((t) => t === 'run.completed')).toHaveLength(2);
  });

  it('events({after}) before the retention window throws event_replay_unavailable', async () => {
    const u1 = await createUncage({ adapters: [fake([{ text: 'hi' }])], dataDir: dir });
    const s1 = await u1.sessions.create({ runtime: 'fake' });
    await s1.startRun({ prompt: 'p' });
    const seen = await eventsUntil(s1, isTerminal);
    await u1.close();

    const u2 = await make([fake([])], { dataDir: dir, eventRetentionDays: 0 });
    const s2 = await u2.sessions.get(s1.id);
    const it = s2.events({ after: 0 })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ code: 'event_replay_unavailable' });
    const ac = new AbortController();
    const tail = s2.events({ after: seen.length, signal: ac.signal })[Symbol.asyncIterator]();
    const pending = tail.next();
    ac.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it('native.session ref persisted and passed as nativeSessionRef on next run', async () => {
    const adapter = inlineAdapter(async function* (input) {
      yield { type: 'native.session', ref: input.nativeSessionRef ?? 'native-1' };
      yield { type: 'run.completed' };
    });
    const u = await make([adapter]);
    const session = await u.sessions.create({ runtime: 'inline' });
    await session.startRun({ prompt: 'one' });
    const first = await eventsUntil(session, isTerminal);
    expect(types(first)).not.toContain('native.session');
    await session.startRun({ prompt: 'two' });
    await eventsUntil(session, isTerminal, { after: first.length });
    expect(adapter.calls.map((c) => c.nativeSessionRef)).toEqual([undefined, 'native-1']);
    expect(adapter.calls[0]?.cwd).toBe((await session.get()).workspace);
  });

  it('session without native resume becomes read-only once it has a native ref', async () => {
    const adapter = inlineAdapter(
      async function* () {
        yield { type: 'native.session', ref: 'n1' };
        yield { type: 'run.completed' };
      },
      { nativeResume: false },
    );
    const u = await make([adapter]);
    const session = await u.sessions.create({ runtime: 'inline' });
    await session.startRun({ prompt: 'one' });
    await eventsUntil(session, isTerminal);
    expect((await session.get()).readOnly).toBe(true);
    await expect(session.startRun({ prompt: 'two' })).rejects.toMatchObject({
      code: 'session_read_only',
      hint: 'Start a new session',
    });
  });

  it('startRun rechecks the workspace against the current allowedRoots', async () => {
    const rootA = join(dir, 'a');
    const rootB = join(dir, 'b');
    mkdirSync(rootA);
    mkdirSync(rootB);
    const dataDir = join(dir, 'data');
    const u1 = await createUncage({ adapters: [fake([])], dataDir, workspace: { allowedRoots: [rootA], default: rootA } });
    const s1 = await u1.sessions.create({ runtime: 'fake' });
    await u1.close();

    const adapter = fake([]);
    const u2 = await make([adapter], { dataDir, workspace: { allowedRoots: [rootB], default: rootB } });
    const s2 = await u2.sessions.get(s1.id);
    await expect(s2.startRun({ prompt: 'p' })).rejects.toMatchObject({
      code: 'invalid_workspace',
      hint: "This session's workspace is outside the allowed roots; start a new session",
    });
    expect((await s2.get()).status).toBe('ready');
    expect((await s2.snapshot()).runs).toEqual([]);
  });

  it('native.session_lost → session read-only (session.updated + warning) and the run fails', async () => {
    const adapter = inlineAdapter(async function* (input) {
      if (input.nativeSessionRef === undefined) {
        yield { type: 'native.session', ref: 'gone-1' };
        yield { type: 'run.completed' };
        return;
      }
      yield { type: 'native.session_lost', message: 'No conversation found with session ID: gone-1' };
    });
    const u = await make([adapter]);
    const session = await u.sessions.create({ runtime: 'inline' });
    await session.startRun({ prompt: 'one' });
    const first = await eventsUntil(session, isTerminal);
    const run = await session.startRun({ prompt: 'two' });
    const events = await eventsUntil(session, isTerminal, { after: first.at(-1)!.sequence });

    expect(types(events)).toEqual(['run.started', 'run.updated', 'session.updated', 'system.warning', 'run.failed']);
    const updated = events.find((e) => e.type === 'session.updated');
    expect(updated?.type === 'session.updated' && updated.payload.session).toMatchObject({ id: session.id, readOnly: true });
    expect(updated?.payload).not.toHaveProperty('session.nativeSessionRef');
    const warning = events.find((e) => e.type === 'system.warning');
    expect(warning?.payload).toEqual({ code: 'session_resume_failed', message: 'No conversation found with session ID: gone-1' });
    const failed = await u.runs.get(run.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'session_read_only', hint: 'Start a new session', retryable: false });
    expect(await session.get()).toMatchObject({ readOnly: true, status: 'ready' });
    await expect(session.startRun({ prompt: 'three' })).rejects.toMatchObject({ code: 'session_read_only' });
    // The history stays readable.
    expect((await session.snapshot()).runs).toHaveLength(2);
  });

  it('validates runtime, workspace and ids', async () => {
    const u = await make([fake([])], { workspace: { allowedRoots: [dir], default: dir } });
    await expect(u.sessions.create({ runtime: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(u.sessions.create({ runtime: 'fake', workspace: tmpdir() })).rejects.toMatchObject({
      code: 'invalid_workspace',
    });
    await expect(u.sessions.get('ses_nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(u.runs.get('run_nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(u.runtimes.get('nope')).rejects.toMatchObject({ code: 'not_found' });

    const missing = createFakeAdapter({ id: 'gone', script: [], probe: { status: 'not_installed', hint: 'install it' } });
    const u2 = await make([missing]);
    expect(await u2.runtimes.list()).toMatchObject([{ id: 'gone', status: 'not_installed', hint: 'install it' }]);
    await expect(u2.sessions.create({ runtime: 'gone' })).rejects.toMatchObject({ code: 'runtime_unavailable' });
  });

  it('close() releases approvals whose adapter ignores the abort signal', async () => {
    const adapter = inlineAdapter(async function* () {
      // No signal handling: a canUseTool-style callback just awaits the decision.
      yield { type: 'tool.started', toolId: 't1', name: 'shell', title: 'ls', category: 'shell' };
      await adapterCtx.requestApproval({ category: 'shell', title: 'ls', target: { command: 'ls' } });
      yield { type: 'run.completed' };
    });
    let adapterCtx!: Parameters<RuntimeAdapter['run']>[1];
    const run0 = adapter.run.bind(adapter);
    adapter.run = (input, ctx) => {
      adapterCtx = ctx;
      return run0(input, ctx);
    };
    const u = await createUncage({ adapters: [adapter], dataDir: dir });
    const session = await u.sessions.create({ runtime: 'inline' });
    const run = await session.startRun({ prompt: 'p' });
    await eventsUntil(session, (e) => e.type === 'approval.requested');
    const t0 = Date.now();
    await u.close();
    expect(Date.now() - t0).toBeLessThan(1_000);

    const u2 = await make([adapter], { dataDir: dir });
    expect(await u2.runs.get(run.id)).toMatchObject({ state: 'interrupted' });
    expect((await u2.approvals.list({ sessionId: session.id })).map((a) => a.state)).toEqual(['expired']);
    const events = await eventsUntil(await u2.sessions.get(session.id), isTerminal);
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'server_shutdown' });
  });

  it('close() interrupts active runs', async () => {
    const u = await createUncage({ adapters: [fake([{ waitMs: 10_000 }])], dataDir: dir });
    const session = await u.sessions.create({ runtime: 'fake' });
    const run = await session.startRun({ prompt: 'p' });
    await eventsUntil(session, (e) => e.type === 'run.updated');
    await u.close();
    const u2 = await make([fake([])], { dataDir: dir });
    expect(await u2.runs.get(run.id)).toMatchObject({ state: 'interrupted' });
  });
});
