import { collect, runAdapterContract } from '@uncage/testkit';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterRunContext, AdapterRunInput, ApprovalOutcome, NativeApprovalInput, RunTool } from '@uncage/protocol';
import type { Options, Query, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_FALLBACK_MODELS, claudeAdapter, claudeCapabilities } from './index.js';
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

const run = { runId: 'run_1', prompt: 'approval', cwd: '/tmp/uncage-fixture',
  settings: { permissionMode: 'default' as const }, attachments: [] };

describe('claudeAdapter', () => {
  it('identifies as Claude Code with the documented capabilities', () => {
    const a = claudeAdapter({ query: scriptedQuery().query });
    expect(a.id).toBe('claude');
    expect(a.displayName).toBe('Claude Code');
    expect(a.capabilities()).toEqual(claudeCapabilities({ models: CLAUDE_FALLBACK_MODELS, allowBypass: false }));
    expect(claudeAdapter({ allowBypass: true }).capabilities().permissionModes).toContain('bypassPermissions');
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

  it('without skills, no settings override is passed', async () => {
    const s = scriptedQuery();
    await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple' }, ctxWith({ decision: 'allow' }).ctx));
    expect(s.calls[0]!.options).not.toHaveProperty('settings');
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

describe('session settings', () => {
  const runWith = async (settings: AdapterRunInput['settings'], o: { allowBypass?: boolean; model?: string } = {}) => {
    const s = scriptedQuery();
    const events = await collect(
      claudeAdapter({ query: s.query, ...o }).run({ ...run, prompt: 'simple', settings }, ctxWith({ decision: 'allow' }).ctx),
    );
    return { events, options: s.calls[0]?.options };
  };

  it('run passes model/effort/permissionMode to query options', async () => {
    const { options } = await runWith({ model: 'opus', effort: 'xhigh', permissionMode: 'acceptEdits' });
    expect(options).toMatchObject({ model: 'opus', effort: 'xhigh', permissionMode: 'acceptEdits' });
    expect(typeof options!.canUseTool).toBe('function');
  });

  it("omits model for 'default' and when unset; omits effort when unset", async () => {
    const a = await runWith({ model: 'default', permissionMode: 'plan' });
    expect(a.options).not.toHaveProperty('model');
    expect(a.options).not.toHaveProperty('effort');
    expect(a.options!.permissionMode).toBe('plan');
    const b = await runWith({ permissionMode: 'default' });
    expect(b.options).not.toHaveProperty('model');
  });

  it('bypass sets allowDangerouslySkipPermissions true; other modes never set it', async () => {
    const bypass = await runWith({ permissionMode: 'bypassPermissions' }, { allowBypass: true });
    expect(bypass.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    expect(typeof bypass.options!.canUseTool).toBe('function');
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'auto'] as const) {
      const { options } = await runWith({ permissionMode }, { allowBypass: true });
      expect(options!.permissionMode).toBe(permissionMode);
      expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
      expect(typeof options!.canUseTool).toBe('function');
    }
  });

  it('refuses bypass when the adapter was not allowed it, without starting Claude Code', async () => {
    const { events, options } = await runWith({ permissionMode: 'bypassPermissions' });
    expect(options).toBeUndefined();
    expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'policy_denied' }) as unknown }]);
  });

  it('attachments are sent as one streaming-input user message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-adapter-'));
    const absPath = join(dir, 'a.png');
    writeFileSync(absPath, Buffer.from([1, 2, 3]));
    const attachment = { id: 'att_1', sessionId: 's', name: 'a.png', mime: 'image/png', size: 3, kind: 'image' as const,
      sha256: 'x', createdAt: '2026-11-07T00:00:00.000Z', absPath };
    const s = scriptedQuery();
    const events = await collect(
      claudeAdapter({ query: s.query }).run({ ...run, prompt: 'what is this', attachments: [attachment] }, ctxWith({ decision: 'allow' }).ctx),
    );
    expect(events.at(-1)).toEqual({ type: 'run.completed' });
    const raw = s.calls[0]!.rawPrompt;
    if (typeof raw === 'string') throw new Error('expected streaming input');
    const msgs: unknown[] = [];
    for await (const m of raw) msgs.push(m);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as SDKUserMessage).message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'what is this' },
    ]);
  });

  it('an unreadable file attachment fails the run without starting Claude Code', async () => {
    const attachment = { id: 'att_1', sessionId: 's', name: 'a.md', mime: 'text/markdown', size: 3, kind: 'file' as const,
      sha256: 'x', createdAt: '2026-11-07T00:00:00.000Z', absPath: '/nonexistent/uncage/a.md' };
    const s = scriptedQuery();
    const events = await collect(
      claudeAdapter({ query: s.query }).run({ ...run, prompt: 'x', attachments: [attachment] }, ctxWith({ decision: 'allow' }).ctx),
    );
    expect(s.calls).toHaveLength(0);
    expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) as unknown }]);
  });

  it('an unreadable attachment fails the run without starting Claude Code', async () => {
    const attachment = { id: 'att_1', sessionId: 's', name: 'a.png', mime: 'image/png', size: 3, kind: 'image' as const,
      sha256: 'x', createdAt: '2026-11-07T00:00:00.000Z', absPath: '/nonexistent/uncage/a.png' };
    const s = scriptedQuery();
    const events = await collect(
      claudeAdapter({ query: s.query }).run({ ...run, prompt: 'x', attachments: [attachment] }, ctxWith({ decision: 'allow' }).ctx),
    );
    expect(s.calls).toHaveLength(0);
    expect(events).toEqual([{ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) as unknown }]);
  });
});

