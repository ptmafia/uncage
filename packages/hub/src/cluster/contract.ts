/** The `ClusterAdapter` contract, shared by the in-process and Docker test suites. */
import { expect } from 'vitest';
import type { ClusterAdapter } from './cluster.js';

/** Contract every ClusterAdapter must meet. */
export async function clusterContract(make: () => ClusterAdapter): Promise<void> {
  const a = make();
  const b = make();
  try {
    const got: string[] = [];
    const unsub = await b.subscribe('uncage:test:ch', (m) => got.push(m));
    for (let i = 0; i < 20; i++) await a.publish('uncage:test:ch', `m${i}`);
    const start = Date.now();
    while (got.length < 20 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`)); // in order, once each
    unsub();
    await new Promise((r) => setTimeout(r, 30));
    await a.publish('uncage:test:ch', 'after');
    await new Promise((r) => setTimeout(r, 50));
    expect(got).not.toContain('after');

    await a.setPresence('mch_1', 'node_a', 30);
    expect(await b.getPresence('mch_1')).toBe('node_a');
    await b.clearPresence('mch_1', 'node_b'); // not the holder: no-op
    expect(await a.getPresence('mch_1')).toBe('node_a');
    await b.clearPresence('mch_1', 'node_a');
    expect(await a.getPresence('mch_1')).toBeNull();
    await a.setPresence('mch_2', 'node_a', 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await b.getPresence('mch_2')).toBeNull();
  } finally {
    await a.close();
    await b.close();
  }
}
