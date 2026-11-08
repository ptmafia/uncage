import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { UncageError } from '@uncage/core';
import { migrateHubStore, sqlHubStore, type SqlClient } from './sql.js';
import type { HubStore } from './store.js';

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** `<dataDir>/uncage-hub.lock` holds our pid; a stale lock (dead pid) is taken over. */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'uncage-hub.lock');
  const locked = () =>
    new UncageError('store_locked', {
      hint: `Another hub process is using ${dataDir}. A single-node PGlite store cannot be shared; use a shared Postgres store for multiple nodes.`,
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) throw locked();
      rmSync(lockPath, { force: true });
    }
  }
  throw locked();
}

/**
 * Single-node hub store on embedded Postgres (PGlite). `dataDir: 'memory://'` keeps everything in
 * memory (tests). One process per data dir.
 */
export async function pgliteHubStore(o: { dataDir: string }): Promise<HubStore> {
  const inMemory = o.dataDir === 'memory://';
  const release = inMemory ? () => undefined : acquireLock(o.dataDir);
  let pg: PGlite;
  try {
    pg = new PGlite(o.dataDir);
    await pg.waitReady;
    await migrateHubStore(pg as unknown as SqlClient);
  } catch (e) {
    release();
    throw e;
  }
  let closed: Promise<void> | undefined;
  return sqlHubStore(pg as unknown as SqlClient, () =>
    (closed ??= pg.close().finally(release)),
  );
}