/** A query() stand-in for refreshCapabilities: records the call and answers supportedModels(). */
function modelsQuery(supportedModels: () => Promise<unknown>) {
  const calls: Array<{ prompt: unknown; options: Options; interrupted: boolean }> = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call = { prompt: params.prompt, options: params.options ?? {}, interrupted: false };
    calls.push(call);
    const signal = call.options.abortController!.signal;
    // Like the SDK's iterator: nothing arrives until the process is aborted, then it rejects.
    const iterator = {
      next: () =>
        new Promise<IteratorResult<never>>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true }),
        ),
    };
    return Object.assign(iterator, {
      supportedModels,
      interrupt: async () => {
        call.interrupted = true;
      },
    }) as unknown as Query;
  }) as typeof query;
  return { query: fn, calls };
}

describe('site tools and skills', () => {
  const tools = (): RunTool[] => [
    {
      name: 'echo_text',
      description: 'Echo text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      requiresConfirmation: false,
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    },
    {
      name: 'publish_page',
      description: 'Publish the page',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      requiresConfirmation: true,
      call: async () => ({ content: [{ type: 'text', text: 'published' }] }),
    },
  ];

  it('reports siteTools: true', () => {
    expect(claudeAdapter({ query: scriptedQuery().query }).capabilities().siteTools).toBe(true);
  });

  it('passes mcpServers.site without allowedTools (no SHADOWED warning)', async () => {
    const s = scriptedQuery();
    await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple', tools: tools() }, ctxWith({ decision: 'allow' }).ctx));
    const o = s.calls[0]!.options;
    expect(o.mcpServers?.site).toMatchObject({ type: 'sdk', name: 'site' });
    expect(o).not.toHaveProperty('allowedTools');
  });

  it('canUseTool allows a non-confirmation site tool without an approval', async () => {
    const s = scriptedQuery();
    const { ctx, requests } = ctxWith({ decision: 'deny' });
    await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple', tools: tools() }, ctx));
    const permission = await s.calls[0]!.options.canUseTool!('mcp__site__echo_text', { text: 'hi' }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_echo',
      requestId: 'req_3',
    });
    expect(permission).toEqual({ behavior: 'allow', updatedInput: { text: 'hi' } });
    expect(requests).toEqual([]);
  });

  it('without tools, no mcpServers / allowedTools are passed', async () => {
    const s = scriptedQuery();
    await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple' }, ctxWith({ decision: 'allow' }).ctx));
    expect(s.calls[0]!.options).not.toHaveProperty('mcpServers');
    expect(s.calls[0]!.options).not.toHaveProperty('allowedTools');
  });

  it('a confirmation tool raises an mcp approval titled by its description', async () => {
    const s = scriptedQuery();
    const { ctx, requests } = ctxWith({ decision: 'allow' });
    const input: AdapterRunInput = { ...run, prompt: 'simple', tools: tools() };
    await collect(claudeAdapter({ query: s.query }).run(input, ctx));
    const permission = await s.calls[0]!.options.canUseTool!('mcp__site__publish_page', { id: 'p1' }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_site',
      requestId: 'req_2',
      title: 'Claude wants to use mcp__site__publish_page',
    });
    expect(requests).toEqual([
      { toolId: 'toolu_site', category: 'mcp', title: 'Publish the page', target: { command: 'publish_page({"id":"p1"})', cwd: run.cwd } },
    ]);
    expect(permission).toEqual({ behavior: 'allow', updatedInput: { id: 'p1' } });
  });

  it('an invalid tool name fails the run without starting Claude Code', async () => {
    const s = scriptedQuery();
    const bad = [{ ...tools()[0]!, name: 'Bash' }];
    const events = await collect(claudeAdapter({ query: s.query }).run({ ...run, prompt: 'simple', tools: bad }, ctxWith({ decision: 'allow' }).ctx));
    expect(events).toEqual([expect.objectContaining({ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) })]);
    expect(s.calls).toHaveLength(0);
  });

  it('materializes skills and makes sure project settings are loaded', async () => {
    const s = scriptedQuery();
    const cwd = mkdtempSync(join(tmpdir(), 'uncage-claude-skills-'));
    const skills = [{ name: 'kumquat', description: 'Sign-off', markdown: 'End with KUMQUAT.' }];
    await collect(claudeAdapter({ query: s.query, settingSources: ['user'] }).run({ ...run, cwd, prompt: 'simple', skills }, ctxWith({ decision: 'allow' }).ctx));
    expect(readFileSync(join(cwd, '.claude', 'skills', 'kumquat', 'SKILL.md'), 'utf8')).toContain('End with KUMQUAT.');
    expect(s.calls[0]!.options.settingSources).toEqual(['user', 'project']);
    expect(s.calls[0]!.options.settings).toEqual({ disableSkillShellExecution: true });
  });

  it('a skill file path traversal fails the run without starting Claude Code', async () => {
    const s = scriptedQuery();
    const cwd = mkdtempSync(join(tmpdir(), 'uncage-claude-skills-'));
    const skills = [{ name: 'evil', description: 'd', markdown: 'm', files: [{ path: '../../escape.md', content: 'x' }] }];
    const events = await collect(claudeAdapter({ query: s.query }).run({ ...run, cwd, prompt: 'simple', skills }, ctxWith({ decision: 'allow' }).ctx));
    expect(events).toEqual([expect.objectContaining({ type: 'run.failed', error: expect.objectContaining({ code: 'invalid_request' }) })]);
    expect(s.calls).toHaveLength(0);
  });
});

