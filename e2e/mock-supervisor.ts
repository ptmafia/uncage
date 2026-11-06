/**
 * Keeps mock-server.ts running as a separate child process with one tmp data dir for the whole
 * E2E run, and exposes a tiny control endpoint so specs can simulate a daemon crash + restart:
 *
 *   GET  http://127.0.0.1:<CONTROL_PORT>/ready    200 once the daemon is listening
 *   POST http://127.0.0.1:<CONTROL_PORT>/restart  SIGKILL the daemon, start it again, 200 when ready
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.MOCK_PORT ?? 4793);
const controlPort = Number(process.env.MOCK_CONTROL_PORT ?? 4794);
const dataDir = mkdtempSync(join(tmpdir(), 'uncage-e2e-'));
const serverScript = new URL('./mock-server.ts', import.meta.url).pathname;

let child: ChildProcess | undefined;
let ready: Promise<void> = Promise.resolve();

function start(): Promise<void> {
  const proc = spawn(process.execPath, [serverScript], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_DATA_DIR: dataDir },
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

ready = start();

const control = createServer((req, res) => {
  const reply = (p: Promise<void>) =>
    p.then(
      () => res.writeHead(200).end('ok'),
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
  if (req.method === 'GET' && req.url === '/ready') return void reply(ready);
  if (req.method === 'POST' && req.url === '/restart') {
    ready = kill().then(start);
    return void reply(ready);
  }
  res.writeHead(404).end();
});
control.listen(controlPort, '127.0.0.1');

const shutdown = async (): Promise<void> => {
  control.close();
  await kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
