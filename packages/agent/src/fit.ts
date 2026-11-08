import type { UncageEvent } from '@uncage/protocol';

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');
const sizeOf = (v: unknown): number => byteLength(JSON.stringify(v));

/** Marker appended to a string field cut to make an event fit in one frame. */
export const truncationMarker = (bytes: number): string => `…[truncated ${bytes} bytes]`;

/** Set in `extensions` of an event whose payload had to be replaced by a minimal stub. */
export const TRUNCATED_EXTENSION = 'uncageTruncated';

/** Strings shorter than this are never cut (the marker would not make them smaller). */
const MIN_CUT_BYTES = 64;
/** Longest string kept in a stub. */
const STUB_STRING = 200;

type Holder = Record<string | number, unknown>;
type Leaf = { holder: Holder; key: string | number; value: string; bytes: number };

function stringLeaves(v: unknown, holder: Holder, key: string | number, out: Leaf[]): void {
  if (typeof v === 'string') {
    const bytes = byteLength(v);
    if (bytes > MIN_CUT_BYTES) out.push({ holder, key, value: v, bytes });
  } else if (Array.isArray(v)) v.forEach((x, i) => stringLeaves(x, v as unknown as Holder, i, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stringLeaves(x, v as Holder, k, out);
}

/** The longest prefix of `bytes` (UTF-8) of at most `max` bytes that ends on a character boundary. */
function prefixWithin(bytes: Buffer, max: number): string {
  let end = Math.min(Math.max(0, max), bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

const cut = (s: unknown): string => {
  const str = typeof s === 'string' ? s : '';
  return str.length > STUB_STRING ? `${str.slice(0, STUB_STRING)}…` : str;
};

/**
 * Returns `e` unchanged when its JSON fits in `budget` bytes. Otherwise a copy that fits:
 * 1. the largest string fields of `payload` (message text, tool output, input, …; a string payload
 *    too) are cut on character boundaries, each ending with `…[truncated N bytes]` — a field is only
 *    cut when that makes the event smaller;
 * 2. if it is still too large (e.g. huge arrays of numbers or many short strings), `payload` is
 *    replaced by a minimal, schema-valid stub that keeps the ids clients key on (`messageId`,
 *    `toolId`, `runId`, the session / run / approval object with long strings cut and arrays
 *    shortened), and `extensions.uncageTruncated = { originalBytes }` marks it.
 * Sequence, ids and type never change, so a replica stays gap-free and in order. Only the copy
 * sent to the hub is affected; the local event keeps its full content.
 */
export function fitEvent(e: UncageEvent, budget: number): UncageEvent {
  const originalBytes = sizeOf(e);
  if (originalBytes <= budget) return e;
  const copy = structuredClone(e) as UncageEvent & Holder;
  let size = originalBytes;
  const leaves: Leaf[] = [];
  stringLeaves(copy.payload, copy, 'payload', leaves);
  leaves.sort((a, b) => b.bytes - a.bytes);
  for (const leaf of leaves) {
    if (size <= budget) break;
    const bytes = Buffer.from(leaf.value, 'utf8');
    const before = sizeOf(leaf.value);
    let target = before - (size - budget) - 64;
    for (;;) {
      const kept = prefixWithin(bytes, target);
      const next = `${kept}${truncationMarker(bytes.length - byteLength(kept))}`;
      const delta = sizeOf(next) - before;
      if (delta >= 0) break; // cutting this field would not help
      if (size + delta <= budget || target <= 0) {
        leaf.holder[leaf.key] = next;
        size += delta;
        break;
      }
      target -= size + delta - budget + 64;
    }
  }
  return size <= budget ? copy : stubEvent(e, originalBytes, budget);
}

/** Minimal payload for `e.type` that still passes the protocol schema. */
function stubEvent(e: UncageEvent, originalBytes: number, budget: number): UncageEvent {
  const p = e.payload as unknown as Record<string, unknown>;
  const mark = truncationMarker(originalBytes);
  let payload: unknown;
  switch (e.type) {
    case 'message.started':
      payload = { messageId: p.messageId, role: 'assistant' };
      break;
    case 'message.delta':
      payload = { messageId: p.messageId, chunkIndex: p.chunkIndex, text: mark };
      break;
    case 'message.completed':
      payload = { messageId: p.messageId, text: mark };
      break;
    case 'tool.started':
      payload = { toolId: p.toolId, name: cut(p.name), title: cut(p.title), category: p.category };
      break;
    case 'tool.updated':
      payload = { toolId: p.toolId, output: mark };
      break;
    case 'tool.completed':
      payload = { toolId: p.toolId, output: mark, ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}) };
      break;
    case 'tool.failed':
      payload = { toolId: p.toolId, error: mark, ...(typeof p.declined === 'boolean' ? { declined: p.declined } : {}) };
      break;
    case 'run.failed': {
      const err = (p.error ?? {}) as Record<string, unknown>;
      payload = { runId: p.runId, error: { code: err.code, message: mark, retryable: err.retryable === true } };
      break;
    }
    case 'run.interrupted':
      payload = { runId: p.runId, reason: cut(p.reason) };
      break;
    case 'system.warning':
      payload = { code: cut(p.code), message: mark };
      break;
    default:
      // session.* / run.started / run.updated / run.completed / run.cancelled / approval.*: keep
      // the object (ids, states) with optional bulk dropped, long strings cut, arrays shortened.
      payload = squeeze(p, (v) => sizeOf({ ...e, payload: v, extensions: undefined }) + 64 <= budget);
  }
  const { extensions: _drop, ...envelope } = e;
  void _drop;
  return { ...envelope, payload, extensions: { [TRUNCATED_EXTENSION]: { originalBytes } } } as UncageEvent;
}

/** Optional fields that may carry arbitrary bulk (all optional in the protocol schemas). */
const DROP_KEYS = new Set(['input', 'details', 'extensions', 'output']);

function squeeze(p: Record<string, unknown>, fits: (v: unknown) => boolean): unknown {
  const strip = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') return key === 'id' || key.endsWith('Id') ? v : cut(v);
    if (Array.isArray(v)) return v.map((x) => strip(x, key));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP_KEYS.has(k)).map(([k, x]) => [k, strip(x, k)]));
    }
    return v;
  };
  const out = strip(p, '') as Record<string, unknown>;
  // Halve the largest array until it fits (no array in these schemas has a minimum length).
  for (let i = 0; i < 200 && !fits(out); i++) {
    const arrays: unknown[][] = [];
    const collect = (v: unknown) => {
      if (Array.isArray(v)) {
        if (v.length > 0) arrays.push(v);
        v.forEach(collect);
      } else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(out);
    if (arrays.length === 0) break;
    const biggest = arrays.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b));
    biggest.length = Math.floor(biggest.length / 2);
  }
  return out;
}
