import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, fakeAcpPath } from '@uncage/testkit';
import type { AdapterRunContext, AdapterRunInput, ApprovalOutcome, NativeApprovalInput, RuntimeAdapter, RuntimeEvent } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { acpAdapter, CLIENT_CAPABILITIES, DEFAULT_ACP_CAPABILITIES, type AcpAdapterOptions } from './index.js';

const adapters: RuntimeAdapter[] = [];
function make(o: Partial<AcpAdapterOptions> = {}): RuntimeAdapter {
  const a = acpAdapter({ id: 'acp-fake', displayName: 'Fake ACP', command: ['node', fakeAcpPath], ...o });
  adapters.push(a);
  return a;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.dispose?.()));
});

function ctxWith(outcome: ApprovalOutcome = { decision: 'allow' }, signal = new AbortController().signal) {
  const requests: NativeApprovalInput[] = [];
  const ctx: AdapterRunContext = {
    signal,
    requestApproval: (i) => {
      requests.push(i);
      return Promise.resolve(outcome);
    },
  };
  return { ctx, requests };
}
const ctx = ctxWith().ctx;

const input = (prompt: string, over: Partial<AdapterRunInput> = {}): AdapterRunInput => ({
  runId: 'run_1',
  prompt,
  cwd: '/tmp/uncage-fixture',
  settings: { permissionMode: 'default' },
  attachments: [],
  ...over,
});

const recordFile = (): string => join(mkdtempSync(join(tmpdir(), 'uncage-acp-')), 'record.jsonl');
const readRecord = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const methodsIn = (file: string): unknown[] => readRecord(file).flatMap((m) => (typeof m.method === 'string' ? [m.method] : []));
const pidsIn = (file: string): number[] => readRecord(file).flatMap((m) => (m.fake === 'start' ? [m.pid as number] : []));

const messageText = (events: RuntimeEvent[]): string =>
  events.flatMap((e) => (e.type === 'message.completed' ? [e.text] : [])).join('\n');
