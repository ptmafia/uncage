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
/**
 * How long a live event beyond the next sequence waits for the missing ones to become readable
 * from history (a write committed after a later one, a cluster that delivered out of order) before
 * the stream ends with `event: reconnect`, so the client resumes after the last event it got.
 */
const DEFAULT_GAP_WAIT_MS = 2_000;
/**
 * A gap in history this process first saw at least this long ago (hub clock) is a permanent hole:
 * no commit lags that long. It is crossed after one wait instead of ending every stream with
 * `reconnect`. Event timestamps are never used for this (they are stamped by the machine's clock).
 */
const PERMANENT_GAP_MS = 5 * 60_000;
const GAPS_SEEN_MAX = 10_000;
/**
 * `sessionId:missingSequence` → when this process first saw that gap, shared by every stream of
 * the process; least recently seen first, capped, and pruned when the sequence is emitted. A fresh
 * instance (FaaS) starts empty and keeps waiting: it fails safe, and the client accepts a gap
 * still there after one resume, which bounds rotations on a real hole.
 */
const gapsSeen = new Map<string, number>();
const gapKey = (sessionId: string, sequence: number) => `${sessionId}:${sequence}`;

/** When the gap was first seen (records it now on first sight). */
function gapFirstSeen(key: string, now: number): number {
  const seen = gapsSeen.get(key) ?? now;
  gapsSeen.delete(key);
  gapsSeen.set(key, seen);
  if (gapsSeen.size > GAPS_SEEN_MAX) gapsSeen.delete(gapsSeen.keys().next().value!);
  return seen;
}

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
  o: { after: number; heartbeatMs: number; maxDurationMs: number; gapWaitMs?: number; signals: AbortSignal[]; requestId: string },
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
    const gapWaitMs = o.gapWaitMs ?? DEFAULT_GAP_WAIT_MS;
    /** Sleeps up to `ms`; rotation or abort cut it short. */
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        unrefTimer(t);
        wake = done;
        function done() {
          clearTimeout(t);
          if (wake === done) wake = undefined;
          resolve();
        }
      });
    let unsubscribe: (() => void) | undefined;

    const emit = (e: UncageEvent) => {
      if (e.sequence <= last) return;
      last = e.sequence;
      if (gapsSeen.size > 0) gapsSeen.delete(gapKey(e.sessionId, e.sequence));
      write(formatEvent(e));
    };
    const permanentHole = (next: UncageEvent) => {
      const key = gapKey(next.sessionId, last + 1);
      const now = Date.now();
      if (now - gapFirstSeen(key, now) < PERMANENT_GAP_MS) return false;
      gapsSeen.delete(key);
      return true;
    };
    /**
     * Emits history after `last` up to the first gap, never past it: a missing sequence is waited
     * for (it may be committed after a later one) up to `gapWaitMs`, then the stream rotates so the
     * client resumes after `last`. A hole this process has seen for PERMANENT_GAP_MS is crossed after the wait.
     */
    const catchUp = async () => {
      let deadline: number | undefined;
      let delay = 25;
      for (;;) {
        const page = await src.history(last, HISTORY_PAGE);
        const fresh = page.filter((e) => e.sequence > last);
        if (fresh.length === 0) return;
        let gap: UncageEvent | undefined;
        for (const e of fresh) {
          if (e.sequence > last + 1) {
            gap = e;
            break;
          }
          emit(e);
        }
        if (stop()) return;
        if (!gap) continue;
        // Recorded on first sight, so a hole's age counts from the first stream that met it.
        gapFirstSeen(gapKey(gap.sessionId, last + 1), Date.now());
        deadline ??= Date.now() + gapWaitMs;
        if (Date.now() >= deadline) {
          if (permanentHole(gap)) {
            emit(gap);
            deadline = undefined;
            delay = 25;
            continue;
          }
          rotate = true;
          return;
        }
        await pause(Math.min(delay, deadline - Date.now()));
        delay = Math.min(delay * 2, 400);
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
        // A gap: fetch what is missing from history first, never emitting past it.
        if (e.sequence > last + 1) {
          await catchUp();
          const deadline = Date.now() + gapWaitMs;
          let delay = 25;
          while (e.sequence > last + 1 && !stop() && Date.now() < deadline) {
            await pause(Math.min(delay, deadline - Date.now()));
            delay = Math.min(delay * 2, 400);
            await catchUp();
          }
          // Rotating mid catch-up, or still missing: the next stream reads it from history.
          if (stop()) break;
          if (e.sequence > last + 1) {
            rotate = true;
            break;
          }
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
