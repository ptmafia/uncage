import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@uncage/hub';
import type { MachineInfo, Run, Session, UncageEvent } from '@uncage/protocol';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readActivity } from './activity.js';
import { createAgent, readUpgradeState, UPGRADE_EXIT_CODE, type Agent } from './agent.js';
import { selfUpgradeCommand } from './exe.js';
import { agentConfigPath, loadAgentConfig, updateAgentSites, type AgentConfig, type AgentSite } from './config.js';
import { siteHost } from './site.js';
import { FAST, memoryLogger, sleep, startProxy, startTestHub, tmpHome, until, type TestHub } from './test-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function hubFor(o: Parameters<typeof startTestHub>[0] = {}): Promise<TestHub> {
  const t = await startTestHub(o);
  cleanups.push(() => t.close());
  return t;
}

async function home(): Promise<string> {
  const h = await tmpHome();
  cleanups.push(h.cleanup);
  return h.home;
}

const fake = (script: FakeStep[] | (() => FakeStep[]), modes: Array<'default' | 'acceptEdits' | 'bypassPermissions'> = ['default', 'acceptEdits', 'bypassPermissions']) =>
  createFakeAdapter({ script, capabilities: { permissionModes: modes, attachments: { images: true, files: true, maxBytes: 10_000_000 } } });

async function agentFor(
  h: string,
  sites: AgentSite[],
  script: FakeStep[] | (() => FakeStep[]),
  o: { policy?: AgentConfig['localPolicy']; extra?: Partial<Parameters<typeof createAgent>[0]> } = {},
): Promise<Agent> {
  const config: AgentConfig = { sites, localPolicy: o.policy ?? { allowBypass: false } };
  await updateAgentSites(h, () => sites);
  const agent = await createAgent({ config, adapters: () => [fake(script)], home: h, logger: memoryLogger(), timing: FAST, ...o.extra });
  cleanups.push(() => agent.close());
  return agent;
}

async function machines(t: TestHub, user = 'alice'): Promise<MachineInfo[]> {
  return (await (await t.as(user, '/machines')).json()) as MachineInfo[];
}
const online = (t: TestHub) => until(async () => (await machines(t))[0]?.online, 8000, 'machine online');

async function createSession(t: TestHub): Promise<Session> {
  const res = await t.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) });
  expect(res.status).toBe(201);
  return (await res.json()) as Session;
}

async function startRun(t: TestHub, sessionId: string, prompt = 'hello', key = `k-${Math.random()}`): Promise<Response> {
  return t.as('alice', `/sessions/${sessionId}/runs`, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ prompt }) });
}

async function history(t: TestHub, sessionId: string): Promise<UncageEvent[]> {
  const res = await t.as('alice', `/sessions/${sessionId}/events?after=0`, { headers: { accept: 'application/json' } });
  expect(res.status).toBe(200);
  return (await res.json()) as UncageEvent[];
}

const terminal = (evs: UncageEvent[]) => evs.find((e) => e.type === 'run.completed' || e.type === 'run.failed');

