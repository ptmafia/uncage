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

const isStr = (v: unknown): v is string => typeof v === 'string';
const hasId = (v: unknown): boolean => isObject(v) && isStr(v.id);

/**
 * The payload fields consumers (the React store) key on, per known event type. Payloads are not
 * otherwise checked field by field. `undefined` for types this client does not know.
 */
function payloadOk(type: string, p: Record<string, unknown>): boolean | undefined {
  if (type === 'session.created' || type === 'session.updated') return hasId(p.session);
  if (type === 'run.started') return hasId(p.run);
  if (type.startsWith('run.')) return isStr(p.runId);
  if (type.startsWith('approval.')) return hasId(p.approval);
  if (type.startsWith('message.')) return isStr(p.messageId);
  if (type.startsWith('tool.')) return isStr(p.toolId);
  if (type === 'system.warning') return isStr(p.code) && isStr(p.message);
  return undefined;
}

/**
 * An event envelope: ids, a non-negative integer `sequence`, a dotted `type` and an object payload
 * carrying the id its type is keyed on (`session.id`, `run.id`/`runId`, `approval.id`,
 * `messageId`, `toolId`). Types this client does not know yet (a newer daemon) pass through with
 * only the envelope checked; consumers switch on `type` and ignore the rest.
 */
export function isUncageEvent(v: unknown): v is UncageEvent {
  if (!isObject(v)) return false;
  const envelope =
    isStr(v.eventId) &&
    isStr(v.sessionId) &&
    typeof v.sequence === 'number' &&
    Number.isInteger(v.sequence) &&
    v.sequence >= 0 &&
    isStr(v.type) &&
    v.type.includes('.') &&
    isStr(v.occurredAt) &&
    isStr(v.schemaVersion) &&
    (v.runId === undefined || isStr(v.runId)) &&
    isObject(v.payload);
  return envelope && payloadOk(v.type as string, v.payload as Record<string, unknown>) !== false;
}
