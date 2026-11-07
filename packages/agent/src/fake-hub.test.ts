import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseAgentFrame, type AgentFrame, type HubFrame, type Session } from '@uncage/protocol';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { readActivity } from './activity.js';
import { createAgent, type Agent } from './agent.js';
import type { AgentSite } from './config.js';
import { MAX_PULL_FILE_BYTES, PULL_CHUNK_BYTES } from './files.js';
import { FAST, memoryLogger, sleep, tmpHome, until } from './test-helpers.js';

/** A scriptable stand-in for the hub: accepts agent sockets and records their frames. */
async function fakeHub() {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: '/api/uncage/agent' });
  const conns: Array<{ ws: WebSocket; frames: AgentFrame[]; auth?: string }> = [];
  let onHello: (ws: WebSocket) => void = (ws) =>
    ws.send(JSON.stringify({ t: 'welcome', machineId: 'mch_1', protocol: 1, minAgentVersion: '0.0.0' } satisfies HubFrame));
  wss.on('connection', (ws, req) => {
    const c = { ws, frames: [] as AgentFrame[], ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) };
    conns.push(c);
    ws.on('message', (d) => {
      const f = parseAgentFrame(d.toString());
      c.frames.push(f);
      if (f.t === 'hello') onHello(ws);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/uncage`;
  const last = () => conns.at(-1)!;
  return {
    url,
    conns,
    last,
    setOnHello(fn: (ws: WebSocket) => void) {
      onHello = fn;
    },
    send(f: HubFrame) {
      last().ws.send(JSON.stringify(f));
    },
    framesOf<T extends AgentFrame['t']>(t: T): Array<Extract<AgentFrame, { t: T }>> {
      return conns.flatMap((c) => c.frames).filter((f): f is Extract<AgentFrame, { t: T }> => f.t === t);
    },
    async command(op: string, args: unknown): Promise<Extract<AgentFrame, { t: 'result' }>> {
      const id = `cmd_${Math.random().toString(16).slice(2)}`;
      last().ws.send(JSON.stringify({ t: 'command', id, op, args }));
      return until(() => conns.flatMap((c) => c.frames).find((f): f is Extract<AgentFrame, { t: 'result' }> => f.t === 'result' && f.id === id));
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup(script: FakeStep[] = [{ text: 'ok' }], timing: Record<string, number> = {}) {
  const hub = await fakeHub();
  cleanups.push(hub.close);
  const { home, cleanup } = await tmpHome();
  cleanups.push(cleanup);
  const site: AgentSite = { id: 'fake.site', name: 'Fake', url: hub.url, machineId: 'mch_1', token: 'tok_secret' };
  const logger = memoryLogger();
  const agent: Agent = await createAgent({
    config: { sites: [site], localPolicy: { allowBypass: false } },
    adapters: [createFakeAdapter({ script })],
    home,
    logger,
    timing: { ...FAST, ...timing },
  });
  cleanups.push(() => agent.close());
  await until(() => hub.framesOf('hello').length > 0);
  return { hub, home, site, logger, agent };
}

describe('agent ↔ fake hub (protocol edges)', () => {
  it('authenticates with the bearer token, says hello, and answers pings', async () => {
    const { hub } = await setup();
    expect(hub.last().auth).toBe('Bearer tok_secret');
    expect(hub.framesOf('hello')[0]).toMatchObject({ protocol: 1, machine: { runtimes: [{ id: 'fake' }] } });
    hub.send({ t: 'ping', at: 42 });
    await until(() => hub.framesOf('pong').find((f) => f.at === 42));
  });

  it('sends nothing but hello before welcome', async () => {
    const hub = await fakeHub();
    cleanups.push(hub.close);
    hub.setOnHello(() => undefined); // never welcome
    const { home, cleanup } = await tmpHome();
    cleanups.push(cleanup);
    const agent = await createAgent({
      config: { sites: [{ id: 's', name: 's', url: hub.url, machineId: 'm', token: 't' }], localPolicy: { allowBypass: false } },
      adapters: [createFakeAdapter({ script: [] })],
      home,
      logger: memoryLogger(),
      timing: FAST,
    });
    cleanups.push(() => agent.close());
    await until(() => hub.framesOf('hello').length > 0);
    hub.send({ t: 'ping', at: 1 });
    hub.send({ t: 'command', id: 'c1', op: 'listSessions', args: {} });
    await sleep(150);
    expect(hub.conns[0]!.frames.map((f) => f.t)).toEqual(['hello']);
  });

  it('rejects invalid command args with invalid_request and survives malformed frames', async () => {
    const { hub } = await setup();
    hub.last().ws.send('{not json');
    hub.last().ws.send(JSON.stringify({ t: 'nope' }));
    const r = await hub.command('createSession', { runtime: 42 });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    const ok = await hub.command('listSessions', {});
    expect(ok).toMatchObject({ ok: true, data: [] });
  });

  it('a tool call without a tool_result fails with tool_failed after the timeout', async () => {
    const { hub, home } = await setup([{ callTool: { name: 'slow_tool', args: { a: 1 } } }], { toolTimeoutMs: 150 });
    const created = await hub.command('createSession', { runtime: 'fake' });
    const session = (created as { data: Session }).data;
    const manifest = { tools: [{ name: 'slow_tool', description: 'x', inputSchema: { type: 'object' }, requiresConfirmation: false }], skills: [] };
    const run = await hub.command('startRun', { sessionId: session.id, prompt: 'go', idempotencyKey: 'k', manifest });
    expect(run.ok).toBe(true);
    const call = await until(() => hub.framesOf('tool_call')[0]);
    expect(call).toMatchObject({ sessionId: session.id, tool: 'slow_tool', args: { a: 1 } });
    const done = await until(() =>
      hub.framesOf('events').flatMap((f) => f.events).find((e) => e.type === 'message.completed'),
    );
    expect(done.type === 'message.completed' && done.payload.text).toMatch(/tool error: .*did not answer/);
    const act = await until(async () => (await readActivity(home, 'fake.site')).find((e) => e.kind === 'tool_call'));
    expect(act).toMatchObject({ name: 'slow_tool', ok: false, code: 'timeout' });
  });

  it('a tool_result error reaches the runtime as a tool error', async () => {
    const { hub } = await setup([{ callTool: { name: 'bad_tool', args: {} } }]);
    const session = ((await hub.command('createSession', { runtime: 'fake' })) as { data: Session }).data;
    const manifest = { tools: [{ name: 'bad_tool', description: 'x', inputSchema: { type: 'object' }, requiresConfirmation: false }], skills: [] };
    await hub.command('startRun', { sessionId: session.id, prompt: 'go', idempotencyKey: 'k', manifest });
    const call = await until(() => hub.framesOf('tool_call')[0]);
    hub.send({ t: 'tool_result', id: call.id, ok: false, error: { code: 'tool_failed', message: 'nope', retryable: false } });
    const done = await until(() => hub.framesOf('events').flatMap((f) => f.events).find((e) => e.type === 'message.completed'));
    expect(done.type === 'message.completed' && done.payload.text).toBe('tool error: nope');
  });

  it('4409 (replaced by a newer connection) stops that connection without reconnecting', async () => {
    const { hub, logger } = await setup();
    hub.last().ws.close(4409, 'replaced');
    await until(() => logger.lines.some((l) => l.msg?.includes('replaced')));
    await sleep(400);
    expect(hub.conns).toHaveLength(1);
  });

  it('reconnects with backoff after an ordinary disconnect', async () => {
    const { hub } = await setup();
    hub.last().ws.terminate();
    await until(() => hub.conns.length === 2 && hub.framesOf('hello').length === 2);
  });

  it('presumes the connection dead when the hub goes silent', async () => {
    const { hub } = await setup([], { idleTimeoutMs: 200 });
    await until(() => hub.conns.length >= 2, 5000);
  });

  describe('file_pull', () => {
    async function pullSetup() {
      const s = await setup();
      const session = ((await s.hub.command('createSession', { runtime: 'fake' })) as { data: Session }).data;
      return { ...s, ws: session.workspace, sessionId: session.id };
    }
    const resultFor = (hub: Awaited<ReturnType<typeof fakeHub>>, id: string) =>
      until(() => hub.framesOf('result').find((f) => f.id === id) ?? hub.framesOf('file_done').find((f) => f.id === id));

    it('streams a directory as 256 KiB chunks then file_done; skips symlinks', async () => {
      const { hub, ws, sessionId } = await pullSetup();
      await mkdir(join(ws, 'site', 'css'), { recursive: true });
      await writeFile(join(ws, 'site', 'index.html'), '<h1>hi</h1>');
      await writeFile(join(ws, 'site', 'css', 'big.css'), Buffer.alloc(PULL_CHUNK_BYTES + 10, 97));
      await writeFile(join(ws, 'site', 'empty.txt'), '');
      await symlink('/etc/hosts', join(ws, 'site', 'hosts'));
      hub.send({ t: 'file_pull', id: 'p1', sessionId, path: 'site', maxBytes: 50 * 1024 * 1024 });
      const done = await resultFor(hub, 'p1');
      expect(done).toMatchObject({
        t: 'file_done',
        files: [
          { path: 'site/css/big.css', size: PULL_CHUNK_BYTES + 10 },
          { path: 'site/empty.txt', size: 0 },
          { path: 'site/index.html', size: 11 },
        ],
      });
      const chunks = hub.framesOf('file_chunk').filter((c) => c.id === 'p1');
      const big = chunks.filter((c) => c.path === 'site/css/big.css');
      expect(big.map((c) => [c.seq, c.last])).toEqual([
        [0, false],
        [1, true],
      ]);
      expect(Buffer.from(big[0]!.data, 'base64').length).toBe(PULL_CHUNK_BYTES);
      expect(chunks.find((c) => c.path === 'site/empty.txt')).toMatchObject({ seq: 0, data: '', last: true });
      expect(Buffer.from(chunks.find((c) => c.path === 'site/index.html')!.data, 'base64').toString()).toBe('<h1>hi</h1>');
      expect(chunks.some((c) => c.path.includes('hosts'))).toBe(false);
    });

    it('refuses a symlink that points outside the workspace', async () => {
      const { hub, ws, sessionId } = await pullSetup();
      await symlink('/etc', join(ws, 'escape'));
      hub.send({ t: 'file_pull', id: 'p2', sessionId, path: 'escape/hosts', maxBytes: 1000 });
      expect(await resultFor(hub, 'p2')).toMatchObject({ t: 'result', ok: false, error: { code: 'invalid_request', message: expect.stringContaining('outside') } });
      expect(hub.framesOf('file_chunk').filter((c) => c.id === 'p2')).toEqual([]);
    });

    it('refuses a pull larger than maxBytes before sending anything', async () => {
      const { hub, ws, sessionId } = await pullSetup();
      await mkdir(join(ws, 'out'));
      await writeFile(join(ws, 'out', 'a.bin'), Buffer.alloc(600));
      await writeFile(join(ws, 'out', 'b.bin'), Buffer.alloc(600));
      hub.send({ t: 'file_pull', id: 'p3', sessionId, path: 'out', maxBytes: 1000 });
      expect(await resultFor(hub, 'p3')).toMatchObject({ ok: false, error: { code: 'invalid_request', details: { maxBytes: 1000 } } });
      expect(hub.framesOf('file_chunk').filter((c) => c.id === 'p3')).toEqual([]);
    });

    it('refuses a single file over 10 MiB', async () => {
      const { hub, ws, sessionId } = await pullSetup();
      await writeFile(join(ws, 'huge.bin'), Buffer.alloc(MAX_PULL_FILE_BYTES + 1));
      hub.send({ t: 'file_pull', id: 'p4', sessionId, path: 'huge.bin', maxBytes: 50 * 1024 * 1024 });
      expect(await resultFor(hub, 'p4')).toMatchObject({ ok: false, error: { details: { maxFileBytes: MAX_PULL_FILE_BYTES } } });
    });

    it('missing paths and unknown sessions fail with not_found', async () => {
      const { hub, sessionId } = await pullSetup();
      hub.send({ t: 'file_pull', id: 'p5', sessionId, path: 'nope.txt', maxBytes: 10 });
      expect(await resultFor(hub, 'p5')).toMatchObject({ ok: false, error: { code: 'not_found' } });
      hub.send({ t: 'file_pull', id: 'p6', sessionId: 'ses_unknown', path: 'a.txt', maxBytes: 10 });
      expect(await resultFor(hub, 'p6')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
  });
});
