import { AgentInfoSchema, type AgentInfo, type TransportKind } from '@uncage/protocol';
import type { AgentTiming } from './types.js';

/** `GET <hub>/agent/info` gives up after this long. */
const INFO_TIMEOUT_MS = 10_000;

/** What the hub serves (`GET <hub>/agent/info`), or `null` when it cannot be read (offline, not a 0.3 hub, bad answer). */
export async function fetchAgentInfo(fetchFn: typeof fetch, hubUrl: string): Promise<AgentInfo | null> {
  try {
    const res = await fetchFn(`${hubUrl.replace(/\/+$/, '')}/agent/info`, { signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const r = AgentInfoSchema.safeParse(await res.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * WebSocket when the hub offers it, unless `wsFallbackAfter` WebSocket attempts in a row failed:
 * then HTTP streaming (when offered) until `wsReprobeMs` after the fallback. Unknown offers (`info`
 * null: `/agent/info` was never read) count as WebSocket only.
 */
export function chooseTransport(
  info: AgentInfo | null,
  s: { wsFailures: number; fellBackAt?: number; now: number },
  t: Pick<AgentTiming, 'wsFallbackAfter' | 'wsReprobeMs'>,
): TransportKind {
  // Unknown offers: WebSocket only (the site passes its last good `info` when it has one).
  const kinds = info ? info.transports.map((x) => x.kind) : (['ws'] as TransportKind[]);
  const ws = kinds.includes('ws');
  const http = kinds.includes('http');
  if (!ws) return http ? 'http' : 'ws';
  if (!http) return 'ws';
  const failing = s.wsFailures >= t.wsFallbackAfter;
  if (!failing) return 'ws';
  const reprobe = s.fellBackAt !== undefined && s.now - s.fellBackAt >= t.wsReprobeMs;
  return reprobe ? 'ws' : 'http';
}

/** Semver-ish comparison (`major.minor.patch[-pre]`): negative when `a` < `b`. Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
