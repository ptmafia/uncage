import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAdapter, RuntimeProbe } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { updateAgentSites } from '@uncage/agent';
import { loadConfig } from './config.js';
import { DOCTOR_HELP, doctorExitCode, exportEvents, formatChecks, nonLoopbackWarning, parseDoctorArgs, runDoctor } from './doctor.js';
import { ensureToken, ensureTokenAt } from './token.js';

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

async function gitRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'uncage-repo-')));
  execFileSync('git', ['init', '-q', repo]);
  return repo;
}

describe('runDoctor: .uncage/ git ignore hint', () => {
  const inWorkspace = async (repo: string, gitCommand?: string) => {
    const { home, config } = await setup();
    return runDoctor({
      config: { ...config, workspace: { allowedRoots: [repo], default: repo } },
      home,
      fetch: okFetch,
      adapters: [],
      ...(gitCommand ? { gitCommand } : {}),
    });
  };

  it('warns (non-fatal) when the workspace is a git repo and .uncage/ is not ignored', async () => {
    const repo = await gitRepo();
    const checks = await inWorkspace(repo);
    const c = checks.find((x) => x.id === `gitignore.${repo}`);
    expect(c).toMatchObject({ ok: false, warn: true });
    expect(c?.fix).toContain('.uncage/.gitignore');
    expect(doctorExitCode(checks)).toBe(0);
    expect(formatChecks(checks)).toContain('! Attachments ignored by git');
  });

  it('passes when the repo ignores .uncage/ (root pattern before the dir exists, or .uncage/.gitignore)', async () => {
    const a = await gitRepo();
    await writeFile(join(a, '.gitignore'), '.uncage/\n');
    expect((await inWorkspace(a)).find((x) => x.id === `gitignore.${a}`)).toMatchObject({ ok: true });
    const b = await gitRepo();
    await mkdir(join(b, '.uncage'));
    await writeFile(join(b, '.uncage', '.gitignore'), '*\n');
    expect((await inWorkspace(b)).find((x) => x.id === `gitignore.${b}`)).toMatchObject({ ok: true });
  });

  it('is skipped when the workspace is not a git repo or git is missing', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'uncage-plain-')));
    expect((await inWorkspace(plain)).some((x) => x.id.startsWith('gitignore.'))).toBe(false);
    const repo = await gitRepo();
    expect((await inWorkspace(repo, join(plain, 'no-such-git'))).some((x) => x.id.startsWith('gitignore.'))).toBe(false);
  });
});

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

  it('checks and sends the token from tokenFile when given', async () => {
    const { config } = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'uncage-tf-'));
    const { path, token } = await ensureTokenAt(join(dir, 'my-token'));
    let auth = '';
    const f = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization ?? '';
      return new Response('{}');
    }) as unknown as typeof fetch;
    const empty = await mkdtemp(join(tmpdir(), 'uncage-empty-'));
    const checks = await runDoctor({ config, home: empty, tokenFile: path, fetch: f, adapters: [] });
    expect(checks.find((c) => c.id === 'token')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.id === 'token')?.detail).toContain(path);
    expect(auth).toBe(`Bearer ${token}`);
  });
});

describe('runDoctor: connected websites', () => {
  it('doctor prints each site’s transports and warns when minAgentVersion is above the installed agent', async () => {
    const { home, config } = await setup();
    const agentHome = await mkdtemp(join(tmpdir(), 'uncage-agent-home-'));
    const site = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, name: id, url, machineId: `mch_${id}`, token: `tok_${id}`, ...extra });
    await updateAgentSites(agentHome, () => [
      site('faas', 'https://faas.example/api/uncage'),
      site('trad', 'https://trad.example/api/uncage'),
      site('down', 'https://down.example/api/uncage'),
      site('gone', 'https://gone.example/api/uncage', { revokedAt: new Date().toISOString() }),
    ]);
    const seen: string[] = [];
    const f = (async (input: string) => {
      const url = String(input);
      seen.push(url);
      const offer = (kinds: string[]) => kinds.map((kind) => ({ kind, url: `${kind}://x/agent` }));
      if (url === 'https://faas.example/api/uncage/agent/info') return Response.json({ protocol: 2, minAgentVersion: '9.0.0', transports: offer(['http']) });
      if (url === 'https://trad.example/api/uncage/agent/info') return Response.json({ protocol: 2, minAgentVersion: '0.3.0', transports: offer(['ws', 'http']) });
      if (url.startsWith('https://down.example')) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const checks = await runDoctor({ config, home, agentHome, agentVersion: '0.3.0', fetch: f, adapters: [] });
    expect(checks.find((c) => c.id === 'site.trad')).toMatchObject({ ok: true, detail: expect.stringContaining('WebSocket, HTTP streaming') });
    expect(checks.find((c) => c.id === 'site.faas')).toMatchObject({ ok: true, detail: expect.stringContaining('HTTP streaming') });
    expect(checks.find((c) => c.id === 'site.faas.version')).toMatchObject({
      ok: false,
      warn: true,
      detail: expect.stringContaining('9.0.0'),
      fix: 'npm i -g @uncage/cli@latest',
    });
    expect(checks.find((c) => c.id === 'site.trad.version')).toBeUndefined();
    expect(checks.find((c) => c.id === 'site.down')).toMatchObject({ ok: false, warn: true });
    expect(checks.some((c) => c.id.startsWith('site.gone'))).toBe(false);
    expect(seen.some((u) => u.startsWith('https://gone.example'))).toBe(false);
    const out = formatChecks(checks);
    expect(out).toContain('✓ Website faas');
    expect(out).toContain('! Agent version for faas');
    expect(doctorExitCode(checks)).toBe(0);
  });
});

