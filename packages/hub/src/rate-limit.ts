import { UncageError } from '@uncage/core';

const MAX_KEYS = 50_000;

/**
 * In-memory sliding-window counter, per node. Multi-node deployments get per-node limits (each
 * node counts on its own) until limits are shared through the cluster adapter.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Milliseconds until `key` may act again, or 0 when under the limit. */
  retryAfterMs(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, list[list.length - this.max]! + this.windowMs - this.now());
  }

  record(key: string): void {
    if (this.hits.size >= MAX_KEYS) this.prune();
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  /** Undoes the most recent `record(key)` (a reserved attempt that turned out not to count). */
  release(key: string): void {
    const list = this.hits.get(key);
    if (!list) return;
    list.pop();
    if (list.length === 0) this.hits.delete(key);
  }

  /** Records a hit unless over the limit; throws `rate_limited` when over it. */
  take(key: string): void {
    this.assertAllowed(key);
    this.record(key);
  }

  /** Throws `rate_limited` (429, `details.retryAfterSec`) when `key` is over the limit. */
  assertAllowed(key: string): void {
    const ms = this.retryAfterMs(key);
    if (ms > 0) {
      const retryAfterSec = Math.ceil(ms / 1000);
      throw new UncageError('rate_limited', { hint: `Try again in ${retryAfterSec} s.`, details: { retryAfterSec } });
    }
  }

  private prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
    // Still full of live keys: drop the oldest half rather than grow without bound.
    if (this.hits.size >= MAX_KEYS) [...this.hits.keys()].slice(0, MAX_KEYS / 2).forEach((k) => this.hits.delete(k));
  }
}
