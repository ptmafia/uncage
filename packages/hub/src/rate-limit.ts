import { UncageError } from '@uncage/core/errors';
import type { HubStore } from './store/store.js';

/** An abuse limit shared by every hub instance on the same store. */
export interface RateLimiter {
  /** Counts one hit for `key`; throws `rate_limited` (429, `details.retryAfterSec`) when over the limit. */
  take(key: string): Promise<void>;
  /** Gives back one hit for `key` (a reserved attempt that turned out not to count). */
  release(key: string): Promise<void>;
}

/**
 * Fixed-window limiter counted in the store (`uncage_hub_rate_limits`), so every instance (FaaS
 * functions, several nodes) shares one count. The store key is `${name}:${key}`. Refused hits do
 * not count. Being fixed windows, up to `2 × max` hits can land around a window boundary.
 */
export function storeRateLimiter(store: HubStore, o: { name: string; max: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = o.now ?? Date.now;
  return {
    async take(key) {
      const r = await store.hitRateLimit(`${o.name}:${key}`, { max: o.max, windowMs: o.windowMs, nowMs: now() });
      if (!r.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
        throw new UncageError('rate_limited', { hint: `Try again in ${retryAfterSec} s.`, details: { retryAfterSec } });
      }
    },
    // A release that lands in the next window gives the hit back there (never below 0); the old
    // window keeps it. Off by at most one around a boundary, and no per-instance state to leak.
    async release(key) {
      await store.releaseRateLimit(`${o.name}:${key}`, { windowMs: o.windowMs, nowMs: now() });
    },
  };
}
