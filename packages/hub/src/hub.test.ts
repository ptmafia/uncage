import { DeviceTokenResponseSchema, MachineInfoSchema, type MachineInfo, type Session, type UncageEvent } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHub, HUB_VERSION } from './hub.js';
import { defaultCliRange } from './install/render.js';
import { CLOSE } from './node/ws.js';
import { pgliteHubStore } from './node/index.js';
import { sha256Hex } from './web.js';
import {
  connectFakeAgent,
  fakeMachine,
  fakeSession,
  makeEvent,
  NO_REPLY,
  readSse,
  sleep,
  startTestHub,
  until,
  type FakeAgent,
  type TestHub,
} from './test-utils.js';
import { defineTool } from './tools.js';
import type { HubOptions } from './types.js';

let th: TestHub | undefined;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await th?.close();
  th = undefined;
});

const start = async (o: Parameters<typeof startTestHub>[0] = {}) => (th = await startTestHub(o));
const connect = async (o: Parameters<typeof connectFakeAgent>[0]) => {
  const a = await connectFakeAgent(o);
  agents.push(a);
  return a;
};
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const machinesOf = async (t: TestHub, user: string) => (await (await t.as(user, '/machines')).json()) as MachineInfo[];

describe('device login over HTTP', () => {
  it('happy path pairs a machine; the token is stored hashed and returned once', async () => {
    const t = await start();
    const code = await j(fetch(`${t.api}/device/code`, post({ name: 'MacBook', os: 'darwin' })));
    expect(code).toMatchObject({ intervalSec: 2, expiresInSec: 600 });
    expect(code.verificationUri).toBe(`${t.origin}/device?code=${code.userCode}`);
    const poll = async () => (await fetch(`${t.api}/device/token`, post({ deviceCode: code.deviceCode }))).json();
    expect(await poll()).toEqual({ status: 'pending' });
    expect(await t.hub.lookupDevice(code.userCode, { id: 'alice' })).toMatchObject({ name: 'MacBook', os: 'darwin' });
    expect(await t.hub.approveDevice(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await poll()).toEqual({ status: 'slow_down' }); // faster than intervalSec
    await sleep(1600);
    const ok = DeviceTokenResponseSchema.parse(await poll());
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.machineToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(ok.site).toEqual({ id: '127.0.0.1-' + new URL(t.origin).port, name: '127.0.0.1', url: t.api });
    expect(ok.transports).toEqual([{ kind: 'ws', url: t.wsUrl }]);
    const m = await t.store.getMachine(ok.machineId);
    expect(m?.userId).toBe('alice');
    expect(m?.tokenHash).toBe(await sha256Hex(ok.machineToken));
    expect(JSON.stringify(m)).not.toContain(ok.machineToken);
    await sleep(1600);
    expect(await poll()).toEqual({ status: 'expired' });
    expect((await machinesOf(t, 'alice')).map((x) => x.name)).toEqual(['MacBook']);
  }, 20_000); // two real-time waits of intervalSec

  it('denied', async () => {
    const t = await start();
    const code = await j(fetch(`${t.api}/device/code`, post({})));
    expect(await t.hub.denyDevice(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await (await fetch(`${t.api}/device/token`, post({ deviceCode: code.deviceCode }))).json()).toEqual({ status: 'denied' });
    expect(await machinesOf(t, 'alice')).toEqual([]);
  });

  it('unknown device code → 404; bad body → 400', async () => {
    const t = await start();
    expect((await fetch(`${t.api}/device/token`, post({ deviceCode: 'nope' }))).status).toBe(404);
    expect((await fetch(`${t.api}/device/token`, post({}))).status).toBe(400);
    expect(await t.hub.approveDevice('ZZZZ-ZZZZ', { id: 'alice' })).toBe('not_found');
  });
});

describe('machine connections', () => {
  it('rejects upgrades without a valid machine token', async () => {
    const t = await start();
    await expect(connectFakeAgent({ url: t.wsUrl, token: 'x'.repeat(43) })).rejects.toThrow(/401/);
    await expect(connectFakeAgent({ url: t.wsUrl, token: '' })).rejects.toThrow(/401/);
  });

  it('welcome on hello; online with hello details; offline on disconnect', async () => {
    const t = await start();
    const { machineId, machineToken } = await t.pair('alice', { name: 'Pending name' });
    expect((await machinesOf(t, 'alice'))[0]).toMatchObject({ id: machineId, online: false });
    const a = await connect({ url: t.wsUrl, token: machineToken, name: 'Alice MBP', os: 'darwin 25.6', agentVersion: '99.1.0' });
    expect(a.frames[0]).toMatchObject({ t: 'welcome', machineId, protocol: 2 });
    const [m] = await machinesOf(t, 'alice');
    expect(MachineInfoSchema.parse(m)).toMatchObject({ online: true, name: 'Alice MBP', os: 'darwin 25.6', agentVersion: '99.1.0', agentOutdated: false, transport: 'ws' });
    expect(m!.runtimes.map((r) => r.id)).toEqual(['fake']);
    await a.close();
    await until(async () => (await machinesOf(t, 'alice'))[0]?.online === false);
    expect((await machinesOf(t, 'alice'))[0]).toMatchObject({ online: false, transport: null });
  });

  it('a protocol 1 (0.2) hello gets upgrade_required', async () => {
    const t = await start();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, protocol: 1, waitWelcome: false });
    expect(await a.waitFor((f) => f.t === 'upgrade_required')).toMatchObject({ t: 'upgrade_required' });
    expect((await a.closed).code).toBe(CLOSE.upgrade);
  });

  it('sends upgrade_required to agents older than minAgentVersion', async () => {
    const t = await start({ minAgentVersion: '0.2.0' });
    const { machineId, machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, agentVersion: '0.1.9', waitWelcome: false });
    expect(await a.waitFor((f) => f.t === 'upgrade_required')).toEqual({ t: 'upgrade_required', minAgentVersion: '0.2.0' });
    expect((await a.closed).code).toBe(CLOSE.upgrade);
    expect((await machinesOf(t, 'alice'))[0]).toMatchObject({ online: false, agentOutdated: false }); // never said hello
    await t.store.updateMachine(machineId, { agentVersion: '0.1.9' });
    expect((await machinesOf(t, 'alice'))[0]).toMatchObject({ agentVersion: '0.1.9', agentOutdated: true });
    // Exactly the minimum is fine.
    const b = await connect({ url: t.wsUrl, token: machineToken, agentVersion: '0.2.0' });
    expect(b.frames[0]?.t).toBe('welcome');
  });

  it('closes a socket whose first frame is not hello, and on malformed frames', async () => {
    const t = await start();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    a.ws.send('{"t":"nope"}');
    expect((await a.closed).code).toBe(CLOSE.policy);
  });

  // Review Focus 1: a sleeping laptop keeps its TCP connection but stops answering.
  it('marks a machine offline after 2 missed pings, and keeps an answering one online', async () => {
    const t = await start({ heartbeat: { pingIntervalMs: 40 } });
    const alive = await t.pair('alice', { name: 'alive' });
    const asleep = await t.pair('alice', { name: 'asleep' });
    await connect({ url: t.wsUrl, token: alive.machineToken, name: 'alive' });
    const b = await connect({ url: t.wsUrl, token: asleep.machineToken, name: 'asleep' });
    b.autoPong = false;
    const startedAt = Date.now();
    const closed = await b.closed;
    const elapsed = Date.now() - startedAt;
    expect(closed.code).not.toBe(1000);
    // 2 missed pings at a 40 ms interval: offline on the 3rd tick (~80–120 ms), not earlier.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    const byName = Object.fromEntries((await machinesOf(t, 'alice')).map((m) => [m.name, m.online]));
    expect(byName).toEqual({ alive: true, asleep: false });
    await sleep(200);
    expect(Object.fromEntries((await machinesOf(t, 'alice')).map((m) => [m.name, m.online]))).toEqual({ alive: true, asleep: false });
    // POST /sessions to the offline machine → machine_offline.
    const res = await t.as('alice', '/sessions', post({ runtime: 'fake', machineId: asleep.machineId }));
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe('machine_offline');
  });

  it('a newer connection for the same machine replaces the old one', async () => {
    const t = await start();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    await connect({ url: t.wsUrl, token: machineToken });
    expect((await a.closed).code).toBe(CLOSE.replaced);
    await sleep(20);
    expect((await machinesOf(t, 'alice'))[0]?.online).toBe(true);
  });

  it('revoking disconnects the machine and invalidates its token', async () => {
    const t = await start();
    const { machineId, machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    const res = await t.as('alice', `/machines/${machineId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await a.closed).code).toBe(CLOSE.revoked);
    expect(await machinesOf(t, 'alice')).toEqual([]);
    await expect(connectFakeAgent({ url: t.wsUrl, token: machineToken })).rejects.toThrow(/401/);
  });

  it('a machine can revoke itself with its own token (uncage sites remove)', async () => {
    const t = await start();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    expect((await fetch(`${t.api}/machine/revoke`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${t.api}/machine/revoke`, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const res = await fetch(`${t.api}/machine/revoke`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await a.closed).code).toBe(CLOSE.revoked);
    expect(await machinesOf(t, 'alice')).toEqual([]);
    await expect(connectFakeAgent({ url: t.wsUrl, token: machineToken })).rejects.toThrow(/401/);
  });

});

