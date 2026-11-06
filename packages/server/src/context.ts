import { UncageError, type Uncage } from '@uncage/core';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

export interface RouteContext {
  uncage: Uncage;
  heartbeatMs: number;
  /** Aborted when the server closes, ending open SSE streams. */
  shutdown: AbortSignal;
}

/** Validates with a protocol Zod schema; failures become 400 `invalid_request`. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new UncageError('invalid_request', {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return r.data;
}

const MAX_IDEMPOTENCY_KEY = 256;

/** Reads the required `Idempotency-Key` header. */
export function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY) {
    throw new UncageError('invalid_request', {
      message: 'The Idempotency-Key header is required.',
      hint: 'Send a unique Idempotency-Key header (for example a UUID) with this request.',
    });
  }
  return key;
}

/** Parses a non-negative integer query/header value; `undefined` passes through. */
export function nonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  throw new UncageError('invalid_request', { message: `${name} must be a non-negative integer.` });
}
