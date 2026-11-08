/**
 * The `HubStore` contract, shared by every store implementation's tests (PGlite always; real
 * Postgres in the Docker suite). Each call gets a fresh, empty store.
 */
import type { HubFrame, UncageEvent } from '@uncage/protocol';
import { expect, it } from 'vitest';
import type { HubStore, MachineRecord, ToolCallRecord, ToolResultFrame } from './store.js';

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

/** `n` seconds after the contract's epoch. */
const t = (n: number) => iso(n * 1000);

const item = (msgId: string, expiresAt = iso(3_600_000)): { msgId: string; msg: HubFrame; expiresAt: string } => ({
  msgId,
  msg: { t: 'command', id: msgId, op: 'listSessions', args: {} } as HubFrame,
  expiresAt,
});

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
    'sessions keep their runtime id; delete removes the record and its events',
    withStore(async (s) => {
      await s.insertSession({ id: 's1', userId: 'alice', machineId: 'm1', createdAt: iso(), title: 'T', lastSequence: 0, runtime: 'codex' });
      await s.insertSession({ id: 's2', userId: 'alice', machineId: 'm1', createdAt: iso(), title: 'T', lastSequence: 0 });
      expect((await s.getSession('s1'))?.runtime).toBe('codex');
      expect(await s.getSession('s2')).not.toHaveProperty('runtime');
      expect(await s.appendEvents('s2', 0, [event('s2', 1)], {})).toBe(true);
      await s.deleteSession('s2');
      expect(await s.getSession('s2')).toBeNull();
      expect(await s.readEvents('s2', 0, 10)).toEqual([]);
    }),
  );

  it(
    'attachments: retention prune by createdAt; revoking a machine deletes its attachments',
    withStore(async (s) => {
      const att = (id: string, sessionId: string, createdAt: string) => ({
        id, sessionId, name: `${id}.txt`, mime: 'text/plain', size: 1, kind: 'file' as const, sha256: 'x', createdAt,
      });
      const data = new Uint8Array([1]);
      await s.insertMachine(machine('m1'));
      await s.insertMachine(machine('m2'));
      await s.insertSession({ id: 's1', userId: 'alice', machineId: 'm1', createdAt: iso(), title: 'T', lastSequence: 0 });
      await s.putAttachment({ attachment: att('att_old', 's2', iso(-40 * 86_400_000)), userId: 'alice', data, machineId: 'm2' });
      await s.putAttachment({ attachment: att('att_new', 's2', iso()), userId: 'alice', data, machineId: 'm2' });
      await s.putAttachment({ attachment: att('att_m1', 's1', iso()), userId: 'alice', data, machineId: 'm1' });
      // No machineId (written by an older hub): matched through its session.
      await s.putAttachment({ attachment: att('att_legacy', 's1', iso()), userId: 'alice', data });
      expect((await s.getAttachment('att_m1'))?.machineId).toBe('m1');

      expect(await s.pruneAttachments(iso(-30 * 86_400_000))).toBe(1);
      expect(await s.getAttachment('att_old')).toBeNull();
      expect(await s.getAttachment('att_new')).not.toBeNull();

      expect(await s.deleteMachine('m1')).toBe(true);
      expect(await s.getAttachment('att_m1')).toBeNull();
      expect(await s.getAttachment('att_legacy')).toBeNull();
      expect(await s.getAttachment('att_new')).not.toBeNull();
    }),
  );

  it(
    'tool-call audit: insert running, finish, list per session in start order',
    withStore(async (s) => {
      const base = { sessionId: 's1', runId: 'run_1', userId: 'alice', machineId: 'm1', tool: 'lookup_order' };
      await s.insertToolCall({ ...base, id: 'tcl_2', callId: 'tc_2', args: null, status: 'running', startedAt: iso(2000) });
      await s.insertToolCall({ ...base, id: 'tcl_1', callId: 'tc_1', args: { id: 'A-1', nested: [1, { x: 'é' }] }, status: 'running', startedAt: iso(1000) });
      await s.insertToolCall({ ...base, sessionId: 's2', id: 'tcl_3', callId: 'tc_3', args: {}, status: 'running', startedAt: iso() });
      const failed: ToolResultFrame = { t: 'tool_result', id: 'tc_1', ok: false, error: { code: 'tool_failed', message: 'down', retryable: false } };
      expect(await s.finishToolCall('tcl_1', { status: 'error', errorCode: 'tool_failed', errorMessage: 'down', finishedAt: iso(1500), durationMs: 500, result: failed })).toBe(true);
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
        result: failed,
      });
      expect(rows[1]).toEqual({ ...base, id: 'tcl_2', callId: 'tc_2', args: null, status: 'running', startedAt: iso(2000) });
      expect(await s.listToolCalls('s1', 1)).toHaveLength(1);
    }),
  );

  it(
    'run manifests: first writer wins, bind by key once, delete only unbound',
    withStore(async (s) => {
      await s.putRunManifest({ key: 's1:k1', sessionId: 's1', tools: ['a'], createdAt: iso(1), nonce: 'n1' });
      await s.putRunManifest({ key: 's1:k1', sessionId: 's1', tools: ['b'], createdAt: iso(2), nonce: 'n1b' });
      expect(await s.getRunTools('run_1')).toBeNull();
      await s.bindRunManifest('s1:k1', 'run_1');
      expect(await s.getRunTools('run_1')).toEqual({ sessionId: 's1', tools: ['a'] });
      await s.bindRunManifest('s1:k1', 'run_other'); // already bound
      expect(await s.getRunTools('run_other')).toBeNull();

      await s.putRunManifest({ key: 's1:k2', sessionId: 's1', tools: [], createdAt: iso(2), nonce: 'n2' });
      await s.bindRunManifest('s1:k2', 'run_1'); // run_1 already linked: no-op
      await s.bindRunManifest('s1:k2', 'run_2');
      expect(await s.getRunTools('run_2')).toEqual({ sessionId: 's1', tools: [] });
      await s.deleteRunManifest('s1:k1', 'n1'); // bound: kept
      expect(await s.getRunTools('run_1')).not.toBeNull();
      await s.putRunManifest({ key: 's1:k3', sessionId: 's1', tools: ['c'], createdAt: iso(3), nonce: 'n3' });
      await s.putRunManifest({ key: 's1:k3', sessionId: 's1', tools: ['c'], createdAt: iso(4), nonce: 'retry' }); // same-key retry: no-op
      await s.deleteRunManifest('s1:k3', 'retry'); // the retry did not create the row: kept
      await s.bindRunManifest('s1:k3', 'run_3');
      expect(await s.getRunTools('run_3')).toEqual({ sessionId: 's1', tools: ['c'] });
      await s.putRunManifest({ key: 's1:k4', sessionId: 's1', tools: ['d'], createdAt: iso(5), nonce: 'n4' });
      await s.deleteRunManifest('s1:k4', 'n4'); // its creator: deleted
      await s.bindRunManifest('s1:k4', 'run_4');
      expect(await s.getRunTools('run_4')).toBeNull();
    }),
  );

  it(
    'run manifests: retention prune drops old unbound and old bound rows only',
    withStore(async (s) => {
      const H = 3_600_000;
      const put = (key: string, at: number) => s.putRunManifest({ key, sessionId: 's1', tools: ['a'], createdAt: iso(at), nonce: key });
      await put('old-unbound', 0);
      await put('new-unbound', 2 * H);
      await put('old-bound', 0);
      await put('mid-bound', 2 * H);
      await s.bindRunManifest('old-bound', 'run_old');
      await s.bindRunManifest('mid-bound', 'run_mid');
      expect(await s.pruneRunManifests({ unboundBefore: iso(H), boundBefore: iso(H) })).toBe(2);
      expect(await s.getRunTools('run_old')).toBeNull();
      expect(await s.getRunTools('run_mid')).not.toBeNull();
      await s.bindRunManifest('new-unbound', 'run_new'); // still there
      expect(await s.getRunTools('run_new')).not.toBeNull();
      await put('old-unbound', 0); // gone, so it can be stored again
      await s.bindRunManifest('old-unbound', 'run_again');
      expect(await s.getRunTools('run_again')).toEqual({ sessionId: 's1', tools: ['a'] });
    }),
  );

  const at = iso();
  const now = iso();

  it(
    'outbox: seqs are per machine, monotonic, ack deletes and only moves forward',
    withStore(async (store) => {
      await store.insertMachine(machine('m1'));
      await store.insertMachine(machine('m2'));
      expect(await store.openLink('m1', { linkId: 'lnk_a', transport: 'http', at })).toEqual({ ackedSeq: 0 });
      expect(await store.enqueueOutbox('m1', [item('x'), item('y')], at)).toEqual([1, 2]);
      expect(await store.enqueueOutbox('m2', [item('z')], at)).toEqual([1]);
      expect(await store.enqueueOutbox('m1', [], at)).toEqual([]);
      const first = await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now });
      expect(first).toMatchObject({ state: 'current', busy: false });
      expect(first.items.map((i) => i.msgId)).toEqual(['x', 'y']);
      expect(first.items[0]).toEqual({ seq: 1, ...item('x') });
      expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 1, now })).items.map((i) => i.seq)).toEqual([1]);
      expect((await store.pollLink('m1', 'lnk_a', { after: 1, limit: 10, now })).items.map((i) => i.seq)).toEqual([2]);
      expect(await store.updateLink('m1', 'lnk_a', { ackedSeq: 1, at })).toBe('current');
      expect(await store.updateLink('m1', 'lnk_a', { ackedSeq: 0, at })).toBe('current');
      expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now })).items.map((i) => i.seq)).toEqual([2]);
      // An ack beyond what was enqueued cannot pre-delete future items.
      expect(await store.updateLink('m1', 'lnk_a', { ackedSeq: 99, at })).toBe('current');
      expect(await store.enqueueOutbox('m1', [item('w')], at)).toEqual([3]);
      expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now })).items.map((i) => i.msgId)).toEqual(['w']);
      // A new link keeps the machine's seqs and acked position.
      expect(await store.openLink('m1', { linkId: 'lnk_b', transport: 'ws', at })).toEqual({ ackedSeq: 2 });
      expect(await store.updateLink('m1', 'lnk_b', { busy: true, at })).toBe('current');
      expect(await store.pollLink('m1', 'lnk_b', { after: 2, limit: 10, now })).toMatchObject({ state: 'current', busy: true });
      expect(await store.updateLink('m1', 'lnk_b', { ackedSeq: 3, at })).toBe('current');
      expect((await store.pollLink('m1', 'lnk_b', { after: 0, limit: 10, now })).items).toEqual([]);
    }),
  );

  it(
    'outbox: expired items are not returned; a replaced link reports replaced; a deleted machine reports gone',
    withStore(async (store) => {
      await store.insertMachine(machine('m1'));
      await store.enqueueOutbox('m1', [item('old', t(-1)), item('fresh', t(60))], at); // before any link
      expect((await store.openLink('m1', { linkId: 'lnk_a', transport: 'http', at })).ackedSeq).toBe(0);
      expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now: t(0) })).items.map((i) => i.msgId)).toEqual(['fresh']);
      expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now: t(61) })).items).toEqual([]);

      await store.openLink('m1', { linkId: 'lnk_b', transport: 'http', at });
      expect(await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now })).toEqual({ state: 'replaced', busy: false, items: [] });
      expect(await store.updateLink('m1', 'lnk_a', { ackedSeq: 2, at })).toBe('replaced');
      expect((await store.pollLink('m1', 'lnk_b', { after: 0, limit: 10, now: t(0) })).items.map((i) => i.msgId)).toEqual(['fresh']); // replaced ack ignored
      await store.closeLink('m1', 'lnk_a'); // not current: no-op
      expect((await store.pollLink('m1', 'lnk_b', { after: 0, limit: 10, now })).state).toBe('current');

      await store.closeLink('m1', null);
      expect((await store.pollLink('m1', 'lnk_b', { after: 0, limit: 10, now })).state).toBe('gone');
      expect(await store.enqueueOutbox('m1', [item('later')], at)).toEqual([3]); // seqs survive a closed link

      await store.openLink('m1', { linkId: 'lnk_c', transport: 'http', at });
      await store.claimInbox('m1', ['up_1'], { leaseUntil: t(10), now: t(0) });
      expect(await store.deleteMachine('m1')).toBe(true);
      expect(await store.pollLink('m1', 'lnk_c', { after: 0, limit: 10, now })).toEqual({ state: 'gone', busy: false, items: [] });
      expect(await store.updateLink('m1', 'lnk_c', { busy: true, at })).toBe('gone');
      expect(await store.claimInbox('m1', ['up_1'], { leaseUntil: t(10), now: t(0) })).toEqual({ up_1: 'new' }); // inbox rows went too
      expect(await store.enqueueOutbox('m1', [item('x')], at)).toBe('gone'); // no link row resurrected for a deleted machine
      expect(await store.enqueueOutbox('nope', [item('x')], at)).toBe('gone');
      // A re-created link starts from scratch (no outbox rows left behind).
      await store.openLink('m1', { linkId: 'lnk_d', transport: 'http', at });
      expect((await store.pollLink('m1', 'lnk_d', { after: 0, limit: 10, now })).items).toEqual([]);
    }),
  );

  it(
    'inbox: new → busy while leased → new after lease expiry → done after complete',
    withStore(async (store) => {
      expect(await store.claimInbox('m1', ['a', 'b'], { leaseUntil: t(10), now: t(0) })).toEqual({ a: 'new', b: 'new' });
      expect(await store.claimInbox('m1', ['a'], { leaseUntil: t(15), now: t(5) })).toEqual({ a: 'busy' });
      expect(await store.claimInbox('m2', ['a'], { leaseUntil: t(15), now: t(5) })).toEqual({ a: 'new' }); // per machine
      expect(await store.claimInbox('m1', ['a', 'b'], { leaseUntil: t(21), now: t(11) })).toEqual({ a: 'new', b: 'new' });
      await store.completeInbox('m1', ['a'], t(12));
      expect(await store.claimInbox('m1', ['a', 'b', 'c'], { leaseUntil: t(40), now: t(30) })).toEqual({ a: 'done', b: 'new', c: 'new' });
      const both = await Promise.all([
        store.claimInbox('m1', ['d'], { leaseUntil: t(50), now: t(31) }),
        store.claimInbox('m1', ['d'], { leaseUntil: t(50), now: t(31) }),
      ]);
      expect(both.map((r) => r.d).sort()).toEqual(['busy', 'new']);
    }),
  );

  it(
    'inbox: a released claim is new again at once; release never undoes done',
    withStore(async (store) => {
      expect(await store.claimInbox('m1', ['a', 'b'], { leaseUntil: t(60), now: t(0) })).toEqual({ a: 'new', b: 'new' });
      await store.completeInbox('m1', ['b'], t(1));
      await store.releaseInbox('m1', ['a', 'b']);
      await store.releaseInbox('m1', []);
      expect(await store.claimInbox('m1', ['a', 'b'], { leaseUntil: t(60), now: t(2) })).toEqual({ a: 'new', b: 'done' });
      await store.releaseInbox('m2', ['a']); // other machine: no effect
      expect(await store.claimInbox('m1', ['a'], { leaseUntil: t(60), now: t(3) })).toEqual({ a: 'busy' });
    }),
  );

  const rec: ToolCallRecord = {
    id: 'tcl_1',
    callId: 'tc_1',
    sessionId: 's1',
    runId: 'run_1',
    userId: 'alice',
    machineId: 'm1',
    tool: 'lookup_order',
    args: { id: 'A-1' },
    status: 'running',
    startedAt: t(0),
  };
  const result: ToolResultFrame = { t: 'tool_result', id: 'tc_1', ok: false, error: { code: 'tool_failed', message: 'Site tool "lookup_order" timed out on the website. Please try again.', retryable: true } };
  const interrupted = { status: 'interrupted' as const, errorCode: 'tool_failed', errorMessage: 'interrupted', finishedAt: t(11), durationMs: 11_000 };
  const ok = { status: 'ok' as const, finishedAt: t(11), durationMs: 11_000 };

  it(
    'tool calls: new, running, stale after lease, done with the stored result; finish is CAS on running',
    withStore(async (store) => {
      expect(await store.claimToolCall(rec, { leaseUntil: t(10), now: t(0) })).toEqual({ kind: 'new' });
      expect(await store.claimToolCall({ ...rec, id: 'tcl_dup' }, { leaseUntil: t(20), now: t(5) })).toEqual({ kind: 'running' });
      expect(await store.listStaleToolCalls(t(5), 10)).toEqual([]);
      const stale = await store.claimToolCall(rec, { leaseUntil: t(30), now: t(11) });
      expect(stale).toEqual({ kind: 'stale', record: { ...rec, leaseUntil: t(10) } });
      expect(await store.listStaleToolCalls(t(11), 10)).toEqual([{ ...rec, leaseUntil: t(10) }]);
      // Same call id from another machine is a different call.
      expect(await store.claimToolCall({ ...rec, id: 'tcl_2', machineId: 'm2' }, { leaseUntil: t(30), now: t(11) })).toEqual({ kind: 'new' });
      expect(await store.finishToolCall(rec.id, { ...interrupted, result })).toBe(true);
      expect(await store.finishToolCall(rec.id, { ...ok, result })).toBe(false);
      expect(await store.claimToolCall(rec, { leaseUntil: t(40), now: t(12) })).toMatchObject({ kind: 'done', record: { status: 'interrupted', result } });
      // A running row without a lease (an older hub's audit row) is stale too, as claimToolCall treats it.
      await store.insertToolCall({ ...rec, id: 'tcl_old', callId: 'tc_old', startedAt: t(-1) });
      expect(await store.listStaleToolCalls(t(99), 10)).toEqual([
        { ...rec, id: 'tcl_old', callId: 'tc_old', startedAt: t(-1) },
        { ...rec, id: 'tcl_2', machineId: 'm2', leaseUntil: t(30) },
      ]);
      expect((await store.claimToolCall({ ...rec, id: 'tcl_x', callId: 'tc_old' }, { leaseUntil: t(200), now: t(99) })).kind).toBe('stale');
      expect((await store.listToolCalls('s1')).find((r) => r.id === 'tcl_1')).toMatchObject({ status: 'interrupted', errorMessage: 'interrupted', result });
      const racers = await Promise.all([
        store.claimToolCall({ ...rec, callId: 'tc_9', id: 'tcl_9a' }, { leaseUntil: t(50), now: t(40) }),
        store.claimToolCall({ ...rec, callId: 'tc_9', id: 'tcl_9b' }, { leaseUntil: t(50), now: t(40) }),
      ]);
      expect(racers.map((r) => r.kind).sort()).toEqual(['new', 'running']);
    }),
  );

  it(
    'rate limits: atomic under 20 parallel hits (exactly max allowed), release gives one back, new window resets',
    withStore(async (store) => {
      const o = { max: 5, windowMs: 60_000, nowMs: 120_000 + 1_000 };
      const hits = await Promise.all(Array.from({ length: 20 }, () => store.hitRateLimit('ip:1', o)));
      expect(hits.filter((h) => h.allowed)).toHaveLength(5);
      expect(hits.filter((h) => !h.allowed).every((h) => h.retryAfterMs === 59_000)).toBe(true);
      expect(hits.filter((h) => h.allowed).every((h) => h.retryAfterMs === 0)).toBe(true);
      expect((await store.hitRateLimit('ip:2', o)).allowed).toBe(true); // per key
      await store.releaseRateLimit('ip:1', o);
      expect((await store.hitRateLimit('ip:1', { ...o, nowMs: o.nowMs + 1 })).allowed).toBe(true);
      expect((await store.hitRateLimit('ip:1', o)).allowed).toBe(false);
      expect(await store.hitRateLimit('ip:1', { ...o, nowMs: 180_000 })).toEqual({ allowed: true, retryAfterMs: 0 });
      expect(await store.pruneTransport({ now, inboxBefore: iso(-1), rateLimitBeforeMs: 180_000 })).toMatchObject({ rateLimits: 2 });
    }),
  );

  it(
    'leases: one holder at a time; expired lease can be taken',
    withStore(async (store) => {
      const both = await Promise.all([
        store.tryLease('sweep', { holder: 'a', until: t(10), now: t(0) }),
        store.tryLease('sweep', { holder: 'b', until: t(10), now: t(0) }),
      ]);
      expect(both.filter(Boolean)).toHaveLength(1);
      const [winner, loser] = both[0] ? ['a', 'b'] : ['b', 'a'];
      expect(await store.tryLease('sweep', { holder: loser!, until: t(15), now: t(5) })).toBe(false);
      expect(await store.tryLease('sweep', { holder: winner!, until: t(20), now: t(5) })).toBe(true); // renew
      expect(await store.tryLease('other', { holder: loser!, until: t(20), now: t(5) })).toBe(true);
      expect(await store.tryLease('sweep', { holder: loser!, until: t(30), now: t(21) })).toBe(true);
      expect(await store.tryLease('sweep', { holder: winner!, until: t(40), now: t(22) })).toBe(false);
    }),
  );

  it(
    'recordDevicePoll returns the previous poll time',
    withStore(async (store) => {
      await store.insertDeviceCode({ deviceCodeHash: 'd1', userCodeHash: 'u1', status: 'pending', createdAt: t(0), expiresAt: t(600) });
      expect(await store.recordDevicePoll('d1', t(1))).toBeNull();
      expect(await store.recordDevicePoll('d1', t(6))).toBe(t(1));
      expect(await store.recordDevicePoll('d1', t(11))).toBe(t(6));
      expect(await store.recordDevicePoll('nope', t(11))).toBeNull();
      const polls = await Promise.all([store.recordDevicePoll('d1', t(20)), store.recordDevicePoll('d1', t(20))]);
      expect(polls.sort()).toEqual([t(11), t(20)]);
    }),
  );

  it(
    'pruneTransport drops expired outbox items, old finished inbox rows, old windows and long-expired device codes; machines can be marked outdated',
    withStore(async (store) => {
      await store.insertMachine(machine('m1'));
      expect(await store.getMachine('m1')).not.toHaveProperty('outdatedAt');
      await store.markMachineOutdated('m1', t(1));
      expect((await store.getMachine('m1'))?.outdatedAt).toBe(t(1));

      await store.openLink('m1', { linkId: 'lnk', transport: 'http', at: t(0) });
      await store.enqueueOutbox('m1', [item('a', t(5)), item('b', t(9_000))], at);
      await store.claimInbox('m1', ['done_old', 'leased', 'expired'], { leaseUntil: t(10), now: t(0) });
      await store.completeInbox('m1', ['done_old'], t(1));
      expect(await store.claimInbox('m1', ['leased'], { leaseUntil: t(9_999), now: t(11) })).toEqual({ leased: 'new' }); // re-claimed: lease runs past the prune
      await store.hitRateLimit('k', { max: 1, windowMs: 1000, nowMs: 0 });
      await store.insertDeviceCode({ deviceCodeHash: 'dx', userCodeHash: 'ux', status: 'pending', createdAt: t(0), expiresAt: t(1) });
      await store.insertDeviceCode({ deviceCodeHash: 'dy', userCodeHash: 'uy', status: 'pending', createdAt: t(0), expiresAt: t(9_000) });

      const now2 = t(7_200);
      expect(await store.pruneTransport({ now: now2, inboxBefore: t(100), rateLimitBeforeMs: 1000 })).toEqual({ outbox: 1, inbox: 2, rateLimits: 1, deviceCodes: 1 });
      expect((await store.pollLink('m1', 'lnk', { after: 0, limit: 10, now: t(0) })).items.map((i) => i.msgId)).toEqual(['b']);
      expect(await store.getDeviceCode('dx')).toBeNull();
      expect(await store.getDeviceCode('dy')).not.toBeNull();
      // done_old (done) and expired (lease over, never completed) went; leased (lease still running) stays.
      expect(await store.claimInbox('m1', ['done_old', 'leased'], { leaseUntil: t(9_999), now: t(20) })).toEqual({ done_old: 'new', leased: 'busy' });
    }),
  );
}
