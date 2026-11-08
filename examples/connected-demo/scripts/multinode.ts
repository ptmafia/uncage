/**
 * Multi-node dev mode: HUB_NODES (default 2) demo servers sharing one Postgres (DATABASE_URL) and
 * one Redis (REDIS_URL), behind the round-robin proxy in rr-proxy.ts on PORT (default 3200).
 *
 *   docker compose up -d        # redis + postgres from docker-compose.yml
 *   pnpm build
 *   HUB_NODES=2 REDIS_URL=redis://127.0.0.1:6380 \
 *     DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5433/uncage pnpm multinode
 *
 * Node i listens on PORT+1+i. All nodes share DEMO_DATA_DIR (assets, cookie secret), so run them
 * on one machine. Stops every node on SIGINT / SIGTERM.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from './rr-proxy.ts';

const nodes = Number(process.env.HUB_NODES || 2);
const port = Number(process.env.PORT || 3200);
const host = process.env.HOST || '127.0.0.1';
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
if (!Number.isInteger(nodes) || nodes < 1) throw new Error(`HUB_NODES must be a positive integer (got "${process.env.HUB_NODES}")`);
if (nodes > 1 && (!process.env.REDIS_URL || !process.env.DATABASE_URL)) {
  console.error('Several nodes share state through Redis and Postgres: set REDIS_URL and DATABASE_URL (see docker-compose.yml).');
  process.exit(2);
}

const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];

function startNode(i: number): Promise<void> {
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: demoDir,
    env: { ...process.env, PORT: String(port + 1 + i), HOST: host, PUBLIC_URL: publicUrl, TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[node ${i + 1}] ${chunk}`);
      out += chunk.toString();
      if (out.includes('ready ')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`node ${i + 1} exited (code ${code})`)));
  });
}

const stop = (code = 0): void => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once('exit', r))))).then(() => process.exit(code));
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

try {
  // One at a time: Postgres migrations take an advisory lock anyway; this keeps the logs readable.
  for (let i = 0; i < nodes; i++) await startNode(i);
  const targets = Array.from({ length: nodes }, (_, i) => ({ host, port: port + 1 + i }));
  await startProxy(port, targets, host);
  console.log(`ready ${publicUrl} (round-robin over ${nodes} node(s): ${targets.map((t) => t.port).join(', ')})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  stop(1);
}
