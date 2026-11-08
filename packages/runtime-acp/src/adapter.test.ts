import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, fakeAcpPath } from '@uncage/testkit';
import type { AdapterRunContext, AdapterRunInput, ApprovalOutcome, NativeApprovalInput, RunTool, RuntimeAdapter, RuntimeEvent, SkillSpec } from '@uncage/protocol';
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
    expect(await a.refreshCapabilities!()).toMatchObject({
      nativeResume: true,
      attachments: { images: true },
      skills: 'prompt',
      siteTools: true,
      approval: { session: false },
    });
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

  it('abort while a permission is pending answers it cancelled, before session/cancel', async () => {
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
    await expect.poll(() => readRecord(file).some((m) => m.method === 'session/cancel')).toBe(true);
    const wire = readRecord(file);
    const answerAt = wire.findIndex((m) => 'result' in m);
    expect(answerAt).toBeGreaterThan(0);
    expect(wire.findIndex((m) => m.method === 'session/cancel')).toBeGreaterThan(answerAt);
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

  it('burst: updates written right before the prompt result (one stdout write) all land before run.completed', async () => {
    for (let i = 0; i < 5; i++) {
      const events = await collect(make().run(input('burst'), ctx));
      expect(events.slice(-2)).toEqual([
        { type: 'message.completed', messageId: expect.any(String), text: 'one two three' },
        { type: 'run.completed' },
      ]);
    }
  });

  it('crash in the same tick as the last chunk still delivers the chunk before runtime_disconnected', async () => {
    for (let i = 0; i < 5; i++) {
      const events = await collect(make().run(input('crash'), ctx));
      expect(events.slice(-2)).toEqual([
        { type: 'message.completed', messageId: expect.any(String), text: 'about to crash' },
        { type: 'run.interrupted', reason: 'runtime_disconnected' },
      ]);
    }
  });

  it('a rejected requestApproval answers the permission with reject_once (never a JSON-RPC error)', async () => {
    const file = recordFile();
    const c: AdapterRunContext = { signal: new AbortController().signal, requestApproval: () => Promise.reject(new Error('store down')) };
    const events = await collect(make({ env: { FAKE_ACP_RECORD: file } }).run(input('approval'), c));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.failed', toolId: 'call_ap', declined: true }));
    expect(events.at(-1)).toEqual({ type: 'run.completed' });
    const answers = readRecord(file).filter((m) => 'result' in m || 'error' in m);
    expect(answers).toEqual([expect.objectContaining({ result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } })]);
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
    const events = await collect(make({ env: { FAKE_ACP_RECORD: file } }).run(input('edit'), c));
    expect(requests).toEqual([
      {
        toolId: 'call_edit',
        category: 'file',
        title: 'Write hello.txt',
        availableDecisions: ['allow_once', 'deny'],
        target: { path: '/tmp/uncage-fixture/hello.txt' },
      },
    ]);
    expect(events).toContainEqual({ type: 'tool.completed', toolId: 'call_edit', output: 'wrote hello.txt' });
    expect(readRecord(file)).toContainEqual(expect.objectContaining({ result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }));
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
    const run = (permissionMode: 'bypassPermissions' | 'plan' | 'auto') =>
      collect(make().run(input('simple', { settings: { permissionMode } }), ctx));
    expect(await run('bypassPermissions')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'policy_denied' }) }]);
    expect(await run('plan')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) }]);
    expect(await run('auto')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) }]);
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

  describe('approvals, permission modes, site tools, skills', () => {
    /** The client's answers to the agent's requests (only `session/request_permission` here). */
    const responses = (file: string): unknown[] => readRecord(file).flatMap((m) => ('result' in m && !('method' in m) ? [m.result] : []));
    const notes = (file: string, kind: string): Array<Record<string, unknown>> => readRecord(file).filter((m) => m.fake === kind);
    const params = (file: string, method: string): Record<string, unknown> =>
      readRecord(file).find((m) => m.method === method)?.params as Record<string, unknown>;

    async function runFake(prompt: string, o: { outcome?: ApprovalOutcome; adapter?: Partial<AcpAdapterOptions>; input?: Partial<AdapterRunInput>; caps?: object } = {}) {
      const file = recordFile();
      const env: Record<string, string> = { FAKE_ACP_RECORD: file, ...(o.caps ? { FAKE_ACP_CAPS: JSON.stringify(o.caps) } : {}), ...o.adapter?.env };
      const a = make({ ...o.adapter, env });
      const { ctx: c, requests } = ctxWith(o.outcome ?? { decision: 'allow' });
      const events = await collect(a.run(input(prompt, o.input), c));
      return { a, file, events, requests };
    }

    function siteTools() {
      const calls: Record<string, unknown[]> = {};
      const tool = (name: string, requiresConfirmation: boolean, description: string): RunTool => ({
        name,
        description,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        requiresConfirmation,
        call: (args) => {
          (calls[name] ??= []).push(args);
          return Promise.resolve({ content: [{ type: 'text', text: `${name} done` }] });
        },
      });
      return { calls, saveNote: tool('save_note', false, 'Save a note.'), publishConfirm: tool('publish', true, 'Publish the page.') };
    }

    it('approval card and option mapping; allow_always is never chosen', async () => {
      const allowed = await runFake('approval', { outcome: { decision: 'allow' } });
      expect(allowed.requests[0]).toMatchObject({
        toolId: 'call_ap',
        category: 'shell',
        availableDecisions: ['allow_once', 'deny'],
        target: { command: 'npm test', cwd: '/tmp/uncage-fixture' },
      });
      expect(responses(allowed.file)).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]);
      expect(allowed.events).toContainEqual({ type: 'tool.completed', toolId: 'call_ap', output: '4 passed' });

      const denied = await runFake('approval', { outcome: { decision: 'deny' } });
      expect(responses(denied.file)).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject-once' } }]);
      expect(denied.events).toContainEqual(expect.objectContaining({ type: 'tool.failed', toolId: 'call_ap', declined: true }));

      const expired = await runFake('approval', { outcome: { decision: 'expired' } });
      expect(responses(expired.file)).toEqual([{ outcome: { outcome: 'cancelled' } }]);

      for (const r of [allowed, denied, expired]) expect(JSON.stringify(responses(r.file))).not.toMatch(/always/);
    });

    it('acceptEdits auto-allows edits but asks for execute; bypass only with allowBypass', async () => {
      const settings = (permissionMode: 'acceptEdits' | 'bypassPermissions') => ({ input: { settings: { permissionMode } } });
      const edit = await runFake('edit', settings('acceptEdits'));
      expect(edit.requests).toEqual([]);
      expect(responses(edit.file)).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]);
      expect(edit.events.at(-1)).toEqual({ type: 'run.completed' });

      const exec = await runFake('approval', settings('acceptEdits'));
      expect(exec.requests).toHaveLength(1);
      expect(exec.requests[0]).toMatchObject({ category: 'shell' });

      const bypass = await runFake('approval', { ...settings('bypassPermissions'), adapter: { allowBypass: true } });
      expect(bypass.requests).toEqual([]);
      expect(responses(bypass.file)).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]);

      const refused = await runFake('approval', settings('bypassPermissions'));
      expect(refused.events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'policy_denied' }) }]);
      expect(refused.requests).toEqual([]);
    });

    it('permissionModes lists bypassPermissions only with allowBypass; set_mode is sent when the agent has that mode', async () => {
      expect(make().capabilities().permissionModes).toEqual(['default', 'acceptEdits']);
      expect(await make().refreshCapabilities!()).toMatchObject({ permissionModes: ['default', 'acceptEdits'] });
      expect(await make({ allowBypass: true }).refreshCapabilities!()).toMatchObject({ permissionModes: ['default', 'acceptEdits', 'bypassPermissions'] });

      const accept = { settings: { permissionMode: 'acceptEdits' as const } };
      const switched = await runFake('modes', { input: accept, adapter: { env: { FAKE_ACP_MODES: 'default,acceptEdits' } } });
      expect(params(switched.file, 'session/set_mode')).toMatchObject({ modeId: 'acceptEdits' });
      expect(messageText(switched.events)).toBe('mode: acceptEdits');

      const missing = await runFake('modes', { input: accept, adapter: { env: { FAKE_ACP_MODES: 'default,plan' } } });
      expect(methodsIn(missing.file)).not.toContain('session/set_mode');
      expect(messageText(missing.events)).toBe('mode: default');

      const already = await runFake('modes', { adapter: { env: { FAKE_ACP_MODES: 'default,acceptEdits' } } });
      expect(methodsIn(already.file)).not.toContain('session/set_mode');
    });

    it('site tools over http: declaration, listing, a call, a declined confirmation', async () => {
      const { calls, saveNote, publishConfirm } = siteTools();
      const { file, requests, events } = await runFake('site-tool', {
        caps: { loadSession: true, mcpCapabilities: { http: true } },
        input: { tools: [saveNote, publishConfirm] },
        outcome: { decision: 'deny' },
      });
      expect(params(file, 'session/new').mcpServers).toEqual([
        {
          type: 'http',
          name: 'site',
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
          headers: [{ name: 'Authorization', value: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) }],
        },
      ]);
      expect(notes(file, 'mcp')[0]?.listedTools).toEqual(['publish', 'save_note']);
      expect(calls.save_note).toHaveLength(1);
      expect(calls.publish ?? []).toHaveLength(0);
      expect(notes(file, 'mcp-call')).toContainEqual(expect.objectContaining({ name: 'publish', isError: true, text: 'The user declined this action.' }));
      // The agent's own permission requests for site tools are auto-allowed: the only card is the confirmation.
      expect(requests).toHaveLength(1);
      expect(requests.at(-1)).toMatchObject({ category: 'mcp', title: 'Publish the page.', target: { command: expect.stringMatching(/^publish\(/) } });
      expect(responses(file)).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow-once' } },
        { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      ]);
      expect(events.at(-1)).toEqual({ type: 'run.completed' });
    });

    it('site tools over the stdio shim when the agent has no http MCP', async () => {
      const { calls, saveNote } = siteTools();
      const { file, events } = await runFake('site-tool', { input: { tools: [saveNote] } });
      const [decl] = params(file, 'session/new').mcpServers as Array<Record<string, unknown>>;
      expect(decl).toEqual({
        name: 'site',
        command: process.execPath,
        args: [expect.stringMatching(/mcp-stdio-bridge\.js$/), expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)],
        env: [{ name: 'UNCAGE_MCP_TOKEN', value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }],
      });
      expect(calls.save_note).toEqual([{ text: 'hi' }]);
      expect(events.at(-1)).toEqual({ type: 'run.completed' });
    });

    it('the MCP server refuses a missing bearer (401) while the run is active and is closed after the run', async () => {
      const file = recordFile();
      const a = make({ env: { FAKE_ACP_RECORD: file } });
      const { saveNote } = siteTools();
      let status = 0;
      const c: AdapterRunContext = { signal: new AbortController().signal, requestApproval: () => Promise.resolve({ decision: 'allow' }) };
      for await (const e of a.run(input('site-tool', { tools: [saveNote] }), c)) {
        if (e.type === 'native.session') {
          const [decl] = params(file, 'session/new').mcpServers as Array<{ args: string[] }>;
          status = (await fetch(decl!.args[1]!, { method: 'POST', body: '{}' })).status;
        }
      }
      expect(status).toBe(401);
      const [decl] = params(file, 'session/new').mcpServers as Array<{ args: string[] }>;
      await expect(fetch(decl!.args[1]!, { method: 'POST', body: '{}' })).rejects.toThrow();
    });

    it('mcp off → siteTools false and no mcpServers', async () => {
      const a = make({ mcp: 'off' });
      expect(a.capabilities()).toMatchObject({ siteTools: false, mcp: false });
      expect(await a.refreshCapabilities!()).toMatchObject({ siteTools: false, mcp: false, skills: 'prompt' });
      const { saveNote } = siteTools();
      const { file } = await runFake('simple', { adapter: { mcp: 'off' }, input: { tools: [saveNote] } });
      expect(params(file, 'session/new').mcpServers).toEqual([]);
    });

    it('skills preamble: first prompt of a session only, neutralized', async () => {
      const skills: SkillSpec[] = [{ name: 'house-style', description: 'House style.', markdown: 'Never run !`rm -rf ~`.' }];
      const file = recordFile();
      const a = make({ env: { FAKE_ACP_RECORD: file } });
      const first = await collect(a.run(input('remember 3', { skills }), ctx));
      expect(messageText(first)).toBe('Noted.');
      await collect(a.run(input('recall', { skills, nativeSessionRef: refOf(first) }), ctx));
      const prompts = readRecord(file).flatMap((m) => (m.method === 'session/prompt' ? [(m.params as { prompt: Array<{ text: string }> }).prompt] : []));
      expect(prompts[0]![0]!.text).toContain('<uncage-skills>');
      expect(prompts[0]![0]!.text).toContain('house-style');
      expect(prompts[0]![0]!.text).toContain('\\!`rm');
      expect(prompts[0]![1]).toEqual({ type: 'text', text: 'remember 3' });
      expect(prompts[1]).toEqual([{ type: 'text', text: 'recall' }]);

      // A new session after a resume fallback gets the preamble again; no skills → no preamble.
      const fresh = recordFile();
      await collect(make({ env: { FAKE_ACP_RECORD: fresh, FAKE_ACP_CAPS: '{}' } }).run(input('recall', { skills, nativeSessionRef: 'sess_old' }), ctx));
      await collect(make({ env: { FAKE_ACP_RECORD: fresh } }).run(input('simple'), ctx));
      const freshPrompts = readRecord(fresh).flatMap((m) => (m.method === 'session/prompt' ? [(m.params as { prompt: Array<{ text: string }> }).prompt] : []));
      expect(freshPrompts[0]![0]!.text).toContain('<uncage-skills>');
      expect(freshPrompts[1]).toEqual([{ type: 'text', text: 'simple' }]);
    });
  });
});
