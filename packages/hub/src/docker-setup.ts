/**
 * Vitest global setup for the `docker` project: starts throwaway Redis and Postgres containers on
 * random loopback ports and provides their URLs to the tests (`inject('redisUrl')`, ...).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
    postgresUrl: string;
  }
}

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { timeout: 180_000 })).stdout.trim();

async function hostPort(id: string, port: number): Promise<number> {
  // e.g. "127.0.0.1:55012"
  const out = await docker('port', id, `${port}/tcp`);
  const m = /:(\d+)\s*$/m.exec(out.split('\n')[0] ?? '');
  if (!m) throw new Error(`docker port ${id} ${port}: unexpected output "${out}"`);
  return Number(m[1]);
}

async function retry(what: string, fn: () => Promise<void>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw new Error(`${what} not ready: ${(e as Error).message}`, { cause: e });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const ids: string[] = [];
  const teardown = async () => {
    if (ids.length > 0) await docker('rm', '-f', ...ids).catch(() => undefined);
  };
  try {
    const redis = await docker('run', '-d', '--rm', '-p', '127.0.0.1::6379', 'redis:7-alpine');
    ids.push(redis);
    const postgres = await docker('run', '-d', '--rm', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=uncage', '-e', 'POSTGRES_USER=uncage', 'postgres:16-alpine');
    ids.push(postgres);
    const redisUrl = `redis://127.0.0.1:${await hostPort(redis, 6379)}`;
    const postgresUrl = `postgres://uncage:uncage@127.0.0.1:${await hostPort(postgres, 5432)}/uncage`;
    await retry('redis', async () => {
      if ((await docker('exec', redis, 'redis-cli', 'ping')) !== 'PONG') throw new Error('no PONG');
    });
    await retry('postgres', async () => {
      const c = new pg.Client({ connectionString: postgresUrl });
      try {
        await c.connect();
        await c.query('SELECT 1');
      } finally {
        await c.end().catch(() => undefined);
      }
    });
    project.provide('redisUrl', redisUrl);
    project.provide('postgresUrl', postgresUrl);
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
