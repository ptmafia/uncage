import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAdapter, RuntimeProbe } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { doctorExitCode, exportEvents, formatChecks, runDoctor } from './doctor.js';
import { ensureToken } from './token.js';

const adapter = (id: string, probe: RuntimeProbe): RuntimeAdapter =>
  ({ id, displayName: id, probe: async () => probe }) as unknown as RuntimeAdapter;

const okFetch = (async () => new Response(JSON.stringify({ ok: true, protocol: '1.0', version: '0' }))) as typeof fetch;
const downFetch = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'uncage-doc-'));
  await ensureToken(home);
  const config = await loadConfig(home, {});
  return { home, config };
}

describe('runDoctor', () => {
  it('marks codex not_installed with npm fix line and does not fail overall', async () => {
    const { home, config } = await setup();
    const checks = await runDoctor({
      config,
      home,
      fetch: okFetch,
      adapters: [
        adapter('claude', { status: 'available', version: '2.0.0', message: 'Login is checked on first run' }),
        adapter('codex', { status: 'not_installed' }),
      ],
    });
    const codex = checks.find((c) => c.id === 'runtime.codex');
    expect(codex).toMatchObject({ ok: false, fix: 'npm i -g @openai/codex && codex login' });
    const claude = checks.find((c) => c.id === 'runtime.claude');
    expect(claude).toMatchObject({ ok: true });
    expect(claude?.detail).toContain('Login is checked on first run');
    expect(doctorExitCode(checks)).toBe(0);
    expect(formatChecks(checks)).toContain('fix: npm i -g @openai/codex && codex login');
  });

  it('fails when server unreachable with fix "uncage serve"', async () => {
    const { home, config } = await setup();
    const checks = await runDoctor({ config, home, fetch: downFetch, adapters: [] });
    expect(checks.find((c) => c.id === 'server')).toMatchObject({ ok: false, fix: 'uncage serve' });
    expect(doctorExitCode(checks)).toBe(1);
  });

  it('fails with a fix when claude CLI is missing', async () => {
    const { home, config } = await setup();
    const checks = await runDoctor({ config, home, fetch: okFetch, adapters: [adapter('claude', { status: 'not_installed' })] });
    expect(checks.find((c) => c.id === 'runtime.claude')).toMatchObject({
      ok: false,
      fix: 'npm i -g @anthropic-ai/claude-code',
    });
    expect(doctorExitCode(checks)).toBe(1);
  });

  it('fails the token check with a fix when the token file is missing', async () => {
    const { config } = await setup();
    const empty = await mkdtemp(join(tmpdir(), 'uncage-empty-'));
    const checks = await runDoctor({ config, home: empty, fetch: okFetch, adapters: [] });
    const t = checks.find((c) => c.id === 'token');
    expect(t?.ok).toBe(false);
    expect(t?.fix).toBe('uncage serve');
  });
});

describe('exportEvents', () => {
  const events = [
    { sequence: 1, type: 'tool.started', payload: { toolId: 't', input: { command: 'rm -rf /' } } },
    { sequence: 2, type: 'approval.requested', payload: { approval: { target: { command: 'rm -rf /secret', cwd: '/x' } } } },
    { sequence: 3, type: 'message.delta', payload: { messageId: 'm', chunkIndex: 0, text: 'hello world' } },
    { sequence: 4, type: 'run.completed', payload: { runId: 'r', durationMs: 5 } },
  ];

  it('redacts command text', async () => {
    const { home, config } = await setup();
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Accept}`);
      return new Response(JSON.stringify(url.includes('after=0') && !url.includes('after=4') ? events : []));
    }) as unknown as typeof fetch;
    const out = await exportEvents({ sessionId: 'ses_1', config, home, fetch: f, includeContent: false });
    const text = JSON.stringify(out);
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('hello world');
    expect(text).toContain('[redacted 14 chars]');
    expect(out[3]).toEqual(events[3]);
    expect(seen[0]).toContain('application/json');
  });

  it('keeps content with includeContent', async () => {
    const { home, config } = await setup();
    const f = (async (url: string) => new Response(JSON.stringify(url.includes('after=0') ? events : []))) as unknown as typeof fetch;
    const out = await exportEvents({ sessionId: 's', config, home, fetch: f, includeContent: true });
    expect(JSON.stringify(out)).toContain('rm -rf /secret');
  });

  it('redacts prompts, titles, descriptions, errors but keeps ids and states', async () => {
    const { home, config } = await setup();
    const evs = [
      { eventId: 'evt_1', sequence: 1, sessionId: 'ses_1', runId: 'run_1', type: 'run.started', occurredAt: '2026-01-01T00:00:00Z', payload: { run: { id: 'run_1', state: 'running', prompt: 'SECRETPROMPT', startedAt: 'x' } } },
      { sequence: 2, type: 'message.completed', payload: { messageId: 'msg_1', text: 'SECRETTEXT' } },
      { sequence: 3, type: 'approval.requested', payload: { approval: { id: 'apr_1', category: 'shell', title: 'SECRETTITLE', description: 'SECRETDESC', target: { command: 'SECRETCMD' }, availableDecisions: ['allow_once'] } } },
      { sequence: 4, type: 'tool.failed', payload: { toolId: 'tool_1', error: 'SECRETERR' } },
      { sequence: 5, type: 'run.failed', payload: { runId: 'run_1', error: { code: 'internal_error', message: 'SECRETMSG', retryable: false } } },
    ];
    const f = (async (url: string) => new Response(JSON.stringify(url.includes('after=0') ? evs : []))) as unknown as typeof fetch;
    const text = JSON.stringify(await exportEvents({ sessionId: 's', config, home, fetch: f, includeContent: false }));
    expect(text).not.toMatch(/SECRET/);
    for (const keep of ['evt_1', 'run_1', 'running', 'apr_1', 'shell', 'allow_once', 'tool_1', 'internal_error', 'msg_1']) {
      expect(text).toContain(keep);
    }
  });

  it('treats tool input as opaque', async () => {
    const { home, config } = await setup();
    const evs = [{ sequence: 1, type: 'tool.started', payload: { toolId: 'tool_1', input: { name: 'SECRET', userId: 'SECRET', type: 'SECRET' }, output: ['SECRET'] }, extensions: { name: 'SECRET' } }];
    const f = (async (url: string) => new Response(JSON.stringify(url.includes('after=0') ? evs : []))) as unknown as typeof fetch;
    const text = JSON.stringify(await exportEvents({ sessionId: 's', config, home, fetch: f, includeContent: false }));
    expect(text).not.toContain('SECRET');
    expect(text).toContain('tool_1');
  });
});
