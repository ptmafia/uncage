import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, Run, Session } from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { UncageError } from '../errors.js';
import { openPgliteStore } from './pglite-store.js';
import type { Store } from './store.js';

const caps: Session['capabilities'] = {
  streaming: true,
  approval: { once: true, session: false, types: ['shell'] },
  nativeResume: false,
  diffEvents: false,
  mcp: false,
  skills: 'unknown',
  models: [],
  efforts: [],
  permissionModes: ['default'],
  attachments: { images: false, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};
const session = (id: string): Session => ({
  id,
  runtimeId: 'fake',
  workspace: '/tmp/w',
  title: id,
  status: 'ready',
  readOnly: false,
  createdAt: new Date().toISOString(),
  capabilities: caps,
  settings: { permissionMode: 'default' },
});
const approval = (id: string, sessionId = 'A'): ApprovalRequest => ({
  id,
  sessionId,
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
});
const ev = (sessionId: string, occurredAt = new Date().toISOString()) => ({
  sessionId,
  type: 'system.warning' as const,
  occurredAt,
  payload: { code: 'x', message: 'y' },
});

const stores: Store[] = [];
const dirs: string[] = [];
const open = async (dataDir: string | 'memory://' = 'memory://') => {
  const s = await openPgliteStore({ dataDir });
  stores.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pglite store', () => {
  it('appendEvent assigns contiguous sequences per session', async () => {
    const s = await open();
    await s.createSession(session('A'));
    await s.createSession(session('B'));
    const a = [await s.appendEvent(ev('A')), await s.appendEvent(ev('A')), await s.appendEvent(ev('A'))];
    const b = [await s.appendEvent(ev('B')), await s.appendEvent(ev('B'))];
    expect(a.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(b.map((e) => e.sequence)).toEqual([1, 2]);
    expect(a[0]?.eventId).toBe('evt_0000000001');
    expect(a[2]?.eventId).toBe('evt_0000000003');
    expect(a[0]?.schemaVersion).toBe('1.0');
    expect((await s.getSession('A'))?.lastSequence).toBe(3);
  });

  it('concurrent appendEvent never duplicates sequence', async () => {
    const s = await open();
    await s.createSession(session('A'));
    const out = await Promise.all(Array.from({ length: 50 }, () => s.appendEvent(ev('A'))));
    expect(out.map((e) => e.sequence).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const stored = await s.readEvents('A', 0);
    expect(stored.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('appendEvent on an unknown session rejects with not_found', async () => {
    const s = await open();
    await expect(s.appendEvent(ev('nope'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('readEvents returns events after N in order and honours limit', async () => {
    const s = await open();
    await s.createSession(session('A'));
    for (let i = 0; i < 5; i++) await s.appendEvent({ ...ev('A'), runId: 'run_1' });
    const after2 = await s.readEvents('A', 2);
    expect(after2.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(after2[0]).toMatchObject({ eventId: 'evt_0000000003', runId: 'run_1', type: 'system.warning', payload: { code: 'x' } });
    expect((await s.readEvents('A', 0, 2)).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('pruneEvents raises minRetainedSequence', async () => {
    const s = await open();
    await s.createSession(session('A'));
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await s.appendEvent(ev('A', old));
    await s.appendEvent(ev('A', old));
    await s.appendEvent(ev('A'));
    expect(await s.minRetainedSequence('A')).toBe(0);
    const removed = await s.pruneEvents(new Date(Date.now() - 86_400_000));
    expect(removed).toBe(2);
    expect(await s.minRetainedSequence('A')).toBe(3);
    expect((await s.readEvents('A', 0)).map((e) => e.sequence)).toEqual([3]);
    expect((await s.appendEvent(ev('A'))).sequence).toBe(4);
  });

  it('casApproval only one of two concurrent claims wins', async () => {
    const s = await open();
    await s.createSession(session('A'));
    await s.createApproval(approval('apr_1'));
    const claim = () => s.casApproval('apr_1', { state: 'pending', version: 1 }, { state: 'submitting', version: 2 });
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await s.getApproval('apr_1'))).toMatchObject({ state: 'submitting', version: 2 });
    expect((await s.listApprovals({ sessionId: 'A', states: ['pending'] }))).toHaveLength(0);
    expect((await s.listApprovals({ sessionId: 'A', states: ['submitting'] }))).toHaveLength(1);
  });

  it('round-trips sessions, runs and patches', async () => {
    const s = await open();
    await s.createSession({ ...session('A'), nativeSessionRef: 'native1' });
    expect(await s.getSession('A')).toMatchObject({ id: 'A', nativeSessionRef: 'native1', lastSequence: 0, capabilities: caps });
    const u = await s.updateSession('A', { status: 'busy', activeRunId: 'run_1', nativeSessionRef: null });
    expect(u).toMatchObject({ status: 'busy', activeRunId: 'run_1' });
    expect((await s.getSession('A'))?.nativeSessionRef).toBeUndefined();
    expect((await s.updateSession('A', { activeRunId: undefined })).activeRunId).toBeUndefined();
    expect(await s.listSessions()).toHaveLength(1);
    await expect(s.updateSession('zzz', { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });

    const run: Run = { id: 'run_1', sessionId: 'A', prompt: 'hi', state: 'queued', createdAt: new Date().toISOString() };
    await s.createRun(run);
    expect(await s.getRun('run_1')).toEqual(run);
    const r2 = await s.updateRun('run_1', { state: 'failed', error: { code: 'internal_error', message: 'm', retryable: false } });
    expect(r2.error?.code).toBe('internal_error');
    expect((await s.listRunsInState(['failed'])).map((r) => r.id)).toEqual(['run_1']);
    expect(await s.listRunsInState([])).toEqual([]);
    expect(await s.listRuns('A')).toHaveLength(1);
  });

  it('idempotency round-trip', async () => {
    const s = await open();
    expect(await s.getIdempotent('k', 'scope')).toBeNull();
    await s.putIdempotent('k', 'scope', 'hash1', { ok: true });
    expect(await s.getIdempotent('k', 'scope')).toEqual({ requestHash: 'hash1', response: { ok: true } });
    expect(await s.getIdempotent('k', 'other')).toBeNull();
  });

  it('persists across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-store-'));
    dirs.push(dir);
    const s1 = await open(dir);
    await s1.createSession(session('A'));
    await s1.appendEvent(ev('A'));
    await s1.close();
    const s2 = await open(dir);
    expect(await s2.getSession('A')).toMatchObject({ id: 'A', lastSequence: 1 });
    expect((await s2.appendEvent(ev('A'))).sequence).toBe(2);
  });

  it('throws store_locked when the dataDir is already open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-store-'));
    dirs.push(dir);
    await open(dir);
    const err = await openPgliteStore({ dataDir: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncageError);
    expect(err).toMatchObject({ code: 'store_locked' });
    expect((err as UncageError).hint).toBe(`Another Uncage process is using ${dir}. Stop it or pass a different dataDir.`);
  });
});
