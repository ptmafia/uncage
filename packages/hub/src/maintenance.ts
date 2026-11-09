/**
 * Retention work (old run manifests, attachment copies, transport rows, stale tool calls) without a
 * background timer of its own: FaaS instances run it opportunistically from requests, a
 * long-running process from `attachWebSocket`'s timer, a platform cron through the maintenance
 * endpoint. A store lease keeps every instance together to one run per interval.
 */
import type { HubLogger } from './machines.js';
import type { HubStore } from './store/store.js';

export interface MaintenanceReport {
  /** `false`: another instance holds the maintenance lease (it ran within the interval). */
  ran: boolean;
  /** Rows each retention task deleted. */
  pruned: Record<string, number>;
  /** Tool calls failed because the instance running them died. */
  interruptedToolCalls: number;
}

/** Store lease that serializes maintenance across instances. */
export const MAINTENANCE_LEASE = 'uncage:maintenance';

export function maintenance(d: {
  store: HubStore;
  nodeId: string;
  intervalMs: number;
  logger: HubLogger;
  /**
   * Retention tasks; their counts are merged into `pruned` (a task that throws is logged and
   * skipped). A count named `interruptedToolCalls` is reported as `MaintenanceReport.interruptedToolCalls`.
   */
  tasks: Array<() => Promise<Record<string, number>>>;
  /** The site's own cleanup, after the tasks of each run. */
  onRun?: () => Promise<void>;
  /** Clock (tests). */
  now?: () => number;
}): {
  /**
   * From a request: at most one attempt per `intervalMs` on this instance; when due and the lease is
   * free, runs. With `waitUntil` the run goes to the platform (the response is not held), otherwise
   * it is awaited. Never throws.
   */
  maybeRun(waitUntil?: (p: Promise<unknown>) => void): Promise<void>;
  /** Runs now if the lease is free (or already ours); `ran: false` otherwise. */
  runNow(): Promise<MaintenanceReport>;
  /** Resolves when no run is in flight on this instance. */
  idle(): Promise<void>;
  /** No further runs (the hub closed): `runNow` reports `ran: false`, `maybeRun` does nothing. */
  stop(): void;
} {
  const now = d.now ?? Date.now;
  let lastAttemptAt = -Infinity;
  let running: Promise<MaintenanceReport> | undefined;
  let stopped = false;
  const skipped = (): MaintenanceReport => ({ ran: false, pruned: {}, interruptedToolCalls: 0 });

  async function run(): Promise<MaintenanceReport> {
    const t = now();
    lastAttemptAt = t;
    const leased = await d.store.tryLease(MAINTENANCE_LEASE, {
      holder: d.nodeId,
      until: new Date(t + d.intervalMs).toISOString(),
      now: new Date(t).toISOString(),
    });
    if (!leased) return skipped();
    const pruned: Record<string, number> = {};
    const results = await Promise.allSettled(d.tasks.map((task) => task()));
    for (const r of results) {
      if (r.status === 'fulfilled') Object.assign(pruned, r.value);
      else d.logger.error({ err: r.reason }, 'maintenance task failed');
    }
    const interruptedToolCalls = pruned.interruptedToolCalls ?? 0;
    delete pruned.interruptedToolCalls;
    if (d.onRun) await d.onRun().catch((err: unknown) => d.logger.error({ err }, 'maintenance onRun failed'));
    return { ran: true, pruned, interruptedToolCalls };
  }

  /** One run at a time on this instance (a timer tick and a request must not overlap). */
  function start(): Promise<MaintenanceReport> {
    if (stopped && !running) return Promise.resolve(skipped());
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    async maybeRun(waitUntil) {
      if (stopped || running || now() - lastAttemptAt < d.intervalMs) return;
      lastAttemptAt = now();
      const p = start().catch((err: unknown) => {
        d.logger.error({ err }, 'maintenance failed');
      });
      if (waitUntil) {
        try {
          waitUntil(p);
          return;
        } catch (err) {
          // e.g. Workers' `ctx.waitUntil` passed unbound ("Illegal invocation"): never fail the request.
          d.logger.warn({ err }, 'waitUntil threw; running maintenance inline');
        }
      }
      await p;
    },
    runNow: () => start(),
    async idle() {
      await running?.catch(() => undefined);
    },
    stop() {
      stopped = true;
    },
  };
}
