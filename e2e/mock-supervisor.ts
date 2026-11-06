/**
 * Keeps mock-server.ts running as a separate child process with one tmp data dir for the whole
 * E2E run, plus a second instance with `allowBypass` on MOCK_BYPASS_PORT (own data dir), and
 * exposes a tiny control endpoint so specs can simulate a daemon crash + restart:
 *
 *   GET  http://127.0.0.1:<CONTROL_PORT>/ready    200 once both daemons are listening
 *   POST http://127.0.0.1:<CONTROL_PORT>/restart  SIGKILL the main daemon, start it again, 200 when ready
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.MOCK_PORT ?? 4793);
const controlPort = Number(process.env.MOCK_CONTROL_PORT ?? 4794);
const bypassPort = Number(process.env.MOCK_BYPASS_PORT ?? 4797);
const TMP_PREFIX = 'uncage-e2e-';
const STALE_MS = 60 * 60 * 1000;

// Runs killed hard (e.g. Ctrl-C twice) cannot clean up; sweep their data dirs once they are stale.
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(TMP_PREFIX)) continue;
  const dir = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Raced with another sweep or not ours to remove: ignore.
  }
}

const serverScript = new URL('./mock-server.ts', import.meta.url).pathname;

/** One mock daemon child process with its own tmp data dir. */
function daemon(listenPort: number, extraEnv: NodeJS.ProcessEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  let child: ChildProcess | undefined;

  function start(): Promise<void> {
    const proc = spawn(process.execPath, [serverScript], {
      env: { ...process.env, ...extraEnv, MOCK_PORT: String(listenPort), MOCK_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child = proc;
    return new Promise((resolve, reject) => {
      let out = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('ready ')) resolve();
      });
      proc.once('exit', (code) => reject(new Error(`mock-server exited early (code ${code})`)));
    });
  }

  async function kill(): Promise<void> {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    });
  }

  return { dataDir, start, kill };
}

const main = daemon(port, {});
// The same fake runtime with `security.allowBypass` on (composer.spec.ts bypass test).
const bypass = daemon(bypassPort, { MOCK_ALLOW_BYPASS: '1' });

let ready: Promise<void> = Promise.all([main.start(), bypass.start()]).then(() => undefined);

const control = createServer((req, res) => {
  const reply = (p: Promise<void>) =>
    p.then(
      () => res.writeHead(200).end('ok'),
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
  if (req.method === 'GET' && req.url === '/ready') return void reply(ready);
  if (req.method === 'POST' && req.url === '/restart') {
    ready = main.kill().then(main.start);
    return void reply(ready);
  }
  res.writeHead(404).end();
});
control.listen(controlPort, '127.0.0.1');

const shutdown = async (): Promise<void> => {
  control.close();
  await Promise.all([main.kill(), bypass.kill()]);
  for (const d of [main, bypass]) rmSync(d.dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
