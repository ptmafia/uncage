/**
 * Starts the stack the live E2E runs against, exactly as a user would run it:
 *
 *   1. `uncage serve` (the real CLI, real Claude Code adapter) on a tmp copy of live/fixture-repo,
 *      with its own tmp data dir and token file, so the user's ~/.uncage is never touched. HOME is
 *      left alone: Claude Code's login lives there.
 *   2. The nextjs-default-chat and react-headless-chat examples (`next start`), their proxies given
 *      the token that serve created.
 *
 *   3. A second `uncage serve` with UNCAGE_ALLOW_BYPASS=1 on its own tmp copy of the fixture (own
 *      data dir and token), and nextjs-default-chat in front of it, for the bypassPermissions spec.
 *      Bypass lets the agent run commands without approval, so it only ever sees that tmp copy.
 *
 * All processes' logs are written to live/results/stack.log.
 *
 * Control endpoint for the specs:
 *   GET http://127.0.0.1:<LIVE_CONTROL_PORT>/ready  200 once everything is listening
 *   GET http://127.0.0.1:<LIVE_CONTROL_PORT>/info   { workspace, tokenFile, daemonUrl, bypass: { workspace, tokenFile, daemonUrl } }
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const daemonPort = Number(process.env.LIVE_DAEMON_PORT ?? 4795);
const appPort = Number(process.env.LIVE_APP_PORT ?? 3102);
const headlessPort = Number(process.env.LIVE_HEADLESS_PORT ?? 3103);
const controlPort = Number(process.env.LIVE_CONTROL_PORT ?? 4796);
const bypassDaemonPort = Number(process.env.LIVE_BYPASS_DAEMON_PORT ?? 4798);
const bypassAppPort = Number(process.env.LIVE_BYPASS_APP_PORT ?? 3105);

const repo = new URL('..', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'uncage-live-'));
/** One `uncage serve` instance's tmp paths: a fresh copy of the fixture repo, data dir, token file. */
function stackDirs(name: string) {
  const dir = join(root, name);
  const workspace = join(dir, 'workspace');
  cpSync(join(repo, 'e2e/live/fixture-repo'), workspace, { recursive: true });
  return { workspace, dataDir: join(dir, 'data'), tokenFile: join(dir, 'token') };
}
// Both serves run in `root` and read its uncage.config.yaml: Claude Code (and Codex) only. Without
// it, the `claude` ACP preset finds the pinned claude-agent-acp on PATH (pnpm puts e2e's
// node_modules/.bin there) and registry detection runs; the ACP path has its own live project.
writeFileSync(join(root, 'uncage.config.yaml'), 'runtimes:\n  acp:\n    presets: off\n    autoDetect: false\n');
const main = stackDirs('main');
const bypass = stackDirs('bypass');

const children: ChildProcess[] = [];
// Daemon/app logs go to a file next to the Playwright report instead of flooding the test output.
const resultsDir = join(repo, 'e2e/live/results');
mkdirSync(resultsDir, { recursive: true });
const logFd = openSync(join(resultsDir, 'stack.log'), 'w');

/** Spawns a child and resolves once its stdout contains `marker`. */
function startUntil(cmd: string, args: string[], env: NodeJS.ProcessEnv, marker: string, cwd: string): Promise<ChildProcess> {
  // Own process group: Playwright signals the supervisor's group on teardown, and a second SIGTERM
  // would make `uncage serve` force-exit instead of shutting down gracefully. Only we signal them.
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', logFd], detached: true });
  children.push(proc);
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      process.stdout.write(chunk);
      writeSync(logFd, chunk);
      if (out.includes(marker)) resolve(proc);
    });
    proc.once('exit', (code) => reject(new Error(`${args.join(' ')} exited early (code ${code})`)));
  });
}

/** Starts `uncage serve` on `dirs`, then nextjs-default-chat (and optionally the headless example) in front of it. */
async function startStack(
  dirs: ReturnType<typeof stackDirs>,
  port: number,
  env: NodeJS.ProcessEnv,
  apps: Array<[name: string, port: number]>,
): Promise<void> {
  await startUntil(
    process.execPath,
    [
      join(repo, 'packages/cli/dist/bin.js'),
      'serve',
      '--port',
      String(port),
      '--workspace',
      dirs.workspace,
      '--data-dir',
      dirs.dataDir,
      '--token-file',
      dirs.tokenFile,
    ],
    env,
    'Uncage listening on',
    root,
  );
  const token = readFileSync(dirs.tokenFile, 'utf8').trim();
  const startExample = (name: string, appPort: number) => {
    const example = join(repo, 'examples', name);
    return startUntil(
      process.execPath,
      [join(example, 'node_modules/next/dist/bin/next'), 'start', '-p', String(appPort)],
      { UNCAGE_URL: `http://127.0.0.1:${port}`, UNCAGE_TOKEN: token },
      'Ready',
      example,
    );
  };
  await Promise.all(apps.map(([name, appPort]) => startExample(name, appPort)));
}

// The user's environment may set UNCAGE_ALLOW_BYPASS: the main stack must never allow bypass.
const ready = Promise.all([
  startStack(main, daemonPort, { UNCAGE_ALLOW_BYPASS: '' }, [
    ['nextjs-default-chat', appPort],
    ['react-headless-chat', headlessPort],
  ]),
  startStack(bypass, bypassDaemonPort, { UNCAGE_ALLOW_BYPASS: '1' }, [['nextjs-default-chat', bypassAppPort]]),
]);
ready.catch((err: unknown) => console.error(err));

const control = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ready') {
    void ready.then(
      () => res.writeHead(200).end('ok'),
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/info') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        workspace: main.workspace,
        tokenFile: main.tokenFile,
        daemonUrl: `http://127.0.0.1:${daemonPort}`,
        bypass: { workspace: bypass.workspace, tokenFile: bypass.tokenFile, daemonUrl: `http://127.0.0.1:${bypassDaemonPort}` },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
control.listen(controlPort, '127.0.0.1');

const stopChild = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const force = setTimeout(() => proc.kill('SIGKILL'), 12_000);
    proc.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill('SIGTERM'); // uncage serve shuts down gracefully: runs end interrupted, CLI children killed
  });

const shutdown = async (): Promise<void> => {
  control.close();
  await Promise.all(children.map(stopChild));
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
