/**
 * The Linux full chain in local Docker images (UNCAGE_DOCKER_TESTS=1 only; needs `pnpm build` first
 * and network access for fnm, Node 22 and the npm registry):
 *
 * 1. `debian:bookworm-slim` with curl, CA certificates and unzip, no Node: the real hub (its own
 *    container, whose network namespace the computer joins, so `http://127.0.0.1:3000` is loopback)
 *    serves install.sh; `curl … | bash -s -- --yes` installs Node 22 with fnm and the CLI from the
 *    local tarballs; `uncage setup` is approved by this test through the published port; the agent
 *    comes online and a codex run (testkit fake app-server) completes; `uncage agent install` falls
 *    back to the foreground (no user systemd).
 * 2. A systemd-booted Debian: enable-linger, `uncage agent install` pinned to a user-owned Node,
 *    the unit active, restarted after kill -9, and doctor flagging the pinned Node once it is removed.
 *    Skipped, with the reason logged, when the local Docker cannot boot systemd.
 */
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const packagesDir = join(pkgRoot, '..');
const chainDir = join(pkgRoot, 'docker', 'linux-chain');
const tag = `uncage-chain-${process.pid}`;

async function docker(args: string[], o: { timeout?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeout ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.end(o.input ?? '');
  });
}
async function dockerOk(args: string[], o: { timeout?: number; input?: string } = {}): Promise<string> {
  const r = await docker(args, o);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} → ${r.code}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(500);
  }
}

interface WorkspacePkg {
  name: string;
  dir: string;
  deps: string[];
}

/** Workspace packages by name, with their @uncage/* dependencies. */
async function workspace(): Promise<Map<string, WorkspacePkg>> {
  const out = new Map<string, WorkspacePkg>();
  for (const d of await readdir(packagesDir)) {
    const pj = JSON.parse(await readFile(join(packagesDir, d, 'package.json'), 'utf8').catch(() => 'null')) as {
      name?: string;
      dependencies?: Record<string, string>;
    } | null;
    if (!pj?.name) continue;
    out.set(pj.name, { name: pj.name, dir: join(packagesDir, d), deps: Object.keys(pj.dependencies ?? {}).filter((n) => n.startsWith('@uncage/')) });
  }
  return out;
}

const tgzName = (name: string): string => `${name.replace(/^@/, '').replace('/', '-')}.tgz`;

/**
 * `pnpm pack` of @uncage/cli, @uncage/hub and every @uncage/* package they need, with each
 * @uncage/* dependency rewritten to `file:/pkgs/<name>.tgz`, so npm in the image installs these
 * builds (third-party dependencies come from the registry).
 */