const refOf = (events: RuntimeEvent[]): string => {
  const e = events.find((x) => x.type === 'native.session');
  if (e?.type !== 'native.session') throw new Error(`no native.session in ${JSON.stringify(events)}`);
  return e.ref;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('acpAdapter', () => {
  it('validates the id', () => {
    expect(() => acpAdapter({ id: 'fake', displayName: 'x', command: ['x'] })).toThrow(/acp-/);
    expect(() => acpAdapter({ id: 'acp-Bad', displayName: 'x', command: ['x'] })).toThrow();
    expect(() => acpAdapter({ id: 'acp-gemini', displayName: 'x', command: [] })).toThrow(/command/);
    expect(make().id).toBe('acp-fake');
    expect(make().displayName).toBe('Fake ACP');
  });

  it('probe: not_installed for a missing command; available with the agent version; error on a protocol mismatch', async () => {
    expect(await make({ command: ['uncage-no-such-acp-agent'], installHint: 'npm i -g x', installUrl: 'https://x.dev' }).probe()).toMatchObject({
      status: 'not_installed',
      hint: 'npm i -g x',
      installUrl: 'https://x.dev',
    });
    expect(await make().probe()).toMatchObject({ status: 'available', version: '1.0.0' });
    expect(await make({ env: { FAKE_ACP_PROTOCOL: '99' } }).probe()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/protocol version/),
    });
  });

  it('capabilities: defaults before initialize, mapped after refreshCapabilities', async () => {
    const a = make({ env: { FAKE_ACP_CAPS: JSON.stringify({ loadSession: true, promptCapabilities: { image: true } }) } });
    expect(a.capabilities()).toEqual(DEFAULT_ACP_CAPABILITIES);
    // skills: 'prompt' and siteTools arrive with Task A2.
    expect(await a.refreshCapabilities!()).toMatchObject({ nativeResume: true, attachments: { images: true }, approval: { session: false } });
    expect(a.capabilities().nativeResume).toBe(true);
  });

  it('initialize declares no fs/terminal client capabilities', async () => {
    const file = recordFile();
    await make({ env: { FAKE_ACP_RECORD: file } }).probe();
    const init = readRecord(file).find((m) => m.method === 'initialize');
    expect(init?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    expect(CLIENT_CAPABILITIES).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  it('maps the tools scenario: thought dropped, two message segments around a tool, plan as one step', async () => {
    const events = await collect(make().run(input('tools'), ctx));
    expect(events.map((e) => e.type)).toEqual([
      'native.session',
      'message.started',
      'message.delta',
      'message.completed',
      'tool.started',
      'tool.updated',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'message.started',
      'message.delta',
      'message.completed',
      'run.completed',
    ]);
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({ category: 'shell', input: { command: 'npm test' } });
    expect(events.filter((e) => e.type === 'tool.completed').at(-1)).toMatchObject({ output: '- [x] read\n- [ ] write' });
    expect(JSON.stringify(events)).not.toContain('think about');
  });

  it('session/new carries the cwd and no MCP servers; prompt text arrives as a text block', async () => {
    const file = recordFile();
    await collect(make({ env: { FAKE_ACP_RECORD: file } }).run(input('simple'), ctx));
    const wire = readRecord(file);
    expect(wire.find((m) => m.method === 'session/new')?.params).toEqual({ cwd: '/tmp/uncage-fixture', mcpServers: [] });
    expect(wire.find((m) => m.method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: 'simple' }] });
  });

  it('resumes with session/load without replaying history into the run, and reports a lost session', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file } });
    const first = await collect(a.run(input('remember 42'), ctx));
    expect(messageText(first)).toBe('Noted.');
    const ref = refOf(first);
    const second = await collect(a.run(input('recall', { nativeSessionRef: ref }), ctx));
    expect(second.at(-1)).toEqual({ type: 'run.completed' });
    expect(messageText(second)).toBe('remembered 42');
    expect(JSON.stringify(second)).not.toContain('remember 42');
    expect(JSON.stringify(second)).not.toContain('Noted');
    expect(refOf(second)).toBe(ref);
    expect(methodsIn(file)).toContain('session/load');
    const lost = await collect(a.run(input('recall', { nativeSessionRef: 'sess_unknown' }), ctx));
    expect(lost).toEqual([{ type: 'native.session_lost', message: expect.any(String) }]);
  });

  it('prefers session/resume when sessionCapabilities.resume', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file, FAKE_ACP_CAPS: JSON.stringify({ loadSession: true, sessionCapabilities: { resume: {} } }) } });
    const ref = refOf(await collect(a.run(input('remember 7'), ctx)));
    const second = await collect(a.run(input('recall', { nativeSessionRef: ref }), ctx));
    expect(messageText(second)).toBe('remembered 7');
    expect(methodsIn(file)).toContain('session/resume');
    expect(methodsIn(file)).not.toContain('session/load');
    expect(await collect(a.run(input('recall', { nativeSessionRef: 'sess_unknown' }), ctx))).toEqual([
      { type: 'native.session_lost', message: expect.any(String) },
    ]);
  });

  it('without load or resume support a resumed run starts a new session with a warning', async () => {
    const a = make({ env: { FAKE_ACP_CAPS: '{}' } });
    const events = await collect(a.run(input('recall', { nativeSessionRef: 'sess_old' }), ctx));
    expect(events[0]).toMatchObject({ type: 'warning', code: 'acp_resume_unsupported' });
    expect(refOf(events)).not.toBe('sess_old');
    expect(messageText(events)).toBe('remembered nothing');
  });

  it('cancel: session/cancel, run.interrupted aborted within 2 s, the process stays usable', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file } });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    let abortedAt = 0;
    for await (const e of a.run(input('slow'), ctxWith({ decision: 'allow' }, controller.signal).ctx)) {
      events.push(e);
      if (e.type === 'message.delta' && !abortedAt) {
        abortedAt = Date.now();
        controller.abort();
      }
    }
    expect(Date.now() - abortedAt).toBeLessThan(2000);
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    expect(events.filter((e) => e.type === 'run.interrupted')).toHaveLength(1);
    await expect.poll(() => methodsIn(file).includes('session/cancel')).toBe(true);
    expect((await collect(a.run(input('simple'), ctx))).at(-1)).toEqual({ type: 'run.completed' });
    expect(pidsIn(file)).toHaveLength(1);
  });

  it('abort during an approval answers it with cancelled after session/cancel', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file } });
    const controller = new AbortController();
    const c: AdapterRunContext = {
      signal: controller.signal,
      requestApproval: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => undefined);
      },
    };
    expect((await collect(a.run(input('approval'), c))).at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    await expect.poll(() => readRecord(file).some((m) => 'result' in m)).toBe(true);
    const wire = readRecord(file);
    const cancelAt = wire.findIndex((m) => m.method === 'session/cancel');
    const answerAt = wire.findIndex((m) => 'result' in m);
    expect(cancelAt).toBeGreaterThan(0);
    expect(answerAt).toBeGreaterThan(cancelAt);
    expect(wire[answerAt]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });

  it('an agent that ignores cancel is killed after cancelGraceMs and respawned on the next run', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file, FAKE_ACP_IGNORE_CANCEL: '1' }, cancelGraceMs: 200 });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    for await (const e of a.run(input('slow'), ctxWith({ decision: 'allow' }, controller.signal).ctx)) {
      events.push(e);
      if (e.type === 'message.delta') controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    const [pid] = pidsIn(file);
    await expect.poll(() => alive(pid!), { timeout: 3000 }).toBe(false);
    expect((await collect(a.run(input('simple'), ctx))).at(-1)).toEqual({ type: 'run.completed' });
    expect(pidsIn(file)).toHaveLength(2);
  });

  it('crash → runtime_disconnected; next run respawns', async () => {
    const a = make();
    const crashed = await collect(a.run(input('crash'), ctx));
    expect(crashed.at(-1)).toEqual({ type: 'run.interrupted', reason: 'runtime_disconnected' });
    expect(crashed.filter((e) => e.type === 'message.completed')).toEqual([expect.objectContaining({ text: 'about to crash' })]);
    expect((await collect(a.run(input('simple'), ctx))).at(-1)).toEqual({ type: 'run.completed' });
  });

  it('auth scenario (-32000 on session/new) → run.failed auth_required with the auth method in the hint', async () => {
    const events = await collect(make({ env: { FAKE_ACP_AUTH: 'required' } }).run(input('simple'), ctx));
    expect(events).toEqual([
      { type: 'run.failed', error: expect.objectContaining({ code: 'auth_required', hint: expect.stringContaining('Fake login') }) },
    ]);
  });

  it('a missing command fails the run as runtime_unavailable', async () => {
    const events = await collect(make({ command: ['uncage-no-such-acp-agent'] }).run(input('simple'), ctx));
    expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'runtime_unavailable' }) }]);
  });

  it('refusal ends with a warning then run.completed', async () => {
    const events = await collect(make().run(input('refusal'), ctx));
    expect(events.slice(-2)).toEqual([{ type: 'warning', code: 'acp_refusal', message: expect.any(String) }, { type: 'run.completed' }]);
  });

  it('approval: the request carries the tool and target; allow selects allow_once', async () => {
    const file = recordFile();
    const { ctx: c, requests } = ctxWith({ decision: 'allow' });
    const events = await collect(make({ env: { FAKE_ACP_RECORD: file } }).run(input('approval'), c));
    expect(requests).toEqual([
      {
        toolId: 'call_ap',
        category: 'file',
        title: 'Write hello.txt',
        availableDecisions: ['allow_once', 'deny'],
        target: { path: '/tmp/uncage-fixture/hello.txt' },
      },
    ]);
    expect(events).toContainEqual({ type: 'tool.completed', toolId: 'call_ap', output: 'wrote hello.txt' });
    expect(readRecord(file)).toContainEqual(expect.objectContaining({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
  });

  it('two concurrent runs share one process and get only their own updates', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file } });
    const [x, y] = await Promise.all([collect(a.run(input('remember 1'), ctx)), collect(a.run(input('simple'), ctx))]);
    expect(messageText(x)).toBe('Noted.');
    expect(messageText(y)).toBe('Hello from fake ACP');
    expect(refOf(x)).not.toBe(refOf(y));
    expect(methodsIn(file).filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('prompt blocks: image as base64 when supported, files as resource_link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-acp-att-'));
    writeFileSync(join(dir, 'pic.png'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'notes.md'), '# notes');
    const att = (name: string, kind: 'image' | 'file', mime: string) => ({
      id: name, sessionId: 's', name, mime, size: 3, kind, sha256: 'h', createdAt: 't', absPath: join(dir, name),
    });
    const attachments = [att('pic.png', 'image', 'image/png'), att('notes.md', 'file', 'text/markdown')];
    const promptOf = async (caps: string): Promise<unknown> => {
      const file = recordFile();
      await collect(make({ env: { FAKE_ACP_RECORD: file, FAKE_ACP_CAPS: caps } }).run(input('look', { attachments }), ctx));
      return (readRecord(file).find((m) => m.method === 'session/prompt')?.params as { prompt: unknown }).prompt;
    };
    expect(await promptOf(JSON.stringify({ promptCapabilities: { image: true } }))).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', uri: pathToFileURL(join(dir, 'notes.md')).href, name: 'notes.md', mimeType: 'text/markdown', size: 3 },
    ]);
    expect(await promptOf('{}')).toEqual([
      { type: 'text', text: 'look' },
      { type: 'resource_link', uri: pathToFileURL(join(dir, 'pic.png')).href, name: 'pic.png', mimeType: 'image/png', size: 3 },
      { type: 'resource_link', uri: pathToFileURL(join(dir, 'notes.md')).href, name: 'notes.md', mimeType: 'text/markdown', size: 3 },
    ]);
  });

  it('unsupported permission modes fail before starting a session', async () => {
    const run = (permissionMode: 'bypassPermissions' | 'plan') =>
      collect(make().run(input('simple', { settings: { permissionMode } }), ctx));
    expect(await run('bypassPermissions')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'policy_denied' }) }]);
    expect(await run('plan')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) }]);
  });

  it('dispose kills the agent process', async () => {
    const file = recordFile();
    const a = make({ env: { FAKE_ACP_RECORD: file } });
    await a.probe();
    const [pid] = pidsIn(file);
    expect(alive(pid!)).toBe(true);
    await a.dispose!();
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});
