import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, fakeCodexPath, runAdapterContract } from '@uncage/testkit';
import type { AdapterRunContext, AdapterRunInput, ApprovalOutcome, NativeApprovalInput, RuntimeAdapter, RuntimeEvent } from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from './index.js';

const fake = ['node', fakeCodexPath];

runAdapterContract('codex (fake app-server)', () => codexAdapter({ command: fake }), {
  simple: 'simple',
  approval: 'approval',
  crash: 'crash',
});

const versionOk = () => Promise.resolve({ stdout: 'codex-cli 0.130.0\n' });

function ctxWith(outcome: ApprovalOutcome, signal = new AbortController().signal) {
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

const input = (prompt: string, nativeSessionRef?: string) => ({
  runId: 'run_1',
  prompt,
  cwd: '/tmp/uncage-fixture',
  settings: { permissionMode: 'default' as const },
  attachments: [],
  ...(nativeSessionRef ? { nativeSessionRef } : {}),
});

const messageText = (events: RuntimeEvent[]): string =>
  events.flatMap((e) => (e.type === 'message.completed' ? [e.text] : [])).join('\n');

const adapters: RuntimeAdapter[] = [];
function make(o: Parameters<typeof codexAdapter>[0] = {}): RuntimeAdapter {
  const a = codexAdapter({ command: fake, ...o });
  adapters.push(a);
  return a;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.dispose?.()));
});

