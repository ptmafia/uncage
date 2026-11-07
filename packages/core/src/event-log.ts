import type { EventEnvelope, EventType, UncageEvent, UncageEventMap } from '@uncage/protocol';
import { UncageError } from './errors.js';
import { silentLog, type Log } from './logger.js';
import type { Store } from './store/store.js';

type Listener = (e: UncageEvent) => void;

const REPLAY_PAGE = 500;
/** `readAfter` page size bounds. */
export const READ_AFTER_DEFAULT = 500;
export const READ_AFTER_MAX = 1000;

/**
 * Append-only per-session event log. Ordering rule: append → store commit → publish to the
 * in-process emitter. Appends are serialised per session so sequences are published in order
 * and `occurredAt` (set here) is monotonic, which retention pruning relies on.
 *
 * `onEvent` (optional) sees every committed event of every session, in sequence order per session.
 * It is called synchronously after commit; a throwing listener is logged and otherwise ignored.
 */
export class EventLog {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly onEvent?: Listener,
    private readonly logger: Log = silentLog,
  ) {}

  append<K extends EventType>(
    sessionId: string,
    type: K,
    payload: UncageEventMap[K],
    runId?: string,
  ): Promise<EventEnvelope<K>> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const e = await this.store.appendEvent<K>({
          sessionId,
          type,
          payload,
          occurredAt: new Date().toISOString(),
          ...(runId !== undefined ? { runId } : {}),
        });
        this.publish(e as unknown as UncageEvent);
        return e;
      });
    this.tails.set(sessionId, next);
    void next.finally(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    }).catch(() => undefined);
    return next;
  }

  /** Resolves once every append issued so far has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }

  /**
   * At most `limit` (default 500, clamped to 1..1000) committed events with sequence > `after`,
   * in sequence order. `event_replay_unavailable` when retention already pruned part of that range.
   */
  async readAfter(sessionId: string, after: number, limit = READ_AFTER_DEFAULT): Promise<UncageEvent[]> {
    const n = Math.min(READ_AFTER_MAX, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : READ_AFTER_DEFAULT)));
    const min = await this.store.minRetainedSequence(sessionId);
    if (min > 0 && after < min - 1) {
      throw new UncageError('event_replay_unavailable', { details: { after, minRetainedSequence: min } });
    }
    return (await this.store.readEvents(sessionId, after, n)) as UncageEvent[];
  }

  private publish(e: UncageEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(e);
      } catch (err) {
        this.logger.error({ err, sessionId: e.sessionId, sequence: e.sequence }, 'onEvent listener failed');
      }
    }
    for (const l of this.listeners.get(e.sessionId) ?? []) l(e);
  }

  private subscribe(sessionId: string, l: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
      if (set.size === 0 && this.listeners.get(sessionId) === set) this.listeners.delete(sessionId);
    };
  }

  /**
   * Replays events with sequence > `after` from the store, then streams live ones. Never ends on
   * its own; it returns when `signal` aborts or the consumer stops iterating. Subscribes before
   * replaying and drops buffered events already replayed, so nothing is missed or duplicated.
   */
  async *read(sessionId: string, after = 0, signal?: AbortSignal): AsyncGenerator<UncageEvent> {
    const buffer: UncageEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.subscribe(sessionId, (e) => {
      buffer.push(e);
      wake?.();
    });
    const onAbort = (): void => wake?.();
    signal?.addEventListener('abort', onAbort);
    try {
      const min = await this.store.minRetainedSequence(sessionId);
      if (min > 0 && after < min - 1) {
        throw new UncageError('event_replay_unavailable', { details: { after, minRetainedSequence: min } });
      }
      let last = after;
      for (;;) {
        const page = await this.store.readEvents(sessionId, last, REPLAY_PAGE);
        for (const e of page) {
          if (signal?.aborted) return;
          yield e as UncageEvent;
          last = e.sequence;
        }
        if (page.length < REPLAY_PAGE) break;
      }
      for (;;) {
        if (signal?.aborted) return;
        const e = buffer.shift();
        if (e === undefined) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        if (e.sequence <= last) continue;
        last = e.sequence;
        yield e;
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
