import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAcpAgent, type FakeAcpOptions } from './fake-acp/scenarios.js';

/** The built binary (src/fake-acp-path.ts points next to dist/index.js). */
const fakeAcpPath = fileURLToPath(new URL('../dist/fake-acp.js', import.meta.url));
const updates: SessionNotification[] = [];
const conns: ClientConnection[] = [];

function connect(
  o: Partial<FakeAcpOptions> = {},
  permission: (r: RequestPermissionRequest) => RequestPermissionResponse = () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
): ClientConnection {
  const app = createFakeAcpAgent({ crash: () => { throw new Error('crash'); }, ...o });
  const conn = client({ name: 'test' })
    .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
    .onRequest(methods.client.session.requestPermission, ({ params }) => permission(params))
    .connect(app);
  conns.push(conn);
  return conn;
}

const init = (conn: ClientConnection) =>
  conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });

const texts = (sessionId: string) =>
  updates.flatMap((u) => (u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : []));

afterEach(() => {
  updates.length = 0;
  for (const c of conns.splice(0)) c.close();
});

describe('fake ACP agent', () => {
  it('initialize reports protocol 1, the version, auth methods and the configured capabilities', async () => {
    const conn = connect({ caps: { loadSession: false, promptCapabilities: { image: true } } });
    expect(await init(conn)).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
      agentInfo: { name: 'fake-acp', version: '1.0.0' },
      authMethods: [{ id: 'fake-login', name: 'Fake login' }],
    });
  });

  it('simple streams a message and ends the turn', async () => {
    const conn = connect();
    await init(conn);
    const { sessionId } = await conn.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const res = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'simple' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(texts(sessionId).join('')).toBe('Hello from fake ACP');
  });

  it('approval asks permission with all four option kinds and fails the tool on reject', async () => {
    const asked: RequestPermissionRequest[] = [];
    const conn = connect({}, (r) => {
      asked.push(r);
      return { outcome: { outcome: 'selected', optionId: 'reject' } };
    });
    await init(conn);
    const { sessionId } = await conn.agent.request(methods.agent.session.new, { cwd: '/w', mcpServers: [] });
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'approval' }] });
    expect(asked[0]?.options.map((x) => x.kind)).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
    expect(asked[0]?.toolCall).toMatchObject({ toolCallId: 'call_ap', kind: 'edit', locations: [{ path: '/w/hello.txt' }] });
    expect(updates.map((u) => u.update)).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }));
  });

  it('remember/recall across session/load, which replays history first; unknown sessions are -32002', async () => {
    const conn = connect();
    await init(conn);
    const { sessionId } = await conn.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'remember 42' }] });
    updates.length = 0;
    await conn.agent.request(methods.agent.session.load, { sessionId, cwd: '/tmp', mcpServers: [] });
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'recall' }] });
    expect(texts(sessionId).at(-1)).toBe('remembered 42');
    await expect(conn.agent.request(methods.agent.session.load, { sessionId: 'sess_unknown', cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({ code: -32002 });
  });

  it('slow honours session/cancel with stop reason cancelled', async () => {
    const conn = connect();
    await init(conn);
    const { sessionId } = await conn.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const prompt = conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'slow' }] });
    await new Promise((r) => setTimeout(r, 150));
    await conn.agent.notify(methods.agent.session.cancel, { sessionId });
    expect((await prompt).stopReason).toBe('cancelled');
  });

  it('auth required fails session/new with -32000', async () => {
    const conn = connect({ authRequired: true });
    await init(conn);
    await expect(conn.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
  });

  it('the built binary speaks ACP over stdio and records received messages', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'uncage-fake-acp-')), 'record.jsonl');
    const proc = spawn('node', [fakeAcpPath], { env: { ...process.env, FAKE_ACP_RECORD: record, FAKE_ACP_PROTOCOL: '7' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const conn = client({ name: 'test' }).connect(ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>));
    conns.push(conn);
    expect((await init(conn)).protocolVersion).toBe(7);
    const lines = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ fake: 'start', pid: proc.pid });
    expect(lines[1]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1 } });
    proc.kill();
  });
});
