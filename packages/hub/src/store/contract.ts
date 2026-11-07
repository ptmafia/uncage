/**
 * The `HubStore` contract, shared by every store implementation's tests (PGlite always; real
 * Postgres in the Docker suite). Each call gets a fresh, empty store.
 */
import type { UncageEvent } from '@uncage/protocol';
import { expect, it } from 'vitest';
import type { HubStore, MachineRecord } from './store.js';

const iso = (offsetMs = 0) => new Date(Date.UTC(2026, 10, 7) + offsetMs).toISOString();

const machine = (id: string, userId = 'alice', extra: Partial<MachineRecord> = {}): MachineRecord => ({
  id,
  userId,
  tokenHash: `hash_${id}`,
  name: 'Mac',
  os: 'darwin',
  agentVersion: '0.2.0',
  runtimes: [{ id: 'fake', displayName: 'Fake', status: 'available' }],
  createdAt: iso(),
  lastSeenAt: iso(),
  ...extra,
});

const event = (sessionId: string, sequence: number): UncageEvent =>
  ({
    eventId: `evt_${String(sequence).padStart(10, '0')}`,
    sequence,
    sessionId,
    type: 'run.cancelled',
    occurredAt: iso(sequence),
    schemaVersion: '1.0',
    payload: { runId: 'run_1' },
  }) as UncageEvent;

