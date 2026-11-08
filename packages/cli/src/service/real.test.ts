/**
 * Registers the REAL per-user service for the CI user, with a fake entry that writes a heartbeat.
 * Runs only with UNCAGE_SERVICE_TESTS=1 on a CI machine (CI set): windows-latest (Task Scheduler)
 * and ubuntu-latest (systemd --user when the runner has one; otherwise skipped, reason logged).
 * Never on a developer machine: it writes a real task / unit and starts it.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ExecFn } from '@uncage/agent';
import { describe, expect, it } from 'vitest';
import { agentService, detectServiceKind } from './index.js';
import type { ServiceDeps, ServiceSpec } from './types.js';

const enabled = process.env.UNCAGE_SERVICE_TESTS === '1' && !!process.env.CI && (process.platform === 'win32' || process.platform === 'linux');

const run = promisify(execFile);
const exec: ExecFn = async (file, args) => {
  const r = await run(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { stdout: r.stdout, stderr: r.stderr };
};

/** The built supervisor (Windows services run `bin.js agent --supervise`). */
const SUPERVISE_JS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'supervise.js');

/**
 * The fake agent: a heartbeat line (`<pid> <time> <args>`) every 500 ms; exits 75 once when `die`
 * appears. With `--supervise` (Windows) it runs the real supervisor, which starts it again without.
 */
const FAKE = (supervise: string) => `
const { appendFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const dir = __dirname;
const argv = process.argv.slice(2);
if (argv.includes('--supervise')) {
  import(pathToFileURL(${JSON.stringify(supervise)}).href).then(async (m) => {
    process.exitCode = await m.superviseAgent({ execPath: process.execPath, entry: __filename, args: argv.filter((a) => a !== '--supervise'), logFile: argv[argv.indexOf('--log-file') + 1], restartDelayMs: 2000 });
  });
} else {
  if (process.env.UNCAGE_SUPERVISOR_PID) {
    const sup = Number(process.env.UNCAGE_SUPERVISOR_PID);
    setInterval(() => { try { process.kill(sup, 0); } catch { process.exit(0); } }, 1000);
  }
  setInterval(() => {
  appendFileSync(join(dir, 'heartbeat'), process.pid + ' ' + Date.now() + ' ' + process.argv.slice(2).join(' ') + '\\n');
  if (existsSync(join(dir, 'die'))) { rmSync(join(dir, 'die')); process.exit(75); }
  }, 500);
}
`;

/** One line on the CI run page (job summary) and in the log. */
async function report(line: string): Promise<void> {
  console.log(`::notice title=real service::${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- real service (${process.platform}): ${line}\n`).catch(() => undefined);
}

