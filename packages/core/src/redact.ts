/**
 * Allowlist redaction used by `uncage doctor --export-events` and the connected agent's activity
 * log: every string not under a known-safe key becomes a length placeholder; structure is kept.
 */
const SAFE_KEYS = new Set([
  'id', 'type', 'state', 'status', 'sequence', 'eventId', 'occurredAt', 'createdAt', 'startedAt', 'endedAt',
  'expiresAt', 'durationMs', 'category', 'name', 'chunkIndex', 'version', 'code', 'retryable', 'decision',
  'scope', 'runtimeId', 'schemaVersion', 'readOnly', 'allowedScopes', 'availableDecisions', 'capabilities',
]);

/** Arbitrary user/tool data: never recursed into, so nested key names cannot leak. */
const OPAQUE_KEYS = new Set(['input', 'output', 'extensions']);

const isSafeKey = (k: string): boolean => SAFE_KEYS.has(k) || k.endsWith('Id');

export function redactForExport(v: unknown, key = ''): unknown {
  if (OPAQUE_KEYS.has(key) && v !== undefined && v !== null) {
    return typeof v === 'string' ? `[redacted ${v.length} chars]` : `[redacted ${Array.isArray(v) ? 'array' : typeof v}]`;
  }
  if (typeof v === 'string') return isSafeKey(key) ? v : `[redacted ${v.length} chars]`;
  if (Array.isArray(v)) return v.map((x) => redactForExport(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactForExport(x, k)]));
  return v;
}