export function hubStoreContract(make: () => Promise<{ store: HubStore; cleanup?: () => Promise<void> }>): void {
  const withStore = (fn: (s: HubStore) => Promise<void>) => async () => {
    const { store, cleanup } = await make();
    try {
      await fn(store);
    } finally {
      await store.close();
      await cleanup?.();
    }
  };

  it(
    'machines: insert, find by token / key, rotate, list newest first, update, delete',
    withStore(async (s) => {
      await s.insertMachine(machine('m1', 'alice', { machineKeyHash: 'k1' }));
      await s.insertMachine(machine('m2', 'alice', { lastSeenAt: iso(5000) }));
      await s.insertMachine(machine('m3', 'bob'));
      expect(await s.getMachine('m1')).toEqual(machine('m1', 'alice', { machineKeyHash: 'k1' }));
      expect(await s.getMachine('nope')).toBeNull();
      expect((await s.findMachineByTokenHash('hash_m2'))?.id).toBe('m2');
      expect((await s.findMachineByKey('alice', 'k1'))?.id).toBe('m1');
      expect(await s.findMachineByKey('bob', 'k1')).toBeNull();
      expect(await s.rotateMachineToken('m1', 'new_hash')).toBe(true);
      expect(await s.rotateMachineToken('nope', 'x')).toBe(false);
      expect((await s.findMachineByTokenHash('new_hash'))?.id).toBe('m1');
      expect((await s.listMachines('alice')).map((m) => m.id)).toEqual(['m2', 'm1']);
      await s.updateMachine('m1', { name: 'Laptop', lastSeenAt: iso(9000), runtimes: [] });
      expect(await s.getMachine('m1')).toMatchObject({ name: 'Laptop', lastSeenAt: iso(9000), runtimes: [] });
      expect(await s.deleteMachine('m1')).toBe(true);
      expect(await s.deleteMachine('m1')).toBe(false);
    }),
  );

  it(
    'device codes: compare-and-set transitions, single winner',
    withStore(async (s) => {
      await s.insertDeviceCode({ deviceCodeHash: 'd1', userCodeHash: 'u1', status: 'pending', name: 'Mac', createdAt: iso(), expiresAt: iso(600_000) });
      expect((await s.findDeviceCodeByUserCode('u1'))?.deviceCodeHash).toBe('d1');
      const both = await Promise.all([
        s.transitionDeviceCode('d1', 'pending', 'approved', { userId: 'alice' }),
        s.transitionDeviceCode('d1', 'pending', 'denied'),
      ]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect((await s.getDeviceCode('d1'))?.status).toMatch(/approved|denied/);
    }),
  );

  it(
    'sessions: idempotent insert, list oldest first, update, replication CAS (one winner)',
    withStore(async (s) => {
      const rec = { id: 's1', userId: 'alice', machineId: 'm1', createdAt: iso(), title: 'T', lastSequence: 0 };
      expect(await s.insertSession(rec)).toEqual(rec);
      expect(await s.insertSession({ ...rec, userId: 'mallory' })).toEqual(rec); // existing wins
      await s.insertSession({ ...rec, id: 's0', createdAt: iso(-1000) });
      expect((await s.listSessions('alice')).map((x) => x.id)).toEqual(['s0', 's1']);
      await s.updateSession('s1', { title: 'New', activeRun: { id: 'run_1', state: 'running' } });
      expect(await s.getSession('s1')).toMatchObject({ title: 'New', activeRun: { id: 'run_1', state: 'running' } });
      await s.updateSession('s1', { activeRun: null });
      expect((await s.getSession('s1'))?.activeRun).toBeUndefined();

      const results = await Promise.all([
        s.appendEvents('s1', 0, [event('s1', 1), event('s1', 2)], {}),
        s.appendEvents('s1', 0, [event('s1', 1)], {}),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const last = (await s.getSession('s1'))!.lastSequence;
      expect(await s.appendEvents('s1', last, [event('s1', last + 1)], { snapshot: { runs: [], pendingApprovals: [], lastSequence: last + 1 } })).toBe(true);
      expect((await s.readEvents('s1', 0, 100)).map((e) => e.sequence)).toEqual(Array.from({ length: last + 1 }, (_, i) => i + 1));
      expect((await s.readEvents('s1', 1, 1)).map((e) => e.sequence)).toEqual([2]);
      expect((await s.getSession('s1'))?.snapshot).toEqual({ runs: [], pendingApprovals: [], lastSequence: last + 1 });
    }),
  );

  it(
    'resources (first writer wins) and attachments (bytes round-trip)',
    withStore(async (s) => {
      await s.putResource('run_1', 'run', 's1');
      await s.putResource('run_1', 'run', 's2');
      expect(await s.getResource('run_1', 'run')).toEqual({ sessionId: 's1' });
      expect(await s.getResource('run_1', 'approval')).toBeNull();
      const data = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
      const attachment = { id: 'att_1', sessionId: 's1', name: 'a.bin', mime: 'application/octet-stream', size: data.length, kind: 'file' as const, sha256: 'x', createdAt: iso() };
      await s.putAttachment({ attachment, userId: 'alice', data });
      const got = await s.getAttachment('att_1');
      expect(got?.attachment).toEqual(attachment);
      expect(got?.userId).toBe('alice');
      expect(Buffer.from(got!.data).equals(Buffer.from(data))).toBe(true);
    }),
  );

  it(
    'tool-call audit: insert running, finish, list per session in start order',
    withStore(async (s) => {
      const base = { sessionId: 's1', runId: 'run_1', userId: 'alice', machineId: 'm1', tool: 'lookup_order' };
      await s.insertToolCall({ ...base, id: 'tcl_2', callId: 'tc_2', args: null, status: 'running', startedAt: iso(2000) });
      await s.insertToolCall({ ...base, id: 'tcl_1', callId: 'tc_1', args: { id: 'A-1', nested: [1, { x: 'é' }] }, status: 'running', startedAt: iso(1000) });
      await s.insertToolCall({ ...base, sessionId: 's2', id: 'tcl_3', callId: 'tc_3', args: {}, status: 'running', startedAt: iso() });
      await s.finishToolCall('tcl_1', { status: 'error', errorCode: 'tool_failed', errorMessage: 'down', finishedAt: iso(1500), durationMs: 500 });
      const rows = await s.listToolCalls('s1');
      expect(rows.map((r) => r.id)).toEqual(['tcl_1', 'tcl_2']);
      expect(rows[0]).toEqual({
        ...base,
        id: 'tcl_1',
        callId: 'tc_1',
        args: { id: 'A-1', nested: [1, { x: 'é' }] },
        status: 'error',
        errorCode: 'tool_failed',
        errorMessage: 'down',
        startedAt: iso(1000),
        finishedAt: iso(1500),
        durationMs: 500,
      });
      expect(rows[1]).toEqual({ ...base, id: 'tcl_2', callId: 'tc_2', args: null, status: 'running', startedAt: iso(2000) });
      expect(await s.listToolCalls('s1', 1)).toHaveLength(1);
    }),
  );

  it(
    'run manifests: first writer wins, bind by key once, delete only unbound',
    withStore(async (s) => {
      await s.putRunManifest({ key: 's1:k1', sessionId: 's1', tools: ['a'], createdAt: iso(1) });
      await s.putRunManifest({ key: 's1:k1', sessionId: 's1', tools: ['b'], createdAt: iso(2) });
      expect(await s.getRunTools('run_1')).toBeNull();
      await s.bindRunManifest('s1:k1', 'run_1');
      expect(await s.getRunTools('run_1')).toEqual({ sessionId: 's1', tools: ['a'] });
      await s.bindRunManifest('s1:k1', 'run_other'); // already bound
      expect(await s.getRunTools('run_other')).toBeNull();

      await s.putRunManifest({ key: 's1:k2', sessionId: 's1', tools: [], createdAt: iso(2) });
      await s.bindRunManifest('s1:k2', 'run_1'); // run_1 already linked: no-op
      await s.bindRunManifest('s1:k2', 'run_2');
      expect(await s.getRunTools('run_2')).toEqual({ sessionId: 's1', tools: [] });
      await s.deleteRunManifest('s1:k1'); // bound: kept
      expect(await s.getRunTools('run_1')).not.toBeNull();
      await s.putRunManifest({ key: 's1:k3', sessionId: 's1', tools: ['c'], createdAt: iso(3) });
      await s.deleteRunManifest('s1:k3');
      await s.bindRunManifest('s1:k3', 'run_3');
      expect(await s.getRunTools('run_3')).toBeNull();
    }),
  );
}