describe('refreshCapabilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const INFOS = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Fable 5.1' },
    { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work' },
  ];

  it('lists models via supportedModels() without sending a turn, then shuts the probe down', async () => {
    const m = modelsQuery(() => Promise.resolve(INFOS));
    const a = claudeAdapter({ query: m.query, executable: '/opt/claude' });
    const caps = await a.refreshCapabilities!();
    expect(m.calls[0]!.options.settingSources).toEqual([]);
    expect(caps.models).toEqual([
      { id: 'default', label: 'Default (recommended)', description: 'Fable 5.1' },
      { id: 'opus', label: 'Opus 5.5', description: 'For complex work' },
    ]);
    expect(caps.modelsAuthoritative).toBe(true);
    expect(a.capabilities().models).toEqual(caps.models);
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.options.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(call.interrupted).toBe(true);
    expect(call.options.abortController!.signal.aborted).toBe(true);
    // The prompt is streaming input that never yields: no model turn is sent.
    const it = (call.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const first = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(first).toBe('pending');
  });

  it('caches the model list for 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const m = modelsQuery(() => Promise.resolve(INFOS));
    const a = claudeAdapter({ query: m.query });
    await a.refreshCapabilities!();
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await a.refreshCapabilities!();
    expect(m.calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await a.refreshCapabilities!();
    expect(m.calls).toHaveLength(2);
  });

  it('refreshCapabilities falls back on error', async () => {
    const m = modelsQuery(() => Promise.reject(new Error('spawn claude ENOENT')));
    const a = claudeAdapter({ query: m.query, allowBypass: true });
    const caps = await a.refreshCapabilities!();
    expect(caps).toEqual(claudeCapabilities({ models: CLAUDE_FALLBACK_MODELS, allowBypass: true }));
    expect(caps.modelsAuthoritative).toBeUndefined();
    expect(m.calls[0]!.options.abortController!.signal.aborted).toBe(true);
  });

  it('backs off 60 s after a failed probe, keeping the fallback models', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = true;
    const m = modelsQuery(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(INFOS)));
    const a = claudeAdapter({ query: m.query });
    expect((await a.refreshCapabilities!()).models).toEqual(CLAUDE_FALLBACK_MODELS);
    fail = false;
    vi.setSystemTime(Date.now() + 59_000);
    expect((await a.refreshCapabilities!()).models).toEqual(CLAUDE_FALLBACK_MODELS);
    expect(m.calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await a.refreshCapabilities!()).models.map((x) => x.id)).toEqual(['default', 'opus']);
    expect(m.calls).toHaveLength(2);
  });

  it('falls back when query() itself throws', async () => {
    const a = claudeAdapter({
      query: (() => {
        throw new Error('boom');
      }) as unknown as typeof query,
    });
    expect((await a.refreshCapabilities!()).models).toEqual(CLAUDE_FALLBACK_MODELS);
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