describe('codexAdapter', () => {
  it('identifies as Codex with the documented capabilities', () => {
    const a = make();
    expect(a.id).toBe('codex');
    expect(a.displayName).toBe('Codex');
    expect(a.capabilities()).toEqual({
      streaming: true,
      approval: { once: true, session: false, types: ['shell', 'file'] },
      nativeResume: true,
      diffEvents: false,
      mcp: true,
      skills: 'unknown',
      siteTools: false,
      models: [{ id: 'default', label: 'Default' }],
      efforts: ['low', 'medium', 'high'],
      permissionModes: ['default'],
      attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
    });
  });

  it('capabilities omit bypass unless allowBypass', () => {
    expect(make().capabilities().permissionModes).toEqual(['default']);
    expect(make({ allowBypass: true }).capabilities().permissionModes).toEqual(['default', 'bypassPermissions']);
  });

  it('refreshCapabilities lists visible models from model/list after default', async () => {
    const a = make();
    expect(a.capabilities().modelsAuthoritative).toBeUndefined();
    const caps = await a.refreshCapabilities!();
    expect(caps.modelsAuthoritative).toBe(true);
    expect(caps.models).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'fake-model', label: 'Fake Model', description: 'The fake default' },
    ]);
  });

  describe('turn/start params on the wire', () => {
    const turnStart = async (o: { allowBypass?: boolean }, over: Partial<AdapterRunInput>): Promise<Record<string, unknown>> => {
      const trace = join(mkdtempSync(join(tmpdir(), 'uncage-codex-')), 'trace.jsonl');
      const a = make({ env: { ...process.env, FAKE_CODEX_TRACE: trace }, ...o });
      const events = await collect(a.run({ ...input('simple hi'), ...over }, ctxWith({ decision: 'allow' }).ctx));
      const wire = readFileSync(trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      const m = wire.find((x) => x.method === 'turn/start');
      expect(m, JSON.stringify(events)).toBeDefined();
      return m!.params as Record<string, unknown>;
    };

    it('turn/start carries model/effort/approvalPolicy from settings', async () => {
      const p = await turnStart({}, { settings: { permissionMode: 'default', model: 'gpt-x', effort: 'high' } });
      expect(p).toMatchObject({
        model: 'gpt-x',
        effort: 'high',
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/uncage-fixture'], networkAccess: false },
      });
    });

    it('omits model for the default and effort when unset', async () => {
      const p = await turnStart({}, { settings: { permissionMode: 'default', model: 'default' } });
      expect(p).not.toHaveProperty('model');
      expect(p).not.toHaveProperty('effort');
    });

    it('bypass maps to never + danger-full-access', async () => {
      const p = await turnStart({ allowBypass: true }, { settings: { permissionMode: 'bypassPermissions' } });
      expect(p).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    });

    it('image attachment sent as localImage before text; files listed by path', async () => {
      const att = (kind: 'image' | 'file', absPath: string) => ({
        id: 'a', sessionId: 's', name: 'n', mime: 'x', size: 1, kind, sha256: 'h', createdAt: 't', absPath,
      });
      const p = await turnStart({}, { attachments: [att('file', '/w/notes.md'), att('image', '/w/pic.png')] });
      expect(p.input).toEqual([
        { type: 'localImage', path: '/w/pic.png' },
        { type: 'text', text: 'simple hi\n\nAttached files (read them with your tools):\n- /w/notes.md' },
      ]);
    });
  });

  it('bypass without allowBypass fails policy_denied and unsupported modes fail invalid_request', async () => {
    const run = (permissionMode: 'bypassPermissions' | 'plan') =>
      collect(make().run({ ...input('simple'), settings: { permissionMode } }, ctxWith({ decision: 'allow' }).ctx));
    expect(await run('bypassPermissions')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'policy_denied' }) }]);
    expect(await run('plan')).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) }]);
  });

  it('resume keeps context', async () => {
    const a = make();
    const first = await collect(a.run(input('simple apple'), ctxWith({ decision: 'allow' }).ctx));
    const ref = first.find((e) => e.type === 'native.session');
    expect(ref?.type).toBe('native.session');
    const second = await collect(
      a.run(input('recall', ref?.type === 'native.session' ? ref.ref : undefined), ctxWith({ decision: 'allow' }).ctx),
    );
    expect(second.at(-1)).toEqual({ type: 'run.completed' });
    expect(messageText(second)).toContain('apple');
  });

  it('command approval → shell request with the command; allow runs it and streams output', async () => {
    const a = make();
    const { ctx, requests } = ctxWith({ decision: 'allow' });
    const events = await collect(a.run(input('approval'), ctx));
    expect(requests).toEqual([
      {
        toolId: expect.any(String),
        category: 'shell',
        title: 'echo hello',
        description: 'Run a harmless command',
        target: { command: 'echo hello', cwd: '/tmp/uncage-fixture' },
      },
    ]);
    const toolId = requests[0]!.toolId;
    expect(events).toContainEqual({
      type: 'tool.started',
      toolId,
      name: 'commandExecution',
      title: 'echo hello',
      category: 'shell',
      input: { command: 'echo hello', cwd: '/tmp/uncage-fixture' },
    });
    expect(events).toContainEqual({ type: 'tool.updated', toolId, output: 'hello\n' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', toolId, output: 'hello\n' }));
  });

  it.each([
    [{ decision: 'deny' } as const, 'run.completed'],
    [{ decision: 'expired' } as const, 'run.completed'],
    [{ decision: 'cancelled' } as const, 'run.interrupted'],
  ])('approval outcome %j declines the command and ends with %s', async (outcome, terminal) => {
    const events = await collect(make().run(input('approval'), ctxWith(outcome).ctx));
    expect(events.find((e) => e.type === 'tool.failed')).toMatchObject({ declined: true });
    expect(events.at(-1)?.type).toBe(terminal);
  });

  it('file change approval → file request titled with the path', async () => {
    const { ctx, requests } = ctxWith({ decision: 'allow' });
    const events = await collect(make().run(input('file'), ctx));
    expect(requests).toEqual([
      expect.objectContaining({ category: 'file', title: 'hello.txt', target: { path: 'hello.txt' } }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', category: 'file', title: 'hello.txt' }));
    expect(events.at(-1)).toEqual({ type: 'run.completed' });
  });

  it('a crashed app-server ends the run as runtime_disconnected and the next run respawns it', async () => {
    const a = make();
    const crashed = await collect(a.run(input('crash'), ctxWith({ decision: 'allow' }).ctx));
    expect(crashed.at(-1)).toEqual({ type: 'run.interrupted', reason: 'runtime_disconnected' });
    const next = await collect(a.run(input('simple'), ctxWith({ decision: 'allow' }).ctx));
    expect(next.at(-1)).toEqual({ type: 'run.completed' });
  });

  it('abort during a slow turn interrupts it and ends with one run.interrupted', async () => {
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    for await (const e of make().run(input('slow'), ctxWith({ decision: 'allow' }, controller.signal).ctx)) {
      events.push(e);
      if (e.type === 'message.delta') controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    expect(events.filter((e) => e.type === 'run.interrupted')).toHaveLength(1);
  });

  it('wire: handshake and thread policy; abort answers the pending approval with cancel and interrupts the turn', async () => {
    const trace = join(mkdtempSync(join(tmpdir(), 'uncage-codex-')), 'trace.jsonl');
    const a = make({ env: { ...process.env, FAKE_CODEX_TRACE: trace } });
    const controller = new AbortController();
    const ctx: AdapterRunContext = {
      signal: controller.signal,
      requestApproval: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => undefined);
      },
    };
    const events = await collect(a.run(input('approval'), ctx));
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    const sent = (): Array<Record<string, unknown>> =>
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    await expect.poll(() => sent().some((m) => m.method === 'turn/interrupt')).toBe(true);
    const wire = sent();
    expect(wire.every((m) => !('jsonrpc' in m))).toBe(true);
    expect(wire.slice(0, 3)).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'uncage', title: 'Uncage', version: '0.0.0' } } },
      { method: 'initialized', params: {} },
      {
        id: 2,
        method: 'thread/start',
        params: { cwd: '/tmp/uncage-fixture', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
      },
    ]);
    expect(wire[3]).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: 'approval' }] } });
    expect(wire).toContainEqual({ id: 'srv_1', result: { decision: 'cancel' } });
    expect(wire).toContainEqual(expect.objectContaining({ method: 'turn/interrupt', params: expect.objectContaining({ turnId: expect.any(String) }) }));
  });

  it('a missing executable fails the run as runtime_unavailable', async () => {
    const events = await collect(
      make({ command: ['/nonexistent/codex', 'app-server'] }).run(input('simple'), ctxWith({ decision: 'allow' }).ctx),
    );
    expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'runtime_unavailable' }) }]);
  });
});

describe('probe', () => {
  it('probe ENOENT → not_installed with npm hint', async () => {
    const execFile = () => Promise.reject(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    expect(await make({ execFile }).probe()).toEqual({
      status: 'not_installed',
      message: 'Codex CLI was not found.',
      hint: 'npm i -g @openai/codex && codex login',
      installUrl: 'https://developers.openai.com/codex',
    });
  });

  it('probe unauthenticated → auth_required', async () => {
    const env = { ...process.env, FAKE_CODEX_AUTH: 'none' };
    expect(await make({ execFile: versionOk, env }).probe()).toEqual({
      status: 'auth_required',
      version: '0.130.0',
      message: 'Codex is not logged in.',
      hint: 'codex login',
    });
  });

  it('probe authenticated → available with the version', async () => {
    const calls: Array<[string, string[]]> = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return versionOk();
    };
    expect(await make({ execFile }).probe()).toEqual({ status: 'available', version: '0.130.0' });
    expect(calls).toEqual([['node', ['--version']]]);
  });
});
