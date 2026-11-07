import type { ErrorBody, UncageEvent } from '@uncage/protocol';

/**
 * Lightweight structural checks for data coming off the wire. The daemon validates with the full
 * protocol schemas; the browser only needs to reject garbage (and stay small: no zod in the bundle).
 */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An `{ error }` body: `code` and `message` strings, a `retryable` boolean, optional `hint`/`details`. */
export function isErrorBody(v: unknown): v is ErrorBody {
  if (!isObject(v)) return false;
  return (
    typeof v.code === 'string' &&
    typeof v.message === 'string' &&
    typeof v.retryable === 'boolean' &&
    (v.hint === undefined || typeof v.hint === 'string') &&
    (v.details === undefined || isObject(v.details))
  );
}

/**
 * An event envelope: ids, a non-negative integer `sequence`, a dotted `type` and an object payload.
 * Payloads are not checked field by field, and types this client does not know yet (a newer
 * daemon) pass through; consumers switch on `type` and ignore the rest.
 */
export function isUncageEvent(v: unknown): v is UncageEvent {
  if (!isObject(v)) return false;
  return (
    typeof v.eventId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.sequence === 'number' &&
    Number.isInteger(v.sequence) &&
    v.sequence >= 0 &&
    typeof v.type === 'string' &&
    v.type.includes('.') &&
    typeof v.occurredAt === 'string' &&
    typeof v.schemaVersion === 'string' &&
    (v.runId === undefined || typeof v.runId === 'string') &&
    isObject(v.payload)
  );
}
