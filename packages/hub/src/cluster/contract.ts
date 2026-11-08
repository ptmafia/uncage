/** The `ClusterAdapter` contract, shared by the in-process and Docker test suites. */
import { expect } from 'vitest';
import type { ClusterAdapter } from './cluster.js';

export interface ClusterContractHooks {
  /**
   * Out-of-order commit (Review Focus #1), for adapters backed by a sequence: inserts `msg` on
   * `channel` in an open transaction, so its id is lower than any message published after this
   * resolves but it becomes visible only on `commit()`. The contract checks it is still delivered.
   */
  insertUncommitted?(channel: string, msg: string): Promise<{ commit(): Promise<void> }>;
}

async function waitFor(ok: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error(`clusterContract: timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Contract every ClusterAdapter must meet. */
export async function clusterContract(make: () => ClusterAdapter, hooks: ClusterContractHooks = {}): Promise<void> {
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

    if (hooks.insertUncommitted) {
      const gap: string[] = [];
      const unsubGap = await b.subscribe('uncage:test:gap', (m) => gap.push(m));
      const late = await hooks.insertUncommitted('uncage:test:gap', 'late');
      await a.publish('uncage:test:gap', 'early');
      await waitFor(() => gap.includes('early'), 2000);
      await late.commit();
      await waitFor(() => gap.includes('late'), 2000);
      expect(gap).toEqual(['early', 'late']);
      unsubGap();
    }
  } finally {
    await a.close();
    await b.close();
  }
}
