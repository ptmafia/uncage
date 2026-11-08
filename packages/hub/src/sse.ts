import { UncageError } from '@uncage/core/errors';
import type { UncageEvent } from '@uncage/protocol';
import { formatErrorFrame, formatEvent, formatReconnectFrame, SSE_HEADERS, SSE_HEARTBEAT } from '@uncage/server/wire';
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
 * sequence at most once and in order. After `maxDurationMs` it writes `event: reconnect` between
 * two event frames and ends, so a platform never cuts it mid-frame; the client resumes at once
 * with Last-Event-ID (on any instance: the new stream starts from history).
 */
export function eventStreamResponse(
  src: EventSource,
  o: { after: number; heartbeatMs: number; maxDurationMs: number; signals: AbortSignal[]; requestId: string },
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
    let rotate = false;
    const rotation = setTimeout(() => {
      rotate = true;
      notify();
    }, o.maxDurationMs);
    unrefTimer(rotation);
    const stop = () => ac.signal.aborted || rotate;
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
        if (stop()) return;
      }
    };

    try {
      // Subscribe before reading history so nothing committed in between is missed.
      unsubscribe = await src.subscribe((events) => {
        queue.push(...events);
        notify();
      });
      await catchUp();
      while (!stop()) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        queue.sort((a, b) => a.sequence - b.sequence);
        const e = queue.shift()!;
        if (e.sequence <= last) continue;
        // A gap: fetch what is missing from history first.
        if (e.sequence > last + 1) {
          await catchUp();
          // Rotating mid catch-up: what is still missing comes from history on the next stream.
          if (stop()) break;
        }
        emit(e);
      }
      // Rotation: everything up to `last` was written whole; the client resumes after it.
      if (!ac.signal.aborted) write(formatReconnectFrame());
    } catch (err) {
      if (!ac.signal.aborted) {
        const uerr = err instanceof UncageError ? err : new UncageError('internal_error');
        write(formatErrorFrame(uerr.toBody(o.requestId)));
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(rotation);
      unsubscribe?.();
      ac.signal.removeEventListener('abort', notify);
    }
  }

  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
