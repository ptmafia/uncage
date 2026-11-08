import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_INFO, stopAcpProcess, treeKillArgv, windowsKill } from './process.js';
import pkg from '../package.json' with { type: 'json' };

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('agent process groups', () => {
  it('a forced process.exit() leaves no agent and no grandchild behind (exit hook kills the groups)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uncage-acp-exit-'));
    dirs.push(dir);
    const agent = join(dir, 'agent');
    // The agent starts a long-running grandchild, then becomes the fake ACP agent (same pid).
    await writeFile(agent, `#!/bin/sh\necho $$ > "${dir}/leader.pid"\nsleep 60 &\necho $! > "${dir}/child.pid"\nexec "${process.execPath}" "${fakeAcpPath}"\n`);
    await chmod(agent, 0o755);
    const lib = pathToFileURL(join(import.meta.dirname, '..', 'node_modules', '.cache', 'uncage-acp-test', 'process.js')).href;
    const script = join(dir, 'main.mjs');
    await writeFile(
      script,
      `import { startAcpProcess } from ${JSON.stringify(lib)};
const p = await startAcpProcess({
  command: [${JSON.stringify(agent)}],
  env: process.env,
  initTimeoutMs: 10000,
  handlers: { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
});
console.log('initialized', p.init.protocolVersion);
// No dispose, no kill: exit right away.
process.exit(0);
`,
    );
    const { stdout } = await run(process.execPath, [script], { timeout: 20_000 });
    expect(stdout).toContain('initialized 1');
    const leader = Number(await readFile(join(dir, 'leader.pid'), 'utf8'));
    const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    for (let i = 0; i < 40 && (alive(leader) || alive(child)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(false);
  });
});

describe('stopping an agent', () => {
  it('Windows tree kill: the absolute taskkill on the pid, /t /f', () => {
    expect(treeKillArgv(4242, { SystemRoot: 'C:\\Windows' })).toEqual(['C:\\Windows\\System32\\taskkill.exe', ['/pid', '4242', '/t', '/f']]);
    expect(treeKillArgv(7, {})[0]).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('Windows: the tree kill runs (synchronously) before any direct kill; the direct kill only on failure or force', () => {
    const order: string[] = [];
    const run = (ok: boolean) => (file: string, args: string[], o: { timeout: number }) => {
      order.push(`taskkill ${file} ${args.join(' ')} t=${o.timeout}`);
      return ok ? { status: 0 } : { status: 128 };
    };
    const direct = (sig: string) => void order.push(`direct ${sig}`);
    const env = { SystemRoot: 'C:\\Windows' };
    expect(windowsKill({ pid: 9, env, force: false, run: run(true), direct })).toBe(true);
    expect(order).toEqual(['taskkill C:\\Windows\\System32\\taskkill.exe /pid 9 /t /f t=5000']);
    order.length = 0;
    expect(windowsKill({ pid: 9, env, force: false, run: run(false), direct })).toBe(false);
    expect(order).toEqual(['taskkill C:\\Windows\\System32\\taskkill.exe /pid 9 /t /f t=5000', 'direct SIGTERM']);
    order.length = 0;
    windowsKill({ pid: 9, env, force: true, run: run(true), direct });
    expect(order).toEqual(['taskkill C:\\Windows\\System32\\taskkill.exe /pid 9 /t /f t=5000', 'direct SIGKILL']);
    // A spawner that throws counts as a failure.
    order.length = 0;
    windowsKill({ pid: 9, env, force: false, run: () => { throw new Error('nope'); }, direct });
    expect(order).toEqual(['direct SIGTERM']);
  });

  it('stopAcpProcess resolves once the agent exits', async () => {
    const kill = vi.fn();
    expect(await stopAcpProcess({ kill, exited: Promise.resolve({ code: 0, signal: null, stderrTail: '' }) }, 1_000)).toBe('exited');
    expect(kill.mock.calls).toEqual([[]]);
  });

  it('stopAcpProcess never hangs: past the timeout it force-kills and resolves', async () => {
    const kill = vi.fn();
    const t0 = Date.now();
    // `exited` never settles (a grandchild holds the pipes).
    expect(await stopAcpProcess({ kill, exited: new Promise(() => undefined) }, 100)).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(kill.mock.calls).toEqual([[], [true]]);
  });

  it('clientInfo carries the real package version', () => {
    expect(CLIENT_INFO.version).toBe(pkg.version);
    expect(CLIENT_INFO.version).not.toBe('0.0.0');
  });
});

