import type { ServerResponse } from 'node:http';
import { UncageError, type SessionHandle } from '@uncage/core';
import type { UncageEvent } from '@uncage/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toUncageError } from './errors.js';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export const formatEvent = (e: UncageEvent): string =>
  `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** Writes a chunk, waiting for `drain` under backpressure (or until the socket closes). */
async function write(res: ServerResponse, chunk: string): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

export interface SseOptions {
  after: number;
  heartbeatMs: number;
  /** Aborted on server shutdown; ends the stream. */
  shutdown: AbortSignal;
}

/**
 * Streams the session's events as SSE until the client disconnects or the server shuts down.
 * Replay failures (e.g. `event_replay_unavailable`) become one `event: error` frame, then the
 * stream closes so the client can reload a snapshot.
 */
export async function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  session: SessionHandle,
  opts: SseOptions,
): Promise<void> {
  const res = reply.raw;
  const ac = new AbortController();
  const abort = (): void => ac.abort();
  request.raw.on('close', abort);
  res.on('close', abort);
  opts.shutdown.addEventListener('abort', abort, { once: true });

  reply.hijack();
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!ac.signal.aborted) res.write(': ping\n\n');
  }, opts.heartbeatMs);
  heartbeat.unref();

  try {
    for await (const e of session.events({ after: opts.after, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      await write(res, formatEvent(e));
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      const uerr = toUncageError(err);
      if (!(err instanceof UncageError)) request.log.error({ err }, 'event stream failed');
      res.write(`event: error\ndata: ${JSON.stringify(uerr.toBody(request.id))}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    request.raw.off('close', abort);
    res.off('close', abort);
    opts.shutdown.removeEventListener('abort', abort);
    res.end();
  }
}
