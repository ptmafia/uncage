import type { ServerResponse } from 'node:http';
import { UncageError, type SessionHandle } from '@uncage/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toUncageError } from './errors.js';
import { formatErrorFrame, formatEvent, SSE_HEADERS, SSE_HEARTBEAT } from './wire.js';

export { formatEvent, SSE_HEADERS } from './wire.js';

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
  // The client may have gone away while the route was awaiting the session lookup, before these
  // listeners existed; 'close' will not fire again, so detect it now.
  if (opts.shutdown.aborted || res.destroyed || res.socket?.destroyed || request.raw.socket?.destroyed) abort();

  reply.hijack();
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    if (ac.signal.aborted) return;
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!ac.signal.aborted) res.write(SSE_HEARTBEAT);
    }, opts.heartbeatMs);
    heartbeat.unref();

    for await (const e of session.events({ after: opts.after, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      await write(res, formatEvent(e));
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      const uerr = toUncageError(err);
      if (!(err instanceof UncageError)) request.log.error({ err }, 'event stream failed');
      res.write(formatErrorFrame(uerr.toBody(request.id)));
    }
  } finally {
    clearInterval(heartbeat);
    request.raw.off('close', abort);
    res.off('close', abort);
    opts.shutdown.removeEventListener('abort', abort);
    res.end();
  }
}
