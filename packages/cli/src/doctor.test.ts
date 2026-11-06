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
});