describe('agent ↔ real hub', () => {
  it('connects, creates a per-session workspace and runs a session end to end', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'Hello from the machine', chunks: 3 }]);
    await online(t);
    const m = (await machines(t))[0]!;
    expect(m.runtimes.map((r) => r.id)).toEqual(['fake']);

    const session = await createSession(t);
    const root = join(h, 'Uncage', siteHost(site.url));
    expect(session.workspace).toBe(join(await import('node:fs/promises').then((f) => f.realpath(root)), session.id));
    expect((await stat(session.workspace)).isDirectory()).toBe(true);

    const res = await startRun(t, session.id, 'say hello');
    expect(res.status).toBe(202);
    const run = (await res.json()) as Run;
    const evs = await until(async () => {
      const all = await history(t, session.id);
      return terminal(all) ? all : null;
    });
    expect(terminal(evs)?.type).toBe('run.completed');
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'Hello from the machine')).toBe(true);
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    expect((await (await t.as('alice', `/runs/${run.id}`)).json()) as Run).toMatchObject({ id: run.id });
    // per-site data dir
    expect((await stat(join(h, '.uncage', 'sites', site.id, 'data'))).isDirectory()).toBe(true);
  });

  it('bridges site tool calls: core callTool → tool_call → hub executor → tool_result', async () => {
    const lookup = defineTool({
      name: 'lookup_order',
      description: 'Look up an order',
      input: z.object({ id: z.string() }),
      handler: async (a) => ({ order: a.id }),
    });
    const execute = vi.fn(async (call: { tool: string; args: unknown }) => ({
      content: [{ type: 'text' as const, text: `order ${(call.args as { id: string }).id} shipped` }],
    }));
    const t = await hubFor({ tools: [lookup], toolExecutor: { execute } });
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ callTool: { name: 'lookup_order', args: { id: 'A-1' } } }]);
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id, 'where is my order')).status).toBe(202);
    const evs = await until(async () => {
      const all = await history(t, session.id);
      return terminal(all) ? all : null;
    });
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'order A-1 shipped')).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'lookup_order', args: { id: 'A-1' }, sessionId: session.id }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const activity = await until(async () => {
      const a = await readActivity(h, site.id);
      return a.some((e) => e.kind === 'tool_call') ? a : null;
    });
    expect(activity.find((e) => e.kind === 'tool_call')).toMatchObject({ name: 'lookup_order', ok: true, detail: { sessionId: session.id, input: '[redacted object]' } });
    expect(JSON.stringify(activity)).not.toContain('A-1');
  });

  it('a runtime without siteTools still runs (site storage): tools dropped, skills kept, site_tools_unsupported shown', async () => {
    const lookup = defineTool({ name: 'lookup_order', description: 'Look up an order', input: z.object({}), handler: async () => 'x' });
    const skill = { name: 'brand-voice', description: 'Brand voice', markdown: '# Voice' };
    const t = await hubFor({ tools: [lookup], skills: [skill], sessionStorage: 'site' });
    const h = await home();
    const site = await t.pair('alice');
    const adapter = createFakeAdapter({ script: [{ text: 'no tools here' }], capabilities: { siteTools: false } });
    await agentFor(h, [site], [], { extra: { adapters: () => [adapter] } });
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);
    // Site storage: these events come from the hub's replica, so the hub recognised its own session id.
    const evs = await until(async () => {
      const all = await history(t, session.id);
      return terminal(all) ? all : null;
    });
    expect(terminal(evs)?.type).toBe('run.completed');
    expect(evs.find((e) => e.type === 'system.warning')).toMatchObject({ payload: { code: 'site_tools_unsupported' } });
    expect(adapter.calls[0]).not.toHaveProperty('tools');
    expect(adapter.calls[0]?.skills).toEqual([expect.objectContaining({ name: 'brand-voice' })]);
  });

  it('local policy: the hub cannot enable bypass, and modes outside allowedPermissionModes are denied', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'x' }], { policy: { allowBypass: false, allowedPermissionModes: ['default'] } });
    await online(t);
    const session = await createSession(t);
    const patch = (permissionMode: string) =>
      t.as('alice', `/sessions/${session.id}/settings`, { method: 'PATCH', body: JSON.stringify({ permissionMode }) });

    const bypass = await patch('bypassPermissions');
    expect(bypass.status).toBe(403);
    expect(await bypass.json()).toMatchObject({ error: { code: 'policy_denied' } });
    const edits = await patch('acceptEdits');
    expect(edits.status).toBe(403);
    expect(await edits.json()).toMatchObject({ error: { code: 'policy_denied', message: expect.stringContaining('allowedPermissionModes') } });
    expect((await patch('default')).status).toBe(200);

    const activity = await until(async () => {
      const a = await readActivity(h, site.id);
      return a.filter((e) => e.name === 'updateSettings').length >= 3 ? a : null;
    });
    expect(activity.filter((e) => e.name === 'updateSettings' && e.code === 'policy_denied')).toHaveLength(2);
  });

  it('allowBypass on this machine lets the website use bypassPermissions', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'x' }], { policy: { allowBypass: true } });
    await online(t);
    const session = await createSession(t);
    const res = await t.as('alice', `/sessions/${session.id}/settings`, { method: 'PATCH', body: JSON.stringify({ permissionMode: 'bypassPermissions' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Session).settings.permissionMode).toBe('bypassPermissions');
  });

  it('writes a redacted activity log of every command (no prompt text, no token)', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'ok' }]);
    await online(t);
    const session = await createSession(t);
    await startRun(t, session.id, 'my very secret prompt');
    await until(async () => terminal(await history(t, session.id)));
    const log = await until(async () => {
      const raw = await readFile(join(h, '.uncage', 'sites', site.id, 'activity.log'), 'utf8').catch(() => '');
      return raw.includes('"startRun"') ? raw : null;
    });
    expect(log).not.toContain('my very secret prompt');
    expect(log).not.toContain(site.token);
    const entries = await readActivity(h, site.id);
    expect(entries.map((e) => e.kind)).toContain('connected');
    const start = entries.find((e) => e.name === 'startRun')!;
    expect(start).toMatchObject({ kind: 'command', ok: true, detail: { sessionId: session.id, prompt: '[redacted 21 chars]' } });
    expect(entries.find((e) => e.name === 'createSession')).toMatchObject({ ok: true });
    expect(((await stat(join(h, '.uncage', 'sites', site.id, 'activity.log'))).mode & 0o777).toString(8)).toBe('600');
  });

  it('attachments sent through the hub land in the session workspace', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ echo: true }]);
    await online(t);
    const session = await createSession(t);
    const res = await t.as('alice', `/sessions/${session.id}/attachments`, {
      method: 'POST',
      headers: { 'x-filename': 'notes.txt', 'content-type': 'text/plain' },
      body: 'hello file',
    });
    expect(res.status).toBe(201);
    const att = (await res.json()) as { id: string; name: string };
    expect(att.name).toBe('notes.txt');
    const files = await import('node:fs/promises').then((f) => f.readdir(join(session.workspace, '.uncage', 'attachments', session.id)));
    expect(files.some((f) => f.endsWith('notes.txt'))).toBe(true);
    await t.as('alice', `/sessions/${session.id}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
      body: JSON.stringify({ prompt: 'read it', attachmentIds: [att.id] }),
    });
    const evs = await until(async () => {
      const all = await history(t, session.id);
      return terminal(all) ? all : null;
    });
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text.includes('attachments: notes.txt'))).toBe(true);
  });

  it('reconnect after a network drop backfills missed events exactly once (site storage)', async () => {
    const t = await hubFor({ sessionStorage: 'site' });
    const proxy = await startProxy(Number(new URL(t.origin).port));
    cleanups.push(() => proxy.close());
    const h = await home();
    const site = await t.pair('alice', { url: proxy.url });
    await agentFor(h, [site], [{ text: 'a'.repeat(40), chunks: 40, delayMs: 25 }]);
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);

    // Some events reach the hub, then the network drops mid-run.
    await until(async () => ((await t.store.getSession(session.id))?.lastSequence ?? 0) >= 6, 8000, 'first events');
    proxy.cut();
    await until(async () => !(await machines(t))[0]?.online, 8000, 'offline');
    await sleep(1200); // the run finishes locally meanwhile
    const before = (await t.store.getSession(session.id))!.lastSequence;
    proxy.restore();

    const evs = await until(async () => {
      const all = await t.store.readEvents(session.id, 0, 1000);
      return terminal(all) ? all : null;
    }, 10_000, 'backfill');
    expect(evs.length).toBeGreaterThan(before);
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    expect(new Set(evs.map((e) => e.eventId)).size).toBe(evs.length);
    expect(terminal(evs)?.type).toBe('run.completed');
    // The browser sees the same, deduplicated history.
    const seen = await history(t, session.id);
    expect(seen.map((e) => e.sequence)).toEqual(evs.map((e) => e.sequence));
  });

  it('after an agent restart, the hub ack on connect rewinds replication to what the hub is missing', async () => {
    const t = await hubFor({ sessionStorage: 'site' });
    const proxy = await startProxy(Number(new URL(t.origin).port));
    cleanups.push(() => proxy.close());
    const h = await home();
    const site = await t.pair('alice', { url: proxy.url });
    const first = await agentFor(h, [site], [{ text: 'b'.repeat(20), chunks: 20, delayMs: 25 }]);
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);
    await until(async () => ((await t.store.getSession(session.id))?.lastSequence ?? 0) >= 4, 8000, 'first events');
    proxy.cut();
    await sleep(1000); // the run completes locally while offline
    await first.close(); // restart: the new process assumes everything local was delivered…
    proxy.restore();
    const second = await createAgent({ config: { sites: [site], localPolicy: { allowBypass: false } }, adapters: [fake([])], home: h, logger: memoryLogger(), timing: FAST });
    cleanups.push(() => second.close());
    // …until the hub's ack says otherwise.
    const evs = await until(async () => {
      const all = await t.store.readEvents(session.id, 0, 1000);
      return terminal(all) ? all : null;
    }, 10_000, 'rewound backfill');
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    expect(terminal(evs)?.type).toBe('run.completed');
  });

  it('status() follows the connection: connecting → connected → connecting → connected', async () => {
    const t = await hubFor();
    const proxy = await startProxy(Number(new URL(t.origin).port));
    cleanups.push(() => proxy.close());
    const h = await home();
    const site = await t.pair('alice', { url: proxy.url });
    proxy.cut();
    const agent = await agentFor(h, [site], [{ text: 'x' }]);
    expect(agent.status()[site.id]).toBe('connecting');
    proxy.restore();
    await until(() => agent.status()[site.id] === 'connected');
    proxy.cut();
    await until(() => agent.status()[site.id] === 'connecting');
    proxy.restore();
    await until(() => agent.status()[site.id] === 'connected');
    await t.hub.revokeMachine(site.machineId, { id: 'alice' });
    await until(() => agent.status()[site.id] === 'revoked');
  });

  it('reconnect backfills events produced while offline to a machine-storage hub (run no longer active)', async () => {
    const t = await hubFor();
    const proxy = await startProxy(Number(new URL(t.origin).port));
    cleanups.push(() => proxy.close());
    const h = await home();
    const site = await t.pair('alice', { url: proxy.url });
    await agentFor(h, [site], [{ waitMs: 400 }, { text: 'done' }]);
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);
    await until(async () => ((await (await t.as('alice', '/runs?active=1')).json()) as unknown[]).length === 1, 8000, 'active run');
    proxy.cut();
    await sleep(800);
    proxy.restore();
    await online(t);
    await until(async () => ((await (await t.as('alice', '/runs?active=1')).json()) as unknown[]).length === 0, 8000, 'run finished at the hub');
  });

  it('revocation (4401) stops dialing and marks the site revoked in agent.yaml', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'x' }]);
    await online(t);
    await t.hub.revokeMachine(site.machineId, { id: 'alice' });
    const cfg = await until(async () => {
      const c = await loadAgentConfig(h);
      return c.sites[0]?.revokedAt ? c : null;
    });
    expect(cfg.sites[0]!.id).toBe(site.id);
    const entries = await until(async () => {
      const a = await readActivity(h, site.id);
      return a.some((e) => e.kind === 'revoked') ? a : null;
    });
    expect(entries.some((e) => e.kind === 'revoked')).toBe(true);
    // A revoked site is skipped on the next start.
    const logger = memoryLogger();
    const again = await createAgent({ config: cfg, adapters: [fake([])], home: h, logger, timing: FAST });
    cleanups.push(() => again.close());
    expect(logger.lines.some((l) => l.msg?.includes('revoked'))).toBe(true);
  });

  it('a token the hub no longer knows (HTTP 401) is treated as revoked', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [{ ...site, token: 'not-a-real-token' }], [{ text: 'x' }]);
    await until(async () => (await loadAgentConfig(h)).sites[0]?.revokedAt);
  });

  it('upgrade_required runs the npm self-upgrade once and exits non-zero', async () => {
    const t = await hubFor({ minAgentVersion: '99.0.0' });
    const h = await home();
    const site = await t.pair('alice');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const exit = vi.fn();
    await agentFor(h, [site], [{ text: 'x' }], { extra: { exec, exit } });
    await until(() => exit.mock.calls.length > 0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(...(await selfUpgradeCommand()));
    expect((await selfUpgradeCommand())[1].slice(-3)).toEqual(['i', '-g', '@uncage/cli@latest']);
    expect(exit).toHaveBeenCalledWith(UPGRADE_EXIT_CODE);
  });

  it('one process serves several sites, each with its own core and workspace root', async () => {
    const t1 = await hubFor({ site: { id: 'one.example' } });
    const t2 = await hubFor({ site: { id: 'two.example' } });
    const h = await home();
    const s1 = await t1.pair('alice');
    const s2 = await t2.pair('alice');
    await agentFor(h, [s1, s2], [{ text: 'x' }]);
    await online(t1);
    await online(t2);
    const a = await createSession(t1);
    const b = await createSession(t2);
    expect(a.workspace).toContain(`${siteHost(s1.url)}/${a.id}`);
    expect(b.workspace).toContain(`${siteHost(s2.url)}/${b.id}`);
    // Sessions are separate per site.
    expect(((await (await t1.as('alice', '/sessions')).json()) as Session[]).map((s) => s.id)).toEqual([a.id]);
    expect(((await (await t2.as('alice', '/sessions')).json()) as Session[]).map((s) => s.id)).toEqual([b.id]);
  });

  it('a failed self-upgrade does not exit: only that site stays offline, it is logged and not retried within the hour', async () => {
    const old = await hubFor({ minAgentVersion: '99.0.0', site: { id: 'needs.upgrade' } });
    const ok = await hubFor({ site: { id: 'healthy.example' } });
    const h = await home();
    const s1 = await old.pair('alice');
    const s2 = await ok.pair('alice');
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('EACCES'), { stderr: 'permission denied' });
    });
    const exit = vi.fn();
    const agent = await agentFor(h, [s1, s2], [{ text: 'x' }], { extra: { exec, exit, agentVersion: '0.2.0' } });
    await until(async () => (await readActivity(h, s1.id)).find((e) => e.kind === 'upgrade' && e.ok === false));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    await online(ok);
    await until(() => agent.status()[s2.id] === 'connected');
    await until(() => agent.status()[s1.id] === 'upgrade_failed');
    expect(await readUpgradeState(h)).toMatchObject({ fromVersion: '0.2.0', minAgentVersion: '99.0.0', failedAt: expect.any(String) });
    // The healthy site keeps working.
    await online(ok);
    expect((await (await ok.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) })).status)).toBe(201);
    await agent.close();

    // A restart within the hour does not run npm again for the same upgrade.
    const exec2 = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const again = await createAgent({
      config: { sites: [s1], localPolicy: { allowBypass: false } },
      adapters: [fake([])],
      home: h,
      logger: memoryLogger(),
      timing: FAST,
      exec: exec2,
      exit,
      agentVersion: '0.2.0',
    });
    cleanups.push(() => again.close());
    await until(() => again.status()[s1.id] === 'upgrade_failed');
    expect(exec2).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a site that fails to start is skipped; the others run; revoked sites are skipped', async () => {
    const t = await hubFor();
    const h = await home();
    const good = await t.pair('alice');
    const broken = { ...good, id: 'broken.example', machineId: 'mch_x', token: 'x' };
    const revoked = { ...good, id: 'revoked.example', machineId: 'mch_y', token: 'y', revokedAt: '2026-11-01T00:00:00Z' };
    // A file where the site's data directory should be: its core cannot open.
    await mkdir(join(h, '.uncage', 'sites'), { recursive: true });
    await writeFile(join(h, '.uncage', 'sites', 'broken.example'), 'not a directory');
    const logger = memoryLogger();
    await updateAgentSites(h, () => [broken, revoked, good]);
    const agent = await createAgent({ config: { sites: [broken, revoked, good], localPolicy: { allowBypass: false } }, adapters: () => [fake([])], home: h, logger, timing: FAST });
    cleanups.push(() => agent.close());
    expect(agent.status()).toMatchObject({ 'broken.example': 'failed', 'revoked.example': 'revoked' });
    expect(logger.lines.some((l) => l.level === 'error' && (l.obj as { site?: string }).site === 'broken.example')).toBe(true);
    await online(t);
    await until(() => agent.status()[good.id] === 'connected');
  });

  it('throws only when every site fails to start', async () => {
    const h = await home();
    await mkdir(join(h, '.uncage', 'sites'), { recursive: true });
    await writeFile(join(h, '.uncage', 'sites', 'a.example'), 'x');
    const site = { id: 'a.example', name: 'a', url: 'http://127.0.0.1:1/api/uncage', machineId: 'm', token: 't' };
    await expect(createAgent({ config: { sites: [site], localPolicy: { allowBypass: false } }, adapters: [fake([])], home: h, logger: memoryLogger(), timing: FAST })).rejects.toThrow(/No website could be started/);
  });

  it('startRun is denied when the session mode is outside allowedPermissionModes', async () => {
    const t = await hubFor();
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'ran' }], { policy: { allowBypass: false, allowedPermissionModes: ['acceptEdits'] } });
    await online(t);
    const session = await createSession(t); // starts in 'default'
    const denied = await startRun(t, session.id);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'policy_denied' } });
    const patched = await t.as('alice', `/sessions/${session.id}/settings`, { method: 'PATCH', body: JSON.stringify({ permissionMode: 'acceptEdits' }) });
    expect(patched.status).toBe(200);
    expect((await startRun(t, session.id)).status).toBe(202);
    const activity = await until(async () => {
      const a = await readActivity(h, site.id);
      return a.filter((e) => e.name === 'startRun').length >= 2 ? a : null;
    });
    expect(activity.filter((e) => e.name === 'startRun').map((e) => e.code ?? 'ok')).toEqual(['policy_denied', 'ok']);
  });

  it('an event larger than one frame is replicated truncated, never skipped (site replica stays gap-free)', async () => {
    const t = await hubFor({ sessionStorage: 'site' });
    const h = await home();
    const site = await t.pair('alice');
    await agentFor(h, [site], [{ text: 'z'.repeat(1_500_000) }, { text: 'after' }]);
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);
    const evs = await until(async () => {
      const all = await t.store.readEvents(session.id, 0, 1000);
      return terminal(all) ? all : null;
    }, 10_000, 'replicated run');
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    const big = evs.find((e) => e.type === 'message.completed' && e.payload.text.startsWith('zzz'));
    expect(big?.type === 'message.completed' && big.payload.text).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'after')).toBe(true);
    // Machine-side reads (readEvents) are truncated the same way.
    const seen = await history(t, session.id);
    expect(seen.map((e) => e.sequence)).toEqual(evs.map((e) => e.sequence));
  });

  it('an event that string truncation cannot shrink is replicated as a stub; the replica does not stall', async () => {
    const t = await hubFor({ sessionStorage: 'site' });
    const h = await home();
    const site = await t.pair('alice');
    const adapter = fake([]);
    adapter.run = async function* () {
      yield { type: 'tool.started', toolId: 'tool_big', name: 'Bash', title: 'many numbers', category: 'shell', input: { n: Array.from({ length: 300_000 }, (_, i) => i) } };
      yield { type: 'tool.completed', toolId: 'tool_big', output: 'ok' };
      yield { type: 'message.started', messageId: 'msg_after' };
      yield { type: 'message.completed', messageId: 'msg_after', text: 'after the stub' };
      yield { type: 'run.completed' };
    } as typeof adapter.run;
    await updateAgentSites(h, () => [site]);
    const agent = await createAgent({ config: { sites: [site], localPolicy: { allowBypass: false } }, adapters: [adapter], home: h, logger: memoryLogger(), timing: FAST });
    cleanups.push(() => agent.close());
    await online(t);
    const session = await createSession(t);
    expect((await startRun(t, session.id)).status).toBe(202);
    const evs = await until(async () => {
      const all = await t.store.readEvents(session.id, 0, 1000);
      return terminal(all) ? all : null;
    }, 10_000, 'replicated run');
    expect(evs.map((e) => e.sequence)).toEqual(evs.map((_, i) => i + 1));
    const stub = evs.find((e) => e.type === 'tool.started')!;
    expect(stub).toMatchObject({ payload: { toolId: 'tool_big' }, extensions: { uncageTruncated: { originalBytes: expect.any(Number) } } });
    expect(evs.some((e) => e.type === 'message.completed' && e.payload.text === 'after the stub')).toBe(true);
  });

  it('agent.yaml is written 0600', async () => {
    const h = await home();
    await updateAgentSites(h, () => []);
    expect(((await stat(agentConfigPath(h))).mode & 0o777).toString(8)).toBe('600');
  });
});
