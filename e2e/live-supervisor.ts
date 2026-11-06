/**
 * Starts the stack the live E2E runs against, exactly as a user would run it:
 *
 *   1. `uncage serve` (the real CLI, real Claude Code adapter) on a tmp copy of live/fixture-repo,
 *      with its own tmp data dir and token file, so the user's ~/.uncage is never touched. HOME is
 *      left alone: Claude Code's login lives there.
 *   2. The nextjs-default-chat example (`next start`), its proxy given the token that serve created.
 *
 * Both processes' logs are written to live/results/stack.log.
 *
 * Control endpoint for the specs:
 *   GET http://127.0.0.1:<LIVE_CONTROL_PORT>/ready  200 once both are listening
 *   GET http://127.0.0.1:<LIVE_CONTROL_PORT>/info   { workspace, tokenFile, daemonUrl }
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const daemonPort = Number(process.env.LIVE_DAEMON_PORT ?? 4795);
const appPort = Number(process.env.LIVE_APP_PORT ?? 3102);
const controlPort = Number(process.env.LIVE_CONTROL_PORT ?? 4796);

const repo = new URL('..', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'uncage-live-'));
const workspace = join(root, 'workspace');
const dataDir = join(root, 'data');
const tokenFile = join(root, 'token');
cpSync(join(repo, 'e2e/live/fixture-repo'), workspace, { recursive: true });

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

const ready = (async () => {
  await startUntil(
    process.execPath,
    [
      join(repo, 'packages/cli/dist/bin.js'),
      'serve',
      '--port',
      String(daemonPort),
      '--workspace',
      workspace,
      '--data-dir',
      dataDir,
      '--token-file',
      tokenFile,
    ],
    {},
    'Uncage listening on',
    root,
  );
  const token = readFileSync(tokenFile, 'utf8').trim();
  const example = join(repo, 'examples/nextjs-default-chat');
  await startUntil(
    process.execPath,
    [join(example, 'node_modules/next/dist/bin/next'), 'start', '-p', String(appPort)],
    { UNCAGE_URL: `http://127.0.0.1:${daemonPort}`, UNCAGE_TOKEN: token },
    'Ready',
    example,
  );
})();
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
    res.end(JSON.stringify({ workspace, tokenFile, daemonUrl: `http://127.0.0.1:${daemonPort}` }));
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