async function beats(dir: string): Promise<Array<{ pid: string; at: number; args: string }>> {
  const text = await readFile(join(dir, 'heartbeat'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [pid, at, ...rest] = l.split(' ');
      return { pid: pid!, at: Number(at), args: rest.join(' ') };
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The built CLI (CI builds it before the tests). */
const BIN_JS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.runIf(enabled)('real service (CI only)', () => {
  it('real service: install → running → kill with exit 75 → restarted within 90 s → uninstall leaves nothing', { timeout: 240_000 }, async (ctx) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'uncage real svc ')));
    const deps: ServiceDeps = { platform: process.platform, home: process.platform === 'win32' ? dir : homedir(), env: process.env, exec };
    const kind = await detectServiceKind(deps);
    if (kind === 'none') {
      await report('skipped: no user systemd on this runner (systemctl --user show-environment failed)');
      ctx.skip();
      return;
    }
    const entry = join(dir, 'fake-agent.cjs');
    await writeFile(entry, FAKE(SUPERVISE_JS));
    const logsDir = join(dir, 'logs');
    const spec: ServiceSpec = {
      nodePath: await realpath(process.execPath),
      cliEntry: entry,
      args: process.platform === 'win32' ? ['agent', '--supervise', '--log-file', join(logsDir, 'agent.log')] : ['agent'],
      env: { PATH: process.env.PATH ?? process.env.Path ?? '', HOME: homedir() },
      workingDir: dir,
      logsDir,
    };
    const svc = await agentService(deps);
    try {
      const { definitionPath, notes } = await svc.install(spec);
      console.log(`[real.test] ${svc.kind} installed at ${definitionPath}${notes.length ? ` · ${notes.join(' ')}` : ''}`);
      const first = await until('the first heartbeat', async () => (await beats(dir))[0], 60_000);
      expect(first.args).toBe(spec.args.filter((a) => a !== '--supervise').join(' '));
      const st = await svc.status();
      console.log(`[real.test] status: ${JSON.stringify({ ...st, spec: undefined })}`);
      expect(st).toMatchObject({ installed: true, nodeExists: true, spec });
      expect(st.running === true || st.running === null).toBe(true);

      const killedAt = Date.now();
      await writeFile(join(dir, 'die'), '75');
      const restarted = await until(
        'a heartbeat from a restarted process',
        async () => (await beats(dir)).find((b) => b.pid !== first.pid && b.at > killedAt),
        90_000,
      );
      await report(`${svc.kind}: exit 75 → restarted after ${restarted.at - killedAt} ms (pid ${first.pid} → ${restarted.pid})`);
    } finally {
      const { removed } = await svc.uninstall();
      expect(removed).toBe(true);
    }
    const after = await svc.status();
    expect(after).toMatchObject({ installed: false, spec: null });
    if (process.platform === 'linux') await expect(stat(join(homedir(), '.config', 'systemd', 'user', 'uncage-agent.service'))).rejects.toThrow();
    else await expect(exec('schtasks', ['/query', '/tn', 'UncageAgent'])).rejects.toThrow();
    // The process is gone: no new heartbeat after a few seconds.
    await new Promise((r) => setTimeout(r, 2_000));
    const n = (await beats(dir)).length;
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await beats(dir)).length).toBe(n);
    await report(`${svc.kind}: uninstalled, nothing left running`);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it.runIf(process.platform === 'win32')(
    'real Windows task with the built bin.js: agent --supervise starts the real agent (stub website), restart replaces the tree, uninstall stops every process',
    { timeout: 240_000 },
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'uncage real bin ')));
      const home = join(dir, 'home');
      const logsDir = join(dir, 'logs');
      await mkdir(join(home, '.uncage'), { recursive: true });
      // The stub website: a hub that is never reachable, so the real agent keeps reconnecting (stays up).
      await writeFile(
        join(home, '.uncage', 'agent.yaml'),
        'sites:\n  - id: stub.example\n    name: Stub\n    url: http://127.0.0.1:9/api/uncage\n    machineId: mch_stub\n    token: t\n',
      );
      // A task has no environment of its own: this entry sets UNCAGE_HOME, then runs the built bin.js.
      const wrapper = join(dir, 'uncage-entry.mjs');
      await writeFile(
        wrapper,
        `process.env.UNCAGE_HOME = ${JSON.stringify(home)};\nprocess.argv[1] = ${JSON.stringify(BIN_JS)};\nawait import(${JSON.stringify(pathToFileURL(BIN_JS).href)});\n`,
      );
      const spec: ServiceSpec = {
        nodePath: await realpath(process.execPath),
        cliEntry: wrapper,
        args: ['agent', '--supervise', '--log-file', join(logsDir, 'agent.log')],
        env: { PATH: process.env.PATH ?? process.env.Path ?? '', HOME: homedir() },
        workingDir: dir,
        logsDir,
      };
      const svc = await agentService({ platform: 'win32', home: dir, env: process.env, exec });
      const pidFile = join(logsDir, 'supervisor.pid');
      const supervisorPid = async () => Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0;
      /** pids of the agent processes (pino writes `"pid":<n>` on every line). */
      const agentPids = async () => [...new Set([...(await readFile(join(logsDir, 'agent.log'), 'utf8').catch(() => '')).matchAll(/"pid":(\d+)/g)].map((m) => Number(m[1])))];
      try {
        await svc.install(spec);
        const sup1 = await until('the supervisor pid file', supervisorPid, 60_000);
        await until('the real agent logging', async () => (await agentPids()).length > 0, 60_000);
        expect(await svc.status()).toMatchObject({ kind: 'schtasks', installed: true, running: true, spec });
        expect(alive(sup1)).toBe(true);
        await report(`built bin.js: supervisor ${sup1}, agent ${(await agentPids()).join(',')}`);

        expect(await svc.restart()).toBe(true);
        const sup2 = await until('a new supervisor', async () => {
          const p = await supervisorPid();
          return p && p !== sup1 ? p : 0;
        }, 60_000); // prettier-ignore
        await until('the old supervisor gone', async () => !alive(sup1), 15_000);
        expect(alive(sup2)).toBe(true);
      } finally {
        expect((await svc.uninstall()).removed).toBe(true);
      }
      const pids = [await supervisorPid(), ...(await agentPids())].filter((p) => p > 0);
      await until('every agent process gone', async () => pids.every((p) => !alive(p)), 15_000);
      await expect(exec('schtasks', ['/query', '/tn', 'UncageAgent'])).rejects.toThrow();
      await report(`built bin.js: restart replaced the tree; uninstall stopped ${pids.length} processes`);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  );
});