async function packTarballs(dest: string): Promise<void> {
  const ws = await workspace();
  const need = new Set<string>();
  const visit = (n: string) => {
    if (need.has(n)) return;
    need.add(n);
    for (const d of ws.get(n)?.deps ?? []) visit(d);
  };
  visit('@uncage/cli');
  visit('@uncage/hub');
  const work = await mkdtemp(join(tmpdir(), 'uncage-pack-'));
  try {
    for (const name of need) {
      const p = ws.get(name)!;
      const outDir = join(work, tgzName(name).replace(/\.tgz$/, ''));
      await mkdir(outDir, { recursive: true });
      await run('pnpm', ['pack', '--pack-destination', outDir], { cwd: p.dir, timeout: 120_000 });
      const packed = (await readdir(outDir)).find((f) => f.endsWith('.tgz'))!;
      await run('tar', ['xzf', join(outDir, packed), '-C', outDir]);
      const pjPath = join(outDir, 'package', 'package.json');
      const pj = JSON.parse(await readFile(pjPath, 'utf8')) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(pj.dependencies ?? {})) if (dep.startsWith('@uncage/')) pj.dependencies![dep] = `file:/pkgs/${tgzName(dep)}`;
      await writeFile(pjPath, `${JSON.stringify(pj, null, 2)}\n`);
      await run('tar', ['czf', join(dest, tgzName(name)), '-C', outDir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const enabled = process.env.UNCAGE_DOCKER_TESTS === '1';
let ctx = '';
const containers: string[] = [];

describe.runIf(enabled)('Linux full chain (Docker)', () => {
  beforeAll(async () => {
    await dockerOk(['version', '--format', '{{.Server.Version}}']);
    ctx = await mkdtemp(join(tmpdir(), 'uncage-chain-ctx-'));
    await mkdir(join(ctx, 'pkgs'));
    await packTarballs(join(ctx, 'pkgs'));
    for (const f of ['Dockerfile', 'Dockerfile.systemd', 'hub.mjs', 'run.sh', 'codex']) await copyFile(join(chainDir, f), join(ctx, f));
    await copyFile(join(packagesDir, 'testkit', 'dist', 'fake-codex.js'), join(ctx, 'fake-codex.js'));
    await dockerOk(['build', '--target', 'hub', '-t', `${tag}-hub`, ctx], { timeout: 900_000 });
    await dockerOk(['build', '--target', 'chain', '-t', `${tag}-chain`, ctx], { timeout: 900_000 });
  });

  afterAll(async () => {
    for (const c of containers) await docker(['rm', '-f', c]);
    await docker(['rmi', '-f', `${tag}-hub`, `${tag}-chain`, `${tag}-systemd`]);
    if (ctx) await rm(ctx, { recursive: true, force: true });
  });

  it('Linux full chain: install.sh with real Node via fnm, setup with device approval, agent online, a codex run (testkit fake) completes, uncage agent install falls back to foreground without systemd', async () => {
    const hub = `${tag}-hub-c`;
    const chain = `${tag}-chain-c`;
    containers.push(hub, chain);
    await dockerOk(['run', '-d', '--name', hub, '-p', '127.0.0.1::3000', `${tag}-hub`]);
    const port = Number(/:(\d+)\s*$/m.exec(await dockerOk(['port', hub, '3000/tcp']))?.[1]);
    const origin = `http://127.0.0.1:${port}`;
    await until('the hub', async () => (await fetch(`${origin}/api/uncage/install.sh`)).ok, 60_000);

    await dockerOk(['run', '-d', '--name', chain, '--network', `container:${hub}`, `${tag}-chain`]);
    const logs = async () => {
      const r = await docker(['logs', chain]);
      return r.stdout + r.stderr;
    };
    const code = await until('the device code', async () => /^CHAIN code ([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await logs())?.[1], 600_000);
    const approve = await fetch(`${origin}/test/approve`, { method: 'POST', body: JSON.stringify({ code }) });
    expect(approve.status).toBe(200);

    const exit = Number((await dockerOk(['wait', chain], { timeout: 600_000 })).trim());
    const out = await logs();
    console.log(out.split('\n').filter((l) => l.startsWith('CHAIN')).join('\n'));
    if (exit !== 0) console.log(out);
    expect(exit).toBe(0);
    expect(out).toContain('CHAIN no node, hub reachable');
    expect(out).toMatch(/^CHAIN installed node v22\.\d+\.\d+ at \/home\/u\/.*fnm.*\/bin\/node; uncage at /m);
    expect(out).toMatch(/^CHAIN version \d+\.\d+\.\d+\|node v22\./m);
    expect(out).toContain('CHAIN setup connected');
    expect(out).toMatch(/^CHAIN agent online \(.*codex:available.*\)$/m);
    expect(out).toContain('CHAIN run run.completed|Hello from fake Codex.');
    expect(out).toContain('CHAIN agent install: foreground fallback');
    expect(out).toMatch(/^CHAIN OK$/m);
  });

  it('Linux systemd user service in a systemd container: enable-linger, agent install, active, restarted after kill -9, doctor flags a removed pinned Node', async (t) => {
    await dockerOk(['build', '-f', join(ctx, 'Dockerfile.systemd'), '-t', `${tag}-systemd`, ctx], { timeout: 900_000 });
    const c = `${tag}-systemd-c`;
    containers.push(c);
    const started = await docker([
      'run', '-d', '--name', c, '--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', `${tag}-systemd`,
    ]); // prettier-ignore
    const booted =
      started.code === 0 &&
      (await until(
        'systemd to boot',
        async () => {
          const r = await docker(['exec', c, 'systemctl', 'is-system-running']);
          return /^(running|degraded)$/m.test(r.stdout) && r.stdout.trim();
        },
        90_000,
      ).catch(() => false));
    if (!booted) {
      const reason = `${started.stderr.trim()} ${(await docker(['logs', c])).stdout.slice(-2000)}`;
      console.log(`[linux-chain] systemd variant skipped: the local Docker could not boot systemd. ${reason}`);
      t.skip();
      return;
    }
    console.log(`[linux-chain] systemd booted (${booted})`);
    await dockerOk(['exec', c, 'loginctl', 'enable-linger', 'u']);
    await until('the user manager bus', async () => (await docker(['exec', c, 'test', '-S', '/run/user/1000/bus'])).code === 0, 60_000);
    const asU = (args: string[], input?: string) =>
      docker(
        ['exec', ...(input !== undefined ? ['-i'] : []), '-u', 'u', '-w', '/home/u', '-e', 'XDG_RUNTIME_DIR=/run/user/1000', '-e', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus', '-e', 'USER=u', '-e', 'HOME=/home/u', c, ...args],
        input !== undefined ? { input } : {},
      );
    // One website whose hub is unreachable: the agent keeps running (reconnecting) instead of exiting.
    const yaml = 'sites:\n  - id: app.example.com\n    name: App\n    url: http://127.0.0.1:9/api/uncage\n    machineId: mch_1\n    token: t\n';
    expect((await asU(['sh', '-c', 'mkdir -p ~/.uncage && chmod 700 ~/.uncage && umask 077 && cat > ~/.uncage/agent.yaml'], yaml)).code).toBe(0);

    const install = await asU(['/home/u/node22/bin/node', '/usr/local/lib/node_modules/@uncage/cli/dist/bin.js', 'agent', 'install']);
    console.log(install.stdout + install.stderr);
    expect(install.code).toBe(0);
    expect(install.stdout).toMatch(/Background agent running \(systemd --user: \/home\/u\/\.config\/systemd\/user\/uncage-agent\.service\)/);
    expect(install.stdout).toContain('Node: /home/u/node22/bin/node');
    expect(install.stdout).not.toContain('loginctl enable-linger'); // linger is on

    const mainPid = async () => (await asU(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', 'uncage-agent.service'])).stdout.trim();
    const active = async () => (await asU(['systemctl', '--user', 'is-active', 'uncage-agent.service'])).stdout.trim() === 'active';
    await until('the unit active', active, 30_000);
    const pid1 = await until('a main pid', async () => ((await mainPid()) !== '0' ? mainPid() : false), 30_000);
    const status = JSON.parse((await asU(['uncage', 'agent', 'status', '--json'])).stdout) as { kind: string; running: boolean; spec: { nodePath: string } };
    expect(status).toMatchObject({ kind: 'systemd', running: true, spec: { nodePath: '/home/u/node22/bin/node' } });

    await dockerOk(['exec', c, 'kill', '-9', pid1]);
    const pid2 = await until('a restarted agent', async () => {
      const p = await mainPid();
      return p !== '0' && p !== pid1 && (await active()) ? p : false;
    }, 40_000); // prettier-ignore
    console.log(`[linux-chain] restarted after kill -9: ${pid1} → ${pid2}`);

    const healthy = await asU(['uncage', 'doctor']);
    expect(healthy.stdout).toMatch(/✓ Background agent — systemd: running/);
    expect(healthy.stdout).toMatch(/✓ Background agent Node — v22\.\d+\.\d+ · \/home\/u\/node22\/bin\/node/);
    expect(healthy.stdout).toMatch(/✓ Agent keeps running after logout — linger on/);

    await dockerOk(['exec', c, 'rm', '-rf', '/home/u/node22']);
    const doctor = await asU(['uncage', 'doctor']);
    console.log(doctor.stdout);
    expect(doctor.stdout).toMatch(/✗ Background agent Node — \/home\/u\/node22\/bin\/node no longer exists[^\n]*\n\s+fix: uncage agent install/);
    expect(doctor.code).toBe(1);

    expect((await asU(['uncage', 'agent', 'uninstall'])).stdout).toContain('stopped and removed');
    expect((await asU(['test', '-e', '/home/u/.config/systemd/user/uncage-agent.service'])).code).not.toBe(0);
  });
});
