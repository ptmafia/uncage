import { UncageError } from '@uncage/core';
import type { ErrorBody } from '@uncage/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Sends `{ error: ErrorBody }` with the status from the error catalog. */
export function sendError(reply: FastifyReply, request: FastifyRequest, err: UncageError): FastifyReply {
  return reply.code(err.status).send({ error: err.toBody(request.id) } satisfies { error: ErrorBody });
}

/** Maps any thrown value to an `UncageError`; unknown errors become `internal_error` (no stack, no message). */
export function toUncageError(err: unknown): UncageError {
  if (err instanceof UncageError) return err;
  if (err instanceof Error && err.name === 'ZodError') return new UncageError('invalid_request');
  // Fastify's own client errors (malformed JSON, unsupported content type, body too large, …).
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new UncageError('invalid_request', { message: (err as Error).message });
  }
  return new UncageError('internal_error');
}
