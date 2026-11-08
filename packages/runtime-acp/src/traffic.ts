import { BRIDGE_TOKEN_ENV } from './site-mcp.js';

const BEARER = /Bearer\s+\S+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Header / env entries (`{ name, value }`) whose value is a secret. */
const SECRET_NAMES = new Set(['authorization', 'proxy-authorization', BRIDGE_TOKEN_ENV.toLowerCase()]);

const redactString = (s: string): string => s.replace(BEARER, 'Bearer [redacted]').replace(EMAIL, '[email]');

function walk(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string' && 'value' in o && SECRET_NAMES.has(o.name.toLowerCase())) {
      return { ...o, value: typeof o.value === 'string' && /^Bearer\s/i.test(o.value) ? 'Bearer [redacted]' : '[redacted]' };
    }
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(o)) {
      out[k] = SECRET_NAMES.has(k.toLowerCase()) ? '[redacted]' : walk(child);
    }
    return out;
  }
  return v;
}

/**
 * Redacts one recorded ACP JSON-RPC message (or a raw line) for a traffic log: Authorization and
 * bridge-token values and any `Bearer …` become `[redacted]`, e-mail addresses become `[email]`, and
 * the params of the agent's `_auth/status_update` (account details) are dropped.
 */
export function redactAcpTraffic(msg: unknown): unknown {
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg) && (msg as { method?: unknown }).method === '_auth/status_update') {
    return { ...(walk(msg) as Record<string, unknown>), params: '[redacted]' };
  }
  return walk(msg);
}
