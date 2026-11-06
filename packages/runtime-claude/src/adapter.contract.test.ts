import { collect, runAdapterContract } from '@uncage/testkit';
import type { AdapterRunContext, ApprovalOutcome, NativeApprovalInput } from '@uncage/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from './index.js';
import { scriptedQuery } from './test-utils.js';

const versionOk = () => Promise.resolve({ stdout: '2.1.318 (Claude Code)\n' });

runAdapterContract(
  'claude (scripted query)',
  () => claudeAdapter({ query: scriptedQuery().query, execFile: versionOk }),
  { simple: 'simple', approval: 'approval', crash: 'crash' },
);

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

const run = { runId: 'run_1', prompt: 'approval', cwd: '/tmp/uncage-fixture' };

describe('claudeAdapter', () => {
  it('identifies as Claude Code with the documented capabilities', () => {
    const a = claudeAdapter({ query: scriptedQuery().query });
    expect(a.id).toBe('claude');
    expect(a.displayName).toBe('Claude Code');
    expect(a.capabilities()).toEqual({
      streaming: true,
      approval: { once: true, session: false, types: ['shell', 'file', 'network', 'mcp', 'other'] },
      nativeResume: true,
      diffEvents: false,
      mcp: true,
      skills: 'supported',
    });
  });

  it('passes safe options to query()', async () => {
    const s = scriptedQuery();
    const a = claudeAdapter({ query: s.query, model: 'claude-opus-5-5', executable: '/opt/claude' });
    await collect(a.run({ ...run, prompt: 'simple', nativeSessionRef: 'sess-1' }, ctxWith({ decision: 'allow' }).ctx));
    const o = s.calls[0]!.options;
    expect(s.calls[0]!.prompt).toBe('simple');
    expect(o).toMatchObject({
      cwd: '/tmp/uncage-fixture',
      resume: 'sess-1',
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['project'],
      model: 'claude-opus-5-5',
      pathToClaudeCodeExecutable: '/opt/claude',
    });
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(typeof o.canUseTool).toBe('function');
    expect(o).not.toHaveProperty('allowDangerouslySkipPermissions');
  });

  it('honours settingSources', async () => {
    const s = scriptedQuery();
    const a = claudeAdapter({ query: s.query, settingSources: ['user', 'project'] });
    await collect(a.run({ ...run, prompt: 'simple' }, ctxWith({ decision: 'allow' }).ctx));
    expect(s.calls[0]!.options.settingSources).toEqual(['user', 'project']);
  });

  it('canUseTool → requestApproval with mapped fields; allow passes the input through', async () => {
    const s = scriptedQuery();
    const { ctx, requests } = ctxWith({ decision: 'allow' });
    await collect(claudeAdapter({ query: s.query }).run(run, ctx));
    expect(requests).toEqual([
      {
        toolId: 'toolu_01WriteHello',
        category: 'file',
        title: 'Claude wants to write hello.txt',
        target: { path: '/tmp/uncage-fixture/hello.txt', cwd: '/tmp/uncage-fixture' },
      },
    ]);
    expect(s.calls[0]!.permission).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/uncage-fixture/hello.txt', content: 'hi' },
    });
  });

  it.each([
    [{ decision: 'deny' } as const, { behavior: 'deny', message: 'The user denied this action.' }],
    [{ decision: 'deny', reason: 'Not here' } as const, { behavior: 'deny', message: 'Not here' }],
    [{ decision: 'expired' } as const, { behavior: 'deny', message: 'The approval request expired.' }],
    [{ decision: 'cancelled' } as const, { behavior: 'deny', message: 'Run cancelled.', interrupt: true }],
  ])('approval outcome %j → %j', async (outcome, permission) => {
    const s = scriptedQuery();
    const events = await collect(claudeAdapter({ query: s.query }).run(run, ctxWith(outcome).ctx));
    expect(s.calls[0]!.permission).toEqual(permission);
    if (outcome.decision !== 'cancelled') {
      expect(events.find((e) => e.type === 'tool.failed')).toMatchObject({ declined: true });
    }
  });

  it('abort interrupts the query and ends with run.interrupted', async () => {
    const s = scriptedQuery();
    const controller = new AbortController();
    const ctx: AdapterRunContext = {
      signal: controller.signal,
      requestApproval: () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    };
    const events = await collect(claudeAdapter({ query: s.query }).run(run, ctx));
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'aborted' });
    expect(s.calls[0]!.interrupted).toBe(true);
    expect(s.calls[0]!.permission).toEqual({ behavior: 'deny', message: 'Run cancelled.', interrupt: true });
  });

  it('auth failure surfaces as run.failed auth_required', async () => {
    const s = scriptedQuery();
    const events = await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'auth' }, ctxWith({ decision: 'allow' }).ctx));
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'auth_required' } });
  });

  it('a crashed iterator becomes run.interrupted with the cause and kills the process', async () => {
    const s = scriptedQuery();
    const events = await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'crash' }, ctxWith({ decision: 'allow' }).ctx));
    expect(events.at(-1)).toEqual({ type: 'run.interrupted', reason: 'process exited' });
    expect(s.calls[0]!.options.abortController?.signal.aborted).toBe(true);
  });

  describe('resume of a session Claude Code no longer has', () => {
    const MISSING = 'No conversation found with session ID: 00000000-0000-0000-0000-000000000000';
    const resume = (prompt: string, nativeSessionRef?: string) =>
      collect(
        claudeAdapter({ query: scriptedQuery().query }).run(
          { ...run, prompt, ...(nativeSessionRef !== undefined ? { nativeSessionRef } : {}) },
          ctxWith({ decision: 'allow' }).ctx,
        ),
      );

    it('the error result becomes native.session_lost (terminal)', async () => {
      const events = await resume('resume-missing', '00000000-0000-0000-0000-000000000000');
      expect(events).toEqual([{ type: 'native.session_lost', message: MISSING }]);
    });

    it('so does the thrown SDK error when no result message came first', async () => {
      const events = await resume('resume-missing-throw', '00000000-0000-0000-0000-000000000000');
      expect(events).toEqual([{ type: 'native.session_lost', message: `Claude Code returned an error result: ${MISSING}` }]);
    });

    it('without a resume ref the same error stays an ordinary run.failed', async () => {
      const events = await resume('resume-missing');
      expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'internal_error', message: MISSING }) as unknown }]);
    });
  });

  describe('after a terminal event', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('kills a CLI that lingers 10 s after the result', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const s = scriptedQuery();
      const events = await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'linger' }, ctxWith({ decision: 'allow' }).ctx));
      expect(events.at(-1)).toEqual({ type: 'run.completed' });
      const signal = s.calls[0]!.options.abortController!.signal;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
    });

    it('does not kill a CLI that exits by itself', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const s = scriptedQuery();
      await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple' }, ctxWith({ decision: 'allow' }).ctx));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(s.calls[0]!.options.abortController!.signal.aborted).toBe(false);
    });
  });
});

describe('probe', () => {
  it('probe ENOENT → not_installed', async () => {
    const execFile = () => Promise.reject(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(await claudeAdapter({ execFile }).probe()).toEqual({
      status: 'not_installed',
      message: 'Claude Code CLI was not found.',
      hint: 'Install Claude Code and make sure `claude` is on your PATH.',
      installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    });
  });

  it('parses the version and defers the login check', async () => {
    const calls: Array<[string, string[]]> = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return versionOk();
    };
    expect(await claudeAdapter({ execFile, executable: '/opt/claude' }).probe()).toEqual({
      status: 'available',
      version: '2.1.318',
      message: 'Login is checked on first run',
    });
    expect(calls).toEqual([['/opt/claude', ['--version']]]);
  });

  it('other probe failures → error', async () => {
    const execFile = () => Promise.reject(new Error('killed'));
    expect(await claudeAdapter({ execFile }).probe()).toMatchObject({ status: 'error', message: 'killed' });
  });
});
