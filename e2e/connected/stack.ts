/**
 * Helpers for the Connected Mode E2E: start the connected-demo website (single node or behind the
 * multi-node proxy), throwaway Redis/Postgres containers, the real `uncage setup` device flow with
 * the browser approving on /device, and agents (fake adapter or real `uncage agent`).
 *
 * Every process and tmp dir is tracked and removed by `cleanup()`. Agents get their own
 * UNCAGE_HOME (tmp), so the user's ~/.uncage and ~/Uncage are never touched; HOME stays real so a
 * live run's Claude Code keeps its login.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const demoDir = join(repo, 'examples/connected-demo');
export const cliBin = join(repo, 'packages/cli/dist/bin.js');
const execFileP = promisify(execFile);

export interface Proc {
  proc: ChildProcess;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export class Stack {
  private procs: Proc[] = [];
  private dirs: string[] = [];
  private containers: string[] = [];
  private logFd: number;
  private results = join(repo, 'e2e/connected/results');

  constructor(readonly name: string) {
    mkdirSync(this.results, { recursive: true });
    this.logFd = openSync(join(this.results, `${name}.log`), 'w');
  }

  /** `e2e/connected/results/<stack>-<file>` (logs and screenshots, gitignored). */
  resultPath(file: string): string {
    return join(this.results, `${this.name}-${file}`);
  }

  tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `uncage-connected-${prefix}-`));
    this.dirs.push(d);
    return d;
  }

  log(line: string): void {
    writeSync(this.logFd, `${line}\n`);
  }

  /** Spawns a process (own process group), logs its output, resolves once stdout has `marker`. */
  async spawn(label: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; marker?: string; timeoutMs?: number } = {}): Promise<Proc> {
    const proc = spawn(process.execPath, args, {
      cwd: o.cwd ?? repo,
      env: { ...process.env, ...o.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    const onData = (stream: string) => (chunk: Buffer) => {
      out += chunk.toString();
      writeSync(this.logFd, chunk.toString().replace(/^(?=.)/gm, `[${label}${stream}] `));
    };
    proc.stdout?.on('data', onData(''));
    proc.stderr?.on('data', onData(' err'));
    const p: Proc = {
      proc,
      output: () => out,
      stop: (signal = 'SIGTERM') =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          const kill = setTimeout(() => proc.kill('SIGKILL'), 15_000);
          proc.once('exit', () => {
            clearTimeout(kill);
            resolve();
          });
          proc.kill(signal);
        }),
    };
    this.procs.push(p);
    if (o.marker) {
      const marker = o.marker;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: no "${marker}" after ${o.timeoutMs ?? 90_000} ms. Output:\n${out}`)), o.timeoutMs ?? 90_000);
        const check = () => {
          if (out.includes(marker)) {
            clearTimeout(timer);
            resolve();
          }
        };
        proc.stdout?.on('data', check);
        check();
        proc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`${label} exited early (code ${code}). Output:\n${out}`));
        });
      });
    }
    return p;
  }

  /** The demo website, single node (production build: `pnpm --filter connected-demo build`). */
  async demo(port: number, env: NodeJS.ProcessEnv = {}): Promise<{ url: string; dataDir: string; proc: Proc }> {
    const dataDir = this.tmp('demo-data');
    const url = `http://localhost:${port}`;
    const proc = await this.spawn('demo', ['server.ts'], {
      cwd: demoDir,
      env: { NODE_ENV: 'production', PORT: String(port), PUBLIC_URL: url, DEMO_DATA_DIR: dataDir, ...env },
      marker: 'ready ',
    });
    return { url, dataDir, proc };
  }

  /** Two (or `nodes`) demo servers on Redis + Postgres behind the round-robin proxy. */
  async multinode(port: number, o: { redisUrl: string; databaseUrl: string; nodes?: number }): Promise<{ url: string; dataDir: string; proc: Proc }> {
    const dataDir = this.tmp('demo-data');
    const url = `http://localhost:${port}`;
    const proc = await this.spawn('multinode', ['scripts/multinode.ts'], {
      cwd: demoDir,
      env: {
        NODE_ENV: 'production',
        PORT: String(port),
        PUBLIC_URL: url,
        DEMO_DATA_DIR: dataDir,
        HUB_NODES: String(o.nodes ?? 2),
        REDIS_URL: o.redisUrl,
        DATABASE_URL: o.databaseUrl,
      },
      // The nodes' own "ready" lines are echoed too; this one is the proxy's.
      marker: 'round-robin over',
      timeoutMs: 120_000,
    });
    return { url, dataDir, proc };
  }

  /** Throwaway redis:7-alpine + postgres:16-alpine on random loopback ports. */
  async docker(): Promise<{ redisUrl: string; databaseUrl: string }> {
    const docker = async (...args: string[]) => (await execFileP('docker', args, { timeout: 180_000 })).stdout.trim();
    const redis = await docker('run', '-d', '--rm', '-p', '127.0.0.1::6379', 'redis:7-alpine');
    this.containers.push(redis);
    const pg = await docker('run', '-d', '--rm', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=uncage', '-e', 'POSTGRES_USER=uncage', 'postgres:16-alpine');
    this.containers.push(pg);
    const port = async (id: string, p: number) => Number(/:(\d+)\s*$/m.exec((await docker('port', id, `${p}/tcp`)).split('\n')[0] ?? '')?.[1]);
    const redisUrl = `redis://127.0.0.1:${await port(redis, 6379)}`;
    const databaseUrl = `postgres://uncage:uncage@127.0.0.1:${await port(pg, 5432)}/uncage`;
    await until(async () => (await docker('exec', redis, 'redis-cli', 'ping')) === 'PONG', 60_000, 'redis ready');
    await until(async () => (await docker('exec', pg, 'pg_isready', '-U', 'uncage', '-h', '127.0.0.1')).includes('accepting'), 60_000, 'postgres ready');
    this.log(`docker: ${redisUrl} ${databaseUrl}`);
    return { redisUrl, databaseUrl };
  }

  /**
   * `uncage setup <url> --no-daemon --no-browser` (the real CLI) with UNCAGE_HOME=`home`; `page`
   * (signed in) opens the printed link, checks the anti-framing headers and approves.
   */
  async setup(page: Page, url: string, home: string): Promise<void> {
    const setup = await this.spawn('setup', [cliBin, 'setup', url, '--no-daemon', '--no-browser'], {
      env: { UNCAGE_HOME: home },
      marker: 'Waiting for approval',
    });
    const link = /(https?:\/\/\S+\/device\?code=\S+)/.exec(setup.output())?.[1];
    const code = /confirm the code:\s+(\S+)/.exec(setup.output())?.[1];
    expect(link, setup.output()).toBeTruthy();
    const res = await page.goto(link!);
    // The approval page may never be framed (clickjacking).
    expect(res?.headers()['x-frame-options']).toBe('DENY');
    expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    await expect(page.getByText(code!)).toBeVisible();
    await page.getByRole('button', { name: '批准', exact: true }).click();
    await expect(page.getByText('电脑已连接')).toBeVisible();
    const exit = await new Promise<number | null>((resolve) => {
      if (setup.proc.exitCode !== null) return resolve(setup.proc.exitCode);
      setup.proc.once('exit', resolve);
    });
    expect(exit, setup.output()).toBe(0);
    expect(setup.output()).toContain('Connected to');
  }

  /** The e2e fake agent (real @uncage/agent + testkit fake adapter), foreground. */
  fakeAgent(home: string): Promise<Proc> {
    return this.spawn('fake-agent', [join(repo, 'e2e/connected/fake-agent.ts')], { env: { UNCAGE_HOME: home }, marker: 'fake agent ready' });
  }

  /** The real `uncage agent` (Claude Code + Codex adapters), foreground. HOME stays real. */
  realAgent(home: string): Promise<Proc> {
    return this.spawn('agent', [cliBin, 'agent'], { env: { UNCAGE_HOME: home, UNCAGE_LOG_LEVEL: 'info' } });
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.procs.splice(0).reverse().map((p) => p.stop()));
    if (this.containers.length > 0) await execFileP('docker', ['rm', '-f', ...this.containers.splice(0)]).catch(() => undefined);
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

export async function until(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** DEMO-ONLY sign-in form. */
export async function login(page: Page, url: string, user: string): Promise<void> {
  await page.goto(`${url}/login`);
  await page.getByLabel('用户名').fill(user);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByTestId('demo-user')).toHaveText(user);
}

export const LANDING_PROMPT = '做一个介绍 Uncage 的落地页并发布';