describe('doctor flags: --port, --url, UNCAGE_URL, --workspace, --help (F5)', () => {
  const healthFetch = (seen: string[], body: unknown = { ok: true, protocol: '1.0', version: '0' }) =>
    (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;

  it('parseDoctorArgs: --url > --port > UNCAGE_URL > UNCAGE_PORT/config', async () => {
    const { config } = await setup();
    const cwd = '/here';
    expect(parseDoctorArgs([], {}, config, cwd).serverUrl).toBe('http://127.0.0.1:4783');
    expect(parseDoctorArgs([], { UNCAGE_URL: 'http://127.0.0.1:4900/' }, config, cwd).serverUrl).toBe('http://127.0.0.1:4900');
    expect(parseDoctorArgs(['--port', '4800'], { UNCAGE_URL: 'http://127.0.0.1:4900' }, config, cwd).serverUrl).toBe(
      'http://127.0.0.1:4800',
    );
    expect(parseDoctorArgs(['--url', 'http://localhost:5000', '--port', '4800'], {}, config, cwd).serverUrl).toBe(
      'http://localhost:5000',
    );
    expect(() => parseDoctorArgs(['--port', 'abc'], {}, config, cwd)).toThrow(/--port/);
    const o = parseDoctorArgs(['--workspace', 'ws', '--data-dir', 'd', '--token-file', 't'], {}, config, cwd);
    expect(o).toMatchObject({ workspace: '/here/ws', dataDir: '/here/d', tokenFile: '/here/t', help: false });
  });

  it('--help / -h is accepted and documents --port and UNCAGE_URL', async () => {
    const { config } = await setup();
    expect(parseDoctorArgs(['--help'], {}, config, '/').help).toBe(true);
    expect(parseDoctorArgs(['-h'], {}, config, '/').help).toBe(true);
    expect(DOCTOR_HELP).toContain('--port');
    expect(DOCTOR_HELP).toContain('UNCAGE_URL');
  });

  it('probes the configured server URL and names the port in the fix when it is down', async () => {
    const { home, config } = await setup();
    const seen: string[] = [];
    await runDoctor({ config, home, fetch: healthFetch(seen), adapters: [], serverUrl: 'http://127.0.0.1:4800' });
    expect(seen).toEqual(['http://127.0.0.1:4800/v1/health']);
    const down = await runDoctor({ config, home, fetch: downFetch, adapters: [], serverUrl: 'http://127.0.0.1:4800' });
    expect(down.find((c) => c.id === 'server')?.fix).toBe('uncage serve --port 4800');
    const atDefault = await runDoctor({ config, home, fetch: downFetch, adapters: [] });
    expect(atDefault.find((c) => c.id === 'server')?.detail).toContain('--port');
  });

  it('warns before sending the token to a non-loopback --url / UNCAGE_URL', async () => {
    expect(nonLoopbackWarning('http://127.0.0.1:4800')).toBeUndefined();
    expect(nonLoopbackWarning('http://localhost:4800')).toBeUndefined();
    expect(nonLoopbackWarning('http://[::1]:4800')).toBeUndefined();
    const w = nonLoopbackWarning('http://192.168.1.20:4783');
    expect(w).toContain('192.168.1.20');
    expect(w).toMatch(/token/i);
    const { home, config } = await setup();
    const checks = await runDoctor({ config, home, fetch: okFetch, adapters: [], serverUrl: 'http://box.lan:4783' });
    const i = checks.findIndex((c) => c.id === 'serverUrl');
    expect(checks[i]).toMatchObject({ ok: false, warn: true });
    expect(i).toBeLessThan(checks.findIndex((c) => c.id === 'server'));
    expect(doctorExitCode(checks)).toBe(0);
    const local = await runDoctor({ config, home, fetch: okFetch, adapters: [] });
    expect(local.some((c) => c.id === 'serverUrl')).toBe(false);
  });

  it('checks git-ignore in the workspace the daemon reports, not the current directory', async () => {
    const { home, config } = await setup();
    const cwdRepo = await gitRepo(); // where doctor runs (config default = cwd)
    const daemonRepo = await gitRepo(); // where the daemon actually writes
    const checks = await runDoctor({
      config: { ...config, workspace: { allowedRoots: [cwdRepo], default: cwdRepo } },
      home,
      adapters: [],
      fetch: healthFetch([], { ok: true, protocol: '1.0', version: '0', workspace: { default: daemonRepo, allowedRoots: [daemonRepo] } }),
    });
    expect(checks.some((c) => c.id === `gitignore.${cwdRepo}`)).toBe(false);
    expect(checks.find((c) => c.id === `gitignore.${daemonRepo}`)).toMatchObject({ ok: false, warn: true });
  });

  it('an explicit --workspace wins over the daemon and the config', async () => {
    const { home, config } = await setup();
    const cwdRepo = await gitRepo();
    const chosen = await gitRepo();
    const checks = await runDoctor({
      config: { ...config, workspace: { allowedRoots: [cwdRepo], default: cwdRepo } },
      home,
      adapters: [],
      fetch: okFetch,
      workspaces: [chosen],
    });
    expect(checks.filter((c) => c.id.startsWith('gitignore.')).map((c) => c.id)).toEqual([`gitignore.${chosen}`]);
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
