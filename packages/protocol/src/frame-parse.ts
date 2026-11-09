import type { z } from 'zod';
import type { ErrorCode } from './errors.js';

/** Maximum size of a single hub/agent frame, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * Thrown by `parseAgentFrame` / `parseHubFrame` on any malformed frame
 * (oversized, too deep, not JSON, unknown `t`, bad shape) — also by the HTTP transport parsers. `code` is always `invalid_request`.
 */
export class ProtocolFrameError extends Error {
  readonly code: ErrorCode = 'invalid_request';
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFrameError';
  }
}

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Bracket-depth scan (string-aware) so deep nesting is rejected before JSON.parse recurses. */
function exceedsDepth(raw: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') {
      if (++depth > MAX_DEPTH) return true;
    } else if (c === '}' || c === ']') depth--;
  }
  return false;
}

const clip = (v: string): string => (v.length > 64 ? `${v.slice(0, 64)}...` : v);

/**
 * Shared guarded parse (size in UTF-8 bytes, nesting depth, JSON, prototype keys, schema).
 * Internal to `@uncage/protocol`: this module is not re-exported from the package index.
 */
export function parseFrame<T>(raw: string, schema: z.ZodType<T>, kind: string, maxBytes = MAX_FRAME_BYTES): T {
  if (typeof raw !== 'string') throw new ProtocolFrameError(`${kind} frame must be a string`);
  // Cheap bound first (a UTF-8 char is at most 3 bytes per UTF-16 unit), exact count only if needed.
  if (raw.length * 3 > maxBytes && new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new ProtocolFrameError(`${kind} frame too large (max ${maxBytes} bytes)`);
  }
  if (exceedsDepth(raw)) throw new ProtocolFrameError(`${kind} frame nested too deeply (max ${MAX_DEPTH})`);
  let json: unknown;
  try {
    json = JSON.parse(raw, (k, v: unknown) => (FORBIDDEN_KEYS.has(k) ? undefined : v));
  } catch {
    throw new ProtocolFrameError(`${kind} frame is not valid JSON`);
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    const t = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;
    throw new ProtocolFrameError(`invalid ${kind} frame${typeof t === 'string' ? ` "${clip(t)}"` : ''}: ${clip(res.error.issues[0]?.message ?? 'bad shape')}`);
  }
  return res.data;
}
