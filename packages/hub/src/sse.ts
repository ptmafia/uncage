import { UncageError } from '@uncage/core/errors';
import type { UncageEvent } from '@uncage/protocol';
import { formatErrorFrame, formatEvent, SSE_HEADERS, SSE_HEARTBEAT } from '@uncage/server/wire';
import { unrefTimer } from './web.js';

export interface EventSource {
  /** Events with `sequence > after`, ascending; an empty page means "caught up". */
  history(after: number, limit: number): Promise<UncageEvent[]>;
  /** Live events (may overlap history or arrive out of order; the stream dedupes by sequence). */
  subscribe(fn: (events: UncageEvent[]) => void): Promise<() => void>;
}

const HISTORY_PAGE = 200;

/** Reads history pages after `after` until caught up or `limit` events are collected. */
export async function readHistory(src: EventSource, after: number, limit: number): Promise<UncageEvent[]> {
  const out: UncageEvent[] = [];
  let cursor = after;
  while (out.length < limit) {
    const page = await src.history(cursor, Math.min(HISTORY_PAGE, limit - out.length));
    const fresh = page.filter((e) => e.sequence > cursor);
    if (fresh.length === 0) break;
    out.push(...fresh);
    cursor = fresh.at(-1)!.sequence;
  }
  return out;
}

/**
 * An SSE response with the daemon's framing (`id` / `event` / `data`, `: ping` heartbeats,
 * `event: error` then close on replay failure): history after `after`, then live events, each
 * sequence at most once and in order.
 */
export function eventStreamResponse(
  src: EventSource,
  o: { after: number; heartbeatMs: number; signals: AbortSignal[]; requestId: string },
): Response {
  const encoder = new TextEncoder();
  const ac = new AbortController();
  const abort = () => ac.abort();
  for (const s of o.signals) {
    if (s.aborted) ac.abort();
    else s.addEventListener('abort', abort, { once: true });
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (!ac.signal.aborted) controller.enqueue(encoder.encode(s));
      };
      void pump(write).finally(() => {
        for (const s of o.signals) s.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          // already cancelled by the consumer
        }
      });
    },
    cancel() {
      ac.abort();
    },
  });

  async function pump(write: (s: string) => void): Promise<void> {
    let last = o.after;
    const queue: UncageEvent[] = [];
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    ac.signal.addEventListener('abort', notify, { once: true });
    const heartbeat = setInterval(() => write(SSE_HEARTBEAT), o.heartbeatMs);
    unrefTimer(heartbeat);
    let unsubscribe: (() => void) | undefined;

    const emit = (e: UncageEvent) => {
      if (e.sequence <= last) return;
      last = e.sequence;
      write(formatEvent(e));
    };
    const catchUp = async () => {
      for (;;) {
        const page = await src.history(last, HISTORY_PAGE);
        const fresh = page.filter((e) => e.sequence > last);
        if (fresh.length === 0) return;
        for (const e of fresh) emit(e);
        if (ac.signal.aborted) return;
      }
    };

    try {
      // Subscribe before reading history so nothing committed in between is missed.
      unsubscribe = await src.subscribe((events) => {
        queue.push(...events);
        notify();
      });
      await catchUp();
      while (!ac.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        queue.sort((a, b) => a.sequence - b.sequence);
        const e = queue.shift()!;
        if (e.sequence <= last) continue;
        // A gap: fetch what is missing from history first.
        if (e.sequence > last + 1) await catchUp();
        emit(e);
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        const uerr = err instanceof UncageError ? err : new UncageError('internal_error');
        write(formatErrorFrame(uerr.toBody(o.requestId)));
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe?.();
      ac.signal.removeEventListener('abort', notify);
    }
  }

  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