describe('browser API → machine', () => {
  it('requires a signed-in user; refuses cross-site writes', async () => {
    const t = await start();
    expect((await fetch(`${t.api}/sessions`)).status).toBe(401);
    expect((await fetch(`${t.api}/machines`)).status).toBe(401);
    const res = await t.as('alice', '/sessions', post({ runtime: 'fake' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect((await t.as('alice', '/nope')).status).toBe(404);
  });

  it('POST /sessions reaches the most recently seen online machine; machineId picks one', async () => {
    const t = await start();
    const fm1 = fakeMachine();
    const fm2 = fakeMachine();
    const m1 = await t.pair('alice', { name: 'one' });
    const m2 = await t.pair('alice', { name: 'two' });
    const a1 = await connect({ url: t.wsUrl, token: m1.machineToken, name: 'one', onCommand: fm1.handler });
    await sleep(5);
    const a2 = await connect({ url: t.wsUrl, token: m2.machineToken, name: 'two', onCommand: fm2.handler });

    const res = await t.as('alice', '/sessions', post({ runtime: 'fake', title: 'Hello', workspace: '/etc' }));
    expect(res.status).toBe(201);
    const s = (await j(res)) as Session;
    expect(a2.commands.map((c) => c.op)).toEqual(['createSession']);
    // The browser cannot choose the workspace; the hub chooses the id (and recorded it first).
    expect(a2.commands[0]!.args).toEqual({ id: s.id, runtime: 'fake', title: 'Hello' });
    expect(await t.store.getSession(s.id)).toMatchObject({ runtime: 'fake', title: 'Hello' });
    expect(a1.commands).toEqual([]);
    expect((await t.store.getSession(s.id))?.machineId).toBe(m2.machineId);

    const res1 = await t.as('alice', '/sessions', post({ runtime: 'fake', machineId: m1.machineId }));
    expect(res1.status).toBe(201);
    expect(a1.commands.map((c) => c.op)).toEqual(['createSession']);

    // GET /sessions lists both (machine storage: asks each online machine).
    const list = (await (await t.as('alice', '/sessions')).json()) as Session[];
    expect(list.map((x) => x.id).sort()).toEqual([s.id, ((await j(res1)) as Session).id].sort());
  });

  for (const storage of ['machine', 'site'] as const) {
    it(`every session the browser sees carries its machineId (${storage} storage)`, async () => {
      const t = await start({ sessionStorage: storage });
      const fm = fakeMachine();
      const { machineToken, machineId } = await t.pair('alice');
      const a = await connect({
        url: t.wsUrl,
        token: machineToken,
        onCommand: (cmd) =>
          cmd.op === 'updateSettings'
            ? { ...fm.sessions.get((cmd.args as { sessionId: string }).sessionId)!.session, settings: { permissionMode: 'plan' } }
            : fm.handler(cmd),
      });
      const s = (await j(t.as('alice', '/sessions', post({ runtime: 'fake' })))) as Session;
      expect(s.machineId).toBe(machineId);
      // The machine itself never sends machineId; the hub stamps it.
      expect(fm.sessions.get(s.id)!.session.machineId).toBeUndefined();
      if (storage === 'site') a.sendEvents(s.id, fm.sessions.get(s.id)!.events);
      if (storage === 'site') await a.waitFor((f) => f.t === 'ack');
      expect(((await j(t.as('alice', '/sessions'))) as Session[]).map((x) => x.machineId)).toEqual([machineId]);
      expect((await j(t.as('alice', `/sessions/${s.id}`))).session.machineId).toBe(machineId);
      const patched = await j(t.as('alice', `/sessions/${s.id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissionMode: 'plan' }) }));
      expect(patched.machineId).toBe(machineId);
      const events = (await j(t.as('alice', `/sessions/${s.id}/events?after=0`, { headers: { accept: 'application/json' } }))) as UncageEvent[];
      const created = events.find((e) => e.type === 'session.created') as Extract<UncageEvent, { type: 'session.created' }>;
      expect(created.payload.session.machineId).toBe(machineId);
    });
  }

  it('no machine → machine_not_found; offline → machine_offline', async () => {
    const t = await start();
    let res = await t.as('alice', '/sessions', post({ runtime: 'fake' }));
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('machine_not_found');
    await t.pair('alice');
    res = await t.as('alice', '/sessions', post({ runtime: 'fake' }));
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe('machine_offline');
  });

  it('startRun carries the selected manifest and requires Idempotency-Key', async () => {
    const tool = defineTool({
      name: 'create_asset',
      description: 'Create an asset',
      input: z.object({ title: z.string() }),
      handler: async () => 'ok',
    });
    const other = defineTool({ name: 'publish_asset', description: 'Publish', input: z.object({}), requiresConfirmation: true, handler: async () => 'ok' });
    const skill = { name: 'landing-page', description: 'Landing page rules', markdown: '# Rules' };
    const seen: unknown[] = [];
    const t = await start({
      tools: [tool, other],
      skills: [skill],
      selectManifest: async (ctx) => {
        seen.push(ctx);
        return { tools: ['create_asset', 'unknown_tool'], skills: ['landing-page'] };
      },
    });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: (cmd) =>
        cmd.op === 'startRun'
          ? { id: 'run_1', sessionId: (cmd.args as { sessionId: string }).sessionId, prompt: 'p', state: 'queued', createdAt: new Date().toISOString() }
          : fm.handler(cmd),
    });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    expect((await t.as('alice', `/sessions/${s.id}/runs`, post({ prompt: 'make a page' }))).status).toBe(400);
    const res = await t.as('alice', `/sessions/${s.id}/runs`, post({ prompt: 'make a page' }, { 'idempotency-key': 'k1' }));
    expect(res.status).toBe(202);
    expect(seen).toEqual([{ user: { id: 'alice' }, prompt: 'make a page', sessionId: s.id, runtime: 'fake' }]);
    const cmd = a.commands.find((c) => c.op === 'startRun')!;
    const args = cmd.args as { idempotencyKey: string; manifest: { tools: Array<Record<string, unknown>>; skills: unknown[] } };
    expect(args.idempotencyKey).toBe('k1');
    expect(args.manifest.tools).toHaveLength(1);
    expect(args.manifest.tools[0]).toMatchObject({ name: 'create_asset', requiresConfirmation: false, inputSchema: { type: 'object' } });
    expect(args.manifest.skills).toEqual([skill]);
    // The run is now routable for its owner.
    expect((await t.store.getResource('run_1', 'run'))?.sessionId).toBe(s.id);
    expect(args).not.toHaveProperty('warnings');
  });

  it('a runtime without siteTools (Codex): tools dropped, skills kept, site_tools_unsupported warning', async () => {
    const tool = defineTool({ name: 'create_asset', description: 'Create', input: z.object({}), handler: async () => 'ok' });
    const skill = { name: 'landing-page', description: 'Landing page rules', markdown: '# Rules' };
    const seen: Array<{ runtime: string }> = [];
    const t = await start({
      tools: [tool],
      skills: [skill],
      selectManifest: async (ctx) => {
        seen.push(ctx);
        return { tools: ['create_asset'], skills: ['landing-page'] };
      },
    });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const caps = (siteTools: boolean) => ({ ...fakeSession('x').capabilities, siteTools });
    const a = await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: fm.handler,
      runtimes: [
        { id: 'codex', displayName: 'Codex', status: 'available', capabilities: caps(false) },
        { id: 'fake', displayName: 'Fake', status: 'available', capabilities: caps(true) },
      ],
    });
    const codex = (await j(t.as('alice', '/sessions', post({ runtime: 'codex' })))) as Session;
    expect((await t.as('alice', `/sessions/${codex.id}/runs`, post({ prompt: 'p' }, { 'idempotency-key': 'k1' }))).status).toBe(202);
    const fake = (await j(t.as('alice', '/sessions', post({ runtime: 'fake' })))) as Session;
    expect((await t.as('alice', `/sessions/${fake.id}/runs`, post({ prompt: 'p' }, { 'idempotency-key': 'k2' }))).status).toBe(202);
    expect(seen.map((c) => c.runtime)).toEqual(['codex', 'fake']);
    const [onCodex, onFake] = a.commands.filter((c) => c.op === 'startRun').map((c) => c.args as { manifest: { tools: unknown[]; skills: unknown[] }; warnings?: unknown });
    expect(onCodex!.manifest).toEqual({ tools: [], skills: [skill] });
    expect(onCodex!.warnings).toEqual([{ code: 'site_tools_unsupported', message: expect.stringContaining('Codex') }]);
    expect(onFake!.manifest.tools).toHaveLength(1);
    expect(onFake).not.toHaveProperty('warnings');
  });

  it('session creation: a refusal removes the hub record; an agent that ignores the id is recorded under its own', async () => {
    const t = await start({ sessionStorage: 'site' });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    let mode: 'refuse' | 'own-id' = 'refuse';
    await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: (cmd) => {
        if (cmd.op !== 'createSession') return fm.handler(cmd);
        if (mode === 'refuse') throw Object.assign(new Error('Runtime nope not found.'), { code: 'not_found' });
        return fm.handler({ ...cmd, args: { runtime: 'fake' } });
      },
    });
    expect((await t.as('alice', '/sessions', post({ runtime: 'nope' }))).status).toBe(404);
    expect(await t.store.listSessions('alice')).toEqual([]);
    mode = 'own-id';
    const s = (await j(t.as('alice', '/sessions', post({ runtime: 'fake' })))) as Session;
    expect((await t.store.listSessions('alice')).map((r) => r.id)).toEqual([s.id]);
    expect(((await j(t.as('alice', '/sessions'))) as Session[]).map((x) => x.id)).toEqual([s.id]);
  });

  it('events from the machine stream to SSE subscribers (history + live, resume with Last-Event-ID)', async () => {
    const t = await start({ sseHeartbeatMs: 30 });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;

    const ac = new AbortController();
    const res = await t.as('alice', `/sessions/${s.id}/events?after=0`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = readSse(res);
    const got: Array<{ id?: string; event?: string; data: string }> = [];
    let sawHeartbeat = false;
    const reader = (async () => {
      for await (const f of frames) {
        if (f.comment) sawHeartbeat = true;
        else got.push(f);
      }
    })().catch(() => undefined);

    // History (session.created, from the machine via readEvents), then live events.
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ id: 'evt_0000000001', event: 'session.created' });
    a.sendEvents(s.id, [fm.append(s.id, 'message.started', { messageId: 'm1', role: 'assistant' })]);
    a.sendEvents(s.id, [fm.append(s.id, 'message.delta', { messageId: 'm1', chunkIndex: 0, text: 'Hi' })]);
    // A duplicate is not re-sent.
    a.sendEvents(s.id, [fm.sessions.get(s.id)!.events[1]!]);
    await until(() => got.length === 3);
    await sleep(80);
    expect(got.map((f) => f.event)).toEqual(['session.created', 'message.started', 'message.delta']);
    expect((JSON.parse(got[2]!.data) as UncageEvent).payload).toMatchObject({ text: 'Hi' });
    expect(sawHeartbeat).toBe(true);
    ac.abort();
    await reader;

    // Gap: a live event beyond the next sequence makes the stream fetch the missing ones.
    const missed = fm.append(s.id, 'message.delta', { messageId: 'm1', chunkIndex: 1, text: ' there' });
    void missed;
    const ac2 = new AbortController();
    const res2 = await t.as('alice', `/sessions/${s.id}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': 'evt_0000000002' },
      signal: ac2.signal,
    });
    const got2: string[] = [];
    const reader2 = (async () => {
      for await (const f of readSse(res2)) if (!f.comment) got2.push(f.id!);
    })().catch(() => undefined);
    await until(() => got2.length === 2);
    a.sendEvents(s.id, [fm.append(s.id, 'message.completed', { messageId: 'm1', text: 'Hi there' })]);
    await until(() => got2.length === 3);
    expect(got2).toEqual(['evt_0000000003', 'evt_0000000004', 'evt_0000000005']);
    ac2.abort();
    await reader2;

    // JSON mode for exports.
    const all = (await (await t.as('alice', `/sessions/${s.id}/events?after=1&limit=2`, { headers: { accept: 'application/json' } })).json()) as UncageEvent[];
    expect(all.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it('machine storage: history needs the machine (offline → error frame, snapshot 409)', async () => {
    const t = await start();
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    expect((await t.as('alice', `/sessions/${s.id}`)).status).toBe(200);
    await a.close();
    await until(async () => (await machinesOf(t, 'alice'))[0]?.online === false);
    const snap = await t.as('alice', `/sessions/${s.id}`);
    expect(snap.status).toBe(409);
    expect((await j(snap)).error.code).toBe('machine_offline');
    const res = await t.as('alice', `/sessions/${s.id}/events`, { headers: { accept: 'text/event-stream' } });
    const frames: Array<{ event?: string; data: string }> = [];
    for await (const f of readSse(res)) if (!f.comment) frames.push(f);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
    expect(JSON.parse(frames[0]!.data).code).toBe('machine_offline');
  });

  it('attachments: relayed to the machine as base64, served back to the owner only', async () => {
    const t = await start();
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: (cmd) => {
        if (cmd.op !== 'addAttachment') return fm.handler(cmd);
        const x = cmd.args as { sessionId: string; name: string; mime: string; data: string };
        return { id: 'att_1', sessionId: x.sessionId, name: x.name, mime: x.mime, size: Buffer.from(x.data, 'base64').length, kind: 'image', sha256: 'x', createdAt: new Date().toISOString() };
      },
    });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await t.as('alice', `/sessions/${s.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent('图.png') },
      body: png,
    });
    expect(up.status).toBe(201);
    const cmd = a.commands.find((c) => c.op === 'addAttachment')!;
    expect(cmd.args).toMatchObject({ sessionId: s.id, name: '图.png', mime: 'image/png', data: Buffer.from(png).toString('base64') });
    const dl = await t.as('alice', '/attachments/att_1');
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(png);
    expect((await t.as('bob', '/attachments/att_1')).status).toBe(404);

    const big = await t.as('alice', `/sessions/${s.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'big.png' },
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
    expect((await j(big)).error.code).toBe('attachment_too_large');
  });

  it('attachment bytes: swept after attachmentRetentionDays; revoking the machine deletes them', async () => {
    const t = await start({ attachmentRetentionDays: 1, manifestSweep: { intervalMs: 50 } });
    const fm = fakeMachine();
    const { machineToken, machineId } = await t.pair('alice');
    let n = 0;
    let createdAt = new Date().toISOString();
    await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: (cmd) => {
        if (cmd.op !== 'addAttachment') return fm.handler(cmd);
        const x = cmd.args as { sessionId: string; name: string; mime: string; data: string };
        return { id: `att_${++n}`, sessionId: x.sessionId, name: x.name, mime: x.mime, size: 1, kind: 'file', sha256: 'x', createdAt };
      },
    });
    const s = (await j(t.as('alice', '/sessions', post({ runtime: 'fake' })))) as Session;
    const upload = () => t.as('alice', `/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt' }, body: 'a' });
    createdAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect((await upload()).status).toBe(201); // att_1: two days old
    createdAt = new Date().toISOString();
    expect((await upload()).status).toBe(201); // att_2: fresh
    await until(async () => (await t.store.getAttachment('att_1')) === null);
    expect((await t.as('alice', '/attachments/att_1')).status).toBe(404);
    expect((await t.store.getAttachment('att_2'))?.machineId).toBe(machineId);
    await t.hub.revokeMachine(machineId, { id: 'alice' });
    expect(await t.store.getAttachment('att_2')).toBeNull();
  });

  it('attachmentRetentionDays must be positive', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    await expect(createHub({ publicUrl: 'https://x.test', getUser: async () => null, store, attachmentRetentionDays: 0 })).rejects.toThrow(/attachmentRetentionDays/);
    await store.close();
  });

  it('install info and install.sh', async () => {
    const t = await start();
    expect(await (await t.as('alice', '/machines/install')).json()).toEqual({
      install: `curl -fsSL ${t.api}/install.sh | bash`,
      setup: `uncage setup ${t.origin}`,
      windows: null,
    });
    const res = await fetch(`${t.api}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const sh = await res.text();
    expect(sh.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(sh.trimEnd().endsWith('main "$@"')).toBe(true);
    expect(sh).toContain(`npm install -g "@uncage/cli@${defaultCliRange(HUB_VERSION)}"`);
    expect(sh).toContain(`SITE_URL='${t.origin}'`);
    expect(sh).toContain('uncage_msg_zh()');
    expect(sh).not.toContain('@@');
  });

  it('install.sh varies only by range, site URL and extension; invalid ranges are refused', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const sh = async (o: Partial<HubOptions> & { publicUrl: string }) => {
      const hub = await createHub({ getUser: async () => null, store, ...o });
      try {
        return await (await hub.fetch(new Request(`${o.publicUrl}${o.basePath ?? '/api/uncage'}/install.sh`))).text();
      } finally {
        await hub.close();
      }
    };
    const a = await sh({ publicUrl: 'https://one.example', cliVersionRange: '~0.2.1' });
    expect(await sh({ publicUrl: 'https://one.example', cliVersionRange: '~0.2.1', site: { id: 'x', name: 'X' }, minAgentVersion: '0.2.0' })).toBe(a);
    const b = await sh({ publicUrl: 'https://two.example:8443', cliVersionRange: '^0.3' });
    expect(b.replaceAll('https://two.example:8443', 'https://one.example').replaceAll('^0.3', '~0.2.1')).toBe(a);
    // A custom basePath puts it in the setup URL.
    expect(await sh({ publicUrl: 'https://one.example', basePath: '/hub', cliVersionRange: '~0.2.1' })).toContain("SITE_URL='https://one.example/hub'");
    const ext = await sh({ publicUrl: 'https://one.example', cliVersionRange: '~0.2.1', installScript: { shAfterCli: 'echo EXTRA-STEP' } });
    expect(ext).toContain('echo EXTRA-STEP');
    const withoutExtension = (x: string) => x.replace(/# The website's own install step[^\n]*\nuncage_extension\(\) \{[\s\S]*?\n\}\n/, '');
    expect(withoutExtension(ext)).toBe(withoutExtension(a));
    await expect(createHub({ publicUrl: 'https://x.example', getUser: async () => null, store, cliVersionRange: '1; rm -rf /' })).rejects.toThrow(/cliVersionRange/);
    // Review Focus 10: a site URL that is not inert in a shell never reaches the script.
    await expect(createHub({ publicUrl: 'http://lan.example:3000', getUser: async () => null, store })).rejects.toThrow(/site URL/);
    await expect(createHub({ publicUrl: 'https://x.example', basePath: "/a'b", getUser: async () => null, store })).rejects.toThrow(/site URL/);
    await expect(createHub({ publicUrl: 'https://x.example', getUser: async () => null, store, installScript: { shAfterCli: 'a\0b' } })).rejects.toThrow(/installScript\.shAfterCli/);
    await store.close();
  });
});

// Review Focus 2: guessing another user's ids must look exactly like a missing id.
describe('cross-user isolation', () => {
  it('bob gets 404 for every alice resource and never reaches her machine', async () => {
    const t = await start();
    const fm = fakeMachine();
    const alice = await t.pair('alice');
    const a = await connect({
      url: t.wsUrl,
      token: alice.machineToken,
      onCommand: (cmd) =>
        cmd.op === 'startRun'
          ? { id: 'run_a', sessionId: (cmd.args as { sessionId: string }).sessionId, prompt: 'p', state: 'queued', createdAt: new Date().toISOString() }
          : fm.handler(cmd),
    });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    await t.as('alice', `/sessions/${s.id}/runs`, post({ prompt: 'x' }, { 'idempotency-key': 'k' }));
    const approval = {
      id: 'apr_a',
      sessionId: s.id,
      runId: 'run_a',
      runtimeId: 'fake',
      category: 'shell' as const,
      title: 'Run ls',
      target: { command: 'ls' },
      allowedScopes: ['once' as const],
      availableDecisions: ['allow_once' as const, 'deny' as const],
      state: 'pending' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      version: 1,
    };
    a.sendEvents(s.id, [fm.append(s.id, 'approval.requested', { approval }, 'run_a')]);
    await until(async () => (await t.store.getResource('apr_a', 'approval')) !== null);
    const before = a.commands.length;

    // Bob has his own machine, so "no machine" is not why he is refused.
    const bob = await t.pair('bob');
    await connect({ url: t.wsUrl, token: bob.machineToken, onCommand: fakeMachine().handler });

    const missing = await t.as('bob', '/sessions/ses_doesnotexist');
    const missingBody = (await j(missing)).error;
    const checks: Array<[string, RequestInit?]> = [
      [`/sessions/${s.id}`],
      [`/sessions/${s.id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissionMode: 'plan' }) }],
      [`/sessions/${s.id}/runs`, post({ prompt: 'steal' }, { 'idempotency-key': 'k2' })],
      [`/sessions/${s.id}/events`, { headers: { accept: 'text/event-stream' } }],
      [`/sessions/${s.id}/events`, { headers: { accept: 'application/json' } }],
      [`/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt' }, body: 'x' }],
      [`/approvals?sessionId=${s.id}`],
      ['/approvals/apr_a/decision', post({ decision: 'allow', scope: 'once' }, { 'idempotency-key': 'k3' })],
      ['/runs/run_a'],
      ['/runs/run_a/cancel', post({})],
    ];
    for (const [path, init] of checks) {
      const res = await t.as('bob', path, init);
      expect(res.status, path).toBe(404);
      const body = (await j(res)).error;
      expect(body.code, path).toBe('not_found');
      expect(body.hint).toBe(missingBody.hint);
    }
    const mchecks: Array<[string, RequestInit?]> = [
      [`/machines/${alice.machineId}`, { method: 'DELETE' }],
      [`/runtimes?machineId=${alice.machineId}`],
      ['/sessions', post({ runtime: 'fake', machineId: alice.machineId })],
    ];
    for (const [path, init] of mchecks) {
      const res = await t.as('bob', path, init);
      expect(res.status, path).toBe(404);
      expect((await j(res)).error.code, path).toBe('machine_not_found');
    }
    await expect(t.hub.revokeMachine(alice.machineId, { id: 'bob' })).rejects.toMatchObject({ code: 'machine_not_found' });

    // Lists contain only bob's own things.
    expect((await machinesOf(t, 'bob')).map((m) => m.id)).toEqual([bob.machineId]);
    expect(await (await t.as('bob', '/sessions')).json()).toEqual([]);
    expect(await (await t.as('bob', '/runs?active=1')).json()).toEqual([]);
    // Nothing bob did reached alice's machine; alice's machine is still connected.
    expect(a.commands.length).toBe(before);
    expect((await machinesOf(t, 'alice'))[0]?.online).toBe(true);
  });

  it("a machine cannot inject events into another machine's session", async () => {
    const t = await start({ sessionStorage: 'site' });
    const fm = fakeMachine();
    const alice = await t.pair('alice');
    await connect({ url: t.wsUrl, token: alice.machineToken, onCommand: fm.handler });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake' }))).json()) as Session;
    const bob = await t.pair('bob');
    const b = await connect({ url: t.wsUrl, token: bob.machineToken });
    b.sendEvents(s.id, [makeEvent(s.id, 1, 'session.updated', { session: { ...fakeSession(s.id), title: 'pwned' } })]);
    await sleep(100);
    expect(await t.store.readEvents(s.id, 0, 10)).toEqual([]);
    expect((await t.store.getSession(s.id))?.userId).toBe('alice');
    expect(b.frames.some((f) => f.t === 'ack')).toBe(false);
  });
});

describe('sessions the hub did not create', () => {
  it('site storage: events for an unknown session id are ignored (nothing stored, no ack, logged)', async () => {
    const warned: unknown[] = [];
    const t = await start({ sessionStorage: 'site', logger: { warn: (o: unknown, m: string) => warned.push([o, m]), error: () => undefined } });
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken });
    const rogue = fakeSession('ses_rogue0001');
    a.sendEvents(rogue.id, [makeEvent(rogue.id, 1, 'session.created', { session: rogue })]);
    await until(() => warned.length > 0);
    expect(await t.store.getSession(rogue.id)).toBeNull();
    expect(await t.store.readEvents(rogue.id, 0, 10)).toEqual([]);
    expect(a.frames.some((f) => f.t === 'ack')).toBe(false);
    expect(await j(t.as('alice', '/sessions'))).toEqual([]);
  });

  it("site storage: a created session's first events may arrive before the createSession result", async () => {
    const t = await start({ sessionStorage: 'site' });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({
      url: t.wsUrl,
      token: machineToken,
      onCommand: (cmd) => (cmd.op === 'createSession' ? NO_REPLY : fm.handler(cmd)),
      onFrame: (f, send) => {
        if (f.t !== 'command' || f.op !== 'createSession') return;
        const session = fm.handler(f) as Session;
        send({ t: 'events', sessionId: session.id, events: fm.sessions.get(session.id)!.events });
        setTimeout(() => send({ t: 'result', id: f.id, ok: true, data: session }), 50);
      },
    });
    const s = (await j(t.as('alice', '/sessions', post({ runtime: 'fake', title: 'Early' })))) as Session;
    await a.waitFor((f) => f.t === 'ack' && f.sessionId === s.id && f.sequence === 1);
    expect((await t.store.readEvents(s.id, 0, 10)).map((e) => e.type)).toEqual(['session.created']);
    expect(((await j(t.as('alice', '/sessions'))) as Session[]).map((x) => x.title)).toEqual(['Early']);
  });

  it('machine storage: an unknown session id is still indexed so it can be listed', async () => {
    const t = await start();
    const fm = fakeMachine();
    const { machineToken, machineId } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    const local = fm.handler({ t: 'command', id: 'x', op: 'createSession', args: { runtime: 'fake' } }) as Session;
    a.sendEvents(local.id, fm.sessions.get(local.id)!.events);
    await until(async () => (await t.store.getSession(local.id)) !== null);
    expect((await t.store.getSession(local.id))?.machineId).toBe(machineId);
    expect(((await j(t.as('alice', '/sessions'))) as Session[]).map((x) => x.id)).toEqual([local.id]);
  });
});

describe("sessionStorage: 'site'", () => {
  it('replicates in order without duplicates, acks, and serves history while the machine is offline', async () => {
    const t = await start({ sessionStorage: 'site' });
    const fm = fakeMachine();
    const { machineToken } = await t.pair('alice');
    const a = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    const s = (await (await t.as('alice', '/sessions', post({ runtime: 'fake', title: 'Landing page' }))).json()) as Session;

    const created = fm.sessions.get(s.id)!.events[0]!;
    const run = { id: 'run_1', sessionId: s.id, prompt: 'make it', state: 'running' as const, createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
    const e2 = fm.append(s.id, 'run.started', { run }, 'run_1');
    const e3 = fm.append(s.id, 'message.completed', { messageId: 'm1', text: 'Done' }, 'run_1');
    const e4 = fm.append(s.id, 'run.completed', { runId: 'run_1', durationMs: 5 }, 'run_1');
    const e5 = fm.append(s.id, 'session.updated', { session: { ...s, title: 'Landing page v2' } });

    a.sendEvents(s.id, [created, e2]);
    expect(await a.waitFor((f) => f.t === 'ack' && f.sequence === 2)).toEqual({ t: 'ack', sessionId: s.id, sequence: 2 });
    // While the run is active it is listed.
    expect(await (await t.as('alice', '/runs?active=1')).json()).toEqual([
      { runId: 'run_1', sessionId: s.id, sessionTitle: 'Landing page', state: 'running', startedAt: run.startedAt },
    ]);
    // Duplicate + gap: nothing new stored, ack stays at 2 so the agent resends from 3.
    a.sendEvents(s.id, [e2, e4]);
    await a.waitFor((f) => f.t === 'ack' && a.frames.filter((x) => x.t === 'ack').length === 2);
    expect(a.frames.filter((f) => f.t === 'ack').at(-1)).toMatchObject({ sequence: 2 });
    a.sendEvents(s.id, [e3, e4, e5]);
    await a.waitFor((f) => f.t === 'ack' && f.sequence === 5);
    expect((await t.store.readEvents(s.id, 0, 100)).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);

    // Machine goes away.
    await a.close();
    await until(async () => (await machinesOf(t, 'alice'))[0]?.online === false);

    const snap = await j(t.as('alice', `/sessions/${s.id}`));
    expect(snap.lastSequence).toBe(5);
    expect(snap.session.title).toBe('Landing page v2');
    expect(snap.runs).toEqual([expect.objectContaining({ id: 'run_1', state: 'completed', endedAt: e4.occurredAt })]);
    expect(snap.pendingApprovals).toEqual([]);
    expect(((await (await t.as('alice', '/sessions')).json()) as Session[]).map((x) => x.id)).toEqual([s.id]);
    expect(await (await t.as('alice', '/runs?active=1')).json()).toEqual([]);
    expect((await j(t.as('alice', '/runs/run_1'))).state).toBe('completed');

    const ac = new AbortController();
    const res = await t.as('alice', `/sessions/${s.id}/events?after=1`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
    const ids: string[] = [];
    const reader = (async () => {
      for await (const f of readSse(res)) if (!f.comment) ids.push(f.id!);
    })().catch(() => undefined);
    await until(() => ids.length === 4);
    expect(ids).toEqual(['evt_0000000002', 'evt_0000000003', 'evt_0000000004', 'evt_0000000005']);
    ac.abort();
    await reader;

    // Reconnect: the hub tells the agent where replication stands.
    const again = await connect({ url: t.wsUrl, token: machineToken, onCommand: fm.handler });
    expect(await again.waitFor((f) => f.t === 'ack')).toEqual({ t: 'ack', sessionId: s.id, sequence: 5 });
  });
});
